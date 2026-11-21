import { describe, expect, it } from 'vitest';
import { DEFAULT_MATCH_SETTINGS, patchMatchSettings } from '../main/match-setup.js';
import { DEFAULT_VR_VIEW, vrViewMode } from './controller.js';
import { MENU_CLOSED, cleanShortcut, menuItems, menuPress, menuView, readMenuKey, shortcutWords, steppedVolume, type MenuFacts, type MenuKey, type MenuState } from './match-menu.js';

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
