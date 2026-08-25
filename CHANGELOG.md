# Changelog

## v5.12.86

- Arranger scan now visits **Soundcheck** and reads its Cubase Info Line length (it was
  skipped so the song countdown stayed blank). Name matching treats `Sound Check` /
  `Soundcheck (Reflex)` / OCR `5oundcheck` as the same event. Gig duration and numbered
  song totals still exclude Soundcheck; a failed Soundcheck length does not block gig-ready.

## v5.12.85

- Info Line OCR: scale the Name/Start/End/Length strip 4–5× (native WinOCR only
  saw labels). When Windows still blanks times, Tesseract reads the times strip
  (e.g. Sit down `0:03:55.000`) instead of thickened-length garbage.
- After chain locate, click the colour-matched Arranger block (not the playhead)
  so Info Line Name/Length stay on the walked song. Wrong chip hits are retried
  with that X excluded. Grab PowerShell timeout raised to 75s for retries.
- Prefer Tesseract of the times strip over Windows OCR lengths (WinOCR was
  writing keepable-but-wrong times). Title OCR maps `1m`→`I'm` and `END SONGS`→OUTRO.
- Unglue Tesseract Start/End/Length strings so glued OCR no longer invents
  false lengths like `02:05`.
- When End OCR drops out, treat absolute Start + short Length as Start+Length
  (fixes Reach for the stars reading as `02:12` instead of `~4:12`).
- Scan prepare: grow Cubase height a bit and thicken the Arranger Track lane
  (no Zoom Full / no maximize) so event blocks are clickable for OCR.
- Gig-ready follows the setlist lengths, not rewind-home success — a solid walk
  no longer shows “not gig-ready: last Arranger scan was incomplete”.

## v5.12.84

- Length OCR uses PrintWindow of Cubase (and minimizes ViewerOne during the
  grab) so Electron no longer covers the Info Line. Play-arrow locate stays
  single-click only.

## v5.12.83

- MIDI Next/Prev still walks the chain. Length OCR uses a **single click** on
  the named Arranger block, or the Current Chain play arrow if that block is
  off-screen. Double-click / space / transport are never sent (those start Play).
  Info Line Name must match before a time is stored.

## v5.12.82

- Arranger scan length is **MIDI Next/Prev + Info Line OCR only**. ViewerOne does
  not click Cubase or send keyboard (those were starting playback — not the
  chain play arrows). Name must still match before a length is written.

## v5.12.81

- Length clicks only the **named Arranger Track block**. Play-triangle /
  Arranger Events play-arrow clicks are gone — those start Cubase playback.

## v5.12.80

- Scan walk now reaches **OUTRO** (16 events). Length clicks target the Arranger
  Track lane (not MIDI clips below it). If a song is off-screen, Ctrl+wheel zooms
  **time** until the named block is visible — not Zoom Full.
- Gig-ready stays blocked when any visited song could not be read from Cubase
  this scan (old times are not treated as a fresh pass).

## v5.12.79

- Length locate clicks the **play triangle** (not the title) on the Current Chain
  row when the named Arranger block is off-screen.
- Arranger-lane detect stays in the **top of the project zone**. MIDI/audio lanes
  (more colour changes, lower on screen) were winning, so the named Arranger
  block was never clicked and Info Line stayed on the previous song.
- MIDI restore after a stray click prefers Next/Prev toward the walk song
  (max 8 steps each way) instead of 20 blind pulses that skipped the rest of the chain.

## v5.12.78

- Clicks only an Arranger block whose **name is visible**, or the current
  chain-row play triangle. Random colour-matched clicks were jumping Cubase
  and stopping the walk after a few songs. After each grab, MIDI is restored
  to the walk song before Next.
- Songs with no Cubase length are not skipped: 5 grab attempts, then a repair
  pass. Scan stays incomplete / not gig-ready until every visited song (except
  Soundcheck) has a keepable time.

## v5.12.77

- Length grab locates the **named Current Chain row** (scrolls the list if needed), stops
  transport, then clicks the Arranger block **at the playhead** — that is what updates the
  Cubase Info Line. Missing lengths are no longer skipped: each song retries up to 3 times,
  and the scan is marked incomplete until every visited song (except Soundcheck) has a time.
- Duration line flags blank scanned lengths in red so a gig total cannot silently drop a song.

## v5.12.76

