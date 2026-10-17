# capture-test.ps1 -- Castcade Phase 0, item (d): VPX window capture + hardware encode cost.
#
# What it does
#   Captures the desktop monitor VPX is drawing on (or one window by title) at 720p30,
#   encodes it with h264_nvenc for N seconds, and samples ffmpeg / system / GPU / VPX CPU
#   once per second while it runs. Prints a results block, writes the same block as JSON.
#   Three attempts, in order; the first that succeeds is used:
#     1. ddagrab (Desktop Duplication) -> frames stay on the GPU -> scale_cuda -> h264_nvenc
#     2. ddagrab -> hwdownload to CPU -> scale -> h264_nvenc
#     3. gdigrab window/desktop -> scale -> h264_nvenc   (only with -WindowTitle, or if 1 and 2 fail)
#
# How to run (VPX running a table, FPS overlay on: F11 in 10.8.0 -- note the FPS first)
#   pwsh -File vpx-hook\spike\capture-test.ps1
#   pwsh -File vpx-hook\spike\capture-test.ps1 -Seconds 60 -Monitor 1
#   pwsh -File vpx-hook\spike\capture-test.ps1 -WindowTitle "Visual Pinball Player"
#
# Gate (gap analysis section 6, Phase 0): capture costs VPX less than 5% of its frame rate.
#   The VPX-side number is NOT measurable from here; read VPX's own FPS overlay before and
#   during the run and paste both into the result line this script prints.
#
# Requirements verified on the owner's rig 2026-10-17: ffmpeg 8.1.1 (gyan full build) with
#   ddagrab, gdigrab, h264_nvenc; NVIDIA RTX 3090 driver 616.56; nvidia-smi on PATH.
# Writes only inside -OutDir. Never deletes anything.

[CmdletBinding()]
param(
    [int]$Seconds = 30,
    [int]$Monitor = 0,
    [int]$Fps = 30,
    [int]$Width = 1280,
    [int]$Height = 720,
    [int]$BitrateMbps = 6,
    [string]$OutDir = 'C:\code\repos\castcade\tmp\spike\capture',
    [string]$WindowTitle = ''
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- preflight
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) { Write-Error 'ffmpeg not found on PATH.'; exit 2 }
$nvsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $OutDir ("capture-{0}.mp4" -f $stamp)
$jsonOut = Join-Path $OutDir ("capture-result-{0}.json" -f $stamp)
$cores   = [Environment]::ProcessorCount
$gop     = 2 * $Fps

$filtersText = & ffmpeg -hide_banner -filters 2>$null | Out-String
$encText     = & ffmpeg -hide_banner -encoders 2>$null | Out-String
$hasDdagrab  = $filtersText -match 'ddagrab'
$hasNvenc    = $encText -match 'h264_nvenc'
if (-not $hasNvenc) { Write-Error 'h264_nvenc not available in this ffmpeg build.'; exit 2 }

Write-Host ("Phase 0d capture test: {0}x{1}@{2} for {3}s, {4} Mbps, monitor {5}" -f $Width, $Height, $Fps, $Seconds, $BitrateMbps, $Monitor)
Write-Host ("ffmpeg: {0}" -f $ffmpeg.Source)
Write-Host ("output: {0}" -f $outFile)
$vpxNow = Get-Process -Name 'VPinballX*' -ErrorAction SilentlyContinue
if ($vpxNow) { Write-Host ("VPinballX running: pid {0} ({1})" -f $vpxNow[0].Id, $vpxNow[0].ProcessName) }
else { Write-Host 'WARNING: no VPinballX process running. Start a table first for a meaningful result.' }
Write-Host 'Read the VPX FPS overlay (F11) NOW and note it as "before".'
Write-Host ''

# ---------------------------------------------------------------- attempt definitions
$common = @('-y', '-hide_banner', '-loglevel', 'info', '-stats')
$encode = @('-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr',
            '-b:v', ("{0}M" -f $BitrateMbps), '-g', "$gop", '-t', "$Seconds")

$attempts = @()
if ($WindowTitle -eq '') {
    if ($hasDdagrab) {
        $attempts += [pscustomobject]@{
            Id = 1; Name = 'ddagrab GPU-resident -> scale_cuda -> h264_nvenc'
            Args = $common + @('-init_hw_device', 'd3d11va', '-filter_complex',
                ("ddagrab=output_idx={0}:framerate={1},hwmap=derive_device=cuda,scale_cuda={2}:{3}:format=nv12" -f $Monitor, $Fps, $Width, $Height)) + $encode + @($outFile)
        }
        $attempts += [pscustomobject]@{
            Id = 2; Name = 'ddagrab -> hwdownload (CPU copy) -> scale -> h264_nvenc'
            Args = $common + @('-init_hw_device', 'd3d11va', '-filter_complex',
                ("ddagrab=output_idx={0}:framerate={1},hwdownload,format=bgra,scale={2}:{3},format=nv12" -f $Monitor, $Fps, $Width, $Height)) + $encode + @($outFile)
        }
    } else {
        Write-Host 'ddagrab filter not present in this ffmpeg; skipping attempts 1 and 2.'
    }
    $attempts += [pscustomobject]@{
        Id = 3; Name = 'gdigrab desktop -> scale -> h264_nvenc'
        Args = $common + @('-f', 'gdigrab', '-framerate', "$Fps", '-i', 'desktop',
            '-vf', ("scale={0}:{1},format=nv12" -f $Width, $Height)) + $encode + @($outFile)
    }
} else {
    $attempts += [pscustomobject]@{
        Id = 3; Name = ("gdigrab window title='{0}' -> scale -> h264_nvenc" -f $WindowTitle)
        Args = $common + @('-f', 'gdigrab', '-framerate', "$Fps", '-i', ("title={0}" -f $WindowTitle),
            '-vf', ("scale={0}:{1},format=nv12" -f $Width, $Height)) + $encode + @($outFile)
    }
}

