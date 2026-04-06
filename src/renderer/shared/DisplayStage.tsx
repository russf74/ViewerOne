import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublicState } from '../../shared/types'

type Props = {
  state: PublicState
  onAfterAction: (next: PublicState) => void
}

const BUTTON_FLASH_MS = 240

export function DisplayStage({ state, onAfterAction }: Props) {
  const [clock, setClock] = useState(() => new Date())
  const [buttonFlash, setButtonFlash] = useState<'stop' | 'start' | 'prev' | 'next' | null>(null)
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const tick = () => setClock(new Date())
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    }
  }, [])

  const onAction = useCallback(
    (fn: () => Promise<PublicState>) => {
      void fn().then(onAfterAction)
    },
    [onAfterAction]
  )

  const pulseButton = useCallback((which: 'stop' | 'start' | 'prev' | 'next') => {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    setButtonFlash(which)
    flashTimeoutRef.current = setTimeout(() => {
      setButtonFlash(null)
      flashTimeoutRef.current = null
    }, BUTTON_FLASH_MS)
  }, [])

  const handleStop = useCallback(() => {
    pulseButton('stop')
    void onAction(() => window.viewer.stop())
  }, [onAction, pulseButton])

  const handleStart = useCallback(() => {
    pulseButton('start')
    void onAction(() => window.viewer.start())
  }, [onAction, pulseButton])

  const handlePrevSong = useCallback(() => {
    pulseButton('prev')
    void onAction(() => window.viewer.prevSong())
  }, [onAction, pulseButton])

  const handleNextSong = useCallback(() => {
    pulseButton('next')
    void onAction(() => window.viewer.nextSong())
  }, [onAction, pulseButton])

  const curIdx = state.currentSongId
    ? state.setlist.findIndex((r) => r.id === state.currentSongId)
    : -1
  const cur = curIdx >= 0 ? state.setlist[curIdx] : null
  const nxt = curIdx >= 0 && curIdx + 1 < state.setlist.length ? state.setlist[curIdx + 1] : null
  const nxt2 = curIdx >= 0 && curIdx + 2 < state.setlist.length ? state.setlist[curIdx + 2] : null

  const remaining =
    curIdx >= 0 ? Math.max(0, state.setlist.length - curIdx - 1) : state.setlist.length

  const currentTitle = cur ? cur.title || '—' : null
  const nextTitle = nxt?.title ?? '—'
  const next2Title = nxt2?.title ?? '—'

  const timeStr = clock.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })

  return (
    <div className="display-stage">
      <div className="dp-col dp-col-left">
        <div className="dp-block dp-current">
          {currentTitle !== null ? (
            <div className="dp-current-title">{currentTitle}</div>
          ) : (
            <div className="dp-current-title dp-muted">Waiting for PC…</div>
          )}
        </div>
        <div className="dp-block dp-next">
          <div className="dp-next-title">{nextTitle}</div>
        </div>
        <div className="dp-block dp-next2">
          <div className="dp-next2-title">{next2Title}</div>
        </div>
      </div>

      <div className="dp-col dp-col-mid">
        <div
          className={
            cur
              ? `dp-chords ${cur.live ? 'dp-chords-live' : 'dp-chords-not-live'}`
              : 'dp-chords dp-chords-idle'
          }
        >
          {cur?.chords ? cur.chords : '—'}
        </div>
        <div className="dp-mid-bottom">
          <div className="dp-status-line">
            <span className="dp-clock">{timeStr}</span>
            <span className="dp-remaining-n" aria-label={`${remaining} songs remaining`}>
              {remaining}
            </span>
          </div>
        </div>
      </div>

      <div className="dp-col dp-col-right">
        <div className="dp-right-stack">
          <div className="dp-button-grid">
            <button
              type="button"
              className={state.muteAllEngaged ? 'active' : ''}
              aria-pressed={state.muteAllEngaged}
              onClick={() => onAction(() => window.viewer.muteAll())}
            >
              Mute Mic
            </button>
            <button
              type="button"
              className={state.muteFxEngaged ? 'active' : ''}
              aria-pressed={state.muteFxEngaged}
              onClick={() => onAction(() => window.viewer.muteFx())}
            >
              Mute FX
            </button>
            <button
              type="button"
              className={buttonFlash === 'stop' ? 'dp-flash' : ''}
              onClick={handleStop}
            >
              Stop
            </button>
            <button
              type="button"
              className={buttonFlash === 'start' ? 'dp-flash' : ''}
              onClick={handleStart}
            >
              Start
            </button>
            <button
              type="button"
              aria-label="Previous song"
              className={buttonFlash === 'prev' ? 'dp-flash' : ''}
              onClick={handlePrevSong}
            >
              &lt;&lt;&lt;
            </button>
            <button
              type="button"
              aria-label="Next song"
              className={buttonFlash === 'next' ? 'dp-flash' : ''}
              onClick={handleNextSong}
            >
              &gt;&gt;&gt;
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
