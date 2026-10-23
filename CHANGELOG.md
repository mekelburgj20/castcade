# Changelog

Release history of the Castcade companion (`companion/package.json` version, tags `v<version>`,
installers from `.github/workflows/release.yml`). The live work list is `WORK.md`; design and rulings
are in `docs/`. Entries before 0.2.4 are one-liners reconstructed from the commit log on 2026-10-21
(WORK item H2 back-fills them from the GitHub release notes).

## [Unreleased]

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
