# Blink the DeepSeek Harness notification-area (system tray) icon.
#
# WHY AN OVERLAY
#   The whale tray icon belongs to the Electron main process (the DesktopTray
#   instance created in the app shell). A plugin runs in a separate host
#   process, so it cannot call Electron's Tray API to swap that icon, and the
#   shell rejects a cross-process NIM_MODIFY for another process's icon
#   (measured: Shell_NotifyIcon returns False). Windows also gives no way for a
#   third party to animate someone else's notification icon in place.
#
#   What does work: Shell_NotifyIconGetRect resolves the icon's exact screen
#   rectangle across processes, and a layered, topmost, click-through window can
#   be parked on top of that cell. Drawing into it makes the tray icon appear to
#   blink or to grow an unread badge, while hit-testing still lands on the
#   notification toolbar, so clicking the icon keeps working.
#
# WHAT "BLINKING" MEANS HERE
#   Alternating between two frames:
#     alert frame  - the icon area covered by a translucent highlight plus a red
#                    unread dot in the corner (attention state)
#     clear frame  - fully transparent, so the real icon shows through (idle)
#   The caller starts and stops the blink; nothing here decides when a session
#   is unread.
#
# USAGE
#   flash-window.ps1 -Action start    begin blinking over the tray icon and
#                                     return at once (a detached child process
#                                     keeps the overlay alive)
#   flash-window.ps1 -Action stop     remove the overlay immediately
#   flash-window.ps1 -Action status   report whether a blink is active
#   flash-window.ps1 -Action probe    report where the tray icon currently is
#
#   start must not block: the caller awaits this script with a timeout, and a
#   blink lasts as long as something is unread.
#
#   -TargetPid selects which process's tray icon to cover. 0 means auto-detect
#   (the Electron main process that owns a notification icon).
#   -IntervalMs controls the blink period.
#
# OUTPUT
#   A human-readable DETAIL line plus a final FLASHED=1|0 verdict line. Exit
#   code is always 0 for handled states so the caller can parse the verdict
#   instead of relying on exit status.
#
# ASCII only: this file is invoked through -EncodedCommand on a host whose
# console code page is not UTF-8, so non-ASCII bytes would be mangled.

