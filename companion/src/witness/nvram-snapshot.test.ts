import { describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import { MemoryFs } from './fs.js';
import { changedNvFiles, snapshotNvFiles, waitForNvChange } from './nvram-snapshot.js';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

describe('nvram snapshots', () => {
  it('lists only .nv files, with bytes on request, and an absent dir is empty', async () => {
    const clock = new ManualClock();
    const fs = new MemoryFs(() => clock.now());
    fs.put('/nv/mm_109c.nv', Uint8Array.from([1, 2, 3]));
    fs.put('/nv/tftc_400.nv', Uint8Array.from([9]));
    fs.put('/nv/readme.txt', 'x');
    const stat = await snapshotNvFiles(fs, '/nv');
    expect([...stat.keys()]).toEqual(['mm_109c.nv', 'tftc_400.nv']);
    expect(stat.get('mm_109c.nv')).toMatchObject({ size: 3, mtimeMs: clock.now(), bytes: null });
    const full = await snapshotNvFiles(fs, '/nv', { readBytes: true });
    expect(full.get('tftc_400.nv')?.bytes).toEqual(Uint8Array.from([9]));
    const big = await snapshotNvFiles(fs, '/nv', { readBytes: true, maxBytes: 2 });
    expect(big.get('mm_109c.nv')?.bytes).toBeNull();
    expect(big.get('tftc_400.nv')?.bytes).toEqual(Uint8Array.from([9]));
    expect((await snapshotNvFiles(fs, '/missing')).size).toBe(0);
  });

  it('diffs by size or mtime and lists new files, newest first', async () => {
    const clock = new ManualClock();
    const fs = new MemoryFs(() => clock.now());
    fs.put('/nv/a.nv', Uint8Array.from([1]));
    fs.put('/nv/b.nv', Uint8Array.from([1]));
    fs.put('/nv/c.nv', Uint8Array.from([1]));
    const before = await snapshotNvFiles(fs, '/nv');
    clock.advance(1000);
    fs.put('/nv/a.nv', Uint8Array.from([2])); // same size, new mtime
    clock.advance(1000);
    fs.put('/nv/new.nv', Uint8Array.from([1]));
    const after = await snapshotNvFiles(fs, '/nv');
    expect(changedNvFiles(before, after)).toEqual(['new.nv', 'a.nv']);
    expect(changedNvFiles(before, before)).toEqual([]);
  });

  it('waitForNvChange returns as soon as a file changes, or empty at the deadline', async () => {
    const clock = new ManualClock();
    const fs = new MemoryFs(() => clock.now());
    fs.put('/nv/a.nv', Uint8Array.from([1]));
    const before = await snapshotNvFiles(fs, '/nv');

    let result: string[] | null = null;
    void waitForNvChange(fs, '/nv', before, { clock, timeoutMs: 5000, pollMs: 500 }).then((r) => {
      result = r.changed;
    });
    await flush();
    expect(result).toBeNull();
    clock.advance(500);
    await flush();
    expect(result).toBeNull();
    clock.advance(700);
    fs.put('/nv/a.nv', Uint8Array.from([1, 2]));
    clock.advance(300);
    await flush();
    expect(result).toEqual(['a.nv']);

    let timedOut: string[] | null = null;
    void waitForNvChange(fs, '/nv', await snapshotNvFiles(fs, '/nv'), { clock, timeoutMs: 1000, pollMs: 500 }).then((r) => {
      timedOut = r.changed;
    });
    for (let i = 0; i < 4; i++) {
      await flush();
      clock.advance(500);
    }
    await flush();
    expect(timedOut).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
