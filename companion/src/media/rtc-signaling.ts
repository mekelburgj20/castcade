/**
 * D2 (alpha-match.md §4, 2026-10-30): WebRTC "perfect negotiation" for the match mesh, one `PeerNegotiator` per remote
 * player, and `SignalingMesh` to address them. Pure: it drives anything shaped like an `RTCPeerConnection`, so vitest
 * runs it on fakes and the panel page runs the same code on the real thing. The page cannot import a module (it is a
 * file written to userData, `panel-page.ts`), so it embeds these classes' own source: they must stay self-contained,
 * referencing nothing at module scope except each other and `isPolite` (`NEGOTIATION_SOURCE` below).
 *
 * The rules (W3C perfect-negotiation example): both sides add their tracks and offer whenever the browser says
 * negotiation is needed; when two offers cross, the polite peer (the lexically smaller player id) rolls its own back
 * and answers, the impolite one ignores the other's offer. Signals of one peer are applied strictly in arrival order;
 * ICE candidates that arrive before the remote description wait for it.
 */
import type { MatchPlayerId, MediaSignal } from './match-media-types.js';

export interface SdpInit {
  type: 'offer' | 'answer' | 'rollback';
  sdp?: string;
}

export interface CandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** The part of `RTCPeerConnection` negotiation needs. */
export interface NegotiablePc {
  readonly signalingState: string;
  readonly localDescription: { type: string; sdp: string } | null;
  readonly remoteDescription: { type: string; sdp: string } | null;
  setLocalDescription(d?: SdpInit): Promise<void>;
  setRemoteDescription(d: SdpInit): Promise<void>;
  addIceCandidate(c: CandidateInit): Promise<void>;
  onnegotiationneeded?: (() => void) | null;
  onicecandidate?: ((ev: { candidate: CandidateInit | null }) => void) | null;
  close?(): void;
}

/** Who rolls back when two offers cross: the lexically smaller id (UTF-16 order, the same on every machine). */
export function isPolite(localId: MatchPlayerId, remoteId: MatchPlayerId): boolean {
  return localId < remoteId;
}

export class PeerNegotiator {
  /** Candidates held for a peer whose remote description is not set yet; more than this is a broken peer. */
  static MAX_QUEUED_ICE = 200;
  makingOffer = false;
  ignoreOffer = false;
  closed = false;
  /** Remote candidates waiting for the remote description. */
  queuedIce: CandidateInit[] = [];
  chain: Promise<void> = Promise.resolve();
  pc: NegotiablePc;
  polite: boolean;
  send: (s: MediaSignal) => void;
  onError: (e: unknown, where: string) => void;

  constructor(pc: NegotiablePc, polite: boolean, send: (s: MediaSignal) => void, onError?: (e: unknown, where: string) => void) {
    this.pc = pc;
    this.polite = polite;
    this.send = send;
    this.onError = onError ?? (() => undefined);
    pc.onnegotiationneeded = () => void this.negotiationNeeded();
    pc.onicecandidate = (ev) => this.localCandidate(ev.candidate);
  }

