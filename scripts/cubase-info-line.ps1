# Cubase info-line Length helper for ViewerOne (5.12.82).
# MUST be invoked only as:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<full-path>\cubase-info-line.ps1" <action> ...
# Never double-click / Start-Process / shell-open this .ps1 (Windows opens Notepad).
# Actions:
#   prepare � restore if minimized, foreground Cubase (no maximize)
#   expand  � grow Cubase height a bit + thicken Arranger Track lane (no Zoom Full)
#   capture � foreground + BitBlt + OCR Name/Start/End/Length
#   click   � unused by scan (auto-click is off)
#   health  � Cubase process + HWND still alive?
#   grab    � foreground + OCR Info Line only (no Cubase clicks or keys)
#   serve   � keep process alive; stdin lines: action<TAB>outDir<TAB>eventName
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File cubase-info-line.ps1 grab <outDir> <name>

param(
  [Parameter(Mandatory = $true)][ValidateSet('prepare', 'capture', 'click', 'health', 'grab', 'serve', 'zoomin', 'stop', 'infoline', 'expand')][string]$Action,
  [string]$OutDir = '',
  [string]$EventName = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CubaseUi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref RECT pvParam, uint fWinIni);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SPI_GETWORKAREA = 0x0030;
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  public const uint PW_RENDERFULLCONTENT = 2;
  public const int SM_CXSCREEN = 0;
  public const int SM_CYSCREEN = 1;
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public int type;
    public MOUSEINPUT mi;
  }
  public const int SW_RESTORE = 9;
  public const int SRCCOPY = 0x00CC0020;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const byte VK_ESCAPE = 0x1B;
  public const byte VK_I = 0x49;
  public const byte VK_CONTROL = 0x11;
  public const byte VK_SHIFT = 0x10;
  public const byte VK_E = 0x45;
  public const byte VK_F = 0x46;
  public const byte VK_NUMPAD0 = 0x60;
  public static void ScrollWheel(int delta) {
    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
  }
  public static void SendLeftClickAt(int x, int y) {
    int sx = GetSystemMetrics(SM_CXSCREEN);
    int sy = GetSystemMetrics(SM_CYSCREEN);
    if (sx < 2) sx = 2;
    if (sy < 2) sy = 2;
    int ax = (int)(x * 65535.0 / (sx - 1));
    int ay = (int)(y * 65535.0 / (sy - 1));
    mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE, (uint)ax, (uint)ay, 0, UIntPtr.Zero);
    mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_LEFTDOWN, (uint)ax, (uint)ay, 0, UIntPtr.Zero);
    mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_LEFTUP, (uint)ax, (uint)ay, 0, UIntPtr.Zero);
  }
  public static void SendLeftClick() {
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }
  public static void SendLeftDrag(int x0, int y0, int x1, int y1, int steps) {
    int sx = GetSystemMetrics(SM_CXSCREEN);
    int sy = GetSystemMetrics(SM_CYSCREEN);
    if (sx < 2) sx = 2;
    if (sy < 2) sy = 2;
    if (steps < 4) steps = 4;
    int ax0 = (int)(x0 * 65535.0 / (sx - 1));
    int ay0 = (int)(y0 * 65535.0 / (sy - 1));
    mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE, (uint)ax0, (uint)ay0, 0, UIntPtr.Zero);
    mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_LEFTDOWN, (uint)ax0, (uint)ay0, 0, UIntPtr.Zero);
    for (int i = 1; i <= steps; i++) {
      int x = x0 + (x1 - x0) * i / steps;
      int y = y0 + (y1 - y0) * i / steps;
      int ax = (int)(x * 65535.0 / (sx - 1));
      int ay = (int)(y * 65535.0 / (sy - 1));
      mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE, (uint)ax, (uint)ay, 0, UIntPtr.Zero);
    }
    int ax1 = (int)(x1 * 65535.0 / (sx - 1));
    int ay1 = (int)(y1 * 65535.0 / (sy - 1));
    mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_LEFTUP, (uint)ax1, (uint)ay1, 0, UIntPtr.Zero);
  }
}
"@
[void][CubaseUi]::SetProcessDPIAware()
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'viewerone-cubase-length' }

function Await-WinRt($WinRtTask, [Type]$ResultType, [int]$TimeoutMs = 30000) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
  })[0]
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  if (-not $netTask.Wait($TimeoutMs)) {
    throw "WinRT operation timed out after ${TimeoutMs}ms"
  }
  return $netTask.Result
}

function Get-CubaseProcess {
  $proc = Get-Process -Name 'Cubase15', 'Cubase14', 'Cubase13', 'Cubase12', 'Cubase' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
  if (-not $proc) {
    $proc = Get-Process -Name 'Cubase15', 'Cubase14', 'Cubase13', 'Cubase12', 'Cubase' -ErrorAction SilentlyContinue |
      Select-Object -First 1
  }
  if (-not $proc) { throw 'Cubase window not found (is Cubase Pro running?)' }
  return $proc
}

function Test-CubaseAlive {
  try {
    $proc = Get-Process -Name 'Cubase15', 'Cubase14', 'Cubase13', 'Cubase12', 'Cubase' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $proc) {
      return [pscustomobject]@{ ok = $false; alive = $false; error = 'Cubase process not found' }
    }
    $proc.Refresh()
    $handle = $proc.MainWindowHandle
    $hasHwnd = ($handle -ne [IntPtr]::Zero) -and [CubaseUi]::IsWindow($handle)
    return [pscustomobject]@{
      ok = $true
      alive = $true
      hasWindow = [bool]$hasHwnd
      process = $proc.ProcessName
      pid = $proc.Id
      title = [string]$proc.MainWindowTitle
    }
  } catch {
    return [pscustomobject]@{ ok = $false; alive = $false; error = $_.Exception.Message }
  }
}

function Refresh-CubaseWindow($proc) {
  $handle = $proc.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) {
    $proc.Refresh()
    $handle = $proc.MainWindowHandle
  }
  if ($handle -eq [IntPtr]::Zero) {
    throw 'Cubase has no main window handle (is the project window open?)'
  }
  if (-not [CubaseUi]::IsWindow($handle)) {
    throw 'Cubase HWND is no longer valid (process may have exited)'
  }
  $rect = New-Object CubaseUi+RECT
  if (-not [CubaseUi]::GetWindowRect($handle, [ref]$rect)) {
    throw 'GetWindowRect failed for Cubase'
  }
  return [pscustomobject]@{
    Process = $proc
    Handle = $handle
    Left = $rect.Left
    Top = $rect.Top
    Width = ($rect.Right - $rect.Left)
    Height = ($rect.Bottom - $rect.Top)
  }
}

# Soft prepare: restore if minimized only. Never maximize. Never SetWindowPos.
function Prepare-CubaseWindow {
  param([switch]$Quick)
  $proc = Get-CubaseProcess
  $handle = $proc.MainWindowHandle
  $restored = $false

  if ($handle -eq [IntPtr]::Zero) {
    try {
      [void][CubaseUi]::ShowWindow($proc.MainWindowHandle, [CubaseUi]::SW_RESTORE)
      Start-Sleep -Milliseconds 280
      $proc.Refresh()
      $handle = $proc.MainWindowHandle
      $restored = $true
    } catch { }
  }

  if ($handle -eq [IntPtr]::Zero) {
    throw 'Cubase has no main window handle (is the project window open?)'
  }

  if ([CubaseUi]::IsIconic($handle)) {
    [void][CubaseUi]::ShowWindow($handle, [CubaseUi]::SW_RESTORE)
    Start-Sleep -Milliseconds 320
    $restored = $true
    $proc.Refresh()
    $handle = $proc.MainWindowHandle
  }

  try {
    [void][CubaseUi]::SetForegroundWindow($handle)
  } catch { }
  # Quick path (scan grab): Cubase is already up � don't pad every song with a foreground sleep.
  if ($restored) {
    Start-Sleep -Milliseconds 40
  } elseif (-not $Quick) {
    Start-Sleep -Milliseconds 80
  }

  $win = Refresh-CubaseWindow $proc
  return [pscustomobject]@{
    ok = $true
    prepared = $true
    moved = $false
    restored = [bool]$restored
    processName = $proc.ProcessName
    title = [string]$proc.MainWindowTitle
    left = $win.Left
    top = $win.Top
    width = $win.Width
    height = $win.Height
    Handle = $win.Handle
    Proc = $proc
  }
}

function Get-ScreenWorkArea {
  $r = New-Object CubaseUi+RECT
  [void][CubaseUi]::SystemParametersInfo([CubaseUi]::SPI_GETWORKAREA, 0, [ref]$r, 0)
  return $r
}

function Invoke-MouseDrag($win, [int]$bitmapX0, [int]$bitmapY0, [int]$bitmapX1, [int]$bitmapY1, [int]$Steps = 18) {
  $screenX0 = $win.Left + $bitmapX0
  $screenY0 = $win.Top + $bitmapY0
  $screenX1 = $win.Left + $bitmapX1
  $screenY1 = $win.Top + $bitmapY1
  $saved = New-Object CubaseUi+POINT
  [void][CubaseUi]::GetCursorPos([ref]$saved)
  $ourTid = [CubaseUi]::GetCurrentThreadId()
  $cubaseTid = [CubaseUi]::GetWindowThreadProcessId($win.Handle, [IntPtr]::Zero)
  $attached = $false
  if ($cubaseTid -ne 0 -and $cubaseTid -ne $ourTid) {
    $attached = [CubaseUi]::AttachThreadInput($ourTid, $cubaseTid, $true)
  }
  try {
    try { [void][CubaseUi]::SetForegroundWindow($win.Handle) } catch { }
    Start-Sleep -Milliseconds 50
    [void][CubaseUi]::SetCursorPos($screenX0, $screenY0)
    Start-Sleep -Milliseconds 40
    [CubaseUi]::SendLeftDrag($screenX0, $screenY0, $screenX1, $screenY1, $Steps)
    Start-Sleep -Milliseconds 180
  } finally {
    [void][CubaseUi]::SetCursorPos($saved.X, $saved.Y)
    if ($attached) { [void][CubaseUi]::AttachThreadInput($ourTid, $cubaseTid, $false) }
  }
}

function Measure-ArrangerLaneSpan([System.Drawing.Bitmap]$bmp) {
  $minX = [int]($bmp.Width * 0.55)
  $minY = 150
  $maxY = [Math]::Min([int]($bmp.Height * 0.45), 420)
  $first = -1
  $last = -1
  for ($y = $minY; $y -le $maxY; $y++) {
    $sat = 0
    for ($x = $minX; $x -lt ($bmp.Width - 8); $x += 3) {
      if (Test-SaturatedPixel $bmp.GetPixel($x, $y)) { $sat++ }
    }
    if ($sat -ge 18) {
      if ($first -lt 0) { $first = $y }
      $last = $y
    } elseif ($first -ge 0 -and ($y - $last) -gt 6) {
      break
    }
  }
  if ($first -lt 0) { return $null }
  return [pscustomobject]@{ Top = $first; Bottom = $last; Height = ($last - $first + 1) }
}

