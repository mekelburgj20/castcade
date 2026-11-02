/**
 * D2.8 (2026-11-01): table sound on the panel page: the pure helpers (track routing, the SDP rename, the jitter ring)
 * and the page script on fakes (the table track on every connection from the start, sending and hearing, the receiver
 * playing only the up player's table). Its own fakes, apart from panel-page.test.ts's, with event listeners on the
 * connection and a fake AudioContext.
 */
import { describe, expect, it } from 'vitest';
import type { PanelState } from './match-media-types.js';
import { createTableRing, outgoingSdp, PANEL_CHANNELS, panelPageHtml, TABLE_AUDIO_STREAM_ID, TABLE_RING, tablePlays, tableWorkletSource, trackRole } from './panel-page.js';

const state = (o: Partial<PanelState> = {}): PanelState => ({
  playerUp: 'krobs',
  myTurn: false,
  ball: 2,
  ballsPerGame: 3,
  players: [
    { id: 'owner', name: 'Owner', score: 10, ballsDone: 1, isUp: false, flags: [] },
    { id: 'krobs', name: 'Krobs', score: 20, ballsDone: 1, isUp: true, flags: [] },
  ],
  phase: 'playing',
  result: null,
  message: null,
  mic: 'open',
  ...o,
});

describe('table sound helpers (D2.8)', () => {
  it('trackRole: an audio track in the castcade-table-audio stream is the table; anything else by kind', () => {
    expect(TABLE_AUDIO_STREAM_ID).toBe('castcade-table-audio');
    expect(trackRole('audio', ['castcade-table-audio'])).toBe('table');
    expect(trackRole('audio', ['{a1b2}'])).toBe('audio');
    expect(trackRole('audio', [])).toBe('audio');
    expect(trackRole('video', ['castcade-table-audio'])).toBe('video');
  });

  it('tablePlays: only the player up, only while hearing, never in the lobby or after the result', () => {
    expect(tablePlays(state(), 'krobs', true)).toBe(true);
    expect(tablePlays(state(), 'krobs', false)).toBe(false);
    expect(tablePlays(state(), 'third', true)).toBe(false);
    expect(tablePlays(state({ phase: 'paused' }), 'krobs', true)).toBe(true);
    expect(tablePlays(state({ myTurn: true, playerUp: 'owner' }), 'krobs', true)).toBe(false);
    expect(tablePlays(state({ phase: 'over', playerUp: null }), 'krobs', true)).toBe(false);
    expect(tablePlays(state({ phase: 'idle', playerUp: null }), 'krobs', true)).toBe(false);
    expect(tablePlays(null, 'krobs', true)).toBe(false);
  });

  const SDP = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    'a=msid-semantic: WMS {voice-stream} {tbl-stream}',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'a=mid:0',
    'a=msid:{voice-stream} {mic-track}',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=mid:1',
    'a=msid:{voice-stream} {video-track}',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'a=mid:2',
    'a=msid:{tbl-stream} {tbl-track}',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=ssrc:1234 msid:{tbl-stream} {tbl-track}',
    '',
  ].join('\r\n');

  it('outgoingSdp: renames the table stream everywhere and asks for stereo on its m-section only', () => {
    const out = outgoingSdp(SDP, '{tbl-stream}');
    expect(out).not.toContain('{tbl-stream}');
    expect(out).toContain('a=msid:castcade-table-audio {tbl-track}');
    expect(out).toContain('a=ssrc:1234 msid:castcade-table-audio {tbl-track}');
    expect(out).toContain('WMS {voice-stream} castcade-table-audio');
    const sections = out.split(/\r\nm=/);
    expect(sections[1]).toContain('a=fmtp:111 minptime=10;useinbandfec=1'); // the voice: as it was
    expect(sections[1]).not.toContain('stereo');
    expect(sections[3]).toContain('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1\r\n');
    // Idempotent on the stereo flags; untouched without a table stream.
    expect(outgoingSdp(out.split('castcade-table-audio').join('{tbl-stream}'), '{tbl-stream}')).toBe(out);
    expect(outgoingSdp(SDP, null)).toBe(SDP);
    expect(outgoingSdp(SDP, '{other}')).toBe(SDP);
  });

  it('createTableRing: primes, plays in order, underruns to silence, keeps the delay bounded, flushes', () => {
    const ring = createTableRing(64, 24, 8, 8);
    const L = new Float32Array(2);
    const R = new Float32Array(2);
    ring.write([1, -1, 2, -2]);
    ring.read(L, R);
    expect([...L, ...R]).toEqual([0, 0, 0, 0]); // 4 < prime 8: silence, nothing taken
    expect(ring.buffered()).toBe(4);
    ring.write([3, -3, 4, -4]);
    ring.read(L, R);
    expect([...L]).toEqual([1, 2]);
    expect([...R]).toEqual([-1, -2]);
    ring.read(L, R);
    expect([...L]).toEqual([3, 4]);
    ring.read(L, R); // underrun
    expect([...L]).toEqual([0, 0]);
    // Too much buffered: the oldest go, down to the target, still in L/R pairs.
    const many: number[] = [];
    for (let i = 0; i < 30; i++) many.push(i);
    ring.write(many);
    expect(ring.buffered()).toBe(8);
    ring.read(L, R);
    expect([...L, ...R]).toEqual([22, 24, 23, 25]);
    ring.flush();
    expect(ring.buffered()).toBe(0);
    // A ragged write keeps the pairs (the odd sample is dropped).
    ring.write([9, 8, 7]);
    expect(ring.buffered()).toBe(2);
  });

  it('the worklet source embeds the ring with its sizes and registers the processor', () => {
    const src = tableWorkletSource();
    expect(src).toContain('function createTableRing');
    expect(src).toContain(`createTableRing(${TABLE_RING.capacity}, ${TABLE_RING.high}, ${TABLE_RING.target}, ${TABLE_RING.prime})`);
    expect(src).toContain("registerProcessor('castcade-table-ring'");
    // It parses as a script (the worklet globals are only referenced at run time).
    expect(() => new Function('AudioWorkletProcessor', 'registerProcessor', src)).not.toThrow();
  });
});

