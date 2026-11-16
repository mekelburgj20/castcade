// I11.4.1 (2026-11-16): the 3D watch tunnel end to end on one PC, without the app. Two tunnel ends
// (`dist/watch/tunnel-end.js`: the hidden page with a real RTCPeerConnection + data channel, the bridge, the loopback
// sockets) in ONE Electron main process, with in-memory signalling in place of the ArcAid relay:
//
//   player VPX  <-loopback->  [proxy P]  <-loopback->  end P  ==data channel==  end W  <-loopback->  [proxy W]  <-loopback->  watcher VPX
//
// The two proxies only time-stamp the bytes (same process, same clock): the latency the tunnel adds is measured per
// chunk, from the moment the player's bytes reach proxy P to the moment the same byte offset leaves proxy W.
//
//   <electron.exe> companion/scripts/watch-tunnel-harness.mjs --out <dir> [--synthetic <seconds>] [--ice stun|none]
//
// Writes <out>/ports.json once ready: { playPort, watcherPort } (the player VPX listens on 127.0.0.1:playPort, the
// watcher VPX connects to 127.0.0.1:watcherPort). Logs to <out>/harness.log, a stats line every 5 s. Commands, one per
// line appended to <out>/control.txt: `drop` (close the data channel under the stream; it reopens), `quit`.
// `--synthetic N`: no VPX; a fake player streams numbered, checksummed messages for N seconds to a fake watcher, then
// the harness reports integrity, throughput and latency and quits. Every socket is on 127.0.0.1.
//
// Run it with the companion's own electron.exe (the one with Windows Firewall rules), never another copy.
import { app } from 'electron';
import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearInterval, setImmediate, setInterval, setTimeout } from 'node:timers';
import { createTunnelEnd, freeLoopbackPort } from '../dist/watch/tunnel-end.js';
import { DEFAULT_MEDIA_SETTINGS, iceServers } from '../dist/media/media-settings.js';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const out = resolve(opt('out', 'tmp/watch-harness'));
const synthetic = Number(opt('synthetic', '0'));
const ice = opt('ice', 'stun') === 'none' ? [] : iceServers(DEFAULT_MEDIA_SETTINGS);
mkdirSync(out, { recursive: true });
app.setPath('userData', join(out, 'user-data'));
const logFile = join(out, 'harness.log');
const t0 = Date.now();
/** Local time, as pair.ps1 and the fork's logs write it. */
const stamp = () => {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};
const log = (line) => {
  const l = `[${stamp()}] ${line}`;
  console.log(l);
  appendFileSync(logFile, `${l}\n`);
};
process.on('uncaughtException', (e) => log(`UNCAUGHT ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`UNHANDLED ${e?.stack ?? e}`));

// ---- the latency probe: per connection, (cumulative bytes, time) of each chunk ----
const probe = { p: null, w: null, samples: [], pConns: 0, wConns: 0 };
const newTimeline = () => ({ total: 0, marks: [], live: true });
function markP(tl, n) {
  tl.total += n;
  tl.marks.push([tl.total, performance.now()]);
  if (tl.marks.length > 200_000) tl.marks.splice(0, 100_000);
}
function markW(tl, n) {
  tl.total += n;
  const p = probe.p;
  if (!p || !p.live || !tl.live || tl.total > p.total) return;
  // The proxy P chunk that held the last byte of this one.
  const want = tl.total;
  const m = p.marks;
  let lo = 0;
  let hi = m.length - 1;
  if (hi < 0 || m[0][0] - 0 > want + 1e12) return;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m[mid][0] >= want) hi = mid;
    else lo = mid + 1;
  }
  if (m[lo][0] < want) return;
  probe.samples.push(performance.now() - m[lo][1]);
}
const pct = (arr, q) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const ms = (v) => (v === null ? '-' : v.toFixed(2));

/** A loopback proxy that time-stamps the bytes from `upstream` (P: from the player VPX) or to the client (W). */
function proxy(name, upstreamPort, side) {
  const server = createServer({ noDelay: true }, (client) => {
    const up = connect({ host: '127.0.0.1', port: upstreamPort() });
    up.setNoDelay(true);
    const tl = newTimeline();
    let connected = false;
    if (side === 'p') {
      probe.pConns += 1;
      // The newest connection is the one measured.
      if (probe.p) probe.p.live = false;
      probe.p = tl;
    } else {
      probe.wConns += 1;
      if (probe.w) probe.w.live = false;
      probe.w = tl;
    }
    up.on('connect', () => {
      connected = true;
    });
    up.on('data', (d) => {
      if (side === 'p') markP(tl, d.length);
      else markW(tl, d.length);
      if (!client.write(d)) up.pause();
    });
    client.on('drain', () => up.resume());
    client.on('data', (d) => {
      if (!up.write(d)) client.pause();
    });
    up.on('drain', () => client.resume());
    const end = (why) => {
      tl.live = false;
      client.destroy();
      up.destroy();
      void why;
    };
    up.on('error', (e) => {
      if (!connected) log(`proxy ${name}: upstream ${upstreamPort()} refused (${e.code ?? e.message})`);
      end('up error');
    });
    client.on('error', () => end('client error'));
    up.on('close', () => end('up close'));
    client.on('close', () => end('client close'));
  });
  return new Promise((r) => server.listen({ host: '127.0.0.1', port: 0 }, () => r({ server, port: server.address().port })));
}

// ---- the synthetic VPX pair (--synthetic) ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
}
/** Message k: [k u32][len u32][payload: len bytes from a PRNG seeded with k]. */
function message(k) {
  const r = lcg(k + 1);
  const len = k % 500 === 499 ? 100_000 + (r() % 50_000) : 80 + (r() % 1500);
  const b = Buffer.alloc(8 + len);
  b.writeUInt32BE(k, 0);
  b.writeUInt32BE(len, 4);
  for (let i = 0; i < len; i++) b[8 + i] = r() & 0xff;
  return b;
}
function startFakePlayer(port, seconds) {
  const state = { sent: 0, bytes: 0, conns: 0 };
  const server = createServer({ noDelay: true }, (s) => {
    state.conns += 1;
    s.setNoDelay(true);
    s.on('error', () => undefined);
    let k = 0;
    const timer = setInterval(() => {
      // 150 a second, as a VPX player at 150 fps.
      if (!s.writable) return clearInterval(timer);
      const m = message(k++);
      state.sent = k;
      state.bytes += m.length;
      s.write(m);
    }, 1000 / 150);
    s.on('close', () => clearInterval(timer));
    setTimeout(() => clearInterval(timer), seconds * 1000);
  });
  server.listen({ host: '127.0.0.1', port });
  return { server, state };
}
function startFakeWatcher(port) {
  const st = { got: 0, bytes: 0, bad: 0, connected: false, closed: false };
  const s = connect({ host: '127.0.0.1', port });
  s.setNoDelay(true);
  let buf = Buffer.alloc(0);
  s.on('connect', () => {
    st.connected = true;
    s.write(Buffer.from('watcher hello'));
  });
  s.on('data', (d) => {
    st.bytes += d.length;
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 8) {
      const len = buf.readUInt32BE(4);
      if (buf.length < 8 + len) break;
      const k = buf.readUInt32BE(0);
      const want = message(k);
      if (k !== st.got || !want.equals(buf.subarray(0, 8 + len))) st.bad += 1;
      st.got = k + 1;
      buf = buf.subarray(8 + len);
    }
  });
  s.on('error', (e) => log(`fake watcher: ${e.code ?? e.message}`));
  s.on('close', () => (st.closed = true));
  return { socket: s, st };
}

// ---- main ----
let P = null;
let W = null;
const changes = { p: 0, w: 0 };
async function main() {
  log(`harness: out ${out}; ice ${ice.length ? 'Google STUN (the default media settings)' : 'none'}; electron ${process.versions.electron}`);
  // Signals cross on the next turn of the event loop, in order, as a relay would carry them (without its delay).
  P = createTunnelEnd({
    dir: join(out, 'end-p'),
    partition: 'castcade-watch-harness-p',
    localId: 'harness-p',
    iceServers: ice,
    sendSignal: (to, s) => setImmediate(() => W?.signal('harness-p', s)),
    log: (l) => log(`P ${l}`),
    onChange: () => (changes.p += 1),
  });
  W = createTunnelEnd({
    dir: join(out, 'end-w'),
    partition: 'castcade-watch-harness-w',
    localId: 'harness-w',
    iceServers: ice,
    sendSignal: (to, s) => setImmediate(() => P?.signal('harness-w', s)),
    log: (l) => log(`W ${l}`),
    onChange: () => (changes.w += 1),
  });
  P.setPeers(['harness-w']);
  W.setPeers(['harness-p']);
  const playPort = await freeLoopbackPort();
  const pxP = await proxy('P', () => playPort, 'p');
  P.setPlayerPort(pxP.port);
  const watchPort = await W.watch('harness-p');
  const pxW = await proxy('W', () => watchPort, 'w');
  writeFileSync(join(out, 'ports.json'), JSON.stringify({ playPort, watcherPort: pxW.port, tunnelWatchPort: watchPort, tunnelPlayerPort: pxP.port }, null, 2));
  log(`harness: the player VPX listens on 127.0.0.1:${playPort} (end P connects through proxy ${pxP.port}); the watcher VPX connects to 127.0.0.1:${pxW.port} (proxy to end W's ${watchPort})`);

  let lastP = null;
  let lastW = null;
  let lastAt = performance.now();
  const statsLine = () => {
    const sp = P.status();
    const sw = W.status();
    const now = performance.now();
    const dt = (now - lastAt) / 1000;
    const rate = (a, b) => Math.round((a - (b ?? 0)) / dt);
    const peerP = sp.peers['harness-w'];
    const peerW = sw.peers['harness-p'];
    const samples = probe.samples.splice(0);
    log(
      `stats: path ${peerW?.path ?? '?'} (${peerW?.pair ?? 'no pair'}, ice ${peerW?.ice ?? '?'}/${peerP?.ice ?? '?'}); ` +
        `streams P ${sp.stats.streams.length} W ${sw.stats.streams.length}; ` +
        `player->watcher ${rate(sw.stats.bytesIn, lastW?.bytesIn)} B/s in ${sw.stats.framesIn - (lastW?.framesIn ?? 0)} frames, watcher->player ${rate(sp.stats.bytesIn, lastP?.bytesIn)} B/s; ` +
        `latency added ms (n ${samples.length}): p50 ${ms(pct(samples, 0.5))} p95 ${ms(pct(samples, 0.95))} p99 ${ms(pct(samples, 0.99))} max ${ms(pct(samples, 1))}; ` +
        `stalls channel ${sp.stats.channelStalls}/${sw.stats.channelStalls} socket ${sp.stats.socketStalls}/${sw.stats.socketStalls}; opened ${sp.stats.opened}/${sw.stats.opened} refused ${sp.stats.refused}/${sw.stats.refused}`,
    );
    allSamples.push(...samples);
    lastP = sp.stats;
    lastW = sw.stats;
    lastAt = now;
  };
  const allSamples = [];
  setInterval(statsLine, 5000);

  // Commands.
  const control = join(out, 'control.txt');
  let done = 0;
  setInterval(() => {
    if (!existsSync(control)) return;
    const lines = readFileSync(control, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    for (const cmd of lines.slice(done)) {
      done += 1;
      log(`harness: command ${cmd}`);
      if (cmd === 'drop') W.dropPeer('harness-p');
      if (cmd === 'quit') void quit(0);
    }
  }, 200);

  const summary = () => {
    const all = allSamples.concat(probe.samples);
    log(`summary: latency added ms over ${all.length} chunks: p50 ${ms(pct(all, 0.5))} p95 ${ms(pct(all, 0.95))} p99 ${ms(pct(all, 0.99))} max ${ms(pct(all, 1))}; connections proxy P ${probe.pConns}, proxy W ${probe.wConns}`);
    const sp = P.status().stats;
    const sw = W.status().stats;
    log(`summary: end P sent ${sp.bytesOut} B in ${sp.framesOut} frames, end W received ${sw.bytesIn} B in ${sw.framesIn} frames; streams opened ${sp.opened}/${sw.opened}, refused ${sp.refused}/${sw.refused}; stalls channel ${sp.channelStalls}/${sw.channelStalls}, socket ${sp.socketStalls}/${sw.socketStalls}`);
  };
  async function quit(code) {
    summary();
    await P.close();
    await W.close();
    log(`harness: done (${Math.round((Date.now() - t0) / 1000)} s)`);
    app.exit(code);
  }

  if (synthetic > 0) {
    const player = startFakePlayer(playPort, synthetic);
    // Wait for the data channel, then connect the fake watcher through proxy W.
    const until = Date.now() + 20_000;
    while (!W.status().peers['harness-p']?.channelOpen) {
      if (Date.now() > until) {
        log('synthetic: the data channel did not open in 20 s');
        return quit(2);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    log(`synthetic: data channel open after ${Math.round((Date.now() - t0) / 100) / 10} s; streaming for ${synthetic} s`);
    const watcher = startFakeWatcher(pxW.port);
    await new Promise((r) => setTimeout(r, synthetic * 1000 + 1500));
    statsLine();
    const ok = watcher.st.bad === 0 && watcher.st.got === player.state.sent && watcher.st.got > 0;
    log(`synthetic: player sent ${player.state.sent} messages (${player.state.bytes} B), watcher got ${watcher.st.got} (${watcher.st.bytes} B), ${watcher.st.bad} bad; ${ok ? 'INTACT' : 'BROKEN'}`);
    watcher.socket.destroy();
    player.server.close();
    return quit(ok ? 0 : 1);
  }
}

app.on('window-all-closed', () => {
  /* hidden pages only: keep running */
});
void app.whenReady().then(main).catch((e) => {
  log(`harness failed: ${e?.stack ?? e}`);
  app.exit(3);
});
