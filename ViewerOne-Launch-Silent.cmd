@echo off
setlocal EnableExtensions
REM Engine for desktop/taskbar shortcuts. Run from a TEMP copy so
REM "git reset --hard" cannot rewrite this batch file while it is running.

if /i "%~n0"=="viewerone-launch-run" goto run_from_temp
set "VO_REPO=%~dp0"
copy /Y "%~f0" "%TEMP%\viewerone-launch-run.cmd" >nul
call "%TEMP%\viewerone-launch-run.cmd"
exit /b %ERRORLEVEL%

:run_from_temp
if not defined VO_REPO set "VO_REPO=%~dp0"
cd /d "%VO_REPO%"

set "LOG=%TEMP%\viewerone-launch.log"
>>"%LOG%" echo %DATE% %TIME% launch %CD%

REM Shortcuts often have a stripped PATH. Merge Machine+User PATH, then
REM prepend known Node.js / Git locations so npm is found.
set "VO_REG_PATH="
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "VO_REG_PATH=%%B"
if defined VO_REG_PATH set "PATH=%VO_REG_PATH%;%PATH%"
set "VO_REG_PATH="
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "VO_REG_PATH=%%B"
if defined VO_REG_PATH set "PATH=%VO_REG_PATH%;%PATH%"
if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
set "PF86=%ProgramFiles(x86)%"
if defined PF86 if exist "%PF86%\nodejs\npm.cmd" set "PATH=%PF86%\nodejs;%PATH%"

where git >nul 2>nul
if not errorlevel 1 (
  git remote set-url origin https://github.com/russf74/ViewerOne.git >>"%LOG%" 2>&1
  git fetch origin main >>"%LOG%" 2>&1
  git cat-file -e origin/main:ViewerOne-Fix.cmd >>"%LOG%" 2>&1
  if not errorlevel 1 (
    git reset --hard origin/main >>"%LOG%" 2>&1
  ) else (
    git fetch origin cursor/fix-shortcut-launch-3470 >>"%LOG%" 2>&1
    if not errorlevel 1 git reset --hard origin/cursor/fix-shortcut-launch-3470 >>"%LOG%" 2>&1
  )
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  >>"%LOG%" echo ERROR: npm not found
  exit /b 1
)

call npm.cmd install --prefer-offline --no-fund --no-audit >>"%LOG%" 2>&1
if errorlevel 1 (
  >>"%LOG%" echo ERROR: npm install failed
  exit /b 2
)

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
