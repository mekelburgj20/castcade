# Phase 0 spike — runbook and results

**Status:** run on the owner's rig 2026-10-17 (desktop VPX, driven by `spike/autoplay.py`); **all five gates passed**, see §8.
Still open for the owner: the hands-on feel of the lock (flippers visibly dead), VR controller / analog plunger inputs, and reading the F11 FPS overlay during a capture, all on the **VR build (`VPinballX_GL64.exe`)** the owner actually plays, see §8 "VR build". MM game 1 in the recorded fixture was played by the owner by hand, not by autoplay (§8).
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

## 8. Results (run 2026-10-17, 18:08–18:25)

**How it was run.** All three staged tables were launched with `VPinballX64.exe -Ini <scratch copy> -Play <staged .vpx>` (the ini copy only
remapped Start to `1`, turned on `EnableLog`/`LogScriptOutput`; the owner's ini was not touched; the exe in this install is the non-VR
build, windowed 1920×1440). Keys came from `spike/autoplay.py`: one credit, Start, then plunge every 7 s and never flip, until the
tailer reported `game_end`; the 0c exercise ran mid-game on TFTC and Iron Maiden and after game over on MM. Each table was quit with
the exit key, so `table_exit` closed every journal. The three journals are in `fixtures/` (gzipped) with `.meta.json` sidecars.

**Exception, MM game 1 was hand-played.** The owner, not told the run was unattended, inserted the coins, pressed Start and flipped
the first MM game: the journal shows credits 4→5→6 at t≈47 s and t≈70 s and `game_start` at t=169 s, 16 s *before* autoplay's first
Start press (t≈185 s); autoplay then plunged into that game's balls 2–3 and ran game 2 (t=278–350 s) on its own, with the owner possibly
still touching the flippers early in it. The MM fixture is therefore a **mixed human/autoplay recording**. That does not weaken the 0a
gate (who pressed the keys is irrelevant to NVRAM decoding, and a hand-played game is the more realistic fixture), but the metadata says
so and finding 1 carries the caveat. It was not re-recorded: the owner's upcoming hands-on session on the VR build is the next MM fixture.

| Item | Table | Result | Evidence / notes |
|---|---|---|---|
| 0e | TFTC | **PASS** | journal `table_loaded` 2 s after launch; no dialog (screenshot); no `%TEMP%` breadcrumb |
| 0e | MM | **PASS** | same; `Castcade` folder, `scripts\castcade.vbs` found via `GetTextFile` |
| 0e | Iron Maiden | **PASS** | same (23k-line class-B sidecar compiled and ran) |
| 0a | TFTC (`tftc_400`) | **PASS** | live NVRAM **8238 = on-disk .nv 8238, offset +0 (97% agreement) → SAME INDEXING**; `game_start` t=61.6, `ball_end` 1/2/3 at 91.6/127.0/169.4, `game_end` score 2,318,430; 22,235 deltas in 185 s |
| 0a | MM (`mm_109c`) | **PASS** | live NVRAM **12334 = .nv 12334, offset +0 (98%) → SAME INDEXING**; two games: `ball_end` 1/2/3 + `game_end` (277,500) then again (1,089,510); 77,547 deltas in 387 s; no extra ball lit in either game (game 1 hand-played by the owner, game 2 autoplay, see "Exception" above) — extra-ball fixture still to record |
| 0b | Iron Maiden | **PASS** | `game_start`, 206 `current_scores` climbing, `ball_end` 1/2/3 (the `ball` value is the ball that just ended, `extra_balls` 0), `game_end` 384,260. **End-of-ball bonus is added after `ball_end`** (259,760 at ball_end → 384,260 at game_end) |
| 0c | keyboard (synthesized scancodes) | **PASS (journal)** | on all three tables: `lock locked=true` once, then `key_blocked` for LShift 42, RShift 54, Enter 28, Start 2 while locked; a flipper held down while locked had its key-up swallowed (no stuck flipper), a flipper held down across unlock→lock released normally; exit key still worked. TFTC also caught a real autoplay plunge (28) while locked. **Owner still confirms the table visibly did nothing** |
| 0c | VR controllers | open | owner: VPX maps joystick buttons to keycodes before `_KeyDown`, expected to pass; `PlungerAxis = 5` is configured on this rig, so an **analog plunger exists → test it** |
| 0c | other inputs | open | analog plunger / nudge if present (`PBWEnabled = 1` in the ini) |
| 0d | MM, game in progress | **PASS (CPU/encoder), FPS unread** | `0d \| attempt=2 \| frames=898/900 \| ffmpeg cpu=1.7% \| enc=3.7% \| vpx fps before=__ during=__`; attempt 1 (GPU-resident `hwmap` to CUDA) fails on this ffmpeg build with `-40`, attempt 2 (ddagrab → hwdownload → h264_nvenc) works; VPX CPU 8.5% unchanged during capture; GPU already at ~80–85% because `MaxFramerate = 0` (uncapped). The F11 overlay did not appear on a synthesized F11, so FPS before/during is the owner's to read |

Tailer summaries (verbatim gate lines):

```
MM   0e PASS · 0a PASS (nvram_full=16 deltas=77547 ball_end=6 game_end=2) · 0c ENGAGED 5 times (3 lock transitions)
TFTC 0e PASS · 0a PASS (nvram_full=5  deltas=22235 ball_end=3 game_end=1) · 0c ENGAGED 6 times (3 lock transitions)
IM   0e PASS · 0b PASS (game_start=1 current_scores=206 ball_end=3 game_end=1) · 0c ENGAGED 6 times (5 lock transitions)
```

### Findings Phase 3 must absorb

