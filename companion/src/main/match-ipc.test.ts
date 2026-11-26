/**
 * A17 step 7 (2026-11-25, the review of PR 136): what the Match tab sends for the lobby's presses is one of the
 * choices or it is refused; nothing else is read as one of them.
 */
import { describe, expect, it } from 'vitest';
import { readAbout, readAwayAnswer, readEndMatch, readPlayer, readStance } from './match-ipc.js';

describe('the lobby\'s presses, read in the main process', () => {
  it('Play or Watch is one of the two; anything else changes nothing (it is not read as Play, which would put a watcher into the next start)', () => {
    expect(readStance('play')).toBe('play');
    expect(readStance('watch')).toBe('watch');
    for (const v of [undefined, null, '', 'Watch', 'spectate', 0, true, {}, ['watch']]) expect(() => readStance(v)).toThrow('Play or Watch: not understood, nothing was changed');
  });

  it('the answer about a player who is away is one of the three; anything else does nothing (it is not read as Keep waiting, which would close the question for another turn clock)', () => {
    expect(readAwayAnswer('wait', { player: 'p1' })).toEqual({ answer: 'wait', player: 'p1' });
    expect(readAwayAnswer('end_ball', undefined)).toEqual({ answer: 'end_ball', player: null });
    expect(readAwayAnswer('play_on', {})).toEqual({ answer: 'play_on', player: null });
    for (const v of [undefined, null, '', 'end', 'End_Ball', 1, {}]) expect(() => readAwayAnswer(v, {})).toThrow(/not understood, nothing was done/);
    expect(() => readAwayAnswer('wait', { player: 7 })).toThrow(/not understood/);
  });

  it('End match says which of the two it is; a request that does not is refused, never taken for either', () => {
    expect(readEndMatch({ everyone: false, about: 'JHDFEF-1/2/between' })).toEqual({ everyone: false, about: 'JHDFEF-1/2/between' });
    expect(readEndMatch({ everyone: true })).toEqual({ everyone: true, about: null });
    for (const v of [undefined, null, {}, { everyone: 'true' }, { everyone: 1 }, 'everyone', true]) expect(() => readEndMatch(v)).toThrow('End match: not understood, nothing was ended');
    expect(() => readEndMatch({ everyone: true, about: { game: 2 } })).toThrow(/not understood/);
    expect(() => readEndMatch({ everyone: true, about: 'x'.repeat(201) })).toThrow(/not understood/);
  });

  it('what a press was about is a short string or nothing', () => {
    expect(readAbout({ about: 'JHDFEF-1/1/game' }, 'Give up this game')).toEqual({ about: 'JHDFEF-1/1/game' });
    expect(readAbout(undefined, 'Give up this game')).toEqual({ about: null });
    expect(() => readAbout({ about: 3 }, 'Give up this game')).toThrow('Give up this game: not understood, nothing was done');
    expect(readPlayer({ player: 'p2' }, 'Play on without')).toEqual({ player: 'p2' });
    expect(readPlayer(null, 'Play on without')).toEqual({ player: null });
    expect(() => readPlayer({ player: [] }, 'Play on without')).toThrow('Play on without: not understood, nothing was done');
  });
});
