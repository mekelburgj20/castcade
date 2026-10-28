# companion/

**Status (2026-10-18): Phase 1 match engine + the Phase 2 tray shell (v0.2.0) + the Witness module (basic
mode, `src/witness/`, see below).** No patcher, media or launch code yet (Phase 3+).

- `src/match/` — the pure match engine, no Electron, no I/O except through a `Transport`: `HostMatch`
  (arbiter), `ClientMatch`, hash-chained `MatchLog`, `MatchState` as a fold over the log, `Session`,
  Ed25519 `keys`, `MemoryBus` (tests, full mesh) and WebSocket transports, `ManualClock`. Exported from
  `@castcade/companion` for `fakeclient/` and tests. Behaviour follows `protocol/SPEC.md`.
- `src/witness/` — the Arcaid Witness desktop producer. `types.ts` is the contract between it and the
  shell (`createWitness(store)`); the shell imports nothing else from the folder.
- `src/main/` — the Electron main process: single-instance tray app (window close hides to the tray;
  tray menu: Open, Pause/Resume watching, Start with Windows, Quit), `settings.ts` (JSON store at
  `%APPDATA%\Castcade\settings.json`, token encrypted with `safeStorage`, deviceId generated once),
  `witness-host.ts` (owns the witness instance, restarts it when the ArcAid URL or nvram dir changes),
  `log.ts` (rotating `%APPDATA%\Castcade\logs\companion.log`), `updater.ts` (electron-updater, packaged
  builds only: check at launch, then every 4 h, retry 30 min after a failure; log + one tray balloon), `allowlist.ts` (`openExternal` limited to the ArcAid origin and
  the project page). `--smoke` prints `castcade <version> protocol <n>` and exits before any of this.
- `src/preload/index.cts` — sandboxed CommonJS preload exposing the typed `window.castcade` bridge
  (`ipc-types.ts` is the single description; `renderer/src/castcade.d.ts` mirrors it by hand).
- `renderer/` — Vite + React, one 420×640 window with three views: Pairing, Status, Settings/About
  (with the ODbL attribution for the maps corpus). `npm run typecheck:renderer -w companion`.
- Commands: `npm run dev -w companion` (build + open with the Vite dev server), `npm run smoke -w companion`,
  `npx vitest run companion`, `npm run pack:dir -w companion` (unpacked app in `release/win-unpacked`),
  `npm run dist:win -w companion` (installer in `release/`), `npm run release:win -w companion` (also
  publishes to GitHub Releases; needs `GH_TOKEN`).
- Tester guide: `docs/phase-2-witness.md`.

### Packaging as built (Phase 2)

`electron-builder.yml`: NSIS, x64 only, per-user (`perMachine: false`, no elevation), assisted installer
(`oneClick: false`, directory choice), artifact `Castcade-Setup-<version>.exe`, `files` = `dist/**` +
`package.json` + the two icons in `build/`, `extraResources` = `resources/maps` → `resources/maps` in the
install (the corpus is fetched by `npm run fetch-maps -w companion` before packaging; `release.yml` does
this), `resources/vps`, the hook library, and `resources/ffmpeg` (D1.6: `npm run fetch-ffmpeg -w companion`
fetches Gyan's GPLv3 essentials build of ffmpeg 8.1.1, sha256-pinned in `scripts/fetch-ffmpeg.mjs`, and keeps
`ffmpeg.exe`, `ffplay.exe`, `LICENSE`, `README.txt` and a `VERSION`; it adds about 54 MB to the installer).
`src/media/ffmpeg-path.ts` finds it; `Castcade.exe --smoke` prints `ffmpeg bundled <build>` when it is there. `npmRebuild: false` and an **exact** `electron` version in `package.json` are required because the
companion is an npm workspace (hoisted `node_modules`). Publish target: GitHub Releases
(`mekelburgj20/castcade`), which is also where electron-updater looks. The repo must stay **public**: the
updater reads the releases feed anonymously and GitHub answers 404 for a private repo (that is how 0.2.2
installs sat on 0.2.2 until 2026-10-19).

**The PoC is unsigned.** SmartScreen shows *"Windows protected your PC"*; testers click *More info →
Run anyway*. No signing configuration exists in the repo yet; a certificate remains the launch blocker
below before anything ships outside the test group.

The Castcade desktop app for Windows: Electron + TypeScript. It is also the Windows desktop producer
for Arcaid Witness (ADR 0003), and its first shippable release is exactly that: install, pair, play,
and last-game VPX scores reach ArcAid with the Witnessed badge, before any netplay exists.

## Modules

