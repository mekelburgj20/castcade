# ADR 0001 — Script hook, not a plugin, on VPX 10.8.0

**Status:** Accepted (2026-10-17)
**Owner rulings:** 2026-10-17 (Castcade v1 path = script hook on 10.8.0, plugin deferred); builds on the ArcAid desktop-Witness ruling of 2026-08-30 (target 10.8.0 only, no plugin tier).
**Related:** ADR 0004 (how the hook reaches each table); ArcAid `docs/vpx-desktop-witness-plan.md` §2–3.

## Context

The handoff design (`docs/design/remote-two-player-design-handoff.md`) made its Phase 0 a C++ plugin
built "against the VPX 10.8 plugin SDK", reading PinMAME RAM each frame and intercepting flipper
input before the table script sees it. Three facts, established by ArcAid's desktop-Witness research
and re-verified on the owner's rig on 2026-10-17, change that:

1. **VPX 10.8.0, the build every player runs, has no plugin system.** Plugins exist only in the
   10.8.1 prerelease (`VPinballX_BGFX` builds). The plugin API is self-declared unstable and has
   already broken superhac's score-server plugin. Sources:
   `ArcAid/tmp/vpx-desktop-witness/FINDINGS-D1-research-synthesis.md` §2 and
   `FINDINGS-D2-1080-only-design.md` (both gitignored in ArcAid). The owner ruled on 2026-08-30 that
   ArcAid targets 10.8.0 only.
2. **An external process cannot read a live game.** `VPinMAME.Controller` and `B2S.Server` are
   InprocServer32 COM objects; anything live must run inside the VPX process. The only in-process
   routes on 10.8.0 are script code and an in-proc COM shim. The Witness plan dropped the COM shim
   (UAC, x86-vs-x64 build matching, AV heuristics) in favour of pure VBScript.
3. **The live plumbing already ships in 10.8.0.** Shared `scripts/core.vbs` (VPinMAME driver
   script 3.61) polls `Controller.ChangedNVRAM` every frame in `PinMAMETimer_Timer` (lines 2490–2493
   on the owner's copy) and passes the deltas to a `NVRAMCallback` hook, gated by `UseNVRAM`.
   Line 37 reads
   `Dim UseNVRAM:If IsEmpty(Eval("UseVPMNVRAM"))=true Then UseNVRAM=false Else UseNVRAM = UseVPMNVRAM`.
   Because the flag is read with `Eval` at the moment `core.vbs` is `ExecuteGlobal`'d (via `LoadVPM`),
   **a table script that declares `Dim UseVPMNVRAM : UseVPMNVRAM = True` before `LoadVPM` and does
   `Set NVRAMCallback = GetRef("...")` after it turns the hook on with no change to `core.vbs`.**
   ArcAid's staged T7 probe (`ArcAid/tmp/vpx-desktop-witness/t7-sidecar/ArcaidTest_TFTC.vbs`,
   lines 30 and 170) does exactly this. Whether that probe's live reads line up with on-disk `.nv`
   offsets is still unverified (Phase 0a answers it).

The data the handoff doc wanted from "ROM RAM" is the same data: `tomlogic/pinmame-nvram-maps`
(ODbL, ~1,500 ROM entries) carries a `game_state` block with per-player scores, current ball,
player up and a game-over flag, proven to decode on the owner's rig for `tftc_400` and `ij_l7`.

## Decision

### 1. v1 runs on stock VPX 10.8.0 with injected VBScript, no plugin, no COM DLL

Everything Castcade needs inside the VPX process is pure VBScript injected per table (ADR 0004),
backed by one shared `castcade.vbs` library. The in-VPX code only appends events to a journal file;
all decoding and logic live in the companion.

### 2. Ball-end detection reads the NVRAM journal through the maps corpus

For ROM (VPM) tables the hook journals `ChangedNVRAM` deltas; the companion keeps a shadow NVRAM,
decodes `game_state` with the maps corpus and derives ball-in-play / player-up / game-over
transitions. The handoff doc's `rommaps/` folder is not created; the corpus is a dependency, with
recorded journals under `fixtures/` for CI replay. Known limit: SAM/SPIKE ROMs (modern Sterns:
acd, bdk, mtl, trn, twd) have maps but no `game_state`, so they have no ball-end signal in v1.

### 3. The turn lock is in-process, at the script layer

The per-table patch wraps the table's `_KeyDown` / `_KeyUp` handlers so flipper, plunger and nudge
keys are swallowed while a companion-written lock file says "not your turn". Fallbacks, in order,
if Phase 0 shows gaps (DirectInput gamepads and analog plungers are read by VPX outside the
script): an OS-level low-level keyboard hook in the companion, VPX's pause (ESC menu), overlay-only.
`VPinMAME.Controller.Pause` is noted as an experiment, not a plan item: a ball draining while the
ROM is paused desyncs ROM and physics.

### 4. Signed grants stay; plugin verification is deferred

The host still signs `TURN_GRANT` and the companion verifies it. The handoff doc's "the plugin
verifies the signature so a hacked companion cannot unlock its own flippers" tier is deferred to
a future 10.8.1+ plugin producer. Honest consequence: v1 integrity rests on the companion plus the
opponent's live video, which is the trust level the doc itself accepted for peer hosting.

### 5. The journal format is the product boundary

The in-VPX producer is swappable: script hook today, a 10.8.1+ plugin later emitting identical
journal events, companion unchanged. The event vocabulary follows the cabinet scoreserver's
(`table_loaded`, `game_start`, `current_scores`, `ball_end`, `game_end`) so desktop and cabinet
converge.

## Consequences

### Easier
- No beta dependency, no C++ toolchain, no plugin API churn; Phase 0 shares its decisive test with
  ArcAid's Witness Round A (T7), which is already staged.
- One mechanism (per-table script) serves scoring, ball end, turn lock and match events.
- Works for script-only originals too, which a PinMAME-reading plugin never could.

### Harder
- Trust is weaker than a signature-checking plugin; disputes resolve by the match log and video.
- Input devices VPX reads outside the script need a fallback lock; Phase 0c measures this.
- `ChangedNVRAM` is a destructive delta read: exactly one consumer per process, a shadow copy is
  mandatory, and any other registered `NVRAMCallback` must be chained (ADR 0003, ADR 0004).

### Locked out
- `plugin-vpx/` is not created in this repo until a stable plugin API ships in a release build.
- No in-proc COM DLL and no `ReadProcessMemory` approach in v1.

## Alternatives rejected

- **Build the plugin and require 10.8.1 beta.** Limits the audience to beta users, contradicts the
  owner's 2026-08-30 ruling, and inherits an API that already broke the one public precedent.
- **In-proc COM shim DLL (B2S.Server / DmdDevice proxy).** 10.8.0-compatible but needs per-user COM
  registration, bitness matching and looks like malware to AV; rejected by the Witness plan for the
  same reasons.
- **External `ReadProcessMemory` against VPinballX64.exe.** Zero footprint inside VPX but AV-hostile
  and fragile; kept as an unused reserve only.
- **Spike plugin and hook side by side in Phase 0.** A week of extra work to re-learn a fact the
  ArcAid research already settled.
