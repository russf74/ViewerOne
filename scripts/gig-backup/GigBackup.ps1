#Requires -Version 5.1
<#
.SYNOPSIS
  Copy this gig rig to a USB hard drive, or apply that snapshot on the backup PC.

.PARAMETER Mode
  Copy  - run on the main PC (also works if you double-click COPY-TO-BACKUP.cmd on the USB)
  Apply - run on the backup PC from the USB drive
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Copy', 'Apply')]
  [string]$Mode,

  [string]$Drive,

  [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ToolDir = $PSScriptRoot
$RememberFile = Join-Path $env:APPDATA 'viewer-one\gig-backup-drive.txt'
$ViewerOneSrc = Join-Path $env:USERPROFILE 'ViewerOne'
$CubaseExe = 'C:\Program Files\Steinberg\Cubase 15\Cubase15.exe'
$LoopMidiX86 = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Tobias Erichsen\loopMIDI\loopMIDI.exe'
$LoopMidi64 = Join-Path $env:ProgramFiles 'Tobias Erichsen\loopMIDI\loopMIDI.exe'
$script:CopyJob = @{ Active = $false }

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  if ($script:CopyJob -and $script:CopyJob.Active) { return }
  Write-Host "    $Message" -ForegroundColor Green
}
function Write-Warn([string]$Message) {
  if ($script:CopyJob -and $script:CopyJob.Active) { return }
  Write-Host "    $Message" -ForegroundColor Yellow
}
function Write-Info([string]$Message) {
  if ($script:CopyJob -and $script:CopyJob.Active) { return }
  Write-Host "    $Message"
}

function Format-Bytes([long]$Bytes) {
  if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
  if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
  if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
  return "$Bytes B"
}

function Format-Duration([double]$Seconds) {
  if ($Seconds -lt 0 -or $Seconds -gt 864000) { return '--:--' }
  $ts = [TimeSpan]::FromSeconds([Math]::Max(0, [int]$Seconds))
  if ($ts.TotalHours -ge 1) { return '{0:h\:mm\:ss}' -f $ts }
  return '{0:mm\:ss}' -f $ts
}

function Format-CopyHudPath([string]$Path, [int]$MaxLen) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  $show = $Path.Trim()
  if ($show.Length -le $MaxLen) { return $show }
  return ('...' + $show.Substring($show.Length - ($MaxLen - 3)))
}

function ConvertTo-RobocopyArgLine([string[]]$Parts) {
  $bits = foreach ($p in $Parts) {
    if ($null -eq $p -or $p -eq '') { continue }
    if ($p -match '[\s"]') { '"{0}"' -f ($p -replace '"', '""') } else { $p }
  }
  return ($bits -join ' ')
}

function Enable-ConsoleVt {
  if ($script:VtTried) { return [bool]$script:VtEnabled }
  $script:VtTried = $true
  $script:VtEnabled = $false
  try {
    if (-not ('GigBackupNativeConsole' -as [type])) {
      Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class GigBackupNativeConsole {
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out int m);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, int m);
}
"@
    }
    $h = [GigBackupNativeConsole]::GetStdHandle(-11)
    $mode = 0
    if ([GigBackupNativeConsole]::GetConsoleMode($h, [ref]$mode)) {
      $script:VtEnabled = [GigBackupNativeConsole]::SetConsoleMode($h, ($mode -bor 4))
    }
  } catch {
    $script:VtEnabled = $false
  }
  return [bool]$script:VtEnabled
}

function Get-HudWidth {
  $width = 79
  try {
    $buf = [Console]::BufferWidth
    $win = [Console]::WindowWidth
    $width = [Math]::Min($buf, $win)
  } catch {
    try { $width = $Host.UI.RawUI.WindowSize.Width } catch { }
  }
  return [Math]::Max(48, $width - 1)
}

function Get-DriveFreeBytes([string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Root)) { return [long]-1 }
  $id = ([IO.Path]::GetPathRoot($Root))
  if ([string]::IsNullOrWhiteSpace($id)) { return [long]-1 }
  $id = $id.TrimEnd('\').ToUpperInvariant()
  if ($id -notmatch '^[A-Z]:$') { return [long]-1 }
  try {
    $d = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$id'" -ErrorAction Stop
    if ($null -ne $d -and $null -ne $d.FreeSpace) { return [long]$d.FreeSpace }
  } catch { }
  try { return [long]([IO.DriveInfo]::new($id)).AvailableFreeSpace } catch { }
  return [long]-1
}

function ConvertFrom-RobocopyProgressLine([string]$Line) {
  if ([string]::IsNullOrWhiteSpace($Line)) { return $null }
  if ($Line -notmatch '(?i)New File|Newer|Older|\bsame\b') { return $null }
  if ($Line -match '(?i)^\s+(New File|Newer|Older|same)\s+([\d,]+)\s+(.*\S)\s*$') {
    $size = [long]0
    [void][long]::TryParse(($Matches[2] -replace ',', ''), [ref]$size)
    return @{ Kind = $Matches[1]; Size = $size; Name = $Matches[3].Trim() }
  }
  return $null
}

$script:CopyHud = @{ Drawn = $false; Lines = 5; Top = 0 }
$script:VtTried = $false
$script:VtEnabled = $false

function Reset-CopyHud {
  $script:CopyHud.Drawn = $false
  $script:CopyHud.Top = 0
}

function Format-HudBar([int]$Percent, [int]$Width) {
  if ($Percent -lt 0) { $Percent = 0 }
  if ($Percent -gt 100) { $Percent = 100 }
  $filled = [int][Math]::Round($Width * $Percent / 100.0)
  if ($filled -gt $Width) { $filled = $Width }
  if ($filled -lt 0) { $filled = 0 }
  return (('#' * $filled) + ('-' * ($Width - $filled)))
}

function Get-HudPercent([long]$Done, [long]$Total, [bool]$Finished) {
  if ($Finished -and $Total -gt 0) { return 100 }
  if ($Total -le 0) { return 0 }
  $pct = [int][Math]::Floor(100.0 * $Done / $Total)
  if ($pct -gt 99) { return 99 }
  if ($pct -lt 0) { return 0 }
  return $pct
}

function New-CopyJobItem([string]$Name, [long]$Files, [long]$Bytes) {
  return [pscustomobject]@{ Name = $Name; Files = [long]$Files; Bytes = [long]$Bytes }
}

function Start-CopyJob {
  param(
    [Parameter(Mandatory = $true)][object[]]$Items,
    [datetime]$StartedAt,
    [string]$DriveRoot = ''
  )
  $files = [long]0
  $bytes = [long]0
  foreach ($i in @($Items)) {
    $files += [long]$i.Files
    $bytes += [long]$i.Bytes
  }
  $startFree = Get-DriveFreeBytes $DriveRoot
  $script:CopyJob = @{
    Active         = $true
    StartedAt      = $StartedAt
    DriveRoot      = $DriveRoot
    StartFree      = $startFree
    ItemStartFree  = $startFree
    Items          = @($Items)
    ItemCount      = @($Items).Count
    ItemIndex      = 0
    ItemName       = ''
    ItemFiles      = [long]0
    ItemBytes      = [long]0
    CurrentFile    = ''
    TotalFiles     = $files
    TotalBytes     = $bytes
  }
  Reset-CopyHud
  try { [Console]::CursorVisible = $false } catch { }
}

function Enter-CopyJobItem {
  param([string]$Name, [long]$Files = 0, [long]$Bytes = 0)
  if (-not $script:CopyJob.Active) { return }
  $script:CopyJob.ItemIndex++
  $script:CopyJob.ItemName = $Name
  $script:CopyJob.ItemFiles = [long]$Files
  $script:CopyJob.ItemBytes = [long]$Bytes
  $script:CopyJob.CurrentFile = ''
  if ($script:CopyJob.DriveRoot) {
    $script:CopyJob.ItemStartFree = Get-DriveFreeBytes $script:CopyJob.DriveRoot
  }
}

