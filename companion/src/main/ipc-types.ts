/**
 * The IPC surface between main and renderer. The preload imports these types only (`import type`,
 * erased at build time: a sandboxed preload cannot load modules). `renderer/src/castcade.d.ts`
 * mirrors the same shapes by hand because the renderer is a separate tsconfig.
 */
import type { RedactedSettings, SettingsPatch } from './settings.js';
import type { WitnessStatus } from '../witness/types.js';
import type { EngineStatus } from '../media/stream-engine.js';
import type { StreamSettings } from '../media/stream-settings.js';
import type { PreviewStatus, StreamSettingsView } from './stream-host.js';
import type { MatchStatus } from './match-host.js';
import type { MatchSettings } from './match-setup.js';
import type { ClipSummary, SaveFramesResult } from '../media/frame-clip.js';
import type { BenchStatus } from '../media/bench.js';
import type { OneStepStatus, TableChoice } from './one-step.js';

export type { OneStepStatus, TableChoice };
export type { EngineStatus, MatchSettings, MatchStatus, PreviewStatus, BenchStatus, ClipSummary, RedactedSettings, SaveFramesResult, SettingsPatch, StreamSettings, StreamSettingsView, WitnessStatus };

export const IPC = {
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
  appClipboardText: 'app:clipboardText',
  tablesDefaults: 'tables:defaults',
  tablesPlan: 'tables:plan',
  tablesApply: 'tables:apply',
  tablesRemoveAll: 'tables:removeAll',
  tablesPatchNow: 'tables:patchNow',
  tablesProgressEvent: 'tables:progress',
  /** A14: one step to a match (main/one-step.ts): the table picker, Host with a table, the join link, a link's confirmation. */
  launchStatus: 'launch:status',
  launchTables: 'launch:tables',
  launchBrowse: 'launch:browse',
  launchHost: 'launch:host',
  launchConfirm: 'launch:confirm',
  launchDismiss: 'launch:dismiss',
  launchCopy: 'launch:copy',
  /** A14: the renderer says whether the Match tab is showing (a link from outside acts without a click only then). */
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
  /** A13: the host's Pass the turn. */
  matchPassTurn: 'match:passTurn',
  /** D7.6.3: save 2 s of eye frames to the logs folder. */
  matchSaveFrames: 'match:saveFrames',
  /** D7.6: the VR test bench. */
  matchBenchStart: 'match:bench:start',
  matchBenchStop: 'match:bench:stop',
  matchBenchView: 'match:bench:view',
  matchBenchClips: 'match:bench:clips',
  matchLeave: 'match:leave',
  matchRejoin: 'match:rejoin',
  matchForgetResume: 'match:forgetResume',
  matchSettingsSet: 'match:settings:set',
  matchSetMicrophone: 'match:setMicrophone',
  matchSetMuted: 'match:setMuted',
  matchSetTurn: 'match:setTurn',
  /** D10.3: the spectator video path (native helper / Electron), saved in media.json. */
  matchSetVideoPath: 'match:setVideoPath',
  /** D10.5: the native video ladder's ceiling (saved) and manual pin (this run). */
  matchSetVideoRungs: 'match:setVideoRungs',
  matchShowPanel: 'match:showPanel',
  matchHidePanel: 'match:hidePanel',
  /** D7.6.2: write the VR report (vr-report-<date>.md / .json beside companion.log). */
  matchVrReport: 'match:vrReport',
  /** D7.6.1: the OpenXR layer's calibration pattern on / off. */
  matchSetVrTest: 'match:setVrTest',
  /** main → renderer push (webContents.send). */
  witnessStatusEvent: 'witness:status',
  streamStatusEvent: 'stream:statusEvent',
  streamPreviewEvent: 'stream:previewEvent',
  matchStatusEvent: 'match:statusEvent',
} as const;

// ------------------------------------------------------------------------- table import (C7) --

/** What `planImport` decided for one `.vpx` (see `companion/src/patcher`). */
export type TablesPlanAction = 'patch' | 'repatch' | 'already' | 'skip' | 'foreign' | 'unsupported' | 'unreadable';

export interface TablesPlanItem {
  vpxPath: string;
  tableId: string;
  action: TablesPlanAction;
  /** Script class A–E or X, null when the file could not be read. */
  cls: string | null;
  rom: string | null;
  reason: string;
}

export interface TablesPlan {
  dir: string;
  items: TablesPlanItem[];
  counts: Record<TablesPlanAction, number>;
}

export interface TablesApplyResult {
  dir: string;
  patched: string[];
  failed: { tableId: string; error: string }[];
  /** Tables whose sidecar was already current (nothing to do). */
  already: number;
  /** Items the plan did not act on for another reason (skip / foreign / unsupported). */
  skipped: number;
  /** B12.1: of those, tables whose Castcade patch was removed (their machine's live score can't be read). */
  unpatched: number;
  libInstalled: 'installed' | 'updated' | 'unchanged';
  scriptsDir: string;
}

