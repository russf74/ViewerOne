@echo off
REM Copy this gig rig onto the USB hard drive.
setlocal
set "SCRIPT=%~dp0GigBackup.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0GigBackup\GigBackup.ps1"
if not exist "%SCRIPT%" (
  echo Could not find GigBackup.ps1 next to this file or in GigBackup\
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode Copy %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo COPY FAILED. Scroll up for the error. Most files may still be on the drive.
) else (
  echo COPY FINISHED. You can close this window.
)
echo.
pause
exit /b %RC%
