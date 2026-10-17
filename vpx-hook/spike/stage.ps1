<#
.SYNOPSIS
  Phase 0 staging: copy the spike tables, extract their scripts, render Castcade sidecars,
  install castcade.vbs, create the journal/lock folders.  Re-runnable.

  Touches in the live VPX install: exactly ONE new file, <VpxRoot>\scripts\castcade.vbs
  (skip with -SkipLib).  Tables, core.vbs, nvram and user folders are never modified; the
  spike plays COPIES staged under castcade\tmp\spike\tables (gitignored).

.EXAMPLE
  pwsh -File vpx-hook\spike\stage.ps1
  pwsh -File vpx-hook\spike\stage.ps1 -Tables 'Attack from Mars LE (Midway 1995) v600'
  pwsh -File vpx-hook\spike\stage.ps1 -Force          # re-copy the .vpx files too
#>
param(
    [string]$VpxRoot  = 'C:\Users\mekel\Documents\Emulators\VPX\VisualPinballX',
    [string]$VpxTool  = 'C:\code\repos\ArcAid\tmp\vpx-desktop-witness\vpxtool\vpxtool.exe',
    [string]$StageDir = '',
    [string[]]$Tables = @(
        'Tales from the Crypt (Data East 1993) VPW v1.22',
        'Medieval Madness (Williams 1997) VPW v1.0.1',
        'Iron Maiden (Original 2022) VPW 1.0.12'
    ),
    [switch]$SkipLib,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $StageDir) { $StageDir = Join-Path $repo 'tmp\spike\tables' }
$render = Join-Path $PSScriptRoot 'render-sidecar.py'
$lib    = Join-Path $repo 'vpx-hook\castcade.vbs'

# per-table renderer arguments (what the Phase 3 analyzer will derive on its own)
$extraArgs = @{
    'Iron Maiden (Original 2022) VPW 1.0.12' = @('--extra-keys', 'KeyUpperLeft,KeyUpperRight')
}

function Say($msg) { Write-Host $msg }
function Need($path, $what) { if (-not (Test-Path $path)) { throw "$what not found: $path" } }

Need $VpxTool 'vpxtool.exe'
Need (Join-Path $VpxRoot 'scripts\core.vbs') 'VPX scripts\core.vbs'
Need $render 'render-sidecar.py'
Need $lib 'vpx-hook\castcade.vbs'
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { throw 'python not on PATH' }

foreach ($d in @($StageDir, (Join-Path $StageDir '_extracted'), (Join-Path $StageDir '_reports'),
                 (Join-Path $env:LOCALAPPDATA 'Castcade\journal'), (Join-Path $env:LOCALAPPDATA 'Castcade\lock'))) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ---- 1. library ------------------------------------------------------------------------
$libDst = Join-Path $VpxRoot 'scripts\castcade.vbs'
if ($SkipLib) {
    Say "lib: skipped (-SkipLib). The sidecars will run with no-op stubs unless $libDst exists."
} else {
    $srcHash = (Get-FileHash $lib -Algorithm SHA256).Hash
    if (Test-Path $libDst) {
        $dstHash = (Get-FileHash $libDst -Algorithm SHA256).Hash
        if ($dstHash -eq $srcHash) {
            Say "lib: $libDst already current ($($srcHash.Substring(0,12)))"
        } else {
            $bak = "$libDst.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
            Copy-Item $libDst $bak
            Copy-Item $lib $libDst -Force
            Say "lib: updated $libDst (previous copy kept as $(Split-Path $bak -Leaf))"
        }
    } else {
        Copy-Item $lib $libDst
        Say "lib: installed $libDst (new file; delete it to revert)"
    }
}

# ---- 2. tables ---------------------------------------------------------------------------
$rows = @()
foreach ($name in $Tables) {
    Say ""
    Say "== $name"
    $src = Join-Path $VpxRoot "tables\$name.vpx"
    Need $src 'table'
    $dst = Join-Path $StageDir "$name.vpx"
    if ($Force -or -not (Test-Path $dst)) {
        Say "   copying .vpx ($([math]::Round((Get-Item $src).Length / 1MB)) MB)"
        Copy-Item $src $dst -Force
    } else { Say "   .vpx already staged" }
    foreach ($ext in @('.directb2s', '.ini', '.pov', '.res', '.txt')) {
        $side = Join-Path $VpxRoot "tables\$name$ext"
        if (Test-Path $side) {
            $sideDst = Join-Path $StageDir "$name$ext"
            if ($Force -or -not (Test-Path $sideDst)) { Copy-Item $side $sideDst -Force; Say "   copied companion $ext" }
        }
    }

    $extracted = Join-Path $StageDir "_extracted\$name.vbs"
    & $VpxTool extractvbs -f $dst $extracted | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $extracted)) { throw "vpxtool extractvbs failed for $name" }
    Say "   extracted script -> _extracted\$name.vbs ($((Get-Content $extracted | Measure-Object -Line).Lines) lines)"

    $sidecar = Join-Path $StageDir "$name.vbs"
    $report  = Join-Path $StageDir "_reports\$name.json"
    $args = @($render, $extracted, $sidecar, '--report', $report)
    if ($extraArgs.ContainsKey($name)) { $args += $extraArgs[$name] }
    $out = & python -I @args 2>&1
    if ($LASTEXITCODE -ne 0) { Say ($out -join "`n"); throw "render-sidecar.py failed for $name (exit $LASTEXITCODE)" }
    $r = Get-Content $report -Raw | ConvertFrom-Json
    Say "   sidecar -> $name.vbs   class=$($r.class) recipe=$($r.recipe) status=$($r.status) rom=$($r.facts.rom)"
    foreach ($w in $r.warnings) { Say "   ! $w" }

    $rows += [pscustomobject]@{
        table          = $name
        class          = $r.class
        recipe         = $r.recipe
        rom            = $r.facts.rom
        status         = $r.status
        vpx_sha256     = (Get-FileHash $dst -Algorithm SHA256).Hash
        script_sha256  = $r.script_sha256
        sidecar_sha256 = $r.sidecar_sha256
        sidecar        = $sidecar
        staged_vpx     = $dst
    }
}

$manifest = Join-Path $StageDir 'manifest.json'
@{ staged_at = (Get-Date -Format o); lib_sha256 = (Get-FileHash $lib -Algorithm SHA256).Hash; tables = $rows } |
    ConvertTo-Json -Depth 4 | Set-Content -Path $manifest -Encoding utf8

Say ""
Say "== staged ($manifest)"
$rows | Format-Table table, class, recipe, rom, status -AutoSize | Out-String | Write-Host
Say "Next: python vpx-hook\spike\tail-journal.py '<table name>' --follow   then open the staged .vpx in VPX:"
foreach ($r in $rows) { Say "   `"$VpxRoot\VPinballX64.exe`" -Play `"$($r.staged_vpx)`"" }
Say ""
Say "Revert: delete the .vbs sidecars in $StageDir (the .vpx copies are untouched), delete $libDst, delete $env:LOCALAPPDATA\Castcade."
