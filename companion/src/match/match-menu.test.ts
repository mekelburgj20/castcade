import { describe, expect, it } from 'vitest';
import { DEFAULT_MATCH_SETTINGS, patchMatchSettings } from '../main/match-setup.js';
import { DEFAULT_VR_VIEW, vrViewMode } from './controller.js';
import { MENU_CHANGED_NOTE, MENU_CLOSED, cleanShortcut, endBallQuestion, menuItems, menuPress, menuSettle, menuView, readMenuKey, shortcutWords, steppedVolume, type MenuFacts, type MenuKey, type MenuLobby, type MenuState } from './match-menu.js';

const facts = (over: Partial<MenuFacts> = {}): MenuFacts => ({
  role: 'host',
  phase: 'lobby',
  players: 2,
  startWarnings: [],
  seriesOver: false,
  nextGameBlocker: null,
  voice: 150,
  theirTable: 100,
  myTable: 100,
  mic: 'open',
  scoreboardPlace: null,
  ...over,
});

/** Presses in a row against fixed facts; the effects that came out, and the state at the end. */
function run(f: MenuFacts, keys: MenuKey[], from: MenuState = MENU_CLOSED) {
  let state = from;
  const effects: unknown[] = [];
  for (const k of keys) {
    const r = menuPress(state, menuItems(f), f, k);
    state = r.state;
    if (r.effect) effects.push(r.effect);
  }
  return { state, effects };
}

