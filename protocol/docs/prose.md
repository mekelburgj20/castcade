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
  and closes. A frame of another version does not decode at all, so a host answers from the frame's JSON,
  and (A17, the build after 0.2.50) writes its answer **with the asker's `v`** on the envelope, so that the
  asker can decode it: a `HELLO` gets `REFUSE` (`protocol_version`) whose `message` is a sentence for the
  player, naming which PC has to update; a `RECONNECT` gets a `RECONNECT_ACK` that does not accept, with
  the code `unknown_player` (the nearest every version knows) and a `seq` above anything the host can
  have sent that participant before (the wall clock, as a restarted sender uses). `REFUSE` and
  `RECONNECT_ACK` have had the same shape since protocol 2. A host up to 0.2.50 answered a `HELLO` in its
  own version, which the asker could not decode, and a `RECONNECT` not at all; a client that is sent a
  frame of another version while it joins or rejoins reports both versions instead of waiting for an
  answer. Nothing of the frame that is answered goes into the answer but its `v` when that is a whole
  number (the sentence says "another version" otherwise) and, for a `RECONNECT`, a match id of letters,
  digits, `_`, `.`, `:` and `-`: a frame from a socket that has not joined may hold anything, and no such
  frame may make the host fail.
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
   A host in advisory mode (the alpha match, 2026-10-30) accepts a differing fingerprint instead, and
   `HELLO_ACK.hostGame` carries the host's fingerprint so the client flags the difference too, and
   `HELLO_ACK.tableMismatches` lists every accepted participant that differs and how (A8, 2026-10-31), so
   with three or four players each client flags the others as well. The host sends `HELLO_ACK` again to every
   accepted client whenever the lobby roster changes (a join, a leave, an update below), so the last one a
   client holds before `MATCH_READY` is the final roster's. The list is deliberately not in `MATCH_READY`:
   that message is logged verbatim, and a peer that does not know a field drops it (or adds its default) when
   it parses, so the two sides would hash different logs.
4. When the host starts the match it sends `MATCH_READY` to everyone. The roster is then final; later
   `HELLO`s are refused with `match_started`. (Not in a lobby, below: there a `HELLO` is taken in every phase.)

Starting from the host's table (A11, protocol 3): a host may announce the start before it sends `MATCH_READY`.
It re-sends `HELLO_ACK` to every client with `startsInMs`, the time left until it starts (a duration, since the
clocks need not agree; null when no start is under way), and sends `MATCH_READY` when it runs out, unless fewer
than two participants are left. A second announcement while one runs changes nothing; the host may still start at
once. `HELLO_ACK.loading` lists the accepted participants whose fingerprint says no table is open yet, as the host
judges it; the companion starts the match from the host's table only when it is empty. Both fields are defaulted
and never logged.

A player may join before its table is open, so its `HELLO` can say `pc` and a fingerprint of no table (the
first two-player match, 2026-10-31). While the match is in the lobby a client sends `PARTICIPANT_UPDATE` with
its rig and/or fingerprint as they are now; the host replaces that participant's roster entry and
fingerprint, compares the fingerprint against its own again, and sends `HELLO_ACK` again to every accepted
client, so each one re-reads the roster and re-compares `hostGame` with its own fingerprint (an advisory
mismatch can appear or clear this way). The host refreshing its own rig or table does the same. A host in
refusing mode rejects an update whose fingerprint differs with `REJECT` (`unexpected_state`) and keeps the old
one. After `MATCH_READY` the host ignores `PARTICIPANT_UPDATE`: the roster and fingerprint in the log are final.

Ball-end readiness (A13, protocol 5): a turn ends when the holder's companion reports `BALL_END`, which it can
only do for a table whose hook journal it follows. `HELLO.ballEndReady` says whether the sender's open table is
one (absent: unknown, no table open yet); a lobby `PARTICIPANT_UPDATE.ballEndReady` replaces it when that
changes; `HELLO_ACK.ballEndReady` carries what every participant said, the host included, to every client. It
is advice for the lobby (the companion names the players whose table cannot report ball ends and asks the host
to confirm the start); the host still may start, and such a match is played with the holder's own manual
`BALL_END` (End my ball, below) or the host's `TURN_PASS`. None of the three fields is logged.

