import { z } from 'zod';
import { PROTOCOL_VERSION } from './version.js';

/*
 * Castcade match messages. Source of truth: these zod schemas. `scripts/generate.ts` renders
 * them to `schemas/*.schema.json` and `SPEC.md`; CI fails if those are stale.
 *
 * Vocabulary (ADR 0002): a match is a Throwdown; the arbiter is the *host*; everyone else is a
 * *client*; the turn token is a *grant*. Transport is JSON text frames, one envelope per frame.
 */

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

export const PlayerId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .describe('Stable participant id for this match: the ArcAid user id, or a fakeclient label.');
export type PlayerId = z.infer<typeof PlayerId>;

export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('Lower-case hex SHA-256.');

export const Base64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .describe('Standard base64, padded.');

export const PublicKey = Base64.describe('Ed25519 public key, 32 raw bytes, base64.');
export const Signature = Base64.describe('Ed25519 signature, 64 raw bytes, base64, over canonical JSON.');

export const MatchId = z
  .string()
  .min(1)
  .max(64)
  .describe('The Throwdown code from ArcAid, or any unique string in a local/fake match.');

export const BallNumber = z.number().int().min(1).max(99).describe('1-based ball number within a game.');
export const Score = z.number().int().min(0).max(1_000_000_000_000).describe('Score as an integer; no decimals.');

export const RigDevice = z.enum(['pc', 'vr_headset', 'real_cabinet']).describe("The player's declared rig, for provenance (ArcAid badge, never a gate).");

export const DetectorReason = z
  .enum(['nvram', 'script', 'display', 'physical', 'manual', 'timeout'])
  .describe('Which signal produced the ball end: ROM NVRAM map, table script hook, display text, physical heuristic, a human click, or the host timeout.');

export const GameFingerprint = z
  .object({
    kind: z.enum(['vpx', 'arcade']).describe('Emulator family.'),
    tableName: z.string().min(1).max(200).describe('Human name of the table or ROM set.'),
    tableHash: Sha256Hex.describe('SHA-256 of the ORIGINAL .vpx (never the patched copy), or of the arcade ROM zip.'),
    romName: z.string().max(64).nullable().describe('PinMAME ROM set name (e.g. mm_109c) or arcade ROM name; null for originals.'),
    romHash: Sha256Hex.nullable().describe('SHA-256 of the ROM zip; null for originals.'),
    physicsHash: Sha256Hex.nullable().describe('Hash of the physics-relevant table settings; null when not computed.'),
    recipeVersion: z.string().max(32).nullable().describe('Castcade patch recipe version applied to this table (ADR 0004); null for arcade.'),
    sidecarHash: Sha256Hex.nullable().describe('SHA-256 of the generated sidecar .vbs; proves both players run the same patch.'),
    emulatorVersion: z.string().max(64).describe('VPX or RetroArch core version string.'),
  })
  .describe('Everything that must match between participants for a fair match. The host compares these at HELLO.');
export type GameFingerprint = z.infer<typeof GameFingerprint>;

export const ParticipantInfo = z.object({
  playerId: PlayerId,
  displayName: z.string().min(1).max(64),
  publicKey: PublicKey,
  rig: RigDevice,
});
export type ParticipantInfo = z.infer<typeof ParticipantInfo>;

export const GrantBody = z
  .object({
    matchId: MatchId,
    player: PlayerId.describe('Who may play.'),
    ballNumber: BallNumber.describe('Which ball of their game this grant covers.'),
    grantSeq: z.number().int().min(1).describe('Monotonic per match; a client ignores a grant with a lower seq than one it has seen.'),
    issuedAt: z.number().int().describe('Host clock, ms since epoch.'),
    logHash: Sha256Hex.describe('Hash of the host log head when the grant was issued; lets a client detect a forked log.'),
  })
  .describe('The signed part of a TURN_GRANT. Signature is over canonicalJson(GrantBody).');
export type GrantBody = z.infer<typeof GrantBody>;

// ---------------------------------------------------------------------------------------------
// Payloads, one per message type
// ---------------------------------------------------------------------------------------------

export const Hello = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    companionVersion: z.string().max(32),
    throwdownCode: MatchId.describe('The Throwdown the client wants to join.'),
    participant: ParticipantInfo,
    game: GameFingerprint,
  })
  .describe('client -> host. First message on a connection.');

export const HelloAck = z
  .object({
    hostPlayerId: PlayerId,
    hostPublicKey: PublicKey.describe('Clients verify every TURN_GRANT against this key.'),
    participants: z.array(ParticipantInfo).describe('Everyone accepted so far, in join order.'),
    hostGame: GameFingerprint.nullable()
      .default(null)
      .describe("The host's fingerprint, so a client the host accepted despite a difference (advisory mode) can show it too. null from a host that does not send it."),
  })
  .describe('host -> client. The HELLO was accepted; the match is not ready until MATCH_READY. Sent again to every client while in the lobby when a PARTICIPANT_UPDATE (or the host itself) changed the roster or the host fingerprint.');

