# Phase 0 spike — runbook and results

**Status:** kit staged 2026-10-17, awaiting the owner's play sessions. Results go in §8 of this file.
**Decides:** the five open questions the plan's Phase 0 row names (`docs/design/arcaid-integration-gap-analysis.md` §6).
Nothing in Phases 1–6 that touches VPX can start honestly until the gates below are read.

| Item | Question | Gate |
|---|---|---|
| **0a** | Does `Controller.ChangedNVRAM` reach a per-table sidecar on 10.8.0, and do live indexes match the on-disk `.nv` offsets the maps use? | Ball 1 → 2 → 3 and game over decoded live on one WPC (Medieval Madness) and one Data East (Tales from the Crypt) table |
| **0b** | Can a script-only original report scores and game boundaries through the same sidecar? | `current_scores` climbing, `ball_end`, `game_end` on Iron Maiden LOTB |
| **0c** | Does swallowing keys in `_KeyDown` make the flippers dead while a lock file exists, and does it cover the owner's real inputs (keyboard, VR controllers, cabinet encoder if any)? | Flippers, plunger and Start do nothing while locked; release instantly on unlock; nothing sticks |
| **0d** | Window capture + hardware encode at 720p30 | < 5% VPX frame cost (F11 overlay before vs during) |
| **0e** | Does a same-basename sidecar `.vbs` auto-load on 10.8.0 Windows, silently? | `table_loaded` appears in the journal with no prompt (note any dialog wording) |

## 1. What the kit is

| Piece | Path | Role |
|---|---|---|
| Library | `vpx-hook/castcade.vbs` (installed to `<VPX>\scripts\castcade.vbs`) | Journal writer, lock check, the single `NVRAMCallback` registration (chains), helper subs for originals |
| Renderer | `vpx-hook/spike/render-sidecar.py` | Classifies an extracted script (design §4 rules) and renders the sidecar (design §5 recipes A and B) |
| Staging | `vpx-hook/spike/stage.ps1` | Copies the three tables to `tmp/spike/tables/`, extracts, renders, installs the library, creates `%LOCALAPPDATA%\Castcade\{journal,lock}` |
| Tailer | `vpx-hook/spike/tail-journal.py` | Decodes a journal (maps corpus for VPM, script events for originals), runs the ball-end detector, prints the gate verdicts |
| Lock | `vpx-hook/spike/lock.ps1` | Creates / removes `turn.lock`; `cycle` mode toggles on a timer with beeps for hands-on-table testing |
| Capture | `vpx-hook/spike/capture-test.ps1` | ffmpeg ddagrab + NVENC 720p30 for 30 s, samples CPU/GPU/encoder, prints a paste line |