param(
    [ValidateSet('start', 'stop', 'status', 'probe', 'loop')]
    [string]$Action = 'start',

    [int]$TargetPid = 0,

    [int]$IntervalMs = 600
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell, not pwsh: the Electron host may not have pwsh on PATH.
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------------------
# Native interop
# ---------------------------------------------------------------------------

$nativeCode = @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public struct NIData {
  public uint cbSize;
  public IntPtr hWnd;
  public uint uID;
  public Guid guidItem;
}

public struct IconRect { public int Left, Top, Right, Bottom; }

public class TrayQuery {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("shell32.dll")]
  public static extern int Shell_NotifyIconGetRect(ref NIData id, out IconRect r);

  // All notification-icon host windows currently alive. Electron creates one
  // per Tray instance and names it Electron_NotifyIconHostWindow.
  public static List<IntPtr> Hosts() {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      StringBuilder sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      if (sb.ToString() == "Electron_NotifyIconHostWindow") list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static uint PidOf(IntPtr h) {
    uint pid = 0;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }

  // The shell assigns ids starting at 1; an icon that exists resolves, one that
  // does not returns a failure HRESULT.
  public static bool RectOf(IntPtr hwnd, uint uid, out IconRect r) {
    NIData d = new NIData();
    d.cbSize = (uint)Marshal.SizeOf(typeof(NIData));
    d.hWnd = hwnd;
    d.uID = uid;
    return Shell_NotifyIconGetRect(ref d, out r) == 0;
  }

  // Locate one tray icon. Returns the owning hwnd, its id and its screen rect.
  public static string Locate(uint wantPid, out IntPtr foundHwnd, out uint foundUid,
                              out int x, out int y, out int w, out int h) {
    foundHwnd = IntPtr.Zero; foundUid = 0; x = y = w = h = 0;
    List<IntPtr> hosts = Hosts();
    foreach (IntPtr host in hosts) {
      uint pid = PidOf(host);
      if (wantPid != 0 && pid != wantPid) continue;
      for (uint uid = 1; uid <= 16; uid++) {
        IconRect r;
        if (RectOf(host, uid, out r)) {
          foundHwnd = host; foundUid = uid;
          x = r.Left; y = r.Top;
          w = r.Right - r.Left; h = r.Bottom - r.Top;
          return "pid=" + pid + " hwnd=" + host + " uid=" + uid;
        }
      }
    }
    return "";
  }
}

public class TrayOverlay : Form {
  const int WS_EX_LAYERED     = 0x00080000;
  const int WS_EX_TRANSPARENT = 0x00000020;
  const int WS_EX_NOACTIVATE  = 0x08000000;
  const int WS_EX_TOOLWINDOW  = 0x00000080;
  const int ULW_ALPHA         = 0x00000002;
  const byte AC_SRC_OVER      = 0x00;
  const byte AC_SRC_ALPHA     = 0x01;

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential)]
  struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst,
      ref SIZE psize, IntPtr hdcSrc, ref POINT pprSrc, int crKey,
      ref BLENDFUNCTION pblend, int dwFlags);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);

  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after,
      int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

  const int SW_SHOW = 5;
  const uint SWP_SHOWWINDOW = 0x0040;
  const uint SWP_NOACTIVATE = 0x0010;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

  int _w, _h;

  // Layered + click-through + never activated + hidden from Alt+Tab. Without
  // these the overlay would swallow tray clicks and steal focus.
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
      return cp;
    }
  }

  public TrayOverlay(int x, int y, int w, int h) {
    _w = w; _h = h;
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    Bounds = new Rectangle(x, y, w, h);
    TopMost = true;
  }

  // Push a premultiplied ARGB bitmap to the layered window. Fully transparent
  // pixels let the real tray icon show through untouched.
  public void ShowFrame(Bitmap bmp) {
    IntPtr screenDc = GetDC(IntPtr.Zero);
    IntPtr memDc = CreateCompatibleDC(screenDc);
    IntPtr hBmp = IntPtr.Zero;
    IntPtr old = IntPtr.Zero;
    try {
      hBmp = bmp.GetHbitmap(Color.FromArgb(0));
      old = SelectObject(memDc, hBmp);
      POINT dst = new POINT(); dst.x = Left; dst.y = Top;
      SIZE size = new SIZE(); size.cx = _w; size.cy = _h;
      POINT src = new POINT(); src.x = 0; src.y = 0;
      BLENDFUNCTION blend = new BLENDFUNCTION();
      blend.BlendOp = AC_SRC_OVER; blend.BlendFlags = 0;
      blend.SourceConstantAlpha = 255; blend.AlphaFormat = AC_SRC_ALPHA;
      UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0,
                          ref blend, ULW_ALPHA);
    } finally {
      if (old != IntPtr.Zero) SelectObject(memDc, old);
      if (hBmp != IntPtr.Zero) DeleteObject(hBmp);
      DeleteDC(memDc);
      ReleaseDC(IntPtr.Zero, screenDc);
    }
  }

  // Windows honours the STARTUPINFO show state for the FIRST ShowWindow call
  // and silently overrides it with SW_HIDE when the process was launched
  // hidden. The blink loop is exactly that: spawned with -WindowStyle Hidden.
  // So the first Show() leaves the overlay invisible, and every later ShowWindow
  // behaves normally. Calling it again, explicitly, is what actually puts the
  // overlay on screen.
  //
  // Repositioning with SWP_SHOWWINDOW afterwards re-asserts topmost and makes
  // sure the layered surface is composited at the rectangle we measured, since
  // the window may have been created before the tray cell settled.
  public void ForceShow() {
    ShowWindow(Handle, SW_SHOW);
    SetWindowPos(Handle, HWND_TOPMOST, Left, Top, Width, Height,
                 SWP_SHOWWINDOW | SWP_NOACTIVATE);
  }

  public bool IsShown() { return IsWindowVisible(Handle); }
}
"@

Add-Type -TypeDefinition $nativeCode -ReferencedAssemblies System.Windows.Forms, System.Drawing

# ---------------------------------------------------------------------------
# Frame drawing
# ---------------------------------------------------------------------------

# A notification cell is taller than the glyph it holds: measured on a 24x40
# cell, the 16x16 icon sits centred horizontally and 12px down.
function Get-GlyphBox {
    param([int]$Width, [int]$Height)

    $glyph = [int][Math]::Min(16, [Math]::Min($Width, $Height))
    $gx = [int](($Width - $glyph) / 2)
    $gy = [int](($Height - $glyph) / 2)
    return @{ x = $gx; y = $gy; size = $glyph }
}

