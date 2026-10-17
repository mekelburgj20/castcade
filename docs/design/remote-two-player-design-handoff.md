> **Provenance.** Handoff document written 2026-10-17 by a previous agent, before ArcAid's current
> state (v2.160.0) was known. Preserved verbatim below this header as the origin of the Castcade
> design. Where it disagrees with `arcaid-integration-gap-analysis.md` or an ADR in
> `../decisions/`, those win. Known-wrong points: VPX 10.8 plugin SDK (10.8.0 has no plugin
> system — ADR 0001), the "ArcAid Challenge" lobby entity (it is a Throwdown — ADR 0002),
> `rommaps/` (use the pinmame-nvram-maps corpus), the paid-tier assumption (none exists).

# Castcade: Remote Live Multiplayer for Virtual Pinball and Arcade Emulators

Oct 17, 2026 · @Justin Mekelburg

## Read this first (for the implementing agent)

Castcade lets two to four friends take turns on the same virtual pinball table or arcade game over the internet, watch each other live, and talk. Nobody runs a server for it: one player's PC hosts the match, and ArcAid (the owner's existing tournament platform) only introduces the players and records the result.

Decisions already made; do not reopen them without asking:

| Decision | Choice |
| --- | --- |
| Hosting model | Peer-hosted. The host player's companion app is the arbiter and stream forwarder. ArcAid does signaling and results only. See "Zero-server option". The "Server-hosted option" section is an optional later upgrade, not the plan. |
| Pinball mode | VPX 10.8 plugin plus companion app; parallel 1-player games with turn locking (architecture B). The v2 shared-ROM state transfer is out of scope for now. |
| Arcade mode | RetroArch netplay with the FBNeo core; Castcade launches it and reads scores. See "Arcade mode". No MAME fork. |
| Players | 2 to 4. Build the protocol for N from the start; test with 2 and 4. |
| Voice | WebRTC audio mesh between all participants, Opus, push-to-talk option for the active player. |
| Repo | github.com/mekelburgj20/quarterd, to be renamed castcade. Monorepo; layout below. |
| License | GPLv3 for everything in the Castcade repo. ArcAid-side code (lobby, signaling endpoint, result storage, subscription checks) lives in the ArcAid repo, never here. |
| Never bundle | VPX, VPinMAME, RetroArch, FBNeo, or any ROM or table file. Castcade finds the user's installed copies, hashes them, and launches them. Their licenses forbid commercial redistribution and ArcAid has a paid tier. |
| Names in code | Product: Castcade. Lobby: an ArcAid Challenge. Roles: host, client. Turn token: grant. |

Terminology note: sections below written before the hosting decision say "relay". Read "relay" as "the host player's companion app in host mode" throughout; the message names and rules are unchanged.

Repo layout to create:

- `protocol/` JSON schemas for every message in "Turn protocol", a version constant, and a markdown spec generated from them. Language-neutral; the plugin and the companion both validate against these.
- `companion/` the desktop app (Electron, TypeScript): lobby UI, ArcAid sign-in, host and client modes, WebRTC video and voice, overlay, process launcher for VPX and RetroArch.
- `plugin-vpx/` C++ CMake project against the VPX 10.8 plugin SDK headers (vendored from the vpinball repo, GPLv3+ files only).
- `arcade/` RetroArch launch profiles, the core allowlist, and the score memory-map registry.
- `rommaps/` JSON RAM maps for VPinMAME ROM families, used by the ball-end detector.
- `fakeclient/` a scripted player for tests that speaks the protocol with no emulator.
- `docs/` this document exported, plus per-phase notes.

Build order and acceptance criteria are in "Roadmap". Work that runs on Linux CI versus work that needs a Windows PC with VPX is in "Work split". Items the agent must verify before Phase 0 ends are in "Open questions".

## Goal and non-goals

Two to four people on separate PCs play one alternating-turn game on the same VPX table or the same arcade ROM, each watching the active player live and talking over voice, with the result recorded as a single match in ArcAid. Pinball targets ROM-driven (VPinMAME) tables on VPX 10.8, desktop, cabinet or VR. Arcade targets RetroArch with the FBNeo core.

What it must do:

- Lock both players to the same table file, ROM, and physics settings before the match starts.
- Hand the turn off automatically at ball end, with no keypress and no ambiguity about whose turn it is.
- Show the waiting player the active player's playfield and DMD with under one second of delay.
- Produce a signed match result a tournament system (ArcAid) can ingest.

