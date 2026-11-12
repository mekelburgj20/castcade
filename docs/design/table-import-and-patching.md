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
| **B — Original, script anchors** | no VPM; `Sub AddScore` (any spelling) AND a start sub (`ResetForNewGame` / `StartGame` / `StartNewGame` / `NewGame` / `InitGame`) AND an end sub (`EndOfGame` / `GameOver` / `EndGame`), or, with no end sub, a plain statement that clears the game flag (`gameon = 0`, `GameActive = False`, `GameOver = 1`, …) outside `_Init` / `_Exit` / the key handlers / the start sub. The JPSalas trio (`ResetForNewGame` + `EndOfGame`) is B ahead of C and D; the wider vocabulary yields to C and D (C1.3, 2026-11-07) | The score store is read from `AddScore`'s body (`X = X + …` scalar, `X(I) = X(I) + …` array with `I` the player, or a family `p1score, p2score…`); ball end from `EndOfBall` / `EndBall` / `EndPlayerTurn` / `BallDrained` or the `BallsRemaining` decrement — record what was found. |
| **C — Original, Scorbit-anchored** | class B anchors absent or partial, but `StartSession`, `SendUpdate`, `StopSession` present (any `Scorbit*` identifiers) | Use the Scorbit call sites as the event anchors regardless of `ScorbitActive`. |
| **D — Original, ScoreServer-integrated** | `CreateObject("VPinball.ScoreServer")` or `SetScoresArray` / `SetGameState` | Already emits scores through superhac's API surface; the sidecar provides a compatible object. (Rare on desktop; present in some ALP-targeted tables.) |
| **E — Original, generic** | none of B–D, but `_KeyDown` exists and at least one of `Score`, `AddScore`, `Points` identifiers | Not patched: the vocabulary found no `AddScore`, no start or no end anchor, and no anchor override knows the script. The guided pick of the first design is dropped (C1.3); a script the vocabulary cannot read gets an anchor override (C1.4, below), which makes it class B. |
| **X — Unsupported** | no `_KeyDown` (e.g. a test table), `Option Explicit` with obfuscated/compressed script, or extraction failed | Never patched. Reason recorded. |

**Anchor overrides come first among the originals (C1.4, 2026-11-12).** A script that matches a record in
`companion/src/patcher/anchor-overrides.ts` is class B whatever else it has (after A): the VPX Game Logic Framework
(`glf`: Dark Chaos), the Burger template with its ball counter (`burger`: 2001, Star Wars), Rattlecan (`rattlecan`).

Secondary facts captured for every class: table object name (the FIRST `Sub (\w+)_KeyDown` → `Table1`; of each handler
the LAST definition is the one renamed, because VBScript keeps the last: Congo and Hook define `Table1_Exit` twice, and
a framework's own `Glf_KeyDown` comes after the table's), key constants in use
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

**As built (WORK C1.1, recipes B/C/D 0.1.0, hook 0.5.0; `companion/src/patcher/render-originals.ts`).** Where it
departs from the sketch above, the code is right:
- Each anchor is ONE line, `    Castcade_<R>_<Event>   ' Castcade: <what>`, calling a sub in a block appended after the
  wrappers (`' --- Castcade recipe <R> anchors ...` / `' --- end Castcade recipe <R> ---`). Those subs hold the table's
  own expressions under `On Error Resume Next` and call `Castcade_GameStart` / `Castcade_Scores` / `Castcade_BallEnd`
  / `Castcade_GameEnd`; `Castcade_PlayerScores(arr, base, players)` (lib) turns the table's score array into one
  entry per player. The player count is kept from the last time it was above 0 (some tables zero it at game over).
