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

  [ValidateSet('Full', 'Incremental')]
  [string]$Kind,

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

function Get-UserDocumentsPath {
  try {
    $p = [Environment]::GetFolderPath('MyDocuments')
    if (-not [string]::IsNullOrWhiteSpace($p)) { return $p }
  } catch { }
  return (Join-Path $env:USERPROFILE 'Documents')
}

function Resolve-CopyKind {
  if ($Kind -eq 'Full' -or $Kind -eq 'Incremental') { return $Kind }
  Write-Host ""
  Write-Host "How should this backup run?" -ForegroundColor Cyan
  Write-Host "  1  Full wipe and backup"
  Write-Host "     Erase the USB drive, then copy every file. Nothing is skipped."
  Write-Host "  2  Incremental"
  Write-Host "     Update the existing backup. Caches and old debug dumps are skipped."
  $answer = Read-Host "Choose 1 or 2"
  if ($answer.Trim() -eq '1') { return 'Full' }
  if ($answer.Trim() -eq '2') { return 'Incremental' }
  throw "Choose 1 for a full wipe, or 2 for incremental."
}

function Clear-UsbVolume([string]$DriveRoot) {
  $root = [System.IO.Path]::GetPathRoot($DriveRoot)
  if ([string]::IsNullOrWhiteSpace($root)) { throw "No drive to wipe" }
  $letter = $root.TrimEnd('\')
  if ($letter -eq 'C:' -or $letter -eq $env:SystemDrive) {
    throw "Refusing to wipe the Windows drive ($letter)."
  }
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$letter'"
  if (-not $disk -or [long]$disk.Size -lt 8GB) { throw "Refusing to wipe $letter" }
  Write-Step "Full wipe of $letter"
  $label = $disk.VolumeName
  if ([string]::IsNullOrWhiteSpace($label)) { $label = '(no label)' }
  Write-Info ("{0}  {1}  {2}" -f $letter, $label, (Format-Bytes ([long]$disk.Size)))
  Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -eq 'System Volume Information') { return }
    Write-Info ("Removing {0}" -f $_.Name)
    if ($_.PSIsContainer) {
      & cmd.exe /c "rd /s /q `"$($_.FullName)`"" | Out-Null
    }
    if (Test-Path -LiteralPath $_.FullName) {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $left = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'System Volume Information' })
  if ($left.Count -gt 0) {
    Write-Warn ("Still on the drive: " + (($left | ForEach-Object { $_.Name }) -join ', '))
  } else {
    Write-Ok "Drive $letter is clear"
  }
}

function Get-SettingsTreeDefs([bool]$Full) {
  $docs = Get-UserDocumentsPath
  $steinbergFile = @()
  $voAppDir = @()
  # Activation Manager holds this PC's licence. It will not work on the backup laptop.
  $steinbergDir = @('Activation Manager')
  if (-not $Full) {
    $steinbergDir += 'Cubase Pro VST3 Cache'
    $steinbergFile = @('ApplicationStarted.txt', 'AppColorHint.txt', 'Cubase Pro Module Cache.xml')
    $voAppDir = @('Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'blob_storage', 'Session Storage', 'Shared Dictionary', 'Network', 'tmp-sc-probe')
    $voAppRoot = Join-Path $env:APPDATA 'viewer-one'
    if (Test-Path -LiteralPath $voAppRoot) {
      Get-ChildItem -LiteralPath $voAppRoot -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Name -like 'captures-backup-*' -or $_.Name -like 'mono-captures-*') { $voAppDir += $_.Name }
      }
    }
  }
  $loopLive = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Tobias Erichsen\loopMIDI'
  $loopApply = $loopLive
  return @(
    [pscustomobject]@{
      Name = 'ViewerOne data'; Live = (Join-Path $env:APPDATA 'viewer-one'); Rel = 'ViewerOne-AppData'
      Apply = (Join-Path $env:APPDATA 'viewer-one'); ExDir = $voAppDir; ExFile = @()
    }
    [pscustomobject]@{
      Name = 'Steinberg settings'; Live = (Join-Path $env:APPDATA 'Steinberg'); Rel = 'Steinberg-AppData'
      Apply = (Join-Path $env:APPDATA 'Steinberg'); ExDir = $steinbergDir; ExFile = $steinbergFile
    }
    [pscustomobject]@{
      Name = 'Steinberg documents'; Live = (Join-Path $docs 'Steinberg'); Rel = 'Steinberg-Documents'
      Apply = (Join-Path $docs 'Steinberg'); ExDir = @(); ExFile = @()
    }
    [pscustomobject]@{
      Name = 'Steinberg local'; Live = (Join-Path $env:LOCALAPPDATA 'Steinberg'); Rel = 'Steinberg-Local'
      Apply = (Join-Path $env:LOCALAPPDATA 'Steinberg'); ExDir = @(); ExFile = @()
    }
    [pscustomobject]@{
      Name = 'Steinberg content'; Live = (Join-Path $env:PROGRAMDATA 'Steinberg'); Rel = 'Steinberg-ProgramData'
      Apply = (Join-Path $env:PROGRAMDATA 'Steinberg'); ExDir = @(); ExFile = @()
    }
    [pscustomobject]@{
      Name = 'Native Instruments'; Live = (Join-Path $env:APPDATA 'Native Instruments'); Rel = 'NativeInstruments-AppData'
      Apply = (Join-Path $env:APPDATA 'Native Instruments'); ExDir = @(); ExFile = @()
    }
    [pscustomobject]@{
      Name = 'loopMIDI app'; Live = $loopLive; Rel = 'loopMIDI\App'
      Apply = $loopApply; ExDir = @(); ExFile = @()
    }
  )
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

function Get-RelativeUnder([string]$Full, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Full) -or [string]::IsNullOrWhiteSpace($Root)) { return $null }
  try {
    $fullN = [IO.Path]::GetFullPath($Full).TrimEnd('\')
    $rootN = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($fullN.Length -le $rootN.Length) { return $null }
    if (-not $fullN.StartsWith($rootN, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $next = $fullN[$rootN.Length]
    if ($next -ne '\' -and $next -ne '/') { return $null }
    return $fullN.Substring($rootN.Length).TrimStart('\', '/')
  } catch {
    return $null
  }
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $prin = New-Object Security.Principal.WindowsPrincipal($id)
  return $prin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-IsReparsePoint([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  } catch {
    return $false
  }
}

function Get-JunctionTarget([string]$Path) {
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $prop = $item.PSObject.Properties['Target']
    if ($null -eq $prop -or $null -eq $prop.Value) { return $null }
    $t = $prop.Value
    if ($t -is [array]) {
      if (@($t).Count -gt 0) { return [string]$t[0] }
      return $null
    }
    return [string]$t
  } catch {
    return $null
  }
}

function Test-IsWindowsUserProfile([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $false }
  return (Test-Path -LiteralPath (Join-Path $Path 'NTUSER.DAT'))
}

function Test-ProfileResolvesHere([string]$SrcProfile) {
  if ([string]::IsNullOrWhiteSpace($SrcProfile)) { return $false }
  if (Test-SamePath $SrcProfile $env:USERPROFILE) { return $true }
  if ((Test-Path -LiteralPath $SrcProfile) -and (Test-IsReparsePoint $SrcProfile)) {
    $tgt = Get-JunctionTarget $SrcProfile
    if ($tgt -and (Test-SamePath $tgt $env:USERPROFILE)) { return $true }
  }
  return $false
}

function Invoke-MklinkJunction([string]$Link, [string]$Target, [switch]$Elevated) {
  $arg = '/c mklink /J "' + $Link + '" "' + $Target + '"'
  $p = $null
  if ($Elevated) {
    $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -Verb RunAs -ArgumentList $arg -Wait -PassThru
  } else {
    $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList $arg -Wait -WindowStyle Hidden -PassThru
  }
  return ($null -ne $p -and $p.ExitCode -eq 0 -and (Test-Path -LiteralPath $Link))
}

function Remove-JunctionOnly([string]$Link) {
  # rmdir without /s removes the link itself and leaves the folder it pointed at.
  & cmd.exe /c "rmdir `"$Link`"" | Out-Null
  return -not (Test-Path -LiteralPath $Link)
}

function New-DirectoryJunction([string]$Link, [string]$Target, [switch]$Replace) {
  if ([string]::IsNullOrWhiteSpace($Link) -or [string]::IsNullOrWhiteSpace($Target)) { return $false }
  $linkFull = [IO.Path]::GetFullPath($Link)
  $targetFull = [IO.Path]::GetFullPath($Target)
  if (Test-SamePath $linkFull $targetFull) { return $true }
  if (-not (Test-Path -LiteralPath $targetFull)) {
    New-Item -ItemType Directory -Path $targetFull -Force | Out-Null
  }
  if (Test-Path -LiteralPath $linkFull) {
    if (Test-IsReparsePoint $linkFull) {
      $cur = Get-JunctionTarget $linkFull
      if ($cur -and (Test-SamePath $cur $targetFull)) {
        Write-Ok ("Already linked: {0} -> {1}" -f $linkFull, $targetFull)
        return $true
      }
      if (-not $Replace) {
        Write-Warn ("A folder link already exists at {0} (target: {1})" -f $linkFull, $cur)
        return $false
      }
      Write-Info ("Replacing old link at {0} (was {1})" -f $linkFull, $cur)
      if (-not (Remove-JunctionOnly $linkFull)) {
        Write-Warn "Could not remove the old folder link at $linkFull"
        return $false
      }
    } else {
      $kids = @(Get-ChildItem -LiteralPath $linkFull -Force -ErrorAction SilentlyContinue)
      if (-not $Replace -or $kids.Count -gt 0) {
        Write-Warn "Cannot create folder link; $linkFull already exists"
        return $false
      }
      Remove-Item -LiteralPath $linkFull -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $linkFull) {
        Write-Warn "Cannot create folder link; $linkFull already exists"
        return $false
      }
    }
  }
  $parent = Split-Path -Parent $linkFull
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if (Invoke-MklinkJunction $linkFull $targetFull) {
    Write-Ok ("Linked {0} -> {1}" -f $linkFull, $targetFull)
    return $true
  }
  if (-not (Test-IsAdmin)) {
    Write-Info "Need Administrator to create $linkFull (Windows will ask once)"
    if (Invoke-MklinkJunction $linkFull $targetFull -Elevated) {
      Write-Ok ("Linked {0} -> {1}" -f $linkFull, $targetFull)
      return $true
    }
  }
  Write-Warn ("Could not create folder link {0} -> {1}" -f $linkFull, $targetFull)
  return $false
}

