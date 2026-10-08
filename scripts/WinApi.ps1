# WinApi.ps1 — shared Win32 / GDI helpers for the DSH screenshot plugin (Windows).
# Dot-source this file; it defines the [DshShot.Win] type and Dsh* helper functions.

Set-StrictMode -Version Latest

# The Node parent decodes this process's stdout as UTF-8; without this, pwsh falls back to the
# OEM code page when stdout is a pipe and Chinese/other window titles arrive as U+FFFD.
try {
    $dshShotUtf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $dshShotUtf8
    $OutputEncoding = $dshShotUtf8
} catch { }

if (-not ('DshShot.Win' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace DshShot
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    public class WinInfo
    {
        public long Hwnd;
        public string Title = "";
        public string ClassName = "";
        public int Pid;
        public string Process = "";
        public int X, Y, W, H;
        public bool Visible;
        public bool Minimized;
        public bool Cloaked;
        public bool ToolWindow;
    }

    public static class Win
    {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT val, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int val, int size);

        public const int GWL_STYLE = -16;
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const int DWMWA_CLOAKED = 14;
        public const uint PW_CLIENTONLY = 0x1;
        public const uint PW_RENDERFULLCONTENT = 0x2;
        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;

        private static string Text(IntPtr h)
        {
            var sb = new StringBuilder(512);
            int n = GetWindowTextW(h, sb, sb.Capacity);
            return n > 0 ? sb.ToString(0, n) : "";
        }

        private static string Class(IntPtr h)
        {
            var sb = new StringBuilder(256);
            int n = GetClassNameW(h, sb, sb.Capacity);
            return n > 0 ? sb.ToString(0, n) : "";
        }

        private static bool IsCloaked(IntPtr h)
        {
            try { int v; if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out v, sizeof(int)) == 0) return v != 0; }
            catch { }
            return false;
        }

        /// <summary>Window rectangle in physical pixels, preferring the DWM frame bounds (no drop shadow).</summary>
        public static bool TryGetFrame(IntPtr h, out RECT r)
        {
            r = new RECT();
            try { if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.Right > r.Left && r.Bottom > r.Top) return true; }
            catch { }
            return GetWindowRect(h, out r);
        }

        /// <summary>Top-level windows in z-order (topmost first).</summary>
        public static WinInfo[] GetTopLevelWindows()
        {
            var list = new List<WinInfo>();
            EnumWindows((h, l) =>
            {
                var r = new RECT();
                if (!TryGetFrame(h, out r)) return true;
                uint pid; GetWindowThreadProcessId(h, out pid);
                int ex = GetWindowLong(h, GWL_EXSTYLE);
                var info = new WinInfo();
                info.Hwnd = h.ToInt64();
                info.Title = Text(h);
                info.ClassName = Class(h);
                info.Pid = (int)pid;
                try { info.Process = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { info.Process = ""; }
                info.X = r.Left; info.Y = r.Top; info.W = r.Right - r.Left; info.H = r.Bottom - r.Top;
                info.Visible = IsWindowVisible(h);
                info.Minimized = IsIconic(h);
                info.Cloaked = IsCloaked(h);
                info.ToolWindow = (ex & WS_EX_TOOLWINDOW) != 0;
                list.Add(info);
                return true;
            }, IntPtr.Zero);
            return list.ToArray();
        }

        public static RECT[] GetMonitors()
        {
            var list = new List<RECT>();
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr d) =>
            {
                var mi = new MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (GetMonitorInfo(hMon, ref mi)) list.Add(mi.rcMonitor);
                return true;
            }, IntPtr.Zero);
            return list.ToArray();
        }

        [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);

        public static RECT GetVirtualScreen()
        {
            var r = new RECT();
            r.Left = GetSystemMetrics(SM_XVIRTUALSCREEN);
            r.Top = GetSystemMetrics(SM_YVIRTUALSCREEN);
            r.Right = r.Left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
            r.Bottom = r.Top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
            return r;
        }
    }
}
'@
}

function Initialize-DshShotDpi {
    <# Make this process per-monitor DPI aware so screen/window coordinates are physical pixels. #>
    try { [void][DshShot.Win]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) }
    catch { try { [void][DshShot.Win]::SetProcessDPIAware() } catch { } }
}

