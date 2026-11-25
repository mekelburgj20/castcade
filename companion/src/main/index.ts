/**
 * Electron main process entry (Phase 2: tray app + Arcaid Witness producer).
 *
 * Order matters: `--smoke` prints the bundle identity, checks the journal pipe's worker (C16.2) and exits before
 * anything else (no window, no tray, no settings file; CI runs it on a headless Windows runner). Then the single-instance
 * lock, then on `ready`: logger → a waiting update (E9: installed now, before anything else) → settings store →
 * journal pipe → witness host → window → tray → IPC → the update offer and its checks.
 * Closing the window hides it to the tray; only the tray's Quit (or the app's own update restart)
 * ends the process.
 */
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, safeStorage, screen, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@castcade/protocol';
import { isAllowedExternalUrl } from './allowlist.js';
import { IPC, type AppVersions, type LoginItemState, type TablesPatchNowResult } from './ipc-types.js';
import { createLogger, describeError, type Logger } from './log.js';
import { featuresFor, resolveEdition } from './edition.js';
import { removeFullEditionLeftovers } from './edition-leftovers.js';
import { writeVrReport } from './vr-report-host.js';
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
import {
  cacheDirName,
  createInstallerProbe,
  createMarkerStore,
  createUpdateController,
  INSTALL_MARKER_FILE,
  installAfterShutdown,
  installRunningNotice,
  installWaitReason,
  loadUpdater,
  readPendingInstaller,
  type UpdateController,
  type UpdateNotice,
  type UpdateStatus,
} from './updater.js';
import { APP_USER_MODEL_ID, ensureStartMenuShortcut } from './start-menu.js';
import { createResumeStore, RESUME_FILE, resumeFreshness } from './match-resume.js';
import { createPowershellLister, isVpxExe } from '../witness/process-watch.js';
import { collectLogBundle } from '../witness/log-bundle.js';
import { createWitnessHost, needsWitnessRestart, type WitnessHost } from './witness-host.js';
import { smokeJournalPipe, startJournalPipe, type JournalPipe } from '../witness/journal-pipe.js';
import { journalDir } from '../witness/journal-tail.js';
import { createTablesHost, type TablePatchResult, type TablesHost } from './tables-host.js';
import { SidecarWatch } from './sidecar-watch.js';
import { manifestDirFor } from '../witness/witness.js';
import { createOverlayServer, overlayStateFrom, type OverlayServer } from '../media/overlay-server.js';
import { resolveFfmpeg } from '../media/ffmpeg-path.js';
import { createStreamHost, type StreamHost } from './stream-host.js';
import { createMatchHost, type MatchHost } from './match-host.js';
import { matchSignalling } from './match-setup.js';
import { linkFromArgv, linkIsTrusted, looksLikePastedLink, registerLinkProtocol } from './deep-link.js';
import { createOneStep, type OneStep } from './one-step.js';
import { createRecentTables, listKnownTables, listTableFiles } from '../launch/known-tables.js';
import { createTableHasher } from '../launch/table-hash.js';
import { createVpxLauncher } from '../launch/vpx-launch.js';
import { createWatchHost, type WatchHost } from './watch-host.js';
import { createStream3dHost, type Stream3dHost } from './stream3d-host.js';
import { createTunnelEnd, freeLoopbackPort } from '../watch/tunnel-end.js';
import { HiddenVpx } from '../witness/hidden-vpx.js';
import type { VrOverlay } from '../media/match-media-types.js';
import { createMediaSettingsStore, iceServers, type MediaSettingsStore } from '../media/media-settings.js';
import { usableBounds } from '../media/panel-placement.js';
import { readIniStereo } from '../media/preview-stereo.js';
import { nodeFs } from '../witness/fs.js';
import { createRtcHost, type RtcHost } from '../media/rtc-host.js';
import { createTableAudioHelper, resolveAudioHelper, type TableAudioHelper } from '../media/audio-helper.js';
import { createVideoHelper, resolveVideoHelper, type VideoHelper } from '../media/video-helper.js';
import { createVrLayerOverlay, registerVrLayer, resolveVrLayer } from '../media/vr-layer.js';
import { createLayerAgeWatch, readRegisteredAt, sha256File, stageVrLayer, versionText, VR_LAYER_DLL, vrLayerStageRoot, writeRegisteredAt } from '../media/vr-layer-stage.js';
import { createVrOverlay, resolveVrOverlay } from '../media/vr-overlay.js';
import { watchFocus } from '../media/focus-watch.js';
import { probeWindows } from '../media/window-geometry.js';
import { createVpxForeground } from './vpx-foreground.js';

const here = dirname(fileURLToPath(import.meta.url)); // <companion>/dist/main
const companionDir = resolve(here, '..', '..');
const appVersion = app.getVersion();
const argv = process.argv.slice(1);

/** E10: the app's own package.json (inside app.asar when packaged), where the Witness installer's build bakes its edition. */
function readAppPackageJson(): string | null {
  try {
    return readFileSync(join(app.getAppPath(), 'package.json'), 'utf8');
  } catch {
    return null;
  }
}
/**
 * E10: the edition (`edition.ts`): the full app, or the Witness edition (`Castcade-Witness-Setup`), which runs the
 * Arcaid Witness part only and constructs none of what `features` turns off.
 */
const editionPick = resolveEdition({ packageJson: readAppPackageJson(), env: process.env, packaged: app.isPackaged });
const edition = editionPick.edition;
const features = featuresFor(edition);
/** E10: what an IPC call for a feature the Witness edition leaves out answers (the window never offers one). */
const NOT_IN_WITNESS = 'not part of the Castcade Witness edition';

let quitting = false;
let win: BrowserWindow | null = null;

