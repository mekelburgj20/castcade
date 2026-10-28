/**
 * Electron main process entry (Phase 2: tray app + Arcaid Witness producer).
 *
 * Order matters: `--smoke` prints the bundle identity and exits before anything else (no window,
 * no tray, no settings file; CI runs it on a headless Windows runner). Then the single-instance
 * lock, then on `ready`: logger → settings store → witness host → window → tray → IPC → updater.
 * Closing the window hides it to the tray; only the tray's Quit (or the app's own update restart)
 * ends the process.
 */
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@castcade/protocol';
import { isAllowedExternalUrl } from './allowlist.js';
import { IPC, type AppVersions, type LoginItemState } from './ipc-types.js';
import { createLogger, describeError, type Logger } from './log.js';
import {
  DEFAULT_ARCAID_BASE_URL,
  openSettingsStore,
  plainTokenCodec,
  redactSettings,
  sanitizePatch,
  type SettingsStore,
  type TokenCodec,
} from './settings.js';
import { createTray, type TrayHandle } from './tray.js';
import { startUpdater, type UpdaterHandle } from './updater.js';
import { createWitnessHost, needsWitnessRestart, type WitnessHost } from './witness-host.js';
import { createTablesHost, type TablesHost } from './tables-host.js';
import { SidecarWatch } from './sidecar-watch.js';
import { manifestDirFor } from '../witness/witness.js';
import { createOverlayServer, overlayStateFrom, type OverlayServer } from '../media/overlay-server.js';
import { resolveFfmpeg } from '../media/ffmpeg-path.js';
import { createStreamHost, type StreamHost } from './stream-host.js';

const here = dirname(fileURLToPath(import.meta.url)); // <companion>/dist/main
const companionDir = resolve(here, '..', '..');
const appVersion = app.getVersion();
const argv = process.argv.slice(1);

let quitting = false;
let win: BrowserWindow | null = null;
let log: Logger | null = null;
let tray: TrayHandle | null = null;
let sidecarWatch: SidecarWatch | null = null;
let updater: UpdaterHandle | null = null;
/** D1.1: the OBS overlay page on 127.0.0.1; null until started (or when its port was taken). */
let overlay: OverlayServer | null = null;
/** D1.2 / D1.3: recording and streaming. */
let stream: StreamHost | null = null;

if (argv.includes('--smoke')) {
  // D1.6: which ffmpeg this build would stream with (`bundled <build>` from the installer, else `path`).
  const ff = resolveFfmpeg({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, companionDir });
  process.stdout.write(`castcade ${appVersion} protocol ${PROTOCOL_VERSION} ffmpeg ${ff.source === 'bundled' ? `bundled ${ff.build ?? '?'}` : 'path'}\n`);
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.setAppUserModelId('app.arcaid.castcade');
  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => {
    /* tray app: keep running */
  });
  app.on('before-quit', () => {
    quitting = true;
    updater?.stop();
  });
  void app.whenReady().then(main);
}

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    win = createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 380,
    minHeight: 520,
    title: 'Castcade',
    show: false,
    autoHideMenuBar: true,
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    backgroundColor: '#14161a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(here, '..', 'preload', 'index.cjs'),
      // The sandboxed preload cannot read package.json or import @castcade/protocol; hand it
      // the two values on argv instead of opening an IPC channel for them.
      additionalArguments: [
        `--castcade-app-version=${appVersion}`,
        `--castcade-protocol-version=${PROTOCOL_VERSION}`,
      ],
    },
  });
  w.removeMenu();
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });

  const devUrl = process.env.CASTCADE_RENDERER_URL;
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(join(here, '..', 'renderer', 'index.html'));
  return w;
}

function tokenCodec(logger: Logger): TokenCodec {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      scheme: 'safeStorage',
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
    };
  }
  logger.warn('settings: OS encryption (safeStorage) unavailable; the witness token is stored in plain text');
  return plainTokenCodec;
}

function loginItemState(): LoginItemState {
  if (!app.isPackaged) return { supported: false, openAtLogin: false };
  return { supported: true, openAtLogin: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin };
}

function setLoginItem(openAtLogin: boolean): LoginItemState {
  if (!app.isPackaged) return loginItemState();
  app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] });
  log?.info(`login item: openAtLogin=${openAtLogin}`);
  return loginItemState();
}

async function quit(host: WitnessHost): Promise<void> {
  quitting = true;
  sidecarWatch?.stop();
  await overlay?.stop();
  await stream?.stop().catch(() => undefined);
  await host.stop();
  log?.info('quit');
  app.quit();
}

