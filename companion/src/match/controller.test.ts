/**
 * A6 + C3 (2026-10-30): the MatchController from both seats, driven by the real engine (HostMatch + ClientMatch on a
 * MemoryBus, a ManualClock for every timer) so the engine's own event names and ordering are what is tested, with
 * fakes for the lock, the cue and the media layer. Detector events are fed by hand, the way the witness emits them.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint, ParticipantInfo } from '@castcade/protocol';
import type { MatchMedia, MediaSignalling, MediaStatus, PanelState } from '../media/match-media-types.js';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { isHostRole, MatchController, type ControllerFeed, type CueKind } from './controller.js';
import { HostMatch } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { MemoryBus } from './transport.js';

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const hex = 'ab'.repeat(32);
const game: GameFingerprint = { kind: 'vpx', tableName: 'MM', tableHash: hex, romName: null, romHash: null, physicsHash: null, recipeVersion: '0.3.1', sidecarHash: null, emulatorVersion: '10.8.0' };

function participant(id: string, keys: KeyPair): ParticipantInfo {
  return { playerId: id, displayName: id === 'h' ? 'Hosty' : 'Krobs', publicKey: keys.publicKeyB64, rig: 'vr_headset' };
}

class FakeMedia implements MatchMedia {
  attachedWith: string[] | null = null;
  added: string[] = [];
  removed: string[] = [];
  sending: boolean[] = [];
  panels: PanelState[] = [];
  detached = false;
  attach(_s: MediaSignalling, peers: string[]): Promise<void> {
    this.attachedWith = [...peers];
    return Promise.resolve();
  }
  addPeer(p: string): void {
    this.added.push(p);
  }
  removePeer(p: string): void {
    this.removed.push(p);
  }
  setSending(on: boolean): void {
    if (this.sending[this.sending.length - 1] !== on) this.sending.push(on);
  }
  setPanelState(s: PanelState): void {
    this.panels.push(s);
  }
  setMuted(): void {}
  status(): MediaStatus {
    return { attached: this.attachedWith !== null, sending: this.sending[this.sending.length - 1] ?? false, peers: {}, mic: 'open', captureSource: null, lastError: null };
  }
  onStatus(): () => void {
    return () => undefined;
  }
  frames(): null {
    return null;
  }
  showPanel(): void {}
  detach(): Promise<void> {
    this.detached = true;
    return Promise.resolve();
  }
  get panel(): PanelState {
    const p = this.panels[this.panels.length - 1];
    if (!p) throw new Error('no panel pushed');
    return p;
  }
}

interface Seat {
  ctl: MatchController;
  locks: ('lock' | 'unlock')[];
  cues: CueKind[];
  media: FakeMedia;
  logs: string[];
}

function seat(role: HostMatch | ClientMatch, clock: ManualClock, ballsPerGame?: number): Seat {
  const locks: Seat['locks'] = [];
  const cues: CueKind[] = [];
  const media = new FakeMedia();
  const logs: string[] = [];
  const ctl = new MatchController({
    role,
    localId: role.localId,
    lock: { lock: () => locks.push('lock'), unlock: () => locks.push('unlock') },
    cue: { play: (k) => cues.push(k) },
    media,
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    log: (l) => logs.push(l),
    ballsPerGame,
  });
  return { ctl, locks, cues, media, logs };
}

async function rig(balls = 3, clientGame: GameFingerprint = game) {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const ck = generateKeys();
  const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'ABCDEF', ballsPerGame: balls, hostParticipant: participant('h', hk), hostGame: game, clock });
  const client = new ClientMatch({ transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game: clientGame, throwdownCode: 'ABCDEF', hostId: 'h', clock });
  const H = seat(host, clock, balls);
  const C = seat(client, clock);
  await H.ctl.open();
  await C.ctl.open();
  client.join();
  await flush();
  return { bus, clock, host, client, H, C };
}

const scores = (s: number): ControllerFeed => ({ kind: 'current_scores', t: 0, scores: [s], player: 1, ball: 1 });
const ballEnd = (ball: number, extraBalls = 0): ControllerFeed => ({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls });
const gameEnd = (s: number): ControllerFeed => ({ kind: 'game_end', t: 0, scores: [s], players: 1 });

describe('MatchController', () => {
  it('picks the role methods by shape', () => {
    const bus = new MemoryBus();
    const k = generateKeys();
    const h = new HostMatch({ transport: bus.transport('h'), keys: k, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', k), hostGame: game });
    const c = new ClientMatch({ transport: bus.transport('c'), keys: k, participant: participant('c', k), game, throwdownCode: 'M' });
    expect(isHostRole(h)).toBe(true);
    expect(isHostRole(c)).toBe(false);
  });

  it('a 2-player 3-ball match from both seats: lock, cues, BALL_END after the bonus or 2 s, GAME_OVER folded into the last ball, RESULT', async () => {
    const { clock, host, client, H, C } = await rig(3);

    // Lobby: the panel is up before the match (media attached with no peers), nothing locked.
    expect(H.media.attachedWith).toEqual([]);
    expect(C.media.attachedWith).toEqual([]);
    expect(H.media.panel).toMatchObject({ phase: 'idle', message: 'Everyone in? Press Start match', ballsPerGame: 3 });
    expect(C.media.panel).toMatchObject({ phase: 'idle', message: 'Waiting for the host to start' });
    expect(H.media.panel.players.map((p) => p.name)).toEqual(['Hosty', 'Krobs']);
    expect(H.locks).toEqual([]);
    expect(C.ctl.status().locked).toBe(false);

    const stateSeen: number[] = [];
    client.on('state', (m) => stateSeen.push(m.payload.score));

    // Start: the host locks at MATCH_READY and unlocks at once for its own ball 1; the client locks.
    host.start();
    await flush();
    expect(H.locks).toEqual(['lock', 'unlock']);
    expect(H.cues).toEqual(['your_turn']);
    expect(H.media.sending).toEqual([true]);
    expect(H.media.panel).toMatchObject({ phase: 'playing', myTurn: true, playerUp: 'h', ball: 1, message: 'Press Start on the table to begin your game' });
    expect(H.media.added).toEqual(['c']);
    expect(C.locks).toEqual(['lock']);
    expect(C.cues).toEqual(['opponent_turn']);
    expect(C.media.added).toEqual(['h']);
    expect(C.media.panel).toMatchObject({ myTurn: false, playerUp: 'h', ball: 1 });

    // Host ball 1: scores stream as STATE; the ball end waits for the bonus score.
    H.ctl.feed({ kind: 'game_start', t: 0, players: 1 });
    H.ctl.feed(scores(1000));
    await flush();
    expect(stateSeen).toEqual([1000]);
    expect(C.media.panel.players.find((p) => p.id === 'h')?.score).toBe(1000);
    H.ctl.feed(ballEnd(1));
    expect(H.ctl.status().locked).toBe(false); // still settling
    H.ctl.feed(scores(1500));
    expect(H.ctl.status().locked).toBe(true);
    expect(H.locks).toEqual(['lock', 'unlock', 'lock']);
    expect(H.media.sending).toEqual([true, false]);
    expect(host.state.players['h']).toMatchObject({ ballsPlayed: 1, score: 1500 });
    await flush();

    // Client ball 1: a verified grant unlocks it; no score after the ball end, so the 2 s settle sends it.
    expect(C.locks).toEqual(['lock', 'unlock']);
    expect(C.cues).toEqual(['opponent_turn', 'your_turn']);
    expect(C.media.sending).toEqual([true]);
    expect(H.cues).toEqual(['your_turn', 'opponent_turn']);
    C.ctl.feed(scores(2000));
    C.ctl.feed(ballEnd(1));
    clock.advance(1999);
    await flush();
    expect(C.ctl.status().locked).toBe(false);
    expect(host.state.players['c']?.ballsPlayed).toBe(0);
    clock.advance(1);
    expect(C.ctl.status().locked).toBe(true);
    expect(C.media.sending).toEqual([true, false]);
    await flush();
    expect(host.state.players['c']).toMatchObject({ ballsPlayed: 1, score: 2000 });

    // Ball 2 for both.
    expect(H.ctl.status()).toMatchObject({ locked: false, myTurn: true });
    H.ctl.feed(scores(3000));
    H.ctl.feed(ballEnd(2));
    H.ctl.feed(scores(3100));
    await flush();
    C.ctl.feed(scores(2500));
    C.ctl.feed(ballEnd(2));
    C.ctl.feed(scores(2600));
    await flush();
    expect(host.state.players['h']).toMatchObject({ ballsPlayed: 2, score: 3100 });
    expect(host.state.players['c']).toMatchObject({ ballsPlayed: 2, score: 2600 });

    // Ball 3: the detector's ball_end and game_end land together; the game_end's score is the final one and no
    // GAME_OVER goes out (the last BALL_END already finished the game).
    const gameOvers: string[] = [];
    host.on('gameOver', (m) => gameOvers.push(m.from));
    H.ctl.feed(scores(4000));
    H.ctl.feed(ballEnd(3));
    H.ctl.feed(gameEnd(4200));
    await flush();
    expect(host.state.players['h']).toMatchObject({ ballsPlayed: 3, score: 4200, status: 'finished' });
    expect(H.media.panel.message).toBe('Your game is over; the others are still playing');
    C.ctl.feed(scores(5000));
    C.ctl.feed(ballEnd(3));
    C.ctl.feed(gameEnd(5100));
    await flush();
    expect(gameOvers).toEqual([]);
    expect(host.state.phase).toBe('ended');

    // RESULT on both seats: unlocked, the chord, standings best first.
    for (const s of [H, C]) {
      expect(s.ctl.status().phase).toBe('over');
      expect(s.ctl.status().locked).toBe(false);
      expect(s.cues[s.cues.length - 1]).toBe('match_over');
      expect(s.media.panel).toMatchObject({
        phase: 'over',
        playerUp: null,
        result: [
          { id: 'c', name: 'Krobs', score: 5100, place: 1 },
          { id: 'h', name: 'Hosty', score: 4200, place: 2 },
        ],
      });
    }
    expect(H.locks).toEqual(['lock', 'unlock', 'lock', 'unlock', 'lock', 'unlock', 'lock', 'unlock']);
    expect(C.locks).toEqual(['lock', 'unlock', 'lock', 'unlock', 'lock', 'unlock', 'lock', 'unlock']);
    expect(H.cues).toEqual(['your_turn', 'opponent_turn', 'your_turn', 'opponent_turn', 'your_turn', 'opponent_turn', 'match_over']);
    expect(C.cues).toEqual(['opponent_turn', 'your_turn', 'opponent_turn', 'your_turn', 'opponent_turn', 'your_turn', 'match_over']);

    await H.ctl.close();
    expect(H.media.detached).toBe(true);
  });

  it('shoot again: BALL_END with shootAgain, the same ball is granted again and unlocks at once', async () => {
    const { host, H } = await rig(3);
    const ballEnds: boolean[] = [];
    host.on('ballEnd', (m) => ballEnds.push(m.payload.shootAgain));
    host.start();
    await flush();
    H.ctl.feed(scores(800));
    H.ctl.feed(ballEnd(1, 1));
    H.ctl.feed(scores(900));
    await flush();
    expect(ballEnds).toEqual([true]);
    expect(host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 1, grantSeq: 2 });
    expect(H.locks).toEqual(['lock', 'unlock', 'lock', 'unlock']);
    expect(H.ctl.status()).toMatchObject({ locked: false, myTurn: true });
    expect(H.cues).toEqual(['your_turn', 'your_turn']);
    expect(H.media.sending).toEqual([true, false, true]);
  });

  it('a game that ends before the match does (table set to fewer balls) sends GAME_OVER', async () => {
    const { host, H } = await rig(5);
    host.start();
    await flush();
    H.ctl.feed(scores(100));
    H.ctl.feed(gameEnd(150));
    await flush();
    expect(host.state.players['h']).toMatchObject({ status: 'finished', score: 150, ballsPlayed: 1 });
    expect(H.ctl.status().locked).toBe(true);
  });

  it('table exit during the match forfeits; the other player plays on to the RESULT', async () => {
    const { host, H, C } = await rig(1);
    host.start();
    await flush();
    // The client closes VPX while the host is up.
    C.ctl.feed({ kind: 'table_exit' });
    await flush();
    expect(host.state.players['c']?.status).toBe('forfeit');
    expect(C.ctl.status().locked).toBe(true);
    // A second exit (and later detector events) are ignored.
    C.ctl.feed({ kind: 'game_abandoned', t: 0, scores: [1], player: 1, ball: 1 });
    await flush();
    H.ctl.feed(scores(700));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(gameEnd(750));
    await flush();
    expect(H.ctl.status().phase).toBe('over');
    expect(C.ctl.status()).toMatchObject({ phase: 'over', locked: false });
    expect(C.media.panel.result?.[0]).toMatchObject({ id: 'h', place: 1 });
  });

  it('STATE goes out at most every 100 ms, the last score trailing', async () => {
    const { clock, host, client, H } = await rig(3);
    const seen: number[] = [];
    client.on('state', (m) => seen.push(m.payload.score));
    host.start();
    await flush();
    for (const s of [10, 20, 30, 40, 50]) {
      H.ctl.feed(scores(s));
      clock.advance(15);
    }
    await flush();
    expect(seen).toEqual([10]);
    clock.advance(25);
    await flush();
    expect(seen).toEqual([10, 50]);
  });

  it('ignores detector events while it is not this player\'s ball', async () => {
    const { host, client, C } = await rig(3);
    const states: number[] = [];
    host.on('state', (m) => states.push(m.payload.score));
    host.start();
    await flush();
    C.ctl.feed(scores(999));
    C.ctl.feed(ballEnd(1));
    await flush();
    expect(states).toEqual([]);
    expect(client.state.players['c']?.ballsPlayed).toBe(0);
    expect(C.ctl.status().locked).toBe(true);
  });

  it('flags a participant the host refused for a different fingerprint (advisory)', async () => {
    const other: GameFingerprint = { ...game, tableHash: 'cd'.repeat(32) };
    const { H, C } = await rig(3, other);
    expect(H.ctl.status().tableMismatch).toEqual(['c']);
    C.ctl.noteTableMismatch('c', ['tableHash']);
    expect(C.media.panel.message).toBe('different table file: you');
    expect(H.media.panel.message).toBe('different table file: c');
  });

  it('close() unlocks a locked table and detaches media', async () => {
    const { host, C } = await rig(3);
    host.start();
    await flush();
    expect(C.ctl.status().locked).toBe(true);
    await C.ctl.close();
    expect(C.locks).toEqual(['lock', 'unlock']);
    expect(C.media.detached).toBe(true);
  });
});
