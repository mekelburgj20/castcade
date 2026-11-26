/**
 * electron-updater wiring: packaged builds check GitHub Releases at launch and then keep checking
 * while the tray app runs (every few hours, sooner after a failed check), download in the background
 * and log every step. Unsigned PoC builds: electron-updater skips signature verification when no
 * publisherName is set.
 *
 * E9 (2026-11-16): an update never installs invisibly, and it ends with Castcade running. On the owner's PC a quit
 * with 0.2.44 downloaded ran the installer silently (`Auto install update on quit`); his start five seconds later was
 * killed by that installer (electron-builder's `CHECK_APP_RUNNING`), and nothing started Castcade after it. Now:
 * - quitting just quits (`autoInstallOnAppQuit` off);
 * - a downloaded update is offered (balloon, tray menu, a banner in the window): Restart and update runs the installer
 *   visibly (`install(false, true)`: `--updated --force-run`, no `/S`), and the installer starts Castcade at its end;
 * - an update downloaded before Castcade last closed is installed at the next start, before anything else, once the
 *   release feed confirms it is still the latest (a stale download is replaced, not installed);
 * - never while a table is open, during a match, a 3D watch session or a recording: the offer waits and says why;
 * - Castcade notes each install it starts (`update-install.json` beside settings.json): the next start knows whether
 *   it worked, failed, or is still running (then that start says so and leaves instead of being killed).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import type { Logger } from './log.js';
import { describeError } from './log.js';
import { realClock, type Clock } from '../match/clock.js';
import { installerPrefix, updateMatchesEdition, type Edition } from './edition.js';

/** Interval between successful checks. A tray app can run for days; one check at launch is not enough. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Retry delay after a failed check (offline at boot, GitHub hiccup, release still being uploaded). */
export const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
/**
 * At start, how long the release feed may take to confirm a waiting download (the check and the re-hash of the cached
 * file together: one deadline) before Castcade starts without it.
 */
export const START_CHECK_TIMEOUT_MS = 10_000;
/** After the installer is launched, how long its process may take to show in `tasklist` before the launch counts as failed. */
export const LAUNCH_CONFIRM_MS = 4_000;
export const LAUNCH_POLL_MS = 500;
/** An installer open longer than this (with Castcade's note) is probably waiting for an answer in its window. */
export const LONG_INSTALL_MS = 2 * 60_000;
/** The note of an install Castcade started (`<userData>/update-install.json`). */
export const INSTALL_MARKER_FILE = 'update-install.json';
/** electron-updater's cache folder under %LOCALAPPDATA% when app-update.yml cannot be read (electron-builder derives it from the package name). */
export const DEFAULT_CACHE_DIR_NAME = '@castcadecompanion-updater';
/**
 * The installer's file name (`artifactName` in electron-builder.yml, and in electron-builder.witness.yml for the Witness
 * edition, E10): the version of a cached download is read from it.
 */
const INSTALLER_NAME = /^Castcade-(?:Witness-)?Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.exe$/i;

export type CheckOutcome = 'ok' | 'failed' | 'downloaded';

/** When to check again after a check with the given outcome; null once an update is downloaded. */
export function nextCheckDelayMs(outcome: CheckOutcome): number | null {
  switch (outcome) {
    case 'ok':
      return CHECK_INTERVAL_MS;
    case 'failed':
      return RETRY_AFTER_FAILURE_MS;
    case 'downloaded':
      return null;
  }
}

// ------------------------------------------------------------------------------------ versions --

/** Semver order of `a` and `b` (major.minor.patch, a pre-release below its release); NaN when either is not a version. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number, string | null] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return Number.NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (x[3] === y[3]) return 0;
  if (x[3] === null) return 1;
  if (y[3] === null) return -1;
  return x[3] < y[3] ? -1 : 1;
}

/** The version in an installer's file name (`Castcade-Setup-0.2.46.exe`, `Castcade-Witness-Setup-0.2.46.exe`), else null. */
export function installerVersion(fileName: string): string | null {
  return INSTALLER_NAME.exec(fileName)?.[1] ?? null;
}

// ------------------------------------------------------------------------- electron-updater cache --

