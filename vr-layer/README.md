# XrApiLayer_castcade_panel

The match in the headset for OpenXR rigs (WORK items D7.3, D7.4; spec: `docs/design/alpha-match.md` §5). An implicit
OpenXR API layer: the OpenXR loader puts it between VPinballX and the OpenXR runtime, and it changes the frames VPX
submits by the mode the companion asks for: **hidden** (VPX's frame untouched: the player's own turn), **panel** (the
match panel as a head-locked quad, low in the view) or **theater** (VPX's own world removed; the opponent's video fixed
in the room: a life-size stereo window onto the sender's view when the sender's VR preview shows both eyes, else a large
screen). The companion side is
`companion/src/media/vr-layer.ts`; it registers the layer and feeds it over a named pipe.

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

Both workflows pass `-DCASTCADE_BUILD_ID=<tag>` on tag pushes, else `-DCASTCADE_BUILD_ID=<short sha>` (D7.3.3); a local
build says `dev`. The id is on the layer's `loaded in` log line, so the log names the exact dll VPX loaded.

## How the loader finds it

The manifest `XrApiLayer_castcade_panel.json` names the dll by a relative path (`./XrApiLayer_castcade_panel.dll`,
beside the json). The OpenXR loader reads implicit layer manifests from the registry:
`HKEY_LOCAL_MACHINE\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit` and
`HKEY_CURRENT_USER\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit`, one `REG_DWORD` value per layer whose **name** is the
json's absolute path and whose data is `0` (enabled).

The companion registers it for the current user (no admin rights needed) at start and again when a match needs the
panel on a non-SteamVR runtime: `HKCU\...\ApiLayers\Implicit`, value
`%LOCALAPPDATA%\Castcade\vr-layer\<companion version>\XrApiLayer_castcade_panel.json` = `0`. Since D7.3.3 (the release after 0.2.29) the
installed app copies the layer there from `<install dir>\resources\vr-layer\` at start (only when that folder lacks it
or its dll's sha256 differs) and registers the copy, never the install folder: VPX maps the dll while it runs, and an
update that lands then cannot replace a mapped dll (0.2.28 → 0.2.29 kept the old one). Older `<version>` folders are
removed at start; one a running VPX still holds is left and removed at a later start. A dev run registers the local
build (`vr-layer/build/Release/`) or `companion/resources/vr-layer/` directly. `companion.log` says what was registered:
`vr-layer: registered for Castcade <version>: <json> (dll sha256 <first 12 hex>, VERSION <first line>)`. By hand:

```powershell
reg add "HKCU\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit" /v "C:\path\to\XrApiLayer_castcade_panel.json" /t REG_DWORD /d 0 /f
```

Things that stop it loading:

- **VPX started before the registration.** The loader reads the list when VPX creates its OpenXR instance (VR start), so
  the first match after installing (and the first after an update) needs VPX restarted. The companion says so: `restart_vpx`
  when nothing answers on the pipe, and `VPX started before this layer was registered: restart VPX for the latest
  theater` (Match tab and `companion.log`) when the VPX running started before the registration changed.
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
… [12345] XR_APILAYER_CASTCADE_panel 0.3.0 build v0.2.30 (OpenXR headers release-1.1.65) loaded in VPinballX_GL64.exe
… [12345] pipe: serving \\.\pipe\castcade-panel
… [12345] session created on 'Virtual Desktop' (max 16 layers): graphics binding OpenGL (Win32); the panel and theater are drawn in this session
… [12345] pipe: the companion connected (protocol 2)
… [12345] pipe: first panel frame 960x640
… [12345] session: panel swapchain 960x640, format 35907, 3 images
… [12345] session: the panel is up
… [12345] mode: hidden -> panel
… [12345] pipe: mode theater, stereo sbs, panel low
… [12345] mode: panel -> theater (through black)
… [12345] theater: the screen is placed 2.6 m ahead, yaw -12 degrees in LOCAL space
… [12345] theater: stereo window, scale 1.00 (life size), 2.60 m ahead, video eye 426x720, eyes from xrLocateViews, IPD 63.0 mm; left eye: fov left -52.0 right +44.0 down -52.0 up +44.0 deg (VPX's frame), eye at x -0.0315 y +0.0000 z +0.0000 m, render 2064x2208, crop 1306x2208 at 379,0, quad 3.70 x 5.84 m centred -0.41, -0.41 m off the eye's axis; right eye: …
```

