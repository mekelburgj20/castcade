/**
 * C16.2: the journal pipe's server (`journal-pipe-server.ts`) over real sockets (a named pipe on Windows, a Unix socket
 * elsewhere) with plain Node clients standing in for the hook, and its host (`journal-pipe.ts`) with the real worker on a
 * worker thread. The hook itself under cscript is `journal-pipe-cscript.test.ts`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { journalFileName } from './journal-tail.js';
import { journalNameIn, smokeJournalPipe, startJournalPipe, type JournalPipe } from './journal-pipe.js';
import {
  JOURNAL_HEADER_PREFIX,
  journalNameProblem,
  nodeJournalFiles,
  parseJournalHeader,
  startJournalPipeServer,
  type JournalFiles,
  type JournalPipeEvent,
  type JournalPipeServer,
  type JournalPipeServerOptions,
} from './journal-pipe-server.js';
import { testPipeName, tsWorker } from './journal-pipe.test-support.js';

const root = mkdtempSync(join(tmpdir(), 'castcade-pipe-'));
const servers: JournalPipeServer[] = [];
const hosts: JournalPipe[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop(100)));
  await Promise.all(hosts.map((h) => h.stop(500)));
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const pipePath = (tag: string): string => (process.platform === 'win32' ? testPipeName(tag) : join(root, `${tag}-${++n}.sock`));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const waiter = <T>(items: T[]) => {
  const waits: { pred: () => boolean; done: () => void }[] = [];
  return {
    wake: () => {
      for (const w of waits.splice(0)) {
        if (w.pred()) w.done();
        else waits.push(w);
      }
    },
    until: (pred: () => boolean, ms = 5_000): Promise<void> =>
      pred()
        ? Promise.resolve()
        : new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error(`not within ${ms} ms: ${JSON.stringify(items)}`)), ms);
            waits.push({ pred, done: () => (clearTimeout(timer), done()) });
          }),
  };
};

/** A server in its own journal folder, every event kept. */
const serve = async (tag: string, extra: Partial<JournalPipeServerOptions> = {}) => {
  const events: JournalPipeEvent[] = [];
  const w = waiter(events);
  const dir = join(root, `${tag}-${++n}`, 'journal');
  const pipe = pipePath(tag);
  const server = startJournalPipeServer({
    pipeName: pipe,
    journalDir: dir,
    emit: (e) => {
      events.push(e);
      w.wake();
    },
    ...extra,
  });
  servers.push(server);
  expect(await server.listening).toBe(true);
  const closed = () => events.filter((e): e is Extract<JournalPipeEvent, { type: 'closed' }> => e.type === 'closed');
  return { server, events, dir, pipe, until: w.until, closed };
};

/** A stand-in for the hook: connect, send each chunk (a short pause between), then end unless told to stay. */
const hook = (pipe: string) => {
  const s = connect(pipe);
  let closed = false;
  const gone = new Promise<void>((r) => s.on('close', () => ((closed = true), r())));
  s.on('error', () => undefined);
  const connected = new Promise<void>((r) => s.once('connect', () => r()));
  return {
    async send(...chunks: (string | Buffer)[]): Promise<void> {
      await connected;
      for (const c of chunks) {
        if (closed) return;
        s.write(c);
        await sleep(15);
      }
    },
    end: async (): Promise<void> => {
      s.end();
      await gone;
    },
    /** Resolves true when the server closed the connection within `ms`. */
    closedByServer: (ms = 2_000): Promise<boolean> => Promise.race([gone.then(() => true), sleep(ms).then(() => false)]),
  };
};

const header = (name: string): string => `${JOURNAL_HEADER_PREFIX}${name}\r\n`;
const fileText = (dir: string, name: string): string => readFileSync(join(dir, name), 'latin1');

/** A writer whose writes wait for `release()`; counts opens and closes. */
const gatedFiles = () => {
  let open = (): void => undefined;
  let gate = new Promise<void>((r) => (open = r));
  const log: string[] = [];
  const files: JournalFiles = {
    async open(path) {
      log.push('open');
      const f = await nodeJournalFiles.open(path);
      return {
        async write(bytes) {
          await gate;
          await f.write(bytes);
        },
        async close() {
          log.push('close');
          await f.close();
        },
      };
    },
  };
  return {
    files,
    log,
    release: () => open(),
    hold: () => (gate = new Promise<void>((r) => (open = r))),
  };
};

