# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project

**Castcade** ("Cast" + "arCADE") — a companion desktop app for remote 2–4 player alternating-turn play
on the same VPX pinball table (and RetroArch arcade netplay), with live spectating and voice, whose
lobby, identity and results are managed by **ArcAid** (`C:\code\repos\ArcAid`, deployed at arcaid.app).
The companion is also the Windows desktop producer for **Arcaid Witness** (ADR 0003).

Remote: https://github.com/mekelburgj20/castcade · License: GPLv3 (owner ruling; nothing from VPX,
VPinMAME, RetroArch, FBNeo, ROMs or tables is ever bundled).

## Current state

Open work, claims and blockers live in **`WORK.md`** (one line per item, IDs like `B4.1`; grammar and
the claiming rule in `.claude/commands/work.md`; the board link is on its first line). Release history is
`CHANGELOG.md`. Start a session with `/work`, end it with `/wrap`. **Do not write a session narrative
here**: this section holds standing facts only (ADR 0006).

- Companion 0.2.50 is an unsigned PoC (alpha match build: Match tab, WebRTC voice + table sound in Electron, and from 0.2.37 **native spectator video** per ADR 0010: `castcade-video.exe` (libwebrtc + libavcodec NVENC → AMF → QSV → x264) carries the player up's picture, the OpenXR layer (0.6.0) hands it the eye through a shared-memory ring and draws the decoded picture from a second ring, a desktop watcher gets the helper's own window and a desktop sender is captured with Windows Graphics Capture; six-rung ladder with a controller; the Electron video path stays behind the `videoPath` setting for one release. **Protocol 6** since 0.2.46 (0.2.41 to 0.2.45 are protocol 5); from 0.2.40 a paired host needs no port forward (match control through an ArcAid relay, the invite is a six-letter code, UPnP as the fallback) and a `castcade://join/…` link joins and starts the table; 0.2.41 to 0.2.43 are companion-only on the v0.2.40 native zips (logs through ArcAid, the in-game menu on a global key in `match/match-menu.ts`, the table left unlocked for a finished game's initials); 0.2.44 adds the 3D watch session (below) and the corner scoreboard, with OpenXR layer 0.7.0 built by the release tag; 0.2.45 is one fix, the hook's journal held open (lib 0.5.2); 0.2.46: an update is offered and installs in sight, never at quit (E9, `main/updater.ts`, `build/installer.nsh`; the update to 0.2.46 itself is still 0.2.45's silent one at quit), the hook's journal goes through a named pipe (lib 0.6.0, C16.2, below), and the state stream runs inside a match, which is what makes it protocol 6 (I11.4.2, below); 0.2.47 (still protocol 6, plays with 0.2.46): the first start of a match waits for the 3D connections (I11.4.9, below), an `ICE round` log line per connection attempt (I11.12), no address from the native video helper in `companion.log` (`media/log-mask.ts`, E8.2), and every tag now builds **two installers**: `Castcade-Setup-<v>.exe`, the full app, and `Castcade-Witness-Setup-<v>.exe`, the Witness edition for cabinets (E10: pairing, patching, capture, posting and updates only; the edition is baked in at package time by `electron-builder.witness.yml` and read in `main/edition.ts`; same app id, install and settings folders, so one installs over the other and the pairing stays; its own update file `witness.yml`, and each edition refuses the other's installer); 0.2.48 (still protocol 6): OpenXR layer **0.8.0** (pipe protocol 5), where the match scoreboard stands at a fixed place in the room (`vr-layer/src/scoreboard_place.h`; the `scoreboardAnchor` setting, `room` by default, `head` for the 0.7.0 corner; "Put the scoreboard where I look" in the in-game menu), a joining PC hashes the unimported copies of the host's title and never lets one displace an imported table (`launch/table-hash.ts`, `launch/find-table.ts`), and the witness says whether a live table's ball ends are read at all (`WitnessStatus.ballEnds`: false on Stern SAM and Bally / Stern M100, where the lobby says so and the host passes each turn; `fixtures/README.md` says what recording would change that); 0.2.49 (still protocol 6, companion-only on 0.2.48's layer, helpers and hook library): every Witness score carries `utc_offset` (minutes east of UTC at the game's start) and, on the five titles whose map has the "Special Modes" audit, `midnight` (`witness/midnight.ts`: the setting where it can be read, `ran` per game in live mode, `ran` false or `ran_span` per sitting in basic mode; the refuse-or-flag rule is ArcAid's, `docs/arcaid-side-changes.md` §25); 0.2.50 (still protocol 6, companion-only): a pause during this player's own live ball leaves the headset view as it was, and the panel comes once the ball has ended (`vrViewMode` in `match/controller.ts`, D8.14), and Settings has "Send logs to Arcaid support" in both editions (`witness/witness.ts`, E8.3: ArcAid's existing `GET /api/witness/logs/request`, then the upload at once). Testers Krobs and ChuckRibbits, the latter on the OpenGL VPX build; both have an NVIDIA GeForce RTX 5070 Ti, so no tester has an AMD or Intel GPU (Chuck's was long written down as AMD; his `vr-layer.log` says GeForce). Both run VPX through OpenComposite, where `[PlayerVR] AskToTurnOn` must be 0 (WORK A6.3)). Code signing waits for GA (owner ruling 2026-10-18). The repo is
  public and must stay so: installed apps read the releases feed anonymously (0.2.6).
- Gates passed: Phase 0 spike (owner's rig, 2026-10-17; findings in `docs/phase-0-spike.md` §8), Phase 1
  protocol + host mode (CI, 2026-10-18), Phase 2 half 1 (Monster Bash to a tournament board with the
  Witness badge, 2026-10-18), Phase 2 half 2 (Krobs' clean install posts a badged score, 2026-10-25).
- Fairness build order F1–F6 is `docs/design/fairness-and-table-identity.md` §7; F1–F4 and F6 shipped (0.2.4 →
  0.2.14 here, ArcAid 2.163 → 2.168); F5 is WORK item B5 (engine shipped, preflight waits on ArcAid). Integrity mode is ADR 0005 here and ArcAid ADR 0027.
- ArcAid is the server (arcaid.app). Its side of the work is `docs/arcaid-side-changes.md`; it is tracked
  in the ArcAid repo's own `WORK.md`, section W, and mirrored here as section F.
- The owner's rig runs Panasony VR builds and a VPinMAME nightly, both allowed in Sanctioned play
  (ruling 2026-10-19). Its device row predates ArcAid #363; one re-pair from Settings fixes its type.
- The VPX fork exists since 2026-11-15: `github.com/mekelburgj20/castcade-vpx` (from `Panasony1008/vpinball` `10.8.0`), branch `castcade/state-stream`, state streaming per ADR 0011 (`CASTCADE_STREAM=play|watch`; the owner watched a recorded game in the headset on 2026-11-16, and it ran between two PCs, both directions, with Krobs on the official 10.8.0.2058 plus the drop-in zip on 2026-11-18: WORK I11.2). It builds locally in about a minute with `C:\code\repos\castcade-vpx-deps\build.ps1` (ATL and the June 2010 DirectX SDK are unpacked there, not installed); `tools/castcade/pair.ps1` in the fork runs two instances with paired screenshots and sends no keyboard input; `tools/castcade/package.ps1` makes the tester zips. The companion carries the stream since 0.2.44: the Match tab's **3D watch** session (`companion/src/watch/`, `main/watch-host.ts`): loopback TCP between each VPX and its own companion, a data-only WebRTC connection between the companions signalled through the relay room of an invite code, so no port forward; it is a session of its own. Since 0.2.46 the same tunnel also runs **inside a match** (`match/stream3d.ts`, `main/stream3d-host.ts`; contract and what was measured: `docs/design/state-stream-in-match.md`): the tunnel is signalled as `MEDIA_SIGNAL` channel `stream` (protocol 6); a match table is started in the fork with `CASTCADE_STREAM=match` when the fork is beside the known exe and the `watch3d` setting is `auto`; the fork connects to the companion's loopback control server (its port kept in `<userData>/stream3d.json`; text lines `hello`, `state playing|watching|failed <reason>` one way, `watch <addr>` and `play` the other) and, while another player is up and this PC's table is locked, pauses its own game and shows that player's table, then puts its own game back; a PC without the fork, with another table file, with `watch3d` off or with a watch that failed gets the 2D video as before. The tunnel opens in the lobby and a connection that comes up late switches the turn to 3D; on main since 2026-11-20 the match's first start is also held for it (I11.4.9: `PARTICIPANT_UPDATE.stream3dWaitMs`, `HELLO_ACK.stream3dWait`, never logged; one limit of 45 s from the first held start in `match/controller.ts`; design §4.5). The fork has the role `match` from build `castcade-9e78aef` (`castcade/state-stream`, I11.3); the build of the first two-PC night, 621694f, has not, and starts as plain VPX in a match; a fork that has not said `hello` 45 s after its table was seen open is no longer waited for (`FORK_HELLO_WAIT_MS`, 0.2.48). From build `castcade-9adaab5` Panasony's VR nudge movement (the table moved in the room by `NudgeStrength` x `AnalogNudgeGain`) is off unless `[Player] CastcadeVRNudgeShake = 1`: with an official install's ini it blurred a player's own table (I11.15); from build `castcade-32c0746` a table that watches shows the watched player's DMD and not this PC's captured DMD window (VPX's `CaptureExternalDMD` drops every script DMD frame while a DMD window is captured, the stream's too; `Player::ScriptDmdTexture`, `[Player] CastcadeWatchDMD = 0` for the stock rule; I11.5.1); `tools/castcade/match-test.ps1` there and `companion/scripts/match-stream-harness.ps1` here prove the two halves on one PC; two PCs and the headset were I11.4.8 (passed 2026-11-20, owner + Krobs). The fork also records a game (`CASTCADE_STREAM_RECORD`) and `castcade-replay.ps1` replays it to a watcher at the recorded pace (I11.7). On the owner's rig the installed Castcade takes any `VPinballX*` exe that loads a table for a game (a report to ArcAid, `vpxExe` rewritten): test instances run from a copy of the exe under another name (I11.8). A file write on VPX's render thread can take 0.1 to 2.8 s on that rig, so the journal stays off it: the fork's logs go through a writer thread; the hook holds its journal open from table load to exit (lib 0.5.2, C16) and, from lib 0.6.0 (C16.2), writes its lines to `\\.\pipe\castcade-journal` while the companion runs, where a worker thread of the companion (`witness/journal-pipe*.ts`) appends them to the same journal file (the file itself when the companion is not running or fails mid-game; one writer per journal; a VPX exit waits for the last lines before anything acts on it). The lock flag's `FileExists` at a key press is the one file-system call left there; `CASTCADE_FRAMELOG=<file>` in the fork (on in `Castcade Record.bat`) names the phase of every slow frame (I11.10).
- Test room for testers' scores: Flippin Fear Fest (`arcaid_flippin_fear_fest_26`); tester kit `docs/tester-kit.md`, for a cabinet `docs/tester-kit-cabinet.md` with the setup probe `tools/probe/`.
- A spike on **upstream VPX 10.9** (not the Castcade fork) lives outside this repo since 2026-11-21 (WORK I13; `docs/design/script-variable-reader-10.9-FINDINGS.md`): the clone `C:\code\repos\vpx-109` (branch `reader/spike`, local commits only, never pushed), its run folder `C:\code\repos\vpx-109-run` and table copies in `C:\code\repos\vpx-109-tables`. It reads a no-ROM table's own script variables through a new plugin-API call (`GetScriptVariable`) and a reader plugin (`plugins/arcaid-reader`), for Legends Unchained's ScoreServer. Its player runs only as `reader109.exe` through `vpx-109-run\run-reader.ps1` (isolated profile, network plugins off, minimized); the findings doc §3 has the build and the traps. Upstream renamed 10.8.1 to 10.9.0 on 2026-11-19 (one line of development, no release or beta of it yet; its VR is OpenXR on the BGFX build only, OpenVR is removed); a port of Castcade to it is WORK I14, and the spike's three commits are also kept as a bundle and patches in `tmp/vpx-109-spike/`.

## Commands

```bash
npm ci                         # install all workspaces (Node 22+)
npm run check                  # lint + typecheck (tsc -b) + all tests + work:check; run before committing
npm run work:summary           # the terminal view of WORK.md (what /work shows); work:check validates it, work:board renders tmp/work-board.html
npm run lint                   # eslint (flat config at the root)
npm run typecheck              # tsc -b over protocol, companion, fakeclient
npm test                       # vitest, all packages (tests import workspace packages from sources)
npx vitest run protocol        # one package; or a path / test-file name for a single test
npm run build                  # tsc -b in every workspace (+ renderer bundle in companion)
npm run protocol:generate      # regenerate protocol/schemas/*.json and protocol/SPEC.md after editing protocol/src
npm run generate -w protocol -- --check   # what CI runs: fails if the generated files are stale
python fixtures/check.py       # replay the recorded journals through the Phase 0 detector (needs the maps corpus, see fixtures/README.md)
npm run fetch-maps -w companion   # fetch the pinned pinmame-nvram-maps corpus into companion/resources/maps (gitignored; needed to package)
npm run fetch-ffmpeg -w companion # fetch the pinned ffmpeg build (sha256-checked) into companion/resources/ffmpeg (gitignored; needed to package, D1.6)
npm run fetch-vr-overlay -w companion # fetch the OpenVR overlay helper zip from the pinned release into companion/resources/vr-overlay (gitignored; `--from vr-overlay/build/Release` for a local build; D7)
npm run fetch-vr-layer -w companion   # fetch the OpenXR panel layer zip (dll + json) into companion/resources/vr-layer (gitignored; `--from vr-layer/build/Release` for a local build; D7.3)
npm run fetch-audio-helper -w companion # fetch castcade-audio.exe (the table-sound helper) into companion/resources/audio-helper (gitignored; `--from audio-helper/build/Release` for a local build; D2.8)
npm run fetch-video-helper -w companion # fetch castcade-video.exe + FFmpeg DLLs (the native spectator-video helper) into companion/resources/video-helper (gitignored; `--from video-helper/build/Release`, relative to the repo root, for a local build; D10.1)
npm run ffmpeg-source -w companion # download the GPL Corresponding Source of the bundled ffmpeg into companion/release (release.yml uploads it; E5, docs/ffmpeg-source.md)
npm run fetch-vps -w companion    # build the compact VPS index into companion/resources/vps from the pinned vps-db commit (gitignored; needed to package; the installed app refreshes it daily from vps-db main into userData, B24); `--from <vpsdb.json> --subset <ids>` rebuilds fixtures/vps
npm run playfield-tags -w companion -- "<table.vpx>"   # re-record fixtures/playfield/tags.json (B4.1) after a VPX update: tag names and counts only
npm run witness-games -w companion   # regenerate docs/witness-games.{json,md} (B14) from the fetched VPS index × maps corpus; verified = a fixtures/nvram/<rom> folder
npm run pack:dir -w companion     # unpacked app in companion/release/win-unpacked (then run Castcade.exe --smoke)
npm run dist:win -w companion     # NSIS installer in companion/release (unsigned)
```

Spike tooling (Python/PowerShell, no Node): `vpx-hook/spike/` (see `vpx-hook/README.md`);
`python vpx-hook/spike/tail-journal.py <journal|fixture.jsonl.gz>` replays a journal through the decoder and
detector (the three fixtures must still yield balls 1,2,3 + game_end and nothing spurious).

## Session start — read in this order

0. `WORK.md` (`/work`): what is open, claimed, blocked, and what the owner wants next. Then, for the design behind an item:
1. `docs/design/arcaid-integration-gap-analysis.md` — what ArcAid already has, the owner's rulings, the revised architecture and phases. **Source of truth.**
2. `docs/decisions/` — ADRs 0001–0011 (script hook not plugin · match = Throwdown · one app, Castcade uses Arcaid Witness · per-table import primary, core.vbs patch opt-in · Open / Sanctioned play · one live work tracker · functionality before ease of setup · sanctioned VPX build for Sanctioned play · spectating is 2D · the spectator-video stack is libwebrtc, chosen by the D10.0.1 spike · a watcher may render the player's table in their own VPX: state streaming in the fork).
3. `docs/design/fairness-and-table-identity.md` — table identity, playfield fingerprint, script inspection, the honest ceiling, build order F1–F6.
4. `docs/design/table-import-and-patching.md` — the Import-a-table pipeline (also the handoff doc for the ArcAid desktop-Witness agent).
5. `docs/arcaid-side-changes.md` — the work that lands in the ArcAid repo, by phase.
6. `docs/design/remote-two-player-design-handoff.md` — the original handoff; historical; wrong where the gap analysis says so.
7. In ArcAid: `docs/vpx-desktop-witness-plan.md`, ADRs 0017/0018/0020–0022, and `CLAUDE.md` sections "Live Event format", "Throwdowns", "Arcaid Witness".

ArcAid's desktop-Witness evidence (research findings, the staged T7 probe, cloned `pinmame-nvram-maps`,
`vpxtool`) is **gitignored** at `C:\code\repos\ArcAid\tmp\vpx-desktop-witness\`. Do not re-run that research.

## Owner rulings that are locked (do not reopen without asking)

| Ruling | Date | ADR |
|---|---|---|
| Target VPX **10.8.0** (no plugin system there; 10.8.1 is beta). In-process code = injected VBScript. Plugin deferred as a later swappable producer. | 2026-08-30 / 2026-10-17 | 0001 |
| A Castcade match is a **Throwdown** with `play_mode='castcade'`. Never a new "Challenge" entity. | 2026-10-17 | 0002 |
| **One desktop app.** The Windows desktop Witness producer lives here; the AtGames cabinet C++ app and the server contract stay in ArcAid. Shared = wire contract + event vocabulary + maps corpus, never code. | 2026-10-17 | 0003 |
| **Import a table** (per-table script patch) is the primary path; the shared `core.vbs` patch is a forced-choice setup opt-in for bulk Witness scoring. "Patched" never reads as "Castcade-ready". | 2026-10-17 | 0004 |
| Peer-hosted (host player's companion arbitrates and forwards media); ArcAid does signaling + results only. Architecture B (parallel 1-player games). Protocol N-player from day one; 2–4 players in the alpha mesh, **no player limit** as the goal (owner 2026-11-05; WORK D9). | handoff doc / 2026-11-05 | — |
| Names in code: product *Castcade*; lobby *Throwdown*; roles *host* / *client*; turn token *grant*. | handoff + 0002 | — |
| **Functionality before ease of setup.** VPX users accept complex setup; never drop a capability (multiplayer streaming, voice, fairness) to save a setup step. Within that, make install and setup as easy as possible: automate it, or walk the user through it. | 2026-10-27 | 0007 |
| A **sanctioned VPX build** (our fork, Sanctioned mode enforced in-process) is a per-tournament requirement for Sanctioned play; ArcAid trusts its signature and Legends Unchained's (Mox's), no other build. Castcade on stock VPX stays the app for Open play and everything else. | 2026-10-30 | 0008 |
| Tournaments have an **integrity mode**: *Open play* (default, any table of the game) or *Sanctioned play* (named table + fairness rules). Evidence is measured on the companion and sent with every score; rules gate only the auto-ingest into an opted-in tournament; room boards stay badge-never-gate. Mode names provisional. | 2026-10-18 | 0005 |
| **Spectating is 2D.** The player who is up is shown to everyone else as flat video (one eye, or the desktop window) on a screen in the headset, the desktop panel, or a cabinet's playfield display; never a stereo or head-tracked view. The stereo window of 0.2.27–0.2.35 stays in the code untouched; no further work on it. The VPinMAME shared machine is separate research (I10). | 2026-11-04 | 0009 |
| **State streaming is reopened** (it was shelved by 0009 §7): a watcher's own VPX may render the player's table from the watcher's own viewpoint and head, in our VPX fork, built on **Panasony's 10.8.0 branch**. Additive: the 2D video path is untouched and stays the default; both players need the fork and the identical table file. The DMD through VPinMAME is the owner's stated next iteration. | 2026-11-15 | 0011 |
| **VPinMAME's `cheat` option matters in no kind of tournament**, Sanctioned play included. It is the "Skip Pinball Startup Test" checkbox (a boot shortcut). Measured and sent as `build.cheat`, never shown to the player as "cheat", never a reason to refuse or flag a score. | 2026-11-24 | 0008 (amended) |

## Repo layout

| Path | Holds | Phase |
|---|---|---|
| `protocol/` | JSON schemas for every match message, version constant, generated spec | 1 |
| `companion/` | Electron + TS app: modules `patcher`, `witness`, `match`, `media`, `launch` | 2+ |
| `vpx-hook/` | `castcade.vbs` shared library (0.5.0: NVRAM chaining, script-event subs for originals, the `VPinball.ScoreServer` shim), `spike/` Phase 0 tooling, patch recipes, optional `core.vbs` bulk patch | 0, 3 |
| `vr-overlay/` | `castcade-vr-overlay.exe`: C++17/CMake/MSVC OpenVR overlay helper that draws the match panel in the headset (stdin frame pipe; OpenVR SDK pinned by tag + sha256; CI `vr-overlay.yml` is the build of record) | alpha (D7) |
| `vr-layer/` | `XrApiLayer_castcade_panel.dll` + manifest: C++17/CMake/MSVC implicit OpenXR API layer that appends the match panel as a quad inside VPinballX on non-SteamVR runtimes (frames over `\\.\pipe\castcade-panel`, same format as the helper's stdin; OpenXR headers pinned by tag + sha256; CI `vr-layer.yml` is the build of record) | alpha (D7.3) |
| `audio-helper/` | `castcade-audio.exe`: C++17/CMake/MSVC table-sound helper: CoreAudio session mute of the VPX process tree (plus PinUP / B2S) while another player is up, process-loopback tap of VPX (`CAU1` float32 stereo 48 kHz frames on stdout) while this rig is up, `--state` crash recovery; CI `audio-helper.yml` is the build of record | alpha (D2.8) |
| `video-helper/` | `castcade-video.exe`: C++17/CMake/MSVC native video helper on LiveKit's prebuilt libwebrtc (M150) with libavcodec (BtbN FFmpeg shared, GPL) as the encoder/decoder front: stdio JSON protocol with the companion, frame rings to and from the layer (`include/castcade_frame_ring.h`), the ladder and controller, the desktop window sink, the WGC source; `tools/drive-pair.mjs` rehearses two helpers without Electron; CI `video-helper.yml` is the build of record; `deps/` gitignored (fetch-webrtc.ps1, fetch-ffmpeg.mjs) | D10 |
| `fakeclient/` | scripted protocol player, no emulator, for CI | 1 |
| `spike/d10-video/` | the D10.0.1 stack spike (ADR 0010): shared harness dll (frame source + libavcodec encoder/decoder), UDP shaper, `measure.mjs`, the str0m / libwebrtc / GStreamer loopback senders, `results/`; the libwebrtc folder is the seed of `castcade-video.exe`; nothing here ships; `deps/` is gitignored | D10 |
| `arcade/` | RetroArch launch profiles, core allowlist, ROM memory maps | 6 |
| `fixtures/` | recorded NVRAM journals + script-event logs for detector replay in CI; `fixtures/maps` is the vendored subset of the maps corpus the tests read (CI has no full corpus) | 2–3 |
| `docs/` | design docs, ADRs, ArcAid work list | — |
| `tmp/` | scratch, gitignored | — |

Not present on purpose: `plugin-vpx/` (deferred), `rommaps/` (use the `pinmame-nvram-maps` corpus), the VPX fork
(its own repository, `github.com/mekelburgj20/castcade-vpx`, cloned at `C:\code\repos\castcade-vpx`; ADR 0008, ADR 0011).

## Working agreement

- **Journal file format is the product boundary** between in-VPX script and the companion. Change it only with a version bump and a fixture.
- **`ChangedNVRAM` is a destructive single-consumer read.** Every registration of `NVRAMCallback` goes through the one chaining routine in `castcade.vbs`.
- **Badge, never gate** (ArcAid doctrine): no verdict Castcade produces may filter a board or change a rank on the ArcAid side.
- **No real work in VBScript.** The script appends journal lines and reads one lock flag (checked at each key press, not polled; a key-up is swallowed only when its key-down was); decoding, detection and networking live in the companion.
- **Never commit** a ROM, a table file, a NVRAM file from someone else's machine, or a pairing token. Fixtures are journals we recorded.
- **One live tracker.** Open work goes in `WORK.md` as items; claim an item before editing another lane's files; `/wrap` before the session ends. Never start a second list (a `tmp/` bug list, a status paragraph in this file).
- Line endings: this repo is LF. The Write tool emits LF; prefer Edit for existing files.
- Build before committing once a build exists; subagent worktree conventions from `C:\code\repos\CLAUDE.md` apply.

## Relationship to the parent folder

`C:\code\repos\CLAUDE.md` is also loaded here. Its ArcAid-specific rules (Docker-first, `SPRINT_STATUS.md`
cadence, iScored) apply to ArcAid only. ArcAid is the reference for domain vocabulary and prior decisions;
there is no shared code.
