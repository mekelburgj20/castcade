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
import { readVpxScript } from './vpx-file.js';
import type { EngineAttestation } from './attestation-types.js';
import { Emitter } from '../match/events.js';
import { ArcaidClient, ArcaidError, type AttemptStartAnswer, type AttemptStartParams, type FetchLike } from './arcaid-client.js';
import { decideCapture } from './capture.js';
import { JournalDetector, type JournalEvent, type EngineSample } from './journal-detector.js';
import { JournalTail, journalDir, journalFileName } from './journal-tail.js';
import { newestJournalSince, parseSessionStamp } from './journal-scan.js';
import { RECIPE_VERSION, disableSidecar, manifestPathFor, readManifest, type Manifest, classifyScript, decodeScript, isOurSidecar, sidecarPathFor, unpatchRecipeA } from '../patcher/index.js';
import { describeScriptDiff, scriptDiffReport, scriptDiffWire, type ScriptDiffReport } from './script-diff.js';
import { isNotFound, nodeFs, type WitnessFs } from './fs.js';
import { createMapCorpus, decodeGameState, liveSupport, romFromNvName, type CompiledMap, type GameState, type MapCorpus } from './maps.js';
import { createRegQueryReader, resolveNvramDir, type RegistryReader } from './nvram-dir.js';
import { changedNvFiles, snapshotNvFiles, waitForNvChange, DEFAULT_NV_POLL_MS, DEFAULT_NV_SETTLE_MS, type NvSnapshot } from './nvram-snapshot.js';
import {
  createPowershellLister,
  ProcessWatch,
  DEFAULT_POLL_INTERVAL_MS,
  parseWindowTitle,
  type ProcessLister,
  type TableSource,
  type VpxExit,
  type VpxLaunch,
  type VpxTitle,
} from './process-watch.js';
import { adjustmentsReport, decodeAdjustments, describeAdjustments } from './adjustments.js';
import { adjustmentsWire, buildWire, iniWire, type Attestation, describeEngine, engineWire } from './attestation-types.js';
import { describeScorePlausibility, ROM_SCORE_STEP, ScoreTrack, scorePlausibilityWire, type ScorePlausibility } from './score-plausibility.js';
import { createBuildAttester, describeBuild, vpmCheatFlag } from './build-attestation.js';
import { NO_VR_PROBE, createPowershellVrProbe, describeVr, playDeviceFor, type VrProbe } from './vr-detect.js';
import { createIdentityResolver } from './identity-resolver.js';
import { createIdentityStore } from './identity-store.js';
import { attemptKey, createPostedGames, postedGameKey } from './posted-games.js';
import { describeIni, readIniAttestation } from './ini-attestation.js';
import type { TableIdentity, VpsIndex } from './identity-types.js';
import { PostQueue, type PostResult, type QueuedPost } from './queue.js';
import { findTableFile, tableBaseName, tableRootsFor } from './table-locator.js';
import { catalogueTableName } from './table-name.js';
import { createVpsIndex } from './vps-index.js';
import type { AttemptStatus, CaptureOutcome, LastCapture, LiveGame, Witness, WitnessEvents, WitnessSettingsStore, WitnessStatus } from './types.js';

export interface WitnessDeps {
  clock?: Clock;
  lister?: ProcessLister;
  /** Headset-or-monitor probe (0.2.10). Omitted = the PowerShell probe; `null` = never sample (tests). */
  vrProbe?: VrProbe | null;
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
  /**
   * Where the in-VPX hook writes its journals (`%LOCALAPPDATA%\\Castcade\\journal`). Omitted = from the
   * environment; `null` = live mode off (basic mode only).
   */
  journalDir?: string | null;
  /** Poll step of the journal tail while a table with a sidecar is open. */
  journalPollMs?: number;
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
  /** B19: the ROM `identity` was last pinned with (`pinIdentityByRom`), so a journal replay pins once. */
  identityRom: string | null;
  /** The background hash of the table file, when one is running. */
  hashing: Promise<void> | null;
  /** Settings and builds measured when the table became known; completed (adjustments, cheat flag) at capture. */
  attestation: Attestation | null;
  /** Live mode (journal tail + detector) when the table has a Castcade sidecar; null in basic mode. */
  live: LiveSession | null;
  /**
   * Journal sessions (`<tableId>@<stamp>`) this VPX process already read. One process can load several
   * tables from the editor; going back to a table re-tails its journal from the top, and its earlier
   * games in this process must not post twice. Across Castcade runs the guard is `posted-games.json` (B17).
   */
  liveRead: Set<string>;
  /** Basic mode on a table the import could patch (or not): the sentence Status shows under "Capture". */
  unpatchedNote: string | null;
  /** F5 (B5.2): the script that ran against the table's embedded one, read at launch; null when not inspected. */
  scriptDiff: ScriptDiffReport | null;
  /** B18: the journals were searched for this player-up's table (once per player-up, reset when it goes down). */
  journalLooked: boolean;
  /** B18: the table file the journal's manifest named, while `launch.tablePath` still holds it. */
  journalPath: string | null;
}

type CaptureTrigger = 'player' | 'exit';

type PublishDecision =
  | { kind: 'skip'; players: number; score: number | null; detail: string }
  /** `gameOver` false = the player quit mid-game (B16), sent as `quit=1` with `quit_ball` when `ball` is known. */
  | { kind: 'score'; players: number; score: number; reason: string; gameOver: boolean | null; ball?: number | null; detail?: string };

/** B16: whether the game was quit before game over, and on which ball; nothing when unknown. */
export function quitWire(decision: { gameOver: boolean | null; ball?: number | null }): { quit?: boolean; quit_ball?: number } {
  if (decision.gameOver === null) return {};
  if (decision.gameOver) return { quit: false };
  const ball = decision.ball ?? null;
  return ball !== null && Number.isInteger(ball) && ball >= 1 && ball <= 10 ? { quit: true, quit_ball: ball } : { quit: true };
}

/** The sidecar's block 0 calls this; its presence in the first bytes of `<Table>.vbs` marks the file as ours. */
const SIDECAR_MARKER = 'Castcade_Init';
/** A `table_loaded` whose session stamp predates the VPX process by more than this is an earlier session's residue. */
const SESSION_STAMP_SLACK_MS = 15 * 60_000;

export { parseSessionStamp };

