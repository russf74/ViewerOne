/**
 * Hardcoded MIDI convention for this rig. There's only one Cubase project and one mixer, so
 * these never need to change at runtime — no settings UI, no dropdowns, just fixed values.
 *
 * Wiring (ViewerOne is the mute hub — not a general MIDI thru):
 *  - Cubase ↔ ViewerOne (two-way, over a loopMIDI cable pair): song/transport + Cubase mute
 *    CCs (ch1 CC88/85/86/87). When Cubase sends FX mute (CC85) / ALL mute (CC88), ViewerOne
 *    updates UI/ESP and forwards to the mixer (FX → ch2/CC85 mute group 6; ALL → ch2/CC80 mute
 *    group 1). ViewerOne mute changes are sent back to Cubase so its Generic Remote /
 *    automation stay in sync.
 *  - Mixer ↔ ViewerOne (two-way, directly on X-USB): mixer mute TX updates ViewerOne + Cubase
 *    (ch2/CC85 mute group 6 → FX / Cubase CC85; ch2/CC80 mute group 1 → ALL / Cubase CC88).
 *    ViewerOne mute changes go straight to the mixer. Works with Cubase closed. Cubase does not
 *    need its own "X32 Mutes" → X-USB track for these mutes anymore (that track can fight
 *    ViewerOne for the port / double-send). Keep X32 Setup → MIDI mute RX+TX enabled. If Cubase
 *    holds X-USB IN exclusive, mixer → ViewerOne goes dark — turn exclusive off or leave X-USB
 *    IN unused in Cubase MIDI Port Setup.
 *  - ESP32 (two-way, over USB serial, auto-detected COM port — see esp32Serial.ts): shows
 *    whatever ViewerOne currently thinks the state is, and a touch on the screen toggles mute
 *    the same way the mixer or Cubase would.
 *
 * loopMIDI cable names (auto-detected, must include both “Cubase” and “ViewerOne”/“Viewer1”):
 *  - Cubase → ViewerOne: name with Cubase *before* ViewerOne, e.g. "CubaseToViewerOne"
 *    (Cubase MIDI track Output = this port; ViewerOne opens it as its input).
 *  - ViewerOne → Cubase: name with ViewerOne *before* Cubase, e.g. "ViewerOneToCubase".
 *
 * Program Change numbering:
 *  - Incoming PC is accepted on **any MIDI channel** (Cubase tracks often send on ch 1 by
 *    default; {@link CUBASE_PC_CHANNEL} is only the preferred channel for ViewerOne→Cubase
 *    outbound PC). The control UI shows last received PC + channel.
 *  - MIDI wire is always 0–127. ViewerOne’s setlist / Cubase-style “PC” is wire + 1 (so wire 0
 *    → song PC 1, wire 118 → song PC 119).
 *  - Song select: PC 1–119 only (wire 0–118). Selecting a song updates the display and queues
 *    that song’s LED pattern — it does NOT push LEDs to the ESP.
 *  - PC 120/121 (wire 119/120): legacy PROMPT 1 on/off (host Detail tests; no CrowPanel pads).
 *  - PC 122/123 (wire 121/122): legacy PROMPT 2 on/off (host Detail tests; no CrowPanel pads).
 *  - CrowPanel ALL pad (Cubase Group 1): mute via CC 88 on ch 1 (FX polarity — see below).
 *    Cubase ALL CC88 ≠ mixer MG1 CC80 and outside X32 MG range 80–85 (CC84 is native MG5 —
 *    any CC84 to the mixer mutes MG5). Cubase FX CC85 and mixer MG6 CC85 share the number but
 *    differ by port/channel/echo key (`cubase:85` vs `mixer:85`) — intentional (Group 6).
 *  - CrowPanel SYNTH / PIANO pads: Cubase mixer mute via CC 86 / 87 on ch 1 (see below).
 *  - PC 124 (wire 123): reserved.
 *  - PC 125 (wire 124): LED blackout — all LEDs off (pattern id 99).
 *  - PC 126 (wire 125): LED idle — dim slow knight rider (pattern id 0) between songs.
 *  - PC 127 (wire 126): LED go / apply — push the currently displayed song’s ledPattern
 *    (or knight_rider if no song) and restore normal brightness.
 *  - Wire 127 (would be “PC 128”) is unused; reserved PCs never match setlist rows.
 */

