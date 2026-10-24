# Castcade — Work

Board: https://claude.ai/artifact/2AsfpUMPfRB1yQhnirHQKd  ·  Rules: `.claude/commands/work.md`  ·  Check: `npm run work:check`

One line per item, IDs never reused. History: `CHANGELOG.md` and `git log -- WORK.md`. Design and rulings:
`docs/design/`, `docs/decisions/`. Pick an item with `/work <ID>`; end a session with `/wrap`.

## Now

- Companion 0.2.12 (unsigned PoC; repo public, keep it so): live mode, one-click table import with the unpatched-table notice, hook 0.4.0 engine attestation, limited attempts. ArcAid 2.168.0 reads the engine evidence (rule `engine`, Integrity panel "In the game"); F8 (ROM→VPS map endpoint) still open there.
- In flight: nothing claimed in either repo.
- Next by priority: B6.1 (score-jump plausibility; unblocked by C7.1.1, the 0.3.0 fixture) → B4 → B5 · C7.1.2 when the owner has played one game on 0.2.12 (ArcAid half W6) → D1 solo streaming (owner ruling 2026-10-21; D1 needs nothing from Phase 3).
- Owner actions: update the rig to 0.2.12; have Krobs update and click Settings → Import tables → Patch my tables once · optional F6 field check: in a Sanctioned tournament, change difficulty in the tweak menu mid-game and look for "changed during the game" on the Integrity panel · re-pair the rig from Settings (device row predates ArcAid #363) · a tester's clean-machine install (E1) · the F1–F2 field gate (B9).
- Watching: C9 (four arrivals per score, 2026-10-22) — no recurrence in three sessions since request logging. ArcAid's admin-ui scoreboard scroll-arrow test is flaky and once skipped a deploy; handed to the ArcAid session (its lane).
- Last wrap: 2026-10-23 — B6, C8, E4.1, F9 done; 0.2.11 and 0.2.12 released; C7 gate passed; C9 added.

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
- **B4** `ready` F4 playfield fingerprint — extend `vpx-file.ts` (compound-file reader + GameData BIFF walker, 0.2.4) to the `GameItem*` streams (flippers, slings, bumpers, kickers, collidable walls/ramps/primitives), canonical JSON, SHA-256; shared with the Phase 3 importer (C1) · spec: docs/design/fairness-and-table-identity.md §3 · gate: stable fingerprint across two launches of the owner's Monster Bash, changes when a flipper is moved 
  - **B4.1** `ready` Pin the record-tag list in a fixture so a VPX rename fails a test, not a tournament · spec: docs/design/fairness-and-table-identity.md §8
- **B5** `ready` F5 script diff, companion half — baseline download, normalise, classify, preflight verdict, diff report · needs: B4 · spec: docs/design/fairness-and-table-identity.md §4 · touches: ArcAid item 12 (F5)
- **B6** `done 0.2.12` F6 engine attestation from the live hook (hook 0.4.0 `engine` line at hook time + every key-down; on the score as `engine`; in-game change named in the capture) · spec: docs/design/fairness-and-table-identity.md §5
  - **B6.1** `ready` Score-jump plausibility from the live journal (a jump between samples larger than the machine's largest single award, scores off the ROM's granularity) → `score_plausibility` evidence · needs: C7.1.1 · spec: docs/design/fairness-and-table-identity.md §5 (memory trainers)
- **B7** `ready` Nudge telemetry: HID trace + lift detector, `nudge` param on the score · spec: docs/design/fairness-and-table-identity.md §5a
- **B8** `idea` ROM→VPS game map served by ArcAid with a shipped seed — today shipped only, from the vps-db index built at package time (`fetch-vps.mjs`); the server half is F8 · spec: docs/design/fairness-and-table-identity.md §8 · needs: F8
- **B9** `ready` Field gate for F1–F2's live half: the owner flips a physics override on and off and the ini values show in the Integrity panel on arcaid.app (2.166.0) · owner: owner · gate: docs/design/fairness-and-table-identity.md §7 "Gate for F1–F2"
- **B10** `idea` SAM/SPIKE `game_state` maps: contribute upstream or declare unsupported in v1
- **B11** `done 0.2.11` Limited attempts, companion half (ArcAid ADR 0029 / A16): attempt call at every live-mode game start, `attempt=<key>` on the score, Status shows the answer

## C. Table import, hook, detector, turn lock (Phase 3)

Lane: `vpx-hook/**`, `companion/src/patcher/**`, `fixtures/**`. ADR 0001 (script hook) and ADR 0004 (per-table import primary, `core.vbs` opt-in). Design: `docs/design/table-import-and-patching.md`.

- **C1** `done 0.2.11` Import-a-table pipeline (`companion/src/patcher/`): `.vpx` script extract (the CODE record), §4 classifier, sidecar render, manifest, library install, folder plan/apply/remove-all, stale guard; recipe A only — originals wait on C1.1
  - **C1.1** `ready` Recipes B (JPSalas original), C (Scorbit-anchored), D (ScoreServer), E (generic) — recipe A (VPM) shipped with C1; the classifier already tells the classes apart and the folder import skips them with the reason · spec: docs/design/table-import-and-patching.md §5
  - **C1.2** `idea` Classification coverage check over the owner's 134 tables and a VPW/JPSalas-heavy collection
- **C2** `done 0.2.11` Journal tailer + detector in the companion (`journal-detector.ts`, `journal-tail.ts`); the three Phase 0 fixtures replay in vitest to what `fixtures/check.py` asserts; lands in 0.2.11
  - **C2.1** `done 0.2.11` Phase 0 findings absorbed: journal volume (hook 0.3.0 `Castcade_WatchBytes`: watched offsets only, coalesced per 50 ms, one snapshot at hook time — from 89 lines/s to a few per score change), boot-garbage gate and exit mid-game (detector C2); bonus-after-ball_end documented in `detectTransition`
  - **C2.2** `ready` Extra-ball fixture: ball-in-play and player unchanged, detector must not fire
- **C3** `ready` Turn lock + overlay, companion half — write the lock flag from the match engine's grant, the overlay, analog-plunger fallback (open case, spike §8 0c); the `_KeyDown` wrap itself shipped in hook 0.1.0 (Phase 0c pass 2026-10-17) · needs: C2
- **C4** `ready` Fill `HELLO`'s `GameFingerprint` from the import manifest — hash(original `.vpx`) + recipe version + sidecar hash; the fields exist since 0.1.0; readiness shared to ArcAid (item 8 = ArcAid W8.1, Phase 3) · needs: C1 · touches: F6
- **C5** `idea` Bulk mode: setup-wizard forced choice, `core.vbs` patch, self-heal, chaining guard — slips if Phase 3 runs long; not on the streaming path · needs: C1
- **C7** `done 0.2.11` Live mode: every game of a session posts its own score (sidecar journal + detector, folder import with dry run and remove-all, three-layer stale-sidecar guard, hook 0.3.0) · spec: docs/design/table-import-and-patching.md
  - **C7.1** `ready` Recorded journal fixtures for the filtered-NVRAM hooks (0.3.0+), split in two (`fixtures/`, replayed in CI beside the three Phase 0 ones) · needs: C7 · touches: fixtures/README.md · note: the three-games-in-one-session gate PASSED 2026-10-23 on the INSTALLED 0.2.11 (updater) — four Monster Bash games, four `ingested`, one request each, attempt calls `unlimited`
    - **C7.1.1** `done 2026-10-24` Hook-0.3.0 fixture `fixtures/nvram/mb_106b/2026-10-23-1` (the C7 gate: five games over three loads), mb_106 map vendored; its second load caught a boot race (player 1 / ball 1, game over 59 ms later) that re-posted the last score, fixed: a ball or game end needs a seen `game_start` (detector + Python tailer)
    - **C7.1.2** `ready` Hook-0.4.0 fixture with `engine` lines: needs one game played on the rig on 0.2.12 (owner); asserts the engine samples · needs: C7.1.1
- **C8** `done 0.2.12` Import UX, second pass: one-click "Patch my tables" with progress and banners, VPX exe remembered across runs + `scripts` beside the tables folder as the fallback, desktop notification + Status line when a table opens unpatched
- **C9** `ready` [OBSERVE] Four arrivals per score at ArcAid on 2026-10-22 session 1 (hook 0.2.0, PC stalled by the 89 lines/s journal; ArcAid W14 done 2.167.1 — repeats inside 120 s now answer `ingested`, per-device serialized) — unexplained on the companion side: the code, the Node probe and the request log send ONE GET per capture, and the three sessions since the log landed (0.2.11, six games) show one `arcaid: #seq` per score with no repeat; keep until a recurrence: on one, the log's `#seq` lines say whether the companion sent them, and `tasklist` whether two companions ran (installed + unpacked) · spec: this line
- **C6** `done 2026-10-17` Same-basename sidecar auto-loads on 10.8.0 Windows without a prompt — Phase 0e PASS on TFTC, MM, Iron Maiden; sidecar is the default install path, `importvbs` copy stays C1's fallback

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
- **E4** `done 0.2.11` Electron 44 / Vite 8 / vitest 5 follow-through: 0.2.11 is the first packaged build on them (`pack:dir` + `--smoke` green on the owner's rig)
  - **E4.1** `done 0.2.11` The updater installed 0.2.11 on the owner's rig (log 2026-10-23T05:32Z: downloaded, installed on quit) and the next session posted four games live

## F. ArcAid side

Lane: none here. The work lands in `C:\code\repos\ArcAid` and is tracked in that repo's `WORK.md` (section W); this section mirrors the hand-off list so the two stay in step. Spec for every item: `docs/arcaid-side-changes.md`.

- **F1** `done 2.163.0` Item 1: desktop device type on `witness_devices` (ArcAid #363)
- **F2** `done 2.163.0` Item 9: desktop-witness plan amended (ArcAid #364)
- **F3** `done 2.166.0` Item 11: integrity mode, VPS-id matching, required table, evidence, admin UI, VR badge (ArcAid #370, #371; ArcAid ADR 0027)
- **F4** `ready` Item 10: room admin's live device view
- **F5** `ready` Item 12: script baseline, diff reports, preflight endpoint · needs: B5
- **F6** `ready` Items 2–7: `play_mode`, roster, `match:<id>` relay, `castcade_matches` + public keys, RESULT ingest with N signatures, ADR (Phase 5); item 8 table-readiness registry is Phase 3 and needed by C4 (ArcAid W8.1, which needs ArcAid C1)
- **F7** `ready` Item 13: runner stage · needs: D3
- **F8** `idea` Item 11, the part left out of 2.166.0: ROM→VPS game map `GET /api/witness/roms` seeded from VPS, so B8 can stop shipping the seed (ArcAid W12) · spec: docs/arcaid-side-changes.md §11
- **F9** `done 2026-10-23` Item 14: ArcAid reads `engine` on the score, Sanctioned rule `engine`, live tilt preferred, Integrity panel "In the game" (ArcAid 2.168.0, PR #377, merged by the owner)

## G. Arcade (Phase 6)

Lane: `arcade/**`. Needs no VPX; can overlap with anything.

- **G1** `idea` Import-a-ROM: hash, core allowlist, memory map (RetroAchievements seed), verification read via RetroArch UDP, registry
- **G2** `idea` Launch profiles + poller; gate: 4-player Galaga match, all four scores captured · needs: G1
- **G3** `idea` Confirm RetroArch UDP `READ_CORE_MEMORY` during netplay on the current release; FBNeo 4-client stability

## H. Docs, process, CI

Lane: `docs/**`, `.claude/**`, `WORK.md`, `CHANGELOG.md`, `tools/**`, `.github/workflows/ci.yml`.

- **H1** `done` Single work tracker + board + `/work` and `/wrap` (ADR 0006), 2026-10-21
- **H2** `ready` `CHANGELOG.md` back-fill detail for 0.2.0–0.2.3 from the release notes on GitHub (the seed entry lists them in one line each)
- **H3** `idea` Protocol prose for A2/A3 before the code — a WebSocket paragraph under the existing "Host transfer" section and a new "Reconnect" section (resume from the log head, not a fresh HELLO) in `protocol/docs/prose.md`, then `npm run protocol:generate` (SPEC.md is generated)
