/** One JSON line per ESP32 update (short keys). */
export type Esp32DisplayPayload = {
  /** title */
  t: string
  /** release year (4-digit) */
  c: string
  /** live */
  l: boolean
  /** FX mute — white text when true; vivid green when false */
  m?: boolean
}

export type SetlistItem = {
  id: string
  /** MIDI program 1–127; equals row index + 1 (recomputed when order changes) */
  program: number
  title: string
  /** Release year, typically 4 digits */
  year: string
  /** Kept for setlist/payload compatibility (ESP colour is mute-driven only). */
  live: boolean
}

export type AppState = {
  /** Cubase / mixer ↔ ViewerOne / ESP: muted = tint + CC 0/127 out (see shared/midiConfig.ts) */
  fxMuted: boolean
  setlist: SetlistItem[]
  /** Row id from last matched program change; null until first PC */
  currentSongId: string | null
  /** When true, push current song/year JSON over USB serial (CH340 / USB-serial autodetect; replug supported). */
  esp32Enabled: boolean
}

/** Live MIDI connection status, so the UI isn't "blind" even though ports are auto-detected/hardcoded. */
export type MidiStatus = {
  cubaseInputName: string | null
  cubaseOutputName: string | null
  mixerInputName: string | null
  mixerInputOpen: boolean
  mixerOutputName: string | null
  mixerOutputOpen: boolean
  mixerLastMessageAgoMs: number | null
  mixerLastCc: { channel: number; controller: number; value: number } | null
  mixerLastSentAgoMs: number | null
  mixerLastSentCc: { channel: number; controller: number; value: number } | null
  cubaseLastSentAgoMs: number | null
  cubaseLastSentCc: { channel: number; controller: number; value: number } | null
}

export type PublicState = AppState & {
  /** From package.json / Electron app.getVersion() */
  appVersion: string
  midi: MidiStatus
}
