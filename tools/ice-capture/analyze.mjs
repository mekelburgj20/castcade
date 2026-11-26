#!/usr/bin/env node
// Castcade ICE capture analyzer, version 1 (WORK I11.12.1). Node 22+, no dependencies.
//
// Reads a folder written by ice-capture.ps1 (capture.pcapng, sockets.csv, meta.json, firewall.log) and
// prints, for each ICE session of Castcade's own UDP sockets, the connectivity checks this PC sent and
// received, whether any were answered, from which ports the peer's checks came, and what Windows
// Firewall dropped. No IP address is printed: every address becomes an alias ("peer A", "STUN server 1").
//
//   node tools/ice-capture/analyze.mjs <capture folder> [--companion-log <companion.log>] [--all]
//
// Writes summary.txt into the folder and prints the same text. See README.md.
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ANALYZER_VERSION = 1;
export const STUN_MAGIC = 0x2112a442;
const STUN_SERVER_PORTS = new Set([3478, 5349, 19302]);

// ------------------------------------------------------------------------------------------ pcapng

/**
 * The packets of a pcapng file. Interface Description Blocks give each packet its link type and
 * timestamp unit; Enhanced Packet Blocks carry the bytes. A truncated last block is ignored.
 */
export function parsePcapng(buf) {
  const interfaces = [];
  const packets = [];
  let off = 0;
  let le = true;
  let ifBase = 0;
  while (off + 12 <= buf.length) {
    if (buf.readUInt32LE(off) === 0x0a0d0d0a) {
      // Section Header Block (its type reads the same in both byte orders): the byte-order magic.
      if (buf.readUInt32LE(off + 8) === 0x1a2b3c4d) le = true;
      else if (buf.readUInt32BE(off + 8) === 0x1a2b3c4d) le = false;
      else throw new Error('not a pcapng file (bad byte-order magic)');
      ifBase = interfaces.length;
    }
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const type = u32(off);
    const len = u32(off + 4);
    if (len < 12 || len % 4 !== 0 || off + len > buf.length) break;
    const body = off + 8;
    const end = off + len - 4;
    if (type === 1 && body + 8 <= end) {
      let tsUnitsPerSec = 1e6;
      let name = '';
      for (let o = body + 8; o + 4 <= end; ) {
        const code = u16(o);
        const olen = u16(o + 2);
        if (code === 0) break;
        if (code === 2) name = buf.toString('utf8', o + 4, Math.min(o + 4 + olen, end));
        if (code === 9 && olen >= 1) {
          const r = buf[o + 4];
          tsUnitsPerSec = r & 0x80 ? 2 ** (r & 0x7f) : 10 ** r;
        }
        o += 4 + ((olen + 3) & ~3);
      }
      interfaces.push({ linkType: u16(body), name, tsUnitsPerSec });
    } else if (type === 6 && body + 20 <= end) {
      const iface = interfaces[ifBase + u32(body)];
      const capLen = u32(body + 12);
      if (iface && body + 20 + capLen <= end) {
        const units = u32(body + 4) * 2 ** 32 + u32(body + 8);
        packets.push({
          ifId: ifBase + u32(body),
          ms: (units / iface.tsUnitsPerSec) * 1000,
          linkType: iface.linkType,
          data: buf.subarray(body + 20, body + 20 + capLen),
        });
      }
    }
    off += len;
  }
  return { interfaces, packets };
}

// ---------------------------------------------------------------------------------- IP and UDP

function ipv4(b, o) {
  return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
}

function ipv6(b, o) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push(b.readUInt16BE(o + i).toString(16));
  return g.join(':');
}

/** Expands `::` so an address from Windows compares equal to one read from a packet. */
export function normalizeIp(ip) {
  const s = String(ip).trim().toLowerCase().replace(/%.*$/, '');
  if (!s.includes(':')) return s;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = s.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16).toString(16)).join(':');
}

/** private, link-local, carrier NAT, loopback or public: what a masked address still says. */
export function addressClass(ip) {
  const s = normalizeIp(ip);
  if (!s.includes(':')) {
    const [a, b] = s.split('.').map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 100 && b >= 64 && b <= 127) return 'carrier NAT';
    if (a === 127) return 'loopback';
    return 'public';
  }
  const first = parseInt(s.split(':')[0], 16);
  if ((first & 0xfe00) === 0xfc00) return 'private';
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if (s === '0:0:0:0:0:0:0:1') return 'loopback';
  return 'public';
}

