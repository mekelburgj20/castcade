/**
 * A17 step 6 (2026-11-25): a lobby on links that can drop and come back, for the tests of what a lobby does about
 * starts, tables, people who are away and people who return (`lobby-start.test.ts`, `lobby-away.test.ts`). The
 * engines run with the lobby option on, over `TapTransport` (a star on the in-memory bus: `cut` drops a link for
 * both ends, `connectTo` makes it again) and a manual clock, so three minutes of waiting are one line of a test.
 * Every frame each engine sends is recorded as text.
 */
import type { AnyMessage, GameFingerprint, ParticipantInfo, PayloadOf, PlayerId, Stance } from '@castcade/protocol';
import { ClientMatch, type ClientOptions, type DroppedInfo, type ResultInfo } from './client.js';
import { ManualClock } from './clock.js';
import { HostMatch, type LobbyOptions, type RejectInfo } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { TapTransport, type RecordedFrame } from './lobby-off.test-support.js';
import { MemoryBus } from './transport.js';

/** Let every frame in flight land. The bus delivers on the microtask queue: a few turns of the event loop empty it (no timer: a timer of 0 costs up to 15 ms on Windows). */
export const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

const hex = (pair: string): string => pair.repeat(32);
/** The lobby's table, open and patched. */
export const TABLE: GameFingerprint = { kind: 'vpx', tableName: 'Monster Bash (Williams 1998) 2.1', tableHash: hex('ab'), romName: 'mb_106b', romHash: hex('cd'), physicsHash: null, recipeVersion: '0.5.0', sidecarHash: hex('ef'), emulatorVersion: '10.8.0' };
/** The same game in another file (another build of the table). */
export const SAME_GAME: GameFingerprint = { ...TABLE, tableName: 'Monster Bash (Williams 1998) VPW 1.1', tableHash: hex('12'), sidecarHash: hex('34') };
/** Another game. */
export const OTHER_GAME: GameFingerprint = { ...TABLE, tableName: 'Congo (Williams 1995)', tableHash: hex('56'), romName: 'congo_21', romHash: hex('78') };
/** No table open: what a PC says before its VPX has loaded one. */
export const NO_TABLE: GameFingerprint = { kind: 'vpx', tableName: 'none', tableHash: '0'.repeat(64), romName: null, romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '' };

/**
 * `TapTransport` whose `closePeer` closes one link and not the peer for good: what a socket transport does when the
 * engine refuses a first frame. The frames already sent on the link arrive first (a socket delivers, then closes),
 * then both ends see the link drop, and the peer may open a new one.
 */
class StarTap extends TapTransport {
  override closePeer(peer: PlayerId): void {
    setImmediate(() => this.cut(peer));
  }
}

export interface StarRig {
  bus: MemoryBus;
  clock: ManualClock;
  taps: Map<PlayerId, TapTransport>;
  frames: RecordedFrame[];
  host: HostMatch;
  hostKeys: KeyPair;
  clients: Record<string, ClientMatch>;
  keys: Record<string, KeyPair>;
  /** Every REJECT the lobby's PC sent (and its own, `to` itself). */
  rejects: RejectInfo[];
  /** The sentences each client was shown (`REJECT.message`), in order. */
  said: Record<string, string[]>;
  dropped: Record<string, DroppedInfo[]>;
  results: Record<string, ResultInfo[]>;
  /** What each client's engine raised, by name, in order (the events a shell wires). */
  events: Record<string, string[]>;
  /** The lobby as a client last heard it. */
  lobby(id: string): PayloadOf<'HELLO_ACK'>;
  /** One more member joins now. */
  join(id: string, opts?: { stance?: Stance; game?: GameFingerprint; ballEndReady?: boolean }): Promise<ClientMatch>;
  /** The link between a member and the lobby's PC drops; it cannot be made again until `mend`. */
  cut(id: string): Promise<void>;
  /** The link can be made again: the clock moves, a second at a time, until the member's next attempt got through. */
  mend(id: string): Promise<void>;
  /**
   * The lobby's PC is back on the relay and tells the member to open its link again (the relay transport's RELINK):
   * the member's link "drops" once more, which starts its attempts afresh, and the first of them gets through.
   */
  relink(id: string): Promise<void>;
  /** Let every frame land, move the clock, and let what that caused land too. */
  tick(ms: number): Promise<void>;
  /** The frames `by` sent to `to`, decoded, from index `from` of `frames` on. */
  sent(by: string, to: string, from?: number): AnyMessage[];
}

