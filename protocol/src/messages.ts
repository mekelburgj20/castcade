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
export const GameNumber = z.number().int().min(1).max(999).describe('1-based game number within a match (a series, A10).');
export const Score = z.number().int().min(0).max(1_000_000_000_000).describe('Score as an integer; no decimals.');

export const RigDevice = z.enum(['pc', 'vr_headset', 'real_cabinet']).describe("The player's declared rig, for provenance (ArcAid badge, never a gate).");

// A17 (2026-11-25): what a member of a lobby wants at the next start. An enum, so a third choice later is a value,
// not a field.
export const Stance = z.enum(['play', 'watch']).describe('A17: Play or Watch at the next start of a match in the lobby. Never logged: a match only knows its players.');
export type Stance = z.infer<typeof Stance>;

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
    // A10 (2026-11-02): no default on purpose: GrantBody is signed and logged, and a default would make a peer that
    // parses a grant without it hash and verify a different object. A protocol 3 host always sends it.
    game: GameNumber.optional().describe('Which game of the series this grant belongs to (1-based; protocol 3 hosts always send it).'),
  })
  .describe('The signed part of a TURN_GRANT. Signature is over canonicalJson(GrantBody).');
export type GrantBody = z.infer<typeof GrantBody>;

// ---------------------------------------------------------------------------------------------
// Payloads, one per message type
// ---------------------------------------------------------------------------------------------

export const FingerprintMismatch = z.object({
  field: z.string().describe('GameFingerprint field name.'),
  expected: z.string().nullable(),
  received: z.string().nullable(),
  expectedFrom: PlayerId.describe('Which participant the host compared against.'),
});

export const Hello = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    companionVersion: z.string().max(32),
    throwdownCode: MatchId.describe('The Throwdown the client wants to join.'),
    participant: ParticipantInfo,
    game: GameFingerprint,
    // A13 (2026-11-12): optional and never logged; a peer that does not know it strips it, and absent reads as unknown.
    ballEndReady: z
      .boolean()
      .optional()
      .describe("A13: whether the sender's companion can report this table's ball ends (it follows the table's hook journal): false when a table is open and it cannot (not patched, an original table, an unreadable machine). Absent: unknown (no table open yet, or a companion from before A13)."),
    // A17 (2026-11-25): optional and never logged. Sent only to a lobby (the lobby is off until the build that makes
    // the protocol 7); a host that does not know it strips it.
    stance: Stance.optional().describe('A17: Play or Watch at the next start. Absent: play.'),
  })
  .describe('client -> host. First message on a connection.');

