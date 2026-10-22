import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import { applyImport, planImport, sidecarPathFor, stalePathFor, readManifest, manifestPathFor, tableIdFor } from '../patcher/index.js';
import { ORIGINAL_B_SCRIPT, VPM_SCRIPT, crlf } from '../patcher/test-scripts.test-support.js';
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

async function harness() {
  const clock = new ManualClock(new Date(2026, 9, 21, 13, 0, 0).getTime());
  const fs = new MemoryFs(() => clock.now());
  fs.put(LIB_SRC, LIB);
  await fs.mkdir(SCRIPTS);
  fs.put(MB, vpx(crlf(VPM_SCRIPT)), clock.now() - 86_400_000);
  const plan = await planImport(fs, { tablesDir: TABLES, manifestDir: MANIFESTS });
  await applyImport(fs, plan, { manifestDir: MANIFESTS, vpxScriptsDir: SCRIPTS, libSource: LIB_SRC, now: () => clock.now() });
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
    log: (l) => log.push(l),
    notify: (title, body) => notices.push({ title, body }),
  });
  return { clock, fs, watch, log, notices };
}

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

  it('a table replaced by an original (no recipe yet) has its patch disabled, not re-made', async () => {
    const h = await harness();
    await h.watch.tick();
    h.clock.advance(60_000);
    h.fs.put(MB, vpx(crlf(ORIGINAL_B_SCRIPT)));
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
