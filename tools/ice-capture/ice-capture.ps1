# Castcade ICE capture, version 1 (WORK I11.12.1). See README.md.
# Records what Castcade's UDP sockets send and receive through the router while a match connects, so
# analyze.mjs can say whether the other PC's connectivity checks reach this PC's network card at all.
# Needs administrator rights (pktmon, the firewall log) and asks for them when started without.
# For the length of the capture it changes, and puts back at the end: pktmon's packet filters (cleared
# before and after) and Windows Firewall's "log dropped packets" setting, per profile.
# Writes one folder, ice-capture-<date>-<time>, next to this script unless -OutDir says otherwise.
# -Check changes nothing and needs no rights: it says what a capture would use.
# Windows PowerShell 5.1, pure ASCII.
param(
    [string]$OutDir,
    [int]$MaxMinutes = 10,
    [switch]$Check,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$CaptureVersion = 1
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say([string]$s) { Write-Host $s }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-RouterMac($route) {
    $n = Get-NetNeighbor -IPAddress $route.NextHop -InterfaceIndex $route.ifIndex -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkLayerAddress -and $_.LinkLayerAddress -ne '00-00-00-00-00-00' } | Select-Object -First 1
    if ($n) { return $n.LinkLayerAddress }
    return $null
}

# The MAC address of each default gateway: filtering on it keeps the capture to traffic that crosses the
# router, so a headset streamed over the home network (Virtual Desktop) does not fill the file.
function Get-GatewayMacs {
    $macs = New-Object System.Collections.Generic.List[string]
    $routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore -ErrorAction SilentlyContinue) +
        @(Get-NetRoute -DestinationPrefix '::/0' -PolicyStore ActiveStore -ErrorAction SilentlyContinue)
    foreach ($r in $routes) {
        if (-not $r -or -not $r.NextHop -or $r.NextHop -eq '0.0.0.0' -or $r.NextHop -eq '::') { continue }
        $mac = Get-RouterMac $r
        if (-not $mac -and $r.AddressFamily -eq 'IPv4') {
            try { [void](Test-Connection -ComputerName $r.NextHop -Count 1 -Quiet) } catch { }
            $mac = Get-RouterMac $r
        }
        if ($mac -and -not $macs.Contains($mac)) { [void]$macs.Add($mac) }
    }
    return , $macs
}

# Castcade's UDP sockets right now: the Electron app (voice, the 3D link) and castcade-video.exe.
function Get-CastcadeSockets {
    $owners = @{}
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'castcade' })) {
        $owners[[int]$p.Id] = $p.ProcessName
    }
    $rows = New-Object System.Collections.Generic.List[object]
    if ($owners.Count -eq 0) { return , $rows }
    foreach ($e in @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) {
        $ownerId = [int]$e.OwningProcess
        if ($owners.ContainsKey($ownerId)) {
            [void]$rows.Add([pscustomobject]@{ process = $owners[$ownerId]; pid = $ownerId; address = $e.LocalAddress; port = $e.LocalPort })
        }
    }
    return , $rows
}

# pktmon with its output as text; never a terminating error from its stderr (Windows PowerShell 5.1
# turns a native command's redirected stderr into errors, which 'Stop' would throw).
function Invoke-Pktmon {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $text = (& pktmon @args 2>&1 | Out-String)
        return [pscustomobject]@{ code = $LASTEXITCODE; text = $text.Trim() }
    } finally { $ErrorActionPreference = $old }
}

