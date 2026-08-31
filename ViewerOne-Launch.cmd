@echo off
REM ViewerOne — always syncs v6 from GitHub, fixes taskbar/desktop pin, builds, launches.
set "REPO=%~dp0"
if exist "%LOCALAPPDATA%\ViewerOne\repo.txt" (
  set /p REPO=<"%LOCALAPPDATA%\ViewerOne\repo.txt"
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $p=$env:TEMP+'\vo-bootstrap.ps1'; (New-Object Net.WebClient).DownloadFile('https://raw.githubusercontent.com/russf74/ViewerOne/main/scripts/remote-bootstrap.ps1',$p); & $p -RepoRoot '%REPO%' -Mode Launch }"
exit /b %ERRORLEVEL%
