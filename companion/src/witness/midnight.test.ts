import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMapCorpus } from './maps.js';
import { MIDNIGHT_PLATFORM, midnightInScope, spansLocalMidnight } from './midnight.js';

const utc = (iso: string): number => Date.parse(iso);
const MIN = 60_000;
const HOUR = 3_600_000;

describe('spansLocalMidnight (B26)', () => {
  it('before, after and across midnight at UTC', () => {
    expect(spansLocalMidnight(utc('2026-11-16T23:40:00Z'), utc('2026-11-16T23:59:59.999Z'), 0)).toBe(false);
    expect(spansLocalMidnight(utc('2026-11-17T00:00:01Z'), utc('2026-11-17T00:20:00Z'), 0)).toBe(false);
    expect(spansLocalMidnight(utc('2026-11-16T23:58:00Z'), utc('2026-11-17T00:03:00Z'), 0)).toBe(true);
  });

  it('the midnight is the local one: the same instants flag or not by the offset passed in', () => {
    // 05:58–06:03 UTC is 23:58–00:03 in UTC-6 (Krobs' evening), and the middle of the morning at UTC.
    const a = utc('2026-11-17T05:58:00Z');
    const b = utc('2026-11-17T06:03:00Z');
    expect(spansLocalMidnight(a, b, -360)).toBe(true);
    expect(spansLocalMidnight(a, b, 0)).toBe(false);
    expect(spansLocalMidnight(a, b, 60)).toBe(false);
    // And the UTC midnight is nobody's in UTC-6 or UTC+5:30.
    const c = utc('2026-11-16T23:58:00Z');
    const d = utc('2026-11-17T00:03:00Z');
    expect(spansLocalMidnight(c, d, -360)).toBe(false);
    expect(spansLocalMidnight(c, d, 330)).toBe(false);
    // 18:28–18:33 UTC is 23:58–00:03 at UTC+5:30.
    expect(spansLocalMidnight(utc('2026-11-16T18:28:00Z'), utc('2026-11-16T18:33:00Z'), 330)).toBe(true);
  });

  it('the edges: ending exactly at midnight has passed it, starting exactly there has not', () => {
    const m = utc('2026-11-17T00:00:00Z');
    expect(spansLocalMidnight(m - 1, m, 0)).toBe(true);
    expect(spansLocalMidnight(m - 5 * MIN, m - 1, 0)).toBe(false);
    expect(spansLocalMidnight(m, m + 5 * MIN, 0)).toBe(false);
  });

  it('zero-length, reversed and nonsense intervals never flag; a multi-day one does', () => {
    const m = utc('2026-11-17T00:00:00Z');
    expect(spansLocalMidnight(m, m, 0)).toBe(false);
    expect(spansLocalMidnight(m - 1, m - 1, 0)).toBe(false);
    expect(spansLocalMidnight(m + MIN, m - MIN, 0)).toBe(false);
    expect(spansLocalMidnight(Number.NaN, m, 0)).toBe(false);
    expect(spansLocalMidnight(m - MIN, Number.POSITIVE_INFINITY, 0)).toBe(false);
    expect(spansLocalMidnight(utc('2026-11-14T12:00:00Z'), utc('2026-11-16T12:00:00Z'), 0)).toBe(true);
    expect(spansLocalMidnight(utc('2026-11-14T12:00:00Z'), utc('2026-11-16T12:00:00Z'), -360)).toBe(true);
  });

  it('the offset may be a function of the instant (a DST change inside the interval); a bad offset reads as UTC', () => {
    // Clocks go back an hour at 06:00 UTC: UTC-5 before, UTC-6 after. 04:50 UTC is 23:50 local; 05:10 UTC is 00:10.
    const change = utc('2026-11-01T06:00:00Z');
    const dst = (ms: number): number => (ms < change ? -300 : -360);
    expect(spansLocalMidnight(utc('2026-11-01T04:50:00Z'), utc('2026-11-01T05:10:00Z'), dst)).toBe(true);
    // 05:30 UTC (00:30 local, already the 1st) to 06:30 UTC (00:30 local again, after the change): the same local day.
    expect(spansLocalMidnight(utc('2026-11-01T05:30:00Z'), utc('2026-11-01T06:30:00Z'), dst)).toBe(false);
    // The function is asked at each end.
    const asked: number[] = [];
    spansLocalMidnight(1000, 1000 + HOUR, (ms) => (asked.push(ms), 0));
    expect(asked).toEqual([1000 + HOUR, 1000]);
    expect(spansLocalMidnight(utc('2026-11-16T23:58:00Z'), utc('2026-11-17T00:03:00Z'), Number.NaN)).toBe(true);
  });
});

describe('midnightInScope (B26): the map platform is WPC', () => {
  const corpus = createMapCorpus(fileURLToPath(new URL('../../../fixtures/maps', import.meta.url)));

  it('WPC maps are in scope; Data East, Stern SAM, Gottlieb, a ROM with no map and no ROM are not', async () => {
    for (const rom of ['mm_109c', 'mb_106b', 'afm_113']) {
      const map = await corpus.mapFor(rom);
      expect(map?.platform.name).toBe('williams-wpc-12K');
      expect(midnightInScope(map)).toBe(true);
    }
    for (const rom of ['tftc_400', 'acd_170h', 'cueball', 'stingray']) {
      const map = await corpus.mapFor(rom);
      expect(map).not.toBeNull();
      expect(midnightInScope(map)).toBe(false);
    }
    expect(midnightInScope(await corpus.mapFor('no_such_rom'))).toBe(false);
    expect(midnightInScope(null)).toBe(false);
    expect(midnightInScope(undefined)).toBe(false);
  });

  it('by the platform name alone: both WPC platforms of the corpus, nothing that merely resembles one', () => {
    const named = (name: string) => ({ platform: { name, endian: 'big' as const, layout: [] } });
    expect(midnightInScope(named('williams-wpc-12K'))).toBe(true);
    expect(midnightInScope(named('williams-wpc-8K'))).toBe(true);
    expect(midnightInScope(named('williams-wpc'))).toBe(true);
    expect(midnightInScope(named('williams-system11-40K'))).toBe(false);
    expect(midnightInScope(named('williams-wpcx'))).toBe(false);
    expect(midnightInScope(named('auto-generated'))).toBe(false);
    expect(MIDNIGHT_PLATFORM.test('whitestar')).toBe(false);
  });
});
