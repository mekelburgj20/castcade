/**
 * A17 step 5 (2026-11-25): the scripted member of a LOBBY, and the runner of a lobby scenario. The engines run with
 * `HostOptions.lobby` / `ClientOptions.lobby` on: one lobby, several matches in it one after the other, players by
 * choice (Play or Watch), people who join while a match is played. `runLobbyScenario` wires the scenario's players
 * over a MemoryBus (or over the transports it is given: the relay double, links that can drop) and returns what each
 * of them saw: every match with its own log, its RESULTs and its MATCH_END, what was refused, rejected or dropped,
 * and how many frames of each type each member's engine sent (a watcher sends none of a player's).
 *
 * Step 6: a match can be ASKED for, by any member, from a button or from their own table (`LobbyMatchScript.start`),
 * with a second ask in the same moment, a second press that starts without what is waited for, and an end for
 * everyone in the middle of a game; and a member's link can drop and come back (`PlayerScript.drops`, on links the
 * caller can cut). A match without `start` is still started by the lobby's PC itself, at once, as in step 5. The
 * lobby's PC ends each match (or lets the next one's start end it) and closes the lobby at the end, which is when
 * every player is done. Nothing here is the plain match's scripted player (`lib.ts`), which stays as it was.
 */
import type { GameFingerprint, GrantBody, ParticipantInfo, PayloadOf, PlayerId } from '@castcade/protocol';
import {
  ClientMatch,
  GENESIS_HASH,
  HostMatch,
  MemoryBus,
  generateKeys,
  logSignBody,
  realClock,
  verifyCanonical,
  type Clock,
  type DesyncInfo,
  type DroppedInfo,
  type KeyPair,
  type LogHead,
  type MatchLog,
  type Transport,
} from '@castcade/companion';
import { defaultFingerprint, type LobbyAsk, type PlayerScript, type Scenario } from './scenario.js';

/** One match of the lobby as one member saw it. */
export interface LobbyMatchOutcome {
  matchId: string;
  ready: PayloadOf<'MATCH_READY'>;
  /** One per game, with what a client's own checks said (the lobby's PC made them). */
  results: { result: PayloadOf<'RESULT'>; logMatches: boolean; signatureValid: boolean }[];
  /** MATCH_END as it came; null when the lobby closed with the match still open. */
  end: PayloadOf<'MATCH_END'> | null;
  /** This member's log of the match as it stood when the match was over. */
  log: MatchLog | null;
  head: LogHead | null;
}

export interface LobbyOutcome {
  playerId: PlayerId;
  publicKey: string;
  role: 'host' | 'client';
  /** Every match this member was in the lobby for, in order (a member who joined late has none before its join). */
  matches: LobbyMatchOutcome[];
  closed: PayloadOf<'LOBBY_CLOSED'> | null;
  refused: PayloadOf<'REFUSE'> | null;
  rejects: PayloadOf<'REJECT'>[];
  dropped: DroppedInfo[];
  desyncs: DesyncInfo[];
  /** The logs this member was sent in MATCH_LOG pages (a join while a match was open, a return into another match). */
  caughtUp: { match: string; entries: number }[];
  /** The lobby's PC only: the members it sent a log to, with the pages and what was committed meanwhile. */
  sentLogs: { playerId: PlayerId; entries: number; pages: number; during: number }[];
  /** The frames this member's engine handed to its transport, by type. */
  sent: Record<string, number>;
  /** The lobby as last said (HELLO_ACK). */
  lobby: PayloadOf<'HELLO_ACK'> | null;
  /** The `seq` of every frame the lobby's PC sent that this member was handed, in order (it never starts over). */
  hostSeqs: number[];
  /** Step 6: every announced start this member was told of, as `by:players:newMatch:waitsFor`, each once, in order. */
  starts: string[];
  /** Step 6: the sentences with which an announced start was taken away. */
  startOffs: string[];
  /** Step 6: every PAUSE this member's log took, as `reason player`. */
  pauses: string[];
  /** Step 6: a client: the entries each accepted RECONNECT brought; the lobby's PC: who came back (`id`, `id quiet`). */
  reconnects: string[];
  /** Step 6: how often this client's place was gone and it said HELLO again. */
  rejoins: number;
  /** Step 6: the lobby's PC: the RECONNECTs it did not take, as `id code`. */
  reconnectRejected: string[];
  /** Step 6: the lobby's PC: the sentences its own asks were refused with. */
  refusals: string[];
  error: Error | null;
}

