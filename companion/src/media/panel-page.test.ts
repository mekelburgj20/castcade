import { describe, expect, it, vi } from 'vitest';
import type { PanelState } from './match-media-types.js';
import { bitrateHintsFor, cameraCapture, cameraFrameSize, eyesKey, isCameraCapture, LAYER_CAMERA_SOURCE_ID, stereoSignal, feedSize, headerText, ICE_ROUND_LOOK, ICE_WATCH, icePairInfo, icePairText, iceUfrag, iceRestartName, iceRoundSparse, iceWatchStep, micText, noPathText, PANEL_CHANNELS, paintFrame, panelPageHtml, preferH264, SBS_MIN_ASPECT, scoreText, stageText, stallStep, CAPTURE_STALL_MS, STATS_MS, stereoOf, stripRows, VIDEO_FEED_MAX, videoBitrateFor, videoCropRect, videoPeer, watchingText, withBitrateHints, volumeGains, VOLUME_NOTE_MS, type Paint2D } from './panel-page.js';

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

describe('volumeGains (D2.10)', () => {
  it('percent to gain: the voice 0–3 (a boost past 1), the table 0–1; defaults 1.5 and 1 for anything else', () => {
    expect(volumeGains({ voice: 150, table: 100 })).toEqual({ voice: 1.5, table: 1 });
    expect(volumeGains({ voice: 300, table: 40 })).toEqual({ voice: 3, table: 0.4 });
    expect(volumeGains({ voice: 900, table: 250 })).toEqual({ voice: 3, table: 1 });
    expect(volumeGains({ voice: -20, table: -1 })).toEqual({ voice: 0, table: 0 });
    expect(volumeGains({ voice: Number.NaN, table: 'loud' as never })).toEqual({ voice: 1.5, table: 1 });
    expect(volumeGains(null)).toEqual({ voice: 1.5, table: 1 });
    expect(volumeGains(undefined)).toEqual({ voice: 1.5, table: 1 });
    expect(volumeGains({ voice: 100, table: 100, note: 'Voice 100 %' })).toEqual({ voice: 1, table: 1 });
    expect(VOLUME_NOTE_MS).toBe(2000);
  });
});

