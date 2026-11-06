# Spectator video, native path (D10)

Status: proposed 2026-11-06 (the lead's answer to the owner's "what is the best way to get the highest quality,
best compatibility for weak rigs, best quality for strong ones"; the owner: "I don't care about how much time it
takes or whether we have to refactor. Quality of spectator should be a high priority. We are early enough in to
this to start over if we have to", and at the wrap: "continue with the new hardware encoding work next and get that
out the door"). ADR 0010 is drafted when the owner confirms the architecture below. Tracked as WORK D10.

## 1. What 0.2.36 measured (owner + Krobs 2026-11-05/06 UTC, ChuckRibbits 2026-11-06)

- Sender: the layer reads the eye back from the GPU and JPEG-encodes it on one thread (23–28 ms per 1354x1440
  frame, 30 fps asked) → named pipe → the hidden offscreen panel page → `canvas.captureStream` → Electron WebRTC.
  Both NVIDIA rigs logged `media: encoder: H264 via OpenH264` (software) and `limited by cpu` at 4–7.8 Mbps. The
  track's `contentHint = 'detail'` tells Chromium to keep resolution and drop frames.
- Receiver: the decoded frame → canvas → RGBA (7.8 MB a frame) over Electron IPC, one frame in flight → main →
  pipe → the layer: a ceiling of about 22 fps measured, 60–245 frames per 10 s reached the layer in the two games.
- Result: sharper than 0.2.35 and "really choppy and almost unwatchable"; the ball cannot be followed.
- Chuck's rig (AMD GPU, Quest 3, Virtual Desktop + OpenComposite, VPinballX_GL64): the layer camera on OpenGL ran at
  exactly 10 fps once idle in panel mode (cause unverified, D8.1.2). First AMD tester.
- An Electron probe (`RTCPeerConnection` loopback, profile orders 42e01f / 640032 / …) read every GPU feature as
  software, but ran under a sandbox: unverified for the installed app (D8.3.2 logs `app.getGPUFeatureStatus()`).

Three bottlenecks, all in the Electron detour: software H.264, a JPEG round trip and a 7.8 MB IPC copy per frame.

## 2. Target

The player up's eye at up to its rendered size, 60 fps where the rig holds it, 2–20 Mbps, glass to glass well under
200 ms on a typical home path; a weaker rig or link steps down in frame rate and resolution by itself and never
stalls; the watcher sees what arrives (size, fps, kbps, encoder) and the sender can pin a rung by hand.

## 3. Architecture

1. **Encode where the pixels are.** The layer (VR rigs) or a native helper (non-VR rigs, Windows Graphics Capture of
   the VPX window) scales the eye on the GPU and hands NV12 frames to FFmpeg libavcodec: `h264_nvenc` / `hevc_nvenc`,
   `h264_amf`, `h264_qsv`, then `libx264` / OpenH264 (`ultrafast`, `zerolatency`) as the fallback; probed once at
   start, the choice logged. No JPEG, no canvas.
2. **Transport from C++.** A native helper (`castcade-video.exe`, the sibling of `castcade-audio.exe`) runs a
   standard WebRTC peer with libdatachannel (ICE / DTLS / SRTP, H.264 packetization, no media engine); signalling
   stays the companion's `MEDIA_SIGNAL` over the match transport. The layer never opens a socket (it lives in VPX's
   process: no firewall rule and no crash there); frames go layer → helper over shared memory (the pipe first).
3. **Decode in the receiver's native side.** The helper decodes (`h264_cuvid`, `d3d11va`, `dxva2`, software fallback)
   to a texture the layer draws on the theater quad through a shared handle; no RGBA through Electron. Non-VR watchers
   keep an Electron WebRTC track or a helper-drawn window (D8.4, D8.5 decide).
4. **Ladder, six rungs** (provisional; about 0.1 bits a pixel a frame): 1354x1440 at 60 fps 20 Mbps · 1354x1440 at
   30 fps 10 · 1016x1080 at 60 fps 8 · 1016x1080 at 30 fps 5 · 677x720 at 60 fps 4 · 677x720 at 30 fps 2. Temporal
   layers (L1T2 / L1T3) so a receiver can halve the frame rate without a sender change.
5. **Controller.** Inputs: encoder queue depth, sent fps against captured, RTCP receiver reports (loss, RTT), the
   bandwidth estimate (TWCC / REMB), the receiver's decode fps. Down one rung after 3 s of sustained trouble, up one
   after 30 s clean; the host sets a match-wide ceiling (D8.2); a manual pin per sender; a live readout on the Match
   tab and in the headset panel. Starting rung from a 5 s uplink probe at match start.
6. **Voice** stays on Electron WebRTC (it works; the ducking is D2.11).
7. **Install stays one installer** (ADR 0007: no "enable spectator mode" checkbox): the helper is bundled like the
   audio helper; NSIS adds its firewall rule; the layer is registered as today.
8. **No router setup for players:** ArcAid as the rendezvous (F6), STUN, a TURN relay of ours (F23), an optional
   UPnP / NAT-PMP mapping of the host's port offered as one click; a connectivity line on the Match tab. An SFU of
   ours for tournaments (D9).

## 4. Build order (WORK D10.x)

| Step | Delivers | Gate |
|---|---|---|
| D10.0 | ADR 0010; this doc confirmed; MSVC Build Tools + CMake on the dev machine (E7) | the owner says go |
| D10.1 | `castcade-video.exe`: FFmpeg libavcodec linked (pinned, sha256, CI-built like the audio helper), encoder probe, `--bench` on synthetic 1354x1440 frames logging encoder, fps, ms a frame | NVENC on both NVIDIA rigs, AMF on Chuck's, software everywhere |
| D10.2 | Layer → helper frames: GPU scale, NV12 readback (D3D11 staging ring, OpenGL PBO), shared-memory ring; JPEG path kept as the fallback | 60 fps readback under 3 ms a frame on the owner's rig |
| D10.3 | libdatachannel sender in the helper on the companion's signalling, H.264 packetization, the ladder, bitrate from TWCC | a match at rung 1 between the owner and Krobs |
| D10.4 | Receiver decode in the helper → texture → the theater quad; desktop fallback | 60 fps on the screen, no Electron copy |
| D10.5 | Controller, readout, manual pin, host ceiling (absorbs D8.2) | the owner dials in by hand, then lets it run |
| D10.6 | Non-VR sender: Windows Graphics Capture of the VPX window in the helper | a desktop rig sends at rung 3 |
| D10.7 | Rig gates on NVIDIA x2 + AMD; the Electron video path removed | the owner follows the ball |

## 5. Risks

- FFmpeg with NVENC / AMF / QSV needs `nv-codec-headers`, the AMF SDK and libvpl at build time: pin each by tag and
  sha256 in the CI workflow as the OpenXR headers are; the GPL offer (E5) extends to the helper's static FFmpeg.
- libdatachannel brings OpenSSL and libjuice: CI build time, and the first C++ networking in the repo.
- Chuck's OpenGL VPX needs the GL readback path from day one; OpenComposite / Virtual Desktop quirks are found on
  rigs only.
- Nothing native compiles on the dev machine today (E7): every fix is a CI round until the toolchain is installed.
- The Electron path stays shippable for one release as the fallback; it is removed in D10.7, not before.
