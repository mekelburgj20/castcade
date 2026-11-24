/**
 * A14 (2026-11-12): the launch module without a process or a real disk: the known-table list (manifests on a
 * `MemoryFs`), the table lookup for a host's game, and the VPX launcher with a fake spawner.
 */
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../patcher/index.js';
import { MemoryFs } from '../witness/fs.js';
import { createIdentityStore } from '../witness/identity-store.js';
import { findLocalTable, objectsCandidates, sameObjectsNote, titleOf } from './find-table.js';
import { createRecentTables, listKnownTables, listTableFiles, type KnownTable } from './known-tables.js';
import { FORK_EXE_NAME, createVpxLauncher, forkExeFor, forkMatchEnv, forkStreamEnv, launchEnv, planLaunch, type SpawnOptions } from './vpx-launch.js';

const TABLES = 'C:\\vpx\\tables';
const MANIFESTS = 'C:\\data\\witness\\tables';
const DATA = 'C:\\data\\witness';

function manifest(tableId: string, o: Partial<Manifest> = {}): Manifest {
  return {
    tableId,
    vpxPath: `${TABLES}\\${tableId}.vpx`,
    vpxSha256: null,
    vpxSize: 4,
    vpxMtimeMs: 1000,
    scriptSha256: 'aa',
    class: 'A',
    recipe: 'A',
    recipeVersion: '1.0.0',
    libVersion: '0.5.0',
    rom: null,
    sidecarPath: `${TABLES}\\${tableId}.vbs`,
    sidecarSha256: 'bb',
    anchors: {},
    warnings: [],
    renderedAt: '2026-11-01T00:00:00.000Z',
    verified: null,
    ...o,
  } as Manifest;
}

function disk(list: Manifest[]): MemoryFs {
  const fs = new MemoryFs();
  for (const m of list) {
    fs.put(`${MANIFESTS}\\${m.tableId}.json`, JSON.stringify(m));
    fs.put(m.vpxPath, 'vpx!', m.vpxMtimeMs);
  }
  return fs;
}

const known = (tableId: string, o: Partial<KnownTable> = {}): KnownTable => ({
  tableId,
  vpxPath: `${TABLES}\\${tableId}.vpx`,
  infoName: null,
  rom: null,
  sha256: null,
  imported: true,
  lastPlayedAt: null,
  patchedAt: null,
  ...o,
});

