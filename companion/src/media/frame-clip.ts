/**
 * D7.6.3 (2026-11-03): saved eye frames, for offline analysis of crop, aspect and geometry, and for the VR test bench
 * (D7.6) to replay. One folder per save under `<logs>/frames/<yyyy-mm-dd-hhmmss>/`:
 *
 *   - the sender side, every layer-camera frame for 2 s: `NNNN-L.jpg`, `NNNN-R.jpg` (the layer's own JPEGs, as they came
 *     off the pipe) and `NNNN.json` (the frame header: `n`, `t`, `w`, `h`, `us`, `eyes` with fov / rect / render);
 *   - the receiver side, every decoded incoming frame the panel page handed to the layer as the theater feed (from a
 *     peer or from the bench), encoded to JPEG in the page (quality 90): `in-NNNN.jpg` and `in-NNNN.json` (width,
 *     height, stereo, eyes if known, the time);
 *   - `clip.json`, the index: both sides' frame lists, their recorded fps and sizes, and the settings in force.
 *
 * At most `FRAME_SAVE_MAX` frames per side. Nothing here imports Electron: the saver takes its file system as a seam,
 * and the listing / playback helpers are pure over file names and parsed JSON.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LayerCameraEyeGeometry, LayerCameraFrame, VrStereo } from './match-media-types.js';

/** How long one save records, the most frames kept per side, and how long the finish waits for the page's last encodes. */
export const FRAME_SAVE_MS = 2000;
export const FRAME_SAVE_MAX = 120;
export const FRAME_SAVE_GRACE_MS = 1500;
/** The receiver side's JPEG quality (canvas `toBlob`). */
export const IN_JPEG_QUALITY = 0.9;
export const CLIP_INDEX = 'clip.json';
export const CLIP_FORMAT = 'castcade-frames';
export const CLIP_VERSION = 1;

const pad = (n: number, w = 2): string => String(Math.max(0, Math.floor(n))).padStart(w, '0');