// A17 (2026-11-25): the lobby as it is now, on HELLO_ACK. Every key is OPTIONAL and none is logged: a host whose
// lobby is off sends none of them, so its HELLO_ACK is byte for byte what a 0.2.50 host sends, and absent reads as
// the value named in each description. (The design, alpha-match.md 11.7, wrote them as defaulted keys; a default
// is filled in when a frame is built, which would have put ten more keys on every HELLO_ACK of a match played
// without a lobby.)
const HelloAckLobby = {
  stances: z
    .array(z.object({ playerId: PlayerId, stance: Stance }))
    .optional()
    .describe('A17: what each member wants at the next start (`HELLO.stance`, then `PARTICIPANT_UPDATE.stance`), the host included. Absent: not a lobby; a member not listed: play.'),
  away: z.array(PlayerId).optional().describe('A17: members whose link is down and whose place is kept. Absent: nobody.'),
  noCopy: z.array(PlayerId).optional().describe("A17: members whose PC has no copy of the lobby's table (`PARTICIPANT_UPDATE.noCopy`): they do not play a match that starts. Absent: nobody."),
  ownGame: z.array(PlayerId).optional().describe('A17: members on whose table a game the match does not own is running (`PARTICIPANT_UPDATE.ownGame`). Absent: nobody.'),
  otherTable: z.array(PlayerId).optional().describe("A17: members whose open table is another game than the lobby's table. Absent: nobody."),
  tablePickedBy: PlayerId.nullable().optional().describe("A17: who picked the lobby's table (`hostGame`); null or absent: the table is whatever the lobby's PC has open."),
  ballsPerGame: z.number().int().min(1).max(10).nullable().optional().describe('A17: the balls per game of a match started in this lobby. Null or absent: not said.'),
  starter: PlayerId.nullable().optional().describe('A17: the one member whose Start on their own table asks for a game. Null or absent: nobody is named.'),
  match: z
    .object({
      matchId: MatchId,
      players: z.array(PlayerId).min(2).max(4).describe('The players the match started with (its `MATCH_READY.playerOrder`).'),
      game: GameNumber.describe('The game of the match that is being played, or was played last.'),
      state: z.enum(['game', 'between']).describe('`game`: a game is being played; `between`: the last game has ended and the match is still open.'),
    })
    .nullable()
    .optional()
    .describe('A17: the match that is open in the lobby; null or absent: none. A member who joins while one is open is sent its log in MATCH_LOG right after this message, and holds no log of it until the last page.'),
  start: z
    .object({
      by: PlayerId.describe('Who asked for the start.'),
      players: z.array(PlayerId).min(2).max(4).describe('Who plays it, the first to go first.'),
      newMatch: z.boolean().describe('True: a new match; false: the next game of the open one.'),
      waitsFor: z.enum(['result', 'tables', 'other_tables', 'own_games', '3d']).nullable().describe('What the start waits for; null: it is counting down (`leftMs`).'),
      waitsOn: z.array(PlayerId).default([]).describe('The members it waits for.'),
      leftMs: z.number().int().min(0).max(120_000).nullable().describe('The ms left of the countdown, or of the wait when it has a limit; null: no limit.'),
    })
    .nullable()
    .optional()
    .describe('A17: the start that is announced, counting down or waiting; null or absent: none. Each PC in `players` locks its table when it counts down, unless a game runs on it.'),
  // A17 step 6 (2026-11-25): not in the design's list. A start can go away for a reason only the lobby's PC knows
  // (who cancelled, who set themselves to Watch, which check failed when the countdown ran out), and every panel is
  // to say it; without this key the others could only see that `start` is null again.
  startOff: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe('A17: on the one HELLO_ACK that takes an announced start away without starting anything: the sentence that says why ("Krobs cancelled the start."). Absent otherwise.'),
};

export const HelloAck = z
  .object({
    hostPlayerId: PlayerId,
    hostPublicKey: PublicKey.describe('Clients verify every TURN_GRANT against this key.'),
    participants: z.array(ParticipantInfo).describe('Everyone accepted so far, in join order.'),
    hostGame: GameFingerprint.nullable()
      .default(null)
      .describe("The host's fingerprint, so a client the host accepted despite a difference (advisory mode) can show it too. null from a host that does not send it."),
    tableMismatches: z
      .array(
        z.object({
          playerId: PlayerId,
          mismatches: z.array(FingerprintMismatch).min(1),
        }),
      )
      .default([])
      .describe(
        "A8 (2026-10-31): every accepted participant whose fingerprint differs from the host's (advisory mode), with what differs, so each client can flag the others too, not only itself. Additive and defaulted, so still protocol 2: a host that does not send it reads as no differences. Not in MATCH_READY: that message is logged, and a peer that strips or defaults an unknown field would hash a different log.",
      ),
    // A11 (2026-11-02): the match starts from the host's table; the lobby sees the countdown and who is still loading.
    startsInMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .nullable()
      .default(null)
      .describe('The host starts the match in this many ms (its first game on the table, A11); null when no start is under way. A duration, not a time: the two clocks need not agree.'),
    loading: z
      .array(PlayerId)
      .default([])
      .describe("Accepted participants whose table is not open yet, as the host judges from their fingerprint (A11): the match does not start from the table until this is empty."),
    // A13 (2026-11-12): three matches stuck at grant 1 on a table no companion could read; the lobby now says so first.
    ballEndReady: z
      .array(z.object({ playerId: PlayerId, ready: z.boolean() }))
      .default([])
      .describe(
        "A13: what each participant (the host included) said about its table's ball ends (`HELLO.ballEndReady`, then `PARTICIPANT_UPDATE.ballEndReady`): `ready` false = that player's table cannot report ball ends, so its turn would never end by itself. A participant not listed is unknown. Defaulted and never logged.",
      ),
    // B26.4 (2026-11-16): defaulted and never logged, like `ballEndReady`, so still protocol 5.
    midnightModes: z
      .array(z.object({ playerId: PlayerId, enabled: z.boolean(), adjustment: z.string().min(1).max(64) }))
      .default([])
      .describe(
        'B26.4: what each participant (the host included) said about the Midnight Madness setting on its table (`PARTICIPANT_UPDATE.midnightMode`). A participant not listed said nothing: no table open, a game with no known setting, or a companion from before B26.4. Defaulted and never logged.',
      ),
    ...HelloAckLobby,
    // I11.4.9 (2026-11-20): defaulted and never logged, like `ballEndReady`, so still protocol 6.
    stream3dWait: z
      .array(z.object({ playerId: PlayerId, leftMs: z.number().int().min(0).max(120_000) }))
      .default([])
      .describe(
        "I11.4.9: the participants (the host included) whose PC is still making its 3D connection (`PARTICIPANT_UPDATE.stream3dWaitMs`), each with the ms after which the host stops waiting for it. A start from the host's table waits until this is empty, as it waits for `loading`. A duration, not a time. A participant not listed is not waited for: its 3D connection is settled, it has none, or its companion is from before I11.4.9. Defaulted and never logged.",
      ),
  })
  .describe('host -> client. The HELLO was accepted; the match is not ready until MATCH_READY. Sent again to every client while in the lobby when a PARTICIPANT_UPDATE (or the host itself) changed the roster or the host fingerprint. In a lobby (A17) it is the lobby as it is now, and is sent to every member on every change in every phase, also while a match is played.');

