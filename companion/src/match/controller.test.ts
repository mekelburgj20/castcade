/**
 * A6 + C3 (2026-10-30): the MatchController from both seats, driven by the real engine (HostMatch + ClientMatch on a
 * MemoryBus, a ManualClock for every timer) so the engine's own event names and ordering are what is tested, with
 * fakes for the lock, the cue and the media layer. Detector events are fed by hand, the way the witness emits them.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint, ParticipantInfo } from '@castcade/protocol';
import type { MatchMedia, MediaSignalling, MediaStatus, PanelState } from '../media/match-media-types.js';
import { headerText } from '../media/panel-page.js';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { DEFAULT_VR_VIEW, isHostRole, MatchController, mismatchWords, vrViewMode, type ControllerFeed, type CueKind, type MatchControllerOptions } from './controller.js';
import { HostMatch } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { MemoryBus } from './transport.js';
import { WsPeerTransport } from './transport-ws.js';

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
  lastError: string | null = null;
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
    return { attached: this.attachedWith !== null, sending: this.sending[this.sending.length - 1] ?? false, peers: {}, mic: 'open', captureSource: null, lastError: this.lastError };
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

function seat(role: HostMatch | ClientMatch, clock: ManualClock, ballsPerGame?: number, extra: Partial<MatchControllerOptions> = {}): Seat {
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
    ...extra,
  });
  return { ctl, locks, cues, media, logs };
}

async function rig(balls = 3, clientGame: GameFingerprint = game, fingerprintPolicy?: 'refuse' | 'advise') {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const ck = generateKeys();
  const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'ABCDEF', ballsPerGame: balls, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy, clock });
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
    expect(H.media.panel).toMatchObject({ phase: 'idle', message: 'Everyone in? Start a game on your table (or press Start match)', ballsPerGame: 3 });
    expect(C.media.panel).toMatchObject({ phase: 'idle', message: 'Waiting for Hosty to start a game on the table' });
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

    // RESULT on both seats: the chord, standings best first. A10: the host's table is unlocked (its next game_start
    // starts game 2), the client's stays locked until game 2's grant or the end of the match.
    for (const s of [H, C]) {
      expect(s.ctl.status().phase).toBe('over');
      expect(s.ctl.status().locked).toBe(s === C);
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
    expect(C.locks).toEqual(['lock', 'unlock', 'lock', 'unlock', 'lock', 'unlock', 'lock']);
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
    // A10: a game's RESULT is not the end of the match: the client's table stays locked until the next game or the end.
    expect(C.ctl.status()).toMatchObject({ phase: 'over', locked: true });
    expect(H.ctl.status()).toMatchObject({ phase: 'over', locked: false });
    expect(C.media.panel.result?.[0]).toMatchObject({ id: 'h', place: 1 });
    expect(H.ctl.endMatch()).toBe(true);
    await flush();
    expect(C.ctl.status()).toMatchObject({ phase: 'over', locked: false, series: { over: true } });
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

  it('a different table file is advisory: an `advise` host accepts it and both panels flag it (alpha-match.md §3)', async () => {
    const other: GameFingerprint = { ...game, tableHash: 'cd'.repeat(32) };
    const { H, C } = await rig(3, other, 'advise');
    expect(H.ctl.status().tableMismatch).toEqual(['c']);
    // The client learns it from HELLO_ACK's hostGame, with nobody telling its controller by hand.
    expect(C.ctl.status().tableMismatch).toEqual(['c']);
    // The same name in another file (D2.5, 2026-10-31): said so.
    expect(C.media.panel.message).toBe('same table, different file (a re-save or another download): you');
    expect(H.media.panel.message).toBe('same table, different file (a re-save or another download): Krobs');
    for (const seat of [H, C]) expect(seat.media.panel.players.find((p) => p.id === 'c')?.flags).toEqual(['table_mismatch']);
    expect(H.media.panel.players.find((p) => p.id === 'h')?.flags).toEqual([]);
  });

  describe('D2.5 (2026-10-31): the wording follows the fields that differ', () => {
    it('mismatchWords: another name or recipe → different table file; the hash alone → same table, different file; the build is its own note', () => {
      expect(mismatchWords(['tableHash'])).toEqual({ table: 'same table, different file (a re-save or another download)', build: null });
      expect(mismatchWords(['tableName', 'tableHash'])).toEqual({ table: 'different table file', build: null });
      expect(mismatchWords(['recipeVersion', 'sidecarHash'])).toEqual({ table: 'different table file', build: null });
      expect(mismatchWords(['romHash'])).toEqual({ table: 'different table setup', build: null });
      expect(mismatchWords(['emulatorVersion'])).toEqual({ table: null, build: 'different VPX build' });
      expect(mismatchWords(['emulatorVersion', 'tableHash'])).toEqual({ table: 'same table, different file (a re-save or another download)', build: 'different VPX build' });
      expect(mismatchWords([])).toEqual({ table: null, build: null });
    });

    it('another table name: "different table file", flagged table_mismatch', async () => {
      const { H, C } = await rig(3, { ...game, tableName: 'Monster Bash', tableHash: 'cd'.repeat(32) }, 'advise');
      expect(H.media.panel.message).toBe('different table file: Krobs');
      expect(C.media.panel.message).toBe('different table file: you');
      expect(H.media.panel.players.find((p) => p.id === 'c')?.flags).toEqual(['table_mismatch']);
      expect(H.ctl.status()).toMatchObject({ tableMismatch: ['c'], mismatches: { c: ['tableName', 'tableHash'] } });
    });

    it('the same table on another VPX build (the second match: 10.8.0.2078.Panasony vs 10.8.0.2058.800a99c): build_mismatch only, no table line', async () => {
      const { H, C } = await rig(3, { ...game, emulatorVersion: '10.8.0.2058.800a99c' }, 'advise');
      for (const seat of [H, C]) {
        expect(seat.media.panel.players.find((p) => p.id === 'c')?.flags).toEqual(['build_mismatch']);
        expect(seat.ctl.status().tableMismatch).toEqual([]);
        expect(seat.media.panel.message ?? '').not.toMatch(/different|build/);
      }
      expect(H.ctl.status().mismatches).toEqual({ c: ['emulatorVersion'] });
    });

    it('both: the table line and the build flag', async () => {
      const { H } = await rig(3, { ...game, tableHash: 'cd'.repeat(32), emulatorVersion: '10.8.0.2058.800a99c' }, 'advise');
      expect(H.media.panel.message).toBe('same table, different file (a re-save or another download): Krobs');
      expect(H.media.panel.players.find((p) => p.id === 'c')?.flags).toEqual(['table_mismatch', 'build_mismatch']);
      expect(H.ctl.status().tableMismatch).toEqual(['c']);
    });
  });

  it('a `refuse` host (the engine default) keeps the different table out, and flags nobody', async () => {
    const other: GameFingerprint = { ...game, tableHash: 'cd'.repeat(32) };
    const { H, client } = await rig(3, other);
    expect(client.refused?.code).toBe('fingerprint_mismatch');
    expect(H.ctl.status().tableMismatch).toEqual([]);
    expect(H.ctl.status().participants.map((p) => p.playerId)).toEqual(['h']);
  });

  it("the media layer's last error fills the panel's message line only when the match has nothing to say", async () => {
    const { host, H, C } = await rig(3);
    C.media.lastError = 'no VPX window to send: open the table in VR with VRPreview on';
    C.ctl.refresh();
    expect(C.media.panel.message).toBe('Waiting for Hosty to start a game on the table');
    host.start();
    await flush();
    expect(C.media.panel.message).toBe('no VPX window to send: open the table in VR with VRPreview on');
    H.media.lastError = 'the match panel did not start; video and voice are off';
    H.ctl.refresh();
    // The host holds ball 1 and has not started its game: that hint wins over the media error.
    expect(H.media.panel.message).toBe('Press Start on the table to begin your game');
    C.media.lastError = null;
    C.ctl.refresh();
    expect(C.media.panel.message).toBeNull();
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

describe('A8 (2026-10-31): the alpha build\'s gaps', () => {
  it("3 players, one with another table file: the OTHER client's controller flags it too (HELLO_ACK.tableMismatches)", async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy: 'advise', clock });
    const H = seat(host, clock, 3);
    await H.ctl.open();
    const mk = (id: string, g: GameFingerprint): Seat => {
      const k = generateKeys();
      const p = { ...participant(id, k), displayName: id };
      const c = new ClientMatch({ transport: bus.transport(id), keys: k, participant: p, game: g, throwdownCode: 'M', hostId: 'h', clock });
      const s = seat(c, clock);
      c.join();
      return s;
    };
    const A = mk('a', { ...game, tableName: 'Another Table' });
    await flush();
    const B = mk('b', game);
    await flush();
    for (const s of [H, A, B]) expect(s.ctl.status().tableMismatch).toEqual(['a']);
    expect(B.ctl.status().participants.map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    // a's own controller saw b join before MATCH_READY (the roster re-sent on every join).
    expect(A.ctl.status().participants.map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    expect(B.media.panel.message).toBe('different table file: a');
    expect(B.media.panel.players.find((p) => p.id === 'a')?.flags).toEqual(['table_mismatch']);
    expect(B.media.panel.players.find((p) => p.id === 'b')?.flags).toEqual([]);
    host.start();
    await flush();
    // The final roster keeps the flags (they are not in MATCH_READY, so nothing clears them).
    expect(B.ctl.status().tableMismatch).toEqual(['a']);
  });

  it('a pending host transfer shows in status().transfer until it commits', async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game, clock });
    const H = seat(host, clock, 3);
    const seats: Seat[] = [];
    const statuses: Array<ReturnType<MatchController['status']>['transfer']> = [];
    for (const id of ['a', 'b']) {
      const k = generateKeys();
      const c = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: 'M', hostId: 'h', clock });
      const s = seat(c, clock);
      seats.push(s);
      c.join();
    }
    await flush();
    host.start();
    await flush();
    seats[0]!.ctl.onChange((s) => statuses.push(s.transfer));
    expect(H.ctl.status().transfer).toBeNull();
    host.transferHost('a');
    await flush();
    expect(statuses[0]).toEqual({ proposer: 'h', newHost: 'a', reason: 'host_requested' });
    expect(seats[0]!.ctl.status().transfer).toBeNull();
    expect(statuses.at(-1)).toBeNull();
  });

  it('a client whose link dropped mid-match sends RESUME itself once its RECONNECT is accepted (real WebSockets)', async () => {
    const clock = new ManualClock();
    const hk = generateKeys();
    const ck = generateKeys();
    const ht = new WsPeerTransport({ localId: 'h' });
    const url = await ht.listen(0, '127.0.0.1');
    const host = new HostMatch({ transport: ht, keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game });
    const H = seat(host, clock, 3);
    const ct = new WsPeerTransport({ localId: 'c' });
    const client = new ClientMatch({ transport: ct, keys: ck, participant: participant('c', ck), game, throwdownCode: 'M', reconnect: { delayMs: 50, attempts: 20 } });
    const C = seat(client, clock);
    const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    try {
      await ct.connect(url);
      client.join();
      await until(() => host.roster().length === 2);
      host.start();
      await until(() => client.state.phase === 'running' && C.ctl.status().phase === 'playing');
      // The host plays ball 1; the client's socket dies.
      ct.dropLinks('h');
      await until(() => host.state.paused !== null);
      expect(host.state.paused).toEqual({ reason: 'disconnect', player: 'c' });
      expect(H.ctl.status().phase).toBe('paused');
      await until(() => host.state.paused === null);
      const types = host.log.entries().map((e) => (e.message ? `${e.message.type}:${e.message.from}` : e.event?.type));
      // The pause, the client's own RESUME right after it, then the re-issued grant.
      const at = types.indexOf('PAUSE:h');
      expect(types.slice(at, at + 3)).toEqual(['PAUSE:h', 'RESUME:c', 'TURN_GRANT:h']);
      await until(() => C.ctl.status().phase === 'playing' && H.ctl.status().phase === 'playing');
      expect(C.logs).toContain('match: back after a drop; resuming the match');
      expect(client.log.head()).toEqual(host.log.head());
    } finally {
      client.close();
      host.close();
      ct.close();
      ht.close();
    }
  });
});

describe('vrViewMode (D7.4, 2026-10-31)', () => {
  const at = (phase: PanelState['phase'], myTurn: boolean, playerUp: string | null) => ({ phase, myTurn, playerUp });

  it('defaults: my ball hidden, their ball theater; the lobby, a pause, the gap between grants and the result: the panel', () => {
    expect(DEFAULT_VR_VIEW).toEqual({ theaterDuringMyTurn: 'hidden', spectate: 'theater' });
    expect(vrViewMode(at('idle', false, null))).toBe('panel');
    expect(vrViewMode(at('playing', true, 'me'))).toBe('hidden');
    expect(vrViewMode(at('playing', false, 'krobs'))).toBe('theater');
    expect(vrViewMode(at('playing', false, null))).toBe('panel');
    expect(vrViewMode(at('paused', true, 'me'))).toBe('panel');
    expect(vrViewMode(at('paused', false, 'krobs'))).toBe('panel');
    expect(vrViewMode(at('over', false, null))).toBe('panel');
  });

  it('the two settings: the panel on my ball, the panel on theirs', () => {
    expect(vrViewMode(at('playing', true, 'me'), { theaterDuringMyTurn: 'panel', spectate: 'theater' })).toBe('panel');
    expect(vrViewMode(at('playing', false, 'krobs'), { theaterDuringMyTurn: 'hidden', spectate: 'panel' })).toBe('panel');
    expect(vrViewMode(at('idle', false, null), { theaterDuringMyTurn: 'hidden', spectate: 'theater' })).toBe('panel');
  });
});

describe('A10 + A11 (2026-11-02): the series and the start from the host table', () => {
  const gameStart: ControllerFeed = { kind: 'game_start', t: 0, players: 1 };

  /** One ball each (1-ball games): the host's, then the client's, settled by the next score. */
  async function playGame(s: Awaited<ReturnType<typeof rig>>, hostScore: number, clientScore: number): Promise<void> {
    s.H.ctl.feed(scores(hostScore));
    s.H.ctl.feed(ballEnd(1));
    s.H.ctl.feed(scores(hostScore));
    await flush();
    s.C.ctl.feed(gameStart);
    s.C.ctl.feed(scores(clientScore));
    s.C.ctl.feed(ballEnd(1));
    s.C.ctl.feed(scores(clientScore));
    await flush();
  }

  it("two games: game 1's result keeps the match open, the host's game_start starts game 2 from grant 1, the series on the panel, End match", async () => {
    const s = await rig(1);
    const { host, client, H, C } = s;
    host.start();
    await flush();
    H.ctl.feed(gameStart);
    // The host's ball ends; game_start again while the client still plays game 1 starts nothing (no RESULT yet).
    H.ctl.feed(scores(500));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(scores(500));
    await flush();
    H.ctl.feed(gameStart);
    await flush();
    expect(host.state.gameNumber).toBe(1);
    C.ctl.feed(scores(800));
    C.ctl.feed(ballEnd(1));
    C.ctl.feed(scores(800));
    await flush();

    // Game 1 over: both panels say so and what comes next; the host's table is free, the client's held.
    expect(headerText(H.media.panel)).toBe('GAME 1 OVER');
    expect(headerText(C.media.panel)).toBe('GAME 1 OVER');
    expect(H.media.panel).toMatchObject({ phase: 'over', game: 1, seriesOver: false, message: 'Next game: start a game on your table (or press Next game)' });
    expect(C.media.panel.message).toBe('Next game: Hosty starts a game on the table');
    expect(C.media.panel.series).toEqual([
      { id: 'c', name: 'Krobs', wins: 1, games: 1, total: 800, place: 1 },
      { id: 'h', name: 'Hosty', wins: 0, games: 1, total: 500, place: 2 },
    ]);
    expect(H.ctl.status()).toMatchObject({ locked: false, series: { game: 1, over: false, nextGameBlocker: null } });
    expect(C.ctl.status()).toMatchObject({ locked: true, series: { game: 1, over: false } });
    expect(vrViewMode(C.media.panel)).toBe('panel');

    // The host starts a game on its table: game 2 for everyone, the host up on ball 1 with no "press Start" prompt.
    H.ctl.feed(gameStart);
    await flush();
    expect(host.state.gameNumber).toBe(2);
    expect(client.state.gameNumber).toBe(2);
    expect(H.ctl.status()).toMatchObject({ phase: 'playing', myTurn: true, locked: false });
    expect(H.media.panel).toMatchObject({ game: 2, ball: 1, result: null, message: null });
    expect(headerText(H.media.panel)).toBe('GAME 2 · YOUR BALL 1');
    expect(headerText(C.media.panel)).toBe('GAME 2 · HOSTY IS UP');
    expect(C.media.panel.players.map((p) => [p.id, p.score, p.ballsDone])).toEqual([
      ['h', null, 0],
      ['c', null, 0],
    ]);
    expect(H.logs.some((l) => l.includes('game 2 begins'))).toBe(true);

    // Game 2: the host wins it; the series is 1-1, the host ahead on total score.
    H.ctl.feed(scores(900));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(scores(900));
    await flush();
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(300));
    C.ctl.feed(ballEnd(1));
    C.ctl.feed(scores(300));
    await flush();
    expect(headerText(C.media.panel)).toBe('GAME 2 OVER');
    expect(C.media.panel.result?.map((r) => [r.id, r.place])).toEqual([
      ['h', 1],
      ['c', 2],
    ]);
    expect(C.media.panel.series?.map((x) => [x.id, x.wins, x.games, x.total, x.place])).toEqual([
      ['h', 1, 2, 1400, 1],
      ['c', 1, 2, 1100, 2],
    ]);
    expect(client.log.head()).toEqual(host.log.head());

    // End match: the series is over everywhere; every table unlocked.
    expect(H.ctl.endMatch()).toBe(true);
    await flush();
    for (const seat of [H, C]) {
      expect(seat.ctl.status()).toMatchObject({ phase: 'over', locked: false, series: { over: true } });
      expect(headerText(seat.media.panel)).toBe('MATCH OVER');
    }
    expect(C.media.panel.message).toBe('The host ended the match after 2 games');
    // Nothing starts after the end.
    H.ctl.feed(gameStart);
    await flush();
    expect(host.state.gameNumber).toBe(2);
  });

  it("the host's Next game (the Match tab) works like the table; a client's game_start never starts one", async () => {
    const s = await rig(1);
    const { host, H, C } = s;
    host.start();
    await flush();
    await playGame(s, 100, 200);
    C.ctl.feed(gameStart);
    await flush();
    expect(host.state.gameNumber).toBe(1);
    expect(C.ctl.nextGame()).toBe(false);
    expect(H.ctl.nextGame()).toBe(true);
    await flush();
    expect(host.state.gameNumber).toBe(2);
    // Started from the desktop: the host is still told to press Start on its table.
    expect(H.media.panel.message).toBe('Press Start on the table to begin your game');
  });

  it('the host leaving between games ends the series for the client (hostGone): unlocked, said on the panel', async () => {
    const s = await rig(1);
    const { host, bus, C } = s;
    host.start();
    await flush();
    await playGame(s, 100, 200);
    expect(C.ctl.status().locked).toBe(true);
    bus.disconnect('h');
    await flush();
    expect(C.ctl.status()).toMatchObject({ locked: false, series: { over: true } });
    expect(C.media.panel.message).toBe('The host left; the match is over');
  });

  it('A11: the host starting a game in a full lobby counts down 5 s on both panels; a second plunge changes nothing; the match starts', async () => {
    const { clock, host, client, H, C } = await rig(1);
    H.ctl.feed(gameStart);
    await flush();
    expect(headerText(H.media.panel)).toBe('STARTING IN 5');
    expect(H.media.panel.message).toBe('Starting the match: you, Krobs');
    expect(headerText(C.media.panel)).toBe('STARTING IN 5');
    expect(C.media.panel.message).toBe('Starting the match: Hosty, you');
    clock.advance(2000);
    H.ctl.feed(gameStart);
    await flush();
    expect(host.countdownRemaining()).toBe(3000);
    expect(H.media.panel.countdown).toBe(3);
    expect(host.state.phase).toBe('lobby');
    clock.advance(3000);
    await flush();
    expect(host.state.phase).toBe('running');
    expect(client.state.phase).toBe('running');
    expect(H.ctl.status()).toMatchObject({ phase: 'playing', myTurn: true });
    expect(H.media.panel.countdown).toBeNull();
    expect(C.media.panel.countdown).toBeNull();
  });

  it('A11: the desktop Start during the countdown starts at once; the countdown then does nothing', async () => {
    const { clock, host, H } = await rig(1);
    H.ctl.feed(gameStart);
    host.start();
    await flush();
    expect(host.state.phase).toBe('running');
    clock.advance(10_000);
    expect(host.log.entries().filter((e) => e.message?.type === 'MATCH_READY')).toHaveLength(1);
    expect(H.media.panel.countdown).toBeNull();
  });

  it('A11: alone in the lobby nothing starts; with a table still loading the start waits for it, flagged LOADING', async () => {
    const noTable: GameFingerprint = { ...game, tableName: 'no table open', tableHash: '0'.repeat(64) };
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const ck = generateKeys();
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'L', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy: 'advise', clock });
    const H = seat(host, clock, 1);
    await H.ctl.open();
    H.ctl.feed(gameStart);
    expect(host.countdownRemaining()).toBeNull();
    expect(H.media.panel.message).toBe('Waiting for players');
    const client = new ClientMatch({ transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game: noTable, throwdownCode: 'L', hostId: 'h', clock });
    const C = seat(client, clock);
    await C.ctl.open();
    client.join();
    await flush();
    expect(H.media.panel.players.find((p) => p.id === 'c')?.flags).toContain('loading');
    expect(C.media.panel.players.find((p) => p.id === 'c')?.flags).toContain('loading');
    expect(H.media.panel.message).toBe("Waiting for Krobs's table to open");
    expect(C.media.panel.message).toBe('Waiting for your table to open');
    H.ctl.feed(gameStart);
    expect(host.countdownRemaining()).toBeNull();
    expect(H.media.panel.message).toBe("The match starts once Krobs's table is open");
    client.updateParticipant({ game });
    await flush();
    expect(host.countdownRemaining()).toBe(5000);
    expect(headerText(C.media.panel)).toBe('STARTING IN 5');
    clock.advance(5000);
    await flush();
    expect(host.state.phase).toBe('running');
  });

  it("A11: the host's game ending in the lobby disarms a start waiting for a table", async () => {
    const noTable: GameFingerprint = { ...game, tableName: 'no table open', tableHash: '0'.repeat(64) };
    const { host, client, H } = await rig(1, noTable, 'advise');
    H.ctl.feed(gameStart);
    H.ctl.feed(gameEnd(10));
    client.updateParticipant({ game });
    await flush();
    expect(host.countdownRemaining()).toBeNull();
    expect(H.media.panel.message).toBe('Everyone in? Start a game on your table (or press Start match)');
  });
});

