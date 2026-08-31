#Requires -Version 5.1
<#
  ViewerOne one-click launcher — syncs v6 from GitHub, repairs shortcuts, builds, opens.
  Invoked from the stable bootstrap VBS in %LOCALAPPDATA%\ViewerOne\.
#>
param(
  [string]$RepoRoot = '',
  [switch]$FixOnly,
  [switch]$SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BootstrapDir = Join-Path $env:LOCALAPPDATA 'ViewerOne'
$BootstrapVbs = Join-Path $BootstrapDir 'ViewerOne-Launch.vbs'
$GitHubZip = 'https://github.com/russf74/ViewerOne/archive/refs/heads/main.zip'
$RepoUrl = 'https://github.com/russf74/ViewerOne.git'

function Write-Step([string]$Message) {
  Write-Host "[ViewerOne] $Message"
}

function Install-Bootstrap {
  $source = Join-Path $PSScriptRoot 'bootstrap\ViewerOne-Launch.vbs'
  New-Item -ItemType Directory -Path $BootstrapDir -Force | Out-Null
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination $BootstrapVbs -Force
  }
}

function Find-Repo {
  param([string]$Hint)
  $candidates = @()
  if ($Hint -and (Test-Path -LiteralPath $Hint)) { $candidates += $Hint }
  $candidates += @(
    (Join-Path $env:USERPROFILE 'ViewerOne'),
    (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
  )
  foreach ($c in $candidates) {
    $pkg = Join-Path $c 'package.json'
    if (-not (Test-Path -LiteralPath $pkg)) { continue }
    try {
      $j = Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json
      if ($j.name -eq 'viewer-one') { return (Resolve-Path $c).Path }
    } catch { }
  }
  return $null
}

function Ensure-Repo([string]$PreferredRoot) {
  $root = Find-Repo -Hint $PreferredRoot
  if ($root) { return $root }

  $root = if ($PreferredRoot) { $PreferredRoot } else { Join-Path $env:USERPROFILE 'ViewerOne' }
  if (-not (Test-Path -LiteralPath $root)) {
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    Write-Step "Cloning ViewerOne into $root ..."
    & git clone $RepoUrl $root 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return (Resolve-Path $root).Path }
  }
  return (Resolve-Path $root).Path
}

function Sync-RepoGit([string]$Root) {
  Push-Location $Root
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
      return $false
    }
    Write-Step "Syncing from GitHub (git) ..."
    & git fetch origin main 2>&1 | Out-Null
    & git checkout main 2>&1 | Out-Null
    & git reset --hard origin/main 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } finally {
    Pop-Location
  }
}

function Sync-RepoZip([string]$Root) {
  Write-Step 'Syncing from GitHub (zip download) ...'
  $zip = Join-Path $env:TEMP 'viewerone-main.zip'
  $extract = Join-Path $env:TEMP 'viewerone-main-extract'
  if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  (New-Object Net.WebClient).DownloadFile($GitHubZip, $zip)
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $src = Join-Path $extract 'ViewerOne-main'
  if (-not (Test-Path -LiteralPath $src)) { throw 'Unexpected GitHub zip layout' }

  $preserve = @('node_modules', '.git')
  Get-ChildItem -LiteralPath $Root -Force | ForEach-Object {
    if ($preserve -contains $_.Name) { return }
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
  Copy-Item -LiteralPath (Join-Path $src '*') -Destination $Root -Recurse -Force
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
}

function Sync-Repo([string]$Root) {
  if (-not (Sync-RepoGit -Root $Root)) {
    Sync-RepoZip -Root $Root
  }
  $pkg = Join-Path $Root 'package.json'
  $ver = (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version
  Write-Step "Repo at v$ver"
}

function Test-ViewerOneShortcut([string]$Name, [string]$TargetPath, [string]$Arguments) {
  $combined = ("$TargetPath $Arguments").ToLowerInvariant()
  if ($Name -match 'viewer\s*one|viewerone|viewer-one') { return $true }
  if ($combined -match 'viewerone|viewer-one|\\viewerone\\') { return $true }
  if ($TargetPath -match 'ViewerOne\.exe$') { return $true }
  return $false
}

function Repair-Shortcuts([string]$Root) {
  Install-Bootstrap
  $target = "$env:SystemRoot\System32\wscript.exe"
  $args = "`"$BootstrapVbs`""
  $icon = Join-Path $Root 'build\icon.ico'

  $folders = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:PUBLIC 'Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup')
  )

  foreach ($folder in $folders) {
    if (-not (Test-Path -LiteralPath $folder)) { continue }
    Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $w = New-Object -ComObject WScript.Shell
        $sc = $w.CreateShortcut($_.FullName)
        if (-not (Test-ViewerOneShortcut -Name $_.BaseName -TargetPath $sc.TargetPath -Arguments $sc.Arguments)) {
          return
        }
        $sc.TargetPath = $target
        $sc.Arguments = $args
        $sc.WorkingDirectory = $BootstrapDir
        if ($icon -and (Test-Path -LiteralPath $icon)) { $sc.IconLocation = "$icon,0" }
        $sc.Save()
        Write-Step "Fixed shortcut: $($_.FullName)"
      } catch { }
    }
    $desktop = Join-Path $folder 'ViewerOne.lnk'
    try {
      $w = New-Object -ComObject WScript.Shell
      $s = $w.CreateShortcut($desktop)
      $s.TargetPath = $target
      $s.Arguments = $args
      $s.WorkingDirectory = $BootstrapDir
      if ($icon -and (Test-Path -LiteralPath $icon)) { $s.IconLocation = "$icon,0" }
      $s.Save()
    } catch { }
  }
}

function Build-And-Launch([string]$Root) {
  Push-Location $Root
  try {
    if (-not (Test-Path -LiteralPath 'node_modules')) {
      Write-Step 'Installing npm dependencies ...'
      & npm.cmd install --no-fund --no-audit
    }
    Write-Step 'Building ViewerOne ...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
    $electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electron)) { throw 'Electron missing after build' }
    if (-not $SkipLaunch) {
      Write-Step 'Launching ViewerOne ...'
      Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $Root
    }
  } finally {
    Pop-Location
  }
}

Install-Bootstrap
$repo = Ensure-Repo -PreferredRoot $RepoRoot
Sync-Repo -Root $repo
Repair-Shortcuts -Root $repo
if ($FixOnly) { exit 0 }
Build-And-Launch -Root $repo
