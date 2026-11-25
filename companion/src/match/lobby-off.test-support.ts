/**
 * A17 step 5 (2026-11-25): one scripted match that touches every kind of frame the engine sent before the lobby,
 * with nothing left to chance: fixed keys, a manual clock, an in-memory bus. Every frame each engine hands to its
 * transport is recorded as the text that goes on the wire.
 *
 * It is the proof that `HostOptions.lobby` / `ClientOptions.lobby`, left off, change nothing: this script was run on
 * the commit step 5 started from (the frames are in `lobby-off.frames.json`), and `lobby-off.test.ts` runs it on the
 * tree as it is and compares the two, byte for byte. So the script may only use what the engine had on that commit;
 * a change to it needs the frames recorded again from that commit, not from a newer one.
 *
 * What it plays: three join (one with another table file and a table that cannot report ball ends, the host in
 * advisory mode), one is refused; rigs, tables, ball-end readiness, the Midnight Madness setting and the 3D wait
 * change in the lobby; media signals in all three directions; a start from a countdown; a game of two balls with a
 * shoot-again, a manual ball end, a requested pause and its resume, a passed turn, a stale ball end and a ball end
 * out of turn (both rejected), a rig change and two advisories after the start, a late HELLO (refused), a game over
 * and a forfeit; the signatures and the RESULT; a second game, in which a client's link drops and comes back inside
 * the grace (RECONNECT, RECONNECT_ACK) and another's drops for longer while it is up (the pause, its RESUME); the
 * second RESULT and MATCH_END.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { AnyMessage, GameFingerprint, ParticipantInfo, PlayerId } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { HostMatch } from './host.js';
import { exportPublicKeyB64, type KeyPair } from './keys.js';
import { MemoryBus, type MessageHandler, type PeerHandler, type Transport } from './transport.js';

export interface RecordedFrame {
  /** The engine that sent it. */
  by: PlayerId;
  /** Where it sent it: one peer, or `all`. */
  to: PlayerId | 'all';
  /** The frame as `JSON.stringify` writes it: what a transport puts on the wire. */
  frame: string;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An Ed25519 key pair from a fixed seed, so every signature in the recording is the same on every run. */
export function fixedKeys(seedByte: number): KeyPair {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, seedByte)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  return { publicKey, privateKey, publicKeyB64: exportPublicKeyB64(publicKey) };
}

/**
 * A transport that records what its engine sends, and can lose and regain one link: a star (`connectTo`), as the
 * WebSocket and relay transports are, laid over the in-memory bus.
 */
export class TapTransport implements Transport {
  readonly topology = 'star' as const;
  private readonly down = new Set<PlayerId>();
  /** While true no new link can be made: `connectTo` fails, as a socket to a PC that cannot be reached does. */
  unreachable = false;
  private readonly leaveHandlers = new Set<PeerHandler>();

  constructor(
    private readonly inner: Transport,
    private readonly bus: MemoryBus,
    private readonly taps: Map<PlayerId, TapTransport>,
    private readonly frames: RecordedFrame[],
  ) {
    taps.set(inner.localId, this);
  }

  get localId(): PlayerId {
    return this.inner.localId;
  }

  send(to: PlayerId | 'all', msg: AnyMessage): void {
    this.frames.push({ by: this.localId, to, frame: JSON.stringify(msg) });
    const targets = to === 'all' ? this.bus.connectedPeers().filter((p) => p !== this.localId) : [to];
    for (const p of targets) if (!this.down.has(p)) this.inner.send(p, msg);
  }

  onMessage(cb: MessageHandler): () => void {
    return this.inner.onMessage((from, msg) => {
      if (!this.down.has(from)) cb(from, msg);
    });
  }

  onPeerJoin(cb: PeerHandler): () => void {
    return this.inner.onPeerJoin(cb);
  }

  onPeerLeave(cb: PeerHandler): () => void {
    this.leaveHandlers.add(cb);
    const off = this.inner.onPeerLeave(cb);
    return () => {
      this.leaveHandlers.delete(cb);
      off();
    };
  }

