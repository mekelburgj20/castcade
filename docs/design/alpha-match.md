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
  ArcAid work (its WORK section W) and is **not built**; when it exists, `inviteMessage` should carry that address.

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
- Castcade restarted in the middle of a match: the match is not picked up again (a host's match is gone; a client has
  no way back in but the link, which the host refuses once the roster is final). Needs the reconnect of A3 on the Match tab.
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
