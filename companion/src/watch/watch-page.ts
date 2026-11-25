/**
 * I11.4.1 (2026-11-16): the 3D watch tunnel's hidden page. One data-only `RTCPeerConnection` per session member, each
 * with ONE reliable ordered data channel (`negotiated: true, id: 0` on both sides: nothing to announce in-band, and
 * both sides' channel is the same one). It is its own page in its own partition, apart from the match panel: the
 * voice path's negotiation fixes (D2.7, D2.9, D2.12) are fragile, and nothing here touches `panel-page.ts`. What it
 * reuses is the same code by source: `rtc-signaling.ts`'s `PeerNegotiator` / `SignalingMesh` (perfect negotiation,
 * the polite side waiting for the first offer, offers resent while not connected, `reset` on a rebuilt page) and the
 * panel's ICE watchdog helpers (`iceWatchStep` restarts a stuck connection and says when it has found no path; since
 * I11.12 of 2026-11-24 the two sides take turns at it, 3, 3, 6, 6, 12 and 12 s apart, and then go on every 30 s for
 * as long as the peer is wanted: `ICE_WATCH`, panel-page.ts, has why),
 * with `iceServers()` from main, so the path through home routers is the one voice already takes. I11.12: and the
 * same one line per ICE round as voice writes (`iceRoundOver`, panel-page.ts): what every kind of candidate pair sent
 * and received, and when the round got its remote description, went to `checking` and connected; since 2026-11-24
 * also when the first server-reflexive candidate went each way and the first check on such a pair was seen, with the
 * counters kept from the last look that still saw pairs (`iceRoundLook`, `iceRoundCandidate`).
 *
 * The page carries frames and nothing else: `tunnel-end.ts` (main) owns the bridge (`tunnel.ts`) and the sockets.
 * Frames from main go out with `dc.send`; every message that arrives goes to main as it is. Flow: past `FLOW.high`
 * buffered bytes main is told `busy`, and at `bufferedamountlow` (below `FLOW.low`) `busy: false`. Nothing on the
 * data path waits for a paint or a timer (the window is never shown; `backgroundThrottling: false` keeps its timers
 * for the watchdog and the status).
 */
import { negotiationSource } from '../media/rtc-signaling.js';
import { ICE_ROUND_LOOK, ICE_WATCH, iceCandidateIds, icePairInfo, icePairText, iceRestartName, iceRoundCandidate, iceRoundLine, iceRoundLook, iceRoundOver, iceRoundSeen, iceRoundSparse, iceRoundStart, iceUfrag, iceWatchStep } from '../media/panel-page.js';
import type { IceServer } from '../media/media-settings.js';

/** IPC between the page and `tunnel-end.ts`. */
export const WATCH_CHANNELS = {
  /** page -> main: the page has loaded and listens. */
  ready: 'castcade-watch:ready',
  /** main -> page: `WatchPageConfig`; the page (re)starts its mesh. */
  config: 'castcade-watch:config',
  /** main -> page: a member id to connect to / to drop. */
  addPeer: 'castcade-watch:add',
  removePeer: 'castcade-watch:remove',
  /** main -> page `{ from, signal }`; page -> main `{ to, signal }`. */
  signalIn: 'castcade-watch:signal-in',
  signalOut: 'castcade-watch:signal-out',
  /** main -> page `{ peer, frames: Uint8Array[] }`. */
  send: 'castcade-watch:send',
  /** page -> main `{ peer, frame: Uint8Array }`. */
  recv: 'castcade-watch:recv',
  /** page -> main `{ peer, open, why? }`: the data channel opened or closed. */
  channel: 'castcade-watch:channel',
  /** page -> main `{ peer, busy }`: the channel's send buffer crossed its high mark, or drained below its low mark. */
  flow: 'castcade-watch:flow',
  /** page -> main `WatchPageStatus`, on every change and every 2 s. */
  status: 'castcade-watch:status',
  /** page -> main: one line for companion.log (states and candidate types, never an address). */
  log: 'castcade-watch:log',
} as const;

