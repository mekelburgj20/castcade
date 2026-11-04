/**
 * D7.6 (the VR test bench) and D7.6.3 (saved theater frames) in the panel page's script, run on small fakes: the bench
 * canvas as the stage and the theater feed (path direct), the local WebRTC loop (path loop) under the match's bitrate
 * rule, the readout every second, and the JPEG save of what the feed hands to the layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_CHANNELS, panelPageHtml } from './panel-page.js';

class Track {
  static n = 0;
  readonly id = `t${++Track.n}`;
  readyState = 'live';
  muted = false;
  enabled = true;
  contentHint = '';
  constructor(readonly kind: 'audio' | 'video') {}
  stop(): void {
    this.readyState = 'ended';
  }
  addEventListener(): void {}
}
class Stream {
  static n = 0;
  readonly id = `s${++Stream.n}`;
  tracks: Track[];
  constructor(t: Track[] = []) {
    this.tracks = [...t];
  }
  getTracks(): Track[] {
    return [...this.tracks];
  }
  getVideoTracks(): Track[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks(): Track[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(t: Track): void {
    this.tracks.push(t);
  }
  removeTrack(t: Track): void {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}
class Ctx {
  calls: unknown[][] = [];
  fillStyle = '';
  font = '';
  textAlign = '';
  textBaseline = '';
  constructor(readonly canvas: Canvas) {}
  drawImage(...a: unknown[]): void {
    this.calls.push(['drawImage', ...a.filter((x) => typeof x === 'number')]);
  }
  fillRect(): void {}
  fillText(): void {}
  getImageData(_x: number, _y: number, w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4) };
  }
}
class Canvas {
  static all: Canvas[] = [];
  width = 300;
  height = 150;
  ctx = new Ctx(this);
  blobs: Array<{ type: string; quality: number; width: number; height: number }> = [];
  constructor() {
    Canvas.all.push(this);
  }
  getContext(): Ctx {
    return this.ctx;
  }
  captureStream(): Stream {
    return new Stream([new Track('video')]);
  }
  toBlob(cb: (b: Blob | null) => void, type: string, quality: number): void {
    this.blobs.push({ type, quality, width: this.width, height: this.height });
    cb(new Blob([new Uint8Array([0xff, 0xd8, this.blobs.length])], { type }));
  }
}
class Element {
  textContent = '';
  className = '';
  srcObject: unknown = null;
  videoWidth = 0;
  videoHeight = 0;
  readyState = 4;
  frames = 0;
  children: Element[] = [];
  getVideoPlaybackQuality() {
    return { totalVideoFrames: this.frames };
  }
  async play(): Promise<void> {}
  replaceChildren(): void {
    this.children = [];
  }
  appendChild(c: Element): void {
    this.children.push(c);
  }
  append(...c: Element[]): void {
    this.children.push(...c);
  }
}
class PC {
  static all: PC[] = [];
  listeners = new Map<string, Array<(e: unknown) => void>>();
  senders: Array<{ track: Track; params: { encodings: Array<{ maxBitrate?: number; maxFramerate?: number }> } }> = [];
  closed = false;
  bytes = 0;
  constructor(readonly config: unknown) {
    PC.all.push(this);
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  addTrack(track: Track) {
    const s = {
      track,
      params: { encodings: [{}] as Array<{ maxBitrate?: number; maxFramerate?: number }> },
      getParameters: () => s.params,
      setParameters: async (p: { encodings: Array<{ maxBitrate?: number }> }) => {
        s.params = p;
      },
    };
    this.senders.push(s);
    return s;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'o' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'a' };
  }
  async setLocalDescription(): Promise<void> {
    for (const cb of this.listeners.get('icecandidate') ?? []) cb({ candidate: { candidate: 'host' } });
  }
  async setRemoteDescription(d: { type: string }): Promise<void> {
    if (d.type === 'offer') for (const cb of this.listeners.get('track') ?? []) cb({ track: new Track('video') });
  }
  async addIceCandidate(): Promise<void> {}
  async getStats() {
    this.bytes += 1_000_000;
    const m = new Map<string, Record<string, unknown>>();
    if (this.senders.length) {
      // D7.6.8: the codec stat by codecId and Chromium's encoder implementation, as the readout names them.
      m.set('c', { type: 'codec', mimeType: 'video/VP8', clockRate: 90000 });
      m.set('o', { type: 'outbound-rtp', kind: 'video', codecId: 'c', encoderImplementation: 'libvpx', powerEfficientEncoder: false, frameWidth: 1440, frameHeight: 1440, bytesSent: this.bytes, framesPerSecond: 30, qualityLimitationReason: 'bandwidth' });
    }
    return m;
  }
  close(): void {
    this.closed = true;
  }
}

function loadPage() {
  const script = /<script>([\s\S]*)<\/script>/.exec(panelPageHtml({ vr: true }))?.[1] ?? '';
  const handlers = new Map<string, (e: unknown, arg: unknown) => void>();
  const sent: Array<{ channel: string; arg: unknown }> = [];
  const els = new Map<string, Element>();
  const document = {
    getElementById: (id: string) => {
      if (!els.has(id)) els.set(id, new Element());
      return els.get(id)!;
    },
    createElement: (tag: string) => (tag === 'canvas' ? new Canvas() : new Element()),
  };
  const navigator = { mediaDevices: { addEventListener: () => undefined, enumerateDevices: async () => [], getUserMedia: async () => new Stream([new Track('audio')]) } };
  const electron = { ipcRenderer: { on: (ch: string, cb: (e: unknown, arg: unknown) => void) => handlers.set(ch, cb), send: (channel: string, arg?: unknown) => sent.push({ channel, arg }) } };
  class Audio {
    srcObject: unknown = null;
    play = async () => undefined;
  }
  const intervals: Array<{ cb: () => void; ms: number }> = [];
  const run = new Function('require', 'document', 'navigator', 'MediaStream', 'RTCPeerConnection', 'Audio', 'setInterval', 'clearInterval', script);
  run(() => electron, document, navigator, Stream, PC, Audio, (cb: () => void, ms: number) => intervals.push({ cb, ms }), () => undefined);
  const emit = (ch: string, arg?: unknown): void => handlers.get(ch)?.({}, arg);
  const on = (ch: string) => sent.filter((s) => s.channel === ch).map((s) => s.arg);
  const tick = (ms: number) => intervals.filter((i) => i.ms === ms).forEach((i) => i.cb());
  return { emit, on, tick, el: (id: string) => document.getElementById(id) };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const jpg = new Uint8Array([0xff, 0xd8, 0xff]);
const GEO = { fov: [-0.9, 0.8, 0.9, -0.95], rect: [0, 0, 64, 128], render: [64, 128] };
const frame = (n: number, o: Record<string, unknown> = {}) => ({ n, width: 64, height: 128, left: jpg, right: jpg, stereo: 'sbs', eyes: [GEO, GEO], ...o });
const FEED_MS = Math.round(1000 / 30);

beforeEach(() => {
  Canvas.all = [];
  PC.all = [];
  vi.stubGlobal('createImageBitmap', async (b: Blob) => {
    if (!(b instanceof Blob) || b.type !== 'image/jpeg') throw new Error('not a JPEG');
    return { width: 64, height: 128, close: () => undefined };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the VR test bench in the panel page (D7.6)', () => {
  it('path direct: the bench canvas is the stage; frames draw both eyes side by side, are acked, and feed the layer by the theater path', async () => {
    const p = loadPage();
    p.emit(PANEL_CHANNELS.bench, { path: 'direct', source: 'clip' });
    expect(p.el('head').textContent).toBe('VR TEST BENCH');
    expect(p.el('idle').textContent).toBe('WAITING FOR FRAMES');
    const bc = Canvas.all.at(-1)!;
    expect((p.el('video').srcObject as Stream).getVideoTracks()[0]!.contentHint).toBe('detail');
    p.emit(PANEL_CHANNELS.benchFrame, frame(1));
    await settle();
    expect([bc.width, bc.height]).toEqual([128, 128]);
    expect(bc.ctx.calls).toEqual([
      ['drawImage', 0, 0, 64, 128, 0, 0, 64, 128],
      ['drawImage', 0, 0, 64, 128, 64, 0, 64, 128],
    ]);
    expect(p.on(PANEL_CHANNELS.benchAck)).toHaveLength(1);
    expect(p.el('idle').textContent).toBe('');
    // Not wanted by the layer: nothing handed over.
    p.tick(FEED_MS);
    expect(p.on(PANEL_CHANNELS.video)).toHaveLength(0);
    p.emit(PANEL_CHANNELS.videoWant, true);
    p.tick(FEED_MS);
    expect(p.on(PANEL_CHANNELS.video)).toMatchObject([{ width: 128, height: 128, stereo: 'sbs' }]);
    p.tick(FEED_MS); // one in flight, and no new frame drawn
    expect(p.on(PANEL_CHANNELS.video)).toHaveLength(1);
    p.emit(PANEL_CHANNELS.videoAck);
    p.tick(FEED_MS); // acked, but still the same frame
    expect(p.on(PANEL_CHANNELS.video)).toHaveLength(1);
    // A received (whole) picture, mono: the canvas takes its size.
    p.emit(PANEL_CHANNELS.benchFrame, frame(2, { right: null, width: 64, height: 128, stereo: 'mono', eyes: null }));
    await settle();
    expect([bc.width, bc.height]).toEqual([64, 128]);
    p.tick(FEED_MS);
    expect(p.on(PANEL_CHANNELS.video).at(-1)).toMatchObject({ width: 64, height: 128, stereo: 'mono' });
    // A frame that does not decode is counted and acked.
    p.emit(PANEL_CHANNELS.benchFrame, frame(3, { left: new Uint8Array(0) }));
    await settle();
    expect(p.on(PANEL_CHANNELS.benchAck)).toHaveLength(3);
    p.tick(1000);
    await settle();
    expect(p.on(PANEL_CHANNELS.benchStatus).at(-1)).toEqual({ path: 'direct', drawn: 2, bad: 1, fed: { width: 64, height: 128, stereo: 'mono' }, fedFrames: 2, sent: null, bitrate: null, loopUp: true, error: null });
    // The bench ends with the page's detach.
    p.emit(PANEL_CHANNELS.detach);
    expect(p.el('head').textContent).toBe('CASTCADE MATCH');
    p.tick(1000);
    await settle();
    expect(p.on(PANEL_CHANNELS.benchStatus)).toHaveLength(1);
  });

  it('path loop: two connections in the page, the canvas track sent under the match’s bitrate rule, the received track is the stage and the feed; the readout has the encoder', async () => {
    const p = loadPage();
    p.emit(PANEL_CHANNELS.bench, { path: 'loop', source: 'live' });
    await settle();
    expect(PC.all).toHaveLength(2);
    const [a, b] = PC.all as [PC, PC];
    expect(a.senders).toHaveLength(1);
    expect(b.senders).toHaveLength(0);
    const stage = p.el('video');
    expect((stage.srcObject as Stream).getVideoTracks()[0]).not.toBe(a.senders[0]!.track); // the received track, not the canvas's
    expect(a.senders[0]!.params.encodings[0]).toMatchObject({ maxBitrate: 2_500_000, maxFramerate: 30 });
    p.emit(PANEL_CHANNELS.benchFrame, frame(1, { width: 720, height: 1440 }));
    await settle();
    // 1440x1440 side by side: the match's cap for that shape (videoBitrateFor), 8 Mbps.
    expect(a.senders[0]!.params.encodings[0]!.maxBitrate).toBe(8_000_000);
    p.emit(PANEL_CHANNELS.videoWant, true);
    stage.videoWidth = 1440;
    stage.videoHeight = 1440;
    stage.frames = 5;
    p.tick(FEED_MS);
    expect(p.on(PANEL_CHANNELS.video)).toMatchObject([{ width: 1440, height: 1440, stereo: 'sbs' }]);
    p.tick(1000);
    await settle();
    p.tick(1000);
    await settle();
    const r = p.on(PANEL_CHANNELS.benchStatus).at(-1) as { path: string; sent: { width: number; kbps: number | null; fps: number; limit: string; codec: string | null; encoder: string | null }; bitrate: number; loopUp: boolean };
    expect(r).toMatchObject({ path: 'loop', bitrate: 8_000_000, loopUp: true, sent: { width: 1440, fps: 30, limit: 'bandwidth', codec: 'VP8', encoder: 'libvpx' } });
    p.emit(PANEL_CHANNELS.bench, null);
    expect(a.closed && b.closed).toBe(true);
  });

  it('path loop with a bitrate cap override: the cap is set on the sender whatever the size, and the readout reports it (D7.6.9)', async () => {
    const p = loadPage();
    p.emit(PANEL_CHANNELS.bench, { path: 'loop', source: 'live', bitrate: 16_000_000 });
    await settle();
    const [a] = PC.all as [PC, PC];
    expect(a.senders[0]!.params.encodings[0]).toMatchObject({ maxBitrate: 16_000_000, maxFramerate: 30 });
    p.emit(PANEL_CHANNELS.benchFrame, frame(1, { width: 720, height: 1440 }));
    await settle();
    expect(a.senders[0]!.params.encodings[0]!.maxBitrate).toBe(16_000_000); // not the rule's 8 Mbps for 1440x1440 sbs
    p.tick(1000);
    await settle();
    expect(p.on(PANEL_CHANNELS.benchStatus).at(-1)).toMatchObject({ path: 'loop', bitrate: 16_000_000 });
    p.emit(PANEL_CHANNELS.bench, null);
  });
});

describe('saved theater frames in the panel page (D7.6.3)', () => {
  it('each frame handed to the layer is JPEG-encoded at its own size (quality 90), until the time or the count is up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = loadPage();
      p.emit(PANEL_CHANNELS.bench, { path: 'direct', source: 'clip' });
      p.emit(PANEL_CHANNELS.videoWant, true);
      p.emit(PANEL_CHANNELS.saveFrames, { ms: 2000, max: 2 });
      for (let n = 1; n <= 3; n++) {
        p.emit(PANEL_CHANNELS.benchFrame, frame(n));
        await settle();
        p.emit(PANEL_CHANNELS.videoAck);
        p.tick(FEED_MS);
        await settle();
      }
      const saved = p.on(PANEL_CHANNELS.savedFrame) as Array<{ i: number; jpeg: Uint8Array; width: number; height: number; stereo: string; eyes: unknown; source: string; skipped: number }>;
      expect(saved.map((s) => [s.i, s.width, s.height, s.stereo, s.source])).toEqual([
        [0, 128, 128, 'sbs', 'bench (direct)'],
        [1, 128, 128, 'sbs', 'bench (direct)'],
      ]);
      expect(saved[0]!.jpeg).toBeInstanceOf(Uint8Array);
      expect(saved[0]!.eyes).toEqual([GEO, GEO]);
      const save = Canvas.all.find((c) => c.blobs.length > 0)!;
      expect(save.blobs[0]).toEqual({ type: 'image/jpeg', quality: 0.9, width: 128, height: 128 });
      // A new save, then past its time: nothing more.
      p.emit(PANEL_CHANNELS.saveFrames, { ms: 2000, max: 120 });
      vi.advanceTimersByTime(2500);
      p.emit(PANEL_CHANNELS.benchFrame, frame(4));
      await settle();
      p.emit(PANEL_CHANNELS.videoAck);
      p.tick(FEED_MS);
      await settle();
      expect(p.on(PANEL_CHANNELS.savedFrame)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
