# Changelog

## v5.6.4

- **Hardened against EPIPE / broken-pipe crashes:** Windows Electron can throw
  `EPIPE: broken pipe, write` from `console.log` when stdout has no console (or the parent
  closed the pipe). That used to surface as an uncaught exception from easymidi MIDI input
  handlers and kill the main process mid-gig. Process guards now wrap console, ignore
  EPIPE/ECONNRESET, and keep the app alive on recoverable MIDI/serial errors.
- MIDI send paths (Cubase + mixer) catch failures, drop the dead port, and schedule reconnect.
- ESP32 serial writes never throw; failed writes dispose the port and reconnect.
- MIDI/ESP input callbacks swallow handler exceptions so they cannot escape into easymidi/serialport.

## v5.6.3

- **Revert mic-mute LED sync:** lights change only via PC 126 / PC 127 (and the test
  buttons / pattern preview dropdown). Mic mute updates display tint + MIDI CC only.
- Song select again updates display + queues the pattern — no auto LED apply on mute or
  song change. ESP reconnect / boot no longer forces LEDs from mute state (board keeps
  its own knight_rider until PC 127).

## v5.6.2

- **LED idle/active follows mic mute:** muted → dim slow knight_rider (same as PC 126);
  unmuted → apply the displayed song’s pattern (same as PC 127). Cubase CC, mixer CC, and
  ESP touchscreen `mute_toggle` all drive this via `applyFxMuted`.
- Song display changes while unmuted also apply that song’s queued LED pattern; while muted,
  idle KR stays even if the LCD song changes.
- PC 126 / PC 127 remain manual overrides for testing; the next mute change from any source
  re-applies mic-driven lights.
- ESP serial open / board boot resyncs LEDs from current mute (or idle override), not stale
  boot knight_rider.
- Control UI hint text updated near PC 126/127 and in MIDI / ESP settings.

## v5.6.1

- **bass_pulse**: replaced whole-strip thump + hue jumps with layered violet/magenta
  pressure rollers (aurora/lava-style continuous motion) — busy and tasteful, not woozy.

## v5.6.0

- **prism_spin**: faster spin / clearer motion while keeping soft wedge blends (less static,
  still non-stroby).
- **New pattern id 20 — random**: meta-pattern that sequentially rotates through busy patterns
  1→19 every ~10 seconds (skips knight_rider). TFT footer shows
  `20 - Random › NN - Child` when space allows.
- Default every setlist song to **random (20)** (normalize / auto-assign / new song / startup
  migration). Between songs still PC 126 → knight_rider; PC 127 applies the song’s random rotator.
- PC clamp / `pushEsp32LedPattern` / preview dropdown allow ids 0–20. LED-Driver controller
  lists `random`.

## v5.5.1

- Control UI: **Test pattern** dropdown under PC 126/127 buttons lists all LED patterns
  (`00 - Knight Rider` …) with Prev/Next for quick scrubbing. Selecting a pattern applies it
  immediately to the ESP (`pushEsp32LedPattern` + normal brightness) and updates the preview
  footer — live override only; does not change the song’s stored `ledPattern`.
- IPC `led:previewPattern` (id 0–19) via preload `previewLedPattern`.

## v5.5.0

- **Pattern id 1:** replaced **faster_knight_rider** with **aurora** (busy teal/green/violet
  curtains). Knight rider (id 0) remains boot / between-songs / PC 126 only.
- **Cubase MIDI Program Change:** accept incoming PC on **any MIDI channel** (was filtered to
  channel 2 only — Cubase tracks often send on ch 1, so every PC was silently dropped).
  Outbound PC still uses channel 2. Control UI shows a dedicated **Last Cubase PC** line
  (program · channel · ago) so any incoming PC is visible; console logs every PC with channel.
- loopMIDI naming reminder in status text: Cubase track Output must be `CubaseToViewerOne`.

## v5.4.3

- **MIDI reconnect hardened:** Reconnect MIDI now starts loopMIDI if needed, fully closes
  Cubase/mixer handles, waits for the OS device list to settle, then re-detects and opens
  with retries (fixes silent “button does nothing” after a failed close/reopen).
- Cubase status tracks real open/closed handles (`cubaseInputOpen` / `cubaseOutputOpen`), not
  just detected port names.
- Reconnect shows a clear status line (“MIDI reconnected — Cubase: …; Mixer: …” or an error
  if nothing opened). Control buttons flash briefly on click (Reconnect, PC 126/127 tests,
  Prev/Next, Add song).
- Song PC 1–125 and LED PC 126/127 handlers unchanged in behaviour; incoming PCs are logged
  for easier diagnosis.

## v5.4.2

- Control UI: larger **Queued:** line under the ESP32 simulated preview.
- Two test buttons under the queue line simulate reserved LED program changes
  (`PC 126 · Idle lights`, `PC 127 · Apply lights`) via the same handlers as real Cubase MIDI.
- Incoming PC 126/127 (DAW or buttons) briefly flash the matching button
  (`ledMidiPulse` / `ledMidiPulseAt` on PublicState).

