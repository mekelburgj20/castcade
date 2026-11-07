# D10.0.1 — GStreamer candidate: notes

Scratch code, nothing here ships. The question: GStreamer's whole pipeline off the shelf (nvh264enc,
WHIP/WebRTC with its congestion control, decode) as a loopback sender + receiver — quality, size, how much
we would own, and the install story.

## 1. Runtime without admin (done, no elevation)

The official installer `gstreamer-1.0-msvc-x86_64-1.28.8.exe` (517 MB, sha256 verified against the published
`.sha256sum`) is **Inno Setup 6.7**, built by cerbero (`cerbero/packages/windows/inno_setup.py`) with
`PrivilegesRequired=admin` **but** `PrivilegesRequiredOverridesAllowed=dialog commandline` and a portable mode
(`{param:portable|0}`: `Uninstallable=not portable`, `ChangesEnvironment=not portable`, registry/env tasks and
the vcredist task are skipped). There is **no separate devel installer any more**: the single installer has
types `runtime | devel | debug` (devel = runtime + headers + `.lib` + pkg-config files + 1.67 GB of static `.a`).

What did not work: `msiexec /a` (not an MSI), 7-Zip (does not read Inno 6.7), innoextract (1.9 reads up to
Inno 6.2; master up to 6.4). What worked, as one command, no UAC prompt:

```
gstreamer-1.0-msvc-x86_64-1.28.8.exe /CURRENTUSER /portable=1 /TYPE=devel /DIR=<abs>\deps\gstreamer\1.0\msvc_x86_64 /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOICONS /LOG=<abs>\deps\dl\install.log
```

`unpack.ps1` does download + sha256 + that command (about 4 minutes); `env.ps1` sets
`GSTREAMER_1_0_ROOT_MSVC_X86_64`, `GST_PLUGIN_PATH`, `GST_REGISTRY` (kept under deps/), `PKG_CONFIG(_PATH)`
(the tree ships `bin\pkg-config.exe`; the `.pc` files are relocatable, `prefix=${pcfiledir}/../..`) and PATH.
Verified afterwards: no `GSTREAMER_1_0_ROOT_MSVC_X86_64` user/machine env var, no HKCU uninstall key.

Unpacked size: **2089 MB** total = bin 192 (DLLs 174) · lib 1830 (static `.a` 1670, plugins `lib/gstreamer-1.0/*.dll`
132, import `.lib` 10, python/typelibs 8) · include 25 · share 43. The runtime-only type would be roughly
bin + plugins + share ≈ 370 MB.

## 2. Inventory (gst-inspect-1.0, 272 plugins / 1626 features on this rig)

| Element | Plugin file | Rank | Note |
|---|---|---|---|
| `nvh264enc` | gstnvcodec.dll (0.9 MB) | primary+1 (257) | CUDA path; webrtcsink's first H264 pick by rank |
| `nvd3d11h264enc` | gstnvcodec.dll | none | D3D11 texture input variant |
| `nvautogpuh264enc` | gstnvcodec.dll | none | auto device variant |
| `nvcudah264enc` | — | — | not in 1.28 (name does not exist) |
| `amfh264enc` | gstamfcodec.dll (0.3 MB) ships | — | **registers only on an AMD GPU**: not on this rig; cannot be verified here |
| `qsvh264enc` | gstqsv.dll (0.6 MB) ships | — | registers only with Intel media runtime: not on this rig |
| `x264enc` | gstx264.dll | primary (256) | software fallback (GPL-2.0) |
| `openh264enc` | gstopenh264.dll | marginal | BSD software fallback |
| `d3d11convert` / `d3d11upload` / `d3d11download` | gstd3d11.dll | none | present |
| `d3d12convert` / `d3d12upload` / `d3d12download` / `d3d12h264enc` | gstd3d12.dll | none | present; `d3d12h264enc` is the vendor-neutral D3D12 video encode path |
| `d3d12h264dec` | gstd3d12.dll | primary+2 (258) | **decodebin3's pick** on this rig |
| `nvh264dec` | gstnvcodec.dll | primary+1 (257) | NVDEC |
| `nvh264sldec`, `nvd3d11h264dec` | — | — | names do not exist in 1.28 |
| `d3d11h264dec` | gstd3d11.dll | primary+1 (257) | |
| `avdec_h264` | gstlibav.dll | primary (256) | software fallback |
| `webrtcsink`, `whipclientsink`, `whepserversink` | gstrswebrtc.dll (16.2 MB, Rust, static) | none | present in the official Windows build |
| `webrtcsrc`, `whipserversrc`, `whepclientsrc` | gstrswebrtc.dll | primary | present |
| `whepserversrc` | — | — | no such element (the WHEP server is a sink: `whepserversink`) |
| `webrtcbin` | gstwebrtc.dll | primary | |
| `rtpgccbwe` | gstrsrtp.dll (3.5 MB) | none | the GCC bandwidth estimator webrtcsink inserts |
| `rtph264pay` / `rtph264depay` | gstrtp.dll | secondary | |
| `h264parse` | gstvideoparsersbad.dll | primary+1 | |
| `appsrc` / `appsink` | gstapp.dll | none | |
| `cudaconvert` | — | — | not registered here (`cudaupload` is); nvh264enc takes system-memory NV12 directly |
| `videoconvert` | gstvideoconvertscale.dll | marginal | |

