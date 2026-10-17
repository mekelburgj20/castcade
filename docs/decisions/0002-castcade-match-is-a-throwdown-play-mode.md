# ADR 0002 — A Castcade match is a Throwdown play mode

**Status:** Accepted (2026-10-17)
**Owner rulings:** 2026-10-17 (Castcade lobby = Throwdown + play mode, not a new "Challenge" entity).
**Related:** ArcAid ADR 0017 (Live Event format), ArcAid ADR 0018 (Throwdowns are room-less), ArcAid ROADMAP "Duels" (competitive-gap item 3).

## Context

The handoff design names the lobby "an ArcAid Challenge" and lists it as a new entity: invite code,
participants, time limit, result storage, its own page. ArcAid already has almost all of it.

A **Throwdown** (ArcAid ADR 0018, v2.136.0) is a row in `tournaments` with `format='event'`,
`game_room_id IS NULL`, `checkin_required=0`, one round, `aggregate_method='best'`, and a cron-free
cadence so the rotation scheduler leaves it alone. It is addressed by an 8-character
`throwdown_code` (alphabet without 0/O/1/I/l, chosen to be read aloud on streams) at
`/throwdown/:code`. Relevant ArcAid code:

- `src/services/ThrowdownService.ts` (`create`, `allocateCode`, `getByCode`, `listForCreator`;
  duration 5 minutes to 7 days), `src/services/ThrowdownScoreService.ts` (`submit`, `rankFor`).
- Routes in `src/api/routes/global.ts` ~L1906–2071: `POST /api/throwdowns`,
  `GET /api/throwdowns/:code`, `POST /api/throwdowns/:code/scores`, `GET /api/me/throwdowns`.
- Columns from migration 165: `tournaments.throwdown_code`, `rematch_of_tournament_id` (partial
  UNIQUE index: first click on "rematch" wins), `created_by_user_id`. Migration 164 made
  `score_history.game_room_id` nullable.
- Lifecycle: created already ACTIVE; `src/engine/EventScheduler.ts` `tick()` closes the round after
  `end_grace_sec`; `finishCompletedEvents` freezes standings into `tournaments.event_result`
  (identity-stable rows only), sets `event_finished_at` and `is_active=0`.
- Scores: `checkThrowdownSubmission` in `src/services/EventSubmissionGate.ts` enforces the window;
  `ScoreHistoryService.log` writes `score_history` only; `GlobalScoreService.fanOutAutomatedScore`
  publishes to the Global Scoreboard (ArcAid ADR 0023).
- Standings: `EventResultService.computeStandings` (`best`/`sum`/`average`, tie-break on higher
  single-round best then earlier timestamp).
- Front end: `admin-ui/src/pages/ThrowdownDetail.tsx` wraps `EventDetail.tsx`.

What a Throwdown lacks that a Castcade match needs:

1. **A fixed roster.** Anyone with the link who is logged in may submit; there is no invite/accept
   step. `tournament_participants(tournament_id, user_id, checked_in_at, source, added_by)` exists
   (migration 163) but Throwdowns do not use it.
2. **Realtime.** `EventDetail.tsx` polls every 20 s; `EventScheduler` emits `leaderboard:updated`
   only for events with a room, so Throwdowns get no push at all. There is no client-to-client
   relay anywhere in `src/api/websocket.ts`.
3. **A match record.** Hashes from `HELLO`, the append-only log hash, per-participant signatures
   and host transfers have nowhere to live.

ArcAid's committed roadmap item **Duels** ("challenge/accept 1v1 with a clock, matchmaking on shared
tables... Throwdown is the seed, ~80% of the plumbing", LAUNCH.md Tier 4) is precisely gap 1 plus
matchmaking plus a clean-run integrity tier. ArcAid ADR 0018 explicitly warns that a parallel
implementation of the event machinery is the mistake the Throwdown design exists to avoid.

## Decision

### 1. A Castcade match is a Throwdown with `play_mode='castcade'`

ArcAid adds `tournaments.play_mode` (`'score'` default, `'castcade'`). Creating a Castcade match
creates a Throwdown; its code is what the companion picks up; its page is where the result shows.
The clock, gate, standings, frozen result, rematch and Global fan-out are reused unchanged.

### 2. The roster is the Duels roster

Invite/accept writes `tournament_participants` rows (a new `source='invite'`), and the submission
gate requires roster membership when `play_mode='castcade'`. This is built once and serves Duels.

### 3. Signaling is a relay channel, nothing persisted

`src/api/websocket.ts` gains `join:match` (JWT or device token, roster check) and a `match:relay`
handler that forwards WebRTC offers, answers and ICE candidates to the other members of
`match:<id>`. A few messages per match, then idle. ArcAid never sees media.

### 4. Results land as scores plus a match record

Each participant's final score is a `score_history` row with the new `source='castcade'` (ArcAid
ADR 0022 doctrine: never reuse a source whose meaning differs), engine `vpx`, device per the
player's rig. Standings decide the winner exactly as for any Throwdown. A new `castcade_matches`
table holds `tournament_id`, `host_user_id`, `table_hash`, `rom_name`, `rom_hash`,
`settings_hash`, `recipe_version`, `sidecar_hash`, `log_hash`, `signatures` (JSON),
`host_transfers`, timestamps. Mismatching signatures are stored and badged `flagged`, never
rejected (badge, never gate).

### 5. Naming rule in Castcade code and docs

Where the handoff doc says "ArcAid Challenge", read and write **Throwdown**. Roles stay host /
client; the turn token stays grant.

## Consequences

### Easier
- No new lobby entity, page, clock or result pipeline; the Throwdown page gains a Castcade block.
- The roster, relay and `play_mode` work is the first slice of Duels, so Castcade advances the
  ArcAid roadmap instead of forking from it.
- Rematch, share codes and Global publishing come for free.

### Harder
- Castcade's ArcAid-side work must respect event semantics (one round, window, grace) rather than
  define its own; a multi-game "best of N" match is N rounds of one event, not a custom format.
- `score_history.source` grows a sixth value; the agent-verified touch list is in
  `docs/design/arcaid-integration-gap-analysis.md` finding 6 and `docs/arcaid-side-changes.md`.

### Locked out
- No `challenges` table, no `/challenge/:code` route, no second clock implementation.
- No Castcade result path that bypasses `EventResultService`.

## Alternatives rejected

- **New "Challenge" entity as the doc specifies.** Duplicates the Throwdown's clock, gate,
  standings and result code, exactly what ArcAid ADR 0018 forbids.
- **Build Duels first, then Castcade on Duels.** Cleanest end state, but Castcade would wait on a
  whole ArcAid arc; the chosen path builds the shared slice (roster, play mode) now and leaves
  matchmaking and brackets to Duels.
- **Room-scoped events only.** A match between friends from different rooms needs the room-less
  Throwdown; a room-scoped match can still be created later by giving a room event the play mode.