`build` (D7.3.3) is the release tag (or the commit's short sha for a branch build, `dev` for a local one): a VPX that
kept an older dll shows an older build here. A line without `build` (version 0.2.0) is a layer from 0.2.29 or older.

The `stereo window` line (D7.4.5) comes with the first side-by-side frame of each theater and again whenever its
inputs change (the video's size, VPX's fov, the scale; at most 20 per session). Per eye: the fov the window uses and
where it came from (`VPX's frame` = the fov VPX rendered with, preferred; `xrLocateViews`; `assumed` = ±45°, logged
once), the eye's place in the head, VPX's eye render and the part of it the sender's preview shows (`crop`, in render
pixels), and the quad that shows it. The quads should be several metres wide and pushed outward (left eye negative x,
right eye positive): the picture fills about the view, as the sender saw it. A `fov in VPX's frame … differs from
xrLocateViews'` line is informational.

No file, or no `loaded in` line after a VR start: the loader did not load the layer (see above). OpenComposite may first
create a short-lived session on its own D3D11 or Vulkan device before VPX's first OpenGL frame; a Vulkan one is logged as
"not supported, this session passes through", which is expected. `XR_LOADER_DEBUG=all` in VPX's environment makes the
loader itself print what it found.

## The pipe (protocol 2, D7.4)

`\\.\pipe\castcade-panel`, byte mode, one client at a time, local clients only. Little-endian throughout.

| Direction | Magic | Then | Meaning |
|---|---|---|---|
| layer → companion, once on connect | `CVH1` | u32 protocol (2) | hello; a protocol-1 layer (0.2.26) sends none |
| companion → layer | `CVO1` | u32 width, height, byteLength (= w·h·4), BGRA top-down | a panel frame: the panel page's paint (960x640), the SteamVR helper's stdin format |
| companion → layer | `CVO2` | same header, **RGBA** top-down | a video frame: the opponent's feed (at most 1920x1080; side by side at most 3840x1080) |
| companion → layer | `CVC1` | u32 byteLength (≤ 64 KiB), UTF-8 JSON | the control: `{"mode": "hidden"\|"panel"\|"theater", "stereo": "mono"\|"sbs", "panelPos": "low"\|"center"}`, optionally `"theaterScale": <number>` (D7.4.5; 0.25–4, default 1; no companion sends it yet) |
| companion → layer | anything else | u32 byteLength, payload | skipped, logged once (every message after protocol 2 is shaped so) |