Non-goals for v1:

- Simultaneous play on one shared pinball physics world. Arcade games that are natively simultaneous (four-player beat-em-ups) do work, because RetroArch handles that.
- More than four players.
- Non-ROM original pinball tables (script-only rules), which need a different ball-end signal.
- Perfect fidelity to shared-state quirks of a real 2-player pinball game (ball locks stolen between players); the v2 section covers it and is deferred.
- Any server-side media. The server-hosted section is documented for a later neutral-arbiter upgrade only.

## The insight that makes this tractable

A 2-player game on a real machine is almost entirely two independent 1-player games interleaved by the ROM. Player 1's modes, multiball progress, bonus and score live in their own slice of ROM RAM; player 2's live in another; the ROM just swaps which slice is active at ball end.

So you do not have to teach VPinMAME to share one emulation across the internet. Each PC can run its own 1-player game, and a thin coordinator can enforce whose turn it is, mirror the other player's screen, and combine the two scores at the end. That removes the hardest engineering (save-state serialization of a MAME core and of VPX's VBScript state) from v1 entirely.

What this approximation gets wrong, and whether it matters:

| Shared-state quirk | Real 2P game | Parallel 1P games | Matters for tournaments? |
| --- | --- | --- | --- |
| Ball locks left in the lock (TZ, AFM) | Player 2 can inherit or steal them | Each player keeps their own | Yes, on a few tables; v2 fixes |
| Ball save and timers | Per player anyway | Per player | No |
| Match / end-of-game bonus | One match sequence | Two; ignore both | No, tournaments disable match |
| Tilt warnings | Per player anyway | Per player | No |
| Player 2 sees player 1's score on the DMD | Yes | Only through the spectator feed | No, feed shows it |
| Physical ball state carried over (ball stuck, multiball in progress at drain) | Shared | Separate | Rare |

For a head-to-head tournament match, the parallel-game result is the same thing a human scorekeeper would record: your score, their score, highest wins.

## Two architectures

Build B first. It reaches a playable, fair match with no changes to the VPX or VPinMAME source; A is the polish layer on top.

|  | A: Shared ROM game, state transfer (what VPX Duo does) | B: Parallel games, turn coordination (recommended v1) |
| --- | --- | --- |
| Emulation | One logical game; the full PinMAME state is serialized at ball end and loaded on the other PC | Two independent 1-player games, one per PC |
| Turn handoff | Transfer state blob, resume emulation on the other side | Coordinator unlocks the other player's flippers and plunger |
| Spectating | Stream switches, lamps, solenoids, DMD, ball positions; spectator VPX renders them as a puppet | v1: WebRTC video of the playfield plus a DMD data stream; v2: puppet render |
| Code touched | Custom VPinMAME64.dll (save states, time fencing) and a VPX fork | A VPX 10.8 plugin plus an external relay; stock VPX and VPinMAME |
| Works on any ROM table | Only ROMs where save state is exact and restore is clean | Any ROM table |
| Determinism needed | Yes, both sides must replay identically or you get desyncs | None |
| Shared-state fidelity (ball locks) | Exact | Approximate |
| Failure mode | Desync corrupts the match | Dropped video; the game continues locally |
| Maintenance risk | Tracks every VPX and PinMAME release | Plugin API is versioned; low |
| Effort to first playable match | Months | Weeks |

A's hard parts are not netcode; they are save-state correctness in a MAME core that was never built for it, and VPX's VBScript table state, which has no serializer at all. Duo's author built a custom VPinMAME64.dll to get there. That is the right v2, after B has proven the lobby, handoff, spectating and scoring.

## Recommended v1 architecture

Two new pieces per PC, none of which require forking VPX: an in-process VPX plugin and a companion app. The companion on one PC runs in host mode and plays the role a server otherwise would.

&#91;embedded content: v1 architecture: host PC, client PCs, ArcAid for signaling only\]

The plugin reads game state out of VPinMAME and enforces the turn lock; the companion handles everything heavy (video, voice, overlay, WebRTC, launching emulators); the host's companion is the single source of truth for whose turn it is and what the scores are, and every client keeps a copy of the log.

