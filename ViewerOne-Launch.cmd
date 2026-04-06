@echo off
REM Dev launcher with visible log. For a normal double-click (no console), use ViewerOne-Launch.vbs instead.
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
