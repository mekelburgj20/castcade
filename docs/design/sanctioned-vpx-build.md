# The sanctioned VPX build — design

> **Status:** draft for the owner, 2026-10-31 (WORK item I1). Nothing here is built. The ruling it designs is ADR 0008
> (2026-10-30); its "Decision" and "Honest ceiling" sections are binding here and are not restated. The evidence
> vocabulary is the one `docs/design/fairness-and-table-identity.md` (the fairness doc) defines and the companion
> ships today. Claims about VPX internals are marked **to be confirmed in the fork** unless the fairness doc already
> verified them against the v10.8.0-2051 source (`player.cpp`, `plumb.cpp`, `pintable.cpp`, `LiveUI.cpp`,
> `dialogs/KeysConfigDialog.cpp`).

**Decisions taken in this doc** (each revertible by the owner; the open questions in §8 are the ones not taken):

1. The fork is based on the upstream **v10.8.0-2051** release tag, DX and GL (VR) x64 only, never 10.8.1 (§9).
2. The sanctioned build is **always in Sanctioned mode**: no switch to turn the locks off. Practice and Open play use
   the player's stock VPX beside it (§2.1).
3. Tournament-tunable bounds (tilt sensitivity, accelerometer gain, nudge filter) come in a **Sanctioned profile** the
   companion fetches from ArcAid; the build clamps to it and signs its hash (§2.3, §4.5).
4. What the build cannot stop (a VPinMAME cheat flag already set, non-factory adjustments, a missing profile) it does
   not hide either: the game plays, the signed report says `ok: false` with reasons, and an on-screen line says so
   before ball one (§2.2).
5. The build **keeps the script hook** (`castcade.vbs` + table import) for game events and the turn lock, and becomes
   the **only writer of the journal**: hook lines are routed through a native append call and hash-chained with the
   build's own lines (§3.2, §5.4).
6. Score decoding stays on the companion (maps corpus, detector). The build signs the journal chain, not a score; the
   score is bound to the signature by the chain (§3.3).
7. First-release attestation: **per-release Ed25519 key injected at CI, signature over a report that includes an
   ArcAid-issued nonce, key rotated every release, self-check of the Authenticode signature** (§4.4). Not TPM/VBS.
8. The companion installs, updates and launches the build from the fork's own GitHub releases; the Castcade installer
   never bundles it (CLAUDE.md: nothing from VPX is bundled). Executables keep the `VPinballX` prefix so frontends and
   the companion's process watch work unchanged (§5).
9. Until I4 ships, a fork binary is a build **family** `sanctioned` proven by a served hash list, exactly as strong as
   `official` today (companion-checked, so a modified companion can lie). Docs and the ArcAid UI must say "trusted-build
   check (hash)", not "verified build" (§4.6).

## 1. Goal and non-goals

**Goal.** One desktop build a runner can require for a Sanctioned tournament, such that a score accepted under the
rule came from a game played with the unfair settings locked, the evidence measured inside the process, and a report
ArcAid can check came from our released binary in that session. With Legends Unchained on cabinets (I5) it is one of
the two builds the rule trusts (ADR 0008 §1).

**Non-goals.**

- Replacing the companion. Networking, posting, matches, streaming, voice, recording, Open-play evidence and the maps
  corpus stay where they are (§6; ADR 0003, ADR 0008 §3).
- A general VPX distribution. No new features, no editor changes, no visual work: the diff against upstream is the
  locks, the native journal writer and the attestation, and stays small enough to rebase each release (§9).
- Preventing physical cheating (lifts within bounds, macros, someone else playing). The live video and the
  recording remain the answer there (fairness §5, §5a).
- Making every Sanctioned tournament require it. The rule is per tournament (ADR 0008 §1); Sanctioned without the rule
  keeps today's evidence path on stock VPX and community builds (owner ruling 2026-10-19 stands).

## 2. What the build locks in Sanctioned mode

### 2.1 Always on

A separate mode switch would be one more thing to patch out and one more state to report. The build has no unlocked
state; the player's stock VPX is beside it for everything else (decision 2). Settings dialogs still open and still save
the ini (key bindings, display, VR, sound must stay configurable); the locked keys are simply ignored or clamped at
play time, and the values in force are what the report carries.

### 2.2 Three verbs

- **Locked**: the build forces the value; the player's setting is ignored and reported beside the forced value.
- **Clamped**: the player's value is used within the profile's bound (§2.3); outside it the bound is used.
- **Reported**: the build cannot or should not force it; it measures it from inside and the signed report carries it.
  ArcAid's existing Sanctioned rules decide (item 11, §14 of `docs/arcaid-side-changes.md`).

