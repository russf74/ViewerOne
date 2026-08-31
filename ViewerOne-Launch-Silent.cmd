@echo off
setlocal
cd /d "%~dp0"

set "LOG=%TEMP%\viewerone-launch.log"
echo %DATE% %TIME% Launch %CD%>"%LOG%"

REM Taskbar/desktop shortcuts often miss the user PATH - add Node.js explicitly
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm not found>>"%LOG%"
  exit /b 1
)

echo Building...>>"%LOG%"
call npm run build >>"%LOG%" 2>&1
if errorlevel 1 (
  echo ERROR: npm run build failed>>"%LOG%"
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo ERROR: electron.exe missing>>"%LOG%"
  exit /b 1
)

start "" "%~dp0node_modules\electron\dist\electron.exe" .
echo Started OK>>"%LOG%"
exit /b 0
