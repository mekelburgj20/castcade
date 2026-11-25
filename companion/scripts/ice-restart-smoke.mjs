// I11.12 (2026-11-24): the one thing about the pages' ICE restarts that no fake can show: that Chromium does what the
// watchdog's turns rest on. Two real RTCPeerConnections in one hidden page, the negotiator the pages embed
// (`negotiationSource()`, dist/media/rtc-signaling.js: the same source, no copy), an in-memory signalling between
// them, host candidates only (no STUN server, nothing leaves the machine):
//
//   1. a restart led by the POLITE side (`PeerNegotiator.restartIce()` on the side that did not make the first
//      offer): its offer is answered, the ICE credentials of BOTH local descriptions are new, ICE is connected again,
//      and the pair in use belongs to the new credentials;
//   2. the same while the impolite side waits for the answer to an offer of its own (one that is no restart, lost on
//      the way): the polite side's restart offer is ignored, the impolite side's offer is delivered and answered (the
//      polite side rolls its own back), and the polite side's restart goes out AGAIN BY ITSELF: nothing here calls
//      restartIce() or asks for negotiation a second time. That Chromium asks again after the rollback is what
//      rtc-signaling.test.ts and ice-round.test.ts assume in their fakes.
//
//   npx electron companion/scripts/ice-restart-smoke.mjs        (after `npm run build`; CI's Windows job runs it)
//
// Prints `ice-restart ok …` and exits 0, or `ice-restart FAILED …` and exits 1 (also after 60 s without an answer).
// What it prints: states, counts and yes/no. Never an address, a candidate, a ufrag or SDP.
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { negotiationSource } from '../dist/media/rtc-signaling.js';

const dir = mkdtempSync(join(tmpdir(), 'castcade-ice-smoke-'));
app.setPath('userData', join(dir, 'user-data'));
// No GPU is needed for a window that is never shown.
app.disableHardwareAcceleration();

let ended = false;
const done = (ok, detail) => {
  if (ended) return;
  ended = true;
  clearTimeout(giveUp);
  process.stdout.write(`ice-restart ${ok ? 'ok' : 'FAILED'} ${detail}\n`);
  app.exit(ok ? 0 : 1);
};
const giveUp = setTimeout(() => done(false, '(no answer within 60 s)'), 60_000);
process.on('uncaughtException', (e) => done(false, `(main: ${e?.message ?? e})`));
process.on('unhandledRejection', (e) => done(false, `(main: ${e?.message ?? e})`));

