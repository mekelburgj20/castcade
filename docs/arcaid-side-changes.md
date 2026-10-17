# ArcAid-side changes for Castcade

> **Written for an agent working in `C:\code\repos\ArcAid`.** Castcade (this repo, GPLv3) never
> contains ArcAid code; everything below lands in the ArcAid repo as ordinary PRs under its own
> rules (Docker-first, `SPRINT_STATUS.md` cadence, migrations claimed in `database.ts`, build before
> commit). **The owner pastes these into ArcAid's `ROADMAP.md` / `LAUNCH.md` when they choose; this
> file is the hand-off, not a scheduling decision.** Facts and file paths were verified against
> ArcAid at v2.160.0 on 2026-10-17; re-check line numbers before editing.
>
> Design context: `docs/design/arcaid-integration-gap-analysis.md`, ADRs 0002–0004 in
> `docs/decisions/`, and `docs/design/table-import-and-patching.md` (the desktop-Witness import
> design, which this list's item 9 points ArcAid's own plan at).

Ordering follows the Castcade phase that needs each item. Items 1 and 9 are the only ones needed
before Castcade's first shippable release (Phase 2).

| # | Change | Castcade phase | Size |
|---|---|---|---|
| 1 | Desktop device type on `witness_devices` | 2 | small |
| 9 | Amend `docs/vpx-desktop-witness-plan.md` | 2 | docs |
| 8 | Table-readiness registry | 3 | medium |
| 2 | `tournaments.play_mode` | 5 | small |
| 3 | Roster (invite/accept) — the Duels roster | 5 | medium |
| 4 | `match:<id>` relay channel | 5 | small–medium |
| 5 | `source='castcade'` + `castcade_matches` + public keys | 5 | medium |
| 6 | `RESULT` ingest with N signatures | 5 | medium |
| 7 | ArcAid ADR 0025 | 5 | docs |

## 1. Desktop device type on `witness_devices`

**What.** `witness_devices` is keyed on `atgames_unique_id` and has no type column. Add
`device_type TEXT NOT NULL DEFAULT 'atgames'` (`'atgames'` | `'desktop'`), allow a non-AtGames
device id (a companion-generated UUID, stable per install), and let the pairing route accept both.
`EventLobbyService.roster` and the heartbeat rules should treat a desktop device like a cabinet
(a desktop that has ever heartbeated and is silent > `HEARTBEAT_STALE_SEC` reads `offline`).

**Where.** `src/services/WitnessService.ts` (pairing, `authenticateDevice`), routes in
`src/api/routes/global.ts` ~L161–402 (`GET /api/witness/pair?code&device&username` and the
`/me/witness/devices` list/PATCH/DELETE), a new migration in `src/database/database.ts` (claim the
next free number), `src/services/EventLobbyService.ts` (`no_cabinet` copy becomes device-neutral),
`admin-ui/src/pages/AccountSettings.tsx` paired-devices list (label the type).

**Size.** Small: one column, one id-shape relaxation, one label. **Needed by:** Castcade Phase 2
(the companion pairs as a witness device before any netplay exists).

## 2. `tournaments.play_mode`

**What.** `play_mode TEXT NOT NULL DEFAULT 'score'` (`'score'` | `'castcade'`). `POST /api/throwdowns`
accepts it; `GET /api/throwdowns/:code` returns it; the Throwdown page renders a Castcade block
(roster, match state, result) when set. Validate: a `castcade` Throwdown is exactly one round,
its game resolves to a catalogue entry (`global_games.id`), and it carries a roster (item 3).

**Where.** Migration; `src/services/ThrowdownService.ts` (`create`), `src/api/routes/global.ts`
~L1906–2071, Zod schema in `src/api/schemas.ts`, `admin-ui/src/pages/ThrowdownDetail.tsx` /
`EventDetail.tsx`.

**Size.** Small. **Needed by:** Phase 5.

