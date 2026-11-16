/**
 * I11.4.1: the 3D watch session in the shell, two PCs in one test: the real session over the relay double, a fake
 * tunnel end and a fake launcher. Who may host or join (paired, no match), Play (the fork with the player's stream
 * variables, the role, the port to the tunnel), Watch (the table looked for by name and size, the tunnel listener,
 * the watcher's variables), the VPX closing (the role is free, the testers swap), Leave.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { KnownTable } from '../launch/known-tables.js';
import type { LaunchOptions, LaunchResult, VpxLauncher } from '../launch/vpx-launch.js';
import { startFakeRelay, type FakeRelay } from '../match/relay-fake.test-support.js';
import type { TunnelEnd, TunnelEndOptions, TunnelEndStatus } from '../watch/tunnel-end.js';
import { createWatchHost, findWatchTable, pathWords, watchTableLine, type WatchHost, type WatchStatus } from './watch-host.js';

const DEVICES = { 'dev-a': 'tok-a', 'dev-b': 'tok-b' };
const VPX = String.raw`C:\vpx\VPinballX_GL64.exe`;
const FORK = String.raw`C:\vpx\VPinballX_GL64_castcade.exe`;
const NUDGE = String.raw`C:\vpx\tables\Nudge Test and Calibration.vpx`;
const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

class FakeTunnel implements TunnelEnd {
  peers: string[] = [];
  playerPort: number | null = null;
  watchPeer: string | null = null;
  closed = false;
  constructor(readonly o: TunnelEndOptions) {}
  setPeers(ids: readonly string[]): void {
    this.peers = [...ids];
  }
  signal(): void {}
  setPlayerPort(port: number | null): void {
    this.playerPort = port;
  }
  async watch(peer: string): Promise<number> {
    this.watchPeer = peer;
    return 50_002;
  }
  stopWatching(): void {
    this.watchPeer = null;
  }
  status(): TunnelEndStatus {
    const peers: TunnelEndStatus['peers'] = {};
    for (const p of this.peers) peers[p] = { path: 'direct', ice: 'connected', pair: 'host -> host udp', rttMs: 1, restarts: 0, channelOpen: true };
    return { peers, watchPort: null, watchPeer: this.watchPeer, playerPort: this.playerPort, stats: { streams: [], opened: 0, refused: 0, framesOut: 0, framesIn: 0, bytesOut: 0, bytesIn: 0, channelStalls: 0, socketStalls: 0 }, pageError: null };
  }
  dropPeer(): void {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

interface Pc {
  host: WatchHost;
  tunnels: FakeTunnel[];
  launches: Array<{ path: string; opts: LaunchOptions }>;
  logs: string[];
  files: Map<string, number>;
  /** I11.4.1: what the witness was told and when the fork was spawned, in order. */
  order: string[];
  last(): WatchStatus;
}

let relay: FakeRelay | null = null;
const pcs: Pc[] = [];
afterEach(async () => {
  for (const p of pcs.splice(0)) await p.host.stop();
  await relay?.close();
  relay = null;
});

function pc(r: FakeRelay, id: 'a' | 'b', o: { paired?: boolean; match?: string | null; fork?: boolean; tables?: KnownTable[] } = {}): Pc {
  const tunnels: FakeTunnel[] = [];
  const launches: Pc['launches'] = [];
  const logs: string[] = [];
  const files = new Map<string, number>([[NUDGE, 4_952_064]]);
  if (o.fork !== false) files.set(FORK, 9_705_472);
  let port = 50_100;
  let last: WatchStatus | null = null;
  const order: string[] = [];
  const launcher: VpxLauncher = {
    async launch(path: string, opts: LaunchOptions = {}): Promise<LaunchResult> {
      launches.push({ path, opts });
      order.push(`spawn ${opts.env?.CASTCADE_STREAM ?? '?'}`);
      return { ok: true, pid: 4000 + launches.length };
    },
  };
  const host = createWatchHost({
    relay: () => (o.paired === false ? null : { baseUrl: r.url, deviceId: `dev-${id}`, deviceToken: `tok-${id}` }),
    me: () => ({ id, name: id === 'a' ? 'Owner' : 'Krobs' }),
    appVersion: 'test',
    log: { info: (l) => logs.push(l), warn: (l) => logs.push(`WARN ${l}`) },
    logsDir: String.raw`C:\logs`,
    vpxExe: () => VPX,
    exists: async (p) => files.has(p),
    size: async (p) => files.get(p) ?? null,
    launcher,
    expectVpx: (e) => {
      order.push(`expect ${e.exe} ${e.tablePath}`);
      return { bind: (pid) => void order.push(`bind ${pid}`), done: () => void order.push('done') };
    },
    tables: async () => o.tables ?? [{ tableId: 'Nudge Test and Calibration', vpxPath: NUDGE, infoName: null, rom: null, sha256: null, imported: false, lastPlayedAt: null, patchedAt: null }],
    iceServers: () => [],
    tunnel: (t) => {
      const f = new FakeTunnel(t);
      tunnels.push(f);
      return f;
    },
    freePort: async () => ++port,
    matchBusy: () => o.match ?? null,
    pageDir: String.raw`C:\userData`,
    session: { welcomeTimeoutMs: 1500, playTimeoutMs: 1500, relayOptions: { connectTimeoutMs: 1500, ackTimeoutMs: 1500 } },
    emitGapMs: 0,
  });
  host.onStatus((s) => (last = s));
  const p: Pc = { host, tunnels, launches, logs, files, order, last: () => last ?? host.status() };
  pcs.push(p);
  return p;
}