/** The UDP datagram in one captured frame, or null (not IPv4 / IPv6 UDP, a later fragment, too short). */
export function parseUdp(data, linkType) {
  let o = 0;
  let ethType;
  if (linkType === 1) {
    if (data.length < 14) return null;
    ethType = data.readUInt16BE(12);
    o = 14;
    while (ethType === 0x8100 || ethType === 0x88a8) {
      if (data.length < o + 4) return null;
      ethType = data.readUInt16BE(o + 2);
      o += 4;
    }
  } else if (linkType === 101 || linkType === 12 || linkType === 14) {
    if (data.length < 1) return null;
    ethType = data[0] >> 4 === 6 ? 0x86dd : 0x0800;
  } else if (linkType === 228) ethType = 0x0800;
  else if (linkType === 229) ethType = 0x86dd;
  else return null;
  let src;
  let dst;
  let proto;
  let l4;
  if (ethType === 0x0800) {
    if (data.length < o + 20) return null;
    if ((data.readUInt16BE(o + 6) & 0x1fff) !== 0) return null;
    proto = data[o + 9];
    src = ipv4(data, o + 12);
    dst = ipv4(data, o + 16);
    l4 = o + (data[o] & 0x0f) * 4;
  } else if (ethType === 0x86dd) {
    if (data.length < o + 40) return null;
    proto = data[o + 6];
    src = ipv6(data, o + 8);
    dst = ipv6(data, o + 24);
    l4 = o + 40;
    for (let n = 0; (proto === 0 || proto === 43 || proto === 60) && n < 4; n++) {
      if (data.length < l4 + 2) return null;
      proto = data[l4];
      l4 += (data[l4 + 1] + 1) * 8;
    }
  } else return null;
  if (proto !== 17 || data.length < l4 + 8) return null;
  return {
    family: ethType === 0x0800 ? 4 : 6,
    src,
    dst,
    sport: data.readUInt16BE(l4),
    dport: data.readUInt16BE(l4 + 2),
    length: data.readUInt16BE(l4 + 4) - 8,
    payload: data.subarray(l4 + 8),
  };
}

// ------------------------------------------------------------------------------------------- STUN

function xorAddress(p, v, len) {
  const family = p[v + 1];
  const port = p.readUInt16BE(v + 2) ^ (STUN_MAGIC >>> 16);
  if (family === 1 && len >= 8) {
    const a = (p.readUInt32BE(v + 4) ^ STUN_MAGIC) >>> 0;
    return { ip: `${a >>> 24}.${(a >>> 16) & 255}.${(a >>> 8) & 255}.${a & 255}`, port };
  }
  if (family === 2 && len >= 20) {
    const key = Buffer.concat([p.subarray(4, 8), p.subarray(8, 20)]);
    const x = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) x[i] = p[v + 4 + i] ^ key[i];
    return { ip: ipv6(x, 0), port };
  }
  return null;
}

function plainAddress(p, v, len) {
  const family = p[v + 1];
  const port = p.readUInt16BE(v + 2);
  if (family === 1 && len >= 8) return { ip: ipv4(p, v + 4), port };
  if (family === 2 && len >= 20) return { ip: ipv6(p, v + 4), port };
  return null;
}

/**
 * A STUN message (RFC 8489) or null. `fullLength` is the UDP payload's length from its header, so a
 * message cut short by the capture's snap length is still recognised; attributes past the cut are not read.
 * cls: 0 request, 1 indication, 2 success response, 3 error response.
 */
