import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '../witness/fs.js';
import { ascii, buildVpx, codeRecord, concat, floatRecord, record, u32le } from '../witness/synth-vpx.test-support.js';
import { applyImport, checkSidecar, disableSidecar, installLibrary, listVpxFiles, planImport, removeAllSidecars, type PlanItem } from './import.js';
import { readManifest } from './manifest.js';
import { manifestPathFor, sidecarPathFor, stalePathFor, tableIdFor } from './paths.js';
import { LIB_VERSION, RECIPE_VERSION, formatLocalStamp } from './render.js';
import { NO_KEYDOWN_SCRIPT, ORIGINAL_B_SCRIPT, PATCHED_VPM_SCRIPT, VPM_DECLARED_SCRIPT, VPM_SCRIPT, crlf, lf } from './test-scripts.test-support.js';

const LIB = readFileSync(new URL('../../../vpx-hook/castcade.vbs', import.meta.url));

const TABLES = 'C:/VPX/tables';
const SCRIPTS = 'C:/VPX/scripts';
const MANIFESTS = 'C:/Users/me/AppData/Local/Castcade/tables';
const LIB_SRC = 'C:/app/resources/hook/castcade.vbs';

const MB = `${TABLES}/Monster Bash (Williams 1998) VPW 1.0.vpx`;
const AFM = `${TABLES}/Attack from Mars (Midway 1995).vpx`;
const IRON = `${TABLES}/Iron Maiden (Original 2022).vpx`;
const FOREIGN = `${TABLES}/Foreign Table (Bally 1980).vpx`;
const NOKEYS = `${TABLES}/Test Table.vpx`;
const BROKEN = `${TABLES}/broken.vpx`;
const PATCHED = `${TABLES}/Already (Williams 1990).vpx`;

const vpxWithScript = (script: string, filler = 0): Uint8Array =>
  buildVpx({
    gameData: concat(record('LEFT', u32le(0)), floatRecord('GAVT', 1.75), codeRecord(ascii(script)), record('ENDB', new Uint8Array(0))),
    fillerBytes: filler,
  });

const T0 = new Date(2026, 9, 21, 13, 5, 9).getTime();

let now = T0;
let fs: MemoryFs;

const applyOpts = { manifestDir: MANIFESTS, vpxScriptsDir: SCRIPTS, libSource: LIB_SRC, now: () => now };
const byPath = (items: PlanItem[], p: string): PlanItem => {
  const it = items.find((i) => i.vpxPath === p);
  if (!it) throw new Error(`no plan item for ${p}`);
  return it;
};

beforeEach(() => {
  now = T0;
  fs = new MemoryFs(() => now);
  fs.put(LIB_SRC, LIB);
  fs.mkdir(SCRIPTS);
  fs.put(`${SCRIPTS}/core.vbs`, "' core");
  fs.put(MB, vpxWithScript(crlf(VPM_SCRIPT)), T0 - 86_400_000);
  fs.put(AFM, vpxWithScript(lf(VPM_DECLARED_SCRIPT)), T0 - 3_600_000);
  fs.put(IRON, vpxWithScript(crlf(ORIGINAL_B_SCRIPT)));
  fs.put(FOREIGN, vpxWithScript(crlf(VPM_SCRIPT)));
  fs.put(sidecarPathFor(FOREIGN), "' somebody else's external script\r\nSub Table1_KeyDown(ByVal k)\r\nEnd Sub\r\n");
  fs.put(NOKEYS, vpxWithScript(lf(NO_KEYDOWN_SCRIPT)));
  fs.put(BROKEN, new Uint8Array(4096).fill(0x42));
  fs.put(PATCHED, vpxWithScript(lf(PATCHED_VPM_SCRIPT)));
  fs.put(`${TABLES}/readme.txt`, 'not a table');
  fs.put(`${TABLES}/Iron Maiden (Original 2022).directb2s`, '<xml/>');
});