describe('watch host words', () => {
  it('says each path plainly', () => {
    expect(pathWords('direct')).toBe('connected directly');
    expect(pathWords('no_path')).toBe('no direct path between your routers');
    expect(pathWords('connecting')).toBe('connecting…');
  });

  it("finds the player's table by file name, the same size first", async () => {
    const t = (vpxPath: string): KnownTable => ({ tableId: 'x', vpxPath, infoName: null, rom: null, sha256: null, imported: true, lastPlayedAt: null, patchedAt: null });
    const sizes = new Map([
      [String.raw`C:\a\Nudge.vpx`, 10],
      [String.raw`C:\b\nudge.VPX`, 20],
    ]);
    const size = async (p: string) => sizes.get(p) ?? null;
    expect(await findWatchTable({ name: 'Nudge.vpx', size: 20 }, [t(String.raw`C:\a\Nudge.vpx`), t(String.raw`C:\b\nudge.VPX`)], size)).toEqual({ path: String.raw`C:\b\nudge.VPX`, size: 20 });
    expect(await findWatchTable({ name: 'Nudge.vpx', size: 99 }, [t(String.raw`C:\a\Nudge.vpx`)], size)).toEqual({ path: String.raw`C:\a\Nudge.vpx`, size: 10 });
    expect(await findWatchTable({ name: 'Other.vpx', size: 1 }, [t(String.raw`C:\a\Nudge.vpx`)], size)).toBeNull();
    expect(watchTableLine({ name: 'N.vpx', size: 1 }, null)).toMatchObject({ warn: true, line: expect.stringContaining('pick your copy') });
    expect(watchTableLine({ name: 'N.vpx', size: 1 }, { path: 'x', size: 2 })).toMatchObject({ warn: true, line: expect.stringContaining('not the same size') });
    expect(watchTableLine({ name: 'N.vpx', size: 1 }, { path: 'x', size: 1 }).warn).toBe(false);
  });
});

