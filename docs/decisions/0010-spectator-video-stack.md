# ADR 0010 — The stack under `castcade-video.exe`, chosen by the D10.0.1 spike

**Status:** Proposed (2026-11-06; the measurements are being made). Becomes Accepted when the owner reads the numbers.
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

_Filled from `spike/d10-video/results/RESULTS.md` when the runs are made._

| Candidate | Encoder | fps held | Longest freeze after drop | Settle | Recover | Binary | LOC we own | Build on CI |
|---|---|---|---|---|---|---|---|---|
| Rust + str0m | | | | | | | | |
| libwebrtc (prebuilt) | | | | | | | | |
| GStreamer | | | | | | | | |

## Decision

_Pending the numbers._

## Consequences

_Pending._ Whatever wins: D10.1 (`castcade-video.exe` skeleton, CI-built) is written on it; the losing candidates'
code stays under `spike/d10-video/` as the record and is never shipped; the encoder front (libavcodec: NVENC → AMF →
QSV → software, probed at start) is the same in every outcome unless GStreamer wins, where its own encoder elements
take that role.
