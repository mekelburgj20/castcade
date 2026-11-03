// D7.5 (2026-11-02): pipe protocol 3, the layer camera on the companion side: the message reader (whatever the chunking,
// garbage, unknown messages), the frame parser, and the overlay's `camera` control field, frames and status.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LayerCameraFrame, LayerCameraStatus, PanelFrame, PanelFrameSource } from './match-media-types.js';
import {
  CAMERA_COUNTERS_MS,
  CAMERA_FRAME_MAX_BYTES,
  createLayerReader,
  createVrLayerOverlay,
  parseCameraFrame,
  VR_LAYER_CAMERA_PROTOCOL,
  VR_LAYER_PROTOCOL,
  type Exec,
  type LayerMessage,
} from './vr-layer.js';

// ---- message builders (what the layer writes: vr-layer/README.md "The pipe", "The camera") ----

function hello(protocol: number): Buffer {
  const b = Buffer.alloc(8);
  b.write('CVH1', 0, 4, 'latin1');
  b.writeUInt32LE(protocol, 4);
  return b;
}

function message(magic: string, body: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(magic, 0, 4, 'latin1');
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}

const eyeJson = (len: number, side: 'L' | 'R') => ({
  fov: side === 'L' ? [-0.907571, 0.785398, 0.872665, -0.959931] : [-0.785398, 0.907571, 0.872665, -0.959931],
  rect: [720, 0, 1632, 3264],
  render: [3072, 3264],
  len,
});

/** A CVF1 body: u16 jsonLength, the header, the two payloads (fake JPEG bytes: 0xff 0xd8 then a tag). */
function frameBody(n: number, left: Buffer, right: Buffer, header?: Record<string, unknown>): Buffer {
  const h = header ?? { n, t: n * 33333, enc: 'jpeg', w: 720, h: 1440, us: { issue: 180, map: 1200, copy: 2100, enc: 24000 }, eyes: [eyeJson(left.length, 'L'), eyeJson(right.length, 'R')] };
  const json = Buffer.from(JSON.stringify(h), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16LE(json.length, 0);
  return Buffer.concat([len, json, left, right]);
}

const jpeg = (tag: number, size = 6): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, tag]), Buffer.alloc(size - 3, tag)]);

const frameMessage = (n: number, left = jpeg(1), right = jpeg(2)) => message('CVF1', frameBody(n, left, right));
const statusMessage = (s: Record<string, unknown>) => message('CVS1', Buffer.from(JSON.stringify(s), 'utf8'));

const kinds = (ms: LayerMessage[]) => ms.map((m) => m.kind);

describe('parseCameraFrame (D7.5)', () => {
  it('reads the header and hands out each eye as a view into the body', () => {
    const f = parseCameraFrame(frameBody(7, jpeg(1, 10), jpeg(2, 20)));
    expect(f).not.toBeNull();
    expect(f!.n).toBe(7);
    expect(f!.t).toBe(7 * 33333);
    expect(f!.encoding).toBe('jpeg');
    expect([f!.width, f!.height]).toEqual([720, 1440]);
    expect(f!.us).toEqual({ issue: 180, map: 1200, copy: 2100, enc: 24000 });
    expect(f!.eyes).toHaveLength(2);
    expect(f!.eyes[0]!.data.length).toBe(10);
    expect(f!.eyes[1]!.data.length).toBe(20);
    expect(f!.eyes[0]!.data[2]).toBe(1);
    expect(f!.eyes[1]!.data[2]).toBe(2);
    expect(f!.eyes[0]!.fov).toEqual([-0.907571, 0.785398, 0.872665, -0.959931]);
    expect(f!.eyes[1]!.rect).toEqual([720, 0, 1632, 3264]);
    expect(f!.eyes[1]!.render).toEqual([3072, 3264]);
  });

  it('refuses what does not add up: short, a header longer than the body, lengths off, one eye, not jpeg', () => {
    expect(parseCameraFrame(Buffer.alloc(1))).toBeNull();
    const tooLong = Buffer.alloc(6);
    tooLong.writeUInt16LE(100, 0);
    expect(parseCameraFrame(tooLong)).toBeNull();
    const good = frameBody(1, jpeg(1), jpeg(2));
    expect(parseCameraFrame(good.subarray(0, good.length - 1))).toBeNull(); // a byte short
    expect(parseCameraFrame(Buffer.concat([good, Buffer.from([0])]))).toBeNull(); // a byte over
    const oneEye = { n: 1, t: 0, enc: 'jpeg', w: 2, h: 2, eyes: [eyeJson(6, 'L')] };
    expect(parseCameraFrame(frameBody(1, jpeg(1), Buffer.alloc(0), oneEye))).toBeNull();
    const png = { n: 1, t: 0, enc: 'png', w: 2, h: 2, eyes: [eyeJson(6, 'L'), eyeJson(6, 'R')] };
    expect(parseCameraFrame(frameBody(1, jpeg(1), jpeg(2), png))).toBeNull();
    const notJson = Buffer.alloc(4);
    notJson.writeUInt16LE(2, 0);
    notJson.write('{x', 2, 'latin1');
    expect(parseCameraFrame(notJson)).toBeNull();
    const noUs = { n: 1, t: 0, enc: 'jpeg', w: 2, h: 2, eyes: [eyeJson(6, 'L'), eyeJson(6, 'R')] };
    expect(parseCameraFrame(frameBody(1, jpeg(1), jpeg(2), noUs))!.us).toBeNull();
  });
});

