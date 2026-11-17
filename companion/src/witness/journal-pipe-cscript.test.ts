/**
 * C16.2 (hook 0.6.0): the real `castcade.vbs` under the Windows VBScript engine, writing its journal through a real pipe
 * held by the real worker (`journal-pipe-worker.ts` on a worker thread, run from source through tsx). The journal file
 * must be byte for byte what file mode writes; the companion going away mid-game must cost at most the lines in transit;
 * the drain must not depend on the main thread or on the disk. Windows only: skipped where `cscript.exe` does not exist
 * (the Linux CI job), like `sidecar-cscript.test.ts`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { startJournalPipe, type JournalPipe } from './journal-pipe.js';
import type { JournalPipeWorkerMessage } from './journal-pipe-server.js';
import { testPipeName, tsWorker } from './journal-pipe.test-support.js';

const CSCRIPT = process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cscript.exe') : '';
const haveCscript = CSCRIPT !== '' && existsSync(CSCRIPT);
const LIB = fileURLToPath(new URL('../../../vpx-hook/castcade.vbs', import.meta.url));

const dir = haveCscript ? mkdtempSync(join(tmpdir(), 'castcade-pipe-cscript-')) : '';
const children: ChildProcess[] = [];
const pipes: JournalPipe[] = [];
const workers: Worker[] = [];
afterAll(async () => {
  await Promise.all(children.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => new Promise((r) => c.once('exit', r).kill())));
  await Promise.all(pipes.map((p) => p.stop(1_000)));
  await Promise.all(workers.map((w) => w.terminate()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const vbs = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** A folder standing in for `%LOCALAPPDATA%`; the journal folder inside it is the worker's too, as in production. */
const localAppData = (name: string): { local: string; journals: string } => {
  const local = join(dir, name);
  mkdirSync(local, { recursive: true });
  return { local, journals: join(local, 'Castcade', 'journal') };
};

/** The harness: `Castcade_PipeName` set before the real library loads (never the production name), a stand-in `Controller`. */
const harness = (name: string, pipe: string, body: string[]): string => {
  const path = join(dir, `${name}.vbs`);
  writeFileSync(
    path,
    [
      `Dim Castcade_PipeName : Castcade_PipeName = ${vbs(pipe)}`,
      'Class Castcade_TestController',
      '    Public Property Get NVRAM : NVRAM = Array(0, 1, 2, 3) : End Property',
      'End Class',
      'Dim Controller : Set Controller = New Castcade_TestController',
      `ExecuteGlobal CreateObject("Scripting.FileSystemObject").OpenTextFile(${vbs(LIB)}, 1, False, 0).ReadAll`,
      ...body,
    ].join('\r\n') + '\r\n',
  );
  return path;
};