describe('journal pipe: file names and the header', () => {
  it('accepts every name Castcade_SafeName can make, and nothing that leaves the journal folder', () => {
    const dir = join(root, 'names', 'journal');
    for (const id of ['Medieval Madness (Williams 1997) VPW v1.0.1', 'Pipe Table (Test 1)', '', '..', '.', 'a/b\\c:d*e?f', 'Ünïcødé', 'x'.repeat(249)]) {
      expect(journalNameProblem(journalFileName(id), dir), id).toBeNull();
    }
    for (const bad of ['', 'x.txt', '.jsonl', 'a b.jsonl', 'a/b.jsonl', 'a\\b.jsonl', '../evil.jsonl', '..\\evil.jsonl', 'C:evil.jsonl', 'é.jsonl', 'x.jsonl\0', 'x.jsonl ', `${'x'.repeat(250)}.jsonl`]) {
      expect(journalNameProblem(bad, dir), JSON.stringify(bad)).not.toBeNull();
    }
    expect(parseJournalHeader('#castcade-journal 1 Pipe_Table_Test_1.jsonl', dir)).toEqual({ name: 'Pipe_Table_Test_1.jsonl' });
    expect(parseJournalHeader('#castcade-journal 2 x.jsonl', dir)).toMatchObject({ problem: expect.stringMatching(/not a journal header/) });
    expect(parseJournalHeader('{"event":"table_loaded"}', dir)).toMatchObject({ problem: expect.stringMatching(/not a journal header/) });
    expect(journalNameIn(dir, join(dir, 'x.jsonl'))).toBe('x.jsonl');
    expect(journalNameIn(dir, join(root, 'elsewhere', 'x.jsonl'))).toBeNull();
  });

  it('a connection whose first line is not a valid header is closed and writes nothing anywhere', async () => {
    const p = await serve('refuse');
    const cases: [string, string | Buffer, RegExp][] = [
      ['dot-dot slash', header('../evil.jsonl'), /character Castcade_SafeName never writes/],
      ['dot-dot backslash', header('..\\evil.jsonl'), /character Castcade_SafeName never writes/],
      ['separator', header('sub/x.jsonl'), /character Castcade_SafeName never writes/],
      ['space', header('bad name.jsonl'), /character Castcade_SafeName never writes/],
      ['not .jsonl', header('x.txt'), /not <table>\.jsonl/],
      ['other version', '#castcade-journal 2 x.jsonl\r\n', /not a journal header/],
      ['no header', '{"event":"table_loaded","t":0}\r\n', /not a journal header/],
      ['oversize header line', `${JOURNAL_HEADER_PREFIX}${'a'.repeat(1100)}.jsonl\r\n`, /longer than 1024 bytes/],
      ['no line break', Buffer.alloc(2000, 0x61), /no journal header in the first 1024 bytes/],
    ];
    for (const [label, first, why] of cases) {
      const c = hook(p.pipe);
      await c.send(first, '{"event":"table_loaded","t":0}\r\n');
      expect(await c.closedByServer(), label).toBe(true);
      expect(p.events.filter((e) => e.type === 'refused').at(-1), label).toMatchObject({ type: 'refused', reason: expect.stringMatching(why) });
    }
    expect(p.events.filter((e) => e.type === 'refused')).toHaveLength(cases.length);
    expect(p.events.filter((e) => e.type === 'opened' || e.type === 'closed')).toEqual([]);
    expect(readdirSync(p.dir)).toEqual([]);
    expect(readdirSync(join(p.dir, '..'))).toEqual(['journal']);
  });
});