/** electron-updater's cache folder name, from the `updaterCacheDirName` line of `resources/app-update.yml`. */
export function cacheDirName(appUpdateYml: string | null): string {
  const m = appUpdateYml ? /^updaterCacheDirName:\s*(.+?)\s*$/m.exec(appUpdateYml) : null;
  const raw = m?.[1]?.replace(/^(['"])(.*)\1$/, '$2') ?? '';
  return raw && !/[\\/]|\.\./.test(raw) ? raw : DEFAULT_CACHE_DIR_NAME;
}

/**
 * What electron-updater's `pending` folder holds. It keeps the installer it downloaded and verified there with
 * `update-info.json` (`fileName`, `sha512`); the folder is not emptied after an install, so a file for the version
 * now running (or an older one) is a leftover, not an update.
 */
export type PendingRead =
  | { kind: 'none' }
  | { kind: 'unreadable'; why: string }
  | { kind: 'leftover'; version: string }
  | { kind: 'pending'; version: string; fileName: string; file: string };

export function readPendingInstaller(o: { dir: string; appVersion: string; readText(path: string): string | null; exists(path: string): boolean; edition?: Edition }): PendingRead {
  const text = o.readText(join(o.dir, 'update-info.json'));
  if (text === null) return { kind: 'none' };
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', why: 'update-info.json is not JSON' };
  }
  const fileName = typeof info === 'object' && info !== null ? (info as { fileName?: unknown }).fileName : undefined;
  if (typeof fileName !== 'string' || win32.basename(fileName) !== fileName) return { kind: 'unreadable', why: 'update-info.json names no installer' };
  const version = installerVersion(fileName);
  if (!version) return { kind: 'unreadable', why: `${fileName} is not a Castcade installer name` };
  // E10: both editions share this folder (same appId). An installer the other edition downloaded before this one was
  // installed over it is never this edition's update.
  if (!updateMatchesEdition(o.edition ?? 'full', [fileName])) return { kind: 'unreadable', why: `${fileName} is the other edition's installer` };
  if (!(compareVersions(version, o.appVersion) > 0)) return { kind: 'leftover', version };
  const file = join(o.dir, fileName);
  if (!o.exists(file)) return { kind: 'unreadable', why: `${fileName} is named in update-info.json but not there` };
  return { kind: 'pending', version, fileName, file };
}

/** One line for the log about what the cache holds. */
export function describePending(p: PendingRead, appVersion: string): string {
  switch (p.kind) {
    case 'none':
      return 'nothing downloaded is waiting';
    case 'unreadable':
      return `the download cache cannot be used (${p.why})`;
    case 'leftover':
      return `the cached installer is ${p.version}, not newer than ${appVersion} (left from an earlier update)`;
    case 'pending':
      return `${p.version} was downloaded (${p.fileName}) and is not installed`;
  }
}

// --------------------------------------------------------------------------------- install note --

/** Written just before Castcade starts an installer; read (and removed) at the next start. */
export interface InstallMarker {
  version: string;
  /** The installer's file name: its process name while it runs. */
  fileName: string;
  /** Epoch ms. */
  at: number;
  from: 'offer' | 'start';
  /** The start that installed was `--hidden` (Start with Windows): the start after the install stays in the tray. */
  hidden: boolean;
  /**
   * False: the installer could not be started (refused, threw, or its process never showed), and Castcade started itself
   * again; that start offers the update instead of installing it.
   */
  started: boolean;
}

export function parseMarker(text: string | null): InstallMarker | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'string' || Number.isNaN(compareVersions(r.version, '0.0.0'))) return null;
  if (typeof r.fileName !== 'string' || installerVersion(r.fileName) === null) return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  return { version: r.version, fileName: r.fileName, at: r.at, from: r.from === 'start' ? 'start' : 'offer', hidden: r.hidden === true, started: r.started !== false };
}

export interface MarkerStore {
  read(): InstallMarker | null;
  write(m: InstallMarker): void;
  remove(): void;
}

export function createMarkerStore(file: string, warn: (line: string) => void): MarkerStore {
  return {
    read() {
      try {
        return parseMarker(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    write(m) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(m));
        renameSync(`${file}.tmp`, file);
      } catch (e) {
        warn(`updater: could not write ${file}: ${describeError(e)}`);
      }
    },
    remove() {
      try {
        rmSync(file, { force: true });
      } catch (e) {
        warn(`updater: could not remove ${file}: ${describeError(e)}`);
      }
    },
  };
}