# Grow Cubase height into free work-area space and thicken the Arranger Track lane.
# Never maximize. Never Shift+F / Zoom Full.
function Expand-ArrangerLayout($win) {
  $work = Get-ScreenWorkArea
  $beforeH = $win.Height
  $beforeW = $win.Width
  $targetH = [Math]::Min($beforeH + 180, ($work.Bottom - $win.Top - 6))
  $targetH = [Math]::Max($beforeH, $targetH)
  $grown = $false
  if ($targetH -gt ($beforeH + 20)) {
    [void][CubaseUi]::SetWindowPos(
      $win.Handle, [IntPtr]::Zero,
      $win.Left, $win.Top, $win.Width, $targetH,
      ([CubaseUi]::SWP_NOZORDER -bor [CubaseUi]::SWP_NOACTIVATE)
    )
    Start-Sleep -Milliseconds 220
    $win = Refresh-CubaseWindow $win.Process
    $grown = ($win.Height -gt $beforeH)
  }

  $cap = Capture-CubaseBitmap $win
  $bmp = $cap.Bitmap
  $win = $cap.Window
  try {
    $span = Measure-ArrangerLaneSpan $bmp
    $laneGrew = $false
    $laneBefore = 0
    $laneAfter = 0
    if ($span) {
      $laneBefore = [int]$span.Height
      # Cubase track resize handle sits on the bottom edge of the track
      # (header column, left of the event blocks). Drag that edge down.
      if ($span.Height -lt 70) {
        $need = 90 - $span.Height
        # Track-list header column (left of event blocks) — ~0.32 works; 0.38 often misses.
        $dragXs = @(
          [int]($bmp.Width * 0.32),
          [int]($bmp.Width * 0.36),
          [int]($bmp.Width * 0.40)
        )
        $y0 = [Math]::Min($bmp.Height - 8, $span.Bottom + 1)
        $y1 = [Math]::Min($bmp.Height - 8, $y0 + [Math]::Max(40, $need + 20))
        foreach ($dragX in $dragXs) {
          Invoke-MouseDrag $win $dragX $y0 $dragX $y1 28
          Start-Sleep -Milliseconds 250
          $cap2 = Capture-CubaseBitmap $win
          $bmp2 = $cap2.Bitmap
          $win = $cap2.Window
          try {
            $span2 = Measure-ArrangerLaneSpan $bmp2
            if ($span2) {
              $laneAfter = [int]$span2.Height
              $laneGrew = ($laneAfter -gt $laneBefore)
              if ($laneGrew) { break }
            }
          } finally {
            $bmp2.Dispose()
          }
        }
      } else {
        $laneAfter = $laneBefore
      }
    }

    # Give Current Chain more vertical room: drag Arranger Events header down a bit.
    $chainGrew = $false
    $ocrPath = Join-Path $OutDir 'expand_ocr.png'
    Save-ScaledCrop $bmp 8 160 ([Math]::Min(320, $bmp.Width - 16)) ([Math]::Min(420, $bmp.Height - 180)) 1 $ocrPath 0
    $ocrBmp = [System.Drawing.Bitmap]::FromFile($ocrPath)
    try {
      $ocr = Invoke-OcrBitmap $ocrBmp ($ocrPath + '.run.png')
    } finally {
      $ocrBmp.Dispose()
    }
    $eventsY = -1
    foreach ($line in $ocr.Lines) {
      $text = ($line.Text -replace '\s+', ' ').Trim()
      if ($text -notmatch '(?i)Arranger\s*Events') { continue }
      $box = Get-LineRect $line
      if (-not $box) { continue }
      $eventsY = 160 + [int]($box.Y + $box.Height / 2)
      break
    }
    if ($eventsY -gt 220 -and $eventsY -lt [int]($win.Height * 0.48)) {
      # Drag the splitter under Current Chain downward so more chain rows show.
      $sx = 90
      $sy0 = $eventsY - 2
      $sy1 = [Math]::Min($win.Height - 100, $eventsY + 70)
      if ($sy1 -gt ($sy0 + 24)) {
        Invoke-MouseDrag $win $sx $sy0 $sx $sy1 16
        $chainGrew = $true
        Start-Sleep -Milliseconds 200
      }
    }

    $win = Refresh-CubaseWindow $win.Process
    return [pscustomobject]@{
      ok = $true
      windowGrown = $grown
      width = $win.Width
      height = $win.Height
      heightBefore = $beforeH
      laneBefore = $laneBefore
      laneAfter = $laneAfter
      laneGrew = $laneGrew
      chainGrew = $chainGrew
      eventsSplitterY = $eventsY
    }
  } finally {
    $bmp.Dispose()
  }
}

function Capture-CubaseBitmap($win) {
  $fresh = Refresh-CubaseWindow $win.Process
  if ($fresh.Width -lt 80 -or $fresh.Height -lt 80) {
    throw "Cubase window too small for capture ($($fresh.Width)x$($fresh.Height))"
  }
  try { [void][CubaseUi]::SetForegroundWindow($fresh.Handle) } catch { }
  Start-Sleep -Milliseconds 80
  $bmp = New-Object System.Drawing.Bitmap $fresh.Width, $fresh.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdcDest = $g.GetHdc()
  try {
    # PrintWindow captures Cubase even when ViewerOne is on top of it.
    $printed = [CubaseUi]::PrintWindow($fresh.Handle, $hdcDest, [CubaseUi]::PW_RENDERFULLCONTENT)
    if (-not $printed) {
      $hdcSrc = [CubaseUi]::GetDC($fresh.Handle)
      try {
        [void][CubaseUi]::BitBlt($hdcDest, 0, 0, $fresh.Width, $fresh.Height, $hdcSrc, 0, 0, [CubaseUi]::SRCCOPY)
      } finally {
        [void][CubaseUi]::ReleaseDC($fresh.Handle, $hdcSrc)
      }
    }
  } finally {
    $g.ReleaseHdc($hdcDest)
    $g.Dispose()
  }
  return @{ Bitmap = $bmp; Window = $fresh }
}

function Invoke-OcrBitmap([System.Drawing.Bitmap]$bmp, [string]$tempPath) {
  $bmp.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tempPath)) ([Windows.Storage.StorageFile])
  $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $softwareBitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) { throw 'Windows OCR language pack not available' }
    return Await-WinRt ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally {
    $stream.Dispose()
  }
}