The uncertain part was the Rust plugins: **they are in the official 1.28.8 MSVC package** (`gstrswebrtc.dll`
= gst-plugins-rs 0.15 `webrtc` crate with WHIP/WHEP/LiveKit/Janus signallers, `gstrsrtp.dll` with `rtpgccbwe`).
No `gst-webrtc-signalling-server` build was needed: WHIP is HTTP between the two elements.

## 3. The candidate (`spike-gst`, Rust, gstreamer-rs 0.25, runs; see the smoke tails in §5)

- Sender: `appsrc NV12 1354x1440@60 (harness dll via libloading, videotestsrc when absent) → queue →
  whipclientsink (video-caps=video/x-h264, congestion-control=gcc, start/min/max-bitrate, do-retransmission)`.
  webrtcsink owns the encoder: it picks the first H264 encoder by rank (`nvh264enc` here; `--encoder` raises a
  factory to rank MAX through `GST_PLUGIN_FEATURE_RANK` before `gst_init`), configures it (`bitrate`,
  `gop-size=2560`, `rc-mode=cbr-ld-hq`, `zerolatency=true`), payloads with `mtu=1200 aggregate-mode=zero-latency
  config-interval=-1`, and drives `bitrate` from `rtpgccbwe::estimated-bitrate`. Our `encoder-setup` handler adds
  `preset=p4 tune=ultra-low-latency bframes=0 rc-lookahead=0 aud=false` and returns false so the defaults still apply.
- Receiver: `whipserversrc (video-codecs=[H264], do-retransmission) → [decodebin3 inside it] → queue →
  videoconvert → appsink NV12 sync=false`. decodebin3 picked `d3d12h264dec` (rank 258 beats `nvh264dec` 257);
  `--decoder nvh264dec` overrides. Frames, arrival gaps and the burned-in counter are read from the NV12.
- ICE: both sides pin the agent to one port (`GstWebRTCICE` `min-rtp-port`/`max-rtp-port`, 27510 sender /
  27500 receiver) and one local address (`add-local-ip-address 127.0.0.1`; libnice does not gather loopback
  by itself, it offered the LAN address 192.168.1.20). Both WHIP elements send a full SDP after ICE gathering
  completes; nothing trickles.
- Shaper routing: `whip-proxy.mjs` (Node, no deps) in front of whipserversrc rewrites the POSTed offer and
  the 201 answer: keeps one host UDP IPv4 candidate (prefers 127.0.0.1), offer port := C (the port the
  receiver talks to), answer port := S (the port the sender talks to), drops the other candidates, 405s
  PATCH. `--s 0 --c 0` keeps the real ports (pass-through, used to test the path without the shaper).
- `run.mjs` starts receiver → proxy → sender and prints the CSV tails; the lead's `measure.mjs` template is
  `node spike/d10-video/gstreamer/run.mjs --s {S} --c {C} --duration {DUR} --out {OUT}` (`--direct` skips the proxy).