/** Whether `tasklist /FO CSV /NH` output lists a process of this image name. */
export function tasklistHas(stdout: string, image: string): boolean {
  const want = `"${image.toLowerCase()}"`;
  return stdout.split(/\r?\n/).some((line) => line.trim().toLowerCase().startsWith(`${want},`));
}

type ExecFileFn = (file: string, args: readonly string[], opts: { timeout: number; windowsHide: boolean }, cb: (err: Error | null, stdout: string) => void) => unknown;

/** Whether the installer of that file name is running (`tasklist`; a failure reads as not running). */
export function createInstallerProbe(exec: ExecFileFn = execFile as unknown as ExecFileFn): (fileName: string) => Promise<boolean> {
  return (fileName) =>
    new Promise((resolve) => {
      if (installerVersion(fileName) === null) {
        resolve(false);
        return;
      }
      try {
        exec('tasklist.exe', ['/FI', `IMAGENAME eq ${fileName}`, '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
          resolve(!err && tasklistHas(String(stdout ?? ''), fileName));
        });
      } catch {
        resolve(false);
      }
    });
}

// --------------------------------------------------------------------------------- busy states --

/**
 * Why an install has to wait now, as the end of "It waits …", or null. The app never pulls itself down while a table
 * is open under the witness, during a match (lobby included), a 3D watch session, or a recording / stream.
 */
export function installWaitReason(s: {
  match: { role: 'none' | 'host' | 'client'; phase: string } | null;
  watch: boolean;
  table: string | null;
  vpx: boolean;
  recording: boolean;
}): string | null {
  if (s.match && (s.match.role !== 'none' || s.match.phase === 'connecting')) return 'until you leave the lobby';
  if (s.watch) return 'until you leave the 3D watch session';
  if (s.table) return `until ${s.table} is closed`;
  if (s.vpx) return 'until VPX is closed';
  if (s.recording) return 'until the recording or stream stops';
  return null;
}

// ------------------------------------------------------------------------------------ updater --

/** The part of electron-updater's NsisUpdater Castcade uses (a fake in the tests: no test runs an installer). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string }; downloadPromise?: Promise<unknown> | null } | null>;
  /**
   * BaseUpdater.install: launches the installer without quitting; Castcade confirms the launch and quits itself. True
   * means only that the spawn was asked for (NsisUpdater.doInstall returns before the spawn's result is known).
   */
  install(isSilent: boolean, isForceRunAfter: boolean): boolean;
  /**
   * BaseUpdater's guard (protected there): set before every install and left set when the install throws, after which
   * every later install() in the run returns false without trying. Castcade clears it after a launch that failed.
   */
  quitAndInstallCalled?: boolean;
  /**
   * AppUpdater's hook inside its own check (`isUpdateAvailable`, after the version compare, before any download): false
   * makes the check "update not available". E10 puts the edition guard here (`configureUpdater`).
   */
  isUpdateSupported?: (info: UpdateInfoLike) => boolean | Promise<boolean>;
}

/** The part of electron-updater's UpdateInfo the edition guard reads. */
export interface UpdateInfoLike {
  version: string;
  path?: string;
  files?: ReadonlyArray<{ url: string }>;
}

/** The file names an update carries (`files[].url`, and the older `path`). */
export function updateFileNames(info: UpdateInfoLike): string[] {
  return [...(info.files ?? []).map((f) => f.url), ...(typeof info.path === 'string' && info.path ? [info.path] : [])];
}

/**
 * The settings Castcade runs electron-updater with. `autoInstallOnAppQuit` off: a quit never installs (BaseUpdater's
 * quit handler is then never added). `autoRunAppAfterInstall` on: a visible install gets `--force-run` (installer.nsh
 * starts Castcade at its end). E10: an update for the other edition is refused inside the check, before any download
 * (`updateMatchesEdition`), logged once per check, and is otherwise "up to date"; electron-updater's own test (the
 * minimum OS version) still runs for an update this edition accepts.
 */
