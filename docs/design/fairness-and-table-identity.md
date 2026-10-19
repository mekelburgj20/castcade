# Fairness and table identity — Open play and Sanctioned play

> **Status:** design accepted by the owner 2026-10-18 ("work all this in as you see fit"); the mode names
> Open play / Sanctioned play and the runner-uploaded script baseline (§8) were confirmed the same day. Nothing here is built yet. The companion half comes first
> (§7), then the ArcAid half (`docs/arcaid-side-changes.md` items 11 and 12). ADR 0005 records the ruling.

## 0. The need, stated plainly

Nothing that runs on a player's own PC can *prevent* cheating: the companion is open source and the
player owns the machine. What a strict competition can have is three things:

1. **Every fairness-relevant input is measured** (which table, which physics, which rules, which ROM,
   which engine build) and sent with the score.
2. **Deviations are visible before ball one** (a preflight on the companion), so an honest player is
   never surprised and a dishonest one knows the game will not count.
3. **Evidence survives for a human ruling** by the people who run the tournament.

Design for detection plus preflight and "prevention" falls out, because cheating stops being worth it.
Room boards keep ArcAid's doctrine, **badge, never gate** (ADR 0020/0021): everything below gates only
the *auto-ingest into a tournament whose runner opted into Sanctioned play*, exactly the way a
tournament's engine exclusion already refuses a Witness score today
(`VpxScoreIngestService.engineExcluded`). Manual submissions are untouched.

## 1. Two modes on a tournament

| | **Open play** (default) | **Sanctioned play** |
|---|---|---|
| Which table counts | any table of the game (VPS *game* id) | the table(s) the runner names (VPS *table* id), with a blessed playfield fingerprint |
| Physics | reported, never enforced | stock required: fingerprint match + no ini physics override + engine attestation (live mode) |
| Script | diff reported to the runner | diff classified; *restricted* changes refuse the auto-score |
| ROM | reported | pinned to the ROM id the runner names |
| Machine adjustments (NVRAM) | reported | factory required (balls per game, ball save, extra ball %, free play) |
| Engine build | reported | known VPX 10.8.0 release build required; others flagged for review |
| Preflight on the companion | informational | verdict before ball one: counts / will not count, with reasons |

Naming is open. "Open" and "Sanctioned" are the working names because "sanctioned" is what real
tournament bodies call events played under their rules; alternatives the owner may prefer: Casual /
Competitive, Standard / Verified (but ArcAid already uses *verified* for the Witness tiers, ADR 0021).
Whatever the words, the mode is one column on `tournaments`, with per-game detail (required table,
baseline) on the tournament's games.

## 2. Identity: which game, which table, which file

Resolution order on the companion, strongest first, each step recorded in the capture detail:

1. **Confirmed mapping** for this file path + size + mtime (the player confirmed once; see 4).
2. **ROM id → VPS game id.** The ROM pins the *game* reliably (Monster Bash is `mb_*` whatever the
   table). The ROM→game table is built from the VPS database (`romFiles`) plus the maps corpus'
   `romnames.json`, and corrected by consensus (what other companions resolved for the same ROM).
3. **Embedded TableInfo** (`TableInfo` storage in the `.vpx`: table name, author, version, release
   date, and `TableSaveDate` / `TableSaveRev`, which advance on every editor save). Name + author +
   version matched against VPS `tableFiles` gives the *table* id in most cases; a save revision later
   than everyone else's says "this copy was re-saved after release", shown as information.
4. **File name and window title** (what v0.2.x does today) as the last resort for the game; for the
   table, the companion asks the player once ("Which VPS table is this file?") and remembers it.

VPS ids are opaque keys assigned by the spreadsheet, not hashes: the game id (`MasterID` in the
sheet) is shared by every table of the game, the table id (`VPS-ID` / `WebGameID`) is per table file.
ArcAid's catalogue already holds the game id on every VPS-imported row (`global_games.vps_id`).

