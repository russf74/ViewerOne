/** One JSON line per ESP32 update (short keys). */
export type Esp32DisplayPayload = {
  /** title */
  t: string
  /** release year (4-digit) */
  c: string
  /** song duration / live remaining time in mm:ss */
  d: string
  /** live — kept for firmware compatibility; colour is mute-driven only */
  l: boolean
  /** FX mute — yellow on navy when true; green on black when false */
  m?: boolean
  /** Group1 / ALL mute; CrowPanel only (CYD ignores unknown fields). */
  a?: boolean
}

export type Esp32DeviceType = 'cyd' | 'crowpanel7' | 'unknown'

/** Runtime serial/device identity. This is intentionally not persisted in AppState. */
export type Esp32DisplayStatus = {
  connection: 'disabled' | 'searching' | 'connected'
  device: Esp32DeviceType
  model: string | null
  width: number | null
  height: number | null
}

export type SetlistItem = {
  id: string
  /** Stable Cubase song Program Change, 1–119. Row order may differ after an Arranger scan. */
  program: number
  /** 1-based position from the last successful Arranger scan; null when not visited by that scan. */
  arrangerIndex: number | null
  title: string
  /** Normalized song duration in mm:ss, or empty when unset. */
  length: string
  /** Release year, typically 4 digits */
  year: string
  /**
   * LED pattern id 0–20 or 99 (blackout) for this song (see shared/ledPatterns.ts).
   * Default is 20 (random — sequential rotate of 1..19 on ESP).
   * Id 0 (knight_rider) is boot / between-songs idle (also PC 126).
   * Id 99 (blackout) is manual/special — also MIDI PC 125; not in the random rotator.
   * Queued when the song is selected for display; applied via MIDI PC 127
   * (or the control UI simulate / pattern preview).
   */
  ledPattern: number
}

export type ArrangerMidiMapping = {
  /** Note On pulse or CC 127 on ViewerOne's existing Cubase output. */
  mode: 'note' | 'cc'
  /** MIDI channel 1–16. */
  channel: number
  /** MIDI note/CC number 0–127. */
  prevNumber: number
  /** MIDI note/CC number 0–127. */
  nextNumber: number
}

/**
 * Cubase → ViewerOne transport Start/Stop mapping (Generic Remote / MIDI Remote).
 * MIDI realtime (0xFA/FB/FC) and MMC Play/Stop are always accepted in addition.
 */
export type TransportMidiMapping = {
  /** Mapped Start/Stop message type from Cubase Generic Remote. */
  mode: 'note' | 'cc'
  /** MIDI channel 1–16, or 0 = any channel. */
  channel: number
  /** Note or CC number for Start (0–127). */
  startNumber: number
  /** Note or CC number for Stop (0–127). */
  stopNumber: number
}

/** What this Cubase→ViewerOne message means for Live status / countdown. */
export type MidiSpyRole = 'SONG' | 'MUTE' | 'TRANSPORT' | 'OTHER'

/** Compact line for the Cubase→ViewerOne MIDI activity spy. */
export type MidiSpyEvent = {
  atMs: number
  kind:
    | 'noteon'
    | 'noteoff'
    | 'cc'
    | 'program'
    | 'sysex'
    | 'mmc'
    | 'start'
    | 'continue'
    | 'stop'
    | 'clock'
    | 'other'
  /** Role tag so Play/Stop stands out from song PCs and mute CCs. */
  role: MidiSpyRole
  /** Short human label, e.g. "ch16 note 60 vel 127". */
  summary: string
}

export type ArrangerScanState = {
  active: boolean
  phase: 'idle' | 'scanning' | 'returning' | 'complete' | 'cancelled' | 'error'
  collected: number
  message: string
}

export type AppState = {
  /** Cubase / mixer ↔ ViewerOne / ESP: muted = tint + CC 0/127 out (see shared/midiConfig.ts) */
  fxMuted: boolean
  /** CrowPanel Group1 / ALL mute, independent from Group6 / FX. */
  allMuted: boolean
  setlist: SetlistItem[]
  /** Row id from last matched program change; null until first PC */
  currentSongId: string | null
  /** When true, push current song/year JSON over USB serial (CH340 / USB-serial autodetect; replug supported). */
  esp32Enabled: boolean
  /** LED brightness 0–255 (capped when not on external PSU). */
  ledBrightness: number
  /** When false, strip is assumed powered from ESP32/USB — brightness hard-capped. */
  ledExternalPower: boolean
  /** Cubase Generic Remote mapping used for Arranger Prev / Next. */
  arrangerMidi: ArrangerMidiMapping
  /** Cubase → ViewerOne Start/Stop mapping (notes/CC); realtime + MMC always on. */
  transportMidi: TransportMidiMapping
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
  /**
   * Recent inbound messages on CubaseToViewerOne (newest last).
   * Use this to see what Cubase actually sends on Play/Stop.
   */
  cubaseSpy: MidiSpyEvent[]
  /** Hint when Play arrives as a mismatched note/CC/channel — null when healthy. */
  transportHint: string | null
}

export type PublicState = AppState & {
  /** From package.json / Electron app.getVersion() */
  appVersion: string
  midi: MidiStatus
  /** Active WS2812 pattern id/name from the ESP (e.g. knight_rider, off). */
  ledPattern: string
  /** Connected physical display identity; unknown/disconnected previews fall back to CYD. */
  esp32Display: Esp32DisplayStatus
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
  ledMidiPulse: 125 | 126 | 127 | null
  /** `Date.now()` when {@link ledMidiPulse} was last set (changes on every trigger). */
  ledMidiPulseAt: number
  /** Absolute CrowPanel PROMPT indicator state (PC 120/121 and 122/123). */
  prompt1On: boolean
  prompt2On: boolean
  /** Last prompt PC fired by Cubase or the simulate controls. */
  promptMidiPulse: 120 | 121 | 122 | 123 | null
  /** `Date.now()` when {@link promptMidiPulse} was last set. */
  promptMidiPulseAt: number
  /** Ephemeral progress for the Cubase Arranger setlist scan. */
  arrangerScan: ArrangerScanState
  /** Ephemeral Cubase-synced song countdown; setlist length remains the source of truth. */
  countdown: {
    running: boolean
    /** Current display value (full length idle, remaining while playing/paused), or empty if unknown. */
    display: string
    remainingSeconds: number | null
    totalSeconds: number | null
  }
  /**
   * Last Cubase transport Start/Stop heard on CubaseToViewerOne.
   * `playing` follows Start/Stop even when no song is selected (countdown may stay idle).
   */
  transport: {
    playing: boolean
    /** note | cc | MMC | realtime — null until the first transport message. */
    lastSource: string | null
    lastAction: 'start' | 'stop' | null
    lastAtMs: number | null
  }
}
