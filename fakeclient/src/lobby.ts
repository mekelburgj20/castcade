/**
 * A17 step 5 (2026-11-25): the scripted member of a LOBBY, and the runner of a lobby scenario. The engines run with
 * `HostOptions.lobby` / `ClientOptions.lobby` on: one lobby, several matches in it one after the other, players by
 * choice (Play or Watch), people who join while a match is played. `runLobbyScenario` wires the scenario's players
 * over a MemoryBus (or over the transports it is given: the relay double, for one test) and returns what each of
 * them saw: every match with its own log, its RESULTs and its MATCH_END, what was refused, rejected or dropped, and
 * how many frames of each type each member's engine sent (a watcher sends none of a player's).
 *
 * The lobby's PC drives the evening, because in this step only it can (a member's START_REQUEST is the next step):
 * it starts each match with the players the scenario names, or with everyone set to Play; it starts the next game at
 * each RESULT; it ends a match or lets the next one's start end it; it closes the lobby at the end, which is when
 * every player is done. Nothing here is the plain match's scripted player (`lib.ts`), which stays as it was.
 */
import type { GameFingerprint, GrantBody, ParticipantInfo, PayloadOf, PlayerId } from '@castcade/protocol';
import {
  ClientMatch,
  HostMatch,
  MemoryBus,
  generateKeys,
  realClock,
  type Clock,
  type DesyncInfo,
  type DroppedInfo,
  type KeyPair,
  type LogHead,
  type MatchLog,
  type Transport,
} from '@castcade/companion';
import { defaultFingerprint, type PlayerScript, type Scenario } from './scenario.js';

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
  /** The logs this member was sent in MATCH_LOG pages (a join while a match was open). */
  caughtUp: { match: string; entries: number }[];
  /** The lobby's PC only: the members it sent a log to, with the pages and what was committed meanwhile. */
  sentLogs: { playerId: PlayerId; entries: number; pages: number; during: number }[];
  /** The frames this member's engine handed to its transport, by type. */
  sent: Record<string, number>;
  /** The lobby as last said (HELLO_ACK). */
  lobby: PayloadOf<'HELLO_ACK'> | null;
  /** The `seq` of every frame the lobby's PC sent that this member was handed, in order (it never starts over). */
  hostSeqs: number[];
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

  /** In the lobby and holding the open match's log (or none is open). */
  get holdsLog(): boolean {
    if (this.host) return true;
    return this.client !== null && this.client.isJoined && this.client.holdsOpenLog;
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

  private attachHost(host: HostMatch): void {
    host.on('lobby', (ack) => {
      this.out.lobby = ack;
    });
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
      this.out.lobby = ack;
    });
    client.on('roster', (ack) => {
      this.out.lobby = ack;
    });
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
  /**
   * The transport of each player, already connected to the lobby's PC (a star: WebSocket, the relay). Default: one
   * MemoryBus for everyone.
   */
  transportOf?: (player: PlayerId) => Transport;
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
      onEvent: opts.onEvent,
      // A member who joins while a match is played does so at a grant the scenario names.
      onGrant: (match, count) => {
        for (const s of scenario.players) if (s.joinsAt?.match === match && s.joinsAt.afterGrants === count) byId.get(s.playerId)?.join();
      },
    });
    byId.set(script.playerId, p);
    return p;
  });
  const hostPlayer = byId.get(scenario.host);
  const host = hostPlayer?.host;
  if (!hostPlayer || !host) throw new Error('no lobby PC');
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
    await until('everyone is in', () => early.every((s) => host.members().some((m) => m.playerId === s.playerId)));
    for (const [i, m] of matches.entries()) {
      for (const [id, stance] of Object.entries(m.stances ?? {})) byId.get(id)?.setStance(stance);
      await until('the choices are said', () => Object.entries(m.stances ?? {}).every(([id, stance]) => host.stanceOf(id) === stance));
      if (!host.startMatch(m.players)) throw new Error(`match ${i + 1} did not start: ${host.startMatchBlocker(m.players)}`);
      const games = Math.max(1, m.games ?? 1);
      for (let g = 1; g <= games; g++) {
        await until(`the RESULT of game ${g}`, () => (hostPlayer.out.matches[i]?.results.length ?? 0) >= g);
        if (g < games) {
          await turn();
          if (!host.nextGame()) throw new Error(`game ${g + 1} of match ${i + 1} did not start: ${host.nextGameBlocker()}`);
        }
      }
      // Whoever joined during this match has its log before the match is closed (a closed match sends none).
      const late = scenario.players.filter((s) => s.joinsAt?.match === i + 1);
      await until('the late members hold the log', () => late.every((s) => byId.get(s.playerId)?.holdsLog === true));
      await turn();
      if (i === matches.length - 1 || (m.closes ?? 'end') === 'end') host.endMatch(`match ${i + 1} is over`);
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