/**
 * Preferred channel (1–16) for ViewerOne → Cubase Program Change *output*.
 * Incoming Cubase PC is accepted on any channel (see midi.ts).
 */
export const CUBASE_PC_CHANNEL = 2

/**
 * Default Cubase Generic Remote transport pulses (original ViewerOne mapping).
 * Overridable at runtime via AppState.transportMidi.
 *
 * Also accepted (always on, no settings needed):
 *  - MIDI realtime Start/Continue/Stop (0xFA / 0xFB / 0xFC)
 *  - MMC Play / Deferred Play / Stop / Pause
 *
 * Important: song Program Changes usually come from a Cubase MIDI track routed to
 * CubaseToViewerOne. Transport realtime/MMC is configured separately in Cubase
 * (Project Synchronization Setup → MIDI Clock / MMC destinations) OR via Generic
 * Remote notes/CCs on that same port. If song PCs work but Play never shows in the
 * MIDI spy, Cubase is not sending transport on CubaseToViewerOne yet.
 */
export const CUBASE_TRANSPORT_CHANNEL = 16
export const CUBASE_TRANSPORT_START_NOTE = 60
export const CUBASE_TRANSPORT_STOP_NOTE = 61
/** How many recent Cubase→ViewerOne messages the Live status spy keeps. */
export const CUBASE_MIDI_SPY_LIMIT = 14

/**
 * Highest setlist program (1-based Cubase/UI PC). Songs use 1…{@link MIDI_PC_SONG_MAX};
 * PCs 120–127 are reserved for prompt indicators and LEDs.
 */
export const MIDI_PC_SONG_MAX = 119

/** PROMPT 1 on/off use absolute Cubase/UI PCs 120/121 (wire 119/120). */
export const MIDI_PC_PROMPT_1_ON = 120
export const MIDI_PC_PROMPT_1_OFF = 121

/** PROMPT 2 on/off use absolute Cubase/UI PCs 122/123 (wire 121/122). */
export const MIDI_PC_PROMPT_2_ON = 122
export const MIDI_PC_PROMPT_2_OFF = 123

/**
 * LED blackout: all LEDs solid off (pattern id 99).
 * Cubase/UI PC **125** = MIDI wire program **124**.
 */
export const MIDI_PC_LED_BLACKOUT = 125

/**
 * LED idle (between songs): dim slow knight rider (pattern id 0).
 * Cubase/UI PC **126** = MIDI wire program **125**.
 */
export const MIDI_PC_LED_IDLE = 126

/**
 * LED go / apply: push LEDs for the currently displayed song.
 * Cubase/UI PC **127** = MIDI wire program **126**.
 */
export const MIDI_PC_LED_APPLY = 127

/**
 * Temporary strip brightness while LED idle (PC 126) is active.
 * Restored to settings `ledBrightness` on PC 125 / 127 / apply / preview.
 */
export const LED_IDLE_DIM_BRIGHTNESS = 32

/** Cubase's own mute CC convention: muted = value 0, unmuted = value 127. */
export const CUBASE_MUTE_CHANNEL = 1
export const CUBASE_MUTE_CC = 85

