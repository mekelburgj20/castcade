import { createHash } from 'node:crypto';
import { VPM_SCRIPT, crlf } from '../patcher/test-scripts.test-support.js';
import { ascii, buildVpx, codeRecord, concat, floatRecord, record, u32le } from './synth-vpx.test-support.js';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import { ArcaidError, type FetchLike } from './arcaid-client.js';
import { MemoryFs } from './fs.js';
import { readJournalLines, replayJournal } from './journal-replay.js';
import { createMapCorpus } from './maps.js';
import { createStaticRegistry, NVRAM_DIRECTORY_VALUE, VPM_GLOBALS_KEY } from './nvram-dir.js';
import type { ProcessInfo } from './process-watch.js';
import { buildOwnerStyleVpx } from './synth-vpx.test-support.js';
import type { LastCapture, LiveGame, WitnessSettings, WitnessStatus, WitnessNotice } from './types.js';
import { createVpsIndex } from './vps-index.js';
import { POSTED_GAMES_FILE } from './posted-games.js';
import { attemptStatusFor, createWitness, embeddedPatchNote, manifestDirFor, oldPatchNote, outcomeForWire, parseSessionStamp, quitWire, resolveTableName, versionOlder, type WitnessDeps } from './witness.js';
import { RECIPE_VERSION, classifyScript, manifestPathFor, renderRecipeA } from '../patcher/index.js';
import { JournalDetector } from './journal-detector.js';
import type { CompiledMap } from './maps.js';

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
    vrProbe: null,
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
  const notices: WitnessNotice[] = [];
  witness.on('notice', (n) => notices.push(n));

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
    notices,
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
    expect(h.witness.status()).toMatchObject({ running: true, paired: true, nvramDir: '/nv', mapsVersion: 'f0c422099f0b50b69bfdf6d071a6653a8b25a6fd', lastError: null });
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
    // 0.2.12: a table without a Castcade patch gets the "not patched" sentence as the status note (basic mode).
    expect(h.witness.status()).toMatchObject({ currentTable: MM_TABLE, vpxExe: EXE, note: expect.stringMatching(/not patched|no Castcade patch/) });
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
    expect(Object.keys(score).sort()).toEqual(['build', 'device', 'dur', 'ended', 'fingerprint', 'ini', 'quit', 'reason', 'rom', 'score', 'slug', 'started', 'table', 'table_save_rev', 'table_sha256', 'vps_game', 'vps_table']);
    expect(score['quit']).toBe('0'); // B16: the .nv says game over
    // F4: the playfield fingerprint rides beside the file hash.
    expect(score['fingerprint']).toMatch(/^pf1:[0-9a-f]{64}$/);
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

  it('VR (0.2.10): the probe sees OpenVR in the process and SteamVR running → play_device=vr_headset on the wire, in the conditions and the capture detail', async () => {
    const sampled: number[] = [];
    const h = harness({}, {
      vrProbe: {
        sample: async (pid) => {
          sampled.push(pid);
          return { inVr: true, runtimeLoaded: true, compositorRunning: true, vrCapableBuild: true, sampledAt: '2026-10-21T00:00:00.000Z' };
        },
      },
    });
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.fs.put(MM_PATH, MM_VPX);
    h.fs.put(EXE, EXE_BYTES);
    h.fs.put(DLL_PATH, DLL_BYTES);
    h.fs.put('C:\\VPX\\VPinballX.ini', new TextEncoder().encode(MAIN_INI));

    await h.witness.start();
    await h.flush();
    await h.launch();
    await h.flush();
    // Sampled once the table was known, against the VPX pid.
    expect(sampled).toContain(10);
    expect(h.witness.status().currentAttestation).toMatchObject({ vr: { inVr: true, runtimeLoaded: true, compositorRunning: true } });

    await h.playFor(300_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.exit();
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({ outcome: 'ingested', score: 1089510 });
    expect(h.captures[0]?.detail).toMatch(/played in a VR headset/);
    const score = h.paths('/score')[0]?.params ?? {};
    expect(score['play_device']).toBe('vr_headset');
  });

  it('F5 (B5.2): a sidecar that is not Castcade\'s is diffed against the embedded script and the report rides on the score', async () => {
    const h = harness({}, { registry: createStaticRegistry(RIG_REGISTRY), env: {} });
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.fs.put(MM_PATH, MM_VPX);
    // MM_VPX's embedded script is `Option Explicit` + `Const cGameName = "mb_106b"`; this sidecar adds a ball saver.
    h.fs.put(MM_PATH.replace(/\.vpx$/, '.vbs'), ascii('Option Explicit\r\nConst cGameName = "mb_106b"\r\nBallSaverTime = 999\r\n'));
    h.fs.put(EXE, EXE_BYTES);
    h.fs.put(DLL_PATH, DLL_BYTES);
    await h.witness.start();
    await h.flush();
    await h.launch();
    await h.flush();
    await h.playFor(300_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.exit();
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]?.detail).toMatch(/script: a sidecar \.vbs that is not Castcade's; 1 restricted vs the embedded script \(first restricted: touches ballsavertime\)/);
    const wire = JSON.parse(h.paths('/score')[0]?.params['script_diff'] ?? 'null');
    expect(wire).toMatchObject({ v: 1, ran: 'foreign', baseline: 'embedded', counts: { restricted: 1, allowed: 0, unknown: 0 }, hunks: [{ cls: 'restricted', add: ['ballsavertime = 999'] }] });
    // Flag only: the score still went in.
    expect(h.captures[0]).toMatchObject({ outcome: 'ingested', score: 1089510 });
  });

  it('F5 (B5.2): no sidecar means the embedded script ran, and no `script_diff` is sent', async () => {
    const h = harness({}, { registry: createStaticRegistry(RIG_REGISTRY), env: {} });
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.fs.put(MM_PATH, MM_VPX);
    await h.witness.start();
    await h.flush();
    await h.launch();
    await h.flush();
    await h.playFor(300_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.exit();
    expect(h.paths('/score')[0]?.params['script_diff']).toBeUndefined();
    expect(h.captures[0]?.detail).toMatch(/script: the table's own script, no change from the embedded script/);
  });

  it('VR (0.2.10): no sample → no play_device on the wire (ArcAid reads the monitor)', async () => {
    const h = harness({}, { vrProbe: { sample: async () => null } });
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    h.fs.put(MM_PATH, MM_VPX);
    h.fs.put(EXE, EXE_BYTES);
    h.fs.put(DLL_PATH, DLL_BYTES);
    await h.witness.start();
    await h.flush();
    await h.launch();
    await h.flush();
    expect(h.witness.status().currentAttestation).toMatchObject({ vr: null });
    await h.playFor(300_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.exit();
    expect(h.captures[0]).toMatchObject({ outcome: 'ingested' });
    expect(h.paths('/score')[0]?.params ?? {}).not.toHaveProperty('play_device');
    expect(h.captures[0]?.detail).not.toMatch(/played/);
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

  it("B20: a play that went to Global says why it counted on no board, in ArcAid's words", () => {
    const global = outcomeForWire('global', { notCounted: 'no open game matched "Tron Legacy (Stern 2011)"' });
    expect(global.outcome).toBe('ingested');
    expect(global.detail).toBe('recorded on the Global Scoreboard; not counted for a board: no open game matched "Tron Legacy (Stern 2011)"');
    expect(outcomeForWire('global', { notCounted: '  ' }).detail).toBe('recorded on the Global Scoreboard');
    expect(outcomeForWire('no_match', { notCounted: 'played before "Tron" went up in "LA-T4" in Arcaid Witness Demo' }).detail)
      .toBe('ArcAid: no open game or catalogue entry matched this table: played before "Tron" went up in "LA-T4" in Arcaid Witness Demo');
    // An attempt refusal arrives as `not_sanctioned` too (ADR 0029): the text must not call it Sanctioned play.
    const refused = outcomeForWire('not_sanctioned', { reasons: ['no game start was reported for this score — import this table in Castcade so live mode can count attempts'], fallback: 'global' });
    expect(refused.detail).toBe('ArcAid: not counted for the tournament: no game start was reported for this score — import this table in Castcade so live mode can count attempts; recorded on the Global Scoreboard instead');
  });

  it('a Sanctioned refusal (ArcAid 2.165.0) is rejected with the reasons and says where the play went instead', () => {
    const held = outcomeForWire('not_sanctioned', { reasons: ['tilt sensitivity 10 is below the minimum 300'], fallback: 'global' });
    expect(held.outcome).toBe('rejected');
    expect(held.detail).toBe('ArcAid: not counted for the tournament: tilt sensitivity 10 is below the minimum 300; recorded on the Global Scoreboard instead');
    expect(outcomeForWire('not_sanctioned', { reasons: [], fallback: null }).detail).toBe('ArcAid: not counted for the tournament');
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
    expect(h.witness.status()).toMatchObject({ currentTable: MB_TABLE, note: expect.stringMatching(/not patched|no Castcade patch/) });
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
    expect(h.witness.status()).toMatchObject({ currentTable: MB_TABLE, note: expect.stringMatching(/no Castcade patch|not patched/) }); // still open in the editor (basic mode: the note says so)

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

  /** B18: a TFTC install as the import leaves it (table, sidecar, manifest) and a VPX whose player is already up. */
  function playerUpHarness() {
    const h = harness({}, { journalDir: '/journal', journalPollMs: 250 });
    h.fs.put(TFTC_PATH, MM_VPX);
    h.fs.put(TFTC_SIDECAR, SIDECAR_HEAD + "Sub Table1_KeyDown(ByVal KeyCode)\r\nEnd Sub\r\n");
    const manifest = {
      tableId: TFTC_TABLE, vpxPath: TFTC_PATH, vpxSha256: null, vpxSize: MM_VPX.length, vpxMtimeMs: 0, scriptSha256: '0'.repeat(64),
      class: 'A', recipe: 'A', recipeVersion: RECIPE_VERSION, libVersion: '0.4.0', rom: 'tftc_400', sidecarPath: TFTC_SIDECAR,
      sidecarSha256: '0'.repeat(64), anchors: {}, warnings: [], renderedAt: '2026-10-29T00:00:00Z', verified: null,
    };
    h.fs.put(manifestPathFor(manifestDirFor('/data'), TFTC_TABLE), JSON.stringify(manifest));
    return h;
  }

  it('B18: started with the player already up, the table comes from the newest journal of this VPX process and live mode arms', async () => {
    const h = playerUpHarness();
    const now = h.clock.now();
    // The table loaded 30 s ago in a VPX started a minute ago (rig 2026-10-30T03:49Z: `launch null` until play ended).
    const loadedAt = now - 30_000;
    const journal = tftcJournalAt(loadedAt);
    h.fs.put(TFTC_JOURNAL, journal.text);
    await h.witness.start();
    await h.launch(`"${EXE}"`, 32, { startedAt: now - 60_000, windowTitle: 'Visual Pinball Player' });
    await h.poll();
    await h.flush();
    await h.flush();

    expect(h.launches).toEqual([{ table: TFTC_TABLE, pid: 32 }]);
    expect(h.witness.status()).toMatchObject({ currentTable: TFTC_TABLE, captureMode: 'live' });
    expect(h.paths('/score')).toHaveLength(1);
    expect(h.paths('/score')[0]?.params).toMatchObject({
      table: 'Tales from the Crypt (Data East 1993)',
      rom: 'tftc_400',
      score: '2318430',
      reason: 'game_over',
      started: String(Math.floor((loadedAt + journal.gameStartT * 1000) / 1000)),
      table_sha256: sha(MM_VPX),
    });
    expect(h.captures[0]).toMatchObject({ table: TFTC_TABLE, mode: 'live', outcome: 'ingested' });
    expect(h.captures[0]?.detail).toMatch(/table from the hook's journal/);
    expect(h.errors).toEqual([]);

    // The exit line names the table too.
    await h.exit();
    await h.settle(8000);
    expect(h.exits).toEqual([{ table: TFTC_TABLE, durationSec: expect.any(Number) }]);
    expect(h.paths('/score')).toHaveLength(1);
  });

  it('B18: a journal from before this VPX process is not taken as its table', async () => {
    const h = playerUpHarness();
    const now = h.clock.now();
    h.fs.put(TFTC_JOURNAL, tftcJournalAt(now - 24 * 3_600_000).text);
    await h.witness.start();
    await h.launch(`"${EXE}"`, 32, { startedAt: now - 60_000, windowTitle: 'Visual Pinball Player' });
    await h.poll();
    await h.flush();

    expect(h.launches).toEqual([{ table: null, pid: 32 }]);
    expect(h.witness.status()).toMatchObject({ currentTable: null, captureMode: 'basic' });
    expect(h.paths('/score')).toHaveLength(0);
    expect(h.errors).toEqual([]);
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

// ------------------------------------------------------------------------------------ live mode --

const TFTC_TABLE = 'Tales from the Crypt (Data East 1993) VPW v1.22';
const TFTC_PATH = `C:\\Tables\\${TFTC_TABLE}.vpx`;
const TFTC_SIDECAR = `C:\\Tables\\${TFTC_TABLE}.vbs`;
const TFTC_CMD = `"C:\\VPX\\VPinballX64.exe" -Play "${TFTC_PATH}"`;
const TFTC_JOURNAL = '/journal/Tales_from_the_Crypt_Data_East_1993_VPW_v1.22.jsonl';
const TFTC_FIXTURE_STAMP = '"session":"2026-10-17T18:16:03"';
/** What a rendered sidecar's first lines look like: the marker the witness looks for is the `Castcade_Init` call. */
const SIDECAR_HEAD = `' --- Castcade (recipe A v0.2.0, lib 0.2.0) --- do not edit; delete this .vbs to revert to the embedded script\r\nOn Error Resume Next\r\nExecuteGlobal GetTextFile("castcade.vbs")\r\nCastcade_Init "${TFTC_TABLE}", "A", "0.2.0", "tftc_400"\r\n`;

/** The hook's local-time stamp for a clock instant (`Castcade_Stamp`). */
function hookStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The TFTC fixture's journal with its session stamp moved to `atMs`, so it reads as this process's session. */
function tftcJournalAt(atMs: number): { text: string; gameStartT: number; gameEndT: number } {
  const lines = readJournalLines(repo('fixtures/nvram/tftc_400/2026-10-17-1.jsonl.gz'));
  const first = lines.findIndex((l) => l.includes('"event":"table_loaded"'));
  if (first < 0 || !lines[first]!.includes(TFTC_FIXTURE_STAMP)) throw new Error('fixture changed: table_loaded stamp not found');
  lines[first] = lines[first]!.replace(TFTC_FIXTURE_STAMP, `"session":"${hookStamp(atMs)}"`);
  // Ground truth for the timings comes from the detector itself (what check.py asserts in CI).
  const d = new JournalDetector({ mapFor: (rom) => (rom === 'tftc_400' ? tftcMap : null) });
  let gameStartT = -1;
  let gameEndT = -1;
  for (const l of lines) {
    for (const ev of d.feed(l)) {
      if (ev.kind === 'game_start') gameStartT = ev.t;
      if (ev.kind === 'game_end') gameEndT = ev.t;
    }
  }
  if (gameStartT < 0 || gameEndT < 0) throw new Error('fixture replay produced no game');
  return { text: lines.join('\n') + '\n', gameStartT, gameEndT };
}

/** The TFTC session cut on ball 2 and closed there (the player quit, B16): the journal ends with `table_exit`. */
function tftcQuitJournalAt(atMs: number): { text: string; quitBall: number } {
  const lines = tftcJournalAt(atMs).text.trimEnd().split('\n');
  const d = new JournalDetector({ mapFor: (rom) => (rom === 'tftc_400' ? tftcMap : null) });
  for (let i = 0; i < lines.length; i++) {
    const hit = d.feed(lines[i]!).find((ev) => ev.kind === 'current_scores' && ev.ball === 2 && (ev.scores[0] ?? 0) > 0);
    if (!hit) continue;
    const t = hit.t + 1;
    return { text: [...lines.slice(0, i + 1), `{"event":"table_exit","t":${t.toFixed(3)},"lines":${i + 2}}`].join('\n') + '\n', quitBall: 2 };
  }
  throw new Error('fixture replay never reached ball 2');
}

let tftcMap: CompiledMap;
beforeAll(async () => {
  const m = await corpus.mapFor('tftc_400');
  if (!m) throw new Error('no tftc_400 map in fixtures/maps');
  tftcMap = m;
});

describe('createWitness: live mode (a table with a Castcade sidecar posts every game from the journal)', () => {
  function liveHarness() {
    const h = harness({}, { journalDir: '/journal', journalPollMs: 250 });
    h.fs.put(TFTC_PATH, MM_VPX);
    h.fs.put(TFTC_SIDECAR, SIDECAR_HEAD + "Sub Table1_KeyDown(ByVal KeyCode)\r\nEnd Sub\r\n");
    return h;
  }

  it('arms when the Castcade block sits behind a long opening banner (AC/DC: the marker at byte 10,866)', async () => {
    const h = liveHarness();
    const banner = Array.from({ length: 200 }, () => "' ****************************************************************\r\n").join('');
    h.fs.put(TFTC_SIDECAR, banner + SIDECAR_HEAD + "Sub Table1_KeyDown(ByVal KeyCode)\r\nEnd Sub\r\n");
    await h.witness.start();
    await h.launch(TFTC_CMD, 31);
    expect(h.witness.status()).toMatchObject({ currentTable: TFTC_TABLE, captureMode: 'live' });
  });

  it('B12: a patched table whose ROM has no readable live score reads as basic on Status, with the reason', async () => {
    const h = liveHarness();
    await h.witness.start();
    await h.launch(TFTC_CMD, 31);
    h.fs.put(TFTC_JOURNAL, `{"event":"table_loaded","t":0,"table":"T","recipe":"A","rom":"zz_999","lib":"0.4.0","session":"${hookStamp(h.clock.now())}","locked":false}\n`);
    await h.poll();
    await h.flush();
    const st = h.witness.status();
    expect(st.captureMode).toBe('basic');
    expect(st.note).toBe(`${TFTC_TABLE}: this machine's live score can't be read yet (no NVRAM map for this ROM). At most the last game of this session posts, when the table closes.`);
  });

  it('B15: a table that loaded an older patch than this build says so once, and stays live', async () => {
    const h = liveHarness();
    await h.witness.start();
    await h.launch(TFTC_CMD, 31);
    const line = (recipe: string, stamp: string) => `{"event":"table_loaded","t":0,"table":"T","recipe":"A","recipe_version":"${recipe}","rom":"tftc_400","lib":"0.4.0","session":"${stamp}","locked":false}\n`;
    h.fs.put(TFTC_JOURNAL, line('0.3.0', hookStamp(h.clock.now())));
    await h.poll();
    await h.flush();
    expect(h.witness.status().captureMode).toBe('live');
    expect(h.witness.status().note).toBe(oldPatchNote(TFTC_TABLE, '0.3.0'));
    expect(h.witness.status().note).toMatch(/older Castcade patch \(recipe 0\.3\.0; this build makes \d+\.\d+\.\d+\).*Close the table and open it again/);
    expect(h.notices.filter((n) => n.kind === 'old_patch')).toEqual([expect.objectContaining({ kind: 'old_patch', table: TFTC_TABLE, title: 'Castcade: reopen this table' })]);
  });

  it("C10: a table whose own script is Castcade's patch (the VPX editor saved it there) arms live mode without a sidecar, and the player is told once", async () => {
    const h = harness({}, { journalDir: '/journal', journalPollMs: 250 });
    const script = crlf(VPM_SCRIPT);
    const patch = renderRecipeA(script, classifyScript(script), { tableId: TFTC_TABLE, rom: 'tftc_400', originalPath: TFTC_PATH, originalSize: 1, originalMtimeMs: 0, sidecarPath: TFTC_SIDECAR });
    h.fs.put(TFTC_PATH, buildVpx({ gameData: concat(record('LEFT', u32le(0)), floatRecord('GAVT', 1.75), codeRecord(patch.bytes), record('ENDB', new Uint8Array(0))) }));
    await h.witness.start();
    await h.launch(TFTC_CMD, 31);
    expect(h.witness.status()).toMatchObject({ currentTable: TFTC_TABLE, captureMode: 'live' });
    expect(h.notices).toEqual([expect.objectContaining({ kind: 'embedded_patch', table: TFTC_TABLE, vpxPath: TFTC_PATH, title: 'Castcade: patch saved into the table', message: embeddedPatchNote(TFTC_TABLE) })]);
    expect(h.notices[0]?.message).toMatch(/the VPX editor saved it into the table. Games still post/);
    // The same table again this run: no second balloon.
    await h.exit();
    await h.launch(TFTC_CMD, 32);
    expect(h.notices).toHaveLength(1);
  });

  it('B15: a table on the current patch shows no note', async () => {
    const h = liveHarness();
    await h.witness.start();
    await h.launch(TFTC_CMD, 31);
    h.fs.put(TFTC_JOURNAL, `{"event":"table_loaded","t":0,"table":"T","recipe":"A","recipe_version":"${RECIPE_VERSION}","rom":"tftc_400","lib":"0.4.0","session":"${hookStamp(h.clock.now())}","locked":false}\n`);
    await h.poll();
    await h.flush();
    expect(h.witness.status()).toMatchObject({ captureMode: 'live', note: null });
    expect(h.notices).toEqual([]);
  });

  it('D1.1: the game on screen follows the journal (table, start, scores with player and ball, end), and clears at exit', async () => {
    const h = liveHarness();
    const seen: (LiveGame | null)[] = [];
    h.witness.on('game', (g) => seen.push(g));
    await h.witness.start();
    await h.launch(TFTC_CMD, 31);
    h.fs.put(TFTC_JOURNAL, tftcJournalAt(h.clock.now() + 4000).text);
    await h.poll();
    await h.flush();
    await h.flush();

    expect(seen[0]).toEqual({ table: TFTC_TABLE, inGame: false, scores: [], player: null, ball: null });
    expect(seen[1]).toEqual({ table: TFTC_TABLE, inGame: true, scores: [], player: null, ball: null });
    const during = seen.filter((g) => g?.inGame && g.scores.length > 0);
    expect(during.length).toBeGreaterThan(3);
    expect(during.every((g) => g!.player === 1 && g!.ball !== null && g!.ball >= 1)).toBe(true);
    const end = seen.find((g) => g && !g.inGame && g.scores.length > 0);
    expect(end?.scores[0]).toBe(2318430);
    expect(h.witness.liveGame()).toMatchObject({ inGame: false, scores: [2318430, 0, 0, 0] });

    await h.exit();
    await h.settle(8000);
    expect(seen.at(-1)).toBeNull();
    expect(h.witness.liveGame()).toBeNull();
  });

  it('arms on a sidecar, posts the game at game_end with the hook\'s own timing, and does not re-post the .nv at close', async () => {
    const h = liveHarness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/tftc_400.nv', mmBefore);
    await h.witness.start();
    await h.launch(TFTC_CMD, 31);
    expect(h.witness.status()).toMatchObject({ currentTable: TFTC_TABLE, captureMode: 'live' });
    const launchedAt = h.clock.now(); // the watch saw the process on this poll; no creation time from the lister

    // The hook initialised a few seconds after the process appeared and wrote the whole session; the tail picks it up.
    const loadedAt = launchedAt + 4000;
    const journal = tftcJournalAt(loadedAt);
    h.fs.put(TFTC_JOURNAL, journal.text);
    await h.poll();
    await h.flush();
    await h.flush();

    expect(h.paths('/score')).toHaveLength(1);
    const started = Math.floor((loadedAt + journal.gameStartT * 1000) / 1000);
    const ended = Math.floor((loadedAt + journal.gameEndT * 1000) / 1000);
    expect(h.paths('/score')[0]?.params).toMatchObject({
      device: 'dev-1',
      table: 'Tales from the Crypt (Data East 1993)',
      rom: 'tftc_400',
      score: '2318430',
      reason: 'game_over',
      quit: '0',
      started: String(started),
      ended: String(ended),
      dur: String(ended - started),
    });
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({ table: TFTC_TABLE, rom: 'tftc_400', players: 1, score: 2318430, outcome: 'ingested', mode: 'live' });
    expect(h.captures[0]?.detail).toMatch(/live: game 1 of this session/);
    // Attestation ran at capture (the Data East map has no adjustments block, so that part is null by design).
    expect(h.captures[0]?.attestation).not.toBeNull();
    expect(h.captures[0]?.attestation?.adjustments).toBeNull();
    // The VPX session was opened once (launch report) and no score closed it yet.
    expect(h.paths('/report')).toHaveLength(1);
    expect(h.paths('/report')[0]?.params).not.toHaveProperty('exit');

    // The player closes the table: VPinMAME rewrites the .nv (the same last game). Live mode posted it already.
    h.fs.put('/nv/tftc_400.nv', mmAfter);
    await h.exit();
    await h.settle(8000);
    expect(h.paths('/score')).toHaveLength(1);
    expect(h.paths('/report')).toHaveLength(2);
    expect(h.paths('/report')[1]?.params).toMatchObject({ table: 'Tales from the Crypt (Data East 1993)', launch: String(Math.floor(launchedAt / 1000)) });
    expect(h.paths('/report')[1]?.params).toHaveProperty('exit');
    expect(h.witness.status()).toMatchObject({ currentTable: null, captureMode: null });
    expect(h.errors).toEqual([]);
  });

  it('B16: a game quit mid-game posts with quit=1 and the ball it was quit on', async () => {
    const h = liveHarness();
    await h.witness.start();
    await h.launch(TFTC_CMD, 31);
    const journal = tftcQuitJournalAt(h.clock.now() + 4000);
    h.fs.put(TFTC_JOURNAL, journal.text);
    await h.poll();
    await h.flush();
    await h.flush();
    await h.exit();
    await h.settle(8000);

    expect(h.paths('/score')).toHaveLength(1);
    expect(h.paths('/score')[0]?.params).toMatchObject({ reason: 'shutdown', quit: '1', quit_ball: String(journal.quitBall) });
    expect(h.captures[0]?.detail).toMatch(/abandoned on ball 2/);
  });

  it('on a limited-attempts board the game start is reported at once with a key the score repeats, and the capture carries the attempt', async () => {
    const h = liveHarness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/tftc_400.nv', mmBefore);
    h.setRespond((path) =>
      path.endsWith('/attempt')
        ? { status: 200, body: { ok: true, status: 'counted', game: 'Tales from the Crypt', attempt: 2, of: 5, remaining: 3, late: false } }
        : path.endsWith('/score')
          ? { status: 200, body: { ok: true, status: 'ingested', game: 'Tales from the Crypt', attempt: { n: 2, of: 5, remaining: 3 } } }
          : { status: 200, body: { ok: true } },
    );
    await h.witness.start();
    await h.launch(TFTC_CMD, 33);
    const loadedAt = h.clock.now() + 4000;
    const journal = tftcJournalAt(loadedAt);
    h.fs.put(TFTC_JOURNAL, journal.text);
    await h.poll();
    await h.flush();
    await h.flush();

    expect(h.paths('/attempt')).toHaveLength(1);
    const a = h.paths('/attempt')[0]!;
    expect(a.params).toMatchObject({
      device: 'dev-1',
      table: 'Tales from the Crypt (Data East 1993)',
      rom: 'tftc_400',
      started: String(Math.floor((loadedAt + journal.gameStartT * 1000) / 1000)),
      players: '1',
    });
    expect(a.params['key']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}#\d+$/);
    expect(a.token).toBe('tok');
    // The attempt call went out BEFORE the score (the start, not the end, is what counts).
    const order = h.calls.map((c) => c.path).filter((p) => p.endsWith('/attempt') || p.endsWith('/score'));
    expect(order).toEqual(['/api/witness/attempt', '/api/witness/score']);
    expect(h.paths('/score')).toHaveLength(1);
    expect(h.paths('/score')[0]?.params['attempt']).toBe(a.params['key']);
    expect(h.captures[0]).toMatchObject({ outcome: 'ingested', mode: 'live', attempt: { n: 2, of: 5, remaining: 3 } });
    expect(h.captures[0]?.detail).toMatch(/attempt 2 of 5/);
    // The Status page saw "Attempt 2 of 5" while the game ran, and nothing once it was captured.
    expect(h.statuses.some((s) => s.attempt?.state === 'counted' && s.attempt.text === 'Attempt 2 of 5')).toBe(true);
    expect(h.witness.status().attempt).toBeNull();
    expect(h.errors).toEqual([]);
  });

  it("B19: the game start carries the ROM's VPS game, not the file's: the identity is pinned at table_loaded", async () => {
    // The file at TFTC_PATH is MM_VPX, whose TableInfo says Medieval Madness: resolved from the file alone the
    // identity is MM (-5yMpqSy), the ROM in the journal says Tales from the Crypt (fXaQ33KC). Krobs' Tron did
    // the same with VPS's 2016 original, and ArcAid matched the start to nothing (2026-10-29).
    const logs: string[] = [];
    const h = harness({}, { journalDir: '/journal', journalPollMs: 250, log: (l) => logs.push(l) });
    h.fs.put(TFTC_PATH, MM_VPX);
    h.fs.put(TFTC_SIDECAR, SIDECAR_HEAD + "Sub Table1_KeyDown(ByVal KeyCode)\r\nEnd Sub\r\n");
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/tftc_400.nv', mmBefore);
    h.setRespond((path) =>
      path.endsWith('/attempt')
        ? { status: 200, body: { ok: true, status: 'counted', game: 'Tales from the Crypt', attempt: 1, of: 5, remaining: 4, late: false } }
        : { status: 200, body: { ok: true, status: 'ingested', game: 'Tales from the Crypt' } },
    );
    await h.witness.start();
    await h.launch(TFTC_CMD, 36);
    const loadedAt = h.clock.now() + 4000;
    h.fs.put(TFTC_JOURNAL, tftcJournalAt(loadedAt).text);
    await h.poll();
    await h.flush();
    await h.flush();

    expect(h.paths('/attempt')).toHaveLength(1);
    expect(h.paths('/attempt')[0]?.params).toMatchObject({ rom: 'tftc_400', vps_game: 'fXaQ33KC' });
    expect(h.paths('/score')).toHaveLength(1);
    expect(h.paths('/score')[0]?.params['vps_game']).toBe('fXaQ33KC');
    expect(h.captures[0]?.identity).toMatchObject({ vpsGame: { id: 'fXaQ33KC' }, gameSource: 'rom' });
    expect(logs).toContain('witness: identity pinned by ROM tftc_400: Tales from the Crypt (fXaQ33KC), was -5yMpqSy');
    expect(h.errors).toEqual([]);
  });

  it('hook 0.4.0 engine lines ride on the score as `engine`, and an in-game change is named in the capture detail', async () => {
    const h = liveHarness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/tftc_400.nv', mmBefore);
    await h.witness.start();
    await h.launch(TFTC_CMD, 34);
    const loadedAt = h.clock.now() + 4000;
    const journal = tftcJournalAt(loadedAt);
    const eng = (t: number, reason: string, difficulty: number, tilt: number) =>
      `{"event":"engine","t":${t},"reason":"${reason}","difficulty":${(difficulty * 100).toFixed(4)},"slope_min":6.5000,"slope_max":6.5000,"physics_set":0,"gravity":0.9700,"friction":0.0750,"elasticity":0.2500,"elasticity_falloff":0.0000,"scatter":0.0000,"nudge_time":5.0000,"nudge":{"xmax":700,"ymax":700,"xgain":115,"ygain":115,"dead_zone":0,"tilt":${tilt}}}`;
    const lines = journal.text.split('\n');
    const tOf = (l: string) => Number(/"t":([\d.]+)/.exec(l)?.[1] ?? 'NaN');
    const mid = (journal.gameStartT + journal.gameEndT) / 2;
    const out: string[] = [];
    let placedInit = false;
    let placedChange = false;
    for (const l of lines) {
      if (!placedInit && l.includes('"event":"table_loaded"')) {
        out.push(l, eng(0.5, 'init', 0.2, 400));
        placedInit = true;
        continue;
      }
      if (!placedChange && Number.isFinite(tOf(l)) && tOf(l) > mid) {
        out.push(eng(mid, 'key', 0.8, 400));
        placedChange = true;
      }
      out.push(l);
    }
    expect(placedInit && placedChange).toBe(true);
    h.fs.put(TFTC_JOURNAL, out.join('\n'));
    await h.poll();
    await h.flush();
    await h.flush();

    expect(h.paths('/score')).toHaveLength(1);
    const wire = JSON.parse(h.paths('/score')[0]?.params['engine'] ?? 'null') as { start: { difficulty: number; nudge: { tilt: number } } | null; changes: { t: number; difficulty: number }[] };
    expect(wire.start).toMatchObject({ difficulty: 0.2, nudge: { tilt: 400 } });
    expect(wire.changes).toHaveLength(1);
    expect(wire.changes[0]).toMatchObject({ difficulty: 0.8 });
    expect(h.captures[0]?.attestation?.engine?.changes).toHaveLength(1);
    expect(h.captures[0]?.detail).toMatch(/CHANGED DURING THE GAME \(1 change, last at \+\d+ s\): difficulty 20% → 80%/);
    expect(h.errors).toEqual([]);
  });

  it('B6.1: how the score moved rides on the score as `score_plausibility` (facts, no flag on a clean game)', async () => {
    const h = liveHarness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/tftc_400.nv', mmBefore);
    await h.witness.start();
    await h.launch(TFTC_CMD, 34);
    h.fs.put(TFTC_JOURNAL, tftcJournalAt(h.clock.now() + 4000).text);
    await h.poll();
    await h.flush();
    await h.flush();

    expect(h.paths('/score')).toHaveLength(1);
    const wire = JSON.parse(h.paths('/score')[0]?.params['score_plausibility'] ?? 'null') as { samples: number; step: number; off_step: number; largest: { points: number; ball: number }; flag: string | null };
    expect(wire).toMatchObject({ step: 10, off_step: 0, flag: null, largest: { points: 600000, ball: 3 } });
    expect(wire.samples).toBeGreaterThan(0);
    expect(h.captures[0]?.detail).toMatch(/score plausibility: \d+ changes, largest jump \+600,000 on ball 3, all in steps of 10/);
    expect(h.errors).toEqual([]);
  });

  it('a second table loaded from the editor in the same VPX process arms its own live mode; its sidecar is not judged by the first table\'s manifest', async () => {
    // 2026-10-26 on the owner's rig: AC/DC played and posted, then Walking Dead opened from the editor. The
    // AC/DC session kept its live state, Walking Dead's hash was checked against AC/DC's manifest, and its
    // good sidecar was renamed .stale; its game was then dropped as "AC/DC: .nv rewritten, not re-posting".
    const h = harness({}, { journalDir: '/journal', journalPollMs: 250 });
    const tftcPath = `C:\\VPX\\tables\\${TFTC_TABLE}.vpx`;
    const mbPath = `C:\\VPX\\tables\\${MB_TABLE}.vpx`;
    h.fs.put(tftcPath, MM_VPX);
    h.fs.put(tftcPath.replace(/\.vpx$/, '.vbs'), SIDECAR_HEAD + "Sub Table1_KeyDown(ByVal KeyCode)\r\nEnd Sub\r\n");
    h.fs.put(mbPath, MB_VPX);
    h.fs.put(mbPath.replace(/\.vpx$/, '.vbs'), SIDECAR_HEAD.replace(TFTC_TABLE, MB_TABLE) + "Sub Table1_KeyDown(ByVal KeyCode)\r\nEnd Sub\r\n");
    // The first table's manifest pins its own file (the import wrote it); the second table's file differs.
    h.fs.put('/data/tables/Tales_from_the_Crypt_Data_East_1993_VPW_v1.22.json', JSON.stringify({
      tableId: TFTC_TABLE, vpxPath: tftcPath, vpxSha256: sha(MM_VPX), vpxSize: MM_VPX.length, vpxMtimeMs: 0, scriptSha256: 'x', class: 'A',
      recipe: 'A', recipeVersion: '0.3.1', libVersion: '0.4.0', rom: 'tftc_400', sidecarPath: tftcPath.replace(/\.vpx$/, '.vbs'), sidecarSha256: 'x',
      anchors: {}, warnings: [], renderedAt: '2026-10-26T00:00:00Z', verified: null,
    }));
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/tftc_400.nv', mmBefore);
    await h.witness.start();
    await h.launch(GL_CMD, 54240, { exe: GL_EXE, startedAt: h.clock.now() - 60_000, windowTitle: 'Visual Pinball' });

    h.setTitle(`Visual Pinball - [${TFTC_TABLE}]`);
    await h.poll();
    expect(h.witness.status()).toMatchObject({ currentTable: TFTC_TABLE, captureMode: 'live' });
    h.fs.put(TFTC_JOURNAL, tftcJournalAt(h.clock.now() + 1000).text);
    await h.poll();
    await h.flush();
    await h.flush();
    expect(h.paths('/score')).toHaveLength(1);

    h.setTitle(MB_TITLE);
    await h.poll();
    await h.flush();
    await h.flush();
    expect(h.witness.status()).toMatchObject({ currentTable: MB_TABLE, captureMode: 'live' });
    expect(h.fs.has(mbPath.replace(/\.vpx$/, '.vbs'))).toBe(true);
    expect(h.fs.has(mbPath.replace(/\.vpx$/, '.vbs.stale'))).toBe(false);
    expect(h.errors).toEqual([]);

    // Back to the first table: its journal is tailed from the top again, and the game it already posted stays posted once.
    h.setTitle(`Visual Pinball - [${TFTC_TABLE}]`);
    await h.poll();
    await h.flush();
    await h.flush();
    expect(h.witness.status()).toMatchObject({ currentTable: TFTC_TABLE, captureMode: 'live' });
    expect(h.paths('/score')).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it('ignores an earlier session left in the same journal file, and falls back to basic mode when no game follows', async () => {
    const h = liveHarness();
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    // Residue from yesterday's session (a whole game) is already in the file when the table launches.
    h.fs.put(TFTC_JOURNAL, tftcJournalAt(h.clock.now() - 24 * 3_600_000).text);
    await h.witness.start();
    await h.launch(TFTC_CMD, 32);
    await h.poll();
    await h.flush();
    expect(h.witness.status().captureMode).toBe('live');
    expect(h.paths('/score')).toHaveLength(0);

    // Nothing live was captured, so the .nv at close is still the one capture (basic mode as before).
    await h.playFor(60_000);
    h.fs.put('/nv/mm_109c.nv', mmAfter);
    await h.exit();
    await h.settle(8000);
    expect(h.paths('/score')).toHaveLength(1);
    expect(h.paths('/score')[0]?.params).toMatchObject({ reason: 'exit_sample', score: '1089510' });
    expect(h.captures[0]?.mode).toBe('basic');
  });

  /** B17: the first run posts the journal's game for a VPX process that started a minute ago; returns what a restart needs. */
  async function firstRunPosts() {
    const h = liveHarness();
    const startedAt = h.clock.now() - 60_000;
    const loadedAt = h.clock.now() - 30_000;
    const journal = tftcJournalAt(loadedAt);
    h.fs.put(TFTC_JOURNAL, journal.text);
    await h.witness.start();
    await h.launch(TFTC_CMD, 32, { startedAt });
    await h.poll();
    await h.flush();
    await h.flush();
    expect(h.paths('/score')).toHaveLength(1);
    const key = `${TFTC_TABLE}@${hookStamp(loadedAt)}#${Math.round(journal.gameStartT * 1000)}`;
    expect(h.fs.text('/data/' + POSTED_GAMES_FILE)).toContain(JSON.stringify(key));
    // Castcade closes; VPX stays open.
    await h.witness.stop();
    return { h, startedAt, journal };
  }

  it('B17: a Castcade restart while VPX stays open does not re-post the games an earlier run posted; a new session still posts', async () => {
    const { h, startedAt, journal } = await firstRunPosts();

    // The restart: a new witness over the same files, the same VPX process (pid and creation time).
    const h2 = harness({}, { fs: h.fs, journalDir: '/journal', journalPollMs: 250 });
    await h2.witness.start();
    await h2.launch(TFTC_CMD, 32, { startedAt });
    await h2.poll();
    await h2.flush();
    await h2.flush();
    expect(h2.paths('/score')).toHaveLength(0);
    expect(h2.witness.status().captureMode).toBe('live');

    // The player opens the table again in the same process: a new session in the same file posts.
    const loadedAt2 = h2.clock.now();
    const next = tftcJournalAt(loadedAt2);
    h.fs.put(TFTC_JOURNAL, journal.text + next.text);
    await h2.poll();
    await h2.flush();
    await h2.flush();
    expect(h2.paths('/score')).toHaveLength(1);
    const started = Math.floor((loadedAt2 + next.gameStartT * 1000) / 1000);
    const ended = Math.floor((loadedAt2 + next.gameEndT * 1000) / 1000);
    expect(h2.paths('/score')[0]?.params).toMatchObject({
      device: 'dev-1',
      table: 'Tales from the Crypt (Data East 1993)',
      rom: 'tftc_400',
      score: '2318430',
      reason: 'game_over',
      started: String(started),
      ended: String(ended),
    });
    expect(h2.errors).toEqual([]);
    await h2.witness.stop();
  });

  it('B17: after a restart that replayed only posted games, the .nv rewrite at close does not post the last one either', async () => {
    const { h, startedAt } = await firstRunPosts();
    const h2 = harness({}, { fs: h.fs, journalDir: '/journal', journalPollMs: 250 });
    await h.fs.mkdir('/nv');
    // Explicit mtimes: the shared fs would stamp both writes with the first run's stopped clock.
    h.fs.put('/nv/mm_109c.nv', mmBefore, h2.clock.now());
    await h2.witness.start();
    await h2.launch(TFTC_CMD, 32, { startedAt });
    await h2.poll();
    await h2.flush();
    await h2.playFor(60_000);
    // VPinMAME rewrites the .nv as the table closes: the game the earlier run posted, again.
    h.fs.put('/nv/mm_109c.nv', mmAfter, h2.clock.now());
    await h2.exit();
    await h2.settle(8000);
    expect(h2.paths('/score')).toHaveLength(0);
    await h2.witness.stop();
  });

  it('B17: a game that was never posted (Castcade was not running) still posts after a restart', async () => {
    const h = liveHarness();
    const startedAt = h.clock.now() - 60_000;
    // VPX ran and the game was played while no Castcade was running: the journal holds it, the posted file does not.
    h.fs.put(TFTC_JOURNAL, tftcJournalAt(h.clock.now() - 30_000).text);
    expect(h.fs.text('/data/' + POSTED_GAMES_FILE)).toBeNull();
    await h.launch(TFTC_CMD, 32, { startedAt });
    await h.witness.start();
    await h.poll();
    await h.flush();
    await h.flush();
    expect(h.paths('/score')).toHaveLength(1);
    expect(h.paths('/score')[0]?.params).toMatchObject({ table: 'Tales from the Crypt (Data East 1993)', score: '2318430', reason: 'game_over' });
    await h.witness.stop();
  });

  it('a table without a sidecar stays in basic mode, and the player is told once that the import would fix it', async () => {
    const h = harness({}, { journalDir: '/journal' });
    // A real VPinMAME-shaped script (recipe A) with no sidecar beside it: the import WOULD patch this one.
    h.fs.put(MM_PATH, buildVpx({ gameData: concat(record('LEFT', u32le(0)), floatRecord('GAVT', 1.75), codeRecord(ascii(crlf(VPM_SCRIPT))), record('ENDB', new Uint8Array(0))) }));
    await h.fs.mkdir('/nv');
    h.fs.put('/nv/mm_109c.nv', mmBefore);
    await h.witness.start();
    await h.launch();
    expect(h.witness.status()).toMatchObject({ currentTable: MM_TABLE, captureMode: 'basic' });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ kind: 'unpatched', table: MM_TABLE, patchable: true, title: 'Castcade: table not patched' });
    expect(h.notices[0]?.message).toMatch(/only the last game of this session will post.*Patch my tables/);
    expect(h.witness.status().note).toBe(h.notices[0]?.message);
    // The same table again this run: no second balloon, the Status line still says so.
    await h.exit();
    await h.launch();
    expect(h.notices).toHaveLength(1);
    expect(h.witness.status().note).toMatch(/not patched/);
  });

  it('B12: a table whose machine the import would refuse is not sent to "Patch my tables"', async () => {
    const h = harness({}, { journalDir: '/journal' });
    const script = crlf(VPM_SCRIPT).replace(/cGameName = "[^"]+"/, 'cGameName = "zz_999"');
    h.fs.put(MM_PATH, buildVpx({ gameData: concat(record('LEFT', u32le(0)), floatRecord('GAVT', 1.75), codeRecord(ascii(script)), record('ENDB', new Uint8Array(0))) }));
    await h.witness.start();
    await h.launch();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ kind: 'unpatched', table: MM_TABLE, patchable: false, title: 'Castcade: basic mode' });
    expect(h.notices[0]?.message).toMatch(/live score can't be read yet \(no NVRAM map for this ROM\)/);
    expect(h.notices[0]?.message).not.toMatch(/Patch my tables/);
    expect(h.witness.status().note).toBe(h.notices[0]?.message);
  });

  it('an original table (no ROM) is told its games will not post, not "the last game will post" (TNA, rig 2026-10-28)', async () => {
    const h = harness({}, { journalDir: '/journal' });
    const original = [
      'Sub Table1_KeyDown(ByVal keycode)', 'End Sub',
      'Sub ResetForNewGame()', 'End Sub',
      'Sub AddScore(points)', '  Score(CurrentPlayer) = Score(CurrentPlayer) + points', 'End Sub',
      'Sub EndOfGame()', 'End Sub',
    ].join('\r\n');
    h.fs.put(MM_PATH, buildVpx({ gameData: concat(record('LEFT', u32le(0)), floatRecord('GAVT', 1.75), codeRecord(ascii(original)), record('ENDB', new Uint8Array(0))) }));
    await h.witness.start();
    await h.launch();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ kind: 'unpatched', table: MM_TABLE, patchable: false, title: 'Castcade: score not read' });
    expect(h.notices[0]?.message).toMatch(/original table \(no ROM\).*won't post/);
    expect(h.notices[0]?.message).not.toMatch(/last game/);
  });
});

describe('attemptStatusFor (what the player is told about a game start)', () => {
  const done = (attempt: Record<string, unknown>) => ({ state: 'done' as const, wire: null, attempt: { status: null, game: null, attempt: null, of: null, remaining: null, late: false, ...attempt } });
  it('counts, refuses, stays silent when unlimited or unmatched, and names an outage', () => {
    expect(attemptStatusFor('k', done({ status: 'counted', attempt: 3, of: 5, remaining: 2, game: 'MB' }))).toMatchObject({ state: 'counted', n: 3, of: 5, remaining: 2, text: 'Attempt 3 of 5', game: 'MB' });
    expect(attemptStatusFor('k', done({ status: 'counted', attempt: 5, of: 5, remaining: 0, late: true }))).toMatchObject({ state: 'counted', late: true, text: 'Attempt 5 of 5 (reported late: this score will not count)' });
    expect(attemptStatusFor('k', done({ status: 'over_limit', attempt: 6, of: 5, remaining: 0 }))).toMatchObject({ state: 'over_limit', text: 'No attempts left: this score will not count' });
    expect(attemptStatusFor('k', done({ status: 'unlimited' }))).toMatchObject({ state: 'unlimited', text: '' });
    expect(attemptStatusFor('k', done({ status: 'no_match' }))).toMatchObject({ state: 'no_match', text: '' });
    expect(attemptStatusFor('k', { state: 'queued', error: new ArcaidError('network', 'ArcAid unreachable') })).toMatchObject({ state: 'queued', text: 'offline: this attempt will not count' });
    expect(attemptStatusFor('k', { state: 'rejected', error: new ArcaidError('auth', 'unpaired by ArcAid') })).toMatchObject({ state: 'rejected', text: 'ArcAid refused the attempt: unpaired by ArcAid' });
  });
});

describe('parseSessionStamp', () => {
  it('reads the hook\'s local-time stamp and rejects anything else', () => {
    const ms = parseSessionStamp('2026-10-17T18:16:03');
    expect(ms).toBe(new Date(2026, 9, 17, 18, 16, 3).getTime());
    expect(parseSessionStamp('2026-10-17 18:16:03')).toBeNull();
    expect(parseSessionStamp(null)).toBeNull();
  });
});

describe('versionOlder', () => {
  it('compares dotted versions numerically and refuses what does not parse', () => {
    expect(versionOlder('0.3.0', '0.3.1')).toBe(true);
    expect(versionOlder('0.3.1', '0.3.1')).toBe(false);
    expect(versionOlder('0.10.0', '0.9.9')).toBe(false);
    expect(versionOlder('0.3', '0.3.1')).toBe(true);
    expect(versionOlder('0.4.0', '0.3.1')).toBe(false);
    expect(versionOlder('x', '0.3.1')).toBe(false);
  });
});

describe('quitWire (B16)', () => {
  it('quit before game over sends the ball when it is plausible; game over sends quit=0; unknown sends nothing', () => {
    expect(quitWire({ gameOver: false, ball: 3 })).toEqual({ quit: true, quit_ball: 3 });
    expect(quitWire({ gameOver: false, ball: null })).toEqual({ quit: true });
    expect(quitWire({ gameOver: false, ball: 0 })).toEqual({ quit: true });
    expect(quitWire({ gameOver: false, ball: 99 })).toEqual({ quit: true });
    expect(quitWire({ gameOver: true, ball: 2 })).toEqual({ quit: false });
    expect(quitWire({ gameOver: null })).toEqual({});
  });
});
