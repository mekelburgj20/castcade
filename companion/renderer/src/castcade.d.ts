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
  /** B21: the start used no attempt because Start attempts was not pressed for this table. */
  needsStart: boolean;
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
  vr: {
    inVr: boolean;
    /** B22 (mirrors witness/vr-detect.ts VrRuntime); absent in samples from before it. */
    runtime?: 'steamvr' | 'virtual-desktop' | 'oculus' | 'openxr-other' | null;
    runtimeLoaded: boolean;
    compositorRunning: boolean;
    vrCapableBuild: boolean;
    activeOpenXrRuntime?: string | null;
    sampledAt: string;
  } | null;
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
  fingerprint: string | null;
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
  /** B24: which VPS index is loaded (the daily refresh or the installer's), its size, and when it was built / checked. */
  vpsIndex: {
    source: 'bundled' | 'refreshed' | 'none';
    version: string | null;
    games: number;
    tables: number;
    builtAt: string | null;
    checkedAt: string | null;
  } | null;
  lastCapture: LastCapture | null;
  queued: number;
  lastHeartbeatAt: string | null;
  lastCheckinAt: string | null;
  sendingTo: string | null;
  lastError: string | null;
  note?: string | null;
  captureMode: 'live' | 'basic' | null;
  attempt: AttemptStatus | null;
  /** B21: the last Start attempts press and ArcAid's answer, as one line. */
  attemptStart: { at: string; status: string; text: string } | null;
  /** C11: the open table is in basic mode and the import would patch it (Patch now). */
  patchNow?: { table: string; vpxPath: string } | null;
  /** C11: why the last closed table's score was read only at close; `vpxPath` set when Patch now fixes it. */
  lastClose?: { table: string; at: string; rung: string; kind: string; text: string; vpxPath: string | null } | null;
}

interface TablesPatchNowResult {
  ok: boolean;
  text: string;
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
  overlay: boolean;
}
interface StreamSettingsView extends StreamSettings {
  hasKey: boolean;
  defaultRecordingsDir: string;
}

/** D1.5 (mirrors main/stream-host.ts PreviewStatus). */
interface PreviewStatus {
  previewing: boolean;
  picture: { width: number; height: number } | null;
  warning: string | null;
  error: string | null;
}

/** A6 (mirrors media/match-media-types.ts PanelState, MediaStatus, VrOverlayStatus). */
interface PanelState {
  playerUp: string | null;
  myTurn: boolean;
  ball: number | null;
  ballsPerGame: number;
  players: Array<{ id: string; name: string; score: number | null; ballsDone: number; isUp: boolean; flags: Array<'table_mismatch' | 'build_mismatch' | 'disconnected' | 'loading'> }>;
  phase: 'idle' | 'playing' | 'paused' | 'over';
  result: Array<{ id: string; name: string; score: number; place: number }> | null;
  /** A10: the game of the series, the series standings after the last result, and whether the series is over. */
  game?: number;
  series?: Array<{ id: string; name: string; wins: number; games: number; total: number; place: number }> | null;
  seriesOver?: boolean;
  /** A11: whole seconds until the match starts from the host's table, or null. */
  countdown?: number | null;
  message: string | null;
  mic: 'open' | 'muted' | 'unavailable';
}
interface MediaStatus {
  attached: boolean;
  sending: boolean;
  peers: Record<string, { ice: string; receivingVideo: boolean; receivingAudio: boolean; signaling?: string; reopens?: number; receivingTable?: boolean }>;
  mic: 'open' | 'muted' | 'unavailable';
  captureSource: string | null;
  /** D7.4: the size of the region sent while the capture is live. */
  captureCrop?: { width: number; height: number } | null;
  /** D2.6: the desktop panel window, when there is one. */
  panelWindow?: { visible: boolean; side: 'right' | 'left' | 'below' | 'edge' } | null;
  /** D7.4.3: what this rig tells the others its picture is, while the capture is live. */
  captureStereo?: 'mono' | 'sbs' | null;
  /** D7.4.10: the preview window covers its display or hangs off it, while the capture is live. */
  captureWarning?: string | null;
  /** D2.8: table sound: the helper, why not, and whether this rig's VPX is muted / being sent now. */
  tableAudio?: { helper: 'ready' | 'unavailable'; reason: string | null; muted: boolean; tapping: boolean };
  /** D10.3: the native spectator video (castcade-video.exe) while this match runs it (media/match-media-types.ts NativeVideoStatus). */
  nativeVideo?: NativeVideoStatus;
  lastError: string | null;
}
interface NativeVideoStats {
  fps: number;
  kbps: number;
  width: number;
  height: number;
  rttMs?: number | null;
  lossPct?: number | null;
  bweKbps?: number | null;
  qualityLimitation?: string | null;
  /** D10.5 (send): the rung applied and the controller's state (`auto`, `probe`, `pin`, `trouble:<kinds>`). */
  rung?: number | null;
  ctrl?: string | null;
}
/** D10.5: one rung of the ladder for this rig's source. */
interface NativeVideoRung {
  rung: number;
  width: number;
  height: number;
  fps: number;
  kbps: number;
}
interface NativeVideoStatus {
  helper: 'ready' | 'starting' | 'stopped' | 'unavailable';
  reason: string | null;
  encoder: string | null;
  decoder: string | null;
  sending: boolean;
  source: { kind: 'ring' | 'bench' | 'wgc' | 'none'; width: number; height: number; fps: number; state: 'ok' | 'missing' | 'dead' | null; fpsIn: number | null; window?: string | null };
  sink: 'ring' | 'window' | 'none';
  /** D10.5: the ladder for this rig's source, the ceiling told to the helper (kbps) and the pin (null = auto). */
  ladder: NativeVideoRung[];
  maxKbps: number;
  pin: number | null;
  /** D10.3.6: the Electron video serves the rest of this match (a peer failed with the restarts exhausted, or the helper is unavailable). */
  fallback: boolean;
  /** D10.3.8: in theater on the layer's ring, where the picture comes from: the native frames, or the Electron frames after 5 s without any. Null otherwise. */
  theaterPath?: 'ring' | 'pipe' | null;
  peers: Record<string, { ice: string; pair: string | null; send: NativeVideoStats | null; recv: NativeVideoStats | null; rung: (NativeVideoRung & { reason: string }) | null; failed: boolean }>;
}
interface VrOverlayStatus {
  state: 'stopped' | 'starting' | 'showing' | 'hidden' | 'unavailable';
  reason: string | null;
  /** D7.3.3: the OpenXR layer only; the VPX running started before the layer was registered (restart VPX). */
  vpxBeforeLayer?: true;
}

