# vpx-hook/

**Status: Phase 0 run 2026-10-17, all gates passed with `castcade.vbs` 0.1.0 on VPX 10.8.0 (results and
findings: `docs/phase-0-spike.md` §8). 0.2.0 (2026-10-21) adds `Castcade_Guard`, the in-script stale-sidecar
check; nothing else changed. `spike/` = renderer, staging, tailer, lock, capture test, autoplay.
Production recipes = Phase 3. Known 0.1.0 cost to fix in Phase 3: the hook journals every changed NVRAM byte
(~200 deltas/s on WPC, ~95 KB/s) and the periodic full snapshot costs a 50–150 ms frame; filter to the mapped
`game_state` region and take the snapshot off the hot path.**

Everything that runs inside the Visual Pinball X process. Pure VBScript, no DLL, no COM registration
(ADR 0001). The script does one job: append events to a journal file and read one lock flag. All
decoding, detection and networking happen in the companion.

## What lives here

- `castcade.vbs` — the shared library every patched table `ExecuteGlobal`s: journal writer
  (one handle, opened at table load and closed at table exit; each line is readable the moment it is written; since
  **0.6.0** that handle is the companion's journal pipe while the companion runs, the file otherwise), the
  `NVRAMCallback` **chaining guard** (`Castcade_RegisterNVRAM`), the lock check the sidecar's
  `_KeyDown` / `_KeyUp` wrappers call (`Castcade_KeyDownBlocked` / `Castcade_KeyUpBlocked`), helper
  subs for originals (`Castcade_GameStart`, `Castcade_Scores`, `Castcade_BallEnd`, `Castcade_GameEnd`),
  and since **0.2.0** the in-script half of the stale-sidecar guard, `Castcade_Guard` (below).
  The event list is in the file header. Exercised outside VPX with a `cscript` harness (2026-10-17).
  Installed by the companion's `patcher` module (`companion/src/patcher/`), which ships this file as
  `resources/hook/castcade.vbs` and writes it to `<VPX>\scripts\castcade.vbs` only when the bytes differ;
  `LIB_VERSION` in `companion/src/patcher/render.ts` must equal `Castcade_LibVersion` here (a test checks).

### 0.2.0 — `Castcade_Guard` and the `stale_sidecar` event

A recipe-A sidecar rendered by the companion calls, right after `Castcade_Init`,

```vbs
Castcade_Guard "<original .vpx path>", <size in bytes>, "<yyyy-mm-dd hh:nn:ss local mtime>", "<this .vbs path>"
```

with the original's size and mtime as they were at render time. At table load the library compares them
with `GetFile(original).Size` / `.DateLastModified` (mtime within ±3601 s, because DST and FILETIME
conversions shift it by a whole hour; size is the strong signal; VBScript cannot hash). On a mismatch it
journals `stale_sidecar` (`detail`: `size <a> vs <b>; mtime <a> vs <b> (<diff> s)`, plus `original`),
renames the sidecar to `<Table>.vbs.stale` (replacing an older `.stale`) and shows a `MsgBox`: *"This
Castcade patch was made for an older version of this table. It has been disabled - close the table,
relaunch it, then re-import it from Castcade."* The table keeps running on the old script for that one
session; the next launch loads the embedded script. A missing original is not a mismatch. 0.1.0 sidecars
do not call the sub and keep working; a 0.2.0 sidecar on a 0.1.0 library skips the call silently
(block 0 runs under `On Error Resume Next`). The companion's `journal-detector.ts` parses the event.

### 0.3.0 — `Castcade_WatchBytes` and the journal volume

The owner's first live-mode session (2026-10-22, Monster Bash on the VR build) measured the 0.1.0 cost for real:
a median of 89 `nvram_delta` lines a second, peaks of 180, 22.6 MB in seven minutes, visible stutter and one VPX
crash. 0.3.0 journals only what the companion decodes. The sidecar (recipe 0.3.0) calls, in block 0,

```vbs
Castcade_WatchBytes Array(<every NVRAM offset the ROM's map reads for game_state>)
```

and `Castcade_NVRAM` then keeps only those offsets of each `ChangedNVRAM` batch, coalesces them (latest value
per offset, the first old value), writes at most one `nvram_delta` line per 50 ms and flushes it at once, so
the companion sees a game end within a frame or two. The full snapshot is taken once, at hook time (it is what
the adjustments are read from), never periodically. An empty watch list (a ROM the maps corpus does not know)
journals no deltas at all: nothing could decode them, and basic mode still reads the `.nv` at close.

**Recipe 0.3.1 (companion 0.2.14, B10):** the offsets in the watch list count from the start of the platform's NVRAM
region, as `ChangedNVRAM` does. Recipe 0.3.0 wrote the map's machine addresses, which are the same numbers only where
NVRAM starts at 0 (WPC, Data East, Whitestar, System 11, Gottlieb System 3); on Stern SAM (0x02100000), Gottlieb
System 1/80/80B (0x1800), Bally and Stern M100/200 (0x200) and Williams System 4–7 (0x100) nothing matched and no
delta was journaled. The bump makes every sidecar stale, so the folder watch re-makes them all on its first look.
For Stern SAM the list also carries the end-of-game counter (`samEndCounter` in `companion/src/witness/maps.ts`).
`table_exit` gains `filtered_bytes`. Without a watch list (0.1.0 / 0.2.0 sidecars) the old behaviour stands.
The companion computes the list with `watchOffsets(map)` (`companion/src/witness/maps.ts`) when it renders
a sidecar; re-importing the folder re-renders every table with it (an older recipe version plans as `repatch`).

**Recipe 0.3.2 (A16.2):** the watch list also holds the bytes of the map's `high_scores` block (each entry's
initials and score, `highScoreOffsets(map)`), so the journal shows the machine writing a high-score entry: the
companion ends a match's initials hold on it. Still `nvram_delta` lines; no lib change. Those bytes change only when
the machine writes its list, so the journal volume during play is what it was.
### 0.4.0 — `Castcade_EngineSample`: what VPX has in force, from inside the table (F6)

