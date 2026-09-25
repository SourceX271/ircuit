<#
.SYNOPSIS
    Drive the running client window: click, type, capture.

.DESCRIPTION
    Visual checks need more than one screenshot. Verifying the dark theme means
    clicking the theme control; verifying the command palette means pressing
    Ctrl+K. Doing that by hand for every milestone is how visual regressions get
    missed, so this puts the three primitives in one place.

    Coordinates are given in the window's own pixel space (the same space
    `capture-window.ps1` reports), with the origin at the window's top-left
    client area, so they do not depend on where the window happens to be.

    NOTE: keep this file ASCII-only. Windows PowerShell reads BOM-less script
    files as ANSI, which corrupts non-ASCII text and breaks parsing.

.EXAMPLE
    powershell -File scripts/dev/ui-drive.ps1 -Click 1775,80 -Capture .cache/dark.png
    powershell -File scripts/dev/ui-drive.ps1 -Keys '^k' -Capture .cache/palette.png
#>
[CmdletBinding()]
param(
    [string]$ProcessName = 'ircuit',
    # Window-relative X,Y to click.
    [int[]]$Click,
    # SendKeys syntax, e.g. '^k' for Ctrl+K.
    [string]$Keys,
    [Parameter(Mandatory)][string]$Capture,
    # Seconds to wait after the click or keys, before capturing.
    [double]$Settle = 1.5
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('IrcuitUiDrive' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class IrcuitUiDrive
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
}

$process = Get-Process -Name $ProcessName -ErrorAction Stop | Select-Object -First 1
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw "Process '$ProcessName' has no main window." }

$rect = New-Object IrcuitUiDrive+RECT
[IrcuitUiDrive]::GetWindowRect($handle, [ref]$rect) | Out-Null
$originX = $rect.Left
$originY = $rect.Top

# Bring it to the front so keystrokes land in it, and give the compositor a
# moment: sending keys to a window that is still activating drops them.
[IrcuitUiDrive]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 400

if ($Click -and $Click.Count -eq 2) {
    $x = $originX + $Click[0]
    $y = $originY + $Click[1]
    Write-Host "clicking window-relative ($($Click[0]),$($Click[1])) -> screen ($x,$y)"

    [IrcuitUiDrive]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 150
    # Left down + up, which is what a real click is; some UI ignores a synthetic
    # click that only sends one of the two.
    [IrcuitUiDrive]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [IrcuitUiDrive]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

if ($Keys) {
    Write-Host "sending keys '$Keys'"
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
}

Start-Sleep -Seconds $Settle

# Capture with the same PrintWindow approach as capture-window.ps1, so the
# result is identical whether or not the window is actually on top.
& (Join-Path $PSScriptRoot 'capture-window.ps1') -ProcessName $ProcessName -OutputPath $Capture
