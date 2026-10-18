/**
 * The append-only match log. Every participant (host and clients) appends exactly the same
 * entries in the same order: the accepted messages the host broadcasts, the grants it issues,
 * and the one derived event (an accepted host transfer). Entry hashes chain through
 * `prevHash`, so equal heads mean equal histories. `ts` is always taken from the message that
 * caused the entry, never from a local clock, so hashes agree across machines.
 */
import { canonicalJson, type AnyMessage, type PlayerId } from '@castcade/protocol';
import { sha256Hex } from './keys.js';

export type LogEntryKind = 'msg' | 'grant' | 'event';

export interface HostTransferEvent {
  type: 'host_transfer';
  reason: 'host_left' | 'host_requested';
  proposer: PlayerId;
  /** The host before the transfer. */
  from: PlayerId;
  /** The host after the transfer. */
  to: PlayerId;
  newHostPublicKey: string;
}

export type LogEvent = HostTransferEvent;

export interface LogEntryInput {
  ts: number;
  kind: LogEntryKind;
  from: PlayerId;
  message?: AnyMessage;
  event?: LogEvent;
}

export interface LogEntryBody extends LogEntryInput {
  index: number;
  prevHash: string;
}

export interface LogEntry extends LogEntryBody {
  hash: string;
}

export interface LogHead {
  hash: string;
  length: number;
}

export const GENESIS_HASH = '0'.repeat(64);

export function hashEntry(body: LogEntryBody): string {
  return sha256Hex(canonicalJson(body));
}

export class MatchLog {
  private readonly list: LogEntry[] = [];

  head(): LogHead {
    const last = this.list[this.list.length - 1];
    return { hash: last ? last.hash : GENESIS_HASH, length: this.list.length };
  }

  entries(): readonly LogEntry[] {
    return this.list;
  }

  at(index: number): LogEntry | undefined {
    return this.list[index];
  }

  get length(): number {
    return this.list.length;
  }

  append(input: LogEntryInput): LogEntry {
    const body: LogEntryBody = {
      index: this.list.length,
      prevHash: this.head().hash,
      ts: input.ts,
      kind: input.kind,
      from: input.from,
    };
    if (input.message !== undefined) body.message = input.message;
    if (input.event !== undefined) body.event = input.event;
    const entry: LogEntry = { ...body, hash: hashEntry(body) };
    this.list.push(entry);
    return entry;
  }

  /** Recompute every hash; returns the first bad index if the chain is broken. */
  verifyChain(): { ok: true } | { ok: false; badIndex: number } {
    let prev = GENESIS_HASH;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e) return { ok: false, badIndex: i };
      const { hash, ...body } = e;
      if (e.index !== i || e.prevHash !== prev || hashEntry(body) !== hash) return { ok: false, badIndex: i };
      prev = hash;
    }
    return { ok: true };
  }

  toJSON(): LogEntry[] {
    return this.list.map((e) => ({ ...e }));
  }

  static fromJSON(entries: readonly LogEntry[]): MatchLog {
    const log = new MatchLog();
    for (const e of entries) log.list.push({ ...e });
    const check = log.verifyChain();
    if (!check.ok) throw new Error(`log chain broken at entry ${check.badIndex}`);
    return log;
  }
}
