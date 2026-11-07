// A stand-in for castcade-video.exe that speaks the stdio protocol of docs/design/spectator-video-native.md §6.2
// (D10.3, 2026-11-07), for video-helper.test.ts and video-mesh.test.ts: run with `node fake-video-helper.mjs`.
// No WebRTC, no frames: it answers `ready`, makes an "offer" when it is the initiator, answers an offer, declares the
// peer connected after an answer, sends one `stats` per direction per interval, `error bad_command` for junk, and exits
// on `quit` or EOF. Knobs through the environment (tests only):
//   FAKE_VIDEO_EXIT=<code>     exit with that code at once, before `ready` (a helper that cannot run here)
//   FAKE_VIDEO_CRASH_AFTER=<ms> exit 3 that long after `ready` (an exit nobody asked for)
//   FAKE_VIDEO_JUNK=1          one line that is not JSON before `ready`
//   FAKE_VIDEO_STDERR=<text>   one stderr line at start
//   FAKE_VIDEO_STATS_MS=<ms>   the stats interval (1000)
//   FAKE_VIDEO_NAME=<name>     this helper's name in the SDP text it makes
//   FAKE_VIDEO_ICE_FAIL=<n>    D10.3.6: every peer fails instead of connecting: `checking`, then `failed` with
//                              `restarts: n, restarts_exhausted: true` (the helper's ICE restart policy spent)
import process from 'node:process';
import { createInterface } from 'node:readline';
import { clearInterval, setInterval, setTimeout } from 'node:timers';

const env = process.env;
if (env.FAKE_VIDEO_EXIT !== undefined) process.exit(Number(env.FAKE_VIDEO_EXIT));
if (env.FAKE_VIDEO_STDERR) process.stderr.write(`${env.FAKE_VIDEO_STDERR}\n`);
const name = env.FAKE_VIDEO_NAME || 'fake';
const statsMs = Number(env.FAKE_VIDEO_STATS_MS || 1000);

const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const peers = new Map();
let source = { kind: 'none' };
// D10.5: the rung in force (the pin, else rung 3 as the helper starts), announced per peer as a `rung` event.
let pin = null;
const RUNGS = [[1354, 1440, 60, 20000], [1354, 1440, 30, 10000], [1016, 1080, 60, 8000], [1016, 1080, 30, 5000], [678, 720, 60, 4000], [678, 720, 30, 2000]];
const sayRung = (id, reason) => {
  const r = pin ?? 3;
  const [width, height, fps, kbps] = RUNGS[r - 1];
  say({ event: 'rung', id, rung: r, width, height, fps, kbps, reason });
};

const connected = (id) => {
  const p = peers.get(id);
  if (!p || p.timer || p.failed) return;
  say({ event: 'peer', id, ice: 'checking' });
  if (env.FAKE_VIDEO_ICE_FAIL !== undefined) {
    p.failed = true;
    return say({ event: 'peer', id, ice: 'failed', restarts: Number(env.FAKE_VIDEO_ICE_FAIL), restarts_exhausted: true });
  }
  say({ event: 'peer', id, ice: 'connected', pair: 'srflx<->host' });
  sayRung(id, 'start');
  p.timer = setInterval(() => {
    say({ event: 'stats', id, dir: 'send', fps: 60, kbps: 18200, width: 1354, height: 1440, rtt_ms: 31, loss_pct: 0, bwe_kbps: 24000, encoder: 'libx264' });
    say({ event: 'stats', id, dir: 'recv', fps: 60, kbps: 17900, width: 1354, height: 1440, decoder: 'h264' });
  }, statsMs);
  p.timer.unref?.();
};

const closePeer = (id) => {
  const p = peers.get(id);
  if (!p) return;
  if (p.timer) clearInterval(p.timer);
  peers.delete(id);
  say({ event: 'peer', id, ice: 'closed' });
};

const quit = () => {
  for (const id of [...peers.keys()]) closePeer(id);
  process.exit(0);
};

const handle = (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return say({ event: 'error', code: 'bad_command', text: 'not JSON' });
  }
  if (typeof m !== 'object' || m === null || typeof m.cmd !== 'string') return say({ event: 'error', code: 'bad_command', text: 'no cmd' });
  switch (m.cmd) {
    case 'ice':
      return say({ event: 'log', level: 'info', text: `ice ${Array.isArray(m.servers) ? m.servers.length : 0} server(s)` });
    case 'peer': {
      if (typeof m.id !== 'string') return say({ event: 'error', code: 'bad_command', text: 'peer without id' });
      peers.set(m.id, { initiator: !!m.initiator, timer: null, failed: false });
      if (m.initiator) say({ event: 'signal', id: m.id, kind: 'offer', sdp: `v=0 offer from ${name} to ${m.id}` });
      return;
    }
    case 'signal': {
      if (!peers.has(m.id)) return say({ event: 'error', code: 'peer_unknown', text: String(m.id) });
      if (m.kind === 'offer') {
        say({ event: 'signal', id: m.id, kind: 'answer', sdp: `v=0 answer from ${name} to ${m.id}` });
        say({ event: 'signal', id: m.id, kind: 'ice', candidate: { candidate: `candidate:1 1 udp 1 10.0.0.1 1 typ host ${name}`, sdpMid: '0', sdpMLineIndex: 0 } });
        connected(m.id);
      } else if (m.kind === 'answer') connected(m.id);
      return;
    }
    case 'close':
      return closePeer(m.id);
    case 'source':
      source = m;
      return say({ event: 'source', kind: m.kind, state: m.kind === 'ring' && m.token === 'missing-ring' ? 'missing' : 'ok', fps_in: m.kind === 'none' ? 0 : Number(m.fps) || 0 });
    case 'send':
      return say({ event: 'log', level: 'info', text: `send ${m.on ? 'on' : 'off'} (${source.kind})` });
    case 'rungs': {
      pin = typeof m.pin === 'number' ? m.pin : null;
      say({ event: 'log', level: 'info', text: `rungs max ${m.max_kbps} kbps${pin !== null ? `, pinned ${pin}` : ''}` });
      for (const [id, p] of peers) if (p.timer) sayRung(id, pin !== null ? 'pin' : 'up');
      return;
    }
    case 'sink':
      return say({ event: 'log', level: 'info', text: `sink ${m.kind}${m.token ? ` ${m.token}` : ''}` });
    case 'quit':
      return quit();
    default:
      return say({ event: 'error', code: 'bad_command', text: m.cmd });
  }
};

if (env.FAKE_VIDEO_JUNK) process.stdout.write('castcade-video: starting up (not JSON)\n');
say({ event: 'ready', version: '0.0.0-fake', encoder: 'libx264', decoder: 'h264' });
if (env.FAKE_VIDEO_CRASH_AFTER) setTimeout(() => process.exit(3), Number(env.FAKE_VIDEO_CRASH_AFTER));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (line.trim()) handle(line.trim());
});
rl.on('close', quit);
