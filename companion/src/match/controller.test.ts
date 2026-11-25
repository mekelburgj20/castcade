/**
 * A6 + C3 (2026-10-30): the MatchController from both seats, driven by the real engine (HostMatch + ClientMatch on a
 * MemoryBus, a ManualClock for every timer) so the engine's own event names and ordering are what is tested, with
 * fakes for the lock, the cue and the media layer. Detector events are fed by hand, the way the witness emits them.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint, ParticipantInfo } from '@castcade/protocol';
import type { MatchMedia, MediaSignalling, MediaStatus, PanelState } from '../media/match-media-types.js';
import { headerText, stripRows } from '../media/panel-page.js';
import { scoreboardView } from '../media/scoreboard-page.js';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { midnightLine } from '../witness/midnight.js';
import { DEFAULT_VR_VIEW, INITIALS_HOLD_CAP_MS, INITIALS_HOLD_MESSAGE, INITIALS_QUIET_MS, isHostRole, MatchController, MIDNIGHT_LINE_MS, mismatchWords, owedBallLine, pausedForPlayerUp, SPENT_UNLOCK_MS, vrViewMode, type ControllerFeed, type CueKind, type MatchControllerOptions } from './controller.js';
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
  /** A18: the ICE state the page reports for a peer (none: the page knows no connection to it). */
  ice: Record<string, string> = {};
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
    const peers = Object.fromEntries(Object.entries(this.ice).map(([id, ice]) => [id, { ice, receivingVideo: false, receivingAudio: true }]));
    return { attached: this.attachedWith !== null, sending: this.sending[this.sending.length - 1] ?? false, peers, mic: 'open', captureSource: null, lastError: this.lastError };
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

async function rig(balls = 3, clientGame: GameFingerprint = game, fingerprintPolicy?: 'refuse' | 'advise', extra: Partial<MatchControllerOptions> = {}) {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const ck = generateKeys();
  const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'ABCDEF', ballsPerGame: balls, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy, clock });
  const client = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game: clientGame, throwdownCode: 'ABCDEF', hostId: 'h', clock });
  const H = seat(host, clock, balls, extra);
  const C = seat(client, clock, undefined, extra);
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
    const h = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: k, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', k), hostGame: game });
    const c = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c'), keys: k, participant: participant('c', k), game, throwdownCode: 'M' });
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
    // A17 (2026-11-24): the voice is connected from the join on; the start below adds nobody again.
    expect(H.media.added).toEqual(['c']);
    expect(C.media.added).toEqual(['h']);

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
    const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy: 'advise', clock });
    const H = seat(host, clock, 3);
    await H.ctl.open();
    const mk = (id: string, g: GameFingerprint): Seat => {
      const k = generateKeys();
      const p = { ...participant(id, k), displayName: id };
      const c = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport(id), keys: k, participant: p, game: g, throwdownCode: 'M', hostId: 'h', clock });
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
    const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game, clock });
    const H = seat(host, clock, 3);
    const seats: Seat[] = [];
    const statuses: Array<ReturnType<MatchController['status']>['transfer']> = [];
    for (const id of ['a', 'b']) {
      const k = generateKeys();
      const c = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: 'M', hostId: 'h', clock });
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

  it("A18: a client whose link drops in the host's ball changes nothing for the host; the match waits for it at its own turn, and it sends RESUME itself once its RECONNECT is accepted (real WebSockets)", async () => {
    const clock = new ManualClock();
    const hk = generateKeys();
    const ck = generateKeys();
    const ht = new WsPeerTransport({ localId: 'h' });
    const url = await ht.listen(0, '127.0.0.1');
    const host = new HostMatch({ disconnectGraceMs: 0, transport: ht, keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game });
    const H = seat(host, clock, 3);
    const ct = new WsPeerTransport({ localId: 'c' });
    const client = new ClientMatch({ disconnectGraceMs: 0, transport: ct, keys: ck, participant: participant('c', ck), game, throwdownCode: 'M', reconnect: { delayMs: 400, attempts: 20 } });
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
      // The host plays ball 1; the client's socket dies. Nothing changes for the host: no pause, the same grant, the
      // table as it was; the client is shown as away.
      const grant = host.state.currentGrant?.grant.grantSeq;
      const locks = H.locks.length;
      const before = host.log.length;
      ct.dropLinks('h');
      await until(() => H.ctl.status().panel.players.find((p) => p.id === 'c')?.flags.includes('disconnected') === true);
      expect(host.state.paused).toBeNull();
      expect(H.ctl.status()).toMatchObject({ phase: 'playing', myTurn: true, locked: false });
      expect(host.state.currentGrant?.grant.grantSeq).toBe(grant);
      expect(H.locks.length).toBe(locks);
      expect(host.log.length).toBe(before);
      // The host's ball ends while the client is still away: its turn is next, so now the match waits for it.
      host.localBallEnd(100, 'nvram');
      expect(host.state.paused).toEqual({ reason: 'disconnect', player: 'c' });
      expect(H.ctl.status().phase).toBe('paused');
      await until(() => host.state.paused === null);
      const types = host.log.entries().map((e) => (e.message ? `${e.message.type}:${e.message.from}` : e.event?.type));
      // The host's ball end, the pause for the client at its turn, the client's own RESUME, then its grant.
      const at = types.indexOf('PAUSE:h');
      expect(types.slice(at - 1, at + 3)).toEqual(['BALL_END:h', 'PAUSE:h', 'RESUME:c', 'TURN_GRANT:h']);
      expect(host.state.currentGrant?.grant).toMatchObject({ player: 'c', ballNumber: 1 });
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

describe('A18 (2026-11-24): a control link that drops is not the media connection', () => {
  /** A started match on the bus; the host's page says its connection to the client is `ice`. */
  async function started(ice: string | null) {
    const s = await rig();
    s.host.start();
    await flush();
    expect(s.H.media.added).toEqual(['c']);
    if (ice !== null) s.H.media.ice.c = ice;
    return s;
  }
  /** The engine's word that the client is back on its link (a MemoryBus peer cannot come back by itself). */
  const back = (s: Awaited<ReturnType<typeof rig>>, quiet = false): void => s.host.events.emit('reconnected', { playerId: 'c', entries: 0, quiet });
  const away = (s: Awaited<ReturnType<typeof rig>>): boolean => s.H.ctl.panel().players.find((p) => p.id === 'c')?.flags.includes('disconnected') === true;

  it('the voice connection is up when the link drops: it is kept, the player is shown as away, and nothing is made again at the return', async () => {
    const s = await started('connected');
    s.bus.disconnect('c');
    await flush();
    expect(away(s)).toBe(true);
    expect(s.H.media.removed).toEqual([]);
    // The host is up: its turn is as it was.
    expect(s.H.ctl.status()).toMatchObject({ phase: 'playing', myTurn: true, locked: false });
    expect(s.H.media.sending).toEqual([true]);
    back(s);
    expect(away(s)).toBe(false);
    expect(s.H.media.added).toEqual(['c']);
    expect(s.H.media.removed).toEqual([]);
    expect(s.H.logs.some((l) => l.includes('never dropped and is kept'))).toBe(true);
  });

  it('the connection is not up when the link drops (the player is really gone): closed as before, and made again at the return', async () => {
    const s = await started('disconnected');
    s.bus.disconnect('c');
    await flush();
    expect(s.H.media.removed).toEqual(['c']);
    back(s);
    expect(s.H.media.added).toEqual(['c', 'c']);
  });

  it('kept at the drop, then the connection itself goes while the player is away: closed at the next word from the page, made again at the return', async () => {
    const s = await started('completed');
    s.bus.disconnect('c');
    await flush();
    expect(s.H.media.removed).toEqual([]);
    s.H.media.ice.c = 'failed';
    s.H.ctl.refresh();
    expect(s.H.media.removed).toEqual(['c']);
    s.H.ctl.refresh();
    expect(s.H.media.removed).toEqual(['c']);
    s.H.media.ice.c = 'new';
    back(s);
    expect(s.H.media.added).toEqual(['c', 'c']);
  });

  it('kept, and the connection is gone by the time the player is back: made again', async () => {
    const s = await started('connected');
    s.bus.disconnect('c');
    await flush();
    s.H.media.ice.c = 'disconnected';
    back(s);
    expect(s.H.media.added).toEqual(['c', 'c']);
  });

  it('a return inside the engine\'s grace (nobody was told of a drop) touches no media, whatever the page says', async () => {
    const s = await started('checking');
    back(s, true);
    expect(s.H.media.added).toEqual(['c']);
    expect(s.H.media.removed).toEqual([]);
  });

  it('a guest who dropped in the lobby and joined again is not away once the match starts, and its connection, still being made, is not closed (review of PR 126)', async () => {
    const clock = new ManualClock();
    const hk = generateKeys();
    const ck = generateKeys();
    const ht = new WsPeerTransport({ localId: 'h' });
    const url = await ht.listen(0, '127.0.0.1');
    const host = new HostMatch({ transport: ht, keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game });
    const H = seat(host, clock, 3);
    const opened: { close(): void }[] = [ht, host];
    const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const join = async (): Promise<{ ct: WsPeerTransport; client: ClientMatch }> => {
      const ct = new WsPeerTransport({ localId: 'c' });
      await ct.connect(url);
      const client = new ClientMatch({ transport: ct, keys: ck, participant: participant('c', ck), game, throwdownCode: 'M' });
      opened.push(ct, client);
      client.join();
      await until(() => host.roster().length === 2);
      return { ct, client };
    };
    try {
      await H.ctl.open();
      // The guest joins, its link drops in the lobby (the host takes it off the roster), and it joins again: the same
      // player id, a fresh HELLO.
      const first = await join();
      // A17: the voice follows the lobby: connected at the join, let go at the leave, connected again at the next join.
      expect(H.media.added).toEqual(['c']);
      first.client.close();
      first.ct.close();
      await until(() => host.roster().length === 1);
      expect(H.media.removed).toEqual(['c']);
      await join();
      expect(H.media.added).toEqual(['c', 'c']);
      host.start();
      await until(() => H.ctl.status().phase === 'playing');
      expect(H.ctl.panel().players.find((p) => p.id === 'c')?.flags).not.toContain('disconnected');
      // The page reports the new connection while it is still being made; every such word used to reach the players
      // the controller thought were away.
      const removed = H.media.removed.length;
      H.media.ice.c = 'checking';
      H.ctl.refresh();
      H.media.ice.c = 'connected';
      H.ctl.refresh();
      expect(H.media.removed.length).toBe(removed);
      // A17: and the start made nothing again: the connection of the second join is the match's.
      expect(H.media.added).toEqual(['c', 'c']);
      expect(H.ctl.panel().players.find((p) => p.id === 'c')?.flags).not.toContain('disconnected');
    } finally {
      for (const x of opened.reverse()) x.close();
    }
  });

  it('a pause for my own drop that reaches me on a live link (the host could not tell I was back): I resume it myself, once', async () => {
    const s = await rig();
    s.host.start();
    await flush();
    // The host's own ball; the pause names the client although its link is up (it was back before the host knew:
    // several players dropped at once, or its RECONNECT crossed the end of its grace).
    s.host.pause('disconnect', 'c');
    await flush();
    expect(s.C.ctl.status().phase).toBe('paused');
    // The resume is deferred by one turn of the controller's own clock (a pause that comes with a RECONNECT_ACK is
    // the `reconnected` handler's).
    s.clock.advance(0);
    await flush();
    expect(s.host.state.paused).toBeNull();
    expect(s.C.logs.filter((l) => l === 'match: back after a drop; resuming the match')).toHaveLength(1);
    const types = s.host.log.entries().map((e) => (e.message ? `${e.message.type}:${e.message.from}` : e.event?.type));
    expect(types.slice(-3)).toEqual(['PAUSE:h', 'RESUME:c', 'TURN_GRANT:h']);
    expect(s.C.ctl.status().phase).toBe('playing');
    expect(s.H.ctl.status()).toMatchObject({ phase: 'playing', myTurn: true, locked: false });
  });

  it("a start from the host's table that is held for a player inside the grace: the panel says so, and a ball that drains on the host's table meanwhile is its ball 1 when the game starts (review 2 of PR 126, D)", async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    // The engines' own grace, on the manual clock.
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, clock });
    const [a, b] = ['a', 'b'].map((id) => {
      const k = generateKeys();
      const c = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: 'M', hostId: 'h', clock });
      c.join();
      return c;
    });
    const H = seat(host, clock, 1);
    await H.ctl.open();
    await flush();
    host.start();
    await flush();
    // Game 1, one ball each.
    host.localBallEnd(100, 'nvram');
    await flush();
    a!.reportBallEnd(200, 'nvram');
    await flush();
    b!.reportBallEnd(300, 'nvram');
    await flush();
    expect(H.ctl.status().phase).toBe('over');
    // b's link drops; a second later the host starts a game on its table.
    bus.disconnect('b');
    await flush();
    clock.advance(1000);
    H.ctl.feed({ kind: 'game_start', t: 0, players: 1 } as ControllerFeed);
    expect(host.nextGamePending).toBe(true);
    expect(host.state.gameNumber).toBe(1);
    expect(H.ctl.panel().message).toBe("Next game: starting in a few seconds (a player's link dropped a moment ago: waiting to see whether they are back)");
    // The host's ball drains at once, inside the hold: the match has no grant for it yet.
    H.ctl.feed(scores(900));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(scores(950));
    expect(host.state.gameNumber).toBe(1);
    // The grace is over, b is away: game 2 starts with the host and a; the ball the table already played is the
    // host's ball 1, reported at its grant, and the turn is a's.
    clock.advance(4000);
    await flush();
    expect(host.state.gameNumber).toBe(2);
    expect(host.state.playerOrder).toEqual(['h', 'a']);
    expect(host.state.players['h']).toMatchObject({ ballsPlayed: 1, score: 950 });
    expect(host.state.currentGrant?.grant).toMatchObject({ player: 'a', ballNumber: 1, game: 2 });
    expect(H.logs.some((l) => l.includes("table event(s) from the seconds the game's start was held go to the match now (1 ball end(s))"))).toBe(true);
    expect(H.ctl.panel().message ?? '').not.toContain('Press Start');
  });

  it("a second game_start on the host's table inside the hold (the game started again, no end between): what was kept of the first is dropped, so its ball end is not ball 1 of the new one (review 3 of PR 126)", async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, clock });
    const [a, b] = ['a', 'b'].map((id) => {
      const k = generateKeys();
      const c = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: 'M', hostId: 'h', clock });
      c.join();
      return c;
    });
    const H = seat(host, clock, 1);
    await H.ctl.open();
    await flush();
    host.start();
    await flush();
    host.localBallEnd(100, 'nvram');
    await flush();
    a!.reportBallEnd(200, 'nvram');
    await flush();
    b!.reportBallEnd(300, 'nvram');
    await flush();
    bus.disconnect('b');
    await flush();
    clock.advance(1000);
    const start = { kind: 'game_start', t: 0, players: 1 } as ControllerFeed;
    H.ctl.feed(start);
    expect(host.nextGamePending).toBe(true);
    // The ball drains, and the host starts the table's game again at once.
    H.ctl.feed(scores(900));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(start);
    H.ctl.feed(scores(50));
    clock.advance(4000);
    await flush();
    // Game 2 starts: the host holds ball 1 of it, with the new table game's score; the first game's ball end is gone.
    expect(host.state.gameNumber).toBe(2);
    expect(host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 1, game: 2 });
    expect(host.state.players['h']).toMatchObject({ ballsPlayed: 0 });
    expect(H.ctl.status()).toMatchObject({ myTurn: true, locked: false });
    expect(H.ctl.panel().players.find((p) => p.id === 'h')?.score).toBe(50);
    expect(H.logs.some((l) => l.includes('(0 ball end(s))'))).toBe(true);
  });
});