function Complete-CopyJobItem {
  param([long]$Files, [long]$Bytes)
}

function Invoke-TinyJobItem {
  param(
    [string]$Name,
    [long]$Files,
    [long]$Bytes,
    [string]$File,
    [scriptblock]$Action
  )
  Enter-CopyJobItem $Name $Files $Bytes
  $t = $script:CopyJob.StartedAt
  Write-CopyHud -FilesDone 0 -FilesTotal $Files -BytesDone 0 -BytesTotal $Bytes -File $File -StartedAt $t
  $null = & $Action
  Write-CopyHud -FilesDone $Files -FilesTotal $Files -BytesDone $Bytes -BytesTotal $Bytes -File $File -StartedAt $t -Done
  Complete-CopyJobItem $Files $Bytes
}

function Release-CopyHud {
  $script:CopyJob.Active = $false
  try {
    if ($script:CopyHud.Drawn) {
      [Console]::SetCursorPosition(0, [int]$script:CopyHud.Top + [int]$script:CopyHud.Lines)
    }
  } catch { }
  try { [Console]::CursorVisible = $true } catch { }
  Write-Host ""
}

function Complete-CopyJob {
  if (-not $script:CopyJob.Active) { return }
  $script:CopyJob.ItemName = 'complete'
  Write-CopyHud -File '' -StartedAt $script:CopyJob.StartedAt -Done
  Release-CopyHud
}

function Write-CopyHud {
  param(
    [long]$FilesDone = 0,
    [long]$FilesTotal = 0,
    [long]$BytesDone = 0,
    [long]$BytesTotal = 0,
    [string]$File = '',
    [datetime]$StartedAt = [datetime]::MinValue,
    [switch]$Done
  )

  $jobOn = [bool]$script:CopyJob.Active
  $overStart = $StartedAt
  if ($jobOn) { $overStart = $script:CopyJob.StartedAt }
  if ($overStart -eq [datetime]::MinValue) { $overStart = Get-Date }

  $overBytesTotal = $BytesTotal
  $itemBytesTotal = $BytesTotal
  $itemName = 'copy'
  $itemN = 1
  $itemOf = 1
  $overBytesDone = $BytesDone
  $itemBytesDone = $BytesDone

  if ($jobOn) {
    $overBytesTotal = [long]$script:CopyJob.TotalBytes
    $itemBytesTotal = [long]$script:CopyJob.ItemBytes
    $itemName = [string]$script:CopyJob.ItemName
    $itemN = [int]$script:CopyJob.ItemIndex
    $itemOf = [int]$script:CopyJob.ItemCount
    $startFree = [long]$script:CopyJob.StartFree
    $itemStartFree = [long]$script:CopyJob.ItemStartFree
    if ($startFree -ge 0 -and $script:CopyJob.DriveRoot) {
      $free = Get-DriveFreeBytes $script:CopyJob.DriveRoot
      if ($free -ge 0) {
        $overBytesDone = [Math]::Max([long]0, $startFree - $free)
        $itemBytesDone = [Math]::Max([long]0, $itemStartFree - $free)
      }
    }
    if ([string]::IsNullOrWhiteSpace($File)) { $File = [string]$script:CopyJob.CurrentFile }
  }

  $jobFinished = [bool]$Done -and ((-not $jobOn) -or ($itemN -ge $itemOf))
  if ($jobFinished -and $overBytesTotal -gt 0) { $overBytesDone = $overBytesTotal }
  if ($Done -and $itemBytesTotal -gt 0) { $itemBytesDone = $itemBytesTotal }
  if ($overBytesTotal -gt 0 -and $overBytesDone -gt $overBytesTotal) { $overBytesDone = $overBytesTotal }
  if ($itemBytesTotal -gt 0 -and $itemBytesDone -gt $itemBytesTotal) { $itemBytesDone = $itemBytesTotal }

  $elapsed = ((Get-Date) - $overStart).TotalSeconds
  $overPct = Get-HudPercent $overBytesDone $overBytesTotal $jobFinished
  $itemPct = Get-HudPercent $itemBytesDone $itemBytesTotal ([bool]$Done)

  $speed = 0.0
  if ($elapsed -gt 0.5) { $speed = $overBytesDone / $elapsed }
  $mbps = $speed / 1MB
  if ($elapsed -lt 1 -and -not $jobFinished) { $speedText = '...' }
  elseif ($mbps -ge 100) { $speedText = '{0:N0} MB/s' -f $mbps }
  elseif ($mbps -ge 10) { $speedText = '{0:N1} MB/s' -f $mbps }
  else { $speedText = '{0:N2} MB/s' -f $mbps }

  $leftBytes = [Math]::Max([long]0, $overBytesTotal - $overBytesDone)
  $etaText = '--:--'
  if ($jobFinished) { $etaText = 'done' }
  elseif ($overBytesTotal -gt 0 -and $leftBytes -le 0) { $etaText = 'finishing...' }
  elseif ($overBytesTotal -gt 0 -and $speed -gt 50KB -and $leftBytes -gt 0) {
    $etaText = Format-Duration ($leftBytes / $speed)
  }

  $width = Get-HudWidth
  $fileLabel = if ($Done -or $jobFinished) { '' } else { Format-CopyHudPath $File ([Math]::Max(16, $width - 12)) }
  $overBytesText = if ($overBytesTotal -gt 0) { '{0} / {1}' -f (Format-Bytes $overBytesDone), (Format-Bytes $overBytesTotal) } else { Format-Bytes $overBytesDone }
  $itemBytesText = if ($itemBytesTotal -gt 0) { '{0} / {1}' -f (Format-Bytes $itemBytesDone), (Format-Bytes $itemBytesTotal) } else { Format-Bytes $itemBytesDone }
  $leftText = if ($jobFinished) { '' } else { '{0} left' -f (Format-Bytes $leftBytes) }

  $itemLine = '{0}/{1}  {2}' -f $itemN, $itemOf, $itemName
  if ($jobOn -and -not $jobFinished -and $itemN -lt $itemOf) {
    try {
      $rest = New-Object System.Collections.Generic.List[string]
      $items = @($script:CopyJob.Items)
      for ($k = $itemN; $k -lt $itemOf -and $k -lt $items.Count; $k++) {
        $rest.Add([string]$items[$k].Name)
      }
      if ($rest.Count -gt 0) { $itemLine = '{0}  then {1}' -f $itemLine, ($rest -join ', ') }
    } catch { }
  }

  $raw = @(
    ('    OVERALL [{0}] {1,3}%   {2}' -f (Format-HudBar $overPct 22), $overPct, $overBytesText),
    ('            {0}   {1}   {2} elapsed   ETA {3}' -f $leftText, $speedText, (Format-Duration $elapsed), $etaText),
    ('    {0}' -f $itemLine),
    ('            [{0}] {1,3}%   {2}' -f (Format-HudBar $itemPct 22), $itemPct, $itemBytesText),
    ('    file: {0}' -f $fileLabel)
  )

  $padded = foreach ($ln in $raw) {
    if ($ln.Length -gt $width) { $ln.Substring(0, $width) } else { $ln.PadRight($width) }
  }
  $n = $padded.Count
  $script:CopyHud.Lines = $n

  try {
    if (-not $script:CopyHud.Drawn) {
      $script:CopyHud.Top = [Console]::CursorTop
      $script:CopyHud.Drawn = $true
    }
    $top = [int]$script:CopyHud.Top
    for ($i = 0; $i -lt $n; $i++) {
      [Console]::SetCursorPosition(0, $top + $i)
      [Console]::Write($padded[$i])
    }
    [Console]::SetCursorPosition(0, $top + $n)
  } catch { }
}


