#Requires -Version 5.1
# Daily launcher for desktop/taskbar shortcut - build and open (no git sync).
param(
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'ViewerOne')
)

$ErrorActionPreference = 'Stop'

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Find-Npm {
  Refresh-Path
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if ($npm) { return $npm }
  foreach ($c in @(
      "$env:ProgramFiles\nodejs\npm.cmd",
      "${env:ProgramFiles(x86)}\nodejs\npm.cmd"
    )) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  throw 'npm not found'
}

try {
  $npm = Find-Npm
  Push-Location $RepoRoot
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  $electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron)) { throw 'electron.exe missing' }
  Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $RepoRoot
  exit 0
} catch {
  $log = Join-Path $env:TEMP 'viewerone-launch.log'
  "$(Get-Date -Format o) $_" | Out-File -LiteralPath $log -Append -Encoding utf8
  Write-Error $_
  exit 1
} finally {
  Pop-Location -ErrorAction SilentlyContinue
}
