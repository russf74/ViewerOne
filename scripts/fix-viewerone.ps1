#Requires -Version 5.1
# Visible repair + launch - run from PowerShell or ViewerOne-Fix.cmd
param(
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'ViewerOne')
)

$LogFile = Join-Path $env:TEMP 'viewerone-fix.log'
$ExpectedOrigin = 'https://github.com/russf74/ViewerOne.git'

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
  Read-Host 'Press Enter to close'
  exit 1
}

function Find-Git {
  $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
  if ($git) { return $git }
  $c = 'C:\Program Files\Git\cmd\git.exe'
  if (Test-Path -LiteralPath $c) { return $c }
  return $null
}

function Find-Npm {
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if ($npm) { return $npm }
  $candidates = @(
    "$env:ProgramFiles\nodejs\npm.cmd",
    "${env:ProgramFiles(x86)}\nodejs\npm.cmd"
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

function Sync-Repo([string]$Root, [string]$Git) {
  if (-not (Test-Path -LiteralPath $Root)) {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
  }

  Push-Location $Root
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
      Log 'No .git folder - cloning fresh copy to temp, then copying over...'
      $temp = Join-Path $env:TEMP 'ViewerOne-clone'
      if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
      & $Git clone $ExpectedOrigin $temp
      if ($LASTEXITCODE -ne 0) { Fail 'git clone failed - is Git installed?' }
      Get-ChildItem -LiteralPath $temp -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Root -Recurse -Force
      }
      Remove-Item -LiteralPath $temp -Recurse -Force
      return
    }

    Log 'Syncing from GitHub main...'
    & $Git remote set-url origin $ExpectedOrigin
    & $Git fetch origin main
    if ($LASTEXITCODE -ne 0) { Fail 'git fetch failed - check internet' }
    & $Git checkout main 2>$null
    & $Git reset --hard origin/main
    if ($LASTEXITCODE -ne 0) { Fail 'git reset failed' }
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
  if (-not (Test-Path -LiteralPath 'node_modules')) {
    Log 'Running npm install (first time - may take a few minutes)...'
    & $npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }
  }

  Log 'Building ViewerOne...'
  & $npm run build
  if ($LASTEXITCODE -ne 0) { Fail 'npm run build failed' }

  $electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron)) { Fail 'electron.exe not found after build' }

  Log 'Starting ViewerOne...'
  Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $RepoRoot
  Log 'Done - ViewerOne should be opening now.'
  Start-Sleep -Seconds 2
} finally {
  Pop-Location
}
