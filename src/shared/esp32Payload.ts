import type { AppState, Esp32DisplayPayload } from './types.js'

/** Shown on ESP and in the desktop preview when no song / empty content. */
export const ESP32_WAITING_TITLE = 'Waiting for signal'

/** Chord field: capital `N` is a line break (not drawn). Same rules as ESP firmware. */
export function chordLineSegments(raw: string): string[] {
  return raw.split('N')
}

/** Trim each segment and join with newlines for block display (matches two logical lines). */
export function chordBlockPlainText(raw: string): string {
  return chordLineSegments(raw)
    .map((s) => s.trim())
    .join('\n')
}

export function buildEsp32DisplayPayload(
  st: Pick<AppState, 'setlist' | 'currentSongId'>
): Esp32DisplayPayload {
  const row = st.currentSongId ? st.setlist.find((r) => r.id === st.currentSongId) : null
  if (!row || st.setlist.length === 0) {
    return { t: ESP32_WAITING_TITLE, c: '', l: false }
  }
  const t = (row.title ?? '').trim()
  const c = (row.chords ?? '').trim()
  if (!t && !c) {
    return { t: ESP32_WAITING_TITLE, c: '', l: false }
  }
  return { t: t || '—', c, l: row.live }
}
