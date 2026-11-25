/**
 * ClientMatch: a participant that is not the arbiter. Joins with HELLO, verifies every
 * TURN_GRANT against the host key before releasing the input lock, reports BALL_END / STATE /
 * GAME_OVER, keeps the same log as the host from the broadcast stream, sends LOG_SIGN once the
 * log shows every game has ended, verifies RESULT, and runs the client side of host transfer
 * (acking a planned handover, proposing itself when the host is gone, becoming the HostMatch
 * when it wins a majority).
 *
 * LOG_SIGN rule (SPEC leaves the trigger implicit): the client derives "every game has ended"
 * from its own log — the fold over MATCH_READY / BALL_END / GAME_OVER / FORFEIT entries — and
 * signs its head at that moment. The host freezes its log at the same entry, so the hashes line
 * up without any extra message.
 *
 * Transfer commit rule: only the prospective new host counts acks. Every other participant
 * commits the transfer when the first host-only message (TURN_GRANT, PAUSE, ...) arrives from the
 * new host, which keeps the position of the commit event identical in every log regardless of
 * the order acks travel in.
 *
 * Over WebSocket (A2, 2026-10-30) a client has a link to the host only. On a HOST_TRANSFER that
 * names the new host's listener it opens a socket there and resumes with RECONNECT from its log
 * head; the RECONNECT_ACK brings the commit event and anything after it, checked entry by entry
 * against the hash chain, so the commit lands at the same log position as everywhere else.
 *
 * A10 (2026-11-02): a match is a series. A RESULT no longer ends it: the client logs the host's NEXT_GAME (only between
 * games, only the next number) and plays on; it signs the log once per game; it raises `result` once per game, and
 * checks a RESULT that arrives late (after a reconnect, game 1's RESULT during game 2) against the log entry at that
 * game's end, not the head. MATCH_END ends the series (`matchEnded`); after it a dropped host is not reconnected to.
 * The host dropping between games and not coming back is `hostGone` (no transfer: no game is running).
 *
 * A18 (2026-11-24, match ECVYGP: one second without ArcAid was a disconnect on both PCs): a dropped link to the host
 * that is back within `disconnectGraceMs` (5 s, the host's number) is nothing anyone sees: the reconnect starts at
 * once as before, `peerLeft` is raised only when the grace runs out first, and `reconnected` says `quiet` when it did
 * not. What this player reported into the dead link is not lost: a BALL_END, GAME_OVER or FORFEIT of its own that the
 * host has not answered (no echo in the log, no REJECT) is sent again after an accepted RECONNECT, before
 * `reconnected` is raised (so before the RESUME a listener sends for a pause the drop caused: a BALL_END is taken
 * during a pause, and the RESUME then moves on instead of granting a finished ball again). So is its LOG_SIGN for a
 * game whose RESULT has not come. The RECONNECT says so (`resends: true`, optional and never logged or signed), which
 * is how a host knows it need not pause and issue the grant again for this client, as it must for one up to 0.2.50.
 *
 * A17 step 5 (2026-11-25, docs/design/alpha-match.md section 11), behind `ClientOptions.lobby`, OFF by default; off,
 * nothing here behaves or sends differently. On, this client is a member of a lobby that outlives its matches:
 * - it says its choice (`stance`: Play or Watch) in HELLO and in PARTICIPANT_UPDATE, which then counts in every
 *   phase (`updateParticipant`, `setStance`), and takes HELLO_ACK in every phase as the lobby as it is (`roster`,
 *   `lobby()`);
 * - MATCH_READY starts a log of its own (index 0), whatever this client held; MATCH_END is "back to the lobby": the
 *   log is put away (`previousMatch()`), the per-match counters start over (the last grant seen, the game signed,
 *   the RESULTs received, what was reported and not answered), and the connection stays;
 * - a member who is not in the game is a watcher: it gets the same stream, keeps the same log, verifies the same
 *   RESULT, and sends nothing of its own (`reportState`, `reportGameOver`, `forfeit`, `pause`, `resume` do nothing;
 *   `maybeSignLog` already left it out);
 * - **a logged message is taken only into a log this client holds in full, for the match it belongs to.** A member
 *   who joins while a match is open holds none of its log until the last MATCH_LOG page; a message of the match
 *   that arrives before that, or for a match that is not the open one, is dropped (`no_log`). Without this rule a
 *   BALL_END between the HELLO_ACK and the log would be entry 0 of an empty log. A grant is also checked against
 *   the match id inside it, which is signed (`grantSeq` starts at 1 in every match);
 * - MATCH_LOG pages are merged entry by entry against the hash chain, as a RECONNECT_ACK's entries are; a
 *   RECONNECT_ACK that says `more` is finished by them;
 * - LOBBY_CLOSED ends it: no reconnect afterwards. No host transfer: a proposal is dropped and none is made.
 *
 * A17 step 6 (2026-11-25, design 11.4, 11.7, 11.8a), still behind `ClientOptions.lobby`:
 * - **asking**: `requestStart` (START_REQUEST: from this player's table or from a button, the next game or a new
 *   match, `anyway`, `now`), `cancelStart`, `requestEnd`, `pickTable`. Each is answered by the change it asks for
 *   (HELLO_ACK: `roster`; MATCH_END) or by a REJECT whose message is the sentence to show (`reject`);
 * - **the lobby's table is a pick**: HELLO_ACK `hostGame` holds its identity keys only, and this client compares
 *   its own table with those (`compareTable`), not with every key;
 * - **RECONNECT in every phase**: a member comes back in the lobby and between games as it does in a game. The
 *   envelope and the signed body carry the lobby's code, the body also the match this client holds a log of and
 *   the envelope's own `seq` (so the frame is good for one use). `restart` in the answer: this client's log is of
 *   another match, or of none: it is put away (`matchEnded`, when a match was held) and the open match's log
 *   follows in MATCH_LOG. `unknown_player`: the place is gone: this client says HELLO again on the same link and is
 *   a newcomer (`rejoining`, then `joined`). Every answer, and every MATCH_LOG page, names the head of the log it
 *   carries, and each is checked;
 * - **the lobby's PC away** (11.8a): this client goes on trying for 20 minutes (`reconnect.maxMs`), not for thirty
 *   attempts; `hostAway()` says since when and until when. What this player reports meanwhile is kept and sent
 *   again when the lobby's PC is back (A18's `resendUnanswered`: a ball that ended while it was away is reported
 *   then). When the time is up the host is gone, as before (`hostLost` / `hostGone`). How often the relay may be
 *   asked for a room that is not there is the transport's rule, not this engine's.
 */
import type { AnyMessage, GameFingerprint, GrantBody, Message, MessageType, MidnightMode, ParticipantInfo, PayloadOf, PlayerAdvisory, PlayerId, Stance } from '@castcade/protocol';
import { buildMessage, parseMessage, PROTOCOL_VERSION } from '@castcade/protocol';
import type { Clock, TimerHandle } from './clock.js';
import { Emitter } from './events.js';
import { compareFingerprints, DEFAULT_DISCONNECT_GRACE_MS, HostMatch, type OutgoingMediaSignal, type ReconnectCode } from './host.js';
import { signCanonical, verifyCanonical, type KeyPair } from './keys.js';
import { hashEntry, type LogEntry, type LogEntryBody, type LogHead, type MatchLog } from './log.js';
import { lobbyReconnectSignBody, logSignBody, reconnectSignBody } from './result.js';
import { compareWithPick, identityOnly } from './table-identity.js';
import { Session } from './session.js';
import { cloneState, isStrictMajority, remainingParticipants, type MatchState } from './state.js';
import type { Transport } from './transport.js';

export interface ClientOptions {
  transport: Transport;
  keys: KeyPair;
  participant: ParticipantInfo;
  game: GameFingerprint;
  throwdownCode: string;
  companionVersion?: string;
  /** A13: whether this player's table can report ball ends (`HELLO.ballEndReady`); omitted = unknown. */
  ballEndReady?: boolean;
  /** Where HELLO goes on a full-mesh transport; omit on a point-to-point transport. */
  hostId?: PlayerId;
  clock?: Clock;
  /** Used if this client becomes host after a transfer. */
  hostTimeouts?: { ballEndTimeoutMs?: number; logSignTimeoutMs?: number };
  /**
   * Reconnect after a dropped socket to the host (A3): one attempt every `delayMs` (default 1 s),
   * at most `attempts` (default 30); then the host counts as gone. A15: `maxMs` also ends it by the clock (an
   * attempt at a PC that is switched off can take the system's connect timeout).
   */
  reconnect?: { attempts?: number; delayMs?: number; maxMs?: number };
  /**
   * A15: false: when the host is gone for good this client does not propose itself as the new host (`hostLost` is
   * still raised). The companion passes false: over WebSocket or the relay a client has no listener the others could
   * reach, so a client that took over was a host nobody could come back to. Default true (a full mesh).
   */
  hostLeftTransfer?: boolean;
  /** A18: how long a dropped link to the host is not yet told to anyone (`peerLeft`). Default 5 s; 0: at once. */
  disconnectGraceMs?: number;
  /**
   * A17 step 5 (2026-11-25): the host is a lobby that outlives its matches (the file header); `stance` is this
   * member's choice at the join (default play). Off by default, and off it changes nothing. Both ends must agree:
   * a lobby's messages are only understood by a client that has it on.
   */
  lobby?: boolean | { stance?: Stance };
}

export interface AdoptOptions {
  participant: ParticipantInfo;
  game: GameFingerprint;
  throwdownCode: string;
  companionVersion?: string;
  gone?: Iterable<PlayerId>;
  /** A8 (2026-10-31): the stepping-down host's `tableMismatches()`, so a later transfer back carries them on. */
  tableMismatches?: Record<PlayerId, PayloadOf<'REFUSE'>['mismatches']>;
  hostTimeouts?: { ballEndTimeoutMs?: number; logSignTimeoutMs?: number };
  reconnect?: { attempts?: number; delayMs?: number; maxMs?: number };
  hostLeftTransfer?: boolean;
  disconnectGraceMs?: number;
}

export interface DroppedInfo {
  from: PlayerId;
  type: MessageType;
  seq: number;
  /** `no_log` (A17): a message of a match whose log this client does not hold in full, or of a match that is not the open one. */
  reason: 'seq' | 'bad_signature' | 'stale_grant' | 'not_host' | 'unexpected' | 'bad_transfer' | 'no_log';
}

export interface DesyncInfo {
  /** `matchlog.entries` (A17): a MATCH_LOG page that does not chain onto this log, or a last page whose head is not the host's. */
  context: 'grant.logHash' | 'result.logHash' | 'reconnect.entries' | 'matchlog.entries';
  expected: string;
  actual: string;
}

