/**
 * I11.4.2: the state stream's shell (`stream3d-host.ts`) with the real control listener on loopback, a scripted
 * control client standing in for the VPX fork, and tunnel ends from `stream3d.test-support.ts`: fakes joined by a hub
 * for most, and for the last group the real `TunnelBridge` over real loopback sockets. The launch (§4.4) and whether a
 * start took, two PCs watching each other by turns, the lock that waits for `state playing`, what the control
 * connection does when the fork misbehaves, never connects, speaks another version, or goes away, who may take the
 * control connection, and when the tunnel is opened at all.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameFingerprint, ParticipantInfo } from '@castcade/protocol';
import { createVpxLauncher } from '../launch/vpx-launch.js';
import { ClientMatch } from '../match/client.js';
import { ManualClock } from '../match/clock.js';
import { HostMatch } from '../match/host.js';
import { generateKeys, type KeyPair } from '../match/keys.js';
import { MemoryBus } from '../match/transport.js';
import type { MediaSignal } from '../media/match-media-types.js';
import { splitSignalling } from '../media/rtc-signaling.js';
import { matchSignalling } from './match-setup.js';
import type { TunnelEnd, TunnelEndOptions } from '../watch/tunnel-end.js';
import { CONTROL_BYTES_MAX, PENDING_MAX, createStream3dHost, type MatchStream3d, type Stream3dHost } from './stream3d-host.js';
import { BridgeHub, ScriptedFork, StreamListener, TunnelHub, until, type BridgeTunnel, type FakeTunnel } from './stream3d.test-support.js';

const VPX = String.raw`C:\vpx\VPinballX_GL64.exe`;
const FORK = String.raw`C:\vpx\VPinballX_GL64_castcade.exe`;
const NAMES: Record<string, string> = { a: 'Owner', b: 'Krobs', c: 'Chuck' };
/** The port each PC's fork says its stream listener is bound to (rule 9), when the test opens no real one. */
const STREAM: Record<string, number> = { a: 50_101, b: 50_102, c: 50_103 };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Pc {
  id: string;
  host: Stream3dHost;
  logs: string[];
  saved: { text: string | null };
  tunnel(): FakeTunnel;
}

const hosts: Stream3dHost[] = [];
const forks: ScriptedFork[] = [];
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of forks.splice(0)) f.close();
  for (const h of hosts.splice(0)) await h.stop();
  for (const c of closers.splice(0)) await c();
});

interface PcOptions {
  fork?: boolean;
  vpx?: string | null;
  saved?: { text: string | null };
  ports?: { read(): string | null; write(text: string): void };
  tunnel?: (o: TunnelEndOptions) => TunnelEnd;
  watchTimeoutMs?: number;
  playWaitMs?: number;
  helloWaitMs?: number;
  forkStartMs?: number;
  forkHelloWaitMs?: number;
}

function pc(hub: TunnelHub, id: string, o: PcOptions = {}): Pc {
  const logs: string[] = [];
  const saved = o.saved ?? { text: null };
  let port = id.charCodeAt(0) * 100;
  const host = createStream3dHost({
    log: { info: (l) => void logs.push(l), warn: (l) => void logs.push(`WARN ${l}`) },
    logsDir: String.raw`C:\logs`,
    pageDir: String.raw`C:\userData`,
    vpxExe: () => (o.vpx === undefined ? VPX : o.vpx),
    exists: async (p) => p === VPX || (p === FORK && o.fork !== false),
    iceServers: () => [],
    tunnel: o.tunnel ?? ((t) => hub.make(t)),
    freePort: async () => ++port,
    ports: o.ports ?? { read: () => saved.text, write: (t) => void (saved.text = t) },
    ...(o.watchTimeoutMs !== undefined ? { watchTimeoutMs: o.watchTimeoutMs } : {}),
    ...(o.playWaitMs !== undefined ? { playWaitMs: o.playWaitMs } : {}),
    ...(o.helloWaitMs !== undefined ? { helloWaitMs: o.helloWaitMs } : {}),
    ...(o.forkStartMs !== undefined ? { forkStartMs: o.forkStartMs } : {}),
    ...(o.forkHelloWaitMs !== undefined ? { forkHelloWaitMs: o.forkHelloWaitMs } : {}),
  });
  hosts.push(host);
  return { id, host, logs, saved, tunnel: () => hub.all.filter((t) => t.id === id).at(-1) as FakeTunnel };
}

/** A socket on `p`'s control port that has said nothing yet. */
async function socketTo(p: { host: Stream3dHost }): Promise<ScriptedFork> {
  const f = await ScriptedFork.connect(await p.host.controlPort());
  forks.push(f);
  return f;
}

/** The fork of `p`'s table: connected to its control port and through its hello. */
async function forkOf(p: { id: string; host: Stream3dHost }, table?: string, streamPort = STREAM[p.id] ?? 50_199): Promise<ScriptedFork> {
  const f = await socketTo(p);
  f.hello(table, undefined, streamPort);
  return f;
}

/** A match of these PCs: each one's stream opened, signalled to the others as the match's `stream` channel would. */
function match(pcs: Array<{ id: string; host: Stream3dHost }>, setting: Record<string, 'auto' | 'off'> = {}): Record<string, MatchStream3d> {
  const streams: Record<string, MatchStream3d> = {};
  for (const p of pcs) {
    streams[p.id] = p.host.open({
      localId: p.id,
      setting: setting[p.id] ?? 'auto',
      // As the match does: the signal goes out marked `channel: 'stream'` and arrives so.
      sendSignal: (to: string, s: MediaSignal) => void queueMicrotask(() => streams[to]?.signal(p.id, { ...s, channel: 'stream' })),
    });
  }
  for (const p of pcs) streams[p.id]!.setPeers(pcs.filter((x) => x.id !== p.id).map((x) => ({ id: x.id, name: NAMES[x.id] ?? x.id })));
  return streams;
}

const lineOf = (s: MatchStream3d, id: string): string => s.status().players.find((p) => p.id === id)?.line ?? '';

