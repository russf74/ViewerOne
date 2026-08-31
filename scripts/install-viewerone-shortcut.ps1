#Requires -Version 5.1
<#
  Refresh every ViewerOne shortcut (Desktop, taskbar pin, Start Menu).
  Installs a stable LocalAppData bootstrap so pins survive repo moves.
  Prefers release\win-unpacked\ViewerOne.exe when built; else repo VBS launcher.
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

function Get-ShortcutPaths {
  $paths = New-Object System.Collections.Generic.List[string]
  $desktop = [Environment]::GetFolderPath('Desktop')
  $commonDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
  $startMenu = [Environment]::GetFolderPath('Programs')
  $commonStart = [Environment]::GetFolderPath('CommonPrograms')
  $taskBar = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
  foreach ($p in @($desktop, $commonDesktop, $startMenu, $commonStart, $taskBar)) {
    if ($p -and (Test-Path -LiteralPath $p)) { $paths.Add($p) }
  }
  return $paths
}

function Install-BootstrapLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$DisplayVersion
  )
  $bootstrapDir = Join-Path $env:LOCALAPPDATA 'ViewerOne'
  if (-not (Test-Path -LiteralPath $bootstrapDir)) {
    New-Item -ItemType Directory -Path $bootstrapDir -Force | Out-Null
  }
  Set-Content -LiteralPath (Join-Path $bootstrapDir 'repo.txt') -Value $RepoRoot -Encoding ASCII -NoNewline
  $bootstrapVbs = Join-Path $bootstrapDir 'ViewerOne-Launch.vbs'
  @"
Option Explicit
Dim sh, fso, bootstrapDir, repoRoot, repoFile, pullCmd, ps1, buildCmd, electronExe, launchCmd, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
bootstrapDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\ViewerOne"
repoFile = bootstrapDir & "\repo.txt"
If fso.FileExists(repoFile) Then
  Dim tf
  Set tf = fso.OpenTextFile(repoFile, 1)
  repoRoot = Trim(tf.ReadAll())
  tf.Close
End If
If Not fso.FolderExists(repoRoot) Then
  MsgBox "ViewerOne repo not found at " & repoRoot, vbCritical, "ViewerOne"
  WScript.Quit 1
End If
pullCmd = "cmd /c cd /d """ & repoRoot & """ && git pull --ff-only origin main 2>nul"
sh.Run pullCmd, 0, True
ps1 = repoRoot & "\scripts\install-viewerone-shortcut.ps1"
If fso.FileExists(ps1) Then sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, True
If Not fso.FolderExists(repoRoot & "\node_modules") Then
  sh.Run "cmd /c cd /d """ & repoRoot & """ && npm install --no-fund --no-audit", 0, True
End If
buildCmd = "cmd /c cd /d """ & repoRoot & """ && npm run build"
code = sh.Run(buildCmd, 0, True)
If code <> 0 Then
  MsgBox "ViewerOne could not build." & vbCrLf & vbCrLf & "Repo: " & repoRoot, vbCritical, "ViewerOne v$DisplayVersion"
  WScript.Quit code
End If
electronExe = repoRoot & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electronExe) Then
  MsgBox "Electron missing — run npm install in " & repoRoot, vbCritical, "ViewerOne"
  WScript.Quit 1
End If
launchCmd = "cmd /c cd /d """ & repoRoot & """ && """ & electronExe & """ ."
sh.Run launchCmd, 0, False
"@ | Set-Content -LiteralPath $bootstrapVbs -Encoding ASCII
  return $bootstrapVbs
}

function Resolve-LaunchTarget {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$BootstrapVbs
  )
  $icon = Join-Path $RepoRoot 'build\icon.ico'
  # Always use the LocalAppData bootstrap so every click syncs, rebuilds, and stays on latest.
  return @{
    Target = "$env:SystemRoot\System32\wscript.exe"
    Arguments = "`"$BootstrapVbs`""
    WorkDir = Split-Path $BootstrapVbs
    Icon = $icon
    Kind = 'bootstrap-vbs'
  }
}

$repoRoot = Get-RepoRoot
$version = Get-PackageVersion -RepoRoot $repoRoot
$displayVersion = Format-ViewerOneVersion -Version $version
$description = "ViewerOne v$displayVersion"
$bootstrapVbs = Install-BootstrapLauncher -RepoRoot $repoRoot -DisplayVersion $displayVersion
$launch = Resolve-LaunchTarget -RepoRoot $repoRoot -BootstrapVbs $bootstrapVbs

$shortcutNames = @('ViewerOne.lnk', 'ViewerOne-Launch.lnk')
$updated = New-Object System.Collections.Generic.List[string]

foreach ($folder in Get-ShortcutPaths) {
  foreach ($name in $shortcutNames) {
    $path = Join-Path $folder $name
    if (-not (Test-Path -LiteralPath $folder)) { continue }
    New-ViewerOneShortcut -Path $path -Target $launch.Target -Arguments $launch.Arguments `
      -WorkDir $launch.WorkDir -Description $description -Icon $launch.Icon
    if (Test-Path -LiteralPath $path) { $updated.Add($path) }
  }
  Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $w = New-Object -ComObject WScript.Shell
      $sc = $w.CreateShortcut($_.FullName)
      $target = $sc.TargetPath
      $args = $sc.Arguments
      $combined = ($target + ' ' + $args).ToLowerInvariant()
      if ($combined -match 'viewerone' -and $_.Name -notin $shortcutNames) {
        New-ViewerOneShortcut -Path $_.FullName -Target $launch.Target -Arguments $launch.Arguments `
          -WorkDir $launch.WorkDir -Description $description -Icon $launch.Icon
        $updated.Add($_.FullName)
      }
    } catch { }
  }
}

Write-Host "ViewerOne shortcuts refreshed ($displayVersion, $($launch.Kind))"
foreach ($p in $updated) { Write-Host "  $p -> $($launch.Target)" }
