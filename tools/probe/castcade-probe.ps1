# Castcade setup probe, version 1.
# Read-only: reads the registry, files and CIM. Writes exactly one file, the report.
# Windows PowerShell 5.1, pure ASCII. See README.md.
param(
    [string]$VpxDir,
    [string]$TablesDir,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$ProbeVersion = '1'
$Started = Get-Date

# ---------------------------------------------------------------- plumbing

$St = @{}
$script:Sections = New-Object System.Collections.Generic.List[object]
$script:Cur = $null
$SumKeys = @('vpx', 'admin', 'pm', 'b2s', 'tables', 'cfa', 'disp', 'ctl', 'fe', 'cast')
$SumLabels = @{
    vpx = 'Visual Pinball X'; admin = 'Run as administrator'; pm = 'VPinMAME'; b2s = 'B2S Server'
    tables = 'Tables'; cfa = 'Controlled Folder Access'; disp = 'Displays'; ctl = 'Controllers'
    fe = 'Frontend'; cast = 'Castcade'
}
$script:Sum = @{}
foreach ($k in $SumKeys) { $script:Sum[$k] = New-Object System.Collections.Generic.List[string] }

function L([string]$text) { [void]$script:Cur.Add($text) }
function S([string]$key, [string]$text) { [void]$script:Sum[$key].Add($text) }

function Section([string]$Title, [scriptblock]$Body) {
    $script:Cur = New-Object System.Collections.Generic.List[string]
    try { & $Body } catch { L ('(could not read: ' + $_.Exception.Message + ')') }
    [void]$script:Sections.Add(@{ Title = $Title; Lines = $script:Cur })
}

# Runs one independent part of a section; a failure is noted and the section carries on.
function Part([string]$What, [scriptblock]$Body) {
    try { & $Body } catch { L ('(could not read ' + $What + ': ' + $_.Exception.Message + ')') }
}

function YesNo($b) { if ($b) { 'yes' } else { 'no' } }

function Norm-Ver([string]$s) {
    if (-not $s) { return '' }
    return ($s -replace '\s*,\s*', '.').Trim()
}

function Get-Fv([string]$path) {
    try { return [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path) } catch { return $null }
}

function Fmt-Date($d) { try { return ([datetime]$d).ToString('yyyy-MM-dd HH:mm') } catch { return '?' } }

function Reg-Open([string]$hive, [string]$view, [string]$sub) {
    try {
        $h = [Microsoft.Win32.RegistryHive]$hive
        $v = [Microsoft.Win32.RegistryView]$view
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($h, $v)
        return $base.OpenSubKey($sub)
    } catch { return $null }
}

function Reg-Default([string]$hive, [string]$view, [string]$sub) {
    $k = Reg-Open $hive $view $sub
    if ($null -eq $k) { return $null }
    try { return [string]$k.GetValue('') } catch { return $null } finally { $k.Close() }
}

function Parse-ExePath([string]$cmd) {
    if (-not $cmd) { return $null }
    $cmd = [Environment]::ExpandEnvironmentVariables($cmd.Trim())
    if ($cmd.StartsWith('"')) {
        $e = $cmd.IndexOf('"', 1)
        if ($e -gt 1) { return $cmd.Substring(1, $e - 1) }
    }
    $m = [regex]::Match($cmd, '^(.*?\.(exe|dll))', 'IgnoreCase')
    if ($m.Success) { return $m.Groups[1].Value }
    return $cmd
}

function Dir-Exists([string]$p) {
    if (-not $p) { return $false }
    try { return [System.IO.Directory]::Exists($p) } catch { return $false }
}
function File-Exists([string]$p) {
    if (-not $p) { return $false }
    try { return [System.IO.File]::Exists($p) } catch { return $false }
}

# Reads at most $max bytes from the start of a file (shared read) and returns them as a Latin-1 string.
function Read-Head([string]$path, [int]$max) {
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $len = [int][Math]::Min([long]$max, $fs.Length)
        $buf = New-Object byte[] $len
        $n = 0
        while ($n -lt $len) {
            $r = $fs.Read($buf, $n, $len - $n)
            if ($r -le 0) { break }
            $n += $r
        }
        return [System.Text.Encoding]::GetEncoding(28591).GetString($buf, 0, $n)
    } finally { $fs.Close() }
}

