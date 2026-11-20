/**
 * No network address in `companion.log` (the log goes to ArcAid with a tester's report). The native video helper
 * writes the candidate pair it selected with both public addresses and ports (video-helper/src/peer.cpp: "pair srflx
 * 203.0.113.7:60892 -> srflx 198.51.100.23:55389"), a candidate error with the local address, and every warning of
 * libwebrtc as it comes (`webrtc: ...`: networks, candidates, connections, in libwebrtc's own formats). Every line
 * that comes from that process is passed through `maskAddresses` before it is logged. The words around an address
 * (the candidate types, the reason) stay as they are.
 *
 * What counts as an address, and becomes `<addr>`; where a doubt is left, the line is masked:
 * - IPv4: four numbers of 0 to 255 with dots (leading zeros too: `203.000.113.007`), or three and an `x` (libwebrtc's
 *   "sensitive" form), with a `:port` when one follows. Also when it is glued to a word (`addr203.0.113.7`,
 *   `203.0.113.7typ`). Not four numbers inside a longer dotted number (`10.8.0.2078.castcade`, `32.0.15.6094`): a
 *   digit, or a digit and a dot, on either side.
 * - IPv6 with `::` and at least one group of up to four hex digits (`2001:db8::1`, `::1`, `fe80::1ff:fe23:4567:890a`),
 *   also right after a colon or glued to a word behind it (`host:2001:db8::1`, `Net[Ethernet:2001:db8:85a3::/64`,
 *   `2001:db8::1typ`); and five or more such groups joined by colons, `x` groups included (the full form, the
 *   "sensitive" form `2001:db8:85a3:x:x:x:x:x`, a MAC address). A zone (`%12`), the brackets around it and a `:port`
 *   after it go with it. A clock time (`12:34:56.789`), a ratio (`16:9`) and a C++ name (`std::string`,
 *   `webrtc::Foo`) are none of these.
 * - In a candidate line (one with `typ host|srflx|prflx|relay`): the port that follows the address after a space, and
 *   the value of `rport`, become `<port>`.
 *
 * Given up for that (they read `<addr>` now): a four-part dotted number with every part 255 or less (a version like
 * `1.2.3.4`); a C++ scope whose name before `::` is hex letters only (`abc::de`; `cc::Layer` reads `<addr>Layer`);
 * five or more short hex or decimal fields joined by colons (the tail of libwebrtc's `Cand[...]`).
 */
const OCTET = '(?:25[0-5]|2[0-4]\\d|[01]?\\d?\\d)';
const IPV4 = new RegExp(`(?<!\\d)(?<!\\d\\.)(?:${OCTET}\\.){3}(?:${OCTET}(?!\\d)(?!\\.\\d)|x)(?::\\d{1,5}(?!\\d))?`, 'g');
const H = '[0-9A-Fa-f]{1,4}';
/** `::` with groups before it (not begun inside a word) or none (then not right behind a word or a colon), and groups after it or none. */
const V6_COMPRESSED = new RegExp(`(?:(?<![0-9A-Za-z])${H}(?::${H}){0,6}|(?<![0-9A-Za-z:]))::(?:${H}(?::${H}){0,6}(?![0-9A-Fa-f]))?`, 'g');
const G = `(?:${H}|x)`;
/** Five to eight groups joined by single colons: the full form, one cut short, the form with `x` groups, a MAC address. */
const V6_FULL = new RegExp(`(?<![0-9A-Za-z])${G}(?::${G}){4,7}(?![0-9A-Fa-f])`, 'g');
const CANDIDATE_LINE = /\btyp (?:host|srflx|prflx|relay)\b/;

export function maskAddresses(line: string): string {
  let s = line
    .replace(IPV4, '<addr>')
    // `::` alone, with no group on either side, is not an address (and is what a C++ name has).
    .replace(V6_COMPRESSED, (m) => (/[0-9A-Fa-f]/.test(m) ? '<addr>' : m))
    .replace(V6_FULL, '<addr>')
    // What belongs to one address is one `<addr>`: an IPv4 tail (`::ffff:192.0.2.1`), a zone, brackets, a port.
    .replace(/<addr>(?:[:.]?<addr>)+/g, '<addr>')
    .replace(/<addr>%[\w.-]+/g, '<addr>')
    .replace(/\[<addr>\]/g, '<addr>')
    .replace(/<addr>:\d{1,5}(?!\d)/g, '<addr>');
  if (CANDIDATE_LINE.test(s)) s = s.replace(/<addr> \d{1,5}(?= typ )/g, '<addr> <port>').replace(/\brport \d{1,5}(?!\d)/g, 'rport <port>');
  return s;
}
