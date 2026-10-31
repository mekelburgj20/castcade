/**
 * A6 + C3 in the shell (docs/design/alpha-match.md §1–§3, 2026-10-30): one match at a time, hosted or joined over
 * `WsPeerTransport`, invite by text (no ArcAid lobby yet, F6). Owns the match keys (`<userData>/match-keys.json`),
 * the match settings (`<userData>/match.json`), the turn lock file the hook reads, the audio cue (a hidden window
 * that synthesises three cues with WebAudio, like `stream-host.ts`'s audio page) and the `MatchController`, which it
 * feeds with the witness's detector events. `media` (D2) and `vrOverlay` (D7) are optional: the app runs without
 * them, and the lead wires the real ones. The panel goes up as soon as a player hosts or joins (coordinator
 * 2026-10-30), so the headset overlay can be checked before the match: the media layer is attached then with no
 * peers, and MATCH_READY adds them.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParticipantInfo, PayloadOf } from '@castcade/protocol';
import { ClientMatch } from '../match/client.js';
import { MatchController, type ControllerStatus, type CueKind } from '../match/controller.js';
import { HostMatch } from '../match/host.js';
import { WsPeerTransport } from '../match/transport-ws.js';
import type { MatchMedia, MediaSignalling, MediaStatus, PanelState, VrOverlay, VrOverlayStatus } from '../media/match-media-types.js';
import { RECIPE_VERSION } from '../patcher/render.js';
import type { Logger } from './log.js';
import { describeError } from './log.js';
import {
  adoptHostFingerprint,
  cleanName,
  cleanPort,
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
  serializeMatchIdentity,
  writeMatchSettings,
  type MatchIdentity,
  type MatchSettings,
} from './match-setup.js';
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
  participants: Array<{ id: string; name: string; rig: ParticipantInfo['rig']; tableMatch: boolean | null }>;
  panel: PanelState | null;
  media: MediaStatus | null;
  vrOverlay: VrOverlayStatus | null;
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
  media?: MatchMedia;
  vrOverlay?: VrOverlay;
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
  overlayStarted: boolean;
  offs: (() => void)[];
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
  const status = (): MatchStatus => {
    const a = active;
    const c: ControllerStatus | null = a ? a.controller.status() : null;
    const phase: MatchPhase = connecting ? 'connecting' : c ? c.phase : 'none';
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
      participants: (c?.participants ?? []).map((p) => ({
        id: p.playerId,
        name: p.displayName,
        rig: p.rig,
        tableMatch: c ? !c.tableMismatch.includes(p.playerId) : null,
      })),
      panel: c?.panel ?? null,
      media: a && opts.media ? opts.media.status() : null,
      vrOverlay: a && opts.vrOverlay ? opts.vrOverlay.status() : null,
      locked,
      settings: { ...settings },
      defaultName: defaultName(),
      lastError,
    };
  };
  const emit = (): void => {
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
  witness.onEvent((ev) => active?.controller.feed(ev));
  // The VR observation is sampled when a table opens: a player who hosted before opening it gets the overlay then.
  witness.onStatus((s) => {
    if (active && !active.overlayStarted && opts.vrOverlay && opts.media?.frames() && rigFrom(s) === 'vr_headset') void startOverlay(active);
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

  const startOverlay = async (a: Active): Promise<void> => {
    const { media, vrOverlay } = opts;
    const frames = media?.frames() ?? null;
    if (!vrOverlay || !frames) {
      if (rigFrom(witness.status()) === 'vr_headset') log.info(`match: in VR but ${vrOverlay ? 'the panel has no frames yet' : 'no overlay helper'}; showing the desktop panel`);
      media?.showPanel();
      return;
    }
    a.overlayStarted = true;
    try {
      const st = await vrOverlay.start(frames);
      log.info(`match: VR overlay ${st.state}${st.reason ? ` (${st.reason})` : ''}`);
    } catch (e) {
      log.warn(`match: the VR overlay did not start: ${describeError(e)}`);
    }
    emit();
  };

  /** §3 / coordinator 2026-10-30: the panel goes up at host / join, before the match starts. */
  const openPanel = async (a: Active): Promise<void> => {
    await a.controller.open();
    if (rigFrom(witness.status()) === 'vr_headset') await startOverlay(a);
    else opts.media?.showPanel();
  };

  const participant = (id: string, name: string): ParticipantInfo => ({
    playerId: id,
    displayName: name,
    publicKey: matchIdentity().keys.publicKeyB64,
    rig: rigFrom(witness.status()),
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
      const transport = new WsPeerTransport({ localId: me });
      try {
        await transport.listen(port, opts.listenAddress ?? '0.0.0.0');
      } catch (e) {
        transport.close();
        const code = (e as NodeJS.ErrnoException).code;
        return fail(new Error(code === 'EADDRINUSE' ? `Port ${port} is already in use on this PC: pick another port` : `Could not listen on port ${port}: ${describeError(e)}`));
      }
      const code = newMatchCode();
      const engine = new HostMatch({
        transport,
        keys: matchIdentity().keys,
        matchId: code,
        ballsPerGame,
        hostParticipant: participant(me, name),
        hostGame: gameFingerprintFrom(witness.status(), RECIPE_VERSION),
        companionVersion: opts.appVersion.slice(0, 32),
      });
      const controller = makeController(engine, ballsPerGame);
      const a: Active = { role: 'host', transport, engine, controller, code, port, invite: null, ipSource: null, overlayStarted: false, offs: [] };
      a.offs.push(transport.onError((err, peer) => log.warn(`match: socket ${peer ?? '(new)'}: ${err.message}`)));
      active = a;
      const pub = await (opts.publicIp ?? ipifyPublicIp)().catch(() => null);
      const ip = pub ?? pickLanAddress(networkInterfaces()) ?? '127.0.0.1';
      a.ipSource = pub ? 'public' : 'lan';
      a.invite = formatInvite(ip, port, code);
      log.info(`match: hosting ${code} on ${transport.endpoint ?? `port ${port}`} (${ballsPerGame} balls); invite ${a.invite} (${a.ipSource} address)`);
      await openPanel(a);
      emit();
      return status();
    });

  type JoinOutcome = { kind: 'joined'; transport: WsPeerTransport; engine: ClientMatch; controller: MatchController } | { kind: 'refused'; refuse: PayloadOf<'REFUSE'> };

  const tryJoin = async (url: string, code: string, me: string, name: string, game: ReturnType<typeof gameFingerprintFrom>): Promise<JoinOutcome> => {
    const transport = new WsPeerTransport({ localId: me });
    const engine = new ClientMatch({ transport, keys: matchIdentity().keys, participant: participant(me, name), game, throwdownCode: code, companionVersion: opts.appVersion.slice(0, 32) });
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
        const own = gameFingerprintFrom(witness.status(), RECIPE_VERSION);
        let out = await tryJoin(parsed.url, parsed.code, me, name, own);
        let adoptedFields: string[] | null = null;
        if (out.kind === 'refused' && out.refuse.code === 'fingerprint_mismatch') {
          const adopted = adoptHostFingerprint(own, out.refuse.mismatches);
          if (adopted) {
            adoptedFields = adopted.fields;
            log.warn(`match: the host's table differs (${adopted.fields.join(', ')}); joining anyway, flagged on both panels`);
            out = await tryJoin(parsed.url, parsed.code, me, name, adopted.game);
          }
        }
        if (out.kind === 'refused') throw new Error(`The host refused: ${out.refuse.message}`);
        if (adoptedFields) out.controller.noteTableMismatch(me, adoptedFields);
        const a: Active = { role: 'client', transport: out.transport, engine: out.engine, controller: out.controller, code: parsed.code, port: parsed.port, invite: null, ipSource: null, overlayStarted: false, offs: [] };
        a.offs.push(out.transport.onError((err) => log.warn(`match: socket: ${err.message}`)));
        active = a;
        connecting = false;
        log.info(`match: joined ${parsed.code} at ${parsed.url}`);
        await openPanel(a);
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
      if (a.overlayStarted) await opts.vrOverlay?.stop().catch((e: unknown) => log.warn(`match: overlay stop: ${describeError(e)}`));
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
