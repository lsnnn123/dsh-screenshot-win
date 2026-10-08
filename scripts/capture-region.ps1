# capture-region.ps1 — frozen-screen region / window picker.
#
# Grabs the whole virtual desktop first, then shows it full-screen and lets the user
# either DRAG a rectangle or CLICK a window (the window under the cursor is outlined
# as you move). Enter/Space confirms the hovered window, Esc / right-click cancels.
#
# stdout is always exactly one compact JSON object.

[CmdletBinding()]
param(
    [string]$Out = "",
    [int]$TimeoutSec = 180,
    [int]$MinSize = 8,
    [double]$Scale = 1,
    [string]$Format = 'png',
    [switch]$NoWindowPick
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WinApi.ps1')

function Emit($o) { Write-Output (Write-DshJson $o); exit 0 }
function Fail($msg) { Write-Output (Write-DshJson ([pscustomobject]@{ ok = $false; error = "$msg" })); exit 1 }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

Initialize-DshShotDpi
$vs = Get-DshVirtualScreen
if ($vs.W -le 0 -or $vs.H -le 0) { Fail "no virtual screen" }

# Windows are enumerated BEFORE our overlay exists, so the overlay is never a candidate.
$candidates = @()
if (-not $NoWindowPick) {
    $skip = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow', 'SysShadow', 'ForegroundStaging')
    $candidates = @(Get-DshWindows | Where-Object {
            $_.pid -ne $PID -and $skip -notcontains $_.className -and
            -not ($_.x -le $vs.X -and $_.y -le $vs.Y -and ($_.x + $_.w) -ge ($vs.X + $vs.W) -and ($_.y + $_.h) -ge ($vs.Y + $vs.H))
        })
}

$shot = New-DshScreenBitmap -X $vs.X -Y $vs.Y -W $vs.W -H $vs.H

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Bounds = New-Object System.Drawing.Rectangle($vs.X, $vs.Y, $vs.W, $vs.H)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.KeyPreview = $true
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.BackColor = [System.Drawing.Color]::Black
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.Text = 'dsh-screenshot-win-region'
try {
    $p = $form.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'NonPublic,Instance')
    if ($p) { $p.SetValue($form, $true) }
} catch { }

# state.sel / state.hover are hashtables: @{ x; y; w; h; title? } in form coordinates.
$script:state = @{ dragging = $false; start = $null; sel = $null; hover = $null; cursor = $null; done = $false; cancelled = $false; elapsed = 0.0 }

$veil = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(135, 0, 0, 0))
$penSel = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 2
$penSelDark = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(190, 0, 0, 0)), 1
$penHover = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 90, 170, 255)), 3
$brushLabel = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(215, 20, 20, 20))
$brushText = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$brushHint = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235, 240, 240, 240))
$font = New-Object System.Drawing.Font('Segoe UI', 11)
$fontHint = New-Object System.Drawing.Font('Segoe UI', 12)

function Get-HoverWindow([System.Drawing.Point]$p) {
    if ($NoWindowPick) { return $null }
    $sx = $p.X + $vs.X; $sy = $p.Y + $vs.Y
    foreach ($c in $candidates) {
        if ($sx -ge $c.x -and $sx -lt ($c.x + $c.w) -and $sy -ge $c.y -and $sy -lt ($c.y + $c.h)) {
            return @{ x = ($c.x - $vs.X); y = ($c.y - $vs.Y); w = $c.w; h = $c.h; title = $c.title }
        }
    }
    return $null
}

function Draw-Label($g, [string]$text, [int]$x, [int]$y, $f, $brush) {
    if (-not $text) { return }
    $s = $g.MeasureString($text, $f)
    $w = [int]$s.Width + 14; $h = [int]$s.Height + 8
    if ($x + $w -gt $g.VisibleClipBounds.Width) { $x = [int]$g.VisibleClipBounds.Width - $w - 4 }
    if ($x -lt 0) { $x = 0 }
    if ($y + $h -gt $g.VisibleClipBounds.Height) { $y = [int]$g.VisibleClipBounds.Height - $h - 4 }
    $box = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
    $g.FillRectangle($brushLabel, $box)
    $g.DrawString($text, $f, $brush, ($x + 7), ($y + 4))
}

$form.Add_MouseDown({
        param($s, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) { $script:state.cancelled = $true; $s.Close(); return }
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $script:state.dragging = $true
            $script:state.start = $e.Location
            $script:state.sel = $null
            $s.Invalidate()
        }
    })

$form.Add_MouseMove({
        param($s, $e)
        $script:state.cursor = $e.Location
        if ($script:state.dragging) {
            $x1 = [Math]::Min($script:state.start.X, $e.Location.X); $y1 = [Math]::Min($script:state.start.Y, $e.Location.Y)
            $x2 = [Math]::Max($script:state.start.X, $e.Location.X); $y2 = [Math]::Max($script:state.start.Y, $e.Location.Y)
            $script:state.sel = @{ x = $x1; y = $y1; w = ($x2 - $x1); h = ($y2 - $y1); title = '' }
        } else {
            $script:state.hover = Get-HoverWindow $e.Location
        }
        $s.Invalidate()
    })