export function configureUpdater(u: UpdaterLike, log: Logger, onDownloaded: (version: string, file: string | null) => void, edition: Edition = 'full'): void {
  u.autoDownload = true;
  u.autoInstallOnAppQuit = false;
  u.autoRunAppAfterInstall = true;
  // The PoC ships as GitHub pre-releases (unsigned until GA); installed apps must still see them.
  u.allowPrerelease = true;
  u.logger = {
    info: (m: unknown) => log.info(`updater: ${String(m)}`),
    warn: (m: unknown) => log.warn(`updater: ${String(m)}`),
    error: (m: unknown) => log.error(`updater: ${String(m)}`),
    debug: (m: unknown) => log.debug(`updater: ${String(m)}`),
  };
  u.on('update-available', (info: { version: string }) => log.info(`updater: update available ${info.version}`));
  u.on('update-not-available', () => log.info('updater: up to date'));
  u.on('error', (e: unknown) => log.warn(`updater: ${describeError(e)}`));
  u.on('update-downloaded', (info: { version: string; downloadedFile?: string }) => onDownloaded(info.version, typeof info.downloadedFile === 'string' ? info.downloadedFile : null));
  // E10: the GitHub provider falls back to latest.yml when the newest release has no witness.yml (allowPrerelease is
  // on); this keeps that fallback from updating a Witness install into the full app, and the other way round.
  const supported = u.isUpdateSupported;
  u.isUpdateSupported = (info) => {
    const names = updateFileNames(info);
    if (!updateMatchesEdition(edition, names)) {
      log.info(`updater: ${info.version} is not an update for the ${edition} edition (its installer: ${names.join(', ') || 'none named'}); up to date as far as this edition goes`);
      return false;
    }
    return supported ? supported.call(u, info) : true;
  };
}

/** electron-updater's autoUpdater (dynamic import: CommonJS, and kept out of the --smoke path and development runs). */
export async function loadUpdater(log: Logger): Promise<UpdaterLike | null> {
  try {
    // electron-updater defines `autoUpdater` as a CJS getter, which Node's ESM named-export
    // detection does not see: read it off the CJS namespace (`default`) instead.
    const ns = await import('electron-updater');
    const cjs = (ns as unknown as { default?: typeof ns }).default ?? ns;
    const u = cjs.autoUpdater as unknown as UpdaterLike | undefined;
    if (!u) throw new Error('electron-updater did not expose autoUpdater');
    return u;
  } catch (e) {
    log.warn(`updater: unavailable: ${describeError(e)}`);
    return null;
  }
}

/** What the window, the tray and the IPC show. */
export interface UpdateStatus {
  /** A downloaded update this run verified and can install, else null. */
  ready: string | null;
  /** Why Restart and update waits ("until you leave the match"); null when it can go now. */
  waiting: string | null;
  /** Restart and update was pressed: Castcade is closing for the installer. */
  installing: boolean;
  /**
   * The last try at installing `ready`: its installer could not be started (`not_started`), or it ran and did not finish
   * (`not_finished`: closed or failed). Null when there was none.
   */
  lastAttempt: AttemptFailure | null;
}

export type AttemptFailure = 'not_started' | 'not_finished';

export type UpdateNotice =
  | { kind: 'ready'; version: string; waiting: string | null }
  | { kind: 'free'; version: string }
  | { kind: 'updated'; version: string }
  | { kind: 'failed'; version: string; why: AttemptFailure };

export type StartOutcome =
  /** Start Castcade as usual. `hidden`: the start before the install was `--hidden`, keep this one in the tray. */
  | { outcome: 'continue'; hidden: boolean }
  /** The installer has been started and Castcade is quitting: start nothing. */
  | { outcome: 'installing'; version: string }
  /** An install Castcade started is still running: say so (`installRunningNotice`) and leave; the installer starts Castcade at its end. */
  | { outcome: 'install_running'; version: string; ageMs: number };

/** What the start that leaves while Castcade's installer runs shows for 3 s. */
export function installRunningNotice(version: string, ageMs: number): string {
  if (ageMs > LONG_INSTALL_MS) {
    return `Castcade is being updated to ${version}, but its installer has been open for ${Math.floor(ageMs / 60_000)} minutes: its window may be waiting for an answer. Castcade starts once the installer is finished or closed.`;
  }
  return `Castcade is being updated to ${version}. The installer is still running and starts Castcade again when it is done.`;
}

