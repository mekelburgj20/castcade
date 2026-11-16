/**
 * D8.12 (2026-11-15): the corner scoreboard. The owner: "a permanent scoreboard panel showing in the top right of the
 * VR pov display - not in the way of the table feed - but that shows the current scores. I'd also like to see a tally
 * of total games played during the match session and how many wins each player has."
 *
 * A second, small offscreen page beside the match panel (`panel-page.ts`): no media, no controls, only the panel state
 * the match panel gets, drawn as a card: the game and the ball, each player's name and score in turn order with the
 * player who is up marked, and the session tally. `rtc-host.ts` opens it with the headset panel and hands its paint to
 * the OpenXR layer as `CVB1` frames (`vr-layer.ts`, pipe protocol 4), which draws it as a small head-locked quad in a
 * top corner of the view while the mode on screen is hidden (this player's own ball) or theater (vr-layer/README.md
 * "The scoreboard"). The page's background is transparent: the card hugs its rows at the bottom of the frame, so two
 * players make a short card and four a taller one on the same quad.
 *
 * The helpers are embedded in the page as their source text (`toString`), like the match panel's: keep them
 * self-contained (no imports, no closures over this module).
 */
import type { PanelState, ScoreboardCorner } from './match-media-types.js';

export type { ScoreboardCorner };

/** main -> page: the `PanelState` (the same object the match panel gets). */
export const SCOREBOARD_CHANNEL = 'castcade-scoreboard:state';
/** page -> main: the page's script ran and listens. */
export const SCOREBOARD_READY_CHANNEL = 'castcade-scoreboard:ready';

/**
 * The page's size in pixels: 4:3, the tallest frame the layer's placement allows for (vr-layer/src/layer.cpp
 * kScoreboardWidthM: 0.32 m wide at 1 m, about 28 pixels a degree, close to a Quest 3's own).
 */
export const SCOREBOARD_SIZE = { width: 512, height: 384 } as const;

export interface ScoreboardRow {
  name: string;
  score: string;
  /** This player's ball now. */
  up: boolean;
}

export interface ScoreboardView {
  /** `GAME 3 · BALL 2 OF 3`, `PAUSED · GAME 3 · BALL 2 OF 3`, `GAME 3 OVER`. */
  title: string;
  /** The players in turn order (the controller's), never re-sorted: a row does not jump while a score climbs. */
  rows: ScoreboardRow[];
  /** `18 GAMES PLAYED · MekelburgJ 10 · Krobs 8`. */
  tally: string;
}

/**
 * The session tally: games finished in this match and each player's wins, in turn order: `18 GAMES PLAYED ·
 * MekelburgJ 10 · Krobs 8`. Before the first result every count is 0. A player the series does not list yet (joined
 * since the last result) has 0 wins.
 */
export function tallyText(s: Pick<PanelState, 'players' | 'series'>): string {
  const series = s.series || [];
  let games = 0;
  for (const x of series) if (x.games > games) games = x.games;
  const wins = s.players.map((p) => {
    const sr = series.find((x) => x.id === p.id);
    return p.name + ' ' + (sr ? sr.wins : 0);
  });
  return [games + (games === 1 ? ' GAME PLAYED' : ' GAMES PLAYED'), ...wins].join(' · ');
}

/**
 * What the scoreboard shows for a panel state, or null for nothing (no match yet: the lobby has no scores). The
 * match host asks the layer for the scoreboard on the same rule (`scoreboardWanted`), so a null here is never drawn.
 */
export function scoreboardView(s: PanelState | null): ScoreboardView | null {
  if (!s || s.phase === 'idle' || s.players.length === 0) return null;
  const game = typeof s.game === 'number' && s.game > 0 ? s.game : 1;
  let title = 'GAME ' + game;
  if (s.phase === 'over') title += ' OVER';
  else if (s.ball !== null) title += ' · BALL ' + s.ball + ' OF ' + s.ballsPerGame;
  if (s.phase === 'paused') title = 'PAUSED · ' + title;
  const rows = s.players.map((p) => ({
    name: p.name,
    score: p.score === null ? '–' : p.score.toLocaleString('en-US'),
    up: s.phase !== 'over' && p.isUp,
  }));
  return { title, rows, tally: tallyText(s) };
}

/**
 * D8.12: whether the headset should carry the scoreboard for this panel state: a match is on (not the lobby) and the
 * Match tab's setting is on. The layer itself leaves it out while the full panel is up (the panel shows the scores).
 */
export function scoreboardWanted(s: Pick<PanelState, 'phase'> | null, enabled: boolean): boolean {
  return enabled && s !== null && s.phase !== 'idle';
}

const HELPERS = [tallyText, scoreboardView];

/** The page: a transparent 512x384 frame with the card at its bottom edge. */
export function scoreboardPageHtml(): string {
  const helpers = HELPERS.map((f) => f.toString()).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Castcade scoreboard</title>
<style>
  :root { --card: rgba(8, 10, 14, 0.78); --text: #fff; --dim: #b8c0cc; --up: #4fd1ff; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 100%; height: 100%; background: transparent; overflow: hidden; color: var(--text);
    font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 700; }
  body { display: flex; flex-direction: column; justify-content: flex-end; }
  #card { background: var(--card); border-radius: 14px; padding: 12px 16px 12px; display: grid; gap: 6px; }
  #card.off { display: none; }
  #title { font-size: 21px; letter-spacing: 0.06em; color: var(--dim); }
  #rows { display: grid; gap: 4px; }
  .row { display: grid; grid-template-columns: 24px 1fr auto; gap: 6px; align-items: baseline; font-size: 30px; line-height: 1.25; }
  .row .mark { color: var(--up); font-size: 22px; }
  .row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .score { font-variant-numeric: tabular-nums; }
  .row.up .name, .row.up .score { color: var(--up); }
  #tally { font-size: 20px; line-height: 1.3; color: var(--dim); border-top: 2px solid rgba(255, 255, 255, 0.18); padding-top: 6px; }
</style></head>
<body>
<div id="card" class="off"><div id="title"></div><div id="rows"></div><div id="tally"></div></div>
<script>
'use strict';
const { ipcRenderer } = require('electron');
const STATE = ${JSON.stringify(SCOREBOARD_CHANNEL)};
const READY = ${JSON.stringify(SCOREBOARD_READY_CHANNEL)};
${helpers}
${PAGE_SCRIPT}
</script>
</body></html>
`;
}

/** The page's own logic (plain JS; no template literals, so nothing here is interpolated by the TS template above). */
const PAGE_SCRIPT = String.raw`
const $ = (id) => document.getElementById(id);
function render(state) {
  const view = scoreboardView(state);
  $('card').className = view ? '' : 'off';
  $('title').textContent = view ? view.title : '';
  $('tally').textContent = view ? view.tally : '';
  const rows = $('rows');
  rows.replaceChildren();
  for (const r of view ? view.rows : []) {
    const el = document.createElement('div');
    el.className = r.up ? 'row up' : 'row';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = r.up ? '▶' : '';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = r.score;
    el.append(mark, name, score);
    rows.appendChild(el);
  }
}
ipcRenderer.on(STATE, (_e, state) => render(state));
render(null);
ipcRenderer.send(READY);
`;