# ---------------------------------------------------------------- helpers
function Get-ProcCpuSeconds([System.Diagnostics.Process]$p) {
    try { $p.Refresh(); return $p.TotalProcessorTime.TotalSeconds } catch { return $null }
}

function Get-SystemCpu {
    try {
        $c = Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop
        return [double]$c.CounterSamples[0].CookedValue
    } catch { return $null }
}

function Get-GpuUtil {
    if (-not $nvsmi) { return $null }
    try {
        $line = & nvidia-smi --query-gpu=utilization.gpu,utilization.encoder --format=csv,noheader,nounits 2>$null | Select-Object -First 1
        if (-not $line) { return $null }
        $parts = ($line -split ',') | ForEach-Object { $_.Trim() }
        return [pscustomobject]@{ Gpu = [double]$parts[0]; Enc = [double]$parts[1] }
    } catch { return $null }
}

function Get-Avg([object[]]$vals) {
    $v = @($vals | Where-Object { $_ -ne $null })
    if ($v.Count -eq 0) { return $null }
    return [math]::Round((($v | Measure-Object -Average).Average), 1)
}
function Get-Max([object[]]$vals) {
    $v = @($vals | Where-Object { $_ -ne $null })
    if ($v.Count -eq 0) { return $null }
    return [math]::Round((($v | Measure-Object -Maximum).Maximum), 1)
}
function Fmt($v) { if ($v -eq $null) { return 'n/a' } else { return "$v" } }

# ---------------------------------------------------------------- run attempts
$success  = $null
$samples  = @()
$stderrTail = @()
$errFile  = $null

foreach ($a in $attempts) {
    Write-Host ("--- Attempt {0}: {1}" -f $a.Id, $a.Name)
    $errFile = Join-Path $OutDir ("capture-{0}-attempt{1}.stderr.txt" -f $stamp, $a.Id)
    $samples = @()

    $proc = Start-Process -FilePath $ffmpeg.Source -ArgumentList $a.Args -PassThru -NoNewWindow -RedirectStandardError $errFile

    $ffPrev  = Get-ProcCpuSeconds $proc
    $vpxProc = Get-Process -Name 'VPinballX*' -ErrorAction SilentlyContinue | Select-Object -First 1
    $vpxPrev = if ($vpxProc) { Get-ProcCpuSeconds $vpxProc } else { $null }
    $tPrev   = Get-Date

    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 1
        $tNow = Get-Date
        $dt = ($tNow - $tPrev).TotalSeconds
        if ($dt -le 0) { $dt = 1 }

        $ffNow = Get-ProcCpuSeconds $proc
        $ffCpu = $null
        if ($ffNow -ne $null -and $ffPrev -ne $null) { $ffCpu = [math]::Round((($ffNow - $ffPrev) / $dt / $cores) * 100, 1) }

        $vpxCpu = $null
        if ($vpxProc) {
            $vpxNowS = Get-ProcCpuSeconds $vpxProc
            if ($vpxNowS -ne $null -and $vpxPrev -ne $null) { $vpxCpu = [math]::Round((($vpxNowS - $vpxPrev) / $dt / $cores) * 100, 1) }
            $vpxPrev = $vpxNowS
        }

        $sys = Get-SystemCpu
        $gpu = Get-GpuUtil

        $s = [pscustomobject]@{
            T = [math]::Round(($tNow - $tPrev).TotalSeconds, 1)
            FfmpegCpu = $ffCpu; SystemCpu = $sys
            Gpu = $(if ($gpu) { $gpu.Gpu } else { $null })
            Enc = $(if ($gpu) { $gpu.Enc } else { $null })
            VpxCpu = $vpxCpu
        }
        $samples += $s
        Write-Host ("  ffmpeg cpu {0,5}%  sys {1,5}%  gpu {2,4}%  enc {3,4}%  vpx cpu {4,5}%" -f (Fmt $s.FfmpegCpu), (Fmt $s.SystemCpu), (Fmt $s.Gpu), (Fmt $s.Enc), (Fmt $s.VpxCpu))

        $ffPrev = $ffNow
        $tPrev  = $tNow
    }

    $proc.WaitForExit()
    $code = $proc.ExitCode
    $stderrTail = @()
    if (Test-Path -LiteralPath $errFile) { $stderrTail = @(Get-Content -LiteralPath $errFile -ErrorAction SilentlyContinue | Select-Object -Last 15) }

    if ($code -eq 0 -and (Test-Path -LiteralPath $outFile) -and ((Get-Item -LiteralPath $outFile).Length -gt 0)) {
        $success = $a
        Write-Host ("  attempt {0} succeeded." -f $a.Id)
        break
    }

    Write-Host ("  attempt {0} FAILED (exit {1}). Last stderr lines:" -f $a.Id, $code)
    $stderrTail | ForEach-Object { Write-Host ("    " + $_) }
    Write-Host ''
}