describe('the in-game menu (D8.10, 2026-11-14)', () => {
  it('holds the lines the match calls for', () => {
    const ids = (f: MenuFacts) => menuItems(f).map((i) => i.id);
    expect(ids(facts())).toEqual(['start', 'voice', 'theirTable', 'myTable', 'mic', 'leave', 'close']);
    expect(ids(facts({ role: 'client' }))).toEqual(['voice', 'theirTable', 'myTable', 'mic', 'leave', 'close']);
    expect(ids(facts({ phase: 'playing' }))).toEqual(['voice', 'theirTable', 'myTable', 'mic', 'leave', 'close']);
    expect(ids(facts({ phase: 'over' }))).toEqual(['next', 'voice', 'theirTable', 'myTable', 'mic', 'leave', 'close']);
    expect(ids(facts({ phase: 'over', seriesOver: true }))).not.toContain('next');
    // The host's leave between games ends the match for everyone, and says so.
    expect(menuItems(facts({ phase: 'over' })).find((i) => i.id === 'leave')).toMatchObject({ label: 'End match', confirm: 'Choose again to end the match for everyone' });
    expect(menuItems(facts({ phase: 'playing' })).find((i) => i.id === 'leave')).toMatchObject({ label: 'Leave match' });
    expect(menuItems(facts()).find((i) => i.id === 'voice')?.value).toBe('150 %');
    expect(menuItems(facts({ mic: 'muted' })).find((i) => i.id === 'mic')?.value).toBe('MUTED');
  });

  it('opens on the menu key only, and the menu key walks down the lines and round again', () => {
    expect(run(facts(), ['choose', 'down', 'right']).state).toBe(MENU_CLOSED);
    expect(run(facts(), ['menu']).state).toEqual({ open: true, at: 'start', confirming: null, note: null });
    expect(run(facts(), ['menu', 'menu', 'menu']).state.at).toBe('theirTable');
    expect(run(facts(), ['menu', 'up']).state.at).toBe('close');
    expect(run(facts(), ['menu', 'menu', 'menu', 'menu', 'menu', 'menu', 'menu', 'menu']).state.at).toBe('start');
  });

  it('starts the match with one choose; a lobby that cannot start says why and stays open', () => {
    const ok = run(facts(), ['menu', 'choose']);
    expect(ok.effects).toEqual([{ kind: 'start', anyway: false }]);
    expect(ok.state).toBe(MENU_CLOSED);
    const alone = run(facts({ players: 1 }), ['menu', 'choose']);
    expect(alone.effects).toEqual([]);
    expect(alone.state).toMatchObject({ open: true, at: 'start', note: 'Nobody has joined yet' });
  });

  it('asks before a start with a warning and before leaving; moving away withdraws the question', () => {
    const warned = facts({ startWarnings: ["Krobs's table cannot report ball ends"] });
    const asked = run(warned, ['menu', 'choose']);
    expect(asked.effects).toEqual([]);
    expect(asked.state).toMatchObject({ confirming: 'start', note: "Krobs's table cannot report ball ends. Choose again to start anyway" });
    expect(run(warned, ['choose'], asked.state).effects).toEqual([{ kind: 'start', anyway: true }]);
    const f = facts({ role: 'client', phase: 'playing' });
    const leave: MenuKey[] = ['menu', 'menu', 'menu', 'menu', 'menu'];
    expect(run(f, leave).state.at).toBe('leave');
    expect(run(f, [...leave, 'choose']).effects).toEqual([]);
    expect(run(f, [...leave, 'choose', 'choose']).effects).toEqual([{ kind: 'leave' }]);
    // Away and back: the question is asked again.
    expect(run(f, [...leave, 'choose', 'down', 'up', 'choose']).effects).toEqual([]);
  });

  it('moves a volume: the arrows up and down inside the range, the choose key up and round to the lowest', () => {
    const f = facts({ role: 'client', phase: 'playing', voice: 275 });
    expect(run(f, ['menu', 'right']).effects).toEqual([{ kind: 'volume', which: 'voice', to: 300 }]);
    expect(run(f, ['menu', 'left']).effects).toEqual([{ kind: 'volume', which: 'voice', to: 250 }]);
    const top = facts({ role: 'client', phase: 'playing', voice: 300, myTable: 10 });
    expect(run(top, ['menu', 'right']).effects).toEqual([]);
    expect(run(top, ['menu', 'choose']).effects).toEqual([{ kind: 'volume', which: 'voice', to: 0 }]);
    expect(run(top, ['menu', 'menu', 'menu', 'left']).effects).toEqual([]);
    expect(run(top, ['menu', 'menu', 'menu', 'choose']).effects).toEqual([{ kind: 'volume', which: 'myTable', to: 20 }]);
    expect(steppedVolume('theirTable', 95, 1, false)).toBe(100);
    // A volume press keeps the menu open on its line.
    expect(run(f, ['menu', 'choose']).state).toMatchObject({ open: true, at: 'voice' });
  });

  it('mutes and unmutes the microphone, and refuses without one', () => {
    const f = facts({ role: 'client', phase: 'playing' });
    const mic: MenuKey[] = ['menu', 'menu', 'menu', 'menu'];
    expect(run(f, [...mic, 'choose']).effects).toEqual([{ kind: 'mic', muted: true }]);
    expect(run({ ...f, mic: 'muted' }, [...mic, 'choose']).effects).toEqual([{ kind: 'mic', muted: false }]);
    const none = run({ ...f, mic: 'unavailable' }, [...mic, 'choose']);
    expect(none.effects).toEqual([]);
    expect(none.state.note).toBe('No microphone on this PC');
  });

  it('D8.12.3: "Put the scoreboard where I look": there only while the scoreboard is held in the room, one choose places it and closes the menu', () => {
    const f = facts({ role: 'client', phase: 'playing', scoreboardPlace: 'ready' });
    // No such line without a scoreboard in the room (a desktop rig, the lobby, "follows my head"): the menu is the D8.10 one.
    expect(menuItems(facts({ role: 'client', phase: 'playing' })).map((i) => i.id)).toEqual(['voice', 'theirTable', 'myTable', 'mic', 'leave', 'close']);
    expect(menuItems(f).map((i) => i.id)).toEqual(['voice', 'theirTable', 'myTable', 'mic', 'scoreboard', 'leave', 'close']);
    expect(menuItems(f).find((i) => i.id === 'scoreboard')).toEqual({ id: 'scoreboard', label: 'Put the scoreboard where I look', value: null, off: null, confirm: null });
    const to: MenuKey[] = ['menu', 'menu', 'menu', 'menu', 'menu'];
    expect(run(f, to).state.at).toBe('scoreboard');
    const chosen = run(f, [...to, 'choose']);
    expect(chosen.effects).toEqual([{ kind: 'placeScoreboard' }]);
    expect(chosen.state).toBe(MENU_CLOSED); // the panel goes, so the scoreboard is seen at its new place at once
    expect(run(f, [...to, 'right']).effects).toEqual([{ kind: 'placeScoreboard' }]);
    expect(run(f, [...to, 'left']).effects).toEqual([]);
    // The layer VPX loaded cannot do it, or none is connected: the line says why, nothing is asked, the menu stays.
    const old = run({ ...f, scoreboardPlace: 'old_layer' }, [...to, 'choose']);
    expect(old.effects).toEqual([]);
    expect(old.state).toMatchObject({ open: true, at: 'scoreboard', note: 'Restart VPX first: until then the scoreboard follows your head' });
    const none = run({ ...f, scoreboardPlace: 'not_connected' }, [...to, 'choose']);
    expect(none.effects).toEqual([]);
    expect(none.state.note).toBe('The headset is not showing Castcade yet');
    expect(menuView(old.state, menuItems({ ...f, scoreboardPlace: 'old_layer' }), '')?.items[4]).toEqual({ label: 'Put the scoreboard where I look', value: null, off: true });
    // Leave match is one line further down, and still asks twice.
    expect(run(f, [...to, 'menu', 'choose', 'choose']).effects).toEqual([{ kind: 'leave' }]);
  });

  it('A17 step 4 (2026-11-24): the End my ball line: there for the player who is up, host or client, after the scoreboard line and before Leave match; it says the score and asks twice', () => {
    const f = facts({ role: 'client', phase: 'playing', endBall: { ball: 2, score: 12_345_670 } });
    expect(menuItems(f).map((i) => i.id)).toEqual(['voice', 'theirTable', 'myTable', 'mic', 'endBall', 'leave', 'close']);
    expect(menuItems({ ...f, role: 'host', scoreboardPlace: 'ready' }).map((i) => i.id)).toEqual(['voice', 'theirTable', 'myTable', 'mic', 'scoreboard', 'endBall', 'leave', 'close']);
    expect(menuItems(f).find((i) => i.id === 'endBall')).toEqual({ id: 'endBall', label: 'End my ball', value: null, off: null, confirm: 'Choose again to end your ball at 12,345,670' });
    // Not this player's ball, the match paused, or facts from before the line existed: no such line.
    expect(menuItems({ ...f, endBall: null }).map((i) => i.id)).not.toContain('endBall');
    expect(menuItems(facts({ role: 'client', phase: 'playing' })).map((i) => i.id)).not.toContain('endBall');
    const to: MenuKey[] = ['menu', 'menu', 'menu', 'menu', 'menu'];
    expect(run(f, to).state.at).toBe('endBall');
    // The first choose asks, with the score; nothing is done yet.
    const asked = run(f, [...to, 'choose']);
    expect(asked.effects).toEqual([]);
    expect(asked.state).toEqual({ open: true, at: 'endBall', confirming: 'endBall', note: 'Choose again to end your ball at 12,345,670', confirmFor: null });
    // The second does it and closes the menu; the arrow to the right chooses like the choose key; left does nothing.
    const done = run(f, [...to, 'choose', 'choose']);
    expect(done.effects).toEqual([{ kind: 'endBall' }]);
    expect(done.state).toBe(MENU_CLOSED);
    expect(run(f, [...to, 'right', 'right']).effects).toEqual([{ kind: 'endBall' }]);
    expect(run(f, [...to, 'choose', 'left']).effects).toEqual([]);
    // Moving away withdraws the question: coming back asks again.
    expect(run(f, [...to, 'choose', 'up', 'down', 'choose']).effects).toEqual([]);
    // A ball that has no score yet says so as a number.
    expect(menuItems({ ...f, endBall: { ball: 1, score: 0 } }).find((i) => i.id === 'endBall')?.confirm).toBe('Choose again to end your ball at 0');
    // Leave match is one line further down, and still asks twice.
    expect(run(f, [...to, 'menu', 'choose', 'choose']).effects).toEqual([{ kind: 'leave' }]);
  });

  it('A17 step 4 (the review of PR 131): the question of End my ball is about one grant: the answer carries it, a choose under another grant only asks again, and the question says when the ball stays on the table', () => {
    const to: MenuKey[] = ['menu', 'menu', 'menu', 'menu', 'menu'];
    const f = facts({ role: 'host', phase: 'playing', endBall: { grantSeq: 7, ball: 1, score: 1_000_000, tableBall: true } });
    const QUESTION = 'Choose again to end your ball at 1,000,000. The ball on your table is played out first at your next turn';
    expect(endBallQuestion({ score: 1_000_000, tableBall: true })).toBe(QUESTION);
    expect(endBallQuestion({ score: 1_000_000, tableBall: false })).toBe('Choose again to end your ball at 1,000,000');
    const asked = run(f, [...to, 'choose']);
    expect(asked.state).toEqual({ open: true, at: 'endBall', confirming: 'endBall', note: QUESTION, confirmFor: 7 });
    // The same grant: the second choose ends that ball, and says which.
    expect(run(f, ['choose'], asked.state).effects).toEqual([{ kind: 'endBall', grantSeq: 7 }]);
    // The table ended the ball with an extra ball meanwhile: ball 1 again under grant 8, at another score. The second
    // choose does not end it: it asks about this one.
    const regranted = { ...f, endBall: { grantSeq: 8, ball: 1, score: 1_050_000, tableBall: true } };
    const again = run(regranted, ['choose'], asked.state);
    expect(again.effects).toEqual([]);
    expect(again.state).toEqual({ open: true, at: 'endBall', confirming: 'endBall', note: 'Choose again to end your ball at 1,050,000. The ball on your table is played out first at your next turn', confirmFor: 8 });
    expect(run(regranted, ['right'], again.state).effects).toEqual([{ kind: 'endBall', grantSeq: 8 }]);
    // Leave match keeps no grant: its second choose leaves, whatever the turn did meanwhile.
    const leaving = run(f, [...to, 'menu', 'choose']);
    expect(leaving.state).toEqual({ open: true, at: 'leave', confirming: 'leave', note: 'Choose again to leave the match' });
    expect(run({ ...f, endBall: null }, ['choose'], leaving.state).effects).toEqual([{ kind: 'leave' }]);
  });

  it('keeps its place when a line goes (the match started while the menu was open)', () => {
    const open = run(facts(), ['menu', 'menu']).state; // on Voice volume
    const playing = facts({ phase: 'playing' });
    expect(menuView(open, menuItems(playing), 'keys')).toMatchObject({ index: 0, hint: 'keys' });
    expect(menuView(open, menuItems(playing), 'keys')?.items[0]).toEqual({ label: 'Voice volume', value: '150 %', off: false });
    // The chosen line is gone: the first line stands in.
    const onStart = run(facts(), ['menu']).state;
    expect(menuView(onStart, menuItems(playing), '')?.index).toBe(0);
    expect(menuView(MENU_CLOSED, menuItems(playing), '')).toBeNull();
  });

  it('reads the menu key by its distance from the last press', () => {
    expect(readMenuKey(null)).toBe('single');
    expect(readMenuKey(33)).toBe('repeat'); // a held key
    expect(readMenuKey(180)).toBe('double');
    expect(readMenuKey(349)).toBe('double');
    expect(readMenuKey(350)).toBe('single');
  });

  it('takes a shortcut as typed, and refuses the keys VPX or the menu itself needs', () => {
    expect(cleanShortcut('ctrl + alt + m')).toBe('Control+Alt+M');
    expect(cleanShortcut('Alt+Control+Shift+F9')).toBe('Control+Alt+Shift+F9');
    expect(cleanShortcut('F9')).toBe('F9');
    expect(cleanShortcut('Num 5')).toBe('num5');
    expect(cleanShortcut('numadd')).toBe('numadd');
    expect(cleanShortcut('Home')).toBe('Home');
    for (const bad of ['M', '7', 'Enter', 'Escape', 'Space', 'Tab', 'Control+Alt', 'Control+Control+M', 'F25', '', 'Up', 'Control+Alt+Up', 'Super+M', 'x'.repeat(41), 5, null]) {
      expect(cleanShortcut(bad)).toBeNull();
    }
    expect(shortcutWords('Control+Alt+M')).toBe('Ctrl+Alt+M');
  });

  it('saves the two keys, never the same key twice, and keeps the old one for a key it cannot take', () => {
    expect(DEFAULT_MATCH_SETTINGS).toMatchObject({ menuKey: 'Control+Alt+M', menuChooseKey: 'Control+Alt+K' });
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { menuKey: 'f9', menuChooseKey: 'F10' })).toMatchObject({ menuKey: 'F9', menuChooseKey: 'F10' });
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { menuKey: 'Enter' }).menuKey).toBe('Control+Alt+M');
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { menuChooseKey: null }).menuChooseKey).toBeNull();
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { menuChooseKey: 'Escape' }).menuChooseKey).toBe('Control+Alt+K');
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { menuKey: 'Control+Alt+K' })).toMatchObject({ menuKey: 'Control+Alt+K', menuChooseKey: null });
  });
});