export interface StarOptions {
  balls?: number;
  stances?: Record<string, Stance>;
  /** A member's own table at the join; default the lobby's. `h` is the lobby's PC. */
  tables?: Record<string, GameFingerprint>;
  ballEndReady?: Record<string, boolean>;
  lobby?: LobbyOptions;
  /** A18's grace on both sides. Default 5 s. */
  grace?: number;
  client?: Partial<ClientOptions>;
}

const who = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: id.toUpperCase(), publicKey: keys.publicKeyB64, rig: 'pc' });

/** A lobby `JHDFEF` with `h` as its PC and the given clients joined, nothing started. Names are the ids in capitals. */
export async function starLobby(clientIds: string[], opts: StarOptions = {}): Promise<StarRig> {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const taps = new Map<PlayerId, TapTransport>();
  const frames: RecordedFrame[] = [];
  const tap = (id: PlayerId): TapTransport => new StarTap(bus.transport(id), bus, taps, frames);
  const hostKeys = generateKeys();
  const grace = opts.grace ?? 5000;
  const host = new HostMatch({
    disconnectGraceMs: grace,
    transport: tap('h'),
    keys: hostKeys,
    matchId: 'JHDFEF',
    ballsPerGame: opts.balls ?? 1,
    hostParticipant: who('h', hostKeys),
    hostGame: opts.tables?.['h'] ?? TABLE,
    clock,
    ...(opts.ballEndReady?.['h'] !== undefined ? { ballEndReady: opts.ballEndReady['h'] } : {}),
    lobby: { ...(opts.lobby ?? {}), stance: opts.stances?.['h'] ?? 'play' },
  });
  const r: StarRig = {
    bus,
    clock,
    taps,
    frames,
    host,
    hostKeys,
    clients: {},
    keys: {},
    rejects: [],
    said: {},
    dropped: {},
    results: {},
    events: {},
    lobby(id) {
      const ack = r.clients[id]?.lobby();
      if (!ack) throw new Error(`${id} has not heard the lobby`);
      return ack;
    },
    async join(id, o = {}) {
      const k = generateKeys();
      r.keys[id] = k;
      const ready = o.ballEndReady ?? opts.ballEndReady?.[id];
      const c = new ClientMatch({
        disconnectGraceMs: grace,
        transport: tap(id),
        keys: k,
        participant: who(id, k),
        game: o.game ?? opts.tables?.[id] ?? TABLE,
        throwdownCode: 'JHDFEF',
        hostId: 'h',
        clock,
        ...(ready !== undefined ? { ballEndReady: ready } : {}),
        reconnect: { delayMs: 1000 },
        lobby: { stance: o.stance ?? opts.stances?.[id] ?? 'play' },
        ...(opts.client ?? {}),
      });
      r.clients[id] = c;
      const log: string[] = (r.events[id] = []);
      r.said[id] = [];
      r.dropped[id] = [];
      r.results[id] = [];
      c.on('reject', (x) => r.said[id]?.push(x.message));
      c.on('dropped', (d) => r.dropped[id]?.push(d));
      c.on('result', (x) => r.results[id]?.push(x));
      c.on('joined', () => log.push('joined'));
      c.on('ready', (x) => log.push(`ready ${x.matchId}`));
      c.on('nextGame', (x) => log.push(`nextGame ${x.game}`));
      c.on('matchEnded', (x) => log.push(`matchEnded ${x.games}${x.abandoned ? ` abandoned ${x.abandoned}` : ''}`));
      c.on('peerLeft', (x) => log.push(`peerLeft ${x}`));
      c.on('reconnected', (x) => log.push(`reconnected ${x.entries}${x.quiet ? ' quiet' : ''}`));
      c.on('reconnectRejected', (x) => log.push(`reconnectRejected ${x.code}`));
      c.on('rejoining', () => log.push('rejoining'));
      c.on('refused', (x) => log.push(`refused ${x.code}`));
      c.on('caughtUp', (x) => log.push(`caughtUp ${x.match} ${x.entries}`));
      c.on('pause', (x) => log.push(`pause ${x.reason} ${x.player}`));
      c.on('forfeit', (x) => log.push(`forfeit ${x.payload.player}`));
      c.on('hostLost', () => log.push('hostLost'));
      c.on('hostGone', () => log.push('hostGone'));
      c.on('lobbyClosed', () => log.push('lobbyClosed'));
      c.on('desync', (x) => log.push(`desync ${x.context}`));
      c.join();
      await flush();
      return c;
    },
    async cut(id) {
      const t = taps.get(id);
      if (!t) throw new Error(`no link for ${id}`);
      t.unreachable = true;
      t.cut('h');
      await flush();
    },
    async mend(id) {
      const t = taps.get(id);
      if (!t) throw new Error(`no link for ${id}`);
      t.unreachable = false;
      // The member's next attempt: a second away at first, further apart after several that failed (half a minute at most).
      for (let i = 0; i < 31; i++) {
        clock.advance(1000);
        await flush();
        if (r.clients[id]?.hostAway() === null) break;
      }
    },
    async relink(id) {
      const t = taps.get(id);
      if (!t) throw new Error(`no link for ${id}`);
      t.unreachable = false;
      t.cut('h');
      await flush();
      clock.advance(1000);
      await flush();
    },
    async tick(ms) {
      await flush();
      clock.advance(ms);
      await flush();
    },
    sent(by, to, from = 0) {
      return frames
        .slice(from)
        .filter((f) => f.by === by && f.to === to)
        .map((f) => JSON.parse(f.frame) as AnyMessage);
    },
  };
  host.on('reject', (x) => r.rejects.push(x));
  for (const id of clientIds) await r.join(id);
  return r;
}