describe('journal pipe: the server', () => {
  it('two connections at once (two tables, and two on one table): whole lines, each connection in its order, the header never written', async () => {
    const p = await serve('two');
    const a = hook(p.pipe);
    const b = hook(p.pipe);
    const c = hook(p.pipe);
    await Promise.all([a.send(header('same.jsonl')), b.send(header('same.jsonl')), c.send(header('other.jsonl'))]);
    await p.until(() => p.events.filter((e) => e.type === 'opened').length === 3);
    // Lines split anywhere across writes, the three connections interleaved.
    await Promise.all([
      a.send('{"a":1}\r\n{"a', '":2}\r', '\n{"a":3}\r\n'),
      b.send('{"b":1}', '\r\n{"b":2}\r\n'),
      c.send('{"c":1}\r\n{"c":2', '}\r\n'),
    ]);
    expect(p.closed()).toEqual([]); // all three were open at once
    await Promise.all([a.end(), b.end(), c.end()]);
    await p.until(() => p.closed().length === 3);
    const same = fileText(p.dir, 'same.jsonl').split('\r\n');
    expect(same.at(-1)).toBe('');
    expect(same.filter((l) => l.startsWith('{"a"'))).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
    expect(same.filter((l) => l.startsWith('{"b"'))).toEqual(['{"b":1}', '{"b":2}']);
    expect(same).toHaveLength(6);
    expect(fileText(p.dir, 'other.jsonl')).toBe('{"c":1}\r\n{"c":2}\r\n');
    expect(p.closed().map((e) => [e.name, e.lines]).sort()).toEqual([['other.jsonl', 2], ['same.jsonl', 2], ['same.jsonl', 3]]);
  });

  it('an unfinished last line is dropped and counted, never glued to the next session', async () => {
    const p = await serve('partial');
    const c = hook(p.pipe);
    await c.send(header('t.jsonl'), '{"event":"table_loaded"}\r\n{"event":"unfin');
    await c.end();
    await p.until(() => p.closed().length === 1);
    expect(p.closed()[0]).toMatchObject({ name: 't.jsonl', lines: 1, partialBytes: 15 });
    expect(fileText(p.dir, 't.jsonl')).toBe('{"event":"table_loaded"}\r\n');
  });

  it('drain: answers at once for a file with nothing queued, and once a slow write is done for one that has', async () => {
    const g = gatedFiles();
    const p = await serve('drain', { files: g.files });
    expect(await p.server.drain('nothing.jsonl')).toMatchObject({ name: 'nothing.jsonl', open: 0 });
    const c = hook(p.pipe);
    await c.send(header('d.jsonl'), '{"event":"table_exit"}\r\n');
    await c.end(); // the hook's process is gone, its last line is still waiting for the disk
    let drained = false;
    const d = p.server.drain('d.jsonl').then((r) => ((drained = true), r));
    await sleep(200);
    expect(drained).toBe(false);
    g.release();
    expect(await d).toMatchObject({ name: 'd.jsonl', open: 0, waitedMs: expect.any(Number) });
    expect(fileText(p.dir, 'd.jsonl')).toBe('{"event":"table_exit"}\r\n');
  });

  it('a slow disk never stops the reading: past the memory cap lines are dropped with one warning, never queued in the pipe', async () => {
    const g = gatedFiles();
    const p = await serve('cap', { files: g.files, maxQueuedBytes: 1_000 });
    const c = hook(p.pipe);
    const line = (i: number): string => `{"i":${String(i).padStart(3, '0')},"pad":"${'x'.repeat(80)}"}\r\n`; // 100 bytes
    await c.send(header('cap.jsonl'));
    for (let i = 1; i <= 50; i++) await c.send(line(i));
    await c.end();
    g.release();
    await p.until(() => p.closed().length === 1);
    const closed = p.closed()[0]!;
    expect(closed.lines + closed.dropped).toBe(50);
    expect(closed.dropped).toBeGreaterThan(30);
    expect(p.events.filter((e) => e.type === 'failure')).toEqual([{ type: 'failure', detail: 'cap.jsonl: 1000 bytes are waiting for the disk; lines are dropped until it catches up' }]);
    // What was kept is the start of the journal, whole lines in order.
    expect(fileText(p.dir, 'cap.jsonl')).toBe(Array.from({ length: closed.lines }, (_, k) => line(k + 1)).join(''));
  });

  it('a file another program holds is retried: the lines wait in memory, one warning, one line when it is written again', async () => {
    let refusals = 2;
    const files: JournalFiles = {
      open: (path) => (refusals-- > 0 ? Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })) : nodeJournalFiles.open(path)),
    };
    const p = await serve('busy', { files, retryMs: 10 });
    const c = hook(p.pipe);
    await c.send(header('busy.jsonl'), '{"n":1}\r\n', '{"n":2}\r\n');
    await c.end();
    await p.until(() => p.closed().length === 1);
    expect(fileText(p.dir, 'busy.jsonl')).toBe('{"n":1}\r\n{"n":2}\r\n');
    expect(p.events.filter((e) => e.type === 'failure' || e.type === 'note')).toEqual([
      { type: 'failure', detail: 'could not open busy.jsonl: EBUSY: resource busy or locked; its lines wait in memory and it is tried again' },
      { type: 'note', detail: 'busy.jsonl is written again' },
    ]);
  });

  it('the file is let go when its last connection ends (a table loaded without the companion can open it), and opened again for the next', async () => {
    const g = gatedFiles();
    g.release();
    const p = await serve('release', { files: g.files });
    const a = hook(p.pipe);
    const b = hook(p.pipe);
    await a.send(header('r.jsonl'), '{"a":1}\r\n');
    await b.send(header('r.jsonl'), '{"b":1}\r\n');
    await a.end();
    await p.until(() => p.closed().length === 1);
    await sleep(50);
    expect(g.log).toEqual(['open']);
    await b.end();
    await p.until(() => p.closed().length === 2);
    await sleep(50);
    expect(g.log).toEqual(['open', 'close']);
    const c = hook(p.pipe);
    await c.send(header('r.jsonl'), '{"c":1}\r\n');
    await c.end();
    await p.until(() => p.closed().length === 3);
    await sleep(50);
    expect(g.log).toEqual(['open', 'close', 'open', 'close']);
    expect(fileText(p.dir, 'r.jsonl')).toBe('{"a":1}\r\n{"b":1}\r\n{"c":1}\r\n');
  });

  it('a pipe name already taken is reported, and the first server keeps it', async () => {
    const p = await serve('taken');
    const events: JournalPipeEvent[] = [];
    const second = startJournalPipeServer({ pipeName: p.pipe, journalDir: join(root, 'taken-2'), emit: (e) => events.push(e) });
    servers.push(second);
    expect(await second.listening).toBe(false);
    expect(events).toEqual([{ type: 'unavailable', pipe: p.pipe, reason: `${p.pipe} is taken (another Castcade?)` }]);
    const c = hook(p.pipe);
    await c.send(header('k.jsonl'), '{"k":1}\r\n');
    await c.end();
    await p.until(() => p.closed().length === 1);
    expect(fileText(p.dir, 'k.jsonl')).toBe('{"k":1}\r\n');
  });
});

