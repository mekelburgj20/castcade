/**
 * A17 step 6 (2026-11-25, alpha-match.md §11.7, §11.8, §11.8a): people who are away, and people who come back, with
 * the lobby option on. A link that drops changes the game only for the person whose link it is, and only when the
 * game needs that person: a watcher, a waiting player, the player who is up, and the lobby's PC itself; the two
 * clocks on a manual clock; RECONNECT in every phase, its `restart`, its one use, and the head every answer names;
 * a place that ran out and the HELLO that follows.
 */
import { describe, expect, it } from 'vitest';
import type { AnyMessage, PlayerId } from '@castcade/protocol';
import type { ClientMatch } from './client.js';
import { expectHeadsNamed, flush, playGame, starLobby, type StarRig } from './lobby.test-support.js';

const client = (r: StarRig, id: string): ClientMatch => r.clients[id] as ClientMatch;
const logged = (r: StarRig): string[] => r.host.log.entries().map((e) => `${e.message?.type ?? e.event?.type}${e.message?.type === 'PAUSE' ? `(${e.message.payload.reason} ${e.message.payload.player})` : ''}`);
const MIN = 60_000;
/** Every answer of this run names the head of the log it carries (and there was at least one answer to look at). */
function headsNamed(r: StarRig): void {
  const seen = expectHeadsNamed(r, (ok, what) => expect(ok, what).toBe(true));
  expect(seen).toBeGreaterThan(0);
}