export interface UpdateControllerDeps {
  log: Logger;
  appVersion: string;
  /** E10: this build's edition (its update guard, its installer's name); default full. */
  edition?: Edition;
  /** Null when electron-updater could not be loaded: nothing is offered or installed. */
  updater: UpdaterLike | null;
  clock?: Clock;
  /** Why an install has to wait right now (`installWaitReason`), else null. */
  busy(): string | null;
  /**
   * At start, before anything runs: a VPX already open, a match to go back to; null when nothing. No answer within the
   * start deadline, or an error, counts as busy: the update is then offered, not installed.
   */
  busyAtStart(): Promise<string | null>;
  /**
   * At start, read again at the moment of deciding to install: a reason that appeared while the feed was asked (a
   * `castcade://` invite handed over by a second start), else null.
   */
  heldAtStart?(): string | null;
  /** Whether a file exists (the downloaded installer, before anything is shut down for it). */
  exists?(path: string): boolean;
  /** What electron-updater's cache holds (`readPendingInstaller`). */
  pending(): PendingRead;
  marker: MarkerStore;
  installerRunning(fileName: string): Promise<boolean>;
  /** This start is `--hidden` (Start with Windows). */
  hiddenStart: boolean;
  /** This start came from the installer (`--updated`). */
  startedByInstaller: boolean;
  /** At start, a waiting download is about to be confirmed and installed: the shell shows a notice meanwhile. */
  checking?(version: string): void;
  /** Ends the app once the installer is started (app.quit). */
  quit(): void;
  startCheckTimeoutMs?: number;
}

export interface UpdateController {
  /** Before anything else starts: the last install's outcome, then a waiting download is confirmed and installed. */
  atStart(): Promise<StartOutcome>;
  /** The periodic check (the first one now, unless `atStart` just did one). */
  startChecks(): void;
  status(): UpdateStatus;
  pendingVersion(): string | null;
  /**
   * Restart and update was pressed. `go`: accepted (the caller shuts down in order, then calls `install`). Else `why`
   * it waits ("until you leave the match"), or null when it is already under way.
   */
  requestInstall(): { go: true } | { go: false; why: string | null };
  /**
   * Launches the installer visibly, confirms its process runs, then quits (true). False when there is nothing to
   * install or the launch was refused, threw or never showed: Castcade does not quit then. `offer` leaves a note that
   * the launch failed (the shell starts Castcade again after its shutdown, and that start offers instead of installing).
   */
  install(from: 'offer' | 'start'): Promise<boolean>;
  /** A busy state may have changed (witness, match, watch, stream status). */
  refresh(): void;
  onStatus(cb: (s: UpdateStatus) => void): () => void;
  /** Balloons; those raised before the first subscriber (at start, before the tray exists) are kept for it. */
  onNotice(cb: (n: UpdateNotice) => void): () => void;
  /** Stop the periodic re-check (the app is quitting). */
  stop(): void;
}

const TIMEOUT = Symbol('timeout');

