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
  is not greater than the last one it accepted from that sender; the host answers with `REJECT`, a client
  drops silently (`REJECT` is host -> client only). Frames the host relays keep the original sender's
  `seq`, so receivers track one counter per `from`.
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
- A `TURN_GRANT` names the player and the ball and goes to **every** participant, not only the holder.
  The signature is over `canonicalJson(grant)` with the host's key from `MATCH_READY` (or the key
  announced in an accepted `HOST_TRANSFER`). A client releases its input lock only for a grant that
  verifies, names itself, and carries a `grantSeq` greater than any it has seen. `grant.logHash` is the
  host's log head before the grant was appended; a client whose head differs raises a desync for the UI
  and the ArcAid badge but still accepts the grant (badge, never gate).
- The grant holder answers with `BALL_END`. The host accepts `BALL_END` only from the holder and only
  with the current `grantSeq`; anything else gets `REJECT` and changes nothing.
- `shootAgain: true` means the detector saw an extra ball. The host re-grants the **same player and the
  same ball number** with a new `grantSeq`; the rotation does not advance.
- `finalScore` in `BALL_END` must be sampled after the end-of-ball bonus has been added. Tables add the
  bonus after the drain (NVRAM counts it down, script tables add it after `EndOfBall`), so a detector
  reports the score at the next boundary or after a quiet period, never at the drain instant.
- A player's game ends after `BALL_END` for ball `ballsPerGame` (with `shootAgain: false`), or on
  `GAME_OVER`, or on `FORFEIT`. The host keeps rotating among players whose games have not ended. A
  `GAME_OVER` for a game that has already ended is answered with `REJECT` (`unexpected_state`).
