import { describe, expect, it } from 'vitest';
import { describeEngine, engineWire } from './attestation-types.js';

describe('engine attestation (F6)', () => {
  const sample = (t: number, difficulty: number, tilt: number) => ({
    t, reason: t === 0 ? 'init' : 'key', difficulty, slopeMin: 6, slopeMax: 7, physicsSet: 0, gravity: 0.97, friction: 0.075, elasticity: 0.25, elasticityFalloff: 0, scatter: 0, nudgeTime: 5,
    nudge: { xmax: 700, ymax: 700, xgain: 115, ygain: 115, deadZone: 0, tilt },
  });
  it('wires the start sample and the changes, four decimals, and words a change for the player', () => {
    expect(engineWire(null)).toBeNull();
    const quiet = { atStart: sample(0, 0.2, 400), changes: [] };
    expect(JSON.parse(engineWire(quiet)!)).toEqual({ start: { t: 0, difficulty: 0.2, slope_min: 6, slope_max: 7, physics_set: 0, gravity: 0.97, friction: 0.075, elasticity: 0.25, elasticity_falloff: 0, scatter: 0, nudge_time: 5, nudge: { xmax: 700, ymax: 700, xgain: 115, ygain: 115, dead_zone: 0, tilt: 400 } }, changes: [] });
    expect(describeEngine(quiet)).toBe('engine (live): difficulty 20%, slope 6.20°, physics set 0, tilt sensitivity 400');
    const edited = { atStart: sample(0, 0.2, 400), changes: [sample(412.3, 0.8, 400), sample(500, 0.8, 10)] };
    expect(JSON.parse(engineWire(edited)!).changes).toHaveLength(2);
    expect(describeEngine(edited)).toBe('engine (live): difficulty 20%, slope 6.20°, physics set 0, tilt sensitivity 400; CHANGED DURING THE GAME (2 changes, last at +500 s): difficulty 20% → 80%, tilt sensitivity 400 → 10');
    expect(describeEngine(null)).toMatch(/not sampled/);
  });
});
