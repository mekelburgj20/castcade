# Castcade — Work

Board: https://claude.ai/artifact/2AsfpUMPfRB1yQhnirHQKd  ·  Rules: `.claude/commands/work.md`  ·  Check: `npm run work:check`

One line per item, IDs never reused. History: `CHANGELOG.md` and `git log -- WORK.md`. Design and rulings:
`docs/design/`, `docs/decisions/`. Pick an item with `/work <ID>`; end a session with `/wrap`.

## Now

- Companion 0.2.10 (unsigned PoC; repo public, keep it so). ArcAid is at 2.166.1 with integrity mode live (F3 complete).
- In flight: nothing claimed.
- Next by the owner's ruling (2026-10-18): B4 playfield fingerprint (F4), then B5 script diff (F5) with its ArcAid half (F5 here = ArcAid item 12).
- Owner actions: re-pair the rig from Settings (its device row predates ArcAid #363, so it still reads as a cabinet) · a tester's clean-machine install (E1).
- Streaming for stream nights (D1, Phase 4a) is scheduled right after F4–F5 and needs nothing from Phase 3.
- Last wrap: 2026-10-21 (this tracker introduced; replaces the "Current state" blob in CLAUDE.md).

## A. Protocol and match engine

Lane: `protocol/**`, `companion/src/match/**`, `fakeclient/**`. Phase 1 shipped 2026-10-18 (gate passed, CI green); these are the gaps it carried.

- **A1** `done 0.1.0` Phase 1: v1 schemas, host arbiter, client, hash-chained log, Ed25519 keys, in-memory + WebSocket transports, fakeclient gate test
- **A2** `ready` Host transfer over WebSocket — clients must reconnect to the new host today · spec: protocol/docs/prose.md · gate: fakeclient scenario with a forced transfer over WS
- **A3** `ready` Client reconnect after a drop — resume from the log hash, not a fresh HELLO · needs: A2
- **A4** `idea` Simultaneous mode — exists in the schemas, never exercised; needs a fakeclient scenario before it is called supported
- **A5** `blocked F6` Post a signed RESULT to ArcAid — waits on the ArcAid roster, relay and ingest (F6)

## B. Witness and fairness

Lane: `companion/src/witness/**`, `docs/design/fairness-and-table-identity.md`. Build order F1–F6 in that doc §7; integrity modes are ADR 0005.

- **B1** `done 0.2.4` F1 table identity: VPS game/table ids, file hash, save revision on every score; one-time picker; `tablesDir` setting
- **B2** `done 0.2.8` F2 attestation: ini, NVRAM adjustments, build hashes + family, VPinMAME cheat flag, accelerometer and tilt keys (0.2.5 → 0.2.8)
- **B3** `done 0.2.10` F3 companion half: `not_sanctioned` → rejected capture with reasons on Status; `play_device` (VR headset vs monitor) per session
- **B4** `ready` F4 playfield fingerprint — compound-file reader + record walker over the playfield fields; shared with the Phase 3 importer (C1) · spec: docs/design/fairness-and-table-identity.md §3 · gate: stable fingerprint across two launches of the owner's Monster Bash, changes when a flipper is moved
  - **B4.1** `ready` Pin the record-tag list in a fixture so a VPX rename fails a test, not a tournament · spec: docs/design/fairness-and-table-identity.md §8
- **B5** `ready` F5 script diff, companion half — baseline download, normalise, classify, preflight verdict, diff report · needs: B4 · spec: docs/design/fairness-and-table-identity.md §4 · touches: ArcAid item 12 (F5)
- **B6** `blocked C2` F6 engine attestation from the live hook; score-jump plausibility · spec: docs/design/fairness-and-table-identity.md §5
- **B7** `ready` Nudge telemetry: HID trace + lift detector, `nudge` param on the score · spec: docs/design/fairness-and-table-identity.md §5a
- **B8** `idea` ROM→VPS game map served by ArcAid with a shipped seed (today: shipped only) · spec: docs/design/fairness-and-table-identity.md §8
- **B9** `ready` Field gate for F1–F2's live half: the owner flips a physics override on and off and the values show on arcaid.app · gate: docs/design/fairness-and-table-identity.md §7 "Gate for F1–F2"
- **B10** `idea` SAM/SPIKE `game_state` maps: contribute upstream or declare unsupported in v1

## C. Table import, hook, detector, turn lock (Phase 3)

Lane: `vpx-hook/**`, `companion/src/patcher/**`, `fixtures/**`. ADR 0001 (script hook) and ADR 0004 (per-table import primary, `core.vbs` opt-in). Design: `docs/design/table-import-and-patching.md`.

- **C1** `ready` Import-a-table pipeline: `.vpx` reader (shares B4's record walker), script extract, recipe match, sidecar write, readiness record · spec: docs/design/table-import-and-patching.md
  - **C1.1** `ready` Recipes: VPM, JPSalas original, Scorbit-anchored
  - **C1.2** `idea` Classification coverage check over the owner's 134 tables and a VPW/JPSalas-heavy collection
- **C2** `ready` Journal tailer + ball-end detector as a pure function over `fixtures/` · gate: the three Phase 0 fixtures yield balls 1,2,3 + game_end and nothing spurious (`python fixtures/check.py`)
  - **C2.1** `ready` Absorb the Phase 0 findings: journal volume, boot-garbage gate, bonus after ball_end, exit mid-game · spec: docs/phase-0-spike.md §8
  - **C2.2** `ready` Extra-ball fixture: ball-in-play and player unchanged, detector must not fire
- **C3** `ready` Turn lock + overlay: `_KeyDown` wrap reads one lock flag per key press; key-up swallowed only when its key-down was · needs: C2
- **C4** `ready` `HELLO` = hash(original `.vpx`) + recipe version + sidecar hash; readiness shared to ArcAid (item 8) · needs: C1
- **C5** `idea` Bulk mode: setup-wizard forced choice, `core.vbs` patch, self-heal, chaining guard — slips if Phase 3 runs long; not on the streaming path · needs: C1
- **C6** `idea` Same-basename sidecar auto-load on 10.8.0 Windows without a prompt; else `importvbs` copy (Phase 0e finding)

## D. Media: streaming, recording, voice

Lane: `companion/src/media/**`. Phase 4a (solo) needs nothing from Phase 3; Phase 4 (match spectating, voice, runner stage) waits for real players in the match engine.

- **D1** `ready` Phase 4a solo streaming + recording: VPX window capture, NVENC/AMF/QSV encode (Phase 0d path), score/ball/Witness overlay, direct RTMP to Twitch/YouTube with the player's own key (`safeStorage`, never sent to ArcAid), local MP4 · spec: docs/design/arcaid-integration-gap-analysis.md §6 "4a"
- **D2** `idea` Phase 4 match streaming: WebRTC through the host, Opus mesh, push-to-talk, DMD + STATE overlay, upload test, STUN + optional TURN · needs: A2, D1
- **D3** `idea` Castcade watch link: any live player's feed in a browser, ArcAid signalling only · needs: D2
- **D4** `idea` Runner stage, companion half (ArcAid item 13 is the other half) · needs: D3

## E. Shell, updater, packaging, release

Lane: `companion/src/main/**`, `companion/src/preload/**`, `companion/renderer/**`, `companion/electron-builder.yml`, `companion/scripts/**`, `.github/workflows/release.yml`.

- **E1** `claimed` Phase 2 gate, half 2: a tester installs on a clean machine from the tester kit and a score lands with the badge · spec: docs/tester-kit.md · owner: owner · since: 2026-10-18
- **E2** `parked` Code signing — deferred until GA by owner ruling 2026-10-18
- **E3** `done 0.2.6` Updater re-checks every 4 h (30 min after a failure); repo made public so the releases feed answers
- **E4** `idea` Electron 44 / Vite 8 / vitest 5 follow-through: run the packaged app once after the 2026-10-21 dependency bumps (CI smoke passed; a real install has not)

## F. ArcAid side

Lane: none here. The work lands in `C:\code\repos\ArcAid` and is tracked in that repo's `WORK.md` (section W); this section mirrors the hand-off list so the two stay in step. Spec for every item: `docs/arcaid-side-changes.md`.

- **F1** `done 2.163.0` Item 1: desktop device type on `witness_devices` (ArcAid #363)
- **F2** `done 2.163.0` Item 9: desktop-witness plan amended (ArcAid #364)
- **F3** `done 2.166.0` Item 11: integrity mode, VPS-id matching, required table, evidence, admin UI, VR badge (ArcAid #370, #371; ArcAid ADR 0027)
- **F4** `ready` Item 10: room admin's live device view
- **F5** `ready` Item 12: script baseline, diff reports, preflight endpoint · needs: B5
- **F6** `ready` Items 2–8: `play_mode`, roster, `match:<id>` relay, `castcade_matches` + public keys, RESULT ingest with N signatures, ADR, table-readiness registry (Phase 5)
- **F7** `ready` Item 13: runner stage · needs: D3

## G. Arcade (Phase 6)

Lane: `arcade/**`. Needs no VPX; can overlap with anything.

- **G1** `idea` Import-a-ROM: hash, core allowlist, memory map (RetroAchievements seed), verification read via RetroArch UDP, registry
- **G2** `idea` Launch profiles + poller; gate: 4-player Galaga match, all four scores captured · needs: G1
- **G3** `idea` Confirm RetroArch UDP `READ_CORE_MEMORY` during netplay on the current release; FBNeo 4-client stability

## H. Docs, process, CI

Lane: `docs/**`, `.claude/**`, `WORK.md`, `CHANGELOG.md`, `tools/**`, `.github/workflows/ci.yml`.

- **H1** `done` Single work tracker + board + `/work` and `/wrap` (ADR 0006), 2026-10-21
- **H2** `ready` `CHANGELOG.md` back-fill detail for 0.2.0–0.2.3 from the release notes on GitHub (the seed entry lists them in one line each)
- **H3** `idea` `protocol/SPEC.md` prose: write the host-transfer and reconnect sections before A2/A3 ship so the spec leads the code