// B26.4 (2026-11-16): what a player's companion read on its own table: the operator adjustment that enables Midnight
// Madness (the bonus multiball some WPC ROMs start when the machine's clock, the PC's under VPinMAME, passes
// midnight during a ball). Shown to every player; never logged, never a verdict.
export const MidnightMode = z
  .object({
    enabled: z.boolean().describe("The adjustment reads YES (true) or NO (false) in the table's NVRAM."),
    adjustment: z.string().min(1).max(64).describe('The adjustment as the service menu numbers and names it, e.g. `A.2 14 Special Mode`.'),
  })
  .describe("The Midnight Madness setting on the sender's table, as its companion read it. Display only.");
export type MidnightMode = z.infer<typeof MidnightMode>;

// B26 (2026-11-16): a flag a player's own companion raises about one of its balls. Never logged, never a verdict:
// nothing in the fold, a score, a turn or a RESULT reads it.
export const PlayerAdvisory = z
  .object({
    kind: z
      .enum(['midnight'])
      .describe("`midnight`: Midnight Madness ran on this ball. B26.4: a fact, not a guess from the clock: the ROM's own audit of the mode went up in the sender's table NVRAM while the ball was in play."),
    game: GameNumber.describe('The game of the series the ball belongs to.'),
    ballNumber: BallNumber.describe("The sender's ball the flag is about."),
  })
  .describe("An advisory flag about one ball of the sender's own game, shown to every player. A flag only.");
export type PlayerAdvisory = z.infer<typeof PlayerAdvisory>;