  /** `negotiationneeded`: make an offer (the browser builds it from the transceivers) and send it. */
  async negotiationNeeded(): Promise<void> {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const d = this.pc.localDescription;
      if (!this.closed && d && d.type === 'offer') this.send({ kind: 'offer', sdp: d.sdp });
    } catch (e) {
      this.onError(e, 'offer');
    } finally {
      this.makingOffer = false;
    }
  }

  /** `icecandidate`: trickle it (the end-of-candidates null and empty lines are not sent). */
  localCandidate(c: CandidateInit | null): void {
    if (this.closed || !c || !c.candidate) return;
    this.send({ kind: 'ice', candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } });
  }

  /** A signal from the remote peer. Applied after every earlier one; the promise never rejects. */
  receive(signal: MediaSignal): Promise<void> {
    const run = this.chain.then(() => this.apply(signal));
    this.chain = run.catch(() => undefined);
    return this.chain;
  }

  /**
   * An offer that got no answer (lost on a reconnect, or the peer was not listening yet) is sent again. A peer that
   * already applied it answers again; one that is offering itself resolves the collision as usual. Call it on a timer
   * while the connection is not up.
   */
  resendOffer(): boolean {
    const d = this.pc.localDescription;
    if (this.closed || this.makingOffer || this.pc.signalingState !== 'have-local-offer' || !d || d.type !== 'offer') return false;
    this.send({ kind: 'offer', sdp: d.sdp });
    return true;
  }

  close(): void {
    this.closed = true;
    this.queuedIce = [];
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
  }

  async apply(signal: MediaSignal): Promise<void> {
    if (this.closed) return;
    if (signal.kind === 'ice') {
      const c = signal.candidate;
      if (!c) return;
      if (!this.pc.remoteDescription) {
        if (this.queuedIce.length < PeerNegotiator.MAX_QUEUED_ICE) this.queuedIce.push(c);
        return;
      }
      try {
        await this.pc.addIceCandidate(c);
      } catch (e) {
        // A candidate of an offer we ignored fails by design.
        if (!this.ignoreOffer) this.onError(e, 'ice');
      }
      return;
    }
    if (signal.sdp === undefined) return;
    const offerCollision = signal.kind === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;
    // An answer with no offer of ours outstanding is stale: one for an offer we rolled back, or an old connection's.
    if (signal.kind === 'answer' && this.pc.signalingState !== 'have-local-offer') return;
    try {
      if (offerCollision) await this.pc.setLocalDescription({ type: 'rollback' });
      await this.pc.setRemoteDescription({ type: signal.kind, sdp: signal.sdp });
      await this.flushIce();
      if (signal.kind === 'offer') {
        await this.pc.setLocalDescription();
        const d = this.pc.localDescription;
        if (!this.closed && d && d.type === 'answer') this.send({ kind: 'answer', sdp: d.sdp });
      }
    } catch (e) {
      this.onError(e, signal.kind);
    }
  }

  async flushIce(): Promise<void> {
    const held = this.queuedIce;
    this.queuedIce = [];
    for (const c of held) {
      if (this.closed) return;
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        // Held across a rollback, a candidate can belong to a description that is gone; the next one will not.
      }
    }
  }
}

/** One `PeerNegotiator` per remote player, addressed by player id: the panel page's whole mesh. */
export class SignalingMesh {
  /** Signals from a peer not added yet (it attached first) are held this many per peer, then replayed on `add`. */
  static MAX_EARLY_SIGNALS = 64;
  localId: MatchPlayerId;
  open: (peer: MatchPlayerId) => NegotiablePc;
  sendTo: (to: MatchPlayerId, s: MediaSignal) => void;
  onError: (peer: MatchPlayerId, e: unknown, where: string) => void;
  peers: Map<MatchPlayerId, PeerNegotiator> = new Map();
  early: Map<MatchPlayerId, MediaSignal[]> = new Map();

  constructor(
    localId: MatchPlayerId,
    open: (peer: MatchPlayerId) => NegotiablePc,
    sendTo: (to: MatchPlayerId, s: MediaSignal) => void,
    onError?: (peer: MatchPlayerId, e: unknown, where: string) => void,
  ) {
    this.localId = localId;
    this.open = open;
    this.sendTo = sendTo;
    this.onError = onError ?? (() => undefined);
  }

  /** Open (or, for a peer that dropped and came back, re-open) the connection to `peer`. */
  add(peer: MatchPlayerId): PeerNegotiator | null {
    if (peer === this.localId) return null;
    const held = this.early.get(peer) ?? [];
    this.remove(peer);
    const n = new PeerNegotiator(
      this.open(peer),
      isPolite(this.localId, peer),
      (s) => this.sendTo(peer, s),
      (e, where) => this.onError(peer, e, where),
    );
    this.peers.set(peer, n);
    for (const s of held) void n.receive(s);
    return n;
  }

  remove(peer: MatchPlayerId): boolean {
    const n = this.peers.get(peer);
    this.early.delete(peer);
    if (!n) return false;
    n.close();
    this.peers.delete(peer);
    try {
      n.pc.close?.();
    } catch {
      // already closed
    }
    return true;
  }

  receive(from: MatchPlayerId, signal: MediaSignal): Promise<void> {
    const n = this.peers.get(from);
    if (n) return n.receive(signal);
    if (from === this.localId) return Promise.resolve();
    const held = this.early.get(from) ?? [];
    if (held.length < SignalingMesh.MAX_EARLY_SIGNALS) held.push(signal);
    this.early.set(from, held);
    return Promise.resolve();
  }

  get(peer: MatchPlayerId): PeerNegotiator | undefined {
    return this.peers.get(peer);
  }

  ids(): MatchPlayerId[] {
    return [...this.peers.keys()];
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.remove(id);
    this.early.clear();
  }
}

/** The classes as plain JS for the panel page's `<script>` (see the header): one source, no second copy to drift. */
export function negotiationSource(): string {
  return [isPolite, PeerNegotiator, SignalingMesh].map((x) => x.toString()).join('\n');
}
