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
 *   log: both rigs run the same build through the updater. MEDIA_SIGNAL `channel` (D10.3, 2026-11-07): optional,
 *   defaulted to `rtc`, never logged, so still 3 (a peer without the native video helper ignores `video` signals).
 */
export const PROTOCOL_VERSION = 3 as const;
