export type TransportMode = 'note' | 'mmc'

export type TransportSettings = {
  mode: TransportMode
  /** 1–16 */
  channel: number
  /** note mode: MIDI note 0–127 */
  startNote: number
  stopNote: number
}

/** How mute CC is sent: X32 mute groups often latch on each CC 127; absolute uses valueOn/valueOff. */
export type CcMuteOutMode = 'toggle127' | 'absolute'

export type CcButtonSettings = {
  channel: number
  cc: number
  /** CC value when mute is engaged (channels muted). X32: often 0. */
  valueOn: number
  /** CC value when unmuted. X32: often 127. */
  valueOff: number
  /** absolute = send valueOn / valueOff from state; toggle127 = legacy pulse (rarely needed). */
  outMode?: CcMuteOutMode
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
  /** Transport “playing” from MIDI (MMC / note / clock start) + local button presses (not persisted) */
  transportPlaying: boolean
  /** From package.json / Electron app.getVersion() */
  appVersion: string
}
