/**
 * The scripted participant. `FakePlayer` drives a ClientMatch (or a HostMatch plus its own local
 * play) from a PlayerScript: on its turn it waits `ballMs`, emits a few STATE updates along the
 * score curve, answers with BALL_END (shootAgain on cue), sends GAME_OVER when scripted, and
 * signs the log automatically through the engine. It follows the engine across host transfers
 * in both directions. `runLocalScenario` wires N fake players over a MemoryBus and returns every
 * participant's outcome (RESULT, log head, grants issued/seen, rejects received).
 */
import type { GameFingerprint, GrantBody, ParticipantInfo, PayloadOf, PlayerId } from '@castcade/protocol';
import {
  ClientMatch,
  HostMatch,
  MemoryBus,
  generateKeys,
  realClock,
  type ClientEvents,
  type Clock,
  type HostEvents,
  type KeyPair,
  type LogHead,
  type MatchLog,
  type Transport,
  type WsPeerTransport,
} from '@castcade/companion';
import { defaultFingerprint, type PlayerScript, type Scenario } from './scenario.js';

export interface FakeHooks {
  /** A scripted player just ignored a grant (so a test can advance a manual clock). */
  onSilent?(player: PlayerId, ball: number): void;
  /** A host-role player issued a grant. */
  onGrant?(grant: GrantBody, issuer: PlayerId): void;
  /** Any engine event, for debugging. */
  onEvent?(player: PlayerId, event: string, payload: unknown): void;
}

export interface FakePlayerOptions {
  role: 'host' | 'client';
  transport: Transport;
  script: PlayerScript;
  scenario: Scenario;
  keys?: KeyPair;
  clock?: Clock;
  /** How long a ball "takes". Default 5 ms. */
  ballMs?: number;
  /** STATE updates per ball. Default 3. */
  stateUpdates?: number;
  /** Where HELLO goes on a mesh transport; omit over WebSocket. */
  hostId?: PlayerId;
  /** Host role: start once this many clients joined (refusals count towards the lobby being complete). */
  expectedJoins?: number;
  /** Host role, `host_left` transfer: called after the host has closed its engine, to drop its link. */
  onHostLeft?: () => void;
  /** Host role, over WebSocket: the new host's listener for HOST_TRANSFER.newHostEndpoint (A2). */
  endpointOf?: (player: PlayerId) => string | null;
  /** Client role: reconnect budget after a dropped host link (A3). */
  reconnect?: { attempts?: number; delayMs?: number };
  hooks?: FakeHooks;
  companionVersion?: string;
}

