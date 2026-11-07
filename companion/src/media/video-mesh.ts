/**
 * D10.3 (2026-11-07, docs/design/spectator-video-native.md §6.4): the native spectator-video mesh. One helper peer
 * (`castcade-video.exe`, `video-helper.ts`) per remote participant for the match's life; the lower player id makes the
 * offer (`initiates`: the rule `isPolite` in rtc-signaling.ts already encodes, the same answer on both rigs); the
 * helper's `signal` events go out as `MEDIA_SIGNAL {to, channel: 'video', ...}` through the `video` side of
 * `splitSignalling`, and that side's signals come back in through `onSignal`. Pure: no Electron, no sockets; the
 * match host owns it and drives it from the turn (`setSending`), the rig (`setSource`, `setSink`) and the media
 * settings (`setIce`, `setRungs`).
 *
 * Rules:
 *   - the wanted state is the whole truth (peers, sending, source, sink, ICE, rungs); only the difference from what the
 *     running helper was told goes out, and a helper that restarts (its `ready` again) is told it all again, peers
 *     included (their connections died with it: the other side's helper sees ICE fail and the match host there keeps
 *     its peer; our fresh `peer` command offers or waits as the rule says);
 *   - a signal for a peer the helper has not been told yet (the roster names its sender after their first offer, or
 *     the helper is not ready) is held, at most `MAX_HELD_SIGNALS` per sender and `MAX_HELD_SENDERS` senders, and
 *     replayed in order after the `peer` command; a sender who never makes the roster is forgotten at `close`;
 *   - a helper event for a player who is not in the roster is ignored;
 *   - `close()` closes every peer, stops sending and clears the source and sink (the helper itself stays up for the
 *     next match; the shell stops it at quit).
 * Nothing here ever blocks a match: the status says what the helper is doing; the Electron path serves the rest.
 */
import type { MatchPlayerId, MediaSignal, NativeVideoRung, NativeVideoRungState, NativeVideoStats, NativeVideoStatus } from './match-media-types.js';
import type { IceServer } from './media-settings.js';
import { isPolite } from './rtc-signaling.js';
import type { VideoHelper, VideoHelperEvent, VideoHelperStatus, VideoIceServer, VideoSignalKind, VideoSink, VideoSource, VideoStatsEvent } from './video-helper.js';

export const MAX_HELD_SIGNALS = 64;
/** Senders whose signals are held before the roster names them (a match has at most three others; the rest is noise). */
export const MAX_HELD_SENDERS = 8;
/** §3 item 4: the top rung, 20 Mbps: the default ceiling. */
export const DEFAULT_MAX_KBPS = 20_000;
/** The ceiling's range as the Match tab and media.json accept it (kbps). */
export const MIN_MAX_KBPS = 500;
export const MAX_MAX_KBPS = 50_000;

/**
 * D10.5: the six rungs (video-helper/src/ladder.h is the one the helper applies; the numbers must agree): a fraction
 * of the source's height (aspect kept, even sizes), a frame rate and a bitrate, ordered the owner's way ("we would
 * sacrifice resolution for smoothness"): full size at 30 fps comes before the smaller size at 60.
 */
export const LADDER: ReadonlyArray<{ scale: number; fps: number; kbps: number }> = [
  { scale: 1, fps: 60, kbps: 20_000 },
  { scale: 1, fps: 30, kbps: 10_000 },
  { scale: 0.75, fps: 60, kbps: 8_000 },
  { scale: 0.75, fps: 30, kbps: 5_000 },
  { scale: 0.5, fps: 60, kbps: 4_000 },
  { scale: 0.5, fps: 30, kbps: 2_000 },
];
/** The design's eye (spectator-video-native.md §3): the ladder shown before this rig's source box is known. */
export const DEFAULT_SOURCE_BOX = { width: 1354, height: 1440 } as const;

const even = (v: number): number => {
  const n = Math.round(v);
  return Math.max(2, n % 2 ? n + 1 : n);
};