- Arranger scan rewind uses real MIDI note lengths again (40ms, 55ms apart). The 8ms
  rewind pulses were too short for Cubase Generic Remote, so Previous never reached the
  first chain event and the walk started on a leftover song, then died after 1–2 titles.
- Length click only happens when the **named Arranger block is visible** on the timeline.
  Inspector list / playhead / leftmost clicks do not update Cubase's Info Line and were
  jumping the chain (INTRO) so MIDI Next stopped. Unmatched Info Line names are not
  written; Tesseract is skipped when the name does not match.
- MIDI Next always steps from the **walk** Program Change, after delayed click PCs go quiet.
- If rewind sends no Program Change (first Arranger event has no ViewerOne PC), the scan
  probes Next instead of treating the leftover song as the start — that was stopping after
  INTRO when the leftover PC reappeared.
- `0:03:39.390` OCR'd as `010339.390` (colon read as 1) parses as 3:39, not 10:39.

## v5.12.75

- Arranger length click uses the **playhead on the Arranger track**, not the leftmost event.
  Clicking INTRO/Soundcheck while Cubase was on a later song jumped the chain and the scan
  stopped after 1–2 titles. Delayed click Program Changes are settled before MIDI Next.

## v5.12.74

- Length scan no longer treats an empty Info Line Name as a match. That was writing leftover
  INTRO time (`0:10:51` → `10:39`) onto songs such as Let me entertain you (actual Arranger
  length 3:39). Normal songs longer than 8 minutes are rejected; INTRO/OUTRO may still be long.

## v5.12.73

- Arranger length click targets the **Arranger track event** again (not a MIDI/audio song clip):
  locate “Arranger Track”, prefer the topmost timeline lane, and wait for Cubase to handle the
  click before restoring the cursor.
- Quit waits for PowerShell OCR, Tesseract, serialport, and MIDI to close before Electron exits,
  instead of `app.exit(0)` after 750ms (that was the “electron has stopped working” crash).

## v5.12.72

- Faster Arranger scan: skip Tesseract when Windows OCR already got a keepable length; drop
  per-song foreground padding and shrink click/Next settle waits that were not required for
  Cubase (Info Line still gets ~90ms after the timeline click). End-of-chain Next timeout
  1.8s → 1.0s.

## v5.12.71

- Arranger scan duration now sums **only songs the scan actually visited**. Leftover rows from a
  previous (longer) setlist kept as “not in arranger” no longer inflate Main/Total (this was the
  114-minute total on an 18-event set). Status, Duration line, and `last-arranger-scan.txt` report
  leftover time excluded, missing lengths, suspiciously long songs, and stale OCR.

## v5.12.50

- Cubase helpers always run via absolute `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`
  (`shell: false`). Never shell-open / Start-Process a `.ps1` (Windows → Notepad). Launch uses
  `node_modules/electron/dist/electron.exe .` only — never `npx` (can resolve to `npx.ps1` → Notepad).

## v5.12.49

- **Safer Cubase length pass** (different stack than the crashy path): no `SetWindowPos` thrash,
  no system `mouse_event`/`SendInput`. Prepare once per pass (soft restore; optional one
  `SW_MAXIMIZE` only if the window is tiny). Arranger selection via OCR-locate + **one
  `PostMessage` LBUTTON** to Cubase HWND with long settle delays. Capture is BitBlt/OCR only
  (no ShowWindow/SetForeground per song). Health check between songs aborts the length pass if
  Cubase is gone; prior lengths are never blanked on fail. Order pass unchanged.

## v5.12.47

- **Scan Arranger** restored as two automatic passes under one button: (1) order/PC walk,
  (2) rewind and walk again for Cubase Length OCR (`00:00` → `mm:ss`). Logs
  `length pass START` / `length pass END` — never silently skips. Removed the
  `skipLengthCapture` early-return that aborted all later songs after one Cubase prepare
  failure during the old inline-OCR walk.

## v5.12.46

- **Scan Arranger** can be run repeatedly: clear stuck `active` / in-flight promise, serialize
  Tesseract OCR (concurrent `recognize` hung subsequent scans), timeout PowerShell / WinRT OCR,
  flush stacked MIDI note-ons before rewind. Busy/error state always cleared in `finally`.
- Live length UX while scanning: each found song shows `00:00` immediately, then the Cubase
  `mm:ss` (or empty on OCR fail). Status confirms e.g. `Song K “Title”: length 3:39 from Cubase`
  or `… length not read (OCR failed)`. Setlist length column updates as the scan progresses.