- **B (0.2.0, C1.3, 2026-11-07: by role, not by JPSalas' names):** the four roles come from the vocabulary in
  `classify.ts` (`START_SUBS`, `END_SUBS`, `BALL_END_SUBS`, `GAME_FLAG_CLEAR`; the first name that exists wins). The
  score store is the first `X = X + …` / `X(I) = X(I) + …` in `AddScore`'s body, a name containing `score`
  preferred (Diablo 2's `AddScore` also counts `ExtraBallPending`), else the same one call down (the Burger template's
  `AddScore` only calls `SetScore`); a scalar `X` journals `Array(X)` with the current-player variable
  (`CurrentPlayer` / `CurrentPlayerIdx` / `nPlayer` / `cp` / `Player`, only when assigned somewhere) and the warning
  "scalar score: in a multi-player game only the player up is journaled"; a family `p1score, p2score, …` journals
  `Array(p1score, …)`; an array's index is the player, its base read from `<I> = 0|1` (start sub first: GotG, Iron
  Maiden, The Matrix and Futurama count from 0, most from 1). Players = `PlayersPlayingGame` / `PlayersPlaying` /
  `nPlayersInGame` / `NumPlayers` / `numplay` (the Burger template's `numplay` is players + 1, journaled as
  `numplay - 1`); ball = the `Balls` function, else `BallNumber` / `CurrentBall` / `nBall` / `BallInPlay`, else
  `BallsPerGame - BallsRemaining[(I)] + 1`; extra = `ExtraBallsAwards(I)` / `ExtraBallPending` / `nExtraBalls` /
  `ExtraBalls`. A name whose only declaration is a `Dim` inside a sub or class is never taken (2001's class-level
  `Private Balls(20)`), and a name assigned inside a procedure wins over one only set at module level (Star Wars'
  dead `PlayersPlayingGame = 1`). Game start at the end of the start sub; scores at the end of `AddScore` **and in
  front of each of its early `Exit Sub`** (a repeat is dropped by the library); **ball end at the TOP of the ball-end
  sub** (the drained ball's player and number, before anything advances: JPSalas' `EndOfBall` hands over to a timer
  and `EndOfBall2`; Diablo 2's `EndPlayerTurn` re-shoots on `ExtraBallPending` in its first line, which the
  `extra_balls` field carries), else before the `BallsRemaining` decrement; game end at the end of the end sub (0.3.1:
  in front of the statement in it that clears the score store, when there is one), else
  **on the line after the game-flag clear** (Rattlecan's `GameOver = 1`, the Burger template's `gameon = 0`), with a
  warning naming the sub and line. An early `Exit Sub` in a start/end anchor sub is a warning, not new control flow
  (GoT's `EndOfGame` re-entry guard is exactly a path that must not journal). The plan reason lists the four subs
  found and the score store. On the owner's rig (2026-11-07) this turned all eight readable class-E tables into B
  without a partial: Diablo 2 ×2, Jacks Open, Futurama (exact), Rattlecan and 2001 ×2 / Star Wars (end via the flag,
  no ball end). Diablo 2's own multiplayer keeps the other players' scores in `PState(p).Item("Score")` and
  overwrites `Score` with the winner's at `GameOver`: single-player games are exact, local multiplayer finals wait on
  C1.4.
- **C:** the 7 arguments of a `Scorbit.SendUpdate` call (P1–P4, ball, 1-based player, players) are the expressions;
  `StopSession`'s scores are not used (VPW tables pass `Score(0..3)` there even when they count from 1, and
  Terrifier passes a different array). Start / end go at the end of the sub calling `StartSession` / `StopSession`,
  outside its Scorbit guard; a call inside a Scorbit-named helper (`StopScorbit`) moves one level up to its caller;
  a call inside a Class or an event handler (`Table1_KeyUp`) is not an anchor. Scores ride `AddScore` when present.