function Confirm-Go([string]$Prompt) {
  if ($Yes) { return $true }
  Write-Host ""
  $answer = Read-Host "$Prompt [Y/n]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $true }
  return $answer -match '^[Yy]'
}

function Test-RobocopyOk([int]$Code) {
  return ($Code -ge 0 -and $Code -le 7)
}

function Get-FolderInventory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$ExcludeTop = @(),
    [string[]]$ExcludeFile = @()
  )
  $bytes = [long]0
  $files = [long]0
  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{ Bytes = [long]0; Files = [long]0 }
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) {
    return [pscustomobject]@{ Bytes = [long]$item.Length; Files = [long]1 }
  }

  $root = $item.FullName.TrimEnd('\')
  $excludeSet = @{}
  foreach ($e in @($ExcludeTop)) {
    if ($e) { $excludeSet[$e] = $true }
  }
  $fileWildcards = @($ExcludeFile | Where-Object { $_ })

  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    try {
      foreach ($sub in [IO.Directory]::EnumerateDirectories($dir)) {
        $name = [IO.Path]::GetFileName($sub)
        if ($excludeSet.ContainsKey($name)) { continue }
        $stack.Push($sub)
      }
    } catch { }
    try {
      foreach ($fp in [IO.Directory]::EnumerateFiles($dir)) {
        $name = [IO.Path]::GetFileName($fp)
        $skip = $false
        foreach ($w in $fileWildcards) {
          if ($name -like $w) { $skip = $true; break }
        }
        if ($skip) { continue }
        try {
          $bytes += [IO.FileInfo]::new($fp).Length
          $files++
        } catch { }
      }
    } catch { }
  }
  return [pscustomobject]@{ Bytes = [long]$bytes; Files = [long]$files }
}

function Invoke-RoboCopy {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Dest,
    [string[]]$ExcludeDir = @(),
    [string[]]$ExcludeFile = @(),
    [switch]$Mirror,
    [long]$ExpectedBytes = 0,
    [long]$ExpectedFiles = 0
  )
  if (-not (Test-Path -LiteralPath $Source)) {
    if ($script:CopyJob.Active) {
      Complete-CopyJobItem -Files $script:CopyJob.ItemFiles -Bytes $script:CopyJob.ItemBytes
    } else {
      Write-Warn "Missing source -- skipped: $Source"
    }
    return
  }
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null

  if ($ExpectedBytes -le 0 -or $ExpectedFiles -le 0) {
    Write-Info 'Scanning...'
    $inv = Get-FolderInventory -Path $Source -ExcludeTop $ExcludeDir -ExcludeFile $ExcludeFile
    if ($ExpectedBytes -le 0) { $ExpectedBytes = [long]$inv.Bytes }
    if ($ExpectedFiles -le 0) { $ExpectedFiles = [long]$inv.Files }
  }

  $roboArgs = @($Source, $Dest, '/E', '/R:2', '/W:2', '/FFT', '/MT:4', '/BYTES', '/NDL', '/NP', '/NJH', '/NJS')
  if ($Mirror) { $roboArgs = @($Source, $Dest, '/MIR', '/R:2', '/W:2', '/FFT', '/MT:4', '/BYTES', '/NDL', '/NP', '/NJH', '/NJS') }
  foreach ($d in $ExcludeDir) {
    if ($d) { $roboArgs += @('/XD', $d) }
  }
  foreach ($f in $ExcludeFile) {
    if ($f) { $roboArgs += @('/XF', $f) }
  }

  $argLine = ConvertTo-RobocopyArgLine $roboArgs
  $proc = $null
  $pump = $null
  $watcher = $null
  $subs = @()
  $cursorWasVisible = $true
  $startedAt = Get-Date
  $code = -1
  $queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
  $filesDone = [long]0
  $bytesDone = [long]0
  $currentFile = ''
  $jobOn = [bool]$script:CopyJob.Active
  if (-not $jobOn) { Reset-CopyHud }

  try {
    try {
      if (-not $jobOn) {
        $cursorWasVisible = [Console]::CursorVisible
        [Console]::CursorVisible = $false
      }
    } catch { }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'robocopy.exe'
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [Console]::OutputEncoding

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    try {
      $watcher = New-Object System.IO.FileSystemWatcher
      $watcher.Path = $Dest
      $watcher.Filter = '*'
      $watcher.IncludeSubdirectories = $true
      $watcher.NotifyFilter = [IO.NotifyFilters]::FileName -bor [IO.NotifyFilters]::LastWrite -bor [IO.NotifyFilters]::Size
      $watcher.InternalBufferSize = 64KB
      $onFile = {
        $job = $Event.MessageData
        if ($job -and $job['Active']) { $job['CurrentFile'] = $Event.SourceEventArgs.FullPath }
      }
      $target = $script:CopyJob
      $subs += Register-ObjectEvent -InputObject $watcher -EventName Created -Action $onFile -MessageData $target
      $subs += Register-ObjectEvent -InputObject $watcher -EventName Changed -Action $onFile -MessageData $target
      $watcher.EnableRaisingEvents = $true
    } catch {
      $watcher = $null
    }

    $rs = [runspacefactory]::CreateRunspace()
    $rs.Open()
    $rs.SessionStateProxy.SetVariable('stdoutReader', $proc.StandardOutput)
    $rs.SessionStateProxy.SetVariable('queue', $queue)
    $pshell = [powershell]::Create()
    $pshell.Runspace = $rs
    [void]$pshell.AddScript({
      try {
        while ($null -ne ($line = $stdoutReader.ReadLine())) {
          $queue.Enqueue($line)
        }
      } catch { }
    })

    $rsErr = [runspacefactory]::CreateRunspace()
    $rsErr.Open()
    $rsErr.SessionStateProxy.SetVariable('stderrReader', $proc.StandardError)
    $errShell = [powershell]::Create()
    $errShell.Runspace = $rsErr
    [void]$errShell.AddScript({
      try {
        while ($null -ne ($line = $stderrReader.ReadLine())) { }
      } catch { }
    })
    $pump = @{
      Shell = $pshell
      Handle = $pshell.BeginInvoke()
      Runspace = $rs
      ErrShell = $errShell
      ErrHandle = $errShell.BeginInvoke()
      ErrRunspace = $rsErr
    }

    do {
      $row = ''
      while ($queue.TryDequeue([ref]$row)) {
        $parsed = ConvertFrom-RobocopyProgressLine $row
        if ($null -eq $parsed) { continue }
        $filesDone++
        $bytesDone += [long]$parsed.Size
        $currentFile = [string]$parsed.Name
        if ($jobOn) { $script:CopyJob.CurrentFile = $currentFile }
      }

      Write-CopyHud -FilesDone $filesDone -FilesTotal $ExpectedFiles -BytesDone $bytesDone -BytesTotal $ExpectedBytes -File $currentFile -StartedAt $startedAt
      Start-Sleep -Milliseconds 400
    } while (-not $proc.HasExited)

    $row = ''
    while ($queue.TryDequeue([ref]$row)) {
      $parsed = ConvertFrom-RobocopyProgressLine $row
      if ($null -eq $parsed) { continue }
      $filesDone++
      $bytesDone += [long]$parsed.Size
      $currentFile = [string]$parsed.Name
    }

    $proc.WaitForExit()
    $code = $proc.ExitCode
    Write-CopyHud -FilesDone $filesDone -FilesTotal $ExpectedFiles -BytesDone $bytesDone -BytesTotal $ExpectedBytes -File $currentFile -StartedAt $startedAt -Done
  } finally {
    if ($null -ne $proc) {
      try {
        if (-not $proc.HasExited) {
          $proc.Kill()
          $proc.WaitForExit()
        }
      } catch { }
      try { $proc.Dispose() } catch { }
    }
    if ($null -ne $pump) {
      try { [void]$pump.Shell.EndInvoke($pump.Handle) } catch { }
      try { $pump.Shell.Dispose() } catch { }
      try { $pump.Runspace.Close(); $pump.Runspace.Dispose() } catch { }
      try { [void]$pump.ErrShell.EndInvoke($pump.ErrHandle) } catch { }
      try { $pump.ErrShell.Dispose() } catch { }
      try { $pump.ErrRunspace.Close(); $pump.ErrRunspace.Dispose() } catch { }
    }
    try { if (-not $jobOn) { [Console]::CursorVisible = $cursorWasVisible } } catch { }
    foreach ($s in @($subs)) {
      try { Unregister-Event -SourceIdentifier $s.Name -Force -ErrorAction SilentlyContinue } catch { }
      try { Remove-Job -Id $s.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    if ($null -ne $watcher) {
      try { $watcher.EnableRaisingEvents = $false; $watcher.Dispose() } catch { }
    }
  }

  if (-not (Test-RobocopyOk $code)) {
    throw "robocopy failed with exit code $code (`"$Source`" -> `"$Dest`")"
  }
  if ($jobOn) {
    Complete-CopyJobItem -Files $ExpectedFiles -Bytes $ExpectedBytes
  } else {
    Write-Ok ("done in {0}  ({1:N0} files, {2})" -f (Format-Duration ((Get-Date) - $startedAt).TotalSeconds), $filesDone, (Format-Bytes $bytesDone))
  }
}