  closePeer(peer: PlayerId): void {
    this.inner.closePeer?.(peer);
  }

  close(): void {
    this.inner.close();
  }

  connectTo(peer: PlayerId, first: () => AnyMessage): Promise<void> {
    if (this.unreachable) return Promise.reject(new Error(`${peer} cannot be reached`));
    this.down.delete(peer);
    this.taps.get(peer)?.down.delete(this.localId);
    this.send(peer, first());
    return Promise.resolve();
  }

  /** The link between this end and `peer` drops: both ends see the other leave, and nothing passes until `connectTo`. */
  cut(peer: PlayerId): void {
    const other = this.taps.get(peer);
    this.down.add(peer);
    other?.down.add(this.localId);
    for (const cb of [...this.leaveHandlers]) cb(peer);
    if (other) for (const cb of [...other.leaveHandlers]) cb(this.localId);
  }
}

const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const hex = (pair: string): string => pair.repeat(32);
const TABLE: GameFingerprint = { kind: 'vpx', tableName: 'Monster Bash (Williams 1998)', tableHash: hex('ab'), romName: 'mb_106b', romHash: hex('cd'), physicsHash: null, recipeVersion: '0.5.0', sidecarHash: hex('ef'), emulatorVersion: '10.8.0' };
const OTHER_FILE: GameFingerprint = { ...TABLE, tableHash: hex('12'), sidecarHash: null };

