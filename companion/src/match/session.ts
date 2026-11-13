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
  readonly log: MatchLog;
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

  /** Rebuild state from the log (used by resumeFromLog to prove the log is sufficient). */
  replay(): void {
    this.state = replayLog(this.log);
  }
}
