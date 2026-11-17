/**
 * C16.2 (hook 0.6.0): the main thread's side of the journal pipe. Starts the worker that drains the hooks' pipe into
 * the journal files (`journal-pipe-worker.ts` → `journal-pipe-server.ts`), logs what it reports, starts it again when it
 * dies, and answers the one question the rest of the companion has: "is everything the hook sent for this journal in
 * the file?" (`drain`), which the witness asks before it acts on a VPX exit. With a pipe, VPX can exit while its last
 * lines (the last ball, `table_exit`) are still on their way to the disk; with the file, a slow write held VPX instead.
 *
 * The pipe is an addition, never a requirement: when it cannot be had (its name is taken, the worker keeps dying), the
 * hooks find no pipe and write the journal file themselves, as before 0.6.0.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { JOURNAL_HEADER_PREFIX, JOURNAL_PIPE_NAME, type DrainResult, type JournalPipeCommand, type JournalPipeWorkerData, type JournalPipeWorkerMessage } from './journal-pipe-server.js';

export interface JournalPipeLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface JournalPipeOptions {
  /** `%LOCALAPPDATA%\Castcade\journal`, where the witness reads the journals. */
  journalDir: string;
  log: JournalPipeLog;
  /** Default `\\.\pipe\castcade-journal`, the name the hook opens. Tests and the smoke pass their own. */
  pipeName?: string;
  /** The worker's entry; default the built `journal-pipe-worker.js` beside this module. Tests run the TypeScript through tsx. */
  workerUrl?: URL;
  execArgv?: string[];
  /** Extra `workerData` for a test's own worker entry. */
  workerData?: Record<string, unknown>;
  restartDelayMs?: number;
  /** Deaths in a row (each within a minute of its start) before the pipe is given up for the run. */
  maxRestarts?: number;
  drainBoundMs?: number;
  /** Every message the worker posts, after it was handled (the smoke and the tests watch connections close). */
  onMessage?: (m: JournalPipeWorkerMessage) => void;
}

export type JournalPipeState = 'starting' | 'listening' | 'unavailable' | 'failed' | 'stopped';

export interface JournalPipe {
  readonly pipeName: string;
  state(): JournalPipeState;
  /** Resolves true once the worker listens; false when it cannot (or not within `timeoutMs`). */
  ready(timeoutMs?: number): Promise<boolean>;
  /**
   * Resolves once every line the worker has received for this journal file is written to it (true), or after `boundMs`
   * (false, logged). At once when the pipe is not running or the path is not in the journal folder.
   */
  drain(journalPath: string, boundMs?: number): Promise<boolean>;
  /** Stop listening, write what is queued (within `timeoutMs`), end the worker. A hook still connected then writes its file. */
  stop(timeoutMs?: number): Promise<void>;
}

/** How long the witness waits for a journal's last lines after VPX exited (a slow write on the owner's PC took 2.8 s). */
export const DEFAULT_DRAIN_BOUND_MS = 10_000;
const DEFAULT_RESTART_DELAY_MS = 1_000;
const DEFAULT_MAX_RESTARTS = 5;
/** A worker that listened this long before it died starts a new count of deaths. */
const STABLE_MS = 60_000;

const errText = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err));

/** The file name of `path` when it is in `dir` (case-insensitive on Windows), else null. */
export function journalNameIn(dir: string, path: string): string | null {
  const a = resolve(dirname(path));
  const b = resolve(dir);
  const same = process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  return same ? basename(path) : null;
}

