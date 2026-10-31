# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

**Castcade** ("Cast" + "arCADE") — a companion desktop app for remote 2–4 player alternating-turn play
on the same VPX pinball table (and RetroArch arcade netplay), with live spectating and voice, whose
lobby, identity and results are managed by **ArcAid** (`C:\code\repos\ArcAid`, deployed at arcaid.app).
The companion is also the Windows desktop producer for **Arcaid Witness** (ADR 0003).

Remote: https://github.com/mekelburgj20/castcade · License: GPLv3 (owner ruling; nothing from VPX,
VPinMAME, RetroArch, FBNeo, ROMs or tables is ever bundled).

## Current state

Open work, claims and blockers live in **`WORK.md`** (one line per item, IDs like `B4.1`; grammar and
the claiming rule in `.claude/commands/work.md`; the board link is on its first line). Release history is
`CHANGELOG.md`. Start a session with `/work`, end it with `/wrap`. **Do not write a session narrative
here**: this section holds standing facts only (ADR 0006).

- Companion 0.2.21 is an unsigned PoC. Code signing waits for GA (owner ruling 2026-10-18). The repo is
  public and must stay so: installed apps read the releases feed anonymously (0.2.6).
- Gates passed: Phase 0 spike (owner's rig, 2026-10-17; findings in `docs/phase-0-spike.md` §8), Phase 1
  protocol + host mode (CI, 2026-10-18), Phase 2 half 1 (Monster Bash to a tournament board with the
  Witness badge, 2026-10-18), Phase 2 half 2 (Krobs' clean install posts a badged score, 2026-10-25).
- Fairness build order F1–F6 is `docs/design/fairness-and-table-identity.md` §7; F1–F4 and F6 shipped (0.2.4 →
  0.2.14 here, ArcAid 2.163 → 2.168); F5 is WORK item B5 (engine shipped, preflight waits on ArcAid). Integrity mode is ADR 0005 here and ArcAid ADR 0027.
- ArcAid is the server (arcaid.app). Its side of the work is `docs/arcaid-side-changes.md`; it is tracked
  in the ArcAid repo's own `WORK.md`, section W, and mirrored here as section F.
- The owner's rig runs Panasony VR builds and a VPinMAME nightly, both allowed in Sanctioned play
  (ruling 2026-10-19). Its device row predates ArcAid #363; one re-pair from Settings fixes its type.
- Test room for testers' scores: Flippin Fear Fest (`arcaid_flippin_fear_fest_26`); tester kit `docs/tester-kit.md`.

## Commands

```bash
npm ci                         # install all workspaces (Node 22+)
npm run check                  # lint + typecheck (tsc -b) + all tests + work:check; run before committing
npm run work:summary           # the terminal view of WORK.md (what /work shows); work:check validates it, work:board renders tmp/work-board.html
npm run lint                   # eslint (flat config at the root)
npm run typecheck              # tsc -b over protocol, companion, fakeclient
npm test                       # vitest, all packages (tests import workspace packages from sources)
npx vitest run protocol        # one package; or a path / test-file name for a single test
npm run build                  # tsc -b in every workspace (+ renderer bundle in companion)
npm run protocol:generate      # regenerate protocol/schemas/*.json and protocol/SPEC.md after editing protocol/src
npm run generate -w protocol -- --check   # what CI runs: fails if the generated files are stale
python fixtures/check.py       # replay the recorded journals through the Phase 0 detector (needs the maps corpus, see fixtures/README.md)
npm run fetch-maps -w companion   # fetch the pinned pinmame-nvram-maps corpus into companion/resources/maps (gitignored; needed to package)
npm run fetch-ffmpeg -w companion # fetch the pinned ffmpeg build (sha256-checked) into companion/resources/ffmpeg (gitignored; needed to package, D1.6)
npm run ffmpeg-source -w companion # download the GPL Corresponding Source of the bundled ffmpeg into companion/release (release.yml uploads it; E5, docs/ffmpeg-source.md)
npm run fetch-vps -w companion    # build the compact VPS index into companion/resources/vps from the pinned vps-db commit (gitignored; needed to package); `--from <vpsdb.json> --subset <ids>` rebuilds fixtures/vps
npm run playfield-tags -w companion -- "<table.vpx>"   # re-record fixtures/playfield/tags.json (B4.1) after a VPX update: tag names and counts only
npm run witness-games -w companion   # regenerate docs/witness-games.{json,md} (B14) from the fetched VPS index × maps corpus; verified = a fixtures/nvram/<rom> folder
npm run pack:dir -w companion     # unpacked app in companion/release/win-unpacked (then run Castcade.exe --smoke)
npm run dist:win -w companion     # NSIS installer in companion/release (unsigned)
```

Spike tooling (Python/PowerShell, no Node): `vpx-hook/spike/` (see `vpx-hook/README.md`);
`python vpx-hook/spike/tail-journal.py <journal|fixture.jsonl.gz>` replays a journal through the decoder and
detector (the three fixtures must still yield balls 1,2,3 + game_end and nothing spurious).

## Session start — read in this order

0. `WORK.md` (`/work`): what is open, claimed, blocked, and what the owner wants next. Then, for the design behind an item:
1. `docs/design/arcaid-integration-gap-analysis.md` — what ArcAid already has, the owner's rulings, the revised architecture and phases. **Source of truth.**
2. `docs/decisions/` — ADRs 0001–0008 (script hook not plugin · match = Throwdown · one app, Castcade uses Arcaid Witness · per-table import primary, core.vbs patch opt-in · Open / Sanctioned play · one live work tracker · functionality before ease of setup · sanctioned VPX build for Sanctioned play).
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
| **Functionality before ease of setup.** VPX users accept complex setup; never drop a capability (multiplayer streaming, voice, fairness) to save a setup step. Within that, make install and setup as easy as possible: automate it, or walk the user through it. | 2026-10-27 | 0007 |
| A **sanctioned VPX build** (our fork, Sanctioned mode enforced in-process) is a per-tournament requirement for Sanctioned play; ArcAid trusts its signature and Legends Unchained's (Mox's), no other build. Castcade on stock VPX stays the app for Open play and everything else. | 2026-10-30 | 0008 |
| Tournaments have an **integrity mode**: *Open play* (default, any table of the game) or *Sanctioned play* (named table + fairness rules). Evidence is measured on the companion and sent with every score; rules gate only the auto-ingest into an opted-in tournament; room boards stay badge-never-gate. Mode names provisional. | 2026-10-18 | 0005 |

## Repo layout

| Path | Holds | Phase |
|---|---|---|
| `protocol/` | JSON schemas for every match message, version constant, generated spec | 1 |
| `companion/` | Electron + TS app: modules `patcher`, `witness`, `match`, `media`, `launch` | 2+ |
| `vpx-hook/` | `castcade.vbs` shared library (0.4.0), `spike/` Phase 0 tooling, patch recipes, optional `core.vbs` bulk patch | 0, 3 |
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
- **One live tracker.** Open work goes in `WORK.md` as items; claim an item before editing another lane's files; `/wrap` before the session ends. Never start a second list (a `tmp/` bug list, a status paragraph in this file).
- Line endings: this repo is LF. The Write tool emits LF; prefer Edit for existing files.
- Build before committing once a build exists; subagent worktree conventions from `C:\code\repos\CLAUDE.md` apply.

## Relationship to the parent folder

`C:\code\repos\CLAUDE.md` is also loaded here. Its ArcAid-specific rules (Docker-first, `SPRINT_STATUS.md`
cadence, iScored) apply to ArcAid only. ArcAid is the reference for domain vocabulary and prior decisions;
there is no shared code.
