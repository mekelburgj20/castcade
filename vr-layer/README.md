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
… [12345] theater: the screen is placed 2.6 m ahead, yaw -12 degrees, pitch -30 degrees in LOCAL space
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

## The pipe (protocol 3, D7.5; protocol 2, D7.4)

`\\.\pipe\castcade-panel`, byte mode, one client at a time, local clients only. Little-endian throughout. The pipe is
overlapped on the layer's side since D7.5 (the camera's worker writes while the reader thread waits for the companion;
on a synchronous handle Windows would queue the write behind the read).

| Direction | Magic | Then | Meaning |
|---|---|---|---|
| layer → companion, once on connect | `CVH1` | u32 protocol (3) | hello; a protocol-1 layer (0.2.26) sends none |
| layer → companion (protocol 3) | `CVF1` | u32 byteLength, then u16 jsonLength, the UTF-8 JSON header, the eyes' JPEG payloads back to back | a camera frame ("The camera" below) |
| layer → companion (protocol 3) | `CVS1` | u32 byteLength, UTF-8 JSON | the camera's state: `{"camera": "on"\|"off"\|"refused", "why": "<text>"}`, on `on` also `"api"`, `"source": [w, h]` (the eye render), `"size": [w, h]` (per eye, as sent), `"fps"`, `"whole"` (layer 0.5.2: true when the whole render is sent); or (D7.6.2, layer 0.5.0) `{"kind": "session", ...}`: the session report ("The session report" below) |
| companion → layer | `CVO1` | u32 width, height, byteLength (= w·h·4), BGRA top-down | a panel frame: the panel page's paint (960x640), the SteamVR helper's stdin format |
| companion → layer | `CVO2` | same header, **RGBA** top-down | a video frame: the opponent's feed (at most 1920x1080; side by side at most 3840x1080) |
| companion → layer | `CVC1` | u32 byteLength (≤ 64 KiB), UTF-8 JSON | the control: `{"mode": "hidden"\|"panel"\|"theater", "stereo": "mono"\|"sbs", "panelPos": "low"\|"center"}`, optionally `"theaterScale": <number>` (D7.4.5; 0.25–4, default 1) and, protocol 3, `"camera": {"width": w, "height": h, "fps": f}` or `"camera": null` (D7.5: each eye in a w x h box at f fps, or no camera; a control without the key leaves it as it was) and `"report": true` (D7.6.2: send the session report now; a request, not a state, so the companion puts it on one control only), `"test": "pattern"` (D7.6.1: the calibration pattern; the companion sends its whole control every time, so a control without the key turns it off), `"eyes": [{"fov": [l, r, u, d], "rect": [x, y, w, h], "render": [w, h]}, …]` (D7.5.2, layer 0.5.1: the sender's two eyes, left then right, as its camera frames' headers carry them: fov in radians with OpenXR's signs, the crop taken inside the render with y from the top; the stereo window is then placed from the sender's crop in the sender's fov; absent or null = not known, and VPX's centre-crop rule places it). Layer 0.5.2, the window's frame (all optional; absent = as before): `"camera": {…, "whole": true}` (D7.5.10: each eye's whole render scaled into the box, no crop; the frame header's `rect` is then `[0, 0, render w, render h]`), `"tune": {"depthM": <m> \| null, "dyDeg": [left, right]}` (D7.5.9 / D7.6.10: the distance the stereo window's frame is placed at, 0.3–100 m, null or 0 = infinity as before; and a vertical offset per eye in degrees, ±10, that moves that eye's quad up or down; the calibration pattern follows both) and `"feather": <0–0.25>` (D7.5.11: the fraction of one eye's half width over which the side-by-side video window's alpha ramps from 0 at each edge to 1, so the frame fades into the black behind it; 0 = hard edges; the pattern, the mono screen and the panel are never feathered) |
| companion → layer | anything else | u32 byteLength, payload | skipped, logged once (every message after protocol 2 is shaped so) |

Every layer → companion message after the hello is magic + u32 byteLength + payload too, so a companion skips what it
does not know and resyncs on the next magic it does.

