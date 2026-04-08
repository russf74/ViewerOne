import { useMemo } from 'react'
import type { PublicState } from '../../shared/types'
import { buildEsp32DisplayPayload, ESP32_WAITING_TITLE } from '../../shared/esp32Payload'

type Props = {
  state: PublicState
}

/** Mirrors payload + 50/50 title/chords (landscape 320×240 on device). */
export function Esp32Preview({ state }: Props) {
  const payload = useMemo(
    () => buildEsp32DisplayPayload(state),
    [state.setlist, state.currentSongId]
  )

  const titleColor = payload.l ? '#6fdd7a' : '#e06c75'
  const isWaiting = payload.t === ESP32_WAITING_TITLE && !payload.c

  return (
    <div className="esp32-sim">
      <div className="esp32-sim-chrome">
        <span className="esp32-sim-label">ESP32 (simulated)</span>
        <span className="esp32-sim-status">
          {!state.esp32Enabled
            ? 'Serial off'
            : !state.esp32SerialPort
              ? 'Pick a COM port'
              : 'Same JSON as USB serial'}
        </span>
      </div>
      <div className={`esp32-sim-lcd ${!state.esp32Enabled ? 'esp32-sim-lcd--dim' : ''}`}>
        <div className="esp32-sim-inner">
          <div className="esp32-sim-half esp32-sim-half--title">
            <div
              className="esp32-sim-title-fill"
              style={{ color: titleColor }}
              title={isWaiting ? 'Idle text matches firmware + PC default' : undefined}
            >
              {payload.t || '—'}
            </div>
          </div>
          <div className="esp32-sim-half esp32-sim-half--chords">
            <div className="esp32-sim-chords-fill">{payload.c || (isWaiting ? '' : '—')}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
