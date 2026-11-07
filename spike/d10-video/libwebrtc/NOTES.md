# D10.0.1 — libwebrtc candidate: notes

Rung reached: **rung 1 (C++ against LiveKit's prebuilt libwebrtc), with our encoder plugged in.** Rung 2
(the Rust `libwebrtc` crate) was not needed. Scratch code: nothing here ships.

## What this is

`spike-libwebrtc.exe` runs a sender and a receiver PeerConnection in one process. The sender pushes the
harness's NV12 frames into a `VideoTrackSource`; a `VideoEncoderFactory` of ours hands each frame to
`spike_encoder_encode` (libavcodec NVENC → AMF → QSV → x264, probed by the harness) and returns the Annex B
access unit to libwebrtc as an `EncodedImage` (H264 packetization mode 1; libwebrtc's own packetizer
splits the NAL units). libwebrtc does the rest: pacing, congestion control (GCC with transport-wide
feedback), NACK/RTX, the jitter buffer, key-frame requests. The receiver decodes with a
`VideoDecoderFactory` wrapping the harness decoder (h264_cuvid → d3d11va → software), reads the burned-in
frame counter, and the renderer stand-in (a `VideoSinkInterface`) counts delivered frames and freezes.

Each side binds exactly one UDP port on exactly one network (a `NetworkManagerBase` subclass that reports
only 127.0.0.1/8), so each SDP carries exactly one host candidate; trickle candidates are never exchanged.

## Fetch / build / run (from the repo root)

```powershell
pwsh spike/d10-video/libwebrtc/fetch-webrtc.ps1        # 114 MB zip → spike/d10-video/deps/webrtc/ (sha256-checked)
cmake -S spike/d10-video/libwebrtc -B spike/d10-video/libwebrtc/build -A x64
cmake --build spike/d10-video/libwebrtc/build --config Release
spike\d10-video\libwebrtc\build\Release\spike-libwebrtc.exe --no-harness --duration 15                 # bring-up: OpenH264 in, FFmpeg H264 out
spike\d10-video\libwebrtc\build\Release\spike-libwebrtc.exe --duration 90                              # harness DLL from ..\harness\build\Release\
spike\d10-video\libwebrtc\build\Release\spike-libwebrtc.exe --shaper-s 40001 --shaper-c 40002 --duration 90   # through the shaper
```

`--help` lists every flag. Defaults: 1354x1440 @ 60 fps, bitrate envelope 1000..20000 kbps starting at 8000,
UDP ports 50100 (sender) / 50200 (receiver), the `WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/` field trial
on (the receiver renders as soon as a frame is complete; `--no-zero-playout-delay` turns it off),
`has_trusted_rate_controller = true` (libwebrtc does not run its own frame dropper on top of NVENC's CBR;
`--untrusted-rc` flips it). CSVs land in `spike/d10-video/results/<timestamp>-libwebrtc-{sender,receiver}.csv`.

Harness lookup order when `--harness` is not given: `<exe>\..\..\..\harness\build\Release\castcade_spike_harness.dll`
(i.e. `spike/d10-video/harness/build/Release/`), then `<exe>\..\harness\build\Release\`, then the same path
relative to the cwd. Not found → falls back to `--no-harness` with a warning. The DLL is loaded with
`LoadLibraryEx(..., LOAD_WITH_ALTERED_SEARCH_PATH)` so the FFmpeg DLLs beside it resolve; nothing links its
import library (the function pointers are bound by name, typed with `decltype` off `spike_harness.h`).

### Shaper routing rule as implemented

The offer (sender → receiver) keeps one host UDP candidate with its port replaced by `--shaper-c` (the shaper
port **facing the receiver**: the receiver sends to it); the answer (receiver → sender) keeps one with
`--shaper-s` (the port facing the sender). If the shaper's convention is the other way round, swap the two
assignments in `main.cpp` (`to_receiver.shaper_port` / `to_sender.shaper_port`). The real ports stay what
`--port-s/--port-c` say, so the shaper forwards shaper-c → 127.0.0.1:50200 and shaper-s → 127.0.0.1:50100.

## The prebuilt: what it is and how it was built

- **Asset**: `webrtc-win-x64-release.zip` from the `livekit/rust-sdks` release **`webrtc-a545de4`** (2026-10-23),
  114,348,165 bytes, sha256 `862403fcb248c7d8803487e4c22b8821c6130e89100cb9c69be95ef45ff46146`. This is the
  binary the `libwebrtc` crate 0.4.0 downloads (`webrtc-sys-build` 0.3.21 pins `WEBRTC_TAG = "webrtc-a545de4"`).
- **Why not `webrtc-sdk/webrtc-build` m150.7871.05**: that repo stopped publishing Windows zips after
  m104 (2023). Its releases since carry only `LiveKitWebRTC*.xcframework.zip` (Apple) and `webrtc.tar.gz`
  (Android); its `build.yml` builds Apple + Android only. The Windows builds moved to `livekit/rust-sdks`
  (`.github/workflows/webrtc-builds.yml`, `webrtc-sys/libwebrtc/build_windows.cmd`), tagged `webrtc-<sha>`.
  m150.7871.05's `build/VERSION` is M150.7871@{#5}, commit a802fa98; the rust-sdks tag a545de4 is a
  `webrtc-sdk/webrtc` commit of the same M150 line (the headers say M150 everywhere).
- **How it was built** (`build_windows.cmd`, confirmed by the zip's `args.gn`): `is_debug=false is_clang=true
  target_cpu="x64" use_custom_libcxx=false rtc_libvpx_build_vp9=true enable_libaom=true rtc_include_tests=false
  rtc_build_examples=false rtc_build_tools=false is_component_build=false rtc_enable_protobuf=false
  rtc_use_h264=true ffmpeg_branding="Chrome" symbol_level=0 enable_iterator_debugging=false`, i.e. **clang-cl**
  (`CR_CLANG_REVISION=llvmorg-23-init-10931`), **MSVC's STL** (no custom libc++), **static CRT `/MT`** (every
  object in `webrtc.lib` carries `/DEFAULTLIB:libcmt.lib` + `libcpmt.lib`; `dumpbin /DIRECTIVES`), no RTTI,
  no exceptions (`_HAS_EXCEPTIONS=0`), release, no symbols. Patches LiveKit applies: `add_licenses`,
  `add_deps`, `ssl_verify_callback_with_native_handle`, `external_audio_source` (none touch the video path).
- **Zip layout**: `win-x64-release/{args.gn, webrtc.ninja, desktop_capture.ninja, LICENSE.md, lib/webrtc.lib,
  include/**}` — 38,755 files, 359 MB of headers (the whole `src/*.h` tree incl. third_party), one static lib.
- **Sizes**: `webrtc.lib` **89,350,204 bytes** (85.2 MiB). Our release exe `spike-libwebrtc.exe`
  **18,825,216 bytes** (18.0 MiB) — that is what the linker keeps of libwebrtc for a full peer connection with
  H264/VP8/VP9/AV1 codecs, audio engine, dummy ADM, ICE/DTLS/SRTP, stats. `castcade-video.exe` would be in
  that range (the audio engine and the software codecs could be trimmed by not linking their factories).

## Build flags that worked (CMake, MSVC `cl.exe` 19.44, not clang-cl)

- Defines: the first line of `webrtc.ninja` (`defines = -D... `), 52 of them, read by CMake and applied
  verbatim minus `CR_CLANG_REVISION` — exactly what LiveKit's `webrtc-sys/build.rs` does. The ones that matter
  for ABI: `WEBRTC_WIN NOMINMAX WIN32_LEAN_AND_MEAN _HAS_EXCEPTIONS=0 _HAS_NODISCARD _UNICODE UNICODE
  _WIN32_WINNT=0x0A00 NTDDI_VERSION=NTDDI_WIN11_GE WEBRTC_USE_H264 RTC_ENABLE_VP9 RTC_ENABLE_H265
  RTC_USE_LIBAOM_AV1_ENCODER RTC_DAV1D_IN_INTERNAL_DECODER_FACTORY WEBRTC_INCLUDE_INTERNAL_AUDIO_DEVICE
  WEBRTC_HAVE_SCTP WEBRTC_ENABLE_PROTOBUF=0 RTC_ENABLE_WIN_WGC ABSL_ALLOCATOR_NOTHROW=1
  _ENABLE_EXTENDED_ALIGNED_STORAGE WEBRTC_LIBRARY_IMPL` (+ the usual `_CRT_*` / `_SCL_*` silencers).
- Includes: `include/`, `include/third_party/abseil-cpp`, `include/third_party/libyuv/include`.
- Compiler: `/std:c++20 /EHs-c- /GR- /bigobj /utf-8 /permissive- /Zc:__cplusplus`, `/MT` (CMake
  `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`). Warnings silenced: C4244/C4267/C4996 (ours), C4530 (MSVC STL has
  `try` in `<chrono>`/`<xstring>` even with `_HAS_EXCEPTIONS=0`), C4068 (`#pragma clang` in a few headers).
- Link: `webrtc.lib` + `ws2_32 winmm secur32 iphlpapi crypt32 ole32 oleaut32 uuid dmoguids wmcodecdspuuid
  msdmo strmiids d3d11 dxgi dwmapi shcore gdi32 user32 advapi32 shell32 avrt dbghelp`.
- **MSVC against clang-cl objects linked and ran first time**: same STL, same CRT model, the same
  `[[msvc::no_unique_address]]` attribute on both compilers, abseil types in the API are header templates.
  No `/Zc:preprocessor` needed. The whole first build (configure + ~10 translation units including the
  peer connection headers) is about 90 s on the dev machine.

### What was missing from the archive (the only fight)

Four link errors, all symbols that exist in upstream libwebrtc but are not in the `:default` target LiveKit
archives; each had a one-line replacement:

| Missing | Replacement used |
|---|---|
| `webrtc::CreateBuiltinVideoEncoderFactory()` | `VideoEncoderFactoryTemplate<OpenH264…, LibvpxVp8…, LibvpxVp9…, LibaomAv1…>` (header-only; the per-codec `CreateH264Encoder` etc. are in the lib) |
| `webrtc::CreateBuiltinVideoDecoderFactory()` | `VideoDecoderFactoryTemplate<OpenH264…, LibvpxVp8…, LibvpxVp9…, Dav1d…>` |
| `webrtc::FieldTrials::FieldTrials(string_view)` | a 20-line `FieldTrialsView` subclass (LiveKit's glue does the same) |
| `webrtc::AudioDeviceModule::Create(env, layer)` | `webrtc::CreateAudioDeviceModule(env, kDummyAudio)` from `api/audio/create_audio_device_module.h` |

Everything else used (`CreateModularPeerConnectionFactory` + `EnableMedia`, `BasicPortAllocator` via
`PeerConnectionFactoryDependencies::network_manager`, `NV12Buffer`, `EncodedImage`, `VideoTrackSource`,
`VideoBroadcaster`, the stats objects, `InitializeSSL`) was there.

## What libwebrtc's API made easy, and what it fought

Easy:
- **Plugging in our encoder**: `VideoEncoderFactory::Create(env, format)` → a `VideoEncoder` with
  `InitEncode / Encode / SetRates / GetEncoderInfo`. ~150 lines. `SetRates` arrives with the GCC target in
  kbps; `Encode` arrives with the frame types (key-frame request = `kVideoFrameKey`); the Annex B output goes
  back as one `EncodedImage` + `CodecSpecificInfo{H264, NonInterleaved}` and the RTP packetizer finds the NAL
  units itself. No fragmentation header to build (gone since M90). `EncoderInfo` tells the pipeline what we
  are: hardware, trusted rate control, NV12 preferred, scaling off → the stack reports
  `powerEfficientEncoder = true`, `encoderImplementation = "h264_nvenc"`.
- **Zero-copy frame path**: push `webrtc::NV12Buffer` (contiguous Y then UV, stride = width) into a
  `VideoBroadcaster`; the encoder gets the same buffer and passes `DataY()` straight to the harness. No I420
  anywhere (the I420 fallback via libyuv is in the code but never ran: `conversions_ == 0`).
- **The decoder side**: `VideoDecoder::Decode(EncodedImage)` receives complete access units after the jitter
  buffer, SPS/PPS included; the harness decoder consumes them as is. One subtlety: `Decoded()` must return a
  frame carrying the input's RTP timestamp or libwebrtc drops the bookkeeping ("too many frames backed up");
  we hand back a 16x16 black frame with the right timestamp (a small FIFO covers decoder latency).
- **Stats**: `GetStats` gives everything the CSV needs in one report: `outbound-rtp.targetBitrate /
  framesSent / bytesSent / encoderImplementation / qualityLimitationReason`, `remote-inbound-rtp.roundTripTime /
  fractionLost`, `candidate-pair.availableOutgoingBitrate` (the BWE), `inbound-rtp.jitterBufferDelay /
  freezeCount / framesDropped / decoderImplementation`.
- **Connect time**: 116–143 ms from CreateOffer to both sides `connected` (in-process, loopback).

Fought (each cost under an hour; listed so D10.1 does not rediscover them):
- **Loopback is ignored by default.** `BasicNetworkManager` enumerates every adapter and
  `network_ignore_mask` defaults to `ADAPTER_TYPE_LOOPBACK`. Fix: a `NetworkManagerBase` subclass that reports
  one 127.0.0.1/8 network (typed ETHERNET), injected through `PeerConnectionFactoryDependencies::network_manager`,
  plus `Options::network_ignore_mask = 0`. Then `RTCConfiguration::set_min_port/max_port` give the one port.
- **The send codec's parameters come from the answer.** To set `x-google-start/min/max-bitrate` the extras
  are appended to the answer's `a=fmtp` for the video PT before the sender's `SetRemoteDescription`; the
  `RtpEncodingParameters.max_bitrate_bps` on the transceiver is the belt to that brace. Start bitrate 8000
  gave the first `SetRates` at 7543 kbps; GCC was at 17.7 Mbps within the first second on loopback.
- **`final` and `make_ref_counted`** do not mix: libwebrtc wraps observers in `RefCountedObject<T>`.
- **Logging**: `LogMessage::LogToDebug(LS_WARNING)` does not silence this build's LS_INFO stream; route it
  through an own `LogSink` (`SetLogToStderr(false)` + `AddLogToStream`).
- Expected warnings: "Transmitting payload type without picture ID using NACK+ULPFEC … Disabling ULPFEC"
  (H264 has no picture id, so FEC is off; NACK/RTX stay on) and "Unable to set playout device" (dummy ADM).

## Smoke results (15 s, direct loopback, dev machine RTX 3090; the lead makes the measurement runs)

`--no-harness` (libwebrtc's OpenH264 encoder, FFmpeg H264 decoder inside libwebrtc): H264 negotiated,
60 fps in and out, 18.4–19.2 Mbps, 0 % loss, RTT 1 ms, freeze max 18–20 ms (one frame period), encode 3.7–3.9 ms
a frame on the CPU (24 cores), jitter-buffer delay 0.2–0.3 ms. Software H264 at 1354x1440@60 is feasible
on this machine but it is not the point.

Harness (`h264_nvenc` → libwebrtc → `h264_cuvid`; DLL from the harness worker's worktree, not built here):
60 fps in and out, 18.3–18.7 Mbps against a 20 Mbps cap, `targetBitrate` 18.4–18.9 Mbps, BWE pinned at the
20 Mbps max, 0 % loss, RTT 1 ms, 18 key frames in 15 s (one requested by libwebrtc, the rest the harness's
own), 887 of 887 decoded frames had a readable counter, glass-to-glass avg 26 → 37 ms over the run
(max 27–40 ms; the first second 239 ms while cuvid warmed up), 3 frames dropped at start, no freezes. Tail:

```
S 13.0,h264_nvenc,60,18527,18724,10693,1.0,0.00,20000,773,none,0,0,video/H264,h264_nvenc
R 13.0,766,59,18527,1,20,36.9,39.0,0.3,0,0,5,0,h264_cuvid
S 14.0,h264_nvenc,60,18370,18560,10263,1.0,0.00,20000,833,none,0,0,video/H264,h264_nvenc
R 14.0,827,61,18370,1,21,36.9,40.2,0.4,0,0,5,0,h264_cuvid
S 15.0,h264_nvenc,60,18283,18464,10617,1.0,0.00,20000,893,none,0,0,video/H264,h264_nvenc
R 15.0,887,60,18283,1,20,36.8,39.3,0.3,0,0,5,0,h264_cuvid
```

Observation for the harness worker / the lead, not a libwebrtc property: `enc_cost_us_avg` (the harness's
own avcodec timing) climbed from 3.7 ms to 10.6 ms a frame over 15 s in both harness runs, and glass-to-glass
climbed with it. The GPU was otherwise idle (nvidia-smi: encoder 0 %, SM 210 MHz between runs). Worth a
look at NVENC clocks / the harness's CBR settings before the 90 s runs; the transport side (`kbps_sent`,
fps, jitter buffer) stayed flat.

## CSV columns

Sender: the README's `t, encoder, fps_sent, kbps_sent, target_kbps, enc_cost_us_avg, rtt_ms, loss_pct, bwe_kbps`
then extras `frames_encoded, quality_limitation, nack, pli, codec, encoder_impl_stats`.
Receiver: the README's `t, frames_delivered, fps, kbps_received, decode_ok, freeze_ms_max` then extras
`g2g_ms_avg, g2g_ms_max, jb_ms, nack, pli, frames_dropped, freeze_count, decoder`. A header row names them.
`kbps_*` count RTP payload + header bytes from `GetStats` (`bytesSent + headerBytesSent`), `fps` and
`frames_delivered` are counted at the renderer sink (after the jitter buffer), `freeze_ms_max` is the longest
gap between delivered frames in that second (a freeze still running counts), `g2g` is measured from the frame
counter the harness decoder reads back (harness clock, both ends in one process), `decode_ok` is 1 when the
harness decoder returned no error that second. `-1` = not available in this mode.

## How CI would build it (`.github/workflows/audio-helper.yml` as the template)

windows-latest, `cmake -A x64`, Release — the same three steps as the audio helper plus one fetch:

```yaml
- run: pwsh spike/d10-video/libwebrtc/fetch-webrtc.ps1     # 114 MB from the livekit/rust-sdks release, sha256-checked
- run: cmake -S spike/d10-video/libwebrtc -B spike/d10-video/libwebrtc/build -A x64
- run: cmake --build spike/d10-video/libwebrtc/build --config Release
- run: spike/d10-video/libwebrtc/build/Release/spike-libwebrtc.exe --no-harness --duration 5   # software codecs only on CI
```

The download would be cached by `actions/cache` keyed on the tag + sha256 (one zip, no toolchain: the
headers are plain, the lib is static). What keeps building: LiveKit cuts a `webrtc-<sha>` release for every
libwebrtc bump (M137 → M144 → M150 over 2025–26); bumping means a new tag + sha256 in `fetch-webrtc.ps1`
and re-reading `webrtc.ninja` (automatic). Risk to carry: the four missing symbols show LiveKit archives
only what their Rust glue needs; a future bump can drop another convenience symbol, and the fix is the same
shape (use the lower-level creator, or copy the 20 lines).

For `castcade-video.exe` the same recipe applies; the only addition is the FFmpeg shared build the companion
already pins (the harness's encoder) and its GPL offer (E5).

## Lines of code we own

`git ls-files spike/d10-video/libwebrtc | xargs wc -l`: 1,956 lines including this file; **1,767 lines of
code and build** — 1,675 in `src/`
(`main.cpp` 514, `peer.cpp` 432, `codecs.cpp` 352, `sdp.cpp` 99, `peer.h` 91, `harness.cpp` 74, `codecs.h` 62,
`harness.h` 33, `sdp.h` 18), `CMakeLists.txt` 62, `fetch-webrtc.ps1` 30. Of the C++, about 320 lines are the
measurement rig (CSV loop, arg parsing, synthetic frame, stats flattening) rather than transport glue.

## Not done / open

- Rung 2 (Rust `libwebrtc` crate) was not attempted: rung 1 built and ran, so there was nothing to fall back to.
- Temporal layers (L1T2/L1T3): `EncoderInfo.fps_allocation` is single-layer here; the harness's encoder has
  no temporal-layer control, so libwebrtc's `temporal_idx` would have to be synthesised from the GOP pattern.
  libwebrtc's H264 path supports `temporal_idx` in `CodecSpecificInfoH264`.
- The shaper port convention is implemented one way (above); flip if the shaper says otherwise.
- Not measured here: the 20 → 2 → 20 Mbps protocol (the lead's run), AMF/QSV encoders (no such GPU here).