describe('A17 step 6: a member who is away keeps their place, for a while', () => {
  it('a watcher drops: no player sees anything but the row; back by itself; the place goes after 3 minutes, and a later return is a new join', async () => {
    const r = await starLobby(['a', 'b'], { stances: { b: 'watch' }, balls: 2 });
    const left: string[] = [];
    const removed: string[] = [];
    r.host.on('peerLeft', (p) => left.push(p));
    r.host.on('memberRemoved', (p) => removed.push(p));
    r.host.start();
    await flush();
    const before = logged(r);
    await r.cut('b');
    // Inside A18's grace nobody is told.
    expect(r.lobby('a').away).toEqual([]);
    await r.tick(5000);
    expect(left).toEqual(['b']);
    expect(r.lobby('a').away).toEqual(['b']);
    expect(r.lobby('a').participants.map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    // The match: nothing logged, nothing paused, the grant where it was.
    expect(logged(r)).toEqual(before);
    expect(r.host.state.paused).toBeNull();
    // Back inside the three minutes: the entries it missed, and it is a watcher as before.
    r.host.localBallEnd(10, 'nvram');
    await r.tick(60_000);
    await r.mend('b');
    expect(r.events['b']?.slice(-2)).toEqual(['peerLeft h', 'reconnected 2']);
    expect(r.lobby('a').away).toEqual([]);
    expect(client(r, 'b').log.head()).toEqual(r.host.log.head());
    // Away again, and this time for longer than the place is kept.
    await r.cut('b');
    await r.tick(5000);
    await r.tick(3 * MIN - 1);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    await r.tick(1);
    expect(removed).toEqual(['b']);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a']);
    expect(r.lobby('a').participants.map((p) => p.playerId)).toEqual(['h', 'a']);
    expect(logged(r).filter((t) => t.startsWith('PAUSE'))).toEqual([]);
    // A later return: the RECONNECT finds no place, and the same link takes a fresh HELLO: a newcomer, with the log.
    const at = r.events['b']?.length ?? 0;
    await r.mend('b');
    expect(r.events['b']?.slice(at)).toEqual(['reconnectRejected unknown_player', 'rejoining', 'joined', 'ready JHDFEF-1', `caughtUp JHDFEF-1 ${r.host.log.length}`]);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    expect(r.host.stanceOf('b')).toBe('watch');
    expect(client(r, 'b').log.head()).toEqual(r.host.log.head());
    await playGame(r);
    expect(r.results['b']?.slice(-1)[0]?.logMatches).toBe(true);
    headsNamed(r);
  });

  it('in the lobby and between games a drop is away, never a leave: the member comes back with RECONNECT while no match is open', async () => {
    const r = await starLobby(['a', 'b']);
    await r.cut('a');
    await r.tick(5000);
    expect(r.lobby('b').away).toEqual(['a']);
    expect(r.lobby('b').participants.map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    // While away they do not play a match that starts, and are not the starter.
    expect(r.host.playSet()).toEqual(['h', 'b']);
    const from = r.frames.length;
    await r.mend('a');
    const ask = r.sent('a', 'h', from)[0];
    if (ask?.type !== 'RECONNECT') throw new Error('no RECONNECT');
    // The lobby's form: the lobby's code in the envelope, no match held.
    expect([ask.matchId, ask.payload.match, ask.payload.logLength]).toEqual(['JHDFEF', null, 0]);
    const ack = r.sent('h', 'a', from)[0];
    expect(ack?.type === 'RECONNECT_ACK' && [ack.matchId, ack.payload.accept, ack.payload.restart, ack.payload.match]).toEqual(['JHDFEF', true, true, null]);
    expect(r.events['a']?.slice(-2)).toEqual(['peerLeft h', 'reconnected 0']);
    expect(r.lobby('b').away).toEqual([]);
    expect(r.host.playSet()).toEqual(['h', 'a', 'b']);
    // Between games: a player of the open match is away; the game does not need them, so the place clock runs.
    r.host.start();
    await flush();
    await playGame(r);
    await r.cut('b');
    await r.tick(5000);
    expect(r.lobby('a').away).toEqual(['b']);
    expect(r.host.nextGameBlocker()).toBeNull();
    await r.tick(3 * MIN);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a']);
    // The next game is without them, and their HELLO, when they are back, is a join into the open match as a watcher.
    r.host.requestStart();
    await r.tick(5000);
    expect(r.host.state.playerOrder).toEqual(['h', 'a']);
    await r.mend('b');
    expect(r.events['b']?.slice(-5)).toEqual(['rejoining', 'joined', 'ready JHDFEF-1', 'nextGame 2', `caughtUp JHDFEF-1 ${r.host.log.length}`]);
    expect(r.host.state.players['b']).toBeUndefined();
    headsNamed(r);
  });

  it('a HELLO never takes over the place of a member who is away, and does not make an old RECONNECT good again', async () => {
    const r = await starLobby(['a', 'b']);
    await r.cut('a');
    await r.mend('a');
    const old = r.frames.filter((f) => f.by === 'a').map((f) => JSON.parse(f.frame) as AnyMessage).find((m) => m.type === 'RECONNECT');
    if (!old) throw new Error('no RECONNECT recorded');
    await r.cut('a');
    await r.tick(5000);
    const codes: string[] = [];
    r.host.on('refused', (x) => codes.push(`${x.refuse.code}: ${x.refuse.message}`));
    r.host.on('reconnectRejected', (x) => codes.push(`reconnect ${x.code}`));
    // Somebody says HELLO as A (a copy of A's own first frame would do: it is not signed).
    const hello = r.frames.map((f) => JSON.parse(f.frame) as AnyMessage).find((m) => m.type === 'HELLO' && m.from === 'a');
    if (!hello) throw new Error('no HELLO recorded');
    r.host.handle('a', hello);
    // Refused, A's row is A's, and A's counter did not start over: the RECONNECT A sent before is still stale.
    r.host.handle('a', old);
    await flush();
    expect(codes).toEqual(['duplicate_player: a is in this lobby and away: the place is kept for a few minutes', 'reconnect stale_seq']);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    expect(r.lobby('b').away).toEqual(['a']);
  });
});

describe('A17 step 6: the turn clock runs only from the pause at that player`s own turn', () => {
  it('a waiting player drops: nothing is logged and nothing pauses during another player`s ball; at their turn the game waits 3 minutes, then goes on without them', async () => {
    const r = await starLobby(['a', 'b'], { balls: 2 });
    r.host.start();
    await flush();
    const before = logged(r);
    await r.cut('b');
    await r.tick(5000);
    // H is up and B is away: H's ball is H's, with the same grant; the lobby's row says AWAY and that is all.
    expect(logged(r)).toEqual(before);
    expect(r.host.state.paused).toBeNull();
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'h', grantSeq: 1 });
    expect(r.lobby('a').away).toEqual(['b']);
    expect(r.host.waitedFor()).toBeNull();
    // However long H's ball takes, B's clock does not run: they are still in the lobby and in the game.
    await r.tick(10 * MIN);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    expect(r.host.state.players['b']?.status).toBe('playing');
    r.host.localBallEnd(10, 'nvram');
    await flush();
    client(r, 'a').reportBallEnd(20, 'script');
    await flush();
    // The turn reaches B: now the game waits for them, and the clock starts here.
    expect(r.host.state.paused).toEqual({ reason: 'disconnect', player: 'b' });
    expect(r.host.waitedFor()).toMatchObject({ player: 'b', asked: false });
    expect(logged(r).slice(-1)).toEqual(['PAUSE(disconnect b)']);
    await r.tick(3 * MIN - 1);
    expect(r.host.state.players['b']?.status).toBe('playing');
    await r.tick(1);
    expect(logged(r).slice(-4)).toEqual(['PAUSE(disconnect b)', 'FORFEIT', 'RESUME', 'TURN_GRANT']);
    expect(r.host.state.players['b']?.status).toBe('forfeit');
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 2 });
    expect(r.host.waitedFor()).toBeNull();
    // The game no longer needs them: now their place has its three minutes.
    await r.tick(3 * MIN);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a']);
    await playGame(r);
    expect(r.results['a']?.[0]?.result.entries.map((e) => [e.playerId, e.status])).toEqual([
      ['h', 'finished'],
      ['a', 'finished'],
      ['b', 'disconnected'],
    ]);
  });

  it('waited for at their turn, the player comes back: their own RESUME, then the grant; and the owner can play on without them sooner', async () => {
    const r = await starLobby(['a', 'b']);
    r.host.startMatch(['h', 'b', 'a']);
    await flush();
    await r.cut('b');
    await r.tick(5000);
    r.host.localBallEnd(10, 'nvram');
    await r.tick(2 * MIN);
    expect(r.host.state.paused).toEqual({ reason: 'disconnect', player: 'b' });
    await r.mend('b');
    // The pause is in the entries it missed; the shell answers it with this player's own RESUME (`resumeAfterMyDrop`).
    expect(r.events['b']?.slice(-3)).toEqual(['peerLeft h', 'pause disconnect b', 'reconnected 2']);
    expect(r.host.waitedFor()).toBeNull();
    client(r, 'b').resume();
    await flush();
    expect(client(r, 'b').myGrant).toMatchObject({ player: 'b', ballNumber: 1 });
    // Play on without Krobs, before the three minutes are up.
    const q = await starLobby(['a', 'b']);
    q.host.startMatch(['h', 'b', 'a']);
    await flush();
    await q.cut('b');
    await q.tick(5000);
    expect(q.host.playOnWithout('b')).toBe(false);
    q.host.localBallEnd(10, 'nvram');
    await q.tick(30_000);
    expect(q.host.playOnWithout('a')).toBe(false);
    expect(q.host.playOnWithout('b')).toBe(true);
    await flush();
    expect(q.host.state.players['b']?.status).toBe('forfeit');
    expect(q.host.state.currentGrant?.grant.player).toBe('a');
    headsNamed(r);
  });

  it('the player who is up drops: the pause at their own turn; after 3 minutes forfeited when nothing of theirs arrives any more', async () => {
    const r = await starLobby(['a', 'b'], { stances: { b: 'watch' } });
    const asked: unknown[] = [];
    r.host.on('awayQuestion', (x) => asked.push(x));
    r.host.startMatch(['a', 'h']);
    await flush();
    await r.cut('a');
    await r.tick(4999);
    expect(r.host.state.paused).toBeNull();
    await r.tick(1);
    expect(r.host.state.paused).toEqual({ reason: 'disconnect', player: 'a' });
    expect(r.events['b']?.slice(-1)).toEqual(['pause disconnect a']);
    expect(r.host.waitedFor()).toMatchObject({ player: 'a' });
    await r.tick(3 * MIN);
    expect(asked).toEqual([]);
    expect(logged(r).slice(-3)).toEqual(['FORFEIT', 'RESUME', 'TURN_GRANT']);
    expect(r.host.state.currentGrant?.grant.player).toBe('h');
  });

  it('the player who is up drops and is still seen playing: never forfeited by a clock; the owner is asked, and answers', async () => {
    const seen = { a: true };
    const r = await starLobby(['a', 'b'], { balls: 2, stances: { b: 'watch' }, lobby: { stillSeen: (p: PlayerId) => p === 'a' && seen.a } });
    const asked: { player: PlayerId; waitedMs: number }[] = [];
    r.host.on('awayQuestion', (x) => asked.push(x));
    r.host.startMatch(['a', 'h']);
    await flush();
    await r.cut('a');
    await r.tick(5000);
    expect(r.host.answerAway('a', 'play_on')).toBe(false);
    await r.tick(3 * MIN);
    // Their picture still reaches the lobby's PC: they are playing. Nothing is done by itself.
    expect(asked).toEqual([{ player: 'a', waitedMs: 3 * MIN }]);
    expect(r.host.state.players['a']?.status).toBe('playing');
    expect(r.host.state.paused).toEqual({ reason: 'disconnect', player: 'a' });
    expect(r.host.waitedFor()).toMatchObject({ player: 'a', asked: true });
    await r.tick(30 * MIN);
    expect(asked).toHaveLength(1);
    // Keep waiting: asked again after another three minutes.
    expect(r.host.answerAway('a', 'wait')).toBe(true);
    expect(r.host.answerAway('a', 'wait')).toBe(false);
    await r.tick(3 * MIN);
    expect(asked).toHaveLength(2);
    expect(asked[1]?.waitedMs).toBe(36 * MIN);
    // End their ball (Pass the turn): the game goes on; their next turn waits for them again.
    expect(r.host.answerAway('a', 'end_ball')).toBe(true);
    await flush();
    expect(logged(r).slice(-3)).toEqual(['TURN_PASS', 'RESUME', 'TURN_GRANT']);
    expect(r.host.state.players['a']).toMatchObject({ status: 'playing', ballsPlayed: 1 });
    expect(r.host.state.currentGrant?.grant.player).toBe('h');
    r.host.localBallEnd(10, 'nvram');
    await flush();
    expect(r.host.state.paused).toEqual({ reason: 'disconnect', player: 'a' });
    // No grant is outstanding now: nobody is "still playing", so this time the clock ends it.
    await r.tick(3 * MIN);
    expect(asked).toHaveLength(2);
    expect(r.host.state.players['a']?.status).toBe('forfeit');
    // Play on without them, as the answer.
    const q = await starLobby(['a'], { lobby: { stillSeen: () => true } });
    q.host.startMatch(['a', 'h']);
    await flush();
    await q.cut('a');
    await q.tick(5000);
    await q.tick(3 * MIN);
    expect(q.host.answerAway('a', 'play_on')).toBe(true);
    await flush();
    expect(q.host.state.players['a']?.status).toBe('forfeit');
    expect(q.host.state.currentGrant?.grant.player).toBe('h');
  });
});