// A6 (2026-10-31, the first two-player match): a client that joined before its table loaded said `pc` and a blank
// table hash in HELLO, and nothing corrected them, so its roster row read "PC · different table file" for the match.
export const ParticipantUpdate = z
  .object({
    rig: RigDevice.optional().describe("The sender's rig now, when it changed since HELLO."),
    game: GameFingerprint.optional().describe("The sender's fingerprint now, when its table changed since HELLO."),
  })
  .describe(
    "client -> host, in the lobby only. Replaces the sender's HELLO `participant.rig` and `game`; the host compares the fingerprint again and re-sends HELLO_ACK to every client. Ignored once MATCH_READY went out (the roster in the log is final).",
  );

export const Refuse = z
  .object({
    code: z.enum(['protocol_version', 'fingerprint_mismatch', 'match_full', 'unknown_throwdown', 'duplicate_player', 'match_started', 'other']),
    message: z.string().max(500),
    mismatches: z
      .array(
        z.object({
          field: z.string().describe('GameFingerprint field name.'),
          expected: z.string().nullable(),
          received: z.string().nullable(),
          expectedFrom: PlayerId.describe('Which participant the host compared against.'),
        }),
      )
      .default([])
      .describe('Populated for fingerprint_mismatch so the UI can say exactly which side differs.'),
  })
  .describe('host -> client. The HELLO was rejected; the host closes the connection after sending.');

export const MatchReady = z
  .object({
    matchId: MatchId,
    ballsPerGame: z.number().int().min(1).max(10),
    playerOrder: z.array(PlayerId).min(2).max(4).describe('Rotation order. Ball 1 of each player in this order, then ball 2, and so on.'),
    participants: z.array(ParticipantInfo).min(2).max(4),
    hostPlayerId: PlayerId,
    hostPublicKey: PublicKey,
    game: GameFingerprint.describe('The agreed fingerprint every participant matched.'),
    seed: z.string().max(64).nullable().describe('Unused in v1; reserved for v2 determinism.'),
    turnMode: z.enum(['alternating', 'simultaneous']).describe('Simultaneous (arcade netplay) skips TURN_GRANT entirely.'),
  })
  .describe('host -> all. The roster is final; grants follow.');

export const TurnGrant = z
  .object({
    grant: GrantBody,
    grantSig: Signature.describe("Host's signature over canonicalJson(grant)."),
  })
  .describe('host -> all. Names the player whose input unlocks; every participant logs it. Verified by the companion before the lock is released.');

export const State = z
  .object({
    ballNumber: BallNumber,
    score: Score,
    ballInPlay: z.boolean(),
    tilt: z.boolean(),
    extraBalls: z.number().int().min(0).default(0),
  })
  .describe('client -> host at up to 10 Hz, mirrored host -> other clients with `from` preserved. Drives the overlay; never trusted for results.');

export const DmdFrame = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('bitmap'),
      width: z.number().int().min(1).max(512),
      height: z.number().int().min(1).max(128),
      bitsPerPixel: z.union([z.literal(2), z.literal(4), z.literal(8)]),
      encoding: z.literal('rle8-base64').describe('Byte-oriented run-length encoding, then base64; defined in SPEC.md.'),
      data: Base64,
    }),
    z.object({
      kind: z.literal('text'),
      lines: z.array(z.string().max(64)).min(1).max(4),
    }),
  ])
  .describe('client -> host on change, mirrored to the other clients. Drawn crisp in the overlay.');

export const BallEnd = z
  .object({
    grantSeq: z.number().int().min(1).describe('The grant this ball end answers. Must match the current grant or the host rejects it.'),
    ballNumber: BallNumber,
    finalScore: Score.describe("The player's score after end-of-ball bonus (see SPEC: sample at the next boundary, not at the drain)."),
    detectorReason: DetectorReason,
    shootAgain: z.boolean().describe('True when the detector saw an extra ball: the host re-grants the same player and ball.'),
  })
  .describe('client -> host. Accepted only from the current grant holder.');

export const GameOver = z
  .object({
    finalScore: Score,
    ballsPlayed: z.number().int().min(0),
  })
  .describe("client -> host when that side's game reaches game over.");

