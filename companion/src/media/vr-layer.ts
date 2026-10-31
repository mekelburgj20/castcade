/**
 * The in-headset panel on OpenXR rigs (D7.3, 2026-10-31; vr-layer/README.md): the Castcade OpenXR API layer runs
 * inside VPX and draws the frames it reads from `\\.\pipe\castcade-panel`. This side registers the layer for the
 * current user and feeds the pipe. Same `VrOverlay` contract as the SteamVR helper (`vr-overlay.ts`); the match host
 * picks this one when VPX's runtime is not SteamVR (Virtual Desktop, Oculus, another OpenXR runtime).
 *
 * Rules:
 *   - `start` registers the manifest under `HKCU\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit` (value = the json's
 *     absolute path, REG_DWORD 0; `reg.exe add … /f`, idempotent), drops other registrations of the same json file name
 *     (a dev build, an older install folder: two copies would both load), and leaves a registration the player set to
 *     1 (disabled) alone: `unavailable layer_disabled`. No json shipped → `unavailable layer_missing`;
 *   - the loader reads the layer list when VPX starts VR, so a VPX started before the first registration has no layer
 *     until it is restarted. The pipe is tried every `CONNECT_RETRY_MS`; no answer within `RESTART_VPX_AFTER_MS` while
 *     VPX runs → `starting restart_vpx` (the Match tab says to restart VPX); trying goes on;
 *   - connected → `showing`; the pipe closes (VPX exited, or left VR) → `hidden pipe_closed`, and trying again;
 *   - frames: `panel-frame-writer.ts`, the bytes the SteamVR helper's stdin takes (drop-when-behind, keepalive);
 *   - D7.4 (2026-10-31), pipe protocol 2: the layer says hello (`CVH1` + its protocol) when the pipe connects. Only then
 *     do the control (`CVC1`: mode, stereo, panel position) and the video frames (`CVO2`) go out: a 0.2.26 layer drops
 *     the pipe on any other magic. Its mode is set by `setMode` (the match host, from the turn); video frames are
 *     wanted from the panel page only while the mode is theater and a protocol-2 layer listens; their `stereo` goes
 *     into the control when it changes;
 *   - `stop` closes the pipe. The registry entry stays: without a client the layer draws nothing.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join, resolve } from 'node:path';
import { VR_LAYER_VIDEO_MAGIC, type PanelFrameSource, type VideoFrameSource, type VrOverlay, type VrOverlayStatus, type VrStereo, type VrViewMode } from './match-media-types.js';
import { controlMessage, createPanelFrameWriter, type FrameStream } from './panel-frame-writer.js';
import type { VrOverlayPathInput } from './vr-overlay.js';

export const VR_LAYER_JSON = 'XrApiLayer_castcade_panel.json';
export const VR_LAYER_PIPE = '\\\\.\\pipe\\castcade-panel';
export const OPENXR_IMPLICIT_LAYERS_KEY = 'HKCU\\SOFTWARE\\Khronos\\OpenXR\\1\\ApiLayers\\Implicit';
export const CONNECT_RETRY_MS = 2000;
export const RESTART_VPX_AFTER_MS = 20_000;
/** D7.4: the pipe protocol this side speaks (vr-layer/src/panel_pipe.h kPipeProtocol); a layer without a hello is 1. */
export const VR_LAYER_PROTOCOL = 2;
export const VR_LAYER_HELLO_MAGIC = 'CVH1';
/** D7.4: the panel's place in panel mode: below the playfield's line of sight (the layer's "center" is the D7.3 one). */
export const VR_LAYER_PANEL_POS = 'low';

/** The layer's protocol from its hello (8 bytes: "CVH1", u32 version), or null while fewer than 8 bytes are in or it is not one. */
export function parseHello(b: Buffer): number | null {
  if (b.length < 8 || b.toString('latin1', 0, 4) !== VR_LAYER_HELLO_MAGIC) return null;
  return b.readUInt32LE(4);
}

/**
 * Where the layer's manifest is: packaged, `resources/vr-layer/` (fetch-vr-layer.mjs, shipped by electron-builder.yml);
 * dev, a local CMake build (`vr-layer/build/Release/`) first, else a fetched copy in `companion/resources/vr-layer/`.
 * Null when none exists (the overlay then reports `unavailable layer_missing`). The dll sits beside the json.
 */