- CSVs: required columns first, then extras. Sender: `enc_kbps` (encoder output), `frames_in`, `mitigation`
  (webrtcsink's flag), `enc_bitrate_kbps` (the encoder's `bitrate` property). Receiver: `width,height` of the
  delivered frames, `decoder`, `counter_last/ok/bad`, `packets_lost`, `jitter_ms`. `kbps_sent`/`kbps_received`
  are webrtcbin `get-stats` `outbound-rtp.bytes-sent` / `inbound-rtp.bytes-received` deltas (wire rate incl.
  RTX), `rtt_ms` is `remote-inbound-rtp.round-trip-time`, `bwe_kbps` is `rtpgccbwe.estimated-bitrate`,
  `enc_cost_us_avg` is encoder sink-pad-in to src-pad-out wall time (includes the NV12 upload to CUDA).
- The sender's clock starts at the session encoder's first output (webrtcsink first runs a discovery pipeline
  with its own encoder instance — "encoder #1 for peer discovery"; only #2 is counted).

## 4. Things the lead should know (behaviour of the off-the-shelf stack, measured or read in 0.15 source)

1. **Built-in ladder.** webrtcsink's default mitigation (`enable-mitigation-modes`, default downscaled +
   downsampled) rewrites the encoder input caps from the bitrate: height 360 below 1 Mbps, 720 below 2 Mbps,
   native above; frame rate halved below 500 kbps. The protocol's 2 Mbps phase sits exactly on the 720 p edge.
   The `mitigation` column reads "Lowered resolution" even at native size (the flag is set whenever a height
   field is present); trust the receiver's `width,height`. `--mitigation none` disables it for a second run.
2. **Encoder bitrate vs estimate.** With `start-bitrate=20 Mbps` the session encoder was set to 13 468 kbps
   while `rtpgccbwe.estimated-bitrate` read 20 000 for the rest of the run; webrtcsink only re-applies the
   bitrate on an `estimated-bitrate` notify, which GCC emits on change only. With the harness content the
   estimate will move and this should resolve itself; if the first 30 s show the encoder below the estimate,
   that is this.
3. **Unknown encoders get no congestion control.** `webrtcsink::configure_congestion_control` returns early for
   encoders not in `is_bitrate_supported` (x264enc, nvh264enc, qsvh264enc, va*, openh264 ...): **`amfh264enc` is
   not in the list** (0.15), so on an AMD rig webrtcsink would send at a fixed bitrate unless we patch
   gst-plugins-rs or set the bitrate ourselves from `rtpgccbwe` (we can: the element is reachable).
4. **Connect time.** About 4 s from pipeline start to the first encoded session frame on loopback (discovery
   pipeline ~1 s, ICE gathering + DTLS the rest).
4b. **No bandwidth probing.** webrtcsink warns `rtprtxsend doesn't have a stuffing-kbps property, stuffing
   disabled` on this 1.28.8 build: GCC gets no padding to probe with, so after the 2 Mbps phase the estimate
   can only grow on the back of what the encoder actually sends (the recovery-time number measures that).
4c. **Windows gotcha.** libnice's `add-local-ip-address` fails with "Failed to initialize NiceAddress" if
   nothing in the process has initialised Winsock yet (`inet_pton` → WSANOTINITIALISED); spike-gst opens a
   throwaway UDP socket before `gst_init`. A helper that pins addresses needs the same.