| Component | Language / runtime | Why this split |
| --- | --- | --- |
| Netplay plugin | C or C++ against the VPX 10.8 plugin SDK (MsgPlugin API, PinMAME controller messages) | Only an in-process plugin can read ROM RAM each frame and intercept flipper input before the table script sees it |
| Companion app | Electron or .NET, with WebRTC via a library (libdatachannel, or the browser stack in Electron) | Keeps video and UI out of the VPX process; crashes here never take down the game |
| Host mode (inside the companion) | Same TypeScript as the companion; a module switched on for exactly one participant | Arbitrates turns so no client can claim the turn on its own; keeps the match log; forwards the active player's stream to the others |
| Plugin to companion link | Local TCP or named pipe, JSON lines | Simple, debuggable with a terminal, no shared memory |

The companion app also hosts the lobby UI so the VPX plugin stays tiny and stable.

## Turn protocol

The host's companion holds the token. A client's plugin unlocks flippers and plunger only when it holds a signed `TURN_GRANT` for the current ball number; everything else is advisory. For arcade mode the grant is informational only, because RetroArch's player slots already decide whose input counts.

&#91;embedded content: turn protocol · 7 states, relay-arbitrated\]

Each plugin reports `BALL_END` when its detector fires; the relay then grants the turn to the other side. A missing `BALL_END` after 20 minutes, or a dropped socket, moves the match to a paused state that either player can resume or forfeit from.

Messages, all JSON over one WebSocket per client:

| Message | Direction | Fields | Notes |
| --- | --- | --- | --- |
| `HELLO` | client to relay | playerId, tableHash, romName, romHash, physicsHash, pluginVersion | Relay refuses the match if any hash differs between the two clients |
| `MATCH_READY` | relay to both | matchId, ballsPerGame, playerOrder, seed | `seed` is unused in v1; reserved for v2 determinism |
| `TURN_GRANT` | relay to one client | matchId, player, ballNumber, grantSig | The only message that unlocks input; signed with the relay's key |
| `STATE` | client to relay, 10 Hz | ballNumber, score, ballInPlay, tilt | Mirrored to the opponent for the overlay |
| `DMD_FRAME` | client to relay, on change | frame bytes (RLE) or alphanumeric text | Opponent draws it in the companion overlay |
| `BALL_END` | client to relay | ballNumber, finalScore, detectorReason | Relay accepts it only from the current grant holder |
| `GAME_OVER` | client to relay | finalScore | Sent when the ROM reaches game-over for that side |
| `RESULT` | relay to both and ArcAid | matchId, scores, winner, log hash, signature | Posted to ArcAid's webhook |
| `PAUSE` / `RESUME` / `FORFEIT` | either direction | reason | Covers disconnects and unrecoverable desyncs |

Two guards keep it honest: `BALL_END` is ignored unless it comes from the grant holder, and `TURN_GRANT` carries a signature the plugin verifies, so a hacked companion app cannot unlock its own flippers.

Two additions for peer hosting: `HOST_TRANSFER` (host to all, or any client proposing itself when the host is gone; carries the log hash and current ball; accepted when a majority of remaining clients ack it) and `LOG_SIGN` (each client to host at game over; a signature over the final log hash with the key ArcAid issued at login). `RESULT` becomes host to all and to ArcAid, carrying every participant's signature. The protocol is N-player from the start: `MATCH_READY.playerOrder` is a list, and `TURN_GRANT` names the player by id.

## Ball-end detection

The turn ends when the ROM says it does, not when the ball drains. Bonus count, ball save, and multiball all mean a drain is not a ball end, so the detector must read the ROM, with a physical fallback for ROMs it has no map for.

Three signals, combined in priority order:

1. **ROM RAM map (primary).** Every WPC, Sys11 and Stern SAM ROM keeps `current player`, `ball in play` and per-player score at known RAM offsets. The plugin reads them each frame through the PinMAME controller API (VPinMAME already exposes memory reads; PINemHi reads NVRAM the same way). `ball in play` incrementing, or `current player` changing, is a ball end. One small JSON map per ROM family, crowd-sourced like PINemHi's.
2. **Display text (secondary).** On a ball end most ROMs flash `PLAYER 1 BALL 2` or `BALL 2` on the DMD or alphanumeric display. The plugin already captures display frames for the opponent overlay; a tiny matcher on that text confirms the RAM read, or stands in when there is no map.
3. **Physical heuristic (fallback).** Trough switches all closed, no ball in play for 2.5 s, and the outhole or trough-eject solenoid has not fired. Catches tilt, slam tilt, and ROMs with neither a map nor readable display text, at the cost of a slower handoff.

