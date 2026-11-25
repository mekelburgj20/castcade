/**
 * A17 step 8 (2026-11-26, alpha-match.md sections 11.7, 11.8, 11.8a): the lobby's PC whose Castcade started again
 * comes back as the same lobby. What it saved (`HostMatch.savedLobby`, the open match's log, the counters'
 * ceilings) goes through JSON, as a file does; the engine and its session after the restart are new ones
 * (`HostMatch.restoreLobby`). The members' engines are the ones they had: for them the lobby's PC was away.
 *
 * The property of the counters (`SeqGuard` in session.ts): after a restart a frame is taken from a member only when
 * its number is above every number that could have been taken from that member before, and the lobby PC's own
 * frames are numbered above every number it could have used before.
 */
import { describe, expect, it } from 'vitest';
import type { AnyMessage, PlayerId } from '@castcade/protocol';
import type { ClientMatch } from './client.js';
import { HostMatch, type LobbyOptions, type SavedLobby } from './host.js';
import { MatchLog, type LogEntry } from './log.js';
import { flush, playGame, starLobby, TABLE, type StarOptions, type StarRig } from './lobby.test-support.js';
import { Session, type SeqCeilings } from './session.js';

const client = (r: StarRig, id: string): ClientMatch => r.clients[id] as ClientMatch;
const MIN = 60_000;

/** What the lobby's PC has on disk: written whole at every change, as the shell writes it. */
interface Disk {
  lobby: SavedLobby | null;
  log: LogEntry[];
  seq: SeqCeilings;
  /** How often the counters' ceilings were written. */
  seqWrites: number;
}

/** A lobby whose PC saves itself: the counters before a number above their ceiling counts, the rest on every word of the lobby and every log entry. */
async function saved(ids: string[], opts: StarOptions = {}): Promise<{ r: StarRig; disk: Disk; watch: (h: HostMatch) => void }> {
  const disk: Disk = { lobby: null, log: [], seq: { taken: {}, sent: 0 }, seqWrites: 0 };
  const guard = {
    step: 100,
    save: (now: SeqCeilings) => {
      disk.seq = JSON.parse(JSON.stringify(now)) as SeqCeilings;
      disk.seqWrites += 1;
    },
  };
  const r = await starLobby(ids, { ...opts, seqGuard: guard });
  const watch = (h: HostMatch): void => {
    const write = (): void => {
      disk.lobby = JSON.parse(JSON.stringify(h.savedLobby())) as SavedLobby;
      disk.log = JSON.parse(JSON.stringify(h.log.toJSON())) as LogEntry[];
    };
    h.session.onCommit = write;
    h.on('lobby', write);
    h.on('result', write);
    h.on('matchEnded', write);
    write();
  };
  watch(r.host);
  return { r, disk, watch };
}

/**
 * Castcade on the lobby's PC is gone (nothing is said to anybody), every member's link drops with it, and it starts
 * again from what was on disk: a new session and a new engine, restored. `runAfterRestore` is the caller's to call.
 */
async function restart(r: StarRig, disk: Disk, watch: (h: HostMatch) => void, lobby: LobbyOptions = {}, graceMs = 5000): Promise<HostMatch> {
  const transport = r.taps.get('h');
  if (!transport || !disk.lobby) throw new Error('nothing was saved');
  r.host.close();
  for (const id of Object.keys(r.clients)) await r.cut(id);
  const at = JSON.parse(JSON.stringify(disk)) as Disk;
  const session = new Session({
    transport,
    keys: r.hostKeys,
    clock: r.clock,
    log: MatchLog.fromJSON(at.log),
    seqGuard: {
      step: 100,
      taken: at.seq.taken,
      sent: at.seq.sent,
      save: (now) => {
        disk.seq = JSON.parse(JSON.stringify(now)) as SeqCeilings;
        disk.seqWrites += 1;
      },
    },
  });
  const host = HostMatch.restoreLobby(
    at.lobby as SavedLobby,
    {
      disconnectGraceMs: graceMs,
      transport,
      keys: r.hostKeys,
      matchId: 'JHDFEF',
      ballsPerGame: 1,
      hostParticipant: { playerId: 'h', displayName: 'H', publicKey: r.hostKeys.publicKeyB64, rig: 'pc' },
      hostGame: TABLE,
      clock: r.clock,
      lobby: { stance: 'play', ...lobby },
    },
    session,
  );
  r.host = host;
  watch(host);
  return host;
}

