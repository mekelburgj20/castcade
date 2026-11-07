# ADR 0010 — The stack under `castcade-video.exe`, chosen by the D10.0.1 spike

**Status:** Accepted (2026-11-07, owner: "I accept ADR 0010").
**Owner ruling:** 2026-11-06, on the lead's recommendation: the WebRTC stack and the language of the native video
helper are chosen by a two-day spike, not by argument; whichever holds 60 fps at 1354x1440 and recovers within 3 s of
a bandwidth drop with the least code we own wins. The layer stays C++ in every outcome; Go is reserved for the SFU (D10.9).
**Builds on:** ADR 0003 (one desktop app), ADR 0007 (functionality before ease of setup), ADR 0009 (spectating is 2D).
**Design:** `docs/design/spectator-video-native.md` §3 (the architecture that is fixed whichever stack wins) and §3a
(the candidates). **Code and numbers:** `spike/d10-video/` (README = the protocol; `results/RESULTS.md` = every run).

## Context

0.2.36 sends the player up's eye as JPEG → canvas → Chromium's OpenH264 → RGBA over IPC; both NVIDIA rigs logged
`H264 via OpenH264` and `limited by cpu` at 4–7.8 Mbps (D8.3.1), and the Electron sender cannot hold 30 fps at any
size. D10 moves capture, encode, transport and decode into native code (the layer and a helper). The transport
library underneath decides the quality: congestion control, pacing, retransmission, the receive buffer. Three
candidates were built the same way, each sending the same synthetic 1354x1440 60 fps picture through the same UDP
shaper to a loopback receiver: Rust + str0m with our libavcodec NVENC encoder; prebuilt libwebrtc (LiveKit's
webrtc-sdk) with the same encoder plugged in as an encoder factory; GStreamer with its own `nvh264enc` and WebRTC
elements. Prediction on record before the runs: libwebrtc wins on quality, Rust + str0m on simplicity, quality takes it.

## Method

`spike/d10-video/README.md`: 90 s a run, the shaper at 25 Mbps for 30 s, 2 Mbps for 20 s, 25 Mbps for 40 s (the ladder's top rung is 20 Mbps; 25 is Krobs' uplink);
the receiver logs frames, fps, kbps and the longest freeze each second. Reported: encoder chosen, fps held in the
first 30 s, longest freeze after the drop, seconds to a steady picture after the drop, seconds to ≥ 55 fps at
≥ 15 Mbps after the restore, release binary size, lines of code we own. Runs by the lead, one candidate at a time,
on the owner's rig (RTX 3090, driver 616.56).

## Results

Six runs on 2026-11-07 (two per candidate, back to back, GPU otherwise idle), `spike/d10-video/results/`. Phase 1 = the
25 Mbps cap (5–30 s), phase 2 = the 2 Mbps cap (30–50 s), phase 3 = 25 Mbps again (50–90 s). "Settle" = seconds after
the drop until five consecutive seconds without a freeze over 500 ms; "recover" = seconds after the restore until
three consecutive seconds at ≥ 55 fps and ≥ 15 Mbps.

| Candidate | Encoder | fps phase 1 (median / min) | Mbps phase 1 / 2 / 3 | Longest freeze after the drop | Settle | Recover | Seconds with nothing decodable | Binary | LOC we own |
|---|---|---|---|---|---|---|---|---|---|
| Rust + str0m 0.25 | h264_nvenc (ours) | 60 / 59 · 60 / 59 | 20.0 / 1.4 / 12.5 · 20.0 / 1.4 / 13.3 | 3.0 s · 5.1 s | 7 s · 8 s | 21 s · 18 s | 4 · 5 | 6.1 MB | 1426 (+ harness 621) |
| libwebrtc M150, LiveKit prebuilt, C++ | h264_nvenc (ours, via `VideoEncoderFactory`) | 60 / 58 · 60 / 58 | 18.4 / 1.9 / 7.7 · 18.4 / 1.9 / 9.1 | 1.8 s · 1.8 s | 4 s · 3 s | 33 s · 30 s | 0 · 0 | 18.0 MB (85 MB static lib) | 1767 (+ harness 621; ~320 is measurement rig) |
| GStreamer 1.28.8, webrtcsink / WHIP | nvh264enc (its own) | 60 / 7 · 60 / 13 | 15.5 / 1.3 / 5.8 · 14.7 / 1.5 / 5.6 | 1.0 s · 1.6 s | 2 s · 2 s | never (12.6 and 13.5 Mbps at 89 s) | 1 · 0 | 0.4 MB exe + 47.7 MB of DLLs (NVIDIA-only set; 73 MB with fallbacks) | ~860 (+ 114 packaging tool) |

What the rows mean:

