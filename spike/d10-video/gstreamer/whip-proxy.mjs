#!/usr/bin/env node
// D10.0.1 WHIP proxy (Node, no deps): sits between whipclientsink and whipserversrc and rewrites the SDP so the
// media goes through the shared UDP shaper (spike/d10-video/shaper). Rule: each side's SDP to the other keeps ONE
// host UDP candidate, its port replaced by the shaper port facing the other side; the rest are dropped.
//   offer  (sender → receiver): candidate port := C (the port the receiver talks to)
//   answer (receiver → sender): candidate port := S (the port the sender talks to)
// Trickle PATCHes are answered 405 (neither GStreamer WHIP element trickles: both send full SDP after gathering).
//   node whip-proxy.mjs --listen 8090 --upstream http://127.0.0.1:8080 --s 27410 --c 27411 [--prefer-ip 127.0.0.1]
import http from 'node:http';

export function rewriteSdp(sdp, port, preferIp = '127.0.0.1') {
  const nl = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(nl);
  const cands = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.startsWith('a=candidate:'));
  const parsed = cands.map(({ l, i }) => { const f = l.slice('a=candidate:'.length).split(' '); return { i, f, host: f[7] === 'host', udp: f[2].toLowerCase() === 'udp', ip: f[4], v4: /^\d+\.\d+\.\d+\.\d+$/.test(f[4]) }; });
  const ok = parsed.filter((c) => c.host && c.udp && c.v4);
  const keep = ok.find((c) => c.ip === preferIp) ?? ok[0];
  if (!keep) return { sdp, kept: null };
  if (port) keep.f[5] = String(port); // port 0 = keep the real port (proxy pass-through, no shaper)
  port = Number(keep.f[5]);
  const dropIdx = new Set(parsed.filter((c) => c !== keep).map((c) => c.i));
  const out = lines.filter((_, i) => !dropIdx.has(i)).map((l, _i) => {
    if (l.startsWith('a=candidate:') && l === lines[keep.i]) return 'a=candidate:' + keep.f.join(' ');
    if (l.startsWith('c=IN IP4 ')) return `c=IN IP4 ${keep.ip}`;
    if (l.startsWith('m=video ') || l.startsWith('m=audio ') || l.startsWith('m=application ')) { const f = l.split(' '); f[1] = String(port); return f.join(' '); }
    return l;
  });
  return { sdp: out.join(nl), kept: `${keep.ip}:${keep.f[5]}` };
}

export function startProxy({ listen = 8090, upstream = 'http://127.0.0.1:8080', s = 27410, c = 27411, preferIp = '127.0.0.1', log = console.log } = {}) {
  const up = new URL(upstream);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.method === 'PATCH') { res.writeHead(405).end(); log(`proxy: dropped PATCH ${req.url}`); return; }
      if (req.method === 'POST' && (req.headers['content-type'] || '').startsWith('application/sdp')) {
        const r = rewriteSdp(body.toString('utf8'), c, preferIp);
        log(`proxy: offer → candidate ${r.kept} (port C)`);
        body = Buffer.from(r.sdp, 'utf8');
      }
      const headers = { ...req.headers, host: up.host, 'content-length': String(body.length) };
      const preq = http.request({ hostname: up.hostname, port: up.port, path: req.url, method: req.method, headers }, (pres) => {
        const pchunks = [];
        pres.on('data', (d) => pchunks.push(d));
        pres.on('end', () => {
          let pbody = Buffer.concat(pchunks);
          const h = { ...pres.headers };
          if ((h['content-type'] || '').startsWith('application/sdp')) {
            const r = rewriteSdp(pbody.toString('utf8'), s, preferIp);
            log(`proxy: answer → candidate ${r.kept} (port S), status ${pres.statusCode}, location ${h.location}`);
            pbody = Buffer.from(r.sdp, 'utf8');
          }
          h['content-length'] = String(pbody.length);
          delete h['transfer-encoding'];
          res.writeHead(pres.statusCode, h).end(pbody);
        });
      });
      preq.on('error', (e) => { log(`proxy: upstream error ${e.message}`); res.writeHead(502).end(); });
      preq.end(body);
    });
  });
  server.listen(listen, '127.0.0.1');
  log(`proxy: http://127.0.0.1:${listen}/whip/endpoint → ${upstream}, shaper S=${s} C=${c}`);
  return server;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  startProxy({ listen: Number(opt('listen', 8090)), upstream: opt('upstream', 'http://127.0.0.1:8080'), s: Number(opt('s', 27410)), c: Number(opt('c', 27411)), preferIp: opt('prefer-ip', '127.0.0.1') });
}
