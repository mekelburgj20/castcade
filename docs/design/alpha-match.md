# Alpha match: two VR players, one table, video and voice in the headset

**Status:** design 2026-10-30; built 2026-10-31 on `main` (A6 + C3, D2, D7, H4: `match/controller.ts`, `main/match-host.ts`, `media/rtc-host.ts`, `media/panel-page.ts`, `media/vr-overlay.ts`, `vr-overlay/`), untested on a rig; the §6 checks are the gate. Design for the first real match (owner + tester Krobs, both in VR). Builds on the Phase 1 engine
(`companion/src/match/`), A2/A3 (WebSocket transfer and reconnect), the live detector (C2), the turn lock in hook
0.1.0+ (`vpx-hook/castcade.vbs`, Phase 0c pass), the VR detection (`witness/vr-detect.ts`) and the D1 media stack.
Owner ask 2026-10-30: build the final product, not an interim; video and voice between the players; both in VR.
Rulings that bind this: peer-hosted (no media on ArcAid), ADR 0002 (a match is a Throwdown; the ArcAid lobby comes
later, F6), ADR 0007 (functionality first, guided setup).

## 1. What a player does

(A14, 2026-11-12, §9: steps 1 and 2 below are one press each now. The host picks a table and presses Host, which starts
VPX and copies a join link; the other player opens the link. The steps as written still work, in any order.)

1. Both players open the same table in VPX (same file; the fingerprint says if not) with the Castcade patch, in VR
   with `VRPreview` on and its window 1280x720 (`[PlayerVR] PreviewWidth / PreviewHeight`).
2. The host opens Castcade → **Match** → *Host*: Castcade listens on a TCP port (setting, default 27401), shows the
   invite string `castcade:ws://<public ip>:<port>#<code>` and the sentence "forward TCP 27401 to this PC on your
   router"; the host copies the invite to the other player (Discord, text). The client pastes it under *Join*.
3. When everyone is in, the host presses *Start match*. From then on the engine rotates turns: ball 1 of each player
   in join order, then ball 2, and so on (3 balls; the host picks 3 or 5).
4. The companion **locks the table** (writes `%LOCALAPPDATA%\Castcade\lock\turn.lock`) whenever it is not this
   player's turn; the hook swallows flipper, plunger, start and nudge keys while the file exists. A grant for this
   player deletes the file, plays a short **sound cue** ("your ball"; the headset is the default audio device) and the
   in-headset panel says `YOUR BALL 2`. The *Start* key is a play key too, so each player starts their own one-player
   game when their first grant arrives, not before.
5. While it is my turn my VR preview window streams to the others (video goes only from the player up; voice is an
   open mesh with a mute key). The others see it on the **panel**: on the desktop a Castcade window; in VR the same
   panel drawn in the headset by the OpenVR overlay helper (§5), anchored to the head, bottom edge.
6. The detector's `ball_end` becomes `BALL_END` (final score sampled after the end-of-ball bonus: the first
   `current_scores` after the ball end, or 2 s), `game_end` becomes `GAME_OVER`; after everyone's last ball the host
   issues `RESULT`, every companion signs, both panels show the standings. Each player's game ALSO posts to ArcAid as
   a normal Witness score, so the boards see both games today; the Throwdown result on arcaid.app is A5 / F6.
7. (A10 + A11, 2026-11-02, §8) The match stays open at the RESULT: the host starting a game on its table starts the
   next game for everyone, from the headset; the host starting a game in a full lobby starts the match itself.

## 2. Pieces and owners (one worktree agent each)

| Piece | Files | Item |
|---|---|---|
| **Match in the app**: `MatchController` (pure: grants → lock/unlock + cue, detector events → BALL_END / GAME_OVER / STATE, result), `main/match-host.ts` (keys, `WsPeerTransport`, invite, IPC), the **Match** tab, the audio cue, the `event` emitter on the witness | `companion/src/match/controller.ts`, `main/match-host.ts`, `main/index.ts` (wiring), `main/ipc-types.ts`, `preload/index.cts`, `renderer/src/views/Match.tsx`, `App.tsx`, `castcade.d.ts`, `witness/witness.ts` + `types.ts` (the `event` emitter only), `main/witness-host.ts` (`onEvent`) | A6 + C3 |
| **Media**: `MEDIA_SIGNAL` in the protocol, relay in host/client, the panel page (RTC peer connections + the panel UI in one hidden-or-visible BrowserWindow), `rtc-host.ts` implementing `MatchMedia` | `protocol/**`, `companion/src/match/host.ts` + `client.ts` (relay only), `companion/src/media/rtc-signaling.ts`, `panel-page.ts`, `rtc-host.ts`, `media-settings.ts` | D2 |
| **VR overlay helper**: `vr-overlay/` (C++17, CMake, OpenVR SDK pinned), a CI build, `media/vr-overlay.ts` (spawn + frame pipe) implementing `VrOverlay` | `vr-overlay/**`, `.github/workflows/vr-overlay.yml`, `companion/scripts/fetch-vr-overlay.mjs`, `companion/electron-builder.yml` (one extraResources entry), `companion/src/media/vr-overlay.ts` | D7 |
| **Runbook** for the two players | `docs/alpha-match-runbook.md` | H4 |

