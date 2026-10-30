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
 */
import type { AnyMessage, GameFingerprint, GrantBody, Message, MessageType, ParticipantInfo, PayloadOf, PlayerId } from '@castcade/protocol';
import { parseMessage, PROTOCOL_VERSION } from '@castcade/protocol';
import type { Clock } from './clock.js';
import { Emitter } from './events.js';
import { HostMatch, type ReconnectCode } from './host.js';
import { signCanonical, verifyCanonical, type KeyPair } from './keys.js';
import { hashEntry, type LogEntry, type LogEntryBody, type LogHead, type MatchLog } from './log.js';
import { logSignBody, reconnectSignBody } from './result.js';
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
  /** Where HELLO goes on a full-mesh transport; omit on a point-to-point transport. */
  hostId?: PlayerId;
  clock?: Clock;
  /** Used if this client becomes host after a transfer. */
  hostTimeouts?: { ballEndTimeoutMs?: number; logSignTimeoutMs?: number };
}

export interface AdoptOptions {
  participant: ParticipantInfo;
  game: GameFingerprint;
  throwdownCode: string;
  companionVersion?: string;
  gone?: Iterable<PlayerId>;
  hostTimeouts?: { ballEndTimeoutMs?: number; logSignTimeoutMs?: number };
}

export interface DroppedInfo {
  from: PlayerId;
  type: MessageType;
  seq: number;
  reason: 'seq' | 'bad_signature' | 'stale_grant' | 'not_host' | 'unexpected' | 'bad_transfer';
}

export interface DesyncInfo {
  context: 'grant.logHash' | 'result.logHash' | 'reconnect.entries';
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
  ready: PayloadOf<'MATCH_READY'>;
  grant: GrantBody;
  myTurn: GrantBody;
  ballEnd: Message<'BALL_END'>;
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
  peerLeft: PlayerId;
  /** RECONNECT accepted by `host`; `entries` were appended to the log (A2/A3). */
  reconnected: { host: PlayerId; entries: number };
  /** RECONNECT rejected: re-join with a fresh HELLO, which after MATCH_READY is refused. */
  reconnectRejected: { host: PlayerId; code: ReconnectCode | null };
  /** The socket to `host` could not be opened. */
  reconnectFailed: { host: PlayerId; error: Error };
}

const HOST_ONLY_TYPES: ReadonlySet<MessageType> = new Set(['TURN_GRANT', 'RESULT', 'PAUSE', 'RESUME', 'FORFEIT', 'REJECT']);

