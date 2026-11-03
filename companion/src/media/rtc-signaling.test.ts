import { describe, expect, it } from 'vitest';
import type { MediaSignal } from './match-media-types.js';
import { isPolite, leadsIceRestart, negotiationSource, PeerNegotiator, SignalingMesh, type CandidateInit, type NegotiablePc, type SdpInit } from './rtc-signaling.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const settle = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

/**
 * A strict stand-in for RTCPeerConnection's signalling state machine: it throws where the browser would throw
 * (a remote offer over a local one, an answer with no offer, a candidate before the remote description), so the
 * negotiator's explicit rollback and its ICE queue are what make the tests pass. D2.7 (2026-11-01): each description
 * names the connection that made it (`pc<n>`), and a remote offer from another connection than the one this one already
 * negotiated with is refused the way Chromium refused it on the owner's rig (m-lines in another order).
 */
const pcTag = (sdp: string | undefined): string => /\bpc\d+\b/.exec(sdp ?? '')?.[0] ?? '';
const MLINE_ERROR = "Failed to set remote offer sdp: The order of m-lines in subsequent offer doesn't match order from previous offer/answer.";
class FakePc implements NegotiablePc {
  private static serial = 0;
  readonly tag = `pc${++FakePc.serial}`;
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
      this.localDescription = { type: 'answer', sdp: `answer ${this.owner}->${this.peer} ${this.tag} #${++this.n}` };
      this.stableLocal = this.localDescription;
      this.signalingState = 'stable';
      return;
    }
    this.localDescription = { type: 'offer', sdp: `offer ${this.owner}->${this.peer} ${this.tag} #${++this.n}` };
    this.signalingState = 'have-local-offer';
  }

  async setRemoteDescription(d: SdpInit): Promise<void> {
    await tick();
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable') throw this.fail(`remote offer in ${this.signalingState}`);
      if (this.remoteDescription && pcTag(this.remoteDescription.sdp) !== pcTag(d.sdp)) throw this.fail(MLINE_ERROR);
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

  /** D2.9: like the browser, a restart asks for negotiation (queued, not inside the call). */
  restarts = 0;
  restartIce(): void {
    this.restarts++;
    setImmediate(() => this.onnegotiationneeded?.());
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
  const reopens: string[] = [];
  const mesh = (id: string): SignalingMesh => {
    const m = new SignalingMesh(
      id,
      (peer) => {
        const pc = new FakePc(id, peer);
        pcs.push(pc);
        return pc;
      },
      (to, signal) => queue.push({ from: id, to, signal }),
      (peer, e, where) => errors.push(`${id}/${peer} ${where}: ${String(e)}`),
    );
    m.onReopen = (peer, why) => reopens.push(`${id}/${peer} ${why}`);
    return m;
  };
  for (const id of ids) meshes[id] = mesh(id);
  /** D2.7: `id` rebuilt its panel page: a new mesh with no connections (the old page and its connections are gone). */
  const rebuild = (id: string): SignalingMesh => {
    meshes[id]?.close();
    meshes[id] = mesh(id);
    return meshes[id];
  };
  const pc = (owner: string, peer: string): FakePc => pcs.filter((p) => p.owner === owner && p.peer === peer).pop()!;
  return { queue, pcs, errors, meshes, deliver, run, pc, rebuild, reopens };
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

    // Only a noticed the drop: a re-opens; b's existing connection refuses the new connection's offer (D2.7), so b
    // re-opens too and the fresh one takes it.
    const oldB = net.pc('b', 'a');
    net.meshes['a']?.add('b');
    expect(oldA.signalingState).toBe('closed');
    const newA = net.pc('a', 'b');
    expect(newA).not.toBe(oldA);
    newA.onnegotiationneeded?.();
    await net.run();
    expect(net.pc('b', 'a')).not.toBe(oldB);
    expect(oldB.signalingState).toBe('closed');
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

  it('D2.7: a fresh offer onto an established connection (the peer rebuilt its page) reopens, and the pair ends connected', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.meshes['b']?.add('a');
    net.pc('a', 'b').onnegotiationneeded?.();
    await net.run();
    const oldB = net.pc('b', 'a');
    expect(paired(net.pc('a', 'b'), oldB)).toBe(true);

    // a's panel moved into the headset: a new page, a new connection, an offer and its ICE, no reset (an old companion).
    net.rebuild('a').add('b');
    const freshA = net.pc('a', 'b');
    freshA.onnegotiationneeded?.();
    await settle();
    freshA.gather(7);
    await net.run();
    expect(oldB.errors).toEqual([MLINE_ERROR]);
    expect(oldB.signalingState).toBe('closed');
    const freshB = net.pc('b', 'a');
    expect(freshB).not.toBe(oldB);
    expect(paired(freshA, freshB)).toBe(true);
    // the candidate queued behind the refused offer followed it to the fresh connection
    expect(freshB.added.map((c) => c.candidate)).toEqual([expect.stringContaining('10.0.0.7 ')]);
    expect(net.reopens).toEqual(['b/a stale_offer']);
    expect(net.errors).toEqual([]);
  });

  it('D2.7: a reset before the fresh offer reopens first: nothing is refused, crossing offers settle, the pair connects', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.meshes['b']?.add('a');
    net.pc('b', 'a').onnegotiationneeded?.();
    await net.run();
    const oldB = net.pc('b', 'a');

    // the rebuilt side says reset first (the page does, `PanelAttach.reset`), then offers
    net.queue.push({ from: 'a', to: 'b', signal: { kind: 'reset' } });
    net.rebuild('a').add('b');
    const freshA = net.pc('a', 'b');
    freshA.onnegotiationneeded?.();
    await settle();
    await net.deliver((w) => w.signal.kind === 'reset');
    expect(oldB.signalingState).toBe('closed');
    // b's fresh connection offers too (its tracks): glare on fresh connections, resolved as usual
    net.pc('b', 'a').onnegotiationneeded?.();
    await net.run();
    expect(oldB.errors).toEqual([]);
    expect(paired(freshA, net.pc('b', 'a'))).toBe(true);
    expect(net.reopens).toEqual(['b/a reset']);
    expect(net.errors).toEqual([]);
  });

  it('D2.7: a reset from a peer not added yet drops what it sent before; stereo signals never touch the connection', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.pc('a', 'b').onnegotiationneeded?.();
    await settle();
    await net.deliver();
    expect(net.meshes['b']?.early.get('a')).toHaveLength(1);
    await net.meshes['b']?.receive('a', { kind: 'reset' });
    expect(net.meshes['b']?.early.has('a')).toBe(false);
    expect(net.reopens).toEqual([]);
    const pc = new FakePc('a', 'b');
    const n = new PeerNegotiator(pc, true, () => undefined);
    await n.receive({ kind: 'stereo', stereo: 'sbs' });
    await n.receive({ kind: 'reset' });
    expect(pc.signalingState).toBe('stable');
    expect(pc.errors).toEqual([]);
  });

  it('a stale answer (for an offer that was rolled back or belongs to an old connection) is ignored', async () => {
    const pc = new FakePc('a', 'b');
    const n = new PeerNegotiator(pc, true, () => undefined);
    await n.receive({ kind: 'answer', sdp: 'answer b->a pc0 #1' });
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

  it('D2.9: exactly one side of a pair leads an ICE restart, the impolite one', () => {
    expect(leadsIceRestart('alice', 'bob')).toBe(false);
    expect(leadsIceRestart('bob', 'alice')).toBe(true);
    for (const [x, y] of [['a', 'b'], ['B', 'a'], ['p1', 'p10']] as const) expect(leadsIceRestart(x, y) !== leadsIceRestart(y, x)).toBe(true);
  });

  it('D2.9: an ICE restart renegotiates on the same connections: no reopen, the pair stable again', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.meshes['b']?.add('a');
    net.pc('a', 'b').onnegotiationneeded?.();
    await net.run();
    const pa = net.pc('a', 'b');
    const pb = net.pc('b', 'a');
    expect(paired(pa, pb)).toBe(true);
    // b leads (impolite): its restart offer is answered by a's existing connection.
    expect(net.meshes['b']?.get('a')?.restartIce()).toBe(true);
    await net.run();
    expect(pb.restarts).toBe(1);
    expect(net.pc('a', 'b')).toBe(pa);
    expect(net.pc('b', 'a')).toBe(pb);
    expect(paired(pa, pb)).toBe(true);
    expect(pb.localDescription?.type).toBe('offer');
    expect(net.reopens).toEqual([]);
    expect([...pa.errors, ...pb.errors, ...net.errors]).toEqual([]);
  });

  it('D2.9: both sides restarting at once settle by the glare rule, still on the same connections', async () => {
    const net = network(['a', 'b']);
    net.meshes['a']?.add('b');
    net.meshes['b']?.add('a');
    net.pc('b', 'a').onnegotiationneeded?.();
    await net.run();
    const pa = net.pc('a', 'b');
    const pb = net.pc('b', 'a');
    net.meshes['a']?.get('b')?.restartIce();
    net.meshes['b']?.get('a')?.restartIce();
    await net.run();
    expect(net.pc('a', 'b')).toBe(pa);
    expect(net.pc('b', 'a')).toBe(pb);
    expect(paired(pa, pb)).toBe(true);
    expect(net.reopens).toEqual([]);
    expect(net.errors).toEqual([]);
  });

  it('D2.9: restartIce on a closed negotiator, or a connection without restartIce, does nothing', () => {
    const plain: NegotiablePc = {
      signalingState: 'stable',
      localDescription: null,
      remoteDescription: null,
      setLocalDescription: () => Promise.resolve(),
      setRemoteDescription: () => Promise.resolve(),
      addIceCandidate: () => Promise.resolve(),
    };
    expect(new PeerNegotiator(plain, true, () => undefined).restartIce()).toBe(false);
    const pc = new FakePc('a', 'b');
    const n = new PeerNegotiator(pc, false, () => undefined);
    n.close();
    expect(n.restartIce()).toBe(false);
    expect(pc.restarts).toBe(0);
  });
});