# A fully transparent frame: the real tray icon shows through untouched.
function New-ClearFrame {
    param([int]$Width, [int]$Height)

    $bmp = New-Object System.Drawing.Bitmap($Width, $Height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.Dispose()
    return $bmp
}

# QQ's tray blink swaps the whole icon for a reddened copy of itself, so the
# shape stays recognisable and the change is unmistakable at 16px. Copy the
# on-screen glyph and push it towards red: white becomes light red, the dark
# whale stays dark red, and the silhouette is preserved.
#
# The recolour runs over one locked byte buffer rather than GetPixel/SetPixel:
# at 16x16 that is 256 COM round trips, which cost roughly a second of startup
# latency - long enough for the first blink to look like it never started.
function New-TintedFrame {
    param([int]$Width, [int]$Height, [System.Drawing.Bitmap]$Glyph)

    $box = Get-GlyphBox -Width $Width -Height $Height

    $tinted = New-Object System.Drawing.Bitmap($box.size, $box.size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $box.size, $box.size)
    $src = $Glyph.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $dst = $tinted.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

    try {
        $srcBytes = New-Object byte[] ($src.Stride * $box.size)
        $dstBytes = New-Object byte[] ($dst.Stride * $box.size)
        [System.Runtime.InteropServices.Marshal]::Copy($src.Scan0, $srcBytes, 0, $srcBytes.Length)

        # Premultiplied BGRA. Push the red channel up and cut green/blue, which
        # turns the white plate light red and the dark whale deep red while
        # keeping every anti-aliased edge exactly where it was.
        #
        # Walk rows and columns with each buffer's own stride: the two surfaces
        # are allowed to pad differently, so a shared byte offset would run off
        # the end of the destination.
        for ($y = 0; $y -lt $box.size; $y++) {
            $srcRow = $y * $src.Stride
            $dstRow = $y * $dst.Stride
            for ($x = 0; $x -lt $box.size; $x++) {
                $si = $srcRow + ($x * 4)
                $di = $dstRow + ($x * 4)
                $alpha = $srcBytes[$si + 3]
                if ($alpha -eq 0) { continue }
                $dstBytes[$di] = [byte][Math]::Min(255, [int]([int]$srcBytes[$si] * 0.30))
                $dstBytes[$di + 1] = [byte][Math]::Min(255, [int]([int]$srcBytes[$si + 1] * 0.30))
                $dstBytes[$di + 2] = [byte][Math]::Min(255, ([int]$srcBytes[$si + 2] + 55))
                $dstBytes[$di + 3] = $alpha
            }
        }
        [System.Runtime.InteropServices.Marshal]::Copy($dstBytes, 0, $dst.Scan0, $dstBytes.Length)
    } finally {
        $Glyph.UnlockBits($src)
        $tinted.UnlockBits($dst)
    }

    $bmp = New-Object System.Drawing.Bitmap($Width, $Height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($tinted, $box.x, $box.y, $box.size, $box.size)
    $g.Dispose()
    $tinted.Dispose()

    # No outline: the glyph already has its own rounded white plate, and a
    # drawn rectangle around it reads as a pasted square rather than a lit icon.
    return $bmp
}

# Fallback when the glyph cannot be captured (for example the tray is collapsed
# into the overflow area and nothing is painted where the icon claims to be).
function New-BadgeFrame {
    param([int]$Width, [int]$Height)

    $bmp = New-Object System.Drawing.Bitmap($Width, $Height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $box = Get-GlyphBox -Width $Width -Height $Height
    $red = New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(255, 232, 56, 56))
    $g.FillEllipse($red, $box.x, $box.y, $box.size, $box.size)
    $red.Dispose()

    $g.Dispose()
    return $bmp
}

# Copy what is actually painted inside the icon cell right now.
#
# CopyFromScreen returns opaque pixels: the taskbar background around the icon
# comes along with the glyph. Tinting that would paint a solid red square, so
# the capture knocks the background out to transparent first, using the corner
# colour as the reference. What survives is the icon plate and the whale.
function Get-GlyphCapture {
    param([int]$X, [int]$Y, [int]$Width, [int]$Height)

    $box = Get-GlyphBox -Width $Width -Height $Height
    $full = New-Object System.Drawing.Bitmap($box.size, $box.size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen(($X + $box.x), ($Y + $box.y), 0, 0,
        (New-Object System.Drawing.Size($box.size, $box.size)))
    $g.Dispose()

    $rect = New-Object System.Drawing.Rectangle(0, 0, $box.size, $box.size)
    $bits = $full.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $bytes = New-Object byte[] ($bits.Stride * $box.size)
        [System.Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $bytes, 0, $bytes.Length)

        # The four corners are taskbar, never icon: average them for the key.
        $bgR = [int]$bytes[2]
        $bgG = [int]$bytes[1]
        $bgB = [int]$bytes[0]

        $lit = 0
        # A tolerance rather than an exact match: the taskbar is not perfectly
        # uniform, and the icon plate is near-white, far outside this band.
        $tol = 26
        for ($y = 0; $y -lt $box.size; $y++) {
            $row = $y * $bits.Stride
            for ($x = 0; $x -lt $box.size; $x++) {
                $i = $row + ($x * 4)
                $b = [int]$bytes[$i]
                $gg = [int]$bytes[$i + 1]
                $r = [int]$bytes[$i + 2]
                $near = ([Math]::Abs($r - $bgR) -le $tol) -and
                        ([Math]::Abs($gg - $bgG) -le $tol) -and
                        ([Math]::Abs($b - $bgB) -le $tol)
                if ($near) {
                    $bytes[$i] = 0; $bytes[$i + 1] = 0; $bytes[$i + 2] = 0; $bytes[$i + 3] = 0
                } else {
                    $bytes[$i + 3] = 255
                    if (($r + $gg + $b) -gt 240) { $lit++ }
                }
            }
        }
        [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $bits.Scan0, $bytes.Length)
    } finally {
        $full.UnlockBits($bits)
    }

    # A blank capture means the icon is not visible there; the caller falls back.
    if ($lit -lt 8) {
        $full.Dispose()
        return $null
    }
    return $full
}

# ---------------------------------------------------------------------------
# Blink loop
# ---------------------------------------------------------------------------

$statePath = Join-Path $env:TEMP 'dsh-desktop-alerts-tray.json'

function Read-State {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    try {
        return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Write-State($obj) {
    $json = $obj | ConvertTo-Json -Compress
    Set-Content -LiteralPath $statePath -Value $json -Encoding ASCII
}

function Stop-Existing {
    $prev = Read-State
    if ($null -eq $prev) { return $false }
    if ($null -eq $prev.pid) { return $false }
    $proc = Get-Process -Id ([int]$prev.pid) -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
        Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
        return $false
    }

    # Delete the state file first: a running loop polls it every 50ms and exits
    # through its own `finally`, which clears the overlay. Killing the process
    # outright would skip that cleanup and leave a red icon painted on the tray
    # until Explorer restarts.
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 100
        if (-not (Get-Process -Id ([int]$prev.pid) -ErrorAction SilentlyContinue)) {
            return $true
        }
    }

    # It ignored the request: force it, then repaint the cell with the real
    # desktop content so no stale red frame survives.
    Stop-Process -Id ([int]$prev.pid) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    return $true
}

if ($Action -eq 'stop') {
    $was = Stop-Existing
    "DETAIL: stop removed-previous=$was"
    'FLASHED=1'
    exit 0
}

if ($Action -eq 'status') {
    $st = Read-State
    if ($null -eq $st) {
        'DETAIL: status no-active-blink'
        'FLASHED=0'
    } else {
        $alive = $null -ne (Get-Process -Id ([int]$st.pid) -ErrorAction SilentlyContinue)
        $vis = if ($null -ne $st.visible) { [bool]$st.visible } else { $null }
        $tin = if ($null -ne $st.tinted) { [bool]$st.tinted } else { $null }
        "DETAIL: status pid=$($st.pid) alive=$alive visible=$vis tinted=$tin hwnd=$($st.hwnd) uid=$($st.uid)"
        if ($alive) { 'FLASHED=1' } else { 'FLASHED=0' }
    }
    exit 0
}

# Resolve the target icon for probe, start and loop.
$foundHwnd = [IntPtr]::Zero
$foundUid = 0
$ix = 0; $iy = 0; $iw = 0; $ih = 0
$locate = [TrayQuery]::Locate([uint32]$TargetPid, [ref]$foundHwnd, [ref]$foundUid,
                              [ref]$ix, [ref]$iy, [ref]$iw, [ref]$ih)

if ($Action -eq 'probe') {
    if ($locate -eq '') {
        'DETAIL: probe no-tray-icon'
        'FLASHED=0'
        exit 0
    }
    "DETAIL: probe $locate rect=($ix,$iy) ${iw}x${ih}"
    'FLASHED=1'
    exit 0
}

if ($locate -eq '') {
    "DETAIL: $Action no-tray-icon"
    'FLASHED=0'
    exit 0
}

# ---------------------------------------------------------------------------
# start: detach the blink loop and return immediately
# ---------------------------------------------------------------------------
if ($Action -eq 'start') {
    [void](Stop-Existing)

    # The loop runs in its own process so this invocation can exit at once.
    # -EncodedCommand avoids quoting problems with the script path.
    $loopArgs = @(
        '-Action', 'loop',
        '-TargetPid', [string]$TargetPid,
        '-IntervalMs', [string]$IntervalMs
    )

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(
        "& '$PSCommandPath' " + ($loopArgs -join ' ')))
    $child = Start-Process -FilePath $powershellExe -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', $encoded
    ) -WindowStyle Hidden -PassThru

    # Claim the state file now, with the child's pid. The loop overwrites it a
    # moment later with the same pid plus the rect; writing it here means
    # `status` answers correctly even if it is asked immediately, before the
    # child has finished starting PowerShell.
    Write-State([pscustomobject]@{
        pid      = $child.Id
        hwnd     = [int64]$foundHwnd
        uid      = [int]$foundUid
        x        = $ix
        y        = $iy
        w        = $iw
        h        = $ih
        interval = $IntervalMs
        started  = (Get-Date).ToString('s')
    })

    "DETAIL: start $locate rect=($ix,$iy) ${iw}x${ih} interval=${IntervalMs}ms loopPid=$($child.Id)"
    'FLASHED=1'
    exit 0
}

