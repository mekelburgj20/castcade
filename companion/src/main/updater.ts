/**
 * electron-updater wiring: packaged builds check GitHub Releases once at launch, download in the
 * background, log every step, and only then tell the user through one tray balloon ("restart to
 * install"). Nothing blocks, nothing prompts. The installed update applies on the next quit.
 * Unsigned PoC builds: electron-updater skips signature verification when no publisherName is set.
 */
import type { AppUpdater } from 'electron-updater';
import type { Logger } from './log.js';
import { describeError } from './log.js';

export interface UpdaterCallbacks {
  /** Called once an update has been downloaded; the tray shows it and offers "Restart to update". */
  onDownloaded(version: string): void;
}

export interface UpdaterHandle {
  /** Resolves to null when no update is downloaded; otherwise the pending version. */
  pendingVersion(): string | null;
  /** Quit and install the downloaded update (no-op when none is pending). */
  quitAndInstall(): void;
}

export async function startUpdater(log: Logger, cb: UpdaterCallbacks): Promise<UpdaterHandle> {
  let pending: string | null = null;
  let updater: AppUpdater | null = null;
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
    await updater.checkForUpdates();
  } catch (e) {
    log.warn(`updater: check failed: ${describeError(e)}`);
  }
  return {
    pendingVersion: () => pending,
    quitAndInstall() {
      if (pending && updater) updater.quitAndInstall(false, true);
    },
  };
}