export interface LobbyPlayerOptions {
  role: 'host' | 'client';
  transport: Transport;
  script: PlayerScript;
  scenario: Scenario;
  keys?: KeyPair;
  clock?: Clock;
  /** How long a ball "takes". Default 4 ms; 0: no waiting and no STATE, for a long match. */
  ballMs?: number;
  /** Where HELLO goes on a mesh transport; omit on a star (WebSocket, the relay). */
  hostId?: PlayerId;
  disconnectGraceMs?: number;
  /** A client's retry after a dropped link. */
  reconnect?: { attempts?: number; delayMs?: number; maxMs?: number };
  /** The lobby's PC issued the `count`-th grant of match number `match` (1-based). */
  onGrant?: (match: number, count: number) => void;
  onEvent?: (player: PlayerId, event: string, payload: unknown) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** The same transport, counting what goes out through it. */
function counting(t: Transport, sent: Record<string, number>): Transport {
  return new Proxy(t, {
    get(target, prop) {
      if (prop === 'send') {
        return (to: PlayerId | 'all', msg: Parameters<Transport['send']>[1]): void => {
          sent[msg.type] = (sent[msg.type] ?? 0) + 1;
          target.send(to, msg);
        };
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

export class LobbyPlayer {
  readonly playerId: PlayerId;
  readonly keys: KeyPair;
  readonly done: Promise<LobbyOutcome>;
  readonly host: HostMatch | null = null;
  readonly client: ClientMatch | null = null;
  readonly out: LobbyOutcome;
  private current: LobbyMatchOutcome | null = null;
  private playing: string | null = null;
  private grants = 0;
  private finished = false;
  private resolveDone!: (o: LobbyOutcome) => void;
  private readonly ballMs: number;

  constructor(private readonly opts: LobbyPlayerOptions) {
    const { script, scenario } = opts;
    this.playerId = script.playerId;
    this.keys = opts.keys ?? generateKeys();
    this.ballMs = opts.ballMs ?? 4;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.out = {
      playerId: this.playerId,
      publicKey: this.keys.publicKeyB64,
      role: opts.role,
      matches: [],
      closed: null,
      refused: null,
      rejects: [],
      dropped: [],
      desyncs: [],
      caughtUp: [],
      sentLogs: [],
      sent: {},
      lobby: null,
      hostSeqs: [],
      starts: [],
      startOffs: [],
      pauses: [],
      reconnects: [],
      rejoins: 0,
      reconnectRejected: [],
      refusals: [],
      error: null,
    };
    const participant: ParticipantInfo = { playerId: script.playerId, displayName: script.displayName ?? script.playerId, publicKey: this.keys.publicKeyB64, rig: script.rig ?? 'pc' };
    const game: GameFingerprint = { ...defaultFingerprint, ...(script.game ?? {}) };
    const transport = counting(opts.transport, this.out.sent);
    const clock = opts.clock ?? realClock;
    const stance = script.stance ?? 'play';
    const lobby = typeof scenario.lobby === 'object' ? scenario.lobby : {};
    if (opts.role === 'host') {
      this.host = new HostMatch({
        transport,
        keys: this.keys,
        matchId: scenario.matchId,
        ballsPerGame: scenario.ballsPerGame,
        hostParticipant: participant,
        hostGame: game,
        clock,
        ballEndTimeoutMs: scenario.ballEndTimeoutMs,
        logSignTimeoutMs: scenario.logSignTimeoutMs,
        disconnectGraceMs: opts.disconnectGraceMs,
        lobby: { ...lobby, stance },
      });
      this.attachHost(this.host);
    } else {
      opts.transport.onMessage((_from, msg) => {
        if (msg.from === scenario.host) this.out.hostSeqs.push(msg.seq);
      });
      this.client = new ClientMatch({
        transport,
        keys: this.keys,
        participant,
        game,
        throwdownCode: scenario.matchId,
        hostId: opts.hostId,
        clock,
        disconnectGraceMs: opts.disconnectGraceMs,
        reconnect: opts.reconnect,
        lobby: { stance },
      });
      this.attachClient(this.client);
    }
  }

  /** A client says HELLO; the lobby's PC is there already. */
  join(): void {
    this.client?.join();
  }

  /** This member's own choice, said the way its role says it. */
  setStance(stance: 'play' | 'watch'): void {
    if (this.host) this.host.updateLocal({ stance });
    else this.client?.setStance(stance);
  }

  /** Step 10: pick the lobby's table, the way this member's role does: the lobby's PC of its own engine, a client with TABLE_PICK. */
  pick(game: GameFingerprint, tableObjects: { editables: number; hash: string } | null = null): void {
    if (this.host) {
      const why = this.host.pickTable(game, this.playerId, tableObjects);
      if (why !== null) this.out.refusals.push(why);
    } else {
      this.client?.pickTable(game, tableObjects);
    }
  }

  /** Step 10: this member's own table is another one now (its PC closed the one it had and opened this), said to the lobby. */
  openTable(game: GameFingerprint): void {
    if (this.host) this.host.updateLocal({ game });
    else this.client?.updateParticipant({ game });
  }

  /** Step 6: ask for a start, the way this member's role asks: the lobby's PC of its own engine, a client with START_REQUEST. */
  ask(how: LobbyAsk['how'], more: { newMatch?: boolean; anyway?: boolean; now?: boolean } = {}): void {
    const ask = { fromTable: how === 'table', ...more };
    if (this.host) {
      const why = this.host.requestStart(ask);
      if (why !== null) this.out.refusals.push(why);
    } else {
      this.client?.requestStart(ask);
    }
  }

  /** In the lobby, on a link, and holding the open match's log (or none is open). */
  get holdsLog(): boolean {
    if (this.host) return true;
    return this.client !== null && this.client.isJoined && this.client.holdsOpenLog && this.client.hostAway() === null;
  }

  snapshot(): unknown {
    return (this.host ?? this.client)?.snapshot() ?? null;
  }

  private trace(event: string, payload: unknown): void {
    this.opts.onEvent?.(this.playerId, event, payload);
  }

  private begin(ready: PayloadOf<'MATCH_READY'>): void {
    this.current = { matchId: ready.matchId, ready, results: [], end: null, log: null, head: null };
    this.out.matches.push(this.current);
    this.playing = null;
    this.grants = 0;
  }

  private over(end: PayloadOf<'MATCH_END'> | null, log: MatchLog | null): void {
    const m = this.current;
    if (!m || m.log) return;
    m.end = end;
    m.log = log;
    m.head = log ? log.head() : null;
  }

  private noteLobby(ack: PayloadOf<'HELLO_ACK'>): void {
    this.out.lobby = ack;
    if (ack.start) {
      const key = `${ack.start.by}:${ack.start.players.join(',')}:${ack.start.newMatch ? 'new' : 'next'}:${ack.start.waitsFor ?? 'countdown'}`;
      if (this.out.starts[this.out.starts.length - 1] !== key) this.out.starts.push(key);
    }
    if (ack.startOff) this.out.startOffs.push(ack.startOff);
  }

  private attachHost(host: HostMatch): void {
    host.on('lobby', (ack) => this.noteLobby(ack));
    host.on('ready', (ready) => {
      this.trace('ready', ready);
      this.begin(ready);
    });
    host.on('grant', (grant) => {
      this.grants += 1;
      this.opts.onGrant?.(this.out.matches.length, this.grants);
      if (grant.player === this.playerId) this.onMyTurn(grant);
    });
    host.on('ballEnd', (msg) => {
      if (msg.from === this.playerId) this.playing = null;
    });
    host.on('nextGame', () => {
      this.playing = null;
    });
    host.on('pause', (p) => {
      this.trace('pause', p);
      this.out.pauses.push(`${p.reason} ${p.player}`);
    });
    host.on('reject', (info) => {
      this.trace('reject', info);
      if (info.to === this.playerId) this.out.rejects.push({ refSeq: info.refSeq, refType: info.refType, code: info.code, message: info.message });
    });
    host.on('result', ({ result }) => {
      this.trace('result', result);
      this.current?.results.push({ result, logMatches: true, signatureValid: true });
    });
    host.on('matchEnded', (end) => {
      this.trace('matchEnded', end);
      this.over(end, host.previousMatch()?.log ?? null);
    });
    host.on('caughtUp', (x) => {
      this.trace('caughtUp', x);
      this.out.sentLogs.push(x);
    });
    host.on('reconnected', (x) => {
      this.out.reconnects.push(`${x.playerId}${x.quiet ? ' quiet' : ''}`);
      this.trace('reconnected', x);
    });
    host.on('reconnectRejected', (x) => {
      this.out.reconnectRejected.push(`${x.playerId} ${x.code}`);
      this.trace('reconnectRejected', x);
    });
    host.on('peerLeft', (x) => this.trace('peerLeft', x));
    host.on('forfeit', (x) => this.trace('forfeit', x.payload));
    host.on('refused', (x) => this.trace('refused', x));
    host.on('lobbyClosed', (closed) => {
      this.out.closed = closed;
      this.over(null, host.log);
      this.finish();
    });
  }

  private attachClient(client: ClientMatch): void {
    client.on('joined', (ack) => {
      this.trace('joined', ack);
      this.noteLobby(ack);
    });
    client.on('roster', (ack) => this.noteLobby(ack));
    client.on('refused', (refuse) => {
      this.out.refused = refuse;
      this.finish();
    });
    client.on('ready', (ready) => {
      this.trace('ready', ready);
      this.begin(ready);
    });
    client.on('myTurn', (grant) => this.onMyTurn(grant));
    client.on('ballEnd', (msg) => {
      if (msg.from === this.playerId) this.playing = null;
    });
    client.on('nextGame', () => {
      this.playing = null;
    });
    client.on('pause', (p) => this.out.pauses.push(`${p.reason} ${p.player}`));
    client.on('reject', (reject) => {
      this.trace('reject', reject);
      this.out.rejects.push(reject);
    });
    client.on('dropped', (d) => {
      this.trace('dropped', d);
      this.out.dropped.push(d);
    });
    client.on('desync', (d) => {
      this.trace('desync', d);
      this.out.desyncs.push(d);
    });
    client.on('caughtUp', (x) => {
      this.trace('caughtUp', x);
      this.out.caughtUp.push(x);
    });
    client.on('reconnected', (x) => {
      this.trace('reconnected', x);
      this.out.reconnects.push(`${x.entries}${x.quiet ? ' quiet' : ''}`);
      // Back after a drop: the pause this player's own disconnect caused is this player's to clear (the companion's
      // `resumeAfterMyDrop`); a ball end that was reported into the dead link has gone out again just before this.
      const paused = client.state.paused;
      if (paused?.reason === 'disconnect' && paused.player === this.playerId) client.resume();
    });
    client.on('rejoining', () => {
      this.out.rejoins += 1;
      this.trace('rejoining', null);
    });
    client.on('peerLeft', (x) => this.trace('peerLeft', x));
    client.on('result', (info) => {
      this.trace('result', info.result);
      this.current?.results.push({ result: info.result, logMatches: info.logMatches, signatureValid: info.signatureValid });
    });
    client.on('matchEnded', (end) => {
      this.trace('matchEnded', end);
      this.over(end, client.previousMatch()?.log ?? null);
    });
    client.on('lobbyClosed', (closed) => {
      this.out.closed = closed;
      this.over(null, client.log);
      this.finish();
    });
  }

  private onMyTurn(grant: GrantBody): void {
    const key = `${grant.matchId}:${grant.game ?? 1}:${grant.ballNumber}`;
    if (this.playing === key) return;
    this.playing = key;
    void this.play(grant, key).catch((err: unknown) => {
      this.playing = null;
      this.trace('playError', err);
    });
  }

  private async play(grant: GrantBody, key: string): Promise<void> {
    const { script } = this.opts;
    const curve = script.seriesScores?.[(grant.game ?? 1) - 1] ?? script.scores;
    const target = curve[grant.ballNumber - 1] ?? curve[curve.length - 1] ?? 0;
    const stale = (): boolean => this.finished || this.playing !== key;
    if (this.ballMs > 0) {
      await sleep(this.ballMs / 2);
      if (stale()) return;
      const state = { ballNumber: grant.ballNumber, score: Math.floor(target / 2), ballInPlay: true, tilt: false };
      if (this.host) this.host.localState(state);
      else this.client?.reportState(state);
      await sleep(this.ballMs / 2);
    } else {
      await turn();
    }
    if (stale()) return;
    if (this.host) this.host.localBallEnd(target, 'script');
    else this.client?.reportBallEnd(target, 'script');
  }

  private finish(error: Error | null = null): void {
    if (this.finished) return;
    this.finished = true;
    this.out.error = error;
    this.resolveDone(this.out);
  }

  abort(reason: string): void {
    this.host?.close();
    this.client?.close();
    this.finish(new Error(reason));
  }
}

export interface RunLobbyOptions {
  ballMs?: number;
  clock?: Clock;
  /** Real-time guard for the whole scenario. Default 20 s. */
  timeoutMs?: number;
  disconnectGraceMs?: number;
  reconnect?: { attempts?: number; delayMs?: number; maxMs?: number };
  /**
   * The transport of each player, already connected to the lobby's PC (a star: WebSocket, the relay). Default: one
   * MemoryBus for everyone.
   */
  transportOf?: (player: PlayerId) => Transport;
  /** Step 6: how a member's link is dropped, and allowed back, for a scenario with `drops` (the transports are the caller's). */
  links?: { cut(player: PlayerId): void; mend(player: PlayerId): void };
  /** The players, as soon as they exist (before anyone joins): a test that needs an engine during the run takes it here. */
  onPlayers?: (players: LobbyPlayer[]) => void;
  onEvent?: (player: PlayerId, event: string, payload: unknown) => void;
}

export interface LobbyRun {
  scenario: Scenario;
  bus: MemoryBus | null;
  players: LobbyPlayer[];
  outcomes: Record<PlayerId, LobbyOutcome>;
}

/** Run a lobby scenario to LOBBY_CLOSED and return what every member saw. */
export async function runLobbyScenario(scenario: Scenario, opts: RunLobbyOptions = {}): Promise<LobbyRun> {
  if (!scenario.lobby || !scenario.matches) throw new Error(`${scenario.name} is not a lobby scenario`);
  const matches = scenario.matches;
  const bus = opts.transportOf ? null : new MemoryBus();
  const byId = new Map<PlayerId, LobbyPlayer>();
  /** The members whose link was cut and may not come back yet. */
  const cut = new Set<PlayerId>();
  const mend = (id: PlayerId): void => {
    if (!cut.delete(id)) return;
    opts.links?.mend(id);
  };
  let hostPlayerRef: LobbyPlayer | null = null;
  const players = scenario.players.map((script) => {
    const p = new LobbyPlayer({
      role: script.playerId === scenario.host ? 'host' : 'client',
      transport: opts.transportOf ? opts.transportOf(script.playerId) : (bus as MemoryBus).transport(script.playerId),
      script,
      scenario,
      clock: opts.clock,
      ballMs: opts.ballMs,
      hostId: bus ? scenario.host : undefined,
      disconnectGraceMs: opts.disconnectGraceMs,
      reconnect: opts.reconnect,
      onEvent: opts.onEvent,
      // What the scenario ties to a grant of a match: a join, a drop, a return, the end for everyone.
      onGrant: (match, count) => {
        for (const s of scenario.players) {
          if (s.joinsAt?.match === match && s.joinsAt.afterGrants === count) byId.get(s.playerId)?.join();
          if (s.drops?.match === match && s.drops.afterGrants === count && opts.links) {
            cut.add(s.playerId);
            opts.links.cut(s.playerId);
            if (s.drops.forMs !== undefined) setTimeout(() => mend(s.playerId), s.drops.forMs);
          }
          if (s.drops?.back?.match === match && s.drops.back.afterGrants === count) mend(s.playerId);
        }
        if (matches[match - 1]?.endForEveryone?.afterGrants === count) {
          // After the grant is out (this runs inside its dispatch).
          setImmediate(() => hostPlayerRef?.host?.endMatch('ended for everyone'));
        }
      },
    });
    byId.set(script.playerId, p);
    return p;
  });
  const hostPlayer = byId.get(scenario.host);
  const host = hostPlayer?.host;
  if (!hostPlayer || !host) throw new Error('no lobby PC');
  hostPlayerRef = hostPlayer;
  opts.onPlayers?.(players);
  let failed: Error | null = null;
  let waitingFor = 'the start';
  const until = async (what: string, cond: () => boolean): Promise<void> => {
    waitingFor = what;
    while (!cond()) {
      if (failed) throw failed;
      await sleep(1);
    }
  };

  const drive = async (): Promise<void> => {
    const early = scenario.players.filter((s) => s.playerId !== scenario.host && !s.joinsAt);
    for (const s of early) byId.get(s.playerId)?.join();
    // In, and told so: a member who has not had its HELLO_ACK yet can ask for nothing.
    await until('everyone is in', () => early.every((s) => host.members().some((m) => m.playerId === s.playerId) && byId.get(s.playerId)?.holdsLog === true));
    for (const [i, m] of matches.entries()) {
      for (const [id, stance] of Object.entries(m.stances ?? {})) byId.get(id)?.setStance(stance);
      await until('the choices are said', () => Object.entries(m.stances ?? {}).every(([id, stance]) => host.stanceOf(id) === stance));
      const matchOf = (): LobbyMatchOutcome | undefined => hostPlayer.out.matches[i];
      const ended = (): boolean => matchOf()?.end != null;
      if (m.pick) {
        // Step 10: the table is picked, a match that was left open ends by it, and every PC opens the new table.
        const picked: GameFingerprint = { ...defaultFingerprint, ...m.pick.game };
        byId.get(m.pick.by)?.pick(picked, m.pick.tableObjects ?? null);
        await until('the pick to be the lobby\'s table', () => host.table().game.tableName === picked.tableName && host.table().pickedBy === m.pick?.by);
        await until('the match before to end by the pick', () => host.openMatch() === null);
        for (const p of players) p.openTable(picked);
        await until('everyone has the picked table open', () => host.loading().length === 0 && (hostPlayer.out.lobby?.otherTable ?? []).length === 0);
      }
      if (m.start) {
        // Asked for: the checks, the announced start, the countdown. A match still open is ended by the new one.
        const asker = byId.get(m.start.by);
        const more = { newMatch: host.openMatch() !== null, anyway: m.start.anyway === true };
        asker?.ask(m.start.how, more);
        if (m.alsoStart) {
          // The second ask comes a moment after the first: when the first is announced (a client's has to arrive).
          await until('the first start to be announced', () => host.announcedStart() !== null || matchOf() !== undefined);
          byId.get(m.alsoStart.by)?.ask(m.alsoStart.how, { anyway: m.alsoStart.anyway === true });
        }
        if (m.pickDuringStart) {
          // Step 10: a pick while the start is announced is refused; the start goes on.
          await until('the start to be announced', () => host.announcedStart() !== null || matchOf() !== undefined);
          byId.get(m.pickDuringStart.by)?.pick({ ...defaultFingerprint, ...m.pickDuringStart.game });
        }
        if (m.startWithout) {
          const presser = byId.get(m.startWithout);
          await until('the start to wait', () => host.announcedStart()?.waitsFor != null);
          presser?.ask('button', { now: true });
        }
        await until(`match ${i + 1} to start`, () => matchOf() !== undefined);
      } else if (!host.startMatch(m.players)) {
        throw new Error(`match ${i + 1} did not start: ${host.startMatchBlocker(m.players)}`);
      }
      const games = Math.max(1, m.games ?? 1);
      for (let g = 1; g <= games && !ended(); g++) {
        await until(`the RESULT of game ${g}`, () => (matchOf()?.results.length ?? 0) >= g || ended());
        if (g < games && !ended()) {
          await turn();
          if (m.start) {
            byId.get(m.start.by)?.ask('button');
            await until(`game ${g + 1} of match ${i + 1} to start`, () => host.state.gameNumber === g + 1 || ended());
          } else if (!host.nextGame()) {
            throw new Error(`game ${g + 1} of match ${i + 1} did not start: ${host.nextGameBlocker()}`);
          }
        }
      }
      // Whoever joined during this match, or is due back in it, holds its log before it is closed (a closed match
      // sends none).
      const due = scenario.players.filter((s) => s.joinsAt?.match === i + 1 || (s.drops && (s.drops.back?.match ?? s.drops.match) === i + 1));
      await until('the late and the returning members hold the log', () => due.every((s) => !cut.has(s.playerId) && byId.get(s.playerId)?.holdsLog === true));
      await turn();
      if (!ended() && (i === matches.length - 1 || (m.closes ?? 'end') === 'end')) host.endMatch(`match ${i + 1} is over`);
    }
    await turn();
    host.closeLobby('the scenario is over');
  };

  const timeoutMs = opts.timeoutMs ?? 20_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const snaps = players.map((p) => ({ id: p.playerId, matches: p.out.matches.map((m) => `${m.matchId}:${m.results.length}`), snap: p.snapshot() }));
      failed = new Error(`lobby scenario ${scenario.name} timed out after ${timeoutMs} ms, waiting for ${waitingFor}\n${JSON.stringify(snaps, null, 1).slice(0, 4000)}`);
      for (const p of players) p.abort('lobby scenario timeout');
      reject(failed);
    }, timeoutMs);
  });
  try {
    const all = (async (): Promise<LobbyOutcome[]> => {
      await drive();
      return Promise.all(players.map((p) => p.done));
    })();
    const list = await Promise.race([all, guard]);
    const outcomes: Record<PlayerId, LobbyOutcome> = {};
    for (const o of list) outcomes[o.playerId] = o;
    return { scenario, bus, players, outcomes };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What a member's own log of a match is when the match ended while its PC was away: a part of it, by a MATCH_END it made up. */
const ENDED_AWAY = 'the match ended while this PC was away';

/**
 * Step 6: what must hold after any lobby scenario, as a list of what does not (empty: all of it holds). Every match
 * the lobby's PC arbitrated has an id of its own and a log that is one hash chain from its own entry 0, with grants
 * from 1 and nobody in it but its players and the lobby's PC; every RESULT names a head of that log and is signed
 * by the lobby's PC and by players only; every member who was in the lobby for a match holds the same log and the
 * same RESULTs (a member who was away when it ended holds a part of it, and is not held to that); nobody was
 * refused, lost a frame, saw a desync, or missed LOBBY_CLOSED. `rejects`: the members whose REJECTs the scenario
 * expects (anyone else's is a problem).
 */
export function lobbyProblems(run: LobbyRun, allow: { rejects?: readonly PlayerId[] } = {}): string[] {
  const { scenario, outcomes } = run;
  const out: string[] = [];
  const host = outcomes[scenario.host];
  if (!host) return ['no outcome of the lobby PC'];
  const say = (ok: boolean, what: string): void => {
    if (!ok) out.push(what);
  };
  say(host.matches.length === scenario.matches?.length, `the lobby PC saw ${host.matches.length} matches, the scenario has ${scenario.matches?.length}`);
  for (const o of Object.values(outcomes)) {
    say(o.error === null, `${o.playerId}: ${o.error?.message}`);
    say(o.refused === null, `${o.playerId} was refused: ${o.refused?.code}`);
    say(o.closed !== null, `${o.playerId} was not told the lobby closed`);
    say(o.desyncs.length === 0, `${o.playerId} saw a desync: ${o.desyncs.map((d) => d.context).join(', ')}`);
    say(o.dropped.length === 0, `${o.playerId} dropped frames: ${o.dropped.map((d) => `${d.type}:${d.reason}`).join(', ')}`);
    if (!allow.rejects?.includes(o.playerId)) say(o.rejects.length === 0, `${o.playerId} was sent REJECT: ${o.rejects.map((r) => r.message).join(' | ')}`);
    say(o.hostSeqs.every((s, i) => i === 0 || s > (o.hostSeqs[i - 1] as number)), `${o.playerId}: the lobby PC's seq went down`);
  }
  for (const [i, m] of host.matches.entries()) {
    const id = `${scenario.matchId}-${i + 1}`;
    say(m.matchId === id, `match ${i + 1} is ${m.matchId}, not ${id}`);
    say(m.ready.hostPlayerId === scenario.host, `${id}: the host is ${m.ready.hostPlayerId}`);
    const log = m.log;
    if (!log || !m.head || !m.end) {
      out.push(`${id}: the lobby PC has no log, or the match was never ended`);
      continue;
    }
    say(log.verifyChain().ok, `${id}: the chain is broken`);
    say(log.at(0)?.prevHash === GENESIS_HASH && log.at(0)?.message?.type === 'MATCH_READY', `${id}: entry 0 is not a MATCH_READY on 64 zeros`);
    say(log.entries().every((e) => e.message?.matchId === id), `${id}: an entry of another match`);
    const grants = log.entries().flatMap((e) => (e.message?.type === 'TURN_GRANT' ? [e.message.payload.grant] : []));
    say(grants.every((g, k) => g.grantSeq === k + 1 && g.matchId === id), `${id}: the grants do not count from 1`);
    const players = new Set(m.ready.playerOrder);
    say(m.ready.participants.map((p) => p.playerId).join() === m.ready.playerOrder.join(), `${id}: the roster is not the players`);
    say(log.entries().every((e) => players.has(e.from) || e.from === scenario.host), `${id}: an entry from somebody who is not a player`);
    say(m.end.games === m.results.length, `${id}: MATCH_END says ${m.end.games} games, ${m.results.length} RESULTs went out`);
    for (const r of m.results) {
      const res = r.result;
      say(res.matchId === id && log.at(res.logLength - 1)?.hash === res.logHash, `${id} game ${res.game}: the RESULT names no head of this log`);
      say(verifyCanonical(logSignBody(id, res.logHash, res.logLength), res.hostSignature, host.publicKey), `${id} game ${res.game}: the lobby PC's signature`);
      say(res.entries.every((e) => players.has(e.playerId)), `${id} game ${res.game}: an entry for somebody who is not a player`);
      for (const s of res.signatures) {
        say(players.has(s.playerId) && s.logHash === res.logHash && verifyCanonical(logSignBody(id, s.logHash, s.logLength), s.signature, outcomes[s.playerId]?.publicKey ?? ''), `${id} game ${res.game}: the signature of ${s.playerId}`);
      }
    }
    for (const o of Object.values(outcomes)) {
      const mine = o.matches.find((x) => x.matchId === id);
      if (!mine || o === host) continue;
      say(mine.log?.verifyChain().ok === true, `${o.playerId}: the chain of ${id} is broken`);
      say(mine.results.every((r) => r.logMatches && r.signatureValid), `${o.playerId}: a RESULT of ${id} did not check`);
      if (mine.end?.reason === ENDED_AWAY) continue;
      say(mine.head?.hash === m.head.hash && mine.head.length === m.head.length, `${o.playerId}: another head of ${id}`);
      say(JSON.stringify(mine.end) === JSON.stringify(m.end), `${o.playerId}: another MATCH_END of ${id}`);
      say(JSON.stringify(mine.results.map((r) => r.result)) === JSON.stringify(m.results.map((r) => r.result)), `${o.playerId}: other RESULTs of ${id}`);
    }
  }
  return out;
}