export interface TablesProgress {
  done: number;
  total: number;
  tableId: string;
}

/** C11: the answer to Patch now, as Status shows it (`ok` false = the table is still unpatched). */
export interface TablesPatchNowResult {
  ok: boolean;
  text: string;
}

export interface TablesRemoveResult {
  dir: string;
  removed: string[];
  keptForeign: string[];
}

/** What the import card is prefilled with. */
export interface TablesDefaults {
  /** The tables folder to offer: the `tablesDir` setting, else `<VPX exe folder>\tables` once a VPX exe was seen. */
  tablesDir: string | null;
  /** Where `castcade.vbs` is installed: `<VPX exe folder>\scripts`, null until a VPX exe was seen. */
  scriptsDir: string | null;
  vpxExe: string | null;
  /** The bundled hook library's version. */
  hookVersion: string;
}

export interface AppVersions {
  app: string;
  protocol: number;
  electron: string;
  chrome: string;
  node: string;
  packaged: boolean;
}

export interface LoginItemState {
  /** False when the toggle is unavailable (development build). */
  supported: boolean;
  openAtLogin: boolean;
}

/** The invoke() API exactly as the preload exposes it to the renderer. */
export interface CastcadeApi {
  readonly appVersion: string;
  readonly protocolVersion: number;
  readonly platform: string;
  witness: {
    status(): Promise<WitnessStatus>;
    pair(code: string): Promise<WitnessStatus>;
    unpair(): Promise<WitnessStatus>;
    setPaused(paused: boolean): Promise<WitnessStatus>;
    /** Remember the player's answer to "which VPS table is this file?"; null forgets it. */
    confirmTable(filePath: string, vpsTableId: string | null): Promise<WitnessStatus>;
    /** B21: press "Start attempts" on ArcAid (W45); the answer lands on `WitnessStatus.attemptStart`. */
    startAttempts(): Promise<WitnessStatus>;
    onStatus(cb: (status: WitnessStatus) => void): () => void;
  };
  settings: {
    get(): Promise<RedactedSettings>;
    set(patch: SettingsPatch): Promise<RedactedSettings>;
  };
  app: {
    openExternal(url: string): Promise<boolean>;
    versions(): Promise<AppVersions>;
    loginItem: {
      get(): Promise<LoginItemState>;
      set(openAtLogin: boolean): Promise<LoginItemState>;
    };
    logPath(): Promise<string>;
    /** D1.1: the OBS overlay page URL, or null when it is not running. */
    overlayUrl(): Promise<string | null>;
    /** Native folder picker; resolves to the chosen folder, or null when the player cancelled. */
    pickFolder(defaultPath: string | null): Promise<string | null>;
    /** A6: the clipboard's text, for the Paste buttons (no right-click menu is needed then). */
    clipboardText(): Promise<string>;
  };
  /** D1.2 / D1.3: record and / or go live. The key goes in, never comes back out. */
  stream: {
    status(): Promise<EngineStatus>;
    start(want: { record: boolean; live: boolean }): Promise<EngineStatus>;
    stop(): Promise<EngineStatus>;
    settings(): Promise<StreamSettingsView>;
    setSettings(patch: Partial<StreamSettings>): Promise<StreamSettingsView>;
    /** Stores the key encrypted; null or blank clears it. */
    setKey(key: string | null): Promise<StreamSettingsView>;
    /** Opens the recordings folder in Explorer. */
    openRecordings(): Promise<void>;
    onStatus(cb: (s: EngineStatus) => void): () => void;
    /** D1.5: the framing preview, an ffplay window showing what viewers would see; allowed while a capture runs. */
    preview: {
      start(): Promise<PreviewStatus>;
      stop(): Promise<PreviewStatus>;
      status(): Promise<PreviewStatus>;
      onStatus(cb: (s: PreviewStatus) => void): () => void;
    };
  };
  /** A6 + C3: host or join a match by invite string; the Match tab. */
  match: {
    status(): Promise<MatchStatus>;
    host(opts: { port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus>;
    join(invite: string, displayName: string): Promise<MatchStatus>;
    /**
     * Host only: freeze the roster (two or more players) and issue the first grant. A10 (2026-11-02): between games of a
     * series, Next game (NEXT_GAME, then grant 1 of it), the same as a game started on the host's table.
     * A13 (2026-11-12): in the lobby, while `startWarnings` is not empty (a table that cannot report ball ends), it
     * rejects unless `anyway` is true: the host's explicit confirmation.
     */
    start(opts?: { anyway?: boolean }): Promise<MatchStatus>;
    /** A13: host only, during a game: end the turn holder's ball at its last known score and grant the next turn (TURN_PASS). */
    passTurn(): Promise<MatchStatus>;
    /** A8 (2026-10-31): host only: end a pause nobody resumed. */
    resume(): Promise<MatchStatus>;
    /** D7.6.3 (2026-11-03): save the next 2 s of layer-camera and theater frames to `<logs>/frames/<date>/`. */
    saveFrames(): Promise<SaveFramesResult>;
    /**
     * D7.6 (2026-11-03): the VR test bench: start (refused during a match), stop, theater or VPX's own view, the saved
     * clips. `bitrate` (D7.6.9): the loop's cap in bits per second (1 to 100 Mbps), null or absent for the match's rule.
     */
    benchStart(req: { source: 'clip' | 'live'; path: 'direct' | 'loop'; clip: { name: string; side: 'sender' | 'receiver' } | null; bitrate?: number | null }): Promise<MatchStatus>;
    benchStop(): Promise<MatchStatus>;
    benchView(view: 'theater' | 'direct'): Promise<MatchStatus>;
    benchClips(): Promise<ClipSummary[]>;
    /** A10 (2026-11-02): the host's leave between games is End match: MATCH_END to everyone, then the teardown. */
    leave(): Promise<MatchStatus>;
    /** A15 (2026-11-12): go back into the match Castcade was in when it last closed (`MatchStatus.resume`); or drop it. */
    rejoin(): Promise<MatchStatus>;
    forgetResume(): Promise<MatchStatus>;
    setSettings(patch: Partial<MatchSettings>): Promise<MatchStatus>;
    /** D2: the microphone the match sends (null = the Windows default), saved in media.json. */
    setMicrophone(deviceId: string | null): Promise<MatchStatus>;
    setMuted(muted: boolean): Promise<MatchStatus>;
    /** D2.9: the TURN relay; null (or an empty url) clears it, a null credential keeps the saved one. */
    setTurn(turn: { url: string; username: string; credential: string | null } | null): Promise<MatchStatus>;
    /** D10.3: the spectator video path: the native helper (`castcade-video.exe`) or the 0.2.36 Electron path; used from the next match. */
    setVideoPath(path: 'native' | 'electron'): Promise<MatchStatus>;
    /** D10.5: the native video quality: the ceiling in kbps (saved in media.json) and the pin (1..6, null = auto; this run only). */
    setVideoRungs(rungs: { maxKbps?: number; pin?: number | null }): Promise<MatchStatus>;
    /** D2.6: show or hide the desktop match panel window (a separate window beside this one). */
    showPanel(): Promise<MatchStatus>;
    hidePanel(): Promise<MatchStatus>;
    /**
     * D7.6.2: the VR report: the layer's session report (runtime, headset, what VPX submits), the companion's settings,
     * counters and preview window, written beside companion.log; resolves with the two paths.
     */
    vrReport(): Promise<{ md: string; json: string }>;
    /** D7.6.1: the layer's calibration pattern in theater ('pattern'), or off (null). */
    setVrTest(test: 'pattern' | null): Promise<MatchStatus>;
    onStatus(cb: (s: MatchStatus) => void): () => void;
  };
  /**
   * A14 (2026-11-12): one step to a match. Host with a table (the match is hosted, the join link copied, VPX started on
   * the table), the join link and its chat line, and a `castcade://join/…` link that waits for the player's click.
   */
  launch: {
    status(): Promise<OneStepStatus>;
    /** The tables Castcade knows (imported), most recent first. */
    tables(): Promise<TableChoice[]>;
    /** Browse: the other `.vpx` files in the tables folder (never patched by Castcade). */
    browse(): Promise<TableChoice[]>;
    /** Host, copy the join link, start VPX on `tablePath` (a `path` from `tables()` or `browse()`; null: host only). A table already open is used. */
    host(opts: { tablePath: string | null; port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus>;
    /** Join the match of the link that waits (`status.pending`) and start its table here. */
    confirm(): Promise<OneStepStatus>;
    dismiss(): Promise<OneStepStatus>;
    copy(what: 'link' | 'message'): Promise<OneStepStatus>;
    /** The Match tab is showing (or not any more). */
    viewing(matchTab: boolean): Promise<void>;
    onStatus(cb: (s: OneStepStatus) => void): () => void;
  };
  tables: {
    defaults(): Promise<TablesDefaults>;
    /** Dry run over a folder (null = the default folder): classifies every `.vpx`, writes nothing. */
    plan(dir: string | null): Promise<TablesPlan>;
    /** Re-plans the folder and patches the `patch` / `repatch` items; installs the hook library. */
    apply(dir: string | null): Promise<TablesApplyResult>;
    /** Progress of a running apply: one call per table. */
    onProgress(cb: (p: TablesProgress) => void): () => void;
    /** Deletes every Castcade sidecar (and manifest) under the folder; foreign `.vbs` files stay. */
    removeAll(dir: string | null): Promise<TablesRemoveResult>;
    /** C11: patch the one table Status offers (`status.patchNow` / `status.lastClose.vpxPath`); others are refused. */
    patchNow(vpxPath: string): Promise<TablesPatchNowResult>;
  };
}
