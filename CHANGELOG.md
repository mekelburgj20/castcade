# Changelog

Release history of the Castcade companion (`companion/package.json` version, tags `v<version>`,
installers from `.github/workflows/release.yml`). The live work list is `WORK.md`; design and rulings
are in `docs/`. Entries before 0.2.4 are one-liners reconstructed from the commit log on 2026-10-21
(WORK item H2 back-fills them from the GitHub release notes).

## [Unreleased]

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

### Dependencies
- Electron 44, Vite 8, vitest 5, eslint 10 (Dependabot #1/#5/#9/#11/#12); CI smoke green. Not yet packaged:
  the 0.2.10 installer runs Electron 38 (WORK item E4).

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
