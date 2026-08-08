import type { SetlistItem } from './types'

export type SetlistTimingTotals = {
  intro: number
  main: number
  outro: number
  total: number
}

const SONG_LENGTH_PATTERN = /^(\d+):([0-5]\d)$/

/** Return canonical mm:ss, or an empty string when the value is empty/invalid. */
export function normalizeSongLength(value: unknown): string {
  const text = String(value ?? '').trim()
  const match = SONG_LENGTH_PATTERN.exec(text)
  if (!match) return ''
  const minutes = Number(match[1])
  if (!Number.isSafeInteger(minutes)) return ''
  return `${String(minutes).padStart(2, '0')}:${match[2]}`
}

export function songLengthSeconds(value: unknown): number {
  const normalized = normalizeSongLength(value)
  if (!normalized) return 0
  const [minutes, seconds] = normalized.split(':').map(Number)
  return minutes * 60 + seconds
}

export function formatSetlistSeconds(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Trim + uppercase for INTRO / OUTRO / SOUNDCHECK prefix checks (matches royal-blue UI). */
function normalizedTitle(title: string): string {
  return (title ?? '').trim().toUpperCase()
}

export function calculateSetlistTiming(items: SetlistItem[]): SetlistTimingTotals {
  const totals: SetlistTimingTotals = { intro: 0, main: 0, outro: 0, total: 0 }
  for (const item of items) {
    const seconds = songLengthSeconds(item.length)
    if (!seconds) continue
    const title = normalizedTitle(item.title)
    if (title.startsWith('SOUNDCHECK')) continue
    if (title.startsWith('INTRO')) totals.intro += seconds
    else if (title.startsWith('OUTRO')) totals.outro += seconds
    else totals.main += seconds
    totals.total += seconds
  }
  return totals
}

/** Same heuristic as royal-blue title text (`#4169E1`) in the setlist UI. */
export function isTimedSectionTitle(title: string): boolean {
  const t = normalizedTitle(title)
  return t.startsWith('SOUNDCHECK') || t.startsWith('INTRO') || t.startsWith('OUTRO')
}

/** INTRO / SOUNDCHECK / OUTRO are excluded from numbered song index and total. */
export function isExcludedFromSongNumbering(title: string): boolean {
  return isTimedSectionTitle(title)
}

/**
 * Real songs in the arranger only: visited by scan (`arrangerIndex != null`) and not a
 * blue INTRO / OUTRO / SOUNDCHECK row. Retained unvisited rows are not part of the total.
 */
export function isCountedInSongNumbering(item: SetlistItem): boolean {
  return item.arrangerIndex != null && !isExcludedFromSongNumbering(item.title)
}

function timedSectionPositionLabel(title: string): 'SC' | 'IN' | 'OU' | null {
  const t = normalizedTitle(title)
  if (t.startsWith('SOUNDCHECK')) return 'SC'
  if (t.startsWith('INTRO')) return 'IN'
  if (t.startsWith('OUTRO')) return 'OU'
  return null
}

/**
 * Title of the next arranger setlist row after the current song (list order).
 * Only rows with `arrangerIndex != null` count — retained unvisited songs at the
 * bottom are skipped. Includes INTRO / OUTRO / SOUNDCHECK when they are in the
 * arranger. Empty when current is the last arranger item (or nothing follows).
 */
export function nextSetlistSongTitle(
  setlist: SetlistItem[],
  currentSongId: string | null | undefined
): string {
  if (!currentSongId || setlist.length === 0) return ''
  const idx = setlist.findIndex((r) => r.id === currentSongId)
  if (idx < 0) return ''
  for (let i = idx + 1; i < setlist.length; i++) {
    const row = setlist[i]
    if (row.arrangerIndex == null) continue
    return (row.title ?? '').trim()
  }
  return ''
}

/**
 * CrowPanel bottom-line song position: `01/24`, `IN/24`, `SC/24`, or `OU/24`.
 * Total = count of real arranger songs only (excludes blue rows and unvisited retained rows).
 */
export function formatSetlistSongPosition(
  setlist: SetlistItem[],
  currentSongId: string | null | undefined
): string {
  let total = 0
  for (const item of setlist) {
    if (isCountedInSongNumbering(item)) total++
  }

  const row = currentSongId ? setlist.find((r) => r.id === currentSongId) : null
  if (!row) return ''

  const special = timedSectionPositionLabel(row.title ?? '')
  if (special) return `${special}/${total}`

  // Unvisited retained songs are outside the arranger numbering.
  if (row.arrangerIndex == null) return ''

  let index = 0
  for (const item of setlist) {
    if (!isCountedInSongNumbering(item)) continue
    index++
    if (item.id === row.id) break
  }
  if (index < 1) return ''
  return `${String(index).padStart(2, '0')}/${total}`
}
