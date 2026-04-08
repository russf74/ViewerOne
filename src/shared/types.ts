/** One JSON line per ESP32 update (short keys). */
export type Esp32DisplayPayload = {
  /** title */
  t: string
  /** chords */
  c: string
  /** live */
  l: boolean
}

export type SetlistItem = {
  id: string
  /** MIDI program 1–127; equals row index + 1 (recomputed when order changes) */
  program: number
  title: string
  chords: string
  /** Chord display: live = green title tint on ESP; not live = red */
  live: boolean
}

export type AppState = {
  midiInputName: string | null
  midiOutputName: string | null
  programChangeChannel: number
  setlist: SetlistItem[]
  /** Row id from last matched program change; null until first PC */
  currentSongId: string | null
  /** Windows COM port path (e.g. COM5) for ESP32 USB serial display; null = off */
  esp32SerialPort: string | null
  /** When true, push current song/chords JSON lines to esp32SerialPort */
  esp32Enabled: boolean
}

export type PublicState = AppState & {
  inputs: string[]
  outputs: string[]
  /** From package.json / Electron app.getVersion() */
  appVersion: string
}