export function startJournalPipe(opts: JournalPipeOptions): JournalPipe {
  const { log } = opts;
  const pipeName = opts.pipeName ?? JOURNAL_PIPE_NAME;
  const workerUrl = opts.workerUrl ?? new URL('./journal-pipe-worker.js', import.meta.url);
  const restartDelayMs = opts.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const drainBoundMs = opts.drainBoundMs ?? DEFAULT_DRAIN_BOUND_MS;

  let worker: Worker | null = null;
  let state: JournalPipeState = 'starting';
  let stopping = false;
  let deaths = 0;
  let listeningSince: number | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let readyWaiters: ((ok: boolean) => void)[] = [];
  let nextReq = 0;
  const pending = new Map<number, (m: DrainResult | null) => void>();
  let stoppedWaiter: (() => void) | null = null;

  const settleReady = (ok: boolean): void => {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const w of waiters) w(ok);
  };

  const onMessage = (w: Worker, m: JournalPipeWorkerMessage): void => {
    if (w !== worker) return;
    switch (m.type) {
      case 'listening':
        state = 'listening';
        listeningSince = Date.now();
        log.info(`journal pipe: listening on ${m.pipe} (journals in ${m.dir}); tables loaded from now on send their journal through it`);
        settleReady(true);
        break;
      case 'unavailable':
        state = 'unavailable';
        log.warn(`journal pipe: ${m.reason}; tables write their journal file themselves this run`);
        settleReady(false);
        worker = null;
        void w.terminate();
        break;
      case 'opened':
        log.info(`journal pipe: ${m.name}: connection ${m.id} opened`);
        break;
      case 'closed': {
        const extra = [m.dropped > 0 ? `${m.dropped} dropped (memory cap)` : '', m.partialBytes > 0 ? `an unfinished last line of ${m.partialBytes} bytes dropped` : ''].filter((s) => s !== '');
        log.info(`journal pipe: ${m.name}: connection ${m.id} closed, ${m.lines} lines written${extra.length > 0 ? `; ${extra.join('; ')}` : ''}`);
        break;
      }
      case 'refused':
        log.warn(`journal pipe: connection ${m.id} refused (the hook then writes the file itself): ${m.reason}`);
        break;
      case 'failure':
        log.error(`journal pipe: ${m.detail}`);
        break;
      case 'note':
        log.info(`journal pipe: ${m.detail}`);
        break;
      case 'drained': {
        const done = pending.get(m.req);
        pending.delete(m.req);
        done?.(m);
        break;
      }
      case 'stopped':
        stoppedWaiter?.();
        break;
    }
    opts.onMessage?.(m);
  };

  const onExit = (w: Worker, code: number): void => {
    if (w !== worker) return;
    worker = null;
    for (const done of pending.values()) done(null);
    pending.clear();
    if (stopping) {
      state = 'stopped';
      return;
    }
    if (listeningSince !== null && Date.now() - listeningSince >= STABLE_MS) deaths = 0;
    listeningSince = null;
    deaths++;
    if (deaths > maxRestarts) {
      state = 'failed';
      log.error(`journal pipe: the worker stopped ${deaths} times in a row; the pipe is off for this run and tables write their journal file themselves`);
      settleReady(false);
      return;
    }
    state = 'starting';
    log.error(`journal pipe: the worker stopped (exit code ${code}); starting it again in ${restartDelayMs} ms (tables that were sending through it write their file now)`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopping) spawn();
    }, restartDelayMs);
    restartTimer.unref();
  };

  const spawn = (): void => {
    state = 'starting';
    const workerData: JournalPipeWorkerData & Record<string, unknown> = { ...opts.workerData, pipeName, journalDir: opts.journalDir };
    let w: Worker;
    try {
      w = new Worker(workerUrl, { workerData, execArgv: opts.execArgv ?? [], name: 'castcade-journal-pipe' });
    } catch (err) {
      state = 'failed';
      log.error(`journal pipe: could not start the worker (${errText(err)}); tables write their journal file themselves this run`);
      settleReady(false);
      return;
    }
    worker = w;
    w.on('message', (m: JournalPipeWorkerMessage) => onMessage(w, m));
    w.on('error', (err) => {
      if (w === worker) log.error(`journal pipe: the worker failed: ${errText(err)}`);
    });
    w.on('exit', (code) => onExit(w, code));
  };

  spawn();

  return {
    pipeName,
    state: () => state,
    ready(timeoutMs = 5_000) {
      if (state === 'listening') return Promise.resolve(true);
      if (state !== 'starting') return Promise.resolve(false);
      return new Promise((done) => {
        const timer = setTimeout(() => done(false), timeoutMs);
        readyWaiters.push((ok) => {
          clearTimeout(timer);
          done(ok);
        });
      });
    },
    drain(journalPath, boundMs = drainBoundMs) {
      const w = worker;
      const name = journalNameIn(opts.journalDir, journalPath);
      if (state !== 'listening' || !w || name === null) return Promise.resolve(true);
      const req = ++nextReq;
      return new Promise((done) => {
        const timer = setTimeout(() => {
          pending.delete(req);
          log.warn(`journal pipe: ${name}: its last lines were still on their way to the file after ${boundMs} ms; the file is read as it is`);
          done(false);
        }, boundMs);
        pending.set(req, (m) => {
          clearTimeout(timer);
          if (m && m.waitedMs >= 100) log.info(`journal pipe: ${name}: waited ${m.waitedMs} ms for its last lines to reach the file`);
          done(m !== null);
        });
        w.postMessage({ type: 'drain', req, name } satisfies JournalPipeCommand);
      });
    },
    async stop(timeoutMs = 3_000) {
      if (stopping) return;
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      settleReady(false);
      const w = worker;
      if (!w) {
        state = state === 'starting' || state === 'listening' ? 'stopped' : state;
        return;
      }
      await new Promise<void>((done) => {
        const timer = setTimeout(done, timeoutMs + 1_000);
        stoppedWaiter = () => {
          clearTimeout(timer);
          done();
        };
        w.postMessage({ type: 'stop', timeoutMs } satisfies JournalPipeCommand);
      });
      stoppedWaiter = null;
      await w.terminate();
      state = 'stopped';
    },
  };
}

