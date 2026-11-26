<#
  Castcade build check.

  Why Castcade cannot tell which Visual Pinball X build ran. Read-only: changes nothing, starts or stops
  nothing, uses no network, needs no administrator rights (and must NOT be run as administrator: it has
  to see what Castcade sees).

  How to run:
    1. Start a table the way you normally do (from PinUP Popper) and leave it running.
    2. Double-click "Castcade Build Check.cmd" (or, in an ordinary PowerShell window:
       powershell -NoProfile -ExecutionPolicy Bypass -File castcade-build-check.ps1 )
    3. Send back the castcade-build-check-<date>.txt file it writes on your Desktop.

  Your Windows user name is replaced by <user> in the report.
#>
param([string]$OutDir = '')

$ErrorActionPreference = 'Continue'
$out = New-Object System.Collections.Generic.List[string]
$summary = New-Object System.Collections.Generic.List[string]
$user = $env:USERNAME
function Mask([string]$s) {
    if (-not $s) { return $s }
    $s = $s -replace [regex]::Escape($env:USERPROFILE), '%USERPROFILE%'
    if ($user) { $s = $s -replace ('(?i)\b' + [regex]::Escape($user) + '\b'), '<user>' }
    return $s
}
function L([string]$s) { $out.Add((Mask $s)) }
function S([string]$s) { $summary.Add((Mask $s)); L ('>> ' + $s) }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CcProc {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder sb, ref int size);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int ret);
    const uint QUERY_LIMITED = 0x1000;
    const uint TOKEN_QUERY = 0x8;
    public static string ImagePath(int pid) {
        IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) return null;
        try { var sb = new StringBuilder(2048); int n = sb.Capacity; return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : null; }
        finally { CloseHandle(h); }
    }
    public static string Elevated(int pid) {
        IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) return "unknown (cannot open the process, error " + Marshal.GetLastWin32Error() + ")";
        try {
            IntPtr t;
            if (!OpenProcessToken(h, TOKEN_QUERY, out t)) return "unknown (cannot read its token, error " + Marshal.GetLastWin32Error() + "; this usually means it IS elevated)";
            try {
                IntPtr buf = Marshal.AllocHGlobal(4);
                try {
                    int ret;
                    if (!GetTokenInformation(t, 20, buf, 4, out ret)) return "unknown (error " + Marshal.GetLastWin32Error() + ")";
                    return Marshal.ReadInt32(buf) != 0 ? "YES" : "no";
                } finally { Marshal.FreeHGlobal(buf); }
            } finally { CloseHandle(t); }
        } finally { CloseHandle(h); }
    }
}
'@

# Official release hashes the companion recognises (companion/src/witness/build-attestation.ts).
$known = @{
    'b4155890501729e04bce840c03b125e78c3146c13a607b352b4604e6b6a44f28' = 'VPX 10.8.0 release (DirectX, x64)'
    'b8c47fe7bcf83c2b417636e16dafd6699a46061442796746215f246a2f26e845' = 'VPX 10.8.0 release (OpenGL/VR, x64)'
    'a745b28a2d5c9d45a412f164d4918582d1ab4c62d3a65eea672eff3a72e4eeca' = 'VPX 10.8.0 release (DirectX, x86)'
    'bd2e07facca5c59306ea8d6e44f57b3e95847b9d887ef9a0edbc779e11696400' = 'VPX 10.8.0 release (OpenGL/VR, x86)'
    '0cd80bca2df4a499fe832772a3d638513c2ffb2da531dad6a618d9df49cc65fc' = 'VPinMAME 3.6.0 release (x64)'
    'de79c95545452915762c956402180366b65ec558f31e41bb33432fa16b3f0e30' = 'VPinMAME 3.6.0 release (x86)'
    '69ebacabdb7e1af0533142a8456341f06e9d4b6cb3dc4649f18794be456ea8c1' = 'VPinMAME 3.6.0 release (x64, -sc)'
}