describe('the launch of a match table (§4.4)', () => {
  it('in the fork, with role match, the two loopback addresses, no sound replay, the delay and a log in the logs folder', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const launch = await a.host.launch('auto');
    const control = await a.host.controlPort();
    expect(launch?.options).toMatchObject({
      exe: FORK,
      env: {
        CASTCADE_STREAM: 'match',
        CASTCADE_STREAM_ADDR: 'listen:127.0.0.1:9701',
        CASTCADE_STREAM_CONTROL: `connect:127.0.0.1:${control}`,
        CASTCADE_STREAM_SOUND: '0',
        CASTCADE_STREAM_DELAY_MS: '100',
        CASTCADE_STREAM_LOG: String.raw`C:\logs\vpx-stream-match.log`,
      },
      what: 'for the match, in the Castcade VPX build',
    });
    expect(Object.keys(launch!.options.env!).sort()).toEqual(['CASTCADE_STREAM', 'CASTCADE_STREAM_ADDR', 'CASTCADE_STREAM_CONTROL', 'CASTCADE_STREAM_DELAY_MS', 'CASTCADE_STREAM_LOG', 'CASTCADE_STREAM_SOUND']);
    // Only the control port is kept: the stream port is the fork's to say (rule 9).
    expect(JSON.parse(a.saved.text!)).toEqual({ controlPort: control });
    expect(a.logs).toContain(`stream3d: the match table starts in the Castcade VPX build (${FORK}): asked to stream on 127.0.0.1:9701, control on 127.0.0.1:${control}`);
    launch!.options.onExit?.(0);
    expect(a.logs.at(-1)).toBe("stream3d: the match table's VPX closed (exit 0)");
  });

  it('exactly as before (null) when the setting is off, when Castcade knows no VPX, and when the fork is not beside it', async () => {
    const hub = new TunnelHub();
    const off = pc(hub, 'a');
    expect(await off.host.launch('off')).toBeNull();
    expect(off.logs).toContain('stream3d: 3D watch is turned off on this PC: the match table starts in your own VPX (the 2D video)');
    expect(off.saved.text).toBeNull();
    expect(await pc(hub, 'b', { vpx: null }).host.launch('auto')).toBeNull();
    const none = pc(hub, 'c', { fork: false });
    expect(await none.host.launch('auto')).toBeNull();
    expect(none.logs).toContain(String.raw`stream3d: the Castcade VPX build (VPinballX_GL64_castcade.exe) is not in C:\vpx: the match table starts in your own VPX (the 2D video)`);
  });

  it('rule 9 (review A4): the port picked at launch is offered to nobody; the others are served the port the hello names', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    // The table of the last match is still open (stream port 50101) when Castcade starts another table for this one:
    // the launch picks 9701, and the VPX that is on the control connection is still the old one.
    const old = await forkOf(a, undefined, 50_101);
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.b!, 'a') === 'Owner: 3D, on your own table');
    expect(a.tunnel().playerPort).toBe(50_101);
    await a.host.launch('auto');
    await sleep(30);
    expect(a.tunnel().playerPort).toBe(50_101);
    // The new table's VPX comes up on a port of its own (not even the one it was asked for): that is the one served.
    await forkOf(a, undefined, 61_234);
    await until(() => old.closed);
    await until(() => a.tunnel().playerPort === 61_234);
    expect(a.logs.some((l) => l.includes('9701') && !l.includes('asked to stream'))).toBe(false);
  });

  it('A1: a start that fails after the spawn (an error from the system, an exe that ends at once) is said: didNotStart', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a', { forkStartMs: 80 });
    // The launcher calls onExit for the `error` event too (null), a moment after `launch` answered ok.
    const failed = await a.host.launch('auto');
    setTimeout(() => failed!.options.onExit?.(null), 10);
    expect(await failed!.didNotStart).toBe(true);
    // An exe that runs for a moment and ends, without its VPX ever reaching the control port.
    const died = await a.host.launch('auto');
    setTimeout(() => died!.options.onExit?.(3221225781), 30);
    expect(await died!.didNotStart).toBe(true);
  });

  it('A1: a VPX that says hello started; so did one that is still there after the first seconds; closing it later is not a failed start', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a', { forkStartMs: 80 });
    const up = await a.host.launch('auto');
    let said: boolean | null = null;
    void up!.didNotStart.then((v) => (said = v));
    await forkOf(a);
    await until(() => said !== null);
    expect(said).toBe(false);
    up!.options.onExit?.(0);
    expect(await up!.didNotStart).toBe(false);
    // A table that takes a minute to load: no hello yet, the process is there.
    const slow = await a.host.launch('auto');
    const t0 = Date.now();
    expect(await slow!.didNotStart).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    slow!.options.onExit?.(0);
    expect(await slow!.didNotStart).toBe(false);
  });
});

describe('a launch and the wait of the first start (I11.4.9)', () => {
  it('a table started in the fork is waited for from the launch; a launch that made no process (`notStarted`), or a process that ended, is not, at once', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    const s = match([a, b]);
    s.a!.setStartGate(true);
    expect(s.a!.startWait().pending).toBe(false);
    // The launcher answers ok:false (the exe or the table file is gone, the spawn threw): `onExit` never comes.
    const gone = await a.host.launch('auto');
    expect(s.a!.startWait()).toEqual({ pending: true, until: null, why: 'fork', waitingFor: [] });
    gone!.notStarted!();
    expect(s.a!.startWait().pending).toBe(false);
    expect(await gone!.didNotStart).toBe(true);
    expect(a.logs).toContain("stream3d: the match's start no longer waits for this PC: the Castcade VPX build is not coming (it ended, or did not start)");
    // The table then opens in the player's own VPX: still not waited for (it was 45 s before this fix).
    s.a!.setTableOpen(true);
    expect(s.a!.startWait().pending).toBe(false);
    // A process that was made and ended says so through its exit.
    const ended = await a.host.launch('auto');
    expect(s.a!.startWait().pending).toBe(true);
    ended!.options.onExit!(1);
    expect(s.a!.startWait().pending).toBe(false);
  });
});

