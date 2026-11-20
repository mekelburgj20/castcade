/**
 * I11.4.1 (2026-11-16): the 3D watch tunnel's hidden page. One data-only `RTCPeerConnection` per session member, each
 * with ONE reliable ordered data channel (`negotiated: true, id: 0` on both sides: nothing to announce in-band, and
 * both sides' channel is the same one). It is its own page in its own partition, apart from the match panel: the
 * voice path's negotiation fixes (D2.7, D2.9, D2.12) are fragile, and nothing here touches `panel-page.ts`. What it
 * reuses is the same code by source: `rtc-signaling.ts`'s `PeerNegotiator` / `SignalingMesh` (perfect negotiation,
 * the polite side waiting for the first offer, offers resent while not connected, `reset` on a rebuilt page) and the
 * panel's ICE watchdog helpers (`iceWatchStep` restarts a stuck connection 10 / 20 / 40 s, then gives up and says so),
 * with `iceServers()` from main, so the path through home routers is the one voice already takes. I11.12: and the
 * same one line per ICE round as voice writes (`iceRoundOver`, panel-page.ts): what every kind of candidate pair sent
 * and received, and when the round got its remote description, went to `checking` and connected.
 *
 * The page carries frames and nothing else: `tunnel-end.ts` (main) owns the bridge (`tunnel.ts`) and the sockets.
 * Frames from main go out with `dc.send`; every message that arrives goes to main as it is. Flow: past `FLOW.high`
 * buffered bytes main is told `busy`, and at `bufferedamountlow` (below `FLOW.low`) `busy: false`. Nothing on the
 * data path waits for a paint or a timer (the window is never shown; `backgroundThrottling: false` keeps its timers
 * for the watchdog and the status).
 */
import { negotiationSource } from '../media/rtc-signaling.js';
import { ICE_WATCH, iceCandidateIds, icePairInfo, icePairText, iceRoundLine, iceRoundOver, iceRoundSeen, iceRoundStart, iceUfrag, iceWatchStep } from '../media/panel-page.js';
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
 * instead of 11. With the variable set the watchdog restarts a stuck connection once after that many ms, then goes on
 * as it always did (10, 20, 40 s). Only the side that leads restarts acts on it; the tunnel page only (not voice).
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
  /** The watchdog gave up: no path after its restarts. */
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

const HELPERS = [iceWatchStep, icePairInfo, icePairText, iceUfrag, iceRoundStart, iceRoundSeen, iceCandidateIds, iceRoundLine, iceRoundOver];

export function watchPageHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Castcade 3D watch</title></head><body>
<script>
'use strict';
const { ipcRenderer } = require('electron');
const C = ${JSON.stringify(WATCH_CHANNELS)};
const FLOW = ${JSON.stringify(FLOW)};
const ICE_WATCH_BASE = ${JSON.stringify(ICE_WATCH)};
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

function newWatch(peer) {
  return { since: null, lastAt: 0, restarts: 0, gaveUp: false, ufrag: null, lead: leadsIceRestart(localId, peer) };
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
function roundOver(peer, r, why, connected, peerLed) {
  const lead = r.watch.lead;
  iceRoundOver(r, why, connected, peerLed, Date.now(), (line) => logLine('peer ' + peer + ': ' + line + (lead ? '; this side leads restarts' : '; the peer leads restarts')));
}
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
    if (w.gaveUp) report();
    return;
  }
  const counting = st === 'checking' || st === 'disconnected' || st === 'failed' || (st === 'new' && pc.signalingState === 'stable' && !!pc.remoteDescription);
  if (!counting) return;
  if (w.since === null) w.since = now;
  if (w.gaveUp) return;
  const action = iceWatchStep(st, stuckFor(r, now), w.restarts, w.lead, ICE_WATCH);
  if (action === 'restart') {
    const secs = Math.round(stuckFor(r, now) / 1000);
    const n = mesh.get(peer);
    if (!n || n.closed || typeof pc.restartIce !== 'function') return;
    // I11.12: the round's stats are asked for before the restart changes them.
    roundOver(peer, r, 'restart ' + (w.restarts + 1) + ' of ' + ICE_WATCH.backoffMs.length + ' decided here', false, false);
    if (!n.restartIce()) return;
    w.restarts++;
    w.lastAt = now;
    logLine('peer ' + peer + ': ICE restart ' + w.restarts + ' of ' + ICE_WATCH.backoffMs.length + ' (' + st + ' for ' + secs + ' s; ' + (r.pairText || 'no pair yet') + ')');
  } else if (action === 'give_up') {
    w.gaveUp = true;
    roundOver(peer, r, 'gave up after ' + w.restarts + ' restart(s)', false, false);
    logLine('peer ' + peer + ': no path after ' + w.restarts + ' ICE restart(s), ' + st + ' for ' + Math.round((now - w.since) / 1000) + ' s; ' + (r.pairText || 'no pair yet'));
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
  if (w.since === null || w.gaveUp || !current(peer, r)) return;
  w.restarts++;
  w.lastAt = Date.now();
  roundOver(peer, r, 'restart ' + w.restarts + ' of ' + ICE_WATCH.backoffMs.length + ' by the peer', false, true);
  logLine('peer ' + peer + ': ICE restart ' + w.restarts + ' of ' + ICE_WATCH.backoffMs.length + ' by the peer (' + pc.iceConnectionState + ')');
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
      r.ids = iceCandidateIds(entries);
    } catch (e) {
      continue;
    }
    if (peers.get(peer) !== r) continue;
    const key = icePairText(info, false);
    r.pairText = icePairText(info, true);
    r.pair = info.pair ? { local: info.pair.local, remote: info.pair.remote, protocol: info.pair.protocol, rttMs: info.pair.rttMs } : null;
    if (key !== r.pairKey) logLine('peer ' + peer + ': ' + r.pairText + ', ice ' + r.pc.iceConnectionState);
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
  // I11.12: the experiment: one more restart, early, before the usual three.
  ICE_WATCH = typeof cfg.firstRestartMs === 'number' && cfg.firstRestartMs > 0
    ? { backoffMs: [cfg.firstRestartMs].concat(ICE_WATCH_BASE.backoffMs), lagMs: ICE_WATCH_BASE.lagMs, tickMs: ICE_WATCH_BASE.tickMs }
    : ICE_WATCH_BASE;
  mesh = new SignalingMesh(
    localId,
    openPeer,
    (to, signal) => ipcRenderer.send(C.signalOut, { to: to, signal: signal }),
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
ipcRenderer.on(C.signalIn, (_e, m) => { if (mesh) void mesh.receive(m.from, m.signal); });
ipcRenderer.on(C.send, (_e, m) => sendFrames(m.peer, m.frames));
ipcRenderer.send(C.ready);
`;
