/**
 * A6 + C3 in the shell (docs/design/alpha-match.md §1–§3, 2026-10-30): one match at a time, hosted or joined over
 * `WsPeerTransport`, invite by text (no ArcAid lobby yet, F6). Owns the match keys (`<userData>/match-keys.json`),
 * the match settings (`<userData>/match.json`), the turn lock file the hook reads, the audio cue (a hidden window
 * that synthesises three cues with WebAudio, like `stream-host.ts`'s audio page) and the `MatchController`, which it
 * feeds with the witness's detector events. `media` (D2), `vrOverlay` (D7, SteamVR) and `vrLayer` (D7.3, OpenXR
 * runtimes) are optional: the app runs without them, and the lead wires the real ones. The panel goes up as soon as a player hosts or joins (coordinator
 * 2026-10-30), so the headset overlay can be checked before the match: the media layer is attached then with no
 * peers, and MATCH_READY adds them.
 *
 * A8 (2026-10-31): hosting opens the listener LAST, once the panel is up and the public-IP lookup has answered (or
 * failed), so the first client to connect meets a host that can show it and an invite that exists; the invite is
 * published only once the listener is up. A listener that cannot open tears the half-built match down again.
 *
 * D2.8 (2026-11-01): table sound. `tableAudio` (the helper, `media/audio-helper.ts`) mutes this rig's VPX while another
 * player is up and taps its sound while this rig is up; the panel page sends the tap as the table track and plays the
 * up player's. `table-audio-policy.ts` decides from the panel state and the three settings, at every status change
 * (`syncTableAudio`, beside `syncVrMode`); no match, the lobby and the result mute and tap nothing.
 *
 * A10 + A11 (2026-11-02): a match is a series, started and continued from the host's table (the controller follows
 * its `game_start`). The Match tab's buttons stay on the same IPC channels: `start()` is Start match in the lobby and
 * Next game between games; the host's `leave()` between games is End match (MATCH_END first, then the teardown). A
 * client whose series is over (MATCH_END, or the host gone between games) keeps the final standings up for
 * `SERIES_OVER_LINGER_MS` and then tears down by itself, so the headset does not keep a dead panel.
 *
 * D2.10 (2026-11-05): voice over the game. Three volume settings: the others' voices and the up player's table go to
 * the panel page (`media.setVolume`, live), my own table while I am up goes to the helper (`level`, through
 * `syncTableAudio`). While a match is on, `Control+Alt+Up` / `Down` step the voice and `Control+Alt+Left` / `Right`
 * my table (`VOLUME_SHORTCUTS`, global shortcuts registered at `openPanel`, released at `teardown` and on quit); a press
 * saves the setting, pushes it live, ticks the cue and shows the new level on the panel for a moment.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import type { GameFingerprint, ParticipantInfo, PayloadOf } from '@castcade/protocol';
import { ClientMatch } from '../match/client.js';
import { MatchController, mismatchWords, vrViewMode, type ControllerStatus, type CueKind } from '../match/controller.js';
import { HostMatch } from '../match/host.js';
import { WsPeerTransport } from '../match/transport-ws.js';
import type { MatchMedia, MediaSignalling, MediaStatus, PanelState, PanelVolume, VrOverlay, VrOverlayStatus, VrViewMode } from '../media/match-media-types.js';
import type { MediaSettingsStore, TurnServer } from '../media/media-settings.js';
import type { MicDevice } from '../media/panel-page.js';
import { previewAdvice } from '../media/preview-stereo.js';
import type { RtcHost } from '../media/rtc-host.js';
import { clipFolderName, listClips, loadClip, type ClipSummary, type SaveFramesResult } from '../media/frame-clip.js';
import { benchHint, benchRequestFrom, benchStep, liveRefusal, type BenchState, type BenchStatus, type BenchView } from '../media/bench.js';
import { tuneWords } from '../media/vr-layer.js';
import type { TableAudioHelper } from '../media/audio-helper.js';
import { tableAudioPid, tableAudioPlan } from '../media/table-audio-policy.js';
import { RECIPE_VERSION } from '../patcher/render.js';
import type { Logger } from './log.js';
import { describeError } from './log.js';
import {
  cleanName,
  cleanPort,
  decideRig,
  formatInvite,
  gameFingerprintFrom,
  isIpv4,
  isTableOpen,
  lockPathFrom,
  newMatchCode,
  newMatchIdentity,
  parseInvite,
  parseMatchIdentity,
  patchMatchSettings,
  loadMatchSettings,
  pickLanAddress,
  rigFrom,
  rigFromStatus,
  serializeMatchIdentity,
  writeMatchSettings,
  ZERO_SHA256,
  type MatchIdentity,
  type MatchSettings,
  type Rig,
  type RigDecision,
} from './match-setup.js';
import type { WitnessStatus } from '../witness/types.js';
import type { VrRuntime } from '../witness/vr-detect.js';
import type { WitnessHost } from './witness-host.js';

export type MatchPhase = 'none' | 'connecting' | 'lobby' | 'playing' | 'paused' | 'over';

export interface MatchStatus {
  role: 'none' | 'host' | 'client';
  phase: MatchPhase;
  /** This companion's listener (host), e.g. `ws://0.0.0.0:27401`. */
  endpoint: string | null;
  invite: string | null;
  /** Where the invite's address came from: `public` (api.ipify.org) or `lan` (replace it with the public one). */
  ipSource: 'public' | 'lan' | null;
  port: number | null;
  code: string | null;
  localId: string | null;
  hostId: string | null;
  /**
   * `tableNote` (D2.5, 2026-10-31): how the player's table differs from the host's (`mismatchWords`), null when it does
   * not; `buildMatch`: false when their VPX build differs (shown muted; the table may still be the same).
   */
  participants: Array<{ id: string; name: string; rig: ParticipantInfo['rig']; tableMatch: boolean | null; tableNote: string | null; buildMatch: boolean | null }>;
  /** A8 (2026-10-31): a host transfer under way (proposed, not committed yet), with names; the engine acks it by itself. */
  transfer: { proposer: string; newHost: string | null; reason: 'host_left' | 'host_requested' } | null;
  /**
   * A10 (2026-11-02): the series: the game being played or just played, whether it is over for good, and, for the host
   * between games, why Next game cannot start now (null: it can). Null with no match.
   */
  series: ControllerStatus['series'] | null;
  panel: PanelState | null;
  media: MediaStatus | null;
  /**
   * D7.4.3 (2026-11-01): one line for a VR player about the picture sent (`preview-stereo.ts` previewAdvice): both eyes
   * in a 16:9 window, one eye only, or a setting Castcade could not read. Null when there is nothing to say.
   */
  previewAdvice: string | null;
  vrOverlay: VrOverlayStatus | null;
  /**
   * D7.6 (2026-11-03): the VR test bench: whether the OpenXR layer's pipe is connected, its protocol (the pattern needs
   * 3) and whether the calibration pattern is asked (D7.6.1). Null when this build has no layer.
   */
  vrBench: { connected: boolean; protocol: number; pattern: boolean } | null;
  /**
   * A6 (2026-10-31): where this rig's panel goes, decided at host / join (and switched to the headset when the witness
   * later reads VR), with the evidence. With no match, the witness's last sample. The Match tab shows both.
   */
  rig: Rig;
  rigReason: string;
  /**
   * B22 (2026-10-31): the VR runtime behind `rig: 'vr_headset'`, else null. D7.3: `steamvr` puts the panel in the
   * headset through the OpenVR overlay helper, any other runtime through the Castcade OpenXR layer (`vrOverlay` is then
   * the layer's status).
   */
  vrRuntime: VrRuntime | null;
  /**
   * The microphones (the panel page lists them during a match; before one, `refreshMicrophones` does, B22), the saved
   * choice and the mute.
   */
  microphones: MicDevice[];
  /** Null: the Windows default device. */
  micDeviceId: string | null;
  muted: boolean;
  /**
   * D2.9 (2026-11-02): the player's own TURN relay from media.json (url and username; the credential only as "set"),
   * used from the next match on. Null: none (STUN only).
   */
  turn: { url: string; username: string; credentialSet: boolean } | null;
  locked: boolean;
  settings: MatchSettings;
  /** The name the Host / Join cards prefill: the setting, else the pairing label. */
  defaultName: string;
  lastError: string | null;
  /** D7.6 (2026-11-03): the VR test bench while it runs (media/bench.ts), else null. */
  bench: BenchStatus | null;
}

