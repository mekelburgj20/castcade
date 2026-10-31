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

export type { EngineStatus, MatchSettings, MatchStatus, PreviewStatus, RedactedSettings, SettingsPatch, StreamSettings, StreamSettingsView, WitnessStatus };

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
  matchStatus: 'match:status',
  matchHost: 'match:host',
  matchJoin: 'match:join',
  matchStart: 'match:start',
  matchLeave: 'match:leave',
  matchSettingsSet: 'match:settings:set',
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
    /** Host only: freeze the roster (two or more players) and issue the first grant. */
    start(): Promise<MatchStatus>;
    leave(): Promise<MatchStatus>;
    setSettings(patch: Partial<MatchSettings>): Promise<MatchStatus>;
    onStatus(cb: (s: MatchStatus) => void): () => void;
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
  };
}