Sent with every score (new wire params, all optional so today's server ignores them):
`vps_game`, `vps_table`, `table_sha256` (whole file, informational), `table_save_rev`,
`fingerprint` (§3), `script_sha256`, `script_diff` (§4, as a short classified summary), `rom`
(exists), `adjustments` (§5), `build` (§6), `ini` (§3). A file's hashes are cached by path, size
and mtime so a 500 MB table is read once, in the background, at launch.

## 3. Playfield fingerprint and settings attestation

**Why not the whole-file hash.** Script edits for VR vs desktop, performance toggles, DMD placement
and plain re-saves all change the file without touching fairness. A hash gate would fail honest
players constantly and teach everyone to ignore it. The whole-file hash is reported, never enforced.

**What the fingerprint hashes instead: the playfield as the ball sees it.** A `.vpx` is an OLE
compound file whose table properties and game items are tagged binary records (`vpxtool`, already in
ArcAid's gitignored evidence folder, parses them to JSON; the companion will carry its own
compound-file reader and record walker, which the Phase 3 importer needs anyway). Included:

- **Table:** gravity, friction, elasticity, elasticity falloff, scatter, nudge time, slope min, slope
  max, default difficulty, physics override set, physics materials.
- **Flippers:** strength, return, ramp-up, elasticity, friction, torque damping, EOS torque, start and
  end angles, length and radii, position.
- **Slingshots, bumpers, kickers, plunger:** force, threshold, scatter, position.
- **Walls, rubbers, posts, ramps, primitives marked collidable:** elasticity, friction, scatter, hit
  height, geometry points.

Excluded on purpose: images, materials' visual side, lights, reflections, camera, DMD and backglass
settings, sounds, the script. So a VR or performance edit leaves the fingerprint unchanged; a widened
flipper gap or a removed outlane post changes it. The fingerprint is a SHA-256 over a canonical JSON
of those fields (sorted keys, floats rounded to 6 places).

**Slope, precisely.** The file stores slope min and max in degrees as floats. Effective slope =
min + difficulty × (max − min), where difficulty is the table's stored value unless the player
overrides it in the tweak menu or the ini. Most tables set min = max, which makes it one number.

**What the file cannot tell, and the two fixes.**

- **Ini attestation (basic mode, now).** Read `VPinballX.ini` and the per-table `<table>.ini` at
  launch and again at exit: physics override set in use, difficulty override, nudge strength, and the
  VPX 10.8 table options the player chose (10.8 moved most VR and visual toggles into ini-backed
  options, which also means fewer legitimate script edits exist at all). Reported as a small `ini`
  object; Sanctioned requires "no physics override".
- **Engine attestation (live mode, Phase 3).** Many modern tables set flipper physics from script at
  runtime. The injected hook samples the live table and flipper values at game start and each ball
  end and journals them. **Open item:** which table and flipper properties are readable from script
  must be verified against VPX's interface definition on the owner's rig before the field list is
  promised; a Phase 3 spike item.

## 4. Script inspection (diff and classify), not a script hash

**Which script actually ran.** VPX 10.8 loads a same-basename sidecar `.vbs` instead of the embedded
script, and both include shared files from `scripts\` (`core.vbs`, `VPMKeys.vbs`, controller and
helper files). The running script is therefore the embedded one or the sidecar, plus the includes.
VBScript cannot read its own source, so this stays file-side; the file is open in the running
process, so what the companion reads is what ran. The companion hashes the includes against the known
VPX 10.8.0 release copies; a modified include is itself a finding (Castcade's own bulk-mode patch,
ADR 0004, is a known diff and is exempt by content, not by name).

**Baseline.** Author downloads sit behind logins and licences, so they are never fetched
automatically. Three sources, combined: the runner uploads the script from their own copy when they
set Sanctioned play on a game; consensus among participants' companions confirms it (most common
normalised script hash); and a curated baseline per VPS table id accumulates over time. The companion
downloads the baseline and diffs locally; **only the diff and its classification leave the player's
machine**, never the full script.

**Normalise, then classify.** Strip comments, whitespace, line endings and case (VBScript is
case-insensitive) before diffing. Each changed hunk lands in one of three bins:

- **Allowed:** constants in the conventional options block (VR room, cabinet / desktop mode, DMD
  placement, volumes, lighting levels, ball reflection style), and anything expressed through the
  10.8 table options API.
- **Restricted:** changes touching physics identifiers (flipper strength / return / EOS, gravity,
  slope, friction, elasticity, ball mass or size), ball saver and balls-per-game constants, extra ball
  logic, score routines on originals, the ROM name (`cGameName`), and any *added* `CreateBall`,
  `DestroyBall`, switch writes or pulses, timers that write switches, or new `Execute`,
  `ExecuteGlobal`, `Eval`, `GetRef`. The last group matters because string-built code is how a
  cheat hides from a pattern scan; a *new* dynamic-code call in a diff is restricted even though the
  baseline legitimately uses `ExecuteGlobal` for includes.
- **Unknown:** everything else, shown to the runner for a yes or no, remembered once answered
  (per table baseline, so the second player with the same edit is not asked again).

**Preflight before anything public.** The check runs at launch and the companion shows the verdict
before ball one: "two allowed edits; one restricted: `BallSaverTime` 20 → 999; fix it or this game is
unranked". The runner sees every diff report. Making reports visible to the whole group is a
per-tournament setting defaulting to runner-only: the deterrent is the preflight, and group visibility
turns an honest mistake into a public event.

## 5. What script inspection misses, and what catches it

- **Machine adjustments on ROM tables.** Balls per game, ball save time, extra ball percentage,
  free play, tilt warnings live in the ROM's operator menu, stored in NVRAM. The maps corpus decodes
  adjustments for many ROMs; the companion reports deviations from factory defaults. This is the most
  common "cheat" in real tournaments and nothing script-side sees it.
- **ROM revision.** Different revisions change rules. Sanctioned pins the ROM id (already sent).
- **VPinMAME's cheat flag and modified binaries.** Report the per-ROM `cheat` option from the
  VPinMAME registry settings; hash the VPX executable and the VPinMAME DLL against known release
  builds. A custom build is flagged, not refused (people do compile their own).
- **Memory trainers.** A tool editing the score in RAM shows as score jumps between live journal
  samples larger than the machine's largest single award, and as scores off the ROM's scoring
  granularity. Flag for review (live mode).
- **Restarts and mid-game quits.** Covered by the launch and exit reports (v0.2.3) and the ball-1
  restart counter in the Duels design.
- **Macros and bots.** Not detectable from data with confidence. The answer is the opponent's live
  video in Castcade matches (Phase 4) and, optionally, a recording kept for the ruling.
- **A modified Castcade.** The ceiling. Signed official builds at GA raise the bar; they do not
  close it. Sanctioned arenas pair the data checks with live video.

## 6. Build hashes

The companion already knows the VPX exe path; it adds SHA-256 of the exe and of `VPinMAME64.dll` /
`VPinMAME.dll`, compared against a small table of known 10.8.0 release builds (official, GL, VR)
shipped with the companion and extensible from ArcAid. Unknown → `build: { known: false }`.

## 7. Build order (companion first, every step shippable on its own)

| Step | Where | What ships | Needs from ArcAid |
|---|---|---|---|
| F1 | companion | VPS game/table id resolver (ROM → game, TableInfo → table, confirm-once UI), `vps_game` / `vps_table` / `table_sha256` / `table_save_rev` on the wire, shown in Status | nothing (params ignored until item 11) |
| F2 | companion | ini attestation, NVRAM adjustments report, build hashes, VPinMAME cheat flag | nothing |
| F3 | ArcAid | item 11: `tournaments.integrity_mode`, per-game required table + baseline, evidence stored per score, runner review view, match by `vps_game` first | F1 |
| F4 | companion | playfield fingerprint (compound-file reader + record walker, shared with the Phase 3 importer) | F3 to enforce |
| F5 | companion + ArcAid | script diff: baseline download, normalise, classify, preflight verdict, diff report (item 12) | F3 |
| F6 | companion (Phase 3) | engine attestation from the live hook; score-jump plausibility | F3 |

Gate for F1–F2: the owner's Monster Bash capture arrives with `vps_game` = Monster Bash's id,
`vps_table` = the VPW mod's id, a stable fingerprint across two launches, and an ini object that
changes when the owner flips a physics override on and back off.

## 8. Open questions

- Script-readable table / flipper properties on 10.8.0 (engine attestation field list).
- Exact record tags for every fingerprint field (take them from VPX's source and `vpxtool`'s parser,
  pin the list in a fixture so a VPX update that renames a tag fails a test, not a tournament).
- Baseline licensing: **settled 2026-10-18.** The runner uploads a script they own a copy of, for the
  private use of the tournament; ArcAid stores it per tournament game, never publishes it, and deletes it
  with the tournament. The owner is comfortable with this for Sanctioned play ("it would contain nothing
  personal").
- Whether the ROM→VPS game map lives in the companion (shipped, like the maps corpus) or is served by
  ArcAid (correctable without a release). Recommendation: served by ArcAid with a shipped seed.
