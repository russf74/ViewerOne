#Requires -Version 5.1
<#
  Full ViewerOne launch script — downloaded from GitHub on each shortcut click.
  Syncs repo to russf74/ViewerOne main, builds, opens v6.
#>
param(
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'ViewerOne')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedOrigin = 'https://github.com/russf74/ViewerOne.git'

function Get-Git {
  $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
  if ($git) { return $git }
  $candidate = 'C:\Program Files\Git\cmd\git.exe'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  return $null
}

function Sync-FromGitHub([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
  }
  $git = Get-Git
  if (-not $git) { throw 'Git not found — install Git for Windows' }

  Push-Location $Root
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
      & $git clone $ExpectedOrigin $Root
      if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
      return
    }
    & $git remote set-url origin $ExpectedOrigin
    & $git fetch origin main
    & $git checkout main
    & $git reset --hard origin/main
    if ($LASTEXITCODE -ne 0) { throw 'git reset failed' }
  } finally {
    Pop-Location
  }
}

function Show-Version([string]$Root) {
  $pkg = Join-Path $Root 'package.json'
  if (Test-Path -LiteralPath $pkg) {
    return (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version
  }
  return '?'
}

Sync-FromGitHub -Root $RepoRoot
$ver = Show-Version -RepoRoot $RepoRoot

Push-Location $RepoRoot
try {
  if (-not (Test-Path -LiteralPath 'node_modules')) {
    & npm.cmd install --no-fund --no-audit
  }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "build failed (package.json version $ver)" }

  $electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron)) { throw 'electron.exe missing' }
  Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $RepoRoot
} finally {
  Pop-Location
}