## v5.12.45

- **Scan Arranger** is one operation: walks the Arranger chain for order (same duplicate-PC rules)
  and OCR-grabs Cubase Info Line Length after each song PC is established. Status shows
  `Scanning song K… grabbing length…`. Length failure on one song leaves that length empty and
  continues; completion reports how many lengths were filled. Removed the separate **Import
  lengths** toolbar button. **Grab Length** remains as a Detail-only helper for a single row.

## v5.12.44

- Cubase Length OCR: auto-position / resize the Cubase window before capture so Info Line +
  Arranger track stay on-screen.

## v5.12.43

- **Import lengths from Cubase** (setlist toolbar): walks Arranger like a scan and fills each
  song’s `length` from the Project Info Line via hybrid capture — Windows screenshot + label
  locate, then Tesseract digit OCR on Start/End/Length (UIA is blocked by Cubase’s custom UI).
  MIDI Next alone often leaves “No Object Selected”; import OCR-clicks the Arranger track event
  matching the setlist title when needed. Round to nearest second (`mm:ss`).
- **Grab Length**: one-shot read for the selected setlist row (same OCR path). Does not change
  Arranger scan/order. Cubase must be visible on screen; DPI/zoom can affect OCR accuracy.

## v5.12.42

- Arranger scan: completion message now reports numbered-song total before→after (CrowPanel
  `n`/`g` denominator) and flags new `Song PC …` placeholder rows that need title/length.
- Control UI: setlist heading shows `rows · numbered`; duration line relabeled so “Total” is
  clearly length-sum, not song count. Scan still persists full setlist + forces CrowPanel refresh.

## v5.12.41

- Arranger scan: ignore same-song Program Change re-chases when stepping Next/Prev. Cubase often
  re-fires the current PC on Arranger navigate; that was treated as a new step and could stop the
  scan with a false "already seen earlier" (e.g. "Dont look back") and leave later songs unvisited.

## v5.12.40

- CrowPanel / Esp32Preview: restore pad height after set-progress (spacing tightened instead of
  shrinking pads). Header contrast: brand/STOP `#9CA3AF`, version `#E5E7EB` full opacity, PLAY
  yellow-green `#B8FF26` (no `#6B7280` @ 70%).

## v5.12.39

- CrowPanel brand bar + desktop preview: compact **PLAY/STOP** transport (`tr` 0/1 in display
  JSON, change-only) with countdown **ARM/CD** hint; works even when MIDI clock is missing.
- Set progress under the pad-column clock (`g`, e.g. `12/30 · 41m`): song index/total (same
  rules as `n`) plus remaining set minutes from current onward (SOUNDCHECK excluded).
- Detail mode: **Diagnostics** section — MIDI port open/closed + names, last Cubase/mixer
  activity, ESP identity/fw, mute bridge map, transport playing + last source.

## v5.12.38

- Cubase ALL mute CC moved **84 → 88**: CC84 is X32 native Mute Group 5, so any CC84 that
  reached the mixer also muted MG5 when Cubase loaded. CC88 is outside MG range 80–85 and
  not used by synth/piano (86/87). Mixer ALL stays ch2 **CC80** (MG1); FX Cubase↔mixer **CC85**
  unchanged. Remap Cubase Generic Remote Group1 from CC84 → CC88 (Jump/Value).

## v5.12.37

- **Root cause (not a shared-path bug):** FX was bridged to **bus 16 CC63**, while the user
  presses **Mute Group 6** which TXes **CC85** (plus member bus CCs). VO→mixer sent CC63 so
  bus 16 changed but MG6 LED did not — looked like TX failure. Mixer→VO for FX only worked
  because engaging MG6 also emits member CC63=127.
- Map FX mixer CC **63 → 85** (Mute Group 6). ALL stays MG1 **CC80**.
- **Mute-group polarity ≠ bus polarity** (live X-USB): MG active → CC=0, off → CC=127; bus
  mute → 127/0. Flip mixer encode/decode for bridged MG1+MG6 to **0=muted** (fixes ALL
  inversion both ways). Cubase CC84/85 polarity unchanged.
- CrowPanel firmware version string only (mute serial already symmetric).

## v5.12.36

