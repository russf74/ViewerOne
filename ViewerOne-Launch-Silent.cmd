@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\launch-viewerone.ps1" -RepoRoot "%~dp0"
exit /b %ERRORLEVEL%