export class ClientMatch {
  readonly events = new Emitter<ClientEvents>();
  private readonly s: Session;
  private readonly participant: ParticipantInfo;
  private readonly game: GameFingerprint;
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
  private signed = false;
  private hostLost = false;
  private transferAccepts = new Set<PlayerId>();
  private readonly gone = new Set<PlayerId>();
  /** The RECONNECT in flight: who must answer, and whether to close our listener on accept (old host). */
  private awaitingReconnect: { host: PlayerId; closeListener: boolean } | null = null;
  /** RECONNECTs that reached this client as the pending new host, answered at its commit (A2). */
  private readonly heldReconnects: { linkFrom: PlayerId; msg: Message<'RECONNECT'> }[] = [];
  private detached = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(opts: ClientOptions, session?: Session) {
    this.s = session ?? new Session({ transport: opts.transport, keys: opts.keys, clock: opts.clock });
    if (opts.participant.playerId !== this.s.localId) throw new Error('participant.playerId must equal transport.localId');
    this.participant = { ...opts.participant, publicKey: this.s.keys.publicKeyB64 };
    this.game = { ...opts.game };
    this.throwdownCode = opts.throwdownCode;
    this.companionVersion = opts.companionVersion ?? '0.1.0';
    this.explicitHostId = opts.hostId ?? null;
    this.hostTimeouts = opts.hostTimeouts ?? {};
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
      },
      session,
    );
    client.joined = true;
    for (const id of opts.gone ?? []) client.gone.add(id);
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

  snapshot(): { role: 'client'; state: MatchState; log: LogHead; inputUnlocked: boolean; myGrant: GrantBody | null; hostId: PlayerId | null; signed: boolean } {
    return {
      role: 'client',
      state: cloneState(this.s.state),
      log: this.s.log.head(),
      inputUnlocked: this._inputUnlocked,
      myGrant: this._myGrant,
      hostId: this.hostId,
      signed: this.signed,
    };
  }

  join(): void {
    this.assertActive();
    if (this.joined) throw new Error('already joined');
    const msg = this.s.build(
      'HELLO',
      { protocolVersion: PROTOCOL_VERSION, companionVersion: this.companionVersion, throwdownCode: this.throwdownCode, participant: this.participant, game: this.game },
      null,
    );
    this.s.transport.send(this.explicitHostId ?? 'all', msg);
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
    }
    this.sendToHost(msg);
    return msg;
  }

  reportState(state: Omit<PayloadOf<'STATE'>, 'extraBalls'> & { extraBalls?: number }): void {
    this.assertActive();
    this.sendToHost(this.s.build('STATE', state, this.matchIdForWire()));
  }

  reportDmd(frame: PayloadOf<'DMD_FRAME'>): void {
    this.assertActive();
    this.sendToHost(this.s.build('DMD_FRAME', frame, this.matchIdForWire()));
  }

  reportGameOver(finalScore: number, ballsPlayed: number): void {
    this.assertActive();
    this._inputUnlocked = false;
    this._myGrant = null;
    this.sendToHost(this.s.build('GAME_OVER', { finalScore, ballsPlayed }, this.matchIdForWire()));
  }

  forfeit(reason: string): void {
    this.assertActive();
    this.sendToHost(this.s.build('FORFEIT', { player: this.localId, reason }, this.matchIdForWire()));
  }

  pause(reason: PayloadOf<'PAUSE'>['reason'] = 'requested'): void {
    this.assertActive();
    this.sendToHost(this.s.build('PAUSE', { reason, player: this.localId }, this.matchIdForWire()));
  }

  resume(): void {
    this.assertActive();
    this.sendToHost(this.s.build('RESUME', {}, this.matchIdForWire()));
  }

  close(): void {
    this.detach();
  }

  /**
   * Open a new socket to `host` (at `endpoint`, or where it was last reached) and resume with
   * RECONNECT from this log's head, never a fresh HELLO (A2/A3, 2026-10-30). A no-op on a transport
   * without per-host links. `replacing`: links to that peer no longer count as a connection (the
   * old host after a transfer). `closeListenerOnAccept`: the old host closes its listener once the
   * new host accepted it.
   */
  relinkTo(host: PlayerId, opts: { endpoint?: string; replacing?: PlayerId; closeListenerOnAccept?: boolean } = {}): void {
    const t = this.s.transport;
    if (!t.connectTo || this.detached) return;
    this.awaitingReconnect = { host, closeListener: opts.closeListenerOnAccept ?? false };
    t.connectTo(host, () => this.buildReconnect(), { endpoint: opts.endpoint, replacing: opts.replacing }).catch((e: unknown) => {
      if (this.awaitingReconnect?.host === host) this.awaitingReconnect = null;
      this.events.emit('reconnectFailed', { host, error: e instanceof Error ? e : new Error(String(e)) });
    });
  }

  private buildReconnect(): Message<'RECONNECT'> {
    const head = this.s.log.head();
    const matchId = this.matchIdForWire();
    const signature = signCanonical(reconnectSignBody(matchId, this.localId, head.hash, head.length), this.s.keys.privateKey);
    return this.s.build('RECONNECT', { player: this.localId, logHash: head.hash, logLength: head.length, signature }, matchId);
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
  }

  private assertActive(): void {
    if (this.detached) throw new Error('this ClientMatch has become host or been closed');
  }

  private matchIdForWire(): string {
    return this.s.state.matchId ?? this.throwdownCode;
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
    switch (msg.type) {
      case 'MATCH_READY':
        if (msg.from !== this.hostId) return this.drop(msg, 'not_host');
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.events.emit('ready', msg.payload);
        return;
      case 'TURN_GRANT':
        this.onGrant(msg);
        return;
      case 'BALL_END':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        if (msg.from === this.localId) {
          this._myGrant = null;
          this._inputUnlocked = false;
        }
        this.events.emit('ballEnd', msg);
        this.maybeSignLog();
        return;
      case 'GAME_OVER':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.events.emit('gameOver', msg);
        this.maybeSignLog();
        return;
      case 'FORFEIT':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
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
      case 'REJECT':
        this.events.emit('reject', msg.payload);
        return;
      case 'RESULT':
        this.onResult(msg);
        return;
      default:
        this.drop(msg, 'unexpected');
    }
  }

  private onGrant(msg: Message<'TURN_GRANT'>): void {
    const { grant, grantSig } = msg.payload;
    const key = this.hostPublicKey;
    if (!key || msg.from !== this.hostId) return this.drop(msg, 'not_host');
    if (!verifyCanonical(grant, grantSig, key)) return this.drop(msg, 'bad_signature');
    if (grant.grantSeq <= this.lastGrantSeqSeen) return this.drop(msg, 'stale_grant');
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

  private maybeSignLog(): void {
    const st = this.s.state;
    if (this.signed || st.phase !== 'ended' || !st.matchId) return;
    this.signed = true;
    const head = this.s.log.head();
    const payload: PayloadOf<'LOG_SIGN'> = {
      logHash: head.hash,
      logLength: head.length,
      signature: signCanonical(logSignBody(st.matchId, head.hash, head.length), this.s.keys.privateKey),
    };
    this.sendToHost(this.s.build('LOG_SIGN', payload, st.matchId));
    this.events.emit('logSigned', payload);
  }

  private onResult(msg: Message<'RESULT'>): void {
    const r = msg.payload;
    const key = this.hostPublicKey;
    const head = this.s.log.head();
    const logMatches = r.logHash === head.hash && r.logLength === head.length;
    const signatureValid = key !== null && verifyCanonical(logSignBody(r.matchId, r.logHash, r.logLength), r.hostSignature, key);
    if (!logMatches) this.events.emit('desync', { context: 'result.logHash', expected: r.logHash, actual: head.hash });
    this.events.emit('result', { result: r, logMatches, signatureValid });
  }

  // ------------------------------------------------------------------------------------------
  // Host transfer
  // ------------------------------------------------------------------------------------------

  private onPeerLeave(peer: PlayerId): void {
    if (this.detached) return;
    this.events.emit('peerLeft', peer);
    if (peer === this.hostId && this.s.state.phase === 'running' && !this.s.state.pendingTransfer && !this.hostLost) {
      this.hostLost = true;
      this.events.emit('hostLost', peer);
      this.proposeIfCandidate();
      return;
    }
    this.gone.add(peer);
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
    const want = this.awaitingReconnect;
    if (!want || linkFrom !== want.host || msg.from !== want.host) return this.drop(msg, 'unexpected');
    this.awaitingReconnect = null;
    const p = msg.payload;
    if (!p.accept) {
      this.events.emit('reconnectRejected', { host: want.host, code: p.code });
      return;
    }
    const appended = this.mergeEntries(p.entries);
    const head = this.s.log.head();
    if (appended === null || head.hash !== p.logHash) {
      this.events.emit('desync', { context: 'reconnect.entries', expected: p.logHash, actual: head.hash });
    }
    if (want.closeListener) this.s.transport.closeListener?.();
    this.events.emit('reconnected', { host: want.host, entries: appended ?? 0 });
    this.maybeSignLog();
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
    switch (msg.type) {
      case 'MATCH_READY':
        this.events.emit('ready', msg.payload);
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
      ...this.hostTimeouts,
    });
    this.events.emit('hostChanged', { from: done.oldHost, to: done.newHost });
    this.events.emit('becameHost', host);
    // Answer the held RECONNECTs first, so those clients get the commit event before the re-issued grant.
    for (const h of this.heldReconnects.splice(0)) host.handle(h.linkFrom, h.msg, { seqChecked: true });
    host.run();
  }
}