5. **Start-up burst.** The receiver's first second delivers ~90–150 frames (jitterbuffer latency released).
6. The GStreamer log line `rtpsession ... generated empty RTCP messages` is noise.
7. `enc_cost_us_avg` ≈ 9.3 ms on the 3090 for 1354x1440 with p4/ultra-low-latency through nvh264enc; it
   includes the system-memory → CUDA upload nvh264enc does per frame (`nvd3d11h264enc` with D3D11 textures
   would avoid it, which is the layer's real path).

## 5. Smoke results (owner's 3090, 2026-11-07; the 90 s measurement runs are the lead's via `measure.mjs`)

**Smoke 1–2: videotestsrc, 15 s direct and 15 s through the WHIP proxy in pass-through mode** (`--s 0 --c 0`):
`nvh264enc` → `d3d12h264dec`, 60 fps sent and delivered every full second, `freeze_ms_max` 31–33 ms, rtt 0.0–0.5 ms,
no loss; the wire carried only 250–350 kbps because the ball pattern compresses to nothing (CBR does not pad).

**Smoke 3: harness frames (`castcade_spike_harness.dll` from main), 20 s through the proxy + the shaper at a flat
25 Mbps** (`shaper.mjs --s 27410 --c 27411 --schedule 25000:60 --start-on-first-packet`), `start-bitrate` 20 Mbps,
`max-bitrate` 30 Mbps. The counter reader works (1138 frames in sequence, 27 not: the start-up burst). Shape of it:
the first ~10 s **overshoot** the link — encoder at 20 Mbps plus RTX fills the shaper's 150 ms queue (shaper log:
24.9 Mbps forwarded, `queued_ms` 150, 25–271 packets dropped a second), GCC sees 136 ms RTT and 2.3 % loss and
backs the encoder down from 17 Mbps (t=2) to 8.5 Mbps (t=11); from ~11 s the queue drains, the encoder climbs
back to 11.6 Mbps by t=19 (wire 13–15 Mbps with RTX), rtt back to 1.3 ms. Delivered frame rate: 59–63 fps while the
queue was filling (t=2–5), then **37–54 fps for t=5–8 with `freeze_ms_max` 118–168 ms and 27 frames lost**
(`counter_bad`, receiver-side `packets_lost` 49–88), then 58–61 fps from t=9 on with `freeze_ms_max` 47–82 ms
(3–5 frame intervals); resolution stayed 1354x1440 (no mitigation above 2 Mbps). `enc_cost_us_avg` 5.5–6 ms a
frame while the encoder ran at 13–17 Mbps, 10–14 ms once congestion control was active (includes the NV12 →
CUDA upload; the libavcodec harness encoder is the comparison).

```
t,encoder,fps_sent,kbps_sent,target_kbps,enc_cost_us_avg,rtt_ms,loss_pct,bwe_kbps,enc_kbps,frames_in,mitigation,enc_bitrate_kbps
14,nvh264enc,59,13368,10334,13410,136.4,2.34,12071,11723,850,Lowered resolution,10334
15,nvh264enc,60,14179,11001,14196,136.4,2.34,13039,12540,910,Lowered resolution,11001
16,nvh264enc,63,14996,9715,10243,136.4,2.34,11198,11605,972,Lowered resolution,9715
17,nvh264enc,58,13264,10259,11233,136.4,2.34,11965,11468,1031,Lowered resolution,10259
18,nvh264enc,62,13982,10934,12673,136.4,2.34,12940,12719,1093,Lowered resolution,10934
19,nvh264enc,59,14920,11621,13235,1.3,0.00,13963,12980,1152,Lowered resolution,11621
t,frames_delivered,fps,kbps_received,decode_ok,freeze_ms_max,width,height,decoder,counter_last,counter_ok,counter_bad,packets_lost,jitter_ms
14,894,61,14667,1,47,1354,1440,d3d12h264dec,993,867,27,0,1.5
15,954,60,14739,1,57,1354,1440,d3d12h264dec,1053,927,27,0,1.4
16,1013,59,12490,1,50,1354,1440,d3d12h264dec,1112,986,27,0,1.2
17,1071,58,14397,1,70,1354,1440,d3d12h264dec,1170,1044,27,0,0.5
18,1132,61,14384,1,82,1354,1440,d3d12h264dec,1231,1105,27,0,1.4
19,1165,33,16884,1,464,1354,1440,d3d12h264dec,1264,1138,27,0,1.0   (sender stopped at 20 s; teardown)
shaper: t,rate_kbps,fwd_kbps,dropped,queued_ms
2.4,25000,24976,25,150 · 8.4,25000,24981,271,150 · 11.4,25000,13459,0,80 · 15.4,25000,18647,0,39 · 19.4,25000,24986,0,139
```

For the measurement the lead may want `--start-kbps` below the first cap (GCC ramps from there instead of
overshooting into the queue) — that is a protocol choice, the default stays 20 000 to match the other candidates.
Note the `rtt_ms`/`loss_pct` columns hold the last RTCP receiver report and change in steps.

## 6. Packaging answer

Minimal DLL closure for a shipped helper (`python -I dllset.py`, PE import walk from the plugin set):

| Set | Files | Size |
|---|---|---|
| NVIDIA-only: core libs + coreelements, app, nvcodec, videoparsersbad, rtp, rtpmanager, webrtc, nice, dtls, srtp, rswebrtc, rsrtp, videoconvertscale, videorate, playback, typefindfunctions (+ their deps: glib/gio/gobject, nice, srtp2, libssl/libcrypto 8.1 MB, orc, pcre2, z, ffi, intl, gstd3dshader 3.7 MB pulled by gstnvcodec via gstd3d11/d3d12 libs) | 49 | **47.7 MB** |
| + fallbacks: gstd3d11, gstd3d12 (decode), gstlibav + avcodec/avformat/avutil/swscale (14.8 + 4 MB), gstx264 + x264-164 (2.3 MB) | 62 | **73.0 MB** |

