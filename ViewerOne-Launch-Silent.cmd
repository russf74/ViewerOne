@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "LOG=%TEMP%\viewerone-launch.log"
>>"%LOG%" echo %DATE% %TIME% local launch %CD%

REM Shortcuts often have a stripped PATH. Put Node.js (and Git) on it.
if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"

REM GitHub is backup only. Fast-forward if this folder is a clone and origin is ahead.
REM Never reset --hard (that was wiping local and fighting the shortcut).
where git >nul 2>nul && (
  git pull --ff-only origin main >>"%LOG%" 2>&1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  >>"%LOG%" echo ERROR: npm not found
  exit /b 1
)

if not exist "node_modules" call npm.cmd install --no-fund --no-audit >>"%LOG%" 2>&1

call npm.cmd run build >>"%LOG%" 2>&1
if errorlevel 1 (
  >>"%LOG%" echo ERROR: build failed
  exit /b 3
)

if not exist "node_modules\electron\dist\electron.exe" (
  >>"%LOG%" echo ERROR: electron.exe missing
  exit /b 4
)

start "" "%CD%\node_modules\electron\dist\electron.exe" .
>>"%LOG%" echo Started OK
exit /b 0