- **D:** every `CreateObject("VPinball.ScoreServer")` becomes `Castcade_D_ScoreServer()` (the shim, else the real
  object, else the error CreateObject would have raised, so the table's own guard behaves as before). Refused, and
  partial, when the table calls a method the shim lacks or with another arity. No ball end (the API has none); state
  3 is journaled as `game_end` with the scores the table sends next (C1.1.1: a table that never sends state 3 still
  ends as `table_exit` → `game_abandoned`).
- Partial (the plan reason says `(partial: ...)`): no scores, no game start or no game end anchor.
- Undo (`unpatchSidecar`, formerly `unpatchRecipeA`) is exact for A–D and refuses another recipe. Each recipe has its
  own version (`RECIPE_VERSIONS`), so a B change does not re-make the A sidecars.
- Not built: recipe E's guided pick (dropped).

**Anchor overrides, as built (WORK C1.4, recipe B 0.3.0 / C 0.2.0, 2026-11-12; `companion/src/patcher/anchor-overrides.ts`).**
The cause was Dark Chaos (apophis 2025) 2.0: three matches on 2026-11-12 never left grant 1 because the table was class
E, never patched (no manifest, no sidecar; `sidecar watch: ... not patched (skip: ... class E ...)` in the owner's log).
C1.3 turned eight of the rig's nine class-E tables into B; the ninth is built on the VPX Game Logic Framework and has no
`AddScore`, no start sub and no end sub for a vocabulary to find.
- **A record is data**: an id, a SIGNATURE (regular expressions that must each match a code line), per role (`gameStart`,
  `scores`, `ballEnd`, `gameEnd`) the places its anchor line goes (`top` / `end` of a sub, `before` / `after` a line,
  several places allowed), and the table's own expressions for scores, player, ball, players and extra balls. Whatever a
  record leaves out comes from the vocabulary. No code runs per table.
- **Keyed by the script, not by TableInfo** (the WORK line proposed author + name): the patcher and the witness classify
  from the script text alone, three of the rig's originals carry no usable TableInfo (Diablo 2, Rattlecan and SMGP are
  "Visual Pinball Demo Table", no author), and a signature follows a table through a mod (the ChuckRibbits 2001 mod
  matches the same record). It ships in the app like the recipes; a refresh channel like the VPS index is not built.
- **`glf`** (any GLF table): game start at the top of `Glf_DispatchGameStarted` (`Glf_StartGame` runs for every Start
  press), ball end at the top of `Glf_EndOfBall` (before it spends an extra ball or advances), game end at the top of
  `Glf_EndGame` (before it empties `glf_playerState`), live scores at the end of `SetPlayerState` as
  `Castcade_B_ScoresFor key`, which journals only when `key` is `"score"`. Scores are
  `GetPlayerStateForPlayer(0..3, "score")`, the player `Getglf_currentPlayerNumber() + 1`, the ball
  `GetPlayerState("ball")`, extra balls `GetPlayerState("extra_balls")`.
- **`burger`**: ball end in front of `Select Case ballstext.text` (in `Drain_Hit` on 2001, in `endballcase_timer` on Star
  Wars); the ball is `DMDballnum`; the extra-ball flag is read from the counter text, which the template sets one behind
  the ball shown (999 on ball 1) so the same Case runs again.
- **`rattlecan`**: ball end at the top of both `ShootAgain_Timer` and `ShootAgainAfterTilt_Timer`; ball `BallInPlay`,
  extra `ExtraBalls`.
- **For every recipe-B table (0.3.0):** the game end is anchored after EVERY game-flag clear, not the first (Rattlecan's
  second `GameOver=1`, the drain after a tilt, was missed), and `Castcade_B_GameEnd` journals once per journaled game
  start (`Castcade_B_InGame`), so a clear outside a game says nothing (recipe C 0.2.0 has the same guard); the score
  store is `Score` itself ahead of any other `...score...` (JP's Foo Fighters adds into
  `CurrentCityScore(CurrentPlayer, ModeActive)` first, and 0.2.0 journaled that). The plan reason and the manifest name
  the override (`anchors from the glf override`).
- **Exact undo, all recipes:** each wrapper takes its handler's own spelling (`Sub table1_Exit()`), and a sidecar ends
  with or without a final newline as its script did; 17 of the 33 originals the rig rendered before came back from the undo with one of
  those two differences before. F5 was not affected (its diff ignores case and line ends). Recipe A's version is NOT
  bumped: an existing recipe-A sidecar is undone as before, and is rendered the new way at its next re-make.
- **Static validation** (`companion/src/patcher/validate.ts`, `lintSidecar`): the undo is exact; every anchor line is
  inside a multi-line procedure outside a Class, not after a line continuation, not between `Select Case` and its first
  `Case`, and calls a sub the block defines; the block structure (Sub / Function / If / Select / For / Do / With /
  Class) is the script's plus our own balanced blocks; no `Castcade_*` name is defined twice, our wrapper is the last
  definition of each handler and the definition renamed was the table's last. Plus a real compile:
  `vpx-hook/spike/vbs-compile.vbs` hands a script to the Windows VBScript engine behind a first line that raises, so the
  engine compiles all of it and runs none. 2026-11-12, the rig: all 34 originals' sidecars and all 105 ROM tables'
  sidecars lint clean; all 34 originals' sidecars compile. `sidecar-cscript.test.ts` (Windows only) also DRIVES the three
  override shapes through a game under cscript with the real library and checks the journal.
- **Live validation** (§7): `npm run validate-original -w companion -- "<table.vpx>"` (or `--all "<folder>"`).
- **Recipe B 0.3.1 (C1.6, 2026-11-12, from the first live run of all 34 originals):** an end sub that sets the score
  store to 0 journals the game end IN FRONT of that statement (outside any `For` / `Do` / `While` that holds it), not
  at the end of the sub. The Matrix (Original) 0.99.0 zeroes `Score(i)` for every player near the end of `EndOfGame`:
  its game passed with ball ends 1, 2, 3 and a final score of 0 after 1461760 live. A clear on a `Case` line or behind
  a line continuation leaves the anchor at the end. Of the rig's 34 originals only that table's sidecar changes;
  `checkGameJournal` now fails a `game_end` whose scores are below the last live scores. A clear in a sub the end sub
  CALLS is not seen by the renderer (the live check catches it).
- **Recipe B 0.3.2 (C1.6, from the rerun):** an end sub whose early exit is a re-entry guard on the game flag
  (`If bGameInPLay = True Then Exit Sub`) is one the table calls LATE, and the game end is ALSO anchored after every
  clear of that flag outside it. Game of Thrones is over in `EndOfBallComplete` (`bGameInPLay = False`, then the match
  sequence); `EndOfGame` runs from a timer 5 s later and leaves at its guard when a Start in between began the next
  game. The rerun played five games back to back (the runner's lockbar key is a Start there once the flag is clear)
  and journaled one game end; the four lost ones had sane, bonus-included live scores (866860, 351250, 605700,
  317030). The end sub keeps its anchor; `Castcade_B_GameEnd` journals once per game start, so whichever anchor comes
  first reports the game. The warning "has 1 early Exit Sub; no game end is journaled on that path" is replaced by one
  that names the flag and the extra anchors. Game of Thrones is the only original on the rig whose END sub has an
  early exit (Diablo 2's two are in its start sub), so no other sidecar changes. This corrects the C1.3 line above:
  the guard's path is a real game over, not one that must stay silent.
- **Still open:** Diablo 2's own local multiplayer (the other players' scores live in `PState(p).Item("Score")`; a
  one-player game, which is what a Castcade match runs on each rig, is exact); the Burger template's ball save and
  multi-player rounds are read from the script only; class X stays unpatched (two calibration tables, one test table).

**Recipe E (generic original):** never rendered. The first design had a guided anchor pick here; C1.3 replaced it with the vocabulary above, and what the vocabulary cannot read gets an anchor override (C1.4).

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

## 6a. The "posted at exit" ladder (C11, 2026-10-31)

A game that posts once, when the table closes (`reason=exit_sample`, no attempt key, no live events), fell off live
mode on one of these rungs. Since C11 the capture detail (`witness: capture …` in the log), the close log line
(`witness: <table>: live mode produced no capture (<rung>: <detail>)`), Status ("Last close", with Patch now where it
applies) and the balloon name the rung in the same words (`companion/src/witness/exit-rung.ts`), so a tester's
`companion.log` alone says which.

| Rung | `kind` | What happened | Detail text | What to do |
|---|---|---|---|---|
| (a) | `not_patched` | The `.vpx` has no sidecar: it arrived after the last **Patch my tables**, or an older build skipped it for lack of a recipe (C1.1.3). VPX ran the table's own script; nothing was journaled. | `table not patched (new file; the import would patch it: VPM / ROM table, ROM freddy)` (`its earlier patch is gone` when a manifest exists) | Since C11 the folder watch patches it on its next look, once the folder was imported once; the balloon and Status offer **Patch now**. C11.2 (2026-11-01): a sidecar the watch wrote that another program removes while the `.vpx` is unchanged (the owner's rig: Windows Defender quarantined the rendered `.vbs` of one original, Thundercats Pinball v1.0.9, as `Trojan:Script/ObfusScript.A!ml`, the table's own obfuscated script; the watch rewrote it every 30 s for an hour with a balloon each time) is reported once ("Castcade could not keep a table patch") and remembered like a decline until the file changes; the detail then reads `its earlier patch was removed from disk by another program, most likely an antivirus quarantine of the .vbs` and the Status note sends the player to Windows Security → Protection history before Patch now. |
| (b) | `unreadable` / `no_map` | Patched or not, the machine's live fields are not in NVRAM (`liveSupport`), or the ROM has no map. The hook journals nothing useful. | `live score not readable on gottlieb-system80 (scores in CPU RAM)` / `no map for ROM xyz` | Nothing on the rig. The platform needs an NVRAM-only detector (B10.2, `docs/design/platform-coverage.md`) or the live-memory producer (B10.3). |
| (c) | `no_recipe` | An original of class E (generic) or X: no anchors to patch. | `not patched; no recipe for this script (class E)` | C1.3 (guided anchor pick). |
| (d) | `partial` | The recipe rendered without one anchor; the manifest now records `partial`. | `the Castcade patch is partial on this script (<warnings>)` | Report the table; the recipe needs the missing anchor. |
| (e) | — | The game posted but ArcAid matched it to nothing (ROM / VPS not pinned). Not an exit-posting cause; listed because testers report it the same way. | `witness: identity unresolved …`, ArcAid's `not counted` reason | F15 (ROM fallback on the start call). |
| (f1) | `hook_silent` | A sidecar sits beside the table but no `table_loaded` arrived: VPX ran another copy of the file, or the sidecar was not picked up. | `sidecar present but the hook never reported in (VPX ran the table's own script?)` | Open the table from the folder Castcade patched, not a copy elsewhere. |
| (f2) | `no_game_end` | `table_loaded` arrived, the map was attached, the journal was followed, and the detector produced no `game_end`. | `live mode followed the journal (hook 0.5.0, recipe A 0.3.1, 1 nvram_full, 312 nvram_delta, 0 orphan; game_start seen: no; last state scores [0,0,0,0] ball 0 player 1 game over) and saw no game end` | Send the journal (`%LOCALAPPDATA%\Castcade\journal\<table-id>.jsonl`) and `companion.log`: a decoder or platform finding, never something the player can fix. |

Two more kinds cover the companion's own blind spots: `no_table_file` (the table file was not found, so its patch could
not be checked) and `script_unread` (the script could not be read).

**Freddy – A Nightmare on Elm Street, Krobs, 2026-10-31 (the case that made the ladder).** Posted at close. Offline:
the corpus maps `freddy` / `freddy4` (`maps/gottlieb/system3/freddy.map.json`) with scores, game over, current ball
and current player all inside the 8 KB NVRAM at 0x0000; `liveSupport` says readable; the importer plans the table as
`patch`; a synthetic System 3 game through `decodeGameState` + `JournalDetector` yields game_start, ball ends and
game_end. Krobs' log up to 2026-10-31T08:05Z shows a Freddy sidecar made on 2026-10-23 and re-made on 10-24, 10-26 and
10-30. **Settled on the owner's rig, 2026-11-01, two tables on 0.2.27:**
- Cue Ball Wizard (patched, System 3) armed live mode, saw `game_start` and balls 1 and 2 end, then posted at close as
  "abandoned on ball 0": rung (f2). Its journal (`fixtures/nvram/cueball/2026-11-01-1`) shows System 3 clearing the ball
  byte (0x03 → 0x00, then the idle bit 0x80) 3.5 s before it clears the player count the map reads as game over, so at
  the game-over step `prev` had no ball in play and the old rule derived neither the last ball end nor the game end.
  WPC keeps the ball byte at 3 across game over and Data East clears both in one step, which is why the fixtures never
  showed it. The detector now remembers the last ball in play (`lastInPlay`) and ends the game from it; the fixture
  replays as one game with three ball ends. This is what Krobs' patched Freddy did on 2026-10-31.
- A freshly downloaded Freddy (v.2.4) on the same rig was rung (a) exactly: "not patched" notice, one score at close,
  and ArcAid then skipped it because "Freddy A Nightmare on Elm Street (Gottlieb 1994)" matches two catalogue games
  (rung e, ArcAid F22). C11's folder watch removes (a); F22 is ArcAid's.

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

**The originals' runner (C1.4, `companion/scripts/validate-original.ts`).** For one original, or every original in a
folder: copy the `.vpx` into `tmp/validate/tables/`, render its sidecar there with the table id `validate-<name>` (its
own journal), lint and compile it, launch VPX with `-Ini <copy>` (Start / plunger / credit / exit bound to known keys in
the copy; the rig's ini is not touched) and `-Play`, wait for `table_loaded`, let `vpx-hook/spike/autoplay.py` press
credit, Start and the plunger (plus the lockbar key) until the journal holds a new `game_end` or the time budget ends,
hold the exit key, then judge the journal with `checkGameJournal`: `table_loaded`, `game_start`, at least N ball ends
that start at ball 1 and never go down (a shoot-again is not counted), `game_end` with a score. It refuses to start while
VPX or Castcade is running (Castcade would follow the run as a real game), needs `castcade.vbs` already in
`<vpx>\scripts` at this build's version, and writes nothing to the tables folder. `--in-place` instead launches the
table where it is, with the sidecar the companion wrote. Results land in `tmp/validate/results/`. A staged copy sits in
another folder than the original, so a table that loads files by a path relative to its own folder may behave
differently there; `--in-place` is the check of record once the companion has patched the folder.

What the first run of all 34 originals taught the runner (2026-11-12: 27 passed; none of the 7 failures was a patch
fault, and one pass was: The Matrix (Original), §5 "Recipe B 0.3.1"):
- **Folders the script loads from are staged with the copy.** Game of Thrones, Sonic, Thundercats and The Goonies
  load a FlexDMD / UltraDMD project from a folder beside the table; without it they stop at a dialog ("FlexDMD
  directory gameofthrones.FlexDMD appears to be missing", "UltraDMD userfiles directory ... does not exist") or a
  script error, no key reaches the script (the journal has `table_loaded` and not even the `lock` line of the first
  key-down) and VPX does not close on the exit key. `resourceFolders` (`validate.ts`) picks the sibling folders whose
  name ends in `DMD` and that the script names in a string literal, whole or as `"<stem>"` + `".UltraDMD"` /
  `".FlexDMD"`. `checkGameJournal` notes a session no key reached.
- **Start is pressed again while the journal shows no game start** (every 12 s, four presses in all): a table still in
  its boot or intro sequence ignores the first one (Sonic's `BootE`, The Goonies' `enableKeys`).
- **Per-table hints are data, in `companion/scripts/validate-hints.ts`**: a record matches a part of the file name and
  says, with its evidence, which keys follow Start (`afterStart`), a longer budget (`minutes`), a longer settle time, or
  extra folders. Today: Diablo 2 (both versions) and SMGP press Start a second time, 4 s after the first; Start opens a
  difficulty / character select there and only a second Start serves the ball (both journaled `game_start` and then
  nothing for 8 minutes). `autoplay.py` takes the steps as `--after-start 4:start`.
- **No key after the game end, and none for 15 s after each ball end.** The runner taps the plunger and the lockbar
  key every 6 s; Game of Thrones takes the lockbar for Start once its game flag is clear, so each game over began the
  next game (the Start retry was not involved: it ends for good at the first journaled game start). `autoplay.py` now
  reads the journal twice a second and holds its keys after a ball end (`--quiet-seconds`). `checkGameJournal` notes
  a session with more than one game start, and a final score of 0 with no live score above 0 (it cannot tell a game
  that scored nothing from a cleared score: Diablo 2 1.2.1's 0 was true, every `AddScore` of that game added 0).
- `--only` takes several name parts separated by `|`, for a rerun of the tables that failed.

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
