/**
 * The panel's frames onto a byte stream in the frame-pipe format (D7, 2026-10-30; shared since D7.3, 2026-10-31): the
 * SteamVR helper's stdin (`vr-overlay.ts`) and the OpenXR layer's named pipe (`vr-layer.ts`) take the same bytes,
 * `frameHeader` + BGRA (vr-overlay/README.md "stdin: frames").
 *
 * Rules:
 *   - while the previous write has not drained, new frames are not written; the newest one is written on `drain` (the
 *     ones in between are dropped: a VR panel wants the current picture, never a backlog);
 *   - keepalive: the panel page paints only when the picture changes, and both consumers hide the panel after 5 s
 *     without a frame, so the last frame is re-sent when nothing was written for `KEEPALIVE_MS`;
 *   - a frame whose bytes do not match its size, or whose size the consumers refuse, is dropped with a log line (sent,
 *     it would end the helper or drop the pipe);
 *   - D7.4 (2026-10-31): `magic` picks the stream: `CVO1` panel frames (BGRA, the default), `CVO2` video frames (RGBA)
 *     on the OpenXR layer's pipe, one writer each; `controlMessage` builds the layer's `CVC1` control.
 */
import { VR_OVERLAY_FRAME_MAGIC, type PanelFrame, type VideoFrame } from './match-media-types.js';

/** Both consumers refuse larger frames; `frameHeader` refuses them first. */
export const PANEL_FRAME_MAX_SIDE = 4096;
/** Below the consumers' 5 s hide timeout, with room for a slow write. */
export const KEEPALIVE_MS = 2000;

/** The frame pipe's 16-byte little-endian header: "CVO1" (or `magic`), width, height, byteLength (= width * height * 4). */
export function frameHeader(width: number, height: number, magic: string = VR_OVERLAY_FRAME_MAGIC): Buffer {
  for (const [name, v] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > PANEL_FRAME_MAX_SIDE) throw new RangeError(`frame ${name} ${v} is outside 1..${PANEL_FRAME_MAX_SIDE}`);
  }
  const h = Buffer.alloc(16);
  h.write(magic, 0, 4, 'latin1');
  h.writeUInt32LE(width, 4);
  h.writeUInt32LE(height, 8);
  h.writeUInt32LE(width * height * 4, 12);
  return h;
}

/** The layer refuses a control message larger than this (vr-layer/src/panel_pipe.cpp kMaxMessageBytes). */
export const CONTROL_MAX_BYTES = 64 * 1024;

/** D7.4: the OpenXR layer's control message: "CVC1", u32 byteLength, the JSON (UTF-8). */
export function controlMessage(body: object): Buffer {
  const json = Buffer.from(JSON.stringify(body), 'utf8');
  if (json.length > CONTROL_MAX_BYTES) throw new RangeError(`control of ${json.length} bytes is over ${CONTROL_MAX_BYTES}`);
  const h = Buffer.alloc(8);
  h.write('CVC1', 0, 4, 'latin1');
  h.writeUInt32LE(json.length, 4);
  return Buffer.concat([h, json]);
}

/** What the writer needs of a stream: a child's stdin and a `net.Socket` both fit. */
export interface FrameStream {
  readonly writable: boolean;
  write(chunk: Uint8Array): boolean;
  on(event: 'drain', cb: () => void): unknown;
  removeListener(event: 'drain', cb: () => void): unknown;
}

export interface PanelFrameWriter {
  /** Write to this stream from now on (a new helper's stdin, a new pipe connection), or to none. The newest frame goes out at once. */
  attach(stream: FrameStream | null): void;
  /** A frame from the panel (or, D7.4, the video): written now, or on the next drain. */
  push(frame: PanelFrame | VideoFrame): void;
  /** Forget the frame, stop the keepalive and let go of the stream. */
  clear(): void;
}

const pixelsOf = (f: PanelFrame | VideoFrame): Uint8Array => ('bgra' in f ? f.bgra : f.rgba);

export function createPanelFrameWriter(opts: { log: (line: string) => void; tag: string; magic?: string }): PanelFrameWriter {
  const magic = opts.magic ?? VR_OVERLAY_FRAME_MAGIC;
  let stream: FrameStream | null = null;
  let onDrain: (() => void) | null = null;
  /** The newest frame from the source, and whether the current stream has been sent it. */
  let latest: PanelFrame | VideoFrame | null = null;
  let latestSent = false;
  /** The last write returned false: wait for `drain` before writing again. */
  let blocked = false;
  let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;

  const stopKeepalive = () => {
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    keepaliveTimer = null;
  };

  const send = () => {
    const s = stream;
    if (!s || !s.writable || blocked || !latest || latestSent) return;
    const f = latest;
    latestSent = true;
    const px = pixelsOf(f);
    if (px.length !== f.width * f.height * 4) {
      opts.log(`${opts.tag}: dropped a ${f.width}x${f.height} frame of ${px.length} bytes (want ${f.width * f.height * 4})`);
      return;
    }
    let header: Buffer;
    try {
      header = frameHeader(f.width, f.height, magic);
    } catch (e) {
      opts.log(`${opts.tag}: dropped a frame: ${(e as Error).message}`);
      return;
    }
    s.write(header);
    blocked = !s.write(px); // the header shares the same buffer, so the second answer covers both
    stopKeepalive();
    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = null;
      latestSent = false;
      send(); // when blocked, `drain` sends it
    }, KEEPALIVE_MS);
  };

  const detach = () => {
    if (stream && onDrain) stream.removeListener('drain', onDrain);
    stream = null;
    onDrain = null;
    stopKeepalive();
  };

  return {
    attach(next) {
      detach();
      blocked = false;
      latestSent = false;
      if (!next) return;
      stream = next;
      const mine = () => {
        if (stream !== next) return;
        blocked = false;
        send();
      };
      onDrain = mine;
      next.on('drain', mine);
      send();
    },
    push(frame) {
      latest = frame;
      latestSent = false;
      send();
    },
    clear() {
      detach();
      latest = null;
      latestSent = false;
      blocked = false;
    },
  };
}
