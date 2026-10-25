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

**Shipped (B4, 2026-10-25; `companion/src/witness/playfield-fingerprint.ts`).** Sent as `fingerprint=pf1:<sha256>`.
What the code does beyond the list above: an item is included only when its own collidable flag is set (`CLDW` walls,
`CLDR` ramps / rubbers / primitives / targets, `COLI` bumpers, `GCOL` gates, `EBLD` kickers; flippers, spinners and the
plunger always), and a primitive marked toy (`ISTO`) never is; gates, spinners and hit targets are in because the
ball hits them; a collidable 3D-mesh primitive contributes vertex positions and triangle indices only; an item whose
overwrite-physics flag (`OVPH`) is off takes its physics from the named material (`MAPH`), whose four physics values
come from `GameData`'s `PHMA` record (48 bytes each); items are sorted by content, so names and order are not hashed.
Every tag was checked against vpxtool 0.33.9's JSON on Monster Bash (6,482 values, 0 mismatches; all 132 materials).
Known limit: a VR mod that adds a *collidable* object (rare: VR cabinets are toys) changes the fingerprint; the
runner blesses the fingerprint of the file the tournament uses.

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

**Shipped so far (B5.1–B5.2, 2026-10-25; `companion/src/witness/script-diff.ts`).** Normalisation also splits `:`
statements and joins `_` continuations, and keeps string literals' case. The baseline today is the table's own
embedded script: no sidecar = embedded ran (no report); Castcade's sidecar is undone exactly by its markers and
templates (`unpatchRecipeA`), so only a person's edits remain; any other sidecar is diffed as it is. The classifier
works on names, not on position: VPW's options block mixes `VRRoom` and `VolumeDial` with `OutLaneDifficulty`,
`Rubberizer`, `FlipperCoilRampupMode` and `TargetBouncer*`, so "constants in the options block" is not safe as an
allow-list. The score carries `script_diff` (compact JSON, capped at 3,000 characters: restricted hunks first, counts
always whole). Flag only. The runner's baseline, the preflight verdict and remembered answers wait on ArcAid item 12
(B5.3); shared includes against the 10.8.0 release copies are B5.4.

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
  granularity. Flag for review (live mode). **Shipped as facts plus one flag (B6.1, 2026-10-25):** the maps carry
  no award values and a hand-written per-game maximum was ruled out, so the companion reports the largest jump
  without a ceiling and flags only a jump off the ROM step of 10 (`score_plausibility`; flag only, never a gate).
- **Restarts and mid-game quits.** Covered by the launch and exit reports (v0.2.3) and the ball-1
  restart counter in the Duels design.
- **Macros and bots.** Not detectable from data with confidence. The answer is the opponent's live
  video in Castcade matches (Phase 4) and, optionally, a recording kept for the ruling.
- **A modified Castcade.** The ceiling. Signed official builds at GA raise the bar; they do not
  close it. Sanctioned arenas pair the data checks with live video.

## 5a. Accelerometer lifts (owner ask, 2026-10-20)

A player with an accelerometer nudge device (Pinscape, KL25Z, Mot-Ion, a desktop controller) can lift
or hold the device tilted so the ball is pushed up the playfield: away from a drain, or against a
target bank. What VPX 10.8.0 does with that input, from the source (`player.cpp`, `plumb.cpp`,
`pintable.cpp`, `dialogs/KeysConfigDialog.cpp` at v10.8.0-2051):

- The axis is read as an **acceleration** every physics frame, scaled by `PBWAccelGainX/Y` (default
  150%) and capped by `PBWAccelMaxX/Y`, and added to the table's motion. A held tilt is a constant push
  for as long as it is held; it does not change the slope, it adds to gravity's in-plane component.
