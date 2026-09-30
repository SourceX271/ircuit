<#
.SYNOPSIS
    Find a process's real top-level window, and put it back on screen.

.DESCRIPTION
    `Process.MainWindowHandle` is not reliable for a WebView2 application. It
    picks the first top-level window the process owns, and Tauri creates small
    helper windows before the real one -- so it can return a 15x15 invisible
    window with no title. Every coordinate computed from that window is then
    wrong, and a synthesized click lands on whatever window happens to be at that
    screen position instead.

    That failure is silent and looks like "the app ignores my clicks", which is
    exactly the kind of thing worth removing from the tooling rather than
    debugging twice.

    A minimized window is also moved to roughly (-32000, -32000) by Windows, so
    this restores it before returning: a screenshot or a click needs a window
    that is actually somewhere.

    NOTE: keep this file ASCII-only. Windows PowerShell reads BOM-less script
    files as ANSI, which corrupts non-ASCII text and breaks parsing.

.EXAMPLE
    . "$PSScriptRoot/find-window.ps1"
    $handle = Get-IrcuitWindowHandle -ProcessName ircuit
#>

if (-not ('IrcuitWindowFinder' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class IrcuitWindowFinder
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public delegate bool EnumProc(IntPtr handle, IntPtr param);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc callback, IntPtr param);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr handle, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr handle, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr handle);

    /// Every visible top-level window the process owns, biggest first.
    public static List<IntPtr> CandidateWindows(uint target)
    {
        var found = new List<IntPtr>();
        var areas = new Dictionary<IntPtr, long>();

        EnumWindows((handle, param) =>
        {
            uint pid;
            GetWindowThreadProcessId(handle, out pid);
            if (pid != target || !IsWindowVisible(handle)) return true;

            RECT r;
            if (!GetWindowRect(handle, out r)) return true;

            long width = r.Right - r.Left;
            long height = r.Bottom - r.Top;
            long area = width * height;

            // A minimized window sits far off-screen at roughly -32000; its
            // reported size is meaningless, so rank it last rather than first.
            if (r.Left <= -30000 || r.Top <= -30000) area = -1;

            found.Add(handle);
            areas[handle] = area;
            return true;
        }, IntPtr.Zero);

        found.Sort((a, b) => areas[b].CompareTo(areas[a]));
        return found;
    }

    /// SW_RESTORE = 9
    public static bool Restore(IntPtr handle) { return ShowWindow(handle, 9); }
}
'@
}

function Get-IrcuitWindowHandle {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProcessName,
        # Put the window back on screen if it has been minimized.
        [bool]$Restore = $true
    )

    $process = Get-Process -Name $ProcessName -ErrorAction Stop | Select-Object -First 1
    $candidates = [IrcuitWindowFinder]::CandidateWindows([uint32]$process.Id)
    if ($candidates.Count -eq 0) {
        throw "Process '$ProcessName' has no visible top-level window."
    }

    $handle = $candidates[0]
    if ($Restore) {
        [IrcuitWindowFinder]::Restore($handle) | Out-Null
        Start-Sleep -Milliseconds 500
    }

    return $handle
}