// I11.4.18: how VPX gets the foreground back from a Castcade window, and what the player is doing in that window:
// every key that goes down in one of Castcade's pages is noted (the time only, never the key), so a grant does not
// take the keyboard from somebody who is typing here.
const vpxForeground = createVpxForeground({ focusedPage: () => BrowserWindow.getFocusedWindow()?.webContents ?? null, ownerPid: process.pid });
app.on('web-contents-created', (_e, contents) => {
  contents.on('before-input-event', (_ev, input) => {
    if (input.type === 'keyDown') vpxForeground.keyPressed();
  });
});
let log: Logger | null = null;
let tray: TrayHandle | null = null;
let sidecarWatch: SidecarWatch | null = null;
/** E9: the update offer and its install (packaged builds only); null in a development run. */
let updater: UpdateController | null = null;
/** E9: the witness host, for "a table is open" (the update waits for it); set once `main` made it. */
let witnessHost: WitnessHost | null = null;
/** C16.2 (hook 0.6.0): the worker that drains the hooks' journal pipe into the journal files; null without %LOCALAPPDATA%. */
let journalPipe: JournalPipe | null = null;
const NO_UPDATE: UpdateStatus = { ready: null, waiting: null, installing: false, lastAttempt: null };
/** E9: the update's part of the start is running (a waiting update may be installed before anything else). */
let updateAtStart = false;
/** D1.1: the OBS overlay page on 127.0.0.1; null until started (or when its port was taken). */
let overlay: OverlayServer | null = null;
/** D1.2 / D1.3: recording and streaming. */
let stream: StreamHost | null = null;
/** A6: the match (host or join by invite); null when it could not be set up this run. */
let match: MatchHost | null = null;
/** D2 / D7 / D7.3: the match's video and voice, and the headset panel (SteamVR helper, OpenXR layer); null when they could not be set up this run. */
let matchMedia: RtcHost | null = null;
/** D2.6: media.json, which also remembers the main window's bounds; set up in `main`, read by `createWindow`. */
let mediaSettingsStore: MediaSettingsStore | null = null;
let matchOverlay: VrOverlay | null = null;
let matchLayer: VrOverlay | null = null;
/** D2.8: the table-sound helper (mute this rig's VPX while another player is up, tap its sound while this rig is up). */
let tableAudio: TableAudioHelper | null = null;
/** D10.3: the native spectator-video helper (`castcade-video.exe`), started by the first match that wants it. */
let videoHelper: VideoHelper | null = null;
/** A14: one step to a match (Host with a table, the join link); null when matches are off this run. */
let oneStep: OneStep | null = null;
/** I11.4.1: the standalone 3D watch session (the VPX fork's state stream through the companion); null when it could not be set up. */
let watch3d: WatchHost | null = null;
/** I11.4.2: the state stream inside a match (the control port the VPX fork connects to, the tunnel, 3D or 2D). */
let stream3d: Stream3dHost | null = null;
/** I11.4.1: a PC is in one ArcAid room at a time: a match is refused while a 3D watch session is on. */
const WATCH_BLOCKS_MATCH = 'Leave the 3D watch session first: a PC is in one ArcAid room at a time.';
/** A14: the renderer's word on whether the Match tab is showing (`launch:viewing`). */
let matchTabShowing = false;
/** A14: a `castcade://` link that arrived before the app was ready (a cold start, or a second instance during startup). */
let earlyLink: string | null = features.match ? linkFromArgv(argv) : null;
/** D10.3 (§6.1): a frame-ring token: 16 characters of `[A-Za-z0-9_-]` (12 random bytes, base64url), fresh per companion start. */
const ringToken = (): string => randomBytes(12).toString('base64url');

if (argv.includes('--smoke')) {
  // D1.6: which ffmpeg this build would stream with (`bundled <build>` from the installer, else `path`).
  const ff = resolveFfmpeg({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, companionDir });
  process.stdout.write(`castcade ${appVersion} protocol ${PROTOCOL_VERSION} ffmpeg ${ff.source === 'bundled' ? `bundled ${ff.build ?? '?'}` : 'path'} edition ${edition}\n`);
  // C16.2: the journal pipe's worker starts from this build (inside the asar when packaged) and writes a line it is sent;
  // on a pipe and in a folder of its own, never the hooks' pipe or the player's journals. A failure, a throw or no
  // answer within 30 s fails the smoke (exit 1); it never keeps running.
  let smokeEnded = false;
  const smokeDone = (ok: boolean, detail: string): void => {
    if (smokeEnded) return;
    smokeEnded = true;
    clearTimeout(smokeGiveUp);
    process.stdout.write(`journal-pipe ${ok ? 'ok' : 'FAILED'} ${detail}\n`);
    app.exit(ok ? 0 : 1);
  };
  const smokeGiveUp = setTimeout(() => smokeDone(false, '(no answer within 30 s)'), 30_000);
  void smokeJournalPipe().then(
    (r) => smokeDone(r.ok, r.detail),
    (err: unknown) => smokeDone(false, `(${err instanceof Error ? err.message : String(err)})`),
  );
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  // A14: a second instance is how Windows hands over a clicked `castcade://` link while Castcade runs.
  app.on('second-instance', (_e, secondArgv) => {
    const link = features.match ? linkFromArgv(secondArgv) : null;
    // E9: while a waiting update is checked at start, a second start opens nothing (Castcade may be about to install).
    if (updateAtStart) {
      if (link) earlyLink = link;
      return;
    }
    if (link) openLink(link);
    else showWindow();
  });
  app.on('window-all-closed', () => {
    /* tray app: keep running */
  });
  app.on('before-quit', () => {
    quitting = true;
    updater?.stop();
  });
  // D2.10: the match's volume keys are released at teardown; this covers a quit that skips it.
  app.on('will-quit', () => globalShortcut.unregisterAll());
  void app.whenReady().then(main);
}

/**
 * A14: a `castcade://` link from Windows (untrusted: any page or chat can hand one over). Whether the player was
 * already looking at the Match tab is read before the window is brought up; if not, the link waits there for a click.
 * Only the text goes on: `one-step.ts` parses it and takes nothing but an invite from it.
 */
