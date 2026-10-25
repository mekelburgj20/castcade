import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import { createIdentityResolver } from './identity-resolver.js';
import { createIdentityStore } from './identity-store.js';
import { buildOwnerStyleVpx } from './synth-vpx.test-support.js';
import { createVpsIndex } from './vps-index.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const MB_PATH = 'C:\\VPX\\tables\\Monster Bash (Williams 1998) VPWmod v1.0.vpx';
const MB_BYTES = buildOwnerStyleVpx({ tableName: 'Monster Bash VPW Mod', author: 'VPW', version: '1.0', manufacturer: 'Williams', year: '1998' });
const MB_SHA = createHash('sha256').update(MB_BYTES).digest('hex');

function rig() {
  const fs = new MemoryFs(() => 1_760_000_000_000);
  fs.put(MB_PATH, MB_BYTES, 1_767_673_167_962);
  // A bare copy nobody filled TableInfo for, with a name that fits every VPX table of the game.
  fs.put('C:\\VPX\\tables\\Monster Bash (Williams 1998).vpx', buildOwnerStyleVpx({ tableName: '', author: '', version: '' }), 1_767_673_167_000);
  const index = createVpsIndex(repo('fixtures/vps')); // the committed fixture, read from disk
  const store = createIdentityStore(fs, '/data');
  const log: string[] = [];
  const resolver = createIdentityResolver({ fs, index, store, now: () => 1_760_000_000_000, log: (l) => log.push(l) });
  return { fs, index, store, resolver, log };
}

describe('identity resolver', () => {
  it("resolves the owner's Monster Bash file to the VPS game and the VPW table from TableInfo, then hashes it", async () => {
    const { resolver, store } = rig();
    await store.load();
    const id = await resolver.fromFile(MB_PATH, 'Monster Bash (Williams 1998) VPWmod v1.0');
    expect(id).toMatchObject({
      filePath: MB_PATH,
      vpsGame: { id: 'F1Skyh5h', name: 'Monster Bash', manufacturer: 'Williams', year: 1998 },
      vpsTable: { id: 'rxmbAdBi', label: 'VPW 1.0 · MOD, VR, FSS' },
      tableConfidence: 'exact',
      confirmed: false,
      saveRev: 7,
      sha256: null,
    });
    expect(id.gameConfidence).not.toBe('none');
    expect(id.physics).toMatchObject({ slopeMin: 6, slopeMax: 7 });
    expect(id.tableChoices.length).toBeGreaterThan(5);
    expect(id.notes.join(' ')).toMatch(/table info read from the file/);

    const hashed = await resolver.hash(id);
    expect(hashed.sha256).toBe(MB_SHA);
    expect(hashed.fingerprint).toMatch(/^pf1:[0-9a-f]{64}$/);
    // Second resolution comes from the cache, hash included.
    const again = await resolver.fromFile(MB_PATH, 'Monster Bash (Williams 1998) VPWmod v1.0');
    expect(again.sha256).toBe(MB_SHA);
    expect(again.fingerprint).toBe(hashed.fingerprint);
    expect(again.notes.join(' ')).toMatch(/cached/);
  });

  it('the ROM at capture pins the game; a name-only identity gets a game from the ROM too', async () => {
    const { resolver, store } = rig();
    await store.load();
    const fromName = await resolver.fromFile(null, 'Some Renamed File');
    expect(fromName).toMatchObject({ filePath: null, vpsGame: null, gameConfidence: 'none' });
    const pinned = await resolver.withRom(fromName, 'mb_106b', 'Monster Bash');
    expect(pinned.vpsGame?.id).toBe('F1Skyh5h');
    expect(pinned.gameSource).toBe('rom');
    expect(pinned.tableConfidence).toBe('ambiguous'); // nothing names the table
    expect(pinned.vpsTable).toBeNull();
    expect(pinned.tableChoices.length).toBeGreaterThan(5);
    expect(pinned.notes.join(' ')).toMatch(/pinned by ROM mb_106b/);
    // No ROM: unchanged.
    expect(await resolver.withRom(fromName, null, null)).toBe(fromName);
  });

  it('a confirmation wins over the matcher, survives a re-save, and can be forgotten', async () => {
    const { resolver, store } = rig();
    await store.load();
    const path = 'C:\\VPX\\tables\\Monster Bash (Williams 1998).vpx';
    const before = await resolver.fromFile(path, 'Monster Bash (Williams 1998)');
    expect(before.vpsGame?.id).toBe('F1Skyh5h');
    expect(before.tableConfidence).toBe('ambiguous');
    expect(before.vpsTable).toBeNull();

    await store.confirm(path, { vpsGameId: 'F1Skyh5h', vpsTableId: 'G7Df7_IH' });
    const after = resolver.applyConfirmation(before);
    expect(after).toMatchObject({ vpsTable: { id: 'G7Df7_IH' }, tableConfidence: 'exact', confirmed: true });
    // A fresh resolution (e.g. after a re-save) applies it as well.
    expect((await resolver.fromFile(path, 'Monster Bash (Williams 1998)')).vpsTable?.id).toBe('G7Df7_IH');

    await store.confirm(path, null);
    const forgotten = resolver.applyConfirmation(after);
    expect(forgotten.confirmed).toBe(false);
    expect(forgotten.tableConfidence).toBe('ambiguous');
  });

  it('a missing file or a missing index never throws', async () => {
    const fs = new MemoryFs();
    const store = createIdentityStore(fs, '/data');
    const resolver = createIdentityResolver({ fs, index: createVpsIndex('/no-index', fs), store, now: () => 0 });
    const id = await resolver.fromFile('C:\\nowhere.vpx', 'Monster Bash (Williams 1998) VPWmod v1.0');
    expect(id.vpsGame).toBeNull();
    expect(id.notes.join(' ')).toMatch(/could not read the table file/);
    expect((await resolver.hash(id)).notes.join(' ')).toMatch(/hash failed/);
  });
});