# Every COM registration of a ProgID: both registry views, HKLM and HKCU. .NET classes carry a CodeBase.
function Get-ComRegs([string]$progId) {
    $res = New-Object System.Collections.Generic.List[object]
    foreach ($view in @('Registry64', 'Registry32')) {
        foreach ($hive in @('LocalMachine', 'CurrentUser')) {
            $clsid = Reg-Default $hive $view ('Software\Classes\' + $progId + '\CLSID')
            if (-not $clsid) { continue }
            foreach ($srv in @('InprocServer32', 'LocalServer32')) {
                $k = Reg-Open $hive $view ('Software\Classes\CLSID\' + $clsid + '\' + $srv)
                if ($null -eq $k) { continue }
                try {
                    $def = [string]$k.GetValue('')
                    $cb = $k.GetValue('CodeBase')
                    $asm = $k.GetValue('Assembly')
                    $subver = ''
                    if (-not $cb) {
                        foreach ($sn in $k.GetSubKeyNames()) {
                            $sk = $k.OpenSubKey($sn)
                            if ($sk) {
                                $c2 = $sk.GetValue('CodeBase')
                                if ($c2) { $cb = $c2; $subver = $sn }
                                $sk.Close()
                            }
                        }
                    }
                    $path = $null
                    if ($cb) {
                        try { $path = ([Uri][string]$cb).LocalPath } catch { $path = [string]$cb }
                    } elseif ($def -and ($def -notmatch 'mscoree\.dll$')) {
                        $path = Parse-ExePath $def
                    }
                    $bits = 64
                    if ($view -eq 'Registry32') { $bits = 32 }
                    [void]$res.Add([pscustomobject]@{
                            Bits = $bits; Hive = $hive; Clsid = $clsid; Server = $srv
                            Path = $path; Exists = (File-Exists $path); SubVersion = $subver; Assembly = $asm
                        })
                } finally { $k.Close() }
            }
        }
    }
    return $res
}

$script:Profile = $env:USERPROFILE
$script:UserName = $env:USERNAME
function Redact([string]$text) {
    if ($null -eq $text) { return '' }
    $t = $text
    try {
        if ($script:Profile) {
            $t = [regex]::Replace($t, [regex]::Escape($script:Profile), '%USERPROFILE%', 'IgnoreCase')
            $t = [regex]::Replace($t, [regex]::Escape($script:Profile.Replace('\', '/')), '%USERPROFILE%', 'IgnoreCase')
            $leaf = Split-Path -Leaf $script:Profile
            if ($leaf -and $leaf.Length -ge 2) {
                $t = [regex]::Replace($t, '(?<![A-Za-z0-9])' + [regex]::Escape($leaf) + '(?![A-Za-z0-9])', '<user>', 'IgnoreCase')
            }
        }
        if ($script:UserName) {
            $t = [regex]::Replace($t, '(?<![A-Za-z0-9])' + [regex]::Escape($script:UserName) + '(?![A-Za-z0-9])', '<user>', 'IgnoreCase')
        }
    } catch { }
    return $t
}

# ---------------------------------------------------------------- shared facts

$script:Drives = @()
try {
    $script:Drives = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } | ForEach-Object { $_.RootDirectory.FullName })
} catch { }

$script:Procs = @()
try { $script:Procs = @(Get-CimInstance Win32_Process | Select-Object Name, ExecutablePath) } catch { }

$script:CastSettings = $null
$script:CastSettingsErr = $null
$settingsPath = Join-Path $env:APPDATA 'Castcade\settings.json'
try {
    if (File-Exists $settingsPath) {
        $script:CastSettings = (Get-Content -LiteralPath $settingsPath -Raw) | ConvertFrom-Json
    }
} catch { $script:CastSettingsErr = $_.Exception.Message }

$script:VpxFolders = New-Object System.Collections.Generic.List[string]
$script:IniLoadDirs = New-Object System.Collections.Generic.List[string]
$script:PmDirs = New-Object System.Collections.Generic.List[string]
$script:B2sDirs = New-Object System.Collections.Generic.List[string]
$script:TableFolders = $null

function Add-Unique($list, [string]$p) {
    if (-not $p) { return }
    $p = $p.Trim().TrimEnd('\')
    if (-not $p) { return }
    foreach ($e in $list) { if ($e.TrimEnd('\') -ieq $p) { return } }
    [void]$list.Add($p)
}

function Get-TableFolders {
    if ($null -ne $script:TableFolders) { return $script:TableFolders }
    $c = New-Object System.Collections.Generic.List[object]
    function addc([string]$p, [string]$why, [bool]$explicit) {
        if (-not $p) { return }
        $p = $p.Trim().TrimEnd('\')
        foreach ($e in $c) { if ($e.Path -ieq $p) { return } }
        [void]$c.Add([pscustomobject]@{ Path = $p; Why = $why; Explicit = $explicit })
    }
    addc $TablesDir '-TablesDir' $true
    if ($script:CastSettings -and $script:CastSettings.tablesDir) { addc ([string]$script:CastSettings.tablesDir) "Castcade's settings" $true }
    foreach ($v in $script:VpxFolders) { addc (Join-Path $v 'Tables') 'VPX folder\Tables' $false }
    foreach ($l in $script:IniLoadDirs) { addc $l 'VPinballX.ini LoadDir' $false }
    $script:TableFolders = $c
    return $c
}

# ---------------------------------------------------------------- 1. System

Section '1. System' {
    Part 'Windows' {
        $os = Get-CimInstance Win32_OperatingSystem
        $ubr = ''
        $k = Reg-Open 'LocalMachine' 'Registry64' 'Software\Microsoft\Windows NT\CurrentVersion'
        if ($k) { $u = $k.GetValue('UBR'); if ($null -ne $u) { $ubr = '.' + $u }; $disp = $k.GetValue('DisplayVersion'); $k.Close() }
        L ('Windows: ' + $os.Caption + ', version ' + $disp + ', build ' + $os.BuildNumber + $ubr + ' (' + $os.OSArchitecture + ')')
        $script:OsCaption = $os.Caption
        $script:OsBuild = $os.BuildNumber + $ubr
    }
    Part 'PowerShell' {
        L ('PowerShell: ' + $PSVersionTable.PSVersion.ToString())
    }
    Part 'elevation' {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $pr = New-Object Security.Principal.WindowsPrincipal($id)
        L ('Elevated (running as administrator): ' + (YesNo $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)))
    }
    Part 'time zone' { L ('Time zone: ' + [TimeZoneInfo]::Local.Id) }
    Part 'RAM' {
        $cs = Get-CimInstance Win32_ComputerSystem
        L ('RAM: ' + [Math]::Round($cs.TotalPhysicalMemory / 1GB, 1) + ' GB')
    }
    Part 'GPU' {
        $gpus = @(Get-CimInstance Win32_VideoController)
        if ($gpus.Count -eq 0) { L 'GPU: none reported' }
        foreach ($g in $gpus) { L ('GPU: ' + $g.Name + ', driver ' + $g.DriverVersion) }
    }
}

# ---------------------------------------------------------------- 2. Displays

Section '2. Displays' {
    $parts = New-Object System.Collections.Generic.List[string]
    Part 'screens' {
        Add-Type -AssemblyName System.Windows.Forms
        $screens = @([System.Windows.Forms.Screen]::AllScreens)
        L ('Screens: ' + $screens.Count)
        foreach ($s in $screens) {
            $b = $s.Bounds
            $orient = 'landscape'
            if ($b.Height -gt $b.Width) { $orient = 'portrait' }
            $prim = ''
            if ($s.Primary) { $prim = ', primary' }
            L ('  ' + $s.DeviceName + ': ' + $b.Width + 'x' + $b.Height + ' at (' + $b.X + ',' + $b.Y + ')' + $prim + ', ' + $orient)
            [void]$parts.Add(($b.Width.ToString() + 'x' + $b.Height + ' ' + $orient + $prim))
        }
        L '  (sizes can be scaled by Windows display scaling; the GPU lines below give the real modes)'
        if ($screens.Count -gt 0) { S 'disp' ('OK ' + $screens.Count + ' display(s): ' + ($parts -join '; ')) }
        else { S 'disp' 'CHECK no displays reported' }
    }
    Part 'refresh rate' {
        foreach ($g in @(Get-CimInstance Win32_VideoController)) {
            if ($g.CurrentHorizontalResolution) {
                L ('  GPU "' + $g.Name + '" current mode: ' + $g.CurrentHorizontalResolution + 'x' + $g.CurrentVerticalResolution + ' at ' + $g.CurrentRefreshRate + ' Hz')
            }
        }
    }
}

# ---------------------------------------------------------------- 3. Controllers

Section '3. Game controllers and input boards' {
    $names = New-Object System.Collections.Generic.List[string]
    Part 'devices' {
        $rx = 'game controller|xbox|xinput|joystick|gamepad|pinscape|kl25|ledwiz|pacled|i-pac|ipac|ultimarc|zero delay|cleveland|csd|atgames|legends|dude|sainsmart'
        $seen = @{}
        $pnp = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.Present -ne $false -and $_.Name -match $rx })
        foreach ($d in $pnp) {
            $vp = ''
            $m = [regex]::Match([string]$d.DeviceID, 'VID_[0-9A-Fa-f]{4}&PID_[0-9A-Fa-f]{4}')
            if ($m.Success) { $vp = $m.Value.ToUpper() }
            $line = '  ' + $d.Name + ' | ' + $vp + ' | ' + $d.Status
            if ($seen.ContainsKey($line)) { continue }
            $seen[$line] = $true
            L $line
            if (-not $names.Contains([string]$d.Name)) { [void]$names.Add([string]$d.Name) }
        }
        if ($pnp.Count -eq 0) { L '  none found' }
    }
    Part 'keyboards' {
        $kb = @(Get-CimInstance Win32_Keyboard)
        L ('Keyboards: ' + $kb.Count)
    }
    if ($names.Count -gt 0) { S 'ctl' ('OK ' + ($names -join '; ')) } else { S 'ctl' 'OK none found' }
}

# ---------------------------------------------------------------- 4. Visual Pinball X

$IniKeys = @('BGSet', 'FullScreen', 'Display', 'Width', 'Height', 'Stereo3D', 'PBWEnabled', 'LRAxis', 'UDAxis', 'PlungerAxis',
    'PBWAccelGainX', 'PBWAccelGainY', 'TiltSensitivity', 'EnableNudgeFilter', 'InputApi',
    'LFlipKey', 'RFlipKey', 'StartGameKey', 'PlungerKey', 'ExitGameKey', 'AddCreditKey', 'LTiltKey', 'RTiltKey', 'CTiltKey', 'LockbarKey',
    'StagedLFlipKey', 'StagedRFlipKey', 'AddCredit2Key', 'LMagnaSave', 'RMagnaSave', 'MechTilt',
    'NudgeStrength', 'PlungerSpeedAxis', 'AccelVelocityInput', 'MaxFramerate', 'SyncMode', 'DisableDWM')
$IniKeySet = @{}
foreach ($k in $IniKeys) { $IniKeySet[$k.ToLower()] = $true }

Section '4. Visual Pinball X' {
    $found = New-Object System.Collections.Generic.List[object]
    function addv([string]$p, [string]$why) {
        if (-not $p) { return }
        $p = $p.Trim().TrimEnd('\')
        foreach ($e in $found) { if ($e.Path -ieq $p) { return } }
        [void]$found.Add([pscustomobject]@{ Path = $p; Why = $why })
    }
    Part 'folder search' {
        if ($VpxDir) { addv $VpxDir '-VpxDir' }
        foreach ($p in $script:Procs) {
            if ($p.Name -like 'VPinballX*' -and $p.ExecutablePath) { addv (Split-Path -Parent $p.ExecutablePath) 'running process' }
        }
        foreach ($hive in @('CurrentUser', 'LocalMachine')) {
            $prog = Reg-Default $hive 'Registry64' 'Software\Classes\.vpx'
            if ($prog) {
                $cmd = Reg-Default $hive 'Registry64' ('Software\Classes\' + $prog + '\shell\open\command')
                $exe = Parse-ExePath $cmd
                if ($exe) { addv (Split-Path -Parent $exe) '.vpx file association' }
            }
        }
        if ($script:CastSettings -and $script:CastSettings.vpxExe) {
            addv (Split-Path -Parent ([string]$script:CastSettings.vpxExe)) "Castcade's settings"
        }
        foreach ($d in $script:Drives) {
            foreach ($rel in @('vPinball\VisualPinball', 'Visual Pinball', 'VisualPinball', 'Games\Visual Pinball', 'Program Files (x86)\Visual Pinball')) {
                $p = Join-Path $d $rel
                if (Dir-Exists $p) { addv $p 'drive scan' }
            }
        }
    }
    $St.anyExe = $false
    if ($found.Count -eq 0) { L 'No VPX folder found.' }
    foreach ($f in $found) {
        L ''
        L ('Folder: ' + $f.Path + '   (found by: ' + $f.Why + ')')
        if (-not (Dir-Exists $f.Path)) { L '  folder does not exist'; continue }
        Add-Unique $script:VpxFolders $f.Path
        Part 'executables' {
            $exes = @(Get-ChildItem -LiteralPath $f.Path -Filter 'VPinballX*.exe' -File)
            if ($exes.Count -eq 0) { L '  no VPinballX*.exe in this folder' }
            foreach ($e in $exes) {
                $St.anyExe = $true
                $v = Get-Fv $e.FullName
                $fv = ''; $pv = ''
                if ($v) { $fv = Norm-Ver $v.FileVersion; $pv = Norm-Ver $v.ProductVersion }
                L ('  ' + $e.Name + ': FileVersion ' + $fv + ', ProductVersion ' + $pv + ', ' + [Math]::Round($e.Length / 1MB, 1) + ' MB, modified ' + (Fmt-Date $e.LastWriteTime))
                $script:ver = $fv
                if (-not $script:ver) { $script:ver = $pv }
                if ($script:ver.StartsWith('10.8.0')) { S 'vpx' ('OK ' + $e.Name + ' is version ' + $script:ver) }
                else { S 'vpx' ('CHECK ' + $e.Name + ' is version ' + $script:ver + '. Castcade is built and tested against VPX 10.8.0') }
                $admin = $false
                foreach ($hive in @('CurrentUser', 'LocalMachine')) {
                    $lk = Reg-Open $hive 'Registry64' 'Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
                    if ($lk) {
                        $val = $lk.GetValue($e.FullName)
                        if ($val -and ([string]$val) -match 'RUNASADMIN') { $admin = $true }
                        $lk.Close()
                    }
                }
                L ('    run as administrator flag: ' + (YesNo $admin))
                if ($admin) { S 'admin' ('PROBLEM ' + $e.Name + ' is set to run as administrator. Castcade cannot see inside a VPX that runs as administrator') }
            }
        }
        Part 'ini' {
            $ini = Join-Path $f.Path 'VPinballX.ini'
            $which = 'beside the exe'
            if (-not (File-Exists $ini)) {
                $ini = Join-Path $env:APPDATA 'VPinballX\VPinballX.ini'
                $which = 'in %APPDATA%\VPinballX'
            }
            if (-not (File-Exists $ini)) { L '  active ini: none found (neither beside the exe nor in %APPDATA%\VPinballX)' }
            else {
                L ('  active ini: ' + $ini + '  (' + $which + ')')
                $section = ''
                foreach ($line in [System.IO.File]::ReadAllLines($ini)) {
                    $t = $line.Trim()
                    if ($t.Length -eq 0 -or $t.StartsWith(';') -or $t.StartsWith('#')) { continue }
                    if ($t.StartsWith('[') -and $t.EndsWith(']')) { $section = $t.Substring(1, $t.Length - 2); continue }
                    $i = $t.IndexOf('=')
                    if ($i -lt 1) { continue }
                    $key = $t.Substring(0, $i).Trim()
                    $val = $t.Substring($i + 1).Trim()
                    if ($section -like 'DefaultProps*') { continue }
                    if ($IniKeySet.ContainsKey($key.ToLower()) -or $key -match '^Joy') {
                        L ('    [' + $section + '] ' + $key + ' = ' + $val)
                    }
                    if ($section -eq 'RecentDir' -and $key -ieq 'LoadDir' -and $val) { Add-Unique $script:IniLoadDirs $val }
                }
            }
        }
        Part 'scripts folder' {
            $sd = Join-Path $f.Path 'scripts'
            if (-not (Dir-Exists $sd)) { L '  scripts folder: not found' }
            else {
                foreach ($n in @('core.vbs', 'controller.vbs', 'castcade.vbs')) {
                    L ('  scripts\' + $n + ': ' + (YesNo (File-Exists (Join-Path $sd $n))))
                }
                $cv = Join-Path $sd 'castcade.vbs'
                if (File-Exists $cv) {
                    $txt = [System.IO.File]::ReadAllText($cv, [System.Text.Encoding]::GetEncoding(28591))
                    $m = [regex]::Match($txt, '(?im)^[^\r\n]*Dim\s+Castcade_LibVersion[^\r\n]*')
                    if (-not $m.Success) { $m = [regex]::Match($txt, '(?im)^[^\r\n]*Castcade_LibVersion[^\r\n]*') }
                    if ($m.Success) { L ('  castcade.vbs declares: ' + $m.Value.Trim()) } else { L '  castcade.vbs: no Castcade_LibVersion line' }
                }
                $core = Join-Path $sd 'core.vbs'
                if (File-Exists $core) {
                    $txt = [System.IO.File]::ReadAllText($core, [System.Text.Encoding]::GetEncoding(28591))
                    $hasA = $txt.IndexOf('arcaid.vbs', [StringComparison]::OrdinalIgnoreCase) -ge 0
                    $hasC = $txt.IndexOf('castcade', [StringComparison]::OrdinalIgnoreCase) -ge 0
                    L ('  core.vbs mentions arcaid.vbs: ' + (YesNo $hasA) + '; mentions castcade: ' + (YesNo $hasC))
                }
            }
        }
    }
    if (-not $St.anyExe) { S 'vpx' 'PROBLEM no Visual Pinball X was found. Run the probe again with -VpxDir <your VPX folder>' }
    if (-not $St.anyExe) { S 'admin' 'CHECK cannot tell whether VPX runs as administrator: no VPX was found' }
    if ($St.anyExe -and $script:Sum['admin'].Count -eq 0) { S 'admin' 'OK no VPX is set to run as administrator' }
}

# ---------------------------------------------------------------- 5. VPinMAME

Section '5. VPinMAME' {
    $script:regs = @()
    Part 'registration' {
        $script:regs = @(Get-ComRegs 'VPinMAME.Controller')
        if ($script:regs.Count -eq 0) { L 'VPinMAME.Controller: not registered' }
        foreach ($r in $script:regs) {
            $fv = ''
            if ($r.Exists) { $v = Get-Fv $r.Path; if ($v) { $fv = Norm-Ver $v.FileVersion } }
            L ('Registered (' + $r.Bits + '-bit view, ' + $r.Hive + '): ' + $r.Path + '  exists: ' + (YesNo $r.Exists) + '  FileVersion: ' + $fv)
            if ($r.Exists) { Add-Unique $script:PmDirs (Split-Path -Parent $r.Path) }
        }
    }
    $script:nv = $null; $script:rom = $null
    Part 'globals' {
        $gk = Reg-Open 'CurrentUser' 'Registry64' 'Software\Freeware\Visual PinMame\globals'
        if ($null -eq $gk) { L 'HKCU\Software\Freeware\Visual PinMame\globals: not found' }
        else {
            $script:nv = [string]$gk.GetValue('nvram_directory')
            $script:rom = [string]$gk.GetValue('rompath')
            $ch = $gk.GetValue('cheat')
            $cf = $gk.GetValue('cheat_file')
            $gk.Close()
            L ('nvram_directory = ' + $script:nv)
            L ('rompath = ' + $script:rom)
            if ($null -ne $ch) { L ('cheat = ' + $ch) } else { L 'cheat = (value not present)' }
            if ($null -ne $cf) { L ('cheat_file = ' + $cf) }
        }
    }
    $script:dllDir = $null
    if ($script:PmDirs.Count -gt 0) { $script:dllDir = $script:PmDirs[0] }
    $script:nvDir = $null
    Part 'folders' {
        $nvNote = ''
        if ($script:nv) { $script:nvDir = [Environment]::ExpandEnvironmentVariables($script:nv) }
        elseif ($script:dllDir) { $script:nvDir = Join-Path $script:dllDir 'nvram'; $nvNote = ' (default: beside the dll)' }
        if ($script:nvDir -and -not [System.IO.Path]::IsPathRooted($script:nvDir) -and $script:dllDir) { $script:nvDir = Join-Path $script:dllDir $script:nvDir }
        if ($script:nvDir) {
            if (Dir-Exists $script:nvDir) {
                $n = @([System.IO.Directory]::GetFiles($script:nvDir, '*.nv')).Count
                L ('NVRAM folder' + $nvNote + ': ' + $script:nvDir + '  exists, ' + $n + ' .nv file(s)')
            } else { L ('NVRAM folder' + $nvNote + ': ' + $script:nvDir + '  does not exist') }
        } else { L 'NVRAM folder: unknown' }
        if ($script:rom) {
            $rd = [Environment]::ExpandEnvironmentVariables($script:rom)
            $romdirs = @($rd -split ';' | Where-Object { $_ })
            $tot = 0
            foreach ($d in $romdirs) {
                if (-not [System.IO.Path]::IsPathRooted($d) -and $script:dllDir) { $d = Join-Path $script:dllDir $d }
                if (Dir-Exists $d) { $c = @([System.IO.Directory]::GetFiles($d, '*.zip')).Count; $tot += $c; L ('ROM folder: ' + $d + '  exists, ' + $c + ' .zip file(s)') }
                else { L ('ROM folder: ' + $d + '  does not exist') }
            }
        }
    }
    Part 'DMD dlls' {
        foreach ($d in $script:PmDirs) {
            L ('Beside the VPinMAME dll (' + $d + '):')
            $dm = @(Get-ChildItem -LiteralPath $d -Filter 'DmdDevice*.dll' -File)
            if ($dm.Count -eq 0) { L '  no DmdDevice*.dll' }
            foreach ($x in $dm) {
                $v = Get-Fv $x.FullName
                $fv = ''; $pn = ''
                if ($v) { $fv = Norm-Ver $v.FileVersion; $pn = $v.ProductName }
                L ('  ' + $x.Name + ': FileVersion ' + $fv + ', ProductName ' + $pn)
            }
            L ('  DmdDevice.ini exists: ' + (YesNo (File-Exists (Join-Path $d 'DmdDevice.ini'))))
        }
    }
    if ($script:regs.Count -eq 0) { S 'pm' 'PROBLEM VPinMAME is not registered (the VPinMAME.Controller COM class was not found)' }
    elseif ($script:nvDir -and (Dir-Exists $script:nvDir)) {
        $fv = ''
        foreach ($r in $script:regs) { if ($r.Exists -and -not $fv) { $v = Get-Fv $r.Path; if ($v) { $fv = Norm-Ver $v.FileVersion } } }
        S 'pm' ('OK VPinMAME ' + $fv + ' registered, NVRAM folder exists: ' + $script:nvDir)
    } else {
        S 'pm' ('PROBLEM VPinMAME is registered but its NVRAM folder was not found: ' + $script:nvDir)
    }
}

# ---------------------------------------------------------------- 6. B2S Server

Section '6. B2S Server' {
    $script:regs = @()
    $script:dll = $null
    Part 'registration' {
        $script:regs = @(Get-ComRegs 'B2S.Server')
        if ($script:regs.Count -eq 0) { L 'B2S.Server: not registered' }
        foreach ($r in $script:regs) {
            $fv = ''
            if ($r.Exists) { $v = Get-Fv $r.Path; if ($v) { $fv = Norm-Ver $v.FileVersion } }
            $sv = ''
            if ($r.SubVersion) { $sv = '  registered version key: ' + $r.SubVersion }
            L ('Registered (' + $r.Bits + '-bit view, ' + $r.Hive + '): ' + $r.Path + '  exists: ' + (YesNo $r.Exists) + '  FileVersion: ' + $fv + $sv)
            if ($r.Exists -and -not $script:dll) { $script:dll = $r.Path }
            if ($r.Exists) { Add-Unique $script:B2sDirs (Split-Path -Parent $r.Path) }
        }
    }
    $script:force = '(not set)'
    Part 'controller values' {
        $ck = Reg-Open 'CurrentUser' 'Registry64' 'Software\Visual Pinball\Controller'
        if ($null -eq $ck) { L 'HKCU\Software\Visual Pinball\Controller: not found' }
        else {
            L 'HKCU\Software\Visual Pinball\Controller values:'
            foreach ($n in $ck.GetValueNames()) {
                L ('  ' + $n + ' = ' + $ck.GetValue($n))
                if ($n -ieq 'ForceDisableB2S') { $script:force = [string]$ck.GetValue($n) }
            }
            $ck.Close()
        }
    }
    Part 'plugins' {
        foreach ($d in $script:B2sDirs) {
            $pd = Join-Path $d 'Plugins'
            if (Dir-Exists $pd) {
                $names = @(Get-ChildItem -LiteralPath $pd -Directory | ForEach-Object { $_.Name })
                L ('Plugins folders in ' + $pd + ': ' + $names.Count)
                foreach ($n in $names) { L ('  ' + $n) }
            } else { L ('No Plugins folder in ' + $d) }
        }
    }
    Part 'B2STableSettings.xml' {
        $places = New-Object System.Collections.Generic.List[string]
        foreach ($d in $script:B2sDirs) { Add-Unique $places $d }
        foreach ($t in @(Get-TableFolders)) { if (Dir-Exists $t.Path) { Add-Unique $places $t.Path } }
        foreach ($p in $places) { L ('B2STableSettings.xml in ' + $p + ': ' + (YesNo (File-Exists (Join-Path $p 'B2STableSettings.xml')))) }
    }
    if ($script:regs.Count -eq 0) { S 'b2s' 'CHECK B2S Server is not registered' }
    else {
        $fv = ''
        if ($script:dll) { $v = Get-Fv $script:dll; if ($v) { $fv = Norm-Ver $v.FileVersion } }
        S 'b2s' ('OK B2S Server ' + $fv + ' registered (ForceDisableB2S = ' + $script:force + ')')
    }
}

# ---------------------------------------------------------------- 7. DOF

Section '7. DirectOutput (DOF)' {
    $script:regs = @(Get-ComRegs 'DirectOutput.ComObject')
    if ($script:regs.Count -eq 0) { L 'DirectOutput.ComObject: not registered' }
    $dirs = New-Object System.Collections.Generic.List[string]
    foreach ($r in $script:regs) {
        $fv = ''
        if ($r.Exists) { $v = Get-Fv $r.Path; if ($v) { $fv = Norm-Ver $v.FileVersion }; Add-Unique $dirs (Split-Path -Parent $r.Path) }
        L ('Registered (' + $r.Bits + '-bit view, ' + $r.Hive + '): ' + $r.Path + '  exists: ' + (YesNo $r.Exists) + '  FileVersion: ' + $fv)
    }
    $cfgs = New-Object System.Collections.Generic.List[string]
    foreach ($d in $dirs) {
        Add-Unique $cfgs (Join-Path $d 'Config')
        $par = Split-Path -Parent $d
        if ($par) { Add-Unique $cfgs (Join-Path $par 'Config') }
    }
    foreach ($c in $cfgs) {
        if (Dir-Exists $c) {
            $fn = @(Get-ChildItem -LiteralPath $c -File | ForEach-Object { $_.Name })
            L ('Config folder ' + $c + ': ' + $fn.Count + ' file(s)')
            foreach ($n in $fn) { L ('  ' + $n) }
        } else { L ('Config folder ' + $c + ': not found') }
    }
}

# ---------------------------------------------------------------- 8. PinUP and other frontends

Section '8. PinUP and other frontends' {
    $pupDirs = New-Object System.Collections.Generic.List[string]
    Part 'PinUP search' {
        foreach ($p in $script:Procs) {
            if ($p.Name -match '^(PinUpMenu|PinUpDisplay|PinUpPlayer)\.exe$' -and $p.ExecutablePath) { Add-Unique $pupDirs (Split-Path -Parent $p.ExecutablePath) }
        }
        foreach ($r in @(Get-ComRegs 'PinUpPlayer.PinDisplay')) {
            if ($r.Path -and $r.Exists) { Add-Unique $pupDirs (Split-Path -Parent $r.Path) }
        }
        foreach ($d in $script:Drives) {
            foreach ($rel in @('vPinball\PinUPSystem', 'PinUPSystem')) {
                $p = Join-Path $d $rel
                if (Dir-Exists $p) { Add-Unique $pupDirs $p }
            }
        }
    }
    if ($pupDirs.Count -eq 0) { L 'PinUP: not found' }
    foreach ($d in $pupDirs) {
        L ('PinUP folder: ' + $d)
        Part 'PinUP exes' {
            foreach ($n in @('PinUpMenu.exe', 'PinUpPlayer.exe')) {
                $p = Join-Path $d $n
                if (File-Exists $p) { $v = Get-Fv $p; $fv = ''; if ($v) { $fv = Norm-Ver $v.FileVersion }; L ('  ' + $n + ': FileVersion ' + $fv) }
                else { L ('  ' + $n + ': not found') }
            }
            $db = Join-Path $d 'PUPDatabase.db'
            if (File-Exists $db) { $fi = Get-Item -LiteralPath $db; L ('  PUPDatabase.db: ' + [Math]::Round($fi.Length / 1KB) + ' KB, modified ' + (Fmt-Date $fi.LastWriteTime)) }
            else { L '  PUPDatabase.db: not found' }
            $vd = Join-Path $d 'PUPVideos'
            if (Dir-Exists $vd) { L ('  PUPVideos subfolders: ' + @(Get-ChildItem -LiteralPath $vd -Directory).Count) } else { L '  PUPVideos: not found' }
        }
        Part 'PUPDatabase.db strings' {
            $db = Join-Path $d 'PUPDatabase.db'
            if (File-Exists $db) {
                L '  Best effort: printable text in PUPDatabase.db that mentions VPinballX (shows how the frontend launches VPX):'
                $txt = Read-Head $db 67108864
                $seen = New-Object System.Collections.Generic.List[string]
                $pos = 0
                while ($seen.Count -lt 20) {
                    $i = $txt.IndexOf('VPinballX', $pos, [StringComparison]::OrdinalIgnoreCase)
                    if ($i -lt 0) { break }
                    $a = $i
                    while ($a -gt 0 -and ($i - $a) -lt 600 -and $txt[$a - 1] -ge ' ' -and $txt[$a - 1] -le '~') { $a-- }
                    $b = $i
                    while ($b -lt $txt.Length -and ($b - $i) -lt 600 -and $txt[$b] -ge ' ' -and $txt[$b] -le '~') { $b++ }
                    $run = $txt.Substring($a, $b - $a)
                    if ($run.Length -gt 300) { $run = $run.Substring(0, 300) }
                    if (-not $seen.Contains($run)) { [void]$seen.Add($run); L ('    ' + $run) }
                    $pos = $b
                }
                if ($seen.Count -eq 0) { L '    (none)' }
            }
        }
    }
    $script:px = $false; $script:py = $false
    Part 'PinballX/PinballY' {
        foreach ($p in $script:Procs) {
            if ($p.Name -ieq 'PinballX.exe') { $script:px = $true }
            if ($p.Name -ieq 'PinballY.exe') { $script:py = $true }
        }
        foreach ($d in $script:Drives) {
            if (File-Exists (Join-Path $d 'PinballX\PinballX.exe')) { $script:px = $true }
            if (File-Exists (Join-Path $d 'PinballY\PinballY.exe')) { $script:py = $true }
        }
        L ('PinballX: ' + $(if ($script:px) { 'found' } else { 'not found' }))
        L ('PinballY: ' + $(if ($script:py) { 'found' } else { 'not found' }))
    }
    $pup = 'not found'; if ($pupDirs.Count -gt 0) { $pup = 'found' }
    $xs = 'not found'; if ($script:px) { $xs = 'found' }
    $ys = 'not found'; if ($script:py) { $ys = 'found' }
    S 'fe' ('OK PinUP (Popper or PinUpPlayer) ' + $pup + ', PinballX ' + $xs + ', PinballY ' + $ys)
}

# ---------------------------------------------------------------- 9. Tables

Section '9. Tables' {
    $marker = New-Object System.Text.RegularExpressions.Regex("(?m)^' --- Castcade \(recipe ([A-Z]) v([\d.]+), lib ([\d.]+)\) ---")
    $foreign = New-Object System.Collections.Generic.List[string]
    $processed = 0
    $cands = @(Get-TableFolders)
    if ($cands.Count -eq 0) { L 'No tables folder known.' }
    foreach ($c in $cands) {
        if ($processed -ge 3) { break }
        if (-not (Dir-Exists $c.Path)) {
            if ($c.Explicit) { L ''; L ('Folder: ' + $c.Path + '   (' + $c.Why + ')'); L '  folder does not exist'; S 'tables' ('CHECK the tables folder from ' + $c.Why + ' does not exist: ' + $c.Path) }
            continue
        }
        $processed++
        L ''
        L ('Folder: ' + $c.Path + '   (' + $c.Why + ')')
        Part 'tables folder' {
            $items = @(Get-ChildItem -LiteralPath $c.Path -File)
            $set = @{}
            $vpx = New-Object System.Collections.Generic.List[object]
            $nB2s = 0; $nVbs = 0; $nStale = 0
            foreach ($f in $items) {
                $set[$f.Name.ToLower()] = $true
                $n = $f.Name
                if ($n.EndsWith('.vpx', [StringComparison]::OrdinalIgnoreCase)) { [void]$vpx.Add($f) }
                elseif ($n.EndsWith('.directb2s', [StringComparison]::OrdinalIgnoreCase)) { $nB2s++ }
                elseif ($n.EndsWith('.vbs.stale', [StringComparison]::OrdinalIgnoreCase)) { $nStale++ }
                elseif ($n.EndsWith('.vbs', [StringComparison]::OrdinalIgnoreCase)) { $nVbs++ }
            }
            $subs = @(Get-ChildItem -LiteralPath $c.Path -Directory).Count
            L ('  .vpx: ' + $vpx.Count + ', .directb2s: ' + $nB2s + ', .vbs: ' + $nVbs + ', .vbs.stale: ' + $nStale + ', subfolders (not searched): ' + $subs)
            S 'tables' ('OK ' + $vpx.Count + ' tables in ' + $c.Path)
            $own = 0
            foreach ($f in ($vpx | Sort-Object Name)) {
                $base = $f.Name.Substring(0, $f.Name.Length - 4)
                $b2s = 'N'
                if ($set.ContainsKey(($base + '.directb2s').ToLower())) { $b2s = 'Y' }
                $state = 'none'
                $vbsName = $base + '.vbs'
                if ($set.ContainsKey($vbsName.ToLower())) {
                    $state = 'other'
                    try {
                        $head = Read-Head (Join-Path $c.Path $vbsName) 2048
                        if ($marker.IsMatch($head)) { $state = 'castcade' }
                    } catch { $state = 'other' }
                } elseif ($set.ContainsKey(($vbsName + '.stale').ToLower())) { $state = 'stale' }
                if ($state -eq 'other') { [void]$foreign.Add($base) }
                L ('  ' + $base + ' | ' + [Math]::Round($f.Length / 1MB, 1) + ' MB | backglass ' + $b2s + ' | script ' + $state)
            }
        }
    }
    if ($processed -eq 0) {
        $msg = 'CHECK no tables folder was found'
        if ($TablesDir) { $msg += ' (-TablesDir does not exist)' }
        S 'tables' ($msg + '. Run the probe again with -TablesDir <your tables folder>')
    }
    if ($foreign.Count -gt 0) {
        $names = @($foreign | Select-Object -First 10)
        $more = ''
        if ($foreign.Count -gt 10) { $more = ', and ' + ($foreign.Count - 10) + ' more' }
        S 'tables' ('CHECK ' + $foreign.Count + ' tables have a .vbs file that is not Castcade''s: Castcade leaves those tables alone and they will not post live scores (' + ($names -join '; ') + $more + ')')
    }
}

# ---------------------------------------------------------------- 10. Windows security

Section '10. Windows security' {
    Part 'Controlled Folder Access' {
        try {
            $mp = Get-MpPreference
            $cfa = $mp.EnableControlledFolderAccess
            $txt = switch ([int]$cfa) { 0 { 'off' } 1 { 'ON (blocking)' } 2 { 'audit only' } 3 { 'block disk sectors only' } 4 { 'audit disk sectors only' } default { 'unknown value' } }
            L ('Controlled Folder Access: ' + $cfa + ' (' + $txt + ')')
            $ex = @($mp.ExclusionPath)
            if ($ex.Count -gt 0 -and ([string]$ex[0]) -match 'N/A') { L 'Defender exclusion paths: not visible without administrator rights' }
            else { L ('Defender exclusion paths: ' + @($ex | Where-Object { $_ }).Count) }
            if ([int]$cfa -eq 1) { S 'cfa' 'PROBLEM Windows Controlled Folder Access is on. Windows may block Castcade from writing its script files beside your tables' }
            else { S 'cfa' ('OK Controlled Folder Access is ' + $txt) }
        } catch {
            L ('(could not read Windows Defender settings: ' + $_.Exception.Message + ')')
            S 'cfa' 'CHECK could not read Controlled Folder Access (Windows Defender may not be the active antivirus)'
        }
    }
    Part 'antivirus' {
        $av = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct | ForEach-Object { $_.displayName })
        if ($av.Count -eq 0) { L 'Antivirus products: none reported' } else { L ('Antivirus products: ' + ($av -join '; ')) }
    }
}

# ---------------------------------------------------------------- 11. Castcade

Section '11. Castcade' {
    $script:ver = $null
    $script:loc = $null
    Part 'install' {
        $uk = Reg-Open 'CurrentUser' 'Registry64' 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
        if ($uk) {
            foreach ($sn in $uk.GetSubKeyNames()) {
                $sk = $uk.OpenSubKey($sn)
                if ($sk) {
                    $dn = [string]$sk.GetValue('DisplayName')
                    if ($dn -like 'Castcade*' -and -not $script:ver) { $script:ver = [string]$sk.GetValue('DisplayVersion'); $script:loc = [string]$sk.GetValue('InstallLocation'); L ('Installed: ' + $dn + ', DisplayVersion ' + $script:ver + ', InstallLocation ' + $(if ($script:loc) { $script:loc } else { '(not recorded)' })) }
                    $sk.Close()
                }
            }
            $uk.Close()
        }
        $exe = Join-Path $env:LOCALAPPDATA 'Programs\Castcade\Castcade.exe'
        if (File-Exists $exe) {
            $v = Get-Fv $exe
            $fv = ''; if ($v) { $fv = Norm-Ver $v.FileVersion }
            L ('Castcade.exe: ' + $exe + ', FileVersion ' + $fv)
            if (-not $script:ver) { $script:ver = $fv }
        } else { L ('Castcade.exe at ' + $exe + ': not found') }
        if (-not $script:ver) { L 'Installed: no' }
        $run = @($script:Procs | Where-Object { $_.Name -ieq 'Castcade.exe' }).Count -gt 0
        L ('Running now: ' + (YesNo $run))
    }
    $script:paired = $null
    Part 'settings.json' {
        if ($script:CastSettingsErr) { L ('settings.json: could not be parsed: ' + $script:CastSettingsErr) }
        elseif ($null -eq $script:CastSettings) { L 'settings.json: not found' }
        else {
            $s = $script:CastSettings
            $script:paired = ($null -ne $s.token)
            L ('Paired (a token is stored): ' + (YesNo $script:paired))
            L ('vpxExe: ' + $(if ($s.vpxExe) { $s.vpxExe } else { '(not set)' }))
            L ('tablesDir: ' + $(if ($s.tablesDir) { $s.tablesDir } else { '(not set)' }))
        }
    }
    Part 'log' {
        $lg = Join-Path $env:APPDATA 'Castcade\logs\companion.log'
        if (File-Exists $lg) { $fi = Get-Item -LiteralPath $lg; L ('companion.log: ' + [Math]::Round($fi.Length / 1KB) + ' KB, modified ' + (Fmt-Date $fi.LastWriteTime) + ' (content not read)') }
        else { L 'companion.log: not found' }
    }
    Part 'journal' {
        $jd = Join-Path $env:LOCALAPPDATA 'Castcade\journal'
        if (Dir-Exists $jd) { L ('journal files: ' + @(Get-ChildItem -LiteralPath $jd -File -Recurse).Count) } else { L 'journal folder: not found' }
    }
    if ($script:ver) {
        $p = 'could not tell if it is paired'
        if ($null -ne $script:paired) { $p = 'paired: ' + (YesNo $script:paired) }
        S 'cast' ('OK Castcade ' + $script:ver + ' installed, ' + $p)
    } else { S 'cast' 'OK Castcade is not installed' }
}

# ---------------------------------------------------------------- assemble and write

$nl = "`r`n"
$report = New-Object System.Collections.Generic.List[string]
[void]$report.Add('Castcade setup probe, version ' + $ProbeVersion)
[void]$report.Add('Date: ' + $Started.ToString('yyyy-MM-dd HH:mm:ss zzz'))
[void]$report.Add('Windows: ' + $script:OsCaption + ', build ' + $script:OsBuild)
[void]$report.Add('')
[void]$report.Add('SUMMARY')
[void]$report.Add('=======')
$summaryLines = New-Object System.Collections.Generic.List[string]
foreach ($k in $SumKeys) {
    if ($script:Sum[$k].Count -eq 0) { [void]$script:Sum[$k].Add('CHECK ' + $SumLabels[$k] + ': could not be determined (see the sections below)') }
    foreach ($ln in $script:Sum[$k]) { [void]$summaryLines.Add($ln) }
}
foreach ($ln in $summaryLines) { [void]$report.Add($ln) }
foreach ($sec in $script:Sections) {
    [void]$report.Add('')
    [void]$report.Add($sec.Title)
    [void]$report.Add('-' * $sec.Title.Length)
    foreach ($ln in $sec.Lines) { [void]$report.Add($ln) }
}
$text = Redact (($report -join $nl) + $nl)

# Where the one file goes: -OutDir, else beside the script, else the Desktop.
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$fileName = 'castcade-probe-' + $stamp + '.txt'
$scriptDir = $null
try { $scriptDir = $PSScriptRoot } catch { }
if (-not $scriptDir) { try { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path } catch { } }
$targets = New-Object System.Collections.Generic.List[string]
if ($OutDir) { [void]$targets.Add($OutDir) }
if ($scriptDir) { [void]$targets.Add($scriptDir) }
try { [void]$targets.Add([Environment]::GetFolderPath('Desktop')) } catch { }
$savedTo = $null
foreach ($t in $targets) {
    try {
        if (-not (Dir-Exists $t)) { continue }
        $full = Join-Path $t $fileName
        [System.IO.File]::WriteAllText($full, $text, (New-Object System.Text.UTF8Encoding($true)))
        $savedTo = $full
        break
    } catch { }
}

Write-Host ''
Write-Host 'Castcade setup probe - summary'
Write-Host '=============================='
foreach ($ln in $summaryLines) { Write-Host (Redact $ln) }
Write-Host ''
if ($savedTo) {
    Write-Host ('Report saved to: ' + $savedTo)
    Write-Host 'Please send that file to whoever asked you to run this probe.'
} else {
    Write-Host 'Could not save the report file anywhere. The full report follows; please copy it and send it to whoever asked you to run this probe.'
    Write-Host $text
}
