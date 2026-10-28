# Castcade — Work

Board: https://claude.ai/artifact/2AsfpUMPfRB1yQhnirHQKd  ·  Rules: `.claude/commands/work.md`  ·  Check: `npm run work:check`

One line per item, IDs never reused. History: `CHANGELOG.md` and `git log -- WORK.md`. Design and rulings:
`docs/design/`, `docs/decisions/`. Pick an item with `/work <ID>`; end a session with `/wrap`.

## Now

- Companion 0.2.18 (unsigned PoC; repo public, keep it so): live mode, one-click table import, engine attestation, score plausibility flag, limited attempts, playfield fingerprint and script inspection on every score. Stern SAM tables post from NVRAM alone (B10.1, 0.2.16); 0.2.17 patches only machines whose live score can be read (B12; 84 of the rig's 140 tables) and re-makes patches fast after an update (B15). 0.2.18 adds the OBS overlay (D1.1), the quit marker on the score call (B16; the board half is F14) and unpatches unreadable tables (B12.1).
- In flight: D1.6 bundle ffmpeg (claude; built, ran on the rig, ships in the next release). D1.0 2026-10-27: live on Twitch from cabinet-mode VPX with no measurable frame cost; two of three runs lost the capture mid-run (cause pending from the owner; D1.3 restarts it either way).
- New ruling 2026-10-27, ADR 0007: functionality before ease of setup; automate or guide every setup step (D6) and promise testers "guided setup", never "no setup".
- Owner actions: update the rig and testers to 0.2.18 · void Krobs' `unreported` Walking Dead attempt on Hoser Haven if promised (prod `attempts` row 6) · B15.1 at the next recipe bump · re-pair the rig from Settings · B9 field gate.
- Multiplayer stream URL (D5, owner request 2026-10-26; Krobs keen) needs D2 and D3; ADR 0007 leans to both an ArcAid watch page and a Twitch push.
- Cabinet SAM and the AMH ScoreServer gap are ArcAid W46 / W47 / W48; the desktop check is C1.1.1 (needs recipes D/E).
- Next by priority: D1 solo streaming (after D1.0), then B14 / F13 for the Limited-attempts list. B5 waits on ArcAid item 12 (F5). Small and unblocked: B4.1, C2.2.
- Watching: C9 (four arrivals per score, 2026-10-22), no recurrence since request logging.
- Last wrap: 2026-10-27 — B12, B15 done 0.2.17 (released); B10 back to ready (B10.1 done); D1.1 built; B12.1, B15.1, B16, C1.1.1, D5, D6 added; ADR 0007.

## A. Protocol and match engine

Lane: `protocol/**`, `companion/src/match/**`, `fakeclient/**`. Phase 1 shipped 2026-10-18 (gate passed, CI green); these are the gaps it carried.

- **A1** `done 0.1.0` Phase 1: v1 schemas, host arbiter, client, hash-chained log, Ed25519 keys, in-memory + WebSocket transports, fakeclient gate test
- **A2** `ready` Host transfer over WebSocket — clients must reconnect to the new host today · spec: protocol/docs/prose.md · gate: fakeclient scenario with a forced transfer over WS
- **A3** `ready` Client reconnect after a drop — resume from the log hash, not a fresh HELLO · needs: A2
- **A4** `idea` Simultaneous mode — exists in the schemas, never exercised; needs a fakeclient scenario before it is called supported
- **A5** `blocked F6` Post a signed RESULT to ArcAid — waits on the ArcAid roster, relay and ingest (F6)

## B. Witness and fairness

Lane: `companion/src/witness/**`, `docs/design/fairness-and-table-identity.md`. Build order F1–F6 in that doc §7; integrity modes are ADR 0005.

- **B1** `done 0.2.4` F1 table identity: VPS game/table ids, file hash, save revision on every score; one-time picker; `tablesDir` setting
- **B2** `done 0.2.8` F2 attestation: ini, NVRAM adjustments, build hashes + family, VPinMAME cheat flag, accelerometer and tilt keys (0.2.5 → 0.2.8)
- **B3** `done 0.2.10` F3 companion half: `not_sanctioned` → rejected capture with reasons on Status; `play_device` (VR headset vs monitor) per session
- **B4** `done 0.2.14` F4 playfield fingerprint `pf1:<sha256>` on every score · spec: docs/design/fairness-and-table-identity.md §3
  - **B4.1** `ready` Pin the record-tag list in a fixture so a VPX rename fails a test, not a tournament · spec: docs/design/fairness-and-table-identity.md §8
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
- **B8** `idea` ROM→VPS game map served by ArcAid with a shipped seed — today shipped only, from the vps-db index built at package time (`fetch-vps.mjs`); the server half is F8 · spec: docs/design/fairness-and-table-identity.md §8 · needs: F8
- **B9** `ready` Field gate for F1–F2's live half: the owner flips a physics override on and off and the ini values show in the Integrity panel on arcaid.app (2.166.0) · owner: owner · gate: docs/design/fairness-and-table-identity.md §7 "Gate for F1–F2"
- **B10** `ready` Machines whose live fields sit in CPU RAM, outside the NVRAM `ChangedNVRAM` reports: Stern SAM, Gottlieb System 1 / 80 / 80B, Bally 17/35, Stern M100/M200, Williams System 4–7, Atari. Tester Krobs: AC/DC, Walking Dead, Haunted House (System 80) never posted, 2026-10-25. Route per family: an NVRAM-only detector where NVRAM holds the scores and some end signal, else a live-memory producer (VPX plugin, ADR 0001)
  - **B10.1** `done 0.2.16` Stern SAM from NVRAM alone: start = scores reset to 0, end = the last-game record's counter 16 bytes before player 1's score (+1 per player), no ball events; watch-list offsets count from the platform's NVRAM start (recipe 0.3.1). Fixtures `acd_170h/2026-10-25-1`, `twd_160h/2026-10-26-1`. Gate passed 2026-10-26: Krobs' AC/DC and Walking Dead post live at game end to both rooms; on the rig a 90 s plunge-and-drain TWD game posts at game over and a game quit on ball 1 posts as abandoned · touches: ArcAid W46, W47 (the AtGames cabinet side)
  - **B10.2** `idea` Bally 17/35, Stern M100, Taito, Zaccaria (~220 corpus ROMs): scores are in NVRAM, game over is not; find an end signal from one rig recording each, as B10.1 did
  - **B10.3** `idea` Gottlieb System 1 / 80 / 80B, Stern M200, Williams System 4–7, Atari gen 1 (Haunted House): scores are in CPU RAM too; needs the live-memory producer
- **B12** `done 0.2.17` Import and Status refuse to call a table witness-ready unless its machine's live score can be read (`liveSupport`: scores, game over, current ball and current player in NVRAM, or Stern SAM's end-of-game record); 84 of the rig's 140 tables qualify
  - **B12.1** `done 0.2.18` "Patch my tables" removes Castcade's own patch from tables whose live score can't be read
