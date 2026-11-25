/**
 * Sandboxed preload (CommonJS: Electron's sandboxed preloads cannot be ESM, hence `.cts`).
 * Exposes `window.castcade` (see `../main/ipc-types.ts` for the shape; `renderer/src/castcade.d.ts`
 * mirrors it). Every call is `ipcMain.handle`-backed; the pushes are `witness:status`, `tables:progress`, `stream:statusEvent`,
 * `stream:previewEvent`, `match:statusEvent`, `launch:statusEvent`, `watch:statusEvent` and `app:update:statusEvent`.
 * The two versions and the edition (E10) arrive on argv via `webPreferences.additionalArguments` (see main/index.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import electron = require('electron');
import type { CastcadeApi, EngineStatus, MatchStatus, OneStepStatus, PreviewStatus, UpdateStatus, WatchStatus, WitnessStatus, TablesProgress } from '../main/ipc-types.js';

// Channel names are duplicated here on purpose: a sandboxed preload cannot load `../main/ipc-types.js`
// at runtime, and `import type` is erased. Keep in step with `IPC` in that file.
const CH = {
  witnessStatus: 'witness:status',
  witnessPair: 'witness:pair',
  witnessUnpair: 'witness:unpair',
  witnessSetPaused: 'witness:setPaused',
  witnessConfirmTable: 'witness:confirmTable',
  witnessStartAttempts: 'witness:startAttempts',
  witnessSendLogs: 'witness:sendLogs',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appOpenExternal: 'app:openExternal',
  appVersions: 'app:versions',
  appLoginItemGet: 'app:loginItem:get',
  appLoginItemSet: 'app:loginItem:set',
  appLogPath: 'app:logPath',
  appOverlayUrl: 'app:overlayUrl',
  appPickFolder: 'app:pickFolder',
  appClipboardText: 'app:clipboardText',
  appUpdateStatus: 'app:update:status',
  appUpdateInstall: 'app:update:install',
  appUpdateStatusEvent: 'app:update:statusEvent',
  tablesDefaults: 'tables:defaults',
  tablesPlan: 'tables:plan',
  tablesApply: 'tables:apply',
  tablesRemoveAll: 'tables:removeAll',
  tablesPatchNow: 'tables:patchNow',
  tablesProgressEvent: 'tables:progress',
  launchStatus: 'launch:status',
  launchTables: 'launch:tables',
  launchBrowse: 'launch:browse',
  launchHost: 'launch:host',
  launchStartTable: 'launch:startTable',
  launchConfirm: 'launch:confirm',
  launchDismiss: 'launch:dismiss',
  launchCopy: 'launch:copy',
  launchViewing: 'launch:viewing',
  launchStatusEvent: 'launch:statusEvent',
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
  matchStatus: 'match:status',
  matchHost: 'match:host',
  matchJoin: 'match:join',
  matchStart: 'match:start',
  matchResume: 'match:resume',
  matchPassTurn: 'match:passTurn',
  matchEndMyBall: 'match:endMyBall',
  matchSaveFrames: 'match:saveFrames',
  matchBenchStart: 'match:bench:start',
  matchBenchStop: 'match:bench:stop',
  matchBenchView: 'match:bench:view',
  matchBenchClips: 'match:bench:clips',
  matchLeave: 'match:leave',
  matchCancelStart: 'match:cancelStart',
  matchEnd: 'match:end',
  matchStance: 'match:stance',
  matchGiveUp: 'match:giveUp',
  matchAnswerAway: 'match:answerAway',
  matchPlayOnWithout: 'match:playOnWithout',
  matchRejoin: 'match:rejoin',
  matchForgetResume: 'match:forgetResume',
  matchSettingsSet: 'match:settings:set',
  matchSetMicrophone: 'match:setMicrophone',
  matchSetMuted: 'match:setMuted',
  matchSetTurn: 'match:setTurn',
  matchSetVideoPath: 'match:setVideoPath',
  matchSetVideoRungs: 'match:setVideoRungs',
  matchShowPanel: 'match:showPanel',
  matchHidePanel: 'match:hidePanel',
  matchVrReport: 'match:vrReport',
  matchSetVrTest: 'match:setVrTest',
  watchStatus: 'watch:status',
  watchHost: 'watch:host',
  watchJoin: 'watch:join',
  watchLeave: 'watch:leave',
  watchPlay: 'watch:play',
  watchWatch: 'watch:watch',
  watchPickTable: 'watch:pickTable',
  witnessStatusEvent: 'witness:status',
  streamStatusEvent: 'stream:statusEvent',
  streamPreviewEvent: 'stream:previewEvent',
  matchStatusEvent: 'match:statusEvent',
  watchStatusEvent: 'watch:statusEvent',
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
  edition: argValue('castcade-edition') === 'witness' ? 'witness' : 'full',
  witness: {
    status: () => ipcRenderer.invoke(CH.witnessStatus),
    pair: (code) => ipcRenderer.invoke(CH.witnessPair, code),
    unpair: () => ipcRenderer.invoke(CH.witnessUnpair),
    setPaused: (paused) => ipcRenderer.invoke(CH.witnessSetPaused, paused),
    confirmTable: (filePath, vpsTableId) => ipcRenderer.invoke(CH.witnessConfirmTable, filePath, vpsTableId),
    startAttempts: () => ipcRenderer.invoke(CH.witnessStartAttempts),
    sendLogs: () => ipcRenderer.invoke(CH.witnessSendLogs),
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
    clipboardText: () => ipcRenderer.invoke(CH.appClipboardText),
    update: {
      status: () => ipcRenderer.invoke(CH.appUpdateStatus),
      install: () => ipcRenderer.invoke(CH.appUpdateInstall),
      onStatus(cb) {
        const listener = (_e: Electron.IpcRendererEvent, s: UpdateStatus): void => cb(s);
        ipcRenderer.on(CH.appUpdateStatusEvent, listener);
        return () => {
          ipcRenderer.removeListener(CH.appUpdateStatusEvent, listener);
        };
      },
    },
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
  match: {
    status: () => ipcRenderer.invoke(CH.matchStatus),
    host: (opts) => ipcRenderer.invoke(CH.matchHost, opts),
    join: (invite, displayName) => ipcRenderer.invoke(CH.matchJoin, invite, displayName),
    start: (opts) => ipcRenderer.invoke(CH.matchStart, opts),
    passTurn: () => ipcRenderer.invoke(CH.matchPassTurn),
    endMyBall: (grantSeq) => ipcRenderer.invoke(CH.matchEndMyBall, grantSeq),
    resume: () => ipcRenderer.invoke(CH.matchResume),
    saveFrames: () => ipcRenderer.invoke(CH.matchSaveFrames),
    benchStart: (req) => ipcRenderer.invoke(CH.matchBenchStart, req),
    benchStop: () => ipcRenderer.invoke(CH.matchBenchStop),
    benchView: (view) => ipcRenderer.invoke(CH.matchBenchView, view),
    benchClips: () => ipcRenderer.invoke(CH.matchBenchClips),
    leave: () => ipcRenderer.invoke(CH.matchLeave),
    cancelStart: () => ipcRenderer.invoke(CH.matchCancelStart),
    endMatch: (o) => ipcRenderer.invoke(CH.matchEnd, o),
    setStance: (stance) => ipcRenderer.invoke(CH.matchStance, stance),
    giveUp: (o) => ipcRenderer.invoke(CH.matchGiveUp, o),
    answerAway: (answer, o) => ipcRenderer.invoke(CH.matchAnswerAway, answer, o),
    playOnWithout: (o) => ipcRenderer.invoke(CH.matchPlayOnWithout, o),
    rejoin: () => ipcRenderer.invoke(CH.matchRejoin),
    forgetResume: () => ipcRenderer.invoke(CH.matchForgetResume),
    setSettings: (patch) => ipcRenderer.invoke(CH.matchSettingsSet, patch),
    setMicrophone: (deviceId) => ipcRenderer.invoke(CH.matchSetMicrophone, deviceId),
    setMuted: (muted) => ipcRenderer.invoke(CH.matchSetMuted, muted),
    setTurn: (turn) => ipcRenderer.invoke(CH.matchSetTurn, turn),
    setVideoPath: (path) => ipcRenderer.invoke(CH.matchSetVideoPath, path),
    setVideoRungs: (rungs) => ipcRenderer.invoke(CH.matchSetVideoRungs, rungs),
    showPanel: () => ipcRenderer.invoke(CH.matchShowPanel),
    hidePanel: () => ipcRenderer.invoke(CH.matchHidePanel),
    vrReport: () => ipcRenderer.invoke(CH.matchVrReport),
    setVrTest: (test) => ipcRenderer.invoke(CH.matchSetVrTest, test),
    onStatus(cb) {
      const listener = (_e: Electron.IpcRendererEvent, s: MatchStatus): void => cb(s);
      ipcRenderer.on(CH.matchStatusEvent, listener);
      return () => {
        ipcRenderer.removeListener(CH.matchStatusEvent, listener);
      };
    },
  },
  launch: {
    status: () => ipcRenderer.invoke(CH.launchStatus),
    tables: () => ipcRenderer.invoke(CH.launchTables),
    browse: () => ipcRenderer.invoke(CH.launchBrowse),
    host: (opts) => ipcRenderer.invoke(CH.launchHost, opts),
    startTable: () => ipcRenderer.invoke(CH.launchStartTable),
    confirm: () => ipcRenderer.invoke(CH.launchConfirm),
    dismiss: () => ipcRenderer.invoke(CH.launchDismiss),
    copy: (what) => ipcRenderer.invoke(CH.launchCopy, what),
    viewing: (matchTab) => ipcRenderer.invoke(CH.launchViewing, matchTab),
    onStatus(cb) {
      const listener = (_e: Electron.IpcRendererEvent, s: OneStepStatus): void => cb(s);
      ipcRenderer.on(CH.launchStatusEvent, listener);
      return () => {
        ipcRenderer.removeListener(CH.launchStatusEvent, listener);
      };
    },
  },
  watch: {
    status: () => ipcRenderer.invoke(CH.watchStatus),
    host: () => ipcRenderer.invoke(CH.watchHost),
    join: (code) => ipcRenderer.invoke(CH.watchJoin, code),
    leave: () => ipcRenderer.invoke(CH.watchLeave),
    play: (tablePath) => ipcRenderer.invoke(CH.watchPlay, tablePath),
    watch: (tablePath) => ipcRenderer.invoke(CH.watchWatch, tablePath),
    pickTable: () => ipcRenderer.invoke(CH.watchPickTable),
    onStatus(cb) {
      const listener = (_e: Electron.IpcRendererEvent, s: WatchStatus): void => cb(s);
      ipcRenderer.on(CH.watchStatusEvent, listener);
      return () => {
        ipcRenderer.removeListener(CH.watchStatusEvent, listener);
      };
    },
  },
  tables: {
    defaults: () => ipcRenderer.invoke(CH.tablesDefaults),
    plan: (dir) => ipcRenderer.invoke(CH.tablesPlan, dir),
    apply: (dir) => ipcRenderer.invoke(CH.tablesApply, dir),
    removeAll: (dir) => ipcRenderer.invoke(CH.tablesRemoveAll, dir),
    patchNow: (vpxPath) => ipcRenderer.invoke(CH.tablesPatchNow, vpxPath),
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
