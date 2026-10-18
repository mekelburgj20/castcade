/**
 * Public contract of the `witness` module (Arcaid Witness desktop producer, basic mode).
 *
 * The Electron shell depends only on this file and on `createWitness` from `./index.js`;
 * everything else in this folder is implementation. Keep this file additive: the shell and the
 * module are built by different agents against it.
 */

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
  lastCapture: LastCapture | null;
  /** Posts waiting in the offline queue. */
  queued: number;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  /** Informational, not an error: e.g. "VPX is open; no table known yet". */
  note?: string | null;
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
  status(): WitnessStatus;
  on<K extends keyof WitnessEvents>(event: K, listener: WitnessEvents[K]): () => void;
}
