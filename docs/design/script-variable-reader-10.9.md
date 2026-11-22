# Script-variable reader on upstream VPX 10.9 (standalone, Windows) — plan

Status: plan, 2026-11-21. Not started. Proposed board item: **I13** (section I).

## 1. Goal

Prove that VPX itself can read a no-ROM table's own script variables (score, ball, current player, player
count, game-in-play flag) while it runs, and turn their changes into game start / drained ball / game over /
quit, **without changing the table or its script**. Do it on the engine LU's cabinets run (Wine VBScript,
`libwinevbs`), on the VPX version LU is moving to (10.9), on this PC.

Why: Legends Unchained (Wraith, `#lu-dev-ext`, 2026-11-21) will not maintain sidecar scripts ("we would have
to reapply it every time a table gets updated") and wants "a method native to VPX so tables don't need
modification at all". Their ScoreServer is already a 10.9 plugin and Wraith plans to publish it; LU is moving
to 10.9 "sooner than later" and uses upstream's `libwinevbs` "aside from some compatibility patches". The same
reader would later remove sidecar patching from Castcade itself (no-ROM tables).

Out of scope: moving the Castcade fork (`castcade-vpx`, 10.8.0) to 10.9; ROM tables (ScoreServer already reads
them through the nvram maps); ScoreServer's own code (not published yet).

## 2. Where the work lives

| What | Where |
|---|---|
| This plan, findings, board item | this repo (`castcade`): `docs/design/`, `WORK.md` section I |
| VPX 10.9 source + build + probe code | NEW clone `C:\code\repos\vpx-109` of `github.com/vpinball/vpinball`, pinned to master `c3c47b5bcf` (2026-11-21), branch `reader/spike` |
| Test tables (copyrighted, never committed) | `C:\code\repos\vpx-109-tables\` |
| LU's current table scripts | `C:\code\repos\ArcAid\tmp\table-cert\vendor\lu-alp4k\tables\<slug>\table.vbs` (LU repo @ ee8d47f) |
| Prior research | ArcAid `tmp/table-cert/scoreserver/FINDINGS-SS.md` (ScoreServer script API + record schema), `tmp/table-cert/sidecars/vpx-tna/table.vbs.diff` (TNA bridge), `tmp/table-cert/sidecars/lu-coverage-2026-11-21/FINDINGS.md` (which LU tables the Castcade rules cover) |
| Variable-name vocabulary to reuse | `companion/src/patcher/classify.ts` + `render-originals.ts` (start/end/ball-end sub names, score store, ball, player, players, game flag) |

**Do not touch** `C:\code\repos\castcade-vpx*` (three worktrees with active sessions) or ArcAid / arcaid-witness.

## 3. Facts already verified (2026-11-21)

- Upstream master is **10.9.0, unreleased** (`src/core/vpversion.h`); 10.8.0 is the last stable; 10.8.1 only
  shipped "DO NOT USE" pre-releases.
- Windows has two app flavors: the regular Windows app (Microsoft's VBScript via COM; CMake `PLATFORM=windows`)
  and the **MSVC standalone build** `make/vpx-standalone.vcxproj` → `VPinballX_BGFXStandalone64.exe`, which links
  `winevbs64.dll` (`make/winevbs64-msvc.def`: "the build fails if the executable still imports from ole32,
  oleaut32 or combase"). There is also `PLATFORM=windows-mingw` (README lists it as unsupported).
- `platforms/windows-x64/external.sh` builds every dependency, **including libwinevbs with MinGW**, and copies
  `winevbs64.dll` + `libwinevbs.h` into `third-party/`. It needs MSYS2 (README pacman line below).
- `libwinevbs` (`github.com/vpinball/libwinevbs`, `wine/dlls/vbscript/vbdisp.c`): `ScriptDisp_GetDispID`
  resolves global **variables** by name; `ScriptDisp_InvokeEx` reads them (`invoke_variant_prop`). A `Const`
  returns `E_NOTIMPL` ("const not supported") — fine, none of the needed values is a Const.
- 10.9 plugin API (`plugins/plugins/VPXPlugin.h`): events `OnGameStart`/`OnGameEnd` (table load/exit),
  `OnPrepareFrame`, `OnUpdatePhysics`, `OnActionChanged`; scripting = `RunScript(const char*)` only (no
  "read variable" call). `ScriptablePlugin.h` lets a plugin add script-callable objects; it is marked "work in
  progress, do not use". `plugins/helloscript` is the template.
- Upstream also has `BUILD_RK3588` (LU's cabinet SoC) and OpenXR VR on BGFX — informational only.
- This PC: VS 2022 at `C:\Program Files\Microsoft Visual Studio\2022` (edition/components unchecked), CMake
  4.4.4, **no MSYS2**, ~300 GB free. `castcade-vpx-deps` injects ATL for the 10.8.0 build (`atl.cmake`), so the
  VS install may lack the ATL component; the standalone build uses libwinevbs's own ATL headers.

## 4. Phases

### P0 — Toolchain (owner approves installs)
1. Install MSYS2 to `C:\msys64`; in its UCRT64 shell run README's line:
   `pacman -S --noconfirm make diffutils nasm mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-zlib mingw-w64-ucrt-x86_64-libwinpthread mingw-w64-ucrt-x86_64-libiconv mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-tools`
2. Confirm VS 2022 has "Desktop development with C++" (v143 toolset, a Windows 10/11 SDK). Add ATL only if a
   build error asks for it.

Exit: `gcc`, `make`, `nasm` resolve inside the MSYS2 shell; `msbuild` resolves from a VS developer prompt.

### P1 — Source and dependencies
1. `git clone https://github.com/vpinball/vpinball C:\code\repos\vpx-109`, `git checkout -b reader/spike c3c47b5bcf`.
2. Dependencies, fastest first:
   - **(a)** download the CI artifact `VPinballX-10.9.0-<rev>-<sha>-dev-third-party-windows-x64-Release.zip` (and
     `-Debug`) from a recent `vpinball` Actions run at or near the pinned commit (`GITHUB_TOKEN= gh run download`),
     extract over `third-party/`. Check it contains `winevbs64.dll` and `third-party/include/libwinevbs/`.
   - **(b)** if (a) is missing, expired or lacks libwinevbs: run `platforms/windows-x64/external.sh` from the repo
     root in Git Bash with MSYS2 + MSBuild on `PATH` (README: point bash at the MSBuild `Bin` folder). Long; run in
     the background, log to a file, check the exit code (never pipe it away).

Exit: `third-party/runtime-libs/.../winevbs64.dll` and `third-party/include/libwinevbs/libwinevbs.h` exist.

### P2 — Build the standalone player
1. `make\create_vs_solution.bat`, answer `2022` → `.build\vsproject\VisualPinball.sln`.
2. Build project `vpx-standalone`, x64, Debug and Release (`msbuild ... /t:vpx-standalone /p:Configuration=Release /p:Platform=x64`), log to file.
3. `dumpbin /dependents VPinballX_BGFXStandalone64.exe`: imports `winevbs64.dll`, not `oleaut32.dll`/`ole32.dll`.
4. Optional: build the regular `vpx` project too (Microsoft engine) for side-by-side comparison.

Exit: the exe starts, opens a stock table (upstream's blank table) and plays a ball on keyboard.

### P3 — Test bench
1. Owner gathers the author `.vpx` files for **TNA** and **Deadpool** (LU ships `table.vbs` for both), plus a
   sample from the coverage findings: 4–6 "rules place all lines" tables across templates (JP original, VPW
   original, Burger template, a GLF table), 2 "rules cannot" tables (Stranger Things, Big Shot), and 1–2 with no
   LU script (AMH, JP's Slimer). Into `C:\code\repos\vpx-109-tables\`.
2. To mirror the cabinet, copy LU's `table.vbs` beside the table as `<TableName>.vbs` (VPX's sidecar rule;
   confirm the standalone build honours it).
3. **ScoreServer stub plugin** (from `plugins/helloscript`): a script-creatable `VPinball.ScoreServer` with
   `SetGameName`, `SetGameState(players, current, ball, state)`, `SetScoresArray(labels, scores)`,
   `SetHighScoresArray`, `AwardBadge`, `ClearState`, each logged with a timestamp. Deadpool's LU script calls
   these, so it becomes the ground truth. (Without an object, LU's Deadpool errors at init:
   `If Not ScoreServer Is Nothing` on `Empty`, FINDINGS-SS §1.) Confirm `CreateObject` reaches a plugin class
   in standalone.

Exit: Deadpool runs one game and the stub logs state 1 → 2 per drain → 3 + `ClearState`.

### P4 — The two read routes (run in parallel)
- **R1 — core probe (truth about the engine).** A few dozen lines in the player: after script init, every
  250 ms on the main thread, get the script's global dispatch (`GetScriptDispatch` or the standalone
  equivalent), `GetIDsOfNames` the candidate names, `Invoke(DISPATCH_PROPERTYGET)`, log the values. Cover: a
  scalar, the `Score` array (whole array and by index), a `Const` (expect `E_NOTIMPL`), an unknown name
  (expect `DISP_E_UNKNOWNNAME`). Measure the cost per read.
- **R2 — plugin probe (the route that needs no VPX change).** Plugin registers a script object `ArcaidProbe`
  with `Report(...)`; on `OnPrepareFrame`, every ~250 ms, `RunScript("On Error Resume Next : ArcaidProbe.Report PlayersPlayingGame, CurrentPlayer, Balls, bGameInPlay, Score(1), Score(2), Score(3), Score(4)")`.
  Answer: does `RunScript` run in the table's global scope? cost per call on frame time? does a bad name raise a
  script error dialog despite `On Error Resume Next`?

Exit: a short table — per route: works yes/no, values correct, ms per poll, failure modes.

### P5 — Events and map format (after P4 picks a route)
- Names: defaults from the Castcade vocabulary; per-table override file
  `{ "score": "Score", "scoreBase": 1, "players": "PlayersPlayingGame", "player": "CurrentPlayer", "ball": "Balls", "inPlay": "bGameInPlay" }`.
- Rules: in-play flag on → game start; ball number changes while in play → drained ball (per-ball points =
  score delta); flag off → game over with the last scores seen while in play (some tables zero `Score(i)` in
  the end sub); table exit with the flag on → no game over (quit / shutdown); no flag variable → in play =
  ball > 0; keep the last player count above 0.
- Output: log lines shaped like LU's ScoreServer record (`game_end`: `started`, `game_duration`, `reason`,
  `rom`, `scores[{player,score}]`, `balls[{ball,points}]`, `timestamp`; schema in FINDINGS-SS) so the Arcaid
  cabinet app could read it unchanged.

