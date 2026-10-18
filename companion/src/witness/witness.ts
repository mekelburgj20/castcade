/**
 * The witness orchestrator (basic mode): process watch → nvram snapshot at launch → on exit wait
 * for the rewritten `.nv`, decode it with the maps corpus, decide, post through the offline queue.
 * Heartbeats keep the device "online" in ArcAid's event lobby (stale after 300 s server-side, so
 * one every 120 s). Everything Windows-specific or networked arrives through `WitnessDeps`, with
 * production defaults, so the whole thing runs under vitest on Linux with fakes.
 */
import { realClock, type Clock, type TimerHandle } from '../match/clock.js';
import { Emitter } from '../match/events.js';
import { ArcaidClient, ArcaidError, type FetchLike } from './arcaid-client.js';
import { decideCapture } from './capture.js';
import { nodeFs, type WitnessFs } from './fs.js';
import { createMapCorpus, decodeGameState, romFromNvName, type GameState, type MapCorpus } from './maps.js';
import { createRegQueryReader, resolveNvramDir, type RegistryReader } from './nvram-dir.js';
import { snapshotNvFiles, waitForNvChange, DEFAULT_NV_POLL_MS, DEFAULT_NV_SETTLE_MS, type NvSnapshot } from './nvram-snapshot.js';
import { createPowershellLister, ProcessWatch, DEFAULT_POLL_INTERVAL_MS, type ProcessLister, type VpxExit, type VpxLaunch } from './process-watch.js';
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
  /** How long to wait for VPinMAME to rewrite the `.nv` after VPX exits. */
  nvSettleMs?: number;
  nvPollMs?: number;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  queueBaseDelayMs?: number;
  /** Diagnostic log line sink (default: none). */
  log?: (line: string) => void;
}

