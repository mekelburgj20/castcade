/**
 * I11.4.1: the 3D watch tunnel's core on fakes: two bridges joined by an in-memory channel (delivered when the test
 * pumps it), fake sockets for the VPX instances. Open / accept / refuse / close, the byte stream chunked and put back
 * together, backpressure both ways, two watchers on one player, a peer that vanishes, a local socket that closes first.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, FRAME, FRAME_MAX, HEADER_BYTES, PENDING_MAX, TunnelBridge, packFrame, unpackFrame, type TunnelChannel, type TunnelSocket } from './tunnel.js';

class FakeSocket extends EventEmitter implements TunnelSocket {
  written: Uint8Array[] = [];
  paused = false;
  ended = false;
  destroyed = false;
  noDelay = false;
  /** `write` answers false while this is set (a full write buffer). */
  full = false;
  pauses = 0;
  resumes = 0;
  write(data: Uint8Array): boolean {
    this.written.push(Uint8Array.from(data));
    return !this.full;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
  pause(): void {
    this.paused = true;
    this.pauses += 1;
  }
  resume(): void {
    this.paused = false;
    this.resumes += 1;
  }
  setNoDelay(on = true): this {
    this.noDelay = on;
    return this;
  }
  bytes(): Buffer {
    return Buffer.concat(this.written);
  }
  /** The VPX sends `d`, in pieces of at most `piece` bytes (TCP reads come in any size). */
  feed(d: Uint8Array, piece = d.length): void {
    for (let off = 0; off < d.length; off += piece) this.emit('data', d.subarray(off, Math.min(d.length, off + piece)));
  }
}

/** One direction of a channel: frames queue until `pump`; `busy` is the page's high mark. */
class FakeChannel implements TunnelChannel {
  busy = false;
  queue: Uint8Array[] = [];
  sizes: number[] = [];
  kinds: number[] = [];
  send(frame: Uint8Array): void {
    this.queue.push(Uint8Array.from(frame));
    this.sizes.push(frame.length);
    this.kinds.push((frame[0] as number) & 0x7f);
  }
}

interface End {
  bridge: TunnelBridge;
  connects: Array<{ port: number; socket: FakeSocket }>;
  log: string[];
  /** What this end sends to each peer. */
  out: Map<string, FakeChannel>;
}

function makeEnd(name: string, extra: { pendingMax?: number } = {}): End {
  const connects: End['connects'] = [];
  const log: string[] = [];
  const bridge = new TunnelBridge({
    connect: (port) => {
      const socket = new FakeSocket();
      connects.push({ port, socket });
      return socket;
    },
    log: (l) => log.push(`${name}: ${l}`),
    endGraceMs: 10,
    ...extra,
  });
  return { bridge, connects, log, out: new Map() };
}

