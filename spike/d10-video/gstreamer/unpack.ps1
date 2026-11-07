# D10.0.1: fetch the official GStreamer 1.28.8 MSVC x86_64 installer and unpack it WITHOUT admin rights.
# The installer is Inno Setup 6.7 built by cerbero with PrivilegesRequiredOverridesAllowed=commandline and a
# portable mode (/portable=1: no uninstaller, no env var, no registry key); /TYPE=devel adds headers, .lib
# and pkg-config files. Result: ../deps/gstreamer/1.0/msvc_x86_64 (2.09 GB, gitignored). About 4 minutes.
$ErrorActionPreference = 'Stop'
$ver = '1.28.8'
$name = "gstreamer-1.0-msvc-x86_64-$ver.exe"
$base = "https://gstreamer.freedesktop.org/data/pkg/windows/$ver/msvc"
$deps = Join-Path $PSScriptRoot '..\deps'
$dl = Join-Path $deps 'dl'
$dest = Join-Path $deps 'gstreamer\1.0\msvc_x86_64'
New-Item -ItemType Directory -Force $dl, $dest | Out-Null
$exe = Join-Path $dl $name
if (-not (Test-Path $exe)) { curl.exe -sS -L -o $exe "$base/$name" }
$want = ((curl.exe -sS "$base/$name.sha256sum") -split '\s+')[0].ToLower()
$have = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
if ($want -ne $have) { throw "sha256 mismatch for $name : expected $want, got $have" }
"sha256 ok: $have"
$p = Start-Process -FilePath $exe -PassThru -Wait -ArgumentList @(
  '/CURRENTUSER', '/portable=1', '/TYPE=devel', "/DIR=$dest",
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', "/LOG=$dl\install.log")
if ($p.ExitCode -ne 0) { throw "installer exit code $($p.ExitCode); see $dl\install.log" }
"unpacked to $dest"
