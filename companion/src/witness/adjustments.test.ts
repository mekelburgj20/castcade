import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adjustmentsReport, decodeAdjustments, describeAdjustments, isFairnessLabel } from './adjustments.js';
import { adjustmentsWire } from './attestation-types.js';
import { createMapCorpus, flattenAdjustments, type CompiledMap } from './maps.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const corpus = createMapCorpus(repo('fixtures/maps'));

/**
 * A 12 KB WPC NVRAM with every adjustment of the map written at its factory default (big-endian
 * `int`, one-byte `enum`, packed `bcd`), then the four standard ones set as asked.
 */
function afmNv(map: CompiledMap, values: { balls: number; tilt: number; maxEb: number; replaySystem: number }): Uint8Array {
  const nv = new Uint8Array(0x3000);
  const writeInt = (at: number, len: number, v: number) => {
    for (let i = len - 1; i >= 0; i--) {
      nv[at + i] = v & 0xff;
      v = Math.floor(v / 256);
    }
  };
  const writeBcd = (at: number, len: number, v: number) => {
    for (let i = len - 1; i >= 0; i--) {
      nv[at + i] = ((Math.floor(v / 10) % 10) << 4) | (v % 10);
      v = Math.floor(v / 100);
    }
  };
  for (const d of map.adjustments) {
    const e = d.entry;
    if (typeof e['default'] !== 'number' || typeof e['start'] !== 'number') continue;
    // `default` is in the stored-value domain (corpus README), so it is written as-is.
    const len = typeof e['length'] === 'number' ? e['length'] : 1;
    if (e['encoding'] === 'bcd') writeBcd(e['start'], len, e['default']);
    else writeInt(e['start'], len, e['default']);
  }
  writeInt(7063, 2, values.balls); // A.1 01 Balls Per Game, default 3
  writeInt(7065, 2, values.tilt); // A.1 02 Tilt Warnings, default 3
  writeInt(7067, 2, values.maxEb); // A.1 03 Max E.B. Count, default 4
  nv[7072] = values.replaySystem; // A.1 05 Replay System enum: Auto % / Fixed, default 0
  return nv;
}

describe('operator adjustments from the maps corpus', () => {
  it('flattens groups of numbered entries and lists, skipping notes and unlabeled entries', () => {
    const flat = flattenAdjustments({
      _note: 'x',
      'A.1 Standard Adjustments': { _note: 'y', '01': { label: 'Balls Per Game', start: 1 }, '02': { start: 2 } },
      'A.2 Feature': [{ label: 'Ball Saves', start: 3 }, 'junk'],
    });
    expect(flat.map((f) => [f.group, f.label])).toEqual([
      ['A.1 Standard Adjustments', 'Balls Per Game'],
      ['A.2 Feature', 'Ball Saves'],
    ]);
    expect(flattenAdjustments(undefined)).toEqual([]);
    expect(flattenAdjustments([1, 2])).toEqual([]);
  });

  it('the fairness subset: what changes the value of a game', () => {
    for (const l of ['Balls Per Game', 'Number of Balls', 'Tilt Warnings', 'Max E.B. Count', 'Ex. Ball Percent', 'Ball Save Time', 'Replay System', 'Free Play', 'Pricing Control', 'Special Award', 'Match Feature', 'Timed Plunger'])
      expect(isFairnessLabel(l), l).toBe(true);
    for (const l of ['Left Coin Slot Multiplier', 'Custom Message', 'HSTD Credits', 'Attract Mode Sounds', 'Game Restart']) expect(isFairnessLabel(l), l).toBe(false);
  });

  it('afm_113: factory bytes read as all factory; a 5-ball, 5-warning, fixed-replay machine is flagged', async () => {
    const map = await corpus.mapFor('afm_113b');
    expect(map).not.toBeNull();
    if (!map) return;
    expect(map.adjustments.length).toBeGreaterThan(20);

    const factory = decodeAdjustments(map, afmNv(map, { balls: 3, tilt: 3, maxEb: 4, replaySystem: 0 }));
    const byLabel = (rs: typeof factory, l: string) => rs.find((r) => r.label === l);
    expect(byLabel(factory, 'Balls Per Game')).toMatchObject({ group: 'A.1 Standard Adjustments', value: 3, shown: 3, factory: 3, isFactory: true, text: null });
    // Replay Start: stored 40, scale 100 → shown 4000; factory is judged on the stored 40.
    expect(byLabel(factory, 'Replay Start')).toMatchObject({ value: 40, shown: 4000, factory: 40, isFactory: true });
    expect(byLabel(factory, 'Replay System')).toMatchObject({ value: 0, text: 'Auto %', factory: 0, isFactory: true });
    const report = adjustmentsReport('afm_113b', factory);
    expect(report).not.toBeNull();
    expect(report?.checked.length).toBeGreaterThan(3);
    expect(report?.nonFactory).toEqual([]);
    expect(describeAdjustments(report)).toMatch(/^\d+ adjustments checked, all factory/);

    const tuned = decodeAdjustments(map, afmNv(map, { balls: 5, tilt: 5, maxEb: 0, replaySystem: 1 }));
    expect(byLabel(tuned, 'Max E.B. Count')).toMatchObject({ value: 0, text: 'NO EX. BALL', isFactory: false });
    const flagged = adjustmentsReport('afm_113b', tuned);
    expect(flagged?.nonFactory).toEqual(expect.arrayContaining(['Balls Per Game', 'Tilt Warnings', 'Max E.B. Count', 'Replay System']));
    expect(describeAdjustments(flagged)).toMatch(/^non-factory adjustments: Balls Per Game, Tilt Warnings/);

    const wire = JSON.parse(adjustmentsWire(flagged) ?? 'null') as { total: number; items: { l: string; v: number; d: number | null; t?: string }[]; non_factory: string[] };
    expect(wire.total).toBe(map.adjustments.length);
    expect(wire.items.find((i) => i.l === 'Balls Per Game')).toEqual({ l: 'Balls Per Game', v: 5, d: 3 });
    expect(wire.items.find((i) => i.l === 'Replay System')).toEqual({ l: 'Replay System', v: 1, t: 'Fixed', d: 0 });
    expect(wire.non_factory).toContain('Tilt Warnings');
  });

  it('a map without an adjustments block (Medieval Madness) yields no report', async () => {
    const map = await corpus.mapFor('mm_109c');
    expect(map?.adjustments).toEqual([]);
    expect(adjustmentsReport('mm_109c', decodeAdjustments(map!, new Uint8Array(0x3000)))).toBeNull();
    expect(describeAdjustments(null)).toBe('no adjustments map for this ROM');
    expect(adjustmentsWire(null)).toBeNull();
  });
});