export interface FakePlayerOutcome {
  playerId: PlayerId;
  publicKey: string;
  result: PayloadOf<'RESULT'> | null;
  resultInfo: { logMatches: boolean; signatureValid: boolean } | null;
  logHead: LogHead;
  log: MatchLog;
  /** Grants this participant issued while it was host, in order. */
  issuedGrants: GrantBody[];
  /** Grants this participant saw as a client, in order. */
  grantsSeen: GrantBody[];
  rejects: PayloadOf<'REJECT'>[];
  pauses: PayloadOf<'PAUSE'>[];
  refused: PayloadOf<'REFUSE'> | null;
  /** True when this player left the match on purpose (host_left scenario). */
  left: boolean;
  signed: boolean;
  hostTransfers: number;
  rolesHeld: ('host' | 'client')[];
  /** Accepted RECONNECTs (after a host transfer or a drop), with how many log entries each brought. */
  reconnects: number[];
  /** Why the host rejected this player's RECONNECT, when it did (A3). */
  reconnectRejected: string | null;
  error: Error | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class FakePlayer {
  readonly playerId: PlayerId;
  readonly keys: KeyPair;
  readonly done: Promise<FakePlayerOutcome>;
  private host: HostMatch | null = null;
  private client: ClientMatch | null = null;
  private offs: (() => void)[] = [];
  private readonly participant: ParticipantInfo;
  private readonly game: GameFingerprint;
  private readonly ballMs: number;
  private readonly stateUpdates: number;
  private readonly expectedJoins: number;
  private lobbyCount = 0;
  private playing: number | null = null;
  private silenced = false;
  private staleDone = false;
  private rogueDone = false;
  private transferred = false;
  private lastAnsweredGrantSeq = 0;
  private readonly shotAgain = new Set<number>();
  private finished = false;
  private resolveDone!: (o: FakePlayerOutcome) => void;
  private readonly out: FakePlayerOutcome;

  constructor(private readonly opts: FakePlayerOptions) {
    const { script, scenario } = opts;
    this.playerId = script.playerId;
    this.keys = opts.keys ?? generateKeys();
    this.participant = {
      playerId: script.playerId,
      displayName: script.displayName ?? script.playerId,
      publicKey: this.keys.publicKeyB64,
      rig: script.rig ?? 'pc',
    };
    this.game = { ...defaultFingerprint, ...(script.game ?? {}) };
    this.ballMs = opts.ballMs ?? 5;
    this.stateUpdates = Math.max(1, opts.stateUpdates ?? 3);
    this.expectedJoins = opts.expectedJoins ?? scenario.players.length - 1;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    const clock = opts.clock ?? realClock;
    let engine: HostMatch | ClientMatch;
    if (opts.role === 'host') {
      engine = new HostMatch({
        transport: opts.transport,
        keys: this.keys,
        matchId: scenario.matchId,
        ballsPerGame: scenario.ballsPerGame,
        hostParticipant: this.participant,
        hostGame: this.game,
        clock,
        ballEndTimeoutMs: scenario.ballEndTimeoutMs,
        logSignTimeoutMs: scenario.logSignTimeoutMs,
        companionVersion: opts.companionVersion,
      });
    } else {
      engine = new ClientMatch({
        transport: opts.transport,
        keys: this.keys,
        participant: this.participant,
        game: this.game,
        throwdownCode: scenario.matchId,
        hostId: opts.hostId,
        clock,
        companionVersion: opts.companionVersion,
        hostTimeouts: { ballEndTimeoutMs: scenario.ballEndTimeoutMs, logSignTimeoutMs: scenario.logSignTimeoutMs },
        reconnect: opts.reconnect,
      });
    }
    this.out = {
      playerId: this.playerId,
      publicKey: this.keys.publicKeyB64,
      result: null,
      resultInfo: null,
      logHead: { hash: '', length: 0 },
      log: engine.log,
      issuedGrants: [],
      grantsSeen: [],
      rejects: [],
      pauses: [],
      refused: null,
      left: false,
      signed: false,
      hostTransfers: 0,
      rolesHeld: [opts.role],
      reconnects: [],
      reconnectRejected: null,
      error: null,
    };
    if (engine instanceof HostMatch) this.attachHost(engine);
    else this.attachClient(engine);
  }

  /** Clients send HELLO; the host waits for joins. */
  start(): void {
    this.client?.join();
  }

  get role(): 'host' | 'client' {
    return this.host ? 'host' : 'client';
  }

  get engine(): HostMatch | ClientMatch | null {
    return this.host ?? this.client;
  }

  snapshot(): unknown {
    return this.engine?.snapshot() ?? null;
  }

  private trace(event: string, payload: unknown): void {
    this.opts.hooks?.onEvent?.(this.playerId, event, payload);
  }

  private detachAll(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ------------------------------------------------------------------------------------------
  // Host role
  // ------------------------------------------------------------------------------------------

  private attachHost(host: HostMatch): void {
    this.detachAll();
    this.host = host;
    this.client = null;
    const on = <K extends keyof HostEvents>(name: K, cb: (p: HostEvents[K]) => void): void => {
      this.offs.push(
        host.on(name, (p) => {
          this.trace(String(name), p);
          cb(p);
        }),
      );
    };
    on('joined', () => {
      this.lobbyCount += 1;
      if (this.lobbyCount === this.expectedJoins && host.state.phase === 'lobby') host.start();
    });
    on('refused', () => {
      this.lobbyCount += 1;
      if (this.lobbyCount === this.expectedJoins && host.state.phase === 'lobby' && host.roster().length >= 2) host.start();
    });
    on('grant', (grant) => {
      this.out.issuedGrants.push(grant);
      this.opts.hooks?.onGrant?.(grant, this.playerId);
      if (grant.player === this.playerId) this.onMyTurn(grant);
      else this.maybeTransfer(grant);
    });
    on('ballEnd', (msg) => {
      if (msg.from === this.playerId) {
        this.lastAnsweredGrantSeq = msg.payload.grantSeq;
        this.playing = null;
      }
    });
    on('reject', (info) => {
      if (info.to === this.playerId) this.out.rejects.push({ refSeq: info.refSeq, refType: info.refType, code: info.code, message: info.message });
    });
    on('pause', (pause) => {
      this.out.pauses.push(pause);
      this.applyHostPolicy(host, pause);
    });
    // Traced only, so hooks and tests see them (A2).
    on('peerLeft', () => undefined);
    on('reconnected', () => undefined);
    on('reconnectRejected', () => undefined);
    on('hostTransfer', ({ client }) => {
      this.out.hostTransfers += 1;
      this.out.rolesHeld.push('client');
      this.attachClient(client);
    });
    on('result', ({ result }) => {
      this.out.result = result;
      this.out.resultInfo = { logMatches: true, signatureValid: true };
      this.finish();
    });
  }

  private applyHostPolicy(host: HostMatch, pause: PayloadOf<'PAUSE'>): void {
    const policy = this.opts.scenario.hostPolicy?.onDisconnect ?? 'forfeit';
    if (policy !== 'forfeit' || !pause.player) return;
    const p = host.state.players[pause.player];
    const gone = host.snapshot().gone.includes(pause.player);
    if ((pause.reason === 'disconnect' || pause.reason === 'ball_end_timeout') && p && p.status === 'playing' && (!p.connected || gone)) {
      // Decide after the current dispatch so the PAUSE broadcast is already on the wire.
      queueMicrotask(() => {
        if (this.host !== host || host.state.players[pause.player ?? '']?.status !== 'playing') return;
        host.forfeit(pause.player as PlayerId, `${pause.reason}: did not return`);
        if (host.state.paused) host.resume();
      });
    }
  }

  private maybeTransfer(grant: GrantBody): void {
    const tr = this.opts.scenario.transfer;
    const host = this.host;
    // Only the scenario's original host hands over; a player that became host plays on.
    if (!tr || this.transferred || !host || this.playerId !== this.opts.scenario.host) return;
    const mine = host.state.players[this.playerId];
    if (!mine || mine.ballsPlayed !== tr.afterHostBall || grant.player === this.playerId) return;
    this.transferred = true;
    if (tr.reason === 'host_requested') {
      host.transferHost(tr.to, { endpoint: this.opts.endpointOf?.(tr.to) ?? undefined });
    } else {
      host.close();
      this.detachAll();
      this.out.left = true;
      this.opts.onHostLeft?.();
      this.finish();
    }
  }

  // ------------------------------------------------------------------------------------------
  // Client role
  // ------------------------------------------------------------------------------------------

  private attachClient(client: ClientMatch): void {
    this.detachAll();
    this.client = client;
    this.host = null;
    const on = <K extends keyof ClientEvents>(name: K, cb: (p: ClientEvents[K]) => void): void => {
      this.offs.push(
        client.on(name, (p) => {
          this.trace(String(name), p);
          cb(p);
        }),
      );
    };
    on('refused', (refuse) => {
      this.out.refused = refuse;
      this.finish();
    });
    on('grant', (grant) => {
      this.out.grantsSeen.push(grant);
      if (grant.player !== this.playerId && this.opts.script.rogueBallEnd && !this.rogueDone && this.lastAnsweredGrantSeq > 0) {
        this.rogueDone = true;
        client.reportBallEnd(1, 'manual', false, { grantSeq: grant.grantSeq, ballNumber: grant.ballNumber });
      }
    });
    on('myTurn', (grant) => this.onMyTurn(grant));
    on('ballEnd', (msg) => {
      if (msg.from === this.playerId) {
        this.lastAnsweredGrantSeq = msg.payload.grantSeq;
        this.playing = null;
      }
    });
    on('reject', (reject) => this.out.rejects.push(reject));
    on('pause', (pause) => {
      this.out.pauses.push(pause);
      // The silent player "comes back": any participant may RESUME.
      if (pause.player === this.playerId && pause.reason === 'ball_end_timeout' && this.silenced) client.resume();
    });
    on('logSigned', () => {
      this.out.signed = true;
    });
    on('hostChanged', () => {
      this.out.hostTransfers += 1;
    });
    on('reconnected', ({ entries }) => {
      this.out.reconnects.push(entries);
      // A ball in flight when the link dropped was lost with it; play the re-issued grant afresh.
      if (!client.myGrant) this.playing = null;
      // Back after a drop: any participant may RESUME the pause our disconnect caused (A3).
      const paused = client.state.paused;
      if (paused?.reason === 'disconnect' && paused.player === this.playerId) client.resume();
    });
    on('reconnectRejected', ({ code }) => {
      // Re-joining takes a fresh HELLO, which a started match refuses; this player is out.
      this.out.reconnectRejected = code ?? 'rejected';
      this.finish();
    });
    on('reconnectFailed', () => undefined);
    on('desync', () => undefined);
    on('peerLeft', () => undefined);
    on('becameHost', (host) => {
      this.out.rolesHeld.push('host');
      this.attachHost(host);
    });
    on('result', (info) => {
      this.out.result = info.result;
      this.out.resultInfo = { logMatches: info.logMatches, signatureValid: info.signatureValid };
      this.finish();
    });
  }

  // ------------------------------------------------------------------------------------------
  // Playing a ball (either role)
  // ------------------------------------------------------------------------------------------

  private onMyTurn(grant: GrantBody): void {
    // A re-grant for the ball already in flight (after RESUME or a host transfer): the in-flight
    // play answers whichever grant is current when it reports, so do not start a second one.
    if (this.playing === grant.ballNumber) return;
    this.playing = grant.ballNumber;
    void this.play(grant).catch((err: unknown) => {
      // Typically "no grant held": the grant moved on while we were playing; wait for the next one.
      this.playing = null;
      this.trace('playError', err);
    });
  }

  private reportState(state: Omit<PayloadOf<'STATE'>, 'extraBalls'>): void {
    if (this.host) this.host.localState(state);
    else this.client?.reportState(state);
  }

  private reportBallEnd(finalScore: number, shootAgain: boolean, override?: { grantSeq: number; ballNumber: number }): void {
    if (this.host) this.host.localBallEnd(finalScore, 'script', shootAgain, override);
    else if (this.client) this.client.reportBallEnd(finalScore, 'script', shootAgain, override);
    else throw new Error('no engine');
  }

  private reportGameOver(finalScore: number, ballsPlayed: number): void {
    if (this.host) this.host.localGameOver(finalScore, ballsPlayed);
    else this.client?.reportGameOver(finalScore, ballsPlayed);
  }

  private async play(grant: GrantBody): Promise<void> {
    const { script, scenario } = this.opts;
    const ball = grant.ballNumber;
    const idx = ball - 1;
    if (script.silentOnBall === ball && !this.silenced) {
      this.silenced = true;
      this.playing = null;
      this.opts.hooks?.onSilent?.(this.playerId, ball);
      return;
    }
    if (script.staleBallEndOnBall === ball && !this.staleDone && this.lastAnsweredGrantSeq > 0) {
      this.staleDone = true;
      this.reportBallEnd(0, false, { grantSeq: this.lastAnsweredGrantSeq, ballNumber: ball });
    }
    const last = script.scores[script.scores.length - 1] ?? 0;
    const target = script.scores[idx] ?? last;
    const prev = idx > 0 ? (script.scores[idx - 1] ?? 0) : 0;
    const slice = this.ballMs / this.stateUpdates;
    for (let k = 1; k <= this.stateUpdates; k++) {
      await sleep(slice);
      if (this.finished || this.playing !== ball) return;
      const score = prev + Math.floor(((target - prev) * k) / (this.stateUpdates + 1));
      this.reportState({ ballNumber: ball, score, ballInPlay: true, tilt: false });
    }
    if (this.finished || this.playing !== ball) return;
    if (script.shootAgainOn?.includes(ball) && !this.shotAgain.has(ball)) {
      this.shotAgain.add(ball);
      this.reportBallEnd(prev + Math.floor((target - prev) / 2), true);
      return;
    }
    this.reportBallEnd(target, false);
    if (script.gameOverAfterBall === ball && ball < scenario.ballsPerGame) this.reportGameOver(target, ball);
  }

  private finish(error: Error | null = null): void {
    if (this.finished) return;
    this.finished = true;
    this.out.error = error;
    const engine = this.engine;
    this.out.logHead = engine ? engine.log.head() : this.out.log.head();
    this.detachAll();
    this.resolveDone(this.out);
  }

  /** Abort (timeout from the runner). */
  abort(reason: string): void {
    this.host?.close();
    this.client?.close();
    this.finish(new Error(reason));
  }
}

export interface RunLocalOptions {
  ballMs?: number;
  clock?: Clock;
  latencyMs?: number;
  hooks?: FakeHooks;
  /** Real-time guard for the whole scenario. Default 15 s. */
  timeoutMs?: number;
}

export interface LocalRun {
  scenario: Scenario;
  bus: MemoryBus;
  players: FakePlayer[];
  outcomes: Record<PlayerId, FakePlayerOutcome>;
}

/** Wire every scripted player of a scenario over one MemoryBus and run the match to its RESULT. */
export async function runLocalScenario(scenario: Scenario, opts: RunLocalOptions = {}): Promise<LocalRun> {
  const bus = new MemoryBus({ latencyMs: opts.latencyMs });
  const players = scenario.players.map(
    (script) =>
      new FakePlayer({
        role: script.playerId === scenario.host ? 'host' : 'client',
        transport: bus.transport(script.playerId),
        script,
        scenario,
        clock: opts.clock,
        ballMs: opts.ballMs,
        hostId: scenario.host,
        expectedJoins: scenario.players.length - 1,
        hooks: opts.hooks,
        onHostLeft: () => bus.disconnect(script.playerId),
      }),
  );
  for (const p of players) p.start();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const snaps = players.map((p) => ({ id: p.playerId, role: p.role, snap: p.snapshot() }));
      for (const p of players) p.abort('scenario timeout');
      reject(new Error(`scenario ${scenario.name} timed out after ${timeoutMs} ms\n${JSON.stringify(snaps, null, 1).slice(0, 4000)}`));
    }, timeoutMs);
  });
  try {
    const list = await Promise.race([Promise.all(players.map((p) => p.done)), guard]);
    const outcomes: Record<PlayerId, FakePlayerOutcome> = {};
    for (const o of list) outcomes[o.playerId] = o;
    return { scenario, bus, players, outcomes };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface WsRun {
  scenario: Scenario;
  transports: Map<PlayerId, WsPeerTransport>;
  endpoints: Map<PlayerId, string>;
  outcomes: Record<PlayerId, FakePlayerOutcome>;
}

/**
 * Run a scenario over real WebSockets on localhost (A2, 2026-10-30): every participant gets the
 * given WsPeerTransport and an ephemeral listener (any of them may become host), the clients
 * connect to the host's, and the run resolves with every participant's outcome. The caller owns
 * the transports and closes them.
 */
export async function runWsScenario(
  scenario: Scenario,
  transports: Map<PlayerId, WsPeerTransport>,
  opts: { timeoutMs?: number; hooks?: FakeHooks; reconnect?: { attempts?: number; delayMs?: number }; players?: (players: FakePlayer[]) => void } = {},
): Promise<WsRun> {
  const endpoints = new Map<PlayerId, string>();
  // Every participant listens, so any of them can become host.
  for (const [id, t] of transports) endpoints.set(id, await t.listen());
  const hostEndpoint = endpoints.get(scenario.host);
  if (!hostEndpoint) throw new Error('no host endpoint');
  const fakes = scenario.players.map((script) => {
    const transport = transports.get(script.playerId);
    if (!transport) throw new Error(`no transport for ${script.playerId}`);
    return new FakePlayer({
      role: script.playerId === scenario.host ? 'host' : 'client',
      transport,
      script,
      scenario,
      expectedJoins: scenario.players.length - 1,
      endpointOf: (id) => endpoints.get(id) ?? null,
      hooks: opts.hooks,
      reconnect: opts.reconnect,
    });
  });
  opts.players?.(fakes);
  for (const [id, t] of transports) if (id !== scenario.host) await t.connect(hostEndpoint);
  for (const f of fakes) f.start();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const snaps = fakes.map((f) => ({ id: f.playerId, role: f.role, snap: f.snapshot() }));
      for (const f of fakes) f.abort('ws scenario timeout');
      reject(new Error(`${scenario.name} timed out\n${JSON.stringify(snaps, null, 1).slice(0, 4000)}`));
    }, opts.timeoutMs ?? 10_000);
  });
  try {
    const list = await Promise.race([Promise.all(fakes.map((f) => f.done)), guard]);
    return { scenario, transports, endpoints, outcomes: Object.fromEntries(list.map((o) => [o.playerId, o])) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Grants in rotation order with consecutive re-issues of the same (player, ball) collapsed. */
export function collapseReissues(grants: readonly GrantBody[]): { player: PlayerId; ballNumber: number }[] {
  const out: { player: PlayerId; ballNumber: number }[] = [];
  for (const g of grants) {
    const prev = out[out.length - 1];
    if (prev && prev.player === g.player && prev.ballNumber === g.ballNumber) continue;
    out.push({ player: g.player, ballNumber: g.ballNumber });
  }
  return out;
}

/** The expected rotation for a plain match: ball 1 for each player in order, then ball 2, ... */
export function expectedRotation(playerOrder: readonly PlayerId[], ballsPerGame: number): { player: PlayerId; ballNumber: number }[] {
  const out: { player: PlayerId; ballNumber: number }[] = [];
  for (let b = 1; b <= ballsPerGame; b++) for (const p of playerOrder) out.push({ player: p, ballNumber: b });
  return out;
}
