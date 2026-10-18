# companion/

**Status (2026-10-18): Phase 1 match engine + a minimal Electron shell + the Witness module (basic mode,
`src/witness/`, see below).** No patcher, media or launch code yet (Phase 3+).

- `src/match/` — the pure match engine, no Electron, no I/O except through a `Transport`: `HostMatch`
  (arbiter), `ClientMatch`, hash-chained `MatchLog`, `MatchState` as a fold over the log, `Session`,
  Ed25519 `keys`, `MemoryBus` (tests, full mesh) and WebSocket transports, `ManualClock`. Exported from
  `@castcade/companion` for `fakeclient/` and tests. Behaviour follows `protocol/SPEC.md`.
- `src/main/` + `src/preload/` + `renderer/` — the Electron shell: one window showing versions,
  sandboxed preload with a `contextBridge`, Vite + React renderer bundled to `dist/renderer`.
  `npm run dev -w companion` builds and opens it; `npm run smoke -w companion` prints
  `castcade <version> protocol <n>` and exits (what CI runs on Windows).
- Tests: `npx vitest run companion`.

The Castcade desktop app for Windows: Electron + TypeScript. It is also the Windows desktop producer
for Arcaid Witness (ADR 0003), and its first shippable release is exactly that: install, pair, play,
and last-game VPX scores reach ArcAid with the Witnessed badge, before any netplay exists.

## Modules

| Module | Responsibility | Phase |
|---|---|---|
| `patcher` | *Import a table*: extract the script, classify, apply a recipe, write the sidecar (or copy), hash manifest, verification run, per-table registry with two states (*witnessed* / *ready for Castcade*); the setup wizard's forced-choice core.vbs bulk patch + contextual nudge; the arcade twin (import a ROM → memory map → test read). ADR 0004 | 3 |
| `witness` | Pair as a witness device (`/api/me/witness/pairing-code` → `/api/witness/pair`); process-watch `VPinballX*.exe -Play`; basic mode decodes `.nv` + `VPReg.stg` on exit with the bundled `pinmame-nvram-maps` corpus; live mode tails the journal; posts report / checkin / heartbeat / score to the existing ArcAid endpoints | 2–3 |
| `match` | Throwdown pickup by code; host mode (turn arbiter, append-only log, `HOST_TRANSFER`); client mode; script-side turn lock + "not your turn" overlay; `HELLO` hashing; ball-end detector as a pure function over journal events, replayable from `fixtures/` | 3 |
| `media` | VPX window capture + hardware encode (720p30), WebRTC video forwarded through the host, Opus voice mesh with push-to-talk for the active player, DMD + `STATE` overlay, upload test and host recommendation, STUN + optional TURN | 4 |
| `launch` | Locate and launch VPX and RetroArch, preflight hashes, core/ROM allowlist checks (`arcade/`) | 2, 6 |

## Witness module (`src/witness/`, Phase 2 basic mode)

The Arcaid Witness desktop producer, basic mode: **no change to the player's VPX**. It watches for
`VPinballX*.exe -Play "<table>.vpx"`, snapshots the VPinMAME nvram directory at launch, and when VPX
exits decodes the `.nv` VPinMAME rewrote with the bundled `pinmame-nvram-maps` corpus to read the last
game's per-player scores, then posts to ArcAid's existing cabinet-Witness GET endpoints. The shell
depends only on `types.ts` (the contract; additive changes only) and `createWitness(store, deps?)` from
`index.ts`. Everything Windows-specific or networked is injectable (`WitnessDeps`), so the whole module
runs under vitest on Linux with fakes.

| File | Does |
|---|---|
| `maps.ts` | TypeScript port of the read side of `nvram_parser.py` (tomlogic/py-pinmame-nvmaps): `bcd`/`int`/`bits`/`bool`/`enum`/`ch`/`wpc_rtc`, nibble high/low, start/length/end/offsets, endian, scale/offset, mask, `special_values`, `char_map`, platform files, synthetic platform for old maps; decodes `game_state` (+ deprecated `last_game`), `high_scores`, `last_played`. Lazy `MapCorpus` over `index.json`; `mapsVersion` = `VERSION` or `.commit` in the corpus dir. |
| `journal-replay.ts` | Rebuilds the NVRAM buffer from a `vpx-hook` journal (`nvram_full` + `nvram_delta`, triples `[index, new, old]`); the fixture tests decode it like the on-disk `.nv`. |
| `process-watch.ts` | 2 s poll of a `ProcessLister` (real: one PowerShell `Get-CimInstance Win32_Process` query, JSON) → `launch`/`exit`; `-Play`/`/Play` parsing, table = file basename; the editor is a launch with `table: null`. |
| `nvram-dir.ts` | Settings override → `HKCU\Software\Freeware\Visual PinMame\globals\nvram_directory` (via `reg query`) → `<vpx root>\VPinMAME\nvram`. |
| `nvram-snapshot.ts` | `.nv` snapshots (size, mtime, bytes), diff, and the ≤5 s wait for VPinMAME's rewrite after exit. |
| `capture.ts` | The post decision as a pure function (below). |
| `arcaid-client.ts` | GET wrapper (15 s timeout, injectable fetch, `x-witness-token` header): `pair`, `report`, `score`, `heartbeat`; failures classified `network`/`server` (retry) vs `auth`/`client` (final). |
| `queue.ts` | Offline queue: JSON lines in `<dataDir>/witness-queue.jsonl`, backoff 5 s → 10 min, survives restart. |
| `witness.ts` | The orchestrator behind `createWitness`. |

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
session launch: basic mode reads one score at exit and has no game start of its own, which is exactly the
cabinet's exit-sample case (`sample='exit'` server-side, never `flagged`). `restarts`/`partial` are launcher
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
