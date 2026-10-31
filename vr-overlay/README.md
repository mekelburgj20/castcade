# castcade-vr-overlay

The OpenVR overlay helper (WORK item D7; spec: `docs/design/alpha-match.md` §5). A VR player cannot see a desktop
window, so the companion renders the match panel offscreen and pipes its frames to this small process, which draws
them in the headset as a SteamVR overlay over VPX's VR session. The companion side is
`companion/src/media/vr-overlay.ts`; it spawns the exe, feeds it, reads its events and restarts it once if it dies.

C++17, CMake ≥ 3.20, MSVC x64; the only dependency is the OpenVR SDK (BSD-3, `THIRD-PARTY.md`), fetched by CMake from
a pinned release tag and checked by sha256 (`CMakeLists.txt`).

## Build

```powershell
cmake -B build -A x64            # the newest Visual Studio generator; MSVC x64
cmake --build build --config Release
# → build/Release/castcade-vr-overlay.exe, openvr_api.dll, THIRD-PARTY.md
```

The first configure downloads the OpenVR tag archive (~150 MB; only the headers and the win64 lib and DLL are used).
Release builds use `/O2` with link-time code generation and the static CRT (`/MT`), so no Visual C++ redistributable
is needed. CI (`.github/workflows/vr-overlay.yml`) is the build of record: it uploads the three files as the artifact
`castcade-vr-overlay-win-x64` on every change here, and on a `v*` tag attaches
`castcade-vr-overlay-<tag>-win-x64.zip` to the GitHub release, where `npm run fetch-vr-overlay -w companion` picks it up
for packaging (`--from vr-overlay/build/Release` copies a local build instead).

## Command line

```
castcade-vr-overlay.exe [--width-m 0.55] [--anchor hmd|world] [--offset 0,-0.28,-0.9] [--alpha 0.95]
                        [--key castcade.panel] [--name Castcade]
```

| Flag | Default | Meaning |
|---|---|---|
| `--width-m` | `0.55` | Panel width in metres (height follows the frame's aspect). |
| `--anchor` | `hmd` | `hmd`: the panel moves with the head. `world`: placed once at start where `hmd` would have put it (head yaw only, so it is upright), then fixed in the room (standing space). |
| `--offset` | `0,-0.28,-0.9` | Metres from the head: right, up, forward negative (OpenVR's HMD space). The default sits below the line of sight. |
| `--alpha` | `0.95` | Overlay opacity, 0 to 1. |
| `--key` | `castcade.panel` | The overlay key (unique per SteamVR session; a second helper with the same key fails with `KeyInUse`). |
| `--name` | `Castcade` | The overlay's display name. |

Placement: the quad is turned so its front faces the eye (a look-at from the offset back to the head, kept upright), so
at the default offset it tilts back about 17° and reads square-on when the player glances down.

## stdin: frames

Binary, back to back, each frame:

| Bytes | Field |
|---|---|
| 0–3 | magic `CVO1` |
| 4–7 | width, u32 little-endian (1 to 4096) |
| 8–11 | height, u32 little-endian (1 to 4096) |
| 12–15 | byteLength, u32 little-endian, must equal width × height × 4 |
| 16… | byteLength bytes of **BGRA**, top-down (Chromium's offscreen paint format, sent as-is) |

Every header is validated; a bad one ends the helper with exit 4. Each frame replaces the last
(`IVROverlay::SetOverlayRaw`). The reader keeps only the newest complete frame, so a burst never queues up.

**Swizzle:** `SetOverlayRaw` takes RGBA when `unBytesPerPixel` is 4. The helper swaps R and B in one in-place pass
before each upload; the companion does no pixel work.

The first frame shows the overlay; 5 s without a frame hides it; the next frame shows it again. The companion re-sends
its last frame every 2 s while the panel is still (Chromium paints only on change), so a hide means the companion
stopped feeding. stdin EOF ends the helper cleanly.

## stdout: events

One JSON object per line:

| Line | When |
|---|---|
| `{"event":"ready"}` | The first frame is up and the overlay is shown. |
| `{"event":"hidden"}` | 5 s without a frame; the overlay is hidden. |
| `{"event":"showing"}` | A frame arrived after `hidden`; shown again. |
| `{"event":"eof"}` | stdin closed; exiting 0. |
| `{"event":"quit"}` | SteamVR sent `VREvent_Quit`; exiting 0. |
| `{"event":"unavailable","reason":"steamvr_not_running","detail":"…"}` | `VR_Init` found no SteamVR or headset; exiting 2. |
| `{"event":"error","reason":"openvr_init"\|"overlay_create"\|…,"detail":"…"}` | An OpenVR error; exiting 3. |
| `{"event":"error","reason":"bad_frame","detail":"bad_magic"\|"bad_size:WxH"\|"bad_length:N"}` | A bad frame header; exiting 4. |
| `{"event":"error","reason":"bad_args","detail":"…"}` | A bad command line; exiting 64. |

stderr carries human-readable log lines (the companion copies them to its log).

## Exit codes

`0` stdin EOF or SteamVR quit · `2` SteamVR not running (or no headset) · `3` OpenVR error · `4` bad frame header ·
`64` bad arguments.

## Try it by hand

With SteamVR running, any program that writes the frame format to the exe's stdin works; the companion's
`frameHeader()` (`companion/src/media/panel-frame-writer.ts`) builds the header.
