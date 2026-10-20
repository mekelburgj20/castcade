/**
 * electron-updater wiring: packaged builds check GitHub Releases at launch and then keep checking
 * while the tray app runs (every few hours, sooner after a failed check), download in the background,
 * log every step, and only then tell the user through one tray balloon ("restart to install").
 * Nothing blocks, nothing prompts. The installed update applies on the next quit.
 * Unsigned PoC builds: electron-updater skips signature verification when no publisherName is set.
 */
import type { AppUpdater } from 'electron-updater';
import type { Logger } from './log.js';
import { describeError } from './log.js';

/** Interval between successful checks. A tray app can run for days; one check at launch is not enough. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Retry delay after a failed check (offline at boot, GitHub hiccup, release still being uploaded). */
export const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;

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

export interface UpdaterCallbacks {
  /** Called once an update has been downloaded; the tray shows it and offers "Restart to update". */
  onDownloaded(version: string): void;
}

export interface UpdaterHandle {
  /** Resolves to null when no update is downloaded; otherwise the pending version. */
  pendingVersion(): string | null;
  /** Quit and install the downloaded update (no-op when none is pending). */
  quitAndInstall(): void;
  /** Stop the periodic re-check (the app is quitting). */
  stop(): void;
}

export async function startUpdater(log: Logger, cb: UpdaterCallbacks): Promise<UpdaterHandle> {
  let pending: string | null = null;
  let updater: AppUpdater | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let checking = false;

  const check = async (): Promise<CheckOutcome> => {
    if (!updater || checking) return pending ? 'downloaded' : 'failed';
    checking = true;
    try {
      await updater.checkForUpdates();
      return pending ? 'downloaded' : 'ok';
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
    timer = setTimeout(() => {
      timer = null;
      void check().then(schedule);
    }, delay);
    // Never keep the process alive for a re-check.
    (timer as { unref?: () => void }).unref?.();
  };

  try {
    // Dynamic import: electron-updater is CommonJS and instantiates platform state on access;
    // keep it out of the --smoke path and out of development runs entirely.
    // electron-updater defines `autoUpdater` as a CJS getter, which Node's ESM named-export
    // detection does not see: read it off the CJS namespace (`default`) instead.
    const ns = await import('electron-updater');
    const cjs = (ns as unknown as { default?: typeof ns }).default ?? ns;
    updater = cjs.autoUpdater;
    if (!updater) throw new Error('electron-updater did not expose autoUpdater');
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    // The PoC ships as GitHub pre-releases (unsigned until GA); installed apps must still see them.
    updater.allowPrerelease = true;
    updater.logger = {
      info: (m: unknown) => log.info(`updater: ${String(m)}`),
      warn: (m: unknown) => log.warn(`updater: ${String(m)}`),
      error: (m: unknown) => log.error(`updater: ${String(m)}`),
      debug: (m: unknown) => log.debug(`updater: ${String(m)}`),
    };
    updater.on('update-available', (info) => log.info(`updater: update available ${info.version}`));
    updater.on('update-not-available', () => log.info('updater: up to date'));
    updater.on('error', (e) => log.warn(`updater: ${describeError(e)}`));
    updater.on('update-downloaded', (info) => {
      pending = info.version;
      log.info(`updater: downloaded ${info.version}; installs on next quit`);
      cb.onDownloaded(info.version);
    });
  } catch (e) {
    log.warn(`updater: unavailable: ${describeError(e)}`);
  }
  // The first check runs now; the download (if any) continues in the background after it resolves,
  // so a 'downloaded' outcome usually arrives through the event and simply ends the schedule later.
  schedule(await check());

  return {
    pendingVersion: () => pending,
    quitAndInstall() {
      if (pending && updater) updater.quitAndInstall(false, true);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