### P6 — Validation (owner plays, agents read the logs)
- Deadpool: reader events vs the stub's ground truth, same game.
- TNA: two full games + a quit in one launch → 2 game overs + 1 quit.
- The sample tables: one game each; note which need a map override and why.
- Multiball and extra ball must not read as a new game; a hold-Start restart reads as quit + new game.

### P7 — Hand-off
`docs/design/script-variable-reader-10.9-FINDINGS.md`: route recommendation (R2 with today's API, or R1 as a
small "read script variable" call proposed for the plugin API), map format, per-table results, cost numbers,
the probe code as a patch/plugin. The owner relays to Wraith; PR target depends on his answers (below).

## 5. Agent split

The lead session plans, reviews and merges findings; agents execute and **return blockers instead of working
around them**. Each agent writes only inside its scope.

| # | Agent | Scope | Needs | Returns |
|---|---|---|---|---|
| A | Setup | P0 (after owner OK), P1, P2 in `vpx-109` | — | exe path, deps route used, build log paths, blockers |
| B | Bench | P3 stub plugin source in `vpx-109/plugins/` (new folder), test-folder layout | A's clone | stub plugin, table checklist for the owner |
| C | Core probe | R1 in `vpx-109/src` | A's build | R1 table + patch |
| D | Plugin probe | R2 in `vpx-109/plugins/` (new folder) | A, B | R2 table + plugin |
| E | Detector | P5 | C/D verdict | event code + map format |
| F | Review | read-only over C/D/E | all | issues, not edits |

A and B run in parallel; C and D run in parallel after A; E waits for C and D; owner game sessions (P3 exit,
P6) are scheduled when E lands. Long builds always in the background, logged, exit code checked.

## 6. Open questions

For Wraith (asked 2026-11-21, unanswered): ScoreServer as a published plugin — would he take a PR adding the
reader? Plugin `RunScript` route, or a "read script variable" call added to VPX's plugin API (upstream change)?
What are LU's libwinevbs "compatibility patches", and do any touch the global dispatch?

For the spike: does `RunScript` see table globals; does standalone honour `<Table>.vbs`; can a plugin class
answer `CreateObject("VPinball.ScoreServer")`; poll rate needed to never miss a fast game over → new game.

## 7. Risks

- Master moves: stay on the pinned commit for the whole spike; rebase once at P7 if needed.
- `ScriptablePlugin` is unstable upstream; R2 may break on a later 10.9 commit.
- LU's engine patches are unknown; a result on upstream libwinevbs is strong evidence, not proof.
- Variable-name drift: a table update that renames its score variable needs a map edit (rare; far less than
  re-applying a sidecar).
- Ball-number polling cannot see an extra-ball drain (same ball number); per-ball points may merge there.
