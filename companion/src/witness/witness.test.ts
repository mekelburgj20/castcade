import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import type { FetchLike } from './arcaid-client.js';
import { MemoryFs } from './fs.js';
import { readJournalLines, replayJournal } from './journal-replay.js';
import { createMapCorpus } from './maps.js';
import { createStaticRegistry, NVRAM_DIRECTORY_VALUE, VPM_GLOBALS_KEY } from './nvram-dir.js';
import type { ProcessInfo } from './process-watch.js';
import type { LastCapture, WitnessSettings, WitnessStatus } from './types.js';
import { createWitness, outcomeForWire, resolveTableName, type WitnessDeps } from './witness.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const corpus = createMapCorpus(repo('fixtures/maps'));

const MM_TABLE = 'Medieval Madness (Williams 1997) VPW v1.0.1';
/** What ArcAid is sent: the name cut after the manufacturer/year parenthetical (catalogueTableName). */
const MM_WIRE = 'Medieval Madness (Williams 1997)';
const MM_CMD = `"C:\\VPX\\VPinballX64.exe" -Play "C:\\Tables\\${MM_TABLE}.vpx" -Minimized`;
const EXE = 'C:\\VPX\\VPinballX64.exe';
const GL_EXE = 'C:\\VPX\\VPinballX_GL64.exe';
/** What a VR/editor launch looks like on the owner's rig: the quoted exe and a trailing space. */
const GL_CMD = `"${GL_EXE}" `;
const MB_TITLE = 'Visual Pinball - [Monster Bash (Williams 1998) VPWmod v1.0]';
const MB_TABLE = 'Monster Bash (Williams 1998) VPWmod v1.0';
const MB_WIRE = 'Monster Bash (Williams 1998)';

/** The MM fixture's final NVRAM (last game 1,089,510, one player, game over). */
let mmAfter: Uint8Array;
/** The same NVRAM as it would have been before that game: player 1 at 277,500 (the first game's total). */
let mmBefore: Uint8Array;
/** A two-player variant: player 2 at 123,450 and player_count 2. */
let mmTwoPlayers: Uint8Array;
/** A later one-player game: 500,000. */
let mmThird: Uint8Array;

beforeAll(async () => {
  const journal = replayJournal(readJournalLines(repo('fixtures/nvram/mm_109c/2026-10-17-1.jsonl.gz')));
  if (!journal.buffer) throw new Error('fixture has no buffer');
  mmAfter = journal.buffer;
  mmBefore = Uint8Array.from(mmAfter);
  mmBefore.set([0x00, 0x00, 0x27, 0x75, 0x00], 5792); // bcd 277500
  mmTwoPlayers = Uint8Array.from(mmAfter);
  mmTwoPlayers.set([0x00, 0x00, 0x12, 0x34, 0x50], 5798); // player 2: 123450
  mmTwoPlayers[5901] = 2;
  mmThird = Uint8Array.from(mmAfter);
  mmThird.set([0x00, 0x00, 0x50, 0x00, 0x00], 5792); // bcd 500000
  // Warm the shared corpus so the end-to-end flows below are driven by the manual clock alone.
  await corpus.mapFor('mm_109c');
  await corpus.romName('mm_109c');
});

interface Call {
  path: string;
  params: Record<string, string>;
  token: string | undefined;
}

