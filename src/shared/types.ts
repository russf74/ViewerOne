export type TransportMode = 'note' | 'mmc'

export type TransportSettings = {
  mode: TransportMode
  /** 1–16 */
  channel: number
  /** note mode: MIDI note 0–127 */
  startNote: number
  stopNote: number
}

export type CcButtonSettings = {
  channel: number
  cc: number
  valueOn: number
  valueOff: number
}

export type SetlistItem = {
  id: string
  /** MIDI program 1–127; equals row index + 1 (recomputed when order changes) */
  program: number
  title: string
  chords: string
  /** Chord display on touch screen: light green when true, light red when false */
  live: boolean
}

export type AppState = {
  midiInputName: string | null
  midiOutputName: string | null
  programChangeChannel: number
  transport: TransportSettings
  muteAll: CcButtonSettings
  muteFx: CcButtonSettings
  setlist: SetlistItem[]
  /** Row id from last matched program change; null until first PC */
  currentSongId: string | null
}

export type PublicState = AppState & {
  inputs: string[]
  outputs: string[]
  /** Live CC toggle state (not persisted) */
  muteAllEngaged: boolean
  muteFxEngaged: boolean
  /** From package.json / Electron app.getVersion() */
  appVersion: string
}
