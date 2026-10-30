# Import a table — semi-automated patching of VPX tables (and ROMs) for live scoring and Castcade

**Status:** Design, 2026-10-17. Owner-ruled direction (ADR 0004). Nothing built yet.
**Audience:** this repo's Phase 3 implementer, AND an agent working in `C:\code\repos\ArcAid` on the
desktop Witness (`docs/vpx-desktop-witness-plan.md` §4 live mode) — this document is self-contained for
that purpose. ArcAid-side consequences are listed in §10.

## 1. Goal

A player opens Castcade, clicks **Import a table**, picks a `.vpx` (or a folder), and Castcade:

1. extracts the table script,
2. classifies the table and picks a patch recipe,
3. injects the lines that enable **realtime scoring** (Arcaid Witness live mode) and **Castcade match
   features** (turn lock, game/ball events, streaming cues),
4. verifies the patched table actually emits events,
5. records the table's readiness, locally and (opt-in) to ArcAid so other players can see it.

The same flow, with a memory map instead of a script edit, covers arcade ROMs for RetroArch (§9).

Target: VPX **10.8.0** on Windows. No plugin (10.8.0 has none), no in-process DLL, no admin rights.
The owner accepts Scorbit-style per-table script edits; the automation is the product.

## 2. Platform facts this design rests on (verified in ArcAid's research, 2026-08-30 / 2026-10-17)

| Fact | Evidence | Why it matters |
|---|---|---|
| `core.vbs` reads `UseVPMNVRAM` via `Eval(...)` at load (line 37) and only calls `Controller.ChangedNVRAM` → `NVRAMCallback` when it was true (lines 2490–2493). | Owner's rig `scripts/core.vbs`, VPinMAME driver ver 3.61 | A **per-table** script can switch NVRAM capture on with two lines; no shared-file edit is needed for VPM tables. |
| `ChangedNVRAM` is a destructive delta read. | VPM docs / `FINDINGS-D2` | Exactly one consumer per process; any second hook must chain. |
| An external process cannot read a running game (`VPinMAME.Controller`, `B2S.Server` are InprocServer32). | `FINDINGS-D1` §2 | Live data must come from injected script. |
| The VBScript host is unsandboxed: `Scripting.FileSystemObject`, `MSXML2.XMLHTTP`, `WScript.Shell` work. | `FINDINGS-D1` §2; T7 probe writes a jsonl file | A journal file is the cheapest, firewall-free IPC. |
| A same-basename `.vbs` beside the `.vpx` overrides the embedded script. | 10.8.0 exe strings `MODIFYING EXTERNAL SCRIPT:`; community-corroborated; **Phase 0e PASS 2026-10-17 (TFTC, MM, Iron Maiden): auto-loads on Windows with no prompt** | Non-destructive patching; revert = delete the file. |
| `vpxtool` (francisdb) does `extractvbs` / `importvbs` round-trips; VPX has `-ExtractVBS`. | `tmp/vpx-desktop-witness/vpxtool-windows-x86_64-v0.33.9.zip` | Scriptable extraction and the fallback write path. |
| `tomlogic/pinmame-nvram-maps` `game_state` gives per-player score, ball in play, player up, game over. ODbL. SAM/SPIKE entries lack `game_state`. | `FINDINGS-D1` §3; coverage 100/138 of the owner's `.nv` files | VPM decode is a lookup, not research; modern Sterns are a known gap. |
| 0 of the owner's 134 tables embed their own `core.vbs`; 0 use `NVRAMCallback`; 131 use VPinMAME; 3 are originals. | `FINDINGS-D2` §15 table | Recipe A covers ~98% of a typical ROM collection with no conflicts. |
| Originals keep score in script variables (`Score(n)`), zeroed in `ResetForNewGame`, with `AddScore` and `EndOfGame` subs; many carry **dormant Scorbit hooks** (`StartSession` / `SendUpdate` / `StopSession`, `Const ScorbitActive = 0`). | Iron Maiden LOTB script read, ArcAid memory 2026-09-26 | Originals are reachable only per-table; the Scorbit anchors are ready-made insertion points. |
| VPW-style tables handle flippers in `Table1_KeyDown` (`FlipperActivate`) and the plunger via `Controller.Switch(n)`. | T7 sidecar lines 2216–2320 | A `_KeyDown`/`_KeyUp` wrap is the right place for the turn lock. |

