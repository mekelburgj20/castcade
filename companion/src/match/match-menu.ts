/**
 * D8.10 (2026-11-14, owner: "I didn't see the option to start the match in the VR panel ... I also want audio control
 * available in VR panel ... map one of the buttons on our pinball controllers to bring up the panel"): the in-game
 * menu. A key brings it up on the match panel (in the headset, or the desktop panel window) while VPX has the focus;
 * it starts the match or the next game, sets the three volumes, mutes the microphone and leaves the match.
 *
 * This file is the pure part: what the menu holds for a match state (`menuItems`), what one key press does
 * (`menuPress`), and how a press of the menu key is read by its distance from the last one (`readMenuKey`). The match
 * host owns the keys, the clock and the effects (main/match-host.ts).
 *
 * Keys. VPX reads the keyboard itself (DirectInput), so a key Castcade takes as a global shortcut still reaches the
 * table: Enter would pull the plunger and Esc would open VPX's own menu. The menu therefore never uses them:
 *   - the menu key opens the menu, and pressed again moves to the next line (round and round);
 *   - the choose key chooses the line; with one spare button only, the menu key pressed twice quickly does the same;
 *   - while the menu is open the arrow keys work too: Up / Down move, Right chooses or raises, Left lowers.
 * A line that ends something (Leave match, a start with a warning) asks for a second choose.
 *
 * D8.12.3 (2026-11-21): one more line while the headset's scoreboard is held at a place in the room, "Put the
 * scoreboard where I look": the player points the head where the scoreboard should be and chooses the line; the OpenXR
 * layer captures the place again from the head's pose at that moment (`placeScoreboard` on the overlay). The menu is on
 * the head-locked panel, so it stays readable wherever the head points.
 *
 * A17 step 4 (2026-11-24, alpha-match.md §11.2, §11.9): "End my ball" for the player who is up: their ball ends at
 * the score as it stands and the turn passes (their own BALL_END, `manual`). For a table whose ball ends Castcade
 * cannot read and for a stuck ball, from the headset, where the player is; it asks for a second choose.
 *
 * The review of PR 131: the question is about one grant. `MenuFacts.endBall` carries the grant, the first choose
 * notes it (`MenuState.confirmFor`), and a second choose for another grant (the table ended the ball with an extra
 * ball in between: the same ball number, another score) only asks again. And the question says what becomes of a
 * ball that is still on the table: it is played out at the next turn.
 *
 * A17 step 7 (2026-11-25, alpha-match.md section 11.9): in a lobby (`MenuFacts.lobby`) the menu is every member's,
 * and its lines are the lobby's: Start match / Next game for anyone (off with the sentence of the check that fails; a
 * second choose where Start anyway is needed; **Start without Dana** while a start waits, **Cancel the start** while
 * one is announced), Start a new match when it applies, Play or watch (a choose flips it), the volumes and the
 * microphone as before, End my ball, Give up this game, End match (between games; on the lobby's PC during a game:
 * End match for everyone), the lobby PC's answers about a player who is away, and Leave lobby (the lobby's PC:
 * Close lobby). Without `lobby` in the facts the menu is the one it was. The table is changed on the Match tab only.
 */

import type { PanelMenu } from '../media/match-media-types.js';
import { possessive } from '../witness/midnight.js';

export type MenuItemId =
  | 'start'
  | 'next'
  | 'voice'
  | 'theirTable'
  | 'myTable'
  | 'mic'
  | 'scoreboard'
  | 'endBall'
  | 'leave'
  | 'close'
  // A17 step 7: the lobby's lines. A line whose meaning differs has an id of its own (the review of PR 136): the
  // start that goes without what it waits for is `startNow`, never `start`; End match for everyone is `endMatchAll`.
  | 'cancelStart'
  | 'startNow'
  | 'newMatch'
  | 'stance'
  | 'giveUp'
  | 'endMatch'
  | 'endMatchAll'
  | 'awayWait'
  | 'awayEnd'
  | 'awayPlayOn'
  | 'playOn';
export type MenuVolume = 'voice' | 'theirTable' | 'myTable';

