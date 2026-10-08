# capture-window.ps1 — capture one top-level window by handle, title regex, process name, or "active".
[CmdletBinding()]
param(
    [string]$Out = "",
    [long]$Hwnd = 0,
    [string]$Title = "",
    [string]$Process = "",
    [switch]$Active,
    [switch]$Focus,
    [switch]$ScreenFallback,
    [double]$Scale = 1,
    [int]$MaxWidth = 0,
    [string]$Format = 'png',
    [int]$Quality = 88,
    [switch]$ListOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WinApi.ps1')

function Emit($o) { Write-Output (Write-DshJson $o); exit 0 }
function Fail($msg) { Write-Output (Write-DshJson ([pscustomobject]@{ ok = $false; error = "$msg" })); exit 1 }

Add-Type -AssemblyName System.Drawing
Initialize-DshShotDpi

$wins = @(Get-DshWindows)
$error_msg = ''

if ($ListOnly) { Emit ([pscustomobject]@{ ok = $true; windows = $wins }) }

if ($Hwnd -eq 0) {
    if ($Active) {
        $fg = [DshShot.Win]::GetForegroundWindow().ToInt64()
        $match = $wins | Where-Object { $_.hwnd -eq $fg } | Select-Object -First 1
        if (-not $match) { $match = @(Get-DshWindows -All | Where-Object { $_.hwnd -eq $fg }) | Select-Object -First 1 }
        if (-not $match) { Fail "no foreground window information for hwnd $fg" }
        $Hwnd = $match.hwnd
    } elseif ($Title) {
        $rx = $null
        try { $rx = [regex]::new($Title, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) } catch { Fail "invalid -Title regex: $($_.Exception.Message)" }
        $match = $wins | Where-Object { $rx.IsMatch($_.title) } | Select-Object -First 1
        if (-not $match) { Fail "no window title matches /$Title/" }
        $Hwnd = $match.hwnd
    } elseif ($Process) {
        $match = $wins | Where-Object { $_.process -like "*$Process*" } | Select-Object -First 1
        if (-not $match) { Fail "no window belongs to process '$Process'" }
        $Hwnd = $match.hwnd
    } else {
        Fail "specify -Hwnd, -Title, -Process or -Active"
    }
}

$info = $wins | Where-Object { $_.hwnd -eq $Hwnd } | Select-Object -First 1
if (-not $info) { $info = @(Get-DshWindows -All | Where-Object { $_.hwnd -eq $Hwnd }) | Select-Object -First 1 }

if ($Focus) {
    try {
        [void][DshShot.Win]::ShowWindow([IntPtr]::new($Hwnd), 9)   # SW_RESTORE
        [void][DshShot.Win]::SetForegroundWindow([IntPtr]::new($Hwnd))
        Start-Sleep -Milliseconds 350
        $info = @(Get-DshWindows -All | Where-Object { $_.hwnd -eq $Hwnd }) | Select-Object -First 1
    } catch { }
}

try { $res = New-DshWindowBitmap -Hwnd $Hwnd -AllowScreenFallback:$ScreenFallback }
catch { Fail "$($_.Exception.Message)" }

$bmp = $res.Bitmap
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
        source = 'window'; hwnd = $Hwnd; title = $(if ($info) { $info.title } else { '' })
        process = $(if ($info) { $info.process } else { '' })
        x = $res.X; y = $res.Y; w = $srcW; h = $srcH
        outW = $outW; outH = $outH; scale = $Scale
        printWindowFlags = $res.Flags; minimized = $(if ($info) { $info.minimized } else { $false })
    })