describe('planImport (dry run)', () => {
  it('classifies the folder, counts per action and writes nothing', async () => {
    const before = [...(await fs.readdir(TABLES))];
    const plan = await planImport(fs, { tablesDir: TABLES, manifestDir: MANIFESTS });
    expect(plan.counts).toEqual({ patch: 2, repatch: 0, already: 1, skip: 1, foreign: 1, unsupported: 2, unreadable: 0 });
    expect(plan.items.map((i) => i.vpxPath)).toEqual([...plan.items.map((i) => i.vpxPath)].sort());

    const mb = byPath(plan.items, MB);
    expect(mb).toMatchObject({ action: 'patch', cls: 'A', rom: 'mb_106b', tableId: 'Monster Bash (Williams 1998) VPW 1.0' });
    expect(byPath(plan.items, AFM)).toMatchObject({ action: 'patch', cls: 'A', rom: 'afm_113b' });
    const iron = byPath(plan.items, IRON);
    expect(iron).toMatchObject({ action: 'skip', cls: 'B', rom: null });
    expect(iron.reason).toBe('original table (JPSalas pattern) (class B): recipe B/C not built yet');
    const foreign = byPath(plan.items, FOREIGN);
    expect(foreign).toMatchObject({ action: 'foreign', cls: null });
    expect(foreign.reason).toMatch(/not Castcade's; left alone/);
    expect(byPath(plan.items, NOKEYS)).toMatchObject({ action: 'unsupported', cls: 'X', reason: 'no _KeyDown handler' });
    const broken = byPath(plan.items, BROKEN);
    expect(broken.action).toBe('unsupported');
    expect(broken.reason).toMatch(/cannot read the table/);
    expect(byPath(plan.items, PATCHED)).toMatchObject({ action: 'already', reason: 'the embedded script already contains Castcade_Init' });

    expect(await fs.readdir(TABLES)).toEqual(before);
    expect(fs.has(`${SCRIPTS}/castcade.vbs`)).toBe(false);
  });

  it('takes explicit paths too, ignoring non-.vpx names, and lists subfolders only when recursive', async () => {
    fs.put(`${TABLES}/sub/Deep (Stern 2001).vpx`, vpxWithScript(crlf(VPM_SCRIPT)));
    expect(await listVpxFiles(fs, TABLES)).not.toContain(`${TABLES}/sub/Deep (Stern 2001).vpx`);
    expect(await listVpxFiles(fs, TABLES, true)).toContain(`${TABLES}/sub/Deep (Stern 2001).vpx`);
    const plan = await planImport(fs, { paths: [MB, `${TABLES}/readme.txt`], manifestDir: MANIFESTS });
    expect(plan.items.map((i) => i.vpxPath)).toEqual([MB]);
    await expect(planImport(fs, { manifestDir: MANIFESTS })).rejects.toThrow(/tablesDir/);
  });
});

describe('applyImport', () => {
  it('writes sidecar + manifest for recipe-A items, installs the library once, then reports already', async () => {
    const plan = await planImport(fs, { tablesDir: TABLES, manifestDir: MANIFESTS });
    const progress: [number, number, string][] = [];
    now = T0 + 5000;
    const res = await applyImport(fs, plan, { ...applyOpts, onProgress: (d, t, it) => progress.push([d, t, it.tableId]) });
    expect(res.libInstalled).toBe('installed');
    expect(res.patched.sort()).toEqual([AFM, MB].sort());
    expect(res.failed).toEqual([]);
    expect(res.skipped.map((i) => i.action).sort()).toEqual(['already', 'foreign', 'skip', 'unsupported', 'unsupported']);
    expect(progress.map(([d, t]) => [d, t])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(await fs.readFile(`${SCRIPTS}/castcade.vbs`)).toEqual(new Uint8Array(LIB));

    const sidecar = fs.text(sidecarPathFor(MB));
    expect(sidecar).not.toBeNull();
    expect(sidecar).toContain(`Castcade_Guard "${MB}", ${(await fs.stat(MB)).size}, "${formatLocalStamp(T0 - 86_400_000)}", "${sidecarPathFor(MB)}"`);
    expect(sidecar).toContain('Castcade_Init "Monster Bash (Williams 1998) VPW 1.0", "A"');
    expect(sidecar?.includes('\r\n')).toBe(true);
    expect(fs.text(sidecarPathFor(FOREIGN))).toMatch(/^' somebody else's/);
    expect(fs.has(sidecarPathFor(IRON))).toBe(false);
    // the .vpx files were not touched
    expect(await fs.stat(MB)).toEqual({ size: (await fs.stat(MB)).size, mtimeMs: T0 - 86_400_000 });

    const manifest = await readManifest(fs, manifestPathFor(MANIFESTS, tableIdFor(MB)));
    expect(manifest).toMatchObject({
      tableId: 'Monster Bash (Williams 1998) VPW 1.0',
      vpxPath: MB,
      vpxSize: (await fs.stat(MB)).size,
      vpxMtimeMs: T0 - 86_400_000,
      class: 'A',
      recipe: 'A',
      recipeVersion: RECIPE_VERSION,
      libVersion: LIB_VERSION,
      rom: 'mb_106b',
      sidecarPath: sidecarPathFor(MB),
      warnings: [],
      renderedAt: new Date(T0 + 5000).toISOString(),
      verified: null,
    });
    expect(manifest?.vpxSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest?.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest?.sidecarSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest?.anchors['block0']).toBe('after Option Explicit (line 1)');
    expect(manifestPathFor(MANIFESTS, tableIdFor(MB))).toBe(`${MANIFESTS}/Monster_Bash_Williams_1998_VPW_1.0.json`);

    // second pass: nothing to do
    const plan2 = await planImport(fs, { tablesDir: TABLES, manifestDir: MANIFESTS });
    expect(plan2.counts).toEqual({ patch: 0, repatch: 0, already: 3, skip: 1, foreign: 1, unsupported: 2, unreadable: 0 });
    expect(byPath(plan2.items, MB).reason).toBe(`sidecar current (recipe ${RECIPE_VERSION}, lib ${LIB_VERSION})`);
    const res2 = await applyImport(fs, plan2, applyOpts);
    expect(res2).toMatchObject({ patched: [], failed: [], libInstalled: 'unchanged' });
    expect(await checkSidecar(fs, MB, MANIFESTS)).toMatchObject({ state: 'ok' });
  });

  it('hashOriginals: false leaves vpxSha256 null, and an mtime change is then stale', async () => {
    const plan = await planImport(fs, { paths: [MB], manifestDir: MANIFESTS });
    await applyImport(fs, plan, { ...applyOpts, hashOriginals: false });
    expect((await readManifest(fs, manifestPathFor(MANIFESTS, tableIdFor(MB))))?.vpxSha256).toBeNull();
    fs.put(MB, await fs.readFile(MB), T0 - 86_400_000 + 10_000);
    expect(await checkSidecar(fs, MB, MANIFESTS)).toMatchObject({ state: 'stale', why: expect.stringMatching(/no hash/) });
  });

  it('installLibrary compares bytes and refuses a library of another version', async () => {
    expect(await installLibrary(fs, LIB_SRC, SCRIPTS)).toBe('installed');
    expect(await installLibrary(fs, LIB_SRC, SCRIPTS)).toBe('unchanged');
    fs.put(`${SCRIPTS}/castcade.vbs`, 'older');
    expect(await installLibrary(fs, LIB_SRC, SCRIPTS)).toBe('updated');
    fs.put('C:/old.vbs', 'Dim Castcade_LibVersion : Castcade_LibVersion = "0.1.0"\n');
    await expect(installLibrary(fs, 'C:/old.vbs', SCRIPTS)).rejects.toThrow(/0\.1\.0.*0\.4\.0/);
    fs.put('C:/none.vbs', "' nothing");
    await expect(installLibrary(fs, 'C:/none.vbs', SCRIPTS)).rejects.toThrow(/\(none\)/);
  });
});

describe('stale-sidecar guard (companion side)', () => {
  beforeEach(async () => {
    const plan = await planImport(fs, { paths: [MB, AFM], manifestDir: MANIFESTS });
    await applyImport(fs, plan, applyOpts);
  });

  it('a new table version (size changed) is stale → repatch, and apply heals it', async () => {
    fs.put(MB, vpxWithScript(crlf([...VPM_SCRIPT, "' v1.1"]), 4096), T0 + 1000);
    const check = await checkSidecar(fs, MB, MANIFESTS);
    expect(check.state).toBe('stale');
    if (check.state === 'stale') expect(check.why).toMatch(/^size \d+ vs \d+/);
    const plan = await planImport(fs, { paths: [MB], manifestDir: MANIFESTS });
    expect(byPath(plan.items, MB).action).toBe('repatch');
    const res = await applyImport(fs, plan, applyOpts);
    expect(res.patched).toEqual([MB]);
    expect(res.libInstalled).toBe('unchanged');
    expect(await checkSidecar(fs, MB, MANIFESTS)).toMatchObject({ state: 'ok' });
    expect(fs.text(sidecarPathFor(MB))).toContain(`"${formatLocalStamp(T0 + 1000)}"`);
  });

  it('same bytes, moved mtime: hash confirms ok, but a move beyond the guard tolerance re-renders the stamp', async () => {
    const bytes = await fs.readFile(MB);
    fs.put(MB, bytes, T0 - 86_400_000 + 10_000);
    expect(await checkSidecar(fs, MB, MANIFESTS)).toMatchObject({ state: 'ok' });
    expect(byPath((await planImport(fs, { paths: [MB], manifestDir: MANIFESTS })).items, MB).action).toBe('already');
    fs.put(MB, bytes, T0 - 86_400_000 + 2 * 3_600_000);
    expect(await checkSidecar(fs, MB, MANIFESTS)).toMatchObject({ state: 'ok' });
    const it = byPath((await planImport(fs, { paths: [MB], manifestDir: MANIFESTS })).items, MB);
    expect(it.action).toBe('repatch');
    expect(it.reason).toMatch(/timestamp moved 7200 s/);
  });

  it('same size, different bytes, moved mtime: the hash catches it', async () => {
    const bytes = await fs.readFile(MB);
    bytes[bytes.length - 1] ^= 0xff;
    fs.put(MB, bytes, T0);
    expect(await checkSidecar(fs, MB, MANIFESTS)).toMatchObject({ state: 'stale', why: 'sha256 of the .vpx differs from the manifest' });
  });

  it('an older recipe/lib version, a hand-edited sidecar, or a missing manifest is stale', async () => {
    const mp = manifestPathFor(MANIFESTS, tableIdFor(MB));
    const m = await readManifest(fs, mp);
    fs.put(mp, JSON.stringify({ ...m, libVersion: '0.1.0' }));
    expect(await checkSidecar(fs, MB, MANIFESTS)).toMatchObject({ state: 'stale', why: expect.stringMatching(/lib 0\.1\.0/) });
    fs.put(mp, JSON.stringify(m));
    fs.put(sidecarPathFor(MB), (fs.text(sidecarPathFor(MB)) ?? '') + "' edited\r\n");
    expect(await checkSidecar(fs, MB, MANIFESTS)).toMatchObject({ state: 'stale', why: expect.stringMatching(/edited by hand/) });
    await fs.unlink(mp);
    expect(await checkSidecar(fs, MB, MANIFESTS)).toMatchObject({ state: 'stale', manifest: null, why: 'no manifest for this sidecar' });
    expect(byPath((await planImport(fs, { paths: [MB], manifestDir: MANIFESTS })).items, MB).action).toBe('repatch');
  });

  it('checkSidecar reports none / foreign / disabled', async () => {
    expect(await checkSidecar(fs, IRON, MANIFESTS)).toEqual({ state: 'none' });
    expect(await checkSidecar(fs, FOREIGN, MANIFESTS)).toEqual({ state: 'foreign' });
    const stale = await disableSidecar(fs, MB);
    expect(stale).toBe(stalePathFor(MB));
    expect(fs.has(sidecarPathFor(MB))).toBe(false);
    expect(fs.text(stale)).toContain('Castcade_Init');
    expect(await checkSidecar(fs, MB, MANIFESTS)).toEqual({ state: 'disabled', stalePath: stale });
  });

  it('disableSidecar replaces an older .stale, refuses a foreign .vbs; a disabled table plans as patch and apply removes the .stale', async () => {
    fs.put(stalePathFor(MB), 'old stale');
    await disableSidecar(fs, MB);
    expect(fs.text(stalePathFor(MB))).not.toBe('old stale');
    await expect(disableSidecar(fs, FOREIGN)).rejects.toThrow(/not a Castcade sidecar/);
    expect(fs.has(sidecarPathFor(FOREIGN))).toBe(true);

    const plan = await planImport(fs, { paths: [MB], manifestDir: MANIFESTS });
    const it = byPath(plan.items, MB);
    expect(it.action).toBe('patch');
    expect(it.reason).toMatch(/disabled as stale/);
    await applyImport(fs, plan, applyOpts);
    expect(fs.has(sidecarPathFor(MB))).toBe(true);
    expect(fs.has(stalePathFor(MB))).toBe(false);
  });

  it('removeAllSidecars deletes ours (.vbs and .vbs.stale) with their manifests and keeps foreign files', async () => {
    await disableSidecar(fs, AFM);
    fs.put(`${TABLES}/sub/Deep (Stern 2001).vbs`, "' --- Castcade (recipe A v0.1.0, lib 0.1.0) --- do not edit\nCastcade_Init \"Deep\", \"A\", \"0.1.0\", \"\"\n");
    const res = await removeAllSidecars(fs, { tablesDir: TABLES, manifestDir: MANIFESTS, recursive: true });
    expect(res.removed.sort()).toEqual(
      [sidecarPathFor(MB), manifestPathFor(MANIFESTS, tableIdFor(MB)), stalePathFor(AFM), manifestPathFor(MANIFESTS, tableIdFor(AFM)), `${TABLES}/sub/Deep (Stern 2001).vbs`].sort(),
    );
    expect(res.keptForeign).toEqual([sidecarPathFor(FOREIGN)]);
    expect(fs.has(sidecarPathFor(FOREIGN))).toBe(true);
    expect(fs.has(sidecarPathFor(MB))).toBe(false);
    expect(fs.has(stalePathFor(AFM))).toBe(false);
    expect(fs.has(manifestPathFor(MANIFESTS, tableIdFor(MB)))).toBe(false);
    for (const p of [MB, AFM, IRON, FOREIGN, NOKEYS, BROKEN, PATCHED]) expect(fs.has(p)).toBe(true);
    expect(fs.has(`${SCRIPTS}/castcade.vbs`)).toBe(true); // the library stays; the owner can delete it
  });
});

describe('watch list through applyImport', () => {
  it('asks watchOffsetsFor per ROM and bakes the answer into the sidecar', async () => {
    const asked: string[] = [];
    const plan = await planImport(fs, { paths: [MB], manifestDir: MANIFESTS });
    await applyImport(fs, plan, {
      ...applyOpts,
      watchOffsetsFor: async (rom) => {
        asked.push(rom);
        return [5792, 5793, 5901];
      },
    });
    expect(asked).toEqual(['mb_106b']);
    expect(fs.text(sidecarPathFor(MB))).toContain('Castcade_WatchBytes Array(5792, 5793, 5901)');
  });

  it('without watchOffsetsFor the sidecar carries no watch list', async () => {
    const plan = await planImport(fs, { paths: [MB], manifestDir: MANIFESTS });
    await applyImport(fs, plan, applyOpts);
    expect(fs.text(sidecarPathFor(MB))).not.toMatch(/^Castcade_WatchBytes Array/m); // the STUB names the sub; no call line
  });
});

describe('B12: machines whose live score the hook cannot see', () => {
  const cpuRam = async (rom: string) =>
    rom === 'mb_106b' ? { readable: false, reason: 'gottlieb-system80: scores, game_over, current_ball, current_player in CPU RAM' } : { readable: true, reason: 'live fields in NVRAM' };

  it('plans such a table as unreadable with the reason, and the apply leaves it unpatched', async () => {
    const asked: string[] = [];
    const plan = await planImport(fs, {
      paths: [MB, AFM],
      manifestDir: MANIFESTS,
      liveSupportFor: async (rom) => {
        asked.push(rom);
        return cpuRam(rom);
      },
    });
    expect(asked.sort()).toEqual(['afm_113b', 'mb_106b']);
    expect(byPath(plan.items, MB)).toMatchObject({ action: 'unreadable', rom: 'mb_106b', reason: 'gottlieb-system80: scores, game_over, current_ball, current_player in CPU RAM' });
    expect(byPath(plan.items, AFM).action).toBe('patch');
    expect(plan.counts.unreadable).toBe(1);
    const res = await applyImport(fs, plan, applyOpts);
    expect(res.patched).toEqual([AFM]);
    expect(fs.has(sidecarPathFor(MB))).toBe(false);
  });

  it('a table patched before the rule is unreadable, not "already patched", and says its sidecar remains', async () => {
    await applyImport(fs, await planImport(fs, { paths: [MB], manifestDir: MANIFESTS }), applyOpts);
    const plan = await planImport(fs, { paths: [MB], manifestDir: MANIFESTS, liveSupportFor: cpuRam });
    expect(byPath(plan.items, MB).action).toBe('unreadable');
    expect(byPath(plan.items, MB).reason).toMatch(/an existing Castcade sidecar remains/);
  });

  it('is never asked about a table with no ROM name or a script that is not recipe A', async () => {
    const asked: string[] = [];
    const plan = await planImport(fs, { paths: [IRON, NOKEYS], manifestDir: MANIFESTS, liveSupportFor: async (rom) => (asked.push(rom), cpuRam(rom)) });
    expect(asked).toEqual([]);
    expect(plan.counts.unreadable).toBe(0);
  });
});