function Save-ThickenedCrop(
  [System.Drawing.Bitmap]$src,
  [int]$x, [int]$y, [int]$w, [int]$h,
  [string]$path,
  [int]$scale = 18,
  [int]$threshold = 70
) {
  $pad = 36
  $bw = $w * $scale + $pad * 2
  $bh = $h * $scale + $pad * 2
  $bmp = New-Object System.Drawing.Bitmap $bw, $bh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  for ($row = 0; $row -lt $h; $row++) {
    for ($col = 0; $col -lt $w; $col++) {
      $px = [Math]::Min($src.Width - 1, $x + $col)
      $py = [Math]::Min($src.Height - 1, $y + $row)
      $p = $src.GetPixel($px, $py)
      $lum = [int](0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
      if ($lum -gt $threshold) {
        $g.FillRectangle(
          [System.Drawing.Brushes]::Black,
          ($pad + $col * $scale - 2),
          ($pad + $row * $scale - 2),
          ($scale + 4),
          ($scale + 4)
        )
      }
    }
  }
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Get-WordRect($word) {
  $br = $word.BoundingRect
  return [pscustomobject]@{
    X = [int][double]("$($br.X)")
    Y = [int][double]("$($br.Y)")
    Width = [int][double]("$($br.Width)")
    Height = [int][double]("$($br.Height)")
  }
}

function Get-LineRect($line) {
  if (-not $line.Words -or @($line.Words).Count -lt 1) { return $null }
  $xs = @(); $ys = @(); $rights = @(); $bottoms = @()
  foreach ($word in @($line.Words)) {
    $r = Get-WordRect $word
    $xs += $r.X; $ys += $r.Y
    $rights += ($r.X + $r.Width)
    $bottoms += ($r.Y + $r.Height)
  }
  if ($xs.Count -lt 1) { return $null }
  $x = ($xs | Measure-Object -Minimum).Minimum
  $y = ($ys | Measure-Object -Minimum).Minimum
  $right = ($rights | Measure-Object -Maximum).Maximum
  $bottom = ($bottoms | Measure-Object -Maximum).Maximum
  return [pscustomobject]@{
    X = [int]$x
    Y = [int]$y
    Width = [int]($right - $x)
    Height = [int]($bottom - $y)
  }
}

function Find-WordBox($ocrResult, [string]$pattern, [int]$nearY = -1, [int]$yTolerance = 18) {
  $best = $null
  $bestScore = -999999
  foreach ($line in $ocrResult.Lines) {
    foreach ($word in @($line.Words)) {
      if ($word.Text -notmatch $pattern) { continue }
      $r = Get-WordRect $word
      # Info line is in the upper inspector/project strip � prefer ~90�200, reject deep UI.
      $score = 100
      if ($r.Y -ge 70 -and $r.Y -le 200) { $score += 80 }
      elseif ($r.Y -lt 70) { $score += 10 }
      else { $score -= 60 }
      if ($nearY -ge 0) {
        $dy = [Math]::Abs($r.Y - $nearY)
        if ($dy -le $yTolerance) { $score += (40 - $dy) }
        else { $score -= 30 }
      }
      if ($score -gt $bestScore) {
        $bestScore = $score
        $best = [pscustomobject]@{
          Text = $word.Text
          X = $r.X; Y = $r.Y; Width = $r.Width; Height = $r.Height
          Score = $score
        }
      }
    }
  }
  return $best
}

function Get-ColumnCrop($box, [int]$fallbackX, [int]$fallbackW, [int]$bitmapWidth) {
  if ($box) {
    $x = [Math]::Max(0, $box.X - 8)
    $w = [Math]::Max(70, $box.Width + 70)
    return @{ x = $x; w = [Math]::Min($w, $bitmapWidth - $x) }
  }
  return @{ x = $fallbackX; w = [Math]::Min($fallbackW, $bitmapWidth - $fallbackX) }
}

function Normalize-Title([string]$text) {
  $t = [string]$text
  $t = $t.ToLowerInvariant()
  $t = $t -replace "[''`�]", ''
  # Windows OCR often reads "I'm" as "1m" / "I" as "1".
  $t = $t -replace '\b1m\b', 'im'
  $t = $t -replace '\b1\b(?=\s*[a-z])', 'i'
  $t = $t -replace '\b5oundcheck\b', 'soundcheck'
  $t = $t -replace '[^a-z0-9]+', ' '
  $t = ($t -replace '\s+', ' ').Trim()
  # Cubase Current Chain labels OUTRO as "END SONGS".
  if ($t -match '^(end songs|end song)\b') { $t = 'outro' }
  if ($t -match '^outro\b') { $t = 'outro ' + ($t -replace '^outro\s*', '') }
  # Cubase / OCR often splits it: "Sound Check" vs setlist "Soundcheck (Reflex)".
  if ($t -match '^sound check\b') { $t = 'soundcheck ' + ($t -replace '^sound check\s*', '') }
  return $t.Trim()
}

function Titles-FuzzyMatch([string]$a, [string]$b) {
  $na = Normalize-Title $a
  $nb = Normalize-Title $b
  if (-not $na -or -not $nb) { return $false }
  if ($na -eq $nb) { return $true }
  if ($na -like "*$nb*" -or $nb -like "*$na*") { return $true }
  $compactA = ($na -replace '[^a-z0-9]', '')
  $compactB = ($nb -replace '[^a-z0-9]', '')
  if ($compactA.Length -ge 6 -and $compactB.Length -ge 5) {
    if ($compactA.StartsWith($compactB.Substring(0, [Math]::Min(5, $compactB.Length))) -or
        $compactB.StartsWith($compactA.Substring(0, [Math]::Min(5, $compactA.Length)))) {
      return $true
    }
    if ($compactA.Contains($compactB) -or $compactB.Contains($compactA)) { return $true }
  }
  $a0 = ($na.Split(' ') | Select-Object -First 1)
  $b0 = ($nb.Split(' ') | Select-Object -First 1)
  if ($a0 -and $a0 -eq $b0 -and $a0 -match '^(intro|outro|soundcheck)$') { return $true }
  # OUTRO setlist title vs chain "END SONGS"
  if (($a0 -eq 'outro' -and $nb -match '^(outro|end songs|end song)\b') -or
      ($b0 -eq 'outro' -and $na -match '^(outro|end songs|end song)\b')) {
    return $true
  }
  $minLen = [Math]::Min($na.Length, $nb.Length)
  if ($minLen -ge 5) {
    $prefix = $na.Substring(0, [Math]::Min(12, $na.Length))
    if ($nb -like "*$prefix*") { return $true }
    $prefixB = $nb.Substring(0, [Math]::Min(12, $nb.Length))
    if ($na -like "*$prefixB*") { return $true }
    if ($na.StartsWith($nb) -or $nb.StartsWith($na)) { return $true }
  }
  $aTok = @($na.Split(' ') | Where-Object { $_.Length -gt 1 })
  if ($aTok.Count -ge 2) {
    $head = $aTok[0] + ' ' + $aTok[1]
    if ($head.Length -ge 5 -and ($na.StartsWith($head) -and $nb.StartsWith($head))) { return $true }
  }
  return $false
}

# Lane OCR is noisy. Only click a block whose OCR is clearly this title �
# the 12-character prefix matcher was clicking "Let me entertain you".
function Titles-ClickMatch([string]$ocr, [string]$want) {
  $na = Normalize-Title $ocr
  $nb = Normalize-Title $want
  if (-not $na -or -not $nb) { return $false }
  if ($na -eq $nb) { return $true }
  if ($nb.Length -ge 5 -and $na.Contains($nb)) { return $true }
  if ($na.Length -ge 5 -and $nb.Contains($na)) { return $true }
  $compactA = ($na -replace '[^a-z0-9]', '')
  $compactB = ($nb -replace '[^a-z0-9]', '')
  if ($compactA -and $compactB -and ($compactA.StartsWith('soundcheck') -or $compactA.StartsWith('5oundcheck')) -and ($compactB.StartsWith('soundcheck') -or $compactB.StartsWith('5oundcheck'))) {
    return $true
  }
  if ($compactA.Length -ge 5 -and $compactB.Contains($compactA)) { return $true }
  if ($compactB.Length -ge 5 -and $compactA.Contains($compactB)) { return $true }
  $a0 = ($na.Split(' ') | Select-Object -First 1)
  $b0 = ($nb.Split(' ') | Select-Object -First 1)
  if ($a0 -and $a0 -eq $b0 -and $a0 -match '^(intro|outro|soundcheck)$') { return $true }
  return $false
}

# Extract Name value text near the Name label (Windows OCR � full text, not digit-only).
function Get-InfoLineNameValue($ocrResult, $nameBox, $startBox, [int]$valueY) {
  if (-not $nameBox) { return '' }
  $nameRight = $nameBox.X + $nameBox.Width
  $startLeft = if ($startBox) { $startBox.X } else { $nameRight + 420 }
  $yMin = [Math]::Min($nameBox.Y, $valueY) - 6
  $yMax = [Math]::Max($nameBox.Y + $nameBox.Height, $valueY + 18) + 10
  $parts = @()
  foreach ($line in $ocrResult.Lines) {
    foreach ($word in @($line.Words)) {
      $t = [string]$word.Text
      if ($t -match '(?i)^(Name|Start|End|Length|Type|Pitch)$') { continue }
      $r = Get-WordRect $word
      $cx = $r.X + [int]($r.Width / 2)
      $cy = $r.Y + [int]($r.Height / 2)
      if ($cx -lt ($nameRight - 4)) { continue }
      if ($cx -gt ($startLeft - 4)) { continue }
      if ($cy -lt $yMin -or $cy -gt $yMax) { continue }
      $parts += [pscustomobject]@{ X = $r.X; Text = $t }
    }
  }
  if ($parts.Count -lt 1) { return '' }
  $ordered = $parts | Sort-Object X
  return (($ordered | ForEach-Object { $_.Text }) -join ' ').Trim()
}

# Real mouse click at bitmap coords inside the Cubase window, then restore the cursor.
# Cubase's custom canvas ignores PostMessage. Never double-click: Cubase treats
# a double-click on an event as Play. Never click the bottom transport bar.
function Invoke-SafeArrangerClick($win, [int]$bitmapX, [int]$bitmapY, [switch]$DoubleClick, [switch]$AllowLocator, [switch]$AllowEventsSelect) {
  $health = Test-CubaseAlive
  if (-not $health.alive) { throw 'Cubase process gone before click' }

  # Menu / toolbar / info strip
  if ($bitmapY -lt 100) { throw 'Refusing click in menu/toolbar band' }
  # Cubase 15 transport + metronome sit on the BOTTOM bar (Play lives here)
  if ($bitmapY -gt [int]($win.Height * 0.78)) { throw 'Refusing click in bottom transport/metronome band' }
  $fracX = $bitmapX / [double]$win.Width
  if ($AllowLocator) {
    # Current Chain / Events row play arrow � locates, does not start transport.
    if ($fracX -lt 0.004 -or $fracX -gt 0.09) { throw 'Locator click must be on the chain-row play arrow' }
  } elseif ($AllowEventsSelect) {
    if ($fracX -lt 0.04 -or $fracX -gt 0.40) { throw 'Events-list click must stay in the inspector' }
  } else {
    if ($fracX -lt 0.10) { throw 'Refusing click on chain play-arrow unless AllowLocator' }
    if ($fracX -ge 0.42 -and $fracX -lt 0.52) { throw 'Refusing click in track-name column' }
  }
  if ($DoubleClick) {
    throw 'Refusing double-click (Cubase starts playback from the event)'
  }

  $screenX = $win.Left + $bitmapX
  $screenY = $win.Top + $bitmapY
  $saved = New-Object CubaseUi+POINT
  [void][CubaseUi]::GetCursorPos([ref]$saved)

  $ourTid = [CubaseUi]::GetCurrentThreadId()
  $cubaseTid = [CubaseUi]::GetWindowThreadProcessId($win.Handle, [IntPtr]::Zero)
  $attached = $false
  if ($cubaseTid -ne 0 -and $cubaseTid -ne $ourTid) {
    $attached = [CubaseUi]::AttachThreadInput($ourTid, $cubaseTid, $true)
  }
  try {
    try {
      [void][CubaseUi]::SetForegroundWindow($win.Handle)
    } catch { }
    Start-Sleep -Milliseconds 40
    [void][CubaseUi]::SetCursorPos($screenX, $screenY)
    Start-Sleep -Milliseconds 30
    [CubaseUi]::SendLeftClickAt($screenX, $screenY)
    if ($DoubleClick) {
      Start-Sleep -Milliseconds 50
      [CubaseUi]::SendLeftClick()
      Start-Sleep -Milliseconds 350
    } else {
      Start-Sleep -Milliseconds 220
    }
  } finally {
    [void][CubaseUi]::SetCursorPos($saved.X, $saved.Y)
    if ($attached) { [void][CubaseUi]::AttachThreadInput($ourTid, $cubaseTid, $false) }
  }

  $after = Test-CubaseAlive
  if (-not $after.alive) { throw 'Cubase process exited after mouse click' }
  return $true
}

function Ocr-ImageFile([string]$path) {
  if (-not $path -or -not (Test-Path $path)) { return '' }
  $bmp = [System.Drawing.Bitmap]::FromFile($path)
  try {
    $ocrPath = $path + '.winocr.png'
    $result = Invoke-OcrBitmap $bmp $ocrPath
    return ([string]$result.Text).Trim()
  } catch {
    return ''
  } finally {
    $bmp.Dispose()
  }
}

function Test-SaturatedPixel([System.Drawing.Color]$p) {
  $maxc = [Math]::Max($p.R, [Math]::Max($p.G, $p.B))
  $minc = [Math]::Min($p.R, [Math]::Min($p.G, $p.B))
  return (($maxc - $minc) -gt 55 -and $maxc -gt 70)
}

function Find-ArrangerLane([System.Drawing.Bitmap]$bmp) {
  # Arranger Track sits in the TOP of the project zone. MIDI/audio lanes
  # below have more hue changes and must not win this search.
  $minX = [int]($bmp.Width * 0.55)
  $minY = 150
  $maxY = [Math]::Min([int]($bmp.Height * 0.42), 380)

  # Primary: OCR the track-header strip for "Arranger Track" (not MIDI/audio lanes below).
  $hdrX = [int]($bmp.Width * 0.30)
  $hdrW = [Math]::Max(80, $minX - $hdrX + 12)
  $hdrH = $maxY - $minY
  if ($hdrW -gt 40 -and $hdrH -gt 40) {
    $hdrPath = Join-Path $OutDir 'arranger_hdr.png'
    Save-ScaledCrop $bmp $hdrX $minY $hdrW $hdrH 2 $hdrPath 0
    $hdrBmp = [System.Drawing.Bitmap]::FromFile($hdrPath)
    try {
      $hdrOcr = Invoke-OcrBitmap $hdrBmp ($hdrPath + '.run.png')
    } finally {
      $hdrBmp.Dispose()
    }
    $scale = 2
    foreach ($line in $hdrOcr.Lines) {
      $text = ($line.Text -replace '\s+', ' ').Trim()
      if ($text -notmatch '(?i)Arranger') { continue }
      if ($text -match '(?i)(Events|Inspector|Current\s*Chain)') { continue }
      $box = Get-LineRect $line
      if (-not $box) { continue }
      $cy = $minY + [int](($box.Y + $box.Height / 2) / $scale)
      if ($cy -ge $minY -and $cy -le $maxY) {
        return [pscustomobject]@{ Y = $cy; FirstX = $minX; MinX = $minX; Sat = 99; Source = 'ocr-header' }
      }
    }
  }

  # Prefer the saturated strip (Arranger events). A single long event has 0 hue
  # runs � that is still the Arranger lane, not a reason to search MIDI below.
  $bestY = -1
  $bestSat = 0
  $bestRuns = -1
  $bestFirst = $minX
  $y = $minY
  while ($y -le $maxY) {
    $runs = 0
    $last = -2
    $first = -1
    $sat = 0
    for ($x = $minX; $x -lt ($bmp.Width - 8); $x += 2) {
      $bucket = Get-HueBucket $bmp.GetPixel($x, $y)
      if ($bucket -lt 0) { $last = -2; continue }
      $sat++
      if ($first -lt 0) { $first = $x }
      if ($last -ge 0 -and $bucket -ne $last) { $runs++ }
      $last = $bucket
    }
    if ($sat -gt $bestSat -or ($sat -eq $bestSat -and $runs -gt $bestRuns)) {
      $bestSat = $sat
      $bestRuns = $runs
      $bestY = $y
      $bestFirst = $first
    }
    $y++
  }
  if ($bestY -ge 0 -and $bestSat -ge 12) {
    return [pscustomobject]@{ Y = $bestY; FirstX = $bestFirst; MinX = $minX; Sat = $bestSat; Source = 'hue-runs' }
  }
  return $null
}

function Find-PlayheadX([System.Drawing.Bitmap]$bmp, [int]$minX, [int]$minY, [int]$maxY) {
  $bestX = -1
  $best = 0
  $minY = [Math]::Max(0, $minY)
  $maxY = [Math]::Min($bmp.Height - 1, $maxY)
  if ($maxY -le $minY) { return -1 }
  for ($x = $minX; $x -lt ($bmp.Width - 4); $x++) {
    $n = 0
    for ($y = $minY; $y -le $maxY; $y += 2) {
      $p = $bmp.GetPixel($x, $y)
      $white = ($p.R -gt 200 -and $p.G -gt 200 -and $p.B -gt 200)
      $red = ($p.R -gt 200 -and $p.G -lt 90 -and $p.B -lt 90)
      if ($white -or $red) { $n++ }
    }
    if ($n -gt $best) { $best = $n; $bestX = $x }
  }
  if ($best -lt 4) { return -1 }
  return $bestX
}

# Click inside a coloured Arranger block just to the right of the playhead.
# Never click a gap � that clears the Info Line to "No Object Selected".
function Find-BlockClickX([System.Drawing.Bitmap]$bmp, [int]$ph, [int]$laneY, [int]$minX) {
  $x0 = [Math]::Max($minX, $ph + 2)
  $x1 = [Math]::Min($bmp.Width - 8, $ph + 48)
  for ($x = $x0; $x -le $x1; $x++) {
    if (Test-SaturatedPixel $bmp.GetPixel($x, $laneY)) {
      return [Math]::Min($bmp.Width - 8, $x + 3)
    }
  }
  return -1
}

function Invoke-TimelineZoom($win, [int]$wheelDelta) {
  try { [void][CubaseUi]::SetForegroundWindow($win.Handle) } catch { }
  $sx = $win.Left + [int]($win.Width * 0.72)
  $sy = $win.Top + 230
  [void][CubaseUi]::SetCursorPos($sx, $sy)
  Start-Sleep -Milliseconds 40
  [CubaseUi]::keybd_event([CubaseUi]::VK_CONTROL, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 20
  [CubaseUi]::ScrollWheel($wheelDelta)
  Start-Sleep -Milliseconds 20
  [CubaseUi]::keybd_event([CubaseUi]::VK_CONTROL, 0, [CubaseUi]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 140
}

function Invoke-ChainScroll($win, [int]$notchesDown, [double]$YFrac = 0.34) {
  try { [void][CubaseUi]::SetForegroundWindow($win.Handle) } catch { }
  $sx = $win.Left + [int]($win.Width * 0.18)
  $sy = $win.Top + [int]($win.Height * $YFrac)
  [void][CubaseUi]::SetCursorPos($sx, $sy)
  Start-Sleep -Milliseconds 40
  $n = [Math]::Max(1, [Math]::Abs($notchesDown))
  $delta = if ($notchesDown -ge 0) { -120 * $n } else { 120 * $n }
  [CubaseUi]::ScrollWheel($delta)
  Start-Sleep -Milliseconds 180
}

function Test-RowHighlighted([System.Drawing.Bitmap]$bmp, [int]$rowY) {
  $y = [Math]::Max(0, [Math]::Min($bmp.Height - 1, $rowY))
  $bright = 0
  $n = 0
  $x1 = [Math]::Min($bmp.Width - 1, 200)
  for ($x = 48; $x -le $x1; $x += 4) {
    $p = $bmp.GetPixel($x, $y)
    $lum = [int](0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
    if ($lum -gt 155) { $bright++ }
    $n++
  }
  return ($n -gt 0 -and ($bright / $n) -gt 0.3)
}

function Find-ChainRow([System.Drawing.Bitmap]$bmp, [string]$name, [bool]$EventsList = $false) {
  $hdrX = 8
  $hdrW = [int]($bmp.Width * 0.28)
  if ($EventsList) {
    $hdrY = [Math]::Max(280, [int]($bmp.Height * 0.38))
    $hdrH = [Math]::Min($bmp.Height - $hdrY - 8, [int]($bmp.Height * 0.40))
  } else {
    $hdrY = 120
    $hdrH = [Math]::Min(420, [int]($bmp.Height * 0.55) - 20)
  }
  if ($hdrW -lt 80 -or $hdrH -lt 80) { return $null }
  $chainPath = Join-Path $OutDir 'chain_ocr.png'
  Save-ScaledCrop $bmp $hdrX $hdrY $hdrW $hdrH 2 $chainPath 0
  $chainBmp = [System.Drawing.Bitmap]::FromFile($chainPath)
  try {
    $chainOcr = Invoke-OcrBitmap $chainBmp ($chainPath + '.run.png')
  } finally {
    $chainBmp.Dispose()
  }
  $scale = 2
  $eventsHeaderY = 9999
  foreach ($line in $chainOcr.Lines) {
    $text = ($line.Text -replace '\s+', ' ').Trim()
    if ($text -match '(?i)Arranger\s*Events') {
      $box = Get-LineRect $line
      if ($box) { $eventsHeaderY = $hdrY + [int](($box.Y + $box.Height) / $scale) }
    }
  }
  $bestY = -1
  $bestNameX = -1
  $bestScore = -1
  foreach ($line in $chainOcr.Lines) {
    $text = ($line.Text -replace '\s+', ' ').Trim()
    if (-not $text) { continue }
    if ($text -match '(?i)^(Arranger|Current\s*Chain|Inspector|Events)') { continue }
    if (-not (Titles-FuzzyMatch $text $name)) { continue }
    $box = Get-LineRect $line
    if (-not $box) { continue }
    $cy = $hdrY + [int](($box.Y + $box.Height / 2) / $scale)
    if ($EventsList) {
      if ($cy -le ($eventsHeaderY + 4)) { continue }
    } else {
      if ($cy -ge $eventsHeaderY) { continue }
    }
    if ($cy -lt 130 -or $cy -gt [int]($bmp.Height * 0.78)) { continue }
    $nameX = $hdrX + [int]($box.X / $scale)
    # Chain titles sit just right of the colour chip (~50�90px). A match at x=300 is
    # the timeline / track header, not the inspector row.
    if ($nameX -gt 160) { continue }
    $score = 40
    if ((Normalize-Title $text) -eq (Normalize-Title $name)) { $score += 80 }
    if (Test-RowHighlighted $bmp $cy) { $score += 60 }
    if ($score -gt $bestScore) {
      $bestScore = $score
      $bestY = $cy
      $bestNameX = $nameX
    }
  }
  if ($bestY -lt 0) { return $null }
  return [pscustomobject]@{ Y = $bestY; NameX = $bestNameX }
}

# When title OCR misses a Current Chain row (e.g. "Reach for the stars" often
# blank in WinOCR), fall back to the bright/highlighted row MIDI Next selected.
function Find-HighlightedChainRow([System.Drawing.Bitmap]$bmp) {
  $hdrX = 8
  $hdrW = [int]($bmp.Width * 0.28)
  $hdrY = 200
  $hdrH = [Math]::Min(400, [int]($bmp.Height * 0.55) - 20)
  if ($hdrW -lt 80 -or $hdrH -lt 80) { return $null }
  # Prefer a row whose left strip is brightly selected (Cubase highlight).
  $bestY = -1
  $bestBright = 0
  $y0 = $hdrY
  $y1 = $hdrY + $hdrH
  for ($y = $y0; $y -le $y1; $y += 2) {
    if (-not (Test-RowHighlighted $bmp $y)) { continue }
    # Must look like a chain row: colour chip somewhere in x=20..70.
    $chip = $false
    for ($x = 20; $x -le 70; $x += 2) {
      $p = $bmp.GetPixel($x, $y)
      if (Test-SaturatedPixel $p) { $chip = $true; break }
    }
    if (-not $chip) { continue }
    $bright = 0
    $n = 0
    for ($x = 48; $x -le 180; $x += 3) {
      $p = $bmp.GetPixel($x, $y)
      $lum = [int](0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
      if ($lum -gt 155) { $bright++ }
      $n++
    }
    $score = if ($n -gt 0) { $bright / $n } else { 0 }
    if ($score -gt $bestBright) {
      $bestBright = $score
      $bestY = $y
    }
  }
  if ($bestY -lt 0 -or $bestBright -lt 0.25) { return $null }
  return [pscustomobject]@{ Y = $bestY; NameX = 70 }
}

# Also try a tight per-row OCR pass for stubborn titles (Reach).
function Find-ChainRowByRowOcr([System.Drawing.Bitmap]$bmp, [string]$name) {
  $hdrX = 48
  $hdrW = 200
  $yStart = 240
  $yEnd = [Math]::Min(700, [int]($bmp.Height * 0.72))
  $needle = Normalize-Title $name
  if (-not $needle) { return $null }
  for ($y = $yStart; $y -le $yEnd; $y += 22) {
    $path = Join-Path $OutDir 'chain_row.png'
    Save-ScaledCrop $bmp $hdrX $y $hdrW 20 4 $path 0
    $rb = [System.Drawing.Bitmap]::FromFile($path)
    try {
      $ocr = Invoke-OcrBitmap $rb ($path + '.run.png')
    } finally {
      $rb.Dispose()
    }
    $text = ([string]$ocr.Text -replace '\s+', ' ').Trim()
    if (-not $text) { continue }
    if (-not (Titles-FuzzyMatch $text $name)) { continue }
    return [pscustomobject]@{ Y = ($y + 10); NameX = 70 }
  }
  return $null
}

# Cubase 15 Current Chain / Arranger Events row (left ? right) is either
#   [play triangle] [color chip] [title]
# or
#   [color chip] [play triangle] [title]
# Title OCR starts at NameX. Never clamp into the title (that only highlights
# the row � Info Line stays on the previous timeline event).
function Find-RowLocatorCandidates([System.Drawing.Bitmap]$bmp, [int]$rowY, [int]$nameX) {
  $left = 6
  $right = [Math]::Max($left + 10, [Math]::Min($nameX - 2, 88))
  $y0 = [Math]::Max(0, $rowY - 7)
  $y1 = [Math]::Min($bmp.Height - 1, $rowY + 7)
  # Colour chip = first saturated vertical run left of the title.
  $chipLeft = -1
  $chipRight = -1
  for ($x = $left; $x -le $right; $x++) {
    $sat = 0
    for ($y = $y0; $y -le $y1; $y += 2) {
      $p = $bmp.GetPixel($x, $y)
      $d = [Math]::Max($p.R, [Math]::Max($p.G, $p.B)) - [Math]::Min($p.R, [Math]::Min($p.G, $p.B))
      if ($d -gt $sat) { $sat = $d }
    }
    if ($sat -gt 50) {
      if ($chipLeft -lt 0) { $chipLeft = $x }
      $chipRight = $x
    } elseif ($chipLeft -ge 0 -and ($x - $chipRight) -ge 3) {
      break
    }
  }
  # Play triangle = grey (mid lum, low sat) peak just LEFT of the chip.
  $triLimit = if ($chipLeft -gt 12) { $chipLeft - 2 } else { $right }
  $triX = -1
  $triN = 0
  for ($x = $left; $x -le $triLimit; $x++) {
    $n = 0
    for ($y = $y0; $y -le $y1; $y++) {
      $p = $bmp.GetPixel($x, $y)
      $lum = [int](0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
      $sat = [Math]::Max($p.R, [Math]::Max($p.G, $p.B)) - [Math]::Min($p.R, [Math]::Min($p.G, $p.B))
      if ($lum -gt 70 -and $lum -lt 180 -and $sat -lt 30) { $n++ }
    }
    if ($n -gt $triN) { $triN = $n; $triX = $x }
  }
  if ($chipLeft -ge 0 -and $chipLeft -lt 30) { $chipLeft = -1 }
  $xs = @()
  # Cubase 15 play triangle is ~14px left of the colour chip (~x=41 ? x=27).
  if ($chipLeft -ge 30) {
    $xs += [int]($chipLeft - 14)
    $xs += [int]($chipLeft - 10)
    $xs += [int]($chipLeft - 18)
  } else {
    $xs += 27
    $xs += 24
    $xs += 30
  }
  if ($triX -ge 20 -and $triN -ge 3 -and ($chipLeft -lt 0 -or $triX -ge ($chipLeft - 22))) {
    $xs += $triX
  }
  $uniq = @()
  foreach ($x in $xs) {
    if ($x -lt 8) { continue }
    if ($chipLeft -ge 30 -and $x -ge ($chipLeft - 3)) { continue }
    $dup = $false
    foreach ($u in $uniq) {
      if ([Math]::Abs($u - $x) -le 2) { $dup = $true; break }
    }
    if (-not $dup) { $uniq += [int]$x }
  }
  if ($uniq.Count -lt 1) { $uniq = @(27) }
  return [pscustomobject]@{
    Xs = $uniq
    ChipX = $(if ($chipLeft -ge 0) { [int](($chipLeft + $chipRight) / 2) } else { -1 })
    ChipLeft = $chipLeft
    TriX = $(if ($triN -ge 3) { $triX } else { -1 })
  }
}

function Save-ScaledCrop(
  [System.Drawing.Bitmap]$src,
  [int]$x, [int]$y, [int]$w, [int]$h,
  [int]$scale,
  [string]$path,
  [int]$pad = 16
) {
  $x = [Math]::Max(0, $x)
  $y = [Math]::Max(0, $y)
  $w = [Math]::Max(8, [Math]::Min($w, $src.Width - $x))
  $h = [Math]::Max(6, [Math]::Min($h, $src.Height - $y))
  $c = $src.Clone([System.Drawing.Rectangle]::new($x, $y, $w, $h), $src.PixelFormat)
  $up = New-Object System.Drawing.Bitmap (($w * $scale) + ($pad * 2)), (($h * $scale) + ($pad * 2))
  $g = [System.Drawing.Graphics]::FromImage($up)
  $g.Clear([System.Drawing.Color]::FromArgb(32, 32, 32))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g.DrawImage($c, $pad, $pad, ($w * $scale), ($h * $scale))
  $g.Dispose()
  $c.Dispose()
  $up.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $up.Dispose()
}

function Invoke-CubaseStop($win) {
  try {
    [void][CubaseUi]::SetForegroundWindow($win.Handle)
  } catch { }
  Start-Sleep -Milliseconds 40
  [CubaseUi]::keybd_event([CubaseUi]::VK_NUMPAD0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [CubaseUi]::keybd_event([CubaseUi]::VK_NUMPAD0, 0, [CubaseUi]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}

function Invoke-CubaseChord($win, [byte]$mod, [byte]$vk) {
  try {
    [void][CubaseUi]::SetForegroundWindow($win.Handle)
  } catch { }
  Start-Sleep -Milliseconds 40
  [CubaseUi]::keybd_event($mod, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 20
  [CubaseUi]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [CubaseUi]::keybd_event($vk, 0, [CubaseUi]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 20
  [CubaseUi]::keybd_event($mod, 0, [CubaseUi]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
}

function Invoke-CubaseKey($win, [byte]$vk) {
  try {
    [void][CubaseUi]::SetForegroundWindow($win.Handle)
  } catch { }
  Start-Sleep -Milliseconds 40
  [CubaseUi]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [CubaseUi]::keybd_event($vk, 0, [CubaseUi]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}

function Invoke-CubaseZoomToEvent($win) {
  try {
    [void][CubaseUi]::SetForegroundWindow($win.Handle)
  } catch { }
  Start-Sleep -Milliseconds 50
  [CubaseUi]::keybd_event([CubaseUi]::VK_SHIFT, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 20
  [CubaseUi]::keybd_event([CubaseUi]::VK_E, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [CubaseUi]::keybd_event([CubaseUi]::VK_E, 0, [CubaseUi]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 20
  [CubaseUi]::keybd_event([CubaseUi]::VK_SHIFT, 0, [CubaseUi]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 280
}

function Get-ColorDistance($a, $b) {
  return [Math]::Abs([int]$a.R - [int]$b.R) + [Math]::Abs([int]$a.G - [int]$b.G) + [Math]::Abs([int]$a.B - [int]$b.B)
}

function Get-BlockMeanColor([System.Drawing.Bitmap]$bmp, [int]$x0, [int]$x1, [int]$y) {
  $r = 0; $g = 0; $b = 0; $n = 0
  $y0 = [Math]::Max(0, $y - 2)
  $y1 = [Math]::Min($bmp.Height - 1, $y + 2)
  for ($x = $x0; $x -lt $x1; $x += 2) {
    for ($yy = $y0; $yy -le $y1; $yy++) {
      $p = $bmp.GetPixel($x, $yy)
      if (-not (Test-SaturatedPixel $p)) { continue }
      $r += $p.R; $g += $p.G; $b += $p.B; $n++
    }
  }
  if ($n -lt 4) { return $null }
  return [System.Drawing.Color]::FromArgb([int]($r / $n), [int]($g / $n), [int]($b / $n))
}

function Get-HueBucket([System.Drawing.Color]$p) {
  if (-not (Test-SaturatedPixel $p)) { return -1 }
  return [int]($p.GetHue() / 20)
}

function Get-ArrangerBlocks([System.Drawing.Bitmap]$bmp, $lane) {
  $y = $lane.Y
  $minX = $lane.MinX
  $blocks = @()
  $start = -1
  $lastBucket = -1
  for ($x = $minX; $x -lt ($bmp.Width - 6); $x++) {
    $bucket = Get-HueBucket $bmp.GetPixel($x, $y)
    if ($bucket -lt 0) {
      $bucket = Get-HueBucket $bmp.GetPixel($x, [Math]::Min($bmp.Height - 1, $y + 4))
    }
    if ($bucket -lt 0) {
      $bucket = Get-HueBucket $bmp.GetPixel($x, [Math]::Max(0, $y - 3))
    }
    if ($bucket -lt 0) {
      if ($start -ge 0 -and (($x - $start) -ge 3)) {
        $blocks += [pscustomobject]@{ X0 = $start; X1 = $x; CX = [int](($start + $x) / 2) }
      }
      $start = -1
      $lastBucket = -1
      continue
    }
    if ($start -lt 0) {
      $start = $x
      $lastBucket = $bucket
      continue
    }
    if ($bucket -ne $lastBucket -and (($x - $start) -ge 3)) {
      $blocks += [pscustomobject]@{ X0 = $start; X1 = $x; CX = [int](($start + $x) / 2) }
      $start = $x
    }
    $lastBucket = $bucket
  }
  if ($start -ge 0 -and (($bmp.Width - 6 - $start) -ge 3)) {
    $blocks += [pscustomobject]@{ X0 = $start; X1 = ($bmp.Width - 6); CX = [int](($start + $bmp.Width - 6) / 2) }
  }
  return $blocks
}

# Match Current Chain colour chip to visible Arranger-track blocks (no Zoom Full).
function Find-ChipMatchedBlocks([System.Drawing.Bitmap]$bmp, $lane, $chipColor) {
  if (-not $chipColor) { return @() }
  $chipHue = $chipColor.GetHue()
  $hits = @()
  $seen = @{}
  foreach ($yOff in @(0, 8, 16, 24, 32, 40, 48, 56, -8)) {
    $yLane = [pscustomobject]@{
      Y = [Math]::Max(140, [Math]::Min($bmp.Height - 8, $lane.Y + $yOff))
      MinX = $lane.MinX
    }
    foreach ($b in @(Get-ArrangerBlocks $bmp $yLane)) {
      $c = Get-BlockMeanColor $bmp $b.X0 $b.X1 $yLane.Y
      if (-not $c) { continue }
      $dh = [Math]::Abs($c.GetHue() - $chipHue)
      if ($dh -gt 180) { $dh = 360 - $dh }
      if ($dh -gt 18) { continue }
      $w = $b.X1 - $b.X0
      if ($w -lt 8 -or $w -gt [int]($bmp.Width * 0.28)) { continue }
      $key = [int]($b.CX / 12)
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      $hits += [pscustomobject]@{ CX = $b.CX; Dist = [int]$dh; X0 = $b.X0; X1 = $b.X1; Y = $yLane.Y }
    }
  }
  if ($hits.Count -lt 1) { return @() }
  return @($hits | Sort-Object Dist, CX)
}

function Find-NamedLaneClick([System.Drawing.Bitmap]$bmp, $lane, [string]$name) {
  if (-not $lane) { return $null }
  $minX = if ($lane.MinX -gt 0) { [int]$lane.MinX } else { [int]($bmp.Width * 0.55) }
  $tops = @()
  if ($lane.Source -eq 'none') {
    $tops = @(180, 210, 240, 270)
  } else {
    $tops = @([Math]::Max(140, $lane.Y - 20), 180, 220)
  }
  $best = $null
  $bestScore = -1
  foreach ($laneTop in $tops) {
    $laneH = 56
    if (($laneTop + $laneH) -gt $bmp.Height) { $laneH = $bmp.Height - $laneTop }
    $cropW = $bmp.Width - $minX
    if ($cropW -lt 40 -or $laneH -lt 10) { continue }
    $ocrPath = Join-Path $OutDir 'lane_ocr.png'
    Save-ScaledCrop $bmp $minX $laneTop $cropW $laneH 3 $ocrPath 0
    $scaled = [System.Drawing.Bitmap]::FromFile($ocrPath)
    try {
      $ocr = Invoke-OcrBitmap $scaled ($ocrPath + '.run.png')
    } finally {
      $scaled.Dispose()
    }
    $needle = Normalize-Title $name
    foreach ($line in $ocr.Lines) {
      $text = ($line.Text -replace '\s+', ' ').Trim()
      if (-not $text) { continue }
      $matchText = $text
      if ($text -match '^\s*\d+\s*-\s*(.+)$') {
        # Timeline often shows "11 - Sit down"; use the title after the dash.
        $matchText = ([string]$Matches[1]).Trim()
      }
      if (-not (Titles-ClickMatch $matchText $name)) { continue }
      $box = Get-LineRect $line
      if (-not $box) { continue }
      $scale = 3
      $cx = $minX + [int](($box.X + $box.Width / 2) / $scale)
      $cy = $laneTop + [int](($box.Y + $box.Height / 2) / $scale)
      if ($cx -lt $minX) { continue }
      # Prefer Arranger Track Y when OCR hit a MIDI/audio clip label below it.
      if ($lane.Source -ne 'none' -and [Math]::Abs($cy - $lane.Y) -gt 36) {
        $cy = [int]$lane.Y
      }
      $score = 50
      $lower = Normalize-Title $matchText
      if ($lower -eq $needle) { $score += 100 }
      elseif ($lower -like "*$needle*" -or $needle -like "*$lower*") { $score += 40 }
      if ($score -gt $bestScore) {
        $bestScore = $score
        $best = [pscustomobject]@{ X = $cx; Y = $cy; Text = $matchText }
      }
    }
  }
  return $best
}

function Select-TimelineArrangerEvent($win, [string]$name, $ExcludeX = @(), [int]$LocatorPick = 0, [switch]$DoubleLocator) {
  $cap = Capture-CubaseBitmap $win
  $bmp = $cap.Bitmap
  $win = $cap.Window
  $lane = Find-ArrangerLane $bmp
  if (-not $lane) {
    $lane = [pscustomobject]@{ Y = 200; FirstX = [int]($bmp.Width * 0.55); MinX = [int]($bmp.Width * 0.55); Sat = 0; Source = 'none' }
  }

  $clickX = -1
  $clickY = $lane.Y
  $clicked = ''

  $named = Find-NamedLaneClick $bmp $lane $name
  if ($named) {
    $nx = [int]$named.X
    $excluded = $false
    foreach ($ex in @($ExcludeX)) {
      if ([Math]::Abs($nx - [int]$ex) -le 14) { $excluded = $true; break }
    }
    if (-not $excluded) {
      $clickX = $nx
      $clickY = [int]$named.Y
      $clicked = [string]$named.Text
    }
  }

  # Off-screen: single-click the Current Chain play arrow (locates; does not
  # start transport). Never double-click � Cubase Play-from-event is a double-click.
  if ($clickX -lt 0 -and $name) {
    $row = Find-ChainRow $bmp $name $false
    if (-not $row) {
      $bmp.Dispose()
      Invoke-ChainScroll $win -16 0.34
      $cap = Capture-CubaseBitmap $win
      $bmp = $cap.Bitmap
      $win = $cap.Window
      $row = Find-ChainRow $bmp $name $false
    }
    for ($scroll = 0; $scroll -lt 10 -and -not $row; $scroll++) {
      $bmp.Dispose()
      Invoke-ChainScroll $win 4 0.34
      $cap = Capture-CubaseBitmap $win
      $bmp = $cap.Bitmap
      $win = $cap.Window
      $row = Find-ChainRow $bmp $name $false
    }
    if (-not $row) {
      # Scroll back up and search again (song may be above the viewport).
      for ($scroll = 0; $scroll -lt 10 -and -not $row; $scroll++) {
        $bmp.Dispose()
        Invoke-ChainScroll $win -4 0.34
        $cap = Capture-CubaseBitmap $win
        $bmp = $cap.Bitmap
        $win = $cap.Window
        $row = Find-ChainRow $bmp $name $false
      }
    }
    # Title OCR sometimes blanks a row (Reach). Try per-row OCR, then the
    # MIDI-highlighted Current Chain row (walk already selected it).
    if (-not $row) {
      $row = Find-ChainRowByRowOcr $bmp $name
    }
    if (-not $row) {
      $row = Find-HighlightedChainRow $bmp
      if ($row) {
        # Tag so logs show this was a highlight fallback, not a title OCR hit.
        $script:LastChainRowSource = 'highlight'
      }
    }
    if ($row -and $row.Y -gt 0) {
      $found = Find-RowLocatorCandidates $bmp ([int]$row.Y) ([int]$row.NameX)
      $xs = @($found.Xs)
      if ($xs.Count -lt 1) { $xs = @( [Math]::Max(12, [int]$row.NameX - 38) ) }
      $pick = [Math]::Max(0, $LocatorPick) % $xs.Count
      $locX = [int]$xs[$pick]
      $rowY = [int]$row.Y
      $chipColor = $null
      $chipSampleX = if ($found.ChipX -ge 0) { [int]$found.ChipX } elseif ($found.ChipLeft -ge 0) { [int]($found.ChipLeft + 4) } else { -1 }
      if ($chipSampleX -ge 8) {
        try {
          $chipColor = $bmp.GetPixel($chipSampleX, $rowY)
          if (-not (Test-SaturatedPixel $chipColor)) { $chipColor = $null }
        } catch { $chipColor = $null }
      }
      $bmp.Dispose()
      try {
        [void](Invoke-SafeArrangerClick $win $locX $rowY -AllowLocator)
      } catch {
        return [pscustomobject]@{ ok = $false; error = $_.Exception.Message; clicked = $null; Window = $win }
      }
      Start-Sleep -Milliseconds 700
      $cap = Capture-CubaseBitmap $win
      $bmp = $cap.Bitmap
      $win = $cap.Window
      $lane = Find-ArrangerLane $bmp
      if (-not $lane) {
        $lane = [pscustomobject]@{ Y = 200; FirstX = [int]($bmp.Width * 0.55); MinX = [int]($bmp.Width * 0.55); Sat = 0; Source = 'none' }
      }
      $named2 = Find-NamedLaneClick $bmp $lane $name
      if ($named2) {
        $clickX = [int]$named2.X
        $clickY = [int]$named2.Y
        $clicked = "locate:$($named2.Text)"
      }
      # Colour-chip match on the Arranger Track (after locate may have scrolled
      # the event into view). Never click the playhead � it often still sits on
      # an earlier song and would overwrite the Info Line with the wrong length.
      if ($clickX -lt 0 -and $chipColor) {
        $hits = @(Find-ChipMatchedBlocks $bmp $lane $chipColor)
        $usable = @()
        foreach ($hit in $hits) {
          $hx = [int]$hit.CX
          $excluded = $false
          foreach ($ex in @($ExcludeX)) {
            if ([Math]::Abs($hx - [int]$ex) -le 14) { $excluded = $true; break }
          }
          if (-not $excluded) { $usable += $hit }
        }
        if ($usable.Count -eq 1) {
          $hit = $usable[0]
          $clickX = [int]$hit.CX
          $clickY = [int]$hit.Y
          $clicked = "chip-match:$name"
        } elseif ($usable.Count -gt 1) {
          # Disambiguate same-hue blocks by OCR'ing a small label crop on each.
          foreach ($hit in $usable) {
            $hx = [int]$hit.CX
            $hy = [int]$hit.Y
            $cropX = [Math]::Max([int]$lane.MinX, $hx - 80)
            $cropW = [Math]::Min(200, $bmp.Width - $cropX)
            $labelPath = Join-Path $OutDir 'chip_label.png'
            Save-ScaledCrop $bmp $cropX ([Math]::Max(140, $hy - 14)) $cropW 36 3 $labelPath 0
            $lb = [System.Drawing.Bitmap]::FromFile($labelPath)
            try {
              $locr = Invoke-OcrBitmap $lb ($labelPath + '.run.png')
            } finally {
              $lb.Dispose()
            }
            if (Titles-ClickMatch ([string]$locr.Text) $name) {
              $clickX = $hx
              $clickY = $hy
              $clicked = "chip-ocr:$name"
              break
            }
          }
          # OCR miss � still try the first non-excluded hit; Invoke-Grab retries
          # with ExcludeX when Info Line Name does not match.
          if ($clickX -lt 0) {
            $hit = $usable[0]
            $clickX = [int]$hit.CX
            $clickY = [int]$hit.Y
            $clicked = "chip-try:$name"
          }
        }
      }
      if ($clickX -lt 0) {
        Start-Sleep -Milliseconds 500
        $bmp.Dispose()
        $cap = Capture-CubaseBitmap $win
        $bmp = $cap.Bitmap
        $win = $cap.Window
        $lane = Find-ArrangerLane $bmp
        if (-not $lane) {
          $lane = [pscustomobject]@{ Y = 200; FirstX = [int]($bmp.Width * 0.55); MinX = [int]($bmp.Width * 0.55); Sat = 0; Source = 'none' }
        }
        $named2 = Find-NamedLaneClick $bmp $lane $name
        if ($named2) {
          $clickX = [int]$named2.X
          $clickY = [int]$named2.Y
          $clicked = "locate-retry:$($named2.Text)"
        } elseif ($chipColor) {
          $hits = @(Find-ChipMatchedBlocks $bmp $lane $chipColor)
          $usable = @()
          foreach ($hit in $hits) {
            $hx = [int]$hit.CX
            $excluded = $false
            foreach ($ex in @($ExcludeX)) {
              if ([Math]::Abs($hx - [int]$ex) -le 14) { $excluded = $true; break }
            }
            if (-not $excluded) { $usable += $hit }
          }
          if ($usable.Count -eq 1) {
            $hit = $usable[0]
            $clickX = [int]$hit.CX
            $clickY = [int]$hit.Y
            $clicked = "chip-match-retry:$name"
          }
        }
      }
      if ($clickX -lt 0) {
        # Locator alone does not fill the Info Line � fail so the scan can retry.
        $bmp.Dispose()
        return [pscustomobject]@{
          ok = $false
          error = "Arranger event '$name' located in chain but not visible on timeline to click"
          clicked = "chain-locator-miss:$name"
          x = $locX
          y = $rowY
          Window = $win
        }
      }
      @{
        method = 'triangle-locate'
        locX = $locX
        rowY = $rowY
        nameX = $row.NameX
        chipLeft = $found.ChipLeft
        triX = $found.TriX
        clickX = $clickX
        named = $(if ($named2) { $named2.Text } else { $null })
        laneY = $lane.Y
        laneSource = $lane.Source
        clicked = $clicked
      } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutDir 'click_debug.json')
    }
  }

  if ($clickX -lt 0) {
    $bmp.Dispose()
    return [pscustomobject]@{
      ok = $false
      error = "Arranger event '$name' not visible to click"
      clicked = $null
      Window = $win
    }
  }

  $bmp.Dispose()
  try {
    [void](Invoke-SafeArrangerClick $win $clickX $clickY)
  } catch {
    return [pscustomobject]@{ ok = $false; error = $_.Exception.Message; clicked = $clicked; Window = $win }
  }
  # Let Cubase paint Info Line Name+times for the newly selected event.
  Start-Sleep -Milliseconds 450
  return [pscustomobject]@{
    ok = $true
    clicked = $clicked
    x = $clickX
    y = $clickY
    score = 50
    source = $lane.Source
    Window = $win
  }
}

function Read-CubaseInfoLine($win, [string]$expectedName = '') {
  $cap = Capture-CubaseBitmap $win
  $bmp = $cap.Bitmap
  $win = $cap.Window
  $winMeta = @{ left = $win.Left; top = $win.Top; width = $win.Width; height = $win.Height; moved = $false }
  $fullPath = Join-Path $OutDir 'cubase_capture.png'
  $bmp.Save($fullPath, [System.Drawing.Imaging.ImageFormat]::Png)

  # Locate Info Line via Name/Start/Length labels � bright-row heuristics were
  # picking track-list titles (e.g. "X32 Mutes") instead of the Info Line.
  $topH = [Math]::Min(220, $bmp.Height)
  $top = $bmp.Clone([System.Drawing.Rectangle]::new(0, 0, $bmp.Width, $topH), $bmp.PixelFormat)
  $topPath = Join-Path $OutDir 'cubase_top.png'
  $ocr = Invoke-OcrBitmap $top $topPath
  $top.Dispose()
  $fullText = [string]$ocr.Text
  if ($fullText -match '(?i)No\s*Obj') {
    $bmp.Dispose()
    return [pscustomobject]@{
      ok = $false
      noObjectSelected = $true
      infoName = ''
      error = 'Cubase info line shows No Object Selected'
      ocrText = $fullText
      rawStart = ''
      rawEnd = ''
      rawLength = ''
      window = $winMeta
      Win = $win
    }
  }
  $nameBox = Find-WordBox $ocr '(?i)^Name$'
  $nearY = if ($nameBox) { [int]$nameBox.Y } else { -1 }
  $startBox = Find-WordBox $ocr '(?i)^Start$' $nearY
  $endBox = Find-WordBox $ocr '(?i)^End$' $nearY
  $lengthBox = Find-WordBox $ocr '(?i)^Length' $nearY
  # Name+Length on the same row is enough. At native 1x, Windows OCR often
  # misses Start/End labels and all Info Line *values*; only the labels survive.
  if ($nameBox -and $lengthBox) {
    $dy = [Math]::Abs([int]$nameBox.Y - [int]$lengthBox.Y)
    if ($dy -gt 24) {
      $nameBox = $null
      $lengthBox = $null
      $startBox = $null
      $endBox = $null
    }
  }
  $valueY = -1
  $infoName = ''
  $rawStart = ''
  $rawEnd = ''
  $rawLength = ''
  $namePath = Join-Path $OutDir 'infoline_name.png'
  $timesPath = Join-Path $OutDir 'infoline_times.png'
  $lenPath = Join-Path $OutDir 'val_length.png'
  $bandScale = 4
  $bandPad = 16

  if ($nameBox -and $lengthBox) {
    # Crop the whole Info Line strip (labels + values) and OCR at 4x �
    # proven to recover "Soundcheck" / "0:03:38.550" when 1x returns only "Name Length".
    $bandY = [Math]::Max(0, [int]$nameBox.Y - 4)
    $bandH = 48
    if (($bandY + $bandH) -gt $bmp.Height) { $bandH = $bmp.Height - $bandY }
    $bandW = [Math]::Min($bmp.Width, [Math]::Max(520, [int]$lengthBox.X + [int]$lengthBox.Width + 220))
    $bandPath = Join-Path $OutDir 'infoline_band.png'
    Save-ScaledCrop $bmp 0 $bandY $bandW $bandH $bandScale $bandPath $bandPad
    $bandBmp = [System.Drawing.Bitmap]::FromFile($bandPath)
    try {
      $bandOcr = Invoke-OcrBitmap $bandBmp (Join-Path $OutDir 'infoline_band.ocr.png')
    } finally {
      $bandBmp.Dispose()
    }
    $fullText = ([string]$bandOcr.Text) + ' ' + $fullText

    # Keep label boxes in *scaled* space for filtering band OCR words.
    $sName = $null; $sStart = $null; $sEnd = $null; $sLen = $null
    foreach ($line in $bandOcr.Lines) {
      foreach ($word in @($line.Words)) {
        $t = [string]$word.Text
        $r = Get-WordRect $word
        if ($t -match '(?i)^Name$' -and -not $sName) { $sName = $r }
        elseif ($t -match '(?i)^Start$' -and -not $sStart) { $sStart = $r }
        elseif ($t -match '(?i)^End$' -and -not $sEnd) { $sEnd = $r }
        elseif ($t -match '(?i)^Length' -and -not $sLen) { $sLen = $r }
      }
    }
    $toOrig = {
      param($r)
      if (-not $r) { return $null }
      return [pscustomobject]@{
        X = [int](($r.X - $bandPad) / $bandScale)
        Y = [int]($bandY + (($r.Y - $bandPad) / $bandScale))
        Width = [Math]::Max(1, [int]($r.Width / $bandScale))
        Height = [Math]::Max(1, [int]($r.Height / $bandScale))
      }
    }
    if ($sName) { $nameBox = & $toOrig $sName }
    if ($sStart) { $startBox = & $toOrig $sStart }
    if ($sEnd) { $endBox = & $toOrig $sEnd }
    if ($sLen) { $lengthBox = & $toOrig $sLen }

    $labelBottom = if ($lengthBox) { $lengthBox.Y + $lengthBox.Height } elseif ($nameBox) { $nameBox.Y + $nameBox.Height } else { $bandY + 14 }
    $valueY = [Math]::Max(0, $labelBottom + 2)

    $infoName = ''
    $labelYScaled = if ($sName) { [int]$sName.Y } else { $bandPad }
    # Name *value* often starts left of the "Name" label (centered under the column).
    $nameLeftScaled = 0
    $nameRightScaled = if ($sStart) { [int]$sStart.X - 8 } elseif ($sEnd) { [int]$sEnd.X - 8 } elseif ($sLen) { [int]$sLen.X - 8 } else { 900 }
    $parts = @()
    foreach ($line in $bandOcr.Lines) {
      foreach ($word in @($line.Words)) {
        $t = [string]$word.Text
        if ($t -match '(?i)^(Name|Start|End|Length|Type|Pitch)$') { continue }
        if ($t -match '^\d' -or $t -match '\d[:.]\d') { continue }
        $r = Get-WordRect $word
        if ($r.Y -lt ($labelYScaled + 12)) { continue }
        if ($r.X -ge $nameRightScaled) { continue }
        $parts += [pscustomobject]@{ X = $r.X; Text = $t }
      }
    }
    if ($parts.Count -ge 1) {
      $infoName = ((($parts | Sort-Object X) | ForEach-Object { $_.Text }) -join ' ').Trim()
    }
    # If OCR split the title ("Sit" + "down"), prefer the expected name only when
    # the Name-column text fuzzy-matches it � never because the title appears
    # elsewhere in the band (timeline / inspector bleed).
    if ($expectedName -and $infoName -and (Titles-FuzzyMatch $infoName $expectedName)) {
      $infoName = $expectedName
    }
    $infoName = (($infoName -replace '(?i)\b(Name|Start|End|Length|Type)\b', '').Trim())
    if ($infoName -match '(?i)^(X32|VST|ViewerOne|The Grand|FullSongs|MIDI)$') {
      $infoName = ''
    }

    # Times: digit tokens below labels, left-to-right (Start / End / Length).
    # Also accept OCR mangling like O:03S8S50 / 00338.550.
    $timeParts = @()
    foreach ($line in $bandOcr.Lines) {
      foreach ($word in @($line.Words)) {
        $t = [string]$word.Text
        if ($t -notmatch '\d') { continue }
        if ($t -match '(?i)^(Name|Start|End|Length)$') { continue }
        $r = Get-WordRect $word
        if ($r.Y -lt ($labelYScaled + 8)) { continue }
        $norm = ($t -replace '[Oo]', '0' -replace '[Ss]', '5' -replace '[Il]', '1')
        if ($norm -match '\d[:.]\d' -or $norm -match '\d{5,}' -or $norm -match '^\d{1,2}[:.]\d' -or $t -match '\d{3,}') {
          $timeParts += [pscustomobject]@{ X = $r.X; Text = $norm }
        }
      }
    }
    $orderedTimes = @($timeParts | Sort-Object X | ForEach-Object { $_.Text })
    if ($orderedTimes.Count -ge 3) {
      $rawStart = [string]$orderedTimes[0]
      $rawEnd = [string]$orderedTimes[1]
      $rawLength = [string]$orderedTimes[2]
    } elseif ($orderedTimes.Count -eq 2) {
      # Prefer Start+End (compute span in Node). Never treat End as Length.
      $rawStart = [string]$orderedTimes[0]
      $rawEnd = [string]$orderedTimes[1]
      $rawLength = ''
    } elseif ($orderedTimes.Count -eq 1) {
      $rawStart = ''
      $rawEnd = ''
      $rawLength = [string]$orderedTimes[0]
    }

    $valueH = 16
    $lengthCol = if ($lengthBox) { Get-ColumnCrop $lengthBox 400 110 $bmp.Width } else { [pscustomobject]@{ x = 480; w = 140 } }
    $startCol = if ($startBox) { Get-ColumnCrop $startBox 200 100 $bmp.Width } else { [pscustomobject]@{ x = 200; w = 140 } }
    $endCol = if ($endBox) { Get-ColumnCrop $endBox 300 100 $bmp.Width } else { [pscustomobject]@{ x = 340; w = 140 } }
    Save-ScaledCrop $bmp 0 ([Math]::Max(0, $valueY - 2)) 260 ($valueH + 4) 4 $namePath
    # Wide times strip: Start through Length values (4x) � more reliable than band OCR alone.
    $timesX = [Math]::Max(0, [int]$startCol.x - 8)
    $timesW = [Math]::Min($bmp.Width - $timesX, [int](($lengthCol.x + $lengthCol.w) - $timesX + 24))
    Save-ScaledCrop $bmp $timesX ([Math]::Max(0, $valueY - 2)) $timesW ($valueH + 6) 5 $timesPath
    Save-ThickenedCrop $bmp $lengthCol.x $valueY $lengthCol.w $valueH $lenPath
    Save-ThickenedCrop $bmp $startCol.x $valueY $startCol.w $valueH (Join-Path $OutDir 'val_start.png')
    Save-ThickenedCrop $bmp $endCol.x $valueY $endCol.w $valueH (Join-Path $OutDir 'val_end.png')

    $timesBmp = [System.Drawing.Bitmap]::FromFile($timesPath)
    try {
      $timesOcr = Invoke-OcrBitmap $timesBmp (Join-Path $OutDir 'infoline_times.ocr.png')
    } finally {
      $timesBmp.Dispose()
    }
    $cropTimeParts = @()
    foreach ($line in $timesOcr.Lines) {
      foreach ($word in @($line.Words)) {
        $t = [string]$word.Text
        if (-not $t) { continue }
        $norm = ($t -replace '[Oo]', '0' -replace '[Ss]', '5' -replace '[Il]', '1')
        if ($norm -match '\d' -and ($norm -match '[:.]' -or $norm -match '\d{3,}')) {
          $r = Get-WordRect $word
          $cropTimeParts += [pscustomobject]@{ X = $r.X; Text = $norm }
        }
      }
    }
    if ($cropTimeParts.Count -ge 1) {
      $orderedTimes = @($cropTimeParts | Sort-Object X | ForEach-Object { $_.Text })
    }
    if ($orderedTimes.Count -ge 3) {
      $rawStart = [string]$orderedTimes[0]
      $rawEnd = [string]$orderedTimes[1]
      $rawLength = [string]$orderedTimes[2]
    } elseif ($orderedTimes.Count -eq 2) {
      # Prefer Start+End (compute span in Node). Never treat End as Length.
      $rawStart = [string]$orderedTimes[0]
      $rawEnd = [string]$orderedTimes[1]
      $rawLength = ''
    } elseif ($orderedTimes.Count -eq 1) {
      $rawStart = ''
      $rawEnd = ''
      $rawLength = [string]$orderedTimes[0]
    }

    $lenOcr = Ocr-ImageFile $lenPath
    $startOcr = Ocr-ImageFile (Join-Path $OutDir 'val_start.png')
    $endOcr = Ocr-ImageFile (Join-Path $OutDir 'val_end.png')
    if ($startOcr -and ($startOcr -match '\d{3,}') -and ($startOcr -notmatch '[A-Za-z]')) {
      $rawStart = ($startOcr -replace '[Oo]', '0' -replace '[Il]', '1')
    }
    if ($endOcr -and ($endOcr -match '\d{3,}') -and ($endOcr -notmatch '[A-Za-z]')) {
      $rawEnd = ($endOcr -replace '[Oo]', '0' -replace '[Il]', '1')
    }
    if ($lenOcr -and ($lenOcr -match '\d{3,}') -and ($lenOcr -notmatch '[A-Za-z]')) {
      $rawLength = ($lenOcr -replace '[Oo]', '0' -replace '[Il]', '1')
    } elseif ($lenOcr -and -not $rawLength -and ($lenOcr -notmatch '[A-Za-z]')) {
      $rawLength = ($lenOcr -replace '[Oo]', '0' -replace '[Il]', '1')
    }
    # Last-resort: Tesseract-friendly thickened length is already written for Node fallback.
  }

  if ((-not $infoName) -and $expectedName) {
    foreach ($line in $ocr.Lines) {
      $text = ($line.Text -replace '\s+', ' ').Trim()
      if (-not $text) { continue }
      if (-not (Titles-FuzzyMatch $text $expectedName)) { continue }
      $box = Get-LineRect $line
      if (-not $box) { continue }
      if ($box.Y -lt 70 -or $box.Y -gt 200) { continue }
      if ($box.X -gt 400) { continue }
      $timeNear = $false
      foreach ($line2 in $ocr.Lines) {
        $t2 = ([string]$line2.Text)
        if ($t2 -notmatch '\d[:.]\d|\d{5,}') { continue }
        $b2 = Get-LineRect $line2
        if (-not $b2) { continue }
        if ([Math]::Abs([int]$b2.Y - [int]$box.Y) -le 28) { $timeNear = $true; break }
      }
      if (-not $timeNear) { continue }
      $infoName = $expectedName
      $valueY = [int]$box.Y
      break
    }
  }
  if ($valueY -lt 0 -or -not $infoName) {
    $bmp.Dispose()
    return [pscustomobject]@{
      ok = $false
      noObjectSelected = $false
      infoName = ''
      error = 'Cubase Info Line not visible � turn on Project window Info Line (toolbar Set up Window Layout)'
      ocrText = $fullText
      rawStart = ''
      rawEnd = ''
      rawLength = ''
      window = $winMeta
      Win = $win
    }
  }

  if ($rawLength -and ($rawLength -notmatch '\d{3,}')) { $rawLength = '' }
  # Reject WinOCR letter-garbage (e.g. "0555.u 1" / "oss5.u") � Node Tesseract
  # reads the times strip cleanly when these are cleared.
  if ($rawLength -match '[A-Za-z]') { $rawLength = '' }
  if ($rawStart -match '[A-Za-z]') { $rawStart = '' }
  if ($rawEnd -match '[A-Za-z]') { $rawEnd = '' }
  $hasTimes = [bool](($rawLength -match '\d{3,}') -or (($rawStart -match '\d') -and ($rawEnd -match '\d')))
  $bmp.Dispose()
  return [pscustomobject]@{
    ok = [bool]($hasTimes -and $infoName)
    noObjectSelected = $false
    infoName = $infoName
    rawStart = $rawStart
    rawEnd = $rawEnd
    rawLength = $rawLength
    ocrText = (($infoName + ' ' + $fullText).Trim() -replace '[\x00-\x1F\x7F]', ' ')
    timesPng = $timesPath
    lengthPng = $lenPath
    namePng = $namePath
    window = $winMeta
    Win = $win
    error = if ($hasTimes -and $infoName) { $null } else { 'Info line times unread' }
  }
}

function Invoke-Grab([string]$name, [switch]$Quick) {
  $alive = Test-CubaseAlive
  if (-not $alive.alive) {
    return [pscustomobject]@{
      ok = $false
      error = 'Cubase not running'
      noObjectSelected = $false
      infoName = ''
      rawStart = ''
      rawEnd = ''
      rawLength = ''
      ocrText = ''
    }
  }
  $prep = Prepare-CubaseWindow -Quick:$Quick
  $win = [pscustomobject]@{
    Process = $prep.Proc
    Handle = $prep.Handle
    Left = $prep.left
    Top = $prep.top
    Width = $prep.width
    Height = $prep.height
  }
  # Dismiss Project Setup / floating dialogs that steal the Info Line OCR.
  Invoke-CubaseKey $win ([CubaseUi]::VK_ESCAPE)
  Start-Sleep -Milliseconds 80
  Invoke-CubaseKey $win ([CubaseUi]::VK_ESCAPE)
  Start-Sleep -Milliseconds 120
  # MIDI Next/Prev is the walk. Click the named Arranger block (or colour-chip
  # match after chain locate). If Info Line Name still mismatches, retry with
  # that X excluded so a wrong-coloured neighbour is not reused.
  $exclude = @()
  $clicked = $null
  $info = $null
  $gotName = ''
  $nameOk = $false
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $clicked = Select-TimelineArrangerEvent $win $name -ExcludeX $exclude -LocatorPick $attempt
    if ($clicked.Window) { $win = $clicked.Window }
    if (-not $clicked.ok) { break }
    Start-Sleep -Milliseconds 120
    $info = Read-CubaseInfoLine $win $name
    $gotName = [string]$info.infoName
    $nameOk = (-not $name) -or ($gotName -and (Titles-FuzzyMatch $name $gotName))
    if ($nameOk) { break }
    if ($clicked.x -ne $null) { $exclude += [int]$clicked.x }
  }
  if (-not $info) {
    $info = [pscustomobject]@{
      ok = $false
      noObjectSelected = $false
      infoName = ''
      rawStart = ''
      rawEnd = ''
      rawLength = ''
      ocrText = ''
      timesPng = ''
      lengthPng = ''
      namePng = ''
      error = $(if ($clicked) { $clicked.error } else { 'click failed' })
      window = $null
    }
  }
  $ok = [bool]($info.ok -and $nameOk)
  @{
    method = 'grab'
    clicked = $clicked.clicked
    clickX = $clicked.x
    clickY = $clicked.y
    clickOk = [bool]$clicked.ok
    infoName = $gotName
    nameOk = $nameOk
    rawLength = [string]$info.rawLength
    exclude = $exclude
  } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutDir 'click_debug.json')
  return [pscustomobject]@{
    ok = $ok
    clickedOk = [bool]$clicked.ok
    clicked = $clicked.clicked
    clickError = $clicked.error
    x = $clicked.x
    y = $clicked.y
    noObjectSelected = [bool]$info.noObjectSelected
    infoName = [string]$info.infoName
    rawStart = [string]$info.rawStart
    rawEnd = [string]$info.rawEnd
    rawLength = [string]$info.rawLength
    ocrText = [string]$info.ocrText
    timesPng = [string]$info.timesPng
    lengthPng = [string]$info.lengthPng
    namePng = [string]$info.namePng
    error = if ($ok) { $null } elseif (-not $nameOk -and $gotName) { "Info Line Name '$gotName' does not match '$name'" } elseif ($info.ok) { $clicked.error } else { $info.error }
    window = $info.window
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if ($Action -eq 'serve') {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = [string]$line
    if ($line.Trim() -eq 'quit') { break }
    if (-not $line.Trim()) { continue }
    $parts = $line.Split("`t")
    $act = $parts[0]
    if ($parts.Count -gt 1 -and $parts[1]) { $script:OutDir = $parts[1]; $OutDir = $parts[1] }
    $EventName = if ($parts.Count -gt 2) { $parts[2] } else { '' }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    try {
      if ($act -eq 'grab') {
        (Invoke-Grab $EventName -Quick) | ConvertTo-Json -Compress
      } elseif ($act -eq 'health') {
        (Test-CubaseAlive) | ConvertTo-Json -Compress
      } elseif ($act -eq 'prepare') {
        $prep = Prepare-CubaseWindow -Quick
        @{
          ok = $true
          prepared = $true
          moved = $false
          restored = $prep.restored
          process = $prep.processName
          title = $prep.title
          left = $prep.left
          top = $prep.top
          width = $prep.width
          height = $prep.height
        } | ConvertTo-Json -Compress
      } elseif ($act -eq 'expand') {
        $prep = Prepare-CubaseWindow -Quick
        $win = [pscustomobject]@{
          Process = $prep.Proc
          Handle = $prep.Handle
          Left = $prep.left
          Top = $prep.top
          Width = $prep.width
          Height = $prep.height
        }
        (Expand-ArrangerLayout $win) | ConvertTo-Json -Compress
      } else {
        @{ ok = $false; error = "unknown action '$act'" } | ConvertTo-Json -Compress
      }
    } catch {
      @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
    [Console]::Out.Flush()
  }
  exit 0
}

if ($Action -eq 'health') {
  $h = Test-CubaseAlive
  $h | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'prepare') {
  $prep = Prepare-CubaseWindow
  @{
    ok = $true
    prepared = $true
    moved = $false
    restored = $prep.restored
    process = $prep.processName
    title = $prep.title
    left = $prep.left
    top = $prep.top
    width = $prep.width
    height = $prep.height
  } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'expand') {
  $prep = Prepare-CubaseWindow
  $win = [pscustomobject]@{
    Process = $prep.Proc
    Handle = $prep.Handle
    Left = $prep.left
    Top = $prep.top
    Width = $prep.width
    Height = $prep.height
  }
  (Expand-ArrangerLayout $win) | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'click') {
  if (-not $EventName) { throw 'EventName required for click' }
  $alive = Test-CubaseAlive
  if (-not $alive.alive) {
    @{ ok = $false; error = 'Cubase not running'; clicked = $null } | ConvertTo-Json -Compress
    exit 0
  }

  $prep = Prepare-CubaseWindow
  $win = [pscustomobject]@{
    Process = $prep.Proc
    Handle = $prep.Handle
    Left = $prep.left
    Top = $prep.top
    Width = $prep.width
    Height = $prep.height
  }

  $cap = Capture-CubaseBitmap $win
  $bmp = $cap.Bitmap
  $win = $cap.Window
  $ocrPath = Join-Path $OutDir 'click_ocr.png'
  $ocr = Invoke-OcrBitmap $bmp $ocrPath

  # Bound: Arranger *timeline event block* only.
  # Inspector clicks hit the chain play-arrow (starts playback) and do not fill the Info Line.
  # MIDI parts look like "1 - Let me entertain you" � skip those.
  $timelineMinX = [int]($bmp.Width * 0.52)
  $timelineMinY = 140
  $timelineMaxY = [int]($bmp.Height * 0.48)

  $arrangerLaneY = -1
  foreach ($line in $ocr.Lines) {
    $lt = [string]$line.Text
    if ($lt -match '(?i)^Arranger\s*Track$') {
      $hdr = Get-LineRect $line
      if ($hdr) { $arrangerLaneY = [int]($hdr.Y + $hdr.Height / 2) }
    }
  }

  $needle = Normalize-Title $EventName
  $candidates = @()
  foreach ($line in $ocr.Lines) {
    $text = ($line.Text -replace '\s+', ' ').Trim()
    if (-not $text) { continue }
    if ($text -match '(?i)^(Current\s*Chain|Arranger\s*Events|Inspector|Editor|MediaBay|Transport)') { continue }
    if ($text -match '(?i)\b(Click|Metronome|Play|Stop|Record|Cycle)\b') { continue }
    if ($text -match '^\s*\d+\s*-') { continue }
    if (-not (Titles-FuzzyMatch $text $EventName)) { continue }
    $box = Get-LineRect $line
    if (-not $box) { continue }

    $cx = [int]($box.X + $box.Width / 2)
    $cy = [int]($box.Y + $box.Height / 2)
    if ($cx -lt $timelineMinX) { continue }
    if ($cy -lt $timelineMinY -or $cy -gt $timelineMaxY) { continue }

    $score = 20
    $lower = Normalize-Title $text
    if ($lower -eq $needle) { $score += 100 }
    elseif ($lower -like "*$needle*" -or $needle -like "*$lower*") { $score += 40 }
    if ($cy -ge 180 -and $cy -le 300) { $score += 40 }
    if ($arrangerLaneY -ge 0 -and [Math]::Abs($cy - $arrangerLaneY) -le 28) { $score += 50 }
    if ($box.Width -lt 24) { $score -= 40 }

    if ($score -lt 40) { continue }

    $candidates += [pscustomobject]@{
      Text = $text
      X = $cx
      Y = $cy
      Score = $score
    }
  }

  # After MIDI Next the playhead sits on the current event. If OCR missed the
  # (often truncated) block label, click the Arranger track lane in the timeline.
  if ($candidates.Count -eq 0 -and $arrangerLaneY -ge $timelineMinY -and $arrangerLaneY -le $timelineMaxY) {
    $fallbackX = [int]($bmp.Width * 0.62)
    $candidates += [pscustomobject]@{
      Text = '(arranger-lane fallback)'
      X = $fallbackX
      Y = $arrangerLaneY
      Score = 40
    }
  }

  $bmp.Dispose()

  if ($candidates.Count -eq 0) {
    @{
      ok = $false
      error = "No Arranger timeline event visible for '$EventName' (won't click inspector/transport)"
      method = 'mouse-timeline-event'
    } | ConvertTo-Json -Compress
    exit 0
  }

  $best = $candidates | Sort-Object Score -Descending | Select-Object -First 1
  try {
    [void](Invoke-SafeArrangerClick $win $best.X $best.Y)
  } catch {
    @{
      ok = $false
      error = $_.Exception.Message
      method = 'mouse-timeline-event'
      clicked = $best.Text
    } | ConvertTo-Json -Compress
    exit 0
  }

  @{
    ok = $true
    clicked = $best.Text
    x = $best.X
    y = $best.Y
    score = $best.Score
    method = 'mouse-timeline-event'
    window = @{ left = $win.Left; top = $win.Top; width = $win.Width; height = $win.Height; moved = $false }
  } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'infoline') {
  $prep = Prepare-CubaseWindow -Quick
  $win = [pscustomobject]@{
    Process = $prep.Proc
    Handle = $prep.Handle
    Left = $prep.left
    Top = $prep.top
    Width = $prep.width
    Height = $prep.height
  }
  Invoke-CubaseChord $win ([CubaseUi]::VK_CONTROL) ([CubaseUi]::VK_I)
  @{ ok = $true; toggledInfoLine = $true } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'stop') {
  $prep = Prepare-CubaseWindow -Quick
  $win = [pscustomobject]@{
    Process = $prep.Proc
    Handle = $prep.Handle
    Left = $prep.left
    Top = $prep.top
    Width = $prep.width
    Height = $prep.height
  }
  Invoke-CubaseStop $win
  @{ ok = $true; stopped = $true } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'zoomin') {
  $prep = Prepare-CubaseWindow -Quick
  $win = [pscustomobject]@{
    Process = $prep.Proc
    Handle = $prep.Handle
    Left = $prep.left
    Top = $prep.top
    Width = $prep.width
    Height = $prep.height
  }
  $n = 10
  if ($EventName -match '^\d+$') { $n = [Math]::Max(1, [int]$EventName) }
  for ($i = 0; $i -lt $n; $i++) { Invoke-TimelineZoom $win 120 }
  @{ ok = $true; zoomedIn = $n } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'grab') {
  if (-not $EventName) { throw 'EventName required for grab' }
  (Invoke-Grab $EventName) | ConvertTo-Json -Compress
  exit 0
}

# --- capture (foreground + BitBlt + OCR; no clicks) ---
$alive0 = Test-CubaseAlive
if (-not $alive0.alive) {
  @{ ok = $false; error = 'Cubase not running'; noObjectSelected = $false; infoName = '' } | ConvertTo-Json -Compress
  exit 0
}

$prepCap = Prepare-CubaseWindow
$win = [pscustomobject]@{
  Process = $prepCap.Proc
  Handle = $prepCap.Handle
  Left = $prepCap.left
  Top = $prepCap.top
  Width = $prepCap.width
  Height = $prepCap.height
}

$captureAttempt = 0
$captureOk = $false
$lastError = 'Cubase Length capture failed'
$noObject = $false
$fullText = ''
$infoName = ''
$startPng = $null
$endPng = $null
$lengthPng = $null
$valueY = -1
$winMeta = $null

while ($captureAttempt -lt 2 -and -not $captureOk) {
  $captureAttempt++
  if ($captureAttempt -gt 1) {
    Start-Sleep -Milliseconds 400
    if ([CubaseUi]::IsIconic($win.Handle)) {
      [void][CubaseUi]::ShowWindow($win.Handle, [CubaseUi]::SW_RESTORE)
      Start-Sleep -Milliseconds 280
    }
  }

  $cap = Capture-CubaseBitmap $win
  $bmp = $cap.Bitmap
  $win = $cap.Window
  $winMeta = @{ left = $win.Left; top = $win.Top; width = $win.Width; height = $win.Height; moved = $false }
  $fullPath = Join-Path $OutDir 'cubase_capture.png'
  $bmp.Save($fullPath, [System.Drawing.Imaging.ImageFormat]::Png)

  # Info line lives in the upper strip � keep crop modest so we don't OCR transport clocks.
  $topH = [Math]::Min(280, $bmp.Height)
  $top = $bmp.Clone([System.Drawing.Rectangle]::new(0, 0, $bmp.Width, $topH), $bmp.PixelFormat)
  $topPath = Join-Path $OutDir 'cubase_top.png'
  $ocr = Invoke-OcrBitmap $top $topPath
  $top.Dispose()

  $fullText = [string]$ocr.Text
  $noObject = $fullText -match '(?i)No Object Selected'
  $nameBox = Find-WordBox $ocr '(?i)^Name$'
  $nearY = if ($nameBox) { [int]$nameBox.Y } else { -1 }
  $startBox = Find-WordBox $ocr '(?i)^Start$' $nearY
  $endBox = Find-WordBox $ocr '(?i)^End$' $nearY
  $lengthBox = Find-WordBox $ocr '(?i)^Length' $nearY

  if ($noObject) {
    $lastError = 'Cubase info line shows No Object Selected'
    $infoName = ''
    $bmp.Dispose()
    break
  }
  if (-not $nameBox) {
    $lastError = 'Name label not found in Cubase info line'
    $bmp.Dispose()
    continue
  }
  if (-not $lengthBox) {
    $lastError = 'Length label not found in Cubase info line'
    $bmp.Dispose()
    continue
  }
  if ([Math]::Abs($lengthBox.Y - $nameBox.Y) -gt 28) {
    $lastError = 'Length label not aligned with Name on Cubase info line'
    $bmp.Dispose()
    continue
  }

  $labelBottom = $lengthBox.Y + $lengthBox.Height
  $lengthCol = Get-ColumnCrop $lengthBox 400 110 $bmp.Width
  $valueY = -1
  $valueH = 12
  $scanEnd = [Math]::Min($bmp.Height - 6, $labelBottom + 40)
  for ($y = $labelBottom + 3; $y -le $scanEnd; $y++) {
    $bright = 0
    $xEnd = [Math]::Min($bmp.Width - 1, $lengthCol.x + $lengthCol.w)
    for ($x = $lengthCol.x; $x -le $xEnd; $x++) {
      $p = $bmp.GetPixel($x, $y)
      $lum = [int](0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
      if ($lum -gt 80) { $bright++ }
    }
    if ($bright -ge 12) {
      $valueY = $y
      break
    }
  }
  if ($valueY -lt 0) { $valueY = [Math]::Max(0, $labelBottom + 12) }
  $valueH = [Math]::Min(14, $bmp.Height - $valueY)

  $infoName = Get-InfoLineNameValue $ocr $nameBox $startBox $valueY

  $startCol = Get-ColumnCrop $startBox 200 100 $bmp.Width
  $endCol = Get-ColumnCrop $endBox 300 100 $bmp.Width

  $startPng = Join-Path $OutDir 'val_start.png'
  $endPng = Join-Path $OutDir 'val_end.png'
  $lengthPng = Join-Path $OutDir 'val_length.png'
  Save-ThickenedCrop $bmp $startCol.x $valueY $startCol.w $valueH $startPng
  Save-ThickenedCrop $bmp $endCol.x $valueY $endCol.w $valueH $endPng
  Save-ThickenedCrop $bmp $lengthCol.x $valueY $lengthCol.w $valueH $lengthPng

  $bmp.Dispose()
  $captureOk = $true
}

if (-not $captureOk) {
  @{
    ok = $false
    noObjectSelected = [bool]$noObject
    infoName = $infoName
    error = $lastError
    ocrText = $fullText
    window = $winMeta
  } | ConvertTo-Json -Compress
  exit 0
}

@{
  ok = $true
  noObjectSelected = $false
  infoName = $infoName
  startPng = $startPng
  endPng = $endPng
  lengthPng = $lengthPng
  valueY = $valueY
  ocrText = $fullText
  window = $winMeta
} | ConvertTo-Json -Compress