## Turn rotation (alternating mode)

- Every participant plays their own one-player game of `ballsPerGame` balls (Architecture B). Grants go
  ball 1 to each player in `playerOrder`, then ball 2 to each, and so on.
- A `TURN_GRANT` names the player, the ball and (protocol 3) the `game` of the series, and goes to **every**
  participant, not only the holder. A client drops a grant whose `game` is not the one its log is in.
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
- `TURN_PASS {grantSeq, player, ballNumber, score}` (host -> all, logged, protocol 5): the host ends the
  outstanding grant's ball by hand, for itself or for a client, when no `BALL_END` will come (a table the
  holder's companion cannot read, a stuck player). It names the outstanding grant and its holder; `score` is the
  holder's last known score. Every participant folds it exactly as that player's `BALL_END` with
  `shootAgain: false` and `finalScore: score`; the entry's `from` is the host, which is how the log shows the
  ball was passed. The host sends it only while a grant is outstanding and no transfer is pending (it is
  accepted while paused, like a `BALL_END`); a client drops one that does not name the outstanding grant. A
  `BALL_END` for the passed grant that arrives afterwards gets `REJECT` (`stale_grant`, or `not_grant_holder`
  when another player holds the next grant) and changes nothing.
- End my ball (A17 step 4, the build after 0.2.50; nothing new on the wire): the grant holder's player ends the
  ball by hand, when no ball end will come from the table (a table the holder's companion cannot read, a stuck
  ball). It is the holder's own `BALL_END` for the outstanding grant with `detectorReason: "manual"`,
  `shootAgain: false` and `finalScore` at the score as it stands (the last one its table reported, else what the
  log has for that player). No participant reads `detectorReason` to decide anything, on any protocol version: the
  host checks the sender, the grant and the ball as for every `BALL_END`, logs the frame as it came and goes on with
  the rotation, and a client folds it the same way; the value is in the log for the record, which is how a ball
  ended by its player differs from one the host passed (`TURN_PASS`). A companion offers it only to the grant
  holder and only while the match is not paused.
- A player's game ends after `BALL_END` (or `TURN_PASS`) for ball `ballsPerGame` (with `shootAgain: false`), or on
  `GAME_OVER`, or on `FORFEIT`. The host keeps rotating among players whose games have not ended. A
  `GAME_OVER` for a game that has already ended is answered with `REJECT` (`unexpected_state`).
