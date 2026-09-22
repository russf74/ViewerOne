#Requires -Version 5.1
# Full autonomous rescan: keep the PC awake, run ViewerOne --rescan-all
# (fresh Cubase lengths, then recapture + lighting/DMX). Resume with
# --lighting-analyze if the first pass dies after the scan.
param(
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'ViewerOne'),
  [int]$MaxRelaunches = 10,
  [int]$StallMinutes = 20
)

$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:APPDATA 'viewer-one'
$log = Join-Path $dataDir 'full-rescan.log'
$statusPath = Join-Path $dataDir 'full-rescan-status.json'
$analyzeLog = Join-Path $dataDir 'lighting-analyze.log'
$electronOut = Join-Path $dataDir 'full-rescan-electron.out.log'
$electronErr = Join-Path $dataDir 'full-rescan-electron.err.log'
$electron = Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe'

function Write-RescanLog([string]$msg) {
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
public static class SleepUtilRescan {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
$KeepAwake = [Convert]::ToUInt32('80000003', 16)
$ClearAwake = [Convert]::ToUInt32('80000000', 16)
[void][SleepUtilRescan]::SetThreadExecutionState($KeepAwake)

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
  const listed = String(r.length || '').split(':');
  const listedSec = listed.length === 2 ? Number(listed[0]) * 60 + Number(listed[1]) : 0;
  const analyzedSec = r.audioAnalysis && r.audioAnalysis.durationMs ? r.audioAnalysis.durationMs / 1000 : 0;
  const durOk = listedSec < 5 || analyzedSec <= 0 || analyzedSec <= listedSec * 1.25 + 2;
  const capturedAt = r.cubaseRenderCapturedAt ? Date.parse(r.cubaseRenderCapturedAt) : 0;
  const fresh = capturedAt >= Number(process.env.RESCAN_AFTER_MS || 0);
  const ok = r.lightingProgram && r.lightingProgram.cues && r.lightingProgram.cues.length && r.audioAnalysis && r.audioAnalysis.bpm && durOk && fresh;
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
  Start-Sleep -Seconds 3
}

function Test-ViewerOneAlive {
  $mains = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.CommandLine -match '\\ViewerOne\\' -and $_.CommandLine -notmatch '--type=' }
  return [bool]$mains
}

function Get-AnalyzeLogTailTime {
  if (-not (Test-Path -LiteralPath $analyzeLog)) { return $null }
  return (Get-Item -LiteralPath $analyzeLog).LastWriteTime
}

function Start-Rescan([string]$mode) {
  if (-not (Test-Path -LiteralPath $electron)) { throw "electron.exe missing: $electron" }
  Stop-ViewerOne
  $args = if ($mode -eq 'analyze') { @('.', '--lighting-analyze') } else { @('.', '--rescan-all') }
  Start-Process -FilePath $electron -ArgumentList $args -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $electronOut -RedirectStandardError $electronErr -WindowStyle Normal
  Write-RescanLog "launched ViewerOne $($args -join ' ')"
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$env:RESCAN_AFTER_MS = [string][DateTimeOffset]::Now.ToUnixTimeMilliseconds()
Write-RescanLog 'full rescan supervisor start'
Write-Status @{ phase = 'starting'; relaunches = 0; ready = 0; total = 0; mode = 'rescan-all' }

$relaunch = 0
$mode = 'rescan-all'
$scanSeen = $false
Start-Rescan $mode

while ($true) {
  [void][SleepUtilRescan]::SetThreadExecutionState($KeepAwake)
  Start-Sleep -Seconds 40

  $outText = ''
  if (Test-Path -LiteralPath $electronOut) { $outText = Get-Content -LiteralPath $electronOut -Raw -ErrorAction SilentlyContinue }
  if (-not $scanSeen -and $outText -match '--rescan-all scan:|--scan-arranger done:') {
    $scanSeen = $true
    $mode = 'analyze'
    Write-RescanLog 'scan finished — further relaunches will be lighting-analyze only'
    Write-Status @{ phase = 'analyzing'; relaunches = $relaunch; mode = $mode }
  }

  $info = $null
  try { $info = Get-Readiness } catch { Write-RescanLog "readiness failed: $_"; continue }

  $missingTitles = @()
  if ($info.missing) { $missingTitles = @($info.missing | ForEach-Object { "PC$($_.program) $($_.title)" }) }
  Write-Status @{
    phase = $(if ($scanSeen) { 'analyzing' } else { 'scanning' })
    ready = [int]$info.ready
    total = [int]$info.total
    need = [int]$info.need
    missing = $missingTitles
    relaunches = $relaunch
    mode = $mode
    viewerOneAlive = (Test-ViewerOneAlive)
  }
  Write-RescanLog "ready $($info.ready)/$($info.total) scanSeen=$scanSeen alive=$(Test-ViewerOneAlive)"

  if ([int]$info.total -gt 0 -and [int]$info.ready -ge [int]$info.total) {
    Write-RescanLog 'ALL ARRANGER SONGS RESCANNED'
    Write-Status @{ phase = 'complete'; ready = [int]$info.ready; total = [int]$info.total; need = 0; missing = @() }
    [void][SleepUtilRescan]::SetThreadExecutionState($ClearAwake)
    exit 0
  }

  $alive = Test-ViewerOneAlive
  $logTime = Get-AnalyzeLogTailTime
  $stalled = $false
  if ($scanSeen -and $logTime -and ((Get-Date) - $logTime).TotalMinutes -gt $StallMinutes) { $stalled = $true }

  if (-not $alive -or $stalled) {
    if ($relaunch -ge $MaxRelaunches) {
      Write-RescanLog "giving up after $relaunch relaunches (alive=$alive stalled=$stalled)"
      Write-Status @{ phase = 'stopped'; reason = 'max relaunches'; ready = [int]$info.ready; total = [int]$info.total; need = [int]$info.need; missing = $missingTitles }
      [void][SleepUtilRescan]::SetThreadExecutionState($ClearAwake)
      exit 2
    }
    $relaunch++
    if ($scanSeen) { $mode = 'analyze' }
    Write-RescanLog "self-heal relaunch $relaunch mode=$mode (alive=$alive stalled=$stalled)"
    Start-Rescan $mode
  }
}