function Utc([datetime]$d) { return $d.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") }

function Read-Shared([string]$path) {
    $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
    try { return (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
}

$node = Get-Command node -ErrorAction SilentlyContinue
$analyzer = Join-Path $Here 'analyze.mjs'

# ------------------------------------------------------------------------------------------ -Check

if ($Check) {
    Say ('Castcade ICE capture ' + $CaptureVersion + ': what a capture would use (nothing is changed)')
    Say ('  administrator now: ' + $(if (Test-Admin) { 'yes' } else { 'no (the capture asks for it)' }))
    Say ('  pktmon: ' + $(if (Get-Command pktmon -ErrorAction SilentlyContinue) { 'present' } else { 'MISSING: Windows 10 2004 or later is needed' }))
    $m = Get-GatewayMacs
    Say ('  routers found: ' + $m.Count + $(if ($m.Count -eq 0) { ' (the capture would take all UDP: a bigger file)' } else { '' }))
    foreach ($p in @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)) { Say ('  network ' + $p.InterfaceAlias + ': ' + $p.NetworkCategory) }
    foreach ($p in @(Get-NetFirewallProfile -ErrorAction SilentlyContinue)) { Say ('  firewall profile ' + $p.Name + ': enabled ' + $p.Enabled + ', logs dropped packets ' + $p.LogBlocked) }
    $s = Get-CastcadeSockets
    Say ('  Castcade UDP sockets now: ' + $s.Count + ' (' + ((@($s | ForEach-Object { $_.process }) | Sort-Object -Unique) -join ', ') + ')')
    Say ('  Node.js for the summary: ' + $(if ($node) { $node.Source } else { 'not found: the folder goes to someone who has it' }))
    exit 0
}

# ------------------------------------------------------------------------------------ rights, folder

if (-not (Test-Admin)) {
    Say 'Asking for administrator rights (pktmon and the firewall log need them) ...'
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $MyInvocation.MyCommand.Path + '"'), '-Elevated', '-MaxMinutes', $MaxMinutes)
    if ($OutDir) { $a += @('-OutDir', ('"' + $OutDir + '"')) }
    try { Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $a | Out-Null }
    catch { Say 'Not started: administrator rights were refused.'; exit 1 }
    Say 'The capture runs in the new administrator window.'
    exit 0
}

if (-not (Get-Command pktmon -ErrorAction SilentlyContinue)) { Say 'pktmon is not on this PC (Windows 10 2004 or later is needed).'; exit 1 }
$status = (Invoke-Pktmon status).text
if ($status -notmatch 'not running') {
    Say ('pktmon says: ' + $status)
    Say 'Another pktmon capture is running. Stop it first (pktmon stop), then start this again.'
    if ($Elevated) { [void](Read-Host 'Press Enter to close this window') }
    exit 1
}