- **B13** `ready` Platform verification pass before the platform list ships: one real game per platform family (Whitestar, Data East, System 11, Gottlieb System 80 / 80B / 3, Bally 35, Stern M100/M200; only WPC is verified). A Gottlieb table failed for Krobs with a complete map: cause unknown, needs his table name and journal. Doctor Who's slow second post (2026-10-25) was the third table loaded in one editor session on 0.2.15: no live mode, posted from the `.nv` at close with no attempt key (prod `attempts` "unreported"), the bug 0.2.16 fixed · owner: owner
- **B14** `ready` Platform-wide list of witness-supported games: generator over the VPS index × maps corpus (ROM version families, full live fields, per table release), status verified / supported / unsupported with the reason; JSON for ArcAid plus a readable page for tournament directors · needs: B12
- **B15** `done 0.2.17` [BUG] A table opened while the patches were still being re-made after an update ran its old patch (Krobs, Walking Dead, 2026-10-26): re-makes keep an unchanged table's hash (2 ms a table on the rig, was 211 ms); a table loaded with an older recipe asks the player to reopen it
  - **B15.1** `ready` Field check at the next recipe bump: the update re-makes the rig's 140 patches in seconds, and a table opened during it shows "reopen this table" on Status and a balloon · owner: owner · gate: this line
