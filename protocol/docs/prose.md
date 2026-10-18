This document is the language-neutral contract between every Castcade participant: the host player's
companion (the arbiter), each client companion, `fakeclient/`, and any future producer. The JSON Schema
files in `schemas/` are normative for shapes; this text is normative for behaviour.

Vocabulary (ADR 0002): a match is an ArcAid **Throwdown**; the arbiter is the **host**; the other
participants are **clients**; the turn token is a **grant**.

## Transport and framing

- JSON text frames, one envelope per frame, UTF-8. In v1 the transport is one WebSocket per client to
  the host's companion; a WebRTC data channel is a drop-in replacement later. ArcAid only relays the
  signaling that bootstraps those connections.
- `seq` is per sender and strictly increasing within a connection. A receiver drops a frame whose `seq`
  is not greater than the last one it accepted from that sender and answers with `REJECT`.
- `v` must equal the receiver's protocol version or the receiver answers `REFUSE` (`protocol_version`)
  and closes.
- `matchId` is `null` only on `HELLO`, `HELLO_ACK` and `REFUSE`.

## Canonical JSON

Anything hashed or signed is first serialized by `canonicalJson`: object keys sorted by UTF-16 code
unit order, no whitespace, `undefined` properties omitted, numbers as JavaScript's `JSON.stringify`
prints them, no `NaN` or infinities. `protocol/fixtures/canonical.json` pins inputs and outputs.
Hashes are SHA-256, lower-case hex. Signatures are Ed25519 over the UTF-8 bytes of the canonical JSON,
base64-encoded.

## Joining

1. A client connects and sends `HELLO` with its `GameFingerprint` and its Ed25519 public key.
2. The host compares the fingerprint against the first accepted participant's. Any difference refuses
   the newcomer with `fingerprint_mismatch` and names the field and both values, so the UI can say which
   side differs. `tableHash` is the hash of the *original* `.vpx`; the patch is proven by `recipeVersion`
   plus `sidecarHash` (ADR 0004).
3. Accepted clients receive `HELLO_ACK` with the host's public key and the roster so far.
4. When the host starts the match it sends `MATCH_READY` to everyone. The roster is then final; later
   `HELLO`s are refused with `match_started`.

## Turn rotation (alternating mode)

- Every participant plays their own one-player game of `ballsPerGame` balls (Architecture B). Grants go
  ball 1 to each player in `playerOrder`, then ball 2 to each, and so on.
- A `TURN_GRANT` names the player and the ball. The signature is over `canonicalJson(grant)` with the
  host's key from `MATCH_READY` (or the key announced in an accepted `HOST_TRANSFER`). A client releases
  its input lock only for a grant that verifies, names itself, and carries a `grantSeq` greater than any it
  has seen.
- The grant holder answers with `BALL_END`. The host accepts `BALL_END` only from the holder and only
  with the current `grantSeq`; anything else gets `REJECT` and changes nothing.
- `shootAgain: true` means the detector saw an extra ball. The host re-grants the **same player and the
  same ball number** with a new `grantSeq`; the rotation does not advance.
- `finalScore` in `BALL_END` must be sampled after the end-of-ball bonus has been added. Tables add the
  bonus after the drain (NVRAM counts it down, script tables add it after `EndOfBall`), so a detector
  reports the score at the next boundary or after a quiet period, never at the drain instant.
- A player's game ends after `BALL_END` for ball `ballsPerGame` (with `shootAgain: false`), or on
  `GAME_OVER`, or on `FORFEIT`. The host keeps rotating among players whose games have not ended.
- The host logs every accepted message and every grant it issues. When every game has ended it sends the
  final log hash to all clients implicitly through `RESULT`; before that each client sends `LOG_SIGN` over
  `{matchId, logHash, logLength}` of the log as *it* received it. A client whose log hash differs still
  signs its own hash; the host records the disagreement. Mismatches are stored and flagged on the ArcAid
  side, never rejected (badge, never gate).

## Pauses and timeouts

- A dropped connection, or no `BALL_END` within 20 minutes of a grant, moves the match to paused
  (`PAUSE` from the host). Any participant may `RESUME`; the host then re-issues the outstanding grant with
  a new `grantSeq`. Any participant may `FORFEIT` themselves; the host may forfeit a participant who does
  not return.

## Host transfer

- Every client keeps the full log, so any client can become host. The current host may hand over
  (`host_requested`); when the host is gone any client may propose itself (`host_left`).
- A `HOST_TRANSFER` carries the proposer's log head, the last grant it saw and its public key. It takes
  effect when a strict majority of the remaining participants (the proposer included) answer
  `HOST_TRANSFER_ACK` with `accept: true`; an acker must hold the same log hash to accept.
- After an accepted transfer the new host re-issues the outstanding grant with a new `grantSeq`, signed
  with its own key, and the match resumes at the same handoff. `RESULT.hostTransfers` counts transfers.

## Result

- `RESULT` lists every participant with score, balls played, status and rank (ties share a rank), the
  final log hash and length, the host's signature over `{matchId, logHash, logLength}`, and every
  `LOG_SIGN` received. The host posts the same object to ArcAid as the Throwdown's scores plus a
  `castcade_matches` record.

## Simultaneous mode (arcade)

`MATCH_READY.turnMode = "simultaneous"` skips `TURN_GRANT` and `BALL_END` entirely: RetroArch's player
slots decide whose input counts, every client sends `STATE` and `GAME_OVER`, and `RESULT` follows.

## DMD bitmap encoding (`rle8-base64`)

Pixels in row-major order, one value per pixel of `bitsPerPixel` bits (2, 4 or 8), run-length encoded as
byte pairs `(count, value)` with `count` 1..255, then base64. Text displays use the `text` variant.
