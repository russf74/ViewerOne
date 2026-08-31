#Requires -Version 5.1
# Repairs desktop + taskbar shortcuts via the shared launcher (stable bootstrap path).
param([string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))

$launcher = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'launch-viewerone.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { exit 0 }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -RepoRoot $RepoRoot -FixOnly