// A6 (2026-10-31, the first two-player match): a client that joined before its table loaded said `pc` and a blank
// table hash in HELLO, and nothing corrected them, so its roster row read "PC · different table file" for the match.
export const ParticipantUpdate = z
  .object({
    rig: RigDevice.optional().describe("The sender's rig now, when it changed since HELLO."),
    game: GameFingerprint.optional().describe("The sender's fingerprint now, when its table changed since HELLO."),
    ballEndReady: z
      .boolean()
      .optional()
      .describe("A13: whether the sender's table can report ball ends now (see `HELLO.ballEndReady`), when that changed since HELLO. Lobby only."),
    // B26 (2026-11-16): optional and never logged, so still protocol 5. A peer that does not know it strips the key
    // (zod): an older host then passes nothing on (it only relays a rig change), an older client drops the frame.
    advisory: PlayerAdvisory.optional().describe(
      "B26: after MATCH_READY only: a flag about one of the sender's own balls (see `PlayerAdvisory`). The host passes the update on to every other participant like a rig change (`from` preserved) and sends its own the same way. A peer from before B26 ignores it.",
    ),
    // B26.4 (2026-11-16): optional and never logged, so still protocol 5; a peer that does not know it strips the key.
    midnightMode: MidnightMode.optional().describe(
      "B26.4: the Midnight Madness setting on the sender's table (see `MidnightMode`), when its companion could read it, in any phase. In the lobby the host lists it in HELLO_ACK `midnightModes`; after MATCH_READY it passes the update on like a rig change. A peer from before B26.4 ignores it.",
    ),
    // I11.4.9 (2026-11-20): optional and never logged, so still protocol 6; a peer that does not know it strips the key
    // (a 0.2.46 host then waits for nobody, as it always did; a 0.2.46 client never says it and is never waited for).
    stream3dWaitMs: z
      .number()
      .int()
      .min(0)
      .max(120_000)
      .optional()
      .describe(
        "I11.4.9: lobby only: the sender's PC is still making its 3D connection (its VPX build has not connected to its Castcade yet, or nothing has been heard from another player's PC over the state stream's data connection), and stops waiting for it in at most this many ms; 0: settled (or given up). The host lists it in HELLO_ACK `stream3dWait` and holds a start from its table meanwhile. Absent: no change. A peer from before I11.4.9 ignores it.",
      ),
    // A17 (2026-11-25): three more optional keys, never logged, sent only in a lobby; a peer that does not know them
    // strips them.
    stance: Stance.optional().describe("A17: the sender's choice now, Play or Watch at the next start. It changes nothing in a game that is being played."),
    noCopy: z.boolean().optional().describe("A17: true: the sender's PC has no copy of the lobby's table (`HELLO_ACK.hostGame`); false: it has."),
    ownGame: z.boolean().optional().describe("A17: true: a game the match does not own is running on the sender's table (played alone, in the lobby or as a watcher); false: it has ended."),
  })
  .describe(
    "client -> host in the lobby: replaces the sender's HELLO `participant.rig` and `game`; the host compares the fingerprint again and re-sends HELLO_ACK to every client; (I11.4.9) `stream3dWaitMs` says whether the sender's 3D connection is still being made. After MATCH_READY (A6.1, 2026-11-01) only `rig`, (B26) `advisory` and (B26.4) `midnightMode` count: the roster in the log stays final, and the host passes the update on to every other participant (`from` preserved) and sends its own the same way, so each Match tab and panel shows the rig each player has now. Never logged. In a lobby (A17) it counts in every phase for `rig`, `game`, `ballEndReady`, `midnightMode`, `stance`, `noCopy` and `ownGame`: the host answers with HELLO_ACK to every member, and a match's logged roster and fingerprint stay what its MATCH_READY said.",
  );

export const Refuse = z
  .object({
    code: z.enum(['protocol_version', 'fingerprint_mismatch', 'match_full', 'unknown_throwdown', 'duplicate_player', 'match_started', 'other']),
    message: z.string().max(500),
    mismatches: z
      .array(FingerprintMismatch)
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

// A13 (2026-11-12): the host's Pass the turn. A new LOGGED message (protocol 5): the fold needs it to end a ball of a
// player who is not the sender, which no BALL_END can say.
export const TurnPass = z
  .object({
    grantSeq: z.number().int().min(1).describe('The outstanding grant this pass answers in place of a BALL_END.'),
    player: PlayerId.describe('The holder of that grant: the player whose ball the host ended.'),
    ballNumber: BallNumber.describe("The grant's ball."),
    score: Score.describe("The holder's last known score (its last STATE, else its last logged score): what the ball ends at."),
  })
  .describe(
    "host -> all, logged. The host ended the holder's ball by hand (the holder's table could not report its end, or the player is stuck): folded exactly like that player's BALL_END with `shootAgain: false` at `score`, and the rotation goes on. The entry's `from` is the host, so the log shows the ball was passed, not played out. A BALL_END for the passed grant that arrives later is rejected (`stale_grant` / `not_grant_holder`).",
  );

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
  .describe("client -> host at game over, once every player's game of the current game has ended (A10: once per game of a series).");

// A10 (2026-11-02): one match, N games. Each game's RESULT carries the series so far.
export const SeriesEntry = z
  .object({
    playerId: PlayerId,
    games: z.number().int().min(0).describe('Games of the series this player was in.'),
    wins: z.number().int().min(0).describe("Games this player won outright (a tie for first is nobody's win)."),
    totalScore: z.number().int().min(0).describe('The sum of their scores over those games.'),
    rank: z.number().int().min(1).describe('By wins, then total score; ties share a rank.'),
  })
  .describe("One player's standing in the series after this game.");

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
    startedAt: z.number().int().describe('ts of the entry that started this game (MATCH_READY, or its NEXT_GAME).'),
    finishedAt: z.number().int(),
    game: GameNumber.default(1).describe('Which game of the series this result is for (A10). RESULT is not logged, so a default is harmless.'),
    series: z
      .array(SeriesEntry)
      .max(4)
      .default([])
      .describe('The series standings after this game, every participant who played any game of it (A10).'),
  })
  .describe("host -> all, once per game (A10): the game's entries, signed over the log head at that game's end, and the series so far. Posted to ArcAid as one result of the Throwdown plus a castcade_matches record.");

