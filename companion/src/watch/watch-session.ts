/**
 * I11.4.1 (2026-11-16, ADR 0011): the standalone "3D watch" session. One PC hosts and gets a six-letter code, the
 * others join with it (paired with ArcAid, as for a match); any member may then play a table in the VPX fork and the
 * others watch it in their own VPX (`tunnel.ts` carries the stream; this file is who is in, who plays, and the WebRTC
 * signalling for the data connections). It is not a match: no protocol frame, no change to `protocol/` or to ArcAid.
 *
 * The relay is a star through the host (`watch-relay.ts`), so the host keeps the roster and the player role, and
 * forwards the signalling between two clients. Up to `WATCH_MAX` members (the alpha mesh's four); nothing below the
 * session assumes two.
 *
 * Everything in `data` is `castcade-watch:1:` and a JSON object (`t` names it), the way `RELINK` is a private string:
 *   client -> host   hello { id, name, app } · signal { to, s } · play { table } · stop · bye
 *   host -> client   welcome { host, members, player, max } · roster { members, player } · refuse { why, text }
 *                    · signal { from, s } · play_refused { text } · rehello
 * The player role is the host's to give: the first `play` while nobody plays wins; `stop` (the player's VPX closed)
 * or the player leaving frees it, so two testers swap who plays without a new session.
 *
 * Wrong codes end with a sentence, never a hang:
 * - a companion without this feature that joins a watch code from the Match tab sends HELLO, a protocol frame: the
 *   host answers REFUSE (code `other`, `NOT_A_MATCH`), which that companion shows as "The host refused: ...";
 * - a watch client that types a real match's code is refused by ArcAid when the match has started (`locked`);
 *   otherwise the match host does not answer its hello (it logs one unreadable frame) and the join gives up after
 *   `WELCOME_TIMEOUT_MS` with `NOT_A_WATCH_SESSION`. A protocol frame or RELINK coming back says the same at once.
 *
 * A member whose relay socket drops is kept for `AWAY_GRACE_MS` (its data connection, which does not go through
 * ArcAid, may well be fine) and comes back with a new hello; the host that re-registers its room asks everyone it
 * still has for one (`rehello`).
 */
import { buildMessage, encodeFrame } from '@castcade/protocol';
import type { MediaSignal } from '../media/match-media-types.js';
import { newMatchCode } from '../main/match-setup.js';
import { RELINK, RelayError, type RelayOptions } from '../match/transport-relay.js';
import { WatchRelayClient, WatchRelayHost, type WatchRoomState } from './watch-relay.js';

export const WATCH_PREFIX = 'castcade-watch:1:';
/** Members, the host included. The relay takes 8 sockets a room; the alpha mesh is 2 to 4. */
export const WATCH_MAX = 4;
export const WELCOME_TIMEOUT_MS = 8_000;
export const PLAY_TIMEOUT_MS = 8_000;
export const AWAY_GRACE_MS = 30_000;
/** A code ArcAid says is taken is replaced this many times. */
const CODE_TRIES = 3;

/** What an older companion that joins a watch code from the Match tab shows after "The host refused: ". */
export const NOT_A_MATCH = 'this code is a Castcade 3D watch session, not a match. Joining it needs a newer Castcade, and 3D watch on the Match tab.';

export const NOT_A_WATCH_SESSION = (code: string): string =>
  `Nothing answered on ${code} as a 3D watch session. If that is a match code, join it with Join a match above.`;

export interface WatchTableInfo {
  /** The `.vpx` file name, no folder (another PC looks for the same name). */
  name: string;
  size: number;
}

export interface WatchMember {
  id: string;
  name: string;
  /** Its connection to ArcAid dropped; kept for `AWAY_GRACE_MS`. */
  away: boolean;
}

export interface WatchPlayer {
  id: string;
  table: WatchTableInfo;
}

