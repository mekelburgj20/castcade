/**
 * D10.8: the UPnP port mapping against a faked gateway on localhost: a UDP socket that answers the SSDP search with a
 * LOCATION, and an HTTP server with the device description and the WANIPConnection control URL.
 */
import { createSocket, type Socket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isNonPublicIpv4, openPort, parseDescription, portMappingLine, soapEnvelope, ssdpLocation, type PortMapResult } from './port-mapping.js';

interface FakeGateway {
  ssdp: { address: string; port: number };
  /** SOAP actions received, as `Action k=v,k=v`. */
  calls: string[];
  /** The live mappings: `TCP:<external>` -> internal client:port. */
  mappings: Map<string, string>;
  close(): Promise<void>;
}

interface GatewayOptions {
  /** Refuse leased mappings with 725, as some routers do. */
  permanentOnly?: boolean;
  /** Refuse every AddPortMapping with this UPnP error code. */
  refuse?: number;
  externalIp?: string;
  /** Answer the search this late (ms). */
  searchDelayMs?: number;
  serviceType?: string;
  /** A LOCATION on another host than the one that answers. */
  foreignLocation?: boolean;
}

const fault = (code: number, text: string): string =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${text}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;

async function fakeGateway(o: GatewayOptions = {}): Promise<FakeGateway> {
  const serviceType = o.serviceType ?? 'urn:schemas-upnp-org:service:WANIPConnection:1';
  const calls: string[] = [];
  const mappings = new Map<string, string>();
  const http: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/rootDesc.xml') {
      res.setHeader('Content-Type', 'text/xml');
      res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><deviceList><device><deviceList><device>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/ctl/CmnIfCfg</controlURL></service></serviceList>
<serviceList><service><serviceType>${serviceType}</serviceType><serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId><controlURL>/ctl/IPConn</controlURL><eventSubURL>/evt/IPConn</eventSubURL></service></serviceList>
</device></deviceList></device></deviceList></device></root>`);
      return;
    }
    if (req.method === 'POST' && req.url === '/ctl/IPConn') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const action = /"[^#"]+#(\w+)"/.exec(String(req.headers['soapaction']))?.[1] ?? '?';
        const arg = (k: string): string => new RegExp(`<${k}>([^<]*)</${k}>`).exec(body)?.[1] ?? '';
        const args = [...body.matchAll(/<(New\w+)>([^<]*)<\/\1>/g)].map((m) => `${m[1]}=${m[2]}`).join(',');
        calls.push(`${action} ${args}`.trim());
        const bad = (code: number, text: string): void => {
          res.statusCode = 500;
          res.end(fault(code, text));
        };
        const ok = (inner: string): void => {
          res.setHeader('Content-Type', 'text/xml');
          res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${serviceType}">${inner}</u:${action}Response></s:Body></s:Envelope>`);
        };
        if (action === 'AddPortMapping') {
          if (o.refuse) return bad(o.refuse, 'refused');
          if (o.permanentOnly && arg('NewLeaseDuration') !== '0') return bad(725, 'OnlyPermanentLeasesSupported');
          mappings.set(`${arg('NewProtocol')}:${arg('NewExternalPort')}`, `${arg('NewInternalClient')}:${arg('NewInternalPort')}`);
          return ok('');
        }
        if (action === 'DeletePortMapping') {
          if (!mappings.delete(`${arg('NewProtocol')}:${arg('NewExternalPort')}`)) return bad(714, 'NoSuchEntryInArray');
          return ok('');
        }
        if (action === 'GetExternalIPAddress') return ok(`<NewExternalIPAddress>${o.externalIp ?? '203.0.113.7'}</NewExternalIPAddress>`);
        bad(401, 'Invalid Action');
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const httpPort = (http.address() as AddressInfo).port;
  const udp: Socket = createSocket('udp4');
  udp.on('message', (buf, rinfo) => {
    const text = buf.toString('utf8');
    if (!text.startsWith('M-SEARCH')) return;
    const st = /^ST:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
    // Like a real IGD: only the search targets it implements are answered.
    if (!st.includes('InternetGatewayDevice:1') && st !== serviceType) return;
    const location = o.foreignLocation ? `http://192.0.2.1:${httpPort}/rootDesc.xml` : `http://127.0.0.1:${httpPort}/rootDesc.xml`;
    const answer = `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nST: ${st}\r\nUSN: uuid:fake::${st}\r\nEXT:\r\nSERVER: Fake/1.0 UPnP/1.1\r\nLOCATION: ${location}\r\n\r\n`;
    setTimeout(() => udp.send(answer, rinfo.port, rinfo.address), o.searchDelayMs ?? 0);
  });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  return {
    ssdp: { address: '127.0.0.1', port: udp.address().port },
    calls,
    mappings,
    close: async () => {
      await new Promise<void>((r) => udp.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

const gateways: FakeGateway[] = [];
afterEach(async () => {
  for (const g of gateways.splice(0)) await g.close();
});
const gateway = async (o: GatewayOptions = {}): Promise<FakeGateway> => {
  const g = await fakeGateway(o);
  gateways.push(g);
  return g;
};
const open = (g: FakeGateway, extra: Partial<Parameters<typeof openPort>[0]> = {}): Promise<PortMapResult> =>
  openPort({ port: 27401, ssdp: g.ssdp, localAddresses: ['127.0.0.1'], timeoutMs: 2000, ...extra });

describe('openPort (D10.8): UPnP against a faked gateway', () => {
  it('finds the gateway, maps TCP 27401 to this PC with a lease, reads the external address, renews and removes', async () => {
    const g = await gateway();
    const r = await open(g);
    if (!r.ok) throw new Error(r.reason);
    expect(r.mapping).toMatchObject({ externalPort: 27401, externalIp: '203.0.113.7', leaseSeconds: 3600, gateway: '127.0.0.1' });
    expect(g.mappings.get('TCP:27401')).toBe('127.0.0.1:27401');
    expect(g.calls[0]).toBe(
      'AddPortMapping NewRemoteHost=,NewExternalPort=27401,NewProtocol=TCP,NewInternalPort=27401,NewInternalClient=127.0.0.1,NewEnabled=1,NewPortMappingDescription=Castcade,NewLeaseDuration=3600',
    );
    expect(g.calls[1]).toBe('GetExternalIPAddress');
    expect(await r.mapping.renew()).toBe(true);
    expect(g.calls.filter((c) => c.startsWith('AddPortMapping'))).toHaveLength(2);
    expect(await r.mapping.remove()).toBe(true);
    expect(g.mappings.size).toBe(0);
    expect(g.calls.at(-1)).toBe('DeletePortMapping NewRemoteHost=,NewExternalPort=27401,NewProtocol=TCP');
    // Already gone: said, not thrown.
    expect(await r.mapping.remove()).toBe(false);
  });

  it('a router that only takes permanent mappings (725) gets one, and it is still removed', async () => {
    const g = await gateway({ permanentOnly: true, serviceType: 'urn:schemas-upnp-org:service:WANPPPConnection:1' });
    const r = await open(g);
    if (!r.ok) throw new Error(r.reason);
    expect(r.mapping.leaseSeconds).toBe(0);
    expect(g.calls.filter((c) => c.startsWith('AddPortMapping')).map((c) => c.split('NewLeaseDuration=')[1])).toEqual(['3600', '0']);
    expect(await r.mapping.remove()).toBe(true);
  });

  it('a router that refuses says why; no router at all gives up at the timeout, never later', async () => {
    const g = await gateway({ refuse: 718 });
    const refused = await open(g);
    expect(refused).toEqual({ ok: false, reason: 'the router at 127.0.0.1 refused the mapping (718: refused)' });

    const silent = createSocket('udp4');
    await new Promise<void>((res) => silent.bind(0, '127.0.0.1', () => res()));
    try {
      const t0 = Date.now();
      const none = await openPort({ port: 27401, ssdp: { address: '127.0.0.1', port: silent.address().port }, localAddresses: ['127.0.0.1'], timeoutMs: 300 });
      expect(none).toEqual({ ok: false, reason: 'no UPnP router answered' });
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      silent.close();
    }
    expect(await openPort({ port: 27401, localAddresses: [], timeoutMs: 300 })).toEqual({ ok: false, reason: 'no UPnP router answered' });
  });

  it('a gateway that answers after the deadline is not waited for, and a LOCATION on another host is not followed', async () => {
    const late = await gateway({ searchDelayMs: 600 });
    expect((await open(late, { timeoutMs: 250 })).ok).toBe(false);
    expect(late.calls).toEqual([]);
    const foreign = await gateway({ foreignLocation: true });
    expect(await open(foreign, { timeoutMs: 400 })).toEqual({ ok: false, reason: 'no UPnP router answered' });
    expect(foreign.calls).toEqual([]);
  });
});

describe('port-mapping helpers', () => {
  it('ssdpLocation reads the LOCATION of a 200 answer only', () => {
    expect(ssdpLocation('HTTP/1.1 200 OK\r\nST: x\r\nLocation: http://192.168.1.1:5000/rootDesc.xml\r\n\r\n')).toBe('http://192.168.1.1:5000/rootDesc.xml');
    expect(ssdpLocation('NOTIFY * HTTP/1.1\r\nLOCATION: http://192.168.1.1/x\r\n\r\n')).toBeNull();
    expect(ssdpLocation('HTTP/1.1 200 OK\r\nST: x\r\n\r\n')).toBeNull();
  });

  it('parseDescription prefers WANIPConnection:2, resolves the control URL against URLBase or the location, and stays on the same host', () => {
    const svc = (type: string, url: string): string => `<service><serviceType>${type}</serviceType><controlURL>${url}</controlURL></service>`;
    const loc = 'http://192.168.1.1:5000/desc/root.xml';
    const both = `<root>${svc('urn:schemas-upnp-org:service:WANIPConnection:1', '/ctl/1')}${svc('urn:schemas-upnp-org:service:WANIPConnection:2', 'ctl/2')}</root>`;
    expect(parseDescription(both, loc)).toEqual({ controlUrl: 'http://192.168.1.1:5000/desc/ctl/2', serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:2' });
    const based = `<root><URLBase>http://192.168.1.1:49152/</URLBase>${svc('urn:schemas-upnp-org:service:WANPPPConnection:1', '/upnp/control/WANPPPConn1')}</root>`;
    expect(parseDescription(based, loc)?.controlUrl).toBe('http://192.168.1.1:49152/upnp/control/WANPPPConn1');
    expect(parseDescription(`<root>${svc('urn:schemas-upnp-org:service:WANIPConnection:1', 'http://203.0.113.9/ctl')}</root>`, loc)).toBeNull();
    expect(parseDescription(`<root>${svc('urn:schemas-upnp-org:service:Layer3Forwarding:1', '/ctl/L3F')}</root>`, loc)).toBeNull();
  });

  it('soapEnvelope escapes its arguments', () => {
    expect(soapEnvelope('urn:x', 'AddPortMapping', [['NewPortMappingDescription', 'a<b&"c"']])).toContain('<NewPortMappingDescription>a&lt;b&amp;&quot;c&quot;</NewPortMappingDescription>');
  });

  it('portMappingLine: the two lines of the Match tab, a router behind another NAT, and the paired wording', () => {
    const mapped = (externalIp: string | null): PortMapResult => ({ ok: true, mapping: { externalPort: 27401, externalIp, leaseSeconds: 3600, gateway: '192.168.1.1', renew: async () => true, remove: async () => true } });
    expect(portMappingLine(mapped('203.0.113.7'), 27401, '203.0.113.7', false)).toEqual({ state: 'opened', line: 'Port opened on your router automatically' });
    expect(portMappingLine(mapped(null), 27401, null, false).state).toBe('opened');
    expect(portMappingLine({ ok: false, reason: 'x' }, 27401, null, false)).toEqual({ state: 'failed', line: 'Your router did not open the port: forward TCP 27401, or pair with ArcAid to host without it' });
    expect(portMappingLine({ ok: false, reason: 'x' }, 27401, null, true).line).toBe('Your router did not open the port: forward TCP 27401 (ArcAid could not be reached to host without it)');
    // CGNAT, a second router, or an address that is not the one the outside sees.
    for (const ext of ['100.72.1.9', '192.168.0.2', '10.1.2.3']) expect(portMappingLine(mapped(ext), 27401, null, false).state, ext).toBe('failed');
    expect(portMappingLine(mapped('198.51.100.4'), 27401, '203.0.113.7', false).line).toMatch(/sits behind another router.*pair with ArcAid/);
    expect(isNonPublicIpv4('172.16.0.1')).toBe(true);
    expect(isNonPublicIpv4('172.32.0.1')).toBe(false);
    expect(isNonPublicIpv4('8.8.8.8')).toBe(false);
  });
});