Video frames are RGBA because the companion reads them with canvas `getImageData`: no byte swap in JavaScript, and on
OpenGL (the owner's rig) and a D3D11 `R8G8B8A8` swapchain none in the layer either.

Compatibility: a protocol-1 layer drops the client on any magic but `CVO1`, so the companion sends `CVC1` and `CVO2`
only after a hello of 2 or more; without one it sends panel frames only, as 0.2.26 did. A protocol-1 companion never
reads the hello (8 bytes sit in its socket) and gets the default control: panel mode, placed low. The control goes
back to that default when the companion disconnects. The companion asks for the camera only after a hello of 3 or more
(a protocol-2 layer would leave the key unread and send no frames, harmlessly); a protocol-2 companion never reads
`CVF1` / `CVS1`, which a protocol-3 layer sends only once asked. The session report (a `CVS1` too) goes after every
connection; a companion from before D7.6.2 logs it once as an unreadable `CVS1` and goes on.

## The session report (layer 0.5.0, D7.6.2)

One complete picture of how VPX reaches the headset, so a rig is described once instead of one fact per headset
session. At the first frame of every session the layer logs it as `session:` lines (one fact per line) in
`vr-layer.log`, and it sends it to the companion as `CVS1` `{"kind": "session", <fact>: <value>, ...}` at that frame,
after every new pipe connection (at the next frame) and on a control with `"report": true`. The facts
(`layer.cpp` `sessionFacts`; null when the runtime did not give one):

| Key | What |
|---|---|
| `layer` | name, version, build id, OpenXR headers tag, pipe protocol |
| `process` | the exe and pid |
| `instance` | what the app (OpenComposite, in VPX) asked at `xrCreateInstance`: application and engine name and version, API version, extensions, API layers it enabled |
| `runtime` | `xrGetInstanceProperties`: runtime name and version |
| `system` | `xrGetSystemProperties`: id, name, vendor id, layer and swapchain limits, tracking |
| `graphics` | the binding (D3D11 / OpenGL (Win32) / another), `GL_VERSION` / `GL_RENDERER` / `GL_VENDOR` when the app's context was current, the D3D11 feature level |
| `views` | `xrEnumerateViewConfigurationViews` (primary stereo): recommended and max image rect per eye, sample counts |
| `appFov` | each eye's fov (degrees: left, right, up, down) and render size in VPX's last frame |
| `located` | each eye's pose and fov from `xrLocateViews` at the last recentre (null before theater) |
| `swapchains` | VPX's swapchains in this session: format (hex and name), size, array, faces, mips, samples, usage flags, image count |
| `lastFrame` | VPX's last `xrEndFrame`: layer count and types, each projection view's swapchain (index into `swapchains`), image rect and array index |
| `theater` | the mode shown, the last recentre's yaw and pitch, the last stereo window (scale, distance, picture size, whether the crop came from the sender, the `tune` it was placed with (`depthM`, null = infinity, and `dyDeg`) and the `feather` on the last video frame (layer 0.5.2), IPD, per eye: fov and its source, render, crop, tangent rect, quad size, position), the window log line |
| `openComposite` | a verdict (its name on the instance; a module named after it; `openvr_api.dll` without SteamVR's `vrclient`) and the marks behind it |
| `modules` | the VR-related modules in VPX's process (full paths) |

The companion's Match tab ("VR test bench", Write VR report) puts it into `vr-report-<date>.md` / `.json` beside
`companion.log`, with the companion's own side (settings, ICE, rig, last controls, counters, the preview window's fit,
VPX's `[PlayerVR]` keys).

## The calibration pattern (layer 0.5.0, D7.6.1)

On a control with `"test": "pattern"` the layer goes to theater (through black, recentred where the head points, like
any theater) and shows a side-by-side picture it draws itself instead of the companion's feed: no second player and no
video needed. Each eye is drawn with the geometry the stereo window assumes for a sender (`eyeCrop`: VPX's fov and render
size from its own frame, VPX's centre crop to the picture's aspect) and placed by `placeWindows` at the control's
`theaterScale`, so a line drawn at angle *a* from an eye's axis is seen at *a* from that eye when the geometry is right:
the two eyes' grids land on each other as one grid at infinity, and a doubled line at a labelled angle is the error
there. In each eye (1024 high, as wide as VPX's render aspect):

- vertical lines every 5° of horizontal angle (atan of the x tangent) and horizontal lines every 5° of vertical angle,
  every 10° brighter and labelled along the eye's axis, the axis itself thickest;
- circles at 10° and 20° from the axis and a cross on it, in the eye's colour (left orange, right blue);
- a large L (left eye, top left) or R (right eye, top right).

What to look for: one grid, the L and R each in its corner, the circles round and single. `vr-layer.log` says
`test: calibration pattern on`, then `test: calibration pattern drawn, each eye WxH; left eye (fov from VPX's frame)
… deg across …` and the `theater: stereo window …` line with the placement. It is redrawn when VPX's fov or render
size changes (at most once a second) and ends with the control (or the pipe: a companion that goes takes it along).

## The camera (protocol 3, D7.5)

A VR sender's picture used to be a screen capture of VPX's VR preview window, which needs a lit desktop, the window in
front, smaller than the display and wholly on it, and still died on Krobs' rig once VPX had focus (D2.5, D7.4.4,
D7.4.10). With the camera, the layer copies the two eye views VPX submits in its `XrCompositionLayerProjection` out of
the frame itself: `VRPreview` becomes optional, the monitor may be off, and the resolution follows the headset.
`src/camera.cpp`; the companion side is `companion/src/media/vr-layer.ts` (`setCamera`, `onCameraFrame`) and the policy
`companion/src/media/layer-camera.ts`; the panel-page contract is `docs/design/alpha-match.md` §5a.

How: the layer hooks `xrCreateSwapchain`, `xrEnumerateSwapchainImages`, `xrAcquireSwapchainImage` and
`xrReleaseSwapchainImage`, so at `xrEndFrame` it knows each projection view's swapchain image (the one last released).
On the render thread it only issues GPU work: OpenGL (the owner's rig: VPX through OpenComposite), a
`glBlitFramebuffer` of each eye's crop into one small texture of ours (left | right, the blit does the scaling) and a
`glReadPixels` of that into a pixel-pack buffer behind a fence; D3D11, a `CopySubresourceRegion` of each crop into a
staging texture. One or two frames later, when the fence / `Map` says the copy is done, it maps the buffer and hands
the pointer to a worker thread; it never waits on the GPU or on the worker. The worker copies the rows out (flipping
OpenGL's bottom-up rows; box-averaging a D3D11 crop down to size), lets the slot go, encodes both eyes as JPEG at
quality 85 (the right eye on a second thread; `third_party/stb/stb_image_write.h`), and writes one `CVF1`. Two slots:
frames are dropped when both are busy, never queued.

Crop and size: the control's `camera` is a per-eye box (the companion asks for 720x1440 at 30 fps by default: the
portrait shape the runbook recommends for the preview window). Each eye is cropped to the box's aspect about the eye's optical
axis (0.5.1, D7.5.8, `eye_crop.h`: centred horizontally on the column where the fov's tangent is 0, clamped inside the
render, centred vertically; 0.5.0 took the render's centre as VPX's own preview does (`Player::PrepareVideoBuffers`),
which stood the two windows about 15° apart on a Quest 3), never stretched, and scaled into the box, never up, to even
sides.
The frame carries what was done, so the receiver places each eye exactly (its stereo window no longer stands in with
its own eyes).

`"whole": true` in the control's `camera` (layer 0.5.2, D7.5.10) takes no crop: each eye's whole render is scaled into
the box (never up, even sides: a 3072x3264 render in a 1440x1440 box gives 1354x1440 per eye), and the header's
`rect` is `[0, 0, render w, render h]`. The receiver's window then shows everything the sender's eye saw, and the
window's frame falls where the sender's view ended, outside the part of the field both eyes share, so it no longer
doubles against the table (a crop's frame stood inside that part, at infinity, while the eyes converged on the table a
metre away). The `camera: on` line says `(whole)` after the crop, the `on` status carries `"whole": true`.

The `CVF1` header (JSON, integers and locale-free decimals only):

```json
{"n": 12, "t": 400123, "enc": "jpeg", "w": 720, "h": 1440,
 "us": {"issue": 180, "map": 1200, "copy": 2100, "enc": 24000},
 "eyes": [{"fov": [-0.907571, 0.785398, 0.872665, -0.959931], "rect": [720, 0, 1632, 3264], "render": [3072, 3264], "len": 210345},
          {"fov": [-0.785398, 0.907571, 0.872665, -0.959931], "rect": [720, 0, 1632, 3264], "render": [3072, 3264], "len": 208811}]}
```

`n` counts issued frames (gaps = drops), `t` is microseconds since the camera started, `w` x `h` is each eye's JPEG
size, `fov` is the view's `[angleLeft, angleRight, angleUp, angleDown]` in radians, `render` the view's `imageRect`
size, `rect` the crop taken inside it (`[x, y, w, h]`, y from the top), `len` the eye's payload length; the payloads
follow the header in eye order (left, right). `us` are that frame's render-thread issue, map, worker copy and encode
microseconds.

What it refuses, with one `camera: refused: …` log line and a `CVS1` `refused` (the companion then keeps the screen
capture): a multisampled swapchain, a swapchain format that is not 8-bit RGBA / BGRA (sRGB or UNORM), an OpenGL
context without framebuffer objects, pixel-pack buffers or fences (OpenGL 3.2), incomplete framebuffers, a session
whose projection views use swapchains the layer did not see created (a VPX started before the layer loaded).

Log lines to read after the first run (`vr-layer.log`):

- `pipe: camera asked: each eye in a 720x1440 box at 30 fps` — the control arrived;
- `camera: on (OpenGL): eye render 3072x3264 (rect 0,0 of a 3072x3264 swapchain, format 0x8c43 GL_SRGB8_ALPHA8, sRGB), crop 1632x3264 at 720,0 -> 720x1440 per eye at 30 fps, JPEG quality 85; …` — what is read and what is sent;
- `camera: frame N: issue A us, ready after K tick(s), map B us, copy C us, encode D us (L x B, R y B), write E us; 720x1440 per eye` — the first 10 frames, then every 300th. `issue` + `map` is the render thread's cost per sent frame (at 30 fps of a 90 Hz loop, one frame in three); `copy`, `encode`, `write` are the worker's. An `encode` above about 30 000 us means the worker cannot keep 30 fps at this size: ask for a smaller box;
- `camera: off (why): N frames sent in S s (F fps), D dropped (ring full a, worker behind b, write failed c); average …` — the summary, with the drops that say which side was slow;
- `camera: refused: …` — why the companion fell back to the screen capture.

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
    points then (its yaw and pitch, never its roll, the pitch clamped to ±75°; `xrLocateSpace` of `VIEW` in `LOCAL`
    at the frame's display time). The pitch is D7.4.7 (2026-11-02): you are looking down at your own playfield when
    the other player's ball starts, about where they look at theirs, so the picture lands where your eyes already
    are; level at eye height, the bottom of their playfield (up to 55° below their view's axis) fell outside your
    headset's view.
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
      (the far edges doubled; "you see them as separate views"). With the picture fused (0.2.34), the window's FRAME
      still doubled: its edge sits at one tangent in both eyes (infinity) while the eyes converge on the table a metre
      away. Layer 0.5.2 (D7.5.9 / D7.6.10 / D7.5.11) answers with the control's `tune` (the frame placed at
      `depthM`: each eye's quad shifted toward the nose by its eye offset over that depth; `dyDeg` lifts one eye's quad
      against the other's; the calibration pattern follows both, so the bench's sliders can be watched) and `feather`
      (the video window's edges fade to the black behind them over that fraction of an eye's half width; the two quads
      then blend instead of being opaque), and the camera's `whole` removes the frame from the shared field altogether.
      The `stereo window` log line names the tune when it is not zero (`window depth 2.60 m`, `vertical offset left +0.5
      deg right -0.5 deg`); `pipe: tune: …` and `pipe: window edges feathered over N% of the eye's width` / `hard` say
      when the control changed them.
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