export function resolveVrLayer(i: VrOverlayPathInput, exists: (p: string) => boolean = existsSync): string | null {
  const candidates = i.packaged
    ? [join(i.resourcesPath, 'vr-layer', VR_LAYER_JSON)]
    : [resolve(i.companionDir, '..', 'vr-layer', 'build', 'Release', VR_LAYER_JSON), resolve(i.companionDir, 'resources', 'vr-layer', VR_LAYER_JSON)];
  return candidates.find((p) => exists(p)) ?? null;
}

/** `reg.exe` arguments that register (or re-enable) the layer for the current user. */
export function registerArgs(jsonPath: string): string[] {
  return ['add', OPENXR_IMPLICIT_LAYERS_KEY, '/v', jsonPath, '/t', 'REG_DWORD', '/d', '0', '/f'];
}

export function queryArgs(): string[] {
  return ['query', OPENXR_IMPLICIT_LAYERS_KEY];
}

export function deleteArgs(valueName: string): string[] {
  return ['delete', OPENXR_IMPLICIT_LAYERS_KEY, '/v', valueName, '/f'];
}

export interface RegisteredLayer {
  /** The value name: a manifest's path. */
  name: string;
  /** The DWORD (0 = enabled), or null when the value is not a DWORD. */
  value: number | null;
}

/** The values of `reg query <key>` (four-space separated: name, type, data). Value names may contain spaces. */
export function parseRegQuery(stdout: string): RegisteredLayer[] {
  const out: RegisteredLayer[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*?)\s*$/.exec(line);
    if (!m) continue;
    const data = m[3]!.trim();
    out.push({ name: m[1]!, value: m[2] === 'REG_DWORD' && /^0x[0-9a-f]+$/i.test(data) ? Number.parseInt(data, 16) : null });
  }
  return out;
}

const sameFile = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const isOurJson = (name: string): boolean => name.toLowerCase().endsWith(`\\${VR_LAYER_JSON.toLowerCase()}`) || sameFile(name, VR_LAYER_JSON);

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execReg: Exec = (file, args) =>
  new Promise((done, fail) => {
    execFile(file, args, { windowsHide: true }, (err, stdout) => (err ? fail(err) : done({ stdout: String(stdout) })));
  });

/** What the overlay needs of a pipe connection; a `net.Socket` fits. */
export interface PipeSocket extends FrameStream {
  on(event: 'connect' | 'close' | 'drain', cb: () => void): unknown;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'error', cb: (e: NodeJS.ErrnoException) => void): unknown;
  destroy(): void;
}

export interface VrLayerOverlayOptions {
  /** From `resolveVrLayer`; null → `unavailable layer_missing`. */
  jsonPath: string | null;
  log: (line: string) => void;
  /** Whether VPX runs now (the witness); `restart_vpx` is only said while it does. Default: always. */
  vpxRunning?: () => boolean;
  /** Test seams. */
  exec?: Exec;
  connect?: (path: string) => PipeSocket;
  now?: () => number;
  pipePath?: string;
}

