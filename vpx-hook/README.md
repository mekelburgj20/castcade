# vpx-hook/

**Status: Phase 0 spike kit present (2026-10-17): `castcade.vbs` 0.1.0 and `spike/` (renderer, staging,
tailer, lock, capture test). Runbook and results: `docs/phase-0-spike.md`. Production recipes = Phase 3.**

Everything that runs inside the Visual Pinball X process. Pure VBScript, no DLL, no COM registration
(ADR 0001). The script does one job: append events to a journal file and read one lock flag. All
decoding, detection and networking happen in the companion.

## What lives here

- `castcade.vbs` — the shared library every patched table `ExecuteGlobal`s: journal writer
  (buffered; events flush at once, `nvram_delta` / `current_scores` every 50 lines), the
  `NVRAMCallback` **chaining guard** (`Castcade_RegisterNVRAM`), the lock check the sidecar's
  `_KeyDown` / `_KeyUp` wrappers call (`Castcade_KeyDownBlocked` / `Castcade_KeyUpBlocked`), helper
  subs for originals (`Castcade_GameStart`, `Castcade_Scores`, `Castcade_BallEnd`, `Castcade_GameEnd`).
  The event list is in the file header. Exercised outside VPX with a `cscript` harness (2026-10-17).
- `spike/` — Phase 0 tooling, not product code: `render-sidecar.py` (section 4 classifier + recipes A
  and B, the ancestor of the companion `patcher`), `stage.ps1`, `tail-journal.py` (map decode +
  ball-end detector, the ancestor of the companion detector), `lock.ps1`, `capture-test.ps1`.
- `recipes/<family>.md` → code later: one recipe per table family — `vpm-rom`, `original-jpsalas`,
  `original-vpw`, `scorbit-anchored`, `scoreserver-anchored`, plus `unsupported` reasons. A recipe
  states its anchors (what the analyzer must find), the lines it inserts, and how it verifies.
- `bulk/` — the optional shared patch: one `ExecuteGlobal` line for `core.vbs` plus `arcaid.vbs`,
  with install, hash-manifest, revert and self-heal rules. Setup-time opt-in only (ADR 0004).
- `JOURNAL.md` — the journal file format. **This is the product boundary.** Same vocabulary as the
  cabinet scoreserver: `table_loaded`, `game_start`, `current_scores`, `ball_end`, `game_end`, with
  `reason` / `via` tags. Versioned; a change needs a fixture in `fixtures/`.

## Rules

- **`ChangedNVRAM` is a destructive delta read.** Exactly one consumer per VPX process; the shadow
  NVRAM lives in the companion; any `NVRAMCallback` already set (bulk patch, a table's own, a future
  plugin) is chained, never replaced. Every registration goes through the one guard in `castcade.vbs`.
- **Enabling NVRAM capture needs no change to `core.vbs`:** `core.vbs` line 37 reads
  `Eval("UseVPMNVRAM")` at load, so a table script sets `UseVPMNVRAM = True` before `LoadVPM` and
  registers the callback after (verified on the owner's rig, 2026-10-17; the T7 probe does this).
- **Sidecar vs copy.** Default output is a same-basename sidecar `.vbs` beside the untouched `.vpx`
  (revert = delete). If Phase 0e shows the sidecar does not auto-load on Windows 10.8.0, the recipe
  writes an `importvbs` copy named `<table> [Castcade].vpx` instead.
- **Stale-sidecar guard.** A sidecar REPLACES the embedded script, so a table update would run the
  old script on new geometry. On a changed `.vpx` hash the sidecar is disabled and re-import offered.
- No real work in VBScript, no network calls from the script, buffered I/O only.

## What does not live here

- The analyzer/classifier and the installer logic (companion `patcher` module).
- NVRAM map decoding (companion, using the `pinmame-nvram-maps` corpus).
- A plugin (`plugin-vpx/` is deferred until a stable plugin API ships in a release VPX).

## Read first

ADR 0001, ADR 0004, `docs/design/table-import-and-patching.md`, and
`ArcAid/tmp/vpx-desktop-witness/t7-sidecar/ArcaidTest_TFTC.vbs` (gitignored in ArcAid) for the
working probe this generalizes.