/** What the match host knows that decides the menu's lines. */
export interface MenuFacts {
  role: 'host' | 'client';
  phase: 'lobby' | 'playing' | 'paused' | 'over';
  /** Players in the lobby or the match, this one included. */
  players: number;
  /** A13: the lobby's "cannot report ball ends" lines; not empty: Start match asks for a second choose. */
  startWarnings: readonly string[];
  /** A10: the series is over for good (no next game). */
  seriesOver: boolean;
  /** A10: for the host between games: why the next game cannot start now, null when it can. */
  nextGameBlocker: string | null;
  voice: number;
  theirTable: number;
  myTable: number;
  mic: 'open' | 'muted' | 'unavailable';
  /**
   * D8.12.3: the "Put the scoreboard where I look" line. null: no such line (no headset scoreboard in this match now,
   * or it follows the head by the Match tab's setting). `ready`: the layer in VPX can place it. `old_layer`: the layer
   * VPX loaded predates the scoreboard in the room (it follows the head until VPX restarts). `not_connected`: no layer
   * is on the pipe yet.
   */
  scoreboardPlace: 'ready' | 'old_layer' | 'not_connected' | null;
  /**
   * A17 step 4: the "End my ball" line: the ball this player is playing and the score it would end at; null (or absent,
   * in facts from before it): no such line (it is not this player's ball, or the match is paused).
   */
  endBall?: { ball: number; score: number; grantSeq?: number; tableBall?: boolean } | null;
  /**
   * A17 step 7: the match is in a lobby: the lines are the lobby's (the file header). Null or absent: no lobby, the
   * menu as it was.
   */
  lobby?: MenuLobby | null;
}

/** A17 step 7: what the match host knows of the lobby that decides the menu's lines. */
export interface MenuLobby {
  /** This PC opened the lobby: its Leave closes the lobby for everyone. */
  opener: boolean;
  stance: 'play' | 'watch';
  /** The start line: its words (Start match, Next game) and why it cannot be chosen now (null: it can). */
  start: { label: string; off: string | null };
  /** A start is announced. `without`: while it waits for people or 3D, the words of the second press ("Start without Dana"). */
  announced: { without: string | null } | null;
  /**
   * Start a new match applies: a match is open between games and somebody outside it is set to Play. `warnings`: the
   * tables among the new match's players that cannot report ball ends (the review of PR 136): they are in the
   * line's question, and the choose that answers it starts anyway.
   */
  newMatch: { warnings: readonly string[] } | null;
  /**
   * What a question of the lobby's lines is about: the open match and its game ("JHDFEF-2/3"; empty: no match). A
   * question asked in one game is not answered in another (the review of PR 136).
   */
  game?: string;
  /** The lobby's PC is away: what would only be sent into a link that is down is off, and says so. */
  hostAway?: boolean;
  /** The lobby is over on this PC (it lingers a moment before it closes): the volumes and Close menu are what is left. */
  over?: boolean;
  /** What End match would end: the open match, between games; on the lobby's PC during a game, the match for everyone. */
  end: 'match' | 'everyone' | null;
  /** This player plays the game that is being played and may give it up. */
  giveUp: boolean;
  /** The lobby's PC: the name of the player the game waits for at their own turn; null: nobody. */
  waitedFor: string | null;
  /** The lobby's PC: that player is up, out of reach and still seen playing: the three answers, and the score their ball would end at. */
  awayQuestion: { name: string; score: number } | null;
}

export interface MenuItem {
  id: MenuItemId;
  label: string;
  /** The line's current value ("150 %", "ON"), null for an action. */
  value: string | null;
  /** Why the line cannot be chosen now, null when it can. */
  off: string | null;
  /** The question a first choose asks, null when one choose is enough. */
  confirm: string | null;
  /** What the question is about (a game of a match); the second choose counts only for the same one. Absent: nothing that changes. */
  subject?: string | null;
}

/** The menu's volume lines: the range (percent) and the step of one press. */
export const MENU_VOLUME: Record<MenuVolume, { min: number; max: number; step: number }> = {
  voice: { min: 0, max: 300, step: 25 },
  theirTable: { min: 0, max: 100, step: 10 },
  myTable: { min: 10, max: 100, step: 10 },
};

const isVolume = (id: MenuItemId): id is MenuVolume => id === 'voice' || id === 'theirTable' || id === 'myTable';