Ini reading is a *settings at launch* statement (`docs/design/fairness-and-table-identity.md` §5): VPX's tweak
menu changes difficulty in memory and writes it to disk only when the player presses Start on that page, so an
unsaved change is in force for the game and on no file anywhere. 0.4.0 reads the live values through the script
API — `ActiveTable.GlobalDifficulty / SlopeMin / SlopeMax / OverridePhysics / Gravity / Friction / Elasticity /
ElasticityFalloff / Scatter / NudgeTime` and the global `NudgeGetCalibration` (nudge gains, maxima, dead zone,
tilt sensitivity) — once at hook time (`reason=init`) and at every key-down (`reason=key`), and writes an
`engine` line only when something changed:

```
{"event":"engine","t":412.3,"reason":"key","difficulty":80.0000,"slope_min":6.5000,"slope_max":6.5000,
 "physics_set":0,"gravity":0.9700,"friction":0.0750,"elasticity":0.2500,"elasticity_falloff":0.0000,
 "scatter":0.0000,"nudge_time":5.0000,"nudge":{"xmax":700,"ymax":700,"xgain":115,"ygain":115,"dead_zone":0,"tilt":400}}
```

`difficulty` is VPX's `GlobalDifficulty` as the script API returns it, **0–100** (the table file and the ini store
0–1: Medieval Madness file 0.5, live 50.0, 2026-10-25); the companion divides by 100 when it reads the line, and the
harness's fake `ActiveTable` used 0–1, which hid it until the first real game. `gravity` is in the script API's unit
too (Medieval Madness live 0.97, file 1.76); nothing compares it to the file. A dozen property reads per key press, no line when nothing changed, floats with four decimals and a `.` whatever
the user's locale. A read that fails (an older VPX, a property a build lacks) leaves its field `null`; without
`ActiveTable` nothing is written. The companion keeps the sample in force at each game start and every change
until the game ends, sends them on the score as `engine` (compact JSON), and names an in-game change in the
capture detail ("CHANGED DURING THE GAME: difficulty 20% → 80%"). No recipe change: a 0.3.0 sidecar loads
the 0.4.0 library as is; the folder watch re-makes the manifests on the first look. Harness:
`cscript engine-harness.vbs` with a fake `ActiveTable` (three lines: init, a difficulty change, a tilt change).

