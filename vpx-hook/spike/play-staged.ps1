<#
.SYNOPSIS
  Phase 0: launch one STAGED table (the copy with the Castcade sidecar) in the chosen VPX build,
  with the journal tailer following in its own window. Absolute paths throughout, so it works from
  any current directory and cannot open the unpatched table in the real tables\ folder by mistake.

.EXAMPLE
  pwsh -File C:\code\repos\castcade\vpx-hook\spike\play-staged.ps1 MM            # VR / OpenGL build (default)
  pwsh -File C:\code\repos\castcade\vpx-hook\spike\play-staged.ps1 TFTC -Exe DX64 # desktop build
  pwsh -File C:\code\repos\castcade\vpx-hook\spike\play-staged.ps1 IM -DryRun     # print what would run
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('MM', 'TFTC', 'IM')]
    [string]$Table = 'MM',
    [ValidateSet('GL64', 'GL', 'DX64')]
    [string]$Exe = 'GL64',
    [string]$VpxDir = 'C:\Users\mekel\Documents\Emulators\VPX\VisualPinballX',
    [switch]$NoTailer,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$names = @{
    MM   = 'Medieval Madness (Williams 1997) VPW v1.0.1'
    TFTC = 'Tales from the Crypt (Data East 1993) VPW v1.22'
    IM   = 'Iron Maiden (Original 2022) VPW 1.0.12'
}
$exes = @{ GL64 = 'VPinballX_GL64.exe'; GL = 'VPinballX_GL.exe'; DX64 = 'VPinballX64.exe' }

$id      = $names[$Table]
$vpx     = Join-Path $repo "tmp\spike\tables\$id.vpx"
$sidecar = Join-Path $repo "tmp\spike\tables\$id.vbs"
$exePath = Join-Path $VpxDir $exes[$Exe]
$lib     = Join-Path $VpxDir 'scripts\castcade.vbs'
$journal = Join-Path $env:LOCALAPPDATA ("Castcade\journal\" + (($id -replace '[()]', '') -replace ' ', '_') + '.jsonl')
$tailer  = Join-Path $repo 'vpx-hook\spike\tail-journal.py'

foreach ($p in @($vpx, $sidecar, $exePath, $lib, $tailer)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "missing: $p  (run stage.ps1 first?)" }
}

Write-Host "table   : $vpx"
Write-Host "sidecar : $sidecar"
Write-Host "exe     : $exePath"
Write-Host "journal : $journal"
if (Test-Path -LiteralPath $journal) {
    Write-Host "note    : journal already exists, this session will be appended; the tailer reports it with --last afterwards"
}

$tailCmd = "while (-not (Test-Path -LiteralPath '$journal')) { Start-Sleep -Seconds 1 }; " +
           "python '$tailer' '$journal' --follow --quiet-scores"

if ($DryRun) {
    Write-Host "would start tailer window: pwsh -NoExit -Command `"$tailCmd`""
    Write-Host "would run: `"$exePath`" -Play `"$vpx`""
    return
}

if (-not $NoTailer) {
    Start-Process pwsh -ArgumentList @('-NoExit', '-Command', $tailCmd) -WorkingDirectory $repo | Out-Null
    Write-Host "tailer window started (waits for the journal, then follows it)"
}

Write-Host "launching VPX ... quit the table with your exit key when done"
$p = Start-Process -FilePath $exePath -ArgumentList @('-Play', "`"$vpx`"") -WorkingDirectory $VpxDir -PassThru
$p.WaitForExit()
Write-Host ("VPX exited (code {0}). Summary of this session:" -f $p.ExitCode)
Write-Host "  python `"$tailer`" `"$journal`" --last --quiet-scores"