Decision rule: signal 1 alone fires immediately; signal 2 alone fires after a 500 ms confirmation; signal 3 alone fires after its 2.5 s window. Any two signals agreeing fire at once. The `BALL_END` message carries which signal fired so bad maps get found fast.

Edge cases handled in the plugin:

- Ball save returns the ball: RAM `ball in play` does not change, so no ball end. Correct.
- Multiball drains to one ball: same, no change. Correct.
- Tilt: ROM advances `ball in play` after the tilt sequence; detected normally.
- Extra ball: `ball in play` does not increment but `current player` does not change either. The ROM keeps the same player up; the relay simply re-grants the same side when the detector reports the shoot-again display text.
- Game started by accident with 2 players on one side: plugin refuses to report `HELLO` ready until the ROM's player count reads 1.

Non-ROM originals are out of scope for v1 because the only signal is the table script. A later version can add a one-line script hook (`NetPlay.BallEnded`) that original-table authors opt into.

## Spectating

v1 streams video; v2 streams events and renders them locally. Video is good enough for a tournament feed and costs a week, not a quarter.

|  | v1: video | v2: event puppet |
| --- | --- | --- |
| What crosses the wire | H.264 of the playfield window, 720p at 30 fps, roughly 2 to 4 Mbps; DMD as a separate data stream | Ball positions at 60 Hz (two balls times 3 floats), switch and solenoid events, lamp deltas, DMD frames; under 50 kbps |
| Delay | 150 to 400 ms over WebRTC P2P | Under 50 ms |
| Spectator sees | The exact pixels the player sees, including their camera and mods | Their own camera angle and settings, and in VR, a second machine next to theirs |
| Needs from VPX | Nothing; the companion captures the window | A render mode where physics is off and ball transforms come from the network; the plugin API would need a hook to set ball positions |
| Works in VR | Yes, as a flat panel in the room | Yes, and far better: the opponent's game is a real table in the room |
| Build cost | Days with an off-the-shelf WebRTC library | Weeks, plus a VPX contribution upstream for the ball-transform hook |

v1 details:

- The companion captures the VPX window with a desktop duplication API and encodes with the GPU's hardware encoder, so the active player loses no frames.
- The DMD rides separately as data (the plugin already has every frame), and the spectator's companion renders it crisp at native resolution over the video. Score and ball number come from `STATE`, so the overlay is never blurry.
- Cabinet owners show the feed on the backglass or topper monitor; desktop and VR owners get a resizable panel.
- One relay-hosted TURN server handles the pairs that cannot connect peer to peer.

v2 reuses everything in v1 and swaps the video track for the event stream. The ball-transform hook is the one piece that should go upstream into VPX rather than live in a fork; it is small and useful to replay tools too.

## Three and four players, and voice

Four players and voice chat both fit without touching the VPX side. This section was written when the plan still had a server; the fan-out it describes now happens in the host player's companion (see "Zero-server option"), and the SFU column below is the optional server-hosted upgrade, not the v1 path.

| Concern | Two players (v1 as drawn) | Three or four players |
| --- | --- | --- |
| Turn token | Relay alternates A, B | Relay holds an ordered list and rotates; `TURN_GRANT` names the player and ball; same message |
| Game model | Two 1-player games | N 1-player games; each ends after its own last ball, result waits for all N |
| State and DMD mirroring | To one waiting client | To N-1 waiting clients, same messages |
| Video | Peer to peer, one stream up | Active player uploads once to an SFU on the relay host (LiveKit or mediasoup); server forwards to N-1 viewers. Avoids the 6 to 12 Mbps upload a P2P mesh would need |
| Relay cost | Negligible | Still small: only one video stream is live at any moment, so an SFU on the same small VM handles dozens of concurrent matches |

Voice chat rides the same SFU as an audio track per client:

- Opus at about 32 kbps per person; always on for waiting players, with push-to-talk or auto-mute for the active player as a per-match setting.
- Echo cancellation is on by default in every WebRTC stack, but table audio bleeding into an open mic is the main annoyance; the lobby recommends a headset and shows a mic level meter before the match starts.
- The relay can mix voice into the stream feed, so a Twitch or ArcAid broadcast of the match carries commentary for free.
- In VR, each opponent's voice is placed at their machine's position in the room.