### 0.4.1 — `Castcade_Guard` is silent when it runs from the table itself (C10)

The VPX editor loads a sidecar as the table's script and saves it back into the `.vpx` (Krobs, 2026-10-29, after a
colour change). The patch then runs embedded, with no sidecar beside the table and a stamp that can never match again:
0.4.0 showed the stale dialog at every launch with nothing to rename. 0.4.1 checks the sidecar path first: when it does
not exist the script is the table's own, script and table were saved together, nothing is stale; the library journals
`embedded_patch` (`original`) and returns. Everything else in the guard is unchanged. The companion renders a fresh
sidecar over such a table (importer `patchSource`, witness notice → `TablesHost.repair`), so the embedded copy only ever
runs until the next launch. No recipe change; the lib bump makes the folder watch re-make every sidecar on its first look.
Checked with a `cscript` harness: an existing original and a missing sidecar journal `embedded_patch` and no `MsgBox`.

### 0.6.0 — the journal through the companion's pipe (C16.2)

0.5.2 left the `WriteLine` itself on VPX's render thread, and on the owner's PC a plain append to a held file sometimes
takes 0.1 to 2.8 s: in an 18.5 minute VR game (2026-11-16, lib 0.5.1) the two longest frames after the table's start,
136 and 406 ms, had the render thread inside `WriteFile` under `scrrun`. 0.6.0 makes no file-system call for the
journal on that thread while the companion runs (spike and data: `castcade-vpx-deps\run\journal-pipe-spike`):

- `Castcade_Init` opens `\\.\pipe\castcade-journal` once, with `OpenTextFile(pipe, 8, True, 0)` (append, ASCII as the
  file is; the Unicode formats hang on a pipe or send a byte-order mark), and writes one transport header,
  `#castcade-journal 1 <file name>` (the `Castcade_SafeName` name, `.jsonl`). The companion's worker
  (`companion/src/witness/journal-pipe-server.ts`, on a thread of its own) consumes the header and appends every later
  byte to `%LOCALAPPDATA%\Castcade\journal\<file name>`: whole lines, in order, so the file is byte for byte what the
  script writes in file mode, and the tail, the detector, the fixtures and the evidence are unchanged. No journal line
  changed except `lib` in `table_loaded`.
- No companion: the open fails with error 53 in under 10 ms and the script writes the file itself for the whole
  session, as in 0.5.2. The pipe is tried once per table load and never again during that session.