describe('the headset view with the menu and a quiet lobby (D8.9 / D8.10)', () => {
  const at = (phase: 'idle' | 'playing' | 'paused' | 'over', myTurn: boolean, playerUp: string | null) => ({ phase, myTurn, playerUp });
  it('shows the panel while the menu is open, whatever the turn', () => {
    expect(vrViewMode(at('playing', true, 'me'), DEFAULT_VR_VIEW, { menuOpen: true })).toBe('panel');
    expect(vrViewMode(at('playing', false, 'krobs'), DEFAULT_VR_VIEW, { menuOpen: true })).toBe('panel');
    expect(vrViewMode(at('idle', false, null), DEFAULT_VR_VIEW, { menuOpen: true, lobbyQuiet: true })).toBe('panel');
  });
  it('shows nothing in a quiet lobby, and the panel in every other gap as before', () => {
    expect(vrViewMode(at('idle', false, null), DEFAULT_VR_VIEW, { lobbyQuiet: true })).toBe('hidden');
    expect(vrViewMode(at('idle', false, null), DEFAULT_VR_VIEW, { lobbyQuiet: false })).toBe('panel');
    expect(vrViewMode(at('over', false, null), DEFAULT_VR_VIEW, { lobbyQuiet: true })).toBe('panel');
    expect(vrViewMode(at('paused', false, 'krobs'), DEFAULT_VR_VIEW, { lobbyQuiet: true })).toBe('panel');
    expect(vrViewMode(at('playing', false, 'krobs'), DEFAULT_VR_VIEW, { lobbyQuiet: true })).toBe('theater');
  });
});

