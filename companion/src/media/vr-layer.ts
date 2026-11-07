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
 *   - `stop` closes the pipe. The registry entry stays: without a client the layer draws nothing;
 *   - D7.3.3 (2026-11-02): packaged, the json registered is the per-version copy under `%LOCALAPPDATA%\Castcade\vr-layer\`
 *     (`vr-layer-stage.ts`), and the companion registers it at start too (`registerVrLayer`), not only here. `layerAge`
 *     says when the VPX running started before that registration: the status then carries `vpxBeforeLayer`;
 *   - D7.5 (2026-11-02), pipe protocol 3, the layer camera (vr-layer/README.md "The camera"; `layer-camera.ts` is the
 *     policy): `setCamera` puts a `camera` field on the control (only to a protocol-3 layer; a protocol-2 control is
 *     byte for byte what it was); the layer's answers come back on the same pipe as messages shaped magic + u32
 *     length + payload (`createLayerReader` cuts them out of the byte stream, whatever the chunking, and resyncs on
 *     garbage): `CVS1` status (on / off / refused, `cameraStatus`) and `CVF1` frames (`onCameraFrame`: both eyes as
 *     JPEG with their fov and crop; D8.1, 2026-11-05: or the one eye the request's `eye` asked for, from layer 0.5.3
 *     on). Counters go to the log every 10 s while the camera is asked, like the capture's;
 *   - D7.6.2 (2026-11-03), the session report: a `CVS1` whose JSON has `"kind": "session"` is the layer's report on
 *     the runtime, the system and VPX's frames (it sends one after every connection and on request); `requestSession`
 *     asks for a fresh one with `report: true` on a control (a request, so it never enters the dedup of controls);
 *     `probeLayerSession` reads one over a short connection of its own when no match holds the pipe. `bench` is what
 *     the test bench shows: connected, protocol, the last report and the last `BENCH_CONTROLS` controls sent;
 *   - D7.5.9 / D7.5.10 / D7.5.11 (2026-11-04), still protocol 3 (all additive): the camera request's `whole` asks for
 *     each eye's whole render; `setWindowTune` puts `tune` (depth in metres, a vertical offset per eye) and
 *     `setSoftEdge` puts `feather` on the control, each only when not the layer's default. The owner's 0.2.34
 *     finding: the window fused but its frame doubled at the edges (the frames sat at infinity while the eyes
 *     converged on the table); the whole view puts the frame at the lens edges, the feather hides what is left, and
 *     the tuning gives live sliders for the geometry reports.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join, resolve } from 'node:path';
import {
  VR_LAYER_CAMERA_FRAME_MAGIC,
  VR_LAYER_CAMERA_STATUS_MAGIC,
  VR_LAYER_VIDEO_MAGIC,
  type LayerCameraEye,
  type LayerCameraEyeGeometry,
  type LayerCameraFrame,
  type LayerCameraRequest,
  type LayerCameraStatus,
  type LayerSessionReport,
  type PanelFrameSource,
  type VideoFrameSource,
  type VrLayerBench,
  type VrOverlay,
  type VrTestPattern,
  type VrOverlayStatus,
  type VrStereo,
  type VrViewMode,
  type VrWindowTune,
} from './match-media-types.js';
import { cameraEyesWords } from './layer-camera.js';
import { controlMessage, createPanelFrameWriter, type FrameStream } from './panel-frame-writer.js';
import type { VrOverlayPathInput } from './vr-overlay.js';
import type { LayerAge } from './vr-layer-stage.js';

export const VR_LAYER_JSON = 'XrApiLayer_castcade_panel.json';
export const VR_LAYER_PIPE = '\\\\.\\pipe\\castcade-panel';
export const OPENXR_IMPLICIT_LAYERS_KEY = 'HKCU\\SOFTWARE\\Khronos\\OpenXR\\1\\ApiLayers\\Implicit';
export const CONNECT_RETRY_MS = 2000;
export const RESTART_VPX_AFTER_MS = 20_000;
/**
 * The pipe protocol this side speaks (vr-layer/src/panel_pipe.h kPipeProtocol); a layer without a hello is 1. D7.4: 2
 * (modes, theater). D7.5: 3 (the camera: the control's `camera`, the layer's CVF1 / CVS1).
 */
export const VR_LAYER_PROTOCOL = 3;
/** D7.5: the first protocol with the camera. */
export const VR_LAYER_CAMERA_PROTOCOL = 3;
export const VR_LAYER_HELLO_MAGIC = 'CVH1';
/** D7.4: the panel's place in panel mode: below the playfield's line of sight (the layer's "center" is the D7.3 one). */
export const VR_LAYER_PANEL_POS = 'low';
/** D7.5: the largest CVF1 the reader accepts (two JPEG eyes of a few hundred KB each; the layer refuses larger first). */
export const CAMERA_FRAME_MAX_BYTES = 32 * 1024 * 1024;
/** D7.5: the largest other layer → companion message (a CVS1 is about 100 bytes). */
export const LAYER_MESSAGE_MAX_BYTES = 64 * 1024;
/** D7.5: the camera counters, like the capture's. */
export const CAMERA_COUNTERS_MS = 10_000;
/** D7.6.2: how many of the last controls `bench().controls` keeps. */
export const BENCH_CONTROLS = 5;

/** The layer's protocol from its hello (8 bytes: "CVH1", u32 version), or null while fewer than 8 bytes are in or it is not one. */
export function parseHello(b: Buffer): number | null {
  if (b.length < 8 || b.toString('latin1', 0, 4) !== VR_LAYER_HELLO_MAGIC) return null;
  return b.readUInt32LE(4);
}

// ---- D7.5: the layer's messages ------------------------------------------------------------------------------------

/** D7.5: what the layer says about its camera (CVS1). */
export interface LayerCameraStatusMessage {
  camera: 'on' | 'off' | 'refused';
  why: string;
  api?: string;
  source?: [number, number];
  size?: [number, number];
  fps?: number;
}

export type LayerMessage =
  | { kind: 'hello'; protocol: number }
  | { kind: 'frame'; frame: LayerCameraFrame }
  | { kind: 'status'; status: LayerCameraStatusMessage }
  /** D7.6.2: the layer's session report (a CVS1 with `"kind": "session"`), its facts without `kind`. */
  | { kind: 'session'; facts: Record<string, unknown> }
  /** A well-shaped message this companion does not know (a newer layer): skipped whole. */
  | { kind: 'unknown'; magic: string; length: number }
  /** A known magic whose payload did not parse: skipped whole. */
  | { kind: 'bad'; magic: string; reason: string }
  /** Bytes that were no message at all, dropped one by one until a magic was found again. */
  | { kind: 'garbage'; bytes: number };

const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const isNums = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * D7.5: a CVF1 payload (vr-layer/README.md "The camera"): u16 jsonLength, the JSON header, the eyes' JPEG bytes back to
 * back. Null when it does not parse (a length that does not add up, a header with no eye or more than two). The eyes'
 * `data` are views into `body` (no copy): the caller hands over the buffer. D8.1 (2026-11-05): one eye is a frame too
 * (a layer honouring the request's `eye` sends only that one).
 */
export function parseCameraFrame(body: Buffer): LayerCameraFrame | null {
  if (body.length < 2) return null;
  const jsonLen = body.readUInt16LE(0);
  if (2 + jsonLen > body.length) return null;
  let h: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8', 2, 2 + jsonLen));
    if (typeof parsed !== 'object' || parsed === null) return null;
    h = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (h.enc !== 'jpeg' || !isInt(h.n) || !isInt(h.t) || !isInt(h.w, 1) || !isInt(h.h, 1) || !Array.isArray(h.eyes) || h.eyes.length < 1 || h.eyes.length > 2) return null;
  const eyes: LayerCameraEye[] = [];
  let at = 2 + jsonLen;
  for (const raw of h.eyes as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return null;
    const e = raw as Record<string, unknown>;
    if (!isNums(e.fov, 4) || !isNums(e.rect, 4) || !isNums(e.render, 2) || !isInt(e.len, 1)) return null;
    if (at + e.len > body.length) return null;
    eyes.push({
      fov: [e.fov[0]!, e.fov[1]!, e.fov[2]!, e.fov[3]!],
      rect: [e.rect[0]!, e.rect[1]!, e.rect[2]!, e.rect[3]!],
      render: [e.render[0]!, e.render[1]!],
      data: body.subarray(at, at + e.len),
    });
    at += e.len;
  }
  if (at !== body.length) return null;
  const us = h.us;
  const timings =
    typeof us === 'object' && us !== null && ['issue', 'map', 'copy', 'enc'].every((k) => isInt((us as Record<string, unknown>)[k]))
      ? { issue: (us as Record<string, number>).issue!, map: (us as Record<string, number>).map!, copy: (us as Record<string, number>).copy!, enc: (us as Record<string, number>).enc! }
      : null;
  return { n: h.n, t: h.t, encoding: 'jpeg', width: h.w, height: h.h, eyes, us: timings };
}

function parseCameraStatus(body: Buffer): LayerCameraStatusMessage | null {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    if (s.camera !== 'on' && s.camera !== 'off' && s.camera !== 'refused') return null;
    const out: LayerCameraStatusMessage = { camera: s.camera, why: typeof s.why === 'string' ? s.why : '' };
    if (typeof s.api === 'string') out.api = s.api;
    if (isNums(s.source, 2)) out.source = [s.source[0]!, s.source[1]!];
    if (isNums(s.size, 2)) out.size = [s.size[0]!, s.size[1]!];
    if (isInt(s.fps)) out.fps = s.fps;
    return out;
  } catch {
    return null;
  }
}

/**
 * D7.6.2: a CVS1 payload that is a session report (`{"kind": "session", ...}`): its facts without `kind`, or null (a
 * camera status, or not a JSON object).
 */
export function parseSessionReport(body: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { kind, ...facts } = parsed as Record<string, unknown>;
    return kind === 'session' ? facts : null;
  } catch {
    return null;
  }
}

export interface LayerReader {
  /** The messages completed by this chunk, in order. */
  push(chunk: Buffer): LayerMessage[];
}

/**
 * D7.5: cuts the layer's messages out of the pipe's byte stream (a `net.Socket` splits and joins writes as it likes).
 * Every message is magic + u32 length + payload, except the hello (magic + u32 protocol, no payload). A 4-byte magic
 * of the form `CV??` with a length inside the limits is a message (known or not); anything else is garbage, dropped a
 * byte at a time until a magic lines up again (a frame written across a reconnect, a stream out of step).
 */
export function createLayerReader(): LayerReader {
  let head: Buffer = Buffer.alloc(0);
  let body: { buf: Buffer; filled: number; magic: string } | null = null;
  let garbage = 0;
  const decode = (magic: string, buf: Buffer): LayerMessage => {
    if (magic === VR_LAYER_CAMERA_FRAME_MAGIC) {
      const frame = parseCameraFrame(buf);
      return frame ? { kind: 'frame', frame } : { kind: 'bad', magic, reason: 'the frame header or its lengths do not parse' };
    }
    if (magic === VR_LAYER_CAMERA_STATUS_MAGIC) {
      const facts = parseSessionReport(buf);
      if (facts) return { kind: 'session', facts };
      const status = parseCameraStatus(buf);
      return status ? { kind: 'status', status } : { kind: 'bad', magic, reason: 'the status is not JSON with a camera state' };
    }
    return { kind: 'unknown', magic, length: buf.length };
  };
  return {
    push(chunk) {
      const out: LayerMessage[] = [];
      const flushGarbage = () => {
        if (garbage > 0) out.push({ kind: 'garbage', bytes: garbage });
        garbage = 0;
      };
      let at = 0;
      while (at < chunk.length) {
        if (body) {
          const take = Math.min(body.buf.length - body.filled, chunk.length - at);
          chunk.copy(body.buf, body.filled, at, at + take);
          body.filled += take;
          at += take;
          if (body.filled === body.buf.length) {
            out.push(decode(body.magic, body.buf));
            body = null;
          }
          continue;
        }
        const take = Math.min(8 - head.length, chunk.length - at);
        head = head.length === 0 ? chunk.subarray(at, at + take) : Buffer.concat([head, chunk.subarray(at, at + take)]);
        at += take;
        if (head.length < 8) break;
        const magic = head.toString('latin1', 0, 4);
        const len = head.readUInt32LE(4);
        if (magic === VR_LAYER_HELLO_MAGIC) {
          flushGarbage();
          out.push({ kind: 'hello', protocol: len });
          head = Buffer.alloc(0);
          continue;
        }
        const max = magic === VR_LAYER_CAMERA_FRAME_MAGIC ? CAMERA_FRAME_MAX_BYTES : LAYER_MESSAGE_MAX_BYTES;
        if (!/^CV[A-Z0-9]{2}$/.test(magic) || len > max) {
          // Not a message: one byte gone, the header window slides on.
          garbage++;
          head = Buffer.from(head.subarray(1));
          continue;
        }
        flushGarbage();
        head = Buffer.alloc(0);
        if (len === 0) {
          out.push(decode(magic, Buffer.alloc(0)));
          continue;
        }
        body = { buf: Buffer.allocUnsafe(len), filled: 0, magic };
      }
      return out;
    },
  };
}

// D8.1: `eye` is part of the request (one eye asked or both), so a change of it reaches the layer.
const sameRequest = (a: LayerCameraRequest | null, b: LayerCameraRequest | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.width === b.width && a.height === b.height && a.fps === b.fps && (a.whole === true) === (b.whole === true) && (a.eye ?? null) === (b.eye ?? null) && (a.ring ?? null) === (b.ring ?? null));

/**
 * D7.5.10 / D7.5.11 (2026-11-04): the stereo window's tuning as the control carries it: `tune` only when a value is not
 * the layer's default (infinity, no offset), `feather` only when above 0, both to a protocol-3 layer only, so every
 * other control is byte for byte as before. The layer clamps (0.3–100 m, ±10°, 0–0.25); this side rounds.
 */
export const VR_LAYER_TUNE_DEFAULT: VrWindowTune = { depthM: null, dyDeg: [0, 0] };
const cleanTune = (t: VrWindowTune): VrWindowTune => {
  const depthM = typeof t.depthM === 'number' && Number.isFinite(t.depthM) && t.depthM > 0 ? Math.round(Math.min(100, Math.max(0.3, t.depthM)) * 100) / 100 : null;
  const dy = (v: number): number => (Number.isFinite(v) ? Math.round(Math.min(10, Math.max(-10, v)) * 10) / 10 + 0 : 0);
  return { depthM, dyDeg: [dy(t.dyDeg?.[0] ?? 0), dy(t.dyDeg?.[1] ?? 0)] };
};
const tuneIsDefault = (t: VrWindowTune): boolean => t.depthM === null && t.dyDeg[0] === 0 && t.dyDeg[1] === 0;
const cleanFeather = (f: number): number => (Number.isFinite(f) ? Math.round(Math.min(0.25, Math.max(0, f)) * 1000) / 1000 : 0);
const signed = (v: number): string => `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(1)}`;
/** The tuning in words for the control's log line: ", window depth 2.6 m, vertical offset L +0.5 R -0.5 deg, soft edge 3%". */
export function tuneWords(t: VrWindowTune, feather: number): string {
  const parts: string[] = [];
  if (t.depthM !== null) parts.push(`window depth ${t.depthM} m`);
  if (t.dyDeg[0] !== 0 || t.dyDeg[1] !== 0) parts.push(`vertical offset L ${signed(t.dyDeg[0])} R ${signed(t.dyDeg[1])} deg`);
  if (feather > 0) parts.push(`soft edge ${Math.round(feather * 1000) / 10}%`);
  return parts.length ? `, ${parts.join(', ')}` : '';
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

export interface RegisterResult {
  /** 'ok', 'disabled' (the player set our value to 1) or 'failed'. */
  result: 'ok' | 'disabled' | 'failed';
  /** 'ok' only: the value was not there (enabled) before, so it was written now. */
  changed: boolean;
}

/**
 * Register `jsonPath` for the current user (D7.3; the rules in the file comment): drop other registrations of the same
 * json file name, leave a value the player disabled alone. Never throws.
 */
export async function registerVrLayer(jsonPath: string, opts: { log: (line: string) => void; exec?: Exec }): Promise<RegisterResult> {
  const exec = opts.exec ?? execReg;
  try {
    // `reg query` exits 1 when the key does not exist yet: nothing registered, nothing stale.
    const existing = parseRegQuery((await exec('reg.exe', queryArgs()).catch(() => ({ stdout: '' }))).stdout);
    const mine = existing.find((v) => sameFile(v.name, jsonPath));
    if (mine && mine.value !== null && mine.value !== 0) {
      opts.log(`vr-layer: ${jsonPath} is disabled under ${OPENXR_IMPLICIT_LAYERS_KEY} (value ${mine.value}); left as the player set it`);
      return { result: 'disabled', changed: false };
    }
    for (const stale of existing.filter((v) => isOurJson(v.name) && !sameFile(v.name, jsonPath))) {
      await exec('reg.exe', deleteArgs(stale.name));
      opts.log(`vr-layer: removed an older registration ${stale.name}`);
    }
    await exec('reg.exe', registerArgs(jsonPath));
    return { result: 'ok', changed: !mine };
  } catch (e) {
    opts.log(`vr-layer: could not register the layer (${(e as Error).message}); the panel can show only if it was registered before`);
    return { result: 'failed', changed: false };
  }
}

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
  /** D7.3.3: whether the VPX running predates the registration (`createLayerAgeWatch`); stale → `vpxBeforeLayer`. */
  layerAge?: LayerAge;
  /** D7.3.3: each successful registration here, `changed` when the value was written now (the age watch's moment). */
  onRegistered?: (changed: boolean) => void;
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
  let theaterScale = 1;
  /** D7.5.10 / D7.5.11: the window's depth and per-eye offset, and its soft edge; on a protocol-3 control only when not the defaults. */
  let tune: VrWindowTune = VR_LAYER_TUNE_DEFAULT;
  let feather = 0;
  /** D7.5.2: the sender's eyes on the theater frames (their JSON as the change key), on the control of a protocol-3 layer. */
  let eyes: LayerCameraEyeGeometry[] | null = null;
  let eyesKey = '';
  let fedSize = '';
  /** The connected layer's protocol: 1 until its hello says more. */
  let protocol = 1;
  /** D7.5.1: the connected layer has said something (its hello, or not): only then is `protocol` known. */
  let spoke = false;
  let lastControl: string | null = null;
  let oldLayerLogged = false;
  // D7.5: the camera: what is asked, what the layer said, the frame listeners and the 10 s counters.
  let cameraReq: LayerCameraRequest | null = null;
  let camera: LayerCameraStatus = { state: 'off', why: null, lastFrameAt: null, frames: 0 };
  const frameListeners = new Set<(f: LayerCameraFrame) => void>();
  const cameraListeners = new Set<(s: LayerCameraStatus) => void>();
  let counterTimer: ReturnType<typeof setInterval> | null = null;
  let counted = { frames: 0, bytes: 0, lastN: -1, gaps: 0, garbage: 0, bad: 0, width: 0, height: 0 };
  let oldCameraLogged = false;
  // D7.6: the bench: the last session report, the last controls written, report requests waiting, the listeners.
  let session: LayerSessionReport | null = null;
  /** D7.6.1: the calibration pattern, while asked. */
  let test: VrTestPattern | null = null;
  /** D10.3: the `recv` frame ring theater reads instead of CVO2 (`video: {ring}` on a protocol-3 control, only while set). */
  let videoRing: string | null = null;
  let sentControls: Array<{ at: number; text: string }> = [];
  const sessionWaiters = new Set<(r: LayerSessionReport) => void>();
  const benchListeners = new Set<(b: VrLayerBench) => void>();
  const isConnected = (): boolean => socket !== null && current.state === 'showing';
  const bench = (): VrLayerBench => ({
    started: current.state !== 'stopped',
    connected: isConnected(),
    protocol: isConnected() ? protocol : 0,
    session,
    controls: [...sentControls],
    test,
  });
  const notifyBench = () => {
    const b = bench();
    for (const l of [...benchListeners]) l(b);
  };
  const setCameraStatus =(patch: Partial<LayerCameraStatus>) => {
    const next = { ...camera, ...patch };
    if (JSON.stringify(next) === JSON.stringify(camera)) return;
    camera = next;
    for (const l of [...cameraListeners]) l(camera);
  };
  const counters = () => {
    if (!cameraReq) return;
    const c = counted;
    counted = { frames: 0, bytes: 0, lastN: c.lastN, gaps: 0, garbage: 0, bad: 0, width: c.width, height: c.height };
    const kb = c.frames ? Math.round(c.bytes / c.frames / 1024) : 0;
    opts.log(
      `vr-layer camera: ${c.frames} frames in ${CAMERA_COUNTERS_MS / 1000} s${c.frames ? ` (${c.width}x${c.height} per eye, ${kb} KB a frame)` : ''}${c.gaps ? `, ${c.gaps} dropped by the layer` : ''}${c.bad ? `, ${c.bad} unreadable` : ''}${c.garbage ? `, ${c.garbage} stray bytes skipped` : ''}; ${camera.state}${camera.why ? ` (${camera.why})` : ''}`,
    );
  };
  const startCounters = () => {
    if (counterTimer) return;
    counterTimer = setInterval(counters, CAMERA_COUNTERS_MS);
  };
  const stopCounters = () => {
    if (counterTimer) clearInterval(counterTimer);
    counterTimer = null;
  };
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

  /** D7.3.3: what callers see: `current` plus `vpxBeforeLayer` while the age watch says so (absent otherwise). */
  const visible = (): VrOverlayStatus => (opts.layerAge?.stale() ? { ...current, vpxBeforeLayer: true } : current);
  const notify = () => {
    const s = visible();
    for (const l of [...listeners]) l(s);
  };

  const set = (state: VrOverlayStatus['state'], reason: string | null = null) => {
    if (current.state === state && current.reason === reason) return;
    current = { state, reason };
    notify();
  };
  opts.layerAge?.onChange(notify);

  /** 'ok', 'disabled' (the player set our value to 1) or 'failed'; never throws. */
  const register = async (jsonPath: string): Promise<'ok' | 'disabled' | 'failed'> => {
    const r = await registerVrLayer(jsonPath, { log: opts.log, exec });
    if (r.result !== 'ok') return r.result;
    if (!registeredLogged) {
      registeredLogged = true;
      opts.log(`vr-layer: ${r.changed ? 'registered now' : 'registered'} ${jsonPath} under ${OPENXR_IMPLICIT_LAYERS_KEY}${r.changed ? ' (a VPX already running loads it only after a restart)' : ''}`);
    }
    opts.onRegistered?.(r.changed);
    return 'ok';
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

  /**
   * The control, when a protocol-2 layer listens and it changed since the last one on this connection. D7.5: the
   * `camera` field goes only to a protocol-3 layer (a request, or null for none), so a protocol-2 control is unchanged.
   */
  const sendControl = (report = false): boolean => {
    const sock = socket;
    if (!sock || protocol < 2 || !sock.writable) return false;
    // D7.6.1: `test` only while set and only to a protocol-3 layer, so every other control is byte for byte as before.
    const body = {
      mode,
      stereo,
      panelPos: VR_LAYER_PANEL_POS,
      theaterScale,
      ...(protocol >= VR_LAYER_CAMERA_PROTOCOL ? { camera: cameraReq } : {}),
      ...(protocol >= VR_LAYER_CAMERA_PROTOCOL && test ? { test } : {}),
      // D7.5.2: the sender's eyes only while the frames carry them, so every other control is byte for byte as before.
      ...(protocol >= VR_LAYER_CAMERA_PROTOCOL && eyes ? { eyes } : {}),
      // D7.5.10 / D7.5.11: the window's tuning and soft edge only when set, to a protocol-3 layer only (omitted = defaults).
      ...(protocol >= VR_LAYER_CAMERA_PROTOCOL && !tuneIsDefault(tune) ? { tune } : {}),
      ...(protocol >= VR_LAYER_CAMERA_PROTOCOL && feather > 0 ? { feather } : {}),
      // D10.3: the decoded picture's ring only while the match host set one, to a protocol-3 layer only (§6.5).
      ...(protocol >= VR_LAYER_CAMERA_PROTOCOL && videoRing ? { video: { ring: videoRing } } : {}),
    };
    const text = JSON.stringify(body);
    if (text === lastControl && !report) return false;
    const changed = text !== lastControl;
    lastControl = text;
    // D7.6.2: `report` rides on one control as a request; the dedup above compares the controls without it.
    const sent = report ? { ...body, report: true } : body;
    sock.write(controlMessage(sent));
    sentControls = [...sentControls, { at: now(), text: report ? JSON.stringify(sent) : text }].slice(-BENCH_CONTROLS);
    if (report) opts.log('vr-layer: asked the layer for its session report');
    if (!changed) return true;
    // D8.1: the eyes asked for (`one eye (left)` / `both eyes`) are on the line.
    const cam = protocol >= VR_LAYER_CAMERA_PROTOCOL ? `, camera ${cameraReq ? `${cameraReq.width}x${cameraReq.height} at ${cameraReq.fps} fps${cameraReq.whole ? ', whole view' : ''}, ${cameraEyesWords(cameraReq)}${cameraReq.ring ? ', to the frame ring' : ''}` : 'off'}` : '';
    const pat = protocol >= VR_LAYER_CAMERA_PROTOCOL && test ? ', calibration pattern' : '';
    const ring = protocol >= VR_LAYER_CAMERA_PROTOCOL && videoRing ? ', theater from the frame ring' : '';
    const eye = protocol >= VR_LAYER_CAMERA_PROTOCOL && eyes ? `, the sender's eyes (crop ${eyes[0]!.rect[2]}x${eyes[0]!.rect[3]} at ${eyes[0]!.rect[0]},${eyes[0]!.rect[1]} / ${eyes[1]!.rect[0]},${eyes[1]!.rect[1]} of ${eyes[0]!.render[0]}x${eyes[0]!.render[1]})` : '';
    const tuned = protocol >= VR_LAYER_CAMERA_PROTOCOL ? tuneWords(tune, feather) : '';
    opts.log(`vr-layer: mode ${mode} (${stereo}${mode === 'panel' ? `, panel ${VR_LAYER_PANEL_POS}` : ''}${cam}${pat}${ring}${eye}${tuned})`);
    if (protocol >= VR_LAYER_CAMERA_PROTOCOL && cameraReq && camera.state !== 'on') setCameraStatus({ state: 'asked', why: null });
    return true;
  };

  /** D7.5: one message the layer sent (after `createLayerReader` cut it out). */
  const onLayerMessage = (m: LayerMessage, sock: PipeSocket) => {
    switch (m.kind) {
      case 'hello': {
        if (protocol >= 2) return; // a second hello on one connection: not a thing
        protocol = m.protocol;
        opts.log(`vr-layer: the layer speaks pipe protocol ${m.protocol}${m.protocol >= VR_LAYER_CAMERA_PROTOCOL ? ' (modes, theater, camera)' : m.protocol >= 2 ? ' (modes, theater)' : ''}`);
        if (cameraReq && m.protocol < VR_LAYER_CAMERA_PROTOCOL && !oldCameraLogged) {
          oldCameraLogged = true;
          opts.log(`vr-layer: the camera is asked, but the layer in VPX speaks pipe protocol ${m.protocol} (before the layer camera): the screen capture stays until VPX restarts with the new layer`);
        }
        sendControl();
        updateVideo();
        notifyBench();
        return;
      }
      case 'session': {
        session = { receivedAt: now(), facts: m.facts };
        opts.log(`vr-layer: session report from the layer: ${sessionSummary(m.facts)}`);
        for (const w of [...sessionWaiters]) w(session);
        notifyBench();
        return;
      }
      case 'frame': {
        const f = m.frame;
        if (!cameraReq) return; // a frame after the camera was turned off: the layer had not read the control yet
        counted.frames++;
        counted.width = f.width;
        counted.height = f.height;
        for (const e of f.eyes) counted.bytes += e.data.length;
        if (counted.lastN >= 0 && f.n > counted.lastN + 1) counted.gaps += f.n - counted.lastN - 1;
        counted.lastN = f.n;
        const first = camera.frames === 0;
        setCameraStatus({ state: 'on', why: null, lastFrameAt: now(), frames: camera.frames + 1 });
        if (first) opts.log(`vr-layer camera: first frame: ${f.width}x${f.height} per eye, ${f.eyes.map((e) => e.data.length).join(' + ')} bytes${f.us ? `, layer issue ${f.us.issue} us, map ${f.us.map} us, copy ${f.us.copy} us, encode ${f.us.enc} us` : ''}`);
        for (const l of [...frameListeners]) l(f);
        return;
      }
      case 'status': {
        const s = m.status;
        if (s.camera === 'on') {
          opts.log(`vr-layer camera: on${s.api ? ` (${s.api})` : ''}${s.source ? `, eye render ${s.source[0]}x${s.source[1]}` : ''}${s.size ? `, ${s.size[0]}x${s.size[1]} per eye` : ''}${s.fps ? ` at ${s.fps} fps` : ''}`);
          setCameraStatus({
            state: 'on',
            why: null,
            api: s.api ?? null,
            source: s.source ? { width: s.source[0], height: s.source[1] } : null,
            size: s.size ? { width: s.size[0], height: s.size[1] } : null,
          });
        } else if (s.camera === 'refused') {
          opts.log(`vr-layer camera: refused by the layer: ${s.why}; the screen capture stays`);
          setCameraStatus({ state: 'refused', why: s.why || 'refused' });
        } else {
          opts.log(`vr-layer camera: off (${s.why || 'no reason given'})`);
          setCameraStatus({ state: cameraReq ? 'asked' : 'off', why: s.why || null, api: null, source: null, size: null });
        }
        return;
      }
      case 'unknown':
        opts.log(`vr-layer: skipped a ${m.length}-byte '${m.magic}' message this companion does not know (newer layer)`);
        return;
      case 'bad':
        counted.bad++;
        if (counted.bad === 1) opts.log(`vr-layer: an unreadable '${m.magic}' message from the layer (${m.reason}); skipped`);
        return;
      case 'garbage':
        counted.garbage += m.bytes;
        if (sock === socket) opts.log(`vr-layer: skipped ${m.bytes} stray byte(s) on the pipe to find the next message`);
        return;
    }
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
    const reader = createLayerReader();
    let firstMessage = true;
    sock.on('connect', () => {
      if (socket !== sock) return;
      connected = true;
      everConnected = true;
      protocol = 1;
      spoke = false;
      lastControl = null;
      opts.log(`vr-layer: connected to the layer in VPX (${pipePath})`);
      set('showing');
      writer.attach(sock);
    });
    sock.on('data', (chunk) => {
      if (socket !== sock) return;
      for (const m of reader.push(chunk)) {
        spoke = true;
        // The hello comes first on a protocol-2+ pipe; anything else first means a layer this side cannot read.
        if (firstMessage && m.kind !== 'hello') {
          firstMessage = false;
          opts.log('vr-layer: the layer sent something that is not a hello; staying on protocol 1 (the panel only)');
          continue;
        }
        firstMessage = false;
        onLayerMessage(m, sock);
      }
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
      spoke = false;
      lastControl = null;
      updateVideo();
      // D7.5: frames end with the pipe; a camera still asked is asked again of the next connection.
      if (camera.state === 'on' || camera.state === 'refused') setCameraStatus({ state: cameraReq ? 'asked' : 'off', why: 'pipe closed', api: null, source: null, size: null });
      if (stopping) return;
      if (connected) {
        opts.log('vr-layer: the layer closed the pipe (VPX exited or left VR); trying again');
        set('hidden', 'pipe_closed');
        notifyBench();
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
    stopCounters();
    setCameraStatus({ state: 'off', why: null, api: null, source: null, size: null, lastFrameAt: null, frames: 0 });
    test = null; // D7.6.1: a test picture never outlives the overlay (the next match starts without it)
    videoRing = null; // D10.3: nor does the ring (the match host sets it again for the next match)
    set('stopped');
    notifyBench();
  };

  return {
    async start(source: PanelFrameSource, videoSource?: VideoFrameSource | null): Promise<VrOverlayStatus> {
      if (socket || retryTimer || unsubscribe) await stop();
      if (!opts.jsonPath) {
        set('unavailable', 'layer_missing');
        return visible();
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
          // D7.5.2: the eyes ride with the frames; the control carries them (and drops them) as they change.
          const key = f.eyes && f.eyes.length === 2 ? JSON.stringify(f.eyes) : '';
          if (f.stereo !== stereo || key !== eyesKey) {
            stereo = f.stereo;
            eyesKey = key;
            eyes = key ? (f.eyes ?? null) : null;
            sendControl();
          }
          if (mode === 'theater' && protocol >= 2) {
            const fed = `${f.width}x${f.height} (${f.stereo})`;
            if (fed !== fedSize) {
              fedSize = fed;
              opts.log(`theater: feeding ${fed} to the layer`);
            }
            videoWriter.push(f);
          }
        }) ?? null;
      set('starting');
      const reg = await register(opts.jsonPath);
      if (stopping) return visible(); // stop() while registering
      if (reg === 'disabled') {
        unsubscribe();
        unsubscribe = null;
        unsubscribeVideo?.();
        unsubscribeVideo = null;
        video = null;
        set('unavailable', 'layer_disabled');
        return visible();
      }
      registerFailed = reg === 'failed';
      tryConnect();
      return visible();
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

    setTheaterScale(scale) {
      const next = Number.isFinite(scale) ? Math.min(4, Math.max(0.25, scale)) : 1;
      if (next === theaterScale) return;
      theaterScale = next;
      sendControl();
    },

    // D7.5.10: the window's depth and per-eye vertical offset, live like Theater size (the control dedups the text).
    setWindowTune(next) {
      const t = cleanTune(next);
      if (t.depthM === tune.depthM && t.dyDeg[0] === tune.dyDeg[0] && t.dyDeg[1] === tune.dyDeg[1]) return;
      tune = t;
      sendControl();
    },

    // D7.5.11: the window's soft edge.
    setSoftEdge(next) {
      const f = cleanFeather(next);
      if (f === feather) return;
      feather = f;
      sendControl();
    },

    status: visible,

    onStatus(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },

    // D7.5: the camera.
    setCamera(req) {
      if (sameRequest(req, cameraReq)) return;
      cameraReq = req;
      counted = { frames: 0, bytes: 0, lastN: -1, gaps: 0, garbage: 0, bad: 0, width: 0, height: 0 };
      if (req) {
        opts.log(`vr-layer camera: asked: each eye${req.whole ? "'s whole render" : ''} in a ${req.width}x${req.height} box at ${req.fps} fps`);
        setCameraStatus({ state: 'asked', why: null, lastFrameAt: null, frames: 0 });
        startCounters();
        if (socket && protocol >= 2 && protocol < VR_LAYER_CAMERA_PROTOCOL && !oldCameraLogged) {
          oldCameraLogged = true;
          opts.log(`vr-layer: the camera is asked, but the layer in VPX speaks pipe protocol ${protocol} (before the layer camera): the screen capture stays until VPX restarts with the new layer`);
        }
      } else {
        opts.log('vr-layer camera: off');
        stopCounters();
        setCameraStatus({ state: 'off', why: null, api: null, source: null, size: null });
      }
      sendControl();
    },

    onCameraFrame(cb) {
      frameListeners.add(cb);
      return () => void frameListeners.delete(cb);
    },

    cameraStatus: () => camera,

    layerProtocol: () => (socket && spoke ? protocol : null),

    onCameraStatus(cb) {
      cameraListeners.add(cb);
      return () => void cameraListeners.delete(cb);
    },

    // D7.6: the test bench.
    bench,

    setTest(next) {
      if (next === test) return;
      test = next;
      opts.log(`vr-layer: calibration pattern ${test ? 'asked' : 'off'}${test && !(isConnected() && protocol >= VR_LAYER_CAMERA_PROTOCOL) ? ' (sent once a protocol-3 layer is connected)' : ''}`);
      sendControl();
      notifyBench();
    },

    // D10.3: theater from the video helper's `recv` ring (§6.5); null returns to the CVO2 pipe frames.
    setVideoRing(token) {
      const next = typeof token === 'string' && token ? token : null;
      if (next === videoRing) return;
      videoRing = next;
      opts.log(`vr-layer: theater video from ${next ? 'the helper\'s frame ring' : 'the pipe (CVO2)'}${next && !(isConnected() && protocol >= VR_LAYER_CAMERA_PROTOCOL) ? ' (sent once a protocol-3 layer is connected)' : ''}`);
      sendControl();
    },

    onBench(cb) {
      benchListeners.add(cb);
      return () => void benchListeners.delete(cb);
    },

    requestSession(timeoutMs) {
      return new Promise<LayerSessionReport | null>((done) => {
        if (!isConnected() || protocol < VR_LAYER_CAMERA_PROTOCOL) return done(null);
        let timer: ReturnType<typeof setTimeout> | null = null;
        const waiter = (r: LayerSessionReport) => {
          if (timer) clearTimeout(timer);
          sessionWaiters.delete(waiter);
          done(r);
        };
        timer = setTimeout(() => {
          sessionWaiters.delete(waiter);
          done(null);
        }, timeoutMs);
        sessionWaiters.add(waiter);
        if (!sendControl(true)) {
          clearTimeout(timer);
          sessionWaiters.delete(waiter);
          done(null);
        }
      });
    },
  };
}

/** D7.6.2: one line about a session report for the log (layer build, runtime, system, OpenComposite). */
export function sessionSummary(facts: Record<string, unknown>): string {
  const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const layer = obj(facts.layer);
  const runtime = obj(facts.runtime);
  const system = obj(facts.system);
  const oc = obj(facts.openComposite);
  const graphics = obj(facts.graphics);
  return [
    `layer ${str(layer?.version) ?? 'unknown'} build ${str(layer?.build) ?? 'unknown'}`,
    runtime ? `runtime '${str(runtime.name) ?? '?'}' ${str(runtime.version) ?? '?'}` : 'runtime unknown',
    system ? `system '${str(system.name) ?? '?'}'` : 'system unknown',
    `graphics ${str(graphics?.binding) ?? 'unknown'}`,
    `OpenComposite ${str(oc?.verdict) ?? 'unknown'}`,
  ].join('; ');
}

export interface LayerProbeResult {
  /** The pipe connected (a layer serves it: VPX runs in VR with the layer loaded). */
  connected: boolean;
  /** The layer's pipe protocol from its hello; null without one. */
  protocol: number | null;
  session: LayerSessionReport | null;
  /** What happened, in words, for the report. */
  note: string;
}

/**
 * D7.6.2: the session report over a short connection of its own, for when no match holds the pipe (the layer serves one
 * client at a time). The layer sends the report after every new connection at its next frame, so this connects,
 * reads the hello and the report, and closes; nothing is written, so the layer's control stays at its defaults (the
 * panel, with no panel frame: nothing is drawn). Never rejects.
 */
export function probeLayerSession(opts: { timeoutMs: number; connect?: (path: string) => PipeSocket; pipePath?: string; now?: () => number }): Promise<LayerProbeResult> {
  const connect = opts.connect ?? ((p: string) => netConnect(p) as unknown as PipeSocket);
  const now = opts.now ?? Date.now;
  const pipePath = opts.pipePath ?? VR_LAYER_PIPE;
  return new Promise((done) => {
    let sock: PipeSocket | null = null;
    let finished = false;
    let connected = false;
    let protocol: number | null = null;
    const finish = (session: LayerSessionReport | null, note: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        sock?.destroy();
      } catch {
        // already gone
      }
      done({ connected, protocol, session, note });
    };
    const silence = () =>
      !connected
        ? 'no layer answered on the pipe (VPX not running in VR, or the layer not loaded in it)'
        : protocol === null
          ? 'the layer sent no hello'
          : `the layer (pipe protocol ${protocol}) sent no session report within ${Math.round(opts.timeoutMs / 1000)} s (a layer before 0.5.0, or VPX is not rendering VR frames)`;
    const timer = setTimeout(() => finish(null, silence()), opts.timeoutMs);
    try {
      sock = connect(pipePath);
    } catch (e) {
      finish(null, `could not open ${pipePath}: ${(e as Error).message}`);
      return;
    }
    const reader = createLayerReader();
    sock.on('connect', () => {
      connected = true;
    });
    sock.on('data', (chunk) => {
      connected = true;
      for (const m of reader.push(chunk)) {
        if (m.kind === 'hello') {
          protocol = m.protocol;
          if (m.protocol < VR_LAYER_CAMERA_PROTOCOL) finish(null, `the layer speaks pipe protocol ${m.protocol}, before the session report: restart VPX with this Castcade's layer`);
        } else if (m.kind === 'session') {
          finish({ receivedAt: now(), facts: m.facts }, 'read over a short pipe connection of its own (no match held the pipe)');
        }
      }
    });
    sock.on('error', (e) => {
      if (!connected) finish(null, `no layer answered on the pipe (${e.code ?? e.message}): VPX not running in VR, or the layer not loaded in it`);
    });
    sock.on('close', () => finish(null, connected ? `the layer closed the pipe before its report (${silence()})` : silence()));
  });
}
