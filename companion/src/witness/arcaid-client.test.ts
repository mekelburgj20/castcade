import { describe, expect, it } from 'vitest';
import { ArcaidClient, ArcaidError, buildUrl, type FetchLike } from './arcaid-client.js';

interface Recorded {
  url: URL;
  headers: Record<string, string>;
}

function fakeFetch(respond: (url: URL) => { status: number; body?: unknown } | Error): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, headers: init.headers });
    const r = respond(url);
    if (r instanceof Error) throw r;
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return { status: r.status, text: async () => text };
  };
  return { fetch, calls };
}

describe('ArcaidClient', () => {
  it('buildUrl joins the base and encodes params, dropping nulls', () => {
    expect(buildUrl('https://arcaid.app', 'api/witness/score', { device: 'd 1', score: 10, rom: null, partial: true, x: undefined })).toBe(
      'https://arcaid.app/api/witness/score?device=d+1&score=10&partial=1',
    );
    expect(buildUrl('http://localhost:3001/', 'api/witness/heartbeat', { device: 'd' })).toBe('http://localhost:3001/api/witness/heartbeat?device=d');
  });

  it('pair sends code, device, username and type=desktop without a token header, and returns the token', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, token: 'tok_abc' } }));
    const client = new ArcaidClient({ baseUrl: 'https://arcaid.app', fetch });
    expect(await client.pair(' abc234 ', 'dev-1', 'MY-PC')).toBe('tok_abc');
    const call = calls[0];
    expect(call?.url.pathname).toBe('/api/witness/pair');
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({ code: 'ABC234', device: 'dev-1', username: 'MY-PC', type: 'desktop' });
    expect(call?.headers['x-witness-token']).toBeUndefined();
  });

  it('pair surfaces the server message on 400 and classifies other failures', async () => {
    const bad = new ArcaidClient({ baseUrl: 'https://a', fetch: fakeFetch(() => ({ status: 400, body: { ok: false, error: 'That pairing code has expired', code: 'CODE_EXPIRED' } })).fetch });
    await expect(bad.pair('X', 'd', 'l')).rejects.toMatchObject({ kind: 'client', status: 400, message: 'That pairing code has expired' });

    const noToken = new ArcaidClient({ baseUrl: 'https://a', fetch: fakeFetch(() => ({ status: 200, body: { ok: true } })).fetch });
    await expect(noToken.pair('X', 'd', 'l')).rejects.toBeInstanceOf(ArcaidError);

    const down = new ArcaidClient({ baseUrl: 'https://a', fetch: fakeFetch(() => ({ status: 503 })).fetch });
    await expect(down.heartbeat('t', 'd')).rejects.toMatchObject({ kind: 'server', status: 503, retryable: true });

    const offline = new ArcaidClient({ baseUrl: 'https://a', fetch: fakeFetch(() => new TypeError('fetch failed')).fetch });
    await expect(offline.heartbeat('t', 'd')).rejects.toMatchObject({ kind: 'network', retryable: true });

    const revoked = new ArcaidClient({ baseUrl: 'https://a', fetch: fakeFetch(() => ({ status: 401, body: { ok: false } })).fetch });
    await expect(revoked.heartbeat('t', 'd')).rejects.toMatchObject({ kind: 'auth', status: 401, message: 'unpaired by ArcAid', retryable: false });
  });

  it('checkin carries the token and returns the server time and routing line; absent fields are null', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, ts: '2026-10-18 20:00:00', sendingTo: 'Room / Event · CHECKED IN · READY' } }));
    const client = new ArcaidClient({ baseUrl: 'https://arcaid.app', fetch });
    expect(await client.checkin('tok', 'd')).toEqual({ ts: '2026-10-18 20:00:00', sendingTo: 'Room / Event · CHECKED IN · READY' });
    expect(calls[0]?.url.pathname).toBe('/api/witness/checkin');
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ device: 'd' });
    expect(calls[0]?.headers['x-witness-token']).toBe('tok');

    const bare = new ArcaidClient({ baseUrl: 'https://a', fetch: fakeFetch(() => ({ status: 200, body: { ok: true, ts: 't', sendingTo: '' } })).fetch });
    expect(await bare.checkin('tok', 'd')).toEqual({ ts: 't', sendingTo: null });
  });

  it('a launch-only report omits exit and dur', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
    const client = new ArcaidClient({ baseUrl: 'https://arcaid.app', fetch });
    await client.report('tok', { device: 'd', table: 'MM', launch: 1_700_000_000 });
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ device: 'd', table: 'MM', launch: '1700000000' });
  });

  it('report, score and heartbeat carry the token header and the documented params', async () => {
    const { fetch, calls } = fakeFetch((url) => (url.pathname.endsWith('/score') ? { status: 200, body: { ok: true, status: 'ingested', game: 'Medieval Madness' } } : { status: 200, body: { ok: true } }));
    const client = new ArcaidClient({ baseUrl: 'https://arcaid.app', fetch });
    await client.report('tok', { device: 'd', table: 'MM', launch: 1_700_000_000, exit: 1_700_000_300, dur: 300 });
    const wire = await client.score('tok', { device: 'd', table: 'MM', rom: 'mm_109c', score: 1089510, started: 1_700_000_000, ended: 1_700_000_300, dur: 300, reason: 'exit_sample' });
    await client.heartbeat('tok', 'd');
    expect(wire).toEqual({ status: 'ingested', game: 'Medieval Madness' });
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/witness/report', '/api/witness/score', '/api/witness/heartbeat']);
    for (const c of calls) expect(c.headers['x-witness-token']).toBe('tok');
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ device: 'd', table: 'MM', launch: '1700000000', exit: '1700000300', dur: '300' });
    expect(Object.fromEntries(calls[1]?.url.searchParams ?? [])).toEqual({
      device: 'd',
      table: 'MM',
      rom: 'mm_109c',
      score: '1089510',
      started: '1700000000',
      ended: '1700000300',
      dur: '300',
      reason: 'exit_sample',
    });
    expect(Object.fromEntries(calls[2]?.url.searchParams ?? [])).toEqual({ device: 'd' });
  });

  it('times out a hanging request as a network failure', async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const client = new ArcaidClient({ baseUrl: 'https://a', fetch: hanging, timeoutMs: 20 });
    await expect(client.heartbeat('t', 'd')).rejects.toMatchObject({ kind: 'network', message: /did not answer within 20 ms/ });
  });
});
