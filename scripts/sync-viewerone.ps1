#Requires -Version 5.1
# Keeps Desktop + taskbar ViewerOne shortcuts pointing at ViewerOne-Launch.vbs in this repo.
param([string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))

$vbs = Join-Path $RepoRoot 'ViewerOne-Launch.vbs'
if (-not (Test-Path -LiteralPath $vbs)) { exit 0 }

$target = "$env:SystemRoot\System32\wscript.exe"
$args = "`"$vbs`""
$icon = Join-Path $RepoRoot 'build\icon.ico'

$folders = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)

foreach ($folder in $folders) {
  if (-not (Test-Path -LiteralPath $folder)) { continue }
  Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $w = New-Object -ComObject WScript.Shell
      $sc = $w.CreateShortcut($_.FullName)
      $combined = ($sc.TargetPath + ' ' + $sc.Arguments).ToLowerInvariant()
      if ($_.Name -like '*ViewerOne*' -or $combined -match 'viewerone|viewer-one') {
        $sc.TargetPath = $target
        $sc.Arguments = $args
        $sc.WorkingDirectory = $RepoRoot
        if (Test-Path -LiteralPath $icon) { $sc.IconLocation = "$icon,0" }
        $sc.Save()
      }
    } catch { }
  }
  $path = Join-Path $folder 'ViewerOne.lnk'
  $w = New-Object -ComObject WScript.Shell
  $sc = $w.CreateShortcut($path)
  $sc.TargetPath = $target
  $sc.Arguments = $args
  $sc.WorkingDirectory = $RepoRoot
  if (Test-Path -LiteralPath $icon) { $sc.IconLocation = "$icon,0" }
  $sc.Save()
}