## v5.4.1

- Control UI: show **Queued:** LED pattern below the ESP32 simulated preview (not on the LCD
  chrome). Always reflects the currently displayed song’s pattern (`Queued: 03 - Ocean`, or
  `Queued: —` when idle). PublicState exposes `queuedLedPattern`.

## v5.4.0

- **LED control independent of song display.** MIDI song select (PC 1–125) updates title/year/mute
  on the ESP but only *queues* that song’s LED pattern — it no longer pushes LEDs immediately.
- **PC 126** (wire 125): LED idle — dim slow knight rider (pattern 0) between songs.
- **PC 127** (wire 126): LED go — apply the currently displayed song’s pattern and restore
  normal brightness. Setlist programs are capped at 125 so they never collide with these.
- Preview / row click / next-prev behave like song select (display + queue, no auto LED apply).

## v5.3.4

- ESP32 TFT pattern footer matches ViewerOne labels (`00 - Knight Rider`, `01 - Faster Knight Rider`, …).
  JSON `name` field remains underscored (`faster_knight_rider`) for the serial protocol.

## v5.3.3

- Pattern labels use zero-padded **ids** (`00 - Knight Rider`, `01 - …`, … `19 - …`).
- **knight_rider** (id 0) is boot / “Waiting for signal” only; songs no longer default to it.
  Returning to waiting sends pattern 0 to the ESP.
- Replaced **aurora** (id 1) with **faster_knight_rider**: quicker scan, hotter red trail,
  longer aggressive tail (noticeably different from default KR).
- On startup (and when adding songs), setlist LED patterns are assigned sequentially
  `1, 2, …` wrapping (skipping 0) so songs are not all the same pattern.

## v5.3.2

- **lava**: replaced vent/heat fill with continuous red/orange/yellow molten waves
  (ocean-like flow, smooth motion, midpoint-mirrored). Pattern id 4 / name unchanged.

## v5.3.1

- **spark_shower**: dense sparks across the full logical half (both mirrored halves fill).
- **prism_spin**: slower rotation with soft wedge blends (less strobe-y).
- **disco_ball**: slowed facet spin.
- **lava**: vents span the full half including logical 0; softer convection so strip
  ends light properly under midpoint mirroring.

## v5.3.0

- Pattern dropdown labels are numbered (`00 - Knight Rider` … `19 - Roller Derby`
  as of v5.3.3; originally shipped as `01`–`20`).
- Ten new busy disco patterns (ids 10–19): strobe wave, disco ball, laser sweep, bass
  pulse, confetti storm, hyper chase, prism spin, spark shower, color bomb, roller derby.
  Existing ids 0–9 unchanged (setlists keep working). TFT footer still shows the short name.

## v5.2.4

- **Starfield**: stronger navy/blue base wash (closer to cyber_rain green intensity) while
  keeping soft white sparkles and smooth motion.

## v5.2.3

- Replaced **starburst** (id 5) with **starfield**: deep navy blue galaxy wash plus soft
  white sparkles (mirrored). Setlist entries that used pattern id 5 keep working; UI label
  is now Starfield.

## v5.2.2

- **Lava**: more ongoing motion — multiple wandering vents, varied blob sizes, occasional
  brighter surges, and shifting colors within the magma palette (still smooth, not flickery).
- **Dual comet**: four comets with longer fading tails and varied speeds (still mirrored).

## v5.2.1

- Replaced lightning / heartbeat with smooth **dual comet** and **neon pulse** patterns.
- All LED patterns now mirror at strip midpoint (logical half written to both joined halves).

## v5.2.0

- Nine new LED patterns (aurora, lightning, ocean, lava, starburst, cyber rain, rainbow ripple,
  heartbeat, galaxy) plus Knight Rider; larger pattern name footer on the ESP and desktop preview.
- Setlist **Live** checkbox replaced with a per-song **Pattern** dropdown; selecting/displaying a
  song sends that pattern to the ESP.
- LED brightness slider + “external 5V PSU” checkbox: USB power caps brightness at 56; full 0–255
  only with external PSU. Settings persist and are pushed over serial with song updates.

## v5.1.1

- ESP32 + desktop preview: show the active LED pattern name in a small footer under the year.
  Pattern label updates when the strip pattern changes; boot handshake includes the current pattern.

## v5.1.0

- ESP32 firmware: WS2812B LED patterns run on the same CYD board as the setlist display
  (data on **GPIO 27** / CN1). Display JSON protocol unchanged; LED uses `{"led":...}` commands.
  Boot default remains Knight Rider. Desktop ignores `evt:led` replies so mute/boot behaviour
  is unaffected.

## v5.0.5

- Mute colours: muted = bright yellow text on dark navy background; unmuted = vivid lime on black.

## v5.0.4

- Mute colours: muted = bright yellow text; unmuted = vivid lime green (black background).

## v5.0.3

- Mute colours: muted = white text; unmuted = vivid lime green (black background).

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