// The page. Plain JS, no template literal inside (it is one below): the negotiation classes, then the two scenarios.
const PAGE = String.raw`
const { ipcRenderer } = require('electron');
const say = (line) => ipcRenderer.send('ice-smoke:log', String(line));
const finish = (ok, detail) => ipcRenderer.send('ice-smoke:done', { ok: ok, detail: String(detail) });
window.addEventListener('error', (e) => finish(false, '(page: ' + e.message + ')'));
window.addEventListener('unhandledrejection', (e) => finish(false, '(page: ' + (e.reason && e.reason.message ? e.reason.message : e.reason) + ')'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, cond, ms) {
  const end = Date.now() + (ms || 15000);
  for (;;) {
    if (await cond()) return;
    if (Date.now() > end) throw new Error('timed out waiting for: ' + what);
    await sleep(25);
  }
}
const ufrag = (d) => { const m = /a=ice-ufrag:(\S+)/.exec((d && d.sdp) || ''); return m ? m[1] : null; };
const up = (pc) => pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';

/**
 * The ICE username fragment of the local candidate of the pair in use: null while no pair is selected, undefined where
 * the stats of this Chromium do not carry it.
 */
async function selectedUfrag(pc) {
  const rep = await pc.getStats();
  let selected = null;
  for (const s of rep.values()) if (s.type === 'transport' && s.selectedCandidatePairId) selected = s.selectedCandidatePairId;
  const pair = selected ? rep.get(selected) : null;
  const local = pair ? rep.get(pair.localCandidateId) : null;
  if (!local) return null;
  return typeof local.usernameFragment === 'string' ? local.usernameFragment : undefined;
}

/** Two connections, 'a' (polite) and 'b' (impolite: it makes the first offer), each behind the pages' own mesh. */
function pair() {
  const errors = [];
  const pcs = {};
  const sent = { a: [], b: [] };
  // What b sends can be held back (lost on the way, until it is released).
  const hold = { b: false, held: [] };
  const mk = (id) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    // As the 3D watch page: one negotiated data channel, so there is something to connect.
    pc.createDataChannel('smoke', { negotiated: true, id: 0 });
    pcs[id] = pc;
    return pc;
  };
  const meshes = {};
  const deliver = (to, from, signal) => setTimeout(() => void meshes[to].receive(from, signal), 2);
  meshes.a = new SignalingMesh('a', () => mk('a'), (to, s) => { sent.a.push(s.kind); deliver('b', 'a', s); }, (peer, e, where) => errors.push('a ' + where + ': ' + (e && e.message ? e.message : e)));
  meshes.b = new SignalingMesh('b', () => mk('b'), (to, s) => {
    sent.b.push(s.kind);
    if (hold.b) hold.held.push(s); else deliver('a', 'b', s);
  }, (peer, e, where) => errors.push('b ' + where + ': ' + (e && e.message ? e.message : e)));
  const release = () => { hold.b = false; for (const s of hold.held.splice(0)) deliver('a', 'b', s); };
  const offers = (id) => sent[id].filter((k) => k === 'offer').length;
  const close = () => { meshes.a.close(); meshes.b.close(); };
  return { errors: errors, pcs: pcs, meshes: meshes, hold: hold, release: release, offers: offers, close: close };
}

async function connect(p) {
  p.meshes.a.add('b');
  p.meshes.b.add('a');
  await until('the first connect', () => up(p.pcs.a) && up(p.pcs.b) && p.pcs.a.signalingState === 'stable' && p.pcs.b.signalingState === 'stable');
  if (p.pcs.b.localDescription.type !== 'offer' || p.pcs.a.localDescription.type !== 'answer') throw new Error('the impolite side did not make the first offer');
}

/** Both sides' credentials are new, signalling is stable, ICE is up, and the pair in use is of the new credentials. */
async function restarted(p, before, what) {
  await until(what + ': both local ufrags new, stable, ICE connected', () =>
    p.pcs.a.signalingState === 'stable' && p.pcs.b.signalingState === 'stable' &&
    ufrag(p.pcs.a.localDescription) !== before.a && ufrag(p.pcs.b.localDescription) !== before.b && up(p.pcs.a) && up(p.pcs.b));
  if (ufrag(p.pcs.a.remoteDescription) !== ufrag(p.pcs.b.localDescription) || ufrag(p.pcs.b.remoteDescription) !== ufrag(p.pcs.a.localDescription)) throw new Error(what + ': the two sides do not hold each other\'s new credentials');
  if (p.pcs.a.localDescription.type !== 'offer' || p.pcs.b.localDescription.type !== 'answer') throw new Error(what + ': the restart in force is not the polite side\'s offer');
  let unread = false;
  await until(what + ': the pair in use is of the new credentials', async () => {
    const a = await selectedUfrag(p.pcs.a);
    const b = await selectedUfrag(p.pcs.b);
    if (a === undefined || b === undefined) {
      unread = true;
      return true;
    }
    return a === ufrag(p.pcs.a.localDescription) && b === ufrag(p.pcs.b.localDescription);
  });
  return unread ? 'not read: no usernameFragment in the stats' : 'yes';
}

async function main() {
  // 1. The polite side leads a restart; the impolite side is stable.
  const one = pair();
  await connect(one);
  say('1: connected');
  let before = { a: ufrag(one.pcs.a.localDescription), b: ufrag(one.pcs.b.localDescription) };
  const offersA = one.offers('a');
  if (!one.meshes.a.get('b').restartIce()) throw new Error('1: restartIce() said no');
  const pair1 = await restarted(one, before, '1');
  if (one.offers('a') !== offersA + 1) throw new Error('1: the polite side made ' + (one.offers('a') - offersA) + ' offers for one restart');
  if (one.errors.length) throw new Error('1: ' + one.errors.join('; '));
  say('1: the polite side\'s restart took (new pair in use: ' + pair1 + ')');
  one.close();

  // 2. The same while the impolite side waits for the answer to an offer of its own, which is no restart.
  const two = pair();
  await connect(two);
  before = { a: ufrag(two.pcs.a.localDescription), b: ufrag(two.pcs.b.localDescription) };
  two.hold.b = true;
  two.pcs.b.addTransceiver('audio', { direction: 'recvonly' });
  await until('2: the impolite side in have-local-offer', () => two.pcs.b.signalingState === 'have-local-offer' && two.hold.held.some((s) => s.kind === 'offer'));
  const sentA = two.offers('a');
  if (!two.meshes.a.get('b').restartIce()) throw new Error('2: restartIce() said no');
  await until('2: the polite side\'s restart offer', () => two.offers('a') === sentA + 1 && two.pcs.a.signalingState === 'have-local-offer');
  // The impolite side ignores it: nothing changes there.
  await sleep(300);
  if (two.pcs.b.signalingState !== 'have-local-offer' || ufrag(two.pcs.b.localDescription) !== before.b) throw new Error('2: the impolite side did not ignore the offer that crossed its own');
  say('2: the polite restart offer was ignored by the impolite side, which is mid-offer');
  // Its own offer arrives after all: the polite side rolls back and answers. Nothing below asks for the restart again.
  two.release();
  const pair2 = await restarted(two, before, '2');
  if (two.offers('a') !== sentA + 2) throw new Error('2: the polite side made ' + (two.offers('a') - sentA) + ' restart offers, not 2 (the one that was rolled back, and the one Chromium asked for again)');
  if (two.errors.length) throw new Error('2: ' + two.errors.join('; '));
  say('2: after the rollback the restart went out again by itself and took (new pair in use: ' + pair2 + ')');
  two.close();
  finish(true, '(a polite-led restart: both ufrags new, ICE connected; after a rollback it is offered again without being asked)');
}
main().catch((e) => finish(false, '(' + (e && e.message ? e.message : e) + ')'));
`;

void app.whenReady().then(() => {
  // As the 3D watch page's session (tunnel-end.ts): the media permission check answers yes, so Chromium gathers on the
  // adapters themselves, as the app's pages do; every request is refused.
  const ses = session.fromPartition('castcade-ice-smoke');
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  const file = join(dir, 'ice-restart-smoke.html');
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><title>ICE restart smoke</title></head><body><script>\n'use strict';\n${negotiationSource()}\n${PAGE}\n</script></body></html>\n`);
  ipcMain.on('ice-smoke:log', (_e, line) => process.stdout.write(`  ${String(line).slice(0, 300)}\n`));
  ipcMain.once('ice-smoke:done', (_e, r) => done(r?.ok === true, String(r?.detail ?? '').slice(0, 400)));
  const w = new BrowserWindow({ show: false, width: 320, height: 120, webPreferences: { session: ses, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  w.webContents.on('render-process-gone', (_e, d) => done(false, `(the page stopped: ${d.reason})`));
  w.loadFile(file).catch((e) => done(false, `(the page did not load: ${e?.message ?? e})`));
});
