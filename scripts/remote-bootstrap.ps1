#Requires -Version 5.1
<#
  ViewerOne remote bootstrap — sync repo, fix Desktop + taskbar shortcuts, build, launch.
  Can run from GitHub raw (always latest) or locally. Safe to call repeatedly.
#>
param(
  [string]$RepoRoot = '',
  [ValidateSet('Launch', 'SyncOnly', 'Logon', 'StartGigApps')]
  [string]$Mode = 'Launch'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Info([string]$Msg) { Write-Host $Msg -ForegroundColor Cyan }
function Write-Ok([string]$Msg) { Write-Host $Msg -ForegroundColor Green }

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

function Resolve-RepoRoot {
  param([string]$Hint)
  $candidates = @()
  if ($Hint -and (Test-Path -LiteralPath $Hint)) { $candidates += (Resolve-Path $Hint).Path }
  $candidates += @(
    (Join-Path $env:USERPROFILE 'ViewerOne'),
    (Join-Path $env:USERPROFILE 'Documents\ViewerOne'),
    (Join-Path $env:USERPROFILE 'source\repos\ViewerOne'),
    'C:\ViewerOne'
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c 'package.json'))) {
      return (Resolve-Path $c).Path
    }
  }
  return $null
}

function Sync-Repo {
  param([Parameter(Mandatory = $true)][string]$Root)
  Push-Location $Root
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
      throw "Not a git repo: $Root"
    }
    Write-Info "Syncing ViewerOne repo at $Root"
    git fetch origin cursor/sound-to-light-director-433b 2>$null
    git fetch origin main 2>$null
    $branch = 'cursor/sound-to-light-director-433b'
    git checkout $branch 2>$null
    if ($LASTEXITCODE -ne 0) { $branch = 'main'; git checkout main 2>$null }
    git reset --hard "origin/$branch" 2>$null
    if ($LASTEXITCODE -ne 0) { git pull --ff-only origin $branch 2>$null }
    Write-Ok "Repo on branch $branch"
  } finally {
    Pop-Location
  }
}

function Ensure-Built {
  param([Parameter(Mandatory = $true)][string]$Root)
  Push-Location $Root
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
      Write-Info 'Running npm install...'
      & npm.cmd install --no-fund --no-audit
      if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    }
    Write-Info 'Building ViewerOne v6...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  } finally {
    Pop-Location
  }
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
  $rawUrl = 'https://raw.githubusercontent.com/russf74/ViewerOne/cursor/sound-to-light-director-433b/scripts/remote-bootstrap.ps1'
  @"
Option Explicit
Dim sh, repoRoot, repoFile, cmd
Set sh = CreateObject("WScript.Shell")
repoRoot = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\ViewerOne"
repoFile = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\repo.txt"
If CreateObject("Scripting.FileSystemObject").FileExists(repoFile) Then
  Dim tf: Set tf = CreateObject("Scripting.FileSystemObject").OpenTextFile(repoFile, 1)
  repoRoot = Trim(tf.ReadAll()): tf.Close
End If
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command ""& { `$u='$rawUrl'; `$p=`$env:TEMP+'\vo-bootstrap.ps1'; (New-Object Net.WebClient).DownloadFile(`$u, `$p); & `$p -RepoRoot '" & repoRoot & "' -Mode Launch }"""
sh.Run cmd, 0, False
"@ | Set-Content -LiteralPath $bootstrapVbs -Encoding ASCII
  return $bootstrapVbs
}

function New-Shortcut {
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

function Repair-AllShortcuts {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$BootstrapVbs,
    [Parameter(Mandatory = $true)][string]$DisplayVersion
  )
  $description = "ViewerOne v$DisplayVersion"
  $icon = Join-Path $RepoRoot 'build\icon.ico'
  $target = "$env:SystemRoot\System32\wscript.exe"
  $args = "`"$BootstrapVbs`""
  $workDir = Split-Path $BootstrapVbs

  $folders = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('Programs'),
    [Environment]::GetFolderPath('CommonPrograms'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch')
  )

  $fixed = New-Object System.Collections.Generic.List[string]
  foreach ($folder in $folders) {
    if (-not ($folder -and (Test-Path -LiteralPath $folder))) { continue }
    Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $w = New-Object -ComObject WScript.Shell
        $sc = $w.CreateShortcut($_.FullName)
        $combined = ($sc.TargetPath + ' ' + $sc.Arguments).ToLowerInvariant()
        $name = $_.Name.ToLowerInvariant()
        if ($name -like '*viewerone*' -or $combined -match 'viewerone|viewer-one') {
          New-Shortcut -Path $_.FullName -Target $target -Arguments $args -WorkDir $workDir -Description $description -Icon $icon
          $fixed.Add($_.FullName)
        }
      } catch { }
    }
  }

  foreach ($name in @('ViewerOne.lnk', 'ViewerOne-Launch.lnk')) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $path = Join-Path $desktop $name
    New-Shortcut -Path $path -Target $target -Arguments $args -WorkDir $workDir -Description $description -Icon $icon
    $fixed.Add($path)
  }

  return $fixed
}

function Register-MaintenanceTask {
  $taskName = 'ViewerOne Auto Sync'
  $rawUrl = 'https://raw.githubusercontent.com/russf74/ViewerOne/cursor/sound-to-light-director-433b/scripts/remote-bootstrap.ps1'
  $arg = "-NoProfile -ExecutionPolicy Bypass -Command ""& { `$p=`$env:TEMP+'\vo-sync.ps1'; (New-Object Net.WebClient).DownloadFile('$rawUrl', `$p); & `$p -Mode SyncOnly }"""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
  $boot = New-ScheduledTaskTrigger -AtStartup
  $logon = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($boot, $logon) -Settings $settings -Principal $principal -Description 'Keep ViewerOne shortcuts and repo on v6' -Force | Out-Null
}

function Launch-ViewerOne {
  param([Parameter(Mandatory = $true)][string]$Root)
  $electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron)) { throw "Electron missing at $electron" }
  Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $Root -WindowStyle Normal
}

# --- main ---
$repo = Resolve-RepoRoot -Hint $RepoRoot
if (-not $repo) {
  throw 'ViewerOne repo not found. Expected %USERPROFILE%\ViewerOne with package.json'
}

Sync-Repo -Root $repo
Ensure-Built -Root $repo

$pkg = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$displayVersion = Format-ViewerOneVersion -Version ([string]$pkg.version)
$bootstrap = Install-BootstrapLauncher -RepoRoot $repo -DisplayVersion $displayVersion
$fixed = Repair-AllShortcuts -RepoRoot $repo -BootstrapVbs $bootstrap -DisplayVersion $displayVersion
Register-MaintenanceTask

Write-Ok "ViewerOne v$displayVersion ready"
foreach ($p in $fixed) { Write-Host "  shortcut: $p" }

if ($Mode -eq 'SyncOnly') { exit 0 }
if ($Mode -eq 'Logon' -or $Mode -eq 'StartGigApps') { exit 0 }
Launch-ViewerOne -Root $repo