- **B16** `done 0.2.18` A game quit before game over posts and counts, marked as quit (companion half: `quit` / `quit_ball` on the score call; board mark is F14)
- **B11** `done 0.2.11` Limited attempts, companion half (ArcAid ADR 0029 / A16): attempt call at every live-mode game start, `attempt=<key>` on the score, Status shows the answer

## C. Table import, hook, detector, turn lock (Phase 3)

Lane: `vpx-hook/**`, `companion/src/patcher/**`, `fixtures/**`. ADR 0001 (script hook) and ADR 0004 (per-table import primary, `core.vbs` opt-in). Design: `docs/design/table-import-and-patching.md`.

- **C1** `done 0.2.11` Import-a-table pipeline (`companion/src/patcher/`): `.vpx` script extract (the CODE record), §4 classifier, sidecar render, manifest, library install, folder plan/apply/remove-all, stale guard; recipe A only — originals wait on C1.1
  - **C1.1** `ready` Recipes B (JPSalas original), C (Scorbit-anchored), D (ScoreServer), E (generic) — recipe A (VPM) shipped with C1; the classifier already tells the classes apart and the folder import skips them with the reason · spec: docs/design/table-import-and-patching.md §5
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

## D. Media: streaming, recording, voice

Lane: `companion/src/media/**`. Phase 4a (solo) needs nothing from Phase 3; Phase 4 (match spectating, voice, runner stage) waits for real players in the match engine.

