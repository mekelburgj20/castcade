/**
 * I11.4.9 (2026-11-20): the first turn of a match starts in 3D. Each PC says whether its 3D connection is still being
 * made (PARTICIPANT_UPDATE `stream3dWaitMs`, the host's own through `updateLocal`); the host lists them for every
 * lobby (HELLO_ACK `stream3dWait`) and the controller holds the start for it, as it holds it for a table that is not
 * open: a start from the table, and the first press of Start match. The real engines on a MemoryBus, a ManualClock for
 * every timer; the machine that decides whether a PC waits is `stream3d.ts` (its own tests).
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint, ParticipantInfo, PayloadOf } from '@castcade/protocol';
import { HelloAck, PROTOCOL_VERSION, ParticipantUpdate } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { FILES_GIVE_3D, MatchController, TABLE_BY_HAND_NOTE, lobbyLineKey, tableObjectsNote, type ControllerFeed } from './controller.js';
import { HostMatch, STREAM3D_WAIT_GRACE_MS } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { MemoryBus } from './transport.js';

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const game: GameFingerprint = { kind: 'vpx', tableName: 'MM', tableHash: 'ab'.repeat(32), romName: null, romHash: null, physicsHash: null, recipeVersion: '0.3.1', sidecarHash: null, emulatorVersion: '10.8.0' };
/** What `gameFingerprintFrom` gives with no table open (match-setup.ts): the host reads it as "still loading". */
const NO_TABLE: GameFingerprint = { ...game, tableName: 'no table open', tableHash: '0'.repeat(64) };
const NAMES: Record<string, string> = { h: 'Hosty', c: 'Krobs', d: 'Chuck' };
const participant = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: NAMES[id] ?? id, publicKey: keys.publicKeyB64, rig: 'vr_headset' });
const gameStart: ControllerFeed = { kind: 'game_start', t: 0, players: 1 };
const scores = (s: number): ControllerFeed => ({ kind: 'current_scores', t: 0, scores: [s], player: 1, ball: 1 });
const ballEnd: ControllerFeed = { kind: 'ball_end', t: 0, player: 1, ball: 1, extraBalls: 0 };

function seat(role: HostMatch | ClientMatch, clock: ManualClock) {
  const logs: string[] = [];
  const ctl = new MatchController({
    role,
    localId: role.localId,
    lock: { lock: () => undefined, unlock: () => undefined },
    cue: { play: () => undefined },
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    log: (l) => logs.push(l),
    ballsPerGame: 1,
  });
  return { ctl, logs, line: () => ctl.panel().message };
}

async function rig(clients: string[] = ['c']) {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'ABCDEF', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy: 'advise', clock });
  const H = seat(host, clock);
  await H.ctl.open();
  const cs: Record<string, { client: ClientMatch; acks: Array<PayloadOf<'HELLO_ACK'>> } & ReturnType<typeof seat>> = {};
  const add = async (id: string, g: GameFingerprint = game): Promise<void> => {
    const k = generateKeys();
    const client = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game: g, throwdownCode: 'ABCDEF', hostId: 'h', clock });
    const acks: Array<PayloadOf<'HELLO_ACK'>> = [];
    client.on('joined', (a) => acks.push(a));
    client.on('roster', (a) => acks.push(a));
    const s = seat(client, clock);
    await s.ctl.open();
    client.join();
    await flush();
    cs[id] = { client, acks, ...s };
  };
  for (const id of clients) await add(id);
  return { bus, clock, host, H, cs, c: cs['c']!, add };
}