- **Before the drop** all three hold 60 fps. str0m sits exactly on the 20 Mbps rung (its delay-based estimate kept
  rising while the shaper's queue was full; only loss pulled it back); libwebrtc's GCC settles at 18.4 Mbps, leaving
  the headroom a real link needs; GStreamer's GCC sits at 15 Mbps **after** a start-up overshoot that fills the queue
  and costs 7–13 fps seconds at t = 3–6 s in both runs (no padding to probe with: this build's `rtprtxsend` lacks
  `stuffing-kbps`, so webrtcsink disables stuffing).
- **At the drop** (25 → 2 Mbps, twelvefold, harsher than a real link) the picture freezes on every stack; libwebrtc for
  1.8 s both times and steady within 3–4 s with no second of undecodable video; str0m for 3–5 s (its estimate stayed
  near 20 Mbps for 3 s, then collapsed to 130–220 kbps; the receiver had a 5 s hole in run 2) and steady after 7–8 s;
  GStreamer for 1.0–1.6 s and steady after 2 s.
- **After the restore** none meets 3 s; the controller the design specifies steps up one rung after 30 s clean, so
  18–33 s is inside the design. str0m climbs fastest (18–21 s), libwebrtc reaches 15 Mbps at 30–33 s and 18.4 Mbps by
  85 s, GStreamer climbs linearly from 1.5 to 13 Mbps over 40 s and never reaches 15.
- **Decode and latency**: libwebrtc delivered every frame decodable with the counter read back (glass to glass 29 ms
  steady, 36–45 ms while ramping); str0m had 4–5 seconds with nothing decodable per run; GStreamer 0–1.
- **Encode cost** climbed from 3.7 to about 10 ms a frame in every run: the GPU down-clocks to P8 under encode-only
  load (nvidia-smi); same for all three, inside 16.7 ms, and absent when VPX keeps the GPU busy (D10.1.2).
- **Build**: libwebrtc linked with MSVC first time from the 114 MB LiveKit zip (defines read from its `webrtc.ninja`;
  four convenience symbols re-supplied in 40 lines); str0m is a plain cargo build (pure-Rust DTLS/SRTP, 86 s cold);
  GStreamer needs a 517 MB installer (unpacked without admin via Inno Setup's `/portable=1`, 2 GB devel / 370 MB
  runtime), ships 48–73 MB of DLLs, `webrtcsink` has no AMF in its congestion-control list (Chuck's rig would run
  uncontrolled or need a patched gst-plugins-rs), and its signaller would be rewritten over `MEDIA_SIGNAL`.
- **Fairness caveats**: str0m's bitrate policy is ours (apply a new estimate on a ≥ 10 % change at most once a second,
  drops of ≥ 30 % at once), written because libavcodec's NVENC wrapper forces an IDR on every bitrate change (D10.1.1);
  libwebrtc and GStreamer drive the encoder from inside the stack. The shaper's clock starts on the first forwarded
  datagram, so its `t` runs about 0.2 s behind the candidates'.

## Decision

**libwebrtc, Google's library from LiveKit's prebuilt `webrtc-win-x64-release` (tag `webrtc-a545de4`, M150), from
C++, with our libavcodec encoder plugged in as a `VideoEncoderFactory` and our decoder as a `VideoDecoderFactory`.**
`castcade-video.exe` (D10.1) is written on it. The prediction on record held: libwebrtc on quality. The simplicity
case for str0m did not materialise (1426 lines against 1767 with a third of the latter measurement rig, and the
congestion controller, the part that decides the quality, would be ours to tune); its freezes at the drop are two to
three times libwebrtc's and it loses whole seconds of decodable video. GStreamer settles fastest at the drop but pays
with start-up freezes, no ramp-up, a 48–73 MB runtime, a 2 GB build dependency, and an AMF gap that touches a tester
rig we have.

Costs accepted with libwebrtc: an 18 MB helper (an 85 MB static lib behind it), LiveKit's release cadence as our
upstream (a bump = new tag + sha256 in `fetch-webrtc.ps1`; a future archive may drop another convenience symbol, the
fix is the same 10-line shape), and a slow ramp-up (30 s to 15 Mbps) to work on in D10.5 (ALR probing / field
trials, or the controller's own up-step).

## Consequences

- D10.1 builds `castcade-video.exe` from `spike/d10-video/libwebrtc/` (CMake, `fetch-webrtc.ps1`, the encoder and
  decoder factories, the loopback network manager replaced by real ICE on the companion's signalling). CI as
  `audio-helper.yml`: windows-latest, fetch (cached by tag + sha), `cmake -A x64`, Release.
- The encoder front stays libavcodec (NVENC → AMF → QSV → software), the harness's `harness.cpp` as the seed; the
  pinned FFmpeg shared build (BtbN n8.1) joins the GPL offer (E5).
- The str0m and GStreamer candidates stay under `spike/d10-video/` as the record; nothing from them ships. The shaper
  and `measure.mjs` stay as the regression bench for D10.3–D10.5.
- Open from the spike, filed as WORK items: D10.1.1 (the NVENC wrapper's IDR on every rate change), D10.1.2 (GPU
  P-state in the bench), D10.1.3 (ramp-up after a restore), E7.1 (the fetch scripts' `--from` path).
