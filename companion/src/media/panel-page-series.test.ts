/**
 * A10 + A11 (2026-11-02): the panel's text for a series of games and the start countdown (`headerText`, `stripRows`).
 * A file of its own beside panel-page.test.ts, which other lanes edit.
 */
import { describe, expect, it } from 'vitest';
import type { PanelState } from './match-media-types.js';
import { headerText, panelPageHtml, stripRows } from './panel-page.js';

const state = (o: Partial<PanelState> = {}): PanelState => ({
  playerUp: 'krobs',
  myTurn: false,
  ball: 2,
  ballsPerGame: 3,
  players: [
    { id: 'owner', name: 'Owner', score: 1_234_560, ballsDone: 2, isUp: false, flags: [] },
    { id: 'krobs', name: 'Krobs', score: 990_000, ballsDone: 1, isUp: true, flags: [] },
  ],
  phase: 'playing',
  result: null,
  message: null,
  mic: 'open',
  ...o,
});

const series: NonNullable<PanelState['series']> = [
  { id: 'owner', name: 'Owner', wins: 1, games: 2, total: 2_000_000, place: 1 },
  { id: 'krobs', name: 'Krobs', wins: 1, games: 2, total: 1_500_000, place: 2 },
];

describe('panel text for a series (A10) and the start countdown (A11)', () => {
  it('header: the game from game 2 on, GAME n OVER between games, MATCH OVER at the end, STARTING IN n in the lobby', () => {
    expect(headerText(state({ game: 1 }))).toBe('KROBS IS UP');
    expect(headerText(state({ game: 2, myTurn: true, playerUp: 'owner' }))).toBe('GAME 2 · YOUR BALL 2');
    expect(headerText(state({ game: 3, phase: 'paused' }))).toBe('PAUSED · GAME 3 · KROBS IS UP');
    expect(headerText(state({ phase: 'over', game: 2, seriesOver: false }))).toBe('GAME 2 OVER');
    expect(headerText(state({ phase: 'over', game: 2, seriesOver: true }))).toBe('MATCH OVER');
    // A state from before A10 (no series fields) still reads as the end of the match.
    expect(headerText(state({ phase: 'over' }))).toBe('MATCH OVER');
    expect(headerText(state({ phase: 'idle', countdown: 4 }))).toBe('STARTING IN 4');
    expect(headerText(state({ phase: 'idle', countdown: null }))).toBe('WAITING FOR THE START');
  });

  it('strip: a result row adds the series place and wins once the series has two games; a playing row the wins as a note', () => {
    const result = [
      { id: 'krobs', name: 'Krobs', score: 1_000_000, place: 1 },
      { id: 'owner', name: 'Owner', score: 800_000, place: 2 },
    ];
    expect(stripRows(state({ phase: 'over', result, game: 2, series })).map((r) => [r.name, r.detail])).toEqual([
      ['Krobs', '#1 · SERIES #2 · 1 WIN'],
      ['Owner', '#2 · SERIES #1 · 1 WIN'],
    ]);
    // After game 1 the series says nothing the game's place does not.
    const one = series.map((x) => ({ ...x, games: 1 }));
    expect(stripRows(state({ phase: 'over', result, game: 1, series: one })).map((r) => r.detail)).toEqual(['#1', '#2']);
    expect(stripRows(state({ game: 3, series: series.map((x) => ({ ...x, wins: x.id === 'owner' ? 2 : 0 })) })).map((r) => r.notes)).toEqual([['2 WINS'], ['0 WINS']]);
    expect(stripRows(state({ game: 1, series: one })).map((r) => r.notes)).toEqual([[], []]);
  });

  it('strip: a lobby row whose table is not open yet says LOADING', () => {
    const lobby = state({ phase: 'idle', playerUp: null, ball: null, players: [{ id: 'krobs', name: 'Krobs', score: null, ballsDone: 0, isUp: false, flags: ['loading'] }] });
    expect(stripRows(lobby)[0]?.flags).toEqual(['LOADING']);
  });

  it('the page still embeds the helpers (they stay self-contained)', () => {
    const html = panelPageHtml({ vr: false });
    expect(html).toContain('function headerText');
    expect(html).toContain('SERIES #');
    // headerText as the page gets it (its source text), with nothing around it.
    const standalone = new Function(`${headerText.toString()}; return headerText;`)() as typeof headerText;
    expect(standalone(state({ phase: 'over', game: 2, seriesOver: false }))).toBe('GAME 2 OVER');
  });
});
