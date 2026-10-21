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
| 10 | Room admin's live device view (who is reporting in, where scores route) | 2–3 | small–medium |
| 11 | Integrity mode (Open / Sanctioned), VPS-id matching, per-game required table, evidence per score, runner review | F3 (after Phase 2) | medium |
| 12 | Script baseline + diff reports + preflight endpoint | F5 | medium |
| 13 | Runner stage: who is live, *Feature this player*, one stage URL for the runner's OBS | 4 | small–medium |

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

**Status (2026-10-18).** Done as PR #363 (`castcade/witness-device-type`, v2.163.0; approved and merging
2026-10-18), with one
addition the review settled: **provenance follows `device_type`**. `VpxScoreIngestService.provenanceFor`
is the one mapping for the room write, the Global fan-out, the Global-fallback write and the tournament
device-exclusion check: cabinet → engine `vpx` / device `atgames` / legacy platform `vpxs` (unchanged);
desktop → engine `vpx` / device `pc` / legacy platform `vpx` (`pc` even in VR: the companion cannot tell a
headset from a monitor, and the headset is a display on a Windows PC). Nothing changed on the wire; the
`type=desktop` the companion already sends is honoured once this deploys. **The companion's half** (v0.2.3):
call `GET /api/witness/checkin?device=` with the token whenever no VPX process is running (start, after every
exit, each heartbeat tick while idle), never while a table is open, and show the reply's `sendingTo`; and
send `report` at table launch (no `exit`) so the lobby shows `table_open` during a game and tier-1 verify has
a live session row, then the exit report on the same `(device, table, launch)` key. Without the check-in a
desktop sits at `no_checkin` in every event lobby, because `ready` requires a check-in since the window opened
and the lobby never reads `device_type` (owner ruling: strict on purpose).

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

## 10. Room admin's live device view (owner ask, 2026-10-18)

**What.** A view for the people who run a room's tournaments (ArcAid's `game_room_admins`, roles
`owner`/`admin`; there is no "tournament director" role, the room admin is the runner) that shows, near
real time, every paired Witness device belonging to a room member that is reporting in: player, device
label and type (cabinet / desktop), online (heartbeat within `HEARTBEAT_STALE_SEC`), last check-in, the
table open right now (an open `witness_observations` session row), and **where that device's scores are
routed** (the P9b designation: this room + tournament, this room any matching game, undesignated → event
rounds only, Global fallback on/off). For an **event** tournament this is the lobby seen from the runner's
side: how many players are checked in and `ready` right now, who is `table_open`, who is `no_checkin` or
`offline`, so the runner knows when to start. The data already exists (`EventLobbyService.roster` computes
the per-player status for the player-facing lobby; `WitnessService.describeTarget` words the routing), so
this is mostly a new aggregation endpoint scoped to the room plus a page/tab, polled every ~20 s like
`EventDetail` or pushed on the existing `room:<roomId>` socket channel.

**Where.** `src/services/EventLobbyService.ts` (reuse `roster`), `src/services/WitnessService.ts`
(`describeTarget`), a new admin route under `src/api/routes/rooms.ts` gated on room admin, a tab on the
room's admin page and a "Lobby" panel on `EventDetail.tsx` for admins.

**Size.** Small–medium. **Needed by:** Castcade Phase 2 testing (the first event run with desktop
devices) and every event after it. Privacy note: only room admins see it, only for members of their room,
and it shows what the device already reports (table names and timestamps), nothing from the player's PC.

## 11. Integrity mode: Open play / Sanctioned play (owner ruling 2026-10-18, Castcade ADR 0005)