export function parseStun(p, fullLength = p.length) {
  if (p.length < 20 || (p[0] & 0xc0) !== 0 || p.readUInt32BE(4) !== STUN_MAGIC) return null;
  const msgLen = p.readUInt16BE(2);
  if (msgLen % 4 !== 0 || 20 + msgLen !== fullLength) return null;
  const type = p.readUInt16BE(0);
  const msg = {
    method: (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2),
    cls: ((type & 0x0010) >> 4) | ((type & 0x0100) >> 7),
    txid: p.toString('hex', 8, 20),
    username: null,
    mapped: null,
    controlling: null,
    useCandidate: false,
    errorCode: null,
  };
  const end = Math.min(p.length, 20 + msgLen);
  for (let o = 20; o + 4 <= end; ) {
    const at = p.readUInt16BE(o);
    const al = p.readUInt16BE(o + 2);
    const v = o + 4;
    if (v + al > end) break;
    if (at === 0x0006) msg.username = p.toString('utf8', v, v + al);
    else if (at === 0x0020) msg.mapped = xorAddress(p, v, al) ?? msg.mapped;
    else if (at === 0x0001 && !msg.mapped) msg.mapped = plainAddress(p, v, al);
    else if (at === 0x802a) msg.controlling = true;
    else if (at === 0x8029) msg.controlling = false;
    else if (at === 0x0025) msg.useCandidate = true;
    else if (at === 0x0009 && al >= 4) msg.errorCode = (p[v + 2] & 0x7) * 100 + p[v + 3];
    o = v + ((al + 3) & ~3);
  }
  return msg;
}

// --------------------------------------------------------------------------- the capture's sidecars

/** sockets.csv: `utc,process,pid,address,port`, one row per Castcade UDP socket per second. */
export function parseSocketsCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const f = line.split(',');
    if (f.length < 5) continue;
    const ms = Date.parse(f[0]);
    const port = Number(f[4]);
    if (!Number.isFinite(ms) || !Number.isInteger(port)) continue;
    rows.push({ ms, process: f[1], pid: Number(f[2]), address: f[3], port });
  }
  return rows;
}

/**
 * Windows Firewall's log (`pfirewall.log`): the UDP packets it dropped on the way in. Its times are
 * local; `utcOffsetMinutes` (east of UTC) turns them into UTC.
 */
export function parseFirewallLog(text, utcOffsetMinutes = 0) {
  let fields = ['date', 'time', 'action', 'protocol', 'src-ip', 'dst-ip', 'src-port', 'dst-port'];
  const drops = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#Fields:')) {
      fields = line.slice(8).trim().split(/\s+/);
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    const get = (k) => f[fields.indexOf(k)];
    if (get('action') !== 'DROP' || get('protocol') !== 'UDP') continue;
    const path = get('path');
    if (path && path !== 'RECEIVE') continue;
    const local = Date.parse(`${get('date')}T${get('time')}Z`);
    if (!Number.isFinite(local)) continue;
    drops.push({
      ms: local - utcOffsetMinutes * 60_000,
      srcIp: get('src-ip'),
      dstIp: get('dst-ip'),
      sport: Number(get('src-port')),
      dport: Number(get('dst-port')),
    });
  }
  return drops;
}

// ---------------------------------------------------------------------------------------- analysis

class Aliases {
  constructor(localAddresses) {
    this.local = new Set(localAddresses.map(normalizeIp));
    this.names = new Map();
    this.counts = new Map();
  }

  /** The masked name of an address; `kind` picks the family of names ("peer", "STUN server", ...). */
  name(ip, kind) {
    const key = normalizeIp(ip);
    if (this.local.has(key)) return 'this PC';
    let n = this.names.get(key);
    if (!n) {
      const cls = addressClass(key);
      const k = kind ?? (cls === 'public' ? 'peer' : `${cls} address`);
      const i = (this.counts.get(k) ?? 0) + 1;
      this.counts.set(k, i);
      n = k === 'peer' ? `peer ${String.fromCharCode(64 + Math.min(i, 26))}${i > 26 ? i : ''}` : `${k} ${i}`;
      this.names.set(key, n);
    }
    return n;
  }
}

function utc(ms) {
  return `${new Date(ms).toISOString().slice(11, 23)}Z`;
}

function bump(map, key, ms) {
  const e = map.get(key) ?? { count: 0, first: ms, last: ms };
  e.count++;
  e.first = Math.min(e.first, ms);
  e.last = Math.max(e.last, ms);
  map.set(key, e);
  return e;
}

/**
 * What the capture shows. `meta.localAddresses` decides which side of each packet is this PC; without
 * it a private source talking to a public destination is taken as outgoing.
 */
