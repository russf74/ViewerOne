# ViewerOne — CrowPanel Advanced 7″ (ESP32-P4)

Firmware for the **ELECROW CrowPanel Advanced 7inch ESP32-P4 HMI** (1024×600 IPS, GT911 touch, Wi‑Fi via onboard ESP32‑C6).

The classic **CYD 2.8″** firmware is unchanged at [`../esp32-display`](../esp32-display/).

## Hardware

| Item | Detail |
|------|--------|
| SoC | ESP32-P4NRW32 (16 MB flash, 32 MB PSRAM) |
| Panel | EK79007 MIPI-DSI, **1024×600**, RGB565 |
| Touch | GT911 I²C — SCL **46**, SDA **45**, INT **42**, RST **40** |
| Backlight | PWM EN **GPIO31**; panel power **GPIO29** (`LCD_BK_POWER`) |
| LCD reset | **GPIO41** |
| Serial | USB‑UART (CH341) **UART0 @ 115200** — same JSON protocol as CYD |
| Power | Screen draw can need **8–10 W**. Use USB‑C data **and** the board’s USB 2.0 / 5 V supply so the panel does not brown out. |

Official docs: [Elecrow wiki](https://www.elecrow.com/wiki/CrowPanel_Advanced_7inch_ESP32-P4_HMI_AI_Display_1024x600_IPS_Touch_Screen_with_WiFi6_Compatible_with_ArduinoLVGL.html) · [GitHub examples](https://github.com/Elecrow-RD/CrowPanel-Advanced-7inch-ESP32-P4-HMI-AI-Display-1024x600-IPS-Touch-Screen)

## PlatformIO / ESP32-P4

Stock PlatformIO `espressif32` **does not** ship Arduino for ESP32-P4. This project uses **[pioarduino/platform-espressif32](https://github.com/pioarduino/platform-espressif32)** (`stable` zip in `platformio.ini`).

Libraries (Arduino path matching Elecrow Lesson07):

- `ESP32_Display_Panel` + `esp-lib-utils` + `ESP32_IO_Expander`
- LVGL **8.3.x** (Elecrow Arduino lessons; not LVGL 9)
- ArduinoJson 7

Board env uses `esp32-p4-evboard` (16 MB flash) with PSRAM enabled.

## Flash (Windows PowerShell)

```powershell
Set-Location <path-to-ViewerOne>\firmware\crowpanel-7-p4
$env:PYTHONUTF8 = "1"
python -m platformio run -e crowpanel-7-p4
python -m platformio run -e crowpanel-7-p4 -t upload --upload-port COMx
python -m platformio device monitor -e crowpanel-7-p4 --port COMx
```

The first build downloads and unpacks the pioarduino platform, Arduino core, P4 RISC-V
toolchain, and libraries. On Windows this can take 10–20 minutes and may sit on an
`Installing ...` line while another package is unpacked. Let one build finish; do not
start concurrent PlatformIO builds because they share `%USERPROFILE%\.platformio` and
can wait on the same package/cache locks.

The configuration was verified with pioarduino platform `55.3.311`, Arduino-ESP32
`3.3.11`, board `esp32-p4-evboard`, and PlatformIO Core `6.1.19` or newer. Stock
PlatformIO `espressif32` still does not provide this Arduino ESP32-P4 toolchain.

If a first install stops making progress:

```powershell
# Stop any other PlatformIO build first, then retry with verbose package progress.
$env:PYTHONUTF8 = "1"
python -m platformio run -e crowpanel-7-p4 -v

# If an interrupted download left a corrupt cache, preview and then clear cache only.
python -m platformio system prune --cache --dry-run
python -m platformio system prune --cache -f
python -m platformio run -e crowpanel-7-p4
```

Do not delete the whole global `.platformio` directory as a first step; that forces the
large P4 toolchain to download again. To reset only this project's build and libraries,
remove `firmware\crowpanel-7-p4\.pio` and rerun the build. `$env:PYTHONUTF8 = "1"`
also prevents Windows code-page errors in PlatformIO package/size output.

Hold **BOOT**, tap **RESET**, release **BOOT** if upload fails to enter download mode.

## UI

- **Left (~75%)**: song title + `YYYY     MM:SS` (full length or live remaining time), mute colours (muted = yellow on navy, live = lime on black), LED pattern footer, polished idle “Waiting for signal”.
- **Right**: four pressable pads — **ALL** (Group1), **FX** (Group6 / main-stage), **SYNTH** (Cubase mixer ch1), **PIANO** (Cubase mixer ch2).
- Synth/Piano: filled green = live/unmuted, filled dark grey = muted. Serial `mute_toggle` includes absolute `muted` so the host SETs once (no double-toggle). Host sends Cubase CC 86 / 87 on ch 1 inverted vs FX (127=muted, 0=unmuted) for Jump/Value Generic Remote.
- ALL (Group1): same absolute serial `muted` pattern; host sends Cubase **CC 88** on ch 1 with FX polarity (0=muted, 127=live). Map Jump/Value Generic Remote to Cubase Group 1 Mute (CC88 outside X32 MG 80–85; ≠ mixer MG1 CC80; not 86/87).
- Legacy prompt PCs 120–123 remain accepted by the host for Detail tests but no longer drive CrowPanel pads.
- Mute feedback is optimistic: touch-down flips local pad style and sends serial immediately. Under **180° software rotation**, pad handlers must not call `lv_refr_now()` (full-frame rotate_copy + vsync would lag the next touch).

## Serial protocol (compatible with ViewerOne desktop)

PC → ESP:

```json
{"t":"Title","c":"1999","d":"04:32","l":true,"m":false,"a":false,"s":false,"i":false}
{"cmd":"hello"}
```

ESP → PC:

```json
{"evt":"mute_toggle"}
{"evt":"mute_toggle","group":"fx","muted":true}
{"evt":"mute_toggle","group":"all","muted":true}
{"evt":"mute_toggle","group":"synth","muted":true}
{"evt":"mute_toggle","group":"piano","muted":false}
{"evt":"boot","device":"crowpanel7","model":"Elecrow CrowPanel Advanced 7","w":1024,"h":600,"fw":"5.10.0",...}
{"evt":"hello","device":"crowpanel7","model":"Elecrow CrowPanel Advanced 7","w":1024,"h":600,"fw":"5.10.0",...}
```

Each pad press emits one event. FX/ALL/Synth/Piano include `group` and absolute `muted`.
The desktop accepts grouped and legacy ungrouped `mute_toggle` events. ViewerOne requests `hello`
whenever the serial port opens, so identity detection does not depend on catching the boot line.

## Optional WS2812 LEDs

Default `crowpanel-7-p4` build **stubs** LED strip control (`led` JSON replies `led_disabled`). Pattern footer still shows the last known / default label.

The `crowpanel-7-p4-led` environment uses **UART1 TX1 (GPIO47)** on the expansion header for the data signal. This pin is configured as ordinary GPIO output by FastLED; RX1 and 3V3 are unused. Flash the LED-enabled environment:

```powershell
$env:PYTHONUTF8 = "1"
python -m platformio run -j 1 -e crowpanel-7-p4-led -t upload --upload-port COMx
```

Wire **TX1 → 3.3 V-to-5 V level shifter → strip DIN**, and join the strip, PSU, and CrowPanel grounds. Power the strip from a suitably sized external 5 V supply; **do not parallel the external PSU's 5 V rail with USB 5 V**. RX1 and the header's 3V3 pin are not used. To use different wiring, override the pin with build flag `-D PIN_LED_DATA=nn`. FastLED/RMT on ESP32-P4 is experimental; validate on hardware before a gig.

## Version

Firmware reports `VIEWERONE_FW_VERSION` in `src/main.cpp` (**5.7.6**).