/** `a` is an older dotted version than `b` ("0.3.0" before "0.3.1"); false when either does not parse. */
export function versionOlder(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.some((n) => !Number.isInteger(n)) || pb.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** B15: what Status and the balloon say when a table started on an older Castcade patch than this build makes. */
/** C10: what the player is told when the VPX editor saved Castcade's patch into the table's own script. */
export function embeddedPatchNote(table: string): string {
  return `${table}'s own script carries Castcade's patch: the VPX editor saved it into the table. Games still post. Castcade is putting a fresh patch beside the table now; it loads the next time you open the table.`;
}

export function oldPatchNote(table: string, ran: string): string {
  return `${table} started with an older Castcade patch (recipe ${ran}; this build makes ${RECIPE_VERSION}), made before Castcade updated. Close the table and open it again so every game posts live.`;
}

/** B12: what Status says on a machine whose live score the hook cannot see (patched or not). */
export function unreadableNote(table: string, reason: string): string {
  return `${table}: this machine's live score can't be read yet (${reason}). At most the last game of this session posts, when the table closes.`;
}

/** Live mode for one session: the hook's journal followed and decoded while the table is open. */
interface LiveSession {
  tail: JournalTail;
  detector: JournalDetector;
  tableId: string;
  path: string;
  /** Lines waiting for the pump (fed to the detector inside the serial chain). */
  lines: string[];
  pumpScheduled: boolean;
  /** The current `table_loaded` belongs to this VPX process (not an earlier session in the same file). */
  accepted: boolean;
  recipe: string | null;
  rom: string | null;
  /** When the hook initialised, from its session stamp; journal `t` values are seconds after this. */
  loadedAtMs: number | null;
  lastGameStartMs: number | null;
  games: number;
  /** Games posted from the journal; when > 0 the `.nv` capture at close is suppressed (it would repeat the last one). */
  captures: number;
  /** The import manifest for this table (pins the `.vpx` hash the sidecar was rendered for), when found. */
  manifest: Manifest | null;
  /** The hook's session stamp from `table_loaded` (half of every attempt key). */
  sessionStamp: string | null;
  /** The game in progress on a limited-attempts board (ADR 0029): set at game start, cleared at capture. */
  attempt: AttemptStatus | null;
  /** B17: the game in progress as `posted-games.json` keys it; set at game start, recorded and cleared at capture. */
  gameKey: string | null;
  /** B17: the game in progress was posted by an earlier Castcade run (a restart replayed it); its events are ignored to its end. */
  skipGame: boolean;
  /** The last `engine` sample the hook wrote (hook 0.4.0), whatever the game state. */
  engineLast: EngineSample | null;
  /** The samples that belong to the game in progress: the one in force at its start, then every change. */
  engineGame: EngineSample[];
  /** B6.1: player 1's score moves in the game in progress (flag only, never a gate). */
  scoreTrack: ScoreTrack;
  /**
   * B12: why live mode cannot read this ROM's machine (`liveSupport`), set when the hook names the ROM; null
   * when it can. The journal is still followed, but Status says what really happens: at most one score at close.
   */
  unreadable: string | null;
  /**
   * B15: the Status line when the table loaded a patch older than this build renders (`recipe_version` in
   * `table_loaded`), e.g. one opened while the sidecar watch was still re-making patches after an update. Null when current.
   */
  oldPatchNote: string | null;
}

/** Where the patcher keeps import manifests: beside the witness module's own files. The shell uses the same rule. */
export function manifestDirFor(dataDir: string): string {
  return joinPath(dataDir, 'tables');
}

const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);

function joinPath(dir: string, name: string): string {
  const sepChar = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sepChar + name;
}

/** Map ArcAid's wire `status` for a score to the module's outcome vocabulary. */
export function outcomeForWire(
  status: string | null,
  wire: { reasons?: string[]; fallback?: string | null; notCounted?: string | null } = {},
): { outcome: CaptureOutcome; detail?: string } {
  // B20: ArcAid says why a play counted in no tournament ("no open game matched …", "played before … went
  // up in …", "your device is set to send to …"); shown so the player need not ask.
  const why = wire.notCounted?.trim() ? `: ${wire.notCounted.trim()}` : '';
  switch (status) {
    case null:
    case 'ingested':
    case 'global':
      return { outcome: 'ingested', ...(status === 'global' ? { detail: `recorded on the Global Scoreboard${why ? `; not counted for a board${why}` : ''}` } : {}) };
    case 'duplicate':
    case 'global_duplicate':
      return { outcome: 'duplicate' };
    case 'no_match':
      return { outcome: 'skipped', detail: `ArcAid: no open game or catalogue entry matched this table${why}` };
    case 'invalid':
      return { outcome: 'rejected', detail: 'ArcAid: invalid score' };
    case 'not_sanctioned': {
      // ArcAid 2.165.0 (item 11): the tournament held the score out. A Sanctioned rule failed, or (the
      // same wire status, ADR 0029) the attempt was refused: "no game start was reported for this score",
      // "reported late". The reasons are the server's own words; the play still reached the Global
      // Scoreboard when `fallback` says so. Shown on the Status page so the player knows what to change.
      const reasons = (wire.reasons ?? []).filter((r) => r.trim().length > 0);
      const held = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
      const went = wire.fallback === 'global' ? '; recorded on the Global Scoreboard instead'
        : wire.fallback === 'global_duplicate' ? '; already on the Global Scoreboard' : '';
      return { outcome: 'rejected', detail: `ArcAid: not counted for the tournament${held}${went}` };
    }
    default:
      return { outcome: 'rejected', detail: `ArcAid: ${status}` };
  }
}

/**
 * B21: ArcAid's `ATTEMPT_REFUSAL_TEXT.not_started` ("you have not pressed Start attempts for this table on Arcaid yet —
 * this play used no attempt"), answered as `no_match` on the attempt call (W38). Matched on its opening words so a
 * change of punctuation after the dash does not lose the state.
 */
export function isNotStartedReason(reason: string | null | undefined): boolean {
  return !!reason && reason.trim().toLowerCase().startsWith('you have not pressed start attempts');
}

/** B21: what Status says on a game start that used no attempt because Start attempts was not pressed. */
export const NEEDS_START_TEXT = 'This table needs Start attempts: press the button on Status, then start a new game.';

/** B21: the one line Status shows under the Start attempts button for ArcAid's answer to a press. */
export function attemptStartText(answer: AttemptStartAnswer): string {
  if (answer.status === 'started') {
    const names = answer.started.map((r) => r.game).filter((g) => g.trim() !== '');
    const again = answer.started.length > 0 && answer.started.every((r) => r.alreadyStarted) ? ' (already started)' : '';
    return `Start attempts pressed for ${names.length > 0 ? names.join(', ') : 'this device'}${again}`;
  }
  return answer.reason ?? `ArcAid answered "${answer.status ?? 'nothing'}" to Start attempts`;
}

