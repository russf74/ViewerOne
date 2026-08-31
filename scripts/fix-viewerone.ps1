#Requires -Version 5.1
# Optional visible repair: install, build, launch. Does not touch git.
# ASCII only.

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Join-Path $env:USERPROFILE 'ViewerOne' }

$LogFile = Join-Path $env:TEMP 'viewerone-fix.log'

function Log([string]$Message) {
  $line = "$(Get-Date -Format 'HH:mm:ss') $Message"
  Write-Host $line
  Add-Content -LiteralPath $LogFile -Value $line
}

function Fail([string]$Message) {
  Log "ERROR: $Message"
  Write-Host $Message -ForegroundColor Red
  if ($Host.Name -eq 'ConsoleHost') { Read-Host 'Press Enter to close' }
  exit 1
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$env:Path"
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

Clear-Content -LiteralPath $LogFile -ErrorAction SilentlyContinue
Log "ViewerOne fix - folder: $RepoRoot"

$npm = Find-Npm
if (-not $npm) { Fail 'npm not found. Install Node.js LTS from https://nodejs.org' }

Push-Location $RepoRoot
try {
  Log 'npm install / build'
  & $npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }
  & $npm run build
  if ($LASTEXITCODE -ne 0) { Fail 'npm run build failed' }

  $electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron)) { Fail 'electron.exe not found' }

  $repair = Join-Path $RepoRoot 'scripts\repair-shortcuts.ps1'
  if (Test-Path -LiteralPath $repair) {
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $repair -RepoRoot $RepoRoot
  }

  Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $RepoRoot
  Log 'Started ViewerOne'
} finally {
  Pop-Location
}

exit 0
