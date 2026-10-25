/**
 * Offline queue for ArcAid posts. A post is tried at once; when ArcAid is unreachable or answers
 * 5xx it is kept as a JSON line in `<dataDir>/witness-queue.jsonl` and retried with exponential
 * backoff (5 s doubling to 10 min) until a final answer arrives (2xx or 4xx). The file survives a
 * restart; `load()` picks the items up again.
 *
 * A report or score delivered late is still the same GET with the same timestamps: the device
 * watched the session live, it only could not reach the server at the time. `via=retro` is NOT
 * set here; that tag is for sessions reconstructed from disk that the device never watched, which
 * basic mode never produces (ADR 0021).
 */
import { ArcaidError, type ArcaidClient, type AttemptParams, type AttemptWireAnswer, type ScoreWireStatus } from './arcaid-client.js';
import { realClock, type Clock, type TimerHandle } from '../match/clock.js';
import { isNotFound, nodeFs, type WitnessFs } from './fs.js';

export type QueuedPost =
  | {
      id: string;
      kind: 'report';
      createdAt: number;
      attempts: number;
      /** `exit`/`dur` absent = a launch report (opens the session; the exit report closes it). */
      params: { device: string; table: string; launch: number; exit?: number | null; dur?: number | null };
    }
  | {
      id: string;
      kind: 'score';
      createdAt: number;
      attempts: number;
      params: {
        device: string;
        table: string;
        rom: string | null;
        slug?: string | null;
        score: number;
        started: number;
        ended: number;
        dur: number;
        reason: string;
        restarts?: number;
        partial?: boolean;
        vps_game?: string | null;
        vps_table?: string | null;
        table_sha256?: string | null;
        fingerprint?: string | null;
        table_save_rev?: number | null;
        ini?: string | null;
        adjustments?: string | null;
        build?: string | null;
        play_device?: 'pc' | 'vr_headset';
        attempt?: string | null;
        engine?: string | null;
      };
    }
  | {
      id: string;
      kind: 'attempt';
      createdAt: number;
      attempts: number;
      /** A game start (ADR 0029); idempotent on `(device, key)` so a replay after an outage is safe. */
      params: AttemptParams;
    };

export type PostInput =
  | { kind: 'report'; params: Extract<QueuedPost, { kind: 'report' }>['params'] }
  | { kind: 'score'; params: Extract<QueuedPost, { kind: 'score' }>['params'] }
  | { kind: 'attempt'; params: AttemptParams };

export type PostResult =
  | { state: 'done'; wire: ScoreWireStatus | null; attempt?: AttemptWireAnswer | null }
  | { state: 'queued'; error: ArcaidError }
  | { state: 'rejected'; error: ArcaidError };

export interface PostQueueOptions {
  dataDir: string;
  /** Resolved on every attempt so a changed base URL applies to queued items. */
  client: () => ArcaidClient;
  /** The current token; read on every attempt so a re-pair applies to queued items. */
  token: () => string | null;
  fs?: WitnessFs;
  clock?: Clock;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called with the final result of an item that was queued earlier (not for first-try results). */
  onSettled?: (post: QueuedPost, result: PostResult) => void;
  onError?: (message: string) => void;
}

export const QUEUE_FILE = 'witness-queue.jsonl';
export const DEFAULT_BASE_DELAY_MS = 5_000;
export const DEFAULT_MAX_DELAY_MS = 10 * 60_000;

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

function isQueuedPost(v: unknown): v is QueuedPost {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['id'] === 'string' && (o['kind'] === 'report' || o['kind'] === 'score' || o['kind'] === 'attempt') && typeof o['params'] === 'object' && o['params'] !== null;
}

export class PostQueue {
  private readonly items: QueuedPost[] = [];
  private readonly file: string;
  private readonly fs: WitnessFs;
  private readonly clock: Clock;
  private readonly client: () => ArcaidClient;
  private readonly token: () => string | null;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly onSettled: ((post: QueuedPost, result: PostResult) => void) | null;
  private readonly onError: ((message: string) => void) | null;
  private timer: TimerHandle | null = null;
  private flushing: Promise<void> | null = null;
  private nextId = 1;
  private stopped = false;

