#!/usr/bin/env node
/**
 * shaper.mjs — the D10.0.1 two-sided UDP relay with a token-bucket cap on the sender → receiver direction.
 *
 *   node spike/d10-video/shaper/shaper.mjs --s 5000 --c 5001 --schedule 20000:30,2000:20,20000:40
 *        [--loss <pct>] [--log <file>] [--start-on-first-packet]
 *
 * Port S faces the sender, port C the receiver (both bound to 0.0.0.0). A datagram arriving on S from X makes X
 * the sender peer and goes out of C to the receiver peer (once known); one arriving on C from Y makes Y the receiver
 * peer and goes out of S to the sender peer. S→C is capped by the schedule (kbps:seconds, the last rate holds; the
 * clock starts at launch, or at the first S→C datagram with --start-on-first-packet) with a queue bounded to 150 ms
 * of bytes at the current rate, tail-drop beyond, plus optional random loss. C→S is unlimited. One CSV line a
 * second goes to stderr and --log: t,rate_kbps,fwd_kbps,dropped,queued_ms (queued_ms = the second's deepest queue).
 *
 * Pacing: Node's timers on Windows tick at 15.6 ms here (measured: setTimeout(1) and Atomics.wait both), which
 * would release 15 ms bursts. While the queue is non-empty the drain runs on a setImmediate loop (sub-ms, one core
 * busy); with an empty queue forwarding is arrival-driven and the process idles. Node >= 22, no dependencies.
 */
import { createSocket } from 'node:dgram';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const portS = Number(opt('s', 5000)), portC = Number(opt('c', 5001));
const lossPct = Number(opt('loss', 0));
const logFile = opt('log', null);
const startOnFirst = args.includes('--start-on-first-packet');
const schedule = String(opt('schedule', '20000:30,2000:20,20000:40')).split(',').map((s) => {
  const [kbps, secs] = s.split(':').map(Number);
  if (!(kbps > 0) || !(secs >= 0)) throw new Error(`bad schedule step ${s}`);
  return { kbps, secs };
});

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
let clock0 = startOnFirst ? null : nowMs();        // schedule clock origin
const rateAt = (t) => {                              // kbps at schedule time t (seconds)
  let acc = 0;
  for (const step of schedule) { acc += step.secs; if (t < acc) return step.kbps; }
  return schedule[schedule.length - 1].kbps;
};
const currentRate = () => (clock0 === null ? schedule[0].kbps : rateAt((nowMs() - clock0) / 1000));

let sender = null, receiver = null;
const queue = [];                 // S→C datagrams waiting for tokens
let queuedBytes = 0;
let tokens = 0, lastFill = nowMs();
let draining = false;
const stat = { fwd: 0, dropped: 0, queuedMsMax: 0 };

const sockS = createSocket('udp4'), sockC = createSocket('udp4');
for (const s of [sockS, sockC]) s.on('error', (e) => { console.error(`socket error: ${e.message}`); process.exit(1); });

function fill() {
  const now = nowMs();
  const bytesPerMs = currentRate() * 1000 / 8 / 1000;
  tokens = Math.min(tokens + (now - lastFill) * bytesPerMs, bytesPerMs * 5);  // burst allowance: 5 ms of the rate
  lastFill = now;
}

function drain() {
  fill();
  while (queue.length && tokens >= queue[0].length) {
    const d = queue.shift();
    queuedBytes -= d.length;
    tokens -= d.length;
    stat.fwd += d.length;
    sockC.send(d, receiver.port, receiver.address);
  }
  if (queue.length) setImmediate(drain); else draining = false;
}

sockS.on('message', (msg, rinfo) => {
  sender = rinfo;
  if (!receiver) return;
  if (clock0 === null) clock0 = nowMs();
  if (lossPct > 0 && Math.random() * 100 < lossPct) { stat.dropped++; return; }
  const limit = currentRate() * 1000 / 8 * 0.150;  // 150 ms of bytes at the current rate
  if (queuedBytes + msg.length > limit) { stat.dropped++; return; }
  queue.push(msg);
  queuedBytes += msg.length;
  const ms = queuedBytes / (currentRate() * 1000 / 8) * 1000;
  if (ms > stat.queuedMsMax) stat.queuedMsMax = ms;
  if (!draining) { draining = true; drain(); }
});

sockC.on('message', (msg, rinfo) => {
  receiver = rinfo;
  if (sender) sockS.send(msg, sender.port, sender.address);
});

sockS.bind(portS, '0.0.0.0', () => sockS.setRecvBufferSize(4 << 20));
sockC.bind(portC, '0.0.0.0', () => sockC.setRecvBufferSize(4 << 20));

const header = 't,rate_kbps,fwd_kbps,dropped,queued_ms';
console.error(header);
if (logFile) appendFileSync(logFile, header + '\n');
let lastLog = nowMs();
setInterval(() => {
  const now = nowMs();
  const dt = (now - lastLog) / 1000;
  lastLog = now;
  const t = clock0 === null ? 0 : (now - clock0) / 1000;
  const line = `${t.toFixed(1)},${currentRate()},${Math.round(stat.fwd * 8 / dt / 1000)},${stat.dropped},${Math.round(stat.queuedMsMax)}`;
  stat.fwd = 0; stat.dropped = 0; stat.queuedMsMax = 0;
  console.error(line);
  if (logFile) appendFileSync(logFile, line + '\n');
}, 1000);
console.error(`shaper: S=${portS} (sender side) C=${portC} (receiver side) schedule=${schedule.map((s) => `${s.kbps}:${s.secs}`).join(',')} loss=${lossPct}%${startOnFirst ? ' clock starts on the first S→C datagram' : ''}`);