describe('known tables (A14)', () => {
  it('lists the imported tables whose file is still there, most recently played first, then most recently patched', async () => {
    const fs = disk([
      manifest('Attack from Mars', { renderedAt: '2026-11-02T00:00:00.000Z', rom: 'afm_113b' }),
      manifest('Monster Bash', { renderedAt: '2026-10-20T00:00:00.000Z', rom: 'mb_106b', vpxSha256: 'AB'.repeat(32) }),
      manifest('Medieval Madness', { renderedAt: '2026-11-03T00:00:00.000Z' }),
      manifest('Gone', { vpxPath: `${TABLES}\\Gone.vpx` }),
    ]);
    await fs.unlink(`${TABLES}\\Gone.vpx`);
    fs.put(`${MANIFESTS}\\notes.txt`, 'not a manifest');
    fs.put(`${MANIFESTS}\\broken.json`, '{');
    const recent = createRecentTables({ read: () => null, write: () => undefined });
    recent.note(`${TABLES}\\Monster Bash.vpx`, '2026-11-12T08:00:00.000Z');
    const list = await listKnownTables({ fs, manifestDir: MANIFESTS, dataDir: DATA, recent: recent.played });
    expect(list.map((t) => t.tableId)).toEqual(['Monster Bash', 'Medieval Madness', 'Attack from Mars']);
    expect(list[0]).toMatchObject({ rom: 'mb_106b', sha256: 'ab'.repeat(32), imported: true, lastPlayedAt: '2026-11-12T08:00:00.000Z' });
  });

  it("takes the table's own name and hash from the witness's cache when it has read the file; a re-saved file loses the manifest's hash", async () => {
    const fs = disk([manifest('mb_vpw', { vpxSha256: 'cd'.repeat(32) }), manifest('resaved', { vpxSha256: 'ef'.repeat(32), vpxMtimeMs: 1000 })]);
    fs.put(`${TABLES}\\resaved.vpx`, 'vpx!', 2000);
    const store = createIdentityStore(fs, DATA);
    await store.setFacts(store.key(`${TABLES}\\mb_vpw.vpx`, 4, 1000), {
      fileVersion: 1080,
      tableInfo: { tableName: 'Monster Bash', authorName: null, tableVersion: null, releaseDate: null, saveDate: null, saveRev: null, manufacturer: null, year: null, raw: {} },
      physics: null,
      scriptBytes: null,
      sha256: '12'.repeat(32),
      computedAt: '2026-11-01T00:00:00.000Z',
    });
    const list = await listKnownTables({ fs, manifestDir: MANIFESTS, dataDir: DATA });
    expect(list.find((t) => t.tableId === 'mb_vpw')).toMatchObject({ infoName: 'Monster Bash', sha256: '12'.repeat(32) });
    expect(list.find((t) => t.tableId === 'resaved')).toMatchObject({ infoName: null, sha256: null });
  });

  it('no manifest folder is an empty list; the folder scan finds other .vpx files one level down and skips the known ones', async () => {
    const fs = new MemoryFs();
    expect(await listKnownTables({ fs, manifestDir: MANIFESTS, dataDir: DATA })).toEqual([]);
    fs.put(`${TABLES}\\Twilight Zone.vpx`, 'x');
    fs.put(`${TABLES}\\Twilight Zone.vbs`, 'x');
    fs.put(`${TABLES}\\Monster Bash.vpx`, 'x');
    fs.put(`${TABLES}\\Williams\\Whirlwind.VPX`, 'x');
    fs.put(`${TABLES}\\Williams\\deep\\Hidden.vpx`, 'x');
    const files = await listTableFiles(fs, TABLES, [known('Monster Bash')]);
    expect(files.map((t) => [t.tableId, t.imported])).toEqual([
      ['Twilight Zone', false],
      ['Whirlwind', false],
    ]);
    expect(await listTableFiles(fs, null)).toEqual([]);
    expect(await listTableFiles(fs, 'C:\\nowhere')).toEqual([]);
  });

  it('recent tables: saved when the open table changes, read back, never more than the cap, a broken file is empty', () => {
    let text: string | null = '{ not json';
    let writes = 0;
    const io = { read: () => text, write: (t: string) => ((text = t), void writes++) };
    const r = createRecentTables(io);
    expect(r.played()).toEqual({});
    r.note('C:/vpx/tables/A.vpx', '2026-11-12T01:00:00.000Z');
    r.note('C:\\vpx\\tables\\a.vpx', '2026-11-12T02:00:00.000Z'); // the same file, still open: not written again
    r.note('C:\\vpx\\tables\\B.vpx', '2026-11-12T03:00:00.000Z');
    expect(writes).toBe(2);
    expect(createRecentTables(io).played()).toEqual({ 'c:\\vpx\\tables\\a.vpx': '2026-11-12T01:00:00.000Z', 'c:\\vpx\\tables\\b.vpx': '2026-11-12T03:00:00.000Z' });
  });
});

