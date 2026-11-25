/**
 * A17 step 7 (2026-11-25, the review of PR 136): the MatchController in a lobby, from both seats, driven by the real
 * engines with the lobby option on (a MemoryBus, a ManualClock for every timer), as `controller.test.ts` drives the
 * plain match. What is here is what one controller keeps from one game, and from one match, to the next: the table
 * game of a player who gave up, and the flags of a match that is over.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint, ParticipantInfo } from '@castcade/protocol';
import type { MatchMedia, MediaStatus, PanelState } from '../media/match-media-types.js';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { COUNTDOWN_HELD_MS, MatchController, MIDNIGHT_LINE_MS, type ControllerFeed } from './controller.js';
import { HostMatch } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { MemoryBus } from './transport.js';

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const hex = 'ab'.repeat(32);
const game: GameFingerprint = { kind: 'vpx', tableName: 'MM', tableHash: hex, romName: null, romHash: null, physicsHash: null, recipeVersion: '0.3.1', sidecarHash: null, emulatorVersion: '10.8.0' };
const NAMES: Record<string, string> = { h: 'Owner', c: 'Krobs', d: 'Dana' };
const who = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: NAMES[id] ?? id, publicKey: keys.publicKeyB64, rig: 'vr_headset' });

class FakeMedia implements MatchMedia {
  panels: PanelState[] = [];
  attach(): Promise<void> {
    return Promise.resolve();
  }
  addPeer(): void {}
  removePeer(): void {}
  setSending(): void {}
  setPanelState(s: PanelState): void {
    this.panels.push(s);
  }
  setMuted(): void {}
  status(): MediaStatus {
    return { attached: true, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null };
  }
  onStatus(): () => void {
    return () => undefined;
  }
  frames(): null {
    return null;
  }
  showPanel(): void {}
  detach(): Promise<void> {
    return Promise.resolve();
  }
}

interface Seat {
  ctl: MatchController;
  /** The lock as the table has it now. */
  locked: () => boolean;
  logs: string[];
}

function seat(role: HostMatch | ClientMatch, clock: ManualClock): Seat {
  let locked = false;
  const logs: string[] = [];
  const ctl = new MatchController({
    role,
    localId: role.localId,
    lock: { lock: () => void (locked = true), unlock: () => void (locked = false) },
    cue: { play: () => undefined },
    media: new FakeMedia(),
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    log: (l) => logs.push(l),
  });
  return { ctl, locked: () => locked, logs };
}

/** A lobby of the opener `h` and the members named, every one set to Play, a start counting down one second. */
async function lobby(members: string[] = ['c'], balls = 1, graceMs = 0) {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const host = new HostMatch({ disconnectGraceMs: graceMs, transport: bus.transport('h'), keys: hk, matchId: 'ABCDEF', ballsPerGame: balls, hostParticipant: who('h', hk), hostGame: game, clock, lobby: { stance: 'play', countdownMs: 1000 } });
  const seats: Record<string, Seat> = { h: seat(host, clock) };
  await seats['h']!.ctl.open();
  const clients: Record<string, ClientMatch> = {};
  for (const id of members) {
    const k = generateKeys();
    const c = new ClientMatch({ disconnectGraceMs: graceMs, transport: bus.transport(id), keys: k, participant: who(id, k), game, throwdownCode: 'ABCDEF', hostId: 'h', clock, lobby: { stance: 'play' } });
    clients[id] = c;
    seats[id] = seat(c, clock);
    await seats[id]!.ctl.open();
    c.join();
    await flush();
  }
  const tick = async (ms: number): Promise<void> => {
    clock.advance(ms);
    await flush();
  };
  return { bus, clock, host, clients, seats, tick };
}

const start: ControllerFeed = { kind: 'game_start', t: 0, players: 1 };
const scores = (s: number): ControllerFeed => ({ kind: 'current_scores', t: 0, scores: [s], player: 1, ball: 1 });
const ballEnd = (ball: number): ControllerFeed => ({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 });
const gameEnd = (s: number): ControllerFeed => ({ kind: 'game_end', t: 0, scores: [s], players: 1 });
const midnightRan = (from = 3, ball = 1): ControllerFeed => ({ kind: 'midnight_madness', t: 0, audit: 'B.4 31 SPECIAL MODES', from, to: from + 1, player: 1, ball });

