@echo off
setlocal EnableExtensions
REM %1 = repo folder. When omitted, this .cmd lives in the repo.
set "REPO=%~1"
if "%REPO%"=="" set "REPO=%~dp0"
for %%I in ("%REPO%") do set "REPO=%%~fI"
cd /d "%REPO%"

set "LOG=%TEMP%\viewerone-launch.log"
echo %DATE% %TIME% BEGIN %REPO%>>"%LOG%"

title ViewerOne update
echo.
echo ========================================
echo   Updating ViewerOne to v6.00.05
echo   Keep this window open.
echo ========================================
echo.

REM Always tell you this ran, even if the shortcut hid the console.
> "%TEMP%\vo-upd.vbs" echo Set s = CreateObject("WScript.Shell")
>> "%TEMP%\vo-upd.vbs" echo s.Popup "Updating ViewerOne to v6.00.05. Wait — do not use the old app.", 6, "ViewerOne", 64
start "" wscript.exe "%TEMP%\vo-upd.vbs"

if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"

echo Closing old ViewerOne...
taskkill /F /IM ViewerOne.exe >>"%LOG%" 2>&1
taskkill /F /IM electron.exe >>"%LOG%" 2>&1
ping -n 4 127.0.0.1 >nul

echo Syncing from GitHub...
where git >nul 2>nul
if not errorlevel 1 (
  git remote set-url origin https://github.com/russf74/ViewerOne.git 2>nul
  git fetch origin main >>"%LOG%" 2>&1
  git checkout main >>"%LOG%" 2>&1
  git reset --hard origin/main >>"%LOG%" 2>&1
  git log -1 --oneline
)

set "VO_VER="
if exist "package.json" for /f "delims=" %%V in ('node -p "require('./package.json').version" 2^>nul') do set "VO_VER=%%V"
echo After git: [%VO_VER%]
echo after git %VO_VER%>>"%LOG%"

set "NEEDZIP=1"
if "%VO_VER%"=="6.0.5" set "NEEDZIP=0"

if "%NEEDZIP%"=="1" (
  echo Downloading ViewerOne from GitHub zip...
  if exist "%TEMP%\ViewerOne-main" rmdir /S /Q "%TEMP%\ViewerOne-main" >>"%LOG%" 2>&1
  curl.exe -L --fail -o "%TEMP%\viewerone-main.zip" https://github.com/russf74/ViewerOne/archive/refs/heads/main.zip
  if exist "%TEMP%\viewerone-main.zip" (
    tar.exe -xf "%TEMP%\viewerone-main.zip" -C "%TEMP%"
    if exist "%TEMP%\ViewerOne-main\package.json" (
      xcopy /E /Y /Q /I "%TEMP%\ViewerOne-main\*" "%REPO%\"
    )
  )
  set "VO_VER="
  if exist "package.json" for /f "delims=" %%V in ('node -p "require('./package.json').version" 2^>nul') do set "VO_VER=%%V"
  echo After zip: [%VO_VER%]
  echo after zip %VO_VER%>>"%LOG%"
)

if not "%VO_VER%"=="6.0.5" (
  echo.
  echo FAILED: still version [%VO_VER%] — not opening the old app.
  echo Log: %LOG%
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm / Node.js not found.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing npm packages...
  call npm install --no-fund --no-audit
)

echo Building v%VO_VER%...
call npm run build
if errorlevel 1 (
  echo ERROR: build failed
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo ERROR: electron.exe missing
  pause
  exit /b 1
)

if exist "%REPO%\scripts\repair-shortcuts.vbs" cscript //nologo "%REPO%\scripts\repair-shortcuts.vbs" "%REPO%" >>"%LOG%" 2>&1

set "VIEWERONE_SKIP_SYNC=1"
echo Starting ViewerOne v%VO_VER%...
start "" /D "%REPO%" "%REPO%\node_modules\electron\dist\electron.exe" .
echo Started OK v%VO_VER%>>"%LOG%"
exit /b 0