describe("the host's table on this PC (A14)", () => {
  const ZERO = '0'.repeat(64);
  const game = (tableName: string, tableHash = ZERO, romName: string | null = null) => ({ tableName, tableHash, romName });

  it('the same file wins over the same name; the same name wins by the whole name, then by the title', () => {
    const tables = [
      known('Monster Bash (Williams 1998) VPW 1.1'),
      known('mb_other', { sha256: 'ab'.repeat(32) }),
      known('Monster Bash (Williams 1998) 2.0', { infoName: 'Monster Bash' }),
    ];
    expect(findLocalTable(game('Monster Bash', 'AB'.repeat(32)), tables)).toMatchObject({ how: 'same_file', table: { tableId: 'mb_other' } });
    expect(findLocalTable(game('Monster Bash'), tables)).toMatchObject({ how: 'same_name', table: { tableId: 'Monster Bash (Williams 1998) 2.0' } });
    expect(findLocalTable(game('Monster Bash (Williams 1998) VPW 1.1'), tables)).toMatchObject({ how: 'same_name', table: { tableId: 'Monster Bash (Williams 1998) VPW 1.1' } });
    expect(findLocalTable(game('Monster Bash (Williams 1998) v3'), [tables[0]!])).toMatchObject({ how: 'same_name' });
  });

  it('an imported table is preferred to a file only found in the folder; within a rung the list order (most recent first) decides', () => {
    const found = known('Attack from Mars', { imported: false });
    const imported = known('Attack From Mars (Bally 1995)');
    // I11.4.11 review: an imported table (it can report ball ends) is never displaced by a file that is only found,
    // whatever its name: before, the whole name of a found file beat the title of an imported one.
    expect(findLocalTable(game('Attack from Mars'), [found, imported])?.table).toBe(imported);
    expect(findLocalTable(game('Attack from Mars'), [found])?.table).toBe(found);
    expect(findLocalTable(game('Attack from Mars (remake)'), [found, imported])?.table).toBe(imported);
    const a = known('Medieval Madness (Williams 1997) A');
    const b = known('Medieval Madness (Williams 1997) B');
    expect(findLocalTable(game('Medieval Madness'), [a, b])?.table).toBe(a);
  });

  it('a ROM in the fingerprint matches a table with that ROM; no table, an unknown name or the no-table fingerprint match nothing', () => {
    const tables = [known('mm_109c table', { rom: 'mm_109c' }), known('AFM')];
    expect(findLocalTable(game('Something else', ZERO, 'MM_109C'), tables)).toMatchObject({ how: 'same_rom' });
    expect(findLocalTable(game('Twilight Zone'), tables)).toBeNull();
    expect(findLocalTable(game('no table open'), tables)).toBeNull();
    expect(findLocalTable(game('..\\..\\Windows\\System32\\calc'), tables)).toBeNull();
    expect(findLocalTable(game('Monster Bash'), [])).toBeNull();
  });

  // I11.4.15: the match night of 2026-11-23. The host's Congo is table `769 fc87…`; the joining PC has two imported
  // copies, neither the host's bytes: the standard one (the same table objects: 3D ran) and a Mixed Reality mod
  // (`766 e4b9…`: 2D), and the mod had been played last.
  const HOST = { editables: 769, hash: 'fc87ddefd36bdd13' };
  const MOD = { editables: 766, hash: 'e4b9bf66f04cfcf9' };
  const CONGO = game('Congo (Williams 1995)', '90'.repeat(32));
  const evidence = (local: Array<[KnownTable, { editables: number; hash: string }]>, host: { editables: number; hash: string } | null = HOST) => ({ host, local: new Map(local.map(([t, id]) => [t.vpxPath, id] as const)) });

  it("I11.4.15: below the identical file the copies rank by their table objects: the host's, then not known, then others; the copy played last never wins over one with the host's objects", () => {
    const mod = known('Congo (Williams 1995) MR mod', { sha256: '6d'.repeat(32), lastPlayedAt: '2026-11-23T23:55:00.000Z' });
    const std = known('Congo (Williams 1995)_VPW_V1.0', { sha256: '34'.repeat(32), lastPlayedAt: '2026-11-20T00:00:00.000Z' });
    const unread = known('Congo (Williams 1995) other', { lastPlayedAt: '2026-11-24T00:00:00.000Z' });
    // As 0.2.50 picked: by the list's order, most recently played first.
    expect(findLocalTable(CONGO, [mod, std])).toMatchObject({ table: mod, how: 'same_name', objects: 'unknown' });
    // With the table objects known, in either order of the list: the copy that gives 3D.
    for (const list of [[mod, std], [std, mod]]) {
      expect(findLocalTable(CONGO, list, evidence([[mod, MOD], [std, HOST]]))).toMatchObject({ table: std, how: 'same_name', objects: 'same' });
    }
    // A copy whose objects are not known comes before one known to hold others, and after one with the host's.
    expect(findLocalTable(CONGO, [mod, unread], evidence([[mod, MOD]]))).toMatchObject({ table: unread, objects: 'unknown' });
    expect(findLocalTable(CONGO, [unread, mod, std], evidence([[mod, MOD], [std, HOST]]))).toMatchObject({ table: std, objects: 'same' });
    // Only copies with other objects: the first of them, said as that (the caller says 2D before the start).
    expect(findLocalTable(CONGO, [mod], evidence([[mod, MOD]]))).toMatchObject({ table: mod, objects: 'differs' });
    // The objects come before the name: a copy matched by its title alone, with the host's objects, wins over the whole name with others.
    const whole = known('Congo (Williams 1995)', { lastPlayedAt: '2026-11-24T00:00:00.000Z' });
    expect(findLocalTable(CONGO, [whole, std], evidence([[whole, MOD], [std, HOST]]))?.table).toBe(std);
    // The identical file stays first, whatever is known of the others, and is `same` by definition.
    const identical = known('congo_host_copy', { sha256: '90'.repeat(32) });
    expect(findLocalTable(CONGO, [std, identical], evidence([[std, HOST]]))).toMatchObject({ table: identical, how: 'same_file', objects: 'same' });
    // Where nothing separates two copies, the list's order (played last first) still decides.
    const a = known('Congo (Williams 1995) A');
    const b = known('Congo (Williams 1995) B');
    expect(findLocalTable(CONGO, [a, b], evidence([[a, HOST], [b, HOST]]))?.table).toBe(a);
    expect(findLocalTable(CONGO, [b, a], evidence([[a, MOD], [b, MOD]]))?.table).toBe(b);
    // A host that says no table objects (an older Castcade): what is known here proves nothing, the old order stands.
    expect(findLocalTable(CONGO, [mod, std], evidence([[mod, MOD], [std, HOST]], null))).toMatchObject({ table: mod, objects: 'unknown' });
  });

  it("I11.4.15: an imported table is still never displaced by one that is not: the imported copy is picked whatever its objects, and a copy with the host's objects (or the identical file) that was passed over is named", () => {
    const mod = known('Congo (Williams 1995) MR mod', { sha256: '6d'.repeat(32) });
    const plain = known('Congo (Williams 1995)_VPW_V1.0', { imported: false, sha256: '34'.repeat(32) });
    const identical = known('congo_host_copy', { imported: false, sha256: '90'.repeat(32) });
    // The imported copy holds other objects, a found one holds the host's: the imported one is started, the other named.
    const passed = findLocalTable(CONGO, [mod, plain], evidence([[mod, MOD], [plain, HOST]]));
    expect(passed).toMatchObject({ table: mod, objects: 'differs', sameObjects: plain });
    expect(passed?.identical).toBeUndefined();
    // The identical file is the better thing to name when it is there too.
    const both = findLocalTable(CONGO, [mod, plain, identical], evidence([[mod, MOD], [plain, HOST]]));
    expect(both).toMatchObject({ table: mod, objects: 'differs', identical });
    expect(both?.sameObjects).toBeUndefined();
    // The imported copy holds the host's objects: 3D works with it, so nothing is named, the identical file neither.
    const std = known('Congo (Williams 1995) standard', { sha256: '34'.repeat(32) });
    const fine = findLocalTable(CONGO, [std, identical], evidence([[std, HOST]]));
    expect(fine).toMatchObject({ table: std, objects: 'same' });
    expect(fine?.identical).toBeUndefined();
    // The imported copy's objects are not known: the identical file is named as before, a copy with the host's objects is not
    // (nothing says the imported one would not give 3D).
    expect(findLocalTable(CONGO, [mod, identical], evidence([]))).toMatchObject({ table: mod, objects: 'unknown', identical });
    expect(findLocalTable(CONGO, [mod, plain], evidence([[plain, HOST]]))?.sameObjects).toBeUndefined();
    // No imported copy at all: among the found ones, the one with the host's objects.
    const vr = known('Congo (Williams 1995) VR room', { imported: false });
    expect(findLocalTable(CONGO, [vr, plain], evidence([[vr, MOD], [plain, HOST]]))).toMatchObject({ table: plain, objects: 'same' });
    expect(sameObjectsNote('Congo (Williams 1995)_VPW_V1.0')).toBe('For 3D: "Congo (Williams 1995)_VPW_V1.0" on this PC holds the same table objects as the host\'s file and is not imported. Import it in Castcade and rejoin');
  });

  it("I11.4.15: the copies whose table objects are worth reading: every copy of the host's game, imported first, nothing else", () => {
    const mod = known('Congo (Williams 1995) MR mod');
    const found = known('Congo (Williams 1995) VR', { imported: false });
    const afm = known('Attack from Mars');
    const byHash = known('renamed copy', { sha256: '90'.repeat(32), imported: false });
    expect(objectsCandidates(CONGO, [found, afm, byHash, mod]).map((t) => t.tableId)).toEqual(['Congo (Williams 1995) MR mod', 'Congo (Williams 1995) VR', 'renamed copy']);
    expect(objectsCandidates(game('Twilight Zone'), [found, afm, mod])).toEqual([]);
  });

  it('titleOf: the words before the first bracket, without a version', () => {
    expect(titleOf('Monster Bash (Williams 1998) VPW v1.1')).toBe('monsterbash');
    expect(titleOf('Attack_from_Mars 2.0.1')).toBe('attackfrommars');
    expect(titleOf('Indiana Jones: The Pinball Adventure [VR]')).toBe('indianajonesthepinballadventure');
  });
});