## 3. Roster: invite / accept (this IS the Duels roster)

**What.** Throwdowns have no roster today: anyone with the link who is logged in may submit.
Reuse `tournament_participants(tournament_id, user_id, checked_in_at, source, added_by)`
(migration 163) with a new `source='invite'` (the CHECK currently allows `checkin`, `qualifier`,
`admin`). Routes: invite by `@username` (the `@`-resolution contract from v2.141.0), accept,
decline, withdraw. `checkThrowdownSubmission` in `src/services/EventSubmissionGate.ts` requires
roster membership when `play_mode='castcade'` (unchanged for `'score'`). Identity resolved via
`IdentityLinkService.resolveCanonical` on write and read, as events already do.

**Where.** Migration (CHECK rebuild on `tournament_participants.source`), `src/services/EventService.ts`
(`listParticipants`, `isParticipant` already exist), `EventSubmissionGate.ts`, `global.ts` routes,
`ThrowdownDetail.tsx`.

**Size.** Medium. **Needed by:** Phase 5; also unblocks ArcAid's own Duels item (LAUNCH.md Tier 4).

## 4. `match:<id>` relay channel

**What.** `src/api/websocket.ts` has only `join:game` / `join:lobby` / `join:room` and server→client
events; there is no client-to-client relay. Add `join:match` (auth: the JWT in
`handshake.auth.token` OR a witness device token; roster check against item 3) and `match:relay`
that forwards an opaque payload (WebRTC offer / answer / ICE candidate) to the other sockets in
`match:<tournamentId>`. Nothing is persisted; rate-limit per socket; refuse before the roster
exists or after `event_finished_at`.

**Where.** `src/api/websocket.ts` (beside `canJoinRoomChannel`), `src/api/rateLimit.ts`.

**Size.** Small–medium. **Needed by:** Phase 5 (Phases 1–4 use a direct host address or a
dev relay in the Castcade repo).

## 5. `source='castcade'`, `castcade_matches`, participant public keys

**What.**
- A migration handler calling `rebuildScoreHistorySource(db, {label, newValue:'castcade', values:[…]})`
  in `src/database/migrations/rebuildScoreHistorySource.ts`, the way `scoreHistorySourceVpx.ts`
  (172) and `scoreHistorySourceAtgames.ts` (167) do; update the base `CREATE TABLE` CHECK at
  `database.ts` L192.
- Touch list (agent-verified 2026-10-17): the `source` unions in `ScoreHistoryService.log` (~L151)
  and `GlobalScoreService` (~L225, ~L390 — keep `'sync'` rejected); `AutoScoreSuppressionService`
  `AutoScoreSource` / `isAutoScoreSource` (a Castcade row is auto-posted and therefore self-deletable
  with a tombstone, ADR 0024); `WitnessVerifyService` L192 (`atgames || vpx` → include `castcade`);
  the `source IN` lists in `src/api/routes/rooms.ts` L2543 and L7407;
  `admin-ui/src/lib/provenanceDisplay.ts` `isWitnessedScore` (badge). `global_scores.source` is free
  text since migration 174.
- New table `castcade_matches(id, tournament_id, host_user_id, table_hash, rom_name, rom_hash,
  settings_hash, recipe_version, sidecar_hash, log_hash, signatures JSON, host_transfers INTEGER,
  created_at, finished_at)`. No FK cascade from `tournaments` (an audit record that outlives its
  tournament, like `maintenance_runs`).
- `witness_devices.public_key` (Ed25519, base64url) registered at pairing or on first `HELLO`;
  ArcAid issues no keys itself.

**Where.** `src/database/database.ts` + `src/database/migrations/`, the services and routes above.

**Size.** Medium. **Needed by:** Phase 5.

## 6. `RESULT` ingest with N signatures

