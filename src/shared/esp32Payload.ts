import type { AppState, Esp32DisplayPayload } from './types.js'

/** Shown on ESP and in the desktop preview when no song / empty content. */
export const ESP32_WAITING_TITLE = 'Waiting for signal'

export function buildEsp32DisplayPayload(
  st: Pick<AppState, 'setlist' | 'currentSongId' | 'fxMuted'>
): Esp32DisplayPayload {
  const row = st.currentSongId ? st.setlist.find((r) => r.id === st.currentSongId) : null
  const m = st.fxMuted
  if (!row || st.setlist.length === 0) {
    return { t: ESP32_WAITING_TITLE, c: '', l: false, m }
  }
  const t = (row.title ?? '').trim()
  const c = (row.year ?? '').trim()
  if (!t && !c) {
    return { t: ESP32_WAITING_TITLE, c: '', l: false, m }
  }
  return { t: t || '—', c, l: row.live, m }
}
