# PinMAME machine-migration feasibility survey (2026-11-04)

**Status:** reference for WORK item I10 (the shared machine). Read-only survey of `github.com/vpinball/pinmame`
at `20a1d01a` (2026-11-04); a scratch clone under `tmp/` (gitignored); nothing built. Paths are relative to the
PinMAME repo root.

**Question.** In an online 2–4 player game of ONE pinball machine, the emulator runs on the active player's PC (so
flippers, slingshots and solenoids react locally); at the end of each ball the whole emulator state is serialised,
sent to the next player's PC and restored there, so the same game continues (player 2's ball 1 follows player 1's,
the end-of-game sequence runs at the right time, one DMD shows every player). Watchers mirror the active machine's
outputs (lamps, solenoids, GI, DMD frames, sound commands); under ADR 0009 they see the table itself as 2D video.

## 1. Save states

**The MAME 0.76 state machinery is compiled into VPinMAME, but no PinMAME driver registers anything with it, and it
is not reachable over COM.** `src/state.c` (header `'MAMESAVE'`, version 1, zlib); `src/cpuexec.c:535 handle_save()`
/ `:582 handle_load()` (tag 0, then one tag per CPU with `cpuintrf_push_context`); scheduled only by `src/mame.c:324`
(command-line `savegame`) and the UI keypress (`src/usrintrf.c:3647`). Both files are in
`cmake/vpinmame/CMakeLists_win-x64.txt` (345, 355); nothing in `src/win32com/` touches them.

Registrations (`grep -rc state_save_register src`): **`src/wpc/*` zero in every file** (WPC, S11, DE, SAM,
Whitestar, GTS3/80, By35, Capcom, Alvin G, Zaccaria, every sound board, `core.c`, `mech.c`, `vpintf.c`). CPU cores
that register: m6809 (`src/cpu/m6809/m6809.c:527-537`), m6800, m68000, i8051, arm7, z80, i86, m6502, cop420, pps4,
scamp, tms7000, i8039, i8085, i4004, tms9900. **Missing: `adsp2100` (DCS), `at91` (SAM), `tms320c1x`, `mips32`,
`pic32mx`, `p8x32a`, `s2650`, `cdp1802`.** Peripherals: `6821pia.c` registers; `6522via.c`, `6532riot.c`,
`8255ppi.c`, `pic8259.c` do not; sound chips ym2151/fm/ay8910/adpcm register, `bsmt2000`, `hc55516`, `dac`,
`tms5220`, `samples` do not. `src/timer.c` registers nothing; `src/cpuint.c:144-148` registers irq enable/vector/line.

**Generic RAM capture exists:** `src/memory.c:1665 register_banks()` (from `memory.c:267` at init) registers every
contiguous `MRA_RAM/MWA_RAM/RAMROM` range and every non-static write handler with a `base` pointer
(`memory.c:1734`), plus every `MRA_BANKn` window as the 512 B currently mapped (1801–1808). For WPC
(`src/wpc/wpc.c:156-181`): `0x0000-0x2fff wpc_ram_w,&wpc_ram` (captured), `0x3c00-0x3faf MWA_RAM`, `0x3fb0-0x3fff
wpc_w,&wpc_data` (the 80 ASIC registers, captured), DMD banks 2–7 (512 B windows), ROM bank 1. **Caveat:** only the
window currently mapped through each DMD bank is saved, not the 8 KB DMD region (`WPC_DMDREGION`, `wpc.h:103-106`);
a postload must re-run `cpu_setbank` from the restored `wpc_data` page registers and `WPC_ROMBANK` (`wpc.c:1022-1037`).

Generic CPU context: `cpunum_get_context_ptr` (`src/cpuintrf.c:1247`), `cpunum_get_reg/set_reg` (1282/1293); every
core has `*_get_context/_set_context` doing a struct memcpy (`m6809.c:425-439`; `adsp2100.c:553-575`, whose ~1 KB
`adsp2100_Regs` holds an `irq_callback` function pointer at line 258, so a raw copy across processes needs a fix-up).

