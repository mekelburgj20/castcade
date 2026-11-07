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

const connected = (id) => {
  const p = peers.get(id);
  if (!p || p.timer) return;
  say({ event: 'peer', id, ice: 'checking' });
  say({ event: 'peer', id, ice: 'connected', pair: 'srflx<->host' });
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
      peers.set(m.id, { initiator: !!m.initiator, timer: null });
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
    case 'rungs':
      return say({ event: 'log', level: 'info', text: `rungs max ${m.max_kbps} kbps${m.pin !== undefined && m.pin !== null ? `, pinned ${m.pin}` : ''}` });
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