/** One rung's geometry for a source box, as the helper computes it (`RungFor`): 677 rounds up to 678. */
export function rungGeometry(rung: number, width: number, height: number): NativeVideoRung {
  const r = Math.min(LADDER.length, Math.max(1, Math.round(rung)));
  const spec = LADDER[r - 1]!;
  return { rung: r, width: width > 0 ? even(width * spec.scale) : 0, height: height > 0 ? even(height * spec.scale) : 0, fps: spec.fps, kbps: spec.kbps };
}

/** The whole ladder for a source box (the design's box when the source has none yet). */
export function ladderFor(width: number, height: number): NativeVideoRung[] {
  const w = width > 0 && height > 0 ? width : DEFAULT_SOURCE_BOX.width;
  const h = width > 0 && height > 0 ? height : DEFAULT_SOURCE_BOX.height;
  return LADDER.map((_, i) => rungGeometry(i + 1, w, h));
}

/** The ceiling as the helper takes it: an integer in [MIN_MAX_KBPS, MAX_MAX_KBPS]; anything else is the default. */
export function clampMaxKbps(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_MAX_KBPS;
  return Math.min(MAX_MAX_KBPS, Math.max(MIN_MAX_KBPS, Math.round(v)));
}

/** A pin as the helper takes it: an integer rung 1..6, or null. */
export function clampPin(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const r = Math.round(v);
  return r >= 1 && r <= LADDER.length ? r : null;
}

/** Mbps with one decimal, for the readouts. */
export const mbps = (kbps: number): string => `${(kbps / 1000).toFixed(1)} Mbps`;

/**
 * D10.5: the Match tab's readout: `Auto (rung 3: 1016x1080 at 60 fps, 7.8 Mbps)` or `Pinned to rung 2: …`, from the
 * rung in force for the peer we send to (the first peer with one) and the sent kbps when sending; the nominal kbps
 * otherwise. `Auto (rung 3 to start)` before the helper said anything.
 */
export function rungReadout(s: Pick<NativeVideoStatus, 'pin' | 'peers' | 'sending' | 'ladder'>): string {
  const mode = s.pin === null ? 'Auto' : `Pinned to rung ${s.pin}`;
  const peers = Object.values(s.peers);
  const inForce = peers.map((p) => p.rung).find((r) => r !== null) ?? null;
  const sent = s.sending ? (peers.map((p) => p.send).find((x) => x && x.width > 0) ?? null) : null;
  if (!inForce) {
    const g = s.ladder[2];
    return `${mode} (rung ${s.pin ?? 3} to start${g && s.pin === null ? `: ${g.width}x${g.height} at ${g.fps} fps` : ''})`;
  }
  const rate = sent ? mbps(sent.kbps) : `up to ${mbps(inForce.kbps)}`;
  const why = inForce.reason.startsWith('down:') ? `, stepped down on ${inForce.reason.slice(5)}` : inForce.reason === 'ceiling' ? ', at the ceiling' : '';
  return `${mode} (rung ${inForce.rung}: ${inForce.width}x${inForce.height} at ${sent ? sent.fps : inForce.fps} fps, ${rate}${why})`;
}

/**
 * D10.5: the headset panel's one line (`setVideoLine`): while sending, the rung in force and what goes out
 * (`video: rung 3 · 1016x1080@60 · 7.8 Mbps · rtt 41 ms`); while a picture arrives, what comes in
 * (`video: in 1016x1080 · 60 fps · 7.8 Mbps`); null when there is nothing to say.
 */