export const HostTransfer = z
  .object({
    proposer: PlayerId.describe('Who sent the proposal: the current host when planned, the candidate itself when the host is gone.'),
    newHost: PlayerId.describe('Who becomes host; equals proposer for host_left.'),
    reason: z.enum(['host_left', 'host_requested']),
    logHash: Sha256Hex.describe("The proposer's log head; acceptors must hold the same hash."),
    logLength: z.number().int().min(0),
    currentGrant: TurnGrant.nullable().describe('The last grant the proposer saw, so the match resumes at the same handoff.'),
    newHostPublicKey: PublicKey.describe('Grants after the transfer are signed with this key. Must equal the roster entry for newHost.'),
    // A2 (2026-10-30): over WebSocket the other participants must know where the new host listens.
    newHostEndpoint: z
      .string()
      .max(256)
      .regex(/^wss?:\/\/\S+$/)
      .nullable()
      .default(null)
      .describe("The new host's listener (ws:// or wss:// URL); everyone else reconnects there. null on a transport without per-host sockets."),
  })
  .describe('host -> all, or client -> all when the host is gone. Takes effect when a majority of the remaining participants ack it.');

export const HostTransferAck = z
  .object({
    proposer: PlayerId,
    accept: z.boolean(),
    logHash: Sha256Hex.describe("The acker's own log head, for diagnosis when accept is false."),
  })
  .describe('client -> proposer (and all).');

// A2 (2026-10-30): RECONNECT_ACK carries log entries verbatim, so the log entry shape is part of the wire.
export const LogEvent = z
  .object({
    type: z.literal('host_transfer'),
    reason: z.enum(['host_left', 'host_requested']),
    proposer: PlayerId,
    from: PlayerId.describe('The host before the transfer.'),
    to: PlayerId.describe('The host after the transfer.'),
    newHostPublicKey: PublicKey,
  })
  .describe('The derived log entry that commits an accepted HOST_TRANSFER.');

export const LogEntry = z
  .object({
    index: z.number().int().min(0),
    prevHash: Sha256Hex.describe('Hash of the previous entry; 64 zeros before the first.'),
    ts: z.number().int().describe("The causing message's own ts, never a local clock."),
    kind: z.enum(['msg', 'grant', 'event']),
    from: PlayerId,
    message: z.record(z.string(), z.unknown()).optional().describe('The logged envelope, verbatim; absent on an event entry.'),
    event: LogEvent.optional().describe('Present only when kind is event.'),
    hash: Sha256Hex.describe('sha256(canonicalJson(entry without hash)).'),
  })
  .describe('One entry of the hash-chained match log, exactly as every participant holds it.');

export const LogSign = z
  .object({
    logHash: Sha256Hex,
    logLength: z.number().int().min(0),
    signature: Signature.describe("The participant's signature over canonicalJson({matchId, logHash, logLength}).")
  })
  .describe('client -> host at game over, once every game in the match has ended.');

export const ResultEntry = z.object({
  playerId: PlayerId,
  score: Score,
  ballsPlayed: z.number().int().min(0),
  status: z.enum(['finished', 'forfeit', 'abandoned', 'disconnected']),
  rank: z.number().int().min(1).describe('1 = winner; ties share a rank.'),
});

export const Result = z
  .object({
    matchId: MatchId,
    entries: z.array(ResultEntry).min(2).max(4),
    winner: PlayerId.nullable().describe('null on a tie for first.'),
    logHash: Sha256Hex,
    logLength: z.number().int().min(0),
    hostSignature: Signature,
    signatures: z
      .array(z.object({ playerId: PlayerId, signature: Signature, logHash: Sha256Hex, logLength: z.number().int().min(0) }))
      .describe('Every LOG_SIGN received, with the head each participant actually signed; missing or disagreeing ones are flagged on the ArcAid side, never rejected.'),
    hostTransfers: z.number().int().min(0),
    startedAt: z.number().int(),
    finishedAt: z.number().int(),
  })
  .describe('host -> all, and posted to ArcAid as the Throwdown result plus a castcade_matches record.');

export const Pause = z
  .object({
    reason: z.enum(['disconnect', 'ball_end_timeout', 'desync', 'requested']),
    player: PlayerId.nullable().describe('The participant the pause is about, if any.'),
  })
  .describe('either direction. The match is held; TURN_GRANTs stop until RESUME.');

export const Resume = z.object({}).describe('either direction. Clears a PAUSE.');

export const Forfeit = z
  .object({
    player: PlayerId,
    reason: z.string().max(200),
  })
  .describe('either direction. The named player leaves the match; their remaining balls are scored as played.');

export const Reject = z
  .object({
    refSeq: z.number().int().min(0).describe('The seq of the message being rejected.'),
    refType: z.string().max(32),
    code: z.enum(['not_grant_holder', 'stale_grant', 'bad_signature', 'unexpected_state', 'schema', 'unknown_player']),
    message: z.string().max(500),
  })
  .describe('host -> client. A message was ignored; diagnostic only, never changes match state.');

