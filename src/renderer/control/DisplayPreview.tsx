import type { PublicState } from '../../shared/types'
import { DisplayStage } from '../shared/DisplayStage'

type Props = {
  state: PublicState
  apply: (next: PublicState) => void
}

export function DisplayPreview({ state, apply }: Props) {
  return (
    <div className="display-preview-outer">
      <p className="display-preview-caption">
        Simulated 14.5″ panel (2560×720) at 50% — layout only; real window uses{' '}
        <strong>Open 2nd screen</strong>.
      </p>
      <div className="display-preview-frame">
        <DisplayStage state={state} onAfterAction={apply} />
      </div>
    </div>
  )
}
