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
 */
/*
 * A17 step 5 (2026-11-25), the lobby's schemas, and STILL 6. The lobby (alpha-match.md §11.7) will be protocol 7, in
 * the build whose shell turns it on; until then the engine's lobby sits behind an option that is off
 * (`HostOptions.lobby`, `ClientOptions.lobby`), and what is added here is never on the wire of a match:
 * - six new message types (START_REQUEST, START_CANCEL, END_REQUEST, TABLE_PICK, LOBBY_CLOSED, MATCH_LOG): only a
 *   lobby sends them. A peer up to 0.2.50 could not decode one (the envelope's `type` is a closed list there), so
 *   none may be sent to it, and none is;
 * - new keys on HELLO (`stance`), PARTICIPANT_UPDATE (`stance`, `noCopy`, `ownGame`), HELLO_ACK (the lobby as it is),
 *   MATCH_END (`abandoned`), RECONNECT (`match`) and RECONNECT_ACK (`match`, `restart`, `more`): every one optional,
 *   with no default, so a frame built without a lobby is byte for byte the frame 0.2.50 builds
 *   (`companion/src/match/lobby-off.test.ts` compares a whole match against frames recorded before this step);
 * - MATCH_END `games` may be 0 (it was 1 or more): the message is never logged, and no match without a lobby sends 0.
 * So every build before the one that says 7 plays with 0.2.46 to 0.2.50, and a fix can still be released on 6.
 */
export const PROTOCOL_VERSION = 6 as const;