Something the build should lock but cannot (a state set before VPX started, or owned by VPinMAME) marks the session
`ok: false` with a reason in the signed report and shows one line on screen before ball one (decision 4). It never
silently stops a table: a failure here must not end a player's game (the hook's own rule, `vpx-hook/castcade.vbs`).

### 2.3 The table

Field names on the right are the wire names the companion already sends (`companion/src/witness/attestation-types.ts`,
`iniWire`, `engineWire`, `buildWire`).

| Setting | Verb | Value in Sanctioned mode | Why | Today's evidence |
|---|---|---|---|---|
| Table physics-set override (`ORRP`, file property) | locked | 0 (the table's own physics); the file's value reported | The ball must see the author's physics; a set is a whole-table physics swap | `ini.set`, `ini.stock`, `engine.physics_set` |
| Flipper physics override (`ORPF`) | locked | off | Same, flippers | `ini.flippers` |
| Global physics sets (`[Player] TablePhysics*N`, `FlipperPhysics*N`) | locked (unused) | ignored, since the override is 0 | Only reachable through the override | `ini.set_name` |
| Difficulty override (`[TableOverride] Difficulty`, tweak menu) | locked | the table's own `TDFT` | Difficulty sets the slope between the table's min and max (fairness §3) | `ini.difficulty_override`, `engine.difficulty` |
| Slope | locked (follows) | `SlopeMin + TDFT × (SlopeMax − SlopeMin)` from the file | Derived from the two above | `ini.slope`, `engine.slope_min/max` |
| Tweak-menu pages that write physics, difficulty or nudge (`LiveUI.cpp`) | locked | read-only while a game runs; visual pages stay live | The in-memory hole of fairness §5a | `engine.changes` |
| Script calls that rewrite nudge calibration (`NudgeSetCalibration`) | locked | no-op, a `warn` line journaled | A table script could raise gains or lower tilt sensitivity at run time (fairness §5a) | the call shows in `script_diff` |
| Script writes to table-level physics (gravity, friction, elasticity, falloff, scatter, slope, `NudgeTime`) | reported | every change journaled at the setter, with time | Many tables set physics in init legitimately; a change after `game_start` is ArcAid's `engine_changed` | `engine` (today: at key presses only) |
| Flipper and element physics set from script (nFozzy-style) | reported (hash of the script that ran) | — | Normal for modern tables during play; judged by script inspection (F5), not by the engine | `script_sha256`, `script_diff` |
| `TiltSensitivity` (0–1000, higher tilts sooner) | clamped | `≥ min_tilt_sensitivity` (profile; default 300); 0 refused while the accelerometer is on | Lower = lift further before the plumb bob trips | `ini.tilt_sens`, `engine.nudge.tilt` |
| `PBWAccelGainX/Y` | clamped | `≤ max_accel_gain` (profile; default 150) | Gain scales the push a held tilt gives (fairness §5a); hardware differs, so a bound, not a value | `ini.accel_gain_x/y`, `engine.nudge.xgain/ygain` |
| `PBWAccelMaxX/Y`, `AccelVelocityInput`, `PBWEnabled` | reported | — | Device calibration; no fair value to force | `ini.accel_*` |
| `EnableNudgeFilter` | clamped | on when the profile's `require_nudge_filter` is set | Runner's choice (fairness §5a default off) | `ini.nudge_filter` |
| Keyboard nudge strength (`NudgeStrength`), legacy nudge | clamped | `≤` VPX default 0.02; legacy reported | A stronger digital nudge is more ball control; weaker is harmless (the owner's rig runs 0.0008) | `ini.nudge`, `ini.legacy_nudge` |
| Panasony keys (`AnalogNudgeGainX/Y`, `DigitalNudge`, `TiltInertia`, `[PlayerVR] nudgestrength`) | n/a | absent: upstream 10.8.0 does not read them | The fork is upstream-based (decision 1); if Panasony's features are merged later (§8 Q2), they fall under the same clamps | `ini.analog_gain_x/y` |
| Table options (`[TableOption]`, the author's names, e.g. "Outlane Difficulty") | reported; locked during a game | values at `game_start` + any change | Some are fairness-relevant, but only the author knows which; the runner reads them by name | `ini.options` |
| Script debugger console, ball control / throw balls, live object editing, frame step or slow motion | locked | disabled | Each lets the player act on the game directly. The exact features in 10.8.0: **to be confirmed in the fork** | none today |
| Play from the editor after editing (in-process edits) | locked | only `-Play <file>` is a Sanctioned session; an edited-then-played table is `ok: false` | The ball must see the file whose hash is reported | `table_sha256` (file only) |
| Pause (ESC menu) | reported | count and total time per game | Real machines cannot pause; harmless solo, relevant in a match | none today |
| VPinMAME per-ROM `cheat` (`HKCU\Software\Freeware\Visual PinMame\<rom>\cheat`, else `default`) | reported, gates `ok` | read inside the process at `game_start`; `true` ⇒ `ok: false` | VPinMAME owns it and reads it at ROM start (exact timing **to be confirmed in the fork**); the build can refuse to sign the session clean, not change the ROM's behaviour mid-run | `build.cheat` |
| VPinMAME DLL that is actually loaded | reported | path + SHA-256 of the loaded module | The companion hashes the COM-registered DLL, which need not be the one loaded | `build.vpinmame` |
| Machine adjustments (NVRAM, operator menu) | reported | unchanged; companion reads the `.nv` through the maps corpus | They live in VPinMAME's NVRAM, decoded only by the corpus; ArcAid's `require_factory_adjustments` with its whitelist (default `['Free Play']`) already rules them. A factory reset before play is §8 Q5 | `adjustments` |
| ROM | reported | the ROM the hook names | Pinned by ArcAid's `required_rom` | `rom` |
| Modules loaded in the process (DLLs) | reported | name, path, SHA-256, Authenticode signer, at `game_start` and `game_end` | Trainers and injectors run as DLLs; Castcade's own OpenXR layer (`vr-layer/`) is one and must be allow-listed | none today |
| VR on/off, display mode | reported | from inside the renderer | Replaces the companion's process probe for `play_device` | `play_device`, `vr` |

### 2.4 The Sanctioned profile

The clamps need the tournament's numbers. The companion fetches a profile from ArcAid for the device's Sanctioned
target (proposed F19, §7) and writes it to `%LOCALAPPDATA%\Castcade\sanctioned\profile.json`:
`{ tournament_id, rules: { min_tilt_sensitivity, max_accel_gain, require_nudge_filter }, issued_at }`. The build reads
it at table load, applies it, and puts `profile_sha256` in the signed report. ArcAid compares that hash with the one it
issued, so a player who loosens the file only produces a report that fails. No profile, or an unreadable one: VPX
defaults are used (tilt 400, gain 150) and the report says `profile: none`, which fails the trusted-build rule but
leaves the game playable (decision 4). The profile carries no secret and no nonce (the nonce arrives later, §4.5).

## 3. Evidence produced in-process

### 3.1 Same journal, same file, same vocabulary

ADR 0001 §5 made the journal format the product boundary and the producer swappable; ADR 0008 §3 says the build writes
that format natively. So the build writes to `%LOCALAPPDATA%\Castcade\journal\<table-id>.jsonl`, one JSON object per
line, every line with `event` and `t`, and the companion's `JournalDetector` (`companion/src/witness/journal-detector.ts`)
reads it unchanged. New lines are additive: an older companion ignores them (the detector's `switch` returns no event
for an unknown `event`, and a line before `table_loaded` opens no session; read in `journal-detector.ts` 2026-10-31, to
be re-proved by the fork fixture).

The working agreement asks for a version bump and a fixture for any journal change. This is **journal format 0.5**: the
hook library goes to 0.5.0 (it gains the native route, §3.2) and a fork-recorded fixture joins `fixtures/`.

### 3.2 Who writes what

| Line | Written by | Content |
|---|---|---|
| `vpx_session` (new, first line) | build | `build_id`, `version`, `key_id`, `table_sha256` of the file opened, `script_sha256` of the script compiled and `script_source` (`embedded` / `sidecar`), `profile_sha256`, the locked and clamped values in force (the §2.3 rows, as the `ini` and `engine` objects name them), `vr` |
| `table_loaded`, `nvram_hook`, `nvram_full`, `nvram_delta`, `game_start`, `current_scores`, `ball_end`, `game_end`, `lock`, `key_blocked`, `warn`, `embedded_patch`, `table_exit` | hook, through the build's native append | exactly as today (`vpx-hook/castcade.vbs` header) |
| `engine` | build (replaces the hook's sampler) | the same fields as hook 0.4.0 (`EngineSample`), written at the setter on every change instead of at key presses |
| `include` (new) | build | name + SHA-256 of each file a script loads through VPX's `GetTextFile` (`core.vbs`, `controller.vbs`, `castcade.vbs`): what B5.4 wanted, measured where it happens. Whether every include path goes through it: **to be confirmed in the fork** |
| `sanctioned` (new) | build | a refusal or clamp that fired (`NudgeSetCalibration` ignored, tweak-menu write refused, cheat flag on, editor play), pause totals at `game_end`, the module list at `game_start` and `game_end` |
| `attest` (new, at `game_end` and `table_exit`) | build | the signed report (§4.5) |

**Single writer, hash-chained.** The build opens the journal itself with write sharing denied (read sharing allowed, so
the companion tails it as today) and exposes one script-callable append (name and binding through VPX's scriptable
object model **to be confirmed in the fork**). `castcade.vbs` 0.5.0 checks for that call once at `Castcade_Init` and
routes `Castcade_Write` through it; on stock VPX it keeps its `FileSystemObject` path, so the hook stays one file for
both producers. Every line the build writes, its own or a routed one, carries `h`: SHA-256 over the previous line's `h`
and this line's bytes. A companion that edits, drops or inserts a line after the fact breaks the chain the `attest`
line signs. Native lines written before the hook names the table are buffered until `Castcade_Init`; a table that is
not imported journals to `_vpx-<session>.jsonl` (native lines only).

### 3.3 Authoritative vs best-effort

"Authoritative" means measured inside the process at the moment it mattered, and (from I4) covered by the signature.
It does not mean tamper-proof (§4.7).

| Field on the score | Today | With the build |
|---|---|---|
| `table_sha256` | companion hashes the file at launch | **authoritative**: the bytes the process opened (closes the swap-after-hash gap) |
| `fingerprint` (`pf1:`) | companion, from the file | companion, from the file whose hash the build reported: **bound** by `table_sha256` |
| `vps_game`, `vps_table`, `table_save_rev` | companion resolver (F1) | unchanged (identity, not fairness) |
| `script_sha256` | companion, from the file or sidecar | **authoritative**: the script compiled |
| `script_diff` | companion (F5) | companion, over a script whose hash the build reported: **bound** |
| `ini` | companion, at launch and capture (a "settings at launch" statement) | still sent; superseded by `vpx_session` (values in force, after locks and clamps) |
| `engine` | hook, at key presses (finer than a ball, not exact) | **authoritative and complete**: every change at the setter |
| `build` | companion hashes the exe and the registered DLL; family from the version resource | **authoritative** self-identification (`build_id`, `key_id`) from I4; loaded VPinMAME module hash |
| `build.cheat` | companion reads the registry | **authoritative** read at `game_start` inside the process |
| `adjustments` | companion, `.nv` + maps | unchanged, **best-effort** (map coverage: 92 of 383 maps, fairness §7) |
| `play_device` / `vr` | companion process probe | **authoritative** from the renderer |
| score, balls, game end | hook lines decoded by the companion | same decoding; lines **chain-covered** (§3.2), so the score is bound to the signature by replay |
| `score_plausibility`, `quit` / `quit_ball` | companion | unchanged |
| `nudge` telemetry (F6, unbuilt) | companion HID read | unchanged; the companion stays the place for it |
| modules, pause, includes | — | **new, report-only** |

**Binding the score.** The build does not decode NVRAM: the maps corpus and the detector are the companion's, and a
C++ copy would be the duplicated code ADR 0003 rules out (decision 6). So the signature covers the chain head, and the
score is bound when a replay of the chain-covered journal yields the posted score. For a Sanctioned tournament with
the rule on, the companion uploads the journal (gzip; tens of KB for a WPC game since hook 0.3.0's watch list) beside
the score, and ArcAid keeps it for a ruling; ArcAid's own T7 decoder already reads `nvram_full` / `nvram_delta`
(`castcade.vbs` header), so an automatic replay check is possible later (proposed F20). Basic mode (a table that is
not imported) posts from the `.nv` after exit and has no chain to bind it: such a score is reported as "not bound"
(§8 Q4).

## 4. Identity and attestation (I4)

### 4.1 The problem

The fork is GPLv3 and public. Anyone can build it with the locks removed and the version strings intact. Trust must
therefore come from something only our release binary has, bound to each report so it cannot be copied into a rebuilt
binary (ADR 0008 §4 (a)–(c)). Everything below runs on a machine the player owns; the question is cost, not
possibility.

### 4.2 Candidates

| Mechanism | What it proves | What defeats it | Cost to us |
|---|---|---|---|
| **A. Authenticode on the binary, checked by the companion** (hash in a served list) | The exe file on disk is our release | A modified companion that reports the right hash; a patched copy launched instead of the checked one | Code-signing certificate (E2); trivial code |
| **B. Release key in the binary, per-report signature** (Ed25519; private key injected by CI from a secret, never in source) | The report was produced by something holding that release's key | Extracting the key from the binary (it ships to every player) and signing forged reports; runtime patching of the genuine process | CI secret per release, a served key list, key rotation |
| **C. Server-issued nonce signed in-process** | The signature was made after ArcAid issued the nonce, for this device and session: no precomputed or replayed reports | Nothing by itself: it only adds freshness to B | One ArcAid endpoint field, one check |
| **D. OS / TPM-backed attestation** (TPM 2.0 non-exportable key via the Platform Crypto Provider; Windows VBS enclaves; Microsoft Azure Attestation) | A TPM key cannot be copied off the machine; an enclave can prove the enclave's code identity | Any process of the user can ask the TPM to sign; an enclave signs whatever the (patchable) host process hands it. It protects the key, not the data | High: enclave signing requirements, VBS often disabled on gaming rigs, per-device enrolment; **unverified** for consumer Windows 11 |
| **E. Legends Unchained precedent** (closed build, hash list from Mox) | The cabinet runs Mox's binary | The cabinet is a locked appliance; the trust comes from the platform, not from the binary. On a desktop the same idea is A | None for the desktop; it is I5's model for cabinets |

### 4.3 Why not D first

D raises key extraction from "reverse the binary" to "attack the TPM", but the cheaper attack (patch the genuine
process in memory so it feeds the key a lie) is untouched by D, so D buys little over B for most of its cost. It is
kept as a later step if a key extraction is ever seen in the wild.

### 4.4 Recommendation for the first release: B + C, with A as the floor

1. **Per-release key.** The fork's release workflow generates an Ed25519 key pair per release (or takes one from a
   secret store), embeds the private key in the binary at build time (lightly obfuscated: split and masked, a speed
   bump, not a defence), publishes the public key and `key_id` with the release, and never commits either. Source
   builds without the secret have no key and report `key_id: null`.
2. **Trust list on ArcAid.** ArcAid serves the trusted identities: per release `build_id`, exe SHA-256s, `key_id`,
   public key, `trusted_from`, `trusted_until` (proposed F18). A leaked key is retired by ending its window; a release
   is retired the same way when a successor ships (with overlap, §5.4).
3. **Nonce.** ArcAid returns a nonce on the start call the companion already makes (`GET /api/witness/attempt`); the
   companion writes it to `%LOCALAPPDATA%\Castcade\sanctioned\nonce` for the session; the build reads it when it
   signs. ArcAid accepts a nonce once, for that device, within the session window.
4. **Self-check.** At start the build verifies its own Authenticode signature (WinVerifyTrust on its image) and its
   exe hash against the list compiled into it; on failure it signs nothing and reports `ok: false`. This catches the
   casual case (a patched exe file) without the companion's help.
5. **Companion check (A).** The companion still hashes the running exe and checks the signer, as it does for
   `official` today, and sends it in `build`.

### 4.5 The report

The `attest` line, and the `trusted` param the companion carries on the score (compact JSON, additive, absent on stock):

```json
{"v":1,"build_id":"csv-10.8.0-2051-s1","key_id":"k2026-11","session":"…","nonce":"…",
 "profile_sha256":"…","table_sha256":"…","script_sha256":"…","chain_head":"…","lines":1834,
 "game":2,"ok":false,"reasons":["vpm_cheat_on"],"sig":"<ed25519 over the canonical JSON without sig>"}
```

`ok` and `reasons` are the build's own verdict on §2.3 (cheat flag, editor play, no profile, self-check failed).
ArcAid's verdict stays ArcAid's: it verifies `sig` with the listed key, checks the nonce, the profile hash and the
window, and then applies its existing Sanctioned rules to the evidence as today. Badge, never gate, everywhere outside
a tournament that turned the rule on.

### 4.6 Until I4 exists

The rule is a stronger build-family check (ADR 0008 §4): the companion recognises a fork binary by hash from a served
list and reports `family: 'sanctioned'` (a fifth `BuildFamily` beside `official`, `panasony`, `nightly`, `unknown`,
`companion/src/witness/build-attestation.ts`). That is exactly as strong as `official` is today: proven by hash, but
the hash is checked by the companion, so a modified companion can claim it. ArcAid's rule and Integrity panel must label
it "trusted build (hash check)" and never "verified" (decision 9). The locks of I3 are real from the first fork
release; only the proof that they ran waits for I4.

### 4.7 What the recommended path proves, plainly

**Proves:** a report signed with a key ArcAid currently trusts, over a fresh nonce, was produced during that session by
a process holding the key of one of our releases; the journal lines it chains were not altered afterwards; the table
and script hashes and the settings in force are what that process saw.

**Does not prove:** that the process was unmodified (in-memory patching, an injected DLL, a stealth injector hidden
from the module list), that the key was not extracted from a release binary, that the player's physical play was
honest, or that the score in a basic-mode game is the one played. It is a deterrent priced at "reverse-engineer this
release's binary before its key window ends", plus a module list and the live video for a ruling. ADR 0008 §4's
honest ceiling, made concrete.

## 5. Install and update path for players

ADR 0007: guide it, never drop it. The player keeps their stock VPX; the sanctioned build is a second install.

### 5.1 Where it lives

`%LOCALAPPDATA%\Castcade\vpx-sanctioned\<version>\`, per user, no admin rights, one folder per installed version.
Executables keep the upstream names with a suffix, e.g. `VPinballX_Sanctioned64.exe` and `VPinballX_Sanctioned_GL64.exe`
(decision 8), so frontends accept them and the companion's process watch (`VPinballX*.exe`) sees them. The `scripts\`
folder is seeded from the player's stock VPX install at setup (core.vbs and friends are not ours to ship; the build's
`include` lines report their hashes), and the companion puts `castcade.vbs` 0.5.0 there as it does for stock. Its ini
is its own (beside the exe, the active-ini rule of the owner's rig), seeded once from the player's stock ini so key
bindings, display and VR settings carry over; locked keys are ignored at play time anyway. Tables, per-table `.ini`
files, NVRAM and VPinMAME are the player's existing ones, shared with stock (the per-table ini's fairness keys are
ignored by the build, so sharing is harmless). Whether VPX resolves `scripts\` relative to the exe in every path:
**to be confirmed in the fork**.

### 5.2 Getting it

A Settings entry "Sanctioned VPX build" (and a Status preflight link, §5.3): one click downloads the release zip from
the fork's public GitHub releases (anonymous read, as the companion's own updater does since 0.2.6), checks its
SHA-256 against the trusted list from ArcAid and its Authenticode signer, unpacks it, seeds `scripts\` and the ini,
and adds a "launch with the sanctioned build" choice. For frontend users (PinUP Popper, PinballX, …) it shows the exact
emulator entry to add; it does not edit frontend databases.

### 5.3 Picking it per tournament

The companion already knows the device's routing target. When that target is a tournament whose rules require the
trusted build (proposed F19 returns it with the profile), the companion: fetches the profile; makes the sanctioned
build the default in its own launcher for tables of that tournament; and when it sees a stock VPX start a table of
that tournament, shows the preflight verdict before ball one ("this game will not count for X: launch it with the
sanctioned build", fairness §0 point 2). It never blocks stock VPX.

### 5.4 Updates

The companion checks the fork's releases feed with its own update check and downloads a new release in the background;
the old version stays until no open tournament the device targets accepts only it. ArcAid's trust windows overlap by
default (proposed: the previous release stays trusted for 14 days after a successor ships) so a player mid-tournament is
not cut off by a release. When a tournament requires a newer build (a retired key, a fix), the preflight says
"update needed" with one button. The build itself never self-updates: one updater, the companion's.

### 5.5 Does the sanctioned build need the script hook?

**Yes, in the first release (decision 5).** Live game events on ROM tables come from VPinMAME's `Controller.ChangedNVRAM`,
a COM object the table script creates and `core.vbs` polls (ADR 0001); the build sees it only through the script.
Original tables' events come from the per-table recipe (ADR 0004). Moving either into C++ means hooking COM or
reimplementing `core.vbs`'s role, a large divergence from upstream that the maintenance budget (§9) cannot carry, and it
duplicates the detector path. So the build does natively what the script cannot see or could fake (settings in force,
engine values, hashes, input and debug locks, the chain, the signature) and leaves the game events to the hook it
already has, made tamper-evident by the single-writer chain. Consequence: Sanctioned-with-the-rule tables must be
imported (C8 "Patch my tables"), which ADR 0004 already makes the primary path. A native turn lock in the input layer
(closing ADR 0001 §3's DirectInput / analog-plunger gap for matches) is a natural later item (proposed I8).

## 6. What stays on the companion

| Stays on the companion | Why |
|---|---|
| ArcAid pairing, check-in, start and score calls, routing, the trusted-list and profile fetch, the journal upload | One network client (ADR 0003); the build makes no network calls at all |
| Detector, NVRAM decoding, the maps corpus, score extraction | The product boundary is the journal (ADR 0001 §5); no C++ copy |
| Matches, turn grants, streaming, recording, voice, the VR panel (`vr-overlay/`, `vr-layer/`) | Unchanged; the OpenXR layer loads into the build like any VPX and is on the module allow-list |
| Open-play evidence on stock VPX and community builds (F1–F6 as shipped) | ADR 0008 §3: everything except the rule |
| Identity resolution (VPS ids), fingerprint, script diff, adjustments, plausibility, quit, HID nudge telemetry | Measured from files and devices; the build binds the first two by hash |
| Installing, updating and launching the build; preflight | §5 |

**Boundary.** The wire contract (journal lines, the `attest` report, the profile file, the nonce file) and the event
vocabulary. No shared code: the fork is C++ in its own repository, the companion TypeScript here (ADR 0003 §3).

## 7. Build order and gates (I2–I5)

Each step ships on its own and leaves every earlier path working.

| Step | Where | What ships | Done when | ArcAid side |
|---|---|---|---|---|
| **I2** fork repository | new public repo (owner's GitHub) | VPX v10.8.0-2051 source, GPLv3; CI builds DX + GL x64; release assets = zips + source archive + `SOURCE-OFFER` text (the E5 pattern); upstream-tracking policy (§9); Authenticode signing of the release (E2 unparked for this artifact) | an unmodified CI build plays Monster Bash and Medieval Madness on the owner's rig, desktop and VR (OpenComposite → Virtual Desktop), with the companion posting a live-mode score as from stock | none |
| **I6** interim trusted family (proposed) | companion + ArcAid | `family: 'sanctioned'` from a served hash list; Settings install/update (§5.2–5.4); preflight on stock | a fork score lands in a test Sanctioned tournament with the rule on, labelled "trusted build (hash check)"; a stock score is refused with the reason | F18 (list, hashes only), F17's rule in its interim form |
| **I3** in-process Sanctioned mode | fork + `vpx-hook` 0.5.0 + companion | the §2.3 locks and clamps, the profile, the native journal writer and chain, `vpx_session` / `engine` / `include` / `sanctioned` lines, a fork-recorded fixture | on the owner's rig each locked setting, changed in the ini, the tweak menu and from script, is refused or clamped and journaled; the companion's detector replays the fork fixture to the same balls and game end as the stock fixture; a chain edit is detected by a companion check | F19 (profile) |
| **I4** attestation on the wire | fork CI + companion + ArcAid | per-release key, nonce, self-check, `attest` line, `trusted` param, journal upload | arcaid.app verifies a fork report in a test tournament; an edited journal line, a reused nonce, a retired key and a source build without a key each fail with their reason | F17 (rule, verification, badge), F18 (keys and windows), F20 (journal upload; replay check later) |
| **I5** Legends Unchained trust | ArcAid + arcaid-witness repo | Mox's build identity (hash list or signature) and the cabinet Witness's report of it | a cabinet score from a listed LU build passes the same rule; an unlisted one is refused | F21 (LU identity in the trust list) |

Test room for every gate: Flippin Fear Fest (`arcaid_flippin_fear_fest_26`) with a Sanctioned test tournament.

**Proposed ArcAid items** (for `docs/arcaid-side-changes.md` item 19 and the ArcAid WORK section W; not edited here):

- **F17** (exists) the "trusted build" rule, verification of `trusted`, the Integrity panel badge.
- **F18** trusted build list: `GET /api/witness/trusted-builds` (build ids, exe SHA-256s, `key_id`, public key,
  `trusted_from` / `trusted_until`), admin-editable, seeded from fork releases.
- **F19** Sanctioned profile: the device's target tournament's rule set as JSON, its hash stored per issue; whether the
  tournament requires the trusted build.
- **F20** nonce on the start answer, one-use check on the score; journal upload stored with the evidence for a ruling;
  later, a replay check through ArcAid's T7 decoder.
- **F21** Legends Unchained identities in the same list, read from the cabinet Witness report (with I5).

## 8. Open questions for the owner

1. **Base version.** Upstream v10.8.0-2051, or a later 10.8.0.x maintenance build if upstream publishes one?
   *Recommend 2051*: every hash, script and fixture we have is against it; move only when upstream ships a 10.8.0 fix
   players adopt.
2. **VR and Panasony.** The owner's rig and most VR testers run Panasony builds. The fork is upstream-based, so VR
   players on it get upstream's VR (OpenVR, which the owner's OpenComposite path already serves for Panasony;
   **unverified** for the fork). *Recommend*: ship upstream VR in I2, and ask Panasony whether their source is public
   and whether they would accept their in-game page under our clamps; until then the Panasony build stays allowed in
   Sanctioned tournaments that do not require the trusted build.
3. **Always on.** *Recommend yes* (decision 2): no unlocked mode in the sanctioned build.
4. **Live mode required under the rule?** *Recommend yes*: a basic-mode score cannot be bound to the signature (§3.3);
   the rule accepts only chain-covered scores, and the preflight tells the player to import the table.
5. **Machine adjustments.** Report and rule as today (`require_factory_adjustments` + whitelist), or have the companion
   back up the `.nv` and cold-boot the ROM to factory before a Sanctioned game? *Recommend report-and-rule for I3*; a
   factory reset is a later item once map coverage (92 of 383) is clearer, because a reset loses the player's high
   scores and some ROMs need operator steps after one.
6. **Keys and the GPL.** A per-release signing key embedded at build time is data, not source; GPLv3 §6 lets a network
   service refuse modified versions. Our reading, **not legal advice and unverified**: a rebuilt fork is fully
   functional VPX, it is just not recognised by ArcAid's rule. *Recommend* the owner confirm comfort with this before
   I4, and the fork's README say it plainly.
7. **Code signing.** ADR 0008 makes E2 a prerequisite here. *Recommend* signing the fork from I2 with whatever
   certificate the companion will use at GA (a cloud signing service is one option; cost and eligibility unverified),
   since the self-check (§4.4 step 4) and A both need it.
8. **Executable names and branding.** *Recommend* `VPinballX_Sanctioned64.exe` / `VPinballX_Sanctioned_GL64.exe`, product
   name "Castcade Sanctioned VPX", with "based on Visual Pinball X" and no upstream logos, so nobody mistakes it for an
   upstream release.
9. **Pause.** *Recommend* allowed and reported (count, total time) for solo Sanctioned play; matches already have their
   own turn flow.
10. **Table options.** *Recommend* report only in I3 (by the author's names); a runner pin in the profile later if
    runners ask.
11. **Speed manipulation.** An in-process speed hack slows the game clock. The companion, a separate process, can
    compare journal `t` against its own clock and report the ratio. *Recommend* adding it as report-only evidence with
    I3 (works on stock VPX too).

## 9. Risks

- **Upstream tracking.** Upstream's effort is on 10.8.1 and later (plugins, BGFX); 10.8.0 may get no more releases,
  which makes the fork stable but frozen, and when players move to 10.8.1+ the fork must follow, rebasing the locks onto
  a different code base and possibly using the plugin system for the non-security parts. Policy for I2: track release
  tags only, never `master`; re-evaluate when 10.8.1 leaves beta (ADR 0001's target follows what players run). Keep the
  diff small and in few files to make the rebase cheap.
- **GPLv3 obligations.** Source with every release (the archive as a release asset, plus the written offer, as E5 does
  for ffmpeg), our changes under GPLv3, upstream notices kept. Every release, not just the first.
- **Code signing (E2)** moves from GA nicety to prerequisite; without it the self-check and check A are empty.
- **Maintenance cost.** A C++ toolchain (MSVC, VPX's dependencies) outside this repo's Node toolchain, a CI matrix,
  a signing and key-rotation routine per release, and a second install to support. Budget: one rebase per upstream
  release, one key per release.
- **Key extraction.** Expected eventually for a popular release. Mitigations: per-release keys, short trust windows,
  the module list, and the journal kept for a ruling; escalation path D if it happens.
- **Players' setup.** A second VPX, its own ini, a frontend entry: guided (§5), never dropped (ADR 0007), but each step
  needs a check that names the fix (WORK D6's pattern).
- **Honest ceiling, once.** The build turns "settings the player chose" into "settings the build forced" and makes the
  evidence complete and tamper-evident; it cannot make a player's own machine trustworthy. A determined player can
  patch the process or extract a key; the deterrent is the effort per release, and the backstop remains the live video,
  the recording and a human ruling (fairness §0, ADR 0008 §4).

## 10. Proposed WORK items

For section I (not edited here; ready to paste):

- **I6** `idea` Interim trusted build: companion recognises fork binaries by a served hash list as `family: 'sanctioned'`, Settings installs and updates the build side by side (`docs/design/sanctioned-vpx-build.md` §5), preflight warns when stock VPX plays a table of a tournament that requires it; labelled "trusted build (hash check)", not verified · needs: I2 · touches: F17, F18
- **I7** `idea` Journal format 0.5: `castcade.vbs` 0.5.0 routes writes through the build's native append when present, the build's `vpx_session` / `engine` / `include` / `sanctioned` / `attest` lines, the `h` chain, a fork-recorded fixture, a companion chain check · needs: I3 · spec: docs/design/sanctioned-vpx-build.md §3
- **I8** `idea` Native turn lock in the sanctioned build's input layer (closes ADR 0001 §3's DirectInput and analog-plunger gap for matches on that build) · needs: I3
- **I9** `idea` Clock-ratio evidence: the companion compares journal `t` with its own clock and reports the ratio (speed hacks), report-only, stock VPX too · spec: docs/design/sanctioned-vpx-build.md §8 Q11
