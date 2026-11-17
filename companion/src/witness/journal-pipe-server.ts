/**
 * C16.2 (hook 0.6.0): the companion's end of the journal pipe. While the companion runs, the in-VPX hook writes its
 * journal lines into `\\.\pipe\castcade-journal` instead of the journal file, so nothing on VPX's render thread touches
 * the file system (a plain append to a held file sometimes took seconds on the owner's PC, and the table froze for that
 * long). This server, alone on a worker thread (`journal-pipe-worker.ts`, hosted by `journal-pipe.ts`), appends what
 * arrives to the same journal file the hook writes when the companion is not there, so the tail, the detector, the
 * fixtures and the evidence read the file as before.
 *
 * The file gets exactly the bytes the hook sent: the first line of a connection is a transport header naming the file
 * (`#castcade-journal 1 <file name>`, consumed here, never written), every later byte goes to that file unchanged and in
 * order, whole lines only (an unfinished line at the end of a connection is dropped and counted). A header that is not
 * valid closes the connection; the hook then writes the file itself.
 *
 * It never stops reading a connection: a hook's `WriteLine` blocks without limit once about 124 KB are unread, and that
 * would freeze the table. A slow disk grows a queue in memory (capped: past the cap lines are dropped, one warning per
 * episode), never the pipe's unread bytes. A file that cannot be opened or written (another process holds it) keeps its
 * lines queued and is retried with a backoff.
 *
 * Node built-ins only and no Electron: it runs on a worker thread of the packaged app and, under vitest, in-process
 * or on a worker thread through tsx.
 */
import { mkdir, open } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import type { MessagePort } from 'node:worker_threads';

/** The pipe the hook opens (`Castcade_PipeName` in `vpx-hook/castcade.vbs`). Tests and the smoke use their own names. */
export const JOURNAL_PIPE_NAME = '\\\\.\\pipe\\castcade-journal';
/** The transport header's text before the file name. */
export const JOURNAL_HEADER_PREFIX = '#castcade-journal 1 ';
/** A header line (with its CR LF) longer than this closes the connection. */
export const MAX_HEADER_BYTES = 1024;
/** NTFS's limit for one name; `Castcade_SafeName` never makes a longer one for a table id a file could be named after. */
export const MAX_JOURNAL_NAME = 255;
/** An unfinished line longer than this closes the connection: a journal line is at most a few hundred KB (`nvram_full`). */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Lines queued for the disk, all files together, before new lines are dropped. Hours of journal at the hook's rate. */
export const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;

/** One open journal file. `write` resolves once every byte is handed to Windows (readable by the tail). */
export interface JournalFile {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** How journal files are opened for appending; tests inject a slow one. */
export interface JournalFiles {
  open(path: string): Promise<JournalFile>;
}

/** Append through a held `FileHandle` (`'a'`: every write lands at the end of the file). */
export const nodeJournalFiles: JournalFiles = {
  async open(path) {
    const handle = await open(path, 'a');
    return {
      async write(bytes) {
        let at = 0;
        while (at < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, at, bytes.length - at);
          at += bytesWritten;
        }
      },
      close: () => handle.close(),
    };
  },
};

/** What the server reports (the worker posts these to the main thread, which logs them). */
export type JournalPipeEvent =
  | { type: 'listening'; pipe: string; dir: string }
  /** The pipe could not be listened on (its name is taken, most likely by another Castcade): scripts write the file. */
  | { type: 'unavailable'; pipe: string; reason: string }
  | { type: 'opened'; id: number; name: string }
  /** Posted once the connection ended AND every line it sent is in the file (or was dropped, counted here). */
  | { type: 'closed'; id: number; name: string; lines: number; bytes: number; dropped: number; partialBytes: number }
  | { type: 'refused'; id: number; reason: string }
  | { type: 'failure'; detail: string }
  | { type: 'note'; detail: string };

export interface JournalPipeServerOptions {
  /** `\\.\pipe\<name>` on Windows; a socket path elsewhere (the core's tests on Linux). */
  pipeName: string;
  /** `%LOCALAPPDATA%\Castcade\journal`; created when missing. */
  journalDir: string;
  emit: (event: JournalPipeEvent) => void;
  files?: JournalFiles;
  maxQueuedBytes?: number;
  /** First retry after a failed open or write; doubles to 8x. */
  retryMs?: number;
}

export interface DrainResult {
  name: string;
  /** Connections for this file still open when everything received so far was written (another VPX on the same table). */
  open: number;
  waitedMs: number;
}

