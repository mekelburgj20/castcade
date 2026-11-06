# Spectator video, native path (D10)

Status: direction accepted 2026-11-06 (the owner: "I don't care about how much time it takes or whether we have
to refactor. Quality of spectator should be a high priority. We are early enough in to this to start over if we
have to"; at the wrap: "continue with the new hardware encoding work next and get that out the door"). **The stack
and the language are chosen by the spike in §3a, not by this doc**; ADR 0010 records the spike's result. Tracked as
WORK D10.

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
What makes Chromium's video smooth when it is smooth (the receive buffer, retransmission, pacing, congestion
control) is not the problem; the encoder and the frame path are.

## 2. Target

The player up's eye at up to its rendered size, 60 fps where the rig holds it, 2–20 Mbps, glass to glass well under
200 ms on a typical home path; a weaker rig or link steps down in frame rate and resolution by itself and never
stalls; the watcher sees what arrives (size, fps, kbps, encoder) and the sender can pin a rung by hand.

## 3. Architecture (fixed, whichever stack wins)

1. **Encode where the pixels are.** The layer (VR rigs) or a native helper (non-VR rigs, Windows Graphics Capture of
   the VPX window) scales the eye on the GPU and hands NV12 frames to a hardware encoder: NVENC, AMF, QSV, then a
   software H.264 as the fallback; probed once at start, the choice logged. No JPEG, no canvas. FFmpeg libavcodec is
   the expected encoder front (NVENC and AMF are loaded at run time from the driver, so the shared FFmpeg build the
   companion already pins can serve; the GPL offer E5 extends to it).