$form.Add_MouseUp({
        param($s, $e)
        if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
        $script:state.dragging = $false
        $sel = $script:state.sel
        if ($null -eq $sel -or $sel.w -lt $MinSize -or $sel.h -lt $MinSize) {
            if ($null -ne $script:state.hover) {
                $script:state.sel = $script:state.hover
            } else {
                $script:state.sel = $null; $s.Invalidate(); return
            }
        }
        $script:state.done = $true
        $s.Close()
    })

$form.Add_KeyDown({
        param($s, $e)
        if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $script:state.cancelled = $true; $s.Close() }
        elseif ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter -or $e.KeyCode -eq [System.Windows.Forms.Keys]::Space) {
            if ($null -ne $script:state.hover) {
                $script:state.sel = $script:state.hover
                $script:state.done = $true; $s.Close()
            }
        }
    })

$form.Add_Paint({
        param($s, $e)
        $g = $e.Graphics
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.DrawImageUnscaled($shot, 0, 0)
        $sel = $script:state.sel
        $active = if ($sel) { $sel } else { $script:state.hover }
        $cw = $s.ClientSize.Width; $ch = $s.ClientSize.Height
        if ($active -and $active.w -gt 0 -and $active.h -gt 0) {
            $g.FillRectangle($veil, 0, 0, $cw, $active.y)
            $g.FillRectangle($veil, 0, ($active.y + $active.h), $cw, ($ch - $active.y - $active.h))
            $g.FillRectangle($veil, 0, $active.y, $active.x, $active.h)
            $g.FillRectangle($veil, ($active.x + $active.w), $active.y, ($cw - $active.x - $active.w), $active.h)
            $rect = New-Object System.Drawing.Rectangle($active.x, $active.y, $active.w, $active.h)
            if ($script:state.dragging -or $script:state.done) {
                $g.DrawRectangle($penSelDark, [System.Drawing.Rectangle]::Inflate($rect, 1, 1))
                $g.DrawRectangle($penSel, $rect)
            } else {
                $g.DrawRectangle($penHover, $rect)
            }
            $ly = if ($active.y -ge 34) { $active.y - 32 } else { $active.y + $active.h + 6 }
            Draw-Label $g ("{0} x {1}" -f $active.w, $active.h) $active.x $ly $font $brushText
            if ($script:state.hover -and -not $script:state.dragging) {
                $t = $script:state.hover.title
                if ($t -and $t.Length -gt 90) { $t = $t.Substring(0, 90) + '...' }
                Draw-Label $g $t ($active.x + 4) ($active.y + $active.h + 6) $font $brushText
            }
        } else {
            $g.FillRectangle($veil, 0, 0, $cw, $ch)
        }
        if (-not $sel) {
            $hint = '拖动框选区域 · 单击选中窗口 · Esc 取消'
            $hs = $g.MeasureString($hint, $fontHint)
            Draw-Label $g $hint ([int](($cw - $hs.Width) / 2)) 40 $fontHint $brushHint
        }
    })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
        if ($TimeoutSec -gt 0) {
            $script:state.elapsed += 0.25
            if ($script:state.elapsed -ge $TimeoutSec) { $script:state.cancelled = $true; $form.Close() }
        }
    })
$timer.Start()

try { [void]$form.ShowDialog() } finally { $timer.Stop(); $form.Dispose() }

$result = $script:state
if ($result.cancelled -or -not $result.done -or $null -eq $result.sel) {
    $shot.Dispose()
    Emit ([pscustomobject]@{ ok = $false; cancelled = $true })
}

$sel = $result.sel
$x1 = [Math]::Max(0, [Math]::Min($sel.x, $vs.W - 1))
$y1 = [Math]::Max(0, [Math]::Min($sel.y, $vs.H - 1))
$x2 = [Math]::Max($x1 + 1, [Math]::Min($sel.x + $sel.w, $vs.W))
$y2 = [Math]::Max($y1 + 1, [Math]::Min($sel.y + $sel.h, $vs.H))
$cropRect = New-Object System.Drawing.Rectangle($x1, $y1, ($x2 - $x1), ($y2 - $y1))
$crop = $shot.Clone($cropRect, $shot.PixelFormat)
$shot.Dispose()
if ($Scale -ne 1) { $crop = Resize-DshBitmap -Bitmap $crop -Scale $Scale }

if (-not $Out) { $Out = Join-Path $env:TEMP ("dsh-screenshot-win-{0}.png" -f (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$path = Save-DshPng -Bitmap $crop -Path $Out -Format $Format
$bytes = (Get-Item $path).Length
$outW = $crop.Width; $outH = $crop.Height
$crop.Dispose()

Emit ([pscustomobject]@{
        ok = $true; path = $path; bytes = $bytes; format = $Format
        x = ($vs.X + $x1); y = ($vs.Y + $y1); w = ($x2 - $x1); h = ($y2 - $y1)
        outW = $outW; outH = $outH; scale = $Scale
        source = 'region'; virtualScreen = "$($vs.W)x$($vs.H)"
        windowTitle = $sel.title
    })