// ---- the page script on fakes ----

let nextId = 0;
class FakeTrack {
  enabled = true;
  muted = false;
  readyState = 'live';
  contentHint = '';
  readonly id = `t${++nextId}`;
  constructor(readonly kind: 'audio' | 'video') {}
  stop(): void {
    this.readyState = 'ended';
  }
  addEventListener(): void {}
}

class FakeStream {
  tracks: FakeTrack[];
  readonly id: string;
  constructor(tracks: FakeTrack[] = [], id?: string) {
    this.tracks = [...tracks];
    this.id = id ?? `s${++nextId}`;
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
  videoWidth = 1280;
  videoHeight = 720;
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
  getContext(): unknown {
    return { fillRect() {}, fillText() {}, drawImage() {} };
  }
  captureStream(): FakeStream {
    return new FakeStream([new FakeTrack('video')]);
  }
}

interface Sender {
  track: FakeTrack | null;
  streams: FakeStream[];
  replaceTrack(t: FakeTrack | null): Promise<void>;
  getParameters(): { encodings: unknown[] };
  setParameters(): Promise<void>;
}

class FakePeerConnection {
  static all: FakePeerConnection[] = [];
  signalingState = 'stable';
  iceConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: unknown = null;
  senders: Sender[] = [];
  listeners = new Map<string, Array<(e: unknown) => void>>();
  closed = false;
  /** What the next local offer's SDP says (the test writes the table stream's id into it). */
  offerSdp = 'offer-sdp';
  constructor(readonly config: unknown) {
    FakePeerConnection.all.push(this);
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  fire(type: string, e: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(e);
  }
  addTrack(track: FakeTrack, ...streams: FakeStream[]): Sender {
    const s: Sender = {
      track,
      streams,
      replaceTrack: async (t) => {
        s.track = t;
      },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => undefined,
    };
    this.senders.push(s);
    return s;
  }
  async setLocalDescription(): Promise<void> {
    if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: 'answer-sdp' };
      this.signalingState = 'stable';
      return;
    }
    this.localDescription = { type: 'offer', sdp: this.offerSdp };
    this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(): Promise<void> {}
  restartIce(): void {}
  close(): void {
    this.closed = true;
  }
}

class FakeAudio {
  static all: FakeAudio[] = [];
  autoplay = false;
  muted = false;
  srcObject: unknown = null;
  plays = 0;
  play = async (): Promise<void> => {
    this.plays++;
  };
  constructor() {
    FakeAudio.all.push(this);
  }
}

class FakeAudioContext {
  static all: FakeAudioContext[] = [];
  state = 'running';
  dest = { channelCount: 1, stream: new FakeStream([new FakeTrack('audio')], '{tbl-stream}') };
  modules: string[] = [];
  audioWorklet = {
    addModule: async (url: string) => {
      this.modules.push(url);
    },
  };
  constructor(readonly opts: unknown) {
    FakeAudioContext.all.push(this);
  }
  createMediaStreamDestination() {
    return this.dest;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
}

class FakeWorkletNode {
  static last: FakeWorkletNode | null = null;
  posted: unknown[] = [];
  connectedTo: unknown = null;
  port = { postMessage: (m: unknown) => this.posted.push(m) };
  constructor(
    readonly ctx: unknown,
    readonly name: string,
    readonly opts: unknown,
  ) {
    FakeWorkletNode.last = this;
  }
  connect(to: unknown): void {
    this.connectedTo = to;
  }
}

function loadPage(audio = true) {
  const html = panelPageHtml({ vr: false });
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
  const navigator = {
    mediaDevices: {
      getUserMedia: async (c: { video?: unknown }) => {
        if (c.video) throw new Error('no capture here');
        return new FakeStream([new FakeTrack('audio')]);
      },
      getDisplayMedia: async () => {
        throw new Error('no display media');
      },
      enumerateDevices: async () => [],
      addEventListener: () => undefined,
    },
  };
  const electron = {
    ipcRenderer: {
      on: (ch: string, cb: (e: unknown, arg: unknown) => void) => handlers.set(ch, cb),
      send: (channel: string, arg?: unknown) => sent.push({ channel, arg }),
    },
  };
  FakePeerConnection.all = [];
  FakeAudioContext.all = [];
  FakeWorkletNode.last = null;
  FakeAudio.all = [];
  const url = { createObjectURL: () => 'blob:castcade-table' };
  const run = new Function(
    'require',
    'document',
    'navigator',
    'MediaStream',
    'RTCPeerConnection',
    'Audio',
    'setInterval',
    'clearInterval',
    'AudioContext',
    'AudioWorkletNode',
    'URL',
    'Blob',
    script,
  );
  run(
    () => electron,
    document,
    navigator,
    FakeStream,
    FakePeerConnection,
    FakeAudio,
    () => 0,
    () => undefined,
    audio ? FakeAudioContext : undefined,
    audio ? FakeWorkletNode : undefined,
    url,
    class {
      constructor(readonly parts: unknown[]) {}
    },
  );
  const emit = (ch: string, arg?: unknown): void => handlers.get(ch)?.({}, arg);
  return { sent, emit };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const ATTACH = { localId: 'owner', peers: ['krobs', 'third'], ice: [], capture: null, micDeviceId: null, muted: false, sending: false };

describe('panel page table sound (D2.8)', () => {
  it('the table track is on every connection from its creation, disabled until sending, its stream renamed in the SDP sent', async () => {
    const p = loadPage();
    p.emit(PANEL_CHANNELS.attach, ATTACH);
    await settle();
    expect(FakeAudioContext.all).toHaveLength(1); // one AudioContext for every connection
    const ctx = FakeAudioContext.all[0]!;
    expect(ctx.opts).toMatchObject({ sampleRate: 48000 });
    expect(ctx.dest.channelCount).toBe(2);
    expect(ctx.modules).toEqual(['blob:castcade-table']);
    expect(FakeWorkletNode.last?.connectedTo).toBe(ctx.dest);
    const table = ctx.dest.stream.getAudioTracks()[0]!;
    expect(table.contentHint).toBe('music');
    expect(table.enabled).toBe(false);
    for (const pc of FakePeerConnection.all) {
      expect(pc.senders.map((s) => s.track?.kind)).toEqual(['audio', 'audio']);
      expect(pc.senders[1]?.track).toBe(table);
      expect(pc.senders[1]?.streams[0]).toBe(ctx.dest.stream);
    }
    // The offer that goes out names the table stream castcade-table-audio.
    const pc = FakePeerConnection.all[0]!;
    pc.offerSdp = 'v=0\r\nm=audio 9 RTP 111\r\na=msid:{tbl-stream} t\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n';
    pc.onnegotiationneeded?.();
    await settle();
    const offer = p.sent.filter((s) => s.channel === PANEL_CHANNELS.send).map((s) => s.arg as { signal: { kind: string; sdp?: string } }).find((s) => s.signal.kind === 'offer');
    expect(offer?.signal.sdp).toContain('a=msid:castcade-table-audio t');
    expect(offer?.signal.sdp).toContain('stereo=1');
    expect(offer?.signal.sdp).not.toContain('{tbl-stream}');
  });

  it('sending: the track goes live and the PCM frames reach the worklet (copied, transferred); off again flushes it', async () => {
    const p = loadPage();
    p.emit(PANEL_CHANNELS.attach, ATTACH);
    await settle();
    const node = FakeWorkletNode.last!;
    const table = FakeAudioContext.all[0]!.dest.stream.getAudioTracks()[0]!;
    const pcm = new Uint8Array(new Float32Array([0.5, -0.5]).buffer);
    p.emit(PANEL_CHANNELS.tablePcm, pcm);
    expect(node.posted).toEqual([]); // not sending: dropped
    p.emit(PANEL_CHANNELS.tableAudio, { send: true, hear: true });
    expect(table.enabled).toBe(true);
    const at = node.posted.length;
    // A view at an odd offset of a larger buffer, as IPC may hand it over.
    const big = new Uint8Array(12);
    big.set(pcm, 3);
    p.emit(PANEL_CHANNELS.tablePcm, big.subarray(3, 11));
    const got = node.posted[at] as ArrayBuffer;
    expect([...new Float32Array(got)]).toEqual([0.5, -0.5]);
    p.emit(PANEL_CHANNELS.tableAudio, { send: false, hear: true });
    expect(table.enabled).toBe(false);
    expect(node.posted.at(-1)).toBe('flush');
  });

  it('receiving: the table track goes to its own element (not the voice stream), heard only while that peer is up', async () => {
    const p = loadPage();
    p.emit(PANEL_CHANNELS.attach, ATTACH);
    await settle();
    const [krobs, third] = FakePeerConnection.all as [FakePeerConnection, FakePeerConnection];
    const voice = new FakeTrack('audio');
    const kTable = new FakeTrack('audio');
    const tTable = new FakeTrack('audio');
    krobs.fire('track', { track: voice, streams: [new FakeStream([], '{their-voice}')] });
    krobs.fire('track', { track: kTable, streams: [new FakeStream([], 'castcade-table-audio')] });
    third.fire('track', { track: tTable, streams: [new FakeStream([], 'castcade-table-audio')] });
    // The voice element keeps the voice track; the table track went to the table element only.
    const holding = (t: FakeTrack) => FakeAudio.all.filter((a) => (a.srcObject as FakeStream | null)?.tracks.includes(t));
    expect(holding(voice)).toHaveLength(1);
    expect(holding(kTable)).toHaveLength(1);
    expect(holding(voice)[0]).not.toBe(holding(kTable)[0]);
    p.emit(PANEL_CHANNELS.tableAudio, { send: false, hear: true });
    p.emit(PANEL_CHANNELS.state, state()); // Krobs is up
    const report = () => {
      p.emit(PANEL_CHANNELS.muted, false); // any handler that reports
      return p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { peers: Record<string, { receivingAudio: boolean; receivingTable: boolean }> };
    };
    const st = report();
    expect(st.peers['krobs']).toMatchObject({ receivingAudio: true, receivingTable: true });
    expect(st.peers['third']).toMatchObject({ receivingAudio: false, receivingTable: true });
  });

  it('routing: the up player\'s table element unmuted, every other muted; my own ball and hear-off mute them all', async () => {
    const p = loadPage();
    p.emit(PANEL_CHANNELS.attach, ATTACH);
    await settle();
    const [krobs, third] = FakePeerConnection.all as [FakePeerConnection, FakePeerConnection];
    const kTable = new FakeTrack('audio');
    const tTable = new FakeTrack('audio');
    krobs.fire('track', { track: kTable, streams: [new FakeStream([], 'castcade-table-audio')] });
    third.fire('track', { track: tTable, streams: [new FakeStream([], 'castcade-table-audio')] });
    // The element for each peer is the one whose srcObject holds that peer's table track.
    const elementOf = (t: FakeTrack): FakeAudio | null => FakeAudio.all.find((a) => (a.srcObject as FakeStream | null)?.tracks.includes(t)) ?? null;
    p.emit(PANEL_CHANNELS.tableAudio, { send: false, hear: true });
    p.emit(PANEL_CHANNELS.state, state());
    expect(elementOf(kTable)?.muted).toBe(false);
    expect(elementOf(tTable)?.muted).toBe(true);
    p.emit(PANEL_CHANNELS.state, state({ playerUp: 'third', players: state().players }));
    expect(elementOf(kTable)?.muted).toBe(true);
    expect(elementOf(tTable)?.muted).toBe(false);
    p.emit(PANEL_CHANNELS.state, state({ myTurn: true, playerUp: 'owner' }));
    expect(elementOf(kTable)?.muted).toBe(true);
    expect(elementOf(tTable)?.muted).toBe(true);
    p.emit(PANEL_CHANNELS.state, state());
    expect(elementOf(kTable)?.muted).toBe(false);
    p.emit(PANEL_CHANNELS.tableAudio, { send: false, hear: false });
    expect(elementOf(kTable)?.muted).toBe(true);
  });

  it('no AudioContext (an older engine): the match runs as before, without a table track', async () => {
    const p = loadPage(false);
    p.emit(PANEL_CHANNELS.attach, ATTACH);
    await settle();
    for (const pc of FakePeerConnection.all) expect(pc.senders.map((s) => s.track?.kind)).toEqual(['audio']);
    expect(() => p.emit(PANEL_CHANNELS.tableAudio, { send: true, hear: true })).not.toThrow();
    expect(() => p.emit(PANEL_CHANNELS.tablePcm, new Uint8Array(8))).not.toThrow();
  });
});