describe('A17 step 1 (2026-11-24): the voice from the join on', () => {
  const gameStart: ControllerFeed = { kind: 'game_start', t: 0, players: 1 };
  /** Every call a seat's media layer got that could open or close a connection. */
  const calls = (s: Seat): string[] => [...s.media.added.map((p) => `add ${p}`), ...s.media.removed.map((p) => `remove ${p}`)];

  it('the voice is up in the lobby: each PC asks for the connection to the other at the join, before any start', async () => {
    const { host, H, C } = await rig();
    expect(host.state.phase).toBe('lobby');
    expect(H.ctl.status().phase).toBe('lobby');
    expect(calls(H)).toEqual(['add c']);
    expect(calls(C)).toEqual(['add h']);
    expect(H.logs.filter((l) => l.includes('voice with Krobs is being connected now, in the lobby'))).toHaveLength(1);
    expect(C.logs.filter((l) => l.includes('voice with Hosty is being connected now, in the lobby'))).toHaveLength(1);
    // The panel is the lobby's: nobody is up, nothing is locked.
    expect(H.media.panel.phase).toBe('idle');
    expect(H.locks).toEqual([]);
  });

  it('MATCH_READY, NEXT_GAME, a RESULT and a reconnect make no addPeer / removePeer call; the end of the match, which is the end of the lobby too, lets everyone go at once', async () => {
    const s = await rig(1);
    const { host, client, H, C } = s;
    const lobby = { h: calls(H), c: calls(C) };
    expect(lobby).toEqual({ h: ['add c'], c: ['add h'] });
    const unchanged = (): void => expect({ h: calls(H), c: calls(C) }).toEqual(lobby);
    const ball = async (x: Seat, score: number): Promise<void> => {
      x.ctl.feed(scores(score));
      x.ctl.feed(ballEnd(1));
      x.ctl.feed(scores(score));
      await flush();
    };

    // MATCH_READY.
    host.start();
    await flush();
    expect(C.ctl.status().phase).toBe('playing');
    unchanged();

    // Game 1 to its RESULT.
    H.ctl.feed(gameStart);
    await ball(H, 500);
    C.ctl.feed(gameStart);
    await ball(C, 800);
    expect(headerText(C.media.panel)).toBe('GAME 1 OVER');
    unchanged();

    // NEXT_GAME.
    H.ctl.feed(gameStart);
    await flush();
    expect(client.state.gameNumber).toBe(2);
    unchanged();

    // A reconnect of the match's control link, on both ends of it, while the pages' connection is up (A18 keeps it).
    H.media.ice.c = 'connected';
    C.media.ice.h = 'connected';
    host.events.emit('reconnected', { playerId: 'c', entries: 0, quiet: false });
    client.events.emit('reconnected', { host: 'h', entries: 0, quiet: false });
    await flush();
    unchanged();

    // Game 2 to its RESULT, then the host ends the match (MATCH_END).
    await ball(H, 900);
    C.ctl.feed(gameStart);
    await ball(C, 300);
    expect(headerText(C.media.panel)).toBe('GAME 2 OVER');
    unchanged();
    // The host ends the match: nothing follows in this lobby, on either PC. Nobody's microphone is sent to anybody
    // through the seconds the panel lingers (the review of PR 127): the connection is let go at once, and nothing
    // that names the player afterwards makes it again.
    expect(H.ctl.endMatch()).toBe(true);
    await flush();
    expect(headerText(C.media.panel)).toBe('MATCH OVER');
    expect({ h: calls(H), c: calls(C) }).toEqual({ h: ['add c', 'remove c'], c: ['add h', 'remove h'] });
    host.events.emit('reconnected', { playerId: 'c', entries: 0, quiet: false });
    client.events.emit('reconnected', { host: 'h', entries: 0, quiet: false });
    await flush();
    expect({ h: calls(H), c: calls(C) }).toEqual({ h: ['add c', 'remove c'], c: ['add h', 'remove h'] });
  });

  /** Three in a lobby on one bus: the host and two clients, each with its controller and its media fake. */
  async function lobbyOfThree() {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    // The engines' own grace, as the app runs them: a drop in the lobby is a leave at once all the same.
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game, clock });
    const H = seat(host, clock, 3);
    await H.ctl.open();
    const mk = async (id: string): Promise<Seat & { client: ClientMatch; dropLink(): void }> => {
      const k = generateKeys();
      const t = bus.transport(id);
      const client = new ClientMatch({ transport: t, keys: k, participant: { ...participant(id, k), displayName: id }, game, throwdownCode: 'M', hostId: 'h', clock });
      const x = seat(client, clock);
      await x.ctl.open();
      client.join();
      await flush();
      /** This PC's own link to the host drops: the others see it leave (the bus), and its transport reports the host gone, as a socket does. */
      const dropLink = (): void => {
        bus.disconnect(id);
        for (const cb of [...(t as unknown as { leaveHandlers: Set<(peer: string) => void> }).leaveHandlers]) cb('h');
      };
      return { ...x, client, dropLink };
    };
    const A = await mk('a');
    const B = await mk('b');
    expect([calls(H), calls(A), calls(B)]).toEqual([
      ['add a', 'add b'],
      ['add h', 'add b'],
      ['add h', 'add a'],
    ]);
    return { bus, clock, host, H, A, B };
  }
  const LOBBY_OVER = "The lobby is over: the link to Hosty's Castcade is gone (they left or closed Castcade, or the connection dropped). Nobody hears your microphone any more. Join again to play.";

  it("the host of a lobby of three goes away (it left, its Castcade closed, the room was closed): each client lets go of everybody at once, the other client too, and says that the lobby is over (the review of PR 127)", async () => {
    const { bus, clock, A, B } = await lobbyOfThree();
    bus.disconnect('h');
    await flush();
    // At once, with no clock: the host, and the other client, whom no roster will ever take off.
    expect(calls(A)).toEqual(['add h', 'add b', 'remove h', 'remove b']);
    expect(calls(B)).toEqual(['add h', 'add a', 'remove h', 'remove a']);
    for (const x of [A, B]) {
      expect(x.ctl.status()).toMatchObject({ phase: 'lobby', series: { over: true }, locked: false });
      expect(x.media.panel).toMatchObject({ phase: 'idle', seriesOver: true, message: LOBBY_OVER });
      expect(headerText(x.media.panel)).toBe('LOBBY OVER');
      expect(x.logs).toContain(`match: ${LOBBY_OVER}`);
      expect(x.media.detached).toBe(false); // the shell closes the page after its linger
    }
    // Until 0.2.50 this dead lobby was silent, and with the voice from the join on the two went on hearing each other
    // in it for as long as neither pressed Leave. Ten minutes on: nothing was made again.
    clock.advance(10 * 60_000);
    await flush();
    expect(calls(A)).toEqual(['add h', 'add b', 'remove h', 'remove b']);
    expect(calls(B)).toEqual(['add h', 'add a', 'remove h', 'remove a']);
    // Nothing that still names a player brings a connection back in a lobby that is over.
    A.client.events.emit('roster', { ...A.client.state, participants: A.ctl.status().participants, loading: [], stream3dWait: [], ballEndReady: [], midnightModes: [], startsInMs: null } as never);
    A.client.events.emit('reconnected', { host: 'h', entries: 0, quiet: false });
    await flush();
    expect(calls(A)).toEqual(['add h', 'add b', 'remove h', 'remove b']);
  });

  it("only this client's own link to the host drops: it lets go of everybody at once and says so; the host lets it go, and tells the other client to", async () => {
    const { H, A, B } = await lobbyOfThree();
    A.dropLink();
    await flush();
    expect(calls(A)).toEqual(['add h', 'add b', 'remove h', 'remove b']);
    expect(headerText(A.media.panel)).toBe('LOBBY OVER');
    expect(A.media.panel.message).toBe(LOBBY_OVER);
    // The lobby goes on for the two who are in it, without the one who is not.
    expect(calls(H)).toEqual(['add a', 'add b', 'remove a']);
    expect(calls(B)).toEqual(['add h', 'add a', 'remove a']);
    expect(headerText(B.media.panel)).toBe('WAITING FOR THE START');
    expect(B.ctl.status().series.over).toBe(false);
  });

  it('the host of a lobby is never the one whose lobby is lost: a client that goes is let go, and the lobby waits for players', async () => {
    const { bus, H } = await lobbyOfThree();
    bus.disconnect('a');
    bus.disconnect('b');
    await flush();
    expect(calls(H)).toEqual(['add a', 'add b', 'remove a', 'remove b']);
    expect(H.ctl.status()).toMatchObject({ phase: 'lobby', series: { over: false } });
    expect(headerText(H.media.panel)).toBe('WAITING FOR THE START');
  });

  it('the host is gone between two games (three players): the series is over, and the two clients let go of each other at once, not when their panels close', async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, clock });
    const H = seat(host, clock, 1);
    await H.ctl.open();
    const mk = async (id: string): Promise<Seat> => {
      const k = generateKeys();
      const c = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport(id), keys: k, participant: { ...participant(id, k), displayName: id }, game, throwdownCode: 'M', hostId: 'h', clock });
      const x = seat(c, clock);
      await x.ctl.open();
      c.join();
      await flush();
      return x;
    };
    const A = await mk('a');
    const B = await mk('b');
    host.start();
    await flush();
    for (const x of [H, A, B]) {
      x.ctl.feed(gameStart);
      x.ctl.feed(scores(100));
      x.ctl.feed(ballEnd(1));
      x.ctl.feed(scores(100));
      await flush();
    }
    expect(headerText(A.media.panel)).toBe('GAME 1 OVER');
    expect(calls(A)).toEqual(['add h', 'add b']);
    bus.disconnect('h');
    await flush();
    expect(A.media.panel.message).toBe('The host left; the match is over');
    expect(calls(A)).toEqual(['add h', 'add b', 'remove h', 'remove b']);
    expect(calls(B)).toEqual(['add h', 'add a', 'remove h', 'remove a']);
  });

  it('three in the lobby: everyone is connected to everyone at the join; a player who leaves is let go by the host at once and by the other client from the roster it is sent', async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game, clock });
    const H = seat(host, clock, 3);
    await H.ctl.open();
    const mk = async (id: string): Promise<Seat> => {
      const k = generateKeys();
      const c = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport(id), keys: k, participant: { ...participant(id, k), displayName: id }, game, throwdownCode: 'M', hostId: 'h', clock });
      const x = seat(c, clock);
      await x.ctl.open();
      c.join();
      await flush();
      return x;
    };
    const A = await mk('a');
    expect(calls(H)).toEqual(['add a']);
    expect(calls(A)).toEqual(['add h']);
    const B = await mk('b');
    // `a` learns of `b` from the roster the host sends again at every join.
    expect(calls(H)).toEqual(['add a', 'add b']);
    expect(calls(A)).toEqual(['add h', 'add b']);
    expect(calls(B)).toEqual(['add h', 'add a']);

    bus.disconnect('b');
    await flush();
    expect(host.roster().map((p) => p.playerId)).toEqual(['h', 'a']);
    expect(calls(H)).toEqual(['add a', 'add b', 'remove b']);
    expect(calls(A)).toEqual(['add h', 'add b', 'remove b']);

    // The match starts with the two who are left: nobody is added or removed by it.
    host.start();
    await flush();
    expect(A.ctl.status().phase).toBe('playing');
    expect(calls(H)).toEqual(['add a', 'add b', 'remove b']);
    expect(calls(A)).toEqual(['add h', 'add b', 'remove b']);
  });

  it('a roster that comes before the panel is up opens nothing by itself: the players in it are connected once the media layer has attached', async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const ck = generateKeys();
    const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 3, hostParticipant: participant('h', hk), hostGame: game, clock });
    const client = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game, throwdownCode: 'M', hostId: 'h', clock });
    const H = seat(host, clock, 3);
    const C = seat(client, clock);
    // The shell's order at a join: the controller sees HELLO_ACK first, the panel (and the media) open after it.
    client.join();
    await flush();
    expect(C.ctl.status().participants.map((p) => p.playerId)).toEqual(['h', 'c']);
    expect(C.media.attachedWith).toBeNull();
    expect(calls(C)).toEqual([]);
    expect(calls(H)).toEqual([]);
    await C.ctl.open();
    expect(calls(C)).toEqual(['add h']);
    await H.ctl.open();
    expect(calls(H)).toEqual(['add c']);
  });

  it('a connection that has to be made again is closed first (A18: kept through the drop, dead at the return): naming a held peer no longer rebuilds it', async () => {
    const s = await rig();
    s.host.start();
    await flush();
    s.H.media.ice.c = 'connected';
    s.bus.disconnect('c');
    await flush();
    expect(calls(s.H)).toEqual(['add c']);
    s.H.media.ice.c = 'failed';
    s.host.events.emit('reconnected', { playerId: 'c', entries: 0, quiet: false });
    expect(s.H.media.added).toEqual(['c', 'c']);
    expect(s.H.media.removed).toEqual(['c']);
  });
});

