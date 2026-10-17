# ADR 0003 — One desktop app: Castcade uses Arcaid Witness

**Status:** Accepted (2026-10-17)
**Owner rulings:** 2026-10-17 ("One app - Castcade. Castcade USES Arcaid Witness. Arcaid Witness needs to maintain separate bits though for use in the standalone app installs (AtGames)").
**Related:** ADR 0001, ADR 0004; ArcAid ADRs 0020–0022 (Witness verify-join, three tiers, VPXS scores from the launcher); ArcAid `docs/vpx-desktop-witness-plan.md`.

## Context

"Arcaid Witness" is today three distinct things:

1. **A server contract** in ArcAid: pairing (`POST /api/me/witness/pairing-code` → 6-character code,
   10-minute TTL, single use; `GET /api/witness/pair?code&device&username` → 32-byte token stored
   only as a SHA-256 in `witness_devices.token_hash`), device-authenticated GET endpoints
   (`/api/witness/report`, `/checkin`, `/heartbeat`, `/score`), per-device routing
   (`target_room_id` / `target_tournament_id` / `global_fallback`), and the three-tier
   verification doctrine (badge, never gate). Files: `src/services/WitnessService.ts`,
   `src/api/routes/global.ts` ~L161–402, `src/services/WitnessVerifyService.ts`,
   `src/services/VpxScoreIngestService.ts`.
2. **The AtGames cabinet app**: about 4.4k lines of C++ on the AtGames external-app SDK
   (Linux/ARM), version 1.0.4, reading the Legends Unchained launcher's `scoreserver/*-games.jsonl`
   and `vpx-sessions.json`. Source lives gitignored in
   `ArcAid/tmp/witness-build/sdk-external-apps-0.3.0/apps/arcaid-witness/`; it is hand-delivered as
   zips. It cannot run anything but itself, cannot be patched into VPX (closed fork), and can only
   send GET requests.
3. **A planned Windows desktop producer** (`ArcAid/docs/vpx-desktop-witness-plan.md`, "nothing is
   built yet"): Node/TS, process-watch `VPinballX*.exe -Play`, basic mode decodes `.nv` and
   `VPReg.stg` on exit, optional live mode via a `core.vbs` hook writing a journal, pairing reusing
   `scripts/witness-agent.ts`, tray UI, per-user installer, code-signing certificate.

The Castcade companion needs item 3 almost verbatim: the same process watch, the same NVRAM
decode through the maps corpus, the same pairing, the same journal, the same installer, the same
signing certificate. Two separate desktop apps would also both want to register `NVRAMCallback`,
and `Controller.ChangedNVRAM` is a destructive delta read: whichever consumer calls it second gets
nothing, so two independent hooks corrupt each other unless deliberately chained.

Licensing: the handoff doc rules GPLv3 for everything in this repo. ArcAid's own licensing is
inconsistent (PolyForm Noncommercial file, `package.json` "ISC", README "Proprietary"); the owner
wrote both codebases and can relicense their own code.

## Decision

### 1. The Windows desktop Witness producer is a module of the Castcade companion

Process watch, basic-mode decode, live-mode journal tailing, pairing, heartbeat, check-in and score
reporting live in `companion/` as the `witness` module, shipped from this repo under GPLv3. The
companion pairs as an ordinary witness device and talks the existing endpoints. Players see one
"Arcaid Witness" brand on cabinet and PC.

### 2. The cabinet app and the server contract stay in ArcAid

The C++ AtGames app remains a separate deliverable in ArcAid's tree, because its platform forces it.
The server side (pairing, endpoints, verification, routing) remains ArcAid code. Castcade asks ArcAid
for small additive changes only (a `device_type` on `witness_devices`, a non-AtGames device id);
see `docs/arcaid-side-changes.md`.

### 3. What is shared is the contract, never code

Shared across cabinet and desktop: the wire contract (pairing flow, endpoint shapes, token rules),
the event vocabulary (`table_loaded`, `game_start`, `current_scores`, `ball_end`, `game_end`,
`reason`/`via` tags), and the `tomlogic/pinmame-nvram-maps` corpus (ODbL; attribution required in
the companion's About box). C++ and TypeScript share nothing else.

### 4. The companion's first shippable release is desktop Witness basic mode

Before any netplay exists, the companion ships as "Arcaid Witness for desktop VPX": install, pair,
play, and last-game scores reach a room board or the Global Scoreboard with the Witnessed badge.
This burns down the installer, SmartScreen and code-signing risk on the simplest possible product.

### 5. One in-VPX hook, one consumer

Because the Witness live mode and Castcade matches are one app, there is exactly one `NVRAMCallback`
consumer per VPX process, with one shadow NVRAM, and the `castcade.vbs` library's registration
guard chains any other callback it finds (ADR 0004).

## Consequences

### Easier
- One install, one pairing, one tray icon, one hook line, one signing certificate for the player.
- The desktop Witness plan's P2–P5 become Castcade Phases 2–3 instead of a parallel ArcAid arc.
- Castcade gets a real user base (Witness-only players) before the match feature is finished.

### Harder
- The desktop agent moves repos and licences: `scripts/witness-agent.ts` pairing logic is ported,
  not copied, and the owner relicenses what is reused.
- ArcAid's `docs/vpx-desktop-witness-plan.md` must be amended to point here (work item 9 in
  `docs/arcaid-side-changes.md`), or two plans will drift.
- The companion inherits the Witness plan's non-negotiables: default install modifies nothing,
  no admin, no COM registration, hash manifest and one-click revert for anything it writes.

### Locked out
- No second Windows desktop Witness app in ArcAid's repo.
- No Castcade-only NVRAM hook that bypasses the shared `castcade.vbs` registration guard.

## Alternatives rejected

- **Two apps sharing written contracts only.** Two installs and two certificates for the player,
  and two hooks competing for one destructive `ChangedNVRAM` read unless chained by convention
  across repos. The chaining would be the hardest part of either app.
- **Castcade as a module inside an ArcAid-repo Witness app.** Inverts the dependency: the match,
  media and launcher modules are the larger product and GPLv3 is already ruled for them.
- **Rename everything "Arcaid Desktop".** The Witness is a feature of ArcAid; Castcade is a product
  with its own identity that happens to carry the Witness. Branding inside the app can still say
  "Arcaid Witness" on the relevant screens.