For v1 the host's companion is the forwarder: the active player sends one stream to the host, the host sends N-1 copies out. Voice is a full mesh, since four Opus streams are under 150 kbps total and a mesh survives a host transfer without renegotiation.

## Arcade mode (RetroArch)

For classic arcade games (Galaga, Donkey Kong, Pac-Man, TMNT, The Simpsons) Castcade does not build netplay; it drives RetroArch's. RetroArch netplay runs one emulated machine that every participant is connected to, with spectators allowed, and the FBNeo core supports netplay and save states. The ROM itself alternates players, so there is no detector, no video stream and no turn lock to build.

What Castcade does in arcade mode:

| Step | Mechanism |
| --- | --- |
| Lobby | Same ArcAid Challenge; the Challenge names the ROM, the core, and the player order |
| Preflight | Companion locates RetroArch and the FBNeo core on each PC, hashes the ROM zip and the core binary, refuses on mismatch, exactly as the pinball `HELLO` check |
| Launch | Host companion starts RetroArch with the host netplay flag and the ROM; clients start with the connect flag pointing at the host. RetroArch's own handshake verifies core and content match |
| Player slots | Player order from the Challenge maps to RetroArch joypad slots 1 to 4. A waiting player's input is ignored by the game, as on a real cabinet |
| Spectating | Native: every PC renders the emulated machine at full resolution with rollback netplay; nothing is encoded. A player who joins late or beyond slot 4 uses RetroArch spectator mode |
| Voice | Same WebRTC audio mesh as pinball; the companion runs it beside RetroArch |
| Score capture | RetroArch exposes a local UDP command interface with a memory read command; the companion polls score and player-up addresses from a per-ROM map in `arcade/`. Start the map from RetroAchievements' published memory addresses for the same ROMs |
| Result | Host companion assembles per-player final scores from the memory reads, every client countersigns the log, ArcAid stores it, same as pinball |

Constraints to build around:

- Same RetroArch version, same core version and same ROM on every PC; the launcher enforces this and the lobby shows which PC differs.
- Lockstep: one slow PC or a bad link stutters everyone. Fine for turn-based games; the lobby warns when any participant's measured RTT to the host is over 120 ms.
- Core allowlist in `arcade/`: FBNeo first, MAME 2003-plus as a fallback for ROMs FBNeo lacks. Current MAME libretro core is excluded until its netplay is verified.
- RetroArch, FBNeo and ROMs are the user's own installs; Castcade never downloads or redistributes them.
- Four-player simultaneous games (beat-em-ups) work with no turn protocol at all: the Challenge marks the game as simultaneous and the grant messages are skipped.

Castcade-side code for arcade mode is small: launch profiles, the hash preflight, the memory-map registry and the score poller. Most of the arcade phase is testing ROMs and writing maps.

## Fairness and integrity

The match is only worth recording if both sides played the same game under the same rules and neither could edit the result. Four controls, cheapest first:

| Control | What it locks | How |
| --- | --- | --- |
| Table hash | Same `.vpx` file, byte for byte | SHA-256 of the file in `HELLO`; relay refuses a mismatch and names the differing side |
| ROM hash | Same ROM, same version | Hash of the ROM zip; also pins VPinMAME version string |
| Settings hash | Physics and rules: flipper strength, slope, ball count, extra balls, tilt sensitivity, nudge | Hash of the normalized VPX table settings plus the ROM's adjustments read from NVRAM (balls per game, extra ball enable, match off) |
| Signed result | Scores and winner | Relay signs `RESULT`; ArcAid verifies the signature, so a player cannot post a fake result |

During play:

- Only the grant holder's `BALL_END` and `STATE` are accepted, so the waiting side cannot inject a score.
- Every `STATE` carries the plugin's RAM-read score, not a number the companion computed. A companion can lie about video; it cannot lie about score without patching the plugin, and the plugin verifies the relay's signature on grants.
- The relay writes an append-only match log (grants, ball ends, scores, detector reasons, disconnects) and includes its hash in `RESULT`. Disputes get resolved by reading the log, not by argument.
- Nudge is a settings-hash input, so both players have the same nudge strength or none.

