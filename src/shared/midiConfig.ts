/**
 * Hardcoded MIDI convention for this rig. There's only one Cubase project and one mixer, so
 * these never need to change at runtime — no settings UI, no dropdowns, just fixed values.
 *
 * Wiring:
 *  - Cubase ↔ ViewerOne (two-way, over a loopMIDI cable pair): song changes (Program Change) and
 *    Cubase's own auto-mute automation arrive from Cubase; ViewerOne's own mute changes (ESP
 *    touch / checkbox / mixer) are sent back to Cubase (its own private ch1/CC85 convention) so
 *    Cubase's state/automation doesn't go stale.
 *  - Mixer ↔ ViewerOne (two-way, directly over the mixer's own USB MIDI port, independent of
 *    Cubase): a mute press on the mixer reaches ViewerOne directly, and ViewerOne's own mute
 *    changes are sent straight to the mixer in its native ch2/CC63 convention. This keeps
 *    working even with Cubase closed. Note: if Cubase is also holding the mixer's output port
 *    open for its own relay, ViewerOne's attempt to open it too may fail depending on the
 *    driver — this degrades gracefully (see midi.ts openMixerOutput) rather than crashing.
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
 *    → song PC 1, wire 124 → song PC 125).
 *  - Song select: PC 1–125 only (wire 0–124). Selecting a song updates the display and queues
 *    that song’s LED pattern — it does NOT push LEDs to the ESP.
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
 * Highest setlist program (1-based Cubase/UI PC). Songs use 1…{@link MIDI_PC_SONG_MAX}.
 * {@link MIDI_PC_LED_IDLE} and {@link MIDI_PC_LED_APPLY} are reserved and must not be assigned.
 */
export const MIDI_PC_SONG_MAX = 125

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
 * Restored to settings `ledBrightness` on PC 127 / apply.
 */
export const LED_IDLE_DIM_BRIGHTNESS = 32

/** Cubase's own mute CC convention: muted = value 0, unmuted = value 127. */
export const CUBASE_MUTE_CHANNEL = 1
export const CUBASE_MUTE_CC = 85

/** The mixer's own (X32) channel-mute CC convention: muted = value 127, unmuted = value 0. */
export const MIXER_MUTE_CHANNEL = 2
export const MIXER_MUTE_CC = 63
export const MIXER_MUTE_INVERTED = true