describe('A17 step 6: the lobby`s PC itself is cut off (design 11.8a)', () => {
  it('for five minutes during a ball: nobody is paused, both clocks stand still, the ball end is kept and reported when it is back', async () => {
    const r = await starLobby(['a', 'b'], { stances: { b: 'watch' } });
    const left: string[] = [];
    const back: string[] = [];
    r.host.on('peerLeft', (p) => left.push(p));
    r.host.on('reconnected', (x) => back.push(`${x.playerId}${x.quiet ? ' quiet' : ''}`));
    r.host.startMatch(['a', 'h']);
    await flush();
    const before = logged(r);
    // The lobby's PC loses ArcAid: every member's link drops at once, and none of them is at fault.
    r.host.setCutOff(true);
    await r.cut('a');
    await r.cut('b');
    await r.tick(5000);
    // On the lobby's PC: no leave, no pause. On each member's: the lobby's PC is away, and they wait up to 20 minutes.
    expect(left).toEqual([]);
    expect(r.host.state.paused).toBeNull();
    expect(r.events['a']?.slice(-1)).toEqual(['peerLeft h']);
    const away = client(r, 'a').hostAway();
    expect(away && away.until !== null && away.until - away.since).toBe(20 * MIN);
    // The ball in play finishes undisturbed, and its end is kept: nobody can take it yet.
    await r.tick(2 * MIN);
    expect(client(r, 'a').inputUnlocked).toBe(true);
    client(r, 'a').reportBallEnd(77, 'script');
    expect(client(r, 'a').inputUnlocked).toBe(false);
    await r.tick(3 * MIN);
    expect(logged(r)).toEqual(before);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    expect(r.host.waitedFor()).toBeNull();
    // Back: the members return by RECONNECT inside a grace that starts from zero, and nobody was ever told they left.
    r.host.setCutOff(false);
    await r.mend('a');
    await r.mend('b');
    expect(back).toEqual(['a quiet', 'b quiet']);
    expect(left).toEqual([]);
    expect(r.events['a']?.slice(-1)).toEqual(['reconnected 0']);
    expect(client(r, 'a').hostAway()).toBeNull();
    // The kept ball end was reported, once, and the next turn is out.
    const ends = r.host.log.entries().filter((e) => e.message?.type === 'BALL_END');
    expect(ends.map((e) => e.message?.type === 'BALL_END' && [e.from, e.message.payload.finalScore])).toEqual([['a', 77]]);
    expect(logged(r).filter((t) => t.startsWith('PAUSE'))).toEqual([]);
    expect(r.host.state.currentGrant?.grant.player).toBe('h');
    expect(client(r, 'b').log.head()).toEqual(r.host.log.head());
    await playGame(r);
    expect(r.results['a']?.[0]?.result.entries.map((e) => [e.playerId, e.score, e.status])).toEqual([
      ['a', 77, 'finished'],
      ['h', 101, 'finished'],
    ]);
    headsNamed(r);
  });

  it('a member who is still gone when the lobby`s PC is back gets the grace from zero, then is away, and the clocks start then', async () => {
    const r = await starLobby(['a', 'b']);
    const left: string[] = [];
    r.host.on('peerLeft', (p) => left.push(p));
    r.host.startMatch(['h', 'a', 'b']);
    await flush();
    r.host.setCutOff(true);
    await r.cut('a');
    await r.cut('b');
    // The lobby PC's own ball ends while it is cut off: the next player cannot be reached, and the game waits there.
    r.host.localBallEnd(10, 'nvram');
    await r.tick(10 * MIN);
    expect(r.host.state.paused).toBeNull();
    expect(r.host.state.currentGrant).toBeNull();
    expect(left).toEqual([]);
    r.host.setCutOff(false);
    await r.mend('b');
    // B is back; A is not. Inside the new grace A's grant waits; after it A is away and the game is paused for A.
    expect(r.host.state.currentGrant).toBeNull();
    expect(r.host.state.paused).toBeNull();
    await r.tick(4000);
    expect(left).toEqual(['a']);
    expect(r.host.state.paused).toEqual({ reason: 'disconnect', player: 'a' });
    expect(r.lobby('b').away).toEqual(['a']);
    await r.tick(3 * MIN - 1);
    expect(r.host.state.players['a']?.status).toBe('playing');
    await r.tick(1);
    expect(r.host.state.players['a']?.status).toBe('forfeit');
    expect(r.host.state.currentGrant?.grant.player).toBe('b');
  });

  it('a member waits 20 minutes for the lobby`s PC, not thirty attempts; then the lobby is gone for it', async () => {
    const r = await starLobby(['a', 'b'], { stances: { b: 'watch' } });
    r.host.startMatch(['h', 'a']);
    await flush();
    let failed = 0;
    client(r, 'a').on('reconnectFailed', () => (failed += 1));
    await r.cut('a');
    await r.cut('b');
    for (let i = 0; i < 40; i++) await r.tick(1000);
    expect(failed).toBeGreaterThan(30);
    expect(r.events['a']).not.toContain('hostLost');
    await r.tick(19 * MIN);
    expect(r.events['a']).not.toContain('hostLost');
    await r.tick(MIN);
    await r.tick(1000);
    // A player of the game being played: the host is lost. A watcher holds the same log, and hears the same.
    expect(r.events['a']?.slice(-1)).toEqual(['hostLost']);
    expect(r.events['b']?.slice(-1)).toEqual(['hostLost']);
    expect(client(r, 'a').hostAway()).toBeNull();
    // With no match open it is `hostGone`.
    const q = await starLobby(['a'], { client: { reconnect: { delayMs: 1000, maxMs: 5000 } } });
    await q.cut('a');
    for (let i = 0; i < 8; i++) await q.tick(1000);
    expect(q.events['a']?.slice(-2)).toEqual(['peerLeft h', 'hostGone']);
  });
});

