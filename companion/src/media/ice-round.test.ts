/**
 * I11.12 (2026-11-20): one log line per ICE round (`iceRoundLine`, `iceRoundOver`, panel-page.ts), the same for voice
 * (the panel page) and the 3D watch tunnel (its page): what each kind of candidate pair sent and received, and when
 * the round got its remote description, went to `checking` and connected. On `getStats()` shapes recorded from the
 * real 3D watch page in Electron (`ice-round.test-data.json`), and on the shape the two-router nights point at: every
 * pair in progress, checks sent, none answered.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ICE_PEER_ROUNDS, ICE_ROUND_LOOK, ICE_WATCH, iceCandidateIds, iceRoundCandidate, iceRoundLine, iceRoundLook, iceRoundOver, iceRoundSeen, iceRoundStart, iceWatchStep, pageLogLine, type IceRound, type IceRoundPeer } from './panel-page.js';
import { WATCH_CHANNELS, firstRestartMs, pathOf, watchPageHtml, type WatchPagePeer } from '../watch/watch-page.js';

type Entry = Record<string, unknown>;
const recorded = JSON.parse(readFileSync(new URL('./ice-round.test-data.json', import.meta.url), 'utf8')) as { first: Entry[]; second: Entry[] };
const pairsOf = (entries: Entry[]): Entry[] => entries.filter((e) => e.type === 'candidate-pair');
/** Nothing that is an address, a port after one, a ufrag or SDP may be in a line: words, counts and times only. */
const SAFE_LINE = /^[A-Za-z0-9 ,;:.()>-]+$/;

/** A round that began at `at`, saw its remote description `remoteMs` later and `checking` at `checkingMs`. */
function round(n: number, at: number, remoteMs: number | null, checkingMs: number | null, known: IceRound['known'] = null): IceRound {
  return { ...iceRoundStart(n, at, null, known), remoteMs, checkingMs };
}

/** What the logs of 2026-11-18 describe: pairs formed both ways, checks going out, nothing coming back. */
function stalled(): Entry[] {
  const out: Entry[] = [{ id: 'T01', type: 'transport' }];
  const local = [
    ['L1', 'host'],
    ['L2', 'srflx'],
  ] as const;
  const remote = [
    ['R1', 'host'],
    ['R2', 'srflx'],
  ] as const;
  for (const [id, candidateType] of local) out.push({ id, type: 'local-candidate', candidateType, protocol: 'udp', address: '192.0.2.10', port: 50_000, usernameFragment: 'abcd' });
  for (const [id, candidateType] of remote) out.push({ id, type: 'remote-candidate', candidateType, protocol: 'udp', address: '198.51.100.7', port: 61_000, usernameFragment: 'wxyz' });
  for (const [l] of local) for (const [r] of remote) out.push({ id: `CP${l}_${r}`, type: 'candidate-pair', localCandidateId: l, remoteCandidateId: r, state: 'in-progress', nominated: false, requestsSent: 21, responsesReceived: 0, requestsReceived: 0, responsesSent: 0 });
  return out;
}