/** Run a harness to its end without blocking this thread (the worker's messages come through it). */
const run = (script: string, local: string, timeoutMs = 60_000): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(CSCRIPT, ['//nologo', script], { env: { ...process.env, LOCALAPPDATA: local }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    child.stdout!.setEncoding('latin1').on('data', (d: string) => (out += d));
    child.stderr!.setEncoding('latin1').on('data', (d: string) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cscript timed out: ${out}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

/** The real worker behind the host, with every message kept; `entry` picks a test entry (the slow disk). */
const pipeFor = (journals: string, tag: string, extra: { entry?: string; workerData?: Record<string, unknown>; drainBoundMs?: number } = {}) => {
  const messages: JournalPipeWorkerMessage[] = [];
  const timed: { at: number; m: JournalPipeWorkerMessage }[] = [];
  const logs: string[] = [];
  const waits: { pred: () => boolean; done: () => void }[] = [];
  const pipe = startJournalPipe({
    journalDir: journals,
    pipeName: testPipeName(tag),
    log: { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l) },
    ...tsWorker(extra.entry),
    ...(extra.workerData ? { workerData: extra.workerData } : {}),
    ...(extra.drainBoundMs ? { drainBoundMs: extra.drainBoundMs } : {}),
    onMessage: (m) => {
      messages.push(m);
      timed.push({ at: Date.now(), m });
      for (const w of waits.splice(0)) {
        if (w.pred()) w.done();
        else waits.push(w);
      }
    },
  });
  pipes.push(pipe);
  const until = (pred: () => boolean, ms = 30_000): Promise<void> =>
    pred()
      ? Promise.resolve()
      : new Promise((done, fail) => {
          const timer = setTimeout(() => fail(new Error(`no such worker message within ${ms} ms: ${JSON.stringify(messages)}`)), ms);
          waits.push({ pred, done: () => (clearTimeout(timer), done()) });
        });
  const closed = () => messages.filter((m): m is Extract<JournalPipeWorkerMessage, { type: 'closed' }> => m.type === 'closed');
  return { pipe, messages, timed, logs, until, closed };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The bytes of a journal with the two things that differ between runs made equal: `t` (Timer) and the session stamp. */
const masked = (bytes: Buffer): string =>
  bytes
    .toString('latin1')
    .replace(/"t":-?[\d.]+/g, '"t":0')
    .replace(/"session":"[^"]*"/g, '"session":"S"');

const lines = (path: string): string[] => readFileSync(path, 'latin1').split('\r\n').filter((l) => l !== '');

/** The statements of a game that writes every kind of line the library has, including bytes outside ASCII. */
const GAME = [
  'Castcade_Init "Pipe Table (Test 1)", "A", "0.3.2", "congo_21"',
  'Castcade_WatchBytes Array(5794)',
  'Dim chg(0, 2), ss, i',
  'chg(0, 0) = 5794 : chg(0, 1) = 42 : chg(0, 2) = 7 : Castcade_NVRAM chg',
  'Castcade_GameStart 2',
  'Castcade_Scores Array(1000, 2500), 1, 1',
  'Castcade_Event "custom", """note"":" & Castcade_Q("quote "" back\\slash " & ChrW(233) & ChrW(937) & " tab" & vbTab & "end")',
  'Castcade_BallEnd 1, 1, 0',
  'Set ss = Castcade_ScoreServer() : ss.SetGameName "pipe" : ss.SetGameState 2, 1, 3, 3',
  'For i = 1 To 300 : Castcade_Event "bulk", """i"":" & i & ",""pad"":""" & String(200, "x") & """" : Next',
  'Castcade_GameEnd Array(1000, 2500), 2',
  'Castcade_Exit',
  'WScript.Echo "done"',
];
const GAME_FILE = 'Pipe_Table_Test_1.jsonl';

describe.skipIf(!haveCscript)('hook 0.6.0: the journal through the companion pipe (real castcade.vbs, real worker)', () => {
  it('the journal file is byte for byte what file mode writes (t and the session stamp masked), and only the worker wrote it', async () => {
    const viaPipe = localAppData('identical-pipe');
    const w = pipeFor(viaPipe.journals, 'identical');
    expect(await w.pipe.ready(15_000)).toBe(true);
    expect(await run(harness('identical-pipe', w.pipe.pipeName, GAME), viaPipe.local)).toEqual({ code: 0, out: 'done\r\n' });
    await w.until(() => w.closed().length === 1);

    const viaFile = localAppData('identical-file');
    expect(await run(harness('identical-file', testPipeName('absent'), GAME), viaFile.local)).toEqual({ code: 0, out: 'done\r\n' });

    const piped = readFileSync(join(viaPipe.journals, GAME_FILE));
    const filed = readFileSync(join(viaFile.journals, GAME_FILE));
    expect(masked(piped)).toBe(masked(filed));
    // The header never reaches the file; every line ends CR LF; the non-ASCII characters went through the same ANSI conversion.
    expect(piped.toString('latin1')).not.toContain('#castcade-journal');
    expect(piped.toString('latin1').split('\r\n').at(-1)).toBe('');
    expect(piped.toString('latin1')).toContain('quote \\" back\\\\slash ');
    expect(piped.some((b) => b > 0x7f)).toBe(true);
    const all = lines(join(viaPipe.journals, GAME_FILE));
    expect(JSON.parse(all[0]!)).toMatchObject({ event: 'table_loaded', table: 'Pipe Table (Test 1)', lib: '0.6.0' });
    expect(JSON.parse(all.at(-1)!)).toMatchObject({ event: 'table_exit', lines: all.length - 1 });
    // The worker wrote every line: a hook that had written the file itself would show 0 here.
    expect(w.closed()).toEqual([expect.objectContaining({ name: GAME_FILE, lines: all.length, dropped: 0, partialBytes: 0 })]);
    expect(w.logs.filter((l) => /refused|failed|could not/.test(l))).toEqual([]);
  });

  it('no companion: the open fails fast and the file is written from table load to exit; a pipe that appears mid-session is never used', async () => {
    const { local, journals } = localAppData('no-server');
    const name = testPipeName('late');
    const script = harness('no-server', name, [
      'Dim t0 : t0 = Timer',
      'Castcade_Init "late server", "A", "0.3.2", ""',
      'WScript.Echo "init " & Round((Timer - t0) * 1000)',
      'Castcade_Event "before", ""',
      'WScript.Sleep 1500',
      'Castcade_Event "after", ""',
      'Castcade_Exit',
    ]);
    // A listener on the hook's pipe name 500 ms into the session: the hook does not look again.
    const connections: number[] = [];
    const late = createServer(() => connections.push(Date.now()));
    const done = run(script, local);
    await new Promise((r) => setTimeout(r, 500));
    await new Promise<void>((r) => late.listen(name, () => r()));
    const { code, out } = await done;
    await new Promise<void>((r) => late.close(() => r()));
    expect(code).toBe(0);
    expect(Number(/init (\d+)/.exec(out)?.[1])).toBeLessThan(1_000);
    expect(connections).toEqual([]);
    expect(lines(join(journals, 'late_server.jsonl')).map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(['table_loaded', 'before', 'after', 'table_exit']);
  });

  /**
   * One kill: the real worker on a bare thread, terminated (what a crash, or Castcade killed, does to the pipe) once
   * `killAt` lines are in the file and `phaseMs` later, while the hook writes `n` lines `paceMs` apart.
   */
  const killedRun = async (tag: string, n: number, paceMs: number, killAt: number, phaseMs: number): Promise<{ failover: number; lost: number[] }> => {
    const { local, journals } = localAppData(tag);
    const name = testPipeName('killed');
    const { workerUrl, execArgv } = tsWorker();
    const worker = new Worker(workerUrl, { execArgv, workerData: { pipeName: name, journalDir: journals } });
    workers.push(worker);
    await new Promise<void>((done) => worker.on('message', (m: JournalPipeWorkerMessage) => m.type === 'listening' && done()));
    const script = harness(tag, name, [
      'Castcade_Init "killed", "A", "0.3.2", ""',
      'Dim i, was',
      `For i = 1 To ${n}`,
      '    was = Castcade_OnPipe',
      '    Castcade_Event "n", """i"":" & i',
      '    If was And Not Castcade_OnPipe Then WScript.Echo "failover " & i',
      ...(paceMs > 0 ? [`    WScript.Sleep ${paceMs}`] : []),
      'Next',
      'Castcade_Exit',
    ]);
    const done = run(script, local);
    const file = join(journals, 'killed.jsonl');
    const deadline = Date.now() + 20_000;
    while (!(existsSync(file) && lines(file).length >= killAt)) {
      if (Date.now() > deadline) throw new Error(`the worker wrote no ${killAt} lines`);
      await sleep(3);
    }
    await sleep(phaseMs);
    await worker.terminate();
    const { code, out } = await done;
    expect(code).toBe(0);
    const failover = Number(/failover (\d+)/.exec(out)?.[1]);
    const events = lines(file).map((l) => JSON.parse(l) as { event: string; i?: number });
    const got = events.filter((e) => e.event === 'n').map((e) => e.i!);
    const lost = Array.from({ length: n }, (_, k) => k + 1).filter((i) => !got.includes(i));
    // In order and nothing twice; table_loaded first; table_exit last, counting every line the hook wrote (lost ones too).
    expect(got).toEqual([...new Set(got)].sort((a, b) => a - b));
    expect(events[0]?.event).toBe('table_loaded');
    expect(events.at(-1)).toMatchObject({ event: 'table_exit', lines: n + 1 });
    // The failing line and every later one went to the file.
    expect(failover).toBeGreaterThan(1);
    expect(got.filter((i) => i >= failover)).toEqual(Array.from({ length: n - failover + 1 }, (_, k) => failover + k));
    // What can be lost: the lines the hook had handed to the pipe that the worker had not appended when it died, which
    // are one run right before the failing line.
    expect(lost).toEqual(Array.from({ length: lost.length }, (_, k) => failover - lost.length + k));
    return { failover, lost };
  };

  it('the companion killed mid-game: the failing line and every later one are in the file; only the lines in transit at the kill are lost', async () => {
    // At a game's pace (a line every 25 ms; a table writes a few per score change), killed at three points between two
    // lines: at most the one line in transit.
    for (const phase of [0, 9, 18]) {
      const { lost } = await killedRun(`killed-paced-${phase}`, 60, 25, 25, phase);
      expect(lost.length).toBeLessThanOrEqual(1);
    }
    // A burst (the hook writing as fast as it can, thousands of lines a second): at most what the pipe's buffer (64 KB)
    // and the worker's last read (64 KB) held.
    const { lost } = await killedRun('killed-burst', 8000, 0, 3000, 0);
    expect(lost.reduce((bytes, i) => bytes + `{"event":"n","t":0.000,"i":${i}}\r\n`.length, 0)).toBeLessThan(128 * 1024);
  }, 120_000);

  /** A hook that writes `n` lines of about 1 KB as fast as it can, timing each, then says how long the slowest took and when it was done. */
  const bulk = (name: string, pipe: string, table: string, n: number): string =>
    harness(name, pipe, [
      `Castcade_Init ${vbs(table)}, "A", "0.3.2", ""`,
      'Dim i, a, d, worst, pad : worst = 0 : pad = String(1000, "x")',
      `For i = 1 To ${n}`,
      '    a = Timer',
      '    Castcade_Event "n", """i"":" & i & ",""pad"":""" & pad & """"',
      '    d = Timer - a : If d > worst Then worst = d',
      'Next',
      'WScript.Echo "worst " & Round(worst * 1000) & " end " & Replace(CStr(Timer), ",", ".") & " pipe " & Castcade_OnPipe',
      'Castcade_Exit',
    ]);
  const bulkResult = (out: string): { worstMs: number; end: number; onPipe: boolean } => {
    const m = /worst (\d+) end ([\d.]+) pipe (\w+)/.exec(out);
    if (!m) throw new Error(`no result line: ${out}`);
    return { worstMs: Number(m[1]), end: Number(m[2]), onPipe: m[3] === 'True' };
  };
  const indices = (path: string): number[] => lines(path).flatMap((l) => ((JSON.parse(l) as { i?: number }).i !== undefined ? [(JSON.parse(l) as { i: number }).i] : []));
  const upTo = (n: number): number[] => Array.from({ length: n }, (_, k) => k + 1);

  it('a blocked main thread does not hold the hook up: 300 KB go through the pipe while this thread sleeps 6 s, and no WriteLine waited', async () => {
    const { local, journals } = localAppData('blocked');
    const w = pipeFor(journals, 'blocked');
    expect(await w.pipe.ready(15_000)).toBe(true);
    const done = run(bulk('blocked', w.pipe.pipeName, 'blocked', 300), local);
    // The thread the worker reports to sleeps; only the worker drains the pipe. A drain that needed this thread would
    // block the hook's WriteLine once about 124 KB were unread, until this thread woke.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_000);
    const now = new Date();
    const woke = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
    const { code, out } = await done;
    expect(code).toBe(0);
    const r = bulkResult(out);
    expect(r.onPipe).toBe(true);
    expect(r.worstMs).toBeLessThan(250);
    // The hook (VBScript's Timer: seconds since local midnight) was done before this thread woke.
    let ahead = woke - r.end;
    if (ahead < -43_200) ahead += 86_400;
    expect(ahead).toBeGreaterThan(0);
    await w.until(() => w.closed().length === 1);
    expect(w.closed()[0]).toMatchObject({ name: 'blocked.jsonl', lines: 302, dropped: 0 });
    expect(indices(join(journals, 'blocked.jsonl'))).toEqual(upTo(300));
  }, 60_000);

  it('a slow disk does not reach the hook: the first write stalls 3 s, every WriteLine returns at once, the lines land in order after it', async () => {
    const { local, journals } = localAppData('slow-disk');
    const w = pipeFor(journals, 'slow', { entry: './journal-pipe-test-worker.test-support.ts', workerData: { stallMs: 3_000, stallWrites: 1 } });
    expect(await w.pipe.ready(15_000)).toBe(true);
    const { code, out } = await run(bulk('slow-disk', w.pipe.pipeName, 'slow disk', 300), local);
    const exitedAt = Date.now();
    expect(code).toBe(0);
    const r = bulkResult(out);
    expect(r.onPipe).toBe(true);
    expect(r.worstMs).toBeLessThan(250);
    // The hook wrote its 300 KB and exited while the first write (table_loaded) was still stalled.
    const stall = w.timed.find((t) => t.m.type === 'note' && t.m.detail === 'test: write 1 stalls 3000 ms');
    expect(stall).toBeDefined();
    expect(exitedAt - stall!.at).toBeLessThan(3_000);
    expect(w.closed()).toEqual([]);
    await w.until(() => w.closed().length === 1, 15_000);
    expect(w.closed()[0]).toMatchObject({ name: 'slow_disk.jsonl', lines: 302, dropped: 0 });
    expect(JSON.parse(lines(join(journals, 'slow_disk.jsonl'))[0]!)).toMatchObject({ event: 'table_loaded', lib: '0.6.0' });
    expect(indices(join(journals, 'slow_disk.jsonl'))).toEqual(upTo(300));
  }, 60_000);

  it('two tables at once: two hooks on the pipe together, each journal with its own lines in order', async () => {
    const { local, journals } = localAppData('two-tables');
    const w = pipeFor(journals, 'two');
    expect(await w.pipe.ready(15_000)).toBe(true);
    const paced = (table: string): string =>
      harness(`two-${table}`, w.pipe.pipeName, [`Castcade_Init ${vbs(table)}, "A", "0.3.2", ""`, 'Dim i', 'For i = 1 To 40', '    Castcade_Event "n", """i"":" & i', '    WScript.Sleep 10', 'Next', 'Castcade_Exit']);
    const [a, b] = await Promise.all([run(paced('table a'), local), run(paced('table b'), local)]);
    expect([a.code, b.code]).toEqual([0, 0]);
    await w.until(() => w.closed().length === 2);
    const kinds = w.messages.filter((m) => m.type === 'opened' || m.type === 'closed').map((m) => m.type);
    expect(kinds).toEqual(['opened', 'opened', 'closed', 'closed']);
    for (const f of ['table_a.jsonl', 'table_b.jsonl']) expect(indices(join(journals, f))).toEqual(upTo(40));
  }, 60_000);

  it('the exit drain with the real hook: its process is gone while its last lines wait for the disk; drain() resolves once they are in the file', async () => {
    const { local, journals } = localAppData('exit-drain');
    const w = pipeFor(journals, 'exit-drain', { entry: './journal-pipe-test-worker.test-support.ts', workerData: { stallMs: 1_500, stallWrites: 1 } });
    expect(await w.pipe.ready(15_000)).toBe(true);
    const script = harness('exit-drain', w.pipe.pipeName, [
      'Castcade_Init "exit drain", "A", "0.3.2", ""',
      'Castcade_GameStart 1',
      'Castcade_Scores Array(1000), 1, 1',
      'Castcade_BallEnd 1, 3, 0',
      'Castcade_GameEnd Array(1000), 1',
      'Castcade_Exit',
    ]);
    expect((await run(script, local)).code).toBe(0);
    const file = join(journals, 'exit_drain.jsonl');
    expect(existsSync(file) && lines(file).some((l) => l.includes('table_exit'))).toBe(false);
    expect(await w.pipe.drain(file)).toBe(true);
    expect(lines(file).map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(['table_loaded', 'game_start', 'current_scores', 'ball_end', 'game_end', 'table_exit']);
  }, 60_000);
});