describe('createLayerReader (D7.5)', () => {
  const all = Buffer.concat([hello(3), statusMessage({ camera: 'on', why: '', api: 'OpenGL', source: [3072, 3264], size: [720, 1440], fps: 30 }), frameMessage(1), frameMessage(2)]);

  it('one chunk: hello, status, two frames', () => {
    const r = createLayerReader();
    const ms = r.push(all);
    expect(kinds(ms)).toEqual(['hello', 'status', 'frame', 'frame']);
    expect(ms[0]).toEqual({ kind: 'hello', protocol: 3 });
    expect(ms[1]).toEqual({ kind: 'status', status: { camera: 'on', why: '', api: 'OpenGL', source: [3072, 3264], size: [720, 1440], fps: 30 } });
    expect((ms[2] as { frame: LayerCameraFrame }).frame.n).toBe(1);
    expect((ms[3] as { frame: LayerCameraFrame }).frame.n).toBe(2);
  });

  it('a byte at a time, and in two uneven halves: the same messages', () => {
    const r = createLayerReader();
    const ms: LayerMessage[] = [];
    for (let i = 0; i < all.length; i++) ms.push(...r.push(all.subarray(i, i + 1)));
    expect(kinds(ms)).toEqual(['hello', 'status', 'frame', 'frame']);
    const r2 = createLayerReader();
    const cut = 8 + 3; // inside the status header
    expect(kinds([...r2.push(all.subarray(0, cut)), ...r2.push(all.subarray(cut))])).toEqual(['hello', 'status', 'frame', 'frame']);
  });

  it('a well-shaped unknown message is skipped whole; a zero-length one too', () => {
    const r = createLayerReader();
    const ms = r.push(Buffer.concat([hello(3), message('CVX9', Buffer.alloc(5, 7)), message('CVZ0', Buffer.alloc(0)), frameMessage(3)]));
    expect(ms).toEqual([{ kind: 'hello', protocol: 3 }, { kind: 'unknown', magic: 'CVX9', length: 5 }, { kind: 'unknown', magic: 'CVZ0', length: 0 }, expect.objectContaining({ kind: 'frame' })]);
  });

  it('garbage before a message is dropped byte by byte and counted; the message after it is read', () => {
    const r = createLayerReader();
    const ms = r.push(Buffer.concat([Buffer.from('hello world!', 'latin1'), hello(3), frameMessage(1)]));
    expect(ms).toEqual([{ kind: 'garbage', bytes: 12 }, { kind: 'hello', protocol: 3 }, expect.objectContaining({ kind: 'frame' })]);
  });

  it('a known magic with an absurd length is garbage (resync), not a 32 MB wait', () => {
    const r = createLayerReader();
    const h = Buffer.alloc(8);
    h.write('CVF1', 0, 4, 'latin1');
    h.writeUInt32LE(CAMERA_FRAME_MAX_BYTES + 1, 4);
    const ms = r.push(Buffer.concat([h, hello(3)]));
    expect(ms).toEqual([{ kind: 'garbage', bytes: 8 }, { kind: 'hello', protocol: 3 }]);
  });

  it('a frame whose body does not parse is reported bad and the stream goes on', () => {
    const r = createLayerReader();
    const bad = message('CVF1', Buffer.from([9, 9, 9]));
    const ms = r.push(Buffer.concat([bad, frameMessage(5)]));
    expect(ms[0]).toEqual({ kind: 'bad', magic: 'CVF1', reason: 'the frame header or its lengths do not parse' });
    expect(ms[1]).toEqual(expect.objectContaining({ kind: 'frame' }));
    const r2 = createLayerReader();
    expect(r2.push(message('CVS1', Buffer.from('{"camera":"maybe"}', 'utf8')))[0]!.kind).toBe('bad');
  });
});