describe('the 3D watch session in the shell', () => {
  it('refuses a PC that is not paired, one in a match, and a second session', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    await expect(pc(relay, 'a', { paired: false }).host.host()).rejects.toThrow('pair this PC with ArcAid first');
    await expect(pc(relay, 'a', { match: 'You are in a match' }).host.join('ABCDEF')).rejects.toThrow('You are in a match: leave it first');
    const a = pc(relay, 'a');
    await a.host.host();
    await expect(a.host.host()).rejects.toThrow('Leave this 3D watch session first');
    expect(a.host.active()).toBe(true);
  });

  it('hosts, joins, plays, watches, and swaps who plays when the table closes', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const a = pc(relay, 'a');
    const b = pc(relay, 'b');
    const sa = await a.host.host();
    expect(sa).toMatchObject({ state: 'on', role: 'host' });
    const sb = await b.host.join(sa.code!);
    expect(sb).toMatchObject({ state: 'on', role: 'client', code: sa.code });
    await until(() => a.tunnels[0]!.peers.join() === 'b' && b.tunnels[0]!.peers.join() === 'a');
    await until(() => a.last().members.length === 2);
    expect(a.last().members.map((m) => [m.name, m.line])).toEqual([
      ['Owner', 'this PC'],
      ['Krobs', 'connected directly'],
    ]);
    expect(a.last().fork).toMatchObject({ present: true, path: FORK });

    // The owner plays: the fork, listening on a free loopback port the tunnel feeds from.
    await a.host.play(NUDGE);
    const play = a.launches[0]!;
    expect(play.path).toBe(NUDGE);
    expect(play.opts.exe).toBe(FORK);
    expect(play.opts.env).toEqual({ CASTCADE_STREAM: 'play', CASTCADE_STREAM_ADDR: 'listen:127.0.0.1:50101', CASTCADE_STREAM_LOG: String.raw`C:\logs\vpx-stream-play.log` });
    expect(a.tunnels[0]!.playerPort).toBe(50_101);
    expect(a.last().local).toMatchObject({ vpx: 'playing', table: 'Nudge Test and Calibration.vpx' });

    // Krobs sees it, his copy is found, and Watch starts the fork connecting to the tunnel's listener.
    await until(() => b.last().player?.id === 'a' && b.last().watchTable !== null);
    expect(b.last().player).toMatchObject({ name: 'Owner', me: false, table: 'Nudge Test and Calibration.vpx', size: 4_952_064 });
    expect(b.last().watchTable).toMatchObject({ path: NUDGE, warn: false });
    await expect(b.host.play(NUDGE)).rejects.toThrow('Owner is playing a table now');
    await b.host.watch(null);
    expect(b.tunnels[0]!.watchPeer).toBe('a');
    expect(b.launches.at(-1)!.opts.env).toEqual({
      CASTCADE_STREAM: 'watch',
      CASTCADE_STREAM_ADDR: 'connect:127.0.0.1:50002',
      CASTCADE_STREAM_DELAY_MS: '100',
      CASTCADE_STREAM_SOUND: '1',
      CASTCADE_STREAM_LOG: String.raw`C:\logs\vpx-stream-watch.log`,
    });
    expect(b.last().local.vpx).toBe('watching');
    // The witness was told of the watcher before the spawn (and given its pid after); of the player, never.
    expect(b.order).toEqual([`expect ${FORK} ${NUDGE}`, 'spawn watch', 'bind 4001']);
    expect(a.order).toEqual(['spawn play']);

    // The owner's table closes: the role is free; Krobs closes his watcher and plays; the owner watches.
    play.opts.onExit!(0);
    await until(() => b.last().player === null && a.last().player === null);
    expect(a.tunnels[0]!.playerPort).toBeNull();
    await expect(b.host.play(NUDGE)).rejects.toThrow('Close the table you are watching first');
    b.launches.at(-1)!.opts.onExit!(0);
    expect(b.order.at(-1)).toBe('done');
    expect(b.tunnels[0]!.watchPeer).toBeNull();
    await b.host.play(NUDGE);
    await until(() => a.last().player?.id === 'b' && a.last().watchTable?.path === NUDGE);
    await a.host.watch(null);
    expect(a.tunnels[0]!.watchPeer).toBe('b');
  });

  it("says where the fork goes when it is missing, and a table that is not here or differs", async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const a = pc(relay, 'a', { fork: false });
    const b = pc(relay, 'b', { tables: [] });
    const code = (await a.host.host()).code!;
    expect(a.last().fork.present).toBe(false);
    expect(a.last().fork.line).toContain(String.raw`copy it into C:\vpx, next to VPinballX_GL64.exe`);
    await expect(a.host.play(NUDGE)).rejects.toThrow('is not beside your VPX');
    // The role went back: nobody plays.
    expect(a.host.status().player).toBeNull();
    await b.host.join(code);
    a.files.set(FORK, 1);
    await a.host.play(NUDGE);
    await until(() => b.last().watchTable !== null);
    expect(b.last().watchTable).toMatchObject({ path: null, warn: true });
    await expect(b.host.watch(null)).rejects.toThrow('is not in your tables: pick your copy');
    // The picked file: a different size is allowed (the fork itself refuses a table whose parts differ).
    const other = String.raw`D:\mine\Nudge Test and Calibration.vpx`;
    b.files.set(other, 123);
    await b.host.watch(other);
    expect(b.launches.at(-1)!.path).toBe(other);
  });

  it('leaving leaves the VPX open and the session off; the host leaving ends it for the others', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const a = pc(relay, 'a');
    const b = pc(relay, 'b');
    const code = (await a.host.host()).code!;
    await b.host.join(code);
    await b.host.play(NUDGE);
    await a.host.leave();
    expect(a.host.status()).toMatchObject({ state: 'off', code: null, members: [] });
    expect(a.tunnels[0]!.closed).toBe(true);
    await until(() => b.last().state === 'ended');
    expect(b.last().ended).toBe('the host ended the session');
    expect(b.last().local.vpx).toBe('playing');
    expect(b.logs.some((l) => l.includes('is left open'))).toBe(true);
    expect(b.host.active()).toBe(false);
  });
});
