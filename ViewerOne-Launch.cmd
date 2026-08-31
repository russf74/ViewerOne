@echo off
REM Visible launcher. Desktop/taskbar shortcuts use ViewerOne-Launch.vbs.
cd /d "%~dp0"
where npm >nul 2>nul || (
  echo ViewerOne: Node.js/npm not found in PATH. Install Node.js LTS.
  pause
  exit /b 1
)
call npm run launch
if errorlevel 1 (
  echo.
  echo ViewerOne: launch failed.
  pause
  exit /b 1
)
