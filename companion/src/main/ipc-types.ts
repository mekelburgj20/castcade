/**
 * The IPC surface between main and renderer. The preload imports these types only (`import type`,
 * erased at build time: a sandboxed preload cannot load modules). `renderer/src/castcade.d.ts`
 * mirrors the same shapes by hand because the renderer is a separate tsconfig.
 */
import type { RedactedSettings, SettingsPatch } from './settings.js';
import type { WitnessStatus } from '../witness/types.js';

export type { RedactedSettings, SettingsPatch, WitnessStatus };

export const IPC = {
  witnessStatus: 'witness:status',
  witnessPair: 'witness:pair',
  witnessUnpair: 'witness:unpair',
  witnessSetPaused: 'witness:setPaused',
  witnessConfirmTable: 'witness:confirmTable',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appOpenExternal: 'app:openExternal',
  appVersions: 'app:versions',
  appLoginItemGet: 'app:loginItem:get',
  appLoginItemSet: 'app:loginItem:set',
  appLogPath: 'app:logPath',
  /** main → renderer push (webContents.send). */
  witnessStatusEvent: 'witness:status',
} as const;

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
  };
}