const logged = (h: HostMatch): string[] => h.log.entries().map((e) => `${e.message?.type ?? e.event?.type}${e.message?.type === 'BALL_END' ? `(${e.from} ${e.message.payload.finalScore})` : ''}`);

describe("A17 step 8: the lobby's PC restarts and is the same lobby", () => {
  it("with a match open, during a member's ball: the members, their choices and keys, the table, the match with its log and its grant are back; the member who is up plays on, their ball end is kept and taken when the lobby is back; nobody was paused or counted as away", async () => {
    const { r, disk, watch } = await saved(['a', 'b'], { stances: { b: 'watch' } });
    r.host.startMatch(['a', 'h']);
    await flush();
    const grant = r.host.state.currentGrant?.grant;
    expect(grant).toMatchObject({ player: 'a', ballNumber: 1 });
    const before = { members: r.host.members(), table: r.host.table(), head: r.host.log.head(), entries: logged(r.host) };

    // (A grace of a minute after the return in this test: a member's next attempt may be half a minute away.)
    const host = await restart(r, disk, watch, {}, MIN);
    // The same lobby: everyone in it with their row and their choice, the pick, the open match and its outstanding grant.
    expect(host.members()).toEqual(before.members);
    expect(['h', 'a', 'b'].map((id) => host.stanceOf(id))).toEqual(['play', 'play', 'watch']);
    expect(host.table()).toEqual(before.table);
    expect(host.openMatch()).toEqual({ matchId: 'JHDFEF-1', players: ['a', 'h'], game: 1, state: 'game' });
    expect(host.log.head()).toEqual(before.head);
    expect(host.state.currentGrant?.grant).toEqual(grant);
    const left: string[] = [];
    const back: string[] = [];
    host.on('peerLeft', (p) => left.push(p));
    host.on('reconnected', (x) => back.push(`${x.playerId}${x.quiet ? ' quiet' : ''}`));

    // The member who is up plays on meanwhile; the ball ends, and the end is kept on their PC.
    expect(client(r, 'a').inputUnlocked).toBe(true);
    client(r, 'a').reportBallEnd(77, 'script');
    expect(client(r, 'a').inputUnlocked).toBe(false);
    host.runAfterRestore();
    await r.tick(2000);
    // A member's grant stands as it was: nothing was issued again, nothing logged, nobody paused.
    expect(logged(host)).toEqual(before.entries);
    expect(host.state.paused).toBeNull();

    // The members come back by themselves, as after any absence of the lobby's PC (each at its next attempt).
    await r.mend('a');
    await r.mend('b');
    expect(back.sort()).toEqual(['a quiet', 'b quiet']);
    expect(left).toEqual([]);
    expect(client(r, 'a').hostAway()).toBeNull();
    // The kept ball end was taken, once, and the next turn is out.
    expect(logged(host).filter((t) => t.startsWith('BALL_END'))).toEqual(['BALL_END(a 77)']);
    expect(logged(host).filter((t) => t === 'PAUSE')).toEqual([]);
    expect(host.state.currentGrant?.grant.player).toBe('h');
    expect(client(r, 'b').log.head()).toEqual(host.log.head());
    expect(r.lobby('b').match).toMatchObject({ matchId: 'JHDFEF-1', state: 'game' });
    expect(r.lobby('b').stances).toEqual(host.members().map((m) => ({ playerId: m.playerId, stance: m.playerId === 'b' ? 'watch' : 'play' })));

    // The match goes on to its result, and the lobby to its next match: the numbering goes on.
    await playGame(r);
    expect(r.results['a']?.at(-1)?.result.entries.map((e) => [e.playerId, e.score]).sort()).toEqual([
      ['a', 77],
      ['h', 101],
    ]);
    expect(host.endMatch()).toBe(true);
    await flush();
    expect(host.startMatch(['h', 'a'])).toBe(true);
    await flush();
    expect(host.openMatch()?.matchId).toBe('JHDFEF-2');
  });

  it("during its own ball: its own grant is issued again under a new number, so the ball its table ended while Castcade was closed has a live grant to be reported for; the members get that entry when they are back", async () => {
    const { r, disk, watch } = await saved(['a']);
    r.host.startMatch(['h', 'a']);
    await flush();
    const first = r.host.state.currentGrant?.grant;
    expect(first).toMatchObject({ player: 'h', ballNumber: 1 });
    const host = await restart(r, disk, watch);
    const grants: number[] = [];
    host.on('grant', (g) => grants.push(g.grantSeq));
    host.runAfterRestore();
    await flush();
    expect(grants).toEqual([(first?.grantSeq ?? 0) + 1]);
    expect(host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 1 });
    // The ball had ended on its table meanwhile: reported now, for the grant that is live.
    host.localBallEnd(350, 'nvram');
    await r.mend('a');
    expect(logged(host).filter((t) => t.startsWith('BALL_END'))).toEqual(['BALL_END(h 350)']);
    expect(client(r, 'a').myGrant).toMatchObject({ player: 'a', ballNumber: 1 });
    expect(client(r, 'a').log.head()).toEqual(host.log.head());
  });

  it('between games: the tally and the RESULT that went out are back, each member gets that RESULT again at its return, and the next game is the next game of the same match', async () => {
    const { r, disk, watch } = await saved(['a', 'b'], { stances: { b: 'watch' } });
    r.host.startMatch(['h', 'a']);
    await flush();
    await playGame(r);
    r.host.requestStart();
    await r.tick(5000);
    await playGame(r, 200);
    expect(r.host.openMatch()).toMatchObject({ matchId: 'JHDFEF-1', game: 2, state: 'between' });
    expect(r.results['a']?.map((x) => x.result.game)).toEqual([1, 2]);
    const sentBefore = r.frames.length;

    const host = await restart(r, disk, watch);
    host.runAfterRestore();
    await flush();
    expect(host.openMatch()).toMatchObject({ matchId: 'JHDFEF-1', game: 2, state: 'between' });
    expect(host.resultOut).toBe(true);
    await r.mend('a');
    await r.mend('b');
    // Both RESULTs of the match are sent again (as every return gets them), and they are the ones that went out.
    const again = r.sent('h', 'a', sentBefore).filter((m) => m.type === 'RESULT');
    expect(again.map((m) => m.type === 'RESULT' && m.payload.game)).toEqual([1, 2]);
    expect(again.map((m) => m.payload)).toEqual(r.results['a']?.map((x) => x.result));
    // The next game: game 3 of the same match; and when the match ends it counts its two games with a result.
    expect(host.requestStart()).toBeNull();
    await r.tick(5000);
    expect(host.openMatch()).toMatchObject({ matchId: 'JHDFEF-1', game: 3, state: 'game' });
    host.endMatch();
    await flush();
    expect(r.events['a']?.at(-1)).toBe('matchEnded 2 abandoned 3');
  });

  it('with no match open: the lobby is back with every place kept, each member returns into it by itself, and the next match is numbered after the ones this lobby has had', async () => {
    const { r, disk, watch } = await saved(['a', 'b'], { stances: { b: 'watch' } });
    r.host.startMatch(['h', 'a']);
    await flush();
    await playGame(r);
    r.host.endMatch();
    await flush();
    expect(r.host.openMatch()).toBeNull();
    expect(disk.log).toEqual([]);
    const members = r.host.members();

    const host = await restart(r, disk, watch);
    host.runAfterRestore();
    expect(host.members()).toEqual(members);
    expect(host.openMatch()).toBeNull();
    expect(host.state.phase).toBe('lobby');
    await r.mend('a');
    await r.mend('b');
    expect(client(r, 'a').hostAway()).toBeNull();
    expect(r.lobby('a')).toMatchObject({ away: [], match: null });
    expect(r.lobby('a').stances?.find((x) => x.playerId === 'b')?.stance).toBe('watch');
    expect(host.startMatch(['a', 'h'])).toBe(true);
    await flush();
    expect(host.openMatch()?.matchId).toBe('JHDFEF-2');
    expect(client(r, 'a').myGrant).toMatchObject({ player: 'a', ballNumber: 1 });
  });

  it("a member who does not come back after the restart is away after the grace, and has the time to return and then the clock, as after any absence of the lobby's PC; one who left before the restart is not in the lobby", async () => {
    const { r, disk, watch } = await saved(['a', 'b', 'c'], { stances: { b: 'watch', c: 'watch' } });
    client(r, 'c').leave();
    await flush();
    expect(r.host.members().map((m) => m.playerId)).toEqual(['h', 'a', 'b']);
    r.host.startMatch(['a', 'h']);
    await flush();
    const host = await restart(r, disk, watch, { returnAllowMs: 200_000 });
    expect(host.members().map((m) => m.playerId)).toEqual(['h', 'a', 'b']);
    const left: string[] = [];
    const removed: string[] = [];
    host.on('peerLeft', (p) => left.push(p));
    host.on('memberRemoved', (p) => removed.push(p));
    // Until this PC says it can be reached again nothing runs: nobody is away, however long it takes. A member
    // who finds it meanwhile is simply back.
    await r.tick(10 * MIN);
    await r.mend('b');
    expect(left).toEqual([]);
    expect(host.state.paused).toBeNull();
    host.runAfterRestore();
    await r.tick(5000);
    // A is up and did not come back: away now, and the game waits for A, which every panel can say.
    expect(left).toEqual(['a']);
    expect(host.state.paused).toEqual({ reason: 'disconnect', player: 'a' });
    expect(r.lobby('b').away).toEqual(['a']);
    await r.tick(200_000 + 3 * MIN - 5000 - 2000);
    expect(host.state.players['a']?.status).toBe('playing');
    await r.tick(2000);
    expect(host.state.players['a']?.status).toBe('forfeit');
    expect(removed).toEqual([]);
  });

  it('what was saved and what is restored have to belong together: a log with no match said to be open, a match with no log, another lobby, a name twice', async () => {
    const { r, disk } = await saved(['a']);
    r.host.startMatch(['h', 'a']);
    await flush();
    const transport = r.taps.get('h');
    if (!transport || !disk.lobby) throw new Error('nothing was saved');
    r.host.close();
    const opts = { transport, keys: r.hostKeys, matchId: 'JHDFEF', ballsPerGame: 1, hostParticipant: { playerId: 'h', displayName: 'H', publicKey: r.hostKeys.publicKeyB64, rig: 'pc' as const }, hostGame: TABLE, clock: r.clock, lobby: {} };
    const withLog = (): Session => new Session({ transport, keys: r.hostKeys, clock: r.clock, log: MatchLog.fromJSON(disk.log) });
    const empty = (): Session => new Session({ transport, keys: r.hostKeys, clock: r.clock });
    expect(() => HostMatch.restoreLobby({ ...disk.lobby!, match: null }, opts, withLog())).toThrow(/no match is said to be open/);
    expect(() => HostMatch.restoreLobby(disk.lobby!, opts, empty())).toThrow(/its log was not saved/);
    expect(() => HostMatch.restoreLobby({ ...disk.lobby!, match: { matchId: 'JHDFEF-9', results: [] } }, opts, withLog())).toThrow(/the saved log is of JHDFEF-1/);
    expect(() => HostMatch.restoreLobby({ ...disk.lobby!, code: 'OTHERX' }, opts, withLog())).toThrow(/the saved lobby is OTHERX/);
    expect(() => HostMatch.restoreLobby({ ...disk.lobby!, members: [...disk.lobby!.members, ...disk.lobby!.members] }, opts, withLog())).toThrow(/in the saved lobby twice/);
    expect(() => HostMatch.restoreLobby(disk.lobby!, { ...opts, lobby: undefined }, withLog())).toThrow(/the lobby option is off/);
    // And when they do belong together it is a lobby again.
    expect(HostMatch.restoreLobby(disk.lobby!, opts, withLog()).openMatch()?.matchId).toBe('JHDFEF-1');
  });
});