- The **nudge filter** was written to reject exactly this, but its sustained-tilt branch ("more than
  500 ms of one-sign motion is gravity, ignore it") is commented out in 10.8.0 because Mot-Ion and
  Pinball Wizard controllers drift. What is left only damps the running sum. `EnableNudgeFilter` helps
  a little and blocks nothing.
- The **virtual plumb bob** (`TiltSensitivity`, 0–1000, default 400) trips a tilt once the bob's
  displacement passes `1 − value/1000` of its range, so **a higher value tilts sooner**; 0 disables
  analog tilt. The bob reads the raw axis, **before** `PBWAccelGain`, so a cheater who raises the gain
  gets a bigger push for a physical tilt that stays under the bob's threshold: the two settings must
  be ruled together. The key is loaded with its default even when the dialog box is unticked (a bug
  the source itself notes), so "absent" means 400, not off.

**Rules (Sanctioned play, runner-configurable per tournament with these defaults):**

| Rule | Reads | Default | Fails when |
|---|---|---|---|
| `min_tilt_sensitivity` | `ini.tilt_sens` (effective) | **300** (owner's provisional number; VPX default 400) | `tilt_sens < min` (0 = analog tilt off always fails while `accel` is on) |
| `max_accel_gain` | `ini.accel_gain_x/y` (percent) | **150** (VPX default) | either axis above the max while `accel` is on |
| `require_nudge_filter` | `ini.nudge_filter` | off | `nudge_filter !== true` |

The runner sets them on the tournament in Sanctioned play (item 11); a player with no accelerometer
(`accel === false`, or no PBW keys at all) passes all three. **Shipped in companion 0.2.8:** the keys
ride in the `ini` object (`accel`, `accel_gain_x/y`, `accel_max_x/y`, `accel_velocity`, `nudge_filter`,
`nudge_sensitivity`, `tilt_sens`, `tilt_sens_set`) and Status shows the gain and the tilt sensitivity on
the Nudge row (warning colour only for "analog tilt off"). Settings bound the payoff; they cannot see
the lift itself.

Two things the keys do not settle on their own. A table script can rewrite these settings at run
time: the script global `NudgeSetCalibration(XMax, YMax, XGain, YGain, DeadZone, TiltSensitivity)`
saves the gains, maxima and tilt sensitivity into the player's settings and re-reads them at once
(`pintable.cpp`). The companion measures the ini when the table becomes known and again at capture,
so a value a script sets for the game is seen at capture, and the script diff (F5) sees the call
itself. And the number only means something for the VPX plumb bob: `vpmNudge.Sensitivity` in a
VPM table's script (1 in the owner's Monster Bash) and the ROM's own tilt-warning adjustment are
separate knobs that govern keyboard nudges and the machine's tilt count, not the analog plumb.

**In-game menus are the hole in ini reading (found 2026-10-20).** VPX's own tweak menu (`LiveUI.cpp`)
changes *Difficulty* live in memory (`m_globalDifficulty`, which sets the slope between the table's
min and max) and writes it to the table ini only when the player presses the Start key on the tweak
page; an unsaved change is in force for the game and on no disk anywhere. The Keys dialog is the
opposite: it saves the whole settings file on OK. The Panasony VR build adds its own in-game page
(labels in the exe: *AnalogNudge X/Y-Gain*, *AnalogNudge X/Y-Max*, *DigitalNudge*, *Difficulty*,
*Slope*, *VisualNudgeStrength*, *VisualAnalogNudgeGain*) with keys stock 10.8.0 does not know
(`AnalogNudgeGainX/Y`, `DigitalNudge`, `TiltInertia` in `[Player]`; `nudgestrength` in `[PlayerVR]`),
so on that build the nudge the player actually gets may be governed by a key the 0.2.8 `ini` object
does not carry, and `max_accel_gain` reads `PBWAccelGain`, which may not be the live knob there. The
owner's rig (2026-10-20) had `AnalogNudgeGainX/Y = 1965/1996` beside `PBWAccelGain = 115`, and VPX
had been open since 2026-10-18 with the owner reporting a tilt sensitivity of 10 in force while every
file on disk said 500: unresolved until that VPX exits and rewrites its ini.

Consequences. (1) Ini reading is a *settings at launch* statement, never a *settings during the game*
one; Status should say so. (2) **Shipped (hook 0.4.0, B6):** the live hook closes the hole from inside: at hook
time and at every key-down the script calls `NudgeGetCalibration` (the in-memory global settings: gains, maxima,
dead zone, tilt sensitivity) and reads `GlobalDifficulty`, `SlopeMin`, `SlopeMax`, `OverridePhysics` and the
table physics from `ActiveTable`, and journals an `engine` line when anything changed, so an in-game change shows
up at the next key press (finer than the ball it was made on). The companion sends the sample in force at game
start and every change on the score as `engine`; ArcAid's Sanctioned rule for it is `docs/arcaid-side-changes.md`
§14. That is the F6 "engine attestation" row. (3) Build-specific knobs: for a declared `panasony` family the hook also
journals the Panasony keys by name once their meaning is confirmed with the author or by experiment on
the owner's rig; until then the `ini` object carries them raw for the runner's eyes (0.2.9 candidate).

**Nudge telemetry (Phase 3).** The companion opens the same HID joystick read-only beside VPX (these
devices allow non-exclusive reads) and samples the nudge axes at 100 Hz or better for the session. A
real nudge is a brief bipolar impulse (push, rebound, zero within ~300 ms); a lift is a one-sided step
held for seconds. A windowed mean against the peak separates them and the integral of the held value is
the free push the player gave themselves. Correlated with the ball timeline from the live journal
(drain and ball-in-play times; NVRAM ball boundaries in basic mode), the signature is a held tilt in
the seconds before a drain or a long hold with the ball on a target bank. Output: a compact `nudge`
param on the score (nudge count, longest held tilt and its magnitude, share of ball time under tilt),
the raw trace kept locally for a ruling, badge never gate, Sanctioned thresholds set by the runner.
Keyboard nudges are key events the script hook already sees, so their count comes for free. Limits:
Pinscape firmware auto-centres slow drifts, so a very gradual tilt is invisible to the device, to VPX
and to us (smaller payoff, not zero); a synthetic joystick (vJoy) is the same ceiling as a modified
Castcade; live video stays the backstop. The owner's rig has an accelerometer configured and is the
calibration bed for the impulse-versus-hold classifier.

## 6. Build hashes

The companion already knows the VPX exe path; it adds SHA-256 of the exe and of `VPinMAME64.dll` /
`VPinMAME.dll`, compared against a small table of known 10.8.0 release builds (official, GL, VR)
shipped with the companion and extensible from ArcAid. A hash that is not on the list is sorted into
a *family* from the binary's version resource: `panasony` (the Panasony VR community builds, which the
owner runs and ruled allowed in Sanctioned play on 2026-10-19), `nightly` (upstream build number past
the release), else `unknown`. Families other than `official` are declared by the binary, not proven;
that sits under the honest ceiling in §5.