describe('what the view says of the fork, and a build that never connects (I11.4.12, I11.4.13)', () => {
  it('the view says whether the Castcade VPX build is beside VPX at all, and whether a table started in it is still expected', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const c = pc(hub, 'c', { fork: false });
    const s = match([a, c]);
    await until(() => s.a!.status().forkInstalled === true && s.c!.status().forkInstalled === false, 2000, 'the look for the fork exe');
    expect(s.a!.status()).toMatchObject({ fork: 'none', expecting: false, forkSilent: false });
    await a.host.launch('auto');
    expect(s.a!.status().expecting).toBe(true);
    // Its VPX connects: on the control connection, nothing expected any more.
    const f = await forkOf(a);
    f.say('state playing');
    await until(() => s.a!.status().fork === 'ready', 2000, 'the fork ready');
    expect(s.a!.status().expecting).toBe(false);
  });

  it('a build that did not connect within its limit is remembered for the run: the next start in it is not waited for, and the log says so; its first hello forgets it', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a', { forkHelloWaitMs: 60 });
    const b = pc(hub, 'b');
    let s = match([a, b]);
    s.a!.setStartGate(true);
    await a.host.launch('auto');
    s.a!.setTableOpen(true);
    expect(s.a!.startWait()).toMatchObject({ pending: true, why: 'fork' });
    await until(() => s.a!.status().forkSilent, 2000, 'the limit');
    expect(s.a!.startWait().pending).toBe(false);
    expect(a.logs).toContain('stream3d: the Castcade VPX build that was started has not connected; for the rest of this run a match start does not wait for it (it counts again the moment it connects)');
    // The next match of this run, the same build: started in it all the same, and not waited for.
    s = match([a, b]);
    s.a!.setStartGate(true);
    expect(await a.host.launch('auto')).not.toBeNull();
    s.a!.setTableOpen(true);
    expect(s.a!.startWait().pending).toBe(false);
    expect(s.a!.status()).toMatchObject({ expecting: false, forkSilent: true });
    expect(a.logs).toContain('stream3d: this Castcade VPX build did not connect the last time it was started in this run (a build from before the 3D watch in a match): the start does not wait for it');
    // It connects after all (a table that only loaded slowly): it counts again from here on.
    const f = await forkOf(a);
    f.say('state playing');
    await until(() => s.a!.status().fork === 'ready' && !s.a!.status().forkSilent, 2000, 'the hello');
    f.close();
    await until(() => s.a!.status().fork === 'none', 2000, 'the fork gone');
    s = match([a, b]);
    s.a!.setStartGate(true);
    await a.host.launch('auto');
    expect(s.a!.startWait()).toMatchObject({ pending: true, why: 'fork' });
  });
});

describe('A1, the whole chain: the real launcher with a start that fails after spawn() returned', () => {
  const TABLE = String.raw`C:\vpx\tables\Monster Bash.vpx`;
  /** `spawn` as Node's: it returns a child at once; a start failure arrives as an `error` event a moment later. */
  const launcherWith = (fate: 'error' | 'dies' | 'runs') => {
    const spawned: string[] = [];
    const logs: string[] = [];
    const launcher = createVpxLauncher({
      spawn: (command) => {
        spawned.push(command);
        const on: Record<string, (x: never) => void> = {};
        const child = { pid: fate === 'error' ? undefined : 4321, unref: () => undefined, on: (ev: string, cb: (x: never) => void) => ((on[ev] = cb), child) };
        if (command === FORK && fate === 'error') setTimeout(() => on.error?.(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) as never), 5);
        if (command === FORK && fate === 'dies') setTimeout(() => on.exit?.(1 as never), 15);
        return child;
      },
      exists: async () => true,
      exe: () => VPX,
      log: (l) => void logs.push(l),
    });
    return { launcher, spawned, logs };
  };

  it('EACCES from the system: the launcher said ok (the process was spawned), and the start is still known to have failed', async () => {
    const a = pc(new TunnelHub(), 'a', { forkStartMs: 2000 });
    const { launcher, spawned, logs } = launcherWith('error');
    const fork = await a.host.launch('auto');
    // What the old fall-back looked at, and why it could not fire: ok, although nothing started.
    expect(await launcher.launch(TABLE, fork!.options)).toEqual({ ok: true, pid: null });
    expect(await fork!.didNotStart).toBe(true);
    expect(spawned).toEqual([FORK]);
    expect(logs).toContain('launch: VPX did not start: spawn EACCES');
  });

  it('an exe that ends at once, its VPX never on the control port: failed; one that runs: not', async () => {
    const a = pc(new TunnelHub(), 'a', { forkStartMs: 120 });
    const dies = launcherWith('dies');
    const d = await a.host.launch('auto');
    expect(await dies.launcher.launch(TABLE, d!.options)).toEqual({ ok: true, pid: 4321 });
    expect(await d!.didNotStart).toBe(true);
    const runs = launcherWith('runs');
    const r = await a.host.launch('auto');
    await runs.launcher.launch(TABLE, r!.options);
    expect(await r!.didNotStart).toBe(false);
  });
});

describe('two PCs in a match, both with the fork on the same table', () => {
  it('the capability crosses the tunnel, each shows the other in 3D; the turn sends watch and play; the lock waits for state playing', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    const fa = await forkOf(a);
    const fb = await forkOf(b);
    const s = match([a, b]);
    // The data connection was signalled through the owner (the match's `stream` channel) and stripped of its channel
    // on the way in: the tunnel's page takes a plain signal.
    await until(() => hub.open('a', 'b'));
    expect(b.tunnel().signalsIn[0]).toEqual(['a', { kind: 'offer', sdp: 'v=0 data a->b' }]);
    expect(a.tunnel().signalsIn[0]).toEqual(['b', { kind: 'answer', sdp: 'v=0 data b->a' }]);
    await until(() => lineOf(s.a!, 'b') === 'Krobs: 3D, on your own table' && lineOf(s.b!, 'a') === 'Owner: 3D, on your own table');
    expect(s.a!.status()).toMatchObject({ setting: 'auto', fork: 'ready', build: '10.8.0.2078.castcade', watching: null, players: [{ id: 'b', name: 'Krobs', mode: '3d' }] });
    // Each tunnel serves its own fork's stream to the other, on the port that fork's hello named.
    expect(a.tunnel().playerPort).toBe(STREAM.a);
    expect(b.tunnel().playerPort).toBe(STREAM.b);
    expect(a.tunnel().o.logTag).toBe('stream3d');

    // The lobby: nobody is sent anywhere.
    expect(fa.got).toEqual([]);
    expect(fb.got).toEqual([]);

    // a is up: b's fork is sent to the tunnel listener aimed at a; a's fork is told nothing.
    s.a!.setTarget(null);
    s.b!.setTarget('a', '1');
    expect(s.b!.showing3d()).toBe(true);
    await fb.next(`watch 127.0.0.1:${b.tunnel().watchPort}`);
    expect(b.tunnel().watched).toEqual(['a']);
    fb.say('state watching');
    await until(() => s.b!.status().watching === 'a');
    expect(fa.got).toEqual([]);

    // b's turn: its table is to be unlocked (the grant), then the shell names nobody; the lock waits for the fork.
    expect(s.b!.away()).toBe(true);
    const unlocked: boolean[] = [];
    s.b!.whenPlaying((late) => void unlocked.push(late));
    s.b!.setTarget(null);
    s.a!.setTarget('b', '2');
    await fb.next('play');
    await fa.next(`watch 127.0.0.1:${a.tunnel().watchPort}`);
    expect(unlocked).toEqual([]);
    fb.say('state playing');
    await until(() => unlocked.length === 1);
    expect(unlocked).toEqual([false]);
    expect(s.b!.away()).toBe(false);
    fa.say('state watching');
    await until(() => s.a!.status().watching === 'b');
    expect(s.b!.showing3d()).toBe(false);

    // The match ends on a while it watches: its fork is called back, its tunnel closes, b knows nothing of a any more.
    await s.a!.close();
    await fa.next('play');
    expect(a.tunnel().closed).toBe(true);
    await until(() => lineOf(s.b!, 'a') === 'Owner: the 2D video (the 3D connection to their PC is not up yet)');
  });

  it('the lock is lifted after the 2 s limit when the fork does not answer the play', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a', { playWaitMs: 80 });
    const b = pc(hub, 'b');
    const fa = await forkOf(a);
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b').endsWith('3D, on your own table'));
    s.a!.setTarget('b', '1');
    await fa.next(/^watch /);
    fa.say('state watching');
    await until(() => s.a!.status().watching === 'b');
    const unlocked: boolean[] = [];
    const t0 = Date.now();
    s.a!.whenPlaying((late) => void unlocked.push(late));
    s.a!.setTarget(null);
    await fa.next('play');
    await until(() => unlocked.length === 1);
    expect(unlocked).toEqual([true]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(a.logs.some((l) => l.startsWith('stream3d: VPX has not said "state playing"') && l.endsWith('the table is unlocked anyway'))).toBe(true);
  });

  it('another table file on the other PC: the 2D video, and nobody is sent to watch', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    const fa = await forkOf(a);
    const fb = await forkOf(b, '615 00000000deadbeef');
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b') === 'Krobs: the 2D video (theirs is another table file)' && lineOf(s.b!, 'a') === 'Owner: the 2D video (theirs is another table file)');
    s.a!.setTarget('b', '1');
    s.b!.setTarget(null);
    await sleep(60);
    expect(fa.got).toEqual([]);
    expect(fb.got).toEqual([]);
    expect(s.a!.showing3d()).toBe(false);
    expect(a.tunnel().watched).toEqual([]);
    expect(a.logs).toContain('stream3d: Krobs: this PC shows the 2D video (theirs is another table file)');
  });
});