describe('journal pipe: the host and its worker thread (the real worker, from source)', () => {
  const host = (tag: string, extra: { entry?: string; workerData?: Record<string, unknown>; maxRestarts?: number; pipeName?: string } = {}) => {
    const logs: string[] = [];
    const w = waiter(logs);
    const dir = join(root, `${tag}-${++n}`, 'journal');
    const pipe = startJournalPipe({
      journalDir: dir,
      pipeName: extra.pipeName ?? pipePath(tag),
      restartDelayMs: 50,
      ...(extra.maxRestarts !== undefined ? { maxRestarts: extra.maxRestarts } : {}),
      ...(extra.workerData ? { workerData: extra.workerData } : {}),
      ...tsWorker(extra.entry),
      log: {
        info: (l) => (logs.push(`info ${l}`), w.wake()),
        warn: (l) => (logs.push(`warn ${l}`), w.wake()),
        error: (l) => (logs.push(`error ${l}`), w.wake()),
      },
    });
    hosts.push(pipe);
    return { pipe, logs, dir, until: w.until };
  };

  it('listens, logs a line per connection with the file and the line count, and stops', async () => {
    const h = host('host');
    expect(await h.pipe.ready(15_000)).toBe(true);
    expect(h.pipe.state()).toBe('listening');
    const c = hook(h.pipe.pipeName);
    await c.send(header('h.jsonl'), '{"n":1}\r\n{"n":2}\r\n');
    await c.end();
    await h.until(() => h.logs.some((l) => l.includes('closed')), 10_000);
    expect(h.logs).toEqual([
      `info journal pipe: listening on ${h.pipe.pipeName} (journals in ${h.dir}); tables loaded from now on send their journal through it`,
      'info journal pipe: h.jsonl: connection 1 opened',
      'info journal pipe: h.jsonl: connection 1 closed, 2 lines written',
    ]);
    expect(await h.pipe.drain(join(h.dir, 'h.jsonl'))).toBe(true);
    expect(await h.pipe.drain(join(root, 'not-the-journal-folder', 'h.jsonl'))).toBe(true);
    await h.pipe.stop();
    expect(h.pipe.state()).toBe('stopped');
    expect(await h.pipe.drain(join(h.dir, 'h.jsonl'))).toBe(true);
    // Stopped: nothing listens any more, so a hook would write its file itself.
    const late = connect(h.pipe.pipeName);
    expect(await new Promise((r) => late.on('error', (e: NodeJS.ErrnoException) => r(e.code)).on('connect', () => r('connected')))).toMatch(/ENOENT|ECONNREFUSED/);
  });

  it('a worker that dies is started again; one that keeps dying is given up for the run', async () => {
    const h = host('restart', { entry: './journal-pipe-test-worker.test-support.ts', workerData: { exitAfterMs: 100 }, maxRestarts: 2 });
    await h.until(() => h.pipe.state() === 'failed', 15_000);
    expect(h.logs.filter((l) => l.startsWith('info journal pipe: listening'))).toHaveLength(3);
    expect(h.logs.filter((l) => l.startsWith('error journal pipe: the worker stopped (exit code 3); starting it again in 50 ms'))).toHaveLength(2);
    expect(h.logs.at(-1)).toBe('error journal pipe: the worker stopped 3 times in a row; the pipe is off for this run and tables write their journal file themselves');
    expect(await h.pipe.ready(10)).toBe(false);
  });

  it('the pipe name taken: logged once, no restart, tables keep writing their files', async () => {
    const first = host('owned');
    expect(await first.pipe.ready(15_000)).toBe(true);
    const second = host('owned', { pipeName: first.pipe.pipeName });
    expect(await second.pipe.ready(15_000)).toBe(false);
    expect(second.pipe.state()).toBe('unavailable');
    await sleep(200);
    expect(second.logs).toEqual([`warn journal pipe: ${first.pipe.pipeName} is taken (another Castcade?); tables write their journal file themselves this run`]);
  });

  it('the drain bound: a write stuck on the disk makes drain() give up after the bound and say so; the default bound waits for it', async () => {
    const h = host('bound', { entry: './journal-pipe-test-worker.test-support.ts', workerData: { stallMs: 1_500, stallWrites: 1 } });
    expect(await h.pipe.ready(15_000)).toBe(true);
    const c = hook(h.pipe.pipeName);
    await c.send(header('b.jsonl'), '{"event":"table_exit"}\r\n');
    await c.end();
    const path = join(h.dir, 'b.jsonl');
    expect(await h.pipe.drain(path, 200)).toBe(false);
    expect(h.logs).toContain('warn journal pipe: b.jsonl: its last lines were still on their way to the file after 200 ms; the file is read as it is');
    expect(await h.pipe.drain(path)).toBe(true);
    expect(readFileSync(path, 'latin1')).toBe('{"event":"table_exit"}\r\n');
    expect(h.logs.some((l) => /info journal pipe: b\.jsonl: waited \d+ ms for its last lines to reach the file/.test(l))).toBe(true);
  });

  it('the smoke check (--smoke) passes with the real worker', async () => {
    expect(await smokeJournalPipe(tsWorker())).toEqual({ ok: true, detail: '(worker listened on its own pipe and wrote 1 line)' });
  });
});