**Full-state size, WPC-95 + DCS:** WPC RAM 16.3 KB + ASIC regs 80 B + DMD region 8 KB + ADSP-2105 data RAM 16 KB +
1 KB + program RAM ~8 KB + external program RAM 32–48 KB (`wmssnd.c:1425-1484`; the banked data RAM behind
`dcs2_RAMbank_w`, `wmssnd.c:1470`, is not registered) + CPU contexts ~1.1 KB + driver statics 1–2 KB ≈ **80–110 KB
raw**. The large derived state `coreGlobals.physicOutputState` (`core.h:528`; ~380 B per output with 32 flip
timestamps each) is an integrator that re-converges in milliseconds and need not migrate.

## 2. DMD and alphanumerics

WPC rasteriser `wpc.c:1655 wpc_dmd_hsync()` (~122 raw 1-bit frames/s) → `core_dmd_submit_frame` (`core.c:4201`,
ring of 16 pages) → `core_dmd_compute_pwm` (4213, per-dot float luminance) → `core_dmd_compute_identify` (4357, the
shade-index "raw" frame; 4 shades on WPC, 16 on pinHeck/SAM) → `core_dmd_publish` (4580, double buffer). VPM:
`core_dmd_send_vpm` (`core.c:1088`) fills `g_raw_dmdbuffer` (0–100 UINT8) and `g_raw_colordmdbuffer` (RGB),
`g_needs_DMD_update` on change; COM `Controller.cpp:692 get_RawDmdPixels`, `:722 get_RawDmdColoredPixels`,
`:521/:530` width/height, `:752-:782 DmdWidth/DmdHeight/DmdPixel/updateDmdPixels`. DMD devices: `core.c:1192
core_dmd_send_dmddevice()` (also hands over the raw 1-bit frames). Lamps/solenoids/GI: `src/wpc/vpintf.c:72
vp_getChangedLamps`, `:133 vp_getChangedSolenoids`, `:182 vp_getChangedGI` over `coreGlobals.lampMatrix/solenoids/
gi[]` (`core.h:512-522`); COM `Controller.cpp:1284/1492/1463`. Alphanumerics: `coreGlobals.segments`, `vpintf.c:374
vp_getChangedLEDs`, COM `Controller.cpp:1308/1340`.

## 3. Inputs, batching, timing, threads