Video frames are RGBA because the companion reads them with canvas `getImageData`: no byte swap in JavaScript, and on
OpenGL (the owner's rig) and a D3D11 `R8G8B8A8` swapchain none in the layer either.

Compatibility: a protocol-1 layer drops the client on any magic but `CVO1`, so the companion sends `CVC1` and `CVO2`
only after a hello of 2 or more; without one it sends panel frames only, as 0.2.26 did. A protocol-1 companion never
reads the hello (8 bytes sit in its socket) and gets the default control: panel mode, placed low. The control goes
back to that default when the companion disconnects.

## What it does

- Active only when the host exe is `VPinballX*.exe`. It never throws across the OpenXR API: a fault inside it (an
  exception, or with `/EHa` a structured exception) turns it off for the rest of the process; a failing OpenXR call of
  its own (space, swapchain) turns it off for that session. Each is logged once.
- Hooks `xrCreateSession` (the graphics binding: `XrGraphicsBindingD3D11KHR` or `XrGraphicsBindingOpenGLWin32KHR`; any
  other binding passes through, logged by name), `xrDestroySession`, `xrEndFrame` and `xrDestroyInstance`.
- Everything of the layer's own (two reference spaces, three swapchains, the mode on screen, the fade, the theater
  screen's place) belongs to one session. OpenComposite creates a short D3D11 session before VPX's OpenGL one (the
  owner's log, 0.2.26); each gets its own.
- **Swapchains**, made at the first frame of each kind and again at a new size: `panel` (BGRA data), `video` (RGBA
  data), `shade` (8x8, black with the fade's alpha). sRGB first (Chromium's pixels are sRGB), else UNORM; on D3D11 the
  format of the data's byte order first, so the upload copies without a swap. D3D11 `UpdateSubresource` on the app's
  immediate context; OpenGL `glTexSubImage2D` as `GL_BGRA` / `GL_RGBA` with the rows flipped (a GL swapchain image's
  origin is its bottom-left), the app's context made current if it is not, the app's texture binding, unpack state and
  pixel-unpack buffer restored. A video frame is uploaded only in theater mode.
- **Modes**, each `xrEndFrame` with at least one app layer (a frame without layers passes untouched):
  - *hidden*: the app's frame as it is.
  - *panel*: the app's layers plus a quad in `VIEW` space, 0.40 m wide at `0, -0.42, -0.9` m turned to face the eye
    (below the playfield's line of sight: the D7.3 placement covered it); `panelPos: center` is the D7.3 placement,
    0.55 m at `0, -0.28, -0.9`. Blended by the source alpha as premultiplied.
  - *theater*: the app's `XrCompositionLayerProjection` layers removed (OpenComposite submits VPX's two eyes as one;
    any other layer type the app submits stays), then a head-locked opaque black quad (30 m at 3 m) and the picture,
    in `LOCAL` space, so it stays put when the head turns. It is placed when theater begins: in front of where the head
    points then (its yaw only, upright, at eye height; `xrLocateSpace` of `VIEW` in `LOCAL` at the frame's display
    time).
    - `stereo: sbs`, the **stereo window** (D7.4.5, 2026-11-02): the video frame's left | right halves are the
      sender's two eyes, and each goes to its eye (one swapchain, `imageRect` halves, `eyeVisibility` LEFT / RIGHT) on
      its own quad, placed so that every pixel is seen in the direction the sender's eye rendered it. VPX's "both eyes"
      preview fills each half with a centre crop of that eye's whole render (cut to the half's aspect), and an eye
      render covers an asymmetric frustum, so the layer takes each eye's fov and render size from VPX's projection
      layer (every frame), each eye's place in the head from `xrLocateViews` (at the recentre), works out VPX's crop
      in tangent space and puts each quad 2.6 m ahead of its eye, offset and sized by that crop's tangents. The
      picture is life size: the sender's playfield fuses where it stood for the sender, where the player's own was. It
      assumes the sender's headset has the receiver's fov (the same model on both ends makes it exact). A `theaterScale`
      in the control scales its angles (0.25–4, default 1; not sent by the companion yet). The derivation is in
      `src/layer.cpp` above `placeWindows`. Until D7.4.4 both halves sat at one pose as a 2.4 m screen: it did not fuse
      (the far edges doubled; "you see them as separate views").
    - Mono (a mono sender, or no live video frame while the panel is live: the panel frame instead of black): one quad
      for both eyes, 2.6 m ahead, whose longer side is 2.4 m (D7.4.3, 2026-11-01: 2.4 m wide for a landscape picture,
      2.4 m tall for a portrait one, the other side from its aspect).
- **Fade**: into or out of theater the view dips to black: a head-locked shade quad over everything, its alpha 0 → 1
  in 150 ms, the mode switched at the dark middle, 1 → 0 in 150 ms (the alpha uploaded in 1/64 steps). Hidden ↔ panel
  keep VPX's world and switch at once. `XR_KHR_composition_layer_color_scale_bias` would fade layers directly, but only
  an app that enabled it at `xrCreateInstance` may use it, and VPX / OpenComposite do not.
- **Safety net**: theater needs a live video or panel frame, panel a live panel frame; with no frame of either kind
  for 5 s the mode is hidden, whatever the companion asked (a crashed companion never leaves a player in the dark).
  The companion re-sends its last frame of each kind every 2 s while the picture is still.
- If the app's layers plus ours exceed `XrSystemGraphicsProperties::maxLayerCount` (16 on the Quest 3) the app's frame
  goes as it is (logged once). If the runtime refuses a frame with our layers with a layer or validation error, the
  app's own frame is submitted again without them and the layer goes off for that session.

Not done (compared with the SteamVR helper): no `--anchor world` for the panel, no global alpha (the panel is as opaque
as its pixels), no placement flags beyond `panelPos`; the placements are fixed in `src/layer.cpp`.