function Get-CandidateDrives {
  Get-CimInstance Win32_LogicalDisk | Where-Object {
    $_.DeviceID -ne 'C:' -and
    $null -ne $_.Size -and
    $_.Size -gt 8GB -and
    $null -ne $_.FreeSpace
  } | Sort-Object DeviceID
}

function Save-RememberedDrive([string]$RootPath) {
  $dir = Split-Path $RememberFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -LiteralPath $RememberFile -Value $RootPath -Encoding ASCII
}

function Get-RememberedDrive {
  if (Test-Path -LiteralPath $RememberFile) {
    $raw = (Get-Content -LiteralPath $RememberFile -TotalCount 1).Trim()
    if ($raw -and (Test-Path -LiteralPath $raw)) { return $raw }
  }
  return $null
}

function Resolve-UsbGigRoot {
  $scriptDrive = ([System.IO.Path]::GetPathRoot($ToolDir)).TrimEnd('\')

  if ($scriptDrive -and $scriptDrive -ne 'C:') {
    if ((Split-Path $ToolDir -Leaf) -eq 'GigBackup') { return $ToolDir }
    $nested = Join-Path $ToolDir 'GigBackup'
    if (Test-Path -LiteralPath (Join-Path $nested 'GigBackup.ps1')) { return $nested }
    return (Join-Path "$scriptDrive\" 'GigBackup')
  }

  if ($Drive) {
    $letter = $Drive.Trim().TrimEnd(':').TrimEnd('\').ToUpperInvariant()
    if ($letter.Length -ne 1) { throw "Drive must be a letter, e.g. -Drive E" }
    $root = "${letter}:\GigBackup"
    if (-not (Test-Path "${letter}:\")) { throw "Drive ${letter}: is not available" }
    return $root
  }

  $remembered = Get-RememberedDrive
  $candidates = @(Get-CandidateDrives)

  if ($remembered) {
    $remDrive = ([System.IO.Path]::GetPathRoot($remembered)).TrimEnd('\')
    $still = $candidates | Where-Object { $_.DeviceID -eq $remDrive }
    if ($still) { return $remembered }
  }

  if ($candidates.Count -eq 0) {
    throw "No USB / extra drive found (C: is ignored). Plug in the backup hard drive and try again."
  }

  Write-Host ""
  Write-Host "Drives that can hold the gig backup:" -ForegroundColor Cyan
  foreach ($d in $candidates) {
    $label = $d.VolumeName
    if ([string]::IsNullOrWhiteSpace($label)) { $label = '(no label)' }
    Write-Host ("  {0}  {1,-16}  {2} free of {3}" -f $d.DeviceID, $label, (Format-Bytes ([long]$d.FreeSpace)), (Format-Bytes ([long]$d.Size)))
  }

  if ($candidates.Count -eq 1) {
    $pick = $candidates[0].DeviceID
    Write-Ok "Using $pick automatically"
    return (Join-Path $pick 'GigBackup')
  }

  $typed = Read-Host "Enter drive letter for the USB hard drive"
  $letter = $typed.Trim().TrimEnd(':').TrimEnd('\').ToUpperInvariant()
  $match = $candidates | Where-Object { $_.DeviceID -eq "${letter}:" }
  if (-not $match) { throw "Drive ${letter}: is not in the list above" }
  return (Join-Path "${letter}:" 'GigBackup')
}

function Get-RecentCprFolders {
  $folders = New-Object System.Collections.Generic.List[string]
  $sh = New-Object -ComObject WScript.Shell
  $recent = Join-Path $env:APPDATA 'Microsoft\Windows\Recent'
  if (-not (Test-Path $recent)) { return @() }
  Get-ChildItem -LiteralPath $recent -Filter '*cpr*' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $lnk = $sh.CreateShortcut($_.FullName)
      $target = $lnk.TargetPath
      if ($target -and (Test-Path -LiteralPath $target)) {
        $folders.Add((Split-Path $target))
      }
    } catch { }
  }
  return @($folders | Select-Object -Unique)
}

function Get-CubaseProjectRoot {
  $known = Join-Path $env:USERPROFILE 'Dropbox\My PC (LFRAY-PC)\Documents\Cubase'
  if (Test-Path -LiteralPath $known) { return $known }

  $docs = Join-Path $env:USERPROFILE 'Documents\Cubase'
  if (Test-Path -LiteralPath $docs) { return $docs }

  foreach ($folder in (Get-RecentCprFolders)) {
    $parent = Split-Path $folder
    if ((Split-Path $parent -Leaf) -eq 'Cubase' -and (Test-Path -LiteralPath $parent)) {
      return $parent
    }
  }

  $dropbox = Join-Path $env:USERPROFILE 'Dropbox'
  if (Test-Path -LiteralPath $dropbox) {
    $hit = Get-ChildItem -LiteralPath $dropbox -Directory -Filter '80s-00s' -Recurse -Depth 6 -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { return $hit.Parent.FullName }
  }
  return $null
}

function Get-LoopMidiExe {
  if (Test-Path -LiteralPath $LoopMidi64) { return $LoopMidi64 }
  if (Test-Path -LiteralPath $LoopMidiX86) { return $LoopMidiX86 }
  return $null
}

function Test-ProcessNamed([string]$ImageName) {
  return [bool](Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ImageName)) -ErrorAction SilentlyContinue)
}

function Test-ViewerOneRunning {
  $procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue
  foreach ($p in @($procs)) {
    if ($p.CommandLine -and ($p.CommandLine.ToLowerInvariant() -like '*\viewerone\*')) { return $true }
  }
  return $false
}

function Wait-GigAppsClosed([string]$Reason) {
  $busy = @()
  if (Test-ProcessNamed 'Cubase15.exe') { $busy += 'Cubase' }
  if (Test-ViewerOneRunning) { $busy += 'ViewerOne' }
  if (Test-ProcessNamed 'X32-Edit.exe') { $busy += 'X32-Edit' }
  if ($busy.Count -eq 0) { return }
  Write-Warn "$Reason"
  Write-Warn ("Currently running: " + ($busy -join ', '))
  Write-Host "    Close those apps, then press Enter to continue (or Ctrl+C to abort)."
  if (-not $Yes) { [void](Read-Host) }
}

function Test-SamePath([string]$Left, [string]$Right) {
  try {
    $a = [IO.Path]::GetFullPath($Left).TrimEnd('\').ToLowerInvariant()
    $b = [IO.Path]::GetFullPath($Right).TrimEnd('\').ToLowerInvariant()
    return ($a -eq $b)
  } catch {
    return $false
  }
}

function Deploy-Tooling([string]$UsbRoot) {
  New-Item -ItemType Directory -Path $UsbRoot -Force | Out-Null
  if (-not (Test-SamePath $ToolDir $UsbRoot)) {
    Copy-Item -LiteralPath (Join-Path $ToolDir 'GigBackup.ps1') -Destination (Join-Path $UsbRoot 'GigBackup.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $ToolDir 'COPY-TO-BACKUP.cmd') -Destination (Join-Path $UsbRoot 'COPY-TO-BACKUP.cmd') -Force
    Copy-Item -LiteralPath (Join-Path $ToolDir 'APPLY-ON-BACKUP-PC.cmd') -Destination (Join-Path $UsbRoot 'APPLY-ON-BACKUP-PC.cmd') -Force
    Copy-Item -LiteralPath (Join-Path $ToolDir 'README.txt') -Destination (Join-Path $UsbRoot 'README.txt') -Force
  }

  $driveRoot = [System.IO.Path]::GetPathRoot($UsbRoot)
  Copy-Item -LiteralPath (Join-Path $ToolDir 'COPY-TO-BACKUP.cmd') -Destination (Join-Path $driveRoot 'COPY-TO-BACKUP.cmd') -Force
  Copy-Item -LiteralPath (Join-Path $ToolDir 'APPLY-ON-BACKUP-PC.cmd') -Destination (Join-Path $driveRoot 'APPLY-ON-BACKUP-PC.cmd') -Force
  Copy-Item -LiteralPath (Join-Path $ToolDir 'README.txt') -Destination (Join-Path $driveRoot 'README.txt') -Force
}

function New-Shortcut {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Target,
    [string]$Arguments = '',
    [string]$WorkDir = '',
    [string]$Description = ''
  )
  $w = New-Object -ComObject WScript.Shell
  $lnk = $w.CreateShortcut($Path)
  $lnk.TargetPath = $Target
  $lnk.Arguments = $Arguments
  if ($WorkDir) { $lnk.WorkingDirectory = $WorkDir }
  if ($Description) { $lnk.Description = $Description }
  $lnk.Save()
}

function Install-CopyShortcut {
  $cmd = Join-Path $ViewerOneSrc 'scripts\gig-backup\COPY-TO-BACKUP.cmd'
  if (-not (Test-Path -LiteralPath $cmd)) { return }
  $dest = Join-Path $env:USERPROFILE 'Desktop\Copy to Gig Backup.lnk'
  New-Shortcut -Path $dest -Target $cmd -WorkDir (Split-Path $cmd) -Description 'Copy Cubase + ViewerOne + settings to the USB gig drive'
  Write-Ok "Desktop shortcut: $dest"
}

function Install-ViewerOneShortcut {
  $ps1 = Join-Path $ViewerOneSrc 'scripts\install-viewerone-shortcut.ps1'
  if (Test-Path -LiteralPath $ps1) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $ps1
    return
  }
  $vbs = Join-Path $env:USERPROFILE 'ViewerOne\ViewerOne-Launch.vbs'
  if (-not (Test-Path -LiteralPath $vbs)) { return }
  $dest = Join-Path $env:USERPROFILE 'Desktop\ViewerOne.lnk'
  New-Shortcut -Path $dest -Target "$env:SystemRoot\System32\wscript.exe" -Arguments "`"$vbs`"" -WorkDir (Split-Path $vbs) -Description 'ViewerOne'
  Write-Ok "Desktop shortcut: $dest"
}

function Install-GigStartupTask([string]$ViewerOneDir) {
  $rawUrl = 'https://raw.githubusercontent.com/russf74/ViewerOne/cursor/sound-to-light-director-433b/scripts/remote-bootstrap.ps1'
  $arg = "-NoProfile -ExecutionPolicy Bypass -Command ""& { `$p=`$env:TEMP+'\vo-boot.ps1'; (New-Object Net.WebClient).DownloadFile('$rawUrl', `$p); & `$p -RepoRoot '$ViewerOneDir' -Mode Logon }"""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $ViewerOneDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Delay = 'PT45S'
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'ViewerOne Gig Startup' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Sync ViewerOne v6 + start gig apps after logon' -Force | Out-Null
  Write-Ok 'Scheduled task: ViewerOne Gig Startup (network bootstrap at logon + 45s)'
}

function Export-LoopMidiReg([string]$DestFile) {
  $dir = Split-Path $DestFile
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  & reg.exe export "HKCU\Software\Tobias Erichsen\loopMIDI" $DestFile /y 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $DestFile)) {
    Write-Warn "loopMIDI registry export failed (is loopMIDI installed?)"
    return $false
  }
  Write-Ok "loopMIDI ports exported"
  return $true
}

function Import-LoopMidiReg([string]$RegFile) {
  if (-not (Test-Path -LiteralPath $RegFile)) {
    Write-Warn "No loopMIDI.reg in this backup"
    return
  }
  $p = Start-Process -FilePath 'reg.exe' -ArgumentList @('import', $RegFile) -Wait -WindowStyle Hidden -PassThru
  if ($p.ExitCode -ne 0) {
    Write-Warn "loopMIDI registry import failed"
    return
  }
  Write-Ok "loopMIDI ports imported (CubaseToViewerOne / ViewerOneToCubase)"
  $exe = Get-LoopMidiExe
  if (-not $exe) {
    Write-Warn "loopMIDI is not installed on this PC. Install it, then run APPLY again (or start loopMIDI once so the ports appear)."
    return
  }
  Get-Process -Name 'loopMIDI' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-Process -FilePath $exe | Out-Null
  Write-Ok "loopMIDI restarted so the cables load"
}

# --- Copy (main PC -> USB) ---
function Invoke-Copy {
  $usbRoot = Resolve-UsbGigRoot
  $payload = Join-Path $usbRoot 'Payload'
  $driveRoot = [System.IO.Path]::GetPathRoot($usbRoot)
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($driveRoot.TrimEnd('\'))'"

  Write-Step "Gig backup destination"
  Write-Info "USB folder: $usbRoot"
  if ($disk) {
    Write-Info ("Drive {0}  {1} free of {2}" -f $disk.DeviceID, (Format-Bytes ([long]$disk.FreeSpace)), (Format-Bytes ([long]$disk.Size)))
  }

  if (-not (Test-Path -LiteralPath $ViewerOneSrc)) {
    throw "ViewerOne not found at $ViewerOneSrc"
  }

  $cubaseRoot = Get-CubaseProjectRoot
  $voExclude = @('.git', 'release', '_ref', '.tmp-cubase-ocr', '.tmp-scan-qa', '.pio', '.cursor')
  $prefsExcludeDir = @('Cubase Pro VST3 Cache')
  $prefsExcludeFile = @('ApplicationStarted.txt', 'AppColorHint.txt', 'Cubase Pro Module Cache.xml')
  $prefsSrc = Join-Path $env:APPDATA 'Steinberg\Cubase 15_64'
  $cfgSrc = Join-Path $env:APPDATA 'viewer-one\viewer-one-config.json'
  $scanSrc = Join-Path $env:APPDATA 'viewer-one\last-arranger-scan.txt'
  $x32Exe = Join-Path $env:USERPROFILE 'Desktop\Apps\X32-Edit.exe'
  $x32App = Join-Path $env:APPDATA 'X32-Edit'

  Write-Step "Scanning"
  $voInv = Get-FolderInventory -Path $ViewerOneSrc -ExcludeTop $voExclude -ExcludeFile @('*.log')
  $cubaseInv = [pscustomobject]@{ Bytes = [long]0; Files = [long]0 }
  if ($cubaseRoot) { $cubaseInv = Get-FolderInventory -Path $cubaseRoot }
  $prefsInv = Get-FolderInventory -Path $prefsSrc -ExcludeTop $prefsExcludeDir -ExcludeFile $prefsExcludeFile
  $cfgFiles = [long]0
  $cfgBytes = [long]0
  foreach ($p in @($cfgSrc, $scanSrc)) {
    if (Test-Path -LiteralPath $p) {
      $cfgFiles++
      $cfgBytes += [long](Get-Item -LiteralPath $p -Force).Length
    }
  }
  $x32Inv = [pscustomobject]@{ Bytes = [long]0; Files = [long]0 }
  $x32Files = [long]0
  $x32Bytes = [long]0
  if (Test-Path -LiteralPath $x32Exe) {
    $x32Files++
    $x32Bytes += [long](Get-Item -LiteralPath $x32Exe -Force).Length
  }
  if (Test-Path -LiteralPath $x32App) {
    $x32Inv = Get-FolderInventory -Path $x32App
    $x32Files += [long]$x32Inv.Files
    $x32Bytes += [long]$x32Inv.Bytes
  }

  $jobItems = New-Object System.Collections.Generic.List[object]
  $jobItems.Add((New-CopyJobItem 'ViewerOne' $voInv.Files $voInv.Bytes))
  $jobItems.Add((New-CopyJobItem 'ViewerOne config' $cfgFiles $cfgBytes))
  $jobItems.Add((New-CopyJobItem 'loopMIDI' 1 2048))
  if ($cubaseRoot) { $jobItems.Add((New-CopyJobItem 'Cubase projects' $cubaseInv.Files $cubaseInv.Bytes)) }
  $jobItems.Add((New-CopyJobItem 'Cubase settings' $prefsInv.Files $prefsInv.Bytes))
  $jobItems.Add((New-CopyJobItem 'Startup' 3 8192))
  if ($x32Files -gt 0) { $jobItems.Add((New-CopyJobItem 'X32-Edit' $x32Files $x32Bytes)) }
  $estimate = [long]0
  $estimateFiles = [long]0
  foreach ($it in $jobItems) {
    $estimate += [long]$it.Bytes
    $estimateFiles += [long]$it.Files
  }

  Write-Step "What will be copied"
  Write-Info ("ViewerOne         {0,8:N0} files   {1}" -f $voInv.Files, (Format-Bytes $voInv.Bytes))
  if ($cubaseRoot) {
    Write-Info ("Cubase projects   {0,8:N0} files   {1}" -f $cubaseInv.Files, (Format-Bytes $cubaseInv.Bytes))
  } else {
    Write-Warn "Cubase project folder not found -- skipped"
  }
  Write-Info ("Cubase settings   {0,8:N0} files   {1}" -f $prefsInv.Files, (Format-Bytes $prefsInv.Bytes))
  Write-Info ("Other (config, loopMIDI, startup, X32)")
  Write-Info ("Total             {0,8:N0} files   {1}" -f $estimateFiles, (Format-Bytes $estimate))

  if ($disk -and [long]$disk.FreeSpace -lt $estimate) {
    Write-Warn ("Drive only has {0} free -- copy may fail if the estimate is close." -f (Format-Bytes ([long]$disk.FreeSpace)))
  }

  Wait-GigAppsClosed "For a clean copy, close Cubase / ViewerOne if they have unsaved work."

  if (-not (Confirm-Go "Copy everything to $usbRoot now?")) {
    Write-Warn "Cancelled."
    return
  }

  $started = Get-Date
  New-Item -ItemType Directory -Path (Join-Path $usbRoot 'logs') -Force | Out-Null
  Deploy-Tooling $usbRoot

  Write-Step "Copying"
  Start-CopyJob -Items @($jobItems.ToArray()) -StartedAt $started -DriveRoot $driveRoot

  Enter-CopyJobItem 'ViewerOne' $voInv.Files $voInv.Bytes
  $null = Invoke-RoboCopy -Source $ViewerOneSrc -Dest (Join-Path $payload 'ViewerOne') -Mirror -ExcludeDir $voExclude -ExcludeFile @('*.log') -ExpectedBytes $voInv.Bytes -ExpectedFiles $voInv.Files

  Invoke-TinyJobItem 'ViewerOne config' $cfgFiles $cfgBytes 'viewer-one-config.json' {
    $cfgDir = Join-Path $payload 'ViewerOne-Config'
    New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null
    if (Test-Path -LiteralPath $cfgSrc) {
      Copy-Item -LiteralPath $cfgSrc -Destination (Join-Path $cfgDir 'viewer-one-config.json') -Force
    }
    if (Test-Path -LiteralPath $scanSrc) {
      Copy-Item -LiteralPath $scanSrc -Destination (Join-Path $cfgDir 'last-arranger-scan.txt') -Force
    }
  }

  Invoke-TinyJobItem 'loopMIDI' 1 2048 'loopMIDI.reg' {
    [void](Export-LoopMidiReg (Join-Path $payload 'loopMIDI\loopMIDI.reg'))
  }

  $projectMap = @()
  if ($cubaseRoot) {
    Enter-CopyJobItem 'Cubase projects' $cubaseInv.Files $cubaseInv.Bytes
    $null = Invoke-RoboCopy -Source $cubaseRoot -Dest (Join-Path $payload 'Cubase-Projects') -Mirror -ExpectedBytes $cubaseInv.Bytes -ExpectedFiles $cubaseInv.Files
    $projectMap = @(
      Get-ChildItem -LiteralPath $cubaseRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{ name = $_.Name; originalPath = $_.FullName }
      }
    )
  }

  Enter-CopyJobItem 'Cubase settings' $prefsInv.Files $prefsInv.Bytes
  $null = Invoke-RoboCopy -Source $prefsSrc -Dest (Join-Path $payload 'Cubase-Settings') -Mirror -ExcludeDir $prefsExcludeDir -ExcludeFile $prefsExcludeFile -ExpectedBytes $prefsInv.Bytes -ExpectedFiles $prefsInv.Files

  Invoke-TinyJobItem 'Startup' 3 8192 'start-gig-apps.vbs' {
    $startupDir = Join-Path $payload 'Startup'
    New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $ViewerOneSrc 'scripts\start-gig-apps.vbs') -Destination (Join-Path $startupDir 'start-gig-apps.vbs') -Force
    Copy-Item -LiteralPath (Join-Path $ViewerOneSrc 'scripts\start-gig-apps.cmd') -Destination (Join-Path $startupDir 'start-gig-apps.cmd') -Force
    try {
      $xml = Export-ScheduledTask -TaskName 'ViewerOne Gig Startup' -ErrorAction Stop
      Set-Content -LiteralPath (Join-Path $startupDir 'ViewerOne-Gig-Startup.xml') -Value $xml -Encoding Unicode
    } catch { }
  }

  if ($x32Files -gt 0) {
    Enter-CopyJobItem 'X32-Edit' $x32Files $x32Bytes
    $x32Dir = Join-Path $payload 'X32-Edit'
    New-Item -ItemType Directory -Path $x32Dir -Force | Out-Null
    if (Test-Path -LiteralPath $x32Exe) {
      Copy-Item -LiteralPath $x32Exe -Destination (Join-Path $x32Dir 'X32-Edit.exe') -Force
    }
    if (Test-Path -LiteralPath $x32App) {
      $null = Invoke-RoboCopy -Source $x32App -Dest (Join-Path $x32Dir 'AppData') -Mirror -ExpectedBytes $x32Inv.Bytes -ExpectedFiles $x32Inv.Files
    } else {
      Write-CopyHud -FilesDone $x32Files -FilesTotal $x32Files -BytesDone $x32Bytes -BytesTotal $x32Bytes -File 'X32-Edit.exe' -StartedAt $script:CopyJob.StartedAt -Done
      Complete-CopyJobItem $x32Files $x32Bytes
    }
  }

  Complete-CopyJob

  $loopMidiReg = Join-Path $payload 'loopMIDI\loopMIDI.reg'
  if (-not (Test-Path -LiteralPath $loopMidiReg)) {
    [void](Export-LoopMidiReg $loopMidiReg)
  }

  $ended = Get-Date
  $secs = [int][Math]::Round(($ended - $started).TotalSeconds)
  $manifest = [ordered]@{
    copiedAt          = $ended.ToString('o')
    sourceComputer    = $env:COMPUTERNAME
    sourceUser        = $env:USERNAME
    sourceUserProfile = $env:USERPROFILE
    viewerOnePath     = $ViewerOneSrc
    cubaseProjectRoot = [string]$cubaseRoot
    cubaseProjects    = @($projectMap)
    durationSeconds   = $secs
    usbRoot           = $usbRoot
  }
  try {
    $json = ConvertTo-Json -InputObject ([pscustomobject]$manifest) -Depth 6
    Set-Content -LiteralPath (Join-Path $usbRoot 'manifest.json') -Value $json -Encoding UTF8
  } catch {
    Write-Warn "Could not write manifest.json: $($_.Exception.Message)"
  }

  $summary = @(
    "Gig backup copied: $($ended.ToString('yyyy-MM-dd HH:mm'))"
    "From: $env:COMPUTERNAME / $env:USERNAME"
    "USB:  $usbRoot"
    "ViewerOne: $ViewerOneSrc"
    "Cubase projects: $cubaseRoot"
    "Took: $secs seconds"
    ""
    "On the backup PC, plug this drive in and double-click APPLY-ON-BACKUP-PC.cmd"
  ) -join [Environment]::NewLine
  Set-Content -LiteralPath (Join-Path $usbRoot 'LAST-COPY.txt') -Value $summary -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $driveRoot 'LAST-COPY.txt') -Value $summary -Encoding UTF8

  Save-RememberedDrive $usbRoot
  Install-CopyShortcut

  Write-Host "========================================" -ForegroundColor Green
  Write-Host "  COPY FINISHED" -ForegroundColor Green
  Write-Host "========================================" -ForegroundColor Green
  Write-Ok $summary.Replace([Environment]::NewLine, " | ")
  Write-Host ""
  Write-Host "On the backup PC: plug this drive in and double-click  APPLY-ON-BACKUP-PC.cmd" -ForegroundColor Green
}

function Get-ManifestValue([object]$Man, [string]$Name) {
  if ($null -eq $Man) { return $null }
  $prop = $Man.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}
function Invoke-Apply {
  $usbRoot = $null
  $scriptDrive = ([System.IO.Path]::GetPathRoot($ToolDir)).TrimEnd('\')
  if ($scriptDrive -and $scriptDrive -ne 'C:') {
    if ((Split-Path $ToolDir -Leaf) -eq 'GigBackup') { $usbRoot = $ToolDir }
    elseif (Test-Path (Join-Path $ToolDir 'Payload')) { $usbRoot = $ToolDir }
  }
  if (-not $usbRoot) { $usbRoot = Resolve-UsbGigRoot }

  $payload = Join-Path $usbRoot 'Payload'
  $manifestPath = Join-Path $usbRoot 'manifest.json'
  if (-not (Test-Path -LiteralPath $payload)) {
    throw "No Payload folder on this drive. Run COPY-TO-BACKUP.cmd on the main PC first. Looked in $usbRoot"
  }

  Write-Step "Gig backup source"
  Write-Info "USB folder: $usbRoot"
  $man = $null
  if (Test-Path -LiteralPath $manifestPath) {
    $man = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Write-Info ("Snapshot: {0}  from {1}\{2}" -f (Get-ManifestValue $man 'copiedAt'), (Get-ManifestValue $man 'sourceComputer'), (Get-ManifestValue $man 'sourceUser'))
    Write-Info ("Cubase projects were at: {0}" -f (Get-ManifestValue $man 'cubaseProjectRoot'))
  } else {
    Write-Warn "No manifest.json -- applying whatever is in Payload\"
  }

  $voDest = Join-Path $env:USERPROFILE 'ViewerOne'
  $cubaseDest = Join-Path $env:USERPROFILE 'Documents\Cubase'
  $srcProfile = [string](Get-ManifestValue $man 'sourceUserProfile')
  $origCubase = [string](Get-ManifestValue $man 'cubaseProjectRoot')
  if ($srcProfile -and ($srcProfile -eq $env:USERPROFILE) -and $origCubase) {
    $cubaseDest = $origCubase
    Write-Info "Same Windows user as the main PC -- restoring Cubase projects to the original path so audio links keep working."
  } else {
    Write-Warn "Restoring Cubase projects to $cubaseDest"
    Write-Warn "If Cubase reports missing audio, point it at that folder (Media > Find Missing Files)."
  }

  Write-Step "This PC will be updated"
  Write-Info "ViewerOne -> $voDest"
  Write-Info "Cubase projects -> $cubaseDest"
  Write-Info 'Cubase settings -> AppData\Steinberg\Cubase 15_64'
  Write-Info 'ViewerOne config -> AppData\viewer-one'
  Write-Info 'loopMIDI ports, X32-Edit, logon startup task'

  if (-not (Test-Path -LiteralPath $CubaseExe)) {
    Write-Warn "Cubase 15 is not installed at the usual path. Projects/settings will still be copied."
  }
  if (-not (Get-LoopMidiExe)) {
    Write-Warn "loopMIDI is not installed yet. Settings will be imported; install loopMIDI so the cables appear."
  }

  Wait-GigAppsClosed "Close Cubase, ViewerOne, and X32-Edit before updating this PC."

  if (-not (Confirm-Go "Update this backup PC from the USB now?")) {
    Write-Warn "Cancelled."
    return
  }

  $voSrc = Join-Path $payload 'ViewerOne'
  $projSrc = Join-Path $payload 'Cubase-Projects'
  $prefsSrc = Join-Path $payload 'Cubase-Settings'
  $prefsDest = Join-Path $env:APPDATA 'Steinberg\Cubase 15_64'
  $cfgSrc = Join-Path $payload 'ViewerOne-Config\viewer-one-config.json'
  $scanSrc = Join-Path $payload 'ViewerOne-Config\last-arranger-scan.txt'
  $x32ExeSrc = Join-Path $payload 'X32-Edit\X32-Edit.exe'
  $x32AppSrc = Join-Path $payload 'X32-Edit\AppData'
  $voExcludeApply = @('.git', 'release', '_ref', '.tmp-cubase-ocr', '.tmp-scan-qa', '.pio')

  Write-Step "Scanning"
  $voInv = Get-FolderInventory -Path $voSrc -ExcludeTop $voExcludeApply
  $cubaseInv = [pscustomobject]@{ Bytes = [long]0; Files = [long]0 }
  if (Test-Path -LiteralPath $projSrc) { $cubaseInv = Get-FolderInventory -Path $projSrc }
  $prefsInv = [pscustomobject]@{ Bytes = [long]0; Files = [long]0 }
  if (Test-Path -LiteralPath $prefsSrc) { $prefsInv = Get-FolderInventory -Path $prefsSrc }
  $cfgFiles = [long]0
  $cfgBytes = [long]0
  foreach ($p in @($cfgSrc, $scanSrc)) {
    if (Test-Path -LiteralPath $p) {
      $cfgFiles++
      $cfgBytes += [long](Get-Item -LiteralPath $p -Force).Length
    }
  }
  $x32Inv = [pscustomobject]@{ Bytes = [long]0; Files = [long]0 }
  $x32Files = [long]0
  $x32Bytes = [long]0
  if (Test-Path -LiteralPath $x32ExeSrc) {
    $x32Files++
    $x32Bytes += [long](Get-Item -LiteralPath $x32ExeSrc -Force).Length
  }
  if (Test-Path -LiteralPath $x32AppSrc) {
    $x32Inv = Get-FolderInventory -Path $x32AppSrc
    $x32Files += [long]$x32Inv.Files
    $x32Bytes += [long]$x32Inv.Bytes
  }

  $jobItems = New-Object System.Collections.Generic.List[object]
  $jobItems.Add((New-CopyJobItem 'ViewerOne' $voInv.Files $voInv.Bytes))
  $jobItems.Add((New-CopyJobItem 'ViewerOne config' $cfgFiles $cfgBytes))
  $jobItems.Add((New-CopyJobItem 'loopMIDI' 1 2048))
  if (Test-Path -LiteralPath $projSrc) { $jobItems.Add((New-CopyJobItem 'Cubase projects' $cubaseInv.Files $cubaseInv.Bytes)) }
  if (Test-Path -LiteralPath $prefsSrc) { $jobItems.Add((New-CopyJobItem 'Cubase settings' $prefsInv.Files $prefsInv.Bytes)) }
  if ($x32Files -gt 0) { $jobItems.Add((New-CopyJobItem 'X32-Edit' $x32Files $x32Bytes)) }
  $jobItems.Add((New-CopyJobItem 'Startup' 1 1024))

  Write-Step "Updating"
  Start-CopyJob -Items @($jobItems.ToArray()) -StartedAt (Get-Date) -DriveRoot ([IO.Path]::GetPathRoot($voDest))

  Enter-CopyJobItem 'ViewerOne' $voInv.Files $voInv.Bytes
  $null = Invoke-RoboCopy -Source $voSrc -Dest $voDest -ExcludeDir $voExcludeApply -ExpectedBytes $voInv.Bytes -ExpectedFiles $voInv.Files

  Invoke-TinyJobItem 'ViewerOne config' $cfgFiles $cfgBytes 'viewer-one-config.json' {
    $cfgDestDir = Join-Path $env:APPDATA 'viewer-one'
    New-Item -ItemType Directory -Path $cfgDestDir -Force | Out-Null
    if (Test-Path -LiteralPath $cfgSrc) {
      Copy-Item -LiteralPath $cfgSrc -Destination (Join-Path $cfgDestDir 'viewer-one-config.json') -Force
      $repoBackup = Join-Path $voDest 'backup\viewer-one-config.json'
      New-Item -ItemType Directory -Path (Split-Path $repoBackup) -Force | Out-Null
      Copy-Item -LiteralPath $cfgSrc -Destination $repoBackup -Force
    }
    if (Test-Path -LiteralPath $scanSrc) {
      Copy-Item -LiteralPath $scanSrc -Destination (Join-Path $cfgDestDir 'last-arranger-scan.txt') -Force
    }
  }

  Invoke-TinyJobItem 'loopMIDI' 1 2048 'loopMIDI.reg' {
    Import-LoopMidiReg (Join-Path $payload 'loopMIDI\loopMIDI.reg')
  }

  if (Test-Path -LiteralPath $projSrc) {
    Enter-CopyJobItem 'Cubase projects' $cubaseInv.Files $cubaseInv.Bytes
    $null = Invoke-RoboCopy -Source $projSrc -Dest $cubaseDest -ExpectedBytes $cubaseInv.Bytes -ExpectedFiles $cubaseInv.Files
  }

  if (Test-Path -LiteralPath $prefsSrc) {
    Enter-CopyJobItem 'Cubase settings' $prefsInv.Files $prefsInv.Bytes
    $null = Invoke-RoboCopy -Source $prefsSrc -Dest $prefsDest -ExpectedBytes $prefsInv.Bytes -ExpectedFiles $prefsInv.Files
  }

  if ($x32Files -gt 0) {
    Enter-CopyJobItem 'X32-Edit' $x32Files $x32Bytes
    $x32ExeDestDir = Join-Path $env:USERPROFILE 'Desktop\Apps'
    if (Test-Path -LiteralPath $x32ExeSrc) {
      New-Item -ItemType Directory -Path $x32ExeDestDir -Force | Out-Null
      Copy-Item -LiteralPath $x32ExeSrc -Destination (Join-Path $x32ExeDestDir 'X32-Edit.exe') -Force
    }
    if (Test-Path -LiteralPath $x32AppSrc) {
      $null = Invoke-RoboCopy -Source $x32AppSrc -Dest (Join-Path $env:APPDATA 'X32-Edit') -ExpectedBytes $x32Inv.Bytes -ExpectedFiles $x32Inv.Files
    } else {
      Write-CopyHud -FilesDone $x32Files -FilesTotal $x32Files -BytesDone $x32Bytes -BytesTotal $x32Bytes -File 'X32-Edit.exe' -StartedAt $script:CopyJob.StartedAt -Done
      Complete-CopyJobItem $x32Files $x32Bytes
    }
  }

  Invoke-TinyJobItem 'Startup' 1 1024 'scheduled task' {
    Install-GigStartupTask $voDest
    Install-ViewerOneShortcut
  }

  Complete-CopyJob

  $electron = Join-Path $voDest 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron)) {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
      Write-Warn "Electron runtime missing. Running npm install (needs internet)..."
      Push-Location $voDest
      try {
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { Write-Warn "npm install failed -- install Node.js LTS and run npm install in $voDest" }
      } finally {
        Pop-Location
      }
    } else {
      Write-Warn "Electron runtime missing and npm is not installed. Install Node.js LTS, then run npm install in $voDest"
    }
  }
  $outMain = Join-Path $voDest 'out\main\index.js'
  if (-not (Test-Path -LiteralPath $outMain) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Info "Building ViewerOne..."
    Push-Location $voDest
    try { & npm.cmd run build } finally { Pop-Location }
  }

  if (Test-Path -LiteralPath (Join-Path $cubaseDest '80s-00s')) {
    $latest = Get-ChildItem -LiteralPath (Join-Path $cubaseDest '80s-00s') -Filter '*.cpr' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($latest) { Write-Ok ("Open this in Cubase: {0}" -f $latest.FullName) }
  }
  if (Test-Path -LiteralPath $prefsSrc) {
    Write-Warn "If the backup PC's audio interface differs, re-select it in Cubase Studio Setup. MIDI ports should match after loopMIDI import."
  }

  Write-Step "Apply finished"
  Write-Ok "Backup PC updated from $usbRoot"
  Write-Host ""
  Write-Host "Quick check before the gig:" -ForegroundColor Green
  Write-Host "  1. loopMIDI shows CubaseToViewerOne and ViewerOneToCubase"
  Write-Host "  2. Open the latest 80s-00s .cpr in Cubase (see path above)"
  Write-Host "  3. Launch ViewerOne from the desktop shortcut"
  Write-Host '  4. Confirm MIDI: CubaseToViewerOne <-> ViewerOneToCubase'
}

try {
  Write-Host "ViewerOne gig backup  ($Mode)" -ForegroundColor Cyan
  if ($Mode -eq 'Copy') { Invoke-Copy } else { Invoke-Apply }
} catch {
  Release-CopyHud
  Write-Host "========================================" -ForegroundColor Red
  Write-Host "  FAILED" -ForegroundColor Red
  Write-Host "========================================" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
