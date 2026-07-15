import { useMemo } from 'react'
import type { PublicState } from '../../shared/types'
import { buildEsp32DisplayPayload, ESP32_WAITING_TITLE } from '../../shared/esp32Payload'

type Props = {
  state: PublicState
}

/** Mirrors payload + 50/50 title/year (landscape 320×240 on device). */
export function Esp32Preview({ state }: Props) {
  const payload = useMemo(
    () => buildEsp32DisplayPayload(state),
    [state.setlist, state.currentSongId, state.fxMuted]
  )

  const fxMuted = Boolean(payload.m)
  /** Match firmware: muted = white; unmuted = vivid lime (both title + year). */
  const textColor = fxMuted ? '#ffffff' : '#39ff14'
  const isWaiting = payload.t === ESP32_WAITING_TITLE && !payload.c

  return (
    <div className="esp32-sim">
      <div className="esp32-sim-chrome">
        <span className="esp32-sim-label">ESP32 (simulated)</span>
        <span className="esp32-sim-status">
          {!state.esp32Enabled ? 'Serial off' : 'USB serial — same JSON as device'}
        </span>
      </div>
      <div className={`esp32-sim-lcd ${!state.esp32Enabled ? 'esp32-sim-lcd--dim' : ''}`}>
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
          </div>
        </div>
      </div>
    </div>
  )
}
