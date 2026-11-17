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

/** Interval between successful checks. A tray app can run for days; one check at launch is not enough. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Retry delay after a failed check (offline at boot, GitHub hiccup, release still being uploaded). */
export const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
/** At start, how long the release feed may take to confirm a waiting download before Castcade starts without it. */
export const START_CHECK_TIMEOUT_MS = 10_000;
/** The note of an install Castcade started (`<userData>/update-install.json`). */
export const INSTALL_MARKER_FILE = 'update-install.json';
/** electron-updater's cache folder under %LOCALAPPDATA% when app-update.yml cannot be read (electron-builder derives it from the package name). */
export const DEFAULT_CACHE_DIR_NAME = '@castcadecompanion-updater';
/** The installer's file name (`artifactName` in electron-builder.yml): the version of a cached download is read from it. */
const INSTALLER_NAME = /^Castcade-Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.exe$/i;

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

/** The version in an installer's file name (`Castcade-Setup-0.2.46.exe`), else null. */
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

export function readPendingInstaller(o: { dir: string; appVersion: string; readText(path: string): string | null; exists(path: string): boolean }): PendingRead {
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
  return { version: r.version, fileName: r.fileName, at: r.at, from: r.from === 'start' ? 'start' : 'offer', hidden: r.hidden === true };
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
  if (s.match && (s.match.role !== 'none' || s.match.phase === 'connecting')) return 'until you leave the match';
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
  /** BaseUpdater.install: starts the installer (true) without quitting; Castcade quits itself after it. */
  install(isSilent: boolean, isForceRunAfter: boolean): boolean;
}

/**
 * The settings Castcade runs electron-updater with. `autoInstallOnAppQuit` off: a quit never installs (BaseUpdater's
 * quit handler is then never added). `autoRunAppAfterInstall` on: a visible install gets `--force-run` (installer.nsh
 * starts Castcade at its end).
 */
export function configureUpdater(u: UpdaterLike, log: Logger, onDownloaded: (version: string, file: string | null) => void): void {
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
  /** The install of `ready` started before did not finish (the installer was closed or failed). */
  failedBefore: boolean;
}

export type UpdateNotice = { kind: 'ready'; version: string; waiting: string | null } | { kind: 'free'; version: string } | { kind: 'updated'; version: string };

export type StartOutcome =
  /** Start Castcade as usual. `hidden`: the start before the install was `--hidden`, keep this one in the tray. */
  | { outcome: 'continue'; hidden: boolean }
  /** The installer has been started and Castcade is quitting: start nothing. */
  | { outcome: 'installing'; version: string }
  /** An install Castcade started is still running: say so and leave (the installer starts Castcade at its end). */
  | { outcome: 'install_running'; version: string };