describe("A17 step 2 (2026-11-24): the controller's share of what ends with a match", () => {
  /** Every `setSending` the media layer is given (the fake itself keeps changes only). */
  const countSending = (s: Seat): { calls: boolean[] } => {
    const calls: boolean[] = [];
    const orig = s.media.setSending.bind(s.media);
    s.media.setSending = (on: boolean): void => {
      calls.push(on);
      orig(on);
    };
    return { calls };
  };

  it('releaseMatch on a waiting player: the lock goes; the media stays attached with its peer and the role is still heard, so the turn still comes', async () => {
    const s = await rig(3);
    const sent = countSending(s.C);
    s.host.start();
    await flush();
    expect(s.C.locks).toEqual(['lock']);
    s.C.ctl.releaseMatch();
    expect(s.C.locks).toEqual(['lock', 'unlock']);
    expect(sent.calls).toEqual([false]);
    // Nothing of the lobby: the page and its peer, the listeners.
    expect(s.C.media.detached).toBe(false);
    expect(s.C.media.added).toEqual(['h']);
    expect(s.C.media.removed).toEqual([]);
    // A second call finds nothing to let go.
    s.C.ctl.releaseMatch();
    expect(s.C.locks).toEqual(['lock', 'unlock']);
    expect(sent.calls).toEqual([false]);
    // The match goes on over the same role: the host's ball ends and the client's grant arrives.
    s.H.ctl.feed({ kind: 'game_start', t: 0, players: 1 });
    s.H.ctl.feed(scores(500));
    s.H.ctl.feed(ballEnd(1));
    s.H.ctl.feed(scores(500));
    await flush();
    expect(s.C.ctl.status()).toMatchObject({ phase: 'playing', myTurn: true, locked: false });
    expect(sent.calls).toEqual([false, true]);

    // close() after it: the lobby's share (the media is detached), and "not sending" is said once more only because
    // a grant turned sending on since.
    await s.C.ctl.close();
    expect(s.C.media.detached).toBe(true);
    expect(sent.calls).toEqual([false, true, false]);
  });

  it('releaseMatch on the player who is up: a ball end that waits for its bonus score is dropped and "sending" goes off; close() right behind it (a teardown) says nothing twice', async () => {
    const s = await rig(3);
    const sent = countSending(s.H);
    s.host.start();
    await flush();
    s.H.ctl.feed({ kind: 'game_start', t: 0, players: 1 });
    s.H.ctl.feed(scores(500));
    s.H.ctl.feed(ballEnd(1));
    expect(sent.calls).toEqual([true]);
    expect(s.H.locks).toEqual(['lock', 'unlock']);
    s.H.ctl.releaseMatch();
    expect(sent.calls).toEqual([true, false]);
    // The table was the player's own already: no lock call. The ball end's 2 s wait is gone: nothing is reported.
    expect(s.H.locks).toEqual(['lock', 'unlock']);
    s.clock.advance(5000);
    await flush();
    expect(s.host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 1 });
    expect(s.H.media.detached).toBe(false);
    await s.H.ctl.close();
    expect(sent.calls).toEqual([true, false]);
    expect(s.H.locks).toEqual(['lock', 'unlock']);
    expect(s.H.media.detached).toBe(true);
  });

  it('close() alone is what it was: the lock off, "not sending" once, the media detached; in the lobby too, where the start countdown goes with it', async () => {
    const s = await rig(3);
    const sent = countSending(s.C);
    s.host.start();
    await flush();
    await s.C.ctl.close();
    expect(s.C.locks).toEqual(['lock', 'unlock']);
    expect(sent.calls).toEqual([false]);
    expect(s.C.media.detached).toBe(true);

    // The lobby: a start is counting down on both panels; releaseMatch leaves it, close() ends it.
    const l = await rig(3);
    l.H.ctl.feed({ kind: 'game_start', t: 0, players: 1 });
    await flush();
    expect(headerText(l.C.media.panel)).toBe('STARTING IN 5');
    l.C.ctl.releaseMatch();
    expect(l.C.ctl.panel().countdown).toBe(5);
    expect(l.C.media.detached).toBe(false);
    await l.C.ctl.close();
    expect(l.C.ctl.panel().countdown ?? null).toBeNull();
    expect(l.C.media.detached).toBe(true);
  });
});

