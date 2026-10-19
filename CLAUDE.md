# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

**Castcade** ("Cast" + "arCADE") — a companion desktop app for remote 2–4 player alternating-turn play
on the same VPX pinball table (and RetroArch arcade netplay), with live spectating and voice, whose
lobby, identity and results are managed by **ArcAid** (`C:\code\repos\ArcAid`, deployed at arcaid.app).
The companion is also the Windows desktop producer for **Arcaid Witness** (ADR 0003).

Remote: https://github.com/mekelburgj20/castcade · License: GPLv3 (owner ruling; nothing from VPX,
VPinMAME, RetroArch, FBNeo, ROMs or tables is ever bundled).

## Current state (2026-10-18)

Phase 0 was **run on the owner's rig 2026-10-17 and all five gates passed** (0a/0b/0c/0d/0e; 0c also
confirmed by the owner by hand); results, the findings Phase 3 must absorb (journal volume, boot-garbage
gate, bonus-after-ball_end, exit mid-game) are in `docs/phase-0-spike.md` §8. First fixtures are in `fixtures/`.
**Phase 1 gate passed 2026-10-18** (first CI run green): npm workspaces with `protocol/` (v1 schemas +
generated `SPEC.md`, the normative behaviour text is `protocol/docs/prose.md`), `companion/src/match/` (host
arbiter, client, hash-chained log, Ed25519 keys, in-memory + WebSocket transports) behind a minimal Electron
shell, and `fakeclient/` (scenarios, CLI, the gate test). CI: `.github/workflows/ci.yml` (ubuntu check, windows
build + smoke, fixture replay). Known gaps carried to later phases: host transfer over WebSocket (clients must
reconnect to the new host), client reconnect after a drop, simultaneous mode untested, no ArcAid posting yet.
**Phase 2 built 2026-10-18 (v0.2.0, unsigned PoC):** `companion/src/witness/` is the Arcaid Witness desktop
producer in basic mode (process watch, `.nv` decode with the pinmame-nvram-maps corpus, GET posts to the
existing witness endpoints, offline queue, heartbeat) behind a tray shell (pairing / status / settings),
packaged by electron-builder (NSIS per-user) from `.github/workflows/release.yml` on `v*` tags. Tester guide:
`docs/phase-2-witness.md`. ArcAid PRs #363 (`witness_devices.device_type`, migration 183; revised in review
2026-10-18: rebased to v2.163.0 and provenance now follows the type, desktop → engine `vpx` / device `pc` /
platform `vpx`) and #364 (docs, unchanged) were approved and are merging/deploying as of 2026-10-18. **v0.2.3 (2026-10-18)** added what ArcAid's event lobby
needs from a desktop: `GET /api/witness/checkin` whenever no VPX process is running (start, after every exit,
each heartbeat tick while idle; the reply's `sendingTo` line is shown in Status and the tray) and a launch-only
`report` as soon as a session has a table name (the capture's report closes it on the same key).
**Phase 2 gate, half 1 passed 2026-10-18 with v0.2.2 on the owner's rig:** paired against arcaid.app,
Monster Bash (VR build, opened from the editor without `-Play`) played to the end, the score landed on the
room's tournament board with the Witness badge. Two field fixes got there: capture on `.nv` change while VPX
stays open with the table from the window title (0.2.1), and the catalogue-grade wire name
`catalogueTableName` + ROM name as `slug` (0.2.2). Half 2 (clean-machine install by a tester) is pending.
Code signing is deferred until GA (owner ruling 2026-10-18). Tester kit for the friends wave:
`docs/tester-kit.md` (v0.2.3; sent 2026-10-18; test room Flippin Fear Fest, https://arcaid.app/arcaid_flippin_fear_fest_26/). **Next, confirmed by the owner 2026-10-18 (ADR 0005, design in
`docs/design/fairness-and-table-identity.md`):** tournaments get an integrity mode, Open play (any table of
the game, matched on VPS game id) or Sanctioned play (names confirmed by the owner) (named table, stock physics, factory NVRAM adjustments,
known build, script diff with no restricted change; preflight before ball one). Build order F1–F6 in the
design doc §7. **F1 shipped in v0.2.4 (2026-10-18):** `companion/src/witness/{identity-resolver,vpx-file,vps-index,
table-match,table-locator,identity-store}.ts`; the compact VPS index is fetched at build time by
`npm run fetch-vps -w companion` (vps-db commit pinned in the script; `fixtures/vps/` holds a 13-game subset for
tests); scores carry `vps_game`, `vps_table`, `table_sha256`, `table_save_rev`; Status shows the identity with a
one-time picker; a `tablesDir` setting widens the search for editor-opened tables. Next: F2 (ini attestation, NVRAM
adjustments, build hashes), then ArcAid items 11/12.

## Commands

```bash
npm ci                         # install all workspaces (Node 22+)
npm run check                  # lint + typecheck (tsc -b) + all tests; run before committing
npm run lint                   # eslint (flat config at the root)
npm run typecheck              # tsc -b over protocol, companion, fakeclient
npm test                       # vitest, all packages (tests import workspace packages from sources)
npx vitest run protocol        # one package; or a path / test-file name for a single test
npm run build                  # tsc -b in every workspace (+ renderer bundle in companion)
npm run protocol:generate      # regenerate protocol/schemas/*.json and protocol/SPEC.md after editing protocol/src
npm run generate -w protocol -- --check   # what CI runs: fails if the generated files are stale
python fixtures/check.py       # replay the recorded journals through the Phase 0 detector (needs the maps corpus, see fixtures/README.md)
npm run fetch-maps -w companion   # fetch the pinned pinmame-nvram-maps corpus into companion/resources/maps (gitignored; needed to package)
npm run fetch-vps -w companion    # build the compact VPS index into companion/resources/vps from the pinned vps-db commit (gitignored; needed to package); `--from <vpsdb.json> --subset <ids>` rebuilds fixtures/vps
npm run pack:dir -w companion     # unpacked app in companion/release/win-unpacked (then run Castcade.exe --smoke)
npm run dist:win -w companion     # NSIS installer in companion/release (unsigned)
```

Spike tooling (Python/PowerShell, no Node): `vpx-hook/spike/` (see `vpx-hook/README.md`);
`python vpx-hook/spike/tail-journal.py <journal|fixture.jsonl.gz>` replays a journal through the decoder and
detector (the three fixtures must still yield balls 1,2,3 + game_end and nothing spurious).

## Session start — read in this order

1. `docs/design/arcaid-integration-gap-analysis.md` — what ArcAid already has, the owner's rulings, the revised architecture and phases. **Source of truth.**
2. `docs/decisions/` — ADRs 0001–0005 (script hook not plugin · match = Throwdown · one app, Castcade uses Arcaid Witness · per-table import primary, core.vbs patch opt-in · Open / Sanctioned play).
3. `docs/design/fairness-and-table-identity.md` — table identity, playfield fingerprint, script inspection, the honest ceiling, build order F1–F6.
4. `docs/design/table-import-and-patching.md` — the Import-a-table pipeline (also the handoff doc for the ArcAid desktop-Witness agent).
5. `docs/arcaid-side-changes.md` — the work that lands in the ArcAid repo, by phase.
6. `docs/design/remote-two-player-design-handoff.md` — the original handoff; historical; wrong where the gap analysis says so.
7. In ArcAid: `docs/vpx-desktop-witness-plan.md`, ADRs 0017/0018/0020–0022, and `CLAUDE.md` sections "Live Event format", "Throwdowns", "Arcaid Witness".

ArcAid's desktop-Witness evidence (research findings, the staged T7 probe, cloned `pinmame-nvram-maps`,
`vpxtool`) is **gitignored** at `C:\code\repos\ArcAid\tmp\vpx-desktop-witness\`. Do not re-run that research.

## Owner rulings that are locked (do not reopen without asking)

| Ruling | Date | ADR |
|---|---|---|
| Target VPX **10.8.0** (no plugin system there; 10.8.1 is beta). In-process code = injected VBScript. Plugin deferred as a later swappable producer. | 2026-08-30 / 2026-10-17 | 0001 |
| A Castcade match is a **Throwdown** with `play_mode='castcade'`. Never a new "Challenge" entity. | 2026-10-17 | 0002 |
| **One desktop app.** The Windows desktop Witness producer lives here; the AtGames cabinet C++ app and the server contract stay in ArcAid. Shared = wire contract + event vocabulary + maps corpus, never code. | 2026-10-17 | 0003 |
| **Import a table** (per-table script patch) is the primary path; the shared `core.vbs` patch is a forced-choice setup opt-in for bulk Witness scoring. "Patched" never reads as "Castcade-ready". | 2026-10-17 | 0004 |
| Peer-hosted (host player's companion arbitrates and forwards media); ArcAid does signaling + results only. Architecture B (parallel 1-player games). 2–4 players, protocol N-player from day one. | handoff doc | — |
| Names in code: product *Castcade*; lobby *Throwdown*; roles *host* / *client*; turn token *grant*. | handoff + 0002 | — |
| Tournaments have an **integrity mode**: *Open play* (default, any table of the game) or *Sanctioned play* (named table + fairness rules). Evidence is measured on the companion and sent with every score; rules gate only the auto-ingest into an opted-in tournament; room boards stay badge-never-gate. Mode names provisional. | 2026-10-18 | 0005 |

## Repo layout

| Path | Holds | Phase |
|---|---|---|
| `protocol/` | JSON schemas for every match message, version constant, generated spec | 1 |
| `companion/` | Electron + TS app: modules `patcher`, `witness`, `match`, `media`, `launch` | 2+ |
| `vpx-hook/` | `castcade.vbs` shared library (0.1.0 present), `spike/` Phase 0 tooling, patch recipes, optional `core.vbs` bulk patch | 0, 3 |
| `fakeclient/` | scripted protocol player, no emulator, for CI | 1 |
| `arcade/` | RetroArch launch profiles, core allowlist, ROM memory maps | 6 |
| `fixtures/` | recorded NVRAM journals + script-event logs for detector replay in CI | 2–3 |
| `docs/` | design docs, ADRs, ArcAid work list | — |
| `tmp/` | scratch, gitignored | — |

Not present on purpose: `plugin-vpx/` (deferred), `rommaps/` (use the `pinmame-nvram-maps` corpus).

## Working agreement

- **Journal file format is the product boundary** between in-VPX script and the companion. Change it only with a version bump and a fixture.
- **`ChangedNVRAM` is a destructive single-consumer read.** Every registration of `NVRAMCallback` goes through the one chaining routine in `castcade.vbs`.
- **Badge, never gate** (ArcAid doctrine): no verdict Castcade produces may filter a board or change a rank on the ArcAid side.
- **No real work in VBScript.** The script appends journal lines and reads one lock flag (checked at each key press, not polled; a key-up is swallowed only when its key-down was); decoding, detection and networking live in the companion.
- **Never commit** a ROM, a table file, a NVRAM file from someone else's machine, or a pairing token. Fixtures are journals we recorded.
- Line endings: this repo is LF. The Write tool emits LF; prefer Edit for existing files.
- Build before committing once a build exists; subagent worktree conventions from `C:\code\repos\CLAUDE.md` apply.

## Relationship to the parent folder

`C:\code\repos\CLAUDE.md` is also loaded here. Its ArcAid-specific rules (Docker-first, `SPRINT_STATUS.md`
cadence, iScored) apply to ArcAid only. ArcAid is the reference for domain vocabulary and prior decisions;
there is no shared code.
