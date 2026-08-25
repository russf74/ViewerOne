@echo off
REM Run this FROM the USB drive on the backup PC.
setlocal
set "SCRIPT=%~dp0GigBackup.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0GigBackup\GigBackup.ps1"
if not exist "%SCRIPT%" (
  echo Could not find GigBackup.ps1 next to this file or in GigBackup\
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode Apply %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo APPLY FAILED. Scroll up for the error.
) else (
  echo APPLY FINISHED. You can close this window.
)
echo.
pause
exit /b %RC%