Of that, `gstrswebrtc.dll` alone is 16.2 MB and `gstrsrtp.dll` 3.5 MB (static Rust: tokio, warp, reqwest,
the signallers). Not shipped: `nvEncodeAPI64.dll`, `nvcuvid.dll`, `nvcuda.dll` (driver), `d3d11/d3d12/dxgi`,
the VC++ 2015-2022 runtime (`msvcp140`, `vcruntime140(_1)`; the Castcade installer already needs it or we add
the redistributable merge). Full runtime for comparison: 2089 MB devel tree / ≈370 MB runtime type.

Licences in the path: GStreamer core, base, good, bad, libav wrapper: LGPL-2.1+; gst-plugins-rs (`webrtc`,
`rtp`): MPL-2.0; libnice: LGPL-2.1 / MPL-1.1; OpenSSL 3: Apache-2.0; libsrtp2: BSD-3; orc: BSD-2; glib: LGPL-2.1+;
FFmpeg as built by cerbero: LGPL configuration; **x264 (`gstx264.dll`, `x264-164.dll`): GPL-2.0** — fine under
Castcade's GPLv3 and the E5 source offer, but it is the one GPL component in the fallback set; openh264: BSD
(Cisco binary licence for the AVC patent pool applies only if we ship their binary). NVENC headers: MIT.

CI (template `.github/workflows/audio-helper.yml`): a `windows-latest` job runs `spike/d10-video/gstreamer/unpack.ps1`
(517 MB download + silent Inno unpack, about 4 min; cache `deps/gstreamer` keyed on the installer sha256;
`/TYPE=runtime` is enough for packaging, `devel` for building), builds with `cargo build --release` after
dot-sourcing `env.ps1` (pkg-config comes from the tree, no vcpkg), then copies the `dllset.py` set beside the
exe into the artifact. For the shipped helper the plugin set would be pinned by name in a script like
`dllset.py` and the GStreamer version pinned like ffmpeg's (`fetch-ffmpeg`-style, sha256-checked).

## 7. What we would own (lines)

`git ls-files spike/d10-video/gstreamer | xargs wc -l` at the end of the session: see the report. Roughly:
`src/main.rs` ≈ 560 (both roles, probes, CSV, harness loading), `whip-proxy.mjs` ≈ 80, `run.mjs` ≈ 60,
`dllset.py` ≈ 120 (packaging tool, not runtime), scripts ≈ 40. A production helper on this stack would own:
the frame source (shared memory from the layer → appsrc), the controller policy on top of webrtcsink's
(ceilings, pins, readout), the encoder-setup tuning, the receiver → texture path (d3d11/d3d12 memory out of
decodebin3 into the layer's shared handle instead of appsink), packaging, and any patch to gst-plugins-rs
(AMF bitrate support). Signalling: WHIP maps poorly onto the companion's `MEDIA_SIGNAL` relay; the production
path would use `webrtcsink`/`webrtcsrc` with a custom `Signallable` (a GObject interface implemented in Rust
or C) over the match transport, not an HTTP endpoint.

## 8. Unfinished / caveats

- The harness is loaded from main's build (`--harness C:\code\repos\castcade\spike\d10-video\harness\build\Release\castcade_spike_harness.dll`);
  the default relative path expects `spike/d10-video/harness/build/Release/` beside this folder once the branches merge.
  The harness packs NV12 with stride = width; spike-gst attaches a `VideoMeta` so nvh264enc accepts the 1354-wide
  rows (GStreamer's default layout rounds the stride to 1356 and rejected the buffers without it).
- The 90 s protocol runs were not made here (lead's job, one GPU). Only the 20 s flat-25 Mbps smoke above.
- `amfh264enc` / `qsvh264enc` paths unverified (no such GPU here); `--encoder x264enc` forces the software path.
- `enc_cost_us_avg` is wall time through the encoder element, not the harness's `spike_encoder_last_cost_us`
  (GStreamer owns the encoder here); compare with that caveat.
