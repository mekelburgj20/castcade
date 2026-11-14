# Changelog

Release history of the Castcade companion (`companion/package.json` version, tags `v<version>`,
installers from `.github/workflows/release.yml`). The live work list is `WORK.md`; design and rulings
are in `docs/`. Entries before 0.2.4 are one-liners reconstructed from the commit log on 2026-10-21
and back-filled from the GitHub release notes on 2026-10-29 (H2).

## [Unreleased]

## [0.2.41] — 2026-11-13

### Added

- **A join link Discord makes clickable (A14.2).** A match hosted through ArcAid copies
  `https://arcaid.app/castcade/join/<code>` instead of `castcade://join/<code>`; the page (ArcAid 2.243.0) has an Open
  in Castcade button and shows the code. The chat line is the table and the link, nothing to explain. A match hosted on
  an address keeps the `castcade://` link. The Join box takes either form (`deep-link.ts`, `one-step.ts`,
  `OneStep.tsx`).
- **Castcade restarted in the middle of a match picks the match up again (A14.5).** A client that closed or
  crashed comes back into the same match, on its own ball or another player's, through ArcAid or direct; a ball end
  missed while it was closed is reported once after the rejoin. The host comes back too (same code, port and relay
  room) and its players reconnect by themselves. Restart to update during a match no longer forfeits. Under 75 s,
  or after an update restart, the rejoin is automatic; later the Match tab asks. The record is
  `<userData>/match-resume.json`, written from the match start, never in the lobby; it holds no private key and no
  pairing token. A lobby and a match that changed hosts are not saved; nothing locks the table while Castcade is
  closed (`match-resume.ts`, `match-host.ts`, `match/restart.test.ts`, `main/match-restart.test.ts`;
  docs/design/alpha-match.md §10).

- **A tester's logs can be asked for through ArcAid (E8).** When ArcAid's heartbeat answer carries a log request
  (ArcAid W99: a player presses Get logs for a paired device), the companion sends one archive: `companion.log` and
  `vr-layer.log` (each with its `.1`), the newest VR report and the six newest table journals, with a manifest.
  Never `settings.json` (the device token) or `media.json`. Nothing is sent unless ArcAid asks, and ArcAid does not
  ask a desktop device yet (WORK F27) (`witness/log-bundle.ts`, `arcaid-client.ts`, `witness.ts`).

### Changed

- **A client whose host is gone waits 3 minutes, then the match ends for it** and its table is unlocked. Before,
  after 30 s each client made itself host of a match nobody could reach (`hostLeftTransfer: false` in the
  companion; the engine default is unchanged).
- **The relay asks again over 88 s, not 18 s** (five asks, gaps 2 s, 6 s, 20 s, 60 s), so a host has about two
  minutes to come back through ArcAid; recovery from an ArcAid restart is slower from the third ask on
  (`transport-relay.ts`).

### Fixed

- **No picture in a match started from a cold VPX (D10.3.10).** Since 0.2.40 hosting or joining starts the table,
  so the VR layer was on the pipe while the table loaded; the camera's 8 s wait ran out before VPX's first frame
  on a slow table (Game of Thrones: 9.2 s) and the rig sent nothing for the whole match. The wait now starts at
  VPX's first VR frame, and a rig with nothing to send asks the layer again at its turn (`layer-camera.ts`,
  `rtc-host.ts`, `vr-layer.ts`).
- **A ball end sent into a link that had just dropped is sent again after the reconnect.** Before, it was lost and
  the host waited for a ball that had drained.

**Wire / journal:** no protocol or journal change; one paragraph added to `protocol/docs/prose.md` (Reconnect: a
restarted participant starts its `seq` above its earlier run), `SPEC.md` regenerated.

## [0.2.40] — 2026-11-12

**Protocol 5** (a new logged message, `TURN_PASS`): a 0.2.39 companion is refused at HELLO, so everyone in a match
updates together.

### Added

- **Host without a port forward (D10.8).** A paired companion hosts through ArcAid: match control messages (not
  media) go through a relay on arcaid.app, and the invite is just the six-letter code. The 27401 listener stays up
  beside it for LAN and forwarded hosts, and address invites still work. The host locks the room when the first game
  starts; after an ArcAid restart the host re-hosts the same code and the players re-link. When ArcAid cannot be
  reached, Castcade asks the router to open TCP 27401 (UPnP) and removes the mapping afterwards. The Match tab says
  which path is in use. Needs ArcAid 2.242.0 (the relay); before that a paired host waits 4 s and hosts direct.
- **One step to a match (A14, steps 1–3).** The Match tab has a table picker (imported tables, or Browse…): Host
  hosts, copies a `castcade://join/…` link and starts VPX on that table; a table already open is used as it is. The
  link opens Castcade, joins, and starts the same table on that rig (found by file hash, then name); a link opened
  while Castcade was closed asks first. Host, Join, VPX and the companion may now come up in any order
  (`docs/design/alpha-match.md` §9.3).
- **Originals report their ball ends (C1.4, C1.6).** Anchor overrides keyed by script signature for tables the
  vocabulary cannot read: the VPX Game Logic Framework (Dark Chaos), the Burger template (2001 ×2, Star Wars) and
  Rattlecan. All 34 originals on the owner's rig played a full unattended game with every ball end and the game
  end journaled (`npm run validate-original -w companion`, desktop build). Recipe B 0.3.2, C 0.2.0 (sidecars re-made
  on the next folder look).

- **The lobby says whose table cannot report ball ends, and the host can pass the turn (A13).** Three matches on an
  unpatched original (Dark Chaos, 2026-11-12) sat on `grant 1` until Forfeit while the witness had already logged that
  it could not read the table. Each companion now tells the lobby whether its table is followed live
  (`ballEndReady` on HELLO / PARTICIPANT_UPDATE / HELLO_ACK; absent = unknown, never warned about); the Match tab and
  the panel name each player whose table is not, Start match asks the host for "Start anyway", and a start from the
  table waits. During a game the host has **Pass the turn**: it ends the holder's ball at the last known score with a
  logged, host-signed `TURN_PASS` and grants the next turn; a late `BALL_END` for that ball is rejected.

### Fixed

- **A witness rebuilt mid-game no longer replays the game (A14.4).** Changing the ArcAid URL or the NVRAM folder
  during a match re-read the journal from the top: on a player's ball 2 the turn passed at ball 1's score, and in a
  free-play lobby the replayed Start began the match. In solo play the replaced witness kept reading beside the new
  one and the game was posted twice. The witness now hands its journal position to its replacement and stops its
  journal tails. Pause watching now also pauses a game in progress; it is read and posted at resume
  (`witness.ts`, `witness-host.ts`, `witness-restart.test.ts`).
- **An original's final score and game end (C1.6, recipe B 0.3.1 / 0.3.2).** The Matrix (Original) zeroed its
  scores before the game end was journaled, so the final read 0: the game end now goes in front of the clear. Game of
  Thrones lost a game's end when Start was pressed during its 5 s match sequence: the end is also journaled where the
  table clears its in-play flag (`render-originals.ts`).
- **A table locked until someone joins no longer dies mid-ball.** Hosting while a game was running locked the table
  at once (flippers and plunger dead, the game could not end); the lock now waits for that game to end (A14).
- **Two or more players dropping at once no longer leaves the match paused** until the host presses Resume: a
  disconnect pause naming a player ends when that player is back on a live link (D10.8).
- **The patcher wrapped the wrong handler** on tables that define `Table1_Exit` twice (Congo, Hook): the last
  definition is the live one. The undo is now byte-exact for every recipe (a handler's case and a final newline
  were changed on 17 originals). Existing ROM-table sidecars pick this up at their next re-make (C1.6).
- **The host never got a joining player's native picture (D10.3.9).** Both helpers made their video sender with
  `AddTransceiver` and only the initiator offers; libwebrtc pairs a remote offer's video section only with a
  transceiver made by `AddTrack`, so the answerer's sender was never negotiated and its encoder never opened (owner
  hosting, Krobs joining, 2026-11-12: six matches, `remote video track` in Krobs' log every time, never in the
  owner's; the same silence as D10.3.8 with ChuckRibbits). The answerer now adds its track with `AddTrack`
  (`castcade-video` 0.2.1). `tools/drive-pair.mjs --reverse` rehearses the client → host direction and exits 1 when
  the receiver decodes nothing: the 0.2.39 helper fails it, 0.2.1 passes both directions at 60 fps.
- **A companion started while a table was already running in VR read nothing until play ended (C14).** The table
  was taken from the hook's journal only when the main window was titled `Visual Pinball Player`; a VR rig with the
  preview window off has no title during play (Krobs 2026-11-12: `launch null` for 3.5 minutes, his Cactus Canyon turn
  with no live score and no ball end). An untitled VPX whose start time is known now takes its table from the journal
  as soon as the companion sees it.

**Wire / journal:** protocol 5 (`TURN_PASS` logged; optional `ballEndReady` on HELLO / PARTICIPANT_UPDATE /
HELLO_ACK; `protocol/test/messages.test.ts`, `companion/src/match/turn-pass.test.ts`). The relay is a transport
(socket.io to ArcAid: `match:host` / `match:join` / `match:relay` / `match:lock` / `match:leave`), no protocol message.
Journal format unchanged; hook library 0.5.0. Video helper 0.2.1.

## [0.2.39] — 2026-11-07

The second-match fix round (owner + ChuckRibbits on 0.2.38, 2026-11-07 21:22Z). The ICE restarts of 0.2.38 worked:
both helpers connected after one restart and Chuck watched the owner's play natively; the owner saw nothing of Chuck's.

### Fixed

- **Both rigs lost the eye camera to a race and sent a window capture instead (D10.3.7).** The first camera request
  went to the layer before the helper was ready, without the ring; the re-ask with the ring restarts the layer's
  camera, which reports `off (a new request)` for a few milliseconds, and the companion read that as the layer giving
  up and fell back to the screen capture (on the native path, the helper's capture of the VR preview window: the owner's
  1200x1280 window worked, Chuck's full-screen 1920x1080 OpenGL window delivered no frames). The ring token now rides
  the first camera request (it exists at start; the layer fills the ring whether or not the helper reads it yet), and an
  `off` for the layer's own restart never triggers the fallback; any other stop falls back only after a one-second
  grace (`rtc-host.ts`, `layer-camera.ts`, `main/match-host.ts`).
- **Theater sat behind an empty ring while a picture was arriving (D10.3.8).** The layer draws from the recv ring when
  the control names one and drains the pipe's frames; with Chuck's native send silent, the owner read "waiting for
  ChuckRibbits' table" while the Electron path delivered Chuck's picture to the page. Now, five seconds without a
  native frame from the player up in theater and the layer draws the Electron frames (logged; the Match tab line says
  `theater from the Electron frames`); three seconds of native frames and it returns to the ring.


## [0.2.38] — 2026-11-07

The fix round from the first 0.2.37 match (owner + ChuckRibbits, 2026-11-07 17:33Z): no native video reached either
rig, and nothing fell back to the 0.2.36 picture. Three causes, three fixes; helper 0.2.0.

### Fixed

- **The companion told the helper its state twice and replaced a peer mid-handshake (D10.3.4).** The helper's `ready`
  reached the mesh once as a status change and once as an event 200 ms later; the second pass re-sent `peer`, the
  helper replaced the connection that had already answered, and both sides ended `ice failed`. The helper status now
  carries a `generation` (one per spawn) and the mesh syncs once per generation (`video-helper.ts`, `video-mesh.ts`).
- **The helper never restarted ICE (D10.3.5).** Between the two rigs' routers the Electron voice peer connected only
  after one ICE restart in every session, the companion's D2.9 policy since 0.2.33; the helper's single attempt timed
  out after 20 s. The helper now renegotiates: the offering side restarts ICE after 10, 20 and 40 s of checking,
  the answering side answers any new offer, candidates are gathered continually, and `peer` events carry `restarts`
  and, when the three are spent, `restarts_exhausted`. Its candidate gathering also skips virtual and link-local
  adapters (the owner's WSL vEthernet, a 169.254 USB adapter and IPv6 unique-local addresses had STUN timing out).
  `--restart-selftest` holds every candidate for 12 s and must connect through restart 1 (`video-helper/src/peer.cpp`,
  `network_filter.h`).
- **Nothing fell back (D10.3.6).** On the native path the Electron video track is held back, so a failed helper
  connection meant voice and no picture. Now a match falls back to the Electron video, for the rest of that match, when
  a helper peer is not connected 25 s after it was told, when the helper gives a peer up, or when the helper is
  unavailable; the log says `native video failed to connect … the Electron video serves this match` and the Match tab
  reads the same (`video-mesh.ts`, `main/match-host.ts`, `Match.tsx`).


## [0.2.37] — 2026-11-07

The first native spectator-video build (D10, ADR 0010): the player up's picture is encoded on the GPU in a native
helper and carried by Google's WebRTC library, decoded natively on the other side and drawn straight on the headset's
theater screen or in the helper's own window. The Electron video path of 0.2.36 stays behind a setting for this one
release. Protocol 4: a 0.2.36 rig and a 0.2.37 rig refuse each other at HELLO; every rig updates through the updater.

### The stack, chosen by measurement (D10.0.1; ADR 0010)

- **Three loopback senders through one UDP shaper, two 90 s runs each on the owner's rig** (`spike/d10-video/`,
  `results/RESULTS.md`): Rust + str0m, LiveKit's prebuilt libwebrtc from C++ with our NVENC plugged in, and GStreamer.
  libwebrtc held 60 fps, froze 1.8 s at a 25 → 2 Mbps drop, was steady again in 3–4 s and never lost a decodable
  second; str0m froze 3–5 s and lost whole seconds; GStreamer had start-up freezes, no ramp-up, a 48–73 MB runtime
  and no congestion control for AMD encoders. libwebrtc won; the owner accepted ADR 0010 the same day.

### `castcade-video.exe`, the video helper (D10.1, D10.1.5; `video-helper/`, 0.1.0)

- **A native helper beside the audio helper**: libwebrtc (LiveKit's `webrtc-a545de4`, M150) with libavcodec as the
  encoder front, probed at start in the order `h264_nvenc` → `h264_amf` → `h264_qsv` → `libx264` (and `h264_cuvid` →
  `d3d11va` → software for decoding), the choice logged and on the Match tab. One JSON line per command over stdin,
  one per event over stdout (`video-helper/README.md` is the protocol). `--probe`, `--bench` (with `--gpu-load`, the
  P-state and the IDR count per rate policy), and self tests the CI runs (`--loopback-selftest`, `--ring-selftest`,
  `--controller-selftest`, `--window-selftest`, `--wgc-selftest`). `video-helper.yml` is the build of record;
  `fetch-video-helper.mjs`, the installer entry and a best-effort firewall rule; the helper's FFmpeg (BtbN
  `autobuild-2026-11-06-12-50`, GPL shared) joins the written source offer (`docs/ffmpeg-source.md`). The installer
  grows by about 136 MB for the FFmpeg DLLs (D10.1.4 is the trim).
- **Bitrate changes are rate-limited** (a new target applied on a ≥ 10 % change at most once a second, drops of
  ≥ 30 % at once) because libavcodec's NVENC wrapper forces a keyframe on every change (D10.1.1: 52 keyframes in a
  10 s bench without the limit, 2 with it).

