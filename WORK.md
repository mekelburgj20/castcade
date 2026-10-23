# Castcade — Work

Board: https://claude.ai/artifact/2AsfpUMPfRB1yQhnirHQKd  ·  Rules: `.claude/commands/work.md`  ·  Check: `npm run work:check`

One line per item, IDs never reused. History: `CHANGELOG.md` and `git log -- WORK.md`. Design and rulings:
`docs/design/`, `docs/decisions/`. Pick an item with `/work <ID>`; end a session with `/wrap`.

## Now

- Companion 0.2.10 (unsigned PoC; repo public, keep it so). The Electron 44 / Vite 8 / vitest 5 bumps are unreleased: 0.2.11 will be the first packaged build on them (E4). ArcAid is at 2.166.1 with integrity mode live (F3 complete except item 11's ROM→VPS map endpoint, F8).
- In flight: C7 live mode (fable@main) — rig session 2 with hook 0.3.0: two games posted live, one request each, both `ingested`; journal volume down ~130x; the start-up watch/import race is fixed. Gate: three games in one session (two so far). B11 Limited attempts (companion half of ArcAid A16, ADR 0029) is next after C7.
- Order by owner ruling 2026-10-21: live mode first (C7: C2 detector → C1/C1.1 recipe A import → per-game capture → C2.1 hook volume), because basic mode posts only the last game of a session; then B4 → B5 (ArcAid half W6) → D1 solo streaming.
- Owner actions: install 0.2.11 when it is tagged, open Settings → Import tables, patch the folder, play three Monster Bash games in one session (the C7 gate) · re-pair the rig from Settings (its device row predates ArcAid #363) · a tester's clean-machine install (E1) · the F1–F2 field gate: flip a physics override on and off and check the Integrity panel (B9).
- Streaming for stream nights (D1, Phase 4a) needs nothing from Phase 3; it follows B5 (ruling 2026-10-21, supersedes the gap analysis §6 "right after F2–F3").
- Last wrap: 2026-10-21 — audit of every item against code, ADRs and the ArcAid tracker: B4, B8, C2, C3, C4, E4, F6, H3 corrected; C6 closed; F8 added.

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
- **B6** `ready` F6 engine attestation from the live hook — block 0 journals an `engine` line at game start and each ball start (`NudgeGetCalibration` gains/maxima/dead zone/tilt sensitivity, the table object's `GlobalDifficulty`/`SlopeMin`/`SlopeMax`/`Difficulty`, flipper strength/return), the detector carries it on the capture as `engine` evidence, ArcAid's Sanctioned rule compares every ball's values with the table file and the launch ini (a tweak-menu change mid-game flags that game); score-jump plausibility · needs: C7 · spec: docs/design/fairness-and-table-identity.md §5 ("In-game menus are the hole")
- **B7** `ready` Nudge telemetry: HID trace + lift detector, `nudge` param on the score · spec: docs/design/fairness-and-table-identity.md §5a
- **B8** `idea` ROM→VPS game map served by ArcAid with a shipped seed — today shipped only, from the vps-db index built at package time (`fetch-vps.mjs`); the server half is F8 · spec: docs/design/fairness-and-table-identity.md §8 · needs: F8
- **B9** `ready` Field gate for F1–F2's live half: the owner flips a physics override on and off and the ini values show in the Integrity panel on arcaid.app (2.166.0) · owner: owner · gate: docs/design/fairness-and-table-identity.md §7 "Gate for F1–F2"
- **B10** `idea` SAM/SPIKE `game_state` maps: contribute upstream or declare unsupported in v1
- **B11** `ready` Limited attempts, companion half (ArcAid ADR 0029 / item A16, owner ask 2026-10-22) — at every game START (live mode: the detector's `game_start`, ROM and script recipes alike) call `GET /api/witness/attempt` with the score's identity params + `started` + an opaque `key` (journal session stamp + the start's `t`); idempotent; show "Attempt n of N" / "No attempts left: this score will not count" / nothing when unlimited, and "offline: this attempt will not count" when queued; send `attempt=<key>` on that game's score (send it even after over_limit); render the new `not_sanctioned` reasons (late / over_limit / void / unreported / reused) · needs: C7 · spec: ArcAid docs/decisions/0029-limited-attempts.md · touches: companion/renderer/src/views/Status.tsx

## C. Table import, hook, detector, turn lock (Phase 3)

Lane: `vpx-hook/**`, `companion/src/patcher/**`, `fixtures/**`. ADR 0001 (script hook) and ADR 0004 (per-table import primary, `core.vbs` opt-in). Design: `docs/design/table-import-and-patching.md`.

- **C1** `done main` Import-a-table pipeline (`companion/src/patcher/`): `.vpx` script extract (the CODE record), §4 classifier, sidecar render, manifest, library install, folder plan/apply/remove-all, stale guard; recipe A only — originals wait on C1.1 · spec: docs/design/table-import-and-patching.md
  - **C1.1** `ready` Recipes B (JPSalas original), C (Scorbit-anchored), D (ScoreServer), E (generic) — recipe A (VPM) shipped with C1; the classifier already tells the classes apart and the folder import skips them with the reason · spec: docs/design/table-import-and-patching.md §5
  - **C1.2** `idea` Classification coverage check over the owner's 134 tables and a VPW/JPSalas-heavy collection
- **C2** `done main` Journal tailer + detector in the companion (`journal-detector.ts`, `journal-tail.ts`); the three Phase 0 fixtures replay in vitest to what `fixtures/check.py` asserts; lands in 0.2.11
  - **C2.1** `done main` Phase 0 findings absorbed: journal volume (hook 0.3.0 `Castcade_WatchBytes`: watched offsets only, coalesced per 50 ms, one snapshot at hook time — from 89 lines/s to a few per score change), boot-garbage gate and exit mid-game (detector C2); bonus-after-ball_end documented in `detectTransition` · spec: docs/phase-0-spike.md §8
  - **C2.2** `ready` Extra-ball fixture: ball-in-play and player unchanged, detector must not fire
- **C3** `ready` Turn lock + overlay, companion half — write the lock flag from the match engine's grant, the overlay, analog-plunger fallback (open case, spike §8 0c); the `_KeyDown` wrap itself shipped in hook 0.1.0 (Phase 0c pass 2026-10-17) · needs: C2
- **C4** `ready` Fill `HELLO`'s `GameFingerprint` from the import manifest — hash(original `.vpx`) + recipe version + sidecar hash; the fields exist since 0.1.0; readiness shared to ArcAid (item 8 = ArcAid W8.1, Phase 3) · needs: C1 · touches: F6
- **C5** `idea` Bulk mode: setup-wizard forced choice, `core.vbs` patch, self-heal, chaining guard — slips if Phase 3 runs long; not on the streaming path · needs: C1
- **C7** `claimed` Live mode: every game of a session posts its own score — when a table has a Castcade sidecar, the companion tails the journal, `game_end` (and `table_exit` mid-game → abandoned, spike §8 finding 8) triggers a capture decoded from the live NVRAM state, `exit_sample` stays the fallback for unpatched tables; import from Settings = the whole tables folder (ruling 2026-10-21; one table is the same flow on one file): dry-run summary first (N ROM tables to patch, M originals skipped until recipes B/C, K with an existing external `.vbs` left alone), then apply; no verification launches in bulk, a table verifies on first play; the stale-sidecar guard in three layers (ruling 2026-10-21): the manifest pins sha256(original .vpx) (§6); the companion watches the tables folder and disables or re-renders a sidecar the moment its `.vpx` changes; the companion re-hashes at launch (§6, may be late for that launch); and the sidecar itself carries the original's size + mtime, checks them at load, and on a mismatch renames itself `.stale`, journals `stale_sidecar` and tells the player "this Castcade patch is for an older version of this table — relaunch, then re-import" (VBScript cannot hash, so size + mtime is the in-script proxy) and a "remove all Castcade sidecars" button ship WITH folder import, not after; recipe A only, installs `scripts\castcade.vbs` · needs: C2, C1.1 · gate: the owner plays three Monster Bash games in one VPX session and three scores land on arcaid.app (ruling 2026-10-21: basic mode's last-game-only capture is unacceptable) · owner: fable@main · since: 2026-10-21
  Resume: rig sessions 2026-10-22 — session 1 (hook 0.2.0): two Monster Bash games posted live but ArcAid answered `duplicate` (prod showed four concurrent identical ingests per score; the companion sends one per the code, local probes and now the request log), one VPX crash on ball 3 and heavy stutter → hook 0.3.0 (C2.1). Session 2 (hook 0.3.0 + request log): journal 1,854 lines / 172 KB over 17 min (was 22.6 MB in 7 min); two games played, both posted live as ONE request each → `ingested` (2,251,670 and 228,982,910; the owner's memory of a third game is not in the journal and the score trace shows no hidden boundary); the watch/import race found at start-up is fixed (f8a07c7). Left: the gate wants three games in ONE session (two so far) — one more session, quick drains are fine; the owner's word on stutter; then tag 0.2.11 (unpacked build with the fix is in companion/release/win-unpacked).
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
- **E4** `ready` Electron 44 / Vite 8 / vitest 5 follow-through — `pack:dir` + `Castcade.exe --smoke` passed 2026-10-21 on main (f58adee; `resources/hook/castcade.vbs` ships); left: tag 0.2.11 (`/release-docs 0.2.11`) and a real install on the owner's rig before testers hear about it

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
