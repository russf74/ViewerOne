# Changelog

## v5.0.2

- Setlist field is now **Year** (4-digit release year) instead of chords.
- ESP32 mute indicator: bright red title + year text on a black background (no solid red fill);
  unmuted text is white.
- Slightly smaller song title on the ESP; desktop ESP preview font sizes/colours aligned to match.

## v5.0.1

- Version number now shows in the app's window/taskbar title ("ViewerOne v5.0.1 — Control")
  instead of a printed badge inside the window.

## v5.0.0

Major reliability and MIDI-sync overhaul, plus an ESP32 touchscreen fix — the result of a full
day tracking down live-performance sync issues between ViewerOne, Cubase, the X32 mixer and the
ESP32 display.

### ESP32 connection reliability
- The ESP32 display now auto-detects its own USB COM port — no more manually picking a port in
  settings.
- If the ESP32 is unplugged and plugged back in while ViewerOne is running, it automatically
  reconnects on its own; no more restarting the app mid-gig.
- Added a firmware watchdog: if the display's main loop ever hangs, the board reboots itself
  automatically and immediately re-syncs the current song/mute state with ViewerOne — no manual
  power-cycling needed.

### Display
- The "muted" background on the ESP32 screen is now a much brighter red, visible in direct
  outdoor sunlight (the desktop preview was updated to match).

### Mute sync (Cubase / mixer / ViewerOne / ESP32)
- Diagnosed and fixed FX-mute sync breaking between the mixer, Cubase and ViewerOne.
- ViewerOne now talks directly, two-way, to the X32 mixer over its own USB MIDI port — a mute
  press on the mixer reaches ViewerOne immediately, and ViewerOne's own mute changes (from the
  ESP32 touchscreen or the app) reach the mixer directly, independent of Cubase.
  Cubase keeps its existing one-way sync of song changes and its own auto-mute automation into
  ViewerOne.
- Removed all manual MIDI configuration — no more port dropdowns, channel numbers or CC fields.
  Every MIDI connection (Cubase, mixer) is now detected automatically by device name, using
  fixed, verified channel/CC conventions under the hood.
- Added a live MIDI status panel in the app so the Cubase and mixer connection state — including
  what was last sent/received — is always visible instead of being a mystery.

### ESP32 touchscreen
- Fixed touch-bounce/chatter: a single tap could occasionally fire several rapid, contradictory
  mute toggles in a row. Fixed with a short "confirm" delay on the raw touch signal plus a brief
  cooldown between toggles — chatter is suppressed without making genuine taps feel unresponsive.