describe('the line of one ICE round (I11.12)', () => {
  it('the round the two-router nights describe: every pair in progress, checks sent, none answered, none received', () => {
    const line = iceRoundLine(round(1, 1_000, 150, 160), 11_400, 'restart 1 of 3 decided here', false, 'checking', stalled(), null);
    expect(line).toBe(
      'ICE round 1: restart 1 of 3 decided here after 10.40 s (ice checking); remote description at 0.15 s, checking at 0.16 s, not connected; srflx candidate sent not seen, received not seen; first check on a srflx pair sent not seen, received not seen; 4 pairs: ' +
        'host>host udp in-progress sent 21 answered 0, received 0 answered 0; host>srflx udp in-progress sent 21 answered 0, received 0 answered 0; ' +
        'srflx>host udp in-progress sent 21 answered 0, received 0 answered 0; srflx>srflx udp in-progress sent 21 answered 0, received 0 answered 0',
    );
    expect(line).toMatch(SAFE_LINE);
  });

  it('the other picture a stalled round can show: checks arrive and are answered here, and nothing this side sends is answered', () => {
    const entries = stalled().map((e) => (e.id === 'CPL1_R2' ? { ...e, requestsReceived: 19, responsesSent: 19 } : e));
    const line = iceRoundLine(round(1, 0, 150, 160), 10_000, 'restart 1 of 3 by the peer', false, 'checking', entries, null);
    expect(line).toContain('host>srflx udp in-progress sent 21 answered 0, received 19 answered 19');
    // Pairs that read the same are counted, not repeated.
    const same = stalled().map((e) => (e.type === 'local-candidate' ? { ...e, candidateType: 'host' } : e.type === 'remote-candidate' ? { ...e, candidateType: 'srflx' } : e));
    expect(iceRoundLine(round(1, 0, 150, 160), 10_000, 'restart 1 of 3 decided here', false, 'checking', same, null)).toContain('; 4 pairs: 4x host>srflx udp in-progress sent 21 answered 0, received 0 answered 0');
  });

  it('a recorded report after a connect: every pair is counted, the selected one is named, and nothing but words, counts and times is in the line', () => {
    const line = iceRoundLine(round(1, 0, 12, 14), 20, 'connected', true, 'connected', recorded.first, null);
    expect(line.startsWith(`ICE round 1: connected after 0.02 s (ice connected); remote description at 0.01 s, checking at 0.01 s, connected at 0.02 s; srflx candidate sent not seen, received not seen; first check on a srflx pair sent not seen, received not seen; ${pairsOf(recorded.first).length} pairs: `)).toBe(true);
    // Exactly one kind of pair is the selected one, and it worked both ways.
    const kinds = line.split(' pairs: ')[1]!.split('; ');
    const selected = kinds.filter((k) => k.includes(' selected '));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatch(/^host>host udp succeeded selected sent [1-9]\d* answered [1-9]\d*, received \d+ answered \d+$/);
    // It is the first one named: what won comes before what only waited.
    expect(kinds[0]).toBe(selected[0]);
    // The counts of all kinds add up to the pairs of the report.
    const total = kinds.reduce((n, k) => n + Number(/^(\d+)x /.exec(k)?.[1] ?? 1), 0);
    expect(total).toBe(pairsOf(recorded.first).length);
    expect(line).toMatch(SAFE_LINE);
  });

  it('a recorded report after an ICE restart: the candidates of the round before are marked, and the pair that won is the first one named', () => {
    const known = iceCandidateIds(recorded.first);
    expect(known.local.length).toBeGreaterThan(0);
    expect(known.remote.length).toBeGreaterThan(0);
    const second = pairsOf(recorded.second);
    const isOld = (p: Entry): [boolean, boolean] => [known.local.includes(p.localCandidateId as string), known.remote.includes(p.remoteCandidateId as string)];
    // What Chromium did at that restart, as recorded on the side that restarted: its new ports were paired with the
    // peer's old candidates as well as its new ones (and its old ports with nothing new), and the pair that was
    // selected afterwards is one of those: a new local candidate, an old remote one.
    const mix = (lo: boolean, ro: boolean): number => second.filter((p) => isOld(p)[0] === lo && isOld(p)[1] === ro).length;
    expect([mix(true, true), mix(false, true), mix(false, false), mix(true, false)]).toEqual([21, 20, 21, 0]);
    const line = iceRoundLine(round(2, 0, 150, 160, known), 500, 'connected', true, 'connected', recorded.second, null);
    expect(line).toContain(`; ${second.length} pairs: `);
    const kinds = line.split(' pairs: ')[1]!.split('; ');
    expect(kinds[0]).toMatch(/^host>host\(old\) udp succeeded selected sent [1-9]\d* answered [1-9]\d*, received \d+ answered \d+$/);
    // More kinds than a line holds: the twelve that say most are named (the pairs that worked before any that only waited).
    expect(kinds).toHaveLength(13);
    expect(kinds.at(-1)).toMatch(/^and \d+ more kinds$/);
    expect(kinds.slice(0, 12).filter((k) => / waiting sent 0 answered 0, received 0 answered 0$/.test(k))).toEqual([]);
    expect(line.length).toBeLessThan(1200);
    expect(line).toMatch(SAFE_LINE);
    // A round that did not connect is read a moment after the next one began: with `only`, the pairs of the look before.
    const only = iceRoundLine(round(1, 0, 150, 160), 10_000, 'restart 1 of 3 decided here', false, 'checking', recorded.second, known);
    expect(only).toContain(`; ${mix(true, true)} pairs: `);
    expect(only).not.toContain('(old)');
  });

  it('never an address, whatever a report holds: a type, a protocol or a state that is not a plain word reads as ?', () => {
    const entries: Entry[] = [
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
      { id: 'L', type: 'local-candidate', candidateType: '203.0.113.7', protocol: 'udp 203.0.113.7:50000', address: '203.0.113.7', ip: '203.0.113.7', port: 50_000, usernameFragment: 'SeCr', url: 'stun:203.0.113.9' },
      { id: 'R', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp', address: '198.51.100.7', port: 61_000 },
      { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'a=ice-ufrag:SeCr', requestsSent: '21; 203.0.113.7', responsesReceived: -4, requestsReceived: 2.6, responsesSent: Infinity },
    ];
    const line = iceRoundLine(round(1, 0, null, null), 1_000, 'gave up after 3 restart(s)', false, 'checking', entries, null);
    expect(line).toBe('ICE round 1: gave up after 3 restart(s) after 1.00 s (ice checking); remote description not seen, checking not seen, not connected; srflx candidate sent not seen, received not seen; first check on a srflx pair sent not seen, received not seen; 1 pair: ?>srflx ? ? selected sent 0 answered 0, received 3 answered 0');
    expect(line).not.toMatch(/203|198\.51|SeCr|ufrag|stun/);
  });

  it('no pairs at all, and more kinds than a line should hold', () => {
    expect(iceRoundLine(round(3, 0, null, null), 40_000, 'restart 3 of 3 decided here', false, 'new', [], null)).toBe('ICE round 3: restart 3 of 3 decided here after 40.00 s (ice new); remote description not seen, checking not seen, not connected; srflx candidate sent not seen, received not seen; first check on a srflx pair sent not seen, received not seen; 0 pairs');
    const many: Entry[] = [{ id: 'L', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }, { id: 'R', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }];
    for (let i = 0; i < 14; i++) many.push({ id: `P${i}`, type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'in-progress', requestsSent: i });
    const line = iceRoundLine(round(1, 0, 0, 0), 1_000, 'restart 1 of 3 decided here', false, 'checking', many, null);
    expect(line).toContain('; 14 pairs: ');
    expect(line.endsWith('; and 2 more kinds')).toBe(true);
    // The kind that sent nothing is the one left for last.
    expect(line).not.toContain('in-progress sent 0 answered 0');
    expect(line.length).toBeLessThan(1200);
  });
});

describe("a round's times (I11.12)", () => {
  it('round 1: the remote description, then the first checking, each counted from the peer connection opening', () => {
    const r = iceRoundStart(1, 1_000, null, null);
    iceRoundSeen(r, 1_010, 'new', null);
    expect(r).toMatchObject({ remoteMs: null, checkingMs: null });
    iceRoundSeen(r, 1_150, 'new', 'uf1');
    iceRoundSeen(r, 1_163, 'checking', 'uf1');
    iceRoundSeen(r, 5_000, 'checking', 'uf1');
    expect(r).toMatchObject({ remoteMs: 150, checkingMs: 163 });
  });

  it('a restart round: its own remote description is the one whose ICE credentials are new; checking counts from there', () => {
    const r = iceRoundStart(2, 20_000, 'uf1', { local: ['L1'], remote: ['R1'] });
    // Still the old description, still checking: neither is this round's.
    iceRoundSeen(r, 20_050, 'checking', 'uf1');
    expect(r).toMatchObject({ remoteMs: null, checkingMs: null });
    iceRoundSeen(r, 20_148, 'checking', 'uf2');
    expect(r).toMatchObject({ remoteMs: 148, checkingMs: 148 });
  });

  it('after a connect the next round begins when the connection is in trouble again, not at the connect', () => {
    const r = iceRoundStart(2, 1_000, 'uf1', null);
    r.idle = true;
    iceRoundSeen(r, 60_000, 'connected', 'uf1');
    iceRoundSeen(r, 90_000, 'completed', 'uf1');
    expect(r).toMatchObject({ at: 1_000, idle: true });
    iceRoundSeen(r, 600_000, 'disconnected', 'uf1');
    expect(r).toMatchObject({ at: 600_000, idle: false, remoteMs: null, checkingMs: null, ufrag: 'uf1' });
  });
});

describe('the end of a round, as both pages call it (I11.12)', () => {
  const peer = (o: { stats?: Entry[] | 'throws' | 'rejects' | 'absent'; ice?: string; sdp?: string | null; ids?: IceRoundPeer['ids'] } = {}): IceRoundPeer => ({
    pc: {
      iceConnectionState: o.ice ?? 'checking',
      remoteDescription: o.sdp === null ? null : { sdp: o.sdp ?? 'v=0\r\na=ice-ufrag:uf1\r\n' },
      ...(o.stats === 'absent'
        ? {}
        : {
            getStats: () => {
              if (o.stats === 'throws') throw new Error('closed');
              if (o.stats === 'rejects') return Promise.reject(new Error('closed'));
              return Promise.resolve(new Map((o.stats ?? stalled()).map((e) => [e.id as string, e])));
            },
          }),
    },
    round: { ...iceRoundStart(1, 0, null, null), remoteMs: 150, checkingMs: 160 },
    ids: o.ids ?? null,
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('a restart decided here: one line from the stats, and round 2 begins with what was known of the candidates', async () => {
    const ids = iceCandidateIds(stalled());
    const r = peer({ ids });
    const lines: string[] = [];
    iceRoundOver(r, 'restart 1 of 3 decided here', false, false, 10_400, (l) => lines.push(l));
    // The next round began at once: the restart that follows belongs to it.
    expect(r.round).toEqual({ n: 2, at: 10_400, ufrag: 'uf1', remoteMs: null, checkingMs: null, known: ids, idle: false, srflxOutMs: null, srflxInMs: null, checkOutMs: null, checkInMs: null });
    expect(lines).toEqual([]);
    await flush();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ICE round 1: restart 1 of 3 decided here after 10\.40 s \(ice checking\); remote description at 0\.15 s, checking at 0\.16 s, not connected; srflx candidate sent not seen, received not seen; first check on a srflx pair sent not seen, received not seen; 4 pairs: /);
  });

  it("a restart the peer made: this side has already answered, so the new round's remote description is there from its start", async () => {
    const r = peer({ sdp: 'v=0\r\na=ice-ufrag:uf2\r\n' });
    const lines: string[] = [];
    iceRoundOver(r, 'restart 1 of 3 by the peer', false, true, 15_000, (l) => lines.push(l));
    expect(r.round).toMatchObject({ n: 2, at: 15_000, ufrag: 'uf2', remoteMs: 0, idle: false });
    await flush();
    expect(lines[0]).toContain('restart 1 of 3 by the peer after 15.00 s');
  });

  it('a connect: the line says when, with every pair of the report; the next round waits for trouble', async () => {
    const r = peer({ ice: 'connected', stats: recorded.first, ids: { local: [], remote: [] } });
    const lines: string[] = [];
    iceRoundOver(r, 'connected', true, false, 420, (l) => lines.push(l));
    expect(r.round).toMatchObject({ n: 2, idle: true });
    await flush();
    expect(lines[0]).toContain(`connected at 0.42 s; srflx candidate sent not seen, received not seen; first check on a srflx pair sent not seen, received not seen; ${pairsOf(recorded.first).length} pairs: `);
  });

  it('no stats (none in this browser, a closed connection): the line is written all the same, and says so', async () => {
    for (const stats of ['absent', 'throws', 'rejects'] as const) {
      const lines: string[] = [];
      iceRoundOver(peer({ stats }), 'gave up after 3 restart(s)', false, false, 110_000, (l) => lines.push(l));
      await flush();
      expect(lines, stats).toEqual(['ICE round 1: gave up after 3 restart(s) after 110.00 s (ice checking); remote description at 0.15 s, checking at 0.16 s, not connected; srflx candidate sent not seen, received not seen; first check on a srflx pair sent not seen, received not seen; 0 pairs (no stats)']);
    }
  });
});

/**
 * The 3D watch page's own script, run as the page runs it (the way panel-page.test.ts runs the panel page): the real
 * `PeerNegotiator` / `SignalingMesh`, the real watchdog and the real round bookkeeping, on a fake `RTCPeerConnection`.
 */
const TIMES_NOT_SEEN = '; srflx candidate sent not seen, received not seen; first check on a srflx pair sent not seen, received not seen';

function loadWatchPage(cfg: { firstRestartMs?: number | null } = {}, localId = 'owner') {
  const script = /<script>([\s\S]*)<\/script>/.exec(watchPageHtml())?.[1] ?? '';
  const handlers = new Map<string, (e: unknown, arg: unknown) => void>();
  const sent: Array<{ channel: string; arg: unknown }> = [];
  const electron = { ipcRenderer: { on: (ch: string, cb: (e: unknown, arg: unknown) => void) => handlers.set(ch, cb), send: (channel: string, arg?: unknown) => sent.push({ channel, arg }) } };
  const intervals: Array<{ cb: () => void; ms: number }> = [];
  class FakeChannel {
    readyState = 'connecting';
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    close(): void {}
    send(): void {}
  }
  class FakePc {
    static all: FakePc[] = [];
    readonly channel = new FakeChannel();
    iceConnectionState = 'new';
    signalingState = 'stable';
    localDescription: { type: string; sdp: string } | null = null;
    remoteDescription: { type: string; sdp: string } | null = null;
    onnegotiationneeded: (() => void) | null = null;
    onicecandidate: unknown = null;
    restarts = 0;
    stats: Entry[] | null = null;
    private readonly listeners = new Map<string, Array<() => void>>();
    constructor() {
      FakePc.all.push(this);
    }
    createDataChannel(): FakeChannel {
      return this.channel;
    }
    addEventListener(name: string, cb: () => void): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
    }
    fire(name: string): void {
      for (const cb of this.listeners.get(name) ?? []) cb();
    }
    restartIce(): void {
      this.restarts += 1;
    }
    async getStats(): Promise<Map<string, Entry>> {
      if (!this.stats) throw new Error('no stats');
      return new Map(this.stats.map((e) => [e.id as string, e]));
    }
    async setLocalDescription(): Promise<void> {}
    async setRemoteDescription(): Promise<void> {}
    async addIceCandidate(): Promise<void> {}
    close(): void {}
  }
  new Function('require', 'RTCPeerConnection', 'setInterval', 'clearInterval', script)(() => electron, FakePc, (cb: () => void, ms: number) => intervals.push({ cb, ms }), () => undefined);
  const emit = (ch: string, arg?: unknown): void => handlers.get(ch)?.({}, arg);
  // 'owner' > 'krobs': this page is the impolite side and leads restarts, as Krobs' PC did on 2026-11-18.
  const t0 = Date.now();
  emit(WATCH_CHANNELS.config, { localId, ice: [], reset: false, peers: [], ...cfg });
  emit(WATCH_CHANNELS.addPeer, 'krobs');
  const pc = FakePc.all[0]!;
  const tick = intervals.find((i) => i.ms === ICE_WATCH.tickMs)!;
  /** I11.12 (2026-11-24): the 50 ms look at a round's first seconds, and the page's own look every 2 s. */
  const look = intervals.find((i) => i.ms === ICE_ROUND_LOOK.everyMs)!;
  const probe = intervals.find((i) => i.ms === 2000)!;
  /** The browser gathered a local candidate: the negotiator trickles it. */
  const gather = (candidate: string): void => (pc.onicecandidate as ((ev: { candidate: unknown }) => void) | null)?.({ candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 } });
  const logs = (): string[] => sent.filter((s) => s.channel === WATCH_CHANNELS.log).map((s) => s.arg as string);
  /** The answer is in and ICE is checking: the stuck spell of the watchdog begins. */
  const checking = (): void => {
    pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:uf1\r\n' };
    pc.signalingState = 'stable';
    pc.fire('signalingstatechange');
    pc.iceConnectionState = 'checking';
    pc.fire('iceconnectionstatechange');
  };
  /** What the page last told main of krobs (`WatchPagePeer`): `pathOf` of it is what the match and the card go by. */
  const told = (): WatchPagePeer | undefined => (sent.filter((s) => s.channel === WATCH_CHANNELS.status).pop()?.arg as { peers: Record<string, WatchPagePeer> } | undefined)?.peers['krobs'];
  return { pc, tick, look, probe, gather, emit, logs, checking, told, t0 };
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe('the 3D watch page runs it (I11.12)', () => {
  it('a round that stalls and is restarted, then connects: one line each, from the stats of that moment, beside the lines the page always wrote', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = loadWatchPage();
      p.checking();
      p.pc.stats = stalled();
      vi.advanceTimersByTime(2_900);
      p.tick.cb();
      expect(p.pc.restarts).toBe(0);
      vi.advanceTimersByTime(100);
      p.tick.cb();
      expect(p.pc.restarts).toBe(1);
      await settle();
      const round1 = p.logs().filter((l) => l.includes('ICE round'));
      expect(round1).toEqual([
        'peer krobs: ICE round 1: restart 1 of 6 decided here after 3.00 s (ice checking); remote description at 0.00 s, checking at 0.00 s, not connected' +
          TIMES_NOT_SEEN +
          '; 4 pairs: ' +
          'host>host udp in-progress sent 21 answered 0, received 0 answered 0; host>srflx udp in-progress sent 21 answered 0, received 0 answered 0; ' +
          'srflx>host udp in-progress sent 21 answered 0, received 0 answered 0; srflx>srflx udp in-progress sent 21 answered 0, received 0 answered 0; this side leads restarts 1, 3, 5',
      ]);
      expect(p.logs()).toContain('peer krobs: ICE restart 1 of 6 (checking for 3 s, our turn; no pair yet)');
      // The answer to the restart comes (new credentials), and half a second later the connection is up.
      vi.advanceTimersByTime(150);
      p.pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:uf2\r\n' };
      p.pc.fire('signalingstatechange');
      vi.advanceTimersByTime(350);
      p.pc.stats = stalled().map((e) => (e.id === 'CPL2_R2' ? { ...e, state: 'succeeded', nominated: true, requestsSent: 3, responsesReceived: 3, requestsReceived: 2, responsesSent: 2 } : e));
      p.pc.iceConnectionState = 'connected';
      p.pc.fire('iceconnectionstatechange');
      await settle();
      const round2 = p.logs().filter((l) => l.includes('ICE round 2'));
      expect(round2).toHaveLength(1);
      expect(round2[0]!.startsWith('peer krobs: ICE round 2: connected after 0.50 s (ice connected); remote description at 0.15 s, checking at 0.15 s, connected at 0.50 s' + TIMES_NOT_SEEN + '; 4 pairs: srflx>srflx udp succeeded nominated sent 3 answered 3, received 2 answered 2; ')).toBe(true);
      expect(round2[0]!.endsWith('; this side leads restarts 1, 3, 5')).toBe(true);
      expect(p.logs()).toContain('peer krobs: ICE connected after 1 restart(s)');
      // Connected: nothing more is written while it stays so.
      const n = p.logs().length;
      p.pc.iceConnectionState = 'completed';
      p.pc.fire('iceconnectionstatechange');
      p.tick.cb();
      await settle();
      expect(p.logs().length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });

  it("I11.12 (2026-11-24): restart 2 is the peer's turn: this page (the usual lead) waits 28 s for it, and the round, whose pairs the browser deleted after 16 s, is written with the counters of the last look that still saw them", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = loadWatchPage();
      p.checking();
      p.pc.stats = stalled();
      vi.advanceTimersByTime(3_000);
      p.tick.cb();
      expect(p.pc.restarts).toBe(1);
      await settle();
      // The answer to the restart; checks go out again and nothing comes back.
      vi.advanceTimersByTime(150);
      p.pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:uf2\r\n' };
      p.pc.fire('signalingstatechange');
      // The peer does not take its turn. 6 s after restart 1 (the lag alone) this page still waits.
      vi.advanceTimersByTime(5_850);
      p.tick.cb();
      expect(p.pc.restarts).toBe(1);
      // The page's own look every 2 s: 14 s into the round the pairs are still there.
      vi.advanceTimersByTime(8_000);
      p.probe.cb();
      await settle();
      // 16 s in the browser has deleted every pair (2026-11-24: 16.05 to 16.19 s after each restart): the next look finds none.
      vi.advanceTimersByTime(4_000);
      p.pc.stats = stalled().filter((e) => e.type !== 'candidate-pair' && e.type !== 'remote-candidate');
      p.pc.iceConnectionState = 'disconnected';
      p.pc.fire('iceconnectionstatechange');
      p.probe.cb();
      await settle();
      vi.advanceTimersByTime(9_000);
      p.tick.cb();
      expect(p.pc.restarts).toBe(1);
      // 28 s after restart 1 (a peer on 0.2.50 would have made its own 25 s after it) this page restarts in its place.
      vi.advanceTimersByTime(1_000);
      p.tick.cb();
      expect(p.pc.restarts).toBe(2);
      await settle();
      expect(p.logs()).toContain('peer krobs: ICE restart 2 of 6 (disconnected for 28 s, the peer did not take its turn; no pair yet (0 tried, 0 failed; local host+srflx, remote none))');
      const round2 = p.logs().filter((l) => l.includes('ICE round 2'));
      expect(round2).toEqual([
        'peer krobs: ICE round 2: restart 2 of 6 decided here after 28.00 s (ice disconnected); remote description at 0.15 s, checking at 0.15 s, not connected' +
          TIMES_NOT_SEEN +
          '; 4 pairs as of 14.00 s (none left at the end): ' +
          'host>host udp in-progress sent 21 answered 0, received 0 answered 0; host>srflx udp in-progress sent 21 answered 0, received 0 answered 0; ' +
          'srflx>host udp in-progress sent 21 answered 0, received 0 answered 0; srflx>srflx udp in-progress sent 21 answered 0, received 0 answered 0; this side leads restarts 1, 3, 5',
      ]);
      expect(round2[0]!.replace(/^peer krobs: /, '')).toMatch(SAFE_LINE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('I11.12 (2026-11-24): the line says who sent first: the first server-reflexive candidate each way, and the first check on such a pair as the 50 ms look sees it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = loadWatchPage();
      // This page offers (it is the impolite side): its candidates go out, then the peer's come.
      p.pc.localDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:mine1\r\n' };
      vi.advanceTimersByTime(30);
      p.gather('candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host generation 0 ufrag mine1 network-id 1');
      vi.advanceTimersByTime(20);
      p.gather('candidate:2 1 udp 1686052607 203.0.113.7 50000 typ srflx raddr 192.0.2.10 rport 50000 generation 0 ufrag mine1 network-id 1');
      vi.advanceTimersByTime(150);
      p.emit(WATCH_CHANNELS.signalIn, { from: 'krobs', signal: { kind: 'ice', candidate: { candidate: 'candidate:3 1 udp 2122260223 198.51.100.7 61000 typ host generation 0 ufrag theirs1 network-id 1', sdpMid: '0', sdpMLineIndex: 0 } } });
      vi.advanceTimersByTime(40);
      p.emit(WATCH_CHANNELS.signalIn, { from: 'krobs', signal: { kind: 'ice', candidate: { candidate: 'candidate:4 1 udp 1686052607 198.51.100.7 61000 typ srflx raddr 10.0.0.2 rport 61000 generation 0 ufrag theirs1 network-id 1', sdpMid: '0', sdpMLineIndex: 0 } } });
      p.checking();
      // 50 ms on: only the host pair has sent a check; none has gone to a server-reflexive candidate yet.
      p.pc.stats = stalled().map((e) => (e.type === 'candidate-pair' && e.id !== 'CPL1_R1' ? { ...e, requestsSent: 0 } : e));
      vi.advanceTimersByTime(50);
      p.look.cb();
      await settle();
      // 100 ms on a check has gone out to the peer's server-reflexive candidate; none has come in, and none ever does.
      vi.advanceTimersByTime(50);
      p.pc.stats = stalled().map((e) => (e.type === 'candidate-pair' && e.id !== 'CPL1_R1' && e.id !== 'CPL1_R2' ? { ...e, requestsSent: 0 } : e));
      p.look.cb();
      await settle();
      vi.advanceTimersByTime(2_900);
      p.tick.cb();
      await settle();
      const round1 = p.logs().filter((l) => l.includes('ICE round 1'));
      expect(round1).toHaveLength(1);
      expect(round1[0]).toContain('not connected; srflx candidate sent at 0.05 s, received at 0.24 s; first check on a srflx pair sent at 0.34 s, received not seen; 4 pairs: ');
      expect(round1[0]!.replace(/^peer krobs: /, '')).toMatch(SAFE_LINE);
      expect(round1[0]).not.toMatch(/mine1|theirs1|203\.0|198\.51|50000|61000/);
      // The look stops 3 s into a round: the stats are not read twenty times a second for ever.
      const reads = vi.spyOn(p.pc, 'getStats');
      vi.advanceTimersByTime(3_100);
      p.look.cb();
      expect(reads).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the experiment: with `firstRestartMs` in its configuration the page restarts a stuck connection once early, then goes on as always; without it nothing happens before 3 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const early = loadWatchPage({ firstRestartMs: 2500 });
      const usual = loadWatchPage();
      for (const p of [early, usual]) p.checking();
      vi.advanceTimersByTime(2_400);
      for (const p of [early, usual]) p.tick.cb();
      expect([early.pc.restarts, usual.pc.restarts]).toEqual([0, 0]);
      vi.advanceTimersByTime(100);
      for (const p of [early, usual]) p.tick.cb();
      expect([early.pc.restarts, usual.pc.restarts]).toEqual([1, 0]);
      // Seven restarts in all there, and the usual six here: the lines say which.
      expect(early.logs()).toContain('peer krobs: ICE restart 1 of 7 (checking for 3 s, our turn; no pair yet)');
      vi.advanceTimersByTime(500);
      for (const p of [early, usual]) p.tick.cb();
      expect([early.pc.restarts, usual.pc.restarts]).toEqual([1, 1]);
      expect(usual.logs()).toContain('peer krobs: ICE restart 1 of 6 (checking for 3 s, our turn; no pair yet)');
      // The early one is restart 1, so the next is the peer's turn on both pages: each waits 28 s after its own first.
      vi.advanceTimersByTime(27_400);
      for (const p of [early, usual]) p.tick.cb();
      expect([early.pc.restarts, usual.pc.restarts]).toEqual([1, 1]);
      vi.advanceTimersByTime(100);
      for (const p of [early, usual]) p.tick.cb();
      expect([early.pc.restarts, usual.pc.restarts]).toEqual([2, 1]);
      vi.advanceTimersByTime(500);
      for (const p of [early, usual]) p.tick.cb();
      expect([early.pc.restarts, usual.pc.restarts]).toEqual([2, 2]);
      await settle();
      const rounds = early.logs().filter((l) => l.includes('ICE round'));
      expect(rounds).toHaveLength(2);
      expect(rounds[0]).toContain('peer krobs: ICE round 1: restart 1 of 7 decided here after 2.50 s (ice checking)');
      expect(rounds[1]).toContain('peer krobs: ICE round 2: restart 2 of 7 decided here after 28.00 s (ice checking)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the experiment on the page that is not the usual lead: its early restart comes `lagMs` after that many ms (not the 14 s it otherwise gives a lead on 0.2.50), and the next one is its own turn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 'alice' < 'krobs': this page is the polite side, the one that does not lead.
      const early = loadWatchPage({ firstRestartMs: 1000 }, 'alice');
      const usual = loadWatchPage({}, 'alice');
      for (const p of [early, usual]) p.checking();
      vi.advanceTimersByTime(3_900);
      for (const p of [early, usual]) p.tick.cb();
      expect([early.pc.restarts, usual.pc.restarts]).toEqual([0, 0]);
      vi.advanceTimersByTime(100);
      for (const p of [early, usual]) p.tick.cb();
      expect([early.pc.restarts, usual.pc.restarts]).toEqual([1, 0]);
      expect(early.logs()).toContain('peer krobs: ICE restart 1 of 7 (checking for 4 s, the peer did not take its turn; no pair yet)');
      // Restart 2 is this side's own turn: 3 s after the first.
      vi.advanceTimersByTime(3_000);
      for (const p of [early, usual]) p.tick.cb();
      expect([early.pc.restarts, usual.pc.restarts]).toEqual([2, 0]);
      expect(early.logs()).toContain('peer krobs: ICE restart 2 of 7 (checking for 3 s, our turn; no pair yet)');
      // Without the switch the page gives the lead 14 s for restart 1.
      vi.advanceTimersByTime(6_900);
      usual.tick.cb();
      expect(usual.pc.restarts).toBe(0);
      vi.advanceTimersByTime(100);
      usual.tick.cb();
      expect(usual.pc.restarts).toBe(1);
      expect(usual.logs()).toContain('peer krobs: ICE restart 1 of 6 (checking for 14 s, the peer did not take its turn; no pair yet)');
      await settle();
      expect(usual.logs().filter((l) => l.includes('ICE round'))[0]!.endsWith('; the peer leads restarts 1, 3, 5')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("I11.12 (2026-11-24): a restart of the peer's that crosses this page's own is the same restart: counted once, no round of its own; one that comes later is the next", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 'alice' < 'krobs': the polite side, whose offer is the one rolled back when two cross.
      const p = loadWatchPage({}, 'alice');
      p.checking();
      // The lead does not make restart 1: after 14 s this page does.
      vi.advanceTimersByTime(14_000);
      p.tick.cb();
      expect(p.pc.restarts).toBe(1);
      // The lead restarted at the same moment: its offer arrives 200 ms later and is answered here (ours rolled back).
      vi.advanceTimersByTime(200);
      p.pc.remoteDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:uf2\r\n' };
      p.pc.localDescription = { type: 'answer', sdp: '' };
      p.pc.fire('signalingstatechange');
      await settle();
      expect(p.logs()).toContain('peer krobs: ICE restart 1 of 6: the peer restarted at the same moment and its offer stands (one restart, counted once)');
      expect(p.logs().filter((l) => l.includes('by the peer'))).toEqual([]);
      expect(p.logs().filter((l) => l.includes('ICE round'))).toHaveLength(1);
      // So restart 2 is this side's turn, 3 s after the one that stands; had the crossed one been counted twice, this
      // side would be waiting for the lead now, and the lead for this side.
      vi.advanceTimersByTime(2_900);
      p.tick.cb();
      expect(p.pc.restarts).toBe(1);
      vi.advanceTimersByTime(100);
      p.tick.cb();
      expect(p.pc.restarts).toBe(2);
      expect(p.logs()).toContain('peer krobs: ICE restart 2 of 6 (checking for 3 s, our turn; no pair yet)');
      // 6 s later the lead makes restart 3: a restart of its own, counted, with its round.
      vi.advanceTimersByTime(6_000);
      p.pc.remoteDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:uf3\r\n' };
      p.pc.fire('signalingstatechange');
      await settle();
      expect(p.logs()).toContain('peer krobs: ICE restart 3 of 6 by the peer (checking)');
      expect(p.logs().filter((l) => l.includes('ICE round 3: restart 3 of 6 by the peer after 6.00 s'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("I11.12 (2026-11-24): a restart of the peer's answered while this page still read the connection as up is the first of the spell that begins here within 20 s; later than that it is another trouble", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      /** The page that is not the usual lead, connected; the lead restarts `before` ms before this page's ICE reads disconnected. */
      const run = async (before: number) => {
        const p = loadWatchPage({}, 'alice');
        p.checking();
        p.pc.localDescription = { type: 'answer', sdp: '' };
        p.pc.iceConnectionState = 'connected';
        p.pc.fire('iceconnectionstatechange');
        await settle();
        vi.advanceTimersByTime(60_000);
        p.pc.remoteDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:uf2\r\n' };
        p.pc.fire('signalingstatechange');
        vi.advanceTimersByTime(before);
        p.pc.iceConnectionState = 'disconnected';
        p.pc.fire('iceconnectionstatechange');
        return p;
      };
      const soon = await run(4_000);
      expect(soon.logs().filter((l) => l.includes('by the peer'))).toEqual([]);
      expect(soon.logs().at(-1)).toBe('peer krobs: the peer restarted ICE 4 s before this side saw the trouble: that was restart 1 of 6, the next is our turn');
      vi.advanceTimersByTime(3_000);
      soon.tick.cb();
      expect(soon.pc.restarts).toBe(1);
      expect(soon.logs().at(-1)).toBe('peer krobs: ICE restart 2 of 6 (disconnected for 3 s, our turn; no pair yet)');
      const late = await run(21_000);
      expect(late.logs().some((l) => l.includes('before this side saw the trouble'))).toBe(false);
      vi.advanceTimersByTime(13_000);
      late.tick.cb();
      expect(late.pc.restarts).toBe(0);
      vi.advanceTimersByTime(1_000);
      late.tick.cb();
      expect(late.pc.restarts).toBe(1);
      expect(late.logs().at(-1)).toBe('peer krobs: ICE restart 1 of 6 (disconnected for 14 s, the peer did not take its turn; no pair yet)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('I11.12 (2026-11-24): "no path" is what main is told, not the end: 30 s after the sixth restart the seventh goes out, and when the connection comes up after all the channel opens and the path is direct', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = loadWatchPage();
      p.checking();
      const seconds = (n: number): void => {
        for (let i = 0; i < n; i++) {
          vi.advanceTimersByTime(1_000);
          p.tick.cb();
        }
      };
      // The six scheduled restarts (this fake peer never takes its turn): 3 + 28 + 6 + 9 + 12 + 15 s.
      seconds(73);
      expect(p.pc.restarts).toBe(6);
      expect(p.told()?.gaveUp).toBe(false);
      // 12 s after the sixth, where 0.2.50 gave up: main is told there is no path, so the match's start does not wait
      // for this peer and its turns are the 2D video (stream3d.ts reads `no_path`), as before.
      seconds(12);
      expect(p.logs().at(-1)).toBe('peer krobs: no path after 6 ICE restart(s), checking for 85 s; no pair yet; still trying: an ICE restart every 30 s');
      expect(p.told()).toMatchObject({ gaveUp: true, channel: 'connecting' });
      expect(pathOf(p.told())).toBe('no_path');
      // And the restarts go on: the seventh 30 s after the sixth, the eighth (the peer's turn, not taken) 33 s on.
      seconds(17);
      expect(p.pc.restarts).toBe(6);
      seconds(1);
      expect(p.pc.restarts).toBe(7);
      expect(p.logs().at(-1)).toBe('peer krobs: ICE late restart 7 (checking for 30 s, our turn; no pair yet)');
      seconds(33);
      expect(p.pc.restarts).toBe(8);
      expect(pathOf(p.told())).toBe('no_path');
      expect(p.logs().filter((l) => l.includes('no path after'))).toHaveLength(1);
      // Three minutes in the path is back: ICE connects, the channel opens, and main hears a direct path, which the
      // match takes as it takes any connection that comes up late (the next turn can be 3D).
      seconds(60);
      p.pc.iceConnectionState = 'connected';
      p.pc.fire('iceconnectionstatechange');
      p.pc.channel.readyState = 'open';
      p.pc.channel.onopen?.();
      expect(p.told()).toMatchObject({ gaveUp: false, channel: 'open', restarts: 0 });
      expect(pathOf(p.told())).toBe('direct');
      expect(p.logs()).toContain('peer krobs: ICE connected after 9 restart(s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('I11.12 (2026-11-24): three hours beside a peer that never connects: one line per late restart and a round in full every five minutes, about 103 kB of companion.log', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = loadWatchPage();
      p.checking();
      const gone = stalled().filter((e) => e.type !== 'candidate-pair' && e.type !== 'remote-candidate');
      const flush = async (): Promise<void> => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      };
      let made = 0;
      let madeAt = 0;
      for (let s = 1; s <= 3 * 3600; s++) {
        vi.advanceTimersByTime(1_000);
        if (p.pc.restarts !== made) {
          made = p.pc.restarts;
          madeAt = s;
        }
        // A round nothing answers: pairs that send and hear nothing, deleted by the browser after 16 s.
        p.pc.stats = s - madeAt < 16 ? stalled() : gone;
        const ice = s - madeAt < 16 ? 'checking' : 'disconnected';
        if (ice !== p.pc.iceConnectionState) {
          p.pc.iceConnectionState = ice;
          p.pc.fire('iceconnectionstatechange');
        }
        p.tick.cb();
        if (s % 2 === 0) p.probe.cb();
        await flush();
      }
      const logs = p.logs();
      // As companion.log has it: the time and level, `stream3d: `, and a player id of 36 characters for krobs.
      const bytes = logs.reduce((n, l) => n + l.length + 31 + 10 + (l.split('krobs').length - 1) * 31 + 1, 0);
      const lateRestarts = p.pc.restarts - 6;
      expect(lateRestarts).toBeGreaterThan(330);
      expect(lateRestarts).toBeLessThan(345);
      const late = logs.filter((l) => l.includes('late restart'));
      expect(late.filter((l) => /: ICE late restart \d+ \(/.test(l))).toHaveLength(lateRestarts);
      expect(late.filter((l) => l.includes('ICE round'))).toHaveLength(Math.ceil(lateRestarts / 10));
      // Nothing else is written once the late restarts are on: no pair line every time the pairs come and go.
      const first = logs.findIndex((l) => l.includes('late restart 7 ('));
      expect(logs.slice(first).filter((l) => !l.includes('late restart'))).toEqual([]);
      // Measured here: 390 lines and 103 kB in three hours (340 late restarts, 34 rounds in full, four kinds of pair
      // each), of the megabyte companion.log holds before it rolls over; the voice page beside it writes 92 kB
      // (panel-page.test.ts). Computed from the lines of 2026-11-24, every late round in full with its pair and state
      // lines would be about 2.7 kB a round for voice and 1 kB for the tunnel: 1.3 MB in the same three hours.
      expect(logs.length).toBeLessThan(410);
      expect(bytes).toBeGreaterThan(90_000);
      expect(bytes).toBeLessThan(115_000);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('a peer that restarts ICE again and again ends a round here each time: four of those lines a minute, one that says the rest are not written, then silence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = loadWatchPage();
      p.checking();
      p.pc.localDescription = { type: 'answer', sdp: '' };
      // Every second a new offer of the peer with new ICE credentials, answered here.
      for (let i = 2; i <= 13; i++) {
        vi.advanceTimersByTime(1_000);
        p.pc.remoteDescription = { type: 'offer', sdp: `v=0\r\na=ice-ufrag:uf${i}\r\n` };
        p.pc.fire('signalingstatechange');
      }
      await settle();
      const rounds = p.logs().filter((l) => l.includes('ICE round'));
      expect(rounds.filter((l) => / by the peer after /.test(l))).toHaveLength(ICE_PEER_ROUNDS.max);
      expect(rounds.filter((l) => l.includes('the peer restarted ICE more than 4 times in 60 s'))).toHaveLength(1);
      expect(rounds).toHaveLength(ICE_PEER_ROUNDS.max + 1);
      // A minute on they are written again. I11.12 (2026-11-24): by now these are late restarts (the thirteenth and
      // on), whose rounds are written only when they have something to say: one that heard nothing is not...
      vi.advanceTimersByTime(ICE_PEER_ROUNDS.perMs);
      p.pc.stats = stalled();
      p.pc.remoteDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:later\r\n' };
      p.pc.fire('signalingstatechange');
      await settle();
      expect(p.logs().filter((l) => / by the peer after /.test(l))).toHaveLength(ICE_PEER_ROUNDS.max);
      expect(p.logs().at(-1)).toBe('peer krobs: ICE late restart 13 by the peer (checking)');
      // ...and one in which a check of the peer's arrived is.
      vi.advanceTimersByTime(30_000);
      p.pc.stats = stalled().map((e) => (e.id === 'CPL1_R2' ? { ...e, requestsReceived: 3, responsesSent: 3 } : e));
      p.pc.remoteDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:later2\r\n' };
      p.pc.fire('signalingstatechange');
      await settle();
      const heard = p.logs().filter((l) => / by the peer after /.test(l));
      expect(heard).toHaveLength(ICE_PEER_ROUNDS.max + 1);
      expect(heard.at(-1)).toContain('ICE round 14: late restart 14 by the peer after 30.00 s');
      expect(heard.at(-1)).toContain('host>srflx udp in-progress sent 21 answered 0, received 3 answered 3');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * I11.12 (2026-11-24): two 3D watch pages, each run as the page runs it, wired to each other through an in-memory
 * signalling: what one page sends on `signalOut` the other gets on `signalIn`, in order. Their `RTCPeerConnection` is a
 * fake that does what a browser does with ICE credentials: every description carries `a=ice-ufrag`; the offer made
 * after `restartIce()` carries a new one, and so does the answer to an offer whose own ufrag changed; `restartIce()`
 * asks for negotiation only once signalling is stable, and again by itself when a restart's offer was rolled back.
 * So a restart one page's watchdog decides really travels: the other page's real negotiator answers it, and its real
 * watchdog counts it by the changed ufrag. 'bob' > 'alice': bob is the impolite side and the usual lead.
 */
function loadWatchPair() {
  const script = /<script>([\s\S]*)<\/script>/.exec(watchPageHtml())?.[1] ?? '';
  const ufragOf = (sdp: string | undefined): string | null => /a=ice-ufrag:(\S+)/.exec(sdp ?? '')?.[1] ?? null;
  type Desc = { type: string; sdp: string };
  class BrowserLikePc {
    iceConnectionState = 'new';
    signalingState = 'stable';
    localDescription: Desc | null = null;
    remoteDescription: Desc | null = null;
    onnegotiationneeded: (() => void) | null = null;
    onicecandidate: unknown = null;
    restartCalls = 0;
    offersMade = 0;
    private gen = 0;
    private ufrag: string;
    private offerUfrag: string | null = null;
    private remoteUfrag: string | null = null;
    private restartWanted = false;
    private stableLocal: Desc | null = null;
    private readonly listeners = new Map<string, Array<() => void>>();
    constructor(private readonly owner: string) {
      this.ufrag = `${owner}0`;
    }
    createDataChannel(): { readyState: string; bufferedAmount: number; close(): void; send(): void } {
      return { readyState: 'connecting', bufferedAmount: 0, close: () => undefined, send: () => undefined };
    }
    addEventListener(name: string, cb: () => void): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
    }
    fire(name: string): void {
      for (const cb of this.listeners.get(name) ?? []) cb();
    }
    localUfrag(): string {
      return this.ufrag;
    }
    private to(state: string): void {
      this.signalingState = state;
      this.fire('signalingstatechange');
      if (state === 'stable') this.afterStable();
    }
    private afterStable(): void {
      setImmediate(() => {
        if (this.signalingState === 'stable' && this.restartWanted) this.onnegotiationneeded?.();
      });
    }
    restartIce(): void {
      this.restartCalls += 1;
      this.restartWanted = true;
      if (this.signalingState === 'stable') this.afterStable();
    }
    async getStats(): Promise<Map<string, Entry>> {
      throw new Error('no stats');
    }
    async setLocalDescription(d?: { type: string }): Promise<void> {
      if (d?.type === 'rollback') {
        if (this.signalingState !== 'have-local-offer') throw new Error('rollback outside have-local-offer');
        this.localDescription = this.stableLocal;
        this.offerUfrag = null;
        this.to('stable');
        return;
      }
      if (this.signalingState === 'have-remote-offer') {
        const offered = ufragOf(this.remoteDescription?.sdp);
        if (this.remoteUfrag !== null && offered !== this.remoteUfrag) {
          this.ufrag = `${this.owner}${++this.gen}`;
          this.restartWanted = false;
        }
        this.remoteUfrag = offered;
        this.localDescription = { type: 'answer', sdp: `v=0\r\na=ice-ufrag:${this.ufrag}\r\n` };
        this.stableLocal = this.localDescription;
        this.to('stable');
        return;
      }
      if (this.signalingState !== 'stable') throw new Error(`an offer in ${this.signalingState}`);
      this.offersMade += 1;
      this.offerUfrag = this.restartWanted ? `${this.owner}${this.gen + 1}` : this.ufrag;
      this.localDescription = { type: 'offer', sdp: `v=0\r\na=ice-ufrag:${this.offerUfrag}\r\n` };
      this.to('have-local-offer');
    }
    async setRemoteDescription(d: Desc): Promise<void> {
      if (d.type === 'offer') {
        if (this.signalingState !== 'stable') throw new Error(`a remote offer in ${this.signalingState}`);
        this.remoteDescription = d;
        this.to('have-remote-offer');
        return;
      }
      if (this.signalingState !== 'have-local-offer') throw new Error(`an answer in ${this.signalingState}`);
      this.remoteDescription = d;
      if (this.offerUfrag !== null && this.offerUfrag !== this.ufrag) {
        this.ufrag = this.offerUfrag;
        this.gen += 1;
        this.restartWanted = false;
      }
      this.offerUfrag = null;
      this.remoteUfrag = ufragOf(d.sdp);
      this.stableLocal = this.localDescription;
      this.to('stable');
    }
    async addIceCandidate(): Promise<void> {}
    close(): void {}
  }
  const wire: Array<{ to: string; from: string; signal: { kind: string } }> = [];
  /** Signals a test holds back or loses on the way: return false to drop one. */
  const net = { pass: (_m: { to: string; from: string; signal: { kind: string } }): boolean => true };
  const page = (id: string, peer: string) => {
    const handlers = new Map<string, (e: unknown, arg: unknown) => void>();
    const sent: Array<{ channel: string; arg: unknown }> = [];
    const intervals: Array<{ cb: () => void; ms: number }> = [];
    const pcs: BrowserLikePc[] = [];
    const electron = {
      ipcRenderer: {
        on: (ch: string, cb: (e: unknown, arg: unknown) => void) => handlers.set(ch, cb),
        send: (channel: string, arg?: unknown) => {
          sent.push({ channel, arg });
          if (channel !== WATCH_CHANNELS.signalOut) return;
          const m = arg as { to: string; signal: { kind: string } };
          wire.push({ to: m.to, from: id, signal: m.signal });
        },
      },
    };
    class Pc extends BrowserLikePc {
      constructor() {
        super(id);
        pcs.push(this);
      }
    }
    new Function('require', 'RTCPeerConnection', 'setInterval', 'clearInterval', script)(() => electron, Pc, (cb: () => void, ms: number) => intervals.push({ cb, ms }), () => undefined);
    const emit = (ch: string, arg?: unknown): void => handlers.get(ch)?.({}, arg);
    emit(WATCH_CHANNELS.config, { localId: id, ice: [], reset: false, peers: [] });
    emit(WATCH_CHANNELS.addPeer, peer);
    return {
      id,
      emit,
      pc: pcs[0]!,
      tick: intervals.find((i) => i.ms === ICE_WATCH.tickMs)!,
      /** The page's own retry: an offer that got no answer is sent again every 5 s. */
      retry: intervals.find((i) => i.ms === 5000)!,
      logs: (): string[] => sent.filter((s) => s.channel === WATCH_CHANNELS.log).map((s) => s.arg as string),
      kinds: (): string[] => sent.filter((s) => s.channel === WATCH_CHANNELS.signalOut).map((s) => (s.arg as { signal: { kind: string } }).signal.kind),
    };
  };
  const alice = page('alice', 'bob');
  const bob = page('bob', 'alice');
  const sides: Record<string, typeof alice> = { alice, bob };
  /** Everything on the wire is delivered, in order, until both pages are quiet. */
  const run = async (): Promise<void> => {
    for (let quiet = 0; quiet < 3; ) {
      await settle();
      const m = wire.shift();
      if (!m) {
        quiet += 1;
        continue;
      }
      quiet = 0;
      if (net.pass(m)) sides[m.to]?.emit(WATCH_CHANNELS.signalIn, { from: m.from, signal: m.signal });
    }
  };
  /** Both connections read `checking` (nothing answers): the watchdogs' spells begin. */
  const checking = (...who: Array<typeof alice>): void => {
    for (const p of who) {
      p.pc.iceConnectionState = 'checking';
      p.pc.fire('iceconnectionstatechange');
    }
  };
  return { alice, bob, wire, net, run, checking };
}

describe('two pages, one connection: a restart the polite side leads travels and takes (I11.12, 2026-11-24)', () => {
  /** The first negotiation: bob (impolite) offers, as a browser asks him to once his data channel exists; alice answers. */
  const connected = async () => {
    const p = loadWatchPair();
    p.bob.pc.onnegotiationneeded?.();
    await p.run();
    expect([p.alice.pc.signalingState, p.bob.pc.signalingState]).toEqual(['stable', 'stable']);
    expect([p.bob.pc.localDescription?.type, p.alice.pc.localDescription?.type]).toEqual(['offer', 'answer']);
    return p;
  };

  it('restart 1 is the lead\'s, restart 2 the polite side\'s: its offer is answered by the lead, both sides\' credentials are new, and the lead\'s watchdog counts it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = await connected();
      p.checking(p.alice, p.bob);
      // 3 s of nothing: restart 1, the lead's turn.
      vi.advanceTimersByTime(3_000);
      p.alice.tick.cb();
      p.bob.tick.cb();
      expect([p.alice.pc.restartCalls, p.bob.pc.restartCalls]).toEqual([0, 1]);
      await p.run();
      expect(p.bob.logs()).toContain('peer alice: ICE restart 1 of 6 (checking for 3 s, our turn; no pair yet)');
      expect(p.alice.logs()).toContain('peer bob: ICE restart 1 of 6 by the peer (checking)');
      const before = [p.alice.pc.localUfrag(), p.bob.pc.localUfrag()];
      expect(before).toEqual(['alice1', 'bob1']);
      // 3 s more: restart 2 is the polite side's turn. The lead waits for it.
      vi.advanceTimersByTime(3_000);
      p.alice.tick.cb();
      p.bob.tick.cb();
      expect([p.alice.pc.restartCalls, p.bob.pc.restartCalls]).toEqual([1, 1]);
      await p.run();
      // It travelled and took: alice offered with new credentials, bob (stable, impolite) answered with new ones.
      expect([p.alice.pc.localDescription?.type, p.bob.pc.localDescription?.type]).toEqual(['offer', 'answer']);
      expect([p.alice.pc.localUfrag(), p.bob.pc.localUfrag()]).toEqual(['alice2', 'bob2']);
      expect([p.alice.pc.signalingState, p.bob.pc.signalingState]).toEqual(['stable', 'stable']);
      // The polite side's log says it was its turn; the lead's says the peer made restart 2.
      expect(p.alice.logs()).toContain('peer bob: ICE restart 2 of 6 (checking for 3 s, our turn; no pair yet)');
      expect(p.bob.logs()).toContain('peer alice: ICE restart 2 of 6 by the peer (checking)');
      // Neither counted it twice: alice did not read bob's answer as a restart of his, bob made none of his own.
      expect(p.alice.logs().filter((l) => l.includes('restart 2 of 6'))).toHaveLength(2);
      expect(p.alice.logs().some((l) => l.includes('restart 2 of 6 by the peer'))).toBe(false);
      expect(p.bob.logs().some((l) => l.includes('restart 2 of 6 (')).valueOf()).toBe(false);
      // So restart 3 is the lead's again, 6 s on, and alice counts it.
      vi.advanceTimersByTime(6_000);
      p.alice.tick.cb();
      p.bob.tick.cb();
      expect([p.alice.pc.restartCalls, p.bob.pc.restartCalls]).toEqual([1, 2]);
      await p.run();
      expect(p.bob.logs()).toContain('peer alice: ICE restart 3 of 6 (checking for 6 s, our turn; no pair yet)');
      expect(p.alice.logs()).toContain('peer bob: ICE restart 3 of 6 by the peer (checking)');
      expect([p.alice.pc.localUfrag(), p.bob.pc.localUfrag()]).toEqual(['alice3', 'bob3']);
      expect(p.wire).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the lead is in the middle of an offer of its own when the polite side\'s restart arrives: that offer is answered first, and the restart goes out again by itself and is counted once on each side', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = await connected();
      p.checking(p.alice, p.bob);
      vi.advanceTimersByTime(3_000);
      p.alice.tick.cb();
      p.bob.tick.cb();
      await p.run();
      expect([p.alice.pc.localUfrag(), p.bob.pc.localUfrag()]).toEqual(['alice1', 'bob1']);
      // The lead offers again for a reason of its own, and that offer is lost on the way: he waits for its answer.
      p.net.pass = (m) => !(m.from === 'bob' && m.signal.kind === 'offer');
      p.bob.pc.onnegotiationneeded?.();
      await p.run();
      p.net.pass = () => true;
      expect(p.bob.pc.signalingState).toBe('have-local-offer');
      // Restart 2, the polite side's turn: her offer reaches a lead who is mid-offer and impolite, and is ignored.
      vi.advanceTimersByTime(3_000);
      p.alice.tick.cb();
      p.bob.tick.cb();
      await p.run();
      expect([p.alice.pc.restartCalls, p.alice.pc.signalingState, p.bob.pc.signalingState]).toEqual([1, 'have-local-offer', 'have-local-offer']);
      expect(p.bob.logs().some((l) => l.includes('restart 2 of 6'))).toBe(false);
      const offers = p.alice.pc.offersMade;
      // The lead's page sends its unanswered offer again (its 5 s retry). She rolls her restart back and answers; that
      // offer was no restart, so her credentials stay, and her connection asks for negotiation again by itself (the
      // watchdog does nothing more): the restart goes out a second time, the lead is stable now and answers it.
      p.bob.retry.cb();
      await p.run();
      expect(p.alice.pc.offersMade).toBe(offers + 1);
      expect(p.alice.pc.restartCalls).toBe(1);
      expect([p.alice.pc.signalingState, p.bob.pc.signalingState]).toEqual(['stable', 'stable']);
      expect([p.alice.pc.localUfrag(), p.bob.pc.localUfrag()]).toEqual(['alice2', 'bob2']);
      expect(p.alice.logs().filter((l) => l.includes('ICE restart 2 of 6'))).toEqual(['peer bob: ICE restart 2 of 6 (checking for 3 s, our turn; no pair yet)']);
      expect(p.bob.logs().filter((l) => l.includes('ICE restart 2 of 6'))).toEqual(['peer alice: ICE restart 2 of 6 by the peer (checking)']);
      expect(p.wire).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('both restart at the same moment: the lead\'s offer stands, the polite side answers it and counts one restart, and the next one is its turn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = await connected();
      // The polite side has read `checking` for 11 s when the lead's own trouble begins; 3 s later it is 14 s for her
      // (her wait for the lead's restart 1 is over) and 3 s for him: both restart in the same second.
      p.checking(p.alice);
      vi.advanceTimersByTime(11_000);
      p.checking(p.bob);
      vi.advanceTimersByTime(3_000);
      p.alice.tick.cb();
      p.bob.tick.cb();
      expect([p.alice.pc.restartCalls, p.bob.pc.restartCalls]).toEqual([1, 1]);
      await p.run();
      // One restart happened: his offer, her answer; each side's credentials changed once.
      expect([p.bob.pc.localDescription?.type, p.alice.pc.localDescription?.type]).toEqual(['offer', 'answer']);
      expect([p.alice.pc.localUfrag(), p.bob.pc.localUfrag()]).toEqual(['alice1', 'bob1']);
      expect(p.alice.logs()).toContain('peer bob: ICE restart 1 of 6: the peer restarted at the same moment and its offer stands (one restart, counted once)');
      expect(p.alice.logs().some((l) => l.includes('by the peer ('))).toBe(false);
      expect(p.bob.logs().some((l) => l.includes('by the peer'))).toBe(false);
      // Both count one, so restart 2 is hers, 3 s on, and he counts it.
      vi.advanceTimersByTime(3_000);
      p.alice.tick.cb();
      p.bob.tick.cb();
      expect([p.alice.pc.restartCalls, p.bob.pc.restartCalls]).toEqual([2, 1]);
      await p.run();
      expect(p.alice.logs()).toContain('peer bob: ICE restart 2 of 6 (checking for 3 s, our turn; no pair yet)');
      expect(p.bob.logs()).toContain('peer alice: ICE restart 2 of 6 by the peer (checking)');
      expect([p.alice.pc.localUfrag(), p.bob.pc.localUfrag()]).toEqual(['alice2', 'bob2']);
      expect(p.wire).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what a round keeps of a look at the stats, and of the candidates that pass (I11.12, 2026-11-24)', () => {
  const peerOf = (round: IceRound, o: { local?: string | null; remote?: string | null } = {}): IceRoundPeer => ({
    pc: {
      iceConnectionState: 'checking',
      localDescription: o.local === null ? null : { sdp: `v=0\r\na=ice-ufrag:${o.local ?? 'mine1'}\r\n` },
      remoteDescription: o.remote === null ? null : { sdp: `v=0\r\na=ice-ufrag:${o.remote ?? 'theirs1'}\r\n` },
    },
    round,
    ids: null,
  });
  const srflx = (ufrag: string | null): string => `candidate:7 1 udp 1686052607 203.0.113.7 50000 typ srflx raddr 192.0.2.10 rport 50000 generation 0${ufrag ? ` ufrag ${ufrag}` : ''} network-id 1`;

  it('a look: the candidates there are, the counters kept without any address, and the first check sent and received on a pair with a server-reflexive candidate', () => {
    const r = peerOf(iceRoundStart(1, 1_000, null, null));
    // Only the host pair has sent: no time yet.
    iceRoundLook(r, 1_200, stalled().map((e) => (e.type === 'candidate-pair' && e.id !== 'CPL1_R1' ? { ...e, requestsSent: 0 } : e)));
    expect(r.ids).toEqual({ local: ['L1', 'L2'], remote: ['R1', 'R2'] });
    expect(r.round).toMatchObject({ checkOutMs: null, checkInMs: null });
    expect(r.kept?.at).toBe(1_200);
    // What is kept is what a line needs, and nothing that could be an address.
    expect(JSON.stringify(r.kept)).not.toMatch(/192\.0\.2|198\.51|50000|61000|abcd|wxyz|"address"|"port"|usernameFragment/);
    expect(r.kept?.entries.filter((e) => e.type === 'candidate-pair')).toHaveLength(4);
    // A check goes out to the peer's server-reflexive candidate; later one comes in on a pair with one.
    iceRoundLook(r, 1_350, stalled());
    expect(r.round).toMatchObject({ checkOutMs: 350, checkInMs: null });
    iceRoundLook(r, 1_500, stalled().map((e) => (e.id === 'CPL2_R1' ? { ...e, requestsReceived: 1 } : e)));
    expect(r.round).toMatchObject({ checkOutMs: 350, checkInMs: 500 });
    // Kept at most once a second while there are pairs; a look that finds none leaves the last one kept.
    expect(r.kept?.at).toBe(1_200);
    iceRoundLook(r, 2_300, stalled());
    expect(r.kept?.at).toBe(2_300);
    iceRoundLook(r, 17_500, stalled().filter((e) => e.type !== 'candidate-pair' && e.type !== 'remote-candidate'));
    expect(r.kept?.at).toBe(2_300);
    expect(r.ids).toEqual({ local: ['L1', 'L2'], remote: [] });
    // A first check that only a late look sees (the page reads every 50 ms for 3 s, then every 2 or 3 s) gets no time.
    const late = peerOf(iceRoundStart(1, 0, null, null));
    iceRoundLook(late, 14_000, stalled());
    expect(late.round).toMatchObject({ checkOutMs: null, checkInMs: null });
    expect(late.kept?.at).toBe(14_000);
  });

  it('a look in a restart round: a check from a new port to a candidate of the round before is not this round\'s first', () => {
    const known = { local: ['L1', 'L2'], remote: ['R1', 'R2'] };
    const r = peerOf(iceRoundStart(2, 10_000, 'theirs1', known));
    const fresh: Entry[] = [
      ...stalled(),
      { id: 'L3', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
      { id: 'R3', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
      // The new port checks the peer's old server-reflexive candidate at once (the recorded restart, above)...
      { id: 'CPL3_R2', type: 'candidate-pair', localCandidateId: 'L3', remoteCandidateId: 'R2', state: 'in-progress', requestsSent: 2, requestsReceived: 0 },
      // ...and has not yet checked the new one.
      { id: 'CPL3_R3', type: 'candidate-pair', localCandidateId: 'L3', remoteCandidateId: 'R3', state: 'waiting', requestsSent: 0, requestsReceived: 0 },
    ];
    iceRoundLook(r, 10_100, fresh);
    expect(r.round).toMatchObject({ checkOutMs: null, checkInMs: null });
    iceRoundLook(r, 10_650, fresh.map((e) => (e.id === 'CPL3_R3' ? { ...e, requestsSent: 1 } : e)));
    expect(r.round).toMatchObject({ checkOutMs: 650, checkInMs: null });
    // After a connect the round waits (idle): a look notes the candidates and nothing else.
    const idle = peerOf({ ...iceRoundStart(3, 20_000, 'theirs2', null), idle: true });
    iceRoundLook(idle, 99_000, stalled());
    expect(idle.ids?.local).toEqual(['L1', 'L2']);
    expect(idle.kept ?? null).toBeNull();
    expect(idle.round.checkOutMs).toBeNull();
  });

  it("candidates: only a server-reflexive one counts, the first each way, and only for the round its ufrag says it belongs to", () => {
    // Round 1, this side offered: its own candidate goes out; the peer's arrives before its answer is applied.
    const r = peerOf(iceRoundStart(1, 0, null, null), { remote: null });
    iceRoundCandidate(r, 20, true, 'candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host generation 0 ufrag mine1 network-id 1');
    iceRoundCandidate(r, 25, true, 42);
    expect(r.round.srflxOutMs).toBeNull();
    iceRoundCandidate(r, 50, true, srflx('mine1'));
    iceRoundCandidate(r, 90, true, srflx('mine1'));
    expect(r.round.srflxOutMs).toBe(50);
    iceRoundCandidate(r, 240, false, srflx('theirs1'));
    iceRoundCandidate(r, 300, false, srflx('theirs1'));
    expect(r.round).toMatchObject({ srflxOutMs: 50, srflxInMs: 240 });

    // A restart made here (round 2 waits for its answer): a late candidate of the round before, either way, is not its.
    const own = peerOf(iceRoundStart(2, 10_000, 'theirs1', null), { local: 'mine2', remote: 'theirs1' });
    iceRoundCandidate(own, 10_010, true, srflx('mine1'));
    iceRoundCandidate(own, 10_020, false, srflx('theirs1'));
    expect(own.round).toMatchObject({ srflxOutMs: null, srflxInMs: null });
    iceRoundCandidate(own, 10_040, true, srflx('mine2'));
    // The peer's new candidate, a moment before its answer is applied here.
    iceRoundCandidate(own, 10_190, false, srflx('theirs2'));
    expect(own.round).toMatchObject({ srflxOutMs: 40, srflxInMs: 190 });
    expect(own.srflxEarly ?? null).toBeNull();

    // A restart the peer makes while this round has its remote description: its candidate is the NEXT round's.
    const led = peerOf({ ...iceRoundStart(2, 20_000, 'theirs1', null), remoteMs: 150 }, { local: 'mine2', remote: 'theirs2' });
    iceRoundCandidate(led, 23_000, false, srflx('theirs3'));
    expect(led.round.srflxInMs).toBeNull();
    expect(led.srflxEarly).toBe(23_000);
    const lines: string[] = [];
    led.pc.remoteDescription = { sdp: 'v=0\r\na=ice-ufrag:theirs3\r\n' };
    iceRoundOver(led, 'restart 2 of 6 by the peer', false, true, 23_030, (l) => lines.push(l));
    expect(led.round).toMatchObject({ n: 3, at: 23_030, remoteMs: 0, srflxInMs: 0 });
    expect(led.srflxEarly).toBeNull();
    // And one that comes after the round changed is timed in it.
    const led2 = peerOf({ ...iceRoundStart(3, 23_030, 'theirs3', null), remoteMs: 0 }, { local: 'mine3', remote: 'theirs3' });
    iceRoundCandidate(led2, 23_090, false, srflx('theirs3'));
    expect(led2.round.srflxInMs).toBe(60);

    // A line without a ufrag (another browser): counted for the round in force. An idle round counts nothing.
    const bare = peerOf(iceRoundStart(1, 0, null, null));
    iceRoundCandidate(bare, 70, false, srflx(null));
    iceRoundCandidate(bare, 80, true, srflx(null));
    expect(bare.round).toMatchObject({ srflxOutMs: 80, srflxInMs: 70 });
    const idle = peerOf({ ...iceRoundStart(2, 0, 'theirs1', null), idle: true });
    iceRoundCandidate(idle, 500, true, srflx('mine1'));
    iceRoundCandidate(idle, 500, false, srflx('theirs1'));
    expect(idle.round).toMatchObject({ srflxOutMs: null, srflxInMs: null });
  });

  it('the end of a round that has no pair left: its line is the kept look\'s, and says from when; with pairs left, or connected, the stats of the moment as before', async () => {
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    const make = (live: Entry[] | 'rejects', ice = 'disconnected'): IceRoundPeer => ({
      pc: { iceConnectionState: ice, remoteDescription: { sdp: 'v=0\r\na=ice-ufrag:uf2\r\n' }, getStats: () => (live === 'rejects' ? Promise.reject(new Error('closed')) : Promise.resolve(new Map(live.map((e) => [e.id as string, e])))) },
      round: { ...iceRoundStart(2, 10_000, 'uf1', null), remoteMs: 140, checkingMs: 140 },
      ids: null,
    });
    const gone = stalled().filter((e) => e.type !== 'candidate-pair' && e.type !== 'remote-candidate');
    // The pairs were there 14 s in and are gone at 20 s.
    for (const live of [gone, 'rejects'] as const) {
      const r = make(live);
      iceRoundLook(r, 24_000, stalled());
      iceRoundLook(r, 28_000, gone);
      const lines: string[] = [];
      iceRoundOver(r, 'restart 2 of 6 decided here', false, false, 30_000, (l) => lines.push(l));
      expect(r.kept ?? null).toBeNull();
      await flush();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('ICE round 2: restart 2 of 6 decided here after 20.00 s (ice disconnected); remote description at 0.14 s, checking at 0.14 s, not connected');
      expect(lines[0]).toContain('; 4 pairs as of 14.00 s (none left at the end): host>host udp in-progress sent 21 answered 0, received 0 answered 0; ');
      expect(lines[0]).toMatch(SAFE_LINE);
    }
    // Pairs are still there at the end: the stats of that moment, nothing said about a kept look.
    const still = make(stalled().map((e) => (e.type === 'candidate-pair' ? { ...e, requestsSent: 40 } : e)));
    iceRoundLook(still, 24_000, stalled());
    const a: string[] = [];
    iceRoundOver(still, 'restart 2 of 6 decided here', false, false, 30_000, (l) => a.push(l));
    await flush();
    expect(a[0]).toContain('; 4 pairs: host>host udp in-progress sent 40 answered 0, received 0 answered 0; ');
    expect(a[0]).not.toContain('as of');
    // A look kept in the round before is not this round's.
    const stale = make(gone);
    stale.kept = { at: 9_000, entries: stalled() };
    const b: string[] = [];
    iceRoundOver(stale, 'restart 2 of 6 decided here', false, false, 30_000, (l) => b.push(l));
    await flush();
    expect(b[0]!.endsWith('; 0 pairs')).toBe(true);
  });
});

/**
 * I11.12 (2026-11-24): the two sides of one connection, each with its own watchdog, its own 1 s tick and its own
 * clock, restarting by `iceWatchStep`. `NEW` is the schedule alone (it stops where the pages say "no path so far":
 * `gaveUp` is that moment), `NEW_ON` is what the pages run (the restarts go on every 30 s after it), and `OLD` is
 * 0.2.50's rule as it shipped (the lead at 10, 20, 40 s, the other side 5 s later, three restarts), for the nights
 * when only one PC has the update. A restart reaches the other side `tripMs` later and is counted there as one of its
 * own (`notePeerRestart`); two that cross are settled as the negotiation settles them: the impolite side (the usual
 * lead) ignores the polite one's offer, and the polite side answers the impolite one's, which the new pages count as
 * the one restart it is and 0.2.50 counted on top of its own. A restart that arrives before a side's own trouble
 * began (it still read the connection as up) is not counted by 0.2.50; the new pages remember it and begin their
 * spell at restart 1 when that is within 20 s (`forget`: the pages as the first commit of this change had them).
 */
type Rule = (elapsedMs: number, restarts: number, lead: boolean) => 'ok' | 'wait' | 'restart' | 'give_up';
const NEW: Rule = (e, n, lead) => iceWatchStep('checking', e, n, lead, ICE_WATCH);
const NEW_ON: Rule = (e, n, lead) => iceWatchStep('checking', e, n, lead, ICE_WATCH, true);
const OLD_WATCH = { backoffMs: [10_000, 20_000, 40_000], lagMs: 5_000 } as const;
const OLD: Rule = (e, n, lead) => {
  const lag = lead ? 0 : OLD_WATCH.lagMs;
  if (n >= 3) return e >= 40_000 + lag ? 'give_up' : 'wait';
  return e >= OLD_WATCH.backoffMs[n]! + lag ? 'restart' : 'wait';
};
interface Side {
  name: string;
  lead: boolean;
  rule: Rule;
  /** When this side's trouble began (its clock's zero), and the phase of its 1 s tick. */
  since: number;
  phase: number;
  restarts?: number;
}
function twoSides(a: Side, b: Side, tripMs = 150, untilMs = 200_000, o: { forget?: boolean } = {}) {
  const st = [a, b].map((s) => ({ ...s, n: s.restarts ?? 0, lastAt: 0, gaveUp: null as number | null, offerAt: null as number | null, peerAt: null as number | null, begun: false }));
  const events: Array<{ at: number; by: string; turn: string }> = [];
  const mail: Array<{ at: number; to: number; sentAt: number }> = [];
  for (let t = 0; t <= untilMs; t += 50) {
    for (const m of mail.filter((x) => x.at === t)) {
      const me = st[m.to]!;
      // Two offers crossed: the impolite side (the lead) ignores the polite one's; the polite one answers.
      const crossed = me.offerAt !== null && t - me.offerAt < 2_000 && m.sentAt < me.offerAt + tripMs;
      if (crossed && me.lead) continue;
      me.offerAt = null;
      if (me.gaveUp !== null) continue;
      // Answered while this side still reads the connection as up: not counted; the new pages remember when.
      if (t < me.since) {
        if (me.rule !== OLD && !o.forget) me.peerAt = t;
        continue;
      }
      me.lastAt = t;
      // The new pages: its own restart and the peer's that crossed it are one restart (`ownAt`).
      if (crossed && me.rule !== OLD) continue;
      me.n += 1;
    }
    for (let i = 0; i < 2; i++) {
      const me = st[i]!;
      if (me.gaveUp !== null || t < me.since) continue;
      if (!me.begun) {
        me.begun = true;
        // The spell begins: a restart of the peer's within the 20 s before it is this spell's first.
        if (me.peerAt !== null && t - me.peerAt < 20_000) {
          me.n = 1;
          me.lastAt = me.peerAt;
        }
      }
      if ((t - me.phase) % 1000 !== 0) continue;
      const action = me.rule(t - Math.max(me.since, me.lastAt), me.n, me.lead);
      if (action === 'give_up') me.gaveUp = t;
      if (action !== 'restart') continue;
      const turn = me.n % 2 === 0 ? (me.lead ? me.name : st[1 - i]!.name) : me.lead ? st[1 - i]!.name : me.name;
      events.push({ at: t, by: me.name, turn });
      me.n += 1;
      me.lastAt = t;
      me.offerAt = t;
      mail.push({ at: t + tripMs, to: 1 - i, sentAt: t });
    }
  }
  /** The smallest time between two restarts, whoever made them. */
  const closest = events.slice(1).reduce((min, e, i) => Math.min(min, e.at - events[i]!.at), Infinity);
  return { events, by: events.map((e) => e.by).join(''), at: events.map((e) => Math.round(e.at / 1000)), closest, counts: st.map((s) => s.n), gaveUp: st.map((s) => (s.gaveUp === null ? null : Math.round(s.gaveUp / 1000))) };
}

describe('the two watchdogs of one connection, in every mix of versions (I11.12, 2026-11-24)', () => {
  it('both on the new rules: the restarts take turns, the usual lead first, 3, 3, 6, 6, 12 and 12 s apart (with the 1 s tick: at 3, 7, 14, 21, 34 and 47 s); never two at once; both give up at about 60 s', () => {
    const r = twoSides({ name: 'L', lead: true, rule: NEW, since: 0, phase: 0 }, { name: 'P', lead: false, rule: NEW, since: 0, phase: 0 });
    expect(r.by).toBe('LPLPLP');
    expect(r.at).toEqual([3, 7, 14, 21, 34, 47]);
    expect(r.events.every((e) => e.by === e.turn)).toBe(true);
    expect(r.counts).toEqual([6, 6]);
    expect(r.gaveUp).toEqual([60, 62]);
    expect(r.closest).toBeGreaterThanOrEqual(3_000);
  });

  it('both new, their clocks and ticks apart (the answering side sees the trouble up to a second before the other), a slow signalling trip: the same turns, no two restarts within 2 s', () => {
    for (const [sinceP, phaseL, phaseP, trip] of [[0, 0, 500, 150], [-900, 300, 50, 150], [900, 0, 950, 150], [-900, 950, 0, 800], [400, 200, 700, 1000]] as const) {
      const r = twoSides({ name: 'L', lead: true, rule: NEW, since: 1_000, phase: phaseL }, { name: 'P', lead: false, rule: NEW, since: 1_000 + sinceP, phase: phaseP }, trip);
      const what = `P ${sinceP} ms, ticks ${phaseL}/${phaseP}, trip ${trip}`;
      expect(r.by, what).toBe('LPLPLP');
      expect(r.events.every((e) => e.by === e.turn), what).toBe(true);
      expect(r.closest, what).toBeGreaterThanOrEqual(2_000);
      expect(r.counts, what).toEqual([6, 6]);
      // The sixth within 50 s of the trouble's start (0.2.50: the third at 70 s).
      expect(r.at.at(-1)!, what).toBeLessThanOrEqual(51);
    }
  });

  it('new on the usual lead, 0.2.50 on the other side: the lead restarts at 3 s and then leaves the other side its own restart, 25 s later (the other direction, tried at about 28 s); after that the new side makes them all', () => {
    for (const [sinceP, phaseP] of [[0, 0], [-900, 400], [900, 700]] as const) {
      const r = twoSides({ name: 'L', lead: true, rule: NEW, since: 1_000, phase: 0 }, { name: 'p', lead: false, rule: OLD, since: 1_000 + sinceP, phase: phaseP });
      const what = `old side ${sinceP} ms, tick ${phaseP}`;
      expect(r.by, what).toBe('LpLLLL');
      // The old side's restart: 25 s after it counted the lead's, and before the 28 s the lead gives it.
      expect(r.events[1]!.at - r.events[0]!.at, what).toBeGreaterThanOrEqual(25_000);
      expect(r.events[1]!.at - r.events[0]!.at, what).toBeLessThan(28_000);
      expect(r.closest, what).toBeGreaterThanOrEqual(2_000);
      // Six restarts in all; the old side has counted them all, makes no more of its own and gives up 45 s after the last.
      expect(r.counts, what).toEqual([6, 6]);
      expect(r.gaveUp[0], what).not.toBeNull();
      expect(r.gaveUp[1]! - r.at.at(-1)!, what).toBeGreaterThanOrEqual(44);
    }
  });

  it('0.2.50 on the usual lead, new on the other side: the old lead still makes its first restart, at 10 s (the one that connected 15 of 16 times with Krobs), before the new side makes any; then the new side goes on, its own direction first', () => {
    for (const [sinceP, phaseL, phaseP] of [[0, 0, 0], [-900, 0, 500], [-900, 900, 0], [900, 300, 700]] as const) {
      const r = twoSides({ name: 'l', lead: true, rule: OLD, since: 1_000, phase: phaseL }, { name: 'P', lead: false, rule: NEW, since: 1_000 + sinceP, phase: phaseP });
      const what = `new side ${sinceP} ms, ticks ${phaseL}/${phaseP}`;
      expect(r.by, what).toBe('lPPPPP');
      expect(r.events[0]!.at - 1_000, what).toBeGreaterThanOrEqual(10_000);
      expect(r.events[0]!.at - 1_000, what).toBeLessThan(11_000);
      // The new side's first is 3 s after the old lead's (restart 2 is its turn).
      expect(r.events[1]!.at - r.events[0]!.at, what).toBeGreaterThanOrEqual(3_000);
      expect(r.events[1]!.at - r.events[0]!.at, what).toBeLessThanOrEqual(4_200);
      expect(r.closest, what).toBeGreaterThanOrEqual(2_000);
      expect(r.counts, what).toEqual([6, 6]);
    }
  });

  it('0.2.50 on both sides (the model against what shipped): the lead at 10, 30 and 70 s, the other side never', () => {
    const r = twoSides({ name: 'l', lead: true, rule: OLD, since: 0, phase: 0 }, { name: 'p', lead: false, rule: OLD, since: 0, phase: 0 });
    expect(r.by).toBe('lll');
    expect(r.at).toEqual([10, 30, 70]);
    // The other side 5 s after the lead, on its own tick.
    expect(r.gaveUp).toEqual([110, 116]);
  });

  it('two restarts that cross (both sides at the same moment) are one restart on both sides: the counts stay the same and the turns go on', () => {
    // The lead is 3 s late for restart 1 of this run (its trouble began 11 s after the other side's, which has waited its 14 s).
    const r = twoSides({ name: 'L', lead: true, rule: NEW, since: 11_000, phase: 0 }, { name: 'P', lead: false, rule: NEW, since: 0, phase: 0 });
    expect(r.events.slice(0, 2).map((e) => `${e.by}@${e.at}`)).toEqual(['L@14000', 'P@14000']);
    // After the glare: the other side's turn, then the lead's, and so on; no second glare.
    expect(r.by).toBe('LPPLPLP');
    expect(r.counts).toEqual([6, 6]);
    expect(r.events.slice(2).every((e) => e.by === e.turn)).toBe(true);
    expect(r.events.slice(2).reduce((min, e, i) => Math.min(min, e.at - r.events[i + 1]!.at), Infinity)).toBeGreaterThanOrEqual(3_000);
  });

  it('a blip one side sees seconds before the other: the restart the first side has already made is the first of the other side\'s spell, so the counts agree and the turns alternate', () => {
    // The lead sees the trouble 5 s before the other side: it restarts at 3 s, which the other side answers while it
    // still reads the connection as up. Its own spell begins at 5 s, at restart 1: restart 2 is its turn.
    const r = twoSides({ name: 'L', lead: true, rule: NEW, since: 0, phase: 0 }, { name: 'P', lead: false, rule: NEW, since: 5_000, phase: 0 });
    expect(r.by).toBe('LPLPLP');
    expect(r.events.every((e) => e.by === e.turn)).toBe(true);
    expect(r.at).toEqual([3, 8, 15, 22, 35, 48]);
    expect(r.counts).toEqual([6, 6]);
    expect(r.closest).toBeGreaterThanOrEqual(3_000);
    // The same with the lead's and the other side's ticks apart, and a slow trip.
    for (const [late, phaseL, phaseP, trip] of [[3_500, 300, 800, 150], [4_000, 0, 950, 800], [9_000, 500, 0, 150], [19_000, 0, 0, 150]] as const) {
      const x = twoSides({ name: 'L', lead: true, rule: NEW, since: 1_000, phase: phaseL }, { name: 'P', lead: false, rule: NEW, since: 1_000 + late, phase: phaseP }, trip);
      const what = `the other side ${late} ms later, ticks ${phaseL}/${phaseP}, trip ${trip}`;
      expect(x.by, what).toBe('LPLPLP');
      expect(x.events.every((e) => e.by === e.turn), what).toBe(true);
      expect(x.counts, what).toEqual([6, 6]);
    }
    // What it was without that (the first commit of this change): the counts are 1 and 0 from the start, and after
    // the lead's first restart the other side makes every one, because each time it is the first whose wait is over.
    const before = twoSides({ name: 'L', lead: true, rule: NEW, since: 0, phase: 0 }, { name: 'P', lead: false, rule: NEW, since: 5_000, phase: 0 }, 150, 200_000, { forget: true });
    expect(before.by).toBe('LPPPPPP');
    expect(before.at).toEqual([3, 19, 22, 31, 37, 52, 64]);
    expect(before.counts).toEqual([7, 6]);
    // The other way round: the side that is not the lead sees it 16 s before the lead, waits its 14 s and makes
    // restart 1 in the lead's place; the lead's spell begins at restart 1 too, and restart 2 is the other side's.
    const other = twoSides({ name: 'L', lead: true, rule: NEW, since: 16_000, phase: 0 }, { name: 'P', lead: false, rule: NEW, since: 0, phase: 0 });
    expect(other.by).toBe('PPLPLP');
    expect(other.events.slice(1).every((e) => e.by === e.turn)).toBe(true);
    expect(other.counts).toEqual([6, 6]);
    // More than 20 s apart is another trouble: nothing is carried over (the lead's spell begins at its own restart 1).
    const apart = twoSides({ name: 'L', lead: true, rule: NEW, since: 0, phase: 0 }, { name: 'P', lead: false, rule: NEW, since: 26_000, phase: 0 });
    expect(apart.events[0]).toMatchObject({ by: 'L', at: 3_000 });
    expect(apart.counts[1]).toBeLessThan(apart.counts[0]!);
  });

  it('never the end: after the sixth restart the two sides go on, one restart every 30 s, turns alternating, and the words come at the moment 0.2.50 gave up', () => {
    const r = twoSides({ name: 'L', lead: true, rule: NEW_ON, since: 0, phase: 0 }, { name: 'P', lead: false, rule: NEW_ON, since: 0, phase: 0 }, 150, 300_000);
    expect(r.by.slice(0, 6)).toBe('LPLPLP');
    expect(r.at.slice(0, 6)).toEqual([3, 7, 14, 21, 34, 47]);
    // Restart 7 is the lead's, 30 s after the sixth; restart 8 the other side's, and so on.
    expect(r.by.slice(6)).toBe('LPLPLPLP');
    expect(r.at.slice(6)).toEqual([78, 109, 140, 171, 202, 233, 264, 295]);
    expect(r.events.every((e) => e.by === e.turn)).toBe(true);
    expect(r.gaveUp).toEqual([null, null]);
    expect(r.counts).toEqual([14, 14]);
    // A peer on 0.2.50 beside a new side that goes on: it counts each restart and never reaches its own 40 s of
    // quiet, so it never says there is no path either; the new side makes every late restart, 30 or 33 s apart.
    for (const [old, mine] of [['p', 'L'], ['l', 'P']] as const) {
      const x = twoSides({ name: old === 'l' ? 'l' : 'L', lead: true, rule: old === 'l' ? OLD : NEW_ON, since: 0, phase: 0 }, { name: old === 'p' ? 'p' : 'P', lead: false, rule: old === 'p' ? OLD : NEW_ON, since: 0, phase: 0 }, 150, 400_000);
      const late = x.events.slice(6);
      expect(late.length, old).toBeGreaterThanOrEqual(9);
      expect(late.every((e) => e.by === mine), old).toBe(true);
      const gaps = late.slice(1).map((e, i) => e.at - late[i]!.at);
      expect(Math.min(...gaps), old).toBeGreaterThanOrEqual(30_000);
      expect(Math.max(...gaps), old).toBeLessThanOrEqual(34_000);
      expect(x.gaveUp, old).toEqual([null, null]);
    }
  });

  it('the two counts apart (one side counted a restart the other did not: a page rebuilt, a signal lost): restarts go on to the end of both schedules, and both sides give up', () => {
    for (const [nL, nP] of [[0, 1], [1, 0], [2, 1], [1, 2], [0, 3]] as const) {
      const r = twoSides({ name: 'L', lead: true, rule: NEW, since: 0, phase: 0, restarts: nL }, { name: 'P', lead: false, rule: NEW, since: 0, phase: 0, restarts: nP });
      const what = `counts ${nL}/${nP}`;
      // Nobody waits for ever for the other's turn.
      expect(r.events.length, what).toBeGreaterThanOrEqual(5);
      expect(Math.min(...r.counts), what).toBeGreaterThanOrEqual(6);
      // No longer than 15 s between two restarts (the longest wait of the schedule), 28 s for the second.
      const gaps = r.events.slice(1).map((e, i) => e.at - r.events[i]!.at);
      expect(Math.max(...gaps), what).toBeLessThanOrEqual(17_000);
      // Never three restarts at the same moment in a row (a glare the negotiation settles, then the schedule again).
      expect(gaps.some((g, i) => g < 1_000 && (gaps[i + 1] ?? 9_999) < 1_000), what).toBe(false);
      expect(r.gaveUp.every((g) => g !== null), what).toBe(true);
    }
  });
});

describe('what main takes from a page for the log (I11.12)', () => {
  it("one line, 400 characters; 1200 for an ICE round's line and for nothing else", () => {
    const long = 'x'.repeat(2000);
    expect(pageLogLine(`peer krobs: data channel send failed (${long})`)).toHaveLength(400);
    expect(pageLogLine(`peer krobs: ICE round 1: restart 1 of 3 decided here after 10.00 s ${long}`)).toHaveLength(1200);
    expect(pageLogLine(`ICE round 12: connected ${long}`)).toHaveLength(1200);
    // The words in the middle of another line do not buy the longer limit.
    expect(pageLogLine(`peer krobs: negotiation (offer): something about an ICE round 1: ${long}`)).toHaveLength(400);
    expect(pageLogLine('two\r\nlines\nhere ')).toBe('two lines here');
  });

  it('CASTCADE_ICE_FIRST_RESTART_MS: 500 to 9000 ms, anything else is no experiment', () => {
    expect(firstRestartMs(undefined)).toBeNull();
    for (const bad of ['', '0', '499', '9001', '2.5', '2500ms', '-2500', 'yes', '25000']) expect(firstRestartMs(bad), bad).toBeNull();
    expect(firstRestartMs('500')).toBe(500);
    expect(firstRestartMs(' 2500 ')).toBe(2500);
    expect(firstRestartMs('9000')).toBe(9000);
  });
});
