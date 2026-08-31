@echo off
REM Visible launcher (console). Desktop/taskbar shortcuts use ViewerOne-Launch.vbs.
setlocal EnableExtensions
cd /d "%~dp0"
call "%~dp0ViewerOne-Launch-Silent.cmd"
if errorlevel 1 (
  echo.
  echo ViewerOne: launch failed. Log: %TEMP%\viewerone-launch.log
  pause
  exit /b 1
)
