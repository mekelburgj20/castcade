/**
 * Shape of the preload's contextBridge (`companion/src/preload/index.cts`). Hand-mirrored from
 * `companion/src/main/ipc-types.ts` and `companion/src/witness/types.ts` because the renderer is a
 * separate tsconfig; keep the three in step.
 */

type CaptureOutcome = 'ingested' | 'duplicate' | 'queued' | 'rejected' | 'skipped';

interface LastCapture {
  table: string;
  rom: string | null;
  players: number;
  score: number | null;
  launchedAt: string;
  exitedAt: string;
  outcome: CaptureOutcome;
  detail?: string;
  identity?: TableIdentity | null;
}

type MatchConfidence = 'exact' | 'likely' | 'ambiguous' | 'none';

interface VpxTableInfo {
  tableName: string | null;
  authorName: string | null;
  tableVersion: string | null;
  releaseDate: string | null;
  saveDate: string | null;
  saveRev: number | null;
  manufacturer: string | null;
  year: number | null;
  raw: Record<string, string>;
}

interface VpxTablePhysics {
  gravity: number | null;
  friction: number | null;
  elasticity: number | null;
  elasticityFalloff: number | null;
  playfieldScatter: number | null;
  defaultScatter: number | null;
  nudgeTime: number | null;
  slopeMin: number | null;
  slopeMax: number | null;
}

interface TableIdentity {
  filePath: string | null;
  vpsGame: { id: string; name: string; manufacturer: string | null; year: number | null } | null;
  gameConfidence: MatchConfidence;
  gameSource: 'rom' | 'tableinfo' | 'filename' | 'none';
  vpsTable: { id: string; label: string } | null;
  tableConfidence: MatchConfidence;
  confirmed: boolean;
  tableChoices: Array<{ id: string; label: string }>;
  sha256: string | null;
  saveRev: number | null;
  tableInfo: VpxTableInfo | null;
  physics: VpxTablePhysics | null;
  notes: string[];
}

interface WitnessStatus {
  paired: boolean;
  running: boolean;
  vpxExe: string | null;
  nvramDir: string | null;
  mapsVersion: string | null;
  currentTable: string | null;
  currentIdentity: TableIdentity | null;
  vpsVersion: string | null;
  lastCapture: LastCapture | null;
  queued: number;
  lastHeartbeatAt: string | null;
  lastCheckinAt: string | null;
  sendingTo: string | null;
  lastError: string | null;
}

interface RedactedSettings {
  arcaidBaseUrl: string;
  deviceId: string;
  deviceLabel: string;
  mapsDir: string;
  nvramDir: string | null;
  dataDir: string;
  vpsDir: string;
  tablesDir: string | null;
  hasToken: boolean;
}

interface SettingsPatch {
  arcaidBaseUrl?: string;
  nvramDir?: string | null;
  tablesDir?: string | null;
  deviceLabel?: string;
}

interface AppVersions {
  app: string;
  protocol: number;
  electron: string;
  chrome: string;
  node: string;
  packaged: boolean;
}

interface LoginItemState {
  supported: boolean;
  openAtLogin: boolean;
}

interface CastcadeBridge {
  readonly appVersion: string;
  readonly protocolVersion: number;
  readonly platform: string;
  readonly witness: {
    status(): Promise<WitnessStatus>;
    pair(code: string): Promise<WitnessStatus>;
    unpair(): Promise<WitnessStatus>;
    setPaused(paused: boolean): Promise<WitnessStatus>;
    confirmTable(filePath: string, vpsTableId: string | null): Promise<WitnessStatus>;
    onStatus(cb: (status: WitnessStatus) => void): () => void;
  };
  readonly settings: {
    get(): Promise<RedactedSettings>;
    set(patch: SettingsPatch): Promise<RedactedSettings>;
  };
  readonly app: {
    openExternal(url: string): Promise<boolean>;
    versions(): Promise<AppVersions>;
    loginItem: {
      get(): Promise<LoginItemState>;
      set(openAtLogin: boolean): Promise<LoginItemState>;
    };
    logPath(): Promise<string>;
  };
}

interface Window {
  readonly castcade?: CastcadeBridge;
}