describe('the fail-safes, over the real control connection', () => {
  const pair = async (o: { watchTimeoutMs?: number } = {}) => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a', o);
    const b = pc(hub, 'b');
    const fa = await forkOf(a);
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b').endsWith('3D, on your own table'));
    return { hub, a, b, fa, s };
  };

  it('state failed: the theater is back (no 3D shown) and the line says why; a new grant to the same player tries again (A5)', async () => {
    const { a, fa, s } = await pair();
    s.a!.setTarget('b', '4');
    await fa.next(/^watch /);
    expect(s.a!.showing3d()).toBe(true);
    fa.say('state failed refused: not the same table', 'state playing');
    await until(() => !s.a!.showing3d());
    expect(lineOf(s.a!, 'b')).toBe('Krobs: the 2D video this turn (3D did not start: refused: not the same table)');
    // No play went out: the fork is back by itself.
    expect(fa.got.filter((l) => l === 'play')).toEqual([]);
    expect(a.logs).toContain('stream3d: 3D watch of Krobs did not work (refused: not the same table); the 2D video serves this turn');
    // b shoots again: the same player under a new grant.
    await sleep(30);
    s.a!.setTarget('b', '5');
    await until(() => fa.got.filter((l) => l.startsWith('watch ')).length === 2);
    expect(s.a!.showing3d()).toBe(true);
  });

  it('no state watching within the time: play, and the 2D video', async () => {
    const { fa, s } = await pair({ watchTimeoutMs: 60 });
    s.a!.setTarget('b', '1');
    await fa.next(/^watch /);
    await fa.next('play');
    expect(s.a!.showing3d()).toBe(false);
    expect(lineOf(s.a!, 'b')).toMatch(/^Krobs: the 2D video this turn \(3D did not start: VPX did not show their table within/);
  });

  it('rule 12: state failed stalled in the middle of a watch: 2D at once, no play sent', async () => {
    const { fa, s } = await pair();
    s.a!.setTarget('b', '1');
    await fa.next(/^watch /);
    fa.say('state watching');
    await until(() => s.a!.status().watching === 'b');
    fa.say('state failed stalled', 'state playing');
    await until(() => !s.a!.showing3d() && !s.a!.away());
    expect(lineOf(s.a!, 'b')).toBe('Krobs: the 2D video this turn (3D did not start: stalled)');
    expect(fa.got.filter((l) => l === 'play')).toEqual([]);
  });

  it('the control connection lost in the middle of a watch: the 2D video at once; the fork that reconnects serves the next turn', async () => {
    const { a, fa, s } = await pair();
    s.a!.setTarget('b', '1');
    await fa.next(/^watch /);
    fa.say('state watching');
    await until(() => s.a!.status().watching === 'b');
    const unlocked: boolean[] = [];
    s.a!.whenPlaying((late) => void unlocked.push(late));
    fa.close();
    await until(() => s.a!.status().fork === 'none');
    expect(s.a!.showing3d()).toBe(false);
    expect(unlocked).toEqual([false]);
    expect(lineOf(s.a!, 'b')).toBe('Krobs: the 2D video this turn (3D did not start: the control connection to VPX was lost)');
    expect(a.tunnel().playerPort).toBeNull();
    // The fork's own retry, 2 s later.
    const again = await forkOf(a);
    await until(() => s.a!.status().fork === 'ready');
    expect(again.got).toEqual([]);
    s.a!.setTarget(null);
    s.a!.setTarget('b', '2');
    await again.next(/^watch /);
    expect(a.tunnel().playerPort).toBe(STREAM.a);
  });

  it('the fork never connects: this PC shows 2D and says so, and the other PC is told there is no build here', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    await a.host.launch('auto'); // started in the fork, but an older build: no control connection ever comes
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.b!, 'a') === 'Owner: the 2D video (no Castcade VPX build runs the table on their PC)');
    expect(s.a!.status()).toMatchObject({ fork: 'none', watching: null });
    expect(lineOf(s.a!, 'b')).toBe('Krobs: the 2D video (no Castcade VPX build runs the table on this PC)');
    s.a!.setTarget('b', '1');
    s.b!.setTarget('a', '2');
    await sleep(60);
    expect(s.a!.showing3d()).toBe(false);
    expect(s.b!.showing3d()).toBe(false);
    expect(a.tunnel().watched).toEqual([]);
    expect(b.tunnel().watched).toEqual([]);
    // No port is offered for a table whose VPX never said where it listens.
    expect(a.tunnel().playerPort).toBeNull();
    // Nothing waits for a fork that is not there.
    const unlocked: boolean[] = [];
    s.a!.whenPlaying((late) => void unlocked.push(late));
    expect(unlocked).toEqual([false]);
  });

  it('hello with another version: no 3D on this PC, the log says why, the fork is told nothing', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    const fa = await socketTo(a);
    fa.say('hello 2 10.9.0.1.castcade 617 9f3a61c2d4e5b701 50101 and-more', 'state playing');
    await forkOf(b);
    const s = match([a, b]);
    await until(() => s.a!.status().fork === 'version');
    await until(() => lineOf(s.b!, 'a') === 'Owner: the 2D video (no Castcade VPX build runs the table on their PC)');
    expect(lineOf(s.a!, 'b')).toBe('Krobs: the 2D video (the Castcade VPX build on this PC and this Castcade are different versions: update both)');
    s.a!.setTarget('b', '1');
    await sleep(60);
    expect(fa.got).toEqual([]);
    expect(a.logs).toContain('stream3d: VPX speaks version 2 of the control connection and this Castcade version 1: no 3D on this PC until both are updated; the 2D video serves');
  });

  it('a hello of the first draft (four fields, no stream port) is not a hello: the connection is closed and nothing is served', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    const f = await socketTo(a);
    f.say('hello 1 10.8.0.2078.castcade 617 9f3a61c2d4e5b701', 'state playing');
    await until(() => f.closed);
    expect(s.status().fork).toBe('none');
    expect(a.tunnel().playerPort).toBeNull();
    expect(a.logs).toContain('stream3d: a connection to the control port did not begin with hello and was closed');
  });
});