function Describe-Binary([string]$path, [string]$what, [int[]]$minVersion) {
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { L ('  ' + $what + ': file not found at ' + $path); return }
    try {
        $fi = Get-Item -LiteralPath $path
        $vi = $fi.VersionInfo
        $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
        L ('  ' + $what + ': ' + $path)
        L ('    FileVersion text: ' + $vi.FileVersion + '   ProductVersion text: ' + $vi.ProductVersion)
        L ('    numeric: ' + $vi.FileMajorPart + '.' + $vi.FileMinorPart + '.' + $vi.FileBuildPart + '.' + $vi.FilePrivatePart + '   size ' + $fi.Length + '   modified ' + $fi.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
        L ('    SHA-256: ' + $sha + '   ' + $(if ($known.ContainsKey($sha)) { '(official: ' + $known[$sha] + ')' } else { '(not an official release hash)' }))
        $v = @($vi.FileMajorPart, $vi.FileMinorPart, $vi.FileBuildPart)
        $ok = ($v[0] -gt $minVersion[0]) -or ($v[0] -eq $minVersion[0] -and ($v[1] -gt $minVersion[1] -or ($v[1] -eq $minVersion[1] -and $v[2] -ge $minVersion[2])))
        if (-not $vi.FileVersion) { S ('PROBLEM ' + $what + ' has no version text; ArcAid cannot pass it by version') }
        elseif (-not $ok) { S ('PROBLEM ' + $what + ' is version ' + ($v -join '.') + ', older than ' + ($minVersion -join '.') + '; ArcAid passes only ' + ($minVersion -join '.') + ' and later by version') }
        else { S ('OK ' + $what + ' version ' + ($v -join '.') + ' would pass ArcAid by version, if Castcade can read the file') }
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $txt = [System.Text.Encoding]::ASCII.GetString($bytes)
        if ($txt -match 'requireAdministrator') { S ('PROBLEM ' + $what + "'s own manifest asks Windows to run it as administrator") }
    } catch { L ('  ' + $what + ': could not read: ' + $_.Exception.Message) }
}

L ('Castcade build check, ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
L ''

# ---------------------------------------------------------------- 1. this window
L '1. This window and Windows'
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$meAdmin = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
L ('  this check runs elevated: ' + $meAdmin)
if ($meAdmin) { S 'CHECK this check was run as administrator, so it sees more than Castcade does. Run it again by double-clicking, not "Run as administrator"' }
try {
    $sys = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System')
    L ('  UAC EnableLUA: ' + $sys.GetValue('EnableLUA') + '   ConsentPromptBehaviorAdmin: ' + $sys.GetValue('ConsentPromptBehaviorAdmin'))
    if ($sys.GetValue('EnableLUA') -eq 0) { S 'CHECK UAC is switched off (EnableLUA = 0): every program of an administrator account runs elevated, Castcade included' }
} catch { }
$cast = @(Get-CimInstance Win32_Process -Filter "Name = 'Castcade.exe'" -ErrorAction SilentlyContinue)
if ($cast.Count -gt 0) { L ('  Castcade.exe running: yes, elevated: ' + [CcProc]::Elevated([int]$cast[0].ProcessId)) } else { L '  Castcade.exe running: no' }
L ''

# ---------------------------------------------------------------- 2. running VPX
L '2. Running Visual Pinball X (what Castcade sees, and what is really there)'
$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$byPid = @{}; foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
$vpx = @($all | Where-Object { $_.Name -like 'VPinballX*' })
$vpxPaths = New-Object System.Collections.Generic.List[string]
if ($vpx.Count -eq 0) { S 'CHECK no VPinballX process is running. Start a table from Popper first, leave it running, and run this again' }
foreach ($p in $vpx) {
    $procId = [int]$p.ProcessId
    $real = [CcProc]::ImagePath($procId)
    L ('  ' + $p.Name + ' (pid ' + $procId + ')')
    L ('    path Castcade reads (Win32_Process.ExecutablePath): ' + $(if ($p.ExecutablePath) { $p.ExecutablePath } else { '<EMPTY>' }))
    L ('    command line Castcade reads: ' + $(if ($p.CommandLine) { $p.CommandLine } else { '<EMPTY>' }))
    L ('    real path (QueryFullProcessImageName): ' + $real)
    $elev = [CcProc]::Elevated($procId)
    L ('    elevated (running as administrator): ' + $elev)
    if (-not $p.ExecutablePath) { S ('PROBLEM Castcade cannot read where ' + $p.Name + ' lives (empty path), so it cannot hash or version it: this is the "build unknown" flag') }
    if ($elev -like 'YES*' -or $elev -like 'unknown (cannot read its token*') { S ('PROBLEM ' + $p.Name + ' is running elevated (as administrator)') }
    if ($real) { $vpxPaths.Add($real) } elseif ($p.ExecutablePath) { $vpxPaths.Add($p.ExecutablePath) }
    # who started it
    $chain = @(); $cur = $p; $guard = 0
    while ($cur -and $guard -lt 6) {
        $ppid = [int]$cur.ParentProcessId; $guard++
        $parent = $byPid[$ppid]
        if (-not $parent -or $parent.CreationDate -gt $cur.CreationDate) { $chain += ('pid ' + $ppid + ' (no longer running)'); break }
        $chain += ($parent.Name + ' (pid ' + $ppid + ', elevated: ' + [CcProc]::Elevated($ppid) + ')')
        $cur = $parent
    }
    L ('    started by: ' + ($chain -join '  <-  '))
}
L ''

# ---------------------------------------------------------------- 3. PinUP
L '3. PinUP Popper'
$pupNames = 'PinUpMenu.exe', 'PinUpMenuSetup.exe', 'PinUpDisplay.exe', 'PinUpPlayer.exe', 'PuPServer.exe', 'PinUpCloud.exe'
$pupProcs = @($all | Where-Object { $pupNames -contains $_.Name })
if ($pupProcs.Count -eq 0) { L '  no PinUP process is running' }
$pupDir = $null
foreach ($p in $pupProcs) {
    $procId = [int]$p.ProcessId
    $real = [CcProc]::ImagePath($procId)
    $elev = [CcProc]::Elevated($procId)
    L ('  ' + $p.Name + ' (pid ' + $procId + '): ' + $real + '   elevated: ' + $elev)
    if ($real -and -not $pupDir) { $pupDir = Split-Path -Parent $real }
    if ($p.Name -eq 'PinUpMenu.exe' -and ($elev -like 'YES*' -or $elev -like 'unknown (cannot read its token*')) {
        S 'PROBLEM PinUP Popper (PinUpMenu.exe) runs as administrator, and every table it starts inherits that'
    }
}
if (-not $pupDir) { foreach ($d in 'C:\vPinball\PinUPSystem', 'D:\vPinball\PinUPSystem', 'C:\PinUPSystem') { if (Test-Path $d) { $pupDir = $d; break } } }
if ($pupDir) {
    L ('  PinUP folder: ' + $pupDir)
    $menu = Join-Path $pupDir 'PinUpMenu.exe'
    if (Test-Path $menu) {
        $t = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($menu))
        L ('  PinUpMenu.exe manifest asks for administrator: ' + ($t -match 'requireAdministrator'))
    }
}
L ''

# ---------------------------------------------------------------- 4. run-as-admin settings
L '4. "Run as administrator" settings for pinball programs (compatibility flags and startup tasks)'
$pat = '(?i)pinup|pinball|vpx|vpinmame|popper|pupserver|pupcloud|b2s|\bdof|dmdext|freezy|ultradmd'
$found = $false
foreach ($hive in 'CurrentUser', 'LocalMachine') {
    try {
        $k = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, 'Registry64').OpenSubKey('Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers')
        if ($k) {
            foreach ($n in $k.GetValueNames()) {
                $v = [string]$k.GetValue($n)
                if ($n -match $pat) {
                    L ('  ' + $hive + ': ' + $n + ' = ' + $v); $found = $true
                    if ($v -match 'RUNASADMIN') { S ('PROBLEM ' + (Split-Path -Leaf $n) + ' is set to "Run this program as an administrator" (' + $hive + ')') }
                }
            }
        }
    } catch { }
}
if (-not $found) { L '  no compatibility flags on pinball programs' }
try {
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { (($_.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' ') -match $pat })
    foreach ($t in $tasks) {
        $acts = ($t.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' ; '
        L ('  task ' + $t.TaskPath + $t.TaskName + ': run level ' + $t.Principal.RunLevel + ', state ' + $t.State + ': ' + $acts)
        if ([string]$t.Principal.RunLevel -eq 'Highest') { S ('PROBLEM the startup task "' + $t.TaskName + '" runs ' + $acts.Trim() + ' with highest privileges (as administrator)') }
    }
    if ($tasks.Count -eq 0) { L '  no scheduled task starts a pinball program' }
} catch { L ('  scheduled tasks: could not list (' + $_.Exception.Message + ')') }
L ''

# ---------------------------------------------------------------- 5. the binaries
L '5. The VPX exe and VPinMAME DLL'
foreach ($path in ($vpxPaths | Select-Object -Unique)) { Describe-Binary $path 'VPX exe' @(10, 8, 0) }
$dll = $null
foreach ($view in 'Registry64', 'Registry32') {
    try {
        $cr = [Microsoft.Win32.RegistryKey]::OpenBaseKey('ClassesRoot', $view)
        $clsid = $cr.OpenSubKey('VPinMAME.Controller\CLSID').GetValue('')
        $srv = $cr.OpenSubKey('CLSID\' + $clsid + '\InprocServer32').GetValue('')
        L ('  VPinMAME COM registration (' + $view + '): ' + $srv)
        if (-not $dll -and $srv) { $dll = $srv }
    } catch { L ('  VPinMAME COM registration (' + $view + '): none') }
}
if (-not $dll -and $vpxPaths.Count -gt 0) {
    foreach ($n in 'VPinMAME64.dll', 'VPinMAME.dll') { $c = Join-Path (Join-Path (Split-Path -Parent $vpxPaths[0]) 'VPinMAME') $n; if (Test-Path $c) { $dll = $c; break } }
}
if ($dll) { Describe-Binary $dll 'VPinMAME DLL' @(3, 6, 0) } else { S 'PROBLEM no VPinMAME DLL found (neither registered nor in a VPinMAME folder beside the exe)' }
L ''

# ---------------------------------------------------------------- 6. Castcade's own log
L "6. Castcade's log: the last build lines"
$logDir = Join-Path $env:APPDATA 'Castcade\logs'
$lines = @()
foreach ($f in 'companion.log.1', 'companion.log') {
    $p = Join-Path $logDir $f
    if (Test-Path $p) { $lines += @(Get-Content -LiteralPath $p -ErrorAction SilentlyContinue | Where-Object { $_ -match 'witness: build|VPX exe|exe not readable|witness: pid' }) }
}
if ($lines.Count -eq 0) { L '  none found' } else { $lines | Select-Object -Last 15 | ForEach-Object { L ('  ' + $_) } }
if (@($lines | Where-Object { $_ -match 'witness: build \? ' }).Count -gt 0) { S 'PROBLEM Castcade logged "build ?": it could not read the VPX exe on those games' }

# ---------------------------------------------------------------- write
$report = New-Object System.Collections.Generic.List[string]
$report.Add('SUMMARY'); foreach ($s in $summary) { $report.Add('  ' + $s) }; $report.Add(''); $report.AddRange($out)
if (-not $OutDir) { $OutDir = [Environment]::GetFolderPath('Desktop') }
$file = Join-Path $OutDir ('castcade-build-check-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.txt')
[System.IO.File]::WriteAllLines($file, $report)
Write-Host ''
foreach ($s in $summary) { Write-Host $s }
Write-Host ''
Write-Host ('Report written to ' + (Mask $file) + ' - please send that file back.')
