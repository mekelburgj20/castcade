/**
 * A17 step 6 (2026-11-25, alpha-match.md §11.4, §11.5): a start is asked for, by anyone, with the lobby option on.
 * One test per row of the design's table of checks, at the request and again when the countdown runs out; the
 * starter and the one table that may ask; two starts at nearly the same moment; the second press that starts
 * without what is waited for; the cancel; Play / Watch during a start; next game against new match; End match by a
 * member and for everyone; the table as a pick. Names are the ids in capitals (`lobby.test-support.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { PayloadOf } from '@castcade/protocol';
import type { ClientMatch } from './client.js';
import { countDown, flush, NO_TABLE, OTHER_GAME, playGame, SAME_GAME, starLobby, TABLE, type StarRig } from './lobby.test-support.js';
import { pickOf } from './table-identity.js';

const start = (r: StarRig, id = 'a'): PayloadOf<'HELLO_ACK'>['start'] => r.lobby(id).start;
const client = (r: StarRig, id: string): ClientMatch => r.clients[id] as ClientMatch;
const types = (r: StarRig, type: string): number => r.frames.filter((f) => f.by === 'h' && (JSON.parse(f.frame) as { type: string }).type === type).length;

describe('A17 step 6: a start, asked for by anyone', () => {
  it('a client starts a match from a button: everyone sees the countdown with their name, and they go first', async () => {
    const r = await starLobby(['a', 'b'], { stances: { b: 'watch' } });
    expect(r.lobby('a').starter).toBe('h');
    expect(client(r, 'a').requestStart()).toBe(true);
    await flush();
    for (const id of ['a', 'b']) {
      expect(start(r, id)).toEqual({ by: 'a', players: ['a', 'h'], newMatch: true, waitsFor: null, waitsOn: [], leftMs: 5000 });
      expect(r.lobby(id).startsInMs).toBe(5000);
    }
    expect(r.host.announcedStart()?.by).toBe('a');
    expect(r.host.state.phase).toBe('lobby');
    await r.tick(4999);
    expect(r.host.state.phase).toBe('lobby');
    await r.tick(1);
    expect(r.host.state.matchId).toBe('JHDFEF-1');
    expect(r.host.state.playerOrder).toEqual(['a', 'h']);
    expect(client(r, 'a').myGrant).toMatchObject({ player: 'a', ballNumber: 1, grantSeq: 1 });
    expect(start(r, 'b')).toBeNull();
    // Whoever started from a button went first, and so is the starter after the game.
    expect(r.lobby('b').starter).toBe('a');
    expect(r.said['a']).toEqual([]);
    expect(types(r, 'MATCH_READY')).toBe(2);
  });

  it('the starter starts from their own table; anybody else`s game on a table is never a request', async () => {
    const r = await starLobby(['a', 'b']);
    // Not the starter: told who is, and nothing is announced.
    client(r, 'a').requestStart({ fromTable: true });
    await flush();
    expect(r.said['a']).toEqual(['Only H starts a match from the table. To start it yourself, use Start in the menu.']);
    expect(start(r, 'b')).toBeNull();
    // The starter: their game has begun, so they go first.
    expect(r.host.requestStart({ fromTable: true })).toBeNull();
    await flush();
    expect(start(r, 'b')).toMatchObject({ by: 'h', players: ['h', 'a', 'b'], newMatch: true, waitsFor: null });
    await countDown(r);
    expect(r.host.state.playerOrder).toEqual(['h', 'a', 'b']);
    expect(r.host.state.currentGrant?.grant.player).toBe('h');
    // A game started on a table is the next game, never a new match.
    expect(r.host.requestStart({ fromTable: true, newMatch: true })).toMatch(/never a new match/);
  });

  it('two Starts in the same countdown: one game, the starter first', async () => {
    const r = await starLobby(['a', 'b']);
    // A presses Start in the menu; a moment later the starter's own game_start arrives (the lock had not reached H).
    client(r, 'a').requestStart();
    await r.tick(1500);
    expect(start(r, 'b')).toMatchObject({ by: 'a', players: ['a', 'h', 'b'], leftMs: 5000 });
    expect(r.host.requestStart({ fromTable: true })).toBeNull();
    await flush();
    expect(start(r, 'b')).toMatchObject({ by: 'a', players: ['h', 'a', 'b'], waitsFor: null, leftMs: 3500 });
    // A third press changes nothing, and neither does a second game_start.
    client(r, 'b').requestStart();
    r.host.requestStart({ fromTable: true });
    await r.tick(3499);
    expect(r.host.state.phase).toBe('lobby');
    await r.tick(1);
    expect(r.host.state.playerOrder).toEqual(['h', 'a', 'b']);
    expect(types(r, 'MATCH_READY')).toBe(2);
    expect(r.host.state.matchId).toBe('JHDFEF-1');
    // The other way round: the starter's table first, then a button: the same one game, the starter still first.
    const q = await starLobby(['a']);
    q.host.requestStart({ fromTable: true });
    client(q, 'a').requestStart();
    await flush();
    expect(start(q)).toMatchObject({ by: 'h', players: ['h', 'a'] });
    await countDown(q);
    expect(q.host.state.playerOrder).toEqual(['h', 'a']);
    expect(types(q, 'MATCH_READY')).toBe(1);
  });

  it('anybody cancels a start; every panel is told who', async () => {
    const r = await starLobby(['a', 'b', 'c'], { stances: { c: 'watch' } });
    const off: string[] = [];
    r.host.on('startOff', (x) => off.push(x.reason));
    expect(r.host.cancelStart()).toBe('No start is under way.');
    client(r, 'a').requestStart();
    await r.tick(2000);
    client(r, 'c').cancelStart();
    await flush();
    expect(start(r, 'b')).toBeNull();
    expect(r.lobby('b').startOff).toBe('C cancelled the start.');
    expect(off).toEqual(['C cancelled the start.']);
    await r.tick(10_000);
    expect(r.host.state.phase).toBe('lobby');
    // The sentence is said once: the next HELLO_ACK has none.
    client(r, 'b').setStance('watch');
    await flush();
    expect(r.lobby('a').startOff).toBeUndefined();
    client(r, 'c').cancelStart();
    await flush();
    expect(r.said['c']).toEqual(['No start is under way.']);
  });
});

describe('A17 step 6: the checks of a start (design 11.4), at the request', () => {
  it('no game is being played', async () => {
    const r = await starLobby(['a']);
    r.host.start();
    await flush();
    expect(r.host.requestStart()).toBe('A game is being played.');
    client(r, 'a').requestStart({ newMatch: true });
    await flush();
    expect(r.said['a']).toEqual(['A game is being played.']);
  });

  it('no start is under way: a second press changes nothing, and the asker sees the start that is announced', async () => {
    const r = await starLobby(['a', 'b']);
    client(r, 'a').requestStart();
    await r.tick(3000);
    client(r, 'b').requestStart({ newMatch: true, anyway: true });
    await flush();
    // Nothing is said again: the lobby's PC has the same start, two seconds from its end.
    expect(start(r, 'b')).toMatchObject({ by: 'a', players: ['a', 'h', 'b'], newMatch: true });
    expect(r.host.announcedStart()).toMatchObject({ by: 'a', players: ['a', 'h', 'b'], leftMs: 2000 });
    expect(r.said['b']).toEqual([]);
    await r.tick(2000);
    expect(r.host.state.playerOrder).toEqual(['a', 'h', 'b']);
  });

  it('the last game`s RESULT is not out yet: the start waits for it (it used to be ignored)', async () => {
    const r = await starLobby(['a', 'b']);
    r.host.startMatch(['a', 'b', 'h']);
    await flush();
    client(r, 'a').reportBallEnd(10, 'script');
    await flush();
    client(r, 'b').reportBallEnd(20, 'script');
    await flush();
    // A's link drops for a moment (inside the grace); the last ball ends; A's signature is still waited for.
    await r.cut('a');
    r.host.localBallEnd(30, 'nvram');
    await flush();
    expect(r.host.state.phase).toBe('ended');
    expect(r.host.resultOut).toBe(false);
    client(r, 'b').requestStart();
    await flush();
    expect(start(r, 'b')).toEqual({ by: 'b', players: ['b', 'h'], newMatch: false, waitsFor: 'result', waitsOn: [], leftMs: null });
    // The grace runs out: the RESULT goes without A, and the countdown begins by itself.
    await r.tick(5000);
    expect(r.host.resultOut).toBe(true);
    expect(start(r, 'b')).toMatchObject({ by: 'b', players: ['b', 'h'], waitsFor: null, leftMs: 5000 });
    await countDown(r);
    expect(r.host.state.gameNumber).toBe(2);
    expect(r.host.state.playerOrder).toEqual(['b', 'h']);
  });

  it('two or more play it: the sentence names who is set to Play, and what would bring another in', async () => {
    const r = await starLobby(['a', 'b'], { stances: { a: 'watch', b: 'watch' } });
    expect(r.host.requestStart()).toBe('Only H is set to Play: a match needs two.');
    r.host.updateLocal({ stance: 'watch' });
    client(r, 'a').requestStart();
    await flush();
    expect(r.said['a']).toEqual(['Nobody is set to Play: a match needs two.']);
    // A person without the table counts as not set to Play for that start.
    client(r, 'a').setStance('play');
    client(r, 'a').updateParticipant({ noCopy: true });
    r.host.updateLocal({ stance: 'play' });
    await flush();
    expect(r.host.requestStart()).toBe('Only H is set to Play: a match needs two.');
    expect(r.lobby('b').noCopy).toEqual(['a']);
    // With a match open: its own players only; somebody outside it set to Play needs the new match.
    client(r, 'a').updateParticipant({ noCopy: false });
    await flush();
    r.host.requestStart();
    await countDown(r);
    await playGame(r);
    client(r, 'b').setStance('play');
    client(r, 'a').setStance('watch');
    await flush();
    expect(r.host.requestStart()).toBe('Only H of this match is set to Play. Press Start a new match to play with B.');
    expect(r.host.requestStart({ newMatch: true })).toBeNull();
    await countDown(r);
    expect(r.host.state.matchId).toBe('JHDFEF-2');
    expect(r.host.state.playerOrder).toEqual(['h', 'b']);
  });

  it('each of their tables is open: the start waits for the one that is loading, and counts down when it is', async () => {
    const r = await starLobby(['a', 'b'], { tables: { b: NO_TABLE } });
    expect(r.lobby('a').loading).toEqual(['b']);
    expect(r.host.requestStart()).toBeNull();
    await flush();
    expect(start(r)).toEqual({ by: 'h', players: ['h', 'a', 'b'], newMatch: true, waitsFor: 'tables', waitsOn: ['b'], leftMs: null });
    expect(r.lobby('a').startsInMs).toBeNull();
    await r.tick(60_000);
    expect(r.host.state.phase).toBe('lobby');
    client(r, 'b').updateParticipant({ game: TABLE });
    await flush();
    expect(start(r)).toMatchObject({ waitsFor: null, waitsOn: [], leftMs: 5000 });
    await countDown(r);
    expect(r.host.state.playerOrder).toEqual(['h', 'a', 'b']);
  });

  it('each of their open tables is the lobby`s table: another game open waits like a table that is loading', async () => {
    const r = await starLobby(['a', 'b'], { tables: { b: OTHER_GAME, a: SAME_GAME } });
    // The same game in another file is today's advisory and holds nothing; another game is OTHER TABLE.
    expect(r.lobby('a').otherTable).toEqual(['b']);
    expect(r.lobby('a').tableMismatches.map((t) => [t.playerId, t.mismatches.map((m) => m.field)])).toEqual([
      ['a', ['tableName', 'tableHash']],
      ['b', ['tableName', 'tableHash', 'romName']],
    ]);
    client(r, 'a').requestStart();
    await flush();
    expect(start(r)).toMatchObject({ by: 'a', players: ['a', 'h', 'b'], waitsFor: 'other_tables', waitsOn: ['b'] });
    client(r, 'b').updateParticipant({ game: TABLE });
    await flush();
    expect(r.lobby('a').otherTable).toEqual([]);
    expect(start(r)).toMatchObject({ waitsFor: null, leftMs: 5000 });
  });

  it('none of them is in a game of their own: the start waits for that game`s end (the starter`s own game from the table is the match`s)', async () => {
    const r = await starLobby(['a', 'b']);
    client(r, 'b').updateParticipant({ ownGame: true });
    await flush();
    expect(r.lobby('a').ownGame).toEqual(['b']);
    // From the starter's table: their own game is this start's first, and is in nobody's way.
    r.host.updateLocal({ ownGame: true });
    r.host.requestStart({ fromTable: true });
    await flush();
    expect(start(r)).toMatchObject({ by: 'h', waitsFor: 'own_games', waitsOn: ['b'] });
    client(r, 'b').updateParticipant({ ownGame: false });
    await flush();
    expect(start(r)).toMatchObject({ waitsFor: null, leftMs: 5000 });
    await countDown(r);
    expect(r.host.state.playerOrder).toEqual(['h', 'a', 'b']);
  });

  it('each of their tables can report ball ends: refused with the sentence, unless the asker confirmed (Start anyway)', async () => {
    const r = await starLobby(['a', 'b'], { ballEndReady: { b: false } });
    const words = "B's table cannot report ball ends (not patched, an original table, or a machine whose ball ends cannot be read). Start anyway: each of their balls is then ended with End my ball.";
    expect(r.host.requestStart()).toBe(words);
    client(r, 'a').requestStart();
    await flush();
    expect(r.said['a']).toEqual([words]);
    expect(start(r)).toBeNull();
    // A client confirms: the player concerned ends their own balls, so it needs no hands at the lobby's PC.
    client(r, 'a').requestStart({ anyway: true });
    await flush();
    expect(start(r)).toMatchObject({ by: 'a', players: ['a', 'h', 'b'], waitsFor: null });
    await countDown(r);
    expect(r.host.state.phase).toBe('running');
  });

  it('their 3D connections are settled: the start waits, for players only, 45 s at most from the first held start', async () => {
    const r = await starLobby(['a', 'b', 'c'], { stances: { c: 'watch' } });
    // A watcher's connection that is late holds nothing.
    client(r, 'c').updateParticipant({ stream3dWaitMs: 60_000 });
    await flush();
    r.host.requestStart();
    await flush();
    expect(start(r)).toMatchObject({ waitsFor: null, leftMs: 5000 });
    r.host.cancelStart();
    // A player's does: until it says it is settled.
    client(r, 'b').updateParticipant({ stream3dWaitMs: 60_000 });
    await flush();
    r.host.requestStart();
    await flush();
    expect(start(r)).toEqual({ by: 'h', players: ['h', 'a', 'b'], newMatch: true, waitsFor: '3d', waitsOn: ['b'], leftMs: 45_000 });
    await r.tick(10_000);
    client(r, 'b').updateParticipant({ stream3dWaitMs: 0 });
    await flush();
    expect(start(r)).toMatchObject({ waitsFor: null, leftMs: 5000 });
    r.host.cancelStart();
    // And a PC that never settles is waited for 45 s from the first hold, then the countdown begins without it.
    client(r, 'b').updateParticipant({ stream3dWaitMs: 120_000 });
    await flush();
    r.host.requestStart();
    await r.tick(44_000);
    expect(r.host.announcedStart()).toMatchObject({ waitsFor: '3d', waitsOn: ['b'], leftMs: 1000 });
    await r.tick(1000);
    expect(start(r)).toMatchObject({ waitsFor: null, leftMs: 5000 });
    await countDown(r);
    expect(r.host.state.phase).toBe('running');
    // Every start of a lobby waits, not only the first: between games too.
    await playGame(r);
    client(r, 'a').updateParticipant({ stream3dWaitMs: 30_000 });
    await flush();
    r.host.requestStart();
    await flush();
    expect(start(r)).toMatchObject({ newMatch: false, waitsFor: '3d', waitsOn: ['a'] });
  });
});

describe('A17 step 6: the checks run again when the countdown runs out', () => {
  it('a table that closed during the countdown: the start becomes one that waits, and counts down again when it is open', async () => {
    const r = await starLobby(['a', 'b']);
    r.host.requestStart();
    await r.tick(2000);
    client(r, 'b').updateParticipant({ game: NO_TABLE });
    await flush();
    // While it counts down nothing is checked: the countdown goes on.
    expect(start(r)).toMatchObject({ waitsFor: null, leftMs: 3000 });
    await r.tick(3000);
    expect(r.host.state.phase).toBe('lobby');
    expect(start(r)).toEqual({ by: 'h', players: ['h', 'a', 'b'], newMatch: true, waitsFor: 'tables', waitsOn: ['b'], leftMs: null });
    expect(r.lobby('a').startsInMs).toBeNull();
    client(r, 'b').updateParticipant({ game: TABLE });
    await flush();
    expect(start(r)).toMatchObject({ waitsFor: null, leftMs: 5000 });
    await countDown(r);
    expect(r.host.state.playerOrder).toEqual(['h', 'a', 'b']);
  });

  it('a check that refuses when the countdown runs out takes the start away, with its sentence for everyone', async () => {
    const r = await starLobby(['a', 'b']);
    const off: string[] = [];
    r.host.on('startOff', (x) => off.push(x.reason));
    client(r, 'a').requestStart();
    await r.tick(1000);
    client(r, 'b').updateParticipant({ ballEndReady: false });
    await r.tick(4000);
    expect(r.host.state.phase).toBe('lobby');
    expect(start(r, 'b')).toBeNull();
    expect(r.lobby('b').startOff).toMatch(/^B's table cannot report ball ends/);
    expect(off).toHaveLength(1);
    // Another game, an own game, a late 3D connection at that moment make it wait instead (one of them here).
    client(r, 'b').updateParticipant({ ballEndReady: true });
    client(r, 'a').requestStart();
    await r.tick(4000);
    client(r, 'b').updateParticipant({ ownGame: true });
    await r.tick(1000);
    expect(start(r)).toMatchObject({ by: 'a', waitsFor: 'own_games', waitsOn: ['b'] });
  });

  it('Play / Watch during a start: a switch to Watch takes that person out, a switch to Play counts from the next start', async () => {
    const r = await starLobby(['a', 'b', 'c'], { stances: { c: 'watch' } });
    client(r, 'a').requestStart();
    await r.tick(1000);
    client(r, 'c').setStance('play');
    client(r, 'b').setStance('watch');
    await flush();
    expect(start(r, 'c')).toMatchObject({ by: 'a', players: ['a', 'h'], waitsFor: null, leftMs: 4000 });
    await r.tick(4000);
    expect(r.host.state.playerOrder).toEqual(['a', 'h']);
    // With fewer than two left it is cancelled, and the panel says who.
    const q = await starLobby(['a']);
    q.host.requestStart();
    await q.tick(1000);
    client(q, 'a').setStance('watch');
    await flush();
    expect(start(q)).toBeNull();
    expect(q.lobby('a').startOff).toBe('A is set to Watch now: the start is off.');
    await q.tick(10_000);
    expect(q.host.state.phase).toBe('lobby');
  });

  it('a start that waits belongs to the person who asked: it is off when they switch to Watch, and when their game on the table ends', async () => {
    const r = await starLobby(['a', 'b'], { tables: { b: NO_TABLE } });
    client(r, 'a').requestStart();
    await flush();
    expect(start(r, 'b')).toMatchObject({ by: 'a', waitsFor: 'tables', waitsOn: ['b'] });
    client(r, 'a').setStance('watch');
    await flush();
    expect(start(r, 'b')).toBeNull();
    expect(r.lobby('b').startOff).toBe('A is set to Watch now: the start is off.');
    // From the starter's table: the game that asked is over before anything started (A12: the next Start asks again).
    r.host.requestStart({ fromTable: true });
    await flush();
    expect(start(r, 'b')).toMatchObject({ by: 'h', waitsFor: 'tables' });
    r.host.updateLocal({ ownGame: false });
    await flush();
    expect(start(r, 'b')).toBeNull();
    expect(r.lobby('b').startOff).toBe("H's game on the table ended: the start is off.");
  });

  it('a second press while a start waits is "start without them", if two are left', async () => {
    const r = await starLobby(['a', 'b'], { tables: { b: NO_TABLE } });
    r.host.requestStart();
    await flush();
    expect(start(r)).toMatchObject({ waitsFor: 'tables', waitsOn: ['b'] });
    // A press without `now` changes nothing; with it, by anyone, B is left out and the countdown begins.
    client(r, 'a').requestStart();
    await flush();
    expect(start(r)).toMatchObject({ waitsFor: 'tables', players: ['h', 'a', 'b'] });
    client(r, 'b').requestStart({ now: true });
    await flush();
    expect(start(r)).toEqual({ by: 'h', players: ['h', 'a'], newMatch: true, waitsFor: null, waitsOn: [], leftMs: 5000 });
    await countDown(r);
    expect(r.host.state.playerOrder).toEqual(['h', 'a']);
    // One person who would be left alone cannot start without the other.
    const q = await starLobby(['a'], { tables: { a: NO_TABLE } });
    q.host.requestStart();
    expect(q.host.requestStart({ now: true })).toBe('Without A only H is left: a match needs two.');
    expect(q.host.announcedStart()?.waitsFor).toBe('tables');
    // And the 3D wait is given up by the same press.
    const s = await starLobby(['a']);
    client(s, 'a').updateParticipant({ stream3dWaitMs: 60_000 });
    await flush();
    s.host.requestStart();
    client(s, 'a').requestStart({ now: true });
    await flush();
    expect(start(s)).toMatchObject({ waitsFor: null, leftMs: 5000 });
  });
});

describe('A17 step 6: the starter, the next game, a new match, End match', () => {
  it('the starter: the first set to Play who is here and has the table; between games whoever went first, else the next in that order', async () => {
    const r = await starLobby(['a', 'b', 'c'], { stances: { h: 'watch' } });
    expect(r.host.starter()).toBe('a');
    client(r, 'a').updateParticipant({ noCopy: true });
    await flush();
    expect(r.lobby('c').starter).toBe('b');
    client(r, 'a').updateParticipant({ noCopy: false });
    await flush();
    // C asks from a button: C goes first and is the starter of the next game.
    client(r, 'c').requestStart();
    await countDown(r);
    expect(r.host.state.playerOrder).toEqual(['c', 'a', 'b']);
    await playGame(r);
    expect(r.lobby('a').starter).toBe('c');
    client(r, 'c').setStance('watch');
    await flush();
    expect(r.lobby('a').starter).toBe('a');
    // The starter's table starts the next game of the open match, with its players who are set to Play.
    client(r, 'a').requestStart({ fromTable: true });
    await flush();
    expect(start(r, 'b')).toEqual({ by: 'a', players: ['a', 'b'], newMatch: false, waitsFor: null, waitsOn: [], leftMs: 5000 });
    await countDown(r);
    expect(r.host.state.gameNumber).toBe(2);
    expect(r.host.state.playerOrder).toEqual(['a', 'b']);
    // Nobody set to Play: nobody starts from a table.
    const q = await starLobby(['a'], { stances: { h: 'watch', a: 'watch' } });
    expect(q.host.starter()).toBeNull();
    expect(q.host.requestStart({ fromTable: true })).toBe('Nobody starts a match from the table. To start it yourself, use Start in the menu.');
  });

  it('with a match open a start is its next game; a new match is asked for by name, ends the open one and brings everyone set to Play in', async () => {
    const r = await starLobby(['a']);
    r.host.requestStart();
    await countDown(r);
    const c = await r.join('c');
    await playGame(r);
    // C is in the lobby, set to Play, and not in the match. C's own press is the match's next game, without C.
    c.requestStart();
    await flush();
    expect(start(r)).toEqual({ by: 'c', players: ['h', 'a'], newMatch: false, waitsFor: null, waitsOn: [], leftMs: 5000 });
    await countDown(r);
    expect(r.host.state.matchId).toBe('JHDFEF-1');
    expect(r.host.state.gameNumber).toBe(2);
    expect(r.host.state.playerOrder).toEqual(['h', 'a']);
    await playGame(r, 300);
    // A player's press: the asker first.
    client(r, 'a').requestStart();
    await countDown(r);
    expect(r.host.state.playerOrder).toEqual(['a', 'h']);
    await playGame(r, 600);
    // Start a new match: the open one ends at three games, the new one has all three, the asker first.
    c.requestStart({ newMatch: true });
    await flush();
    expect(start(r)).toMatchObject({ by: 'c', players: ['c', 'h', 'a'], newMatch: true });
    expect(r.host.state.matchId).toBe('JHDFEF-1');
    await countDown(r);
    expect(r.events['a']?.filter((e) => e.startsWith('matchEnded') || e.startsWith('ready'))).toEqual(['ready JHDFEF-1', 'matchEnded 3', 'ready JHDFEF-2']);
    expect(r.host.state.playerOrder).toEqual(['c', 'h', 'a']);
    expect(r.host.previousMatch()?.matchId).toBe('JHDFEF-1');
  });

  it('End match: anyone between games; during a game only the lobby`s PC, for everyone, and that game has no result', async () => {
    const r = await starLobby(['a', 'b'], { balls: 2, stances: { b: 'watch' } });
    client(r, 'b').requestEnd();
    await flush();
    expect(r.said['b']).toEqual(['No match is open.']);
    r.host.requestStart();
    await countDown(r);
    await playGame(r);
    r.host.requestStart();
    await countDown(r);
    // Game 2 is being played. A member cannot end it.
    client(r, 'a').requestEnd();
    await flush();
    expect(r.said['a']).toEqual(["Only the lobby's PC ends a match while a game is being played."]);
    r.host.localBallEnd(50, 'nvram');
    await flush();
    const log = r.host.log;
    const length = log.length;
    const before = types(r, 'FORFEIT') + types(r, 'RESULT');
    // The lobby's PC ends it for everyone: nothing is logged, nobody forfeits, no RESULT; MATCH_END names the game.
    expect(r.host.requestEnd()).toBeNull();
    await flush();
    expect(r.events['b']?.slice(-1)).toEqual(['matchEnded 1 abandoned 2']);
    expect(types(r, 'FORFEIT') + types(r, 'RESULT')).toBe(before);
    expect(log.length).toBe(length);
    expect(r.host.previousMatch()?.log).toBe(log);
    expect(log.entries().slice(-1)[0]?.message?.type).toBe('TURN_GRANT');
    // The tally is that of the last RESULT: one game, and every PC holds the log as it stood.
    expect(r.results['b']?.map((x) => x.result.game)).toEqual([1]);
    expect(r.results['b']?.[0]?.result.series.map((s) => s.games)).toEqual([1, 1]);
    for (const id of ['a', 'b']) {
      expect(client(r, id).previousMatch()?.log.head()).toEqual(log.head());
      expect(client(r, id).state.phase).toBe('lobby');
      expect(client(r, id).inputUnlocked).toBe(false);
    }
    expect(r.host.state.phase).toBe('lobby');
    expect(r.host.members()).toHaveLength(3);
    // A match whose only game was left unfinished has no result at all.
    r.host.requestStart();
    await countDown(r);
    expect(r.host.endMatch('enough')).toBe(true);
    await flush();
    expect(r.events['a']?.slice(-1)).toEqual(['matchEnded 0 abandoned 1']);
    expect(r.results['a']).toHaveLength(1);
    // Between games a member ends the match; the next start is a new one.
    r.host.requestStart();
    await countDown(r);
    await playGame(r, 700);
    client(r, 'b').requestEnd();
    await flush();
    expect(r.events['a']?.slice(-1)).toEqual(['matchEnded 1']);
    expect(r.said['b']).toEqual(['No match is open.']);
    expect(r.host.previousMatch()?.matchId).toBe('JHDFEF-3');
  });
});

describe('A17 step 6: the lobby`s table is a pick (design 11.5)', () => {
  it('anyone picks, in the lobby: the identity keys only, who picked, and every row compared with it again', async () => {
    const r = await starLobby(['a', 'b']);
    const picked: string[] = [];
    r.host.on('tablePicked', (x) => picked.push(`${x.by} ${x.game.tableName}`));
    expect(r.lobby('a').tablePickedBy).toBe('h');
    expect(r.lobby('a').hostGame).toEqual(pickOf(TABLE));
    client(r, 'a').pickTable(OTHER_GAME);
    await flush();
    expect(picked).toEqual(['a Congo (Williams 1995)']);
    const seen = r.lobby('b');
    expect(seen.tablePickedBy).toBe('a');
    expect(seen.hostGame).toEqual({ kind: 'vpx', tableName: 'Congo (Williams 1995)', tableHash: OTHER_GAME.tableHash, romName: 'congo_21', romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '' });
    // Everyone still has Monster Bash open: another game than the pick, the lobby's PC like the others.
    expect(seen.otherTable).toEqual(['h', 'a', 'b']);
    expect(seen.tableMismatches.map((t) => t.playerId)).toEqual(['h', 'a', 'b']);
    expect(r.host.table()).toEqual({ game: pickOf(OTHER_GAME), pickedBy: 'a' });
    // Each PC opens it (the shell's work); the rows clear one by one, and the pick stays the pick.
    client(r, 'a').updateParticipant({ game: NO_TABLE });
    await flush();
    expect(r.lobby('b').loading).toEqual(['a']);
    expect(r.lobby('b').otherTable).toEqual(['h', 'b']);
    client(r, 'a').updateParticipant({ game: OTHER_GAME });
    r.host.updateLocal({ game: OTHER_GAME });
    await flush();
    expect(r.lobby('b').otherTable).toEqual(['b']);
    expect(r.lobby('b').tableMismatches.map((t) => t.playerId)).toEqual(['b']);
    expect(r.lobby('b').tablePickedBy).toBe('a');
    // A start waits for the one who has not followed yet.
    r.host.requestStart();
    await flush();
    expect(start(r)).toMatchObject({ waitsFor: 'other_tables', waitsOn: ['b'] });
    // The match's own fingerprint is a full one: the open table of the first player, never a pick.
    client(r, 'b').updateParticipant({ game: OTHER_GAME });
    await countDown(r);
    expect(r.host.state.game).toEqual(OTHER_GAME);
    // A client compares its own table with the pick on the identity keys alone.
    expect(client(r, 'b').tableMismatches()).toEqual({});
  });

  it('a pick is refused during a game and while a start is announced; between games it ends the open match', async () => {
    const r = await starLobby(['a']);
    r.host.requestStart();
    await flush();
    client(r, 'a').pickTable(OTHER_GAME);
    await flush();
    expect(r.said['a']).toEqual(['A match is starting: cancel the start to change the table.']);
    await countDown(r);
    expect(r.host.pickTable(OTHER_GAME)).toBe('A game is being played: the table changes after it.');
    await playGame(r);
    // The table it already is: nothing changes, the match stays open.
    expect(r.host.pickTable(TABLE)).toBeNull();
    expect(r.host.openMatch()?.matchId).toBe('JHDFEF-1');
    client(r, 'a').pickTable(OTHER_GAME);
    await flush();
    expect(r.events['a']?.slice(-1)).toEqual(['matchEnded 1']);
    expect(r.host.state.phase).toBe('lobby');
    expect(r.lobby('a').match).toBeNull();
    expect(r.lobby('a').tablePickedBy).toBe('a');
    const end = r.sent('h', 'a').filter((m) => m.type === 'MATCH_END').pop();
    expect(end?.type === 'MATCH_END' && end.payload.reason).toBe('the table changed');
  });

  it('a lobby opened with no table takes the first table its PC opens; one opened with a pick keeps it while its PC has none', async () => {
    const r = await starLobby(['a'], { tables: { h: NO_TABLE } });
    expect(r.lobby('a').tablePickedBy).toBeNull();
    expect(r.lobby('a').loading).toEqual(['h']);
    expect(r.lobby('a').otherTable).toEqual([]);
    r.host.updateLocal({ game: TABLE });
    await flush();
    expect(r.lobby('a').tablePickedBy).toBe('h');
    expect(r.lobby('a').hostGame).toEqual(pickOf(TABLE));
    expect(r.lobby('a').tableMismatches).toEqual([]);
    // After that the lobby's PC is a row like any other: another table on it is its own difference, not a new pick.
    r.host.updateLocal({ game: OTHER_GAME });
    await flush();
    expect(r.lobby('a').hostGame).toEqual(pickOf(TABLE));
    expect(r.lobby('a').otherTable).toEqual(['h']);
    expect(r.lobby('a').tableMismatches.map((t) => t.playerId)).toEqual(['h']);
    // Opened with a pick (the table picker), the PC's own table not open yet.
    const q = await starLobby(['a'], { tables: { h: NO_TABLE }, lobby: { table: TABLE } });
    expect(q.lobby('a').tablePickedBy).toBe('h');
    expect(q.lobby('a').hostGame).toEqual(pickOf(TABLE));
    expect(q.lobby('a').loading).toEqual(['h']);
    expect(q.lobby('a').tableMismatches.map((t) => t.playerId)).toEqual(['h']);
    q.host.updateLocal({ game: SAME_GAME });
    await flush();
    expect(q.lobby('a').loading).toEqual([]);
    expect(q.lobby('a').otherTable).toEqual([]);
    expect(q.lobby('a').tableMismatches.map((t) => [t.playerId, t.mismatches.map((m) => m.field)])).toEqual([['h', ['tableName', 'tableHash']]]);
    // In a lobby a table that differs is never a refusal: a newcomer with another game is in, and its row says so.
    const late = await q.join('late', { game: OTHER_GAME });
    expect(late.refused).toBeNull();
    expect(q.lobby('a').otherTable).toEqual(['late']);
  });
});
