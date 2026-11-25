/**
 * 2026-11-25: what the link-binding tests share: a host engine and a client engine (and a second client where a
 * test asks for one) on the real transports, through the relay double or over real WebSockets, and another link to
 * the host that has said nothing yet (a seat in the relay room, a socket on the listener).
 */
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { WebSocket } from 'ws';
import { buildMessage, decodeFrame, encodeFrame, PROTOCOL_VERSION, type AnyMessage, type GameFingerprint, type GrantBody, type ParticipantInfo, type Message } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import type { Clock } from './clock.js';
import { HostMatch } from './host.js';
import { generateKeys, signCanonical, type KeyPair } from './keys.js';
import { reconnectSignBody } from './result.js';
import { startFakeRelay, type FakeRelay } from './relay-fake.test-support.js';
import { RelayClientTransport, RelayHostTransport, RELINK, type RelayOptions } from './transport-relay.js';
import { WsPeerTransport } from './transport-ws.js';

export const CODE = 'RELAYA';
export const game: GameFingerprint = { kind: 'vpx', tableName: 'Test Table', tableHash: 'ab'.repeat(32), romName: null, romHash: null, physicsHash: null, recipeVersion: '0.5.0', sidecarHash: null, emulatorVersion: '10.8.0' };
export const participant = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: id, publicKey: keys.publicKeyB64, rig: 'pc' });
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(5);
  }
};
export const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
export const types = (m: HostMatch | ClientMatch): string[] => m.log.entries().map((e) => (e.message ? `${e.message.type}:${e.message.from}` : (e.event?.type ?? '?')));

export const DEVICES = { 'dev-h': 'tok-h', 'dev-a': 'tok-a', 'dev-b': 'tok-b', 'dev-c': 'tok-c' };
/** The relay double of the test that is running, and everything it opened; `cleanup` goes into `afterEach`. */
export const world: { relay: FakeRelay | null; open: { close(): void }[] } = { relay: null, open: [] };
export async function cleanup(): Promise<void> {
  for (const x of world.open.splice(0)) x.close();
  await world.relay?.close();
  world.relay = null;
}
export const optsFor = (r: FakeRelay, id: string, extra: Partial<RelayOptions> = {}): RelayOptions => ({
  localId: id,
  baseUrl: r.url,
  auth: { deviceId: `dev-${id}`, deviceToken: `tok-${id}` },
  connectTimeoutMs: 1500,
  ackTimeoutMs: 1500,
  ...extra,
});

/** Another link to the host that has said nothing yet: a seat in the relay room, or a socket on the listener. */
export interface Second {
  send(...msgs: AnyMessage[]): void;
  /** Text as it is, for a frame that is not written by this build. */
  sendText(text: string): void;
  /** The protocol frames this link was sent, in order. */
  frames(): AnyMessage[];
  /** Over the relay (which has no kick): this link was told it is on no link. Over WebSocket: the socket was closed. */
  shut(): boolean;
  /** Go away: leave the room, or close the socket. */
  leave(): void;
}

export interface RigOptions {
  /** Both engines' grace. Default 0: a leave that was wrongly noted would pause at once. */
  graceMs?: number;
  /** The host engine's clock (its grace, then, runs on it). */
  clock?: Clock;
  /** How long `a` waits between its reconnect attempts. Default 40 ms. */
  retryMs?: number;
  /** A second client, `b`, joins too. */
  third?: boolean;
}

export interface Rig {
  kind: 'relay' | 'ws';
  host: HostMatch;
  hk: KeyPair;
  a: ClientMatch;
  ak: KeyPair;
  b: ClientMatch | null;
  /** What the engines raised that is not the plain course of a match. */
  seen: string[];
  /** What the host's transport reported (the shell writes these to its log). */
  errors: string[];
  /** The players the host's transport holds a link for. */
  linked(): string[];
  second(device?: string): Promise<Second>;
  /** `a`'s link to the host goes, as a network drop would take it. */
  dropA(): void;
  relayHost: RelayHostTransport | null;
}