/**
 * CrowPanel ALL pad → Cubase Group 1 / ALL mute on ViewerOneToCubase.
 * Channel {@link CUBASE_MUTE_CHANNEL}. Same polarity as FX {@link CUBASE_MUTE_CC}:
 * muted → 0, live/unmuted → 127.
 *
 * Cubase Generic Remote (map on the ViewerOne → Cubase port):
 *  - CC {@link CUBASE_ALL_MUTE_CC} → Group 1 Mute (or your ALL / VCA mute)
 *
 * Must NOT equal mixer mute-group CC80 (echo flash loop) or land in X32 MG range 80–85
 * (CC84 is native Mute Group 5 — any CC84 reaching the mixer mutes MG5). Also avoid
 * CC86/87 (synth/piano). Use CC88.
 *
 * Flags: **Jump / Value** (absolute) — do NOT enable Toggle or Push Button.
 * Reverse-map the same CC on CubaseToViewerOne for Cubase → ViewerOne / ESP sync.
 */
export const CUBASE_ALL_MUTE_CC = 88

/**
 * CrowPanel SYNTH / PIANO pads → Cubase mixer channel mutes on ViewerOneToCubase.
 * Channel {@link CUBASE_MUTE_CHANNEL}. Polarity is **inverted vs FX CC85** for Jump/Value
 * Generic Remote: muted → 127, live/unmuted → 0 (see {@link CUBASE_CHANNEL_MUTE_INVERTED}).
 *
 * Cubase Generic Remote (map on the ViewerOne → Cubase port):
 *  - CC {@link CUBASE_SYNTH_MUTE_CC} → Mixer Channel 1 ("Synth") Mute
 *  - CC {@link CUBASE_PIANO_MUTE_CC} → Mixer Channel 2 ("Piano") Mute
 *
 * Flags: **Jump / Value** (absolute) — do NOT enable Toggle or Push Button.
 * Optionally reverse-map the same CCs on CubaseToViewerOne (same inverted polarity).
 */
export const CUBASE_SYNTH_MUTE_CC = 86
export const CUBASE_PIANO_MUTE_CC = 87

/**
 * Synth/Piano (CC86/87) Jump/Value polarity vs Cubase mixer mute.
 * true → muted=127, live=0 (opposite of FX CC85). UI green=live stays unchanged.
 */
export const CUBASE_CHANNEL_MUTE_INVERTED = true

export function isCubaseChannelMuteCc(controller: number): boolean {
  return controller === CUBASE_SYNTH_MUTE_CC || controller === CUBASE_PIANO_MUTE_CC
}

/**
 * Absolute Cubase mute CC value.
 * FX CC85 / ALL CC88: 0=muted, 127=live.
 * Synth/Piano when inverted: 127=muted, 0=live.
 */
export function cubaseMuteCcValue(muted: boolean, controller = CUBASE_MUTE_CC): number {
  const inverted = CUBASE_CHANNEL_MUTE_INVERTED && isCubaseChannelMuteCc(controller)
  return inverted ? (muted ? 127 : 0) : muted ? 0 : 127
}

/** Ignore mute CC echoes for this long after we send on that controller (Cubase or mixer). */
export const MUTE_ECHO_IGNORE_MS = 450
/** @deprecated Use {@link MUTE_ECHO_IGNORE_MS} — kept as alias for older call sites. */
export const CUBASE_MUTE_ECHO_IGNORE_MS = MUTE_ECHO_IGNORE_MS

/**
 * Mixer (X32) mute CCs on {@link MIXER_MUTE_CHANNEL}.
 *
 * X32 MIDI CC map (ch 2): CC0–31 channel mutes, CC48–63 bus mutes, CC80–85 mute groups 1–6.
 * Bridged mutes are **both mute groups** (not bus 16):
 *  - FX / Group6: Cubase ch1/CC85 ↔ mixer mute group 6 CC85
 *  - ALL / Group1: Cubase ch1/CC88 ↔ mixer mute group 1 CC80
 *
 * Polarity (live X-USB capture — mute groups ≠ bus/channel):
 *  - Bus/channel mute (e.g. CC63 bus 16): 127 = muted, 0 = unmuted
 *  - Mute group master (CC80–85): 0 = group active/muted, 127 = group off/live
 *    (engaging MG6 TX: CC85=0 + member buses CC61–63=127; release: CC85=127 + buses=0)
 * Bridged FX+ALL therefore encode/decode with 0=muted (opposite of the old bus-16 path).
 *
 * Cubase boundary unchanged: 0 = muted, 127 = live (CC88/85).
 */