/** D7.6.3 (mirrors media/frame-clip.ts SaveFramesResult): the folder written (null: nothing), frames per side, why a side is empty. */
interface SaveFramesResult {
  dir: string | null;
  sender: number;
  receiver: number;
  notes: string[];
  line: string;
}

/** D7.6 (mirrors media/frame-clip.ts ClipSummary): one saved clip under <logs>/frames. */
interface ClipSummary {
  name: string;
  dir: string;
  sender: { count: number; fps: number | null; eye: { width: number; height: number } | null } | null;
  receiver: { count: number; fps: number | null; size: { width: number; height: number } | null; stereo: 'mono' | 'sbs' | null } | null;
}

/** D7.6 (mirrors media/bench.ts BenchStatus): the VR test bench while it runs. */
interface BenchStatus {
  state: 'starting' | 'running';
  source: 'clip' | 'live';
  path: 'direct' | 'loop';
  clip: string | null;
  headset: boolean;
  view: 'theater' | 'direct';
  readout: string;
  hint: string;
}

/** A6 (mirrors main/match-setup.ts MatchSettings). */
interface MatchSettings {
  port: number;
  ballsPerGame: 3 | 5;
  displayName: string | null;
  cueVolume: number;
  /** D7.4: the headset on this player's own ball. */
  theaterDuringMyTurn: 'hidden' | 'panel';
  /** D7.4: the headset while another player is up. */
  spectate: 'theater' | 'panel';
  /** D7.4.3: what this rig's VR preview sends: `auto` (VPX's setting), one eye, both eyes. */
  previewStereo: 'auto' | 'mono' | 'sbs';
  /** D2.8: table sound: mute mine while others play, send mine, hear the other table. */
  tableMuteMine: boolean;
  tableSendMine: boolean;
  tableHearOthers: boolean;
  /** D7.4.9: the theater window's size against life size (0.25–4). */
  theaterScale: number;
  /** D7.5: a VR sender's picture: the OpenXR layer's copy of the eye views (the default since D8.1), or the screen capture of the preview window. */
  cameraSource: 'screen' | 'layer';
  /** D8.1 (ADR 0009): what the layer camera sends: one eye as a flat picture (the default), or both side by side (the 0.2.35 stereo window). */
  cameraEyes: 'one' | 'both';
  /** D8.1: the settings' version (migrations at load; main owns it). */
  settingsVersion: number;
  /** D7.5.9: what the layer camera sends per eye: the whole render (the picture fills the headset), or the 1:2 centre crop of 0.2.34. */
  cameraView: 'whole' | 'window';
  /** D7.5.10: the stereo window's depth in metres (0.3–100), null = infinity (as rendered). */
  windowDepthM: number | null;
  /** D7.5.10: a vertical offset per eye in degrees (±10), left then right. */
  eyeOffsetDeg: [number, number];
  /** D7.5.11: the window's soft edge, 0–0.25 of one eye's half width. */
  softEdge: number;
  /** A12 (2026-11-05): the host's table before the match: free play until the lobby is complete, or locked until then. */
  preMatchPlay: 'free' | 'locked';
  /** D2.10: the other players' voices, 0–300 % (over 100 is a boost). */
  voiceVolume: number;
  /** D2.10: the up player's table sound as this rig plays it, 0–100 %. */
  othersTableVolume: number;
  /** D2.10: this rig's own VPX volume while this player is up, 10–100 % (100 = untouched). */
  myTableWhileUp: number;
}

