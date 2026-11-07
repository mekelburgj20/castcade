# castcade-video

The native spectator-video helper (WORK item D10.1; ADR 0010; `docs/design/spectator-video-native.md` §3 and §6). In a
Castcade match the player up's eye is encoded on the GPU and sent to the other players over standard WebRTC; the
Electron path of 0.2.36 (JPEG → canvas → OpenH264 → RGBA over IPC) could not hold 30 fps. This process does the parts
Electron cannot:

- **encode** the frames the OpenXR layer puts into a shared-memory ring (BGRA, §6.1) with libavcodec's hardware
  encoders, `h264_nvenc` → `h264_amf` → `h264_qsv` → `libx264`, probed once at start;
- **transport** them as one libwebrtc `PeerConnection` per remote player (Google's library, LiveKit's prebuilt M150):
  congestion control, pacing, NACK / RTX, the jitter buffer; signalling stays the companion's `MEDIA_SIGNAL`, so the
  layer never opens a socket;
- **decode** the player up's stream (`h264_cuvid` → D3D11VA → software) into the `recv` ring the layer draws on the
  theater quad, or into a window of its own for desktop (non-VR) watchers (D10.4, "The window" below).

The companion side is `companion/src/media/video-helper.ts` (spawn, JSON lines both ways) and `video-mesh.ts` (one peer
per remote participant, `send on` for the player up). The layer's side of the rings is `vr-layer/` (D10.2).

C++17 code (the libwebrtc headers need `/std:c++20`), CMake ≥ 3.21, MSVC x64. Dependencies, both fetched into
`video-helper/deps/` (gitignored) and checked by sha256: LiveKit's `webrtc-win-x64-release.zip` (tag `webrtc-a545de4`,
an 85 MB static lib + headers, BSD) and BtbN's FFmpeg n8.1 GPL shared build (pin in `ffmpeg.sha256`; the GPL offer is
`docs/ffmpeg-source.md`). libyuv comes from the libwebrtc archive. Nothing from a GPU vendor is bundled: NVENC, AMF,
QSV and cuvid are loaded from the driver at run time.

## Build

From the repo root:

```powershell
pwsh video-helper/fetch-webrtc.ps1          # 114 MB, once; sha256-checked; extracts under video-helper/deps/webrtc/
node video-helper/fetch-ffmpeg.mjs          # BtbN n8.1 shared; sha256-pinned; extracts under video-helper/deps/ffmpeg/
cmake -S video-helper -B video-helper/build -A x64
cmake --build video-helper/build --config Release
# → video-helper/build/Release/castcade-video.exe
#   + avcodec-62.dll avutil-60.dll swscale-9.dll swresample-6.dll (copied beside it by CMake)
#   + THIRD-PARTY.md (generated: libwebrtc BSD and the components its LICENSE.md lists, FFmpeg GPL with the build's
#     version string, libyuv BSD)
```