1. **Journal volume and frame cost (hook 0.1.0).** WPC RAM changes every PinMAME tick: MM produced ~200 `nvram_delta` lines/s (≈95 KB/s,
   37 MB for 6.5 min). VPX's own frame profiler logged ten long frames for the patched MM run, 10–13 ms each with the time inside
   `PinMAMETimer` (our callback), plus **148 ms and 51 ms frames at the periodic `nvram_full` snapshot** (`Join` of 12,334 bytes). The
   unpatched MM baseline run, and the patched TFTC and Iron Maiden runs, logged no long frame at all. Fix: journal only the bytes inside
   the map's `game_state` region (≈100 bytes, known at render time from the map), throttle deltas to ≥50 ms, and take the full snapshot
   only at hook time and on request. 0d's "<5 % frame cost" therefore holds for capture but **not yet for the 0.1.0 hook on WPC**.
   Caveat: the patched MM run contained the owner's hand-played game 1 while the unpatched baseline was autoplay-only, so the two runs
   are not strictly like for like. The conclusion stands anyway: the 148/51 ms spikes sit at `nvram_full` snapshots, which do not depend
   on play, and the ~200 deltas/s rate held through attract mode (WPC timers, not flipper activity). The owner's VR session gives a
   second patched run to compare.
2. **ROM boot garbage.** MM fills NVRAM with 0x55 then 0xAA during its power-on RAM test (`current_player` decodes as 85/170). The first
   tailer pass derived a fake `game_start`/`ball_end`/`game_end` from it. The detector now rejects implausible states (`plausible()`:
   player 0–4, ball within range, integer scores) and only ends a game that had a ball in play; both fixtures replay clean.
3. **Bonus after `ball_end` on originals.** Iron Maiden adds the end-of-ball bonus after `EndOfBall` fires, so the score at `ball_end`
   is not the ball's final score. The match detector must take a player's score at the *next* `game_start`/`ball_end`/`game_end`, or
   after a quiet period, never at the `ball_end` instant. (NVRAM tables: the same rule, since WPC counts bonus down after the drain.)
4. **`ball` at `ball_end` is the ended ball** on Iron Maiden (`Balls` evaluated at the top of `EndOfBall`), matching the NVRAM path.
5. **Alignment is a no-op on both platforms tested** (WPC, Data East): live `Controller.NVRAM` has the same length and indexing as the
   `.nv` file. The maps apply unshifted; the Phase 3 decoder keeps the alignment check only as a sanity assertion.
6. **Autoplay works through DirectInput.** SendInput with scancodes drives VPX (Start, plunger, flippers, exit); fixture recording needs
   no human once the table is staged. Useful for the Phase 3 verification run ("import → launch → one automated ball → ready").
7. **ffmpeg path.** On this build `ddagrab` → `hwmap(cuda)` is unavailable; `ddagrab` → `hwdownload` → `h264_nvenc` costs 1.7 % CPU
   and 3.7 % of the encoder at 720p30. Phase 4 should also try `-filter_complex ddagrab=output_fmt=…,hwmap=derive_device=cuda` with
   a newer ffmpeg, or capture via the companion's own D3D11 path, but the fallback is good enough.

### What the results decide

- **0e passes** → sidecar is the default install path (design §6). Fails or prompts → recipes write an `importvbs` copy `<Table> [Castcade].vpx`.
- **0a SAME INDEXING** → the companion decodes the live array with the maps as-is. SHIFT → one constant per platform family, recorded in the maps adapter.
- **0a/0b pass** → Phase 3's detector gets its first fixtures; Phase 2 (Witness basic mode) can proceed independently.
- **0c passes on all the owner's inputs** → script-side lock is the v1 turn lock; the OS-level hook is dropped from Phase 3 scope.
  Fails for analog devices only → OS-level hook becomes a Phase 3 item for those devices. (Keyboard path passed 2026-10-17; the
  analog plunger on this rig is the open case.)
- **0d passes** → `media` module plan stands (ddagrab + NVENC via the host companion). Fails → test the alternative capture path before Phase 4.

### VR build

The owner plays the **OpenGL / VR build**, `VPinballX_GL64.exe` (10.8.0.2078, links `openvr_api`), not `VPinballX64.exe`
(10.8.0.2079, no OpenVR) that the unattended run used. Checked 2026-10-17: both exes sit in the same folder, read the same portable
`VPinballX.ini` and the same `scripts\castcade.vbs`, and the sidecar `.vbs` is found beside the `.vpx` regardless of the exe, so 0e, 0a
and 0b do not depend on the renderer and need no re-run. What does differ, and is why the hands-on pass should be on the GL64 build:

- **0c inputs.** VR controller buttons and the analog plunger (`PlungerAxis = 5`, `PBWEnabled = 1`) are the untested input paths. The
  joystick keys in the ini (`JoyLFlipKey = 5`, `JoyRFlipKey = 6`, `JoyPlungerKey = 10`) are mapped to key actions before `_KeyDown`, so
  they should be swallowed like the keyboard; an analog plunger pull drives the plunger body directly and will **not** be, which is the
  expected open case.
- **0d capture.** The owner's ini has `VRPreview = 0`, so in VR the desktop window shows no preview and `ddagrab` would capture nothing
  useful. A spectator feed in VR needs `VRPreview` set to one eye (1 or 2) and the frame cost re-read against the headset's 90 Hz budget,
  not the uncapped desktop rate. The F11 overlay is read inside the headset.
- **Logging.** `EnableLog = 1` in the owner's own ini (or an `-Ini` copy) writes `vpinball.log` beside the exe for either build.

Any gate that fails is written up here first; the ADR it affects (0001 for 0a/0e, the match design for 0c) is amended only after the owner reads it.
