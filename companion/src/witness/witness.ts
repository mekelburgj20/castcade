/**
 * The witness orchestrator (basic mode): process watch → nvram baseline while VPX is open → when a
 * `.nv` changes and settles (the in-process player closed), or when VPX exits with a changed `.nv`,
 * decode it with the maps corpus, decide, post through the offline queue. Heartbeats keep the
 * device "online" in ArcAid's event lobby (stale after 300 s server-side, so one every 120 s).
 * Everything Windows-specific or networked arrives through `WitnessDeps`, with production
 * defaults, so the whole thing runs under vitest on Linux with fakes.
 *
 * ## What ArcAid's event lobby sees
 *
 * A **launch report** (no `exit`) goes out as soon as a session has a table name, so the lobby
 * shows `table_open` during the game; the capture's report (same device/table/launch key, with
 * `exit`) closes it. A **check-in** ("no table is open on this machine right now") goes out
 * only while no VPX process is running: at start, after every exit, and on each heartbeat tick
 * while idle. That is what turns a desktop player `ready` once an event's check-in window
 * opens, and the reply's `sendingTo` line is shown in Status so a stale routing gets noticed
 * before the round, not after it.
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
 *
 * On top of the name, F1 of `docs/design/fairness-and-table-identity.md`: once a session has a
 * table file (named on the command line, or found under the tables folder from the editor title)
 * the identity resolver reads its TableInfo and physics, matches the VPS game and table, and hashes
 * the file in the background; at capture the ROM pins the game. The ids ride on the score as
 * `vps_game` / `vps_table` / `table_sha256` / `table_save_rev` and in `LastCapture.identity`.
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
import { adjustmentsReport, decodeAdjustments, describeAdjustments } from './adjustments.js';
import { adjustmentsWire, buildWire, iniWire, type Attestation } from './attestation-types.js';
import { createBuildAttester, describeBuild, vpmCheatFlag } from './build-attestation.js';
import { createIdentityResolver } from './identity-resolver.js';
import { createIdentityStore } from './identity-store.js';
import { describeIni, readIniAttestation } from './ini-attestation.js';
import type { TableIdentity, VpsIndex } from './identity-types.js';
import { PostQueue, type PostResult, type QueuedPost } from './queue.js';
import { findTableFile, tableBaseName, tableRootsFor } from './table-locator.js';
import { catalogueTableName } from './table-name.js';
import { createVpsIndex } from './vps-index.js';
import type { CaptureOutcome, LastCapture, Witness, WitnessEvents, WitnessSettingsStore, WitnessStatus } from './types.js';

export interface WitnessDeps {
  clock?: Clock;
  lister?: ProcessLister;
  registry?: RegistryReader;
  fs?: WitnessFs;
  fetch?: FetchLike;
  /** Overrides `settings.mapsDir`. */
  corpus?: MapCorpus;
  /** Overrides `settings.vpsDir`. */
  vpsIndex?: VpsIndex;
  /** How long a capture waits for a still-running file hash before posting without it. */
  hashWaitMs?: number;
  /** Environment for `%APPDATA%` (the per-user `VPinballX.ini` location); default `process.env`. */
  env?: NodeJS.ProcessEnv;
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
export const DEFAULT_HASH_WAIT_MS = 3_000;
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
  /** The (table, launch) key of the launch report sent for the current player session, if any. */
  reported: { table: string; launch: number } | null;
  /** Identity of the session's table file as far as it is resolved; null until a table is known. */
  identity: TableIdentity | null;
  /** What `identity` was resolved for (file path, or the bare name when no file was found). */
  identityFor: string | null;
  /** The background hash of the table file, when one is running. */
  hashing: Promise<void> | null;
  /** Settings and builds measured when the table became known; completed (adjustments, cheat flag) at capture. */
  attestation: Attestation | null;
}

type CaptureTrigger = 'player' | 'exit';

const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);

function joinPath(dir: string, name: string): string {
  const sepChar = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sepChar + name;
}

