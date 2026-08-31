@echo off
setlocal
cd /d "%~dp0"

set "LOG=%TEMP%\viewerone-launch.log"
echo %DATE% %TIME% Launch %CD%>>"%LOG%"

REM Node.js + Git (shortcuts often miss user PATH)
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"

REM Auto-sync latest from GitHub (silent, ok if offline)
where git >nul 2>nul && (
  git remote set-url origin https://github.com/russf74/ViewerOne.git 2>nul
  git fetch origin main 2>>"%LOG%"
  git reset --hard origin/main 2>>"%LOG%"
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm not found>>"%LOG%"
  exit /b 1
)

if not exist "node_modules" call npm install --no-fund --no-audit >>"%LOG%" 2>&1

call npm run build >>"%LOG%" 2>&1
if errorlevel 1 (
  echo ERROR: build failed>>"%LOG%"
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo ERROR: electron missing>>"%LOG%"
  exit /b 1
)

start "" "%~dp0node_modules\electron\dist\electron.exe" .
echo Started OK>>"%LOG%"
exit /b 0
