import { describe, expect, it, vi } from 'vitest';
import type { PanelState } from './match-media-types.js';
import { feedSize, headerText, micText, PANEL_CHANNELS, paintFrame, panelPageHtml, SBS_MIN_ASPECT, scoreText, stageText, stallStep, CAPTURE_STALL_MS, STATS_MS, stereoOf, stripRows, VIDEO_FEED_MAX, videoCropRect, videoPeer, type Paint2D } from './panel-page.js';

const state = (o: Partial<PanelState> = {}): PanelState => ({
  playerUp: 'krobs',
  myTurn: false,
  ball: 2,
  ballsPerGame: 3,
  players: [
    { id: 'owner', name: 'Owner', score: 1_234_560, ballsDone: 2, isUp: false, flags: [] },
    { id: 'krobs', name: 'Krobs', score: 990_000, ballsDone: 1, isUp: true, flags: ['table_mismatch'] },
  ],
  phase: 'playing',
  result: null,
  message: null,
  mic: 'open',
  ...o,
});

describe('panel text (D2)', () => {
  it('header: YOUR BALL n when I am up, <NAME> IS UP otherwise, the phase when nobody is', () => {
    expect(headerText(state({ myTurn: true, playerUp: 'owner' }))).toBe('YOUR BALL 2');
    expect(headerText(state())).toBe('KROBS IS UP');
    expect(headerText(state({ phase: 'paused' }))).toBe('PAUSED · KROBS IS UP');
    expect(headerText(state({ phase: 'idle', playerUp: null, ball: null }))).toBe('WAITING FOR THE START');
    expect(headerText(state({ phase: 'over' }))).toBe('MATCH OVER');
    expect(headerText(state({ playerUp: null, ball: null }))).toBe('WAITING');
  });

  it('strip: the controller order while playing, with the ball, balls done and flags; standings by place when over', () => {
    expect(stripRows(state())).toEqual([
      { id: 'owner', name: 'Owner', score: '1,234,560', detail: '2/3', up: false, flags: [], notes: [] },
      { id: 'krobs', name: 'Krobs', score: '990,000', detail: 'BALL 2', up: true, flags: ['DIFFERENT TABLE'], notes: [] },
    ]);
    // D2.5 (2026-10-31): a different VPX build is a muted note, not a red flag; with a different table, both.
    const build = state({ players: [{ id: 'krobs', name: 'Krobs', score: null, ballsDone: 0, isUp: false, flags: ['build_mismatch'] }] });
    expect(stripRows(build)[0]).toMatchObject({ flags: [], notes: ['DIFFERENT VPX BUILD'] });
    const both = state({ players: [{ id: 'krobs', name: 'Krobs', score: null, ballsDone: 0, isUp: false, flags: ['table_mismatch', 'build_mismatch'] }] });
    expect(stripRows(both)[0]).toMatchObject({ flags: ['DIFFERENT TABLE'], notes: ['DIFFERENT VPX BUILD'] });
    const done = state({ players: [{ id: 'owner', name: 'Owner', score: null, ballsDone: 3, isUp: false, flags: ['disconnected'] }] });
    expect(stripRows(done)[0]).toMatchObject({ score: '–', detail: 'DONE', flags: ['OFFLINE'] });
    const over = state({
      phase: 'over',
      result: [
        { id: 'krobs', name: 'Krobs', score: 2_000_000, place: 2 },
        { id: 'owner', name: 'Owner', score: 3_000_000, place: 1 },
      ],
    });
    expect(stripRows(over).map((r) => [r.name, r.detail, r.score])).toEqual([
      ['Owner', '#1', '3,000,000'],
      ['Krobs', '#2', '2,000,000'],
    ]);
  });

  it('stage: my own preview when I am up, the up player otherwise, nothing before the start or after the result', () => {
    expect(videoPeer(state({ myTurn: true }))).toBe('self');
    expect(videoPeer(state())).toBe('krobs');
    expect(videoPeer(state({ phase: 'paused' }))).toBe('krobs');
    expect(videoPeer(state({ phase: 'idle' }))).toBeNull();
    expect(videoPeer(state({ phase: 'over' }))).toBeNull();
    expect(stageText(state(), false)).toBe("WAITING FOR KROBS'S TABLE");
    expect(stageText(state(), true)).toBe('');
    expect(stageText(state({ myTurn: true }), false)).toBe('NO PICTURE FROM YOUR TABLE');
    expect(stageText(null, false)).toBe('');
  });

  it('mic and score formatting', () => {
    expect([micText('open'), micText('muted'), micText('unavailable')]).toEqual(['MIC ON', 'MIC MUTED', 'NO MIC']);
    expect(scoreText(0)).toBe('0');
    expect(scoreText(null)).toBe('–');
  });
});

// ---- D2.5: the crop and the cover, drawn onto the canvas ----

const CAP = { sourceId: 'screen:0:0', label: 'screen 1, crop 1280x720 of Visual Pinball Player', screen: { width: 2560, height: 1440 }, crop: { x: 100, y: 200, width: 1280, height: 720 }, out: { width: 1280, height: 720 } };

