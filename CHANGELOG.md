# Changelog

Release history of the Castcade companion (`companion/package.json` version, tags `v<version>`,
installers from `.github/workflows/release.yml`). The live work list is `WORK.md`; design and rulings
are in `docs/`. Entries before 0.2.4 are one-liners reconstructed from the commit log on 2026-10-21
(WORK item H2 back-fills them from the GitHub release notes).

## [Unreleased]

### Streaming
- A monitor turned to portrait in Windows (the usual desktop VPX setup) streams upright. Screen capture delivers such a
  monitor's picture unrotated, so the table came out on its side; the window probe now reads each monitor's rotation,
  the capture region is mapped into the panel's own frame and the picture turned back after scaling. Found on the
  owner's rig with the D1.0 preview. `media/window-geometry.ts`, `media/ffmpeg-args.ts` (`ddagrabRegion`).
- A rotate option for VPX in cabinet mode, where VPX draws the table on its side for a monitor that stands portrait but
  that Windows calls landscape: the picture turns 90 / 180 / 270 degrees clockwise after scaling, combined with any
  monitor rotation into one turn, and the vertical slice follows the turn. The D1.0 spike takes `--rotate`; the Stream
  page will offer it beside the preview (D1.5). `media/ffmpeg-args.ts` (`rotate`), `window-geometry.ts` (`portraitSlice`).

### Packaging
- The installer carries ffmpeg for streaming and recording: Gyan's GPLv3 essentials build of ffmpeg 8.1.1 (`ffmpeg.exe`
  and `ffplay.exe` for the framing preview, its LICENSE and README), pinned by sha256 and fetched at package time by
  `npm run fetch-ffmpeg -w companion` (`release.yml` runs it). The installer grows by about 54 MB. Nothing uses it
  in the app yet (D1.2 / D1.3); `Castcade.exe --smoke` reports `ffmpeg bundled <build>`, and the D1.0 spike's
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

## [0.2.2] — 2026-10-18
- Catalogue-grade wire name (`catalogueTableName`) plus the ROM name as `slug`, so ArcAid can match.
  Phase 2 gate, half 1, passed on the owner's rig with this build (Monster Bash to the tournament board
  with the Witness badge).

## [0.2.1] — 2026-10-18
- Capture on `.nv` change while VPX stays open (editor-driven play), table from the window title.

## [0.2.0] — 2026-10-18
- Phase 2: the Arcaid Witness desktop producer in basic mode (`companion/src/witness/`: process watch,
  `.nv` decode with the pinmame-nvram-maps corpus, GET posts, offline queue, heartbeat) behind a tray shell
  (pairing, status, settings); electron-builder NSIS per-user installer from `release.yml` on `v*` tags.
  Unsigned. Tester guide `docs/phase-2-witness.md`.

## [0.1.0] — 2026-10-18
- Phase 1: npm workspaces; `protocol/` v1 schemas with generated `SPEC.md`; `companion/src/match/`
  (host arbiter, client, hash-chained log, Ed25519 keys, in-memory and WebSocket transports) behind a
  minimal Electron shell; `fakeclient/` scenarios and the gate test; CI on ubuntu + windows + fixture replay.
  Phase 0 spike results in `docs/phase-0-spike.md`.