- If the next grant would go to a player the host knows to be disconnected, the host sends
  `PAUSE(disconnect, player)` instead of the grant. Whether to `FORFEIT` that player and `RESUME` is a
  policy decision above the protocol (the host UI, or the fake client's scenario). A player whose link dropped
  less than the disconnect grace ago (see Pauses and timeouts) is not yet known to be disconnected: its grant is
  held until it is back (the grant then goes out after its `RECONNECT_ACK`) or the grace is over (the pause).

## The match log

- Every state-changing message the host accepts is broadcast **verbatim to all participants**, the
  sender included: the echo is the sender's acknowledgement that it was accepted. Each participant
  appends the broadcast stream, in order, to its own append-only log, so host and clients hold the same
  entries without any further coordination.
- Logged, in stream order: `MATCH_READY`, every `TURN_GRANT` the host issues, accepted `BALL_END`, `TURN_PASS`,
  `GAME_OVER`, `FORFEIT`, `PAUSE`, `RESUME`, `HOST_TRANSFER`, one derived `host_transfer` event per
  accepted transfer (below), and `NEXT_GAME` (Series). **Not logged**: `STATE` and `DMD_FRAME` (mirrored to the
  *other* participants only, never trusted for results), `HELLO`, `HELLO_ACK`, `REFUSE`, `REJECT`, `LOG_SIGN`,
  `HOST_TRANSFER_ACK`, `RECONNECT`, `RECONNECT_ACK`, `RESULT`, `MATCH_END`, `PARTICIPANT_UPDATE`,
  `MEDIA_SIGNAL` (forwarded to its `to` only, see Media signalling).
- Each entry is `{index, prevHash, ts, kind, from, message | event}` with
  `hash = sha256(canonicalJson(entry))` and `prevHash` the previous hash (64 zeros before the first
  entry). `ts` is always the message's own `ts`, never a local clock, so hashes agree across machines.
  `kind` is `grant` for a `TURN_GRANT`, `event` for the derived transfer entry, `msg` otherwise.
- The log **holds still at the entry that ends the current game** (the last player's game of it ending).
  `LOG_SIGN` and that game's `RESULT.logHash` refer to that head; nothing is appended after it until the host's
  `NEXT_GAME` (Series), and nothing at all after the last game of the match.
- A client that played the current game sends `LOG_SIGN` over `{matchId, logHash, logLength}` as soon as its own
  log shows every player's game of it ended (finished or forfeited), using the head as *it* holds it; once per
  game of a series. The host drops a `LOG_SIGN` whose `logLength` does not reach past the start of the current
  game (a late one for an earlier game). A client whose head
  differs from the host's still signs its own; the host records the disagreement and `RESULT.signatures`
  carries what each participant actually signed. Mismatches are flagged on the ArcAid side, never
  rejected (badge, never gate).
- The host sends `RESULT` once every connected non-host participant has signed, or after a log-sign
  timeout (default 10 s) with the signatures it has.

## Pauses and timeouts

- No `BALL_END` within 20 minutes of a grant moves the match to paused (`PAUSE` from the host). Any participant
  may `RESUME`; the host then re-issues the outstanding grant with a new `grantSeq`. Any participant may `FORFEIT`
  themselves; the host may forfeit a participant who does not return. A `BALL_END` for the outstanding grant is
  still accepted while paused. A client `PAUSE` while already paused, or a `RESUME` while not paused, gets `REJECT`
  (`unexpected_state`).
- A dropped connection (A18, 2026-11-24; no change on the wire, so every protocol 6 build plays with every other):
  - **The disconnect grace.** A link that drops is not a disconnect for 5 seconds. The host sends that peer nothing
    meanwhile, logs nothing and pauses nothing; a client whose link to the host dropped starts its reconnect at once
    and tells its player nothing. A `RECONNECT` inside the grace is answered as any other, and that is all that
    happened. A peer whose `RECONNECT` the host rejects is disconnected at once.
  - **Only the grant holder is paused for.** When the grace is over and the peer holds the outstanding grant, the
    host sends `PAUSE(disconnect, player)`: the others wait, as before. (That player's own companion keeps its table
    as it is: it locks only on what the host says, never on a silence.) A peer that does not hold the grant changes
    nothing: no `PAUSE`, no log entry, the outstanding grant and its 20 minutes untouched, nothing sent to the
    player who is up. Its absence counts when its own grant comes due (Turn rotation, the last rule). Simultaneous
    mode has no grant holder: there the drop pauses once the grace is over.
  - A host from before A18 pauses at the drop itself, for any player; a client must take either (it does: a `PAUSE`
    is a `PAUSE`).
  - **What the others are shown during that pause** (A17 step 4, the build after 0.2.50; nothing on the wire).
    `PAUSE(disconnect, player)` for the grant holder is about the holder's link to the host and says nothing of the
    holder's media, which never crossed the host: the holder may be playing on. A companion that is watching the
    holder goes on showing the holder's table (the video, or the state stream on its own table) for as long as
    that picture arrives, and says who is away beside it; when the picture stops arriving it shows the pause. The
    grant the host issues again after the `RESUME` changes nothing in what is shown. A companion up to 0.2.50 shows
    the pause at once and its own table until that grant.
  - Inside the grace the peer is still a player of the match in every other respect: a game that ends waits for its
    `LOG_SIGN` like anyone's (the log-sign timeout bounds it), and a `NEXT_GAME` the host wants meanwhile is held
    until the grace is over one way or the other, so that `playerOrder` lists the peer when it is back and leaves it
    out when it is not.
- What a player reported into a link that had just dropped is not lost: after an accepted `RECONNECT` a client
  sends again, each in a new envelope, its own `BALL_END` when the grant it answers is still the outstanding one
  and no `BALL_END` or `TURN_PASS` for it is in the log, its own `GAME_OVER` or `FORFEIT` when the log still has
  its game as being played, and its `LOG_SIGN` for a game that has ended and whose `RESULT` it has not received;
  before any `RESUME` it sends for a pause its drop caused, so the host takes the ball end inside the pause and the
  `RESUME` moves the rotation on. A report the host answered with `REJECT` is not sent again.
- `RECONNECT.resends` (optional, never logged, not in the signed body; a peer that does not know the key drops it)
  is `true` from a client that does this. A client that does not say so (a companion up to 0.2.50) reports a ball
  that ended while its link was away only for a grant issued again, so for such a client, when it holds the
  outstanding grant and the match is not already paused for it, the host commits `PAUSE(disconnect, player)` before
  the `RECONNECT_ACK`: inside the grace, and also when the host never saw that client's link drop (a relayed peer
  replaced with no leave). That `PAUSE` is sent to every other participant and not to the reconnecting one, which
  finds it in the `RECONNECT_ACK`'s entries, sends `RESUME` as it always did, and gets the grant issued again. A
  client that says `resends`, and a player of any build that does not hold the grant, is not paused for.
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
- The existing pause and timeout rules apply while a player is disconnected (Pauses and timeouts: the grace, and
  a pause only for the grant holder or at the absent player's own grant, `PAUSE(disconnect, player)`), the host may
  forfeit a player who does not return, and any participant may `RESUME`. A `RESUME` that clears a `disconnect`
  pause for a player who is still playing marks that player connected again; if it is still gone, the host pauses
  again at its next grant. A reconnect that finds no pause for its own player sends no `RESUME`.
- After an accepted `RECONNECT` the client unlocks input only for an outstanding grant that names it
  and verifies, signs the log if the current game has ended and it played in it, and receives again every
  `RESULT` the host has sent, oldest first, each in a new envelope (a frame resent with its old `seq` would fall
  to the seq rule). A `RESULT` for a game before the current one is checked against the client's log entry at
  `logLength`, not its head.
- A client retries the reconnect for a bounded time; when it gives up, the host is treated as gone
  (`host_left`, above).
- A participant whose process restarted resumes the same way, from the log it saved: a client sends
  `RECONNECT` from its saved head; a host rebuilds its state from its saved log, serves the same
  endpoint again and issues the outstanding grant again under a new `grantSeq`. `seq` is per sender
  and strictly increasing across that sender's connections (only a `HELLO` starts it over), so a
  restarted participant starts its `seq` above anything its earlier run can have used.

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
- The `rtc` connection of a pair exists from the moment both are in the lobby (A17, the build after 0.2.50): a
  participant opens its side to everyone in the roster as it learns of them (`HELLO_ACK`, sent again on every
  change) and closes it for one who is no longer listed. `MATCH_READY`, `NEXT_GAME`, `RESULT` and an accepted
  `RECONNECT` open and close nothing: the voice of the lobby is the voice of the match. A participant on
  0.2.46 to 0.2.50 opens its side at `MATCH_READY`, as every build did. It holds the offer and the candidates it was
  sent before that (64 signals per peer) and answers them then, so the voice with such a participant starts with the
  match, as it did. An offer the peer has never answered is sent again after 5 s and then less and less often (up to
  5 minutes apart), so that a long lobby leaves that participant a handful of copies to answer; when the peer then
  offers by itself, the side whose offer wins the collision sends its own again at once. An answer whose m-lines are
  not those of the offer that is waiting was made for an older offer and is dropped.
- Nobody's microphone is sent to a participant once the lobby they shared is over, or either has left it. A client
  that loses the host before `MATCH_READY` (the host left, its link closed, the room was closed, or the client's own
  link dropped: in the lobby none of these is followed by a `RECONNECT`) closes every `rtc` connection at once,
  those to the other clients too: no roster will tell it who is still there. So does every participant at
  `MATCH_END`, and a client whose host is gone between two games.
- A dropped match link is not a dropped media connection (A18): the two are different paths, and a participant
  keeps every media connection that is itself still connected through a drop and a reconnect of the match link.
  Only a connection that is not connected any more is closed, and made again when its peer is back (the peer
  that rebuilt its side offers anew; a side that kept its own takes that offer on a fresh connection, D2.7).
- `channel` says which connection of the pair a signal sets up: `rtc` (the default: voice, and the Electron
  video), `video` (protocol 4: the native video helper's connection) or `stream` (protocol 6, I11.4.2: a
  data-only connection between the two companions that carries the VPX state stream, so a waiting player
  whose VPX can watches the player up on their own table instead of the flat video). The `stream`
  connection is opened in the lobby by every pair; what a PC's VPX can do is said over that connection
  itself, never in a match message. A peer on protocol 5 does not know the value, which is why 6 is a
  version of its own: mixed builds refuse each other at `HELLO`.

## Result

- `RESULT` is sent once per game. It lists every player of that game with score, balls played, status and rank
  (competition ranking: ties share a rank, the next rank skips; `winner` is `null` on a tie for first), the log
  hash and length at that game's end, the host's signature over `{matchId, logHash, logLength}`, every `LOG_SIGN`
  received with the head it signed, `game` (1-based) and `series`, the standings after this game (below).
  `RESULT` itself is not logged. The host posts the same object to ArcAid as one result of the Throwdown plus a
  `castcade_matches` record.

## Series (protocol 3, A10)

- A match is a series of games in one log. Each game is played and ended as above, and its `RESULT` goes out.
  Then the host either starts the next game or ends the match; it does neither before that game's `RESULT` went out.
- `NEXT_GAME {game, playerOrder}` (host -> all, logged) starts game `game`, the previous one plus 1.
  `playerOrder` is who plays it, in rotation order: the companion lists the roster's participants still
  connected, the host first. Every listed player starts a fresh game (no balls played, score 0, playing); the
  grant rotation starts again at ball 1 of `playerOrder[0]`; `grantSeq` keeps increasing across games. A client
  drops a `NEXT_GAME` that arrives while a game is still being played or does not carry the next number.
- A participant left out of a game is still in the roster: it may reconnect, and it receives the grants and
  results, but it plays, signs and ranks only in the games it is listed for.
- `RESULT.series`: per participant who played any game of the series, the games played, the outright wins (a
  tie for first wins nobody that game) and the total of their scores, ranked by wins, then total score
  (competition ranking). It is a fold over the log, so a host that took over mid-series sends the same table.
- `MATCH_END {games, reason}` (host -> all, never logged) ends the series between games; the last `RESULT`
  stands, nothing more is appended, and the host closes the match. A client does not reconnect to a host after
  it, and a host that leaves between games without one ends the series for the others too (no transfer happens
  between games: there is no game to hand over). In a lobby (below) `MATCH_END` closes the match and nothing
  else.

## The lobby (A17)

**Status, 2026-11-25.** The shapes below are in the schemas and both engines know the rules, behind an option
that is off (`HostOptions.lobby`, `ClientOptions.lobby`). The protocol is still 6: a build with the option off
sends none of the new messages and none of the new keys, so its frames are byte for byte those of 0.2.46 to
0.2.50, and it plays with them. The version becomes 7 in the build that turns the lobby on; from then on a host
is a lobby.

A **lobby** is one connection per PC for an evening: one code, the people in it (**members**), what each has
chosen (`Stance`: `play` or `watch`), a table, and any number of matches, one after the other. The host is the
lobby's PC; it arbitrates every match in the lobby, also one it does not play in. A **player** is a member who
is in the match being played; a **watcher** is a member who is not.

- **Watch is a fact of the lobby, never of a match.** A match's log holds its players and nothing else, exactly
  as a log without a lobby does: `MATCH_READY.participants` and `playerOrder` are the players, `RESULT.entries`
  the players, `LOG_SIGN` from the players. No logged message changes shape, and the fold over the log is the
  same. Never logged: who is in the lobby, who watches, who is away, who asked for a start, the starter, the
  table picks, joins and leaves of members.
- **Joining.** `HELLO.throwdownCode` is the lobby's code, and `HELLO.stance` the sender's choice (absent:
  `play`). A lobby takes a `HELLO` in every phase while there is room (four people in all): it never refuses
  with `match_started` or for a table that differs, and `match_full` reads "This lobby is full (four people)."
  A `HELLO` in the name of somebody who is a member is refused (`duplicate_player`), also while that member is
  away: a `HELLO` is not signed and never takes a place over.
- **`HELLO_ACK` is the lobby as it is now**, sent to every member on every change, in every phase, also while a
  match is played: `participants` is the members (the host first, then in the order they joined), with
  `stances`, `away`, `noCopy`, `ownGame`, `otherTable`, `tablePickedBy`, `ballsPerGame`, `starter`, `match` (the
  open match: its id, the players it started with, the game number, and `game` or `between`; null when none is
  open) and `start` (the start that is announced; null when none is). Every one of these keys is optional and
  absent from a host that is not a lobby.
- **`PARTICIPANT_UPDATE` counts in every phase** for `rig`, `game`, `ballEndReady`, `midnightMode`, `stance`,
  `noCopy` and `ownGame` (and `stream3dWaitMs` whenever no game is being played); the host answers with
  `HELLO_ACK` to every member and does not pass the update on (an `advisory`, a flag about one ball, is still
  passed on as it came). A choice takes effect at the next start: it changes nothing in a game that is being
  played.
- **The lobby's table is a pick.** `HELLO_ACK.hostGame` is the picked table: its identity keys (`kind`,
  `tableName`, `tableHash`, `romName`), the other keys null or empty, because they are facts of one PC's copy;
  `tablePickedBy` says who picked it (null: nobody yet; a lobby opened with no table takes the first table its
  PC has open). A member's own table is compared with the pick on the identity keys only
  (`tableMismatches`), the host's own like anyone's; `loading` lists the members whose table is not open,
  `otherTable` those whose open table is another game (not the same ROM, nor the same name or title).
  `TABLE_PICK {game}` (client -> host) picks; the answer is the `HELLO_ACK` that carries it, or `REJECT`
  (`unexpected_state`) with the sentence: not during a game, and not while a start is announced. A pick of
  another table ends the open match at that moment (`MATCH_END`, "the table changed"). What each PC then does
  about its own VPX is not the protocol's.
- **A match of a lobby.** Two to four members play it, and the host need not be one of them.
  `MATCH_READY.matchId` is `<lobby code>-<n>`, `n` counting the lobby's matches from 1; grants, `RESULT` and the
  signatures carry that id. `hostPlayerId` is the lobby's PC, which need not be in `playerOrder`; `game` is the
  full fingerprint of the first player's open table, never a pick. `NEXT_GAME.playerOrder` is the open match's
  own players who are set to Play and here: a member who is not in the open match comes into play only by a
  new match, never by a next game.
- **Asking for a start.** Any member asks: `START_REQUEST` (client -> host; the host's own owner asks its
  engine). The host answers by announcing the start in `HELLO_ACK.start`, or with `REJECT` (`unexpected_state`)
  whose `message` is the sentence the asker is shown.
  - Who plays it: with no match open, or with `newMatch`, the members set to Play who are on a link and have a
    copy of the table (`noCopy` counts as not set to Play), in the lobby's order: a new match, and an open one
    is ended first. With a match open and without `newMatch`: that match's players who are set to Play and
    here: its next game. The asker goes first when they play.
  - **The starter** (`HELLO_ACK.starter`) is the one member whose own table may ask (`fromTable`: their game
    began on their table, so it is the match's first and they go first): with no match open the first member
    in the lobby's order who is set to Play, here and has the table; with one open the player who went first
    in the game being played or just played, while here and set to Play, else the next in that game's order.
    `fromTable` from anyone else is refused, and `fromTable` with `newMatch` always. The starter's `fromTable`
    arriving while somebody else's start is announced puts the starter first in that start.
  - The checks, in this order, at the request and again when the countdown runs out: no game is being played
    (refused); no start is announced (a second request changes nothing); the last game's `RESULT` is out (the
    start **waits**: `waitsFor: result`); two or more play it (refused, with who is set to Play); each of
    their tables is open (`tables`), is the lobby's game (`other_tables`), and none of them is in a game of
    their own other than the `fromTable` game (`own_games`): the start waits, `waitsOn` names for whom; each
    of their tables can report ball ends (refused unless the request says `anyway`); their 3D connections are
    settled (`3d`: it waits, 45 s at most from the first time it was held).
  - When nothing is in the way the start **counts down** 5 s (`start.waitsFor` null, `leftMs`, and
    `startsInMs`); each PC in `start.players` locks its table then, unless a game runs on it. When it runs out
    the checks run again: `MATCH_READY` (after the open match's `MATCH_END`, for a new match) or `NEXT_GAME`
    follows, or the start waits again, or it is taken away.
  - A request with `now` while a start waits starts without what it waits for: without the members in
    `waitsOn`, if two are left, and without the 3D connections. `START_CANCEL` (any member) takes the
    announced start back. A member in the start who switches to Watch, goes away or leaves is taken out of it;
    with fewer than two left, or without its asker while it waits, it is taken away; a switch to Play counts
    from the next start. The one `HELLO_ACK` that takes a start away without starting anything says why in
    `startOff`.
- **Where one match's log ends and the next begins.** A match's log ends at the entry that ends its last game.
  `MATCH_END` (never logged) means "this match is over, back to the lobby": nobody leaves and no connection
  closes; `games` is how many of its games have a `RESULT`. `END_REQUEST` (client -> host) ends the open match
  between games. During a game only the lobby's PC ends it, **for everyone**: no `FORFEIT` is logged and no
  `RESULT` is sent for that game; the log stops where it stands, and `MATCH_END.abandoned` names the game. The
  next match's log starts from nothing: index 0, `prevHash` 64 zeros, its own `MATCH_READY`, `grantSeq` from 1.
  Nothing chains one match to the next. The envelope's `seq` is per sender for the whole lobby and never starts
  over.
- **A watcher** receives what a player receives: every logged message, `STATE`, `DMD_FRAME`, `RESULT`. It keeps
  the same log and checks the same `RESULT`. It reports nothing and signs nothing: the host rejects a
  `BALL_END`, `GAME_OVER`, `FORFEIT`, `PAUSE`, `RESUME` or `LOG_SIGN` from a member who is not in the game
  (`unexpected_state`) and drops their `STATE` and `DMD_FRAME`. It is never granted. `STATE`, `DMD_FRAME` and
  `MEDIA_SIGNAL` go to every member, not to a match's roster.
- **The log, unasked and in pages.** A member who joins while a match is open is sent `HELLO_ACK` (whose
  `match` names it) and then that match's whole log in `MATCH_LOG` messages of at most 100 entries (about
  50 KB; the relay takes 256 KB a frame). The first says `restart`: the receiver starts an empty log for
  `match`. Each entry is checked against the hash chain as it is appended. **Every page names the head of the
  log at the page's end** (`logHash`, `logLength`), and the receiver's head must be that after it. At the page
  that says `more: false` the receiver is current, and the `RESULT`s of the match that are out follow.
  **The host sends a logged message only to members whose log it has sent in full**: an entry committed while
  the pages go out is in a later page, never on the wire beside them. **A client takes a logged message, and a
  `RESULT`, only into a log it holds in full for the match the envelope names**, and drops any other. Without
  these two rules a `BALL_END` that falls between the `HELLO_ACK` and the log would be entry 0 of the
  newcomer's log, and the log that follows would not fit on it.
- **Away.** A member whose link drops, past the grace of Pauses and timeouts, is away: `HELLO_ACK.away` lists
  them, their place is kept, and nothing is logged. A link that drops changes the game only for the member
  whose link it is, and only when the game needs them:
  - a member the game does not need (a watcher; anyone while no game is played; a player whose own game is
    over) keeps the place for 3 minutes, then the row goes;
  - a player the game still needs changes nothing during another player's ball. When the turn reaches them, or
    when they hold the grant, the game is paused for them (`PAUSE(disconnect, player)`), and from that pause
    the host waits 3 minutes, then forfeits them (`FORFEIT` from the host; `disconnected` in the `RESULT`) and
    resumes. A player who holds the grant and whose picture still reaches the lobby's PC is never forfeited by
    the clock: the owner of the lobby's PC decides (wait on, end their ball with `TURN_PASS`, or play on
    without them);
  - while the lobby's PC is itself cut off from the relay, the members' links drop through no fault of theirs:
    no leave is counted, nobody is paused for, both waits stand still, and they start from zero (after a new
    grace) when it is back.
