# Castcade — Work

Board: https://claude.ai/artifact/2AsfpUMPfRB1yQhnirHQKd  ·  Rules: `.claude/commands/work.md`  ·  Check: `npm run work:check`

One line per item, IDs never reused. History: `CHANGELOG.md` and `git log -- WORK.md`. Design and rulings:
`docs/design/`, `docs/decisions/`. Pick an item with `/work <ID>`; end a session with `/wrap`.

## Now

- Companion 0.2.21 is the installed release; **0.2.22 is built on `main` (2026-10-30), untagged** until the rig checks below pass, then `/release-docs 0.2.22`. New in it: the Stream tab with Preview and health (D1.5), Sanctioned recordings kept until the tournament closes (D1.7, needs ArcAid F16 to serve `tournament`), the Start attempts button and the "not started" state (B21), the served ROM map (B8), the platform-wide supported-games list (B14, `docs/witness-games.md`), the ffmpeg GPL source offer and release assets (E5), and host transfer + reconnect over WebSocket with protocol 2 (H3, A2, A3; engine only, no app wiring: A6).
- Rig checks owed on 0.2.22: D1.5.1 (Stream tab, Preview, health), B21.1 (Start attempts against arcaid.app, ROM map log line), plus the 0.2.21 ones still open: D1.4 (overlay legible at 720p30), B17 (restart with VPX open), B18 (start mid-game), B15.1 (hook bump re-makes every patch), C10.1 (Krobs' saved table).
- Decisions made without the owner on 2026-10-30 (revert if wrong): protocol version 2 (new `RECONNECT` messages; v1 peers refused); no microphone control until a capture path exists; the OBS overlay card lives on the Stream page; the GPL offer points at GitHub issues, not an email, and the source-upload step never blocks a release; `docs/witness-games.*` are committed outputs; verified = a `fixtures/nvram/<rom>` folder; the ROM map cache sits in `witness\roms.json`.
- Owner actions: update the rig and testers to 0.2.21 · void Krobs' three `start not reported` Tron attempts on Arcaid Witness Demo (B19) · void Krobs' `unreported` Walking Dead attempt on Hoser Haven if promised · re-pair the rig from Settings · B9 field gate · record an extra-ball session on a mapped table for C2.2 · B14.1: one Taito and one Bally 35 game decide whether the list or B10.2 is right.
- ArcAid side owed: F15 (ROM fallback on the start call, Krobs' Tron), F16 (`tournament` on the score answer for D1.7), F12 (blessed fingerprint UI), F13 (Limited-attempts list seeded from B14's JSON).
- Multiplayer stream URL (D5, owner request 2026-10-26; Krobs keen) needs D2 and D3; ADR 0007 leans to both an ArcAid watch page and a Twitch push.
- Cabinet SAM and the AMH ScoreServer gap are ArcAid W46 / W47 / W48; the desktop check is C1.1.1 (needs recipes D/E).
- Next by priority: the rig checks, then release 0.2.22; E6 (stop ffmpeg on an update restart); C1.1 recipes B–E (the owner's Spooky TNA posts nothing); A6 / A7 only when Phase 5 starts. B5 waits on ArcAid item 12 (F5).
- Watching: C9 (four arrivals per score, 2026-10-22), no recurrence since request logging.
- Last wrap: 2026-10-30 (second) — A2, A3, B8, B14, B21, D1.5, D1.7, E5, H3 done on main as 0.2.22 (untagged); F8, F14 mirrored done; new A6, A7, B8.1, B14.1, B14.2, B21.1, D1.5.1, D1.7.1, E5.1, E6, F16.

## A. Protocol and match engine

Lane: `protocol/**`, `companion/src/match/**`, `fakeclient/**`. Phase 1 shipped 2026-10-18 (gate passed, CI green); these are the gaps it carried.

- **A1** `done 0.1.0` Phase 1: v1 schemas, host arbiter, client, hash-chained log, Ed25519 keys, in-memory + WebSocket transports, fakeclient gate test
- **A2** `done 0.2.22` Host transfer over WebSocket — `HOST_TRANSFER.newHostEndpoint`, `WsPeerTransport`, protocol 2; gate `fakeclient/src/ws-transfer.test.ts`
- **A3** `done 0.2.22` Client reconnect after a drop — `RECONNECT` / `RECONNECT_ACK` resume from the log head, signed; gate `fakeclient/src/ws-reconnect.test.ts` · needs: A2
- **A4** `idea` Simultaneous mode — exists in the schemas, never exercised; needs a fakeclient scenario before it is called supported
- **A5** `blocked F6` Post a signed RESULT to ArcAid — waits on the ArcAid roster, relay and ingest (F6)
- **A6** `idea` Match transport in the app: the main process creates a `WsPeerTransport`, opens the listener, and learns the new host's endpoint (ArcAid signalling, F6); the fakeclient CLI (`host` / `join`) still uses the Phase 1 transports · needs: A2, F6
- **A7** `idea` Transfer / reconnect hardening left by A2–A3: no abort when a transfer never reaches a majority; no timeout on a socket waiting for `RECONNECT_ACK`; a client that reconnects to the old host does not follow a `HOST_TRANSFER` it missed; `host_left` over WS has no candidate endpoint; a bad-signature reconnect closes that player's other links · spec: protocol/docs/prose.md "Reconnect", commits 9b6da24 and 3772379

## B. Witness and fairness

Lane: `companion/src/witness/**`, `docs/design/fairness-and-table-identity.md`. Build order F1–F6 in that doc §7; integrity modes are ADR 0005.

- **B1** `done 0.2.4` F1 table identity: VPS game/table ids, file hash, save revision on every score; one-time picker; `tablesDir` setting
- **B2** `done 0.2.8` F2 attestation: ini, NVRAM adjustments, build hashes + family, VPinMAME cheat flag, accelerometer and tilt keys (0.2.5 → 0.2.8)
- **B3** `done 0.2.10` F3 companion half: `not_sanctioned` → rejected capture with reasons on Status; `play_device` (VR headset vs monitor) per session
- **B4** `done 0.2.14` F4 playfield fingerprint `pf1:<sha256>` on every score · spec: docs/design/fairness-and-table-identity.md §3
  - **B4.1** `done 0.2.20` Pin the record-tag list in a fixture so a VPX rename fails a test, not a tournament — `fixtures/playfield/tags.json`, `npm run playfield-tags -w companion`
  - **B4.2** `ready` Field gate for F4: the owner launches Monster Bash twice (the log line `witness: playfield pf1:…` is the same both times), then moves a flipper in the VPX editor, saves, launches again: the line changes. A byte-patched copy passed both halves on 2026-10-25 · owner: owner · gate: this line
- **B5** `blocked F5` F5 script diff, companion half — baseline download, normalise, classify, preflight verdict, diff report · needs: B4 · spec: docs/design/fairness-and-table-identity.md §4 · touches: ArcAid item 12 (F5)
  - **B5.1** `done 0.2.14` Engine: normalise, Myers diff, classify allowed / restricted / unknown, capped `script_diff` report (`script-diff.ts`)
  - **B5.2** `done 0.2.14` Which script ran vs the embedded one, sent as `script_diff` (flag only)
  - **B5.3** `blocked F5` Runner baseline download + preflight verdict before ball one — waits on ArcAid item 12 (upload, `GET /api/witness/preflight`, `script_diff` ingest) · needs: B5.1
  - **B5.4** `idea` Shared includes (`core.vbs`, `VPMKeys.vbs`, controller files) hashed against the VPX 10.8.0 release copies — needs a trusted hash list first
- **B6** `done 0.2.12` F6 engine attestation from the live hook (hook 0.4.0 `engine` line at hook time + every key-down; on the score as `engine`; in-game change named in the capture) · spec: docs/design/fairness-and-table-identity.md §5
  - **B6.1** `done 0.2.13` Score plausibility from the live journal → `score_plausibility` (largest jump, off-step flag; flag only, never a gate) · spec: docs/arcaid-side-changes.md §15
  - **B6.2** `done 0.2.13` [BUG] Live difficulty read 100× too big (VPX `GlobalDifficulty` is 0–100); the detector divides by 100
- **B7** `ready` Nudge telemetry: HID trace + lift detector, `nudge` param on the score · spec: docs/design/fairness-and-table-identity.md §5a
- **B8** `done 0.2.22` ROM→VPS game map served by ArcAid (`GET /api/witness/roms`, W12), cached in `witness/roms.json`, the shipped seed as the fallback (`witness/rom-map.ts`)
  - **B8.1** `idea` Send the served map's `globalGameId` with the start and score calls, and count ROMs in the seed log line

- **B9** `ready` Field gate for F1–F2's live half: the owner flips a physics override on and off and the ini values show in the Integrity panel on arcaid.app (2.166.0) · owner: owner · gate: docs/design/fairness-and-table-identity.md §7 "Gate for F1–F2"
- **B10** `ready` Machines whose live fields sit in CPU RAM, outside the NVRAM `ChangedNVRAM` reports: Stern SAM, Gottlieb System 1 / 80 / 80B, Bally 17/35, Stern M100/M200, Williams System 4–7, Atari. Tester Krobs: AC/DC, Walking Dead, Haunted House (System 80) never posted, 2026-10-25. Route per family: an NVRAM-only detector where NVRAM holds the scores and some end signal, else a live-memory producer (VPX plugin, ADR 0001)
  - **B10.1** `done 0.2.16` Stern SAM from NVRAM alone: start = scores reset to 0, end = the last-game record's counter 16 bytes before player 1's score (+1 per player), no ball events; watch-list offsets count from the platform's NVRAM start (recipe 0.3.1). Fixtures `acd_170h/2026-10-25-1`, `twd_160h/2026-10-26-1`. Gate passed 2026-10-26: Krobs' AC/DC and Walking Dead post live at game end to both rooms; on the rig a 90 s plunge-and-drain TWD game posts at game over and a game quit on ball 1 posts as abandoned · touches: ArcAid W46, W47 (the AtGames cabinet side)
  - **B10.2** `idea` Bally 17/35, Stern M100, Taito, Zaccaria (~220 corpus ROMs): scores are in NVRAM, game over is not; find an end signal from one rig recording each, as B10.1 did
  - **B10.3** `idea` Gottlieb System 1 / 80 / 80B, Stern M200, Williams System 4–7, Atari gen 1 (Haunted House): scores are in CPU RAM too; needs the live-memory producer
- **B12** `done 0.2.17` Import and Status refuse to call a table witness-ready unless its machine's live score can be read (`liveSupport`: scores, game over, current ball and current player in NVRAM, or Stern SAM's end-of-game record); 84 of the rig's 140 tables qualify
  - **B12.1** `done 0.2.18` "Patch my tables" removes Castcade's own patch from tables whose live score can't be read
- **B13** `ready` Platform verification pass before the platform list ships: one real game per platform family (Whitestar, Data East, System 11, Gottlieb System 80 / 80B / 3, Bally 35, Stern M100/M200; only WPC is verified). A Gottlieb table failed for Krobs with a complete map: cause unknown, needs his table name and journal. Doctor Who's slow second post (2026-10-25) was the third table loaded in one editor session on 0.2.15: no live mode, posted from the `.nv` at close with no attempt key (prod `attempts` "unreported"), the bug 0.2.16 fixed · owner: owner
- **B14** `done 0.2.22` Platform-wide list of witness-supported games: `npm run witness-games -w companion` → `docs/witness-games.md` + `.json` (2365 games: 13 verified, 297 supported) · needs: B12
  - **B14.1** `ready` [CHECK] The list calls all 66 Taito games and Bally 35's game over readable from NVRAM, which contradicts B10.2's premise (no game-over signal there); one real Taito game and one Bally 35 game on the rig decide which is right before F13 trusts the list (part of B13) · owner: owner · spec: docs/witness-games.md
  - **B14.2** `idea` List shape follow-ups: per-table rows (a table on an unlisted ROM revision can differ from its game's row), verified limited to the original machine (originals that reuse a verified ROM count today), a compact JSON for ArcAid (1 MB today, mostly per-ROM `live` objects)

- **B15** `done 0.2.17` [BUG] A table opened while the patches were still being re-made after an update ran its old patch (Krobs, Walking Dead, 2026-10-26): re-makes keep an unchanged table's hash (2 ms a table on the rig, was 211 ms); a table loaded with an older recipe asks the player to reopen it
  - **B15.1** `ready` Field check at the next recipe bump: the update re-makes the rig's 140 patches in seconds, and a table opened during it shows "reopen this table" on Status and a balloon · owner: owner · gate: this line
- **B16** `done 0.2.18` A game quit before game over posts and counts, marked as quit (companion half: `quit` / `quit_ball` on the score call; board mark is F14)
- **B11** `done 0.2.11` Limited attempts, companion half (ArcAid ADR 0029 / A16): attempt call at every live-mode game start, `attempt=<key>` on the score, Status shows the answer
- **B17** `done 0.2.20` [BUG] A restart of Castcade while the same VPX process stays open re-posted that process's earlier games — posted game keys persist per journal (`posted-games.json`)
- **B18** `done 0.2.20` [BUG] Castcade started while the VPX player window was already up learned the table only when play ended — the table comes from the newest journal of the VPX process (`journal-scan.ts`), live mode arms at once
- **B19** `done 0.2.21` [BUG] The game-start report carried the VPS game resolved from the file name alone (Krobs' Tron: VPS's 2016 original, so ArcAid matched the start to nothing and the score landed as `unreported`) — the identity is pinned by the ROM at `table_loaded`; a file contradicting the only same-named game on manufacturer and year resolves to nothing
  - **B19.1** `ready` Field gate for B19: Krobs' next Tron game on 0.2.21 shows "Attempt n of 5" on Status and lands on the Arcaid Witness Demo board (void the three `start not reported` attempts first) · owner: owner · gate: this line
- **B20** `done 0.2.21` Status shows ArcAid's reason when a score lands on the Global Scoreboard instead of a board (`notCounted` on the score answer, ArcAid W27); an attempt refusal is no longer labelled "Sanctioned play"
- **B21** `done 0.2.22` "Start attempts" button on Status (`GET /api/witness/attempt-start`, ArcAid W45) and the "not started" state
  - **B21.1** `ready` Field gate for B21 on arcaid.app: play a start-required table before pressing → Status says "This table needs Start attempts"; press with the table open → "Start attempts pressed for <game>" and Sending to flips to "N OF M ATTEMPTS LEFT"; press again → "(already started)"; the next game counts; the log shows `witness: ROM map <hash> (<n> ROMs, served)` and `witness\roms.json` exists (B8) · owner: owner · gate: this line


## C. Table import, hook, detector, turn lock (Phase 3)

Lane: `vpx-hook/**`, `companion/src/patcher/**`, `fixtures/**`. ADR 0001 (script hook) and ADR 0004 (per-table import primary, `core.vbs` opt-in). Design: `docs/design/table-import-and-patching.md`.

- **C1** `done 0.2.11` Import-a-table pipeline (`companion/src/patcher/`): `.vpx` script extract (the CODE record), §4 classifier, sidecar render, manifest, library install, folder plan/apply/remove-all, stale guard; recipe A only — originals wait on C1.1
  - **C1.1** `ready` Recipes B (JPSalas original), C (Scorbit-anchored), D (ScoreServer), E (generic) — recipe A (VPM) shipped with C1; the classifier already tells the classes apart and the folder import skips them with the reason · spec: docs/design/table-import-and-patching.md §5 · note: owner's Spooky TNA (VPW 2.3, class B) game of ~1.5M posted nothing 2026-10-28 (an original leaves no NVRAM; basic mode skips it); recipe B is what makes it post
    - **C1.1.1** `blocked C1.1` [CHECK] America's Most Haunted (Spooky 2014, script-only original, no ROM) on the desktop Witness, once recipes D/E exist. ArcAid W48 (2.180.0, cabinet 1.0.6, 2026-10-26): the LU launcher's ScoreServer records for AMH never say game over (9 of 9 `shutdown`) and never write the last ball, so 27 cabinet scores in The Wizard Room missed the last ball and its bonus. If AMH's script never calls `SetGameState` at game over, recipe D sees no `game_end` and `table_exit` makes it `game_abandoned`. Today the import skips originals (C1.1), so nothing posts. Check: (1) the class the importer gives AMH; (2) whether its script signals game over (`SetGameState` or another anchor); (3) one real game posts the final display score, last-ball bonus included (Burner shows bonus added after the last ball entry); (4) two games in one sitting each get a `game_end`. The rig has no AMH (Krobs does); the rig's Spooky TNA classes B with no ScoreServer calls, so Spooky originals do not all share AMH's script base. Evidence: ArcAid `tmp/witness-build/10262026_vpx-americasmosthaunted-games.jsonl`, `10262026_witness (7).log` · needs: C1.1 · touches: ArcAid W48
  - **C1.2** `idea` Classification coverage check over the owner's 134 tables and a VPW/JPSalas-heavy collection
- **C2** `done 0.2.11` Journal tailer + detector in the companion (`journal-detector.ts`, `journal-tail.ts`); the three Phase 0 fixtures replay in vitest to what `fixtures/check.py` asserts; lands in 0.2.11
  - **C2.1** `done 0.2.11` Phase 0 findings absorbed: journal volume (hook 0.3.0 `Castcade_WatchBytes`: watched offsets only, coalesced per 50 ms, one snapshot at hook time — from 89 lines/s to a few per score change), boot-garbage gate and exit mid-game (detector C2); bonus-after-ball_end documented in `detectTransition`
  - **C2.2** `ready` Extra-ball fixture: ball-in-play and player unchanged, detector must not fire
- **C3** `ready` Turn lock + overlay, companion half — write the lock flag from the match engine's grant, the overlay, analog-plunger fallback (open case, spike §8 0c); the `_KeyDown` wrap itself shipped in hook 0.1.0 (Phase 0c pass 2026-10-17) · needs: C2
- **C4** `ready` Fill `HELLO`'s `GameFingerprint` from the import manifest — hash(original `.vpx`) + recipe version + sidecar hash; the fields exist since 0.1.0; readiness shared to ArcAid (item 8 = ArcAid W8.1, Phase 3) · needs: C1 · touches: F6
- **C5** `idea` Bulk mode: setup-wizard forced choice, `core.vbs` patch, self-heal, chaining guard — slips if Phase 3 runs long; not on the streaming path · needs: C1
- **C7** `done 0.2.11` Live mode: every game of a session posts its own score (sidecar journal + detector, folder import with dry run and remove-all, three-layer stale-sidecar guard, hook 0.3.0) · spec: docs/design/table-import-and-patching.md
  - **C7.1** `done 0.2.13` Recorded journal fixtures for the filtered-NVRAM hooks (0.3.0+)
    - **C7.1.1** `done 0.2.13` Hook-0.3.0 fixture `fixtures/nvram/mb_106b/2026-10-23-1`; boot-race fix (a ball or game end needs a seen `game_start`)
    - **C7.1.2** `done 0.2.13` Hook-0.4.0 fixture `fixtures/nvram/mm_109c/2026-10-25-1` (found B6.2)
- **C8** `done 0.2.12` Import UX, second pass: one-click "Patch my tables" with progress and banners, VPX exe remembered across runs + `scripts` beside the tables folder as the fallback, desktop notification + Status line when a table opens unpatched
- **C9** `ready` [OBSERVE] Four arrivals per score at ArcAid on 2026-10-22 session 1 (hook 0.2.0, PC stalled by the 89 lines/s journal; ArcAid W14 done 2.167.1 — repeats inside 120 s now answer `ingested`, per-device serialized) — unexplained on the companion side: the code, the Node probe and the request log send ONE GET per capture, and the three sessions since the log landed (0.2.11, six games) show one `arcaid: #seq` per score with no repeat; keep until a recurrence: on one, the log's `#seq` lines say whether the companion sent them, and `tasklist` whether two companions ran (installed + unpacked) · spec: this line
- **C6** `done 2026-10-17` Same-basename sidecar auto-loads on 10.8.0 Windows without a prompt — Phase 0e PASS on TFTC, MM, Iron Maiden; sidecar is the default install path, `importvbs` copy stays C1's fallback
- **C10** `done 0.2.20` [BUG] Saving a patched table in the VPX editor copied Castcade's patch into the table's own script (Krobs, 2026-10-29): the stale guard fired at every launch and the import refused the table — hook 0.4.1 is silent without its sidecar and journals `embedded_patch`; the importer and the folder watch patch the script underneath; live mode arms, one balloon, a fresh `.vbs` · spec: docs/design/table-import-and-patching.md §6
  - **C10.1** `ready` Field gate for C10: Krobs opens the saved table on 0.2.21: no dialog, one balloon, a fresh `.vbs` beside the table, the game posts · owner: owner · gate: this line

## D. Media: streaming, recording, voice

Lane: `companion/src/media/**`. Phase 4a (solo) needs nothing from Phase 3; Phase 4 (match spectating, voice, runner stage) waits for real players in the match engine.

- **D1** `ready` Phase 4a solo streaming + recording: VPX window capture, NVENC/AMF/QSV encode (Phase 0d path), score/ball/Witness overlay, direct RTMP to Twitch/YouTube with the player's own key (`safeStorage`, never sent to ArcAid), local MP4 · spec: docs/design/solo-streaming-and-recording.md (owner rulings 2026-10-25: architecture A, ffmpeg bundled, 720p30 default, keep 3 sessions + Sanctioned, mic off) · gate: docs/design/solo-streaming-and-recording.md §1
  - **D1.0** `done 2026-10-27` Spike on the owner's rig: crop, rotation, F11 cost (none at 720p30), live Twitch push, 1080p, the bundled ffmpeg · spec: docs/design/solo-streaming-and-recording.md §5
  - **D1.1** `done 0.2.18` OBS overlay page on 127.0.0.1 (Settings → OBS overlay)
  - **D1.2** `done 0.2.19` Local recording: MP4 per session, game markers, hash-chained manifest tied to posted scores, retention
  - **D1.3** `done 0.2.19` Streaming to Twitch / YouTube from the app: key in `safeStorage`, presets, reconnect, a session outlives one table (slate between tables)
  - **D1.4** `done 0.2.20` Overlay burned into stream and recording — the D1.1 state as text, drawn by ffmpeg `drawtext` `reload=1`; Stream setting to turn it off
  - **D1.5** `done 0.2.22` Stream page: `Stream` tab with Preview (bundled ffplay on the engine's own picture), health table, folder / cap / volume / delay settings; OBS card moved here · needs: D1.2, D1.3
    - **D1.5.1** `ready` Field gate for D1.5 on the rig: the Stream tab shows and Settings lost its Stream / OBS cards; with a table up, Preview opens ffplay on the other monitor with the stream's framing (vertical, rotate 90, overlay text); shape / rotate / shift / quality / overlay changes redraw it within a second; Q or X closes it; no table → "Start a table in VPX first"; preview during a capture works, Stop closes it, tray Quit leaves no ffplay.exe; the health table fills during a capture; folder Choose… / Use default; ffplay placement on a DPI-scaled display · owner: owner · gate: this line

  - **D1.6** `done 0.2.19` Bundle ffmpeg: pinned GPL build + sha256, `fetch-ffmpeg` at package time, extra resource in the installer
  - **D1.7** `done 0.2.22` A Sanctioned recording is kept until its tournament closes, from the score answer's `tournament` object (§18; served by F16) · needs: D1.2
    - **D1.7.1** `idea` A score that posts later from the offline queue may not carry its `tournament` into the manifest (the capture is noted once); `landed[]` rows are not parsed, so a play whose first landing is Open and a later one Sanctioned is not kept · needs: F16

  - **D1.8** `done 0.2.19` Stop ffmpeg cleanly instead of killing it (grab → mux split; a stop no longer loses the last second)
  - **D1.9** `done 0.2.19` Never stream the desktop: cover the picture whenever VPX is not the foreground window
- **D2** `idea` Phase 4 match streaming: WebRTC through the host, Opus mesh, push-to-talk, DMD + STATE overlay, upload test, STUN + optional TURN · needs: A2, D1
- **D3** `idea` Castcade watch link: any live player's feed in a browser, ArcAid signalling only · needs: D2
- **D4** `idea` Runner stage, companion half (ArcAid item 13 is the other half) · needs: D3
- **D5** `idea` A multiplayer Castcade match (Throwdown, `play_mode='castcade'`) has one stream URL so the whole session can be streamed live: the player up's table, every player's score, whose turn it is and the voice mix, shown as one feed. Open: viewers watch on an ArcAid page fed by the host (D3's link, one per match), a Twitch / YouTube push of the host's composite (D1.3's ingest), or both (ADR 0007 leans both); where the URL appears (the Throwdown page, the lobby) · needs: D2, D3 · touches: ArcAid Throwdown page (owner request 2026-10-26)
- **D6** `idea` Guided setup for streaming and matches (ADR 0007): a check per required step that names the fix: `VRPreview` on with its window 1280x720 or larger for VR players (read `[PlayerVR] PreviewWidth / PreviewHeight` from the ini), upload bandwidth for the chosen preset, whether the host is reachable (STUN, then TURN, then which router port to open); a named microphone picker (D1.5 built no microphone path; the Windows default is often a virtual device, design doc §5) · spec: docs/decisions/0007-functionality-before-ease-of-setup.md · needs: D1.0

## E. Shell, updater, packaging, release

Lane: `companion/src/main/**`, `companion/src/preload/**`, `companion/renderer/**`, `companion/electron-builder.yml`, `companion/scripts/**`, `.github/workflows/release.yml`.

- **E1** `done 0.2.13` Phase 2 gate, half 2: a tester's clean-machine install from the tester kit posts a badged score (Krobs, 2026-10-25)
- **E2** `parked` Code signing — deferred until GA by owner ruling 2026-10-18
- **E3** `done 0.2.6` Updater re-checks every 4 h (30 min after a failure); repo made public so the releases feed answers
- **E4** `done 0.2.11` Electron 44 / Vite 8 / vitest 5 follow-through: 0.2.11 is the first packaged build on them (`pack:dir` + `--smoke` green on the owner's rig)
  - **E4.1** `done 0.2.11` The updater installed 0.2.11 on the owner's rig (log 2026-10-23T05:32Z: downloaded, installed on quit) and the next session posted four games live
- **E5** `done 0.2.22` GPL Corresponding Source for the bundled ffmpeg: written offer (`docs/ffmpeg-source.md`, `SOURCE-OFFER.txt` beside ffmpeg.exe) + `ffmpeg-source` release assets · needs: D1.6
  - **E5.1** `idea` Stronger Corresponding Source: mirror each statically linked library's tarball at the README's version and Gyan's build scripts with the release, instead of "upstream at that version"
- **E6** `ready` [BUG] The updater's `quitAndInstall` path never calls `stream.stop()`: a running capture's ffmpeg pair may be orphaned on an update restart (the preview is covered by the process exit hook, D1.5) · spec: companion/src/main/updater.ts, stream-host.ts


## F. ArcAid side

Lane: none here. The work lands in `C:\code\repos\ArcAid` and is tracked in that repo's `WORK.md` (section W); this section mirrors the hand-off list so the two stay in step. Spec for every item: `docs/arcaid-side-changes.md`.

- **F1** `done 2.163.0` Item 1: desktop device type on `witness_devices` (ArcAid #363)
- **F2** `done 2.163.0` Item 9: desktop-witness plan amended (ArcAid #364)
- **F3** `done 2.166.0` Item 11: integrity mode, VPS-id matching, required table, evidence, admin UI, VR badge (ArcAid #370, #371; ArcAid ADR 0027)
- **F4** `ready` Item 10: room admin's live device view
- **F5** `ready` Item 12: script baseline, diff reports, preflight endpoint · needs: B5
- **F6** `ready` Items 2–7: `play_mode`, roster, `match:<id>` relay, `castcade_matches` + public keys, RESULT ingest with N signatures, ADR (Phase 5); item 8 table-readiness registry is Phase 3 and needed by C4 (ArcAid W8.1, which needs ArcAid C1)
- **F7** `ready` Item 13: runner stage · needs: D3
- **F8** `done 2.193.0` Item 11, the part left out of 2.166.0: ROM→VPS game map `GET /api/witness/roms` seeded from VPS, so B8 can stop shipping the seed (ArcAid W12, PR #411; contract in ArcAid docs/vpx-desktop-witness-plan.md §4) · spec: docs/arcaid-side-changes.md §11
- **F9** `done 2026-10-23` Item 14: ArcAid reads `engine` on the score, Sanctioned rule `engine`, live tilt preferred, Integrity panel "In the game" (ArcAid 2.168.0, PR #377, merged by the owner)
- **F10** `done 2.170.0` [BUG] ArcAid reads `engine.difficulty` > 1 as a percentage (÷100): 0.2.12 sends VPX's 0–100 number (B6.2), so the Sanctioned `engine` rule fails every 0.2.12 score ("differs from the table's 50%") and the Integrity panel shows 5000%; installed 0.2.12 companions keep sending it until they update. Two stored rows already carry 50 (Medieval Madness 16814490 and 19643660, 2026-10-25). · pr: https://github.com/mekelburgj20/ArcAid/pull/379 (ArcAid W40/W41, 2.170.0) · spec: docs/arcaid-side-changes.md §14 (Correction)
- **F11** `done 2.170.0` Item 15: ArcAid reads `score_plausibility` (B6.1), stores it with the evidence and shows it on the Integrity panel; flag only, never a gate · pr: https://github.com/mekelburgj20/ArcAid/pull/379 (ArcAid W40/W41, 2.170.0) · spec: docs/arcaid-side-changes.md §15
- **F12** `ready` ArcAid admin UI for the blessed playfield fingerprint: `required_fingerprint` is stored and compared since 2.166.0 and settable through `PATCH` on the integrity route, but the tournament form has no field and no "bless the one I just played" button (§11 runner review); the companion sends `fingerprint` from 0.2.14 · spec: docs/arcaid-side-changes.md §11 "Runner review"
- **F13** `idea` One curated platform-wide list of games allowed in Limited attempts (owner ruling 2026-10-25: one list for the whole platform), seeded from B14, owner approves entries on an admin page; with `max_attempts` set the game picker offers only listed games and the server refuses others; shares data with F8 · needs: B14
- **F14** `done 2.189.0` Item 16: read `quit` / `quit_ball` on the score call and mark a quit game on the board and the Integrity panel ("quit on ball 2"); badge, never gate (ArcAid W49, PR #407) · spec: docs/arcaid-side-changes.md §16 · needs: B16
- **F15** `ready` Item 17: when the `vps_game` on a start or score call names a catalogue game that matches no open game, try the ROM's catalogue game before the name fallback (today the ROM is consulted only when the VPS id is unknown to the catalogue); and answer the start call with the miss reason, as the score call does. Would have saved Krobs' three Tron attempts (B19) · spec: docs/arcaid-side-changes.md §17
- **F16** `ready` Item 18: the score answer names the tournament that took the play (`tournament: { id, name, integrity_mode, closes_at }`), so the companion can keep a Sanctioned recording until that tournament closes (D1.7's companion half reads it from 0.2.22) · spec: docs/arcaid-side-changes.md §18 · needs: D1.7

## G. Arcade (Phase 6)

Lane: `arcade/**`. Needs no VPX; can overlap with anything.

- **G1** `idea` Import-a-ROM: hash, core allowlist, memory map (RetroAchievements seed), verification read via RetroArch UDP, registry
- **G2** `idea` Launch profiles + poller; gate: 4-player Galaga match, all four scores captured · needs: G1
- **G3** `idea` Confirm RetroArch UDP `READ_CORE_MEMORY` during netplay on the current release; FBNeo 4-client stability

## H. Docs, process, CI

Lane: `docs/**`, `.claude/**`, `WORK.md`, `CHANGELOG.md`, `tools/**`, `.github/workflows/ci.yml`.

- **H1** `done` Single work tracker + board + `/work` and `/wrap` (ADR 0006), 2026-10-21
- **H2** `done 0.2.20` `CHANGELOG.md` back-fill detail for 0.2.0–0.2.3 from the release notes on GitHub
- **H3** `done 0.2.22` Protocol prose for host transfer over WebSocket and reconnect (`protocol/docs/prose.md`), 2026-10-30