function fakeCtx() {
  const calls: Array<[string, ...unknown[]]> = [];
  const ctx: Paint2D & { calls: typeof calls; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } = {
    calls,
    getImageData: (x: number, y: number, w: number, h: number) => {
      calls.push(['getImageData', x, y, w, h]);
      return { data: new Uint8ClampedArray(w * h * 4) };
    },
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect: (...a: number[]) => calls.push(['fillRect', ...a]),
    fillText: (t: string, x: number, y: number) => calls.push(['fillText', t, x, y]),
    drawImage: (_src: unknown, ...a: number[]) => calls.push(['drawImage', ...a]),
  };
  return ctx;
}

describe('match video crop (D2.5)', () => {
  it('the crop in the video\'s own pixels: as given at the display\'s size, scaled when Chromium delivers it smaller, clamped, none before a frame', () => {
    expect(videoCropRect(CAP, 2560, 1440)).toEqual({ sx: 100, sy: 200, sw: 1280, sh: 720 });
    expect(videoCropRect(CAP, 1280, 720)).toEqual({ sx: 50, sy: 100, sw: 640, sh: 360 });
    expect(videoCropRect({ ...CAP, crop: { x: 2000, y: 1000, width: 1280, height: 720 } }, 2560, 1440)).toEqual({ sx: 2000, sy: 1000, sw: 560, sh: 440 });
    expect(videoCropRect(CAP, 0, 0)).toBeNull();
  });

  it('paints the crop at the output size; covered, a dark frame saying "Paused: back in a moment"; no frame yet, nothing', () => {
    const ctx = fakeCtx();
    expect(paintFrame(ctx, { videoWidth: 2560, videoHeight: 1440 }, CAP, false)).toBe('crop');
    expect(ctx.calls).toEqual([['drawImage', 100, 200, 1280, 720, 0, 0, 1280, 720]]);
    ctx.calls.length = 0;
    expect(paintFrame(ctx, { videoWidth: 2560, videoHeight: 1440 }, CAP, true)).toBe('cover');
    expect(ctx.calls).toEqual([
      ['fillRect', 0, 0, 1280, 720],
      ['fillText', 'Paused: back in a moment', 640, 360],
    ]);
    expect(ctx.font).toMatch(/^700 60px /);
    // A portrait crop: the text is sized by the width so it fits.
    paintFrame(ctx, { videoWidth: 0, videoHeight: 0 }, { ...CAP, out: { width: 404, height: 720 } }, true);
    expect(ctx.font).toMatch(/^700 25px /);
    ctx.calls.length = 0;
    expect(paintFrame(ctx, { videoWidth: 0, videoHeight: 0 }, CAP, false)).toBe('blank');
    expect(ctx.calls).toEqual([]);
  });
});

// ---- the page's script, run on fakes: it parses, renders PanelState, and drives a connection per peer ----

class FakeTrack {
  enabled = true;
  muted = false;
  readyState = 'live';
  contentHint = '';
  private static n = 0;
  readonly id = `t${++FakeTrack.n}`;
  constructor(readonly kind: 'audio' | 'video') {}
  stop(): void {
    this.readyState = 'ended';
  }
  addEventListener(): void {}
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: FakeTrack): void {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack): void {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

class FakeElement {
  textContent = '';
  className = '';
  srcObject: unknown = null;
  videoWidth = 2560;
  videoHeight = 1440;
  children: FakeElement[] = [];
  async play(): Promise<void> {}
  appendChild(c: FakeElement): void {
    this.children.push(c);
  }
  append(...c: FakeElement[]): void {
    this.children.push(...c);
  }
  replaceChildren(): void {
    this.children = [];
  }
  text(): string {
    return [this.textContent, ...this.children.map((c) => c.text())].join(' ').trim();
  }
}

class FakePeerConnection {
  static all: FakePeerConnection[] = [];
  signalingState = 'stable';
  iceConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: unknown = null;
  senders: { track: FakeTrack; params: { encodings: { maxBitrate?: number; maxFramerate?: number }[] } }[] = [];
  closed = false;
  candidates: unknown[] = [];
  constructor(readonly config: unknown) {
    FakePeerConnection.all.push(this);
  }
  /** D2.7: the remote connection a description came from (`session:<x>` in the fake SDP), as Chromium tells them apart. */
  static session(sdp: string | undefined): string | null {
    return /session:(\w+)/.exec(sdp ?? '')?.[1] ?? null;
  }
  addEventListener(): void {}
  addTrack(track: FakeTrack) {
    const s = {
      track,
      params: { encodings: [{}] as { maxBitrate?: number; maxFramerate?: number }[] },
      replaceTrack: async (t: FakeTrack) => {
        s.track = t;
      },
      getParameters: () => s.params,
      setParameters: async (p: { encodings: { maxBitrate?: number }[] }) => {
        s.params = p;
      },
    };
    this.senders.push(s);
    return s;
  }
  async setLocalDescription(d?: { type: string }): Promise<void> {
    if (d?.type === 'rollback') {
      this.signalingState = 'stable';
      return;
    }
    if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: 'answer-sdp' };
      this.signalingState = 'stable';
      this.iceConnectionState = 'connected';
      return;
    }
    this.localDescription = { type: 'offer', sdp: 'offer-sdp' };
    this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> {
    if (d.type === 'offer') {
      // D2.7: what the owner's rig logged when a rebuilt page's fresh connection offered onto this one.
      const had = FakePeerConnection.session(this.remoteDescription?.sdp);
      if (had !== null && had !== FakePeerConnection.session(d.sdp)) {
        throw new Error("Failed to set remote offer sdp: The order of m-lines in subsequent offer doesn't match order from previous offer/answer.");
      }
      this.remoteDescription = d;
      this.signalingState = 'have-remote-offer';
      return;
    }
    this.remoteDescription = d;
    this.signalingState = 'stable';
    this.iceConnectionState = 'connected';
  }
  async addIceCandidate(c: unknown): Promise<void> {
    this.candidates.push(c);
  }
  restartIce(): void {}
  close(): void {
    this.closed = true;
  }
}