- **`RECONNECT` is how a member comes back in every phase**, the lobby with no match open included. The
  envelope's `matchId` is the lobby's code; `match` is the match the member holds a log of (null: none), and
  `logHash` / `logLength` its head. The signature is over `{lobby, player, match, logHash, logLength, seq}`,
  `seq` being the envelope's own, with the member's key as the lobby holds it (a watcher is in no match's
  roster). The host checks the signature first and then takes the `seq` only when it is above the last it
  took from that member: the same frame sent a second time is refused (`stale_seq`), and in a new envelope its
  signature does not verify (`bad_signature`). A refused `RECONNECT` changes nothing about the member it names.
  The answer:
  - the same match is open and the head is known: the entries after it. More than 100: the first 100, `more`,
    and the rest in `MATCH_LOG` (`restart: false`);
  - another match is open, or none, or the head is not in the host's log: `restart`: the member puts its log
    away, and the open match's whole log follows in `MATCH_LOG` (nothing follows when none is open);
  - the member's place is gone: `unknown_player`. The link stays open, and the member says `HELLO` on it: a
    newcomer, which a lobby takes while there is room.
  **Every `RECONNECT_ACK` names the head of the log it carries**: with entries, the hash and the place of the
  last one; a `restart` or a refusal, which carry no log, 64 zeros and 0. After the answer the host sends the
  lobby as it is now (`HELLO_ACK`), then the `RESULT`s. The member then sends again what the host never
  answered (Pauses and timeouts), so a ball that ended while the link was down, or while the lobby's PC was
  away, is reported once the link is back.