| Module | Responsibility | Phase |
|---|---|---|
| `patcher` | *Import a table*: extract the script, classify, apply a recipe, write the sidecar (or copy), hash manifest, verification run, per-table registry with two states (*witnessed* / *ready for Castcade*); the setup wizard's forced-choice core.vbs bulk patch + contextual nudge; the arcade twin (import a ROM → memory map → test read). ADR 0004 | 3 |
| `witness` | Pair as a witness device (`/api/me/witness/pairing-code` → `/api/witness/pair`); process-watch `VPinballX*.exe -Play`; basic mode decodes `.nv` + `VPReg.stg` on exit with the bundled `pinmame-nvram-maps` corpus; live mode tails the journal; posts report / checkin / heartbeat / score to the existing ArcAid endpoints | 2–3 |
| `match` | Throwdown pickup by code; host mode (turn arbiter, append-only log, `HOST_TRANSFER`); client mode; script-side turn lock + "not your turn" overlay; `HELLO` hashing; ball-end detector as a pure function over journal events, replayable from `fixtures/` | 3 |
| `media` | **4a:** VPX window capture + hardware encode (720p30), score/Witness overlay, direct RTMP push to Twitch/YouTube with the player's own key, local MP4 recording with a hash manifest, OBS browser-source overlay. **4:** WebRTC video forwarded through the host, Opus voice mesh with push-to-talk for the active player, DMD + `STATE` overlay, upload test and host recommendation, STUN + optional TURN, watch link, runner stage (ArcAid item 13) | 4a, 4 |
| `launch` | Locate and launch VPX and RetroArch, preflight hashes, core/ROM allowlist checks (`arcade/`) | 2, 6 |

## Witness module (`src/witness/`, Phase 2 basic mode)

