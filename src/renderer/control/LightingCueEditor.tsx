import type { LightingProgram, SetlistItem } from '../../shared/types'
import { LED_PATTERNS } from '../../shared/ledPatterns'

type Props = {
  row: SetlistItem | null
  onSave: (program: LightingProgram) => void
}

function formatMs(ms: number): string {
  const sec = Math.floor(ms / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function LightingCueEditor({ row, onSave }: Props) {
  if (!row?.lightingProgram?.cues?.length) {
    return (
      <p className="settings-hint">
        No lighting program yet. Run <strong>Analyze from Cubase</strong> to capture the real
        arrangement audio (tempo/key edits included).
      </p>
    )
  }

  const program = row.lightingProgram
  const source =
    row.audioSource === 'cubase-render'
      ? 'Cubase render'
      : row.audioSource === 'external-file'
        ? 'External file (legacy)'
        : 'Unknown'

  return (
    <div className="lighting-cue-editor">
      <p className="settings-hint">
        {source}
        {row.audioAnalysis ? ` · ${row.audioAnalysis.bpm} BPM · ${program.cues.length} cues` : ''}
        {row.cubaseRenderCapturedAt
          ? ` · captured ${new Date(row.cubaseRenderCapturedAt).toLocaleString()}`
          : ''}
      </p>
      <div className="cue-table-wrap">
        <table className="cue-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Section</th>
              <th>Pattern</th>
            </tr>
          </thead>
          <tbody>
            {program.cues.map((cue, idx) => (
              <tr key={`${cue.atMs}-${idx}`}>
                <td>{formatMs(cue.atMs)}</td>
                <td>{cue.label ?? '—'}</td>
                <td>
                  <select
                    value={cue.ledPatternId}
                    onChange={(e) => {
                      const next = {
                        ...program,
                        cues: program.cues.map((c, i) =>
                          i === idx ? { ...c, ledPatternId: Number(e.target.value) } : c
                        )
                      }
                      onSave(next)
                    }}
                    aria-label={`Pattern at ${formatMs(cue.atMs)}`}
                  >
                    {LED_PATTERNS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
