# capture-screen.ps1 — capture the whole virtual desktop, one monitor, or an explicit rect.
[CmdletBinding()]
param(
    [string]$Out = "",
    [int]$Monitor = -1,
    [int]$X = [int]::MinValue,
    [int]$Y = [int]::MinValue,
    [int]$Width = 0,
    [int]$Height = 0,
    [double]$Scale = 1,
    [int]$MaxWidth = 0,
    [string]$Format = 'png',
    [int]$Quality = 88
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WinApi.ps1')

function Emit($o) { Write-Output (Write-DshJson $o); exit 0 }
function Fail($msg) { Write-Output (Write-DshJson ([pscustomobject]@{ ok = $false; error = "$msg" })); exit 1 }

Add-Type -AssemblyName System.Drawing

Initialize-DshShotDpi
$vs = Get-DshVirtualScreen
$monitors = @(Get-DshMonitors)

$source = 'virtual-screen'
if ($Width -gt 0 -and $Height -gt 0) {
    $rect = @{ x = $(if ($X -eq [int]::MinValue) { $vs.X } else { $X }); y = $(if ($Y -eq [int]::MinValue) { $vs.Y } else { $Y }); w = $Width; h = $Height }
    $source = 'rect'
} elseif ($Monitor -ge 0) {
    if ($Monitor -ge $monitors.Count) { Fail "monitor $Monitor out of range (0..$($monitors.Count - 1))" }
    $m = $monitors[$Monitor]
    $rect = @{ x = $m.X; y = $m.Y; w = $m.W; h = $m.H }
    $source = "monitor-$Monitor"
} else {
    $rect = @{ x = $vs.X; y = $vs.Y; w = $vs.W; h = $vs.H }
}

try { $bmp = New-DshScreenBitmap -X $rect.x -Y $rect.y -W $rect.w -H $rect.h }
catch { Fail "screen capture failed: $($_.Exception.Message)" }

$srcW = $bmp.Width; $srcH = $bmp.Height
if ($Scale -ne 1 -or $MaxWidth -gt 0) {
    if ($MaxWidth -gt 0 -and $Scale -eq 1) { $bmp = Resize-DshBitmap -Bitmap $bmp -MaxWidth $MaxWidth }
    else { $bmp = Resize-DshBitmap -Bitmap $bmp -Scale $Scale -MaxWidth $MaxWidth }
}

if (-not $Out) { $Out = Join-Path $env:TEMP ("dsh-screenshot-win-{0}.png" -f (Get-Date -Format 'yyyyMMdd-HHmmss')) }
try { $path = Save-DshImage -Bitmap $bmp -Path $Out -Format $Format -Quality $Quality }
catch { $bmp.Dispose(); Fail "save failed: $($_.Exception.Message)" }
$outW = $bmp.Width; $outH = $bmp.Height
$bmp.Dispose()

Emit ([pscustomobject]@{
        ok = $true; path = $path; bytes = (Get-Item $path).Length; format = $Format
        source = $source; x = $rect.x; y = $rect.y; w = $srcW; h = $srcH
        outW = $outW; outH = $outH; scale = $Scale; maxWidth = $MaxWidth
        virtualScreen = "$($vs.W)x$($vs.H)"; monitorCount = $monitors.Count
    })