describe('A12 (2026-11-05): no game before the match', () => {
  const gameStart: ControllerFeed = { kind: 'game_start', t: 0, players: 1 };

  /** A host alone in its lobby (`rig()` joins the client at once); the client is made with `join()`. */
  function lobby(preMatchPlay?: 'free' | 'locked') {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const ck = generateKeys();
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'A', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy: 'advise', clock });
    const H = seat(host, clock, 1, { preMatchPlay });
    const join = async (clientGame: GameFingerprint = game) => {
      const client = new ClientMatch({ transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game: clientGame, throwdownCode: 'A', hostId: 'h', clock });
      const C = seat(client, clock, undefined, { preMatchPlay });
      await C.ctl.open();
      client.join();
      await flush();
      return { client, C };
    };
    return { bus, clock, host, H, join };
  }

  it("free play (default): the host's game started before the join is never game 1; the join waits for it to end, the next Start counts down", async () => {
    const { clock, host, H, join } = lobby();
    await H.ctl.open();
    expect(H.locks).toEqual([]);
    H.ctl.feed(gameStart);
    expect(H.logs).toContain('match: a game started on the table, but nobody has joined yet; the match does not start');
    const { client, C } = await join();
    // The lobby is complete, but the host's game runs: nothing starts, nothing is locked; the host's panel says why.
    expect(host.countdownRemaining()).toBeNull();
    expect(H.ctl.status()).toMatchObject({ phase: 'lobby', locked: false, waitingForHostGame: true });
    expect(H.logs).toContain("match: the lobby is complete, but a game is running on the host's table; the match starts at the next Start after it ends");
    expect(H.media.panel.message).toBe('Everyone is in: finish the game on your table, then press Start on it to start the match');
    expect(C.media.panel.message).toBe('Waiting for Hosty to start a game on the table');
    expect(H.locks).toEqual([]);
    expect(C.locks).toEqual([]);
    // The host's game ends: the usual "press Start" line; nothing started.
    H.ctl.feed(gameEnd(1200));
    expect(H.ctl.status().waitingForHostGame).toBe(false);
    expect(H.logs).toContain("match: the game on the host's table ended; the next Start on the table starts the match");
    expect(H.media.panel.message).toBe('Everyone in? Start a game on your table (or press Start match)');
    expect(host.countdownRemaining()).toBeNull();
    // The next Start: the A11 countdown, then the match, with the host up on ball 1 of a fresh game.
    H.ctl.feed(gameStart);
    await flush();
    expect(host.countdownRemaining()).toBe(5000);
    expect(headerText(C.media.panel)).toBe('STARTING IN 5');
    clock.advance(5000);
    await flush();
    expect(host.state.phase).toBe('running');
    expect(client.state.phase).toBe('running');
    expect(H.ctl.status()).toMatchObject({ phase: 'playing', myTurn: true, waitingForHostGame: false });
    expect(H.locks).toEqual(['lock', 'unlock']);
    expect(C.locks).toEqual(['lock']);
  });

  it('free play: a second game_start with no game_end between is the start; a leave while waiting drops the wait', async () => {
    const { host, H, join } = lobby('free');
    await H.ctl.open();
    H.ctl.feed(gameStart);
    await join();
    expect(H.ctl.status().waitingForHostGame).toBe(true);
    H.ctl.feed(gameStart);
    await flush();
    expect(H.logs).toContain('match: a new game started on the table while the lobby waited for the last one to end; taking it as the start');
    expect(H.ctl.status().waitingForHostGame).toBe(false);
    expect(host.countdownRemaining()).toBe(5000);

    // Another lobby: waiting, then the client leaves: back to "Waiting for players"; a game still runs on the table.
    const second = lobby('free');
    await second.H.ctl.open();
    second.H.ctl.feed(gameStart);
    await second.join();
    expect(second.H.ctl.status().waitingForHostGame).toBe(true);
    second.bus.disconnect('c');
    await flush();
    expect(second.H.ctl.status().waitingForHostGame).toBe(false);
    expect(second.H.media.panel.message).toBe('Waiting for players');
  });

  it('a game already running at host time (the witness says so) is waited out the same way', async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const ck = generateKeys();
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'A', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, clock });
    const H = seat(host, clock, 1, { tableGameRunning: true });
    await H.ctl.open();
    const client = new ClientMatch({ transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game, throwdownCode: 'A', hostId: 'h', clock });
    const C = seat(client, clock);
    await C.ctl.open();
    client.join();
    await flush();
    expect(H.ctl.status().waitingForHostGame).toBe(true);
    H.ctl.feed(gameEnd(5));
    H.ctl.feed(gameStart);
    expect(host.countdownRemaining()).toBe(5000);
  });

  it('locked: the host\'s table is locked from Host, unlocked when the lobby is complete, locked again on a leave; a client\'s never', async () => {
    const { bus, clock, host, H, join } = lobby('locked');
    await H.ctl.open();
    expect(H.locks).toEqual(['lock']);
    expect(H.ctl.status().locked).toBe(true);
    expect(H.media.panel.message).toBe('Waiting for players — the table unlocks when someone joins');
    expect(H.logs).toContain('match: your table is locked until the lobby is complete (Before the match: locked)');
    const { C } = await join();
    expect(H.locks).toEqual(['lock', 'unlock']);
    expect(H.ctl.status().locked).toBe(false);
    expect(H.media.panel.message).toBe('Everyone in? Start a game on your table (or press Start match)');
    expect(C.locks).toEqual([]);
    expect(C.ctl.status().locked).toBe(false);
    expect(C.media.panel.message).toBe('Waiting for Hosty to start a game on the table');
    // The client leaves before the countdown: locked again.
    bus.disconnect('c');
    await flush();
    expect(H.locks).toEqual(['lock', 'unlock', 'lock']);
    expect(H.media.panel.message).toBe('Waiting for players — the table unlocks when someone joins');
    // A second client joins; the Start press starts the countdown as in A11; MATCH_READY locks as always, grant 1 unlocks.
    const k2 = generateKeys();
    const c2 = new ClientMatch({ transport: bus.transport('c2'), keys: k2, participant: { ...participant('c2', k2), displayName: 'Bea' }, game, throwdownCode: 'A', hostId: 'h', clock });
    const C2 = seat(c2, clock, undefined, { preMatchPlay: 'locked' });
    await C2.ctl.open();
    c2.join();
    await flush();
    expect(H.locks).toEqual(['lock', 'unlock', 'lock', 'unlock']);
    H.ctl.feed(gameStart);
    await flush();
    expect(host.countdownRemaining()).toBe(5000);
    clock.advance(5000);
    await flush();
    expect(host.state.phase).toBe('running');
    expect(H.locks).toEqual(['lock', 'unlock', 'lock', 'unlock', 'lock', 'unlock']);
    expect(C2.locks).toEqual(['lock']);
  });

  it('locked: a joined player whose table is still loading keeps the lock; the setting switched in the lobby takes effect at once', async () => {
    const noTable: GameFingerprint = { ...game, tableName: 'no table open', tableHash: '0'.repeat(64) };
    const { H, join } = lobby('locked');
    await H.ctl.open();
    const { client } = await join(noTable);
    expect(H.locks).toEqual(['lock']);
    expect(H.media.panel.message).toBe("Waiting for Krobs's table to open; your table unlocks then");
    client.updateParticipant({ game });
    await flush();
    expect(H.locks).toEqual(['lock', 'unlock']);
    // Back to free play then locked again, with the lobby complete: nothing to lock.
    H.ctl.setPreMatchPlay('free');
    H.ctl.setPreMatchPlay('locked');
    expect(H.locks).toEqual(['lock', 'unlock']);

    const alone = lobby('free');
    await alone.H.ctl.open();
    alone.H.ctl.setPreMatchPlay('locked');
    expect(alone.H.locks).toEqual(['lock']);
    alone.H.ctl.setPreMatchPlay('free');
    expect(alone.H.locks).toEqual(['lock', 'unlock']);
    expect(alone.H.media.panel.message).toBe('Waiting for players');
  });
});