The contract between the three code pieces is `companion/src/media/match-media-types.ts` (written with this doc):
`MatchMedia` (what the controller drives), `PanelState` (what the panel shows), `PanelFrameSource` and `VrOverlay`
(how the panel's frames reach the headset). Agents code against it; nobody changes it without telling the lead.

## 3. Match controller (A6 + C3)

- Role objects come from the engine: `HostMatch` or `ClientMatch` on a `Session` over `WsPeerTransport` (D10.8: or
  the relay transports, §3a).
- **Keys**: one Ed25519 pair per companion, `<userData>/match-keys.json` (`match/keys.ts` export/import).
- **Participant**: `playerId` = a stable per-install id (the pairing device id when paired, else a UUID stored with the
  keys); `displayName` = the pairing username (`WitnessSettings.username`), editable on the Match tab; `rig` =
  `vr_headset` when the witness's VR observation says `inVr`, else `pc`. Built (A6 fix, 2026-10-31): decided at host /
  join by probing the running VPX process now (the witness's attestation could hold a sample from before the player
  started; the owner's first match got the desktop panel in VR that way), else the witness's last sample; the witness
  also re-samples at `table_loaded`, and a match decided `pc` switches to the headset (panel re-attached offscreen,
  overlay started) when that reads VR. The Match tab shows the decision and its evidence (`MatchStatus.rig`, `rigReason`).
- **GameFingerprint** from the witness's current identity: `tableName`, `tableHash` = `TableIdentity.sha256` (zeros
  when unknown), `romName`, `romHash: null`, `physicsHash: null`, `recipeVersion` = the loaded recipe version. A
  client whose fingerprint differs from the host's is shown "different table file" on both panels (advisory).
  Lobby refresh (A6, 2026-10-31; the first two-player match showed a VR tester as "PC · different table file" because
  he joined before his table loaded): until MATCH_READY, a change of the witness's table fingerprint or VR sample
  re-runs `decideRig` and rebuilds the fingerprint; a client sends `PARTICIPANT_UPDATE`, the host updates its own
  entry, and either way the host re-compares and re-sends `HELLO_ACK` to every client, so rosters and flags follow
  (the roster, not `MATCH_READY`: the lobby has to show it before the start). The rig only moves towards the headset.
- **Lock**: `lock()` creates `turn.lock` (empty file, `%LOCALAPPDATA%\Castcade\lock\`), `unlock()` deletes it. Locked
  the moment the match starts; unlocked by a verified grant for me; locked again when my `ball_end` is accepted (the
  next grant is someone else's) and at match end (then unlocked when the match closes, so solo play works again).
- **Detector → engine**: witness emits every `GameEvent` (`event`); the controller, while holding a grant:
  `current_scores` → `reportState` (≤ 10 Hz, score = player 1's); `ball_end` → wait for the next `current_scores` or
  2 s → `reportBallEnd(grantSeq, ballNumber, finalScore, 'nvram', shootAgain = (extraBalls ?? 0) > 0)`;
  `game_end` → `reportGameOver(score, balls)`; `game_abandoned` / `table_exit` → `forfeit('table closed')`.
- **Cue**: a hidden BrowserWindow with WebAudio (no asset): two rising tones for "your ball", one low tone for
  "opponent up", a chord for "match over"; volume setting; the panel text changes at the same moment.
- **Match tab**: Host (port, balls per game, invite string + copy, "forward TCP <port>"), Join (paste), roster with
  rig and table-file agreement, the big turn line, scores per player, result, Leave. The invite's public IP comes from
  `https://api.ipify.org` (one GET, failure → the LAN address with a note to replace it). D10.8 (2026-11-12): a paired
  host's invite is the match code alone and the match goes through ArcAid; see §3a.
- **Media hooks**: on `MATCH_READY` → `media.attach(signalling, peerIds)`; on my grant → `media.setSending(true)`; on
  my `ball_end` accepted → `setSending(false)`; every state change → `media.setPanelState(...)`; on leave → `detach()`.
  In VR (`inVr`) the controller also starts `VrOverlay` with the panel's frame source; on the desktop the panel window
  is simply shown. The VR runtime (`RigDecision.runtime`, B22) picks the overlay (D7.3, 2026-10-31): SteamVR → the
  OpenVR overlay helper (§5); any OpenXR runtime (the owner's rig: Virtual Desktop's, through OpenComposite) → the
  Castcade OpenXR layer (§5). A later reading on a runtime that needs the other one swaps them. The rig, `play_device`
  and the capture pick follow `inVr`.

## 3a. Reaching the host: the ArcAid relay, and the router port as the fallback (D10.8, 2026-11-12)

Until 0.2.39 the host listened on TCP 27401 and the invite carried its public address, so a host with no port forward
could not be reached (a tester's first try: "Could not reach the host at … (no answer in 10 s)"). Media already
crosses NAT by STUN; only the match control needed a path. Owner ruling 2026-11-12: ArcAid relays the match control
messages (primary); a UPnP port mapping is the fallback. The protocol is unchanged: the relay is a transport.

- **Transports** (`match/transport-relay.ts`): `RelayHostTransport` owns the relay room named by the match code,
  `RelayClientTransport` joins it; both carry the exact text frames of the WebSocket transport over socket.io to
  ArcAid (contract and limits: `docs/arcaid-side-changes.md` §4a). `CompositeTransport` lets the host serve the room
  and its WebSocket listener at once. A relay link behaves like a socket: a peer is a link at the host from its first
  frame (HELLO or RECONNECT), a dropped socket.io connection closes the links on that side (the engine sees leaves),
  and `connectTo` re-joins and opens with RECONNECT, so the engine resumes from the log head as over WebSocket.
- **Host.** Paired, and ArcAid answers (5 s to connect, beside the rig probe and the address lookup; 4 s for the
  ack): the room is registered, the invite is **the code alone** (`JHDFEF`), and the listener still opens on 27401
  for LAN players, a forwarded port and players who are not paired (the tab shows that address invite small). A code
  ArcAid says is in use is replaced (three tries). A port that cannot be opened no longer stops a paired host: the
  match goes through ArcAid only. Not paired, ArcAid unreachable, or a server without the relay: the address invite
  as before, and the router is asked for the port in the background.
- **Join.** Six letters (any case, `castcade:` in front allowed) → the relay; `castcade:ws://host:port#CODE` →
  direct, as before. A code on a PC that is not paired says so. A relay failure names its cause: no such match, full,
  the match already started (`locked`), ArcAid refusing the device (pair again), ArcAid holding the PC back (wait a
  few minutes: its lockout after wrong codes is fifteen), ArcAid unreachable, the match closed. ArcAid checks the
  device when a room is asked for, not at connect, so "refused the device" always comes from that answer; a host it
  refuses (or holds back, or has no room for) hosts on its listener and the tab says why.
- **Started = locked.** When the host starts the first game it tells ArcAid (`match:lock`): a device that never had a
  seat in the room is refused from then on, the players may come back. Leaving on purpose (Leave, a match that ends,
  quitting) tells ArcAid too (`match:leave`), so a host's room closes at once and not after the 30 s grace.
- **Match tab.** One line under the turn: `Through ArcAid` (with `(reconnecting to ArcAid…)` while the host's socket
  is away) or `Direct to <host:port>`. `MatchStatus.via`, `path`, `directInvite`, `relayNote`, `portMapping`.
- **A drop on the relay.** The host's socket to ArcAid going away drops every relay player at once. The host takes the
  room back when socket.io reconnects (ArcAid then names the clients in the room again; the companion does not need
  it, a peer is a link from its first frame), tells its former peers to relink (a transport-private string, §4a), each
  resumes with RECONNECT and RESUMEs the pause that names it. For that last step the controller now also resumes when
  a pause for its own drop reaches it on a live link (with two or more dropped at once the host pauses for each in
  turn, and the second one's pause arrives after it is back; before D10.8 that pause waited for the host's Resume
  button). In the lobby a drop is a leave, as over WebSocket: the player joins again. If the host stays away more
  than 30 s ArcAid closes the room and the clients' reconnects end with "no such match".
- **ArcAid restarts (a deploy), or closes the room** (`expired`, `server_restart`). The room lives in the server's
  memory, so it is gone. The host registers the same code again when its socket is back (a new room, locked again
  once the players it had are back in it, or after 60 s), and the clients come back by the same relink path with a
  new peer id. A client that asks before the host did is told "no such match"; ArcAid locks a device out after eight
  of those in ten minutes, so the transport asks at most five times, further apart each time (1.5, 3, 5, 8 s), and
  after that answers by itself while the engine's own attempts run out. A room closed because the host left
  (`host_left`) or hosts another match (`replaced`) is not asked for again, and the host does not reopen it.
- **A pairing revoked mid-match.** ArcAid checks a seated device again at most once a minute and takes the seat of
  one that no longer verifies. That player's companion says "This PC is no longer paired with ArcAid" and does not
  try to come back through ArcAid (the host sees a leave); a revoked host's room is closed and not opened again.
- **What ArcAid drops, it says** (`match:error`): over the rate, too large, not readable, no such player, not in the
  match. Each goes to the log in plain words, once per ten seconds. "No such player" does not name the player, so
  the host asks who is in the room and closes the links of those who are not (the engine sees a leave); "not in the
  match" is a closed link on a client and a room to take back on the host.
- **Not carried by the relay:** a host transfer. The room belongs to the host's device, and `newHostEndpoint` is a
  `ws://` URL; a relay client refuses to move to one. The companion never calls `transferHost` and its clients do not
  listen, so nothing is lost that worked before; a transfer through the relay needs a contract (a room handed to
  another device) and a protocol answer for the endpoint.
- **Rate.** ArcAid allows 200 `match:relay` per fixed 10 s window per client socket and, for the host, per
  destination (amended 2026-11-12; the first wording counted the host's socket as a whole, which a host that is up
  reached with three clients); a frame it refuses for its size counts too. `RelayPacer` keeps each bucket under it
  (180 in any 10 s, so under 200 in any fixed window): one pacer on a client, one per destination on the host; STATE
  and DMD_FRAME are shed first, the rest waits in order. STATE at 10 Hz is half a bucket, so nothing is shed in a
  normal match at any size (§4a).
- **Router port** (`main/port-mapping.ts`): UPnP IGD written directly on `node:dgram` and `fetch` (no dependency:
  the maintained npm libraries bring an XML parser and a gateway prober for three requests): SSDP search from every
  LAN address, the description fetched only from the device that answered, `AddPortMapping` TCP 27401 → this PC with
  a 1 h lease (renewed every 30 min while hosting; a router that only takes permanent mappings, error 725, gets one),
  `GetExternalIPAddress`, `DeletePortMapping` at teardown (leave, quit). One 3 s deadline; hosting never waits for
  it. The tab says `Port opened on your router automatically`, or `Your router did not open the port: forward TCP
  27401, or pair with ArcAid to host without it`; a router whose own address is private, CGNAT or not the public one
  is reported as behind another router (the mapping cannot help). NAT-PMP / PCP is not done (it needs the default
  gateway's address, which Node does not give without a dependency).

## 4. Media (D2)

- **Signalling**: new protocol message `MEDIA_SIGNAL` `{ to: PlayerId, kind: 'offer' | 'answer' | 'ice', sdp?: string,
  candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } }`, direction `any`; the host
  relays it to `to` only (never logged, like STATE; D10.8: through the ArcAid relay it rides the match channel
  unchanged, §3a); protocol stays 2 (unreleased). Built: `HELLO_ACK.hostGame` was added too, so a client learns of a table-file mismatch and both panels flag it (the host accepts the HELLO in `advise` mode). Prose: a "Media signalling"
  section (what is signalled, that media never crosses ArcAid, that video flows only from the player up).
- **Topology**: full mesh of `RTCPeerConnection`s (2–4 players; perfect negotiation, polite = the lexically smaller
  playerId). Voice: every peer sends its microphone, Opus, echo cancellation and noise suppression on, open mic with a
  mute toggle (push-to-talk is a later setting; a VR player's hands hold the flippers). Video: ONE track per peer,
  enabled only while that peer is the player up (`setSending`), 1280x720 at 30 fps, `maxBitrate` 2.5 Mbps; receivers
  show the up player's track. This bounds upload to one video stream per rig and survives a host transfer without
  renegotiation (the handoff's host-forwarding is not needed at 2–4 players; revisit at the SFU step).
- **Capture** (built as a window capture, then changed by D2.5 on 2026-10-31: Chromium's window capture freezes once VPX has focus in VR, so the page now captures the SCREEN and crops to the player window, covered while VPX is not in front, `media/capture-crop.ts`): originally `desktopCapturer` window source: in VR the VPX VR preview window (title from `probeWindows()`: the
  window of the VPX process that is not "Visual Pinball Player"; the agent confirms the title on the fixtures /
  comments and falls back to the largest VPX window), else the player window. The fallback never takes a DMD,
  backglass or PinUP window (title `/dmd|pinmame|flexdmd|backglass|b2s|pup|pinup/i`) or one under 640x360: the first
  two-player match (2026-10-31) sent a VR player's VPinMAME DMD because his `VRPreview` was off. With only those, nothing
  is sent and the Match tab says to turn VRPreview on. With no window at attach the VPX windows are probed every 3 s
  until one is found (and again when the capture ends); the track goes on every connection at once, disabled until
  `setSending(true)`, so a player's first turn only flips the flag (the first match lost ball 1's picture to a
  capture looked for only at the turn). Microphone from a named device
  (`micDeviceId` setting; the panel lists devices, and before a match a hidden page in the same partition does when
  the Match tab opens, B22; the Windows default is often a virtual device in VR).
- **ICE**: STUN `stun:stun.l.google.com:19302` and `stun:stun1.l.google.com:19302`; optional TURN from settings
  (media.json `turn: { url, username, credential }`, set on the Match tab, D2.9); no relay of ours yet. D2.9
  (2026-11-02, EFUKTZ: two NATed rigs sat in `checking` with no pair): each peer's candidate pair from `getStats()`
  (types and protocol, never an address) is logged when it changes and every 10 s, and a connection stuck in
  `checking` / `disconnected` / `failed` (or `new` once signalling is stable) restarts ICE through the normal
  negotiation: the impolite peer leads after 10 s, 20 s, 40 s, the polite one 5 s later each time; after three the
  panel and the Match tab say there is no path and a TURN relay is needed.
- **Panel page**: one HTML page (a template string, like `stream-host.ts`'s audio page) holding the peer connections
  AND the UI: the up player's video large, a header `YOUR BALL 2` / `<name> IS UP`, a score strip (name, score, ball),
  the mic state, a one-line message (errors, "different table file"). Dark, high-contrast, legible at 0.6 m in a
  headset. In VR the window is created `show: false` with `webPreferences.offscreen: true` and its `paint` events
  (`setFrameRate(20)`) feed `PanelFrameSource`; on the desktop it is a normal always-on-top window.

> **2026-11-04, ADR 0009: spectating is 2D.** The stereo window described from D7.4.5 onward in §5, §5a and §5b
> (both eyes placed per eye, `camera.whole`, window depth, soft edges, the calibration pattern, the tuning sliders)
> is withdrawn: it stays in the code as shipped in 0.2.35 and gets no more work. The theater is the flat mono screen
> of D7.4 (one of the sender's eyes on a 2.4 m screen 2.6 m ahead), the layer camera becomes a one-eye camera, and
> the open work is WORK section D8. The sections below are kept as the record of what was built and measured.

## 5. VR overlay helper (D7)

- `vr-overlay/` C++17, CMake, MSVC; OpenVR SDK pinned by tag + sha256 (`openvr.h`, `openvr_api.dll`, `.lib`; BSD-3,
  attributed in `vr-overlay/THIRD-PARTY.md`). `castcade-vr-overlay.exe --width-m 0.55 --anchor hmd --offset 0,-0.28,-0.9
  [--alpha 0.95] [--key castcade.panel]`.
- stdin frame protocol: 16-byte little-endian header `magic "CVO1" · u32 width · u32 height · u32 byteLength` then
  `byteLength` bytes of BGRA; each frame replaces the last (`IVROverlay::SetOverlayRaw`). The helper shows the overlay
  on the first frame, hides it after 5 s without frames, exits 0 on stdin EOF, exit 2 when SteamVR is not running,
  3 on an OpenVR error, and prints one JSON line per event on stdout (`{"event":"ready"}`, `{"event":"hidden"}`, …).
- `companion/src/media/vr-overlay.ts`: `createVrOverlay(opts)` spawns it (path from `resources/vr-overlay/`,
  dev fallback `vr-overlay/build/Release/`), pipes `PanelFrameSource` frames (drop frames when the pipe is behind),
  restarts once if it exits unexpectedly, reports `unavailable` with the reason on exit 2/3. The match host starts it
  only on SteamVR (B22, 2026-10-31): the helper draws into SteamVR's compositor, which an OpenXR runtime such as
  Virtual Desktop's does not run.
- CI: `.github/workflows/vr-overlay.yml` builds on `windows-latest` on every push touching `vr-overlay/**`, uploads
  the exe as an artifact, attaches it to the GitHub release on `v*` tags; `companion/scripts/fetch-vr-overlay.mjs`
  downloads it from a pinned release tag into `companion/resources/vr-overlay/` (or `--from <dir>` for a local build);
  `electron-builder.yml` ships that folder as `vr-overlay`.
- **OpenXR runtimes (D7.3, 2026-10-31):** `vr-layer/` is an implicit OpenXR API layer (`XrApiLayer_castcade_panel.dll`
  + manifest, OpenXR headers pinned by tag + sha256) that loads inside `VPinballX*.exe` on any runtime and appends the
  panel as one head-locked `XrCompositionLayerQuad` (same placement as the helper). Frames come over the named pipe
  `\\.\pipe\castcade-panel` in the helper's stdin format. `companion/src/media/vr-layer.ts` registers the manifest
  under `HKCU\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit` and feeds the pipe (`panel-frame-writer.ts`, shared with
  the helper). The loader reads the list when VPX starts VR, so a VPX started before the first registration needs a
  restart (`restart_vpx` on the Match tab). CI `vr-layer.yml`; `fetch-vr-layer.mjs`; shipped as `vr-layer`.
- **Theater mode (D7.4, 2026-10-31; the owner after the first layer run: "I want to see his playfield where my
  playfield was… not a window popup that I look at while he's playing"):** the layer has three modes the match host
  sets from the turn (`vrViewMode`, match/controller.ts): *hidden* on this player's ball, *theater* while another is
  up (VPX's projection layers removed, the up player's video on a screen 2.6 m ahead in LOCAL space whose longer side
  is 2.4 m, black around it, stereo when the sender's VR preview is on "both eyes"), *panel* in the lobby, a pause and
  the result
  (placed low now, below the playfield). Into or out of theater the view dips to black over 300 ms; with no frame
  for 5 s the layer passes VPX through. Pipe protocol 2 (hello, `CVC1` control, `CVO2` RGBA video frames):
  `vr-layer/README.md` "The pipe". The panel page reads the stage video into a canvas only while theater wants it.
  Two Match tab settings (`match.json` `theaterDuringMyTurn`, `spectate`). SteamVR rigs keep the panel.
- **Stereo is the sender's word (D7.4.3, 2026-11-01; rig test BCBSLU / LBWNUP):** the receivers used to guess "both
  eyes" from the picture (3:1 or wider, VR senders only), and both eyes in a 16:9 or a square window were shown flat.
  VPX 10.8.0 (`Player::PrepareVideoBuffers`, v10.8.0-2051) centre-crops each eye to its half of the window, never
  stretches it, and clamps the window to the monitor, so the recommended both-eyes window is as tall as the monitor
  and about as wide (1080x1080 on 1080p: two 540x1080 portrait eyes; the owner's 1440x1392), not 2560x720. The sender
  declares it (`media/preview-stereo.ts`): the Match tab's **Your preview** (`match.json` `previewStereo`: auto / one
  eye / both eyes), on auto `[PlayerVR] VRPreview` (3 = both eyes) from the active `VPinballX.ini`, read at each
  capture pick; a monitor rig sends one picture. The page tells every peer on a `MEDIA_SIGNAL` of kind `stereo` (not
  logged, so protocol 2), and the receiver trusts it whatever the shape and the rig; only a sender that declared
  nothing (an older companion, no ini found) is still judged by the 3:1 rule. The layer sizes a portrait eye
  height-led (2.4 m tall). The Match tab says "both eyes is on but the window is 16:9" when it is.
- **A panel move keeps the media (D2.7, 2026-11-01):** a rig whose VPX loads after host / join moves its panel into
  the headset, which rebuilds the panel page and its connections. The new page sends each peer a `reset` signal
  first (they reopen their connection), and an offer that an established connection refuses (Chromium: "The order
  of m-lines in subsequent offer doesn't match") reopens that peer and is applied to the fresh connection, its ICE
  following. Each peer's ICE and signalling state is one companion.log line per change.
- **A rig switch after Start is told (A6.1, 2026-11-01):** PARTICIPANT_UPDATE carries a rig in any phase; after
  MATCH_READY the host passes it on to the others (the log's roster stays as it started) and the Match tab and panel
  show the rig each player has now.

## 5a. The layer as the camera (D7.5, 2026-11-02): integration contract

**Why.** A VR sender's picture has been a screen capture of VPX's VR preview window, which needs a lit desktop, the
window in front, smaller than the display and wholly on it, and still died on Krobs' rig once VPX had focus (D2.5,
D7.4.4, D7.4.10). The OpenXR layer sees the two eye views VPX submits (`XrCompositionLayerProjection`) in every
`xrEndFrame`; D7.5 makes it the camera: it copies them out of the frame, crops each eye the way VPX's own preview does,
scales, encodes to JPEG and writes them to the pipe with each eye's fov and crop. `VRPreview` becomes optional, the
monitor may be off, the resolution follows the headset, and the receiver's stereo window can place the picture from
the **sender's** eyes instead of standing in with its own (exact for mixed headsets).

**Built this round** (`vr-layer/`, pipe protocol 3, `companion/src/media/vr-layer.ts`, `layer-camera.ts`, the
`cameraSource` setting and its Match-tab control). The panel page and `rtc-host.ts` side is **built in D7.5.1**
(items 1, 2, 4 and 5 below, and the sender's half of item 3); see "Built in D7.5.1" at the end of this section for
what the code changed in the contract.

### What exists

- **Pipe protocol 3** (`vr-layer/README.md` "The pipe", "The camera"): the control's `camera: {width, height, fps} |
  null` (a per-eye box; only sent to a protocol-3 layer, so a protocol-2 control is byte for byte what it was); the
  layer's `CVS1` status (`on` with api / source / size / fps, `off` with why, `refused` with why) and `CVF1` frames
  (u16 jsonLength, JSON header, the two JPEG payloads left then right). The layer logs `camera: on …`, per-frame
  timings for the first 10 frames and then every 300th, and `camera: off …` with averages and drop counts.
- **`VrOverlay`** (`match-media-types.ts`; the OpenXR layer implements them, the SteamVR helper has none):
  - `setCamera(req: LayerCameraRequest | null)`: ask (or stop). Sent with the control once a protocol-3 layer is on
    the pipe and again on every new connection while asked. Idempotent for an equal request.
  - `onCameraFrame(cb: (f: LayerCameraFrame) => void)`: every complete frame, in order. `f.width` x `f.height` is each
    eye's JPEG size; `f.eyes[0]` left, `f.eyes[1]` right, each `{fov, rect, render, data}` (`LayerCameraEye`:
    `fov` = `[angleLeft, angleRight, angleUp, angleDown]` radians, `render` = the view's `imageRect` size, `rect` =
    the crop taken inside it `[x, y, w, h]` with y from the top, `data` = the JPEG bytes, a view into the message
    buffer: hand it on, never keep more than the newest). `f.n` counts the layer's issued frames (a gap = a drop on its
    side), `f.t` is microseconds since the layer's camera started, `f.us` the layer's own timings.
  - `cameraStatus()` / `onCameraStatus(cb)`: `{state: 'off' | 'asked' | 'on' | 'refused', why, api, source, size,
    lastFrameAt, frames}`.
  - `companion.log` gets `vr-layer camera: asked …`, `… first frame …`, `… refused by the layer: …`, and a counter line
    every 10 s: `vr-layer camera: N frames in 10 s (WxH per eye, K KB a frame), D dropped by the layer; on`.
- **Policy** (`layer-camera.ts`, pure, tested): `decideCamera({setting, rig, runtime, layerProtocol})` →
  `{source: 'layer' | 'screen', reason}` (layer only when the setting says so, the rig is a headset on a non-SteamVR
  runtime, and the layer on the pipe is protocol 3+; otherwise the screen capture with the reason);
  `cameraRequestFor({eyeHeight?, fps?, sourceEye?})` → the box (720x1440 at 30 fps by default: portrait 1:2, the
  receiver's side-by-side feed box height, never taller than the eye render); `cameraFallback(status, now, askedAt,
  sending)` → `{fallBack, reason}` (refused; stopped by the layer; no frame within 8 s of asking; frames stopped for
  3 s while sending).
- **Setting**: `match.json` `cameraSource: 'screen' | 'layer'` (default `screen`), the Match tab's **Camera** select
  (`Screen capture of the VR preview window` / `VR layer (experimental)`), `MatchHost.setSettings` logs a change.
- `MediaSignal` of kind `stereo` has an optional `eyes?: LayerCameraEyeGeometry[] | null` (the type only; nobody sends
  it yet).

### What the lead wires (built in D7.5.1, with the changes listed at the end of this section)

1. **Choosing the source** (`rtc-host.ts`, at attach and when the setting or the layer's protocol changes): `const d =
   decideCamera({ setting: settings.cameraSource, rig, runtime, layerProtocol })`. For `screen`, everything as today.
   For `layer`: `overlay.setCamera(cameraRequestFor())`, log `media: camera: the VR layer (…)`, and tell the page
   (`PANEL_CHANNELS.capture` with a new `PanelCapture` shape, or a new channel `castcade-panel:camera`) that frames
   will come from main. Keep the capture pick's pieces that still matter (the VPX pid for table sound, the window
   probe for the Match tab) but do not open the screen capture while the layer feeds. Run `cameraFallback(status,
   Date.now(), askedAt, sending)` on a 1 s tick and on every camera status; on `fallBack`, log `media: camera: back to
   the screen capture: <reason>`, `setCamera(null)`, and pick the capture as today (`pickCapture`). A later `on`
   status does not switch back within the same match (no flapping); the next attach decides afresh.
2. **Feeding the page** (`panel-page.ts`): frames go main → page over IPC as `{n, width, height, left: Uint8Array,
   right: Uint8Array}` (the two JPEGs, about 150–400 KB a frame: Electron's structured clone carries them; one frame
   in flight with an ack like the theater feed, newest wins, older dropped and counted). In the page:
   `createImageBitmap(new Blob([left], {type: 'image/jpeg'}))` and the same for the right, then
   `ctx.drawImage(leftBitmap, 0, 0, w, h)` and `ctx.drawImage(rightBitmap, w, 0, w, h)` onto the **same canvas whose
   track the peers already get** (`canvas.captureStream(VIDEO.fps)`, `videoTrack`), sized `2w x h`: nothing
   renegotiates, `applyBitrate` sees a side-by-side shape (`videoBitrateFor` already rates 1440x1440 at about
   8 Mbps), `contentHint` stays `detail`. The hidden `<video id="src">` and `paintFrame` are simply not used while
   the layer feeds; `cap` is a synthetic `PanelCapture` (`sourceId: 'layer-camera'`, `out: {2w, h}`, `stereo: 'sbs'`,
   `label: 'VR layer camera'`) so `report()`, the Match tab's `captureSource` / `captureCrop` and the 10 s counters
   (`capture: N frames`) keep working, with the counter fed by decoded camera frames. Decode failures (a truncated
   JPEG) are skipped and counted; the stall watch (`srcTick`) uses the camera frame counter as its mark so a stalled
   layer shows as `capture stalled` and goes through the same fallback.
3. **The stereo declaration carries the sender's eyes** (`MediaSignal` `stereo`): while the layer feeds, `noteStereo`
   sends `{kind: 'stereo', stereo: 'sbs', eyes: [geometryOf(left), geometryOf(right)]}` (fov, rect, render from the
   newest frame; re-sent when they change, which is at most once per VPX resolution change) and `stereo: 'sbs'` is
   forced whatever `previewStereo` says. The receiver keeps `peerStereo` and adds `peerEyes`; the theater feed
   (`feedTick`) passes the eyes to main with each video frame (`VideoFrame.eyes?`), `vr-layer.ts` puts them on the
   control as `"eyes": [{"fov": […], "rect": […], "render": […]}, …]` (a new optional control field; the layer's
   `placeWindows` then uses the sender's fov, render and crop instead of its own `appFov` / `appRect` and the
   centre-crop it assumes: the tangent rect is `tL' = tL + (x / W)(tR - tL)` etc. with the sender's numbers, the
   same derivation as §D7.4.5 with the crop given rather than inferred). Until the layer side exists, a receiver that
   gets `eyes` ignores them and the picture is placed as today (the sender's crop is the same centre crop VPX would
   have made for a 1:2 window, so the current geometry is already right when both rigs have the same headset).
4. **Fallback rules** (all logged, all visible on the Match tab through `captureSource` and `captureWarning`): PC
   rig → screen; SteamVR rig → screen; protocol-2 layer → screen with "restart VPX with the new layer"; refused → screen
   with the layer's reason; no frame within 8 s → screen; frames stopped for 3 s while sending → screen (and the
   `capture stalled` line); the pipe closes mid-match → the capture (the layer comes back with VPX, the next attach
   decides). The screen capture never falls *forward* to the layer within a match.
5. **Receiver box**: a camera frame is `2w x h` = 1440x1440 by default; `VIDEO_FEED_MAX` (D7.4.9 raises the
   side-by-side box to 1440 high) passes it through unscaled.

### Decisions taken alone this round

- **Wire encoding JPEG, quality 85, one JPEG per eye, the right eye encoded on a second thread** (stb_image_write,
  vendored, public domain). Raw at 2x720x1440x30 would be 250 MB/s; the pipe could carry it, the IPC hop into the page
  could not. Two JPEGs rather than one side-by-side image so the two encodes run in parallel and the page draws each
  half where it belongs with no cropping.
- **Default box 720x1440 at 30 fps per eye** (not 900x1800): the receiver's feed box is 1440 high (D7.4.9), the
  shape is the runbook's 1:2, and 2x720x1440 is 2.1 Mpx a frame: within what a scalar JPEG encoder on two threads
  manages at 30 fps on a desktop core (the per-frame `encode` log line says whether it does; above about 30 000 us,
  ask for a smaller box).
- **GPU work on the render thread is a blit plus a pixel-pack readback behind a fence, mapped one or two frames
  later**; the worker reads the mapped memory and lets the slot go before encoding, so the render thread never
  waits and never copies a full frame. Two slots; frames are dropped, never queued.
- **Crop before scale, the box's aspect, centred**: what VPX's own both-eyes preview does, so the receiver's existing
  stereo-window geometry is already right for same-headset pairs, and the frame header makes it exact for others.
- **Refusals are loud and specific** (multisampled swapchain, non-8-bit format, OpenGL below 3.2, no projection layer
  the layer saw created) and always end in the screen capture.

### Built in D7.5.1 (2026-11-02): what the code changed in the contract

- **Plumbing.** `RtcHost.setCameraLayer(vrLayer)` and `setCameraSource(setting)` (the match host calls both at start,
  and the latter on every Match-tab change); `setVr` now carries the rig's `runtime` too. `VrOverlay.layerProtocol()`
  is new (`vr-layer.ts`): the connected layer's protocol once it has said anything on this connection, else null.
- **The channel.** The page is told through the existing `PANEL_CHANNELS.capture` (and `attach.capture`): a capture
  whose `sourceId` is `layer-camera` (`cameraCapture(w, h)` in `panel-page.ts`, `out` 2w x h, `stereo: 'sbs'`, label
  `VR layer camera`) puts the page in camera mode; any screen capture after it takes it out (the canvas track stays,
  the declaration is re-sent without eyes). Frames go on `castcade-panel:camera-frame` as `PanelCameraFrame` `{n,
  width, height, left, right, eyes}` (eyes = the geometry, no data), acked on `castcade-panel:camera-ack`; main's side
  is `createFrameSlot` (`layer-camera.ts`: one in flight, newest waits, older dropped and counted, a lost ack given up
  after 1 s). **No transfer:** Electron's `webContents.send` structured-clones (only MessagePorts transfer
  main → renderer), so each frame is copied once; the two eye views share the frame's one buffer (`Buffer.allocUnsafe`
  of the CVF1 payload, tight to the message), so that copy is the payload and nothing else.
- **While another player is up** main forwards one frame a second (the track is disabled then; the decode of two
  JPEGs at 30 fps would be wasted); at `setSending(true)` the full rate is back on the next frame. The layer keeps
  encoding at 30 fps meanwhile (asking it for fewer while not up is a follow-up).
- **The watch** is `cameraWatch` (`layer-camera.ts`), on a 1 s tick and on every camera status. Two things the code
  taught: (a) at attach the overlay has not started yet (the match host starts it after the panel opens), so
  `layerProtocol` is null at decide time and the 8 s "no frame" clock runs from when the layer comes on the pipe; a
  layer that never comes is given up after `LAYER_CAMERA_PIPE_WAIT_MS` (20 s); (b) when the layer stops the camera on
  its own while it is still asked, `vr-layer.ts` keeps the state `asked` with the layer's `why` (not `off` with a why,
  as `cameraFallback` assumed), so the watch reads that case itself. Also: a pipe that closes after the layer spoke →
  the screen at once; `on` with no frame within 8 s → the screen; an overlay `unavailable` → the screen. The page's
  own stall (no drawn camera frame for 3 s while sending) reports `captureStalled`; main logs `media: capture stalled
  (no new frame from the VR layer camera for 3 s)` and falls back instead of re-picking.
- **Never forward within a match**: once given up, a re-attach of the same match (the panel moving into the headset)
  logs `media: camera: the screen capture (the layer camera failed earlier in this match: …)`; the next match decides
  afresh. The one exception is the player: setting Camera back to `VR layer` on the Match tab tries again.
- **Live switch**: a Camera change while attached takes effect at once between balls, or when this rig's ball ends
  (`media: camera: the change takes effect when this ball ends`).
- **Table sound's pid** comes from one window probe at the camera's start (no screen capture is opened).
- **Item 3, the eyes on the wire (D7.5.2: the wire half in 0.2.33, the receiver half in 0.2.34).** The page's `stereo`
  signal carries `eyes` (`stereoSignal`, re-sent when `eyesKey` changes; protocol 3's optional `MediaSignal.eyes`).
  The receiver's page keeps them per peer (`peerEyes`) and hands them to main with every theater frame
  (`VideoFrame.eyes`, checked by `eyeGeometryFrom`); `vr-layer.ts` puts them on the control (`eyes`, a protocol-3
  layer only, re-sent when they change, dropped when the frames stop carrying them); layer 0.5.1 places each eye's
  window from the sender's crop in the sender's fov (`eyeCrop` with a sender; exact for mixed headsets) and falls
  back to VPX's centre-crop rule for a picture without eyes (the screen capture, an older sender). The bench passes
  its camera's or clip's eyes the same way. **Why it had to land with D7.5.8:** the camera's crop is centred on the
  eye's optical axis since layer 0.5.1 (`vr-layer/src/eye_crop.h`; the solo bench of 2026-11-03 showed the table
  fusing but the two window frames 15° apart under the centre crop), so a receiver that still assumed the centre
  crop would place a 0.2.34 sender's picture 15° off per eye; both rigs update through the updater as always.
- **The log**, first run with Camera = VR layer: `media: camera: the VR layer (the VR layer, once it is on the pipe):
  each eye in a 720x1440 box at 30 fps; no screen capture`, `media: capture VR layer camera ready, both eyes side by
  side`, `media: sending 1440x1440 sbs at 8.0 Mbps`, `media: capture: from the VR layer camera, WxH (sbs)` when the
  first frame's size differs from the request (once per change), and every 10 s while up `media: capture: N frames in
  10 s from the VR layer camera, 1440x1440 (sbs)[, K unreadable][, D dropped before the panel (newest wins)], sent …`.
  With Camera = screen none of these lines, messages or code paths occur.

### D8.1 (2026-11-05, ADR 0009): the one-eye camera, the layer as the default

Spectating is 2D (ADR 0009): the player up is shown as one flat eye. The two-eye contract above stays in the code as
shipped in 0.2.35 (Camera eyes = **both**) and gets no more work; what changed:

- **The request asks for one eye.** `LayerCameraRequest.eye?: 'left' | 'right'` rides on the control's `camera`
  object (`"camera": {"width": 1440, "height": 1440, "fps": 30, "whole": true, "eye": "left"}`); the companion asks
  for `left` (`cameraEyeFor('one')`, `LAYER_CAMERA_DEFAULT_EYE`). A layer that honours it (0.5.3) sends `CVF1`
  frames whose `eyes` array has ONE entry, that eye, with its fov / rect / render as before; a layer that does not
  know the field (0.5.2) sends both. `parseCameraFrame` (`vr-layer.ts`) accepts one or two eyes; `cameraFrameEyes`
  (`layer-camera.ts`) picks: one wanted and two came → the asked eye (left = `eyes[0]`), the other dropped in main
  before the IPC copy; one came → taken as the asked eye (a one-entry frame carries no side). A one-eye frame while
  both are wanted is not a frame for the page. The box is the same per eye whatever the count (`cameraRequestFor`'s
  `eyeHeight`, 1440, is the one knob D8.2's quality presets will turn; `rtc-host.ts` reads it through one
  `cameraRequest()`), so a 3072x3264 eye gives 1354x1440.
- **A mono camera capture.** `cameraCapture(w, h, 'mono')` is a `w x h` canvas declared `mono`; `PanelCameraFrame`
  carries `left` or `right` (the other null) and `cameraFrameSize` says `{width, height, stereo}`; `drawCamera` draws
  the one eye at (0, 0) and `noteStereo('mono', null)`: no eye geometry, so the receivers place it as the flat theater
  screen (`vr-layer: mode theater (mono …)`, `theater: feeding 1354x1440 (mono)`), never from the sender's eyes. The
  receiver side needed no change: `stereoSignal('mono', …)` already drops the eyes, `peerEyes` is null for a mono
  peer, `feedOut` feeds mono. `VIDEO_FEED_MAX.mono` is 1920x1440 now (was 1080 high) so the portrait one-eye picture
  reaches the layer unscaled; `videoBitrateFor` rates 1354x1440 mono by the pixel rule, 7.6 Mbps (720x1440: 4.0).
- **Settings** (`match-setup.ts`): `cameraSource` defaults to **`layer`** (the 2026-11-04 run captured the tester's
  PuP DMD window over his preview; the layer needs no desktop window); new `cameraEyes: 'one' | 'both'` (default
  `one`; the Match tab's **Camera eyes**, applied live like the view: `RtcHost.setCameraEyes`, the layer re-asked and a
  running match capture replaced); new `settingsVersion` (2). `loadMatchSettings` migrates a `match.json` without one
  (0.2.35 and before) to `cameraSource: 'layer'`, `cameraEyes: 'one'` once (`match: match.json from before 0.2.36 …`)
  and the match host saves it at version 2, so the testers who set the screen capture by hand for the 2D test get the
  layer camera; their later choices stand. `decideCamera`'s fallbacks (PC rig, SteamVR, a protocol-2 layer, refusals,
  the watch) are unchanged and still logged.
- **Logs.** `vr-layer: mode … (…, camera 1440x1440 at 30 fps, whole view, one eye (left))` / `…, both eyes)`;
  `media: camera: the VR layer (…): one eye (left), its whole render in a 1440x1440 box at 30 fps; no screen capture`
  / `both eyes, each eye's whole render in …`; `media: capture VR layer camera ready, one picture`; `media: sending
  1354x1440 mono at 7.6 Mbps`; `media: capture: from the VR layer camera, 1354x1440 (mono)`. The VR report prints
  `- Camera eyes: one (left) | both`. The frames saver writes a one-eye frame as `NNNN-L.jpg` only (whichever eye it
  is; the index lists `right: null`, the header's `eyes` has one entry) and the bench plays it back as a mono picture;
  the bench on "my own table, live" follows the eyes setting too.

## 5b. The VR test bench and saved frames (D7.6, D7.6.3, 2026-11-03)

**Why.** Every headset finding so far cost a two-person session; the bench answers theater geometry, scale, detail
and frame rate on one rig in five minutes, and saved frames give the real images for offline analysis.

- **Saved frames** (`media/frame-clip.ts`; the Match tab's **Save 2 s of frames**): `<logs>/frames/<yyyy-mm-dd-hhmmss>/`
  holds, for 2 s and at most 120 frames per side, every layer-camera frame (`NNNN-L.jpg`, `NNNN-R.jpg` as the layer
  sent them, `NNNN.json` = the frame header `n, t, w, h, us, eyes`) while the camera runs, every theater frame the panel
  page hands to the layer (`in-NNNN.jpg`, encoded in the page at quality 90 at the decoded size, one encode in flight;
  `in-NNNN.json` = size, stereo, eyes if known, time, source) while theater shows, and `clip.json` (both lists, the
  recorded fps and sizes, the settings in force). Log: `media: frames: saving 2 s to <dir> (layer camera on|not
  running, theater feed on|not running)`, then `media: frames: saved N sender frame(s) (WxH per eye, F fps) and M
  received frame(s) (WxH sbs, F fps) to <dir>` and a `media: frames: <side>: …` line for a side that was empty.
- **The bench** (`media/bench.ts`, `RtcHost.startBench`, `MatchHost.startBench`; the Match tab's VR test bench card,
  `renderer/src/views/TestBench.tsx`): the panel page is opened without a match (a `castcade-panel:bench` message
  instead of the attach: no mesh, no microphone, no capture, no listener); refused while a match is on, and a match
  hosted or joined stops it. On a VR rig off SteamVR the OpenXR layer is started with the bench's panel and video
  sources and put in theater (Theater size live), exactly the receiver's path: the page's `feedTick` → `feedOut`
  (feedSize, `VIDEO_FEED_MAX`) → `castcade-panel:video` → the layer. On a PC the picture shows in the desktop panel.
  Sources: a saved clip (sender eye frames or received frames, looped at the recorded fps by the wall clock), or
  **my own table, live** (the layer camera; it reads VPX's submitted eye views in `cameraTick` before `compose` drops
  them for theater, so the window shows the player's own table to compare with the direct view: the card's **Show
  VPX's own view** sets the layer to hidden while the bench keeps running). Paths: **straight to the layer** (the bench
  canvas, no encoder) or **through a local WebRTC loop** (two RTCPeerConnections in the page, the canvas track under
  `videoBitrateFor` and `contentHint = 'detail'`, the received track fed as a peer's is). Stop: theater off (`hidden`),
  300 ms for the control to land, the pipe closed, the panel destroyed.
- **The log**: `bench: …` lines from the match host (`running (vr_headset via virtual-desktop; theater in the
  headset)`, `the OpenXR layer showing, theater at Theater size 1`, `stopped (…); VPX's own view is back`), and from the
  media layer `media: bench: started: <source>, <path>, <where>` and every 10 s `media: bench: 30 fps drawn · 1440x1440
  sbs to the layer at 30 fps[ · encoder sent 1440x1440 at 7.8 Mbps (cap 8.0 Mbps), 30 fps, limited by none]`, plus the
  layer's own `theater: feeding 1440x1440 (sbs) to the layer` and `vr-layer camera: …` lines.
- **Window tuning (0.2.35, D7.6.10; layer 0.5.2)**: the bench card's **Window depth**, **Vertical offset** per eye and **Soft edge** are match
  settings (`windowDepthM`, `eyeOffsetDeg`, `softEdge`) that ride on every control to a protocol-3 layer (`tune`, `feather`;
  `main/match-host.ts` `syncWindowTune`), bench and match alike, so the owner can tune by eye and the VR report reads the values
  back. They exist because the owner's 0.2.34 check showed the window's frame doubling at its edges while the picture fused: a
  frame at infinity seen while converged on the table. The cure is the Match tab's **Camera view** = whole (D7.5.10: the camera
  sends each eye's whole render, so the frame falls outside the shared field); the sliders measure what remains, and the
  pattern follows them too.

## 6. Checks only the rig can answer (run before the first match)

1. **VR controller input under the lock** (15 min): with a table open in VR, create `turn.lock` by hand; the flippers
   must go dead; delete it; they return. If VR controller buttons bypass `_KeyDown`, the lock needs the plugin path.
2. A table left with a ball in the shooter lane for several minutes: ball save, attract timers, auto-plunge.
3. The VR preview window capture inside the companion (the spike proved it at 1280x720).
4. The overlay helper drawing over VPX's VR session; readability of the panel at the chosen size and offset.
5. Krobs' and the owner's routers: direct WebRTC with STUN; the host's forwarded TCP port for the match socket.

## 7. Not in this milestone

The ArcAid lobby and Throwdown result (F6, A5), host transfer in the UI (engine only), the runner stage and watch link
(D3, D4, D5), push-to-talk, a TURN server of ours, DMD frames on the panel.

## 8. Series: more than one game in a match (A10, A11; 2026-11-02)

Owner, 2026-11-02: "after you start match, play one full game, be able to start another game without leaving the table
VR view", and start the match from inside the headset too. Built 2026-11-02 (protocol 3); untested on a rig. Gates:
A10, owner + Krobs play two games back to back in headsets; A11, both in headsets from Host / Join to the first ball.

**Shape (the lead's decision).** One Throwdown, N games, in ONE hash-chained log. Each game ends exactly as a single
game did (every player finished or forfeited, the log holds still, LOG_SIGN, one signed RESULT), and that RESULT
carries `game` (1-based) and `series`, the standings so far. The log then continues: the host's `NEXT_GAME`
(`{game, playerOrder}`, logged) starts game N+1, and each later RESULT signs the log head at the end of ITS game. The
host's `MATCH_END` (`{games, reason}`, not logged: the last RESULT stands) ends the series; the existing teardown then
runs. `TURN_GRANT.grant.game` names the game too (signed and logged; optional in the schema with no default, so a grant
is the same object on both sides). Protocol 3: `NEXT_GAME` is a new logged message type, which a protocol 2 peer could
not fold; both rigs run the same build through the updater.

**Series standings** (`match/result.ts` `seriesStandings`): per player the games played, the outright wins (a tie for
first wins nobody that game, as `RESULT.winner` is null then) and the total score; ranked by wins, then total score
(competition ranking). Folded from the log (`MatchState.pastGames`), so a host that took over mid-series computes the
same table. Every participant who played any game is in it.

**The next game.**
- At a RESULT the match stays open: peers, mesh, voice, panel and overlay. The panel (header `GAME 1 OVER`) shows the
  game's standings, with the series place and wins once there are two games, and "Next game: <host> starts a game on
  the table" (the host's own: "start a game on your table (or press Next game)"). The headset is in panel mode (the
  view mode of `over`). From game 2 the turn line says the game (`GAME 2 · YOUR BALL 1`) and each row its series wins.
- Lock between games: the host's table is unlocked (its Start starts the next game); a client's stays locked until
  its grant in the next game (it would otherwise start a solo game that the next grant then scores). The series over
  (`MATCH_END`, or the host gone between games: `ClientEvents.hostGone`) unlocks every table.
- Trigger: the host's own `game_start` (the hook's, which the witness already follows), only once the current game's
  RESULT has gone out (`HostMatch.nextGameBlocker`): a `game_start` seen before that, or during a game, is ignored.
  The host's Match tab also has **Next game** (the same IPC call as Start match: main decides by the phase) and **End
  match** (the host's Leave between games: MATCH_END first). A client's `game_start` never starts a game.
- Game N+1's `playerOrder`: the roster still connected, in roster order, the host first (its table started the game,
  so grant 1 is the host's). Every listed player starts afresh (ball 1, score 0); `grantSeq` keeps counting. A player
  who left before the game is out of its order, its entries and its signers, and stays in the series with the games
  it played. With fewer than two connected, no next game.
- Readiness: there is no "your table is back on the attract screen" signal for a client, so a client whose VPX is
  still on the last game's game-over sequence is told nothing; its grant waits as any grant does (it starts its own
  game when the grant unlocks it).
- After MATCH_END a client keeps the final standings up for 20 s and then closes the match by itself, so the headset
  does not keep a dead panel; the host's End match tears down at once.

**Edge cases built and tested** (`match/series.test.ts`, `controller.test.ts`, fakeclient `two-game-series`,
`main/match-host.test.ts`):
- Reconnect mid-series: the RECONNECT_ACK carries the NEXT_GAME entries like any other, so the game number comes back
  with the log. The host then sends every RESULT it sent, oldest first, each in a fresh envelope (a resent frame with
  its old `seq` was dropped by the receiver's seq rule: true of A3's single resend too, fixed with this).
- The last RESULT of game 1 reaching a late peer (already in game 2): the client checks it against its own log entry
  at that game's end (`RESULT.logLength`), not its head, and raises `result` once per game.
- Host transfer mid-series: transfers happen during a game, as before; the new host's `resumeFromLog` folds the
  series from the log, finishes the game, sends its RESULT with the same series and can start the next game.
  Between games there is no transfer: a host gone then ends the series for the others.
- A LOG_SIGN for an earlier game (late) is dropped by the host; a client signs once per game it played.
- A NEXT_GAME that is not the next number, or arrives while a game runs, is dropped by a client (not logged).

**A11, the start from the headset.** In the lobby the host's `game_start` starts the match when two or more are in and
every joined table is open (`HELLO_ACK.loading` is empty; open = a table hash, or at least a table name, in the
fingerprint: `match-setup.ts` `isTableOpen`): a 5 s countdown (`HostMatch.startIn`) that every panel shows
(`STARTING IN 5`, "Starting the match: <names>"; clients learn it from a re-sent `HELLO_ACK.startsInMs`, a duration
because the two clocks need not agree), then MATCH_READY. A second plunge does not restart or cancel it. With a table
still loading the start is armed and fires once the last table opens; the host's game ending in the lobby (game end,
abandoned, table exit) disarms it. Fewer than two when it runs out: nothing starts. The desktop Start button stays,
works during the countdown (it starts at once; the countdown then does nothing) and cancels nothing. Lobby rows whose
table is not open say LOADING on every panel. The alternative, an explicit Castcade key read by the hook and journaled,
stays unbuilt until the first-game rule proves too eager (it needs a journal version bump and a fixture).

**For the F-lane (ArcAid, A5 / F6): one Throwdown with N results.** A Castcade match stays one Throwdown
(`play_mode='castcade'`), but it can carry several games: the companion will post one RESULT per game, each with
`game` (1, 2, ...), the game's ranked entries, its own `logHash` / `logLength` (heads of one growing log, so game 2's
head extends game 1's) and signatures, plus the `series` standings after it (wins, then total score). ArcAid needs a
way to hold N results under one Throwdown (a `game` column on the result or the `castcade_matches` record), to show
the series standings, and to decide what the Throwdown's own outcome is when the series ends (the last RESULT's
series ranks, or each game as its own scored round). The end of a series is not posted as a separate message today
(MATCH_END is peer to peer and unlogged); the post after the last game is the final one.

## 9. One step to a match, and any order (A14, 2026-11-12)

Owner, 2026-11-12, about hosting: "I do not want to have to start VPX, launch the table, switch views back to desktop,
Host session, copy code, paste code in Discord, wait for player while watching Castcade, after player joins press start
match, then switch view back to VR table, then play. It's really clunky and cumbersome and if any of that is out of
order, things seem to fail." Target: the host picks a table, presses Host and puts the headset on; the friend opens a
link and puts the headset on. A11 (the host's first Start on the table starts the match), A12 (free play until someone
joins) and the headset panel already carry the rest. Built 2026-11-12; **the launch, the link registration and the Match
tab were not run** (unit tests and typecheck only: the machine was busy with an unattended VPX run); §9.5 is the rig list.

### 9.1 Host starts the table and copies a link (step 1)

- The Match tab's Host card has a table picker (`renderer/src/views/OneStep.tsx` `TablePicker`): the tables Castcade
  knows, which are the imported ones (a manifest under `<userData>/witness/tables` whose `.vpx` is still there,
  `launch/known-tables.ts`), most recently played first (`<userData>/recent-tables.json`, noted when the witness sees a
  table open), then most recently patched; a search box narrows by name or ROM. "No table: I open it myself" stays.
  **Browse…** adds every other `.vpx` of the tables folder and one level of sub-folders (the listing a joining rig
  searches, `listTableFiles`), marked "not imported", so a table Castcade never patched can be hosted; if it cannot
  report ball ends, the lobby says so and Start asks the host to confirm (A13), as for any such table.
- Host (`main/one-step.ts` `host`) = `MatchHost.host`, then the join link on the clipboard, then VPX on the picked
  table: `"<VPinballX exe>" -Play "<table.vpx>"` from the exe's folder (`launch/vpx-launch.ts`; the switch the witness's
  process watch reads back and `scripts/validate-original.ts` uses; no other switch, so the player's ini, display and VR
  settings apply). The exe is the one the witness last saw running (`vpxExe`, settings.json): on a rig with several
  builds, the one the player plays. Started without a shell and let go; the witness finds it like any launch.
- **A table already open is used and nothing is started** (the witness names a current table; a VPX editor with no table
  does not count, an editor with a table loaded does: press Play there).
- The link is `castcade://join/<invite>` with the invite URL-encoded (`main/deep-link.ts`): the six-letter code once
  ArcAid carries the match (D10.8: `MatchStatus.invite` is the code then), the address invite otherwise. The Match tab shows it with Copy, and a chat
  line with Copy for chat: `Castcade match on <table>: castcade://join/… (copy the link, then in Castcade press Match,
  Paste, Join)`. The Join box takes a link as well as an invite.
- **Discord does not make `castcade://` clickable.** Discord's community forum has users reporting that since May 2023
  only `http://`, `https://` and `discord://` links are clickable in messages (`steam://` links stopped then); no
  official statement was found, and it was not tried in a Discord client here. So the chat line carries instructions.
  The click-through fallback is a redirect page on ArcAid, `https://arcaid.app/castcade/join/<invite>`, which answers
  with a page that opens `castcade://join/<invite>` (and says to install Castcade when nothing handles it). That is
  ArcAid work (its W96, live from ArcAid 2.243.0).
- **The clickable link (A14.2).** When ArcAid carries the match (the invite is the code) and this PC's ArcAid address
  is `https://`, the link Host copies, the Match tab shows and the chat line carries is
  `https://arcaid.app/castcade/join/JHDFEF` (`formatWebJoinLink`: upper-case code, no trailing slash), and the chat line
  is just `Castcade match on <table>: <link>`. An address invite keeps the `castcade://` form and its instructions (the
  web form would put the host's address in a request to ArcAid and needs an encoded `/` and `#` through its proxy,
  untried). The Join box reads the web form like the `castcade://` one; the command line still takes only
  `castcade://`. Not tried in a Discord client or a browser with Castcade installed.
- **The invite before the table (A14.7, 2026-11-15).** Owner: "when you click host, you are put in to VR view. You
  have to exit out of VR to copy the code and paste it in to Discord." Host no longer starts VPX by default: it hosts,
  copies the link and holds the picked table (`OneStepStatus.tableToStart`); the card's **Start the table** button
  (`OneStep.startTable`, IPC `launch:startTable`) turns the held table into the same wish Host used to make, so the
  launch, its two-minute wait and its failures are unchanged. The held table is dropped when the match ends or when
  the host opens a table by hand. `match.json` `startTableOnHost` (default false; the Host card's "Start the table as
  soon as I host") keeps the one-press Host. A friend who joins meanwhile is in the state §9.3 already covers (the
  host's table opens after the join). Unit tests only; not run in the app.

### 9.2 The link joins and starts the table (step 2)

- `castcade://` is registered per user: by the app at every start (`app.setAsDefaultProtocolClient`, packaged builds;
  a development run only with `CASTCADE_REGISTER_LINKS=1`) and by the installer (`build/installer.nsh`, the same
  `HKCU\Software\Classes\castcade` keys, removed at uninstall). electron-builder's `protocols` key is set too, but its
  NSIS target does not read it (macOS, Linux and AppX only; checked in app-builder-lib 26).
- Windows starts `Castcade.exe "castcade://join/…"`. A first instance finds it on its command line (`linkFromArgv`),
  a running one gets it from `second-instance`. Either way the window comes up on the Match tab.
- Opening a link joins that match with the saved name, then starts the host's table here: the host's game is
  `HELLO_ACK.hostGame` (`MatchHost.hostGame()`), matched against the tables on this PC by `launch/find-table.ts`: the
  same file (SHA-256), then the same ROM (the fingerprint carries none today), then the same name, whole or by title;
  an imported table before a `.vpx` only found in the tables folder; then the most recently played. The advisory on the
  panels then says what it says for a pasted invite. No copy here: "The host plays <table>. Castcade found no copy of
  it on this PC…", and the player stays joined. A match that is gone: "That match is gone or cannot be reached: ask
  the host for a new link."
- **The link is untrusted input.** Only the exact shape is taken (scheme, `join`, one segment, at most 300 characters,
  the decoded invite one of the two invite shapes); only the invite comes out of it. Nothing of a link, and nothing of
  the host's fingerprint, is ever a path, a program, a switch or a shell string: the table started is one from this
  PC's own lists, the exe must be an absolute `VPinballX*.exe` that exists, and the process is spawned with an argument
  array and no shell. **A link acts without a click only when Castcade's window was already on screen with the Match tab
  showing** (`linkIsTrusted`). Otherwise (the app closed, in the tray, minimised, on another tab, or a cold start) the
  Match tab asks first: "Join this match? … Joining turns your microphone on for the other players and starts the
  host's table in VPX." The click gates the join as well as the table start, which is stricter than "before launching
  VPX": joining opens the voice mesh, and a web page must not do that silently either.

### 9.3 Any order: the audit (step 3)

The pieces: companion start (C), VPX start (V), the table loaded (T), Host or Join (H), the other player's join (J), the
VR preview on or off (P). The match host already followed the witness rather than a sequence for most of these (A6's
lobby refresh, A11's armed start, A12's wait); the audit ran each ordering as a test over two real match hosts with a
witness the test drives (`main/match-host-orderings.test.ts`) and fixed what failed. The table start is a wish that
`one-step.ts` `settle` re-checks on every match and witness status, so it has no order either.

| Ordering | Before | Now | Tested by |
|---|---|---|---|
| C after V, T: Castcade started with a table already running, preview on or off | Preview off: `launch null`, the table unread for minutes | C14 (0.2.39): the table comes from the hook's journal of that process | `witness.test.ts` "C14: started with a table running and no window title…" |
| H before V: Host with no VPX | Worked in the engine (row LOADING, then the table), but the player had to take the headset off again to start VPX | Host starts VPX on the picked table; the lobby follows when it opens | orderings "Host before any table…"; `one-step.test.ts` "hosts, puts the join link on the clipboard and starts VPX…" |
| J before the host's T: the friend joins while the host's VPX is still loading | Joined, flagged "different table file" until the host's table opened; the friend had to guess the table | The link joins, waits for the host's fingerprint, then starts the same table here | orderings "Host with a table, the friend opens the link before the host's VPX is up…"; one-step "joined before the host's table is open…" |
| J before the friend's own T | Row LOADING, then right (A6) | Same; the link starts the table | orderings "Host before any table…" |
| The host's Start pressed while another table is still loading | Armed, fires when it opens (A11) | Same | orderings "the host's Start pressed while the other table is still loading…" |
| H while a game is already running on the host's table, free play | The join waits for that game; the next Start starts the match (A12) | Same | orderings "Host while a game is already running on the table (free play)…" |
| H while a game is running, "Table locked until someone joins" | **The lock went on in the middle of the ball**: flippers and plunger dead, the game could not end | The running game keeps its keys; the lock goes on when it ends, off when the lobby is complete (`controller.ts` `syncLobby`) | orderings "Host while a game is running, with Table locked…" |
| T already open at Host or at the link | Worked | Used as it is; nothing is started | one-step "a table that is already open is used…", "a table already open here is kept…" |
| T closed and reopened in the lobby | Row LOADING, then open again; the start from the table still works | Same | orderings "the table closed and reopened in the lobby…" |
| T closed and reopened between games, either rig | The series stays open; the reopened host table starts the next game; the client stays locked until its ball | Same | orderings "the table closed and reopened between games, on both rigs…" |
| T closed during a game | That player forfeits ("table closed"): a pinball game cannot be picked up again | Same, by design | `controller.test.ts` (table_exit) |
| A link with Castcade closed, in the tray or on another tab | (no links) | The window comes up on the Match tab and asks; nothing is joined or started before the click | `deep-link.test.ts` "a link acts without a click only when…"; one-step "from outside…" |
| A link while already in a match; the same link twice | (no links) | "You are already in this match." / "That link is for another match…"; nothing changes | one-step "text that is not a join link is ignored…" |
| A link for a match that ended, or whose host left while the link waited for the click | A pasted invite said "Could not reach the host…" | "That match is gone or cannot be reached: ask the host for a new link." | orderings "a link for a match that ended while it waited…"; one-step "a link for a match that is gone says so…" |
| The match ends while a table is still to be started | (new) | The wish is dropped; nothing starts later | one-step "the match ending while VPX is still to be started…" |
| VPX slow, or it never shows the table | (new) | Not started twice; after 2 minutes the tab says to open it by hand; if it opens after all, the tab follows | one-step "VPX that does not start, or never shows the table…" |
| P off (no preview window) at Host or Join | The rig read `pc` until the witness sampled VR, then the panel moved into the headset (A6); the camera is the layer's (D8.1), so no window is needed | Same | `match-host.test.ts` "host on the monitor reading, then the witness reads VR…" (existing) |
| J after the match started | Refused by the host ("the roster is final"); through ArcAid the room is locked at the first game (D10.8) | Same; a link says the answer as it came ("That match has already started (CODE): only its players can come back to it." or "Could not join that match. The host refused…") and starts no table | engine tests (existing); one-step "D10.8: a link opened after the match started…" |
| The relay reconnecting (a pause, the client's bounded `no_such_match` retry, a host re-hosting the same code) while a link waits for the host's table | (new) | The wish is kept while this rig is still in the match; the same link stays valid | one-step "the wait for the host's table outlasts a pause…" |
| The witness rebuilt during a match by a settings change (the ArcAid address, the NVRAM folder), A15 | **The game in progress was fed to the match a second time**: on this player's ball 2 the replayed end of ball 1 passed the turn; in a free-play lobby the replayed Start started the match in the middle of the host's game. The replaced witness also went on reading the journal and posted the game a second time at its end | The new witness is given the old one's journal mark (file, table load, byte position of the last event delivered) and delivers nothing at or before it again; the journal is still read from the top, so the game on screen, the attempt and the game count are rebuilt. A stopped witness stops its journal tails | `main/witness-restart.test.ts` (two match hosts, the real witness and witness host); `witness.test.ts` "A15: …" |

**Not fixed, known:**
- Castcade restarted in the middle of a match: fixed by A15, §10 (what it does not cover is listed there).
- A VPX editor open with a table loaded but not playing counts as "a table is open": Host starts nothing and the player
  presses Play. A second VPX is never started beside it.

### 9.4 Decisions taken alone

- The link's click gates the join as well as the table start (§9.2).
- The picker lists imported tables first (the owner's words: "the tables Castcade already knows") and the rest of the
  tables folder behind Browse…; a joining rig also
  looks at plain `.vpx` files in the tables folder and one level of sub-folders, by name, after the imported ones.
- The name match takes the title before the first bracket ("Monster Bash (Williams 1998) 2.1" = "Monster Bash"). A
  wrong pick is an advisory on the panels ("different table file"), never a refusal.
- `-Play` and nothing else; the exe is `vpxExe` (last seen running). No `-Minimized`, no `-Ini`.
- The link is copied, not the chat line; the chat line has its own button.
- A development run does not register the scheme unless asked.
- One code change in the engine: the lobby lock never goes on during a running game (the row above).

### 9.5 Rig checks (none of this was run)

1. Install the build; `HKCU\Software\Classes\castcade\shell\open\command` names the installed `Castcade.exe "%1"`.
2. Host with a table picked and no VPX running: VPX starts on that table in the headset build, the link is on the
   clipboard, the lobby row goes from LOADING to open; the log has `launch: started VPX on … (-Play, pid …)`.
3. Host with the table already open: nothing starts; the tab says "Using the table that is already open".
4. Win+R, paste the link, with Castcade closed: Castcade opens on the Match tab and asks; Join and start the table
   joins and starts the same table. With Castcade open on the Match tab: no question.
5. The same from a browser's address bar, and a look at how Discord shows the link and the chat line.
6. The friend's rig without the table: the tab names it and the match stays joined.
7. A second link while in a match; a link after the host left.
8. With "Table locked until someone joins": Host during a ball; the flippers stay live until the game ends.

## 10. Castcade restarted in the middle of a match (A15, 2026-11-12)

Before: a companion that closed or crashed during a match was out of it. A client had no way back (the host refuses a
new HELLO once the roster is final); a host's match was gone, and its clients, after 30 s of retries, each made itself
"host" of a match nobody could reach (the `host_left` transfer needs a listener the others can come to, which a client
over WebSocket or the relay does not have). Built 2026-11-12; **nothing here was run in the app or on a rig** (engine
and match-host tests only); §10.6 is the rig list. No protocol change, no journal change.

### 10.1 What is saved

`<userData>/match-resume.json` (`main/match-resume.ts`), from MATCH_READY on, never in the lobby. Written whole (tmp +
rename) inside `Session.commit` at every entry of the match log, before the frame that carries the entry is sent, so the
file is never behind what another player was told; and every 15 s as a sign of life (`aliveAt`). Removed when the match
is left, when it ends for good (MATCH_END, the host gone), and when another match is hosted or joined.

In it: the match code; a client's invite as it joined (the code, or the host's address and port for a direct match); a
host's port and whether ArcAid carried the match; this player's id and name; the other players' names; the match log
(the roster with names, ids and public keys, the table fingerprints, grants, ball ends, scores: what went over the
wire); the witness's journal mark at the last log entry. Not in it: the private key (still only `match-keys.json`), the
pairing token, anything of voice or video. The file alone gets nobody into the match: RECONNECT is signed with the key.

### 10.2 At start

- A record older than its bound is dropped: 20 minutes for a client (the host pauses for a dropped player until
  someone acts; 20 minutes is the protocol's own limit for one ball), 3 minutes for a host (`HOST_WAIT_MS`: after that
  no client is still waiting).
- Castcade was alive in the match under 75 s ago (a minute, plus one heartbeat), or closed itself to install an update
  (`restart: 'update'`; `quit(install)` no longer leaves the match): the shell rejoins without asking. The player did
  not leave, and the microphone was on in that match a moment ago.
- Otherwise the Match tab shows "You were in a match … Rejoin the match with <names>" / "Forget it" (a host: "Host it
  again"). Hosting or joining something else drops it.
- The turn lock is left as the last run left it while a record waits (before A15 it was always removed at start), so a
  table that was locked for another player's ball stays locked until the rejoin or Forget it.

### 10.3 The rejoin

- **Client**: the saved log is loaded (its hash chain is checked), a `Session` is built on it with its `seq` started
  from the wall clock (the host rejects a frame whose `seq` is not above the last it took from that player, and the
  counter of the last run is gone), `ClientMatch.adopt` + `relinkTo`: the same RECONNECT / RECONNECT_ACK as after any
  drop, through ArcAid (the room is joined again first; a locked room takes a device that held a seat) or to the host's
  address. The controller is built from the log's state (`MatchControllerOptions.resumed`): phase, roster, scores, who
  is up. The table keeps its keys only if the log says the outstanding grant is this player's; the host's answer
  confirms it or locks. The player's own RESUME clears the pause the host raised for its drop (A8), and the grant comes
  again under a new number.
- **Host**: the same code is hosted again: the listener on the saved port, the relay room under the saved code (a room
  that is gone is opened anew; it is locked again after a minute, so its players can come back first),
  `HostMatch.resumeFromLog` with every other player marked gone, then `runAfterRestart`: the outstanding grant is
  issued again (at once when it is the host's own; else the usual disconnect pause until its holder is back), or,
  between games, the result goes out again so the next game can start. The clients come back by their own retry.
- A rejoin that gets no answer in 20 s says so and keeps the record (Rejoin tries again); one the host refuses
  (`unknown_log_hash`, `bad_signature`) drops it.

### 10.4 The table: what happened while Castcade was closed

The hook keeps journaling. `TableBacklog` (`match-resume.ts`) sits between the witness and the controller:

- The witness says for each event where in the journal it is and whether it was there before the witness began to
  read (`backlog`). After a restart, an event at or before the saved mark was already answered by the log and is
  dropped; everything after it is held until the host's answer is merged, then fed in order. So a ball end that
  happened while Castcade was closed is reported once, for the grant as re-issued, and an earlier ball of the same
  game is not reported again (A15's first half, the witness mark, is the same notion one level down).
- Ball ends the host turns out to have already (reported just before the crash, or the host passed the turn by hand
  meanwhile) are counted from the log (this player's BALL_END and TURN_PASS entries now, minus those in the saved log)
  and that many of the first held ball ends are skipped.
- The same list serves a plain reconnect: what the table said since the log last grew is fed again after
  `reconnected`, so a BALL_END sent into a link that had just dropped is sent again (before A15 it was lost and the
  host waited for a ball that had already drained).
- A journal from another load of the table than the saved mark names: the table was closed and opened again, the game
  cannot be picked up, and the player forfeits it, as at any table close.

### 10.5 A host that is gone, and what is not covered

- A client now waits 3 minutes for its host ("The host's Castcade closed or lost its connection. The match is paused:
  waiting up to 3 minutes for it to come back."), by the clock (`reconnect.maxMs`), then the match ends for it with
  "The host did not come back within 3 minutes: the match is over." It never makes itself host
  (`hostLeftTransfer: false` in the companion; the engine's default, for a full mesh, is unchanged).
- Through ArcAid the room outlives its host by 30 s; after that a client asks for it again five times, the last 88 s
  after the first miss (`HOST_WAIT_REJOIN`; before: five asks over 18 s). So through ArcAid a host has about two minutes
  to come back, not three. Five misses stay under the server's lockout (eight in ten minutes).
- Not covered: while Castcade is closed nothing locks the table, so a player can play on past the ball it was granted;
  the match takes the first ball end and the rest is theirs to sort out (the host's Pass the turn). A host's lobby is
  not saved (host again; the link changes). A match that changed hands by a host transfer is not saved. A player who
  reopens Castcade with VPX closed is back in the match with no table; the forfeit comes when a table is opened. Table
  mismatch notes and which tables can report ball ends are lobby facts the log does not carry: a host that came back
  shows none. Voice and video are set up again from nothing.

### 10.6 Rig checks (none of this was run)

1. Two rigs, a match under way. On the client, during the host's ball, end Castcade from Task Manager and start it
   again within a minute: it is back in the match by itself, the table still locked, the host's panel goes from
   "Paused: waiting for … to reconnect" to playing. Voice and the spectator picture come back.
2. The same during the client's own ball, the ball kept in play: the flippers never die; after the rejoin the turn is
   still the client's and the ball end passes it once.
3. The same, but drain the ball while Castcade is closed: after the rejoin the turn passes at once with the right
   score; `companion.log` has "table event(s) since the log last grew go to the match now".
4. Wait two minutes before starting Castcade again: the Match tab offers "Rejoin the match with …"; nothing is joined
   before the click. Forget it unlocks the table.
5. End the host's Castcade: the client's panel says it waits 3 minutes. Start the host's Castcade within a minute: it
   hosts the same code again by itself, the client reconnects, play goes on. Once through ArcAid, once direct.
6. End the host's Castcade and leave it: after 3 minutes the client's Match tab says the match is over and its table
   is unlocked.
7. With an update downloaded, "Restart to update" during a match: the others see a pause, not a forfeit; the new
   version rejoins by itself.

## 11. A lobby that outlives a match (A17, design 2026-11-24)

Owner, 2026-11-23, after a night of four matches, each with a new code and a voice connection made again: "keep our
audio session live, even between matches … 'join lobby'. Anyone in the lobby can all chat. Then we start and end
matches without leaving the lobby." **Design only: nothing in this section is built.** Revised 2026-11-24 after an
independent review that checked it against the code; the lead's rulings on that review are worked in, and §11.13
lists what they changed. The owner's rulings it is built on (2026-11-23 and 2026-11-24, fixed):

1. One lobby, joined once an evening; the voice stays live between matches.
2. Anyone in the lobby can start a match.
3. The table can change between matches without anyone leaving.
4. People who do not play can sit in the lobby and watch the player who is up.
5. A watcher sees what a waiting player sees today: the table in 3D in their own VPX when their PC has the Castcade
   VPX build and the table, the 2D video otherwise.
6. Each person sets themselves to Play or Watch; Start starts the match with the people set to Play.
7. Four people in the lobby in all, players and watchers together. Five or more is A17.1 (§11.11).
8. "We never want another player's disconnect to cause the active player to have a messed up session."

The lead's decisions, kept: the PC that opened the lobby arbitrates every match in it, also one somebody else starts
and one its owner only watches, and the lobby ends when that PC leaves (the hand-over to another PC is the next work
after this, §11.8a); a watcher is on the voice and hears the table of the player who is up; the lobby is protocol 7;
a watcher is in no result and each match is its own Throwdown (ADR 0002). Two are changed by what the code says,
both in §11.13: a watcher's table **is** locked while it shows the player who is up, and Watch is not written into
any logged message.

Words used here: **the lobby's PC** is the PC that opened the lobby (the `host` in the code and the protocol; every
other PC is a `client`, whether its owner plays or watches). A **member** is anyone in the lobby. A **player** is a
member who is in the match being played. A **watcher** is a member who is not. **The starter** is the one person
whose Start on their own table begins a game (§11.4).

### 11.1 What is there today (read in the code)

- **One connection, one match.** `main/match-host.ts` holds one `Active` from Host / Join to `teardown`. The engine
  (`match/host.ts`) has a lobby only before the first game: after `MATCH_READY` a `HELLO` is refused
  (`match_started`, "the roster is final"), and after `MATCH_END` nothing more can happen.
- **Everyone plays.** `HostMatch.start()` puts the whole lobby into `MATCH_READY.playerOrder`; `onHello` refuses a
  fifth person (`match_full`). The fold (`match/state.ts`) builds its `players` from `playerOrder` alone, and a
  series already knows a person who is in the roster and not in a game (`NEXT_GAME.playerOrder` leaves out a player
  who dropped; `protocol/docs/prose.md`: "A participant left out of a game is still in the roster … it plays, signs
  and ranks only in the games it is listed for").
- **A PC that is in no game still reports from its table.** `MatchController.feed` sends `GAME_OVER` at the table's
  `game_end` and a `FORFEIT` at `table_exit` whenever `inPlay()` holds and `myGameDone()` does not, and both are so
  for a PC that is not in `players`; `leave()` forfeits the same way. The host rejects both (`onGameOver`,
  `onForfeit`), so the log is safe, but that PC's panel says "The host rejected GAME_OVER". Only `restore()` sets
  `myGameOver` for such a PC today.
- **The voice begins at the match, not at the join.** The panel page is attached at Host / Join with no peers;
  `MatchController.onReady` adds them at `MATCH_READY` (`match/controller.ts`). **And adding a peer is a re-open:**
  `SignalingMesh.add` (`media/rtc-signaling.ts`) removes the peer and builds a new connection, and the controller
  calls `addPeer` in `onReady`, in `onPeerBack` and in `restore`. The native video connections and the state-stream
  tunnels do open in the lobby (`syncNativeVideo` and `syncStream` follow the roster on every status).
- **What ends the media.** The host's End match is `leave()`: `MATCH_END`, 300 ms, `teardown`. A client closes by
  itself `SERIES_OVER_LINGER_MS` (20 s) after `MATCH_END` (`scheduleSeriesEnd`). `teardown` closes the video mesh
  (`closeVideo`), the stream tunnels (`stream.close()`), the overlay, the controller (whose `close()` calls
  `media.detach()`: the voice), the transport, and tells ArcAid the room is left. Besides that, any dropped link
  takes that person's voice connection down at once (`onPeerLeft` → `media.removePeer`), which is half of A18.
- **A drop in the lobby is a leave** (`HostMatch.onPeerLeave` removes the person; `RECONNECT` is answered
  `match_not_started`). **A drop during a game pauses the match at once** when the person still has balls to play,
  whoever is up (`onPeerLeave` → `pause('disconnect', peer)`), although the rotation would pause by itself when the
  turn reaches a person who is gone (`advance()`). The other half of A18.
- **A pause takes the picture away.** `vrViewMode` gives everyone but the player up the panel in any phase but
  `playing`, and `syncStream` sends a VPX to watch only while the phase is `playing`: a 3D watcher's VPX goes back
  to its own table at a pause, and the watch starts again at the grant that follows the `RESUME`.
- **The table is the host's.** `HELLO_ACK.hostGame` is the fingerprint of whatever the host's witness sees open, and
  the host has no other fingerprint of its own: `loading()` reads `hostGame` for the host's row, `updateLocal`
  overwrites it, and the host is never in `tableMismatches`. A joining PC finds its copy from it
  (`launch/find-table.ts`) and starts it (`main/one-step.ts`, the wish `want`). "A table that is already open is used
  and nothing is started", and nothing in the companion closes VPX.
- **A host can hand a match over, in the engine only.** `transferHost`, `commitTransfer`, `resumeFromLog` and
  `ClientMatch`'s side of it exist and are tested (`fakeclient/scenarios/four-player-transfer-*.json`,
  `ws-transfer.test.ts`), during a game and for a match's roster. The companion never starts one and its clients
  never take over (`hostLeftTransfer: false`), and the relay does not carry one (§3a).
- **The room on ArcAid** (`C:\code\repos\ArcAid\src\api\matchRelay.ts`, ADR 0039): it holds 8 sockets, the host's
  included; it ends 12 hours after it was made, whatever happens in it; it outlives its host's socket by 30 s;
  `match:lock` cannot be undone ("a new match is a new code") and from then on refuses a device that never had a
  seat. The companion locks when the Match tab's Start match starts the first game (`api.start` → `relay.lock()`);
  a start from the table never locks.

### 11.2 The model

Three things, one inside the other:

- **A lobby** is the room: one code, one set of connections (match control, voice, video, state stream), the list of
  members with what each has chosen (Play or Watch), and the table. It lives from Open lobby until the lobby's PC
  closes it. It has no log and no result.
- **A match** is what it is today (§8): a series of games on one table by the players it started with, one
  hash-chained log, one Throwdown, a tally of wins. A lobby holds any number of matches, one after the other. A
  match ends when somebody presses End match, when the table changes, or when somebody presses Start a new match.
- **A game** is one round of that match: every player's balls, one signed `RESULT`.

So nothing changes inside a match. What is new is that the end of a match is not the end of the connection, that
the players of a match are a choice and not "everyone who joined", and that people can come in while one is played.

```
 Open lobby / Join
        |
        v
   +---------+   Start (2+ set to Play)    +--------+   every player done    +---------------+
   |  LOBBY  | --------------------------> |  GAME  | ---------------------> | BETWEEN GAMES |
   | no match|                             |        | <--------------------- | a match is    |
   +---------+ <-------------------------- +--------+  Start: its players    | open, RESULT  |
        ^        End match for everyone                who are set to Play   | is out        |
        |        (the lobby's PC; the game             (NEXT_GAME)           +---------------+
        |         has no result)                                                    |
        +---------------------------------------------------------------------------+
          End match · the table changes · Start a new match (the new match follows at once)

 In every state: people join and leave, switch Play / Watch, talk. The lobby's PC leaving closes the lobby.
```

| State | The engine's phase | Who may do what |
|---|---|---|
| **Lobby** | `lobby` | anyone: Start, change the table, Play / Watch, leave; a newcomer joins |
| **Game** | `running` | the player who is up: End my ball; a player: give up their own game; the lobby's PC: Pass the turn, Resume, End match for everyone; anyone: Play / Watch for later, leave; a newcomer joins and watches |
| **Between games** | `ended`, the match still open | anyone: Start (Next game, or Start a new match), End match, change the table, Play / Watch, leave; a newcomer joins |

**Whose table is whose.** At any moment outside a game exactly one named person, **the starter**, can begin a game
by pressing Start on their own table; everyone else starts from the in-game menu or the Match tab. No rule lets two
tables both believe they began the match's game (§11.4 has who the starter is and why this closes the hole).

| Who | Lobby (no match open) | A start is counting down | Game | Between games (a match open) |
|---|---|---|---|---|
| **The starter** | Free. Start on the table asks for the match | Asked from their table: free, their game has begun. Asked from a button, by anyone: locked until their grant | By turn | Free. Start on the table asks for the next game |
| **A player of the open match who is not the starter** | (no match is open) | Locked | By turn: free while up, locked while waiting | Locked, as a client's table is today. An initials hold or the window in which a finished game ends on the machine (A16, A16.2) keeps the table as it does today. Starts from the menu or the Match tab |
| **Set to Play, not in the open match** (in the Lobby: everyone set to Play but the starter) | Free play. Their Start begins a game of their own, never the match's | In this start and no game of their own running: locked. In a game of their own: free, and the start waits | Locked while this PC shows the player up; free while a game of their own runs | Free play: they are not in the match |
| **Set to Watch** | Free play | Free | Locked while this PC shows the player up; free while a game of their own runs | Free play |

Free play outside a match stays for everyone who is not in it. Between games the players' tables stay as §8 has
them (the starter's free, the others' locked), with one change: the starter is a named person who can be any player,
not always the host.

**What End match and Leave mean now.**

- **End match**: the match is closed, its tally is final, and everyone is back in the lobby. Nobody leaves and no
  connection closes. Between games anyone can press it. Most evenings nobody does: a new table or Start a new match
  ends the match by itself.
- **End match for everyone** (the lobby's PC, during a game, after a confirmation: "End the match for everyone? The
  game being played gets no result."): **the game is a win for nobody and does not count in the tally.** No
  `FORFEIT` is logged and no `RESULT` is sent for it: the log stops where it is, and `MATCH_END` (never logged)
  says which game was left unfinished (`abandoned`, §11.7). The tally is that of the last `RESULT`. The panel shows
  `MATCH ENDED · GAME 3 NOT FINISHED`, the scores as they stood with no places, and the tally of the games before.
  So no logged message changes shape and nothing changes in the fold; a match whose only game was left unfinished
  has no result at all, and nothing of it is posted.
- **End my ball** (the player who is up, confirmed): their own `BALL_END` with `detectorReason: 'manual'` at their
  score as it stands, which the schema already has. It is what Pass the turn is for the lobby's PC, in the hands of
  the person it concerns: a table the companion cannot read, or a ball that is stuck, no longer needs the owner of
  the lobby's PC at their keyboard.
- **Give up this game** (a player, during a game): what Leave did to a player's own game until now, a `FORFEIT`.
  The others play on; the person stays in the lobby and watches.
- **Leave lobby**: this person is out: voice, video and state stream to them close, their table is unlocked, their
  row goes. A player who leaves during a game gives it up first. The others carry on.
- **Close lobby** (the lobby's PC's Leave, confirmed: "This closes the lobby for everyone"): a game being played is
  ended as by End match for everyone, then every PC is told (`LOBBY_CLOSED`, §11.7) and tears down as it does today
  at a match's end.

### 11.3 Play and Watch

- **Each person chooses for themselves**, on the Match tab or in the in-game menu, at any time. The choice is kept
  per PC (`match.json` `stance`, `play` by default) and said at the join. It takes effect at the next Start: a
  switch during a game changes nothing in that game (a player who wants out now presses Give up this game; a
  watcher who wants in is in from a later Start). Nobody sets it for somebody else.
- **Who plays a game** (the lobby's PC decides it at each start, §11.4):
  - with no match open: the people set to Play who are here and have the table;
  - with a match open: **the players of that match who are set to Play and here**, two or more of them. A player who
    is away or has switched to Watch sits that game out and is still in the match, as a dropped player is in a
    series today. This is `NEXT_GAME`, and the tally goes on;
  - **a person who is not in the open match comes in only when somebody presses Start a new match**: never by a
    Start on a table, never by a default. A newcomer who joined on Play while a series runs watches it until then.
- **A person without the table does not hold anyone up.** A member whose PC has no copy of the lobby's table
  (`noCopy`) counts as not set to Play for that start, as a person who is away does. Their row keeps `PLAY · NO
  TABLE`, and they watch in the 2D video.
- **A watcher's PC is a waiting player's PC whose turn never comes.** Checked in the code, piece by piece:
  - the voice: unchanged, everybody to everybody;
  - the table sound: `tableAudioPlan` mutes this PC's own table and plays the table of the player up for anyone
    whose turn it is not; a watcher is never tapped;
  - the picture: `vrViewMode` gives `spectate` (the theater, or the panel by the setting) for anyone whose turn it
    is not; on the desktop the panel window or the helper's window, as today;
  - 3D: `syncStream` sends this PC's VPX to watch the player up when the table is locked, the fork is on the control
    connection and the table identity is the same as the player's; else the 2D video, with the reason on the Match
    tab as today;
  - the log: `ClientMatch.maybeSignLog` already skips a PC that is not in `playerOrder`.
- **One thing must change for it: a PC that is not in `playerOrder` reports nothing from its table.** Today it would
  send `GAME_OVER` and `FORFEIT` for a game it is not in (§11.1). `onReady` and `onNextGame` set `myGameOver` for a
  PC whose id is not in the order (what `restore()` does already), and `leave()` forfeits nothing for it. The test
  is named in step 7 (§11.12): "a watcher's table game ends, and its table closes, during a match: nothing is sent,
  nothing is on its panel".
- **A watcher's table is locked while a game is played** (from `MATCH_READY` or `NEXT_GAME` to the game's `RESULT`),
  and its own again between games and in the lobby. This overturns "never a lock" (§11.13): the 3D watch is built
  on the lock (`syncStream` sends the fork to watch only while `locked`; state-stream-in-match.md §4.3), and in the
  2D theater a key pressed in the headset still reaches the table underneath, so a watcher's Start key would begin
  a game nobody sees or hears.
- **Never in the middle of a game of one's own** (A14's rule, §9.3). A watcher who is playing alone when a game of
  the match starts keeps their table, their view and their sound until their own game ends; then the lock goes on
  and the player up is shown. The roster says `OWN GAME` for them meanwhile.
- **A person who joins while a ball is in play** gets the voice at once, with everyone. The `video` and `stream`
  connections between their PC and the PC of the player who is up are opened when that ball ends, so nothing is
  set up on the PC of a person who is playing (an encoder in their video helper, a tunnel beside their VPX). With
  everyone else they open at once. Until then the newcomer's panel reads `KROBS IS UP` with the scores, and "You
  see the table from the next ball".
- **The roster** (Match tab and the full panel) lists every member, the lobby's PC like any other: name, rig,
  `PLAY` or `WATCH`, and what is wrong if anything (`LOADING`, `NO TABLE`, `OTHER TABLE`, `OWN GAME`, `AWAY`, the
  table-file advisories of today). **The score strip and the scoreboard** (`scoreboard-page.ts`) list the players
  of the match in turn order, as today, and are the same for a watcher; under the strip the full panel has one
  line, `Watching: Chuck, Dana`. The tally is the open match's.

### 11.4 Starting a match, by anyone

Start is one request with one set of checks, whoever makes it. The lobby's PC makes it to itself; any other PC sends
`START_REQUEST` (§11.7) and the lobby's PC answers by announcing the start, by announcing a start that waits, or
with a sentence.

**The starter.** One person, named in `HELLO_ACK.starter` and on every panel:

- with no match open: the first person in the lobby's list (the opener, then in the order people joined) who is set
  to Play, is here and has the table;
- between games: the player who went first in the game just played, while they are here and set to Play; else the
  next in that game's order;
- a person who starts from the menu or the Match tab goes first in the game that follows, and is the starter after
  it.

**Three ways to ask**, and who has which:

- the Match tab's button (**Start match**, **Next game**, **Start a new match**, §11.9): every member;
- the in-game menu's first line, the same words (`match-menu.ts`: today only the host has it): every member;
- **a game started on the table** (A11's first-game rule): the starter only. Their `game_start` in the lobby or
  between games asks `fromTable`, and they go first because their game has begun (today "the host first" for the
  same reason). Anybody else's `game_start` is never a request: where their table is free it is a game of their
  own, where it is locked the key does nothing.

**Every start counts down 5 s**, from a table or from a button (today a button starts at once). The countdown is
what closes the hole of two tables: when it is announced, the PC of every person in the start locks its table at
once, unless a game is running on it (the starter's own `fromTable` game, or somebody's game of their own, which
that PC then says, `ownGame`). When it runs out the lobby's PC runs the checks again, and only then sends
`MATCH_READY` or `NEXT_GAME`. If a check fails then, the start becomes one that waits and the locks of the
countdown come off. While a start counts down or waits:

- the starter's `game_start` arriving after somebody else's button press puts the starter first (theirs is the one
  table that can have begun a game; it can only arrive in the moment before the countdown's lock reached their PC);
- a second press of Start during the countdown changes nothing, and anybody can press **Cancel the start**
  (`START_CANCEL`): the locks come off, and a game the starter began on their table is then a game of their own
  (A12's rule: the next Start after it ends asks again);
- a person in the start who switches to Watch is taken out of it; with fewer than two left it is cancelled, and the
  panel says who ("Krobs set himself to Watch: the start is off"). A switch to Play counts from the next start;
- a table pick is refused: "A match is starting: cancel the start to change the table."

**The checks**, in this order, on the lobby's PC, at the request and again when the countdown runs out
(`HostMatch.requestStart`, new; today's rules are the controller's `tryStartFromTable` and `api.start` in
`match-host.ts`, and they move with it):

| Check | When it fails |
|---|---|
| No game is being played | Refused: "A game is being played." |
| No start is under way | Nothing happens: the asker sees the start that is already announced |
| The last game's `RESULT` is out (`nextGameBlocker`: up to 10 s after the last ball) | The start **waits** for it. Today such a start is silently ignored |
| Two or more people play it (§11.3: set to Play, here, with the table; with a match open, its players only) | Refused: "Only MekelburgJ is set to Play: a match needs two." With a match open and somebody outside it set to Play: "Only MekelburgJ of this match is set to Play. Press Start a new match to play with Dana." |
| Each of their tables is open | The start **waits** (A11's armed start): "The match starts once Krobs' table is open." |
| Each of their open tables is the lobby's table, not another game (`OTHER TABLE`) | The start **waits**: "The match starts once Krobs has Monster Bash open (he has Congo open)." |
| None of them is in a game of their own (other than the starter's `fromTable` game) | The start **waits** (A12, for everyone): "The match starts once Krobs' game on his table has ended." |
| Each of their tables can report ball ends (A13) | Refused unless the asker confirmed (`anyway`): the sentence of today, and Start anyway. The player concerned ends each of their balls with End my ball |
| Their 3D connections are settled (I11.4.9) | The start **waits**, 45 s at most from the first held start, as today |

- **A start that waits belongs to the person who asked.** It is announced to everyone with their name, who it is
  for and what it waits for (`HELLO_ACK.start`, §11.7; today a client is told nothing of a held start). It is
  dropped when that person leaves, switches to Watch or cancels, when (for a start from the table) their game ends,
  and when fewer than two are left to play it. When what it waits for is over, the countdown begins.
- **A second press of Start by anyone, while a start waits, starts without what is waited for** (`now`): without the
  3D connections (as today), and without the people whose table is not ready (loading, another game, a game of
  their own), if two are left. The button then reads **Start without Krobs**. One person who has gone to bed with
  a table half loaded cannot hold three others.
- **The 3D wait counts players only.** The owner's ruling was that the first turn is in 3D for the people playing.
  A watcher whose connection is late gets the 2D video and switches to 3D in the middle of the turn, which the code
  already does. The wait applies to every start in a lobby, not only the first: after a table change every VPX is
  new (`FORK_HELLO_WAIT_MS` runs again); with nothing still being made it holds nothing.
- **Next game or new match** is the asker's choice, never a side effect. With a match open, a start from the table
  and **Next game** are `NEXT_GAME` with the match's players who are set to Play and here (§11.3). **Start a new
  match** (`START_REQUEST.newMatch`, a button and a menu line of its own, shown when somebody outside the open
  match is set to Play) ends the open match (`MATCH_END`) and starts one with everyone set to Play. With no match
  open every start is a new match. The order: the asker first, then the others as in the last game, or, in a new
  match, in the order they joined the lobby.
- **Who confirmed.** A start with a table that cannot report ball ends is confirmed by the person who asked
  (`START_REQUEST.anyway`), a client included, because the player concerned can end their own balls (End my
  ball); the lobby's PC logs who confirmed. Pass the turn stays with the lobby's PC as well.
- **The initials hold and the window of a finished game** (A16, A16.2) are left as they are: a start does not wait
  for them, as today, and the table they keep unlocked stays so until they end. A `game_start` out of one is a
  request only when it is the starter's.
- **`preMatchPlay`** (A12's "Table locked until someone joins") is retired in a lobby: outside a match every table
  is its owner's by the table above. The key stays in `match.json` and is not read; its line on the Match tab goes
  with step 9.

### 11.5 Changing the table

- **Anyone picks**, in the lobby or between games, on the Match tab: the picker of §9.1 (`TablePicker`: the
  imported tables, Browse…). Not during a game ("A game is being played: the table changes after it"), and not
  while a start counts down or waits (§11.4). Not from the headset in the first version: a picker needs a list
  (§11.13).
- **The lobby has a table, and it is a pick, not somebody's open VPX.** `HELLO_ACK.hostGame` carries it, with
  `tablePickedBy`. **The lobby's PC becomes a member row like any other**: its own fingerprint (kept beside the
  pick; `updateLocal` stops overwriting `hostGame`), its own `LOADING` while its table is not open, its own entry
  in `tableMismatches`. A lobby opened with "No table: I open it myself" takes the first table its opener opens as
  the pick, which is today's behaviour. Opening a table by hand on any other PC is never a pick: that person's row
  says `OTHER TABLE`.
- **What a pick is made of: the lobby's table identity.** Of `GameFingerprint`: `kind`, `tableName`, `tableHash`
  (the SHA-256 of the `.vpx`; a file never hashed is hashed first, `launch/table-hash.ts`) and `romName`, which the
  picker's PC knows before the table is open (`KnownTable`); and beside them the Castcade VPX build's own table
  identity (the fork's `<editables> <table hash>`) once I11.4.15, on another branch now, adds it to what is
  announced. The other keys (`romHash`, `physicsHash`, `recipeVersion`, `sidecarHash`, `emulatorVersion`) are facts
  of one PC's copy and are null or empty in a pick. So a member's row is compared with the pick on the identity
  keys only (`compareFingerprints` compares every key today, and would flag everyone against a pick): the same
  file; the same game in another file (today's advisory); another game (`OTHER TABLE`). The muted build note of
  today (`emulatorVersion`) is a comparison between the players of a start. `MATCH_READY.game` is the full
  fingerprint of the open table of the first player in the order, never a pick.
- **The announcement** is the next `HELLO_ACK` (it goes to every member on every change). An open match ends at
  that moment (`MATCH_END`, "the table changed"): a tally is for one table.
- **What each PC does** when the lobby's table changes to another game (`one-step.ts`: the wish `want` learns that a
  table can be open and wrong). At the join nothing changes: a table that is already open is kept, as today (§9.3),
  and the row says how it differs.
  1. Find its copy by the rules of `launch/find-table.ts` as they are then (the identical file, then the same game;
     an imported table before a file only found in the folder; I11.4.15's identity when it is in). The pick is only
     ever compared with what is on this disk: never a path, as today.
  2. No copy: nothing is closed. This PC says so (`PARTICIPANT_UPDATE.noCopy`), its row reads `NO TABLE`, its Match
     tab "Krobs picked Monster Bash. Castcade found no copy of it on this PC: you can watch, or pick another
     table." The person stays in the lobby with the voice, and watches in the 2D video.
  3. **Nothing is closed that might be a game.** A game is running on the open table, or an initials hold or the
     window of a finished game (A16, A16.2) is on: wait for its end (the row: `OWN GAME`). And a table Castcade
     cannot follow (the witness in `basic` mode, no hook journal: `ballEndsFrom`) is never closed by Castcade,
     because it cannot know whether a game is on: this PC is asked, as in rung 3 below.
  4. Otherwise close the open table, then start the copy the way a match table is started today (`launchTable`: in
     the Castcade VPX build when it is there and `watch3d` is `auto`). The row reads `LOADING` until the witness
     sees the new table.
- **Closing VPX is new**, and it must be a clean exit: a ROM table writes its NVRAM when the game stops, so a killed
  process can lose a high score. Three rungs (`launch/vpx-close.ts`, new):
  1. the fork: a line `quit` on the control connection (state-stream-in-match.md §3; an older fork ignores an
     unknown line, rule 13, and falls to the next rung);
  2. any other VPX: its player window is asked to close (`WM_CLOSE` to the window of the witness's VPX pid, by the
     PowerShell route `media/window-geometry.ts` already uses), which is what Alt+F4 does;
  3. still open 15 s later, or a table Castcade cannot follow: this PC's Match tab and row say "Close the table on
     this PC: Castcade opens Monster Bash when it is closed", and the wish waits for the witness's `table_exit`.
     Never a forced end of the process.
  A setting, "Change tables for me" (`match.json`, on by default; ADR 0007: automate it): off, the tab shows the
  pick with an **Open it** button and nothing closes by itself.
- **What the lobby shows meanwhile**: the header `CHANGING TABLE · MONSTER BASH`, each row its state, and Start
  refused or waiting by the checks of §11.4. Nothing blocks the lobby: people talk through it.
- **VPX closing and opening, and the rest.**
  - The voice lives in Castcade (the panel page), not in VPX: it is untouched. So is the microphone choice.
  - The table sound helper mutes and taps by pid and nothing is muted outside a game: the new pid is read at the
    next game, as at any table start today.
  - The OpenXR layer lives inside VPX: the headset's panel and scoreboard go with the table and come back when the
    new VPX's layer connects to the pipe (`vr-layer.ts` logs "the layer closed the pipe … trying again"). In
    between, the headset shows what its runtime shows with no application (on the owner's rig Virtual Desktop's own
    room); the person hears the others and a cue. On SteamVR the overlay helper is its own process and stays.
  - The picture source (the layer camera's ring, or the window capture) is found again as at any table start;
    nobody is up, so nothing is being sent.
  - The 3D: the new VPX says `hello` with the new table's identity on the control connection, which lives for the
    app's run (`stream3d-host.ts`), and what this PC can do is announced again to the PCs already connected
    (`Stream3d.publish` in `match/stream3d.ts` tells the tunnel whenever it changed).

### 11.6 Media across matches

**Kept from the moment two people are in the lobby together until one of them leaves it**, one of each per pair of
PCs. Nothing is opened or closed at a match's start or end, at a game's, or at a table change:

| Connection (`MEDIA_SIGNAL.channel`) | Carries | Today |
|---|---|---|
| `rtc`, the panel page | every microphone to everyone, always; the table sound of the player up; the Electron video while that path is in use | opened at `MATCH_READY`, closed at `teardown`; made again at every `addPeer`; closed for a person whose link drops |
| `video`, `castcade-video.exe` | the picture of the player up, one encoder per receiving PC, sending only while up | opened in the lobby, closed at `teardown` |
| `stream`, the tunnel | the state stream from the VPX of the player up to each PC that watches in 3D; what each PC's VPX can do | opened in the lobby, closed at `teardown` |

One exception to "from the moment": the `video` and `stream` connections between a newcomer and a person who is on
a ball wait for that ball's end (§11.3). Match control (the WebSocket listener or the ArcAid room) is kept the
same way as the three.

**Per turn**, as today and nothing more: who sends the picture and the table sound (`setSending`, the helper's
`mesh.setSending`, the tap), whose table is muted, which VPX watches which (`watch` / `play`), the headset's mode,
the lock. **Per match: nothing.**

**Four in the lobby, two playing** (A is the lobby's PC and watches, B and C play, D watches). Six pairs, three
connections each. While B is up:

```
 B  --microphone-->            A, C, D        (and each of them to the other three: the voice is a full mesh)
 B  --table sound-->           A, C, D        (the table track of the rtc connection)
 B  --picture-->               A, C, D        (three encoders in B's video helper)
 B's VPX --state stream-->     each of A, C, D whose VPX has the build and the identical table (83 to 145 KB/s each, I11.2)
 A, C, D: own table muted and locked; never send a picture or a table sound while B is up
 Match control: B, C, D <-> A only (a star; through ArcAid or A's listener)
```

That is the load of a four-player match today, with two of the four never taking a turn: the reason four is the
size of the first version. The 2D picture keeps flowing to a PC that watches in 3D, as today (the fallback is
instant); not encoding for it is A17.1's first saving.

**What must change.**

- **Adding a peer that is already held makes no new connection.** `rtc-host.ts` `addPeer` does nothing for a peer
  the page holds (the mesh's own `add` keeps its meaning: `reopen` and the `reset` signal use it). With that, voice
  peers follow the lobby's members (`MatchController.onLobby`), and the calls in `onReady`, `onPeerBack` and
  `restore` are harmless. Without it "the voice from the join on" would rebuild every voice connection at
  `MATCH_READY` and at every reconnect, which is the fault this item exists to remove.
- **A pause for the player who is up does not take their picture away** (the lead's ruling). While the match is
  paused for the disconnect of the person who holds the grant, or while the lobby's PC is away during a ball
  (§11.8a), and that person's picture still arrives, everyone else keeps what they were looking at: the theater or
  the 3D watch. Who is away is said without a full panel: the scoreboard's title (`KROBS AWAY · GAME 2 · BALL 1 OF
  3`, as `PAUSED ·` is said to the player up today, D8.14) and the desktop panel's line. Three changes, in step 4
  (§11.12), which needs no lobby:
  - `vrViewMode`: a new fact `now.upAway` ("paused for the player up, their picture arrives") gives `spectate` as
    in `playing`, where today any phase but `playing` gives the panel;
  - `syncStream`: `waiting` holds in that state too, where today it needs `p.phase === 'playing'`; and a grant
    issued again for the same player and ball after the `RESUME` does not start a running watch over (the turn key
    today is the `grantSeq`, which a re-issue changes);
  - "their picture arrives" is read where it is already read: the theater-path watch's `recv` (`syncNativeVideo`),
    the Electron page's `receivingVideo`, and for 3D the fork's own rule (no frame for 3 s ends the watch,
    state-stream-in-match.md §3 rule 12). When it stops arriving the panel comes, as today.
  `PanelState` gains who the pause is for.
- `MatchController`: a match's end returns the controller to the lobby (scores, result and holds cleared; the
  series kept on the panel until the next start) instead of ending it; `close()` and its `media.detach()` are for
  leaving the lobby only.
- `match-host.ts`: `Active` is the lobby's life, and `teardown` is split. **What ends with a match:** the saved
  match (`dropRecord`), `Session.onCommit` and the record's heartbeat (until step 8 makes the record the lobby's),
  the `TableBacklog` and the journal mark,
  the per-game state of the controller, the lock, the table sound put back (`tableAudio.apply`, `unlevel`), the end
  timer. **What ends with the lobby:** the media (`controller.close()`), the video mesh, the stream tunnels, the
  overlay, the in-game menu and its global keys (`unregisterKeys`, `closeMenu`), the lobby peek timer, the
  transport, the ArcAid room, the router port. A client's `scheduleSeriesEnd` goes: `MATCH_END` is no reason to
  close anything. `syncNativeVideo` and `syncStream` take the members, not the match's participants.
- A link that drops closes no media connection (A18 does this for today's match; step 1 starts from A18 as it is
  merged and does not do it again): the peers stay while the person is `away`, and ICE decides by itself whether
  the path between the two PCs is still good. Media between two PCs never crossed the lobby's PC or ArcAid, so a
  control drop is no evidence about it.
- `relay.lock()` is not called in a lobby (§11.10).

### 11.7 The wire: protocol 7

**The rule that keeps it small: Watch is a fact of the lobby, never of a match.** A match's log holds its players and
nothing else, exactly as a protocol 6 log does: `MATCH_READY.participants` and `playerOrder` are the players,
`RESULT.entries` the players, `LOG_SIGN` from the players. Members who watch receive the same broadcast stream and
keep the same log, and appear in none of it. So no logged message changes shape, the fold (`state.ts`) is
untouched, and what ArcAid will ingest (A5, F6) is what it would have ingested before the lobby.

**Logged, unchanged in shape; what is different in use:**

- `MATCH_READY.matchId` is `<lobby code>-<n>` (`JHDFEF-2`), `n` counting the lobby's matches from 1: each match is
  its own Throwdown. Grants, `RESULT` and the signatures carry that id. `hostPlayerId` is the lobby's PC, which need
  not be in `playerOrder`. `game` is the first player's full fingerprint (§11.5).
- `NEXT_GAME.playerOrder`: the match's players who are set to Play and here, the asker first (today: the roster
  still connected, "the host first").
- `BALL_END` with `detectorReason: 'manual'` from the grant holder is End my ball. The value is in the schema; no
  companion sends it today.
- **Where one match's log ends and the next begins.** A match's log ends, as today, at the entry that ends its last
  game; `MATCH_END` is not logged. A game ended for everyone leaves the log where it stood, in the middle of that
  game, unsigned for it. The next match's log starts from nothing: index 0, `prevHash` 64 zeros, its own
  `MATCH_READY`, `grantSeq` from 1. Nothing chains one match to the next. `seq` (the envelope's) is per sender for
  the whole lobby and never starts over.
- **Never logged:** who is in the lobby, who watches, who is away, who asked for a start, the starter, the table
  picks, joins and leaves of members who are not playing.

**Not logged, new or changed** (in the style of `protocol/src/messages.ts`):

```ts
// A17: what a member wants at the next start. An enum, so a third choice later is a value, not a field.
export const Stance = z.enum(['play', 'watch']);

// HELLO: one more optional key.
stance: Stance.optional().describe('A17: Play or Watch at the next start. Absent: play.'),

// PARTICIPANT_UPDATE: three more optional keys, valid in every phase.
stance: Stance.optional().describe("A17: the sender's choice now."),
noCopy: z.boolean().optional().describe("A17: true: the sender's PC has no copy of the lobby's table (`HELLO_ACK.hostGame`); false: it has."),
ownGame: z.boolean().optional().describe("A17: a game the match does not own is running on the sender's table (played alone, in the lobby or as a watcher)."),

// HELLO_ACK: the lobby as it is now. In a lobby it is sent to every member on every change IN EVERY PHASE, not only
// before the first game. All defaulted, none logged. `hostGame` is the lobby's PICKED table (its identity keys; the
// others null or empty, §11.5); the host is listed in `loading` and `tableMismatches` like any member.
stances: z.array(z.object({ playerId: PlayerId, stance: Stance })).default([]),
away: z.array(PlayerId).default([]).describe('Members whose link is down and whose place is kept (§11.8).'),
noCopy: z.array(PlayerId).default([]),
ownGame: z.array(PlayerId).default([]),
otherTable: z.array(PlayerId).default([]).describe('Members whose open table is another game than the pick.'),
tablePickedBy: PlayerId.nullable().default(null),
ballsPerGame: z.number().int().min(1).max(10).nullable().default(null),
starter: PlayerId.nullable().default(null).describe('A17: the one member whose Start on their own table asks for a game (§11.4).'),
match: z
  .object({ matchId: MatchId, players: z.array(PlayerId).min(2).max(4), game: GameNumber, state: z.enum(['game', 'between']) })
  .nullable()
  .default(null)
  .describe('The match that is open; null in the lobby. Its log follows in MATCH_LOG for a member who has none.'),
start: z
  .object({
    by: PlayerId,
    players: z.array(PlayerId).min(2).max(4).describe('Who plays it, the first to go first.'),
    newMatch: z.boolean(),
    waitsFor: z.enum(['result', 'tables', 'other_tables', 'own_games', '3d']).nullable().describe('null: it is counting down (`startsInMs`).'),
    waitsOn: z.array(PlayerId).default([]),
    leftMs: z.number().int().min(0).max(120_000).nullable(),
  })
  .nullable()
  .default(null)
  .describe('A17: the start that is announced: counting down or waiting (§11.4). Each PC in `players` locks its table when it counts down, unless a game runs on it.'),

// New: a member asks the host to start. client -> host. The host announces the start (HELLO_ACK `start`), or
// answers REJECT (`unexpected_state`) whose `message` is the sentence the asker is shown.
export const StartRequest = z.object({
  fromTable: z.boolean().describe("True: the sender's own game began on its table (A11). Taken from the starter only."),
  newMatch: z.boolean().default(false).describe('True: end the open match and start one with everyone set to Play (the explicit press, never set with `fromTable`).'),
  anyway: z.boolean().default(false).describe('A13: the sender confirmed a start with a table that cannot report ball ends.'),
  now: z.boolean().default(false).describe('Do not wait: start without the 3D connections and without the people whose table is not ready (a second press).'),
});

// New: client -> host, each answered by the change it asks for (HELLO_ACK, MATCH_END) or by REJECT.
export const StartCancel = z.object({});                       // take back the start that counts down or waits
export const EndRequest = z.object({});                        // end the open match, between games
export const TablePick = z.object({ game: GameFingerprint });  // the identity keys of §11.5

// New: the host closes the lobby. host -> all. Every member tears down; nobody reconnects afterwards.
export const LobbyClosed = z.object({ reason: z.string().max(200) });

// New: the open match's log, to a member who does not hold it. host -> client, in pages of at most 100 entries
// (about 50 KB), so that no frame comes near the relay's 256 KB.
export const MatchLogPage = z.object({
  match: MatchId,
  restart: z.boolean().describe('True on the first page of a whole log: the receiver starts an empty log for `match`.'),
  entries: z.array(LogEntry).max(100),
  logHash: Sha256Hex.describe("The host's head after the last page."),
  logLength: z.number().int().min(0),
  more: z.boolean().describe('Another page follows at once. False: the receiver is current.'),
});

// MATCH_END: in a lobby it means "this match is over, back to the lobby". Never logged, so it may change.
games: z.number().int().min(0).max(999).describe('Games of the match that have a RESULT.'),  // was GameNumber (min 1)
abandoned: GameNumber.nullable().default(null).describe('A17: the game that was being played and was ended for everyone: no RESULT, a win for nobody.'),

// RECONNECT: the envelope's matchId is ALWAYS the lobby code. Two more keys, and a new signed body.
match: MatchId.nullable().default(null).describe('The match the sender holds a log of; null: none.'),
// signature: over canonicalJson({ lobby, player, match, logHash, logLength, seq }), seq being the envelope's own.

// RECONNECT_ACK: three more keys, and one more code.
match: MatchId.nullable().default(null).describe('The match that is open now; null: none.'),
restart: z.boolean().default(false).describe("True: the sender's log is not of the open match (or none is open): drop it. The open match's log follows in MATCH_LOG."),
more: z.boolean().default(false).describe('`entries` holds at most 100; the rest follows in MATCH_LOG.'),
// `code` gains 'protocol_version' (the sender speaks another version; see the refusals below).
```

`MESSAGE_DIRECTION`: `START_REQUEST`, `START_CANCEL`, `END_REQUEST` and `TABLE_PICK` are `client->host`;
`MATCH_LOG` is `host->client` and `LOBBY_CLOSED` `host->all`. The lobby's PC does the first four to itself
through the engine, with no message. `HELLO.throwdownCode` is the lobby's code (the name is from before the lobby).

**Rules that change** (`protocol/docs/prose.md` gets a section "The lobby"):

- **`HELLO` is accepted in every phase while there is room.** `REFUSE` `match_started` is not sent in a lobby;
  `match_full` reads "This lobby is full (four people)."
- **A member who joins while a match is open is given its log unasked.** In the same turn in which it accepts the
  `HELLO` the host sends `HELLO_ACK` and then the whole log in `MATCH_LOG` pages, and **the host sends the logged
  stream only to members whose log it has sent in full** (today `send('all')` reaches any socket that has said
  `HELLO`). A client commits a logged frame only into a log it holds in full for that match. Without this a
  `BALL_END` that falls between the `HELLO_ACK` and the log goes into the newcomer's empty log at index 0
  (`ClientMatch.handle` commits it unconditionally) and the log that follows does not fit on it.
- **`RECONNECT` is how a member comes back in every phase**, the lobby included (today `match_not_started`). It is
  checked against the member's key as the lobby holds it, not against a match's roster (a watcher is in none). One
  form for every case: the envelope's `matchId` and the signed body carry the lobby code, and the match the member
  holds a log of goes in `match`. The host answers: the same match is open and the head is known → the entries
  after it, as today, in pages; another match is open, or none → `restart`, and the open match's log in `MATCH_LOG`.
  A member whose place is gone (`unknown_player`) falls back to a fresh `HELLO`, which a lobby takes while there is
  room.
- **A `RECONNECT` cannot be used twice.** Its signature covers the envelope's `seq`, and the host takes it only when
  that `seq` is above the last it took from that member (`Session.checkSeq`, which runs on every frame already;
  today the signature does not cover `seq`, so a captured `RECONNECT` can be sent again in a new envelope, and in a
  lobby with no log its body would be the same all evening). A counter, not a nonce: a nonce needs an exchange
  before the first frame on a new link. A lobby's PC that restarted has lost the counters; it keeps the last one
  per member in its saved lobby (written with the 15 s heartbeat), so the window in which an old one would still
  pass is that long, once.
- `PARTICIPANT_UPDATE` counts in every phase for `rig`, `game`, `ballEndReady`, `stance`, `noCopy`, `ownGame` and
  `midnightMode`. A match's logged roster and fingerprint stay what its `MATCH_READY` said.
- `MEDIA_SIGNAL`, `STATE` and `DMD_FRAME` go to every member, not to a match's roster (`isParticipant`, `mirror` in
  `host.ts`).
- **The envelope's `matchId`**: the lobby code on lobby messages (`RECONNECT`, `START_REQUEST`, `START_CANCEL`,
  `END_REQUEST`, `TABLE_PICK`, `PARTICIPANT_UPDATE`, `MEDIA_SIGNAL`), the open match's id on match messages. A
  match frame with the id of a match that is over is dropped by whoever receives it. **Two checks a client does
  not make today**, both in step 6 (§11.12): `ClientMatch.handle` reads no envelope `matchId` at all; and with
  `grantSeq` starting at 1 in every match, `lastGrantSeqSeen` (its only guard against an old grant) is reset per
  match, so a grant is also checked against `grant.matchId`, which is signed.
- A drop of a member who is not holding the grant sends nothing and logs nothing (§11.8).
- **No host transfer in a lobby** in the first version: with the lobby on, `transferHost` refuses and a client
  never proposes itself. The engine's transfer code and its tests are not touched; they are the base of the
  hand-over (§11.8a).

**Why 7, and when.** Each new key alone would have stayed 6 by the precedent of `ballEndReady`. Together they change
what a peer must do: a 0.2.50 client closes the connection 20 s after `MATCH_END`, never asks for a start, never
says whether it plays, and would take a `HELLO_ACK` in the middle of a game for nothing; a 0.2.50 host refuses a
join after the first game and drops the new messages. A lobby of mixed builds half works, which is worse than a
refusal. **The version changes in the step in which the shell turns the lobby on (step 7), not when the schemas
land:** until then the engine's lobby behaviour sits behind an option that is off (`HostOptions.lobby`,
`ClientOptions.lobby`), no new message is sent, and the new keys of `HELLO_ACK` go out at their defaults, which a
0.2.50 peer strips. Every build before step 7 plays with 0.2.50, so a fix can still be released on protocol 6.

**How a PC on another version is refused, in a plain sentence.** Today it is not: `foreignVersionRefusal`
(`transport-ws.ts`, shared by the relay transport) answers a `HELLO` of another version with a `REFUSE` built in the
host's own version, and the envelope's `v` is a literal, so the older client cannot decode the answer and reports a
host that did not answer; and it reads `HELLO` only, so a `RECONNECT` of another version gets nothing at all and its
sender waits out the whole host wait. Three changes, harmless on protocol 6 and so in step 1:

- the `REFUSE` is written in the asker's version (its `v`; the shape of `REFUSE` is the same in 6 and 7), with the
  message "This lobby needs Castcade 0.2.51 or newer. Update Castcade on this PC (Settings, Check for updates) and
  join again." (0.2.51 stands for whichever release first carries protocol 7.) A 0.2.50 client shows it as "The
  host refused: …" (`match-host.ts` `joinMatch`). Not tried.
- a `RECONNECT` of another version is answered in the asker's version with a `RECONNECT_ACK` that does not accept
  it. A 0.2.50 client knows no code that says why (`unknown_player` is the nearest it has; from protocol 7 the
  code is `protocol_version`), so what it shows is "The host did not take this PC back into the match", at once
  and not after three minutes. This is the case of the evening the update arrives: a lobby's PC that restarted into
  the new version, and a client still on the old one coming back.
- the new client, when a frame during a join or a rejoin does not decode and its JSON carries another `v`, says "The
  lobby's PC runs another version of Castcade (protocol 6; this PC has 7). Both need the same: update, then join
  again." instead of the timeout.

### 11.8 Drops and rejoins

Ruling 8 as a rule of the engine: **a link that drops changes the game only for the person whose link it is, and
only when the game needs that person.** A18, being built on another branch now, does three things for today's
match: a disconnect of a player who is not up changes nothing for the player who is up, a relay drop has a few
seconds' grace before it counts, and no media is made again. This design starts from A18 as it is merged and adds
what a lobby needs on top:

- **Away.** A member whose link drops (past A18's grace) is `away`: the row says so, the place is kept, and nothing
  is sent to the log.
- **Two clocks, and only two.**
  - **The place**, for a member the game does not need (a watcher; anyone in the lobby or between games): 3 minutes
    away, and the row goes. A later return is a new join: the `RECONNECT` is answered `unknown_player` and the PC
    falls back to `HELLO`, which a lobby takes while there is room ("Rejoin the lobby" is offered for 20 minutes
    after a restart and works either way).
  - **The turn**, for a player: it runs **only from the pause at that player's own turn**, never during another
    player's ball, and nothing is logged about a waiting player during another player's ball. 3 minutes after that
    pause the lobby's PC forfeits them (`disconnected` in the `RESULT`) and the game goes on; its owner can do it
    sooner (**Play on without Krobs**). A player who is waited for keeps their place for as long.
- **Both clocks stop while the lobby's PC is itself cut off from ArcAid** (`relay.onState` `reconnecting`), and
  start again from zero when the room is registered again: everyone who came through ArcAid is away at once then,
  none of them is at fault, and a client's next ask for the room can be minutes away (§11.8a).
- **Whose drop is it.** When the lobby's PC loses ArcAid, nobody is paused for it: it is the lobby's PC that is
  away, for everyone (the row below, and §11.8a). A pause for a player is raised only for a link that is down while
  the lobby's PC's own connection to ArcAid is up, or for a direct link.

| Who drops | In the lobby, or between games | During a game |
|---|---|---|
| **A watcher** | `AWAY`. Back by itself (`RECONNECT`). The place goes after 3 minutes | The same. No player sees anything but the row |
| **A player who is waiting** | As a watcher. While away they do not play a game that starts (§11.3) | Nothing is logged and nothing pauses: the player up plays on with the same picture, sound and scoreboard. If the turn reaches them while they are away: `PAUSE(disconnect)`, "Waiting for Krobs to come back (2:41)", counted from that pause. Back: their own `RESUME` (`resumeAfterMyDrop`), then the grant. Not back after the 3 minutes, or Play on without Krobs: forfeited, and the game goes on |
| **The player who is up** | (nobody is up) | Their table stays theirs and nothing comes over it (the lock never goes on in a ball; D8.14). `PAUSE(disconnect)` for them, the pause at their own turn. The others keep the picture while it arrives (§11.6), and the scoreboard says `KROBS AWAY`. Back: `RESUME`, and a ball that ended meanwhile is reported once (§10.4, `TableBacklog`). After 3 minutes: **if their picture or state stream still reaches the lobby's PC they are playing, and nothing is done by itself**; the lobby PC's owner is asked: "Krobs has been out of the lobby's reach for 3 minutes and is still playing. **Keep waiting** · **End Krobs' ball** (Pass the turn) · **Play on without Krobs**". If nothing of theirs arrives any more: forfeited, as a waiting player is |
| **The lobby's PC** | §11.8a | §11.8a |
| **ArcAid for a moment** (A18: four times in one night), which is the lobby's PC losing it | Inside A18's grace nothing is shown. Past it: every other member sees the lobby's PC away; both clocks stand still | The ball in play goes on. No pause is raised for anyone. If the ball ends before ArcAid is back, the game waits there (§11.8a) |

**A restart of Castcade (A14.5, §10) in a lobby.**

- `match-resume.json` becomes **version 2** and is written from the moment a lobby is opened or joined (today
  `saveResume` returns in the lobby): the code or invite, this person's id, name and choice, the other names, and
  the open match's log when there is one. The lobby's PC also saves what only it knows: the members with their keys
  and choices, the table, the starter, the number of the next match, the balls per game, the last `seq` it took
  from each member. (§10.5: "A host's lobby is not saved" stops being true.) A version 1 record is dropped: it is
  of another protocol.
- `rejoin()` today throws a record away when this PC is not in the saved log's roster ("it was not played with this
  PC's match keys"). That would catch every watcher and a lobby's PC that only watches: the check becomes "this PC's
  key is the one the record was saved with", and `resumeFromLog` stops insisting that the host is in the roster.
- At start, as today: in the lobby under 75 s ago, or restarted for an update → back without asking; else the Match
  tab offers "You were in a lobby with Krobs and ChuckRibbits. **Rejoin the lobby** / **Forget it**" (the lobby's
  PC: **Open it again**). The bound is 20 minutes for both (§11.8a).
- A client comes back with `RECONNECT` from its saved head. The match it was in still open: the entries since, as
  today. Another match or none: `restart`, and it is in the lobby as it is now. Its place gone: `HELLO`. Its choice
  is the one the lobby's PC holds for it. A player's table events from the time Castcade was closed are handled as
  in §10.4.
- The lobby's PC opens the same code again (§10.3), with every member away until they return; an open match is
  taken up from its log.
- Voice, video and state stream are made again for the PC that restarted (its processes are gone), and only for it.

### 11.8a The one PC a match depends on

**In the first version the lobby's PC is the one PC whose loss stops a match, and this is accepted, not solved.**
Every other PC can drop, restart or leave without the player who is up noticing. When the lobby's PC goes (its
Castcade closes, its network or its connection to ArcAid drops), also when its owner was only watching:

- **The ball in play finishes undisturbed.** The table of the player who is up stays theirs, nothing comes over it,
  the picture and the sound keep reaching everyone (they never crossed that PC), and everyone keeps talking. The
  scores on the scoreboard stop moving, because `STATE` goes through the lobby's PC; its title says `LOBBY PC AWAY`.
- **Then the match waits.** When the ball ends, the player's own companion locks their table (new: it knows the ball
  is over; today the lock waits for the host's echo of the `BALL_END`) and keeps the ball end to report, as
  `TableBacklog` does for a dropped link (§10.4); nobody can be granted the next turn. Every panel says: "MekelburgJ's PC
  is away. The match goes on when it is back: waiting up to 20 minutes (18:12 left). You can keep talking; Leave
  lobby ends the wait for you."
- **For 20 minutes**, the time a client's saved match is good for today (`CLIENT_RESUME_MAX_MS`, the protocol's own
  limit for one ball), where today a client waits 3 minutes and, through ArcAid, about 2 (§10.5). The room on ArcAid
  dies 30 s after its host's socket, but the returning PC registers the same code again (§3a), so the limit is only
  how often a waiting PC may ask for a room that is not there: ArcAid holds a device back at eight misses in ten
  minutes. A waiting PC asks at once, after 2 s, after 6 s, and then every 150 s (six asks in the first ten minutes,
  four in every ten after: `RejoinPolicy` learns to go on asking slowly instead of stopping after five). So a
  lobby's PC that comes back is found within two and a half minutes at worst, and at once on a direct link. The
  saved lobby of the lobby's PC is good for the same 20 minutes (today 3).
- **Back**: every member returns by `RECONNECT`, the ball end that was kept is reported, the next grant goes out.
  The clocks of §11.8 start from zero.
- **Not back in 20 minutes**: "The lobby is closed: MekelburgJ's PC did not come back", teardown, every table
  unlocked. The match is over without a result for the game that was open.

Two things in the first version keep this to the one case:

- **End my ball** (§11.2): no match needs the hands of the lobby PC's owner. A player on a table that cannot report
  ball ends, or with a stuck ball, moves the match on themselves.
- A player who is idle on their ball while the owner of the lobby's PC is away from the keyboard is still only moved
  on by the 20-minute ball limit, Pass the turn, or their own End my ball. That stays.

**The hand-over of a lobby to another PC is the next work after the first version** (A10.2, to be filed by the lead
in this shape; not a step of §11.12). What it needs:

- **The engine**: the transfer that exists (`HOST_TRANSFER`, `host_requested` and `host_left`; `commitTransfer`,
  `resumeFromLog`; tested by `ws-transfer.test.ts` and the two `four-player-transfer` scenarios, which this design
  leaves untouched) works during a game and for a match's roster. A lobby needs it also between games and with no
  match open, where there is no log to anchor it: a signed copy of the lobby's state takes the log's place.
- **What is carried**: the members with their keys and choices, who is away, the table pick, the starter, the number
  of the next match, the balls per game, each member's last `seq`, the table differences. A successor named in
  advance (a `HELLO_ACK` key) gets this copy on every change, so it can take over a lobby whose PC is gone and not
  only one that hands over politely.
- **ArcAid's relay**: a room belongs to the device that made it, and another device's `match:host` for the same code
  is `code_in_use`. It needs a way for the room to change hands: the host naming a successor that may claim the
  code, at once when it hands over and after the 30 s when it is gone. `HOST_TRANSFER.newHostEndpoint` is a `ws://`
  address today and needs an answer for a room.
- **The media** needs nothing: it never crossed the lobby's PC.

### 11.9 The screens

**The Match tab, with no lobby.** Two cards where Host a match and Join a match are (`Match.tsx`, `OneStep.tsx`):

- **Open a lobby**: the table picker, Balls per game, Your name, the button **Open lobby**. Under it: "You get a
  code to send. Everyone who joins can talk, play or watch. Play as many matches as you like without leaving. Your
  microphone is on for the others from the moment you open it."
- **Join a lobby**: Code or link, **Join**, and "Your microphone is on for the people in the lobby from the moment
  you join." A link that asks first (§9.2) asks: "Join this lobby? … Joining turns your microphone on for the
  people in it and starts the lobby's table in VPX."

The sentence about the microphone goes onto today's Host and Join cards already in step 1, the step that turns the
microphone on at the join.

**The Match tab, in a lobby**, top to bottom:

- `Lobby JHDFEF · Through ArcAid · 3 of 4 here`, and the Invite card **on every member's tab**, not only the
  opener's (`one-step.ts` `linkOf` gives a link to the host alone today): the code, the link, Copy, the chat line
  "Castcade lobby on Monster Bash: https://arcaid.app/castcade/join/JHDFEF". The notices of `one-step.ts` say
  "lobby" where they say "match" ("That lobby is gone or cannot be reached: ask for a new link.").
- **In the next match I** `[ Play ]` `[ Watch ]`. Under it, when it applies: "You are watching this match. You are
  in when somebody starts a new match." / "You play this match. You sit out from the next game."
- The people, one row each, the opener's like any other:
  `MekelburgJ (you) · opened the lobby · VR · PLAY · starts from the table` ·
  `Krobs · VR · PLAY · LOADING` ·
  `ChuckRibbits · VR · WATCH · NO TABLE` ·
  `Dana · PC · PLAY · AWAY 0:42`.
- `Table: Monster Bash (Williams 1998) · picked by Krobs` and **Change table…**: the picker, then "Everyone's VPX
  closes its table and opens Congo. The match that is open ends. **Change table** / Cancel". On a PC with the
  setting off, or with a table Castcade cannot follow: "Krobs picked Congo. **Open it**" / "Close your table:
  Castcade opens Congo when it is closed."
- The start button, whose words and line say what a press does:
  - **Start match** · "MekelburgJ and Krobs play. ChuckRibbits watches."
  - **Next game** · "Game 3 of this match. MekelburgJ 1 win, Krobs 1."
  - beside it, when somebody outside the match is set to Play, **Start a new match** · "Dana plays too. The match
    that is open ends at MekelburgJ 2, Krobs 1."
  - greyed, with the check that fails (§11.4): "Two people have to be set to Play."
  - while a start counts down: "Krobs starts the match: Krobs, MekelburgJ · 4" and **Cancel the start**.
  - while a start waits: "Krobs starts the match once Dana's table is open." and **Start without Dana** / **Cancel
    the start**.
- During a game: the player who is up has **End my ball** ("End your ball now at 12,345,670? The turn passes.");
  a player has **Give up this game**; the lobby's PC has **End match for everyone**, **Pass the turn** and
  **Resume** as today, **Play on without Krobs** while a player is waited for, and the question of §11.8 for a
  player who is up and out of reach. Between games, **End match** · "Closes the tally. Everyone stays in the lobby."
- **Leave lobby**; on the lobby's PC **Close lobby** · "This closes the lobby for everyone."

**The panel** (the headset, or the desktop panel window; `panel-page.ts` `headerText`, `controller.ts`
`lobbyMessage`):

- In the lobby the header is `LOBBY · 3 HERE` (today `WAITING FOR THE START`), `STARTING IN 5` in a countdown,
  `CHANGING TABLE` while tables are being opened. The rows are the members with `PLAY` / `WATCH`. The line names
  the starter, so that one person and no other reaches for their Start key: to the starter "Everyone in? Start a
  game on your table (or Start match in the menu)"; to everyone else "Krobs starts the match from his table. To
  start it yourself: Start match in the menu"; "Waiting for a second player: only MekelburgJ is set to Play";
  "Krobs starts the match once Dana's table is open"; to a watcher "You are set to Watch: the match starts without
  you". The lobby panel gets out of the way of a free table after 8 s as today (D8.9).
- In a game the header is today's: `YOUR BALL 2` for the player up, `KROBS IS UP` for everyone else, a watcher
  included. Under the score strip: `Watching: ChuckRibbits, Dana`.
- Between games: `GAME 2 OVER`, the standings and the tally as today, and to the starter "Next game: start a game
  on your table (or Next game in the menu)", to the others "Next game: Krobs starts a game on his table. To start
  it yourself: Next game in the menu".
- After End match: `MATCH OVER` with the final tally for 20 s (the time a client's panel lingered before it
  closed), then the lobby. After End match for everyone: `MATCH ENDED · GAME 3 NOT FINISHED` (§11.2).

**The in-game menu** (`match-menu.ts` `menuItems`), for every member, top to bottom: **Start match** / **Next game**
(off with the sentence of the check that fails; a second choose where Start anyway is needed; while a start waits
the line is **Start without Dana**, while one counts down **Cancel the start**); **Start a new match** (when it
applies; "Choose again: the open match ends"); **Play or watch** `PLAY` (a choose flips it); the three volumes;
Microphone; Put the scoreboard where I look; **End my ball** (the player who is up: "Choose again to end your ball
at 12,345,670"); **Give up this game** (a player, during a game: "Choose again to give up this game"); **End
match** (between games: "Choose again to end the match; everyone stays in the lobby"); **Leave lobby** ("Choose
again to leave the lobby"; the lobby's PC: "Choose again to close the lobby for everyone"); Close menu. The table
is changed on the Match tab only.

**The scoreboard** (`scoreboard-page.ts`) is the same card for a watcher as for a player: `GAME 2 · BALL 1 OF 3`,
the players in turn order with the one who is up marked, the tally of the open match; `KROBS AWAY ·` or `LOBBY PC
AWAY ·` before the title when that is so. It is shown while a game is on and not in the lobby (`scoreboardWanted`),
as today.

`PanelState` (`match-media-types.ts`) gains the lobby's rows (`members`: id, name, Play or Watch, the flags), the
starter, this person's own choice and who a pause is for. `players` stays the players of the match, so the strip,
the scoreboard and `tallyText` do not change.

### 11.10 ArcAid

**Now: nothing has to change on ArcAid for a lobby of four.** What was read in `src/api/matchRelay.ts` and ADR 0039
(ArcAid main, 2026-11-24), and what the companion does about each:

| The room today | For a lobby |
|---|---|
| Ends 12 h after it was made (`MATCH_ROOM_TTL_MS`), whatever happens in it; nothing extends it | An evening fits. A lobby left open past it gets `expired`, which the host already answers by registering the same code again (§3a) |
| 8 sockets, the host's included (`MATCH_MAX_SOCKETS`). A device that comes back on a new socket holds two until the old one times out | Enough for four |
| `match:lock` has no unlock; a locked room refuses a device that never had a seat | **A lobby is never locked.** The companion stops calling `relay.lock()` (and `REHOST_LOCK_MS` with it) |
| Kept in memory; a deploy ends every room, and nobody is sent `match:closed` (the code that would is only run by the tests) | The sockets drop, the host registers the code again, every member relinks (§3a). By §11.8 that is the lobby's PC away for some seconds, not a pause |
| The host has 30 s to come back (`MATCH_HOST_GRACE_MS`); clients are not told it is away; after it the room is closed | The returning PC registers the code again and the members find it by asking (§11.8a) |
| A device is held back for 15 minutes after eight wrong or missing codes in ten (`MATCH_MISS_LIMIT`) | What sets how often a waiting PC may ask: six times in the first ten minutes, four in each ten after (§11.8a) |
| A frame is 256 KB at most (`MATCH_MAX_DATA_BYTES`) | A whole log is sent in pages of 100 entries, about 50 KB (§11.7). Today a `RECONNECT_ACK` past about 500 entries is reported and not sent (`docs/arcaid-side-changes.md` §4a) |
| Two roles, host and client; a client reaches only the host | A watcher is a client like any other. Nothing to add |
| 200 frames per 10 s per client socket and per destination from the host | A player's `STATE` to three others is half a bucket, as with three clients today |
| No link between a room and a Throwdown; the roster check is an empty seam (`admitJoin`) | See below |

What an unlocked room costs: the six-letter code is the only key for as long as the lobby is open. Any paired PC
that has it can take a place until four are in (ArcAid still stops guessing, by the row above). The members see who
joined, and it is a room of friends; §11.13 has the cheap switch.

**Items the lead can file** (ArcAid's section W, mirrored in section F here):

1. *Later, small:* a lock that can be undone (`match:unlock`, or `match:lock {on}`), so "closed to new people" can be
   enforced where the seat is given and not only at `HELLO`.
2. *Later, small:* `match:closed {reason: 'server_restart'}` sent when the process is told to stop, so a deploy is
   told and not guessed from a dead socket.
3. *Later, small:* a PC that waits for a code is told when it is hosted again, instead of asking every 150 s under
   the lockout (§11.8a).
4. *Later:* the 12 hours counted from the last frame, not from creation, or left as it is: the companion heals it.
5. *For A17.1:* more than 8 sockets in a room.
6. *For the hand-over (§11.8a):* a room that can change hands to a successor its host named.
7. *For A5 / F6, a change of plan to write down now:* **a room is no longer one Throwdown.** F6 (ArcAid W8.3, W8.4)
   meant to admit a device to a room by the roster of the Throwdown the code names. A lobby's room outlives its
   matches and holds people who are in no roster. So: a room is admitted by the lobby's own list (the invited
   friends of A14.8 / F28, or today's "has the code"), and a Throwdown is made **per match**, from what the lobby's
   PC posts: the match id `<code>-<n>`, the players of its `MATCH_READY`, one `RESULT` per game with the series
   (§8's request, unchanged). Two notes for that ingest:
   - **the poster, and the key of `RESULT.hostSignature`, may belong to a device that is not on that Throwdown's
     roster** (the lobby's PC only watched). ArcAid takes the host's key from the paired device that posts
     (`witness_devices.public_key`), not from the roster;
   - **`<code>-<n>` is unique only for a room's life**: codes are six random letters and come round again. ArcAid
     keys a match on the hash of its log (`RESULT.logHash` of its first game), not on the id.
   Watchers are posted nowhere. A game ended for everyone has no `RESULT` and is posted nowhere. Nothing is posted
   today (A5 waits on F6).
8. *For A14.8 / F28:* what a friend is invited to is a lobby ("Krobs is online: invite to my lobby"), not a match.

### 11.11 Five or more (A17.1)

What stops at four is the media, as D9 says, not this design:

- **What changes past four.** Each PC cannot hold a voice connection to every other, and the player up cannot run
  an encoder for every watcher: the voice is mixed or forwarded, and the picture is forwarded, by the lobby's PC or
  a relay of ours (D9, D10.9). A watcher in 3D costs the player up 83 to 145 KB/s and no encoder, so 3D watchers can
  be let past four before the video can. The room on ArcAid needs more than 8 sockets, and the roster, the strip
  and the panel need a layout for more rows (D8.6).
- **What was chosen now to keep that cheap.**
  - A watcher is in no logged message. A match's log, its `RESULT` and what ArcAid ingests are the same with one
    watcher or with fifty; the limit of four on `playerOrder` is the limit on players, which the rulings do not ask
    to lift.
  - The size of the lobby is one number in the engine (`HostOptions.lobby.size`; today `onHello`'s `>= 4`), with no
    schema behind it (`HELLO_ACK.participants` has no maximum).
  - Who a PC holds media connections with comes from one list, the members, in one place per kind (`onLobby`,
    `syncNativeVideo`, `syncStream`), and the rule that holds a newcomer's `video` and `stream` back from a person
    on a ball is the same rule a forwarder would use. A forwarder changes the answer of those three, not the lobby.
  - Match control is already a star through the lobby's PC, with a rate counted per destination, and a log is
    already sent in pages.
  - `Stance` is an enum, and "does this PC need the 2D picture" is a fact the tunnel already knows (it is watching
    in 3D or it is not): the first saving, no encoder for a PC that watches in 3D, needs no new message.

### 11.12 The build plan

Each step is one pull request and leaves main releasable. **Steps 1 to 6 leave main on protocol 6 and playing with
0.2.50; step 7 makes main protocol 7.** That is possible because the engine's lobby behaviour (steps 5 and 6) sits
behind an option that the shell only turns on in step 7 (§11.7): with it off the engine is today's engine, which is
proved by today's suites passing untouched. So a fix can be released on protocol 6 at any time before step 7, and
from step 7 on main is a lobby build that is released once, after step 10. Step 1 starts from A18 as it is merged
(§11.8) and repeats none of it. Sizes: S about a day of an agent's work, M two or three, L a week.

| # | Step | Protocol | Size | New tests | Existing suites |
|---|---|---|---|---|---|
| 1 | **The voice from the join on.** Voice peers follow the lobby roster (`MatchController.onLobby`); `addPeer` for a peer already held makes no new connection (`rtc-host.ts`); the microphone sentence on the Host and Join cards; the refusals in the asker's version (§11.7). A 0.2.50 PC in the same lobby holds the early offer until its own `MATCH_READY` (`SignalingMesh.receive` keeps 64 early signals), so the voice with it starts when it did before | 6 | S | `controller.test.ts`: "the voice is up in the lobby"; "MATCH_READY, NEXT_GAME and a reconnect make no `addPeer` / `removePeer` call that opens or closes a connection"; `rtc-host.test.ts`: "addPeer for a peer already held is not passed to the page"; `transport-relay.test.ts` and `fakeclient/src/ws-smoke.test.ts` (where the refusal of another version is tested today): "a HELLO, and a RECONNECT, of another version are answered in that version" | Change: `controller.test.ts` and `main/match-host.test.ts` where they expect the peers at `MATCH_READY`; the two just named, where they expect the `REFUSE` in the host's version. Untouched: `rtc-signaling.test.ts` (the mesh's `add` keeps its meaning), `engine`, `series`, `turn-pass`, `restart`, the rest of fakeclient, `main/match-host-orderings.test.ts` |
| 2 | **`match-host.ts`: what ends with a match, what ends with the lobby.** `teardown` split in two by the list of §11.6, with no change in behaviour (both halves still run together) | 6 | M | `main/match-host.test.ts`: "the match half leaves the voice, the video mesh, the tunnel, the overlay and the menu keys as they are" | Untouched, all of them: `main/match-host*.test.ts`, `main/match-restart.test.ts`, `main/witness-restart.test.ts`, `main/one-step.test.ts` |
| 3 | **A table that is open and wrong is closed and the right one opened** (`launch/vpx-close.ts`, the wish in `one-step.ts`, the fork's `quit` in castcade-vpx). It has an effect by itself: a host who opens another table in today's lobby moves every joined PC to it (a change of `hostGame` from one named table to another; a table that was open at the join is still kept), so the two cases in which nothing may be closed are tests of this step | 6 | M | `launch/vpx-close.test.ts` (the three rungs against a scripted fork and a fake window); `one-step.test.ts`: "another table is open: closed, then started", "a game is running: nothing closes", "an initials hold, and the window of a finished game: nothing closes", "a table Castcade cannot follow (basic mode): never closed, the player is asked", "no copy: nothing closes". Rig: check 11 below | Change: `one-step.test.ts` gains cases. Untouched: its "a table that is already open is used" cases, `main/match-host-orderings.test.ts` |
| 4 | **For the player who is up, and the people watching them.** End my ball (`BALL_END` `manual`: the Match tab and the menu); a pause for the player up keeps the others' picture (`vrViewMode`, `syncStream`, the scoreboard's title, §11.6) | 6 | M | `controller.test.ts`: "End my ball reports the grant's ball at the last score", "paused for the player up with the picture arriving: spectate"; `main/match-host-stream3d.test.ts`: "a pause for the player up keeps the 3D watch; the re-issued grant does not start it over; no picture: the panel"; `match-menu.test.ts`: the End my ball line; `scoreboard-page.test.ts`: the `AWAY` title | Change: the `vrViewMode` cases of `controller.test.ts` that expect the panel at a pause. Untouched: its D8.14 cases, `turn-pass.test.ts`, `engine.test.ts` (a `manual` `BALL_END` is an ordinary one to the host) |
| 5 | **The engine, behind the option (1): the lobby and its matches.** The schemas and the prose of §11.7 (nothing new is sent with the option off; `PROTOCOL_VERSION` stays 6, and `version.ts` says so). With `lobby` on: `HostMatch` keeps its members for its whole life, the lobby's PC a member row, takes a `HELLO` in every phase and answers with the log in pages, sends the logged stream only to members that hold it, starts a match with given players (the lobby's PC allowed out of them), goes back to the lobby at `MATCH_END` with a new log (`Session.newMatch()`), refuses a transfer; `ClientMatch` the same (its per-match counters start over: `lastGrantSeqSeen`, `signedGame`, `resultsReceived`) | 6 | L | `match/lobby.test.ts` on `MemoryBus`; fakeclient scenarios `lobby-two-matches`, `lobby-watcher`, `lobby-host-watches`, `lobby-join-mid-game` (a `BALL_END` lands between the `HELLO_ACK` and the last page), `lobby-long-log` (a log of 600 entries, in pages, through the relay double), `lobby-series-then-new-match` (the scenario file gets `lobby: true`, `matches: []` and a `stance` per player); `protocol` generate `--check` | **Untouched, as the proof that the option gates it:** `engine`, `series`, `turn-pass`, `restart`, `participant-update`, `media-signal`, `state`, `start-wait-3d`, the nine scenarios of `scenarios.test.ts` (its loader learns the new keys), `gate`, `relay`, `ws-reconnect`, `ws-smoke`, `ws-transfer`. Change: `protocol/test/messages.test.ts` and `generated.test.ts` (new shapes) |
| 6 | **The engine, behind the option (2): asking, and dropping.** `START_REQUEST` with the checks of §11.4 at the request and at the countdown's end (`HostMatch.requestStart`), the starter, the countdown on every start and `START_CANCEL`, Next game against Start a new match, `END_REQUEST`, End match for everyone with no result, `TABLE_PICK`, `away`, the two clocks and what stops them, `RECONNECT` in every phase with its `seq` signed, the fallback to `HELLO`, the two client checks of §11.7 | 6 | L | `match/lobby-start.test.ts` (one test per row of the table in §11.4, at the request and at the countdown's end; "two Starts in the same countdown: one game, the starter first"; "a non-starter's game_start is never a request"); fakeclient `lobby-start-by-client`, `lobby-start-from-starter-table`, `lobby-two-starts`, `lobby-start-without`, `lobby-watcher-drops`, `lobby-waiting-player-drops`, `lobby-player-up-drops`, `lobby-rejoin-other-match`, `lobby-ended-for-everyone` (no `RESULT`, the tally unchanged), `lobby-reconnect-replayed` (refused); `fakeclient/src/relay.test.ts`: "in a lobby a relay drop during a ball pauses nobody" | Untouched: the same list as step 5. (`silent-client-pause` is a ball-end timeout, not a drop, and stays as it is. The tests that hold today's pause on a drop are `engine.test.ts` "a dropped client pauses the match…", `ws-reconnect.test.ts`, `relay.test.ts` and `restart.test.ts`: they are A18's to change, not this step's, and with the option off this step leaves them as A18 left them) |
| 7 | **The shell turns the lobby on: protocol 7.** `PROTOCOL_VERSION` 7. `Active` lives across matches; the controller returns to the lobby; no `relay.lock()`; Play / Watch, the three starts, Cancel, End match and Give up this game as IPC, with plain controls on the Match tab; a PC not in `playerOrder` reports nothing from its table (§11.3); a watcher's lock, view, sound and 3D; a game of one's own left alone; the locks of §11.2 and of a countdown; a newcomer's `video` and `stream` held back from a person on a ball; the waits of §11.8a (`RejoinPolicy`, 20 minutes) | **7** | L | `main/match-host-lobby.test.ts` (two and three real match hosts, a driven witness): two matches with not one `addPeer` or `removePeer` between them; "a watcher's table game ends, and its table closes, during a match: nothing is sent, nothing is on its panel"; a watcher locked and shown the player up; a watcher in a game of their own left alone; the lobby's PC watching; a join during a ball: the video mesh and the tunnel of the player up get the newcomer at the ball's end; the lobby's PC away for 5 minutes during a ball: the ball end is kept and reported, the turn goes on; `main/match-host-stream3d.test.ts`: a watcher's fork is sent to watch; `transport-relay.test.ts`: the slow asks never pass six in ten minutes | Change: `main/match-host.test.ts`, `-orderings`, `main/match-restart.test.ts`, `main/witness-restart.test.ts`, `main/one-step.test.ts` and `controller.test.ts` where they expect a teardown at `MATCH_END`, the 20 s linger, a start at once from the button, or `preMatchPlay`; whatever pins the version in `protocol/test`. Untouched: every engine suite and all of fakeclient (they run with the option as each test sets it), `ws-transfer.test.ts` and the two transfer scenarios |
| 8 | **A restart in a lobby.** `match-resume.json` version 2, written from the join; the lobby's PC saves its lobby; `rejoin()` and `resumeFromLog` without the roster check (§11.8) | 7 | M | `main/match-resume.test.ts`: version 2, a version 1 record dropped; `main/match-restart.test.ts`: a client restarts in the lobby, between games and during a ball; a watcher restarts; the lobby's PC restarts while it only watches | Change: `main/match-resume.test.ts`, `main/match-restart.test.ts`. Untouched: `match/restart.test.ts` (the engine's side) |
| 9 | **The screens.** The Match tab, the invite on every member's tab, the panel's lobby view, the starter's prompt and the `Watching:` line, the menu's lines, the words of §11.9; `preMatchPlay` off the tab | 7 | M | `match-menu.test.ts`, `panel-page.test.ts` (`headerText`, the rows, the two prompts), `scoreboard-page.test.ts` (a watcher's card), `one-step.test.ts`: "a client has the link and the chat line" | Change: those four. Untouched: `panel-page-series.test.ts`, `panel-page-table.test.ts` |
| 10 | **The table changes in a lobby.** `TABLE_PICK` wired to step 3, the pick's identity keys, the rows `NO TABLE` / `OTHER TABLE` / `OWN GAME`, the open match ended, the 3D wait after a change | 7 | M | fakeclient `lobby-table-change`, `lobby-pick-during-start` (refused); `one-step.test.ts`: "the lobby's table changed: this PC follows", "Change tables for me off: it asks"; `main/match-host-lobby.test.ts`: a match on the new table starts with the voice peers untouched; "a pick before the picker's table is open flags nobody" | Change: `one-step.test.ts`, `participant-update.test.ts` (the comparison on the identity keys, with the option on) |

Then the release, and the checks only two or more PCs can make. **A tester's list** (two PCs for 1 to 13, three or
four for 14 to 20; both in headsets where it says so):

1. Open a lobby, send the code, the friend joins: you hear each other **before** any table is open.
2. Start match from the friend's Match tab, not the opener's: both headsets count `STARTING IN 5`, and it starts
   with the friend first. Again from the friend's headset menu.
3. The starter starts a game on their table in the lobby: both headsets count down with their name, and their first
   ball is ball 1 of the match. The other person does the same when they are not the starter: nothing starts for
   anyone, and their panel says who the starter is.
4. **Two Starts at nearly the same moment**: on a count of three the starter presses Start on their table and the
   other presses Start match in the menu. One match starts, the starter goes first, and no ball is in play on the
   other table when their turn comes. The same with the two the other way round (the menu a moment earlier).
5. Cancel the start from the other headset during the countdown: both tables are free again.
6. Play a game. Next game from the starter's table, then from the other's menu. The tally reads 1 and 1.
7. End my ball in the middle of a ball: the turn passes at the score on the display; the table is locked.
8. End match: both are back in the lobby, still talking; `companion.log` on both has no `ice new` between the first
   join and the end of the evening.
9. Pull the friend's network cable for 20 s while you are on a ball: your picture, your scoreboard and your flippers
   do not change; their row says `AWAY`; they are back by themselves. Then the same while the friend is on the
   ball: you keep their picture, the scoreboard says they are away, no panel covers it.
10. End the friend's Castcade from Task Manager in the lobby and start it again within a minute: back in the lobby
    by itself, the voice back.
11. Change table from the friend's Match tab: both VPX close their table and open the new one; you keep talking
    through it; a ROM table's high scores are still there the next time it is opened (the NVRAM was written); in a
    headset, what the runtime shows between the two tables and that the panel comes back. With a game running on
    one PC, and with a table that is not imported open on one PC: that table is not closed.
12. **The lobby's PC goes away**, its owner only watching: end its Castcade during the other person's ball. They
    finish the ball without a change on their table; then every panel says it waits, with the minutes. Start that
    Castcade again after 5 minutes: everyone is back by themselves within about 3 minutes (at once on a direct
    lobby), the kept ball end is reported, the next turn starts. Block arcaid.app on the lobby's PC for 20 s
    instead: nobody is paused.
13. End the opener's Castcade and leave it: after 20 minutes the friend's Match tab says the lobby is closed and
    their table is unlocked.
14. A third person joins **while a ball is in play**: they hear everyone at once and see the scores; the table
    appears at the next ball. The player who was up had `CASTCADE_FRAMELOG` on: no slow frame at the moment of the
    join, nor at the moment the ball ended.
15. The third person joined on Play during a series of two: a start from the starter's table is the next game of
    the two, and the third still watches. Start a new match brings them in.
16. The third person set to Watch: a match of two starts without them; they see the player up in 3D when they have
    the Castcade VPX build and the identical file, the flat video when not; their flippers and Start do nothing
    while it is played, and work again between games. Their own table game, started before the match, is theirs
    until it ends, and nothing about it shows on anyone's panel.
17. The opener sets themselves to Watch: the other two play a whole match that the opener only watches.
18. The watcher closes Castcade in the middle of a ball: neither player sees or hears a change.
19. A person set to Play has no copy of the table, another has theirs still loading: the first does not hold the
    start; the second does until Start without them is pressed.
20. Four in the lobby, two playing: the player up reads their send statistics on the Match tab (three pictures out);
    a fifth person is told "This lobby is full (four people)." A PC on 0.2.50 is told to update, in a sentence.

### 11.13 Decisions taken alone, and open points

**Changed from the lead's list, because of the code.**

- **A watcher's table is locked while a game is played** (the lead: "never a lock"). `syncStream` sends a VPX to
  watch only while its table is locked, and `onReady` already locks every PC; in the 2D theater nothing holds the
  keys, and Start would begin a game under the picture, unheard. A watcher is still never granted. The one
  exception is a game of their own that was already running (§11.3).
- **Watch is not a new role in any logged message** (the lead: "Watch is a new role in the protocol"). The engine
  already has a person who is in the room and not in the game (`NEXT_GAME.playerOrder`), and keeping watchers out
  of `MATCH_READY` leaves the log, the fold and the future ArcAid ingest as they are. The lobby is still protocol 7,
  for the reasons in §11.7.

**Changed by the review of 2026-11-24 and the lead's rulings on it.**

- Every table unlocked between games is withdrawn: it made two people's Start on their tables the common accident.
  One named starter instead, every start a countdown with a cancel, and a game of one's own never taken for the
  match's (§11.2, §11.4).
- Next game or new match is the asker's choice: a start from a table and a default can no longer end a series or
  pull a newcomer into one (§11.3, §11.4).
- The forfeit of a person who is away counts from the pause at their own turn, and a player who is up and still
  seen to be playing is never forfeited by a clock (§11.8).
- The lobby's PC is said to be the one PC a match depends on, the wait for it is 20 minutes and not 2 or 3, End my
  ball takes the turn out of its owner's hands, and the hand-over is described as the next work (§11.8a).
- A game ended for everyone has no result (§11.2); a pause for the player up keeps the picture (§11.6); a person who
  joins during a ball costs the player nothing until it ends (§11.3); the log reaches a newcomer unasked and in
  pages (§11.7); the protocol version changes when the shell turns the lobby on (§11.12).

**Decided here, each reversible in its step.**

- A match stays a series: the tally goes on from game to game until somebody ends the match, changes the table or
  starts a new one. The other shape, every Start a new match and one tally for the evening kept by the lobby, is
  less engine and loses §8's signed series; it would also need a new place for the scoreboard's tally.
- The 3D wait holds a start for players only, and applies to every start in a lobby (§11.4).
- Only the lobby's PC ends a match in the middle of a game (§11.2). All the players together can end it too, each
  by giving up; nobody else should be able to take a ball away from the player who is up.
- `HELLO_ACK` is the lobby's state in every phase; there is no separate lobby message (§11.7).
- A newcomer is set to Play unless their PC remembers Watch (§11.3); it brings them into nothing by itself.
- `preMatchPlay` is retired in a lobby (§11.4).
- The wait for the lobby's PC is 20 minutes, and both the place and the turn count 3 (§11.8, §11.8a).

**Open, for the lead.**

1. **A person who is in the lobby to talk, and wants neither to play nor to watch** during a match (their own
   table, their own sound). In the first version they can finish a game of their own that was running, and are a
   watcher after it. *Recommended:* later, as a third value of `Stance` (`alone`), which is why it is an enum; the
   cost is one more branch in the lock, the view and the table sound, and one more button.
2. **Closed to new people.** An unlocked room is open to anyone who has the code (§11.10). *Recommended:* add a
   switch on the lobby's PC, "New people can join" (on by default), that makes the engine refuse a `HELLO` from a
   device that was never a member ("This lobby is not taking new people"); S, in step 9, no ArcAid work. The lock
   on ArcAid's side (item 1 of §11.10) can follow.
3. **Closing VPX from Castcade** (§11.5) has never been done by this app, and whether a stock VPX 10.8.0 started with
   `-Play` leaves cleanly on `WM_CLOSE` (NVRAM written, no dialog) is not known. *Recommended:* build step 3 with
   the three rungs and run check 11 on the owner's rig and on Krobs' official build before step 10 depends on it;
   if the second rung is not clean, stock VPX gets the third rung only (the person closes the table, Castcade opens
   the next), and the fork's `quit` carries the automatic case.
4. **Changing the table from the headset.** Not in the first version (a picker is a list). *Recommended:* later, a
   menu line "Next table" that walks the lobby's recent tables; S once step 10 is in.
5. **Balls per game** is the opener's choice at Open lobby and can be changed on its Match tab between matches
   (`HELLO_ACK.ballsPerGame` tells the others). Whether anyone may change it, like the table, is not ruled.
   *Recommended:* leave it with the opener.
6. **Handing the start to somebody without starting.** The starter is fixed by rule (§11.4), and anybody else
   starts from the menu. If the owner wants "you start this one from your table" said to a friend, it is one more
   request message and a menu line ("Let Krobs start"); S. *Recommended:* not until somebody asks: the menu's
   Start does the same in one press.
