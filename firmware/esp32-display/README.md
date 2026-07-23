# ViewerOne ESP32 display + LED (ILI9341 CYD)

Firmware for the ESP32-2432S028R-style board (**Cheap Yellow Display**):

- USB serial at **115200**
- Display JSON: `{"t":"Title","c":"1999","l":true,"m":false}` (unchanged)
- LED JSON: `{"led":"pattern","id":0}` etc. (WS2812B)

Board MACs (Main / Backup): see [`HARDWARE.md`](HARDWARE.md).  
Full PC rebuild (app + flash + MIDI): see the root [`README.md`](../../README.md) **Disaster recovery** section.

## LED wiring (CN1 header)

| Strip | CYD |
|-------|-----|
| DIN | **GPIO 27** (CN1) |
| GND | CN1 GND **and** external PSU GND |
| +5V | **External 5V PSU only** (not USB / not 3V3) |

Do **not** use GPIO 2 — that is TFT DC on this board.

Default: **144** LEDs, Knight Rider on boot. Change `NUM_LEDS` in `src/led_config.h` (e.g. 576 for four strips).

## Deploy from Windows (PowerShell)

Prerequisites: Python 3 + PlatformIO (`python -m pip install platformio`). Close ViewerOne USB serial so the port is free.

```powershell
Set-Location <path-to-ViewerOne>\firmware\esp32-display
python -m platformio run -e esp32-diy8-ili9341 -t upload --upload-port COMx
```

Replace `COMx` with the board’s COM port. Default env: **`esp32-diy8-ili9341`**.

Identify Main vs Backup:

```powershell
python -m esptool --port COMx read_mac
```

(or `python <path-to-esptool.py> --port COMx read_mac` — see [`HARDWARE.md`](HARDWARE.md)).

## LED commands (one JSON line each)

```text
{"led":"pattern","id":0}
{"led":"pattern","name":"fire"}
{"led":"brightness","v":96}
{"led":"off"}
{"led":"status"}
```

Patterns 0–20 (TFT footer matches UI labels, e.g. `01 - Aurora`; JSON `name` stays underscored):

0 knight_rider (boot/waiting), 1 aurora, 2 dual_comet, 3 ocean, 4 lava,
5 starfield, 6 cyber_rain, 7 rainbow_ripple, 8 neon_pulse, 9 galaxy, 10 strobe_wave,
11 disco_ball, 12 laser_sweep, 13 bass_pulse, 14 confetti_storm, 15 hyper_chase,
16 prism_spin, 17 spark_shower, 18 color_bomb, 19 roller_derby,
20 random (sequential rotate through 1..19 every ~10s; footer shows current child).
All patterns mirror at the strip midpoint.

Replies look like `{"evt":"led",...}` — ViewerOne desktop ignores these (only handles `mute_toggle` / `boot`).

## Optional standalone LED CLI

A separate local **LED-Driver** repo (not required for ViewerOne rebuild) can send LED commands when ViewerOne USB serial is off. Prefer flashing and controlling LEDs through ViewerOne for the gig setup.

## Build variants

| Environment | Use |
|-------------|-----|
| `esp32-diy8-ili9341` | Default (40 MHz SPI) |
| `esp32-diy8-ili9341-slow` | 20 MHz SPI |
| `esp32-diy8-ili9341-inv` | Inverted panel colors |
| `esp32-diy8-ili9341-notouch` | Touch disabled |

## Version

Firmware reports `VIEWERONE_FW_VERSION` in `src/main.cpp` (**5.6.1** = TFT footer matches ViewerOne labels, e.g. `01 - Aurora`; JSON `name` stays underscored).