/**
 * The menu's question before a ball is ended by hand: the score it ends at, and, on a table whose ball is still in
 * play, that the ball is not lost (the review of PR 131: it is played out first at the player's next turn).
 */
export function endBallQuestion(b: { score: number; tableBall?: boolean }): string {
  return `Choose again to end your ball at ${b.score.toLocaleString('en-US')}${b.tableBall ? '. The ball on your table is played out first at your next turn' : ''}`;
}

export function menuItems(f: MenuFacts): MenuItem[] {
  const items: MenuItem[] = [];
  if (f.lobby) return lobbyItems(f, f.lobby);
  if (f.role === 'host' && f.phase === 'lobby') {
    items.push({
      id: 'start',
      label: 'Start match',
      value: null,
      off: f.players < 2 ? 'Nobody has joined yet' : null,
      confirm: f.startWarnings.length > 0 ? `${f.startWarnings.join(' · ')}. Choose again to start anyway` : null,
    });
  }
  if (f.role === 'host' && f.phase === 'over' && !f.seriesOver) {
    items.push({ id: 'next', label: 'Next game', value: null, off: f.nextGameBlocker, confirm: null });
  }
  items.push({ id: 'voice', label: 'Voice volume', value: `${f.voice} %`, off: null, confirm: null });
  items.push({ id: 'theirTable', label: 'Their table sound', value: `${f.theirTable} %`, off: null, confirm: null });
  items.push({ id: 'myTable', label: 'My table while I play', value: `${f.myTable} %`, off: null, confirm: null });
  items.push({
    id: 'mic',
    label: 'Microphone',
    value: f.mic === 'open' ? 'ON' : f.mic === 'muted' ? 'MUTED' : 'NONE',
    off: f.mic === 'unavailable' ? 'No microphone on this PC' : null,
    confirm: null,
  });
  if (f.scoreboardPlace !== null) {
    items.push({
      id: 'scoreboard',
      label: 'Put the scoreboard where I look',
      value: null,
      off:
        f.scoreboardPlace === 'old_layer'
          ? 'Restart VPX first: until then the scoreboard follows your head'
          : f.scoreboardPlace === 'not_connected'
            ? 'The headset is not showing Castcade yet'
            : null,
      confirm: null,
    });
  }
  // A17 step 4: the player who is up may end their own ball by hand; the score is said before it is done.
  if (f.endBall) {
    items.push({ id: 'endBall', label: 'End my ball', value: null, off: null, confirm: endBallQuestion(f.endBall) });
  }
  // The host's leave between games is End match (A10); at any other time, and for a client, it is Leave match.
  const ends = f.role === 'host' && f.phase === 'over' && !f.seriesOver;
  items.push({
    id: 'leave',
    label: ends ? 'End match' : 'Leave match',
    value: null,
    off: null,
    confirm: ends ? 'Choose again to end the match for everyone' : 'Choose again to leave the match',
  });
  items.push({ id: 'close', label: 'Close menu', value: null, off: null, confirm: null });
  return items;
}

/** The lines every menu has: the three volumes, the microphone, the scoreboard's place and End my ball. */
function commonItems(f: MenuFacts, items: MenuItem[], subject: string | null = null): void {
  items.push({ id: 'voice', label: 'Voice volume', value: `${f.voice} %`, off: null, confirm: null });
  items.push({ id: 'theirTable', label: 'Their table sound', value: `${f.theirTable} %`, off: null, confirm: null });
  items.push({ id: 'myTable', label: 'My table while I play', value: `${f.myTable} %`, off: null, confirm: null });
  items.push({
    id: 'mic',
    label: 'Microphone',
    value: f.mic === 'open' ? 'ON' : f.mic === 'muted' ? 'MUTED' : 'NONE',
    off: f.mic === 'unavailable' ? 'No microphone on this PC' : null,
    confirm: null,
  });
  if (f.scoreboardPlace !== null) {
    items.push({
      id: 'scoreboard',
      label: 'Put the scoreboard where I look',
      value: null,
      off:
        f.scoreboardPlace === 'old_layer'
          ? 'Restart VPX first: until then the scoreboard follows your head'
          : f.scoreboardPlace === 'not_connected'
            ? 'The headset is not showing Castcade yet'
            : null,
      confirm: null,
    });
  }
  // `subject` (a lobby): the match and its game; every match numbers its grants from 1 again.
  if (f.endBall) items.push({ id: 'endBall', label: 'End my ball', value: null, off: null, confirm: endBallQuestion(f.endBall), ...(subject !== null ? { subject } : {}) });
}

