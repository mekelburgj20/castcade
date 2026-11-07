# D10.1: fetch the pinned LiveKit libwebrtc prebuilt (Windows x64, release) into video-helper/deps/webrtc/.
# The zip is an untrusted download: it is extracted into its own folder and nothing in it is executed
# (headers + a static lib + two ninja files + args.gn + LICENSE.md). Idempotent; re-run to verify.
# Same tag and sha256 as the D10.0.1 spike (spike/d10-video/libwebrtc/NOTES.md says what the asset is).
#
#   pwsh video-helper/fetch-webrtc.ps1
#
$ErrorActionPreference = 'Stop'
$Tag = 'webrtc-a545de4'   # livekit/rust-sdks release; the libwebrtc crate 0.4.0 / webrtc-sys-build 0.3.21 pin this tag
$Asset = 'webrtc-win-x64-release.zip'
$Sha256 = '862403fcb248c7d8803487e4c22b8821c6130e89100cb9c69be95ef45ff46146'
$Url = "https://github.com/livekit/rust-sdks/releases/download/$Tag/$Asset"

$Deps = Join-Path $PSScriptRoot 'deps\webrtc'
New-Item -ItemType Directory -Force $Deps | Out-Null
$Zip = Join-Path $Deps $Asset
$Dir = Join-Path $Deps 'webrtc-win-x64-release'

if (-not (Test-Path $Zip) -or (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower() -ne $Sha256) {
  Write-Host "downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
}
$hash = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $Sha256) { throw "sha256 mismatch for ${Asset}: $hash (expected $Sha256)" }
Write-Host "sha256 ok: $hash"

if (-not (Test-Path (Join-Path $Dir 'win-x64-release\lib\webrtc.lib'))) {
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
  New-Item -ItemType Directory -Force $Dir | Out-Null
  Write-Host "extracting into $Dir"
  & "$env:SystemRoot\system32\tar.exe" -xf $Zip -C $Dir
}
$lib = Get-Item (Join-Path $Dir 'win-x64-release\lib\webrtc.lib')
Write-Host ("ready: {0} ({1:N0} bytes)" -f $lib.FullName, $lib.Length)