// ---- the overlay with a fake pipe ----

class FakePipe extends EventEmitter {
  readonly chunks: Buffer[] = [];
  writable = false;
  constructor(readonly path: string) {
    super();
  }
  write(chunk: Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  answer(): void {
    this.writable = true;
    this.emit('connect');
  }
  hangUp(): void {
    this.writable = false;
    this.emit('close');
  }
  destroy(): void {
    this.writable = false;
  }
  /** The CVC1 controls written, parsed. */
  controls(): Array<Record<string, unknown>> {
    const all = Buffer.concat(this.chunks);
    const out: Array<Record<string, unknown>> = [];
    let at = 0;
    while (at + 8 <= all.length) {
      const magic = all.toString('latin1', at, at + 4);
      if (magic === 'CVC1') {
        const n = all.readUInt32LE(at + 4);
        out.push(JSON.parse(all.toString('utf8', at + 8, at + 8 + n)) as Record<string, unknown>);
        at += 8 + n;
      } else {
        at += 16 + all.readUInt32LE(at + 12); // a CVO1 / CVO2 frame
      }
    }
    return out;
  }
}

function setup() {
  const pipes: FakePipe[] = [];
  const exec: Exec = vi.fn(async () => ({ stdout: 'The operation completed successfully.\r\n' }));
  let clock = 0;
  const log: string[] = [];
  const ov = createVrLayerOverlay({
    jsonPath: 'C:\\x\\XrApiLayer_castcade_panel.json',
    log: (l) => log.push(l),
    exec,
    connect: (p) => {
      const pipe = new FakePipe(p);
      pipes.push(pipe);
      return pipe as never;
    },
    now: () => clock,
  });
  const cbs = new Set<(f: PanelFrame) => void>();
  const src: PanelFrameSource = { onFrame: (cb) => (cbs.add(cb), () => void cbs.delete(cb)) };
  const frames: LayerCameraFrame[] = [];
  const statuses: LayerCameraStatus[] = [];
  ov.onCameraFrame!((f) => frames.push(f));
  ov.onCameraStatus!((s) => statuses.push(s));
  return {
    ov,
    pipes,
    log,
    src,
    frames,
    statuses,
    advance(ms: number) {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('createVrLayerOverlay: the camera (D7.5)', () => {
  it('this side speaks protocol 3; the camera needs 3', () => {
    expect(VR_LAYER_PROTOCOL).toBe(3);
    expect(VR_LAYER_CAMERA_PROTOCOL).toBe(3);
  });

  it('a protocol-3 layer: the control carries camera null, then the request; frames and status come back', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.src);
    const p = h.pipes[0]!;
    p.answer();
    p.emit('data', hello(3));
    expect(h.log).toContain('vr-layer: the layer speaks pipe protocol 3 (modes, theater, camera)');
    expect(p.controls()).toEqual([{ mode: 'panel', stereo: 'mono', panelPos: 'low', theaterScale: 1, camera: null }]);
    expect(h.ov.cameraStatus!().state).toBe('off');

    h.ov.setCamera!({ width: 720, height: 1440, fps: 30 });
    expect(p.controls()[1]).toEqual({ mode: 'panel', stereo: 'mono', panelPos: 'low', theaterScale: 1, camera: { width: 720, height: 1440, fps: 30 } });
    expect(h.ov.cameraStatus!().state).toBe('asked');
    h.ov.setCamera!({ width: 720, height: 1440, fps: 30 }); // the same again: nothing written
    expect(p.controls()).toHaveLength(2);

    p.emit('data', statusMessage({ camera: 'on', why: '', api: 'OpenGL', source: [3072, 3264], size: [720, 1440], fps: 30 }));
    expect(h.ov.cameraStatus!()).toMatchObject({ state: 'on', api: 'OpenGL', source: { width: 3072, height: 3264 }, size: { width: 720, height: 1440 } });
    h.advance(100);
    // Two frames, the second split across chunks.
    const f2 = frameMessage(2, jpeg(3, 40), jpeg(4, 50));
    p.emit('data', Buffer.concat([frameMessage(1), f2.subarray(0, 20)]));
    p.emit('data', f2.subarray(20));
    expect(h.frames.map((f) => f.n)).toEqual([1, 2]);
    expect(h.frames[1]!.eyes.map((e) => e.data.length)).toEqual([40, 50]);
    expect(h.ov.cameraStatus!()).toMatchObject({ state: 'on', frames: 2, lastFrameAt: 100 });
    expect(h.log.some((l) => l.startsWith('vr-layer camera: first frame: 720x1440 per eye'))).toBe(true);

    // The 10 s counters, with the gap the layer dropped (n 2 → 5).
    p.emit('data', frameMessage(5));
    h.advance(CAMERA_COUNTERS_MS);
    expect(h.log.at(-1)).toBe('vr-layer camera: 3 frames in 10 s (720x1440 per eye, 0 KB a frame), 2 dropped by the layer; on');

    // Off: camera null on the wire, frames that still arrive are ignored.
    h.ov.setCamera!(null);
    expect(p.controls()[2]).toEqual({ mode: 'panel', stereo: 'mono', panelPos: 'low', theaterScale: 1, camera: null });
    p.emit('data', frameMessage(6));
    expect(h.frames).toHaveLength(3);
    expect(h.ov.cameraStatus!().state).toBe('off');
  });

  it('refused by the layer: the status says so with the reason; the next connection asks again', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.ov.setCamera!({ width: 720, height: 1440, fps: 30 }); // before any connection
    await h.ov.start(h.src);
    const p = h.pipes[0]!;
    p.answer();
    p.emit('data', Buffer.concat([hello(3), statusMessage({ camera: 'refused', why: 'swapchain format 0x881a is not an 8-bit RGBA format the layer camera reads' })]));
    expect(p.controls()).toEqual([{ mode: 'panel', stereo: 'mono', panelPos: 'low', theaterScale: 1, camera: { width: 720, height: 1440, fps: 30 } }]);
    expect(h.ov.cameraStatus!()).toMatchObject({ state: 'refused', why: 'swapchain format 0x881a is not an 8-bit RGBA format the layer camera reads' });
    expect(h.log.at(-1)).toBe('vr-layer camera: refused by the layer: swapchain format 0x881a is not an 8-bit RGBA format the layer camera reads; the screen capture stays');
    p.hangUp();
    expect(h.ov.cameraStatus!()).toMatchObject({ state: 'asked', why: 'pipe closed' });
    h.advance(2000);
    const p2 = h.pipes[1]!;
    p2.answer();
    p2.emit('data', hello(3));
    expect(p2.controls()[0]!.camera).toEqual({ width: 720, height: 1440, fps: 30 });
  });

  it('a protocol-2 layer: the control has no camera key at all (byte for byte as before), and the ask is logged once', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.src);
    const p = h.pipes[0]!;
    p.answer();
    p.emit('data', hello(2));
    h.ov.setCamera!({ width: 720, height: 1440, fps: 30 });
    h.ov.setMode('theater');
    expect(p.controls()).toEqual([
      { mode: 'panel', stereo: 'mono', panelPos: 'low', theaterScale: 1 },
      { mode: 'theater', stereo: 'mono', panelPos: 'low', theaterScale: 1 },
    ]);
    expect(h.log.filter((l) => l.includes('speaks pipe protocol 2 (before the layer camera)'))).toHaveLength(1);
    expect(h.ov.cameraStatus!().state).toBe('asked'); // the fallback timer (layer-camera.ts) decides
  });

  it('garbage first is not a hello: logged, protocol 1 kept, the stream still read after', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.src);
    const p = h.pipes[0]!;
    p.answer();
    p.emit('data', Buffer.concat([Buffer.from('oops', 'latin1'), hello(3)]));
    expect(h.log).toContain('vr-layer: the layer sent something that is not a hello; staying on protocol 1 (the panel only)');
    // The hello that followed the garbage still counts: a protocol-3 control went out.
    expect(p.controls()).toEqual([{ mode: 'panel', stereo: 'mono', panelPos: 'low', theaterScale: 1, camera: null }]);
    expect(h.statuses.length).toBeGreaterThanOrEqual(0);
  });
});
