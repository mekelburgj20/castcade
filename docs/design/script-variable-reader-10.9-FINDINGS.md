# Script-variable reader on upstream VPX 10.9 — findings

Status: spike done, 2026-11-21. Board item **I13**. Plan: `script-variable-reader-10.9.md`.
Everything here was measured on this PC on upstream `vpinball` master `c3c47b5bcf` (10.9.0, unreleased), built as
the MSVC standalone player (`winevbs64.dll`, Wine's VBScript, libwinevbs `db90ea99`), unless a line says "read in
code" or "not verified".

## 1. Answer

VPX can read a no-ROM table's own script variables while the table runs, with no change to the table or its
script, on the engine LU's cabinets run. A plugin turns the changes into game start, drained ball, game over,
abandoned game (restart) and quit, and writes records in the shape of LU's ScoreServer `game_end` lines.

**Recommended route: R1 as one small plugin-API call**, `GetScriptVariable(name, index, value)`, proposed to
upstream VPX. It reads through the script engine's global `IDispatch`; it never parses text and never runs script
code. Cost is flat at 9 to 14 µs for a whole poll and it keeps no memory. The reader plugin (`arcaid-reader`)
is built on it.

R2 (`RunScript` polling from a plugin, no VPX change) works and reads correctly, but every poll leaves a
compiled chunk in the engine and makes every later poll slower: about 2 hours at 4 polls per second before a
poll costs 1 ms. It is the interim option for a stock 10.9 host at slow polling, and the only way to read a
`Const`, a class member or a table `Function`.

| | R1: `GetScriptVariable` (new API call) | R2: `RunScript` (today's API) |
|---|---|---|
| VPX change needed | yes: 3 files and a test | none |
| Reads globals, array elements | yes | yes |
| Reads a `Const` | no (`E_NOTIMPL` in libwinevbs) | yes |
| Reads a class member, a `Function`, an expression | no, by design | yes (it runs table code on the frame thread) |
| Cost per poll (9 to 10 values, with the detector) | median 9 to 14 µs, p99 30 to 36 µs, flat | 57 µs at the start, +33 µs per 1,000 polls |
| Memory kept per poll | 0 | about 1.2 KB (80 KB if the whole text is parsed each poll) |
| Usable session length | unlimited | about 2.0 h at 250 ms, 3.9 h at 500 ms, 7.8 h at 1 s (median under 1 ms) |
| Can a read break a game | no | no (an uncaught error costs one log line and one notification) |
| Can a read change a game | no | yes if the text is careless: an unbracketed argument can be written back, an unknown name is created as a global unless the chunk has `Option Explicit` |

## 2. What was built, and where it is

Nothing below is in this repository. It is in a local clone, as three local commits on `reader/spike`, and has
not been pushed anywhere: this PC holds the only copy.

| What | Where |
|---|---|
| VPX 10.9 source, branch `reader/spike` (base `c3c47b5bcf`) | `C:\code\repos\vpx-109` |
| The upstream candidate: `GetScriptVariable` and its test (commit `09615e18`) | `plugins/plugins/VPXPlugin.h`, `src/core/VPXPluginAPIImpl.{h,cpp}`, `tests/plugins/plugins/test-scriptvariable.cpp`; as a patch: `C:\code\repos\vpx-109-run\r1\r1-plugin-api.patch` |
| Test-only host code: the R1 core probe, `VPX_IGNORE_FOCUS` (commit `050a27b5`) | `src/core/ScriptVariableProbe.cpp`, hooks in `player.cpp`, `main.cpp`; patch `r1-core-probe.patch` |
| Plugins and bench (commit `e1d8e951`) | the rows below |
| The reader plugin (detector, map format, direct sampler, tests, README) | `plugins/arcaid-reader/` |
| The R2 probe plugin (`RunScript`, three poll modes, expressions) | `plugins/arcaid-probe/` |
| `VPinball.ScoreServer` stub (ground truth) | `plugins/scoreserver-stub/` |
| Self-playing test table, expected events, check tools | `reader-spike/simtable/` |
| Input-only autoplay plugin (unattended real games) | `reader-spike/autoplay-plugin/` |
| Script scan tool, proposed maps, coverage, per-table results | `reader-spike/maps/` (`COVERAGE.md`, `VALIDATED.md`, `proposed/`) |
| Built players, launcher, logs, recipes | `C:\code\repos\vpx-109-run\` (`run-reader.ps1`, `logs\`, `bench\recipes\`) |
| Test tables (copies of the owner's own files, never committed) | `C:\code\repos\vpx-109-tables\` (`TABLES.md`) |

## 3. Building the standalone player on this PC

- Dependencies: the CI third-party zip of the upstream run for the pinned commit (run 44874554731, artifact
  `VPinballX-10.9.0-6955-c3c47b5bc-dev-third-party-windows-x64-Release`), extracted over `third-party/`. It was
  built with VS 2026 (v145) and links with the VS 2022 Build Tools (v143) here. MSYS2 and `external.sh` were not
  needed; nothing was installed.
- ATL is not in the Build Tools: an untracked `.build\vsproject\Directory.Build.targets` points at the unpacked
  ATL in `castcade-vpx-deps\atlmfc` (read only).
- `make\create_vs_solution.bat` (answer `2022`), then MSBuild `vpx-standalone`, `Release_BGFX|x64`: cold 3 min
  42 s, one changed `.cpp` about 80 s. Only Release exists (CI publishes no Debug dependencies).
- The exe imports `winevbs64.dll` and none of ole32, oleaut32, combase.
- Running it without disturbing this rig: only as a renamed copy (`reader109.exe`; the installed Castcade takes
  any `VPinballX*` process for a game), with `USERPROFILE`/`APPDATA` redirected (the player creates
  `%APPDATA%\VPinballX\10.9` and imports the 10.8 settings before it reads `-PrefPath`), every network plugin
  off (Inspector listens on TCP 0.0.0.0:2113 and RemoteControl binds UDP on all interfaces by default), and the
  two game controllers marked `NoAutoLayout` (otherwise an input-layout popup opens at every start and swallows
  all input). `run-reader.ps1` does all of it.
- 10.9 pauses when its window loses focus and has no setting for it. The spike branch adds an
  environment-gated line (`VPX_IGNORE_FOCUS=1` sets the existing `Player::s_ignoreWndFocus`); with it a
  minimized player keeps simulating.

Facts about this flavor found on the way:

- A `<TableStem>.vbs` beside the table replaces the embedded script (also searched in the table's `user` and
  `scripts` folders, the app folder and the pref folder). A folder table (`manifest.json` + `script.vbs`) opens
  too.
- Plugins are **disabled by default** (`[Plugin.<id>] Enable = 1` to load one); the header comment that
  `OnGameStart` is broadcast "before script initialization" is wrong: it comes after the script ran and
  `Table1_Init` fired. `OnGameEnd` comes before `Table1_Exit` and before the script stops, so a last read there
  works.
- A script's `CreateObject` reaches a plugin class through `SetCOMObjectOverride` (text rewrite, case
  insensitive; not matched: a space before `(`, a progid in a variable). Without a plugin it can create only
  what Wine bundles: `Scripting.Dictionary`, `Scripting.FileSystemObject`, `WScript.Shell`. `Microsoft.XMLHTTP`,
  WMI and `Shell.Application` fail with error 429: a table script cannot reach the system's COM servers or the
  network from here.
- Engine differences from Microsoft's VBScript seen on real scripts: `TypeName` of a VPX part or ball is
  `"Object"` (Batman 66 fails one line on it); a runtime error in global code is reported as
  `Compile error ... Description unavailable`. Arithmetic, promotion Integer → Long → Double and the
  conversions tested were identical.

## 4. The two read routes, measured

### 4.1 R1: the script's global dispatch

`IActiveScript::GetScriptDispatch` → `GetIDsOfNames` → `Invoke(DISPATCH_PROPERTYGET)`, on the main thread
between frames (never inside a script call: call depth was 0 at every poll).

| Case | Result |
|---|---|
| Integer (small values are `VT_I2`), Long, Double above 2^31 (exact), Boolean, String (UTF-8), Currency, Date, Empty, Null | read, `S_OK` |
| Object variable | `VT_DISPATCH`, never converted |
| `Dim Score(4)` whole | a copy (`VT_ARRAY|VT_VARIANT`), caller frees |
| `Score(i)` | the element; out of range `DISP_E_BADINDEX` |
| `ReDim`med and 2-D arrays | read |
| `Const` | `E_NOTIMPL` (it resolves, and the type info lists it as a variable) |
| Unknown name | `DISP_E_UNKNOWNNAME` |
| Sub / Function | resolves to a function id; a property get returns `E_NOTIMPL` and does **not** run it |
| Class instance field | readable through `IDispatchEx` only; the instance has no type info in libwinevbs |
| Class `Property Get` | **runs script code on every read**; cannot be told from a field |
| Variable made later by `ExecuteGlobal` | unknown, then readable |
| `Private` global, name in another case | read |

Cost: name lookup 0.1 to 0.3 µs; a cached scalar read 0.4 to 0.9 µs (the first read of a poll pays a cold
cache, median 7.5 µs); a whole 5-element array 8.5 µs; a 7-name poll median 13.5 µs, p99 40 µs, max 111 µs.
500,000 reads in a burst: 0.046 µs each, 0 bytes kept. Private bytes over a 3-minute run: unchanged. A failed
read never reached `OnScriptError`; after a script runtime error reads still work; after `Stop` the dispatch
returns `E_UNEXPECTED`.

What this depends on in libwinevbs (`wine/dlls/vbscript/`, commit `db90ea9`): `vbdisp.c:2044-2129`
(`ScriptDisp_GetDispID`, `ScriptDisp_InvokeEx`: a variable's id is index+1, a function's carries the mask
`0x20000000`, a Const returns `E_NOTIMPL`), `vbdisp.c:263-289` (`invoke_variant_prop` copies with
`VariantCopyInd`), `vbdisp.c:1306-1401` (the script type info), `vbscript.c:990` (`GetScriptDispatch` refuses
another thread or a closed engine). The class type info is a stub under `#ifdef __LIBWINEVBS__`
(`vbdisp.c:654-878`). **LU's "compatibility patches" to libwinevbs are unknown; a patch in these functions
would change these results.**

### 4.2 The API call

```c
VPXScriptVarStatus (MSGPIAPI* GetScriptVariable)(const char* name, int index, VPXScriptValue* value);
```

After `RunScript` in `VPXPluginAPI`; the struct's `version` goes from 1 to 2 and a plugin must check
`version >= 2` before it touches the field (a plugin built against the new header stayed idle on a version-1
host and exited cleanly). API thread only. Statuses: OK, NoScript, UnknownName, NotReadable (a Const on
libwinevbs), NotAValue (Sub, Function, object), IndexOutOfRange, NotConvertible, InvalidArgument. Values: Empty,
Null, Bool, Int (`int64`), Double, String (caller's buffer, UTF-8, truncated on a character boundary), Array
(bounds). `VPXScriptValue` starts with a `structSize` the caller sets, so types can be added later.

What the implementation guarantees, on any engine:

- Global variables only. A name is read only if the script's type information lists it as a variable; the
  classification is cached per DISPID and redone after any failed read.
- The only call into the engine is a property get without arguments. An array element is taken from a copy of
  the whole array (`SafeArrayGetElement`), never by asking the engine to index, so an object's default member
  can never be called. An object, as the value or as an element, is `NotAValue` and is never converted.
- Cost of the copy: an element of a 5-element array 3.0 µs median (1.4 with an indexed call), of a
  1,000-element array 8.8 µs median, 26.6 µs p99. A 7-name poll: 4.3 µs median, 12.4 µs p99 (sum of the calls).
  A batch call (`GetScriptArray`) would be the later answer for large arrays.

A test is part of the candidate patch: `tests/plugins/plugins/test-scriptvariable.cpp` runs a real player on a
script and fails if any read changes a variable (1 case, 37/37 assertions on the Microsoft-engine `vpx-test`).

**The same call on Microsoft's VBScript** (the regular Windows flavor of 10.9 compiles the same host file;
built and run here as a renamed copy, `Script.Print ... ScriptEngine VBScript 10.8.16384`):

| Case | Microsoft's engine | libwinevbs |
|---|---|---|
| DISPID equals the type-info memid; no Function listed as a variable | yes (the type info also lists every table part as a variable) | yes |
| Sub / Function | `NotAValue`; a raw property get is refused (`DISP_E_MEMBERNOTFOUND`), body not run | `NotAValue`; `E_NOTIMPL`, not run |
| `Const` | **read** (`MaxPlayers` = 4) | `NotReadable` |
| Variable holding a class instance with a default member, read by index | `IndexOutOfRange`, the default member did not run | same |
| `ExecuteGlobal` turns a variable into a Function | **the DISPID is reused and changes kind** (this broke the first cache; fixed) → `NotAValue` | a new DISPID → `NotAValue` |
| Arrays, 2-D, jagged, a string with an embedded zero, unknown name | identical | identical |
| First read of a name (type-info lookup) | 300 to 630 µs, then cached | about 3 µs |

No read ran script code or raised a script error on either engine. The regular flavor writes the registry at
every start (`RegisterTypeLibForUser`: `HKCU\Software\Classes\TypeLib\{384DF69D…}\1.0\0\win64` and two
`Interface` keys); each of the five launches was wrapped in an export and a restore, verified byte for byte
(`C:\code\repos\vpx-109-run\r1\regguard.ps1`, `r1\logs\*.guard.txt`).

### 4.3 R2: `RunScript` from a plugin

Read in code and confirmed by the runs: the text runs in the table's global scope; `Option Explicit` is per
chunk; every `ParseScriptText` chunk is kept until the engine closes (`compile.c:2684`, freed at
`vbscript.c:345-435`) and every call walks the whole list (`vbscript.c:858-865`); a plugin cannot hold a script
function, so there is no way to poll without parsing text.

| Mode (25 ms interval soak, about 16,200 polls) | µs at poll 100 | at 10,000 | slope per 1,000 polls | bytes kept per poll |
|---|---|---|---|---|
| `noop` (an empty call) | 23 | 361 | 32.9 | 1,414 |
| `sub` (poll body defined once, each poll parses a 38-character call) | 57 | 402 | 33.5 | 1,215 |
| `text` (whole body parsed each poll) | 170 | — | 35.1 | 79,560 |

The slope is the same in every mode: the growth is per call. At 57,600 polls (4 h at 250 ms) the fit gives about
2 ms per poll and 67 MB kept (extrapolated, not measured). Values, types and Consts read correctly (the
2,500,019,900 score exactly); a name that is a Sub or Function is detected at setup and never called; with every
name missing the probe stops for good after 40 polls; errors inside a poll under `On Error Resume Next` reach
nothing; one uncaught and one syntax error on purpose gave exactly two log lines and the game went on with
identical events. Expressions (opt-in) work: `BallsRemaining(CurrentPlayer)`, a `Function`, a class member,
5 to 13 µs for four of them.

The smallest VPX change that would remove R2's growth is a plugin call that invokes a named script Sub or
Function (VPX already does this to fire events in the standalone build). With `GetScriptVariable` present, the
only things left for `RunScript` are Consts (one read at setup), a `Function` called on purpose, class members
and 2-D arrays.

## 5. The reader: events, maps, reach

### 5.1 Events (`plugins/arcaid-reader/Detector.*`, pure C++, 71 test cases)

A sample is: scores per player, current player, player count, ball number or balls remaining, extra-ball
counter, in-play flag; any of them may be absent.

1. In-play flag rises → `game_start`; the per-ball baselines reset (LU's records do not reset them).
2. (player, ball) changes while in play → `ball_end` for the previous one, points = that player's score minus
   their baseline. A new position counts after it holds 200 ms or as soon as that player scores.
3. A decrease of the extra-ball counter with player and ball unchanged → `ball_end` flagged shoot-again. Without
   the counter in the map an extra-ball drain is invisible and its points merge into that ball.
4. Flag falls → the open ball closes, then `game_over` with the last scores seen in play.
5. Scores back to zero, or the ball back to 1 with a score decrease, while the flag stays on: a restart
   (`game_abandoned`, then `game_start` cause restart) once the new game shows play; `game_over` with the
   pre-reset scores if the flag falls first (a table that zeroes before clearing its flag).
6. Table exit while in play → `quit` with the live scores and the open ball's points; exit in attract → nothing.
7. No flag in the map → in play = ball above 0.
8. A game over followed by a new game inside one poll interval looks like a restart. The signal that separates
   them: the player up is already out of balls (`BallsRemaining(CurrentPlayer) <= 0`), which the JP default
   reads.

Poll rate, from the test timeline replayed in every phase and with jitter: with balls remaining in the map,
16, 50, 100 and 250 ms are all clean (250 ms jittered: 98% of runs clean); without it, 250 ms is clean in only
20% of runs on a deliberately extreme 50 ms gap between a game over and the next start. The plugin polls every
frame by default, which costs about 1.6 ms of CPU per second.

Records: one `game_end` JSON line per game with LU's keys and nesting (`started`, `game_duration`, `reason`,
`rom`, `scores[{player, score, balls[{ball, points}]}]`, `timestamp`, `machine_id`, `type`), no `sig`.
Deliberate differences from LU's records: the baseline resets per game, a quit (`shutdown`) lists the open
ball, a restart is its own record with `reason: "abandoned"`, an extra ball is its own entry, players that
never played are dropped, `started` is the real game start.

### 5.2 The map (`MAP-FORMAT.md`)

One JSON file per table says where each value lives: scores as an array with a base index or as a list of
scalars; player and player count with their bases; the ball as a variable or derived from balls remaining and a
balls-per-game literal; the extra-ball counter; the flag as Boolean or number, inverted or absent. A missing key
takes the JP-template default (`Score(1..4)`, `CurrentPlayer`, `PlayersPlayingGame`, `bGameInPlay`,
`BallsRemaining`, `BallsPerGame`, `ExtraBallsAwards`), so a JP table needs no map at all. The map is found by
the table's file stem or its parent folder (the plugin API gives only the path; on LU's cabinet the folder is
the slug). On the first poll the plan is validated: a wrong map gives one log line naming the unknown names and
the plugin stays idle for that table.

What real scripts look like (85 JP-template scripts scanned): `Balls` is a Function on 76, a class member on 5,
absent on 4, and a readable global on none, so the ball number comes from `BallsRemaining(CurrentPlayer)`;
`BallsPerGame` is a `Const` on 60 (not readable by R1: the map carries it, or it is learned at run time).

### 5.3 Reach over LU's no-ROM tables (static scan, `reader-spike/maps/COVERAGE.md`)

166 active no-ROM tables, 25,577 plays (inventory of 2026-10-27; LU scripts at `ee8d47f`):

| Group | Tables | Share of plays |
|---|---|---|
| JP defaults, no map needed | 73 | 53% |
| Generated map | 27 | 25% |
| Readable except the ball number | 2 | 0.5% |
| Needs the expression route (`RunScript`) | 1 | 0.5% |
| Not scanned: LU ships no `table.vbs` (the script is only in the author's `.vpx`) | 63 | 21% |

78% of plays, against 59% for Castcade's sidecar rules on the same scripts. A static proposal is not proof at
run time: in a hand check of 14 scripts, JP and Burger templates were 0 wrong of 6, the other templates 3 wrong
of 8 at first proposal (fixed in the scanner). The 13 non-template generated maps (1,858 plays) need a hand
check before use. Not readable by the direct route: player-state dictionaries (Cyber Race, GLF tables), a ball
number kept only in a textbox, a single score variable for the player up, a current player stored as text.

## 6. Validation

### 6.1 Self-playing table (no human, no physics)

A script that plays four scripted games on a timer (extra ball, multiball, two players, a score above 2^31, a
new game 50 ms after a game over, a hold-Start restart, a quit in play) and calls `VPinball.ScoreServer` the
way LU's Deadpool script does. On Wine's engine it gives 20/20 expected events and 41/41 stub calls within
1 ms, with no script change. The reader, 18 runs: all 20 events in order and content in every full run, and
against the stub 4/4 starts, 12/12 ball ends with matching scores, 2/2 game overs, 1/1 restart; at every-frame
and at 250 ms polling; wrong map → idle with the names listed; version-1 host → idle; the table closed
mid-game → the `quit` record written and flushed. A poll including the detector: median 10 µs, p99 30 to 38 µs.

### 6.2 Real tables

Nobody played: an input-only autoplay plugin (plugin API `SetInputState`, no script access) pressed credit,
Start and launch on a timeline and let the balls drain. Each recipe is two complete games and a third quit
mid-ball in one launch, 390 s. The witnesses are independent of the variables read: the tables' own log prints
and lights. All final evidence is on the final build (`app-v3`). Per-table detail:
`reader-spike/maps/VALIDATED.md`; evidence `C:\code\repos\vpx-109-run\reader\out-real\`.

| Table (script) | Map | Result |
|---|---|---|
| Total Nuclear Annihilation (author) | generated (ball from balls remaining, `BallsPerGame` literal 3) | 20/20 checks, three launches: 3 starts, 2 game overs, 1 quit; starts within 1 ms of the witness; ball ends 1, 2, 3 in order; `balls[]` sums to the score; nothing in attract, bonus, match or high-score entry |
| JP's Foo Fighters (author) | generated, and none (JP defaults) | 20/20, four launches, same shape |
| Deadpool v6.10 (LU's `table.vbs`, which targets v7) + stub | generated | 17/17 after one fix: stub states 1 / 2 / 3 matched 2 / 2 / 2 within 0 to 4 ms with the same scores |
| Iron Maiden (author, `Score` from 0) | generated | loads, validates, nothing emitted in attract |
| Batman 66 (author, `Score` from 0) | generated | same; a started game ends as a quit with ball 3 open |
| Star Wars (Burger template: `P1Score`, `cp`, `numplay`, `gameon`) | generated | every read OK, nothing in attract |
| TNA (LU's script) | found by its folder name | loads, validates |
| Blood Machines (author) | fits | no game: `Table1_Init` stops at its Scorbit setup in this build, nothing emitted |
| Darkest Dungeon (author) | — | script fails at load without its PuP pack; the reader reports `Score` "not an array yet" and stays idle |

What the real tables showed:

- When the flag falls: TNA 3.8 s after its `Match Check` print (after high-score check and match); TNA under
  LU's script and Iron Maiden in the same poll as the last ball; Foo Fighters when the last high-score initial
  is confirmed, 19 to 27 s after the last ball. No table zeroed its scores before the flag fell.
- At load `CurrentPlayer` is Empty; it is 1 in play. A ball-save drain is not a ball end (correct).
- Deadpool under LU's script never assigns `BallsPerGame`, so `BallsRemaining` is Empty, then -1. The detector
  took Empty for 0 and missed both ball ends; fixed (Empty is "no information"), with a test and a replay of the
  recorded trace.
- A poll including the detector on real tables: median 9 to 14 µs, p99 34 to 36 µs, no poll over 1 ms. Largest
  gap between polls 105 to 250 ms (host stalls with a ball in play); no event fell inside one.
- The recorded traces of every run replay identically through the final code (`ARCAID_READER_REPLAY`).

## 7. Review

An independent read of the host call, the detector and the plugin (2026-11-21). Against libwinevbs the host
call is sound: no input runs script code, leaks a reference or returns garbage, and the variable-only check
holds when a script redefines a name as a Function. Findings and their state:

| Finding | State |
|---|---|
| The host call had never run on Microsoft's engine; three guarantees rested on libwinevbs | run there (§4.2); the indexed read no longer calls the engine; the DISPID-kind cache was wrong on Microsoft's engine and is fixed |
| Null name, `index < -1`, doc comment promising more than verified, no size field in the value struct | fixed (`InvalidArgument`, `structSize`, reworded comment) |
| No test for the call | `test-scriptvariable.cpp`, passes on the Microsoft-engine `vpx-test` |
| Test-only probe in the shared source list breaks non-Windows builds | wrapped in `#ifdef _MSC_VER` (by inspection; not compiled elsewhere) |
| Detector: false restart when a stale score slot is zeroed as a player joins; negative ball points; duplicate ball end with a lost ball; spurious shoot-again at game start; player counts unclamped; balls-per-game learned per session | all fixed, a test each (suite: 71 cases, 4,292 assertions) |
| Plugin: an exception could cross the C boundary (non-UTF-8 table name); events lost when the log folder is not writable; exit could block on a hung disk; unload mid-game dropped the game; a Windows 10-only import | all fixed (the exception path, the timeout and the unload path are tested with a fake host, not live) |
| Any score decrease on ball 1 reads as a restart | kept, documented as a limit |
| The plugin binds to an unmerged API | kept, warned at the top of the plugin README (§8) |
| The stub overrides `VPinball.ScoreServer` whenever it is enabled | kept: it is test tooling and plugins are off by default; never enable it beside a real ScoreServer |

## 8. For LU (Wraith), and what is still open

- The reader does not need table changes and does not need a sidecar. For 53% of no-ROM plays it needs no
  per-table file at all; for another 25% a generated map (a few lines of JSON, not a script).
- A table update that renames a score variable needs a map edit; the plugin says so in one log line
  ("the map does not fit this table's script: ... unknown name") and stays idle.
- Upstream VPX's `CONTRIBUTING.md` prohibits contributions made entirely by AI (a draft PR that discloses it is
  the one exception, for fixes of identified issues). The API patch was written by AI agents in this spike: a
  person has to review it, test it, own it and disclose that before it is proposed. Opening an issue or
  discussion first is the safer start. Maintainers will ask why plugins should read script internals at all
  and why not reuse `ScriptVariant`.
- The plugin binds to an API that is not merged. If upstream ships version 2 with another layout, this dll
  would call a wrong function pointer on a stock build. Ship it only with a host that carries this exact patch.
- Until the call is upstream, R2 is usable on a stock 10.9 host at slow polling (1 s: under 1 ms per poll for
  about 7.8 hours of one table session; the growth resets when the table closes, read in code).

Open questions for Wraith (asked 2026-11-21, unanswered): would he take the reader into the published
ScoreServer plugin; `RunScript` now or wait for the API call; what LU's libwinevbs patches touch.

Not verified:

- No human played. Not exercised on a real table: a multi-player game, an earned extra ball (the shoot-again
  path), a hold-Start restart, multiball. The self-playing table covers them; a real table has not.
- LU's own engine: results are on upstream libwinevbs `db90ea9`, not on LU's patched build, and on Windows x64,
  not on the cabinet's RK3588 Linux build.
- The patched tree was compiled only with MSVC (standalone and regular flavors). Linux, macOS, Android and
  MinGW builds were not compiled.
- R2's 4-hour figures are a linear fit over 16,200 polls; that the kept memory is released when the table
  closes is read in code.
- Of the 113 proposed maps, 8 tables were run. The 13 non-template maps need a hand check.
- Author scripts of the 63 no-ROM tables LU ships no `table.vbs` for were not scanned (only two were available).
- Deadpool v7 (the version LU's script targets) was not available; v6.10 stood in.
- Stranger Things, Big Shot, America's Most Haunted, JP's Slimer and a GLF table from the plan's sample were
  not on this PC (a GLF table, Dark Chaos, is, and was not run).

## 9. Reproduce

```powershell
# the player (cold 4 min); output .build\bin\vpx-standalone\Release_BGFX-x64\
$msb='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe'
& $msb C:\code\repos\vpx-109\.build\vsproject\VisualPinball.sln /t:vpx-standalone /p:Configuration=Release_BGFX /p:Platform=x64 /m /nodeReuse:false /nologo /v:minimal
# the reader's unit suite (71 cases)
C:\code\repos\vpx-109-run\reader\build-tests\Release\arcaid-reader-tests.exe
# the self-playing table with the reader and the stub (about 55 s, minimized, quits by itself)
pwsh -NoProfile -Command "& 'C:\code\repos\vpx-109-run\run-reader.ps1' -Tag demo -Seconds 90 -AppDir 'C:\code\repos\vpx-109-run\reader\app' -PrefPath 'C:\code\repos\vpx-109-run\reader\prefs' -Env @{ ARCAID_READER_LOGDIR='C:\code\repos\vpx-109-run\reader\out\demo' } -VpxArgs @('-Play','C:\code\repos\vpx-109-run\reader\tables\simtable.vpx')"
# then read reader\out\demo\arcaid-reader-events.jsonl and arcaid-reader-games.jsonl
```

The final player is staged at `C:\code\repos\vpx-109-run\app-v3\reader109.exe` (never run it under a
`VPinballX*` name on this rig). Real-table recipes: `C:\code\repos\vpx-109-run\bench\recipes\README.md` and
`C:\code\repos\vpx-109-run\reader\run-real.ps1`.
