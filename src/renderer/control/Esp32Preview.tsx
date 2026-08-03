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
}

const FLASH_MS = 500

function activePatternId(ledPattern: string): number {
  const found = LED_PATTERNS.find((p) => p.name === ledPattern)
  return found ? found.id : 0
}

const PREVIEW_PADS = [
  { id: 'all', label: 'ALL', kind: 'button' },
  { id: 'fx', label: 'FX', kind: 'button' },
  { id: 'prompt1', label: 'PROMPT 1', kind: 'indicator' },
  { id: 'prompt2', label: 'PROMPT 2', kind: 'indicator' }
] as const

/** Mirrors CrowPanel 1024×600 HMI (main stage + two mute buttons + two prompt indicators). */
export function Esp32Preview({ state }: Props) {
  const payload = useMemo(
    () => buildEsp32DisplayPayload(state),
    [state.setlist, state.currentSongId, state.fxMuted, state.allMuted]
  )

  const fxMuted = Boolean(payload.m)
  /** Match firmware: muted = yellow on navy; unmuted = lime on black. */
  const textColor = fxMuted ? '#ffe600' : '#39ff14'
  const footerColor = state.ledPattern === 'off' || !state.esp32Enabled ? '#8b92a0' : textColor
  const isWaiting = payload.t === ESP32_WAITING_TITLE && !payload.c
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
              <div className="esp32-sim-brand">VIEWERONE · LIVE HMI</div>
              <div className="esp32-sim-inner">
                <div className="esp32-sim-half esp32-sim-half--title">
                  <div
                    className="esp32-sim-title-fill"
                    style={{ color: textColor }}
                    title={isWaiting ? 'Idle text matches firmware + PC default' : undefined}
                  >
                    {isWaiting ? 'Waiting for signal' : payload.t || '—'}
                  </div>
                </div>
                <div className="esp32-sim-half esp32-sim-half--year">
                  <div className="esp32-sim-year-fill" style={{ color: textColor }}>
                    {isWaiting && !payload.c ? '' : !payload.c.trim() ? '—' : payload.c}
                  </div>
                  <div className="esp32-sim-pattern" style={{ color: footerColor }} title="Active LED pattern on strip">
                    {patternLabel}
                  </div>
                </div>
              </div>
            </div>
            <div className="esp32-sim-pads" role="group" aria-label="CrowPanel controls and prompt indicators">
              <div className="esp32-sim-pads-title">CONTROLS</div>
              {PREVIEW_PADS.map((pad) => {
                const active =
                  pad.id === 'fx'
                    ? fxMuted
                    : pad.id === 'prompt1'
                      ? state.prompt1On
                      : pad.id === 'prompt2'
                        ? state.prompt2On
                        : state.allMuted
                if (pad.kind === 'indicator') {
                  return (
                    <div
                      key={pad.id}
                      className={`esp32-sim-pad esp32-sim-pad--indicator esp32-sim-pad--${pad.id}${
                        active ? ' esp32-sim-pad--on' : ' esp32-sim-pad--standby'
                      }`}
                      role="status"
                      aria-label={`${pad.label} ${active ? 'on' : 'off'}`}
                      title={`${pad.label} — MIDI-controlled status indicator`}
                    >
                      <span className="esp32-sim-pad-light" aria-hidden="true" />
                      <span className="esp32-sim-pad-label">{pad.label}</span>
                    </div>
                  )
                }
                return (
                  <button
                    key={pad.id}
                    type="button"
                    className={`esp32-sim-pad esp32-sim-pad--button esp32-sim-pad--${pad.id}${
                      active ? ' esp32-sim-pad--muted' : ' esp32-sim-pad--live'
                    }`}
                    title={`${pad.label} mute button${pad.id === 'fx' ? ' (follows FX mute)' : ' (preview state)'}`}
                    onClick={() => {
                      if (pad.id === 'fx') {
                        void window.viewer.patchSettings({ fxMuted: !fxMuted })
                        return
                      }
                      void window.viewer.patchSettings({ allMuted: !state.allMuted })
                    }}
                  >
                    <span className="esp32-sim-pad-label">{pad.label}</span>
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
                style={{ color: textColor }}
                title={isWaiting ? 'Idle text matches firmware + PC default' : undefined}
              >
                {isWaiting ? 'Waiting for signal' : payload.t || '—'}
              </div>
            </div>
            <div className="esp32-sim-half esp32-sim-half--year">
              <div className="esp32-sim-year-fill" style={{ color: textColor }}>
                {isWaiting && !payload.c ? '' : !payload.c.trim() ? '—' : payload.c}
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
      <details className="preview-tests">
        <summary>Prompt tests</summary>
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
              title={`Simulate PC ${pc} — ${label}`}
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
      </details>
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
  )
}