export function analyze({ packets, sockets = [], drops = [], meta = {}, all = false }) {
  const aliases = new Aliases(meta.localAddresses ?? []);
  const isLocal = (ip) => aliases.local.has(normalizeIp(ip));
  const procOf = (port, ms) => {
    let best = null;
    for (const r of sockets) {
      if (r.port !== port) continue;
      const d = Math.abs(r.ms - ms);
      if (d <= 10_000 && (!best || d < best.d)) best = { d, name: r.process };
    }
    return best?.name ?? null;
  };
  const watched = (proc) => all || (proc !== null && /castcade/i.test(proc));

  const stats = { udp: 0, stun: 0, unreadable: 0, duplicates: 0, other: 0, firstMs: Infinity, lastMs: -Infinity };
  const flows = new Map(); // `${proc}|${localPort}|${remote}` -> { out, in }
  const sessions = new Map(); // local ufrag -> session
  const txOut = new Map(); // txid of a request this PC sent -> { session, remote, ms, server }
  const txIn = new Map(); // txid of a request this PC received -> session
  const mappedBySocket = new Map(); // `${proc}|${port}` -> Set of 'alias:port'
  const seen = new Map(); // de-duplication of the same packet seen at two capture points
  const serverIps = new Set();

  const session = (ufrag, proc) => {
    let s = sessions.get(ufrag);
    if (!s) {
      s = {
        ufrag,
        proc,
        peerUfrags: new Set(),
        localPorts: new Set(),
        sent: new Map(),
        received: new Map(),
        answersIn: new Map(),
        answersOut: new Map(),
        errorsIn: 0,
        role: null,
        nominated: 0,
        sentToPorts: new Map(),
        fromPorts: new Map(),
      };
      sessions.set(ufrag, s);
    }
    return s;
  };

  // First pass: which remotes are STUN servers (a request with no USERNAME sent to them).
  const parsed = [];
  for (const pk of packets) {
    const u = parseUdp(pk.data, pk.linkType);
    if (!u) {
      stats.unreadable++;
      continue;
    }
    let dir = isLocal(u.src) ? 'out' : isLocal(u.dst) ? 'in' : null;
    if (!dir && !meta.localAddresses) {
      const s = addressClass(u.src);
      const d = addressClass(u.dst);
      dir = s !== 'public' && d === 'public' ? 'out' : d !== 'public' && s === 'public' ? 'in' : null;
    }
    if (!dir) {
      stats.other++;
      continue;
    }
    const stun = parseStun(u.payload, u.length);
    const dupKey = stun ? `${dir}|${stun.cls}|${stun.txid}` : `${dir}|${u.sport}|${u.dport}|${u.payload.toString('hex', 0, 48)}`;
    const prev = seen.get(dupKey);
    if (prev !== undefined && Math.abs(prev - pk.ms) < (stun ? 20 : 2)) {
      stats.duplicates++;
      continue;
    }
    seen.set(dupKey, pk.ms);
    const remoteIp = dir === 'out' ? u.dst : u.src;
    const remotePort = dir === 'out' ? u.dport : u.sport;
    if (stun && dir === 'out' && stun.cls === 0 && stun.method === 1 && !stun.username && STUN_SERVER_PORTS.has(remotePort)) {
      serverIps.add(normalizeIp(remoteIp));
    }
    parsed.push({ ms: pk.ms, dir, u, stun, remoteIp, remotePort, localPort: dir === 'out' ? u.sport : u.dport });
  }
  for (const ip of serverIps) aliases.name(ip, 'STUN server');

  for (const p of parsed) {
    const owner = procOf(p.localPort, p.ms);
    stats.udp++;
    stats.firstMs = Math.min(stats.firstMs, p.ms);
    stats.lastMs = Math.max(stats.lastMs, p.ms);
    if (!watched(owner)) continue;
    const proc = owner ?? 'unknown process';
    const remote = `${aliases.name(p.remoteIp)}:${p.remotePort}`;
    const fk = `${proc}|${p.localPort}|${remote}`;
    const flow = flows.get(fk) ?? { proc, localPort: p.localPort, remote, out: 0, in: 0, stunOut: 0, stunIn: 0 };
    flow[p.dir]++;
    flows.set(fk, flow);
    const m = p.stun;
    if (!m) continue;
    stats.stun++;
    flow[p.dir === 'out' ? 'stunOut' : 'stunIn']++;
    if (m.method !== 1) continue;
    const toServer = serverIps.has(normalizeIp(p.remoteIp));
    if (m.cls === 0 && p.dir === 'out') {
      if (!m.username) {
        txOut.set(m.txid, { session: null, remote, ms: p.ms, server: true });
        continue;
      }
      // An outgoing check's USERNAME is "<peer's ufrag>:<this PC's ufrag>".
      const [theirs, ours] = m.username.split(':');
      const s = session(ours ?? m.username, proc);
      if (theirs) s.peerUfrags.add(theirs);
      s.localPorts.add(p.localPort);
      bump(s.sent, aliases.name(p.remoteIp), p.ms);
      bump(s.sentToPorts, remote, p.ms);
      if (m.controlling !== null) s.role = m.controlling ? 'controlling' : 'controlled';
      if (m.useCandidate) s.nominated++;
      txOut.set(m.txid, { session: s, remote, ms: p.ms, server: false });
    } else if (m.cls === 0 && p.dir === 'in') {
      if (!m.username) continue;
      // An incoming check's USERNAME is "<this PC's ufrag>:<peer's ufrag>".
      const [ours, theirs] = m.username.split(':');
      const s = session(ours ?? m.username, proc);
      if (theirs) s.peerUfrags.add(theirs);
      s.localPorts.add(p.localPort);
      bump(s.received, aliases.name(p.remoteIp), p.ms);
      bump(s.fromPorts, remote, p.ms);
      txIn.set(m.txid, s);
    } else if ((m.cls === 2 || m.cls === 3) && p.dir === 'in') {
      const req = txOut.get(m.txid);
      if (req?.server || (!req && toServer)) {
        if (m.cls === 2 && m.mapped) {
          const key = `${proc}|${p.localPort}`;
          const set = mappedBySocket.get(key) ?? new Set();
          set.add(`${aliases.name(m.mapped.ip, 'public address of this PC')}:${m.mapped.port}`);
          mappedBySocket.set(key, set);
        }
      } else if (req?.session) {
        if (m.cls === 2) bump(req.session.answersIn, remote, p.ms);
        else req.session.errorsIn++;
      }
    } else if ((m.cls === 2 || m.cls === 3) && p.dir === 'out') {
      const s = txIn.get(m.txid);
      if (s) bump(s.answersOut, remote, p.ms);
    }
  }

  // Windows Firewall: drops addressed to a port one of the watched sockets used.
  const watchedPorts = new Map();
  for (const f of flows.values()) watchedPorts.set(f.localPort, f.proc);
  for (const r of sockets) if (watched(r.process)) watchedPorts.set(r.port, r.process);
  const firewall = [];
  for (const d of drops) {
    if (!watchedPorts.has(d.dport)) continue;
    if (meta.startMs && meta.endMs && (d.ms < meta.startMs - 5000 || d.ms > meta.endMs + 5000)) continue;
    firewall.push({ ...d, proc: watchedPorts.get(d.dport), from: `${aliases.name(d.srcIp)}:${d.sport}` });
  }

  return { stats, flows: [...flows.values()], sessions: [...sessions.values()], mappedBySocket, firewall };
}