/** The data channel's buffer marks: reading the local sockets stops above `high` and goes on below `low`. */
export const FLOW = { high: 1024 * 1024, low: 256 * 1024 } as const;

export interface WatchPageConfig {
  localId: string;
  ice: IceServer[];
  /** This page replaces one whose connections the peers still hold: `peers` are told to open theirs again (D2.7). */
  reset: boolean;
  peers: string[];
  /** I11.12: an experiment (`firstRestartMs`): one more ICE restart, this soon after a connection got stuck. Absent: none. */
  firstRestartMs?: number | null;
}

/**
 * I11.12 (2026-11-20): an experiment for a two-router night, off unless `CASTCADE_ICE_FIRST_RESTART_MS` is set (500 to
 * 9000). Every first ICE round between the owner's and Krobs' routers stalled until the watchdog's restart at 10 s and
 * connected half a second after it. A restart makes the side that restarts send first (its new ports check the peer's
 * old candidates at once: the recorded stats in `media/ice-round.test-data.json`), where in round one the side that
 * answers sends first; if that order is what one of the routers cannot take, a restart after 2 s connects at 2.5 s
 * instead of 11. With the variable set, this PC's watchdog has one restart more than the usual ones: the first after
 * that many ms, then the usual ones after it, each as long after the one before as it always is. The tunnel page only
 * (not voice), and each PC for itself:
 * - on the PC that leads restarts (the larger player id) the early restart happens at that many ms;
 * - on the other PC it would happen `lagMs` later (the lag a restart has on the side whose turn it is not), and only
 *   if the lead has not restarted by then, so the PC that is "not the lead" then restarts first;
 * - a PC without the variable counts the other's early restart as one of its own ("ICE restart 1 of 6 by the peer")
 *   and so gives up one restart earlier than the PC that has it. Set it on both PCs, or know which one leads.
 *
 * I11.12 (2026-11-24): the usual schedule is now 3, 3, 6, 6, 12, 12 s with the two sides taking turns (`ICE_WATCH`,
 * panel-page.ts), so the first restart is at 3 s without this switch and the question it was built for is answered by
 * the default. It still does what it says: one more restart, at that many ms, before the usual six (seven in all);
 * the early one is restart 1, so it is the usual lead's turn, and the turns go on from there (restart 2 is the other
 * side's). On the PC that is not the lead it comes `lagMs` (3 s) after that many ms: the wait of 14 s that restart 1
 * otherwise has there, for a lead on 0.2.50, is not kept, because jumping ahead of the lead is what the switch is for
 * there. On a PC with 0.2.50 it is also the way to test, with no build, whether a restart led from the side that is
 * not the lead connects where the lead's did not: set there alone (lag 5 s in 0.2.50), that page restarts first.
 */
export function firstRestartMs(env: string | undefined): number | null {
  if (env === undefined || !/^\d{3,4}$/.test(env.trim())) return null;
  const n = Number(env.trim());
  return n >= 500 && n <= 9000 ? n : null;
}

export interface WatchPagePeer {
  /** `RTCPeerConnection.iceConnectionState`. */
  ice: string;
  channel: 'connecting' | 'open' | 'closed';
  /** The candidate pair in use: types and protocol, never an address. */
  pair: { local: string; remote: string; protocol: string; rttMs: number | null } | null;
  restarts: number;
  /**
   * The watchdog found no path with its scheduled restarts. I11.12 (2026-11-24): what it says, not an end: it goes on
   * with one restart every 30 s, and this is false again the moment the connection is up.
   */
  gaveUp: boolean;
  /** The data channel's buffered bytes at the last look. */
  buffered: number;
}

export interface WatchPageStatus {
  peers: Record<string, WatchPagePeer>;
}