# ---------------------------------------------------------------------------
# loop: own the overlay until the state file disappears or we are killed
# ---------------------------------------------------------------------------
$overlay = New-Object TrayOverlay($ix, $iy, $iw, $ih)
$overlay.Show()
# `Show()` alone leaves the overlay invisible: this process was launched with
# -WindowStyle Hidden, so Windows applies SW_HIDE to the first ShowWindow and
# ignores the request. Forcing it makes the overlay actually appear.
$overlay.ForceShow()
[System.Windows.Forms.Application]::DoEvents()

# Capture the real glyph now, before the overlay paints over it, so the alert
# frame is a reddened copy of the actual icon rather than a generic dot.
$glyph = Get-GlyphCapture -X $ix -Y $iy -Width $iw -Height $ih
$clearFrame = New-ClearFrame -Width $iw -Height $ih
if ($null -ne $glyph) {
    $alertFrame = New-TintedFrame -Width $iw -Height $ih -Glyph $glyph
} else {
    $alertFrame = New-BadgeFrame -Width $iw -Height $ih
}

# Diagnostic for `status`: a running loop that cannot be seen is a bug, not a
# working blink, so the fact is reported instead of guessed.
$visible = $overlay.IsShown()

# Publish the state before entering the loop. `status` reads this file to answer
# "is a blink running", and the parent may ask immediately after `start`
# returns. The pixel work above happens first so the file already carries
# whether the overlay is really on screen and whether the glyph was captured -
# a loop that reports `visible=false` or `tinted=false` is a diagnosable bug
# rather than a silent one.
Write-State([pscustomobject]@{
    pid      = $PID
    hwnd     = [int64]$foundHwnd
    uid      = [int]$foundUid
    x        = $ix
    y        = $iy
    w        = $iw
    h        = $ih
    interval = $IntervalMs
    visible  = $visible
    tinted   = ($null -ne $glyph)
    started  = (Get-Date).ToString('s')
})