// ------------------------------------------------------------------------------------------ report

function total(map) {
  let n = 0;
  for (const e of map.values()) n += e.count;
  return n;
}

function firstOf(map) {
  let t = Infinity;
  for (const e of map.values()) t = Math.min(t, e.first);
  return t;
}

function portsText(map) {
  return [...map.entries()].map(([k, e]) => `${k} (${e.count})`).join(', ');
}

/** One session's reading, in words. */
export function verdict(s, firewallHits) {
  const sent = total(s.sent);
  const received = total(s.received);
  const answeredIn = total(s.answersIn);
  const answeredOut = total(s.answersOut);
  const fw = firewallHits > 0 ? ` Windows Firewall dropped ${firewallHits} packet(s) addressed to this session's ports.` : '';
  if (answeredIn > 0 && answeredOut > 0) return 'Checks answered both ways: this session had a working path.';
  if (answeredIn > 0) return "This PC's checks were answered, so the path out worked; the peer's own checks were not seen or not answered here." + fw;
  if (received > 0 && answeredOut === 0) {
    return `The peer's checks reached this PC's network card (${received}) and Castcade never answered one: they were lost inside this PC (Windows or Chromium).` + fw;
  }
  if (received > 0) {
    return `The peer's checks arrived (${received}) and this PC answered ${answeredOut}, but none of this PC's own ${sent} checks was answered: they are lost on the way out of this network, or at the peer.` + fw;
  }
  if (sent > 0) {
    return `Nothing from the peer reached this PC's network card for this session, and none of this PC's ${sent} checks was answered: lost on the way (this router, the peer's router or between), or the peer never sent.` + fw;
  }
  return 'No checks in this session.' + fw;
}