/** A17 step 7 (alpha-match.md section 11.9): the menu of a member of a lobby, top to bottom. */
function lobbyItems(f: MenuFacts, l: MenuLobby): MenuItem[] {
  const items: MenuItem[] = [];
  if (l.over) {
    commonItems({ ...f, endBall: null }, items);
    items.push({ id: 'close', label: 'Close menu', value: null, off: null, confirm: null });
    return items;
  }
  const game = f.phase === 'playing' || f.phase === 'paused';
  const subject = l.game ?? '';
  const away = l.hostAway ? "The lobby's PC is away: this waits until it is back" : null;
  if (l.announced) {
    // A second choose while a start waits starts without what it waits for; anybody takes a start back.
    if (l.announced.without !== null) items.push({ id: 'startNow', label: l.announced.without, value: null, off: away, confirm: null });
    items.push({ id: 'cancelStart', label: 'Cancel the start', value: null, off: away, confirm: null });
  } else if (!game) {
    // Not while a game is being played: nothing can start then, and the first line of the menu is not one that is off.
    items.push({
      id: 'start',
      label: l.start.label,
      value: null,
      off: l.start.off,
      confirm: l.start.off === null && f.startWarnings.length > 0 ? `${f.startWarnings.join(' · ')}. Choose again to start anyway` : null,
      subject,
    });
    if (l.newMatch) {
      const w = l.newMatch.warnings;
      items.push({ id: 'newMatch', label: 'Start a new match', value: null, off: null, confirm: w.length > 0 ? `${w.join(' · ')}. Choose again to start anyway: the open match ends` : 'Choose again: the open match ends', subject });
    }
  }
  items.push({ id: 'stance', label: 'Play or watch', value: l.stance === 'play' ? 'PLAY' : 'WATCH', off: null, confirm: null });
  commonItems(f, items, subject);
  if (l.giveUp) items.push({ id: 'giveUp', label: 'Give up this game', value: null, off: null, confirm: 'Choose again to give up this game', subject });
  if (l.awayQuestion) {
    const who = l.awayQuestion.name;
    items.push({ id: 'awayWait', label: `Keep waiting for ${who}`, value: null, off: null, confirm: null });
    items.push({ id: 'awayEnd', label: `End ${possessive(who)} ball`, value: null, off: null, confirm: `Choose again to end ${possessive(who)} ball at ${l.awayQuestion.score.toLocaleString('en-US')}; the turn passes`, subject });
    items.push({ id: 'awayPlayOn', label: `Play on without ${who}`, value: null, off: null, confirm: `Choose again: ${who} is out of this game`, subject });
  } else if (l.waitedFor !== null) {
    items.push({ id: 'playOn', label: `Play on without ${l.waitedFor}`, value: null, off: null, confirm: `Choose again: ${l.waitedFor} is out of this game`, subject });
  }
  // Two lines with two ids: a question asked about the one is never answered as the other.
  if (l.end === 'match') items.push({ id: 'endMatch', label: 'End match', value: null, off: null, confirm: 'Choose again to end the match; everyone stays in the lobby', subject });
  if (l.end === 'everyone') items.push({ id: 'endMatchAll', label: 'End match for everyone', value: null, off: null, confirm: 'Choose again to end the match for everyone: the game being played gets no result', subject });
  items.push({
    id: 'leave',
    label: l.opener ? 'Close lobby' : 'Leave lobby',
    value: null,
    off: null,
    confirm: l.opener ? 'Choose again to close the lobby for everyone' : 'Choose again to leave the lobby',
  });
  items.push({ id: 'close', label: 'Close menu', value: null, off: null, confirm: null });
  return items;
}

