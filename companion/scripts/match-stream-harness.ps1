<#
.SYNOPSIS
  I11.4.2: runs companion/scripts/match-stream-harness.mjs (the companion's state stream in a match, against the real
  VPX fork, on this one PC) and puts back everything a VPX start changes here.

.DESCRIPTION
  The harness itself is the .mjs beside this file (read its header): real Stream3dHosts, real tunnel pages in one
  Electron process, real fork instances. This script is what surrounds it, in the way of the fork's own
  tools\castcade\match-test.ps1:

  - before: saves the HKCU type-library registration and the editor key of VPX, %APPDATA%\VPinballX\BAMViewSettings.xml
    and, for -Rom, VPinMAME's nvram\<rom>.nv, cfg\<rom>.cfg and cfg\default.cfg (bytes and time stamp);
  - runs Electron (ONLY the electron.exe of the main checkout: it has Windows Firewall allow rules; any other raises a
    prompt that holds the desktop's foreground) on the harness script, with its own --user-data-dir in the run folder;
  - after, whatever happened: closes every process the harness started and left (WM_CLOSE by PID; its own PID is
    killed only as a last resort), puts the saved things back, imports the owner's canonical type-library registration
    (-CanonicalTypeLib), and prints the `vpxExe` the installed Castcade remembers (read only).

  It sends no keyboard or mouse input and never changes the foreground window. Every TCP port is in 48200-48299 on
  127.0.0.1. The fork runs from -Exe as it is (a name that does not start with VPinballX, so the installed Castcade
  does not take a test instance for a game). The owner's stock VPX is never started.

  -ClosePid <pid>: used by the harness itself: posts WM_CLOSE to that process's player window and exits.

.EXAMPLE
  pwsh -NoProfile -File companion\scripts\match-stream-harness.ps1
  pwsh -NoProfile -File companion\scripts\match-stream-harness.ps1 -Only two,three -Turns 20
#>
[CmdletBinding()]
param(
    [int]$ClosePid = 0,
    [string]$Electron = 'C:\code\repos\castcade\node_modules\electron\dist\electron.exe',
    [string]$Exe = 'C:\code\repos\castcade-vpx-wt-handoff\build\Release\cchand_GL64.exe',
    [string]$Template = 'C:\code\repos\castcade-vpx-deps\run\smoke.template.ini',
    [string]$Tables = 'C:\code\repos\castcade-vpx-deps\run\tables',
    [string]$RomTable = 'Attack from Mars LE (Midway 1995) v600.vpx',
    [string[]]$Rom = @('afm_113b'),
    [string[]]$Only = @('two', 'three', 'off', 'mismatch', 'rom', 'nostart', 'gate', 'gatecap'),
    [int]$Turns = 20,
    [string]$Root = 'C:\code\repos\castcade-vpx-deps\run\match-companion',
    [string]$CanonicalTypeLib = 'C:\code\repos\castcade-vpx-deps\run\regbackup\hkcu-typelib-before.reg',
    [string]$Label = 'run'
)
$ErrorActionPreference = 'Stop'
# `pwsh -File x.ps1 -Only a,b` hands over ONE string "a,b", not two (only -Command splits it): both lists are split
# here. The first run of the ROM group went without its nvram backup because of exactly that.
$Only = @($Only | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$Rom = @($Rom | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

try {
    if ([IntPtr]::Size -ne 8) { throw 'needs a 64-bit PowerShell' }
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class HarnessWin {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    public class Win { public IntPtr H; public string Title; public string Cls; public bool Visible; }
    public static List<Win> ForPid(uint want) {
        var list = new List<Win>();
        EnumWindows((h, l) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == want) {
                var t = new StringBuilder(512); GetWindowText(h, t, 512);
                var c = new StringBuilder(256); GetClassName(h, c, 256);
                list.Add(new Win { H = h, Title = t.ToString(), Cls = c.ToString(), Visible = IsWindowVisible(h) });
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
'@
} catch { Write-Host "helper type failed to compile or load, nothing started: $_"; exit 1 }

# WM_CLOSE to the player window of one process (as match-test.ps1 closes an instance); the editor frame as a second try.
function Close-Vpx([uint32]$id) {
    $wins = [HarnessWin]::ForPid($id)
    $pl = $wins | Where-Object { $_.Title -eq 'Visual Pinball Player' } | Select-Object -First 1
    if ($pl) { [void][HarnessWin]::PostMessage($pl.H, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); return $true }
    $posted = $false
    foreach ($w in ($wins | Where-Object Visible)) { [void][HarnessWin]::PostMessage($w.H, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); $posted = $true }
    return $posted
}

if ($ClosePid -gt 0) {
    # Only a process that runs the fork's test exe is ever touched.
    $p = Get-Process -Id $ClosePid -ErrorAction SilentlyContinue
    if (-not $p) { exit 0 }
    if ($p.Path -and ((Split-Path -Leaf $p.Path) -match '^VPinballX')) { Write-Host "PID $ClosePid is a VPinballX process, not a test instance: left alone"; exit 2 }
    if (Close-Vpx ([uint32]$ClosePid)) { exit 0 } else { exit 1 }
}

# ---------------------------------------------------------------- preconditions
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Harness = Join-Path $Here 'match-stream-harness.mjs'
$Companion = Split-Path -Parent $Here
function Fail([string]$m) { Write-Host "match-stream-harness.ps1: $m"; exit 1 }
foreach ($f in @($Electron, $Exe, $Template, $Harness, (Join-Path $Tables 'Nudge Test and Calibration.vpx'), $CanonicalTypeLib)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Fail "missing file: $f" } }
if ((Split-Path -Leaf $Exe) -match '^VPinballX') { Fail 'the fork must run under a name that does not start with VPinballX (the installed Castcade would take the instances for games)' }
foreach ($f in @('dist\main\stream3d-host.js', 'dist\watch\tunnel-end.js', 'dist\main\one-step.js')) { if (-not (Test-Path -LiteralPath (Join-Path $Companion $f))) { Fail "the companion is not built ($f): run 'npm run build' in the repo first" } }
foreach ($port in @(48201, 48202, 48203) + (48210..48289)) {
    $l = $null
    try { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port); $l.Start(); $l.Stop() }
    catch { Fail "port $port is not free on 127.0.0.1 ($($_.Exception.Message))" }
}
if (Test-Path -LiteralPath $Root) {
    Get-ChildItem -LiteralPath $Root -Filter 'pids.json' -Recurse -Depth 1 -ErrorAction SilentlyContinue | ForEach-Object {
        foreach ($e in @(Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json)) {
            $pr = Get-Process -Id $e.pid -ErrorAction SilentlyContinue
            if ($pr -and $pr.Path -eq $e.exe) { Fail "an earlier run still has a live process: PID $($e.pid) ($($_.FullName))" }
        }
    }
}
$Run = Join-Path $Root ("{0}-{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $Label)
New-Item -ItemType Directory -Force $Run, "$Run\regbackup", "$Run\vpm" | Out-Null
$LogFile = Join-Path $Run 'driver.log'
function Log([string]$m) { $line = "[{0:HH:mm:ss.fff}] {1}" -f (Get-Date), $m; Write-Host $line; try { Add-Content -LiteralPath $LogFile -Value $line } catch {} }

# ---------------------------------------------------------------- what a VPX start changes on this PC: saved
$RegDir = Join-Path $Run 'regbackup'
$RegKeys = [ordered]@{
    'typelib' = 'HKCU\Software\Classes\TypeLib\{384DF69D-3592-4041-848D-9A2D5CD081A0}'
    'editor'  = 'HKCU\Software\Visual Pinball\VP10\Editor'
}
function Export-Key([string]$key, [string]$file) {
    Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
    & reg.exe export $key $file /y *> $null
    return ($LASTEXITCODE -eq 0)
}
$regBefore = @{}; foreach ($n in $RegKeys.Keys) { $regBefore[$n] = Export-Key $RegKeys[$n] (Join-Path $RegDir "$n-before.reg") }
function Restore-Reg {
    $allOk = $true
    foreach ($n in $RegKeys.Keys) {
        $key = $RegKeys[$n]; $b = Join-Path $RegDir "$n-before.reg"; $a = Join-Path $RegDir "$n-after.reg"
        $existsNow = Export-Key $key $a
        if ($regBefore[$n]) {
            if ($existsNow -and ((Get-FileHash -LiteralPath $a).Hash -eq (Get-FileHash -LiteralPath $b).Hash)) { Log "registry ${n}: unchanged"; continue }
            Log "registry ${n}: changed by the run, restoring"
            if ($existsNow) { & reg.exe delete $key /f *> $null }
            & reg.exe import $b *> $null
            $again = Export-Key $key (Join-Path $RegDir "$n-restored.reg")
            $same = $again -and ((Get-FileHash -LiteralPath (Join-Path $RegDir "$n-restored.reg")).Hash -eq (Get-FileHash -LiteralPath $b).Hash)
            Log ("registry ${n}: restored, verified identical = {0}" -f $same); if (-not $same) { $allOk = $false }
        } elseif ($existsNow) {
            & reg.exe delete $key /f *> $null
            Log ("registry ${n}: created by the run, deleted (exit {0})" -f $LASTEXITCODE); if ($LASTEXITCODE -ne 0) { $allOk = $false }
        } else { Log "registry ${n}: absent before and after" }
    }
    $allOk
}
$BamXml = Join-Path $env:APPDATA 'VPinballX\BAMViewSettings.xml'
$BamBak = Join-Path $RegDir 'BAMViewSettings.xml.before'
$bamExisted = Test-Path -LiteralPath $BamXml
if ($bamExisted) { Copy-Item -LiteralPath $BamXml -Destination $BamBak -Force; $bamTime = (Get-Item -LiteralPath $BamXml).LastWriteTimeUtc }
function Restore-Bam {
    if ($bamExisted -and (Test-Path -LiteralPath $BamXml)) {
        if ((Get-FileHash -LiteralPath $BamXml).Hash -ne (Get-FileHash -LiteralPath $BamBak).Hash -or (Get-Item -LiteralPath $BamXml).LastWriteTimeUtc -ne $bamTime) {
            Copy-Item -LiteralPath $BamBak -Destination $BamXml -Force; (Get-Item -LiteralPath $BamXml).LastWriteTimeUtc = $bamTime
            Log 'BAMViewSettings.xml: rewritten by the run, original bytes and timestamp restored'
        } else { Log 'BAMViewSettings.xml: unchanged' }
        return ((Get-FileHash -LiteralPath $BamXml).Hash -eq (Get-FileHash -LiteralPath $BamBak).Hash)
    } elseif ($bamExisted) { Copy-Item -LiteralPath $BamBak -Destination $BamXml -Force; Log 'BAMViewSettings.xml: was deleted, restored'; return $true }
    elseif (Test-Path -LiteralPath $BamXml) { Remove-Item -LiteralPath $BamXml -Force; Log 'BAMViewSettings.xml: created by the run, removed'; return $true }
    return $true
}
# VPinMAME writes nvram\<rom>.nv and cfg\<rom>.cfg when a ROM table closes (and cfg\default.cfg with every one).
# Saved whatever groups run: a ROM table is in two of them, and a group list that is read wrongly must not cost a backup.
$VpmFiles = @()
if ($Rom.Count) {
    $g = Get-ItemProperty 'HKCU:\Software\Freeware\Visual PinMame\globals' -ErrorAction SilentlyContinue
    if (-not $g -or -not $g.nvram_directory) { Fail 'VPinMAME''s nvram folder is not in the registry; cannot save the files of -Rom' }
    foreach ($r in @($Rom) + 'default') {
        foreach ($f in @((Join-Path $g.nvram_directory "$r.nv"), (Join-Path $g.cfg_directory "$r.cfg"))) {
            if ($r -eq 'default' -and $f -like '*.nv') { continue }
            $e = @{ Path = $f; Existed = (Test-Path -LiteralPath $f); Bak = (Join-Path "$Run\vpm" ((Split-Path -Leaf (Split-Path -Parent $f)) + '-' + (Split-Path -Leaf $f))) }
            if ($e.Existed) { Copy-Item -LiteralPath $f -Destination $e.Bak -Force; $e.Time = (Get-Item -LiteralPath $f).LastWriteTimeUtc; $e.Hash = (Get-FileHash -LiteralPath $f).Hash }
            $VpmFiles += , $e
        }
    }
}
function Restore-Vpm {
    $ok = $true
    foreach ($e in $VpmFiles) {
        try {
            if ($e.Existed) {
                if (-not (Test-Path -LiteralPath $e.Path) -or (Get-FileHash -LiteralPath $e.Path).Hash -ne $e.Hash -or (Get-Item -LiteralPath $e.Path).LastWriteTimeUtc -ne $e.Time) {
                    Copy-Item -LiteralPath $e.Bak -Destination $e.Path -Force; (Get-Item -LiteralPath $e.Path).LastWriteTimeUtc = $e.Time
                    Log "VPinMAME $($e.Path): rewritten by the run, original bytes and timestamp restored"
                } else { Log "VPinMAME $($e.Path): unchanged" }
                if ((Get-FileHash -LiteralPath $e.Path).Hash -ne $e.Hash) { $ok = $false }
            } elseif (Test-Path -LiteralPath $e.Path) { Remove-Item -LiteralPath $e.Path -Force; Log "VPinMAME $($e.Path): created by the run, removed" }
        } catch { $ok = $false; Log "VPinMAME $($e.Path): restore failed: $_" }
    }
    $ok
}

# ---------------------------------------------------------------- run
$code = 99; $cleanOk = $true; $regOk = $true; $bamOk = $true; $vpmOk = $true; $canonOk = $true
try {
    Log "run folder $Run; groups: $($Only -join ', '); VPinMAME files saved: $(@($VpmFiles | Where-Object { $_.Existed }).Count) of $($VpmFiles.Count) (roms: $($Rom -join ', '))"
    Log ("other VPX processes (left alone): {0}" -f ((Get-Process -Name 'VPinballX*' -ErrorAction SilentlyContinue | ForEach-Object Id) -join ','))
    $psi = [Diagnostics.ProcessStartInfo]::new($Electron)
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = $Companion
    foreach ($a in @($Harness, "--user-data-dir=$Run\electron-user-data", '--out', $Run, '--exe', $Exe, '--template', $Template, '--tables', $Tables, '--closer', $MyInvocation.MyCommand.Path, '--only', ($Only -join ','), '--turns', "$Turns", '--rom-table', $RomTable)) { $psi.ArgumentList.Add($a) }
    foreach ($k in @($psi.Environment.Keys | Where-Object { $_ -like 'CASTCADE_*' -or $_ -eq 'ELECTRON_RUN_AS_NODE' })) { [void]$psi.Environment.Remove($k) }
    Log "start: `"$Electron`" `"$Harness`" --out `"$Run`" --only $($Only -join ',')"
    $proc = [Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    $code = $proc.ExitCode
    Log "the harness exited with code $code"
} catch {
    Log "FAILED: $_"
} finally {
    # Whatever the harness left running: its own processes only (the exe it started them from, by PID).
    try {
        $pidsFile = Join-Path $Run 'pids.json'
        if (Test-Path -LiteralPath $pidsFile) {
            $mine = @(Get-Content -LiteralPath $pidsFile -Raw | ConvertFrom-Json)
            $alive = @()
            foreach ($e in $mine) { $pr = Get-Process -Id $e.pid -ErrorAction SilentlyContinue; if ($pr -and $pr.Path -eq $e.exe) { $alive += , $pr } }
            foreach ($pr in $alive) { Log "PID $($pr.Id) ($($pr.Path)) is still running: WM_CLOSE"; [void](Close-Vpx ([uint32]$pr.Id)) }
            foreach ($pr in $alive) {
                if (-not $pr.WaitForExit(25000)) {
                    $cleanOk = $false
                    Log "PID $($pr.Id) did not exit; last resort: killing the harness's own process"
                    try { Stop-Process -Id $pr.Id -Force; [void]$pr.WaitForExit(10000) } catch { Log "kill failed: $_" }
                }
            }
            Log ("test processes left: {0}" -f (@($mine | Where-Object { $pr = Get-Process -Id $_.pid -ErrorAction SilentlyContinue; $pr -and $pr.Path -eq $_.exe }).Count))
        }
    } catch { $cleanOk = $false; Log "cleanup error: $_" }
    try { $regOk = Restore-Reg } catch { $regOk = $false; Log "registry restore error: $_" }
    try { $bamOk = Restore-Bam } catch { $bamOk = $false; Log "BAM restore error: $_" }
    try { $vpmOk = Restore-Vpm } catch { $vpmOk = $false; Log "VPinMAME restore error: $_" }
    # The owner's own registration, whatever this run found when it began (it can have been another test build's).
    try {
        & reg.exe import $CanonicalTypeLib *> $null
        $canonOk = ($LASTEXITCODE -eq 0)
        $win64 = (Get-ItemProperty -Path 'Registry::HKEY_CURRENT_USER\Software\Classes\TypeLib\{384DF69D-3592-4041-848D-9A2D5CD081A0}\1.0\0\win64' -ErrorAction SilentlyContinue).'(default)'
        Log "type library: canonical registration imported (exit $LASTEXITCODE); win64 = $win64"
    } catch { $canonOk = $false; Log "canonical type-library import error: $_" }
    try {
        $settings = Join-Path $env:APPDATA 'Castcade\settings.json'
        if (Test-Path -LiteralPath $settings) { Log ("the installed Castcade's vpxExe (read only): {0}" -f ((Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json).vpxExe)) }
        else { Log 'the installed Castcade has no settings.json' }
    } catch { Log "could not read the installed Castcade's settings.json: $_" }
    Log ("cleanup: test processes clean={0}, registry restored={1}, BAMViewSettings restored={2}, VPinMAME files restored={3}, canonical type library imported={4}" -f $cleanOk, $regOk, $bamOk, $vpmOk, $canonOk)
}
if ($code -eq 0 -and $cleanOk -and $regOk -and $bamOk -and $vpmOk -and $canonOk) { Log 'MATCH STREAM HARNESS OK'; exit 0 }
Log "MATCH STREAM HARNESS FAILED (harness exit code $code)"; exit 1
