# ADR 0005 — Two integrity modes on a tournament: Open play and Sanctioned play

**Status:** Accepted (2026-10-18); mode names are a working proposal pending the owner's choice
**Owner rulings:** 2026-10-18 ("I want to do whatever it takes to make the playing field completely level in certain arenas like a strict competition"; "we need to have a strict mode and a non-strict mode for tournament settings"; "work all this in as you see fit")
**Builds on:** ADR 0002 (matches are Throwdowns), ADR 0003 (Castcade is the desktop Witness), ADR 0004 (per-table import; the importer's file parser is reused here); ArcAid ADR 0020/0021 (badge, never gate; three-tier verification)
**Design:** `docs/design/fairness-and-table-identity.md`

## Context

Witness scores reach ArcAid matched by *name* (v0.2.2 sends the catalogue-grade table name and the ROM
name). That works for "any table of this game counts", which is what most runners want, and it is all
Open play needs once VPS game ids replace names. Some runners want more: one specific table build, stock
physics, factory machine settings, no script edits that change the rules. Today nothing measures any of
that, and the one tool that looks like it would, a hash of the `.vpx`, fails honest players (VR and
performance script edits, re-saves) while proving nothing about physics set at runtime or in the ini.

The owner's constraints, from the 2026-10-18 discussion: players will mistype or exploit a self-declared
table identity, so identity must come from evidence on the machine; legitimate script edits are too
common for a script hash, so the script must be *inspected*, not hashed; and the strict rules must be
something a runner turns on per tournament, not the default.

## Decision

1. **A tournament has an integrity mode, `open` (default) or `sanctioned`.** Open: any table of the
   game counts, matched on the VPS game id; everything else is reported, never enforced. Sanctioned:
   the runner names the table (VPS table id) and the ROM per game; a blessed playfield fingerprint,
   no ini physics override, factory NVRAM adjustments, a known engine build and a script whose diff
   from the baseline contains no *restricted* change are required for the auto-score to land in that
   tournament. The names are working names; the owner may rename them before ArcAid's PR.
2. **Evidence is measured on the companion and sent with every score in both modes.** VPS ids, whole-file
   hash and save revision (informational), playfield fingerprint, ini attestation, NVRAM adjustments,
   build hashes, script hash and a classified script diff. Only diffs and hashes leave the machine, never
   a player's full script.
3. **Preflight on the companion before ball one** in a Sanctioned tournament: the verdict and its reasons
   are shown to the player first; the runner sees every report; group visibility is a per-tournament
   setting, off by default.
4. **Scope of the gate.** Sanctioned rules refuse only the *auto-ingest into that tournament*, the same
   boundary ArcAid's engine exclusion already uses. Room boards, the Global Scoreboard and manual
   submissions stay badge-never-gate. A refused score is still recorded on the player's Global record
   when their device allows it, with the reasons attached.
5. **Script inspection means diff plus classification** (allowed / restricted / unknown) against a
   baseline the runner blesses from their own copy and consensus confirms; unknown hunks go to the
   runner once and are remembered.
6. **Build order:** companion identity and attestation first (shippable alone, ArcAid ignores the new
   params until its PR), then the ArcAid mode and review view, then the fingerprint and script diff,
   then the live-mode engine attestation with Phase 3.

## Consequences

- The companion grows a compound-file reader and record walker; the Phase 3 importer shares it.
- ArcAid gains a column, per-game rules, an evidence table, a runner review view and a preflight
  endpoint (`docs/arcaid-side-changes.md` items 11 and 12). Matching by VPS game id lands with item 11.
- The honest ceiling is written down: a modified companion, macros and bots are not detectable from
  data; Sanctioned arenas pair the checks with live video (Phase 4) and signed builds (GA).
- Every check is a flag a runner can see and a rule a runner may enforce; none changes a room board.