export const MIXER_MUTE_CHANNEL = 2
/** FX / Group6 path: X32 Mute Group 6 (was wrongly bus 16 / CC63 in ≤5.12.36). */
export const MIXER_MUTE_CC = 85
/** ALL / Group1 path: X32 Mute Group 1. */
export const MIXER_ALL_MUTE_CC = 80
/**
 * Mute-group wire polarity vs “127=muted” bus convention.
 * false → muted=0, live=127 (required for MG1/MG6; matches live X32 TX).
 */
export const MIXER_MUTE_INVERTED = false

export function isMixerMuteCc(controller: number): boolean {
  return controller === MIXER_MUTE_CC || controller === MIXER_ALL_MUTE_CC
}

/** Absolute X32 mute-group CC value (MG1 + MG6): muted→0, live→127. */
export function mixerMuteCcValue(muted: boolean): number {
  return MIXER_MUTE_INVERTED ? (muted ? 127 : 0) : muted ? 0 : 127
}

/**
 * Decode a mute CC wire value → muted boolean.
 * Cubase FX/ALL (non-inverted): value < 64 → muted.
 * Mixer mute groups (non-inverted): value < 64 → muted (0=active).
 * Inverted Cubase channel mutes / bus-style: value ≥ 64 → muted.
 */
export function ccValueToMuted(value: number, inverted = false): boolean {
  return inverted ? value >= 64 : value < 64
}

/** Decode mixer ch2 mute-group CC (MG6 / MG1) — same polarity for FX and ALL. */
export function ccValueToMixerMuted(value: number): boolean {
  return ccValueToMuted(value, MIXER_MUTE_INVERTED)
}

/** Shared Cubase↔VO↔mixer mute bridges — FX and ALL use the same process; only CCs/keys differ. */
export type BridgedMuteId = 'fx' | 'all'
export type BridgedMuteStateKey = 'fxMuted' | 'allMuted'

export type BridgedMuteDef = {
  id: BridgedMuteId
  stateKey: BridgedMuteStateKey
  cubaseCc: number
  mixerCc: number
  /** CrowPanel / ESP `group` field (bare mute_toggle with no group → fx). */
  espGroup: string
}

export const BRIDGED_MUTES: readonly BridgedMuteDef[] = [
  {
    id: 'fx',
    stateKey: 'fxMuted',
    cubaseCc: CUBASE_MUTE_CC,
    mixerCc: MIXER_MUTE_CC,
    espGroup: 'fx'
  },
  {
    id: 'all',
    stateKey: 'allMuted',
    cubaseCc: CUBASE_ALL_MUTE_CC,
    mixerCc: MIXER_ALL_MUTE_CC,
    espGroup: 'all'
  }
] as const

export function bridgedMuteById(id: BridgedMuteId): BridgedMuteDef {
  const def = BRIDGED_MUTES.find((b) => b.id === id)
  if (!def) throw new Error(`Unknown bridged mute id: ${id}`)
  return def
}

export function bridgedMuteByCubaseCc(controller: number): BridgedMuteDef | undefined {
  return BRIDGED_MUTES.find((b) => b.cubaseCc === controller)
}

export function bridgedMuteByMixerCc(controller: number): BridgedMuteDef | undefined {
  return BRIDGED_MUTES.find((b) => b.mixerCc === controller)
}

export function bridgedMuteByEspGroup(group: string): BridgedMuteDef | undefined {
  const g = group.toLowerCase()
  if (!g || g === 'fx') return bridgedMuteById('fx')
  return BRIDGED_MUTES.find((b) => b.espGroup === g)
}
