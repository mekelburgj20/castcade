# C16.2 bench (not CI): the real castcade.vbs writing its journal through the companion's real pipe worker, timed per
# call, beside a plain append to a held file and two FileExists calls (Castcade_Locked's check, on an existing and on a
# missing file). The spike's interleaved run (castcade-vpx-deps\run\journal-pipe-spike\bench-pipe.ps1) with the product
# code in place of the spike's: the pipe write is Castcade_Event through the library's Castcade_Write.
#
# Started by companion/scripts/journal-pipe-bench.ts, which runs the worker and reads the CSV; by hand:
#   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File journal-pipe-bench.ps1 `
#       -Lib ..\castcade.vbs -Pipe '\\.\pipe\castcade-bench-1' -Root <folder> -Csv <file>
# 32-bit PowerShell: MSScriptControl.ScriptControl is 32-bit only. %LOCALAPPDATA% must be -Root (the hook's folders).
# Each cycle (every PaceMs): pipe, file, exists, missing and a no-op call (the ScriptControl overhead), the order rotated.
param(
    [Parameter(Mandatory)] [string] $Lib,
    [Parameter(Mandatory)] [string] $Pipe,
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $Csv,
    [int] $Cycles = 9000,
    [int] $PaceMs = 20
)
$ErrorActionPreference = 'Stop'
if ([IntPtr]::Size -ne 4) { throw 'run this in 32-bit PowerShell (C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe)' }

# The held file beside the hook's journal folder, grown to 400 KB first (the spike's journal size).
$held = Join-Path $Root 'held.jsonl'
$sb = [Text.StringBuilder]::new()
$i = 0
while ($sb.Length -lt 400KB) { $i++; [void]$sb.Append('{"event":"nvram_delta","t":' + ($i * 0.05).ToString('0.000', [Globalization.CultureInfo]::InvariantCulture) + ',"n":1,"d":[[5794,' + ($i % 256) + ',' + (($i + 255) % 256) + ']]}' + "`r`n") }
[IO.File]::WriteAllText($held, $sb.ToString(), [Text.Encoding]::ASCII)
$lockDir = Join-Path $Root 'Castcade\lock'
New-Item -ItemType Directory -Force $lockDir | Out-Null
$existing = Join-Path $lockDir 'turn.lock'
[IO.File]::WriteAllText($existing, '')
$missing = Join-Path $lockDir 'missing.lock'

$sc = New-Object -ComObject MSScriptControl.ScriptControl
$sc.Language = 'VBScript'
$sc.AddCode([IO.File]::ReadAllText($Lib))
$q = { param($s) '"' + $s.Replace('"', '""') + '"' }
$sc.ExecuteStatement('Castcade_PipeName = ' + (& $q $Pipe))
$sc.AddCode(@"
Dim Bench_F, Bench_Existing, Bench_Missing
Sub Bench_Setup()
    Castcade_Init "journal pipe bench", "A", "0.3.2", ""
    Set Bench_F = Castcade_fso.OpenTextFile($(& $q $held), 8, False, 0)
    Bench_Existing = $(& $q $existing)
    Bench_Missing = $(& $q $missing)
End Sub
Function Bench_Ln(i)
    Bench_Ln = """i"":" & i & ",""n"":1,""d"":[[5794," & (i Mod 256) & "," & ((i + 255) Mod 256) & "]]"
End Function
Sub P(i)
    Castcade_Event "bench", Bench_Ln(i)
End Sub
Sub F(i)
    Bench_F.WriteLine "{""event"":""bench"",""t"":0," & Bench_Ln(i) & "}"
End Sub
Function E(i)
    E = Castcade_fso.FileExists(Bench_Existing)
End Function
Function M(i)
    M = Castcade_fso.FileExists(Bench_Missing)
End Function
Sub N(i)
    Dim s
    s = Bench_Ln(i)
End Sub
Function Bench_OnPipe()
    Bench_OnPipe = Castcade_OnPipe
End Function
Sub Bench_Done()
    Castcade_Exit
    Bench_F.Close
End Sub
"@)
$sc.Run('Bench_Setup')
if (-not $sc.Run('Bench_OnPipe')) { throw "the hook did not open $Pipe (is the worker listening?)" }

$freq = [Diagnostics.Stopwatch]::Frequency
$us = 1e6 / $freq
$calls = @('P', 'F', 'E', 'M', 'N')
$out = [Text.StringBuilder]::new()
[void]$out.AppendLine('idx,wall_ms,pipe_us,file_us,exists_us,missing_us,noop_us')
$next = [Diagnostics.Stopwatch]::GetTimestamp()
for ($k = 0; $k -lt $Cycles; $k++) {
    $next += $PaceMs * $freq / 1000
    while ([Diagnostics.Stopwatch]::GetTimestamp() -lt $next) { [Threading.Thread]::Sleep(1) }
    $wall = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $t = @{}
    for ($j = 0; $j -lt 5; $j++) {
        $c = $calls[($k + $j) % 5]
        $a = [Diagnostics.Stopwatch]::GetTimestamp()
        [void]$sc.Run($c, $k)
        $t[$c] = ([Diagnostics.Stopwatch]::GetTimestamp() - $a) * $us
    }
    [void]$out.AppendLine("$k,$wall,$([int]$t['P']),$([int]$t['F']),$([int]$t['E']),$([int]$t['M']),$([int]$t['N'])")
    # A stall does not make the loop burst to catch up.
    $now = [Diagnostics.Stopwatch]::GetTimestamp(); if ($now -gt $next) { $next = $now }
}
$onPipe = $sc.Run('Bench_OnPipe')
$sc.Run('Bench_Done')
[IO.File]::WriteAllText($Csv, $out.ToString())
"done cycles=$Cycles on_pipe_at_end=$onPipe"
