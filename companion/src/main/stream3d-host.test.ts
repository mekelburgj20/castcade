/**
 * I11.4.2: the state stream's shell (`stream3d-host.ts`) with the real control listener on loopback, a scripted
 * control client standing in for the VPX fork, and fake tunnel ends joined by a hub (`stream3d.test-support.ts`). The
 * launch (§4.4), two PCs watching each other by turns, the lock that waits for `state playing`, and what the control
 * connection does when the fork misbehaves, never connects, speaks another version, or goes away.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaSignal } from '../media/match-media-types.js';
import { CONTROL_BYTES_MAX, createStream3dHost, type MatchStream3d, type Stream3dHost } from './stream3d-host.js';
import { ScriptedFork, TunnelHub, until, type FakeTunnel } from './stream3d.test-support.js';

const VPX = String.raw`C:\vpx\VPinballX_GL64.exe`;
const FORK = String.raw`C:\vpx\VPinballX_GL64_castcade.exe`;
const NAMES: Record<string, string> = { a: 'Owner', b: 'Krobs', c: 'Chuck' };

interface Pc {
  id: string;
  host: Stream3dHost;
  logs: string[];
  saved: { text: string | null };
  tunnel(): FakeTunnel;
}

const hosts: Stream3dHost[] = [];
const forks: ScriptedFork[] = [];
afterEach(async () => {
  for (const f of forks.splice(0)) f.close();
  for (const h of hosts.splice(0)) await h.stop();
});

function pc(hub: TunnelHub, id: string, o: { fork?: boolean; vpx?: string | null; saved?: { text: string | null }; watchTimeoutMs?: number; playWaitMs?: number } = {}): Pc {
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
    tunnel: (t) => hub.make(t),
    freePort: async () => ++port,
    ports: { read: () => saved.text, write: (t) => void (saved.text = t) },
    ...(o.watchTimeoutMs !== undefined ? { watchTimeoutMs: o.watchTimeoutMs } : {}),
    ...(o.playWaitMs !== undefined ? { playWaitMs: o.playWaitMs } : {}),
  });
  hosts.push(host);
  return { id, host, logs, saved, tunnel: () => hub.all.filter((t) => t.id === id).at(-1) as FakeTunnel };
}

/** The fork of `p`'s table: connected to its control port and through its hello. */
async function forkOf(p: Pc, table?: string): Promise<ScriptedFork> {
  const f = await ScriptedFork.connect(await p.host.controlPort());
  forks.push(f);
  f.hello(table);
  return f;
}

