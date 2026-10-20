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
  attestation?: Attestation | null;
}

interface PhysicsSetValues {
  gravity: number | null;
  contactFriction: number | null;
  elasticity: number | null;
  elasticityFalloff: number | null;
  scatterAngle: number | null;
  contactScatterAngle: number | null;
  minSlope: number | null;
  maxSlope: number | null;
}

interface NudgeSettings {
  strength: number | null;
  sensitivity: number | null;
  legacy: boolean | null;
  legacyStrength: number | null;
  analogGainX: number | null;
  analogGainY: number | null;
  filter: boolean | null;
}

interface IniAttestation {
  mainIni: string | null;
  tableIni: string | null;
  physicsSet: number | null;
  physicsSetName: string | null;
  physicsSetValues: PhysicsSetValues | null;
  physicsFlippersOverridden: boolean | null;
  flipperSetValues: Record<string, number> | null;
  stockPhysics: boolean | null;
  tableDifficulty: number | null;
  difficultyOverride: number | null;
  effectiveDifficulty: number | null;
  slope: { min: number; max: number; effective: number | null } | null;
  nudge: NudgeSettings;
  tableOptions: Record<string, number>;
  tableOverrides: Record<string, string>;
  playerOverrides: string[];
  notes: string[];
}

interface AdjustmentReading {
  group: string;
  label: string;
  value: number | null;
  shown: number | null;
  text: string | null;
  factory: number | null;
  isFactory: boolean | null;
}

interface AdjustmentsReport {
  rom: string;
  total: number;
  checked: AdjustmentReading[];
  nonFactory: string[];
  unjudged: number;
}

interface PeVersion {
  fileVersion: string | null;
  fileVersionText: string | null;
  productVersionText: string | null;
  description: string | null;
}

interface KnownBuild {
  id: string;
  label: string;
  kind: 'official';
}

type BuildFamily = 'official' | 'panasony' | 'nightly' | 'unknown';

interface BinaryAttestation {
  path: string;
  size: number;
  sha256: string;
  version: PeVersion | null;
  known: KnownBuild | null;
  family: BuildFamily;
}

interface BuildAttestation {
  vpx: BinaryAttestation | null;
  vpinmame: BinaryAttestation | null;
  notes: string[];
}

interface Attestation {
  measuredAt: string;
  ini: IniAttestation | null;
  build: BuildAttestation | null;
  adjustments: AdjustmentsReport | null;
  vpmCheat: boolean | null;
  iniChanged: boolean;
  notes: string[];
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
  difficulty: number | null;
  overridePhysicsSet: number | null;
  overridePhysicsFlippers: boolean | null;
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
  currentAttestation: Attestation | null;
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
