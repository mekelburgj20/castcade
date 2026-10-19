import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import { createIdentityStore, type CachedFacts } from './identity-store.js';

const FACTS: CachedFacts = {
  fileVersion: 1080,
  tableInfo: { tableName: 'Monster Bash VPW Mod', authorName: 'VPW', tableVersion: '1.0', releaseDate: null, saveDate: null, saveRev: 7, manufacturer: 'Williams', year: 1998, raw: {} },
  physics: null,
  scriptBytes: 163862,
  sha256: null,
  computedAt: '2026-10-18T00:00:00.000Z',
};

describe('identity store', () => {
  it('caches facts by path+size+mtime, confirmations by path, and survives a reload', async () => {
    const fs = new MemoryFs();
    const store = createIdentityStore(fs, '/data', () => 1_760_000_000_000);
    await store.load(); // no file yet
    const key = store.key('C:\\VPX\\tables\\Monster Bash.vpx', 184487936, 1767673167962.5);
    expect(key).toBe('c:/vpx/tables/monster bash.vpx|184487936|1767673167962');
    expect(store.facts(key)).toBeNull();
    await store.setFacts(key, FACTS);
    await store.setSha256(key, 'abc');
    expect(store.facts(key)?.sha256).toBe('abc');
    await store.confirm('c:/VPX/Tables/Monster Bash.vpx', { vpsGameId: 'F1Skyh5h', vpsTableId: 'rxmbAdBi' });
    expect(store.confirmation('C:\\VPX\\tables\\Monster Bash.vpx')).toEqual({ vpsGameId: 'F1Skyh5h', vpsTableId: 'rxmbAdBi', at: new Date(1_760_000_000_000).toISOString() });

    const again = createIdentityStore(fs, '/data');
    await again.load();
    expect(again.facts(key)).toEqual({ ...FACTS, sha256: 'abc' });
    expect(again.confirmation('C:\\VPX\\tables\\Monster Bash.vpx')?.vpsTableId).toBe('rxmbAdBi');
    // A re-saved file (new size/mtime) gets no cached facts but keeps the confirmation.
    expect(again.facts(again.key('C:\\VPX\\tables\\Monster Bash.vpx', 184487937, 1767673167962))).toBeNull();
    await again.confirm('C:\\VPX\\tables\\Monster Bash.vpx', null);
    expect(again.confirmation('C:\\VPX\\tables\\Monster Bash.vpx')).toBeNull();
  });

  it('ignores a torn file and setSha256 on an unknown key', async () => {
    const fs = new MemoryFs();
    fs.put('/data/table-identity.json', '{"version":1,"facts":{');
    const store = createIdentityStore(fs, '/data');
    await store.load();
    await store.setSha256('nope', 'x');
    expect(store.facts('nope')).toBeNull();
    expect(fs.has('/data/table-identity.json')).toBe(true);
  });
});