- The companion gone mid-game (quit, crash): the next `WriteLine` raises within about a millisecond; that line goes to
  the file and so does every later one until the table exits. What can be lost is only what the script had already
  handed to the pipe and the worker had not appended: one run of lines right before the failing one (none in about 26
  kills at a game's pace, a line every 25 ms; 6 to 16 short lines when the script wrote thousands a second). Because a
  lost `nvram_delta` (or the first `nvram_full`) would leave the companion's shadow NVRAM wrong until those bytes change
  again, a table with the NVRAM hook writes one fresh `nvram_full` at its next NVRAM callback after the failover
  (`Castcade_Resync`; there and not in `Castcade_Write`, which may run in a key handler or at table exit, where
  `Controller` may be stopping). The detector takes a later snapshot as ground truth.
- One writer per journal file. A second VPX on a table whose journal is being written (names compared without case,
  as Windows does) is refused once the worker holds the file: its script fails over, its open of the held file fails
  (error 70), and its lines are not kept, which is what happened to the second opener before 0.6.0. Two sessions'
  lines interleaved in one file make the detector invent games.
- `Castcade_PipeName`, a global a harness sets before the library loads, names another pipe (`""`: the file only).
  No test uses the production name.

The one danger the spike found is the reader's to avoid: a reader that stops reading blocks `WriteLine` without limit
once about 124 KB are unread. The worker only drains the pipe, never pauses a connection, and a slow disk grows its
queue in memory (capped at 64 MB, then lines are dropped with one warning), never the pipe's unread bytes. When VPX
exits, the witness asks the worker for that journal's last lines before it reads the end of the game, posts it, or tells
a match the table closed (once per exit, bounded at 10 s; names compared without case, since the witness spells the
journal as VPX was given the table). Checked with cscript harnesses against the real worker
(`companion/src/witness/journal-pipe-cscript.test.ts`): the same bytes in both modes; the main thread blocked 6 s
while the script writes 300 KB, no `WriteLine` over 250 ms (a drain on the main thread: 5.97 s); a disk write stalled
3 s, the same; the worker killed mid-game (and the fresh `nvram_full` after the failing line); a second VPX on the same
table refused, the first one's journal as if alone; the same table again after its session ended. Through the library's own write path on the owner's PC
(`vpx-hook/spike/journal-pipe-bench.ps1` driven by `companion/scripts/journal-pipe-bench.ts`, 9,000 lines 20 ms apart
beside a held-file append, two runs on 2026-11-16): the pipe line took 0.09 ms (median), 0.5 ms (p99), 2.8 and 2.9 ms
at worst, never 5 ms; the file line beside it took 50 ms or more 2 and 1 times, at worst 417 ms and 1.58 s; every
piped line was in the journal, in order. `Castcade_Locked`'s `FileExists`, timed in the same runs: 0.24 ms (median)
on an existing file, 0.1 ms on a missing one, at worst 3.2 and 14.7 ms. No recipe change; the lib bump makes the folder
watch re-make every sidecar on its first look.

### 0.5.2 — no close and reopen of the journal while the table runs (C16)

`Castcade_Write` closed the journal and opened it again after every event and every watched `nvram_delta` (and every 50th
line otherwise) so the companion would see the line at once. It runs on VPX's render thread. On the owner's PC
(2026-11-16, Windows Defender real-time protection on) four freezes of a 147 s VR game of Congo, 47 to 688 ms long, each
began within 3 ms of a journal line, and a quiet Windows Script Host loop measured the reopen at 7 ms on average, worst
74 ms. The close was never what made a line visible: a `TextStream` holds nothing back, and the companion's own
`JournalTail` reads each line on its first poll after `WriteLine` returns while the file is still open
(`sidecar-cscript.test.ts`, "C16 premise"). 0.5.2 opens the journal at `Castcade_Init` and closes it at `Castcade_Exit`
only; `Castcade_Write` lost its `flush` argument. A failed open is still retried at the next write. Through the library's
own write path (1000 to 2000 lines paced 20 ms apart on a 400 KB journal, timed per call around a ScriptControl call)
one line took 20 ms on average, worst 0.97 to 1.29 s, every line over 11 ms; it now takes 0.15 ms (median), average
0.3 to 1.0 ms, with three to six lines in a thousand over 11 ms (worst 140 to 694 ms), the same as a plain append from
Node with a held handle on that PC. No recipe change, no journal format change; the lib bump makes the folder watch
re-make every sidecar on its first look. Checked with a `cscript` harness: with the journal made read-only after table
load (so any reopen would fail), every later line still arrives, the tail reads each one on its next poll, and the file
can be renamed only after `Castcade_Exit`.

### 0.5.1 — a sitting longer than 44 minutes keeps reporting (C15)

`Castcade_NVRAM` stopped journaling after 300000 callbacks (the 0.1.0 runaway guard, from when every changed byte was
written). core.vbs calls it about 114 times a second whether a game runs or not, so the journal went silent 44 minutes
after the table opened: in the owner's match QBPKHR (2026-11-15, Congo, three games in one sitting) the journal ends
at t = 2618 s, 28 seconds into his last ball, and the match waited for a ball end that was never written. The guard
now applies only without a watch list; with one, the volume is a few lines per score change. No recipe change; the lib
bump makes the folder watch re-make every sidecar on its first look. Checked with a `cscript` harness
(`sidecar-cscript.test.ts`): a watched change after 300010 callbacks is journaled.

### 0.5.0 — originals: `Castcade_PlayerScores` and the ScoreServer shim (C1.1)

Recipes B, C and D (`companion/src/patcher/render-originals.ts`, design §5 "As built") journal original tables from
their own variables through the existing `game_start` / `current_scores` / `ball_end` / `game_end`; no new kind the
detector needs. New in the library: `Castcade_PlayerScores(arr, base, players)` (a table's 0- or 1-based score
array → one entry per player) and `Castcade_ScoreServer()`, a `VPinball.ScoreServer`-compatible object (`SetGameName`,
`SetGameState`, `SetScoresArray`, `SetHighScoresArray`, `AwardBadge`, `ClearState`) that journals what a class-D table
reports and forwards every call to the real object when `CreateObject` finds one (LU's cabinet build). State 3 is
held until the next `SetScoresArray` / `ClearState` / `SetGameState` / table exit so `game_end` carries the final
scores. One informational line, `score_server` (`call` + `real` | `name` | `players, player, ball, state`), records the
calls (C1.1.1 evidence: whether a table ever says game over). Recipe A is unchanged; the lib bump re-makes every
sidecar on the folder watch's first look (B15: a script read each, no re-hash). Checked with a `cscript` harness over
synthetic B/C/D scripts: one game each journals start → scores → ball ends → end, with and without the library.

- `spike/vbs-compile.vbs` (C1.4): `cscript //nologo vbs-compile.vbs <script.vbs>` compiles one table script or
  rendered sidecar with the Windows VBScript engine and runs none of it (the text goes to `ExecuteGlobal` behind a
  first line that raises, and the engine compiles a whole text before its first statement). `OK` / `SYNTAX ...`,
  exit 0 / 1. Used by `companion/src/patcher/sidecar-cscript.test.ts` and `companion/scripts/validate-original.ts`.
  `spike/autoplay.py game --also 156` taps extra scancodes with every plunge (a lockbar or fire button that launches
  the ball).
- `spike/` — Phase 0 tooling, not product code: `render-sidecar.py` (section 4 classifier + recipes A
  and B, the ancestor of the companion `patcher`), `stage.ps1`, `tail-journal.py` (map decode +
  ball-end detector; ported to `companion/src/witness/journal-detector.ts` 2026-10-21, kept as the oracle behind `fixtures/check.py`), `lock.ps1`, `capture-test.ps1`, `autoplay.py`, `play-staged.ps1` (opens a staged copy in a chosen build with the tailer alongside)
  (SendInput scancodes: credits, Start, plunge-and-drain until the tailer reports `game_end`, plus the 0c lock
  exercise — lets a fixture be recorded unattended; VPX reads the keyboard through DirectInput so the player
  window is brought to the foreground first).
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
- No real work in VBScript, no network calls from the script, no close and reopen of the journal while the table
  runs (0.5.2): one handle from `Castcade_Init` to `Castcade_Exit`. While the companion runs, no file-system call for
  the journal on VPX's render thread at all (0.6.0): the handle is the companion's pipe, and the companion's reader
  must never stop reading it (an unread pipe blocks `WriteLine` without limit once about 124 KB wait).

## What does not live here

- The analyzer/classifier and the installer logic (companion `patcher` module).
- NVRAM map decoding (companion, using the `pinmame-nvram-maps` corpus).
- A plugin (`plugin-vpx/` is deferred until a stable plugin API ships in a release VPX).

## Read first

ADR 0001, ADR 0004, `docs/design/table-import-and-patching.md`, and
`ArcAid/tmp/vpx-desktop-witness/t7-sidecar/ArcaidTest_TFTC.vbs` (gitignored in ArcAid) for the
working probe this generalizes.