- FX and ALL VO↔mixer path are identical (shared `applyBridgedMute` / `BRIDGED_MUTES`): same
  polarity, same absolute TX, same origin flags. Only mixer CC (63 vs 80), Cubase CC (85 vs 84),
  and state keys differ.
- ViewerOne/ESP/preview mute toggles always `sendToMixer: true` with absolute value (no longer
  skip mixer TX when store already matches — that made FX look dead when store/X32 drifted).
- Boot-sync absolute FX/ALL mutes to the mixer whenever X-USB out opens (works with Cubase closed).
- CrowPanel FX pad now sends absolute `muted` like ALL (host SETs once; no host-side toggle).
- Mixer TX log: `group`, `CC`, `val`, `muted`.

## v5.12.35

- Broke ALL/MG1 mute flash loop: Cubase ALL mute CC moved **80 → 84** so it no longer shares a
  number with mixer mute group 1 (ch2/CC80). Same pattern as working FX (Cubase CC85 ≠ mixer CC63).
  Remap Cubase Generic Remote Group1 from CC80 → CC84 (Jump/Value). Echo ignore keys by
  source+CC (`cubase:84` vs `mixer:80`); bridged apply still TX only when state changes.

## v5.12.34

- FX and ALL mute now share one `applyBridgedMute` path / `BRIDGED_MUTES` table. Only Cubase CC,
  mixer CC, state key, and ESP group differ — same polarity, echo ignore, forward flags, boot sync,
  and absolute SET. Removed ALL-only special cases that drifted from FX.

## v5.12.33

- ALL / MG1 mute bridge now mirrors the working FX path 1:1 (absolute SET, same echo ignore,
  same mixer↔Cubase forward rules). Only CCs differ: Cubase CC80 ↔ X32 ch2/CC80 vs Cubase CC85
  ↔ X32 ch2/CC63. Removed the 5.12.32 ALL-only bridge lock / longer echo windows that caused
  every-other / double-press. If CC80 still needs two presses, set Cubase Generic Remote for
  CC80 to Jump/Value like CC85 (not Toggle).

## v5.12.32

- Fixed X32 Mute Group 1 (ALL) rapid flash: Cubase ch1/CC80 ↔ mixer ch2/CC80 feedback loop.
  Longer echo suppress on both ports, bridge lock against opposite values, TX only when
  `allMuted` changes, and clear ignore vs apply logs. Polarity unchanged vs FX boundary
  convert: Cubase 0=muted/127=live, X32 127=muted/0=unmuted (same as bus 16).

## v5.12.31

- Bridged X32 Mute Group 1 (ch2/CC80) ↔ ViewerOne ALL (`allMuted`) ↔ Cubase ch1/CC80, mirroring
  the existing FX path (mixer ch2/CC63 ↔ Cubase CC85). CrowPanel / Cubase ALL now also TX mute
  group 1 to the mixer when X-USB is open.

## v5.10.1

- Live status now shows Cubase transport **Playing/Stopped** plus the last Start/Stop source
  (`note` / `MMC` / `realtime`) so missing Generic Remote mapping is obvious on the simple view.
- Remaining-time line and CubaseToViewerOne mapping reminder (ch 16 note 60 Start / 61 Stop) sit
  under that indicator; wrong-channel transport notes are logged instead of silently dropped.

## v5.10.0

- ESP display payloads now include `d` for setlist duration / live remaining time. CrowPanel and
  CYD render `YYYY     MM:SS`, and the desktop hardware preview mirrors the same left-aligned line.
- Restored Cubase transport input using the rig's original channel 16 notes (60 Start, 61
  Stop/Pause), plus MIDI realtime Start/Continue/Stop and MMC Play/Stop compatibility.
- Added a one-second remaining-time countdown sourced from the selected song length. Stop freezes,
  Start resumes, a repeated song PC resets, and Start while already running resets. Cross-protocol
  duplicate transport messages from one Cubase action are collapsed.

## v5.9.0

- Added an editable **Song length** column immediately after Title. Durations accept `m:ss` /
  `mm:ss`, persist normalized as `mm:ss`, survive restarts, and are preserved by stable program
  when Arranger scans merge visited and unvisited songs.
- Added live Intro / Main Set / Outro / Total timing beside the setlist controls. Capitalized
  `INTRO` and `OUTRO` title prefixes select those sections; `SOUNDCHECK` is excluded; every other
  valid duration contributes to Main Set, including songs not visited by the latest scan.