/** What the player is told about a game start on a limited-attempts board (ADR 0029, "Castcade's half", item 2). */
export function attemptStatusFor(key: string, posted: PostResult): AttemptStatus {
  const base = { key, n: null, of: null, remaining: null, late: false, game: null, needsStart: false };
  if (posted.state === 'queued') return { ...base, state: 'queued', text: 'offline: this attempt will not count' };
  if (posted.state === 'rejected') return { ...base, state: 'rejected', text: `ArcAid refused the attempt: ${posted.error.message}` };
  const a = posted.attempt ?? null;
  const late = a?.late ?? false;
  const lateText = late ? ' (reported late: this score will not count)' : '';
  switch (a?.status) {
    case 'counted':
      return { ...base, state: 'counted', n: a.attempt, of: a.of, remaining: a.remaining, late, game: a.game, text: `Attempt ${a.attempt ?? '?'} of ${a.of ?? '?'}${lateText}` };
    case 'over_limit':
      return { ...base, state: 'over_limit', n: a.attempt, of: a.of, remaining: 0, late, game: a.game, text: 'No attempts left: this score will not count' };
    case 'unlimited':
      return { ...base, state: 'unlimited', game: a.game, text: '' };
    case 'no_match':
      if (isNotStartedReason(a.reason)) return { ...base, state: 'no_match', game: a.game, needsStart: true, text: NEEDS_START_TEXT };
      return { ...base, state: 'no_match', text: '' };
    default:
      return { ...base, state: 'rejected', text: `ArcAid answered "${a?.status ?? 'nothing'}" to the attempt` };
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

/** The table name and second name key a game start sends; the B21 press sends the same so it lands on the same games. */
function wireTableNames(launch: Pick<VpxLaunch, 'table' | 'tableSource'>, romName: string | null, rom: string | null): { table: string; slug: string | null } | null {
  const resolved = resolveTableName(launch, romName, rom);
  if (!resolved) return null;
  const table = catalogueTableName(resolved.table);
  return { table, slug: romName && catalogueTableName(romName) !== table ? catalogueTableName(romName) : null };
}

const SOURCE_TEXT: Record<TableSource, string> = {
  play: 'table from -Play',
  arg: 'table from the command line',
  title: 'table from the editor window title',
  romname: 'table name derived from the ROM (romnames.json)',
  rom: 'table name is the ROM id (no better name known)',
  journal: "table from the hook's journal",
};

export function createWitness(store: WitnessSettingsStore, deps: WitnessDeps = {}): Witness {
  const clock = deps.clock ?? realClock;
  const fs = deps.fs ?? nodeFs;
  const registry = deps.registry ?? createRegQueryReader();
  const lister = deps.lister ?? createPowershellLister();
  const vrProbe: VrProbe = deps.vrProbe === undefined ? createPowershellVrProbe() : (deps.vrProbe ?? NO_VR_PROBE);
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
    captureMode: null,
    attempt: null,
    attemptStart: null,
  };

  const sessions = new Map<number, OpenSession>();
  const identityStore = createIdentityStore(fs, store.get().dataDir, () => clock.now());
  const postedGames = createPostedGames(fs, store.get().dataDir, () => clock.now());
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
      client = new ArcaidClient({ baseUrl: base, fetch: deps.fetch, timeoutMs: deps.requestTimeoutMs, log });
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
    const following = !!active?.live && active.live.unreadable === null;
    status.captureMode = active ? (following ? 'live' : 'basic') : null;
    status.attempt = active?.live?.attempt ?? null;
    status.note = sessions.size > 0 && !status.currentTable ? 'VPX is open; no table known yet' : active && !following ? active.unpatchedNote : (active?.live?.oldPatchNote ?? null);
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
    // Headset or monitor: VR is initialised before the table loads, so the first sample (table
    // known) already says; the capture-time sample refreshes it while the process is still there.
    const vr = await vrProbe.sample(launch.pid).catch((err: unknown) => {
      notes.push(`vr: ${errText(err)}`);
      return null;
    });
    return {
      measuredAt: iso(clock.now()),
      ini,
      build,
      vr: vr ?? session.attestation?.vr ?? null,
      adjustments: session.attestation?.adjustments ?? null,
      vpmCheat: session.attestation?.vpmCheat ?? null,
      iniChanged: false,
      engine: null,
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
    if (session.live && (!path || tableBaseName(path) !== session.live.tableId)) await switchTable(session);
    if (path) await startLive(session, path);
    if (path && !session.live) await noticeUnpatched(session, path);
    if (path) await inspectScript(session, path);
    const identity = await resolver.fromFile(path, path ? tableBaseName(path) : launch.table);
    session.identity = identity;
    session.identityRom = null; // B19: a fresh file identity; the next `table_loaded` or start report pins it again
    if (identity.vpsGame) log(`witness: identity ${identity.vpsGame.name} (${identity.vpsGame.id}) / ${identity.vpsTable ? `${identity.vpsTable.label} (${identity.vpsTable.id}, ${identity.tableConfidence})` : `table ${identity.tableConfidence}`}`);
    else log(`witness: identity unresolved for ${target}: ${identity.notes.join('; ')}`);
    session.attestation = await measureAttestation(session);
    if (session.attestation.ini) log(`witness: settings ${describeIni(session.attestation.ini)}`);
    refreshTableStatus();
    emitStatus();
    if (path && !(identity.sha256 && identity.fingerprint)) {
      session.hashing = resolver
        .hash(identity)
        .then((hashed) => {
          if (session.identity && session.identity.filePath === hashed.filePath) {
            if (hashed.fingerprint && hashed.fingerprint !== session.identity.fingerprint) log(`witness: playfield ${hashed.fingerprint} for ${hashed.filePath}`);
            session.identity = {
              ...session.identity,
              sha256: hashed.sha256,
              fingerprint: hashed.fingerprint,
              notes: hashed.sha256 && hashed.fingerprint ? session.identity.notes : hashed.notes,
            };
            refreshTableStatus();
            emitStatus();
            void checkLiveHash(session, hashed.filePath, hashed.sha256);
          }
        })
        .finally(() => {
          session.hashing = null;
        });
    }
  };

  /** The identity a capture posts: the session's, upgraded by the ROM, with the hash if it is in time. */
  /**
   * B19: pin the session's identity to the ROM's game as soon as the ROM is known (the journal's
   * `table_loaded`), so the game-start report carries the same `vps_game` the score will. Resolved from
   * the file alone, "Tron Legacy (Stern 2011) VPW Mod v1.1" read as the 2016 original "TRON Legacy" and
   * ArcAid matched the start to nothing: the score then landed as `unreported` and used an attempt
   * (Krobs, 2026-10-29). The capture path re-pins anyway (`identityForCapture`); this is the early copy.
   */
  const pinIdentityByRom = async (session: OpenSession, rom: string | null): Promise<void> => {
    if (!rom || session.identityRom === rom) return;
    const before = session.identity;
    if (!before) return;
    const romName = await corpus.romName(rom);
    const pinned = await resolver.withRom(before, rom, romName);
    if (session.identity !== before) return; // the background hash landed meanwhile; the next call pins again
    session.identity = pinned;
    session.identityRom = rom;
    const was = before.vpsGame?.id ?? null;
    if (pinned.vpsGame && pinned.vpsGame.id !== was) {
      log(`witness: identity pinned by ROM ${rom}: ${pinned.vpsGame.name} (${pinned.vpsGame.id})${was ? `, was ${was}` : ', was unresolved'}`);
    }
  };

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

  /** Close the session in ArcAid (report with `exit`) without a score: live mode's end of session. */
  const closeReport = async (session: OpenSession, ended: number): Promise<void> => {
    const { deviceId, token } = store.get();
    const key = sessionKey(session);
    if (!token || !key) return;
    const reported = await queue.submit({
      kind: 'report',
      params: { device: deviceId, table: key.table, launch: key.launch, exit: sec(ended), dur: Math.max(0, Math.round((ended - key.launch * 1000) / 1000)) },
    });
    if (reported.state === 'rejected') fail(reported.error.message);
  };

  // ------------------------------------------------------------------------------ capture --

  /**
   * The one posting path for both modes: resolve identity and attestation, name the table for
   * ArcAid, send the player-session report (basic mode) and the score, record the outcome. A
   * `live` game leaves the player-session bookkeeping alone (`lastCaptureAt`, the nvram baseline,
   * the report): live mode reports the VPX session once when it opens and once at exit.
   */
  const publish = async (p: {
    session: OpenSession;
    rom: string | null;
    map: CompiledMap | null;
    /** The bytes the score came from: the `.nv` (basic) or the journal's shadow NVRAM (live). */
    nvBytes: Uint8Array | null;
    started: number;
    ended: number;
    decision: PublishDecision;
    details: string[];
    live: boolean;
    /** The key of this game's attempt call (live mode on a limited board); the score repeats it. */
    attemptKey?: string | null;
    /** F6: the engine values in force during this game, from the hook (live mode, hook 0.4.0). */
    engine?: EngineAttestation | null;
    /** B6.1: how the score moved during this game (live mode); a flag, never a gate. */
    plausibility?: ScorePlausibility | null;
  }): Promise<void> => {
    const { session, rom, map, nvBytes, started, ended, decision, details, live } = p;
    const { deviceId, token } = store.get();
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
    const engine = p.engine ?? null;
    const attestation: Attestation = { ...measured, adjustments, vpmCheat, iniChanged, engine };
    session.attestation = attestation;
    if (attestation.ini) details.push(describeIni(attestation.ini));
    if (iniChanged) details.push('settings changed during the session');
    if (live) details.push(describeEngine(engine));
    if (live) details.push(describeScorePlausibility(p.plausibility ?? null));
    if (rom) details.push(describeAdjustments(adjustments));
    details.push(describeBuild(attestation.build, vpmCheat));
    if (attestation.vr) details.push(describeVr(attestation.vr));
    if (session.scriptDiff) details.push(describeScriptDiff(session.scriptDiff));

    const resolved = resolveTableName(session.launch, romName, rom);
    const table = resolved?.table ?? UNKNOWN_TABLE;
    // What ArcAid sees: the catalogue-grade name, plus the ROM's own name as the `slug` fallback key.
    const wireTable = resolved ? catalogueTableName(resolved.table) : UNKNOWN_TABLE;
    const wireSlug = romName && catalogueTableName(romName) !== wireTable ? catalogueTableName(romName) : null;
    if (resolved) details.push(SOURCE_TEXT[resolved.source]);
    if (wireTable !== table) details.push(`sent to ArcAid as "${wireTable}"${wireSlug ? ` (or "${wireSlug}")` : ''}`);

    const durationSec = Math.max(0, Math.round((ended - started) / 1000));
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
      mode: live ? 'live' : 'basic',
    };

    if (!live && token && resolved) {
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
          ...quitWire(decision),
          vps_game: identity?.vpsGame?.id ?? null,
          vps_table: identity?.vpsTable?.id ?? null,
          table_sha256: identity?.sha256 ?? null,
          ...(identity?.fingerprint ? { fingerprint: identity.fingerprint } : {}),
          ...(scriptDiffWire(session.scriptDiff) ? { script_diff: scriptDiffWire(session.scriptDiff) } : {}),
          table_save_rev: identity?.saveRev ?? null,
          ini: iniWire(attestation.ini),
          adjustments: adjustmentsWire(adjustments),
          build: buildWire(attestation.build, vpmCheat),
          // 0.2.10: headset or monitor, when sampled. ArcAid 2.166.0 puts it on the device axis.
          ...(playDeviceFor(attestation.vr) ? { play_device: playDeviceFor(attestation.vr)! } : {}),
          ...(p.attemptKey ? { attempt: p.attemptKey } : {}),
          ...(engineWire(engine) ? { engine: engineWire(engine) } : {}),
          ...(scorePlausibilityWire(p.plausibility ?? null) ? { score_plausibility: scorePlausibilityWire(p.plausibility ?? null) } : {}),
        },
      });
      const mapped = outcomeForPost(posted);
      result.outcome = mapped.outcome;
      if (posted.state === 'done' && posted.wire?.attempt) {
        result.attempt = posted.wire.attempt;
        details.push(`attempt ${posted.wire.attempt.n} of ${posted.wire.attempt.of}`);
      }
      for (const d of [decision.detail, mapped.detail]) if (d) details.unshift(d);
      if (posted.state === 'queued') {
        const last = queue.pending()[queue.size() - 1];
        if (last) queuedCaptures.set(last.id, result);
      }
      if (posted.state === 'rejected' && posted.error.kind === 'auth') fail(posted.error.message);
    }

    result.detail = details.join('; ');
    if (!live) {
      session.lastCaptureAt = ended;
      await refreshBaseline();
    }
    session.captures++;
    status.lastCapture = result;
    log(`witness: ${table} → ${result.outcome} (${result.detail})`);
    emitter.emit('capture', result);
    emitStatus();
  };

  /**
   * Basic mode's capture: `changed` are the `.nv` names that differ from the baseline (newest
   * first), `after` the snapshot they were seen in. Decides from the file, then publishes.
   */
  const capture = async (session: OpenSession, changed: string[], after: NvSnapshot, trigger: CaptureTrigger, endedFallback: number): Promise<void> => {
    const nvramDir = status.nvramDir;
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
    details.push(trigger === 'player' ? 'captured when the player closed' : 'captured at VPX exit');
    const decision = decideCapture({ table: session.launch.table ?? UNKNOWN_TABLE, rom, map, before, after: afterState, launchedAtMs: started, exitedAtMs: ended });
    await publish({ session, rom, map, nvBytes, started, ended, decision, details, live: false });
  };

  // ---------------------------------------------------------------------------- live mode --

  /** Where the hook writes journals; null disables live mode (no `%LOCALAPPDATA%`, or a test that says so). */
  const journalRoot: string | null = deps.journalDir === undefined ? (env.LOCALAPPDATA ? journalDir(env.LOCALAPPDATA) : null) : deps.journalDir;
  const manifestDir = manifestDirFor(store.get().dataDir);

  /**
   * Layer 2 of the stale-sidecar guard: the table file's hash landed (identity resolution); when
   * the manifest pinned a different file, the sidecar is for another version — disable it and say so.
   */
  const checkLiveHash = async (session: OpenSession, vpxPath: string | null, sha256: string | null): Promise<void> => {
    const live = session.live;
    if (!live || !vpxPath || !sha256 || !live.manifest?.vpxSha256 || live.manifest.vpxSha256 === sha256) return;
    // The manifest must be this table's: another table loaded in the same VPX process has its own (2026-10-26:
    // Walking Dead's hash against AC/DC's manifest disabled a good sidecar).
    if (tableBaseName(vpxPath) !== live.tableId) return;
    try {
      const stale = await disableSidecar(fs, vpxPath);
      fail(`Castcade patch for ${live.tableId} was made for another version of this table; disabled (${stale}) — re-import it from Castcade`);
    } catch (err) {
      log(`witness: could not disable the stale sidecar of ${live.tableId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** A table runs the hook when `<Table>.vbs` sits beside its `.vpx` and carries the sidecar's marker. */
  /** C10: the table's own script carries Castcade's marker (a sidecar the VPX editor saved back into the `.vpx`). */
  const hasEmbeddedPatch = async (vpxPath: string): Promise<boolean> => {
    try {
      const script = await readVpxScript(fs, vpxPath);
      return script !== null && isOurSidecar(decodeScript(script.bytes));
    } catch {
      return false;
    }
  };

  const hasSidecar = async (vpxPath: string): Promise<boolean> => {
    const sidecar = vpxPath.replace(/\.vpx$/i, '.vbs');
    if (sidecar === vpxPath) return false;
    // The whole file, not a head: block 0 goes after the table's own opening comments, and a long banner put
    // the marker past the old 8 KB head (AC/DC at byte 10,866; 8 of the owner's 102 tables), so those tables
    // were judged unpatched and never armed live mode (2026-10-26). A sidecar is a few hundred KB.
    try {
      return Buffer.from(await fs.readFile(sidecar)).toString('latin1').includes(SIDECAR_MARKER);
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  };

  /**
   * Arm live mode for a session whose table file has a sidecar: tail the hook's journal for that
   * table id from its first byte (the hook may have written `table_loaded` before the process watch
   * saw the launch) and feed the detector. Lines are pumped through the serial chain so a ROM's map
   * is attached before the deltas that follow its `table_loaded` are decoded.
   */
  /**
   * A table opened in basic mode (0.2.12): tell the player once per table per run that only the last
   * game will post, and whether the import would fix it (the script classifies as recipe A).
   */
  const noticedUnpatched = new Set<string>();
  /** B15: one balloon per table load that ran an older patch (`<tableId>@<session stamp>`). */
  const noticedOldPatch = new Set<string>();
  /** C10: one balloon per table per run for a patch the VPX editor saved into the table itself. */
  const noticedEmbeddedPatch = new Set<string>();
  const noticeEmbeddedPatch = (vpxPath: string): void => {
    if (noticedEmbeddedPatch.has(vpxPath)) return;
    noticedEmbeddedPatch.add(vpxPath);
    const table = tableBaseName(vpxPath);
    const message = embeddedPatchNote(table);
    log(`witness: ${message}`);
    emitter.emit('notice', { kind: 'embedded_patch', table, vpxPath, title: 'Castcade: patch saved into the table', message });
  };
  /**
   * F5 (B5.2): which script ran and how it differs from the table's own. VPX 10.8 runs a same-basename sidecar
   * instead of the embedded script; Castcade's own sidecar is undone exactly (`unpatchRecipeA`) so only a person's
   * edits remain. Flag only: the report rides on the score, nothing here refuses a capture.
   */
  const inspectScript = async (session: OpenSession, vpxPath: string): Promise<void> => {
    try {
      const script = await readVpxScript(fs, vpxPath);
      if (!script) return;
      const embeddedText = decodeScript(script.bytes);
      // C10: the table's own script can be Castcade's patch itself (the VPX editor saved a sidecar into the .vpx):
      // the baseline is the script underneath, and with no sidecar beside the table that patch is what ran.
      const underneath = isOurSidecar(embeddedText) ? unpatchRecipeA(embeddedText) : null;
      const embedded = underneath ?? embeddedText;
      let sidecar: string | null = null;
      try {
        sidecar = decodeScript(await fs.readFile(sidecarPathFor(vpxPath)));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      let report: ScriptDiffReport;
      if (sidecar === null) report = scriptDiffReport(embedded, embedded, { ran: underneath !== null ? 'castcade' : 'embedded', baseline: 'embedded' });
      else if (isOurSidecar(sidecar)) {
        const own = unpatchRecipeA(sidecar);
        const r = scriptDiffReport(embedded, own ?? sidecar, { ran: 'castcade', baseline: 'embedded' });
        report = r.hunks.length > 0 || r.truncated || own === null ? { ...r, ran: 'castcade_edited' } : r;
      } else report = scriptDiffReport(embedded, sidecar, { ran: 'foreign', baseline: 'embedded' });
      session.scriptDiff = report;
      if (report.ran !== 'embedded' && report.ran !== 'castcade') log(`witness: ${describeScriptDiff(report)} on ${tableBaseName(vpxPath)}`);
    } catch (err) {
      log(`witness: script inspection failed for ${tableBaseName(vpxPath)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const noticeUnpatched = async (session: OpenSession, vpxPath: string): Promise<void> => {
    const table = tableBaseName(vpxPath);
    const cls = await readVpxScript(fs, vpxPath)
      .then((script) => (script !== null ? classifyScript(decodeScript(script.bytes)) : null))
      .catch(() => null);
    // B12: the import will not patch a machine whose live score the hook cannot see, so do not send the player there.
    const rom = cls?.cls === 'A' ? cls.facts.rom ?? null : null;
    const support = rom ? liveSupport(await corpus.mapFor(rom).catch(() => null)) : null;
    const patchable = cls?.cls === 'A' && (support === null || support.readable);
    // An original (no ROM) leaves no NVRAM, so basic mode posts nothing at all for it: say so (TNA, rig 2026-10-28).
    // Classes B–E only: X (unclassified, e.g. no _KeyDown) says nothing about a ROM.
    const original = cls !== null && ['B', 'C', 'D', 'E'].includes(cls.cls);
    const message = patchable
      ? `${table} is not patched: only the last game of this session will post. Settings → Import tables → Patch my tables, then relaunch the table.`
      : support && !support.readable
        ? unreadableNote(table, support.reason)
        : original
          ? `${table} is an original table (no ROM). Castcade can't read an original's score yet, so games on it won't post.`
          : `${table} has no Castcade patch and its script type has no recipe yet: only the last game of this session will post.`;
    session.unpatchedNote = message;
    refreshTableStatus();
    if (noticedUnpatched.has(vpxPath)) return;
    noticedUnpatched.add(vpxPath);
    emitter.emit('notice', { kind: 'unpatched', table, patchable, title: patchable ? 'Castcade: table not patched' : original ? 'Castcade: score not read' : 'Castcade: basic mode', message });
  };

  const startLive = async (session: OpenSession, vpxPath: string): Promise<void> => {
    if (session.live || !journalRoot) return;
    if (!(await hasSidecar(vpxPath).catch(() => false))) {
      // C10: no sidecar, but the table's own script is Castcade's patch (the VPX editor saved it there): it journals
      // like a sidecar, so live mode arms; the player is told once and the shell renders a fresh sidecar over it.
      if (!(await hasEmbeddedPatch(vpxPath))) return;
      noticeEmbeddedPatch(vpxPath);
    }
    const tableId = tableBaseName(vpxPath);
    const path = joinPath(journalRoot, journalFileName(tableId));
    const manifest = await readManifest(fs, manifestPathFor(manifestDir, tableId)).catch(() => null);
    const live: LiveSession = {
      tail: new JournalTail(path, { fs, clock, pollMs: deps.journalPollMs, from: 'start' }),
      detector: new JournalDetector(),
      tableId,
      path,
      lines: [],
      pumpScheduled: false,
      accepted: false,
      recipe: null,
      rom: null,
      loadedAtMs: null,
      lastGameStartMs: null,
      games: 0,
      captures: 0,
      manifest,
      sessionStamp: null,
      attempt: null,
      gameKey: null,
      skipGame: false,
      engineLast: null,
      engineGame: [],
      scoreTrack: new ScoreTrack(),
      unreadable: null,
      oldPatchNote: null,
    };
    session.live = live;
    live.tail.on('line', (line) => {
      live.lines.push(line);
      if (!live.pumpScheduled) {
        live.pumpScheduled = true;
        serial(() => pumpLive(session, live));
      }
    });
    live.tail.on('truncated', () => log(`witness: journal ${live.tableId} restarted from the top`));
    live.tail.on('error', (err) => fail(`journal ${live.tableId}: ${err.message}`));
    live.tail.start();
    log(`witness: live mode armed for ${tableId} (${path})`);
    refreshTableStatus();
    emitStatus();
  };

  /**
   * The editor loaded another table in the same VPX process: finish the old table's journal and let the
   * new one arm its own. The old table's games were posted live, so its close-time `.nv` write is folded
   * into the baseline rather than captured again under the new table's name.
   */
  const switchTable = async (session: OpenSession): Promise<void> => {
    const old = session.live;
    if (!old) return;
    await stopLive(session);
    session.live = null;
    session.unpatchedNote = null;
    session.scriptDiff = null;
    log(`witness: ${old.tableId}: another table loaded in the same VPX process; stopped following its journal`);
    if (old.captures > 0) {
      pending = null;
      await refreshBaseline();
    }
  };

  /**
   * B18: Castcade started while the player window was already up, whose title names no table (`launch null`
   * until play ended: no live mode, no overlay, games posted only at close; rig 2026-10-30T03:49Z). The table
   * in play is the one whose journal has a `table_loaded` inside this process's lifetime; its import manifest
   * gives the `.vpx`, so identity and live mode then arm as for `-Play`. Never throws.
   */
  const tableFromJournal = async (session: OpenSession): Promise<void> => {
    const { launch } = session;
    if (launch.table !== null || journalRoot === null) return;
    session.journalLooked = true;
    try {
      // The same rule as `onJournalEvent` uses to accept a `table_loaded` as this process's.
      const slack = launch.startedAt !== null ? 90_000 : SESSION_STAMP_SLACK_MS;
      const c = await newestJournalSince(fs, journalRoot, session.startedAt - slack);
      if (!c) {
        log(`witness: pid ${launch.pid}: the player is up with no table name and no journal of this process; waiting for play to end`);
        return;
      }
      const manifest = await readManifest(fs, manifestPathFor(manifestDir, c.tableId)).catch(() => null);
      const tablePath = manifest?.vpxPath ?? null;
      const table = tablePath ? tableBaseName(tablePath) : (c.table ?? c.tableId);
      // In place, not a copy: the watch keeps this object and updates it from later titles (an editor title
      // naming a table still wins over the journal), and its exit event hands the same object back.
      launch.table = table;
      launch.tablePath = tablePath;
      launch.tableSource = 'journal';
      session.journalPath = tablePath;
      log(`witness: pid ${launch.pid}: table ${table} from the hook's journal (${c.path}, session ${c.sessionStamp ?? '?'})`);
    } catch (err) {
      fail(`pid ${launch.pid}: could not read the hook's journals: ${errText(err)}`);
    }
  };

  /** D1.1: the game on screen for the OBS overlay; announced only when it changes. */
  let liveGame: LiveGame | null = null;
  const setGame = (next: LiveGame | null): void => {
    if (JSON.stringify(next) === JSON.stringify(liveGame)) return;
    liveGame = next;
    emitter.emit('game', next);
  };

  const pumpLive = async (session: OpenSession, live: LiveSession): Promise<void> => {
    live.pumpScheduled = false;
    while (live.lines.length > 0) {
      const line = live.lines.shift()!;
      for (const ev of live.detector.feed(line)) await onJournalEvent(session, live, ev);
    }
  };

  const onJournalEvent = async (session: OpenSession, live: LiveSession, ev: JournalEvent): Promise<void> => {
    if (ev.kind === 'table_loaded') {
      // The file holds every session of this table; only the one that belongs to this VPX process counts.
      const stampMs = parseSessionStamp(ev.session);
      // With the real process creation time (CIM) a session stamp more than 90 s older than the
      // process is an earlier session's; without it, allow for a long poll gap.
      const slack = session.launch.startedAt !== null ? 90_000 : SESSION_STAMP_SLACK_MS;
      live.accepted = stampMs === null || stampMs >= session.startedAt - slack;
      if (!live.accepted) {
        log(`witness: journal ${live.tableId}: skipping an earlier session (${ev.session ?? '?'})`);
        return;
      }
      const readKey = ev.session ? `${live.tableId}@${ev.session}` : null;
      if (readKey && session.liveRead.has(readKey)) {
        live.accepted = false;
        log(`witness: journal ${live.tableId}: session ${ev.session} already read in this VPX process`);
        return;
      }
      if (readKey) session.liveRead.add(readKey);
      live.loadedAtMs = stampMs ?? clock.now() - ev.t * 1000;
      live.lastGameStartMs = null;
      live.sessionStamp = ev.session ?? null;
      live.attempt = null;
      live.gameKey = null;
      live.skipGame = false;
      live.engineLast = null;
      live.engineGame = [];
      live.scoreTrack = new ScoreTrack(ev.recipe === 'A' ? ROM_SCORE_STEP : null);
      live.recipe = ev.recipe;
      live.rom = ev.rom;
      log(`witness: live mode: ${ev.table ?? live.tableId} loaded (recipe ${ev.recipe ?? '?'}, rom ${ev.rom ?? '-'}, hook ${ev.lib ?? '?'})`);
      await pinIdentityByRom(session, ev.rom);
      // B15: the patch VPX loaded predates this build (the re-make after an update had not reached it yet).
      const ran = ev.recipe === 'A' ? ev.recipeVersion : null;
      live.oldPatchNote = ran && versionOlder(ran, RECIPE_VERSION) ? oldPatchNote(live.tableId, ran) : null;
      if (live.oldPatchNote) {
        log(`witness: ${live.tableId}: loaded with recipe ${ran}, older than this build's ${RECIPE_VERSION}; asking the player to reopen it`);
        const key = `${live.tableId}@${ev.session ?? ''}`;
        if (!noticedOldPatch.has(key)) {
          noticedOldPatch.add(key);
          emitter.emit('notice', { kind: 'old_patch', table: live.tableId, title: 'Castcade: reopen this table', message: live.oldPatchNote });
        }
      }
      if (ev.recipe === 'A' && ev.rom) {
        const map = await corpus.mapFor(ev.rom);
        live.detector.setMap(map);
        if (!map) fail(`live mode: no map for ROM ${ev.rom}; games on ${live.tableId} will be captured at close only`);
        const support = liveSupport(map);
        live.unreadable = support.readable ? null : support.reason;
        if (!support.readable) {
          session.unpatchedNote = unreadableNote(live.tableId, support.reason);
          log(`witness: ${live.tableId}: live score can't be read on this machine (ROM ${ev.rom}, ${support.reason}); at most one score posts, at close`);
        }
      }
      setGame({ table: live.tableId, inGame: false, scores: [], player: null, ball: null });
      refreshTableStatus();
      emitStatus();
      return;
    }
    if (!live.accepted) return;
    const at = (live.loadedAtMs ?? clock.now()) + ev.t * 1000;
    if (live.skipGame) {
      // B17: a game an earlier run posted, replayed after a restart. Follow it to its end and post nothing;
      // only the engine values carry over (the next game's `atStart` needs them).
      switch (ev.kind) {
        case 'current_scores':
          return;
        case 'engine':
          live.engineLast = ev.sample;
          return;
        case 'game_end':
        case 'game_abandoned':
          live.skipGame = false;
          live.gameKey = null;
          // It went out from the journal (in the earlier run), so the `.nv` rewrite at close must not post it again.
          live.captures++;
          return;
        default:
          break;
      }
    }
    switch (ev.kind) {
      case 'game_start':
        live.gameKey = postedGameKey(live.tableId, attemptKey(live.sessionStamp, live.loadedAtMs, ev.t));
        if (postedGames.has(live.gameKey)) {
          live.skipGame = true;
          log(`witness: journal ${live.tableId}: game ${live.gameKey} was posted by an earlier run; not posting it again`);
          break;
        }
        live.lastGameStartMs = at;
        live.games++;
        session.lastActivityAt = clock.now();
        live.engineGame = live.engineLast ? [{ ...live.engineLast, t: ev.t }] : [];
        live.scoreTrack.reset();
        setGame({ table: live.tableId, inGame: true, scores: [], player: null, ball: null });
        await reportAttempt(session, live, ev.players ?? null, at, ev.t);
        break;
      case 'current_scores':
        if (live.lastGameStartMs !== null) live.scoreTrack.add(ev.scores[0] ?? null, ev.t, ev.ball);
        if (liveGame?.table === live.tableId && liveGame.inGame) {
          setGame({ ...liveGame, scores: ev.scores, player: ev.player !== null && ev.player >= 1 ? ev.player : null, ball: ev.ball !== null && ev.ball >= 1 ? ev.ball : null });
        }
        break;
      case 'engine':
        live.engineLast = ev.sample;
        if (live.lastGameStartMs !== null) live.engineGame.push(ev.sample);
        if (ev.sample.reason === 'init') log(`witness: ${describeEngine({ atStart: ev.sample, changes: [] })} on ${live.tableId}`);
        break;
      case 'game_end':
        setGame({ table: live.tableId, inGame: false, scores: ev.scores, player: null, ball: null });
        await captureLive(session, live, ev.scores, ev.players, at, 'game_over', null, null);
        break;
      case 'game_abandoned':
        setGame({ table: live.tableId, inGame: false, scores: ev.scores, player: null, ball: null });
        // Stern SAM has no ball in reach (B10): say so rather than "ball ?".
        await captureLive(session, live, ev.scores, null, at, 'shutdown', `abandoned${ev.ball !== null ? ` on ball ${ev.ball}` : ''}; score as of the exit`, ev.ball);
        break;
      case 'stale_sidecar':
        fail(`Castcade patch for ${live.tableId} is for an older version of the table (${ev.detail ?? 'size or date changed'}); re-import it`);
        break;
      case 'embedded_patch':
        log(`witness: the hook on ${live.tableId} runs from the table's own script${ev.original ? ` (${ev.original})` : ''}`);
        break;
      case 'warn':
        log(`witness: hook warning on ${live.tableId}: ${ev.msg ?? ''} ${ev.err ?? ''}`.trimEnd());
        break;
      default:
        break;
    }
  };

  /** One game from the journal: player 1 only, a positive score, posted with the hook's own timing. */
  const captureLive = async (
    session: OpenSession,
    live: LiveSession,
    scores: (number | null)[],
    players: number | null,
    endedAt: number,
    reason: 'game_over' | 'shutdown',
    note: string | null,
    /** The ball in play when the game was abandoned (B16's `quit_ball`), when the machine says. */
    ball: number | null,
  ): Promise<void> => {
    const rom = live.rom;
    const map = rom ? await corpus.mapFor(rom) : null;
    const score = scores[0] ?? null;
    const nonzero = scores.filter((s) => s !== null && s > 0).length;
    const n = Math.max(nonzero, players !== null && players >= 1 && players <= 4 ? players : 0);
    const started = live.lastGameStartMs ?? live.loadedAtMs ?? session.startedAt;
    const details: string[] = [`live: game ${Math.max(live.games, live.captures + 1)} of this session, from the hook's journal`];
    if (note) details.push(note);
    let decision: PublishDecision;
    if (n > 1) decision = { kind: 'skip', players: n, score, detail: `multi-player game (${n} players): not attributable to one account` };
    else if (score === null || score <= 0) decision = { kind: 'skip', players: n, score, detail: 'no score (player 1 score is 0)' };
    else decision = { kind: 'score', players: 1, score, reason, gameOver: reason === 'game_over', ball };
    const engine: EngineAttestation | null = live.engineGame.length > 0 || live.engineLast
      ? { atStart: live.engineGame[0] ?? live.engineLast, changes: live.engineGame.slice(1) }
      : null;
    await publish({ session, rom, map, nvBytes: live.detector.shadow, started, ended: endedAt, decision, details, live: true, attemptKey: live.attempt?.key ?? null, engine, plausibility: live.scoreTrack.result() });
    // B17: whatever the outcome (the persisted queue owns delivery retries), this game is done: a restart must not replay it.
    if (live.gameKey) await postedGames.add(live.gameKey).catch((err: unknown) => fail(`posted games: ${err instanceof Error ? err.message : String(err)}`));
    live.gameKey = null;
    if (decision.kind === 'score') live.captures++;
    live.attempt = null;
    live.engineGame = [];
    refreshTableStatus();
    emitStatus();
  };

  /**
   * A game START on a limited-attempts board (ADR 0029, 0.2.11): tell ArcAid at once with a key the
   * score call will repeat. The call goes through the queue so an outage replays it (idempotent on
   * the key), but a late report uses the slot and its score is refused, so the player is told.
   */
  const reportAttempt = async (session: OpenSession, live: LiveSession, players: number | null, startedMs: number, t: number): Promise<void> => {
    const { deviceId, token } = store.get();
    if (!token) return;
    const rom = live.rom;
    const romName = rom ? await corpus.romName(rom) : null;
    const wire = wireTableNames(session.launch, romName, rom);
    const wireTable = wire?.table ?? UNKNOWN_TABLE;
    const wireSlug = wire?.slug ?? null;
    const key = attemptKey(live.sessionStamp, live.loadedAtMs, t);
    await pinIdentityByRom(session, rom); // B19: no-op once `table_loaded` pinned it
    const identity = session.identity;
    const playDevice = session.attestation ? playDeviceFor(session.attestation.vr) : null;
    const posted = await queue.submit({
      kind: 'attempt',
      params: {
        device: deviceId,
        table: wireTable,
        rom,
        slug: wireSlug,
        vps_game: identity?.vpsGame?.id ?? null,
        vps_table: identity?.vpsTable?.id ?? null,
        started: sec(startedMs),
        key,
        players,
        ...(playDevice ? { play_device: playDevice } : {}),
      },
    });
    live.attempt = attemptStatusFor(key, posted);
    log(`witness: attempt ${key} on ${wireTable}: ${live.attempt.state}${live.attempt.text ? ` (${live.attempt.text})` : ''}`);
    refreshTableStatus();
    emitStatus();
  };

  /** Drain what the hook wrote last (`table_exit`), then stop following. */
  const stopLive = async (session: OpenSession): Promise<void> => {
    const live = session.live;
    if (!live) return;
    await live.tail.poll().catch(() => {});
    live.tail.stop();
    await pumpLive(session, live);
    if (liveGame?.table === live.tableId) setGame(null);
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
        if (changed.length > 0 && session) {
          if (session.live && session.live.captures > 0) {
            // Live mode already posted every game; the `.nv` rewrite at close is the last one again.
            log(`witness: ${session.live.tableId}: .nv rewritten after ${session.live.captures} live capture(s); not re-posting`);
            await refreshBaseline();
          } else {
            await capture(session, changed, snap, 'player', now);
          }
        }
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
      identityRom: null,
      hashing: null,
      attestation: null,
      live: null,
      liveRead: new Set(),
      unpatchedNote: null,
      scriptDiff: null,
      journalLooked: false,
      journalPath: null,
    };
    sessions.set(launch.pid, session);
    // B18: Castcade started with the player already up; name the table before the launch line goes out.
    if (parseWindowTitle(launch.title).kind === 'player') await tableFromJournal(session);
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
    if (!session.playerUp) session.journalLooked = false;
    // B18: an editor title named another table than the journal did; the journal's file is not this one's.
    const { launch } = session;
    if (session.journalPath !== null && launch.tablePath === session.journalPath && launch.table !== tableBaseName(session.journalPath)) {
      launch.tablePath = null;
      session.journalPath = null;
    }
    if (session.playerUp && launch.table === null && !session.journalLooked) await tableFromJournal(session);
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

    if (session) await stopLive(session);
    if (session?.live && session.live.captures > 0) {
      // Every game went out from the journal. Let VPinMAME's close-time write land so the baseline
      // is current, close the session in ArcAid, and post nothing more.
      if (status.nvramDir && baseline) await waitForNvChange(fs, status.nvramDir, baseline, { clock, timeoutMs: settleMs, pollMs: deps.nvPollMs ?? DEFAULT_NV_POLL_MS });
      pending = null;
      await refreshBaseline();
      await closeReport(session, exitedAt);
    } else if (session && status.nvramDir && baseline) {
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
      await postedGames.load().catch((err: unknown) => fail(`posted games: ${err instanceof Error ? err.message : String(err)}`));
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
        throw new Error(message, { cause: err });
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

    async startAttempts() {
      const { token, deviceId } = store.get();
      // The queue's word for a call made while unpaired, so every path says the same.
      if (!token) throw new ArcaidError('auth', 'not paired');
      const params: AttemptStartParams = { device: deviceId };
      const session = activeSession();
      if (session) {
        // The loaded table's identity as its game start would send it (reportAttempt), so the press lands on the
        // games its plays land on. Read, not re-pinned: B19 pins the identity at `table_loaded`.
        const rom = session.live?.rom ?? session.identityRom ?? null;
        const romName = rom ? await corpus.romName(rom).catch(() => null) : null;
        const wire = wireTableNames(session.launch, romName, rom);
        if (wire) {
          const playDevice = session.attestation ? playDeviceFor(session.attestation.vr) : null;
          Object.assign(params, {
            table: wire.table,
            rom,
            slug: wire.slug,
            vps_game: session.identity?.vpsGame?.id ?? null,
            ...(playDevice ? { play_device: playDevice } : {}),
          });
        }
      }
      let answer: AttemptStartAnswer;
      try {
        answer = await arcaid().attemptStart(token, params);
      } catch (err) {
        log(`witness: start attempts${params.table ? ` for ${params.table}` : ''} failed: ${errText(err)}`);
        throw err;
      }
      const text = attemptStartText(answer);
      status.sendingTo = answer.sendingTo;
      status.attemptStart = { at: iso(clock.now()), status: answer.status ?? 'unknown', text };
      clearArcaidError();
      log(`witness: start attempts${params.table ? ` for ${params.table}` : ''}: ${answer.status ?? '?'} (${text})`);
      emitStatus();
      return { ...status };
    },

    liveGame() {
      return liveGame;
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
