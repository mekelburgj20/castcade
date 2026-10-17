# Castcade × ArcAid — integration gap analysis and revised design

**Status:** Current (2026-10-17). Supersedes `remote-two-player-design-handoff.md` wherever the two disagree.
**Read with:** `../decisions/0001`–`0004`, `table-import-and-patching.md`, and in the ArcAid repo
`docs/vpx-desktop-witness-plan.md` (the desktop Witness plan Castcade now absorbs).

## 1. Why this document exists

The handoff design was written without knowledge of ArcAid's state. ArcAid is at v2.160.0 (2026-10-02)
with a field-proven AtGames cabinet Witness (ADR 0020–0022), Throwdowns (ADR 0018), Live Events
(ADR 0017), a device-token pairing protocol, and a fully designed (unbuilt) desktop VPX Witness.
Roughly half of what the handoff proposed to build already exists or is already researched, and two
of its "decided" assumptions are wrong. This document records both, then states the revised design.

## 2. What the handoff got right — unchanged

- **Architecture B**: parallel 1-player games with turn coordination. State transfer (VPX Duo style) stays v2.
- **Peer-hosted**: the host player's companion is arbiter and stream forwarder; ArcAid does signaling
  and results only. ArcAid prod is a 1.9 GiB-RAM Hetzner box; server-side media is not an option.
- **Protocol-first, N-player from day one, fake client for Linux CI, gated phases.**
- **Never bundle** VPX, VPinMAME, RetroArch, FBNeo, ROMs or tables.
- **Arcade mode drives RetroArch netplay** rather than building netplay.
- **GPLv3** for this repository.

## 3. What it got wrong or did not know

| # | Handoff assumption | Reality (ArcAid source) | Consequence |
|---|---|---|---|
| 1 | "VPX 10.8 plugin SDK"; Phase 0 = a C++ plugin | **VPX 10.8.0 has no plugin system.** Plugins exist only in the 10.8.1 prerelease (`VPinballX_BGFX`), API self-declared unstable, already broke superhac's score-server. Owner ruling 2026-08-30: 10.8.0 only, no plugin tier. (`ArcAid/tmp/vpx-desktop-witness/FINDINGS-D1-research-synthesis.md` §2; `ArcAid/docs/vpx-desktop-witness-plan.md` §2) | ADR 0001: script hook, plugin deferred |
| 2 | Build `rommaps/`, a crowd-sourced RAM map corpus | `tomlogic/pinmame-nvram-maps` (ODbL, ~1,500 ROMs) already has a `game_state` block: per-player scores, **current ball, player up, game-over flag**. Proven to decode on the owner's rig (tftc_400, ij_l7). VPX 10.8.0's shared `scripts/core.vbs` line 2457 already calls `Controller.ChangedNVRAM` every frame into a `NVRAMCallback` hook. | Consume the corpus; `rommaps/` becomes `fixtures/` |
| 3 | "Stern SAM" ROMs covered by RAM maps | SAM/SPIKE ROMs (acd, bdk, mtl, trn, twd) are mapped but have **no `game_state`**. | Modern Sterns have no ball-end signal in v1 |
| 4 | Companion reads the game from outside | `VPinMAME.Controller` and `B2S.Server` are InprocServer32: **no external process can read a live game**. In-process means plugin, script, or COM shim; the Witness plan dropped the COM shim (UAC, AV, x86/x64). | All live reads go through injected VBScript |
| 5 | Lobby = a new "ArcAid Challenge" | **Throwdown** already is that: a `tournaments` row, `format='event'`, `game_room_id IS NULL`, one round, `throwdown_code` at `/throwdown/:code`, clock via `EventScheduler.tick`, standings via `EventResultService.computeStandings`, frozen `event_result`, rematch, Global fan-out. "Duels" is committed roadmap item 3 ("Throwdown is the seed, ~80% of the plumbing"). Gap: no roster (anyone with the link may submit). | ADR 0002 |
| 6 | ArcAid issues identity/signing keys to clients | Pairing exists (Witness): `POST /api/me/witness/pairing-code` then `GET /api/witness/pair` yields a 32-byte token, SHA-256 at rest, valid until revoked. **No signing keys**, no desktop OAuth (no PKCE, device code or loopback). `witness_devices` is keyed on `atgames_unique_id` with no type column. | Pairing code is the desktop login; companion-generated Ed25519 key registered at pairing |
| 7 | A `RESULT` webhook | `score_history.source` has five values with fixed meanings (ADR 0022: never reuse one). Castcade needs a sixth. Doctrine: **badge, never gate**. | ArcAid work item 5 |
| 8 | WebSocket signaling available | socket.io exists but is **server-to-client only**; no client relay, no match channel; Throwdowns get no push (the page polls every 20 s). | ArcAid work item 4 |
| 9 | "ArcAid has a paid tier", so a subscription gate for hosting | **No paid tier, no billing code.** | Gate dropped |
| 10 | Audience: cabinets, desktops or VR, unknown | The live tester runs VPX on an **AtGames ALP cabinet** under the closed Linux Legends Unchained fork. **Castcade cannot run there.** The owner's rig is desktop VPX 10.8.0 in VR; RTX runs a "Weekly Grind - VR" tournament; "the RTX use case is stream-night driven". | v1 audience = Windows desktop/VR VPX |
| 11 | (absent) | **Code signing / SmartScreen** is the #1 adoption killer for a Windows download (Witness plan §8). | Cert budgeted before Phase 2 ships |
| 12 | (absent) | Clean-run integrity (ball-1 restart via NVRAM game-count deltas) is a Duels requirement. | Castcade gets it nearly free |
| 13 | Repo `quarterd` | Repo is `castcade`. | none |
| 14 | Table identity via hashes only | `global_games.vps_id` exists (indexed, not unique); no checksum or ROM column anywhere ("Manifest adoption" is open ArcAid Tier 1 work). | `HELLO` hashes stay companion-side; ArcAid stores them on the match record |

