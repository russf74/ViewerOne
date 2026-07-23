# ViewerOne CYD ESP32 hardware inventory

Boards used with this firmware (ESP32-2432S028R / Cheap Yellow Display, USB-SERIAL CH340).

| Role   | MAC               | Notes |
|--------|-------------------|-------|
| Main   | 80:f3:da:bb:a3:14 | Confirmed on COM8 via `esptool read_mac` (2026-07-23). Chip ESP32-D0WD-V3 rev v3.1. |
| Backup | 80:f3:da:bb:8d:54 | Flashed as spare; not the board currently plugged in. |

## Identify a board

With ViewerOne USB serial **off** (port free):

```powershell
python -m esptool --port COMx read_mac
```

If `esptool` is only available via PlatformIO’s package:

```powershell
python "$env:USERPROFILE\.platformio\packages\tool-esptoolpy\esptool.py" --port COMx read_mac
```

Use the printed MAC against the table above to choose Main vs Backup.

## Wiring reminder

- LED data: **GPIO 27** (CN1)
- LED power: external **5V**; common **GND** with the CYD
- Flash env: `esp32-diy8-ili9341` — see [README.md](README.md)
