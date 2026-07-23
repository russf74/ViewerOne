/** One JSON line per ESP32 update (short keys). */
export type Esp32DisplayPayload = {
  /** title */
  t: string
  /** release year (4-digit) */
  c: string
  /** live — kept for firmware compatibility; colour is mute-driven only */
  l: boolean
  /** FX mute — yellow on navy when true; green on black when false */
  m?: boolean
}

export type SetlistItem = {
  id: string
  /** MIDI program 1–125; equals row index + 1 (recomputed when order changes). PC 126/127 reserved for LED. */
  program: number
  title: string
  /** Release year, typically 4 digits */
  year: string
  /**
   * LED pattern id 0–20 for this song (see shared/ledPatterns.ts).
   * Default is 20 (random — sequential rotate of 1..19 on ESP).
   * Id 0 (knight_rider) is boot / between-songs idle (also PC 126).
   * Queued when the song is selected for display; applied via MIDI PC 127
   * (or the control UI simulate / pattern preview).
   */
  ledPattern: number
}

export type AppState = {
  /** Cubase / mixer ↔ ViewerOne / ESP: muted = tint + CC 0/127 out (see shared/midiConfig.ts) */
  fxMuted: boolean
  setlist: SetlistItem[]
  /** Row id from last matched program change; null until first PC */
  currentSongId: string | null
  /** When true, push current song/year JSON over USB serial (CH340 / USB-serial autodetect; replug supported). */
  esp32Enabled: boolean
  /** LED brightness 0–255 (capped when not on external PSU). */
  ledBrightness: number
  /** When false, strip is assumed powered from ESP32/USB — brightness hard-capped. */
  ledExternalPower: boolean
}

/** Live MIDI connection status, so the UI isn't "blind" even though ports are auto-detected/hardcoded. */
export type MidiStatus = {
  cubaseInputName: string | null
  /** True when the Cubase/loopMIDI input handle is actually open (not just detected by name). */
  cubaseInputOpen: boolean
  cubaseOutputName: string | null
  /** True when the Cubase/loopMIDI output handle is actually open. */
  cubaseOutputOpen: boolean
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
  /**
   * Last Program Change received on the Cubase input (Cubase/UI 1–127 numbering), any channel.
   * Null until the first PC arrives after connect/reconnect.
   */
  cubaseLastPc: number | null
  /** MIDI channel 1–16 of {@link cubaseLastPc}. */
  cubaseLastPcChannel: number | null
  cubaseLastPcAgoMs: number | null
}

export type PublicState = AppState & {
  /** From package.json / Electron app.getVersion() */
  appVersion: string
  midi: MidiStatus
  /** Active WS2812 pattern id/name from the ESP (e.g. knight_rider, off). */
  ledPattern: string
  /**
   * LED pattern id queued for the currently displayed song (applied via MIDI PC 127
   * or the control UI simulate / pattern preview).
   * Null when no song is selected / idle.
   */
  queuedLedPattern: number | null
  /**
   * Last reserved LED Program Change (Cubase/UI numbering) that fired — real MIDI
   * or UI simulate. Renderer pulses the matching test button when {@link ledMidiPulseAt} changes.
   */
  ledMidiPulse: 126 | 127 | null
  /** `Date.now()` when {@link ledMidiPulse} was last set (changes on every trigger). */
  ledMidiPulseAt: number
}