export interface MenuState {
  open: boolean;
  /** The chosen line, by id: the lines change with the match (Start match goes at the start), the choice stays put. */
  at: MenuItemId | null;
  /** The line whose question is on screen: the next choose of the same line does it. */
  confirming: MenuItemId | null;
  /** One line under the menu: the question, a refusal, or what the last choose did. */
  note: string | null;
  /** The review of PR 131: for End my ball, the grant the question on screen was asked about (absent: none). */
  confirmFor?: number | null;
  /** The review of PR 136: what the question on screen was asked about (`MenuItem.subject`; absent: nothing that changes). */
  confirmSubject?: string | null;
}

export const MENU_CLOSED: MenuState = { open: false, at: null, confirming: null, note: null };

export type MenuKey = 'menu' | 'choose' | 'up' | 'down' | 'left' | 'right';

export type MenuEffect =
  /** `now` (A17 step 7): the second choose while a start waits: start without what it waits for. */
  | { kind: 'start'; anyway: boolean; now?: boolean; without?: string }
  /** A17 step 7: the lobby's choices. */
  | { kind: 'cancelStart' }
  /** `anyway`: the question named a table that cannot report ball ends, and the choose answered it. */
  | { kind: 'newMatch'; anyway: boolean }
  | { kind: 'stance'; to: 'play' | 'watch' }
  | { kind: 'giveUp' }
  /** `everyone`: the line was End match for everyone (a game is being played); false: End match, between games. */
  | { kind: 'endMatch'; everyone: boolean }
  | { kind: 'away'; answer: 'wait' | 'end_ball' | 'play_on' }
  | { kind: 'playOn' }
  | { kind: 'next' }
  /** `to`: the new value in percent, already inside the line's range. */
  | { kind: 'volume'; which: MenuVolume; to: number }
  | { kind: 'mic'; muted: boolean }
  /** D8.12.3: the layer captures the scoreboard's place again, where the head points now. */
  | { kind: 'placeScoreboard' }
  /** A17 step 4: this player's own ball ends now, by hand. */
  | { kind: 'endBall'; grantSeq?: number }
  | { kind: 'leave' };

/**
 * The index of the chosen line among `items`, for the picture of the menu (the first line when the chosen one is
 * gone). A press never goes by this alone: see `menuPress`.
 */
export function menuIndex(state: MenuState, items: readonly MenuItem[]): number {
  const i = items.findIndex((it) => it.id === state.at);
  return i < 0 ? 0 : i;
}

/** What a press says when the line the cursor was on is no longer there. */
export const MENU_CHANGED_NOTE = 'The menu changed: nothing was chosen';

/** Is the question on screen still the one this line asks now (the same line, the same words, about the same game)? */
function stillAsked(state: MenuState, item: MenuItem | undefined): boolean {
  if (item === undefined || state.confirming !== item.id || item.confirm === null) return false;
  // End my ball's question names the score as it stands, which may move between the two chooses while the question
  // stays the same one: it is held to its grant (`confirmFor`, the review of PR 131), not to its words.
  if (item.id === 'endBall') return (state.confirmSubject ?? null) === (item.subject ?? null);
  return state.note === item.confirm && (state.confirmSubject ?? null) === (item.subject ?? null);
}

/**
 * The review of PR 136: the lines changed while the menu was open (somebody's start, the end of a game, a question
 * withdrawn). A question on screen whose line is gone, or asks something else now, or is about another game, is
 * closed: it must not be answered by a choose made for it earlier. The cursor stays where it was, by line id; a
 * line that is gone is not replaced by another one here (`menuPress` deals with the press). Returns `state` itself
 * when nothing changed. End my ball's question keeps its own rule (`confirmFor`, the review of PR 131).
 */
export function menuSettle(state: MenuState, items: readonly MenuItem[]): MenuState {
  if (!state.open || state.confirming === null || state.confirming === 'endBall') return state;
  if (stillAsked(state, items.find((it) => it.id === state.confirming))) return state;
  return { open: true, at: state.at, confirming: null, note: null };
}

/** A volume one press away: `wrap` (the choose key, which only goes up) starts again at the lowest after the highest. */
export function steppedVolume(which: MenuVolume, from: number, dir: 1 | -1, wrap: boolean): number {
  const { min, max, step } = MENU_VOLUME[which];
  if (wrap && dir === 1 && from >= max) return min;
  return Math.min(max, Math.max(min, from + dir * step));
}

