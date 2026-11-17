import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import type { Logger } from './log.js';
import {
  CHECK_INTERVAL_MS,
  RETRY_AFTER_FAILURE_MS,
  START_CHECK_TIMEOUT_MS,
  DEFAULT_CACHE_DIR_NAME,
  cacheDirName,
  compareVersions,
  configureUpdater,
  createInstallerProbe,
  createMarkerStore,
  createUpdateController,
  installWaitReason,
  installerVersion,
  nextCheckDelayMs,
  parseMarker,
  readPendingInstaller,
  tasklistHas,
  type InstallMarker,
  type PendingRead,
  type UpdateNotice,
  type UpdaterLike,
} from './updater.js';

describe('nextCheckDelayMs', () => {
  it('re-checks every few hours after a successful check (tray apps run for days)', () => {
    expect(nextCheckDelayMs('ok')).toBe(CHECK_INTERVAL_MS);
    expect(CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(CHECK_INTERVAL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('retries sooner after a failed check (offline at boot, 404 while a release uploads)', () => {
    expect(nextCheckDelayMs('failed')).toBe(RETRY_AFTER_FAILURE_MS);
    expect(RETRY_AFTER_FAILURE_MS).toBeLessThan(CHECK_INTERVAL_MS);
    expect(RETRY_AFTER_FAILURE_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('stops once an update is downloaded; it is offered, and installs from the offer or at the next start', () => {
    expect(nextCheckDelayMs('downloaded')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------- fakes --

type CheckResult = Awaited<ReturnType<UpdaterLike['checkForUpdates']>>;

/** electron-updater as Castcade drives it; `install` only records (no test runs an installer). */
class FakeUpdater implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = false;
  logger: unknown = null;
  installs: Array<[boolean, boolean]> = [];
  installResult = true;
  checks = 0;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  /** What the next checkForUpdates does: by default the release feed has nothing newer. */
  next: () => Promise<CheckResult> = async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.2.45' } });

  constructor(private readonly order: string[]) {}
  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as unknown as (...args: unknown[]) => void);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  checkForUpdates(): Promise<CheckResult> {
    this.checks += 1;
    this.order.push('check');
    return this.next();
  }
  install(isSilent: boolean, isForceRunAfter: boolean): boolean {
    this.order.push('install');
    this.installs.push([isSilent, isForceRunAfter]);
    return this.installResult;
  }
  /**
   * The feed's latest is `version` and its download checks out: electron-updater emits update-downloaded (from its
   * cache, or after downloading) before the download promise resolves.
   */
  offers(version: string): void {
    this.next = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version },
      downloadPromise: Promise.resolve().then(() => this.emit('update-downloaded', { version, downloadedFile: `C:\\Users\\p\\AppData\\Local\\@castcadecompanion-updater\\pending\\Castcade-Setup-${version}.exe` })),
    });
  }
}

const memLog = (lines: string[]): Logger => ({
  file: '',
  debug: (l) => void lines.push(l),
  info: (l) => void lines.push(l),
  warn: (l) => void lines.push(l),
  error: (l) => void lines.push(l),
});

const pendingOf = (version: string): PendingRead => ({ kind: 'pending', version, fileName: `Castcade-Setup-${version}.exe`, file: `C:\\cache\\pending\\Castcade-Setup-${version}.exe` });

function rig(o: { appVersion?: string; pending?: PendingRead; marker?: InstallMarker | null; installerRunning?: boolean; busy?: string | null; busyAtStart?: string | null; hiddenStart?: boolean; startedByInstaller?: boolean } = {}) {
  const order: string[] = [];
  const clock = new ManualClock();
  const u = new FakeUpdater(order);
  const logs: string[] = [];
  const notices: UpdateNotice[] = [];
  const state = {
    busy: o.busy ?? null,
    busyAtStart: o.busyAtStart ?? null,
    pending: o.pending ?? ({ kind: 'none' } as PendingRead),
    installerRunning: o.installerRunning ?? false,
    marker: o.marker ?? null,
    quits: 0,
  };
  const c = createUpdateController({
    log: memLog(logs),
    appVersion: o.appVersion ?? '0.2.45',
    updater: u,
    clock,
    busy: () => state.busy,
    busyAtStart: async () => {
      order.push('busyAtStart');
      return state.busyAtStart;
    },
    pending: () => {
      order.push('pending');
      return state.pending;
    },
    marker: {
      read: () => state.marker,
      write: (m) => {
        state.marker = m;
      },
      remove: () => {
        state.marker = null;
      },
    },
    installerRunning: async (name) => {
      order.push(`installerRunning ${name}`);
      return state.installerRunning;
    },
    hiddenStart: o.hiddenStart ?? false,
    startedByInstaller: o.startedByInstaller ?? false,
    checking: (v) => order.push(`checking ${v}`),
    quit: () => {
      state.quits += 1;
      order.push('quit');
    },
  });
  return { c, u, clock, logs, notices, state, order, listen: () => c.onNotice((n) => notices.push(n)) };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// ------------------------------------------------------------------------------------- E9 --

describe('a quit with a downloaded update (E9)', () => {
  it('does not install: autoInstallOnAppQuit is off, and an install is visible with Castcade run after it', async () => {
    const r = rig();
    expect(r.u.autoInstallOnAppQuit).toBe(false);
    expect(r.u.autoRunAppAfterInstall).toBe(true);
    expect(r.u.autoDownload).toBe(true);
    expect(r.u.allowPrerelease).toBe(true);
    r.u.offers('0.2.46');
    r.c.startChecks();
    await flush();
    expect(r.c.status()).toEqual({ ready: '0.2.46', waiting: null, installing: false, failedBefore: false });
    // The tray's Quit: the shell stops the checks and quits; nothing installs.
    r.c.stop();
    expect(r.u.installs).toEqual([]);
    expect(r.state.quits).toBe(0);
    expect(r.state.marker).toBeNull();
    expect(r.logs.some((l) => l.includes('downloaded 0.2.46') && l.includes('at the next start'))).toBe(true);
  });

  it('with the real electron-updater: no install-on-quit handler is added once a download is done', async () => {
    const { NsisUpdater } = await import('electron-updater');
    const app = (handlers: unknown[]) => ({
      version: '0.2.45',
      name: 'Castcade',
      isPackaged: true,
      appUpdateConfigPath: '',
      userDataPath: '',
      baseCachePath: '',
      whenReady: () => Promise.resolve(),
      relaunch: () => undefined,
      quit: () => undefined,
      onQuit: (h: (exitCode: number) => void) => void handlers.push(h),
    });
    // BaseUpdater.executeDownload calls addQuitHandler when a download is done; it registers app.onQuit only with
    // autoInstallOnAppQuit on (the 0.2.43 → 0.2.44 quit on the owner's PC: "Auto install update on quit").
    const before: unknown[] = [];
    const old = new NsisUpdater(null, app(before));
    (old as unknown as { addQuitHandler(): void }).addQuitHandler();
    expect(before).toHaveLength(1);
    const now: unknown[] = [];
    const u = new NsisUpdater(null, app(now));
    configureUpdater(u as unknown as UpdaterLike, memLog([]), () => undefined);
    (u as unknown as { addQuitHandler(): void }).addQuitHandler();
    expect(now).toHaveLength(0);
  });
});

describe('the offer (E9)', () => {
  it('is said when the download is done; Restart and update shuts down first, then starts the installer shown, then quits', async () => {
    const r = rig();
    r.listen();
    r.u.offers('0.2.46');
    r.c.startChecks();
    await flush();
    expect(r.notices).toEqual([{ kind: 'ready', version: '0.2.46', waiting: null }]);
    expect(r.c.requestInstall()).toEqual({ go: true });
    expect(r.c.status().installing).toBe(true);
    expect(r.u.installs).toEqual([]); // the shell's orderly shutdown runs before the installer
    expect(r.c.requestInstall()).toEqual({ go: false, why: null }); // a second press does nothing
    expect(r.c.install('offer')).toBe(true);
    // Not silent (the installer shows its progress); force-run: the installer starts Castcade at its end.
    expect(r.u.installs).toEqual([[false, true]]);
    expect(r.state.quits).toBe(1);
    expect(r.order.slice(-2)).toEqual(['install', 'quit']);
    expect(r.state.marker).toMatchObject({ version: '0.2.46', fileName: 'Castcade-Setup-0.2.46.exe', from: 'offer', hidden: false });
  });

  it('an installer that does not start leaves Castcade running and no note behind', async () => {
    const r = rig();
    r.u.offers('0.2.46');
    r.c.startChecks();
    await flush();
    r.u.installResult = false;
    expect(r.c.requestInstall()).toEqual({ go: true });
    expect(r.c.install('offer')).toBe(false);
    expect(r.state.quits).toBe(0);
    expect(r.state.marker).toBeNull();
    expect(r.c.status().installing).toBe(false);
  });

  it('with nothing downloaded there is nothing to install', () => {
    const r = rig();
    expect(r.c.requestInstall()).toEqual({ go: false, why: 'no update is downloaded' });
    expect(r.c.install('offer')).toBe(false);
    expect(r.u.installs).toEqual([]);
    expect(r.state.quits).toBe(0);
  });
});

describe('nothing installs or restarts during a game, a match or a 3D watch session (E9)', () => {
  it('the wait reasons', () => {
    const none = { match: null, watch: false, table: null, vpx: false, recording: false };
    expect(installWaitReason(none)).toBeNull();
    expect(installWaitReason({ ...none, match: { role: 'none', phase: 'none' } })).toBeNull();
    for (const phase of ['lobby', 'playing', 'paused', 'over']) expect(installWaitReason({ ...none, match: { role: 'client', phase } })).toBe('until you leave the match');
    expect(installWaitReason({ ...none, match: { role: 'host', phase: 'lobby' } })).toBe('until you leave the match');
    expect(installWaitReason({ ...none, match: { role: 'none', phase: 'connecting' } })).toBe('until you leave the match');
    expect(installWaitReason({ ...none, watch: true })).toBe('until you leave the 3D watch session');
    expect(installWaitReason({ ...none, table: 'Monster Bash (Williams 1998)', vpx: true })).toBe('until Monster Bash (Williams 1998) is closed');
    expect(installWaitReason({ ...none, vpx: true })).toBe('until VPX is closed');
    expect(installWaitReason({ ...none, recording: true })).toBe('until the recording or stream stops');
  });

  for (const why of ['until you leave the match', 'until you leave the 3D watch session', 'until Monster Bash (Williams 1998) is closed']) {
    it(`Restart and update is refused ${why}, and offered again (once) when it is over`, async () => {
      const r = rig({ busy: why });
      r.listen();
      r.u.offers('0.2.46');
      r.c.startChecks();
      await flush();
      expect(r.notices).toEqual([{ kind: 'ready', version: '0.2.46', waiting: why }]);
      expect(r.c.status()).toMatchObject({ ready: '0.2.46', waiting: why, installing: false });
      expect(r.c.requestInstall()).toEqual({ go: false, why });
      expect(r.c.status().installing).toBe(false);
      expect(r.u.installs).toEqual([]);
      expect(r.state.quits).toBe(0);
      expect(r.logs.some((l) => l.includes(`refused: it waits ${why}`))).toBe(true);

      r.state.busy = null;
      r.c.refresh();
      expect(r.notices.at(-1)).toEqual({ kind: 'free', version: '0.2.46' });
      r.state.busy = why;
      r.c.refresh();
      r.state.busy = null;
      r.c.refresh();
      expect(r.notices.filter((n) => n.kind === 'free')).toHaveLength(1);
      expect(r.c.requestInstall()).toEqual({ go: true });
    });
  }

  it('a waiting update found at start is not installed while VPX is open or a match is to be rejoined', async () => {
    for (const why of ['VPX is open (VPinballX_GL64.exe, pid 4242)', 'Castcade was in match ABCDEF when it closed']) {
      const r = rig({ appVersion: '0.2.45', pending: pendingOf('0.2.46'), busyAtStart: why });
      r.u.offers('0.2.46');
      await expect(r.c.atStart()).resolves.toEqual({ outcome: 'continue', hidden: false });
      expect(r.u.installs).toEqual([]);
      expect(r.state.quits).toBe(0);
      expect(r.c.status().ready).toBe('0.2.46'); // offered instead
      expect(r.logs.some((l) => l.includes(`not installing 0.2.46 at start: ${why}`))).toBe(true);
    }
  });
});

describe('at start (E9)', () => {
  it('an update downloaded before the last close is confirmed and installed before anything else', async () => {
    const r = rig({ appVersion: '0.2.45', pending: pendingOf('0.2.46') });
    r.u.offers('0.2.46');
    await expect(r.c.atStart()).resolves.toEqual({ outcome: 'installing', version: '0.2.46' });
    expect(r.order).toEqual(['pending', 'checking 0.2.46', 'busyAtStart', 'check', 'install', 'quit']);
    expect(r.u.installs).toEqual([[false, true]]);
    expect(r.state.marker).toMatchObject({ version: '0.2.46', from: 'start', hidden: false });
    expect(r.logs).toContain('updater: at start: 0.2.46 was downloaded (Castcade-Setup-0.2.46.exe) and is not installed');
    expect(r.logs.some((l) => l.includes('installing 0.2.46 at start, before anything else'))).toBe(true);
  });

  it('a stale download (a newer release is out) is not installed: the newer one downloads and is offered', async () => {
    const r = rig({ appVersion: '0.2.43', pending: pendingOf('0.2.44') });
    let downloaded: () => void = () => undefined;
    r.u.next = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '0.2.45' },
      downloadPromise: new Promise<void>((resolve) => {
        downloaded = () => {
          r.u.emit('update-downloaded', { version: '0.2.45', downloadedFile: 'C:\\cache\\pending\\Castcade-Setup-0.2.45.exe' });
          resolve();
        };
      }),
    });
    await expect(r.c.atStart()).resolves.toEqual({ outcome: 'continue', hidden: false });
    expect(r.u.installs).toEqual([]);
    expect(r.state.quits).toBe(0);
    expect(r.c.status().ready).toBeNull();
    expect(r.logs.some((l) => l.includes('the downloaded 0.2.44 is out of date (0.2.45 is the latest)'))).toBe(true);
    downloaded();
    await flush();
    expect(r.c.status()).toMatchObject({ ready: '0.2.45', waiting: null });
  });

  it('offline: Castcade starts without installing, and offers it once a later check confirms it', async () => {
    const r = rig({ pending: pendingOf('0.2.46') });
    r.u.next = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await expect(r.c.atStart()).resolves.toEqual({ outcome: 'continue', hidden: false });
    expect(r.u.installs).toEqual([]);
    expect(r.logs.some((l) => l.includes('could not confirm 0.2.46 (net::ERR_INTERNET_DISCONNECTED)'))).toBe(true);
    // The schedule goes on from that failed check: the retry finds it (from electron-updater's cache) and offers it.
    r.c.startChecks();
    r.u.offers('0.2.46');
    r.clock.advance(RETRY_AFTER_FAILURE_MS);
    await flush();
    expect(r.c.status().ready).toBe('0.2.46');
    expect(r.u.installs).toEqual([]);
  });

  it('a release feed that does not answer holds the start for 10 s at most', async () => {
    const r = rig({ pending: pendingOf('0.2.46') });
    r.u.next = () => new Promise(() => undefined);
    const start = r.c.atStart();
    await flush();
    r.clock.advance(START_CHECK_TIMEOUT_MS);
    await expect(start).resolves.toEqual({ outcome: 'continue', hidden: false });
    expect(r.u.installs).toEqual([]);
    expect(r.logs.some((l) => l.includes('did not confirm 0.2.46 within 10 s'))).toBe(true);
  });

  it('nothing waiting: no check at start, the schedule checks once the app is up', async () => {
    const r = rig();
    await expect(r.c.atStart()).resolves.toEqual({ outcome: 'continue', hidden: false });
    expect(r.u.checks).toBe(0);
    expect(r.logs).toContain('updater: at start: nothing downloaded is waiting');
    r.c.startChecks();
    await flush();
    expect(r.u.checks).toBe(1);
  });

  it('a feed that has nothing newer leaves the download alone', async () => {
    const r = rig({ pending: pendingOf('0.2.46') });
    await expect(r.c.atStart()).resolves.toEqual({ outcome: 'continue', hidden: false });
    expect(r.u.installs).toEqual([]);
    expect(r.logs.some((l) => l.includes('offers nothing newer than 0.2.45'))).toBe(true);
  });
});

describe('the install Castcade started, at the next start (E9)', () => {
  const marker = (o: Partial<InstallMarker> = {}): InstallMarker => ({ version: '0.2.46', fileName: 'Castcade-Setup-0.2.46.exe', at: new ManualClock().now() - 75_000, from: 'offer', hidden: false, ...o });

  it('on the new version: logged as done, the note removed, a balloon; a hidden start stays hidden', async () => {
    const r = rig({ appVersion: '0.2.46', marker: marker({ from: 'start', hidden: true }), pending: { kind: 'leftover', version: '0.2.46' } });
    await expect(r.c.atStart()).resolves.toEqual({ outcome: 'continue', hidden: true });
    expect(r.state.marker).toBeNull();
    expect(r.logs.some((l) => l.includes('updated to 0.2.46: the install of 0.2.46 at a start began 75 s before this start'))).toBe(true);
    r.listen();
    expect(r.notices).toEqual([{ kind: 'updated', version: '0.2.46' }]);
  });

  it('a start while that installer still runs leaves at once, without touching the update', async () => {
    const r = rig({ appVersion: '0.2.45', marker: marker(), installerRunning: true, pending: pendingOf('0.2.46') });
    await expect(r.c.atStart()).resolves.toEqual({ outcome: 'install_running', version: '0.2.46' });
    expect(r.order).toEqual(['installerRunning Castcade-Setup-0.2.46.exe']);
    expect(r.u.checks).toBe(0);
    expect(r.u.installs).toEqual([]);
    expect(r.state.marker).not.toBeNull(); // the start after the install reads it
    expect(r.logs.some((l) => l.includes('is still running; this start leaves at once'))).toBe(true);
  });

  it('an install that did not finish is offered, not run again at that start', async () => {
    const r = rig({ appVersion: '0.2.45', marker: marker(), installerRunning: false, pending: pendingOf('0.2.46') });
    r.u.offers('0.2.46');
    await expect(r.c.atStart()).resolves.toEqual({ outcome: 'continue', hidden: false });
    expect(r.u.checks).toBe(0);
    expect(r.u.installs).toEqual([]);
    expect(r.state.marker).toBeNull();
    expect(r.logs.some((l) => l.includes('did not finish'))).toBe(true);
    r.c.startChecks();
    await flush();
    expect(r.c.status()).toEqual({ ready: '0.2.46', waiting: null, installing: false, failedBefore: true });
  });

  it('started by the installer with no note (an older Castcade installed it when it quit): a balloon says so', async () => {
    const r = rig({ appVersion: '0.2.46', startedByInstaller: true });
    r.listen();
    await r.c.atStart();
    expect(r.notices).toEqual([{ kind: 'updated', version: '0.2.46' }]);
    expect(r.logs).toContain('updater: started by the installer after an update to 0.2.46');
  });
});

// ------------------------------------------------------------------------------- the cache --

describe("electron-updater's download cache", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const fsOf = (files: Record<string, string>) => ({
    readText: (p: string) => files[p] ?? null,
    exists: (p: string) => p in files,
  });
  const dir = join('cache', 'pending');
  const info = (fileName: unknown) => JSON.stringify({ fileName, sha512: 'x', isAdminRightsRequired: false });

  it('reads the waiting installer and its version from update-info.json', () => {
    const files = { [join(dir, 'update-info.json')]: info('Castcade-Setup-0.2.46.exe'), [join(dir, 'Castcade-Setup-0.2.46.exe')]: 'MZ' };
    expect(readPendingInstaller({ dir, appVersion: '0.2.45', ...fsOf(files) })).toEqual({ kind: 'pending', version: '0.2.46', fileName: 'Castcade-Setup-0.2.46.exe', file: join(dir, 'Castcade-Setup-0.2.46.exe') });
  });

  it('a file for the running version or an older one is a leftover of an earlier update', () => {
    const files = { [join(dir, 'update-info.json')]: info('Castcade-Setup-0.2.44.exe'), [join(dir, 'Castcade-Setup-0.2.44.exe')]: 'MZ' };
    expect(readPendingInstaller({ dir, appVersion: '0.2.44', ...fsOf(files) })).toEqual({ kind: 'leftover', version: '0.2.44' });
    expect(readPendingInstaller({ dir, appVersion: '0.2.45', ...fsOf(files) })).toEqual({ kind: 'leftover', version: '0.2.44' });
  });

  it('nothing, or nothing usable', () => {
    expect(readPendingInstaller({ dir, appVersion: '0.2.45', ...fsOf({}) })).toEqual({ kind: 'none' });
    expect(readPendingInstaller({ dir, appVersion: '0.2.45', ...fsOf({ [join(dir, 'update-info.json')]: '{' }) }).kind).toBe('unreadable');
    expect(readPendingInstaller({ dir, appVersion: '0.2.45', ...fsOf({ [join(dir, 'update-info.json')]: info('..\\evil.exe') }) }).kind).toBe('unreadable');
    expect(readPendingInstaller({ dir, appVersion: '0.2.45', ...fsOf({ [join(dir, 'update-info.json')]: info('Other-0.3.0.exe') }) }).kind).toBe('unreadable');
    expect(readPendingInstaller({ dir, appVersion: '0.2.45', ...fsOf({ [join(dir, 'update-info.json')]: info('Castcade-Setup-0.2.46.exe') }) })).toEqual({
      kind: 'unreadable',
      why: 'Castcade-Setup-0.2.46.exe is named in update-info.json but not there',
    });
  });

  it("matches what the installed electron-updater writes (DownloadedUpdateHelper's update-info.json)", async () => {
    const root = mkdtempSync(join(tmpdir(), 'castcade-updater-'));
    dirs.push(root);
    const { DownloadedUpdateHelper } = (await import('electron-updater/out/DownloadedUpdateHelper.js')) as unknown as {
      DownloadedUpdateHelper: new (cacheDir: string) => {
        cacheDirForPendingUpdate: string;
        setDownloadedFile(file: string, packageFile: string | null, versionInfo: unknown, fileInfo: unknown, updateFileName: string, isSaveCache: boolean): Promise<void>;
      };
    };
    const helper = new DownloadedUpdateHelper(join(root, DEFAULT_CACHE_DIR_NAME));
    const file = join(helper.cacheDirForPendingUpdate, 'Castcade-Setup-0.2.46.exe');
    mkdirSync(helper.cacheDirForPendingUpdate, { recursive: true });
    writeFileSync(file, 'MZ');
    await helper.setDownloadedFile(file, null, { version: '0.2.46' }, { info: { sha512: 'abc', url: 'Castcade-Setup-0.2.46.exe' } }, 'Castcade-Setup-0.2.46.exe', true);
    const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
    expect(readPendingInstaller({ dir: helper.cacheDirForPendingUpdate, appVersion: '0.2.45', readText: read, exists: existsSync })).toEqual({ kind: 'pending', version: '0.2.46', fileName: 'Castcade-Setup-0.2.46.exe', file });
  });

  it("finds the cache folder from app-update.yml (electron-builder quotes a name that starts with '@')", () => {
    expect(cacheDirName("owner: mekelburgj20\nrepo: castcade\nprovider: github\nupdaterCacheDirName: '@castcadecompanion-updater'\n")).toBe('@castcadecompanion-updater');
    expect(cacheDirName('updaterCacheDirName: castcade-updater\n')).toBe('castcade-updater');
    expect(cacheDirName(null)).toBe(DEFAULT_CACHE_DIR_NAME);
    expect(cacheDirName('updaterCacheDirName: ..\\..\\Windows\n')).toBe(DEFAULT_CACHE_DIR_NAME);
  });

  it('orders versions and reads them from installer names', () => {
    expect(compareVersions('0.2.46', '0.2.45')).toBeGreaterThan(0);
    expect(compareVersions('0.2.45', '0.2.45')).toBe(0);
    expect(compareVersions('0.2.9', '0.2.10')).toBeLessThan(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBeLessThan(0);
    expect(compareVersions('nonsense', '0.2.45')).toBeNaN();
    expect(installerVersion('Castcade-Setup-0.2.46.exe')).toBe('0.2.46');
    expect(installerVersion('Castcade-Setup-0.2.46.exe.blockmap')).toBeNull();
  });
});

describe('the install note and the installer probe', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('keeps the note across a restart, and rejects anything that is not one', () => {
    const d = mkdtempSync(join(tmpdir(), 'castcade-marker-'));
    dirs.push(d);
    const warns: string[] = [];
    const store = createMarkerStore(join(d, 'update-install.json'), (l) => void warns.push(l));
    expect(store.read()).toBeNull();
    const m: InstallMarker = { version: '0.2.46', fileName: 'Castcade-Setup-0.2.46.exe', at: 1_700_000_000_000, from: 'start', hidden: true };
    store.write(m);
    expect(store.read()).toEqual(m);
    store.remove();
    expect(store.read()).toBeNull();
    expect(warns).toEqual([]);
    expect(parseMarker('{"version":"0.2.46","fileName":"setup.exe","at":1}')).toBeNull();
    expect(parseMarker('{"version":"x","fileName":"Castcade-Setup-0.2.46.exe","at":1}')).toBeNull();
    expect(parseMarker('not json')).toBeNull();
  });

  it("reads tasklist's answer", () => {
    expect(tasklistHas('"Castcade-Setup-0.2.46.exe","9876","Console","1","12,345 K"\r\n', 'Castcade-Setup-0.2.46.exe')).toBe(true);
    expect(tasklistHas('INFO: No tasks are running which match the specified criteria.\r\n', 'Castcade-Setup-0.2.46.exe')).toBe(false);
    expect(tasklistHas('"Castcade-Setup-0.2.46.exe.old","1","Console","1","1 K"', 'Castcade-Setup-0.2.46.exe')).toBe(false);
  });

  it('asks tasklist for exactly that image name, and a failure reads as not running', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const answer = { err: null as Error | null, out: '"Castcade-Setup-0.2.46.exe","9876","Console","1","12,345 K"' };
    const probe = createInstallerProbe((file, args, _opts, cb) => {
      calls.push({ file, args });
      cb(answer.err, answer.out);
    });
    await expect(probe('Castcade-Setup-0.2.46.exe')).resolves.toBe(true);
    expect(calls[0]).toEqual({ file: 'tasklist.exe', args: ['/FI', 'IMAGENAME eq Castcade-Setup-0.2.46.exe', '/FO', 'CSV', '/NH'] });
    answer.err = new Error('tasklist failed');
    await expect(probe('Castcade-Setup-0.2.46.exe')).resolves.toBe(false);
    await expect(probe('notepad.exe')).resolves.toBe(false);
    expect(calls).toHaveLength(2);
  });
});