**What.** A device-authenticated route (GET, to match the witness family, or POST if the companion
is the only caller — decide in the PR) that accepts the host's `RESULT`: per-participant final
scores, `log_hash`, `signatures[]`. For each participant write a `score_history` row
(`source='castcade'`, engine `vpx`, device from the companion's declared rig, `created_at` = the
match's game-over time threaded through `ScoreHistoryService.log`'s `createdAt`) via
`checkThrowdownSubmission` → `ScoreHistoryService.log` → `GlobalScoreService.fanOutAutomatedScore`,
then insert the `castcade_matches` row. Verify every signature over `log_hash` against the stored
public keys; a mismatch or a missing signature is **stored and badged `flagged`, never rejected**
(badge, never gate — ArcAid ADRs 0020/0021). Standings come from `EventResultService` unchanged.

**Where.** New service `src/services/CastcadeResultService.ts`, route in `global.ts` beside the
witness routes, verdict surfaced through `WitnessVerifyService` so the Throwdown page's existing
badge renderer shows it.

**Size.** Medium. **Needed by:** Phase 5.

## 7. ArcAid ADR 0025 — "Castcade matches are Throwdowns"

**What.** Record the decision on the ArcAid side in ArcAid's own ADR series (next free number 0025
as of 2026-10-17; recent style: `# ADR NNNN — Title`, `**Status:**`, Context / Decision /
Consequences), cross-linking Castcade ADR 0002 and ArcAid ADR 0018. Add the row to
`docs/decisions/README.md`.

**Size.** Docs. **Needed by:** Phase 5 (write it with the first Phase 5 PR).

## 8. Table-readiness registry

**What.** ArcAid's ROADMAP ("VPX score ingestion") already plans a GLOBAL scorability table seeded
from the Legends Unchained manifest `romVersion` × the maps corpus. Shape it so the companion can
report per-table outcomes keyed on `global_games.id` + `recipe_version`:
`witness_live_ready` / `castcade_ready` / `unsupported(reason)`, with a count of distinct reporting
devices, so the Throwdown page and the companion's import screen can say "N players verified this
table". Device-authenticated GET, idempotent per (device, game, recipe). `castcade_matches` records
`recipe_version` + `sidecar_hash` (item 5).

**Where.** Wherever the scorability table lands (not built yet; ROADMAP item), a route beside the
witness routes, a read endpoint for the public Throwdown page.

**Size.** Medium. **Needed by:** Castcade Phase 3 (registry sharing); optional for Phase 5.

## 9. Amend `docs/vpx-desktop-witness-plan.md`

**What.** Three edits so the two plans stop drifting: (a) §4 "Live mode": gains two install paths —
per-table *Import a table* (primary; also covers originals) and the shared `core.vbs` patch as a
setup-wizard **forced-choice** opt-in bulk mode (Castcade ADR 0004); (b) §4 and §6: the Windows
desktop producer ships inside the Castcade companion from `C:\code\repos\castcade` under GPLv3
(Castcade ADR 0003); the cabinet app and the server contract stay in ArcAid; (c) §6 phases P2–P5
now map to Castcade Phases 2–3; P6 (originals) is covered by the per-table recipes. Point at
`castcade/docs/design/table-import-and-patching.md` for the import design rather than restating it.
Also add one line to ROADMAP "VPX score ingestion" arc 2 and LAUNCH.md Tier 4 "Arc 2" saying where
the desktop agent now lives.

**Where.** `docs/vpx-desktop-witness-plan.md`, `ROADMAP.md` L56–62, `LAUNCH.md` L63.

**Size.** Docs. **Needed by:** Castcade Phase 2 (before anyone builds a second desktop agent).

## Not asked of ArcAid

- No media, TURN or SFU on the ArcAid server (peer-hosted by ruling).
- No subscription or paid-tier gate (none exists in ArcAid; the handoff doc's assumption was wrong).
- No new "Challenge" entity, page or clock (ADR 0002 / ArcAid ADR 0018).
- No change to the cabinet Witness app for Castcade.