// A10 (2026-11-02): the series. NEXT_GAME is logged (the games share one hash chain); MATCH_END is not.
export const NextGame = z
  .object({
    game: GameNumber.describe('The game that starts now: the previous one plus 1.'),
    playerOrder: z
      .array(PlayerId)
      .min(2)
      .max(4)
      .describe("Who plays this game, in rotation order: the roster's players still connected, the host first (its table started the game). A player who left is out of this game and its standings."),
  })
  .describe("host -> all, logged. Only after the previous game's RESULT went out. Every listed player starts a fresh game: grant 1 follows, ball counts and scores start again.");

export const MatchEnd = z
  .object({
    // A17 (2026-11-25): was GameNumber (1 or more). Never logged, so it may widen: a match whose only game was ended
    // for everyone has none with a RESULT.
    games: z.number().int().min(0).max(999).describe('How many games of the match have a RESULT.'),
    reason: z.string().max(200),
    abandoned: GameNumber.nullable()
      .optional()
      .describe('A17: the game that was being played and was ended for everyone: no RESULT, a win for nobody. Null or absent: none.'),
  })
  .describe('host -> all, between games: the series is over; the last RESULT stands. Never logged; the host closes the match afterwards. In a lobby (A17) it means "this match is over, back to the lobby": nobody leaves, no connection closes, and the next match starts a log of its own.');

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
    signature: Signature.describe(
      "The participant's signature over canonicalJson({matchId, player, logHash, logLength}) with its roster key. In a lobby (A17; `match` is present) it is over canonicalJson({lobby, player, match, logHash, logLength, seq}): the lobby's code, the same `match` as below, and the envelope's own `seq`, so that a captured RECONNECT cannot be sent again in a new envelope.",
    ),
    // A18 (2026-11-24): optional, never logged, not in the signed body; a peer that does not know it strips it, and
    // absent reads as "does not" (a companion up to 0.2.50).
    resends: z
      .boolean()
      .optional()
      .describe('A18: true when the sender sends again, right after an accepted RECONNECT, its own BALL_END, GAME_OVER, FORFEIT and LOG_SIGN that the host never answered. Absent or false: it does not, and a ball end it reported into the dropped link comes back only for a grant the host issues again (after a PAUSE and its RESUME).'),
    // A17 (2026-11-25): optional, for the lobby's RECONNECT (every phase, the lobby code in the envelope, a signed
    // `seq`). A lobby's client always sends it (null when it holds no log); nobody else does.
    match: MatchId.nullable().optional().describe('A17: the match the sender holds a log of; null: none. Absent: a RECONNECT from before the lobby, whose envelope names the match.'),
  })
  .describe('client -> host. First frame on a new socket to the current host, after a drop or a host transfer; never a fresh HELLO.');

export const ReconnectAck = z
  .object({
    accept: z.boolean(),
    code: z
      // A17 step 6 (2026-11-25): two more values, sent by a lobby only (a peer up to 0.2.50 never meets them).
      .enum(['unknown_log_hash', 'unknown_player', 'bad_signature', 'match_not_started', 'protocol_version', 'stale_seq'])
      .nullable()
      .describe(
        "Why the RECONNECT was rejected; null when accepted. A17: `protocol_version`: the sender speaks another version; `stale_seq`: the envelope's `seq` is not above the last this host took from that member (a RECONNECT sent a second time). In a lobby `unknown_player` means the member's place is gone: it joins again with a fresh HELLO on the same link.",
      ),
    entries: z.array(LogEntry).describe('Every log entry after the one the client named, in order; empty when it is current or rejected.'),
    logHash: Sha256Hex.describe("The host's log head after these entries. In a lobby's answer: the head of the log the answer carries (with `more`, at the end of this first page; for a `restart` or a refusal, which carry no log, 64 zeros and length 0)."),
    logLength: z.number().int().min(0),
    // A17 (2026-11-25): three more optional keys; a host whose lobby is off sends none of them.
    match: MatchId.nullable().optional().describe('A17: the match that is open now; null: none. Absent: not said (no lobby).'),
    restart: z.boolean().optional().describe("A17: true: the sender's log is not of the open match (or none is open): drop it. The open match's log follows in MATCH_LOG. Absent: false."),
    more: z.boolean().optional().describe('A17: true: `entries` holds only the first page (at most 100); the rest follows in MATCH_LOG, and the sender is current at its last page. Absent: false.'),
  })
  .describe('host -> client. Answers RECONNECT. A rejected client must re-join with a fresh HELLO; the host closes the socket after a rejection.');

