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
 */

import type { PanelMenu } from '../media/match-media-types.js';

export type MenuItemId = 'start' | 'next' | 'voice' | 'theirTable' | 'myTable' | 'mic' | 'scoreboard' | 'endBall' | 'leave' | 'close';
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
  endBall?: { ball: number; score: number } | null;
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
}

/** The menu's volume lines: the range (percent) and the step of one press. */
export const MENU_VOLUME: Record<MenuVolume, { min: number; max: number; step: number }> = {
  voice: { min: 0, max: 300, step: 25 },
  theirTable: { min: 0, max: 100, step: 10 },
  myTable: { min: 10, max: 100, step: 10 },
};

const isVolume = (id: MenuItemId): id is MenuVolume => id === 'voice' || id === 'theirTable' || id === 'myTable';

export function menuItems(f: MenuFacts): MenuItem[] {
  const items: MenuItem[] = [];
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
    items.push({ id: 'endBall', label: 'End my ball', value: null, off: null, confirm: `Choose again to end your ball at ${f.endBall.score.toLocaleString('en-US')}` });
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

export interface MenuState {
  open: boolean;
  /** The chosen line, by id: the lines change with the match (Start match goes at the start), the choice stays put. */
  at: MenuItemId | null;
  /** The line whose question is on screen: the next choose of the same line does it. */
  confirming: MenuItemId | null;
  /** One line under the menu: the question, a refusal, or what the last choose did. */
  note: string | null;
}

export const MENU_CLOSED: MenuState = { open: false, at: null, confirming: null, note: null };

export type MenuKey = 'menu' | 'choose' | 'up' | 'down' | 'left' | 'right';

export type MenuEffect =
  | { kind: 'start'; anyway: boolean }
  | { kind: 'next' }
  /** `to`: the new value in percent, already inside the line's range. */
  | { kind: 'volume'; which: MenuVolume; to: number }
  | { kind: 'mic'; muted: boolean }
  /** D8.12.3: the layer captures the scoreboard's place again, where the head points now. */
  | { kind: 'placeScoreboard' }
  /** A17 step 4: this player's own ball ends now, by hand. */
  | { kind: 'endBall' }
  | { kind: 'leave' };

/** The index of the chosen line among `items` (the first line when it is gone or none was chosen). */
export function menuIndex(state: MenuState, items: readonly MenuItem[]): number {
  const i = items.findIndex((it) => it.id === state.at);
  return i < 0 ? 0 : i;
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
  if (item.confirm !== null && state.confirming !== item.id) return { state: { ...here, confirming: item.id, note: item.confirm }, effect: null };
  switch (item.id) {
    case 'start':
      return { state: MENU_CLOSED, effect: { kind: 'start', anyway: item.confirm !== null } };
    case 'next':
      return { state: MENU_CLOSED, effect: { kind: 'next' } };
    case 'mic':
      return { state: here, effect: { kind: 'mic', muted: facts.mic === 'open' } };
    case 'scoreboard':
      // The menu closes: the panel goes, and the scoreboard is seen at its new place at once.
      return { state: MENU_CLOSED, effect: { kind: 'placeScoreboard' } };
    case 'endBall':
      return { state: MENU_CLOSED, effect: { kind: 'endBall' } };
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
  return {
    items: items.map((it) => ({ label: it.label, value: it.value, off: it.off !== null })),
    index: menuIndex(state, items),
    note: state.note,
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