2. **Transport in a native helper.** `castcade-video.exe`, the sibling of `castcade-audio.exe`, runs a standard WebRTC
   peer; signalling stays the companion's `MEDIA_SIGNAL` over the match transport. The layer never opens a socket
   (it lives in VPX's process: no firewall rule and no crash there); frames go layer → helper over shared memory
   (the pipe first). Standard WebRTC keeps the door open to browser watchers (D3), the tournament stream (D5) and an
   SFU (D10.9).
3. **Decode in the receiver's native side.** The helper decodes (NVDEC / D3D11VA / software) to a texture the layer
   draws on the theater quad through a shared handle; no RGBA through Electron. Non-VR watchers keep an Electron
   WebRTC track or a helper-drawn window (D8.4, D8.5 decide).
4. **Ladder, six rungs** (provisional; about 0.1 bits a pixel a frame): 1354x1440 at 60 fps 20 Mbps · 1354x1440 at
   30 fps 10 · 1016x1080 at 60 fps 8 · 1016x1080 at 30 fps 5 · 677x720 at 60 fps 4 · 677x720 at 30 fps 2. Temporal
   layers (L1T2 / L1T3) so a receiver can halve the frame rate without a sender change.
5. **Controller.** Inputs: encoder queue depth, sent fps against captured, RTCP receiver reports (loss, RTT), the
   stack's bandwidth estimate, the receiver's decode fps. Down one rung after 3 s of sustained trouble, up one
   after 30 s clean; the host sets a match-wide ceiling (D8.2); a manual pin per sender; a live readout on the Match
   tab and in the headset panel. Starting rung from a 5 s uplink probe at match start.
6. **Voice** stays on Electron WebRTC (it works; the ducking is D2.11).
7. **Install stays one installer** (ADR 0007: no "enable spectator mode" checkbox): the helper is bundled like the
   audio helper; NSIS adds its firewall rule; the layer is registered as today.
8. **No router setup for players:** ArcAid as the rendezvous (F6), STUN, a TURN relay of ours (F23), an optional
   UPnP / NAT-PMP mapping of the host's port offered as one click; a connectivity line on the Match tab. An SFU of
   ours for tournaments (D9).

## 3a. The stack is chosen by a spike (owner 2026-11-06, D10.0.1)

The language is the smaller decision; the WebRTC stack underneath (congestion control, receive buffer,
retransmission, pacing) and the encoder path decide the quality, and the language follows the stack. Candidates:

| Stack | Off the shelf | Written by us | Cost |
|---|---|---|---|
| C++ + libdatachannel | ICE, DTLS, SRTP, RTP packetization | encoder glue, frame path, bandwidth estimation, retransmission policy, receive buffer, controller | deps vendored by hand in CMake; the most code we own |
| Rust + str0m (or webrtc-rs) | the above plus bandwidth estimation and NACK; packet reordering | encoder glue, frame path, controller | cargo-managed deps; the FFI glue is unsafe Rust either way |
| Go + Pion | the most complete non-Google library: congestion control, simulcast, interceptors | encoder glue and D3D11 capture through cgo (the weak spot) | strong networking, poor Windows graphics story; the natural choice for the SFU (D10.9), not the helper |
| libwebrtc (Google's library, prebuilt binaries such as LiveKit's webrtc-sdk, from Rust or C++) | everything Chromium has: congestion control, jitter buffer, NACK, FEC, pacing, temporal layers | an encoder factory calling FFmpeg, the frame path, the controller | a 20 MB library; a hard build if the prebuilt binaries do not fit; standalone bindings thinly documented |
| GStreamer (webrtcsink / webrtcsrc, nvh264enc / amfh264enc / qsvh264enc, D3D11 capture) | the whole pipeline: capture, hardware encoder selection, scaling, WebRTC with congestion control, decode | a shared-memory source for the layer's frames, the controller's policy, packaging | 50–150 MB of runtime in the installer; pipeline debugging is its own skill; the Rust plugins' Windows binaries need checking |
| Sunshine / Moonlight | capture + NVENC / AMF / QSV, GPL, proven low latency | its protocol and client are Moonlight's, outside our signalling and theater | a reference for encoder settings, not a base |

**The spike (two days):** build the same thing three ways, the owner's eye at 1354x1440 encoded on the GPU and sent
to a loopback receiver, on Rust + str0m, on prebuilt libwebrtc (Rust or C++), and on GStreamer. Measure: the encoder
chosen, fps held, bitrate and recovery time under a forced bandwidth drop, binary size, lines of code we own.
Whichever holds 60 fps and recovers within 3 s with the least code we own wins; ADR 0010 records the result and
the rest of D10 is built on it. Prediction on record: libwebrtc wins on quality, Rust + str0m on simplicity; quality
takes it. Go is reserved for the SFU. The layer stays C++ in every outcome (a C-ABI DLL inside VPX with three rigs'
quirks already ironed out; its D10 change is the NV12 readback and the shared-memory ring).

## 4. Build order (WORK D10.x)

| Step | Delivers | Gate |
|---|---|---|
| D10.0 | E7 (MSVC Build Tools + CMake, plus rustup if Rust is in the spike) on the dev machine; this doc confirmed | the owner says go (done 2026-11-06) |
| D10.0.1 | The spike of §3a: three loopback senders, the measurements, ADR 0010 | the numbers in ADR 0010; the stack named |
| D10.1 | `castcade-video.exe` on the winning stack: encoder probe (nvenc → amf → qsv → software), `--bench` on synthetic 1354x1440 frames logging encoder, fps, ms a frame; CI-built like the audio helper | NVENC on both NVIDIA rigs, AMF on Chuck's, software on CI |
| D10.2 | Layer → helper frames: GPU scale, NV12 readback (D3D11 staging ring, OpenGL PBO), shared-memory ring; JPEG path kept as the fallback | 60 fps readback under 3 ms a frame on the owner's rig |
| D10.3 | The native sender on the companion's signalling, the ladder, bitrate from the stack's estimate | a match at rung 1 between the owner and Krobs |
| D10.4 | Receiver decode in the helper → texture → the theater quad; desktop fallback | 60 fps on the screen, no Electron copy |
| D10.5 | Controller, readout, manual pin, host ceiling (absorbs D8.2) | the owner dials in by hand, then lets it run |
| D10.6 | Non-VR sender: Windows Graphics Capture of the VPX window in the helper | a desktop rig sends at rung 3 |
| D10.7 | Rig gates on NVIDIA x2 + AMD; the Electron video path removed | the owner follows the ball |

## 5. Risks

- Each candidate's Windows build is unproven here: a prebuilt FFmpeg with NVENC / AMF / QSV, prebuilt libwebrtc
  binaries, GStreamer's Rust plugins. The spike exists to surface this before anything is built on it.
- Chuck's OpenGL VPX needs the GL readback path from day one; OpenComposite / Virtual Desktop quirks are found on
  rigs only.
- Nothing native compiles on the dev machine today (E7): every fix is a CI round until the toolchain is installed.
- The Electron path stays shippable for one release as the fallback; it is removed in D10.7, not before.
