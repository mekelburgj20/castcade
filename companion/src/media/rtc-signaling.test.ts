import { describe, expect, it } from 'vitest';
import type { MediaSignal } from './match-media-types.js';
import { isPolite, negotiationSource, PeerNegotiator, SignalingMesh, type CandidateInit, type NegotiablePc, type SdpInit } from './rtc-signaling.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const settle = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

/**
 * A strict stand-in for RTCPeerConnection's signalling state machine: it throws where the browser would throw
 * (a remote offer over a local one, an answer with no offer, a candidate before the remote description), so the
 * negotiator's explicit rollback and its ICE queue are what make the tests pass.
 */
class FakePc implements NegotiablePc {
  signalingState: 'stable' | 'have-local-offer' | 'have-remote-offer' | 'closed' = 'stable';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: CandidateInit | null }) => void) | null = null;
  added: CandidateInit[] = [];
  errors: string[] = [];
  private n = 0;
  private stableLocal: { type: string; sdp: string } | null = null;

  constructor(
    readonly owner: string,
    readonly peer: string,
  ) {}

  async setLocalDescription(d?: SdpInit): Promise<void> {
    await tick();
    if (this.signalingState === 'closed') throw new Error('closed');
    if (d?.type === 'rollback') {
      if (this.signalingState !== 'have-local-offer') throw this.fail('rollback outside have-local-offer');
      this.signalingState = 'stable';
      this.localDescription = this.stableLocal;
      return;
    }
    if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: `answer ${this.owner}->${this.peer} #${++this.n}` };
      this.stableLocal = this.localDescription;
      this.signalingState = 'stable';
      return;
    }
    this.localDescription = { type: 'offer', sdp: `offer ${this.owner}->${this.peer} #${++this.n}` };
    this.signalingState = 'have-local-offer';
  }

  async setRemoteDescription(d: SdpInit): Promise<void> {
    await tick();
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable') throw this.fail(`remote offer in ${this.signalingState}`);
      this.remoteDescription = { type: 'offer', sdp: d.sdp ?? '' };
      this.signalingState = 'have-remote-offer';
      return;
    }
    if (this.signalingState !== 'have-local-offer') throw this.fail(`answer in ${this.signalingState}`);
    this.remoteDescription = { type: 'answer', sdp: d.sdp ?? '' };
    this.stableLocal = this.localDescription;
    this.signalingState = 'stable';
  }

  async addIceCandidate(c: CandidateInit): Promise<void> {
    await tick();
    if (!this.remoteDescription) throw this.fail('candidate before the remote description');
    this.added.push(c);
  }

  close(): void {
    this.signalingState = 'closed';
  }

  /** The browser gathered a local candidate. */
  gather(i: number): void {
    this.onicecandidate?.({ candidate: { candidate: `candidate:${i} 1 udp 1 10.0.0.${i} 5000${i} typ host`, sdpMid: '0', sdpMLineIndex: 0 } });
  }

  private fail(msg: string): Error {
    this.errors.push(msg);
    return new Error(msg);
  }
}

interface Wire {
  from: string;
  to: string;
  signal: MediaSignal;
}

/** A network of meshes: `sendTo` queues; `deliver` hands queued signals over (in order, or filtered). */
function network(ids: string[]) {
  const queue: Wire[] = [];
  const pcs: FakePc[] = [];
  const errors: string[] = [];
  const meshes: Record<string, SignalingMesh> = {};
  for (const id of ids) {
    meshes[id] = new SignalingMesh(
      id,
      (peer) => {
        const pc = new FakePc(id, peer);
        pcs.push(pc);
        return pc;
      },
      (to, signal) => queue.push({ from: id, to, signal }),
      (peer, e, where) => errors.push(`${id}/${peer} ${where}: ${String(e)}`),
    );
  }
  const deliver = async (pick: (w: Wire) => boolean = () => true): Promise<number> => {
    let n = 0;
    for (let i = 0; i < queue.length; ) {
      const w = queue[i]!;
      if (!pick(w)) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      n++;
      await meshes[w.to]?.receive(w.from, w.signal);
    }
    return n;
  };
  /** Deliver until quiet. */
  const run = async (pick?: (w: Wire) => boolean): Promise<void> => {
    for (let i = 0; i < 50; i++) {
      await settle(4);
      if ((await deliver(pick)) === 0 && queue.filter(pick ?? (() => true)).length === 0) {
        await settle(4);
        if (queue.filter(pick ?? (() => true)).length === 0) return;
      }
    }
  };
  const pc = (owner: string, peer: string): FakePc => pcs.filter((p) => p.owner === owner && p.peer === peer).pop()!;
  return { queue, pcs, errors, meshes, deliver, run, pc };
}