Switch path: `Controller.Switch(n) = v` → `Controller.cpp:443 put_Switch` (only while `m_hEmuIsRunning`) →
`core_setHostSw` (`core.c:2354`) → `core_setSw` (2288), which **writes `coreGlobals.swMatrix` from VPX's thread**,
no lock, `volatile` fields (`core.h:509`); bulk `put_Switches` (1086). No per-frame switch batching in PinMAME (any
batching is in VPX's `core.vbs`); the only queue is the record/playback switch log at 1 kHz (`core.c:2335`).

**Time fence (exists):** COM `Controller.cpp:1686 put_TimeFence(double)` → `vpintf.c:320 vp_setTimeFence` →
`options.time_fence`; in `src/cpuexec.c:1050-1083` inside `cpu_timeslice()` the emulation publishes outputs
(`cpu_publish_outputs(1)`) and `time_fence_wait(0.250)` on a semaphore when it reaches the fence, re-aligns if it gets
≥ 1 s ahead, `mame_pause(1)` on timeout; `Stop()` clears it first (`Controller.cpp:383`). Without a fence the
emulation free-runs in its own thread (`src/windows/video.c` throttle). The emu thread also pumps the Win32 message
loop every slice (`cpuexec.c:1041-1045`). Threads: `Controller.cpp:343` creates the emulation thread
(`ControllerRun.cpp:90 RunController` → `run_game`); `m_hEmuIsRunning` gates every COM call; `g_fPause` is polled;
COM calls execute on VPX's thread against shared globals with atomics and double buffers, not a mutex. WPC rates:
IRQ 976.5 Hz, interface update 60 Hz, zero-cross 120 Hz (`wpc.c:31/47/382`).

## 4. Sound

Chips → `src/sound/streams.c` → `mixer.c:1060 mixer_sh_update()` → `osd_update_audio_stream` → DirectSound
(`src/windows/sound.c:379`). **A command level exists and is already mirrored three ways:** every main-board write to a
sound board goes through `src/wpc/sndbrd.c:87 sndbrd_data_w()` → `snd_cmd_log` (`snd_cmd.c:549`) → AltSound
(`src/wpc/altsound/`, built in), PinSound (mailslot), libpinmame, and a ring read by `vpintf.c:360
vp_getNewSoundCommands()` → COM `Controller.cpp:1761 get_NewSoundCommands`. A watcher can therefore mirror
**commands** and run its own sound board or AltSound pack. Limits: DCS state (volume, running tracks, fades) lives in
the ADSP program, so a watcher joining mid-game either receives the DCS RAM too or starts a cold sound board; mech
samples are separate. DCS internals: `wmssnd.c` `dcslocals` (1364–1404), `dcs_dac` (1340–1362), ADSP glue
(2773–2780: control registers, irq and sport timers), ADSP-2105 core `src/cpu/adsp2100/` (no state registration);
`soundlatch` (`src/sndintrf.c:27`) is a plain static behind a `TIME_NOW` timer.

## 5. NVRAM

`wpc.c:1586 NVRAM_HANDLER(wpc)` → `core_nvram(file, rw, wpc_ram, 0x3000 or 0x2000, 0xff)` (`core.c:3169`: the
block, then `mech_nv()` positions, then 6 DIP bytes). Loaded once (`mame.c:618`, `nvram/<rom>.nv`), **written only
at exit** (`mame.c:642`). COM reads it through a `RAM_FILE` pseudo-file (`Controller.cpp:539 get_NVRAM`, `:608
get_ChangedNVRAM`). On WPC the NVRAM is the first 8–12 KB of `wpc_ram`, so it is inside any RAM-based state; for
CMOS outside the map (By35 5101, GTS, S11) `core_nvram` is the hook (the remote debugger uses exactly that,
`src/remote_debug/remote_debug.c:2603-2609`). NVRAM should migrate with the state; the receiving PC's `nvram/<rom>.nv`
is then overwritten at Stop with the migrated audits and high scores.

## 6. COM surface (`src/win32com/VPinMAME.idl:155-262`; bodies in `Controller.cpp`)

Mutate the machine (a watcher instance must ignore): `Run` (222), `Stop` (377), `Switch` put (443), `Switches` put
(1086), `Pause` put (461), `Dip` put (1577), `Mech` put (1435), `HandleMechanics` (1414), `SolMask` (1647),
`ModOutputType` (1672), `TimeFence` (1686), `GameName` put (1144), `HandleKeyboard` (1200), `MechSamples` (2007),
`SoundMode` / `MasterVolume` / `CurrentAudioDevice` / `FastFrames` / `IgnoreRomCrc` / `CabinetMode` puts
(2099–2266), `CheckROMS` (1918), the dialogs, the display puts (`ShowDMDOnly` 1834, `LockDisplay` 1626, `Hidden`
1972, `SetDisplayPosition` 1788, …). Read-only: `Lamp(s)`, `ChangedLamps`, `Solenoid(s)`, `ChangedSolenoids`,
`GIString(s)`, `ChangedGIStrings`, `ChangedLEDs(+State)`, the `*State` variants, `GetMech` (1425), `Dip` get,
`NVRAM`, `ChangedNVRAM`, the DMD getters, `NewSoundCommands`, `Running` (1271), `WPCNumbering`, `GameName` get,
`ROMName` (1183), `Version` (1696), `PMBuildVersion`, `Games` / `Game` / `Settings` / `Machines`, window rects,
audio-device enumeration.

## 7. Build and licence

`cmake/vpinmame/CMakeLists_win-x64.txt` (`add_library(vpinmame SHARED …)` 110, static CRT 796, defines
`VPINMAME VPINMAME_ALTSOUND VPINMAME_PINSOUND` 91–93); legacy `vcproj/*.vcxproj`. CI `.github/workflows/vpinmame.yml`
(`windows-2025-vs2026`, "Visual Studio 18 2026", win-x64 `VPinMAME64.dll` + `Setup64.exe`, a `-sc` coloured-SAM
variant, win-x86). **Licence** (`LICENSE`): the old MAME licence with a per-file migration to BSD-3-Clause (437
files tagged `// license:BSD-3-Clause`; `fm.c`, `fmopl.c`, `ym2151.c`, `ymf262.c` GPL-2.0+; `ym2151_opm.*` LGPL;
`src/wpc/bulb.*` and two libpinmame plugin headers GPLv3+); everything untagged, which is most of `src/` including
`cpuexec.c`, `memory.c`, `timer.c`, `state.c` and the drivers, stays old-MAME: "The source code cannot be used in a
commercial product without the written authorization of the authors"; "Selling either is not allowed". A Castcade
VPinMAME64.dll fork is possible as a **separate, source-published, non-commercial binary**; it cannot be folded into
the GPLv3 companion as one work without the PinMAME authors' agreement. (The same obligation binds anyone else who
distributes a modified VPinMAME: the source must be provided.)

