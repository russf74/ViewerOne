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

/** True for Soundcheck rows, including “Sound Check” / “Soundcheck (Reflex)”. */
export function isSoundcheckTitle(title: string): boolean {
  const compact = normalizedTitle(title).replace(/[^A-Z0-9]/g, '')
  return compact.startsWith('SOUNDCHECK')
}

/**
 * True when the last successful Arranger scan visited this row.
 * After a scan, leftover songs from a previous (longer) setlist sit at the bottom
 * with `arrangerIndex == null` — they must not inflate gig duration.
 */
export function isVisitedArrangerRow(item: SetlistItem): boolean {
  return item.arrangerIndex != null
}

/** Once any row has been scanned, duration only sums visited arranger events. */
function shouldCountRowInDuration(item: SetlistItem, hasScannedRows: boolean): boolean {
  if (!hasScannedRows) return true
  return isVisitedArrangerRow(item)
}

export function calculateSetlistTiming(items: SetlistItem[]): SetlistTimingTotals {
  const totals: SetlistTimingTotals = { intro: 0, main: 0, outro: 0, total: 0 }
  const hasScannedRows = items.some((item) => isVisitedArrangerRow(item))
  for (const item of items) {
    if (!shouldCountRowInDuration(item, hasScannedRows)) continue
    const seconds = songLengthSeconds(item.length)
    if (!seconds) continue
    const title = normalizedTitle(item.title)
    if (isSoundcheckTitle(item.title)) continue
    if (title.startsWith('INTRO')) totals.intro += seconds
    else if (title.startsWith('OUTRO')) totals.outro += seconds
    else totals.main += seconds
    totals.total += seconds
  }
  return totals
}

export type UnvisitedSetlistSummary = {
  rows: number
  withLength: number
  seconds: number
}

/** Leftover rows kept after a scan that did not visit them (previous setlist songs). */
export function summarizeUnvisitedSetlist(items: SetlistItem[]): UnvisitedSetlistSummary {
  let rows = 0
  let withLength = 0
  let seconds = 0
  for (const item of items) {
    if (isVisitedArrangerRow(item)) continue
    rows++
    const sec = songLengthSeconds(item.length)
    if (!sec) continue
    withLength++
    seconds += sec
  }
  return { rows, withLength, seconds }
}