/** A match of these PCs: each one's stream opened, signalled to the others as the match's `stream` channel would. */
function match(pcs: Pc[]): Record<string, MatchStream3d> {
  const streams: Record<string, MatchStream3d> = {};
  const wire: Array<[string, string, MediaSignal]> = [];
  for (const p of pcs) {
    streams[p.id] = p.host.open({
      localId: p.id,
      setting: 'auto',
      // As the match does: the signal goes out marked `channel: 'stream'` and arrives so.
      sendSignal: (to, s) => {
        wire.push([p.id, to, s]);
        queueMicrotask(() => streams[to]?.signal(p.id, { ...s, channel: 'stream' }));
      },
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
    const opts = await a.host.launchOptions('auto');
    const control = await a.host.controlPort();
    expect(opts).toMatchObject({
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
    expect(Object.keys(opts!.env!).sort()).toEqual(['CASTCADE_STREAM', 'CASTCADE_STREAM_ADDR', 'CASTCADE_STREAM_CONTROL', 'CASTCADE_STREAM_DELAY_MS', 'CASTCADE_STREAM_LOG', 'CASTCADE_STREAM_SOUND']);
    expect(JSON.parse(a.saved.text!)).toEqual({ controlPort: control, streamPort: 9701 });
    expect(a.logs).toContain(`stream3d: the match table starts in the Castcade VPX build (${FORK}): stream on 127.0.0.1:9701, control on 127.0.0.1:${control}`);
    opts!.onExit?.(0);
    expect(a.logs.at(-1)).toBe("stream3d: the match table's VPX closed (exit 0)");
  });

  it('exactly as before (null) when the setting is off, when Castcade knows no VPX, and when the fork is not beside it', async () => {
    const hub = new TunnelHub();
    const off = pc(hub, 'a');
    expect(await off.host.launchOptions('off')).toBeNull();
    expect(off.logs).toContain('stream3d: 3D watch is turned off on this PC: the match table starts in your own VPX (the 2D video)');
    expect(off.saved.text).toBeNull();
    expect(await pc(hub, 'b', { vpx: null }).host.launchOptions('auto')).toBeNull();
    const none = pc(hub, 'c', { fork: false });
    expect(await none.host.launchOptions('auto')).toBeNull();
    expect(none.logs).toContain(String.raw`stream3d: the Castcade VPX build (VPinballX_GL64_castcade.exe) is not in C:\vpx: the match table starts in your own VPX (the 2D video)`);
  });
});

describe('two PCs in a match, both with the fork on the same table', () => {
  it('the capability crosses the tunnel, each shows the other in 3D; the turn sends watch and play; the lock waits for state playing', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    await a.host.launchOptions('auto');
    await b.host.launchOptions('auto');
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
    // Each tunnel serves its own fork's stream to the other (the port the launch gave the fork).
    expect(a.tunnel().playerPort).toBe(9701);
    expect(b.tunnel().playerPort).toBe(9801);
    expect(a.tunnel().o.logTag).toBe('stream3d');

    // The lobby: nobody is sent anywhere.
    expect(fa.got).toEqual([]);
    expect(fb.got).toEqual([]);

    // a is up: b's fork is sent to the tunnel listener aimed at a; a's fork is told nothing.
    s.a!.setTarget(null);
    s.b!.setTarget('a');
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
    s.a!.setTarget('b');
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
    await a.host.launchOptions('auto');
    await b.host.launchOptions('auto');
    const fa = await forkOf(a);
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b').endsWith('3D, on your own table'));
    s.a!.setTarget('b');
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
    await a.host.launchOptions('auto');
    await b.host.launchOptions('auto');
    const fa = await forkOf(a);
    const fb = await forkOf(b, '615 00000000deadbeef');
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b') === 'Krobs: the 2D video (theirs is another table file)' && lineOf(s.b!, 'a') === 'Owner: the 2D video (theirs is another table file)');
    s.a!.setTarget('b');
    s.b!.setTarget(null);
    await new Promise((r) => setTimeout(r, 60));
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
    await a.host.launchOptions('auto');
    await b.host.launchOptions('auto');
    const fa = await forkOf(a);
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.a!, 'b').endsWith('3D, on your own table'));
    return { hub, a, b, fa, s };
  };

  it('state failed: the theater is back (no 3D shown) and the line says why', async () => {
    const { a, fa, s } = await pair();
    s.a!.setTarget('b');
    await fa.next(/^watch /);
    expect(s.a!.showing3d()).toBe(true);
    fa.say('state failed refused: not the same table', 'state playing');
    await until(() => !s.a!.showing3d());
    expect(lineOf(s.a!, 'b')).toBe('Krobs: the 2D video this turn (3D did not start: refused: not the same table)');
    // No play went out: the fork is back by itself.
    expect(fa.got.filter((l) => l === 'play')).toEqual([]);
    expect(a.logs).toContain('stream3d: 3D watch of Krobs did not work (refused: not the same table); the 2D video serves this turn');
  });

  it('no state watching within the time: play, and the 2D video', async () => {
    const { fa, s } = await pair({ watchTimeoutMs: 60 });
    s.a!.setTarget('b');
    await fa.next(/^watch /);
    await fa.next('play');
    expect(s.a!.showing3d()).toBe(false);
    expect(lineOf(s.a!, 'b')).toMatch(/^Krobs: the 2D video this turn \(3D did not start: VPX did not show their table within/);
  });

  it('the control connection lost in the middle of a watch: the 2D video at once; the fork that reconnects serves the next turn', async () => {
    const { a, fa, s } = await pair();
    s.a!.setTarget('b');
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
    s.a!.setTarget('b');
    await again.next(/^watch /);
    expect(a.tunnel().playerPort).toBe(9701);
  });

  it('the fork never connects: this PC shows 2D and says so, and the other PC is told there is no build here', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    await a.host.launchOptions('auto'); // started in the fork, but an older build: no control connection ever comes
    await b.host.launchOptions('auto');
    await forkOf(b);
    const s = match([a, b]);
    await until(() => lineOf(s.b!, 'a') === 'Owner: the 2D video (no Castcade VPX build runs the table on their PC)');
    expect(s.a!.status()).toMatchObject({ fork: 'none', watching: null });
    expect(lineOf(s.a!, 'b')).toBe('Krobs: the 2D video (no Castcade VPX build runs the table on this PC)');
    s.a!.setTarget('b');
    s.b!.setTarget('a');
    await new Promise((r) => setTimeout(r, 60));
    expect(s.a!.showing3d()).toBe(false);
    expect(s.b!.showing3d()).toBe(false);
    expect(a.tunnel().watched).toEqual([]);
    expect(b.tunnel().watched).toEqual([]);
    // Nothing waits for a fork that is not there.
    const unlocked: boolean[] = [];
    s.a!.whenPlaying((late) => void unlocked.push(late));
    expect(unlocked).toEqual([false]);
  });

  it('hello with another version: no 3D on this PC, the log says why, the fork is told nothing', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    await a.host.launchOptions('auto');
    await b.host.launchOptions('auto');
    const fa = await ScriptedFork.connect(await a.host.controlPort());
    forks.push(fa);
    fa.say('hello 2 10.9.0.1.castcade 617 9f3a61c2d4e5b701', 'state playing');
    await forkOf(b);
    const s = match([a, b]);
    await until(() => s.a!.status().fork === 'version');
    await until(() => lineOf(s.b!, 'a') === 'Owner: the 2D video (no Castcade VPX build runs the table on their PC)');
    expect(lineOf(s.a!, 'b')).toBe('Krobs: the 2D video (the Castcade VPX build on this PC and this Castcade are different versions: update both)');
    s.a!.setTarget('b');
    await new Promise((r) => setTimeout(r, 60));
    expect(fa.got).toEqual([]);
    expect(a.logs).toContain('stream3d: VPX speaks version 2 of the control connection and this Castcade version 1: no 3D on this PC until both are updated; the 2D video serves');
  });
});