export interface WatchSessionState {
  role: 'host' | 'client';
  code: string;
  me: string;
  hostId: string;
  /** Everyone in, this PC included, host first. */
  members: WatchMember[];
  player: WatchPlayer | null;
  /** This PC's link to ArcAid (the session's control; the stream does not go through it). */
  relay: 'ok' | 'reconnecting' | 'closed';
  /** Why the session is over for this PC; null while it runs. */
  ended: string | null;
}

export interface WatchSessionOptions {
  relay: { baseUrl: string; deviceId: string; deviceToken: string };
  me: { id: string; name: string };
  appVersion: string;
  log(line: string): void;
  /** Test seams. */
  max?: number;
  welcomeTimeoutMs?: number;
  playTimeoutMs?: number;
  awayGraceMs?: number;
  relayOptions?: Partial<Pick<RelayOptions, 'connectTimeoutMs' | 'ackTimeoutMs' | 'pace'>> & { rejoinGapsMs?: readonly number[]; rejoinMaxMisses?: number };
  newCode?: () => string;
}

/** A join that did not get in, in the words the card shows. */
export class WatchJoinError extends Error {
  constructor(
    readonly reason: 'not_a_session' | 'refused' | 'relay',
    message: string,
  ) {
    super(message);
    this.name = 'WatchJoinError';
  }
}

type Msg = Record<string, unknown> & { t: string };

export function encodeWatch(msg: Msg): string {
  return WATCH_PREFIX + JSON.stringify(msg);
}

/** A session message, or null for anything else (another version, a protocol frame, garbage). */
export function decodeWatch(data: string): Msg | null {
  if (!data.startsWith(WATCH_PREFIX)) return null;
  try {
    const v: unknown = JSON.parse(data.slice(WATCH_PREFIX.length));
    return typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string' ? (v as Msg) : null;
  } catch {
    return null;
  }
}

/** A match protocol frame (or the match relay's RELINK): what a match host or a match client sends. */
export function looksLikeMatchFrame(data: string): 'hello' | 'other' | null {
  if (data === RELINK) return 'other';
  if (data.startsWith('castcade-watch:')) return null;
  try {
    const v = JSON.parse(data) as { v?: unknown; type?: unknown };
    if (typeof v !== 'object' || v === null || typeof v.type !== 'string' || v.v === undefined) return null;
    return v.type === 'HELLO' ? 'hello' : 'other';
  } catch {
    return null;
  }
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v : null);

export function tableFrom(v: unknown): WatchTableInfo | null {
  const t = v as { name?: unknown; size?: unknown } | null;
  const name = text(t?.name, 260);
  const size = t?.size;
  if (!name || /[\\/\0\r\n]/.test(name) || typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > 2 ** 40) return null;
  return { name, size };
}

/** A WebRTC signal as the session carries it (the shape `rtc-signaling.ts` sends); null for anything else. */
export function signalFrom(v: unknown): MediaSignal | null {
  const s = v as { kind?: unknown; sdp?: unknown; candidate?: unknown } | null;
  if (typeof s !== 'object' || s === null) return null;
  if (s.kind === 'reset') return { kind: 'reset' };
  if (s.kind === 'offer' || s.kind === 'answer') return typeof s.sdp === 'string' && s.sdp.length <= 200_000 ? { kind: s.kind, sdp: s.sdp } : null;
  if (s.kind === 'ice') {
    const c = s.candidate as { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown } | null;
    if (typeof c !== 'object' || c === null || typeof c.candidate !== 'string' || c.candidate.length > 2000) return null;
    const mid = typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null;
    const idx = typeof c.sdpMLineIndex === 'number' && Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null;
    return { kind: 'ice', candidate: { candidate: c.candidate, sdpMid: mid, sdpMLineIndex: idx } };
  }
  return null;
}

function membersFrom(v: unknown): WatchMember[] | null {
  if (!Array.isArray(v) || v.length > 16) return null;
  const out: WatchMember[] = [];
  for (const m of v as Array<{ id?: unknown; name?: unknown; away?: unknown }>) {
    const id = text(m?.id, 64);
    if (!id) return null;
    out.push({ id, name: text(m.name, 64) ?? id, away: m.away === true });
  }
  return out;
}