function registerIpc(store: SettingsStore, host: WitnessHost, tables: TablesHost, watch: SidecarWatch, logger: Logger, maybeStream: StreamHost | null): void {
  const sh = (): StreamHost => {
    if (!maybeStream) throw new Error('streaming is unavailable this run (see the log)');
    return maybeStream;
  };
  const str = (v: unknown, what: string): string => {
    if (typeof v !== 'string') throw new Error(`${what} must be a string`);
    return v;
  };
  ipcMain.handle(IPC.witnessStatus, () => host.status());
  ipcMain.handle(IPC.witnessPair, async (_e, code: unknown) => {
    try {
      return await host.pair(str(code, 'pairing code'));
    } catch (e) {
      logger.warn(`pair failed: ${describeError(e)}`);
      throw e;
    }
  });
  ipcMain.handle(IPC.witnessUnpair, () => host.unpair());
  ipcMain.handle(IPC.witnessSetPaused, (_e, paused: unknown) => host.setPaused(paused === true));
  ipcMain.handle(IPC.witnessConfirmTable, (_e, filePath: unknown, vpsTableId: unknown) => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('filePath must be a string');
    if (vpsTableId !== null && typeof vpsTableId !== 'string') throw new Error('vpsTableId must be a string or null');
    return host.confirmTable(filePath, vpsTableId);
  });
  ipcMain.handle(IPC.settingsGet, () => redactSettings(store.get()));
  ipcMain.handle(IPC.settingsSet, async (_e, patch: unknown) => {
    const clean = sanitizePatch(patch);
    await store.set(clean);
    logger.info(`settings: updated ${Object.keys(clean).join(', ')}`);
    return redactSettings(store.get());
  });
  const dirArg = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    return str(v, 'folder');
  };
  ipcMain.handle(IPC.tablesDefaults, () => tables.defaults());
  ipcMain.handle(IPC.tablesPlan, (_e, dir: unknown) => tables.plan(dirArg(dir)));
  ipcMain.handle(IPC.tablesApply, async (e, dir: unknown) => {
    try {
      return await tables.apply(dirArg(dir), (done, total, tableId) => {
        if (!e.sender.isDestroyed()) e.sender.send(IPC.tablesProgressEvent, { done, total, tableId });
      });
    } finally {
      watch.reset();
    }
  });
  ipcMain.handle(IPC.tablesRemoveAll, async (_e, dir: unknown) => {
    try {
      return await tables.removeAll(dirArg(dir));
    } finally {
      watch.reset();
    }
  });
  ipcMain.handle(IPC.appOpenExternal, async (_e, url: unknown) => {
    const target = str(url, 'url');
    if (!isAllowedExternalUrl(target, store.get().arcaidBaseUrl)) {
      logger.warn(`openExternal refused: ${target}`);
      return false;
    }
    await shell.openExternal(target);
    return true;
  });
  ipcMain.handle(IPC.appVersions, (): AppVersions => ({
    app: appVersion,
    protocol: PROTOCOL_VERSION,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
    packaged: app.isPackaged,
  }));
  ipcMain.handle(IPC.appLoginItemGet, () => loginItemState());
  ipcMain.handle(IPC.appLoginItemSet, (_e, on: unknown) => setLoginItem(on === true));
  ipcMain.handle(IPC.appLogPath, () => logger.file);
  ipcMain.handle(IPC.appOverlayUrl, () => overlay?.url() ?? null);
  ipcMain.handle(IPC.streamStatus, () => sh().status());
  ipcMain.handle(IPC.streamStart, async (_e, want: unknown) => {
    const w = (want ?? {}) as { record?: unknown; live?: unknown };
    return sh().start({ record: w.record === true, live: w.live === true });
  });
  ipcMain.handle(IPC.streamStop, () => sh().stop());
  ipcMain.handle(IPC.streamSettingsGet, () => sh().settings());
  ipcMain.handle(IPC.streamSettingsSet, (_e, patch: unknown) => sh().setSettings((patch ?? {}) as Record<string, never>));
  ipcMain.handle(IPC.streamSetKey, (_e, key: unknown) => sh().setKey(typeof key === 'string' ? key : null));
  ipcMain.handle(IPC.streamOpenRecordings, async () => {
    const dir = sh().recordingsDir();
    mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
  ipcMain.handle(IPC.appPickFolder, async (_e, defaultPath: unknown) => {
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'], title: 'Choose a folder' };
    if (typeof defaultPath === 'string' && defaultPath.trim() !== '') opts.defaultPath = defaultPath;
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!;
  });
}

async function main(): Promise<void> {
  const userData = app.getPath('userData');
  const logger = createLogger({
    file: join(userData, 'logs', 'companion.log'),
    mirrorToStderr: !app.isPackaged,
  });
  log = logger;
  logger.info(`castcade ${appVersion} protocol ${PROTOCOL_VERSION} electron ${process.versions.electron} packaged=${app.isPackaged}`);

  const store = openSettingsStore({
    file: join(userData, 'settings.json'),
    defaults: {
      mapsDir: app.isPackaged ? join(process.resourcesPath, 'maps') : resolve(companionDir, 'resources', 'maps'),
      vpsDir: app.isPackaged ? join(process.resourcesPath, 'vps') : resolve(companionDir, 'resources', 'vps'),
      dataDir: join(userData, 'witness'),
      deviceLabel: hostname(),
      newDeviceId: () => randomUUID(),
    },
    codec: tokenCodec(logger),
    log: logger,
  });
  const s = store.get();
  logger.info(`settings: arcaid=${s.arcaidBaseUrl} device=${s.deviceId} label=${s.deviceLabel} paired=${s.token !== null} maps=${s.mapsDir}`);
  if (s.arcaidBaseUrl !== DEFAULT_ARCAID_BASE_URL) logger.warn(`settings: non-production ArcAid URL ${s.arcaidBaseUrl}`);

  const host = createWitnessHost(store, logger);
  store.onChange((next, prev) => {
    if (needsWitnessRestart(prev, next)) void host.restart('settings changed');
  });

  // Table import (C7): the hook library ships as a resource; manifests live beside the witness data.
  const libSource = app.isPackaged ? join(process.resourcesPath, 'hook', 'castcade.vbs') : resolve(companionDir, '..', 'vpx-hook', 'castcade.vbs');
  const manifestDir = manifestDirFor(s.dataDir);
  const tables = createTablesHost({ store, witnessStatus: () => host.status(), libSource, manifestDir, log: logger });
  const watch = new SidecarWatch({
    tablesDir: () => tables.resolveTablesDir(null),
    scriptsDir: () => tables.scriptsDir(),
    manifestDir,
    libSource,
    watchOffsetsFor: (rom) => tables.watchOffsetsFor(rom),
    exclusive: (fn) => tables.exclusive(fn),
    log: (line) => logger.info(line),
    notify: (title, body) => tray?.notify(title, body),
  });
  sidecarWatch = watch;

  // D1.2 / D1.3: recording and streaming; the key shares the pairing token's codec.
  // A failure here turns streaming off for this run; it never stops the witness.
  let streamHost: StreamHost | null = null;
  try {
    streamHost = createStreamHost({
      file: join(userData, 'stream.json'),
      codec: tokenCodec(logger),
      defaultRecordingsDir: join(app.getPath('videos'), 'Castcade'),
      ffmpeg: resolveFfmpeg({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, companionDir }),
      appVersion,
      log: logger,
    });
    const sh = streamHost;
    stream = sh;
    sh.onStatus((st) => {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.streamStatusEvent, st);
      tray?.refresh(host.status());
    });
    host.onGame((g) => sh.noteGame(g));
    host.onCapture((c) => sh.noteCapture(c));
  } catch (e) {
    logger.error(`stream: could not set up (${describeError(e)}); streaming and recording are off this run`);
  }

  registerIpc(store, host, tables, watch, logger, streamHost);
  host.onNotice((n) => tray?.notify(n.title, n.message));

  if (!argv.includes('--hidden')) win = createWindow();
  if (win) win.once('ready-to-show', () => win?.show());

  tray = createTray(join(app.getAppPath(), 'build', 'tray.ico'), {
    open: showWindow,
    setPaused: (p) => void host.setPaused(p),
    isPaused: () => host.isPaused(),
    loginItemSupported: () => loginItemState().supported,
    getOpenAtLogin: () => loginItemState().openAtLogin,
    setOpenAtLogin: (on) => {
      setLoginItem(on);
      tray?.refresh(host.status());
    },
    pendingUpdate: () => updater?.pendingVersion() ?? null,
    restartToUpdate: () => {
      quitting = true;
      updater?.quitAndInstall();
    },
    quit: () => void quit(host),
    streamState: () => {
      if (!stream) return null;
      const st = stream.status();
      return { running: st.state !== 'idle', live: st.wantsLive, recording: st.wantsRecording, hasKey: stream.settings().hasKey };
    },
    streamStart: (want) => {
      void stream?.start(want).catch((e: unknown) => tray?.notify('Castcade: could not start', describeError(e)));
    },
    streamStop: () => void stream?.stop(),
  }, host.status());

  host.onStatus((status) => {
    streamHost?.noteTable(status.currentTable);
    tray?.refresh(status);
    if (win && !win.isDestroyed()) win.webContents.send(IPC.witnessStatusEvent, status);
    overlay?.publish();
  });
  host.onGame(() => overlay?.publish());

  await host.start();
  watch.start();

  // D1.1: the overlay page OBS adds as a browser source. A taken port is logged, never fatal.
  const page = createOverlayServer({ state: () => overlayStateFrom(host.status(), host.liveGame()), log: (line) => logger.info(line) });
  await page.start().then(
    () => {
      overlay = page;
    },
    (err: unknown) => logger.warn(`overlay: could not start (${describeError(err)}); the OBS overlay is off this run`),
  );

  if (app.isPackaged) {
    updater = await startUpdater(logger, {
      onDownloaded: (version) => {
        tray?.refresh(host.status());
        tray?.notify('Castcade update', `Update available: v${version}. Quit and reopen (or use the tray menu) to install.`);
      },
    });
  } else {
    logger.info('updater: skipped (not packaged)');
  }
}
