/**
 * Electron main process entry (Phase 2 shell). One window, no tray, no IPC beyond the preload's
 * contextBridge. `--smoke` prints the bundle identity and exits before any window exists, so
 * humans and CI can verify the build without a display.
 */
import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@castcade/protocol';

const here = dirname(fileURLToPath(import.meta.url)); // <companion>/dist/main
const appVersion = app.getVersion();

if (process.argv.includes('--smoke')) {
  process.stdout.write(`castcade ${appVersion} protocol ${PROTOCOL_VERSION}\n`);
  app.exit(0);
} else {
  void app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 720,
    height: 480,
    title: 'Castcade',
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
  win.removeMenu();

  const devUrl = process.env.CASTCADE_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(here, '..', 'renderer', 'index.html'));
  }
}