/** ArcAid's `HEARTBEAT_STALE_SEC` is 300; two beats per window keeps a desktop "online" through one miss. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 120_000;

type EventPayloads = {
  [K in keyof WitnessEvents]: Parameters<WitnessEvents[K]>[0];
};

interface OpenSession {
  launch: VpxLaunch;
  nvramDir: string | null;
  snapshot: NvSnapshot;
}

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

export function createWitness(store: WitnessSettingsStore, deps: WitnessDeps = {}): Witness {
  const clock = deps.clock ?? realClock;
  const fs = deps.fs ?? nodeFs;
  const registry = deps.registry ?? createRegQueryReader();
  const lister = deps.lister ?? createPowershellLister();
  const log = deps.log ?? (() => {});
  const corpus = deps.corpus ?? createMapCorpus(store.get().mapsDir, fs);
  const emitter = new Emitter<EventPayloads>();

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

  // ------------------------------------------------------------------------------ sessions --

  const resolveDir = async (vpxExe: string | null): Promise<string | null> => {
    const resolved = await resolveNvramDir({ override: store.get().nvramDir, registry, vpxExe, fs });
    if (resolved.dir) log(`witness: nvram dir ${resolved.dir} (${resolved.source})`);
    return resolved.dir;
  };

  const serial = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  };

  const onLaunch = async (launch: VpxLaunch): Promise<void> => {
    status.vpxExe = launch.exe;
    if (status.nvramDir === null) status.nvramDir = await resolveDir(launch.exe);
    if (launch.table === null) {
      status.note = 'VPX is running without -Play (editor): nothing to capture';
      emitStatus();
      return;
    }
    status.note = null;
    status.currentTable = launch.table;
    const snapshot: NvSnapshot = status.nvramDir ? await snapshotNvFiles(fs, status.nvramDir, { readBytes: true }) : new Map();
    sessions.set(launch.pid, { launch, nvramDir: status.nvramDir, snapshot });
    emitter.emit('launch', { table: launch.table, exe: launch.exe, pid: launch.pid, at: iso(launch.seenAt) });
    emitStatus();
  };

  const decode = (map: Awaited<ReturnType<MapCorpus['mapFor']>>, bytes: Uint8Array | null): GameState | null => {
    if (!map || !bytes) return null;
    try {
      return decodeGameState(map, bytes);
    } catch {
      return null;
    }
  };

  const onExit = async (exit: VpxExit): Promise<void> => {
    const { launch, exitedAt } = exit;
    const session = sessions.get(launch.pid);
    sessions.delete(launch.pid);
    if (sessions.size === 0) status.currentTable = null;
    if (launch.table === null) {
      status.note = null;
      emitStatus();
      return;
    }
    const table = launch.table;
    const durationSec = Math.max(0, Math.round((exitedAt - launch.seenAt) / 1000));
    emitter.emit('exit', { table, at: iso(exitedAt), durationSec });

    const { deviceId, token } = store.get();
    const capture: LastCapture = {
      table,
      rom: null,
      players: 0,
      score: null,
      launchedAt: iso(launch.seenAt),
      exitedAt: iso(exitedAt),
      outcome: 'skipped',
    };

    if (token) {
      const reported = await queue.submit({
        kind: 'report',
        params: { device: deviceId, table, launch: sec(launch.seenAt), exit: sec(exitedAt), dur: durationSec },
      });
      if (reported.state === 'rejected') fail(reported.error.message);
    }

    const nvramDir = session?.nvramDir ?? status.nvramDir;
    let rom: string | null = null;
    let map: Awaited<ReturnType<MapCorpus['mapFor']>> = null;
    let before: GameState | null = null;
    let after: GameState | null = null;
    let nvDetail: string | null = null;

    if (!nvramDir) {
      nvDetail = 'VPinMAME nvram directory not found (set it in settings)';
    } else {
      const change = await waitForNvChange(fs, nvramDir, session?.snapshot ?? new Map(), {
        clock,
        timeoutMs: deps.nvSettleMs ?? DEFAULT_NV_SETTLE_MS,
        pollMs: deps.nvPollMs ?? DEFAULT_NV_POLL_MS,
      });
      const name = change.changed[0];
      if (name) {
        rom = romFromNvName(name);
        if (change.changed.length > 1) nvDetail = `${change.changed.length} .nv files changed; using the newest (${name})`;
        map = await corpus.mapFor(rom);
        try {
          after = decode(map, await fs.readFile(joinPath(nvramDir, name)));
        } catch (err) {
          nvDetail = `could not read ${name}: ${err instanceof Error ? err.message : String(err)}`;
        }
        before = decode(map, session?.snapshot.get(name)?.bytes ?? null);
      }
    }

    const decision = decideCapture({ table, rom, map, before, after, launchedAtMs: launch.seenAt, exitedAtMs: exitedAt });
    capture.rom = rom;
    capture.players = decision.players;
    capture.score = decision.score;

    if (decision.kind === 'skip') {
      capture.outcome = 'skipped';
      capture.detail = nvDetail ? `${decision.detail} (${nvDetail})` : decision.detail;
    } else if (!token) {
      capture.outcome = 'skipped';
      capture.detail = 'not paired with ArcAid';
    } else {
      const result = await queue.submit({
        kind: 'score',
        params: {
          device: deviceId,
          table,
          rom,
          score: decision.score,
          started: sec(launch.seenAt),
          ended: sec(exitedAt),
          dur: durationSec,
          reason: decision.reason,
        },
      });
      const mapped = outcomeForPost(result);
      capture.outcome = mapped.outcome;
      const details = [decision.detail, mapped.detail, nvDetail].filter((d): d is string => !!d);
      if (details.length > 0) capture.detail = details.join('; ');
      if (result.state === 'queued') {
        const last = queue.pending()[queue.size() - 1];
        if (last) queuedCaptures.set(last.id, capture);
      }
      if (result.state === 'rejected' && result.error.kind === 'auth') fail(result.error.message);
    }

    status.lastCapture = capture;
    log(`witness: ${table} → ${capture.outcome}${capture.detail ? ` (${capture.detail})` : ''}`);
    emitter.emit('capture', capture);
    emitStatus();
  };

  const watch = new ProcessWatch({ lister, clock, intervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS });
  watch.on('launch', (l) => serial(() => onLaunch(l)));
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
