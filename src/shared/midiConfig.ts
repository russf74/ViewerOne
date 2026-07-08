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
 */

/** Song-select Program Change, 1–16. */
export const CUBASE_PC_CHANNEL = 2

/** Cubase's own mute CC convention: muted = value 0, unmuted = value 127. */
export const CUBASE_MUTE_CHANNEL = 1
export const CUBASE_MUTE_CC = 85

/** The mixer's own (X32) channel-mute CC convention: muted = value 127, unmuted = value 0. */
export const MIXER_MUTE_CHANNEL = 2
export const MIXER_MUTE_CC = 63
export const MIXER_MUTE_INVERTED = true