/** Same heuristic as royal-blue title text (`#4169E1`) in the setlist UI. */
export function isTimedSectionTitle(title: string): boolean {
  const t = normalizedTitle(title)
  return isSoundcheckTitle(title) || t.startsWith('INTRO') || t.startsWith('OUTRO')
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

/** CrowPanel `n`/`g` denominator — same rules as {@link formatSetlistSongPosition}. */
export function countNumberedArrangerSongs(setlist: SetlistItem[]): number {
  let total = 0
  for (const item of setlist) {
    if (isCountedInSongNumbering(item)) total++
  }
  return total
}

/** Main-set songs longer than this are flagged (INTRO/OUTRO/SOUNDCHECK are exempt). */
export const SUSPICIOUS_MAIN_SONG_SEC = 12 * 60

export type SetlistLengthAudit = {
  visitedRows: number
  numberedSongs: number
  visitedMissingLength: string[]
  suspiciousLong: string[]
  unvisited: UnvisitedSetlistSummary
  warnings: string[]
}

/**
 * Cross-check scanned song count vs duration so a shorter Arranger cannot keep a
 * previous setlist's 114-minute total from leftover / stale rows.
 */
export function auditSetlistLengths(
  items: SetlistItem[],
  opts?: {
    freshLengthCount?: number
    previousMainSeconds?: number
    previousNumbered?: number
  }
): SetlistLengthAudit {
  const timing = calculateSetlistTiming(items)
  const unvisited = summarizeUnvisitedSetlist(items)
  const numberedSongs = countNumberedArrangerSongs(items)
  const visited = items.filter((item) => isVisitedArrangerRow(item))
  const visitedMissingLength = visited
    .filter((item) => {
      if (isSoundcheckTitle(item.title)) return false
      return !songLengthSeconds(item.length)
    })
    .map((item) => (item.title || `PC ${item.program}`).trim())
  const suspiciousLong = visited
    .filter((item) => {
      if (isTimedSectionTitle(item.title)) return false
      return songLengthSeconds(item.length) >= SUSPICIOUS_MAIN_SONG_SEC
    })
    .map((item) => `${(item.title || `PC ${item.program}`).trim()} ${item.length}`)

  const warnings: string[] = []
  if (unvisited.withLength > 0) {
    warnings.push(
      `${unvisited.rows} leftover row(s) not in this Arranger (${formatSetlistSeconds(unvisited.seconds)} excluded from duration)`
    )
  }
  if (visitedMissingLength.length) {
    warnings.push(
      `${visitedMissingLength.length} scanned song(s) have no length: ${visitedMissingLength.slice(0, 4).join(', ')}${
        visitedMissingLength.length > 4 ? '…' : ''
      }`
    )
  }
  if (suspiciousLong.length) {
    warnings.push(`suspiciously long scanned song(s): ${suspiciousLong.join(', ')}`)
  }
  if (
    opts?.freshLengthCount != null &&
    visited.length >= 3 &&
    opts.freshLengthCount === 0
  ) {
    warnings.push('no song lengths were read from Cubase this scan — totals may be stale')
  }
  if (numberedSongs >= 3 && timing.main / numberedSongs > 8 * 60) {
    warnings.push(
      `average numbered song is ${formatSetlistSeconds(Math.round(timing.main / numberedSongs))} — check Cubase lengths`
    )
  }
  if (
    opts?.previousNumbered != null &&
    opts?.previousMainSeconds != null &&
    numberedSongs + 2 <= opts.previousNumbered &&
    timing.main > 0 &&
    Math.abs(timing.main - opts.previousMainSeconds) / Math.max(opts.previousMainSeconds, 1) < 0.08
  ) {
    warnings.push(
      'numbered song count dropped but main duration barely changed — leftover or stale lengths'
    )
  }

  return {
    visitedRows: visited.length,
    numberedSongs,
    visitedMissingLength,
    suspiciousLong,
    unvisited,
    warnings
  }
}

/**
 * Hard gate before a gig: every scanned song (except Soundcheck) must have a
 * keepable length, and none of those lengths should look like a missed event.
 */
export function scanIsGigReady(
  items: SetlistItem[],
  opts?: {
    freshLengthCount?: number
    previousVisited?: number
    previousNumbered?: number
    previousMainSeconds?: number
    lengthFailures?: number
  }
): { ready: boolean; blockers: string[] } {
  const audit = auditSetlistLengths(items, opts)
  const blockers: string[] = []
  if (audit.visitedRows < 2) {
    blockers.push('scan visited fewer than 2 songs')
  }
  if (audit.visitedMissingLength.length) {
    blockers.push(`missing length: ${audit.visitedMissingLength.join(', ')}`)
  }
  if (audit.suspiciousLong.length) {
    blockers.push(`suspicious length: ${audit.suspiciousLong.join(', ')}`)
  }
  if (opts?.freshLengthCount === 0 && audit.visitedRows >= 2) {
    blockers.push('no lengths were read from Cubase this scan')
  }
  if (opts?.lengthFailures != null && opts.lengthFailures > 0) {
    blockers.push(
      `${opts.lengthFailures} visited song(s) could not be read from Cubase this scan (kept an old time)`
    )
  }
  if (
    opts?.previousVisited != null &&
    opts.previousVisited >= 8 &&
    audit.visitedRows + 3 <= opts.previousVisited
  ) {
    blockers.push(`scan visited ${audit.visitedRows} songs (previous ${opts.previousVisited})`)
  }
  if (
    opts?.previousNumbered != null &&
    opts.previousNumbered >= 8 &&
    audit.numberedSongs + 2 <= opts.previousNumbered
  ) {
    blockers.push(
      `numbered songs ${audit.numberedSongs} (previous ${opts.previousNumbered}) — walk looks truncated`
    )
  }
  // Upper Heyford / typical set: if OUTRO exists in the store as leftover but was not visited,
  // the walk stopped early.
  const visitedOutro = items.some(
    (item) => isVisitedArrangerRow(item) && normalizedTitle(item.title).startsWith('OUTRO')
  )
  const leftoverOutro = items.some(
    (item) => !isVisitedArrangerRow(item) && normalizedTitle(item.title).startsWith('OUTRO')
  )
  if (!visitedOutro && leftoverOutro && audit.visitedRows >= 3) {
    blockers.push('OUTRO not visited — Arranger walk stopped before the end of the chain')
  }
  return { ready: blockers.length === 0, blockers }
}

function timedSectionPositionLabel(title: string): 'SC' | 'IN' | 'OU' | null {
  const t = normalizedTitle(title)
  if (isSoundcheckTitle(title)) return 'SC'
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
  const total = countNumberedArrangerSongs(setlist)

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

/**
 * Sum of arranger song lengths from the current row onward (inclusive).
 * Matches {@link calculateSetlistTiming}: skips SOUNDCHECK; includes INTRO/OUTRO/main;
 * unvisited retained rows (`arrangerIndex == null`) are excluded.
 */
export function remainingSetSecondsFromCurrent(
  setlist: SetlistItem[],
  currentSongId: string | null | undefined
): number {
  if (!currentSongId || setlist.length === 0) return 0
  const idx = setlist.findIndex((r) => r.id === currentSongId)
  if (idx < 0) return 0
  let total = 0
  for (let i = idx; i < setlist.length; i++) {
    const item = setlist[i]
    if (item.arrangerIndex == null) continue
    if (isSoundcheckTitle(item.title)) continue
    total += songLengthSeconds(item.length)
  }
  return total
}

/** Compact remaining-set duration: `41m`, `1h`, or `1h 20m`. */
export function formatCompactSetDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/**
 * CrowPanel pad-column line under the clock, e.g. `12/30 · 41m`.
 * Position uses the same rules as {@link formatSetlistSongPosition}; time is full
 * lengths from current onward (song-change only — not live countdown).
 */
export function formatSetProgressNearClock(
  setlist: SetlistItem[],
  currentSongId: string | null | undefined
): string {
  const pos = formatSetlistSongPosition(setlist, currentSongId)
  if (!pos) return ''
  return `${pos} · ${formatCompactSetDuration(remainingSetSecondsFromCurrent(setlist, currentSongId))}`
}