function harness(settingsPatch: Partial<WitnessSettings> = {}, depsPatch: Partial<WitnessDeps> = {}) {
  const clock = new ManualClock(1_760_000_000_000);
  const fs = new MemoryFs(() => clock.now());
  const settings: WitnessSettings = {
    arcaidBaseUrl: 'https://arcaid.test',
    deviceId: 'dev-1',
    deviceLabel: 'OWNER-PC',
    token: 'tok',
    mapsDir: repo('fixtures/maps'),
    nvramDir: '/nv',
    dataDir: '/data',
    ...settingsPatch,
  };
  const store = {
    get: () => ({ ...settings }),
    set: async (patch: Partial<WitnessSettings>) => {
      Object.assign(settings, patch);
    },
  };
  let procs: ProcessInfo[] = [];
  const calls: Call[] = [];
  let respond: (path: string, params: Record<string, string>) => { status: number; body?: unknown } | Error = (path) =>
    path.endsWith('/score') ? { status: 200, body: { ok: true, status: 'ingested', game: 'Medieval Madness' } } : { status: 200, body: { ok: true } };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const params = Object.fromEntries(url.searchParams);
    calls.push({ path: url.pathname, params, token: init.headers['x-witness-token'] });
    const r = respond(url.pathname, params);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  const statuses: WitnessStatus[] = [];
  const captures: LastCapture[] = [];
  const launches: { table: string | null; pid: number }[] = [];
  const exits: { table: string | null; durationSec: number }[] = [];
  const errors: string[] = [];
  const witness = createWitness(store, {
    clock,
    fs,
    fetch,
    corpus,
    lister: { list: async () => procs.map((p) => ({ ...p })) },
    registry: createStaticRegistry({}),
    pollIntervalMs: 2000,
    heartbeatIntervalMs: 120_000,
    ...depsPatch,
  });
  witness.on('status', (s) => statuses.push(s));
  witness.on('capture', (c) => captures.push(c));
  witness.on('launch', (l) => launches.push({ table: l.table, pid: l.pid }));
  witness.on('exit', (e) => exits.push({ table: e.table, durationSec: e.durationSec }));
  witness.on('error', (m) => errors.push(m));

  /** Let every pending promise chain run (microtasks and one macrotask turn per round). */
  const flush = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((r) => setImmediate(r));
      if (i % 2 === 1) await new Promise<void>((r) => setTimeout(r, 0));
    }
  };
  const paths = (suffix: string) => calls.filter((c) => c.path.endsWith(suffix));
  return {
    clock,
    fs,
    settings,
    witness,
    calls,
    statuses,
    captures,
    launches,
    exits,
    errors,
    flush,
    paths,
    setRespond(fn: typeof respond) {
      respond = fn;
    },
    /** The process appears; the next poll (2 s) sees it. */
    async launch(commandLine = MM_CMD, pid = 10, extra: Partial<ProcessInfo> = {}) {
      await flush();
      procs = [{ pid, exe: EXE, commandLine, startedAt: null, windowTitle: null, ...extra }];
      clock.advance(2000);
      await flush();
    },
    setTitle(title: string | null) {
      for (const p of procs) p.windowTitle = title;
    },
    /** One poll interval. */
    async poll() {
      await flush();
      clock.advance(2000);
      await flush();
    },
    async playFor(ms: number) {
      await flush();
      clock.advance(ms);
      await flush();
    },
    /** Walk the clock forward in 1 s steps so the alive nvram poll and the settle window run. */
    async settle(ms: number) {
      for (let t = 0; t < ms; t += 1000) {
        // Only in-memory work happens here (the corpus is warm), so microtask rounds suffice.
        for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
        clock.advance(1000);
      }
      await flush();
    },
    /** The process is gone; the next poll (2 s) notices. */
    async exit() {
      await flush();
      procs = [];
      clock.advance(2000);
      await flush();
    },
  };
}