export interface JournalPipeServer {
  /** Resolves when listening (true) or when the pipe could not be had (false). */
  readonly listening: Promise<boolean>;
  /**
   * Resolves once every byte received so far for this journal file is written. Pending I/O is let through first, so the
   * end of a connection whose process just exited is seen before the answer.
   */
  drain(name: string): Promise<DrainResult>;
  /** No new connections; resolves when every queue is written (or after `timeoutMs`) and the files are closed. Open connections stay open. */
  stop(timeoutMs: number): Promise<void>;
}

/** Why `name` cannot be a journal file name in `dir`, or null when it can. Same characters as `Castcade_SafeName`. */
export function journalNameProblem(name: string, dir: string): string | null {
  if (name.length > MAX_JOURNAL_NAME) return `file name longer than ${MAX_JOURNAL_NAME} characters`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return `file name ${JSON.stringify(name.slice(0, 80))} has a character Castcade_SafeName never writes (a path separator, a space, a colon, ...)`;
  if (!name.endsWith('.jsonl') || name.length === '.jsonl'.length) return `file name ${JSON.stringify(name)} is not <table>.jsonl`;
  const root = resolve(dir);
  if (dirname(resolve(root, name)) !== root) return `file name ${JSON.stringify(name)} is outside the journal folder`;
  return null;
}

/** The file name a header line names, or why it is not a header. `line` is without its line break. */
export function parseJournalHeader(line: string, dir: string): { name: string } | { problem: string } {
  if (!line.startsWith(JOURNAL_HEADER_PREFIX)) return { problem: `first line is not a journal header: ${JSON.stringify(line.slice(0, 80))}` };
  const name = line.slice(JOURNAL_HEADER_PREFIX.length);
  const problem = journalNameProblem(name, dir);
  return problem === null ? { name } : { problem };
}

interface Chunk {
  bytes: Buffer;
  lines: number;
  seq: number;
}

/** One journal file: its queue, its handle while connections are open, and who waits for what was queued. */
class Sink {
  readonly queue: Chunk[] = [];
  queuedBytes = 0;
  /** Sequence number of the last chunk accepted, and of the last chunk written. */
  acceptedSeq = 0;
  writtenSeq = 0;
  conns = 0;
  file: JournalFile | null = null;
  writing = false;
  failing = false;
  overflowing = false;
  retryMs: number;
  readonly waiters: { seq: number; done: () => void }[] = [];

  constructor(
    readonly name: string,
    readonly path: string,
    readonly baseRetryMs: number,
  ) {
    this.retryMs = baseRetryMs;
  }

  idle(): boolean {
    return this.conns === 0 && this.queue.length === 0 && !this.writing && this.file === null && this.waiters.length === 0;
  }

