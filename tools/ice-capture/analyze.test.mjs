import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STUN_MAGIC,
  addressClass,
  analyze,
  normalizeIp,
  parseFirewallLog,
  parsePcapng,
  parseSocketsCsv,
  parseStun,
  parseUdp,
  report,
  runFolder,
} from './analyze.mjs';

// ------------------------------------------------------------------ builders for a synthetic capture

function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function block(type, body) {
  const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
  const len = 12 + padded.length;
  const b = Buffer.alloc(len);
  b.writeUInt32LE(type, 0);
  b.writeUInt32LE(len, 4);
  padded.copy(b, 8);
  b.writeUInt32LE(len, len - 4);
  return b;
}

function shb() {
  const body = Buffer.alloc(16);
  body.writeUInt32LE(0x1a2b3c4d, 0);
  body.writeUInt16LE(1, 4);
  body.writeBigInt64LE(-1n, 8);
  return block(0x0a0d0d0a, body);
}

function idb(linkType = 1, tsresol = null) {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(linkType, 0);
  head.writeUInt32LE(0, 4);
  const opts =
    tsresol === null ? Buffer.alloc(0) : Buffer.concat([u16le(9), u16le(1), Buffer.from([tsresol, 0, 0, 0]), Buffer.alloc(4)]);
  return block(1, Buffer.concat([head, opts]));
}

function epb(ifId, ms, data, unitsPerSec = 1e6) {
  const units = BigInt(Math.round((ms * unitsPerSec) / 1000));
  const head = Buffer.alloc(20);
  head.writeUInt32LE(ifId, 0);
  head.writeUInt32LE(Number(units >> 32n), 4);
  head.writeUInt32LE(Number(units & 0xffffffffn), 8);
  head.writeUInt32LE(data.length, 12);
  head.writeUInt32LE(data.length, 16);
  return block(6, Buffer.concat([head, data]));
}

function ip4(s, b, o) {
  s.split('.').forEach((x, i) => (b[o + i] = Number(x)));
}

function frame(src, dst, sport, dport, payload, snap = Infinity) {
  const udp = Buffer.alloc(8);
  udp.writeUInt16BE(sport, 0);
  udp.writeUInt16BE(dport, 2);
  udp.writeUInt16BE(8 + payload.length, 4);
  const ip = Buffer.alloc(20);
  ip[0] = 0x45;
  ip.writeUInt16BE(28 + payload.length, 2);
  ip[8] = 64;
  ip[9] = 17;
  ip4(src, ip, 12);
  ip4(dst, ip, 16);
  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(0x0800, 12);
  const full = Buffer.concat([eth, ip, udp, payload]);
  return full.subarray(0, Math.min(full.length, snap));
}

function stun(type, txid, attrs = []) {
  const body = Buffer.concat(
    attrs.map(([t, v]) => {
      const h = Buffer.alloc(4);
      h.writeUInt16BE(t, 0);
      h.writeUInt16BE(v.length, 2);
      return Buffer.concat([h, v, Buffer.alloc((4 - (v.length % 4)) % 4)]);
    }),
  );
  const hdr = Buffer.alloc(20);
  hdr.writeUInt16BE(type, 0);
  hdr.writeUInt16BE(body.length, 2);
  hdr.writeUInt32BE(STUN_MAGIC, 4);
  Buffer.from(txid.padStart(24, '0'), 'hex').copy(hdr, 8);
  return Buffer.concat([hdr, body]);
}

const username = (s) => [0x0006, Buffer.from(s)];
const controlling = [0x802a, Buffer.alloc(8)];
function xorMapped(ip, port) {
  const v = Buffer.alloc(8);
  v[1] = 1;
  v.writeUInt16BE(port ^ 0x2112, 2);
  const n = ip.split('.').reduce((a, x) => a * 256 + Number(x), 0);
  v.writeUInt32BE((n ^ STUN_MAGIC) >>> 0, 4);
  return [0x0020, v];
}

const T0 = Date.parse('2026-11-25T00:19:20.000Z');
const ME = '192.168.1.10';
const MY_PUBLIC = '203.0.113.7';
const PEER = '198.51.100.20';
const GOOGLE = '74.125.250.129';
const meta = { localAddresses: [ME, 'fe80::1'], startMs: T0 - 1000, endMs: T0 + 60_000 };
const sockets = [50000, 50002, 50004, 50006].map((port) => ({ ms: T0, process: 'Castcade', pid: 7, address: '0.0.0.0', port }));

