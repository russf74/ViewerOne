#Requires -Version 5.1
# Keep the PC awake and recapture every performance song.
# First launch forces a new stereo WAV. If ViewerOne dies, later launches
# only fill songs that do not yet have a WAV from this run.
param(
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'ViewerOne'),
  [int]$MaxRelaunches = 6,
  [int]$StallMinutes = 25
)

$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:APPDATA 'viewer-one'
$log = Join-Path $dataDir 'overnight-audio.log'
$statusPath = Join-Path $dataDir 'overnight-audio-status.json'
$analyzeLog = Join-Path $dataDir 'lighting-analyze.log'
$electronOut = Join-Path $dataDir 'overnight-audio-electron.out.log'
$electronErr = Join-Path $dataDir 'overnight-audio-electron.err.log'
$electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'

function Write-NightLog([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
  Write-Host $line
}

function Write-Status([hashtable]$patch) {
  $patch['updatedAt'] = (Get-Date).ToString('o')
  ($patch | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $statusPath -Encoding utf8
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SleepUtilAudio {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
$KeepAwake = [Convert]::ToUInt32('80000003', 16)
$ClearAwake = [Convert]::ToUInt32('80000000', 16)
[void][SleepUtilAudio]::SetThreadExecutionState($KeepAwake)

function Get-Readiness {
  $js = @'
const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.env.APPDATA + '/viewer-one/viewer-one-config.json', 'utf8'));
function skip(t) {
  t = String(t || '').toUpperCase();
  return t.includes('SOUNDCHECK') || t.startsWith('INTRO') || t.startsWith('OUTRO');
}
const rows = (j.setlist || []).filter((r) => !skip(r.title) && r.program >= 1 && r.program <= 119 && r.arrangerIndex != null);
const need = [];
const ready = [];
for (const r of rows) {
  const cues = r.lightingProgram && r.lightingProgram.cues ? r.lightingProgram.cues.length : 0;
  const bpm = r.audioAnalysis && r.audioAnalysis.bpm;
  const capturedAt = r.cubaseRenderCapturedAt ? Date.parse(r.cubaseRenderCapturedAt) : 0;
  const fresh = capturedAt >= Number(process.env.RESCAN_AFTER_MS || 0);
  let stereo = false;
  try {
    if (r.cubaseRenderPath && fs.existsSync(r.cubaseRenderPath)) {
      const fd = fs.openSync(r.cubaseRenderPath, 'r');
      const buf = Buffer.alloc(44);
      fs.readSync(fd, buf, 0, 44, 0);
      fs.closeSync(fd);
      stereo = buf.readUInt16LE(22) >= 2;
    }
  } catch (e) {}
  const ok = cues && bpm && fresh && stereo;
  const rec = { program: r.program, title: r.title, ready: !!ok };
  if (ok) ready.push(rec); else need.push(rec);
}
process.stdout.write(JSON.stringify({ total: rows.length, ready: ready.length, need: need.length, missing: need }));
'@
  $raw = & node -e $js
  return $raw | ConvertFrom-Json
}

function Stop-ViewerOne {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -match '\\ViewerOne\\' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
}

function Test-ViewerOneAlive {
  $mains = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -match '\\ViewerOne\\' -and $_.CommandLine -notmatch '--type=' }
  return [bool]$mains
}

function Start-Capture([string]$mode) {
  if (-not (Test-Path -LiteralPath $electron)) { throw "electron.exe missing: $electron" }
  Stop-ViewerOne
  $args = if ($mode -eq 'force') { @('.', '--lighting-analyze-force') } else { @('.', '--lighting-analyze') }
  Start-Process -FilePath $electron -ArgumentList $args -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $electronOut -RedirectStandardError $electronErr -WindowStyle Normal
  Write-NightLog "launched ViewerOne $($args -join ' ')"
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$env:RESCAN_AFTER_MS = [string][DateTimeOffset]::Now.ToUnixTimeMilliseconds()
Write-NightLog 'overnight stereo audio/dmx start'
Write-Status @{ phase = 'starting'; relaunches = 0; ready = 0; total = 0 }

$relaunch = 0
$mode = 'force'
Start-Capture $mode

while ($true) {
  [void][SleepUtilAudio]::SetThreadExecutionState($KeepAwake)
  Start-Sleep -Seconds 40

  $info = $null
  try { $info = Get-Readiness } catch { Write-NightLog "readiness failed: $_"; continue }

  $missingTitles = @()
  if ($info.missing) { $missingTitles = @($info.missing | ForEach-Object { "PC$($_.program) $($_.title)" }) }
  Write-Status @{
    phase = 'capturing'
    ready = [int]$info.ready
    total = [int]$info.total
    need = [int]$info.need
    missing = $missingTitles
    relaunches = $relaunch
    viewerOneAlive = (Test-ViewerOneAlive)
  }
  Write-NightLog "ready $($info.ready)/$($info.total) alive=$(Test-ViewerOneAlive)"

  if ([int]$info.total -gt 0 -and [int]$info.ready -ge [int]$info.total) {
    Write-NightLog 'ALL SONGS CAPTURED'
    Write-Status @{ phase = 'complete'; ready = [int]$info.ready; total = [int]$info.total; need = 0; missing = @() }
    [void][SleepUtilAudio]::SetThreadExecutionState($ClearAwake)
    exit 0
  }

  $alive = Test-ViewerOneAlive
  $stalled = $false
  if (Test-Path -LiteralPath $analyzeLog) {
    $age = ((Get-Date) - (Get-Item -LiteralPath $analyzeLog).LastWriteTime).TotalMinutes
    if ($age -gt $StallMinutes) { $stalled = $true }
  }
  if (-not $alive -or $stalled) {
    if ($relaunch -ge $MaxRelaunches) {
      Write-NightLog "giving up after $relaunch relaunches"
      Write-Status @{ phase = 'stopped'; ready = [int]$info.ready; total = [int]$info.total; need = [int]$info.need; missing = $missingTitles }
      [void][SleepUtilAudio]::SetThreadExecutionState($ClearAwake)
      exit 2
    }
    $relaunch++
    $mode = 'resume'
    Write-NightLog "self-heal relaunch $relaunch (alive=$alive stalled=$stalled)"
    Start-Capture $mode
  }
}