## 8. Already in the tree

Switch-log record/playback (`src/wpc/core.c:2325-2500`: `.inp` plus a `.sw` text log of host switches at 1 kHz
and an `.nv` snapshot at recording start, RTC pinned; opened from registry options `record` / `playback`,
`VPinMAMEConfig.cpp:367`): deterministic **replay**, not state capture, but proof that the core replays
deterministically from NVRAM + timed switches. Remote-debugger checkpoints (`remote_debug.c:2600-2800`,
`/api/debugger/savestate`): every `MWA_RAM` block of CPU 0, every `core_nvram` block, main-CPU registers;
"lightweight", no sound CPU, timers, driver statics or banks; Linux only. `cpu_publish_outputs` hook
(`cpuexec.c:217`, `core.c:2829`). No netplay, no serialise/deserialise, no rewind.

## Interception points

- **Serialise / restore at ball end** (emulation thread): the time-fence park in `cpu_timeslice()`
  (`cpuexec.c:1050-1083`): all CPUs between slices, timers quiescent, outputs published. Add a "migrate" request
  flag checked there (like `loadsave_schedule`, `cpuexec.c:645-651`), then `handle_save`'s pattern (535–574) into a
  `RAM_FILE` `mame_file` (the trick `Controller.cpp:543-549` uses for NVRAM) and a new COM getter; restore mirrors
  `handle_load` (582–626) followed by postload hooks (`state_save_register_func_postload`, `state.c:327`). New COM:
  `MachineState` get/put plus a `Migrate`-style method beside `TimeFence`.
- **Output mirroring to watchers:** `core_publish_pwm_outputs` / `core_dmd_publish` (`core.c:3787/4580`), the
  `vp_getChanged*` family, `core_dmd_send_vpm` (`core.c:1088`) or the dmddevice hook (1192), `snd_cmd_log`
  (`snd_cmd.c:549`). The existing `Changed*` / `RawDmdPixels` / `NewSoundCommands` getters are the delta vocabulary;
  a watcher-side shim can replay them to a table script with no emulator at all.
- **Watcher mode:** a stub `IController` (or a `WatcherMode` flag on `CController`) answering the read-only getters
  from a network-fed shadow of `coreGlobals` / `g_raw_dmdbuffer` / the sound log, `Running = TRUE`, the mutating
  puts (§6) no-ops; `put_Switch` 443 and `put_Switches` 1086 are the two entry points table scripts hit every frame.