# Property names are lowercase so the JSON envelope matches `windows[]` (x/y/w/h).
# PowerShell property access is case-insensitive, so $vs.W still reads the same field.
function Get-DshVirtualScreen {
    Initialize-DshShotDpi
    $r = [DshShot.Win]::GetVirtualScreen()
    [pscustomobject]@{ x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
}

function Get-DshMonitors {
    Initialize-DshShotDpi
    @([DshShot.Win]::GetMonitors()) | ForEach-Object {
        [pscustomobject]@{ x = $_.Left; y = $_.Top; w = $_.Right - $_.Left; h = $_.Bottom - $_.Top }
    }
}

function Get-DshWindows {
    <# Top-level windows, topmost first, filtered to ones a user could meaningfully pick. #>
    param([switch]$All)
    Initialize-DshShotDpi
    $wins = [DshShot.Win]::GetTopLevelWindows()
    $i = 0
    foreach ($w in $wins) {
        $z = $i; $i++
        if (-not $All) {
            if (-not $w.Visible) { continue }
            if ($w.Cloaked) { continue }
            if ($w.ToolWindow) { continue }
            if ([string]::IsNullOrWhiteSpace($w.Title)) { continue }
            if ($w.W -lt 40 -or $w.H -lt 40) { continue }
        }
        [pscustomobject]@{
            hwnd = $w.Hwnd; title = $w.Title; process = $w.Process; pid = $w.Pid
            className = $w.ClassName; x = $w.X; y = $w.Y; w = $w.W; h = $w.H
            minimized = $w.Minimized; z = $z
        }
    }
}

function New-DshScreenBitmap {
    <# GDI screen copy of a rectangle in physical pixels. Negative origins (multi-monitor) are fine. #>
    param([int]$X, [int]$Y, [int]$W, [int]$H)
    if ($W -le 0 -or $H -le 0) { throw "invalid capture rect ${W}x${H}" }
    $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally { $g.Dispose() }
    return $bmp
}

function New-DshWindowBitmap {
    <# Capture one window. Tries PrintWindow(PW_RENDERFULLCONTENT), then PrintWindow(0), then a screen copy of its rect. #>
    param([Parameter(Mandatory)][int64]$Hwnd, [switch]$AllowScreenFallback)
    Initialize-DshShotDpi
    $h = [IntPtr]::new($Hwnd)
    $r = New-Object DshShot.RECT
    if (-not [DshShot.Win]::TryGetFrame($h, [ref]$r)) { throw "window $Hwnd has no rectangle" }
    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
    if ($w -le 0 -or $ht -le 0) { throw "window $Hwnd has an empty rectangle (${w}x${ht})" }

    $bmp = $null; $flags = 0
    foreach ($f in @([DshShot.Win]::PW_RENDERFULLCONTENT, [uint32]0)) {
        $cand = New-Object System.Drawing.Bitmap($w, $ht, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($cand)
        $hdc = $g.GetHdc()
        $ok = $false
        try { $ok = [DshShot.Win]::PrintWindow($h, $hdc, $f) } finally { $g.ReleaseHdc($hdc); $g.Dispose() }
        if ($ok -and -not (Test-DshBitmapBlank $cand)) { $bmp = $cand; $flags = $f; break }
        $cand.Dispose()
    }
    if ($null -eq $bmp) {
        if (-not $AllowScreenFallback) { throw "PrintWindow produced no image for window $Hwnd (it may be minimized or GPU-composited)" }
        $bmp = New-DshScreenBitmap -X $r.Left -Y $r.Top -W $w -H $ht
        $flags = -1
    }
    return [pscustomobject]@{ Bitmap = $bmp; X = $r.Left; Y = $r.Top; W = $w; H = $ht; Flags = $flags }
}

function Test-DshBitmapBlank {
    <# True when a sampled grid of pixels is a single flat colour (PrintWindow failure signature). #>
    param($Bitmap)
    $seen = @{}
    $sx = [Math]::Max(1, [int]($Bitmap.Width / 24))
    $sy = [Math]::Max(1, [int]($Bitmap.Height / 24))
    for ($y = 0; $y -lt $Bitmap.Height; $y += $sy) {
        for ($x = 0; $x -lt $Bitmap.Width; $x += $sx) {
            $c = $Bitmap.GetPixel($x, $y).ToArgb()
            $seen[$c] = 1
            if ($seen.Count -gt 2) { return $false }
        }
    }
    return $true
}

function Resize-DshBitmap {
    <# Scale / cap a bitmap. Takes ownership of $Bitmap and disposes it when a copy is made. #>
    param([Parameter(Mandatory)]$Bitmap, [double]$Scale = 1, [int]$MaxWidth = 0)
    $w = $Bitmap.Width; $h = $Bitmap.Height
    $tw = $w; $th = $h
    if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) { $tw = $MaxWidth; $th = [int][Math]::Round($h * $MaxWidth / $w) }
    if ($Scale -ne 1) { $tw = [int][Math]::Round($tw * $Scale); $th = [int][Math]::Round($th * $Scale) }
    if ($tw -lt 1) { $tw = 1 }; if ($th -lt 1) { $th = 1 }
    if ($tw -eq $w -and $th -eq $h) { return $Bitmap }
    $out = New-Object System.Drawing.Bitmap($tw, $th, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($out)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.DrawImage($Bitmap, 0, 0, $tw, $th)
    } finally { $g.Dispose() }
    $Bitmap.Dispose()
    return $out
}

function Save-DshImage {
    <# Save a bitmap as png or jpeg. Returns the real absolute path (extension may be corrected). #>
    param([Parameter(Mandatory)]$Bitmap, [Parameter(Mandatory)][string]$Path, [string]$Format = 'png', [int]$Quality = 88)
    $fmt = $Format.ToLowerInvariant()
    if ($fmt -eq 'jpg') { $fmt = 'jpeg' }
    if ($fmt -ne 'png' -and $fmt -ne 'jpeg') { throw "unsupported image format '$Format'" }
    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($fmt -eq 'jpeg' -and $ext -ne '.jpg' -and $ext -ne '.jpeg') { $Path = [System.IO.Path]::ChangeExtension($Path, '.jpg') }
    if ($fmt -eq 'png' -and $ext -ne '.png') { $Path = [System.IO.Path]::ChangeExtension($Path, '.png') }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if ($fmt -eq 'png') {
        $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } else {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $ps = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)
        $Bitmap.Save($Path, $codec, $ps)
        $ps.Dispose()
    }
    return (Get-Item $Path).FullName
}

function Save-DshPng {
    param([Parameter(Mandatory)]$Bitmap, [Parameter(Mandatory)][string]$Path, [string]$Format = 'png', [int]$Quality = 88)
    return (Save-DshImage -Bitmap $Bitmap -Path $Path -Format $Format -Quality $Quality)
}

function Write-DshJson {
    param($Object)
    $Object | ConvertTo-Json -Depth 6 -Compress
}
