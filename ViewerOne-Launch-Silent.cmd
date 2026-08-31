@echo off
setlocal
REM %1 = repo folder. When omitted, assume this .cmd lives in the repo.
set "REPO=%~1"
if "%REPO%"=="" set "REPO=%~dp0"
cd /d "%REPO%"

set "LOG=%TEMP%\viewerone-launch.log"
echo %DATE% %TIME% Launch %CD%>>"%LOG%"

REM Node.js + Git (shortcuts often miss user PATH)
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"

REM Close running ViewerOne so git can replace files (taskbar pin is often electron.exe)
if exist "%REPO%\scripts\stop-viewerone.vbs" cscript //nologo "%REPO%\scripts\stop-viewerone.vbs" >>"%LOG%" 2>&1

REM Auto-sync latest from GitHub (silent, ok if offline)
where git >nul 2>nul && (
  git remote set-url origin https://github.com/russf74/ViewerOne.git 2>nul
  git fetch origin main 2>>"%LOG%"
  git checkout main 2>>"%LOG%"
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

where node >nul 2>nul && node -p "require('./package.json').version" >>"%LOG%" 2>&1
git log -1 --oneline >>"%LOG%" 2>&1

if exist "%REPO%\scripts\repair-shortcuts.vbs" cscript //nologo "%REPO%\scripts\repair-shortcuts.vbs" "%REPO%" >>"%LOG%" 2>&1

REM After a launcher sync, skip a second git check inside Electron
set "VIEWERONE_SKIP_SYNC=1"
start "" "%REPO%\node_modules\electron\dist\electron.exe" .
echo Started OK>>"%LOG%"
exit /b 0
