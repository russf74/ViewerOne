@echo off
REM One-click repair: sync from GitHub, install, build, fix shortcuts, start ViewerOne.
REM Double-click this if the desktop/taskbar shortcut shows a VBScript or launch error.
setlocal EnableExtensions
cd /d "%~dp0"
title ViewerOne repair
echo Repairing ViewerOne. This window closes when the app starts.
echo.

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\fix-viewerone.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo Repair failed. Log: %TEMP%\viewerone-fix.log
  pause
  exit /b %ERR%
)
exit /b 0