export function note(host: HostMatch, a: ClientMatch): string[] {
  const seen: string[] = [];
  host.on('pause', (p) => seen.push(`h:pause:${String(p.player)}`));
  host.on('resume', () => seen.push('h:resume'));
  host.on('peerLeft', (id) => seen.push(`h:peerLeft:${id}`));
  host.on('reconnected', (x) => seen.push(`h:reconnected:${x.playerId}`));
  host.on('reconnectRejected', (x) => seen.push(`h:reconnectRejected:${x.code}`));
  host.on('refused', (x) => seen.push(`h:refused:${x.refuse.code}`));
  host.on('reject', (x) => seen.push(`h:reject:${x.refType}:${x.code}`));
  a.on('peerLeft', (id) => seen.push(`a:peerLeft:${id}`));
  a.on('reject', (x) => seen.push(`a:reject:${x.refType}`));
  a.on('reconnected', () => seen.push('a:reconnected'));
  a.on('reconnectFailed', () => seen.push('a:reconnectFailed'));
  a.on('reconnectRejected', () => seen.push('a:reconnectRejected'));
  a.on('refused', (x) => seen.push(`a:refused:${x.code}`));
  return seen;
}

/** A bare socket.io client with a seat in the room of `CODE`. */
export async function relaySeat(r: FakeRelay, device = 'b'): Promise<Second & { socket: ClientSocket }> {
  const s: ClientSocket = ioClient(r.url, { auth: { deviceId: `dev-${device}`, deviceToken: `tok-${device}` }, transports: ['websocket'], forceNew: true, reconnection: false });
  world.open.push({ close: () => s.disconnect() });
  await new Promise<void>((res, rej) => {
    s.once('connect', () => res());
    s.once('connect_error', rej);
  });
  const raw: string[] = [];
  s.on('match:relay', (p: { data: string }) => raw.push(p.data));
  const ack = await new Promise<{ ok?: boolean }>((res, rej) => s.timeout(1500).emit('match:join', { code: CODE }, (err: Error | null, x: { ok?: boolean }) => (err ? rej(err) : res(x))));
  if (ack.ok !== true) throw new Error('no seat in the room');
  return {
    socket: s,
    send: (...msgs) => msgs.forEach((m) => s.emit('match:relay', { data: encodeFrame(m) })),
    sendText: (text) => s.emit('match:relay', { data: text }),
    frames: () => raw.filter((d) => d !== RELINK).map((d) => decodeFrame(d)),
    shut: () => raw.includes(RELINK),
    leave: () => s.disconnect(),
  };
}

export async function rawSocket(endpoint: string): Promise<Second & { socket: WebSocket }> {
  const socket = new WebSocket(endpoint);
  world.open.push({ close: () => socket.terminate() });
  const raw: string[] = [];
  let closed = false;
  socket.on('message', (d) => raw.push(d.toString()));
  socket.on('close', () => (closed = true));
  await new Promise<void>((res, rej) => {
    socket.once('open', () => res());
    socket.once('error', rej);
  });
  return {
    socket,
    send: (...msgs) => msgs.forEach((m) => socket.send(encodeFrame(m))),
    sendText: (text) => socket.send(text),
    frames: () => raw.map((d) => decodeFrame(d)),
    shut: () => closed,
    leave: () => socket.close(),
  };
}

export async function relayRig(o: RigOptions = {}): Promise<Rig> {
  const r = (world.relay = await startFakeRelay({ devices: DEVICES }));
  const graceMs = o.graceMs ?? 0;
  const hk = generateKeys();
  const ak = generateKeys();
  const rh = new RelayHostTransport(optsFor(r, 'h'));
  const errors: string[] = [];
  rh.onError((e) => errors.push(e.message));
  await rh.host(CODE);
  const host = new HostMatch({ transport: rh, keys: hk, matchId: CODE, ballsPerGame: 2, hostParticipant: participant('h', hk), hostGame: game, disconnectGraceMs: graceMs, clock: o.clock });
  const at = new RelayClientTransport(optsFor(r, 'a'));
  await at.connect(CODE);
  const a = new ClientMatch({ transport: at, keys: ak, participant: participant('a', ak), game, throwdownCode: CODE, reconnect: { delayMs: o.retryMs ?? 40, attempts: 40 }, disconnectGraceMs: graceMs });
  world.open.push(rh, at, host, a);
  const seen = note(host, a);
  a.join();
  await until(() => a.isJoined && host.roster().length === 2);
  let b: ClientMatch | null = null;
  if (o.third) {
    const bk = generateKeys();
    const bt = new RelayClientTransport(optsFor(r, 'c', { localId: 'b' }));
    await bt.connect(CODE);
    b = new ClientMatch({ transport: bt, keys: bk, participant: participant('b', bk), game, throwdownCode: CODE, disconnectGraceMs: graceMs });
    world.open.push(bt, b);
    b.join();
    await until(() => b!.isJoined && host.roster().length === 3);
  }
  return { kind: 'relay', host, hk, a, ak, b, seen, errors, linked: () => rh.peers(), second: (device) => relaySeat(r, device), dropA: () => r.dropDevice('dev-a'), relayHost: rh };
}