export type WatchPath = 'connecting' | 'direct' | 'relay' | 'no_path';

/** The path to one member in the card's words' terms: TURN in the pair is `relay`; the watchdog's verdict is `no_path`. */
export function pathOf(p: WatchPagePeer | undefined): WatchPath {
  if (!p) return 'connecting';
  if (p.channel === 'open') return p.pair && (p.pair.local === 'relay' || p.pair.remote === 'relay') ? 'relay' : 'direct';
  if (p.gaveUp) return 'no_path';
  return 'connecting';
}

const HELPERS = [iceWatchStep, iceRestartName, icePairInfo, icePairText, iceUfrag, iceRoundStart, iceRoundSeen, iceCandidateIds, iceRoundLine, iceRoundOver, iceRoundSparse, iceRoundLook, iceRoundCandidate];

export function watchPageHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Castcade 3D watch</title></head><body>
<script>
'use strict';
const { ipcRenderer } = require('electron');
const C = ${JSON.stringify(WATCH_CHANNELS)};
const FLOW = ${JSON.stringify(FLOW)};
const ICE_WATCH_BASE = ${JSON.stringify(ICE_WATCH)};
const ICE_ROUND_LOOK = ${JSON.stringify(ICE_ROUND_LOOK)};
let ICE_WATCH = ICE_WATCH_BASE;
${HELPERS.map((f) => f.toString()).join('\n')}
${negotiationSource()}
${PAGE_SCRIPT}
</script>
</body></html>
`;
}

/** The page's own logic (plain JS; no template literals, so nothing in it is interpolated by the template above). */
const PAGE_SCRIPT = String.raw`
let mesh = null;
let localId = null;
let ice = [];
/** peer -> { pc, dc, open, busy, watch, pair, pairKey, retry } */
const peers = new Map();

function logLine(line) { ipcRenderer.send(C.log, line); }
function errText(e) { return e && e.message ? String(e.message) : String(e); }

/**
 * I11.12 (2026-11-24): how long after a restart of the peer's, answered here while this side still saw the connection
 * up, a spell that begins here is the same trouble: that restart is then its restart 1 (iceWatch; the panel page's rule).
 */
const PEER_RESTART_BEFORE_MS = 20000;
function newWatch(peer) {
  return { since: null, lastAt: 0, restarts: 0, gaveUp: false, ownAt: 0, peerAt: 0, ufrag: null, lead: leadsIceRestart(localId, peer) };
}
/** I11.12 (2026-11-24): the scheduled restarts of this peer's spell are used up: the late ones are on, and its lines are kept few. */
function lateSpell(r) {
  return r.watch.since !== null && r.watch.restarts >= ICE_WATCH.backoffMs.length;
}

function closePeer(peer, why) {
  const r = peers.get(peer);
  if (!r) return;
  peers.delete(peer);
  clearInterval(r.retry);
  // Main hears the channel go now (the close event of a replaced connection comes later, and is not this peer's any more).
  if (r.open) {
    r.open = false;
    ipcRenderer.send(C.channel, { peer: peer, open: false, why: why });
  }
  try { r.dc.close(); } catch (e) { /* closed */ }
  try { r.pc.close(); } catch (e) { /* closed */ }
}

