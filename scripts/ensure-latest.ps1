#Requires -Version 5.1
# Ensures this folder matches GitHub main (fixes local-only version drift e.g. 5.12.92).
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'SilentlyContinue'

$ExpectedOrigin = 'https://github.com/russf74/ViewerOne.git'
Push-Location $RepoRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) { return }

  $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
  if (-not $git) {
    $candidate = 'C:\Program Files\Git\cmd\git.exe'
    if (Test-Path -LiteralPath $candidate) { $git = $candidate }
  }
  if (-not $git) { return }

  & $git remote get-url origin 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & $git remote add origin $ExpectedOrigin 2>$null
  } else {
    & $git remote set-url origin $ExpectedOrigin 2>$null
  }

  & $git fetch origin main 2>$null
  & $git checkout main 2>$null
  & $git reset --hard origin/main 2>$null
} finally {
  Pop-Location
}
