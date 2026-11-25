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

const who = (state: string): string => NAMES[FIXTURES[state]?.me ?? 'owner'] ?? 'Owner';
const says = (state: string): string => FIXTURES[state]?.says ?? state;

/** The panel page as the headset draws it (960 x 640), as the desktop panel window (480 x 720), and with the menu open. */
const PANEL_VR = ['alone', 'four-starter', 'four-player', 'four-watcher', 'start-countdown', 'start-waits-table', 'start-held-grace', 'member-away-lobby', 'table-changing', 'game-up', 'game-waiting', 'game-watcher', 'waited-for', 'host-away', 'between', 'match-ended', 'given-up-me', 'host-kept-quit', 'lobby-closed'];
const PANEL_DESKTOP = ['four-starter', 'start-waits-3d', 'table-changing', 'game-watcher', 'host-away', 'between'];
const PANEL_MENU = ['four-starter', 'game-up', 'between-newmatch', 'away-question'];
const BOARD = ['game-up', 'game-watcher', 'waited-for', 'away-question', 'host-away', 'between'];
const panel: Shot[] = [
  ...PANEL_VR.map((s) => ({ name: `panel-headset-${s}`, page: `panel.html?state=${s}&vr=1`, says: `Panel in the headset, ${who(s)}'s PC: ${says(s)}`, width: 960, height: 640 })),
  ...PANEL_DESKTOP.map((s) => ({ name: `panel-desktop-${s}`, page: `panel.html?state=${s}&vr=0`, says: `Panel window on the desktop, ${who(s)}'s PC: ${says(s)}`, width: 480, height: 720 })),
  ...PANEL_MENU.map((s) => ({ name: `panel-menu-${s}`, page: `panel.html?state=${s}&vr=1&menu=1`, says: `Panel in the headset with the in-game menu open, ${who(s)}'s PC: ${says(s)}`, width: 960, height: 640 })),
  { name: 'panel-menu-game-owner-last-line', page: 'panel.html?state=game-owner&vr=1&menu=1&at=closeLobby&asked=1', says: "Panel in the headset with the in-game menu open on its last lines, Close lobby chosen and its question asked, Owner's PC", width: 960, height: 640 },
  { name: 'panel-menu-desktop-away-question', page: 'panel.html?state=away-question&vr=0&menu=1&at=awayEnd&asked=1', says: "Panel window on the desktop with the in-game menu open, End Krobs' ball chosen and its question asked, Owner's PC", width: 480, height: 720 },
  ...BOARD.map((s) => ({ name: `scoreboard-${s}`, page: `scoreboard.html?state=${s}`, says: `Scoreboard card in the headset (the grey stands for the game behind it), ${who(s)}'s PC: ${says(s)}`, width: 512, height: 384 })),
];

/** The in-game menu as text, three states to a picture: every line, its id, what it asks first, why it is off. */
const MENUS = [
  ['lobby', ['four-starter', 'four-player', 'four-watcher']],
  ['start', ['alone', 'start-countdown', 'start-waits-table']],
  ['game', ['game-up', 'game-waiting', 'game-owner']],
  ['between', ['between', 'between-newmatch', 'game-watcher']],
  ['away', ['waited-for', 'away-question', 'host-away']],
  ['more', ['given-up-me', 'host-kept-quit', 'table-changing']],
] as const;
const menus: Shot[] = MENUS.map(([name, states]) => ({ name: `menu-text-${name}`, page: `menu.html?states=${states.join(',')}`, says: `In-game menu as text (each line, its id, what it asks first, why it is off): ${states.join(', ')}`, width: 12 + states.length * 412, height: 400 }));

/** The panel pictures, six to a sheet at half size (three across). */
const panelSheet = (name: string, states: string[], vr = true): Shot => ({
  name: `sheet-panel-${name}`,
  page: `sheet.html?page=panel.html&states=${states.join(',')}&w=${vr ? 960 : 480}&h=${vr ? 640 : 720}&zoom=${vr ? 0.5 : 0.75}&more=${encodeURIComponent(vr ? 'vr=1' : 'vr=0')}`,
  says: `Panel, side by side: ${states.join(', ')}`,
  width: vr ? 3 * 486 : 4 * 366,
  height: 400,
});
SHEETS.push(
  panelSheet('lobby', PANEL_VR.slice(0, 6)),
  panelSheet('start', PANEL_VR.slice(6, 12)),
  panelSheet('game', PANEL_VR.slice(12, 19)),
  panelSheet('desktop', PANEL_DESKTOP.slice(0, 4), false),
);

export const SHOTS: Shot[] = [
  ...tab,
  ...panel,
  ...menus,
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