class FakeCanvas {
  static last: FakeCanvas | null = null;
  width = 300;
  height = 150;
  ctx = fakeCtx();
  streams: FakeStream[] = [];
  constructor() {
    FakeCanvas.last = this;
  }
  getContext(): Paint2D {
    return this.ctx;
  }
  captureStream(): FakeStream {
    const s = new FakeStream([new FakeTrack('video')]);
    this.streams.push(s);
    return s;
  }
}

function loadPage(media: { mic: boolean; capture: boolean }) {
  const html = panelPageHtml({ vr: true });
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
  const handlers = new Map<string, (e: unknown, arg: unknown) => void>();
  const sent: { channel: string; arg: unknown }[] = [];
  const els = new Map<string, FakeElement>();
  const document = {
    getElementById: (id: string) => {
      if (!els.has(id)) els.set(id, new FakeElement());
      return els.get(id)!;
    },
    createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas() : new FakeElement()),
  };
  const captures: Array<{ constraints: unknown; track: FakeTrack }> = [];
  const gum = async (c: { audio?: unknown; video?: unknown }) => {
    if (c.video) {
      if (!media.capture) throw new Error('capture refused');
      const track = new FakeTrack('video');
      captures.push({ constraints: c.video, track });
      return new FakeStream([track]);
    }
    if (!media.mic) throw new Error('NotFoundError');
    return new FakeStream([new FakeTrack('audio')]);
  };
  const navigator = {
    mediaDevices: {
      getUserMedia: gum,
      getDisplayMedia: async () => {
        throw new Error('no display media');
      },
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'hs', label: 'Headset' }, { kind: 'videoinput', deviceId: 'cam', label: 'Cam' }],
      addEventListener: () => undefined,
    },
  };
  const electron = {
    ipcRenderer: {
      on: (ch: string, cb: (e: unknown, arg: unknown) => void) => handlers.set(ch, cb),
      send: (channel: string, arg?: unknown) => sent.push({ channel, arg }),
    },
  };
  class FakeAudio {
    autoplay = false;
    srcObject: unknown = null;
    play = async () => undefined;
  }
  FakePeerConnection.all = [];
  const intervals: Array<{ cb: () => void; ms: number }> = [];
  const run = new Function('require', 'document', 'navigator', 'MediaStream', 'RTCPeerConnection', 'Audio', 'setInterval', 'clearInterval', script);
  run(() => electron, document, navigator, FakeStream, FakePeerConnection, FakeAudio, (cb: () => void, ms: number) => intervals.push({ cb, ms }), () => undefined);
  const canvas = FakeCanvas.last!;
  const emit = (ch: string, arg?: unknown): void => handlers.get(ch)?.({}, arg);
  return { html, script, sent, emit, el: (id: string) => document.getElementById(id), handlers, canvas, captures, intervals };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe('panel page script (D2)', () => {
  it('is one page with the channels, the helpers and the negotiation classes embedded', () => {
    const { html, script } = loadPage({ mic: true, capture: true });
    expect(html).toContain('<body class="vr">');
    expect(panelPageHtml({ vr: false })).toContain('<body class="desktop">');
    for (const name of ['function headerText', 'function stripRows', 'function videoCropRect', 'function paintFrame', 'class PeerNegotiator', 'class SignalingMesh', 'function isPolite']) expect(script).toContain(name);
    expect(script).toContain(PANEL_CHANNELS.attach);
    expect(script).not.toContain('innerHTML');
  });

  it('says it is ready on load and renders PanelState as given, names through textContent only', async () => {
    const p = loadPage({ mic: true, capture: true });
    expect(p.sent.map((s) => s.channel)).toContain(PANEL_CHANNELS.ready);
    expect(p.el('head').textContent).toBe('CASTCADE MATCH');
    p.emit(PANEL_CHANNELS.state, state({ myTurn: true, playerUp: 'owner', players: [{ id: 'owner', name: '<b>Owner</b>', score: 10, ballsDone: 1, isUp: true, flags: [] }] }));
    expect(p.el('head').textContent).toBe('YOUR BALL 2');
    expect(p.el('head').className).toBe('mine');
    expect(p.el('strip').text()).toContain('<b>Owner</b>');
    expect(p.el('mic').textContent).toBe('MIC ON');
    p.emit(PANEL_CHANNELS.state, state({ message: 'different table file', mic: 'muted' }));
    expect(p.el('msg').textContent).toBe('different table file');
    expect(p.el('mic').textContent).toBe('MIC MUTED');
  });

  it('attach: mic and capture on every connection, video enabled only while sending, 2.5 Mbps cap, offers addressed to the peer', async () => {
    const p = loadPage({ mic: true, capture: true });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs', 'third'], ice: [{ urls: ['stun:x'] }], capture: CAP, micDeviceId: 'hs', muted: false, sending: false });
    await settle();
    expect(FakePeerConnection.all).toHaveLength(2);
    expect(FakePeerConnection.all[0]?.config).toEqual({ iceServers: [{ urls: ['stun:x'] }], bundlePolicy: 'max-bundle' });
    const pc = FakePeerConnection.all[0]!;
    expect(pc.senders.map((s) => s.track.kind)).toEqual(['audio', 'video']);
    const video = pc.senders[1]!;
    expect(video.track.enabled).toBe(false);
    expect(video.params.encodings[0]).toEqual({ maxBitrate: 2_500_000, maxFramerate: 30 });
    expect(video.track.contentHint).toBe('motion');
    p.emit(PANEL_CHANNELS.sending, true);
    expect(video.track.enabled).toBe(true);
    // the browser asks for negotiation; the offer goes to main addressed to that peer
    pc.onnegotiationneeded?.();
    await settle();
    expect(p.sent.filter((s) => s.channel === PANEL_CHANNELS.send).map((s) => s.arg)).toEqual([{ to: 'krobs', signal: { kind: 'offer', sdp: 'offer-sdp' } }]);
    // its answer comes back through main
    p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'answer', sdp: 'answer-sdp' } });
    await settle();
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'answer-sdp' });
    const devices = p.sent.filter((s) => s.channel === PANEL_CHANNELS.devices).pop();
    expect(devices?.arg).toEqual([{ deviceId: 'hs', label: 'Headset' }]);
    // mute toggles the mic track, removePeer closes that connection, detach closes all
    p.emit(PANEL_CHANNELS.muted, true);
    expect(pc.senders[0]?.track.enabled).toBe(false);
    p.emit(PANEL_CHANNELS.removePeer, 'krobs');
    expect(pc.closed).toBe(true);
    p.emit(PANEL_CHANNELS.detach);
    expect(FakePeerConnection.all.every((x) => x.closed)).toBe(true);
  });

  it('D2.7: a fresh offer onto an established connection (the peer rebuilt its page) reopens it and ends connected', async () => {
    const p = loadPage({ mic: true, capture: false });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: null, micDeviceId: null, muted: false, sending: false });
    await settle();
    const first = FakePeerConnection.all[0]!;
    first.onnegotiationneeded?.();
    await settle();
    p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'answer', sdp: 'answer session:k1' } });
    await settle();
    expect(first.iceConnectionState).toBe('connected');

    // Krobs's panel moved into the headset (an older companion: no reset): his fresh connection offers, then its ICE.
    p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'offer', sdp: 'offer session:k2' } });
    p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'ice', candidate: { candidate: 'candidate:9 1 udp 1 10.0.0.9 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } } });
    await settle();
    expect(first.closed).toBe(true);
    expect(FakePeerConnection.all).toHaveLength(2);
    const fresh = FakePeerConnection.all[1]!;
    expect(fresh.remoteDescription).toEqual({ type: 'offer', sdp: 'offer session:k2' });
    expect(fresh.candidates).toHaveLength(1);
    expect(fresh.iceConnectionState).toBe('connected');
    expect(fresh.senders.map((s) => s.track.kind)).toEqual(['audio']);
    const sent = p.sent.filter((s) => s.channel === PANEL_CHANNELS.send).map((s) => s.arg);
    expect(sent.at(-1)).toEqual({ to: 'krobs', signal: { kind: 'answer', sdp: 'answer-sdp' } });
    // the report names the connection's state and the reopen; no error line
    p.intervals.find((i) => i.ms === 2000)!.cb();
    const st = p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { error: string | null; peers: Record<string, { ice: string; signaling: string; reopens: number }> };
    expect(st.peers['krobs']).toMatchObject({ ice: 'connected', signaling: 'stable', reopens: 1 });
    expect(st.error).toBeNull();
  });

  it('D2.7: a reset reopens the connection before the offer; a rebuilt page sends reset to every peer first', async () => {
    const p = loadPage({ mic: true, capture: true });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: null, micDeviceId: null, muted: false, sending: false });
    await settle();
    const first = FakePeerConnection.all[0]!;
    p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'offer', sdp: 'offer session:k1' } });
    await settle();
    expect(first.iceConnectionState).toBe('connected');
    p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'reset' } });
    expect(first.closed).toBe(true);
    p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'offer', sdp: 'offer session:k2' } });
    await settle();
    expect(FakePeerConnection.all.at(-1)?.iceConnectionState).toBe('connected');
    p.intervals.find((i) => i.ms === 2000)!.cb();
    const st = p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { error: string | null; peers: Record<string, { reopens: number }> };
    expect(st.peers['krobs']?.reopens).toBe(1);
    expect(st.error).toBeNull();

    // The mover's side: a re-attach with `reset` says so to each peer before its connections offer; its stereo follows.
    const m = loadPage({ mic: true, capture: true });
    m.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs', 'third'], ice: [], capture: { ...CAP, stereo: 'sbs' }, micDeviceId: null, muted: false, sending: false, reset: true });
    await settle();
    for (const pc of FakePeerConnection.all) pc.onnegotiationneeded?.();
    await settle();
    const kinds = m.sent.filter((s) => s.channel === PANEL_CHANNELS.send).map((s) => s.arg as { to: string; signal: { kind: string; stereo?: string } });
    expect(kinds.slice(0, 2)).toEqual([
      { to: 'krobs', signal: { kind: 'reset' } },
      { to: 'third', signal: { kind: 'reset' } },
    ]);
    expect(kinds.filter((k) => k.signal.kind === 'stereo')).toEqual([
      { to: 'krobs', signal: { kind: 'stereo', stereo: 'sbs' } },
      { to: 'third', signal: { kind: 'stereo', stereo: 'sbs' } },
    ]);
    expect(kinds.filter((k) => k.signal.kind === 'offer')).toHaveLength(2);
    // a later capture that says one eye goes to every peer once
    m.emit(PANEL_CHANNELS.capture, { ...CAP, stereo: 'mono' });
    m.emit(PANEL_CHANNELS.capture, { ...CAP, stereo: 'mono' });
    await settle();
    const later = m.sent.filter((s) => s.channel === PANEL_CHANNELS.send).map((s) => s.arg as { signal: { kind: string; stereo?: string } });
    expect(later.filter((k) => k.signal.kind === 'stereo' && k.signal.stereo === 'mono')).toHaveLength(2);
  });

  it('no microphone and no capture: the mesh still opens (receive only) and the status says why', async () => {
    const p = loadPage({ mic: false, capture: false });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: CAP, micDeviceId: null, muted: false, sending: false });
    await settle();
    expect(FakePeerConnection.all).toHaveLength(1);
    expect(FakePeerConnection.all[0]?.senders).toEqual([]);
    const st = p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { mic: string; capturing: boolean; error: string; peers: Record<string, { ice: string }> };
    expect(st.mic).toBe('unavailable');
    expect(st.capturing).toBe(false);
    expect(st.error).toMatch(/Could not capture screen 1, crop 1280x720 of Visual Pinball Player|No microphone/);
    expect(st.peers['krobs']?.ice).toBe('new');
  });

  it('D2.5: films the screen at its own size, sends the canvas track; a moved window re-crops without a new capture; the cover; null stops it', async () => {
    const p = loadPage({ mic: true, capture: true });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: CAP, micDeviceId: null, muted: false, sending: false });
    await settle();
    expect(p.captures).toHaveLength(1);
    expect(p.captures[0]?.constraints).toEqual({ mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0', maxWidth: 2560, maxHeight: 1440, maxFrameRate: 30 } });
    expect(p.el('src').srcObject).not.toBeNull();
    expect([p.canvas.width, p.canvas.height]).toEqual([1280, 720]);
    // The peers get the canvas's track, not the screen's.
    const sender = FakePeerConnection.all[0]!.senders.find((s) => s.track.kind === 'video')!;
    expect(sender.track).toBe(p.canvas.streams[0]?.getVideoTracks()[0]);
    expect(sender.track).not.toBe(p.captures[0]?.track);
    expect(sender.track.contentHint).toBe('motion');

    // The draw loop: a 33 ms timer; while not sending, once a second.
    const loop = p.intervals.find((i) => i.ms === 33)!;
    p.canvas.ctx.calls.length = 0;
    for (let i = 0; i < 30; i++) loop.cb();
    expect(p.canvas.ctx.calls.filter((c) => c[0] === 'drawImage')).toHaveLength(1);
    p.emit(PANEL_CHANNELS.sending, true);
    p.canvas.ctx.calls.length = 0;
    for (let i = 0; i < 30; i++) loop.cb();
    expect(p.canvas.ctx.calls.filter((c) => c[0] === 'drawImage')).toHaveLength(30);

    // Moved and resized on the same screen: a new crop and output size, the same capture and the same sent track.
    p.emit(PANEL_CHANNELS.capture, { ...CAP, crop: { x: 0, y: 0, width: 1920, height: 1080 }, out: { width: 1280, height: 720 } });
    await settle();
    expect(p.captures).toHaveLength(1);
    p.canvas.ctx.calls.length = 0;
    loop.cb();
    expect(p.canvas.ctx.calls).toEqual([['drawImage', 0, 0, 1920, 1080, 0, 0, 1280, 720]]);
    // Another screen: a new capture, the canvas track stays (no renegotiation).
    p.emit(PANEL_CHANNELS.capture, { ...CAP, sourceId: 'screen:1:0' });
    await settle();
    expect(p.captures).toHaveLength(2);
    expect(p.captures[0]?.track.readyState).toBe('ended');
    expect(p.canvas.streams).toHaveLength(1);
    expect(sender.track.readyState).toBe('live');

    // Covered: the "Paused" frame at once and at every tick, until uncovered.
    p.canvas.ctx.calls.length = 0;
    p.emit(PANEL_CHANNELS.cover, true);
    loop.cb();
    expect(p.canvas.ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1])).toEqual(['Paused: back in a moment', 'Paused: back in a moment']);
    expect(p.canvas.ctx.calls.some((c) => c[0] === 'drawImage')).toBe(false);
    p.emit(PANEL_CHANNELS.cover, false);
    p.canvas.ctx.calls.length = 0;
    loop.cb();
    expect(p.canvas.ctx.calls[0]?.[0]).toBe('drawImage');

    // Main found no window any more: the capture stops and the status says so.
    p.emit(PANEL_CHANNELS.capture, null);
    await settle();
    expect(p.captures[1]?.track.readyState).toBe('ended');
    expect(sender.track.readyState).toBe('ended');
    const st = p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { capturing: boolean };
    expect(st.capturing).toBe(false);
  });
});