describe('the control connection as a socket', () => {
  it('lines arrive whole whatever the writes: in pieces, two at once, with a carriage return', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    const f = await socketTo(a);
    f.raw('hel');
    await sleep(20);
    expect(s.status().fork).toBe('none');
    f.raw('lo 1 10.8.0.2078.castcade 617 9f3a61c2d4e5b701 50101\r\nstate playing\r\n');
    await until(() => s.status().fork === 'ready');
    expect(s.status().build).toBe('10.8.0.2078.castcade');
  });

  it('a line that never ends closes the connection; the fork connects again and is taken', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    const f = await forkOf(a);
    await until(() => s.status().fork === 'ready');
    f.raw('x'.repeat(CONTROL_BYTES_MAX + 1));
    await until(() => f.closed);
    await until(() => s.status().fork === 'none');
    expect(a.logs.some((l) => l.includes(`a line over ${CONTROL_BYTES_MAX} bytes`))).toBe(true);
    await forkOf(a);
    await until(() => s.status().fork === 'ready');
  });

  it('a table left open serves the next match: the fork stays on the control port, and the new match is told about it', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    const fa = await forkOf(a);
    await forkOf(b);
    const first = match([a, b]);
    await until(() => lineOf(first.a!, 'b').endsWith('3D, on your own table'));
    await first.a!.close();
    await first.b!.close();
    expect(fa.closed).toBe(false);
    const second = match([a, b]);
    await until(() => lineOf(second.a!, 'b') === 'Krobs: 3D, on your own table' && lineOf(second.b!, 'a') === 'Owner: 3D, on your own table');
    expect(a.tunnel().playerPort).toBe(STREAM.a);
    // The first match's handle is dead: it shows and waits for nothing.
    expect(first.a!.showing3d()).toBe(false);
    const calls: boolean[] = [];
    first.a!.whenPlaying((late) => void calls.push(late));
    expect(calls).toEqual([false]);
  });

  it('Castcade restarted under an open table: the same control port again, and the fork that comes back says its own stream port', async () => {
    const hub = new TunnelHub();
    // A ports file of the first build of this feature also named a stream port: it is not read any more.
    const saved = { text: null as string | null };
    const before = pc(hub, 'a', { saved });
    await before.host.launch('auto');
    const port = await before.host.controlPort();
    saved.text = JSON.stringify({ controlPort: port, streamPort: 9701 });
    const f1 = await forkOf(before, undefined, 50_555);
    await before.host.stop();
    await until(() => f1.closed);
    // The next run of Castcade: the ports file names the control port the open table still tries every 2 s.
    const after = pc(hub, 'a', { saved });
    const s = after.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    expect(await after.host.controlPort()).toBe(port);
    expect(after.tunnel().playerPort).toBeNull();
    await forkOf(after, undefined, 50_555);
    await until(() => s.status().fork === 'ready');
    expect(after.tunnel().playerPort).toBe(50_555);
    expect(after.logs.some((l) => l.includes('the same as in the last run'))).toBe(true);
  });
});