function withTimeout<T>(p: Promise<T>, ms: number, clock: Clock): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const t = clock.setTimeout(() => resolve(TIMEOUT), ms);
    p.then(
      (v) => {
        clock.clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clock.clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const { log, appVersion, updater } = deps;
  const edition = deps.edition ?? 'full';
  const clock = deps.clock ?? realClock;
  const startTimeout = deps.startCheckTimeoutMs ?? START_CHECK_TIMEOUT_MS;
  let ready: string | null = null;
  let readyFile: string | null = null;
  let installing = false;
  /** The version whose last install try failed, and how. */
  let failedBefore: { version: string; why: AttemptFailure } | null = null;
  let lastWaiting: string | null = null;
  const freed = new Set<string>();
  let timer: unknown = null;
  let stopped = false;
  let checking = false;
  /** The check `atStart` made, so `startChecks` schedules from it instead of asking again. */
  let startCheck: CheckOutcome | null = null;
  const statusCbs = new Set<(s: UpdateStatus) => void>();
  const noticeCbs = new Set<(n: UpdateNotice) => void>();
  const held: UpdateNotice[] = [];

  const status = (): UpdateStatus => ({
    ready,
    waiting: ready && !installing ? deps.busy() : null,
    installing,
    lastAttempt: ready !== null && failedBefore?.version === ready ? failedBefore.why : null,
  });
  const emit = (): void => {
    const s = status();
    for (const cb of statusCbs) cb(s);
  };
  const notice = (n: UpdateNotice): void => {
    if (noticeCbs.size === 0) {
      // At start: "could not be started, offered again" says all a held "downloaded" of the same version would.
      if (n.kind === 'failed') for (let i = held.length - 1; i >= 0; i--) if (held[i]?.kind === 'ready' && held[i]?.version === n.version) held.splice(i, 1);
      held.push(n);
    }
    for (const cb of noticeCbs) cb(n);
  };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => void clock.setTimeout(resolve, ms));

  if (updater) {
    configureUpdater(updater, log, (version, file) => {
      ready = version;
      readyFile = file;
      const waiting = deps.busy();
      lastWaiting = waiting;
      log.info(
        `updater: downloaded ${version}${file ? ` (${file})` : ''}; it installs from Restart and update (window, tray, balloon) or at the next start` +
          (waiting ? `; Restart and update waits ${waiting}` : ''),
      );
      emit();
      notice({ kind: 'ready', version, waiting });
    }, edition);
  }

  const check = async (): Promise<CheckOutcome> => {
    if (!updater || checking) return ready ? 'downloaded' : 'failed';
    checking = true;
    try {
      await updater.checkForUpdates();
      return ready ? 'downloaded' : 'ok';
    } catch (e) {
      log.warn(`updater: check failed: ${describeError(e)}`);
      return 'failed';
    } finally {
      checking = false;
    }
  };

  const schedule = (outcome: CheckOutcome): void => {
    if (stopped) return;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    const delay = nextCheckDelayMs(outcome);
    if (delay === null) return;
    timer = clock.setTimeout(() => {
      timer = null;
      void check().then(schedule);
    }, delay);
    // Never keep the process alive for a re-check.
    (timer as { unref?: () => void } | null)?.unref?.();
  };

  /** The downloaded installer is gone from electron-updater's cache: forget it and download it again. */
  const readyFileGone = (): boolean => {
    if (!readyFile || !deps.exists || deps.exists(readyFile)) return false;
    log.warn(`updater: the downloaded installer of ${ready} is gone (${readyFile}); Castcade downloads it again`);
    ready = null;
    readyFile = null;
    installing = false;
    emit();
    if (!stopped) void check().then(schedule);
    return true;
  };

  /** Whether the release feed's latest is `version` and electron-updater has it verified in its cache now. */
  const confirm = async (
    version: string,
    deadline: number,
  ): Promise<{ kind: 'confirmed' } | { kind: 'stale' | 'none'; latest: string | null } | { kind: 'timeout' } | { kind: 'unreachable'; why: string }> => {
    if (!updater) return { kind: 'unreachable', why: 'electron-updater is unavailable' };
    const left = (): number => Math.max(0, deadline - clock.now());
    try {
      const r = await withTimeout(updater.checkForUpdates(), left(), clock);
      if (r === TIMEOUT) return { kind: 'timeout' };
      if (!r || !r.isUpdateAvailable) {
        startCheck = 'ok';
        return { kind: 'none', latest: r?.updateInfo.version ?? null };
      }
      startCheck = 'ok';
      if (r.updateInfo.version !== version) return { kind: 'stale', latest: r.updateInfo.version };
      // The same version: electron-updater re-hashes the cached file against the feed's sha512 and reports it
      // downloaded (no download), or downloads it again when the file does not match. Same deadline as the check.
      const d = await withTimeout(r.downloadPromise ?? Promise.resolve(), left(), clock);
      if (d === TIMEOUT) return { kind: 'timeout' };
      if (ready !== version) return { kind: 'unreachable', why: `electron-updater did not report ${version} downloaded` };
      startCheck = 'downloaded';
      return { kind: 'confirmed' };
    } catch (e) {
      startCheck = 'failed';
      return { kind: 'unreachable', why: e instanceof Error ? e.message : String(e) };
    }
  };

  /** The installer's process shows in `tasklist` within LAUNCH_CONFIRM_MS. */
  const launched = async (fileName: string): Promise<boolean> => {
    const until = clock.now() + LAUNCH_CONFIRM_MS;
    for (;;) {
      if (await deps.installerRunning(fileName)) return true;
      if (clock.now() >= until) return false;
      await sleep(LAUNCH_POLL_MS);
    }
  };

  const install = async (from: 'offer' | 'start'): Promise<boolean> => {
    const version = ready;
    if (!updater || !version) {
      log.warn(`updater: install asked (${from}) but no downloaded update is ready`);
      installing = false;
      emit();
      return false;
    }
    const fileName = readyFile ? win32.basename(readyFile) : `${installerPrefix(edition)}${version}.exe`;
    const failed = (why: string): false => {
      // BaseUpdater leaves its guard set after a launch that threw: clear it, or every later try is refused unseen.
      if (updater.quitAndInstallCalled === true) updater.quitAndInstallCalled = false;
      failedBefore = { version, why: 'not_started' };
      if (from === 'offer') {
        deps.marker.write({ version, fileName, at: clock.now(), from, hidden: false, started: false });
        log.warn(`updater: the installer of ${version} could not be started (${why}); Castcade starts again and offers it, it does not install it at that start`);
      } else {
        deps.marker.remove();
        log.warn(`updater: the installer of ${version} could not be started (${why}); Castcade starts without it and offers it`);
      }
      installing = false;
      emit();
      // From the offer the shell starts Castcade again, and that start says it (from the note); at start, say it here.
      if (from === 'start') notice({ kind: 'failed', version, why: 'not_started' });
      return false;
    };
    if (readyFile && deps.exists && !deps.exists(readyFile)) return failed(`${readyFile} is gone`);
    deps.marker.write({ version, fileName, at: clock.now(), from, hidden: from === 'start' && deps.hiddenStart, started: true });
    log.info(
      `updater: installing ${version} ${from === 'start' ? 'at start, before anything else' : 'from Restart and update'}: ` +
        'Castcade closes, the installer shows its progress and starts Castcade again when it is done',
    );
    installing = true;
    emit();
    let asked: boolean;
    try {
      asked = updater.install(false, true);
    } catch (e) {
      return failed(describeError(e));
    }
    if (!asked) return failed('electron-updater refused, see the updater lines above');
    if (!(await launched(fileName))) return failed(`its process ${fileName} did not show within ${LAUNCH_CONFIRM_MS / 1000} s`);
    log.info(`updater: the installer of ${version} is running; Castcade quits for it`);
    deps.quit();
    return true;
  };

  return {
    async atStart() {
      const now = clock.now();
      let hidden = false;
      const m = deps.marker.read();
      if (m) {
        const ageMs = Math.max(0, now - m.at);
        const age = Math.round(ageMs / 1000);
        if (compareVersions(appVersion, m.version) >= 0) {
          log.info(`updater: updated to ${appVersion}: the install of ${m.version} ${m.from === 'start' ? 'at a start' : 'from Restart and update'} began ${age} s before this start`);
          deps.marker.remove();
          hidden = m.hidden;
          notice({ kind: 'updated', version: appVersion });
        } else if (await deps.installerRunning(m.fileName)) {
          log.warn(
            `updater: the installer of ${m.version} (${m.fileName}), started ${age} s ago, is still running; this start leaves at once (the installer starts Castcade when it is done)` +
              (ageMs > LONG_INSTALL_MS ? '; it has been open long enough to be waiting for an answer in its window' : ''),
          );
          return { outcome: 'install_running', version: m.version, ageMs };
        } else {
          const why: AttemptFailure = m.started ? 'not_finished' : 'not_started';
          log.warn(
            (m.started
              ? `updater: the install of ${m.version} begun ${age} s ago did not finish (its installer is not running and this is still ${appVersion}: it was closed or failed)`
              : `updater: the installer of ${m.version} could not be started ${age} s ago`) + '; not installing it at this start, it is offered instead',
          );
          deps.marker.remove();
          failedBefore = { version: m.version, why };
          notice({ kind: 'failed', version: m.version, why });
        }
      } else if (deps.startedByInstaller) {
        log.info(`updater: started by the installer after an update to ${appVersion}`);
        notice({ kind: 'updated', version: appVersion });
      }

      const p = deps.pending();
      log.info(`updater: at start: ${describePending(p, appVersion)}`);
      if (p.kind !== 'pending') return { outcome: 'continue', hidden };
      if (!updater) return { outcome: 'continue', hidden };
      if (failedBefore?.version === p.version) return { outcome: 'continue', hidden };

      log.info(`updater: asking the release feed whether ${p.version} is still the latest before installing it (up to ${Math.round(startTimeout / 1000)} s)`);
      deps.checking?.(p.version);
      const deadline = clock.now() + startTimeout;
      const [busy, verdict] = await Promise.all([
        withTimeout(deps.busyAtStart(), startTimeout, clock).then(
          (b) => (b === TIMEOUT ? `Castcade could not tell within ${Math.round(startTimeout / 1000)} s whether VPX or a match is on` : b),
          (e: unknown) => `Castcade could not tell whether VPX or a match is on (${e instanceof Error ? e.message : String(e)})`,
        ),
        confirm(p.version, deadline),
      ]);
      switch (verdict.kind) {
        case 'confirmed': {
          const why = busy ?? deps.heldAtStart?.() ?? null;
          if (why) {
            log.info(`updater: not installing ${p.version} at start: ${why}; it is offered instead`);
            return { outcome: 'continue', hidden };
          }
          log.info(`updater: ${p.version} is the latest release and its download checks out`);
          if (await install('start')) return { outcome: 'installing', version: p.version };
          return { outcome: 'continue', hidden };
        }
        case 'stale':
          log.info(`updater: the downloaded ${p.version} is out of date (${verdict.latest} is the latest): not installing it; ${verdict.latest} downloads now and is offered when it is ready`);
          return { outcome: 'continue', hidden };
        case 'none':
          log.info(`updater: the release feed offers nothing newer than ${appVersion} (latest ${verdict.latest ?? 'unknown'}): the downloaded ${p.version} is not installed`);
          return { outcome: 'continue', hidden };
        case 'timeout':
          log.info(`updater: the release feed did not confirm ${p.version} within ${Math.round(startTimeout / 1000)} s: starting without installing; it is offered once confirmed`);
          return { outcome: 'continue', hidden };
        case 'unreachable':
          log.info(`updater: could not confirm ${p.version} (${verdict.why}): starting without installing; it is offered once confirmed`);
          return { outcome: 'continue', hidden };
      }
    },
    startChecks() {
      if (stopped) return;
      if (startCheck !== null) schedule(startCheck);
      else void check().then(schedule);
    },
    status,
    pendingVersion: () => ready,
    requestInstall() {
      if (!ready) return { go: false, why: 'no update is downloaded' };
      if (installing) return { go: false, why: null };
      // Before anything is shut down for it: the downloaded installer must still be there.
      if (readyFileGone()) return { go: false, why: 'its download is gone: Castcade downloads it again' };
      const waiting = deps.busy();
      if (waiting) {
        log.info(`updater: Restart and update to ${ready} refused: it waits ${waiting}`);
        lastWaiting = waiting;
        emit();
        return { go: false, why: waiting };
      }
      installing = true;
      log.info(`updater: Restart and update to ${ready} pressed: shutting down in order, then the installer`);
      emit();
      return { go: true };
    },
    install,
    refresh() {
      if (!ready || installing) return;
      const waiting = deps.busy();
      if (waiting === lastWaiting) return;
      const was = lastWaiting;
      lastWaiting = waiting;
      if (waiting) log.info(`updater: ${ready} waits ${waiting}`);
      else log.info(`updater: ${ready} can be installed now (it waited ${was})`);
      emit();
      if (!waiting && !freed.has(ready)) {
        freed.add(ready);
        notice({ kind: 'free', version: ready });
      }
    },
    onStatus(cb) {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    onNotice(cb) {
      noticeCbs.add(cb);
      // A download confirmed at start reported "nothing waits" before the witness or a match existed: say it as of now.
      for (const n of held.splice(0)) cb(n.kind === 'ready' ? { ...n, waiting: n.version === ready && !installing ? deps.busy() : n.waiting } : n);
      lastWaiting = ready && !installing ? deps.busy() : lastWaiting;
      return () => noticeCbs.delete(cb);
    },
    stop() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * The end of Restart and update, after the shell's orderly shutdown (witness, match, helpers stopped): the installer,
 * or, when it could not be started, Castcade again (`relaunch` + `quit`; the services are already down). That start
 * reads the note `install` left (`started: false`) and offers the update instead of installing it, so it cannot walk
 * straight into another try.
 */
export async function installAfterShutdown(o: { updates: UpdateController; relaunch(): void; quit(): void; warn(line: string): void }): Promise<'installing' | 'relaunched'> {
  if (await o.updates.install('offer')) return 'installing';
  o.warn('quit: the installer could not be started; Castcade starts again and says so');
  o.relaunch();
  o.quit();
  return 'relaunched';
}