## 7. Build order (companion first, every step shippable on its own)

| Step | Where | What ships | Needs from ArcAid |
|---|---|---|---|
| F1 **(shipped v0.2.4, 2026-10-18)** | companion | VPS game/table id resolver (ROM → game, TableInfo → table, confirm-once UI), `vps_game` / `vps_table` / `table_sha256` / `table_save_rev` on the wire, shown in Status | nothing (params ignored until item 11) |
| F2 **(shipped v0.2.5, 2026-10-19; 0.2.7 build families; 0.2.8 accelerometer + analog-tilt keys)** | companion | ini attestation, NVRAM adjustments report, build hashes, VPinMAME cheat flag; build `family`; accelerometer gain, tilt sensitivity (§5a) | nothing |
| F3 **(shipped: ArcAid #370 v2.165.0 + #371 v2.166.0, ADR 0027; companion 0.2.9–0.2.10)** | ArcAid | item 11: `tournaments.integrity_mode`, per-game required table + baseline, evidence stored per score, runner review view, match by `vps_game` first | F1 |
| F4 **(shipped: B4, 2026-10-25; the bless UI is ArcAid F12)** | companion | playfield fingerprint (compound-file reader + record walker, shared with the Phase 3 importer) | F3 to enforce |
| F5 | companion + ArcAid | script diff: baseline download, normalise, classify, preflight verdict, diff report (item 12) | F3 |
| F6 **(engine attestation shipped: hook 0.4.0 + companion, WORK B6, 2026-10-22; the rest open)** | companion (Phase 3) | engine attestation from the live hook (`engine` line at hook time and every key-down, on the score as `engine`); score-jump plausibility (B6.1, `score_plausibility`, 2026-10-25); nudge telemetry (§5a: HID trace, lift detector, `nudge` param) | F3 |

Gate for F1–F2: the owner's Monster Bash capture arrives with `vps_game` = Monster Bash's id,
`vps_table` = the VPW mod's id, a stable fingerprint across two launches, and an ini object that
changes when the owner flips a physics override on and back off. F1's half of the gate is covered by
the unit tests on the owner's exact sequence (`witness.test.ts`, synthetic table files with the real
TableInfo values) and by a read-only run of the reader against the owner's three VPW tables (all
values matched; 350 KB read of a 184 MB file; hash 0.2–0.4 s warm). F2's offline half passed the
same way on 2026-10-19 (read-only run against the rig): Monster Bash reads stock physics, table
difficulty 0.56, slope 6.56°, no table options; Medieval Madness slope 6.5° fixed; both exes and the
DLL hash and version in under 0.4 s; the DLL is found through the COM registration; the cheat flag
reads `off` for both ROMs; a real Attack from Mars `.nv` reports one non-factory adjustment (Max E.B.
Per B.I.P). The "flip an override on and back off" half and the live half (the values visible on
arcaid.app once item 11 lands) are pending.

