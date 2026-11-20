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
import { MatchController, type ControllerFeed } from './controller.js';
import { HostMatch, STREAM3D_WAIT_GRACE_MS } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { MemoryBus } from './transport.js';

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const game: GameFingerprint = { kind: 'vpx', tableName: 'MM', tableHash: 'ab'.repeat(32), romName: null, romHash: null, physicsHash: null, recipeVersion: '0.3.1', sidecarHash: null, emulatorVersion: '10.8.0' };
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
  const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'ABCDEF', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, clock });
  const H = seat(host, clock);
  await H.ctl.open();
  const cs: Record<string, { client: ClientMatch; acks: Array<PayloadOf<'HELLO_ACK'>> } & ReturnType<typeof seat>> = {};
  for (const id of clients) {
    const k = generateKeys();
    const client = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: 'ABCDEF', hostId: 'h', clock });
    const acks: Array<PayloadOf<'HELLO_ACK'>> = [];
    client.on('joined', (a) => acks.push(a));
    client.on('roster', (a) => acks.push(a));
    const s = seat(client, clock);
    await s.ctl.open();
    client.join();
    await flush();
    cs[id] = { client, acks, ...s };
  }
  return { bus, clock, host, H, cs, c: cs['c']! };
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

  it('protocol 6 still: the new keys are optional, and a peer that does not know them drops them', () => {
    expect(PROTOCOL_VERSION).toBe(6);
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
  it('a start from the table waits, says so in every lobby with the seconds left, and goes on when the last PC settles', async () => {
    const { host, clock, H, c } = await rig();
    c.client.updateParticipant({ stream3dWaitMs: 30_000 });
    host.updateLocal({ stream3dWaitMs: 45_000 });
    await flush();
    // Before any start: the lobby says what a start would wait for.
    expect(H.line()).toBe('Everyone in? Start a game on your table (or press Start match) · the 3D connection to Krobs is still being made (the start waits for it, 45 s at most)');
    expect(c.line()).toBe('Waiting for Hosty to start a game on the table · the 3D connection to Hosty is still being made (the start waits for it, 45 s at most)');

    H.ctl.feed(gameStart);
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    expect(host.state.phase).toBe('lobby');
    expect(H.ctl.status().wait3d).toEqual({ players: ['h', 'c'], seconds: 45, armed: 'table' });
    expect(H.line()).toBe('The match starts once the 3D connection to Krobs is up, or in 45 s (Start match on the Match tab starts it now; the first turn may then be the 2D video)');
    expect(H.logs).toContain('match: a game started on the table; the match starts once the 3D connection to Krobs is up, 45 s at most (Start match on the Match tab starts it now)');
    // The seconds count down on the panel.
    clock.advance(3_000);
    expect(H.line()).toContain('or in 42 s');
    expect(c.line()).toContain('42 s at most');

    // The host's own connection settles: the client's is still waited for, and the line names what is left of ITS wait.
    host.updateLocal({ stream3dWaitMs: 0 });
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    expect(H.line()).toBe('The match starts once the 3D connection to Krobs is up, or in 27 s (Start match on the Match tab starts it now; the first turn may then be the 2D video)');
    // The client, the only one waited for now, reads its own PC in the line.
    expect(c.line()).toBe("Waiting for Hosty to start a game on the table · this PC's 3D connection is still being made (the start waits for it, 27 s at most)");

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

  it('the limit: a PC that never settles is waited for until its own time is up, then the start goes on', async () => {
    const { host, clock, H, c } = await rig();
    c.client.updateParticipant({ stream3dWaitMs: 45_000 });
    await flush();
    H.ctl.feed(gameStart);
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    clock.advance(45_000 + STREAM3D_WAIT_GRACE_MS - 1);
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    clock.advance(1);
    await flush();
    expect(host.countdownRemaining()).toBe(5_000);
    clock.advance(5_000);
    await flush();
    expect(host.state.phase).toBe('running');
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
    expect(H.ctl.status().wait3d).toEqual({ players: ['c'], seconds: 30, armed: 'tab' });
    expect(H.line()).toBe('The match starts once the 3D connection to Krobs is up, or in 30 s (Start match again starts it now; the first turn may then be the 2D video)');
    expect(H.logs).toContain('match: Start match was pressed; the match starts once the 3D connection to Krobs is up, 30 s at most (Start match again starts it now)');
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
    expect(again.c.ctl.status().wait3d).toEqual({ players: ['h'], seconds: 30, armed: null });
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
    const { host, client, H, c } = await (async () => {
      const r = await rig();
      return { ...r, client: r.c.client };
    })();
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
