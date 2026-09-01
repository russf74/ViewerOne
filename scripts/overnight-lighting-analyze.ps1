#Requires -Version 5.1
# Overnight: keep the PC awake, run ViewerOne --lighting-analyze, relaunch if it dies or stalls.
param(
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'ViewerOne'),
  [int]$MaxRelaunches = 8,
  [int]$StallMinutes = 15
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:APPDATA 'viewer-one\overnight-analyze.log'
$statusPath = Join-Path $env:APPDATA 'viewer-one\overnight-analyze-status.json'
$analyzeLog = Join-Path $env:APPDATA 'viewer-one\lighting-analyze.log'
$electronOut = Join-Path $env:APPDATA 'viewer-one\lighting-analyze-electron.out.log'
$electronErr = Join-Path $env:APPDATA 'viewer-one\lighting-analyze-electron.err.log'
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
public static class SleepUtil {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED — Cubase OCR needs the screen on.
$KeepAwake = [Convert]::ToUInt32('80000003', 16)
$ClearAwake = [Convert]::ToUInt32('80000000', 16)
[void][SleepUtil]::SetThreadExecutionState($KeepAwake)

function Get-Readiness {
  $js = @'
const fs = require('fs');
const path = require('path');
const j = JSON.parse(fs.readFileSync(process.env.APPDATA + '/viewer-one/viewer-one-config.json', 'utf8'));
function skip(t) {
  t = String(t || '').toUpperCase();
  return t.includes('SOUNDCHECK') || t.startsWith('INTRO') || t.startsWith('OUTRO');
}
const rows = (j.setlist || []).filter((r) => !skip(r.title) && r.program >= 1 && r.program <= 119 && r.arrangerIndex != null);
const need = [];
const ready = [];
for (const r of rows) {
  const click = r.clickTrackPath || '';
  const clickOk = click && fs.existsSync(click) && fs.statSync(click).size > 8000;
  const listed = String(r.length || '').split(':');
  const listedSec = listed.length === 2 ? Number(listed[0]) * 60 + Number(listed[1]) : 0;
  const analyzedSec = r.audioAnalysis && r.audioAnalysis.durationMs ? r.audioAnalysis.durationMs / 1000 : 0;
  const durOk = listedSec < 5 || analyzedSec <= 0 || analyzedSec <= listedSec * 1.25 + 2;
  const ok = r.lightingProgram && r.lightingProgram.cues && r.lightingProgram.cues.length && r.audioAnalysis && r.audioAnalysis.bpm && clickOk && durOk;
  const rec = { program: r.program, title: r.title, length: r.length || '', arrangerIndex: r.arrangerIndex, ready: !!ok };
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
  Start-Sleep -Seconds 2
}

function Start-Analyze {
  if (-not (Test-Path -LiteralPath $electron)) { throw "electron.exe missing: $electron" }
  Stop-ViewerOne
  Start-Process -FilePath $electron -ArgumentList '.','--lighting-analyze' -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $electronOut -RedirectStandardError $electronErr -WindowStyle Normal
  Write-NightLog 'launched ViewerOne --lighting-analyze'
}

function Get-AnalyzeLogTailTime {
  if (-not (Test-Path -LiteralPath $analyzeLog)) { return $null }
  $item = Get-Item -LiteralPath $analyzeLog
  return $item.LastWriteTime
}

function Test-ViewerOneAlive {
  $mains = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -match '\\ViewerOne\\' -and $_.CommandLine -notmatch '--type=' }
  return [bool]$mains
}

New-Item -ItemType Directory -Path (Join-Path $env:APPDATA 'viewer-one') -Force | Out-Null
Write-NightLog 'overnight lighting analyze supervisor start'
Write-Status @{ phase = 'starting'; relaunches = 0; ready = 0; total = 0 }

$relaunch = 0
Start-Analyze

while ($true) {
  [void][SleepUtil]::SetThreadExecutionState($KeepAwake)
  Start-Sleep -Seconds 45

  $info = $null
  try { $info = Get-Readiness } catch { Write-NightLog "readiness failed: $_"; continue }

  $missingTitles = @()
  if ($info.missing) { $missingTitles = @($info.missing | ForEach-Object { "PC$($_.program) $($_.title)" }) }
  Write-Status @{
    phase = 'running'
    ready = [int]$info.ready
    total = [int]$info.total
    need = [int]$info.need
    missing = $missingTitles
    relaunches = $relaunch
    viewerOneAlive = (Test-ViewerOneAlive)
  }
  Write-NightLog "ready $($info.ready)/$($info.total) alive=$(Test-ViewerOneAlive)"

  if ([int]$info.total -gt 0 -and [int]$info.ready -ge [int]$info.total) {
    Write-NightLog 'ALL ARRANGER SONGS READY'
    Write-Status @{ phase = 'complete'; ready = [int]$info.ready; total = [int]$info.total; need = 0; missing = @() }
    [void][SleepUtil]::SetThreadExecutionState($ClearAwake)
    exit 0
  }

  $alive = Test-ViewerOneAlive
  $logTime = Get-AnalyzeLogTailTime
  $stalled = $false
  if ($logTime -and ((Get-Date) - $logTime).TotalMinutes -gt $StallMinutes) { $stalled = $true }
  if (-not $logTime -and $alive) {
    # electron up but analyze log never written — wait for first 8 min after launch
    $stalled = $false
  }

  if (-not $alive -or $stalled) {
    if ($relaunch -ge $MaxRelaunches) {
      Write-NightLog "giving up after $relaunch relaunches (alive=$alive stalled=$stalled)"
      Write-Status @{ phase = 'stopped'; reason = 'max relaunches'; ready = [int]$info.ready; total = [int]$info.total; need = [int]$info.need; missing = $missingTitles }
      [void][SleepUtil]::SetThreadExecutionState($ClearAwake)
      exit 2
    }
    $relaunch++
    Write-NightLog "self-heal relaunch $relaunch (alive=$alive stalled=$stalled)"
    Start-Analyze
  }
}
