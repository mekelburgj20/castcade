/**
 * No network address in `companion.log` (the log goes to ArcAid with a tester's report). The native video helper
 * writes the candidate pair it selected with both public addresses and ports (video-helper/src/peer.cpp: "pair srflx
 * 203.0.113.7:60892 -> srflx 198.51.100.23:55389"), and what libwebrtc says about the network adapters; every line
 * that comes from that process is passed through `maskAddresses` before it is logged. The words around an address
 * (the candidate types, the reason) stay as they are.
 *
 * What counts as an address: dotted IPv4, also with its last part already written as `x`, with or without `:port`;
 * IPv6 in brackets (with or without `:port` after them), or bare when it has `::` or at least five colons (a clock
 * time or a `host:port` name has fewer; a MAC address has five and goes too). Each becomes `<addr>`. An IPv4-looking
 * run of four numbers inside a longer dotted number (a build like 10.8.0.2078) is not one.
 */
// Not inside a longer dotted number (a digit and a dot before it, or a dot and a digit after it); a dot that ends a
// sentence after it is only a dot.
const IPV4 = /(?<!\w)(?<!\d\.)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d|x)(?::\d{1,5}(?!\d)|(?!\w)(?!\.\d))/g;
const BRACKETED = /\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?\](?::\d{1,5})?/g;
/** A run of hex digits, colons and dots (with an optional zone) that is not part of a longer word. */
const BARE = /(?<![\w:.])[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?(?![\w:])/g;

export function maskAddresses(line: string): string {
  return line
    .replace(BRACKETED, '<addr>')
    .replace(BARE, (m) => {
      const colons = m.split(':').length - 1;
      return m.includes('::') || colons >= 5 ? '<addr>' : m;
    })
    .replace(IPV4, '<addr>');
}
