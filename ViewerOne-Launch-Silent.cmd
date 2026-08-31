@echo off
setlocal EnableExtensions
REM %1 = repo folder. When omitted, this .cmd lives in the repo.
set "REPO=%~1"
if "%REPO%"=="" set "REPO=%~dp0"
for %%I in ("%REPO%") do set "REPO=%%~fI"

set "LOG=%TEMP%\viewerone-launch.log"
echo %DATE% %TIME% Launch REPO=%REPO%>>"%LOG%"

REM Re-exec from TEMP so git reset cannot rewrite this script mid-run.
if not defined VIEWERONE_LAUNCH_REEXEC (
  copy /Y "%~f0" "%TEMP%\viewerone-launch-run.cmd" >nul
  set "VIEWERONE_LAUNCH_REEXEC=1"
  cmd /c "%TEMP%\viewerone-launch-run.cmd" "%REPO%"
  exit /b %ERRORLEVEL%
)

cd /d "%REPO%"

REM Node.js + Git (shortcuts often miss user PATH)
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"

REM Always close electron.exe first. The kill helper is not on old 6.00.00 disks,
REM and git cannot update package.json while ViewerOne is still open.
echo Killing electron.exe>>"%LOG%"
taskkill /F /IM electron.exe >>"%LOG%" 2>&1
ping -n 3 127.0.0.1 >nul

where git >nul 2>nul && (
  git remote set-url origin https://github.com/russf74/ViewerOne.git 2>nul
  git fetch origin main >>"%LOG%" 2>&1
  git checkout main >>"%LOG%" 2>&1
  git reset --hard origin/main >>"%LOG%" 2>&1
  git log -1 --oneline >>"%LOG%" 2>&1
)

set "VO_VER="
if exist "package.json" if exist "%ProgramFiles%\nodejs\node.exe" (
  for /f "delims=" %%V in ('node -p "require('./package.json').version" 2^>nul') do set "VO_VER=%%V"
)
if exist "package.json" if "%VO_VER%"=="" (
  for /f "delims=" %%V in ('node -p "require('./package.json').version" 2^>nul') do set "VO_VER=%%V"
)
echo version after git %VO_VER%>>"%LOG%"

set "NEEDZIP=0"
if not exist "package.json" set "NEEDZIP=1"
if "%VO_VER%"=="" set "NEEDZIP=1"
if "%VO_VER%"=="6.0.0" set "NEEDZIP=1"
if "%VO_VER%"=="6.0.1" set "NEEDZIP=1"

if "%NEEDZIP%"=="1" (
  echo Forcing GitHub zip overlay>>"%LOG%"
  if exist "%TEMP%\ViewerOne-main" rmdir /S /Q "%TEMP%\ViewerOne-main" >>"%LOG%" 2>&1
  curl.exe -L --fail -o "%TEMP%\viewerone-main.zip" https://github.com/russf74/ViewerOne/archive/refs/heads/main.zip >>"%LOG%" 2>&1
  if exist "%TEMP%\viewerone-main.zip" (
    tar.exe -xf "%TEMP%\viewerone-main.zip" -C "%TEMP%" >>"%LOG%" 2>&1
    if exist "%TEMP%\ViewerOne-main\package.json" (
      xcopy /E /Y /Q /I "%TEMP%\ViewerOne-main\*" "%REPO%\" >>"%LOG%" 2>&1
    )
  )
)

if exist "package.json" (
  for /f "delims=" %%V in ('node -p "require('./package.json').version" 2^>nul') do set "VO_VER=%%V"
)
echo version before build %VO_VER%>>"%LOG%"

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

if exist "%REPO%\scripts\repair-shortcuts.vbs" cscript //nologo "%REPO%\scripts\repair-shortcuts.vbs" "%REPO%" >>"%LOG%" 2>&1

set "VIEWERONE_SKIP_SYNC=1"
start "" /D "%REPO%" "%REPO%\node_modules\electron\dist\electron.exe" .
echo Started OK v%VO_VER%>>"%LOG%"
exit /b 0
