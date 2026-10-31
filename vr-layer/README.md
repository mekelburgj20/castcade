# XrApiLayer_castcade_panel

The in-headset match panel for OpenXR rigs (WORK item D7.3; spec: `docs/design/alpha-match.md` §5). An implicit
OpenXR API layer: the OpenXR loader puts it between VPinballX and the OpenXR runtime, and it appends the panel to every
frame VPX submits as one head-locked quad. The companion side is `companion/src/media/vr-layer.ts`; it registers the
layer and feeds it frames over a named pipe.

Why a layer and not the SteamVR helper (`vr-overlay/`): on the owner's rig and Krobs', VPX
(`VPinballX_GL64.exe`, Panasony 10.8.0.2078) renders through OpenComposite (its `openvr_api64.dll` translates OpenVR to
OpenXR) onto Virtual Desktop's OpenXR runtime. No SteamVR runs there, so an OpenVR overlay has nowhere to draw. A layer
loads inside VPX's own process whatever the runtime (Virtual Desktop, Oculus / Meta, any other OpenXR runtime).

C++17, CMake ≥ 3.20, MSVC x64; the only dependency is the OpenXR headers (Apache-2.0, `THIRD-PARTY.md`), fetched by
CMake from a pinned KhronosGroup/OpenXR-SDK release tag and checked by sha256 (`CMakeLists.txt`).

## Build

```powershell
cmake -B build -A x64            # the newest Visual Studio generator; MSVC x64
cmake --build build --config Release
# → build/Release/XrApiLayer_castcade_panel.dll, XrApiLayer_castcade_panel.json, THIRD-PARTY.md
```

Static CRT (`/MT`), `/O2` with link-time code generation. CI (`.github/workflows/vr-layer.yml`) is the build of record:
it uploads the three files as the artifact `castcade-vr-layer-win-x64` on every change here, and on a `v*` tag attaches
`castcade-vr-layer-<tag>-win-x64.zip` to the GitHub release, where `npm run fetch-vr-layer -w companion` picks it up for
packaging (`--from vr-layer/build/Release` copies a local build instead). The release workflow builds it from the tag
itself for the installer.

## How the loader finds it

The manifest `XrApiLayer_castcade_panel.json` names the dll by a relative path (`./XrApiLayer_castcade_panel.dll`,
beside the json). The OpenXR loader reads implicit layer manifests from the registry:
`HKEY_LOCAL_MACHINE\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit` and
`HKEY_CURRENT_USER\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit`, one `REG_DWORD` value per layer whose **name** is the
json's absolute path and whose data is `0` (enabled).

The companion registers it for the current user when a match needs the panel on a non-SteamVR runtime (no admin
rights needed): `HKCU\...\ApiLayers\Implicit`, value `<install dir>\resources\vr-layer\XrApiLayer_castcade_panel.json`
= `0`. By hand:

```powershell
reg add "HKCU\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit" /v "C:\path\to\XrApiLayer_castcade_panel.json" /t REG_DWORD /d 0 /f
```

Things that stop it loading:

- **VPX started before the registration.** The loader reads the list when VPX creates its OpenXR instance (VR start), so
  the first match after installing needs VPX restarted. The companion says so (`restart_vpx`).
- **VPX run as administrator.** The loader ignores `HKEY_CURRENT_USER` (and environment variables) in an elevated
  process. Run VPX unelevated, or register the json under `HKEY_LOCAL_MACHINE` by hand.
- `XR_API_LAYER_PATH` set in VPX's environment: the loader then reads layers from that path only.
- OpenComposite carries its own copy of the Khronos loader (built from OpenXR-SDK sources); it reads the same registry
  keys, so the layer loads under it like under the standard `openxr_loader.dll`.

## Disable it

- For one run: set `XR_DISABLE_CASTCADE_PANEL=1` in VPX's environment (the manifest's `disable_environment`).
- For good: set the registry value to `1`, or delete it. In any process other than `VPinballX*.exe` the layer is a pure
  pass-through already: it forwards every call and draws nothing.

## Verify it loaded

`%LOCALAPPDATA%\Castcade\logs\vr-layer.log` (one `.1` backup at 1 MB). Each line has the local time and VPX's pid:

```
… [12345] XR_APILAYER_CASTCADE_panel 0.1.0 (OpenXR headers release-1.1.65) loaded in VPinballX_GL64.exe
… [12345] pipe: serving \\.\pipe\castcade-panel
… [12345] session created on 'Virtual Desktop' (max 16 layers): graphics binding OpenGL (Win32); the panel is drawn in this session
… [12345] pipe: the companion connected
… [12345] pipe: first frame 960x640
… [12345] session: swapchain 960x640, format 35907, 3 images
… [12345] session: the panel is up
```

No file, or no `loaded in` line after a VR start: the loader did not load the layer (see above). OpenComposite may first
create a short-lived session on its own D3D11 or Vulkan device before VPX's first OpenGL frame; a Vulkan one is logged as
"not supported, this session passes through", which is expected. `XR_LOADER_DEBUG=all` in VPX's environment makes the
loader itself print what it found.

## What it does

- Active only when the host exe is `VPinballX*.exe`. It never throws across the OpenXR API: a fault inside it (an
  exception, or with `/EHa` a structured exception) turns it off for the rest of the process; a failing OpenXR call of
  its own (space, swapchain) turns it off for that session. Each is logged once.
- Hooks `xrCreateSession` (the graphics binding: `XrGraphicsBindingD3D11KHR` or `XrGraphicsBindingOpenGLWin32KHR`; any
  other binding passes through, logged by name), `xrDestroySession`, `xrEndFrame` and `xrDestroyInstance`.
- **Frames:** a named pipe server, `\\.\pipe\castcade-panel`, byte mode, one client at a time, local clients only. The
  companion writes the SteamVR helper's stdin format (`vr-overlay/README.md`, "stdin: frames": 16-byte header `CVO1`,
  u32 width, height, byteLength, then BGRA top-down). A bad header drops the client; it reconnects. The newest frame
  wins. The dll pins itself in memory when the server starts, so the reader thread never outlives its code.
- The first frame creates a `VIEW` reference space and a swapchain at the frame's size (960x640 for the panel; a new
  size makes a new swapchain): sRGB RGBA8 or BGRA8 first (Chromium's pixels are sRGB), else the UNORM ones. Each new
  frame goes into the next image: D3D11 `UpdateSubresource` on the app's immediate context (R and B swapped for an RGBA
  format); OpenGL `glTexSubImage2D` as `GL_BGRA` with the rows flipped (a GL swapchain image's origin is its bottom-left),
  the app's context made current if it is not, the app's texture binding, unpack state and pixel-unpack buffer
  restored.
- `xrEndFrame` with a frame less than 5 s old and the app submitting at least one layer: the app's layers plus an
  `XrCompositionLayerQuad` (our VIEW space, the helper's default placement `0, -0.28, -0.9` m turned to face the eye,
  0.55 m wide, height by the frame's aspect, both eyes, blended by the source alpha as premultiplied). If the app is
  already at `XrSystemGraphicsProperties::maxLayerCount` the panel is left out (logged once). If the runtime refuses the
  frame with a layer or validation error, the app's own frame is submitted again without the panel and the panel goes
  off for that session.
- No frame for 5 s: the quad is left out; the next frame brings it back. The companion re-sends its last frame every
  2 s while the panel is still.

Not done (compared with the SteamVR helper): no `--anchor world`, no global alpha (the panel is as opaque as its
pixels), no placement flags; the placement is fixed in `src/layer.cpp`.