/** Whoever holds the grant ends their ball, until the game is over and its RESULT is out. */
export async function playGame(r: StarRig, base = 100): Promise<void> {
  let n = 0;
  for (let guard = 0; guard < 200 && r.host.state.phase === 'running'; guard++) {
    const g = r.host.state.currentGrant?.grant;
    if (!g) throw new Error(`no grant is outstanding (paused: ${JSON.stringify(r.host.state.paused)})`);
    n += 1;
    if (g.player === 'h') r.host.localBallEnd(base + n, 'nvram');
    else (r.clients[g.player] as ClientMatch).reportBallEnd(base + n, 'script');
    await flush(4);
  }
  await flush();
  if (!r.host.resultOut) throw new Error('the game ended and no RESULT went out');
}

/** The countdown of the announced start runs out (five seconds on the clock), and what it started has landed. */
export async function countDown(r: StarRig, ms = 5000): Promise<void> {
  await r.tick(ms);
}

/**
 * A18's fix, and step 6's rule for the lobby's form: every RECONNECT_ACK, and every MATCH_LOG page, names the head
 * of the log it carries. With entries: the hash and the place of its last one. An answer that is a `restart`, or a
 * refusal, carries no log: 64 zeros, length 0. An answer with nothing to add: the head the RECONNECT itself named.
 */
export function expectHeadsNamed(r: StarRig, expect: (ok: boolean, what: string) => void): number {
  let seen = 0;
  const asked = new Map<string, { logHash: string; logLength: number }>();
  for (const f of r.frames) {
    const m = JSON.parse(f.frame) as AnyMessage;
    if (m.type === 'RECONNECT') asked.set(m.from, { logHash: m.payload.logHash, logLength: m.payload.logLength });
    if (m.type !== 'RECONNECT_ACK' && m.type !== 'MATCH_LOG') continue;
    seen += 1;
    const what = `${m.type} seq ${m.seq} to ${f.to}`;
    const entries = m.payload.entries as { index: number; hash: string }[];
    const last = entries[entries.length - 1];
    if (last) {
      expect(m.payload.logHash === last.hash && m.payload.logLength === last.index + 1, `${what}: the head of its last entry`);
    } else if (m.type === 'RECONNECT_ACK' && (!m.payload.accept || m.payload.restart === true)) {
      expect(m.payload.logHash === '0'.repeat(64) && m.payload.logLength === 0, `${what}: no log, so no head`);
    } else if (m.type === 'RECONNECT_ACK') {
      const q = asked.get(String(f.to));
      expect(q !== undefined && m.payload.logHash === q.logHash && m.payload.logLength === q.logLength, `${what}: nothing to add, the head that was asked from`);
    }
  }
  return seen;
}
