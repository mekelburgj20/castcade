#!/usr/bin/env node
// drive-pair.mjs — a two-helper rehearsal of the companion's job (D10.1 / D10.3), no Electron: spawns two
// castcade-video.exe, relays their `signal` events to each other as the match channel would, points A's source at a
// send ring and B's sink at a recv ring (vr-layer/build/Release/ring_feed.exe fills and drains them), prints the stats.
//
//   node video-helper/tools/drive-pair.mjs [--exe <path>] [--seconds 15] [--send-token tokS] [--recv-token tokR]
//        [--width 1354 --height 1440 --fps 60] [--bench]   (--bench: A uses the synthetic source instead of the ring)
//
// Run beside it, in two other terminals (or let --feed start them for you when ring_feed.exe is found):
//   vr-layer\build\Release\ring_feed.exe --send tokS --width 1354 --height 1440 --fps 60 --seconds 30
//   vr-layer\build\Release\ring_feed.exe --recv tokR --seconds 30
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const exe = resolve(opt('exe', resolve(here, '..', 'build', 'Release', 'castcade-video.exe')));
const seconds = Number(opt('seconds', 15));
const sendToken = opt('send-token', 'tokS'), recvToken = opt('recv-token', 'tokR');
const width = Number(opt('width', 1354)), height = Number(opt('height', 1440)), fps = Number(opt('fps', 60));
const feed = resolve(here, '..', '..', 'vr-layer', 'build', 'Release', 'ring_feed.exe');
if (!existsSync(exe)) { console.error(`missing ${exe}`); process.exit(2); }

const log = (who, text) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} ${who} ${text}`);
const t0 = Date.now();

function helper(name) {
  const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const h = { name, p, send: (o) => p.stdin.write(JSON.stringify(o) + '\n'), on: () => {} };
  createInterface({ input: p.stdout }).on('line', (line) => {
    let ev; try { ev = JSON.parse(line); } catch { log(name, `junk ${line}`); return; }
    h.on(ev);
  });
  createInterface({ input: p.stderr }).on('line', (line) => { if (/error|warn|ring|source|probe: encoder h264|decoder h264_cuvid/i.test(line)) log(name, `stderr ${line}`); });
  p.on('exit', (code) => log(name, `exit ${code}`));
  return h;
}

const A = helper('A'), B = helper('B');
const other = { A: B, B: A };
const ready = { A: false, B: false };
const stats = [];

for (const h of [A, B]) {
  h.on = (ev) => {
    switch (ev.event) {
      case 'ready': ready[h.name] = true; log(h.name, `ready ${ev.version} enc=${ev.encoder} dec=${ev.decoder}`); if (ready.A && ready.B) start(); break;
      case 'signal': other[h.name].send({ cmd: 'signal', id: h.name, kind: ev.kind, sdp: ev.sdp, candidate: ev.candidate }); break;
      case 'peer': log(h.name, `peer ${ev.id} ice=${ev.ice}${ev.pair ? ` pair=${ev.pair.local?.type}<->${ev.pair.remote?.type}` : ''}`); break;
      case 'stats': stats.push({ who: h.name, ...ev }); log(h.name, `stats ${ev.dir} ${ev.width}x${ev.height} ${ev.fps} fps ${ev.kbps} kbps${ev.rtt_ms != null ? ` rtt ${ev.rtt_ms}` : ''}${ev.bwe_kbps != null ? ` bwe ${ev.bwe_kbps}` : ''}${ev.enc_us != null ? ` enc ${ev.enc_us}us` : ''}${ev.dec_us != null ? ` dec ${ev.dec_us}us` : ''}${ev.freeze_ms != null ? ` freeze ${ev.freeze_ms}` : ''}`); break;
      case 'source': log(h.name, `source ${ev.kind} ${ev.state} fps_in=${ev.fps_in}`); break;
      case 'error': log(h.name, `ERROR ${ev.code} ${ev.text ?? ''}`); break;
      case 'log': if (ev.level !== 'info') log(h.name, `${ev.level} ${ev.text}`); break;
      default: log(h.name, `event ${JSON.stringify(ev)}`);
    }
  };
}

let feeds = [];
function start() {
  for (const h of [A, B]) h.send({ cmd: 'ice', servers: [] });
  if (flag('bench')) A.send({ cmd: 'source', kind: 'bench', width, height, fps });
  else A.send({ cmd: 'source', kind: 'ring', token: sendToken, width, height, fps });
  B.send({ cmd: 'sink', kind: 'ring', token: recvToken, width, height });
  A.send({ cmd: 'rungs', max_kbps: 20000 });
  // B is told its peer first so A's offer finds it; A initiates.
  B.send({ cmd: 'peer', id: 'A', initiator: false });
  A.send({ cmd: 'peer', id: 'B', initiator: true });
  A.send({ cmd: 'send', on: true });
  if (flag('feed') && existsSync(feed)) {
    const mk = (a) => { const p = spawn(feed, a, { stdio: ['ignore', 'pipe', 'inherit'] }); createInterface({ input: p.stdout }).on('line', (l) => log(a[0] === '--send' ? 'feedS' : 'feedR', l)); return p; };
    feeds = [mk(['--send', sendToken, '--width', String(width), '--height', String(height), '--fps', String(fps), '--seconds', String(seconds + 2)]), mk(['--recv', recvToken, '--seconds', String(seconds + 2)])];
  }
  setTimeout(stop, seconds * 1000);
}

function stop() {
  A.send({ cmd: 'send', on: false });
  for (const h of [A, B]) h.send({ cmd: 'quit' });
  const recv = stats.filter((s) => s.who === 'B' && s.dir === 'recv' && s.fps > 0);
  const send = stats.filter((s) => s.who === 'A' && s.dir === 'send' && s.fps > 0);
  const avg = (a, k) => (a.length ? (a.reduce((x, s) => x + (s[k] ?? 0), 0) / a.length).toFixed(0) : '-');
  console.log(`summary: send ${send.length} s at ${avg(send, 'fps')} fps ${avg(send, 'kbps')} kbps enc ${avg(send, 'enc_us')} us · recv ${recv.length} s at ${avg(recv, 'fps')} fps ${avg(recv, 'kbps')} kbps dec ${avg(recv, 'dec_us')} us freeze max ${Math.max(0, ...recv.map((s) => s.freeze_ms ?? 0))} ms`);
  setTimeout(() => { for (const h of [A, B]) h.p.kill(); for (const f of feeds) f.kill(); process.exit(0); }, 3000);
}
