# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

**Castcade** ("Cast" + "arCADE") — a companion desktop app for remote 2–4 player alternating-turn play
on the same VPX pinball table (and RetroArch arcade netplay), with live spectating and voice, whose
lobby, identity and results are managed by **ArcAid** (`C:\code\repos\ArcAid`, deployed at arcaid.app).
The companion is also the Windows desktop producer for **Arcaid Witness** (ADR 0003).

Remote: https://github.com/mekelburgj20/castcade · License: GPLv3 (owner ruling; nothing from VPX,
VPinMAME, RetroArch, FBNeo, ROMs or tables is ever bundled).

## Current state (2026-10-17)

Docs, skeleton, and the **Phase 0 spike kit** (`vpx-hook/castcade.vbs` + `vpx-hook/spike/`: Python and
PowerShell only, no Node). **No companion code, no package manifest, no build or test tooling yet.**
Phase 0 was **run on the owner's rig 2026-10-17 and all five gates passed** (0a/0b/0c/0d/0e); results, the
findings Phase 3 must absorb (journal volume, boot-garbage gate, bonus-after-ball_end) and what the owner still
confirms by hand are in `docs/phase-0-spike.md` §8. First fixtures are in `fixtures/`. When the stack lands (Electron + TypeScript is the ruled direction), add
build / lint / test / single-test commands here.

Spike checks that exist today: `cscript` harness for the library (see `vpx-hook/README.md`), and
`python vpx-hook/spike/tail-journal.py <journal|fixture.jsonl.gz>` replays a journal through the decoder and
detector (the three fixtures must still yield balls 1,2,3 + game_end and nothing spurious).

## Session start — read in this order

1. `docs/design/arcaid-integration-gap-analysis.md` — what ArcAid already has, the owner's rulings, the revised architecture and phases. **Source of truth.**
2. `docs/decisions/` — ADRs 0001–0004 (script hook not plugin · match = Throwdown · one app, Castcade uses Arcaid Witness · per-table import primary, core.vbs patch opt-in).
3. `docs/design/table-import-and-patching.md` — the Import-a-table pipeline (also the handoff doc for the ArcAid desktop-Witness agent).
4. `docs/arcaid-side-changes.md` — the work that lands in the ArcAid repo, by phase.
5. `docs/design/remote-two-player-design-handoff.md` — the original handoff; historical; wrong where the gap analysis says so.
6. In ArcAid: `docs/vpx-desktop-witness-plan.md`, ADRs 0017/0018/0020–0022, and `CLAUDE.md` sections "Live Event format", "Throwdowns", "Arcaid Witness".

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