The Arcaid Witness desktop producer, basic mode: **no change to the player's VPX**. It watches for any
`VPinballX*.exe` (launched with `-Play`, by file association, or bare and driven from the editor),
keeps a baseline of the VPinMAME nvram directory while VPX is open, and whenever the in-process player
closes (VPinMAME rewrites the ROM's `.nv`) or VPX exits with a changed `.nv`, decodes that file with the
bundled `pinmame-nvram-maps` corpus to read the last game's per-player scores and posts to ArcAid's
existing cabinet-Witness GET endpoints. The shell depends only on `types.ts` (the contract; additive
changes only) and `createWitness(store, deps?)` from `index.ts`. Everything Windows-specific or
networked is injectable (`WitnessDeps`), so the whole module runs under vitest on Linux with fakes.

**One capture per player session.** VPX is long-lived on the desktop (a table opened from the editor
or a recent-files entry keeps the process alive between games), so the unit of capture is the player
session, not the process: a `.nv` that changes and then stays unchanged for the settle window (5 s,
polled every 3 s while VPX is open) triggers decode → decide → post, and the baseline is refreshed so
the next game is compared against the state this one left. Process exit is the final chance for a
`.nv` that changed without a capture yet; an unchanged `.nv` at exit produces nothing (no duplicate).
`started` is the later of the process start (CIM `CreationDate`) and the previous capture for that
process, `ended` is the `.nv` mtime. You may stay in the editor between games.

**Conditions (F2, 0.2.5):** once the table is known, `ini-attestation.ts` reads the settings VPX will apply
(the global ini resolved like VPX does: `-Ini`, else beside the exe, else `%APPDATA%`; the table's `<table>.ini`
layered on top), combining them with the table file's own `ORRP`/`ORPF`/`TDFT` properties into physics set,
difficulty, slope, nudge and table options; `build-attestation.ts` hashes and versions the exe and the VPinMAME
DLL (found through the COM registration, else beside the exe) against `KNOWN_BUILDS`; at capture
`adjustments.ts` decodes the ROM's operator adjustments from the same `.nv` bytes the score came from and
`vpmCheatFlag` reads VPinMAME's cheat option. All of it rides on the score as `ini` / `adjustments` / `build`
and shows in Status. Measured, never enforced.

**Table identity, strongest first:** `-Play <path>.vpx` → a positional `<path>.vpx` (file association,
`-Edit`) → the editor's window title `Visual Pinball - [<table>]` (polled with the process list) →
the ROM's name from the corpus's `romnames.json` with its version parenthetical stripped → the ROM id.
A capture is never refused for want of a name; `LastCapture.detail` says how the name was derived.
`launch`/`exit` fire for every VPX process with `table` null until one is known; `status.note` reads
"VPX is open; no table known yet" meanwhile and `currentTable` follows the title.

| File | Does |
|---|---|
| `maps.ts` | TypeScript port of the read side of `nvram_parser.py` (tomlogic/py-pinmame-nvmaps): `bcd`/`int`/`bits`/`bool`/`enum`/`ch`/`wpc_rtc`, nibble high/low, start/length/end/offsets, endian, scale/offset, mask, `special_values`, `char_map`, platform files, synthetic platform for old maps; decodes `game_state` (+ deprecated `last_game`), `high_scores`, `last_played`. Lazy `MapCorpus` over `index.json`; `mapsVersion` = `VERSION` or `.commit` in the corpus dir. |
| `journal-replay.ts` | Rebuilds the NVRAM buffer from a `vpx-hook` journal (`nvram_full` + `nvram_delta`, triples `[index, new, old]`); the fixture tests decode it like the on-disk `.nv`. |
| `process-watch.ts` | 2 s poll of a `ProcessLister` (real: one PowerShell query joining `Get-CimInstance Win32_Process` with `Get-Process` for `MainWindowTitle`, JSON, 5.1 and 7 date shapes) → `launch`/`exit`/`title`; `-Play`/`/Play` and positional `.vpx` parsing, `Visual Pinball - [<table>]` / `Visual Pinball Player` title parsing. |
| `nvram-dir.ts` | Settings override → `HKCU\Software\Freeware\Visual PinMame\globals\nvram_directory` (via `reg query`) → `<vpx root>\VPinMAME\nvram`. |
| `nvram-snapshot.ts` | `.nv` snapshots (size, mtime, bytes), diff, and the ≤5 s wait for VPinMAME's rewrite after exit; the alive poll in `witness.ts` uses the same snapshot/diff. |
| `capture.ts` | The post decision as a pure function (below). |
| `arcaid-client.ts` | GET wrapper (15 s timeout, injectable fetch, `x-witness-token` header): `pair`, `report`, `score`, `heartbeat`; failures classified `network`/`server` (retry) vs `auth`/`client` (final). |
| `queue.ts` | Offline queue: JSON lines in `<dataDir>/witness-queue.jsonl`, backoff 5 s → 10 min, survives restart. |
| `witness.ts` | The orchestrator behind `createWitness`: sessions per pid, the alive nvram poll + settle, the one capture path shared by the player-closed and exit triggers, table-name resolution. |

**ArcAid contract (read from `ArcAid/src/services/WitnessService.ts`, `VpxScoreIngestService.ts`, routes in
`global.ts`, ADRs 0020–0022):** all timestamps on the wire are **epoch seconds**; `GET /api/witness/report?device&table&launch&exit&dur`
(session), `GET /api/witness/score?device&table&rom&score&started&ended&dur&reason` (game),
`GET /api/witness/heartbeat?device` every **120 s** (the server reads a device as offline after
`HEARTBEAT_STALE_SEC` = 300 s), `GET /api/witness/pair?code&device&username&type=desktop` (`type` is for the
ArcAid change in `docs/arcaid-side-changes.md` §1; today's server ignores it). A 401 on any call means the
token was revoked: the capture is `rejected`, `lastError` reads "unpaired by ArcAid", the token is kept.

**Decision rules (mirroring the cabinet, ADR 0022 §5):** one player only — a game with more than one player
(nonzero score or `player_count`) is skipped whole; a `.nv` rewritten with an unchanged game state is "no new
game"; a session under 20 s posts nothing; a table whose ROM has no map, or no `.nv` at all (originals), is
`skipped` with the reason in `detail`. The score is posted with `reason=exit_sample` and `started` = the
player session's start bound (process start or the previous capture): basic mode reads one score when the
player closes and has no game start of its own, which is exactly the cabinet's exit-sample case
(`sample='exit'` server-side, never `flagged`). A `report` (session) is posted per capture with the same
bounds. `restarts`/`partial` are launcher
facts basic mode cannot know and are not sent; `via` is never set — `via=retro` is for sessions reconstructed
from disk that the device did not watch, and basic mode watches every session it reports, even when the post
is delivered late from the queue. Wire `status` → outcome: `ingested`/`global` → `ingested`,
`duplicate`/`global_duplicate` (and a suppressed play, which arrives as `duplicate`) → `duplicate`,
`no_match` → `skipped`, `invalid` → `rejected`.

**Maps corpus:** `npm run fetch-maps -w companion` (`scripts/fetch-maps.mjs`) shallow-fetches the pinned
commit of tomlogic/pinmame-nvram-maps into `companion/resources/maps/` (gitignored) with a `VERSION` file;
`fixtures/maps/` vendors the two maps the tests need (ODbL, attribution in its README).

**Not done / TODO:** `vpreg.ts` (reading `user\VPReg.stg`, an OLE compound file, for an original table's
high-score list) is not implemented; originals currently end as `skipped: no .nv changed`. Live mode
(journal tailing) is Phase 3.

## Packaging (non-negotiable, from the ArcAid Witness plan)

- Per-user install, no admin, no COM registration, no firewall prompt (IPC with the script is a
  journal file, not a socket).
- Default install modifies nothing in the player's VPX. Writes happen only after *Import a table*
  or the wizard's explicit choice, always with a hash manifest and one-click revert.
- Installer: Velopack (built-in delta auto-update) or Inno Setup; decide at Phase 2.
- **A code-signing certificate (OV/EV, roughly $200–400/yr plus reputation) is a launch blocker.**
  Unsigned downloads hit SmartScreen and most players stop there. Budget before Phase 2 ships
  outside the test group.
- Bundle the maps corpus with background refresh; ODbL attribution in the About box.
- Tray shows proof of life ("Last capture: … · Live mode on · N tables ready").

## What does not live here

- The message schemas (`protocol/`), the VBScript library and recipes (`vpx-hook/`), the RetroArch
  profiles and ROM maps (`arcade/`), recorded journals (`fixtures/`).
- The AtGames cabinet Witness app or any ArcAid server code (both stay in the ArcAid repo).

## Read first

`docs/design/arcaid-integration-gap-analysis.md`, `docs/design/table-import-and-patching.md`,
ADRs 0001–0004, and `ArcAid/docs/vpx-desktop-witness-plan.md` §4 and §8.