function openLink(link: string, atStartup = false): void {
  const w = win && !win.isDestroyed() ? win : null;
  const trusted = !atStartup && linkIsTrusted({ exists: w !== null, visible: w?.isVisible() ?? false, minimized: w?.isMinimized() ?? false, matchTab: matchTabShowing });
  showWindow();
  if (!oneStep) {
    // Not ready yet (startup): `main` opens it when it is. Never trusted then: the window was not up.
    earlyLink = link;
    return;
  }
  log?.info(`links: a castcade:// link arrived (${trusted ? 'the Match tab was showing' : 'waits for a click on the Match tab'})`);
  void oneStep.openLink(link, { trusted });
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

/** D2.6 (2026-11-01): the main window's bounds while it is on screen; the match panel is placed beside them. */
function mainWindowBounds(): { x: number; y: number; width: number; height: number } | null {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null;
  return win.getBounds();
}

function createWindow(): BrowserWindow {
  // D2.6: where it was last run, if that is still on a display (a monitor may have gone); else centred as before.
  const saved = usableBounds(mediaSettingsStore?.get().mainBounds, screen.getAllDisplays().map((d) => d.workArea));
  const w = new BrowserWindow({
    width: saved?.width ?? 420,
    height: saved?.height ?? 640,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
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
        `--castcade-edition=${edition}`,
      ],
    },
  });
  w.removeMenu();
  // 2026-10-31 (A6): Electron shows no right-click menu by default, so Krobs could not paste the invite.
  w.webContents.on('context-menu', (_e, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]).popup();
    } else if (params.selectionText) {
      Menu.buildFromTemplate([{ role: 'copy' }]).popup();
    }
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  // D2.6: remember where the window is (after a move or resize settles, and on hide / quit).
  const remember = (): void => {
    if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
    const b = w.getNormalBounds();
    const cur = mediaSettingsStore?.get().mainBounds;
    if (cur && cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return;
    mediaSettingsStore?.patch({ mainBounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
  };
  w.on('moved', remember);
  w.on('resized', remember);
  w.on('close', (e) => {
    remember();
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  w.on('closed', () => {
    if (win === w) win = null;
    matchTabShowing = false;
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

/** The orderly shutdown; `install` swaps the final app.quit() for the updater's quit-and-install (E6). */
async function quit(host: WitnessHost, install = false): Promise<void> {
  quitting = true;
  sidecarWatch?.stop();
  await overlay?.stop();
  await stream?.stop().catch(() => undefined);
  oneStep?.stop();
  await watch3d?.stop().catch(() => undefined); // I11.4.1: leaves the 3D watch session; a VPX it started stays open
  // Forfeits a match in progress and removes the turn lock. A15: not when Castcade restarts itself for an update: the
  // match is kept and rejoined at the next start.
  await match?.stop({ keepForRestart: install && !!updater?.pendingVersion() }).catch(() => undefined);
  await stream3d?.stop().catch(() => undefined); // I11.4.2: the control port closes; a fork left open goes on as plain VPX
  await matchMedia?.detach().catch(() => undefined); // the match detached it if one was running; this closes the panel window
  await matchOverlay?.stop().catch(() => undefined); // ends the helper's stdin, so it hides the overlay and exits
  await matchLayer?.stop().catch(() => undefined); // closes the layer's pipe; the quad leaves the headset 5 s later
  await tableAudio?.stop().catch(() => undefined); // ends the helper's stdin: it unmutes everything it muted and exits
  await videoHelper?.stop().catch(() => undefined); // D10.3: `quit` and the end of its stdin; the match closed its peers already
  await host.stop();
  // C16.2: what the pipe still holds goes to the journal files; a table still open then writes its file itself.
  await journalPipe?.stop().catch(() => undefined);
  // E9: the installer runs visibly and starts Castcade again at its end; install() quits once its process runs. When it
  // cannot be started, Castcade starts again (everything is stopped by now) and that start offers the update.
  if (install && updater) {
    await installAfterShutdown({
      updates: updater,
      relaunch: () => app.relaunch({ args: argv.filter((a) => a !== '--hidden' && a !== '--updated' && !a.toLowerCase().startsWith('castcade:')) }),
      quit: () => app.quit(),
      warn: (line) => log?.warn(line),
    });
    return;
  }
  const downloaded = updater?.pendingVersion() ?? null;
  log?.info(downloaded ? `quit (${downloaded} is downloaded and not installed: quitting does not install it, the next start does)` : 'quit');
  app.quit();
}

/**
 * E9: Restart and update (the window's banner, the tray menu, a balloon). Never while a table is open, in a match, a
 * 3D watch session or a recording: then it waits and says why (the window shows it; from the tray, a balloon).
 */
function restartToUpdate(host: WitnessHost, from: 'window' | 'tray'): UpdateStatus {
  if (!updater) return NO_UPDATE;
  const version = updater.pendingVersion();
  const r = updater.requestInstall();
  if (r.go) void quit(host, true);
  else if (r.why && version && updater.pendingVersion() === null) tray?.notify('Castcade update', `The download of Castcade ${version} is gone. Castcade downloads it again and offers it when it is ready.`);
  else if (r.why && from === 'tray') tray?.notify('Castcade update waits', `The update to Castcade ${version ?? ''} waits ${r.why}. Castcade never restarts during a game${features.match ? ', a match or a 3D watch session' : ''}.`);
  return updater.status();
}

/** E9: why an update has to wait right now (`installWaitReason`), from the hosts' own state. */
function updateWaitReason(): string | null {
  const ms = match?.status();
  return installWaitReason({
    match: ms ? { role: ms.role, phase: ms.phase } : null,
    watch: watch3d?.active() ?? false,
    table: witnessHost?.status().currentTable ?? null,
    vpx: (witnessHost?.vpxPid?.() ?? null) !== null,
    recording: stream ? stream.status().state !== 'idle' : false,
  });
}

/** E9: the update's balloons. */
function updateBalloon(n: UpdateNotice, host: WitnessHost): void {
  const install = () => void restartToUpdate(host, 'tray');
  switch (n.kind) {
    case 'ready':
      if (n.waiting) tray?.notify('Castcade update ready', `Castcade ${n.version} is downloaded. It waits ${n.waiting}; then Restart and update (window or tray menu). Quitting does not install it; the next start does.`);
      else tray?.notify('Castcade update ready', `Castcade ${n.version} is downloaded. Click here to restart and install it: the installer shows its progress for about a minute, then Castcade starts again.`, install);
      return;
    case 'free':
      tray?.notify('Castcade update ready', `Castcade ${n.version} can be installed now. Click here to restart and update.`, install);
      return;
    case 'updated':
      tray?.notify('Castcade updated', `Castcade is now ${n.version}.`);
      return;
    case 'failed':
      tray?.notify(
        'Castcade update not installed',
        n.why === 'not_started'
          ? `Castcade could not start the installer of ${n.version}. It is offered again in the window and the tray menu.`
          : `The install of ${n.version} did not finish (the installer was closed or failed). It is offered again in the window and the tray menu.`,
      );
      return;
  }
}

/** E9: a small window for the moments before the main one exists (an update at start, a start during an install). */
function showNotice(text: string): { close(): void } {
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const html =
    '<!doctype html><meta charset="utf-8"><title>Castcade</title>' +
    '<body style="margin:0;padding:18px 20px;background:#14161a;color:#e6e6e6;font:14px system-ui,sans-serif;border:1px solid #262a31;height:100vh;box-sizing:border-box">' +
    `<div style="font-weight:700;letter-spacing:.04em;margin-bottom:8px">Castcade</div><div>${esc(text)}</div></body>`;
  const w = new BrowserWindow({
    width: 440,
    height: 140,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    center: true,
    show: false,
    title: 'Castcade',
    backgroundColor: '#14161a',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.removeMenu();
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.once('ready-to-show', () => w.show());
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return {
    close: () => {
      if (!w.isDestroyed()) w.destroy();
    },
  };
}

const readTextOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * E9: the update's part of a start, before anything else runs. Null: this start ends here (the installer of a waiting
 * update is starting, or an install Castcade began is still running); else whether to stay in the tray.
 */
async function updaterAtStart(logger: Logger, userData: string): Promise<{ hidden: boolean } | null> {
  const localAppData = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local');
  const pendingDir = join(localAppData, cacheDirName(readTextOrNull(join(process.resourcesPath, 'app-update.yml'))), 'pending');
  const resume = createResumeStore(join(userData, RESUME_FILE), (line) => logger.warn(line));
  const lister = createPowershellLister();
  let notice: { close(): void } | null = null;
  const controller = createUpdateController({
    log: logger,
    appVersion,
    edition,
    updater: await loadUpdater(logger),
    busy: updateWaitReason,
    busyAtStart: async () => {
      const rec = resume.read();
      if (rec && resumeFreshness(rec, Date.now()) !== 'stale') return `Castcade was in match ${rec.code} when it closed`;
      const vpx = (await lister.list()).find((p) => isVpxExe(p.exe));
      return vpx ? `VPX is open (${basename(vpx.exe)}, pid ${vpx.pid})` : null;
    },
    // A `castcade://` invite (on this start's command line, or handed over by a second start during the check) is
    // opened, not lost to an install: the installer would start Castcade again with `--updated` only.
    heldAtStart: () => (earlyLink ? 'a castcade:// invite is waiting to be opened' : null),
    exists: existsSync,
    pending: () => readPendingInstaller({ dir: pendingDir, appVersion, readText: readTextOrNull, exists: existsSync, edition }),
    marker: createMarkerStore(join(userData, INSTALL_MARKER_FILE), (line) => logger.warn(line)),
    installerRunning: createInstallerProbe(),
    hiddenStart: argv.includes('--hidden'),
    startedByInstaller: argv.includes('--updated'),
    checking: (version) => {
      notice = showNotice(`Castcade ${version} was downloaded before Castcade last closed. Checking it is still the latest, then installing it: the installer shows its progress, then Castcade starts again.`);
    },
    quit: () => app.quit(),
  });
  updater = controller;
  updateAtStart = true;
  const r = await controller.atStart().catch((e: unknown): { outcome: 'continue'; hidden: boolean } => {
    logger.warn(`updater: at start: ${describeError(e)}`);
    return { outcome: 'continue', hidden: false };
  });
  if (r.outcome === 'installing') return null; // the notice stays up until the app has quit; the installer follows
  (notice as { close(): void } | null)?.close();
  if (r.outcome === 'continue') updateAtStart = false; // else this start is leaving: a second one still opens nothing
  if (r.outcome === 'install_running') {
    // The installer's own start of the new Castcade at its end must not find this instance holding the lock.
    app.releaseSingleInstanceLock();
    const n = showNotice(installRunningNotice(r.version, r.ageMs));
    setTimeout(() => {
      n.close();
      app.quit();
    }, 3000);
    return null;
  }
  return { hidden: r.hidden };
}

/** C11: the player's sentence for a Patch now answer (Status and the follow-up balloon say the same). */
function patchNowResult(r: TablePatchResult, logger: Logger): TablesPatchNowResult {
  if (r.result === 'failed' || r.result === 'skipped') logger.warn(`tables: Patch now ${r.result}: ${r.detail}`);
  switch (r.result) {
    case 'patched':
      return { ok: true, text: 'patched; reopen the table so every game posts live' };
    case 'already':
      return { ok: true, text: 'already patched; reopen the table so every game posts live' };
    case 'skipped':
      return { ok: false, text: `not patched: ${r.detail}` };
    case 'failed':
      return { ok: false, text: `could not patch it: ${r.detail}. Settings → Import tables → Patch my tables.` };
  }
}

function registerIpc(
  store: SettingsStore,
  host: WitnessHost,
  tables: TablesHost,
  watch: SidecarWatch,
  logger: Logger,
  maybeStream: StreamHost | null,
  maybeMatch: MatchHost | null,
  maybeOneStep: OneStep | null,
): void {
  const sh = (): StreamHost => {
    if (!maybeStream) throw new Error(features.stream ? 'streaming is unavailable this run (see the log)' : `streaming is ${NOT_IN_WITNESS}`);
    return maybeStream;
  };
  const mh = (): MatchHost => {
    if (!maybeMatch) throw new Error(features.match ? 'matches are unavailable this run (see the log)' : `matches are ${NOT_IN_WITNESS}`);
    return maybeMatch;
  };
  /** I11.4.1: the calls that put this PC into a match room are refused while a 3D watch session is on. */
  const noWatch = (): void => {
    if (watch3d?.active()) throw new Error(WATCH_BLOCKS_MATCH);
  };
  const wh = (): WatchHost => {
    if (!watch3d) throw new Error(features.watch3d ? '3D watch is unavailable this run (see the log)' : `3D watch is ${NOT_IN_WITNESS}`);
    return watch3d;
  };
  const os = (): OneStep => {
    if (!maybeOneStep) throw new Error(features.match ? 'matches are unavailable this run (see the log)' : `matches are ${NOT_IN_WITNESS}`);
    return maybeOneStep;
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
  ipcMain.handle(IPC.witnessStartAttempts, () => host.startAttempts());
  ipcMain.handle(IPC.witnessSendLogs, () => host.sendLogsToSupport());
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
  // C11: Patch now from Status. Only a table file the witness itself offered (the open table, or the last close's).
  ipcMain.handle(IPC.tablesPatchNow, async (_e, vpxPath: unknown) => {
    const path = str(vpxPath, 'table file');
    const st = host.status();
    if (path !== st.patchNow?.vpxPath && path !== st.lastClose?.vpxPath) throw new Error('Castcade did not offer to patch that table');
    return patchNowResult(await tables.patchTable(path), logger);
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
  // E9: the update offer in the window (its banner's Restart and update).
  ipcMain.handle(IPC.appUpdateStatus, () => updater?.status() ?? NO_UPDATE);
  ipcMain.handle(IPC.appUpdateInstall, () => restartToUpdate(host, 'window'));
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
  ipcMain.handle(IPC.streamPreviewStart, () => sh().startPreview());
  ipcMain.handle(IPC.streamPreviewStop, () => sh().stopPreview());
  ipcMain.handle(IPC.streamPreviewStatus, () => sh().previewStatus());
  ipcMain.handle(IPC.matchStatus, () => {
    // B22 (2026-10-31): the Match tab asks for its status when it opens; list the microphones then, before any match.
    mh().refreshMicrophones();
    return mh().status();
  });
  ipcMain.handle(IPC.matchHost, (_e, o: unknown) => {
    noWatch();
    const w = (o ?? {}) as { port?: unknown; ballsPerGame?: unknown; displayName?: unknown };
    return mh().host({
      port: w.port === undefined || w.port === null ? undefined : Number(w.port),
      ballsPerGame: w.ballsPerGame === 5 ? 5 : 3,
      displayName: typeof w.displayName === 'string' ? w.displayName : '',
    });
  });
  ipcMain.handle(IPC.matchJoin, (_e, invite: unknown, displayName: unknown) => {
    noWatch();
    const text = str(invite, 'invite');
    const name = typeof displayName === 'string' ? displayName : '';
    // A14: a join link pasted into the Join box joins and starts the host's table here (the player pressed Join).
    return looksLikePastedLink(text) ? os().joinLink(text, name) : mh().join(text, name);
  });
  ipcMain.handle(IPC.launchStatus, () => os().status());
  ipcMain.handle(IPC.launchTables, () => os().tables());
  ipcMain.handle(IPC.launchBrowse, () => os().browse());
  ipcMain.handle(IPC.launchHost, (_e, o: unknown) => {
    noWatch();
    const w = (o ?? {}) as { tablePath?: unknown; startTable?: unknown; port?: unknown; ballsPerGame?: unknown; displayName?: unknown };
    return os().host({
      tablePath: typeof w.tablePath === 'string' && w.tablePath !== '' ? w.tablePath : null,
      // A14.7: the table starts with Host only when asked; otherwise it waits for Start the table.
      startTable: w.startTable === true,
      port: w.port === undefined || w.port === null ? undefined : Number(w.port),
      ballsPerGame: w.ballsPerGame === 5 ? 5 : 3,
      displayName: typeof w.displayName === 'string' ? w.displayName : '',
    });
  });
  ipcMain.handle(IPC.launchStartTable, () => os().startTable());
  ipcMain.handle(IPC.launchConfirm, () => {
    noWatch();
    return os().confirm();
  });
  ipcMain.handle(IPC.launchDismiss, () => os().dismiss());
  ipcMain.handle(IPC.launchCopy, (_e, what: unknown) => os().copy(what === 'message' ? 'message' : 'link'));
  ipcMain.handle(IPC.launchViewing, (e, on: unknown) => {
    if (win && !win.isDestroyed() && e.sender === win.webContents) matchTabShowing = on === true;
  });
  ipcMain.handle(IPC.matchStart, (_e, o: unknown) => mh().start({ anyway: (o as { anyway?: unknown } | null | undefined)?.anyway === true }));
  ipcMain.handle(IPC.matchPassTurn, () => mh().passTurn());
  ipcMain.handle(IPC.matchEndMyBall, () => mh().endMyBall());
  ipcMain.handle(IPC.matchResume, () => mh().resume());
  ipcMain.handle(IPC.matchSaveFrames, () => mh().saveFrames());
  ipcMain.handle(IPC.matchBenchStart, (_e, req: unknown) => mh().startBench(req));
  ipcMain.handle(IPC.matchBenchStop, () => mh().stopBench());
  ipcMain.handle(IPC.matchBenchView, (_e, view: unknown) => mh().setBenchView(view === 'direct' ? 'direct' : 'theater'));
  ipcMain.handle(IPC.matchBenchClips, () => mh().benchClips());
  ipcMain.handle(IPC.matchLeave, () => mh().leave());
  ipcMain.handle(IPC.matchRejoin, () => {
    noWatch();
    return mh().rejoin();
  });
  ipcMain.handle(IPC.matchForgetResume, () => mh().forgetResume());
  ipcMain.handle(IPC.matchSettingsSet, (_e, patch: unknown) => mh().setSettings((patch ?? {}) as Record<string, never>));
  ipcMain.handle(IPC.matchSetMicrophone, (_e, deviceId: unknown) => mh().setMicrophone(typeof deviceId === 'string' ? deviceId : null));
  ipcMain.handle(IPC.matchSetMuted, (_e, muted: unknown) => mh().setMuted(muted === true));
  ipcMain.handle(IPC.matchSetTurn, (_e, t: unknown) => {
    const v = (typeof t === 'object' && t !== null ? t : {}) as { url?: unknown; username?: unknown; credential?: unknown };
    if (typeof v.url !== 'string' || v.url.trim() === '') return mh().setTurn(null);
    return mh().setTurn({ url: v.url, username: typeof v.username === 'string' ? v.username : '', credential: typeof v.credential === 'string' ? v.credential : null });
  });
  ipcMain.handle(IPC.matchSetVideoPath, (_e, path: unknown) => mh().setVideoPath(path === 'electron' ? 'electron' : 'native'));
  ipcMain.handle(IPC.matchSetVideoRungs, (_e, r: unknown) => {
    const v = (typeof r === 'object' && r !== null ? r : {}) as { maxKbps?: unknown; pin?: unknown };
    return mh().setVideoRungs({
      ...(typeof v.maxKbps === 'number' ? { maxKbps: v.maxKbps } : {}),
      ...(v.pin === null || typeof v.pin === 'number' ? { pin: v.pin } : {}),
    });
  });
  ipcMain.handle(IPC.matchShowPanel, () => mh().showPanel());
  ipcMain.handle(IPC.matchHidePanel, () => mh().hidePanel());
  ipcMain.handle(IPC.matchSetVrTest, (_e, test: unknown) => mh().setVrTest(test === 'pattern' ? 'pattern' : null));
  // D7.6.2: the VR report, beside companion.log; works with no match (the layer is then read over a short pipe connection).
  ipcMain.handle(IPC.matchVrReport, () =>
    writeVrReport({
      logFile: logger.file,
      layerLogFile: process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Castcade', 'logs', 'vr-layer.log') : null,
      appVersion,
      protocol: PROTOCOL_VERSION,
      match: maybeMatch,
      vrLayer: matchLayer,
      mediaSettings: mediaSettingsStore,
      witness: host,
      fs: nodeFs,
      log: (line) => logger.info(line),
    }),
  );
  // I11.4.1: the 3D watch session.
  ipcMain.handle(IPC.watchStatus, () => wh().status());
  ipcMain.handle(IPC.watchHost, () => wh().host());
  ipcMain.handle(IPC.watchJoin, (_e, code: unknown) => wh().join(str(code, 'code')));
  ipcMain.handle(IPC.watchLeave, () => wh().leave());
  ipcMain.handle(IPC.watchPlay, (_e, tablePath: unknown) => wh().play(str(tablePath, 'table file')));
  ipcMain.handle(IPC.watchWatch, (_e, tablePath: unknown) => wh().watch(tablePath === null || tablePath === undefined ? null : str(tablePath, 'table file')));
  ipcMain.handle(IPC.watchPickTable, async () => {
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], title: 'Pick a table', filters: [{ name: 'VPX table', extensions: ['vpx'] }] };
    const dir = tables.resolveTablesDir(null);
    if (dir) opts.defaultPath = dir;
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!;
  });
  ipcMain.handle(IPC.appClipboardText, () => clipboard.readText());
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
  logger.info(`castcade ${appVersion} protocol ${PROTOCOL_VERSION} electron ${process.versions.electron} packaged=${app.isPackaged} edition ${edition}`);
  if (editionPick.ignored !== null) logger.warn(`edition: '${editionPick.ignored}' (${editionPick.source === 'env' ? 'CASTCADE_EDITION' : 'package.json castcadeEdition'}) is not an edition; running the full app`);

  // E9: before anything else starts. An update downloaded before Castcade last closed is installed now (the installer
  // shows its progress and starts Castcade again), unless a table or a match is on; a start while an install Castcade
  // began is still running says so and leaves instead of being killed by that installer. Then a missing Start menu
  // entry is put back.
  let hiddenAfterUpdate = false;
  if (app.isPackaged) {
    const startup = await updaterAtStart(logger, userData);
    if (startup === null) return;
    hiddenAfterUpdate = startup.hidden;
    const sm = ensureStartMenuShortcut({
      platform: process.platform,
      packaged: app.isPackaged,
      execPath: process.execPath,
      appData: app.getPath('appData'),
      programData: process.env.ProgramData ?? process.env.ALLUSERSPROFILE ?? null,
      exists: existsSync,
      writeShortcut: (path, spec) => shell.writeShortcutLink(path, 'create', spec),
    });
    if (sm.result === 'created' || sm.result === 'failed') logger.info(sm.line);
    else logger.debug(sm.line);
  } else {
    logger.info('updater: skipped (not packaged)');
  }

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

  // E8: ArcAid's log pull (W99): the bundle is this rig's logs, newest VR report and newest journals; never settings.
  const localAppData = process.env.LOCALAPPDATA ?? null;
  // C16.2 (hook 0.6.0): the journal pipe, listening before the witness can see a table. A table loaded from now on sends
  // its journal through it (writing the journal touches no file on VPX's render thread; the hook's turn-lock check still
  // does); one loaded before, or while the pipe is off, writes its journal file itself. The witness reads the file either way.
  if (localAppData) {
    const pipe = startJournalPipe({ journalDir: journalDir(localAppData), log: logger });
    journalPipe = pipe;
    if (!(await pipe.ready(5_000)) && pipe.state() === 'starting') logger.warn('journal pipe: not listening 5 s after its start; tables write their journal file themselves until it is');
  } else {
    logger.warn('journal pipe: no %LOCALAPPDATA%; tables write their journal file themselves');
  }
  // I11.4.1: the 3D watch watchers Castcade starts are announced here before their spawn; the witness never sees them.
  const hiddenVpx = new HiddenVpx();
  const host = createWitnessHost(store, logger, {
    hideProcess: (p) => hiddenVpx.hides(p),
    // C16.2: before the witness acts on a VPX exit, the lines that table sent through the pipe are in its journal file.
    journalDrain: (path) => journalPipe?.drain(path) ?? Promise.resolve(true),
    logBundle: () =>
      collectLogBundle({
        companionLog: logger.file,
        layerLog: localAppData ? join(localAppData, 'Castcade', 'logs', 'vr-layer.log') : null,
        journalDir: localAppData ? join(localAppData, 'Castcade', 'journal') : null,
        about: [`castcade ${appVersion} protocol ${PROTOCOL_VERSION} edition ${edition}`, `device ${store.get().deviceLabel} (${store.get().deviceId})`],
      }),
  });
  witnessHost = host;
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
    liveSupportFor: (rom) => tables.liveSupportFor(rom),
    exclusive: (fn) => tables.exclusive(fn),
    log: (line) => logger.info(line),
    notify: (title, body) => tray?.notify(title, body),
  });
  sidecarWatch = watch;

  // D1.2 / D1.3: recording and streaming; the key shares the pairing token's codec.
  // A failure here turns streaming off for this run; it never stops the witness.
  let streamHost: StreamHost | null = null;
  if (features.stream) try {
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
      updater?.refresh(); // E9: an update waits for a recording
    });
    // D1.5: the preview closes on its own when the streamer presses Q or closes its window.
    sh.onPreview((p) => {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.streamPreviewEvent, p);
    });
    host.onGame((g) => sh.noteGame(g));
    host.onCapture((c) => sh.noteCapture(c));
  } catch (e) {
    logger.error(`stream: could not set up (${describeError(e)}); streaming and recording are off this run`);
  }

  // D2 + D7 (alpha-match.md §4, §5): the match's video and voice, and the panel in the headset. Each one that fails to
  // set up is logged and left out: the match then runs without it (2026-10-30: media never blocks a match).
  const mediaSettings = createMediaSettingsStore(join(userData, 'media.json'), (e) => logger.warn(`media: could not save media.json: ${describeError(e)}`));
  mediaSettingsStore = mediaSettings;
  // E10: the Witness edition sets up none of the match's media below, and removes what a full install left (the
  // OpenXR layer's registration, the castcade:// link); in a development run it leaves the PC's registrations alone.
  if (!features.match && app.isPackaged) void removeFullEditionLeftovers({ protocol: app, log: (line) => logger.info(line) });
  if (features.match) try {
    matchMedia = createRtcHost({
      userData,
      log: logger,
      // The panel's kind (desktop or headset) is the match host's decision at host / join (A6, 2026-10-31): `setVr`.
      probe: () => probeWindows(),
      // D2.5: the match video is covered while VPX is not in front (it films the screen now).
      watchFocus,
      settings: mediaSettings,
      // D2.6: the desktop panel opens beside the main window, never over it.
      mainBounds: mainWindowBounds,
      // D7.4.3 (2026-11-01): the sender declares both eyes from VPX's own setting, `[PlayerVR] VRPreview` in its ini.
      iniStereo: async () => (await readIniStereo({ fs: nodeFs, exe: host.status().vpxExe })).stereo,
    });
  } catch (e) {
    logger.error(`media: could not set up (${describeError(e)}); matches run without video and voice this run`);
  }
  if (features.match) try {
    const exePath = resolveVrOverlay({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, companionDir });
    if (!exePath) logger.info('vr-overlay: no helper in this build; in VR the match panel shows on the desktop');
    matchOverlay = createVrOverlay({ exePath, log: (line) => logger.info(line) });
  } catch (e) {
    logger.error(`vr-overlay: could not set up (${describeError(e)}); the match panel shows on the desktop this run`);
  }
  // D7.3: off SteamVR (Virtual Desktop, Oculus, other OpenXR runtimes) the panel goes in through the OpenXR layer.
  // D7.3.3 (2026-11-02): packaged, it runs from a per-version copy under %LOCALAPPDATA%\Castcade\vr-layer (an update
  // cannot replace a dll a running VPX maps), registered now at start, and the log says when VPX predates it.
  if (features.match) try {
    const layerLog = (line: string) => logger.info(line);
    const sourceJson = resolveVrLayer({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, companionDir });
    const staged = sourceJson && app.isPackaged ? stageVrLayer({ sourceDir: dirname(sourceJson), root: vrLayerStageRoot(process.env, userData), version: appVersion, log: layerLog }) : null;
    const jsonPath = staged?.jsonPath ?? sourceJson;
    if (!jsonPath) logger.info('vr-layer: no OpenXR layer in this build; on OpenXR rigs the headset panel is unavailable');
    const layerAge = createLayerAgeWatch({ vpxPid: () => host.vpxPid?.() ?? null, vpxStartedAt: () => host.vpxStartedAt?.() ?? null, log: layerLog });
    /** When the registration last changed: now when it did (or the files were copied), else the stage's stamp. */
    const noteRegistered = (changed: boolean) => {
      if (changed) {
        const at = Date.now();
        if (staged) writeRegisteredAt(staged.dir, at);
        layerAge.setRegisteredAt(at);
      } else if (layerAge.registeredAt() === null && staged) layerAge.setRegisteredAt(readRegisteredAt(staged.dir));
    };
    matchLayer = createVrLayerOverlay({ jsonPath, log: layerLog, vpxRunning: () => host.status().running, layerAge, onRegistered: noteRegistered });
    if (jsonPath) {
      const dir = dirname(jsonPath);
      const dll = join(dir, VR_LAYER_DLL);
      const sha = existsSync(dll) ? sha256File(dll).slice(0, 12) : 'missing';
      void registerVrLayer(jsonPath, { log: layerLog }).then((r) => {
        if (r.result !== 'ok') return;
        noteRegistered(r.changed || staged?.copied === true);
        logger.info(`vr-layer: registered for Castcade ${appVersion}: ${jsonPath} (dll sha256 ${sha}, VERSION ${versionText(dir) ?? 'none'})`);
      });
    }
    layerAge.start();
  } catch (e) {
    logger.error(`vr-layer: could not set up (${describeError(e)}); no headset panel on OpenXR rigs this run`);
  }

  // D2.8: table sound. A missing helper (or an old Windows) only means each rig hears its own table, as before.
  if (features.match) try {
    const exePath = resolveAudioHelper({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, companionDir });
    const stateFile = join(userData, 'castcade-audio-state.txt');
    tableAudio = createTableAudioHelper({ exePath, stateFile, log: (line) => logger.info(line) });
    tableAudio.onFrame((pcm) => matchMedia?.pushTableAudio(pcm));
    // A helper that was killed while it held a mute left this file: start one now, which unmutes those sessions first.
    if (existsSync(stateFile)) {
      logger.info('audio: an earlier run left sessions muted; starting the helper to restore them');
      tableAudio.start();
    }
  } catch (e) {
    logger.error(`audio: could not set up (${describeError(e)}); every rig hears its own table this run`);
  }

  // D10.3 (spectator-video-native.md §6.4): the native spectator video. The helper is spawned by the first match whose
  // media setting `videoPath` is `native`; a missing helper only means the Electron video path, as 0.2.36. The two
  // frame-ring tokens are fresh per companion start (§6.1: a stale layer in a running VPX never meets a new helper's ring).
  const videoRings = { sendRing: ringToken(), recvRing: ringToken() };
  if (features.match) try {
    const exe = resolveVideoHelper({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, companionDir });
    videoHelper = createVideoHelper({ exe, log: (line) => logger.info(line) });
    if (!exe) logger.info('video: no spectator-video helper in this build; matches use the Electron video path');
  } catch (e) {
    logger.error(`video: could not set up (${describeError(e)}); matches use the Electron video path this run`);
  }

  // I11.4.2 (ADR 0011, docs/design/state-stream-in-match.md §4): the state stream inside a match. Nothing is opened
  // here: the control port comes up with the first match (or the first match table started), the tunnel with each
  // match. A failure only means every match is 2D, as before.
  if (features.match) try {
    const portsFile = join(userData, 'stream3d.json');
    stream3d = createStream3dHost({
      log: logger,
      logsDir: dirname(logger.file),
      pageDir: userData,
      vpxExe: () => host.status().vpxExe ?? store.get().vpxExe ?? null,
      exists: async (p) => existsSync(p),
      iceServers: () => iceServers(mediaSettings.get()),
      tunnel: (o) => createTunnelEnd(o),
      freePort: freeLoopbackPort,
      ports: {
        read: () => (existsSync(portsFile) ? readFileSync(portsFile, 'utf8') : null),
        write: (text) => writeFileSync(portsFile, text),
      },
    });
  } catch (e) {
    logger.error(`stream3d: could not set up (${describeError(e)}); matches show the 2D video this run`);
  }

  // A6 + C3: the match (host or join by invite). A failure here turns matches off for this run; it never stops the witness.
  let matchHost: MatchHost | null = null;
  if (features.match) try {
    matchHost = createMatchHost({
      file: join(userData, 'match.json'),
      keysFile: join(userData, 'match-keys.json'),
      witness: host,
      device: () => {
        const cur = store.get();
        return { deviceId: cur.deviceId, deviceLabel: cur.deviceLabel };
      },
      media: matchMedia ?? undefined,
      mediaSettings,
      vrOverlay: matchOverlay ?? undefined,
      vrLayer: matchLayer ?? undefined,
      tableAudio: tableAudio ?? undefined,
      // D10.3: the native spectator video: the helper and this run's frame-ring tokens.
      nativeVideo: videoHelper ? { helper: videoHelper, ...videoRings } : undefined,
      // I11.4.2: the player up on a waiting player's own table, when both PCs run the Castcade VPX build.
      stream3d: stream3d ?? undefined,
      // MEDIA_SIGNAL over the match socket; it buffers what lands before the media layer listens (match-setup.ts).
      signalling: (role, localId) => matchSignalling(role, localId),
      // D2.10: the in-game volume keys (Ctrl+Alt+arrows), held only while a match is on.
      shortcuts: globalShortcut,
      // D10.8: match control through ArcAid for a paired companion (the Witness device credentials); null: not paired.
      relay: () => {
        const cur = store.get();
        return cur.token ? { baseUrl: cur.arcaidBaseUrl, deviceId: cur.deviceId, deviceToken: cur.token } : null;
      },
      // I11.4.18: VPX gets the foreground back when a Castcade window (this one, the desktop panel) holds it and this
      // PC's table is the one to play. This process owns those windows, so Windows lets it hand the foreground on.
      // At a grant it is not handed on while the player types in Castcade (`vpxForeground`, above).
      foreground: vpxForeground,
      appVersion,
      log: logger,
    });
    match = matchHost;
    matchHost.onStatus((st) => {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.matchStatusEvent, st);
      updater?.refresh(); // E9: an update waits for the match
    });
    // A15: Castcade was in a match under a minute ago (a crash, a restart for an update): back into it without a click.
    // An older one waits on the Match tab for the player's word.
    const back = matchHost.status().resume;
    if (back?.auto) {
      logger.info(`match: rejoining ${back.code} (Castcade was in it a moment ago)`);
      const mh = matchHost;
      void mh.rejoin().catch((e: unknown) => logger.warn(`match: could not rejoin ${back.code}: ${describeError(e)}`));
    }
  } catch (e) {
    logger.error(`match: could not set up (${describeError(e)}); matches are off this run`);
  }

  // A14: one step to a match. Host with a table starts VPX the way a player does (`-Play`, the exe the witness last
  // saw); a `castcade://join/…` link joins and starts the host's table here. The spawner, the clipboard and the table
  // lists are handed in (one-step.ts imports no Electron); a failure here leaves Host and Join as they were.
  if (matchHost) {
    try {
      const recentFile = join(userData, 'recent-tables.json');
      const recent = createRecentTables({
        read: () => (existsSync(recentFile) ? readFileSync(recentFile, 'utf8') : null),
        write: (text) => writeFileSync(recentFile, text),
      });
      host.onStatus((st) => {
        const file = st.currentIdentity?.filePath;
        if (file) recent.note(file, new Date().toISOString());
      });
      const known = () => listKnownTables({ fs: nodeFs, manifestDir, dataDir: store.get().dataDir, recent: recent.played });
      const hashesFile = join(userData, 'table-hashes.json');
      const tableHasher = createTableHasher({
        fs: nodeFs,
        io: { read: () => (existsSync(hashesFile) ? readFileSync(hashesFile, 'utf8') : null), write: (text) => writeFileSync(hashesFile, text) },
      });
      oneStep = createOneStep({
        match: matchHost,
        witness: host,
        launcher: createVpxLauncher({
          spawn: (command, args, options) => spawn(command, [...args], options),
          exists: async (p) => existsSync(p),
          exe: () => host.status().vpxExe ?? store.get().vpxExe ?? null,
          log: (line) => logger.info(line),
        }),
        clipboard: { writeText: (text) => clipboard.writeText(text) },
        tables: known,
        tableFiles: (have) => listTableFiles(nodeFs, tables.resolveTablesDir(null), have),
        // I11.4.11: the host's identical file is found among the copies of its title that nothing has hashed yet.
        hashTable: (vpxPath) => tableHasher.hashOf(vpxPath),
        arcaidBaseUrl: () => store.get().arcaidBaseUrl ?? null,
        log: logger,
      });
      oneStep.onStatus((st) => {
        if (win && !win.isDestroyed()) win.webContents.send(IPC.launchStatusEvent, st);
      });
      logger.info(registerLinkProtocol(app, { packaged: app.isPackaged, execPath: process.execPath, devEntry: !app.isPackaged && process.env.CASTCADE_REGISTER_LINKS === '1' && argv[0] ? resolve(argv[0]) : null }));
    } catch (e) {
      logger.error(`launch: could not set up (${describeError(e)}); Host and Join work as before, without the table start and the link`);
    }
  }

  // I11.4.1: the 3D watch session (ADR 0011's fork, its stream carried between PCs over a WebRTC data channel, every
  // socket on loopback). Through ArcAid like a match: paired only, and never while a match is on. A failure here only
  // turns 3D watch off for this run.
  if (features.watch3d) try {
    const mhost = matchHost;
    watch3d = createWatchHost({
      relay: () => {
        const cur = store.get();
        return cur.token ? { baseUrl: cur.arcaidBaseUrl, deviceId: cur.deviceId, deviceToken: cur.token } : null;
      },
      me: () => {
        const cur = store.get();
        const st = mhost?.status();
        return { id: cur.deviceId, name: st?.settings.displayName ?? st?.defaultName ?? cur.deviceLabel };
      },
      appVersion,
      log: logger,
      logsDir: dirname(logger.file),
      vpxExe: () => host.status().vpxExe ?? store.get().vpxExe ?? null,
      exists: async (p) => existsSync(p),
      size: async (p) => {
        try {
          const st = await stat(p);
          return st.isFile() ? st.size : null;
        } catch {
          return null;
        }
      },
      launcher: createVpxLauncher({
        spawn: (command, args, options) => spawn(command, [...args], options),
        exists: async (p) => existsSync(p),
        exe: () => host.status().vpxExe ?? store.get().vpxExe ?? null,
        log: (line) => logger.info(line),
      }),
      expectVpx: (e) => hiddenVpx.expect(e),
      tables: async () => {
        const known = await listKnownTables({ fs: nodeFs, manifestDir, dataDir: store.get().dataDir });
        return [...known, ...(await listTableFiles(nodeFs, tables.resolveTablesDir(null), known))];
      },
      iceServers: () => iceServers(mediaSettings.get()),
      tunnel: (o) => createTunnelEnd(o),
      freePort: freeLoopbackPort,
      matchBusy: () => {
        const st = mhost?.status();
        if (!st) return null;
        if (st.phase === 'connecting') return 'This PC is joining a match';
        return st.role === 'none' ? null : 'This PC is in a match';
      },
      pageDir: userData,
    });
    watch3d.onStatus((st) => {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.watchStatusEvent, st);
      updater?.refresh(); // E9: an update waits for the 3D watch session
    });
  } catch (e) {
    logger.error(`watch: could not set up (${describeError(e)}); 3D watch is off this run`);
  }

  registerIpc(store, host, tables, watch, logger, streamHost, matchHost, oneStep);
  host.onNotice((n) => {
    // C11: a table the import would patch: clicking the balloon is Patch now.
    if (n.kind === 'unpatched' && n.patchable) {
      tray?.notify(n.title, `${n.message} Click here to patch it now.`, () => {
        void tables
          .patchTable(n.vpxPath)
          .then((r) => patchNowResult(r, logger))
          .catch((e: unknown): TablesPatchNowResult => ({ ok: false, text: `could not patch it: ${describeError(e)}` }))
          .then((r) => tray?.notify(r.ok ? 'Castcade patched the table' : 'Castcade could not patch the table', `${n.table}: ${r.text}.`));
      });
      return;
    }
    tray?.notify(n.title, n.message);
    // C10: a patch the VPX editor saved into a table gets a fresh sidecar over it, so the next launch runs one Castcade can keep current.
    if (n.kind === 'embedded_patch') {
      void tables.repair(n.vpxPath).then((r) => {
        if (r.result === 'patched') return;
        logger.warn(`tables: repair of ${n.table} ${r.result}: ${r.detail}`);
        if (r.result === 'failed') tray?.notify('Castcade could not re-patch a table', `${n.table}: ${r.detail}. Settings → Import tables → Patch my tables.`);
      });
    }
  });

  // A14: a link on the command line brings the window up even with `--hidden`. E9: the start after an update that a
  // `--hidden` start installed stays in the tray too (the installer starts Castcade with `--updated` only).
  if ((!argv.includes('--hidden') && !hiddenAfterUpdate) || earlyLink) win = createWindow();
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
    updateWaiting: () => updater?.status().waiting ?? null,
    restartToUpdate: () => void restartToUpdate(host, 'tray'),
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
    updater?.refresh(); // E9: an update waits while a table is open
    tray?.refresh(status);
    if (win && !win.isDestroyed()) win.webContents.send(IPC.witnessStatusEvent, status);
    overlay?.publish();
    streamHost?.noteOverlay(overlayStateFrom(host.status(), host.liveGame())); // D1.4: the same state, burned in
  });
  host.onGame(() => {
    overlay?.publish();
    streamHost?.noteOverlay(overlayStateFrom(host.status(), host.liveGame()));
  });

  await host.start();
  watch.start();

  // A14: the link this instance was started with (or one a second instance handed over during startup). The window
  // was not up when it came, so it waits for the player's click on the Match tab.
  if (earlyLink) {
    const link = earlyLink;
    earlyLink = null;
    if (oneStep) openLink(link, true);
    else logger.warn('links: a castcade:// link arrived, but matches are off this run');
  }

  // D1.1: the overlay page OBS adds as a browser source. A taken port is logged, never fatal.
  const page = features.overlayServer ? createOverlayServer({ state: () => overlayStateFrom(host.status(), host.liveGame()), log: (line) => logger.info(line) }) : null;
  await page?.start().then(
    () => {
      overlay = page;
    },
    (err: unknown) => logger.warn(`overlay: could not start (${describeError(err)}); the OBS overlay is off this run`),
  );

  // E9: the update offer (window banner, tray menu, balloons) and the periodic check.
  if (updater) {
    const u = updater;
    u.onStatus((s) => {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.appUpdateStatusEvent, s);
      tray?.refresh(host.status());
    });
    u.onNotice((n) => updateBalloon(n, host));
    u.startChecks();
  }
}
