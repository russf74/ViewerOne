@echo off
REM One-time fix if ViewerOne opens the wrong version. Double-click this file.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\fix-viewerone.ps1"
pause
