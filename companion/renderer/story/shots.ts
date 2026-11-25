/**
 * A17 step 9 (2026-11-27): the pictures shoot.mjs takes: every fixture of the Match tab, and the states a click
 * opens (a confirm row, the picker), each with the words that say what it is and from whose PC.
 */
import { FIXTURES } from './fixtures.js';

export interface Shot {
  name: string;
  /** The story page and its query, under /story/. */
  page: string;
  says: string;
  /** Also taken at the app's own window sizes (420 x 640 and 380 x 520). */
  window?: boolean;
  width?: number;
  height?: number;
}

const NAMES: Record<string, string> = { owner: 'Owner', krobs: 'Krobs', chuck: 'Chuck', dana: 'Dana' };
const WINDOW = new Set(['none', 'four-starter', 'game-up', 'between', 'host-away', 'table-changing', 'away-question']);

const tab: Shot[] = Object.entries(FIXTURES).map(([name, f]) => ({
  name: `tab-${name}`,
  page: `match.html?state=${name}`,
  says: `Match tab, ${NAMES[f.me]}'s PC: ${f.says}`,
  window: WINDOW.has(name),
}));

/** A state a press opens: the fixture, the buttons pressed in order, what is seen then. */
const pressed = (name: string, state: string, press: string[], says: string): Shot => ({
  name: `tab-${name}`,
  page: `match.html?state=${state}&press=${encodeURIComponent(press.join('|'))}`,
  says: `Match tab, ${NAMES[FIXTURES[state]?.me ?? 'owner']}'s PC: ${says}`,
});

/** Several states side by side (sheet.html), three to a picture: to compare the place of a thing between states. */
const sheet = (name: string, states: string[], h = 900): Shot => ({
  name: `sheet-${name}`,
  page: `sheet.html?page=match.html&states=${states.map(encodeURIComponent).join(',')}&h=${h}`,
  says: `Match tab, side by side: ${states.join(', ')}`,
  width: states.length * 426,
  height: h + 24,
});

export const SHEETS: Shot[] = [
  sheet('none', ['none', 'none-link', 'resume-quit']),
  sheet('resume', ['resume-crash-member', 'resume-damaged', 'resume-v1']),
  sheet('refused', ['refused-old-here', 'refused-old-there', 'refused-full']),
  sheet('lobby-1', ['unpaired-closed', 'alone', 'four-player']),
  sheet('lobby-2', ['four-watcher', 'four-owner-watches', 'full-direct']),
  sheet('start', ['start-countdown', 'start-waits-table', 'start-waits-3d']),
  sheet('start-2', ['start-held-grace', 'member-away-lobby', 'no-table']),
  sheet('trouble', ['cannot-save', 'relay-waiting', 'lobby-closed'], 1000),
  sheet('game', ['game-waiting', 'game-watcher', 'game-owner']),
  sheet('between', ['between', 'between-newmatch', 'match-ended'], 1100),
  sheet('away', ['waited-for', 'away-question', 'host-away'], 1000),
  sheet('away-2', ['host-kept-quit', 'given-up-me', 'given-up-others'], 1100),
  sheet('table', ['table-changing', 'table-close-it', 'table-open-it'], 1000),
  sheet('ask-1', ['four-player~Leave lobby', 'four-starter~Close lobby', 'game-waiting~Give up this game']),
  sheet('ask-2', ['game-up~End my ball', 'game-owner~End match for everyone', 'game-owner~Pass the turn']),
  sheet('ask-3', ['waited-for~Play on without Chuck', 'between-newmatch~Start a new match', 'four-player~Change table…'], 1100),
];

export const SHOTS: Shot[] = [
  ...tab,
  pressed('ask-leave', 'four-player', ['Leave lobby'], 'Leave lobby was pressed: the question'),
  pressed('ask-close', 'four-starter', ['Close lobby'], "Close lobby was pressed on the lobby's PC: the question"),
  pressed('ask-give-up', 'game-waiting', ['Give up this game'], 'Give up this game was pressed: the question'),
  pressed('ask-end-ball', 'game-up', ['End my ball'], 'End my ball was pressed: the question'),
  pressed('ask-end-everyone', 'game-owner', ['End match for everyone'], "End match for everyone was pressed on the lobby's PC: the question"),
  pressed('ask-pass', 'game-owner', ['Pass the turn'], "Pass the turn was pressed on the lobby's PC: the question"),
  pressed('ask-play-on', 'waited-for', ['Play on without Chuck'], 'Play on without Chuck was pressed: the question'),
  pressed('ask-new-match', 'between-newmatch', ['Start a new match'], 'Start a new match was pressed: the question'),
  pressed('picker', 'four-player', ['Change table…'], 'Change table was pressed: the picker'),
];