What is modified on the rig: one new file `scripts\castcade.vbs`, one new folder `%LOCALAPPDATA%\Castcade`,
and copies under `castcade\tmp\spike\tables\`. The real tables, `core.vbs`, nvram and `user\` folders are untouched.
**Revert:** delete the three `.vbs` sidecars in `tmp\spike\tables`, delete `scripts\castcade.vbs`, delete `%LOCALAPPDATA%\Castcade`.

Tables and why: **Tales from the Crypt** (Data East, `tftc_400`, the table ArcAid's T7 probe already staged), **Medieval Madness**
(WPC, `mm_109c`; its map also carries `extra_balls`, so the extra-ball case can be recorded), **Iron Maiden LOTB** (VPW original,
class B: `Score()` array, `AddScore`, `ResetForNewGame`, `EndOfBall`, `EndOfGame`, dormant Scorbit hooks). All three maps have a
`game_state` block. Staged 2026-10-17: TFTC 5,923-line script → recipe A; MM 3,956 → A; Iron Maiden 19,951 → B, all anchors found.

## 2. Prerequisites (verified on the rig 2026-10-17)

- VPX 10.8.0 `VPinballX64.exe`, Python 3.14 on PATH, ffmpeg 8.1 on PATH, RTX 3090 (NVENC).
- ArcAid's gitignored evidence at `C:\code\repos\ArcAid\tmp\vpx-desktop-witness\`: `vpxtool.exe`, `pinmame-nvram-maps`, `py-pinmame-nvmaps`.
  The tailer defaults to those paths; override with `--maps`, `--parser`, `--nvram-dir`.
- Run everything from `C:\code\repos\castcade` in PowerShell 7 (`pwsh`).

## 3. Stage (already done once; re-run after any change to `castcade.vbs` or the renderer)

```
pwsh -File vpx-hook\spike\stage.ps1
```

It prints a table of class / recipe / ROM per table and the exact `-Play` command lines. `-Force` re-copies the `.vpx` files;
`-Tables 'Attack from Mars LE (Midway 1995) v600'` stages another table (AFM `afm_113b` and Fish Tales `ft_l5` also classify A).

## 4. Run 0a + 0e — the two ROM tables

Do this once for Tales from the Crypt and once for Medieval Madness.

1. In one terminal start the tailer in follow mode (table name exactly as staged):
   ```
   python vpx-hook\spike\tail-journal.py "Medieval Madness (Williams 1997) VPW v1.0.1" --follow --quiet-scores
   ```
   It says `journal not found` until the table has been opened once; that is expected the first time. Start it again after launch.
2. Launch the staged copy, either from the command line stage.ps1 printed, or VPX → File → Open → `tmp\spike\tables\<name>.vpx`.
   - **0e:** note whether VPX says anything about an external script and the exact wording. No dialog is the hoped-for result.
   - The tailer should print `table_loaded`, then `nvram_hook chained=False use_nvram=True`, then `nvram_full` with the alignment line.
3. Play **one full game to Game Over** (drain all three balls). If you can, start a **second game** before quitting so two game boundaries are in one session.
   On MM, if an extra ball lights, take it: that recording is the extra-ball fixture the plan asked for.
4. Quit the table normally (ESC → quit), not a kill: the exit hook flushes the journal and VPinMAME writes the `.nv`.
5. Read the summary the tailer prints (or re-run without `--follow` and with `--last`).

What to look for:

- `alignment: ... best offset +0 ... SAME INDEXING` → live `Controller.NVRAM` indexes equal `.nv` offsets, maps apply unshifted.
  `SHIFT +N` means the on-disk file has an N-byte header; the tailer applies it automatically and the Phase 3 decoder must do the same.
  `NO MATCH` means the live array is not the mapped region: that is a real finding, stop and record it.
- Derived `game_start`, `ball_end` ball 1, 2, 3, `game_end` in order. The gate line `0a live NVRAM: PASS` needs balls 1, 2 and 3 plus a `game_end`.
- `current_scores` lines while playing (hidden by `--quiet-scores`; drop the flag to see them).

Failure modes, in order of likelihood:

- **No `nvram_full` and `nvram_delta` at all, but `nvram_hook use_nvram=False`** → `UseVPMNVRAM` did not reach `core.vbs` line 37. The sidecar
  sets it right before `LoadVPM`; if that is too late on this table, move the line before `controller.vbs` loads (T7's placement). Record which worked.
- **`warn NVRAMCallback registration failed`** → `core.vbs` was not loaded where the sidecar expected; same fix as above.
- **Deltas flow but the score never moves** → region/offset mismatch; the alignment line is the lead.
- **No journal file at all** → the sidecar did not run (0e fails: VPX ignored the `.vbs`) **or** the library did not load. Distinguish with
  `%TEMP%\castcade-sidecar-ran-but-no-library.txt`: present means the sidecar ran and `castcade.vbs` was not found by `GetTextFile`.
- **A VBScript error dialog from VPX** → note the line number, open `tmp\spike\tables\<name>.vbs` at that line; everything we inserted is
  marked `' Castcade`. Setting `LogScriptOutput = 1` in `VPinballX.ini` also logs script errors.

## 5. Run 0b — Iron Maiden (original)

Same procedure with `"Iron Maiden (Original 2022) VPW 1.0.12"`. No NVRAM lines are expected; instead the script itself emits
`game_start` (end of `ResetForNewGame`), `current_scores` (end of `AddScore`, de-duplicated), `ball_end` (top of `EndOfBall`, with
`extra_balls`) and `game_end` (top of `EndOfGame`). Play one game to Game Over. Gate: `0b original scoring: PASS`.