/** A channel each way between `a` (id `aId`) and `b` (id `bId`); `pump` delivers until both queues are empty. */
function link(a: End, aId: string, b: End, bId: string): { ab: FakeChannel; ba: FakeChannel; pump: () => number; down: (why?: string) => void } {
  const ab = new FakeChannel();
  const ba = new FakeChannel();
  a.out.set(bId, ab);
  b.out.set(aId, ba);
  a.bridge.channelUp(bId, ab);
  b.bridge.channelUp(aId, ba);
  const pump = (): number => {
    let n = 0;
    while (ab.queue.length > 0 || ba.queue.length > 0) {
      const f1 = ab.queue.shift();
      if (f1) {
        n += 1;
        b.bridge.receive(aId, f1);
      }
      const f2 = ba.queue.shift();
      if (f2) {
        n += 1;
        a.bridge.receive(bId, f2);
      }
    }
    return n;
  };
  const down = (why = 'test'): void => {
    a.bridge.channelDown(bId, why);
    b.bridge.channelDown(aId, why);
  };
  pump();
  return { ab, ba, pump, down };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('tunnel frames', () => {
  it('packs and unpacks every kind, with the acceptor flag and the id', () => {
    for (const kind of Object.values(FRAME)) {
      const payload = Uint8Array.from([1, 2, 3]);
      const f = unpackFrame(packFrame(kind, 0xfedc_ba98, kind % 2 === 0, payload));
      expect(f).not.toBeNull();
      expect(f!.kind).toBe(kind);
      expect(f!.id).toBe(0xfedc_ba98);
      expect(f!.fromAcceptor).toBe(kind % 2 === 0);
      expect([...f!.payload]).toEqual([1, 2, 3]);
    }
  });

  it('refuses what is not a frame and never packs one over the size', () => {
    expect(unpackFrame(new Uint8Array(4))).toBeNull();
    expect(unpackFrame(Uint8Array.from([9, 0, 0, 0, 1]))).toBeNull();
    expect(unpackFrame(new Uint8Array(FRAME_MAX + 1))).toBeNull();
    expect(packFrame(FRAME.DATA, 1, false, new Uint8Array(CHUNK_BYTES)).length).toBe(FRAME_MAX);
    expect(() => packFrame(FRAME.DATA, 1, false, new Uint8Array(CHUNK_BYTES + 1))).toThrow();
  });

  it('reads a frame out of a view into a larger buffer (what IPC may hand over)', () => {
    const big = new Uint8Array(100);
    big.set(packFrame(FRAME.DATA, 7, true, Uint8Array.from([5, 6])), 10);
    const f = unpackFrame(big.subarray(10, 10 + HEADER_BYTES + 2));
    expect(f?.id).toBe(7);
    expect([...f!.payload]).toEqual([5, 6]);
  });
});

describe('TunnelBridge', () => {
  it('opens a watcher stream to the peer, which connects to its player on loopback and accepts', () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    p.bridge.setPlayerPort(47811);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    expect(watcher.noDelay).toBe(true);
    watcher.feed(Buffer.from('hello from the watcher'));
    l.pump();
    expect(p.connects).toHaveLength(1);
    expect(p.connects[0]!.port).toBe(47811);
    const player = p.connects[0]!.socket;
    // Nothing reaches the player's VPX before the connection is up: it is held, then written in order.
    expect(player.written).toHaveLength(0);
    player.emit('connect');
    expect(player.noDelay).toBe(true);
    expect(player.bytes().toString()).toBe('hello from the watcher');
    l.pump();
    expect(w.bridge.stats().streams[0]).toMatchObject({ peer: 'p', role: 'watch', state: 'open' });
    expect(p.bridge.stats().streams[0]).toMatchObject({ peer: 'w', role: 'play', state: 'open' });
    player.feed(Buffer.from('keyframe'));
    l.pump();
    expect(watcher.bytes().toString()).toBe('keyframe');
    expect(w.log.some((x) => x.includes('accepted'))).toBe(true);
  });

  it('refuses a watcher when no table plays on the peer: the watcher socket closes (the fork tries again)', () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    l.pump();
    expect(p.connects).toHaveLength(0);
    expect(watcher.destroyed).toBe(true);
    expect(w.bridge.stats().streams).toHaveLength(0);
    expect(w.bridge.stats().refused).toBe(1);
  });

  it("refuses a watcher when the player's VPX does not answer on its port", () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    p.bridge.setPlayerPort(47812);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    l.pump();
    const player = p.connects[0]!.socket;
    player.emit('error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:47812'), { code: 'ECONNREFUSED' }));
    player.emit('close');
    l.pump();
    expect(watcher.destroyed).toBe(true);
    expect(p.bridge.stats().streams).toHaveLength(0);
    expect(w.bridge.stats().streams).toHaveLength(0);
    expect(p.log.join('\n')).toContain('ECONNREFUSED');
  });

  it('closes a watcher at once when there is no channel to the peer yet', () => {
    const w = makeEnd('W');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    expect(watcher.destroyed).toBe(true);
  });

  it('carries a byte stream both ways in frames of at most 16 KB, whatever the read sizes', () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    p.bridge.setPlayerPort(1);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    l.pump();
    const player = p.connects[0]!.socket;
    player.emit('connect');
    l.pump();
    const up = randomBytes(1_000_003);
    const down = randomBytes(3_000_017);
    // Uneven reads, as TCP gives them: a 64 KB read becomes several frames; a 3-byte read one small frame.
    watcher.feed(up, 65_536 + 13);
    player.feed(down.subarray(0, 3), 3);
    player.feed(down.subarray(3), 40_000);
    l.pump();
    expect(player.bytes().equals(up)).toBe(true);
    expect(watcher.bytes().equals(down)).toBe(true);
    expect(Math.max(...l.ab.sizes, ...l.ba.sizes)).toBeLessThanOrEqual(FRAME_MAX);
    expect(Math.max(...l.ba.sizes)).toBe(FRAME_MAX);
    const ws = w.bridge.stats();
    expect(ws.streams[0]).toMatchObject({ up: up.length, down: down.length });
  });

  it('pauses the local reads while the channel is over its high mark, and resumes at its low mark', () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    p.bridge.setPlayerPort(1);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    l.pump();
    const player = p.connects[0]!.socket;
    player.emit('connect');
    l.pump();
    // The page reports its buffer over the mark after a send: the socket that fed it stops reading.
    l.ba.busy = true;
    player.feed(randomBytes(50_000));
    expect(player.paused).toBe(true);
    expect(p.bridge.stats().channelStalls).toBe(1);
    l.ba.busy = false;
    p.bridge.channelWritable('w');
    expect(player.paused).toBe(false);
    // The same from outside (the page's flow message), with two streams on the channel: both stop, both go on.
    const watcher2 = new FakeSocket();
    w.bridge.attachWatcher(watcher2, 'p');
    l.pump();
    w.bridge.channelBusy('p');
    expect(watcher.paused && watcher2.paused).toBe(true);
    w.bridge.channelWritable('p');
    expect(watcher.paused || watcher2.paused).toBe(false);
    l.pump();
    expect(watcher.bytes().length).toBe(50_000);
  });

  it("tells the peer to stop reading while this side's local socket cannot take more, and to go on at drain", () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    p.bridge.setPlayerPort(1);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    l.pump();
    const player = p.connects[0]!.socket;
    player.emit('connect');
    l.pump();
    // The player's VPX reads slowly: its write buffer fills, PAUSE goes to the watcher's side.
    player.full = true;
    watcher.feed(randomBytes(20_000));
    l.pump();
    expect(l.ba.kinds).toContain(FRAME.PAUSE);
    expect(watcher.paused).toBe(true);
    expect(p.bridge.stats().socketStalls).toBe(1);
    // More writes while full send no second PAUSE.
    watcher.feed(randomBytes(100));
    l.pump();
    expect(l.ba.kinds.filter((k) => k === FRAME.PAUSE)).toHaveLength(1);
    player.full = false;
    player.emit('drain');
    l.pump();
    expect(l.ba.kinds).toContain(FRAME.RESUME);
    expect(watcher.paused).toBe(false);
    // The same the other way: the watcher's VPX is the slow one.
    watcher.full = true;
    player.feed(randomBytes(10));
    l.pump();
    expect(player.paused).toBe(true);
    watcher.full = false;
    watcher.emit('drain');
    l.pump();
    expect(player.paused).toBe(false);
  });

  it('a pause from the peer and a busy channel are both needed gone before reading goes on', () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    p.bridge.setPlayerPort(1);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    l.pump();
    p.connects[0]!.socket.emit('connect');
    l.pump();
    const player = p.connects[0]!.socket;
    player.full = true;
    watcher.feed(randomBytes(10));
    l.pump();
    w.bridge.channelBusy('p');
    expect(watcher.paused).toBe(true);
    player.full = false;
    player.emit('drain');
    l.pump();
    expect(watcher.paused).toBe(true);
    w.bridge.channelWritable('p');
    expect(watcher.paused).toBe(false);
  });

  it('serves two watchers on one player: two loopback connections, each with its own bytes', () => {
    const p = makeEnd('P');
    const a = makeEnd('A');
    const b = makeEnd('B');
    p.bridge.setPlayerPort(47813);
    const la = link(a, 'a', p, 'p');
    const lb = link(b, 'b', p, 'p');
    const wa = new FakeSocket();
    const wb = new FakeSocket();
    const wa2 = new FakeSocket();
    a.bridge.attachWatcher(wa, 'p');
    b.bridge.attachWatcher(wb, 'p');
    // A second watcher on the same PC (two VPX instances) is a third stream.
    a.bridge.attachWatcher(wa2, 'p');
    wa.feed(Buffer.from('A1'));
    wb.feed(Buffer.from('B1'));
    wa2.feed(Buffer.from('A2'));
    la.pump();
    lb.pump();
    expect(p.connects.map((c) => c.port)).toEqual([47813, 47813, 47813]);
    for (const c of p.connects) c.socket.emit('connect');
    la.pump();
    lb.pump();
    const got = p.connects.map((c) => c.socket.bytes().toString()).sort();
    expect(got).toEqual(['A1', 'A2', 'B1']);
    for (const c of p.connects) c.socket.feed(Buffer.from(`to ${c.socket.bytes().toString()}`));
    la.pump();
    lb.pump();
    expect(wa.bytes().toString()).toBe('to A1');
    expect(wa2.bytes().toString()).toBe('to A2');
    expect(wb.bytes().toString()).toBe('to B1');
    expect(p.bridge.stats().streams).toHaveLength(3);
    // One watcher leaves: only its connection to the player closes.
    wb.destroy();
    lb.pump();
    expect(p.connects.filter((c) => c.socket.ended || c.socket.destroyed)).toHaveLength(1);
    expect(p.bridge.stats().streams).toHaveLength(2);
  });

  it('closes the local sockets on both ends when the peer vanishes mid-stream', () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    p.bridge.setPlayerPort(1);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    l.pump();
    const player = p.connects[0]!.socket;
    player.emit('connect');
    player.feed(randomBytes(30_000));
    // The channel goes before these frames arrive.
    l.down('the connection failed');
    expect(watcher.destroyed).toBe(true);
    expect(player.destroyed).toBe(true);
    expect(w.bridge.stats().streams).toHaveLength(0);
    expect(p.bridge.stats().streams).toHaveLength(0);
    // A later watcher connection with no channel is closed at once; once the channel is back it goes through.
    const again = new FakeSocket();
    w.bridge.attachWatcher(again, 'p');
    expect(again.destroyed).toBe(true);
    const l2 = link(w, 'w', p, 'p');
    const third = new FakeSocket();
    w.bridge.attachWatcher(third, 'p');
    l2.pump();
    expect(p.connects).toHaveLength(2);
  });

  it("ends the player's connection when the watcher's VPX closes first, and the other way round", async () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    p.bridge.setPlayerPort(1);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    l.pump();
    const player = p.connects[0]!.socket;
    player.emit('connect');
    l.pump();
    watcher.emit('close');
    l.pump();
    expect(player.ended).toBe(true);
    // Ended first (what was written still reaches the VPX), destroyed after the grace.
    await sleep(30);
    expect(player.destroyed).toBe(true);
    // The player's VPX closes first: the watcher's socket is ended, and its next connection is a new stream.
    const watcher2 = new FakeSocket();
    w.bridge.attachWatcher(watcher2, 'p');
    l.pump();
    const player2 = p.connects[1]!.socket;
    player2.emit('connect');
    l.pump();
    player2.emit('close');
    l.pump();
    expect(watcher2.ended).toBe(true);
    expect(w.bridge.stats().streams).toHaveLength(0);
    expect(p.bridge.stats().streams).toHaveLength(0);
  });

  it('holds what arrives before the local connection is up, and refuses a stream that waits on too much', () => {
    const w = makeEnd('W');
    const p = makeEnd('P', { pendingMax: 1000 });
    p.bridge.setPlayerPort(1);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    watcher.feed(randomBytes(1500), 100);
    l.pump();
    expect(p.connects[0]!.socket.destroyed).toBe(true);
    expect(watcher.destroyed).toBe(true);
    expect(PENDING_MAX).toBeGreaterThan(1_000_000);
  });

  it('answers a frame for a stream it does not have with CLOSE, and never answers an ending', () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    const l = link(w, 'w', p, 'p');
    const before = l.ba.kinds.length;
    p.bridge.receive('w', packFrame(FRAME.DATA, 99, false, Uint8Array.from([1])));
    expect(l.ba.kinds.slice(before)).toEqual([FRAME.CLOSE]);
    p.bridge.receive('w', packFrame(FRAME.CLOSE, 98, false));
    p.bridge.receive('w', packFrame(FRAME.REFUSE, 97, true));
    expect(l.ba.kinds.slice(before)).toEqual([FRAME.CLOSE]);
    // The CLOSE that W gets for a stream it does not have either is not answered: no loop.
    const n = l.pump();
    expect(n).toBe(1);
  });

  it('keeps the two sides’ stream ids apart when each watches the other at once', () => {
    const a = makeEnd('A');
    const b = makeEnd('B');
    a.bridge.setPlayerPort(1);
    b.bridge.setPlayerPort(2);
    const l = link(a, 'a', b, 'b');
    const wa = new FakeSocket();
    const wb = new FakeSocket();
    a.bridge.attachWatcher(wa, 'b');
    b.bridge.attachWatcher(wb, 'a');
    l.pump();
    a.connects[0]!.socket.emit('connect');
    b.connects[0]!.socket.emit('connect');
    l.pump();
    // Both opened stream id 1; the flag keeps them apart.
    expect(a.bridge.stats().streams.map((s) => [s.id, s.role]).sort()).toEqual([
      [1, 'play'],
      [1, 'watch'],
    ]);
    wa.feed(Buffer.from('from a'));
    wb.feed(Buffer.from('from b'));
    l.pump();
    expect(b.connects[0]!.socket.bytes().toString()).toBe('from a');
    expect(a.connects[0]!.socket.bytes().toString()).toBe('from b');
  });

  it('logs repeated refusals once, then a count', () => {
    let t = 0;
    const log: string[] = [];
    const bridge = new TunnelBridge({ connect: () => new FakeSocket(), log: (l) => log.push(l), now: () => t });
    bridge.channelUp('p', new FakeChannel());
    for (let k = 0; k < 5; k++) {
      bridge.receive('p', packFrame(FRAME.OPEN, k + 1, false));
      t += 2000;
    }
    expect(log.filter((l) => l.includes('no table is playing'))).toHaveLength(1);
    t += 30_000;
    bridge.receive('p', packFrame(FRAME.OPEN, 50, false));
    expect(log.filter((l) => l.includes('no table is playing'))).toHaveLength(2);
    expect(log.at(-1)).toContain('and 4 more like it');
  });

  it('close() ends every stream and refuses new ones', () => {
    const w = makeEnd('W');
    const p = makeEnd('P');
    p.bridge.setPlayerPort(1);
    const l = link(w, 'w', p, 'p');
    const watcher = new FakeSocket();
    w.bridge.attachWatcher(watcher, 'p');
    l.pump();
    w.bridge.close();
    expect(watcher.destroyed).toBe(true);
    l.pump();
    expect(p.connects[0]!.socket.destroyed).toBe(true);
    const late = new FakeSocket();
    w.bridge.attachWatcher(late, 'p');
    expect(late.destroyed).toBe(true);
  });
});
