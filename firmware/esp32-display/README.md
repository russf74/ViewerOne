# ViewerOne ESP32 display (ILI9341)

Firmware for the ESP32-2432S028R-style board: USB serial at **115200**, JSON lines: `{"t":"Title","c":"Chords","l":true}`.

## Deploy from Windows (PowerShell)

From the repo, use this project directory:

`C:\Users\pc\ViewerOne\firmware\esp32-display`

**Upload (PlatformIO via your Python install)** — replace `COM4` with your port (`pio device list` if needed):

```powershell
Set-Location C:\Users\pc\ViewerOne\firmware\esp32-display
& "C:\Users\pc\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m platformio run -e esp32-diy8-ili9341 -t upload --upload-port COM4
```

If `pio` is on your `PATH`, you can use:

```powershell
Set-Location C:\Users\pc\ViewerOne\firmware\esp32-display
pio run -e esp32-diy8-ili9341 -t upload --upload-port COM4
```

**Serial monitor** (115200):

```powershell
& "C:\Users\pc\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m platformio device monitor -b 115200 -p COM4
```

## Build variants

Defined in `platformio.ini`:

| Environment | Use |
|-------------|-----|
| `esp32-diy8-ili9341` | Default (40 MHz SPI) |
| `esp32-diy8-ili9341-slow` | 20 MHz SPI if the panel is unstable |
| `esp32-diy8-ili9341-inv` | Inverted panel colors |

## Version

Firmware reports `VIEWERONE_FW_VERSION` in `src/main.cpp`. When you release a new **ViewerOne** desktop version, bump **both** `package.json` at the repo root and `VIEWERONE_FW_VERSION` so they stay aligned.