describe('the control connection as a socket', () => {
  it('lines arrive whole whatever the writes: in pieces, two at once, with a carriage return', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    await a.host.launchOptions('auto');
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    const f = await ScriptedFork.connect(await a.host.controlPort());
    forks.push(f);
    f.raw('hel');
    await new Promise((r) => setTimeout(r, 20));
    expect(s.status().fork).toBe('connecting');
    f.raw('lo 1 10.8.0.2078.castcade 617 9f3a61c2d4e5b701\r\nstate playing\r\n');
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

  it('a second VPX on the control port replaces the first, which is closed', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const s = a.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    const first = await forkOf(a);
    await until(() => s.status().fork === 'ready');
    const second = await forkOf(a, '700 1111111111111111');
    await until(() => first.closed);
    await until(() => s.status().fork === 'ready' && a.logs.some((l) => l.includes('table 700 1111111111111111')));
    expect(second.closed).toBe(false);
    // The first one's close did not take the second one's link down.
    await new Promise((r) => setTimeout(r, 30));
    expect(s.status().fork).toBe('ready');
  });

  it('a table left open serves the next match: the fork stays on the control port, and the new match is told about it', async () => {
    const hub = new TunnelHub();
    const a = pc(hub, 'a');
    const b = pc(hub, 'b');
    await a.host.launchOptions('auto');
    await b.host.launchOptions('auto');
    const fa = await forkOf(a);
    await forkOf(b);
    const first = match([a, b]);
    await until(() => lineOf(first.a!, 'b').endsWith('3D, on your own table'));
    await first.a!.close();
    await first.b!.close();
    expect(fa.closed).toBe(false);
    const second = match([a, b]);
    await until(() => lineOf(second.a!, 'b') === 'Krobs: 3D, on your own table' && lineOf(second.b!, 'a') === 'Owner: 3D, on your own table');
    expect(a.tunnel().playerPort).toBe(9701);
    // The first match's handle is dead: it shows and waits for nothing.
    expect(first.a!.showing3d()).toBe(false);
    const calls: boolean[] = [];
    first.a!.whenPlaying((late) => void calls.push(late));
    expect(calls).toEqual([false]);
  });

  it('Castcade restarted under an open table: the same control port again, and the fork that comes back is served on its stream port', async () => {
    const hub = new TunnelHub();
    const saved = { text: null as string | null };
    const before = pc(hub, 'a', { saved });
    await before.host.launchOptions('auto');
    const port = await before.host.controlPort();
    const f1 = await forkOf(before);
    await before.host.stop();
    await until(() => f1.closed);
    // The next run of Castcade: the ports file names the control port the open table still tries every 2 s.
    const after = pc(hub, 'a', { saved });
    const s = after.host.open({ localId: 'a', setting: 'auto', sendSignal: () => undefined });
    expect(await after.host.controlPort()).toBe(port);
    await forkOf(after);
    await until(() => s.status().fork === 'ready');
    expect(after.tunnel().playerPort).toBe(9701);
    expect(after.logs.some((l) => l.includes('the same as in the last run'))).toBe(true);
  });
});
