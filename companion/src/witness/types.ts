/**
 * Public contract of the `witness` module (Arcaid Witness desktop producer, basic mode).
 *
 * The Electron shell depends only on this file and on `createWitness` from `./index.js`;
 * everything else in this folder is implementation. Keep this file additive: the shell and the
 * module are built by different agents against it.
 */
import type { Attestation } from './attestation-types.js';
import type { TableIdentity } from './identity-types.js';

export type { TableIdentity, VpsGameRef, VpsTableRef, MatchConfidence, VpxTableInfo, VpxTablePhysics } from './identity-types.js';
export type {
  Attestation,
  IniAttestation,
  PhysicsSetValues,
  NudgeSettings,
  AdjustmentReading,
  AdjustmentsReport,
  BuildAttestation,
  BinaryAttestation,
  PeVersion,
  KnownBuild,
  KnownBuildKind,
} from './attestation-types.js';

/** Persisted settings. The shell owns persistence; the module reads and patches through the store. */
export interface WitnessSettings {
  /** ArcAid origin without a trailing slash, e.g. `https://arcaid.app` or `http://localhost:3001`. */
  arcaidBaseUrl: string;
  /** Stable per-install device id (UUID v4, generated once by the shell). Sent as `device=`. */
  deviceId: string;
  /** Human label sent as `username=` at pairing; defaults to the machine name. */
  deviceLabel: string;
  /** Witness device token from `/api/witness/pair`; null until paired. The shell encrypts it at rest. */
  token: string | null;
  /** Root of the bundled `pinmame-nvram-maps` corpus (contains `index.json`, `maps/`). */
  mapsDir: string;
  /** VPinMAME nvram directory override; null = auto-detect from the registry. */
  nvramDir: string | null;
  /** Directory for the module's own files (offline queue, shadow state). */
  dataDir: string;
  /** Root of the bundled compact VPS index (`index.json`, `VERSION`), built by `scripts/fetch-vps.mjs`. */
  vpsDir: string;
  /** Extra folder to search for `<table>.vpx` when a table was opened from the editor; null = only `<exe dir>\tables`. */
  tablesDir: string | null;
}

export interface WitnessSettingsStore {
  get(): WitnessSettings;
  set(patch: Partial<WitnessSettings>): Promise<void>;
}

export type CaptureOutcome =
  | 'ingested' // ArcAid accepted the score
  | 'duplicate' // ArcAid already had it (or the player deleted it)
  | 'queued' // offline or 5xx; will retry
  | 'rejected' // ArcAid refused (401 bad token, 4xx)
  | 'skipped'; // nothing to post (no map, multi-player game, no game played, unknown table)

export interface LastCapture {
  table: string;
  rom: string | null;
  players: number;
  score: number | null;
  launchedAt: string; // ISO
  exitedAt: string; // ISO
  outcome: CaptureOutcome;
  detail?: string; // human-readable reason for skipped/rejected
  /** What the companion established about the table file (VPS ids, hash, save revision); null when unknown. */
  identity?: TableIdentity | null;
  /** The conditions the game was played under (settings, machine adjustments, builds); null when not measured. */
  attestation?: Attestation | null;
  /** `live`: one game, from the hook's journal (0.2.11); `basic`: the `.nv` read when the player closed. */
  mode?: 'live' | 'basic';
}

export interface WitnessStatus {
  paired: boolean;
  running: boolean;
  /** Exe path of the VPX build most recently seen running, or null. */
  vpxExe: string | null;
  /** Resolved nvram directory (override or auto-detected), or null if not found. */
  nvramDir: string | null;
  /** Corpus identity from the bundled maps (e.g. its git commit), or null. */
  mapsVersion: string | null;
  /** Table currently running (from `-Play "<path>.vpx"`), or null. */
  currentTable: string | null;
  /** Identity of the current table as far as it is resolved (file facts at launch, game by ROM at capture). */
  currentIdentity: TableIdentity | null;
  /** Settings and builds in force for the current table (adjustments and the cheat flag fill in at capture). */
  currentAttestation: Attestation | null;
  /** The compact VPS index's version (vps-db commit), or null when the index is missing. */
  vpsVersion: string | null;
  lastCapture: LastCapture | null;
  /** Posts waiting in the offline queue. */
  queued: number;
  lastHeartbeatAt: string | null;
  /** Last successful check-in ("no table open here right now"); sent only while VPX is not running. */
  lastCheckinAt: string | null;
  /** ArcAid's routing line from the last check-in, e.g. `Room / Tournament · CHECKED IN · READY`. */
  sendingTo: string | null;
  lastError: string | null;
  /** Informational, not an error: e.g. "VPX is open; no table known yet". */
  note?: string | null;
  /** How the open table's games are captured: `live` (hook journal, every game) or `basic` (`.nv` at close); null with no table. */
  captureMode: 'live' | 'basic' | null;
}

export interface WitnessEvents {
  status: (status: WitnessStatus) => void;
  /** Every VPX process; `table` is null until the command line or the editor title names one. */
  launch: (info: { table: string | null; exe: string; pid: number; at: string }) => void;
  exit: (info: { table: string | null; at: string; durationSec: number }) => void;
  capture: (capture: LastCapture) => void;
  error: (message: string) => void;
}

export interface Witness {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Redeem a pairing code minted at ArcAid Account Settings; stores the token through the settings store. */
  pair(code: string): Promise<void>;
  /** Forget the token locally (ArcAid-side revoke happens in Account Settings). */
  unpair(): Promise<void>;
  /**
   * The player's answer to "which VPS table is this file?" (or a correction): remembered for the
   * file path, applied to the current session and the last capture's display at once. `null` forgets.
   */
  confirmTable(filePath: string, vpsTableId: string | null): Promise<void>;
  status(): WitnessStatus;
  on<K extends keyof WitnessEvents>(event: K, listener: WitnessEvents[K]): () => void;
}