describe('panel text (D2)', () => {
  it('header: YOUR BALL n when I am up, <NAME> IS UP otherwise, the phase when nobody is', () => {
    expect(headerText(state({ myTurn: true, playerUp: 'owner' }))).toBe('YOUR BALL 2');
    expect(headerText(state())).toBe('KROBS IS UP');
    expect(headerText(state({ phase: 'paused' }))).toBe('PAUSED · KROBS IS UP');
    expect(headerText(state({ phase: 'idle', playerUp: null, ball: null }))).toBe('WAITING FOR THE START');
    // A17 step 1 (the review of PR 127): a lobby this PC has lost (its host is gone) says that it is over, whatever was counting down.
    expect(headerText(state({ phase: 'idle', playerUp: null, ball: null, seriesOver: true }))).toBe('LOBBY OVER');
    expect(headerText(state({ phase: 'idle', playerUp: null, ball: null, seriesOver: true, countdown: 3 }))).toBe('LOBBY OVER');
    expect(headerText(state({ phase: 'idle', playerUp: null, ball: null, seriesOver: false }))).toBe('WAITING FOR THE START');
    // A17 step 10: tables are being changed; a start that counts down is still the header, and so is a lobby that is over.
    expect(headerText(state({ phase: 'idle', playerUp: null, ball: null, changingTable: 'Monster Bash (Williams 1998)' }))).toBe('CHANGING TABLE · MONSTER BASH (WILLIAMS 1998)');
    expect(headerText(state({ phase: 'idle', playerUp: null, ball: null, changingTable: 'Monster Bash', countdown: 4 }))).toBe('STARTING IN 4');
    expect(headerText(state({ phase: 'idle', playerUp: null, ball: null, changingTable: 'Monster Bash', seriesOver: true }))).toBe('LOBBY OVER');
    expect(headerText(state({ changingTable: 'Monster Bash' }))).toBe('KROBS IS UP');
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
    expect(stripRows(done)[0]).toMatchObject({ score: '–', detail: 'DONE', flags: ['AWAY'] });
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
    // B26 (2026-11-16): Midnight Madness ran on one of that player's balls: a red flag on the row, while
    // playing and on the result; the place is the score's.
    const midnight = state({ players: [{ id: 'krobs', name: 'Krobs', score: 5, ballsDone: 1, isUp: false, flags: ['midnight'] }] });
    expect(stripRows(midnight)[0]).toMatchObject({ flags: ['MIDNIGHT MADNESS'], notes: [] });
    const marked = state({
      phase: 'over',
      result: [
        { id: 'krobs', name: 'Krobs', score: 4_000_000, place: 1, flags: ['midnight'] },
        { id: 'owner', name: 'Owner', score: 3_000_000, place: 2 },
      ],
    });
    expect(stripRows(marked).map((r) => [r.name, r.detail, r.flags])).toEqual([
      ['Krobs', '#1', ['MIDNIGHT MADNESS']],
      ['Owner', '#2', []],
    ]);
  });

  it('stage: my own preview when I am up, the up player otherwise, nothing before the start or after the result', () => {
    expect(videoPeer(state({ myTurn: true }))).toBe('self');
    expect(videoPeer(state())).toBe('krobs');
    expect(videoPeer(state({ phase: 'paused' }))).toBe('krobs');
    expect(videoPeer(state({ phase: 'idle' }))).toBeNull();
    expect(videoPeer(state({ phase: 'over' }))).toBeNull();
    expect(stageText(state(), false)).toBe("WAITING FOR KROBS' TABLE");
    expect(stageText(state(), true)).toBe('');
    expect(stageText(state({ myTurn: true }), false)).toBe('NO PICTURE FROM YOUR TABLE');
    expect(stageText(null, false)).toBe('');
  });

  it('A17 step 1 (2026-11-24): the lobby panel says in words that the microphone is heard, once a connection to another player is up; never while muted, and never outside the lobby', () => {
    const lobby = state({ phase: 'idle', playerUp: null, ball: null });
    // No connection yet (alone in the lobby, or the other PC is on 0.2.50 and connects at the match's start): nothing.
    expect(stageText(lobby, false)).toBe('');
    expect(stageText(lobby, false, false)).toBe('');
    expect(stageText(lobby, false, true)).toBe('YOUR MICROPHONE IS ON · THE OTHERS HEAR YOU');
    expect(stageText({ ...lobby, mic: 'muted' }, false, true)).toBe('');
    expect(stageText({ ...lobby, mic: 'unavailable' }, false, true)).toBe('');
    // During a game and after it the stage is the picture's, as before.
    expect(stageText(state(), false, true)).toBe("WAITING FOR KROBS' TABLE");
    expect(stageText(state({ phase: 'over' }), false, true)).toBe('');
    // The page embeds the function and tells it whether a connection is up.
    expect(panelPageHtml({ vr: true })).toContain('stageText(panel, hasVideo, voiceUp())');
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

describe("the panel's lobby view (A17 step 9, 2026-11-27, alpha-match.md section 11.9)", () => {
  const members: NonNullable<PanelState['members']> = [
    { id: 'owner', name: 'Owner', stance: 'play', flags: [], inMatch: false },
    { id: 'krobs', name: 'Krobs', stance: 'play', flags: ['loading'], inMatch: false },
    { id: 'chuck', name: 'Chuck', stance: 'watch', flags: ['no_table'], inMatch: false },
    { id: 'dana', name: 'Dana', stance: 'play', flags: ['away'], inMatch: false },
  ];
  const lobby = (o: Partial<PanelState> = {}): PanelState => state({ phase: 'idle', playerUp: null, ball: null, members, starter: 'owner', stance: 'play', ...o });

  it('headerText: the lobby and how many are here; a countdown; a held countdown; tables being changed; a match with no lobby keeps its words', () => {
    expect(headerText(lobby())).toBe('LOBBY · 4 HERE');
    expect(headerText(lobby({ countdown: 5 }))).toBe('STARTING IN 5');
    expect(headerText(lobby({ countdown: 0 }))).toBe('STARTING');
    expect(headerText(lobby({ changingTable: 'Congo (Williams 1995)' }))).toBe('CHANGING TABLE · CONGO (WILLIAMS 1995)');
    expect(headerText(lobby({ seriesOver: true }))).toBe('LOBBY CLOSED');
    expect(headerText(state({ phase: 'idle', playerUp: null, ball: null }))).toBe('WAITING FOR THE START');
    // In a game the header is what it was, for a player and for a watcher alike.
    expect(headerText(lobby({ phase: 'playing', playerUp: 'krobs', ball: 2, myTurn: true }))).toBe('YOUR BALL 2');
    expect(headerText(lobby({ phase: 'playing', playerUp: 'krobs', ball: 2 }))).toBe('KROBS IS UP');
  });

  it('the rows: in the lobby every member with PLAY or WATCH and what is wrong with their row, no score; in a game the players of the match as before', () => {
    expect(stripRows(lobby()).map((r) => [r.name, r.detail, r.score, r.flags.join('|')])).toEqual([
      ['Owner', 'PLAY', '', ''],
      ['Krobs', 'PLAY', '', 'LOADING'],
      ['Chuck', 'WATCH', '', 'NO TABLE'],
      ['Dana', 'PLAY', '', 'AWAY'],
    ]);
    const way = lobby({
      members: [
        { id: 'a', name: 'A', stance: 'play', flags: ['close_table'], inMatch: false },
        { id: 'b', name: 'B', stance: 'play', flags: ['asked', 'own_game'], inMatch: false },
        { id: 'c', name: 'C', stance: 'play', flags: ['changing', 'other_table'], inMatch: false },
      ],
    });
    expect(stripRows(way).map((r) => r.flags)).toEqual([['HAS TO CLOSE THEIR TABLE'], ['ASKED TO OPEN IT', 'OWN GAME'], ['CHANGING TABLE', 'OTHER TABLE']]);
    expect(stripRows(lobby({ phase: 'playing', playerUp: 'krobs' })).map((r) => r.name)).toEqual(['Owner', 'Krobs']);
    // A match with no lobby (no `members`) keeps the players' rows before the start.
    expect(stripRows(state({ phase: 'idle', playerUp: null, ball: null })).map((r) => r.name)).toEqual(['Owner', 'Krobs']);
    expect(stripRows(state({ phase: 'idle', playerUp: null, ball: null })).map((r) => r.detail)).not.toContain('PLAY');
  });

  it('the `Watching:` line: during a game, the members who are not in it and are here; nothing in the lobby, without a lobby, or when everybody plays', () => {
    expect(watchingText(lobby({ phase: 'playing', playerUp: 'krobs' }))).toBe('Watching: Chuck');
    expect(watchingText(lobby({ phase: 'paused', playerUp: 'krobs', members: members.map((m) => ({ ...m, flags: [] })) }))).toBe('Watching: Chuck, Dana');
    expect(watchingText(lobby())).toBe('');
    expect(watchingText(state())).toBe('');
    expect(watchingText(lobby({ phase: 'playing', members: members.slice(0, 2) }))).toBe('');
    // The page draws it under the strip, with the helper in it.
    for (const vr of [false, true]) {
      const html = panelPageHtml({ vr });
      expect(html).toContain('function watchingText(');
      expect(html).toContain('const watching = panel ? watchingText(panel) : ');
    }
  });
});

describe('the in-game menu on the panel (A17 step 9, 2026-11-27)', () => {
  it("is a window onto its lines: a lobby's menu has more lines than fit, so the chosen one is brought into sight, the list says when there is more, and the question and the keys keep their place under it", () => {
    for (const vr of [false, true]) {
      const html = panelPageHtml({ vr });
      expect(html).toContain('<div id="menuup" class="more">');
      expect(html).toContain('<div id="menudown" class="more">');
      expect(html).toContain("if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });");
      // The list takes the room that is left and no more: what stands under it is never pushed out of the panel.
      expect(html).toMatch(/#menuitems \{[^}]*flex: 1 1 auto; min-height: 0; overflow: hidden;/);
    }
  });

  it('the page is as wide as its window and no wider, and its line wraps: a long sentence does not push the header and the scores off the panel', () => {
    for (const vr of [false, true]) {
      const html = panelPageHtml({ vr });
      expect(html).toMatch(/body \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
      expect(html).toMatch(/#msg \{[^}]*-webkit-line-clamp: 6;/);
      expect(html).not.toMatch(/#msg \{[^}]*white-space: nowrap/);
    }
  });
});

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
  /** D8.3: one transceiver per sender, recording the codec preferences set on it. */
  transceivers: { sender: unknown; preferences: unknown[] | null; setCodecPreferences(c: unknown[]): void }[] = [];
  /** D8.3: what `getStats` answers (a Map of stats entries by id); absent, no getStats at all (the browser before one). */
  stats: Map<string, Record<string, unknown>> | null = null;
  closed = false;
  candidates: unknown[] = [];
  constructor(readonly config: unknown) {
    FakePeerConnection.all.push(this);
  }
  getTransceivers() {
    return this.transceivers;
  }
  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    if (!this.stats) throw new Error('no stats');
    return this.stats;
  }
  /** D2.7: the remote connection a description came from (`session:<x>` in the fake SDP), as Chromium tells them apart. */
  static session(sdp: string | undefined): string | null {
    return /session:(\w+)/.exec(sdp ?? '')?.[1] ?? null;
  }
  /** I11.12: the page's own listeners, so a test can have the connection say what a browser would (`fire`). */
  listeners = new Map<string, Array<() => void>>();
  addEventListener(name: string, cb: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
  }
  fire(name: string): void {
    for (const cb of this.listeners.get(name) ?? []) cb();
  }
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
    const tr = { sender: s, preferences: null as unknown[] | null, setCodecPreferences: (c: unknown[]) => void (tr.preferences = c) };
    this.transceivers.push(tr);
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
    for (const name of ['function headerText', 'function stripRows', 'function videoCropRect', 'function paintFrame', 'function volumeGains', 'class PeerNegotiator', 'class SignalingMesh', 'function isPolite']) expect(script).toContain(name);
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

  it('D8.12 (2026-11-15): the session tally sits under the scores once a game has been played, between games and while playing', () => {
    const p = loadPage({ mic: true, capture: true });
    const players = [
      { id: 'owner', name: 'Owner', score: 10, ballsDone: 3, isUp: false, flags: [] },
      { id: 'krobs', name: 'Krobs', score: 20, ballsDone: 3, isUp: false, flags: [] },
    ];
    // No result yet: the strip is the two rows and nothing else.
    p.emit(PANEL_CHANNELS.state, state({ players }));
    expect(p.el('strip').children.map((c) => c.className)).toEqual(['row', 'row']);
    const series = [
      { id: 'krobs', name: 'Krobs', wins: 2, games: 3, total: 60, place: 1 },
      { id: 'owner', name: 'Owner', wins: 1, games: 3, total: 40, place: 2 },
    ];
    const result = [{ id: 'krobs', name: 'Krobs', score: 20, place: 1 }, { id: 'owner', name: 'Owner', score: 10, place: 2 }];
    p.emit(PANEL_CHANNELS.state, state({ phase: 'over', playerUp: null, ball: null, players, result, game: 3, series, seriesOver: false }));
    expect(p.el('strip').children.map((c) => c.className)).toEqual(['row', 'row', 'tally']);
    expect(p.el('strip').children.at(-1)?.textContent).toBe('3 GAMES PLAYED · Owner 1 · Krobs 2');
    p.emit(PANEL_CHANNELS.state, state({ players, game: 4, series }));
    expect(p.el('strip').children.at(-1)?.textContent).toBe('3 GAMES PLAYED · Owner 1 · Krobs 2');
  });

  it('D8.10 (2026-11-14): draws the in-game menu over the panel while main sends one, and takes it away on null', () => {
    const p = loadPage({ mic: true, capture: true });
    expect(p.el('menu').className).toBe('');
    p.emit(PANEL_CHANNELS.menu, { items: [{ label: 'Start match', value: null, off: true }, { label: 'Voice volume', value: '150 %', off: false }], index: 1, note: 'Nobody has joined yet', hint: 'Ctrl+Alt+M: next line' });
    expect(p.el('menu').className).toBe('open');
    expect(p.el('menuitems').children.map((c) => c.className)).toEqual(['mi off', 'mi sel']);
    expect(p.el('menuitems').text()).toContain('Voice volume 150 %');
    expect(p.el('menunote').textContent).toBe('Nobody has joined yet');
    expect(p.el('menuhint').textContent).toBe('Ctrl+Alt+M: next line');
    p.emit(PANEL_CHANNELS.menu, null);
    expect(p.el('menu').className).toBe('');
    expect(p.el('menuitems').children).toEqual([]);
  });

  it("A17 step 1 (the review of PR 127): a peer named while attach() still opens the microphone and the capture is added after them, with the attach's own peers: its connection is made with the microphone on it, and the timer's resend is the one that backs off", async () => {
    const p = loadPage({ mic: true, capture: true });
    // The join on this build: main posts the attach with no peers and names the lobby's players right behind it.
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: [], ice: [], capture: CAP, micDeviceId: null, muted: false, sending: false });
    p.emit(PANEL_CHANNELS.addPeer, 'krobs');
    p.emit(PANEL_CHANNELS.addPeer, 'third');
    p.emit(PANEL_CHANNELS.addPeer, 'krobs'); // named twice: once on the page
    p.emit(PANEL_CHANNELS.removePeer, 'third'); // left again before the page was up: never connected
    // Nothing is connected while the microphone is not there: a connection made now would offer without it, offer
    // again when it comes, and a PC on 0.2.50 answers the first offer many times over.
    expect(FakePeerConnection.all).toHaveLength(0);
    await settle();
    expect(FakePeerConnection.all).toHaveLength(1);
    expect(FakePeerConnection.all[0]?.senders.map((s) => s.track.kind)).toEqual(['audio', 'video']);
    // Once the page is up a peer is added the moment it is named, as before.
    p.emit(PANEL_CHANNELS.addPeer, 'fourth');
    expect(FakePeerConnection.all).toHaveLength(2);
    expect(FakePeerConnection.all[1]?.senders.map((s) => s.track.kind)).toEqual(['audio', 'video']);
    // A page that is replaced while it waits adds nothing for the attach that is gone.
    const q = loadPage({ mic: true, capture: true });
    q.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: null, micDeviceId: null, muted: false, sending: false });
    q.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['chuck'], ice: [], capture: null, micDeviceId: null, muted: false, sending: false });
    await settle();
    expect(FakePeerConnection.all).toHaveLength(1);
    // The 5 s timer while a connection is not up asks the negotiator's `resendWaitingOffer` (less and less often to a
    // peer that has never answered), not `resendOffer` at every look.
    expect(q.script).toContain('n.resendWaitingOffer()');
    expect(q.script).not.toMatch(/completed'\) n\.resendOffer\(\)/);
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
    expect(video.track.contentHint).toBe('detail');
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
    m.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs', 'chuck'], ice: [], capture: { ...CAP, stereo: 'sbs' }, micDeviceId: null, muted: false, sending: false, reset: true });
    await settle();
    for (const pc of FakePeerConnection.all) pc.onnegotiationneeded?.();
    await settle();
    const kinds = m.sent.filter((s) => s.channel === PANEL_CHANNELS.send).map((s) => s.arg as { to: string; signal: { kind: string; stereo?: string } });
    expect(kinds.slice(0, 2)).toEqual([
      { to: 'krobs', signal: { kind: 'reset' } },
      { to: 'chuck', signal: { kind: 'reset' } },
    ]);
    expect(kinds.filter((k) => k.signal.kind === 'stereo')).toEqual([
      { to: 'krobs', signal: { kind: 'stereo', stereo: 'sbs' } },
      { to: 'chuck', signal: { kind: 'stereo', stereo: 'sbs' } },
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
    expect(sender.track.contentHint).toBe('detail');

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

  it('the feed is the video at its own size, scaled down into 1920x1440 (a side-by-side one into 3840x1440), even sides', () => {
    expect(VIDEO_FEED_MAX).toEqual({ mono: { width: 1920, height: 1440 }, sbs: { width: 3840, height: 1440 }, fps: 30 });
    expect(feedSize(1280, 720, 'mono')).toEqual({ width: 1280, height: 720 });
    expect(feedSize(2560, 1440, 'mono')).toEqual({ width: 1920, height: 1080 });
    expect(feedSize(1281, 721, 'mono')).toEqual({ width: 1280, height: 720 });
    expect(feedSize(2560, 720, 'sbs')).toEqual({ width: 2560, height: 720 });
    expect(feedSize(5120, 1440, 'sbs')).toEqual({ width: 3840, height: 1080 });
    // D7.4.9: the owner's both-eyes window (1440x1392) lands whole; a taller one scales into 1440 high
    expect(feedSize(1440, 1392, 'sbs')).toEqual({ width: 1440, height: 1392 });
    expect(feedSize(2880, 1600, 'sbs')).toEqual({ width: 2592, height: 1440 });
    // D8.1: a mono picture may be 1440 high too: the one-eye layer camera's 1354x1440 lands whole; taller scales into 1440
    expect(feedSize(1440, 1392, 'mono')).toEqual({ width: 1440, height: 1392 });
    expect(feedSize(1354, 1440, 'mono')).toEqual({ width: 1354, height: 1440 });
    expect(feedSize(1080, 1920, 'mono')).toEqual({ width: 810, height: 1440 });
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
    expect(last()).toEqual({ seq: 1, capture: null, decoded: 28, toLayer: 4, decodedSize: { width: 1280, height: 720 } });
    video.total = 35;
    feed.cb();
    stats.cb();
    expect(last()).toEqual({ seq: 2, capture: null, decoded: 7, toLayer: 1, decodedSize: { width: 1280, height: 720 } });
  });
});

describe('videoBitrateFor (D7.4.6)', () => {
  it('a mono landscape picture up to 1280x720 keeps 2.5 Mbps', () => {
    expect(videoBitrateFor({ width: 1280, height: 720, stereo: 'mono' })).toBe(2_500_000);
    expect(videoBitrateFor({ width: 800, height: 600, stereo: null })).toBe(2_500_000);
  });
  it('side by side, portrait or larger scale with pixels, up to 8 Mbps', () => {
    expect(videoBitrateFor({ width: 1280, height: 1080, stereo: 'sbs' })).toBe(5_400_000);
    expect(videoBitrateFor({ width: 2560, height: 720, stereo: 'sbs' })).toBe(7_200_000);
    expect(videoBitrateFor({ width: 1440, height: 1392, stereo: 'sbs' })).toBe(7_800_000);
    expect(videoBitrateFor({ width: 1080, height: 1920, stereo: 'mono' })).toBe(8_000_000);
    // D8.1: the one-eye layer camera's portrait picture (a 3072x3264 eye in the 1440 box) is rated by the pixel rule: 7.6 Mbps
    expect(videoBitrateFor({ width: 1354, height: 1440, stereo: 'mono' })).toBe(7_600_000);
    expect(videoBitrateFor({ width: 720, height: 1440, stereo: 'mono' })).toBe(4_000_000);
    expect(videoBitrateFor({ width: 720, height: 1280, stereo: 'mono' })).toBe(3_600_000);
    expect(videoBitrateFor({ width: 1280, height: 720, stereo: 'sbs' })).toBe(3_600_000);
  });
  it('a size not known gets the base rate', () => {
    expect(videoBitrateFor({ width: 0, height: 0, stereo: 'mono' })).toBe(2_500_000);
  });
});

describe('hardware H.264 and a start bitrate at the cap (D8.3, 2026-11-05)', () => {
  // Chromium's video capabilities on an NVIDIA rig, in its own order (VP8 first), with the rtx / red / fec entries.
  const h264 = (profile: string, mode: 0 | 1) => ({ mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}` });
  const CAPS: { mimeType: string; clockRate: number; sdpFmtpLine?: string }[] = [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/rtx', clockRate: 90000, sdpFmtpLine: 'apt=96' },
    { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' },
    h264('42001f', 1),
    h264('42001f', 0),
    h264('42e01f', 1),
    h264('42e01f', 0),
    h264('4d001f', 1),
    h264('640032', 1),
    h264('64001f', 1),
    { mimeType: 'video/AV1', clockRate: 90000 },
    { mimeType: 'video/red', clockRate: 90000 },
    { mimeType: 'video/ulpfec', clockRate: 90000 },
    { mimeType: 'video/flexfec-03', clockRate: 90000, sdpFmtpLine: 'repair-window=10000000' },
  ];

  it('preferH264: H.264 first (mode 1 before 0; 42e01f, then 640032, then other high, then the rest), everything else in its order', () => {
    const out = preferH264(CAPS);
    expect(out.map((c) => (c.mimeType === 'video/H264' ? c.sdpFmtpLine!.replace('level-asymmetry-allowed=1;', '') : c.mimeType))).toEqual([
      'packetization-mode=1;profile-level-id=42e01f',
      'packetization-mode=1;profile-level-id=640032',
      'packetization-mode=1;profile-level-id=64001f',
      'packetization-mode=1;profile-level-id=42001f',
      'packetization-mode=1;profile-level-id=4d001f',
      'packetization-mode=0;profile-level-id=42e01f',
      'packetization-mode=0;profile-level-id=42001f',
      'video/VP8',
      'video/rtx',
      'video/VP9',
      'video/AV1',
      'video/red',
      'video/ulpfec',
      'video/flexfec-03',
    ]);
    // The very objects Chromium listed, each once; the mime type's case does not matter; no H.264 at all: as given.
    expect(out).toHaveLength(CAPS.length);
    for (const c of out) expect(CAPS.includes(c)).toBe(true);
    expect(preferH264([{ mimeType: 'video/VP8' }, { mimeType: 'video/h264', sdpFmtpLine: 'profile-level-id=42E01F;packetization-mode=1' }]).map((c) => c.mimeType)).toEqual(['video/h264', 'video/VP8']);
    expect(preferH264([{ mimeType: 'video/VP8' }, { mimeType: 'video/VP9' }]).map((c) => c.mimeType)).toEqual(['video/VP8', 'video/VP9']);
    expect(preferH264([])).toEqual([]);
  });

  it('bitrateHintsFor: the cap in kbps as the start, 40 % of it as the floor', () => {
    expect(bitrateHintsFor(2_500_000)).toEqual({ startKbps: 2500, minKbps: 1000 });
    expect(bitrateHintsFor(7_800_000)).toEqual({ startKbps: 7800, minKbps: 3120 });
    expect(bitrateHintsFor(8_000_000)).toEqual({ startKbps: 8000, minKbps: 3200 });
    expect(bitrateHintsFor(0)).toEqual({ startKbps: 1, minKbps: 1 });
  });

  // A Chromium answer: voice, two video codecs with fmtp lines, one without, rtx / red / fec payloads, then the table sound.
  const SDP = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:0',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 102 103 96 97 98 99 100',
    'a=mid:1',
    'a=rtpmap:102 H264/90000',
    'a=rtcp-fb:102 nack',
    'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=rtpmap:103 rtx/90000',
    'a=fmtp:103 apt=102',
    'a=rtpmap:96 VP8/90000',
    'a=rtcp-fb:96 nack',
    'a=rtpmap:97 rtx/90000',
    'a=fmtp:97 apt=96',
    'a=rtpmap:98 VP9/90000',
    'a=fmtp:98 profile-id=0',
    'a=rtpmap:99 red/90000',
    'a=rtpmap:100 ulpfec/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:2',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1',
    '',
  ].join('\r\n');

  it('withBitrateHints: every video codec of the m=video section gets the hints on its fmtp line (one added where there is none); rtx / red / fec and audio untouched', () => {
    const out = withBitrateHints(SDP, { startKbps: 5400, minKbps: 2160 });
    const lines = out.split('\r\n');
    expect(lines).toContain('a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=5400;x-google-min-bitrate=2160');
    expect(lines).toContain('a=fmtp:98 profile-id=0;x-google-start-bitrate=5400;x-google-min-bitrate=2160');
    // VP8 had no fmtp line: one follows its rtpmap.
    expect(lines.indexOf('a=fmtp:96 x-google-start-bitrate=5400;x-google-min-bitrate=2160')).toBe(lines.indexOf('a=rtpmap:96 VP8/90000') + 1);
    expect(lines).toContain('a=fmtp:103 apt=102');
    expect(lines).toContain('a=fmtp:97 apt=96');
    expect(lines.filter((l) => l.startsWith('a=fmtp:99') || l.startsWith('a=fmtp:100'))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('a=fmtp:111'))).toEqual(['a=fmtp:111 minptime=10;useinbandfec=1', 'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1']);
    // Nothing else changed: the lines without hints are the input's, in order; the line ending is kept.
    expect(lines.filter((l) => l.indexOf('x-google') < 0)).toEqual(SDP.split('\r\n').filter((l) => !l.startsWith('a=fmtp:102') && !l.startsWith('a=fmtp:98')));
    expect(out.indexOf('\n')).toBeGreaterThan(0);
    expect(out.split('\n').every((l, i, all) => i === all.length - 1 || l.endsWith('\r'))).toBe(true);
    // The max only when asked; the start alone otherwise.
    expect(withBitrateHints('v=0\nm=video 9 RTP 96\na=rtpmap:96 VP8/90000\n', { startKbps: 2500, maxKbps: 8000 })).toBe('v=0\nm=video 9 RTP 96\na=rtpmap:96 VP8/90000\na=fmtp:96 x-google-start-bitrate=2500;x-google-max-bitrate=8000\n');
    expect(withBitrateHints('v=0\nm=video 9 RTP 96\na=rtpmap:96 VP8/90000\n', { startKbps: 2500 })).toBe('v=0\nm=video 9 RTP 96\na=rtpmap:96 VP8/90000\na=fmtp:96 x-google-start-bitrate=2500\n');
  });

  it('withBitrateHints: hinting again replaces the hints (idempotent, a new cap wins); several m=video sections; no video: as given', () => {
    const once = withBitrateHints(SDP, { startKbps: 5400, minKbps: 2160 });
    expect(withBitrateHints(once, { startKbps: 5400, minKbps: 2160 })).toBe(once);
    const again = withBitrateHints(once, { startKbps: 8000, minKbps: 3200 });
    expect(again).toBe(withBitrateHints(SDP, { startKbps: 8000, minKbps: 3200 }));
    expect(again).not.toContain('5400');
    expect(again.split('\r\n')).toContain('a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=8000;x-google-min-bitrate=3200');
    const two = SDP + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:3\r\na=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=300\r\n';
    const out = withBitrateHints(two, { startKbps: 2500, minKbps: 1000 }).split('\r\n');
    expect(out.filter((l) => l.startsWith('a=fmtp:96'))).toEqual(['a=fmtp:96 x-google-start-bitrate=2500;x-google-min-bitrate=1000', 'a=fmtp:96 x-google-start-bitrate=2500;x-google-min-bitrate=1000']);
    const audioOnly = 'v=0\r\nm=audio 9 RTP 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n';
    expect(withBitrateHints(audioOnly, { startKbps: 2500, minKbps: 1000 })).toBe(audioOnly);
    expect(withBitrateHints('answer-sdp', { startKbps: 2500 })).toBe('answer-sdp');
  });

  it('on the page: H.264 first on the video transceiver when the sender is added, the hints at the cap on every remote description, the encoder reported and logged once', async () => {
    const g = globalThis as { RTCRtpSender?: unknown };
    g.RTCRtpSender = { getCapabilities: (kind: string) => (kind === 'video' ? { codecs: CAPS } : { codecs: [] }) };
    try {
      const p = loadPage({ mic: true, capture: true });
      p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture: CAP, micDeviceId: null, muted: false, sending: true });
      await settle();
      const pc = FakePeerConnection.all[0]!;
      const video = pc.senders.find((s) => s.track.kind === 'video')!;
      const tr = pc.transceivers.find((t) => t.sender === video)!;
      expect((tr.preferences as { mimeType: string }[]).slice(0, 2).map((c) => c.mimeType)).toEqual(['video/H264', 'video/H264']);
      expect(tr.preferences).toEqual(preferH264(CAPS));
      expect(pc.transceivers.find((t) => t.sender === pc.senders[0])!.preferences).toBeNull(); // the mic's: untouched
      // The answer the peer sends: its VP8 gets the start / min hints at this sender's cap (CAP is 1280x720 mono: 2.5 Mbps).
      pc.onnegotiationneeded?.();
      await settle();
      p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'answer', sdp: 'v=0\r\nm=video 9 RTP 96\r\na=rtpmap:96 VP8/90000\r\n' } });
      await settle();
      expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\nm=video 9 RTP 96\r\na=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=2500;x-google-min-bitrate=1000\r\n' });
      expect(video.params.encodings[0]).toEqual({ maxBitrate: 2_500_000, maxFramerate: 30 });
      // The peer's offer (an ICE restart of its own) goes through the same door.
      p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'offer', sdp: 'v=0\r\nm=video 9 RTP 102\r\na=rtpmap:102 H264/90000\r\na=fmtp:102 packetization-mode=1\r\n' } });
      await settle();
      expect(pc.remoteDescription?.sdp).toBe('v=0\r\nm=video 9 RTP 102\r\na=rtpmap:102 H264/90000\r\na=fmtp:102 packetization-mode=1;x-google-start-bitrate=2500;x-google-min-bitrate=1000\r\n');
      // The stats tick: the codec by codecId and the encoder on `sent`; one log line when they become known, none while repeated.
      const stats = p.intervals.find((i) => i.ms === STATS_MS)!;
      const logs = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.log).map((s) => s.arg as string).filter((l) => l.startsWith('encoder'));
      const last = () => (p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { stats: { sent?: unknown } | null }).stats;
      pc.stats = new Map<string, Record<string, unknown>>([
        ['c1', { type: 'codec', mimeType: 'video/H264', clockRate: 90000 }],
        ['o1', { type: 'outbound-rtp', kind: 'video', codecId: 'c1', encoderImplementation: 'unknown', frameWidth: 1280, frameHeight: 720, bytesSent: 0, qualityLimitationReason: 'none' }],
      ]);
      stats.cb();
      await settle();
      expect(logs()).toEqual(['encoder: H264']);
      pc.stats.set('o1', { type: 'outbound-rtp', kind: 'video', codecId: 'c1', encoderImplementation: 'MediaFoundationVideoEncodeAccelerator', frameWidth: 1280, frameHeight: 720, bytesSent: 9_250_000, qualityLimitationReason: 'none' });
      stats.cb();
      await settle();
      stats.cb();
      await settle();
      expect(last()?.sent).toEqual({ width: 1280, height: 720, kbps: 7400, limit: 'none', codec: 'H264', encoder: 'MediaFoundationVideoEncodeAccelerator' });
      expect(logs()).toEqual(['encoder: H264', 'encoder: H264 via MediaFoundationVideoEncodeAccelerator']);
      // A page without RTCRtpSender (or a connection without transceivers) sets no preference and still negotiates.
      delete g.RTCRtpSender;
      p.emit(PANEL_CHANNELS.addPeer, 'third');
      await settle();
      const third = FakePeerConnection.all[1]!;
      expect(third.senders.map((s) => s.track.kind)).toContain('video');
      expect(third.transceivers.every((t) => t.preferences === null)).toBe(true);
    } finally {
      delete g.RTCRtpSender;
    }
  });
});

describe('ICE: the candidate pair and the watchdog (D2.9, 2026-11-02)', () => {
  const report = (o: { selected?: string; pairs?: Array<Record<string, unknown>> } = {}): Array<Record<string, unknown>> => [
    ...(o.selected ? [{ type: 'transport', id: 'T1', selectedCandidatePairId: o.selected }] : []),
    { type: 'local-candidate', id: 'L1', candidateType: 'host', protocol: 'udp', address: '192.168.1.5' },
    { type: 'local-candidate', id: 'L2', candidateType: 'srflx', protocol: 'udp', address: '203.0.113.7' },
    { type: 'remote-candidate', id: 'R1', candidateType: 'srflx', protocol: 'udp', address: '198.51.100.9' },
    ...(o.pairs ?? []),
  ];
  const pair = (id: string, l: string, r: string, state: string, more: Record<string, unknown> = {}) => ({ type: 'candidate-pair', id, localCandidateId: l, remoteCandidateId: r, state, ...more });

  it('icePairInfo: the transport-selected pair, else a nominated succeeded one; types, protocol and rtt, no address', () => {
    const sel = icePairInfo(report({ selected: 'P2', pairs: [pair('P1', 'L1', 'R1', 'failed'), pair('P2', 'L2', 'R1', 'succeeded', { nominated: true, currentRoundTripTime: 0.0342 })] }));
    expect(sel).toEqual({ pair: { state: 'succeeded', local: 'srflx', remote: 'srflx', protocol: 'udp', rttMs: 34 }, tried: 2, failed: 1, local: ['host', 'srflx'], remote: ['srflx'] });
    expect(JSON.stringify(sel)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    const nominated = icePairInfo(report({ pairs: [pair('P1', 'L1', 'R1', 'in-progress'), pair('P2', 'L2', 'R1', 'succeeded', { nominated: true })] }));
    expect(nominated.pair).toMatchObject({ local: 'srflx', remote: 'srflx', rttMs: null });
    expect(icePairInfo(report({ pairs: [pair('P1', 'L1', 'R1', 'in-progress'), pair('P2', 'L2', 'R1', 'failed')] })).pair).toBeNull();
    expect(icePairInfo([])).toEqual({ pair: null, tried: 0, failed: 0, local: [], remote: [] });
  });

  it('icePairText: the pair as the log says it, or why there is none', () => {
    const ok = icePairInfo(report({ selected: 'P2', pairs: [pair('P2', 'L2', 'R1', 'succeeded', { currentRoundTripTime: 0.05 })] }));
    expect(icePairText(ok, true)).toBe('pair srflx -> srflx udp succeeded, rtt 50 ms');
    expect(icePairText(ok, false)).toBe('pair srflx -> srflx udp succeeded');
    const stuck = icePairInfo(report({ pairs: [pair('P1', 'L1', 'R1', 'failed'), pair('P2', 'L2', 'R1', 'in-progress')] }));
    expect(icePairText(stuck, true)).toBe('no pair yet (2 tried, 1 failed; local host+srflx, remote srflx)');
    expect(icePairText(icePairInfo([]), true)).toBe('no pair yet (0 tried, 0 failed; local none, remote none)');
  });

  it('iceUfrag: the first ice-ufrag of an SDP, null without one', () => {
    expect(iceUfrag('v=0\r\na=ice-ufrag:AbC1\r\na=ice-pwd:x\r\nm=audio\r\na=ice-ufrag:AbC1\r\n')).toBe('AbC1');
    expect(iceUfrag('v=0\r\n')).toBeNull();
    expect(iceUfrag(null)).toBeNull();
  });

  it('I11.12: the schedule is 3, 3, 6, 6, 12, 12 s, a lag of 3 s, and for the first two restarts a wait an 0.2.50 peer needs', () => {
    expect(ICE_WATCH).toEqual({ backoffMs: [3_000, 3_000, 6_000, 6_000, 12_000, 12_000], lagMs: 3_000, waitMs: [14_000, 28_000], lateMs: 30_000, tickMs: 1_000 });
    expect(ICE_ROUND_LOOK).toEqual({ everyMs: 50, forMs: 3_000, keepMs: 1_000 });
  });

  it('iceWatchStep: the side whose turn it is restarts after 3, 3, 6, 6, 12, 12 s; the turns alternate, the usual lead first; give up 12 s after the sixth', () => {
    const step = (ice: string, s: number, n: number, lead = true) => iceWatchStep(ice, s * 1000, n, lead, ICE_WATCH);
    expect(step('connected', 999, 3)).toBe('ok');
    expect(step('completed', 0, 0)).toBe('ok');
    expect(step('closed', 999, 0)).toBe('wait');
    for (const ice of ['new', 'checking', 'disconnected']) {
      expect(step(ice, 2.9, 0)).toBe('wait');
      expect(step(ice, 3, 0)).toBe('restart');
    }
    // Restart 1, 3, 5 (0, 2, 4 made so far) is the usual lead's turn; restart 2, 4, 6 the other side's.
    const delays = [3, 3, 6, 6, 12, 12];
    for (let k = 0; k < 6; k++) {
      const turn = k % 2 === 0;
      expect(step('checking', delays[k]! - 0.1, k, turn), `restart ${k + 1}, its side, too soon`).toBe('wait');
      expect(step('checking', delays[k]!, k, turn), `restart ${k + 1}, its side`).toBe('restart');
      // The side whose turn it is not is still waiting then.
      expect(step('checking', delays[k]!, k, !turn), `restart ${k + 1}, the other side`).toBe('wait');
    }
    // The side whose turn it is not steps in: after 14 s and 28 s for the first two (an 0.2.50 lead restarts at 10 s,
    // an 0.2.50 other side 25 s after the first), 3 s after the turn's time from the third on.
    const waits = [14, 28, 9, 9, 15, 15];
    for (let k = 0; k < 6; k++) {
      const turn = k % 2 === 0;
      expect(step('checking', waits[k]! - 0.1, k, !turn), `restart ${k + 1}, in the other's place, too soon`).toBe('wait');
      expect(step('checking', waits[k]!, k, !turn), `restart ${k + 1}, in the other's place`).toBe('restart');
    }
    // After the sixth: 12 s more and it gives up (the side whose turn the seventh would not be: 3 s later).
    expect(step('checking', 11.9, 6)).toBe('wait');
    expect(step('checking', 12, 6)).toBe('give_up');
    expect(step('checking', 14.9, 6, false)).toBe('wait');
    expect(step('checking', 15, 6, false)).toBe('give_up');
    expect(step('checking', 999, 9)).toBe('give_up');
    // failed before any restart: the browser gave up on every pair, so the first restart is at once (the other side
    // 3 s later, not 14); the schedule holds after it
    expect(step('failed', 0, 0)).toBe('restart');
    expect(step('failed', 2.9, 0, false)).toBe('wait');
    expect(step('failed', 3, 0, false)).toBe('restart');
    expect(step('failed', 2.9, 1, false)).toBe('wait');
    expect(step('failed', 3, 1, false)).toBe('restart');
    expect(step('failed', 12, 6)).toBe('give_up');
    // A schedule without the waits (the rules of 0.2.50, as a caller may still pass them): the lag alone.
    const old = { backoffMs: [10_000, 20_000, 40_000], lagMs: 5_000 };
    expect(iceWatchStep('checking', 10_000, 0, true, old)).toBe('restart');
    expect(iceWatchStep('checking', 14_999, 0, false, old)).toBe('wait');
    expect(iceWatchStep('checking', 15_000, 0, false, old)).toBe('restart');
  });

  it('iceWatchStep, persist (the picture has a direct pair to the peer): never give_up; after the sixth one restart every 30 s, the turns going on', () => {
    const step = (s: number, n: number, lead: boolean, persist: boolean) => iceWatchStep('disconnected', s * 1000, n, lead, ICE_WATCH, persist);
    // The scheduled restarts are the same with it.
    expect(step(3, 0, true, true)).toBe('restart');
    expect(step(13.9, 0, false, true)).toBe('wait');
    // Past the schedule: where it would give up at 12 s, it waits for 30 s and restarts (restart 7 is the usual lead's).
    expect(step(12, 6, true, false)).toBe('give_up');
    expect(step(12, 6, true, true)).toBe('wait');
    expect(step(29.9, 6, true, true)).toBe('wait');
    expect(step(30, 6, true, true)).toBe('restart');
    expect(step(30, 6, false, true)).toBe('wait');
    expect(step(33, 6, false, true)).toBe('restart');
    // Restart 8 is the other side's.
    expect(step(30, 7, false, true)).toBe('restart');
    expect(step(30, 7, true, true)).toBe('wait');
    expect(step(33, 7, true, true)).toBe('restart');
    expect(step(9_999, 40, true, true)).toBe('restart');
  });

  it('iceRestartName: within the schedule and past it', () => {
    expect(iceRestartName(1, 6)).toBe('restart 1 of 6');
    expect(iceRestartName(6, 6)).toBe('restart 6 of 6');
    expect(iceRestartName(7, 6)).toBe('late restart 7');
  });

  it('noPathText: names the player and the state; says what is missing', () => {
    expect(noPathText('Krobs', 'checking', 3, false)).toBe('No path to Krobs (ICE checking after 3 restarts): both routers blocked the direct connection; a TURN relay is needed.');
    expect(noPathText('Krobs', 'failed', 3, true)).toBe('No path to Krobs (ICE failed after 3 restarts): the TURN relay did not get through either.');
    // D2.12: nothing was tried, so no router is blamed.
    expect(noPathText('Krobs', 'new', 3, false)).toBe('Voice with Krobs did not start (ICE new after 3 restarts): leave the match and join again.');
    // I11.12 (2026-11-24): the native video holds a direct pair to the same player: no router is blamed and no relay asked for.
    const direct = noPathText('ChuckRibbits', 'disconnected', 6, false, true);
    expect(direct).toBe('Voice with ChuckRibbits is not connected yet (ICE disconnected after 6 restarts). The picture has a direct path to their PC, so no relay is needed: still trying.');
    expect(direct).not.toMatch(/TURN|blocked|No path/);
    expect(noPathText('ChuckRibbits', 'checking', 8, true, true)).not.toMatch(/TURN|blocked|No path/);
    expect(noPathText('ChuckRibbits', 'new', 6, false, true)).toBe('Voice with ChuckRibbits did not start (ICE new after 6 restarts): leave the match and join again.');
    // I11.12 (2026-11-24): the restarts go on after these words, and the words without a direct picture say so too.
    expect(noPathText('Krobs', 'checking', 6, false, false, true)).toBe('No path to Krobs (ICE checking after 6 restarts): both routers blocked the direct connection; a TURN relay is needed. Still trying.');
    expect(noPathText('Krobs', 'failed', 6, true, false, true)).toBe('No path to Krobs (ICE failed after 6 restarts): the TURN relay did not get through either. Still trying.');
    expect(noPathText('ChuckRibbits', 'disconnected', 6, false, true, true)).toBe(direct);
  });

  it('iceRoundSparse: of the rounds a late restart ends, the first is written in full and then every tenth', () => {
    for (let k = 1; k <= 6; k++) expect(iceRoundSparse(k, 6), `restart ${k}`).toBe(false);
    expect(iceRoundSparse(7, 6)).toBe(false);
    for (let k = 8; k <= 16; k++) expect(iceRoundSparse(k, 6), `restart ${k}`).toBe(true);
    expect(iceRoundSparse(17, 6)).toBe(false);
    expect(iceRoundSparse(18, 6)).toBe(true);
    expect(iceRoundSparse(27, 6)).toBe(false);
    // The switch's seven (CASTCADE_ICE_FIRST_RESTART_MS): the same from the eighth on.
    expect(iceRoundSparse(7, 7)).toBe(false);
    expect(iceRoundSparse(8, 7)).toBe(false);
    expect(iceRoundSparse(9, 7)).toBe(true);
  });

  it('the page: a connection stuck in checking restarts ICE on the backoff, then says there is no path; connected clears it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const restart = vi.spyOn(FakePeerConnection.prototype, 'restartIce');
    try {
      const p = loadPage({ mic: true, capture: false });
      // owner > krobs: owner is the impolite side and leads the restart
      p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [{ urls: ['stun:x'] }], capture: null, micDeviceId: null, muted: false, sending: false });
      p.emit(PANEL_CHANNELS.state, state());
      await settle();
      const pc = FakePeerConnection.all[0]!;
      pc.onnegotiationneeded?.();
      await settle();
      p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'answer', sdp: 'answer session:k1' } });
      await settle();
      const tick = p.intervals.find((i) => i.ms === ICE_WATCH.tickMs)!;
      const logs = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.log).map((s) => s.arg as string);
      const status = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { error: string | null };
      tick.cb();
      expect(restart).not.toHaveBeenCalled();
      pc.iceConnectionState = 'checking';
      tick.cb();
      vi.advanceTimersByTime(2_900);
      tick.cb();
      expect(restart).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      tick.cb();
      expect(restart).toHaveBeenCalledTimes(1);
      expect(logs().at(-1)).toBe('peer krobs: ICE restart 1 of 6 (checking for 3 s, our turn; no pair yet)');
      // I11.12: restart 2 is the peer's turn. It does not take it (this fake never restarts), so this side steps in:
      // after 28 s (a peer on 0.2.50 would make its own 25 s after the first), not before.
      vi.advanceTimersByTime(27_000);
      tick.cb();
      expect(restart).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_000);
      tick.cb();
      expect(restart).toHaveBeenCalledTimes(2);
      expect(logs().at(-1)).toBe('peer krobs: ICE restart 2 of 6 (checking for 28 s, the peer did not take its turn; no pair yet)');
      // Restart 3 (ours) 6 s on; 4 (the peer's, taken over 3 s late) 9 s; 5 (ours) 12 s; 6 (the peer's) 15 s.
      for (const [s, n] of [[6, 3], [9, 4], [12, 5], [15, 6]] as const) {
        vi.advanceTimersByTime(s * 1000 - 1_000);
        tick.cb();
        expect(restart).toHaveBeenCalledTimes(n - 1);
        vi.advanceTimersByTime(1_000);
        tick.cb();
        expect(restart).toHaveBeenCalledTimes(n);
      }
      expect(logs().at(-1)).toBe('peer krobs: ICE restart 6 of 6 (checking for 15 s, the peer did not take its turn; no pair yet)');
      vi.advanceTimersByTime(11_000);
      tick.cb();
      expect(status().error).toBeNull();
      vi.advanceTimersByTime(1_000);
      tick.cb();
      expect(restart).toHaveBeenCalledTimes(6);
      expect(logs().at(-1)).toBe('peer krobs: no path after 6 ICE restart(s), checking for 85 s; no pair yet; no TURN relay is set; still trying: an ICE restart every 30 s');
      const msg = 'No path to Krobs (ICE checking after 6 restarts): both routers blocked the direct connection; a TURN relay is needed. Still trying.';
      expect(status().error).toBe(msg);
      expect(p.el('msg').textContent).toBe(msg);
      // I11.12 (2026-11-24): "no path" is what is said, not the end. With no direct picture either (videoDirect was
      // never sent), restart 7 goes out 30 s after the sixth, and so on, turns alternating: a path that was away for a
      // minute is found again. The words stay the same meanwhile (the count in them is the one they were first said with).
      vi.advanceTimersByTime(17_000);
      tick.cb();
      expect(restart).toHaveBeenCalledTimes(6);
      vi.advanceTimersByTime(1_000);
      tick.cb();
      expect(restart).toHaveBeenCalledTimes(7);
      expect(logs().at(-1)).toBe('peer krobs: ICE late restart 7 (checking for 30 s, our turn; no pair yet)');
      vi.advanceTimersByTime(33_000);
      tick.cb();
      expect(restart).toHaveBeenCalledTimes(8);
      expect(logs().at(-1)).toBe('peer krobs: ICE late restart 8 (checking for 33 s, the peer did not take its turn; no pair yet)');
      expect(status().error).toBe(msg);
      expect(logs().filter((l) => l.includes('no path after'))).toHaveLength(1);
      // The late restarts are on: main is told, and does not write this peer's state changes one by one.
      expect((p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { peers: Record<string, { quiet?: boolean }> }).peers['krobs']?.quiet).toBe(true);
      // a path after all: the message goes, the outcome is logged
      pc.iceConnectionState = 'connected';
      vi.advanceTimersByTime(5_000);
      tick.cb();
      expect(logs().at(-1)).toBe('peer krobs: ICE connected after 8 restart(s), 141 s stuck');
      expect(status().error).toBeNull();
      expect((p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { peers: Record<string, { quiet?: boolean }> }).peers['krobs']?.quiet).toBeUndefined();
    } finally {
      restart.mockRestore();
      vi.useRealTimers();
    }
  });

  it('I11.12 (2026-11-24): while the native video holds a direct pair to the peer the page never asks for a TURN relay: it says the voice is still being tried and the picture has a direct path; the restarts are the same either way', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const restart = vi.spyOn(FakePeerConnection.prototype, 'restartIce');
    try {
      const p = loadPage({ mic: true, capture: false });
      p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [{ urls: ['stun:x'] }], capture: null, micDeviceId: null, muted: false, sending: false });
      p.emit(PANEL_CHANNELS.state, state());
      await settle();
      const pc = FakePeerConnection.all[0]!;
      pc.onnegotiationneeded?.();
      await settle();
      p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'answer', sdp: 'answer session:k1' } });
      await settle();
      const tick = p.intervals.find((i) => i.ms === ICE_WATCH.tickMs)!;
      const logs = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.log).map((s) => s.arg as string);
      const status = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { error: string | null };
      const seconds = (n: number): void => {
        for (let i = 0; i < n; i++) {
          vi.advanceTimersByTime(1_000);
          tick.cb();
        }
      };
      pc.iceConnectionState = 'checking';
      tick.cb();
      // The picture connects straight between the two PCs half a second in (2026-11-24: 0.3 s, in all eight matches).
      p.emit(PANEL_CHANNELS.videoDirect, ['krobs']);
      // The six scheduled restarts: 3 + 28 + 6 + 9 + 12 + 15 s, and 12 s more: nothing said until then.
      seconds(73);
      expect(restart).toHaveBeenCalledTimes(6);
      seconds(11);
      expect(status().error).toBeNull();
      seconds(1);
      // Where 0.2.50 gave up and asked for a relay, it says what is true, and goes on.
      const direct = 'Voice with Krobs is not connected yet (ICE checking after 6 restarts). The picture has a direct path to their PC, so no relay is needed: still trying.';
      expect(status().error).toBe(direct);
      expect(p.el('msg').textContent).toBe(direct);
      expect(logs().at(-1)).toBe('peer krobs: not connected after 6 ICE restart(s), checking for 85 s; no pair yet; the native video holds a direct pair to this peer; still trying: an ICE restart every 30 s');
      seconds(17);
      expect(restart).toHaveBeenCalledTimes(6);
      seconds(1);
      expect(restart).toHaveBeenCalledTimes(7);
      expect(logs().at(-1)).toBe('peer krobs: ICE late restart 7 (checking for 30 s, our turn; no pair yet)');
      // Restart 8 is the peer's turn: 3 s after its time this side makes it.
      seconds(33);
      expect(restart).toHaveBeenCalledTimes(8);
      expect(logs().at(-1)).toBe('peer krobs: ICE late restart 8 (checking for 33 s, the peer did not take its turn; no pair yet)');
      expect(logs().some((l) => l.includes('no path after'))).toBe(false);
      expect(p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).some((s) => /TURN|blocked/.test(String((s.arg as { error: string | null }).error)))).toBe(false);
      // The picture loses its direct pair: only the words change (the relay may be what is missing after all); the
      // restarts go on as they were, the next 30 s after the last.
      p.emit(PANEL_CHANNELS.videoDirect, []);
      expect(status().error).toBe('No path to Krobs (ICE checking after 6 restarts): both routers blocked the direct connection; a TURN relay is needed. Still trying.');
      seconds(29);
      expect(restart).toHaveBeenCalledTimes(8);
      seconds(1);
      expect(restart).toHaveBeenCalledTimes(9);
      // And it is back: the relay is no longer asked for.
      p.emit(PANEL_CHANNELS.videoDirect, ['krobs']);
      expect(status().error).toBe(direct);
      // Each state of the words was written to the log once by main (it logs a change): nothing here repeats them.
      expect(logs().filter((l) => /no path after|not connected after/.test(l))).toHaveLength(1);
      // Connected at last: the message goes.
      pc.iceConnectionState = 'connected';
      seconds(1);
      expect(status().error).toBeNull();
    } finally {
      restart.mockRestore();
      vi.useRealTimers();
    }
  });

  it("I11.12 (2026-11-24): a restart of the peer's that this side answered while it still read the connection as up is the first of the spell that begins here within 20 s: the counts agree, and restart 2 is this side's turn", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const restart = vi.spyOn(FakePeerConnection.prototype, 'restartIce');
    try {
      /** A page that is not the usual lead ('alice' < 'krobs'), connected to krobs, who then restarts ICE `before` ms before this side's ICE goes `disconnected`. */
      const run = async (before: number) => {
        restart.mockClear();
        const p = loadPage({ mic: true, capture: false });
        p.emit(PANEL_CHANNELS.attach, { localId: 'alice', peers: ['krobs'], ice: [{ urls: ['stun:x'] }], capture: null, micDeviceId: null, muted: false, sending: false });
        p.emit(PANEL_CHANNELS.state, state());
        await settle();
        const pc = FakePeerConnection.all[0]!;
        p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'offer', sdp: 'offer session:k1\r\na=ice-ufrag:uf1\r\n' } });
        await settle();
        pc.fire('signalingstatechange');
        const tick = p.intervals.find((i) => i.ms === ICE_WATCH.tickMs)!;
        const logs = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.log).map((s) => s.arg as string);
        expect(pc.iceConnectionState).toBe('connected');
        tick.cb();
        // The lead sees a blip first and restarts; this side answers, its own ICE still reading connected.
        vi.advanceTimersByTime(60_000);
        pc.remoteDescription = { type: 'offer', sdp: 'offer session:k1\r\na=ice-ufrag:uf2\r\n' };
        pc.localDescription = { type: 'answer', sdp: 'answer-sdp' };
        pc.fire('signalingstatechange');
        expect(logs().some((l) => l.includes('by the peer'))).toBe(false);
        vi.advanceTimersByTime(before);
        await settle();
        pc.iceConnectionState = 'disconnected';
        tick.cb();
        return { pc, tick, logs };
      };
      // 4 s later this side sees it too: the peer's restart was restart 1, so restart 2 is this side's, 3 s on.
      const soon = await run(4_000);
      expect(soon.logs().at(-1)).toBe('peer krobs: the peer restarted ICE 4 s before this side saw the trouble: that was restart 1 of 6, the next is our turn');
      vi.advanceTimersByTime(2_000);
      soon.tick.cb();
      expect(restart).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      soon.tick.cb();
      expect(restart).toHaveBeenCalledTimes(1);
      expect(soon.logs().at(-1)).toBe('peer krobs: ICE restart 2 of 6 (disconnected for 3 s, our turn; no pair yet)');
      // 25 s later is another trouble: this side's spell begins at restart 1, the lead's turn, for which it waits 14 s.
      const late = await run(25_000);
      expect(late.logs().some((l) => l.includes('before this side saw the trouble'))).toBe(false);
      vi.advanceTimersByTime(13_000);
      late.tick.cb();
      expect(restart).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      late.tick.cb();
      expect(restart).toHaveBeenCalledTimes(1);
      expect(late.logs().at(-1)).toBe('peer krobs: ICE restart 1 of 6 (disconnected for 14 s, the peer did not take its turn; no pair yet)');
    } finally {
      restart.mockRestore();
      vi.useRealTimers();
    }
  });

  it('I11.12 (2026-11-24): three hours beside a peer that never connects: one line per late restart and a round in full every five minutes, about 92 kB of companion.log; main is told the peer is quiet', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const restart = vi.spyOn(FakePeerConnection.prototype, 'restartIce');
    try {
      const p = loadPage({ mic: true, capture: false });
      p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [{ urls: ['stun:x'] }], capture: null, micDeviceId: null, muted: false, sending: false });
      p.emit(PANEL_CHANNELS.state, state());
      await settle();
      const pc = FakePeerConnection.all[0]!;
      pc.onnegotiationneeded?.();
      await settle();
      p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'answer', sdp: 'answer session:k1' } });
      await settle();
      const tick = p.intervals.find((i) => i.ms === ICE_WATCH.tickMs)!;
      const probe = p.intervals.find((i) => i.ms === 3000)!;
      const stats = p.intervals.find((i) => i.ms === STATS_MS)!;
      const report = p.intervals.find((i) => i.ms === 2000)!;
      // What a round nothing answers looks like in the stats: pairs that send and hear nothing, gone after 16 s.
      const entry = (e: Record<string, unknown>): [string, Record<string, unknown>] => [e.id as string, e];
      const candidates = [
        { id: 'L', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
        { id: 'R', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
      ];
      const checking = new Map([...candidates, { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'in-progress', requestsSent: 20, responsesReceived: 0, requestsReceived: 0, responsesSent: 0 }].map(entry));
      const gone = new Map([candidates[0]!].map(entry));
      pc.iceConnectionState = 'checking';
      tick.cb();
      const flush = async (): Promise<void> => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      };
      let made = 0;
      let madeAt = 0;
      const HOURS = 3;
      for (let s = 1; s <= HOURS * 3600; s++) {
        vi.advanceTimersByTime(1_000);
        if (restart.mock.calls.length !== made) {
          made = restart.mock.calls.length;
          madeAt = s;
        }
        // The browser's own states through a round: checking with pairs, then disconnected with none.
        pc.stats = s - madeAt < 16 ? checking : gone;
        pc.iceConnectionState = s - madeAt < 16 ? 'checking' : 'disconnected';
        tick.cb();
        if (s % 2 === 0) report.cb();
        if (s % 3 === 0) probe.cb();
        if (s % (STATS_MS / 1000) === 0) stats.cb();
        await flush();
      }
      const logs = p.sent.filter((s) => s.channel === PANEL_CHANNELS.log).map((s) => s.arg as string);
      // As companion.log has it: the time and level, `media: `, and a player id of 36 characters where this test says krobs.
      const bytes = (lines: string[]): number => lines.reduce((n, l) => n + l.length + 31 + 7 + (l.split('krobs').length - 1) * 31 + 1, 0);
      const late = logs.filter((l) => l.includes('late restart'));
      const lateRestarts = restart.mock.calls.length - 6;
      // A late restart every 30 s (its own turn) or 33 s (the peer's, which this fake never takes).
      expect(lateRestarts).toBeGreaterThan(330);
      expect(lateRestarts).toBeLessThan(345);
      // One line for each, and a round in full for the first and every tenth.
      expect(late.filter((l) => /: ICE late restart \d+ \(/.test(l))).toHaveLength(lateRestarts);
      const rounds = late.filter((l) => l.includes('ICE round'));
      expect(rounds).toHaveLength(Math.ceil(lateRestarts / 10));
      expect(rounds[0]).toContain('late restart 7 decided here after 30.00 s');
      expect(rounds[0]).toContain('; 1 pair as of ');
      // Nothing else is written in the late phase: no pair line, no state line of its own.
      const first = logs.findIndex((l) => l.includes('late restart 7 ('));
      expect(logs.slice(first).filter((l) => !l.includes('late restart'))).toEqual([]);
      const total = bytes(logs);
      // Measured here: 396 lines and 92 kB in three hours (340 late restarts, 34 rounds in full), of the megabyte
      // companion.log holds before it rolls over. A real round names more kinds of pair (up to 1200 characters a line).
      expect(logs.length).toBeLessThan(420);
      expect(total).toBeGreaterThan(80_000);
      expect(total).toBeLessThan(100_000);
      // And main: every report since the scheduled restarts were used up marks the peer quiet, so `peerChanges` writes
      // none of its four state changes a round.
      const statuses = p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).map((s) => s.arg as { peers: Record<string, { quiet?: boolean }> });
      expect(statuses.slice(-1000).every((s) => s.peers['krobs']?.quiet === true)).toBe(true);
    } finally {
      restart.mockRestore();
      vi.useRealTimers();
    }
  }, 60_000);

  it('I11.12: the page writes one line per ICE round of the voice connection: what every kind of pair sent and received when the restart was decided', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = loadPage({ mic: true, capture: false });
      p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [{ urls: ['stun:x'] }], capture: null, micDeviceId: null, muted: false, sending: false });
      p.emit(PANEL_CHANNELS.state, state());
      await settle();
      const pc = FakePeerConnection.all[0]!;
      pc.onnegotiationneeded?.();
      await settle();
      p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'answer', sdp: 'answer session:k1' } });
      await settle();
      // Checks go out on the one pair and nothing comes back (the first round between the two routers, 2026-11-18).
      pc.stats = new Map<string, Record<string, unknown>>([
        ['L', { id: 'L', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', address: '192.0.2.10', port: 50_000 }],
        ['R', { id: 'R', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp', address: '198.51.100.7', port: 61_000 }],
        ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'in-progress', requestsSent: 21, responsesReceived: 0, requestsReceived: 0, responsesSent: 0 }],
      ]);
      const tick = p.intervals.find((i) => i.ms === ICE_WATCH.tickMs)!;
      const look = p.intervals.find((i) => i.ms === ICE_ROUND_LOOK.everyMs)!;
      const logs = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.log).map((s) => s.arg as string);
      pc.iceConnectionState = 'checking';
      tick.cb();
      // I11.12 (2026-11-24): this side's server-reflexive candidate goes out, the peer's comes in, and the page's 50 ms
      // look at the stats sees the first check go out on that pair: the three times the line gives.
      vi.advanceTimersByTime(40);
      (pc.onicecandidate as (ev: { candidate: unknown }) => void)({ candidate: { candidate: 'candidate:1 1 udp 1677729535 192.0.2.10 50000 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag LoCa network-id 1', sdpMid: '0', sdpMLineIndex: 0 } });
      vi.advanceTimersByTime(60);
      p.emit(PANEL_CHANNELS.signal, { from: 'krobs', signal: { kind: 'ice', candidate: { candidate: 'candidate:2 1 udp 1677729535 198.51.100.7 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag ReMo network-id 1', sdpMid: '0', sdpMLineIndex: 0 } } });
      vi.advanceTimersByTime(50);
      look.cb();
      await settle();
      vi.advanceTimersByTime(2_850);
      tick.cb();
      await settle();
      const round = logs().filter((l) => l.includes('ICE round'));
      expect(round).toHaveLength(1);
      expect(round[0]).toMatch(
        /^peer krobs: ICE round 1: restart 1 of 6 decided here after \d\.\d\d s \(ice checking\); remote description (not seen|at \d+\.\d\d s), checking (not seen|at \d+\.\d\d s), not connected; srflx candidate sent at \d\.\d\d s, received at \d\.\d\d s; first check on a srflx pair sent at \d\.\d\d s, received not seen; 1 pair: srflx>srflx udp in-progress sent 21 answered 0, received 0 answered 0; this side leads restarts 1, 3, 5$/,
      );
      // The candidate sent 60 ms before the one received, the first check seen 50 ms after that.
      const at = (re: RegExp): number => Number(re.exec(round[0]!)?.[1]);
      expect(at(/received at (\d\.\d\d) s; first/) - at(/srflx candidate sent at (\d\.\d\d) s/)).toBeCloseTo(0.06, 2);
      expect(at(/pair sent at (\d\.\d\d) s/) - at(/received at (\d\.\d\d) s; first/)).toBeCloseTo(0.05, 2);
      expect(round[0]).not.toMatch(/192\.0\.2|198\.51|50000|61000|LoCa|ReMo|ufrag/);
      // The watchdog's own line is still there, as before.
      expect(logs()).toContain('peer krobs: ICE restart 1 of 6 (checking for 3 s, our turn; no pair yet)');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the layer camera on the page (D7.5.1, 2026-11-02)', () => {
  const GEO = { fov: [-0.9, 0.8, 0.9, -0.95], rect: [450, 0, 900, 1800], render: [1800, 1800] };
  const CAMERA = cameraCapture(720, 1440);

  it('helpers: the synthetic capture, its test, a frame checked, the eyes as a key, the stereo signal (unchanged without eyes)', () => {
    expect(CAMERA).toEqual({ sourceId: 'layer-camera', label: 'VR layer camera', screen: { width: 1440, height: 1440 }, crop: { x: 0, y: 0, width: 1440, height: 1440 }, out: { width: 1440, height: 1440 }, stereo: 'sbs' });
    expect(LAYER_CAMERA_SOURCE_ID).toBe(CAMERA.sourceId);
    expect(isCameraCapture(CAMERA)).toBe(true);
    expect(isCameraCapture(CAP)).toBe(false);
    expect(isCameraCapture(null)).toBe(false);
    const jpg = new Uint8Array([1, 2]);
    expect(cameraFrameSize({ width: 720, height: 1440, left: jpg, right: jpg })).toEqual({ width: 720, height: 1440, stereo: 'sbs' });
    expect(cameraFrameSize({ width: 720, height: 1440, left: new Uint8Array(0), right: jpg })).toBeNull();
    expect(cameraFrameSize({ width: 0, height: 1440, left: jpg, right: jpg })).toBeNull();
    expect(cameraFrameSize({ width: 5000, height: 1440, left: jpg, right: jpg })).toBeNull();
    expect(cameraFrameSize(null)).toBeNull();
    // D8.1: one eye (the other null or absent) is a mono frame; two empty eyes are not a frame.
    expect(cameraFrameSize({ width: 1354, height: 1440, left: jpg, right: null })).toEqual({ width: 1354, height: 1440, stereo: 'mono' });
    expect(cameraFrameSize({ width: 1354, height: 1440, left: null, right: jpg })).toEqual({ width: 1354, height: 1440, stereo: 'mono' });
    expect(cameraFrameSize({ width: 1354, height: 1440, left: jpg })).toEqual({ width: 1354, height: 1440, stereo: 'mono' });
    expect(cameraFrameSize({ width: 1354, height: 1440, left: null, right: null })).toBeNull();
    expect(cameraFrameSize({ width: 1354, height: 1440, left: new Uint8Array(0), right: null })).toBeNull();
    const MONO = cameraCapture(1354, 1440, 'mono');
    expect(MONO).toEqual({ sourceId: 'layer-camera', label: 'VR layer camera', screen: { width: 1354, height: 1440 }, crop: { x: 0, y: 0, width: 1354, height: 1440 }, out: { width: 1354, height: 1440 }, stereo: 'mono' });
    expect(cameraCapture(720, 1440, 'sbs')).toEqual(CAMERA);
    expect(eyesKey([GEO, GEO])).toBe(eyesKey([{ ...GEO, fov: [-0.90001, 0.8, 0.9, -0.95] }, GEO]));
    expect(eyesKey([GEO, GEO])).not.toBe(eyesKey([{ ...GEO, rect: [449, 0, 900, 1800] }, GEO]));
    expect(eyesKey([GEO])).toBeNull();
    expect(eyesKey(null)).toBeNull();
    expect(eyesKey([{ ...GEO, fov: [1, 2, 3] }, GEO])).toBeNull();
    expect(stereoSignal('sbs', null)).toEqual({ kind: 'stereo', stereo: 'sbs' });
    expect(Object.keys(stereoSignal('mono', [GEO, GEO]))).toEqual(['kind', 'stereo']);
    expect(stereoSignal('sbs', [GEO, GEO])).toEqual({ kind: 'stereo', stereo: 'sbs', eyes: [GEO, GEO] });
    expect(PANEL_CHANNELS.cameraFrame).toBe('castcade-panel:camera-frame');
    expect(PANEL_CHANNELS.cameraAck).toBe('castcade-panel:camera-ack');
  });

  async function cameraPage(capture = CAMERA) {
    const bitmaps: Array<{ width: number; height: number; closed: boolean }> = [];
    const fail = { next: false };
    vi.stubGlobal('createImageBitmap', async (b: Blob) => {
      if (fail.next || !(b instanceof Blob) || b.type !== 'image/jpeg') throw new Error('The source image could not be decoded.');
      const bm = { width: 720, height: 1440, closed: false, close: () => (bm.closed = true) };
      bitmaps.push(bm);
      return bm;
    });
    const p = loadPage({ mic: true, capture: true });
    p.emit(PANEL_CHANNELS.attach, { localId: 'owner', peers: ['krobs'], ice: [], capture, micDeviceId: null, muted: false, sending: true });
    await settle();
    const jpg = new Uint8Array([0xff, 0xd8, 0xff]);
    const frame = (n: number, o: Partial<{ width: number; height: number; left: Uint8Array; eyes: unknown[] }> = {}) => ({ n, width: 720, height: 1440, left: jpg, right: jpg, eyes: [GEO, GEO], ...o });
    const acks = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.cameraAck).length;
    const stereoSignals = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.send && (s.arg as { signal: { kind: string } }).signal.kind === 'stereo').map((s) => (s.arg as { signal: unknown }).signal);
    const sender = () => FakePeerConnection.all[0]!.senders.find((s) => s.track?.kind === 'video');
    return { p, bitmaps, fail, frame, acks, stereoSignals, sender };
  }

  it('no screen is opened; each frame draws both eyes side by side onto the same canvas (2w x h), is acked, and the declaration carries the eyes once', async () => {
    try {
      const { p, bitmaps, frame, acks, stereoSignals, sender } = await cameraPage();
      expect(p.captures).toHaveLength(0); // getUserMedia never asked for a screen
      expect(p.canvas.width).toBe(1440);
      expect(p.canvas.height).toBe(1440);
      expect(p.canvas.streams).toHaveLength(1);
      const track = sender()!.track;
      expect(track.enabled).toBe(true);
      expect(stereoSignals()).toEqual([{ kind: 'stereo', stereo: 'sbs' }]); // before a frame: side by side, no eyes yet
      p.canvas.ctx.calls.length = 0;
      p.emit(PANEL_CHANNELS.cameraFrame, frame(1));
      await settle();
      expect(p.canvas.ctx.calls).toEqual([
        ['drawImage', 0, 0, 720, 1440, 0, 0, 720, 1440],
        ['drawImage', 0, 0, 720, 1440, 720, 0, 720, 1440],
      ]);
      expect(bitmaps.every((b) => b.closed)).toBe(true);
      expect(acks()).toBe(1);
      expect(stereoSignals().at(-1)).toEqual({ kind: 'stereo', stereo: 'sbs', eyes: [GEO, GEO] });
      p.emit(PANEL_CHANNELS.cameraFrame, frame(2));
      await settle();
      expect(stereoSignals()).toHaveLength(2); // same eyes: not said again
      // A smaller box: the canvas follows (same track: nothing renegotiates), and so does the bitrate cap.
      p.emit(PANEL_CHANNELS.cameraFrame, frame(3, { width: 540, height: 1080 }));
      await settle();
      expect([p.canvas.width, p.canvas.height]).toEqual([1080, 1080]);
      expect(p.canvas.streams).toHaveLength(1);
      expect(sender()!.track).toBe(track);
      expect(p.canvas.ctx.calls.at(-1)).toEqual(['drawImage', 0, 0, 720, 1440, 540, 0, 540, 1080]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('D8.1: a mono camera capture (one eye): the canvas is w x h, the declaration mono without eyes, each one-eye frame drawn alone at (0, 0); a two-eye frame after it goes back to side by side', async () => {
    try {
      const { p, bitmaps, frame, acks, stereoSignals, sender } = await cameraPage(cameraCapture(1354, 1440, 'mono'));
      expect(p.captures).toHaveLength(0);
      expect([p.canvas.width, p.canvas.height]).toEqual([1354, 1440]);
      const track = sender()!.track;
      expect(stereoSignals()).toEqual([{ kind: 'stereo', stereo: 'mono' }]);
      p.canvas.ctx.calls.length = 0;
      p.emit(PANEL_CHANNELS.cameraFrame, frame(1, { width: 1354, height: 1440, right: null, eyes: [GEO] } as never));
      await settle();
      expect(p.canvas.ctx.calls).toEqual([['drawImage', 0, 0, 720, 1440, 0, 0, 1354, 1440]]);
      expect(bitmaps).toHaveLength(1); // one decode per frame
      expect(bitmaps.every((b) => b.closed)).toBe(true);
      expect(acks()).toBe(1);
      expect(stereoSignals()).toEqual([{ kind: 'stereo', stereo: 'mono' }]); // nothing new to say: mono carries no eyes
      // The right eye alone is a mono frame too, drawn the same.
      p.emit(PANEL_CHANNELS.cameraFrame, frame(2, { width: 1354, height: 1440, left: null, eyes: [GEO] } as never));
      await settle();
      expect(p.canvas.ctx.calls.at(-1)).toEqual(['drawImage', 0, 0, 720, 1440, 0, 0, 1354, 1440]);
      expect(acks()).toBe(2);
      // The bitrate cap follows the mono shape (the pixel rule: 1354x1440 is 7.6 Mbps).
      expect(sender()!.params.encodings[0]!.maxBitrate).toBe(7_600_000);
      // Both eyes again (the Match tab's Camera eyes): the canvas doubles, the declaration carries the eyes; same track.
      p.emit(PANEL_CHANNELS.cameraFrame, frame(3, { width: 720, height: 1440 }));
      await settle();
      expect([p.canvas.width, p.canvas.height]).toEqual([1440, 1440]);
      expect(sender()!.track).toBe(track);
      expect(stereoSignals().at(-1)).toEqual({ kind: 'stereo', stereo: 'sbs', eyes: [GEO, GEO] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('unreadable frames are skipped, acked and counted; the counters and the stall watch run on drawn camera frames', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { p, fail, frame, acks } = await cameraPage();
      const watch = p.intervals.find((i) => i.ms === 400)!;
      const stats = p.intervals.find((i) => i.ms === STATS_MS)!;
      const status = () => p.sent.filter((s) => s.channel === PANEL_CHANNELS.status).pop()?.arg as { captureStalled: boolean; capturing: boolean; stats: { capture: number | null; camera?: { unreadable: number } } | null };
      for (let n = 1; n <= 3; n++) {
        p.emit(PANEL_CHANNELS.cameraFrame, frame(n));
        await settle();
        watch.cb();
      }
      fail.next = true;
      p.emit(PANEL_CHANNELS.cameraFrame, frame(4));
      await settle();
      p.emit(PANEL_CHANNELS.cameraFrame, frame(5, { left: new Uint8Array(0) }));
      await settle();
      expect(acks()).toBe(5);
      stats.cb();
      expect(status().capturing).toBe(true);
      expect(status().stats).toMatchObject({ capture: 3, camera: { unreadable: 2 } });
      // No drawn frame for 3 s while sending: stalled (main falls back to the screen capture).
      vi.advanceTimersByTime(3_100);
      watch.cb();
      expect(status().captureStalled).toBe(true);
      fail.next = false;
      p.emit(PANEL_CHANNELS.cameraFrame, frame(6));
      await settle();
      watch.cb();
      expect(status().captureStalled).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('back to a screen capture: the screen is opened, the canvas track kept, the declaration re-sent without the eyes; frames then are ignored but acked', async () => {
    try {
      const { p, frame, acks, stereoSignals, sender } = await cameraPage();
      p.emit(PANEL_CHANNELS.cameraFrame, frame(1));
      await settle();
      const track = sender()!.track;
      p.emit(PANEL_CHANNELS.capture, { ...CAP, stereo: 'sbs' });
      await settle();
      expect(p.captures).toHaveLength(1);
      expect(p.canvas.streams).toHaveLength(1);
      expect(sender()!.track).toBe(track);
      expect([p.canvas.width, p.canvas.height]).toEqual([1280, 720]);
      expect(stereoSignals().at(-1)).toEqual({ kind: 'stereo', stereo: 'sbs' });
      p.canvas.ctx.calls.length = 0;
      p.emit(PANEL_CHANNELS.cameraFrame, frame(2));
      await settle();
      expect(p.canvas.ctx.calls.filter((c) => c[0] === 'drawImage' && c[5] === 720)).toEqual([]);
      expect(acks()).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