  /** Resolve every waiter whose bytes are written. */
  settle(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i]!;
      if (this.writtenSeq >= w.seq) {
        this.waiters.splice(i, 1);
        w.done();
      } else i++;
    }
  }

  /** Calls `done` once everything accepted up to now is written. */
  afterAccepted(done: () => void): void {
    if (this.writtenSeq >= this.acceptedSeq) done();
    else this.waiters.push({ seq: this.acceptedSeq, done });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function startJournalPipeServer(opts: JournalPipeServerOptions): JournalPipeServer {
  const { pipeName, journalDir, emit } = opts;
  const files = opts.files ?? nodeJournalFiles;
  const maxQueued = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const baseRetry = opts.retryMs ?? 250;
  const sinks = new Map<string, Sink>();
  let queuedTotal = 0;
  let nextId = 0;
  let stopping = false;

  const sinkFor = (name: string): Sink => {
    let s = sinks.get(name);
    if (!s) {
      s = new Sink(name, resolve(journalDir, name), baseRetry);
      sinks.set(name, s);
    }
    return s;
  };

  const forget = (s: Sink): void => {
    if (s.idle() && sinks.get(s.name) === s) sinks.delete(s.name);
  };

  /** Write the queue in order, one batch at a time; keep the file open while connections are; never drop on a failure. */
  const pump = async (s: Sink): Promise<void> => {
    if (s.writing) return;
    s.writing = true;
    try {
      while (s.queue.length > 0) {
        if (!s.file) {
          try {
            s.file = await files.open(s.path);
          } catch (err) {
            await failed(s, `could not open ${s.name}`, err);
            continue;
          }
        }
        const n = s.queue.length;
        const batch = s.queue.slice(0, n);
        const bytes = n === 1 ? batch[0]!.bytes : Buffer.concat(batch.map((c) => c.bytes));
        try {
          await s.file.write(bytes);
        } catch (err) {
          const f = s.file;
          s.file = null;
          await f.close().catch(() => undefined);
          await failed(s, `could not write ${s.name}`, err);
          continue;
        }
        s.queue.splice(0, n);
        s.queuedBytes -= bytes.length;
        queuedTotal -= bytes.length;
        s.writtenSeq = batch[n - 1]!.seq;
        if (s.failing) {
          s.failing = false;
          emit({ type: 'note', detail: `${s.name} is written again` });
        }
        s.retryMs = baseRetry;
        if (s.queue.length === 0) s.overflowing = false;
        s.settle();
      }
      // The last connection of this file is gone and everything is written: let go of the file, so a table loaded while the
      // companion is not running can open it (the hook's own open shares reading only).
      if (s.conns === 0 && s.file) {
        const f = s.file;
        s.file = null;
        await f.close().catch((err: unknown) => emit({ type: 'failure', detail: `could not close ${s.name}: ${errText(err)}` }));
      }
    } finally {
      s.writing = false;
    }
    s.settle();
    if (s.queue.length > 0) void pump(s);
    else forget(s);
  };

  const failed = async (s: Sink, what: string, err: unknown): Promise<void> => {
    if (!s.failing) {
      s.failing = true;
      emit({ type: 'failure', detail: `${what}: ${errText(err)}; its lines wait in memory and it is tried again` });
    }
    await sleep(s.retryMs);
    s.retryMs = Math.min(s.retryMs * 2, baseRetry * 8);
  };

  const accept = (s: Sink, bytes: Buffer, lines: number, conn: { dropped: number }): void => {
    if (queuedTotal + bytes.length > maxQueued) {
      conn.dropped += lines;
      if (!s.overflowing) {
        s.overflowing = true;
        emit({ type: 'failure', detail: `${s.name}: ${maxQueued} bytes are waiting for the disk; lines are dropped until it catches up` });
      }
      return;
    }
    s.queue.push({ bytes, lines, seq: ++s.acceptedSeq });
    s.queuedBytes += bytes.length;
    queuedTotal += bytes.length;
    void pump(s);
  };

  const countLines = (b: Buffer): number => {
    let n = 0;
    for (let i = b.indexOf(0x0a); i >= 0; i = b.indexOf(0x0a, i + 1)) n++;
    return n;
  };

  const onConnection = (socket: Socket): void => {
    const id = ++nextId;
    const conn: { name: string | null; sink: Sink | null; head: Buffer; partial: Buffer; lines: number; bytes: number; dropped: number; done: boolean } = {
      name: null,
      sink: null,
      head: Buffer.alloc(0),
      partial: Buffer.alloc(0),
      lines: 0,
      bytes: 0,
      dropped: 0,
      done: false,
    };
    const refuse = (reason: string): void => {
      conn.done = true;
      emit({ type: 'refused', id, reason });
      socket.destroy();
    };
    const body = (chunk: Buffer): void => {
      const buf = conn.partial.length > 0 ? Buffer.concat([conn.partial, chunk]) : chunk;
      const last = buf.lastIndexOf(0x0a);
      if (last < 0) {
        conn.partial = buf;
      } else {
        // Copies: the queued lines and the unfinished line do not share one buffer.
        const whole = Buffer.from(buf.subarray(0, last + 1));
        conn.partial = last + 1 < buf.length ? Buffer.from(buf.subarray(last + 1)) : Buffer.alloc(0);
        const lines = countLines(whole);
        conn.lines += lines;
        conn.bytes += whole.length;
        accept(conn.sink!, whole, lines, conn);
      }
      if (conn.partial.length > MAX_LINE_BYTES) {
        emit({ type: 'failure', detail: `${conn.name}: connection ${id} sent ${conn.partial.length} bytes without a line break; closed` });
        conn.partial = Buffer.alloc(0);
        socket.destroy();
      }
    };
    socket.on('data', (chunk: Buffer) => {
      if (conn.done) return;
      if (conn.name !== null) {
        body(chunk);
        return;
      }
      const head = conn.head.length > 0 ? Buffer.concat([conn.head, chunk]) : chunk;
      const nl = head.indexOf(0x0a);
      if (nl < 0) {
        if (head.length > MAX_HEADER_BYTES) refuse(`no journal header in the first ${MAX_HEADER_BYTES} bytes`);
        else conn.head = Buffer.from(head);
        return;
      }
      if (nl + 1 > MAX_HEADER_BYTES) {
        refuse(`journal header longer than ${MAX_HEADER_BYTES} bytes`);
        return;
      }
      const text = head.subarray(0, nl > 0 && head[nl - 1] === 0x0d ? nl - 1 : nl).toString('latin1');
      const parsed = parseJournalHeader(text, journalDir);
      if ('problem' in parsed) {
        refuse(parsed.problem);
        return;
      }
      conn.name = parsed.name;
      conn.sink = sinkFor(parsed.name);
      conn.sink.conns++;
      conn.head = Buffer.alloc(0);
      emit({ type: 'opened', id, name: parsed.name });
      if (nl + 1 < head.length) body(Buffer.from(head.subarray(nl + 1)));
    });
    // However a connection ends (its end, or an error when the writer went away), 'close' follows: that is the end.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      const s = conn.sink;
      if (!s || conn.name === null) return;
      const name = conn.name;
      conn.done = true;
      s.conns--;
      const partialBytes = conn.partial.length;
      conn.partial = Buffer.alloc(0);
      s.afterAccepted(() => {
        emit({ type: 'closed', id, name, lines: conn.lines - conn.dropped, bytes: conn.bytes, dropped: conn.dropped, partialBytes });
        if (s.conns === 0 && !s.writing && s.queue.length === 0) {
          // Nothing left to write, so no pump runs to close the file: close it here.
          if (s.file) {
            void pump(s);
          } else forget(s);
        }
      });
    });
  };

  const server: Server = createServer(onConnection);
  const listening = new Promise<boolean>((resolveListening) => {
    let up = false;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (up) {
        emit({ type: 'failure', detail: `pipe server: ${errText(err)}` });
        return;
      }
      const reason = err.code === 'EADDRINUSE' || err.code === 'EACCES' ? `${pipeName} is taken (another Castcade?)` : errText(err);
      emit({ type: 'unavailable', pipe: pipeName, reason });
      resolveListening(false);
    });
    void mkdir(journalDir, { recursive: true })
      .catch((err: unknown) => emit({ type: 'failure', detail: `could not create ${journalDir}: ${errText(err)}` }))
      .then(() =>
        server.listen(pipeName, () => {
          up = true;
          emit({ type: 'listening', pipe: pipeName, dir: journalDir });
          resolveListening(true);
        }),
      );
  });

  return {
    listening,
    async drain(name) {
      const started = Date.now();
      // Let pending I/O through first: the end (and the last bytes) of a connection whose VPX just exited.
      await new Promise<void>((r) => setImmediate(r));
      const s = sinks.get(name);
      if (s) await new Promise<void>((r) => s.afterAccepted(r));
      return { name, open: sinks.get(name)?.conns ?? 0, waitedMs: Date.now() - started };
    },
    async stop(timeoutMs) {
      if (stopping) return;
      stopping = true;
      // No new connections. The callback would wait for the open ones to end, which is the hooks' call: not awaited.
      server.close();
      const all = Promise.all([...sinks.values()].map((s) => new Promise<void>((r) => s.afterAccepted(r))));
      await Promise.race([all, sleep(timeoutMs)]);
      for (const s of sinks.values()) {
        if (s.file && !s.writing) {
          const f = s.file;
          s.file = null;
          await f.close().catch(() => undefined);
        }
      }
    },
  };
}

