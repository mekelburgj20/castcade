import { describe, expect, it } from 'vitest';
import { describeScorePlausibility, ScoreTrack, scorePlausibilityWire } from './score-plausibility.js';

const run = (scores: number[], step: number | null = 10) => {
  const t = new ScoreTrack(step);
  scores.forEach((s, i) => t.add(s, i, 1));
  return t.result();
};

describe('ScoreTrack', () => {
  it('the first sample is the baseline; jumps are the differences after it', () => {
    const r = run([48488530, 0, 5000, 15000, 4015000]);
    expect(r).toMatchObject({ samples: 4, gcd: 5000, offStep: 0, flag: null, largest: { points: 4000000, t: 4 } });
  });

  it('a drop moves the baseline and is not a jump', () => {
    const r = run([1000, 0, 2000]);
    expect(r.largest?.points).toBe(2000);
    expect(r.samples).toBe(2);
  });

  it('a jump off the ROM step is flagged, with the first offender', () => {
    const r = run([0, 1000, 1001234]);
    expect(r.offStep).toBe(1);
    expect(r.gcd).toBe(2);
    expect(r.flag).toBe('1 score change not a multiple of 10 (first +1,000,234); ROM scores move in steps of 10');
    expect(describeScorePlausibility(r)).toMatch(/FLAG: 1 score change not a multiple of 10/);
  });

  it('script recipes (step null) get the facts and never a flag', () => {
    const r = run([0, 3, 10], null);
    expect(r).toMatchObject({ step: null, offStep: 0, flag: null, gcd: 1 });
  });

  it('reset() starts a new game; nulls and non-integers are ignored', () => {
    const t = new ScoreTrack();
    t.add(0, 0, 1);
    t.add(1001, 1, 1);
    t.reset();
    t.add(null, 2, 1);
    t.add(0.5, 3, 1);
    t.add(0, 4, 1);
    t.add(50, 5, 1);
    expect(t.result()).toMatchObject({ samples: 1, offStep: 0, largest: { points: 50 } });
  });

  it('wire: compact JSON, null for a game with no score change', () => {
    expect(scorePlausibilityWire(run([0]))).toBeNull();
    expect(JSON.parse(scorePlausibilityWire(run([0, 10, 30]))!)).toEqual({ samples: 2, gcd: 10, step: 10, off_step: 0, largest: { points: 20, t: 2, ball: 1 }, flag: null });
  });
});
