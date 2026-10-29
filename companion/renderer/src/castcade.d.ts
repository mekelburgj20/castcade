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
  mode?: 'live' | 'basic';
  attempt?: { n: number; of: number; remaining: number } | null;
}

interface AttemptStatus {
  key: string;
  state: 'counted' | 'over_limit' | 'unlimited' | 'no_match' | 'queued' | 'rejected';
  n: number | null;
  of: number | null;
  remaining: number | null;
  late: boolean;
  game: string | null;
  text: string;
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
  accelEnabled: boolean | null;
  accelGainX: number | null;
  accelGainY: number | null;
  accelMaxX: number | null;
  accelMaxY: number | null;
  accelVelocityInput: boolean | null;
  tiltSensitivity: number | null;
  tiltSensitivityEffective: number;
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

interface EngineSample {
  t: number;
  reason: string | null;
  difficulty: number | null;
  slopeMin: number | null;
  slopeMax: number | null;
  physicsSet: number | null;
  gravity: number | null;
  friction: number | null;
  elasticity: number | null;
  elasticityFalloff: number | null;
  scatter: number | null;
  nudgeTime: number | null;
  nudge: { xmax: number | null; ymax: number | null; xgain: number | null; ygain: number | null; deadZone: number | null; tilt: number | null } | null;
}

interface Attestation {
  measuredAt: string;
  ini: IniAttestation | null;
  build: BuildAttestation | null;
  vr: { inVr: boolean; runtimeLoaded: boolean; compositorRunning: boolean; vrCapableBuild: boolean; sampledAt: string } | null;
  adjustments: AdjustmentsReport | null;
  vpmCheat: boolean | null;
  iniChanged: boolean;
  notes: string[];
  engine: {
    atStart: EngineSample | null;
    changes: EngineSample[];
  } | null;
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
  note?: string | null;
  captureMode: 'live' | 'basic' | null;
  attempt: AttemptStatus | null;
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
  vpxExe?: string | null;
}

interface SettingsPatch {
  arcaidBaseUrl?: string;
  nvramDir?: string | null;
  tablesDir?: string | null;
  deviceLabel?: string;
}

type TablesPlanAction = 'patch' | 'repatch' | 'already' | 'skip' | 'foreign' | 'unsupported' | 'unreadable';

interface TablesPlanItem {
  vpxPath: string;
  tableId: string;
  action: TablesPlanAction;
  cls: string | null;
  rom: string | null;
  reason: string;
}

interface TablesPlan {
  dir: string;
  items: TablesPlanItem[];
  counts: Record<TablesPlanAction, number>;
}

interface TablesApplyResult {
  dir: string;
  patched: string[];
  failed: { tableId: string; error: string }[];
  already: number;
  skipped: number;
  /** B12.1: of those, tables whose Castcade patch was removed (their machine's live score can't be read). */
  unpatched: number;
  libInstalled: 'installed' | 'updated' | 'unchanged';
  scriptsDir: string;
}

interface TablesProgress {
  done: number;
  total: number;
  tableId: string;
}

interface TablesRemoveResult {
  dir: string;
  removed: string[];
  keptForeign: string[];
}

interface TablesDefaults {
  tablesDir: string | null;
  scriptsDir: string | null;
  vpxExe: string | null;
  hookVersion: string;
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

/** D1.2 / D1.3 (mirrors media/stream-engine.ts EngineStatus). */
interface StreamStatus {
  state: 'idle' | 'waiting' | 'capturing' | 'slate';
  live: boolean;
  recording: boolean;
  wantsLive: boolean;
  wantsRecording: boolean;
  session: string | null;
  segment: string | null;
  table: string | null;
  picture: { width: number; height: number } | null;
  health: { frames: number; fps: number; speed: number } | null;
  restarts: number;
  /** VPX is not the foreground window, so the picture is covered (D1.9). */
  covered: boolean;
  lastError: string | null;
  since: string | null;
}

/** Mirrors media/stream-settings.ts StreamSettings + main/stream-host.ts StreamSettingsView. */
interface StreamSettings {
  preset: string;
  orientation: 'portrait' | 'landscape';
  shiftPercent: number;
  rotate: 0 | 90 | 180 | 270;
  service: 'twitch' | 'youtube' | 'custom';
  customIngest: string | null;
  recordingsDir: string | null;
  keepSessions: number;
  maxRecordings: number | null;
  gameVolume: number;
  audioLateMs: number;
}
interface StreamSettingsView extends StreamSettings {
  hasKey: boolean;
  defaultRecordingsDir: string;
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
  readonly stream: {
    status(): Promise<StreamStatus>;
    start(want: { record: boolean; live: boolean }): Promise<StreamStatus>;
    stop(): Promise<StreamStatus>;
    settings(): Promise<StreamSettingsView>;
    setSettings(patch: Partial<StreamSettings>): Promise<StreamSettingsView>;
    setKey(key: string | null): Promise<StreamSettingsView>;
    openRecordings(): Promise<void>;
    onStatus(cb: (s: StreamStatus) => void): () => void;
  };
  readonly tables: {
    defaults(): Promise<TablesDefaults>;
    plan(dir: string | null): Promise<TablesPlan>;
    apply(dir: string | null): Promise<TablesApplyResult>;
    onProgress(cb: (p: TablesProgress) => void): () => void;
    removeAll(dir: string | null): Promise<TablesRemoveResult>;
  };
  readonly app: {
    openExternal(url: string): Promise<boolean>;
    versions(): Promise<AppVersions>;
    loginItem: {
      get(): Promise<LoginItemState>;
      set(openAtLogin: boolean): Promise<LoginItemState>;
    };
    logPath(): Promise<string>;
    /** D1.1: the OBS overlay page URL, or null when it is not running. */
    overlayUrl(): Promise<string | null>;
    pickFolder(defaultPath: string | null): Promise<string | null>;
  };
}

interface Window {
  readonly castcade?: CastcadeBridge;
}
