# D10.0.1 GStreamer candidate: dot-source this (`. .\env.ps1`) to point a shell at the portable runtime
# unpacked by unpack.ps1 under ../deps/gstreamer/1.0/msvc_x86_64 (no admin, nothing registered system-wide).
$gstRoot = Join-Path $PSScriptRoot '..\deps\gstreamer\1.0\msvc_x86_64' | Resolve-Path | Select-Object -ExpandProperty Path
$env:GSTREAMER_1_0_ROOT_MSVC_X86_64 = $gstRoot
$env:GST_PLUGIN_PATH = Join-Path $gstRoot 'lib\gstreamer-1.0'
$env:GST_PLUGIN_SYSTEM_PATH = $env:GST_PLUGIN_PATH
$env:GST_REGISTRY = Join-Path $PSScriptRoot '..\deps\gstreamer\registry.bin'
$env:PKG_CONFIG_PATH = Join-Path $gstRoot 'lib\pkgconfig'
$env:PKG_CONFIG = Join-Path $gstRoot 'bin\pkg-config.exe'
$env:PATH = (Join-Path $gstRoot 'bin') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