What this does not stop: a player who modifies their own plugin binary to report false RAM reads. The plugin binary's hash goes in `HELLO` too, which raises the bar to recompiling; past that, the only real defense is the video feed, where the opponent and any stream viewers can see the score on the DMD. For sanctioned events, require video recording, as physical remote tournaments already do.

## v2: one shared ROM game

v2 makes the ROM itself run a 2-player game and moves the emulation between PCs at each handoff. It fixes the ball-lock quirk and makes the DMD say `PLAYER 2` for real. It is the part that took Duo's author a custom VPinMAME build, and it is where the real risk sits.

What has to be serialized at ball end:

| State | Owner | Serializable today? | Work |
| --- | --- | --- | --- |
| CPU registers, RAM, timers, sound board, display controller | VPinMAME (MAME core) | Partly: MAME has save states, but PinMAME's drivers and sound boards were never audited for them | Add and audit `save_state` for the WPC, Sys11 and SAM families first; everything else later |
| NVRAM (audits, adjustments, high scores) | VPinMAME | Yes, it is a file | Ship with the state blob |
| Table script variables (VBScript globals, timers, mode flags held in script) | VPX script engine | No serializer exists | Either snapshot the script engine's variable table through a plugin hook, or accept that at ball end the script is in a quiescent state and reset only the per-ball timers |
| Physics (ball positions, flipper angles) | VPX | Not needed at ball end: no ball in play, flippers down | Nothing |
| Mechs (ball locks, diverters, Thing's hand) | VPX script plus PinMAME solenoid state | Mostly inferable from PinMAME state, since the ROM owns the mech | Verify per table |

Sequence at handoff: active side pauses emulation at the ball-end tick, serializes PinMAME plus NVRAM plus script snapshot, sends the blob (under 1 MB) through the relay, the other side loads it and resumes. The relay keeps the blob, so a crash mid-ball rolls back to the last handoff, which is exactly what a tournament director would rule anyway.

Why this is a v2 and not a v1: every piece of v1 (lobby, hashes, grants, detector, video, signing, ArcAid hook) is needed by v2 unchanged. v2 only replaces "start two 1-player games" with "start one 2-player game and move it." Building v1 first means v2 is a transport change, not a product.

## Server-hosted option on the existing ArcAid server

The relay becomes part of the ArcAid backend on the Hetzner box, and media runs as one added container. No second server, no webhook, no separate identity.

| Piece | Where it lives | What it replaces in the design above |
| --- | --- | --- |
| Lobby | An ArcAid Challenge: invite code, participants, time limit | The relay's own lobby |
| Identity | The ArcAid session (Discord login) | `playerId` in `HELLO`; the plugin gets a short-lived match token from ArcAid |
| Turn arbiter, hashes, match log | A WebSocket endpoint in the ArcAid Node backend | The standalone relay |
| Result | A direct write to the Challenge scoreboard | `RESULT` signature and the ArcAid webhook |
| Video and voice | LiveKit in its own Docker container next to ArcAid; ArcAid mints the room token per participant | Peer-to-peer WebRTC and the TURN server |

Server requirements:

- Firewall: LiveKit's UDP media port range (configurable; the default is a few thousand ports) plus its TCP signaling port, and the server's public IP set as the advertised address.
- Bandwidth: one four-player match is one stream in and three out, about 12 Mbps and 5 GB per hour at 720p 3 Mbps. Hetzner's included traffic allowance covers this comfortably; drop to 2 Mbps if it ever matters.
- CPU: LiveKit forwards without transcoding, so a 2-vCPU VPS handles a handful of concurrent matches without affecting ArcAid; put a memory and CPU limit on the container so a stream burst cannot starve the app.
- Same reverse proxy and TLS as ArcAid for the WebSocket endpoint; LiveKit uses its own ports.

This removes the ArcAid hook phase from the roadmap and shortens phase 1, since the lobby and identity already exist.

## Zero-server option: one player hosts (recommended)

The section above keeps the relay and media on the ArcAid server, which means every match consumes server CPU and bandwidth. Moving the relay into the host player's companion app leaves ArcAid with only signaling and the result, a few kilobytes per match. This is the recommended model; the server-hosted one is an optional upgrade for sanctioned events that want a neutral arbiter.

| Role | Server-hosted (above) | Player-hosted |
| --- | --- | --- |
| Turn arbiter and match log | ArcAid backend | The host player's companion app |
| Video and voice forwarding | LiveKit container | The host's companion forwards tracks to the other players |
| Identity and lobby | ArcAid Challenge | Same |
| Signaling (WebRTC offers, ICE candidates) | ArcAid WebSocket | Same; a few messages per match, then idle |
| NAT traversal | Server has a public IP | Free public STUN; host UPnP or port forward; optional small TURN on the server for the failures only |
| Result | Server writes it | All clients sign the log hash; ArcAid stores the result with N signatures and flags any mismatch |
| Server cost per match | Streams in and out for the whole match | Under 100 KB |
| Scaling limit | Server bandwidth and CPU | None on the server; the host's upload speed per match |

Host responsibilities, all inside the companion app:

- Issue `TURN_GRANT`, accept `BALL_END` only from the grant holder, keep the append-only match log, exactly as the relay did.
- Receive the active player's single video stream and forward it to the other players, so the active player uploads once and the host uploads N-1 copies. For four players at 720p that is about 6 to 9 Mbps of host upload; the lobby runs a 5-second upload test and recommends the best-connected player as host.
- Mix nothing: voice goes peer to peer as a mesh, since four Opus streams are under 150 kbps total.

Failure handling:

- Host drops: every client holds the full log, so any client can be promoted. One new message, `HOST_TRANSFER`, carries the log hash and the current ball; the match resumes at the last handoff.
- A pair cannot connect even with STUN (carrier-grade NAT on both ends): the lobby says so before the match starts and offers the TURN fallback if one is configured, or suggests a different host.

Trust: the host is a participant and could tamper with the log. Each client signs the log hash at the end with a key issued by ArcAid at login; a result with disagreeing signatures is stored but flagged for review. This is the same trust level as every peer-hosted game, and consistent with the community's honor-system approach to virtual scores.

This removes LiveKit and the server-side arbiter from the roadmap. The companion app grows by one module (host mode) that is the same code as the relay, just running on a player's PC.

## Roadmap

About thirteen weeks of part-time work to a first recorded match, with a gate after each phase so a bad assumption shows up in week two and not week twelve. Each phase lists what to build and what must be true before the next one starts.

&#91;embedded content: roadmap · 6 gated phases to v1, then v2\]

| Phase | Build | Gate (acceptance) |
| --- | --- | --- |
| 0 Spike | `plugin-vpx/` skeleton: loads in VPX 10.8, reads PinMAME RAM, logs player/ball/score, blocks flipper input on a local command. Resolves the first two open questions | On a Windows PC, flippers lock and unlock from a command sent over the local socket, and the log shows correct player, ball and score on one WPC table |
| 1 Host mode | `protocol/` schemas; `companion/` host and client modes with the turn arbiter, match log, `HOST_TRANSFER`, `LOG_SIGN`; `fakeclient/`; CI on Linux | Four fake clients complete a 3-ball match with correct alternation, one forced host transfer, and matching log hashes, in CI |
| 2 Detector | Ball-end detector as a pure function; `rommaps/` for WPC, Sys11 and SAM; record real session logs from the plugin | 100 ball ends across 5 tables with zero missed and zero false handoffs, replayed from recorded logs in CI |
| 3 Streaming | Window capture and hardware encode, WebRTC video through the host, voice mesh, overlay with DMD and score | Four real PCs: feed delay under 400 ms, voice both ways, host upload under 9 Mbps at 720p |
| 4 Arcade | `arcade/` launch profiles, preflight hashes, core allowlist, score poller, first 10 ROM maps | A 4-player Galaga match on real PCs with correct scores captured for all four |
| 5 ArcAid | In the ArcAid repo: Challenge type for Castcade, signaling WebSocket, result storage with N signatures, subscription gate for hosting. In Castcade: ArcAid sign-in and Challenge pickup | A Challenge created in ArcAid runs end to end and its result appears on the Challenge scoreboard; beta with one community |

Phase 0 runs first and alone: if the VPX 10.8 plugin API cannot read PinMAME RAM and block flipper input, the design changes before anything else is built. Phases 1 and 2 are Linux-testable and can overlap with 0. Phase 4 can start any time after 1, since arcade mode does not depend on the plugin.

## Work split: Linux CI versus a Windows PC

Roughly 60 percent of v1 by code volume can be written and tested on Linux with no emulator present; the remainder is the VPX plugin, window capture, and the RetroArch launch path, which need a Windows PC with VPX, VPinMAME, RetroArch and the owner's ROMs. Where the table says "here", read Linux CI; where it says "your PC", read that Windows machine.

| Piece | Build here | Needs your PC | Why |
| --- | --- | --- | --- |
| Relay server (lobby, hashes, grants, signing, match log, ArcAid webhook) | Yes, fully, with a test suite that simulates two clients | No | Pure network code; runs in Linux |
| Protocol spec and JSON schemas | Yes | No | Shared contract both sides build against |
| Fake client (a scripted player that sends STATE and BALL\_END) | Yes | No | Lets the relay and companion be tested with no VPX at all |
| Companion app UI, overlay, WebRTC signaling | Yes, most of it | Window capture and the hardware encoder need Windows to test | Electron or .NET runs here for logic; capture does not |
| VPX plugin skeleton (loads, registers for PinMAME messages, logs) | Draft here against the SDK headers from the vpinball repo | Compile and run there | No VPX in this environment |
| RAM map for the first ROM family | Draft from known WPC offsets | Verify there | Reads must be checked against a running ROM |
| Ball-end detector logic | Yes, as a pure function with recorded event logs as test input | Record the logs there | Once you capture one session's switch and RAM log, the detector is testable here |

The practical loop: build the protocol, host mode and fake client first, so by the time the plugin compiles on Windows there is already a working match to connect it to. When the plugin runs on a real table and captures a session log, commit the log under `rommaps/fixtures/` and tune the detector against it in CI.

One repo for all of it: `companion/`, `protocol/`, `fakeclient/` and `arcade/` run their tests on Linux; `plugin-vpx/` is a CMake project opened in Visual Studio.

## Open questions to verify first

Each of these can flip a design choice, so they are the week-one checklist, in order.

- [ ] Does the VPX 10.8 plugin API expose PinMAME memory reads to a plugin, or only lamps, solenoids and DMD frames? If reads are missing, the plugin links `libpinmame` directly or reads NVRAM from disk instead, which is slower but workable.
- [ ] Can a plugin intercept keyboard and cabinet input before the table script sees it? If not, the lock has to be done at the script layer with a small `.vbs` shim the lobby injects, or by the companion app at the OS input level.
- [ ] Which RAM offsets hold `current player` and `ball in play` for WPC, Sys11 and SAM. PINemHi's NVRAM parsers are the starting reference; confirm on Medieval Madness, Attack from Mars, Twilight Zone, Monster Bash and one SAM title.
- [ ] Which VPX plugin SDK header files are GPLv3+ versus still under the old non-commercial license. Vendor only the GPLv3+ ones into `plugin-vpx/`; if a needed header is not, link dynamically and do not vendor it.
- [ ] RetroArch's UDP command interface: confirm the exact memory read command name and address format in the current release, and that it works while netplay is active on both host and client.
- [ ] FBNeo netplay on current RetroArch for the first ten target ROMs (Galaga, Donkey Kong, Pac-Man, Ms. Pac-Man, Dig Dug, Frogger, Centipede, TMNT, The Simpsons, Street Fighter II): verify a 4-client session is stable for 15 minutes.
- [ ] Is VPX Duo's modified VPinMAME64.dll published anywhere with source? If so, its save-state work is a head start on v2 and worth reading before writing any of it.
- [ ] Does the launch community run cabinets, desktops or VR? That decides whether the spectator panel goes on a backglass monitor, a desktop window or a VR room panel first.

Sources: [VPX Duo demo thread on VPForums](https://www.vpforums.org/index.php?showtopic=58028), [VPX online mode discussion](https://www.vpforums.org/index.php?showtopic=47757), [VPUniverse league rules](https://vpuniverse.com/league_games/), [VPX Launcher on VPUniverse](https://vpuniverse.com/files/file/20108-vpx-launcher-64bit/), [RetroArch netplay developer notes](https://docs-test-retroa.readthedocs.io/en/latest/development/retroarch/netplay/), [FBNeo core features](https://wiki.recalbox.com/en/emulators/arcade/final-burn-neo/libretro-fbneo), [Visual Pinball license text](https://repo.retrodeck.net/Xargon/RetroDECK/src/branch/main/other_licenses.txt), [PinMAME license](https://www.nuget.org/packages/PinMame/0.0.3/License). Numbers for bitrate, latency and phase lengths are engineering estimates, not measurements.
