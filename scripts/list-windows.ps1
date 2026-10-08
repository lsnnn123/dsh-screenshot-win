# list-windows.ps1 — enumerate pickable top-level windows as JSON (topmost first).
[CmdletBinding()]
param([switch]$All)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WinApi.ps1')

try {
    $wins = @(Get-DshWindows -All:$All)
    Write-Output (Write-DshJson ([pscustomobject]@{ ok = $true; count = $wins.Count; virtualScreen = (Get-DshVirtualScreen); monitors = @(Get-DshMonitors); windows = $wins }))
} catch {
    Write-Output (Write-DshJson ([pscustomobject]@{ ok = $false; error = "$($_.Exception.Message)" }))
    exit 1
}