/** One key press. Never throws; a press that means nothing leaves the state as it was. */
export function menuPress(state: MenuState, items: readonly MenuItem[], facts: MenuFacts, key: MenuKey): { state: MenuState; effect: MenuEffect | null } {
  if (!state.open) {
    if (key !== 'menu') return { state, effect: null };
    return { state: { open: true, at: items[0]?.id ?? null, confirming: null, note: null }, effect: null };
  }
  if (items.length === 0) return { state: MENU_CLOSED, effect: null };
  // The review of PR 136: the line the cursor was on is gone (the lines changed under it). Whatever the key, the
  // press only puts the cursor on the first line and says so: a choose never lands on a line that was not chosen.
  if (!items.some((it) => it.id === state.at)) return { state: { open: true, at: items[0]!.id, confirming: null, note: MENU_CHANGED_NOTE }, effect: null };
  const i = menuIndex(state, items);
  const move = (by: number): { state: MenuState; effect: null } => ({
    state: { open: true, at: items[(i + by + items.length) % items.length]!.id, confirming: null, note: null },
    effect: null,
  });
  if (key === 'menu' || key === 'down') return move(1);
  if (key === 'up') return move(-1);
  const item = items[i]!;
  const here: MenuState = { open: true, at: item.id, confirming: null, note: null };
  if (isVolume(item.id)) {
    const from = facts[item.id];
    const to = steppedVolume(item.id, from, key === 'left' ? -1 : 1, key === 'choose');
    return { state: here, effect: to === from ? null : { kind: 'volume', which: item.id, to } };
  }
  if (key === 'left') return { state, effect: null };
  if (item.off !== null) return { state: { ...here, note: item.off }, effect: null };
  // The review of PR 131: End my ball's question is about one grant: asked again when the grant is another by now.
  const asked = item.id === 'endBall' ? (facts.endBall?.grantSeq ?? null) : null;
  // The review of PR 136: the second choose counts only for the question as it was asked: the same words, about the
  // same game. Anything else asks (again).
  if (item.confirm !== null && (!stillAsked(state, item) || (item.id === 'endBall' && (state.confirmFor ?? null) !== asked))) {
    return { state: { ...here, confirming: item.id, note: item.confirm, ...(item.id === 'endBall' ? { confirmFor: asked } : {}), ...(item.subject != null ? { confirmSubject: item.subject } : {}) }, effect: null };
  }
  switch (item.id) {
    case 'start':
      return { state: MENU_CLOSED, effect: { kind: 'start', anyway: item.confirm !== null } };
    case 'startNow':
      // The review of PR 138: the press says what it was about (the line's own words): the shell does nothing when
      // the start waits for something else by then.
      return { state: MENU_CLOSED, effect: { kind: 'start', anyway: false, now: true, without: item.label } };
    case 'cancelStart':
      return { state: MENU_CLOSED, effect: { kind: 'cancelStart' } };
    case 'newMatch':
      return { state: MENU_CLOSED, effect: { kind: 'newMatch', anyway: (facts.lobby?.newMatch?.warnings.length ?? 0) > 0 } };
    case 'stance':
      if (facts.lobby?.over) return { state: here, effect: null };
      // The menu stays open: the line shows the new choice.
      return { state: here, effect: { kind: 'stance', to: facts.lobby?.stance === 'play' ? 'watch' : 'play' } };
    case 'giveUp':
      return { state: MENU_CLOSED, effect: { kind: 'giveUp' } };
    case 'endMatch':
      return { state: MENU_CLOSED, effect: { kind: 'endMatch', everyone: false } };
    case 'endMatchAll':
      return { state: MENU_CLOSED, effect: { kind: 'endMatch', everyone: true } };
    case 'awayWait':
      return { state: MENU_CLOSED, effect: { kind: 'away', answer: 'wait' } };
    case 'awayEnd':
      return { state: MENU_CLOSED, effect: { kind: 'away', answer: 'end_ball' } };
    case 'awayPlayOn':
      return { state: MENU_CLOSED, effect: { kind: 'away', answer: 'play_on' } };
    case 'playOn':
      return { state: MENU_CLOSED, effect: { kind: 'playOn' } };
    case 'next':
      return { state: MENU_CLOSED, effect: { kind: 'next' } };
    case 'mic':
      return { state: here, effect: { kind: 'mic', muted: facts.mic === 'open' } };
    case 'scoreboard':
      // The menu closes: the panel goes, and the scoreboard is seen at its new place at once.
      return { state: MENU_CLOSED, effect: { kind: 'placeScoreboard' } };
    case 'endBall':
      return { state: MENU_CLOSED, effect: { kind: 'endBall', ...(asked !== null ? { grantSeq: asked } : {}) } };
    case 'leave':
      return { state: MENU_CLOSED, effect: { kind: 'leave' } };
    default:
      return { state: MENU_CLOSED, effect: null };
  }
}