/** Map ArcAid's wire `status` for a score to the module's outcome vocabulary. */
export function outcomeForWire(
  status: string | null,
  wire: { reasons?: string[]; fallback?: string | null } = {},
): { outcome: CaptureOutcome; detail?: string } {
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
    case 'not_sanctioned': {
      // ArcAid 2.165.0 (item 11): the tournament is in Sanctioned play and a rule failed. The
      // reasons are the server's own words; the play still reached the Global Scoreboard when
      // `fallback` says so. Shown on the Status page so the player knows what to change.
      const reasons = (wire.reasons ?? []).filter((r) => r.trim().length > 0);
      const why = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
      const went = wire.fallback === 'global' ? '; recorded on the Global Scoreboard instead'
        : wire.fallback === 'global_duplicate' ? '; already on the Global Scoreboard' : '';
      return { outcome: 'rejected', detail: `ArcAid: not counted for the tournament (Sanctioned play)${why}${went}` };
    }
    default:
      return { outcome: 'rejected', detail: `ArcAid: ${status}` };
  }
}

export function outcomeForPost(result: PostResult): { outcome: CaptureOutcome; detail?: string } {
  if (result.state === 'done') return outcomeForWire(result.wire?.status ?? null, result.wire ?? {});
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
    currentIdentity: null,
    currentAttestation: null,
    vpsVersion: null,
    lastCapture: null,
    queued: 0,
    lastHeartbeatAt: null,
    lastCheckinAt: null,
    sendingTo: null,
    lastError: null,
    note: null,
  };

  const sessions = new Map<number, OpenSession>();
  const identityStore = createIdentityStore(fs, store.get().dataDir, () => clock.now());
  const vpsIndex = deps.vpsIndex ?? createVpsIndex(store.get().vpsDir, fs);
  const resolver = createIdentityResolver({ fs, index: vpsIndex, store: identityStore, now: () => clock.now(), log });
  const hashWaitMs = deps.hashWaitMs ?? DEFAULT_HASH_WAIT_MS;
  const builds = createBuildAttester({ fs, registry, log });
  const env = deps.env ?? process.env;
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

  // ------------------------------------------------------------------ heartbeat + check-in --

  const clearArcaidError = () => {
    if (status.lastError?.startsWith('ArcAid') || status.lastError === 'unpaired by ArcAid') status.lastError = null;
  };

  /**
   * Check in with ArcAid: an attestation that no table is open on this machine at this instant,
   * so it is never sent while a VPX process is running. Repeats are expected server-side.
   */
  const checkin = async (): Promise<void> => {
    const { token, deviceId } = store.get();
    if (!token || sessions.size > 0) return;
    try {
      const result = await arcaid().checkin(token, deviceId);
      status.lastCheckinAt = iso(clock.now());
      status.sendingTo = result.sendingTo;
      clearArcaidError();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    emitStatus();
  };

  const beat = async (): Promise<void> => {
    const { token, deviceId } = store.get();
    if (!token) return;
    try {
      await arcaid().heartbeat(token, deviceId);
      status.lastHeartbeatAt = iso(clock.now());
      clearArcaidError();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    emitStatus();
    await checkin();
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
    status.currentIdentity = active?.identity ?? null;
    status.currentAttestation = active?.attestation ?? null;
    status.note = sessions.size > 0 && !status.currentTable ? 'VPX is open; no table known yet' : null;
  };

  // --------------------------------------------------------------------------- attestation --

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /**
   * The settings (ini) and builds (exe, DLL) in force for a session, measured when the table is
   * known and again at capture. Adjustments and the cheat flag need the ROM and are kept from the
   * session's previous attestation until the capture fills them in.
   */
  const measureAttestation = async (session: OpenSession): Promise<Attestation> => {
    const { launch } = session;
    const notes: string[] = [];
    const tablePath = session.identity?.filePath ?? launch.tablePath;
    const ini = await readIniAttestation({ fs, exe: launch.exe, iniPath: launch.iniPath, tablePath, tableIniPath: launch.tableIniPath, physics: session.identity?.physics ?? null, env }).catch((err: unknown) => {
      notes.push(`settings: ${errText(err)}`);
      return null;
    });
    const build = await builds.forExe(launch.exe).catch((err: unknown) => {
      notes.push(`build: ${errText(err)}`);
      return null;
    });
    return {
      measuredAt: iso(clock.now()),
      ini,
      build,
      adjustments: session.attestation?.adjustments ?? null,
      vpmCheat: session.attestation?.vpmCheat ?? null,
      iniChanged: false,
      notes,
    };
  };

  // ------------------------------------------------------------------------------ identity --

  /**
   * Resolve the session's table identity from its file: the `-Play` path when there is one, else
   * `<name>.vpx` under the VPX `tables` folder (and the `tablesDir` setting). Idempotent per target;
   * the hash runs in the background and updates the status when it lands.
   */
  const resolveIdentity = async (session: OpenSession): Promise<void> => {
    const { launch } = session;
    let path = launch.tablePath;
    if (!path && launch.table) {
      const roots = await tableRootsFor(fs, launch.exe, [store.get().tablesDir]).catch(() => [] as string[]);
      path = await findTableFile(fs, launch.table, roots).catch(() => null);
    }
    const target = path ?? launch.table;
    if (!target || session.identityFor === target) return;
    session.identityFor = target;
    const identity = await resolver.fromFile(path, path ? tableBaseName(path) : launch.table);
    session.identity = identity;
    if (identity.vpsGame) log(`witness: identity ${identity.vpsGame.name} (${identity.vpsGame.id}) / ${identity.vpsTable ? `${identity.vpsTable.label} (${identity.vpsTable.id}, ${identity.tableConfidence})` : `table ${identity.tableConfidence}`}`);
    else log(`witness: identity unresolved for ${target}: ${identity.notes.join('; ')}`);
    session.attestation = await measureAttestation(session);
    if (session.attestation.ini) log(`witness: settings ${describeIni(session.attestation.ini)}`);
    refreshTableStatus();
    emitStatus();
    if (path && !identity.sha256) {
      session.hashing = resolver
        .hash(identity)
        .then((hashed) => {
          if (session.identity && session.identity.filePath === hashed.filePath) {
            session.identity = { ...session.identity, sha256: hashed.sha256, notes: hashed.sha256 ? session.identity.notes : hashed.notes };
            refreshTableStatus();
            emitStatus();
          }
        })
        .finally(() => {
          session.hashing = null;
        });
    }
  };

  /** The identity a capture posts: the session's, upgraded by the ROM, with the hash if it is in time. */
  const identityForCapture = async (session: OpenSession, rom: string | null, romName: string | null): Promise<TableIdentity | null> => {
    if (session.hashing) {
      let timer: TimerHandle | null = null;
      await Promise.race([session.hashing, new Promise<void>((r) => { timer = clock.setTimeout(r, hashWaitMs); })]);
      if (timer !== null) clock.clearTimeout(timer);
    }
    let identity = session.identity;
    if (!identity && !rom) return null;
    if (!identity) identity = await resolver.fromFile(null, session.launch.table);
    return resolver.withRom(identity, rom, romName);
  };

  /** The report key the capture for this player session will use (same table name, same launch second). */
  const sessionKey = (session: OpenSession): { table: string; launch: number } | null => {
    if (!session.launch.table) return null;
    return { table: catalogueTableName(session.launch.table), launch: sec(Math.max(session.startedAt, session.lastCaptureAt ?? 0)) };
  };

  /**
   * Open the session in ArcAid (launch-only report) once the table is known; idempotent per
   * (table, launch) so title churn and the player going up and down do not repeat it.
   */
  const reportLaunch = async (session: OpenSession): Promise<void> => {
    const { deviceId, token } = store.get();
    const key = sessionKey(session);
    if (!token || !key) return;
    if (session.reported && session.reported.table === key.table && session.reported.launch === key.launch) return;
    session.reported = key;
    const reported = await queue.submit({ kind: 'report', params: { device: deviceId, table: key.table, launch: key.launch } });
    if (reported.state === 'rejected') fail(reported.error.message);
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
    let nvBytes: Uint8Array | null = null;
    if (rom && name && nvramDir) {
      map = await corpus.mapFor(rom);
      try {
        nvBytes = await fs.readFile(joinPath(nvramDir, name));
        afterState = decode(map, nvBytes);
      } catch (err) {
        details.push(`could not read ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      before = decode(map, baseline?.get(name)?.bytes ?? null);
    }

    const romName = rom ? await corpus.romName(rom) : null;
    const identity = await identityForCapture(session, rom, romName).catch((err: unknown) => {
      details.push(`identity failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (identity) {
      session.identity = identity;
      if (identity.vpsGame) details.push(`VPS game ${identity.vpsGame.name} (${identity.vpsGame.id})${identity.vpsTable ? `, table ${identity.vpsTable.label} (${identity.vpsTable.id}${identity.confirmed ? ', confirmed' : identity.tableConfidence === 'exact' ? '' : `, ${identity.tableConfidence}`})` : ', table undecided'}`);
    }
    // Attestation: settings re-read now (the tweak menu writes the table ini at exit), adjustments
    // from the very bytes the score came from, the cheat flag for this ROM.
    const launchIni = session.attestation?.ini ?? null;
    const measured = await measureAttestation(session);
    const adjustments = map && nvBytes && rom ? adjustmentsReport(rom, decodeAdjustments(map, nvBytes)) : null;
    const vpmCheat = rom ? await vpmCheatFlag(registry, rom).catch(() => null) : null;
    const iniChanged = launchIni !== null && measured.ini !== null && iniWire(launchIni) !== iniWire(measured.ini);
    const attestation: Attestation = { ...measured, adjustments, vpmCheat, iniChanged };
    session.attestation = attestation;
    if (attestation.ini) details.push(describeIni(attestation.ini));
    if (iniChanged) details.push('settings changed during the session');
    if (rom) details.push(describeAdjustments(adjustments));
    details.push(describeBuild(attestation.build, vpmCheat));

    const resolved = resolveTableName(session.launch, romName, rom);
    const table = resolved?.table ?? UNKNOWN_TABLE;
    // What ArcAid sees: the catalogue-grade name, plus the ROM's own name as the `slug` fallback key.
    const wireTable = resolved ? catalogueTableName(resolved.table) : UNKNOWN_TABLE;
    const wireSlug = romName && catalogueTableName(romName) !== wireTable ? catalogueTableName(romName) : null;
    if (resolved) details.push(SOURCE_TEXT[resolved.source]);
    if (wireTable !== table) details.push(`sent to ArcAid as "${wireTable}"${wireSlug ? ` (or "${wireSlug}")` : ''}`);
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
      identity,
      attestation,
    };

    if (token && resolved) {
      const reported = await queue.submit({
        kind: 'report',
        params: { device: deviceId, table: wireTable, launch: sec(started), exit: sec(ended), dur: durationSec },
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
          table: wireTable,
          rom,
          slug: wireSlug,
          score: decision.score,
          started: sec(started),
          ended: sec(ended),
          dur: durationSec,
          reason: decision.reason,
          vps_game: identity?.vpsGame?.id ?? null,
          vps_table: identity?.vpsTable?.id ?? null,
          table_sha256: identity?.sha256 ?? null,
          table_save_rev: identity?.saveRev ?? null,
          ini: iniWire(attestation.ini),
          adjustments: adjustmentsWire(adjustments),
          build: buildWire(attestation.build, vpmCheat),
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
      reported: null,
      identity: null,
      identityFor: null,
      hashing: null,
      attestation: null,
    };
    sessions.set(launch.pid, session);
    if (!baseline) await refreshBaseline();
    refreshTableStatus();
    emitter.emit('launch', { table: launch.table, exe: launch.exe, pid: launch.pid, at: iso(launch.seenAt) });
    emitStatus();
    scheduleNvPoll();
    await reportLaunch(session);
    await resolveIdentity(session);
  };

  const onTitle = async (t: VpxTitle): Promise<void> => {
    const session = sessions.get(t.launch.pid);
    if (!session) return;
    session.playerUp = t.parsed.kind === 'player';
    session.lastActivityAt = t.at;
    refreshTableStatus();
    emitStatus();
    // The editor named a table, or the player went up for another game on it: open that session.
    await reportLaunch(session);
    await resolveIdentity(session);
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
    // No table is open on this machine any more: say so (this is what makes the lobby `ready`).
    if (sessions.size === 0) await checkin();
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
      status.vpsVersion = await vpsIndex.version().catch(() => null);
      status.nvramDir = await resolveDir(null);
      await queue.load();
      await identityStore.load().catch((err: unknown) => fail(`identity store: ${err instanceof Error ? err.message : String(err)}`));
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

    async confirmTable(filePath, vpsTableId) {
      const same = (i: TableIdentity | null | undefined): i is TableIdentity => !!i && i.filePath !== null && i.filePath.toLowerCase() === filePath.toLowerCase();
      const current = [...sessions.values()].map((s) => s.identity).find(same) ?? (same(status.lastCapture?.identity) ? status.lastCapture!.identity! : null);
      await identityStore.confirm(filePath, vpsTableId === null ? null : { vpsGameId: current?.vpsGame?.id ?? null, vpsTableId });
      for (const s of sessions.values()) if (same(s.identity)) s.identity = resolver.applyConfirmation(s.identity);
      if (status.lastCapture && same(status.lastCapture.identity)) {
        status.lastCapture = { ...status.lastCapture, identity: resolver.applyConfirmation(status.lastCapture.identity) };
      }
      refreshTableStatus();
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