> **Status 2026-10-20:** the backend half is **ArcAid PR #370** (v2.165.0, ArcAid ADR 0027) — migration 184, the
> rules as a pure function (`src/utils/sanctionedRules.ts`), the evidence trail, the VPS-id-first match, the
> `not_sanctioned` wire status (desktops only; cabinets get `no_match`), the integrity router and the catalogue's
> per-game table list. The admin UI (tournament integrity settings, required-table picker, per-score review,
> board badges) and the ROM → VPS endpoint are the next PR. Decisions taken there that refine the text below:
> no adjustments map = *unverifiable* (skipped, never failed); the default allow-list is `['Free Play']`; a
> tournament update that omits the integrity fields keeps them; the Global fallback still applies to a refused
> score; evidence rows are written for every outcome in both modes. The same PR carries a fix found on the
> owner's rig 2026-10-20: the witness ingest never cleared the room `leaderboard_cache` (no expiry), so a Witness
> score reached the tournament's scores page but not the room board until somebody's manual submission to the
> same game flushed it; migration `185_flush_leaderboard_cache` recomputes the stale boards on deploy.

**What.** `tournaments.integrity_mode TEXT NOT NULL DEFAULT 'open'` (`'open'` | `'sanctioned'`; names
are working names, the owner may rename before this ships). Per tournament game, in Sanctioned mode:
`required_vps_table_id`, `required_rom`, `required_fingerprint` (blessed by the runner from their own
copy: the companion shows it in Status, the runner pastes or the device posts it), `require_stock_physics`,
`require_factory_adjustments`, `require_known_build`, and the accelerometer rules the runner can tune per
tournament: `min_tilt_sensitivity` (default 300, provisional; VPX's own default is 400, higher tilts sooner,
0 = analog tilt off), `max_accel_gain` (percent, default 150 = VPX default) and `require_nudge_filter`
(default off). The full rationale and field meanings are in
`castcade/docs/design/fairness-and-table-identity.md` (accelerometer rules in §5a).