/** A key held down repeats faster than this; such a press is the same press. */
export const MENU_REPEAT_MS = 90;
/** Two presses of the menu key closer than this are one "choose" (for a controller with one spare button). */
export const MENU_DOUBLE_MS = 350;

/**
 * How a press of the menu key reads, from the time since the last one (null: the first). `repeat`: the key is being
 * held, ignore it. `double`: the second press of a quick pair: undo the first press's move and choose that line.
 */
export function readMenuKey(gapMs: number | null): 'single' | 'double' | 'repeat' {
  if (gapMs === null || gapMs >= MENU_DOUBLE_MS) return 'single';
  return gapMs < MENU_REPEAT_MS ? 'repeat' : 'double';
}

export function menuView(state: MenuState, items: readonly MenuItem[], hint: string): PanelMenu | null {
  if (!state.open) return null;
  // A note that belongs to a line which is gone is not shown over another line.
  const here = items.some((it) => it.id === state.at);
  return {
    items: items.map((it) => ({ label: it.label, value: it.value, off: it.off !== null })),
    index: menuIndex(state, items),
    note: here || state.note === MENU_CHANGED_NOTE ? state.note : null,
    hint,
  };
}

/**
 * The keys a setting may name (Electron accelerators): optional modifiers, then one key. Enter, Esc, Space and Tab are
 * refused: VPX would act on them too (the plunger, its own menu, a nudge).
 */
const MODIFIERS = new Map([
  ['ctrl', 'Control'],
  ['control', 'Control'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
]);
const NAMED_KEYS = new Map(
  ['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace', 'numadd', 'numsub', 'nummult', 'numdiv', 'numdec'].map((k) => [k.toLowerCase(), k]),
);

/** Taken already: the volume keys (D2.10) and the arrows the open menu uses. */
export const RESERVED_SHORTCUTS: readonly string[] = ['Control+Alt+Up', 'Control+Alt+Down', 'Control+Alt+Left', 'Control+Alt+Right', 'Up', 'Down', 'Left', 'Right'];

/** A shortcut as typed ("ctrl+alt+m", "F9", "Num 5") in Electron's spelling, or null when it is not one this menu takes. */
export function cleanShortcut(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const parts = v
    .split('+')
    .map((p) => p.trim().replace(/\s+/g, '').toLowerCase())
    .filter((p) => p !== '');
  if (parts.length === 0 || parts.length > 4) return null;
  const mods: string[] = [];
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIERS.get(p);
    if (!m || mods.includes(m)) return null;
    mods.push(m);
  }
  const k = parts[parts.length - 1]!;
  let key: string | null;
  if (/^[a-z0-9]$/.test(k)) key = k.toUpperCase();
  else if (/^f([1-9]|1\d|2[0-4])$/.test(k)) key = k.toUpperCase();
  else if (/^num\d$/.test(k)) key = k;
  else key = NAMED_KEYS.get(k) ?? null;
  if (key === null) return null;
  // A bare letter or digit would be taken from every program while a match is on (and VPX plays on most of them).
  if (mods.length === 0 && /^[A-Z0-9]$/.test(key)) return null;
  const order = ['Control', 'Alt', 'Shift'].filter((m) => mods.includes(m));
  const acc = [...order, key].join('+');
  return RESERVED_SHORTCUTS.includes(acc) ? null : acc;
}

/** A shortcut in the words of a keyboard ("Ctrl+Alt+M"). */
export function shortcutWords(acc: string): string {
  return acc.replace(/\bControl\b/g, 'Ctrl');
}