export function headsetVideoLine(s: Pick<NativeVideoStatus, 'helper' | 'sending' | 'peers'>): string | null {
  if (s.helper !== 'ready') return null;
  const peers = Object.values(s.peers);
  if (s.sending) {
    const r = peers.map((p) => p.rung).find((x) => x !== null) ?? null;
    const sent = peers.map((p) => p.send).find((x) => x && x.width > 0) ?? null;
    if (!r && !sent) return 'video: starting';
    const parts = [r ? `rung ${r.rung}` : null, sent ? `${sent.width}x${sent.height}@${sent.fps}` : r ? `${r.width}x${r.height}@${r.fps}` : null, sent ? mbps(sent.kbps) : null, sent?.rttMs != null ? `rtt ${Math.round(sent.rttMs)} ms` : null];
    return `video: ${parts.filter((x) => x).join(' · ')}`;
  }
  const inbound = peers.map((p) => p.recv).find((x) => x && x.width > 0 && x.fps > 0) ?? null;
  if (!inbound) return null;
  return `video: in ${inbound.width}x${inbound.height} · ${inbound.fps} fps · ${mbps(inbound.kbps)}`;
}

/** Who makes the offer for a pair: the lexically smaller id (UTF-16 order, the same on every machine). */
export function initiates(localId: MatchPlayerId, remoteId: MatchPlayerId): boolean {
  return isPolite(localId, remoteId);
}

/**
 * The selected candidate pair for the Match tab's connectivity line: the helper sends a string (`"srflx<->host"`) or
 * an object with `local` / `remote` (each a string type or `{type}`); either becomes `local↔remote`. Null when none.
 */
export function pairWords(pair: unknown): string | null {
  if (typeof pair === 'string') return pair.trim() ? pair.replace(/<->|->|-/, '↔') : null;
  if (typeof pair !== 'object' || pair === null) return null;
  const p = pair as { local?: unknown; remote?: unknown };
  const side = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string' ? (v as { type: string }).type : null);
  const l = side(p.local);
  const r = side(p.remote);
  return l && r ? `${l}↔${r}` : null;
}

/** `iceServers()` from media-settings as the helper takes it (`urls` always a list). */
export function helperIceServers(servers: IceServer[]): VideoIceServer[] {
  return servers.map((s) => {
    const out: VideoIceServer = { urls: Array.isArray(s.urls) ? [...s.urls] : [s.urls] };
    if (s.username !== undefined) out.username = s.username;
    if (s.credential !== undefined) out.credential = s.credential;
    return out;
  });
}

export interface VideoRungs {
  max_kbps: number;
  /** 1..6 pins the rung; null or absent: the helper's controller chooses. */
  pin?: number | null;
}

export interface VideoMeshOptions {
  helper: VideoHelper;
  localId: MatchPlayerId;
  /** The `video` side of `splitSignalling`: what goes out as MEDIA_SIGNAL `{to, channel: 'video', ...}`. */
  sendSignal: (to: MatchPlayerId, signal: MediaSignal) => void;
  log: (line: string) => void;
}

export interface VideoMesh {
  /** The roster without this player: a helper peer per id, closed when an id leaves. */
  setPeers(ids: MatchPlayerId[]): void;
  /** A `channel: 'video'` signal from `from`, relayed to the helper's peer for them. */
  onSignal(from: MatchPlayerId, signal: MediaSignal): void;
  /** This rig is the player up: the encoder runs and the video sender is active. */
  setSending(on: boolean): void;
  setSource(source: VideoSource): void;
  setSink(sink: VideoSink): void;
  /** The ICE servers for every peer made after this (media-settings `iceServers()`), at start and on change. */
  setIce(servers: IceServer[]): void;
  setRungs(rungs: VideoRungs): void;
  status(): NativeVideoStatus;
  onStatus(cb: (s: NativeVideoStatus) => void): () => void;
  /** Close every peer, stop sending, clear the source and sink, stop listening to the helper. */
  close(): void;
}

type PeerView = NativeVideoStatus['peers'][string];