/**
 * `--smoke` (C16.2): the worker starts in this build (inside the asar when packaged), listens on a pipe of its own and
 * writes one line it is sent into a journal file in a temporary folder; never the hooks' pipe or the player's journals.
 */
export async function smokeJournalPipe(opts: Pick<JournalPipeOptions, 'workerUrl' | 'execArgv'> = {}): Promise<{ ok: boolean; detail: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'castcade-pipe-smoke-'));
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\castcade-journal-smoke-${process.pid}` : join(dir, 'smoke.sock');
  const logs: string[] = [];
  let onClosed: ((lines: number) => void) | null = null;
  const pipe = startJournalPipe({
    ...opts,
    journalDir: dir,
    pipeName,
    maxRestarts: 0,
    log: { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l) },
    onMessage: (m) => {
      if (m.type === 'closed') onClosed?.(m.lines);
    },
  });
  try {
    if (!(await pipe.ready(10_000))) return { ok: false, detail: logs.at(-1) ?? 'the worker did not listen within 10 s' };
    const line = '{"event":"smoke","t":0}';
    const closed = new Promise<number>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('no connection report from the worker within 10 s')), 10_000);
      onClosed = (lines) => {
        clearTimeout(timer);
        done(lines);
      };
    });
    await new Promise<void>((done, fail) => {
      const s = connect(pipeName, () => s.end(`${JOURNAL_HEADER_PREFIX}smoke.jsonl\r\n${line}\r\n`));
      s.on('error', fail);
      s.on('close', () => done());
    });
    const lines = await closed;
    const text = readFileSync(join(dir, 'smoke.jsonl'), 'latin1');
    if (text !== `${line}\r\n`) return { ok: false, detail: `the journal holds ${JSON.stringify(text)}` };
    return { ok: true, detail: `(worker listened on its own pipe and wrote ${lines} line)` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await pipe.stop(2_000);
    rmSync(dir, { recursive: true, force: true });
  }
}