### Frames cross through shared memory, not the pipe (D10.2; layer 0.6.0)

- **The OpenXR layer writes the eye it captures into a send ring** (`Local\castcade-video-send-<token>`, three
  slots, BGRA, newest wins) instead of JPEG when the companion's camera request names a ring; **theater draws from a
  recv ring** the helper fills with the decoded picture when the control names one (`"video": {"ring": …}`). The JPEG
  path and `CVO2` frames stay as the fallback; a helper that dies leaves theater within 3 s as before. The contract is
  `video-helper/include/castcade_frame_ring.h`; `ring_feed.exe` (not shipped) fills and drains rings without VPX.

### The companion drives it (D10.3; protocol 4)

- **`video-helper.ts` and `video-mesh.ts`**: the helper is spawned at Host / Join and restarted on a crash at most
  once per 5 s; one helper peer per other player for the match's life (the lower player id offers), the turn turns
  sending on and off, VR rigs get the recv ring and desktop rigs the helper's window; signals ride `MEDIA_SIGNAL` with
  the new `channel: "video"`. **Match tab setting "Spectator video"**: Native helper (default) or Electron (the 0.2.36
  path), used from the next match; a status line `Native video: h264_nvenc · sending 1354x1440 at 60 fps, 18.2 Mbps ·
  from Krobs: 60 fps · ice connected (srflx↔host)`.
- **Wire**: `MEDIA_SIGNAL.channel` (`rtc` | `video`, default `rtc`); `PROTOCOL_VERSION` 4 (a 0.2.36 peer would strip
  the key and feed a native-video offer to its page, so mixed builds refuse each other instead). Schemas and SPEC
  regenerated; `protocol/test/messages.test.ts` covers the default.

### Watching on a desktop (D10.4) and sending from one (D10.6)

- **The helper opens its own window for a desktop watcher** ("Castcade — spectating": resizable, letterboxed, F11 or a
  double-click for full screen, Escape back; D3D11 with a WARP fallback; "waiting for the player up" after 3 s without
  a frame). Closing it tells the companion.
- **A desktop sender captures the VPX player window natively** with Windows Graphics Capture (the client area of a
  windowed player, the whole of a borderless one, portrait stays portrait; works with the window behind others and
  with the OpenGL build), so no rig on the native path sends Electron video any more. Minimised → "no VPX window to
  capture yet" until it is back.

### The ladder and its controller (D10.5)

