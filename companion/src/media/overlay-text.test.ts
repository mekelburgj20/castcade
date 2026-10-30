import { describe, expect, it } from 'vitest';
import type { OverlayState } from './overlay-server.js';
import { groupThousands, overlayText } from './overlay-text.js';

const LIVE = { kind: 'live', text: 'Arcaid Witness · live' } as const;

function state(o: Partial<OverlayState> = {}): OverlayState {
  return { v: 1, table: null, game: null, badge: { kind: 'idle', text: 'Arcaid Witness · waiting for a table' }, attempt: null, lastPost: null, ...o };
}
const game = (g: Partial<NonNullable<OverlayState['game']>>): OverlayState['game'] => ({ inGame: true, scores: [], player: 1, ball: null, ...g });

describe('burned-in overlay text (D1.4)', () => {
  it('idle: no table, the badge alone', () => {
    expect(overlayText(state())).toBe('Arcaid Witness · waiting for a table');
  });

  it('in a game, one player: the table, the player up with the ball, the badge', () => {
    const s = state({ table: 'Monster Bash', game: game({ scores: [1_234_560], player: 1, ball: 2 }), badge: LIVE });
    expect(overlayText(s)).toBe('Monster Bash\n▶ P1 1,234,560 · Ball 2\nArcaid Witness · live');
  });

  it('two players with player 2 up: one line each, the ball on the player-up line', () => {
    const s = state({ table: 'Monster Bash', game: game({ scores: [4_571_120, 980], player: 2, ball: 1 }), badge: LIVE });
    expect(overlayText(s)).toBe('Monster Bash\nP1 4,571,120\n▶ P2 980 · Ball 1\nArcaid Witness · live');
  });

  it('no score yet: "In play", with the ball when known', () => {
    expect(overlayText(state({ table: 'Monster Bash', game: game({ scores: [null], ball: 1 }), badge: LIVE }))).toBe('Monster Bash\nIn play · Ball 1\nArcaid Witness · live');
    expect(overlayText(state({ table: 'Monster Bash', game: game({}), badge: LIVE }))).toBe('Monster Bash\nIn play\nArcaid Witness · live');
  });

  it('a limited-attempts game: the attempt on its own line (in a game only)', () => {
    const s = state({ table: 'Monster Bash', game: game({ scores: [10_000], ball: 3 }), badge: LIVE, attempt: 'Attempt 2 of 10' });
    expect(overlayText(s)).toBe('Monster Bash\n▶ P1 10,000 · Ball 3\nAttempt 2 of 10\nArcaid Witness · live');
    expect(overlayText({ ...s, game: null })).toBe('Monster Bash\nArcaid Witness · live');
  });

  it('after a post: the last game in a viewer’s words', () => {
    const s = state({ table: 'Monster Bash', game: game({ inGame: false, scores: [4_571_120] }), badge: LIVE, lastPost: { score: 4_571_120, outcome: 'ingested', table: 'Monster Bash' } });
    expect(overlayText(s)).toBe('Monster Bash\nLast game: 4,571,120 · posted\nArcaid Witness · live');
    const words = (outcome: string) => overlayText({ ...s, lastPost: { score: 1, outcome, table: 'Monster Bash' } }).split('\n')[1];
    expect(['queued', 'duplicate', 'rejected', 'skipped', 'mystery'].map(words)).toEqual([
      'Last game: 1 · queued',
      'Last game: 1 · already posted',
      'Last game: 1 · not counted',
      'Last game: 1 · skipped',
      'Last game: 1 · mystery',
    ]);
  });

  it('unpaired: the unpaired badge', () => {
    expect(overlayText(state({ table: 'Monster Bash', badge: { kind: 'unpaired', text: 'Castcade · not paired with ArcAid' } }))).toBe('Monster Bash\nCastcade · not paired with ArcAid');
  });

  it('groups thousands whatever the locale', () => {
    expect([0, 999, 1000, 4_571_120, 1_000_000_000].map(groupThousands)).toEqual(['0', '999', '1,000', '4,571,120', '1,000,000,000']);
  });

  it('escapes what drawtext would expand (a stray % stops the encode)', () => {
    expect(overlayText(state({ table: '100% Pinball \\ Deluxe' }))).toBe('100\\% Pinball \\\\ Deluxe\nArcaid Witness · waiting for a table');
  });
});