Watch for: the `ball` number reported at `ball_end` (it is the table's `Balls` function; check whether it is the ball that just ended
or the next one), and whether an extra ball produces a `ball_end` whose `extra_balls` is non-zero (then the detector must not hand the turn over).

## 6. Run 0c — turn lock

With any of the three tables running and a game in progress:

1. From a second terminal: `pwsh -File vpx-hook\spike\lock.ps1 cycle -Seconds 10`. High beep = locked, low beep = unlocked, Ctrl+C ends unlocked.
2. While locked, work the flippers, plunger/launch, Start, nudges, lockbar, magna-saves. Expected: **nothing happens** on the table, the tailer
   prints `lock locked=true` once and then one `key_blocked key=N` per press.
3. While unlocked everything works. Hold a flipper across a lock transition both ways: it must release normally (a key-up is only swallowed
   when its key-down was swallowed).
4. Repeat with every input you actually use: keyboard, VR controller buttons, a gamepad or cabinet keyboard encoder if you have one.
   VPX translates buttons to the configured keycodes before calling the script, so these should all be caught. **An analog plunger or nudge
   from DirectInput bypasses the script**: if you have one, test it and record the result; the design's fallback for that case is an OS-level hook.
5. Also check: can you still quit with the exit key while locked (must be yes), does the VPX pause menu still work (yes), does the DMD / ROM
   keep running normally (yes: the ROM never knows the keys were pressed).

Gate: `0c script turn lock: ENGAGED N times` in the summary **and** your observation that the table did nothing while locked.

## 7. Run 0d — capture

With a table running and a game in progress, note the VPX FPS (F11 overlay) for 20 s, then:

```
pwsh -File vpx-hook\spike\capture-test.ps1 -Seconds 30
```

Note the FPS again during the capture. The script prints a paste line (`0d | attempt=... | ... | vpx fps before=__ during=__ | PASS/FAIL`).
`-Monitor 1` if the VPX preview window is on a second display; `-WindowTitle "Visual Pinball"` forces the gdigrab window path for comparison.
In VR the capture is of the desktop preview window, which is also what spectators would see.

## 8. Results (fill in)

Copy the tailer summaries here verbatim. Then copy each session's journal into `fixtures/` as `fixtures/nvram/<rom>/<yyyy-mm-dd>-<n>.jsonl`
(ROM tables) or `fixtures/script/<table-slug>/<yyyy-mm-dd>-<n>.jsonl` (Iron Maiden), with a sibling `.meta.json` naming the table file,
VPX version and sidecar sha256 from `tmp\spike\tables\manifest.json`. They are the first detector fixtures.

| Item | Table | Result | Evidence / notes |
|---|---|---|---|
| 0e | TFTC | | dialog wording, if any |
| 0e | MM | | |
| 0e | Iron Maiden | | |
| 0a | TFTC (`tftc_400`) | | alignment line; balls seen; game_end |
| 0a | MM (`mm_109c`) | | alignment line; balls seen; game_end; extra ball? |
| 0b | Iron Maiden | | scores climb; ball numbering at ball_end; game_end |
| 0c | keyboard | | |
| 0c | VR controllers | | |
| 0c | other inputs | | analog plunger / nudge if present |
| 0d | | | paste line from capture-test |

### What the results decide

- **0e passes** → sidecar is the default install path (design §6). Fails or prompts → recipes write an `importvbs` copy `<Table> [Castcade].vpx`.
- **0a SAME INDEXING** → the companion decodes the live array with the maps as-is. SHIFT → one constant per platform family, recorded in the maps adapter.
- **0a/0b pass** → Phase 3's detector gets its first fixtures; Phase 2 (Witness basic mode) can proceed independently.
- **0c passes on all the owner's inputs** → script-side lock is the v1 turn lock; the OS-level hook is dropped from Phase 3 scope.
  Fails for analog devices only → OS-level hook becomes a Phase 3 item for those devices.
- **0d passes** → `media` module plan stands (ddagrab + NVENC via the host companion). Fails → test the alternative capture path before Phase 4.

Any gate that fails is written up here first; the ADR it affects (0001 for 0a/0e, the match design for 0c) is amended only after the owner reads it.