Static CRT (`/MT`, what the libwebrtc objects ask for), no VC++ redistributable. CI (`.github/workflows/video-helper.yml`)
is the build of record: it fetches both dependencies (cached by their pins), builds, runs `--version` and
`--loopback-selftest` (software codecs on the runner), uploads `castcade-video-win-x64`, and on a `v*` tag attaches
`castcade-video-<tag>-win-x64.zip` (the folder's contents) to the release. `npm run fetch-video-helper -w companion`
takes that zip (or `-- --from video-helper/build/Release` for a local build) into `companion/resources/video-helper/`;
electron-builder ships it as `resources/video-helper/` and the installer adds its firewall rule.

The FFmpeg import libraries are linked **before** `webrtc.lib` on purpose: libwebrtc carries Chromium's own ffmpeg
objects (decoder only) under the same symbol names, and the first library that defines a symbol wins. The probe logs
the libavcodec version it reached and warns when it is not the build the exe was compiled against.

## How the companion finds it

Packaged: `<resources>/video-helper/castcade-video.exe`. Dev: `video-helper/build/Release/castcade-video.exe` first,
then a fetched copy in `companion/resources/video-helper/`. The FFmpeg DLLs must sit beside the exe (the loader looks
in the exe's folder first). A missing exe means the native video path is unavailable; the Electron path stays
selectable for one release (§6.4).

## Command line

```
castcade-video.exe                       the stdio protocol below (how the companion runs it)
castcade-video.exe --version             "castcade-video 0.1.0"
castcade-video.exe --probe               opens each encoder and decoder candidate in turn, closes it again, prints one
                                         JSON line: {"encoder": "h264_nvenc", "decoder": "h264_cuvid", "gpu": "<DXGI adapter name>"}
castcade-video.exe --bench [--seconds 10] [--width 1354 --height 1440 --fps 60] [--kbps 20000] [--gpu-load]
                           [--rate-policy limited|naive] [--rate-jitter 5] [--encoder <name>]
castcade-video.exe --ring-selftest       a send ring produced and consumed in this process, 60 fps for 3 s
castcade-video.exe --loopback-selftest [--seconds 5]   two in-process peers over real libwebrtc (the CI smoke)
castcade-video.exe --window-selftest [--seconds 5] [--warp]   the sink window fed the bench pattern at 60 fps (the
                                         window's CI smoke; --warp skips the hardware device, what a GPU-less runner
                                         falls back to on its own)
```

Exit codes as the audio helper: 0 normal (also after `quit` or stdin EOF), 2 the helper cannot run here (no H.264
encoder opened at all, libwebrtc did not start), 64 bad arguments.

`--bench` encodes synthetic BGRA frames (the D10.0.1 harness's playfield pattern) converted to NV12 with libyuv, at the
given fps, and prints one CSV line a second, `t, encoder, fps, kbps, convert_us, enc_us_avg, enc_us_max, pstate,
applied_kbps, idr`, then a `summary:` line. `pstate` is the NVIDIA performance state from `nvml.dll` (loaded at run
time; `-` on other GPUs). The wanted bitrate steps to a quarter at 1/3 of the run and back at 2/3, with a ±5 % wobble
every 200 ms in between as a bandwidth estimate would give; the summary counts the IDRs at each step and elsewhere.
`--rate-policy` picks how a new target reaches the encoder (D10.1.1): `limited` (the default, and the helper's policy:
a change of ≥ 10 % applied at most once a second, a drop of ≥ 30 % at once) or `naive` (every change as it comes).
`--gpu-load` runs a D3D11 compute loop on another thread for the bench's duration so the GPU stays clocked as it would
with VPX running (D10.1.2): without it this rig's encode time goes 3.7 → 9.9 ms a frame in 10 s as the GPU drops to P8;
with it the run ends at 4.9–5.9 ms (P2–P5; the governor still dips around the low-bitrate third of the run).

## The stdio protocol (§6.2 of `docs/design/spectator-video-native.md`, the normative text)

The shape of `castcade-audio.exe`: the companion spawns the helper, writes one JSON object per line to its stdin,
reads one JSON object per line from its stdout (events), copies stderr into its log. Nothing binary on these pipes
(frames go through the rings). Exit codes as the audio helper (2 = bad arguments, 64 = cannot run here).

Commands (companion → helper):

| `cmd` | Fields | Meaning |
|---|---|---|
| `ice` | `servers: [{urls: [..], username?, credential?}]` | The ICE servers for every peer made after this (the companion's STUN list and TURN entry, media-settings.ts). |
| `peer` | `id` (the remote player's id), `initiator: bool` | Make a PeerConnection for that remote player with one `sendrecv` video transceiver (H.264 only, packetization mode 1). The initiator makes the offer now; the other waits for it. One PC per pair for the whole match; nothing is renegotiated. |
| `signal` | `id`, `kind: offer \| answer \| ice`, `sdp?`, `candidate?` (`{candidate, sdpMid, sdpMLineIndex}`) | The remote side's signal for that peer, relayed from `MEDIA_SIGNAL` with `channel: "video"`. |
| `close` | `id` | Close that peer. |
| `source` | `kind: ring \| bench \| none`, `token?`, `width`, `height`, `fps` | Where the frames this rig sends come from: the `send` ring named by the token (the layer fills it), a synthetic bench picture, or nothing. |
| `send` | `on: bool` | Whether this rig is sending now (the player up): the encoder runs and the video sender is active; off = the track is paused (the transceiver stays). |
| `rungs` | `max_kbps`, `pin?: int \| null` | The ladder ceiling (the host's, D8.2 / D10.5) and an optional manual pin to one rung; absent = the controller chooses. v1 of the helper: the ceiling clamps libwebrtc's `max_bitrate_bps`; the ladder itself is D10.5. |
| `sink` | `kind: ring \| window \| none`, `token?`; window only, all optional: `title`, `topmost: bool`, `monitor: int`, `x, y, width, height` | Where decoded frames go: the `recv` ring (the layer draws it), a window the helper opens itself (desktop watchers, D10.4; "The window" below), or nowhere. The last `sink` wins. |
| `quit` | | Close everything and exit 0. Closing stdin does the same. |

Events (helper → companion):

| `event` | Fields |
|---|---|
| `ready` | `version`, `encoder` (the probe's choice: `h264_nvenc` / `h264_amf` / `h264_qsv` / `libx264`), `decoder` |
| `signal` | `id`, `kind`, `sdp?`, `candidate?` — to be wrapped in `MEDIA_SIGNAL {channel: "video", to: id}` |
| `peer` | `id`, `ice: new \| checking \| connected \| completed \| failed \| disconnected \| closed`, `pair?` (the selected candidate pair's types and addresses, for the Match tab's connectivity line) |
| `stats` | once a second: `id`, `dir: send \| recv`, `fps`, `kbps`, `width`, `height`, `rtt_ms?`, `loss_pct?`, `bwe_kbps?`, `enc_us?`, `dec_us?`, `freeze_ms?`, `encoder?`, `decoder?`, `quality_limitation?` |
| `source` | `kind`, `state: ok \| missing \| dead`, `fps_in` — the ring's health |
| `sink` | `kind: window`, `state: open \| closed`, `driver: hardware \| warp`, `x`, `y`, `width`, `height` (the window rect; `closed` = the watcher closed it, the sink is `none` from then on) |
| `error` | `code` (`bad_command`, `peer_unknown`, `ring_open_failed`, `encoder_failed`, …), `text` |
| `log` | `level: info \| warn`, `text` |

### What 0.1.0 does with it (the details the table leaves open)

- **Exit codes** follow the audio helper's actual numbers (`audio-helper/README.md`): 64 = bad arguments, 2 = cannot
  run here. The parenthetical in the §6.2 text has them the other way round; the companion treats both as `helper_failed`.
- `ready` comes after the probe (NVENC is opened once and closed, about 150 ms on an NVIDIA rig) and after libwebrtc
  started. Every later encoder and decoder is opened by the probed name, never re-probed.
- `ice`: `urls` may be one string or an array (both shapes the companion's `IceServer` allows). Servers apply to peers
  made after the command; a peer keeps the servers it was made with.
- `peer`: a second `peer` with the same `id` closes and replaces the first. The sender's encoding starts inactive and
  follows the last `send`; the remote description gets `x-google-start-bitrate=4000;x-google-min-bitrate=500;
  x-google-max-bitrate=50000` appended to every H264 `a=fmtp` before `SetRemoteDescription` (the send parameters come
  from the remote description), and the encoding's `max_bitrate_bps` is the live ceiling (`rungs`, default 20000).
  Degradation preference is `DISABLED`: the ladder is ours (D10.5), libwebrtc never scales or drops on its own.
- `signal`: candidates that arrive before the remote description wait for it. A `candidate` whose `candidate` string
  is empty (a browser's end-of-candidates) is ignored. The helper never sends an end-of-candidates signal.
- `signal` out carries `candidate.candidate` as the SDP attribute value (`candidate:…`, no `a=`), `sdpMid` and
  `sdpMLineIndex`, the shape of a browser's `RTCIceCandidate`.
- `peer` events: one per ICE state change and one per selected-pair change (same `ice`, new `pair`). `pair` is
  `{"local": {"type", "protocol", "address", "relay_protocol"?}, "remote": {…}}` with `type` one of host / srflx /
  prflx / relay and `address` as `ip:port`. `close` answers with `ice: closed`.
- `source ring`: the helper opens the layer's `send` ring and reports `missing` until it exists (retried every
  500 ms), `ok` while frames come, `dead` when the producer's heartbeat is older than 3 s (then it closes and retries).
  The `source` event is sent on every state change and once a second while a source is set, with `fps_in` (frames taken
  from the ring in the last second, whether or not sending), `convert_us` (BGRA → NV12 average) and `skipped` (frames
  the producer lapped). `width`/`height` are informational for a ring (the frames carry their own size; a size change
  re-opens the encoder). For `bench` they set the picture (480x300 minimum, even, fps 1–120).
- `send off`: no frames are converted or pushed, and every peer's encoding is set `active = false`. `send on` does
  the reverse; a peer made while sending is on starts active.
- `rungs`: `pin` 1–6 clamps the ceiling to that rung's kbps (20000, 10000, 8000, 5000, 4000, 2000: the provisional
  ladder of §3); its size and frame rate are D10.5. A `pin` of `null` or absent clears it.
- `sink ring` creates the `recv` ring as its producer, sized by `width`/`height` (optional, default 2048x2048: a
  decoded picture larger than the box is dropped and logged once). A section that already exists under the token is
  adopted when its geometry matches (the header's rule) and refused with `ring_open_failed` otherwise.
- `sink window` opens the window below (`window_open_failed` with the reason when neither a hardware nor a WARP
  D3D11 device could be made) and answers `sink … open`; the last `sink` wins (a window closes the ring, a ring
  closes the window, `none` closes either; `quit` closes it too).
- `stats`: two events per peer per second, `dir: send` and `dir: recv`, from `GetStats` deltas. `send`: `fps` = frames
  sent, `kbps` = RTP payload + header bytes, `width`/`height` of the encoded frame, `rtt_ms` and `loss_pct` from
  remote-inbound-rtp, `bwe_kbps` = the selected pair's available outgoing bitrate, `enc_us` = libwebrtc's encode time
  per frame, plus `target_kbps` (the encoder target the stack set). `recv`: `fps` = frames decoded, `kbps` received,
  `width`/`height` of the last decoded picture (libwebrtc only sees the 16x16 bookkeeping frame the decoder hands it),
  `dec_us`, `freeze_ms` (total freeze time in the second), `loss_pct` of packets, plus `jitter_ms` (the jitter buffer's
  delay per emitted frame) and, with a ring or window sink, `conv_us` (YUV → BGRA average); with the window sink
  also `presented_fps` (frames presented in the window per second) and `present_us` (mean upload + Present).
- Every unknown or malformed command answers `error bad_command`; `signal` / `close` for an unknown `id` answer
  `error peer_unknown`; a peer that could not be created answers `error peer_failed`; negotiation and candidate
  problems come as `error negotiation_failed` / `error bad_signal` with the peer's `id`. The helper carries on.
- stderr: one `video: …` line per state change (probe results, peers made / connected / closed, source and sink
  changes, `send` changes, encoder and decoder opens, libwebrtc warnings), never per frame.

## The window (`sink window`, D10.4; `src/sink_window.{h,cpp}`)

The picture a desktop watcher sees. The helper opens a Win32 window of its own (class `CastcadeVideoWindow`, title
`Castcade — spectating` or the command's `title`) on its own thread with its own message loop, puts a D3D11 flip-model
swapchain on it (`DXGI_FORMAT_B8G8R8A8_UNORM`, two buffers, vsync on; hardware device first, WARP second, so a machine
without a GPU still shows the picture) and draws every decoded frame letterboxed in black with the aspect kept: the
BGRA picture goes into a dynamic texture (Map `WRITE_DISCARD` + one row copy; a size change re-creates it) and a
full-screen triangle drawn through a viewport the size of the letterbox does the scaling (a tiny vertex / pixel shader
pair compiled at run time with D3DCompile; linear sampling). The decode thread never touches D3D: it converts the
picture into the window's pending buffer (`Begin` / `Commit`, the ring producer's shape, so `Sink::OnDecoded` has
one conversion for either sink) and posts a message; the newest frame wins when the window is behind.

Placement: absent, the primary display, a client area 50 % of the display's height at the eye's aspect (1354:1440),
centred in the work area; the first frame of a different aspect resizes the width to match unless the watcher has
moved or resized the window. `monitor` picks the display (0 = primary, n = the n-th in Windows' enumeration order;
out of range = primary). `x, y, width, height` together are a remembered window rect (what the `sink` event
reports); `width, height` alone are a client size, centred on the chosen display. `topmost` keeps it above VPX. The
window is resizable (200x200 minimum), per-monitor-v2 DPI aware. Double-click or F11 toggles borderless full screen on
the window's current monitor (DXGI's own Alt+Enter is disabled), Escape leaves it. Closing the window is `sink none`
from the helper's side: `{"event":"sink","kind":"window","state":"closed","x":…,"y":…,"width":…,"height":…}` carries the
last placement outside full screen so the companion can remember it. While no frame has arrived for 3 s (also the
first 3 s after opening) the window shows black with a small centred "waiting for the player up" (drawn once with
GDI into a bitmap and uploaded as a texture; no DirectWrite / Direct2D interop). A device loss closes the window.

## The frame ring (§6.1; `include/castcade_frame_ring.h` is the contract)

`src/frame_ring.{h,cpp}` is the helper's side of both rings, written to the header's protocol: `RingConsumer` opens the
layer's `send` ring (`Local\castcade-video-send-<token>` and `…-event`, read/write for the `reading` field, read-only
with the post-use check alone when the producer is elevated); `RingProducer` creates the `recv` ring (slot = seq %
slots, stepping past the consumer's slot; seq = 0 while writing; the producer's heartbeat every publish and every
200 ms idle; a matching existing section is adopted). The decoded picture is converted into the slot in place. The
tool that feeds a send ring and drains a recv ring from the layer's side is `vr-layer/tools/ring_feed.cpp`.

## Pixel formats and colour

The ring carries BGRA; libyuv's `ARGBToNV12` / `NV12ToARGB` (its "ARGB" is this byte order) convert with BT.601 limited
range on both ends, so the round trip is consistent. The encoder gets NV12 (zero-copy from the conversion buffer), the
decoder yields NV12 (cuvid, D3D11VA after the hardware → system copy) or I420 (software).

## Measured on the owner's rig (RTX 3090, driver 616.56)

- `--bench` at 1354x1440 @ 60, 20 Mbps: convert 0.6 ms, encode 3.7 ms a frame, climbing to 9.9 ms within 10 s as the GPU
  goes P2 → P8 with nothing else running; with `--gpu-load` the run ends at 4.9–5.9 ms, P2–P5 (D10.1.2).
- libavcodec's `h264_nvenc` costs one IDR per applied rate change, whatever the VBV does (52 changes → 52 IDRs under the
  naive policy; 2 → 2 under the limited one): the limited policy is the default. A direct `NvEncReconfigureEncoder`
  without `forceIDR` needs `nvEncodeAPI.h`, which neither the FFmpeg build nor this machine has (D10.1.1 stays open).
- `--loopback-selftest`: connected in 14 ms, 60 fps at 20 Mbps, nvenc → cuvid, decode 2.1 ms a frame.
- `--window-selftest` (1354x1440 @ 60): 300 fed, 302 presented, upload 0.69 ms, upload + Present 0.78 ms a frame on
  the hardware device; `--warp` 0.72 / 0.87 ms (the 7.8 MB copy dominates on either).
