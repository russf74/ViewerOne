import { useEffect, useMemo, useState } from 'react'
import type { PublicState } from '../../shared/types'
import { buildEsp32DisplayPayload, ESP32_WAITING_TITLE } from '../../shared/esp32Payload'
import { getEsp32PreviewDisplay } from '../../shared/esp32Device'
import { LED_PATTERNS, clampLedPatternId, formatLedPatternLabel } from '../../shared/ledPatterns'
import {
  MIDI_PC_PROMPT_1_ON,
  MIDI_PC_PROMPT_1_OFF,
  MIDI_PC_PROMPT_2_ON,
  MIDI_PC_PROMPT_2_OFF,
  MIDI_PC_LED_BLACKOUT,
  MIDI_PC_LED_IDLE,
  MIDI_PC_LED_APPLY
} from '../../shared/midiConfig'

type Props = {
  state: PublicState
  detailMode: boolean
}

const FLASH_MS = 500
const BRAND_CLOCK_MS = 30_000

function formatLocalHm(d = new Date()): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function activePatternId(ledPattern: string): number {
  const found = LED_PATTERNS.find((p) => p.name === ledPattern)
  return found ? found.id : 0
}

const PREVIEW_PADS = [
  { id: 'all', label: 'ALL', kind: 'button' as const },
  { id: 'fx', label: 'FX', kind: 'button' as const },
  { id: 'synth', label: 'SYNTH', kind: 'channel' as const },
  { id: 'piano', label: 'PIANO', kind: 'channel' as const }
]