/** The scripted match, with the lobby option left as it is by default (off). Returns every frame, in the order sent. */
export async function recordOptionOffMatch(): Promise<RecordedFrame[]> {
  const frames: RecordedFrame[] = [];
  const bus = new MemoryBus();
  const taps = new Map<PlayerId, TapTransport>();
  const clock = new ManualClock(1_795_000_000_000);
  const tap = (id: PlayerId): TapTransport => new TapTransport(bus.transport(id), bus, taps, frames);
  const who = (id: PlayerId, keys: KeyPair, rig: ParticipantInfo['rig']): ParticipantInfo => ({ playerId: id, displayName: `Player ${id}`, publicKey: keys.publicKeyB64, rig });
  const step = async (ms = 0): Promise<void> => {
    if (ms > 0) clock.advance(ms);
    await flush();
  };

  const hKeys = fixedKeys(1);
  const hTap = tap('h');
  const host = new HostMatch({
    transport: hTap,
    keys: hKeys,
    matchId: 'GOLDEN',
    ballsPerGame: 2,
    hostParticipant: who('h', hKeys, 'pc'),
    hostGame: TABLE,
    fingerprintPolicy: 'advise',
    clock,
    companionVersion: '0.2.50',
    ballEndReady: true,
    logSignTimeoutMs: 10_000,
  });
  const client = (id: PlayerId, seed: number, game: GameFingerprint, code: string, ballEndReady?: boolean): { c: ClientMatch; t: TapTransport } => {
    const keys = fixedKeys(seed);
    const t = tap(id);
    const c = new ClientMatch({ transport: t, keys, participant: who(id, keys, 'pc'), game, throwdownCode: code, hostId: 'h', clock, companionVersion: '0.2.50', ballEndReady, reconnect: { delayMs: 1000, attempts: 10 }, hostLeftTransfer: false });
    return { c, t };
  };

  // The lobby: a joins with another file of the table and no hook, b as the host has it, x asks for another match.
  const { c: a, t: aTap } = client('a', 2, OTHER_FILE, 'GOLDEN', false);
  a.join();
  await step(100);
  const { c: b, t: bTap } = client('b', 3, TABLE, 'GOLDEN', true);
  b.join();
  await step(100);
  const { c: x } = client('x', 4, TABLE, 'ELSEWHERE');
  x.join();
  await step(100);
  a.updateParticipant({ rig: 'vr_headset', game: TABLE, ballEndReady: true, stream3dWaitMs: 5000 });
  await step(100);
  a.updateParticipant({ stream3dWaitMs: 0 });
  await step(100);
  b.reportMidnightMode({ enabled: true, adjustment: 'A.2 14 Special Mode' });
  await step(100);
  host.updateLocal({ rig: 'vr_headset' });
  host.localMidnightMode({ enabled: false, adjustment: 'A.2 14 Special Mode' });
  await step(100);
  a.sendMediaSignal('b', { kind: 'offer', sdp: 'v=0 offer a to b' });
  host.sendMediaSignal('a', { kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 }, channel: 'video' });
  b.sendMediaSignal('h', { kind: 'answer', sdp: 'v=0 answer b to h', channel: 'stream' });
  await step(100);

  // The start, from a countdown.
  host.startIn(3000);
  await step(1000);
  await step(2000);

  // Game 1, ball 1. The host; then a with a shoot-again and a manual end; then b: a pause, its resume, a passed turn.
  host.localState({ ballNumber: 1, score: 50, ballInPlay: true, tilt: false });
  await step(500);
  host.localBallEnd(100, 'nvram');
  await step(500);
  a.reportState({ ballNumber: 1, score: 150, ballInPlay: true, tilt: false, extraBalls: 1 });
  a.reportDmd({ kind: 'text', lines: ['EXTRA BALL', '150'] });
  await step(500);
  a.reportBallEnd(200, 'script', true);
  await step(500);
  a.reportBallEnd(300, 'manual');
  await step(500);
  b.pause('requested');
  await step(500);
  b.resume();
  await step(500);
  b.reportState({ ballNumber: 1, score: 40, ballInPlay: true, tilt: false });
  await step(500);
  host.passTurn(50);
  await step(500);

  // After the start: a rig, two advisories, the Midnight setting again, a HELLO that comes too late.
  a.updateParticipant({ rig: 'pc' });
  a.reportAdvisory({ kind: 'midnight', game: 1, ballNumber: 1 });
  host.localAdvisory({ kind: 'midnight', game: 1, ballNumber: 1 });
  b.reportMidnightMode({ enabled: false, adjustment: 'A.2 14 Special Mode' });
  host.updateLocal({ rig: 'pc' });
  await step(100);
  const { c: late } = client('late', 5, TABLE, 'GOLDEN');
  late.join();
  await step(100);

  // Ball 2. The host; a answers an old grant, then b answers out of turn (both rejected), then a's game is over;
  // b gives its game up.
  host.localBallEnd(400, 'nvram');
  await step(500);
  a.reportBallEnd(1, 'script', false, { grantSeq: 2, ballNumber: 2 });
  b.reportBallEnd(1, 'script', false, { grantSeq: host.state.lastGrantSeq, ballNumber: 2 });
  await step(500);
  a.reportGameOver(900, 2);
  await step(500);
  b.forfeit('gave up');
  await step(500);
  await step(500);

  // Game 2: a's link drops while the host is up and is back inside the grace; then b's drops while b is up, for longer.
  host.nextGame();
  await step(500);
  aTap.cut('h');
  await step(1000);
  await step(500);
  host.localBallEnd(1000, 'nvram');
  await step(500);
  a.reportBallEnd(1100, 'script');
  await step(500);
  bTap.unreachable = true;
  bTap.cut('h');
  for (let i = 0; i < 5; i++) await step(1000);
  bTap.unreachable = false;
  await step(1000);
  await step(500);
  b.resume();
  await step(500);
  b.reportBallEnd(1200, 'script');
  await step(500);
  host.localBallEnd(2000, 'nvram');
  await step(500);
  a.reportBallEnd(2100, 'script');
  await step(500);
  b.reportBallEnd(2200, 'script');
  await step(500);
  await step(500);
  host.endMatch('the evening is over');
  await step(500);

  host.close();
  for (const c of [a, b, x, late]) c.close();
  void hTap;
  return frames;
}