- **The lobby's PC away.** It is the one PC a match depends on. A member whose link to it is down goes on
  trying to come back for 20 minutes, then treats the host as gone. Meanwhile the ball in play is the
  player's own; its end is kept and reported on the return, as above. (How often a member may ask the relay
  for a room that is not there is the transport's rule.)
- **The envelope's `matchId`**: the lobby's code on what is said to the lobby (`RECONNECT`, `RECONNECT_ACK` in
  answer to it, `START_REQUEST`, `START_CANCEL`, `END_REQUEST`, `TABLE_PICK`, `PARTICIPANT_UPDATE`,
  `MEDIA_SIGNAL`, `MATCH_LOG`, `LOBBY_CLOSED`), the open match's id on the messages of a match. The host takes
  the open match's id on a lobby message too. A match frame with the id of a match that is over, or with none
  open, is dropped by whoever receives it (the host says so with a `REJECT`, except for `STATE` and
  `DMD_FRAME`). And because `grantSeq` starts at 1 in every match, a client also checks a grant against the
  `matchId` inside it, which is signed, and forgets the last `grantSeq` it saw when a match ends.
- **`LOBBY_CLOSED`** (host -> all, never logged): the lobby is over. An open match is ended first (`MATCH_END`;
  a game that is being played is ended for everyone). Every member tears down, and nobody reconnects
  afterwards.
- **No host transfer in a lobby**: the host never proposes one, and a client drops a `HOST_TRANSFER` and never
  proposes itself. (The transfer of a match without a lobby is unchanged.)

## Simultaneous mode (arcade)

`MATCH_READY.turnMode = "simultaneous"` skips `TURN_GRANT` and `BALL_END` entirely: RetroArch's player
slots decide whose input counts, every client sends `STATE` and `GAME_OVER`, and `RESULT` follows.

## DMD bitmap encoding (`rle8-base64`)

Pixels in row-major order, one value per pixel of `bitsPerPixel` bits (2, 4 or 8), run-length encoded as
byte pairs `(count, value)` with `count` 1..255, then base64. Text displays use the `text` variant.
