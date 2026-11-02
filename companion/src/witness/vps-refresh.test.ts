import { describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import { MemoryFs } from './fs.js';
import { createVpsIndex } from './vps-index.js';
import { createVpsRefresh, shortVersion, versionFromEtag, vpsRefreshDir, type VpsDbFetch, type VpsRefreshState } from './vps-refresh.js';

const DAY = 24 * 60 * 60_000;
const DELAY = 30_000;

const db = (names: string[]) => names.map((name, i) => ({ id: `g${i}`, name, romFiles: [{ version: `rom${i}_100` }], tableFiles: [{ id: `t${i}`, authors: ['A'] }] }));

interface Call {
  url: string;
  ifNoneMatch: string | null;
}

type Reply = { status: 200; body: unknown; etag: string; contentLength?: number } | { status: 304 } | { status: number } | { throws: string };

/** A scripted fetch: each call takes the next reply; the calls made are recorded with their If-None-Match. */
function fakeFetch(replies: Reply[]): { fetch: VpsDbFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: VpsDbFetch = async (url, init) => {
    calls.push({ url, ifNoneMatch: init.headers['if-none-match'] ?? null });
    const r = replies.shift();
    if (!r) throw new Error('unexpected fetch');
    if ('throws' in r) throw new Error(r.throws);
    const headers = new Map<string, string>();
    if ('etag' in r) headers.set('etag', r.etag);
    if ('contentLength' in r && r.contentLength !== undefined) headers.set('content-length', String(r.contentLength));
    return {
      status: r.status,
      text: async () => ('body' in r ? (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) : ''),
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    };
  };
  return { fetch, calls };
}

function harness(replies: Reply[], opts: { state?: VpsRefreshState; bundled?: boolean } = {}) {
  const clock = new ManualClock(Date.parse('2026-11-02T04:00:00.000Z'));
  const fs = new MemoryFs(() => clock.now());
  const dir = vpsRefreshDir('/data');
  if (opts.bundled !== false) fs.put('/bundled/index.json', JSON.stringify({ version: 'cce9160', generatedAt: '2026-10-19T06:20:39.599Z', games: db(['Old Game']).map((g) => ({ ...g, roms: ['rom0_100'], tables: [{ id: 't0', authors: ['A'] }] })) }));
  if (opts.state) fs.put(`${dir}/state.json`, JSON.stringify(opts.state));
  const index = createVpsIndex({ bundled: '/bundled', refreshed: dir }, fs);
  const { fetch, calls } = fakeFetch(replies);
  const logs: string[] = [];
  const refreshed: VpsRefreshState[] = [];
  const refresh = createVpsRefresh({
    dir,
    fs,
    fetch,
    clock,
    log: (l) => logs.push(l),
    intervalMs: DAY,
    startDelayMs: DELAY,
    maxBodyBytes: 10_000,
    onRefreshed: (s) => {
      refreshed.push(s);
      index.reload();
    },
  });
  return { clock, fs, dir, index, calls, logs, refreshed, refresh };
}

/** Let the promise chain behind a fired timer settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const fresh = (names: string[], etag = '"fffd511d0000000000000000000000000000000000000000000000000000abcd"'): Reply => ({ status: 200, body: db(names), etag });

describe('versionFromEtag / shortVersion', () => {
  it('strip quotes and the weak marker; a hash shows its first seven characters', () => {
    expect(versionFromEtag('"abc"')).toBe('abc');
    expect(versionFromEtag('W/"abc"')).toBe('abc');
    expect(versionFromEtag('""')).toBeNull();
    expect(versionFromEtag(null)).toBeNull();
    expect(shortVersion('cce9160b30110ee174786239fdfb30a6e4caaab7')).toBe('cce9160');
    expect(shortVersion('fetched-2026-11-02T04:00:00.000Z')).toBe('fetched-2026-11-02T04:00:00.000Z');
    expect(shortVersion(null)).toBe('unknown');
  });
});

describe('createVpsRefresh', () => {
  it('with no cached copy: one fetch after the start delay; a 200 writes the index atomically and reloads the loader', async () => {
    const h = harness([fresh(['Old Game', 'Freddy'])]);
    await h.refresh.start();
    expect((await h.index.info()).source).toBe('bundled');
    expect(h.calls).toHaveLength(0);
    h.clock.advance(DELAY - 1);
    expect(h.calls).toHaveLength(0);
    h.clock.advance(1);
    await settle();
    expect(h.calls).toEqual([{ url: 'https://raw.githubusercontent.com/VirtualPinballSpreadsheet/vps-db/main/db/vpsdb.json', ifNoneMatch: null }]);

    expect(h.fs.has(`${h.dir}/index.json`)).toBe(true);
    expect(h.fs.has(`${h.dir}/index.json.tmp`)).toBe(false);
    expect(h.refreshed).toHaveLength(1);
    const state = h.refresh.state();
    expect(state).toEqual({
      etag: '"fffd511d0000000000000000000000000000000000000000000000000000abcd"',
      checkedAt: '2026-11-02T04:00:30.000Z',
      refreshedAt: '2026-11-02T04:00:30.000Z',
      version: 'fffd511d0000000000000000000000000000000000000000000000000000abcd',
      games: 2,
      tables: 2,
    });
    expect(JSON.parse(h.fs.text(`${h.dir}/state.json`) ?? '')).toEqual(state);

    // The loader now answers from the refreshed copy, without a restart.
    const info = await h.index.info();
    expect(info).toEqual({ source: 'refreshed', version: state?.version, games: 2, tables: 2, builtAt: '2026-11-02T04:00:30.000Z' });
    expect((await h.index.gamesByName('Freddy')).map((g) => g.id)).toEqual(['g1']);
    expect(h.logs).toEqual([]);
  });

  it('then checks once a day with If-None-Match: a 304 touches checkedAt and keeps the index', async () => {
    const h = harness([fresh(['A']), { status: 304 }, fresh(['A', 'B'], '"second"')]);
    await h.refresh.start();
    h.clock.advance(DELAY);
    await settle();
    expect(h.calls).toHaveLength(1);
    const first = h.refresh.state();

    h.clock.advance(DAY - 1);
    await settle();
    expect(h.calls).toHaveLength(1);
    h.clock.advance(1);
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.ifNoneMatch).toBe(first?.etag);
    expect(h.refresh.state()).toEqual({ ...first, checkedAt: '2026-11-03T04:00:30.000Z' });
    expect(h.refreshed).toHaveLength(1);
    expect(h.logs).toEqual(['witness: VPS index up to date (vps-db unchanged since 2026-11-02T04:00:30.000Z)']);
    expect((await h.index.info()).games).toBe(1);

    h.clock.advance(DAY);
    await settle();
    expect(h.calls).toHaveLength(3);
    expect(h.refresh.state()?.etag).toBe('"second"');
    expect(h.refreshed).toHaveLength(2);
    expect((await h.index.info()).games).toBe(2);
  });

  it('a copy checked less than a day ago waits out the rest of its day', async () => {
    const state: VpsRefreshState = { etag: '"e"', checkedAt: '2026-11-02T00:00:00.000Z', refreshedAt: '2026-11-02T00:00:00.000Z', version: 'e', games: 1, tables: 1 };
    const h = harness([{ status: 304 }], { state });
    await h.refresh.start();
    expect(h.refresh.state()).toEqual(state);
    h.clock.advance(DAY - 4 * 60 * 60_000 - 1); // checked at 00:00, started at 04:00: due at 00:00 next day
    await settle();
    expect(h.calls).toHaveLength(0);
    h.clock.advance(1);
    await settle();
    expect(h.calls).toEqual([{ url: expect.any(String), ifNoneMatch: '"e"' }]);
  });

  it('a copy older than a day is checked after the start delay, never sooner', async () => {
    const state: VpsRefreshState = { etag: '"e"', checkedAt: '2026-10-30T00:00:00.000Z', refreshedAt: '2026-10-30T00:00:00.000Z', version: 'e', games: 1, tables: 1 };
    const h = harness([{ status: 304 }], { state });
    await h.refresh.start();
    h.clock.advance(DELAY - 1);
    expect(h.calls).toHaveLength(0);
    h.clock.advance(1);
    await settle();
    expect(h.calls).toHaveLength(1);
  });

  it('a failure is one log line and leaves the loaded index alone: HTTP error, no network, bad JSON, oversize, 304 with nothing cached', async () => {
    const h = harness([
      { status: 500 },
      { throws: 'getaddrinfo ENOTFOUND raw.githubusercontent.com' },
      { status: 200, body: '{not json', etag: '"x"' },
      { status: 200, body: db(['A']), etag: '"x"', contentLength: 10_001 },
      { status: 200, body: db(Array.from({ length: 400 }, (_, i) => `Game number ${i}`)), etag: '"x"' },
      { status: 304 },
      { status: 200, body: { games: [] }, etag: '"x"' },
      { status: 200, body: [], etag: '"x"' },
    ]);
    await h.refresh.start();
    for (let i = 0; i < 8; i++) expect((await h.refresh.refresh()).kind).toBe('failed');
    expect(h.logs).toEqual([
      'witness: VPS index refresh skipped (HTTP 500); the loaded index stays in use',
      'witness: VPS index refresh skipped (getaddrinfo ENOTFOUND raw.githubusercontent.com); the loaded index stays in use',
      'witness: VPS index refresh skipped (not JSON); the loaded index stays in use',
      'witness: VPS index refresh skipped (body is 10001 bytes, over the 10000 limit); the loaded index stays in use',
      expect.stringMatching(/^witness: VPS index refresh skipped \(body is \d+ bytes, over the 10000 limit\)/),
      'witness: VPS index refresh skipped (HTTP 304 without a cached index); the loaded index stays in use',
      'witness: VPS index refresh skipped (vpsdb.json: expected a top-level array of games); the loaded index stays in use',
      'witness: VPS index refresh skipped (no games in the database); the loaded index stays in use',
    ]);
    expect(h.fs.has(`${h.dir}/index.json`)).toBe(false);
    expect(h.refresh.state()).toBeNull();
    expect(h.refreshed).toHaveLength(0);
    expect((await h.index.info()).source).toBe('bundled');
  });

  it('a failed daily check is retried a day later, not sooner', async () => {
    const h = harness([{ status: 503 }, fresh(['A'])]);
    await h.refresh.start();
    h.clock.advance(DELAY);
    await settle();
    expect(h.calls).toHaveLength(1);
    h.clock.advance(DAY - 1);
    await settle();
    expect(h.calls).toHaveLength(1);
    h.clock.advance(1);
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.refreshed).toHaveLength(1);
  });

  it('a response without an ETag still builds an index, versioned by its fetch time', async () => {
    const h = harness([{ status: 200, body: db(['A']), etag: '' }]);
    await h.refresh.start();
    expect((await h.refresh.refresh()).kind).toBe('fresh');
    expect(h.refresh.state()?.version).toBe('fetched-2026-11-02T04:00:00.000Z');
    expect(h.refresh.state()?.etag).toBeNull();
  });

  it('a torn state.json is ignored, and stop() cancels the timer', async () => {
    const h = harness([fresh(['A'])]);
    h.fs.put(`${h.dir}/state.json`, '{"etag":');
    await h.refresh.start();
    expect(h.refresh.state()).toBeNull();
    expect(h.clock.pending()).toBe(1);
    h.refresh.stop();
    expect(h.clock.pending()).toBe(0);
    h.clock.advance(DAY);
    await settle();
    expect(h.calls).toHaveLength(0);
  });

  it('two overlapping refresh() calls share one fetch', async () => {
    const h = harness([fresh(['A'])]);
    await h.refresh.start();
    const [a, b] = await Promise.all([h.refresh.refresh(), h.refresh.refresh()]);
    expect(a.kind).toBe('fresh');
    expect(b).toBe(a);
    expect(h.calls).toHaveLength(1);
  });
});