describe('the theater feed (D7.4, 2026-10-31)', () => {
  it('a sender that declared nothing: side by side only from a VR sender and only 3:1 or wider (the D7.4 guess)', () => {
    expect(SBS_MIN_ASPECT).toBe(3);
    expect(stereoOf(undefined, 'vr_headset', 2560, 720)).toBe('sbs');
    expect(stereoOf(null, 'vr_headset', 2160, 720)).toBe('sbs');
    expect(stereoOf(undefined, 'vr_headset', 2150, 720)).toBe('mono');
    expect(stereoOf(undefined, 'vr_headset', 1280, 720)).toBe('mono');
    expect(stereoOf(undefined, 'pc', 2560, 720)).toBe('mono'); // a wide monitor picture is one picture
    expect(stereoOf(undefined, undefined, 2560, 720)).toBe('mono');
    expect(stereoOf(undefined, 'vr_headset', 2560, 0)).toBe('mono');
  });

  it('D7.4.3: the sender\'s declaration wins whatever the shape and the rig (both eyes in a 16:9 or a square window)', () => {
    expect(stereoOf('sbs', 'vr_headset', 1920, 1080)).toBe('sbs'); // Krobs, BCBSLU
    expect(stereoOf('sbs', 'vr_headset', 1440, 1392)).toBe('sbs'); // the owner's window
    expect(stereoOf('sbs', 'pc', 1080, 1080)).toBe('sbs'); // a roster that still says pc (A6.1)
    expect(stereoOf('mono', 'vr_headset', 2560, 720)).toBe('mono');
    expect(stereoOf('tab', 'vr_headset', 2560, 720)).toBe('sbs'); // unknown word: the guess
  });

  it('D7.4.3: the up player\'s stereo signal decides the feed; it is kept for a peer not added yet', async () => {
    const p = loadPage({ mic: false, capture: false });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: null, micDeviceId: null, muted: false, sending: false });
    // before the peers are added (the page waits for its microphone and capture first)
    p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'stereo', stereo: 'sbs' } });
    await settle();
    p.emit(PANEL_CHANNELS.state, {
      playerUp: 'krobs',
      myTurn: false,
      ball: 1,
      ballsPerGame: 3,
      players: [
        { id: 'owner', name: 'Owner', score: null, ballsDone: 0, isUp: false, flags: [], rig: 'vr_headset' },
        { id: 'krobs', name: 'Krobs', score: null, ballsDone: 0, isUp: true, flags: [], rig: 'pc' },
      ],
      phase: 'playing',
      result: null,
      message: null,
      mic: 'open',
    } satisfies PanelState);
    const feed = p.intervals.filter((i) => i.ms === 33).at(-1)!;
    const video = p.el('video') as unknown as { videoWidth: number; videoHeight: number; currentTime: number; readyState: number };
    Object.assign(video, { videoWidth: 1440, videoHeight: 1392, readyState: 4, currentTime: 1 });
    p.emit(PANEL_CHANNELS.videoWant, true);
    feed.cb();
    const frames = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.video).map((s) => s.arg as { stereo: string });
    expect(frames().at(-1)?.stereo).toBe('sbs');
    p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'stereo', stereo: 'mono' } });
    p.emit(PANEL_CHANNELS.videoAck);
    video.currentTime = 2;
    feed.cb();
    expect(frames().at(-1)?.stereo).toBe('mono');
    // never handed to the negotiation: no connection saw it
    expect(FakePeerConnection.all[0]?.remoteDescription).toBeNull();
  });

  it('the feed is the video at its own size, scaled down into 1920x1080 (a side-by-side one into 3840x1080), even sides', () => {
    expect(VIDEO_FEED_MAX).toEqual({ mono: { width: 1920, height: 1080 }, sbs: { width: 3840, height: 1080 }, fps: 30 });
    expect(feedSize(1280, 720, 'mono')).toEqual({ width: 1280, height: 720 });
    expect(feedSize(2560, 1440, 'mono')).toEqual({ width: 1920, height: 1080 });
    expect(feedSize(1281, 721, 'mono')).toEqual({ width: 1280, height: 720 });
    expect(feedSize(2560, 720, 'sbs')).toEqual({ width: 2560, height: 720 });
    expect(feedSize(5120, 1440, 'sbs')).toEqual({ width: 3840, height: 1080 });
    expect(feedSize(0, 0, 'mono')).toBeNull();
  });

  it('wanted: each new frame of the up player\'s stage video goes to main as RGBA, one in flight; never my own picture', async () => {
    const p = loadPage({ mic: true, capture: true });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: null, micDeviceId: null, muted: false, sending: false });
    await settle();
    const state = (myTurn: boolean): PanelState => ({
      playerUp: myTurn ? 'owner' : 'krobs',
      myTurn,
      ball: 1,
      ballsPerGame: 3,
      players: [
        { id: 'owner', name: 'Owner', score: null, ballsDone: 0, isUp: myTurn, flags: [], rig: 'vr_headset' },
        { id: 'krobs', name: 'Krobs', score: null, ballsDone: 0, isUp: !myTurn, flags: [], rig: 'vr_headset' },
      ],
      phase: 'playing',
      result: null,
      message: null,
      mic: 'open',
    });
    p.emit(PANEL_CHANNELS.state, state(false));
    const feed = p.intervals.filter((i) => i.ms === 33).at(-1)!;
    const video = p.el('video') as unknown as { videoWidth: number; videoHeight: number; currentTime: number; readyState: number };
    video.videoWidth = 2560;
    video.videoHeight = 720;
    video.readyState = 4;
    video.currentTime = 1;
    const frames = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.video).map((s) => s.arg as { width: number; height: number; rgba: Uint8Array; stereo: string });
    feed.cb();
    expect(frames()).toHaveLength(0); // not wanted
    p.emit(PANEL_CHANNELS.videoWant, true);
    feed.cb();
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toMatchObject({ width: 2560, height: 720, stereo: 'sbs' });
    expect(frames()[0]!.rgba).toBeInstanceOf(Uint8Array);
    expect(frames()[0]!.rgba.length).toBe(2560 * 720 * 4);
    video.currentTime = 2;
    feed.cb();
    expect(frames()).toHaveLength(1); // no ack yet
    p.emit(PANEL_CHANNELS.videoAck);
    feed.cb();
    expect(frames()).toHaveLength(2);
    p.emit(PANEL_CHANNELS.videoAck);
    feed.cb();
    expect(frames()).toHaveLength(2); // the same video frame: not sent again
    // My own ball: the stage shows my preview; nothing goes.
    p.emit(PANEL_CHANNELS.state, state(true));
    video.currentTime = 3;
    feed.cb();
    expect(frames()).toHaveLength(2);
    p.emit(PANEL_CHANNELS.state, state(false));
    p.emit(PANEL_CHANNELS.videoWant, false);
    video.currentTime = 4;
    feed.cb();
    expect(frames()).toHaveLength(2);
  });
});