if (-not $OutDir) { $OutDir = $Here }
$dir = Join-Path $OutDir ('ice-capture-' + (Get-Date).ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$etl = Join-Path $dir 'capture.etl'
$csv = Join-Path $dir 'sockets.csv'
[System.IO.File]::WriteAllText($csv, "utc,process,pid,address,port`r`n")

# ---------------------------------------------------------------------------------------- capture

$fwBefore = @(Get-NetFirewallProfile | Select-Object Name, LogBlocked, LogFileName)
$fwOn = $false
$started = $false
$filterText = 'UDP to and from the router'
$start = Get-Date
$stoppedBy = 'the time limit'
try {
    [void](Invoke-Pktmon filter remove)
    $macs = Get-GatewayMacs
    $filtered = $macs.Count -gt 0
    foreach ($mac in $macs) {
        if ((Invoke-Pktmon filter add CastcadeIce -m $mac -t UDP).code -ne 0) { $filtered = $false; break }
    }
    if (-not $filtered) {
        [void](Invoke-Pktmon filter remove)
        [void](Invoke-Pktmon filter add CastcadeIce -t UDP)
        $filterText = 'all UDP (no router filter could be set): the file grows fast, stop within a few minutes'
    }

    foreach ($p in $fwBefore) {
        if ([string]$p.LogBlocked -ne 'True') { Set-NetFirewallProfile -Name $p.Name -LogBlocked True }
    }
    $fwOn = $true

    $r = Invoke-Pktmon start --capture --comp nics --pkt-size 256 --file-name $etl --file-size 1024
    if ($r.code -ne 0) { throw ('pktmon did not start: ' + $r.text) }
    $started = $true
    $start = Get-Date

    Say ''
    Say ('Capturing (' + $filterText + ').')
    Say 'Now host the match (or join it). Press Enter here about a minute after the other player has joined,'
    Say ('or once voice works. It stops by itself after ' + $MaxMinutes + ' minutes.')
    $keys = $true
    try { [void][Console]::KeyAvailable } catch { $keys = $false; Say 'This window cannot read keys: the capture runs until the time limit.' }
    $deadline = $start.AddMinutes($MaxMinutes)
    $stop = $false
    while (-not $stop -and (Get-Date) -lt $deadline) {
        $now = Utc (Get-Date)
        $rows = Get-CastcadeSockets
        if ($rows.Count -gt 0) {
            $lines = @($rows | ForEach-Object { $now + ',' + $_.process + ',' + $_.pid + ',' + $_.address + ',' + $_.port })
            [System.IO.File]::AppendAllText($csv, (($lines -join "`r`n") + "`r`n"))
        }
        Write-Host -NoNewline ("`r  {0,4} s, Castcade UDP sockets now: {1,3}   " -f [int]((Get-Date) - $start).TotalSeconds, $rows.Count)
        $until = (Get-Date).AddMilliseconds(1000)
        while ((Get-Date) -lt $until) {
            if ($keys -and [Console]::KeyAvailable) {
                if ([Console]::ReadKey($true).Key -eq 'Enter') { $stop = $true; $stoppedBy = 'Enter'; break }
            }
            Start-Sleep -Milliseconds 100
        }
    }
    Say ''
}
finally {
    $end = Get-Date
    if ($started) { [void](Invoke-Pktmon stop) }
    [void](Invoke-Pktmon filter remove)
    if ($fwOn) {
        foreach ($p in $fwBefore) {
            try { Set-NetFirewallProfile -Name $p.Name -LogBlocked $p.LogBlocked } catch { Say ('Could not put back the firewall log setting of profile ' + $p.Name + ': ' + $_.Exception.Message) }
        }
    }
}

Say ('Stopped by ' + $stoppedBy + ' after ' + [int]($end - $start).TotalSeconds + ' s. Converting ...')

# ------------------------------------------------------------------------------- what was captured

$pcap = Join-Path $dir 'capture.pcapng'
[void](Invoke-Pktmon etl2pcap $etl --out $pcap)
if (-not (Test-Path $pcap)) { Say 'pktmon could not convert the capture to pcapng; capture.etl is in the folder.' }

# Windows Firewall's drops in the capture's window, from every log file a profile names.
$fwLines = New-Object System.Collections.Generic.List[string]
$fields = $null
$from = $start.AddSeconds(-5)
$to = $end.AddSeconds(5)
$files = @($fwBefore | ForEach-Object { [Environment]::ExpandEnvironmentVariables([string]$_.LogFileName) } | Sort-Object -Unique)
foreach ($f in @($files + @($files | ForEach-Object { $_ + '.old' }))) {
    if (-not $f -or -not (Test-Path $f)) { continue }
    try {
        foreach ($line in (Read-Shared $f) -split "`r?`n") {
            if ($line.StartsWith('#Fields:')) { $fields = $line; continue }
            if ($line -notmatch '^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ') { continue }
            $t = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
            if ($t -ge $from -and $t -le $to -and $line -match ' DROP UDP ') { [void]$fwLines.Add($line) }
        }
    } catch { Say ('Could not read ' + $f + ': ' + $_.Exception.Message) }
}
$fwText = $(if ($fields) { $fields } else { '#Fields: date time action protocol src-ip dst-ip src-port dst-port size tcpflags tcpsyn tcpack tcpwin icmptype icmpcode info path pid' }) + "`r`n" + ($fwLines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText((Join-Path $dir 'firewall.log'), $fwText)

$meta = [ordered]@{
    version          = $CaptureVersion
    startUtc         = Utc $start
    endUtc           = Utc $end
    stoppedBy        = $stoppedBy
    utcOffsetMinutes = [int][TimeZoneInfo]::Local.GetUtcOffset($start).TotalMinutes
    filter           = $filterText
    firewallLog      = $fwOn
    localAddresses   = @(Get-NetIPAddress -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.IPAddress })
}
[System.IO.File]::WriteAllText((Join-Path $dir 'meta.json'), ($meta | ConvertTo-Json -Depth 3))

Say ''
Say ('Folder: ' + $dir)
if ($node -and (Test-Path $analyzer)) {
    & $node.Source $analyzer $dir
    Say ''
    Say ('The summary is ' + (Join-Path $dir 'summary.txt') + ': it holds no address and is the file to send.')
} else {
    Say 'Node.js is not on this PC: send the whole folder to whoever asked for the capture (it holds both PCs'' public addresses).'
}
Say 'capture.pcapng and capture.etl hold the packets themselves, with addresses: keep them on this PC.'
if ($Elevated) { [void](Read-Host 'Press Enter to close this window') }
