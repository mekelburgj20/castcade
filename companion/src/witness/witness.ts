/**
 * The witness orchestrator (basic mode): process watch → nvram baseline while VPX is open → when a
 * `.nv` changes and settles (the in-process player closed), or when VPX exits with a changed `.nv`,
 * decode it with the maps corpus, decide, post through the offline queue. Heartbeats keep the
 * device "online" in ArcAid's event lobby (stale after 300 s server-side, so one every 120 s).
 * Everything Windows-specific or networked arrives through `WitnessDeps`, with production
 * defaults, so the whole thing runs under vitest on Linux with fakes.
 *
 * ## One capture per player session
 *
 * VPX is a long-lived process on the desktop: a table opened from the editor, a recent-files entry
 * or a file association keeps the process alive between games, so "capture at process exit" would
 * miss every game but the last. The unit of capture is therefore the PLAYER SESSION: VPinMAME
 * rewrites the ROM's `.nv` when the in-process player closes, and that write (once it has been
 * stable for the settle window) triggers decode → decide → post, after which the nvram baseline is
 * refreshed so the next player session is compared against the state this one left behind.
 * Process exit is the final chance for a `.nv` that changed without a capture yet; a `.nv` that is
 * unchanged since the last capture produces nothing (no duplicate), and `sameGame` guards the rest.
 *
 * ## Table identity
 *
 * `-Play <path>.vpx` → a positional `<path>.vpx` (file association) → the editor's window title
 * `Visual Pinball - [<table>]` → the ROM's name from `romnames.json` → the ROM id. A capture is
 * never refused for want of a name; how the name was derived rides in `LastCapture.detail`.
 */
import { realClock, type Clock, type TimerHandle } from '../match/clock.js';
import { Emitter } from '../match/events.js';
import { ArcaidClient, ArcaidError, type FetchLike } from './arcaid-client.js';
import { decideCapture } from './capture.js';
import { nodeFs, type WitnessFs } from './fs.js';
import { createMapCorpus, decodeGameState, romFromNvName, type CompiledMap, type GameState, type MapCorpus } from './maps.js';
import { createRegQueryReader, resolveNvramDir, type RegistryReader } from './nvram-dir.js';
import { changedNvFiles, snapshotNvFiles, waitForNvChange, DEFAULT_NV_POLL_MS, DEFAULT_NV_SETTLE_MS, type NvSnapshot } from './nvram-snapshot.js';
import {
  createPowershellLister,
  ProcessWatch,
  DEFAULT_POLL_INTERVAL_MS,
  type ProcessLister,
  type TableSource,
  type VpxExit,
  type VpxLaunch,
  type VpxTitle,
} from './process-watch.js';
import { PostQueue, type PostResult, type QueuedPost } from './queue.js';
import type { CaptureOutcome, LastCapture, Witness, WitnessEvents, WitnessSettingsStore, WitnessStatus } from './types.js';

export interface WitnessDeps {
  clock?: Clock;
  lister?: ProcessLister;
  registry?: RegistryReader;
  fs?: WitnessFs;
  fetch?: FetchLike;
  /** Overrides `settings.mapsDir`. */
  corpus?: MapCorpus;
  pollIntervalMs?: number;
  /** How long a changed `.nv` must stay unchanged before it is read (VPinMAME's write is done). */
  nvSettleMs?: number;
  /** Poll step while waiting for the rewrite after a process exit. */
  nvPollMs?: number;
  /** Poll step of the nvram directory while a VPX process is open. */
  nvAlivePollMs?: number;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  queueBaseDelayMs?: number;
  /** Diagnostic log line sink (default: none). */
  log?: (line: string) => void;
}

/** ArcAid's `HEARTBEAT_STALE_SEC` is 300; two beats per window keeps a desktop "online" through one miss. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 120_000;
export const DEFAULT_NV_ALIVE_POLL_MS = 3_000;
export const UNKNOWN_TABLE = '(unknown table)';

type EventPayloads = {
  [K in keyof WitnessEvents]: Parameters<WitnessEvents[K]>[0];
};

interface OpenSession {
  launch: VpxLaunch;
  /** Process creation time when the lister knew it, else when the watch first saw the pid. */
  startedAt: number;
  lastCaptureAt: number | null;
  captures: number;
  playerUp: boolean;
  lastActivityAt: number;
}

