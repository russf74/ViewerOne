import type { AppState, Esp32DisplayPayload } from './types.js'
import {
  formatSetlistSongPosition,
  formatSetProgressNearClock,
  nextSetlistSongTitle
} from './setlistTiming.js'

/** Shown on ESP and in the desktop preview when no song / empty content. */
export const ESP32_WAITING_TITLE = 'Waiting for signal'

/**
 * Hard char cap for next-song title (CrowPanel + preview). No ellipsis — just stop.
 * Keep in sync with firmware `kNextTitleMaxChars`.
 */
export const ESP32_NEXT_SONG_MAX_CHARS = 36

/** Hard char cap for now-playing title — keep in sync with firmware `kTitleMaxChars`. */
export const ESP32_TITLE_MAX_CHARS = 96

/** Hard cap for set-progress near clock — keep in sync with firmware `kSetProgressMaxChars`. */
export const ESP32_SET_PROGRESS_MAX_CHARS = 24

export type Esp32CountdownArm = {
  remainingSeconds: number | null
  running: boolean
}

export type Esp32DisplayExtras = {
  /** Cubase transport playing — always included as `tr` 0/1. */
  transportPlaying?: boolean
}

/** Truncate to N chars with a hard cut (no `…` / ellipsis). */
export function truncateEsp32Text(title: string, maxChars: number): string {
  const t = (title ?? '').trim()
  if (!t) return ''
  if (t.length <= maxChars) return t
  return t.slice(0, maxChars)
}

export function truncateEsp32NextSongTitle(
  title: string,
  maxChars = ESP32_NEXT_SONG_MAX_CHARS
): string {
  return truncateEsp32Text(title, maxChars)
}

function withTransportAndSetProgress(
  payload: Esp32DisplayPayload,
  st: Pick<AppState, 'setlist' | 'currentSongId'>,
  extras?: Esp32DisplayExtras | null,
  includeSetProgress = false
): Esp32DisplayPayload {
  payload.tr = extras?.transportPlaying ? 1 : 0
  if (includeSetProgress) {
    const g = truncateEsp32Text(
      formatSetProgressNearClock(st.setlist, st.currentSongId),
      ESP32_SET_PROGRESS_MAX_CHARS
    )
    if (g) payload.g = g
  }
  return payload
}

export function buildEsp32DisplayPayload(
  st: Pick<AppState, 'setlist' | 'currentSongId' | 'fxMuted' | 'allMuted' | 'synthMuted' | 'pianoMuted'>,
  displayDuration?: string,
  countdown?: Esp32CountdownArm | null,
  extras?: Esp32DisplayExtras | null
): Esp32DisplayPayload {
  const row = st.currentSongId ? st.setlist.find((r) => r.id === st.currentSongId) : null
  const m = st.fxMuted
  const a = st.allMuted
  const s = st.synthMuted
  const i = st.pianoMuted
  if (!row || st.setlist.length === 0) {
    return withTransportAndSetProgress(
      { t: ESP32_WAITING_TITLE, c: '', d: '', l: true, m, a, s, i },
      st,
      extras,
      false
    )
  }
  const t = truncateEsp32Text(row.title ?? '', ESP32_TITLE_MAX_CHARS)
  const c = (row.year ?? '').trim()
  const d = (displayDuration ?? row.length ?? '').trim()
  if (!t && !c && !d) {
    return withTransportAndSetProgress(
      { t: ESP32_WAITING_TITLE, c: '', d: '', l: true, m, a, s, i },
      st,
      extras,
      false
    )
  }
  // Same `n` / `x` / `g` for serial JSON and PC CrowPanel preview.
  const n = formatSetlistSongPosition(st.setlist, st.currentSongId)
  const x = truncateEsp32Text(
    nextSetlistSongTitle(st.setlist, st.currentSongId),
    ESP32_NEXT_SONG_MAX_CHARS
  )
  const payload: Esp32DisplayPayload = { t: t || '—', c, d, l: true, m, a, s, i }
  if (n) payload.n = n
  if (x) payload.x = x
  // Arm device-side countdown whenever we know remaining — transport/song events only.
  if (countdown && countdown.remainingSeconds != null && countdown.remainingSeconds >= 0) {
    payload.r = Math.max(0, Math.trunc(countdown.remainingSeconds))
    payload.p = Boolean(countdown.running)
  }
  return withTransportAndSetProgress(payload, st, extras, true)
}