/** The folder of one save: local time, `2026-11-03-101502`. */
export function clipFolderName(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** A frame's number in its file names: `0007`. */
export const frameBase = (i: number): string => pad(i, 4);

export function senderFiles(i: number): { left: string; right: string; header: string } {
  const b = frameBase(i);
  return { left: `${b}-L.jpg`, right: `${b}-R.jpg`, header: `${b}.json` };
}

export function receiverFiles(i: number): { image: string; header: string } {
  const b = frameBase(i);
  return { image: `in-${b}.jpg`, header: `in-${b}.json` };
}

/** The sender side's `NNNN.json`: the layer's frame header, without the JPEG bytes. */
export interface SenderHeader {
  n: number;
  t: number;
  w: number;
  h: number;
  us: LayerCameraFrame['us'] | null;
  eyes: LayerCameraEyeGeometry[];
}

export function senderHeader(f: LayerCameraFrame): SenderHeader {
  return { n: f.n, t: f.t, w: f.width, h: f.height, us: f.us ?? null, eyes: f.eyes.map((e) => ({ fov: e.fov, rect: e.rect, render: e.render })) };
}

/** One decoded incoming frame from the panel page (the receiver side). */
export interface ReceivedFrame {
  jpeg: Uint8Array;
  width: number;
  height: number;
  stereo: VrStereo;
  eyes: LayerCameraEyeGeometry[] | null;
  /** `Date.now()` in the page when it was decoded. */
  at: number;
  /** What the feed came from: `peer <id>`, `bench (direct)`, `bench (local WebRTC loop)`. */
  source: string;
  /** Frames the page skipped since the last one because an encode was still in flight. */
  skipped: number;
}

/** A saved frame from the panel page (`PanelSavedFrame`), checked: a non-empty JPEG, whole sizes 1–8192; null otherwise. */
export function receivedFrameFrom(m: unknown): ReceivedFrame | null {
  if (typeof m !== 'object' || m === null) return null;
  const v = m as Partial<Record<keyof ReceivedFrame, unknown>>;
  const size = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 8192;
  if (!(v.jpeg instanceof Uint8Array) || v.jpeg.byteLength === 0 || !size(v.width) || !size(v.height)) return null;
  const eyes = Array.isArray(v.eyes) && v.eyes.length === 2 ? (v.eyes as LayerCameraEyeGeometry[]) : null;
  return {
    jpeg: v.jpeg,
    width: v.width,
    height: v.height,
    stereo: v.stereo === 'sbs' ? 'sbs' : 'mono',
    eyes,
    at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : Date.now(),
    source: typeof v.source === 'string' ? v.source.slice(0, 80) : 'unknown',
    skipped: typeof v.skipped === 'number' && v.skipped >= 0 ? Math.floor(v.skipped) : 0,
  };
}

/** The receiver side's `in-NNNN.json`. */
export interface ReceiverHeader {
  width: number;
  height: number;
  stereo: VrStereo;
  eyes: LayerCameraEyeGeometry[] | null;
  at: number;
  source: string;
}

export interface ClipSenderFrame {
  i: number;
  n: number;
  /** Microseconds since the layer's camera started (the header's `t`). */
  t: number;
  left: string;
  right: string;
  header: string;
}

export interface ClipReceiverFrame {
  i: number;
  /** Milliseconds since the save started. */
  at: number;
  file: string;
  header: string;
  width: number;
  height: number;
  stereo: VrStereo;
}

export interface ClipIndex {
  format: typeof CLIP_FORMAT;
  version: number;
  createdAt: string;
  folder: string;
  durationMs: number;
  cap: number;
  sender: { count: number; fps: number | null; eye: { width: number; height: number } | null; eyes: LayerCameraEyeGeometry[] | null; frames: ClipSenderFrame[] } | null;
  receiver: {
    count: number;
    fps: number | null;
    size: { width: number; height: number } | null;
    stereo: VrStereo | null;
    source: string | null;
    skipped: number;
    frames: ClipReceiverFrame[];
  } | null;
  settings: Record<string, unknown>;
  notes: string[];
}

/** Frames a second from their times (`perSecond` units a second: 1e6 for the layer's microseconds, 1000 for ms), to 0.1; null under two frames. */
export function fpsOf(times: readonly number[], perSecond: number): number | null {
  if (times.length < 2) return null;
  const span = (times[times.length - 1]! - times[0]!) / perSecond;
  if (!(span > 0)) return null;
  return Math.round(((times.length - 1) / span) * 10) / 10;
}

export function buildClipIndex(o: {
  folder: string;
  createdAt: Date;
  durationMs: number;
  cap: number;
  sender: ClipSenderFrame[];
  senderFirst: SenderHeader | null;
  receiver: ClipReceiverFrame[];
  receiverSource: string | null;
  receiverSkipped: number;
  settings: Record<string, unknown>;
  notes: string[];
}): ClipIndex {
  const r0 = o.receiver[0];
  return {
    format: CLIP_FORMAT,
    version: CLIP_VERSION,
    createdAt: o.createdAt.toISOString(),
    folder: o.folder,
    durationMs: o.durationMs,
    cap: o.cap,
    sender: o.sender.length
      ? {
          count: o.sender.length,
          fps: fpsOf(o.sender.map((f) => f.t), 1e6),
          eye: o.senderFirst ? { width: o.senderFirst.w, height: o.senderFirst.h } : null,
          eyes: o.senderFirst ? o.senderFirst.eyes : null,
          frames: o.sender,
        }
      : null,
    receiver: o.receiver.length
      ? {
          count: o.receiver.length,
          fps: fpsOf(o.receiver.map((f) => f.at), 1000),
          size: r0 ? { width: r0.width, height: r0.height } : null,
          stereo: r0 ? r0.stereo : null,
          source: o.receiverSource,
          skipped: o.receiverSkipped,
          frames: o.receiver,
        }
      : null,
    settings: o.settings,
    notes: o.notes,
  };
}

export interface FrameSaverFs {
  mkdir(dir: string): Promise<unknown>;
  writeFile(path: string, data: Uint8Array | string): Promise<unknown>;
}

const nodeFs: FrameSaverFs = { mkdir: (d) => mkdir(d, { recursive: true }), writeFile: (p, d) => writeFile(p, d) };

export interface FrameSaver {
  /** One layer-camera frame; false when it is not kept (the window is over, the cap is reached, or the saver finished). */
  senderFrame(f: LayerCameraFrame): boolean;
  receiverFrame(f: ReceivedFrame): boolean;
  counts(): { sender: number; receiver: number; capped: { sender: number; receiver: number } };
  /** Stops taking frames, waits for the writes, writes `clip.json`; null (and no folder) when no frame came. */
  finish(notes?: string[]): Promise<ClipIndex | null>;
}

/**
 * D7.6.3: the saver for one save. Frames are copied at once (a layer frame's eyes are views into the pipe's buffer) and
 * written in order on one promise chain; the folder is made at the first frame.
 */
export function createFrameSaver(o: {
  dir: string;
  folder: string;
  settings: Record<string, unknown>;
  now?: () => number;
  durationMs?: number;
  max?: number;
  fs?: FrameSaverFs;
}): FrameSaver {
  const now = o.now ?? Date.now;
  const fs = o.fs ?? nodeFs;
  const durationMs = o.durationMs ?? FRAME_SAVE_MS;
  const max = o.max ?? FRAME_SAVE_MAX;
  const startedAt = now();
  const createdAt = new Date(startedAt);
  const sender: ClipSenderFrame[] = [];
  const receiver: ClipReceiverFrame[] = [];
  let senderFirst: SenderHeader | null = null;
  let receiverSource: string | null = null;
  let receiverSkipped = 0;
  const capped = { sender: 0, receiver: 0 };
  let closed = false;
  let chain: Promise<unknown> | null = null;
  const errors: string[] = [];
  const write = (name: string, data: Uint8Array | string): void => {
    chain ??= fs.mkdir(o.dir);
    chain = chain.then(() => fs.writeFile(join(o.dir, name), data)).catch((e: unknown) => {
      if (errors.length < 3) errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  const open = (): boolean => !closed && now() - startedAt <= durationMs;
  return {
    senderFrame(f) {
      if (!open()) return false;
      const [l, r] = f.eyes;
      if (!l || !r) return false;
      if (sender.length >= max) {
        capped.sender++;
        return false;
      }
      const i = sender.length;
      const files = senderFiles(i);
      const h = senderHeader(f);
      senderFirst ??= h;
      sender.push({ i, n: f.n, t: f.t, ...files });
      write(files.left, Uint8Array.from(l.data));
      write(files.right, Uint8Array.from(r.data));
      write(files.header, JSON.stringify(h, null, 1));
      return true;
    },
    receiverFrame(f) {
      if (!open() || !(f.jpeg instanceof Uint8Array) || f.jpeg.byteLength === 0) return false;
      receiverSkipped += Math.max(0, Math.floor(f.skipped || 0));
      if (receiver.length >= max) {
        capped.receiver++;
        return false;
      }
      const i = receiver.length;
      const files = receiverFiles(i);
      const h: ReceiverHeader = { width: f.width, height: f.height, stereo: f.stereo, eyes: f.eyes, at: f.at, source: f.source };
      receiverSource ??= f.source;
      receiver.push({ i, at: Math.max(0, f.at - startedAt), file: files.image, header: files.header, width: f.width, height: f.height, stereo: f.stereo });
      write(files.image, Uint8Array.from(f.jpeg));
      write(files.header, JSON.stringify(h, null, 1));
      return true;
    },
    counts: () => ({ sender: sender.length, receiver: receiver.length, capped: { ...capped } }),
    async finish(notes = []) {
      closed = true;
      if (!chain) return null;
      const all = [...notes];
      if (capped.sender) all.push(`sender: ${capped.sender} frame(s) past the cap of ${max} not kept`);
      if (capped.receiver) all.push(`receiver: ${capped.receiver} frame(s) past the cap of ${max} not kept`);
      const index = buildClipIndex({ folder: o.folder, createdAt, durationMs, cap: max, sender, senderFirst, receiver, receiverSource, receiverSkipped, settings: o.settings, notes: all });
      await chain;
      if (errors.length) index.notes.push(...errors.map((e) => `write failed: ${e}`));
      write(CLIP_INDEX, JSON.stringify(index, null, 1));
      await chain;
      return index;
    },
  };
}

/** What one save did, for the Match tab: the folder (null: nothing written), the frames per side, and why a side is empty. */
export interface SaveFramesResult {
  dir: string | null;
  sender: number;
  receiver: number;
  notes: string[];
  line: string;
}

/** One line for companion.log about a finished save. */
export function savedLine(dir: string, index: ClipIndex | null): string {
  if (!index) return `media: frames: nothing saved (no layer camera frame and no theater frame in ${FRAME_SAVE_MS / 1000} s)`;
  const s = index.sender;
  const r = index.receiver;
  const paren = (parts: Array<string | null>): string => {
    const p = parts.filter((x): x is string => !!x);
    return p.length ? ` (${p.join(', ')})` : '';
  };
  const sw = s ? `${s.count} sender frame(s)${paren([s.eye ? `${s.eye.width}x${s.eye.height} per eye` : null, s.fps !== null ? `${s.fps} fps` : null])}` : 'no sender frames';
  const rw = r
    ? `${r.count} received frame(s)${paren([r.size ? `${r.size.width}x${r.size.height}${r.stereo ? ` ${r.stereo}` : ''}` : null, r.fps !== null ? `${r.fps} fps` : null, r.skipped ? `${r.skipped} skipped while encoding` : null])}`
    : 'no received frames';
  return `media: frames: saved ${sw} and ${rw} to ${dir}`;
}

// ---- reading saved clips back (the bench) ----

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 64 && !/[\\/]/.test(v);

/** `clip.json` parsed and checked (format, version, frame lists with safe file names); null otherwise. */
export function parseClipIndex(text: string): ClipIndex | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const c = v as Partial<ClipIndex>;
  if (c.format !== CLIP_FORMAT || c.version !== CLIP_VERSION || typeof c.folder !== 'string') return null;
  const okSender = (f: unknown): f is ClipSenderFrame => {
    const x = f as ClipSenderFrame;
    return !!x && isNum(x.i) && isNum(x.t) && isStr(x.left) && isStr(x.right) && isStr(x.header);
  };
  const okReceiver = (f: unknown): f is ClipReceiverFrame => {
    const x = f as ClipReceiverFrame;
    return !!x && isNum(x.i) && isNum(x.at) && isStr(x.file) && isStr(x.header) && isNum(x.width) && isNum(x.height) && (x.stereo === 'mono' || x.stereo === 'sbs');
  };
  if (c.sender !== null && c.sender !== undefined && !(Array.isArray(c.sender.frames) && c.sender.frames.every(okSender))) return null;
  if (c.receiver !== null && c.receiver !== undefined && !(Array.isArray(c.receiver.frames) && c.receiver.frames.every(okReceiver))) return null;
  return { ...(c as ClipIndex), sender: c.sender ?? null, receiver: c.receiver ?? null, settings: c.settings ?? {}, notes: Array.isArray(c.notes) ? c.notes : [] };
}

/**
 * The frames a folder holds, by their names alone, in order: sender frames with both eyes (`NNNN-L.jpg` + `NNNN-R.jpg`;
 * the header may be missing), receiver frames (`in-NNNN.jpg`). Anything else is ignored.
 */
export function orderFrames(names: readonly string[]): { sender: Array<{ i: number; left: string; right: string; header: string | null }>; receiver: Array<{ i: number; image: string; header: string | null }> } {
  const set = new Set(names);
  const sender: Array<{ i: number; left: string; right: string; header: string | null }> = [];
  const receiver: Array<{ i: number; image: string; header: string | null }> = [];
  for (const n of names) {
    let m = /^(\d{4,})-L\.jpg$/.exec(n);
    if (m) {
      const b = m[1]!;
      if (set.has(`${b}-R.jpg`)) sender.push({ i: Number(b), left: n, right: `${b}-R.jpg`, header: set.has(`${b}.json`) ? `${b}.json` : null });
      continue;
    }
    m = /^in-(\d{4,})\.jpg$/.exec(n);
    if (m) receiver.push({ i: Number(m[1]), image: n, header: set.has(`in-${m[1]}.json`) ? `in-${m[1]}.json` : null });
  }
  sender.sort((a, b) => a.i - b.i);
  receiver.sort((a, b) => a.i - b.i);
  return { sender, receiver };
}

/** One saved clip as the bench's source list shows it. */
export interface ClipSummary {
  name: string;
  dir: string;
  sender: { count: number; fps: number | null; eye: { width: number; height: number } | null } | null;
  receiver: { count: number; fps: number | null; size: { width: number; height: number } | null; stereo: VrStereo | null } | null;
}

export interface ClipFs {
  readdirSync(dir: string): string[];
  readFileSync(path: string): Buffer | string;
  existsSync(path: string): boolean;
}

const clipFs: ClipFs = { readdirSync: (d) => readdirSync(d), readFileSync: (p) => readFileSync(p), existsSync };

/** The saved clips under `root` (`<logs>/frames`), newest first (the folder names are timestamps); none when it does not exist. */
export function listClips(root: string, fs: ClipFs = clipFs): ClipSummary[] {
  if (!fs.existsSync(root)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: ClipSummary[] = [];
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/.test(name)) continue;
    const dir = join(root, name);
    let index: ClipIndex | null;
    try {
      index = parseClipIndex(String(fs.readFileSync(join(dir, CLIP_INDEX))));
    } catch {
      index = null;
    }
    if (!index || (!index.sender && !index.receiver)) continue;
    out.push({
      name,
      dir,
      sender: index.sender ? { count: index.sender.count, fps: index.sender.fps, eye: index.sender.eye } : null,
      receiver: index.receiver ? { count: index.receiver.count, fps: index.receiver.fps, size: index.receiver.size, stereo: index.receiver.stereo } : null,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/** One frame the bench plays: one JPEG per eye (sender side) or one whole picture (receiver side). */
export interface PlaybackFrame {
  i: number;
  left: string;
  right: string | null;
  /** Each eye's size (sender side), else the whole picture's. */
  width: number;
  height: number;
  stereo: VrStereo;
  eyes: LayerCameraEyeGeometry[] | null;
}

export interface Playback {
  side: 'sender' | 'receiver';
  fps: number;
  frames: PlaybackFrame[];
}

/** The bench's frame rate for a clip: its recorded fps, 30 when not known, 1–60. */
export const playbackFps = (fps: number | null | undefined): number => (isNum(fps) && fps > 0 ? Math.min(60, Math.max(1, fps)) : 30);

/**
 * D7.6: a saved clip as the bench plays it: `side` from the index (only frames whose files are in the folder, in
 * order), each with its size, stereo and eyes from its header. Null when the folder has no `clip.json` or no frames
 * on that side.
 */
export function loadClip(dir: string, side: 'sender' | 'receiver', fs: ClipFs = clipFs): Playback | null {
  let index: ClipIndex | null;
  let names: string[];
  try {
    index = parseClipIndex(String(fs.readFileSync(join(dir, CLIP_INDEX))));
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  if (!index) return null;
  const present = orderFrames(names);
  const header = (file: string | null): Record<string, unknown> | null => {
    if (!file) return null;
    try {
      const v = JSON.parse(String(fs.readFileSync(join(dir, file)))) as unknown;
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const eyesOf = (v: unknown): LayerCameraEyeGeometry[] | null => (Array.isArray(v) && v.length === 2 ? (v as LayerCameraEyeGeometry[]) : null);
  if (side === 'sender') {
    const s = index.sender;
    if (!s) return null;
    const listed = new Set(s.frames.map((f) => f.left));
    const frames: PlaybackFrame[] = [];
    for (const f of present.sender) {
      if (!listed.has(f.left)) continue;
      const h = header(f.header);
      const w = isNum(h?.w) ? h.w : (s.eye?.width ?? 0);
      const hh = isNum(h?.h) ? h.h : (s.eye?.height ?? 0);
      if (!(w > 0 && hh > 0)) continue;
      frames.push({ i: f.i, left: f.left, right: f.right, width: w, height: hh, stereo: 'sbs', eyes: eyesOf(h?.eyes) ?? s.eyes });
    }
    return frames.length ? { side, fps: playbackFps(s.fps), frames } : null;
  }
  const r = index.receiver;
  if (!r) return null;
  const byFile = new Map(r.frames.map((f) => [f.file, f]));
  const frames: PlaybackFrame[] = [];
  for (const f of present.receiver) {
    const listed = byFile.get(f.image);
    if (!listed) continue;
    const h = header(f.header);
    frames.push({ i: f.i, left: f.image, right: null, width: listed.width, height: listed.height, stereo: listed.stereo, eyes: eyesOf(h?.eyes) });
  }
  return frames.length ? { side, fps: playbackFps(r.fps), frames } : null;
}

/** D7.6: the frame to show `now`, looping at `fps` from `startedAt` (wall clock, so a slow draw drops frames, never slows the clip). */
export function playbackIndex(count: number, startedAt: number, now: number, fps: number): number {
  if (count <= 0) return 0;
  const k = Math.floor((Math.max(0, now - startedAt) * fps) / 1000);
  return k % count;
}