describe('who may take the control connection (A3)', () => {
  /** a watches b in 3D, its fork on the control connection. */
  const watching = async (o: PcOptions = {}) => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a', o);
    const b = pc(hub, 'b');
    const fa = await forkOf(a);
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b').endsWith('3D, on your own table'));
    s.a!.setTarget('b', '1');
    await fa.next(/^watch /);
    fa.say('state watching');
    await until(() => s.a!.status().watching === 'b');
    return { hub, a, b, fa, s };
  };

  it('a stray connection that says nothing, or something that is not hello, does not end a 3D watch', async () => {
    const { a, fa, s } = await watching({ helloWaitMs: 60 });
    // Anything on this PC can connect to a loopback port.
    const silent = await socketTo(a);
    const junk = await socketTo(a);
    junk.say('GET / HTTP/1.1');
    const state = await socketTo(a);
    state.say('state playing');
    await until(() => junk.closed && state.closed && silent.closed);
    expect(fa.closed).toBe(false);
    expect(s.a!.status()).toMatchObject({ fork: 'ready', watching: 'b' });
    expect(s.a!.showing3d()).toBe(true);
    expect(fa.got.filter((l) => l === 'play')).toEqual([]);
    expect(a.logs).toContain('stream3d: a connection to the control port did not begin with hello and was closed');
    expect(a.logs).toContain('stream3d: a connection to the control port said nothing for 0.06 s and was closed');
    // The fork on the connection is still the one that is talked to.
    s.a!.setTarget(null);
    await fa.next('play');
  });

  it('a second VPX wins only with its hello; the one it replaced is turned away for as long as the newer one lives, and comes back after', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    const first = await forkOf(a, undefined, 50_101);
    await until(() => s.status().fork === 'ready');
    // A second table is started while the first is still open.
    const second = await socketTo(a);
    await sleep(30);
    expect(first.closed).toBe(false);
    expect(a.tunnel().playerPort).toBe(50_101);
    second.hello('700 1111111111111111', undefined, 50_777);
    await until(() => first.closed);
    await until(() => a.tunnel().playerPort === 50_777);
    expect(a.logs.some((l) => l.includes('table 700 1111111111111111'))).toBe(true);
    // The first fork retries every 2 s, for ever: it does not get the connection back, and the second keeps it.
    for (let i = 0; i < 3; i++) {
      const retry = await forkOf(a, undefined, 50_101);
      await until(() => retry.closed);
    }
    expect(second.closed).toBe(false);
    expect(s.status().fork).toBe('ready');
    expect(a.tunnel().playerPort).toBe(50_777);
    // Said once, not every 2 s.
    expect(a.logs.filter((l) => l.includes('tried again; the newer one stays'))).toHaveLength(1);
    // The second table is closed: the first, still open, is taken at its next try.
    second.close();
    await until(() => s.status().fork === 'none');
    const back = await forkOf(a, undefined, 50_101);
    await until(() => s.status().fork === 'ready' && a.tunnel().playerPort === 50_101);
    expect(back.closed).toBe(false);
  });

  it('the same VPX connecting again before its old connection is seen closed (a line too long made it reconnect): it takes over each time, and is never turned away as "the one that was replaced"', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    const first = await forkOf(a, undefined, 50_101);
    await until(() => s.status().fork === 'ready');
    // Its second connection says hello while the first is still open here (the two closes and opens are not ordered).
    const second = await forkOf(a, undefined, 50_101);
    await until(() => first.closed);
    await until(() => s.status().fork === 'ready');
    expect(second.closed).toBe(false);
    // And a third: the second is still the one "on the connection" when it arrives.
    const third = await forkOf(a, undefined, 50_101);
    await until(() => second.closed);
    await sleep(40);
    expect(third.closed).toBe(false);
    expect(s.status().fork).toBe('ready');
    expect(a.tunnel().playerPort).toBe(50_101);
    expect(a.logs.filter((l) => l.includes('tried again; the newer one stays'))).toEqual([]);
    expect(a.logs.filter((l) => l.includes('connected again (stream port 50101)'))).toHaveLength(2);
  });

  it('hello with stream port 0: that PC watches in 3D, serves no port, and the other PC is told there is nothing to watch', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    const fa = await forkOf(a, undefined, 0);
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b') === 'Krobs: 3D, on your own table' && lineOf(s.b!, 'a') === 'Owner: the 2D video (no Castcade VPX build runs the table on their PC)');
    expect(fa.closed).toBe(false);
    expect(a.tunnel().playerPort).toBeNull();
    s.a!.setTarget('b', '1');
    await fa.next(/^watch /);
  });

  it('a second VPX this Castcade cannot talk to (another version) does not take the place of one it can', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    const good = await forkOf(a);
    await until(() => s.status().fork === 'ready');
    const other = await socketTo(a);
    other.say('hello 2 something else entirely');
    await until(() => other.closed);
    expect(good.closed).toBe(false);
    expect(s.status().fork).toBe('ready');
  });

  it('connections that never say hello are bounded: one more closes the oldest', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    await a.host.controlPort();
    const silent: ScriptedFork[] = [];
    for (let i = 0; i < PENDING_MAX + 2; i++) {
      silent.push(await socketTo(a));
      await sleep(10);
    }
    await until(() => silent[0]!.closed && silent[1]!.closed);
    expect(silent.slice(2).every((x) => !x.closed)).toBe(true);
    // One of those that are left can still become the fork.
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    silent.at(-1)!.hello();
    await until(() => s.status().fork === 'ready');
  });
});

describe('opening a match (A7, D6)', () => {
  it('A7: a ports file that cannot be read does not stop the match, and leaves no tunnel end behind', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a', {
      ports: {
        read: () => {
          throw new Error('EPERM: operation not permitted');
        },
        write: () => undefined,
      },
    });
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    expect(hub.all).toHaveLength(1);
    // The control port still opens (on a port the OS picks), and the fork is served.
    await forkOf(a);
    await until(() => s.status().fork === 'ready');
    expect(a.logs.some((l) => l.startsWith('WARN stream3d: the saved control port could not be read (EPERM'))).toBe(true);
    await s.close();
    expect(hub.all.every((t) => t.closed)).toBe(true);
  });

  it('A7: a tunnel end that fails while it is set up is closed, and the match goes on in 2D', async () => {
    const hub = new TunnelHub();
    const made: FakeTunnel[] = [];
    const a = pc(hub, 'a', {
      tunnel: (t) => {
        const end = hub.make(t);
        made.push(end);
        // The page is up (a hidden window, ipc listeners) and the first call on it throws.
        end.setInfo = () => {
          throw new Error('the page is gone');
        };
        return end;
      },
    });
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    s.setPeers([{ id: 'b', name: 'Krobs' }]);
    await sleep(10);
    expect(made).toHaveLength(1);
    expect(made[0]!.closed).toBe(true);
    expect(a.logs.some((l) => l.startsWith('WARN stream3d: the data connections could not be opened (the page is gone)'))).toBe(true);
    // It is not tried again and again, and the match host gets its answers.
    await forkOf(a);
    await until(() => s.status().fork === 'ready');
    expect(made).toHaveLength(1);
    expect(s.showing3d()).toBe(false);
    expect(lineOf(s, 'b')).toBe('Krobs: the 2D video (the 3D connection to their PC is not up yet)');
  });

  it('D6: with 3D watch off and no fork, no tunnel is opened (no page, no peer connections, no signalling)', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    await forkOf(b);
    const sent: Array<[string, string, string]> = [];
    const streams: Record<string, MatchStream3d> = {};
    for (const p of [a, b]) {
      streams[p.id] = p.host.open({
        localId: p.id,
        setting: p.id === 'a' ? 'off' : 'auto',
        sendSignal: (to, sig) => {
          sent.push([p.id, to, sig.kind]);
          queueMicrotask(() => streams[to]?.signal(p.id, { ...sig, channel: 'stream' }));
        },
      });
    }
    streams.a!.setPeers([{ id: 'b', name: 'Krobs' }]);
    streams.b!.setPeers([{ id: 'a', name: 'Owner' }]);
    await sleep(40);
    expect(hub.all.map((t) => t.id)).toEqual(['b']);
    expect(sent.filter(([from]) => from === 'a')).toEqual([]);
    expect(hub.open('a', 'b')).toBe(false);
    expect(lineOf(streams.a!, 'b')).toBe('Krobs: the 2D video (3D watch is turned off on this PC)');
    expect(a.logs).toContain('stream3d: no data connections are opened on this PC: 3D watch is off and no Castcade VPX build is on the control port (they open if either changes)');

    // A fork comes up on a's control port (the table was started by hand in the Castcade build): the others can
    // watch this PC now, so its tunnel opens, tells b to start over, and says what its VPX is.
    await forkOf(a);
    await until(() => hub.open('a', 'b'));
    expect(sent.filter(([from]) => from === 'a').map(([, , kind]) => kind)).toEqual(['reset', 'offer']);
    await until(() => lineOf(streams.b!, 'a') === 'Owner: 3D, on your own table');
    expect(a.tunnel().playerPort).toBe(STREAM.a);
    // This PC itself still shows 2D: the setting is off.
    expect(lineOf(streams.a!, 'b')).toBe('Krobs: the 2D video (3D watch is turned off on this PC)');
  });

  it('D6: turning 3D watch on during the match opens the tunnel; the one that offers is then the one with the lower id, whoever came late', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    await forkOf(a);
    const fb = await forkOf(b);
    // b is the PC with the setting off this time: the late one is the one that waits for the offer.
    const s = match([a, b], { b: 'off' });
    // b has a fork, so its tunnel is open although its setting is off: a may watch it.
    await until(() => lineOf(s.a!, 'b') === 'Krobs: 3D, on your own table');
    expect(lineOf(s.b!, 'a')).toBe('Owner: the 2D video (3D watch is turned off on this PC)');
    fb.close();
    await until(() => s.b!.status().fork === 'none');
    // A second match on the same PCs, b with neither: no tunnel on b until the setting changes.
    await s.a!.close();
    await s.b!.close();
    const made = hub.all.length;
    const again = match([a, b], { b: 'off' });
    await sleep(40);
    expect(hub.all.length).toBe(made + 1);
    again.b!.setSetting('auto');
    await until(() => hub.open('a', 'b'));
    expect(hub.all.length).toBe(made + 2);
    await until(() => lineOf(again.a!, 'b') === 'Krobs: the 2D video (no Castcade VPX build runs the table on their PC)');
    expect(lineOf(again.b!, 'a')).toBe('Owner: the 2D video (no Castcade VPX build runs the table on this PC)');
  });

  it("D6: the tunnel's own reports (a round-trip time every 2 s per peer) do not reach the match host", async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    await forkOf(a);
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b') === 'Krobs: 3D, on your own table');
    await sleep(20);
    let changes = 0;
    s.a!.onChange(() => void changes++);
    for (let i = 0; i < 30; i++) {
      a.tunnel().report();
      await sleep(1);
    }
    expect(changes).toBe(0);
    // What the match host does read still reaches it, once.
    s.a!.setTarget('b', '1');
    await until(() => changes === 1);
    await sleep(20);
    expect(changes).toBe(1);
  });
});

