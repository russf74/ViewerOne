#Requires -Version 5.1
<#
  Create or refresh ViewerOne desktop + taskbar shortcuts.
  Points to wscript.exe + ViewerOne-Launch.vbs in the repo (same as always).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  return (Resolve-Path (Join-Path $here '..')).Path
}

function Get-PackageVersion {
  param([string]$RepoRoot)
  $pkg = Join-Path $RepoRoot 'package.json'
  if (-not (Test-Path -LiteralPath $pkg)) { return '6.0.0' }
  $json = Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json
  return [string]$json.version
}

function Format-ViewerOneVersion {
  param([string]$Version)
  if ($Version -match '^(\d+)\.(\d+)\.(\d+)') {
    $major = [int]$Matches[1]
    if ($major -ge 6) {
      return ('{0}.{1}.{2}' -f $major, $Matches[2].PadLeft(2, '0'), $Matches[3].PadLeft(2, '0'))
    }
  }
  return $Version
}

function New-ViewerOneShortcut {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Target,
    [string]$Arguments = '',
    [string]$WorkDir = '',
    [string]$Description = '',
    [string]$Icon = ''
  )
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $w = New-Object -ComObject WScript.Shell
  $lnk = $w.CreateShortcut($Path)
  $lnk.TargetPath = $Target
  $lnk.Arguments = $Arguments
  if ($WorkDir) { $lnk.WorkingDirectory = $WorkDir }
  if ($Description) { $lnk.Description = $Description }
  if ($Icon -and (Test-Path -LiteralPath $Icon)) { $lnk.IconLocation = "$Icon,0" }
  $lnk.Save()
}

$repoRoot = Get-RepoRoot
$version = Get-PackageVersion -RepoRoot $repoRoot
$displayVersion = Format-ViewerOneVersion -Version $version
$vbs = Join-Path $repoRoot 'ViewerOne-Launch.vbs'
$icon = Join-Path $repoRoot 'build\icon.ico'
$description = "ViewerOne v$displayVersion"
$target = "$env:SystemRoot\System32\wscript.exe"
$args = "`"$vbs`""

if (-not (Test-Path -LiteralPath $vbs)) {
  Write-Error "ViewerOne-Launch.vbs not found at $vbs"
}

$folders = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)

foreach ($folder in $folders) {
  if (-not (Test-Path -LiteralPath $folder)) { continue }
  $path = Join-Path $folder 'ViewerOne.lnk'
  New-ViewerOneShortcut -Path $path -Target $target -Arguments $args `
    -WorkDir $repoRoot -Description $description -Icon $icon
  Write-Host "ViewerOne shortcut -> $path"
}

Write-Host "ViewerOne v$displayVersion — shortcuts point to $vbs"
