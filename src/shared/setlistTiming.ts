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

export function calculateSetlistTiming(items: SetlistItem[]): SetlistTimingTotals {
  const totals: SetlistTimingTotals = { intro: 0, main: 0, outro: 0, total: 0 }
  for (const item of items) {
    const seconds = songLengthSeconds(item.length)
    if (!seconds || item.title.startsWith('SOUNDCHECK')) continue
    if (item.title.startsWith('INTRO')) totals.intro += seconds
    else if (item.title.startsWith('OUTRO')) totals.outro += seconds
    else totals.main += seconds
    totals.total += seconds
  }
  return totals
}

export function isTimedSectionTitle(title: string): boolean {
  return (
    title.startsWith('SOUNDCHECK') ||
    title.startsWith('INTRO') ||
    title.startsWith('OUTRO')
  )
}