describe('through the real TunnelBridge and real loopback sockets', () => {
  interface RealPc {
    id: string;
    host: Stream3dHost;
    logs: string[];
    /** The fork's control connection. */
    fork: ScriptedFork;
    /** The fork's stream listener: the port its hello names. */
    stream: StreamListener;
    tunnel(): BridgeTunnel;
  }
  const realPc = async (hub: BridgeHub, id: string): Promise<RealPc> => {
    const logs: string[] = [];
    const host = createStream3dHost({
      log: { info: (l) => void logs.push(l), warn: (l) => void logs.push(`WARN ${l}`) },
      logsDir: String.raw`C:\logs`,
      pageDir: String.raw`C:\userData`,
      vpxExe: () => VPX,
      exists: async () => true,
      iceServers: () => [],
      tunnel: (t) => hub.make(t),
      freePort: async () => 1,
    });
    hosts.push(host);
    const stream = await StreamListener.open();
    closers.push(() => stream.close());
    const fork = await ScriptedFork.connect(await host.controlPort());
    forks.push(fork);
    fork.hello(undefined, undefined, stream.port);
    return { id, host, logs, fork, stream, tunnel: () => hub.ends.get(id) as BridgeTunnel };
  };
  /** The fork's watcher: a socket to the address a `watch` line named. */
  const watcher = async (line: string): Promise<{ sock: Socket; got: () => string; closed: () => boolean }> => {
    const m = /^watch 127\.0\.0\.1:(\d+)$/.exec(line);
    if (!m) throw new Error(`not a watch line: ${line}`);
    const sock = connect({ host: '127.0.0.1', port: Number(m[1]) });
    let got = '';
    let closed = false;
    sock.on('data', (d: Buffer) => (got += d.toString('utf8')));
    sock.on('error', () => undefined);
    sock.on('close', () => (closed = true));
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    closers.push(() => sock.destroy());
    return { sock, got: () => got, closed: () => closed };
  };

  it("a fork sent to watch reaches the other PC's stream listener through the tunnel; a re-aim arrives on the same listener and leads to the next player; a watcher that reaches a PC whose own fork is away is taken, not refused", async () => {
    const hub = new BridgeHub();
    const a = await realPc(hub, 'a');
    const b = await realPc(hub, 'b');
    const c = await realPc(hub, 'c');
    const s = match([a, b, c]);
    // The capability crossed the real bridge as an INFO frame (tunnel version 2).
    await until(() => ['b', 'c'].every((id) => lineOf(s.a!, id).endsWith('3D, on your own table')) && lineOf(s.b!, 'c').endsWith('3D, on your own table'), 5000, 'the capabilities over the bridge');
    expect(b.tunnel().status().playerPort).toBe(b.stream.port);

    // b is up; a is sent to watch it. The scripted fork does what the real one does: it connects to the address.
    s.a!.setTarget('b', '1');
    const first = await a.fork.next(/^watch /);
    const w1 = await watcher(first);
    await until(() => b.stream.sockets.length === 1, 5000, "the watcher to reach b's stream listener");
    w1.sock.write('HELLO from the watcher on a');
    b.stream.sockets[0]!.write('KEYFRAME of b');
    await until(() => b.stream.got[0] === 'HELLO from the watcher on a' && w1.got() === 'KEYFRAME of b');
    a.fork.say('state watching');
    await until(() => s.a!.status().watching === 'b');
    expect(a.tunnel().status().stats.streams).toMatchObject([{ peer: 'b', role: 'watch', state: 'open' }]);
    expect(c.stream.sockets).toHaveLength(0);

    // The turn goes from b to c. b's fork is sent to watch c at the same moment a is re-aimed (rule 10): b is away
    // from its own table for the rest of this test.
    s.b!.setTarget('c', '2');
    await b.fork.next(/^watch /);
    expect(s.b!.away()).toBe(true);
    s.a!.setTarget('c', '2');
    await until(() => a.fork.got.filter((l) => l.startsWith('watch ')).length === 2);
    // Rule 11: the same address as before (the tunnel has one listener for every player).
    expect(a.fork.got.filter((l) => l.startsWith('watch '))[1]).toBe(first);
    // The fork drops its watcher connection and connects again.
    w1.sock.destroy();
    await until(() => b.stream.live().length === 0, 5000, "b's side of the old stream to close");
    const w2 = await watcher(first);
    await until(() => c.stream.sockets.length === 1, 5000, "the re-aimed watcher to reach c's stream listener");
    c.stream.sockets[0]!.write('KEYFRAME of c');
    await until(() => w2.got() === 'KEYFRAME of c');
    a.fork.say('state watching');
    await until(() => s.a!.status().watching === 'c');
    // Nothing of c reached b's listener, and nothing of the old stream is left.
    expect(b.stream.sockets).toHaveLength(1);
    expect(a.tunnel().status().stats.streams).toMatchObject([{ peer: 'c', role: 'watch', state: 'open' }]);

    // A watcher that reaches b while b's own fork is away (the hand-over of rule 10, seen from the other side): b's
    // companion still serves its stream port, so the stream opens and the fork holds it; it is not refused.
    const refusedBefore = c.tunnel().status().stats.refused + b.tunnel().status().stats.refused;
    s.c!.setTarget('b', '3');
    const toB = await c.fork.next(/^watch /);
    const w3 = await watcher(toB);
    await until(() => b.stream.live().length === 1, 5000, "c's watcher to reach b's stream listener while b is away");
    expect(s.b!.away()).toBe(true);
    await until(() => c.tunnel().status().stats.streams.some((x) => x.peer === 'b' && x.state === 'open'));
    expect(c.tunnel().status().stats.refused + b.tunnel().status().stats.refused).toBe(refusedBefore);
    expect(w3.closed()).toBe(false);
    // b's fork comes back and serves what it held.
    b.stream.live()[0]!.write('KEYFRAME of b, late');
    await until(() => w3.got() === 'KEYFRAME of b, late');
  }, 20_000);

  it('a PC whose fork is gone refuses the stream: the watcher is closed (its fork then says state failed) and the turn is 2D', async () => {
    const hub = new BridgeHub();
    const a = await realPc(hub, 'a');
    const b = await realPc(hub, 'b');
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b').endsWith('3D, on your own table'));
    s.a!.setTarget('b', '1');
    const line = await a.fork.next(/^watch /);
    // b's VPX closes at that moment: its companion has no port to serve any more, and says so to a.
    b.fork.close();
    await until(() => b.tunnel().status().playerPort === null);
    const w = await watcher(line);
    await until(() => w.closed(), 5000, 'the refused watcher to be closed');
    expect(b.stream.sockets).toHaveLength(0);
    a.fork.say('state failed refused', 'state playing');
    await until(() => !s.a!.showing3d());
    await until(() => lineOf(s.a!, 'b') === 'Krobs: the 2D video (no Castcade VPX build runs the table on their PC)');
  }, 20_000);
});