## 4. Owner rulings, 2026-10-17 (ADRs 0001–0004)

1. **Script hook on VPX 10.8.0; no plugin in v1.**
2. **A Castcade match is a Throwdown with `play_mode='castcade'`**, never a new entity. Code says *Throwdown*, not *Challenge*.
3. **One desktop app. Castcade uses Arcaid Witness.** The Windows desktop Witness producer ships inside the companion from this repo; the cabinet C++ app and the server contract stay in ArcAid. First shippable release = desktop Witness basic mode.
4. **Per-table "Import a table" patching is the primary integration path.** The shared `core.vbs` patch is kept as a forced-choice setup-wizard opt-in (bulk Witness scoring), re-offered by a contextual nudge. See `table-import-and-patching.md`.

## 5. Revised architecture

```
 Player PC                                        ArcAid (arcaid.app)
 +------------------------------------------+     +-------------------------------+
 | Castcade companion (Electron + TS)       |     | Throwdown  play_mode=castcade |
 |  patcher  import > classify > recipe >   |     | roster (invite/accept)        |
 |           sidecar > verify > registry    |<--->| match:<id> signaling relay    |
 |  witness  pair . process watch . .nv /   |     | /api/witness/* (pair, report, |
 |           VPReg decode . journal tail    |     |   checkin, heartbeat, score)  |
 |  match    host arbiter + log . client .  |     | source='castcade' +           |
 |           turn lock . HELLO hashes .     |     |   castcade_matches            |
 |           ball-end detector (pure fn)    |     | table-readiness registry      |
 |  media    capture . encode . WebRTC .    |     +-------------------------------+
 |           voice mesh . DMD/score overlay |              ^ signaling + results only
 |  launch   VPX / RetroArch, preflight     |              | (kilobytes per match)
 +---------------^--------------------------+              |
                 | journal file (tail)                     |
 +---------------+--------------------------+     peer PCs <---- WebRTC video via host,
 | VPX 10.8.0  table.vpx + table.vbs sidecar|                     Opus voice mesh
 |   castcade.vbs library (ExecuteGlobal)   |
 |   VPM: UseVPMNVRAM + NVRAMCallback       |
 |   original: AddScore/EndOfGame hooks     |
 |   _KeyDown/_KeyUp wrap = turn lock       |
 |   [opt-in] core.vbs one-line bulk patch  |
 +------------------------------------------+
```

**Journal file = the product boundary.** Vocabulary shared with the cabinet scoreserver:
`table_loaded`, `game_start`, `current_scores`, `ball_end`, `game_end`, plus `nvram_delta` for VPM tables.
The in-VPX producer is swappable (sidecar today, a 10.8.1+ plugin later) with the companion unchanged.

**Turn lock** lives in the sidecar: `_KeyDown`/`_KeyUp` swallow flipper, plunger and nudge keys while a
companion-written lock file says "not your turn". Fallbacks to verify in Phase 0: OS-level key hook,
`Controller.Pause` (risky: a drain while the ROM is paused desyncs it), overlay only.

**Integrity in v1** = companion + the opponent's live video + the match log signed by every participant.
A modified companion can lie; the plugin-verified-grant tier is deferred with the plugin. This is the
same level the handoff already accepted, stated honestly.

