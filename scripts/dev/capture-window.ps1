<#
.SYNOPSIS
    Capture a process main window's content, even when it is occluded.

.DESCRIPTION
    On Windows a plain screen grab only sees desktop pixels, so an occluded
    window cannot be captured. This uses user32 PrintWindow with
    PW_RENDERFULLCONTENT to render the window into a bitmap directly, which
    needs no foregrounding and works for WebView2 / DirectComposition content.

    The window bounds come from the DWM extended frame bounds when available,
    so the drop shadow is not included. It falls back to GetWindowRect.

    NOTE: keep this file ASCII-only. Windows PowerShell reads BOM-less script
    files as ANSI, which corrupts non-ASCII text and breaks parsing.

.EXAMPLE
    pwsh -File scripts/dev/capture-window.ps1 -ProcessName ircuit -OutputPath .cache/ui.png
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProcessName,
    [Parameter(Mandatory)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('IrcuitWindowCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class IrcuitWindowCapture
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);

    // DWMWA_EXTENDED_FRAME_BOUNDS = 9
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
}
'@
}

$process = Get-Process -Name $ProcessName -ErrorAction Stop | Select-Object -First 1
$handle = [IntPtr]::Zero
try {
    . (Join-Path $PSScriptRoot 'find-window.ps1')
    $handle = Get-IrcuitWindowHandle -ProcessName $ProcessName
} catch {
    # Fall back to the process's own idea of its main window rather than failing:
    # an older Windows or an unusual app may not expose anything better.
    $handle = $process.MainWindowHandle
}

if ($handle -eq [IntPtr]::Zero) {
    throw "Process '$ProcessName' has no main window yet."
}

$rect = New-Object IrcuitWindowCapture+RECT
$rectSize = [System.Runtime.InteropServices.Marshal]::SizeOf($rect)
$dwmResult = [IrcuitWindowCapture]::DwmGetWindowAttribute($handle, 9, [ref]$rect, $rectSize)
if ($dwmResult -ne 0) {
    [IrcuitWindowCapture]::GetWindowRect($handle, [ref]$rect) | Out-Null
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
    throw "Window bounds are invalid: ${width}x${height}"
}

$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$deviceContext = $graphics.GetHdc()

# flags = 2 is PW_RENDERFULLCONTENT, required for WebView2 content.
$rendered = [IrcuitWindowCapture]::PrintWindow($handle, $deviceContext, 2)

$graphics.ReleaseHdc($deviceContext)
$graphics.Dispose()

if (-not $rendered) {
    $bitmap.Dispose()
    throw 'PrintWindow failed.'
}

$directory = Split-Path -Parent $OutputPath
if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }

$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Host "Captured '$ProcessName' window (${width}x${height}) -> $OutputPath"