describe('createWitness: -Play sessions (capture at exit)', () => {
  it('heartbeats on start, snapshots at launch, posts report + score on exit for a one-player game', async () => {
    const h = harness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.fs.put('/nv/tftc_400.nv', Uint8Array.from([0]));

    await h.witness.start();
    await h.flush();
    expect(h.witness.status()).toMatchObject({ running: true, paired: true, nvramDir: '/nv', mapsVersion: 'f16a0cc6c347370706bf1a3f2c7a77568b3f69e7', lastError: null });
    expect(h.calls.map((c) => c.path)).toEqual(['/api/witness/heartbeat']);
    expect(h.calls[0]?.token).toBe('tok');
    expect(h.witness.status().lastHeartbeatAt).toBe(new Date(h.clock.now()).toISOString());

    await h.launch();
    const launchedAt = h.clock.now();
    expect(h.launches).toEqual([{ table: MM_TABLE, pid: 10 }]);
    expect(h.witness.status()).toMatchObject({ currentTable: MM_TABLE, vpxExe: EXE, note: null });

    await h.playFor(300_000);
    // VPinMAME rewrites the .nv as the table closes, then the process disappears
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    const ended = h.clock.now(); // the .nv mtime is the game's end
    await h.exit();
    const exitedAt = h.clock.now();
    const dur = Math.round((ended - launchedAt) / 1000);

    expect(h.exits).toEqual([{ table: MM_TABLE, durationSec: Math.round((exitedAt - launchedAt) / 1000) }]);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({
      table: MM_TABLE,
      rom: 'mm_109c',
      players: 1,
      score: 1089510,
      launchedAt: new Date(launchedAt).toISOString(),
      exitedAt: new Date(ended).toISOString(),
      outcome: 'ingested',
    });
    expect(h.captures[0]?.detail).toMatch(/table from -Play/);
    expect(h.captures[0]?.detail).toMatch(/captured at VPX exit/);
    expect(h.witness.status()).toMatchObject({ currentTable: null, lastCapture: h.captures[0], queued: 0, lastError: null, note: null });

    const posts = h.calls.filter((c) => !c.path.endsWith('/heartbeat'));
    expect(posts.map((c) => c.path)).toEqual(['/api/witness/report', '/api/witness/score']);
    for (const p of posts) expect(p.token).toBe('tok');
    expect(posts[0]?.params).toEqual({
      device: 'dev-1',
      table: MM_WIRE,
      launch: String(Math.floor(launchedAt / 1000)),
      exit: String(Math.floor(ended / 1000)),
      dur: String(dur),
    });
    expect(posts[1]?.params).toEqual({
      device: 'dev-1',
      table: MM_WIRE,
      rom: 'mm_109c',
      slug: 'Medieval Madness', // the ROM's catalogue name (romnames.json) as the fallback key
      score: '1089510',
      started: String(Math.floor(launchedAt / 1000)),
      ended: String(Math.floor(ended / 1000)),
      dur: String(dur),
      reason: 'exit_sample',
    });
    expect(h.errors).toEqual([]);

    // heartbeats keep going on their interval (one at start, one 120 s into the 300 s session, ...)
    const beats = () => h.paths('/heartbeat').length;
    expect(beats()).toBe(2);
    h.clock.advance(120_000);
    await h.flush();
    expect(beats()).toBe(3);

    await h.witness.stop();
    expect(h.witness.status().running).toBe(false);
    h.clock.advance(1_000_000);
    await h.flush();
    expect(beats()).toBe(3);
  });

  it('skips a two-player game whole (report still posted), and an unchanged .nv as no new game', async () => {
    const h = harness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    await h.witness.start();
    await h.launch();
    await h.playFor(100_000);
    h.fs.put('/nv/mm_109c.nv', mmTwoPlayers);
    await h.exit();
    expect(h.captures[0]).toMatchObject({ outcome: 'skipped', players: 2, score: 1089510, rom: 'mm_109c', detail: expect.stringMatching(/multi-player/) });
    expect(h.paths('/score')).toHaveLength(0);
    expect(h.paths('/report')).toHaveLength(1);

    // next session: VPinMAME rewrites the file (new mtime) but nobody played
    await h.launch(MM_CMD, 11);
    await h.playFor(100_000);
    h.fs.put('/nv/mm_109c.nv', mmTwoPlayers);
    await h.exit();
    expect(h.captures[1]).toMatchObject({ outcome: 'skipped', detail: expect.stringMatching(/no new game/) });
    expect(h.paths('/report')).toHaveLength(2);
  });

  it('skips when no .nv changed (original table) and when the ROM has no map', async () => {
    const h = harness({}, { nvSettleMs: 0 });
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    await h.witness.start();
    await h.launch('"C:\\VPX\\VPinballX64.exe" -Play "C:\\t\\Iron Maiden LOTB (Original 2020).vpx"');
    await h.playFor(60_000);
    await h.exit();
    expect(h.captures[0]).toMatchObject({ table: 'Iron Maiden LOTB (Original 2020)', rom: null, outcome: 'skipped', detail: expect.stringMatching(/no \.nv changed/) });

    await h.launch('"C:\\VPX\\VPinballX64.exe" -Play "C:\\t\\Mystery.vpx"', 12);
    await h.playFor(60_000);
    h.fs.put('/nv/zzz_999.nv', mmAfter);
    await h.exit();
    expect(h.captures).toHaveLength(2);
    expect(h.captures[1]).toMatchObject({ table: 'Mystery', rom: 'zzz_999', outcome: 'skipped', detail: expect.stringMatching(/no map for ROM zzz_999/) });
  });

  it('a 401 marks the capture rejected and the device "unpaired by ArcAid" but keeps the token', async () => {
    const h = harness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.setRespond(() => ({ status: 401, body: { ok: false } }));
    await h.witness.start();
    await h.launch();
    await h.playFor(60_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.exit();
    expect(h.captures[0]).toMatchObject({ outcome: 'rejected', score: 1089510, detail: expect.stringMatching(/unpaired by ArcAid/) });
    expect(h.witness.status().lastError).toBe('unpaired by ArcAid');
    expect(h.settings.token).toBe('tok');
    expect(h.witness.status().paired).toBe(true);
  });

  it('queues when ArcAid is unreachable and upgrades the capture when the retry lands', async () => {
    const h = harness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.setRespond(() => new TypeError('fetch failed'));
    await h.witness.start();
    await h.launch();
    await h.playFor(60_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.exit();
    expect(h.captures[0]).toMatchObject({ outcome: 'queued', score: 1089510 });
    expect(h.witness.status().queued).toBe(2); // report + score
    expect(h.fs.has('/data/witness-queue.jsonl')).toBe(true);

    h.setRespond((path) => (path.endsWith('/score') ? { status: 200, body: { ok: true, status: 'global' } } : { status: 200, body: { ok: true } }));
    h.clock.advance(5000);
    await h.flush();
    expect(h.witness.status().queued).toBe(0);
    expect(h.captures).toHaveLength(2);
    expect(h.captures[1]).toMatchObject({ outcome: 'ingested', detail: expect.stringMatching(/Global Scoreboard/) });
    expect(h.witness.status().lastCapture?.outcome).toBe('ingested');
    expect(h.fs.has('/data/witness-queue.jsonl')).toBe(false);
  });

  it('pairs with a code (type=desktop), stores the token, then heartbeats; unpair forgets it', async () => {
    const h = harness({ token: null });
    await h.fs.mkdir('/nv');
    h.setRespond((path) => (path.endsWith('/pair') ? { status: 200, body: { ok: true, token: 'tok_new' } } : { status: 200, body: { ok: true } }));
    await h.witness.start();
    await h.flush();
    expect(h.calls).toHaveLength(0); // unpaired: no heartbeat
    expect(h.witness.status().paired).toBe(false);

    await h.witness.pair('abc234');
    await h.flush();
    expect(h.settings.token).toBe('tok_new');
    expect(h.witness.status().paired).toBe(true);
    expect(h.calls[0]).toMatchObject({ path: '/api/witness/pair', params: { code: 'ABC234', device: 'dev-1', username: 'OWNER-PC', type: 'desktop' }, token: undefined });
    expect(h.calls[1]).toMatchObject({ path: '/api/witness/heartbeat', token: 'tok_new' });

    await h.witness.unpair();
    expect(h.settings.token).toBeNull();
    expect(h.witness.status().paired).toBe(false);
    h.clock.advance(120_000);
    await h.flush();
    expect(h.paths('/heartbeat')).toHaveLength(1);
  });

  it('rejects a bad pairing code with the server message and posts nothing while unpaired', async () => {
    const h = harness({ token: null });
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.setRespond((path) => (path.endsWith('/pair') ? { status: 400, body: { ok: false, error: 'That pairing code is not valid', code: 'CODE_INVALID' } } : { status: 200 }));
    await h.witness.start();
    await expect(h.witness.pair('nope')).rejects.toThrow('That pairing code is not valid');
    expect(h.witness.status().lastError).toMatch(/pairing failed: That pairing code is not valid/);

    await h.launch();
    await h.playFor(60_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.exit();
    expect(h.captures[0]).toMatchObject({ outcome: 'skipped', score: 1089510, detail: expect.stringMatching(/not paired with ArcAid/) });
    expect(h.calls.filter((c) => c.path.endsWith('/report') || c.path.endsWith('/score'))).toHaveLength(0);
  });

  it('resolves the nvram dir from the registry when there is no override', async () => {
    const registry = createStaticRegistry({ [`${VPM_GLOBALS_KEY}\\${NVRAM_DIRECTORY_VALUE}`.toLowerCase()]: 'C:\\VPM\\nvram' });
    const h = harness({ nvramDir: null }, { registry });
    await h.fs.mkdir('C:\\VPM\\nvram');
    await h.witness.start();
    expect(h.witness.status().nvramDir).toBe('C:\\VPM\\nvram');

    const none = harness({ nvramDir: null });
    await none.witness.start();
    expect(none.witness.status().nvramDir).toBeNull();
    await none.launch();
    await none.playFor(60_000);
    await none.exit();
    expect(none.captures[0]).toMatchObject({ outcome: 'skipped', detail: expect.stringMatching(/nvram directory not found/) });
  });

  it('maps ArcAid wire statuses onto capture outcomes', () => {
    expect(outcomeForWire('ingested').outcome).toBe('ingested');
    expect(outcomeForWire('global').outcome).toBe('ingested');
    expect(outcomeForWire('duplicate').outcome).toBe('duplicate');
    expect(outcomeForWire('global_duplicate').outcome).toBe('duplicate');
    expect(outcomeForWire('no_match').outcome).toBe('skipped');
    expect(outcomeForWire('invalid').outcome).toBe('rejected');
    expect(outcomeForWire(null).outcome).toBe('ingested');
  });
});

describe('createWitness: editor-driven sessions (capture while VPX stays open)', () => {
  it("the owner's case: VR build without -Play, table loaded from the editor, two games, exit from the editor", async () => {
    const h = harness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    await h.witness.start();

    // VPX has been open for an hour when the companion first sees it (process creation from CIM).
    const procStart = h.clock.now() - 3_600_000;
    await h.launch(GL_CMD, 22548, { exe: GL_EXE, startedAt: procStart, windowTitle: 'Visual Pinball' });
    expect(h.launches).toEqual([{ table: null, pid: 22548 }]);
    expect(h.witness.status()).toMatchObject({ currentTable: null, note: 'VPX is open; no table known yet', vpxExe: GL_EXE });

    h.setTitle(MB_TITLE);
    await h.poll();
    expect(h.witness.status()).toMatchObject({ currentTable: MB_TABLE, note: null });

    // Player up (in-process), a game is played, the player closes: VPinMAME rewrites the .nv.
    h.setTitle('Visual Pinball Player');
    await h.poll();
    await h.playFor(120_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    const ended1 = h.clock.now();
    h.setTitle(MB_TITLE);
    await h.settle(12_000); // alive poll (3 s) notices, settle window (5 s) passes

    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({
      table: MB_TABLE,
      rom: 'mm_109c',
      players: 1,
      score: 1089510,
      launchedAt: new Date(procStart).toISOString(),
      exitedAt: new Date(ended1).toISOString(),
      outcome: 'ingested',
    });
    expect(h.captures[0]?.detail).toMatch(/table from the editor window title/);
    expect(h.captures[0]?.detail).toMatch(/captured when the player closed/);
    expect(h.paths('/report')[0]?.params).toMatchObject({ table: MB_WIRE, launch: String(Math.floor(procStart / 1000)), exit: String(Math.floor(ended1 / 1000)) });
    expect(h.paths('/score')[0]?.params).toMatchObject({
      table: MB_WIRE,
      rom: 'mm_109c',
      score: '1089510',
      started: String(Math.floor(procStart / 1000)),
      ended: String(Math.floor(ended1 / 1000)),
      reason: 'exit_sample',
    });
    expect(h.witness.status()).toMatchObject({ currentTable: MB_TABLE, note: null }); // still open in the editor

    // Nothing more happens while the editor idles.
    await h.settle(30_000);
    expect(h.captures).toHaveLength(1);

    // Second player session on the same table: started = the previous capture.
    h.setTitle('Visual Pinball Player');
    await h.poll();
    await h.playFor(90_000);
    h.fs.put('/nv/mm_109c.nv', mmThird);
    const ended2 = h.clock.now();
    h.setTitle(MB_TITLE);
    await h.settle(12_000);
    expect(h.captures).toHaveLength(2);
    expect(h.captures[1]).toMatchObject({
      score: 500000,
      launchedAt: new Date(ended1).toISOString(),
      exitedAt: new Date(ended2).toISOString(),
      outcome: 'ingested',
    });
    expect(h.paths('/score')[1]?.params).toMatchObject({ started: String(Math.floor(ended1 / 1000)), ended: String(Math.floor(ended2 / 1000)) });

    // Quit VPX from the editor: exit event, no third capture, nothing more posted.
    await h.exit();
    await h.settle(10_000);
    expect(h.exits).toEqual([{ table: MB_TABLE, durationSec: expect.any(Number) }]);
    expect(h.captures).toHaveLength(2);
    expect(h.paths('/score')).toHaveLength(2);
    expect(h.paths('/report')).toHaveLength(2);
    expect(h.witness.status()).toMatchObject({ currentTable: null, note: null });
    expect(h.errors).toEqual([]);
  });

  it('a game captured while alive is not captured again at exit; exiting inside the settle window captures once', async () => {
    const h = harness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    await h.witness.start();
    await h.launch(GL_CMD, 30, { exe: GL_EXE, windowTitle: MB_TITLE });
    await h.playFor(60_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.settle(3_000); // the alive poll has seen the change, the settle window is open
    expect(h.captures).toHaveLength(0);
    await h.exit(); // ... and VPX quits before it closes
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({ score: 1089510, outcome: 'ingested', detail: expect.stringMatching(/captured at VPX exit/) });
    await h.settle(15_000);
    expect(h.captures).toHaveLength(1);
    expect(h.paths('/score')).toHaveLength(1);
  });

  it('names the table from the ROM when neither the command line nor the title said', async () => {
    const h = harness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    await h.witness.start();
    await h.launch(GL_CMD, 31, { exe: GL_EXE, windowTitle: 'Visual Pinball' });
    h.setTitle('Visual Pinball Player');
    await h.poll();
    await h.playFor(60_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    h.setTitle('Visual Pinball');
    await h.settle(12_000);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({ table: 'Medieval Madness', rom: 'mm_109c', score: 1089510, outcome: 'ingested' });
    expect(h.captures[0]?.detail).toMatch(/derived from the ROM/);
    expect(h.paths('/score')[0]?.params).toMatchObject({ table: 'Medieval Madness', rom: 'mm_109c' });

    // An editor exit with nothing new and no table name produces an exit event and no capture.
    await h.exit();
    expect(h.exits).toEqual([{ table: null, durationSec: expect.any(Number) }]);
    expect(h.captures).toHaveLength(1);
  });

  it('a file-association launch takes the table from the positional .vpx', async () => {
    const h = harness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    await h.witness.start();
    await h.launch(`"${EXE}" "C:\\Tables\\${MM_TABLE}.vpx"`, 32, { windowTitle: 'Visual Pinball - [Other Name]' });
    expect(h.launches).toEqual([{ table: MM_TABLE, pid: 32 }]);
    await h.playFor(60_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.exit();
    expect(h.captures[0]).toMatchObject({ table: MM_TABLE, outcome: 'ingested', detail: expect.stringMatching(/table from the command line/) });
  });

  it('resolveTableName follows the documented priority', () => {
    expect(resolveTableName({ table: 'From Title', tableSource: 'title' }, 'Monster Bash', 'mb_106b')).toEqual({ table: 'From Title', source: 'title' });
    expect(resolveTableName({ table: null, tableSource: null }, 'Monster Bash', 'mb_106b')).toEqual({ table: 'Monster Bash', source: 'romname' });
    expect(resolveTableName({ table: null, tableSource: null }, null, 'mb_106b')).toEqual({ table: 'mb_106b', source: 'rom' });
    expect(resolveTableName({ table: null, tableSource: null }, null, null)).toBeNull();
  });
});
