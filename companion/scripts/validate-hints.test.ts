import { describe, expect, it } from 'vitest';
import { RUNNER_HINTS, afterStartArg, hintFor, type RunnerHint } from './validate-hints.js';

describe('runner hints (validate-original)', () => {
  it('every record names its table, says why, and asks for something autoplay.py can do', () => {
    for (const h of RUNNER_HINTS) {
      expect(h.match.trim()).not.toBe('');
      expect(h.why.length, h.match).toBeGreaterThan(40);
      expect((h.afterStart?.length ?? 0) + (h.folders?.length ?? 0) + (h.minutes ?? 0) + (h.settleSeconds ?? 0), h.match).toBeGreaterThan(0);
      for (const s of h.afterStart ?? []) {
        expect(['start', 'plunge', 'credit', 'lflip', 'rflip']).toContain(s.key);
        expect(s.seconds).toBeGreaterThan(0);
      }
    }
  });

  it('matches by a part of the file name, whatever its case: both Diablo 2 versions and SMGP press Start a second time', () => {
    for (const name of ['Diablo 2 (ChuckRibbits Original 2026) 1.1.1 Multiplayer', 'Diablo 2 (ChuckRibbits Original 2026) 1.2.1', 'SMGP']) {
      const h = hintFor(name);
      expect(h.afterStart, name).toEqual([{ seconds: 4, key: 'start' }]);
      expect(afterStartArg(h.afterStart ?? [])).toBe('4:start');
      expect(h.why).toHaveLength(1);
    }
    expect(hintFor('Godfather')).toEqual({ why: [], afterStart: [], folders: [] });
  });

  it('merges every record that matches: steps and folders add up, the longest budget wins', () => {
    const hints: RunnerHint[] = [
      { match: 'alpha', why: 'a', afterStart: [{ seconds: 2, key: 'start' }], minutes: 10, folders: ['A.FlexDMD'] },
      { match: 'ALPHA beta', why: 'b', afterStart: [{ seconds: 1.5, key: 'lflip' }], minutes: 12, settleSeconds: 20, folders: ['A.FlexDMD', 'B'] },
    ];
    expect(hintFor('Alpha Beta v2', hints)).toEqual({
      why: ['a', 'b'],
      afterStart: [
        { seconds: 2, key: 'start' },
        { seconds: 1.5, key: 'lflip' },
      ],
      folders: ['A.FlexDMD', 'B'],
      minutes: 12,
      settleSeconds: 20,
    });
    expect(afterStartArg(hintFor('Alpha Beta v2', hints).afterStart ?? [])).toBe('2:start,1.5:lflip');
  });
});
