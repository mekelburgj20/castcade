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
  })
  .describe('host -> client. The HELLO was accepted; the match is not ready until MATCH_READY.');

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
  })
  .describe('host -> all, or client -> all when the host is gone. Takes effect when a majority of the remaining participants ack it.');

export const HostTransferAck = z
  .object({
    proposer: PlayerId,
    accept: z.boolean(),
    logHash: Sha256Hex.describe("The acker's own log head, for diagnosis when accept is false."),
  })
  .describe('client -> proposer (and all).');

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
};