export interface ResultInfo {
  result: PayloadOf<'RESULT'>;
  logMatches: boolean;
  signatureValid: boolean;
}

export interface ClientEvents extends Record<string, unknown> {
  joined: PayloadOf<'HELLO_ACK'>;
  refused: PayloadOf<'REFUSE'>;
  /**
   * HELLO_ACK's `hostGame` differs from this client's own fingerprint (a host in advisory mode); raised before `joined`.
   * A6 (2026-10-31): raised again when a re-sent HELLO_ACK changes what differs; an empty `mismatches` means it agrees now.
   * A8 (2026-10-31): also for every OTHER participant the host's `HELLO_ACK.tableMismatches` names (or stops naming).
   */
  tableMismatch: { playerId: PlayerId; mismatches: PayloadOf<'REFUSE'>['mismatches'] };
  /** A6 (2026-10-31): the host re-sent HELLO_ACK in the lobby (someone's rig or table changed): the roster now. */
  roster: PayloadOf<'HELLO_ACK'>;
  ready: PayloadOf<'MATCH_READY'>;
  grant: GrantBody;
  myTurn: GrantBody;
  ballEnd: Message<'BALL_END'>;
  /** A13: the host passed the turn (TURN_PASS, logged): `payload.player`'s ball ended by hand, at `payload.score`. */
  turnPassed: Message<'TURN_PASS'>;
  gameOver: Message<'GAME_OVER'>;
  forfeit: Message<'FORFEIT'>;
  pause: PayloadOf<'PAUSE'>;
  resume: { from: PlayerId };
  state: Message<'STATE'>;
  dmd: Message<'DMD_FRAME'>;
  reject: PayloadOf<'REJECT'>;
  dropped: DroppedInfo;
  desync: DesyncInfo;
  transferProposed: PayloadOf<'HOST_TRANSFER'>;
  transferAck: Message<'HOST_TRANSFER_ACK'>;
  hostChanged: { from: PlayerId; to: PlayerId };
  becameHost: HostMatch;
  hostLost: PlayerId;
  logSigned: PayloadOf<'LOG_SIGN'>;
  result: ResultInfo;
  /**
   * A peer's link dropped. A18: for the host on a transport that reconnects, only once the link has been down for the
   * grace; a drop that is over sooner raises nothing but `reconnected` (`quiet`).
   */
  peerLeft: PlayerId;
  /** RECONNECT accepted by `host`; `entries` were appended to the log (A2/A3). A18: `quiet`: no `peerLeft` came before it. */
  reconnected: { host: PlayerId; entries: number; quiet: boolean };
  /** RECONNECT rejected: re-join with a fresh HELLO, which after MATCH_READY is refused. */
  reconnectRejected: { host: PlayerId; code: ReconnectCode | null };
  /** One reconnect attempt to `host` failed; `attemptsLeft` 0 means this client gave up. */
  reconnectFailed: { host: PlayerId; error: Error; attemptsLeft: number };
  /** A MEDIA_SIGNAL for this player, forwarded by the host (or sent by it); `from` is the original sender (D2). */
  mediaSignal: { from: PlayerId; signal: PayloadOf<'MEDIA_SIGNAL'> };
  /**
   * A6.1 (2026-11-01): a participant's rig changed after MATCH_READY (the host passed on its PARTICIPANT_UPDATE, or
   * sent its own), or this player's own (`updateParticipant`). The roster in the log keeps what MATCH_READY said.
   */
  rigUpdated: { playerId: PlayerId; rig: ParticipantInfo['rig'] };
  /**
   * B26 (2026-11-16): a player flagged one of its own balls after MATCH_READY (the host passed on its
   * PARTICIPANT_UPDATE, or sent its own), or this player did (`reportAdvisory`). Never logged; a flag only.
   */
  advisory: { playerId: PlayerId; advisory: PlayerAdvisory };
  /**
   * B26.4 (2026-11-16): after MATCH_READY another player said how the Midnight Madness setting reads on its table
   * (the host passed on its PARTICIPANT_UPDATE, or sent its own). In the lobby HELLO_ACK `midnightModes` says it
   * (`joined` / `roster`). Never logged; display only.
   */
  midnightMode: { playerId: PlayerId; mode: MidnightMode };
  /** A10: the host started the next game of the series (logged); its grant 1 follows. */
  nextGame: PayloadOf<'NEXT_GAME'>;
  /** A10: the host ended the series (MATCH_END). */
  matchEnded: PayloadOf<'MATCH_END'>;
  /** A10: the host is gone for good while no game runs (between games, or after the series), so no transfer follows. */
  hostGone: PlayerId;
  /**
   * A17: this client holds the open match's log in full now (the last MATCH_LOG page arrived and its head is the
   * host's): `entries` long. From here on the match's messages are taken live.
   */
  caughtUp: { match: string; entries: number };
  /** A17: the host closed the lobby (LOBBY_CLOSED); nothing follows, and this client does not reconnect. */
  lobbyClosed: PayloadOf<'LOBBY_CLOSED'>;
  /**
   * A17 step 6: this client's place in the lobby was gone when it came back (RECONNECT_ACK `unknown_player`): it has
   * put away whatever it held and said HELLO again to `host`; `joined` (or `refused`) follows.
   */
  rejoining: PlayerId;
}

const HOST_ONLY_TYPES: ReadonlySet<MessageType> = new Set(['TURN_GRANT', 'TURN_PASS', 'RESULT', 'PAUSE', 'RESUME', 'FORFEIT', 'REJECT', 'NEXT_GAME', 'MATCH_END']);
/** A17: the messages of a match (the logged stream, and its RESULT): a lobby's member takes them only into a log it holds. */
const MATCH_STREAM_TYPES: ReadonlySet<MessageType> = new Set(['TURN_GRANT', 'BALL_END', 'TURN_PASS', 'GAME_OVER', 'FORFEIT', 'PAUSE', 'RESUME', 'NEXT_GAME', 'RESULT']);
const DEFAULT_RECONNECT_ATTEMPTS = 30;
/** A17 step 6 (design 11.8a): how long a lobby's member goes on trying to get back to the lobby's PC. */
export const LOBBY_HOST_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_RECONNECT_DELAY_MS = 1000;

interface Reconnecting {
  host: PlayerId;
  endpoint: string | undefined;
  replacing: PlayerId | undefined;
  /** The old host closes its own listener once the new host accepted it. */
  closeListener: boolean;
  attemptsLeft: number;
  /** A socket was opened and RECONNECT sent; waiting for RECONNECT_ACK. */
  inFlight: boolean;
  timer: TimerHandle | null;
  /** A15: no attempt is scheduled after this (the session's clock); null = the attempts alone bound it. */
  deadline: number | null;
}

export class ClientMatch {
  readonly events = new Emitter<ClientEvents>();
  private readonly s: Session;
  /** Not readonly: `updateParticipant` corrects the rig and the fingerprint in the lobby (A6, 2026-10-31). */
  private participant: ParticipantInfo;
  private game: GameFingerprint;
  /** A13: what the host was last told about this table's ball ends (HELLO, then lobby updates); undefined = unknown. */
  private ballEndReady: boolean | undefined;
  /** The mismatched fields last raised as `tableMismatch`, so a re-sent HELLO_ACK raises only a change. */
  private mismatchFields = '';
  /** The host's fingerprint from the last HELLO_ACK: what this client's own entry in `tableMismatches()` compares with. */
  private ackHostGame: GameFingerprint | null = null;
  /** A8 (2026-10-31): the OTHER participants the host found different, from the last HELLO_ACK (or a step-down). */
  private readonly othersMismatched = new Map<PlayerId, PayloadOf<'REFUSE'>['mismatches']>();
  private readonly throwdownCode: string;
  private readonly companionVersion: string;
  private readonly explicitHostId: PlayerId | null;
  private readonly hostTimeouts: { ballEndTimeoutMs?: number; logSignTimeoutMs?: number };
  private ackHostId: PlayerId | null = null;
  private ackHostKey: string | null = null;
  private joined = false;
  private refusedWith: PayloadOf<'REFUSE'> | null = null;
  private _inputUnlocked = false;
  private _myGrant: GrantBody | null = null;
  private lastGrantSeqSeen = 0;
  /** A10: the game this client last signed the log for (0: none yet). */
  private signedGame = 0;
  private hostLost = false;
  private transferAccepts = new Set<PlayerId>();
  private readonly gone = new Set<PlayerId>();
  private readonly reconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxMs: number | null;
  private readonly hostLeftTransfer: boolean;
  /** The reconnect under way, if any: who must answer RECONNECT, and the retry budget. */
  private reconnecting: Reconnecting | null = null;
  private readonly graceMs: number;
  /**
   * A18: the link to `peer` is down and a reconnect is under way. `timer`: the grace still runs and nobody has been
   * told; `told`: it ran out and `peerLeft` was raised.
   */
  private down: { peer: PlayerId; timer: TimerHandle | null; told: boolean } | null = null;
  /**
   * A18: this player's own reports the host has not answered yet (the echo in the log, or a REJECT), kept so that one
   * sent into a link that had just dropped goes out again after the reconnect.
   */
  private unanswered: { ballEnd: PayloadOf<'BALL_END'> | null; gameOver: PayloadOf<'GAME_OVER'> | null; forfeit: PayloadOf<'FORFEIT'> | null } = { ballEnd: null, gameOver: null, forfeit: null };
  /** A18: this player's LOG_SIGN for the game whose RESULT has not come yet, sent again after a reconnect. */
  private logSignSent: { game: number; payload: PayloadOf<'LOG_SIGN'> } | null = null;
  /** A10: the games whose RESULT arrived (each raises `result` once). */
  private readonly resultsReceived = new Set<number>();
  /** A10: MATCH_END arrived. */
  private ended = false;
  /** RECONNECTs that reached this client as the pending new host, answered at its commit (A2). */
  private readonly heldReconnects: { linkFrom: PlayerId; msg: Message<'RECONNECT'> }[] = [];
  private detached = false;
  private readonly unsubscribe: (() => void)[] = [];
  /** A17: the host is a lobby (`ClientOptions.lobby`). Everything the lobby adds is behind this flag. */
  private readonly lobbyOn: boolean;
  /** A17: this member's own choice, as last said to the host. */
  private myStance: Stance = 'play';
  /** A17: what the host was last told about a copy of the lobby's table on this PC, and a game of its own; undefined = never said. */
  private saidNoCopy: boolean | undefined;
  private saidOwnGame: boolean | undefined;
  /** A17: the lobby as the host last said it (HELLO_ACK); null before the join. */
  private lobbyAck: PayloadOf<'HELLO_ACK'> | null = null;
  /**
   * A17: this client holds the open match's log in full (or no match is open). False from a join into an open match,
   * or a RECONNECT_ACK that says `more`, until the last MATCH_LOG page: meanwhile nothing of the match is taken live.
   */
  private holdsLog = true;
  /** A17: the match whose log is on its way in MATCH_LOG pages; null when none is. */
  private catchingUp: string | null = null;
  /** A17: what an accepted RECONNECT still has to do once the rest of its log has arrived (`more`). */
  private afterCatchUp: { entries: number; done: (entries: number) => void } | null = null;
  /** A17: the match that ended last in this lobby, with this client's log of it. */
  private lastMatch: { matchId: string; log: MatchLog } | null = null;
  /** A17 step 6: when the link to the host dropped (this session's clock); null while it is up. */
  private downSince: number | null = null;