export const Reconnect = z
  .object({
    player: PlayerId.describe('Who is resuming; must equal the envelope from.'),
    logHash: Sha256Hex.describe('Hash of the last log entry this participant holds; 64 zeros when it holds none.'),
    logLength: z.number().int().min(0),
    signature: Signature.describe("The participant's signature over canonicalJson({matchId, player, logHash, logLength}) with its roster key."),
  })
  .describe('client -> host. First frame on a new socket to the current host, after a drop or a host transfer; never a fresh HELLO.');

export const ReconnectAck = z
  .object({
    accept: z.boolean(),
    code: z
      .enum(['unknown_log_hash', 'unknown_player', 'bad_signature', 'match_not_started'])
      .nullable()
      .describe('Why the RECONNECT was rejected; null when accepted.'),
    entries: z.array(LogEntry).describe('Every log entry after the one the client named, in order; empty when it is current or rejected.'),
    logHash: Sha256Hex.describe("The host's log head after these entries."),
    logLength: z.number().int().min(0),
  })
  .describe('host -> client. Answers RECONNECT. A rejected client must re-join with a fresh HELLO; the host closes the socket after a rejection.');

// D2 (2026-10-30): the WebRTC signalling for a match's video and voice rides the match channel; the media itself
// goes peer to peer, never through the host's match socket or ArcAid.
export const IceCandidate = z
  .object({
    candidate: z.string().max(4096).describe("The browser's candidate line; empty for end-of-candidates."),
    sdpMid: z.string().max(64).nullable(),
    sdpMLineIndex: z.number().int().min(0).max(255).nullable(),
  })
  .describe('One trickled ICE candidate, as RTCIceCandidate.toJSON() gives it.');

export const MediaSignal = z
  .object({
    to: PlayerId.describe('The one participant this signal is for. The host forwards it there and nowhere else.'),
    kind: z.enum(['offer', 'answer', 'ice']).describe('An SDP offer or answer, or one ICE candidate.'),
    sdp: z.string().max(65_536).optional().describe('The session description; present on offer and answer.'),
    candidate: IceCandidate.optional().describe('Present on ice.'),
  })
  .refine((s) => (s.kind === 'ice' ? s.candidate !== undefined : s.sdp !== undefined), {
    message: 'an offer or answer carries sdp; an ice signal carries candidate',
  })
  .describe(
    'any -> `to`, through the host: it forwards the frame to `to` only, `from` preserved. Sets up the peer-to-peer video and voice between two participants; never logged, never trusted for anything but media.',
  );

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

export const payloadSchemas = {
  HELLO: Hello,
  HELLO_ACK: HelloAck,
  REFUSE: Refuse,
  MATCH_READY: MatchReady,
  TURN_GRANT: TurnGrant,
  STATE: State,
  DMD_FRAME: DmdFrame,
  BALL_END: BallEnd,
  GAME_OVER: GameOver,
  HOST_TRANSFER: HostTransfer,
  HOST_TRANSFER_ACK: HostTransferAck,
  LOG_SIGN: LogSign,
  RESULT: Result,
  PAUSE: Pause,
  RESUME: Resume,
  FORFEIT: Forfeit,
  REJECT: Reject,
  RECONNECT: Reconnect,
  RECONNECT_ACK: ReconnectAck,
  MEDIA_SIGNAL: MediaSignal,
  PARTICIPANT_UPDATE: ParticipantUpdate,
} as const;

export type MessageType = keyof typeof payloadSchemas;
export const MESSAGE_TYPES = Object.keys(payloadSchemas) as MessageType[];

export type PayloadOf<T extends MessageType> = z.infer<(typeof payloadSchemas)[T]>;
export type PayloadInput<T extends MessageType> = z.input<(typeof payloadSchemas)[T]>;

/** Who may send each message. Used by the host and client state machines and printed in SPEC.md. */
export const MESSAGE_DIRECTION: Record<MessageType, 'client->host' | 'host->client' | 'host->all' | 'any'> = {
  HELLO: 'client->host',
  HELLO_ACK: 'host->client',
  REFUSE: 'host->client',
  MATCH_READY: 'host->all',
  TURN_GRANT: 'host->all',
  STATE: 'any',
  DMD_FRAME: 'any',
  BALL_END: 'client->host',
  GAME_OVER: 'client->host',
  HOST_TRANSFER: 'any',
  HOST_TRANSFER_ACK: 'any',
  LOG_SIGN: 'client->host',
  RESULT: 'host->all',
  PAUSE: 'any',
  RESUME: 'any',
  FORFEIT: 'any',
  REJECT: 'host->client',
  RECONNECT: 'client->host',
  RECONNECT_ACK: 'host->client',
  MEDIA_SIGNAL: 'any',
  PARTICIPANT_UPDATE: 'client->host',
};