describe('A17 step 6: RECONNECT in every phase', () => {
  it('`restart`: the match the member held is over and another is open: its log is put away and the open one arrives whole', async () => {
    const r = await starLobby(['a', 'b'], { stances: { b: 'watch' }, lobby: { logPageSize: 3 } });
    r.host.start();
    await flush();
    await r.cut('b');
    await r.tick(5000);
    // While B is away: the game ends, the match is ended, a new one starts and a ball of it is played.
    await playGame(r);
    r.host.endMatch('next');
    r.host.start();
    await flush();
    r.host.localBallEnd(10, 'nvram');
    await flush();
    expect(client(r, 'b').state.matchId).toBe('JHDFEF-1');
    const from = r.frames.length;
    const at = r.events['b']?.length ?? 0;
    await r.mend('b');
    const ask = r.sent('b', 'h', from)[0];
    expect(ask?.type === 'RECONNECT' && [ask.matchId, ask.payload.match]).toEqual(['JHDFEF', 'JHDFEF-1']);
    const ack = r.sent('h', 'b', from)[0];
    expect(ack?.type === 'RECONNECT_ACK' && [ack.payload.accept, ack.payload.restart, ack.payload.match, ack.payload.entries.length]).toEqual([true, true, 'JHDFEF-2', 0]);
    const pages = r.sent('h', 'b', from).filter((m) => m.type === 'MATCH_LOG');
    expect(pages.length).toBe(Math.ceil(r.host.log.length / 3));
    expect(pages[0]?.type === 'MATCH_LOG' && [pages[0].payload.restart, pages[0].payload.match]).toEqual([true, 'JHDFEF-2']);
    expect(r.events['b']?.slice(at)).toEqual(['matchEnded 0', 'ready JHDFEF-2', `caughtUp JHDFEF-2 ${r.host.log.length}`, `reconnected ${r.host.log.length}`]);
    expect(client(r, 'b').previousMatch()?.matchId).toBe('JHDFEF-1');
    expect(client(r, 'b').log.head()).toEqual(r.host.log.head());
    expect(client(r, 'b').holdsOpenLog).toBe(true);
    // None open on the return: back in the lobby, with nothing to be sent.
    await r.cut('b');
    await r.tick(5000);
    client(r, 'a').reportBallEnd(20, 'script');
    await flush();
    await flush();
    r.host.endMatch('done');
    await flush();
    const then = r.frames.length;
    await r.mend('b');
    expect(r.sent('h', 'b', then).map((m) => m.type)).toEqual(['RECONNECT_ACK', 'HELLO_ACK']);
    expect(r.events['b']?.slice(-2)).toEqual(['matchEnded 0', 'reconnected 0']);
    expect(client(r, 'b').state.phase).toBe('lobby');
    expect(r.lobby('b').match).toBeNull();
    expect(r.dropped['b']).toEqual([]);
    headsNamed(r);
  });

  it('a RECONNECT is good for one use: sent again as it was it is stale, in a new envelope its signature does not cover the new seq', async () => {
    const r = await starLobby(['a', 'b']);
    r.host.start();
    await flush();
    await r.cut('a');
    await r.mend('a');
    const old = r.frames.filter((f) => f.by === 'a').map((f) => JSON.parse(f.frame) as AnyMessage).find((m) => m.type === 'RECONNECT');
    if (!old || old.type !== 'RECONNECT') throw new Error('no RECONNECT recorded');
    const codes: string[] = [];
    r.host.on('reconnectRejected', (x) => codes.push(`${x.playerId} ${x.code}`));
    const left: string[] = [];
    r.host.on('peerLeft', (p) => left.push(p));
    const head = r.host.log.head();
    const from = r.frames.length;
    // The captured frame, sent again as it was.
    r.host.handle('a', old);
    // And its payload in a new envelope with a higher seq (and a later time): the signature is over the old seq.
    r.host.handle('a', { ...old, seq: old.seq + 1_000_000, ts: old.ts + 1 });
    // And one for another lobby's code, or naming somebody else.
    r.host.handle('a', { ...old, seq: old.seq + 2_000_000, matchId: 'OTHERS' });
    await flush();
    expect(codes).toEqual(['a stale_seq', 'a bad_signature', 'a bad_signature']);
    const answers = r.sent('h', 'a', from).filter((m) => m.type === 'RECONNECT_ACK');
    expect(answers.map((m) => m.type === 'RECONNECT_ACK' && [m.payload.accept, m.payload.code, m.payload.entries.length])).toEqual([
      [false, 'stale_seq', 0],
      [false, 'bad_signature', 0],
      [false, 'bad_signature', 0],
    ]);
    // A is where A was: in the lobby, on its link, in the game; nobody was told anything, nothing was paused.
    expect(left).toEqual([]);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    expect(r.lobby('b').away).toEqual([]);
    expect(r.host.state.paused).toBeNull();
    expect(r.host.log.head()).toEqual(head);
    expect(r.bus.isConnected('a')).toBe(true);
    r.host.localBallEnd(10, 'nvram');
    await flush();
    expect(client(r, 'a').myGrant?.player).toBe('a');
    // A's own next reconnect, with its own next seq, is taken.
    await r.cut('a');
    await r.mend('a');
    expect(r.events['a']?.slice(-1)).toEqual(['reconnected 0 quiet']);
    // Somebody who is not in the lobby: the place is not theirs.
    r.host.handle('zed', { ...old, from: 'zed', seq: 5, payload: { ...old.payload, player: 'zed' } });
    await flush();
    expect(codes.slice(-1)).toEqual(['zed unknown_player']);
    headsNamed(r);
  });

  it('a player comes back in the middle of a long game: the first page in the answer, the rest in MATCH_LOG, each naming its own head', async () => {
    const r = await starLobby(['a', 'b'], { balls: 4, lobby: { logPageSize: 2 } });
    r.host.startMatch(['h', 'a', 'b']);
    await flush();
    await r.cut('b');
    r.host.localBallEnd(10, 'nvram');
    await flush();
    client(r, 'a').reportBallEnd(20, 'script');
    await flush();
    const held = client(r, 'b').log.length;
    const from = r.frames.length;
    await r.mend('b');
    const got = r.sent('h', 'b', from);
    expect(got.map((m) => m.type)).toEqual(['RECONNECT_ACK', 'HELLO_ACK', 'MATCH_LOG', 'TURN_GRANT']);
    const ack = got[0];
    expect(ack?.type === 'RECONNECT_ACK' && [ack.payload.more, ack.payload.match, ack.payload.entries.length, ack.payload.logLength]).toEqual([true, 'JHDFEF-1', 2, held + 2]);
    const page = got[2];
    // Three entries were missed (the grant for B itself waited for B): two in the answer, one in the page.
    expect(page?.type === 'MATCH_LOG' && [page.payload.restart, page.payload.more, page.payload.entries.length, page.payload.logLength]).toEqual([false, false, 1, held + 3]);
    expect(r.events['b']?.slice(-2)).toEqual([`caughtUp JHDFEF-1 ${held + 3}`, 'reconnected 3 quiet']);
    expect(client(r, 'b').myGrant?.player).toBe('b');
    expect(client(r, 'b').log.head()).toEqual(r.host.log.head());
    expect(r.dropped['b']).toEqual([]);
    expect(r.events['b']?.filter((e) => e.startsWith('desync'))).toEqual([]);
    headsNamed(r);
  });

  it('a start, and a member who goes away during it', async () => {
    const r = await starLobby(['a', 'b'], { lobby: { countdownMs: 20_000 } });
    r.host.requestStart();
    await r.tick(1000);
    await r.cut('b');
    await r.tick(5000);
    // Away: taken out of the start; with two left it goes on.
    expect(r.lobby('a').start).toMatchObject({ players: ['h', 'a'], waitsFor: null });
    await r.tick(14_000);
    expect(r.host.state.playerOrder).toEqual(['h', 'a']);
    // A start that waits belongs to its asker: it is off when they are away.
    const q = await starLobby(['a', 'b']);
    client(q, 'b').updateParticipant({ ownGame: true });
    client(q, 'a').requestStart();
    await flush();
    expect(q.lobby('b').start).toMatchObject({ by: 'a', waitsFor: 'own_games' });
    await q.cut('a');
    await q.tick(5000);
    expect(q.lobby('b').start).toBeNull();
    expect(q.lobby('b').startOff).toBe('A is away: the start is off.');
  });
});