## Not reachable through the existing machinery (per-driver work)

1. Driver statics: `wpclocals` (`wpc.c:108-137`: solenoid smoothing, the PIC security handshake, page mask,
   zero-cross phase, GI on-times, triac conduction, the high-resolution timer, FIRQ lines), `dmdlocals` (144–147),
   `core.c:768 locals` (flip timers, solenoid log, DMD PWM rings), `mech.c`, `snd_cmd.c`, thirteen statics in
   `wmssnd.c` (DCS banks as pointers, the DAC ring, ADSP control registers and timers), `sndbrd.c`, `soundlatch`.
   Other platforms (`s11.c`, `dedmd.c`, `desound.c`, `se.c`, `gts80s.c`, `by35snd.c`, `capcom.c`, `zac.c`,
   `zacsnd.c`) each need the same by hand.
2. CPU cores without registration: ADSP-2100 family (every WPC-DCS / WPC-95 game), AT91 (SAM), TMS320C1x,
   MIPS/PIC32 (Spike); `*_get_context` exists for all, with function pointers to fix up.
3. Timers: `src/timer.c` keeps 256 timers with callback pointers and absolute doubles; periodic ones are re-created at
   init, one-shots in flight (`wpclocals.highres_timer`, DCS `irqTimer`, soundlatch) must be re-armed by postload;
   emulated time restarts at zero on the receiver, so every absolute timestamp must be rebased.
4. Bank mappings (`cpu_setbank` targets) restored per driver (`wpc.c:1022-1037`, `wmssnd.c:1729`).
5. Memory regions not CPU-mapped: the WPC DMD region (only 512 B windows caught), `DCS_BANKREGION`.
6. Peripherals without registration: 6522 VIA, 6532 RIOT, 8255, `bsmt2000`, `hc55516`, `tms5220`, `dac`, `samples`.
7. Host-side continuity: `SolMask`, `ModOutputType`, `HandleMechanics`, mech positions (partly in NVRAM via
   `mech_nv`), AltSound's own playback stack, DIPs.

Captured for free on WPC: all of `wpc_ram` (NVRAM, scores, player count, ball number, game mode), the 80 ASIC
registers, the 6809 context and IRQ state; for DCS only the ADSP RAM zones, not its registers.

## Estimate and risks (PoC: Medieval Madness, WPC-95 + DCS, two PCs, migrate at ball end)

**8–12 engineer-weeks** for a demo-grade proof, one engineer who knows MAME internals, both rigs at hand; not a
product. Fork + CMake/CI + a `MachineState` COM getter/putter around `handle_save/load` (1 wk); WPC registration and
postload (1–1.5 wk); DCS (2 wk, the hardest piece; alternative: do not migrate the sound CPU, cold-reset DCS and
resend the last volume command, a week back for a sound hiccup at each handover); `core.c` statics, mech, sound log,
time rebasing (1 wk); watcher stub controller + delta mirroring over the companion's data channel (1.5 wk); ball-end
detection and handover choreography using the time fence to park both sides (1 wk); testing until a four-player MM
game including the end-of-game match sequence and high-score entry survives 12+ migrations (2+ wk).

Risks: (1) unknown unknowns in unregistered state: a missed static does not crash, it desyncs seconds later and only
long play finds it; (2) DCS / ADSP-2105 migration; (3) cross-host emulated time and the output integrators (flippers,
flashers, GI misbehave after a bad rebase; the companion must also rebase the fence offset,
`time_fence_global_offset`, `cpuexec.c:216`); (4) licence (above). **A cheaper correctness oracle:** the switch-log
replay proves the core deterministic from NVRAM + RTC + timed switches: record on PC A, migrate, continue the replay
on PC B, diff RAM.
