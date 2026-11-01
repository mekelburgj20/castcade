import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import { LIB_VERSION, applyImport, planImport, sidecarPathFor, stalePathFor, readManifest, writeManifest, manifestPathFor, tableIdFor } from '../patcher/index.js';
import { ORIGINAL_B_SCRIPT, ORIGINAL_E_SCRIPT, VPM_SCRIPT, crlf } from '../patcher/test-scripts.test-support.js';
import { MemoryFs } from '../witness/fs.js';
import { ascii, buildVpx, codeRecord, concat, floatRecord, record, u32le } from '../witness/synth-vpx.test-support.js';
import { SidecarWatch } from './sidecar-watch.js';

const LIB = readFileSync(new URL('../../../vpx-hook/castcade.vbs', import.meta.url));
const TABLES = 'C:/VPX/tables';
const SCRIPTS = 'C:/VPX/scripts';
const MANIFESTS = 'C:/data/witness/tables';
const LIB_SRC = 'C:/app/resources/hook/castcade.vbs';
const MB = `${TABLES}/Monster Bash (Williams 1998) VPW 1.0.vpx`;
const vpx = (script: string, filler = 0) =>
  buildVpx({ gameData: concat(record('LEFT', u32le(0)), floatRecord('GAVT', 1.75), codeRecord(ascii(script)), record('ENDB', new Uint8Array(0))), fillerBytes: filler });

async function harness(opts: { imported?: boolean; liveSupportFor?: (rom: string) => Promise<{ readable: boolean; reason: string }> } = {}) {
  const clock = new ManualClock(new Date(2026, 9, 21, 13, 0, 0).getTime());
  const fs = new MemoryFs(() => clock.now());
  fs.put(LIB_SRC, LIB);
  await fs.mkdir(SCRIPTS);
  fs.put(MB, vpx(crlf(VPM_SCRIPT)), clock.now() - 86_400_000);
  if (opts.imported !== false) {
    const plan = await planImport(fs, { tablesDir: TABLES, manifestDir: MANIFESTS });
    await applyImport(fs, plan, { manifestDir: MANIFESTS, vpxScriptsDir: SCRIPTS, libSource: LIB_SRC, now: () => clock.now() });
  }
  const log: string[] = [];
  const notices: { title: string; body: string }[] = [];
  const watch = new SidecarWatch({
    fs,
    clock,
    intervalMs: 30_000,
    tablesDir: () => TABLES,
    scriptsDir: () => SCRIPTS,
    manifestDir: MANIFESTS,
    libSource: LIB_SRC,
    ...(opts.liveSupportFor ? { liveSupportFor: opts.liveSupportFor } : {}),
    log: (l) => log.push(l),
    notify: (title, body) => notices.push({ title, body }),
  });
  return { clock, fs, watch, log, notices };
}

const FREDDY = `${TABLES}/Freddy A Nightmare on Elm Street (Gottlieb 1994).vpx`;
const FREDDY_SCRIPT = VPM_SCRIPT.map((l) => l.replace('"mb_106b"', '"freddy"'));
const TNA = `${TABLES}/originals/TNA (JPSalas 2014).vpx`;

