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
  /**
   * A17 step 8 (2026-11-26): the numbers this participant must never fall behind across a restart of its process,
   * for the one participant that keeps them: a lobby's PC (`SeqGuard`). Without it nothing here changes.
   */
  seqGuard?: SeqGuard;
}

/**
 * A17 step 8 (2026-11-26, alpha-match.md section 11.7: "a lobby's PC that restarted has lost the counters"). What a
 * lobby's PC holds so that a restart loses none of them.
 *
 * The property: **after a restart, a frame is taken from a sender only when its number is above every number this
 * PC could have taken from that sender before the restart, and this PC's own frames are numbered above every number
 * it could have used before.** So nothing it took before a restart is taken again after it, and no count runs
 * backwards.
 *
 * How: beside each count a ceiling is kept in the saved lobby. Before a number above the ceiling is taken (or
 * used), a new ceiling `step` further is handed to `save`, which writes it before it returns; only then does the
 * frame count. After a restart the counts start at the saved ceilings (`taken`, `sent`). A sender whose own count
 * is below its ceiling then is told where the lobby stands and goes on above it (`RECONNECT_ACK.seqAbove`), once.
 * A write for one number in `step`, not for every frame.
 */
export interface SeqGuard {
  /** How far ahead a ceiling is written. Default 1024. */
  step?: number;
  /** The ceilings as last saved: the last number that may have been taken from each sender, and that may have been used by this PC. */
  taken?: Readonly<Record<PlayerId, number>>;
  sent?: number;
  /**
   * Called, synchronously, before a number above a saved ceiling counts: write `now` where the lobby is saved.
   * False: it was not written (nothing is saved yet, or the write failed): the ceiling stays where it was, and the
   * next number asks again.
   */
  save: (now: SeqCeilings) => boolean | void;
}

export interface SeqCeilings {
  taken: Record<PlayerId, number>;
  sent: number;
}

const DEFAULT_SEQ_STEP = 1024;

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
  /** A17 step 8: `SessionOptions.seqGuard`, and the ceilings as they were last handed to it. */
  private readonly guard: SeqGuard | null;
  private readonly step: number;
  private readonly takenCeil = new Map<PlayerId, number>();
  private sentCeil = 0;

  constructor(opts: SessionOptions) {
    this.transport = opts.transport;
    this.keys = opts.keys;
    this.clock = opts.clock ?? realClock;
    this.log = opts.log ?? new MatchLog();
    this.state = this.log.length > 0 ? replayLog(this.log) : initialState();
    if (opts.seqStart !== undefined && Number.isSafeInteger(opts.seqStart) && opts.seqStart > 0) this.seq = opts.seqStart;
    this.guard = opts.seqGuard ?? null;
    this.step = Math.max(1, Math.floor(opts.seqGuard?.step ?? DEFAULT_SEQ_STEP));
    if (this.guard) {
      // A restart: every count begins at its saved ceiling, never below it.
      for (const [id, n] of Object.entries(this.guard.taken ?? {})) {
        if (!Number.isSafeInteger(n) || n < 0) continue;
        this.lastSeq.set(id, n);
        this.takenCeil.set(id, n);
      }
      const sent = this.guard.sent ?? 0;
      if (Number.isSafeInteger(sent) && sent > this.seq) this.seq = sent;
      this.sentCeil = Math.max(0, Number.isSafeInteger(sent) ? sent : 0);
    }
  }

  /** A17 step 8: the ceilings as they stand (what `SeqGuard.save` was last given, or the restored ones). */
  seqCeilings(): SeqCeilings {
    return { taken: Object.fromEntries(this.takenCeil), sent: this.sentCeil };
  }

  /** A17 step 8: a number from `from` is about to count: when it is above the saved ceiling, a new ceiling is saved first. */
  private reserveTaken(from: PlayerId, seq: number): void {
    const was = this.takenCeil.get(from);
    if (!this.guard || seq <= (was ?? -1)) return;
    this.takenCeil.set(from, seq + this.step);
    if (this.guard.save(this.seqCeilings()) !== false) return;
    if (was === undefined) this.takenCeil.delete(from);
    else this.takenCeil.set(from, was);
  }

  /** A17 step 8: a sender this PC holds no row for any more: its ceiling is no longer kept (a later frame of that name is a newcomer's). */
  dropCeiling(from: PlayerId): void {
    this.takenCeil.delete(from);
  }

  get localId(): PlayerId {
    return this.transport.localId;
  }

  nextSeq(): number {
    this.seq += 1;
    if (this.guard && this.seq > this.sentCeil) {
      const was = this.sentCeil;
      this.sentCeil = this.seq + this.step;
      if (this.guard.save(this.seqCeilings()) === false) this.sentCeil = was;
    }
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
    this.reserveTaken(from, seq);
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
    if (last === undefined || seq > last) {
      this.reserveTaken(from, seq);
      this.lastSeq.set(from, seq);
    }
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