// A17 (2026-11-25): the lobby's own messages. None is logged. None is sent while the lobby is off, so a peer up to
// 0.2.50, which cannot decode a type it does not know, never meets one.
export const StartRequest = z
  .object({
    fromTable: z.boolean().describe("True: the sender's own game began on its table (A11). Taken from the starter only."),
    newMatch: z.boolean().default(false).describe('True: end the open match and start one with everyone set to Play (the explicit press, never set with `fromTable`).'),
    anyway: z.boolean().default(false).describe('A13: the sender confirmed a start with a table that cannot report ball ends.'),
    now: z.boolean().default(false).describe('Do not wait: start without the 3D connections and without the people whose table is not ready (a second press).'),
  })
  .describe('client -> host, in a lobby. A member asks for a start. The host announces it (HELLO_ACK `start`) or answers REJECT (`unexpected_state`) whose `message` is the sentence the asker is shown.');

export const StartCancel = z.object({}).describe('client -> host, in a lobby. Take back the start that counts down or waits; answered by the HELLO_ACK without it, or by REJECT.');

export const EndRequest = z.object({}).describe('client -> host, in a lobby, between games. End the open match; answered by MATCH_END, or by REJECT.');

export const TablePick = z
  .object({ game: GameFingerprint.describe("The picked table: its identity keys (`kind`, `tableName`, `tableHash`, `romName`); the other keys are facts of one PC's copy and are null or empty in a pick.") })
  .describe("client -> host, in a lobby, outside a game. A member picks the lobby's table; answered by the HELLO_ACK that carries it (`hostGame`, `tablePickedBy`), or by REJECT.");

export const LobbyClosed = z
  .object({ reason: z.string().max(200) })
  .describe('host -> all. The lobby is closed: every member tears down, and nobody reconnects afterwards. Never logged.');

/** A17: the most log entries in one MATCH_LOG (and in the RECONNECT_ACK that says `more`): about 50 KB, far under the relay's 256 KB a frame. */
export const MATCH_LOG_PAGE_SIZE = 100;

export const MatchLogPage = z
  .object({
    match: MatchId.describe('The match the entries belong to.'),
    restart: z.boolean().describe('True on the first page of a whole log: the receiver starts an empty log for `match`. False: the entries follow the ones the receiver holds.'),
    entries: z.array(LogEntry).max(MATCH_LOG_PAGE_SIZE).describe('The next entries of the log, in order, verbatim.'),
    logHash: Sha256Hex.describe("The head of the log at the end of this page: the receiver's head once it has appended the entries (64 zeros for an empty log). Every page names the head of the log it carries."),
    logLength: z.number().int().min(0),
    more: z.boolean().describe('Another page follows. False: the receiver is current, and the logged messages reach it live from here on.'),
  })
  .describe("host -> client, in a lobby. The open match's log, to a member who does not hold it (it joined while the match was open, or its RECONNECT_ACK said `more`), in pages. The host sends such a member no logged message until the last page went out. Never logged.");

// D2 (2026-10-30): the WebRTC signalling for a match's video and voice rides the match channel; the media itself
// goes peer to peer, never through the host's match socket or ArcAid.
export const IceCandidate = z
  .object({
    candidate: z.string().max(4096).describe("The browser's candidate line; empty for end-of-candidates."),
    sdpMid: z.string().max(64).nullable(),
    sdpMLineIndex: z.number().int().min(0).max(255).nullable(),
  })
  .describe('One trickled ICE candidate, as RTCIceCandidate.toJSON() gives it.');

