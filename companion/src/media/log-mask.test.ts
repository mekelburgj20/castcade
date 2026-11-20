/**
 * No network address reaches `companion.log` from the native video helper (`maskAddresses`): the shapes of the lines
 * it writes, with documentation addresses (RFC 5737, RFC 3849) in place of real ones.
 */
import { describe, expect, it } from 'vitest';
import { maskAddresses } from './log-mask.js';

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

  it('IPv6: compressed, full, link-local with a zone, in brackets with a port, mapped IPv4', () => {
    expect(maskAddresses('local 2001:db8::1 remote 2001:db8:0:0:0:0:0:2')).toBe('local <addr> remote <addr>');
    expect(maskAddresses('adapter Ethernet (v6 global 2001:db8:85a3::8a2e:370:7334, link fe80::1ff:fe23:4567:890a%12)')).toBe('adapter Ethernet (v6 global <addr>, link <addr>)');
    expect(maskAddresses('pair host [2001:db8::1]:50000 -> host [2001:db8::2]:50001')).toBe('pair host <addr> -> host <addr>');
    expect(maskAddresses('loopback ::1 and ::ffff:192.0.2.1')).toBe('loopback <addr> and <addr>');
  });

  it('what is not an address stays readable: versions, sizes, clock times, ids, names with a port', () => {
    for (const line of [
      'video: helper 0.3.2 ready (encoder h264_nvenc, decoder h264_cuvid)',
      'video: peer 56999e06-838a-4d68-ae8a-1a8385cfb4da: rung 3 (1016x1080 @60, 8000 kbps): start',
      'video: source: ring 1npn0k6gnaICvZqL 1440x1440 @30',
      'video: ice: 1 servers (stun:stun.l.google.com:19302 stun:stun1.l.google.com:19302)',
      'video: peer k: adapters: kept 0 Intel(R) Ethernet Controller (2) I225-V (v6 global), 1 Wi-Fi (v4 private)',
      'video: at 12:26:50 the build 10.8.0.2078 of VPX, ratio 16:9, 1.5.2.3456 and 300.1.2.3 are not addresses',
      'video: peer k: ice connected (srflx↔srflx)',
    ]) {
      expect(maskAddresses(line), line).toBe(line);
    }
  });
});
