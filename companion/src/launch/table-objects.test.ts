/**
 * I11.4.15: what this PC knows of its table files' objects (`table-objects.ts`): computed once per path, size and
 * time and kept across runs, replaced by the Castcade VPX build's own word when that comes, one file at a time, and
 * never a throw. No table is read: the computation is the test's.
 */
import { describe, expect, it } from 'vitest';
import type { WitnessFs } from '../witness/fs.js';
import type { ForkIdentity } from './fork-identity.js';
import { createTableObjects, objectsDisagreeLine } from './table-objects.js';

const A = String.raw`C:\Tables\Congo (Williams 1995).vpx`;
const B = String.raw`C:\Tables\Congo MR mod.vpx`;
const ODD = String.raw`C:\Tables\Odd one.vpx`;
const STD: ForkIdentity = { editables: 769, hash: 'fc87ddefd36bdd13' };
const MOD: ForkIdentity = { editables: 766, hash: 'e4b9bf66f04cfcf9' };

function world(saved: string | null = null) {
  const files: Record<string, { size: number; mtimeMs: number; id: ForkIdentity | null }> = {
    [A]: { size: 300_000_000, mtimeMs: 1_700_000_000_123.4, id: STD },
    [B]: { size: 10, mtimeMs: 5, id: MOD },
    [ODD]: { size: 7, mtimeMs: 9, id: null },
  };
  const reads: string[] = [];
  let running = 0;
  let most = 0;
  const store = { text: saved };
  const fs = {
    stat: async (p: string) => {
      // As Windows finds a file: whatever the case of its path and the way its slashes lean.
      const f = Object.entries(files).find(([k]) => k.toLowerCase() === p.replace(/\//g, '\\').toLowerCase())?.[1];
      if (!f) throw new Error('ENOENT');
      return { size: f.size, mtimeMs: f.mtimeMs };
    },
  } as unknown as WitnessFs;
  const objects = createTableObjects({
    fs,
    io: { read: () => store.text, write: (t) => void (store.text = t) },
    compute: async (_fs, p) => {
      reads.push(p);
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return files[p]!.id;
    },
  });
  return { objects, files, reads, store, most: () => most };
}

describe('the table objects of a table file (I11.4.15)', () => {
  it('reads a file once and keeps the answer for the next run; a file that cannot be told is kept as that, and not read again', async () => {
    const w = world();
    expect(await w.objects.objectsOf(A)).toEqual(STD);
    expect(await w.objects.objectsOf(A.toLowerCase().replace(/\\/g, '/'))).toEqual(STD);
    expect(await w.objects.objectsOf(ODD)).toBeNull();
    expect(await w.objects.objectsOf(ODD)).toBeNull();
    expect(w.reads).toEqual([A, ODD]);
    const again = world(w.store.text);
    expect(await again.objects.objectsOf(A)).toEqual(STD);
    expect(await again.objects.objectsOf(ODD)).toBeNull();
    expect(again.reads).toEqual([]);
    expect(JSON.parse(w.store.text!)).toEqual({
      v: 1,
      tables: {
        'c:\\tables\\congo (williams 1995).vpx|300000000|1700000000123': { editables: 769, hash: 'fc87ddefd36bdd13', from: 'file' },
        'c:\\tables\\odd one.vpx|7|9': { unknown: true },
      },
    });
  });

  it('a file that changed (its size or its time) is read again; one that is gone, or a cache that does not parse, is no error', async () => {
    const w = world('{ not json');
    expect(await w.objects.objectsOf(A)).toEqual(STD);
    w.files[A]!.mtimeMs += 2000;
    w.files[A]!.id = MOD;
    expect(await w.objects.objectsOf(A)).toEqual(MOD);
    expect(w.reads).toEqual([A, A]);
    expect(await w.objects.objectsOf(String.raw`C:\Tables\gone.vpx`)).toBeNull();
    // Junk in a cache file is not an identity.
    const junk = world(JSON.stringify({ v: 1, tables: { 'c:\\tables\\congo mr mod.vpx|10|5': { editables: 'many', hash: 'nope', from: 'fork' } } }));
    expect(await junk.objects.objectsOf(B)).toEqual(MOD);
    expect(junk.reads).toEqual([B]);
  });

  it("the build's own word is kept for the file it was said for and comes before anything computed, also for a file that could not be told; a word that contradicts what was computed is answered so", async () => {
    const w = world();
    // Nothing computed yet: the build's word is simply kept, and the file is never read.
    expect(await w.objects.learn(A, STD)).toBeNull();
    expect(await w.objects.objectsOf(A)).toEqual(STD);
    expect(w.reads).toEqual([]);
    // Computed, and the build says the same: nothing to report; the entry is now the build's.
    expect(await w.objects.objectsOf(B)).toEqual(MOD);
    expect(await w.objects.learn(B, { editables: 766, hash: 'E4B9BF66F04CFCF9' })).toBeNull();
    expect((JSON.parse(w.store.text!) as { tables: Record<string, { from: string }> }).tables['c:\\tables\\congo mr mod.vpx|10|5']!.from).toBe('fork');
    // Computed, and the build says another: the build's word wins from here on, and the caller is told what was computed.
    const c = world();
    expect(await c.objects.objectsOf(A)).toEqual(STD);
    expect(await c.objects.learn(A, MOD)).toEqual({ computed: STD });
    expect(await c.objects.objectsOf(A)).toEqual(MOD);
    expect(await c.objects.learn(A, MOD)).toBeNull();
    expect(c.reads).toEqual([A]);
    expect(await world(c.store.text).objects.objectsOf(A)).toEqual(MOD);
    expect(objectsDisagreeLine('Congo (Williams 1995)', MOD, STD)).toBe(
      "launch: the Castcade VPX build reports table 766 e4b9bf66f04cfcf9 for Congo (Williams 1995); Castcade had computed 769 fc87ddefd36bdd13 from the file. The build's word is kept for this file",
    );
    // A file that could not be told from its bytes: the build's word replaces "unknown".
    expect(await c.objects.objectsOf(ODD)).toBeNull();
    expect(await c.objects.learn(ODD, STD)).toBeNull();
    expect(await c.objects.objectsOf(ODD)).toEqual(STD);
    // Not an identity, or a file that is gone: nothing is kept, nothing thrown.
    expect(await c.objects.learn(A, { editables: 1, hash: 'short' })).toBeNull();
    expect(await c.objects.learn(String.raw`C:\Tables\gone.vpx`, STD)).toBeNull();
  });

  it('one file at a time, whoever asks; a read that was given up answers null and is not kept, and one still waiting its turn is never begun', async () => {
    const w = world();
    const ctl = new AbortController();
    const first = w.objects.objectsOf(A, ctl.signal);
    const second = w.objects.objectsOf(B, ctl.signal);
    const third = w.objects.objectsOf(ODD);
    // The first read is under way when the player gives up.
    await new Promise((r) => setTimeout(r, 1));
    expect(w.reads).toEqual([A]);
    ctl.abort();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(await third).toBeNull();
    // The first was being read when it was given up (its answer is dropped); the second never began; the third ran.
    expect(w.reads).toEqual([A, ODD]);
    expect(w.most()).toBe(1);
    // Nothing of the given-up read was kept: it is read again when asked for.
    expect(await w.objects.objectsOf(A)).toEqual(STD);
    expect(w.reads).toEqual([A, ODD, A]);
  });
});
