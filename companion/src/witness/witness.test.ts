import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import type { FetchLike } from './arcaid-client.js';
import { MemoryFs } from './fs.js';
import { readJournalLines, replayJournal } from './journal-replay.js';
import { createMapCorpus } from './maps.js';
import { createStaticRegistry, NVRAM_DIRECTORY_VALUE, VPM_GLOBALS_KEY } from './nvram-dir.js';
import type { ProcessInfo } from './process-watch.js';
import { buildOwnerStyleVpx } from './synth-vpx.test-support.js';
import type { LastCapture, WitnessSettings, WitnessStatus } from './types.js';
import { createVpsIndex } from './vps-index.js';
import { createWitness, outcomeForWire, resolveTableName, type WitnessDeps } from './witness.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const corpus = createMapCorpus(repo('fixtures/maps'));
const vpsIndex = createVpsIndex(repo('fixtures/vps'));

const MM_TABLE = 'Medieval Madness (Williams 1997) VPW v1.0.1';
const MM_PATH = `C:\\Tables\\${MM_TABLE}.vpx`;
/** A synthetic table file with the owner's MM TableInfo (VPW 1.1 in the file, v1.0.1 in the name, like the real one). */
const MM_VPX = buildOwnerStyleVpx({ tableName: 'Medieval Madness (Williams 1997)', author: 'VPW', version: '1.0.1', saveRev: '946' }, 6.5, { difficulty: 0.5, overridePhysics: 0, overrideFlippers: false });
/** Stand-ins for the binaries: no version resource, so only the hash and "not a known build" are attested. */
const EXE_BYTES = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) & 0xff);
const DLL_BYTES = Uint8Array.from({ length: 2048 }, (_, i) => (i * 13 + 1) & 0xff);
const DLL_PATH = 'C:\\VPX\\VPinMAME\\VPinMAME64.dll';
/** The owner's portable ini, cut to the keys that matter: no override in use, nudge strength set. */
const MAIN_INI = '[Player]\nNudgeStrength = 0.000800\nEnableLegacyNudge = 0\nPhysicsSetName0 = Mousing Around\nTablePhysicsMinSlope0 = 5.5\nTablePhysicsMaxSlope0 = 6\n';
/** The player raised the difficulty in the tweak menu, and set one table option. */
const MM_TABLE_INI = '[TableOverride]\nDifficulty = 0.750000\n[TableOption]\nOutlane Difficulty = 1.000000\n';
const RIG_REGISTRY = {
  'HKCR\\VPinMAME.Controller\\CLSID\\(Default)': '{F389C8B7-144F-4C63-A2E3-246D168F9D39}',
  'HKCR\\CLSID\\{F389C8B7-144F-4C63-A2E3-246D168F9D39}\\InprocServer32\\(Default)': DLL_PATH,
  'HKCU\\Software\\Freeware\\Visual PinMame\\mm_109c\\cheat': '0x1',
  'HKCU\\Software\\Freeware\\Visual PinMame\\default\\cheat': '0x0',
};
const MB_VPX = buildOwnerStyleVpx({ tableName: 'Monster Bash VPW Mod', author: 'VPW', version: '1.0', manufacturer: 'Williams', year: '1998' });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
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
/** ArcAid's P9b routing line as the check-in reply carries it. */
const SENDING_TO = 'Flippin Fear Fest / Flippin Fear Fest 26 · CHECKED IN · READY';

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
    vpsDir: repo('fixtures/vps'),
    tablesDir: null,
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
    path.endsWith('/score')
      ? { status: 200, body: { ok: true, status: 'ingested', game: 'Medieval Madness' } }
      : path.endsWith('/checkin')
        ? { status: 200, body: { ok: true, ts: '2026-10-18 12:00:00', sendingTo: SENDING_TO } }
        : { status: 200, body: { ok: true } };
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
    vpsIndex,
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
  it('heartbeats and checks in on start, opens the session at launch, closes it with the score on exit', async () => {
    const h = harness({}, { registry: createStaticRegistry(RIG_REGISTRY), env: {} });
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.fs.put('/nv/tftc_400.nv', Uint8Array.from([0]));
    h.fs.put(MM_PATH, MM_VPX);
    h.fs.put(EXE, EXE_BYTES);
    h.fs.put(DLL_PATH, DLL_BYTES);
    h.fs.put('C:\\VPX\\VPinballX.ini', new TextEncoder().encode(MAIN_INI));
    h.fs.put(`C:\\Tables\\${MM_TABLE}.ini`, new TextEncoder().encode(MM_TABLE_INI));

    await h.witness.start();
    await h.flush();
    expect(h.witness.status()).toMatchObject({ running: true, paired: true, nvramDir: '/nv', mapsVersion: 'f16a0cc6c347370706bf1a3f2c7a77568b3f69e7', lastError: null });
    expect(h.witness.status().vpsVersion).toMatch(/^[0-9a-f]{7,40}$/);
    // Idle at start: a heartbeat, then a check-in ("no table open here"), whose reply says where scores go.
    expect(h.calls.map((c) => c.path)).toEqual(['/api/witness/heartbeat', '/api/witness/checkin']);
    expect(h.calls[0]?.token).toBe('tok');
    expect(h.calls[1]).toMatchObject({ token: 'tok', params: { device: 'dev-1' } });
    expect(h.witness.status().lastHeartbeatAt).toBe(new Date(h.clock.now()).toISOString());
    expect(h.witness.status()).toMatchObject({ lastCheckinAt: new Date(h.clock.now()).toISOString(), sendingTo: SENDING_TO });

    await h.launch();
    const launchedAt = h.clock.now();
    expect(h.launches).toEqual([{ table: MM_TABLE, pid: 10 }]);
    expect(h.witness.status()).toMatchObject({ currentTable: MM_TABLE, vpxExe: EXE, note: null });
    // Identity from the -Play file: VPS game by name, the VPW table by TableInfo author + version, hash in the background.
    await h.flush();
    expect(h.witness.status().currentIdentity).toMatchObject({
      filePath: MM_PATH,
      vpsGame: { id: '-5yMpqSy', name: 'Medieval Madness' },
      vpsTable: { id: 'zbyQ01wi3L' },
      tableConfidence: 'exact',
      saveRev: 946,
      sha256: sha(MM_VPX),
      physics: { slopeMin: 6.5, slopeMax: 7.5, difficulty: 0.5, overridePhysicsSet: 0, overridePhysicsFlippers: false },
    });
    // Conditions measured with the identity: stock physics, the tweak-menu difficulty, the builds; the ROM-bound parts wait for capture.
    expect(h.witness.status().currentAttestation).toMatchObject({
      ini: {
        mainIni: 'C:\\VPX\\VPinballX.ini',
        tableIni: `C:\\Tables\\${MM_TABLE}.ini`,
        physicsSet: 0,
        stockPhysics: true,
        tableDifficulty: 0.5,
        difficultyOverride: 0.75,
        slope: { min: 6.5, max: 7.5, effective: 7.25 },
        tableOptions: { 'Outlane Difficulty': 1 },
      },
      build: { vpx: { path: EXE, sha256: sha(EXE_BYTES), known: null, version: null }, vpinmame: { path: DLL_PATH, sha256: sha(DLL_BYTES), known: null } },
      adjustments: null,
      vpmCheat: null,
      iniChanged: false,
    });

    await h.playFor(300_000);
    // A heartbeat went out during the game (120 s in); it did not check in (a table is open).
    expect(h.paths('/heartbeat')).toHaveLength(2);
    expect(h.paths('/checkin')).toHaveLength(1);
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

    const posts = h.calls.filter((c) => !c.path.endsWith('/heartbeat') && !c.path.endsWith('/checkin'));
    expect(posts.map((c) => c.path)).toEqual(['/api/witness/report', '/api/witness/report', '/api/witness/score']);
    for (const p of posts) expect(p.token).toBe('tok');
    // The launch report opens the session (no exit); the exit report closes it on the same key.
    expect(posts[0]?.params).toEqual({ device: 'dev-1', table: MM_WIRE, launch: String(Math.floor(launchedAt / 1000)) });
    expect(posts[1]?.params).toEqual({
      device: 'dev-1',
      table: MM_WIRE,
      launch: String(Math.floor(launchedAt / 1000)),
      exit: String(Math.floor(ended / 1000)),
      dur: String(dur),
    });
    const score = posts[2]?.params ?? {};
    expect(Object.keys(score).sort()).toEqual(['build', 'device', 'dur', 'ended', 'ini', 'reason', 'rom', 'score', 'slug', 'started', 'table', 'table_save_rev', 'table_sha256', 'vps_game', 'vps_table']);
    expect(score).toMatchObject({
      device: 'dev-1',
      table: MM_WIRE,
      rom: 'mm_109c',
      slug: 'Medieval Madness', // the ROM's catalogue name (romnames.json) as the fallback key
      score: '1089510',
      started: String(Math.floor(launchedAt / 1000)),
      ended: String(Math.floor(ended / 1000)),
      dur: String(dur),
      reason: 'exit_sample',
      vps_game: '-5yMpqSy',
      vps_table: 'zbyQ01wi3L',
      table_sha256: sha(MM_VPX),
      table_save_rev: '946',
    });
    // Attestation (F2) rides along as compact JSON; no `adjustments` because the MM map has no adjustments block.
    expect(JSON.parse(score['ini'] ?? 'null')).toEqual({
      set: 0,
      set_name: null,
      flippers: false,
      stock: true,
      difficulty: 0.5,
      difficulty_override: 0.75,
      slope: 7.25,
      nudge: 0.0008,
      legacy_nudge: false,
      nudge_filter: null,
      nudge_sensitivity: null,
      accel: null,
      accel_gain_x: null,
      accel_gain_y: null,
      accel_max_x: null,
      accel_max_y: null,
      accel_velocity: null,
      analog_gain_x: null,
      analog_gain_y: null,
      tilt_sens: 400,
      tilt_sens_set: false,
      options: { 'Outlane Difficulty': 1 },
      overrides: [],
      table_ini: true,
    });
    expect(JSON.parse(score['build'] ?? 'null')).toEqual({
      vpx: { sha256: sha(EXE_BYTES), version: null, known: null, family: 'unknown' },
      vpinmame: { sha256: sha(DLL_BYTES), version: null, known: null, family: 'unknown' },
      cheat: true,
    });
    expect(h.captures[0]?.identity).toMatchObject({ vpsGame: { id: '-5yMpqSy' }, vpsTable: { id: 'zbyQ01wi3L' }, gameSource: 'rom' });
    expect(h.captures[0]?.attestation).toMatchObject({ vpmCheat: true, adjustments: null, iniChanged: false, ini: { stockPhysics: true } });
    expect(h.captures[0]?.detail).toMatch(/VPS game Medieval Madness \(-5yMpqSy\), table VPW 1\.0\.1/);
    expect(h.captures[0]?.detail).toMatch(/stock physics, difficulty override 75%, slope 7\.25°, 1 table option; no adjustments map for this ROM; VPX [0-9a-f]{12} \(unrecognised build\); VPinMAME [0-9a-f]{12} \(unrecognised build\), cheat ON/);
    expect(h.errors).toEqual([]);

    // VPX gone: checked in again right after the capture, and on every heartbeat tick while idle.
    const beats = () => h.paths('/heartbeat').length;
    const checkins = () => h.paths('/checkin').length;
    expect(checkins()).toBe(2);
    expect(h.calls.at(-1)?.path).toBe('/api/witness/checkin');
    expect(h.calls.at(-2)?.path).toBe('/api/witness/score'); // after the posts, not before
    h.clock.advance(120_000);
    await h.flush();
    expect(beats()).toBe(3);
    expect(checkins()).toBe(3);

    await h.witness.stop();
    expect(h.witness.status().running).toBe(false);
    h.clock.advance(1_000_000);
    await h.flush();
    expect(beats()).toBe(3);
    expect(checkins()).toBe(3);
  });

  it('a check-in that fails is an error, not a crash; a 401 reads "unpaired by ArcAid"; VPX open suppresses it', async () => {
    const h = harness({}, { nvSettleMs: 0 });
    await h.fs.mkdir('/nv');
    h.setRespond((path) => (path.endsWith('/checkin') ? { status: 401, body: { ok: false } } : { status: 200, body: { ok: true } }));
    await h.witness.start();
    await h.flush();
    expect(h.paths('/checkin')).toHaveLength(1);
    expect(h.witness.status()).toMatchObject({ lastCheckinAt: null, sendingTo: null, lastError: 'unpaired by ArcAid' });

    // ArcAid recovers while a table is open: the next heartbeat clears the error but does not check in.
    h.setRespond((path) => (path.endsWith('/checkin') ? { status: 200, body: { ok: true, ts: 't', sendingTo: 'Room / T' } } : { status: 200, body: { ok: true } }));
    await h.launch();
    h.clock.advance(120_000);
    await h.flush();
    expect(h.paths('/checkin')).toHaveLength(1);
    expect(h.witness.status().lastError).toBeNull();

    // ... and checks in once the table is gone, with the routing line.
    await h.exit();
    expect(h.paths('/checkin')).toHaveLength(2);
    expect(h.witness.status()).toMatchObject({ sendingTo: 'Room / T', lastCheckinAt: new Date(h.clock.now()).toISOString() });
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
    expect(h.paths('/report')).toHaveLength(2); // launch + exit

    // next session: VPinMAME rewrites the file (new mtime) but nobody played
    await h.launch(MM_CMD, 11);
    await h.playFor(100_000);
    h.fs.put('/nv/mm_109c.nv', mmTwoPlayers);
    await h.exit();
    expect(h.captures[1]).toMatchObject({ outcome: 'skipped', detail: expect.stringMatching(/no new game/) });
    expect(h.paths('/report')).toHaveLength(4);
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
    expect(h.witness.status().queued).toBe(3); // launch report + exit report + score
    expect(h.fs.has('/data/witness-queue.jsonl')).toBe(true);

    h.setRespond((path) => (path.endsWith('/score') ? { status: 200, body: { ok: true, status: 'global' } } : { status: 200, body: { ok: true } }));
    // The launch report has been retrying since launch (backoff grown past 5 s); the cap is 10 min.
    h.clock.advance(10 * 60_000);
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
    expect(h.calls[2]).toMatchObject({ path: '/api/witness/checkin', token: 'tok_new' });
    // This server answered the check-in without a routing line: checked in, nothing to show.
    expect(h.witness.status()).toMatchObject({ sendingTo: null, lastCheckinAt: expect.any(String) });

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

  it('a Sanctioned refusal (ArcAid 2.165.0) is rejected with the reasons and says where the play went instead', () => {
    const held = outcomeForWire('not_sanctioned', { reasons: ['tilt sensitivity 10 is below the minimum 300'], fallback: 'global' });
    expect(held.outcome).toBe('rejected');
    expect(held.detail).toBe('ArcAid: not counted for the tournament (Sanctioned play): tilt sensitivity 10 is below the minimum 300; recorded on the Global Scoreboard instead');
    expect(outcomeForWire('not_sanctioned', { reasons: [], fallback: null }).detail).toBe('ArcAid: not counted for the tournament (Sanctioned play)');
  });
});