const statsOf = (e: VideoStatsEvent): NativeVideoStats => ({
  fps: num(e.fps),
  kbps: num(e.kbps),
  width: num(e.width),
  height: num(e.height),
  ...(e.rtt_ms !== undefined ? { rttMs: e.rtt_ms } : {}),
  ...(e.loss_pct !== undefined ? { lossPct: e.loss_pct } : {}),
  ...(e.bwe_kbps !== undefined ? { bweKbps: e.bwe_kbps } : {}),
  ...(e.quality_limitation !== undefined ? { qualityLimitation: e.quality_limitation } : {}),
  ...(typeof e.rung === 'number' ? { rung: e.rung } : {}),
  ...(typeof e.ctrl === 'string' ? { ctrl: e.ctrl } : {}),
});
const emptyPeer = (): PeerView => ({ ice: 'new', pair: null, send: null, recv: null, rung: null });
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sourceBox = (s: VideoSource): { width: number; height: number; fps: number } => (s.kind === 'none' ? { width: 0, height: 0, fps: 0 } : { width: s.width, height: s.height, fps: s.fps });

export function createVideoMesh(o: VideoMeshOptions): VideoMesh {
  const { helper, localId, log } = o;
  const listeners = new Set<(s: NativeVideoStatus) => void>();
  // ---- wanted ----
  const wantPeers = new Set<MatchPlayerId>();
  let wantSending = false;
  let wantSource: VideoSource = { kind: 'none' };
  let wantSink: VideoSink = { kind: 'none' };
  let wantIce: VideoIceServer[] = [];
  let wantRungs: VideoRungs = { max_kbps: DEFAULT_MAX_KBPS };
  // ---- told to the running helper (null: not told since its last `ready`) ----
  const toldPeers = new Set<MatchPlayerId>();
  let toldSending: boolean | null = null;
  let toldSource: string | null = null;
  let toldSink: string | null = null;
  let toldIce: string | null = null;
  let toldRungs: string | null = null;
  // ---- what the helper says ----
  const peerViews = new Map<MatchPlayerId, PeerView>();
  const held = new Map<MatchPlayerId, MediaSignal[]>();
  let sourceState: { state: 'ok' | 'missing' | 'dead'; fpsIn: number } | null = null;
  let helperStatus: VideoHelperStatus = helper.status();
  let closed = false;
  let current: NativeVideoStatus | null = null;

  const computed = (): NativeVideoStatus => ({
    helper: helperStatus.helper,
    reason: helperStatus.reason,
    encoder: helperStatus.encoder,
    decoder: helperStatus.decoder,
    sending: wantSending,
    source: { kind: wantSource.kind, ...sourceBox(wantSource), state: sourceState?.state ?? null, fpsIn: sourceState?.fpsIn ?? null },
    sink: wantSink.kind,
    ladder: ladderFor(wantSource.kind === 'none' ? 0 : wantSource.width, wantSource.kind === 'none' ? 0 : wantSource.height),
    maxKbps: wantRungs.max_kbps,
    pin: wantRungs.pin ?? null,
    peers: Object.fromEntries([...wantPeers].map((id) => [id, peerViews.get(id) ?? emptyPeer()])),
  });
  const emit = (): void => {
    const s = computed();
    if (current && JSON.stringify(s) === JSON.stringify(current)) return;
    current = s;
    for (const l of [...listeners]) l(s);
  };

  const signalToHelper = (from: MatchPlayerId, s: MediaSignal): void => {
    const kind = s.kind as VideoSignalKind;
    helper.send({ cmd: 'signal', id: from, kind, ...(s.sdp !== undefined ? { sdp: s.sdp } : {}), ...(s.candidate ? { candidate: { ...s.candidate } } : {}) });
  };

  /** The difference between what the helper was told and what is wanted, in the order the helper needs it. */
  const sync = (): void => {
    if (helperStatus.helper !== 'ready') return;
    const ice = JSON.stringify(wantIce);
    if (ice !== toldIce && helper.send({ cmd: 'ice', servers: wantIce })) toldIce = ice;
    const src = JSON.stringify(wantSource);
    if (src !== toldSource && helper.send({ cmd: 'source', ...wantSource })) toldSource = src;
    const sink = JSON.stringify(wantSink);
    if (sink !== toldSink && helper.send({ cmd: 'sink', ...wantSink })) toldSink = sink;
    const rungs = JSON.stringify(wantRungs);
    if (rungs !== toldRungs && helper.send({ cmd: 'rungs', max_kbps: wantRungs.max_kbps, ...(wantRungs.pin !== undefined ? { pin: wantRungs.pin } : {}) })) toldRungs = rungs;
    if (wantSending !== toldSending && helper.send({ cmd: 'send', on: wantSending })) toldSending = wantSending;
    for (const id of [...toldPeers]) {
      if (wantPeers.has(id)) continue;
      helper.send({ cmd: 'close', id });
      toldPeers.delete(id);
      peerViews.delete(id);
      held.delete(id);
    }
    for (const id of wantPeers) {
      if (toldPeers.has(id)) continue;
      const initiator = initiates(localId, id);
      if (!helper.send({ cmd: 'peer', id, initiator })) continue;
      toldPeers.add(id);
      log(`video: peer ${id}: ${initiator ? 'offering' : 'waiting for their offer'}`);
      for (const s of held.get(id) ?? []) signalToHelper(id, s);
      held.delete(id);
    }
  };

  const onEvent = (e: VideoHelperEvent): void => {
    switch (e.event) {
      case 'ready':
        // A fresh helper (the first, or a restart): it knows nothing; say it all again.
        toldPeers.clear();
        toldSending = null;
        toldSource = null;
        toldSink = null;
        toldIce = null;
        toldRungs = null;
        peerViews.clear();
        sourceState = null;
        helperStatus = helper.status();
        sync();
        break;
      case 'signal': {
        if (typeof e.id !== 'string' || !wantPeers.has(e.id)) return;
        if (e.kind !== 'offer' && e.kind !== 'answer' && e.kind !== 'ice') return;
        const out: MediaSignal = { kind: e.kind };
        if (typeof e.sdp === 'string') out.sdp = e.sdp;
        if (e.candidate && typeof e.candidate.candidate === 'string') out.candidate = { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid ?? null, sdpMLineIndex: e.candidate.sdpMLineIndex ?? null };
        o.sendSignal(e.id, out);
        return;
      }
      case 'peer': {
        if (typeof e.id !== 'string' || !toldPeers.has(e.id)) return;
        const was = peerViews.get(e.id);
        const pair = e.pair === undefined ? (was?.pair ?? null) : pairWords(e.pair);
        const ice = typeof e.ice === 'string' ? e.ice : 'new';
        peerViews.set(e.id, { ...(was ?? emptyPeer()), ice, pair });
        if (was?.ice !== ice || was?.pair !== pair) log(`video: peer ${e.id}: ice ${ice}${pair ? ` (${pair})` : ''}`);
        break;
      }
      case 'stats': {
        if (typeof e.id !== 'string' || !toldPeers.has(e.id)) return;
        const was = peerViews.get(e.id) ?? emptyPeer();
        peerViews.set(e.id, { ...was, [e.dir === 'recv' ? 'recv' : 'send']: statsOf(e) });
        break;
      }
      case 'rung': {
        // D10.5: the rung the helper applies to the frames sent to that peer (the controller's, the pin's or the ceiling's).
        if (typeof e.id !== 'string' || !toldPeers.has(e.id)) return;
        const was = peerViews.get(e.id) ?? emptyPeer();
        const rung: NativeVideoRungState = { rung: num(e.rung), width: num(e.width), height: num(e.height), fps: num(e.fps), kbps: num(e.kbps), reason: typeof e.reason === 'string' ? e.reason : '' };
        peerViews.set(e.id, { ...was, rung });
        log(`video: peer ${e.id}: rung ${rung.rung} (${rung.width}x${rung.height} at ${rung.fps} fps, ${mbps(rung.kbps)}): ${rung.reason}`);
        break;
      }
      case 'source': {
        const state = e.state === 'ok' || e.state === 'missing' || e.state === 'dead' ? e.state : 'ok';
        const next = { state, fpsIn: num(e.fps_in) };
        if (sourceState?.state !== next.state) log(`video: source ${e.kind}: ${state}${state !== 'ok' ? ' (the ring is not being filled)' : ''}`);
        sourceState = next;
        break;
      }
      default:
        return;
    }
    emit();
  };

  const offEvent = helper.onEvent(onEvent);
  const offStatus = helper.onStatus((s) => {
    helperStatus = s;
    if (s.helper !== 'ready') {
      // The helper is gone (or going): its peers are gone with it; a `ready` later says it all again.
      toldPeers.clear();
      toldSending = null;
      toldSource = null;
      toldSink = null;
      toldIce = null;
      toldRungs = null;
      peerViews.clear();
      sourceState = null;
    }
    emit();
  });
  // A helper that is ready already (a second match in one run): told the whole (empty) state now, as a helper that
  // becomes ready later is told it all at its `ready`; the match host's own settings follow as single commands.
  if (helperStatus.helper === 'ready') sync();

  return {
    setPeers(ids) {
      const next = new Set(ids.filter((id) => id !== localId));
      let changed = false;
      for (const id of [...wantPeers]) {
        if (next.has(id)) continue;
        wantPeers.delete(id);
        held.delete(id);
        changed = true;
      }
      for (const id of next) {
        if (wantPeers.has(id)) continue;
        wantPeers.add(id);
        changed = true;
      }
      if (!changed) return;
      sync();
      emit();
    },
    onSignal(from, signal) {
      if (closed || from === localId) return;
      if (signal.kind !== 'offer' && signal.kind !== 'answer' && signal.kind !== 'ice') return;
      if (wantPeers.has(from) && toldPeers.has(from) && helperStatus.helper === 'ready') {
        signalToHelper(from, signal);
        return;
      }
      const q = held.get(from);
      if (!q && held.size >= MAX_HELD_SENDERS) return;
      const list = q ?? [];
      if (list.length < MAX_HELD_SIGNALS) list.push(signal);
      held.set(from, list);
    },
    setSending(on) {
      if (wantSending === on) return;
      wantSending = on;
      sync();
      emit();
    },
    setSource(source) {
      if (JSON.stringify(source) === JSON.stringify(wantSource)) return;
      wantSource = source;
      sourceState = null;
      log(`video: source ${source.kind === 'none' ? 'none' : `${source.kind} ${source.width}x${source.height} at ${source.fps} fps`}`);
      sync();
      emit();
    },
    setSink(sink) {
      if (JSON.stringify(sink) === JSON.stringify(wantSink)) return;
      wantSink = sink;
      log(`video: sink ${sink.kind}`);
      sync();
      emit();
    },
    setIce(servers) {
      const next = helperIceServers(servers);
      if (JSON.stringify(next) === JSON.stringify(wantIce)) return;
      wantIce = next;
      sync();
    },
    setRungs(rungs) {
      const pin = clampPin(rungs.pin);
      const next: VideoRungs = { max_kbps: clampMaxKbps(rungs.max_kbps), ...(pin !== null ? { pin } : {}) };
      if (JSON.stringify(next) === JSON.stringify(wantRungs)) return;
      wantRungs = next;
      log(`video: rungs: ceiling ${next.max_kbps} kbps, ${pin !== null ? `pinned to rung ${pin}` : 'auto'}`);
      sync();
      emit();
    },
    status: () => current ?? (current = computed()),
    onStatus(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    close() {
      if (closed) return;
      wantPeers.clear();
      held.clear();
      wantSending = false;
      wantSource = { kind: 'none' };
      wantSink = { kind: 'none' };
      sync();
      closed = true;
      offEvent();
      offStatus();
      emit();
      listeners.clear();
    },
  };
}