describe('the VPX launcher (A14)', () => {
  const EXE = 'C:\\vpx\\VPinballX_GL64.exe';
  const TABLE = `${TABLES}\\Monster Bash (Williams 1998).vpx`;

  function launcher(o: { exe?: string | null; missing?: string[]; fail?: Error } = {}) {
    const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const logs: string[] = [];
    let unrefs = 0;
    const errorCbs: ((e: Error) => void)[] = [];
    const l = createVpxLauncher({
      spawn: (command, args, options) => {
        if (o.fail) throw o.fail;
        spawned.push({ command, args, options });
        return { pid: 4242, unref: () => void unrefs++, on: (_e, cb) => void errorCbs.push(cb) };
      },
      exists: async (p) => !(o.missing ?? []).includes(p),
      exe: () => (o.exe === undefined ? EXE : o.exe),
      log: (line) => void logs.push(line),
    });
    return { l, spawned, logs, unrefs: () => unrefs, errorCbs };
  }

  it('starts the remembered exe with -Play and the table, from the exe folder, with no shell, and lets it go', async () => {
    const t = launcher();
    expect(await t.l.launch(TABLE)).toEqual({ ok: true, pid: 4242 });
    expect(t.spawned).toEqual([{ command: EXE, args: ['-Play', TABLE], options: { cwd: 'C:\\vpx', detached: true, stdio: 'ignore', shell: false, windowsHide: false } }]);
    expect(t.unrefs()).toBe(1);
    // A late spawn error has a listener (it would end the app otherwise) and is logged.
    t.errorCbs[0]!(new Error('ENOENT'));
    expect(t.logs.at(-1)).toBe('launch: VPX did not start: ENOENT');
  });

  it('starts nothing without a VPX exe, with one that is not VPinballX, with a path that is not a table, or with a missing file', async () => {
    expect(await launcher({ exe: null }).l.launch(TABLE)).toMatchObject({ ok: false, reason: expect.stringContaining('does not know where VPX is') });
    for (const exe of ['C:\\Windows\\System32\\cmd.exe', 'VPinballX64.exe', 'C:\\vpx\\VPinballX64.exe.bat']) {
      const t = launcher({ exe });
      expect(await t.l.launch(TABLE)).toMatchObject({ ok: false });
      expect(t.spawned).toEqual([]);
    }
    for (const table of ['Monster Bash.vpx', 'C:\\vpx\\tables\\evil.exe', 'C:\\vpx\\tables\\a".vpx', 'C:\\vpx\\tables\\a.vpx\n-Minimized']) {
      const t = launcher();
      expect(await t.l.launch(table)).toEqual({ ok: false, reason: 'that is not a table file' });
      expect(t.spawned).toEqual([]);
    }
    const noExe = launcher({ missing: [EXE] });
    expect(await noExe.l.launch(TABLE)).toMatchObject({ ok: false, reason: expect.stringContaining('no longer there') });
    const noTable = launcher({ missing: [TABLE] });
    expect(await noTable.l.launch(TABLE)).toEqual({ ok: false, reason: 'the table file is no longer there' });
    expect([...noExe.spawned, ...noTable.spawned]).toEqual([]);
  });

  it('a spawn that throws is an answer, not an exception', async () => {
    const t = launcher({ fail: new Error('spawn EACCES') });
    expect(await t.l.launch(TABLE)).toEqual({ ok: false, reason: 'VPX did not start (spawn EACCES)' });
  });

  it('planLaunch is the whole command: two arguments, never a string to split', () => {
    expect(planLaunch(EXE, TABLE)).toEqual({ ok: true, plan: { command: EXE, args: ['-Play', TABLE], cwd: 'C:\\vpx' } });
  });
});