export function report(result, meta = {}, companionLines = []) {
  const { stats, flows, sessions, mappedBySocket, firewall } = result;
  const out = [];
  const say = (s = '') => out.push(s);
  say(`Castcade ICE capture summary (analyzer ${ANALYZER_VERSION}${meta.version ? `, capture script ${meta.version}` : ''})`);
  if (Number.isFinite(stats.firstMs)) {
    say(`Packets: ${utc(stats.firstMs)} to ${utc(stats.lastMs)} (${Math.round((stats.lastMs - stats.firstMs) / 1000)} s), ${stats.udp} UDP datagrams through the router, ${stats.stun} STUN messages on Castcade's sockets.`);
  } else say('Packets: no UDP datagram in the capture.');
  if (meta.filter) say(`Capture filter: ${meta.filter}.`);
  if (stats.unreadable) say(`${stats.unreadable} captured frame(s) were not IPv4 / IPv6 UDP the analyzer can read.`);
  say('No address is printed: "this PC", "peer A", "STUN server 1" stand for them; ports are real.');
  say();

  const sockets = new Map();
  for (const f of flows) {
    const k = `${f.proc}|${f.localPort}`;
    const e = sockets.get(k) ?? { proc: f.proc, port: f.localPort, flows: [] };
    e.flows.push(f);
    sockets.set(k, e);
  }
  say(`Castcade's UDP sockets that crossed the router: ${sockets.size}`);
  for (const e of [...sockets.values()].sort((a, b) => a.proc.localeCompare(b.proc) || a.port - b.port)) {
    const mapped = mappedBySocket.get(`${e.proc}|${e.port}`);
    say(`  ${e.proc} udp/${e.port}${mapped ? `  (public port as the STUN server saw it: ${[...mapped].join(', ')})` : ''}`);
    for (const f of e.flows.sort((a, b) => b.out + b.in - (a.out + a.in))) {
      say(`    ${f.remote}: ${f.out} out, ${f.in} in${f.stunOut + f.stunIn ? ` (STUN ${f.stunOut} out, ${f.stunIn} in)` : ''}`);
    }
  }
  say();

  say(`ICE sessions: ${sessions.length} (one per connection attempt; an ICE restart is a new session)`);
  const ordered = [...sessions].sort((a, b) => Math.min(firstOf(a.sent), firstOf(a.received)) - Math.min(firstOf(b.sent), firstOf(b.received)));
  ordered.forEach((s, i) => {
    const ports = new Set(s.localPorts);
    const fwHits = firewall.filter((d) => ports.has(d.dport)).length;
    const first = Math.min(firstOf(s.sent), firstOf(s.received));
    say(`${i + 1}. ${s.proc}, this PC's ufrag "${s.ufrag}", the peer's "${[...s.peerUfrags].join('", "') || '?'}"${s.role ? `, this PC ${s.role}` : ''}; sockets ${[...ports].join(', ')}; from ${utc(first)}`);
    say(`   checks sent: ${total(s.sent)}${s.sent.size ? ` to ${portsText(s.sentToPorts)}` : ''}${s.sent.size ? `; first ${utc(firstOf(s.sent))}` : ''}`);
    say(`   answers to them: ${total(s.answersIn)}${s.answersIn.size ? ` from ${portsText(s.answersIn)}` : ''}${s.errorsIn ? `; ${s.errorsIn} error response(s)` : ''}`);
    say(`   checks received: ${total(s.received)}${s.received.size ? ` from ${portsText(s.fromPorts)}` : ''}${s.received.size ? `; first ${utc(firstOf(s.received))}` : ''}`);
    say(`   answers this PC sent: ${total(s.answersOut)}${s.nominated ? `; nominations sent: ${s.nominated}` : ''}`);
    // The race of WORK I11.12: the peer's checks come from a port this PC never sent to.
    const sentPorts = new Set(s.sentToPorts.keys());
    const strange = [...s.fromPorts.keys()].filter((k) => !sentPorts.has(k));
    if (strange.length && sentPorts.size) {
      say(`   the peer's checks came from ${strange.join(', ')}, a port this PC never sent to (it sent to ${[...sentPorts].join(', ')}): the peer's router gave that flow another public port`);
    }
    if (s.sent.size && s.received.size) {
      const d = Math.abs(firstOf(s.sent) - firstOf(s.received)).toFixed(0);
      say(
        firstOf(s.sent) <= firstOf(s.received)
          ? `   first check: this PC sent its first ${d} ms before the peer's first reached it`
          : `   first check: the peer's first reached this PC ${d} ms before this PC sent its own first`,
      );
    }
    say(`   reading: ${verdict(s, fwHits)}`);
  });
  if (!sessions.length) say('  none: no ICE connectivity check on Castcade\'s sockets crossed the router.');
  say();

  say(`Windows Firewall drops addressed to Castcade's ports: ${firewall.length}${meta.firewallLog === false ? ' (the firewall log could not be turned on: not known)' : ''}`);
  for (const d of firewall.slice(0, 20)) say(`  ${utc(d.ms)} ${d.proc} udp/${d.dport} from ${d.from}`);
  if (firewall.length > 20) say(`  ... and ${firewall.length - 20} more`);

  if (companionLines.length) {
    say();
    say(`companion.log in the same minutes (${companionLines.length} line(s)):`);
    for (const l of companionLines) say(`  ${l}`);
  }
  return out.join('\n') + '\n';
}