describe('the host engine: who is still making a 3D connection (I11.4.9)', () => {
  it("lists what each PC says, for every lobby, with the time left of each PC's own wait; never in the log", async () => {
    const r = await rig(['c', 'd']);
    const { host, clock, c } = r;
    const d = r.cs['d']!;
    expect(host.stream3dWaiting()).toEqual([]);
    expect(c.acks.at(-1)!.stream3dWait).toEqual([]);

    expect(c.client.updateParticipant({ stream3dWaitMs: 30_000 })).toBe(true);
    await flush();
    expect(host.stream3dWaiting()).toEqual([{ playerId: 'c', leftMs: 30_000 }]);
    // Every client hears it, the one that said it and the other.
    expect(c.acks.at(-1)!.stream3dWait).toEqual([{ playerId: 'c', leftMs: 30_000 }]);
    expect(d.acks.at(-1)!.stream3dWait).toEqual([{ playerId: 'c', leftMs: 30_000 }]);

    // The host's own, through updateLocal; a duration, so what is listed later is what is left.
    clock.advance(4_000);
    expect(host.updateLocal({ stream3dWaitMs: 45_000 })).toBe(true);
    await flush();
    expect(host.stream3dWaiting()).toEqual([
      { playerId: 'h', leftMs: 45_000 },
      { playerId: 'c', leftMs: 26_000 },
    ]);
    expect(d.acks.at(-1)!.stream3dWait).toEqual(host.stream3dWaiting());

    // The same estimate said again is not news: no HELLO_ACK goes out for it.
    const before = d.acks.length;
    clock.advance(300);
    expect(host.updateLocal({ stream3dWaitMs: 44_700 })).toBe(false);
    c.client.updateParticipant({ stream3dWaitMs: 25_700 });
    await flush();
    expect(d.acks.length).toBe(before);

    // Settled: 0. The list shrinks for everyone.
    c.client.updateParticipant({ stream3dWaitMs: 0 });
    await flush();
    expect(host.stream3dWaiting().map((x) => x.playerId)).toEqual(['h']);
    expect(d.acks.at(-1)!.stream3dWait.map((x) => x.playerId)).toEqual(['h']);
    host.updateLocal({ stream3dWaitMs: 0 });
    await flush();
    expect(host.stream3dWaiting()).toEqual([]);
    expect(d.acks.at(-1)!.stream3dWait).toEqual([]);

    // None of it is logged, so the log's hash is the same for a peer that does not know the field.
    expect(host.log.length).toBe(0);
    expect(c.client.log.length).toBe(0);
  });

  it('a PC that never says it settled is let go when its own time (and a grace) is up, and the lobby hears of it', async () => {
    const { host, clock, c } = await rig();
    const updated: string[] = [];
    host.on('participantUpdated', (p) => updated.push(p.playerId));
    c.client.updateParticipant({ stream3dWaitMs: 10_000 });
    await flush();
    const n = updated.length;
    clock.advance(10_000);
    // Its time is up; it is still listed, with nothing left, for the grace.
    expect(host.stream3dWaiting()).toEqual([{ playerId: 'c', leftMs: 0 }]);
    clock.advance(STREAM3D_WAIT_GRACE_MS);
    await flush();
    expect(host.stream3dWaiting()).toEqual([]);
    expect(updated.length).toBe(n + 1);
    expect(c.acks.at(-1)!.stream3dWait).toEqual([]);
  });

  it('a player who leaves is not waited for; after the start nothing is, and what a PC says then changes nothing', async () => {
    const r = await rig(['c', 'd']);
    const { host, c } = r;
    c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    r.cs['d']!.client.updateParticipant({ stream3dWaitMs: 30_000 });
    await flush();
    expect(host.stream3dWaiting().map((x) => x.playerId)).toEqual(['c', 'd']);
    r.bus.disconnect('d');
    await flush();
    expect(host.stream3dWaiting().map((x) => x.playerId)).toEqual(['c']);
    // start() is the host's "start now": it does not look at the list.
    host.start();
    await flush();
    expect(host.state.phase).toBe('running');
    expect(host.stream3dWaiting()).toEqual([]);
    expect(c.client.updateParticipant({ stream3dWaitMs: 30_000 })).toBe(false);
    expect(host.updateLocal({ stream3dWaitMs: 30_000 })).toBe(false);
    expect(host.stream3dWaiting()).toEqual([]);
  });

  it("the new keys are optional and bounded, and this build's parser drops a key it does not know (what a 0.2.46 peer does with these two: its schemas are not strict either)", () => {
    // A17 step 7: the version is 7 now; these two keys came in on 6 and did not change it.
    expect(PROTOCOL_VERSION).toBe(7);
    // What a 0.2.46 peer sends: no key at all.
    const key = generateKeys().publicKeyB64;
    const ack = HelloAck.safeParse({ hostPlayerId: 'h', hostPublicKey: key, participants: [] });
    expect(ack.success && ack.data.stream3dWait).toEqual([]);
    const upd = ParticipantUpdate.safeParse({ rig: 'pc' });
    expect(upd.success && 'stream3dWaitMs' in upd.data).toBe(false);
    // What a 0.2.46 peer does with a key it does not know: the schemas are not strict, an unknown key is stripped and
    // the rest of the message is taken (the same parser, a key from the future).
    const future = ParticipantUpdate.safeParse({ rig: 'pc', stream3dWaitMs: 30_000, aKeyFromALaterBuild: true });
    expect(future.success && Object.keys(future.data).sort()).toEqual(['rig', 'stream3dWaitMs']);
    const futureAck = HelloAck.safeParse({ hostPlayerId: 'h', hostPublicKey: key, participants: [], aListFromALaterBuild: [{ playerId: 'c', leftMs: 1 }] });
    expect(futureAck.success && 'aListFromALaterBuild' in futureAck.data).toBe(false);
    // Out of range is refused, as any other field.
    expect(ParticipantUpdate.safeParse({ stream3dWaitMs: -1 }).success).toBe(false);
    expect(ParticipantUpdate.safeParse({ stream3dWaitMs: 120_001 }).success).toBe(false);
  });
});

