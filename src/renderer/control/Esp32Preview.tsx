import { useEffect, useMemo, useState } from 'react'
import type { PublicState } from '../../shared/types'
import { buildEsp32DisplayPayload, ESP32_WAITING_TITLE } from '../../shared/esp32Payload'
import { LED_PATTERNS, clampLedPatternId, formatLedPatternLabel } from '../../shared/ledPatterns'
import { MIDI_PC_LED_IDLE, MIDI_PC_LED_APPLY } from '../../shared/midiConfig'

type Props = {
  state: PublicState
}

const FLASH_MS = 500
const PATTERN_COUNT = LED_PATTERNS.length

function activePatternId(ledPattern: string): number {
  const found = LED_PATTERNS.find((p) => p.name === ledPattern)
  return found ? found.id : 0
}

/** Mirrors payload + 50/50 title/year (landscape 320×240 on device), plus LED pattern footer. */
export function Esp32Preview({ state }: Props) {
  const payload = useMemo(
    () => buildEsp32DisplayPayload(state),
    [state.setlist, state.currentSongId, state.fxMuted]
  )

  const fxMuted = Boolean(payload.m)
  /** Match firmware: muted = yellow on navy; unmuted = lime on black. */
  const textColor = fxMuted ? '#ffe600' : '#39ff14'
  const footerColor = state.ledPattern === 'off' || !state.esp32Enabled ? '#8b92a0' : textColor
  const isWaiting = payload.t === ESP32_WAITING_TITLE && !payload.c
  const patternLabel = formatLedPatternLabel(state.ledPattern)
  const selectedId = activePatternId(state.ledPattern)

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

  const [flashPc, setFlashPc] = useState<126 | 127 | null>(null)

  useEffect(() => {
    const pc = state.ledMidiPulse
    const at = state.ledMidiPulseAt
    if (!at || (pc !== MIDI_PC_LED_IDLE && pc !== MIDI_PC_LED_APPLY)) return
    setFlashPc(pc)
    const t = window.setTimeout(() => setFlashPc(null), FLASH_MS)
    return () => window.clearTimeout(t)
  }, [state.ledMidiPulseAt, state.ledMidiPulse])

  const applyPreview = (id: number) => {
    void window.viewer.previewLedPattern(clampLedPatternId(id))
  }

  const stepPreview = (delta: number) => {
    const next = (selectedId + delta + PATTERN_COUNT) % PATTERN_COUNT
    applyPreview(next)
  }

  return (
    <div className="esp32-sim">
      <div className="esp32-sim-chrome">
        <span className="esp32-sim-label">ESP32 (simulated)</span>
        <span className="esp32-sim-status">
          {!state.esp32Enabled ? 'Serial off' : 'USB serial — same JSON as device'}
        </span>
      </div>
      <div
        className={`esp32-sim-lcd ${!state.esp32Enabled ? 'esp32-sim-lcd--dim' : ''} ${
          fxMuted ? 'esp32-sim-lcd--fx-muted' : 'esp32-sim-lcd--fx-unmuted'
        }`}
      >
        <div className="esp32-sim-inner">
          <div className="esp32-sim-half esp32-sim-half--title">
            <div
              className="esp32-sim-title-fill"
              style={{ color: textColor }}
              title={isWaiting ? 'Idle text matches firmware + PC default' : undefined}
            >
              {payload.t || '—'}
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
      <p
        className={`esp32-sim-queued-line${queuedLabel && !queuedMatchesActive ? ' esp32-sim-queued-line--pending' : ''}`}
        title="Queued for the displayed song; applied with PC 127"
      >
        Queued: {queuedText}
      </p>
      <p className="esp32-sim-led-hint">
        <strong>PC {MIDI_PC_LED_IDLE}</strong> = dim knight rider (idle).{' '}
        <strong>PC {MIDI_PC_LED_APPLY}</strong> = apply the queued song pattern. Song select and mic mute do not
        change the strip.
      </p>
      <div className="esp32-sim-pc-btns" role="group" aria-label="Simulate reserved LED program changes">
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
