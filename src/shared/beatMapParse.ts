/** Parse Music AI / Moises beat-map JSON into click times (ms). */

export type ParsedBeatMap = {
  timesMs: number[]
  accentPhase: number
  bpm?: number
  fromBeatNumbers: boolean
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function timeField(obj: Record<string, unknown>): number | null {
  for (const k of [
    'startTime',
    'start_time',
    'start',
    'time',
    'timestamp',
    't',
    'offset',
    'positionTime',
    'onset'
  ]) {
    const n = asNumber(obj[k])
    if (n != null) return n
  }
  return null
}

function beatField(obj: Record<string, unknown>): number | null {
  for (const k of ['beatNumber', 'beat_number', 'beat', 'number', 'position', 'index', 'label']) {
    const v = obj[k]
    if (typeof v === 'string') {
      const m = v.match(/(\d+)/)
      if (m) return Number(m[1])
    }
    const n = asNumber(v)
    if (n != null) return n
  }
  return null
}

function collectItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return []
  const o = raw as Record<string, unknown>
  for (const k of ['beats', 'beatMap', 'beat_map', 'annotations', 'events', 'data', 'items', 'result']) {
    if (Array.isArray(o[k])) return o[k] as unknown[]
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) {
      const nested = collectItems(o[k])
      if (nested.length) return nested
    }
  }
  return []
}

function toMs(times: number[]): number[] {
  if (times.length === 0) return []
  const max = Math.max(...times)
  const scale = max > 10000 ? 1 : 1000
  return times.map((t) => t * scale)
}

/**
 * Turn a beat-map payload (array or `{ beats: [...] }`) into click times.
 * Beat numbers 1–4 set which click is the bar downbeat.
 */
export function parseBeatMapJson(raw: unknown): ParsedBeatMap {
  let bpm: number | undefined
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const b = asNumber((raw as Record<string, unknown>).bpm)
    if (b != null && b > 40 && b < 300) bpm = b
  }
  const items = collectItems(raw)
  const rows: { t: number; beat: number | null }[] = []
  for (const item of items) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      rows.push({ t: item, beat: null })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const t = timeField(obj)
    if (t == null) continue
    rows.push({ t, beat: beatField(obj) })
  }
  rows.sort((a, b) => a.t - b.t)
  const timesMs = toMs(rows.map((r) => r.t))
  const downIdx = rows.findIndex((r) => r.beat === 1)
  const fromBeatNumbers = downIdx >= 0
  const accentPhase = fromBeatNumbers ? downIdx % 4 : 0
  return { timesMs, accentPhase, bpm, fromBeatNumbers }
}
