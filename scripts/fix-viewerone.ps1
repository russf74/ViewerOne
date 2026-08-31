#Requires -Version 5.1
# ASCII only. One-time repair: sync GitHub main, install, build, fix shortcuts, launch.
# Safe to run via: irm <raw-url> | iex   OR   ViewerOne-Fix.cmd

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Join-Path $env:USERPROFILE 'ViewerOne' }

$LogFile = Join-Path $env:TEMP 'viewerone-fix.log'
$ExpectedOrigin = 'https://github.com/russf74/ViewerOne.git'
$FixBranch = 'cursor/fix-shortcut-launch-3470'

function Log([string]$Message) {
  $line = "$(Get-Date -Format 'HH:mm:ss') $Message"
  Write-Host $line
  Add-Content -LiteralPath $LogFile -Value $line
}

function Fail([string]$Message) {
  Log "ERROR: $Message"
  Log "Log file: $LogFile"
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  if ($Host.Name -eq 'ConsoleHost') {
    Read-Host 'Press Enter to close'
  }
  exit 1
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$env:Path"
}

function Find-Git {
  Refresh-Path
  $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
  if ($git) { return $git }
  foreach ($c in @(
      'C:\Program Files\Git\cmd\git.exe',
      'C:\Program Files (x86)\Git\cmd\git.exe'
    )) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

function Find-Npm {
  Refresh-Path
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if ($npm) { return $npm }
  foreach ($c in @(
      "$env:ProgramFiles\nodejs\npm.cmd",
      "${env:ProgramFiles(x86)}\nodejs\npm.cmd",
      "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd"
    )) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

function Sync-Repo([string]$Root, [string]$Git) {
  if (-not (Test-Path -LiteralPath $Root)) {
    Log "Folder missing - cloning $ExpectedOrigin to $Root"
    & $Git clone $ExpectedOrigin $Root
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed - is Git installed and is the PC online?' }
    return
  }

  Push-Location $Root
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
      Fail "No .git folder in $Root - move that folder aside and re-run this repair to clone fresh."
    }
    Log 'Syncing from GitHub...'
    & $Git remote set-url origin $ExpectedOrigin
    & $Git fetch origin main
    if ($LASTEXITCODE -ne 0) { Fail 'git fetch failed - check internet' }
    & $Git cat-file -e origin/main:ViewerOne-Fix.cmd
    if ($LASTEXITCODE -eq 0) {
      Log 'Updating local main from origin/main'
      & $Git checkout -B main origin/main
    } else {
      Log "Launcher fix is not on main yet - using $FixBranch"
      & $Git fetch origin $FixBranch
      if ($LASTEXITCODE -ne 0) { Fail "git fetch $FixBranch failed" }
      & $Git checkout -B main "origin/$FixBranch"
    }
    if ($LASTEXITCODE -ne 0) { Fail 'git checkout failed' }
  } finally {
    Pop-Location
  }
}

Clear-Content -LiteralPath $LogFile -ErrorAction SilentlyContinue
Log "ViewerOne fix - folder: $RepoRoot"

$git = Find-Git
if (-not $git) { Fail 'Git not found. Install Git for Windows from https://git-scm.com' }
Log "Git: $git"

$npm = Find-Npm
if (-not $npm) { Fail 'npm not found. Install Node.js LTS from https://nodejs.org' }
Log "npm: $npm"

Sync-Repo -Root $RepoRoot -Git $git

$pkg = Join-Path $RepoRoot 'package.json'
if (-not (Test-Path -LiteralPath $pkg)) { Fail "package.json missing in $RepoRoot" }
$ver = (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version
Log "Version in package.json: $ver"

Push-Location $RepoRoot
try {
  Log 'Running npm install...'
  & $npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }

  Log 'Building ViewerOne...'
  & $npm run build
  if ($LASTEXITCODE -ne 0) { Fail 'npm run build failed' }

  $electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron)) { Fail 'electron.exe not found after build' }

  $repair = Join-Path $RepoRoot 'scripts\repair-shortcuts.ps1'
  if (Test-Path -LiteralPath $repair) {
    Log 'Repairing desktop and taskbar shortcuts...'
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $repair -RepoRoot $RepoRoot
  }

  Log 'Starting ViewerOne...'
  Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $RepoRoot
  Log 'Done - ViewerOne should be opening now.'
  Start-Sleep -Seconds 2
} finally {
  Pop-Location
}

exit 0