**Implementation notes (F2).** Verified against the VPX 10.8.0 source (v10.8.0-2051): the
physics-set override is a **property of the table file** (`ORRP` int, 0 = none, 1–8 = set; `ORPF`
flipper flag), not an ini key; the ini only holds the eight sets' values (`[Player]
TablePhysics*N`, `FlipperPhysics*N`, `PhysicsSetNameN`, 0-based). The table's own difficulty is
`TDFT` (0–1); the tweak menu writes the override to `[TableOverride] Difficulty` in the table's
`<table>.ini` (beside the `.vpx`; `-TableIni` overrides), whose values sit on top of the global ini
(`-Ini`, else `<exe dir>\VPinballX.ini` when it exists, else `%APPDATA%\VPinballX\VPinballX.ini`).
Table options live in `[TableOption]` under the author's own names ("Outlane Difficulty" = 1.0), so
they are reported by name and value, not interpreted. **Adjustments:** at the pinned corpus commit
92 of 383 maps carry an `adjustments` block (Attack from Mars, Demolition Man, Dracula yes; Medieval
Madness, Monster Bash, Tales from the Crypt no), so "no adjustments map" is the common case and must
never read as "factory". `default`, `min` and `max` describe the **stored** value, before `scale`
and `offset` (corpus README), so the factory comparison uses the stored value and the report carries
both. The companion checks a fairness subset by label (balls per game, tilt warnings, extra ball,
ball save, replay, pricing/free play, special award, match, difficulty, timed plunger, buy-in), at
most 24 entries. **Builds:** the known list is seeded from the official release assets, hashed on
2026-10-19 (VPX v10.8.0-2051 DX/GL × x64/x86, VPinMAME v3.6.0-1227 x64/x86/-sc). The owner's own
rig runs Panasony community builds 10.8.0.2078/2079 and a VPinMAME 3.7.0.222 nightly, so in 0.2.5
**the owner's own scores read "not an official release build"**. 0.2.7 replaced that flag with a
build *family* read from the version resource (`official` / `panasony` / `nightly` / `unknown`), shown
without a warning colour, and the owner ruled (2026-10-19) that the Panasony VR mod is allowed in
Sanctioned play; ArcAid item 11 treats `official` and `panasony` as passing by default, nightlies as a
runner toggle, and `unknown` as needing a blessed hash (a runner's own, or one several devices report). Version strings come from the PE
`VS_VERSIONINFO` block (`FileVersion` carries the builder tag, e.g. `10.8.0.2079.Panasony`). The
cheat flag is `HKCU\Software\Freeware\Visual PinMame\<rom>\cheat`, falling back to `default`.

**Implementation notes (F1).** The `.vpx` reader walks the compound file's FAT and directory on
demand and reads only TableInfo and `GameStg/GameData`; a 1 GB table costs a few hundred KB of reads.
TableInfo strings are UTF-16LE without terminator; `Manufacturer`/`Year` exist only when the author
filled the custom tags (Monster Bash yes, Medieval Madness and Tales from the Crypt no), so the file
name's `(Manufacturer Year)` and the ROM stay the primary game signals. Physics floats are the exact
float32 values widened to double (0.20000000298023224, not 0.2); ArcAid-side comparison must round or
compare as float32. Table matching scores authors (+4 lead author, +2 other), version equality (+3,
near +1.5), feature words in the file name (+1 each) and VPS comment words (+0.5); `exact` needs a
lead of 3 with author or version evidence, `likely` a lead of 1, else `ambiguous` and the picker.

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
