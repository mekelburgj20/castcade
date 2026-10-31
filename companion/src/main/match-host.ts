/**
 * A6 + C3 in the shell (docs/design/alpha-match.md §1–§3, 2026-10-30): one match at a time, hosted or joined over
 * `WsPeerTransport`, invite by text (no ArcAid lobby yet, F6). Owns the match keys (`<userData>/match-keys.json`),
 * the match settings (`<userData>/match.json`), the turn lock file the hook reads, the audio cue (a hidden window
 * that synthesises three cues with WebAudio, like `stream-host.ts`'s audio page) and the `MatchController`, which it
 * feeds with the witness's detector events. `media` (D2), `vrOverlay` (D7, SteamVR) and `vrLayer` (D7.3, OpenXR
 * runtimes) are optional: the app runs without them, and the lead wires the real ones. The panel goes up as soon as a player hosts or joins (coordinator
 * 2026-10-30), so the headset overlay can be checked before the match: the media layer is attached then with no
 * peers, and MATCH_READY adds them.
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
import type { MatchMedia, MediaSignalling, MediaStatus, PanelState, VrOverlay, VrOverlayStatus, VrViewMode } from '../media/match-media-types.js';
import type { MediaSettingsStore } from '../media/media-settings.js';
import type { MicDevice } from '../media/panel-page.js';
import type { RtcHost } from '../media/rtc-host.js';
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
  lockPathFrom,
  newMatchCode,
  newMatchIdentity,
  parseInvite,
  parseMatchIdentity,
  patchMatchSettings,
  pickLanAddress,
  readMatchSettings,
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
  panel: PanelState | null;
  media: MediaStatus | null;
  vrOverlay: VrOverlayStatus | null;
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
  locked: boolean;
  settings: MatchSettings;
  /** The name the Host / Join cards prefill: the setting, else the pairing label. */
  defaultName: string;
  lastError: string | null;
}