- **D1** `ready` Phase 4a solo streaming + recording: VPX window capture, NVENC/AMF/QSV encode (Phase 0d path), score/ball/Witness overlay, direct RTMP to Twitch/YouTube with the player's own key (`safeStorage`, never sent to ArcAid), local MP4 · spec: docs/design/solo-streaming-and-recording.md (owner rulings 2026-10-25: architecture A, ffmpeg bundled, 720p30 default, keep 3 sessions + Sanctioned, mic off) · gate: docs/design/solo-streaming-and-recording.md §1
  - **D1.0** `blocked owner` Spike on the owner's rig: crop, rotation, F11 cost, live Twitch push, 1080p, the bundled ffmpeg · spec: docs/design/solo-streaming-and-recording.md §5 · note: 2026-10-27 framing (cabinet mode, `--rotate 90`), F11 cost (none at 720p30; 1080p 350-420 vs ~450 fps) and a live Twitch push passed; the 1080p and `--bundled` runs both lost the capture mid-run (DXGI access lost, cause unknown); left: what happened on screen at that moment, or one more run with the new ffmpeg log
  - **D1.1** `done 0.2.18` OBS overlay page on 127.0.0.1 (Settings → OBS overlay)
  - **D1.2** `ready` Local recording: MP4 per session, game markers, hash-chained manifest tied to posted scores, retention (last N sessions, default 3; optional total cap, empty = unlimited; Sanctioned kept until the tournament closes) · needs: D1.0
  - **D1.3** `ready` Streaming to Twitch / YouTube: key in `safeStorage`, presets (720p30 default, 1080p30/60), reconnect, restart the capture when Desktop Duplication is lost (D1.0: twice in three runs), health · needs: D1.0
  - **D1.4** `ready` Overlay burned into stream and recording · needs: D1.1, D1.0
  - **D1.5** `ready` Stream page: go live, record, preview (owner ask 2026-10-27: the streamer sees and adjusts the framing before going live; the spike's `--preview` runs ffplay on the same filter chain, `ffplayPreviewArgs`; a Rotate setting beside it for VPX cabinet mode, `--rotate` in the spike, 90 on the owner's rig; later a default read from `BGSet` and the table's cabinet view), health, settings (quality, retention, microphone off by default) · needs: D1.2, D1.3
  - **D1.6** `claimed` Bundle ffmpeg: pinned GPL build + sha256, `fetch-ffmpeg` at package time (gitignored), extra resource in the installer · needs: D1.0 · owner: claude · since: 2026-10-27 · note: built on main (fetch-ffmpeg, Gyan essentials 8.1.1 sha256-pinned, `media/ffmpeg-path.ts`, smoke prints it; installer 114 → 168 MB); captured and encoded on the rig with `--bundled` 2026-10-27 until the same capture loss as the PATH build; left: ship in the next release
- **D2** `idea` Phase 4 match streaming: WebRTC through the host, Opus mesh, push-to-talk, DMD + STATE overlay, upload test, STUN + optional TURN · needs: A2, D1
- **D3** `idea` Castcade watch link: any live player's feed in a browser, ArcAid signalling only · needs: D2
- **D4** `idea` Runner stage, companion half (ArcAid item 13 is the other half) · needs: D3
- **D5** `idea` A multiplayer Castcade match (Throwdown, `play_mode='castcade'`) has one stream URL so the whole session can be streamed live: the player up's table, every player's score, whose turn it is and the voice mix, shown as one feed. Open: viewers watch on an ArcAid page fed by the host (D3's link, one per match), a Twitch / YouTube push of the host's composite (D1.3's ingest), or both (ADR 0007 leans both); where the URL appears (the Throwdown page, the lobby) · needs: D2, D3 · touches: ArcAid Throwdown page (owner request 2026-10-26)
- **D6** `idea` Guided setup for streaming and matches (ADR 0007): a check per required step that names the fix: `VRPreview` on with its window 1280x720 or larger for VR players, upload bandwidth for the chosen preset, whether the host is reachable (STUN, then TURN, then which router port to open) · spec: docs/decisions/0007-functionality-before-ease-of-setup.md · needs: D1.0

## E. Shell, updater, packaging, release

Lane: `companion/src/main/**`, `companion/src/preload/**`, `companion/renderer/**`, `companion/electron-builder.yml`, `companion/scripts/**`, `.github/workflows/release.yml`.

- **E1** `done 0.2.13` Phase 2 gate, half 2: a tester's clean-machine install from the tester kit posts a badged score (Krobs, 2026-10-25)
- **E2** `parked` Code signing — deferred until GA by owner ruling 2026-10-18
- **E3** `done 0.2.6` Updater re-checks every 4 h (30 min after a failure); repo made public so the releases feed answers
- **E4** `done 0.2.11` Electron 44 / Vite 8 / vitest 5 follow-through: 0.2.11 is the first packaged build on them (`pack:dir` + `--smoke` green on the owner's rig)
  - **E4.1** `done 0.2.11` The updater installed 0.2.11 on the owner's rig (log 2026-10-23T05:32Z: downloaded, installed on quit) and the next session posted four games live
- **E5** `ready` GPL source for the bundled ffmpeg before GA: publish the Corresponding Source of the shipped build (FFmpeg at the README's commit plus the static libraries) with each release, or a written offer, and name it in the installer's licence notes (GPLv3 §6) · spec: companion/scripts/fetch-ffmpeg.mjs · needs: D1.6

## F. ArcAid side

Lane: none here. The work lands in `C:\code\repos\ArcAid` and is tracked in that repo's `WORK.md` (section W); this section mirrors the hand-off list so the two stay in step. Spec for every item: `docs/arcaid-side-changes.md`.

- **F1** `done 2.163.0` Item 1: desktop device type on `witness_devices` (ArcAid #363)
- **F2** `done 2.163.0` Item 9: desktop-witness plan amended (ArcAid #364)
- **F3** `done 2.166.0` Item 11: integrity mode, VPS-id matching, required table, evidence, admin UI, VR badge (ArcAid #370, #371; ArcAid ADR 0027)
- **F4** `ready` Item 10: room admin's live device view
- **F5** `ready` Item 12: script baseline, diff reports, preflight endpoint · needs: B5
- **F6** `ready` Items 2–7: `play_mode`, roster, `match:<id>` relay, `castcade_matches` + public keys, RESULT ingest with N signatures, ADR (Phase 5); item 8 table-readiness registry is Phase 3 and needed by C4 (ArcAid W8.1, which needs ArcAid C1)
- **F7** `ready` Item 13: runner stage · needs: D3
- **F8** `idea` Item 11, the part left out of 2.166.0: ROM→VPS game map `GET /api/witness/roms` seeded from VPS, so B8 can stop shipping the seed (ArcAid W12) · spec: docs/arcaid-side-changes.md §11
- **F9** `done 2026-10-23` Item 14: ArcAid reads `engine` on the score, Sanctioned rule `engine`, live tilt preferred, Integrity panel "In the game" (ArcAid 2.168.0, PR #377, merged by the owner)
- **F10** `done 2.170.0` [BUG] ArcAid reads `engine.difficulty` > 1 as a percentage (÷100): 0.2.12 sends VPX's 0–100 number (B6.2), so the Sanctioned `engine` rule fails every 0.2.12 score ("differs from the table's 50%") and the Integrity panel shows 5000%; installed 0.2.12 companions keep sending it until they update. Two stored rows already carry 50 (Medieval Madness 16814490 and 19643660, 2026-10-25). · pr: https://github.com/mekelburgj20/ArcAid/pull/379 (ArcAid W40/W41, 2.170.0) · spec: docs/arcaid-side-changes.md §14 (Correction)
- **F11** `done 2.170.0` Item 15: ArcAid reads `score_plausibility` (B6.1), stores it with the evidence and shows it on the Integrity panel; flag only, never a gate · pr: https://github.com/mekelburgj20/ArcAid/pull/379 (ArcAid W40/W41, 2.170.0) · spec: docs/arcaid-side-changes.md §15
- **F12** `ready` ArcAid admin UI for the blessed playfield fingerprint: `required_fingerprint` is stored and compared since 2.166.0 and settable through `PATCH` on the integrity route, but the tournament form has no field and no "bless the one I just played" button (§11 runner review); the companion sends `fingerprint` from 0.2.14 · spec: docs/arcaid-side-changes.md §11 "Runner review"
- **F13** `idea` One curated platform-wide list of games allowed in Limited attempts (owner ruling 2026-10-25: one list for the whole platform), seeded from B14, owner approves entries on an admin page; with `max_attempts` set the game picker offers only listed games and the server refuses others; shares data with F8 · needs: B14
- **F14** `ready` Item 16: read `quit` / `quit_ball` on the score call and mark a quit game on the board and the Integrity panel ("quit on ball 2"); badge, never gate (ArcAid W49) · spec: docs/arcaid-side-changes.md §16 · needs: B16

## G. Arcade (Phase 6)

Lane: `arcade/**`. Needs no VPX; can overlap with anything.

- **G1** `idea` Import-a-ROM: hash, core allowlist, memory map (RetroAchievements seed), verification read via RetroArch UDP, registry
- **G2** `idea` Launch profiles + poller; gate: 4-player Galaga match, all four scores captured · needs: G1
- **G3** `idea` Confirm RetroArch UDP `READ_CORE_MEMORY` during netplay on the current release; FBNeo 4-client stability

## H. Docs, process, CI

Lane: `docs/**`, `.claude/**`, `WORK.md`, `CHANGELOG.md`, `tools/**`, `.github/workflows/ci.yml`.

- **H1** `done` Single work tracker + board + `/work` and `/wrap` (ADR 0006), 2026-10-21
- **H2** `ready` `CHANGELOG.md` back-fill detail for 0.2.0–0.2.3 from the release notes on GitHub (the seed entry lists them in one line each)
- **H3** `idea` Protocol prose for A2/A3 before the code — a WebSocket paragraph under the existing "Host transfer" section and a new "Reconnect" section (resume from the log head, not a fresh HELLO) in `protocol/docs/prose.md`, then `npm run protocol:generate` (SPEC.md is generated)