export interface UpdateControllerDeps {
  log: Logger;
  appVersion: string;
  /** Null when electron-updater could not be loaded: nothing is offered or installed. */
  updater: UpdaterLike | null;
  clock?: Clock;
  /** Why an install has to wait right now (`installWaitReason`), else null. */
  busy(): string | null;
  /** At start, before anything runs: a VPX already open, a match to go back to; null when nothing. */
  busyAtStart(): Promise<string | null>;
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
  /** Starts the installer visibly and quits; false when there is nothing to install or the installer did not start. */
  install(from: 'offer' | 'start'): boolean;
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
  const clock = deps.clock ?? realClock;
  const startTimeout = deps.startCheckTimeoutMs ?? START_CHECK_TIMEOUT_MS;
  let ready: string | null = null;
  let readyFile: string | null = null;
  let installing = false;
  let failedBefore: string | null = null;
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
    failedBefore: ready !== null && failedBefore === ready,
  });
  const emit = (): void => {
    const s = status();
    for (const cb of statusCbs) cb(s);
  };
  const notice = (n: UpdateNotice): void => {
    if (noticeCbs.size === 0) held.push(n);
    for (const cb of noticeCbs) cb(n);
  };

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
    });
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
    const delay = nextCheckDelayMs(outcome);
    if (delay === null) return;
    timer = clock.setTimeout(() => {
      timer = null;
      void check().then(schedule);
    }, delay);
    // Never keep the process alive for a re-check.
    (timer as { unref?: () => void } | null)?.unref?.();
  };

  /** Whether the release feed's latest is `version` and electron-updater has it verified in its cache now. */
  const confirm = async (version: string): Promise<{ kind: 'confirmed' } | { kind: 'stale' | 'none'; latest: string | null } | { kind: 'timeout' } | { kind: 'unreachable'; why: string }> => {
    if (!updater) return { kind: 'unreachable', why: 'electron-updater is unavailable' };
    try {
      const r = await withTimeout(updater.checkForUpdates(), startTimeout, clock);
      if (r === TIMEOUT) return { kind: 'timeout' };
      if (!r || !r.isUpdateAvailable) {
        startCheck = 'ok';
        return { kind: 'none', latest: r?.updateInfo.version ?? null };
      }
      startCheck = 'ok';
      if (r.updateInfo.version !== version) return { kind: 'stale', latest: r.updateInfo.version };
      // The same version: electron-updater re-hashes the cached file against the feed's sha512 and reports it
      // downloaded (no download), or downloads it again when the file does not match.
      const d = await withTimeout(r.downloadPromise ?? Promise.resolve(), startTimeout, clock);
      if (d === TIMEOUT) return { kind: 'timeout' };
      if (ready !== version) return { kind: 'unreachable', why: `electron-updater did not report ${version} downloaded` };
      startCheck = 'downloaded';
      return { kind: 'confirmed' };
    } catch (e) {
      startCheck = 'failed';
      return { kind: 'unreachable', why: e instanceof Error ? e.message : String(e) };
    }
  };

  const install = (from: 'offer' | 'start'): boolean => {
    const version = ready;
    if (!updater || !version) {
      log.warn(`updater: install asked (${from}) but no downloaded update is ready`);
      installing = false;
      emit();
      return false;
    }
    const fileName = readyFile ? win32.basename(readyFile) : `Castcade-Setup-${version}.exe`;
    deps.marker.write({ version, fileName, at: clock.now(), from, hidden: from === 'start' && deps.hiddenStart });
    log.info(
      `updater: installing ${version} ${from === 'start' ? 'at start, before anything else' : 'from Restart and update'}: ` +
        'Castcade closes, the installer shows its progress and starts Castcade again when it is done',
    );
    let started = false;
    try {
      started = updater.install(false, true);
    } catch (e) {
      log.warn(`updater: ${describeError(e)}`);
    }
    if (!started) {
      deps.marker.remove();
      installing = false;
      log.warn(`updater: the installer of ${version} did not start (see the updater lines above)`);
      emit();
      return false;
    }
    installing = true;
    emit();
    deps.quit();
    return true;
  };

  return {
    async atStart() {
      const now = clock.now();
      let hidden = false;
      const m = deps.marker.read();
      if (m) {
        const age = Math.max(0, Math.round((now - m.at) / 1000));
        if (compareVersions(appVersion, m.version) >= 0) {
          log.info(`updater: updated to ${appVersion}: the install of ${m.version} ${m.from === 'start' ? 'at a start' : 'from Restart and update'} began ${age} s before this start`);
          deps.marker.remove();
          hidden = m.hidden;
          notice({ kind: 'updated', version: appVersion });
        } else if (await deps.installerRunning(m.fileName)) {
          log.warn(`updater: the installer of ${m.version} (${m.fileName}), started ${age} s ago, is still running; this start leaves at once (the installer starts Castcade when it is done)`);
          return { outcome: 'install_running', version: m.version };
        } else {
          log.warn(
            `updater: the install of ${m.version} begun ${age} s ago did not finish (its installer is not running and this is still ${appVersion}: ` +
              'it was closed or failed); not installing it again at this start, it is offered instead',
          );
          deps.marker.remove();
          failedBefore = m.version;
        }
      } else if (deps.startedByInstaller) {
        log.info(`updater: started by the installer after an update to ${appVersion}`);
        notice({ kind: 'updated', version: appVersion });
      }

      const p = deps.pending();
      log.info(`updater: at start: ${describePending(p, appVersion)}`);
      if (p.kind !== 'pending') return { outcome: 'continue', hidden };
      if (!updater) return { outcome: 'continue', hidden };
      if (failedBefore === p.version) return { outcome: 'continue', hidden };

      log.info(`updater: asking the release feed whether ${p.version} is still the latest before installing it (up to ${Math.round(startTimeout / 1000)} s)`);
      deps.checking?.(p.version);
      const [busy, verdict] = await Promise.all([
        withTimeout(deps.busyAtStart(), startTimeout, clock).catch((e: unknown) => {
          log.warn(`updater: could not tell whether a table or a match is on (${describeError(e)}); taken as none`);
          return null;
        }),
        confirm(p.version),
      ]);
      const why = busy === TIMEOUT ? null : busy;
      switch (verdict.kind) {
        case 'confirmed':
          if (why) {
            log.info(`updater: not installing ${p.version} at start: ${why}; it is offered once that is over`);
            return { outcome: 'continue', hidden };
          }
          log.info(`updater: ${p.version} is the latest release and its download checks out`);
          if (install('start')) return { outcome: 'installing', version: p.version };
          return { outcome: 'continue', hidden };
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