/** The mesh's factory: a data-only connection to one member. */
function openPeer(peer) {
  closePeer(peer, 'the connection was replaced');
  const pc = new RTCPeerConnection({ iceServers: ice });
  // Both sides make the same channel (id 0): no in-band announcement, so neither waits for the other's.
  const dc = pc.createDataChannel('castcade-watch', { negotiated: true, id: 0, ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = FLOW.low;
  const r = { pc: pc, dc: dc, open: false, busy: false, watch: newWatch(peer), round: iceRoundStart(1, Date.now(), null, null), ids: null, pair: null, pairKey: null, pairText: null, retry: null };
  dc.onopen = () => {
    if (peers.get(peer) !== r) return;
    r.open = true;
    logLine('peer ' + peer + ': data channel open' + (r.pairText ? ' (' + r.pairText + ')' : ''));
    ipcRenderer.send(C.channel, { peer: peer, open: true });
    report();
  };
  dc.onclose = () => {
    if (!r.open) return;
    r.open = false;
    if (peers.get(peer) === r) {
      logLine('peer ' + peer + ': data channel closed');
      ipcRenderer.send(C.channel, { peer: peer, open: false, why: 'the data channel closed' });
    }
    report();
  };
  dc.onmessage = (e) => {
    if (peers.get(peer) !== r) return;
    ipcRenderer.send(C.recv, { peer: peer, frame: new Uint8Array(e.data) });
  };
  dc.onbufferedamountlow = () => {
    if (!r.busy || peers.get(peer) !== r) return;
    r.busy = false;
    ipcRenderer.send(C.flow, { peer: peer, busy: false });
  };
  pc.addEventListener('iceconnectionstatechange', () => {
    roundSeen(peer, r);
    iceWatch(peer, r);
    report();
  });
  pc.addEventListener('connectionstatechange', () => report());
  pc.addEventListener('signalingstatechange', () => {
    roundSeen(peer, r);
    if (pc.signalingState === 'stable') notePeerRestart(peer, r);
    report();
  });
  peers.set(peer, r);
  // An offer lost on the way (the peer's page was not up yet, a relay blip) is sent again until the connection is up.
  r.retry = setInterval(() => {
    const n = mesh && mesh.get(peer);
    const st = pc.iceConnectionState;
    if (n && n.pc === pc && st !== 'connected' && st !== 'completed') n.resendOffer();
  }, 5000);
  report();
  return pc;
}

/** A frame batch from main for one peer. A send that fails (the buffer is full, the channel is closing) reopens the peer. */
function sendFrames(peer, frames) {
  const r = peers.get(peer);
  if (!r || !r.open || r.dc.readyState !== 'open') return;
  try {
    for (const f of frames) r.dc.send(f);
  } catch (e) {
    logLine('peer ' + peer + ': data channel send failed (' + errText(e) + '); opening the connection again');
    restartPeer(peer);
    return;
  }
  if (!r.busy && r.dc.bufferedAmount > FLOW.high) {
    r.busy = true;
    ipcRenderer.send(C.flow, { peer: peer, busy: true });
  }
}

function restartPeer(peer) {
  if (!mesh || !mesh.get(peer)) return;
  ipcRenderer.send(C.signalOut, { to: peer, signal: { kind: 'reset' } });
  mesh.add(peer);
}

// ---- the ICE watchdog (the panel page's rules, D2.9) ----
function current(peer, r) {
  const n = mesh && mesh.get(peer);
  return !!n && n.pc === r.pc && peers.get(peer) === r;
}
function stuckFor(r, now) { return now - Math.max(r.watch.since, r.watch.lastAt); }
/**
 * I11.12: one line per ICE round of a peer (iceRoundOver, shared with the other page): what each kind of candidate
 * pair sent and received, and when the round got its remote description, went to checking and connected.
 */
function roundSeen(peer, r) {
  const st = r.pc.iceConnectionState;
  iceRoundSeen(r.round, Date.now(), st, iceUfrag(r.pc.remoteDescription && r.pc.remoteDescription.sdp));
  if ((st === 'connected' || st === 'completed') && !r.round.idle && current(peer, r)) roundOver(peer, r, 'connected', true, false);
}
function roundOver(peer, r, why, connected, peerLed, sparse) {
  const lead = r.watch.lead;
  // I11.12 (2026-11-24): restart 1, 3, 5 is the usual lead's turn, 2, 4, 6 the other side's.
  iceRoundOver(r, why, connected, peerLed, Date.now(), (line) => logLine('peer ' + peer + ': ' + line + (lead ? '; this side leads restarts 1, 3, 5' : '; the peer leads restarts 1, 3, 5')), sparse);
}
/** I11.12 (2026-11-24): the time of a round's first server-reflexive candidate each way (iceRoundCandidate; nothing else of it is kept). */
function noteCandidate(peer, signal, outgoing) {
  const r = peers.get(peer);
  if (!r || !signal || signal.kind !== 'ice' || !signal.candidate) return;
  iceRoundCandidate(r, Date.now(), outgoing, signal.candidate.candidate);
}
/**
 * I11.12 (2026-11-24): the stats of a round's first seconds, read every 50 ms until a check was seen sent and received
 * on a pair with a server-reflexive candidate, 3 s at most (ICE_ROUND_LOOK): the times a round's line gives for them.
 */
function roundLook() {
  const now = Date.now();
  for (const [peer, r] of [...peers]) {
    const round = r.round;
    if (round.idle || now - round.at >= ICE_ROUND_LOOK.forMs || (round.checkOutMs !== null && round.checkInMs !== null)) continue;
    if (r.looking || typeof r.pc.getStats !== 'function') continue;
    r.looking = true;
    let stats;
    try { stats = r.pc.getStats(); } catch (e) { stats = null; }
    if (!stats || typeof stats.then !== 'function') { r.looking = false; continue; }
    stats.then((rep) => {
      r.looking = false;
      // The look belongs to the round it was asked in.
      if (peers.get(peer) === r && r.round === round) iceRoundLook(r, Date.now(), [...rep.values()]);
    }, () => { r.looking = false; });
  }
}
setInterval(roundLook, ICE_ROUND_LOOK.everyMs);
function iceWatch(peer, r) {
  if (!current(peer, r)) return;
  const pc = r.pc;
  const w = r.watch;
  const st = pc.iceConnectionState;
  const now = Date.now();
  if (st === 'connected' || st === 'completed') {
    if (w.since !== null && w.restarts > 0) logLine('peer ' + peer + ': ICE ' + st + ' after ' + w.restarts + ' restart(s)');
    r.watch = newWatch(peer);
    r.watch.ufrag = w.ufrag;
    r.watch.peerAt = w.peerAt;
    if (w.gaveUp) report();
    return;
  }
  const counting = st === 'checking' || st === 'disconnected' || st === 'failed' || (st === 'new' && pc.signalingState === 'stable' && !!pc.remoteDescription);
  if (!counting) return;
  const total = ICE_WATCH.backoffMs.length;
  if (w.since === null) {
    w.since = now;
    // I11.12 (2026-11-24): the peer saw this trouble first and has already restarted, which this side answered while
    // it still read the connection as up and so did not count: that restart is this spell's first (the panel page
    // has the reason: with the counts 1 there and 0 here, one side makes every restart and the turns are gone).
    if (w.peerAt && now - w.peerAt < PEER_RESTART_BEFORE_MS) {
      w.restarts = 1;
      w.lastAt = w.peerAt;
      logLine('peer ' + peer + ': the peer restarted ICE ' + Math.round((now - w.peerAt) / 1000) + ' s before this side saw the trouble: that was ' + iceRestartName(1, total) + ', the next is ' + (w.lead ? "the peer's" : 'our') + ' turn');
    }
    w.peerAt = 0;
  }
  // I11.12 (2026-11-24): never the end (persist): after the scheduled restarts, one every ICE_WATCH.lateMs, for as
  // long as the peer is wanted. A path that is away for a minute or two comes back; were the give-up final, the rest
  // of the match would have no 3D (0.2.50's third restart, at 70 s, caught such a path; the sixth is now at about 47 s).
  const action = iceWatchStep(st, stuckFor(r, now), w.restarts, w.lead, ICE_WATCH, true);
  if (action === 'restart') {
    const secs = Math.round(stuckFor(r, now) / 1000);
    const n = mesh.get(peer);
    if (!n || n.closed || typeof pc.restartIce !== 'function') return;
    // I11.12 (2026-11-24): whose turn this restart is (even count: the usual lead's).
    const mine = w.restarts % 2 === 0 ? w.lead : !w.lead;
    // I11.12: the round's stats are asked for before the restart changes them (a late round's line: iceRoundSparse).
    roundOver(peer, r, iceRestartName(w.restarts + 1, total) + ' decided here', false, false, iceRoundSparse(w.restarts + 1, total));
    if (!n.restartIce()) return;
    w.restarts++;
    w.lastAt = now;
    w.ownAt = now;
    logLine('peer ' + peer + ': ICE ' + iceRestartName(w.restarts, total) + ' (' + st + ' for ' + secs + ' s, ' + (mine ? 'our turn' : 'the peer did not take its turn') + '; ' + (r.pairText || 'no pair yet') + ')');
  } else if (!w.gaveUp && iceWatchStep(st, stuckFor(r, now), w.restarts, w.lead, ICE_WATCH, false) === 'give_up') {
    // I11.12 (2026-11-24): where 0.2.50 gave up. gaveUp is what main is told (pathOf: no_path): the match's start
    // stops waiting for this peer and its turns are the 2D video (stream3d.ts), exactly as before. It is no longer the
    // end: the restarts go on, and a connection that comes up later opens the channel as any late one does.
    w.gaveUp = true;
    logLine('peer ' + peer + ': no path after ' + w.restarts + ' ICE restart(s), ' + st + ' for ' + Math.round((now - w.since) / 1000) + ' s; ' + (r.pairText || 'no pair yet') + '; still trying: an ICE restart every ' + Math.round(ICE_WATCH.lateMs / 1000) + ' s');
    report();
  }
}
function notePeerRestart(peer, r) {
  const pc = r.pc;
  const u = iceUfrag(pc.remoteDescription && pc.remoteDescription.sdp);
  const w = r.watch;
  const was = w.ufrag;
  w.ufrag = u;
  if (!was || !u || u === was || !pc.localDescription || pc.localDescription.type !== 'answer') return;
  if (!current(peer, r)) return;
  // I11.12 (2026-11-24): answered while this side reads the connection as up: remembered, for a spell that begins
  // here within PEER_RESTART_BEFORE_MS (iceWatch counts it as that spell's first restart, as the peer has).
  if (w.since === null) {
    w.peerAt = Date.now();
    return;
  }
  // I11.12 (2026-11-24): both sides restarted at the same moment and the negotiation let the peer's offer stand (ours
  // was rolled back to answer it): one restart, already counted and its round already begun here, not two (the panel
  // page's rule; the two counts must stay the same for the sides to agree on whose turn the next one is).
  if (w.ownAt && Date.now() - w.ownAt < 2000) {
    w.ownAt = 0;
    w.lastAt = Date.now();
    logLine('peer ' + peer + ': ICE ' + iceRestartName(w.restarts, ICE_WATCH.backoffMs.length) + ': the peer restarted at the same moment and its offer stands (one restart, counted once)');
    return;
  }
  // I11.12 (2026-11-24): counted after "no path" too: the late restarts take turns as the scheduled ones do.
  w.restarts++;
  w.lastAt = Date.now();
  roundOver(peer, r, iceRestartName(w.restarts, ICE_WATCH.backoffMs.length) + ' by the peer', false, true, iceRoundSparse(w.restarts, ICE_WATCH.backoffMs.length));
  logLine('peer ' + peer + ': ICE ' + iceRestartName(w.restarts, ICE_WATCH.backoffMs.length) + ' by the peer (' + pc.iceConnectionState + ')');
}
setInterval(() => { for (const [peer, r] of peers) iceWatch(peer, r); }, ICE_WATCH_BASE.tickMs);

/** Each peer's candidate pair, logged when it changes (types and protocol only). */
async function probePairs() {
  for (const [peer, r] of [...peers]) {
    let info;
    try {
      const rep = await r.pc.getStats();
      const entries = [...rep.values()];
      info = icePairInfo(entries);
      // I11.12 (2026-11-24): the candidates there are, and the counters kept while there still are pairs.
      iceRoundLook(r, Date.now(), entries);
    } catch (e) {
      continue;
    }
    if (peers.get(peer) !== r) continue;
    const key = icePairText(info, false);
    r.pairText = icePairText(info, true);
    r.pair = info.pair ? { local: info.pair.local, remote: info.pair.remote, protocol: info.pair.protocol, rttMs: info.pair.rttMs } : null;
    // I11.12 (2026-11-24): not while the late restarts run and there is still no pair: the same three or four lines
    // every 30 s for as long as the match lasts. A pair that works is always said.
    if (key !== r.pairKey && !(lateSpell(r) && !info.pair)) logLine('peer ' + peer + ': ' + r.pairText + ', ice ' + r.pc.iceConnectionState);
    r.pairKey = key;
  }
  report();
}
setInterval(() => void probePairs(), 2000);

function report() {
  const out = { peers: {} };
  for (const [peer, r] of peers) {
    out.peers[peer] = {
      ice: r.pc.iceConnectionState,
      channel: r.open ? 'open' : r.dc.readyState === 'closed' ? 'closed' : 'connecting',
      pair: r.pair,
      restarts: r.watch.restarts,
      gaveUp: r.watch.gaveUp,
      buffered: r.dc.bufferedAmount,
    };
  }
  ipcRenderer.send(C.status, out);
}

function configure(cfg) {
  if (mesh) mesh.close();
  for (const id of [...peers.keys()]) closePeer(id, 'the page was configured again');
  localId = cfg.localId;
  ice = cfg.ice || [];
  // I11.12: the experiment: one more restart, early, before the usual ones. 2026-11-24: it is restart 1 (the usual
  // lead's turn); the side whose turn it is not waits lagMs for it and no longer (waitMs 0), and restart 2 keeps its wait.
  ICE_WATCH = typeof cfg.firstRestartMs === 'number' && cfg.firstRestartMs > 0
    ? { backoffMs: [cfg.firstRestartMs].concat(ICE_WATCH_BASE.backoffMs), lagMs: ICE_WATCH_BASE.lagMs, waitMs: [0].concat(ICE_WATCH_BASE.waitMs.slice(1)), lateMs: ICE_WATCH_BASE.lateMs, tickMs: ICE_WATCH_BASE.tickMs }
    : ICE_WATCH_BASE;
  mesh = new SignalingMesh(
    localId,
    openPeer,
    (to, signal) => { noteCandidate(to, signal, true); ipcRenderer.send(C.signalOut, { to: to, signal: signal }); },
    (peer, e, where) => logLine('peer ' + peer + ': negotiation (' + where + '): ' + errText(e)),
  );
  mesh.onReopen = (peer, why) => logLine('peer ' + peer + ': connection replaced (' + why + ')');
  if (cfg.reset && Array.isArray(cfg.peers)) for (const p of cfg.peers) ipcRenderer.send(C.signalOut, { to: p, signal: { kind: 'reset' } });
}

ipcRenderer.on(C.config, (_e, cfg) => configure(cfg));
ipcRenderer.on(C.addPeer, (_e, peer) => { if (mesh && !mesh.get(peer)) mesh.add(peer); });
ipcRenderer.on(C.removePeer, (_e, peer) => {
  if (mesh) mesh.remove(peer);
  closePeer(peer, 'the member left');
  report();
});
ipcRenderer.on(C.signalIn, (_e, m) => { noteCandidate(m.from, m.signal, false); if (mesh) void mesh.receive(m.from, m.signal); });
ipcRenderer.on(C.send, (_e, m) => sendFrames(m.peer, m.frames));
ipcRenderer.send(C.ready);
`;
