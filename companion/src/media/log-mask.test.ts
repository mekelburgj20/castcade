/**
 * No network address reaches `companion.log` from the native video helper (`maskAddresses`): the shapes of the lines
 * it writes and of the libwebrtc warnings it forwards, with documentation addresses (RFC 5737, RFC 3849) in place of
 * real ones.
 */
import { describe, expect, it } from 'vitest';
import { maskAddresses } from './log-mask.js';

/** Nothing of a documentation address may be left in a masked line. */
const LEFT = /203\.0|203\.000|198\.51|192\.0\.2|113\.7|113\.007|2001|db8|85a3|8a2e|fe80|60892|55389/;
const masked = (line: string): string => {
  const out = maskAddresses(line);
  expect(out, line).not.toMatch(LEFT);
  return out;
};

describe('maskAddresses', () => {
  it('the selected pair, as the helper writes it: both addresses and ports go, the candidate types and the reason stay', () => {
    expect(maskAddresses('video: peer 56999e06-838a-4d68-ae8a-1a8385cfb4da: pair srflx 203.0.113.7:60892 -> srflx 198.51.100.23:55389 (candidate pair state changed)')).toBe(
      'video: peer 56999e06-838a-4d68-ae8a-1a8385cfb4da: pair srflx <addr> -> srflx <addr> (candidate pair state changed)',
    );
    expect(maskAddresses('video: peer k: pair host 192.0.2.10:50000 -> prflx [2001:db8::1]:61000 (selected)')).toBe('video: peer k: pair host <addr> -> prflx <addr> (selected)');
  });

  it("a candidate error, as the helper writes it: the local address and port go, the STUN server's name stays", () => {
    expect(maskAddresses('video: peer k: ICE candidate error 701 from stun:stun.l.google.com:19302 (192.0.2.10:50000): STUN binding request timed out.')).toBe(
      'video: peer k: ICE candidate error 701 from stun:stun.l.google.com:19302 (<addr>): STUN binding request timed out.',
    );
    expect(maskAddresses('video: peer k: ICE candidate error 701 from stun:stun.l.google.com:19302 ([2001:db8::7]:50000): timed out')).toBe('video: peer k: ICE candidate error 701 from stun:stun.l.google.com:19302 (<addr>): timed out');
  });

  it('IPv4: with and without a port, already half hidden, at the ends of a line, several in one', () => {
    expect(maskAddresses('203.0.113.7')).toBe('<addr>');
    expect(maskAddresses('from 203.0.113.7 to 198.51.100.23:3478.')).toBe('from <addr> to <addr>.');
    expect(maskAddresses('The peer is at 203.0.113.7. Next line.')).toBe('The peer is at <addr>. Next line.');
    // libwebrtc's own "sensitive" form still names the network.
    expect(maskAddresses('candidate 203.0.113.x:60892 gathered')).toBe('candidate <addr> gathered');
    expect(maskAddresses('adapters: kept 2 Ethernet (192.0.2.44, 10.0.0.5), dropped 1 vEthernet (172.16.4.1)')).toBe('adapters: kept 2 Ethernet (<addr>, <addr>), dropped 1 vEthernet (<addr>)');
    expect(maskAddresses('stun:203.0.113.9:19302 answered')).toBe('stun:<addr> answered');
  });

  it('IPv4 glued to a word on either side, and written with leading zeros', () => {
    expect(masked('webrtc: ip_203.0.113.7 seen')).toBe('webrtc: ip_<addr> seen');
    expect(masked('webrtc: addr203.0.113.7 seen')).toBe('webrtc: addr<addr> seen');
    expect(masked('webrtc: 203.0.113.7typ host')).toBe('webrtc: <addr>typ host');
    expect(masked('webrtc: from 203.000.113.007 (padded)')).toBe('webrtc: from <addr> (padded)');
    expect(masked('webrtc: addr203.0.113.7:60892typ')).toBe('webrtc: addr<addr>typ');
  });

  it('IPv6: compressed, full, link-local with a zone, in brackets with a port, mapped IPv4', () => {
    expect(maskAddresses('local 2001:db8::1 remote 2001:db8:0:0:0:0:0:2')).toBe('local <addr> remote <addr>');
    expect(maskAddresses('adapter Ethernet (v6 global 2001:db8:85a3::8a2e:370:7334, link fe80::1ff:fe23:4567:890a%12)')).toBe('adapter Ethernet (v6 global <addr>, link <addr>)');
    expect(maskAddresses('pair host [2001:db8::1]:50000 -> host [2001:db8::2]:50001')).toBe('pair host <addr> -> host <addr>');
    expect(maskAddresses('loopback ::1 and ::ffff:192.0.2.1')).toBe('loopback <addr> and <addr>');
    expect(masked('NAT64 64:ff9b::192.0.2.33 and [::ffff:192.0.2.1]:5000 and 0:0:0:0:0:ffff:192.0.2.1.')).toBe('NAT64 <addr> and <addr> and <addr>.');
    // One that a line cut short: five groups are enough to be taken for an address.
    expect(masked('cut at 2001:db8:85a3:0:0')).toBe('cut at <addr>');
  });

  it("IPv6 in libwebrtc's release-build \"sensitive\" form, with x groups: bare, in brackets with a port, with a port behind it", () => {
    expect(masked('webrtc: Conn from 2001:db8:85a3:x:x:x:x:x to peer')).toBe('webrtc: Conn from <addr> to peer');
    expect(masked('webrtc: Conn from [2001:db8:85a3:x:x:x:x:x]:60892 to peer')).toBe('webrtc: Conn from <addr> to peer');
    expect(masked('webrtc: Conn from 2001:db8:85a3:x:x:x:x:x:60892 to peer')).toBe('webrtc: Conn from <addr> to peer');
    expect(masked('webrtc: 2001:db8:85a3:x:x:x:x:x:60892->203.0.113.x:55389')).toBe('webrtc: <addr>-><addr>');
  });

  it('IPv6 right after a colon, as libwebrtc prints a network, a candidate and a connection', () => {
    expect(masked('webrtc: Net[Ethernet:2001:db8:85a3::/64:Ethernet:id=1]')).toBe('webrtc: Net[Ethernet:<addr>/64:Ethernet:id=1]');
    // The address and its port are one `<addr>`; the six short fields at the end go too (the safe side, below).
    expect(masked('webrtc: Cand[:842163049:1:udp:2122260223:2001:db8:85a3::8a2e:60892:local::0:0:abcd:1:10:0]')).toBe('webrtc: Cand[:842163049:1:udp:2122260223:<addr>:local::<addr>]');
    expect(masked('webrtc: Cand[:842163049:1:udp:2122260223:2001:db8:85a3::8a2e:60892:local:0:0]')).toBe('webrtc: Cand[:842163049:1:udp:2122260223:<addr>:local:0:0]');
    expect(masked('webrtc: host:2001:db8::1 is up')).toBe('webrtc: host:<addr> is up');
    expect(masked('webrtc: ip6:2001:db8::1 is up')).toBe('webrtc: ip6:<addr> is up');
    expect(masked('webrtc: Net[Wi-Fi:203.0.113.x/24:Wifi:id=2]')).toBe('webrtc: Net[Wi-Fi:<addr>/24:Wifi:id=2]');
  });

  it('IPv6 glued to a word behind it', () => {
    expect(masked('webrtc: 2001:db8::1typ host')).toBe('webrtc: <addr>typ host');
    expect(masked('webrtc: 2001:db8:85a3::8a2e:370:7334generation')).toBe('webrtc: <addr>generation');
  });

  it('a candidate line: the port after the address, and the value of rport, go too', () => {
    expect(masked('webrtc: candidate:842163049 1 udp 1677729535 203.0.113.7 60892 typ srflx raddr 192.0.2.10 rport 60892 generation 0')).toBe(
      'webrtc: candidate:842163049 1 udp 1677729535 <addr> <port> typ srflx raddr <addr> rport <port> generation 0',
    );
    expect(masked('webrtc: candidate:1 1 udp 2122260223 2001:db8:85a3::8a2e 60892 typ host generation 0')).toBe('webrtc: candidate:1 1 udp 2122260223 <addr> <port> typ host generation 0');
    // Only there: a number after an address in another line is something else.
    expect(maskAddresses('webrtc: sent to 203.0.113.7 1200 bytes, rport 5 of something')).toBe('webrtc: sent to <addr> 1200 bytes, rport 5 of something');
  });

  it('what is not an address stays readable: clock times, versions, ratios, ids, C++ names, names with a port', () => {
    for (const line of [
      'video: helper 0.3.2 ready (encoder h264_nvenc, decoder h264_cuvid)',
      'video: peer 56999e06-838a-4d68-ae8a-1a8385cfb4da: rung 3 (1016x1080 @60, 8000 kbps): start',
      'video: source: ring 1npn0k6gnaICvZqL 1440x1440 @30',
      'video: ice: 1 servers (stun:stun.l.google.com:19302 stun:stun1.l.google.com:19302)',
      'video: peer k: adapters: kept 0 Intel(R) Ethernet Controller (2) I225-V (v6 global), 1 Wi-Fi (v4 private)',
      'video: at 12:26:50 the build 10.8.0.2078 of VPX, ratio 16:9, 1.5.2.3456 and 300.1.2.3 are not addresses',
      'video: peer k: ice connected (srflx↔srflx)',
      'webrtc: at 12:34:56 and 12:34:56.789, since 2026-11-19T06:35:55.613Z',
      'webrtc: VPX 10.8.0.9999, build 10.8.0.2078.castcade, helper 0.3.2, driver 32.0.15.6094, castcade-9e78aef',
      'webrtc: (peer_connection.cc:1234): std::string webrtc::Foo::Bar() failed for 0x7ffdeadbeef0 id 9f3a61c2d4e5b701',
      'webrtc: ratio 16:9, 4:3; step 1:2:3; foo::bar is not here: x::y',
    ]) {
      expect(maskAddresses(line), line).toBe(line);
    }
  });

  it('given up for the safe side: a four-part number of small parts, a name of hex letters before ::, five or more short fields joined by colons', () => {
    expect(maskAddresses('version 1.2.3.4 of something')).toBe('version <addr> of something');
    expect(maskAddresses('in abc::de, a::b and cc::Layer')).toBe('in <addr>, <addr> and <addr>Layer');
    expect(maskAddresses('fields 0:0:abcd:1:10:0 and aa:bb:cc:dd:ee:ff and 1:2:3:4:5')).toBe('fields <addr> and <addr> and <addr>');
    // Four fields are not enough (a time with frames, a short list).
    expect(maskAddresses('fields 1:2:3:4 and c0:ff:ee')).toBe('fields 1:2:3:4 and c0:ff:ee');
  });
});
