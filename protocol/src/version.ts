/**
 * The single protocol version. Bump on any change to a message shape, the envelope, or
 * canonical JSON. Peers with different versions refuse each other at HELLO.
 */
export const PROTOCOL_VERSION = 1 as const;
