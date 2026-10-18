import { describe, expect, it } from 'vitest';
import { buildMessage, type AnyMessage } from '@castcade/protocol';
import { ManualClock } from './clock.js';
import { MemoryBus } from './transport.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const msg = (from: string, seq: number): AnyMessage => buildMessage('RESUME', {}, { matchId: 'M', seq, from, ts: seq });

describe('MemoryBus', () => {
  it('delivers FIFO per link, broadcasts to everyone but the sender, and reports joins', async () => {
    const bus = new MemoryBus();
    const a = bus.transport('a');
    const joins: string[] = [];
    a.onPeerJoin((p) => joins.push(p));
    const b = bus.transport('b');
    const c = bus.transport('c');
    const got: Record<string, string[]> = { a: [], b: [], c: [] };
    for (const t of [a, b, c]) t.onMessage((from, m) => got[t.localId]?.push(`${from}:${m.seq}`));
    a.send('b', msg('a', 1));
    a.send('b', msg('a', 2));
    a.send('all', msg('a', 3));
    b.send('a', msg('b', 1));
    await flush();
    expect(got['b']).toEqual(['a:1', 'a:2', 'a:3']);
    expect(got['c']).toEqual(['a:3']);
    expect(got['a']).toEqual(['b:1']);
    expect(joins.sort()).toEqual(['b', 'c']);
    expect(bus.connectedPeers().sort()).toEqual(['a', 'b', 'c']);
  });

  it('disconnect: frames already sent still arrive, later ones do not, and peers see onPeerLeave', async () => {
    const bus = new MemoryBus();
    const a = bus.transport('a');
    const b = bus.transport('b');
    const left: string[] = [];
    const seen: string[] = [];
    b.onPeerLeave((p) => left.push(p));
    b.onMessage((_f, m) => seen.push(`${m.from}:${m.seq}`));
    a.send('b', msg('a', 1));
    bus.disconnect('a');
    a.send('b', msg('a', 2));
    await flush();
    expect(seen).toEqual(['a:1']);
    expect(left).toEqual(['a']);
    expect(bus.isConnected('a')).toBe(false);
    expect(() => bus.transport('a')).toThrow(/already exists/);
  });

  it('closePeer from one side drops the peer for everyone (host refusing a joiner)', async () => {
    const bus = new MemoryBus();
    const host = bus.transport('h');
    const x = bus.transport('x');
    const left: string[] = [];
    host.onPeerLeave((p) => left.push(p));
    const got: number[] = [];
    x.onMessage((_f, m) => got.push(m.seq));
    host.send('x', msg('h', 1));
    host.closePeer?.('x');
    await flush();
    expect(got).toEqual([1]);
    expect(bus.isConnected('x')).toBe(false);
    expect(left).toEqual(['x']); // the closer is told too; the host ignores leaves of non-roster peers
  });

  it('with latency, delivery is delayed but still ordered', async () => {
    const bus = new MemoryBus({ latencyMs: 5 });
    const a = bus.transport('a');
    const b = bus.transport('b');
    const got: number[] = [];
    b.onMessage((_f, m) => got.push(m.seq));
    a.send('b', msg('a', 1));
    a.send('b', msg('a', 2));
    expect(got).toEqual([]);
    await new Promise((r) => setTimeout(r, 25));
    expect(got).toEqual([1, 2]);
  });
});

describe('ManualClock', () => {
  it('fires timers in due order only when advanced, and supports clearTimeout', () => {
    const clock = new ManualClock(1000);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 50);
    const h = clock.setTimeout(() => fired.push('x'), 20);
    clock.setTimeout(() => {
      fired.push('a');
      clock.setTimeout(() => fired.push('a2'), 5);
    }, 10);
    clock.clearTimeout(h);
    expect(clock.pending()).toBe(2);
    clock.advance(9);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual(['a']);
    expect(clock.now()).toBe(1010);
    clock.advance(100);
    expect(fired).toEqual(['a', 'a2', 'b']);
    expect(clock.now()).toBe(1110);
    expect(clock.pending()).toBe(0);
  });
});
