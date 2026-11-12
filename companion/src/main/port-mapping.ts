/**
 * D10.8 (2026-11-12): the fallback for a host that cannot use the ArcAid relay: ask the router to forward the match
 * port to this PC (UPnP IGD: SSDP discovery, the device description, then the WANIPConnection / WANPPPConnection SOAP
 * actions AddPortMapping, GetExternalIPAddress and DeletePortMapping). Written here with `node:dgram` and `fetch`
 * rather than a library: the maintained ones on npm (@achingbrain/nat-port-mapper, @silentbot1/nat-api) pull in an
 * XML parser, a default-gateway prober and more for three requests. NAT-PMP / PCP is not done: it needs the default
 * gateway's address, which Node does not give without one of those dependencies.
 *
 * The whole attempt has one deadline (3 s by default) and never throws: the caller hosts first and shows the result
 * when it comes. The mapping is leased (1 h, renewed by the caller while the match is hosted), so a crash does not
 * leave the port open for ever; a router that only takes permanent mappings (error 725) gets one, removed on leave.
 *
 * Only a gateway on this network is talked to: the description must come from the address that answered the search,
 * and the control URL must be on the same host.
 */
import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

export interface PortMapping {
  externalPort: number;
  /** What the router says its own WAN address is; null when it did not say. */
  externalIp: string | null;
  /** Seconds; 0 = the router only takes permanent mappings. */
  leaseSeconds: number;
  /** The router's control host, for the log (a LAN address). */
  gateway: string;
  /** Ask for the same mapping again (a lease renewal). Never throws; false when the router refused. */
  renew(): Promise<boolean>;
  /** Never throws; false when the router did not confirm. */
  remove(): Promise<boolean>;
}

export type PortMapResult = { ok: true; mapping: PortMapping } | { ok: false; reason: string };

export interface OpenPortOptions {
  /** The TCP port, the same outside and inside. */
  port: number;
  description?: string;
  leaseSeconds?: number;
  /** The whole attempt: discovery, description and the mapping. Default 3000. */
  timeoutMs?: number;
  /** Test seam: where the search goes. Default the SSDP multicast group, 239.255.255.250:1900. */
  ssdp?: { address: string; port: number };
  /** Test seam: the local addresses to search from. Default: every non-internal IPv4 of this PC. */
  localAddresses?: string[];
}

export const DEFAULT_LEASE_SECONDS = 3600;
const SSDP = { address: '239.255.255.250', port: 1900 } as const;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
/** Best first. */
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

interface Gateway {
  controlUrl: string;
  serviceType: string;
  /** This PC's address on the gateway's network: NewInternalClient. */
  localAddress: string;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(i.address);
  }
  return out;
}

/** The LOCATION header of an SSDP answer, or null. */
export function ssdpLocation(text: string): string | null {
  if (!/^HTTP\/1\.[01] 200/i.test(text)) return null;
  const m = /^location:\s*(\S+)\s*$/im.exec(text);
  return m ? (m[1] as string) : null;
}

/** The control URL and service type of the best WAN connection service in a device description, or null. */
export function parseDescription(xml: string, location: string): { controlUrl: string; serviceType: string } | null {
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => m[1] as string);
  const field = (block: string, tag: string): string | null => new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, 'i').exec(block)?.[1] ?? null;
  const base = field(xml, 'URLBase') || location;
  for (const type of SERVICE_TYPES) {
    for (const s of services) {
      if (field(s, 'serviceType') !== type) continue;
      const control = field(s, 'controlURL');
      if (!control) continue;
      try {
        const url = new URL(control, base);
        // A description that sends the SOAP calls to another host is not followed.
        if (url.protocol !== 'http:' || url.hostname !== new URL(location).hostname) continue;
        return { controlUrl: url.toString(), serviceType: type };
      } catch {
        /* a control URL that does not parse: try the next service */
      }
    }
  }
  return null;
}

const xmlEscape = (s: string): string => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string);

/** The SOAP envelope of one UPnP action; arguments in the order given (routers are strict about it). */
export function soapEnvelope(serviceType: string, action: string, args: [string, string | number][]): string {
  const body = args.map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`).join('');
  return `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body></s:Envelope>`;
}

type SoapResult = { ok: true; body: string } | { ok: false; code: number | null; text: string };

async function soap(gw: Gateway, action: string, args: [string, string | number][], timeoutMs: number): Promise<SoapResult> {
  try {
    const r = await fetch(gw.controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gw.serviceType}#${action}"` },
      body: soapEnvelope(gw.serviceType, action, args),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    const body = await r.text();
    if (r.ok) return { ok: true, body };
    const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(body)?.[1];
    const text = /<errorDescription>\s*([^<]*?)\s*<\/errorDescription>/i.exec(body)?.[1];
    return { ok: false, code: code ? Number(code) : null, text: text || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, code: null, text: describe(e) };
  }
}