export interface MatchHost {
  host(opts: { port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus>;
  join(invite: string, displayName: string): Promise<MatchStatus>;
  /** Host only: Start match in the lobby; A10: Next game between games (the same as a game started on the host's table). */
  start(): Promise<MatchStatus>;
  /** A8 (2026-10-31): host only: end a pause nobody resumed (a dropped player that is not coming back reconnects never). */
  resume(): Promise<MatchStatus>;
  /** Leave the match; A10: the host's leave between games is End match (MATCH_END to everyone first). */
  leave(): Promise<MatchStatus>;
  setSettings(patch: Partial<MatchSettings>): MatchStatus;
  /** Null: the Windows default. Saved in media.json, and switched live while a match runs. */
  setMicrophone(deviceId: string | null): MatchStatus;
  setMuted(muted: boolean): MatchStatus;
  /**
   * D2.9 (2026-11-02): the TURN relay (saved in media.json, used from the next match on). Null or an empty url clears
   * it; a null credential keeps the saved one. Throws on a url that is not `turn:` / `turns:`.
   */
  setTurn(turn: { url: string; username: string; credential: string | null } | null): MatchStatus;
  /** D2.6 (2026-11-01): the Match tab's Show panel / Hide panel for the desktop panel window; a no-op without one. */
  showPanel(): MatchStatus;
  hidePanel(): MatchStatus;
  /**
   * D7.6.1 (2026-11-03): the Match tab's "Show calibration pattern": the OpenXR layer shows its stereo test grid in
   * theater instead of any picture (null stops it). A no-op without the layer; the tab enables it only while
   * `vrBench` says a protocol-3 layer is connected.
   */
  setVrTest(test: 'pattern' | null): MatchStatus;
  /** B22 (2026-10-31): the Match tab opened: list the microphones if no match lists them; a status follows. Never throws. */
  refreshMicrophones(): void;
  status(): MatchStatus;
  onStatus(cb: (s: MatchStatus) => void): () => void;
  /**
   * D7.6.3 (2026-11-03): the Match tab's Save 2 s of frames: the layer camera's frames and the theater frames handed to
   * the layer, into `<logs>/frames/<yyyy-mm-dd-hhmmss>/` (media/frame-clip.ts). Throws without the media layer.
   */
  saveFrames(): Promise<SaveFramesResult>;
  /**
   * D7.6 (2026-11-03): the VR test bench: theater alone in the headset, no second player (media/bench.ts). Refused
   * while a match is on; a match hosted or joined stops it. `req` comes from the renderer and is checked here.
   */
  startBench(req: unknown): Promise<MatchStatus>;
  /** D7.6: Stop: VPX's own view back (theater off), the layer and the panel detached. */
  stopBench(): Promise<MatchStatus>;
  /** D7.6: while it runs, theater (the bench picture) or VPX's own view, to compare. */
  setBenchView(view: BenchView): MatchStatus;
  /** D7.6: the saved clips under the frames folder, newest first (D7.6.3 makes them). */
  benchClips(): ClipSummary[];
  /** On quit: leave any match and close the cue window. */
  stop(): Promise<void>;
}

export interface MatchHostOptions {
  file: string;
  keysFile: string;
  witness: WitnessHost;
  /** The pairing facts: the device id is the player id while paired (§3); the label is the default name. */
  device: () => { deviceId: string; deviceLabel: string };
  /** `RtcHost` (D2) in the app; the microphone picker and `setVr` are optional so tests can pass a bare `MatchMedia`. */
  media?: MatchMedia & Partial<Pick<RtcHost, 'microphones' | 'onMicrophones' | 'setMicrophone' | 'setVr' | 'refreshMicrophones' | 'setPreviewStereo' | 'setCameraLayer' | 'setCameraSource' | 'setCameraView' | 'setCameraEyes' | 'saveFrames' | 'startBench' | 'stopBench' | 'benchStatus' | 'onBenchStatus'>>;
  /** `<userData>/media.json`: the microphone and mute choices, kept even when the media layer did not start. */
  mediaSettings?: MediaSettingsStore;
  /** The SteamVR overlay helper (`media/vr-overlay.ts`, D7): the panel in the headset when VPX runs on SteamVR. */
  vrOverlay?: VrOverlay;
  /** D7.3 (2026-10-31): the Castcade OpenXR layer (`media/vr-layer.ts`): the panel in the headset on any other runtime. */
  vrLayer?: VrOverlay;
  /** D2.8 (2026-11-01): the table-sound helper (`media/audio-helper.ts`); absent → every rig hears its own table. */
  tableAudio?: TableAudioHelper;
  /** MEDIA_SIGNAL over the match transport (D2); absent → the media layer gets a mute signalling. */
  signalling?: (role: HostMatch | ClientMatch, localId: string) => MediaSignalling;
  appVersion: string;
  log: Logger;
  /** Test seam: the public IPv4, or null. Default: one GET to api.ipify.org, 4 s. */
  publicIp?: () => Promise<string | null>;
  /** Test seam: the lock file. Default: where the hook looks (`lockPathFrom(process.env)`). */
  lockFile?: string;
  /** Test seam: the address the host listens on. Default `0.0.0.0` (the other player comes in through the router). */
  listenAddress?: string;
  /** Test seam: the rig decision at host / join. Default `decideRig(witness)`: the running VPX probed now (A6, 2026-10-31). */
  rig?: () => Promise<RigDecision>;
  /** D7.6.3: where saved frames go. Default `<userData>/logs/frames` (beside companion.log; `file`'s folder is userData). */
  framesDir?: string;
  /** D2.10 (2026-11-05): Electron's `globalShortcut` in the app (the in-game volume keys); absent → no keys (tests pass a fake). */
  shortcuts?: ShortcutRegistrar;
}

/** D2.10: what `globalShortcut` offers: `register` is false when another app holds the key. */
export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** D2.10: the in-game volume keys (Electron accelerators), registered only while a match is on. */
export const VOLUME_SHORTCUTS = {
  voiceUp: 'Control+Alt+Up',
  voiceDown: 'Control+Alt+Down',
  tableDown: 'Control+Alt+Left',
  tableUp: 'Control+Alt+Right',
} as const;
/** D2.10: one press moves a volume by this many percent. */
export const VOLUME_STEP = 10;

const CUE_CHANNEL = 'castcade-cue:play';
const CUE_STATUS_CHANNEL = 'castcade-cue:status';
const CONNECT_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 10_000;
/** Lets a FORFEIT frame leave the socket before the transport is torn down. */
const LEAVE_FLUSH_MS = 300;
/** A10: how long a client shows the final standings after the series ended before it closes the match by itself. */
const SERIES_OVER_LINGER_MS = 20_000;
/** D7.6: after the bench's theater-off control, before the pipe closes (the layer reads the control first). */
const BENCH_HIDE_MS = 300;

interface Active {
  role: 'host' | 'client';
  transport: WsPeerTransport;
  engine: HostMatch | ClientMatch;
  controller: MatchController;
  code: string;
  port: number | null;
  invite: string | null;
  ipSource: 'public' | 'lan' | null;
  /** The overlay started for this match (the SteamVR helper or, D7.3, the OpenXR layer); null until one is. */
  overlay: VrOverlay | null;
  /** D7.4: the headset mode last given to `overlay` (and to which one), so each change goes out once. */
  vrMode: { mode: VrViewMode; to: VrOverlay } | null;
  /** A6 (2026-10-31): the rig decided at host / join; `pc` turns into `vr_headset` when the witness reads VR later. */
  rig: Rig;
  rigReason: string;
  /** B22 (2026-10-31): the runtime behind a `vr_headset` rig; it picks the overlay (D7.3). */
  runtime: VrRuntime | null;
  /** The witness's own reading at the last status, so a VR -> monitor change is logged once, not at every status. */
  witnessRig: Rig;
  /** A switch to the headset is under way (status events keep coming meanwhile). */
  switching: boolean;
  /**
   * A6 (2026-10-31, the first two-player match): the rig and fingerprint the others were last told (HELLO / the
   * host's own roster entry, then lobby updates), the witness reading they came from (`lobbyKey`), and a refresh
   * under way. Krobs joined before his table loaded and read "PC · different table file" for the whole match.
   */
  sent: { rig: Rig; game: GameFingerprint };
  lobbyKey: string;
  refreshing: boolean;
  refreshAgain: boolean;
  /** A10: a client's teardown after the series ended, once scheduled. */
  endTimer: ReturnType<typeof setTimeout> | null;
  offs: (() => void)[];
}

/** A6 (2026-10-31): the witness facts a lobby refresh follows: the table's fingerprint and the VR sample. */
/** D2.9: the saved TURN relay as the Match tab sees it: never the credential itself. */
export function turnView(t: TurnServer | null): MatchStatus['turn'] {
  return t ? { url: t.url, username: t.username, credentialSet: t.credential !== '' } : null;
}

function lobbyKey(s: WitnessStatus): string {
  const vr = s.currentAttestation?.vr;
  return JSON.stringify([gameFingerprintFrom(s, RECIPE_VERSION), vr?.sampledAt ?? null, vr?.inVr ?? null]);
}

async function ipifyPublicIp(): Promise<string | null> {
  try {
    const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return isIpv4(t) ? t : null;
  } catch {
    return null;
  }
}

/** D7.5.10 / D7.5.11: the stereo window's tuning in words for the log (empty at the defaults), as the layer control's line says it. */
export function windowTuneWords(s: Pick<MatchSettings, 'windowDepthM' | 'eyeOffsetDeg' | 'softEdge'>): string {
  return tuneWords({ depthM: s.windowDepthM, dyDeg: s.eyeOffsetDeg }, s.softEdge);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} (no answer in ${Math.round(ms / 1000)} s)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function createMatchHost(opts: MatchHostOptions): MatchHost {
  const { log, witness } = opts;
  const listeners = new Set<(s: MatchStatus) => void>();
  // D8.1 (2026-11-05): a match.json from before 0.2.36 is migrated once (the layer camera, one eye) and saved below.
  const loaded = loadMatchSettings(readText(opts.file));
  let settings = loaded.settings;
  // D7.4.3 (2026-11-01): the media layer declares the preview's stereo from this setting (and the ini on `auto`).
  opts.media?.setPreviewStereo?.(settings.previewStereo);
  // D7.5.1 (2026-11-02): the layer camera's layer and the Match tab's Camera (decided at each attach, alpha-match.md §5a).
  opts.media?.setCameraLayer?.(opts.vrLayer ?? null);
  opts.media?.setCameraSource?.(settings.cameraSource);
  // D7.5.9 (2026-11-04): the camera's view (whole render or the 1:2 crop); applied live to a running camera.
  opts.media?.setCameraView?.(settings.cameraView);
  // D8.1: the camera's eyes (one as a flat picture, or both side by side); applied live to a running camera.
  opts.media?.setCameraEyes?.(settings.cameraEyes);
  // D2.10: the page's playback volumes (the media layer keeps them for its next attach; a page that is up gets them now).
  const pushVolume = (note: string | null = null): void => {
    opts.media?.setVolume?.({ voice: settings.voiceVolume, table: settings.othersTableVolume, note } satisfies PanelVolume);
  };
  pushVolume();
  /**
   * D7.5.10 / D7.5.11 (2026-11-04): the stereo window's tuning and soft edge go to an overlay with Theater size: the
   * match's and the bench's, on every settings change (each setter is idempotent and the control dedups).
   */
  const syncWindowTune = (to: VrOverlay | null | undefined): void => {
    if (!to) return;
    to.setTheaterScale?.(settings.theaterScale);
    to.setWindowTune?.({ depthM: settings.windowDepthM, dyDeg: settings.eyeOffsetDeg });
    to.setSoftEdge?.(settings.softEdge);
  };
  let active: Active | null = null;
  let connecting = false;
  /** D7.6: the VR test bench (null: off). `overlay`: the OpenXR layer it put in theater, else the desktop panel shows it. */
  type Bench = { state: BenchState; source: 'clip' | 'live'; path: 'direct' | 'loop'; clip: string | null; overlay: VrOverlay | null; view: BenchView };
  let bench: Bench | null = null;
  const framesRoot = (): string => opts.framesDir ?? join(dirname(opts.file), 'logs', 'frames');
  let lastError: string | null = null;
  let busy = false;

  // ---- the turn lock (the hook checks it at each key press) ----
  const lockFile = opts.lockFile ?? lockPathFrom(process.env);
  let locked = false;
  const lock = {
    lock(): void {
      mkdirSync(dirname(lockFile), { recursive: true });
      writeFileSync(lockFile, '');
      locked = true;
    },
    unlock(): void {
      rmSync(lockFile, { force: true });
      locked = false;
    },
  };
  // A lock left by a crash would keep every solo game dead: no match is running at startup.
  if (existsSync(lockFile)) {
    try {
      rmSync(lockFile, { force: true });
      log.warn(`match: removed a turn lock left from an earlier run (${lockFile})`);
    } catch (e) {
      log.error(`match: could not remove the stale turn lock ${lockFile}: ${describeError(e)}`);
    }
  }

  // ---- the cue ----
  const cue = createCue(join(dirname(opts.file), 'match-cue.html'), () => settings.cueVolume, log);

  // ---- identity ----
  let identity: MatchIdentity | null = null;
  const matchIdentity = (): MatchIdentity => {
    if (identity) return identity;
    const loaded = parseMatchIdentity(readText(opts.keysFile));
    if (loaded) {
      identity = loaded;
      return loaded;
    }
    const fresh = newMatchIdentity();
    mkdirSync(dirname(opts.keysFile), { recursive: true });
    const tmp = `${opts.keysFile}.tmp`;
    writeFileSync(tmp, serializeMatchIdentity(fresh));
    renameSync(tmp, opts.keysFile);
    log.info(`match: generated match keys (${opts.keysFile})`);
    identity = fresh;
    return fresh;
  };
  const playerId = (): string => (witness.status().paired ? opts.device().deviceId : matchIdentity().installId);
  const defaultName = (): string => settings.displayName ?? cleanName(opts.device().deviceLabel) ?? 'Player';

  const saveSettings = (next: MatchSettings): void => {
    settings = next;
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.tmp`;
      writeFileSync(tmp, writeMatchSettings(settings));
      renameSync(tmp, opts.file);
    } catch (e) {
      log.warn(`match: could not save ${opts.file}: ${describeError(e)}`);
    }
  };
  if (loaded.migrated) {
    log.info(`match: ${loaded.migrated}`);
    saveSettings(settings);
  }

  // ---- status ----
  const idleRig = (): RigDecision => {
    const d = rigFromStatus(witness.status());
    return { rig: d.rig, reason: `no match; decided again when you host or join (${d.reason})`, runtime: d.runtime };
  };
  /** `RigDecision` names it `reason`; the status calls it `rigReason`. */
  const rigOf = (d: RigDecision): { rig: Rig; rigReason: string; runtime: VrRuntime | null } => ({ rig: d.rig, rigReason: d.reason, runtime: d.runtime });
  /**
   * D7.3 (2026-10-31): in VR the panel goes in the headset on every runtime. SteamVR: the OpenVR overlay helper draws
   * into its compositor. Any other (Virtual Desktop, Oculus, another OpenXR runtime; B22 told them apart): the Castcade
   * OpenXR layer draws inside VPX. A VR rig with no runtime is a sample from before B22, which only SteamVR produced.
   */
  type RigRuntime = Pick<Active, 'rig' | 'runtime'>;
  const usesLayer = (a: RigRuntime): boolean => a.rig === 'vr_headset' && a.runtime !== null && a.runtime !== 'steamvr';
  const overlayFor = (a: RigRuntime): VrOverlay | undefined => (usesLayer(a) ? opts.vrLayer : opts.vrOverlay);
  const headsetPanel = (a: RigRuntime): boolean => a.rig === 'vr_headset';
  const mediaRig = (a: Pick<Active, 'rig' | 'runtime'>): { inVr: boolean; headsetPanel: boolean; runtime: VrRuntime | null } => ({ inVr: a.rig === 'vr_headset', headsetPanel: headsetPanel(a), runtime: a.runtime });
  /** D7.6.1 / D7.6.2: the OpenXR layer's pipe as the Match tab's test-bench card needs it (the pattern toggle, the report). */
  const layerBenchView = (): MatchStatus['vrBench'] => {
    const b = opts.vrLayer?.bench?.();
    return b ? { connected: b.connected, protocol: b.protocol, pattern: b.test === 'pattern' } : null;
  };
  const nameIn = (c: ControllerStatus, id: string): string => c.participants.find((p) => p.playerId === id)?.displayName ?? id;
  const status = (): MatchStatus => {
    const a = active;
    const c: ControllerStatus | null = a ? a.controller.status() : null;
    const phase: MatchPhase = connecting ? 'connecting' : c ? c.phase : 'none';
    const r = a ? { rig: a.rig, rigReason: a.rigReason, runtime: a.runtime } : rigOf(idleRig());
    const rawMedia = a && opts.media ? opts.media.status() : null;
    const media = rawMedia && opts.tableAudio ? { ...rawMedia, tableAudio: opts.tableAudio.status() } : rawMedia;
    return {
      role: a ? a.role : 'none',
      phase,
      endpoint: a?.transport.endpoint ?? null,
      invite: a?.invite ?? null,
      ipSource: a?.ipSource ?? null,
      port: a?.port ?? null,
      code: a?.code ?? null,
      localId: a ? a.engine.localId : null,
      hostId: c?.hostId ?? null,
      participants: (c?.participants ?? []).map((p) => {
        const words = c ? mismatchWords(c.mismatches[p.playerId] ?? []) : null;
        return {
          id: p.playerId,
          name: p.displayName,
          rig: p.rig,
          tableMatch: c ? !c.tableMismatch.includes(p.playerId) : null,
          tableNote: words?.table ?? null,
          buildMatch: words ? words.build === null : null,
        };
      }),
      transfer: c?.transfer
        ? {
            proposer: nameIn(c, c.transfer.proposer),
            newHost: c.transfer.newHost === null ? null : nameIn(c, c.transfer.newHost),
            reason: c.transfer.reason,
          }
        : null,
      series: c?.series ?? null,
      panel: c?.panel ?? null,
      media,
      previewAdvice: previewAdvice({ inVr: r.rig === 'vr_headset', declared: media?.captureStereo, crop: media?.captureCrop }),
      vrOverlay: a ? ((a.overlay ?? overlayFor(a))?.status() ?? null) : null,
      vrBench: layerBenchView(),
      rig: r.rig,
      rigReason: r.rigReason,
      vrRuntime: r.runtime,
      microphones: opts.media?.microphones?.() ?? [],
      micDeviceId: opts.mediaSettings?.get().micDeviceId ?? null,
      muted: opts.mediaSettings?.get().muted ?? false,
      turn: turnView(opts.mediaSettings?.get().turn ?? null),
      locked,
      settings: { ...settings },
      defaultName: defaultName(),
      lastError,
      bench: benchView(),
    };
  };
  /** D7.6: the bench for the Match tab: the media layer's readout, plus the layer's own state while it is not showing. */
  const benchView = (): BenchStatus | null => {
    const b = bench;
    if (!b) return null;
    const m = opts.media?.benchStatus?.() ?? null;
    const o = b.overlay?.status() ?? null;
    const layer = o && o.state !== 'showing' ? ` · the layer is ${o.state}${o.reason ? ` (${o.reason})` : ''}` : '';
    const headset = !!b.overlay;
    return { state: b.state === 'running' ? 'running' : 'starting', source: b.source, path: b.path, clip: b.clip, headset, view: b.view, readout: (m?.readout ?? 'starting') + layer, hint: benchHint(headset, b.view) };
  };
  /**
   * D7.4 (2026-10-31): the headset follows the turn: hidden on this player's ball, theater while another is up, the
   * panel otherwise (`vrViewMode`, with the Match tab's two settings). Given to the overlay running now, once per change.
   */
  const syncVrMode = (a: Active): void => {
    const to = a.overlay;
    if (!to) return;
    syncWindowTune(to);
    const mode = vrViewMode(a.controller.panel(), settings);
    if (a.vrMode?.mode === mode && a.vrMode.to === to) return;
    a.vrMode = { mode, to };
    log.info(`match: headset mode ${mode}`);
    to.setMode(mode);
  };
  /**
   * D2.8: the table sound the panel state calls for (`tableAudioPlan`), on the VPX the match uses (the capture's window,
   * else the witness's launch). The helper and the page each act only on a change.
   */
  let tableLogged = '';
  const syncTableAudio = (): void => {
    const a = active;
    const plan = tableAudioPlan(a ? a.controller.panel() : null, settings);
    const pid = a ? tableAudioPid(opts.media?.capturePid?.(), witness.vpxPid?.()) : null;
    opts.tableAudio?.apply({ mutePid: plan.muteMine ? pid : null, tapPid: plan.tapMine ? pid : null });
    // D2.10: my table under my voice while I am up; back to its own volume the moment I am not.
    if (plan.levelMine !== null && pid !== null) opts.tableAudio?.level(pid, plan.levelMine);
    else opts.tableAudio?.unlevel();
    opts.media?.setTableAudio?.({ send: plan.tapMine && pid !== null, hear: plan.playTableOf !== null });
    const words = `mute ${plan.muteMine ? 'on' : 'off'}, send ${plan.tapMine ? 'on' : 'off'}, play ${plan.playTableOf ?? 'nobody'}, mine at ${plan.levelMine ?? 100} %, VPX pid ${pid ?? 'unknown'}`;
    if (opts.tableAudio && a && words !== tableLogged) {
      tableLogged = words;
      log.info(`match: table sound: ${words}`);
    }
  };
  /** A10: a client whose series is over closes the match after the linger (the host's End match tears down at once). */
  const scheduleSeriesEnd = (a: Active): void => {
    if (a.endTimer || active !== a || a.controller.currentRole instanceof HostMatch || !a.controller.status().series.over) return;
    log.info(`match: the series is over; closing the match in ${Math.round(SERIES_OVER_LINGER_MS / 1000)} s`);
    a.endTimer = setTimeout(() => {
      if (active !== a) return;
      void teardown(a).then(() => {
        log.info(`match: closed ${a.code} after the series ended`);
        emit();
      });
    }, SERIES_OVER_LINGER_MS);
  };
  const emit = (): void => {
    if (active) {
      syncVrMode(active);
      scheduleSeriesEnd(active);
    }
    // D7.6: Theater size applies to the bench live, as in a match; D7.5.10 / D7.5.11: the window's tuning and soft edge too.
    syncWindowTune(bench?.overlay);
    syncTableAudio();
    const s = status();
    for (const l of [...listeners]) l(s);
  };
  const fail = (e: unknown): never => {
    lastError = describeError(e);
    emit();
    throw e instanceof Error ? e : new Error(lastError);
  };

  opts.media?.onStatus(() => {
    if (!active) return;
    active.controller.refresh();
    emit();
  });
  opts.vrOverlay?.onStatus(() => {
    if (active) emit();
  });
  // D7.6: the bench's facts (connected, protocol, the pattern) reach the Match tab as they change.
  opts.vrLayer?.onBench?.(() => {
    if (active) emit();
  });
  opts.vrLayer?.onStatus(() => {
    if (active || bench) emit();
  });
  opts.media?.onBenchStatus?.(() => {
    if (bench) emit();
  });
  opts.tableAudio?.onStatus(() => {
    if (active) emit();
  });
  opts.media?.onMicrophones?.(() => emit());
  witness.onEvent((ev) => active?.controller.feed(ev));
  // A6 (2026-10-31): the witness samples VR when a table opens and again when its player starts (`table_loaded`). A
  // player who hosted on the monitor reading (before opening the table, or before the player started) is switched
  // to the headset then: the panel moves offscreen and the overlay starts. The reverse is logged and ignored. D7.3
  // (2026-10-31): a VR reading whose runtime needs the other overlay (SteamVR <-> an OpenXR runtime: VPX restarted on
  // another runtime) stops the one running and starts the other.
  witness.onStatus((s) => {
    const a = active;
    if (!a) return;
    checkLobby(a, s);
    const d = rigFromStatus(s);
    const now = d.rig;
    const was = a.witnessRig;
    a.witnessRig = now;
    if (now === 'vr_headset') {
      if (a.rig === 'pc' || overlayChanges(a, d)) void switchToVr(a, d);
      else if (headsetPanel(a) && !a.overlay && !a.switching && overlayFor(a) && opts.media?.frames()) void startOverlay(a);
    } else if (was === 'vr_headset' && a.rig === 'vr_headset') {
      log.info('match: the witness reads the monitor now; the panel stays in the headset for this match');
    }
  });

  const makeController = (engine: HostMatch | ClientMatch, ballsPerGame?: number): MatchController => {
    const controller = new MatchController({
      role: engine,
      localId: engine.localId,
      lock,
      cue: { play: (k) => cue.play(k) },
      media: opts.media,
      signalling: opts.signalling?.(engine, engine.localId),
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      log: (line) => log.info(line),
      ballsPerGame,
      // A12 (2026-11-05): the host's table before the match, and whether a game is already running on it.
      preMatchPlay: settings.preMatchPlay,
      tableGameRunning: liveGameRunning(),
    });
    controller.onChange(() => emit());
    return controller;
  };

  /** A12: the witness's live game says a game is on this rig's table now (a test witness may not have `liveGame`). */
  const liveGameRunning = (): boolean => {
    try {
      return witness.liveGame()?.inGame ?? false;
    } catch {
      return false;
    }
  };

  /** D7.3: the overlay the panel needs is not the one this rig has been using (VPX moved between SteamVR and OpenXR). */
  const overlayChanges = (a: Active, d: RigDecision): boolean =>
    a.rig === 'vr_headset' && d.runtime !== null && usesLayer({ rig: 'vr_headset', runtime: d.runtime }) !== usesLayer(a);

  const startOverlay = async (a: Active): Promise<void> => {
    const { media } = opts;
    const overlay = overlayFor(a);
    const frames = media?.frames() ?? null;
    if (!overlay || !frames) {
      const none = usesLayer(a) ? 'no OpenXR layer' : 'no overlay helper';
      if (a.rig === 'vr_headset') log.info(`match: in VR but ${overlay ? 'the panel has no frames yet' : none}; showing the desktop panel`);
      media?.showPanel();
      return;
    }
    a.overlay = overlay;
    syncVrMode(a);
    const via = usesLayer(a) ? ` via the OpenXR layer (${a.runtime})` : '';
    try {
      const st = await overlay.start(frames, media?.videoFrames?.() ?? null);
      log.info(`match: VR overlay ${st.state}${st.reason ? ` (${st.reason})` : ''}${via}`);
    } catch (e) {
      log.warn(`match: the VR overlay${via} did not start: ${describeError(e)}`);
    }
    emit();
  };

  // ---- D2.10: the in-game volume keys ----
  let keysHeld = false;
  /** One press: the setting moves a step (clamped by `patchMatchSettings`), is saved, pushed live, ticked and shown. */
  const nudge = (key: 'voiceVolume' | 'myTableWhileUp', delta: number, accelerator: string): void => {
    const before = settings[key];
    saveSettings(patchMatchSettings(settings, { [key]: before + delta }));
    const now = settings[key];
    const what = key === 'voiceVolume' ? 'voice volume' : 'my table while I play';
    log.info(`match: ${what} ${now} % (${accelerator}${now === before ? ', at the limit' : ''})`);
    pushVolume(key === 'voiceVolume' ? `Voice ${now} %` : `My table ${now} %`);
    cue.play('tick');
    // The Match tab's sliders follow; for my table, `syncTableAudio` levels the helper.
    emit();
  };
  const registerKeys = (): void => {
    const reg = opts.shortcuts;
    if (!reg || keysHeld) return;
    keysHeld = true;
    const bind = (acc: string, fn: () => void): void => {
      let ok: boolean;
      try {
        ok = reg.register(acc, fn);
      } catch (e) {
        log.warn(`match: ${acc} could not be registered: ${describeError(e)}`);
        return;
      }
      if (!ok) log.warn(`match: ${acc} is held by another app; that volume key is off this match`);
    };
    bind(VOLUME_SHORTCUTS.voiceUp, () => nudge('voiceVolume', VOLUME_STEP, VOLUME_SHORTCUTS.voiceUp));
    bind(VOLUME_SHORTCUTS.voiceDown, () => nudge('voiceVolume', -VOLUME_STEP, VOLUME_SHORTCUTS.voiceDown));
    bind(VOLUME_SHORTCUTS.tableUp, () => nudge('myTableWhileUp', VOLUME_STEP, VOLUME_SHORTCUTS.tableUp));
    bind(VOLUME_SHORTCUTS.tableDown, () => nudge('myTableWhileUp', -VOLUME_STEP, VOLUME_SHORTCUTS.tableDown));
    log.info('match: volume keys on while the match runs: Ctrl+Alt+Up / Down the voice, Ctrl+Alt+Left / Right my table while I play');
  };
  const unregisterKeys = (): void => {
    if (!keysHeld) return;
    keysHeld = false;
    for (const acc of Object.values(VOLUME_SHORTCUTS)) {
      try {
        opts.shortcuts?.unregister(acc);
      } catch {
        /* already gone */
      }
    }
  };

  /** §3 / coordinator 2026-10-30: the panel goes up at host / join, before the match starts, of the kind decided then. */
  const openPanel = async (a: Active): Promise<void> => {
    // D2.8: the helper starts with the match, so "table sound unavailable" shows before the first ball.
    opts.tableAudio?.start();
    // D2.10: the volume keys live as long as the match.
    registerKeys();
    await opts.media?.setVr?.(mediaRig(a));
    await a.controller.open();
    if (headsetPanel(a)) await startOverlay(a);
    else opts.media?.showPanel();
  };

  /**
   * A6 (2026-10-31): the desktop panel moves into the headset when the witness reads VR after host / join. D7.3: on any
   * runtime (the OpenXR layer off SteamVR), and a later reading on a runtime that needs the other overlay swaps them.
   */
  const switchToVr = async (a: Active, d: RigDecision): Promise<void> => {
    if (a.switching) return;
    if (a.rig === 'vr_headset' && !overlayChanges(a, d)) return;
    a.switching = true;
    const was = a.overlay;
    a.rig = 'vr_headset';
    a.runtime = d.runtime;
    a.rigReason = `switched after ${a.role === 'host' ? 'hosting' : 'joining'}: ${d.reason}`;
    log.info(`match: rig vr_headset (${a.rigReason})`);
    // A6.1 (2026-11-01): the others are told in any phase, before the panel moves (the owner's rig read VR 7 s after
    // Start, and the roster said pc all match). The table is the lobby refresh's to announce, not this.
    if (active === a) announceLobby(a, a.rig, a.sent.game);
    emit();
    if (was) {
      a.overlay = null;
      log.info(`match: VPX's VR runtime is ${d.runtime ?? 'unknown'} now; the panel moves to ${usesLayer(a) ? 'the OpenXR layer' : 'the SteamVR overlay'}`);
      await was.stop().catch((e: unknown) => log.warn(`match: overlay stop: ${describeError(e)}`));
    }
    try {
      await opts.media?.setVr?.(mediaRig(a));
    } catch (e) {
      log.warn(`match: the panel did not move into the headset: ${describeError(e)}`);
    }
    a.switching = false;
    if (active !== a) return;
    await startOverlay(a);
    emit();
  };

  /** The rig at host / join, logged with its evidence; a failing probe never stops a match (the monitor is assumed). */
  const decide = async (): Promise<RigDecision> => {
    const d = await (opts.rig ?? (() => decideRig(witness)))().catch((e: unknown): RigDecision => ({ rig: 'pc', reason: `the VR probe failed (${describeError(e)}); monitor assumed`, runtime: null }));
    log.info(`match: rig ${d.rig}${d.runtime ? ` via ${d.runtime}` : ''} (${d.reason})`);
    return d;
  };

  // ---- A6 (2026-10-31): the lobby refresh of the rig and the table ----
  // The rig and fingerprint go out once in HELLO (or the host's roster entry). A player who joins or hosts before its
  // table loads says `pc` and no table; until MATCH_READY, a table load or a new VR sample re-decides both and tells
  // the others (PARTICIPANT_UPDATE from a client, a re-sent HELLO_ACK from the host). The rig only moves towards the
  // headset, as the A6 switch does: a monitor reading after a VR one keeps the headset (`switchToVr` is one-way).
  const inLobby = (a: Active): boolean => active === a && a.engine.state.phase === 'lobby';
  const checkLobby = (a: Active, s: WitnessStatus): void => {
    if (!inLobby(a)) return;
    const k = lobbyKey(s);
    if (k === a.lobbyKey) return;
    a.lobbyKey = k;
    void refreshLobby(a);
  };
  const refreshLobby = async (a: Active): Promise<void> => {
    if (a.refreshing) {
      a.refreshAgain = true;
      return;
    }
    a.refreshing = true;
    try {
      do {
        a.refreshAgain = false;
        const d = await decide();
        if (!inLobby(a)) return;
        // Only the first move into VR: a runtime swap (SteamVR <-> an OpenXR runtime) is the status listener's job, and
        // re-deciding here could swap it straight back (merge of D2.4 + D7.3, 2026-10-31: the media layer was told twice).
        if (d.rig === 'vr_headset' && a.rig === 'pc') await switchToVr(a, d);
        if (!inLobby(a)) return;
        announceLobby(a, a.rig, gameFingerprintFrom(witness.status(), RECIPE_VERSION));
      } while (a.refreshAgain);
    } catch (e) {
      log.warn(`match: the lobby update failed: ${describeError(e)}`);
    } finally {
      a.refreshing = false;
    }
  };
  /**
   * Tells the others what changed since they were last told. A6.1 (2026-11-01): in any phase; after MATCH_READY the
   * engines carry only the rig (a table change then is not sent, and `sent.game` keeps what was). The role in charge
   * now (`currentRole`): after a host transfer `a.engine` is the role that stepped down.
   */
  const announceLobby = (a: Active, rig: Rig, game: GameFingerprint): void => {
    const role = a.controller.currentRole as HostMatch | ClientMatch;
    const lobby = role.state.phase === 'lobby';
    const rigChanged = rig !== a.sent.rig;
    const gameChanged = lobby && JSON.stringify(game) !== JSON.stringify(a.sent.game);
    if (!rigChanged && !gameChanged) return;
    const u = { ...(rigChanged ? { rig } : {}), ...(gameChanged ? { game } : {}) };
    let done: boolean;
    try {
      done = role instanceof HostMatch ? role.updateLocal(u) : role.updateParticipant(u);
    } catch (e) {
      log.warn(`match: the rig update did not go out: ${describeError(e)}`);
      return;
    }
    a.sent = { rig, game: gameChanged ? game : a.sent.game };
    if (!done) return;
    const what = [rigChanged ? `rig ${rig}` : null, gameChanged ? `table ${game.tableName} (${game.tableHash === ZERO_SHA256 ? 'no hash' : game.tableHash.slice(0, 12)})` : null].filter(Boolean).join(', ');
    log.info(`match: ${lobby ? 'lobby' : 'match'} update: ${what}; ${role instanceof HostMatch ? 'the players were told' : 'the host was told'}`);
    emit();
  };

  const participant = (id: string, name: string, rig: Rig): ParticipantInfo => ({
    playerId: id,
    displayName: name,
    publicKey: matchIdentity().keys.publicKeyB64,
    rig,
  });

  const guard = async (fn: () => Promise<MatchStatus>): Promise<MatchStatus> => {
    if (busy) throw new Error('Castcade is still working on the last match request');
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };

  /**
   * D7.6: ends the bench (Stop, a match starting, quit): VPX's own view first (theater off, the control given a moment
   * to reach the layer), then the layer's pipe and the panel. Never throws.
   */
  const endBench = async (why: string): Promise<void> => {
    const b = bench;
    if (!b) return;
    bench = null;
    if (b.overlay) {
      b.overlay.setMode('hidden');
      await new Promise<void>((r) => setTimeout(r, BENCH_HIDE_MS));
      await b.overlay.stop().catch((e: unknown) => log.warn(`bench: layer stop: ${describeError(e)}`));
    }
    await opts.media?.stopBench?.().catch((e: unknown) => log.warn(`bench: media stop: ${describeError(e)}`));
    log.info(`bench: stopped (${why})${b.overlay ? "; VPX's own view is back" : ''}`);
    emit();
  };
  const startBench = (raw: unknown): Promise<MatchStatus> =>
    guard(async () => {
      const step = benchStep(bench ? bench.state : 'off', { kind: 'start', matchOn: !!active || connecting });
      if (step.refuse) return fail(new Error(step.refuse));
      const media = opts.media;
      if (!media?.startBench || !media.stopBench) return fail(new Error('The media layer is not running in this build: no test bench'));
      const req = benchRequestFrom(raw);
      if (typeof req === 'string') return fail(new Error(req));
      lastError = null;
      const d = await decide();
      const layer = usesLayer(d) && opts.vrLayer ? opts.vrLayer : null;
      if (req.source === 'live') {
        const why = liveRefusal(d.rig, d.runtime, !!opts.vrLayer);
        if (why) return fail(new Error(why));
      }
      const clipDir = req.clip ? join(framesRoot(), req.clip.name) : null;
      const clip = req.clip && clipDir ? loadClip(clipDir, req.clip.side) : null;
      if (req.source === 'clip' && !clip) return fail(new Error(`The saved clip ${req.clip?.name ?? ''} has no ${req.clip?.side === 'receiver' ? 'received' : 'eye'} frames to play`));
      const b: Bench = { state: 'starting', source: req.source, path: req.path, clip: req.clip ? `${req.clip.name} (${req.clip.side === 'receiver' ? 'received frames' : 'eye frames'})` : null, overlay: null, view: 'theater' };
      bench = b;
      emit();
      try {
        await media.startBench({ source: req.source, path: req.path, clip, clipDir, clipName: req.clip?.name ?? null, inVr: d.rig === 'vr_headset', headsetPanel: !!layer, bitrate: req.bitrate });
      } catch (e) {
        bench = null;
        return fail(e);
      }
      if (layer) {
        const frames = media.frames();
        if (frames) {
          b.overlay = layer;
          syncWindowTune(layer);
          layer.setMode('theater');
          try {
            const st = await layer.start(frames, media.videoFrames?.() ?? null);
            log.info(`bench: the OpenXR layer ${st.state}${st.reason ? ` (${st.reason})` : ''}, theater at Theater size ${settings.theaterScale}${windowTuneWords(settings)}`);
          } catch (e) {
            log.warn(`bench: the OpenXR layer did not start: ${describeError(e)}`);
          }
        }
      } else media.showPanel();
      if (bench !== b) return status();
      b.state = benchStep(b.state, { kind: 'started' }).state;
      // D7.5.9: the camera's view when the source is the layer camera; D7.5.10 / D7.5.11: the tuning when not the defaults.
      const view = b.source === 'live' ? `; ${settings.cameraView} view` : '';
      log.info(`bench: running (${d.rig}${d.runtime ? ` via ${d.runtime}` : ''}; ${b.overlay ? 'theater in the headset' : 'the desktop panel'}${view}${windowTuneWords(settings)})`);
      emit();
      return status();
    });

  const host = (o: { port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus> =>
    guard(async () => {
      if (active) return fail(new Error('Leave the current match first'));
      await endBench('a match is hosted');
      lastError = null;
      const port = o.port === undefined ? settings.port : cleanPort(o.port);
      if (port === null) return fail(new Error('The port must be a number from 1024 to 65535'));
      const ballsPerGame = o.ballsPerGame === 5 ? 5 : 3;
      const name = cleanName(o.displayName) ?? defaultName();
      saveSettings(patchMatchSettings(settings, { port, ballsPerGame, displayName: name }));
      const me = playerId();
      // A8 (2026-10-31): the rig and the public address first, the listener last (module header).
      const [rig, pub] = await Promise.all([decide(), (opts.publicIp ?? ipifyPublicIp)().catch(() => null)]);
      const transport = new WsPeerTransport({ localId: me });
      const code = newMatchCode();
      const ws = witness.status();
      const game = gameFingerprintFrom(ws, RECIPE_VERSION);
      const engine = new HostMatch({
        transport,
        keys: matchIdentity().keys,
        matchId: code,
        ballsPerGame,
        hostParticipant: participant(me, name, rig.rig),
        hostGame: game,
        // §3: a different table file is shown on both panels, never refused (the client learns it from HELLO_ACK).
        fingerprintPolicy: 'advise',
        companionVersion: opts.appVersion.slice(0, 32),
        // A11: who is still loading, and whether the start from this host's table may go.
        tableOpen: isTableOpen,
      });
      const controller = makeController(engine, ballsPerGame);
      const a: Active = {
        role: 'host',
        transport,
        engine,
        controller,
        code,
        port,
        invite: null,
        ipSource: null,
        overlay: null,
        vrMode: null,
        ...rigOf(rig),
        witnessRig: rigFrom(witness.status()),
        switching: false,
        sent: { rig: rig.rig, game },
        lobbyKey: lobbyKey(ws),
        refreshing: false,
        refreshAgain: false,
        endTimer: null,
        offs: [],
      };
      a.offs.push(transport.onError((err, peer) => log.warn(`match: socket ${peer ?? '(new)'}: ${err.message}`)));
      active = a;
      await openPanel(a);
      try {
        await transport.listen(port, opts.listenAddress ?? '0.0.0.0');
      } catch (e) {
        await teardown(a);
        const errno = (e as NodeJS.ErrnoException).code;
        return fail(new Error(errno === 'EADDRINUSE' ? `Port ${port} is already in use on this PC: pick another port` : `Could not listen on port ${port}: ${describeError(e)}`));
      }
      const ip = pub ?? pickLanAddress(networkInterfaces()) ?? '127.0.0.1';
      a.ipSource = pub ? 'public' : 'lan';
      a.invite = formatInvite(ip, port, code);
      log.info(`match: hosting ${code} on ${transport.endpoint ?? `port ${port}`} (${ballsPerGame} balls); invite ${a.invite} (${a.ipSource} address)`);
      // The table may have loaded while hosting (A6, 2026-10-31).
      checkLobby(a, witness.status());
      emit();
      return status();
    });

  type JoinOutcome = { kind: 'joined'; transport: WsPeerTransport; engine: ClientMatch; controller: MatchController } | { kind: 'refused'; refuse: PayloadOf<'REFUSE'> };

  const tryJoin = async (url: string, code: string, me: string, name: string, rig: Rig, game: ReturnType<typeof gameFingerprintFrom>): Promise<JoinOutcome> => {
    const transport = new WsPeerTransport({ localId: me });
    const engine = new ClientMatch({ transport, keys: matchIdentity().keys, participant: participant(me, name, rig), game, throwdownCode: code, companionVersion: opts.appVersion.slice(0, 32) });
    // Built before HELLO so it sees HELLO_ACK's roster.
    const controller = makeController(engine);
    const offs: (() => void)[] = [];
    const answer = new Promise<'joined' | PayloadOf<'REFUSE'>>((resolve) => {
      offs.push(engine.on('joined', () => resolve('joined')));
      offs.push(engine.on('refused', (r) => resolve(r)));
    });
    const cleanup = async (): Promise<void> => {
      await controller.close();
      engine.close();
      transport.close();
    };
    try {
      await withTimeout(transport.connect(url), CONNECT_TIMEOUT_MS, `Could not reach the host at ${url.slice('ws://'.length)}`);
      engine.join();
      const r = await withTimeout(answer, JOIN_TIMEOUT_MS, 'The host did not answer');
      if (r !== 'joined') {
        await cleanup();
        return { kind: 'refused', refuse: r };
      }
      return { kind: 'joined', transport, engine, controller };
    } catch (e) {
      await cleanup();
      throw new Error(`${describeError(e)}. Check the invite, and that the host forwarded the TCP port to their PC.`, { cause: e });
    } finally {
      for (const off of offs) off();
    }
  };

  const joinMatch = (invite: string, displayName: string): Promise<MatchStatus> =>
    guard(async () => {
      if (active) return fail(new Error('Leave the current match first'));
      await endBench('a match is joined');
      lastError = null;
      let parsed: ReturnType<typeof parseInvite>;
      try {
        parsed = parseInvite(invite);
      } catch (e) {
        return fail(e);
      }
      const name = cleanName(displayName) ?? defaultName();
      saveSettings(patchMatchSettings(settings, { displayName: name }));
      const me = playerId();
      connecting = true;
      emit();
      try {
        const rig = await decide();
        const ws = witness.status();
        const game = gameFingerprintFrom(ws, RECIPE_VERSION);
        const out = await tryJoin(parsed.url, parsed.code, me, name, rig.rig, game);
        if (out.kind === 'refused') throw new Error(`The host refused: ${out.refuse.message}`);
        const differs = out.controller.status().tableMismatch.includes(me);
        if (differs) log.warn("match: the host's table file differs from this one; joined anyway, flagged on both panels");
        const a: Active = {
          role: 'client',
          transport: out.transport,
          engine: out.engine,
          controller: out.controller,
          code: parsed.code,
          port: parsed.port,
          invite: null,
          ipSource: null,
          overlay: null,
          vrMode: null,
          ...rigOf(rig),
          witnessRig: rigFrom(witness.status()),
          switching: false,
          sent: { rig: rig.rig, game },
          lobbyKey: lobbyKey(ws),
          refreshing: false,
          refreshAgain: false,
          endTimer: null,
          offs: [],
        };
        a.offs.push(out.transport.onError((err) => log.warn(`match: socket: ${err.message}`)));
        active = a;
        connecting = false;
        log.info(`match: joined ${parsed.code} at ${parsed.url}`);
        await openPanel(a);
        // The table may have loaded while joining (A6, 2026-10-31).
        checkLobby(a, witness.status());
        emit();
        return status();
      } catch (e) {
        connecting = false;
        return fail(e);
      }
    });

  /** Close everything a match holds: the overlay, the controller (the panel, the media), the engine(s), the sockets. */
  const teardown = async (a: Active): Promise<void> => {
    if (active === a) active = null;
    if (a.endTimer) clearTimeout(a.endTimer);
    a.endTimer = null;
    for (const off of a.offs) off();
    unregisterKeys();
    // D2.8: this rig's table sounds again at once (the emit that follows would do it too, a moment later).
    opts.tableAudio?.apply({ mutePid: null, tapPid: null });
    opts.tableAudio?.unlevel();
    tableLogged = '';
    if (a.overlay) await a.overlay.stop().catch((e: unknown) => log.warn(`match: overlay stop: ${describeError(e)}`));
    const roles = new Set<{ close(): void }>([a.engine, a.controller.currentRole as HostMatch | ClientMatch]);
    await a.controller.close();
    for (const r of roles) r.close();
    a.transport.close();
  };

  const leave = (): Promise<MatchStatus> =>
    guard(async () => {
      const a = active;
      if (!a) return status();
      a.controller.leave('left the match');
      // A10: the host leaving between games ends the series for everyone (MATCH_END), rather than leaving them to find
      // out from a dead socket.
      if (a.controller.currentRole instanceof HostMatch && a.controller.endMatch()) log.info(`match: ${a.code} ended by the host after ${a.controller.status().series.game} game(s)`);
      await new Promise<void>((r) => setTimeout(r, LEAVE_FLUSH_MS));
      await teardown(a);
      lastError = null;
      log.info(`match: left ${a.code}`);
      emit();
      return status();
    });

  return {
    host,
    join: joinMatch,
    async start() {
      const a = active;
      if (!a) return fail(new Error('No match: host one first'));
      const r = a.controller.currentRole;
      if (!(r instanceof HostMatch)) return fail(new Error('Only the host starts the match'));
      if (r.state.phase !== 'lobby') {
        // A10: between games this is Next game.
        const why = a.controller.status().series.nextGameBlocker;
        if (why !== null || !a.controller.nextGame()) return fail(new Error(`No next game now: ${why ?? 'the host could not start it'}`));
        lastError = null;
        log.info(`match: ${a.code} game ${r.state.gameNumber} started from the Match tab`);
        emit();
        return status();
      }
      try {
        r.start();
      } catch (e) {
        return fail(e);
      }
      lastError = null;
      log.info(`match: ${a.code} started with ${r.state.participants.map((p) => p.displayName).join(', ')}`);
      emit();
      return status();
    },
    async resume() {
      const a = active;
      if (!a) return fail(new Error('No match'));
      const r = a.controller.currentRole;
      if (!(r instanceof HostMatch)) return fail(new Error('Only the host resumes a pause from here'));
      if (r.state.phase !== 'running' || !r.state.paused) return fail(new Error('The match is not paused'));
      if (r.state.pendingTransfer) return fail(new Error('A host transfer is under way: wait for it to finish'));
      try {
        r.resume();
      } catch (e) {
        return fail(e);
      }
      lastError = null;
      log.info(`match: ${a.code} resumed from the Match tab`);
      emit();
      return status();
    },
    leave,
    setSettings(patch) {
      const before = settings.previewStereo;
      const cameraBefore = settings.cameraSource;
      const viewBefore = settings.cameraView;
      const eyesBefore = settings.cameraEyes;
      const tuneBefore = windowTuneWords(settings);
      const preMatchBefore = settings.preMatchPlay;
      const volumeBefore = `${settings.voiceVolume}/${settings.othersTableVolume}/${settings.myTableWhileUp}`;
      saveSettings(patchMatchSettings(settings, patch));
      // A12 (2026-11-05): the host's table before the match; a lobby under way follows the new choice at once.
      if (settings.preMatchPlay !== preMatchBefore) {
        log.info(`match: before the match: ${settings.preMatchPlay === 'locked' ? 'the table is locked until someone joins' : 'free play until someone joins'} (Match tab)`);
        active?.controller.setPreMatchPlay(settings.preMatchPlay);
      }
      // D2.10: the page's volumes go live at once; my table while I play reaches the helper in `emit` (syncTableAudio).
      if (`${settings.voiceVolume}/${settings.othersTableVolume}/${settings.myTableWhileUp}` !== volumeBefore) {
        pushVolume();
        log.info(`match: volumes on the Match tab: voice ${settings.voiceVolume} %, their table ${settings.othersTableVolume} %, my table while I play ${settings.myTableWhileUp} %`);
      }
      if (settings.previewStereo !== before) {
        opts.media?.setPreviewStereo?.(settings.previewStereo);
        log.info(`match: preview stereo set to ${settings.previewStereo} on the Match tab`);
      }
      // D7.5.1: the media layer reads it at its next attach, and while attached switches between balls (§5a).
      if (settings.cameraSource !== cameraBefore) {
        log.info(`match: camera set to ${settings.cameraSource === 'layer' ? 'the VR layer' : 'the screen capture'} on the Match tab (${active ? 'takes effect between balls' : 'takes effect at the next match'})`);
        opts.media?.setCameraSource?.(settings.cameraSource);
      }
      // D7.5.9: the view applies to a running camera at once (the media layer asks the layer again).
      if (settings.cameraView !== viewBefore) {
        log.info(`match: camera view set to ${settings.cameraView === 'whole' ? "each eye's whole render" : 'the 1:2 window crop'} on the Match tab`);
        opts.media?.setCameraView?.(settings.cameraView);
      }
      // D8.1: the eyes apply to a running camera at once too (the media layer asks the layer again, the capture follows).
      if (settings.cameraEyes !== eyesBefore) {
        log.info(`match: camera eyes set to ${settings.cameraEyes === 'one' ? 'one eye (a flat picture)' : 'both eyes (side by side)'} on the Match tab`);
        opts.media?.setCameraEyes?.(settings.cameraEyes);
      }
      // D7.5.10 / D7.5.11: the window's tuning reaches the overlays in `emit` (syncWindowTune); one line when it changed.
      if (windowTuneWords(settings) !== tuneBefore) log.info(`match: stereo window${windowTuneWords(settings) || ': depth infinity, no vertical offset, hard edges'} on the Match tab`);
      emit();
      return status();
    },
    setMicrophone(deviceId) {
      const id = typeof deviceId === 'string' && deviceId.trim() !== '' ? deviceId : null;
      // The media layer saves it and switches the live track; without one the choice is still kept for next time.
      if (opts.media?.setMicrophone) opts.media.setMicrophone(id);
      else opts.mediaSettings?.patch({ micDeviceId: id });
      log.info(`match: microphone ${id === null ? 'set to the Windows default' : 'chosen on the Match tab'}`);
      emit();
      return status();
    },
    setTurn(turn) {
      const store = opts.mediaSettings;
      if (!store) throw new Error('media settings are not available in this build');
      const url = turn?.url.trim() ?? '';
      if (!turn || url === '') {
        store.patch({ turn: null });
        log.info('match: TURN relay cleared on the Match tab (STUN only from the next match)');
      } else {
        const saved = store.get().turn;
        const next: TurnServer = { url, username: turn.username.trim(), credential: turn.credential ?? saved?.credential ?? '' };
        const got = store.patch({ turn: next }).turn;
        if (!got || got.url !== next.url || got.username !== next.username || got.credential !== next.credential) {
          throw new Error('The TURN relay needs a turn: or turns: address (for example turn:relay.example.org:3478), a username and a credential, each under 512 characters.');
        }
        // Never the credential (media-settings.ts).
        log.info(`match: TURN relay set to ${got.url} on the Match tab (used from the next match)`);
      }
      emit();
      return status();
    },
    setMuted(muted) {
      if (opts.media) opts.media.setMuted(muted);
      else opts.mediaSettings?.patch({ muted });
      active?.controller.refresh();
      emit();
      return status();
    },
    showPanel() {
      opts.media?.showPanel();
      emit();
      return status();
    },
    hidePanel() {
      opts.media?.hidePanel?.();
      emit();
      return status();
    },
    setVrTest(test) {
      if (opts.vrLayer?.setTest) {
        log.info(`match: calibration pattern ${test ? 'on' : 'off'} (Match tab)`);
        opts.vrLayer.setTest(test);
      }
      emit();
      return status();
    },
    refreshMicrophones() {
      // During a match the panel page keeps the list; the new list reaches the tab through onMicrophones -> emit.
      if (active || !opts.media?.refreshMicrophones) return;
      void opts.media.refreshMicrophones().catch((e: unknown) => log.warn(`match: microphone list: ${describeError(e)}`));
    },
    status,
    onStatus(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async saveFrames() {
      const media = opts.media;
      if (!media?.saveFrames) throw new Error('The media layer is not running in this build: no frames to save');
      const root = framesRoot();
      const base = clipFolderName(new Date());
      let folder = base;
      for (let k = 2; existsSync(join(root, folder)); k++) folder = `${base}-${k}`;
      const a = active;
      return media.saveFrames({
        dir: join(root, folder),
        folder,
        settings: { match: { ...settings }, phase: a ? a.controller.status().phase : 'none', rig: a ? a.rig : null, runtime: a ? a.runtime : null, headsetMode: a?.vrMode?.mode ?? null },
      });
    },
    startBench,
    async stopBench() {
      await endBench('Stop on the Match tab');
      return status();
    },
    setBenchView(view) {
      const b = bench;
      if (!b || b.state !== 'running') return status();
      const next: BenchView = view === 'direct' ? 'direct' : 'theater';
      if (next !== b.view) {
        b.view = next;
        b.overlay?.setMode(next === 'theater' ? 'theater' : 'hidden');
        log.info(`bench: ${next === 'theater' ? 'the bench picture (theater)' : "VPX's own view"} on the Match tab`);
      }
      emit();
      return status();
    },
    benchClips: () => listClips(framesRoot()),
    async stop() {
      await endBench('Castcade quits');
      await leave().catch((e: unknown) => log.warn(`match: leave on quit: ${describeError(e)}`));
      unregisterKeys();
      cue.destroy();
    },
  };
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------- cue --

/**
 * §3: a hidden window synthesises the cues (no asset): two rising tones for "your ball", one low tone for "opponent
 * up", a chord for "match over"; D2.10: a short `tick` for a volume key press. It plays on the default output, which
 * in VR is the headset. A file page with node integration, like `stream-host.ts`'s audio page; autoplay allowed so
 * the first cue sounds without a click.
 */
function createCue(page: string, volume: () => number, log: Logger): { play(kind: CueKind | 'tick'): void; destroy(): void } {
  let win: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;
  ipcMain.on(CUE_STATUS_CHANNEL, (e, s: unknown) => {
    if (win && !win.isDestroyed() && e.sender === win.webContents) log.warn(`match: cue ${JSON.stringify(s)}`);
  });
  const ensure = (): Promise<void> => {
    if (win && !win.isDestroyed() && ready) return ready;
    writeFileSync(page, cuePage());
    const w = new BrowserWindow({
      show: false,
      width: 120,
      height: 80,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    win = w;
    ready = new Promise<void>((resolve) => {
      w.webContents.once('did-finish-load', () => resolve());
    });
    void w.loadFile(page);
    return ready;
  };
  return {
    play(kind) {
      try {
        void ensure().then(() => {
          if (win && !win.isDestroyed()) win.webContents.send(CUE_CHANNEL, kind, volume() / 100);
        });
      } catch (e) {
        log.warn(`match: cue ${kind} failed: ${describeError(e)}`);
      }
    },
    destroy() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      ready = null;
    },
  };
}

function cuePage(): string {
  return `<!doctype html><meta charset="utf-8"><title>Castcade cue</title><script>
const { ipcRenderer } = require('electron');
let ctx = null;
function tone(freq, start, dur, gain, type) {
  const o = new OscillatorNode(ctx, { type, frequency: freq });
  const g = new GainNode(ctx, { gain: 0 });
  o.connect(g).connect(ctx.destination);
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t);
  o.stop(t + dur + 0.05);
}
ipcRenderer.on('${CUE_CHANNEL}', async (_e, kind, volume) => {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state !== 'running') await ctx.resume();
    const v = Math.max(0, Math.min(1, Number(volume) || 0)) * 0.6;
    if (v <= 0) return;
    if (kind === 'your_turn') { tone(660, 0, 0.18, v, 'triangle'); tone(990, 0.2, 0.32, v, 'triangle'); }
    else if (kind === 'opponent_turn') { tone(262, 0, 0.4, v * 0.8, 'sine'); }
    else if (kind === 'match_over') { for (const f of [523.25, 659.25, 783.99]) tone(f, 0, 1.3, v * 0.45, 'triangle'); tone(1046.5, 0.12, 1.1, v * 0.3, 'sine'); }
    else if (kind === 'tick') { tone(880, 0, 0.06, v * 0.7, 'triangle'); }
  } catch (e) { ipcRenderer.send('${CUE_STATUS_CHANNEL}', { error: String(e) }); }
});
</script>`;
}