describe('the controller: the start waits for the 3D connections (I11.4.9)', () => {
  const HELD = 'The match starts once the 3D connection to Krobs is up, or in';
  const NOW_TAB = '(Start match on the Match tab starts it now; the first turn may then be the 2D video)';

  it('a start from the table waits, says so with the seconds left of its one limit, and goes on when the last PC settles', async () => {
    const { host, clock, H, c } = await rig();
    c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    host.updateLocal({ stream3dWaitMs: 45_000 });
    await flush();
    // Before any start: the lobby says what a start would wait for.
    expect(H.line()).toBe('Everyone in? Start a game on your table (or press Start match) · the 3D connection to Krobs is still being made (a start waits for it, 45 s at most)');
    expect(c.line()).toBe('Waiting for Hosty to start a game on the table · the 3D connection to Hosty is still being made (the start waits for it, 45 s at most)');

    H.ctl.feed(gameStart);
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    expect(host.state.phase).toBe('lobby');
    expect(H.ctl.status().wait3d).toEqual({ players: ['h', 'c'], seconds: 45, armed: 'table' });
    expect(H.line()).toBe(`${HELD} 45 s ${NOW_TAB}`);
    expect(H.logs).toContain('match: a game started on the table; the match starts once the 3D connection to Krobs is up, 45 s at most (Start match on the Match tab starts it now)');
    // The seconds count down on the host's panel, toward the one moment the start goes on whatever happens.
    clock.advance(3_000);
    expect(H.line()).toBe(`${HELD} 42 s ${NOW_TAB}`);

    // The host's own connection settles: the client's is still waited for; the limit is the hold's, not a PC's.
    host.updateLocal({ stream3dWaitMs: 0 });
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    expect(H.ctl.status().wait3d).toEqual({ players: ['c'], seconds: 42, armed: 'table' });
    expect(c.line()).toBe("Waiting for Hosty to start a game on the table · this PC's 3D connection is still being made (the start waits for it, 45 s at most)");

    // The client settles: the countdown of a start from the table begins, as it does when the last table opens.
    c.client.updateParticipant({ stream3dWaitMs: 0 });
    await flush();
    expect(host.countdownRemaining()).toBe(5_000);
    expect(H.logs).toContain('match: the 3D connections are settled; the start from the table goes on');
    expect(H.line()).toBe('Starting the match: you, Krobs');
    expect(c.line()).toBe('Starting the match: Hosty, you');
    clock.advance(5_000);
    await flush();
    expect(host.state.phase).toBe('running');
    expect(H.ctl.status()).toMatchObject({ phase: 'playing', wait3d: { players: [], seconds: 0, armed: null } });
  });

  it('D4: while no start is held the lobby line does not change by itself, on the host or a client (a line that counted seconds kept the headset panel up)', async () => {
    const { host, clock, H, c } = await rig();
    c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    host.updateLocal({ stream3dWaitMs: 45_000 });
    await flush();
    const before = [H.line(), c.line(), JSON.stringify(H.ctl.status().wait3d), JSON.stringify(c.ctl.status().wait3d)];
    expect(before[0]).not.toMatch(/\d+ s\b(?! at most)/);
    let changes = 0;
    H.ctl.onChange(() => changes++);
    c.ctl.onChange(() => changes++);
    for (let i = 0; i < 12; i++) {
      clock.advance(1_000);
      await flush(2);
    }
    expect([H.line(), c.line(), JSON.stringify(H.ctl.status().wait3d), JSON.stringify(c.ctl.status().wait3d)]).toEqual(before);
    expect(changes).toBe(0);
    // A held start counts down on the host (the panel stays up for it, as for the countdown); what the headset's lobby
    // peek compares is the line without the number, and that does not change either. A client's line stays as it is.
    H.ctl.feed(gameStart);
    await flush();
    const key = lobbyLineKey(H.line());
    const clientLine = c.line();
    expect(key).toBe(`The match starts once the 3D connection to Krobs is up ${NOW_TAB}`);
    clock.advance(7_000);
    await flush(2);
    expect(H.line()).toBe(`${HELD} 38 s ${NOW_TAB}`);
    expect(lobbyLineKey(H.line())).toBe(key);
    expect(c.line()).toBe(clientLine);
    expect(lobbyLineKey(null)).toBeNull();
    expect(lobbyLineKey('Starting the match: you, Krobs')).toBe('Starting the match: you, Krobs');
  });

  it('D1: one limit on a held start: 45 s after it was first held the match starts, whatever any PC says meanwhile (a PC asking again and again, a player who joins late)', async () => {
    const r = await rig();
    const { host, clock, H, c } = r;
    c.client.updateParticipant({ stream3dWaitMs: 120_000 });
    await flush();
    H.ctl.feed(gameStart);
    await flush();
    expect(H.ctl.status().wait3d).toEqual({ players: ['c'], seconds: 45, armed: 'table' });
    // Every 10 s the client asks for two more minutes; at 30 s a third player joins and asks too.
    for (let s = 10; s <= 40; s += 10) {
      clock.advance(10_000);
      c.client.updateParticipant({ stream3dWaitMs: 120_000 });
      if (s === 30) {
        await r.add('d');
        r.cs['d']!.client.updateParticipant({ stream3dWaitMs: 120_000 });
      }
      await flush();
      // The seconds on the line only ever go down.
      expect(H.ctl.status().wait3d.seconds).toBe(45 - s);
      expect(host.countdownRemaining()).toBeNull();
    }
    expect(H.ctl.status().wait3d.players).toEqual(['c', 'd']);
    clock.advance(4_999);
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    clock.advance(1);
    await flush();
    // The limit: nobody is waited for any more, the countdown of the start from the table runs, and the log says why.
    expect(H.ctl.status().wait3d.players).toEqual([]);
    expect(host.countdownRemaining()).toBe(5_000);
    expect(H.logs).toContain('match: 45 s passed since the start was held for the 3D connections (still being made: Krobs, Chuck); the start from the table goes on, and the first turn may be the 2D video');
    // What a PC says after that changes nothing.
    c.client.updateParticipant({ stream3dWaitMs: 119_000 });
    clock.advance(5_000);
    await flush();
    expect(host.state.phase).toBe('running');
    expect(host.state.playerOrder).toEqual(['h', 'c', 'd']);
  });

  it('D1: a held Start match comes due at the same limit: a PC that said two minutes once and nothing more holds it 45 s, not 122', async () => {
    const { clock, H, c } = await rig();
    c.client.updateParticipant({ stream3dWaitMs: 120_000 });
    await flush();
    expect(H.ctl.holdTabStart()).toBe(true);
    expect(H.ctl.status().wait3d).toEqual({ players: ['c'], seconds: 45, armed: 'tab' });
    clock.advance(44_999);
    await flush();
    expect(H.ctl.status().wait3d).toEqual({ players: ['c'], seconds: 1, armed: 'tab' });
    clock.advance(1);
    await flush();
    // Nobody is waited for and the start is still armed: the shell's cue to start (match-host).
    expect(H.ctl.status().wait3d).toEqual({ players: [], seconds: 0, armed: 'tab' });
  });

  it('nobody is waited for: the start from the table counts down at once, as before', async () => {
    const { host, H } = await rig();
    H.ctl.feed(gameStart);
    await flush();
    expect(host.countdownRemaining()).toBe(5_000);
    expect(H.ctl.status().wait3d).toEqual({ players: [], seconds: 0, armed: null });
  });

  it('Start match: the first press holds the start and says how to start now; the shell starts when the wait is over; a second press starts now', async () => {
    const { host, H, c } = await rig();
    c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    await flush();
    // The first press: held.
    expect(H.ctl.holdTabStart()).toBe(true);
    expect(H.ctl.status().wait3d).toEqual({ players: ['c'], seconds: 45, armed: 'tab' });
    expect(H.line()).toBe(`${HELD} 45 s (Start match again starts it now; the first turn may then be the 2D video)`);
    expect(H.logs).toContain('match: Start match was pressed; the match starts once the 3D connection to Krobs is up, 45 s at most (Start match again starts it now)');
    // The second press is not held: the caller starts.
    expect(H.ctl.holdTabStart()).toBe(false);

    // Settled while held: nobody is waited for and the start is still armed: the shell's cue to start (match-host).
    c.client.updateParticipant({ stream3dWaitMs: 0 });
    await flush();
    expect(H.ctl.status().wait3d).toEqual({ players: [], seconds: 0, armed: 'tab' });
    host.start();
    await flush();
    expect(H.ctl.status()).toMatchObject({ phase: 'playing', wait3d: { players: [], armed: null } });
  });

  it('D3: once a start from the table is held for the 3D connections, ONE press of Start match starts now, as its lobby line says', async () => {
    const { H, c } = await rig();
    c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    await flush();
    H.ctl.feed(gameStart);
    await flush();
    expect(H.line()).toContain('Start match on the Match tab starts it now');
    // Not held: the caller (match-host's start) starts the match.
    expect(H.ctl.holdTabStart()).toBe(false);
    expect(H.ctl.status().wait3d.armed).toBe('table');
    expect(H.logs).toContain('match: Start match was pressed while the start from the table waited for the 3D connections; the match starts now');
  });

  it('D2: a PC whose table is not open yet is listed and does not hold a press of Start match; a start from the table waits for its table, then for its 3D connection', async () => {
    const r = await rig();
    const { host, H } = r;
    await r.add('d', NO_TABLE);
    // Its table was started in the fork and is loading: it says so, with the longest time it may ask for.
    r.cs['d']!.client.updateParticipant({ stream3dWaitMs: 120_000 });
    await flush();
    expect(host.stream3dWaiting().map((x) => x.playerId)).toEqual(['d']);
    expect(host.loading()).toEqual(['d']);
    // Start match is not held for it (before this feature a press started the match, table open or not).
    expect(H.ctl.status().wait3d.players).toEqual([]);
    expect(H.ctl.holdTabStart()).toBe(false);
    // A start from the table waits for the table, as ever.
    H.ctl.feed(gameStart);
    await flush();
    expect(H.line()).toBe("The match starts once Chuck's table is open");
    // The table opens: without another word from that PC the start is now held for its 3D connection (no gap in which
    // the countdown could begin).
    r.cs['d']!.client.updateParticipant({ game });
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    expect(H.ctl.status().wait3d).toEqual({ players: ['d'], seconds: 45, armed: 'table' });
    r.cs['d']!.client.updateParticipant({ stream3dWaitMs: 0 });
    await flush();
    expect(host.countdownRemaining()).toBe(5_000);
  });

  it('D3: a held Start match the shell gives up (a warning or a loading table when it came due, a start that failed) is off, and the next press is not held again: the host has waited once', async () => {
    const { H, c } = await rig();
    c.client.updateParticipant({ stream3dWaitMs: 120_000 });
    await flush();
    expect(H.ctl.holdTabStart()).toBe(true);
    H.ctl.dropTabHold("Chuck's table cannot report ball ends");
    expect(H.ctl.status().wait3d).toEqual({ players: ['c'], seconds: 0, armed: null });
    expect(H.logs).toContain("match: the held Start match is off: Chuck's table cannot report ball ends; the next press of Start match is not held");
    expect(H.line()).toContain('Everyone in? Start a game on your table (or press Start match)');
    // The PC still asks to be waited for; the press the Match tab's message asked for starts all the same.
    expect(H.ctl.holdTabStart()).toBe(false);
    expect(H.ctl.status().wait3d.armed).toBeNull();
  });

  it('a press of Start match while a table is still loading is not held, whoever else is waited for (three players: it would sit there unseen, then end in an error)', async () => {
    const r = await rig();
    const { host, H, c } = r;
    c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    await r.add('d', NO_TABLE);
    await flush();
    expect(host.loading()).toEqual(['d']);
    expect(H.ctl.status().wait3d.players).toEqual(['c']);
    expect(H.line()).toBe("Waiting for Chuck's table to open");
    // Not held: the caller starts as a press did before this wait existed.
    expect(H.ctl.holdTabStart()).toBe(false);
    expect(H.ctl.status().wait3d).toEqual({ players: ['c'], seconds: 0, armed: null });
    expect(H.logs.filter((l) => l.includes('Start match was pressed'))).toEqual([]);
    // The table opens: now a press is held for the PC that is waited for.
    r.cs['d']!.client.updateParticipant({ game });
    await flush();
    expect(H.ctl.holdTabStart()).toBe(true);
  });

  it('the lobby falling below two ends a hold of either kind and its limit: nothing "starts now" with one player, and the next start is held anew for whoever joins', async () => {
    // A start from the table.
    const r = await rig();
    const { host, clock, H, c } = r;
    c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    await flush();
    H.ctl.feed(gameStart);
    await flush();
    expect(H.ctl.status().wait3d.armed).toBe('table');
    r.bus.disconnect('c');
    await flush();
    expect(H.ctl.status().wait3d).toEqual({ players: [], seconds: 0, armed: null });
    expect(H.logs).toContain('match: the start from the table is off: the lobby fell below two players while it waited for the 3D connections (start a game on the table again once somebody has joined)');
    // The old limit passes with one player in the lobby: nothing happens, nothing is said to start.
    clock.advance(46_000);
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    expect(H.logs.filter((l) => l.includes('s passed since the start was held'))).toEqual([]);
    // A minute later a player joins and is still connecting: the next start is held for them, with a whole new limit.
    clock.advance(60_000);
    await r.add('d');
    r.cs['d']!.client.updateParticipant({ stream3dWaitMs: 40_000 });
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    H.ctl.feed(gameStart);
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    expect(H.ctl.status().wait3d).toEqual({ players: ['d'], seconds: 45, armed: 'table' });

    // A held Start match.
    const t = await rig();
    t.c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    await flush();
    expect(t.H.ctl.holdTabStart()).toBe(true);
    t.bus.disconnect('c');
    await flush();
    expect(t.H.logs).toContain('match: the held Start match is off: the lobby fell below two players');
    t.clock.advance(46_000);
    await t.add('d');
    t.cs['d']!.client.updateParticipant({ stream3dWaitMs: 40_000 });
    await flush();
    expect(t.H.ctl.status().wait3d).toEqual({ players: ['d'], seconds: 0, armed: null });
    expect(t.H.ctl.holdTabStart()).toBe(true);
    expect(t.H.ctl.status().wait3d).toEqual({ players: ['d'], seconds: 45, armed: 'tab' });
  });

  it("the limit's log line says what happens: a start from the table that then waits for a table says so, and does not say the match starts", async () => {
    const r = await rig();
    const { host, clock, H, c } = r;
    c.client.updateParticipant({ stream3dWaitMs: 120_000 });
    await flush();
    H.ctl.feed(gameStart);
    await flush();
    // A third player joins during the hold, their table not open yet.
    clock.advance(20_000);
    await r.add('d', NO_TABLE);
    await flush();
    clock.advance(25_000);
    await flush();
    expect(H.logs).toContain("match: 45 s passed since the start was held for the 3D connections (still being made: Krobs); the start from the table now waits for Chuck's table to open");
    expect(H.logs.filter((l) => l.includes('the match starts now'))).toEqual([]);
    expect(host.countdownRemaining()).toBeNull();
    expect(H.line()).toBe("The match starts once Chuck's table is open");
    // The table opens: the start goes on at once (the hold's limit has passed: nobody is waited for again).
    r.cs['d']!.client.updateParticipant({ game });
    await flush();
    expect(host.countdownRemaining()).toBe(5_000);
    // A held Start match at its limit: the line says it comes due (the shell starts it or gives it up, and logs which).
    const t = await rig();
    t.c.client.updateParticipant({ stream3dWaitMs: 120_000 });
    await flush();
    expect(t.H.ctl.holdTabStart()).toBe(true);
    t.clock.advance(45_000);
    await flush();
    expect(t.H.logs).toContain('match: 45 s passed since the start was held for the 3D connections (still being made: Krobs); the held Start match comes due');
  });

  it('Start match with nobody waited for is never held; a held start is dropped when the lobby falls below two', async () => {
    const r = await rig();
    expect(r.H.ctl.holdTabStart()).toBe(false);
    r.c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    await flush();
    expect(r.H.ctl.holdTabStart()).toBe(true);
    r.bus.disconnect('c');
    await flush();
    expect(r.H.ctl.status().wait3d).toEqual({ players: [], seconds: 0, armed: null });
    // A client is never the one to hold a start.
    const again = await rig();
    again.host.updateLocal({ stream3dWaitMs: 30_000 });
    await flush();
    expect(again.c.ctl.holdTabStart()).toBe(false);
    expect(again.c.ctl.status().wait3d).toEqual({ players: ['h'], seconds: 0, armed: null });
  });

  it("the host's start() during the wait starts at once (the manual way out), and the wait is gone for everyone", async () => {
    const { host, H, c } = await rig();
    c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    await flush();
    H.ctl.feed(gameStart);
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    host.start();
    await flush();
    expect(host.state.phase).toBe('running');
    expect(H.ctl.status()).toMatchObject({ phase: 'playing', wait3d: { players: [], armed: null } });
    expect(c.ctl.status()).toMatchObject({ phase: 'playing', wait3d: { players: [], armed: null } });
  });

  it('only the first start: a next game starts from the table at once, whatever a PC says about its 3D connection', async () => {
    const { host, H, c } = await rig();
    const client = c.client;
    host.start();
    await flush();
    // Game 1, one ball each.
    H.ctl.feed(gameStart);
    H.ctl.feed(scores(500));
    H.ctl.feed(ballEnd);
    H.ctl.feed(scores(500));
    await flush();
    c.ctl.feed(gameStart);
    c.ctl.feed(scores(800));
    c.ctl.feed(ballEnd);
    c.ctl.feed(scores(800));
    await flush();
    expect(H.ctl.status().phase).toBe('over');
    // Between the games a PC says its 3D connection is being made (a fork restarted, say): nobody is listed.
    expect(client.updateParticipant({ stream3dWaitMs: 30_000 })).toBe(false);
    expect(host.updateLocal({ stream3dWaitMs: 30_000 })).toBe(false);
    expect(host.stream3dWaiting()).toEqual([]);
    expect(H.ctl.holdTabStart()).toBe(false);
    H.ctl.feed(gameStart);
    await flush();
    expect(host.state.gameNumber).toBe(2);
    expect(H.ctl.status()).toMatchObject({ phase: 'playing', wait3d: { players: [], armed: null } });
  });
});

