import { describe, expect, it } from 'vitest';
import type { PanelState } from './match-media-types.js';
import { headerText, micText, PANEL_CHANNELS, panelPageHtml, scoreText, stageText, stripRows, videoPeer } from './panel-page.js';

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
      { id: 'owner', name: 'Owner', score: '1,234,560', detail: '2/3', up: false, flags: [] },
      { id: 'krobs', name: 'Krobs', score: '990,000', detail: 'BALL 2', up: true, flags: ['DIFFERENT TABLE'] },
    ]);
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
  children: FakeElement[] = [];
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
  constructor(readonly config: unknown) {
    FakePeerConnection.all.push(this);
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
  async setLocalDescription(): Promise<void> {
    this.localDescription = { type: 'offer', sdp: 'offer-sdp' };
    this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = d;
    this.signalingState = 'stable';
  }
  async addIceCandidate(): Promise<void> {}
  restartIce(): void {}
  close(): void {
    this.closed = true;
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
    createElement: () => new FakeElement(),
  };
  const gum = async (c: { audio?: unknown; video?: unknown }) => {
    if (c.video) {
      if (!media.capture) throw new Error('capture refused');
      return new FakeStream([new FakeTrack('video')]);
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
  const run = new Function('require', 'document', 'navigator', 'MediaStream', 'RTCPeerConnection', 'Audio', 'setInterval', 'clearInterval', script);
  run(() => electron, document, navigator, FakeStream, FakePeerConnection, FakeAudio, () => 0, () => undefined);
  const emit = (ch: string, arg?: unknown): void => handlers.get(ch)?.({}, arg);
  return { html, script, sent, emit, el: (id: string) => document.getElementById(id), handlers };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe('panel page script (D2)', () => {
  it('is one page with the channels, the helpers and the negotiation classes embedded', () => {
    const { html, script } = loadPage({ mic: true, capture: true });
    expect(html).toContain('<body class="vr">');
    expect(panelPageHtml({ vr: false })).toContain('<body class="desktop">');
    for (const name of ['function headerText', 'function stripRows', 'class PeerNegotiator', 'class SignalingMesh', 'function isPolite']) expect(script).toContain(name);
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
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs', 'third'], ice: [{ urls: ['stun:x'] }], capture: { sourceId: 'window:1:0', label: 'Visual Pinball Player' }, micDeviceId: 'hs', muted: false, sending: false });
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

  it('no microphone and no capture: the mesh still opens (receive only) and the status says why', async () => {
    const p = loadPage({ mic: false, capture: false });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: { sourceId: 'window:1:0', label: 'Visual Pinball Player' }, micDeviceId: null, muted: false, sending: false });
    await settle();
    expect(FakePeerConnection.all).toHaveLength(1);
    expect(FakePeerConnection.all[0]?.senders).toEqual([]);
    const st = p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { mic: string; capturing: boolean; error: string; peers: Record<string, { ice: string }> };
    expect(st.mic).toBe('unavailable');
    expect(st.capturing).toBe(false);
    expect(st.error).toMatch(/Could not capture Visual Pinball Player|No microphone/);
    expect(st.peers['krobs']?.ice).toBe('new');
  });
});
