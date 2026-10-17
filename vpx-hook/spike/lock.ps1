<#
.SYNOPSIS
  Phase 0c: drive the Castcade turn-lock flag by hand.

  The sidecar's <Table>_KeyDown wrapper swallows flipper / plunger / start / nudge keys while
  %LOCALAPPDATA%\Castcade\lock\turn.lock EXISTS.  The companion will write this file on every
  TURN_GRANT transition; for the spike you flip it from this script.

.EXAMPLE
  pwsh -File vpx-hook\spike\lock.ps1 status
  pwsh -File vpx-hook\spike\lock.ps1 on        # flippers should go dead in the running table
  pwsh -File vpx-hook\spike\lock.ps1 off
  pwsh -File vpx-hook\spike\lock.ps1 cycle -Seconds 10          # toggle every 10 s with a beep (hands-free / VR)
  pwsh -File vpx-hook\spike\lock.ps1 cycle -Seconds 8 -Count 6  # six toggles then stop unlocked
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'on', 'off', 'toggle', 'cycle')]
    [string]$Action = 'status',
    [int]$Seconds = 10,
    [int]$Count = 0
)

$dir  = Join-Path $env:LOCALAPPDATA 'Castcade\lock'
$lock = Join-Path $dir 'turn.lock'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

function Set-Lock([bool]$on) {
    if ($on) {
        if (-not (Test-Path $lock)) { Set-Content -Path $lock -Value (Get-Date -Format o) -NoNewline }
    } else {
        if (Test-Path $lock) { Remove-Item -Path $lock -Force }
    }
    $state = if (Test-Path $lock) { 'LOCKED  (not your turn: play keys swallowed)' } else { 'UNLOCKED (your turn)' }
    Write-Host ("{0:HH:mm:ss}  {1}" -f (Get-Date), $state)
    try { if ($on) { [console]::Beep(880, 150) } else { [console]::Beep(440, 150) } } catch { }
}

switch ($Action) {
    'status' {
        $state = if (Test-Path $lock) { 'LOCKED' } else { 'UNLOCKED' }
        Write-Host "$state  ($lock)"
    }
    'on'     { Set-Lock $true }
    'off'    { Set-Lock $false }
    'toggle' { Set-Lock (-not (Test-Path $lock)) }
    'cycle'  {
        Write-Host "Cycling the lock every $Seconds s. High beep = locked, low beep = unlocked. Ctrl+C to stop (leaves it unlocked)."
        $n = 0
        try {
            while ($true) {
                Set-Lock (-not (Test-Path $lock))
                $n++
                if ($Count -gt 0 -and $n -ge $Count) { break }
                Start-Sleep -Seconds $Seconds
            }
        } finally {
            Set-Lock $false
        }
    }
}
