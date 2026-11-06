import { describe, expect, it } from 'vitest';
import type { PanelState } from './match-media-types.js';
import { levelFor, NO_TABLE_AUDIO, tableAudioPid, tableAudioPlan, type TableAudioSettings } from './table-audio-policy.js';

const ON: TableAudioSettings = { tableMuteMine: true, tableSendMine: true, tableHearOthers: true };
const p = (phase: PanelState['phase'], myTurn: boolean, playerUp: string | null) => ({ phase, myTurn, playerUp });

describe('tableAudioPlan (D2.8)', () => {
  it('another player up: mute mine, play theirs', () => {
    expect(tableAudioPlan(p('playing', false, 'krobs'), ON)).toEqual({ muteMine: true, tapMine: false, playTableOf: 'krobs', levelMine: null });
  });

  it('my ball: tap mine, mute nothing, play nobody', () => {
    expect(tableAudioPlan(p('playing', true, 'me'), ON)).toEqual({ muteMine: false, tapMine: true, playTableOf: null, levelMine: null });
  });

  it('paused keeps the turn: still muted on their ball, still tapping on mine', () => {
    expect(tableAudioPlan(p('paused', false, 'krobs'), ON)).toEqual({ muteMine: true, tapMine: false, playTableOf: 'krobs', levelMine: null });
    expect(tableAudioPlan(p('paused', true, 'me'), ON)).toMatchObject({ tapMine: true, muteMine: false });
  });

  it('between grants (nobody up) while playing: mine stays muted (my game-end sounds included), nobody plays', () => {
    expect(tableAudioPlan(p('playing', false, null), ON)).toEqual({ muteMine: true, tapMine: false, playTableOf: null, levelMine: null });
  });

  it('D2.10: my table while I play: levelled on my ball only (also with sending off), untouched at 100 or without the setting', () => {
    const quiet = { ...ON, myTableWhileUp: 40 };
    expect(tableAudioPlan(p('playing', true, 'me'), quiet)).toEqual({ muteMine: false, tapMine: true, playTableOf: null, levelMine: 40 });
    expect(tableAudioPlan(p('paused', true, 'me'), quiet).levelMine).toBe(40);
    expect(tableAudioPlan(p('playing', true, 'me'), { ...quiet, tableSendMine: false }).levelMine).toBe(40);
    expect(tableAudioPlan(p('playing', false, 'krobs'), quiet).levelMine).toBeNull();
    expect(tableAudioPlan(p('idle', false, null), quiet)).toEqual(NO_TABLE_AUDIO);
    expect(tableAudioPlan(p('playing', true, 'me'), { ...ON, myTableWhileUp: 100 }).levelMine).toBeNull();
    expect(tableAudioPlan(p('playing', true, 'me'), ON).levelMine).toBeNull();
    expect(levelFor(99.6)).toBeNull();
    expect(levelFor(55.4)).toBe(55);
    expect(levelFor(3)).toBe(10);
    expect(levelFor(Number.NaN)).toBeNull();
    expect(levelFor(undefined)).toBeNull();
  });

  it('the lobby, the result and no match touch nothing', () => {
    expect(tableAudioPlan(p('idle', false, null), ON)).toEqual(NO_TABLE_AUDIO);
    expect(tableAudioPlan(p('over', false, null), ON)).toEqual(NO_TABLE_AUDIO);
    expect(tableAudioPlan(null, ON)).toEqual(NO_TABLE_AUDIO);
  });

  it('each setting turns its own part off', () => {
    expect(tableAudioPlan(p('playing', false, 'krobs'), { ...ON, tableMuteMine: false })).toEqual({ muteMine: false, tapMine: false, playTableOf: 'krobs', levelMine: null });
    expect(tableAudioPlan(p('playing', false, 'krobs'), { ...ON, tableHearOthers: false })).toEqual({ muteMine: true, tapMine: false, playTableOf: null, levelMine: null });
    expect(tableAudioPlan(p('playing', true, 'me'), { ...ON, tableSendMine: false })).toEqual(NO_TABLE_AUDIO);
  });
});

describe('tableAudioPid (D2.8)', () => {
  it('the capture window pid first, else the witness launch pid, else none', () => {
    expect(tableAudioPid(1200, 900)).toBe(1200);
    expect(tableAudioPid(null, 900)).toBe(900);
    expect(tableAudioPid(undefined, undefined)).toBeNull();
    expect(tableAudioPid(0, -1)).toBeNull();
    expect(tableAudioPid(1.5, 900)).toBe(900);
  });
});