export function createVrLayerOverlay(opts: VrLayerOverlayOptions): VrOverlay {
  const exec = opts.exec ?? execReg;
  const connect = opts.connect ?? ((p: string) => netConnect(p) as unknown as PipeSocket);
  const now = opts.now ?? Date.now;
  const vpxRunning = opts.vpxRunning ?? (() => true);
  const pipePath = opts.pipePath ?? VR_LAYER_PIPE;
  const listeners = new Set<(s: VrOverlayStatus) => void>();
  const writer = createPanelFrameWriter({ log: opts.log, tag: 'vr-layer' });
  const videoWriter = createPanelFrameWriter({ log: opts.log, tag: 'vr-layer video', magic: VR_LAYER_VIDEO_MAGIC });
  let video: VideoFrameSource | null = null;
  let unsubscribeVideo: (() => void) | null = null;
  /** D7.4: what the match host asked for; the layer's own default (before any control) is the panel too. */
  let mode: VrViewMode = 'panel';
  let stereo: VrStereo = 'mono';
  /** The connected layer's protocol: 1 until its hello says more. */
  let protocol = 1;
  let lastControl: string | null = null;
  let oldLayerLogged = false;
  let current: VrOverlayStatus = { state: 'stopped', reason: null };
  let unsubscribe: (() => void) | null = null;
  let socket: PipeSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let startedAt = 0;
  let everConnected = false;
  let registerFailed = false;
  let waitLogged = false;
  let registeredLogged = false;

  const set = (state: VrOverlayStatus['state'], reason: string | null = null) => {
    if (current.state === state && current.reason === reason) return;
    current = { state, reason };
    for (const l of [...listeners]) l(current);
  };

  /** 'ok', 'disabled' (the player set our value to 1) or 'failed'; never throws. */
  const register = async (jsonPath: string): Promise<'ok' | 'disabled' | 'failed'> => {
    try {
      // `reg query` exits 1 when the key does not exist yet: nothing registered, nothing stale.
      const existing = parseRegQuery((await exec('reg.exe', queryArgs()).catch(() => ({ stdout: '' }))).stdout);
      const mine = existing.find((v) => sameFile(v.name, jsonPath));
      if (mine && mine.value !== null && mine.value !== 0) {
        opts.log(`vr-layer: ${jsonPath} is disabled under ${OPENXR_IMPLICIT_LAYERS_KEY} (value ${mine.value}); left as the player set it`);
        return 'disabled';
      }
      for (const stale of existing.filter((v) => isOurJson(v.name) && !sameFile(v.name, jsonPath))) {
        await exec('reg.exe', deleteArgs(stale.name));
        opts.log(`vr-layer: removed an older registration ${stale.name}`);
      }
      await exec('reg.exe', registerArgs(jsonPath));
      if (!registeredLogged) {
        registeredLogged = true;
        opts.log(`vr-layer: ${mine ? 'registered' : 'registered now'} ${jsonPath} under ${OPENXR_IMPLICIT_LAYERS_KEY}${mine ? '' : ' (a VPX already running loads it only after a restart)'}`);
      }
      return 'ok';
    } catch (e) {
      opts.log(`vr-layer: could not register the layer (${(e as Error).message}); the panel can show only if it was registered before`);
      return 'failed';
    }
  };

  /** No answer yet: after 20 s while VPX runs, the layer is not in that VPX (or not registered). */
  const noAnswer = () => {
    if (everConnected) return;
    if (!vpxRunning()) {
      if (current.state === 'starting' && current.reason) set('starting');
      return;
    }
    if (now() - startedAt < RESTART_VPX_AFTER_MS) return;
    const reason = registerFailed ? 'register_failed' : 'restart_vpx';
    if (current.reason !== reason) {
      opts.log(
        reason === 'restart_vpx'
          ? `vr-layer: no answer on ${pipePath} after ${RESTART_VPX_AFTER_MS / 1000} s while VPX runs; VPX was started before the layer was registered (or ignores it), restart VPX`
          : `vr-layer: no answer on ${pipePath}, and the layer could not be registered`,
      );
    }
    set('starting', reason);
  };

  /** The control, when a protocol-2 layer listens and it changed since the last one on this connection. */
  const sendControl = () => {
    const sock = socket;
    if (!sock || protocol < 2 || !sock.writable) return;
    const body = { mode, stereo, panelPos: VR_LAYER_PANEL_POS };
    const text = JSON.stringify(body);
    if (text === lastControl) return;
    lastControl = text;
    sock.write(controlMessage(body));
    opts.log(`vr-layer: mode ${mode} (${stereo}${mode === 'panel' ? `, panel ${VR_LAYER_PANEL_POS}` : ''})`);
  };

  /** Video frames flow from the panel page only in theater with a protocol-2 layer on the pipe: each one is a copy. */
  const updateVideo = () => {
    const on = mode === 'theater' && protocol >= 2 && socket !== null && current.state === 'showing';
    video?.setWanted(on);
    if (on) videoWriter.attach(socket);
    else videoWriter.clear();
  };

  const tryConnect = () => {
    retryTimer = null;
    if (stopping) return;
    let sock: PipeSocket;
    try {
      sock = connect(pipePath);
    } catch (e) {
      opts.log(`vr-layer: could not open ${pipePath}: ${(e as Error).message}`);
      retryTimer = setTimeout(tryConnect, CONNECT_RETRY_MS);
      return;
    }
    socket = sock;
    let connected = false;
    let hello = Buffer.alloc(0);
    sock.on('connect', () => {
      if (socket !== sock) return;
      connected = true;
      everConnected = true;
      protocol = 1;
      lastControl = null;
      opts.log(`vr-layer: connected to the layer in VPX (${pipePath})`);
      set('showing');
      writer.attach(sock);
    });
    sock.on('data', (chunk) => {
      if (socket !== sock || protocol >= 2 || hello.length >= 8) return;
      hello = Buffer.concat([hello, chunk]);
      if (hello.length < 8) return;
      const v = parseHello(hello);
      if (v === null) {
        opts.log('vr-layer: the layer sent something that is not a hello; staying on protocol 1 (the panel only)');
        return;
      }
      protocol = v;
      opts.log(`vr-layer: the layer speaks pipe protocol ${v}${v >= 2 ? ' (modes, theater)' : ''}`);
      sendControl();
      updateVideo();
    });
    sock.on('error', (e) => {
      if (connected) opts.log(`vr-layer: pipe error: ${e.message}`);
      else if (!waitLogged) {
        waitLogged = true;
        opts.log(`vr-layer: waiting for VPX's layer on ${pipePath} (${e.code ?? e.message}); trying every ${CONNECT_RETRY_MS / 1000} s`);
      }
    });
    sock.on('close', () => {
      if (socket !== sock) return;
      socket = null;
      writer.attach(null);
      protocol = 1;
      lastControl = null;
      updateVideo();
      if (stopping) return;
      if (connected) {
        opts.log('vr-layer: the layer closed the pipe (VPX exited or left VR); trying again');
        set('hidden', 'pipe_closed');
      } else noAnswer();
      retryTimer = setTimeout(tryConnect, CONNECT_RETRY_MS);
    });
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    unsubscribe?.();
    unsubscribe = null;
    writer.clear();
    video?.setWanted(false);
    unsubscribeVideo?.();
    unsubscribeVideo = null;
    video = null;
    videoWriter.clear();
    const s = socket;
    socket = null;
    s?.destroy();
    set('stopped');
  };

  return {
    async start(source: PanelFrameSource, videoSource?: VideoFrameSource | null): Promise<VrOverlayStatus> {
      if (socket || retryTimer || unsubscribe) await stop();
      if (!opts.jsonPath) {
        set('unavailable', 'layer_missing');
        return current;
      }
      stopping = false;
      everConnected = false;
      registerFailed = false;
      waitLogged = false;
      startedAt = now();
      writer.clear();
      unsubscribe = source.onFrame((f) => writer.push(f));
      video = videoSource ?? null;
      unsubscribeVideo =
        video?.onFrame((f) => {
          if (f.stereo !== stereo) {
            stereo = f.stereo;
            sendControl();
          }
          if (mode === 'theater' && protocol >= 2) videoWriter.push(f);
        }) ?? null;
      set('starting');
      const reg = await register(opts.jsonPath);
      if (stopping) return current; // stop() while registering
      if (reg === 'disabled') {
        unsubscribe();
        unsubscribe = null;
        unsubscribeVideo?.();
        unsubscribeVideo = null;
        video = null;
        set('unavailable', 'layer_disabled');
        return current;
      }
      registerFailed = reg === 'failed';
      tryConnect();
      return current;
    },

    stop,

    setMode(next) {
      if (next === mode) return;
      mode = next;
      if (socket && current.state === 'showing' && protocol < 2 && next !== 'panel' && !oldLayerLogged) {
        oldLayerLogged = true;
        opts.log(`vr-layer: mode ${next} asked, but the layer in VPX predates pipe protocol 2 (Castcade 0.2.26): it shows the panel only until VPX restarts with the new layer`);
      }
      sendControl();
      updateVideo();
    },

    status: () => current,

    onStatus(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}
