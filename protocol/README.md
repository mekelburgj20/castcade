# protocol/

**Status: version 2 (2026-10-30): version 1 (Phase 1, 2026-10-18) plus `HOST_TRANSFER.newHostEndpoint`,
`RECONNECT` and `RECONNECT_ACK` for host transfer and reconnect over WebSocket (A2, A3).** `src/messages.ts` is the source of truth (zod
schemas); `schemas/*.schema.json` and [`SPEC.md`](SPEC.md) are generated from it plus `docs/prose.md` by
`npm run protocol:generate`, and CI fails when they are stale. Behaviour (joining, rotation, pauses, host
transfer, result) is specified in `SPEC.md`; the table below is the original sketch and `SPEC.md` wins
where they differ (it adds `HELLO_ACK`, `REFUSE`, `HOST_TRANSFER_ACK`, `REJECT`, and `shootAgain` on `BALL_END`).

Language-neutral contract between every Castcade participant: JSON Schema for each match message,
one `PROTOCOL_VERSION` constant, and a markdown spec generated from the schemas. The companion
(host and client modes), `fakeclient/`, and any future in-VPX producer validate against these.
Transport is JSON over one WebSocket per client to the host's companion; ArcAid only relays the
WebRTC signaling that bootstraps those connections (ADR 0002).

## Package

`@castcade/protocol` (npm workspace): `PROTOCOL_VERSION`, `canonicalJson`, the zod schemas and their
TypeScript types, `buildMessage` / `parseMessage` / `decodeFrame` / `encodeFrame` / `isType`.
Tests: `npx vitest run protocol`. Conformance samples for canonical JSON: `fixtures/canonical.json`.

## Messages (from the handoff design, renamed per ADR 0002)

| Message | Direction | Fields | Notes |
|---|---|---|---|
| `HELLO` | client → host | playerId, tableHash, romName, romHash, physicsHash, recipeVersion, sidecarHash, companionVersion, publicKey | Host refuses the match if any hash differs between participants and names the differing side. `tableHash` is the ORIGINAL `.vpx`; the patched sidecar is proven by `recipeVersion` + `sidecarHash` (ADR 0004) |
| `MATCH_READY` | host → all | matchId (the Throwdown code), ballsPerGame, playerOrder (list), seed | `seed` unused in v1; reserved for v2 determinism |
| `TURN_GRANT` | host → one client | matchId, player, ballNumber, grantSig | The only message that unlocks input; signed with the host's key, verified by the companion (plugin-level verification deferred, ADR 0001) |
| `STATE` | client → host, 10 Hz | ballNumber, score, ballInPlay, tilt | Mirrored to the other participants for the overlay |
| `DMD_FRAME` | client → host, on change | frame bytes (RLE) or alphanumeric text | Drawn crisp in the spectators' overlay |
| `BALL_END` | client → host | ballNumber, finalScore, detectorReason | Accepted only from the current grant holder |
| `GAME_OVER` | client → host | finalScore | Sent when that side's game reaches game over |
| `HOST_TRANSFER` | host → all, or any client proposing itself when the host is gone | logHash, currentBall | Accepted when a majority of remaining clients ack it |
| `LOG_SIGN` | each client → host, at game over | signature over the final log hash | Signed with the companion's own keypair (public key registered with ArcAid at pairing; ArcAid issues no keys today) |
| `RESULT` | host → all and ArcAid | matchId, scores, winner, logHash, signatures[] | Posted to ArcAid as the Throwdown's scores plus a `castcade_matches` record; disagreeing signatures are stored and flagged, never rejected |
| `PAUSE` / `RESUME` / `FORFEIT` | either direction | reason | Disconnects, missing `BALL_END` after 20 minutes, unrecoverable desync |

Arcade mode: `TURN_GRANT` is informational only (RetroArch's player slots decide whose input
counts); a Throwdown marked simultaneous skips the grant messages entirely.

## What lives here

- `src/messages.ts`, `src/envelope.ts`, `src/canonical.ts`, `src/version.ts` — the implementation.
- `schemas/*.schema.json`, one per message plus `Envelope`, `GameFingerprint`, `ParticipantInfo`,
  `GrantBody`, and `schemas/index.json` — generated.
- `SPEC.md` — generated from `docs/prose.md` (behaviour) + the schemas (shapes); never hand-edited.
- `fixtures/canonical.json` — pinned canonical-JSON samples; `test/` — vitest.

## What does not live here

- Transport code, signing code, or the host arbiter (those are `companion/`).
- The journal format between the in-VPX script and the companion (that is `vpx-hook/`).
- ArcAid's REST/socket shapes (owned by ArcAid; listed in `docs/arcaid-side-changes.md`).

## Read first

`docs/design/arcaid-integration-gap-analysis.md` (phases, Phase 1 gate), ADR 0001, ADR 0002, and the
"Turn protocol" and "Zero-server option" sections of `docs/design/remote-two-player-design-handoff.md`.