export const EyeGeometry = z
  .object({
    fov: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("The view's field of view in radians, OpenXR's order and signs: [angleLeft, angleRight, angleUp, angleDown]."),
    rect: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(1), z.number().int().min(1)]).describe("The crop taken inside the view's render: [x, y, width, height], y from the top."),
    render: z.tuple([z.number().int().min(1), z.number().int().min(1)]).describe("The view's render size (its imageRect): [width, height]."),
  })
  .describe('One eye of a sender whose picture comes from the OpenXR layer camera (D7.5): how it was rendered and cropped.');

export const MediaSignal = z
  .object({
    to: PlayerId.describe('The one participant this signal is for. The host forwards it there and nowhere else.'),
    // D2.7 + D7.4.3 (2026-11-01): `reset` and `stereo` are additive (MEDIA_SIGNAL is never logged; a companion that
    // does not know them drops the frame as undecodable, which only costs the feature), so the version stays 2.
    kind: z
      .enum(['offer', 'answer', 'ice', 'reset', 'stereo'])
      .describe(
        "An SDP offer or answer, or one ICE candidate. `reset`: the sender's connections to `to` are new (its panel was rebuilt); close yours and negotiate afresh. `stereo`: what the sender's video is (VPX's VR preview on one eye or both).",
      ),
    sdp: z.string().max(65_536).optional().describe('The session description; present on offer and answer.'),
    candidate: IceCandidate.optional().describe('Present on ice.'),
    stereo: z
      .enum(['mono', 'sbs'])
      .nullable()
      .optional()
      .describe("Present on stereo: `sbs` = left eye | right eye side by side, `mono` = one picture, null = the sender does not know (the receiver guesses from the picture's shape)."),
    // D7.5.2 (2026-11-03): additive like `stereo`; the sender's eye geometry when the picture comes from the OpenXR
    // layer's camera (D7.5), so the receiver's theater window uses the sender's eyes, not its own.
    eyes: z
      .array(EyeGeometry)
      .length(2)
      .nullable()
      .optional()
      .describe('Optional on stereo `sbs`: the geometry of [left, right] as the sender rendered them (the OpenXR layer camera, D7.5). Absent or null: a screen capture; the receiver assumes its own eyes.'),
    // D10.3 (2026-11-07, docs/design/spectator-video-native.md §6.3): additive like `stereo`, defaulted so a frame
    // without it reads as the Electron connection; the version stays 3.
    // I11.4.2 (2026-11-19, docs/design/state-stream-in-match.md §4.1): `stream`, a new VALUE, so protocol 6 (version.ts).
    channel: z
      .enum(['rtc', 'video', 'stream'])
      .default('rtc')
      .describe(
        "Which peer connection between the two the signal belongs to: `rtc` (absent = `rtc`), the Electron connection that carries voice (and video until D10.7); `video`, the native video helper's connection for the same pair (castcade-video.exe, D10); `stream` (protocol 6), the data-only connection that carries the VPX state stream between the two companions (a waiting player watches the player up on their own table, I11.4.2). A peer that does not run the helper ignores `video` signals; every peer opens the `stream` connection, whether or not its VPX can use it.",
      ),
  })
  .refine((s) => (s.kind === 'ice' ? s.candidate !== undefined : s.kind === 'reset' ? true : s.kind === 'stereo' ? s.stereo !== undefined : s.sdp !== undefined), {
    message: 'an offer or answer carries sdp; an ice signal carries candidate; a stereo signal carries stereo',
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
  TURN_PASS: TurnPass,
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
  NEXT_GAME: NextGame,
  MATCH_END: MatchEnd,
  START_REQUEST: StartRequest,
  START_CANCEL: StartCancel,
  END_REQUEST: EndRequest,
  TABLE_PICK: TablePick,
  LOBBY_CLOSED: LobbyClosed,
  MATCH_LOG: MatchLogPage,
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
  TURN_PASS: 'host->all',
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
  NEXT_GAME: 'host->all',
  MATCH_END: 'host->all',
  START_REQUEST: 'client->host',
  START_CANCEL: 'client->host',
  END_REQUEST: 'client->host',
  TABLE_PICK: 'client->host',
  LOBBY_CLOSED: 'host->all',
  MATCH_LOG: 'host->client',
};