describe("A17 step 8: the counters of the lobby's PC across a restart", () => {
  it('a ceiling is written before the number that passes it counts, and not for every frame', async () => {
    const order: string[] = [];
    const s = new Session({
      transport: { localId: 'h' } as never,
      keys: {} as never,
      seqGuard: {
        step: 10,
        save: (now) => order.push(`save a<=${now.taken['a'] ?? '-'} own<=${now.sent} (a at ${s.lastSeqFrom('a') ?? '-'})`),
      },
    });
    expect(s.checkSeq('a', 5)).toBe(true);
    // The ceiling was written while the count still stood where it was.
    expect(order).toEqual(['save a<=15 own<=0 (a at -)']);
    for (let n = 6; n <= 15; n++) expect(s.checkSeq('a', n)).toBe(true);
    expect(order).toHaveLength(1);
    expect(s.checkSeq('a', 16)).toBe(true);
    expect(order.at(-1)).toBe('save a<=26 own<=0 (a at 15)');
    // A number that is not taken writes nothing; an opening frame's number noted later is written like any other.
    expect(s.checkSeq('a', 16)).toBe(false);
    expect(order).toHaveLength(2);
    s.noteSeq('a', 500);
    expect(order.at(-1)).toBe('save a<=510 own<=0 (a at 16)');
    // This PC's own numbers the same way.
    expect(s.nextSeq()).toBe(1);
    expect(order.at(-1)).toBe('save a<=510 own<=11 (a at 500)');
    for (let n = 0; n < 10; n++) s.nextSeq();
    expect(order).toHaveLength(4);
    expect(s.nextSeq()).toBe(12);
    expect(order).toHaveLength(5);
    expect(s.seqCeilings()).toEqual({ taken: { a: 510 }, sent: 22 });
    // After a restart the counts begin at the ceilings.
    const again = new Session({ transport: { localId: 'h' } as never, keys: {} as never, seqStart: 3, seqGuard: { step: 10, ...s.seqCeilings(), save: () => undefined } });
    expect(again.checkSeq('a', 510)).toBe(false);
    expect(again.checkSeq('a', 511)).toBe(true);
    expect(again.nextSeq()).toBe(23);
    // A row that is gone keeps no ceiling.
    s.dropCeiling('a');
    expect(s.seqCeilings().taken).toEqual({});
  });

  it("nothing the lobby's PC took before the restart is taken after it: a member's earlier RECONNECT, sent again as it was, is refused, whatever was the last thing written; the member's own return is told where the lobby stands, once, and is back above it; the lobby's own frames are numbered above all it sent before", async () => {
    const { r, disk, watch } = await saved(['a', 'b']);
    r.host.startMatch(['a', 'h']);
    await flush();
    // A's link drops and comes back: a RECONNECT of A's that the lobby's PC takes. More frames of A's follow it.
    await r.cut('a');
    await r.mend('a');
    const taken = r.frames.filter((f) => f.by === 'a').map((f) => JSON.parse(f.frame) as AnyMessage);
    const old = taken.filter((m) => m.type === 'RECONNECT').at(-1);
    expect(old).toBeDefined();
    for (let n = 0; n < 5; n++) client(r, 'a').reportState({ ballNumber: 1, score: 100 + n, ballInPlay: true, tilt: false });
    await flush();
    const highestTaken = Math.max(...r.frames.filter((f) => f.by === 'a').map((f) => (JSON.parse(f.frame) as AnyMessage).seq));
    const highestSent = Math.max(...r.frames.filter((f) => f.by === 'h').map((f) => (JSON.parse(f.frame) as AnyMessage).seq));
    // What is on disk is at or above everything that was taken and everything that was used.
    expect(disk.seq.taken['a']).toBeGreaterThanOrEqual(highestTaken);
    expect(disk.seq.sent).toBeGreaterThanOrEqual(highestSent);
    const writes = disk.seqWrites;

    const host = await restart(r, disk, watch);
    const refused: string[] = [];
    const back: string[] = [];
    host.on('reconnectRejected', (x) => refused.push(`${x.playerId} ${x.code}`));
    host.on('reconnected', (x) => back.push(x.playerId));
    host.runAfterRestore();
    await flush();
    const head = host.log.head();
    // The frame the lobby's PC took before the restart arrives again, as it was: its signature is A's, and it is not
    // taken. (The rig's own filter for a link that is down is lifted for the moment the frame arrives.)
    const down = (r.taps.get('h') as unknown as { down: Set<PlayerId> }).down;
    const arrive = async (m: AnyMessage): Promise<void> => {
      down.delete('a');
      r.bus.route('a', 'h', m);
      await flush();
      down.add('a');
    };
    await arrive(old as AnyMessage);
    expect(refused).toEqual(['a stale_seq']);
    expect(back).toEqual([]);
    expect(host.log.head()).toEqual(head);
    expect(host.snapshot().gone).toContain('a');
    // So with every other frame A sent before, whatever its number.
    for (const m of taken.filter((x) => x.type !== 'RECONNECT' && x.type !== 'HELLO')) await arrive(m);
    expect(host.log.head()).toEqual(head);
    expect(back).toEqual([]);

    // A itself comes back: its own count is below where the lobby stands; it is told, goes on above it, and is back.
    await r.mend('a');
    expect(r.events['a']?.filter((e) => e.startsWith('reconnect')).slice(-2)).toEqual(['reconnectRejected stale_seq', 'reconnected 0 quiet']);
    expect(back).toEqual(['a']);
    expect(client(r, 'a').hostAway()).toBeNull();
    // What A sends now is taken (above the ceiling), and its ball end moves the game.
    client(r, 'a').reportBallEnd(90, 'script');
    await flush();
    expect(logged(host).filter((t) => t.startsWith('BALL_END'))).toEqual(['BALL_END(a 90)']);
    // The lobby PC's own frames after the restart are all numbered above everything it sent before, so A, which
    // never restarted and still holds the count of before, takes them: it heard the lobby and the next grant.
    const after = r.frames.filter((f) => f.by === 'h' && (JSON.parse(f.frame) as AnyMessage).seq > highestSent).length;
    const sentAfter = r.frames.filter((f) => f.by === 'h').length - r.frames.filter((f) => f.by === 'h' && (JSON.parse(f.frame) as AnyMessage).seq <= highestSent).length;
    expect(after).toBe(sentAfter);
    expect(after).toBeGreaterThan(0);
    expect(client(r, 'a').state.currentGrant?.grant.player).toBe('h');
    // And the ceilings were written a handful of times in all, not once a frame.
    expect(disk.seqWrites - writes).toBeLessThan(8);
  });

  it("a member's Castcade that started again while the lobby's PC was restarting comes back by its own signed HELLO, numbered from the clock, far above the ceiling", async () => {
    const { r, disk, watch } = await saved(['a']);
    const host = await restart(r, disk, watch);
    host.runAfterRestore();
    const ceiling = disk.seq.taken['a'] ?? 0;
    // The clock a new process starts its numbers from is milliseconds since 1970: no ceiling a step above a count is near it.
    expect(r.clock.now()).toBeGreaterThan(ceiling * 1000);
    expect(host.members().map((m) => m.playerId)).toEqual(['h', 'a']);
  });

  it("A17 step 10: a pick a member made is the lobby's table after the restart, with who made it and what the Castcade VPX build says of it; the lobby PC's own table opened beside it is still no pick; and a default pick is still one", async () => {
    const AFM = { ...TABLE, tableName: 'Attack from Mars', tableHash: 'cd'.repeat(32), romName: 'afm_113b' };
    const CC = { editables: 1203, hash: '00aa11bb22cc33dd' };
    const { r, disk, watch } = await saved(['a']);
    client(r, 'a').pickTable(AFM, CC);
    await flush();
    expect(disk.lobby?.table).toMatchObject({ fixed: true, pickedBy: 'a', byDefault: false, objects: CC });
    const host = await restart(r, disk, watch);
    host.runAfterRestore();
    expect(host.table()).toEqual({ game: { kind: 'vpx', tableName: 'Attack from Mars', tableHash: 'cd'.repeat(32), romName: 'afm_113b', romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '' }, pickedBy: 'a' });
    expect(host.tableObjects()).toEqual(CC);
    // The lobby's PC came back with the table it had before the pick (TABLE): a row with another table, not the pick.
    await r.mend('a');
    expect(r.lobby('a').hostGame?.tableName).toBe('Attack from Mars');
    expect(r.lobby('a').hostTableObjects).toEqual(CC);
    expect(r.lobby('a').tablePickedBy).toBe('a');
    expect(r.lobby('a').otherTable).toContain('h');
    // What its own Castcade says of the table it has open is not the lobby's.
    expect(host.setHostTableObjects({ editables: 5, hash: 'ffffffffffffffff' })).toBe(false);
    expect(host.tableObjects()).toEqual(CC);

    // A lobby whose table was never picked by anyone: after the restart it is still the lobby PC's own by default,
    // so what that PC says of its own table is the lobby's.
    const d = await saved(['a']);
    expect(d.disk.lobby?.table).toMatchObject({ fixed: true, pickedBy: 'h', byDefault: true, objects: null });
    const again = await restart(d.r, d.disk, d.watch);
    again.runAfterRestore();
    expect(again.setHostTableObjects(CC)).toBe(true);
    expect(again.tableObjects()).toEqual(CC);
  });
});
