# ADR 0004 — Per-table import is primary; the shared core.vbs patch is a setup-time opt-in

**Status:** Accepted (2026-10-17)
**Owner rulings:** 2026-10-17 (per-table "Import a table" patching heavily favoured, Scorbit-style script edits acceptable, same approach for arcade and for the Witness alone); same day: keep the shared `core.vbs` patch as a first-run opt-in ("Patch VPX to allow score capture from all tables/ROMs?"); same day: forced choice, contextual nudge, two table states agreed.
**Related:** ADR 0001 (why script, not plugin), ADR 0003 (one app, one hook consumer); full design in `docs/design/table-import-and-patching.md`.

## Context

The primary product goal is multiplayer streaming in VPX **10.8.0**. Someone online has achieved
it without releasing files and is testing table by table, which is consistent with per-table
script injection. Scorbit's VPIN support is already per-table script integration, so the community
accepts the model.

Two injection points exist on 10.8.0 (ADR 0001):

- **Per-table.** A same-basename sidecar `.vbs` beside the `.vpx` (binary evidence in the 10.8.0
  exe: `MODIFYING EXTERNAL SCRIPT:`; auto-load on Windows is unverified until Phase 0e), or
  `vpxtool importvbs` into a copy. ArcAid's T7 probe is a sidecar of this kind.
- **Shared.** One `ExecuteGlobal` line in `scripts/core.vbs` plus a separate `arcaid.vbs`, which
  the ArcAid Witness plan designed. On the owner's rig 131 of 134 tables load VPinMAME, none embed
  their own `core.vbs`, none use `NVRAMCallback`, so one shared patch instruments ~98% of ROM
  tables with no per-table edits.

What each can and cannot do:

| | Shared `core.vbs` patch | Per-table import |
|---|---|---|
| ROM/VPM tables scored live | all at once | yes, two lines, no analysis needed |
| Originals (script-only) scored | no; the score lives in table variables `core.vbs` never sees | yes; the only path |
| Turn lock for a match | no; flipper keys are handled in each table's own `KeyDown` | yes, by wrapping `_KeyDown`/`_KeyUp` |
| Game start/end events | inferred from NVRAM transitions | from `ResetForNewGame`/`EndOfGame` on originals, NVRAM on VPM |
| New tables added later | automatic | after import (bulk folder import mitigates) |
| What it modifies | a shared file players guard, clobbered by every VP script-package update | a sidecar beside an untouched `.vpx`; revert = delete |
| Both players provably identical | weak | strong: hash original `.vpx` + recipe version + sidecar |
| Table version update | unaffected | a same-basename sidecar REPLACES the embedded script, so an old sidecar on a new table breaks it |

A Castcade match needs the turn lock and match events, so per-table patching is required
regardless. The shared patch serves exactly one case: "witness every ROM table I play without
importing each one".

## Decision

### 1. Import a table is the primary integration path

In the companion: *Import a table* → pick a `.vpx` (or a folder) → extract the script (`vpxtool
extractvbs` or VPX `-ExtractVBS`) → classify (VPM/ROM; JPSalas-pattern original; VPW original;
Scorbit-anchored; `VPinball.ScoreServer`-anchored; unsupported) → apply a recipe → write the
sidecar (or an `importvbs` copy if sidecar auto-load fails Phase 0e) → hash manifest → verification
run → registry entry. Recipes insert lines for realtime scoring (Witness), the turn lock and match
events. The same flow, with a per-ROM memory map in place of a script recipe, applies to arcade
ROMs for RetroArch (import → hash → map lookup → test read → registry).

### 2. The shared core.vbs patch is a setup-time opt-in bulk mode

The first-run wizard asks, as a **forced choice with no pre-selection**: patch VPX so every ROM
table reports scores, or import tables one at a time. The wizard shows exactly what changes (one
line in `core.vbs`, one new file, a Revert button). The question is re-offerable from Settings and
through a **contextual nudge** when the process watch sees the player finish a ROM table that is
not imported ("Capture scores from every ROM table automatically? / Import tables one at a time /
Not now"). Bulk mode never provides the turn lock, so a match still requires per-table import.

### 3. Two table states, never conflated

The table list shows *witnessed* (bulk or imported: scores flow to ArcAid) and *ready for Castcade*
(imported with turn lock and match events). "Patched" never reads as "Castcade-ready".

### 4. Guards

- **Chaining guard.** Both mechanisms share one `castcade.vbs` library with an idempotent
  registration guard: a sidecar on a bulk-patched install chains the existing `NVRAMCallback`
  rather than double-registering it (`ChangedNVRAM` is a destructive read).
- **Stale-sidecar guard.** On a changed `.vpx` hash the sidecar is disabled and re-import offered.
- **Self-heal.** The process watch detects a VP script-package update overwriting the shared patch
  and offers a one-click re-patch.
- **Hash manifest + revert** for the shared patch and every sidecar.

### 5. Priority

Bulk mode is not on the critical path for multiplayer streaming. If Phase 3 runs long, bulk mode
slips, not the import pipeline.

## Consequences

### Easier
- Originals become reachable; the turn lock is in-process; the match handshake proves both players
  patched the same table from the same original.
- Witness-only players with large, frequently updated collections get the lower-maintenance bulk
  path by saying yes once.
- The Witness plan's "default install modifies nothing" still holds: nothing is written until the
  player imports a table or answers the wizard.

### Harder
- A recipe catalogue that grows with table families; heuristic script classification can misfire
  and must report "unsupported (reason)" rather than guess.
- Two code paths to the same journal; the chaining guard is load-bearing and needs a fixture.
- Sidecar auto-load on Windows 10.8.0 is unverified (Phase 0e); the copy fallback changes the file
  the player launches.

### Locked out
- No `rommaps/` of our own; the maps corpus is a dependency.
- No pre-checked "patch VPX" box; no silent modification of `core.vbs`.

## Alternatives rejected

- **Per-table only, never the shared patch.** Loses the all-at-once Witness case and its immunity
  to table updates; the owner chose to keep it as an opt-in.
- **Shared patch only.** Cannot reach originals or lock input, so it can never carry a match.
- **Shared patch first, per-table later.** Would make the Witness work while leaving Castcade's
  hard requirement unbuilt.
- **Pre-checked opt-in by default.** Close to the "precondition of installing" the Witness plan
  ruled out; an unchecked box is what everyone skips. A forced choice gets a real decision.
