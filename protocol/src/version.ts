/**
 * The single protocol version. Bump on any change to a message shape, the envelope, or
 * canonical JSON. Peers with different versions refuse each other at HELLO.
 * 2 (2026-10-30, A2/A3): HOST_TRANSFER.newHostEndpoint, RECONNECT and RECONNECT_ACK; MEDIA_SIGNAL (D2, same
 *   unreleased version). PARTICIPANT_UPDATE (A6, 2026-10-31): optional and lobby-only, so still 2 (a host that does
 *   not know it drops the frame, and the roster stays as HELLO said). HELLO_ACK.tableMismatches (A8, 2026-10-31):
 *   defaulted to [] and never logged, so still 2 (a field added to a LOGGED message would change its hash for a peer
 *   that does not know it: zod drops unknown keys and fills defaults). MEDIA_SIGNAL kinds `reset` (D2.7) and `stereo`
 *   (D7.4.3) and PARTICIPANT_UPDATE in any phase (A6.1), all 2026-11-01: never logged, and a peer that does not know
 *   them drops the frame, so still 2.
 * 3 (2026-11-02, A10 + A11): a match is a series of games. NEXT_GAME (logged) starts game N+1 in the same log,
 *   MATCH_END (not logged) closes the series; `GrantBody.game`, `RESULT.game` and `RESULT.series`; HELLO_ACK
 *   `startsInMs` (the lobby countdown) and `loading`. A new logged message type, so a peer on 2 could not follow the
 *   log: both rigs run the same build through the updater.
 * 4 (2026-11-07, D10.3): MEDIA_SIGNAL `channel` (`rtc` | `video`, defaulted to `rtc`, never logged). Additive in
 *   shape, but a peer that does not know it would not drop the frame: zod strips the unknown key, so a 0.2.36 peer
 *   would feed the native helper's `video` offer to its Electron page as its own. A version bump makes mixed builds
 *   refuse each other at HELLO instead; every rig updates through the updater, so nothing is lost (lead's decision).
 * 5 (2026-11-12, A13): TURN_PASS (logged): the host ends the grant holder's ball by hand. A new logged message type,
 *   like NEXT_GAME in 3: a peer on 4 would drop the frame, miss the entry and fold a different state. The same item's
 *   `ballEndReady` (HELLO, PARTICIPANT_UPDATE, HELLO_ACK) is optional / defaulted and never logged, and alone would
 *   have stayed 4 (as A8's `tableMismatches` stayed 2): absent reads as unknown. PARTICIPANT_UPDATE `advisory` (B26,
 *   2026-11-16, the Midnight Madness flag): optional, never logged, after MATCH_READY only, so still 5. A 0.2.41–0.2.43
 *   peer strips the key: as the host it relays nothing (an update with no new rig is not passed on), as a client it
 *   drops the frame (`unexpected`); either way the flag is lost for that peer and nothing else changes. B26.4 (same
 *   day, same unreleased build): the flag is raised by the ROM's own audit, not the clock, and the setting that
 *   enables the mode travels as PARTICIPANT_UPDATE `midnightMode` / HELLO_ACK `midnightModes` (optional / defaulted,
 *   never logged): an older peer strips both and sees and reports nothing.
 * 6 (2026-11-19, I11.4.2): MEDIA_SIGNAL `channel` gains `stream`: the data-only connection between two companions that
 *   carries the VPX fork's state stream inside a match (docs/design/state-stream-in-match.md §4.1). The same reasoning
 *   as 4, from the other side: a peer on 5 refuses the value (its enum is `rtc` | `video`), so the frame does not decode
 *   there, the pair's stream connection never opens and one PC waits for an answer that never comes. A version bump
 *   makes mixed builds refuse each other at HELLO instead; every rig updates through the updater. Never logged.
 *   I11.4.9 (2026-11-20, the first turn starts in 3D): PARTICIPANT_UPDATE `stream3dWaitMs` (optional) and HELLO_ACK
 *   `stream3dWait` (defaulted), both never logged, so still 6, by the precedent of `ballEndReady` in 5. A 0.2.46 peer
 *   strips the keys (zod objects are not strict): as the host it lists nobody and waits for nobody, which is what it
 *   did; as a client it never says it is waiting and is never waited for, and it ignores the list.
 *   I11.4.15 (2026-11-24, the table a joining PC opens): HELLO_ACK `hostTableObjects` (defaulted to null, never
 *   logged), so still 6, by the same precedent. A 0.2.46 to 0.2.50 client strips the key and picks its table by the
 *   file hash and the name, as it did; a host of those builds never sends it, and a new client then ranks its copies
 *   as before. Not a field of `GameFingerprint`: that object is also MATCH_READY's `game`, which is logged.
 */
/*
 * 7 (2026-11-25, A17 step 7: the companion's shell turns the lobby on; docs/design/alpha-match.md section 11.7). A
 *   host is a lobby from here on: one connection for an evening, any number of matches in it, people who watch. Each
 *   key and message of it alone would have stayed 6 by the precedent of `ballEndReady` (all are optional and never
 *   logged, and they came into the schemas in steps 5 and 6 behind an option that was off). Together they change what
 *   a peer must do, and a lobby of mixed builds half works: a 0.2.50 client cannot decode the seven new message types
 *   (START_REQUEST, START_CANCEL, END_REQUEST, TABLE_PICK, LEAVE_LOBBY, MATCH_LOG, LOBBY_CLOSED), reads MATCH_END as
 *   the end of the evening and leaves, and comes back with a RECONNECT the lobby does not take; a 0.2.50 host refuses
 *   a join after the first game and answers none of what a member asks. So they refuse each other at HELLO, each
 *   with a sentence that names the PC that has to update (`transport-ws.ts`).
 *   What a lobby does on the wire, against 6: HELLO (`stance`, `proof`) is taken in every phase and HELLO_ACK is the
 *   lobby as it is now, in every phase; PARTICIPANT_UPDATE (`stance`, `noCopy`, `ownGame`) counts in every phase;
 *   MATCH_READY's id is `<lobby code>-<n>` and its roster the players only (the host need not be one); MATCH_END
 *   means "back to the lobby", may say `games: 0` and may name a game that was ended for everyone (`abandoned`);
 *   the logged stream goes only to members who hold the log (MATCH_LOG brings it, in pages); no host transfer.
 *   **RECONNECT has one signed body in protocol 7**, with or without a lobby: `{lobby, host, player, match, logHash,
 *   logLength, seq}`: the PC the frame is addressed to and the envelope's own `seq` are under the signature, so a
 *   RECONNECT is good for one use at one PC, and a protocol 7 host takes no other body. (Up to 6 the body was
 *   `{matchId, player, logHash, logLength}`.) RECONNECT_ACK gains `match`, `restart`, `more`, `closed`, `seqAbove`
 *   and the codes `stale_seq` and `protocol_version` (the last one is what a RECONNECT of another version is
 *   answered with when the asker is on 7 or later; an asker up to 6 does not know it and gets `unknown_player`).
 *   No logged message changes shape, so a protocol 6 log and a protocol 7 match's log fold the same way. The engines
 *   still have the lobby as an option (`HostOptions.lobby`, `ClientOptions.lobby`): the companion always sets it; with
 *   it off an engine runs one match as before (the fakeclient, the engine's own tests), on the same version 7.
 */
export const PROTOCOL_VERSION = 7 as const;
