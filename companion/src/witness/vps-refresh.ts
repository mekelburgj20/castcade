/**
 * B24: keep the VPS index current while the app runs. The installer ships an index built at a pinned
 * vps-db commit, which can never know a table released after the pin (Freddy's `ZqH53HLaa4`, added
 * the day before the owner played it, 2026-11-01). So the companion rebuilds the same compact index
 * (`vps-build.ts`) from `db/vpsdb.json` of vps-db `main` into `<dir>/index.json`, and the loader
 * (`vps-index.ts`) prefers that copy over the bundled one.
 *
 * Cadence: on `start()`, if there is no cached copy or it is older than a day, one fetch after a short
 * delay (startup is not slowed); then once a day while running, never more often. No setting (ADR
 * 0007: automate, do not add knobs). The raw file is ~8 MB with a strong ETag, so the daily check is
 * a conditional GET that costs nothing when nothing changed (304). Any failure, offline, HTTP error,
 * bad JSON, oversize body, is one log line; whatever index is loaded stays in use.
 *
 * `state.json` beside the index remembers the ETag and when it was last checked. The index file is
 * written through a temp name and renamed, so a crash mid-write never leaves a torn `index.json`
 * (and the loader treats a torn one as absent anyway).
 */
import type { Clock, TimerHandle } from '../match/clock.js';
import type { WitnessFs } from './fs.js';
import { isNotFound } from './fs.js';
import { buildIndex, countTables } from './vps-build.js';
import { vpsIndexPath } from './vps-index.js';

export const VPS_DB_URL = 'https://raw.githubusercontent.com/VirtualPinballSpreadsheet/vps-db/main/db/vpsdb.json';
/** Once a day after the first check; the bundled pin covers the first day of a fresh install. */
export const DEFAULT_VPS_REFRESH_MS = 24 * 60 * 60_000;
/** The first check waits this long after start so the fetch never competes with startup. */
export const DEFAULT_VPS_REFRESH_DELAY_MS = 30_000;
/** The database is ~8 MB today; four times that is a bug or a hijacked response, not growth. */
export const VPS_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** 8 MB on a slow line: generous, but bounded. */
export const DEFAULT_VPS_FETCH_TIMEOUT_MS = 120_000;
export const VPS_STATE_FILE = 'state.json';

/** `state.json`: what the last successful check learned. */
export interface VpsRefreshState {
  /** The ETag of `vpsdb.json` the current `index.json` was built from (sent back as `If-None-Match`). */
  etag: string | null;
  /** When upstream was last checked (a 200 or a 304), ISO. */
  checkedAt: string;
  /** When the current `index.json` was built (the last 200), ISO. */
  refreshedAt: string;
  /** What the index records as its version (the ETag without quotes). */
  version: string;
  games: number;
  tables: number;
}