describe('what the lobby says about 3D before the start (I11.4.11, I11.4.12, I11.4.15)', () => {
  /** The same table in another file: only the hash differs (a re-save, a modified copy). */
  const OTHER_FILE: GameFingerprint = { ...game, tableHash: 'cd'.repeat(32) };

  it('I11.4.15: two different files of the table: the bytes alone say nothing of 3D; where both VPX name the same table objects the table line says 3D works, on both PCs, before the start; where they do not, the lobby note says so with the name', async () => {
    const r = await rig([]);
    await r.add('c', OTHER_FILE);
    const { H } = r;
    const c = r.cs['c']!;
    // The difference is named, and nothing is said of 3D while nothing is known (I11.4.11 warned here, wrongly on two
    // tables of two on 2026-11-23: other bytes, the same table objects, 3D ran).
    expect(H.line()).toBe('same table, different file (a re-save or another download): Krobs');
    expect(c.line()).toBe('same table, different file (a re-save or another download): you');
    // Both VPX are the Castcade build and name the same table objects (the shell's word, from the stream's decision).
    H.ctl.setFilesGive3d(true);
    c.ctl.setFilesGive3d(true);
    expect(H.line()).toBe(`same table, different file (a re-save or another download): Krobs · ${FILES_GIVE_3D}`);
    expect(c.line()).toBe(`same table, different file (a re-save or another download): you · ${FILES_GIVE_3D}`);
    expect(FILES_GIVE_3D).toBe('3D works all the same: the files hold the same table objects');
    // The other case: the two tables hold other objects. Said by the shell's note, which names who it is about.
    H.ctl.setFilesGive3d(false);
    H.ctl.setLobbyNote(tableObjectsNote(['Krobs']));
    expect(H.line()).toBe('same table, different file (a re-save or another download): Krobs · Not in 3D with Krobs: the two table files do not hold the same table objects, so their turns are shown as the flat video');
    expect(tableObjectsNote(null)).toBe('Not in 3D with the host: the two table files do not hold the same table objects, so their turns are shown as the flat video');
    expect(tableObjectsNote(['Krobs', 'Chuck'])).toContain('Not in 3D with Krobs, Chuck:');
    // Once the match runs the table line is what it always was (the turn prompts need the room).
    r.host.start();
    await flush();
    expect(H.line()).not.toContain('3D');
    expect(c.line()).not.toContain('3D');
    // The identical file: nothing is said at all.
    const same = await rig();
    same.H.ctl.setFilesGive3d(true);
    expect(same.H.line()).toBe('Everyone in? Start a game on your table (or press Start match)');
  });

  it("I11.4.12: the shell's note (a table Castcade did not start) rides on the lobby line of that PC, does not change by itself, and goes when it no longer applies or the match starts", async () => {
    const { host, clock, H, c } = await rig();
    c.ctl.setLobbyNote(TABLE_BY_HAND_NOTE);
    expect(c.line()).toBe(`Waiting for Hosty to start a game on the table · ${TABLE_BY_HAND_NOTE}`);
    expect(TABLE_BY_HAND_NOTE).toBe('Not in 3D: this table is not running in the Castcade VPX build. For 3D it has to be started again by Castcade: close VPX, then open or join a lobby again');
    // Only on the PC it is about.
    expect(H.line()).toBe('Everyone in? Start a game on your table (or press Start match)');
    let changes = 0;
    c.ctl.onChange(() => changes++);
    clock.advance(20_000);
    await flush(2);
    expect(changes).toBe(0);
    // The same word again is no change; taking it away is one.
    c.ctl.setLobbyNote(TABLE_BY_HAND_NOTE);
    expect(changes).toBe(0);
    c.ctl.setLobbyNote(null);
    expect(changes).toBe(1);
    expect(c.line()).toBe('Waiting for Hosty to start a game on the table');
    // On the host too, with whatever else its line says; not over the countdown, not in the match.
    H.ctl.setLobbyNote(TABLE_BY_HAND_NOTE);
    expect(H.line()).toBe(`Everyone in? Start a game on your table (or press Start match) · ${TABLE_BY_HAND_NOTE}`);
    H.ctl.feed(gameStart);
    await flush();
    expect(H.line()).toBe('Starting the match: you, Krobs');
    clock.advance(5_000);
    await flush();
    expect(host.state.phase).toBe('running');
    expect(H.line() ?? '').not.toContain('not running in the Castcade VPX build');
  });
});