- **Six rungs** from the source box (full, 0.75, 0.5 of its height; 60 and 30 fps; 20 / 10 / 8 / 5 / 4 / 2 Mbps),
  applied per receiving peer: a GPU-side NV12 scale, a steady frame decimation, the encoder's clamp. **The controller**
  (sampled every 200 ms from the stack's stats and a `castcade-feedback` data channel carrying the receiver's decode
  fps and freezes): 5 s at rung 3 to probe, then straight to the highest rung the estimate supports; one rung down after
  3 s of trouble (loss over 2 %, RTT up 100 ms, estimate under 0.9× the rung, sent or decoded fps under 0.9×, a freeze
  over 500 ms), one up after 30 s clean. A size change costs 190–350 ms (the receiver's `h264_cuvid` is re-opened on a
  keyframe of a new size). **Match tab**: Auto or a pinned rung, a ceiling in kbps (`videoMaxKbps`, this rig's own);
  **headset footer**: `video: rung 3 · 1016x1080@60 · 7.8 Mbps · rtt 41 ms` while sending, `video: in …` while watching.
  The rung order honours the owner's rule: full size at 30 fps before a smaller picture at 60.


### Added

- **Original tables patch by role, not by JPSalas' names (C1.3; recipe B 0.2.0).** Diablo 2 (ChuckRibbits 1.1.1 and
  1.2.1) and eight other originals on the owner's rig were skipped as class E ("recipe E needs a guided pick"). Recipe B
  now finds its four anchors from a vocabulary: the start sub (`ResetForNewGame` / `StartGame` / `StartNewGame` /
  `NewGame` / `InitGame`), the end sub (`EndOfGame` / `GameOver` / `EndGame`) or, failing one, the first statement that
  clears the game flag (`gameon = 0`, `GameActive = False`, `GameOver = 1`), the ball-end sub (`EndOfBall` / `EndBall` /
  `EndPlayerTurn` / `BallDrained`) or the `BallsRemaining` decrement, and the score store read from `AddScore`'s own
  body (a scalar `Score`, a `Score(player)` array, or a `p1score, p2score…` family). The player, players, ball and
  extra-ball variables follow the same vocabulary, and a name that is only a local `Dim` is never taken. Every B
  sidecar is re-made on the first look (recipe version 0.2.0); the plan reason names the subs and the score store it
  found. On the rig: Diablo 2 ×2, Jacks Open and Futurama exact; Rattlecan, 2001 ×2 and Star Wars (Burger) with the
  game end from the flag and no ball end. The guided-pick UI of the old C1.3 is dropped; the leftovers (Diablo 2's own
  multiplayer finals, the Burger template's ball end) are per-table overrides, C1.4.

### Fixed

- **Scripts with mixed line endings were refused as "no _KeyDown handler" (C13).** Krobs' Twilight Zone (VPW 1.0),
  Mustang 1.27 and Time Machine 2.4.1 each ran unpatched in basic mode, so only the last game of a session posted.
  The patcher split a script on its one dominant newline, so an LF-only run inside a CRLF script (VPW multi-author
  scripts; 44 of the owner's 142 tables mix endings) collapsed into one chunk where no anchor could be found. It now
  splits on every newline and keeps each line's own ending through a patch and its undo (the round trip stays
  byte-exact; Castcade's own lines take the dominant ending). A UTF-16 script is refused by name ("script is UTF-16
  text, not the ANSI VPX writes"), and every refusal of an unclassifiable script logs its byte length, CRLF / LF / CR
  / NUL counts and first line, so the next odd script is readable from `companion.log`. Found and reproduced by the
  ArcAid session (ArcAid W94).

## [0.2.36] — 2026-11-05

The first build under ADR 0009 (spectating is 2D, owner and Krobs 2026-11-04): the player up is flat video on a screen
for everyone, never a stereo window. The stereo window of 0.2.27–0.2.35 stays in the code untouched and leaves the UI.
Both rigs take this through the updater and must restart VPX afterwards (`vr-layer.log` says `build v0.2.36`, layer
0.5.3; the table-sound helper is 0.2.0). An existing `match.json` is migrated once: the camera becomes the VR layer
sending one eye (`settingsVersion` 2).

### One eye from the VR layer, the default camera (D8.1; layer 0.5.3)
- The OpenXR layer camera sends ONE eye (control `camera.eye: "left" | "right"`; a one-entry `eyes` array and one JPEG
  per `CVF1` frame; half the GPU readback, JPEG work and pipe traffic; the helper thread is not started). The companion
  asks for the left eye by default (`cameraEyes: 'one'`), accepts a one- or two-eye frame (a 0.5.2 layer still sends
  both; the other eye is dropped), draws it as a `w x h` mono capture and declares `mono`, so the receivers show the
  flat theater screen. `cameraSource` now defaults to `'layer'` (the screen capture of VPX's preview window stays the
  fallback and the monitor rig's camera, every fallback logged); the preview window is no longer captured on a VR rig,
  so PuP and DMD windows can sit anywhere (Krobs' DMD sat over his preview on 2026-11-04). `VIDEO_FEED_MAX.mono` is
  1920x1440 so the 1354x1440 eye reaches the layer unscaled. `vr-layer/src/camera.cpp`, `panel_pipe.cpp`,
  `media/layer-camera.ts`, `vr-layer.ts`, `panel-page.ts`, `rtc-host.ts`, `frame-clip.ts`, `main/match-setup.ts`
  (`loadMatchSettings`, the migration), `main/match-host.ts`, `main/vr-report.ts`.

### Hardware H.264, started at the cap (D8.3)
- Every video sender prefers H.264 (`preferH264`: packetization-mode 1, 42e01f then 640032; VP8/VP9/AV1 kept after
  as the fallback) through `setCodecPreferences`, so Chromium's Media Foundation encoder (NVENC on both rigs) carries
  the match instead of software VP8. Every remote description gets `x-google-start-bitrate` at the sender's cap and
  `x-google-min-bitrate` at 40 % of it (`withBitrateHints`), so the picture starts at the cap instead of ramping from a
  low guess for ten seconds after each turn (the 2026-11-04 series: 9–25 fps after every switch, 5–7 Mbps VP8). The
  codec and encoder are logged: `media: encoder: H264 via MediaFoundationVideoEncodeAccelerator` once known, and on
  every `media: capture:` line. The bitrate rule (`videoBitrateFor`, 8 Mbps ceiling) is unchanged; D8.2 replaces it
  with presets. `media/panel-page.ts`, `rtc-host.ts`.

### The Match tab and the bench speak 2D (D8.7)
- Camera view, window depth, the per-eye vertical offsets, soft edge and the calibration pattern leave the Match tab
  and the bench card (their settings, IPC and layer controls stay; a hand-edited `match.json` still reaches them).
  Hints rewritten for the flat screen; Theater size is a legitimate 2D control again (Life size, Krobs' choice, the
  default). `previewStereo: auto` declares one eye unless VPX's ini plainly says Both Eyes, and the tab then tells the
  player to turn it off; the runbook no longer asks for Both Eyes. `renderer/src/views/Match.tsx`, `TestBench.tsx`,
  `media/preview-stereo.ts`, `media/bench.ts`, `docs/alpha-match-runbook.md`.

### Voice over the game (D2.10; helper 0.2.0)
- Both testers heard the table over the other player's voice. Three Match tab sliders, saved and applied live:
  **Voice volume** (0–300 %, default 150; a GainNode on each peer's voice in the panel page, the media element muted
  so the track is not played twice), **Their table sound** (0–100 %), **My table while I play** (10–100 %, default
  100: the helper's new `level <pid> <percent>` sets the VPX session volume while this rig is up and `unlevel`
  restores it; the `--state` recovery restores levels like mutes). Global shortcuts while in a match: Ctrl+Alt+Up /
  Down change the voice volume, Ctrl+Alt+Left / Right my table while I play, each press saved, pushed live, logged and
  ticked at the cue volume. A 0.1.0 helper is told once that it cannot level. `media/panel-page.ts` (`volumeGains`),
  `rtc-host.ts` (`setVolume`), `audio-helper.ts`, `table-audio-policy.ts`, `main/match-host.ts`, `main/index.ts`,
  `audio-helper/src/main.cpp`.

### No game before the match (A12)
- The owner pressed Start before the other player joined and nothing could start. New setting **Before the match**:
  *Free play until someone joins* (the default: when the lobby completes while a game runs on the host's table, the
  match waits for that game to end, says so on the host's panel, and starts at the next Start; a game started with
  fewer than two in the lobby is never game 1) or *Table locked until someone joins* (the turn lock holds the host's
  table until the lobby is complete, re-locks if it empties; a client's table is never locked before the match).
  `match/controller.ts`, `main/match-setup.ts`, `main/match-host.ts`, `renderer/src/views/Match.tsx`.

### Housekeeping
- `witness.test.ts` waits for the unpatched notice instead of assuming six flush rounds (the first cold read of the
  maps corpus on an ubuntu runner outran them: main CI red on two of three runs).

## [0.2.35] — 2026-11-04

The owner's solo check on 0.2.34 (2026-11-04): the calibration pattern's grids fuse into one and the table fuses, so
the stereo window's placement is right; but the window's FRAME still doubled at its edges. The two frames are placed
with zero disparity (at infinity) while the eyes converge on the table about a metre away: three to four degrees of
uncrossed disparity, and no fixed offset cures it (a frame at any one depth doubles against content at another). This
build removes the frame from the shared field, softens what remains, and gives the bench sliders to tune and read back
the geometry. Both rigs take it through the updater and must restart VPX afterwards (`vr-layer.log` says
`build v0.2.35`); the control's new fields are additive, so an older layer simply keeps the 0.2.34 behaviour.

### Full view: each eye's whole render (D7.5.10; layer 0.5.2)
- The layer camera can send each eye's whole render instead of a 1:2 crop (control `camera.whole`; `camera.cpp`
  `cropFor` returns the eye's whole rect, scaled into the box, never up: a 3072x3264 Quest 3 eye in a 1440x1440 box
  gives 1354x1440). The receiver places it from the sender's eyes as any crop (D7.5.2), so the frame's edges land where
  the sender's eye's own view ended, outside the part of the field both eyes share (each eye's nasal edge lies where
  only the other eye sees content, as in native VR): nothing is left to double. The match setting `cameraView`
  (`whole`, the default, or `window`, the 1:2 crop of 0.2.34) is the Match tab's **Camera view**, applied live to a
  running match camera and to the bench (`RtcHost.setCameraView`). The side-by-side picture is about twice the pixels
  (2708x1440 against 1440x1440), so the cap / codec decision (D7.6.9's gate) is now the real gate for a match; the
  bitrate rule is unchanged. `media/layer-camera.ts` (`cameraRequestFor({ view })`), `media/rtc-host.ts`,
  `media/vr-layer.ts`, `main/match-setup.ts`, `main/match-host.ts`, `renderer/src/views/Match.tsx`.

### Window depth, vertical offsets and soft edges (D7.5.9, D7.5.11, D7.6.10; layer 0.5.2)
- Control `tune`: `depthM` places the window's frame at a distance instead of infinity (each eye's tangent rect shifted
  by -eye.x / D, toward the nose: an uncrossed disparity of IPD / D; null = infinity) and `dyDeg` lifts or lowers one
  eye's picture in degrees; both apply to the video and to the calibration pattern, so the sliders can be watched.
  Control `feather` ramps the video window's alpha to the black backdrop over a fraction of the eye's width on all four
  edges (the window quads blend when it is on; the pattern, the mono screen and the panel stay hard), so an edge that
  still doubles (the window view, or a sender with a narrower field of view than the receiver) is a soft gradient, not
  a line. `vr-layer/src/panel_pipe.{h,cpp}` (`jsonTune`, `jsonFeather`), `vr-layer/src/layer.cpp` (`placeWindows`,
  `featherEdges`, `uploadVideo`); the session report's window block says `tune` and `feather`; `vr-layer.log` logs
  `pipe: tune: …`, `pipe: window edges feathered over N% of the eye's width`, and the `theater: stereo window` line
  carries the depth and offsets.
- Match settings `windowDepthM` (default null = infinity), `eyeOffsetDeg` (default [0, 0]) and `softEdge` (default
  0.03) ride on every control to a protocol-3 layer (omitted at their defaults), in a match and on the bench alike, and
  are changed live from the bench card: **Window depth** (infinity / 5 / 2.6 / 1.5 / 1 / 0.7 m), **Vertical offset**
  per eye (degrees, ±3), **Soft edge** (off / 1 / 3 / 6 / 10 %). The VR report prints them in words (settings) and what
  the layer applied (the layer section's `window` block). `renderer/src/views/TestBench.tsx` (`WindowTuning`),
  `main/match-host.ts` (`syncWindowTune`), `media/vr-layer.ts` (`setWindowTune`, `setSoftEdge`, `tuneWords`),
  `main/vr-report.ts`.

### Wire / journal
- The layer pipe's `CVC1` control gains `camera.whole`, `tune` and `feather`; the `CVS1` camera status gains `whole`
  (additive; pipe protocol stays 3; `vr-layer/README.md`). The match protocol and the journal are unchanged.

## [0.2.34] — 2026-11-03

The owner's first solo run of the VR test bench on 0.2.33 (five minutes, no second player) returned two facts: straight
to the layer the table fused but the two window frames stood 15° apart, and through the local WebRTC loop the picture
was poor at the 8 Mbps cap. This build fixes the first and gives the bench what it needs to settle the second. Both rigs
take it through the updater and must restart VPX afterwards (`vr-layer.log` says `build v0.2.34`); a 0.2.33 receiver
would place a 0.2.34 sender's picture 15° off per eye.

### The stereo window stands straight ahead (D7.5.8, D7.5.2; layer 0.5.1)
- The camera crops each eye about the eye's optical axis instead of the render's centre. A Quest 3 eye sees 40° toward
  the nose and 54° outward, so the centre of its render is 15° temporal of where the eye looks; the centre crop put the
  right eye's window 15° right (black on the nasal side, the outer edge at the lens) and the left eye's 15° left: the
  table fused, the frames did not. One rule, `axisCropX` in `vr-layer/src/eye_crop.h`, used by `camera.cpp`'s
  `cropFor`; the crop stays centred vertically (both eyes share the up / down asymmetry, so a low window fuses, and the
  full height keeps the flippers). `vr-layer.log` now says `crop 1632x3264 at 348,0` for the left eye and `at 1092,0`
  for the right.
- The receiver places the window from the sender's eyes (the D7.5.2 receiver half): the peer's `eyes` from its stereo
  signal ride with every theater frame to main (`VideoFrame.eyes`, `eyeGeometryFrom`) and go on the layer's control
  (`eyes`, a protocol-3 layer only, sent when they change, dropped when the frames stop carrying them); the layer's
  `eyeCrop` takes the sender's fov, render and crop as they are (exact for mixed headsets) and falls back to VPX's
  centre-crop rule for a picture without eyes (the screen capture, an older sender). The bench's own camera and clips
  take the same path, so the bench shows exactly what a receiver would. The session report's theater block says
  `cropFromSender`; `vr-layer.log` logs `pipe: the sender's eyes: …` when they change; the calibration pattern still
  measures this headset's own geometry. `media/panel-page.ts` peerEyes / feedOut, `media/rtc-host.ts`,
  `media/vr-layer.ts`, `vr-layer/src/panel_pipe.{h,cpp}` (`jsonEyes`, `readNumber`), `vr-layer/src/layer.cpp`;
  `docs/design/alpha-match.md` §5a item 3.

### The bench names the codec and lets the cap move (D7.6.8, D7.6.9)
- The loop's readout and the `media: bench:` log line name the codec and encoder from the sender's stats (`codecId` →
  mimeType, `encoderImplementation`, `(hw)` when the encoder is power-efficient): `encoder sent 1440x1440 at 7.8 Mbps
  (cap 8.0 Mbps), 30 fps, VP8 via libvpx, limited by none`. `media/bench.ts`, `media/panel-page.ts` benchTick.
- A Bitrate cap select on the bench card, shown on the loop path: the match's rule (8 Mbps for stereo), 16, 30 or
  50 Mbps; the cap goes to the loop's sender and the start line says `cap 16 Mbps`. Save 2 s of frames pressed during
  the loop keeps the frames as they came out of the loop. `renderer/src/views/TestBench.tsx`, `main/match-host.ts`,
  `media/rtc-host.ts`, `media/bench.ts` (`benchRequestFrom` rejects a cap outside 1–100 Mbps).

### Wire / journal
- The layer pipe's `CVC1` control gains an optional `eyes` array (additive; pipe protocol stays 3; `vr-layer/README.md`).
  The match protocol and the journal are unchanged.

## [0.2.33] — 2026-11-03

Protocol 3. Five headset runs had each returned one fact, because every hypothesis needed a second player in a headset
and the picture came from a screen capture of a preview window. This build takes the picture from inside VPX's frame,
lets a match run more than one game without leaving the table, recovers a connection both routers block, and adds a
test bench so the owner can judge theater geometry, scale, detail and frame rate alone in five minutes. VPX must be
restarted after the update so the new layer loads (`vr-layer.log` says `build v0.2.33`).

### A match is a series; the match starts from the headset (A10, A11, A10.5)
- After a game's RESULT the match stays open (peers, mesh, voice, panel): the panel shows `GAME 1 OVER`, the standings
  and "Next game: <host> starts a game on the table". The host starting a game on their table (the hook's `game_start`
  in the journal) begins the next game for everyone from ball 1, no button and no desktop; the header reads `GAME 2 ·
  YOUR BALL 1`; from two games on the score rows show the series place and wins (by outright wins, then total score; a
  tie for first gives nobody the win). The host's Match tab gets Next game and End match; End match works between games,
  Leave is still the way out mid-game. A client shows the final standings for 20 s, then closes the match itself.
  Protocol 3: one hash-chained log for the whole series, `NEXT_GAME {game, playerOrder}` host → all and logged,
  `MATCH_END {games, reason}` not logged, `game` on the TURN_GRANT body and on each signed RESULT with the series
  standings so far. Reconnect mid-series, host transfer mid-game-2, a player who left before game 2, a late LOG_SIGN
  and a bad NEXT_GAME are covered by `companion/src/match/series.test.ts` and the fakeclient `two-game-series`
  scenario. `protocol/src/messages.ts`, `match/state.ts`, `result.ts`, `host.ts`, `client.ts`, `controller.ts`,
  `main/match-host.ts`, `media/panel-page.ts` headerText / stripRows, `Match.tsx`; design in
  `docs/design/alpha-match.md` §8. ArcAid's side (N results under one Throwdown) is WORK F24, before A5 posts.
- Start from inside the headset: the host's first game on the table starts the match when the lobby is complete
  (every joined rig has its table open), after a 5 s countdown on every panel (`STARTING IN 5`, "Starting the match:
  <names>"; `HELLO_ACK.startsInMs` carries it as a duration, the clocks need not agree). A second plunge changes
  nothing; the desktop Start still starts at once; a table still loading (`HELLO_ACK.loading`, a LOADING flag on the
  roster) makes the start wait and fire when it opens. `match/host.ts` startIn, `main/match-host.ts`.
- Fixed: a RESULT resent to a reconnecting peer was always dropped by the seq rule (it went out with its old `seq`
  after the newer RECONNECT_ACK), so 0.2.22's "sent RESULT again" never worked; every RESULT is now resent in a fresh
  envelope.
- Wire / journal: protocol 2 → 3 (`PROTOCOL_VERSION`, `protocol/SPEC.md`, `protocol/schemas/`); MEDIA_SIGNAL's stereo
  signal gains an optional `eyes` field (two `EyeGeometry` entries: fov, crop rect, render size) for the layer camera
  (D7.5.2's wire half; `protocol/test/messages.test.ts`). The journal format is unchanged.

### The picture comes from inside VPX: the layer camera (D7.5, D7.5.1; layer 0.4.0 → 0.5.0)
- On the Match tab, Camera: `screen capture` (the default, unchanged from 0.2.32) or `VR layer (experimental)`. With the
  layer, the OpenXR layer copies the two eye views VPX submits (`XrCompositionLayerProjection`) out of VPX's frame:
  OpenGL (the owner's rig through OpenComposite) by `glBlitFramebuffer` into a texture of ours, `glReadPixels` into a
  PBO, a fence polled and never waited on; D3D11 by a staging copy; a worker thread reads back one or two frames late,
  centre-crops each eye to a 720x1440 box (VPX's own preview rule, never stretched), encodes each eye as JPEG quality
  85 (vendored `stb_image_write.h`, `vr-layer/third_party/stb`, attributed in `THIRD-PARTY.md`) and writes the frame
  down the pipe; the render thread never copies a frame or blocks. Per-frame `issue / map / copy / encode / write`
  microseconds are logged for the first 10 frames and then every 300th (`camera: frame N: …`); `camera: on (OpenGL):
  eye render WxH …` / `camera: off (why): N frames sent …` / `camera: refused: …` bracket a run (multisampled or
  non-8-bit swapchains, OpenGL below 3.2, a VPX started before the layer are refused loudly). The pipe is overlapped
  now, so the worker's writes no longer queue behind the reader. Pipe protocol 3: control `camera: {width, height,
  fps} | null`, layer → companion `CVS1` status and `CVF1` frames (header JSON with n, t, w, h, timings and per-eye
  fov / rect / render, then the two JPEGs). `vr-layer/src/layer.cpp`, `camera.cpp`, `jpeg_encode.cpp`,
  `panel_pipe.cpp`; `companion/src/media/vr-layer.ts` createLayerReader / parseCameraFrame, `layer-camera.ts`.
- The panel page draws the two JPEGs side by side on the same canvas whose track the peers already hold (1440x1440,
  no renegotiation; `media: sending 1440x1440 sbs at 8.0 Mbps`), a synthetic capture `VR layer camera` keeps the
  Match tab fields and the `capture: N frames in 10 s from the VR layer camera …` counters working, and the stereo
  declaration is forced to `sbs` with the sender's eyes. While another player is up, one frame a second reaches the
  page; the full rate returns on this rig's turn. Falls back to the screen capture, once per match and never forward
  again within it (`media: camera: back to the screen capture: <reason>`): the layer not on the pipe within 20 s, a
  refusal, no frame for 8 s after `on`, a stall of 3 s, the pipe closing. A Camera change applies between balls. PC
  rigs and SteamVR rigs always use the screen capture. `rtc-host.ts`, `panel-page.ts`; the contract and what is built
  are `docs/design/alpha-match.md` §5a. Left for later: the receiver's window still assumes its own eyes (D7.5.2).

### Theater: size and a taller feed; the connection recovers (D7.4.9, D2.9)
- Theater size on the Match tab: life size, 80 % or 60 % (sharper, smaller; `theaterScale` in the layer's control,
  live). The side-by-side feed box is 3840x1440 instead of 3840x1080, so the owner's 1440x1392 preview reaches the
  other rig whole (it arrived as 1116x1080 on 2026-11-02); `theater: feeding WxH (sbs) to the layer` is logged once per
  size change. `panel-page.ts` VIDEO_FEED_MAX / feedSize, `vr-layer.ts`, `main/match-setup.ts`, `Match.tsx`.
- EFUKTZ 2026-11-02 never found a working ICE pair (two NATed peers, STUN only) and nobody heard anything until the
  owner forfeited. Now every 10 s counter line names the nominated candidate pair per peer (state, local and remote
  candidate types host / srflx / relay, protocol, round trip; never an address), and a watchdog restarts ICE through
  the existing signalling when a connection sits in `checking` (or `new` after signalling settled, or `disconnected`)
  for 10 s, again after 20 s and 40 s, three restarts at most, the impolite peer leading and the polite one 5 s
  behind; after that the panel and the Match tab say "No path to <name> (ICE checking after 3 restarts): both routers
  blocked the direct connection; a TURN relay is needed". `media: peer <id>: ICE restart 1 of 3 (checking for 10 s, we
  lead …)` / `ICE connected after 1 restart(s) …; pair srflx -> srflx udp succeeded`. The Match tab has TURN relay
  fields (url, username, credential; saved in `media.json`, the credential never shown or logged) until a relay of
  ours exists (WORK F23). `rtc-signaling.ts` restartIce / leadsIceRestart, `panel-page.ts` icePairInfo / iceWatchStep,
  `media-settings.ts`, `main/match-host.ts` setTurn, `Match.tsx`.

### The VR test bench: theater alone in the headset (D7.6, D7.6.1, D7.6.2, D7.6.3)
- A "VR test bench" card on the Match tab. Start puts the layer in theater without a match (refused while one is on):
  Source "My own table, live" (this rig's layer camera: the owner sees their own table in the window and can compare
  it with the direct view through "Show VPX's own view") or a saved clip; Path "Straight to the layer" (no encoder) or
  "local WebRTC loop" (two peer connections inside the panel page with the match's bitrate rule, so the encoder's
  detail is in the picture); Theater size live; a readout every second (fps drawn, the size handed to the layer, and
  on the loop the encoder's sent size, bitrate against its cap and `qualityLimitationReason`); Stop restores VPX's
  view. On a PC the picture shows in the desktop panel window. `media/bench.ts`, `rtc-host.ts`, `panel-page.ts`,
  `main/match-host.ts`, `renderer/src/views/TestBench.tsx`; `docs/design/alpha-match.md` §5b.
- Show calibration pattern: the layer draws a stereo test image itself (control `test: 'pattern'`): per eye a grid
  every 5° of visual angle, labelled every 10°, circles at 10° and 20°, a cross on the axis, left orange and right
  blue, a large L / R in the outer corner, placed with the exact geometry theater uses for a sender. A doubled line
  at a known angle measures the geometry error directly. Needs a hosted match today (the layer connects only during
  one; WORK D7.6.1.2). `vr-layer/src/layer.cpp` eyeCrop / the pattern canvas.
- Write VR report: `vr-report-<date>.md` and `.json` in the logs folder with what the headset, the runtime and VPX
  say about the picture: runtime name and version, system, view configuration and recommended eye sizes, per-eye fov,
  VPX's swapchains (format, size, array, samples, usage), the last frame's layers and rects, the graphics binding and
  GL strings, the OpenComposite verdict and the VR modules in VPX, the last theater placement; plus the rig and
  runtime detection, the match settings, the ICE description, the last controls sent, the camera status, the last
  60 s of counters, the VPX preview window's fit and the `[PlayerVR]` ini keys. The layer logs the same `session:`
  block to `vr-layer.log` at each session's first frame. `vr-layer/src/layer.cpp` sessionFacts,
  `companion/src/main/vr-report.ts`, `vr-report-host.ts`, `media/vr-layer.ts` requestSession / probeLayerSession.
- Save 2 s of frames: `logs/frames/<date>/` gets the layer camera's own JPEG eyes with their headers (`NNNN-L.jpg`,
  `NNNN-R.jpg`, `NNNN.json`) and the received theater frames as the page decoded them (`in-NNNN.jpg` + `.json`), at
  most 120 a side, with a `clip.json` index the bench replays. `media/frame-clip.ts`.

## [0.2.32] — 2026-11-02

The fourth run's logs re-read against the clock: 0.2.31's reading of Krobs' frozen picture (a display turned off) was
wrong, and the owner's question, "could it be a focus thing?", was right. The display-awake hold stays (harmless).

### A full-screen or clipped VR preview window is called out (D7.4.10)
- Krobs' screen capture ran at 22–29 fps for the whole of LUADLJ (15 min, VPX focused in the headset), then delivered
  one frame per pick from 90 s after he restarted VPX with `[PlayerVR] PreviewWidth / PreviewHeight` at 1920x1080, the
  size of his display (1080x912 before), with bursts only while he had alt-tabbed out. A window that covers the whole
  display is presented full screen once it has focus, past the desktop composition the screen capture films: the
  tracker's third sighting of "froze once VPX had focus" (D2.5, D7.4.4). The companion now computes the window's fit
  on its display at every pick and says so on the Match tab and in the log (`media: the VPX preview window covers the
  whole 1920x1080 display: a full-screen window stops the screen capture once VPX has focus …`, with a size that fits:
  960x960 on 1080p), repeats it on the stall line, and also names rows or columns of the window that hang off the
  display and are not sent (his earlier 1080-row window sat 168 rows below the display: the bottom of his table never
  left his PC). Runbook: 960x960 on a 1080p monitor, never the monitor's size, wholly on screen.
  `companion/src/media/capture-crop.ts` cropFit / fitWarning, `rtc-host.ts`, `Match.tsx`.
- The owner's own VPX (started 22:59, before the 0.2.29 install at 23:15) kept the 0.2.28 layer through the first three
  matches of the night; only VBPATF ran the stereo window. So the one match with a healthy capture from Krobs was seen
  through the old layer, and no clean moving picture of his table was seen all night. D7.5 (the layer as the camera)
  remains the design that takes the screen capture, and all its conditions, out of VR senders.

## [0.2.31] — 2026-11-02

The fourth two-rig run (VBPATF, 0.2.29 with the stereo window on both rigs): the stereo pair lines up on both sides
without strain. Two things it found, both fixed here.

### Theater follows the head's pitch (D7.4.7)
- The window is placed where the receiver is looking when the other player's ball starts: the head's yaw and pitch,
  never its roll, the pitch clamped to ±75°. The sender's eye render reaches 55° below his gaze and his playfield sits
  low in it, so a level window put the flippers below the receiver's view. The mono screen uses the same frame.
  `vr-layer.log`: `theater: the screen is placed 2.6 m ahead, yaw N degrees, pitch N degrees`. `vr-layer/src/layer.cpp`.

### The display stays awake during a match (D7.4.8)
- Krobs' screen capture delivered 0–1 frames per 10 s for whole balls late in the night (one frame per re-pick, then
  nothing) after 21–29 fps earlier: Windows had turned his display off after its idle time (VR controllers are not
  desktop input), and desktop duplication delivers nothing from a dark display. The companion now holds a
  `prevent-display-sleep` power-save block while a match's media is attached and releases it on detach
  (`media: keeping the display awake while attached`). His decode of the owner's feed ran at 30 fps throughout, so the
  lag he felt is latency and the grain is 558x1080 per eye spread life-size (D7.4.9 raises the receiver's feed box;
  D7.5 is the design that removes the screen capture from VR senders altogether). `companion/src/media/rtc-host.ts`.
- Krobs' `vr-layer.log` confirms his headset is a Meta Quest 3 with the same fov and render size as the owner's, so the
  stereo window's stand-in (the receiver's eyes for the sender's) is exact between these two rigs.

## [0.2.30] — 2026-11-02

The third two-rig run (LUADLJ, 0.2.29) proved table sound (D2.8) and showed why the owner's theater had not changed:
his VPX had been running through the update, so Windows kept the 0.2.28 layer dll mapped and the installer could not
replace it. This release makes that impossible from now on and carries the coverage lane's two rig-tested fixes.

### The layer runs from a per-version copy (D7.3.3)
- At start the companion copies the OpenXR layer to `%LOCALAPPDATA%\Castcade\vr-layer\<version>\` and registers that
  manifest, never the install dir, so an update never touches a dll a running VPX holds; older copies are removed when
  no VPX holds them. `companion.log` names the registered path, the dll's sha256 and the VERSION text. While a VPX
  process predates the registration, the Match tab's rig line and the log say `VPX started before this layer was
  registered: restart VPX for the latest theater`, and say when it cleared. The layer's `loaded in` line carries a build
  id (`XR_APILAYER_CASTCADE_panel 0.3.0 build v0.2.30 …`; CI passes the tag or the short sha); a `0.2.0` line with no
  `build` is a 0.2.29-or-older dll. The update **to** this release is the last one that can hit the old bug: close VPX
  before it, or restart VPX and reinstall afterwards. `companion/src/media/vr-layer-stage.ts`, `vr-layer.ts`,
  `witness/witness.ts` (`startedAt` on the launch event), `vr-layer/CMakeLists.txt`, `vr-layer.yml`, `release.yml`.
- Pins: `fetch-vr-layer.mjs` and `fetch-audio-helper.mjs` name the v0.2.29 zips (D2.8.1).

### Table coverage, after the first night on 0.2.28 (C11.2, B24)
- The folder watch no longer rewrites a table patch that another program keeps removing. On the owner's rig Windows
  Defender quarantined the rendered `.vbs` of one original (Thundercats Pinball v1.0.9, `Trojan:Script/ObfusScript.A!ml`:
  the table's own obfuscated script, which VPX runs happily from inside the `.vpx`), and 0.2.28 wrote it again every
  30 s for an hour, a balloon each time. The watch now remembers what it wrote; a sidecar gone while the table file is
  unchanged is reported once (`sidecar watch: <table>: its Castcade patch (<file>.vbs) was removed right after Castcade
  wrote it, most likely by an antivirus quarantine …`, balloon "Castcade could not keep a table patch") and not written
  again until the file changes. When such a table is opened, Status and the close-time capture say `its earlier patch
  was removed from disk by another program, most likely an antivirus quarantine of the .vbs` and send the player to
  Windows Security → Protection history before Patch now. `companion/src/main/sidecar-watch.ts`, `witness.ts`
  `noticeUnpatched`, `exit-rung.ts`; ladder row (a) in `docs/design/table-import-and-patching.md` §6a.
- The VPS index refreshes itself (B24). The installer's index was frozen at a vps-db commit of 2026-10-19, so a table
  released after it could never be confirmed: the owner's Freddy file (VPS table `ZqH53HLaa4`, added 2026-10-31) was not
  in the "which table is this file?" picker and identity stayed "table ambiguous". The companion now rebuilds the index
  from vps-db `main` 30 s after start when its cached copy is missing or a day old, then daily (8 MB, `If-None-Match`,
  32 MB guard, 120 s timeout), into `%APPDATA%\Castcade\witness\vps\`, reloads it live (the picker and every lookup see
  the new tables without a restart) and falls back to the bundled index when the copy is missing, torn or empty. Status
  gains a "VPS index" row beside Maps version (`2,643 games · bundled 2026-10-19`, then `2,671 games · refreshed …`);
  the log says `witness: VPS index refreshed fffd511 (2671 games, 5798 table files, built …)`, `up to date` on a 304,
  `refresh skipped (<reason>)` on any failure. The build logic moved into the app (`vps-build.ts`); the packaging script
  is now `companion/scripts/fetch-vps.ts` under `tsx`, pinned to vps-db `70e1ff8e` (2026-11-02). `vps-refresh.ts`,
  `vps-index.ts`, `witness.ts`, `Status.tsx`.

## [0.2.29] — 2026-11-02

The second two-rig run on 0.2.28 (owner vs Krobs, 2026-11-02, two matches) found the stereo pair not fusing, only the
player's own table audible, and one match whose media mesh never connected. This release answers the first two and
adds the logging that will explain the third.

### Theater: a life-size stereo window (D7.4.5)
- A side-by-side picture (the sender's VPX "both eyes" preview) is no longer two halves on one shared 2.4 m screen. Each
  eye gets its own quad, offset by the receiver's eye pose (`xrLocateViews`) and sized and centred in tangent space from
  the eye field of view, cropped the way VPX cropped the eye render (`Player::PrepareVideoBuffers`), so every pixel
  reaches the receiver's eye in the direction the sender's eye rendered it. Life size by default (`kTheaterScale` 1.0;
  an optional `theaterScale` control field, 0.25–4, the companion does not send yet). The fov comes from VPX's own
  projection views, then `xrLocateViews`, then ±45°; the eyes from `xrLocateViews`, else ±31.5 mm. One
  `theater: stereo window, …` line per change in `vr-layer.log` names fov, IPD, render rect, crop and quads. Mono
  pictures and the panel are unchanged; pipe protocol stays 2. `vr-layer/src/layer.cpp`, `panel_pipe.cpp`, `vr-layer/README.md`.

### Theater detail (D7.4.6)
- The match video track asks Chromium for detail over motion (`contentHint = 'detail'`: keep resolution, drop frames),
  the bitrate follows the shape (2.5 Mbps for mono up to 1280x720 as before; 0.13 bits per pixel per frame above that,
  so 1280x1080 side by side gets 5.4 Mbps, 2560x720 7.2, 1440x1392 7.8, capped at 8), and portrait or near-square
  windows are sent at their own size (a 1440x1920 output box below aspect 1.5). `media: sending WxH sbs at N Mbps` once
  per capture; the 10 s counters carry the outbound size, bitrate and `qualityLimitationReason`, and the decoded size on
  the receiver. `companion/src/media/panel-page.ts` (`videoBitrateFor`), `capture-crop.ts`, `rtc-host.ts`.

### Table sound (D2.8)
- New helper `castcade-audio.exe` (`audio-helper/`, C++17, CoreAudio; built by `audio-helper.yml`, staged by
  `release.yml`, fetched by `npm run fetch-audio-helper -w companion`). While another player is up, this rig's VPX
  process tree, PinUP Player and the B2S server are muted at their Windows audio sessions on every render endpoint,
  re-scanned every 2 s; they come back on my grant, at the result, on Leave, on quit, when the companion dies (the helper
  unmutes on stdin EOF) and, through `--state`, after a crash of the helper itself. Only sessions the helper muted are
  unmuted.
- While I am up, the helper taps my VPX's sound alone (Windows process loopback, 10 2004+; never the voice coming out
  of my speakers) and the panel page sends it as a second audio track, stereo Opus, in a stream named
  `castcade-table-audio`; receivers play it only for the player up. Voice is unchanged. Three Match-tab switches, all on;
  "table sound unavailable" names a missing helper or an old Windows and never blocks a match. **Both players must be
  on 0.2.29**: a 0.2.28 receiver would play the table track as voice. `companion/src/media/audio-helper.ts`,
  `table-audio-policy.ts`, `panel-page.ts`, `main/match-host.ts`, `renderer/src/views/Match.tsx`, runbook "Table sound".

### Diagnosis carried in WORK.md
- D2.9: in EFUKTZ both logs show offer and answer exchanged and ICE in `checking` with no pair ever connecting; the
  same rigs connected in 0.3 s eleven minutes later. No TURN relay is configured. The fix (TURN, the nominated
  candidate pair in the counters, an ICE restart after 10 s in `checking`) is the next media item. New A10 (a series of
  games in one match, the host's next game on the table starts it) and A11 (start the match from inside the headset).
- The renderer bridge's type declaration gains `showPanel` / `hidePanel` (D2.6 wired them; `typecheck:renderer` failed).

## [0.2.28] — 2026-11-01

Everything since 0.2.27 (2026-10-31 evening to 2026-11-01 night): four agents' match and shell work while the headset
test waited, the table-coverage lane (four more agents after Krobs' Freddy posted only at VPX exit, then the Gottlieb
System 3 game-end fix from the owner's own rig), and the fixes for what the 2026-11-01 headset test found (five
two-player VR matches, owner vs Krobs). Untested on a rig as a whole: the D7.4.1 checklist runs again on this build.

- **Wire / journal:** protocol stays 2. Additive, defaulted fields only: `HELLO_ACK.tableMismatches` (A8), MEDIA_SIGNAL
  kinds `reset` and `stereo` with an optional `stereo` field (D2.7, D7.4.3; unlogged, so the match log hash is
  unchanged; a 0.2.27 peer drops them with a transport line). PARTICIPANT_UPDATE may now carry a rig after MATCH_READY
  (A6.1). The journal gains an informational `score_server` line with `castcade.vbs` 0.5.0 (C1.1; the decoder ignores
  lines it does not know; the three Phase 0 fixtures replay unchanged). New detector fixture
  `fixtures/nvram/cueball/2026-11-01-1` (Gottlieb System 3). The OpenXR layer's pipe protocol stays 2; the layer dll is
  rebuilt from this tag by `release.yml` (height-led theater screen, D7.4.3).

### Match in VR: what the 2026-11-01 headset test found (D2.6, D2.7, A6.1, D7.4.3, D7.4.4)
- **Voice and video no longer die when a player's VPX loads after host / join (D2.7).** The panel's move into the
  headset rebuilds its page and its connections; the fresh offer landed on peers whose connection to that player still
  stood and was refused ("the order of m-lines in subsequent offer doesn't match"), ending voice and video both ways. The
  mover now sends a `reset` signal first, a peer reopens that connection, and an offer that still fails on a connection
  with a remote description reopens it and re-applies. Per-peer ICE / signalling state goes to the log on change.
  `media/rtc-signaling.ts`, `media/panel-page.ts`, `media/rtc-host.ts`. Wire: MEDIA_SIGNAL gains the kinds `reset` and
  `stereo` (unlogged, protocol stays 2; an older companion drops them with a transport line).
- **A rig that reads VR after Start is told to the others (A6.1).** PARTICIPANT_UPDATE carries a rig in any phase; the
  roster and the log stay as MATCH_READY said, the Match tab and the panel show the latest rig. Before, both players read
  PC for the whole match when the table loaded after Start. `main/match-host.ts`, `match/host.ts`, `match/client.ts`.
- **The sender declares a both-eyes preview; portrait eyes (D7.4.3).** The receiver guessed stereo from the picture's
  shape (3:1 or wider), so a both-eyes window of 1920x1080 or 1440x1392 was drawn flat, two tables side by side. Now the
  sender reads `[PlayerVR] VRPreview` from VPX's active ini (a Match-tab override: auto / one eye / both eyes) and tells
  the peers on a `stereo` signal; the receiver trusts it whatever the shape or rig. VPX 10.8.0 centre-crops each eye to
  its half of the window, so a both-eyes window as tall as the monitor and about as wide (1080x1080 on 1080p) sends two
  portrait eyes: the table-only view; the theater screen's longer side is 2.4 m, so a portrait eye is height-led
  (`vr-layer/src/layer.cpp`). The runbook and the Match-tab hint say so (2560x720 is gone: it never fit a 1080p
  monitor). `media/preview-stereo.ts` (new), `renderer/views/Match.tsx`, `docs/alpha-match-runbook.md`.
- **The desktop match panel opens beside the main window, never over it (D2.6).** It is excluded from screen capture
  (so the match video never films it), which also makes it invisible through Virtual Desktop; centred on the display it
  sat exactly over the main window and took every click. Placed right / left / below the main window, clamped to the
  work area; the main window's bounds are remembered; Show panel / Hide panel on the Match tab, which names the window.
  `media/panel-placement.ts` (new), `media/rtc-host.ts`, `main/index.ts`.
- **A stalled capture is noticed and re-picked (D7.4.4).** The canvas track kept producing frames whatever the screen
  capture did, so a frozen capture looked alive to the receivers. The page watches the capture's own frame counter: no
  new frame for 3 s while sending → the video track is pulled (the receivers show "waiting for <name>'s table"), main
  logs `capture stalled`, re-picks the capture at most every 10 s, and the track comes back on the next frame. Counters
  every 10 s in the log: `capture: N frames` on the sender, `theater: N decoded, M sent to the layer` on a receiver.

### Table coverage: every table posts each game live (C11, B23, B14.2, B10.2)
- **New tables get patched without a trip to Settings (C11, C1.1.3).** The folder watch now plans every `.vpx` that has
  no sidecar and patches it in the same batch as the re-makes, with one notice per look; it does this only in a folder
  that was imported once (a fresh install still presses Patch my tables once). Tables an older build skipped for lack
  of a recipe (originals of class B/C/D) are picked up on the first look; unpatchable ones are remembered until the file
  changes. **Patch now:** the "table not patched" balloon and Status both patch the table in one click (the IPC accepts
  only the file the witness offered). **Every score read only at close now says why** (`exit-rung.ts`): the capture
  detail, Status ("Last close") and the log name the rung: not patched, live score not readable or no map, no recipe,
  partial recipe (the manifest now records `partial`), the hook never reported in, or live mode saw no game end (with the
  journal counts and the last decoded state). A tester's `companion.log` alone answers a Freddy-style report. Ladder:
  `docs/design/table-import-and-patching.md` §6a.
- **Bally and Stern M100 tables score live (unverified); the Gottlieb System 3 ball decode is fixed (B10.2, B10.3).**
  Bally AS-2518-17/-35 and Stern M100 keep ball and player in CPU RAM, out of the hook's reach. Their NVRAM holds the
  GAME OVER lamp, the score displays and the last game's scores, so a new detector (`ballyTransition`, `liveSupport` via
  `bally_lamp`) starts a game on the lamp going off with blank displays and ends it when the last-game scores match the
  displays. About 125 more games are listed as readable, marked unverified until a rig recording lands; a wrong guess
  only costs the live post, since the `.nv` still posts at close. **Gottlieb System 3 games now end live** (the cause of
  "Freddy posted only when VPX closed", found on the owner's rig 2026-11-01 with Cue Ball Wizard, the first System 3
  recording, `fixtures/nvram/cueball/2026-11-01-1`): System 3 clears the ball byte about 3.5 s before it clears the
  player count the map reads as game over, so at the game-over step the detector saw no ball in play, derived neither
  the last ball end nor the game end, and the game surfaced only as `game_abandoned` at table exit ("abandoned on ball
  0"). The detector now remembers the last ball in play (`lastInPlay`) and ends the game from it; WPC and Data East
  are unchanged (their fixtures replay the same). The idle bit that System 3 then sets in the ball byte (0x80; the
  owner's `.nv` files also show 0x70 / 0x90 at rest) is masked: the companion reads the low nibble on that platform when
  the map gives no mask (a map's own mask wins; the corpus files are unchanged).
  `docs/design/platform-coverage.md` records why Stern M200, Williams System 4–7, Gottlieb System 80/80B/1, Atari gen 1,
  Zaccaria and Capcom stay unsupported, with the recording recipe per family. Test maps vendored under `fixtures/maps`.
- **The witness-games list no longer calls ROM games originals (B23).** For a solid-state game VPS lists no ROM for
  (type SS or unknown), `buildSupportList` takes the ROMs from pinmame-nvram-maps by matching the `romnames.json` name
  and the map's manufacturer folder to the VPS name and manufacturer; EM and pure-mechanical games never take one, and
  same-named pairs of one manufacturer (2 games) are left as no ROM. Each game carries `romSource`; the counts gain
  `romsFromCorpus` (77) and `romsAmbiguous`, with the names on the script's last lines. Gottlieb System 3 went from 4 to
  25 supported games, Freddy among them. Import and live scoring were never affected: they read `cGameName` / the hook's ROM.
- **List shape (B14.2).** A game whose ROMs differ in status or reason carries `romsDiffer` and the Markdown ROMs cell
  shows each ROM's status; `verified` is claimed only for the machine the recording was made on (JP's The Walking Dead
  and The Return Of The Living Dead, both on `twd_160h`, are now `supported` with the reason); `docs/witness-games.json`
  for ArcAid is compact (no per-ROM `live` or `map`; 1.17 MB → 0.98 MB, stable key order); the Markdown rendering is a
  tested pure function in `support-list.ts`. The list after all three: 2365 games, **11 verified, 447 supported,
  1907 unsupported** (was 13 / 297 / 2055).

### Table import: original tables post (C1.1)
- Recipes **B** (JPSalas-pattern originals: `ResetForNewGame`, `AddScore`, top of `EndOfBall`, `EndOfGame`), **C**
  (Scorbit-anchored: the seven arguments of `Scorbit.SendUpdate`, start/stop one call site up) and **D** (ScoreServer:
  `CreateObject("VPinball.ScoreServer")` becomes the library's shim, which journals `SetGameState` / `SetScoresArray` as
  the usual events and forwards every call to the real object when one exists). Class E (generic) is still skipped with
  its reason. The import plans and applies B–D, manifests accept them, the undo is exact for A–D, and the unpatched-table
  notice sends B/C/D players to Patch my tables. `castcade.vbs` 0.5.0 (`Castcade_PlayerScores`, the shim, an
  informational `score_server` journal line); recipe versions are per recipe (`RECIPE_VERSIONS`, A 0.3.1, B/C/D 0.1.0),
  so a later B bump no longer re-makes A sidecars. The lib bump re-makes every existing sidecar on the first look (B15).
  A table an older build skipped needs one press of Patch my tables. `companion/src/patcher/render-originals.ts`,
  `render.ts`, `import.ts`, `vpx-hook/castcade.vbs`; design §5 "As built".
- Rig survey (C1.2): 140 tables, A 102, B 24, C 1, E 9, X 3, 1 unreadable; all 25 B/C render without a partial.

### Match (alpha, A8)
- Every client sees which participant's table differs, not only its own: `HELLO_ACK.tableMismatches` (additive,
  defaulted, still protocol 2; re-sent to everyone on each lobby change; not in MATCH_READY, which is hashed into the log).
- The mismatch list survives a host transfer (`resumeFromLog` / adopt options).
- After a drop, the reconnecting companion sends RESUME itself; the host's Match tab has a Resume button for a pause
  nobody resumes; a pending host transfer shows on the Match tab (no accept/decline: the engine acks by log agreement).
- The host's listener opens only after the panel is up and the public-IP lookup has settled; a port in use tears the
  half-built match down. `protocol/src/messages.ts`, `companion/src/match/{host,client,controller}.ts`, `main/match-host.ts`.

### Shell
- E6: Restart to update runs the orderly shutdown (capture, match, overlays, host) before the updater installs, so a
  running capture's ffmpeg pair is no longer orphaned. `companion/src/main/index.ts`.

### Docs
- I1: `docs/design/sanctioned-vpx-build.md`, the design of the sanctioned VPX build (ADR 0008), a draft for the owner.
- H5: `LICENSE` (GPLv3) at the repo root.

## [0.2.27] — 2026-10-31

After the third match (0.2.26): the OpenXR layer loaded and drew in both headsets, but the panel sat in the line of
sight and showed during the player's own turn, and the other player's video went black whenever a browser or Castcade
was the foreground window on a VR rig.

### Match (alpha)
- D7.4: **theater mode**. During the other player's turn the layer removes VPX's own view from the frame and shows the
  opponent's feed on a large fixed screen 2.6 m ahead (re-centred to where you face when it begins), dark all around,
  in **stereo** when the sender's VPX VR preview is set to both eyes (`[PlayerVR] VRPreview = 3`, side by side) and
  mono otherwise, with a 150 ms dip to black on each change. During your own turn nothing is drawn; the lobby, pauses
  and the result show the small panel, now low below the playfield line of sight. Two Match settings: what to show
  while the other player plays (theater or the panel) and during your own turn (nothing or the panel). The layer's
  pipe speaks protocol 2 (a hello, a control message, a separate video stream); an old companion still gets the panel,
  and five seconds without frames hands VPX's view back. Sender side: a side-by-side preview goes out at up to
  2560x720 (720 rows per eye). `vr-layer/` 0.2.0, `media/vr-layer.ts`, `panel-page.ts`, `match/controller.ts`.
- D2.5 follow-up: the "Paused" cover never fires on a VR rig (the preview window renders without focus; a browser in
  front had blacked out the other player's video for 30 s).

## [0.2.26] — 2026-10-31

After the second two-player match (all three balls each to a signed result; the other player's video froze the moment
VPX took focus on his PC, and nothing showed in the headsets).

### Match (alpha)
- D2.5: the match video films the **screen** and crops to the player window (the same Desktop Duplication path the
  solo stream engine uses) instead of Chromium's window capture, which freezes once VPX has focus in VR; the picture
  is covered ("Paused: back in a moment") while VPX is not the window in front (D1.9), re-cropped when the window
  moves, and the desktop panel is kept out of the capture. The roster wording follows what differs: `different table
  file`, `same table, different file (a re-save or another download)` when only the hash differs, and a separate muted
  `different VPX build` (the two rigs run Panasony 2078 and 2058). `media/capture-crop.ts`, `rtc-host.ts`,
  `panel-page.ts`, `match/controller.ts`.
- D7.3: the **in-headset panel on OpenXR rigs**: `vr-layer/`, an implicit OpenXR API layer (`XrApiLayer_castcade_panel`,
  C++, OpenXR-SDK release-1.1.65 headers, CI-built) that loads inside `VPinballX*.exe` on any runtime (Virtual Desktop,
  Oculus, SteamVR), takes the panel frames over a named pipe from the companion and appends them to every frame as
  an `XrCompositionLayerQuad` 0.55 m wide below the line of sight; OpenGL and D3D11 sessions; inert without a client;
  `XR_DISABLE_CASTCADE_PANEL=1` turns it off. The companion registers the layer for the current user when a match
  opens in VR on a non-SteamVR runtime, so **VPX must be started after Castcade has hosted or joined once**; the Match
  tab says `restart_vpx` until then. The SteamVR helper (D7) stays for SteamVR rigs. `media/vr-layer.ts`,
  `media/panel-frame-writer.ts`, `main/match-host.ts`; built by `.github/workflows/vr-layer.yml`, fetched by
  `npm run fetch-vr-layer -w companion`.
- A6: the lobby refresh only moves a monitor rig into VR; a runtime swap stays with the status listener (the merge of
  the two had told the media layer twice).

### Tests
- A9: `fakeclient/src/ws-reconnect.test.ts` "an unknown log hash is rejected" was racy (the test's trace detached when the
  host finished, ~34 ms before the rejection); it listens on the `HostMatch` now. The engine was correct.

## [0.2.25] — 2026-10-31

After the first two-player match (owner vs Krobs, Monster Bash, both in VR over Virtual Desktop, on 0.2.24: turns,
lock, cue, voice and live scores all worked across the two routers on the first try).

### Match (alpha)
- D2.4: the up player's video was missing for ball 1 and present from ball 2, because the capture started on the first
  turn when no player window existed at Host; the capture now starts as soon as a player window appears (a 3 s
  re-probe while attached) with the track added in the lobby, so the first turn only flips it on. The VR fallback
  never sends a DMD, backglass or PinUP window any more (Krobs' 1x1 VRPreview left the DMD as the largest VPX
  window); with no playfield window the Match tab and panel say to turn VRPreview on. `media/rtc-host.ts`.
- D2.4: the lobby refreshes each player's rig and table file when a table loads after Join (new `PARTICIPANT_UPDATE`,
  client → host, protocol 2; the host re-sends `HELLO_ACK` with the roster), so a player who joined before loading
  the table no longer stays `PC` / "different table file". A real mismatch still flags. `match/host.ts`, `client.ts`,
  `main/match-host.ts`.

## [0.2.24] — 2026-10-31

### Witness
- B22: the VR probe recognises OpenXR runtimes. The owner's rig runs VPX's OpenVR calls through OpenComposite onto
  Virtual Desktop's OpenXR runtime with no SteamVR at all, so the old rule (SteamVR client in the process + compositor
  running) had never once seen VR there and every score went out as `play_device=pc`. The probe now names the runtime
  (`steamvr`, `virtual-desktop`, `oculus`, `openxr-other`) from the modules in the VPX process plus the active OpenXR
  runtime in the registry; `play_device=vr_headset` follows. `witness/vr-detect.ts`.

### Match (alpha)
- A6: the in-headset panel is started only when VPX runs through SteamVR (the OpenVR overlay helper draws into
  SteamVR's compositor); on any other VR runtime the panel stays as a visible desktop window and the Match tab says
  so, with what would move it into the headset. The rig line names the runtime.
- A6: the microphone list fills when the Match tab opens, not only after Host or Join (Krobs saw only "Windows
  default"); a right-click Cut / Copy / Paste menu app-wide and a Paste button on the Join field and the pairing code
  (Krobs could not paste the invite).

## [0.2.23] — 2026-10-31

### Match (alpha)
- A6: the rig (VR headset or monitor) is decided the moment you Host or Join, by probing the running VPX process
  right then, not from the sample taken when the VPX process started (on the owner's rig that first sample ran
  before the player had loaded its VR runtime, so 0.2.22 built the desktop panel and never started the headset
  overlay). The witness also re-samples VR when the table loads. If the decision was "monitor" and VR shows up
  later, the panel moves into the headset and the overlay starts. The Match tab shows `Rig: VR headset (…)` /
  `Rig: monitor (…)` with the reason. `main/match-setup.ts` (`decideRig`), `match-host.ts`, `media/rtc-host.ts`
  (`setVr`), `witness/witness.ts` (`sampleVr`).

## [0.2.22] — 2026-10-31

The alpha match build. Released untested on a rig so both players' companions receive it through the updater; the
checks before the first match are `docs/design/alpha-match.md` §6 and `WORK.md` (Now).

### Match (alpha): two players, one table, video and voice in the headset
- A6 + C3: a **Match** tab. Host shows an invite (`castcade:ws://<ip>:<port>#<code>`, default TCP 27401, the public
  IP from api.ipify.org with the LAN address as the fallback); Join pastes it. `match/controller.ts` turns the
  engine's grants into the turn lock (`%LOCALAPPDATA%\Castcade\lock\turn.lock`: the hook swallows flippers,
  plunger, nudge and Start while it exists, so each player starts their own one-player game when their first grant
  arrives) and a sound cue in the headset, and turns the witness's live events into `BALL_END` (the score sampled at
  the next `current_scores` or 2 s after the ball end, shoot-again from the detector's extra balls), `GAME_OVER` and
  `STATE`; the result is signed by every companion and shown on both sides. Each player's game still posts to ArcAid
  as a normal Witness score; the Throwdown result on arcaid.app is still A5 / F6. Keys in `match-keys.json`,
  settings in `match.json`. Design: `docs/design/alpha-match.md`; runbook: `docs/alpha-match-runbook.md`.
- D2: video and voice between the players over WebRTC, peer to peer, signalled with the new `MEDIA_SIGNAL` message
  through the host (never logged, never through ArcAid). A full mesh for 2–4 players: every rig sends its microphone
  (Opus, echo cancellation and noise suppression, open mic with Mute; a named microphone, because the Windows default
  in VR is often a virtual device); video goes only from the player up (the VPX player / VR preview window at up to
  1280x720, 30 fps, 2.5 Mbps). Google STUN by default, an optional TURN in `media.json`. The **panel** (one page:
  the peer connections and the in-headset UI: the up player's video, `YOUR BALL 2` / `<NAME> IS UP`, scores, mic
  state) is a desktop window on a monitor rig and an offscreen window in VR. `media/rtc-host.ts`, `panel-page.ts`,
  `rtc-signaling.ts`, `media-settings.ts`.
- D7: `vr-overlay/`, a C++ OpenVR overlay helper (`castcade-vr-overlay.exe`, OpenVR SDK v2.15.6, BSD-3) that draws
  the panel inside the headset over VPX's VR session: frames arrive over stdin (BGRA, a 16-byte `CVO1` header), the
  overlay is head-anchored 0.55 m wide below the line of sight, hides after 5 s without frames, exits 2 when SteamVR
  is not running. Built by `.github/workflows/vr-overlay.yml` on windows-latest, fetched into the installer by
  `npm run fetch-vr-overlay -w companion`, driven by `media/vr-overlay.ts`.
- Protocol 2 additions: `MEDIA_SIGNAL`, `HELLO_ACK.hostGame` (a table-file mismatch is advisory on both sides, shown
  as "different table file", never a refusal in `advise` mode).

### Streaming and recording
- D1.5: a `Stream` tab replaces the card on Settings. **Preview** opens the bundled ffplay on exactly the picture the
  stream would carry (the engine's window probe, portrait slice, rotate and burned-in overlay; `media/preview.ts`),
  on the other monitor or beside the captured area, and restarts when shape, slice, rotate, quality or overlay
  changes; it closes with Q or the window's X, on Stop, and on quit. A health table shows fps against the preset,
  speed, frames, restarts, the segment and the cover state while capturing. New settings on the page: the recordings
  folder (Choose… / Use default), a cap on MP4s kept, game volume, the audio delay (under Advanced). The OBS overlay
  card moved to the Stream page. Microphone capture is still not built; the page says so.
- D1.7: a recording whose score a Sanctioned tournament took is kept until that tournament closes. The manifest's
  `score_posted` line carries `sanctioned` and `tournament {id, name, closesAt}` from the score answer's optional
  `tournament` object (ArcAid hand-off §18, F16; nothing is served yet, so today's behaviour is unchanged), and
  retention keeps the session while `closesAt` is in the future or unknown. `media/recording.ts`,
  `witness/arcaid-client.ts`.

### Witness
- B21: a **Start attempts** button on Status presses Start for the open start-required limited-attempts tables this
  device's plays land on (`GET /api/witness/attempt-start`, ArcAid 2.188.0, W45), narrowed to the loaded table when
  there is one; the result line and "Sending to" refresh from the answer. When a game's attempt call answers that
  Start attempts was not pressed, Status says so and points at the button. `witness/arcaid-client.ts`
  (`attemptStart`), `witness/witness.ts`, `renderer/src/views/Status.tsx`.
- B8: the ROM → VPS game map is read from ArcAid (`GET /api/witness/roms`, ArcAid 2.193.0, W12) after the witness
  starts and after pairing, then daily with `If-None-Match`, cached in `witness/roms.json`; an exact served ROM wins
  over the shipped vps-db seed, an ambiguous or unknown ROM falls through to the seed and its family rule. Log line
  `witness: ROM map <version> (<n> ROMs, served|cached|seed)`. `witness/rom-map.ts`.
- B14: `npm run witness-games -w companion` generates the platform-wide list of witness-supported games from the VPS
  index × the maps corpus: `docs/witness-games.md` for tournament directors and `docs/witness-games.json` for ArcAid
  (2365 VPX games: 13 verified, 297 supported, 2055 unsupported with the reason; vps-db `cce9160b`, maps `f0c42209`).
  `witness/support-list.ts`.

### Protocol and match engine (no app wiring yet)
- H3, A2, A3: `protocol/docs/prose.md` gains the WebSocket paragraph under "Host transfer" and a "Reconnect" section;
  **protocol 2**: `HOST_TRANSFER.newHostEndpoint` (a `ws://` / `wss://` URL, null on the in-memory bus), new
  `RECONNECT` (`player`, `logHash`, `logLength`, signed with the roster key) and `RECONNECT_ACK` (`accept`, `code`,
  the missing `entries[]`, `logHash`, `logLength`; rejections `unknown_log_hash`, `unknown_player`, `bad_signature`,
  `match_not_started`), and `LogEntry` as a schema. `companion/src/match/transport-ws.ts` adds `WsPeerTransport` (one
  role-agnostic listener + outbound links); the new host opens its listener before the proposal, the old host relays
  the acks and reconnects to the new host after the commit; a dropped client retries once a second for 30 s, resumes
  from its log head and verifies each replayed entry's chain. Gates `fakeclient/src/ws-transfer.test.ts` and
  `ws-reconnect.test.ts` run over real sockets on 127.0.0.1 in `npm test`. v1 peers are refused on HELLO.

### Packaging
- E5: the GPL Corresponding Source of the bundled ffmpeg. `docs/ffmpeg-source.md` holds the written offer (GPLv3
  §6(b), three years from each release, by GitHub issue) and the library list copied from the build's README;
  `SOURCE-OFFER.txt` ships beside `ffmpeg.exe`; `npm run ffmpeg-source -w companion` downloads FFmpeg at the build's
  commit and `release.yml` uploads `ffmpeg-<version>-source.tar.gz` + `-SOURCES.txt` to each release (the step never
  blocks a release).

### Wire / journal
- Score parameters and the journal format are unchanged (hook 0.4.1). New calls: `GET /api/witness/attempt-start`
  (B21) and `GET /api/witness/roms` (B8). The score answer's optional `tournament` object (§18) is read when present.
  The recording manifest's `score_posted` line gains optional `sanctioned` and `tournament` fields (additive; the
  hash chain is unchanged).

## [0.2.21] — 2026-10-30

### Witness
- B19: the game-start report (the attempt on a limited-attempts board) carried the VPS game resolved from the file name
  alone; the score, re-matched by ROM, carried the right one. For "Tron Legacy (Stern 2011) VPW Mod v1.1" the file name
  resolved to VPS's 2016 original "TRON Legacy", so ArcAid matched the start to nothing and the score landed as
  `start not reported`: the attempt was used and the score did not count (Krobs, Arcaid Witness Demo, three games on
  2026-10-29). The identity is now pinned by the ROM the moment the journal's `table_loaded` names it, before the start
  goes out (`witness: identity pinned by ROM …` in the log), and a file whose `(Manufacturer Year)` disagrees with the
  only same-named VPS game on both halves resolves to nothing rather than to that game; one half off (a re-release
  year) stays `likely`, as before. `witness/witness.ts` (`pinIdentityByRom`), `witness/table-match.ts`
  (`parentheticalContradicts`).
- B20: when a score lands on the Global Scoreboard instead of a board, Status says why in ArcAid's words ("no open
  game matched …", "played before … went up in …", "your device is set to send to …"; ArcAid's `notCounted`, W27),
  so the player need not ask. A refused attempt ("no game start was reported for this score", "reported late") is
  shown as "not counted for the tournament", no longer as "Sanctioned play". `witness/arcaid-client.ts`,
  `witness/witness.ts` (`outcomeForWire`).

### Wire / journal
- Score parameters, the attempt call and the journal format are unchanged (hook 0.4.1). The attempt call's `vps_game`
  now carries the ROM-pinned game, as the score call already did. The score answer's optional `notCounted` (ArcAid W27)
  is now read; answers are not recorded as fixtures, `witness/arcaid-client.test.ts` covers the parse.

## [0.2.20] — 2026-10-30

### Table import and hook
- C10: saving a patched table in the VPX editor copies the Castcade script into the table itself; a tester's colour
  change then brought the "made for an older version of this table" dialog at every launch and "Patch my tables"
  refused the table as already patched. Hook 0.4.1's guard is silent when it runs from the table (it journals
  `embedded_patch` instead), the importer and the folder watch patch the script underneath instead of refusing, the
  witness arms live mode on such a table, tells the player once and puts a fresh script beside it, and the script
  inspection no longer reads the patch as a hand edit. The Tables card and the tester kit say so. `vpx-hook/castcade.vbs`,
  `patcher/import.ts` (`patchSource`), `main/tables-host.ts` (`repair`), `witness/witness.ts`.

### Witness
- B18: Castcade started while the VPX player window was already up (the title names no table) now names the table from
  the newest hook journal whose `table_loaded` falls inside that process's lifetime, takes the `.vpx` from the import
  manifest, and arms live mode at once instead of learning the table when play ends. A journal from an earlier
  process is never taken. `witness/journal-scan.ts` (`newestJournalSince`), `witness/witness.ts` (`tableFromJournal`).
- B17: a Castcade restart while the same VPX process stays open no longer re-posts that process's earlier games.
  Live mode remembers every game it posted in `posted-games.json` (key = table id + the attempt key ArcAid dedupes
  on, capped at 2000); a replayed game is followed to its end and posts nothing, and the `.nv` rewrite at close
  stays suppressed. Games played while Castcade was not running still post. `witness/posted-games.ts`, `witness/witness.ts`.
- B4.1: the playfield fingerprint's record tags are pinned against a tag census of a real table
  (`fixtures/playfield/tags.json`, tag names and counts only, recorded from the rig's Medieval Madness, file
  version 1080); a VPX release that renames a tag now fails `npm test`, not a tournament. Re-record with
  `npm run playfield-tags -w companion -- "<table.vpx>"`. `witness/playfield-fingerprint.ts` (`playfieldTagCensus`),
  `companion/scripts/playfield-tags.ts`.

### Streaming and recording
- D1.4: the overlay (table, score per player with the player up and the ball, the limited-attempts line, the last
  post, the Arcaid Witness badge) is burned into the stream and the recording: the same state as the OBS page,
  written as text to `stream-overlay.txt` (overwritten in place) and drawn by ffmpeg's `drawtext` with `reload=1`.
  On by default; Settings → Stream and record → "Overlay in the stream and recording" turns it off for OBS users
  who draw the browser-source overlay themselves. No font, no overlay (as for the slate). `media/overlay-text.ts`,
  `media/stream-engine.ts`, `media/ffmpeg-args.ts` (`overlay`), `main/stream-host.ts`, `views/StreamCard.tsx`.

### Wire / journal
- Score parameters and the match protocol are unchanged. The hook is 0.4.1 (`vpx-hook/castcade.vbs`, `patcher/render.ts`
  `LIB_VERSION`): one new journal line, `embedded_patch`, written when the guard runs from a script the VPX editor saved
  into the table; `recipe_version` stays 0.3.1 and every existing line is unchanged. No recorded fixture carries the new
  line yet (the detector and witness tests cover it, `witness/journal-detector.test.ts`); Krobs' saved table is the field
  gate (C10.1). New local file `posted-games.json` beside the post queue (B17).

## [0.2.19] — 2026-10-29

### Streaming and recording
- Castcade records and streams on its own: Settings → **Stream and record** (and the tray) has Go live and record,
  Record only and Go live only, the stream key (Twitch, YouTube or any RTMP URL; stored encrypted, never shown again,
  never sent to ArcAid), shape (vertical 9:16 slice or the whole window), rotate (for VPX cabinet mode), quality and how
  many sessions to keep. A session outlives one table: quitting to the editor ends that recording segment and a live
  stream shows a "back in a moment" screen until the next table opens; a capture or stream connection that drops
  restarts by itself (D1.3). `media/stream-engine.ts`, `media/stream-settings.ts`, `main/stream-host.ts`,
  `views/StreamCard.tsx`, `main/tray.ts`.
- Recordings go to `Videos\Castcade`, one folder per session: an MP4 per table played and a hash-chained
  `manifest.jsonl` holding each MP4's sha256, game starts and ends, and every score posted while it recorded; the newest
  3 sessions are kept by default (D1.2). `media/recording.ts`.
- Smooth video: a capture runs as two ffmpeg processes, one grabbing and encoding the screen and one adding the game
  sound and writing the MP4 / stream, so waiting for the sound can no longer pause the screen grab. In one process the
  ball froze for 50–100 ms several times a second (15–18 new frames a second at 1080p60 on the owner's rig); a test
  pattern now keeps 276 of 300 frames new with the sound up to 400 ms late. Stopping lets the second process finish the
  file, so the last second is no longer lost (D1.8). `media/ffmpeg-pipeline.ts`, `media/ffmpeg-args.ts` (`captureArgs`).
- Sound and picture line up (medians within about 40 ms over several flash-and-beep runs, the owner heard them in sync):
  the sound starts with the first video, travels in ~21 ms chunks instead of 100 ms, and is delayed 145 ms by default.
  The setting is now `audioLateMs` (negative = delay), written to the settings file only when changed from the default,
  so a retuned default still applies; a stored `avLateMs` from the one-process capture is ignored.
  `main/stream-host.ts`, `media/stream-settings.ts`.
- The desktop never goes out on the stream or into the recording: the moment VPX stops being the window in front
  (alt-tab, a click on another window), the picture is covered with "Paused: back in a moment" within about a tenth of
  a second, without restarting the capture or dropping the stream; it comes off 0.75 s after VPX is back in front. The
  recording's manifest marks each covered stretch and what was in front, and Settings says when the stream is covered.
  The owner's first long stream had sent a chat window out twice (D1.9). `media/focus-watch.ts`,
  `media/ffmpeg-args.ts` (`coverCommand`; the screen grab is now an ffmpeg input so the cover takes commands),
  `media/stream-engine.ts`, `main/stream-host.ts`, `views/StreamCard.tsx`.
- A score that posts after its table was closed (the witness posts about a second after the game) is tied to the
  recording its game was played in, not to none. `media/stream-engine.ts`.
- A monitor turned to portrait in Windows (the usual desktop VPX setup) streams upright. Screen capture delivers such a
  monitor's picture unrotated, so the table came out on its side; the window probe now reads each monitor's rotation,
  the capture region is mapped into the panel's own frame and the picture turned back after scaling. Found on the
  owner's rig with the D1.0 preview. `media/window-geometry.ts`, `media/ffmpeg-args.ts` (`ddagrabRegion`).
- A rotate option for VPX in cabinet mode, where VPX draws the table on its side for a monitor that stands portrait but
  that Windows calls landscape: the picture turns 90 / 180 / 270 degrees clockwise after scaling, combined with any
  monitor rotation into one turn, and the vertical slice follows the turn. The D1.0 spike takes `--rotate`; the Stream
  page will offer it beside the preview (D1.5). `media/ffmpeg-args.ts` (`rotate`), `window-geometry.ts` (`portraitSlice`).

### Witness
- Opening an original table (no ROM: JPSalas-style, Scorbit-anchored, ScoreServer or generic script) now says Castcade
  can't read its score yet and its games won't post. It used to say "only the last game of this session will post",
  which is true only for ROM tables: an original leaves no NVRAM, so nothing posted (owner's TNA game, 2026-10-28).
  `witness.ts`.

### Packaging
- The installer carries ffmpeg for streaming and recording: Gyan's GPLv3 essentials build of ffmpeg 8.1.1 (`ffmpeg.exe`
  and `ffplay.exe` for the framing preview, its LICENSE and README), pinned by sha256 and fetched at package time by
  `npm run fetch-ffmpeg -w companion` (`release.yml` runs it). The installer grows by about 54 MB; recording
  and streaming run on it (D1.2 / D1.3); `Castcade.exe --smoke` reports `ffmpeg bundled <build>`, and the D1.0 spike's
  `--bundled` runs on it (D1.6). `scripts/fetch-ffmpeg.mjs`, `media/ffmpeg-path.ts`, `electron-builder.yml`.

## [0.2.18] — 2026-10-27

### Streaming
- An overlay for OBS: Castcade serves a page on `http://127.0.0.1:47390/overlay` (Settings → OBS overlay has the
  address and a Copy button) that a streamer adds as a Browser source. It shows the table, the score of the player up
  (every player's in a multi-player game), ball and player, "Game over", the Witness badge (live / last game only / not
  paired) and the limited-attempts line, and follows the game live over server-sent events. Loopback only, a foreign
  Host header is refused; `?scale=` and `?side=right` adjust it; a taken port is logged and leaves it off (D1.1).
  `media/overlay-server.ts`; the witness's new `game` event (`LiveGame`) feeds it.
- The D1.0 stream spike (developer tool, not in the app) gains `--preview`: an ffplay window shows the stream's exact
  crop, scale and overlay before going live, and nothing is recorded or sent. `media/ffmpeg-args.ts`
  (`ffplayPreviewArgs`), `media/window-geometry.ts` (`previewPlacement`), `scripts/stream-spike.mjs`.

### Witness
- A game quit before game over says so: the score call carries `quit=1` and, when the machine reports it,
  `quit_ball` (the ball in play); a game played to game over carries `quit=0`. ArcAid marks quit games on the board
  (owner ruling 2026-10-27; ArcAid side `docs/arcaid-side-changes.md` §16). The game still posts and counts (B16).
- Wire: `quit` (0/1) and `quit_ball` (1–10) are new optional query params on `/api/witness/score`; neither is sent when
  game over is unknown. Covered by the TFTC journal fixture cut at ball 2 (`witness.test.ts`). `witness.ts` (`quitWire`),
  `capture.ts`, `queue.ts`, `arcaid-client.ts`.

### Import
- "Patch my tables" removes Castcade's own patch from tables whose machine's live score can't be read (patched
  before 0.2.17's rule): the sidecar, any `.stale` copy and the manifest. A script that is not Castcade's is never
  touched; the preview says "Castcade's earlier patch will be removed" (B12.1).

## [0.2.17] — 2026-10-26

### Import and Status
- The import no longer patches a table whose machine keeps its live score where the hook cannot see it: it is listed
  as "not patched: this machine's live score can't be read yet" with the reason (no map for the ROM, or the fields in
  CPU RAM). The rule: scores, game over, current ball and current player inside NVRAM; Stern SAM qualifies through its
  end-of-game record. On the owner's 140 tables: 84 readable (74 + 10 SAM), 17 not (8 without a map; Gottlieb System
  1 / 80 / 80B, Williams System 6, Bally 17). A sidecar made before the rule stays (remove-all deletes it). Status
  shows such a table as basic with the reason instead of "live — every game", and an unpatched one is no longer sent
  to "Patch my tables" (B12). `maps.ts` (`liveSupport`), `patcher/import.ts`, `witness.ts`.

### After an update
- Re-making every table patch after an update no longer re-hashes each `.vpx`: a table whose path, size and timestamp
  are unchanged keeps its recorded hash, so a re-make costs a script read (2 ms a table on the owner's SSD, was 211 ms).
  On Krobs' hard disk 334 re-makes took three minutes after 0.2.16 installed, and Walking Dead, opened in that window,
  ran its old patch: no SAM score was recorded and only the last game posted, at close (2026-10-26). `patcher/import.ts`.
- A table that loads an older Castcade patch than the build makes says so: Status and a balloon ask the player to close
  and reopen it (B15). `witness.ts`.

## [0.2.16] — 2026-10-26

### Live mode
- A second table opened from the VPX editor, without quitting VPX, now gets its own live mode. Before, the session
  kept following the first table's journal: the second table never armed, its file was checked against the first
  table's manifest and its good sidecar renamed `.stale`, and its close-time `.nv` was dropped as the first table's
  (AC/DC then Walking Dead, 2026-10-26). Going back to a table does not post its earlier games twice. `witness.ts`
  (`switchTable`, `checkLiveHash` compares a manifest with its own table only, `liveRead`).

## [0.2.15] — 2026-10-26

### Live mode
- A patched table whose script opens with a long comment banner now runs in live mode. The patched check read only the
  sidecar's first 8 KB, and on 8 of the owner's 102 tables (AC/DC, 24, Transformers, Bad Cats, Hook, both Batmans,
  Black Knight 2000) Castcade's block starts past it, so they were judged unpatched: no game start was reported and a
  Limited-attempts tournament refused the score (AC/DC, 2026-10-26). `witness.ts` (`hasSidecar` reads the whole file).

## [0.2.14] — 2026-10-26

### Scoring coverage
- Maps corpus moved from `f16a0cc` (2026-08-26) to `f0c4220` (2026-10-24): 91 upstream commits, new maps and fixes
  (Whitestar, Gottlieb System 1, SAM). All 1,589 ROM entries compile; the five recorded fixtures replay unchanged. Pins:
  `fetch-maps.mjs`, `ci.yml`, `fixtures/maps` (its four vendored maps refreshed). Upstream's new SAM live fields do not
  make SAM work here: ball, player and game over sit in CPU RAM, which `ChangedNVRAM` does not report (B10).
- **Stern SAM tables post scores** (B10.1; AC/DC, The Walking Dead and the other SAM ROMs the corpus maps with scores).
  SAM keeps ball, player and game over in CPU RAM, out of the hook's reach, so the detector reads the game from NVRAM
  alone: the scores resetting to 0 start a game (the Limited-attempts attempt), and the last-game record SAM writes 16
  bytes before player 1's score ends it, its counter rising by the player count, with the final scores already in
  place. No ball events on SAM; a game quit mid-way is `game_abandoned` at exit, and a restart from the start button
  abandons the open game. `journal-detector.ts` (`samTransition`), `maps.ts` (`samEndCounter`).
- **Watch lists count from the start of NVRAM** (recipe 0.3.1). The sidecar's `Castcade_WatchBytes` held the map's
  machine addresses, which match `ChangedNVRAM`'s offsets only where NVRAM starts at 0 (WPC, Data East, Whitestar,
  System 11, Gottlieb System 3). On Stern SAM, Gottlieb System 1/80/80B, Bally, Stern M100/200 and Williams System 4–7
  nothing matched and no change was journaled. The recipe bump makes every sidecar stale, so the companion re-makes
  them all on its first look after the update; no re-import by hand. `maps.ts` (`gameStateOffsets`), `patcher/render.ts`.
- Wire / journal: format unchanged; `recipe_version` 0.3.1 in `table_loaded`. Fixtures `nvram/acd_170h/2026-10-25-1`
  (three games and a quit, all bytes journaled) and `nvram/twd_160h/2026-10-26-1` (two games and a quit), recorded on the
  owner's rig; `fixtures/check.py` skips them (`"oracle": false`: the Phase 0 tailer has no SAM rules).
- A ROM name is looked up without regard to case: tables that write `cGameName = "SS_15"` or `"Hook_501"` found no map
  (`witness/maps.ts`).

### Fairness
- Script inspection, first half (F5, B5.1–B5.2): at launch the companion works out which script ran — the table's
  own, Castcade's untouched patch of it, Castcade's patch edited by hand, or someone else's sidecar `.vbs` — and diffs
  it against the table's embedded script (Castcade's own patch is undone exactly first, so it never shows). Each change
  is classified allowed (a cosmetic option: VR, DMD, sound, lights), restricted (a name that changes play —
  difficulty, outlanes, ball size or mass, ball saver, tilt, physics, the ROM name — or an added ball, switch write or
  `Execute` / `Eval`) or unknown, and the score carries the capped report as `script_diff`. Flag only. The runner's
  own baseline and the preflight verdict wait on ArcAid item 12. `script-diff.ts`, `patcher/render.ts`
  (`unpatchRecipeA`), `witness.ts`.
- Playfield fingerprint (F4, B4): every score now carries `fingerprint=pf1:<sha256>`, a hash of the playfield as
  the ball sees it — collidable walls, ramps, rubbers, primitives (with their collision mesh), targets, flippers,
  bumpers, kickers, gates, spinners and the plunger, with physics, position and shape; the table's physics; the
  physics materials those items use. Names, images, visual materials, lights, the script and editor state are left
  out, so a VR or performance edit leaves it unchanged and a moved flipper changes it. Computed in the background
  beside the file hash (~0.5 s on Monster Bash) and cached with it. Every record tag was checked against vpxtool
  0.33.9 on Monster Bash (6,482 values, 0 mismatches). `playfield-fingerprint.ts`, `vpx-file.ts`
  (`readVpxPlayfieldStreams`), `identity-resolver.ts`.

### Tooling
- Solo-streaming spike (D1.0, not in the app yet): `npm run spike:stream -w companion` films the VPX player window with
  `ddagrab` (DXGI monitor match, DPI-aware), mixes loopback game sound with a named microphone (compressor, limiter,
  levels), trims the measured 390 ms audio lag, and defaults to a vertical 9:16 slice shifted 10 % right (the owner's VR
  framing); `--sync-test` with `scripts/av-sync.py` measures A/V offset. Rig findings in
  `docs/design/solo-streaming-and-recording.md` §3. `media/window-geometry.ts`, `media/ffmpeg-args.ts`,
  `scripts/stream-spike.mjs`.

## [0.2.13] — 2026-10-25

### Fixes found by the first recorded live games (C7.1)
- A table load no longer re-posts the previous game's score. On 2026-10-23 Monster Bash's boot wrote player 1 /
  ball 1 and, 59 ms later in a separate NVRAM callback, game over; the detector read that as the previous game
  ending again and live mode re-posted its score 11 s after the table loaded (ArcAid answered `duplicate`). A ball
  or game end now needs a `game_start` seen in the same table load (recipe A). `journal-detector.ts`, and the
  Python oracle `vpx-hook/spike/tail-journal.py` (C7.1.1).
- Live difficulty is 0–1 again (B6.2). VPX's `GlobalDifficulty` reads 0–100 through the script API (Medieval
  Madness: table file 0.5, live 50), so 0.2.12 logged "difficulty 5000%", sent `difficulty: 50` on the score's
  `engine` (a Sanctioned `engine` rule fails it against the table's 0.5) and would put a 6–7° table's slope at 62°.
  The detector divides by 100; the hook and the journal are unchanged. ArcAid reads 0.2.12's 0–100 value as a
  percentage from its side (Castcade F10). `journal-detector.ts`.

### Fairness
- Score plausibility (B6.1): every live score carries how player 1's score moved — the number of changes, the
  largest single jump with its time and ball, and a flag when a jump is not a multiple of 10 (ROM games; original
  tables get the facts only). No ceiling: the maps carry no award values. Shown in the capture detail; flag only,
  never a gate. `score-plausibility.ts`, `witness.ts`.

### Wire / journal
- New optional score param `score_plausibility` (compact JSON, `docs/arcaid-side-changes.md` §15); `engine.difficulty`
  is now 0–1. Journal format unchanged (hook 0.4.0; `castcade.vbs`'s header comment now says 0.4.0). Covered by two new
  fixtures replayed in vitest and `fixtures/check.py`: `fixtures/nvram/mb_106b/2026-10-23-1` (hook 0.3.0, five games
  over three loads, the boot race included; `mb_106` map vendored) and `fixtures/nvram/mm_109c/2026-10-25-1` (the
  first hook-0.4.0 journal from real VPX, two games, one `engine` line).

## [0.2.12] — 2026-10-22

### Table import, second pass (what a tester hit on 0.2.11 — C8)
- "Patch my tables" is one button: it plans and patches the folder in one click with a "37 of 102" progress line,
  the outcome is a banner at the top of the card (errors too — the old card printed them in small red text at the
  bottom, which is why a tester saw "nothing happen"), and "Preview what will change" is the dry run.
- The import no longer needs a table to have been launched: the VPX exe is remembered across runs
  (`settings.vpxExe`), and when none is known the hook library goes into the `scripts` folder beside the tables
  folder (the standard layout). A folder with neither gets a sentence that says what to pick.
- A table opened WITHOUT a Castcade patch raises a desktop notification once per table per run — "<table> is not
  patched: only the last game of this session will post. Settings → Import tables → Patch my tables" — and the
  Status page's Capture row says the same in orange; a table whose script type has no recipe yet is told so
  instead. `witness.ts` (`notice` event), `witness-host.ts`, `tables-host.ts`, `renderer/views/ImportTables.tsx`.

### Fairness
- Engine attestation (F6, WORK B6): hook 0.4.0 `Castcade_EngineSample` reads what VPX has in force — difficulty,
  slope, physics set, table physics, nudge calibration and tilt sensitivity — through the script API at hook time
  and at every key-down, and journals an `engine` line when anything changed. The companion keeps the sample in
  force at game start and every in-game change, sends them on the score as `engine` (compact JSON), names a change
  in the capture detail ("CHANGED DURING THE GAME: difficulty 20% → 80%") and shows "In the game" on the
  conditions card. Closes the tweak-menu hole the fairness doc §5 names (an unsaved in-game change was on no disk).
  ArcAid's rule is `docs/arcaid-side-changes.md` §14. No recipe change; the folder watch re-makes manifests for
  lib 0.4.0 on the first look. `vpx-hook/castcade.vbs`, `journal-detector.ts`, `attestation-types.ts`, `witness.ts`,
  `renderer/views/Attestation.tsx`.

### Wire / journal
- Score call: new optional `engine=<json>`. Journal: new `engine` event (hook 0.4.0); the three Phase 0 fixtures
  are unaffected; a 0.4.0 fixture is part of WORK C7.1.

## [0.2.11] — 2026-10-22

### Process
- One live work tracker per repo: `WORK.md` (item grammar in `.claude/commands/work.md`), the board
  renderer `tools/work-board.mjs` (`npm run work:check | work:summary | work:board`), `/work`, `/wrap`
  and `/release-docs` commands, ADR 0006. `.claude/commands` is tracked; `.claude/worktrees` is not.
  CI checks the tracker's grammar. The "Current state" narrative left `CLAUDE.md`.
- Eighth item status `dropped <reason>` for work that will not be done (hidden on the board by default); first
  full audit of the tracker against code, ADRs and the ArcAid tracker (commit 3cc645c).

### Witness
- Journal detector and tailer in the companion (`journal-detector.ts`, `journal-tail.ts`): the TypeScript port of the
  Phase 0 tailer. Recipe-A journals are decoded live from the shadow NVRAM and `game_start` / `ball_end` / `game_end`
  are derived; script recipes pass through; `table_exit` mid-game becomes `game_abandoned`. The three Phase 0
  fixtures replay in vitest to the same balls and games `fixtures/check.py` asserts (WORK C2).
- Live mode (WORK C7): a table with a Castcade sidecar beside it posts EVERY game as its own score, from the
  journal, with the hook's timing (`reason=game_over`; a game abandoned at exit as `shutdown`); the `.nv` read at
  close is no longer re-posted after a live capture. Status shows "Capture: live" or "basic".

### Limited attempts (ArcAid ADR 0029, companion half — B11)
- In live mode every game START is reported at once on `GET /api/witness/attempt` with a key (the hook's
  session stamp + the start's journal time) that the game's score call repeats as `attempt=<key>`. Status shows
  the answer while the game runs: "Attempt 3 of 5", "No attempts left: this score will not count", "offline:
  this attempt will not count" (the call is queued and replayed, idempotent on the key, but a late start uses
  the slot and its score is refused), nothing when the board has no limit. The last capture shows which
  attempt the score used. Basic mode sends no attempt call: a limited board refuses those scores as
  `unreported`, which ArcAid words as "import this table in Castcade".

### Table import (Phase 3, recipe A)
- Settings → "Import tables for live scores": dry run over the whole tables folder (what will be patched,
  re-patched, skipped, left alone, unsupported), patch, remove all. Every ROM table gets a same-basename
  sidecar `.vbs` (recipe A: `UseVPMNVRAM`, `Castcade_RegisterNVRAM`, the key wrappers) and a manifest under
  `<userData>/witness/tables`; the shared library `castcade.vbs` is installed into the VPX `scripts\` folder
  and ships as a resource. Originals (recipes B/C) are skipped until their recipes exist; a foreign external
  `.vbs` is never touched; the `.vpx` is never modified.
- Hook 0.2.0: `Castcade_Guard` — the sidecar carries the original's size and mtime, and on a mismatch journals
  `stale_sidecar`, renames itself `.stale` and tells the player to relaunch and re-import. The companion adds two
  more layers: the tables folder is watched (a changed `.vpx` is re-patched or its patch disabled, with a
  notification) and the launch-time identity hash is compared with the manifest.
- The folder watch and the Settings card share one lock over the tables folder, and a new companion build (every
  manifest older than its recipe / library) is re-made as one batch with one notification on the first look, not
  a hundred. (2026-10-22 on the owner's rig the first look and a manual Patch re-patched the same 102 tables at the
  same time; the card then reported "Patched 67".) The card's result now separates "already current" from "left
  as they were".
- Hook 0.3.0 / recipe 0.3.0: `Castcade_WatchBytes` — the sidecar carries the NVRAM offsets the ROM's map reads
  for `game_state`; the hook journals only those, coalesced to one line per 50 ms, flushed at once, with a single
  snapshot at hook time. Measured on the owner's rig before the change: 89 lines/s median, 22.6 MB in seven
  minutes, stutter and a VPX crash (WORK C2.1). Re-import the folder to re-render every sidecar.

### Dependencies
- Electron 44, Vite 8, vitest 5, eslint 10 (Dependabot #1/#5/#9/#11/#12): this is the first packaged build on
  them (WORK E4; the 0.2.10 installer ran Electron 38). `pack:dir` + `--smoke` green on the owner's rig.

### Wire / journal
- Score call: new optional `attempt=<key>`; new device call `GET /api/witness/attempt` (ArcAid 2.167.0). The
  score answer may carry `attempt {n, of, remaining}`.
- Journal format: hook 0.3.0 adds `Castcade_WatchBytes` (deltas limited to the watched offsets, coalesced per
  50 ms), `table_exit.filtered_bytes`, and hook 0.2.0's `stale_sidecar` event; `table_loaded` carries
  `recipe_version` and `lib`. Unwatched (0.1.0) journals decode as before: the three Phase 0 fixtures still replay
  in vitest. A recorded 0.3.0 fixture is WORK C7.1.
- Companion log: one line per ArcAid request and answer (`arcaid: #seq …`), never the token.

## [0.2.10] — 2026-10-21

### Witness
- Headset-or-monitor probe per session (`companion/src/witness/vr-detect.ts`): SteamVR runtime client
  loaded in the VPX process plus a running compositor means VR; sent as `play_device=vr_headset|pc`.
  ArcAid 2.166.0 shows the VR headset badge on the score. Status and the detail view say which.

## [0.2.9] — 2026-10-20

### Witness
- ArcAid's `not_sanctioned` reply (integrity mode, ArcAid #370 / ADR 0027) is a rejected capture with
  the `reasons` shown on Status.
- The Panasony `analog_gain_x/y` keys ride with the ini object.

## [0.2.8] — 2026-10-20

### Witness (F2, accelerometer)
- The `ini` object carries `PBWEnabled`, `PBWAccelGain/Max`, `AccelVelocityInput`, `EnableNudgeFilter`,
  `TiltSensitivity` (VPX default 400 when absent). Sanctioned rules for lifts
  (`min_tilt_sensitivity`, `max_accel_gain`, `require_nudge_filter`) are runner-set on ArcAid
  (fairness design §5a). Nudge telemetry itself is a Phase 3 item (WORK B7).

## [0.2.7] — 2026-10-19

### Witness (F2, builds)
- Build `family` from the version resource: `official` (by hash) / `panasony` / `nightly` / `unknown`,
  replacing the "not an official release build" flag. Owner ruling 2026-10-19: the Panasony VR mod is
  allowed in Sanctioned play.

## [0.2.6] — 2026-10-19

### Shell
- The updater re-checks every 4 h (30 min after a failure) instead of once per launch. The repo was
  private until 2026-10-19, so installed apps got an anonymous 404 on the releases feed; it is public now
  and must stay so.

## [0.2.5] — 2026-10-19

### Witness (F2, attestation)
- `companion/src/witness/{ini-attestation,adjustments,build-attestation,attestation-types}.ts`: scores
  carry `ini` (physics and table overrides; the physics-set override is the table-file property `ORRP`,
  not an ini key), `adjustments` (NVRAM adjustments versus factory for the 92/383 maps that have them),
  `build` (VPX, VPinMAME hashes and versions, cheat flag). Status shows a *conditions* block.
  Shapes: `docs/arcaid-side-changes.md` item 11.

## [0.2.4] — 2026-10-18

### Witness (F1, table identity)
- `companion/src/witness/{identity-resolver,vpx-file,vps-index,table-match,table-locator,identity-store}.ts`:
  ROM → VPS game, TableInfo → VPS table (scored match; confirm-once picker on Status); scores carry
  `vps_game`, `vps_table`, `table_sha256`, `table_save_rev`. The compact VPS index is built at package time
  by `npm run fetch-vps -w companion` (vps-db commit pinned); `fixtures/vps/` holds a 13-game subset.
  A `tablesDir` setting widens the search for editor-opened tables.

## [0.2.3] — 2026-10-18
- `GET /api/witness/checkin` whenever no VPX process runs (start, after every exit, each idle heartbeat);
  the reply's `sendingTo` shows in Status and the tray. A launch-only `report` opens a session as soon as
  it has a table name; the capture's report closes it on the same key. Tester kit `docs/tester-kit.md`.
- In an event with a check-in window the player's row turns *ready* on its own; the lobby shows *table open*
  while the table is being played. Status and the tray tooltip show where ArcAid is sending scores.

## [0.2.2] — 2026-10-18
- Catalogue-grade wire name (`catalogueTableName`) plus the ROM name as `slug`, so ArcAid can match.
  Phase 2 gate, half 1, passed on the owner's rig with this build (Monster Bash to the tournament board
  with the Witness badge).
- Fix: scores were captured but ArcAid answered "no match" because the raw file name was sent
  ("Monster Bash (Williams 1998) VPWmod v1.0"); the name is now cut after the "(Manufacturer Year)" part.

## [0.2.1] — 2026-10-18
- Capture on `.nv` change while VPX stays open (editor-driven play), table from the window title.
- Captures play sessions started from the VPX editor, the recent-files list or a file association, not only
  `-Play` launches; the table name comes from the command line, the editor window title or the ROM's name.
- Captures when the player closes while VPX stays open: one capture per player session; quitting VPX is
  still the final chance.
- Every VPX process shows up in the log and the Status view.

## [0.2.0] — 2026-10-18
- Phase 2: the Arcaid Witness desktop producer in basic mode (`companion/src/witness/`: process watch,
  `.nv` decode with the pinmame-nvram-maps corpus, GET posts, offline queue, heartbeat) behind a tray shell
  (pairing, status, settings); electron-builder NSIS per-user installer from `release.yml` on `v*` tags.
  Unsigned. Tester guide `docs/phase-2-witness.md`.
- Posts the last one-player game's score from the ROM's NVRAM to the ArcAid board with the Witness badge when
  VPX 10.8.0 exits; pairs with an ArcAid account by the Account Settings pairing code; changes nothing in the
  Visual Pinball install.

## [0.1.0] — 2026-10-18
- Phase 1: npm workspaces; `protocol/` v1 schemas with generated `SPEC.md`; `companion/src/match/`
  (host arbiter, client, hash-chained log, Ed25519 keys, in-memory and WebSocket transports) behind a
  minimal Electron shell; `fakeclient/` scenarios and the gate test; CI on ubuntu + windows + fixture replay.
  Phase 0 spike results in `docs/phase-0-spike.md`.