function playerFrom(v: unknown): WatchPlayer | null {
  const p = v as { id?: unknown; table?: unknown } | null;
  const id = text(p?.id, 64);
  const table = tableFrom(p?.table);
  return id && table ? { id, table } : null;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The card's sentence for a relay refusal of a join or a host (`RelayError.code`). */
export function relayWords(code: string | null, sessionCode: string, detail: string): string {
  switch (code) {
    case 'no_such_match':
      return `Nothing is hosted on ${sessionCode}: check the six letters with the host.`;
    case 'locked':
      return `${sessionCode} is a match that has started, not a 3D watch session.`;
    case 'full':
      return `The session ${sessionCode} is full.`;
    case 'unauthorized':
      return 'ArcAid did not accept this PC: pair it with ArcAid again in Settings.';
    case 'rate_limited':
      return 'ArcAid is holding this PC back after too many tries: wait a few minutes, then try again.';
    case 'unreachable':
      return `ArcAid could not be reached (${detail}): check this PC's internet connection.`;
    case 'code_in_use':
    case 'server_busy':
      return `ArcAid could not open a room (${detail}): try again in a minute.`;
    default:
      return `ArcAid refused: ${detail}`;
  }
}

interface HostMember extends WatchMember {
  relayPeer: string | null;
  awayTimer: ReturnType<typeof setTimeout> | null;
}

type Listener<A extends unknown[]> = Set<(...a: A) => void>;

export class WatchSession {
  readonly role: 'host' | 'client';
  readonly me: string;
  private code = '';
  private hostId: string;
  private members: WatchMember[] = [];
  private player: WatchPlayer | null = null;
  private relayState: WatchSessionState['relay'] = 'ok';
  private ended: string | null = null;
  // host side
  private readonly hostMembers = new Map<string, HostMember>();
  private readonly byRelay = new Map<string, string>();
  private readonly refusedFrames = new Set<string>();
  private host: WatchRelayHost | null = null;
  // client side
  private client: WatchRelayClient | null = null;
  private welcomed: ((m: Msg) => void) | null = null;
  private playWait: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly changeL: Listener<[WatchSessionState]> = new Set();
  private readonly signalL: Listener<[string, MediaSignal]> = new Set();
  private readonly endedL: Listener<[string]> = new Set();
  private readonly offs: Array<() => void> = [];

  private constructor(
    private readonly o: WatchSessionOptions,
    role: 'host' | 'client',
  ) {
    this.role = role;
    this.me = o.me.id;
    this.hostId = role === 'host' ? o.me.id : '';
  }

  private relayOpts(): RelayOptions & { rejoinGapsMs?: readonly number[]; rejoinMaxMisses?: number } {
    return { localId: this.me, baseUrl: this.o.relay.baseUrl, auth: { deviceId: this.o.relay.deviceId, deviceToken: this.o.relay.deviceToken }, ...this.o.relayOptions };
  }

  private get max(): number {
    return this.o.max ?? WATCH_MAX;
  }

  // ---------------------------------------------------------------------------------------- host --

  /** Host a session: a fresh code, registered with ArcAid. Rejects with the card's sentence. */
  static async host(o: WatchSessionOptions): Promise<WatchSession> {
    const s = new WatchSession(o, 'host');
    const relay = new WatchRelayHost(s.relayOpts());
    s.host = relay;
    s.hostMembers.set(s.me, { id: s.me, name: o.me.name, away: false, relayPeer: null, awayTimer: null });
    s.offs.push(relay.onData((from, data) => s.hostData(from, data)));
    s.offs.push(relay.onLeft((peer) => s.hostLeft(peer)));
    s.offs.push(relay.onState((st, why, present) => s.hostRoom(st, why, present)));
    s.offs.push(relay.onError((e) => o.log(`watch: ArcAid: ${e.message}`)));
    let last: unknown = null;
    for (let k = 0; k < CODE_TRIES; k++) {
      const code = (o.newCode ?? newMatchCode)();
      try {
        await relay.host(code);
        s.code = code;
        s.syncHostView();
        o.log(`watch: hosting the 3D watch session ${code} through ArcAid`);
        return s;
      } catch (e) {
        last = e;
        if (!(e instanceof RelayError && e.code === 'code_in_use')) break;
      }
    }
    s.dispose();
    throw new WatchJoinError('relay', relayWords(last instanceof RelayError ? last.code : null, '', describe(last)));
  }

  private hostData(relayPeer: string, data: string): void {
    const msg = decodeWatch(data);
    if (!msg) return this.foreign(relayPeer, data);
    if (msg.t === 'hello') return this.hello(relayPeer, msg);
    const id = this.byRelay.get(relayPeer);
    const m = id ? this.hostMembers.get(id) : undefined;
    if (!m) {
      // A socket this host does not know (it re-registered and missed the hello): ask for one.
      this.host?.sendTo(relayPeer, encodeWatch({ t: 'rehello' }));
      return;
    }
    switch (msg.t) {
      case 'signal': {
        const to = text(msg.to, 64);
        const sig = signalFrom(msg.s);
        if (!to || !sig) return;
        if (to === this.me) return this.emitSignal(m.id, sig);
        const target = this.hostMembers.get(to);
        if (target?.relayPeer) this.host?.sendTo(target.relayPeer, encodeWatch({ t: 'signal', from: m.id, s: sig }));
        return;
      }
      case 'play': {
        const table = tableFrom(msg.table);
        if (!table) return;
        if (this.player && this.player.id !== m.id) {
          const who = this.hostMembers.get(this.player.id)?.name ?? this.player.id;
          this.host?.sendTo(relayPeer, encodeWatch({ t: 'play_refused', text: `${who} is playing a table now: wait until they close it.` }));
          return;
        }
        this.player = { id: m.id, table };
        this.o.log(`watch: ${m.name} plays ${table.name}`);
        return this.broadcast();
      }
      case 'stop':
        if (this.player?.id !== m.id) return;
        this.player = null;
        this.o.log(`watch: ${m.name} closed their table`);
        return this.broadcast();
      case 'bye':
        return this.removeMember(m.id, 'left');
    }
  }

  /** Not a session message: a companion without this feature answering the code as a match gets REFUSE. */
  private foreign(relayPeer: string, data: string): void {
    const kind = looksLikeMatchFrame(data);
    if (kind !== 'hello') return;
    if (this.refusedFrames.has(relayPeer)) return;
    this.refusedFrames.add(relayPeer);
    this.o.log('watch: a match HELLO arrived on the watch code (a Castcade without 3D watch, or the Match tab): refused it');
    try {
      const refuse = buildMessage('REFUSE', { code: 'other', message: NOT_A_MATCH }, { matchId: null, seq: 1, from: this.me });
      this.host?.sendTo(relayPeer, encodeFrame(refuse));
    } catch (e) {
      this.o.log(`watch: could not refuse it (${describe(e)})`);
    }
  }

  private hello(relayPeer: string, msg: Msg): void {
    const id = text(msg.id, 64);
    const name = text(msg.name, 64)?.trim() ?? id;
    if (!id || !name) return;
    const refuse = (why: string, words: string): void => {
      this.host?.sendTo(relayPeer, encodeWatch({ t: 'refuse', why, text: words }));
      this.o.log(`watch: refused ${name} (${why})`);
    };
    if (id === this.me) return refuse('same_pc', 'This PC is hosting that session: join it from another PC.');
    let m = this.hostMembers.get(id);
    if (!m) {
      if (this.hostMembers.size >= this.max) return refuse('full', `The session is full (${this.max} PCs).`);
      m = { id, name, away: false, relayPeer, awayTimer: null };
      this.hostMembers.set(id, m);
      this.o.log(`watch: ${name} joined`);
    } else {
      // The same PC again: a new socket after a drop, or a hello asked for (rehello).
      if (m.relayPeer && m.relayPeer !== relayPeer) this.byRelay.delete(m.relayPeer);
      m.relayPeer = relayPeer;
      m.name = name;
      if (m.awayTimer) clearTimeout(m.awayTimer);
      m.awayTimer = null;
      if (m.away) this.o.log(`watch: ${name} is back`);
      m.away = false;
    }
    this.byRelay.set(relayPeer, id);
    this.syncHostView();
    this.host?.sendTo(relayPeer, encodeWatch({ t: 'welcome', host: this.me, members: this.members, player: this.player, max: this.max }));
    this.broadcast(id);
  }

  private hostLeft(relayPeer: string): void {
    this.refusedFrames.delete(relayPeer);
    const id = this.byRelay.get(relayPeer);
    this.byRelay.delete(relayPeer);
    const m = id ? this.hostMembers.get(id) : undefined;
    if (!m || m.relayPeer !== relayPeer) return;
    this.markAway(m);
  }

  private markAway(m: HostMember): void {
    m.relayPeer = null;
    if (m.away) return;
    m.away = true;
    this.o.log(`watch: ${m.name}'s connection to ArcAid dropped; keeping them for ${Math.round((this.o.awayGraceMs ?? AWAY_GRACE_MS) / 1000)} s`);
    m.awayTimer = setTimeout(() => this.removeMember(m.id, 'gone'), this.o.awayGraceMs ?? AWAY_GRACE_MS);
    this.broadcast();
  }

  private removeMember(id: string, why: 'left' | 'gone'): void {
    const m = this.hostMembers.get(id);
    if (!m || id === this.me) return;
    if (m.awayTimer) clearTimeout(m.awayTimer);
    if (m.relayPeer) this.byRelay.delete(m.relayPeer);
    this.hostMembers.delete(id);
    if (this.player?.id === id) this.player = null;
    this.o.log(`watch: ${m.name} ${why === 'left' ? 'left' : 'is gone (no word for too long)'}`);
    this.broadcast();
  }

  private hostRoom(st: WatchRoomState, why: string | null, present: string[] | null): void {
    if (st === 'registered') {
      this.relayState = 'ok';
      if (present) {
        // Back after a drop: who the server still has is asked for a hello (what crossed meanwhile was lost); the
        // others come back by themselves or go after the grace.
        this.o.log('watch: the session room is ours again');
        for (const m of this.hostMembers.values()) {
          if (m.id === this.me) continue;
          if (m.relayPeer && present.includes(m.relayPeer)) this.host?.sendTo(m.relayPeer, encodeWatch({ t: 'rehello' }));
          else this.markAway(m);
        }
      }
    } else if (st === 'reconnecting') {
      this.relayState = 'reconnecting';
      if (why) this.o.log(`watch: ${why}`);
    } else if (st === 'closed') {
      this.relayState = 'closed';
      this.o.log(`watch: ${why ?? 'ArcAid closed the room'}; the PCs already connected stay connected, nobody new can join`);
    }
    this.emitChange();
  }

  /** The host's own view, from its member map (host first, then by join order). */
  private syncHostView(): void {
    this.members = [...this.hostMembers.values()].map((m) => ({ id: m.id, name: m.name, away: m.away }));
  }

  /** The roster to every client (but `except`, which just got its welcome), and to this PC's listeners. */
  private broadcast(except: string | null = null): void {
    this.syncHostView();
    const msg = encodeWatch({ t: 'roster', members: this.members, player: this.player });
    for (const m of this.hostMembers.values()) if (m.relayPeer && m.id !== except) this.host?.sendTo(m.relayPeer, msg);
    this.emitChange();
  }

  // -------------------------------------------------------------------------------------- client --

  /**
   * Join the session of `code`. Resolves once the host welcomed this PC; rejects with a `WatchJoinError` whose message
   * is the card's sentence (a code that is a match, a full session, an unpaired PC, ArcAid out of reach).
   */
  static async join(o: WatchSessionOptions, rawCode: string): Promise<WatchSession> {
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-Z]{6}$/.test(code)) throw new WatchJoinError('refused', 'The code is six letters, like JHDFEF.');
    const s = new WatchSession(o, 'client');
    s.code = code;
    const relay = new WatchRelayClient(s.relayOpts());
    s.client = relay;
    const welcome = new Promise<Msg>((resolve, reject) => {
      s.welcomed = resolve;
      s.offs.push(
        relay.onData((data) => {
          const msg = decodeWatch(data);
          if (msg) return s.clientData(msg, reject);
          if (s.welcomed && looksLikeMatchFrame(data)) reject(new WatchJoinError('not_a_session', `${code} is a match, not a 3D watch session: join it with Join a match above.`));
        }),
      );
    });
    // Settled before anyone awaits it (a refusal during the join itself) is not an unhandled rejection.
    welcome.catch(() => undefined);
    s.offs.push(relay.onError((e) => o.log(`watch: ArcAid: ${e.message}`)));
    try {
      await relay.join(code);
    } catch (e) {
      s.dispose();
      throw new WatchJoinError('relay', relayWords(e instanceof RelayError ? e.code : null, code, describe(e)));
    }
    s.sendHello();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const w = await Promise.race([
        welcome,
        new Promise<never>((_r, reject) => {
          timer = setTimeout(() => reject(new WatchJoinError('not_a_session', NOT_A_WATCH_SESSION(code))), o.welcomeTimeoutMs ?? WELCOME_TIMEOUT_MS);
        }),
      ]);
      s.welcome(w);
    } catch (e) {
      s.dispose();
      throw e;
    } finally {
      clearTimeout(timer);
      s.welcomed = null;
    }
    s.offs.push(
      relay.onDown((why, final) => {
        if (final) return s.end(why);
        s.relayState = 'reconnecting';
        o.log(`watch: ${why}; asking ArcAid for the session again`);
        s.emitChange();
      }),
      relay.onUp(() => {
        s.relayState = 'ok';
        o.log('watch: back in the session room');
        s.sendHello();
        s.emitChange();
      }),
    );
    o.log(`watch: joined the 3D watch session ${code}`);
    return s;
  }

  private sendHello(): void {
    this.client?.send(encodeWatch({ t: 'hello', id: this.me, name: this.o.me.name, app: this.o.appVersion.slice(0, 32) }));
  }

  private welcome(w: Msg): void {
    const members = membersFrom(w.members);
    const host = text(w.host, 64);
    if (!members || !host) throw new WatchJoinError('refused', 'The host sent a welcome this Castcade cannot read: update Castcade on both PCs.');
    this.hostId = host;
    this.members = members;
    this.player = w.player === null ? null : playerFrom(w.player);
    this.emitChange();
  }

  private clientData(msg: Msg, rejectJoin: (e: Error) => void): void {
    switch (msg.t) {
      case 'welcome':
        if (this.welcomed) return this.welcomed(msg);
        try {
          this.welcome(msg);
        } catch (e) {
          this.o.log(`watch: ${describe(e)}`);
        }
        return this.settlePlay();
      case 'refuse': {
        const words = text(msg.text, 300) ?? 'The host refused this PC.';
        if (this.welcomed) return rejectJoin(new WatchJoinError('refused', words));
        return this.end(words);
      }
      case 'roster': {
        const members = membersFrom(msg.members);
        if (!members) return;
        this.members = members;
        this.player = msg.player === null || msg.player === undefined ? null : playerFrom(msg.player);
        this.emitChange();
        return this.settlePlay();
      }
      case 'signal': {
        const from = text(msg.from, 64);
        const sig = signalFrom(msg.s);
        if (from && sig) this.emitSignal(from, sig);
        return;
      }
      case 'play_refused': {
        const w = this.playWait;
        if (!w) return;
        this.playWait = null;
        clearTimeout(w.timer);
        w.reject(new Error(text(msg.text, 300) ?? 'The host did not give this PC the table.'));
        return;
      }
      case 'rehello':
        return this.sendHello();
    }
  }

  private settlePlay(): void {
    const w = this.playWait;
    if (!w || this.player?.id !== this.me) return;
    this.playWait = null;
    clearTimeout(w.timer);
    w.resolve();
  }

  // -------------------------------------------------------------------------------------- shared --

  state(): WatchSessionState {
    return { role: this.role, code: this.code, me: this.me, hostId: this.hostId, members: this.members.map((m) => ({ ...m })), player: this.player ? { ...this.player, table: { ...this.player.table } } : null, relay: this.relayState, ended: this.ended };
  }

  /** The other members (the data connections to open). */
  peers(): string[] {
    return this.members.filter((m) => m.id !== this.me).map((m) => m.id);
  }

  onChange(cb: (s: WatchSessionState) => void): () => void {
    this.changeL.add(cb);
    return () => this.changeL.delete(cb);
  }

  onSignal(cb: (from: string, s: MediaSignal) => void): () => void {
    this.signalL.add(cb);
    return () => this.signalL.delete(cb);
  }

  onEnded(cb: (why: string) => void): () => void {
    this.endedL.add(cb);
    return () => this.endedL.delete(cb);
  }

  /** A WebRTC signal for `to`'s data connection, through the host. */
  sendSignal(to: string, s: MediaSignal): void {
    if (this.ended) return;
    if (this.role === 'client') {
      this.client?.send(encodeWatch({ t: 'signal', to, s }));
      return;
    }
    const target = this.hostMembers.get(to);
    if (target?.relayPeer) this.host?.sendTo(target.relayPeer, encodeWatch({ t: 'signal', from: this.me, s }));
  }

  /** Take the player role for `table`. Resolves once it is this PC's; rejects with the reason (someone else plays). */
  play(table: WatchTableInfo): Promise<void> {
    if (this.ended) return Promise.reject(new Error('The session is over.'));
    if (this.role === 'host') {
      if (this.player && this.player.id !== this.me) {
        const who = this.hostMembers.get(this.player.id)?.name ?? this.player.id;
        return Promise.reject(new Error(`${who} is playing a table now: wait until they close it.`));
      }
      this.player = { id: this.me, table: { ...table } };
      this.o.log(`watch: this PC plays ${table.name}`);
      this.broadcast();
      return Promise.resolve();
    }
    if (this.playWait) return Promise.reject(new Error('Already asking the host for the table.'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.playWait = null;
        reject(new Error('The host did not answer: try again.'));
      }, this.o.playTimeoutMs ?? PLAY_TIMEOUT_MS);
      this.playWait = { resolve, reject, timer };
      this.client?.send(encodeWatch({ t: 'play', table }));
    });
  }

  /** This PC's table closed: the player role is free again. */
  stopPlaying(): void {
    if (this.player?.id !== this.me) return;
    if (this.role === 'host') {
      this.player = null;
      this.o.log('watch: this PC closed its table');
      this.broadcast();
      return;
    }
    this.client?.send(encodeWatch({ t: 'stop' }));
  }

  /** Leave on purpose (the host's leaving closes the room for everyone). */
  async leave(): Promise<void> {
    if (this.ended) return;
    if (this.role === 'client') this.client?.send(encodeWatch({ t: 'bye' }));
    // Give the bye a moment to leave the socket (the pacer emits at once when it has room).
    await new Promise((r) => setTimeout(r, 50));
    this.end('you left the session');
  }

  private end(why: string): void {
    if (this.ended) return;
    this.ended = why;
    this.relayState = 'closed';
    this.o.log(`watch: the session ${this.code} is over for this PC (${why})`);
    this.dispose();
    this.emitChange();
    for (const cb of [...this.endedL]) cb(why);
  }

  private dispose(): void {
    for (const off of this.offs.splice(0)) off();
    for (const m of this.hostMembers.values()) if (m.awayTimer) clearTimeout(m.awayTimer);
    if (this.playWait) {
      clearTimeout(this.playWait.timer);
      this.playWait.reject(new Error('The session is over.'));
      this.playWait = null;
    }
    this.host?.close();
    this.client?.close();
    this.host = null;
    this.client = null;
  }

  private emitSignal(from: string, s: MediaSignal): void {
    for (const cb of [...this.signalL]) cb(from, s);
  }

  private emitChange(): void {
    const st = this.state();
    for (const cb of [...this.changeL]) cb(st);
  }
}