const paired = (a: FakePc, b: FakePc): boolean =>
  a.signalingState === 'stable' && b.signalingState === 'stable' && a.remoteDescription?.sdp === b.localDescription?.sdp && b.remoteDescription?.sdp === a.localDescription?.sdp;

describe('perfect negotiation (D2)', () => {
  it('polite is the lexically smaller id, the same answer on both sides', () => {
    expect(isPolite('alice', 'bob')).toBe(true);
    expect(isPolite('bob', 'alice')).toBe(false);
    expect(isPolite('B', 'a')).toBe(true); // UTF-16 order, not locale order
  });

  it('glare: both offer at once; the polite side rolls back and answers the impolite offer', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.meshes['b']?.add('a');
    const pa = net.pc('a', 'b');
    const pb = net.pc('b', 'a');
    pa.onnegotiationneeded?.();
    pb.onnegotiationneeded?.();
    await settle();
    expect(net.queue.map((w) => `${w.from}:${w.signal.kind}`).sort()).toEqual(['a:offer', 'b:offer']);
    await net.run();
    expect(paired(pa, pb)).toBe(true);
    // b (impolite) kept its offer: a answered it
    expect(pb.localDescription?.type).toBe('offer');
    expect(pa.localDescription?.type).toBe('answer');
    expect(pa.remoteDescription?.sdp).toMatch(/^offer b->a/);
    expect([...pa.errors, ...pb.errors, ...net.errors]).toEqual([]);
  });

  it('ICE before the answer (and before the offer) waits for the remote description, then is applied in order', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.meshes['b']?.add('a');
    const pa = net.pc('a', 'b');
    const pb = net.pc('b', 'a');
    pa.onnegotiationneeded?.();
    await settle();
    pa.gather(1);
    pa.gather(2);
    // a's candidates reach b before a's offer does
    await net.deliver((w) => w.signal.kind === 'ice');
    expect(net.meshes['b']?.get('a')?.queuedIce).toHaveLength(2);
    await net.deliver((w) => w.signal.kind === 'offer');
    await settle();
    expect(pb.added.map((c) => c.candidate.split(' ')[0])).toEqual(['candidate:1', 'candidate:2']);
    // b's candidates overtake b's answer
    pb.gather(3);
    await net.deliver((w) => w.signal.kind === 'ice');
    expect(net.meshes['a']?.get('b')?.queuedIce).toHaveLength(1);
    await net.run();
    expect(pa.added.map((c) => c.candidate.split(' ')[0])).toEqual(['candidate:3']);
    expect(paired(pa, pb)).toBe(true);
    expect([...pa.errors, ...pb.errors, ...net.errors]).toEqual([]);
  });

  it('the end-of-candidates null and empty candidates are not sent', () => {
    const sent: MediaSignal[] = [];
    const pc = new FakePc('a', 'b');
    new PeerNegotiator(pc, true, (s) => sent.push(s));
    pc.onicecandidate?.({ candidate: null });
    pc.onicecandidate?.({ candidate: { candidate: '' } });
    pc.onicecandidate?.({ candidate: { candidate: 'candidate:9 1 udp 1 1.2.3.4 9 typ host' } });
    expect(sent).toEqual([{ kind: 'ice', candidate: { candidate: 'candidate:9 1 udp 1 1.2.3.4 9 typ host', sdpMid: null, sdpMLineIndex: null } }]);
  });

  it('a peer re-added after a drop (A3) negotiates on a fresh connection; the old one is closed', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.meshes['b']?.add('a');
    net.pc('a', 'b').onnegotiationneeded?.();
    await net.run();
    const oldA = net.pc('a', 'b');
    expect(paired(oldA, net.pc('b', 'a'))).toBe(true);

    // Only a noticed the drop: a re-opens, b's existing connection takes the new offer as a renegotiation.
    net.meshes['a']?.add('b');
    expect(oldA.signalingState).toBe('closed');
    const newA = net.pc('a', 'b');
    expect(newA).not.toBe(oldA);
    newA.onnegotiationneeded?.();
    await net.run();
    expect(paired(newA, net.pc('b', 'a'))).toBe(true);

    // Both noticed: both re-open and both offer (glare on fresh connections).
    net.meshes['a']?.add('b');
    net.meshes['b']?.add('a');
    net.pc('a', 'b').onnegotiationneeded?.();
    net.pc('b', 'a').onnegotiationneeded?.();
    await net.run();
    expect(paired(net.pc('a', 'b'), net.pc('b', 'a'))).toBe(true);
    expect(net.errors).toEqual([]);
  });

  it('a stale answer (for an offer that was rolled back or belongs to an old connection) is ignored', async () => {
    const pc = new FakePc('a', 'b');
    const n = new PeerNegotiator(pc, true, () => undefined);
    await n.receive({ kind: 'answer', sdp: 'answer b->a #1' });
    expect(pc.errors).toEqual([]);
    expect(pc.remoteDescription).toBeNull();
  });

  it('an offer that got no answer is sent again by resendOffer, and the peer answers it', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.pc('a', 'b').onnegotiationneeded?.();
    await settle();
    net.queue.length = 0; // lost: b was not listening yet
    net.meshes['b']?.add('a');
    expect(net.meshes['a']?.get('b')?.resendOffer()).toBe(true);
    await net.run();
    expect(paired(net.pc('a', 'b'), net.pc('b', 'a'))).toBe(true);
    expect(net.meshes['a']?.get('b')?.resendOffer()).toBe(false); // stable: nothing outstanding
  });

  it('signals from a peer that is not added yet are held and replayed when it is', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.pc('a', 'b').onnegotiationneeded?.();
    await settle();
    net.pc('a', 'b').gather(1);
    await net.deliver(); // b has no connection to a yet
    expect(net.meshes['b']?.early.get('a')).toHaveLength(2);
    net.meshes['b']?.add('a');
    await net.run();
    expect(paired(net.pc('a', 'b'), net.pc('b', 'a'))).toBe(true);
    expect(net.pc('b', 'a').added).toHaveLength(1);
  });

  it('3-peer mesh: every signal reaches the one connection it names, and all three pairs connect', async () => {
    const ids = ['a', 'b', 'c'];
    const net = network(ids);
    for (const id of ids) for (const other of ids) if (other !== id) net.meshes[id]?.add(other);
    expect(net.meshes['a']?.add('a')).toBeNull();
    for (const p of [...net.pcs]) p.onnegotiationneeded?.();
    await settle();
    for (const p of [...net.pcs]) p.gather(p.owner.charCodeAt(0));
    await net.run();
    for (const [x, y] of [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ] as const) {
      const px = net.pc(x, y);
      const py = net.pc(y, x);
      expect(paired(px, py), `${x}<->${y}`).toBe(true);
      // the descriptions each holds came from the right peer's connection to it
      expect(px.remoteDescription?.sdp).toContain(`${y}->${x}`);
      expect(py.remoteDescription?.sdp).toContain(`${x}->${y}`);
      expect(px.added.every((c) => c.candidate.includes(`10.0.0.${y.charCodeAt(0)} `))).toBe(true);
    }
    expect(net.errors).toEqual([]);
    expect(net.meshes['b']?.ids().sort()).toEqual(['a', 'c']);
    net.meshes['b']?.close();
    expect(net.meshes['b']?.ids()).toEqual([]);
  });

  it('the embedded page source (negotiationSource) is self-contained and negotiates the same way', async () => {
    const lib = new Function(`${negotiationSource()}\nreturn { isPolite, PeerNegotiator, SignalingMesh };`)() as {
      SignalingMesh: typeof SignalingMesh;
    };
    const queue: Wire[] = [];
    const pcs: Record<string, FakePc> = {};
    const mk = (id: string) =>
      new lib.SignalingMesh(
        id,
        (peer) => (pcs[`${id}${peer}`] = new FakePc(id, peer)),
        (to, signal) => queue.push({ from: id, to, signal }),
      );
    const m: Record<string, SignalingMesh> = { a: mk('a'), b: mk('b') };
    m['a']?.add('b');
    m['b']?.add('a');
    pcs['ab']?.onnegotiationneeded?.();
    pcs['ba']?.onnegotiationneeded?.();
    for (let i = 0; i < 20; i++) {
      await settle(3);
      for (const w of queue.splice(0)) await m[w.to]?.receive(w.from, w.signal);
    }
    expect(paired(pcs['ab']!, pcs['ba']!)).toBe(true);
  });
});