/** A6 (mirrors main/match-host.ts MatchStatus). */
interface MatchStatus {
  role: 'none' | 'host' | 'client';
  phase: 'none' | 'connecting' | 'lobby' | 'playing' | 'paused' | 'over';
  endpoint: string | null;
  invite: string | null;
  /** D10.8: the address invite beside a code invite (LAN, a forwarded port, a player who is not paired). */
  directInvite: string | null;
  ipSource: 'public' | 'lan' | null;
  /** D10.8: the path of the match control and its one line ("Through ArcAid" / "Direct to <host>"). */
  via: 'relay' | 'direct' | null;
  path: string | null;
  relayNote: string | null;
  portMapping: { state: 'trying' | 'opened' | 'failed'; line: string } | null;
  port: number | null;
  code: string | null;
  localId: string | null;
  hostId: string | null;
  participants: Array<{
    id: string;
    name: string;
    rig: 'pc' | 'vr_headset' | 'real_cabinet';
    tableMatch: boolean | null;
    tableNote: string | null;
    buildMatch: boolean | null;
    /** A13: whether this player's table can report ball ends; null = unknown. */
    ballEnds: boolean | null;
  }>;
  /** A13: in the lobby, one line per player whose table cannot report ball ends; not empty = Start match asks to confirm. */
  startWarnings: string[];
  /** A13: for the host while a turn is held: whose ball Pass the turn would end, and at what score. */
  pass: { name: string; ball: number; score: number } | null;
  /** A8: a host transfer under way (names), else null. */
  transfer: { proposer: string; newHost: string | null; reason: 'host_left' | 'host_requested' } | null;
  /** A10: the game being played or just played, whether the series is over, and why Next game cannot start (null: it can). */
  series: { game: number; over: boolean; nextGameBlocker: string | null } | null;
  panel: PanelState | null;
  media: MediaStatus | null;
  /** D7.4.3: one line for a VR player about the picture sent, or null. */
  previewAdvice: string | null;
  vrOverlay: VrOverlayStatus | null;
  /** D7.6: the OpenXR layer's pipe for the VR test bench (connected, protocol, the calibration pattern); null without a layer. */
  vrBench: { connected: boolean; protocol: number; pattern: boolean } | null;
  rig: 'vr_headset' | 'pc';
  rigReason: string;
  /** B22: the VR runtime behind `rig: 'vr_headset'`. D7.3: `steamvr` → the SteamVR overlay, any other → the OpenXR layer. */
  vrRuntime: 'steamvr' | 'virtual-desktop' | 'oculus' | 'openxr-other' | null;
  microphones: Array<{ deviceId: string; label: string }>;
  micDeviceId: string | null;
  muted: boolean;
  /** D2.9: the TURN relay saved in media.json (the credential only as "set"); null = none. */
  turn: { url: string; username: string; credentialSet: boolean } | null;
  /** D10.3: which path carries the spectator video (media.json): the native helper or the 0.2.36 Electron path. */
  videoPath: 'native' | 'electron';
  /** D10.5: the native video ladder's ceiling (media.json, kbps) and manual pin (1..6, null = auto; this run only). */
  videoMaxKbps: number;
  videoPin: number | null;
  locked: boolean;
  settings: MatchSettings;
  defaultName: string;
  lastError: string | null;
  /** D7.6: the VR test bench while it runs, else null. */
  bench: BenchStatus | null;
  /** A15: a match this PC was in when Castcade last closed and can go back to; `auto`: it is rejoined without asking. */
  resume: { code: string; role: 'host' | 'client'; names: string[]; auto: boolean } | null;
}

/** A14 (2026-11-12): mirrors `OneStepStatus` in main/one-step.ts. */
interface OneStepStatus {
  /** While hosting: the join link (`castcade://join/…`) and the line for a chat. */
  link: string | null;
  message: string | null;
  copied: boolean;
  /** A link from outside the app that waits for the player's click. */
  pending: { code: string; address: string | null } | null;
  launch: { state: 'idle' | 'waiting_host' | 'starting' | 'running' | 'needed' | 'failed'; table: string | null; detail: string | null };
  notice: string | null;
  attention: number;
}

