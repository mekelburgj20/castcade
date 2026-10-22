/**
 * Follow a Castcade journal file as the in-VPX hook appends to it, delivering complete lines.
 * The hook writes `%LOCALAPPDATA%\Castcade\journal\<table-id>.jsonl` with buffered appends
 * (events flush at once, `nvram_delta` every 50 lines), so a read can land mid-line: the partial
 * tail is kept until its newline arrives. The file may not exist yet when the tail starts (the
 * sidecar creates it at table load), may be appended to by a later session, or may be replaced
 * by a shorter file (the player cleared the folder): a size below the consumed position restarts
 * from byte 0.
 *
 * Polling through `WitnessFs` and `Clock` rather than `fs.watch`, so the tail runs under vitest on
 * `MemoryFs` + `ManualClock`, and because Windows change notifications for a file another process
 * holds open with a write handle are unreliable. 250 ms matches the Python spike tailer.
 */
import { realClock, type Clock, type TimerHandle } from '../match/clock.js';
import { Emitter } from '../match/events.js';
import { isNotFound, nodeFs, type WitnessFs } from './fs.js';

export const DEFAULT_TAIL_POLL_MS = 250;

/**
 * The hook's journal file name for a table id (`Castcade_SafeName` in `vpx-hook/castcade.vbs`): ASCII letters,
 * digits, `.`, `_`, `-` kept, a space becomes `_`, anything else is dropped, an empty result is `table`.
 */
export function journalFileName(tableId: string): string {
  let r = '';
  for (const c of tableId) {
    if (/[A-Za-z0-9._-]/.test(c)) r += c;
    else if (c === ' ') r += '_';
  }
  return (r === '' ? 'table' : r) + '.jsonl';
}

/** `%LOCALAPPDATA%\Castcade\journal`, where the hook writes; `localAppData` comes from the environment. */
export function journalDir(localAppData: string): string {
  const sep = localAppData.includes('\\') && !localAppData.includes('/') ? '\\' : '/';
  return localAppData.replace(/[\\/]+$/, '') + sep + 'Castcade' + sep + 'journal';
}

export function journalPathFor(localAppData: string, tableId: string): string {
  const dir = journalDir(localAppData);
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir + sep + journalFileName(tableId);
}

export interface JournalTailEvents extends Record<string, unknown> {
  /** One complete line, newline (and a preceding CR) stripped. Blank lines are delivered too. */
  line: string;
  /** The file shrank below the consumed position (or vanished); reading restarted from the top. */
  truncated: { from: number; size: number };
  error: Error;
}

export interface JournalTailOptions {
  fs?: WitnessFs;
  clock?: Clock;
  pollMs?: number;
  /**
   * Where to begin: `'end'` (default) skips whatever the file already holds, which is the earlier
   * sessions of this table; `'start'` replays the file from byte 0 first. A file that does not
   * exist yet is read from its first byte either way.
   */
  from?: 'start' | 'end';
}

export class JournalTail {
  private readonly fs: WitnessFs;
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly from: 'start' | 'end';
  private readonly emitter = new Emitter<JournalTailEvents>();
  /** File position of the first byte of `partial`; everything before it was delivered as lines. */
  private offset: number | null = null;
  private partial: Uint8Array = new Uint8Array(0);
  private timer: TimerHandle | null = null;
  private running = false;
  private polling: Promise<void> | null = null;

  constructor(
    readonly path: string,
    opts: JournalTailOptions = {},
  ) {
    this.fs = opts.fs ?? nodeFs;
    this.clock = opts.clock ?? realClock;
    this.pollMs = opts.pollMs ?? DEFAULT_TAIL_POLL_MS;
    this.from = opts.from ?? 'end';
  }

  on<K extends keyof JournalTailEvents>(name: K, cb: (payload: JournalTailEvents[K]) => void): () => void {
    return this.emitter.on(name, cb);
  }

  /** Bytes consumed so far (complete lines plus the partial tail), or null before the first poll. */
  get position(): number | null {
    return this.offset === null ? null : this.offset + this.partial.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Read whatever is new right now (what each poll tick does). Safe to call while running. */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.readNew().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.poll().then(() => this.schedule(this.pollMs));
    }, ms);
  }

  private async readNew(): Promise<void> {
    let size: number;
    try {
      size = (await this.fs.stat(this.path)).size;
    } catch (err) {
      if (isNotFound(err)) {
        // Not created yet, or gone: whatever appears next is new from its first byte.
        const consumed = this.position ?? 0;
        if (consumed > 0) this.emitter.emit('truncated', { from: consumed, size: 0 });
        this.offset = 0;
        this.partial = new Uint8Array(0);
        return;
      }
      this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.offset === null) {
      this.offset = this.from === 'end' ? size : 0;
      if (this.from === 'end') return;
    }
    let start = this.offset + this.partial.length;
    if (size < start) {
      this.emitter.emit('truncated', { from: start, size });
      this.offset = 0;
      this.partial = new Uint8Array(0);
      start = 0;
    }
    if (size <= start) return;
    let chunk: Uint8Array;
    try {
      const file = await this.fs.open(this.path);
      try {
        chunk = await file.read(start, size - start);
      } finally {
        await file.close();
      }
    } catch (err) {
      if (isNotFound(err)) return;
      this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.consume(chunk);
  }

  private consume(chunk: Uint8Array): void {
    // `buf` starts at file position `offset`: the kept partial tail followed by the new bytes.
    let buf: Uint8Array;
    if (this.partial.length > 0) {
      buf = new Uint8Array(this.partial.length + chunk.length);
      buf.set(this.partial, 0);
      buf.set(chunk, this.partial.length);
    } else {
      buf = chunk;
    }
    const decoder = new TextDecoder('utf-8');
    let lineStart = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue;
      const end = i > lineStart && buf[i - 1] === 0x0d ? i - 1 : i;
      const line = decoder.decode(buf.subarray(lineStart, end));
      lineStart = i + 1;
      this.emitter.emit('line', line);
    }
    this.offset = (this.offset ?? 0) + lineStart;
    this.partial = buf.subarray(lineStart).slice();
  }
}
