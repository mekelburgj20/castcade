# D10.0.1 — the spectator-video stack spike

Owner ruling 2026-11-06: the stack under `castcade-video.exe` is chosen by measurement, not argument
(`docs/design/spectator-video-native.md` §3a; the result is ADR 0010). Scratch code: nothing here ships.

The same loopback sender three ways, each sending the harness's synthetic 1354x1440 60 fps playfield
through a bandwidth shaper to a loopback receiver:

| Folder | Candidate | Encoder |
|---|---|---|
| `harness/` | shared: frame source, libavcodec encoder (NVENC → AMF → QSV → x264), decoder, clock (C ABI dll) | — |
| `shaper/` | shared: UDP token-bucket shaper the candidates route their ICE through (Node, no deps) | — |
| `str0m/` | Rust + str0m | harness dll |
| `libwebrtc/` | prebuilt libwebrtc (LiveKit webrtc-sdk) from C++, custom encoder factory; Rust `libwebrtc` crate as the fallback | harness dll (fallback: the library's own) |
| `gstreamer/` | GStreamer webrtcsink / webrtcsrc | `nvh264enc` (its own) |
| `results/` | one JSON per run + `RESULTS.md`, the numbers ADR 0010 cites | — |

## The protocol every candidate runs (90 s)

0–30 s: shaper cap 25 Mbps · 30–50 s: 2 Mbps · 50–90 s: 25 Mbps. Target 60 fps at 1354x1440, ladder top 20 Mbps.
(Changed 2026-11-07 from 20 Mbps caps: the first str0m smoke showed the top rung sitting exactly on the cap leaves no room
for RTP/RTX/probe overhead and the shaper's queue stayed full at 150 ms; a 25 Mbps cap is Krobs' real uplink and gives the
20 % headroom every stack assumes.) The GPU is otherwise idle during a run and down-clocks to P8 after ~8 s of encode-only
load (encode cost 3.7 → 10 ms, still inside 16.7 ms); every candidate runs under the same condition and `enc_cost_us_avg`
records it; in the product VPX keeps the GPU in P0.
Each candidate's receiver logs one line a second: `t, frames_delivered, fps, kbps_received, decode_ok, freeze_ms_max`
and the sender: `t, encoder, fps_sent, kbps_sent, target_kbps, enc_cost_us_avg, rtt_ms, loss_pct, bwe_kbps`.
Reported per candidate: encoder chosen · fps held in the first 30 s · longest freeze after the drop ·
seconds from 30 s until the picture is steady again (no freeze > 500 ms) · seconds from 50 s until ≥ 55 fps
at ≥ 15 Mbps again · release binary size · lines of code we own (`tokei`-style count of the candidate folder).

The measurement runs are made by the lead, one candidate at a time (one GPU). Workers build and smoke-test.
