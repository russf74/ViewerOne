#Requires -Version 5.1
<#
  Create or refresh the Desktop ViewerOne shortcut (ViewerOne.lnk).
  Prefers a built release exe when present; otherwise the silent VBS dev launcher.
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
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'ViewerOne.lnk'
$icon = Join-Path $repoRoot 'build\icon.ico'
$description = "ViewerOne v$displayVersion"

$releaseDir = Join-Path $repoRoot 'release'
$unpackedExe = Join-Path $releaseDir 'win-unpacked\ViewerOne.exe'
$portable = Get-ChildItem -LiteralPath $releaseDir -Filter 'ViewerOne-*-portable.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

$vbs = Join-Path $repoRoot 'ViewerOne-Launch.vbs'

if (Test-Path -LiteralPath $unpackedExe) {
  New-ViewerOneShortcut -Path $shortcutPath -Target $unpackedExe -WorkDir (Split-Path $unpackedExe) -Description $description -Icon $icon
  Write-Host "ViewerOne shortcut -> release build ($displayVersion)"
  Write-Host "  $shortcutPath"
  Write-Host "  -> $unpackedExe"
  exit 0
}

if ($portable) {
  New-ViewerOneShortcut -Path $shortcutPath -Target $portable.FullName -WorkDir $portable.DirectoryName -Description $description -Icon $icon
  Write-Host "ViewerOne shortcut -> portable build ($displayVersion)"
  Write-Host "  $shortcutPath"
  Write-Host "  -> $($portable.FullName)"
  exit 0
}

if (-not (Test-Path -LiteralPath $vbs)) {
  Write-Error "No release build and ViewerOne-Launch.vbs missing at: $vbs"
}

New-ViewerOneShortcut -Path $shortcutPath `
  -Target "$env:SystemRoot\System32\wscript.exe" `
  -Arguments "`"$vbs`"" `
  -WorkDir $repoRoot `
  -Description $description `
  -Icon $icon

Write-Host "ViewerOne shortcut -> dev launcher ($displayVersion)"
Write-Host "  $shortcutPath"
Write-Host "  -> wscript.exe `"$vbs`""