**Ingest.** `GET /api/witness/score` accepts new optional params and ignores them when absent:
`vps_game`, `vps_table`, `table_sha256`, `table_save_rev` (shipped in companion 0.2.4), `ini`, `adjustments`,
`build` (shipped in 0.2.5, exact shapes below), `play_device` (0.2.10: `pc` | `vr_headset`, how the game was
displayed; ArcAid 2.166.0 puts it on the score's device axis for desktop devices, so the badge says VR headset;
absent = monitor; the companion decides "headset" when the SteamVR runtime client `vrclient_x64.dll` is loaded
in the VPX process and `vrcompositor`/`vrserver` is running, because VPX 10.8.0's VR builds turn VR on at
player start whenever OpenVR reports a headset, not from any ini key), and later `fingerprint`,
`script_sha256`, `script_diff` (a short JSON summary: counts per class plus the restricted hunks' identifiers).

As shipped by companion 0.2.5–0.2.8 (JSON strings, URL-encoded as query params; each absent when not measured):

- `ini`: `{"set":0,"set_name":null,"flippers":false,"stock":true,"difficulty":0.56,"difficulty_override":null,
  "slope":6.56,"nudge":0.0008,"legacy_nudge":false,"nudge_filter":false,"nudge_sensitivity":null,"accel":true,
  "accel_gain_x":115,"accel_gain_y":115,"accel_max_x":100,"accel_max_y":100,"accel_velocity":false,
  "analog_gain_x":1965,"analog_gain_y":1996,"tilt_sens":500,
  "tilt_sens_set":true,"options":{"Outlane Difficulty":1},"overrides":[],"table_ini":true}`
  — `set` is the table's physics-set override (0 = stock), `stock` = no set and no flipper override,
  `difficulty` the table's own (0–1), `difficulty_override` the tweak-menu value when set, `slope` the
  effective degrees, `options` the 10.8 table options by the author's names, `overrides` the other
  `[TableOverride]` keys present. Sanctioned's `require_stock_physics` reads `stock === true` and
  `difficulty_override === null`. The accelerometer keys (0.2.8): `accel` = `PBWEnabled` (null = key absent =
  VPX default on), `accel_gain_x/y` = `PBWAccelGainX/Y` in percent (VPX default 150), `accel_max_x/y`,
  `accel_velocity` = `AccelVelocityInput`, `nudge_filter` = `EnableNudgeFilter`, `tilt_sens` = the
  `TiltSensitivity` VPX actually uses (stored value, else VPX's default 400; **higher tilts sooner**, 0 =
  analog tilt off), `tilt_sens_set` = whether the key was present. `min_tilt_sensitivity` reads `tilt_sens`,
  `max_accel_gain` reads both gains; both apply only while `accel !== false`. `analog_gain_x/y` (0.2.9) is
  `AnalogNudgeGainX/Y`, a key stock 10.8.0 does not have: the Panasony VR build's in-game nudge page writes it
  (the owner's rig: 1965/1996), scale unconfirmed, sent raw for the runner's eyes and read by no rule yet.
  The rest is for the runner's eyes.
- `adjustments`: `{"total":52,"items":[{"l":"Balls Per Game","v":3,"d":3},{"l":"Replay System","v":1,"t":"Fixed","d":0}],
  "non_factory":["Replay System"]}` — `v` and `d` are the stored values the map's `default` describes, `t`
  the enum/special text. Absent for the many ROMs whose map has no adjustments block (never treat absence as
  factory). `require_factory_adjustments` reads `non_factory.length === 0` and should let the runner
  whitelist labels (free play is routinely non-factory and harmless).
- `build`: `{"vpx":{"sha256":"…","version":"10.8.0.2079.Panasony","known":null,"family":"panasony"},
  "vpinmame":{"sha256":"…","version":"3, 7, 0, 222","known":null,"family":"nightly"},"cheat":false}` — `known` is
  the companion's id for an official release build (`vpx-10.8.0-2051-gl-x64`, `vpinmame-3.6.0-1227-x64`, …) or
  null. `family` (0.2.7) is `official` (proven by hash), `panasony` (the Panasony VR community builds: tag
  `.Panasony` in the exe's version resource), `nightly` (an upstream-style build number past the release with no
  builder tag; VPinMAME 3.7.x) or `unknown`. The three non-official families are read from the version resource,
  so they are declared rather than proven; Sanctioned play accepts that under the honest ceiling (§5 of the
  fairness design). **Expect `known: null` often:** VR players run community builds (the owner's rig does) and
  many run VPinMAME nightlies. `require_known_build` therefore means: `official` and `panasony` pass by default
  (**owner ruling 2026-10-19: the Panasony VR mod of VPX is allowed even in Sanctioned play**), `nightly` passes
  by default behind a runner toggle, and `unknown` passes only when the runner has blessed that hash for the
  tournament (their own, or one several devices report). Never "official only". `cheat` is VPinMAME's per-ROM
  cheat option; Sanctioned refuses `true`. `VpxScoreIngestService`: match candidates by `vps_game` against
`global_games.vps_id` **first**, falling back to today's name keys (so every v0.2.x companion keeps
working); in a Sanctioned tournament apply the per-game rules the way `engineExcluded` already refuses a
score, returning a new wire status `not_sanctioned` with `reasons: string[]` (the companion maps it to
`rejected` with the reasons in the detail). A refused score still falls through to the Global record when
the device's `globalFallback` allows it. **Store the evidence** on every score, both modes: a
`witness_evidence` table keyed by `score_history.id` (and the global row id) holding the JSON above,
so the runner can review and so Open-mode runners see what Sanctioned would have flagged.

**Runner review.** On the tournament's admin side: per score, the evidence with pass/flag per rule;
per game, the required table and the blessed fingerprint with a "bless the one I just played" button
(reads the runner's own device's latest evidence). Badges on the board: *sanctioned* when every rule
passed, *flagged* when a rule failed but the score landed (Open mode). Room boards never filter or
re-rank (ADR 0020/0021).

**Catalogue.** `global_games.vps_id` already holds the VPS game id. Add a `global_game_tables`
table (`global_game_id`, `vps_table_id`, `name`, `authors`, `version`, `table_format`) filled by
`VpsImportService` from `tableFiles[]` (it already reads the array for authors and download URLs),
so the runner's "required table" picker lists the game's tables by name, and so the companion's
TableInfo → table id resolution can be served from ArcAid (`GET /api/witness/tables?vps_game=`)
rather than shipped. Also serve the ROM → VPS game map (`GET /api/witness/roms`) seeded from VPS
`romFiles` and the maps corpus' `romnames.json`, corrected by consensus from device reports.

**Where.** Migration (claim the next free number after 183), `src/services/VpxScoreIngestService.ts`,
`src/services/VpsImportService.ts`, `src/api/routes/global.ts` (witness routes), tournament admin pages
in `admin-ui`, `EventDetail.tsx` / rotation game settings for the per-game rules.

**Size.** Medium. **Needed by:** Castcade F3 (companion F1/F2 ship first and work against today's server).

## 12. Script baseline, diff reports and preflight (Castcade F5)

**What.** Per Sanctioned tournament game, the runner uploads the baseline script from their own copy
(stored privately per tournament game, never published, deleted with the tournament; the owner to confirm
the licensing stance in `fairness-and-table-identity.md` §8). `GET /api/witness/preflight?device&vps_table&
script_sha256&fingerprint&...` answers, for the device's routed tournament, the rules that apply, the
baseline's download URL (device-token gated) and the verdict ArcAid would give for the evidence sent, so the
companion can show "will count / will not count, because …" before ball one. `GET /api/witness/score`
carries `script_diff`; the runner review shows the classified hunks; a per-tournament setting
`diff_reports_visible_to: 'runner' | 'participants'` (default runner) controls who else sees them.
Unknown hunks the runner approves are stored against the baseline so the next player is not asked.

**Where.** Same files as item 11 plus a small upload route and storage for baselines (text, ~100–500 KB).

**Size.** Medium. **Needed by:** Castcade F5.

## 13. Runner stage: feature a live player on the runner's stream (owner ask, 2026-10-19)

**What.** The event lobby (item 10's runner side) also shows which checked-in devices are **live**: the
companion's heartbeat gains `live: 'off' | 'recording' | 'streaming' | 'watchable'` and, when watchable, a
feed id. The runner clicks **Feature** on one player; ArcAid stores `tournaments.featured_device_id` (or a
small `event_stage` row with history) and pushes the change on the existing `room:<roomId>` socket channel
and to the companions through `GET /api/witness/checkin` (`featured: bool` in the reply, so the featured
player's companion knows to start or keep pushing its feed). A fixed **stage page** per tournament,
`/stage/:tournamentId` (admin-token gated, meant to be added once to the runner's OBS as a browser
source), renders whichever feed is featured plus the Castcade overlay (player, table, score, ball, Witness
badge, tournament standing). The runner's YouTube or Twitch stream never changes keys; switching players is
a click in ArcAid. Nothing about the video itself touches the ArcAid server: the stage page plays the feed
from the relay Castcade's Phase 4 provides (peer-hosted ruling), ArcAid only says *which* feed.

**Where.** `witness_devices` or the heartbeat handler for the `live` state, `EventLobbyService.roster`,
a tournament admin route, the stage page in `admin-ui` (public-ish route, token in the URL), the checkin
reply shape in `src/api/routes/global.ts`.

**Size.** Small–medium on ArcAid's side; the feed relay and the overlay are Castcade Phase 4 / 4a work.
**Needed by:** Castcade Phase 4. Design context: `docs/design/arcaid-integration-gap-analysis.md` §6
(phases 4a and 4).

## Not asked of ArcAid

- No media, TURN or SFU on the ArcAid server (peer-hosted by ruling).
- No subscription or paid-tier gate (none exists in ArcAid; the handoff doc's assumption was wrong).
- No new "Challenge" entity, page or clock (ADR 0002 / ArcAid ADR 0018).
- No change to the cabinet Witness app for Castcade.
