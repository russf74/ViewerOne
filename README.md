# ViewerOne

Live setlist display + MIDI control for Cubase, with optional ESP displays: classic CYD 2.8″ (ILI9341) and **CrowPanel Advanced 7″ ESP32-P4** (1024×600), plus WS2812B LED strip on the CYD.

**GitHub:** https://github.com/russf74/ViewerOne

## If I lose everything (cold-start index)

| What | Where |
|------|--------|
| This app + CYD + CrowPanel firmware | https://github.com/russf74/ViewerOne |
| Earlier ESP32-S3 LED experiments / USB scripts | https://github.com/russf74/LED-Driver |
| Setlist + app settings backup (in-repo) | [`backup/viewer-one-config.json`](backup/viewer-one-config.json) |
| Board MAC table + identify steps | [`firmware/esp32-display/HARDWARE.md`](firmware/esp32-display/HARDWARE.md) |

| Piece | Location |
|-------|----------|
| Windows Electron app | this repo root (`npm run launch` / `npm run dist`) |
| ESP32 CYD firmware + LED (production) | [`firmware/esp32-display`](firmware/esp32-display/) |
| CrowPanel 7″ ESP32-P4 HMI firmware | [`firmware/crowpanel-7-p4`](firmware/crowpanel-7-p4/) |
| Board MAC inventory (CYD) | [`firmware/esp32-display/HARDWARE.md`](firmware/esp32-display/HARDWARE.md) |
| Standalone S3 LED lab (older) | [russf74/LED-Driver](https://github.com/russf74/LED-Driver) |

---

## Disaster recovery — rebuild from scratch

If this PC (or the ESP32 boards) are lost, restore from GitHub alone. Setlist and most app toggles are snapshotted in [`backup/viewer-one-config.json`](backup/viewer-one-config.json).

### 1. Prerequisites (new Windows PC)

- **Git**
- **Node.js** (LTS, 18+ recommended) and npm
- **Python 3** + [PlatformIO Core](https://platformio.org/install/cli) (`pip install platformio` or `python -m pip install platformio`)
- **USB serial driver** for the CYD (usually CH340)
- Optional for Cubase: [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html)
- Optional: external **5V** PSU for the LED strip (do not power LEDs from USB/3V3)

### 2. Clone and run the desktop app

```powershell
git clone https://github.com/russf74/ViewerOne.git
cd ViewerOne
npm install
npm run launch
```

- Dev/build only: `npm run build`
- Installer / portable Windows build: `npm run dist` (output under `release/`)
- Refresh Desktop shortcut: `npm run install-shortcut`
- Shortcut scripts (after clone): `ViewerOne-Launch.cmd` / `ViewerOne-Launch.vbs`

### 3. Restore setlist / app config

After the first launch (so `%APPDATA%\viewer-one\` exists), copy the in-repo backup over the live store file, then restart ViewerOne:

```powershell
Copy-Item -Force .\backup\viewer-one-config.json "$env:APPDATA\viewer-one\viewer-one-config.json"
```

That restores setlist, MIDI port names, LED brightness / power flags, and mute/transport CC settings. Re-check loopMIDI cable names if they differ on the new PC.

To refresh the GitHub backup after you change the live setlist:

```powershell
Copy-Item -Force "$env:APPDATA\viewer-one\viewer-one-config.json" .\backup\viewer-one-config.json
git add backup/viewer-one-config.json
git commit -m "Update viewer-one config backup."
git push
```

### 4. Flash ESP display firmware

Close ViewerOne USB serial (or disable “Enable USB serial”) so the COM port is free.

**CYD 2.8″** — env **`esp32-diy8-ili9341`**:

```powershell
cd firmware\esp32-display
python -m platformio run -e esp32-diy8-ili9341 -t upload --upload-port COMx
```

**CrowPanel Advanced 7″ ESP32-P4** — env **`crowpanel-7-p4`** (needs [pioarduino](https://github.com/pioarduino/platform-espressif32); see project README):

```powershell
cd firmware\crowpanel-7-p4
python -m platformio run -e crowpanel-7-p4 -t upload --upload-port COMx
```

Replace `COMx` with the board’s port (Device Manager). Details: [`firmware/esp32-display/README.md`](firmware/esp32-display/README.md) · [`firmware/crowpanel-7-p4/README.md`](firmware/crowpanel-7-p4/README.md).

Both firmwares announce `device`, `model`, `w`, and `h` in boot JSON and answer `{"cmd":"hello"}`.
The Windows app requests that identity whenever serial opens and switches its simulated display automatically.
Unknown, older, disconnected, and disabled devices use the CYD preview as a clearly labelled fallback.

Identify Main vs Backup by MAC: [`firmware/esp32-display/HARDWARE.md`](firmware/esp32-display/HARDWARE.md).

| Role   | MAC               |
|--------|-------------------|
| Main   | `80:f3:da:bb:a3:14` |
| Backup | `80:f3:da:bb:8d:54` |

### 5. LED wiring (CN1)

| Strip | CYD |
|-------|-----|
| DIN   | **GPIO 27** (CN1) — not GPIO 2 (TFT DC) |
| GND   | CN1 GND **and** external PSU GND (common ground) |
| +5V   | **External 5V only** |

Default LED count is in `firmware/esp32-display/src/led_config.h` (`NUM_LEDS`).

### 6. loopMIDI (Cubase)

Create two virtual cables whose names include both Cubase and ViewerOne (order matters for auto-detect):

- **Cubase → ViewerOne:** e.g. `CubaseToViewerOne` (Cubase track **Output** = this port)
- **ViewerOne → Cubase:** e.g. `ViewerOneToCubase`

Program Change / mute CC conventions are fixed in `src/shared/midiConfig.ts` (no per-machine secrets).
Song select uses Cubase-style PC **1–119**; PCs 120–123 are prompt indicators, and reserved
**PC 125** = LED blackout, **PC 126** = idle dim knight rider, **PC 127** = apply current song pattern.

Cubase transport uses the original Generic Remote mapping on **channel 16**: **note 60 = Start**
and **note 61 = Stop/Pause**. ViewerOne also accepts MIDI realtime Start/Continue/Stop and MMC
Play/Stop. A song PC loads its setlist length at full time and waits. Start runs/resumes the
countdown, Stop freezes it, a repeated PC resets the same song, and Start received while already
running resets to full length. The ESP receives at most one updated `MM:SS` display payload per
second.

#### Cubase Arranger controls and scan

ViewerOne sends Arranger Prev/Next through the existing **`ViewerOneToCubase`** output. Defaults:

- Message: **Note On pulse**
- Channel: **16**
- **Prev: note 62**
- **Next: note 63**

The message type (Note On or CC), channel, and Prev/Next note/CC numbers are configurable in
ViewerOne's MIDI panel. In Cubase, map these messages to the same Arranger previous/next commands
already used by the USB keyboard.

**Scan Arranger** snapshots the current song, steps forward while Cubase sends its normal song
Program Changes, detects the end/wrap, and steps back to the starting song. Song identity still
comes into ViewerOne through the existing **`CubaseToViewerOne`** input; scanning does not add a
new inbound MIDI protocol.

The scanned order is saved immediately by `electron-store` and loaded unchanged after app or PC
restart. A later scan replaces the order. Each row shows both its saved Arranger position (`#`)
and its stable Cubase song Program Change (`PC`); existing title, year, and LED pattern are merged
by PC so custom LED choices survive rescans.

### 7. After restore — app checklist

1. Start loopMIDI (cables above).
2. Restore config (step 3) if you have not already.
3. Plug ESP32; in ViewerOne enable USB serial if needed.
4. Confirm mute path: Cubase / mixer / ESP touch as you use them live.

---

## What is not in git (still local / regenerable)

| Item | Where |
|------|--------|
| Live setlist store (working copy) | `%APPDATA%\viewer-one\viewer-one-config.json` — snapshot in [`backup/`](backup/) |
| `node_modules/`, `out/`, `release/` | regenerated by `npm install` / `npm run launch` / `npm run dist` |
| PlatformIO build cache | `firmware/esp32-display/.pio/` |
| Secrets / API keys | none required for normal operation |
| Cubase project / mixer scene | outside this repo |

---

## Repo layout (quick)

```
ViewerOne/
  src/                    Electron main + renderer
  firmware/esp32-display/ CYD firmware + HARDWARE.md
  backup/                 Disaster-recovery config snapshot
  package.json            App scripts and version
  CHANGELOG.md
```
