/**
 * Sandboxed preload (CommonJS: Electron's sandboxed preloads cannot be ESM, hence `.cts`).
 * Exposes `window.castcade` (see `../main/ipc-types.ts` for the shape; `renderer/src/castcade.d.ts`
 * mirrors it). Every call is `ipcMain.handle`-backed; the pushes are `witness:status`, `tables:progress`, `stream:statusEvent`
 * and `stream:previewEvent`.
 * The two versions arrive on argv via `webPreferences.additionalArguments` (see main/index.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import electron = require('electron');
import type { CastcadeApi, EngineStatus, PreviewStatus, WitnessStatus, TablesProgress } from '../main/ipc-types.js';

// Channel names are duplicated here on purpose: a sandboxed preload cannot load `../main/ipc-types.js`
// at runtime, and `import type` is erased. Keep in step with `IPC` in that file.
const CH = {
  witnessStatus: 'witness:status',
  witnessPair: 'witness:pair',
  witnessUnpair: 'witness:unpair',
  witnessSetPaused: 'witness:setPaused',
  witnessConfirmTable: 'witness:confirmTable',
  witnessStartAttempts: 'witness:startAttempts',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appOpenExternal: 'app:openExternal',
  appVersions: 'app:versions',
  appLoginItemGet: 'app:loginItem:get',
  appLoginItemSet: 'app:loginItem:set',
  appLogPath: 'app:logPath',
  appOverlayUrl: 'app:overlayUrl',
  appPickFolder: 'app:pickFolder',
  tablesDefaults: 'tables:defaults',
  tablesPlan: 'tables:plan',
  tablesApply: 'tables:apply',
  tablesRemoveAll: 'tables:removeAll',
  tablesProgressEvent: 'tables:progress',
  streamStatus: 'stream:status',
  streamStart: 'stream:start',
  streamStop: 'stream:stop',
  streamSettingsGet: 'stream:settings:get',
  streamSettingsSet: 'stream:settings:set',
  streamSetKey: 'stream:setKey',
  streamOpenRecordings: 'stream:openRecordings',
  streamPreviewStart: 'stream:preview:start',
  streamPreviewStop: 'stream:preview:stop',
  streamPreviewStatus: 'stream:preview:status',
  witnessStatusEvent: 'witness:status',
  streamStatusEvent: 'stream:statusEvent',
  streamPreviewEvent: 'stream:previewEvent',
} as const;

function argValue(flag: string): string {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : 'unknown';
}

const { ipcRenderer } = electron;

const castcade: CastcadeApi = {
  appVersion: argValue('castcade-app-version'),
  protocolVersion: Number(argValue('castcade-protocol-version')),
  platform: process.platform,
  witness: {
    status: () => ipcRenderer.invoke(CH.witnessStatus),
    pair: (code) => ipcRenderer.invoke(CH.witnessPair, code),
    unpair: () => ipcRenderer.invoke(CH.witnessUnpair),
    setPaused: (paused) => ipcRenderer.invoke(CH.witnessSetPaused, paused),
    confirmTable: (filePath, vpsTableId) => ipcRenderer.invoke(CH.witnessConfirmTable, filePath, vpsTableId),
    startAttempts: () => ipcRenderer.invoke(CH.witnessStartAttempts),
    onStatus(cb) {
      const listener = (_e: Electron.IpcRendererEvent, status: WitnessStatus): void => cb(status);
      ipcRenderer.on(CH.witnessStatusEvent, listener);
      return () => {
        ipcRenderer.removeListener(CH.witnessStatusEvent, listener);
      };
    },
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (patch) => ipcRenderer.invoke(CH.settingsSet, patch),
  },
  app: {
    openExternal: (url) => ipcRenderer.invoke(CH.appOpenExternal, url),
    versions: () => ipcRenderer.invoke(CH.appVersions),
    loginItem: {
      get: () => ipcRenderer.invoke(CH.appLoginItemGet),
      set: (on) => ipcRenderer.invoke(CH.appLoginItemSet, on),
    },
    logPath: () => ipcRenderer.invoke(CH.appLogPath),
    overlayUrl: () => ipcRenderer.invoke(CH.appOverlayUrl),
    pickFolder: (defaultPath) => ipcRenderer.invoke(CH.appPickFolder, defaultPath),
  },
  stream: {
    status: () => ipcRenderer.invoke(CH.streamStatus),
    start: (want) => ipcRenderer.invoke(CH.streamStart, want),
    stop: () => ipcRenderer.invoke(CH.streamStop),
    settings: () => ipcRenderer.invoke(CH.streamSettingsGet),
    setSettings: (patch) => ipcRenderer.invoke(CH.streamSettingsSet, patch),
    setKey: (key) => ipcRenderer.invoke(CH.streamSetKey, key),
    openRecordings: () => ipcRenderer.invoke(CH.streamOpenRecordings),
    onStatus(cb) {
      const listener = (_e: Electron.IpcRendererEvent, s: EngineStatus): void => cb(s);
      ipcRenderer.on(CH.streamStatusEvent, listener);
      return () => {
        ipcRenderer.removeListener(CH.streamStatusEvent, listener);
      };
    },
    preview: {
      start: () => ipcRenderer.invoke(CH.streamPreviewStart),
      stop: () => ipcRenderer.invoke(CH.streamPreviewStop),
      status: () => ipcRenderer.invoke(CH.streamPreviewStatus),
      onStatus(cb) {
        const listener = (_e: Electron.IpcRendererEvent, s: PreviewStatus): void => cb(s);
        ipcRenderer.on(CH.streamPreviewEvent, listener);
        return () => {
          ipcRenderer.removeListener(CH.streamPreviewEvent, listener);
        };
      },
    },
  },
  tables: {
    defaults: () => ipcRenderer.invoke(CH.tablesDefaults),
    plan: (dir) => ipcRenderer.invoke(CH.tablesPlan, dir),
    apply: (dir) => ipcRenderer.invoke(CH.tablesApply, dir),
    removeAll: (dir) => ipcRenderer.invoke(CH.tablesRemoveAll, dir),
    onProgress(cb) {
      const listener = (_e: Electron.IpcRendererEvent, p: TablesProgress): void => cb(p);
      ipcRenderer.on(CH.tablesProgressEvent, listener);
      return () => {
        ipcRenderer.removeListener(CH.tablesProgressEvent, listener);
      };
    },
  },
};

electron.contextBridge.exposeInMainWorld('castcade', castcade);