describe("the in-game menu in a lobby (A17 step 7, 2026-11-25, alpha-match.md section 11.9)", () => {
  const lobby = (over: Partial<MenuLobby> = {}): MenuLobby => ({
    opener: false,
    stance: 'play',
    start: { label: 'Start match', off: null },
    announced: null,
    newMatch: null,
    end: null,
    giveUp: false,
    waitedFor: null,
    awayQuestion: null,
    ...over,
  });
  const inLobby = (l: Partial<MenuLobby> = {}, f: Partial<MenuFacts> = {}): MenuFacts => facts({ role: 'client', lobby: lobby(l), ...f });
  const ids = (f: MenuFacts) => menuItems(f).map((i) => i.id);
  const line = (f: MenuFacts, id: string) => menuItems(f).find((i) => i.id === id);
  /** The presses that put the cursor on `id` in the menu of `f`, from closed. */
  const to = (f: MenuFacts, id: string): MenuKey[] => ['menu', ...Array.from({ length: ids(f).indexOf(id as never) }, () => 'down' as const)];
  /** One press against the facts as they are at that press: the lines may have changed since the last one. */
  const press = (state: MenuState, f: MenuFacts, key: MenuKey) => menuPress(state, menuItems(f), f, key);

  it('anybody starts: the start line is on every PC, with its words, and is not there while a game is played', () => {
    expect(ids(inLobby())).toEqual(['start', 'stance', 'voice', 'theirTable', 'myTable', 'mic', 'leave', 'close']);
    expect(line(inLobby(), 'start')).toMatchObject({ label: 'Start match', off: null, confirm: null });
    // A17 step 9: the next game of the open match is a line of its own (`nextGame`), with the same effect.
    const next = inLobby({ start: { label: 'Next game', off: null }, game: 'JHDFEF-1/1/between' }, { phase: 'over' });
    expect(line(next, 'nextGame')?.label).toBe('Next game');
    expect(line(next, 'start')).toBeUndefined();
    expect(run(next, ['menu', 'choose'])).toEqual({ state: MENU_CLOSED, effects: [{ kind: 'start', anyway: false }] });
    expect(ids(inLobby({}, { phase: 'playing' }))).toEqual(['stance', 'voice', 'theirTable', 'myTable', 'mic', 'leave', 'close']);
    expect(ids(inLobby({}, { phase: 'paused' }))).not.toContain('start');
    // One choose starts; a start that cannot be made says why and stays open.
    expect(run(inLobby(), ['menu', 'choose'])).toEqual({ state: MENU_CLOSED, effects: [{ kind: 'start', anyway: false }] });
    const off = run(inLobby({ start: { label: 'Start match', off: 'Waiting for a second player: only you are set to Play' } }), ['menu', 'choose']);
    expect(off.effects).toEqual([]);
    expect(off.state).toMatchObject({ open: true, note: 'Waiting for a second player: only you are set to Play' });
    // A table that differs is asked about first (the warnings are the lobby's as they were the match's).
    const warned = inLobby({}, { startWarnings: ['Krobs has another build of the table'] });
    expect(run(warned, ['menu', 'choose']).effects).toEqual([]);
    expect(run(warned, ['menu', 'choose', 'choose']).effects).toEqual([{ kind: 'start', anyway: true }]);
  });

  it('a start that is announced: Cancel the start for anybody; while it waits, a line of its own starts without what it waits for', () => {
    const counting = inLobby({ announced: { without: null } });
    expect(ids(counting).slice(0, 2)).toEqual(['cancelStart', 'stance']);
    expect(run(counting, ['menu', 'choose']).effects).toEqual([{ kind: 'cancelStart' }]);
    const waiting = inLobby({ announced: { without: 'Start without Dana' } });
    // The review of PR 136: not the line `start` with other words: its own id, so that a cursor left on Start match
    // never becomes a choose of this.
    expect(menuItems(waiting).slice(0, 2).map((i) => [i.id, i.label])).toEqual([
      ['startNow', 'Start without Dana'],
      ['cancelStart', 'Cancel the start'],
    ]);
    // The press says what it was about (the review of PR 138): the shell refuses it when the start waits for something else by then.
    expect(run(waiting, ['menu', 'choose']).effects).toEqual([{ kind: 'start', anyway: false, now: true, without: 'Start without Dana' }]);
    expect(run(waiting, ['menu', 'down', 'choose']).effects).toEqual([{ kind: 'cancelStart' }]);
    // With the lobby's PC away neither would reach it: both are off and say so.
    const away = inLobby({ announced: { without: 'Start without Dana' }, hostAway: true });
    expect(menuItems(away).slice(0, 2).map((i) => i.off)).toEqual(["The lobby's PC is away: this waits until it is back", "The lobby's PC is away: this waits until it is back"]);
    expect(run(away, ['menu', 'choose']).effects).toEqual([]);
  });

  it('Play or watch switches with one choose and keeps the menu open; Start a new match asks first, with what the new match\'s tables cannot do', () => {
    const sw = run(inLobby(), ['menu', 'down', 'choose']);
    expect(sw.effects).toEqual([{ kind: 'stance', to: 'watch' }]);
    expect(sw.state).toMatchObject({ open: true, at: 'stance' });
    expect(line(inLobby({ stance: 'watch' }), 'stance')?.value).toBe('WATCH');
    expect(run(inLobby({ stance: 'watch' }), ['menu', 'down', 'choose']).effects).toEqual([{ kind: 'stance', to: 'play' }]);

    const between = inLobby({ start: { label: 'Next game', off: null }, newMatch: { warnings: [] }, end: 'match', game: 'JHDFEF-1/1/between' }, { phase: 'over' });
    expect(ids(between)).toEqual(['nextGame', 'newMatch', 'stance', 'voice', 'theirTable', 'myTable', 'mic', 'endMatch', 'leave', 'close']);
    const asked = run(between, to(between, 'newMatch').concat('choose'));
    expect(asked.effects).toEqual([]);
    expect(asked.state).toMatchObject({ confirming: 'newMatch', note: 'Choose again: the open match ends' });
    expect(run(between, to(between, 'newMatch').concat('choose', 'choose')).effects).toEqual([{ kind: 'newMatch', anyway: false }]);
    // The review of PR 136: a player of the NEW match whose table cannot report ball ends (the next game's players
    // may all be fine): the question says so, and the choose that answers it starts anyway.
    const dana = "Dana's table cannot report ball ends: it is not patched, an original table, or a machine whose ball ends cannot be read";
    const unreadable = inLobby({ start: { label: 'Next game', off: null }, newMatch: { warnings: [dana] }, end: 'match', game: 'JHDFEF-1/1/between' }, { phase: 'over' });
    expect(line(unreadable, 'newMatch')?.confirm).toBe(`${dana}. Choose again to start anyway: the open match ends`);
    expect(line(unreadable, 'nextGame')?.confirm).toBeNull();
    expect(run(unreadable, to(unreadable, 'newMatch').concat('choose', 'choose')).effects).toEqual([{ kind: 'newMatch', anyway: true }]);
  });

  it('the review of PR 136: End match and End match for everyone are two lines with two ids and two effects; a question asked about the one is never answered as the other', () => {
    const between = inLobby({ opener: true, start: { label: 'Next game', off: null }, end: 'match', game: 'JHDFEF-1/1/between' }, { role: 'host', phase: 'over' });
    const during = inLobby({ opener: true, end: 'everyone', game: 'JHDFEF-1/2/game' }, { role: 'host', phase: 'playing' });
    expect(line(between, 'endMatch')).toMatchObject({ label: 'End match', confirm: 'Choose again to end the match; everyone stays in the lobby' });
    expect(line(between, 'endMatchAll')).toBeUndefined();
    expect(line(during, 'endMatchAll')).toMatchObject({ label: 'End match for everyone', confirm: 'Choose again to end the match for everyone: the game being played gets no result' });
    expect(line(during, 'endMatch')).toBeUndefined();
    expect(run(between, to(between, 'endMatch').concat('choose', 'choose')).effects).toEqual([{ kind: 'endMatch', everyone: false }]);
    expect(run(during, to(during, 'endMatchAll').concat('choose', 'choose')).effects).toEqual([{ kind: 'endMatch', everyone: true }]);
    // Never without its question, however the cursor got there.
    expect(run(during, to(during, 'endMatchAll').concat('choose')).effects).toEqual([]);
    // A member never has the line during a game.
    expect(ids(inLobby({}, { phase: 'playing' })).filter((i) => i.startsWith('endMatch'))).toEqual([]);

    // The sequence of the review: between games, End match is chosen once ("Choose again to end the match; everyone
    // stays in the lobby"); somebody's start counts down and the game begins; the second choose comes then.
    const asked = run(between, to(between, 'endMatch').concat('choose')).state;
    expect(asked).toMatchObject({ confirming: 'endMatch', at: 'endMatch' });
    const second = press(asked, during, 'choose');
    expect(second.effect).toBeNull();
    expect(second.state).toMatchObject({ open: true, confirming: null, note: MENU_CHANGED_NOTE });
    // And a third choose, on the line the cursor was put on, ends nothing either: it is not that line.
    expect(press(second.state, during, 'choose').effect?.kind).not.toBe('endMatch');
  });

  it('the review of PR 136: the lines change under the cursor: a choose never lands on another line, and a question whose subject is gone is closed', () => {
    // B has the cursor on Start match; the starter's start is announced, so the first line is Cancel the start now.
    const open = run(inLobby(), ['menu']).state;
    expect(open.at).toBe('start');
    const counting = inLobby({ announced: { without: null } });
    const a = press(open, counting, 'choose');
    expect(a.effect).toBeNull();
    expect(a.state).toEqual({ open: true, at: 'cancelStart', confirming: null, note: MENU_CHANGED_NOTE });
    // The same press with the right arrow, or the left: nothing either.
    expect(press(open, counting, 'right').effect).toBeNull();
    expect(press(open, counting, 'left').effect).toBeNull();
    // The picture of the menu meanwhile: the note of the line that is gone is not shown over another line.
    const noted: MenuState = { open: true, at: 'start', confirming: 'start', note: 'Krobs has another build of the table. Choose again to start anyway' };
    expect(menuView(noted, menuItems(counting), 'hint')).toMatchObject({ index: 0, note: null });
    // Only after the cursor has been put on a line that is there does a choose count, for that line.
    expect(press(a.state, counting, 'choose').effect).toEqual({ kind: 'cancelStart' });

    // "Choose again to give up this game" is open and the game ends: the choose does not press Next game.
    const playing = inLobby({ giveUp: true, game: 'JHDFEF-1/1/game' }, { phase: 'playing' });
    const givingUp = run(playing, to(playing, 'giveUp').concat('choose')).state;
    expect(givingUp).toMatchObject({ confirming: 'giveUp', confirmSubject: 'JHDFEF-1/1/game' });
    const between = inLobby({ start: { label: 'Next game', off: null }, end: 'match', game: 'JHDFEF-1/1/between' }, { phase: 'over' });
    expect(press(givingUp, between, 'choose')).toMatchObject({ effect: null, state: { confirming: null, note: MENU_CHANGED_NOTE } });
    // The next game begins before any press: the line is back, but the question was about the game before: asked again.
    const next = inLobby({ giveUp: true, game: 'JHDFEF-1/2/game' }, { phase: 'playing' });
    const again = press(givingUp, next, 'choose');
    expect(again.effect).toBeNull();
    expect(again.state).toMatchObject({ confirming: 'giveUp', confirmSubject: 'JHDFEF-1/2/game', note: 'Choose again to give up this game' });
    expect(press(again.state, next, 'choose').effect).toEqual({ kind: 'giveUp' });

    // An away answer's question is open and the question is withdrawn: the choose does not flip Play / Watch.
    const asked = inLobby({ opener: true, waitedFor: 'Krobs', awayQuestion: { name: 'Krobs', score: 500 }, end: 'everyone', game: 'JHDFEF-1/1/game' }, { role: 'host', phase: 'paused' });
    const ending = run(asked, to(asked, 'awayEnd').concat('choose')).state;
    const back = inLobby({ opener: true, end: 'everyone', game: 'JHDFEF-1/1/game' }, { role: 'host', phase: 'playing' });
    expect(press(ending, back, 'choose')).toMatchObject({ effect: null, state: { confirming: null } });
    // The same question about another player by now: asked again, with that player's name and score.
    const other = inLobby({ opener: true, waitedFor: 'Chuck', awayQuestion: { name: 'Chuck', score: 900 }, end: 'everyone', game: 'JHDFEF-1/1/game' }, { role: 'host', phase: 'paused' });
    const re = press(ending, other, 'choose');
    expect(re.effect).toBeNull();
    expect(re.state.note).toBe("Choose again to end Chuck's ball at 900; the turn passes");

    // A new-match question is open and someone starts: the choose does not cancel their start.
    const nm = inLobby({ start: { label: 'Next game', off: null }, newMatch: { warnings: [] }, end: 'match', game: 'JHDFEF-1/1/between' }, { phase: 'over' });
    const asking = run(nm, to(nm, 'newMatch').concat('choose')).state;
    const started = inLobby({ announced: { without: null }, game: 'JHDFEF-1/1/between' }, { phase: 'over' });
    expect(press(asking, started, 'choose')).toMatchObject({ effect: null, state: { at: 'cancelStart', confirming: null, note: MENU_CHANGED_NOTE } });
  });

  it('the review of PR 136: `menuSettle` closes a question when its line is gone, asks something else, or is about another game; and leaves everything else as it is', () => {
    const playing = inLobby({ giveUp: true, game: 'JHDFEF-1/1/game' }, { phase: 'playing' });
    const asked = run(playing, to(playing, 'giveUp').concat('choose')).state;
    // Nothing changed: the very same state.
    expect(menuSettle(asked, menuItems(playing))).toBe(asked);
    expect(menuSettle(MENU_CLOSED, menuItems(playing))).toBe(MENU_CLOSED);
    const idle = run(playing, ['menu']).state;
    expect(menuSettle(idle, menuItems(inLobby({}, { phase: 'over' })))).toBe(idle);
    // The line is gone; the same line in the next game; the cursor stays where it was, by id.
    const between = inLobby({ start: { label: 'Next game', off: null }, game: 'JHDFEF-1/1/between' }, { phase: 'over' });
    expect(menuSettle(asked, menuItems(between))).toEqual({ open: true, at: 'giveUp', confirming: null, note: null });
    const next = inLobby({ giveUp: true, game: 'JHDFEF-1/2/game' }, { phase: 'playing' });
    expect(menuSettle(asked, menuItems(next))).toEqual({ open: true, at: 'giveUp', confirming: null, note: null });
    // End my ball keeps its own rule (the grant it was asked about).
    const ball: MenuState = { open: true, at: 'endBall', confirming: 'endBall', note: 'x', confirmFor: 3 };
    expect(menuSettle(ball, menuItems(between))).toBe(ball);
    // And its second choose counts though the score in its words has moved meanwhile: the same grant, the same question.
    const up = (score: number): MenuFacts => inLobby({ giveUp: true, game: 'JHDFEF-1/1/game' }, { phase: 'playing', endBall: { ball: 1, score, grantSeq: 3 } });
    const first = run(up(1000), to(up(1000), 'endBall').concat('choose')).state;
    expect(first).toMatchObject({ confirming: 'endBall', confirmFor: 3 });
    expect(press(first, up(1500), 'choose').effect).toEqual({ kind: 'endBall', grantSeq: 3 });
    // The same grant number in another match (a match numbers its grants from 1 again) is another ball: asked again.
    const other = inLobby({ giveUp: true, game: 'JHDFEF-2/1/game' }, { phase: 'playing', endBall: { ball: 1, score: 0, grantSeq: 3 } });
    const re = press(first, other, 'choose');
    expect(re.effect).toBeNull();
    expect(re.state).toMatchObject({ confirming: 'endBall', confirmFor: 3, confirmSubject: 'JHDFEF-2/1/game' });
  });

  it("leaving: a member's line is Leave lobby, the opener's is Close lobby, and each says what it does before it does it", () => {
    expect(line(inLobby(), 'leave')).toMatchObject({ label: 'Leave lobby', confirm: 'Choose again to leave the lobby' });
    // A17 step 9: three lines, three ids: a member goes, a member goes and gives up their game by it, the lobby's PC closes the lobby.
    expect(line(inLobby({ opener: true }, { role: 'host' }), 'closeLobby')).toMatchObject({ label: 'Close lobby', confirm: 'Choose again to close the lobby for everyone' });
    expect(line(inLobby({ opener: true }, { role: 'host' }), 'leave')).toBeUndefined();
    const f = inLobby({ opener: true }, { role: 'host' });
    expect(run(f, to(f, 'closeLobby').concat('choose')).effects).toEqual([]);
    expect(run(f, to(f, 'closeLobby').concat('choose', 'choose')).effects).toEqual([{ kind: 'leave' }]);
  });

  it('A17 step 9: a question asked about one line is never answered as the line that took its place', () => {
    // Leave lobby is asked between games; a game begins and this member is one of its players: the same key now
    // gives the game up, so it asks again, in its own words, and only the second choose after that leaves.
    const before = inLobby({ game: 'JHDFEF-1/1/between' }, { phase: 'over' });
    const asked = run(before, to(before, 'leave').concat('choose'));
    expect(asked.state).toMatchObject({ confirming: 'leave', note: 'Choose again to leave the lobby' });
    const during = inLobby({ game: 'JHDFEF-1/2/game', giveUp: true }, { phase: 'playing' });
    expect(line(during, 'leaveGame')).toMatchObject({ label: 'Leave lobby', confirm: 'Choose again to leave the lobby: you give up the game you are playing' });
    expect(line(during, 'leave')).toBeUndefined();
    const settled = menuSettle(asked.state, menuItems(during));
    expect(settled.confirming).toBeNull();
    const again = run(during, to(during, 'leaveGame').concat('choose'));
    expect(again.effects).toEqual([]);
    expect(again.state).toMatchObject({ confirming: 'leaveGame', confirmSubject: 'JHDFEF-1/2/game' });
    expect(run(during, ['choose'], again.state).effects).toEqual([{ kind: 'leave' }]);
    // Start match with a warning is asked; the match is started by somebody else and its first game ends: the first
    // line is Next game now, and the question about Start match does not start it.
    const warned = inLobby({}, { startWarnings: ["Krobs's table cannot report ball ends"] });
    const q = run(warned, ['menu', 'choose']);
    expect(q.state.confirming).toBe('start');
    const next = inLobby({ start: { label: 'Next game', off: null }, game: 'JHDFEF-1/1/between' }, { phase: 'over', startWarnings: ["Krobs's table cannot report ball ends"] });
    expect(menuSettle(q.state, menuItems(next)).confirming).toBeNull();
    expect(run(next, ['choose'], menuSettle(q.state, menuItems(next))).effects).toEqual([]);
  });

  it("the lobby's PC and a player who is away: Play on without them at their own turn; the three answers when they are up and still seen playing; Give up this game for a player of the game", () => {
    const waited = inLobby({ opener: true, waitedFor: 'Chuck', end: 'everyone' }, { role: 'host', phase: 'paused' });
    expect(line(waited, 'playOn')).toMatchObject({ label: 'Play on without Chuck', confirm: 'Choose again: Chuck is out of this game' });
    const asked = inLobby({ opener: true, waitedFor: 'Krobs', awayQuestion: { name: 'Krobs', score: 1_234_500 }, end: 'everyone' }, { role: 'host', phase: 'paused' });
    expect(ids(asked)).not.toContain('playOn');
    // Design 11.8: "End Krobs' ball" (a name that ends in s takes the apostrophe alone).
    expect(menuItems(asked).filter((i) => i.id.startsWith('away')).map((i) => [i.label, i.confirm])).toEqual([
      ['Keep waiting for Krobs', null],
      ["End Krobs' ball", "Choose again to end Krobs' ball at 1,234,500; the turn passes"],
      ['Play on without Krobs', 'Choose again: Krobs is out of this game'],
    ]);
    expect(line(inLobby({ opener: true, waitedFor: 'Dana', awayQuestion: { name: 'Dana', score: 5 } }, { role: 'host', phase: 'paused' }), 'awayEnd')?.label).toBe("End Dana's ball");
    expect(run(asked, to(asked, 'awayWait').concat('choose')).effects).toEqual([{ kind: 'away', answer: 'wait' }]);
    expect(run(asked, to(asked, 'awayEnd').concat('choose')).effects).toEqual([]);
    expect(run(asked, to(asked, 'awayEnd').concat('choose', 'choose')).effects).toEqual([{ kind: 'away', answer: 'end_ball' }]);
    expect(run(asked, to(asked, 'awayPlayOn').concat('choose', 'choose')).effects).toEqual([{ kind: 'away', answer: 'play_on' }]);
    // A member never has these lines: the question is the lobby PC's.
    expect(ids(inLobby({}, { phase: 'paused' })).filter((i) => i.startsWith('away') || i === 'playOn')).toEqual([]);

    const playing = inLobby({ giveUp: true }, { phase: 'playing' });
    expect(line(playing, 'giveUp')).toMatchObject({ label: 'Give up this game', confirm: 'Choose again to give up this game' });
    expect(ids(inLobby({ stance: 'watch' }, { phase: 'playing' }))).not.toContain('giveUp');
  });

  it('a lobby that is over on this PC (it lingers a moment before it closes): the volumes, the microphone and Close menu are what is left; nothing that would be sent, saved or started', () => {
    const over = inLobby({ over: true, giveUp: true, end: 'match', newMatch: { warnings: [] } }, { phase: 'over' });
    expect(ids(over)).toEqual(['voice', 'theirTable', 'myTable', 'mic', 'close']);
  });

  it('without a lobby the menu is the one of a match, line for line (the option-off path)', () => {
    expect(menuItems(facts({ lobby: null }))).toEqual(menuItems(facts()));
    expect(menuItems(facts({ lobby: null })).map((i) => i.id)).toEqual(['start', 'voice', 'theirTable', 'myTable', 'mic', 'leave', 'close']);
    // The review of PR 136 holds here too: the match starts while the cursor is on Start match: the choose is nothing.
    const open = run(facts(), ['menu']).state;
    const started = facts({ phase: 'playing' });
    expect(menuPress(open, menuItems(started), started, 'choose')).toMatchObject({ effect: null, state: { at: 'voice', note: MENU_CHANGED_NOTE } });
  });
});