describe('a stalled capture and the counters (D7.4.4, 2026-11-01)', () => {
  it('stallStep: stalled only while sending, after the limit with no movement; movement clears it; not sending keeps the clock moving', () => {
    expect(CAPTURE_STALL_MS).toBe(3000);
    expect(STATS_MS).toBe(10_000);
    const w = { mark: 10, at: 1000 };
    expect(stallStep(w, 10, 3999, true, 3000)).toEqual({ mark: 10, at: 1000, stalled: false, moved: false });
    expect(stallStep(w, 10, 4000, true, 3000)).toEqual({ mark: 10, at: 1000, stalled: true, moved: false });
    expect(stallStep(w, 11, 9000, true, 3000)).toEqual({ mark: 11, at: 9000, stalled: false, moved: true });
    // Not sending: a still screen is no fault, and the clock restarts so sending begins with a full 3 s.
    expect(stallStep(w, 10, 9000, false, 3000)).toEqual({ mark: 10, at: 9000, stalled: false, moved: false });
  });

  type Stats = { seq: number; capture: number | null; decoded: number | null; toLayer: number | null };

  async function sendingPage() {
    const p = loadPage({ mic: true, capture: true });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: CAP, micDeviceId: null, muted: false, sending: true });
    await settle();
    const src = p.el('src') as unknown as { currentTime: number };
    const watch = p.intervals.find((i) => i.ms === 400)!;
    const stats = p.intervals.find((i) => i.ms === STATS_MS)!;
    const sender = FakePeerConnection.all[0]!.senders.find((s) => s.track.kind === 'video')!;
    const canvasTrack = sender.track;
    const status = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { captureStalled: boolean; stats: Stats | null };
    return { p, src, watch, stats, sender, canvasTrack, status };
  }

  it('no new frame from the capture for 3 s while sending: reported stalled, the track comes off the connections; frames back: it returns', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { p, src, watch, sender, canvasTrack, status } = await sendingPage();
      expect(canvasTrack.enabled).toBe(true);
      src.currentTime = 1;
      watch.cb();
      vi.advanceTimersByTime(2_800);
      watch.cb();
      expect(status().captureStalled).toBe(false);
      vi.advanceTimersByTime(400);
      watch.cb();
      expect(status().captureStalled).toBe(true);
      expect(canvasTrack.enabled).toBe(false);
      await settle();
      expect(sender.track).toBeNull(); // the receivers' video mutes: "waiting for <name>'s table"
      // A new frame: back on, enabled, reported.
      src.currentTime = 2;
      watch.cb();
      await settle();
      expect(status().captureStalled).toBe(false);
      expect(canvasTrack.enabled).toBe(true);
      expect(sender.track).toBe(canvasTrack);
      expect(p.canvas.streams).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('not sending: a still screen is no stall; a restart capture from main opens a fresh stream and clears a stall', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { p, src, watch, sender, canvasTrack, status } = await sendingPage();
      p.emit(PANEL_CHANNELS.sending, false);
      src.currentTime = 1;
      watch.cb();
      vi.advanceTimersByTime(10_000);
      watch.cb();
      expect(status().captureStalled).toBe(false);
      p.emit(PANEL_CHANNELS.sending, true);
      vi.advanceTimersByTime(3_100);
      watch.cb();
      expect(status().captureStalled).toBe(true);
      // Main re-picked the same screen: without `restart` this would only move the crop.
      p.emit(PANEL_CHANNELS.capture, CAP);
      await settle();
      expect(p.captures).toHaveLength(1);
      p.emit(PANEL_CHANNELS.capture, { ...CAP, restart: true });
      await settle();
      expect(p.captures).toHaveLength(2);
      expect(p.captures[0]?.track.readyState).toBe('ended');
      expect(status().captureStalled).toBe(false);
      expect(sender.track).toBe(canvasTrack);
      expect(canvasTrack.enabled).toBe(true);
      expect(p.canvas.streams).toHaveLength(1); // the same canvas track: nothing renegotiates
    } finally {
      vi.useRealTimers();
    }
  });

  it('every 10 s while sending: how many frames the capture delivered; nothing when not sending', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { src, watch, stats, p, status } = await sendingPage();
      for (let i = 1; i <= 5; i++) {
        src.currentTime = i;
        watch.cb();
      }
      stats.cb();
      expect(status().stats).toEqual({ seq: 1, capture: 5, decoded: null, toLayer: null });
      stats.cb(); // the next window had no frames: 0 is a count too
      expect(status().stats).toEqual({ seq: 2, capture: 0, decoded: null, toLayer: null });
      p.emit(PANEL_CHANNELS.sending, false);
      stats.cb();
      expect(status().stats?.seq).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('every 10 s in theater: frames decoded by the stage video and frames sent to the layer; nothing when theater is not wanted', async () => {
    const p = loadPage({ mic: true, capture: true });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: null, micDeviceId: null, muted: false, sending: false });
    await settle();
    const st: PanelState = {
      playerUp: 'krobs',
      myTurn: false,
      ball: 1,
      ballsPerGame: 3,
      players: [
        { id: 'owner', name: 'Owner', score: null, ballsDone: 0, isUp: false, flags: [], rig: 'vr_headset' },
        { id: 'krobs', name: 'Krobs', score: null, ballsDone: 0, isUp: true, flags: [], rig: 'vr_headset' },
      ],
      phase: 'playing',
      result: null,
      message: null,
      mic: 'open',
    };
    p.emit(PANEL_CHANNELS.state, st);
    const stats = p.intervals.find((i) => i.ms === STATS_MS)!;
    const feed = p.intervals.filter((i) => i.ms === 33).at(-1)!;
    const video = p.el('video') as unknown as { videoWidth: number; videoHeight: number; readyState: number; total: number; getVideoPlaybackQuality(): { totalVideoFrames: number } };
    video.videoWidth = 1280;
    video.videoHeight = 720;
    video.readyState = 4;
    video.total = 0;
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: video.total });
    const last = () => (p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { stats: Stats | null }).stats;
    stats.cb();
    expect(last()).toBeNull(); // theater not wanted: not relevant, nothing reported
    p.emit(PANEL_CHANNELS.videoWant, true);
    for (let i = 1; i <= 4; i++) {
      video.total = i * 7;
      feed.cb();
      p.emit(PANEL_CHANNELS.videoAck);
    }
    stats.cb();
    expect(last()).toEqual({ seq: 1, capture: null, decoded: 28, toLayer: 4 });
    video.total = 35;
    feed.cb();
    stats.cb();
    expect(last()).toEqual({ seq: 2, capture: null, decoded: 7, toLayer: 1 });
  });
});
