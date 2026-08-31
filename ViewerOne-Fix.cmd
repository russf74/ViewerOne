@echo off
title ViewerOne Fix
cd /d "%~dp0"
echo.
echo ViewerOne fix — syncing v6, building, opening...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\fix-viewerone.ps1" -RepoRoot "%~dp0"
echo.
pause