type CaptureTrigger = 'player' | 'exit';

const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);

function joinPath(dir: string, name: string): string {
  const sepChar = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sepChar + name;
}

/** Map ArcAid's wire `status` for a score to the module's outcome vocabulary. */
export function outcomeForWire(status: string | null): { outcome: CaptureOutcome; detail?: string } {
  switch (status) {
    case null:
    case 'ingested':
    case 'global':
      return { outcome: 'ingested', ...(status === 'global' ? { detail: 'recorded on the Global Scoreboard' } : {}) };
    case 'duplicate':
    case 'global_duplicate':
      return { outcome: 'duplicate' };
    case 'no_match':
      return { outcome: 'skipped', detail: 'ArcAid: no open game or catalogue entry matched this table' };
    case 'invalid':
      return { outcome: 'rejected', detail: 'ArcAid: invalid score' };
    default:
      return { outcome: 'rejected', detail: `ArcAid: ${status}` };
  }
}

export function outcomeForPost(result: PostResult): { outcome: CaptureOutcome; detail?: string } {
  if (result.state === 'done') return outcomeForWire(result.wire?.status ?? null);
  if (result.state === 'queued') return { outcome: 'queued', detail: result.error.message };
  return { outcome: 'rejected', detail: result.error.message };
}

export interface ResolvedTable {
  table: string;
  source: TableSource;
}

/**
 * Table name priority: command line (`-Play`, positional) or editor title as recorded on the
 * launch, then the ROM's descriptive name, then the ROM id itself.
 */
export function resolveTableName(launch: Pick<VpxLaunch, 'table' | 'tableSource'>, romName: string | null, rom: string | null): ResolvedTable | null {
  if (launch.table && launch.tableSource) return { table: launch.table, source: launch.tableSource };
  if (romName) return { table: romName, source: 'romname' };
  if (rom) return { table: rom, source: 'rom' };
  return null;
}

const SOURCE_TEXT: Record<TableSource, string> = {
  play: 'table from -Play',
  arg: 'table from the command line',
  title: 'table from the editor window title',
  romname: 'table name derived from the ROM (romnames.json)',
  rom: 'table name is the ROM id (no better name known)',
};