/** The connection lines of companion.log in the capture's window (they hold no address since 0.2.47). */
export function companionLinesIn(text, startMs, endMs) {
  const want = /ICE round|no path after|ice connected|feedback channel open|No path to|stream3d: peer .*connected/;
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const ms = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(ms) || ms < startMs - 5000 || ms > endMs + 5000) continue;
    if (want.test(line)) lines.push(line.length > 400 ? `${line.slice(0, 400)} ...` : line);
  }
  return lines.slice(-80);
}

// --------------------------------------------------------------------------------------------- CLI

export function runFolder(dir, { companionLog = null, all = false } = {}) {
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : null);
  const pcap = read('capture.pcapng');
  if (!pcap) throw new Error(`no capture.pcapng in ${dir}`);
  const meta = read('meta.json') ? JSON.parse(read('meta.json').toString('utf8').replace(/^\uFEFF/, '')) : {};
  if (meta.startUtc) meta.startMs = Date.parse(meta.startUtc);
  if (meta.endUtc) meta.endMs = Date.parse(meta.endUtc);
  const sockets = read('sockets.csv') ? parseSocketsCsv(read('sockets.csv').toString('utf8')) : [];
  const drops = read('firewall.log') ? parseFirewallLog(read('firewall.log').toString('utf8'), meta.utcOffsetMinutes ?? 0) : [];
  const { packets } = parsePcapng(pcap);
  const result = analyze({ packets, sockets, drops, meta, all });
  let lines = [];
  if (companionLog && existsSync(companionLog) && meta.startMs && meta.endMs) {
    lines = companionLinesIn(readFileSync(companionLog, 'utf8'), meta.startMs, meta.endMs);
  }
  const text = report(result, meta, lines);
  writeFileSync(join(dir, 'summary.txt'), text);
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--companion-log');
  const i = args.indexOf('--companion-log');
  const appData = process.env.APPDATA ? join(process.env.APPDATA, 'Castcade', 'logs', 'companion.log') : null;
  const companionLog = i >= 0 ? args[i + 1] : appData;
  if (!dir) {
    console.error('usage: node analyze.mjs <capture folder> [--companion-log <companion.log>] [--all]');
    process.exit(2);
  }
  try {
    process.stdout.write(runFolder(dir, { companionLog, all: args.includes('--all') }));
  } catch (e) {
    console.error(`analyze: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