- `SOUNDCHECK`, `INTRO`, and `OUTRO` rows are highlighted cyan for quick identification.
- Enlarged the simulated CrowPanel from 280px to a responsive 440px-wide 1024×600 preview and
  refined the stage-to-controls proportions, spacing, and four right pads (ALL, FX, PROMPT1,
  PROMPT2) while retaining the scrollable multi-row setlist below.

## v5.8.0

- Added configurable Cubase Arranger Prev/Next output on the existing `ViewerOneToCubase` port.
  Defaults are Note On pulses on channel 16: note 62 Prev and note 63 Next; Note/CC mode,
  channel, and numbers are editable in the MIDI panel.
- Added **Scan Arranger** with progress and cancel. It collects the normal incoming song PCs,
  retries unchanged steps, detects end/wrap, returns to the starting song, and saves the scanned
  order. No new inbound protocol is required (`CubaseToViewerOne` remains the song input).
- Scanned order persists in `electron-store` across restarts and is only replaced by a later scan
  or normal explicit setlist edits. Existing IDs, titles, years, and custom LED patterns are
  merged by stable song PC.
- Setlist rows now show both Arranger position (`#`) and Cubase song program (`PC`). Dragging
  changes saved order without renumbering stable Cubase programs.

## v5.7.1

- CrowPanel right column now has four double-height items: pressable ALL/FX mute controls and
  non-clickable PROMPT 1/PROMPT 2 status indicators.
- Reserved absolute prompt PCs: 120/121 = PROMPT 1 on/off; 122/123 = PROMPT 2 on/off. ViewerOne
  updates its preview and sends `{"prompt":N,"on":true|false}` over serial, including reconnect
  resynchronization. Song PCs are now limited to 1–119.
- Added PROMPT PC simulate controls alongside the existing LED PC 125/126/127 controls.
- CrowPanel firmware v5.7.5 parses prompt JSON and spaces the year about half a zoomed title
  line below the rendered song title. CYD firmware remains unchanged and ignores prompt JSON.
- Firmware v5.7.6 and desktop state keep Group1/ALL independent from Group6/FX. Active FX uses
  the stage navy-blue fill; PROMPT 1 uses bright pink and PROMPT 2 bright yellow, on device and
  in the simulated CrowPanel preview.

## v5.7.0

- **CrowPanel Advanced 7″ ESP32-P4 firmware** (`firmware/crowpanel-7-p4`): 1024×600 LVGL HMI
  with song stage + 8 mute pads (ALL / FX / placeholders). Uses pioarduino for ESP32-P4
  Arduino; EK79007 MIPI-DSI + GT911. CYD 2.8″ display/LED behavior remains compatible.
- Serial protocol accepts legacy `{"evt":"mute_toggle"}` and CrowPanel grouped
  `{"evt":"mute_toggle","group":"fx"|"all"}`. Desktop maps `all` to FX mute for now.
- Firmware boot/hello identity (`device`, `model`, `w`, `h`) switches Esp32Preview automatically
  between the CYD 320×240 UI and CrowPanel 1024×600 wide stage + pad column.
- Optional LED strip env `crowpanel-7-p4-led` (FastLED on a free GPIO; default build stubs LEDs).

## v5.6.6

- **PC 125 = Blackout:** reserved Cubase-style Program Change 125 (wire 124) applies LED
  pattern id 99 (`blackout`) immediately — same push path as preview/apply; updates
  `ledPattern` / preview footer. Handled before setlist lookup (like PC 126/127).
- Song select capped at **PC 1–124** (`MIDI_PC_SONG_MAX`); PC 126 idle and PC 127 apply unchanged.
- Control UI: **PC 125 · Blackout** simulate button (flashes on real/simulated receipt);
  MIDI / ESP settings hints updated.

## v5.6.5

- **99 - Blackout:** new LED pattern id 99 (`blackout`) — all LEDs solid off. Available in
  setlist / test-pattern dropdowns; clamp/push accept 0–20 and 99. Random rotator (20) still
  cycles 1→19 only — blackout is manual/special.
- **ESP32 auto footer:** in random mode the TFT shows `(A) - <child title>` (e.g.
  `(A) - Starfield`) at text size 2; long labels truncate instead of falling back to size 1.
  Non-random patterns keep `NN - Name` at size 2 with the same truncate rule.

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
