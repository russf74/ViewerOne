#Requires -Version 5.1
# Point desktop + taskbar ViewerOne shortcuts at ViewerOne-Launch.vbs
param(
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'ViewerOne')
)

$vbs = Join-Path $RepoRoot 'ViewerOne-Launch.vbs'
if (-not (Test-Path -LiteralPath $vbs)) {
  Write-Error "Missing: $vbs"
  exit 1
}

$target = "$env:SystemRoot\System32\wscript.exe"
$args = "`"$vbs`""
$icon = Join-Path $RepoRoot 'build\icon.ico'

$folders = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)

foreach ($folder in $folders) {
  if (-not (Test-Path -LiteralPath $folder)) { continue }

  Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $w = New-Object -ComObject WScript.Shell
      $sc = $w.CreateShortcut($_.FullName)
      $hay = ($_.Name + ' ' + $sc.TargetPath + ' ' + $sc.Arguments).ToLowerInvariant()
      if ($hay -notmatch 'viewerone|viewer-one') { return }
      $sc.TargetPath = $target
      $sc.Arguments = $args
      $sc.WorkingDirectory = $RepoRoot
      if (Test-Path -LiteralPath $icon) { $sc.IconLocation = "$icon,0" }
      $sc.Save()
      Write-Host "Fixed: $($_.FullName)"
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
  Write-Host "OK: $path"
}

exit 0
