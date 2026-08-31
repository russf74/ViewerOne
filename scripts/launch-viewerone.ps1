#Requires -Version 5.1
# Optional PowerShell entry: runs the same engine as the shortcut.
param(
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'ViewerOne')
)

$cmd = Join-Path $RepoRoot 'ViewerOne-Launch-Silent.cmd'
if (-not (Test-Path -LiteralPath $cmd)) {
  throw "Missing: $cmd"
}
$p = Start-Process -FilePath $cmd -WorkingDirectory $RepoRoot -Wait -PassThru -WindowStyle Hidden
exit $p.ExitCode
