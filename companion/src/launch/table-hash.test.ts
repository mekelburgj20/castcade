/**
 * I11.4.11: the hash of a table file nothing has hashed yet (`table-hash.ts`): read once per path, size and time, kept
 * across runs, one file at a time, and never a throw.
 */
import { describe, expect, it } from 'vitest';
import type { WitnessFs } from '../witness/fs.js';
import { createTableHasher } from './table-hash.js';

const A = String.raw`C:\Tables\Congo (Williams 1995).vpx`;
const B = String.raw`C:\Tables\Congo copy.vpx`;

function world(saved: string | null = null) {
  const files: Record<string, { size: number; mtimeMs: number; sha: string }> = {
    [A]: { size: 300_000_000, mtimeMs: 1_700_000_000_123.4, sha: 'AA'.repeat(32) },
    [B]: { size: 10, mtimeMs: 5, sha: 'bb'.repeat(32) },
  };
  const reads: string[] = [];
  let running = 0;
  let most = 0;
  const store = { text: saved };
  const fs = {
    stat: async (p: string) => {
      const f = files[p];
      if (!f) throw new Error('ENOENT');
      return { size: f.size, mtimeMs: f.mtimeMs };
    },
  } as unknown as WitnessFs;
  const hasher = createTableHasher({
    fs,
    io: { read: () => store.text, write: (t) => void (store.text = t) },
    hash: async (_fs, p) => {
      reads.push(p);
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return files[p]!.sha;
    },
  });
  return { hasher, files, reads, store, most: () => most };
}

describe('the hash of a table file (I11.4.11)', () => {
  it('reads a file once, answers lower-case, and keeps the answer for the next run', async () => {
    const w = world();
    expect(await w.hasher.hashOf(A)).toBe('aa'.repeat(32));
    expect(await w.hasher.hashOf(A)).toBe('aa'.repeat(32));
    expect(w.reads).toEqual([A]);
    // The next run of the app starts from the file that was written.
    const next = world(w.store.text);
    expect(await next.hasher.hashOf(A)).toBe('aa'.repeat(32));
    expect(next.reads).toEqual([]);
  });

  it('a file that changed (its size or its time) is read again; one that is gone, or a cache that does not parse, is no error', async () => {
    const w = world();
    await w.hasher.hashOf(A);
    w.files[A]!.mtimeMs += 1000;
    w.files[A]!.sha = 'cc'.repeat(32);
    expect(await w.hasher.hashOf(A)).toBe('cc'.repeat(32));
    expect(w.reads).toEqual([A, A]);
    expect(await w.hasher.hashOf(String.raw`C:\Tables\gone.vpx`)).toBeNull();
    const torn = world('{ not json');
    expect(await torn.hasher.hashOf(B)).toBe('bb'.repeat(32));
  });

  it('one file at a time, whoever asks', async () => {
    const w = world();
    const [a, b] = await Promise.all([w.hasher.hashOf(A), w.hasher.hashOf(B)]);
    expect([a, b]).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
    expect(w.most()).toBe(1);
  });
});