describe('A17 step 4 (2026-11-24): End my ball, and a pause for the player who is up', () => {
  const gameStart: ControllerFeed = { kind: 'game_start', t: 0, players: 1 };
  const lastBallEnd = (host: HostMatch) => [...host.log.entries()].reverse().find((e) => e.message?.type === 'BALL_END')?.message;
  /** A started match with the host's ball 1 over at 500: the client is up. */
  async function clientUp(balls = 3) {
    const s = await rig(balls);
    s.host.start();
    await flush();
    s.H.ctl.feed(gameStart);
    s.H.ctl.feed(scores(500));
    s.H.ctl.feed(ballEnd(1));
    s.H.ctl.feed(scores(500));
    await flush();
    expect(s.C.ctl.status()).toMatchObject({ phase: 'playing', myTurn: true, locked: false });
    return s;
  }

  it("End my ball reports the grant's ball at the last score: a BALL_END of the player's own, `manual`, no shoot-again; the table locks and the turn passes", async () => {
    const s = await clientUp();
    const { host, client, H, C } = s;
    // Only the player who is up has a ball to end.
    expect(H.ctl.status().endBall).toBeNull();
    expect(H.ctl.endMyBall()).toBe(false);
    expect(H.logs.at(-1)).toBe('match: End my ball: nothing to end (this player does not hold the turn)');
    // Nothing reported from the table yet: the score is what the log has for this player. No game runs on the table:
    // nothing would be left on it.
    expect(C.ctl.status().endBall).toEqual({ grantSeq: host.state.currentGrant?.grant.grantSeq, ball: 1, score: 0, tableBall: false });
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(12_345_670));
    expect(C.ctl.status().endBall).toMatchObject({ ball: 1, score: 12_345_670 });
    const grant = host.state.currentGrant?.grant;
    const locks = C.locks.length;

    expect(C.ctl.endMyBall()).toBe(true);
    await flush();
    const m = lastBallEnd(host);
    expect(m).toMatchObject({ type: 'BALL_END', from: 'c', payload: { grantSeq: grant?.grantSeq, ballNumber: 1, finalScore: 12_345_670, detectorReason: 'manual', shootAgain: false } });
    expect(C.locks.slice(locks)).toEqual(['lock']);
    expect(C.ctl.status()).toMatchObject({ myTurn: false, locked: true, endBall: null });
    expect(C.media.sending.at(-1)).toBe(false);
    expect(C.logs).toContain('match: BALL_END ball 1 score 12345670 (ended by hand: End my ball)');
    // The turn passed: the host is up on ball 2, and both logs are the same log.
    expect(H.ctl.status()).toMatchObject({ myTurn: true, endBall: { ball: 2, score: 500 } });
    expect(host.state.players['c']).toMatchObject({ score: 12_345_670, ballsPlayed: 1 });
    expect(client.log.head()).toEqual(host.log.head());
    // The ball that was ended by hand drains on the table a moment later: nothing more is reported for it.
    const entries = host.log.length;
    C.ctl.feed(ballEnd(1));
    C.ctl.feed(scores(12_400_000));
    s.clock.advance(5000);
    await flush();
    expect(host.log.length).toBe(entries);
    expect(C.ctl.endMyBall()).toBe(false);
  });

  it('End my ball on the host, on a table that never reports anything: each ball ends at what the log has for that player, and the game still comes to its result', async () => {
    const s = await rig(1);
    const { host, H, C } = s;
    host.start();
    await flush();
    expect(H.ctl.status().endBall).toMatchObject({ ball: 1, score: 0 });
    expect(H.ctl.endMyBall()).toBe(true);
    await flush();
    expect(lastBallEnd(host)).toMatchObject({ from: 'h', payload: { ballNumber: 1, finalScore: 0, detectorReason: 'manual', shootAgain: false } });
    expect(C.ctl.status().endBall).toMatchObject({ ball: 1, score: 0 });
    expect(C.ctl.endMyBall()).toBe(true);
    await flush();
    expect(headerText(C.media.panel)).toBe('GAME 1 OVER');
    expect(headerText(H.media.panel)).toBe('GAME 1 OVER');
    expect(H.ctl.status().endBall).toBeNull();
    expect(C.ctl.status().endBall).toBeNull();
  });

  it('End my ball while the table has already ended the ball (its bonus score is waited for): that ball end is reported now, as the table said it, shoot-again included', async () => {
    const s = await clientUp();
    const { host, C } = s;
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(900));
    C.ctl.feed(ballEnd(1, 1));
    expect(C.ctl.endMyBall()).toBe(true);
    await flush();
    expect(lastBallEnd(host)).toMatchObject({ from: 'c', payload: { finalScore: 900, detectorReason: 'nvram', shootAgain: true } });
    // Shoot again: the same ball is granted again, and can be ended by hand like any other.
    expect(C.ctl.status()).toMatchObject({ myTurn: true, endBall: { ball: 1, score: 900 } });
  });

  it('the other PC knows nothing of End my ball (a companion up to 0.2.50: here its engine with no controller of this build): as the host it logs the ball end like any other and grants the next turn; as a client it folds it, takes its turn and signs the same log', async () => {
    // ---- an old host, a new client ----
    {
      const bus = new MemoryBus();
      const clock = new ManualClock();
      const hk = generateKeys();
      const ck = generateKeys();
      const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'OLDHST', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, clock });
      const client = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game, throwdownCode: 'OLDHST', hostId: 'h', clock });
      const rejects: string[] = [];
      host.on('reject', (r) => rejects.push(`${r.refType}:${r.code}`));
      const C = seat(client, clock);
      await C.ctl.open();
      client.join();
      await flush();
      host.start();
      await flush();
      // The host's own ball, as its table reports it; then the client ends its ball by hand.
      host.localBallEnd(500, 'nvram');
      await flush();
      expect(C.ctl.status().endBall).toMatchObject({ ball: 1, score: 0 });
      C.ctl.feed(scores(800));
      expect(C.ctl.endMyBall()).toBe(true);
      await flush();
      expect(rejects).toEqual([]);
      const ends = host.log.entries().filter((e) => e.message?.type === 'BALL_END').map((e) => (e.message?.type === 'BALL_END' ? `${e.message.from}:${e.message.payload.detectorReason}:${e.message.payload.finalScore}` : ''));
      expect(ends).toEqual(['h:nvram:500', 'c:manual:800']);
      // The game came to its result, with the client's signature under the log that holds the manual ball end.
      expect(host.state.phase).toBe('ended');
      expect(client.log.head()).toEqual(host.log.head());
      expect(headerText(C.media.panel)).toBe('GAME 1 OVER');
      expect(C.media.panel.result?.map((x) => [x.id, x.score])).toEqual([
        ['c', 800],
        ['h', 500],
      ]);
    }
    // ---- a new host, an old client ----
    {
      const bus = new MemoryBus();
      const clock = new ManualClock();
      const hk = generateKeys();
      const ck = generateKeys();
      const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'OLDCLI', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, clock });
      const client = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game, throwdownCode: 'OLDCLI', hostId: 'h', clock });
      const H = seat(host, clock, 1);
      await H.ctl.open();
      const seen: string[] = [];
      client.on('ballEnd', (m) => seen.push(`ballEnd ${m.from} ${m.payload.detectorReason} ${m.payload.finalScore}`));
      client.on('myTurn', (g) => seen.push(`myTurn ball ${g.ballNumber}`));
      client.on('dropped', (d) => seen.push(`dropped ${d.type}`));
      client.on('desync', () => seen.push('desync'));
      const results: Array<{ logMatches: boolean; signatureValid: boolean }> = [];
      client.on('result', (r) => results.push({ logMatches: r.logMatches, signatureValid: r.signatureValid }));
      client.join();
      await flush();
      host.start();
      await flush();
      H.ctl.feed(gameStart);
      H.ctl.feed(scores(4200));
      expect(H.ctl.endMyBall()).toBe(true);
      await flush();
      // What the old client was handed: an ordinary ball end of the host's, then its own grant.
      expect(seen).toEqual(['ballEnd h manual 4200', 'myTurn ball 1']);
      expect(client.state.players['h']).toMatchObject({ score: 4200, ballsPlayed: 1, status: 'finished' });
      client.reportBallEnd(3000, 'nvram');
      await flush();
      expect(results).toEqual([{ logMatches: true, signatureValid: true }]);
      expect(client.log.head()).toEqual(host.log.head());
      expect(H.media.panel.result?.map((x) => [x.id, x.score])).toEqual([
        ['h', 4200],
        ['c', 3000],
      ]);
    }
  });

  // ---- the review of PR 131, finding 1: the table owes a ball end ----
  const seqOf = (x: Seat): number => x.ctl.status().endBall?.grantSeq ?? -1;
  /** This player's ball ends in the host's log: `ball:how:score`, with `:again` for a shoot-again. */
  const endsOf = (host: HostMatch, from: string): string[] =>
    host.log.entries().flatMap((e) => (e.message?.type === 'BALL_END' && e.message.from === from ? [`${e.message.payload.ballNumber}:${e.message.payload.detectorReason}:${e.message.payload.finalScore}${e.message.payload.shootAgain ? ':again' : ''}`] : []));
  /** The host's ball `ball` ends on its table at `score`. */
  const hostBall = async (s: Awaited<ReturnType<typeof rig>>, ball: number, score: number): Promise<void> => {
    s.H.ctl.feed(scores(score));
    s.H.ctl.feed(ballEnd(ball));
    s.H.ctl.feed(scores(score));
    await flush();
  };
  /** The client is up on ball 1 with a game running on its table at 1200, and ends the ball by hand. */
  async function endedByHand(balls = 3) {
    const s = await clientUp(balls);
    s.C.ctl.feed(gameStart);
    s.C.ctl.feed(scores(1200));
    const seq = seqOf(s.C);
    expect(s.C.ctl.status().endBall).toEqual({ grantSeq: seq, ball: 1, score: 1200, tableBall: balls > 1 });
    expect(s.C.ctl.endMyBall(seq)).toBe(true);
    await flush();
    return { ...s, seq };
  }

  it("the table owes a ball end: a ball ended by hand drains during the other player's turn: nothing is reported for it, and the table's next ball end is the end of ball 2", async () => {
    const s = await endedByHand();
    const { host, H, C, seq } = s;
    expect(C.ctl.status().owedTableEnds).toEqual([seq]);
    expect(C.logs).toContain("match: End my ball with the table's ball still in play: the table owes the match that ball end; the ball is played out at this player's next turn, and its end reports nothing");
    // The ball drains while the host plays its ball 2 (the table is locked). `feed` says the match will never take it.
    expect(C.ctl.feed(ballEnd(1))).toBe(true);
    expect(C.ctl.feed(scores(1250))).toBe(false);
    expect(C.ctl.status().owedTableEnds).toEqual([]);
    expect(C.logs).toContain('match: the ball that was ended by hand has ended on the table: nothing is reported for it');
    await hostBall(s, 2, 900);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false, endBall: { ball: 2, tableBall: true } });
    expect(C.media.panel.message ?? '').not.toContain('still on the table');
    // The table's ball 2 is ball 2 of the match.
    C.ctl.feed(scores(3000));
    expect(C.ctl.feed(ballEnd(2))).toBe(false);
    C.ctl.feed(scores(3100));
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:manual:1200', '2:nvram:3100']);
    expect(H.ctl.status()).toMatchObject({ myTurn: true, endBall: { ball: 3 } });
  });

  it('the ball ended by hand is still on the table at the next grant: the panel says to play it out, its points count as they come, its end reports nothing, and the ball after it is ball 2', async () => {
    const s = await endedByHand();
    const { host, C, seq } = s;
    await hostBall(s, 2, 900);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false, owedTableEnds: [seq] });
    expect(owedBallLine(1, 2)).toBe('Your last ball is still on the table: play it out, then ball 2 begins');
    expect(C.media.panel.message).toBe(owedBallLine(1, 2));
    expect(C.logs.some((l) => l.endsWith('my ball 2 (the table still has the ball this player ended by hand: played out first, reporting nothing)'))).toBe(true);
    // The old ball's points are real: the others see them as they come.
    C.ctl.feed(scores(1800));
    s.clock.advance(2000);
    await flush();
    expect(s.H.media.panel.players.find((x) => x.id === 'c')?.score).toBe(1800);
    // It drains: no ball end for it, the turn stays, and the line goes.
    expect(C.ctl.feed(ballEnd(1))).toBe(true);
    C.ctl.feed(scores(1900));
    s.clock.advance(5000);
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:manual:1200']);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false, owedTableEnds: [] });
    expect(C.media.panel.message ?? '').not.toContain('still on the table');
    expect(C.logs).toContain('match: the ball that was ended by hand has ended on the table: nothing is reported for it; ball 2 begins now');
    // The next ball of the table is ball 2.
    C.ctl.feed(scores(2500));
    expect(C.ctl.feed(ballEnd(2))).toBe(false);
    C.ctl.feed(scores(2600));
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:manual:1200', '2:nvram:2600']);
  });

  it('the same player is granted again at once (the last one with balls left): the ball ended by hand is played out under the new grant, and only the ball end after its drain ends ball 2', async () => {
    const s = await rig(3);
    const { host, H } = s;
    host.start();
    await flush();
    host.forfeit('c', 'left');
    await flush();
    H.ctl.feed(gameStart);
    H.ctl.feed(scores(400));
    const seq = seqOf(H);
    const locks = H.locks.length;
    expect(H.ctl.endMyBall(seq)).toBe(true);
    await flush();
    // Ball 2 was granted inside the ball end itself: the table locked and unlocked, and the old ball is on it.
    expect(H.locks.slice(locks)).toEqual(['lock', 'unlock']);
    expect(H.ctl.status()).toMatchObject({ myTurn: true, locked: false, endBall: { ball: 2, score: 400 }, owedTableEnds: [seq] });
    expect(H.media.panel.message).toBe(owedBallLine(1, 2));
    H.ctl.feed(scores(650));
    expect(H.ctl.feed(ballEnd(1))).toBe(true);
    H.ctl.feed(scores(700));
    s.clock.advance(5000);
    await flush();
    expect(endsOf(host, 'h')).toEqual(['1:manual:400']);
    expect(H.ctl.status()).toMatchObject({ myTurn: true, owedTableEnds: [], endBall: { ball: 2, score: 700 } });
    H.ctl.feed(scores(1500));
    H.ctl.feed(ballEnd(2));
    H.ctl.feed(scores(1500));
    await flush();
    expect(endsOf(host, 'h')).toEqual(['1:manual:400', '2:nvram:1500']);
    expect(H.ctl.status()).toMatchObject({ myTurn: true, endBall: { ball: 3 } });
  });

  it('an extra ball on the ball that was ended by hand grants nothing: the machine serves the same ball again, it is still owed, and its real end is swallowed too', async () => {
    const s = await endedByHand();
    const { host, H, C, seq } = s;
    const entries = host.log.length;
    // The old ball drains with an extra ball lit, in the host's turn.
    expect(C.ctl.feed(ballEnd(1, 1))).toBe(true);
    await flush();
    expect(host.log.length).toBe(entries);
    expect(C.ctl.status()).toMatchObject({ myTurn: false, locked: true, owedTableEnds: [seq] });
    expect(H.ctl.status()).toMatchObject({ myTurn: true, endBall: { ball: 2 } });
    expect(C.logs).toContain('match: the ball that was ended by hand has ended on the table with an extra ball: it is still that ball, nothing is reported and nothing granted for it');
    // The client's next turn: the same table ball is still to be played out; a second extra ball changes nothing.
    await hostBall(s, 2, 900);
    expect(C.media.panel.message).toBe(owedBallLine(1, 2));
    expect(C.ctl.feed(ballEnd(1, 1))).toBe(true);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, owedTableEnds: [seq] });
    expect(C.ctl.feed(ballEnd(1))).toBe(true);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, owedTableEnds: [] });
    s.clock.advance(5000);
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:manual:1200']);
    // Ball 2 itself may still earn its own extra ball: that one is the match's.
    C.ctl.feed(scores(2000));
    C.ctl.feed(ballEnd(2, 1));
    C.ctl.feed(scores(2000));
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:manual:1200', '2:nvram:2000:again']);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, endBall: { ball: 2 } });
  });

  it('two balls ended by hand with no drain between owe two: both are played out at the next turn before ball 3, whose end is the third of the table', async () => {
    const s = await endedByHand();
    const { host, C, seq } = s;
    await hostBall(s, 2, 900);
    expect(C.media.panel.message).toBe(owedBallLine(1, 2));
    // The same ball is still on the table (stuck, say), and the player ends ball 2 by hand as well.
    const seq2 = seqOf(C);
    expect(C.ctl.status().endBall).toMatchObject({ ball: 2, score: 1200, tableBall: true });
    expect(C.ctl.endMyBall(seq2)).toBe(true);
    await flush();
    expect(C.ctl.status().owedTableEnds).toEqual([seq, seq2]);
    expect(C.logs).toContain("match: End my ball with the table's ball still in play: the table owes the match 2 ball ends; the ball is played out at this player's next turn, and its end reports nothing");
    await hostBall(s, 3, 1100);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, endBall: { ball: 3, tableBall: false } });
    expect(owedBallLine(2, 3)).toBe('Your last 2 balls are still on the table: play them out, then ball 3 begins');
    expect(C.media.panel.message).toBe(owedBallLine(2, 3));
    expect(C.ctl.feed(ballEnd(1))).toBe(true);
    expect(C.media.panel.message).toBe(owedBallLine(1, 3));
    expect(C.ctl.feed(ballEnd(2))).toBe(true);
    expect(C.media.panel.message ?? '').not.toContain('still on the table');
    s.clock.advance(5000);
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:manual:1200', '2:manual:1200']);
    C.ctl.feed(scores(5000));
    expect(C.ctl.feed(ballEnd(3))).toBe(false);
    C.ctl.feed(scores(5000));
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:manual:1200', '2:manual:1200', '3:nvram:5000']);
    expect(host.state.phase).toBe('ended');
  });

  it('nothing is owed where no ball end will come: a table whose ball ends Castcade cannot read (the witness says so), no game running on the table, and the last ball of the game', async () => {
    // ---- the witness says this table reports no ball ends ----
    {
      const s = await clientUp();
      const { C } = s;
      C.ctl.setLocalBallEnds(false, 'This machine does not report its ball ends');
      C.ctl.feed(gameStart);
      C.ctl.feed(scores(700));
      const seq = seqOf(C);
      expect(C.ctl.status().endBall).toEqual({ grantSeq: seq, ball: 1, score: 700, tableBall: false });
      expect(C.ctl.endMyBall(seq)).toBe(true);
      await flush();
      expect(C.ctl.status().owedTableEnds).toEqual([]);
      await hostBall(s, 2, 900);
      expect(C.ctl.status()).toMatchObject({ myTurn: true, endBall: { ball: 2, tableBall: false } });
      expect(C.media.panel.message ?? '').not.toContain('still on the table');
    }
    // ---- the witness learns it only after the ball was ended by hand: what was noted is dropped ----
    {
      const s = await endedByHand();
      expect(s.C.ctl.status().owedTableEnds).toEqual([s.seq]);
      s.C.ctl.setLocalBallEnds(false, null);
      expect(s.C.ctl.status().owedTableEnds).toEqual([]);
    }
    // ---- no game running on the table ----
    {
      const s = await clientUp();
      const seq = seqOf(s.C);
      expect(s.C.ctl.status().endBall).toMatchObject({ tableBall: false });
      expect(s.C.ctl.endMyBall(seq)).toBe(true);
      await flush();
      expect(s.C.ctl.status().owedTableEnds).toEqual([]);
    }
    // ---- the last ball of the game: the rest of the table's game is not the match's (A16) ----
    {
      const s = await endedByHand(1);
      expect(s.C.ctl.status().owedTableEnds).toEqual([]);
      expect(s.host.state.phase).toBe('ended');
      // What the table says of that game afterwards is nothing to the match.
      expect(s.C.ctl.feed(ballEnd(1))).toBe(true);
    }
  });

  it("the owed ball end goes with the table's game: its end, its abandonment, the table closing, a new game on the table", async () => {
    const over: ControllerFeed[] = [gameEnd(1300), { kind: 'game_abandoned', t: 0, scores: [1300], player: 1, ball: 1 }, { kind: 'table_exit' }, gameStart];
    for (const ev of over) {
      const s = await endedByHand();
      expect(s.C.ctl.status().owedTableEnds).toEqual([s.seq]);
      s.C.ctl.feed(ev);
      expect([ev.kind, s.C.ctl.status().owedTableEnds]).toEqual([ev.kind, []]);
    }
    // A game start that is fed again (after a reconnect, or read from the journal after a restart) is the start of
    // the game the ball was ended in: what the table owes stays.
    const s = await endedByHand();
    s.C.ctl.feed(gameStart, true);
    s.C.ctl.feed(scores(1200), true);
    expect(s.C.ctl.status().owedTableEnds).toEqual([s.seq]);
    expect(s.C.ctl.feed(ballEnd(1), true)).toBe(true);
    expect(s.C.ctl.status().owedTableEnds).toEqual([]);
  });

  it("Pass the turn is an end by hand too: on the passed player's PC the ball still in play is owed and played out at the next turn; a ball the table had already ended, or a table that reports no ball ends, owes nothing", async () => {
    // ---- the ball is in play when the host passes the client's turn ----
    {
      const s = await clientUp();
      const { host, H, C } = s;
      C.ctl.feed(gameStart);
      C.ctl.feed(scores(700));
      const seq = seqOf(C);
      expect(H.ctl.passTurn()).toBe(true);
      await flush();
      expect(C.ctl.status()).toMatchObject({ myTurn: false, locked: true, owedTableEnds: [seq] });
      expect(C.logs).toContain("match: the turn was passed with this table's ball still in play: the table owes the match that ball end; the ball is played out at this player's next turn, and its end reports nothing");
      await hostBall(s, 2, 900);
      expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false });
      expect(C.media.panel.message).toBe(owedBallLine(1, 2));
      expect(C.ctl.feed(ballEnd(1))).toBe(true);
      s.clock.advance(5000);
      await flush();
      expect(endsOf(host, 'c')).toEqual([]);
      expect(C.ctl.status()).toMatchObject({ myTurn: true, owedTableEnds: [] });
      C.ctl.feed(scores(2000));
      C.ctl.feed(ballEnd(2));
      C.ctl.feed(scores(2000));
      await flush();
      expect(endsOf(host, 'c')).toEqual(['2:nvram:2000']);
    }
    // ---- the table had ended the ball (its bonus was being waited for) ----
    {
      const s = await clientUp();
      const { H, C } = s;
      C.ctl.feed(gameStart);
      C.ctl.feed(scores(700));
      C.ctl.feed(ballEnd(1));
      expect(H.ctl.passTurn()).toBe(true);
      await flush();
      expect(C.ctl.status()).toMatchObject({ myTurn: false, owedTableEnds: [] });
    }
    // ---- a table that reports no ball ends: the pass is the only end there is ----
    {
      const s = await clientUp();
      const { H, C } = s;
      C.ctl.setLocalBallEnds(false, null);
      C.ctl.feed(gameStart);
      C.ctl.feed(scores(700));
      expect(H.ctl.passTurn()).toBe(true);
      await flush();
      expect(C.ctl.status()).toMatchObject({ myTurn: false, owedTableEnds: [] });
    }
    // ---- the table had ended the ball and this PC had reported it, into a link that lost the report: the host passes ----
    {
      const s = await clientUp();
      const { bus, host, H, C } = s;
      C.ctl.feed(gameStart);
      C.ctl.feed(scores(700));
      const route = bus.route.bind(bus);
      bus.route = (from, to, msg) => {
        if (from === 'c' && msg.type === 'BALL_END') return;
        route(from, to, msg);
      };
      C.ctl.feed(ballEnd(1));
      C.ctl.feed(scores(750));
      await flush();
      expect(C.logs).toContain('match: BALL_END ball 1 score 750');
      expect(endsOf(host, 'c')).toEqual([]);
      expect(H.ctl.passTurn()).toBe(true);
      await flush();
      // The table's ball 1 is over, as this PC knows: nothing is owed, and ball 2's end will be ball 2's.
      expect(C.ctl.status()).toMatchObject({ myTurn: false, locked: true, owedTableEnds: [] });
    }
    // ---- the host's own ball, passed by the host with its ball in play ----
    {
      const s = await rig(3);
      const { host, H } = s;
      host.start();
      await flush();
      H.ctl.feed(gameStart);
      H.ctl.feed(scores(300));
      const seq = seqOf(H);
      expect(H.ctl.passTurn()).toBe(true);
      await flush();
      expect(H.ctl.status()).toMatchObject({ myTurn: false, locked: true, owedTableEnds: [seq] });
      expect(H.ctl.feed(ballEnd(1))).toBe(true);
      expect(H.ctl.status().owedTableEnds).toEqual([]);
    }
  });

  it('a ball end of the table that comes with no grant held and nothing owed is one the match will never take: `feed` says so, for the shell to forget it', async () => {
    const s = await clientUp();
    const { H, C } = s;
    // The host's ball 1 is reported and over: its table says "ball end" once more (the client is up).
    expect(H.ctl.feed(ballEnd(1))).toBe(true);
    // An end the match takes is not one of those, nor is any other event.
    C.ctl.feed(gameStart);
    expect(C.ctl.feed(scores(100))).toBe(false);
    expect(C.ctl.feed(ballEnd(1))).toBe(false);
    expect(C.ctl.feed(ballEnd(1))).toBe(false);
  });

  // ---- finding 3: a confirmation is for one grant ----
  it('End my ball names the grant it was asked about: after the table ended that ball with an extra ball, the same ball number under a new grant is not ended by the old answer', async () => {
    const s = await clientUp();
    const { host, C } = s;
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(1_000_000));
    const asked = seqOf(C);
    // The table ends the ball with an extra ball before the player answers: ball 1 is granted again.
    C.ctl.feed(ballEnd(1, 1));
    C.ctl.feed(scores(1_050_000));
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:nvram:1050000:again']);
    const now = seqOf(C);
    expect(now).not.toBe(asked);
    expect(C.ctl.status().endBall).toMatchObject({ grantSeq: now, ball: 1, score: 1_050_000 });
    expect(C.ctl.endMyBall(asked)).toBe(false);
    await flush();
    expect(C.logs.at(-1)).toBe(`match: End my ball: the question was about another grant (${asked}; this ball is played under ${now}): nothing ended`);
    expect(endsOf(host, 'c')).toEqual(['1:nvram:1050000:again']);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false, owedTableEnds: [] });
    // Asked again for this grant, it ends.
    expect(C.ctl.endMyBall(now)).toBe(true);
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:nvram:1050000:again', '1:manual:1050000']);
  });

  // ---- finding 5: a manual end that never reached the host ----
  it('a ball ended by hand whose report never reached the host is sent again, once, when the grant for that ball comes back under a new number; the table stays locked and what it owes follows the new grant', async () => {
    const s = await clientUp();
    const { bus, host, C } = s;
    const rejects: string[] = [];
    host.on('reject', (r) => rejects.push(`${r.refType}:${r.code}`));
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(1200));
    const seq = seqOf(C);
    // The report goes into a dead link: the bus loses this one frame.
    const route = bus.route.bind(bus);
    let lost = 0;
    bus.route = (from, to, msg) => {
      if (from === 'c' && msg.type === 'BALL_END' && lost === 0) {
        lost += 1;
        return;
      }
      route(from, to, msg);
    };
    const locks = C.locks.length;
    expect(C.ctl.endMyBall(seq)).toBe(true);
    await flush();
    expect(lost).toBe(1);
    expect(endsOf(host, 'c')).toEqual([]);
    expect(C.ctl.status()).toMatchObject({ myTurn: false, locked: true, owedTableEnds: [seq] });
    // The host pauses and resumes (its owner pressed Resume; a restarted host does the same): the grant for the
    // client's ball 1 is issued again under a new number.
    host.pause('requested', null);
    host.resume();
    await flush();
    const again = host.state.currentGrant?.grant;
    expect(again).toMatchObject({ player: 'c', ballNumber: 1 });
    expect(again?.grantSeq).not.toBe(seq);
    expect(C.logs).toContain(`match: grant ${again?.grantSeq}: ball 1 again, which this player had ended by hand (that report never reached the host): sent for this grant`);
    // Not inside the grant itself (the engine's own resend after a reconnect comes first), a moment later.
    expect(endsOf(host, 'c')).toEqual([]);
    s.clock.advance(0);
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:manual:1200']);
    expect(host.log.entries().flatMap((e) => (e.message?.type === 'BALL_END' && e.message.from === 'c' ? [e.message.payload.grantSeq] : []))).toEqual([again?.grantSeq]);
    expect(rejects).toEqual([]);
    // The table never unlocked for the grant that came back, and the "your turn" cue did not sound for it.
    expect(C.locks.slice(locks).filter((l) => l === 'unlock')).toEqual([]);
    expect(C.ctl.status()).toMatchObject({ myTurn: false, locked: true, owedTableEnds: [again?.grantSeq] });
    // The host is up on ball 2; nothing more is sent for ball 1.
    expect(host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 2 });
    s.clock.advance(5000);
    await flush();
    expect(endsOf(host, 'c')).toEqual(['1:manual:1200']);
  });

  it('paused for the player up with the picture arriving: spectate; and not during the pause itself is a ball ended by hand', async () => {
    const s = await clientUp();
    const { H, C } = s;
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(700));
    await flush();
    // The client's link to the host drops while it is up: the match pauses for it (no grace in this rig).
    s.bus.disconnect('c');
    await flush();
    const p = H.media.panel;
    expect(p).toMatchObject({ phase: 'paused', myTurn: false, playerUp: 'c', ball: 1, pausedFor: 'c', message: 'Paused: waiting for Krobs to reconnect' });
    expect(pausedForPlayerUp(p)).toBe(true);
    // Their picture still arrives on this PC (the shell's word): what a watcher saw stays. It does not: the panel.
    expect(vrViewMode(p, DEFAULT_VR_VIEW, { upAway: true })).toBe('theater');
    expect(vrViewMode(p, { ...DEFAULT_VR_VIEW, spectate: 'panel' }, { upAway: true })).toBe('panel');
    expect(vrViewMode(p, DEFAULT_VR_VIEW, { upAway: false })).toBe('panel');
    expect(vrViewMode(p)).toBe('panel');
    // The menu and an initials hold of this player's own still come first.
    expect(vrViewMode(p, DEFAULT_VR_VIEW, { upAway: true, menuOpen: true })).toBe('panel');
    expect(vrViewMode(p, DEFAULT_VR_VIEW, { upAway: true, initialsHold: true })).toBe('hidden');
    // The scoreboard is what says who is away.
    expect(scoreboardView(p)?.title).toBe('KROBS AWAY · GAME 1 · BALL 1 OF 3');
    // The host is not up and has nothing to end; a pause is not the moment for it either.
    expect(H.ctl.status().endBall).toBeNull();
    // The player who is away does not know it is paused (its link is down) and plays on: its own view is its own.
    expect(C.ctl.status().phase).toBe('playing');
  });

  it('vrViewMode: `upAway` counts only in a pause for the player who is up, with their ball in play, on a PC that watches', () => {
    const base = { phase: 'paused' as const, myTurn: false, playerUp: 'krobs', ball: 2, pausedFor: 'krobs' };
    expect(vrViewMode(base, DEFAULT_VR_VIEW, { upAway: true })).toBe('theater');
    // A pause for somebody else, or of another kind (no `pausedFor`): the panel says why, as before.
    expect(vrViewMode({ ...base, pausedFor: 'chuck' }, DEFAULT_VR_VIEW, { upAway: true })).toBe('panel');
    expect(vrViewMode({ ...base, pausedFor: null }, DEFAULT_VR_VIEW, { upAway: true })).toBe('panel');
    expect(vrViewMode({ phase: 'paused', myTurn: false, playerUp: 'krobs', ball: 2 }, DEFAULT_VR_VIEW, { upAway: true })).toBe('panel');
    // Their ball is over (the pause came at their next grant): nothing to keep.
    expect(vrViewMode({ ...base, ball: null }, DEFAULT_VR_VIEW, { upAway: true })).toBe('panel');
    // My own ball: D8.14's rule, untouched by this one.
    expect(vrViewMode({ ...base, myTurn: true, playerUp: 'me', pausedFor: 'me' }, DEFAULT_VR_VIEW, { upAway: true })).toBe('hidden');
    // While playing the fact changes nothing.
    expect(vrViewMode({ ...base, phase: 'playing', pausedFor: null }, DEFAULT_VR_VIEW, { upAway: true })).toBe('theater');
    expect(pausedForPlayerUp({ ...base, phase: 'playing' })).toBe(false);
    expect(pausedForPlayerUp({ ...base, myTurn: true })).toBe(false);
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
    expect(vrViewMode(at('paused', false, 'krobs'))).toBe('panel');
    expect(vrViewMode(at('over', false, null))).toBe('panel');
  });

  it('D8.14: a pause during my own live ball puts nothing over my table; the panel comes once the ball has ended', () => {
    expect(vrViewMode({ ...at('paused', true, 'me'), ball: 2 })).toBe('hidden');
    expect(vrViewMode(at('paused', true, 'me'))).toBe('hidden');
    expect(vrViewMode({ ...at('paused', true, 'me'), ball: null })).toBe('panel');
    expect(vrViewMode({ ...at('paused', false, 'krobs'), ball: 2 })).toBe('panel');
    expect(vrViewMode({ ...at('paused', true, 'me'), ball: 2 }, { theaterDuringMyTurn: 'panel', spectate: 'theater' })).toBe('panel');
    expect(vrViewMode({ ...at('paused', true, 'me'), ball: 2 }, DEFAULT_VR_VIEW, { menuOpen: true })).toBe('panel');
  });

  it('the two settings: the panel on my ball, the panel on theirs', () => {
    expect(vrViewMode(at('playing', true, 'me'), { theaterDuringMyTurn: 'panel', spectate: 'theater' })).toBe('panel');
    expect(vrViewMode(at('playing', false, 'krobs'), { theaterDuringMyTurn: 'hidden', spectate: 'panel' })).toBe('panel');
    expect(vrViewMode(at('idle', false, null), { theaterDuringMyTurn: 'hidden', spectate: 'theater' })).toBe('panel');
  });

  it('A16.2: during an initials hold the headset shows what it shows on my own ball, whoever is up and after the result; the menu still wins', () => {
    const hold = { initialsHold: true };
    expect(vrViewMode(at('playing', false, 'krobs'), DEFAULT_VR_VIEW, hold)).toBe('hidden');
    expect(vrViewMode(at('playing', false, null), DEFAULT_VR_VIEW, hold)).toBe('hidden');
    expect(vrViewMode(at('over', false, null), DEFAULT_VR_VIEW, hold)).toBe('hidden');
    expect(vrViewMode(at('paused', false, 'krobs'), DEFAULT_VR_VIEW, hold)).toBe('hidden');
    expect(vrViewMode(at('playing', false, 'krobs'), { theaterDuringMyTurn: 'panel', spectate: 'theater' }, hold)).toBe('panel');
    expect(vrViewMode(at('playing', false, 'krobs'), DEFAULT_VR_VIEW, { initialsHold: true, menuOpen: true })).toBe('panel');
    expect(vrViewMode(at('playing', false, 'krobs'), DEFAULT_VR_VIEW, { initialsHold: false })).toBe('theater');
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

  it("A16 (2026-11-15, match LPHDUW): the table stays unlocked after my last ball until its own game ends (initials), and that game's end is never the next game's", async () => {
    const s = await rig(1);
    const { host, clock, H, C } = s;
    host.start();
    await flush();
    H.ctl.feed(gameStart);
    H.ctl.feed(scores(500));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(scores(500));
    H.ctl.feed(gameEnd(500));
    await flush();
    // The client's only ball ends at 82,347,460; the machine asks for initials, so its game is not over yet.
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(82_347_460));
    C.ctl.feed(ballEnd(1));
    C.ctl.feed(scores(82_347_460));
    await flush();
    expect(headerText(C.media.panel)).toBe('GAME 1 OVER');
    expect(host.state.players['c']).toMatchObject({ score: 82_347_460, status: 'finished' });
    // Unlocked for the initials, although a client's table is locked between games.
    expect(C.ctl.status().locked).toBe(false);
    expect(C.logs.some((l) => l.includes("the table's own game is still on"))).toBe(true);
    // The host starts game 2 and plays its ball; the client is still at the initials when its turn comes.
    H.ctl.feed(gameStart);
    await flush();
    expect(host.state.gameNumber).toBe(2);
    expect(C.ctl.status().locked).toBe(false);
    H.ctl.feed(scores(900));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(scores(900));
    H.ctl.feed(gameEnd(900));
    await flush();
    expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false });
    // The old game's last words (the match bonus, then its end) are not game 2's: no score, no ball end, no GAME_OVER.
    const gameOvers: string[] = [];
    host.on('gameOver', (m) => gameOvers.push(m.from));
    C.ctl.feed(scores(93_465_460));
    C.ctl.feed(gameEnd(93_465_460));
    await flush();
    expect(gameOvers).toEqual([]);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false });
    expect(host.state.players['c']).toMatchObject({ ballsPlayed: 0, status: 'playing' });
    expect(C.media.panel.players.find((x) => x.id === 'c')?.score ?? null).toBeNull();
    expect(C.logs.some((l) => l.includes("the table's finished game ended; nothing reported for it"))).toBe(true);
    // Game 2 on the client's table then plays as any game does.
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(1200));
    C.ctl.feed(ballEnd(1));
    C.ctl.feed(scores(1200));
    C.ctl.feed(gameEnd(1200));
    await flush();
    expect(headerText(C.media.panel)).toBe('GAME 2 OVER');
    expect(host.state.players['c']).toMatchObject({ score: 1200, status: 'finished' });
    expect(C.ctl.status().locked).toBe(true);
    void clock;
  });

  it('A16: a table game that never ends keeps the table unlocked for three minutes only; a new game on it ends the wait at once', async () => {
    const s = await rig(1);
    const { host, clock, H, C } = s;
    host.start();
    await flush();
    H.ctl.feed(gameStart);
    H.ctl.feed(scores(500));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(scores(500));
    await flush();
    // The host's game is done while the client plays: unlocked for its ending, then locked again by the clock.
    expect(H.ctl.status()).toMatchObject({ myTurn: false, locked: false });
    clock.advance(SPENT_UNLOCK_MS - 1);
    expect(H.ctl.status().locked).toBe(false);
    clock.advance(1);
    expect(H.ctl.status().locked).toBe(true);
    // The client: the same wait, ended by a game started on its table (locked: the game is between games' business).
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(800));
    C.ctl.feed(ballEnd(1));
    C.ctl.feed(scores(800));
    await flush();
    expect(C.ctl.status().locked).toBe(false);
    C.ctl.feed(gameStart);
    expect(C.ctl.status().locked).toBe(true);
  });

  // ---- A16.2 (2026-11-15, match NQYJGN on Congo / congo_21): the high-score initials hold ----
  const GC = 1_701_234_940;
  const highScores = (...entries: [string | null, number][]): ControllerFeed => ({
    kind: 'high_scores_changed',
    t: 0,
    entries: entries.map(([initials, score]) => ({ label: null, shortLabel: null, initials, score })),
  });
  /** The host's only ball on a WPC machine: the game end comes with the ball's end, before the initials. */
  async function hostFinishesAt(score: number, qualifies: (score: number) => boolean) {
    const asked: number[] = [];
    const s = await rig(1, game, undefined, { highScoreQualifies: (x) => (asked.push(x), qualifies(x)) });
    s.host.start();
    await flush();
    s.H.ctl.feed(gameStart);
    s.H.ctl.feed(scores(score));
    s.H.ctl.feed(ballEnd(1));
    s.H.ctl.feed(gameEnd(score));
    s.H.ctl.feed(scores(score));
    await flush();
    return { ...s, asked };
  }

  it('A16.2: a score that makes the high-score list holds the table for the initials although the game end came with the last ball; the match goes on', async () => {
    const { host, clock, H, C, asked } = await hostFinishesAt(GC, () => true);
    expect(asked).toEqual([GC]);
    expect(host.state.players['h']).toMatchObject({ score: GC, ballsPlayed: 1 });
    // The next grant was not delayed: the client is up. The host's table is unlocked all the same.
    expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false });
    expect(H.ctl.status()).toMatchObject({ myTurn: false, locked: false, initialsHold: true });
    // Locked at MATCH_READY, unlocked by the grant, and never locked since.
    expect(H.locks).toEqual(['lock', 'unlock']);
    expect(H.media.panel.message).toBe(INITIALS_HOLD_MESSAGE);
    expect(H.media.panel).toMatchObject({ phase: 'playing', myTurn: false, playerUp: 'c' });
    // The headset: the other player's picture by the turn, the host's own table by the hold.
    expect(vrViewMode(H.media.panel, DEFAULT_VR_VIEW)).toBe('theater');
    expect(vrViewMode(H.media.panel, DEFAULT_VR_VIEW, { initialsHold: H.ctl.status().initialsHold })).toBe('hidden');
    expect(H.logs.some((l) => l.startsWith(`match: initials hold on: my score ${GC} is on the table's high-score list`))).toBe(true);
    // Nothing the table says during the hold is reported into the match.
    const states: number[] = [];
    host.on('state', (m) => m.from === 'h' && states.push(m.payload.score));
    H.ctl.feed(scores(GC + 10));
    H.ctl.feed(ballEnd(1));
    await flush();
    expect(states).toEqual([]);
    expect(host.state.players['h']).toMatchObject({ score: GC, ballsPlayed: 1 });
    // The machine writes the entry; five quiet seconds later the turn lock rules again.
    H.ctl.feed(highScores(['JTM', GC], ['AAA', 900]));
    clock.advance(INITIALS_QUIET_MS - 1);
    expect(H.ctl.status()).toMatchObject({ locked: false, initialsHold: true });
    clock.advance(1);
    expect(H.ctl.status()).toMatchObject({ locked: true, initialsHold: false });
    expect(H.media.panel.message).not.toBe(INITIALS_HOLD_MESSAGE);
    expect(H.logs.some((l) => l.startsWith('match: initials hold over: the table wrote its high-score list (JTM '))).toBe(true);
    // The cap timer went with the hold: nothing more happens when it would have fired.
    clock.advance(INITIALS_HOLD_CAP_MS);
    expect(H.logs.filter((l) => l.startsWith('match: initials hold over')).length).toBe(1);
  });

  it('A16.2: a list that shows my score with no initials yet keeps the hold on; each write starts the quiet time again', async () => {
    const { clock, H } = await hostFinishesAt(GC, () => true);
    // The machine puts the score on the list first.
    H.ctl.feed(highScores([null, GC], ['AAA', 900]));
    clock.advance(INITIALS_QUIET_MS);
    expect(H.ctl.status()).toMatchObject({ locked: false, initialsHold: true });
    expect(H.logs.some((l) => l.includes(`has my score ${GC} with no initials yet`))).toBe(true);
    // Then the initials, in two writes less than the quiet time apart.
    H.ctl.feed(highScores(['J  ', GC], ['AAA', 900]));
    clock.advance(INITIALS_QUIET_MS - 1);
    H.ctl.feed(highScores(['JTM', GC], ['AAA', 900]));
    clock.advance(INITIALS_QUIET_MS - 1);
    expect(H.ctl.status().initialsHold).toBe(true);
    clock.advance(1);
    expect(H.ctl.status()).toMatchObject({ locked: true, initialsHold: false });
  });

  it('A16.2: with no high-score write seen (an older patch) the hold ends at the cap', async () => {
    const { clock, H } = await hostFinishesAt(GC, () => true);
    clock.advance(INITIALS_HOLD_CAP_MS - 1);
    expect(H.ctl.status()).toMatchObject({ locked: false, initialsHold: true });
    clock.advance(1);
    expect(H.ctl.status()).toMatchObject({ locked: true, initialsHold: false });
    expect(H.logs).toContain(`match: initials hold over: no high-score entry seen after ${INITIALS_HOLD_CAP_MS / 1000} s`);
    // A write after the hold is nobody's business.
    H.ctl.feed(highScores(['JTM', GC]));
    clock.advance(INITIALS_QUIET_MS);
    expect(H.logs.filter((l) => l.startsWith('match: initials hold over')).length).toBe(1);
  });

  it('A16.2: a new game started on the table ends the hold at once and is handled as ever; so does the table closing', async () => {
    const a = await hostFinishesAt(GC, () => true);
    a.H.ctl.feed(gameStart);
    expect(a.H.ctl.status()).toMatchObject({ locked: true, initialsHold: false });
    expect(a.H.logs).toContain('match: initials hold over: a new game started on the table');
    // Game 1 is still on (the client is up): the host's game_start starts nothing.
    expect(a.host.state.gameNumber).toBe(1);
    const b = await hostFinishesAt(GC, () => true);
    b.H.ctl.feed({ kind: 'table_exit' });
    expect(b.H.ctl.status()).toMatchObject({ locked: true, initialsHold: false });
    expect(b.H.logs).toContain('match: initials hold over: the table closed');
  });

  it('A16.2: a score that does not make the list locks the table at once, as before; so does a table with nothing to ask', async () => {
    const no = await hostFinishesAt(500, () => false);
    expect(no.asked).toEqual([500]);
    expect(no.H.ctl.status()).toMatchObject({ myTurn: false, locked: true, initialsHold: false });
    expect(no.H.media.panel.message).not.toBe(INITIALS_HOLD_MESSAGE);
    expect(no.H.logs.some((l) => l.includes('initials hold'))).toBe(false);
    // No `highScoreQualifies` at all (an original table, a test witness): the plain rig.
    const s = await rig(1);
    s.host.start();
    await flush();
    s.H.ctl.feed(gameStart);
    s.H.ctl.feed(scores(GC));
    s.H.ctl.feed(ballEnd(1));
    s.H.ctl.feed(gameEnd(GC));
    await flush();
    expect(s.H.ctl.status()).toMatchObject({ locked: true, initialsHold: false });
  });

  it('A16.2: the last player of the game: the hold runs across the RESULT (a client stays unlocked, the line asks for the initials) and ends with the match', async () => {
    const s = await rig(1, game, undefined, { highScoreQualifies: (x) => x === GC });
    const { host, H, C } = s;
    host.start();
    await flush();
    H.ctl.feed(gameStart);
    H.ctl.feed(scores(500));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(gameEnd(500));
    await flush();
    expect(H.ctl.status().initialsHold).toBe(false);
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(GC));
    C.ctl.feed(ballEnd(1));
    C.ctl.feed(gameEnd(GC));
    await flush();
    expect(headerText(C.media.panel)).toBe('GAME 1 OVER');
    // Between games a client's table is locked; not while it enters its initials.
    expect(C.ctl.status()).toMatchObject({ phase: 'over', locked: false, initialsHold: true });
    expect(C.media.panel.message).toBe(INITIALS_HOLD_MESSAGE);
    expect(vrViewMode(C.media.panel, DEFAULT_VR_VIEW, { initialsHold: true })).toBe('hidden');
    // The A16 window is not open (the table's game ended with the ball): the hold alone keeps the table.
    expect(C.logs.some((l) => l.includes("the table's own game is still on"))).toBe(false);
    H.ctl.endMatch();
    await flush();
    expect(C.ctl.status()).toMatchObject({ locked: false, initialsHold: false });
    expect(C.logs).toContain('match: initials hold over: the match ended');
  });

  it("A16.2 beside A16: a machine whose game ends after the initials: both hold the table; the game's end closes A16's window, the high-score write the hold", async () => {
    const s = await rig(1, game, undefined, { highScoreQualifies: () => true });
    const { host, clock, H } = s;
    host.start();
    await flush();
    H.ctl.feed(gameStart);
    H.ctl.feed(scores(GC));
    H.ctl.feed(ballEnd(1));
    H.ctl.feed(scores(GC));
    await flush();
    expect(H.ctl.status()).toMatchObject({ myTurn: false, locked: false, initialsHold: true });
    expect(H.logs.some((l) => l.includes("the table's own game is still on"))).toBe(true);
    // The initials go in, then the machine ends its game: nothing of it is reported, and the hold ends on the quiet time.
    H.ctl.feed(highScores(['JTM', GC]));
    H.ctl.feed(gameEnd(GC));
    expect(H.ctl.status()).toMatchObject({ locked: false, initialsHold: true });
    clock.advance(INITIALS_QUIET_MS);
    expect(H.ctl.status()).toMatchObject({ locked: true, initialsHold: false });
    expect(host.state.players['h']).toMatchObject({ score: GC, ballsPlayed: 1 });
  });

  // ---- B26 (2026-11-16, "a midnight madness happened for Krobs"), B26.4: the flag is the ROM's own count, never the clock ----
  const DAY_MS = 86_400_000;
  const MINUTE = 60_000;
  const KROBS_LINE = "Midnight Madness ran on Krobs' ball 1 (counted by that table's ROM)";
  const MY_LINE = "Midnight Madness ran on your ball 1 (counted by your table's ROM)";
  /** The witness's event: the ROM's audit went up while the table's game was in play. */
  const midnightRan = (from = 3, ball = 1): ControllerFeed => ({ kind: 'midnight_madness', t: 0, audit: 'B.4 31 SPECIAL MODES', from, to: from + 1, player: 1, ball });
  /** One ball of `seat`, `ms` long, ending at `score`; `last`: the table's game ends with it; `midnight`: the mode starts in it. */
  const playBall = async (seat: Seat, clock: ManualClock, ball: number, score: number, ms: number, last: boolean, midnight = false): Promise<void> => {
    if (ball === 1) seat.ctl.feed(gameStart);
    seat.ctl.feed(scores(score));
    clock.advance(ms / 2);
    if (midnight) seat.ctl.feed(midnightRan(3, ball));
    clock.advance(ms / 2);
    seat.ctl.feed(ballEnd(ball));
    seat.ctl.feed(scores(score));
    if (last) seat.ctl.feed(gameEnd(score));
    await flush();
  };
  const midnightFlagged = (p: PanelState): string[] => p.players.filter((x) => x.flags.includes('midnight')).map((x) => x.id);

  it('B26.4: the lines state a fact (the wording lives in witness/midnight.ts)', () => {
    expect(KROBS_LINE).toBe(midnightLine('Krobs', 1));
    expect(MY_LINE).toBe(midnightLine(null, 1));
  });

  it("B26.4: the ROM counting a Midnight Madness during a player's ball flags that ball for every player at once: the log, the line, the row, the result; no score, turn or log entry changes", async () => {
    const { host, client, clock, H, C } = await rig(1);
    host.start();
    await flush();
    // The host's ball: nothing counted, nothing flagged.
    await playBall(H, clock, 1, 500, 5 * MINUTE, true);
    expect(H.ctl.status().advisories).toEqual([]);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, advisories: [] });
    // Krobs' ball: his table's ROM counts one in the middle of it. Both seats know before the ball is over.
    const logged = host.log.length;
    C.ctl.feed(gameStart);
    C.ctl.feed(scores(400));
    C.ctl.feed(midnightRan(3));
    await flush();
    expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false, advisories: [MY_LINE] });
    expect(H.ctl.status().advisories).toEqual([KROBS_LINE]);
    expect(C.media.panel.message).toBe(MY_LINE);
    expect(H.media.panel.message).toBe(KROBS_LINE);
    expect(C.logs).toContain("match: Midnight Madness ran on my ball 1 of game 1: the ROM's audit B.4 31 SPECIAL MODES went from 3 to 4 during the game; flagged for every player (a flag only: no score or result changes)");
    expect(H.logs).toContain("match: Midnight Madness ran on Krobs' ball 1 of game 1: the ROM on that table counted it (flagged by that player's Castcade; a flag only: no score or result changes)");
    C.ctl.feed(scores(900));
    C.ctl.feed(ballEnd(1));
    C.ctl.feed(gameEnd(900));
    await flush();
    // The game is over (one ball each): the line is on both panels for a while, over the next-game line.
    expect(headerText(H.media.panel)).toBe('GAME 1 OVER');
    expect(H.media.panel.message).toBe(KROBS_LINE);
    expect(C.media.panel.message).toBe(MY_LINE);
    // The result marks Krobs and nobody else; the places and scores are what the scores say.
    expect(H.media.panel.result).toEqual([
      { id: 'c', name: 'Krobs', score: 900, place: 1, flags: ['midnight'] },
      { id: 'h', name: 'Hosty', score: 500, place: 2 },
    ]);
    expect(C.media.panel.result).toEqual(H.media.panel.result);
    expect(stripRows(H.media.panel).map((r) => [r.name, r.detail, r.flags])).toEqual([
      ['Krobs', '#1', ['MIDNIGHT MADNESS']],
      ['Hosty', '#2', []],
    ]);
    expect(midnightFlagged(H.media.panel)).toEqual(['c']);
    expect(midnightFlagged(C.media.panel)).toEqual(['c']);
    expect(host.state.players['c']).toMatchObject({ score: 900, ballsPlayed: 1, status: 'finished' });
    // The flag is not in the log: Krobs' BALL_END and GAME_OVER only (GAME_OVER folded into the last ball: one entry).
    const added = host.log.entries().slice(logged).map((e) => e.message?.['type']);
    expect(added).not.toContain('PARTICIPANT_UPDATE');
    expect(client.log.head()).toEqual(host.log.head());
    // After a while the panel's line is the usual one again; the row flag and the Match tab's line stay for the game.
    clock.advance(MIDNIGHT_LINE_MS);
    expect(H.media.panel.message).toBe('Next game: start a game on your table (or press Next game)');
    expect(C.media.panel.message).toBe('Next game: Hosty starts a game on the table');
    expect(midnightFlagged(H.media.panel)).toEqual(['c']);
    expect(H.ctl.status().advisories).toEqual([KROBS_LINE]);
    // The same flag twice (a re-send) is one flag.
    client.reportAdvisory({ kind: 'midnight', game: 1, ballNumber: 1 });
    await flush();
    expect(H.ctl.status().advisories).toEqual([KROBS_LINE]);
    expect(H.logs.filter((l) => l.includes('Midnight Madness')).length).toBe(1);
    // The next game starts clean.
    expect(H.ctl.nextGame()).toBe(true);
    await flush();
    expect(H.ctl.status().advisories).toEqual([]);
    expect(C.ctl.status().advisories).toEqual([]);
    expect(midnightFlagged(H.media.panel)).toEqual([]);
    expect(H.media.panel.result).toBeNull();
  });

  it("B26.4: the host's ball: the client is told while the match goes on; a second count on the same ball is one flag, one on a later ball is another", async () => {
    const { host, clock, H, C } = await rig(2);
    host.start();
    await flush();
    await playBall(H, clock, 1, 500, 5 * MINUTE, false, true);
    expect(host.state.players['h']).toMatchObject({ score: 500, ballsPlayed: 1 });
    expect(C.ctl.status()).toMatchObject({ myTurn: true, locked: false, advisories: ["Midnight Madness ran on Hosty's ball 1 (counted by that table's ROM)"] });
    expect(H.ctl.status().advisories).toEqual([MY_LINE]);
    expect(midnightFlagged(C.media.panel)).toEqual(['h']);
    expect(stripRows(C.media.panel).find((r) => r.id === 'h')?.flags).toEqual(['MIDNIGHT MADNESS']);
    // Krobs' ball 1: nothing counted on his table.
    await playBall(C, clock, 1, 900, MINUTE, false);
    expect(H.ctl.status()).toMatchObject({ myTurn: true });
    expect(midnightFlagged(H.media.panel)).toEqual(['h']);
    expect(C.logs.some((l) => l.includes('Midnight Madness ran on my ball'))).toBe(false);
    // The host's ball 2: counted twice (the audit written in two steps): one more flag, not two.
    H.ctl.feed(scores(600));
    H.ctl.feed(midnightRan(4, 2));
    H.ctl.feed(midnightRan(5, 2));
    await flush();
    expect(H.ctl.status().advisories).toEqual([MY_LINE, "Midnight Madness ran on your ball 2 (counted by your table's ROM)"]);
    expect(C.ctl.status().advisories).toEqual(["Midnight Madness ran on Hosty's ball 1 (counted by that table's ROM)", "Midnight Madness ran on Hosty's ball 2 (counted by that table's ROM)"]);
  });

  it('B26.4: nothing is guessed from the clock: balls played across midnight, a whole day long, with no count from the ROM, are not flagged', async () => {
    const { host, clock, H, C } = await rig(1);
    host.start();
    await flush();
    await playBall(H, clock, 1, 500, DAY_MS / 2 + MINUTE, true);
    await playBall(C, clock, 1, 900, DAY_MS / 2 + MINUTE, true);
    expect(H.ctl.status().advisories).toEqual([]);
    expect(C.ctl.status().advisories).toEqual([]);
    expect(midnightFlagged(H.media.panel)).toEqual([]);
    expect(H.media.panel.result).toEqual([
      { id: 'c', name: 'Krobs', score: 900, place: 1 },
      { id: 'h', name: 'Hosty', score: 500, place: 2 },
    ]);
    expect([...H.logs, ...C.logs].some((l) => l.includes('Midnight Madness'))).toBe(false);
  });

  it("B26.4: a count outside this player's match game flags nothing (the lobby, a game already over); one between this player's turns is the ball it plays next", async () => {
    const { host, clock, H, C } = await rig(2);
    // The lobby: a game on the table before the match.
    C.ctl.feed(gameStart);
    C.ctl.feed(midnightRan(1));
    C.ctl.feed(gameEnd(100));
    await flush();
    expect(C.ctl.status().advisories).toEqual([]);
    expect(C.logs).toContain("match: the ROM's audit B.4 31 SPECIAL MODES went from 1 to 2 on my table outside my game of this match; nothing flagged");
    host.start();
    await flush();
    // Krobs has not had a turn yet and no game of the match is open on his table: not his.
    C.ctl.feed(midnightRan(2));
    await flush();
    expect(H.ctl.status().advisories).toEqual([]);
    await playBall(H, clock, 1, 500, MINUTE, false);
    await playBall(C, clock, 1, 900, MINUTE, false);
    // The host is up for ball 2. Krobs' table, its game open and waiting for his ball 2, counts one: his ball 2.
    C.ctl.feed(midnightRan(3));
    await flush();
    expect(C.ctl.status().advisories).toEqual(["Midnight Madness ran on your ball 2 (counted by your table's ROM)"]);
    expect(H.ctl.status().advisories).toEqual(["Midnight Madness ran on Krobs' ball 2 (counted by that table's ROM)"]);
    await playBall(H, clock, 2, 700, MINUTE, true);
    await playBall(C, clock, 2, 1200, MINUTE, true);
    expect(host.state.phase).toBe('ended');
    // Both games are over; the table goes on counting for nobody.
    const before = C.logs.filter((l) => l.includes('Midnight Madness ran')).length;
    C.ctl.feed(midnightRan(4));
    H.ctl.feed(midnightRan(4));
    await flush();
    expect(C.logs.filter((l) => l.includes('Midnight Madness ran')).length).toBe(before);
    expect(H.ctl.status().advisories).toEqual(["Midnight Madness ran on Krobs' ball 2 (counted by that table's ROM)"]);
  });

  it("B26.4: a ball the host passes by hand keeps the flag it got while it was played", async () => {
    const { host, H, C } = await rig(1);
    host.start();
    await flush();
    H.ctl.feed(gameStart);
    H.ctl.feed(scores(400));
    H.ctl.feed(midnightRan(3));
    expect(H.ctl.passTurn()).toBe(true);
    await flush();
    expect(host.state.players['h']).toMatchObject({ score: 400, ballsPlayed: 1 });
    expect(H.ctl.status().advisories).toEqual([MY_LINE]);
    expect(C.ctl.status()).toMatchObject({ myTurn: true, advisories: ["Midnight Madness ran on Hosty's ball 1 (counted by that table's ROM)"] });
  });

  // ---- B26.4: the setting that enables it, read on each rig and shown to everyone ----
  const MODE_ON = { enabled: true, adjustment: 'A.2 14 Special Mode' };
  const MODE_OFF = { enabled: false, adjustment: 'A.2 14 Special Mode' };

  it('B26.4: the setting: nothing while no rig could read it or it is OFF; ON on one table, it differs, ON on every table: every player sees the same from the lobby on', async () => {
    const { H, C } = await rig(1);
    expect(H.ctl.status().advisories).toEqual([]);
    // Unknown on a rig (no table open, an unknown game): nothing is said, nothing is sent.
    H.ctl.setLocalMidnightMode(null);
    C.ctl.setLocalMidnightMode(null);
    await flush();
    expect(H.ctl.status().advisories).toEqual([]);
    expect(C.ctl.status().advisories).toEqual([]);
    // OFF on the only table that could be read: nothing to warn about.
    H.ctl.setLocalMidnightMode(MODE_OFF);
    await flush();
    expect(H.ctl.status().advisories).toEqual([]);
    expect(C.ctl.status().advisories).toEqual([]);
    expect(H.logs).toContain('match: Midnight Madness is OFF on my table (adjustment A.2 14 Special Mode)');
    expect(C.logs).toContain("match: Midnight Madness is OFF on Hosty's table (adjustment A.2 14 Special Mode; read by that player's Castcade)");
    // Krobs' table has it ON: it differs, said plainly on both sides.
    C.ctl.setLocalMidnightMode(MODE_ON);
    await flush();
    expect(C.ctl.status().advisories).toEqual(["Midnight Madness differs between tables: ON on your table, OFF on Hosty's table (adjustment A.2 14 Special Mode)"]);
    expect(H.ctl.status().advisories).toEqual(["Midnight Madness differs between tables: ON on Krobs' table, OFF on your table (adjustment A.2 14 Special Mode)"]);
    // The host turns it on too (the reading follows the table's NVRAM).
    H.ctl.setLocalMidnightMode(MODE_ON);
    await flush();
    expect(H.ctl.status().advisories).toEqual(['Midnight Madness is ON on every table (adjustment A.2 14 Special Mode)']);
    expect(C.ctl.status().advisories).toEqual(['Midnight Madness is ON on every table (adjustment A.2 14 Special Mode)']);
    // A table that closes says nothing new: what was read stands.
    C.ctl.setLocalMidnightMode(null);
    await flush();
    expect(H.ctl.status().advisories).toEqual(['Midnight Madness is ON on every table (adjustment A.2 14 Special Mode)']);
    // The lobby panel keeps its own line; the setting is on the Match tab until the game starts.
    expect(H.media.panel.message).toBe('Everyone in? Start a game on your table (or press Start match)');
  });

  it("B26.4: the setting, ON on one table and unknown on the other: named for that table only; on the panel at each game's start, beside the Press Start prompt, then on the Match tab all game", async () => {
    const { host, clock, H, C } = await rig(1);
    C.ctl.setLocalMidnightMode(MODE_ON);
    await flush();
    const ON_KROBS = "Midnight Madness is ON on Krobs' table (adjustment A.2 14 Special Mode)";
    const ON_MINE = 'Midnight Madness is ON on your table (adjustment A.2 14 Special Mode)';
    expect(H.ctl.status().advisories).toEqual([ON_KROBS]);
    expect(C.ctl.status().advisories).toEqual([ON_MINE]);
    host.start();
    await flush();
    expect(H.media.panel.message).toBe(`Press Start on the table to begin your game · ${ON_KROBS}`);
    expect(C.media.panel.message).toBe(ON_MINE);
    clock.advance(MIDNIGHT_LINE_MS);
    expect(H.media.panel.message).toBe('Press Start on the table to begin your game');
    expect(C.media.panel.message).toBeNull();
    expect(H.ctl.status().advisories).toEqual([ON_KROBS]);
    // The game: the setting line stays first, a ball the mode ran on follows it.
    await playBall(H, clock, 1, 500, MINUTE, true);
    await playBall(C, clock, 1, 900, MINUTE, true, true);
    expect(H.ctl.status().advisories).toEqual([ON_KROBS, KROBS_LINE]);
    expect(C.ctl.status().advisories).toEqual([ON_MINE, MY_LINE]);
    clock.advance(MIDNIGHT_LINE_MS);
    // The next game: the flag is gone, the setting is on the panel again for a while.
    expect(H.ctl.nextGame()).toBe(true);
    await flush();
    expect(H.ctl.status().advisories).toEqual([ON_KROBS]);
    expect(C.media.panel.message).toBe(ON_MINE);
    // During play too: the host's table is read (it was opened late) and has it OFF.
    H.ctl.setLocalMidnightMode(MODE_OFF);
    await flush();
    expect(C.ctl.status().advisories).toEqual(["Midnight Madness differs between tables: ON on your table, OFF on Hosty's table (adjustment A.2 14 Special Mode)"]);
    expect(host.log.entries().some((e) => e.message?.['type'] === 'PARTICIPANT_UPDATE')).toBe(false);
  });

  it('B26.4: a client that read its table before it joined tells the host at the join; a client that joins later hears what the lobby already said', async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const hk = generateKeys();
    const ck = generateKeys();
    const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'ABCDEF', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, clock });
    const client = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game, throwdownCode: 'ABCDEF', hostId: 'h', clock });
    const H = seat(host, clock, 1);
    const C = seat(client, clock);
    await H.ctl.open();
    await C.ctl.open();
    H.ctl.setLocalMidnightMode(MODE_ON);
    C.ctl.setLocalMidnightMode(MODE_OFF);
    expect(H.ctl.status().advisories).toEqual(['Midnight Madness is ON on your table (adjustment A.2 14 Special Mode)']);
    expect(C.ctl.status().advisories).toEqual([]);
    client.join();
    await flush();
    expect(host.midnightModes()).toEqual({ h: MODE_ON, c: MODE_OFF });
    expect(H.ctl.status().advisories).toEqual(["Midnight Madness differs between tables: ON on your table, OFF on Krobs' table (adjustment A.2 14 Special Mode)"]);
    expect(C.ctl.status().advisories).toEqual(["Midnight Madness differs between tables: ON on Hosty's table, OFF on your table (adjustment A.2 14 Special Mode)"]);
  });

  it('the host leaving between games ends the series for the client (hostGone): unlocked, said on the panel', async () => {
    const s = await rig(1);
    const { host, bus, C } = s;
    host.start();
    await flush();
    await playGame(s, 100, 200);
    // A16: the client's table game ends (no initials to enter); between games its table is locked.
    C.ctl.feed(gameEnd(200));
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
    const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'L', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy: 'advise', clock });
    const H = seat(host, clock, 1);
    await H.ctl.open();
    H.ctl.feed(gameStart);
    expect(host.countdownRemaining()).toBeNull();
    expect(H.media.panel.message).toBe('Waiting for players');
    const client = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game: noTable, throwdownCode: 'L', hostId: 'h', clock });
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
    const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'A', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy: 'advise', clock });
    const H = seat(host, clock, 1, { preMatchPlay });
    const join = async (clientGame: GameFingerprint = game) => {
      const client = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game: clientGame, throwdownCode: 'A', hostId: 'h', clock });
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
    const host = new HostMatch({ disconnectGraceMs: 0, transport: bus.transport('h'), keys: hk, matchId: 'A', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, clock });
    const H = seat(host, clock, 1, { tableGameRunning: true });
    await H.ctl.open();
    const client = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game, throwdownCode: 'A', hostId: 'h', clock });
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
    const c2 = new ClientMatch({ disconnectGraceMs: 0, transport: bus.transport('c2'), keys: k2, participant: { ...participant('c2', k2), displayName: 'Bea' }, game, throwdownCode: 'A', hostId: 'h', clock });
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