# ---------------------------------------------------------------- results
$expected = $Fps * $Seconds
$frames = $null; $encFps = $null; $speed = $null
if ($success) {
    $errText = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)
    if ($errText) {
        # ffmpeg -stats emits progress lines separated by CR; take the last frame= occurrence.
        $m = [regex]::Matches($errText, 'frame=\s*(\d+)\s+fps=\s*([\d.]+).*?speed=\s*([\d.]+)x')
        if ($m.Count -gt 0) {
            $last = $m[$m.Count - 1]
            $frames = [int]$last.Groups[1].Value
            $encFps = [double]$last.Groups[2].Value
            $speed  = [double]$last.Groups[3].Value
        }
    }
}
$dropped = if ($frames -ne $null) { [math]::Max(0, $expected - $frames) } else { $null }
$sizeMB  = if ($success -and (Test-Path -LiteralPath $outFile)) { [math]::Round((Get-Item -LiteralPath $outFile).Length / 1MB, 2) } else { $null }

$result = [ordered]@{
    timestamp       = (Get-Date).ToString('o')
    phase           = '0d'
    attempt         = $(if ($success) { $success.Id } else { $null })
    attempt_name    = $(if ($success) { $success.Name } else { 'ALL ATTEMPTS FAILED' })
    output_file     = $(if ($success) { $outFile } else { $null })
    output_mb       = $sizeMB
    seconds         = $Seconds
    fps_target      = $Fps
    resolution      = ("{0}x{1}" -f $Width, $Height)
    bitrate_mbps    = $BitrateMbps
    frames_encoded  = $frames
    frames_expected = $expected
    frames_dropped_est = $dropped
    encode_fps      = $encFps
    encode_speed_x  = $speed
    ffmpeg_cpu_avg  = Get-Avg ($samples | ForEach-Object { $_.FfmpegCpu })
    ffmpeg_cpu_max  = Get-Max ($samples | ForEach-Object { $_.FfmpegCpu })
    system_cpu_avg  = Get-Avg ($samples | ForEach-Object { $_.SystemCpu })
    gpu_util_avg    = Get-Avg ($samples | ForEach-Object { $_.Gpu })
    encoder_util_avg = Get-Avg ($samples | ForEach-Object { $_.Enc })
    vpx_cpu_avg     = Get-Avg ($samples | ForEach-Object { $_.VpxCpu })
    vpx_fps_before  = $null
    vpx_fps_during  = $null
    samples         = $samples
    stderr_tail     = $stderrTail
}

Write-Host ''
Write-Host '=============================== RESULTS ==============================='
Write-Host ("attempt:          {0} ({1})" -f (Fmt $result.attempt), $result.attempt_name)
Write-Host ("output:           {0} ({1} MB)" -f (Fmt $result.output_file), (Fmt $sizeMB))
Write-Host ("frames:           {0} / {1} expected  (dropped est. {2})" -f (Fmt $frames), $expected, (Fmt $dropped))
Write-Host ("encode:           {0} fps, speed {1}x" -f (Fmt $encFps), (Fmt $speed))
Write-Host ("ffmpeg cpu:       avg {0}%  max {1}%  (of all {2} logical cores)" -f (Fmt $result.ffmpeg_cpu_avg), (Fmt $result.ffmpeg_cpu_max), $cores)
Write-Host ("system cpu:       avg {0}%" -f (Fmt $result.system_cpu_avg))
Write-Host ("gpu / encoder:    avg {0}% / {1}%" -f (Fmt $result.gpu_util_avg), (Fmt $result.encoder_util_avg))
Write-Host ("vpx cpu:          avg {0}%" -f (Fmt $result.vpx_cpu_avg))
Write-Host ''
Write-Host 'The gate is VPX frame cost, which only VPX can report. Read the F11 FPS overlay'
Write-Host 'before and during the capture; the test passes if "during" is within 5% of "before"'
Write-Host 'and frames encoded is within 2% of expected.'
Write-Host ''
Write-Host 'Paste into docs/phase-0-spike.md:'
Write-Host ("0d | attempt={0} | frames={1}/{2} | ffmpeg cpu={3}% | enc={4}% | vpx fps before=__ during=__ | PASS/FAIL" -f (Fmt $result.attempt), (Fmt $frames), $expected, (Fmt $result.ffmpeg_cpu_avg), (Fmt $result.encoder_util_avg))

$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonOut -Encoding UTF8
Write-Host ("json: {0}" -f $jsonOut)

if (-not $success) { exit 1 }
exit 0