/** The fetch shape this module needs (`globalThis.fetch` fits; tests pass a fake). */
export type VpsDbFetch = (
  input: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export interface VpsRefreshDeps {
  /** Where `index.json` and `state.json` live (`<dataDir>/vps`). */
  dir: string;
  fs: WitnessFs;
  fetch: VpsDbFetch;
  clock: Clock;
  /** After a new index is on disk: the loader reloads and the status line is redrawn. */
  onRefreshed: (state: VpsRefreshState) => void | Promise<void>;
  log?: (line: string) => void;
  intervalMs?: number;
  startDelayMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  url?: string;
}

export type VpsRefreshResult = { kind: 'fresh'; state: VpsRefreshState } | { kind: 'unchanged'; state: VpsRefreshState } | { kind: 'failed'; error: string };

export interface VpsRefresh {
  /** Load `state.json` and arm the timer. Idempotent. */
  start(): Promise<void>;
  stop(): void;
  /** The last successful check as remembered on disk, or null before any. */
  state(): VpsRefreshState | null;
  /** One check now (tests and the timer). Never throws. */
  refresh(): Promise<VpsRefreshResult>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function parseState(json: unknown): VpsRefreshState | null {
  if (!isObj(json)) return null;
  const checkedAt = text(json['checkedAt']);
  const refreshedAt = text(json['refreshedAt']);
  const version = text(json['version']);
  if (!checkedAt || !refreshedAt || !version) return null;
  return { etag: text(json['etag']), checkedAt, refreshedAt, version, games: count(json['games']), tables: count(json['tables']) };
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/** Where the refreshed index lives: `<dataDir>/vps` (beside `roms.json` and `identity.json`). */
export function vpsRefreshDir(dataDir: string): string {
  return joinPath(dataDir, 'vps');
}

/** The ETag without weak marker and quotes: what the index records as its version. */
export function versionFromEtag(etag: string | null): string | null {
  if (!etag) return null;
  const bare = etag.replace(/^W\//, '').replace(/^"|"$/g, '').trim();
  return bare === '' ? null : bare;
}

/** The first seven characters of a hash version (a commit or an ETag), for log lines. */
export function shortVersion(version: string | null): string {
  if (!version) return 'unknown';
  return /^[0-9a-f]{12,}$/i.test(version) ? version.slice(0, 7) : version;
}

export function createVpsRefresh(deps: VpsRefreshDeps): VpsRefresh {
  const { dir, fs, clock } = deps;
  const log = deps.log ?? (() => {});
  const intervalMs = deps.intervalMs ?? DEFAULT_VPS_REFRESH_MS;
  const startDelayMs = deps.startDelayMs ?? DEFAULT_VPS_REFRESH_DELAY_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_VPS_FETCH_TIMEOUT_MS;
  const maxBodyBytes = deps.maxBodyBytes ?? VPS_MAX_BODY_BYTES;
  const url = deps.url ?? VPS_DB_URL;
  const stateFile = joinPath(dir, VPS_STATE_FILE);
  const indexFile = vpsIndexPath(dir);

  let state: VpsRefreshState | null = null;
  let timer: TimerHandle | null = null;
  let running = false;
  let inFlight: Promise<VpsRefreshResult> | null = null;

  const iso = (): string => new Date(clock.now()).toISOString();

  const loadState = async (): Promise<VpsRefreshState | null> => {
    let raw: string;
    try {
      raw = new TextDecoder().decode(await fs.readFile(stateFile));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    try {
      return parseState(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  const writeAtomic = async (path: string, data: string): Promise<void> => {
    const tmp = path + '.tmp';
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path);
  };

  const saveState = async (next: VpsRefreshState): Promise<void> => {
    await fs.mkdir(dir);
    await writeAtomic(stateFile, JSON.stringify(next) + '\n');
    state = next;
  };

  /** One conditional GET, parsed and written. Returns the outcome; the caller logs. */
  const fetchOnce = async (): Promise<VpsRefreshResult> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (state?.etag) headers['if-none-match'] = state.etag;
    const controller = new AbortController();
    const abort = clock.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await deps.fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (res.status === 304) {
        if (!state) return { kind: 'failed', error: 'HTTP 304 without a cached index' };
        const next = { ...state, checkedAt: iso() };
        await saveState(next);
        return { kind: 'unchanged', state: next };
      }
      if (res.status < 200 || res.status >= 300) return { kind: 'failed', error: `HTTP ${res.status}` };
      const declared = Number(res.headers?.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBodyBytes) return { kind: 'failed', error: `body is ${declared} bytes, over the ${maxBodyBytes} limit` };
      const body = await res.text();
      if (body.length > maxBodyBytes) return { kind: 'failed', error: `body is ${body.length} bytes, over the ${maxBodyBytes} limit` };
      let db: unknown;
      try {
        db = JSON.parse(body);
      } catch {
        return { kind: 'failed', error: 'not JSON' };
      }
      const etag = text(res.headers?.get('etag'));
      const now = iso();
      const index = buildIndex(db, { version: versionFromEtag(etag) ?? `fetched-${now}`, generatedAt: now });
      if (index.games.length === 0) return { kind: 'failed', error: 'no games in the database' };
      await fs.mkdir(dir);
      await writeAtomic(indexFile, JSON.stringify(index) + '\n');
      const next: VpsRefreshState = { etag, checkedAt: now, refreshedAt: now, version: index.version, games: index.games.length, tables: countTables(index) };
      await saveState(next);
      return { kind: 'fresh', state: next };
    } catch (err) {
      return { kind: 'failed', error: err instanceof Error && err.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : err instanceof Error ? err.message : String(err) };
    } finally {
      clock.clearTimeout(abort);
    }
  };

  const refresh = (): Promise<VpsRefreshResult> => {
    inFlight ??= (async () => {
      let r: VpsRefreshResult;
      try {
        r = await fetchOnce();
      } catch (err) {
        r = { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
      if (r.kind === 'failed') log(`witness: VPS index refresh skipped (${r.error}); the loaded index stays in use`);
      else if (r.kind === 'unchanged') log(`witness: VPS index up to date (vps-db unchanged since ${r.state.refreshedAt})`);
      else {
        try {
          await deps.onRefreshed(r.state);
        } catch (err) {
          log(`witness: VPS index refreshed but not reloaded (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      return r;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const schedule = (ms: number): void => {
    if (!running) return;
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      void refresh().finally(() => schedule(intervalMs));
    }, ms);
  };

  return {
    async start() {
      if (running) return;
      running = true;
      state = await loadState().catch(() => null);
      const checked = state ? Date.parse(state.checkedAt) : NaN;
      const age = Number.isFinite(checked) ? clock.now() - checked : Infinity;
      // A fresh enough copy waits out the rest of its day; anything else is checked after the start delay.
      schedule(age >= intervalMs ? startDelayMs : Math.max(startDelayMs, intervalMs - age));
    },
    stop() {
      running = false;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
    state: () => state,
    refresh,
  };
}