/** The seat's ball `ball` ends at `score`: the score, the ball end, the bonus wait. */
async function playBall(r: Awaited<ReturnType<typeof lobby>>, s: Seat, ball: number, score: number): Promise<void> {
  s.ctl.feed(scores(score));
  s.ctl.feed(ballEnd(ball));
  await r.tick(2500);
}

const row = (s: Seat, name: string) => s.ctl.status().lobby?.members.find((m) => m.name === name);

describe("A17 step 7: the controller in a lobby, from one game and one match to the next (the review of PR 136)", () => {
  it('Give up this game with the table\'s game still running: that table game is spent (A16), never a game of one\'s own: the lobby is not told OWN GAME, and the next game starts without waiting for it', async () => {
    const r = await lobby(['c'], 1);
    const { h: H, c: C } = r.seats as { h: Seat; c: Seat };
    expect(H.ctl.requestStart()).toBeNull();
    await r.tick(1000);
    expect(H.ctl.status().phase).toBe('playing');
    H.ctl.feed(start);
    await playBall(r, H, 1, 500);
    H.ctl.feed(gameEnd(500));
    await flush();
    // Krobs is up, starts his table's game, scores, and gives the game up with that table game still running.
    expect(C.ctl.panel()).toMatchObject({ myTurn: true, ball: 1 });
    C.ctl.feed(start);
    C.ctl.feed(scores(50));
    await flush();
    expect(C.ctl.giveUp()).toBe(true);
    await r.tick(100);
    // The game is over (the other player had finished): between games now.
    expect(H.ctl.status().phase).toBe('over');
    expect(C.ctl.status().phase).toBe('over');
    // Krobs is a player of the open match who does not start the next game: his table is locked, and the game on
    // it is the one he gave up. It is not his own game: nothing says OWN GAME, here or on the other PC.
    expect(C.locked()).toBe(true);
    expect(C.ctl.status().ownGame).toBe(false);
    expect(row(H, 'Krobs')?.flags ?? []).not.toContain('own_game');
    expect(row(C, 'Krobs')?.flags ?? []).not.toContain('own_game');
    // A word of the lobby (anybody's Play / Watch) does not make it one either.
    H.ctl.setStance('watch');
    H.ctl.setStance('play');
    await flush();
    expect(C.ctl.status().ownGame).toBe(false);
    expect(row(H, 'Krobs')?.flags ?? []).not.toContain('own_game');

    // The next game is asked for and counts down at once: nothing is waited for.
    expect(H.ctl.requestStart()).toBeNull();
    await flush();
    expect(r.host.announcedStart()).toMatchObject({ waitsFor: null });
    await r.tick(1000);
    expect(H.ctl.status().phase).toBe('playing');
    expect(r.host.state.gameNumber).toBe(2);
    // What the given-up game still says on Krobs' table is nobody's: nothing is reported for it, and its end ends it.
    H.ctl.feed(start);
    await playBall(r, H, 1, 700);
    expect(C.ctl.panel()).toMatchObject({ myTurn: true, ball: 1 });
    C.ctl.feed(scores(80));
    C.ctl.feed(ballEnd(1));
    await r.tick(2500);
    expect(C.ctl.panel()).toMatchObject({ myTurn: true, ball: 1 });
    expect(C.logs.filter((l) => l.includes('BALL_END ball'))).toEqual([]);
    C.ctl.feed(gameEnd(80));
    // The new game on his table is this game's.
    C.ctl.feed(start);
    await playBall(r, C, 1, 300);
    expect(C.logs.filter((l) => l.includes('BALL_END ball'))).toEqual(['match: BALL_END ball 1 score 300']);
  });

  it("a player counted out by the lobby's PC (Play on without them) with their table's game still running: the same, that game is spent and never OWN GAME", async () => {
    const r = await lobby(['c', 'd'], 1);
    const { h: H, c: C, d: D } = r.seats as { h: Seat; c: Seat; d: Seat };
    expect(H.ctl.requestStart()).toBeNull();
    await r.tick(1000);
    H.ctl.feed(start);
    await playBall(r, H, 1, 500);
    H.ctl.feed(gameEnd(500));
    await flush();
    expect(C.ctl.panel()).toMatchObject({ myTurn: true });
    C.ctl.feed(start);
    C.ctl.feed(scores(50));
    await flush();
    // The lobby's PC counts Krobs out of this game (the engine's FORFEIT for him), while his table's game runs.
    r.host.forfeit('c', 'counted out');
    await flush();
    expect(C.ctl.status().ownGame).toBe(false);
    // Dana plays her ball: the game ends.
    expect(D.ctl.panel()).toMatchObject({ myTurn: true });
    D.ctl.feed(start);
    await playBall(r, D, 1, 400);
    D.ctl.feed(gameEnd(400));
    await r.tick(100);
    expect(C.ctl.status().phase).toBe('over');
    expect(C.ctl.status().ownGame).toBe(false);
    expect(row(H, 'Krobs')?.flags ?? []).not.toContain('own_game');
    expect(H.ctl.requestStart()).toBeNull();
    await flush();
    expect(r.host.announcedStart()).toMatchObject({ waitsFor: null });
  });

  it('a game of one\'s own is still said: a watcher who plays alone is OWN GAME until that game ends, and a start that they are in waits for it', async () => {
    const r = await lobby(['c'], 1);
    const { h: H, c: C } = r.seats as { h: Seat; c: Seat };
    // Krobs is not the starter: a game on his table is his own.
    C.ctl.feed(start);
    await flush();
    expect(C.ctl.status().ownGame).toBe(true);
    expect(row(H, 'Krobs')?.flags).toContain('own_game');
    expect(C.locked()).toBe(false);
    expect(H.ctl.requestStart()).toBeNull();
    await flush();
    expect(r.host.announcedStart()).toMatchObject({ waitsFor: 'own_games' });
    C.ctl.feed(gameEnd(10));
    await r.tick(1);
    expect(C.ctl.status().ownGame).toBe(false);
    expect(r.host.announcedStart()).toMatchObject({ waitsFor: null });
  });

  it("the Midnight Madness flags of one match are not the next match's: nothing of match 1 is listed in match 2, and a flag on the same ball of match 2 is taken", async () => {
    const r = await lobby(['c'], 1);
    const { h: H, c: C } = r.seats as { h: Seat; c: Seat };
    // Match 1, game 1: the mode runs on the opener's ball 1.
    expect(H.ctl.requestStart()).toBeNull();
    await r.tick(1000);
    H.ctl.feed(start);
    H.ctl.feed(scores(100));
    H.ctl.feed(midnightRan(3));
    await flush();
    const line = "Midnight Madness ran on Owner's ball 1";
    expect(C.ctl.status().advisories.join(' | ')).toContain(line);
    expect(H.logs.filter((l) => l.includes('Midnight Madness ran on my ball 1 of game 1'))).toHaveLength(1);
    await playBall(r, H, 1, 500);
    H.ctl.feed(gameEnd(500));
    C.ctl.feed(start);
    await playBall(r, C, 1, 300);
    C.ctl.feed(gameEnd(300));
    await r.tick(100);
    expect(H.ctl.status().phase).toBe('over');
    // End match: back in the lobby. Then match 2 at once (inside the time the flag's line stays on a panel).
    expect(H.ctl.requestEnd()).toBeNull();
    await flush();
    expect(H.ctl.status().phase).toBe('lobby');
    expect(MIDNIGHT_LINE_MS).toBeGreaterThan(5000);
    expect(H.ctl.requestStart()).toBeNull();
    await r.tick(1000);
    expect(H.ctl.status().phase).toBe('playing');
    expect(r.host.state.matchId).toBe('ABCDEF-2');
    // Game 1 of match 2: nothing ran, and nothing says it did: not the list, not the panel's line, not the row.
    for (const s of [H, C]) {
      expect(s.ctl.status().advisories.join(' | ')).not.toContain('Midnight Madness ran');
      expect(s.ctl.panel().message ?? '').not.toContain('Midnight Madness ran');
      expect(s.ctl.panel().players.flatMap((p) => p.flags)).not.toContain('midnight');
    }
    // It really runs on the opener's ball 1 of this match: flagged, logged and shown as the first time.
    H.ctl.feed(start);
    H.ctl.feed(scores(100));
    H.ctl.feed(midnightRan(4));
    await flush();
    expect(H.logs.filter((l) => l.includes('Midnight Madness ran on my ball 1 of game 1'))).toHaveLength(2);
    expect(C.ctl.status().advisories.join(' | ')).toContain(line);
  });

  it("a start whose countdown has run out and is held for a player inside the grace of a dropped link says so, a second after it ran out; the member's row says since when they are away once they are", async () => {
    const r = await lobby(['c'], 1, 5000);
    const { h: H } = r.seats as { h: Seat };
    expect(H.ctl.requestStart()).toBeNull();
    await r.tick(400);
    expect(H.ctl.status().lobby?.start).toMatchObject({ line: 'You start the match: you, Krobs', seconds: 1 });
    // Krobs' link drops inside the countdown: inside the grace he is still in the start.
    r.bus.disconnect('c');
    await flush();
    await r.tick(600);
    // The countdown has run out; the start is still announced, and for a second the line is the countdown's own.
    expect(r.host.announcedStart()).not.toBeNull();
    expect(H.ctl.status().phase).toBe('lobby');
    expect(H.ctl.status().lobby?.start).toMatchObject({ line: 'You start the match: you, Krobs', seconds: 0 });
    await r.tick(COUNTDOWN_HELD_MS);
    const held = "You start the match in a few seconds (a player's link dropped a moment ago: waiting to see whether they are back)";
    expect(H.ctl.status().lobby?.start?.line).toBe(held);
    expect(H.ctl.panel().message).toBe(held);
    // A word of the lobby in between (somebody's Play / Watch) does not put the line back.
    H.ctl.setStance('watch');
    H.ctl.setStance('play');
    await r.tick(100);
    expect(H.ctl.status().lobby?.start?.line ?? held).toBe(held);
    // The grace is over: Krobs is away, the start is off, and his row says since when.
    const at = r.clock.now();
    await r.tick(5000);
    expect(H.ctl.status().lobby?.start ?? null).toBeNull();
    const krobs = row(H, 'Krobs');
    expect(krobs?.flags).toContain('away');
    expect(krobs?.awaySince).toBeGreaterThan(at);
    expect(krobs?.awaySince).toBeLessThanOrEqual(r.clock.now());
    expect(row(H, 'Owner')?.awaySince).toBeNull();
  });

  it("the shell lets go of a match's share (`releaseMatch`) while a start that this player is in counts down: the table stays as the lobby's rule has it, and is not unlocked for the moment in between", async () => {
    const r = await lobby(['c'], 1);
    const { h: H, c: C } = r.seats as { h: Seat; c: Seat };
    // No start, no match: a table is its owner's, and releasing changes nothing.
    C.ctl.releaseMatch();
    expect(C.locked()).toBe(false);
    expect(H.ctl.requestStart()).toBeNull();
    await r.tick(300);
    expect(C.locked()).toBe(true);
    expect(H.locked()).toBe(true);
    const unlocks: string[] = [];
    // What the shell's match half does when the match before this start was closed a moment ago.
    C.ctl.releaseMatch();
    H.ctl.releaseMatch();
    if (!C.locked()) unlocks.push('c');
    if (!H.locked()) unlocks.push('h');
    expect(unlocks).toEqual([]);
    // The start goes through as ever: the first player's table is theirs, the other's stays locked.
    await r.tick(700);
    expect(H.ctl.status().phase).toBe('playing');
    expect(H.locked()).toBe(false);
    expect(C.locked()).toBe(true);
  });
});
