@echo off
REM Dev launcher with visible log. For normal use, double-click ViewerOne-Launch.vbs instead.
cd /d "%~dp0"
where npm >nul 2>nul || (
  echo ViewerOne: Node.js/npm not found in PATH. Install Node.js LTS.
  pause
  exit /b 1
)
git pull --ff-only origin main 2>nul
call npm run launch
if errorlevel 1 (
  echo.
  echo ViewerOne: launch failed.
  pause
  exit /b 1
)