/** Mirrors the full CrowPanel 1024×600 HMI: broad stage plus four stacked right pads. */
export function Esp32Preview({ state, detailMode }: Props) {
  // Same builder as host serial broadcast — includes c/d/n for the three meta slots.
  const payload = useMemo(
    () => buildEsp32DisplayPayload(state, state.countdown.display),
    [
      state.setlist,
      state.currentSongId,
      state.fxMuted,
      state.allMuted,
      state.synthMuted,
      state.pianoMuted,
      state.countdown.display
    ]
  )

  const fxMuted = Boolean(state.fxMuted)
  /** Match firmware: muted = yellow on navy; unmuted = lime on black (meta / next / footer). */
  const textColor = fxMuted ? '#ffe600' : '#39ff14'
  /** Now-playing title — cyan on black (matches CrowPanel + totals `--cyan`). */
  const titleColor = '#00e5ff'
  const footerColor = state.ledPattern === 'off' || !state.esp32Enabled ? '#8b92a0' : textColor
  const isWaiting = payload.t === ESP32_WAITING_TITLE && !payload.c && !payload.d
  const metaYear = isWaiting ? '' : payload.c || ''
  const metaDuration = isWaiting ? '' : payload.d || ''
  const metaPosition = isWaiting ? '' : payload.n || ''
  const nextSong = isWaiting ? '' : payload.x || ''
  const nextSongLabel = nextSong ? `Next : ${nextSong}` : ''
  const hasMeta = Boolean(metaYear || metaDuration || metaPosition)
  const patternLabel = formatLedPatternLabel(state.ledPattern)
  const selectedId = activePatternId(state.ledPattern)
  const previewDisplay = getEsp32PreviewDisplay(state.esp32Display)
  const isCrowPanel = previewDisplay.device === 'crowpanel7'
  const serialStatus =
    state.esp32Display.connection === 'disabled'
      ? 'Serial off — CrowPanel 7" fallback (1024×600)'
      : state.esp32Display.connection === 'searching'
        ? 'Searching for display — CrowPanel 7" fallback (1024×600)'
        : state.esp32Display.device === 'unknown'
          ? 'Connected — identifying… CrowPanel 7" fallback (1024×600)'
          : `${state.esp32Display.model ?? (isCrowPanel ? 'CrowPanel 7"' : 'CYD 2.8"')} · ${state.esp32Display.width}×${state.esp32Display.height}`

  const queuedLabel =
    state.queuedLedPattern !== null && state.queuedLedPattern !== undefined
      ? formatLedPatternLabel(state.queuedLedPattern)
      : null
  const activeLabel = patternLabel
  const queuedMatchesActive = queuedLabel !== null && queuedLabel === activeLabel
  const queuedText = queuedLabel
    ? queuedMatchesActive
      ? `${queuedLabel} (same as active)`
      : queuedLabel
    : '—'

  const [flashPc, setFlashPc] = useState<125 | 126 | 127 | null>(null)
  const [flashPromptPc, setFlashPromptPc] = useState<120 | 121 | 122 | 123 | null>(null)
  const [padClock, setPadClock] = useState(formatLocalHm)

  useEffect(() => {
    setPadClock(formatLocalHm())
    const id = window.setInterval(() => setPadClock(formatLocalHm()), BRAND_CLOCK_MS)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const pc = state.ledMidiPulse
    const at = state.ledMidiPulseAt
    if (
      !at ||
      (pc !== MIDI_PC_LED_BLACKOUT && pc !== MIDI_PC_LED_IDLE && pc !== MIDI_PC_LED_APPLY)
    ) {
      return
    }
    setFlashPc(pc)
    const t = window.setTimeout(() => setFlashPc(null), FLASH_MS)
    return () => window.clearTimeout(t)
  }, [state.ledMidiPulseAt, state.ledMidiPulse])

  useEffect(() => {
    const pc = state.promptMidiPulse
    if (!state.promptMidiPulseAt || pc === null) return
    setFlashPromptPc(pc)
    const t = window.setTimeout(() => setFlashPromptPc(null), FLASH_MS)
    return () => window.clearTimeout(t)
  }, [state.promptMidiPulseAt, state.promptMidiPulse])

  const applyPreview = (id: number) => {
    void window.viewer.previewLedPattern(clampLedPatternId(id))
  }

  const stepPreview = (delta: number) => {
    const idx = LED_PATTERNS.findIndex((p) => p.id === selectedId)
    const i = idx < 0 ? 0 : idx
    const next = LED_PATTERNS[(i + delta + LED_PATTERNS.length) % LED_PATTERNS.length]
    applyPreview(next.id)
  }

  return (
    <div className="esp32-sim">
      <div className="esp32-sim-chrome">
        <span className="esp32-sim-label">
          {isCrowPanel ? 'CrowPanel 7" · 1024×600 (simulated)' : 'CYD 2.8" · 320×240 (simulated)'}
        </span>
        <span className="esp32-sim-status">{serialStatus}</span>
      </div>
      <div
        className={`esp32-sim-lcd ${isCrowPanel ? 'esp32-sim-lcd--crowpanel' : 'esp32-sim-lcd--cyd'} ${
          !state.esp32Enabled ? 'esp32-sim-lcd--dim' : ''
        } ${
          fxMuted ? 'esp32-sim-lcd--fx-muted' : 'esp32-sim-lcd--fx-unmuted'
        }`}
      >
        {isCrowPanel ? (
          <>
            <div className="esp32-sim-stage">
              <div className="esp32-sim-brand-bar">
                <div className="esp32-sim-brand">VIEWERONE</div>
                <span className="esp32-sim-version" aria-label="App version">
                  v{state.appVersion || '—'}
                </span>
              </div>
              <div className="esp32-sim-inner">
                <div className="esp32-sim-half esp32-sim-half--title">
                  <div
                    className="esp32-sim-title-fill"
                    style={{ color: isWaiting ? '#ffe600' : titleColor }}
                    title={isWaiting ? 'Idle text matches firmware + PC default' : undefined}
                  >
                    {isWaiting ? 'Waiting for signal' : payload.t || '—'}
                  </div>
                </div>
                <div className="esp32-sim-half esp32-sim-half--year">
                  <div
                    className="esp32-sim-next-song"
                    style={{ color: textColor }}
                    title={nextSong || undefined}
                  >
                    {nextSongLabel}
                  </div>
                  <div className="esp32-sim-meta-row" style={{ color: textColor }}>
                    <span className="esp32-sim-meta-slot esp32-sim-meta-slot--year">
                      {hasMeta ? metaYear : '—'}
                    </span>
                    <span className="esp32-sim-meta-slot esp32-sim-meta-slot--duration">{metaDuration}</span>
                    <span className="esp32-sim-meta-slot esp32-sim-meta-slot--position">{metaPosition}</span>
                  </div>
                  <div className="esp32-sim-pattern" style={{ color: footerColor }} title="Active LED pattern on strip">
                    {patternLabel}
                  </div>
                </div>
              </div>
            </div>
            <div className="esp32-sim-pads" role="group" aria-label="CrowPanel mute controls">
              <time className="esp32-sim-pad-clock" dateTime={padClock} aria-label="Local time">
                {padClock}
              </time>
              {PREVIEW_PADS.map((pad) => {
                const muted =
                  pad.id === 'fx'
                    ? state.fxMuted
                    : pad.id === 'synth'
                      ? state.synthMuted
                      : pad.id === 'piano'
                        ? state.pianoMuted
                        : state.allMuted
                const title =
                  pad.id === 'fx'
                    ? 'FX mute (Group6 / Cubase CC85)'
                    : pad.id === 'synth'
                      ? 'Cubase mixer ch1 Synth mute (CC86)'
                      : pad.id === 'piano'
                        ? 'Cubase mixer ch2 Piano mute (CC87)'
                        : 'ALL mute (Group1 / Cubase CC88)'
                return (
                  <button
                    key={pad.id}
                    type="button"
                    className={`esp32-sim-pad esp32-sim-pad--button esp32-sim-pad--${pad.id}${
                      muted ? ' esp32-sim-pad--muted' : ' esp32-sim-pad--live'
                    }`}
                    title={title}
                    aria-pressed={muted}
                    onClick={() => {
                      if (pad.id === 'fx') {
                        void window.viewer.patchSettings({ fxMuted: !state.fxMuted })
                        return
                      }
                      if (pad.id === 'synth') {
                        void window.viewer.patchSettings({ synthMuted: !state.synthMuted })
                        return
                      }
                      if (pad.id === 'piano') {
                        void window.viewer.patchSettings({ pianoMuted: !state.pianoMuted })
                        return
                      }
                      void window.viewer.patchSettings({ allMuted: !state.allMuted })
                    }}
                  >
                    <span className="esp32-sim-pad-label">{pad.label}</span>
                    <span className="esp32-sim-pad-status">{muted ? 'MUTED' : 'LIVE'}</span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <div className="esp32-sim-inner">
            <div className="esp32-sim-half esp32-sim-half--title">
              <div
                className="esp32-sim-title-fill"
                style={{ color: isWaiting ? '#ffe600' : titleColor }}
                title={isWaiting ? 'Idle text matches firmware + PC default' : undefined}
              >
                {isWaiting ? 'Waiting for signal' : payload.t || '—'}
              </div>
            </div>
            <div className="esp32-sim-half esp32-sim-half--year">
              <div
                className="esp32-sim-next-song"
                style={{ color: textColor }}
                title={nextSong || undefined}
              >
                {nextSongLabel}
              </div>
              <div className="esp32-sim-meta-row" style={{ color: textColor }}>
                <span className="esp32-sim-meta-slot esp32-sim-meta-slot--year">
                  {hasMeta ? metaYear : '—'}
                </span>
                <span className="esp32-sim-meta-slot esp32-sim-meta-slot--duration">{metaDuration}</span>
                <span className="esp32-sim-meta-slot esp32-sim-meta-slot--position">{metaPosition}</span>
              </div>
              <div className="esp32-sim-pattern" style={{ color: footerColor }} title="Active LED pattern on strip">
                {patternLabel}
              </div>
            </div>
          </div>
        )}
      </div>
      <p
        className={`esp32-sim-queued-line${queuedLabel && !queuedMatchesActive ? ' esp32-sim-queued-line--pending' : ''}`}
        title="Queued for the displayed song; applied with PC 127"
      >
        Queued: {queuedText}
      </p>
      {detailMode ? (
        <div className="preview-detail-tools">
          <div className="preview-tool-label">Prompt PC tests (no CrowPanel pads — Synth/Piano replaced them)</div>
          <div className="esp32-sim-pc-btns" role="group" aria-label="Simulate prompt program changes">
          {[
            [MIDI_PC_PROMPT_1_ON, 'Prompt 1 on'],
            [MIDI_PC_PROMPT_1_OFF, 'Prompt 1 off'],
            [MIDI_PC_PROMPT_2_ON, 'Prompt 2 on'],
            [MIDI_PC_PROMPT_2_OFF, 'Prompt 2 off']
          ].map(([pc, label]) => (
            <button
              type="button"
              key={flashPromptPc === pc ? `prompt-${pc}-${state.promptMidiPulseAt}` : `prompt-${pc}`}
              className={`esp32-sim-pc-btn${flashPromptPc === pc ? ' esp32-sim-pc-btn--flash' : ''}`}
              title={`Simulate PC ${pc} — ${label} (host state only; pads are Synth/Piano)`}
              onClick={(e) => {
                e.currentTarget.classList.remove('btn-click-flash')
                void e.currentTarget.offsetWidth
                e.currentTarget.classList.add('btn-click-flash')
                void window.viewer.promptMidi(pc as 120 | 121 | 122 | 123)
              }}
            >
              PC {pc} · {label}
            </button>
          ))}
          </div>
          <div className="preview-tool-label">LED PC tests</div>
          <div className="esp32-sim-pc-btns" role="group" aria-label="Simulate reserved LED program changes">
        <button
          type="button"
          key={flashPc === MIDI_PC_LED_BLACKOUT ? `blackout-${state.ledMidiPulseAt}` : 'blackout'}
          className={`esp32-sim-pc-btn${flashPc === MIDI_PC_LED_BLACKOUT ? ' esp32-sim-pc-btn--flash' : ''}`}
          title="Simulate PC 125 — LED blackout (all off)"
          onClick={(e) => {
            e.currentTarget.classList.remove('btn-click-flash')
            void e.currentTarget.offsetWidth
            e.currentTarget.classList.add('btn-click-flash')
            void window.viewer.ledMidiBlackout()
          }}
        >
          PC 125 · Blackout
        </button>
        <button
          type="button"
          key={flashPc === MIDI_PC_LED_IDLE ? `idle-${state.ledMidiPulseAt}` : 'idle'}
          className={`esp32-sim-pc-btn${flashPc === MIDI_PC_LED_IDLE ? ' esp32-sim-pc-btn--flash' : ''}`}
          title="Simulate PC 126 — dim knight rider (between songs / idle)"
          onClick={(e) => {
            e.currentTarget.classList.remove('btn-click-flash')
            void e.currentTarget.offsetWidth
            e.currentTarget.classList.add('btn-click-flash')
            void window.viewer.ledMidiIdle()
          }}
        >
          PC 126 · Idle lights
        </button>
        <button
          type="button"
          key={flashPc === MIDI_PC_LED_APPLY ? `apply-${state.ledMidiPulseAt}` : 'apply'}
          className={`esp32-sim-pc-btn${flashPc === MIDI_PC_LED_APPLY ? ' esp32-sim-pc-btn--flash' : ''}`}
          title="Simulate PC 127 — apply queued song LED pattern"
          onClick={(e) => {
            e.currentTarget.classList.remove('btn-click-flash')
            void e.currentTarget.offsetWidth
            e.currentTarget.classList.add('btn-click-flash')
            void window.viewer.ledMidiApply()
          }}
        >
          PC 127 · Apply lights
        </button>
          </div>
          <div
            className="esp32-sim-pattern-test"
            role="group"
            aria-label="Live-test LED patterns on the ESP"
          >
        <button
          type="button"
          className="esp32-sim-pattern-step"
          title="Previous pattern (live test)"
          onClick={(e) => {
            e.currentTarget.classList.remove('btn-click-flash')
            void e.currentTarget.offsetWidth
            e.currentTarget.classList.add('btn-click-flash')
            stepPreview(-1)
          }}
        >
          ‹
        </button>
        <label className="esp32-sim-pattern-select-wrap" title="Apply pattern immediately to ESP (live test — does not change the song)">
          <span className="esp32-sim-pattern-select-label">Test pattern</span>
          <select
            className="esp32-sim-pattern-select"
            value={selectedId}
            aria-label="Live-test LED pattern"
            onChange={(e) => applyPreview(Number(e.target.value))}
          >
            {LED_PATTERNS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="esp32-sim-pattern-step"
          title="Next pattern (live test)"
          onClick={(e) => {
            e.currentTarget.classList.remove('btn-click-flash')
            void e.currentTarget.offsetWidth
            e.currentTarget.classList.add('btn-click-flash')
            stepPreview(1)
          }}
        >
          ›
        </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