export function createWitness(store: WitnessSettingsStore, deps: WitnessDeps = {}): Witness {
  const clock = deps.clock ?? realClock;
  const fs = deps.fs ?? nodeFs;
  const registry = deps.registry ?? createRegQueryReader();
  const lister = deps.lister ?? createPowershellLister();
  const log = deps.log ?? (() => {});
  const corpus = deps.corpus ?? createMapCorpus(store.get().mapsDir, fs);
  const emitter = new Emitter<EventPayloads>();
  const settleMs = deps.nvSettleMs ?? DEFAULT_NV_SETTLE_MS;
  const alivePollMs = deps.nvAlivePollMs ?? DEFAULT_NV_ALIVE_POLL_MS;

  const status: WitnessStatus = {
    paired: store.get().token !== null,
    running: false,
    vpxExe: null,
    nvramDir: null,
    mapsVersion: null,
    currentTable: null,
    lastCapture: null,
    queued: 0,
    lastHeartbeatAt: null,
    lastError: null,
    note: null,
  };

  const sessions = new Map<number, OpenSession>();
  /** The nvram directory as of the last capture (or the first launch), with bytes for `sameGame`. */
  let baseline: NvSnapshot | null = null;
  /** A `.nv` change seen while VPX is open, waiting to settle. */
  let pending: { snapshot: NvSnapshot; lastChangeAt: number } | null = null;
  let nvTimer: TimerHandle | null = null;
  /** Capture waiting on a queued score post, by post id, so a late delivery updates the outcome. */
  const queuedCaptures = new Map<string, LastCapture>();
  let heartbeatTimer: TimerHandle | null = null;
  let chain: Promise<void> = Promise.resolve();
  let client: ArcaidClient | null = null;
  let clientBase: string | null = null;

  const emitStatus = () => {
    status.paired = store.get().token !== null;
    status.queued = queue.size();
    emitter.emit('status', { ...status });
  };
  const fail = (message: string) => {
    status.lastError = message;
    log(`witness: ${message}`);
    emitter.emit('error', message);
  };

  const arcaid = (): ArcaidClient => {
    const base = store.get().arcaidBaseUrl;
    if (!client || clientBase !== base) {
      client = new ArcaidClient({ baseUrl: base, fetch: deps.fetch, timeoutMs: deps.requestTimeoutMs });
      clientBase = base;
    }
    return client;
  };

  const queue = new PostQueue({
    dataDir: store.get().dataDir,
    client: arcaid,
    token: () => store.get().token,
    fs,
    clock,
    baseDelayMs: deps.queueBaseDelayMs,
    onSettled: (post: QueuedPost, result: PostResult) => {
      const capture = queuedCaptures.get(post.id);
      queuedCaptures.delete(post.id);
      if (result.state === 'rejected' && result.error.kind === 'auth') fail(result.error.message);
      if (capture && status.lastCapture && status.lastCapture.launchedAt === capture.launchedAt && status.lastCapture.table === capture.table) {
        const mapped = outcomeForPost(result);
        status.lastCapture = { ...status.lastCapture, outcome: mapped.outcome, ...(mapped.detail ? { detail: mapped.detail } : {}) };
        emitter.emit('capture', status.lastCapture);
      }
      emitStatus();
    },
    onError: fail,
  });

  // ---------------------------------------------------------------------------- heartbeat --

  const beat = async (): Promise<void> => {
    const { token, deviceId } = store.get();
    if (!token) return;
    try {
      await arcaid().heartbeat(token, deviceId);
      status.lastHeartbeatAt = iso(clock.now());
      if (status.lastError?.startsWith('ArcAid') || status.lastError === 'unpaired by ArcAid') status.lastError = null;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    emitStatus();
  };

  const scheduleHeartbeat = () => {
    if (heartbeatTimer !== null) clock.clearTimeout(heartbeatTimer);
    heartbeatTimer = clock.setTimeout(() => {
      heartbeatTimer = null;
      void beat().finally(() => {
        if (status.running && store.get().token) scheduleHeartbeat();
      });
    }, deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  };

  const startHeartbeat = () => {
    if (!status.running || !store.get().token) return;
    void beat().finally(() => {
      if (status.running && store.get().token) scheduleHeartbeat();
    });
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) clock.clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  };

  // ------------------------------------------------------------------------------ helpers --

  const resolveDir = async (vpxExe: string | null): Promise<string | null> => {
    const resolved = await resolveNvramDir({ override: store.get().nvramDir, registry, vpxExe, fs });
    if (resolved.dir) log(`witness: nvram dir ${resolved.dir} (${resolved.source})`);
    return resolved.dir;
  };

  const serial = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  };

  const decode = (map: CompiledMap | null, bytes: Uint8Array | null): GameState | null => {
    if (!map || !bytes) return null;
    try {
      return decodeGameState(map, bytes);
    } catch {
      return null;
    }
  };

  const refreshBaseline = async (): Promise<void> => {
    baseline = status.nvramDir ? await snapshotNvFiles(fs, status.nvramDir, { readBytes: true }) : new Map();
    pending = null;
  };

  /** The session a `.nv` change belongs to: the one whose player is up, else the most recently active. */
  const activeSession = (): OpenSession | null => {
    let best: OpenSession | null = null;
    for (const s of sessions.values()) {
      if (!best || (s.playerUp && !best.playerUp) || (s.playerUp === best.playerUp && s.lastActivityAt > best.lastActivityAt)) best = s;
    }
    return best;
  };

  const refreshTableStatus = () => {
    const active = activeSession();
    status.currentTable = active?.launch.table ?? null;
    status.note = sessions.size > 0 && !status.currentTable ? 'VPX is open; no table known yet' : null;
  };

  // ------------------------------------------------------------------------------ capture --

  /**
   * The one capture path: `changed` are the `.nv` names that differ from the baseline (newest
   * first), `after` the snapshot they were seen in. Posts the player session's report and score,
   * then refreshes the baseline so the next player session starts clean.
   */
  const capture = async (session: OpenSession, changed: string[], after: NvSnapshot, trigger: CaptureTrigger, endedFallback: number): Promise<void> => {
    const nvramDir = status.nvramDir;
    const { deviceId, token } = store.get();
    const started = Math.max(session.startedAt, session.lastCaptureAt ?? 0);
    const name = changed[0] ?? null;
    const rom = name ? romFromNvName(name) : null;
    const details: string[] = [];

    const mtime = name ? after.get(name)?.mtimeMs : undefined;
    const ended = mtime !== undefined && mtime >= started && mtime <= clock.now() + 60_000 ? mtime : endedFallback;
    if (changed.length > 1) details.push(`${changed.length} .nv files changed; using the newest (${name})`);
    if (!nvramDir) details.push('VPinMAME nvram directory not found (set it in settings)');

    let map: CompiledMap | null = null;
    let before: GameState | null = null;
    let afterState: GameState | null = null;
    if (rom && name && nvramDir) {
      map = await corpus.mapFor(rom);
      try {
        afterState = decode(map, await fs.readFile(joinPath(nvramDir, name)));
      } catch (err) {
        details.push(`could not read ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      before = decode(map, baseline?.get(name)?.bytes ?? null);
    }

    const resolved = resolveTableName(session.launch, rom ? await corpus.romName(rom) : null, rom);
    const table = resolved?.table ?? UNKNOWN_TABLE;
    if (resolved) details.push(SOURCE_TEXT[resolved.source]);
    details.push(trigger === 'player' ? 'captured when the player closed' : 'captured at VPX exit');

    const durationSec = Math.max(0, Math.round((ended - started) / 1000));
    const decision = decideCapture({ table, rom, map, before, after: afterState, launchedAtMs: started, exitedAtMs: ended });
    const result: LastCapture = {
      table,
      rom,
      players: decision.players,
      score: decision.score,
      launchedAt: iso(started),
      exitedAt: iso(ended),
      outcome: 'skipped',
    };

    if (token && resolved) {
      const reported = await queue.submit({
        kind: 'report',
        params: { device: deviceId, table, launch: sec(started), exit: sec(ended), dur: durationSec },
      });
      if (reported.state === 'rejected') fail(reported.error.message);
    }

    if (decision.kind === 'skip') {
      result.outcome = 'skipped';
      details.unshift(decision.detail);
    } else if (!token) {
      result.outcome = 'skipped';
      details.unshift('not paired with ArcAid');
    } else {
      const posted = await queue.submit({
        kind: 'score',
        params: {
          device: deviceId,
          table,
          rom,
          score: decision.score,
          started: sec(started),
          ended: sec(ended),
          dur: durationSec,
          reason: decision.reason,
        },
      });
      const mapped = outcomeForPost(posted);
      result.outcome = mapped.outcome;
      for (const d of [decision.detail, mapped.detail]) if (d) details.unshift(d);
      if (posted.state === 'queued') {
        const last = queue.pending()[queue.size() - 1];
        if (last) queuedCaptures.set(last.id, result);
      }
      if (posted.state === 'rejected' && posted.error.kind === 'auth') fail(posted.error.message);
    }

    result.detail = details.join('; ');
    session.lastCaptureAt = ended;
    session.captures++;
    await refreshBaseline();
    status.lastCapture = result;
    log(`witness: ${table} → ${result.outcome} (${result.detail})`);
    emitter.emit('capture', result);
    emitStatus();
  };

  // ----------------------------------------------------------------------- alive nv poll --

  const stopNvPoll = () => {
    if (nvTimer !== null) clock.clearTimeout(nvTimer);
    nvTimer = null;
    pending = null;
  };

  const scheduleNvPoll = () => {
    if (!status.running || sessions.size === 0 || !status.nvramDir || nvTimer !== null) return;
    nvTimer = clock.setTimeout(() => {
      nvTimer = null;
      serial(nvTick);
    }, alivePollMs);
  };

  /** One look at the nvram dir while VPX is open: notice a change, wait for it to settle, capture. */
  const nvTick = async (): Promise<void> => {
    if (!status.running || sessions.size === 0 || !status.nvramDir || !baseline) return;
    const now = clock.now();
    const snap = await snapshotNvFiles(fs, status.nvramDir);
    if (pending) {
      if (changedNvFiles(pending.snapshot, snap).length > 0) {
        pending = { snapshot: snap, lastChangeAt: now };
      } else if (now - pending.lastChangeAt >= settleMs) {
        const changed = changedNvFiles(baseline, snap);
        pending = null;
        const session = activeSession();
        if (changed.length > 0 && session) await capture(session, changed, snap, 'player', now);
      }
    } else if (changedNvFiles(baseline, snap).length > 0) {
      pending = { snapshot: snap, lastChangeAt: now };
    }
    scheduleNvPoll();
  };

  // ----------------------------------------------------------------------------- sessions --

  const onLaunch = async (launch: VpxLaunch): Promise<void> => {
    status.vpxExe = launch.exe;
    if (status.nvramDir === null) status.nvramDir = await resolveDir(launch.exe);
    const session: OpenSession = {
      launch,
      startedAt: launch.startedAt ?? launch.seenAt,
      lastCaptureAt: null,
      captures: 0,
      playerUp: false,
      lastActivityAt: launch.seenAt,
    };
    sessions.set(launch.pid, session);
    if (!baseline) await refreshBaseline();
    refreshTableStatus();
    emitter.emit('launch', { table: launch.table, exe: launch.exe, pid: launch.pid, at: iso(launch.seenAt) });
    emitStatus();
    scheduleNvPoll();
  };

  const onTitle = async (t: VpxTitle): Promise<void> => {
    const session = sessions.get(t.launch.pid);
    if (!session) return;
    session.playerUp = t.parsed.kind === 'player';
    session.lastActivityAt = t.at;
    refreshTableStatus();
    emitStatus();
  };

  const onExit = async (exit: VpxExit): Promise<void> => {
    const { launch, exitedAt } = exit;
    const session = sessions.get(launch.pid);
    sessions.delete(launch.pid);
    const durationSec = Math.max(0, Math.round((exitedAt - launch.seenAt) / 1000));
    emitter.emit('exit', { table: launch.table, at: iso(exitedAt), durationSec });

    if (session && status.nvramDir && baseline) {
      // Final chance: a `.nv` rewritten as the table closed, not yet captured by the alive poll.
      const change = await waitForNvChange(fs, status.nvramDir, baseline, { clock, timeoutMs: settleMs, pollMs: deps.nvPollMs ?? DEFAULT_NV_POLL_MS });
      pending = null;
      if (change.changed.length > 0) {
        await capture(session, change.changed, change.after, 'exit', exitedAt);
      } else if (session.captures === 0 && launch.table) {
        // A table we knew about ended without a ROM write: an original, or nothing was played.
        await capture(session, [], change.after, 'exit', exitedAt);
      }
    } else if (session && session.captures === 0 && launch.table) {
      const empty: NvSnapshot = new Map();
      await capture(session, [], empty, 'exit', exitedAt);
    }

    if (sessions.size === 0) {
      baseline = null;
      stopNvPoll();
    }
    refreshTableStatus();
    emitStatus();
  };

  const watch = new ProcessWatch({ lister, clock, intervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS });
  watch.on('launch', (l) => serial(() => onLaunch(l)));
  watch.on('title', (t) => serial(() => onTitle(t)));
  watch.on('exit', (e) => serial(() => onExit(e)));
  watch.on('error', (err) => fail(`process watch: ${err.message}`));

  // -------------------------------------------------------------------------------- public --

  return {
    async start() {
      if (status.running) return;
      status.running = true;
      status.mapsVersion = await corpus.version().catch(() => null);
      status.nvramDir = await resolveDir(null);
      await queue.load();
      queue.resume();
      startHeartbeat();
      watch.start();
      emitStatus();
    },

    async stop() {
      if (!status.running) return;
      status.running = false;
      watch.stop();
      stopHeartbeat();
      stopNvPoll();
      queue.stop();
      await chain;
      emitStatus();
    },

    async pair(code: string) {
      const { deviceId, deviceLabel } = store.get();
      try {
        const token = await arcaid().pair(code, deviceId, deviceLabel);
        await store.set({ token });
      } catch (err) {
        const message = err instanceof ArcaidError ? err.message : err instanceof Error ? err.message : String(err);
        fail(`pairing failed: ${message}`);
        emitStatus();
        throw new Error(message);
      }
      status.lastError = null;
      startHeartbeat();
      void queue.flush();
      emitStatus();
    },

    async unpair() {
      await store.set({ token: null });
      stopHeartbeat();
      emitStatus();
    },

    status() {
      status.paired = store.get().token !== null;
      status.queued = queue.size();
      return { ...status };
    },

    on(event, listener) {
      return emitter.on(event, listener as (payload: EventPayloads[typeof event]) => void);
    },
  };
}