export interface MatchHost {
  host(opts: { port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus>;
  join(invite: string, displayName: string): Promise<MatchStatus>;
  start(): Promise<MatchStatus>;
  leave(): Promise<MatchStatus>;
  setSettings(patch: Partial<MatchSettings>): MatchStatus;
  /** Null: the Windows default. Saved in media.json, and switched live while a match runs. */
  setMicrophone(deviceId: string | null): MatchStatus;
  setMuted(muted: boolean): MatchStatus;
  /** B22 (2026-10-31): the Match tab opened: list the microphones if no match lists them; a status follows. Never throws. */
  refreshMicrophones(): void;
  status(): MatchStatus;
  onStatus(cb: (s: MatchStatus) => void): () => void;
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
  media?: MatchMedia & Partial<Pick<RtcHost, 'microphones' | 'onMicrophones' | 'setMicrophone' | 'setVr' | 'refreshMicrophones'>>;
  /** `<userData>/media.json`: the microphone and mute choices, kept even when the media layer did not start. */
  mediaSettings?: MediaSettingsStore;
  /** The SteamVR overlay helper (`media/vr-overlay.ts`, D7): the panel in the headset when VPX runs on SteamVR. */
  vrOverlay?: VrOverlay;
  /** D7.3 (2026-10-31): the Castcade OpenXR layer (`media/vr-layer.ts`): the panel in the headset on any other runtime. */
  vrLayer?: VrOverlay;
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
}

const CUE_CHANNEL = 'castcade-cue:play';
const CUE_STATUS_CHANNEL = 'castcade-cue:status';
const CONNECT_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 10_000;
/** Lets a FORFEIT frame leave the socket before the transport is torn down. */
const LEAVE_FLUSH_MS = 300;

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
  offs: (() => void)[];
}

/** A6 (2026-10-31): the witness facts a lobby refresh follows: the table's fingerprint and the VR sample. */
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
  let settings = readMatchSettings(readText(opts.file));
  let active: Active | null = null;
  let connecting = false;
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
  const mediaRig = (a: Pick<Active, 'rig' | 'runtime'>): { inVr: boolean; headsetPanel: boolean } => ({ inVr: a.rig === 'vr_headset', headsetPanel: headsetPanel(a) });
  const status = (): MatchStatus => {
    const a = active;
    const c: ControllerStatus | null = a ? a.controller.status() : null;
    const phase: MatchPhase = connecting ? 'connecting' : c ? c.phase : 'none';
    const r = a ? { rig: a.rig, rigReason: a.rigReason, runtime: a.runtime } : rigOf(idleRig());
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
      panel: c?.panel ?? null,
      media: a && opts.media ? opts.media.status() : null,
      vrOverlay: a ? ((a.overlay ?? overlayFor(a))?.status() ?? null) : null,
      rig: r.rig,
      rigReason: r.rigReason,
      vrRuntime: r.runtime,
      microphones: opts.media?.microphones?.() ?? [],
      micDeviceId: opts.mediaSettings?.get().micDeviceId ?? null,
      muted: opts.mediaSettings?.get().muted ?? false,
      locked,
      settings: { ...settings },
      defaultName: defaultName(),
      lastError,
    };
  };
  /**
   * D7.4 (2026-10-31): the headset follows the turn: hidden on this player's ball, theater while another is up, the
   * panel otherwise (`vrViewMode`, with the Match tab's two settings). Given to the overlay running now, once per change.
   */
  const syncVrMode = (a: Active): void => {
    const to = a.overlay;
    if (!to) return;
    const mode = vrViewMode(a.controller.panel(), settings);
    if (a.vrMode?.mode === mode && a.vrMode.to === to) return;
    a.vrMode = { mode, to };
    log.info(`match: headset mode ${mode}`);
    to.setMode(mode);
  };
  const emit = (): void => {
    if (active) syncVrMode(active);
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
  opts.vrLayer?.onStatus(() => {
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
    });
    controller.onChange(() => emit());
    return controller;
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

  /** §3 / coordinator 2026-10-30: the panel goes up at host / join, before the match starts, of the kind decided then. */
  const openPanel = async (a: Active): Promise<void> => {
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
  const announceLobby = (a: Active, rig: Rig, game: GameFingerprint): void => {
    const rigChanged = rig !== a.sent.rig;
    const gameChanged = JSON.stringify(game) !== JSON.stringify(a.sent.game);
    if (!rigChanged && !gameChanged) return;
    const u = { ...(rigChanged ? { rig } : {}), ...(gameChanged ? { game } : {}) };
    const done = a.engine instanceof HostMatch ? a.engine.updateLocal(u) : a.engine.updateParticipant(u);
    a.sent = { rig, game };
    if (!done) return;
    const what = [rigChanged ? `rig ${rig}` : null, gameChanged ? `table ${game.tableName} (${game.tableHash === ZERO_SHA256 ? 'no hash' : game.tableHash.slice(0, 12)})` : null].filter(Boolean).join(', ');
    log.info(`match: lobby update: ${what}; ${a.role === 'host' ? 'the players were told' : 'the host was told'}`);
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

  const host = (o: { port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus> =>
    guard(async () => {
      if (active) return fail(new Error('Leave the current match first'));
      lastError = null;
      const port = o.port === undefined ? settings.port : cleanPort(o.port);
      if (port === null) return fail(new Error('The port must be a number from 1024 to 65535'));
      const ballsPerGame = o.ballsPerGame === 5 ? 5 : 3;
      const name = cleanName(o.displayName) ?? defaultName();
      saveSettings(patchMatchSettings(settings, { port, ballsPerGame, displayName: name }));
      const me = playerId();
      const rig = await decide();
      const transport = new WsPeerTransport({ localId: me });
      try {
        await transport.listen(port, opts.listenAddress ?? '0.0.0.0');
      } catch (e) {
        transport.close();
        const code = (e as NodeJS.ErrnoException).code;
        return fail(new Error(code === 'EADDRINUSE' ? `Port ${port} is already in use on this PC: pick another port` : `Could not listen on port ${port}: ${describeError(e)}`));
      }
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
        offs: [],
      };
      a.offs.push(transport.onError((err, peer) => log.warn(`match: socket ${peer ?? '(new)'}: ${err.message}`)));
      active = a;
      const pub = await (opts.publicIp ?? ipifyPublicIp)().catch(() => null);
      const ip = pub ?? pickLanAddress(networkInterfaces()) ?? '127.0.0.1';
      a.ipSource = pub ? 'public' : 'lan';
      a.invite = formatInvite(ip, port, code);
      log.info(`match: hosting ${code} on ${transport.endpoint ?? `port ${port}`} (${ballsPerGame} balls); invite ${a.invite} (${a.ipSource} address)`);
      await openPanel(a);
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

  const leave = (): Promise<MatchStatus> =>
    guard(async () => {
      const a = active;
      if (!a) return status();
      a.controller.leave('left the match');
      await new Promise<void>((r) => setTimeout(r, LEAVE_FLUSH_MS));
      active = null;
      for (const off of a.offs) off();
      if (a.overlay) await a.overlay.stop().catch((e: unknown) => log.warn(`match: overlay stop: ${describeError(e)}`));
      const roles = new Set<{ close(): void }>([a.engine, a.controller.currentRole as HostMatch | ClientMatch]);
      await a.controller.close();
      for (const r of roles) r.close();
      a.transport.close();
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
    leave,
    setSettings(patch) {
      saveSettings(patchMatchSettings(settings, patch));
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
    setMuted(muted) {
      if (opts.media) opts.media.setMuted(muted);
      else opts.mediaSettings?.patch({ muted });
      active?.controller.refresh();
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
    async stop() {
      await leave().catch((e: unknown) => log.warn(`match: leave on quit: ${describeError(e)}`));
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
 * up", a chord for "match over". It plays on the default output, which in VR is the headset. A file page with node
 * integration, like `stream-host.ts`'s audio page; autoplay allowed so the first cue sounds without a click.
 */
function createCue(page: string, volume: () => number, log: Logger): { play(kind: CueKind): void; destroy(): void } {
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
  } catch (e) { ipcRenderer.send('${CUE_STATUS_CHANNEL}', { error: String(e) }); }
});
</script>`;
}
