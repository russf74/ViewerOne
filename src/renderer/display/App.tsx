import { useCallback, useEffect, useState } from 'react'
import type { PublicState } from '../../shared/types'
import { DisplayStage } from '../shared/DisplayStage'

export function App() {
  const [state, setState] = useState<PublicState | null>(null)
  const bridgeOk = typeof window !== 'undefined' && typeof window.viewer !== 'undefined'

  useEffect(() => {
    if (!bridgeOk) return
    let off: (() => void) | undefined
    void window.viewer.getState().then(setState)
    off = window.viewer.onState(setState)
    return () => off?.()
  }, [bridgeOk])

  const apply = useCallback((next: PublicState) => {
    setState(next)
  }, [])

  if (!bridgeOk) {
    return (
      <div className="display-shell">
        <p className="waiting">Display bridge missing — reload the window from the control app.</p>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="display-shell">
        <p className="waiting">Loading…</p>
      </div>
    )
  }

  return (
    <div className="display-shell">
      <DisplayStage state={state} onAfterAction={apply} />
    </div>
  )
}