function capture(frames, { tsresol = null, unitsPerSec = 1e6 } = {}) {
  return Buffer.concat([shb(), idb(1, tsresol), idb(1, tsresol), ...frames.map(([ifId, ms, f]) => epb(ifId, ms, f, unitsPerSec))]);
}

function textOf(frames, extra = {}) {
  const { packets } = parsePcapng(capture(frames));
  return report(analyze({ packets, sockets, meta, ...extra }), meta);
}

// ------------------------------------------------------------------------------------------- tests

describe('ice-capture analyzer (I11.12.1)', () => {
  it('reads pcapng timestamps in the interface resolution (100 ns as pktmon may write)', () => {
    const f = frame(ME, PEER, 50000, 62000, stun(0x0001, 'a1', [username('p:m')]));
    const { packets } = parsePcapng(capture([[0, T0 + 1.5, f]], { tsresol: 7, unitsPerSec: 1e7 }));
    expect(packets).toHaveLength(1);
    expect(Math.abs(packets[0].ms - (T0 + 1.5))).toBeLessThan(0.01);
    const u = parseUdp(packets[0].data, packets[0].linkType);
    expect(u).toMatchObject({ src: ME, dst: PEER, sport: 50000, dport: 62000 });
  });

  it('parses STUN: class, method, USERNAME, XOR-MAPPED-ADDRESS; a message cut by the snap length keeps what fits', () => {
    const req = stun(0x0001, 'b2', [username('peerU:myU'), controlling]);
    const m = parseStun(req);
    expect(m).toMatchObject({ method: 1, cls: 0, username: 'peerU:myU', controlling: true });
    const res = parseStun(stun(0x0101, 'b2', [xorMapped(MY_PUBLIC, 61000)]));
    expect(res).toMatchObject({ cls: 2, mapped: { ip: MY_PUBLIC, port: 61000 } });
    expect(parseStun(stun(0x0111, 'b3', []))?.cls).toBe(3);
    // 20 + 4 + 9 bytes survive a cut at 33: the USERNAME is still read, the rest is not.
    expect(parseStun(req.subarray(0, 33), req.length)?.username).toBe('peerU:myU');
    expect(parseStun(Buffer.from('not stun at all, an RTP packet'))).toBeNull();
  });

  it('a round like ChuckRibbits\' (2026-11-24): checks out, nothing in, says so and prints no address', () => {
    const text = textOf([
      [0, T0, frame(ME, GOOGLE, 50000, 19302, stun(0x0001, 'c0'))],
      [0, T0 + 30, frame(GOOGLE, ME, 19302, 50000, stun(0x0101, 'c0', [xorMapped(MY_PUBLIC, 61000)]))],
      ...[1, 2, 3].map((i) => [0, T0 + 100 * i, frame(ME, PEER, 50000, 62000, stun(0x0001, `c${i}`, [username('peerU:myU'), controlling]))]),
    ]);
    expect(text).toContain('this PC\'s ufrag "myU", the peer\'s "peerU", this PC controlling');
    expect(text).toContain('checks sent: 3 to peer A:62000 (3)');
    expect(text).toContain('checks received: 0');
    expect(text).toContain("Nothing from the peer reached this PC's network card");
    expect(text).toContain('public port as the STUN server saw it: public address of this PC 1:61000');
    expect(text).toContain('STUN server 1:19302');
    for (const ip of [ME, MY_PUBLIC, PEER, GOOGLE]) expect(text).not.toContain(ip);
  });

  it('the peer\'s checks from a port this PC never sent to, unanswered, with a firewall drop: all three said', () => {
    const drops = parseFirewallLog(
      ['#Version: 1.5', '#Fields: date time action protocol src-ip dst-ip src-port dst-port size tcpflags tcpsyn tcpack tcpwin icmptype icmpcode info path pid', `2026-11-24 16:19:21 DROP UDP ${PEER} ${ME} 62001 50002 120 - - - - - - - RECEIVE 0`].join('\r\n'),
      -480,
    );
    expect(drops).toHaveLength(1);
    expect(drops[0].ms).toBe(Date.parse('2026-11-25T00:19:21Z'));
    const text = textOf(
      [
        [0, T0 + 10, frame(ME, PEER, 50002, 62000, stun(0x0001, 'd1', [username('peerU2:myU2')]))],
        [0, T0 + 20, frame(PEER, ME, 62001, 50002, stun(0x0001, 'd2', [username('myU2:peerU2')]))],
      ],
      { drops },
    );
    expect(text).toContain('checks received: 1 from peer A:62001 (1)');
    expect(text).toContain('a port this PC never sent to (it sent to peer A:62000)');
    expect(text).toContain('Castcade never answered one');
    expect(text).toContain('Windows Firewall dropped 1 packet(s)');
    expect(text).toContain("Windows Firewall drops addressed to Castcade's ports: 1");
    expect(text).not.toContain(PEER);
  });

  it('a session answered both ways reads as a working path; the same packet seen at two capture points counts once', () => {
    const inReq = frame(PEER, ME, 62000, 50004, stun(0x0001, 'e1', [username('myU3:peerU3')]));
    const text = textOf([
      [0, T0, frame(ME, PEER, 50004, 62000, stun(0x0001, 'e0', [username('peerU3:myU3')]))],
      [0, T0 + 5, inReq],
      [1, T0 + 5.4, inReq],
      [0, T0 + 6, frame(ME, PEER, 50004, 62000, stun(0x0101, 'e1', [xorMapped(PEER, 62000)]))],
      [0, T0 + 90, frame(PEER, ME, 62000, 50004, stun(0x0101, 'e0', [xorMapped(MY_PUBLIC, 61004)]))],
    ]);
    expect(text).toContain('checks received: 1 from');
    expect(text).toContain('Checks answered both ways');
    expect(text).toContain('first check: this PC sent its first 5 ms before');
  });

  it('only Castcade\'s sockets are reported unless --all', () => {
    const f = frame(ME, PEER, 40000, 3478, stun(0x0001, 'f1', [username('a:b')]));
    expect(textOf([[0, T0, f]])).toContain('ICE sessions: 0');
    const { packets } = parsePcapng(capture([[0, T0, f]]));
    expect(report(analyze({ packets, sockets, meta, all: true }), meta)).toContain('unknown process');
  });

  it('addresses: IPv6 forms compare equal, classes are what a masked name still tells', () => {
    expect(normalizeIp('fe80::1%12')).toBe('fe80:0:0:0:0:0:0:1');
    expect(normalizeIp('::1')).toBe('0:0:0:0:0:0:0:1');
    expect(addressClass('10.0.0.1')).toBe('private');
    expect(addressClass('100.64.1.1')).toBe('carrier NAT');
    expect(addressClass('172.24.0.5')).toBe('private');
    expect(addressClass('2001:db8::5')).toBe('public');
    expect(addressClass('fe80::5')).toBe('link-local');
  });

  it('reads a capture folder end to end and writes summary.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ice-capture-'));
    try {
      writeFileSync(join(dir, 'capture.pcapng'), capture([[0, T0, frame(ME, PEER, 50006, 62000, stun(0x0001, 'g1', [username('pU:mU')]))]]));
      writeFileSync(join(dir, 'sockets.csv'), `utc,process,pid,address,port\r\n${new Date(T0).toISOString()},Castcade,7,0.0.0.0,50006\r\n`);
      writeFileSync(join(dir, 'meta.json'), `\uFEFF${JSON.stringify({ version: 1, startUtc: new Date(T0 - 1000).toISOString(), endUtc: new Date(T0 + 5000).toISOString(), utcOffsetMinutes: -480, localAddresses: [ME], filter: 'UDP to and from the router', firewallLog: true })}`);
      writeFileSync(join(dir, 'firewall.log'), '#Fields: date time action protocol src-ip dst-ip src-port dst-port\r\n');
      const log = join(dir, 'companion.log');
      writeFileSync(log, `${new Date(T0 + 1000).toISOString()} info  stream3d: peer x: ICE round 1: restart 1 of 3 ...\n${new Date(T0 + 1000).toISOString()} info  witness: unrelated\n`);
      const text = runFolder(dir, { companionLog: log });
      expect(readFileSync(join(dir, 'summary.txt'), 'utf8')).toBe(text);
      expect(text).toContain('capture script 1');
      expect(text).toContain('Capture filter: UDP to and from the router.');
      expect(text).toContain('companion.log in the same minutes (1 line(s))');
      expect(text).toContain('ICE round 1');
      expect(parseSocketsCsv(readFileSync(join(dir, 'sockets.csv'), 'utf8'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