function Get-LocalDataDrive {
  param([string]$ExcludeRoot, [long]$NeededBytes = 0)
  $skip = @{}
  $skip['C:'] = $true
  if ($ExcludeRoot) {
    $r = [IO.Path]::GetPathRoot($ExcludeRoot)
    if ($r) { $skip[$r.TrimEnd('\').ToUpperInvariant()] = $true }
  }
  $need = [long]$NeededBytes + 2GB
  if ($need -lt 2GB) { $need = 2GB }
  $all = @(Get-CimInstance Win32_LogicalDisk | Where-Object {
    $_.DeviceID -and
    -not $skip.ContainsKey($_.DeviceID.ToUpperInvariant()) -and
    $null -ne $_.Size -and
    [long]$_.Size -gt 50GB -and
    $null -ne $_.FreeSpace
  })
  if ($all.Count -eq 0) { return $null }
  $fixed = @($all | Where-Object { $_.DriveType -eq 3 -and [long]$_.FreeSpace -ge $need } |
    Sort-Object { [long]$_.FreeSpace } -Descending)
  if ($fixed.Count -gt 0) { return $fixed[0] }
  $any = @($all | Where-Object { [long]$_.FreeSpace -ge $need } |
    Sort-Object { [long]$_.FreeSpace } -Descending)
  if ($any.Count -gt 0) { return $any[0] }
  return $null
}

function Test-CanLinkOriginalProfile([string]$SrcProfile, $Plan) {
  if ([string]::IsNullOrWhiteSpace($SrcProfile)) { return $false }
  if ($Plan.SameProfile) { return $true }
  if ($null -ne $Plan.ProfileJunctionLink) { return $true }
  return (Test-ProfileResolvesHere $SrcProfile)
}

function Get-BackupPathPlan {
  param(
    [string]$SrcProfile,
    [string]$OrigCubase,
    [string]$OrigViewerOne,
    [string]$UsbRoot,
    [long]$CubaseBytes = 0,
    [long]$ViewerOneBytes = 0,
    [long]$ContentBytes = 0
  )
  $voLaunch = Join-Path $env:USERPROFILE 'ViewerOne'
  $plan = [ordered]@{
    ViewerOneDest              = $voLaunch
    ViewerOneCopyDest          = $voLaunch
    CubaseDest                 = Join-Path $env:USERPROFILE 'Documents\Cubase'
    CubasePhysicalDest         = Join-Path $env:USERPROFILE 'Documents\Cubase'
    CubaseNativeLink           = $null
    DataDrive                  = $null
    SrcProfile                 = $SrcProfile
    SameProfile                = $false
    ProfileJunctionLink        = $null
    ProfileJunctionTarget      = $null
    CubaseJunctionLink         = $null
    CubaseJunctionTarget       = $null
    ViewerOneJunctionLink      = $null
    ViewerOneJunctionTarget    = $null
    SteinbergContentPhysical   = Join-Path $env:PROGRAMDATA 'Steinberg'
    SteinbergContentLink       = $null
    WillMatchOriginalPaths     = $false
    Notes                      = New-Object System.Collections.Generic.List[string]
  }
  if ([string]::IsNullOrWhiteSpace($SrcProfile)) {
    $SrcProfile = $env:USERPROFILE
    $plan.SrcProfile = $SrcProfile
  }
  $plan.SameProfile = Test-SamePath $SrcProfile $env:USERPROFILE
  if ($OrigViewerOne) {
    $voRel = Get-RelativeUnder $OrigViewerOne $SrcProfile
    if ($voRel) {
      $voLaunch = Join-Path $env:USERPROFILE $voRel
      $plan.ViewerOneDest = $voLaunch
      $plan.ViewerOneCopyDest = $voLaunch
    }
  }
  $cFree = Get-DriveFreeBytes 'C:\'
  $voOnCNeed = [long]$ViewerOneBytes + 5GB
  $needOnData = [long]$CubaseBytes + [long]$ContentBytes
  $moveViewerOne = $false
  if ($cFree -ge 0 -and $cFree -lt $voOnCNeed -and $ViewerOneBytes -gt 50MB) {
    $voExists = (Test-Path -LiteralPath $plan.ViewerOneDest) -and -not (Test-IsReparsePoint $plan.ViewerOneDest)
    $voKids = @()
    if ($voExists) { $voKids = @(Get-ChildItem -LiteralPath $plan.ViewerOneDest -Force -ErrorAction SilentlyContinue) }
    if (-not $voExists -or $voKids.Count -eq 0) {
      $moveViewerOne = $true
      $needOnData += [long]$ViewerOneBytes
    }
  }
  $dataDisk = Get-LocalDataDrive -ExcludeRoot $UsbRoot -NeededBytes $needOnData
  if ($dataDisk) {
    $plan.DataDrive = $dataDisk.DeviceID
    $plan.CubasePhysicalDest = Join-Path $dataDisk.DeviceID 'GigData\Cubase'
    $plan.CubaseDest = $plan.CubasePhysicalDest
    $plan.Notes.Add(("Cubase projects go on {0}\GigData\Cubase so they do not fill the OS drive" -f $dataDisk.DeviceID))
    $docsCubase = Join-Path $env:USERPROFILE 'Documents\Cubase'
    if (-not (Test-SamePath $docsCubase $plan.CubasePhysicalDest)) { $plan.CubaseNativeLink = $docsCubase }
    if ($ContentBytes -gt 50MB) {
      $plan.SteinbergContentPhysical = Join-Path $dataDisk.DeviceID 'GigData\Steinberg'
      $plan.SteinbergContentLink = Join-Path $env:PROGRAMDATA 'Steinberg'
      $plan.Notes.Add(("Steinberg content goes on {0}\GigData\Steinberg and C:\ProgramData\Steinberg links there" -f $dataDisk.DeviceID))
    }
    if ($moveViewerOne) {
      $plan.ViewerOneCopyDest = Join-Path $dataDisk.DeviceID 'GigData\ViewerOne'
      $plan.ViewerOneJunctionLink = $plan.ViewerOneDest
      $plan.ViewerOneJunctionTarget = $plan.ViewerOneCopyDest
      $plan.Notes.Add(("ViewerOne also goes on {0}; {1} will link there" -f $dataDisk.DeviceID, $plan.ViewerOneDest))
    }
  } else {
    $plan.Notes.Add('No extra data drive with enough space -- large files will try to land on C:')
  }
  if (-not $plan.SameProfile) {
    if (-not (Test-Path -LiteralPath $SrcProfile)) {
      $plan.ProfileJunctionLink = $SrcProfile
      $plan.ProfileJunctionTarget = $env:USERPROFILE
      $plan.Notes.Add(("Link {0} -> {1} so the original Cubase path still exists" -f $SrcProfile, $env:USERPROFILE))
    } elseif (Test-IsReparsePoint $SrcProfile) {
      $tgt = Get-JunctionTarget $SrcProfile
      if ($tgt -and (Test-SamePath $tgt $env:USERPROFILE)) {
        $plan.Notes.Add("Profile link already in place: $SrcProfile")
      } else {
        $plan.Notes.Add("A different folder link already exists at $SrcProfile -- leaving it")
      }
    } elseif (Test-IsWindowsUserProfile $SrcProfile) {
      $plan.Notes.Add("Original profile $SrcProfile is a real Windows user folder on this PC; will not take it over")
    } else {
      $kids = @(Get-ChildItem -LiteralPath $SrcProfile -Force -ErrorAction SilentlyContinue)
      if ($kids.Count -eq 0) {
        $plan.ProfileJunctionLink = $SrcProfile
        $plan.ProfileJunctionTarget = $env:USERPROFILE
        $plan.Notes.Add("Replace empty $SrcProfile with a link to this account")
      } else {
        $plan.Notes.Add("$SrcProfile already exists and is not empty; will not replace it")
      }
    }
  }
  if ($OrigCubase) {
    $physical = [string]$plan.CubasePhysicalDest
    if (Test-SamePath $OrigCubase $physical) {
      $plan.WillMatchOriginalPaths = $true
    } elseif (Test-CanLinkOriginalProfile $SrcProfile $plan) {
      $plan.CubaseJunctionLink = $OrigCubase
      $plan.CubaseJunctionTarget = $physical
      $plan.WillMatchOriginalPaths = $true
      $plan.Notes.Add(("Link {0} -> {1} so Cubase still finds audio at the original path" -f $OrigCubase, $physical))
    } else {
      $plan.WillMatchOriginalPaths = $false
      $plan.Notes.Add("Could not recreate $OrigCubase on this PC. Cubase may ask to Find Missing Files.")
    }
  }
  return [pscustomobject]$plan
}

function Invoke-BackupPathPlan($Plan) {
  if ($Plan.ProfileJunctionLink) {
    if ((Test-Path -LiteralPath $Plan.ProfileJunctionLink) -and -not (Test-IsReparsePoint $Plan.ProfileJunctionLink)) {
      $kids = @(Get-ChildItem -LiteralPath $Plan.ProfileJunctionLink -Force -ErrorAction SilentlyContinue)
      if ($kids.Count -eq 0) { Remove-Item -LiteralPath $Plan.ProfileJunctionLink -Force -ErrorAction SilentlyContinue }
    }
    if (-not (New-DirectoryJunction $Plan.ProfileJunctionLink $Plan.ProfileJunctionTarget)) {
      $Plan.WillMatchOriginalPaths = $false
    }
  }
  if ($Plan.ViewerOneCopyDest) { New-Item -ItemType Directory -Path $Plan.ViewerOneCopyDest -Force | Out-Null }
  if ($Plan.ViewerOneJunctionLink -and $Plan.ViewerOneJunctionTarget) {
    if (-not (New-DirectoryJunction $Plan.ViewerOneJunctionLink $Plan.ViewerOneJunctionTarget -Replace)) {
      Write-Warn "Could not link ViewerOne; files will live at $($Plan.ViewerOneCopyDest)"
      $Plan.ViewerOneDest = [string]$Plan.ViewerOneCopyDest
    }
  }
  if ($Plan.CubasePhysicalDest) {
    New-Item -ItemType Directory -Path $Plan.CubasePhysicalDest -Force | Out-Null
    $Plan.CubaseDest = [string]$Plan.CubasePhysicalDest
  }
  if ($Plan.CubaseJunctionLink -and $Plan.CubaseJunctionTarget) {
    if (-not (Test-ProfileResolvesHere $Plan.SrcProfile) -and -not $Plan.SameProfile) {
      Write-Warn "Could not make $($Plan.SrcProfile) point at this account; Cubase may ask to Find Missing Files"
      $Plan.WillMatchOriginalPaths = $false
    } elseif (-not (New-DirectoryJunction $Plan.CubaseJunctionLink $Plan.CubaseJunctionTarget -Replace)) {
      Write-Warn "Could not link the original Cubase path."
      $Plan.WillMatchOriginalPaths = $false
    } else {
      $Plan.WillMatchOriginalPaths = $true
    }
  }
  $native = [string]$Plan.CubaseNativeLink
  if ($native -and $Plan.CubasePhysicalDest -and -not (Test-SamePath $native $Plan.CubasePhysicalDest)) {
    if (-not (Test-Path -LiteralPath $native) -or (Test-IsReparsePoint $native)) {
      [void](New-DirectoryJunction $native $Plan.CubasePhysicalDest -Replace)
    }
  }
  if ($Plan.SteinbergContentPhysical) {
    New-Item -ItemType Directory -Path $Plan.SteinbergContentPhysical -Force | Out-Null
  }
  if ($Plan.SteinbergContentLink -and $Plan.SteinbergContentPhysical) {
    if (-not (New-DirectoryJunction $Plan.SteinbergContentLink $Plan.SteinbergContentPhysical -Replace)) {
      Write-Warn "Steinberg content is on $($Plan.SteinbergContentPhysical). C:\ProgramData\Steinberg was left as it is."
    }
  }
  return $Plan
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
  $vbs = Join-Path $env:USERPROFILE 'ViewerOne\ViewerOne-Launch.vbs'
  if (-not (Test-Path -LiteralPath $vbs)) { return }
  $dest = Join-Path $env:USERPROFILE 'Desktop\ViewerOne.lnk'
  New-Shortcut -Path $dest -Target "$env:SystemRoot\System32\wscript.exe" -Arguments "`"$vbs`"" -WorkDir (Split-Path $vbs) -Description 'ViewerOne'
  Write-Ok "Desktop shortcut: $dest"
}

function Install-GigStartupTask([string]$ViewerOneDir) {
  $vbs = Join-Path $ViewerOneDir 'scripts\start-gig-apps.vbs'
  if (-not (Test-Path -LiteralPath $vbs)) {
    Write-Warn "Startup script missing -- scheduled task not created: $vbs"
    return
  }
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//nologo `"$vbs`"" -WorkingDirectory $ViewerOneDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Delay = 'PT45S'
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'ViewerOne Gig Startup' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Start X32-Edit, Cubase 15, and ViewerOne after Windows logon' -Force | Out-Null
  Write-Ok "Scheduled task: ViewerOne Gig Startup (at logon + 45s)"
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

  $copyKind = Resolve-CopyKind
  $full = $copyKind -eq 'Full'
  $cubaseRoot = Get-CubaseProjectRoot
  $voExclude = @()
  $voExcludeFile = @()
  if (-not $full) {
    $voExclude = @('.git', 'release', '_ref', '.tmp-cubase-ocr', '.tmp-scan-qa', '.pio', '.cursor')
    $voExcludeFile = @('*.log')
  }
  $x32Exe = Join-Path $env:USERPROFILE 'Desktop\Apps\X32-Edit.exe'
  $x32App = Join-Path $env:APPDATA 'X32-Edit'

  Write-Step "Scanning ($copyKind)"
  $voInv = Get-FolderInventory -Path $ViewerOneSrc -ExcludeTop $voExclude -ExcludeFile $voExcludeFile
  $cubaseInv = [pscustomobject]@{ Bytes = [long]0; Files = [long]0 }
  if ($cubaseRoot) { $cubaseInv = Get-FolderInventory -Path $cubaseRoot }
  $settingsTrees = New-Object System.Collections.Generic.List[object]
  foreach ($def in @(Get-SettingsTreeDefs $full)) {
    if (-not (Test-Path -LiteralPath $def.Live)) {
      Write-Info ("{0} not found -- skipped ({1})" -f $def.Name, $def.Live)
      continue
    }
    $inv = Get-FolderInventory -Path $def.Live -ExcludeTop $def.ExDir -ExcludeFile $def.ExFile
    if ([long]$inv.Files -le 0) {
      Write-Info ("{0} is empty -- skipped" -f $def.Name)
      continue
    }
    $settingsTrees.Add([pscustomobject]@{
      Name = $def.Name; Live = $def.Live; Rel = $def.Rel; ExDir = @($def.ExDir); ExFile = @($def.ExFile)
      Files = [long]$inv.Files; Bytes = [long]$inv.Bytes
    })
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
  foreach ($t in $settingsTrees) { $jobItems.Add((New-CopyJobItem $t.Name $t.Files $t.Bytes)) }
  $jobItems.Add((New-CopyJobItem 'loopMIDI' 1 2048))
  if ($cubaseRoot) { $jobItems.Add((New-CopyJobItem 'Cubase projects' $cubaseInv.Files $cubaseInv.Bytes)) }
  $jobItems.Add((New-CopyJobItem 'Startup' 3 8192))
  if ($x32Files -gt 0) { $jobItems.Add((New-CopyJobItem 'X32-Edit' $x32Files $x32Bytes)) }
  $estimate = [long]0
  $estimateFiles = [long]0
  foreach ($it in $jobItems) {
    $estimate += [long]$it.Bytes
    $estimateFiles += [long]$it.Files
  }

  Write-Step "What will be copied ($copyKind)"
  if ($full) { Write-Warn "Full wipe: everything currently on $driveRoot will be deleted first." }
  Write-Info ("ViewerOne         {0,8:N0} files   {1}" -f $voInv.Files, (Format-Bytes $voInv.Bytes))
  foreach ($t in $settingsTrees) {
    Write-Info ("{0,-18} {1,8:N0} files   {2}" -f $t.Name, $t.Files, (Format-Bytes $t.Bytes))
  }
  if ($cubaseRoot) {
    Write-Info ("Cubase projects   {0,8:N0} files   {1}" -f $cubaseInv.Files, (Format-Bytes $cubaseInv.Bytes))
  } else {
    Write-Warn "Cubase project folder not found -- skipped"
  }
  Write-Info "Also: loopMIDI ports, startup, X32-Edit"
  Write-Info ("Total             {0,8:N0} files   {1}" -f $estimateFiles, (Format-Bytes $estimate))

  $room = if ($full -and $disk) { [long]$disk.Size } elseif ($disk) { [long]$disk.FreeSpace } else { [long]0 }
  if ($disk -and $room -lt $estimate) {
    Write-Warn ("Drive only has {0} available -- copy may fail if the estimate is close." -f (Format-Bytes $room))
  }

  Wait-GigAppsClosed "For a clean copy, close Cubase / ViewerOne if they have unsaved work."

  $confirm = if ($full) { "Wipe $driveRoot and copy everything to $usbRoot now?" } else { "Copy everything to $usbRoot now?" }
  if (-not (Confirm-Go $confirm)) {
    Write-Warn "Cancelled."
    return
  }

  if ($full) { Clear-UsbVolume $driveRoot }

  $started = Get-Date
  New-Item -ItemType Directory -Path (Join-Path $usbRoot 'logs') -Force | Out-Null
  Deploy-Tooling $usbRoot

  Write-Step "Copying"
  Start-CopyJob -Items @($jobItems.ToArray()) -StartedAt $started -DriveRoot $driveRoot

  Enter-CopyJobItem 'ViewerOne' $voInv.Files $voInv.Bytes
  $null = Invoke-RoboCopy -Source $ViewerOneSrc -Dest (Join-Path $payload 'ViewerOne') -Mirror -ExcludeDir $voExclude -ExcludeFile $voExcludeFile -ExpectedBytes $voInv.Bytes -ExpectedFiles $voInv.Files

  foreach ($t in $settingsTrees) {
    Enter-CopyJobItem $t.Name $t.Files $t.Bytes
    $null = Invoke-RoboCopy -Source $t.Live -Dest (Join-Path $payload $t.Rel) -Mirror -ExcludeDir $t.ExDir -ExcludeFile $t.ExFile -ExpectedBytes $t.Bytes -ExpectedFiles $t.Files
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
    copyKind          = $copyKind
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
    "Gig backup copied: $($ended.ToString('yyyy-MM-dd HH:mm')) ($copyKind)"
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

  $srcProfile = [string](Get-ManifestValue $man 'sourceUserProfile')
  $origCubase = [string](Get-ManifestValue $man 'cubaseProjectRoot')
  $origViewerOne = [string](Get-ManifestValue $man 'viewerOnePath')

  $voSrc = Join-Path $payload 'ViewerOne'
  $projSrc = Join-Path $payload 'Cubase-Projects'
  $prefsSrc = Join-Path $payload 'Cubase-Settings'
  $prefsDest = Join-Path $env:APPDATA 'Steinberg\Cubase 15_64'
  $cfgSrc = Join-Path $payload 'ViewerOne-AppData\viewer-one-config.json'
  if (-not (Test-Path -LiteralPath $cfgSrc)) {
    $cfgSrc = Join-Path $payload 'ViewerOne-Config\viewer-one-config.json'
  }
  $scanSrc = Join-Path $payload 'ViewerOne-AppData\last-arranger-scan.txt'
  if (-not (Test-Path -LiteralPath $scanSrc)) {
    $scanSrc = Join-Path $payload 'ViewerOne-Config\last-arranger-scan.txt'
  }
  $x32ExeSrc = Join-Path $payload 'X32-Edit\X32-Edit.exe'
  $x32AppSrc = Join-Path $payload 'X32-Edit\AppData'
  $voExcludeApply = @('.git', 'release', '_ref', '.tmp-cubase-ocr', '.tmp-scan-qa', '.pio')
  $applyTreeDefs = @(
    [pscustomobject]@{ Name = 'ViewerOne data'; Rel = 'ViewerOne-AppData'; Dest = (Join-Path $env:APPDATA 'viewer-one'); ExDir = @() }
    [pscustomobject]@{ Name = 'Steinberg settings'; Rel = 'Steinberg-AppData'; Dest = (Join-Path $env:APPDATA 'Steinberg'); ExDir = @('Activation Manager') }
    [pscustomobject]@{ Name = 'Steinberg documents'; Rel = 'Steinberg-Documents'; Dest = (Join-Path (Get-UserDocumentsPath) 'Steinberg'); ExDir = @() }
    [pscustomobject]@{ Name = 'Steinberg local'; Rel = 'Steinberg-Local'; Dest = (Join-Path $env:LOCALAPPDATA 'Steinberg'); ExDir = @() }
    [pscustomobject]@{ Name = 'Steinberg content'; Rel = 'Steinberg-ProgramData'; Dest = (Join-Path $env:PROGRAMDATA 'Steinberg'); ExDir = @() }
    [pscustomobject]@{ Name = 'Native Instruments'; Rel = 'NativeInstruments-AppData'; Dest = (Join-Path $env:APPDATA 'Native Instruments'); ExDir = @() }
    [pscustomobject]@{ Name = 'loopMIDI app'; Rel = 'loopMIDI\App'; Dest = (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Tobias Erichsen\loopMIDI'); ExDir = @() }
  )

  Write-Step "Scanning"
  $voInv = Get-FolderInventory -Path $voSrc -ExcludeTop $voExcludeApply
  $cubaseInv = [pscustomobject]@{ Bytes = [long]0; Files = [long]0 }
  if (Test-Path -LiteralPath $projSrc) { $cubaseInv = Get-FolderInventory -Path $projSrc }
  $restoreTrees = New-Object System.Collections.Generic.List[object]
  foreach ($def in $applyTreeDefs) {
    $src = Join-Path $payload $def.Rel
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $ex = @()
    if ($def.PSObject.Properties['ExDir']) { $ex = @($def.ExDir) }
    $inv = Get-FolderInventory -Path $src -ExcludeTop $ex
    if ([long]$inv.Files -le 0) { continue }
    $restoreTrees.Add([pscustomobject]@{
      Name = $def.Name; Src = $src; Dest = $def.Dest; ExDir = $ex; Files = [long]$inv.Files; Bytes = [long]$inv.Bytes
    })
  }
  $hasSteinbergAppData = [bool]($restoreTrees | Where-Object { $_.Name -eq 'Steinberg settings' })
  $prefsInv = [pscustomobject]@{ Bytes = [long]0; Files = [long]0 }
  if ((-not $hasSteinbergAppData) -and (Test-Path -LiteralPath $prefsSrc)) {
    $prefsInv = Get-FolderInventory -Path $prefsSrc
  }
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

  $contentBytes = [long]0
  $contentTree = $restoreTrees | Where-Object { $_.Name -eq 'Steinberg content' } | Select-Object -First 1
  if ($contentTree) { $contentBytes = [long]$contentTree.Bytes }
  $plan = Get-BackupPathPlan -SrcProfile $srcProfile -OrigCubase $origCubase -OrigViewerOne $origViewerOne -UsbRoot $usbRoot -CubaseBytes ([long]$cubaseInv.Bytes) -ViewerOneBytes ([long]$voInv.Bytes) -ContentBytes $contentBytes
  $voDest = [string]$plan.ViewerOneCopyDest
  $cubaseDest = [string]$plan.CubasePhysicalDest
  if ($contentTree -and $plan.SteinbergContentPhysical) { $contentTree.Dest = [string]$plan.SteinbergContentPhysical }

  Write-Step "This PC will be updated"
  Write-Info "ViewerOne -> $voDest"
  if ($plan.ViewerOneJunctionLink) { Write-Info ("ViewerOne link -> {0}" -f $plan.ViewerOneJunctionLink) }
  Write-Info "Cubase projects -> $cubaseDest"
  if ($plan.CubaseJunctionLink) { Write-Info ("Cubase original path -> {0}  (folder link)" -f $plan.CubaseJunctionLink) }
  if ($plan.CubaseNativeLink) { Write-Info ("Also available at -> {0}" -f $plan.CubaseNativeLink) }
  if ($plan.SteinbergContentPhysical) { Write-Info ("Steinberg content -> {0}" -f $plan.SteinbergContentPhysical) }
  Write-Info 'Settings, MIDI Remote, loopMIDI, X32-Edit, and the logon startup task stay on C:'
  if (@($plan.Notes).Count -gt 0) {
    foreach ($note in @($plan.Notes)) { Write-Info $note }
  }
  if ($plan.WillMatchOriginalPaths) {
    Write-Ok "Cubase will still see files at the original path, so audio links should just work."
  } else {
    Write-Warn "Cubase may ask to Find Missing Files once."
  }
  if (-not (Test-Path -LiteralPath $CubaseExe)) {
    Write-Warn "Cubase 15 is not installed at the usual path. Projects and settings will still be copied. Cubase itself has to be installed separately."
  }
  if (-not (Get-LoopMidiExe)) {
    Write-Info "loopMIDI is not installed yet. The backup will copy the program in and load the cables."
  }

  Wait-GigAppsClosed "Close Cubase, ViewerOne, and X32-Edit before updating this PC."
  if (-not (Confirm-Go "Update this backup PC from the USB now?")) {
    Write-Warn "Cancelled."
    return
  }
  $plan = Invoke-BackupPathPlan $plan
  $voDest = [string]$plan.ViewerOneCopyDest
  $cubaseDest = [string]$plan.CubasePhysicalDest
  if ($contentTree -and $plan.SteinbergContentPhysical) { $contentTree.Dest = [string]$plan.SteinbergContentPhysical }

  $jobItems = New-Object System.Collections.Generic.List[object]
  $jobItems.Add((New-CopyJobItem 'ViewerOne' $voInv.Files $voInv.Bytes))
  foreach ($t in $restoreTrees) { $jobItems.Add((New-CopyJobItem $t.Name $t.Files $t.Bytes)) }
  if ($cfgFiles -gt 0) { $jobItems.Add((New-CopyJobItem 'ViewerOne config' $cfgFiles $cfgBytes)) }
  $jobItems.Add((New-CopyJobItem 'loopMIDI' 1 2048))
  if (Test-Path -LiteralPath $projSrc) { $jobItems.Add((New-CopyJobItem 'Cubase projects' $cubaseInv.Files $cubaseInv.Bytes)) }
  if ([long]$prefsInv.Files -gt 0) { $jobItems.Add((New-CopyJobItem 'Cubase settings' $prefsInv.Files $prefsInv.Bytes)) }
  if ($x32Files -gt 0) { $jobItems.Add((New-CopyJobItem 'X32-Edit' $x32Files $x32Bytes)) }
  $jobItems.Add((New-CopyJobItem 'Startup' 1 1024))

  Write-Step "Updating"
  Start-CopyJob -Items @($jobItems.ToArray()) -StartedAt (Get-Date) -DriveRoot ([IO.Path]::GetPathRoot($voDest))

  Enter-CopyJobItem 'ViewerOne' $voInv.Files $voInv.Bytes
  $null = Invoke-RoboCopy -Source $voSrc -Dest $voDest -ExcludeDir $voExcludeApply -ExpectedBytes $voInv.Bytes -ExpectedFiles $voInv.Files

  foreach ($t in $restoreTrees) {
    Enter-CopyJobItem $t.Name $t.Files $t.Bytes
    New-Item -ItemType Directory -Path $t.Dest -Force -ErrorAction SilentlyContinue | Out-Null
    $null = Invoke-RoboCopy -Source $t.Src -Dest $t.Dest -ExcludeDir @($t.ExDir) -ExpectedBytes $t.Bytes -ExpectedFiles $t.Files
  }

  if ($cfgFiles -gt 0) {
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
  }

  Invoke-TinyJobItem 'loopMIDI' 1 2048 'loopMIDI.reg' {
    Import-LoopMidiReg (Join-Path $payload 'loopMIDI\loopMIDI.reg')
  }

  if (Test-Path -LiteralPath $projSrc) {
    Enter-CopyJobItem 'Cubase projects' $cubaseInv.Files $cubaseInv.Bytes
    $null = Invoke-RoboCopy -Source $projSrc -Dest $cubaseDest -ExpectedBytes $cubaseInv.Bytes -ExpectedFiles $cubaseInv.Files
  }

  if ([long]$prefsInv.Files -gt 0) {
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
    if ($latest) {
      $openPath = $latest.FullName
      if ($plan.WillMatchOriginalPaths -and $plan.CubaseJunctionLink) {
        $rel = Get-RelativeUnder $latest.FullName $plan.CubasePhysicalDest
        if ($rel) { $openPath = Join-Path $plan.CubaseJunctionLink $rel }
      }
      $dest = Join-Path $env:USERPROFILE 'Desktop\Open gig Cubase project.lnk'
      if (Test-Path -LiteralPath $CubaseExe) {
        New-Shortcut -Path $dest -Target $CubaseExe -Arguments ('"{0}"' -f $openPath) -WorkDir (Split-Path $openPath) -Description 'Open the gig Cubase project'
      } else {
        New-Shortcut -Path $dest -Target $openPath -WorkDir (Split-Path $openPath) -Description 'Open the gig Cubase project'
      }
      Write-Ok "Desktop shortcut: $dest"
      Write-Ok ("Open this in Cubase: {0}" -f $openPath)
    }
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
