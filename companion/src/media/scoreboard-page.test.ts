/**
 * D8.12 (2026-11-15): the corner scoreboard's content (`scoreboardView`, `tallyText`), when the headset carries it
 * (`scoreboardWanted`), and the page itself run over a fake document.
 */
import { describe, expect, it } from 'vitest';
import type { PanelState } from './match-media-types.js';
import { panelPageHtml } from './panel-page.js';
import { SCOREBOARD_CHANNEL, SCOREBOARD_READY_CHANNEL, SCOREBOARD_SIZE, scoreboardPageHtml, scoreboardView, scoreboardWanted, shortName, tallyText } from './scoreboard-page.js';

const state = (o: Partial<PanelState> = {}): PanelState => ({
  playerUp: 'krobs',
  myTurn: false,
  ball: 2,
  ballsPerGame: 3,
  players: [
    { id: 'owner', name: 'MekelburgJ', score: 1_234_560, ballsDone: 2, isUp: false, flags: [] },
    { id: 'krobs', name: 'Krobs', score: 990_000, ballsDone: 1, isUp: true, flags: [] },
  ],
  phase: 'playing',
  result: null,
  message: null,
  mic: 'open',
  ...o,
});

/** The series as the controller hands it: best first (Krobs leads here), not in turn order. */
const series: NonNullable<PanelState['series']> = [
  { id: 'krobs', name: 'Krobs', wins: 10, games: 18, total: 9_000_000, place: 1 },
  { id: 'owner', name: 'MekelburgJ', wins: 8, games: 18, total: 8_000_000, place: 2 },
];

describe("a watcher's scoreboard, and the lobby's PC away (A17 step 9, 2026-11-27, alpha-match.md section 11.9)", () => {
  const members: NonNullable<PanelState['members']> = [
    { id: 'owner', name: 'MekelburgJ', stance: 'play', flags: [], inMatch: true },
    { id: 'krobs', name: 'Krobs', stance: 'play', flags: [], inMatch: true },
    { id: 'chuck', name: 'Chuck', stance: 'watch', flags: [], inMatch: false },
  ];

  it("a watcher's card is the players' card: the game and the ball, the players in turn order with the one who is up marked, the tally; the watcher is no row", () => {
    // A watcher's panel state: not their turn, the match's players, the lobby's rows with themselves in them.
    const watcher = state({ game: 2, ball: 1, members, stance: 'watch', series });
    const player = state({ game: 2, ball: 1, members, stance: 'play', series });
    expect(scoreboardView(watcher)).toEqual(scoreboardView(player));
    expect(scoreboardView(watcher)).toEqual({
      title: 'GAME 2 · BALL 1 OF 3',
      rows: [
        { name: 'MekelburgJ', score: '1,234,560', up: false, away: false },
        { name: 'Krobs', score: '990,000', up: true, away: false },
      ],
      tally: '18 GAMES PLAYED · MekelburgJ 8 · Krobs 10',
    });
    expect(scoreboardWanted(watcher, true)).toBe(true);
    // Not in the lobby: nothing to show there, for a watcher as for a player.
    expect(scoreboardView(state({ phase: 'idle', playerUp: null, ball: null, members, stance: 'watch' }))).toBeNull();
    expect(scoreboardWanted(state({ phase: 'idle', members, stance: 'watch' }), true)).toBe(false);
  });

  it("`LOBBY PC AWAY` stands before the title while the lobby's PC is away; a player who is up and away keeps their own words", () => {
    const hostAway = members.map((m, i) => (i === 0 ? { ...m, flags: ['away' as const] } : m));
    expect(scoreboardView(state({ game: 2, ball: 1, members: hostAway }))?.title).toBe('LOBBY PC AWAY · GAME 2 · BALL 1 OF 3');
    expect(scoreboardView(state({ game: 2, ball: 1, members: hostAway, phase: 'paused' }))?.title).toBe('LOBBY PC AWAY · GAME 2 · BALL 1 OF 3');
    expect(scoreboardView(state({ game: 2, ball: null, members: hostAway, phase: 'over', playerUp: null }))?.title).toBe('LOBBY PC AWAY · GAME 2 OVER');
    // Krobs is up and away, read by somebody who watches: that is said, and not the lobby's PC with it.
    expect(scoreboardView(state({ game: 2, ball: 1, members, phase: 'paused', pausedFor: 'krobs' }))?.title).toBe('KROBS AWAY · GAME 2 · BALL 1 OF 3');
    expect(scoreboardView(state({ game: 2, ball: 1, members: hostAway, phase: 'paused', pausedFor: 'krobs' }))?.title).toBe('KROBS AWAY · GAME 2 · BALL 1 OF 3');
    // Nobody away, or no lobby: the title as it was.
    expect(scoreboardView(state({ game: 2, ball: 1, members }))?.title).toBe('GAME 2 · BALL 1 OF 3');
    expect(scoreboardView(state({ game: 2, ball: 1, phase: 'paused' }))?.title).toBe('PAUSED · GAME 2 · BALL 1 OF 3');
  });
});