/** A14: a table of the picker (`path` is handed back to `launch.host`). */
interface TableChoice {
  path: string;
  name: string;
  rom: string | null;
  lastPlayedAt: string | null;
  /** False: a file from Browse that Castcade never patched. */
  imported: boolean;
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
    startAttempts(): Promise<WitnessStatus>;
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
    readonly preview: {
      start(): Promise<PreviewStatus>;
      stop(): Promise<PreviewStatus>;
      status(): Promise<PreviewStatus>;
      onStatus(cb: (s: PreviewStatus) => void): () => void;
    };
  };
  readonly match: {
    status(): Promise<MatchStatus>;
    host(opts: { port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus>;
    join(invite: string, displayName: string): Promise<MatchStatus>;
    /** Host only: Start match in the lobby; A10: Next game between games. A13: `anyway` confirms a start with `startWarnings`. */
    start(opts?: { anyway?: boolean }): Promise<MatchStatus>;
    /** A13: host only: end the turn holder's ball at its last known score and grant the next turn. */
    passTurn(): Promise<MatchStatus>;
    /** A8: host only: end a pause nobody resumed. */
    resume(): Promise<MatchStatus>;
    /** D7.6.3: save the next 2 s of layer-camera and theater frames to `<logs>/frames/<date>/`. */
    saveFrames(): Promise<SaveFramesResult>;
    /**
     * D7.6: the VR test bench: start (refused during a match), stop, theater or VPX's own view, the saved clips.
     * `bitrate` (D7.6.9): the loop's cap in bits per second (1 to 100 Mbps), null or absent for the match's rule.
     */
    benchStart(req: { source: 'clip' | 'live'; path: 'direct' | 'loop'; clip: { name: string; side: 'sender' | 'receiver' } | null; bitrate?: number | null }): Promise<MatchStatus>;
    benchStop(): Promise<MatchStatus>;
    benchView(view: 'theater' | 'direct'): Promise<MatchStatus>;
    benchClips(): Promise<ClipSummary[]>;
    /** A10: the host's leave between games is End match (everyone is told). */
    leave(): Promise<MatchStatus>;
    /** A15: go back into the match of `MatchStatus.resume`; `forgetResume` drops it. */
    rejoin(): Promise<MatchStatus>;
    forgetResume(): Promise<MatchStatus>;
    setSettings(patch: Partial<MatchSettings>): Promise<MatchStatus>;
    setMicrophone(deviceId: string | null): Promise<MatchStatus>;
    setMuted(muted: boolean): Promise<MatchStatus>;
    /** D2.9: the TURN relay; null (or an empty url) clears it, a null credential keeps the saved one. */
    setTurn(turn: { url: string; username: string; credential: string | null } | null): Promise<MatchStatus>;
    /** D10.3: the spectator video path (native helper / Electron), used from the next match. */
    setVideoPath(path: 'native' | 'electron'): Promise<MatchStatus>;
    /** D10.5: the native video quality: the ceiling (kbps, saved) and the pin (1..6 or null for auto; this run only). */
    setVideoRungs(rungs: { maxKbps?: number; pin?: number | null }): Promise<MatchStatus>;
    /** D2.6: the desktop match panel window (no-op in VR). */
    showPanel(): Promise<MatchStatus>;
    hidePanel(): Promise<MatchStatus>;
    /** D7.6.2: write the VR report beside companion.log; the two paths. */
    vrReport(): Promise<{ md: string; json: string }>;
    /** D7.6.1: the layer's calibration pattern in theater ('pattern'), or off (null). */
    setVrTest(test: 'pattern' | null): Promise<MatchStatus>;
    onStatus(cb: (s: MatchStatus) => void): () => void;
  };
  /** A14: one step to a match (main/one-step.ts). */
  readonly launch: {
    status(): Promise<OneStepStatus>;
    tables(): Promise<TableChoice[]>;
    browse(): Promise<TableChoice[]>;
    host(opts: { tablePath: string | null; port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus>;
    confirm(): Promise<OneStepStatus>;
    dismiss(): Promise<OneStepStatus>;
    copy(what: 'link' | 'message'): Promise<OneStepStatus>;
    viewing(matchTab: boolean): Promise<void>;
    onStatus(cb: (s: OneStepStatus) => void): () => void;
  };
  readonly tables: {
    defaults(): Promise<TablesDefaults>;
    plan(dir: string | null): Promise<TablesPlan>;
    apply(dir: string | null): Promise<TablesApplyResult>;
    onProgress(cb: (p: TablesProgress) => void): () => void;
    removeAll(dir: string | null): Promise<TablesRemoveResult>;
    patchNow(vpxPath: string): Promise<TablesPatchNowResult>;
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
    clipboardText(): Promise<string>;
  };
}

interface Window {
  readonly castcade?: CastcadeBridge;
}
