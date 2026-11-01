/**
 * The single protocol version. Bump on any change to a message shape, the envelope, or
 * canonical JSON. Peers with different versions refuse each other at HELLO.
 * 2 (2026-10-30, A2/A3): HOST_TRANSFER.newHostEndpoint, RECONNECT and RECONNECT_ACK; MEDIA_SIGNAL (D2, same
 *   unreleased version). PARTICIPANT_UPDATE (A6, 2026-10-31): optional and lobby-only, so still 2 (a host that does
 *   not know it drops the frame, and the roster stays as HELLO said). HELLO_ACK.tableMismatches (A8, 2026-10-31):
 *   defaulted to [] and never logged, so still 2 (a field added to a LOGGED message would change its hash for a peer
 *   that does not know it: zod drops unknown keys and fills defaults).
 */
export const PROTOCOL_VERSION = 2 as const;