describe('the corner scoreboard (D8.12)', () => {
  it('tally: games played and each player\'s wins in turn order; zeros before the first result; a player the series does not list has 0', () => {
    expect(tallyText(state({ series }))).toBe('18 GAMES PLAYED · MekelburgJ 8 · Krobs 10');
    expect(tallyText(state({ series: null }))).toBe('0 GAMES PLAYED · MekelburgJ 0 · Krobs 0');
    expect(tallyText(state())).toBe('0 GAMES PLAYED · MekelburgJ 0 · Krobs 0');
    expect(tallyText(state({ series: [{ id: 'krobs', name: 'Krobs', wins: 1, games: 1, total: 5, place: 1 }] }))).toBe('1 GAME PLAYED · MekelburgJ 0 · Krobs 1');
  });

  it('view: the game and the ball, names and scores in turn order with the player up marked, the tally', () => {
    expect(scoreboardView(state({ game: 19, series }))).toEqual({
      title: 'GAME 19 · BALL 2 OF 3',
      rows: [
        { name: 'MekelburgJ', score: '1,234,560', up: false, away: false },
        { name: 'Krobs', score: '990,000', up: true, away: false },
      ],
      tally: '18 GAMES PLAYED · MekelburgJ 8 · Krobs 10',
    });
    // A18: a player who is away from the match (the panel's `disconnected` flag) is marked on their row: this card is
    // what the player who is up sees of the match, and the match no longer pauses to say it.
    const away = state({ myTurn: true, playerUp: 'owner', ball: 2, players: [
      { id: 'owner', name: 'MekelburgJ', score: 5, ballsDone: 1, isUp: true, flags: [] },
      { id: 'krobs', name: 'Krobs', score: 7, ballsDone: 1, isUp: false, flags: ['disconnected'] },
    ] });
    expect(scoreboardView(away)?.rows).toEqual([{ name: 'MekelburgJ', score: '5', up: true, away: false }, { name: 'Krobs', score: '7', up: false, away: true }]);
    expect(scoreboardView(away)?.title).toBe('GAME 1 · BALL 2 OF 3');
    // My own ball: the same card, my row marked; a player with no score yet shows a dash.
    const mine = state({ myTurn: true, playerUp: 'owner', ball: 1, players: [
      { id: 'owner', name: 'MekelburgJ', score: null, ballsDone: 0, isUp: true, flags: [] },
      { id: 'krobs', name: 'Krobs', score: null, ballsDone: 0, isUp: false, flags: [] },
    ] });
    expect(scoreboardView(mine)).toMatchObject({ title: 'GAME 1 · BALL 1 OF 3', rows: [{ name: 'MekelburgJ', score: '–', up: true }, { name: 'Krobs', score: '–', up: false }] });
  });

  it('view: paused and between games say so; the gap between grants has no ball; the lobby and no state show nothing', () => {
    expect(scoreboardView(state({ phase: 'paused', game: 2 }))?.title).toBe('PAUSED · GAME 2 · BALL 2 OF 3');
    const over = scoreboardView(state({ phase: 'over', game: 2, playerUp: null, ball: null }));
    expect(over?.title).toBe('GAME 2 OVER');
    expect(over?.rows.every((r) => !r.up)).toBe(true);
    expect(scoreboardView(state({ playerUp: null, ball: null, game: 3 }))?.title).toBe('GAME 3');
    expect(scoreboardView(state({ phase: 'idle', playerUp: null, ball: null }))).toBeNull();
    expect(scoreboardView(null)).toBeNull();
    expect(scoreboardView(state({ players: [] }))).toBeNull();
  });

  it('A17 step 4 (2026-11-24): the AWAY title: a pause for the player who is up reads `KROBS AWAY ·` on a watcher\'s card; any other pause, and that player\'s own card, read PAUSED', () => {
    // Krobs is up, his link to the host dropped, and the match is paused for him: the people watching keep his
    // picture while it arrives, and this card is what says he is away.
    expect(scoreboardView(state({ phase: 'paused', game: 2, pausedFor: 'krobs' }))?.title).toBe('KROBS AWAY · GAME 2 · BALL 2 OF 3');
    // A pause with nobody named (the host's own, a ball-end timeout), and one for a player who is not the one up.
    expect(scoreboardView(state({ phase: 'paused', game: 2, pausedFor: null }))?.title).toBe('PAUSED · GAME 2 · BALL 2 OF 3');
    // The final review (finding 4): a pause for a player who is not the one up says for whom it waits.
    expect(scoreboardView(state({ phase: 'paused', game: 2, pausedFor: 'owner' }))?.title).toBe('WAITING FOR MEKELBURGJ · GAME 2 · BALL 2 OF 3');
    expect(scoreboardView(state({ phase: 'paused', game: 2, pausedFor: 'owner', playerUp: null, ball: null, players: state().players.map((x) => ({ ...x, isUp: false })) }))?.title).toBe('WAITING FOR MEKELBURGJ · GAME 2');
    // The card of the player the pause is for (back on the link, their own ball): PAUSED, as D8.14 has it.
    expect(scoreboardView(state({ phase: 'paused', myTurn: true, playerUp: 'owner', pausedFor: 'owner' }))?.title).toBe('PAUSED · GAME 1 · BALL 2 OF 3');
    // Outside a pause the key means nothing.
    expect(scoreboardView(state({ pausedFor: 'krobs' }))?.title).toBe('GAME 1 · BALL 2 OF 3');
    // The page embeds the rule with the rest of the view.
    expect(scoreboardPageHtml()).toMatch(/toUpperCase\(\) \+ ["'] AWAY["']/);
  });

  it('wanted: a match is on and the setting is on; never in the lobby', () => {
    expect(scoreboardWanted(state(), true)).toBe(true);
    expect(scoreboardWanted(state({ phase: 'paused' }), true)).toBe(true);
    expect(scoreboardWanted(state({ phase: 'over' }), true)).toBe(true);
    expect(scoreboardWanted(state({ phase: 'idle' }), true)).toBe(false);
    expect(scoreboardWanted(state(), false)).toBe(false);
    expect(scoreboardWanted(null, true)).toBe(false);
  });

  // ---- the page, run over a fake document (no body, no style: only what the page touches) ----
  class FakeElement {
    textContent = '';
    className = '';
    children: FakeElement[] = [];
    appendChild(c: FakeElement): void {
      this.children.push(c);
    }
    append(...c: FakeElement[]): void {
      this.children.push(...c);
    }
    replaceChildren(): void {
      this.children = [];
    }
  }

  function runPage() {
    const html = scoreboardPageHtml();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    const els = new Map<string, FakeElement>();
    const document = {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, new FakeElement());
        return els.get(id)!;
      },
      createElement: () => new FakeElement(),
    };
    const sent: string[] = [];
    const handlers = new Map<string, (e: unknown, arg: unknown) => void>();
    const require = () => ({
      ipcRenderer: {
        send: (ch: string) => void sent.push(ch),
        on: (ch: string, cb: (e: unknown, arg: unknown) => void) => void handlers.set(ch, cb),
      },
    });
    new Function('require', 'document', script)(require, document);
    return { html, sent, el: (id: string) => document.getElementById(id), state: (s: PanelState | null) => handlers.get(SCOREBOARD_CHANNEL)?.({}, s) };
  }

  it('page: nothing until a match state; then the title, a row per player with the one up marked, the tally; back to nothing in the lobby', () => {
    const p = runPage();
    expect(p.sent).toEqual([SCOREBOARD_READY_CHANNEL]);
    expect(p.el('card').className).toBe('off');
    p.state(state({ game: 19, series }));
    expect(p.el('card').className).toBe('');
    expect(p.el('title').textContent).toBe('GAME 19 · BALL 2 OF 3');
    expect(p.el('rows').children.map((r) => [r.className, ...r.children.map((c) => c.textContent)])).toEqual([
      ['row', '', 'MekelburgJ', '1,234,560'],
      ['row up', '▶', 'Krobs', '990,000'],
    ]);
    expect(p.el('tally').textContent).toBe('18 GAMES PLAYED · MekelburgJ 8 · Krobs 10');
    // The next state replaces the rows (never appends to them).
    p.state(state({ game: 19, series, myTurn: true, playerUp: 'owner', players: state().players.map((x) => ({ ...x, isUp: x.id === 'owner' })) }));
    expect(p.el('rows').children.map((r) => r.className)).toEqual(['row up', 'row']);
    p.state(state({ phase: 'idle', playerUp: null, ball: null }));
    expect(p.el('card').className).toBe('off');
    expect(p.el('rows').children).toEqual([]);
    p.state(null);
    expect(p.el('card').className).toBe('off');
  });

  it('page: a transparent 4:3 frame with the card at its bottom; the helpers are embedded and self-contained', () => {
    const html = scoreboardPageHtml();
    expect(SCOREBOARD_SIZE).toEqual({ width: 512, height: 384 });
    expect(html).toContain('background: transparent');
    expect(html).toContain('justify-content: flex-end');
    expect(html).toContain('function scoreboardView');
    expect(html).toContain('function tallyText');
    // The final review (finding 10): the helper that cuts a long name is one of them.
    expect(html).toContain('function shortName');
    const standalone = new Function(`${shortName.toString()}; ${tallyText.toString()}; ${scoreboardView.toString()}; return scoreboardView;`)() as typeof scoreboardView;
    expect(standalone(state({ game: 2, series }))?.tally).toBe('18 GAMES PLAYED · MekelburgJ 8 · Krobs 10');
  });

  it('the match panel carries the tally too (the between-games panel and the desktop panel): embedded with its helpers', () => {
    for (const vr of [true, false]) {
      const html = panelPageHtml({ vr });
      expect(html).toContain('function tallyText');
      expect(html).toContain("tally.textContent = tallyText(panel)");
    }
  });
});