describe('createWitness: editor-driven sessions (capture while VPX stays open)', () => {
  it("the owner's case: VR build without -Play, table loaded from the editor, two games, exit from the editor", async () => {
    const h = harness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.fs.put(`C:\\VPX\\tables\\${MB_TABLE}.vpx`, MB_VPX);
    await h.witness.start();

    // VPX has been open for an hour when the companion first sees it (process creation from CIM).
    const procStart = h.clock.now() - 3_600_000;
    await h.launch(GL_CMD, 22548, { exe: GL_EXE, startedAt: procStart, windowTitle: 'Visual Pinball' });
    expect(h.launches).toEqual([{ table: null, pid: 22548 }]);
    expect(h.witness.status()).toMatchObject({ currentTable: null, note: 'VPX is open; no table known yet', vpxExe: GL_EXE });

    h.setTitle(MB_TITLE);
    await h.poll();
    expect(h.witness.status()).toMatchObject({ currentTable: MB_TABLE, note: null });
    // The editor title named the table; its file was found beside the exe and identified.
    expect(h.witness.status().currentIdentity).toMatchObject({
      filePath: `C:\\VPX\\tables\\${MB_TABLE}.vpx`,
      vpsGame: { id: 'F1Skyh5h', name: 'Monster Bash' },
      vpsTable: { id: 'rxmbAdBi', label: 'VPW 1.0 · MOD, VR, FSS' },
      tableConfidence: 'exact',
      saveRev: 7,
      sha256: sha(MB_VPX),
    });

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
    // The session opened in ArcAid when the editor title named the table, and closed with the capture.
    expect(h.paths('/report')[0]?.params).toEqual({ device: 'dev-1', table: MB_WIRE, launch: String(Math.floor(procStart / 1000)) });
    expect(h.paths('/report')[1]?.params).toMatchObject({ table: MB_WIRE, launch: String(Math.floor(procStart / 1000)), exit: String(Math.floor(ended1 / 1000)) });
    expect(h.paths('/report')).toHaveLength(2);
    expect(h.paths('/score')[0]?.params).toMatchObject({
      table: MB_WIRE,
      rom: 'mm_109c',
      score: '1089510',
      started: String(Math.floor(procStart / 1000)),
      ended: String(Math.floor(ended1 / 1000)),
      reason: 'exit_sample',
      // The fixture .nv is Medieval Madness's, so the ROM re-pins the game to MM while the file said Monster Bash:
      // the ROM wins (it is what actually ran), and the table is re-matched against MM's tables.
      vps_game: '-5yMpqSy',
      table_sha256: sha(MB_VPX),
      table_save_rev: '7',
    });
    expect(h.captures[0]?.identity).toMatchObject({ vpsGame: { id: '-5yMpqSy' }, gameSource: 'rom' });
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
    // The second player session was opened (player up again) on the key its capture then closed.
    expect(h.paths('/report')[2]?.params).toEqual({ device: 'dev-1', table: MB_WIRE, launch: String(Math.floor(ended1 / 1000)) });
    expect(h.paths('/report')[3]?.params).toMatchObject({ table: MB_WIRE, launch: String(Math.floor(ended1 / 1000)), exit: String(Math.floor(ended2 / 1000)) });
    // No check-in while VPX has been open (only the one at start).
    expect(h.paths('/checkin')).toHaveLength(1);

    // Quit VPX from the editor: exit event, no third capture, nothing more posted but the check-in.
    await h.exit();
    await h.settle(10_000);
    expect(h.exits).toEqual([{ table: MB_TABLE, durationSec: expect.any(Number) }]);
    expect(h.captures).toHaveLength(2);
    expect(h.paths('/score')).toHaveLength(2);
    expect(h.paths('/report')).toHaveLength(4);
    expect(h.paths('/checkin')).toHaveLength(2);
    expect(h.witness.status()).toMatchObject({ currentTable: null, note: null, sendingTo: SENDING_TO });
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
