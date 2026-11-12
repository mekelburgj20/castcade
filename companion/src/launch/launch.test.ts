/**
 * A14 (2026-11-12): the launch module without a process or a real disk: the known-table list (manifests on a
 * `MemoryFs`), the table lookup for a host's game, and the VPX launcher with a fake spawner.
 */
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../patcher/index.js';
import { MemoryFs } from '../witness/fs.js';
import { createIdentityStore } from '../witness/identity-store.js';
import { findLocalTable, titleOf } from './find-table.js';
import { createRecentTables, listKnownTables, listTableFiles, type KnownTable } from './known-tables.js';
import { createVpxLauncher, planLaunch, type SpawnOptions } from './vpx-launch.js';

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
    expect(findLocalTable(game('Attack from Mars'), [found, imported])?.table).toBe(found); // the whole name beats the title alone
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