- If the next grant would go to a player the host knows to be disconnected, the host sends
  `PAUSE(disconnect, player)` instead of the grant. Whether to `FORFEIT` that player and `RESUME` is a
  policy decision above the protocol (the host UI, or the fake client's scenario).

## The match log

- Every state-changing message the host accepts is broadcast **verbatim to all participants**, the
  sender included: the echo is the sender's acknowledgement that it was accepted. Each participant
  appends the broadcast stream, in order, to its own append-only log, so host and clients hold the same
  entries without any further coordination.
- Logged, in stream order: `MATCH_READY`, every `TURN_GRANT` the host issues, accepted `BALL_END`,
  `GAME_OVER`, `FORFEIT`, `PAUSE`, `RESUME`, `HOST_TRANSFER`, and one derived `host_transfer` event per
  accepted transfer (below). **Not logged**: `STATE` and `DMD_FRAME` (mirrored to the *other*
  participants only, never trusted for results), `HELLO`, `HELLO_ACK`, `REFUSE`, `REJECT`, `LOG_SIGN`,
  `HOST_TRANSFER_ACK`, `RECONNECT`, `RECONNECT_ACK`, `RESULT`, `MEDIA_SIGNAL` (forwarded to its `to`
  only, see Media signalling).
- Each entry is `{index, prevHash, ts, kind, from, message | event}` with
  `hash = sha256(canonicalJson(entry))` and `prevHash` the previous hash (64 zeros before the first
  entry). `ts` is always the message's own `ts`, never a local clock, so hashes agree across machines.
  `kind` is `grant` for a `TURN_GRANT`, `event` for the derived transfer entry, `msg` otherwise.
- The log **freezes at the entry that ends the last game**. `LOG_SIGN` and `RESULT.logHash` refer to
  that head; nothing is appended after it.
- A client sends `LOG_SIGN` over `{matchId, logHash, logLength}` as soon as its own log shows every
  game ended (every player finished or forfeited), using the head as *it* holds it. A client whose head
  differs from the host's still signs its own; the host records the disagreement and `RESULT.signatures`
  carries what each participant actually signed. Mismatches are flagged on the ArcAid side, never
  rejected (badge, never gate).
- The host sends `RESULT` once every connected non-host participant has signed, or after a log-sign
  timeout (default 10 s) with the signatures it has.

## Pauses and timeouts

- A dropped connection, or no `BALL_END` within 20 minutes of a grant, moves the match to paused
  (`PAUSE` from the host). Any participant may `RESUME`; the host then re-issues the outstanding grant with
  a new `grantSeq`. Any participant may `FORFEIT` themselves; the host may forfeit a participant who does
  not return. A `BALL_END` for the outstanding grant is still accepted while paused. A client `PAUSE`
  while already paused, or a `RESUME` while not paused, gets `REJECT` (`unexpected_state`).
- In `RESULT`, a forfeited player whose connection was still up has status `forfeit`; one whose
  connection was gone has status `disconnected`.

## Host transfer

- Every client keeps the full log, so any client can become host. The current host may hand over
  (`host_requested`); when the host is gone any client may propose itself (`host_left`).
- A `HOST_TRANSFER` names `newHost` and carries the proposer's log head, the last grant it saw and the
  new host's public key, which must equal `newHost`'s roster entry (a receiver ignores a proposal where it
  does not: no log entry, no ack). For `host_requested` the proposer is the current host; for `host_left`
  the proposer is `newHost` itself, the lowest remaining `playerId`. Every participant logs the
  `HOST_TRANSFER`.
- It takes effect when a strict majority of the remaining participants (connected and not forfeited,
  the departed host excluded, the proposer counted as accepting) answer `HOST_TRANSFER_ACK` with
  `accept: true`; an acker must hold the log head the proposal names to accept. Only the prospective new
  host counts acks. Everyone else commits the transfer when the first host-only message (`TURN_GRANT`,
  `PAUSE`, `RESUME`, `FORFEIT`, `RESULT`, `REJECT`) arrives from the new host, so the commit lands at the
  same log position everywhere regardless of the order acks travel in.
- Committing appends the derived `host_transfer` event `{type, reason, proposer, from, to,
  newHostPublicKey}` with `ts` equal to the `HOST_TRANSFER` message's `ts`. From then on grants are
  verified with the new key.
- While a `host_requested` transfer is pending the old host answers `BALL_END`, `GAME_OVER`,
  `FORFEIT`, `PAUSE` and `RESUME` with `REJECT` (`unexpected_state`), so no entry can land between the
  `HOST_TRANSFER` entry and the commit event; the holder answers the re-issued grant instead.
- After the commit the new host re-issues the outstanding grant with a new `grantSeq`, signed with its
  own key, and the match resumes at the same handoff. `RESULT.hostTransfers` counts transfers.
- Over WebSocket (A2, 2026-10-30) clients reach each other only through the host. The host relays
  every `HOST_TRANSFER_ACK` to the other participants, so the prospective new host can count them.
  `HOST_TRANSFER.newHostEndpoint` carries the new host's listener (a `ws://` or `wss://` URL); it is
  `null` on a transport without per-host sockets (the in-memory bus, a data channel set up by
  signaling). For `host_left` the endpoint is the proposer's own; for `host_requested` the current host
  learns it the way the first connections were bootstrapped. The listener is open before the proposal
  goes out.
- Every other participant, the old host included, opens a new socket to that endpoint and sends
  `RECONNECT` from its log position (see Reconnect), never a fresh `HELLO`. A client does so as soon as
  it has logged and acked the `HOST_TRANSFER`; the old host does so after its commit. The new host holds
  a `RECONNECT` that arrives before its own commit and answers it at the commit, before it re-issues the
  grant. The old host closes its listener, and with it every socket to it, once its own `RECONNECT` is
  accepted. A socket to the old host that closes after the proposal is not a disconnect.
- The transfer is one entry in the hash-chained log like everything else: a participant that was not
  linked to the new host when the commit landed receives the `host_transfer` event, and anything after
  it, in its `RECONNECT_ACK`, at the same log position as everyone else.
- `host_left` over WebSocket needs the candidate's endpoint before the host is gone, which this
  version does not carry; a client that loses the host first tries to reconnect to it (see Reconnect).

## Reconnect

- A client that lost its socket reconnects to the current host, at the endpoint it last reached it on,
  and sends `RECONNECT` as the first frame: its player id, the hash and length of the last log entry it
  holds, and its signature over `{matchId, player, logHash, logLength}` with its roster key. It never
  sends a fresh `HELLO` to resume.
- The host answers `RECONNECT_ACK`. When it holds an entry with that hash at that position, the answer
  carries every entry after it, in order, verbatim (nothing when the client is already current). The
  client checks each entry's `prevHash` and `hash` before appending it, so its log is the host's log.
  When the hash is unknown, the signature does not verify, or the player is not in the roster, the
  answer is a rejection with a `code` and no entries, and the host closes the socket.
- A rejected client must re-join with a fresh `HELLO`. It is a new participant only if the match allows
  it, which after `MATCH_READY` it does not (`match_started`).
- The existing pause and timeout rules apply while a player is disconnected: the drop pauses the match
  (`PAUSE(disconnect, player)`), the host may forfeit a player who does not return, and any participant
  may `RESUME`. A `RESUME` that clears a `disconnect` pause for a player who is still playing marks that
  player connected again; if it is still gone, the host pauses again at its next grant.
- After an accepted `RECONNECT` the client unlocks input only for an outstanding grant that names it
  and verifies, signs the log if every game has ended, and receives the `RESULT` again if the host has
  already sent it.
- A client retries the reconnect for a bounded time; when it gives up, the host is treated as gone
  (`host_left`, above).

## Media signalling

- Players see and hear each other over WebRTC, one peer connection per pair of participants (a full
  mesh at 2–4 players). `MEDIA_SIGNAL` carries only the setup: SDP offers and answers and trickled ICE
  candidates. It rides the match channel (D2, 2026-10-30): a client sends it to the host, and the host
  forwards it to the one participant named in `to`, with `from` preserved, and to nobody else. A signal
  addressed to the host is consumed there; the host sends its own straight to `to`. A signal for a
  participant who is not connected is dropped.
- `MEDIA_SIGNAL` is never logged and never changes match state; it is valid in any phase.
- The media flows peer to peer (STUN, optionally the player's own TURN server). It never crosses ArcAid
  and never passes through the host's match socket.
- Voice goes from every participant to every other (open microphone with a mute). Video goes only from
  the player up: each rig keeps one video sender per connection and enables it only while it holds the
  grant, so a new grant or a host transfer needs no renegotiation. Who is up comes from `TURN_GRANT`,
  never from the media.

## Result

- `RESULT` lists every participant with score, balls played, status and rank (competition ranking: ties
  share a rank, the next rank skips; `winner` is `null` on a tie for first), the frozen log hash and
  length, the host's signature over `{matchId, logHash, logLength}`, and every `LOG_SIGN` received with
  the head it signed. `RESULT` itself is not logged. The host posts the same object to ArcAid as the
  Throwdown's scores plus a `castcade_matches` record.

## Simultaneous mode (arcade)

`MATCH_READY.turnMode = "simultaneous"` skips `TURN_GRANT` and `BALL_END` entirely: RetroArch's player
slots decide whose input counts, every client sends `STATE` and `GAME_OVER`, and `RESULT` follows.

## DMD bitmap encoding (`rle8-base64`)

Pixels in row-major order, one value per pixel of `bitsPerPixel` bits (2, 4 or 8), run-length encoded as
byte pairs `(count, value)` with `count` 1..255, then base64. Text displays use the `text` variant.