## 3. Pipeline

```
 pick .vpx ──► extract script ──► analyse/classify ──► choose recipe ──► render sidecar
      │              │                   │                   │               │
      │        vpxtool extractvbs   regex + anchor      A/B/C/D/E/X      castcade.vbs +
      │        (or VPX -ExtractVBS)   detection                          table-specific lines
      │                                                                        │
      └──────────── hash original .vpx ──────────────────────────► manifest ◄──┘
                                                                        │
                            verification launch ◄───────────────────────┘
                            (VPX -Play "<table>.vpx", wait for journal events, exit)
                                        │
                              registry: witnessed / ready-for-castcade / unsupported(reason)
                                        │
                              optional: report readiness to ArcAid (global_games.id + recipe version)
```

Every step is idempotent and re-runnable. **The default import is the whole tables folder** (owner ruling
2026-10-21; one table is the same flow on one file): a dry run first (classify every `.vpx`, write nothing, show
"N ROM tables will be patched, M originals skipped until recipes B/C exist, K have a foreign external `.vbs` and are
left alone, J already patched"), then apply. A `.vbs` beside a `.vpx` that does not carry the Castcade marker is never
touched. A "remove all Castcade sidecars" action deletes ours (and their manifests) and nothing else.

## 4. Analyzer — classification rules

Input: the extracted script text. Output: one class plus the anchors found. Rules are ordered; first match wins.
All matching is case-insensitive VBScript-aware (ignore `'` comments and string literals).

| Class | Detect | Notes |
|---|---|---|
| **A — VPM / ROM table** | `LoadVPM` call, or `ExecuteGlobal GetTextFile("core.vbs")`, or `Set Controller = CreateObject("VPinMAME.Controller")`; capture `cGameName` (ROM name) | 98% of a typical collection. ROM name → maps corpus lookup decides if live scores are decodable (`game_state` present). |
| **B — Original, JPSalas pattern** | no VPM; `Sub AddScore` (or `AddScore(`) AND `Sub ResetForNewGame` AND `Sub EndOfGame`; `Dim Score(` | Score per player in `Score(CurrentPlayer)`; ball count in `BallsRemaining(` or similar — record what was found. |
| **C — Original, Scorbit-anchored** | class B anchors absent or partial, but `StartSession`, `SendUpdate`, `StopSession` present (any `Scorbit*` identifiers) | Use the Scorbit call sites as the event anchors regardless of `ScorbitActive`. |
| **D — Original, ScoreServer-integrated** | `CreateObject("VPinball.ScoreServer")` or `SetScoresArray` / `SetGameState` | Already emits scores through superhac's API surface; the sidecar provides a compatible object. (Rare on desktop; present in some ALP-targeted tables.) |
| **E — Original, generic** | none of B–D, but `_KeyDown` exists and at least one of `Score`, `AddScore`, `Points` identifiers | Turn lock possible; scoring needs a manual anchor (the UI offers a guided pick: "which Sub adds points?"). Marked *partial*. |
| **X — Unsupported** | no `_KeyDown` (e.g. a test table), `Option Explicit` with obfuscated/compressed script, or extraction failed | Never patched. Reason recorded. |

Secondary facts captured for every class: table object name (`Sub (\w+)_KeyDown` → `Table1`), key constants in use
(`LeftFlipperKey`, `RightFlipperKey`, `PlungerKey`, `LockBarKey`, nudge keys, `StartGameKey`), `UseVPMDMD`,
B2S usage, `Option Explicit` presence (drives how we declare), and whether `NVRAMCallback` is already set
(chain, do not replace).

Target metric (Phase 3 gate): ≥ 80% of the owner's 134 tables auto-classified A–D without a guided pick.

## 5. Recipes

Each recipe renders a **sidecar `.vbs`** = the original script with blocks inserted at anchors. All injected
code is prefixed `Castcade_` and wrapped in `On Error Resume Next` where it touches the host, so a failure
in our code can never stop a table. Real work (decode, detection, networking) never runs in VBScript; the
script only appends lines to the journal and reads one lock flag.

**Common block 0 — library load (top of script, after `Option Explicit` if present):**
```vbs
' --- Castcade (recipe <id> v<n>, do not edit) ---
Dim Castcade_Journal, Castcade_Locked
ExecuteGlobal GetTextFile("castcade.vbs")   ' shared library installed in VPX\scripts\
Castcade_Init "<table-id>", "<recipe>", "<recipe-version>"
```
`castcade.vbs` provides: journal open/append/flush-every-N (the T7 probe's pattern), the lock-file check
`Castcade_Locked` (read at each key press, no timer), an idempotent `NVRAMCallback` registration that **chains**
any existing callback, and (Phase 3) a `VPinball.ScoreServer`-compatible object for class D. Version 0.1.0 exists
in `vpx-hook/castcade.vbs` (Phase 0 spike); the event list is in its header. It lives in the VPX `scripts\` folder (installed by the
companion alongside `core.vbs`; it is a new file, so nothing existing is touched).

**Recipe A (VPM):**
- before `LoadVPM`: `Dim UseVPMNVRAM : UseVPMNVRAM = True` (exactly what T7 does)
- after `LoadVPM`: `Castcade_RegisterNVRAM` (sets `NVRAMCallback`, chaining if already set)
- `_KeyDown` / `_KeyUp` wrap (block L below)
- journal events: `table_loaded` (with `cGameName`), `nvram_delta` stream, `nvram_baseline` at first callback and every 5,000. The companion decodes with the maps → `current_scores`, `ball_end`, `game_start`, `game_end`.

**Recipe B (JPSalas original):**
- block 0; `_KeyDown`/`_KeyUp` wrap
- append to `ResetForNewGame`: `Castcade_GameStart`
- append to `AddScore` (end of sub): `Castcade_Score CurrentPlayer, Score(CurrentPlayer)`
- append to `EndOfGame`: `Castcade_GameEnd Score`  (array → per-player finals)
- ball end: append to the sub that advances the ball (`EndOfBall` / `BallDrained` detected by name; else the place where `BallsRemaining` decrements) → `Castcade_BallEnd CurrentPlayer, BallNumber`

**Recipe C (Scorbit-anchored):** as B, but anchors = the `StartSession` / `SendUpdate` / `StopSession` call sites, which already receive player, score and game-over information.

**Recipe D (ScoreServer-integrated):** block 0 only + `_KeyDown` wrap; the library's `VPinball.ScoreServer` shim turns `SetScoresArray` / `SetGameState` into journal events.

**Recipe E (generic original):** block 0 + `_KeyDown` wrap + whatever anchor the guided pick supplied. Marked *partial* in the registry until verified.

**Block L — turn lock (all recipes):**
```vbs
Sub Table1_KeyDown(ByVal KeyCode)              ' renamed original: Castcade_Orig_KeyDown
    If Castcade_KeyDownBlocked(KeyCode) Then Exit Sub    ' locked AND a play key: flippers, plunger, lockbar, nudges, start, magna-saves
    Castcade_Orig_KeyDown KeyCode
End Sub
Sub Table1_KeyUp(ByVal KeyCode)
    If Castcade_KeyUpBlocked(KeyCode) Then Exit Sub      ' swallowed only if this key's key-down was swallowed
    Castcade_Orig_KeyUp KeyCode
End Sub
```
A key-up is swallowed only when its key-down was, so a flipper that went down always comes back up, even across
a lock transition. The play-key set is the VPX host constants plus table-specific names the analyzer captures
(`Castcade_AddPlayKeys Array("KeyUpperLeft", ...)` for staged flippers); `ExitGame` and the coin keys are never
locked. The lock file is written by the companion on every `TURN_GRANT` transition and read at the key press
itself (no poll, no timer object needed), so the handoff latency is the companion's write latency. Every swallowed
press is journaled as `key_blocked`, which is how the verification run proves the lock worked.

**Non-goals in the script:** no network calls, no signature checks, no decoding. Those live in the companion.

## 6. Sidecar vs copy, hashing, and the stale-sidecar guard

- **Default: sidecar.** `<Table>.vbs` beside `<Table>.vpx`. Original untouched; revert = delete. Phase 0e confirmed
  auto-load without a prompt on 10.8.0 Windows (2026-10-17).
- **Fallback: copy.** If auto-load fails, `vpxtool importvbs` into `<Table> [Castcade].vpx`. The original is still
  untouched; the player launches the copy.
- **Manifest** (`%LOCALAPPDATA%\Castcade\tables\<table-id>.json`): sha256 of the original `.vpx`, sha256 of the
  extracted script, recipe id + version, sha256 of the rendered sidecar, class, anchors found, verification result.
- **Match handshake (`HELLO`)** carries `sha256(original .vpx)`, `recipe`, `recipe_version`, `sha256(sidecar)`.
  Two players with the same original and the same recipe version produce byte-identical sidecars, so the host
  can refuse a mismatch and name the differing side (the handoff's table-hash control, preserved).
- **Stale-sidecar guard, three layers (owner ruling 2026-10-21).** A sidecar REPLACES the embedded script. When a
  table author ships a new `.vpx`, the old sidecar would run the old script against new geometry and break the
  table. The manifest's `sha256(original .vpx)` is the truth; three checks act on it, in the order they usually fire:
  1. **Folder watch.** The companion is a tray app, so it watches the tables folder; a `.vpx` whose size or mtime
     changed is re-hashed within seconds of the download and its sidecar is re-rendered (recipe anchors still match)
     or disabled (renamed to `<Table>.vbs.stale`) with a notification offering one-click re-import.
  2. **Launch re-hash.** The process watch hashes the `.vpx` at launch and disables a mismatch. It is usually late
     for that launch (VPX reads the sidecar at table load, the watch polls every 2 s), so it protects the next one.
  3. **In-script stamp.** Block 0 calls `Castcade_Guard originalPath, size, mtime, sidecarPath` (hook 0.2.0).
     VBScript cannot hash a 300 MB file, so the sidecar carries the original's size and local-time mtime
     (±1 h tolerance for DST / FileTime quirks; size is the strong signal). On a mismatch it journals
     `stale_sidecar`, renames itself `.stale`, and tells the player: "This Castcade patch was made for an older
     version of this table. It has been disabled — close the table, relaunch it, then re-import it from Castcade."
     That one session still runs the old script (the embedded script is out of reach once VPX chose the sidecar).
  This is the maintenance cost of the per-table path, stated plainly; the folder watch makes the other two rare.

  **The editor save (C10, Krobs 2026-10-29).** The VPX editor loads a same-basename sidecar as the table's script, and
  saving the table writes that script back into the `.vpx` (it also offers to rewrite the `.vbs`). After a colour
  change and a save, Castcade's patch was the table's own script with the old stamp: layer 3 fired at every launch with
  nothing left to rename, and the import refused the table as already patched. The rules since hook 0.4.1 /
  companion 0.2.20: `Castcade_Guard` with no sidecar beside the table journals `embedded_patch` and returns, because
  script and table were saved together and nothing is stale; the importer (`patchSource`) undoes its own patch found in
  an embedded script and patches the script underneath, so the folder watch heals an editor save within one look and
  "Patch my tables" never refuses it; the witness arms live mode on an embedded patch, tells the player once and has
  the shell render a fresh sidecar over it (`TablesHost.repair`), so the next launch runs a patch Castcade can keep
  current; the F5 baseline is the script underneath too, so the patch never reads as a person's edit. Nothing writes
  to the `.vpx`: the embedded copy stays, inert under the sidecar, until the author saves a clean script.

  Two rules the folder watch follows (companion `main/sidecar-watch.ts`): it runs every look under the same lock as
  the card's plan / patch / remove-all, so a re-patch never runs twice over one table at once; and a stale sidecar
  whose only fault is version drift (a newer companion with a newer recipe or library) is re-made quietly, all such
  tables in one import run with one notification, because that is maintenance the player did not cause.

## 7. Verification run

After rendering: launch `VPinballX64.exe -Play "<path>"` (or the copy), wait for `table_loaded` in the journal
within 30 s, then either (a) ask the player to start a game and drain one ball, or (b) in unattended folder
import, accept `table_loaded` + a successful `nvram_baseline`/anchor hit as *provisional*. Full status requires one
observed `game_start` → `ball_end` → `game_end` sequence. Outcomes:

| Status | Meaning | Shown as |
|---|---|---|
| `witnessed` | scores + game boundaries flow (Witness live mode works) | green "Live scores" |
| `ready_for_castcade` | `witnessed` AND turn lock present and verified (a locked flipper key did nothing) | green "Castcade ready" |
| `provisional` | loaded and hooked, no game observed yet | amber |
| `partial` | recipe E, or VPM ROM without `game_state` (scores only at exit) | amber with reason |
| `unsupported` | class X, or verification failed | grey with reason |

"Patched" must never read as "Castcade-ready". The two states are separate columns in the table list.

**Folder import runs no verification launch.** Opening VPX once per table across a 100-table folder is hours of
windows popping up, so bulk-imported tables are `provisional` ("patched, unverified") until the first real game
on them produces `game_start` → `ball_end` → `game_end` in live mode, which upgrades them to `witnessed` in the
manifest. The single-table verification launch stays available as an explicit action.

## 8. Bulk mode — the shared `core.vbs` patch (setup-time opt-in)

For Witness-only users with large, frequently updated collections, per-table sidecars carry the stale-sidecar
cost on every table update. The one-line `core.vbs` patch (`ExecuteGlobal GetTextFile("arcaid.vbs")` which sets
`UseVPMNVRAM` and registers the callback) instruments every VPM table at once and never goes stale with table
updates (it goes stale with VP script-package updates instead; self-heal detects and re-offers).

- Offered in the first-run wizard as a **forced choice** (two buttons, no pre-selection) with the exact diff shown
  (one line in `core.vbs`, one new `arcaid.vbs`, a Revert button) and again as a **contextual nudge** when the
  process watch sees the player finish a ROM table that is not imported.
- Backup + hash manifest + one-click revert, same as sidecars. Self-heal: the process watch verifies the
  `core.vbs` hash on each launch and offers re-patch when a script-package update clobbered it.
- **Chaining guard:** `castcade.vbs` and `arcaid.vbs` share one registration routine; a sidecar on a bulk-patched
  install chains rather than double-registers, so `ChangedNVRAM` has one consumer.
- Bulk mode provides **scoring only**. A match still requires the per-table import (turn lock, events).
- Not on the critical path for multiplayer streaming; it is the piece that slips if Phase 3 runs long.

## 9. Arcade twin — Import a ROM (RetroArch)

Same shape, no script edit:

1. pick a ROM zip → sha256 → identify (FBNeo/MAME set name)
2. core allowlist check (FBNeo first; MAME 2003-plus fallback; current MAME excluded until its netplay is verified)
3. memory map lookup in `arcade/maps/<set>.json` (score and player-up addresses, seeded from RetroAchievements'
   published addresses for the same ROMs; RA is already imported in ArcAid's catalogue)
4. verification: launch RetroArch with the core + ROM and the UDP command interface enabled; read the mapped
   addresses while the player starts a game; confirm the score address changes
5. registry: `ready_for_castcade` / `partial (no map)` / `unsupported (core)`

Open item: confirm the exact memory-read command name and address format in the current RetroArch release and
that it works while netplay is active on host and client.

## 10. ArcAid-side consequences (for the ArcAid agent)

- `docs/vpx-desktop-witness-plan.md` §4 "Live mode": add the per-table import path as primary (covers originals), keep the
  shared `core.vbs` patch as the forced-choice opt-in bulk mode; the desktop producer ships inside Castcade (castcade ADR 0003).
- Table-readiness registry: the planned GLOBAL scorability table (ROADMAP "VPX score ingestion") should accept
  per-table outcomes from companions keyed on `global_games.id` + `recipe_version`: `witnessed` /
  `ready_for_castcade` / `partial` / `unsupported(reason)`, crowd-sourced, so the Throwdown page and the import screen
  can say "N players verified this table".
- `castcade_matches` records `recipe_version` + `sidecar_hash` alongside the table/ROM hashes.
- ODbL attribution for `pinmame-nvram-maps` in the companion's About box (already a Witness-plan requirement).

## 11. Risks

- **Script diversity.** VPW, JPSalas, Hauntfreaks, older converts all differ; the recipe catalogue grows by table
  family. Mitigation: the guided pick (recipe E) and the crowd-sourced registry.
- **Stale sidecar on table update** (§6). Mitigation: the guard and re-import offer.
- **Key handling outside the script.** VPX reads DirectInput gamepads/plungers itself; a script-level lock cannot
  swallow those. Phase 0c measures; fallbacks are an OS-level hook, `Controller.Pause` (risky), or overlay only.
- **Antivirus / Controlled Folder Access.** We write files next to tables under `Documents`. Detect and explain;
  never fail silently (Witness plan §8).
- **`superhac/score-server` has no LICENSE.** The class-D shim is call-compatible with its documented API by
  interface only; no code is copied.