  constructor(opts: ClientOptions, session?: Session) {
    this.s = session ?? new Session({ transport: opts.transport, keys: opts.keys, clock: opts.clock });
    if (opts.participant.playerId !== this.s.localId) throw new Error('participant.playerId must equal transport.localId');
    this.participant = { ...opts.participant, publicKey: this.s.keys.publicKeyB64 };
    this.game = { ...opts.game };
    this.ballEndReady = opts.ballEndReady;
    this.throwdownCode = opts.throwdownCode;
    this.companionVersion = opts.companionVersion ?? '0.1.0';
    this.explicitHostId = opts.hostId ?? null;
    this.hostTimeouts = opts.hostTimeouts ?? {};
    this.lobbyOn = opts.lobby !== undefined && opts.lobby !== false;
    // A17 step 6: in a lobby the wait for the lobby's PC is counted in minutes, not in attempts.
    this.reconnectAttempts = Math.max(1, opts.reconnect?.attempts ?? (this.lobbyOn ? Number.POSITIVE_INFINITY : DEFAULT_RECONNECT_ATTEMPTS));
    this.reconnectDelayMs = opts.reconnect?.delayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.reconnectMaxMs = opts.reconnect?.maxMs ?? (this.lobbyOn ? LOBBY_HOST_WAIT_MS : null);
    if (typeof opts.lobby === 'object') this.myStance = opts.lobby.stance ?? 'play';
    // A17: a lobby does not change hands: its client never proposes itself.
    this.hostLeftTransfer = this.lobbyOn ? false : (opts.hostLeftTransfer ?? true);
    this.graceMs = Math.max(0, opts.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS);
    this.attach();
  }

  /** Continue an in-progress match as a client on an existing session (a host that stepped down). */
  static adopt(session: Session, opts: AdoptOptions): ClientMatch {
    const client = new ClientMatch(
      {
        transport: session.transport,
        keys: session.keys,
        participant: opts.participant,
        game: opts.game,
        throwdownCode: opts.throwdownCode,
        companionVersion: opts.companionVersion,
        hostTimeouts: opts.hostTimeouts,
        reconnect: opts.reconnect,
        hostLeftTransfer: opts.hostLeftTransfer,
        disconnectGraceMs: opts.disconnectGraceMs,
      },
      session,
    );
    client.joined = true;
    for (const id of opts.gone ?? []) client.gone.add(id);
    for (const [id, m] of Object.entries(opts.tableMismatches ?? {})) {
      if (id !== client.localId && m.length > 0) client.othersMismatched.set(id, m.map((x) => ({ ...x })));
    }
    return client;
  }

  // ------------------------------------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------------------------------------

  get localId(): PlayerId {
    return this.s.localId;
  }

  get log(): MatchLog {
    return this.s.log;
  }

  get session(): Session {
    return this.s;
  }

  get state(): MatchState {
    return this.s.state;
  }

  get publicKey(): string {
    return this.s.keys.publicKeyB64;
  }

  get hostId(): PlayerId | null {
    return this.s.state.hostId ?? this.ackHostId ?? this.explicitHostId;
  }

  get hostPublicKey(): string | null {
    return this.s.state.hostPublicKey ?? this.ackHostKey;
  }

  get inputUnlocked(): boolean {
    return this._inputUnlocked;
  }