  constructor(private readonly opts: PostQueueOptions) {
    this.fs = opts.fs ?? nodeFs;
    this.clock = opts.clock ?? realClock;
    this.client = opts.client;
    this.token = opts.token;
    this.file = joinPath(opts.dataDir, QUEUE_FILE);
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.onSettled = opts.onSettled ?? null;
    this.onError = opts.onError ?? null;
  }

  size(): number {
    return this.items.length;
  }

  pending(): readonly QueuedPost[] {
    return this.items;
  }

  /** Read the persisted queue (call once at start). Missing file = empty queue. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = new TextDecoder().decode(await this.fs.readFile(this.file));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isQueuedPost(parsed)) {
          this.items.push({ ...parsed, attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0 });
        }
      } catch {
        // A torn line from a crash mid-write: drop it, the rest is intact.
      }
    }
    if (this.items.length > 0) this.scheduleRetry(0);
  }

  /** Stop retry timers (the file keeps the items). */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  resume(): void {
    this.stopped = false;
    if (this.items.length > 0) this.scheduleRetry(0);
  }

  /**
   * Try to deliver now. Retryable failures keep the post and return `queued`; a 4xx returns
   * `rejected`; a 2xx returns `done` with the wire status (scores only).
   */
  async submit(input: PostInput): Promise<PostResult> {
    const post = { ...input, id: `${this.clock.now()}-${this.nextId++}`, createdAt: this.clock.now(), attempts: 0 } as QueuedPost;
    const result = await this.attempt(post);
    if (result.state === 'queued') {
      this.items.push(post);
      await this.persist();
      this.scheduleRetry(post.attempts);
    }
    return result;
  }

  /** Retry every pending item in order; stops at the first retryable failure to keep order. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    while (this.items.length > 0) {
      const post = this.items[0];
      if (!post) break;
      const result = await this.attempt(post);
      if (result.state === 'queued') {
        await this.persist();
        this.scheduleRetry(post.attempts);
        return;
      }
      this.items.shift();
      await this.persist();
      this.onSettled?.(post, result);
    }
  }

  private async attempt(post: QueuedPost): Promise<PostResult> {
    const token = this.token();
    post.attempts++;
    if (!token) {
      return { state: 'rejected', error: new ArcaidError('auth', 'not paired') };
    }
    try {
      const client = this.client();
      if (post.kind === 'report') {
        await client.report(token, post.params);
        return { state: 'done', wire: null };
      }
      if (post.kind === 'attempt') {
        const attempt = await client.attempt(token, post.params);
        return { state: 'done', wire: null, attempt };
      }
      const wire = await client.score(token, post.params);
      return { state: 'done', wire };
    } catch (err) {
      const error = err instanceof ArcaidError ? err : new ArcaidError('network', err instanceof Error ? err.message : String(err));
      return error.retryable ? { state: 'queued', error } : { state: 'rejected', error };
    }
  }

  /** Backoff for the next retry after `attempts` failed tries. */
  delayFor(attempts: number): number {
    return Math.min(this.baseDelayMs * 2 ** Math.max(0, attempts - 1), this.maxDelayMs);
  }

  private scheduleRetry(attempts: number): void {
    if (this.stopped || this.timer !== null || this.items.length === 0) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayFor(attempts));
  }

  private async persist(): Promise<void> {
    try {
      await this.fs.mkdir(this.opts.dataDir);
      if (this.items.length === 0) {
        try {
          await this.fs.unlink(this.file);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
        return;
      }
      const text = this.items.map((i) => JSON.stringify(i)).join('\n') + '\n';
      const tmp = this.file + '.tmp';
      await this.fs.writeFile(tmp, text);
      await this.fs.rename(tmp, this.file);
    } catch (err) {
      this.onError?.(`queue: could not persist ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
