import { describe, expect, it } from 'vitest';
import { buildMessage } from '@castcade/protocol';
import { GENESIS_HASH, MatchLog } from './log.js';

const resume = (seq: number, ts: number) => buildMessage('RESUME', {}, { matchId: 'M', seq, from: 'p1', ts });

describe('MatchLog', () => {
  it('starts at the genesis head and chains hashes through prevHash', () => {
    const log = new MatchLog();
    expect(log.head()).toEqual({ hash: GENESIS_HASH, length: 0 });
    const e0 = log.append({ ts: 5, kind: 'msg', from: 'p1', message: resume(1, 5) });
    const e1 = log.append({ ts: 6, kind: 'msg', from: 'p1', message: resume(2, 6) });
    expect(e0.index).toBe(0);
    expect(e0.prevHash).toBe(GENESIS_HASH);
    expect(e1.prevHash).toBe(e0.hash);
    expect(log.head()).toEqual({ hash: e1.hash, length: 2 });
    expect(log.verifyChain()).toEqual({ ok: true });
  });

  it('is deterministic: the same inputs on two logs give the same hashes', () => {
    const a = new MatchLog();
    const b = new MatchLog();
    for (const l of [a, b]) {
      l.append({ ts: 1, kind: 'msg', from: 'p1', message: resume(1, 1) });
      l.append({ ts: 2, kind: 'event', from: 'p1', event: { type: 'host_transfer', reason: 'host_left', proposer: 'p2', from: 'p1', to: 'p2', newHostPublicKey: 'AA==' } });
    }
    expect(a.head()).toEqual(b.head());
    const c = new MatchLog();
    c.append({ ts: 1, kind: 'msg', from: 'p1', message: resume(1, 1) });
    c.append({ ts: 3, kind: 'event', from: 'p1', event: { type: 'host_transfer', reason: 'host_left', proposer: 'p2', from: 'p1', to: 'p2', newHostPublicKey: 'AA==' } });
    expect(c.head().hash).not.toBe(a.head().hash);
  });

  it('round-trips through JSON and detects a tampered entry', () => {
    const log = new MatchLog();
    log.append({ ts: 1, kind: 'msg', from: 'p1', message: resume(1, 1) });
    log.append({ ts: 2, kind: 'msg', from: 'p1', message: resume(2, 2) });
    const json = JSON.parse(JSON.stringify(log.toJSON())) as ReturnType<MatchLog['toJSON']>;
    const back = MatchLog.fromJSON(json);
    expect(back.head()).toEqual(log.head());
    expect(back.entries()).toEqual(log.entries());
    const first = json[0];
    if (!first) throw new Error('empty');
    first.ts = 99;
    expect(() => MatchLog.fromJSON(json)).toThrow(/broken at entry 0/);
    const tampered = MatchLog.fromJSON(log.toJSON());
    (tampered.entries()[1] as { ts: number }).ts = 42;
    expect(tampered.verifyChain()).toEqual({ ok: false, badIndex: 1 });
  });
});