/** What the worker is started with (`workerData`). */
export interface JournalPipeWorkerData {
  pipeName: string;
  journalDir: string;
  maxQueuedBytes?: number;
}

/** The main thread's requests to the worker. */
export type JournalPipeCommand = { type: 'drain'; req: number; name: string } | { type: 'stop'; timeoutMs: number };

/** Everything the worker posts: the server's events, the answers to `drain`, and `stopped`. */
export type JournalPipeWorkerMessage = JournalPipeEvent | ({ type: 'drained'; req: number } & DrainResult) | { type: 'stopped' };

/** The worker's whole job: run the server and answer the main thread over `port` (`journal-pipe-worker.ts`). */
export function serveJournalPipe(port: MessagePort, data: JournalPipeWorkerData, files?: JournalFiles): JournalPipeServer {
  const post = (m: JournalPipeWorkerMessage): void => port.postMessage(m);
  const server = startJournalPipeServer({ pipeName: data.pipeName, journalDir: data.journalDir, maxQueuedBytes: data.maxQueuedBytes, files, emit: post });
  port.on('message', (m: JournalPipeCommand) => {
    if (m.type === 'drain') void server.drain(m.name).then((r) => post({ type: 'drained', req: m.req, ...r }));
    else if (m.type === 'stop') void server.stop(m.timeoutMs).then(() => post({ type: 'stopped' }));
  });
  return server;
}
