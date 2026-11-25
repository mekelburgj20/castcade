/**
 * What a participant carries across roles: the transport, its keys, its clock, the log, the
 * state folded from the log, the outgoing `seq` counter and the last accepted `seq` per sender.
 * A HostMatch that hands over becomes a ClientMatch on the same Session, and a ClientMatch that
 * wins a transfer becomes a HostMatch on it, so counters and the log never reset mid-match.
 */
import { buildMessage, type Message, type MessageType, type PayloadInput, type PlayerId } from '@castcade/protocol';
import { realClock, type Clock } from './clock.js';
import type { KeyPair } from './keys.js';
import { MatchLog, type LogEntry, type LogEntryInput } from './log.js';
import { applyEntry, initialState, replayLog, type MatchState } from './state.js';
import type { Transport } from './transport.js';

export interface SessionOptions {
  transport: Transport;
  keys: KeyPair;
  clock?: Clock;
  log?: MatchLog;
  /**
   * A15: the outgoing `seq` continues after this number. A participant that restarted in the middle of a match has
   * lost its counter, and the others drop a frame whose `seq` is not above the last they took from it; it starts
   * from a number no earlier run can have reached (the shell passes the wall clock in ms).
   */
  seqStart?: number;
}

export class Session {
  readonly transport: Transport;
  readonly keys: KeyPair;
  readonly clock: Clock;
  /**
   * The log of the match this session is in. One for the session's life, except in a lobby (A17, 2026-11-25), where
   * each match has a log of its own from its first entry: `newMatch()` puts this one away and starts the next.
   */
  log: MatchLog;
  state: MatchState;
  /**
   * A15: called inside `commit`, after the entry is in the log and folded into the state, before the caller sends
   * anything: the shell saves the log here, so what is on disk is never behind what another participant was sent.
   */
  onCommit: ((entry: LogEntry) => void) | null = null;
  private seq = 0;
  private readonly lastSeq = new Map<PlayerId, number>();

  constructor(opts: SessionOptions) {
    this.transport = opts.transport;
    this.keys = opts.keys;
    this.clock = opts.clock ?? realClock;
    this.log = opts.log ?? new MatchLog();
    this.state = this.log.length > 0 ? replayLog(this.log) : initialState();
    if (opts.seqStart !== undefined && Number.isSafeInteger(opts.seqStart) && opts.seqStart > 0) this.seq = opts.seqStart;
  }

  get localId(): PlayerId {
    return this.transport.localId;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /**
   * A17 step 6: the outgoing `seq` continues above `floor` (never below where it is). For a member a lobby told
   * that its counter fell behind (`RECONNECT_ACK.seqAbove`): the counter only ever moves forward.
   */
  raiseSeq(floor: number): void {
    if (Number.isSafeInteger(floor) && floor > this.seq) this.seq = floor;
  }

  /** Per-sender strictly increasing `seq`. Records the seq when it is acceptable. */
  checkSeq(from: PlayerId, seq: number): boolean {
    const last = this.lastSeq.get(from);
    if (last !== undefined && seq <= last) return false;
    this.lastSeq.set(from, seq);
    return true;
  }

  /** Forget the last seq from `from`: a HELLO opens a new connection with a fresh counter (A3). */
  resetSeq(from: PlayerId): void {
    this.lastSeq.delete(from);
  }

  /** 2026-11-25: the last `seq` taken from `from`, or null when none was. Reads only. */
  lastSeqFrom(from: PlayerId): number | null {
    return this.lastSeq.get(from) ?? null;
  }

  /**
   * 2026-11-25: record a `seq` that was judged against the count as it stood earlier (an opening frame that was
   * held before it was read). The count moves up to it and never down.
   */
  noteSeq(from: PlayerId, seq: number): void {
    const last = this.lastSeq.get(from);
    if (last === undefined || seq > last) this.lastSeq.set(from, seq);
  }

  build<T extends MessageType>(type: T, payload: PayloadInput<T>, matchId: string | null): Message<T> {
    return buildMessage(type, payload, { matchId, seq: this.nextSeq(), from: this.localId, ts: this.clock.now() });
  }

  /** Append to the log and fold into state. The only way state changes. */
  commit(input: LogEntryInput): LogEntry {
    const entry = this.log.append(input);
    applyEntry(this.state, entry);
    this.onCommit?.(entry);
    return entry;
  }

  /**
   * A17 (2026-11-25): a match of a lobby is over, or another one begins: the log is put away as it stands (returned;
   * nothing is appended to it any more) and the session holds an empty one, with the state of a lobby in which no
   * match is open. Nothing chains one match's log to the next: index 0, `prevHash` 64 zeros. What does NOT start
   * over is the outgoing `seq` and the last `seq` taken from each sender: they are the connection's, and the lobby's
   * connections outlive its matches.
   */
  newMatch(): MatchLog {
    const done = this.log;
    this.log = new MatchLog();
    this.state = initialState();
    return done;
  }

  /** Rebuild state from the log (used by resumeFromLog to prove the log is sufficient). */
  replay(): void {
    this.state = replayLog(this.log);
  }
}