export async function wsRig(o: RigOptions = {}): Promise<Rig> {
  const graceMs = o.graceMs ?? 0;
  const hk = generateKeys();
  const ak = generateKeys();
  const ht = new WsPeerTransport({ localId: 'h' });
  const errors: string[] = [];
  ht.onError((e) => errors.push(e.message));
  const endpoint = await ht.listen(0, '127.0.0.1');
  const host = new HostMatch({ transport: ht, keys: hk, matchId: CODE, ballsPerGame: 2, hostParticipant: participant('h', hk), hostGame: game, disconnectGraceMs: graceMs, clock: o.clock });
  const at = new WsPeerTransport({ localId: 'a' });
  await at.connect(endpoint);
  const a = new ClientMatch({ transport: at, keys: ak, participant: participant('a', ak), game, throwdownCode: CODE, reconnect: { delayMs: o.retryMs ?? 40, attempts: 40 }, disconnectGraceMs: graceMs });
  world.open.push(ht, at, host, a);
  const seen = note(host, a);
  a.join();
  await until(() => a.isJoined && host.roster().length === 2);
  let b: ClientMatch | null = null;
  if (o.third) {
    const bk = generateKeys();
    const bt = new WsPeerTransport({ localId: 'b' });
    await bt.connect(endpoint);
    b = new ClientMatch({ transport: bt, keys: bk, participant: participant('b', bk), game, throwdownCode: CODE, disconnectGraceMs: graceMs });
    world.open.push(bt, b);
    b.join();
    await until(() => b!.isJoined && host.roster().length === 3);
  }
  return { kind: 'ws', host, hk, a, ak, b, seen, errors, linked: () => ht.inboundPeers(), second: () => rawSocket(endpoint), dropA: () => at.dropLinks('h'), relayHost: null };
}

/** The two transports a test runs on, with the words its name carries. */
export const TRANSPORTS = [
  ['through the relay', relayRig],
  ['over WebSocket', wsRig],
] as const;

/** The match is running and `a` holds the grant for its first ball. */
export async function aIsUp(rig: Pick<Rig, 'host' | 'a'>): Promise<GrantBody> {
  rig.host.start();
  await until(() => rig.a.state.currentGrant?.grant.player === 'h');
  rig.host.localBallEnd(100, 'nvram');
  await until(() => rig.a.myGrant !== null);
  return rig.a.myGrant as GrantBody;
}

/**
 * A RECONNECT that names `player` and the head `head` (default: `a`'s own log head), signed with `key`, under the number `seq`.
 * A17 step 7 (protocol 7): the signed body names the host the frame is for (`h` here; `o.host` for another) and the
 * envelope's own `seq` (`result.ts` `reconnectSignBody`).
 */
export function reconnectAs(rig: Pick<Rig, 'a'>, key: KeyPair, seq: number, o: { player?: string; head?: { hash: string; length: number }; resends?: boolean; host?: string; match?: string } = {}): AnyMessage {
  return signedReconnect(o.match ?? CODE, o.host ?? 'h', o.player ?? 'a', o.head ?? rig.a.log.head(), key, seq, o.resends !== false);
}
/** A17 step 7: a RECONNECT of a match without a lobby, as protocol 7 signs it: `match` stands where the lobby's code would, twice. */
export function signedReconnect(match: string, host: string, player: string, head: { hash: string; length: number }, key: KeyPair, seq: number, resends = true): Message<'RECONNECT'> {
  const signature = signCanonical(reconnectSignBody(match, host, player, match, head.hash, head.length, seq), key.privateKey);
  return buildMessage('RECONNECT', { player, logHash: head.hash, logLength: head.length, signature, ...(resends ? { resends: true } : {}) }, { matchId: match, seq, from: player });
}
export function helloAs(id: string, seq: number): AnyMessage {
  return buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: 'test', throwdownCode: CODE, participant: participant(id, generateKeys()), game }, { matchId: null, seq, from: id });
}
export function ballEndAs(id: string, g: GrantBody, seq: number, score = 5200): AnyMessage {
  return buildMessage('BALL_END', { grantSeq: g.grantSeq, ballNumber: g.ballNumber, finalScore: score, detectorReason: 'nvram', shootAgain: false }, { matchId: CODE, seq, from: id });
}

/** A number far above any a test's own engines reach. */
export const HIGH = 1_000_000_000_000_000;