  get myGrant(): GrantBody | null {
    return this._myGrant;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  get refused(): PayloadOf<'REFUSE'> | null {
    return this.refusedWith;
  }

  on<K extends keyof ClientEvents>(name: K, cb: (payload: ClientEvents[K]) => void): () => void {
    return this.events.on(name, cb);
  }

  /**
   * A8 (2026-10-31): who differs from the host's fingerprint and how, like `HostMatch.tableMismatches()`: the others
   * as the host last said (HELLO_ACK), this player from its own comparison. Carried into `resumeFromLog` on a transfer.
   */
  tableMismatches(): Record<PlayerId, PayloadOf<'REFUSE'>['mismatches']> {
    const out: Record<PlayerId, PayloadOf<'REFUSE'>['mismatches']> = {};
    for (const [id, m] of this.othersMismatched) out[id] = m.map((x) => ({ ...x }));
    const ref = this.s.state.game ?? this.ackHostGame;
    // A17 step 6: with no match open in a lobby the reference is the pick: its identity keys only.
    const mine = !ref ? [] : this.lobbyOn && !this.s.state.game ? compareWithPick(ref, this.game, this.hostId ?? this.localId) : compareFingerprints(ref, this.game, this.hostId ?? this.localId);
    if (mine.length > 0) out[this.localId] = mine;
    return out;
  }

  /** A14 (2026-11-12): the host's game as this client knows it: the match's once it started, else the last HELLO_ACK's; null before any. */
  hostGame(): GameFingerprint | null {
    const g = this.s.state.game ?? this.ackHostGame;
    return g ? { ...g } : null;
  }

  snapshot(): { role: 'client'; state: MatchState; log: LogHead; inputUnlocked: boolean; myGrant: GrantBody | null; hostId: PlayerId | null; signed: boolean } {
    return {
      role: 'client',
      state: cloneState(this.s.state),
      log: this.s.log.head(),
      inputUnlocked: this._inputUnlocked,
      myGrant: this._myGrant,
      hostId: this.hostId,
      signed: this.signedGame > 0 && this.signedGame === this.s.state.gameNumber,
    };
  }

  /** A10: MATCH_END arrived. A17: in a lobby, LOBBY_CLOSED did (a match's end ends nothing there). */
  get matchEnded(): boolean {
    return this.ended;
  }

  /** A17: the host is a lobby (`ClientOptions.lobby`). */
  get isLobby(): boolean {
    return this.lobbyOn;
  }

  /** A17: this member's own choice, Play or Watch, as last said to the host. */
  get stance(): Stance {
    return this.myStance;
  }

  /** A17: the lobby as the host last said it: the members, their choices, the open match. Null before the join. */
  lobby(): PayloadOf<'HELLO_ACK'> | null {
    return this.lobbyAck;
  }

  /** A17: this client holds the open match's log in full, or no match is open (always true without a lobby). */
  get holdsOpenLog(): boolean {
    return this.holdsLog;
  }

  /** A17: the match that ended last in this lobby, with this client's log of it as it stood; null before any. */
  previousMatch(): { matchId: string; log: MatchLog } | null {
    return this.lastMatch ? { ...this.lastMatch } : null;
  }

  /**
   * A17: Play or Watch, said to the host (PARTICIPANT_UPDATE), in any phase. It takes effect at the next start: it
   * changes nothing in a game that is being played. False when nothing was sent (no lobby, not joined, no change).
   */
  setStance(stance: Stance): boolean {
    return this.updateParticipant({ stance });
  }

  /**
   * A17 step 6: ask the lobby's PC for a start (START_REQUEST). `fromTable`: this player's own game began on its
   * table (only the starter's counts); `newMatch`: end the open match and start one with everyone set to Play;
   * `anyway`: this player confirmed a start with a table that cannot report ball ends; `now`: a second press while
   * a start waits. The answer is the start in HELLO_ACK (`roster`), or a REJECT with the sentence (`reject`).
   * False when nothing was sent (no lobby, not joined).
   */
  requestStart(ask: { fromTable?: boolean; newMatch?: boolean; anyway?: boolean; now?: boolean } = {}): boolean {
    this.assertActive();
    if (!this.lobbyOn || !this.joined) return false;
    this.sendToHost(this.s.build('START_REQUEST', { fromTable: ask.fromTable === true, newMatch: ask.newMatch === true, anyway: ask.anyway === true, now: ask.now === true }, this.throwdownCode));
    return true;
  }

  /** A17 step 6: take back the start that counts down or waits (START_CANCEL). Anybody in the lobby may. */
  cancelStart(): boolean {
    this.assertActive();
    if (!this.lobbyOn || !this.joined) return false;
    this.sendToHost(this.s.build('START_CANCEL', {}, this.throwdownCode));
    return true;
  }

  /** A17 step 6: end the open match, between games (END_REQUEST). Everyone stays in the lobby. */
  requestEnd(): boolean {
    this.assertActive();
    if (!this.lobbyOn || !this.joined) return false;
    this.sendToHost(this.s.build('END_REQUEST', {}, this.throwdownCode));
    return true;
  }

  /** A17 step 6: pick the lobby's table (TABLE_PICK); only its identity keys count. Not during a game or a start. */
  pickTable(game: GameFingerprint): boolean {
    this.assertActive();
    if (!this.lobbyOn || !this.joined) return false;
    this.sendToHost(this.s.build('TABLE_PICK', { game: { ...game } }, this.throwdownCode));
    return true;
  }

  /**
   * A17 step 6: the link to the lobby's PC is down and this client is trying to get back: since when, and until
   * when it goes on trying (this session's clock; null: no limit by time). Null while the link is up.
   */
  hostAway(): { since: number; until: number | null } | null {
    if (this.downSince === null) return null;
    return { since: this.downSince, until: this.reconnecting?.deadline ?? null };
  }

  join(): void {
    this.assertActive();
    if (this.joined) throw new Error('already joined');
    const msg = this.s.build(
      'HELLO',
      {
        protocolVersion: PROTOCOL_VERSION,
        companionVersion: this.companionVersion,
        throwdownCode: this.throwdownCode,
        participant: this.participant,
        game: this.game,
        ...(this.ballEndReady !== undefined ? { ballEndReady: this.ballEndReady } : {}),
        // A17: only a lobby is told the choice.
        ...(this.lobbyOn ? { stance: this.myStance } : {}),
      },
      null,
    );
    this.s.transport.send(this.explicitHostId ?? 'all', msg);
  }

  /**
   * A6 (2026-10-31): this player's rig or table changed after HELLO (it joined before its table loaded): tell the host
   * with PARTICIPANT_UPDATE, which answers with a HELLO_ACK to everyone (`roster`, and `tableMismatch` on a change).
   * Only the fields that changed are sent. False (nothing sent) before the join or with no change. A6.1 (2026-11-01):
   * after MATCH_READY only the rig is sent (the host passes it on to the others); a table change then is not.
   * A13: `ballEndReady` (whether this table can report ball ends) goes the same way, in the lobby only.
   * I11.4.9: so does `stream3dWaitMs` (this PC's 3D connection is still being made; 0: settled), in the lobby only.
   */
  updateParticipant(u: { rig?: ParticipantInfo['rig']; game?: GameFingerprint; ballEndReady?: boolean; stream3dWaitMs?: number; stance?: Stance; noCopy?: boolean; ownGame?: boolean }): boolean {
    this.assertActive();
    if (!this.joined) return false;
    // A17: in a lobby every key counts in every phase, and three more are read: `stance`, `noCopy`, `ownGame`.
    if (this.lobbyOn) return this.updateInLobby(u);
    if (this.s.state.phase !== 'lobby') {
      if (u.rig === undefined || u.rig === this.participant.rig) return false;
      this.participant = { ...this.participant, rig: u.rig };
      this.sendToHost(this.s.build('PARTICIPANT_UPDATE', { rig: u.rig }, this.matchIdForWire()));
      this.events.emit('rigUpdated', { playerId: this.localId, rig: u.rig });
      return true;
    }
    const payload: PayloadOf<'PARTICIPANT_UPDATE'> = {};
    if (u.rig !== undefined && u.rig !== this.participant.rig) payload.rig = u.rig;
    if (u.game !== undefined && compareFingerprints(this.game, u.game, this.localId).length > 0) payload.game = { ...u.game };
    if (u.ballEndReady !== undefined && u.ballEndReady !== this.ballEndReady) payload.ballEndReady = u.ballEndReady;
    // I11.4.9: sent whenever the caller gives it (the caller sends it only on a change; the host compares).
    if (u.stream3dWaitMs !== undefined) payload.stream3dWaitMs = Math.max(0, Math.min(120_000, Math.round(u.stream3dWaitMs)));
    if (payload.rig === undefined && payload.game === undefined && payload.ballEndReady === undefined && payload.stream3dWaitMs === undefined) return false;
    if (payload.rig !== undefined) this.participant = { ...this.participant, rig: payload.rig };
    if (payload.game !== undefined) this.game = { ...payload.game };
    if (payload.ballEndReady !== undefined) this.ballEndReady = payload.ballEndReady;
    this.sendToHost(this.s.build('PARTICIPANT_UPDATE', payload, this.matchIdForWire()));
    return true;
  }

  /** A17: `updateParticipant` in a lobby: what changed, in any phase, under the lobby's code. */
  private updateInLobby(u: { rig?: ParticipantInfo['rig']; game?: GameFingerprint; ballEndReady?: boolean; stream3dWaitMs?: number; stance?: Stance; noCopy?: boolean; ownGame?: boolean }): boolean {
    const payload: PayloadOf<'PARTICIPANT_UPDATE'> = {};
    if (u.rig !== undefined && u.rig !== this.participant.rig) payload.rig = u.rig;
    if (u.game !== undefined && compareFingerprints(this.game, u.game, this.localId).length > 0) payload.game = { ...u.game };
    if (u.ballEndReady !== undefined && u.ballEndReady !== this.ballEndReady) payload.ballEndReady = u.ballEndReady;
    // I11.4.9: counted by the lobby's PC whenever no game is being played (every start of a lobby waits for it).
    if (u.stream3dWaitMs !== undefined && this.s.state.phase !== 'running') payload.stream3dWaitMs = Math.max(0, Math.min(120_000, Math.round(u.stream3dWaitMs)));
    if (u.stance !== undefined && u.stance !== this.myStance) payload.stance = u.stance;
    if (u.noCopy !== undefined && u.noCopy !== this.saidNoCopy) payload.noCopy = u.noCopy;
    if (u.ownGame !== undefined && u.ownGame !== this.saidOwnGame) payload.ownGame = u.ownGame;
    if (Object.keys(payload).length === 0) return false;
    if (payload.rig !== undefined) this.participant = { ...this.participant, rig: payload.rig };
    if (payload.game !== undefined) this.game = { ...payload.game };
    if (payload.ballEndReady !== undefined) this.ballEndReady = payload.ballEndReady;
    if (payload.stance !== undefined) this.myStance = payload.stance;
    if (payload.noCopy !== undefined) this.saidNoCopy = payload.noCopy;
    if (payload.ownGame !== undefined) this.saidOwnGame = payload.ownGame;
    this.sendToHost(this.s.build('PARTICIPANT_UPDATE', payload, this.lobbyIdForWire()));
    // A6.1: this player's own rig after a match's start is told here as it always was.
    if (payload.rig !== undefined && this.s.state.phase !== 'lobby') this.events.emit('rigUpdated', { playerId: this.localId, rig: payload.rig });
    return true;
  }

  /**
   * B26 (2026-11-16): flag one of this player's own balls (the Midnight Madness flag): to the host as a
   * PARTICIPANT_UPDATE, which it passes on to the others (a host from before B26 passes nothing on), and `advisory`
   * here. Never logged. False (nothing sent) before MATCH_READY.
   */
  reportAdvisory(advisory: PlayerAdvisory): boolean {
    this.assertActive();
    if (!this.joined || this.s.state.phase === 'lobby') return false;
    const msg = this.s.build('PARTICIPANT_UPDATE', { advisory }, this.lobbyIdForWire());
    this.sendToHost(msg);
    this.events.emit('advisory', { playerId: this.localId, advisory: msg.payload.advisory! });
    return true;
  }

  /**
   * B26.4 (2026-11-16): how the Midnight Madness setting reads on this player's own table, to the host as a
   * PARTICIPANT_UPDATE in any phase: in the lobby the host lists it in HELLO_ACK for everyone, after MATCH_READY it
   * passes the update on (a host from before B26.4 does neither). Never logged. False (nothing sent) before the join.
   */
  reportMidnightMode(mode: MidnightMode): boolean {
    this.assertActive();
    if (!this.joined) return false;
    this.sendToHost(this.s.build('PARTICIPANT_UPDATE', { midnightMode: { enabled: mode.enabled, adjustment: mode.adjustment } }, this.lobbyIdForWire()));
    return true;
  }

  /** Answer the held grant. Locks input again. `override` exists so tests can send bad grantSeqs. */
  reportBallEnd(
    finalScore: number,
    detectorReason: PayloadOf<'BALL_END'>['detectorReason'],
    shootAgain = false,
    override: { grantSeq?: number; ballNumber?: number } = {},
  ): Message<'BALL_END'> {
    this.assertActive();
    const g = this._myGrant;
    const grantSeq = override.grantSeq ?? g?.grantSeq;
    if (grantSeq === undefined) throw new Error('reportBallEnd: no grant held');
    const msg = this.s.build(
      'BALL_END',
      { grantSeq, ballNumber: override.ballNumber ?? g?.ballNumber ?? 1, finalScore, detectorReason, shootAgain },
      this.matchIdForWire(),
    );
    if (override.grantSeq === undefined) {
      this._inputUnlocked = false;
      this._myGrant = null;
      this.unanswered.ballEnd = msg.payload;
    }
    this.sendToHost(msg);
    return msg;
  }

  reportState(state: Omit<PayloadOf<'STATE'>, 'extraBalls'> & { extraBalls?: number }): void {
    this.assertActive();
    // A17: a member who is not in the game reports nothing from their own table.
    if (this.watchesNow()) return;
    this.sendToHost(this.s.build('STATE', state, this.matchIdForWire()));
  }

  /**
   * D2: a WebRTC signal for `to`, through the host (it forwards it to `to` only, or consumes it when `to` is the host).
   * Never throws: ICE callbacks fire late, after a step-up or a drop, and a lost signal costs a renegotiation, not the
   * match. False when nothing was sent.
   */
  sendMediaSignal(to: PlayerId, signal: OutgoingMediaSignal): boolean {
    if (this.detached || to === this.localId) return false;
    let msg: Message<'MEDIA_SIGNAL'>;
    try {
      msg = this.s.build('MEDIA_SIGNAL', { ...signal, to }, this.lobbyIdForWire());
    } catch {
      return false; // not a valid MEDIA_SIGNAL (an oversized SDP, a bad id): the schema refused it
    }
    this.sendToHost(msg);
    return true;
  }

  reportDmd(frame: PayloadOf<'DMD_FRAME'>): void {
    this.assertActive();
    if (this.watchesNow()) return;
    this.sendToHost(this.s.build('DMD_FRAME', frame, this.matchIdForWire()));
  }

  reportGameOver(finalScore: number, ballsPlayed: number): void {
    this.assertActive();
    if (this.watchesNow()) return;
    this._inputUnlocked = false;
    this._myGrant = null;
    const msg = this.s.build('GAME_OVER', { finalScore, ballsPlayed }, this.matchIdForWire());
    this.unanswered.gameOver = msg.payload;
    this.sendToHost(msg);
  }

  forfeit(reason: string): void {
    this.assertActive();
    if (this.watchesNow()) return;
    const msg = this.s.build('FORFEIT', { player: this.localId, reason }, this.matchIdForWire());
    this.unanswered.forfeit = msg.payload;
    this.sendToHost(msg);
  }

  pause(reason: PayloadOf<'PAUSE'>['reason'] = 'requested'): void {
    this.assertActive();
    if (this.watchesNow()) return;
    this.sendToHost(this.s.build('PAUSE', { reason, player: this.localId }, this.matchIdForWire()));
  }

  resume(): void {
    this.assertActive();
    if (this.watchesNow()) return;
    this.sendToHost(this.s.build('RESUME', {}, this.matchIdForWire()));
  }

  close(): void {
    this.detach();
  }

  /**
   * Open a new socket to `host` (at `endpoint`, or where it was last reached) and resume with
   * RECONNECT from this log's head, never a fresh HELLO (A2/A3, 2026-10-30), retrying within the
   * reconnect budget. A no-op on a transport without per-host links. `replacing`: links to that
   * peer no longer count as a connection (the old host after a transfer). `closeListenerOnAccept`:
   * the old host closes its listener once the new host accepted it. `delayFirst`: wait one retry
   * delay before the first attempt (after a drop, so the host has seen it too).
   */
  relinkTo(host: PlayerId, opts: { endpoint?: string; replacing?: PlayerId; closeListenerOnAccept?: boolean; delayFirst?: boolean } = {}): void {
    if (!this.s.transport.connectTo || this.detached) return;
    this.cancelReconnect();
    this.reconnecting = {
      host,
      endpoint: opts.endpoint,
      replacing: opts.replacing,
      closeListener: opts.closeListenerOnAccept ?? false,
      attemptsLeft: this.reconnectAttempts,
      inFlight: false,
      timer: null,
      deadline: this.reconnectMaxMs === null ? null : this.s.clock.now() + this.reconnectMaxMs,
    };
    if (opts.delayFirst) this.scheduleReconnect(this.reconnecting);
    else this.attemptReconnect(this.reconnecting);
  }

  private attemptReconnect(r: Reconnecting): void {
    const connectTo = this.s.transport.connectTo?.bind(this.s.transport);
    if (this.reconnecting !== r || this.detached || !connectTo) return;
    r.timer = null;
    r.attemptsLeft -= 1;
    r.inFlight = true;
    connectTo(r.host, () => this.buildReconnect(), { endpoint: r.endpoint, replacing: r.replacing }).catch((e: unknown) =>
      this.reconnectAttemptFailed(r, e instanceof Error ? e : new Error(String(e))),
    );
  }

  private scheduleReconnect(r: Reconnecting): void {
    r.timer = this.s.clock.setTimeout(() => this.attemptReconnect(r), this.reconnectDelayMs);
  }

  private reconnectAttemptFailed(r: Reconnecting, error: Error): void {
    if (this.reconnecting !== r || this.detached) return;
    r.inFlight = false;
    this.events.emit('reconnectFailed', { host: r.host, error, attemptsLeft: r.attemptsLeft });
    if (r.attemptsLeft > 0 && (r.deadline === null || this.s.clock.now() < r.deadline)) {
      this.scheduleReconnect(r);
      return;
    }
    // Out of attempts: the host counts as gone, as it always did on a mesh (host_left).
    this.reconnecting = null;
    // A18: a budget that ran out inside the grace: the drop is told before what follows from it.
    this.tellDown();
    this.down = null;
    this.downSince = null;
    if (r.host === this.hostId) this.onHostGone(r.host);
  }

  /**
   * A18: the link to `peer` dropped and a reconnect is (or stays) under way. Nobody is told for the grace: a link that
   * is back inside it was never a disconnect. With no grace, `peerLeft` is raised for every drop, as it was before.
   */
  private noteDown(peer: PlayerId): void {
    const since = this.downSince ?? this.s.clock.now();
    this.downSince = since;
    if (this.graceMs <= 0) {
      this.events.emit('peerLeft', peer);
      return;
    }
    if (this.down?.peer === peer) return;
    this.clearDown();
    this.downSince = since;
    const d = { peer, timer: null as TimerHandle | null, told: false };
    d.timer = this.s.clock.setTimeout(() => {
      d.timer = null;
      if (this.down === d) this.tellDown();
    }, this.graceMs);
    this.down = d;
  }

  /** A18: the grace is over (or what follows cannot wait for it): the drop is told, once. */
  private tellDown(): void {
    const d = this.down;
    if (!d || d.told || this.detached) return;
    if (d.timer !== null) this.s.clock.clearTimeout(d.timer);
    d.timer = null;
    d.told = true;
    this.events.emit('peerLeft', d.peer);
  }

  /**
   * A18: the link is back (or the match is over for this player). True when a drop was noted and nobody had been told
   * of it. With no drop noted (a rejoin after a restart, a relink at a host transfer) there was nothing to be quiet
   * about: false.
   */
  private clearDown(): boolean {
    const d = this.down;
    this.down = null;
    this.downSince = null;
    if (!d) return false;
    if (d.timer !== null) this.s.clock.clearTimeout(d.timer);
    return !d.told;
  }

  private cancelReconnect(): void {
    if (this.reconnecting?.timer != null) this.s.clock.clearTimeout(this.reconnecting.timer);
    this.reconnecting = null;
  }

  private buildReconnect(): Message<'RECONNECT'> {
    if (this.lobbyOn) {
      // A17 step 6: the lobby's form, in every phase. The lobby's code in the envelope and in what is signed; the
      // match this client holds a log of (null: none); and the envelope's own `seq` under the signature, so the
      // host takes this frame once and no copy of it in another envelope.
      const held = this.s.state.matchId;
      const at = this.s.log.head();
      const seq = this.s.nextSeq();
      const sig = signCanonical(lobbyReconnectSignBody(this.throwdownCode, this.localId, held, at.hash, at.length, seq), this.s.keys.privateKey);
      return buildMessage(
        'RECONNECT',
        { player: this.localId, logHash: at.hash, logLength: at.length, signature: sig, resends: true, match: held },
        { matchId: this.throwdownCode, seq, from: this.localId, ts: this.s.clock.now() },
      );
    }
    const head = this.s.log.head();
    const matchId = this.matchIdForWire();
    const signature = signCanonical(reconnectSignBody(matchId, this.localId, head.hash, head.length), this.s.keys.privateKey);
    // A18: `resends`: this client sends its unanswered reports again after the answer (`resendUnanswered`), so a host
    // need not pause and issue the grant again to hear of a ball that ended while the link was away.
    return this.s.build('RECONNECT', { player: this.localId, logHash: head.hash, logLength: head.length, signature, resends: true }, matchId);
  }

  // ------------------------------------------------------------------------------------------
  // Plumbing
  // ------------------------------------------------------------------------------------------

  private attach(): void {
    const t = this.s.transport;
    this.unsubscribe.push(t.onMessage((from, msg) => this.handle(from, msg)));
    this.unsubscribe.push(t.onPeerLeave((peer) => this.onPeerLeave(peer)));
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.cancelReconnect();
    this.clearDown();
  }

  private assertActive(): void {
    if (this.detached) throw new Error('this ClientMatch has become host or been closed');
  }

  private matchIdForWire(): string {
    return this.s.state.matchId ?? this.throwdownCode;
  }

  /** The envelope's id on what is said to the lobby and not to a match (A17: the lobby's code); without a lobby, the match's. */
  private lobbyIdForWire(): string {
    return this.lobbyOn ? this.throwdownCode : this.matchIdForWire();
  }

  /** A17: in a lobby, this member is not in the game being played (or none is open): a watcher, with nothing to report. */
  private watchesNow(): boolean {
    return this.lobbyOn && (this.s.state.phase === 'lobby' || this.s.state.players[this.localId] === undefined);
  }

  /** A17: HELLO_ACK in a lobby. The first one says whether a match is open, whose log then follows in MATCH_LOG. */
  private noteLobby(ack: PayloadOf<'HELLO_ACK'>, first: boolean): void {
    const before = this.lobbyAck;
    this.lobbyAck = ack;
    if (first) {
      this.holdsLog = !ack.match;
      this.catchingUp = ack.match?.matchId ?? null;
      return;
    }
    // A6.1 / B26.4: while a match is open, another player's rig and Midnight Madness setting used to come as that
    // player's PARTICIPANT_UPDATE, passed on. A lobby says both in HELLO_ACK in every phase and passes nothing on,
    // so whoever listens for the two events hears a change from here.
    if (!before || this.s.state.phase === 'lobby') return;
    for (const p of ack.participants) {
      const was = before.participants.find((x) => x.playerId === p.playerId);
      if (p.playerId !== this.localId && was && was.rig !== p.rig) this.events.emit('rigUpdated', { playerId: p.playerId, rig: p.rig });
    }
    for (const m of ack.midnightModes) {
      const was = before.midnightModes.find((x) => x.playerId === m.playerId);
      if (m.playerId !== this.localId && (!was || was.enabled !== m.enabled || was.adjustment !== m.adjustment)) {
        this.events.emit('midnightMode', { playerId: m.playerId, mode: { enabled: m.enabled, adjustment: m.adjustment } });
      }
    }
  }

  /**
   * A17: the match this client was in is over, or another begins: its log is put away and everything counted per
   * match starts over. `grantSeq` begins at 1 again in the next match, so the last one seen must not outlive this.
   */
  private putMatchAway(): void {
    const matchId = this.s.state.matchId;
    const log = this.s.newMatch();
    if (matchId !== null) this.lastMatch = { matchId, log };
    this._myGrant = null;
    this._inputUnlocked = false;
    this.lastGrantSeqSeen = 0;
    this.signedGame = 0;
    this.resultsReceived.clear();
    this.logSignSent = null;
    this.unanswered = { ballEnd: null, gameOver: null, forfeit: null };
    this.hostLost = false;
    this.holdsLog = true;
    this.catchingUp = null;
    this.afterCatchUp = null;
  }

  /**
   * A17: whether a frame from the lobby's PC is read at all. A message of a match (the logged stream, RESULT) only
   * when this client holds that match's log in full and the envelope names it; everything else always.
   */
  private takesInLobby(msg: AnyMessage): boolean {
    if (!MATCH_STREAM_TYPES.has(msg.type)) return true;
    const open = this.s.state.matchId;
    if (this.holdsLog && open !== null && msg.matchId === open) return true;
    this.drop(msg, 'no_log');
    return false;
  }

  /**
   * A17: a page of the open match's log. `restart`: whatever this client held is put away and the log begins at
   * entry 0; else the entries follow the ones it holds (the rest of a RECONNECT_ACK that said `more`). Each entry is
   * checked against the hash chain as it is appended. At the last page the head must be the host's; then this
   * client is current.
   */
  private onMatchLog(msg: Message<'MATCH_LOG'>): void {
    const p = msg.payload;
    if (!this.lobbyOn || msg.from !== this.hostId) return this.drop(msg, 'unexpected');
    if (p.restart) {
      const after = this.afterCatchUp;
      this.putMatchAway();
      this.afterCatchUp = after;
      this.catchingUp = p.match;
      this.holdsLog = false;
    } else if (this.catchingUp !== p.match) {
      return this.drop(msg, 'unexpected');
    }
    const appended = this.mergeEntries(p.entries);
    const head = this.s.log.head();
    // Step 6: every page names the head of the log as it stands at the page's end, and every page is checked.
    if (appended === null || this.s.state.matchId !== p.match || head.hash !== p.logHash || head.length !== p.logLength) {
      // The log stays not held: nothing of this match is taken until a whole log arrives again.
      this.events.emit('desync', { context: 'matchlog.entries', expected: p.logHash, actual: head.hash });
      return;
    }
    if (this.afterCatchUp) this.afterCatchUp.entries += appended;
    if (p.more) return;
    this.holdsLog = true;
    this.catchingUp = null;
    this.events.emit('caughtUp', { match: p.match, entries: head.length });
    const after = this.afterCatchUp;
    this.afterCatchUp = null;
    if (after) after.done(after.entries);
    else this.maybeSignLog();
  }

  private sendToHost(msg: AnyMessage): void {
    this.s.transport.send(this.hostId ?? 'all', msg);
  }

  private drop(msg: AnyMessage, reason: DroppedInfo['reason']): void {
    this.events.emit('dropped', { from: msg.from, type: msg.type, seq: msg.seq, reason });
  }

  // ------------------------------------------------------------------------------------------
  // Inbound dispatch
  // ------------------------------------------------------------------------------------------

  /** Public so a stepping-down HostMatch can hand the triggering frame to its successor client. */
  handle(linkFrom: PlayerId, msg: AnyMessage, opts: { seqChecked?: boolean } = {}): void {
    if (this.detached) return;
    if (!opts.seqChecked && !this.s.checkSeq(msg.from, msg.seq)) {
      this.drop(msg, 'seq');
      return;
    }
    if (!this.joined) {
      if (msg.type === 'HELLO_ACK') {
        this.joined = true;
        this.ackHostId = msg.payload.hostPlayerId;
        this.ackHostKey = msg.payload.hostPublicKey;
        if (this.lobbyOn) this.noteLobby(msg.payload, true);
        // Advisory (alpha-match.md §3, 2026-10-30): the host accepted us anyway; say so on this side too.
        this.compareTable(msg.payload);
        this.events.emit('joined', msg.payload);
      } else if (msg.type === 'REFUSE') {
        this.refusedWith = msg.payload;
        this.events.emit('refused', msg.payload);
      }
      return;
    }
    const pt = this.s.state.pendingTransfer;
    if (pt && pt.newHost !== null && pt.newHost !== this.localId && pt.newHost === msg.from && HOST_ONLY_TYPES.has(msg.type)) {
      this.commitTransferAsClient();
    }
    if (msg.type === 'HOST_TRANSFER') {
      this.onHostTransfer(linkFrom, msg);
      return;
    }
    if (msg.type === 'HOST_TRANSFER_ACK') {
      this.onTransferAck(msg);
      return;
    }
    if (msg.type === 'RECONNECT_ACK') {
      this.onReconnectAck(linkFrom, msg);
      return;
    }
    if (msg.type === 'RECONNECT') {
      // Over WebSocket a client can reach the new host's listener before the new host has its
      // majority; hold it and answer at the commit, before the re-issued grant (A2, 2026-10-30).
      if (this.s.state.pendingTransfer?.newHost === this.localId && msg.from === linkFrom) {
        this.heldReconnects.push({ linkFrom, msg });
        return;
      }
      this.drop(msg, 'not_host');
      return;
    }
    if (linkFrom !== this.hostId) {
      this.drop(msg, 'not_host');
      return;
    }
    if (this.lobbyOn && !this.takesInLobby(msg)) return;
    switch (msg.type) {
      case 'MATCH_READY':
        if (msg.from !== this.hostId) return this.drop(msg, 'not_host');
        // A17: every match of a lobby has a log of its own, and MATCH_READY is its entry 0, whatever this client
        // held (the log of a match whose MATCH_END it never got, or a half-sent one).
        if (this.lobbyOn) this.putMatchAway();
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.events.emit('ready', msg.payload);
        return;
      case 'HELLO_ACK':
        // A6 (2026-10-31): the host re-sends it in the lobby when a rig or a table changed; after MATCH_READY the
        // roster in the log is final.
        // A17: in a lobby it is the lobby as it is now, in every phase.
        if ((this.s.state.phase !== 'lobby' && !this.lobbyOn) || msg.payload.hostPlayerId !== this.hostId) return this.drop(msg, 'unexpected');
        if (this.lobbyOn) this.noteLobby(msg.payload, false);
        this.compareTable(msg.payload);
        this.events.emit('roster', msg.payload);
        return;
      case 'TURN_GRANT':
        this.onGrant(msg);
        return;
      case 'BALL_END':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.noteAnswered(msg);
        if (msg.from === this.localId) {
          this._myGrant = null;
          this._inputUnlocked = false;
        }
        this.events.emit('ballEnd', msg);
        this.maybeSignLog();
        return;
      case 'TURN_PASS': {
        // A13: only from the host, and only for the outstanding grant; anything else would fork the fold.
        const g = this.s.state.currentGrant?.grant;
        if (msg.from !== this.hostId) return this.drop(msg, 'not_host');
        if (!g || g.grantSeq !== msg.payload.grantSeq || g.player !== msg.payload.player) return this.drop(msg, 'unexpected');
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.noteAnswered(msg);
        if (msg.payload.player === this.localId) {
          this._myGrant = null;
          this._inputUnlocked = false;
        }
        this.events.emit('turnPassed', msg);
        this.maybeSignLog();
        return;
      }
      case 'GAME_OVER':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.noteAnswered(msg);
        this.events.emit('gameOver', msg);
        this.maybeSignLog();
        return;
      case 'FORFEIT':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.noteAnswered(msg);
        if (msg.payload.player === this.localId) {
          this._myGrant = null;
          this._inputUnlocked = false;
        }
        this.events.emit('forfeit', msg);
        this.maybeSignLog();
        return;
      case 'PAUSE':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this._inputUnlocked = false;
        this.events.emit('pause', msg.payload);
        return;
      case 'RESUME':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.events.emit('resume', { from: msg.from });
        return;
      case 'STATE':
        this.events.emit('state', msg);
        return;
      case 'DMD_FRAME':
        this.events.emit('dmd', msg);
        return;
      case 'MEDIA_SIGNAL':
        // The host forwards a signal to its `to` only (D2); anything else reaching here is a host bug, not ours to use.
        if (msg.payload.to !== this.localId) return this.drop(msg, 'unexpected');
        this.events.emit('mediaSignal', { from: msg.from, signal: msg.payload });
        return;
      case 'REJECT':
        this.noteAnswered(msg);
        this.events.emit('reject', msg.payload);
        return;
      case 'NEXT_GAME': {
        // A10: only from the host, between games, the next number; anything else would fork the fold.
        const st = this.s.state;
        if (msg.from !== this.hostId) return this.drop(msg, 'not_host');
        if (st.phase !== 'ended' || msg.payload.game !== st.gameNumber + 1) return this.drop(msg, 'unexpected');
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.noteAnswered(msg);
        this._myGrant = null;
        this._inputUnlocked = false;
        this.events.emit('nextGame', msg.payload);
        return;
      }
      case 'MATCH_END':
        if (msg.from !== this.hostId || this.ended) return this.drop(msg, 'unexpected');
        if (this.lobbyOn) {
          // A17: back to the lobby. Nothing closes; the next MATCH_READY starts a log of its own.
          if (this.s.state.matchId === null && this.catchingUp === null) return this.drop(msg, 'unexpected');
          this.putMatchAway();
          this.events.emit('matchEnded', msg.payload);
          return;
        }
        this.ended = true;
        this.cancelReconnect();
        this.events.emit('matchEnded', msg.payload);
        return;
      case 'PARTICIPANT_UPDATE':
        // A6.1 (2026-11-01): another player's rig (or the host's own) after MATCH_READY; in the lobby HELLO_ACK says it.
        // B26: or a flag about one of that player's own balls (`advisory`).
        // B26.4: or how the Midnight Madness setting reads on that player's table (`midnightMode`).
        if (this.s.state.phase === 'lobby' || (msg.payload.rig === undefined && msg.payload.advisory === undefined && msg.payload.midnightMode === undefined) || msg.from === this.localId) return this.drop(msg, 'unexpected');
        if (msg.payload.rig !== undefined) this.events.emit('rigUpdated', { playerId: msg.from, rig: msg.payload.rig });
        if (msg.payload.advisory !== undefined) this.events.emit('advisory', { playerId: msg.from, advisory: msg.payload.advisory });
        if (msg.payload.midnightMode !== undefined) this.events.emit('midnightMode', { playerId: msg.from, mode: msg.payload.midnightMode });
        return;
      case 'RESULT':
        this.onResult(msg);
        return;
      case 'MATCH_LOG':
        this.onMatchLog(msg);
        return;
      case 'LOBBY_CLOSED':
        // A17: the lobby is over for everyone: nothing follows, and a link that drops now is not made again.
        if (!this.lobbyOn || msg.from !== this.hostId || this.ended) return this.drop(msg, 'unexpected');
        this.ended = true;
        this.cancelReconnect();
        this.events.emit('lobbyClosed', msg.payload);
        return;
      default:
        this.drop(msg, 'unexpected');
    }
  }

  /**
   * A17 step 6: in a lobby `hostGame` is a PICK: its identity keys say which table, and the rest (the ROM's hash, the
   * patch, the build) is null or empty, because those are facts of one PC's copy. Compared key by key it would flag
   * every member. `compareHostGame` walks the keys of the `hostGame` it is given, so it is given the pick with the
   * identity keys alone; the pick is then kept whole. Without a lobby, and for a host that says no table, nothing
   * changes.
   */
  private compareTable(ack: PayloadOf<'HELLO_ACK'>): void {
    if (!this.lobbyOn || !ack.hostGame) return this.compareHostGame(ack);
    this.compareHostGame({ ...ack, hostGame: identityOnly(ack.hostGame) as GameFingerprint });
    this.ackHostGame = { ...ack.hostGame };
  }

  /** `tableMismatch` when what differs from `hostGame` changed since the last HELLO_ACK (first one: only a difference). */
  private compareHostGame(ack: PayloadOf<'HELLO_ACK'>): void {
    this.ackHostGame = ack.hostGame ? { ...ack.hostGame } : null;
    const mismatches = ack.hostGame ? compareFingerprints(ack.hostGame, this.game, ack.hostPlayerId) : [];
    const fields = mismatches.map((m) => m.field).join(',');
    if (fields !== this.mismatchFields) {
      this.mismatchFields = fields;
      this.events.emit('tableMismatch', { playerId: this.localId, mismatches });
    }
    // A8 (2026-10-31): the others, from the host's list (this player's own entry stays its own comparison above). A
    // host before A8 sends none: nobody else is flagged, as before.
    const now = new Map(ack.tableMismatches.filter((t) => t.playerId !== this.localId).map((t) => [t.playerId, t.mismatches] as const));
    for (const id of new Set([...this.othersMismatched.keys(), ...now.keys()])) {
      const next = now.get(id) ?? [];
      const before = (this.othersMismatched.get(id) ?? []).map((m) => m.field).join(',');
      if (next.length > 0) this.othersMismatched.set(id, next.map((x) => ({ ...x })));
      else this.othersMismatched.delete(id);
      if (next.map((m) => m.field).join(',') !== before) this.events.emit('tableMismatch', { playerId: id, mismatches: next.map((x) => ({ ...x })) });
    }
  }

  private onGrant(msg: Message<'TURN_GRANT'>): void {
    const { grant, grantSig } = msg.payload;
    const key = this.hostPublicKey;
    if (!key || msg.from !== this.hostId) return this.drop(msg, 'not_host');
    if (!verifyCanonical(grant, grantSig, key)) return this.drop(msg, 'bad_signature');
    // A17: `grantSeq` starts at 1 in every match of a lobby, so the number alone no longer tells an old grant from a
    // new one: the match id inside the grant, which is signed, must be the open match's.
    if (this.lobbyOn && grant.matchId !== this.s.state.matchId) return this.drop(msg, 'stale_grant');
    if (grant.grantSeq <= this.lastGrantSeqSeen) return this.drop(msg, 'stale_grant');
    // A10: a grant for another game than the one this log is in (a host that missed a NEXT_GAME, or one from before it).
    if (grant.game !== undefined && grant.game !== this.s.state.gameNumber) return this.drop(msg, 'stale_grant');
    const head = this.s.log.head();
    if (grant.logHash !== head.hash) this.events.emit('desync', { context: 'grant.logHash', expected: grant.logHash, actual: head.hash });
    this.lastGrantSeqSeen = grant.grantSeq;
    this.s.commit({ ts: msg.ts, kind: 'grant', from: msg.from, message: msg });
    this.events.emit('grant', grant);
    if (grant.player === this.localId) {
      this._myGrant = grant;
      this._inputUnlocked = true;
      this.events.emit('myTurn', grant);
    } else {
      this._myGrant = null;
      this._inputUnlocked = false;
    }
  }

  /** Once per game (A10), when this client's log shows that game ended and it played in it. */
  private maybeSignLog(): void {
    const st = this.s.state;
    if (this.signedGame === st.gameNumber || st.phase !== 'ended' || !st.matchId || !st.playerOrder.includes(this.localId)) return;
    this.signedGame = st.gameNumber;
    const head = this.s.log.head();
    const payload: PayloadOf<'LOG_SIGN'> = {
      logHash: head.hash,
      logLength: head.length,
      signature: signCanonical(logSignBody(st.matchId, head.hash, head.length), this.s.keys.privateKey),
    };
    this.logSignSent = { game: st.gameNumber, payload };
    this.sendToHost(this.s.build('LOG_SIGN', payload, st.matchId));
    this.events.emit('logSigned', payload);
  }

  /**
   * A10: once per game. A RESULT for an earlier game (sent again after a reconnect) is checked against this log's entry
   * at that game's end, which is where the host froze it; the current game's against the head, as before.
   */
  private onResult(msg: Message<'RESULT'>): void {
    const r = msg.payload;
    if (this.resultsReceived.has(r.game)) return;
    const key = this.hostPublicKey;
    const head = this.s.log.head();
    const atEnd = r.logLength > 0 && r.logLength <= head.length ? this.s.log.at(r.logLength - 1)?.hash : r.logLength === 0 ? head.hash : undefined;
    const logMatches = r.game < this.s.state.gameNumber ? atEnd === r.logHash : r.logHash === head.hash && r.logLength === head.length;
    const signatureValid = key !== null && verifyCanonical(logSignBody(r.matchId, r.logHash, r.logLength), r.hostSignature, key);
    if (!logMatches) this.events.emit('desync', { context: 'result.logHash', expected: r.logHash, actual: atEnd ?? head.hash });
    this.resultsReceived.add(r.game);
    if (this.logSignSent?.game === r.game) this.logSignSent = null;
    this.events.emit('result', { result: r, logMatches, signatureValid });
  }

  // ------------------------------------------------------------------------------------------
  // Host transfer
  // ------------------------------------------------------------------------------------------

  private onPeerLeave(peer: PlayerId): void {
    if (this.detached) return;
    const r = this.reconnecting;
    if (r && r.host === peer && r.inFlight) {
      // The new socket closed before RECONNECT_ACK: one failed attempt.
      this.noteDown(peer);
      this.reconnectAttemptFailed(r, new Error(`link to ${peer} closed before RECONNECT_ACK`));
      return;
    }
    if (peer === this.hostId && this.mayReconnect()) {
      // On a star a dropped host link looks the same whether we or the host went away: try to
      // resume first; the host counts as gone only when the attempts run out (A3, 2026-10-30).
      // A18: and nobody is told of it while the grace runs.
      this.noteDown(peer);
      this.relinkTo(peer, { delayFirst: true });
      return;
    }
    this.events.emit('peerLeft', peer);
    if (peer === this.hostId) {
      this.onHostGone(peer);
      return;
    }
    this.gone.add(peer);
  }

  private mayReconnect(): boolean {
    // A10: a RESULT no longer ends the match (the next game may follow); MATCH_END does.
    // A17 step 6: a lobby's member comes back in every phase, the lobby with no match open included.
    return this.s.transport.topology === 'star' && this.s.transport.connectTo !== undefined && (this.lobbyOn ? this.joined : this.s.state.phase !== 'lobby') && !this.ended;
  }

  private onHostGone(peer: PlayerId): void {
    if (this.s.state.phase === 'running' && !this.s.state.pendingTransfer && !this.hostLost) {
      this.hostLost = true;
      this.events.emit('hostLost', peer);
      if (this.hostLeftTransfer) this.proposeIfCandidate();
      return;
    }
    const known = this.gone.has(peer);
    this.gone.add(peer);
    if (!known && peer === this.hostId && this.s.state.phase !== 'running') this.events.emit('hostGone', peer);
  }

  private votingParticipants(): PlayerId[] {
    const hostId = this.hostId;
    return remainingParticipants(this.s.state).filter((id) => !this.gone.has(id) && !(this.hostLost && id === hostId));
  }

  /** Host gone: the lowest remaining playerId proposes itself. */
  private proposeIfCandidate(): void {
    const candidates = this.votingParticipants().sort();
    if (candidates[0] !== this.localId) return;
    const st = this.s.state;
    const head = this.s.log.head();
    const msg = this.s.build(
      'HOST_TRANSFER',
      {
        proposer: this.localId,
        newHost: this.localId,
        reason: 'host_left',
        logHash: head.hash,
        logLength: head.length,
        currentGrant: st.currentGrant,
        newHostPublicKey: this.publicKey,
      },
      this.matchIdForWire(),
    );
    this.s.commit({ ts: msg.ts, kind: 'msg', from: this.localId, message: msg });
    this.s.transport.send('all', msg);
    this.transferAccepts = new Set([this.localId]);
    this.events.emit('transferProposed', msg.payload);
    this.checkTransferMajority();
  }

  private onHostTransfer(linkFrom: PlayerId, msg: Message<'HOST_TRANSFER'>): void {
    const st = this.s.state;
    const p = msg.payload;
    // A17: a lobby does not change hands.
    if (this.lobbyOn) return this.drop(msg, 'unexpected');
    if (st.phase !== 'running' || st.pendingTransfer) return this.drop(msg, 'unexpected');
    if (p.reason === 'host_requested') {
      if (msg.from !== this.hostId || linkFrom !== this.hostId) return this.drop(msg, 'not_host');
    } else {
      if (!this.hostLost || msg.from !== p.proposer || !st.players[msg.from]) return this.drop(msg, 'unexpected');
    }
    // newHostPublicKey must be newHost's roster key (and for host_left the proposer is the new host);
    // otherwise the proposal is ignored outright: no log entry, no ack.
    const target = st.participants.find((x) => x.playerId === p.newHost);
    if (!target || target.publicKey !== p.newHostPublicKey || (p.reason === 'host_left' && p.newHost !== p.proposer)) {
      return this.drop(msg, 'bad_transfer');
    }
    const headBefore = this.s.log.head();
    const accept = p.logHash === headBefore.hash && p.logLength === headBefore.length;
    this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
    this.events.emit('transferProposed', p);
    const ack = this.s.build('HOST_TRANSFER_ACK', { proposer: p.proposer, accept, logHash: headBefore.hash }, this.matchIdForWire());
    this.s.transport.send('all', ack);
    this.transferAccepts = accept ? new Set([p.proposer, this.localId]) : new Set([p.proposer]);
    if (this.s.state.pendingTransfer?.newHost === this.localId) {
      this.checkTransferMajority();
    } else if (p.newHostEndpoint !== null) {
      // Over WebSocket: move to the new host's listener now; the old host's link stops counting
      // as a connection, so its close is not a disconnect (A2, 2026-10-30).
      this.relinkTo(p.newHost, { endpoint: p.newHostEndpoint, replacing: st.hostId ?? undefined });
    }
  }

  // ------------------------------------------------------------------------------------------
  // Reconnect (A2/A3, 2026-10-30)
  // ------------------------------------------------------------------------------------------

  private onReconnectAck(linkFrom: PlayerId, msg: Message<'RECONNECT_ACK'>): void {
    const want = this.reconnecting;
    if (!want || !want.inFlight || linkFrom !== want.host || msg.from !== want.host) return this.drop(msg, 'unexpected');
    this.cancelReconnect();
    const p = msg.payload;
    if (!p.accept) {
      this.clearDown();
      this.events.emit('reconnectRejected', { host: want.host, code: p.code });
      // A17 step 6: the place in the lobby is gone (it ran out while this PC was away): a newcomer again, with a
      // fresh HELLO on the link the RECONNECT opened, which a lobby takes while there is room.
      if (this.lobbyOn && p.code === 'unknown_player' && !this.ended) {
        this.putMatchAway();
        this.joined = false;
        this.lobbyAck = null;
        this.events.emit('rejoining', want.host);
        this.join();
      }
      return;
    }
    if (this.lobbyOn && p.restart === true) {
      // A17 step 6: this client's log is not of the open match (it ended while this PC was away, another began, or
      // none is open): it is put away. The open match's log, when there is one, follows in MATCH_LOG from entry 0.
      const had = this.s.state.matchId;
      const games = this.resultsReceived.size;
      this.putMatchAway();
      if (had !== null && had !== (p.match ?? null)) this.events.emit('matchEnded', { games, reason: 'the match ended while this PC was away' });
      const back = (entries: number): void => {
        const quiet = this.clearDown();
        this.events.emit('reconnected', { host: want.host, entries, quiet });
        this.maybeSignLog();
      };
      if (p.match) {
        this.holdsLog = false;
        this.catchingUp = p.match;
        this.afterCatchUp = { entries: 0, done: back };
        return;
      }
      back(0);
      return;
    }
    const appended = this.mergeEntries(p.entries);
    const head = this.s.log.head();
    // A17: an answer that says `more` holds the first page only; like every answer it names the head of the log
    // it carries, so the check is the same.
    const more = this.lobbyOn && p.more === true && appended !== null;
    if (appended === null || head.hash !== p.logHash) {
      this.events.emit('desync', { context: 'reconnect.entries', expected: p.logHash, actual: head.hash });
    }
    if (want.closeListener) this.s.transport.closeListener?.();
    const done = (entries: number): void => {
      // A18: what was reported into the dead link first, then the news (a listener may answer it with a RESUME).
      this.resendUnanswered();
      const quiet = this.clearDown();
      this.events.emit('reconnected', { host: want.host, entries, quiet });
      this.maybeSignLog();
    };
    if (more) {
      // The rest follows in MATCH_LOG pages; until the last one nothing of the match is taken live, and what this
      // reconnect still has to do waits for it (`onMatchLog`).
      this.holdsLog = false;
      this.catchingUp = this.s.state.matchId;
      this.afterCatchUp = { entries: appended ?? 0, done };
      return;
    }
    // A17 step 6: a client that dropped in the middle of being sent the log has the rest of it now.
    if (this.lobbyOn && appended !== null) {
      this.holdsLog = true;
      this.catchingUp = null;
    }
    done(appended ?? 0);
  }

  /**
   * A18: the host answered one of this player's reports: its echo is in the log (live or from a RECONNECT_ACK), the
   * host passed that turn or forfeited this player, a new game began, or it said REJECT. Nothing is sent again for it.
   */
  private noteAnswered(msg: AnyMessage): void {
    const u = this.unanswered;
    const me = this.localId;
    if (msg.type === 'BALL_END' && msg.from === me) u.ballEnd = null;
    else if (msg.type === 'TURN_PASS' && msg.payload.player === me) u.ballEnd = null;
    else if (msg.type === 'GAME_OVER' && msg.from === me) u.ballEnd = u.gameOver = null;
    else if (msg.type === 'FORFEIT' && msg.payload.player === me) u.ballEnd = u.gameOver = u.forfeit = null;
    else if (msg.type === 'NEXT_GAME') u.ballEnd = u.gameOver = u.forfeit = null;
    else if (msg.type === 'REJECT') {
      if (msg.payload.refType === 'BALL_END') u.ballEnd = null;
      else if (msg.payload.refType === 'GAME_OVER') u.gameOver = null;
      else if (msg.payload.refType === 'FORFEIT') u.forfeit = null;
    }
  }

  /**
   * A18: after an accepted RECONNECT, with the log merged: each of this player's reports the host never answered goes
   * out again in a new envelope, when the log still has a place for it: a BALL_END while the grant it answers is the
   * outstanding one (the host takes it during a pause too), a GAME_OVER or FORFEIT while this player's game is still
   * on. One that has no place any more is dropped (a grant issued again under a new number is answered by whoever
   * plays it: the companion reports the table's ball end again, `main/match-host.ts` `tryReconcile`).
   */
  private resendUnanswered(): void {
    const u = this.unanswered;
    const st = this.s.state;
    const me = this.localId;
    if (st.pendingTransfer) return;
    const g = st.phase === 'running' ? st.currentGrant?.grant : undefined;
    if (u.ballEnd && g && g.player === me && g.grantSeq === u.ballEnd.grantSeq) this.sendToHost(this.s.build('BALL_END', u.ballEnd, this.matchIdForWire()));
    else u.ballEnd = null;
    const playing = st.phase === 'running' && st.players[me]?.status === 'playing';
    if (u.gameOver && playing) this.sendToHost(this.s.build('GAME_OVER', u.gameOver, this.matchIdForWire()));
    else u.gameOver = null;
    if (u.forfeit && playing) this.sendToHost(this.s.build('FORFEIT', u.forfeit, this.matchIdForWire()));
    else u.forfeit = null;
    // The signature of a game that ended, when the host's RESULT for it has not come: the host waits for it (for its
    // log-sign timeout), and one that went into the dead link would never arrive. A second one changes nothing there.
    const ls = this.logSignSent;
    if (ls && st.phase === 'ended' && ls.game === st.gameNumber && !this.resultsReceived.has(ls.game) && st.matchId) this.sendToHost(this.s.build('LOG_SIGN', ls.payload, st.matchId));
    else if (ls && ls.game !== st.gameNumber) this.logSignSent = null;
  }

  /**
   * Append the host's entries after our head, checking each `prevHash` and `hash`, so this log is
   * the host's log. Entries we already hold are skipped when their hash agrees. Returns how many
   * were appended, or null at the first entry that does not chain (nothing after it is taken).
   */
  private mergeEntries(entries: PayloadOf<'RECONNECT_ACK'>['entries']): number | null {
    const seenBefore = this.lastGrantSeqSeen;
    let appended = 0;
    for (const raw of entries) {
      const log = this.s.log;
      if (raw.index < log.length) {
        if (log.at(raw.index)?.hash !== raw.hash) return null;
        continue;
      }
      if (raw.index !== log.length || raw.prevHash !== log.head().hash) return null;
      let message: AnyMessage | undefined;
      try {
        message = raw.message === undefined ? undefined : parseMessage(raw.message);
      } catch {
        return null;
      }
      const body: LogEntryBody = { index: raw.index, prevHash: raw.prevHash, ts: raw.ts, kind: raw.kind, from: raw.from };
      if (message !== undefined) body.message = message;
      if (raw.event !== undefined) body.event = raw.event;
      if (hashEntry(body) !== raw.hash) return null;
      const oldHost = this.s.state.hostId;
      const entry = this.s.commit({ ts: raw.ts, kind: raw.kind, from: raw.from, message, event: raw.event });
      appended += 1;
      this.afterMergedEntry(entry, oldHost);
    }
    // The input lock: released only for an outstanding grant that names us, is newer than any we
    // had seen before this merge, and verifies against the host key the log now names.
    const cg = this.s.state.currentGrant;
    const key = this.hostPublicKey;
    if (cg && cg.grant.player === this.localId) {
      if (cg.grant.grantSeq > seenBefore && key && verifyCanonical(cg.grant, cg.grantSig, key)) {
        this._myGrant = cg.grant;
        this._inputUnlocked = true;
        this.events.emit('myTurn', cg.grant);
      }
    } else {
      this._myGrant = null;
      this._inputUnlocked = false;
    }
    return appended;
  }

  /** The events a live entry would have raised, for an entry that arrived in a RECONNECT_ACK. */
  private afterMergedEntry(entry: LogEntry, oldHost: PlayerId | null): void {
    if (entry.event?.type === 'host_transfer') {
      if (oldHost) this.noteTransferCommitted(oldHost);
      this.events.emit('hostChanged', { from: entry.event.from, to: entry.event.to });
      return;
    }
    const msg = entry.message;
    if (!msg) return;
    this.noteAnswered(msg);
    switch (msg.type) {
      case 'MATCH_READY':
        this.events.emit('ready', msg.payload);
        return;
      case 'NEXT_GAME':
        this.events.emit('nextGame', msg.payload);
        return;
      case 'TURN_GRANT':
        this.lastGrantSeqSeen = Math.max(this.lastGrantSeqSeen, msg.payload.grant.grantSeq);
        this.events.emit('grant', msg.payload.grant);
        return;
      case 'BALL_END':
        if (msg.from === this.localId) {
          this._myGrant = null;
          this._inputUnlocked = false;
        }
        this.events.emit('ballEnd', msg);
        return;
      case 'TURN_PASS':
        if (msg.payload.player === this.localId) {
          this._myGrant = null;
          this._inputUnlocked = false;
        }
        this.events.emit('turnPassed', msg);
        return;
      case 'GAME_OVER':
        this.events.emit('gameOver', msg);
        return;
      case 'FORFEIT':
        this.events.emit('forfeit', msg);
        return;
      case 'PAUSE':
        this._inputUnlocked = false;
        this.events.emit('pause', msg.payload);
        return;
      case 'RESUME':
        this.events.emit('resume', { from: msg.from });
        return;
      case 'HOST_TRANSFER':
        this.events.emit('transferProposed', msg.payload);
        return;
      default:
        return;
    }
  }

  private onTransferAck(msg: Message<'HOST_TRANSFER_ACK'>): void {
    const pt = this.s.state.pendingTransfer;
    if (!pt || msg.payload.proposer !== pt.proposer) return this.drop(msg, 'unexpected');
    this.events.emit('transferAck', msg);
    if (msg.payload.accept && msg.payload.logHash === pt.logHash) this.transferAccepts.add(msg.from);
    if (pt.newHost === this.localId) this.checkTransferMajority();
  }

  private checkTransferMajority(): void {
    const pt = this.s.state.pendingTransfer;
    if (!pt || pt.newHost !== this.localId) return;
    const remaining = this.votingParticipants();
    const accepts = [...this.transferAccepts].filter((id) => remaining.includes(id)).length;
    if (isStrictMajority(accepts, remaining.length)) this.commitAndBecomeHost();
  }

  private commitTransferEvent(): { oldHost: PlayerId; newHost: PlayerId } | null {
    const pt = this.s.state.pendingTransfer;
    const oldHost = this.s.state.hostId;
    if (!pt || !pt.newHost || !oldHost) return null;
    this.s.commit({
      ts: pt.proposedTs,
      kind: 'event',
      from: oldHost,
      event: { type: 'host_transfer', reason: pt.reason, proposer: pt.proposer, from: oldHost, to: pt.newHost, newHostPublicKey: pt.newHostPublicKey },
    });
    this.noteTransferCommitted(oldHost);
    return { oldHost, newHost: pt.newHost };
  }

  private noteTransferCommitted(oldHost: PlayerId): void {
    if (this.hostLost) {
      this.gone.add(oldHost);
      this.hostLost = false;
    }
    this.transferAccepts.clear();
  }

  private commitTransferAsClient(): void {
    const done = this.commitTransferEvent();
    if (done) this.events.emit('hostChanged', { from: done.oldHost, to: done.newHost });
  }

  private commitAndBecomeHost(): void {
    const done = this.commitTransferEvent();
    if (!done) return;
    this.detach();
    const host = HostMatch.resumeFromLog(this.s.log, {
      transport: this.s.transport,
      keys: this.s.keys,
      clock: this.s.clock,
      session: this.s,
      gone: this.gone,
      tableMismatches: this.tableMismatches(),
      disconnectGraceMs: this.graceMs,
      ...this.hostTimeouts,
    });
    this.events.emit('hostChanged', { from: done.oldHost, to: done.newHost });
    this.events.emit('becameHost', host);
    // Answer the held RECONNECTs first, so those clients get the commit event before the re-issued grant.
    for (const h of this.heldReconnects.splice(0)) host.handle(h.linkFrom, h.msg, { seqChecked: true });
    host.run();
  }
}