describe('the VPX fork launch (I11.4.1)', () => {
  const DIR = String.raw`C:\vpx`;
  const EXE = String.raw`C:\vpx\VPinballX_GL64.exe`;
  const FORK = String.raw`C:\vpx\VPinballX_GL64_castcade.exe`;
  const TABLE = String.raw`C:\vpx\tables\Nudge Test and Calibration.vpx`;

  it('the fork goes beside the VPX exe Castcade knows', () => {
    expect(forkExeFor(EXE)).toBe(FORK);
    expect(forkExeFor(FORK)).toBe(FORK);
    expect(FORK_EXE_NAME).toBe('VPinballX_GL64_castcade.exe');
    expect(forkExeFor(null)).toBeNull();
    expect(forkExeFor('VPinballX_GL64.exe')).toBeNull();
  });

  it('a player listens and a watcher connects, both on loopback, as the fork launchers set them', () => {
    expect(forkStreamEnv('play', 51000, 'play.log')).toEqual({ CASTCADE_STREAM: 'play', CASTCADE_STREAM_ADDR: 'listen:127.0.0.1:51000', CASTCADE_STREAM_LOG: 'play.log' });
    expect(forkStreamEnv('watch', 51001, 'watch.log')).toEqual({
      CASTCADE_STREAM: 'watch',
      CASTCADE_STREAM_ADDR: 'connect:127.0.0.1:51001',
      CASTCADE_STREAM_DELAY_MS: '100',
      CASTCADE_STREAM_SOUND: '1',
      CASTCADE_STREAM_LOG: 'watch.log',
    });
    expect(() => forkStreamEnv('play', 0, 'x')).toThrow();
  });

  it('I11.4.2: a match table: role match, the stream on loopback for the tunnel, the control connection to this companion, no sound replay, the delay', () => {
    expect(forkMatchEnv(51000, 51002, 'match.log')).toEqual({
      CASTCADE_STREAM: 'match',
      CASTCADE_STREAM_ADDR: 'listen:127.0.0.1:51000',
      CASTCADE_STREAM_CONTROL: 'connect:127.0.0.1:51002',
      CASTCADE_STREAM_SOUND: '0',
      CASTCADE_STREAM_DELAY_MS: '100',
      CASTCADE_STREAM_LOG: 'match.log',
    });
    expect(() => forkMatchEnv(0, 51002, 'x')).toThrow();
    expect(() => forkMatchEnv(51000, 65536, 'x')).toThrow();
    // An inherited control address (a Castcade started from a fork's own launcher) never reaches the child.
    expect(launchEnv({ PATH: 'Windows', CASTCADE_STREAM_CONTROL: 'connect:127.0.0.1:1' }, forkMatchEnv(51000, 51002, 'm.log')).CASTCADE_STREAM_CONTROL).toBe('connect:127.0.0.1:51002');
  });

  it("the child's environment drops inherited stream and test variables, whatever their case", () => {
    const env = launchEnv({ PATH: 'Windows', castcade_stream: 'watch', CASTCADE_TEST_INPUT: 'x', CASTCADE_TEST_NOPAUSE: '1', CASTCADE_OTHER: 'kept' }, { CASTCADE_STREAM: 'play' });
    expect(env).toEqual({ PATH: 'Windows', CASTCADE_OTHER: 'kept', CASTCADE_STREAM: 'play' });
  });

  it('planLaunch carries the environment only when asked', () => {
    expect(planLaunch(FORK, TABLE, { CASTCADE_STREAM: 'play' })).toEqual({ ok: true, plan: { command: FORK, args: ['-Play', TABLE], cwd: DIR, env: { CASTCADE_STREAM: 'play' } } });
    expect(planLaunch(EXE, TABLE)).toEqual({ ok: true, plan: { command: EXE, args: ['-Play', TABLE], cwd: DIR } });
  });

  function forkLauncher(missing: string[] = []) {
    const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const exits: Array<(code: number | null) => void> = [];
    const errors: Array<(e: Error) => void> = [];
    const logs: string[] = [];
    const l = createVpxLauncher({
      spawn: (command, args, options) => {
        spawned.push({ command, args, options });
        return {
          pid: 77,
          unref: () => undefined,
          on: (event: string, cb: (x: never) => void) => void (event === 'exit' ? exits.push(cb as (c: number | null) => void) : errors.push(cb as (e: Error) => void)),
        };
      },
      exists: async (p) => !missing.includes(p),
      exe: () => EXE,
      log: (line) => void logs.push(line),
      baseEnv: () => ({ PATH: 'Windows', CASTCADE_STREAM_ADDR: 'listen:47800' }),
    });
    return { l, spawned, exits, errors, logs };
  }

  it('starts the fork with the stream added to a clean environment, and hears it end once', async () => {
    const t = forkLauncher();
    const codes: Array<number | null> = [];
    const env = forkStreamEnv('watch', 51001, 'w.log');
    expect(await t.l.launch(TABLE, { exe: FORK, env, onExit: (c) => codes.push(c), what: 'as the 3D watch watcher' })).toEqual({ ok: true, pid: 77 });
    expect(t.spawned[0]).toEqual({ command: FORK, args: ['-Play', TABLE], options: { cwd: DIR, detached: true, stdio: 'ignore', shell: false, windowsHide: false, env: { PATH: 'Windows', ...env } } });
    expect(t.logs.at(-1)).toBe('launch: started VPX on Nudge Test and Calibration.vpx (VPinballX_GL64_castcade.exe -Play, pid 77) as the 3D watch watcher');
    t.exits[0]!(0);
    t.errors[0]!(new Error('late'));
    expect(codes).toEqual([0]);
  });

  it('a fork that is not there is said plainly, with its folder', async () => {
    const t = forkLauncher([FORK]);
    expect(await t.l.launch(TABLE, { exe: FORK })).toEqual({ ok: false, reason: `VPinballX_GL64_castcade.exe is not in ${DIR}` });
    expect(t.spawned).toEqual([]);
  });

  it('a spawn error counts as the end of a launch that wanted to hear it', async () => {
    const t = forkLauncher();
    const codes: Array<number | null> = [];
    await t.l.launch(TABLE, { exe: FORK, onExit: (c) => codes.push(c) });
    t.errors[0]!(new Error('ENOENT'));
    expect(codes).toEqual([null]);
  });
});
