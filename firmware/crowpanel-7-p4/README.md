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
python -m platformio run -e crowpanel-7-p4 -t upload --upload-port COMx
python -m platformio device monitor -e crowpanel-7-p4 --port COMx
```

First build downloads the pioarduino platform and libs (several minutes).

Hold **BOOT**, tap **RESET**, release **BOOT** if upload fails to enter download mode.

## UI

- **Left (~75%)**: song title + year, mute colours (muted = yellow on navy, live = lime on black), LED pattern footer, polished idle “Waiting for signal”.
- **Right**: 8 square mute pads — **ALL** (Group1), **FX** (Group6, same as CYD touch mute), **G2–G5 / —** placeholders.

## Serial protocol (compatible with ViewerOne desktop)

PC → ESP (unchanged):

```json
{"t":"Title","c":"1999","l":true,"m":false}
{"cmd":"hello"}
```

ESP → PC:

```json
{"evt":"mute_toggle"}
{"evt":"mute_toggle","group":"fx"}
{"evt":"mute_toggle","group":"all"}
{"evt":"boot","device":"crowpanel7","model":"Elecrow CrowPanel Advanced 7","w":1024,"h":600,"fw":"5.7.0",...}
{"evt":"hello","device":"crowpanel7","model":"Elecrow CrowPanel Advanced 7","w":1024,"h":600,"fw":"5.7.0",...}
```

Each pad press emits one event. FX/ALL include `group`; the desktop accepts grouped and legacy ungrouped
`mute_toggle` events. ViewerOne requests `hello` whenever the serial port opens, so identity detection does not
depend on catching the boot line.

## Optional WS2812 LEDs

Default build **stubs** LED strip control (`led` JSON replies `led_disabled`). Pattern footer still shows the last known / default label.

To enable FastLED on a free header GPIO (default **GPIO20** — confirm your wiring):

```powershell
python -m platformio run -e crowpanel-7-p4-led -t upload --upload-port COMx
```

Override pin: build flag `-D PIN_LED_DATA=nn`. FastLED/RMT on ESP32-P4 is experimental; prefer validating on hardware before a gig.

## Version

Firmware reports `VIEWERONE_FW_VERSION` in `src/main.cpp` (**5.7.0**).
