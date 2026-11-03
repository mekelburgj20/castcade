# Alpha match: two VR players, one table, video and voice in the headset

**Status:** design 2026-10-30; built 2026-10-31 on `main` (A6 + C3, D2, D7, H4: `match/controller.ts`, `main/match-host.ts`, `media/rtc-host.ts`, `media/panel-page.ts`, `media/vr-overlay.ts`, `vr-overlay/`), untested on a rig; the §6 checks are the gate. Design for the first real match (owner + tester Krobs, both in VR). Builds on the Phase 1 engine
(`companion/src/match/`), A2/A3 (WebSocket transfer and reconnect), the live detector (C2), the turn lock in hook
0.1.0+ (`vpx-hook/castcade.vbs`, Phase 0c pass), the VR detection (`witness/vr-detect.ts`) and the D1 media stack.
Owner ask 2026-10-30: build the final product, not an interim; video and voice between the players; both in VR.
Rulings that bind this: peer-hosted (no media on ArcAid), ADR 0002 (a match is a Throwdown; the ArcAid lobby comes
later, F6), ADR 0007 (functionality first, guided setup).

## 1. What a player does

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

- Role objects come from the engine: `HostMatch` or `ClientMatch` on a `Session` over `WsPeerTransport`.
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
  `https://api.ipify.org` (one GET, failure → the LAN address with a note to replace it).
- **Media hooks**: on `MATCH_READY` → `media.attach(signalling, peerIds)`; on my grant → `media.setSending(true)`; on
  my `ball_end` accepted → `setSending(false)`; every state change → `media.setPanelState(...)`; on leave → `detach()`.
  In VR (`inVr`) the controller also starts `VrOverlay` with the panel's frame source; on the desktop the panel window
  is simply shown. The VR runtime (`RigDecision.runtime`, B22) picks the overlay (D7.3, 2026-10-31): SteamVR → the
  OpenVR overlay helper (§5); any OpenXR runtime (the owner's rig: Virtual Desktop's, through OpenComposite) → the
  Castcade OpenXR layer (§5). A later reading on a runtime that needs the other one swaps them. The rig, `play_device`
  and the capture pick follow `inVr`.

## 4. Media (D2)

- **Signalling**: new protocol message `MEDIA_SIGNAL` `{ to: PlayerId, kind: 'offer' | 'answer' | 'ice', sdp?: string,
  candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } }`, direction `any`; the host
  relays it to `to` only (never logged, like STATE); protocol stays 2 (unreleased). Built: `HELLO_ACK.hostGame` was added too, so a client learns of a table-file mismatch and both panels flag it (the host accepts the HELLO in `advise` mode). Prose: a "Media signalling"
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