/** Search every local address at once; the first answer whose description names a WAN connection service wins. */
function discover(opts: OpenPortOptions, deadline: number): Promise<Gateway | null> {
  const target = opts.ssdp ?? SSDP;
  const locals = opts.localAddresses ?? lanAddresses();
  if (locals.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const sockets: Socket[] = [];
    const seen = new Set<string>();
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (gw: Gateway | null): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          /* already closed */
        }
      }
      resolve(gw);
    };
    timers.push(setTimeout(() => finish(null), Math.max(1, deadline - Date.now())));
    const search = (s: Socket): void => {
      for (const st of SEARCH_TARGETS) {
        const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.address}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`);
        s.send(msg, target.port, target.address, () => undefined);
      }
    };
    for (const local of locals) {
      const s = createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(s);
      s.on('error', () => undefined);
      s.on('message', (buf, rinfo) => {
        const location = ssdpLocation(buf.toString('utf8'));
        if (!location || seen.has(location) || settled) return;
        seen.add(location);
        let host: string;
        try {
          const u = new URL(location);
          if (u.protocol !== 'http:') return;
          host = u.hostname;
        } catch {
          return;
        }
        // The description is fetched only from the device that answered.
        if (host !== rinfo.address) return;
        void fetch(location, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
          .then((r) => (r.ok ? r.text() : null))
          .then((xml) => {
            const found = xml ? parseDescription(xml, location) : null;
            if (found) finish({ ...found, localAddress: local });
          })
          .catch(() => undefined);
      });
      s.bind(0, local, () => {
        if (settled) return;
        search(s);
        // UDP: once more for a search that was lost.
        timers.push(setTimeout(() => !settled && search(s), 400));
      });
    }
  });
}

/**
 * Map external TCP `port` to this PC's `port` on the router. Resolves within `timeoutMs` and never throws; a failure
 * carries a reason for the log.
 */
export async function openPort(opts: OpenPortOptions): Promise<PortMapResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  const left = (): number => deadline - Date.now();
  const lease = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const description = opts.description ?? 'Castcade';
  let gw: Gateway | null;
  try {
    gw = await discover(opts, deadline);
  } catch (e) {
    return { ok: false, reason: `the search for a router failed (${describe(e)})` };
  }
  if (!gw) return { ok: false, reason: 'no UPnP router answered' };
  const gateway = gw;
  const host = new URL(gateway.controlUrl).hostname;
  const add = (seconds: number, timeoutMs: number): Promise<SoapResult> =>
    soap(
      gateway,
      'AddPortMapping',
      [
        ['NewRemoteHost', ''],
        ['NewExternalPort', opts.port],
        ['NewProtocol', 'TCP'],
        ['NewInternalPort', opts.port],
        ['NewInternalClient', gateway.localAddress],
        ['NewEnabled', 1],
        ['NewPortMappingDescription', description],
        ['NewLeaseDuration', seconds],
      ],
      timeoutMs,
    );
  let granted = lease;
  let r = await add(lease, left());
  // 725 OnlyPermanentLeasesSupported: this router has no leases.
  if (!r.ok && r.code === 725 && lease !== 0 && left() > 0) {
    granted = 0;
    r = await add(0, left());
  }
  if (!r.ok) return { ok: false, reason: `the router at ${host} refused the mapping (${r.code ?? 'no code'}: ${r.text})` };
  let externalIp: string | null = null;
  if (left() > 50) {
    const ext = await soap(gateway, 'GetExternalIPAddress', [], left());
    if (ext.ok) externalIp = /<NewExternalIPAddress>\s*([^<]*?)\s*<\/NewExternalIPAddress>/i.exec(ext.body)?.[1] || null;
  }
  return {
    ok: true,
    mapping: {
      externalPort: opts.port,
      externalIp,
      leaseSeconds: granted,
      gateway: host,
      renew: async () => (await add(granted, 3000)).ok,
      remove: async () =>
        (
          await soap(
            gateway,
            'DeletePortMapping',
            [
              ['NewRemoteHost', ''],
              ['NewExternalPort', opts.port],
              ['NewProtocol', 'TCP'],
            ],
            3000,
          )
        ).ok,
    },
  };
}

/** An address a router has when it is itself behind another NAT: private (RFC 1918), CGNAT (100.64/10) or link-local. */
export function isNonPublicIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || a === 0;
}

/**
 * The Match tab's line about the port. `publicIp`: what the outside sees of this network, when known: a router whose
 * own address is not that one (or is not public at all) sits behind another NAT, and its mapping does not help.
 * `paired`: the relay was tried and did not answer, so "pair with ArcAid" would be wrong advice.
 */
export function portMappingLine(r: PortMapResult, port: number, publicIp: string | null, paired: boolean): { state: 'opened' | 'failed'; line: string } {
  const without = paired ? 'ArcAid could not be reached to host without it' : 'or pair with ArcAid to host without it';
  if (!r.ok) return { state: 'failed', line: `Your router did not open the port: forward TCP ${port}${paired ? ` (${without})` : `, ${without}`}` };
  const ext = r.mapping.externalIp;
  if (ext && (isNonPublicIpv4(ext) || (publicIp !== null && ext !== publicIp))) {
    return {
      state: 'failed',
      line: `Your router opened the port, but it sits behind another router (your provider's, or a second one at home), so players outside cannot reach it${paired ? ` (${without})` : `: pair with ArcAid to host without it`}`,
    };
  }
  return { state: 'opened', line: 'Port opened on your router automatically' };
}
