/**
 * Tray icon + menu. The menu is rebuilt whenever status or an update changes, so the Pause/Resume
 * and Start-with-Windows items always reflect reality. The tooltip is the "proof of life" line.
 */
import { Menu, Tray, nativeImage } from 'electron';
import type { WitnessStatus } from '../witness/types.js';

export interface TrayActions {
  open(): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  loginItemSupported(): boolean;
  getOpenAtLogin(): boolean;
  setOpenAtLogin(on: boolean): void;
  pendingUpdate(): string | null;
  /** D1.2 / D1.3: what the stream engine is doing; null hides the items (no stream host). */
  streamState?(): { running: boolean; live: boolean; recording: boolean; hasKey: boolean } | null;
  streamStart?(want: { record: boolean; live: boolean }): void;
  streamStop?(): void;
  restartToUpdate(): void;
  quit(): void;
}

export interface TrayHandle {
  refresh(status: WitnessStatus): void;
  notify(title: string, content: string): void;
  destroy(): void;
}

export function proofOfLife(status: WitnessStatus, paused: boolean): string {
  const parts = ['Castcade'];
  parts.push(status.paired ? 'paired' : 'not paired');
  parts.push(paused ? 'paused' : status.running ? 'watching' : 'stopped');
  if (status.currentTable) parts.push(`playing ${status.currentTable}`);
  else if (status.lastCapture) {
    const c = status.lastCapture;
    parts.push(`last: ${c.table}${c.score !== null ? ` ${c.score.toLocaleString()}` : ''} (${c.outcome})`);
  }
  if (status.queued > 0) parts.push(`${status.queued} queued`);
  if (status.sendingTo && !status.currentTable) parts.push(`→ ${status.sendingTo}`);
  return parts.join(' · ');
}

export function createTray(iconPath: string, actions: TrayActions, initial: WitnessStatus): TrayHandle {
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.on('click', () => actions.open());
  tray.on('double-click', () => actions.open());

  const build = (status: WitnessStatus): void => {
    const paused = actions.isPaused();
    const pending = actions.pendingUpdate();
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: 'Open Castcade', click: () => actions.open() },
      { type: 'separator' },
      { label: paused ? 'Resume watching' : 'Pause watching', click: () => actions.setPaused(!paused) },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: actions.getOpenAtLogin(),
        enabled: actions.loginItemSupported(),
        click: (item) => actions.setOpenAtLogin(item.checked),
      },
    ];
    const st = actions.streamState?.() ?? null;
    if (st) {
      template.push({ type: 'separator' });
      if (st.running) template.push({ label: st.live ? 'Stop streaming' : 'Stop recording', click: () => actions.streamStop?.() });
      else {
        template.push(
          { label: 'Go live and record', enabled: st.hasKey, click: () => actions.streamStart?.({ record: true, live: true }) },
          { label: 'Record only', click: () => actions.streamStart?.({ record: true, live: false }) },
        );
      }
    }
    if (pending) {
      template.push({ type: 'separator' }, { label: `Restart to update to v${pending}`, click: () => actions.restartToUpdate() });
    }
    template.push({ type: 'separator' }, { label: 'Quit Castcade', click: () => actions.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(proofOfLife(status, paused));
  };
  build(initial);

  return {
    refresh: build,
    notify(title, content) {
      if (process.platform === 'win32') tray.displayBalloon({ title, content, iconType: 'info' });
    },
    destroy: () => tray.destroy(),
  };
}