## 6. Phases and gates

| Phase | Build | Gate |
|---|---|---|
| **0 Spike** (owner's rig) | (a) live NVRAM capture = ArcAid Witness Round A / T7 (`ArcAid/tmp/vpx-desktop-witness/SETUP-T7.md`, staged; it IS a per-table sidecar patch) (b) same sidecar on one JPSalas-pattern original: hook `AddScore`/`EndOfGame` (c) script-side turn lock via `_KeyDown` wrap, keyboard + keyboard-encoder cabinet (d) VPX window capture + hardware encode at 720p30 (e) confirm same-basename sidecar `.vbs` auto-loads on 10.8.0 Windows | ball 1→2→3 + game-over live on one WPC + one Data East table; score + game-end on one original; flippers dead under lock; capture < 5% frame cost |
| **1 Protocol + host mode** (Linux CI) | `protocol/` schemas; host arbiter + append-only log + `HOST_TRANSFER`; client state machine; `fakeclient/`; Ed25519 keypair per companion | 4 fake clients finish a 3-ball match with correct rotation, one forced host transfer, matching log hashes |
| **2 Companion shell + Witness basic mode**, the **first shippable** | Electron app; pairing-code login; process watch; `.nv` + `VPReg.stg` decode with bundled maps (ODbL attribution); report/checkin/heartbeat/score; tray; per-user installer; **signing cert acquired** | last-game scores land on a room board / Global with the AW badge; clean-machine install passes SmartScreen |
| **3 Import-a-table + detector + turn lock** | `patcher` pipeline; recipes VPM / JPSalas original / Scorbit-anchored; `castcade.vbs`; journal tailer; ball-end detector as a pure function with `fixtures/`; turn lock + overlay; `HELLO` = hash(original `.vpx`) + recipe version + sidecar hash; readiness shared to ArcAid; bulk mode (wizard + nudge, `core.vbs` patch, self-heal, chaining guard) | 100 ball ends across 5 tables (at least one original), 0 missed / 0 false, replayed in CI; 20 owner tables import unattended, 80%+ auto-classified; 2-PC match with fakeclient host completes |
| **4 Streaming + voice** | WebRTC video through the host, Opus mesh, push-to-talk, DMD + STATE overlay, upload test, STUN + optional TURN | 4 real PCs: delay < 400 ms, voice both ways, host upload < 9 Mbps |
| **5 ArcAid integration** (ArcAid repo) | see `../arcaid-side-changes.md` | a Throwdown created on arcaid.app runs end to end; result on the Throwdown page and Global; beta with one community |
| **6 Arcade** | import-a-ROM: hash, core allowlist, memory map (RetroAchievements seed), verification read via RetroArch UDP, registry; launch profiles; poller | 4-player Galaga match, all four scores captured |

Phases 1 and 6 need no VPX and can overlap with 0. Phase 2 is the first public artifact and burns down
installer and signing risk. The desktop device-type tweak in ArcAid lands with Phase 2; the rest of
Phase 5 after Phase 3. Bulk mode is not on the streaming critical path; if Phase 3 runs long, it slips.

## 7. Open questions carried forward

- `Controller.NVRAM` index vs on-disk `.nv` offset alignment (Phase 0a / T7).
- Same-basename sidecar auto-load on 10.8.0 Windows without a prompt (Phase 0e); else `importvbs` copy.
- Script-side turn lock coverage: keyboard encoders and nudge keys yes; DirectInput gamepads/plungers are read outside the script (fallbacks above).
- Classification coverage over the owner's 134 tables (3 originals, ~98% VPM) and a VPW/JPSalas-heavy collection; dormant Scorbit anchors as insertion points.
- SAM/SPIKE `game_state` maps: contribute upstream or declare unsupported in v1.
- Extra ball: ball-in-play and player unchanged, detector must not fire; needs a fixture.
- RetroArch UDP `READ_CORE_MEMORY` during netplay on the current release; FBNeo 4-client stability.
- VPX Duo's modified VPinMAME64.dll source (v2 only).
- Code-signing certificate: budget and vendor before Phase 2 ships outside the test group.

## 8. Where the evidence lives

ArcAid's desktop-Witness evidence is gitignored: `C:\code\repos\ArcAid\tmp\vpx-desktop-witness\`
(FINDINGS-D0 to D3, `SETUP-T7.md`, `t7-sidecar/`, `decode-live.py`, `parse-nv.py`, cloned
`pinmame-nvram-maps`, `vpxtool`). The ArcAid project memory entry `project_vpx_desktop_witness.md` points there.