$script:Running = $true

# Whatever ends the loop, the overlay must be cleared: otherwise a red icon
# stays painted on the taskbar until Explorer restarts.
#
# Only the process that owns the state file may delete it. A newer `start`
# replaces the file, and the older loop must not wipe its successor's state
# just because it is shutting down.
$cleanup = {
    $script:Running = $false
    try { $overlay.ShowFrame($clearFrame) } catch { }
    try { $overlay.Close() } catch { }
    try { $overlay.Dispose() } catch { }
    if ($null -ne $glyph) { try { $glyph.Dispose() } catch { } }
    $st = Read-State
    if ($null -ne $st -and [int]$st.pid -eq $PID) {
        Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
    }
}

try {
    $on = $true
    while ($script:Running) {
        if ($on) { $overlay.ShowFrame($alertFrame) } else { $overlay.ShowFrame($clearFrame) }
        $on = -not $on
        [System.Windows.Forms.Application]::DoEvents()

        # Sleep in slices so a stop request is noticed promptly.
        $slept = 0
        while ($slept -lt $IntervalMs -and $script:Running) {
            Start-Sleep -Milliseconds 50
            [System.Windows.Forms.Application]::DoEvents()
            $slept += 50
            $st = Read-State
            if ($null -eq $st) { $script:Running = $false }
        }
    }
} finally {
    & $cleanup
}

'FLASHED=1'
exit 0