describe('SidecarWatch: new tables (C11)', () => {
  it('a new .vpx dropped into a folder that already has a patched table is patched on the next look, with one notice', async () => {
    const h = await harness();
    expect(await h.watch.tick()).toEqual([]);
    h.clock.advance(30_000);
    h.fs.put(FREDDY, vpx(crlf(FREDDY_SCRIPT)));
    const out = await h.watch.tick();
    expect(out).toEqual([{ vpxPath: FREDDY, result: 'patched', detail: expect.stringContaining('recipe A') }]);
    expect(h.fs.has(sidecarPathFor(FREDDY))).toBe(true);
    expect((await readManifest(h.fs, manifestPathFor(MANIFESTS, tableIdFor(FREDDY))))?.rom).toBe('freddy');
    expect(h.notices).toEqual([{ title: 'Castcade patched a new table', body: expect.stringMatching(/^Freddy A Nightmare on Elm Street \(Gottlieb 1994\) is patched \(recipe A\)/) }]);
    expect(h.log).toContain('sidecar watch: Freddy A Nightmare on Elm Street (Gottlieb 1994) patched (new table, recipe A)');
    // Quiet afterwards: the new sidecar is current.
    h.clock.advance(30_000);
    expect(await h.watch.tick()).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it('a new table on a machine whose live score cannot be read is not patched, and is not re-read on the following looks', async () => {
    const h = await harness({ liveSupportFor: async () => ({ readable: false, reason: 'gottlieb-system80: scores in CPU RAM' }) });
    await h.watch.tick();
    h.fs.put(FREDDY, vpx(crlf(FREDDY_SCRIPT)));
    const reads: string[] = [];
    const open = h.fs.open.bind(h.fs);
    h.fs.open = (p: string) => {
      reads.push(p);
      return open(p);
    };
    h.clock.advance(30_000);
    expect(await h.watch.tick()).toEqual([{ vpxPath: FREDDY, result: 'declined', detail: expect.stringContaining('unreadable: gottlieb-system80: scores in CPU RAM') }]);
    expect(h.fs.has(sidecarPathFor(FREDDY))).toBe(false);
    expect(reads.some((p) => p === FREDDY)).toBe(true);
    reads.length = 0;
    for (let i = 0; i < 3; i++) {
      h.clock.advance(30_000);
      expect(await h.watch.tick()).toEqual([]);
    }
    expect(reads.filter((p) => p === FREDDY)).toEqual([]);
    expect(h.notices).toEqual([]);
    // A changed file is planned again.
    h.fs.put(FREDDY, vpx(crlf([...FREDDY_SCRIPT, "' v2"]), 512));
    h.clock.advance(30_000);
    expect((await h.watch.tick()).map((o) => o.result)).toEqual(['declined']);
  });

  it('a never-imported folder gets nothing patched (the guard)', async () => {
    const h = await harness({ imported: false });
    expect(await h.watch.tick()).toEqual([]);
    h.fs.put(FREDDY, vpx(crlf(FREDDY_SCRIPT)));
    h.clock.advance(30_000);
    expect(await h.watch.tick()).toEqual([]);
    expect(h.fs.has(sidecarPathFor(MB))).toBe(false);
    expect(h.fs.has(sidecarPathFor(FREDDY))).toBe(false);
    expect(h.notices).toEqual([]);
  });

  it('the first look patches a table an older build skipped for lack of a recipe (class B, C1.1.3) when another table is patched', async () => {
    const h = await harness();
    h.fs.put(TNA, vpx(crlf(ORIGINAL_B_SCRIPT)), h.clock.now() - 86_400_000);
    const out = await h.watch.tick();
    expect(out).toEqual([{ vpxPath: TNA, result: 'patched', detail: expect.stringContaining('recipe B') }]);
    expect(h.fs.has(sidecarPathFor(TNA))).toBe(true);
    expect((await readManifest(h.fs, manifestPathFor(MANIFESTS, tableIdFor(TNA))))?.recipe).toBe('B');
    expect(h.notices).toEqual([{ title: 'Castcade patched a new table', body: expect.stringContaining('TNA (JPSalas 2014)') }]);
  });

  it('several new tables at once get one batch notice; an unpatchable one among them is declined quietly', async () => {
    const h = await harness();
    await h.watch.tick();
    const more = [`${TABLES}/Alpha (Williams 1990).vpx`, `${TABLES}/Beta (Bally 1991).vpx`, `${TABLES}/Gamma (Stern 2001).vpx`];
    for (const p of more) h.fs.put(p, vpx(crlf(VPM_SCRIPT)));
    h.fs.put(`${TABLES}/Generic Original.vpx`, vpx(crlf(ORIGINAL_E_SCRIPT)));
    h.clock.advance(30_000);
    const out = await h.watch.tick();
    expect(out.filter((o) => o.result === 'patched').map((o) => o.vpxPath).sort()).toEqual(more);
    expect(out.filter((o) => o.result === 'declined')).toEqual([{ vpxPath: `${TABLES}/Generic Original.vpx`, result: 'declined', detail: expect.stringContaining('skip') }]);
    expect(h.notices).toEqual([{ title: 'Castcade patched new tables', body: 'Castcade patched 3 new tables: every game on them posts live from their next launch.' }]);
  });

  it('a library that cannot be installed leaves the new table alone, and the next look tries again', async () => {
    const h = await harness();
    await h.watch.tick();
    h.fs.put(LIB_SRC, new TextEncoder().encode("' not the hook\n"));
    h.fs.put(FREDDY, vpx(crlf(FREDDY_SCRIPT)));
    h.clock.advance(30_000);
    expect((await h.watch.tick()).map((o) => o.result)).toEqual(['error']);
    expect(h.fs.has(sidecarPathFor(FREDDY))).toBe(false);
    h.fs.put(LIB_SRC, LIB);
    h.clock.advance(30_000);
    expect((await h.watch.tick()).map((o) => o.result)).toEqual(['patched']);
  });
});

describe('SidecarWatch', () => {
  it('a patched table that is unchanged is left alone on the first look and after', async () => {
    const h = await harness();
    expect(await h.watch.tick()).toEqual([]);
    h.clock.advance(30_000);
    expect(await h.watch.tick()).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.fs.has(sidecarPathFor(MB))).toBe(true);
  });

  it('a table updated in place (still a ROM table) gets its patch re-made and the player is told', async () => {
    const h = await harness();
    await h.watch.tick();
    const before = await readManifest(h.fs, manifestPathFor(MANIFESTS, tableIdFor(MB)));
    h.clock.advance(60_000);
    h.fs.put(MB, vpx(crlf([...VPM_SCRIPT, "' v2 of the table"]), 4096)); // new size and mtime
    const out = await h.watch.tick();
    expect(out).toEqual([{ vpxPath: MB, result: 'repatched', detail: expect.stringContaining('re-made') }]);
    expect(h.notices).toEqual([{ title: 'Castcade re-patched a table', body: expect.stringContaining('Monster Bash') }]);
    const after = await readManifest(h.fs, manifestPathFor(MANIFESTS, tableIdFor(MB)));
    expect(after?.vpxSha256).not.toBe(before?.vpxSha256);
    expect(h.fs.has(sidecarPathFor(MB))).toBe(true);
    expect(h.fs.has(stalePathFor(MB))).toBe(false);
    // Quiet again afterwards.
    h.clock.advance(30_000);
    expect(await h.watch.tick()).toEqual([]);
  });

  it("C10: a table saved from the VPX editor (its own script is now the sidecar's) gets a fresh patch over it, not a refusal", async () => {
    const h = await harness();
    await h.watch.tick();
    const sidecar = Buffer.from(await h.fs.readFile(sidecarPathFor(MB))).toString('latin1');
    h.clock.advance(60_000);
    h.fs.put(MB, vpx(sidecar, 4096)); // the editor saved the sidecar's text into the .vpx; the .vbs it rewrote reads the same
    const out = await h.watch.tick();
    expect(out).toEqual([{ vpxPath: MB, result: 'repatched', detail: expect.stringContaining('re-made') }]);
    const fresh = Buffer.from(await h.fs.readFile(sidecarPathFor(MB))).toString('latin1');
    expect(fresh.match(/Castcade_Init /g)).toHaveLength(1);
    expect(fresh).toContain('Castcade_Guard ');
    expect(h.fs.has(stalePathFor(MB))).toBe(false);
    h.clock.advance(30_000);
    expect(await h.watch.tick()).toEqual([]);
  });

  it('a table replaced by an original (no recipe yet) has its patch disabled, not re-made', async () => {
    const h = await harness();
    await h.watch.tick();
    h.clock.advance(60_000);
    h.fs.put(MB, vpx(crlf(ORIGINAL_E_SCRIPT))); // class E: still no recipe since C1.1 gave B/C/D theirs
    const out = await h.watch.tick();
    expect(out).toEqual([{ vpxPath: MB, result: 'disabled', detail: expect.stringContaining('Re-import') }]);
    expect(h.fs.has(sidecarPathFor(MB))).toBe(false);
    expect(h.fs.has(stalePathFor(MB))).toBe(true);
    expect(h.notices[0]?.title).toBe('Castcade patch disabled');
  });

  it('the first look catches a table that changed while the companion was not running', async () => {
    const h = await harness();
    h.clock.advance(60_000);
    h.fs.put(MB, vpx(crlf([...VPM_SCRIPT, "' changed offline"]), 1024));
    const out = await h.watch.tick();
    expect(out.map((o) => o.result)).toEqual(['repatched']);
  });

  it('a new companion build (older lib in every manifest) re-makes all patches as one batch with one notice', async () => {
    const h = await harness();
    const TZ = `${TABLES}/Tales from the Crypt (Data East 1993).vpx`;
    h.fs.put(TZ, vpx(crlf(VPM_SCRIPT)), h.clock.now() - 86_400_000);
    await applyImport(h.fs, await planImport(h.fs, { paths: [TZ], manifestDir: MANIFESTS }), { manifestDir: MANIFESTS, vpxScriptsDir: SCRIPTS, libSource: LIB_SRC, now: () => h.clock.now() });
    for (const p of [MB, TZ]) {
      const m = await readManifest(h.fs, manifestPathFor(MANIFESTS, tableIdFor(p)));
      if (!m) throw new Error('no manifest');
      await writeManifest(h.fs, manifestPathFor(MANIFESTS, tableIdFor(p)), { ...m, libVersion: '0.2.0', recipeVersion: '0.2.0' });
    }
    const out = await h.watch.tick();
    expect(out.map((o) => o.result)).toEqual(['repatched', 'repatched']);
    expect(out[0]?.detail).toContain(`re-made for hook ${LIB_VERSION}`);
    expect(h.notices).toEqual([{ title: 'Castcade updated its table patches', body: `2 table patches re-made for hook ${LIB_VERSION}; nothing to do.` }]);
    for (const p of [MB, TZ]) expect((await readManifest(h.fs, manifestPathFor(MANIFESTS, tableIdFor(p))))?.libVersion).toBe(LIB_VERSION);
    expect(h.log.filter((l) => l.includes('is stale'))).toHaveLength(2);
    h.clock.advance(30_000);
    expect(await h.watch.tick()).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it('every look runs under the shared lock, so it waits for an import in progress', async () => {
    const h = await harness();
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered = 0;
    const watch = new SidecarWatch({
      fs: h.fs,
      clock: h.clock,
      tablesDir: () => TABLES,
      scriptsDir: () => SCRIPTS,
      manifestDir: MANIFESTS,
      libSource: LIB_SRC,
      exclusive: async (fn) => {
        entered++;
        await held;
        return fn();
      },
      log: () => {},
    });
    let settled = false;
    const tick = watch.tick().then((o) => {
      settled = true;
      return o;
    });
    await Promise.resolve();
    expect(entered).toBe(1);
    expect(settled).toBe(false);
    release?.();
    expect(await tick).toEqual([]);
  });

  it('runs on the clock, and a missing folder is not an error', async () => {
    const h = await harness();
    h.watch.start();
    h.clock.advance(0);
    await h.watch.tick();
    h.watch.stop();
    expect(h.clock.pending()).toBe(0);
    const empty = new SidecarWatch({ fs: new MemoryFs(), tablesDir: () => 'C:/nowhere', scriptsDir: () => null, manifestDir: MANIFESTS, libSource: LIB_SRC, log: () => {} });
    expect(await empty.tick()).toEqual([]);
  });
});