describe('the stream channel of a match whose host changes (the engine on a memory bus)', () => {
  const flush = async (n = 8): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };
  const hex = 'ab'.repeat(32);
  const game: GameFingerprint = { kind: 'vpx', tableName: 'MM', tableHash: hex, romName: null, romHash: null, physicsHash: null, recipeVersion: '1', sidecarHash: null, emulatorVersion: '10.8.0' };
  const who = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: NAMES[id] ?? id, publicKey: keys.publicKeyB64, rig: 'pc' });

  it('a host transfer under an open stream: the data connections stay as they are, and signals sent after it still reach their player (a tunnel that opens late, through the new host)', async () => {
    const bus = new MemoryBus();
    const clock = new ManualClock();
    const keys = { a: generateKeys(), b: generateKeys(), c: generateKeys() };
    // a hosts; b and c are clients. c has 3D watch off and no fork: its tunnel is not open yet.
    const host = new HostMatch({ transport: bus.transport('a'), keys: keys.a, matchId: 'M', ballsPerGame: 1, hostParticipant: who('a', keys.a), hostGame: game, clock });
    const b = new ClientMatch({ transport: bus.transport('b'), keys: keys.b, participant: who('b', keys.b), game, throwdownCode: 'M', hostId: 'a', clock });
    const c = new ClientMatch({ transport: bus.transport('c'), keys: keys.c, participant: who('c', keys.c), game, throwdownCode: 'M', hostId: 'a', clock });
    closers.push(() => void [host, b, c].forEach((r) => r.close()));
    // As the match host wires it: one signalling per role, split by channel; the stream side goes to the stream.
    const hub = new TunnelHub();
    const pcs = { a: pc(hub, 'a'), b: pc(hub, 'b'), c: pc(hub, 'c') };
    const streams: Record<string, MatchStream3d> = {};
    const roles = { a: host, b, c } as const;
    for (const id of ['a', 'b', 'c'] as const) {
      const side = splitSignalling(matchSignalling(roles[id], id)).stream;
      const s = pcs[id].host.open({ localId: id, setting: id === 'c' ? 'off' : 'auto', sendSignal: (to, sig) => side.send(to, sig) });
      side.onSignal((from, sig) => s.signal(from, sig));
      streams[id] = s;
    }
    b.join();
    c.join();
    await flush();
    for (const id of ['a', 'b', 'c'] as const) streams[id]!.setPeers((['a', 'b', 'c'] as const).filter((x) => x !== id).map((x) => ({ id: x, name: NAMES[x]! })));
    await forkOf(pcs.a);
    await forkOf(pcs.b);
    host.start();
    await flush();
    await until(() => hub.open('a', 'b') && lineOf(streams.a!, 'b') === 'Krobs: 3D, on your own table');
    expect(hub.all.map((t) => t.id).sort()).toEqual(['a', 'b']);

    // The host hands the match to b.
    const became: HostMatch[] = [];
    b.on('becameHost', (h) => became.push(h));
    host.transferHost('b');
    await flush();
    expect(became).toHaveLength(1);
    closers.push(() => became[0]!.close());
    // Nothing of the stream moved: the same ends, still connected, each still knowing the other's VPX.
    expect(hub.all.map((t) => t.id).sort()).toEqual(['a', 'b']);
    expect(hub.open('a', 'b')).toBe(true);
    expect(lineOf(streams.a!, 'b')).toBe('Krobs: 3D, on your own table');

    // c's VPX comes up on its control port after the transfer: its tunnel opens, and its reset, offers and answers
    // travel through the new host (b), and through it to a (now a client).
    await forkOf(pcs.c);
    await until(() => hub.open('a', 'c') && hub.open('b', 'c'), 5000, "c's data connections through the new host");
    await until(() => lineOf(streams.a!, 'c') === 'Chuck: 3D, on your own table' && lineOf(streams.b!, 'c') === 'Chuck: 3D, on your own table');
    expect(lineOf(streams.c!, 'a')).toBe('Owner: the 2D video (3D watch is turned off on this PC)');
  });
});
