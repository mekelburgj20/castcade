import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveGame, WitnessStatus } from '../witness/types.js';
import { createOverlayServer, overlayStateFrom, type OverlayServer, type OverlayState } from './overlay-server.js';

const status = (patch: Partial<WitnessStatus> = {}): WitnessStatus =>
  ({ paired: true, running: true, currentTable: 'Monster Bash', captureMode: 'live', attempt: null, lastCapture: null, ...patch }) as WitnessStatus;

const game = (patch: Partial<LiveGame> = {}): LiveGame => ({ table: 'Monster Bash', inGame: true, scores: [1_250_000, 0, 0, 0], player: 1, ball: 2, ...patch });

describe('overlayStateFrom', () => {
  it('a live table with a game in progress: the scores, player, ball and the live badge', () => {
    expect(overlayStateFrom(status({ attempt: { text: 'Attempt 2 of 10' } as WitnessStatus['attempt'] }), game())).toEqual({
      v: 1,
      table: 'Monster Bash',
      game: { inGame: true, scores: [1_250_000, 0, 0, 0], player: 1, ball: 2 },
      badge: { kind: 'live', text: 'Arcaid Witness · live' },
      attempt: 'Attempt 2 of 10',
      lastPost: null,
    });
  });

  it('says what the witness can promise: basic, idle, unpaired', () => {
    expect(overlayStateFrom(status({ captureMode: 'basic' }), null).badge.kind).toBe('basic');
    expect(overlayStateFrom(status({ currentTable: null, captureMode: null }), null)).toMatchObject({ table: null, game: null, badge: { kind: 'idle' } });
    expect(overlayStateFrom(status({ paired: false }), game()).badge).toEqual({ kind: 'unpaired', text: 'Castcade · not paired with ArcAid' });
  });

  it('carries the last post', () => {
    const lastCapture = { table: 'Monster Bash', score: 3_289_230, outcome: 'ingested' } as WitnessStatus['lastCapture'];
    expect(overlayStateFrom(status({ lastCapture }), null).lastPost).toEqual({ score: 3_289_230, outcome: 'ingested', table: 'Monster Bash' });
  });
});

/** One HTTP request against the server; `host` overrides the Host header. */
function get(url: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers: opts.host ? { Host: opts.host } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Open `/events` and collect the `data:` payloads as they arrive. */
function subscribe(url: string): { messages: OverlayState[]; next(n: number): Promise<void>; close(): void } {
  const messages: OverlayState[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  let buf = '';
  const u = new URL(url);
  const req = request({ hostname: u.hostname, port: u.port, path: '/events' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (data) messages.push(JSON.parse(data.slice(6)) as OverlayState);
      }
      for (const w of [...waiters]) if (messages.length >= w.n) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return {
    messages,
    next: (n) => (messages.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve }))),
    close: () => req.destroy(),
  };
}

describe('createOverlayServer', () => {
  let server: OverlayServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  const start = async (state: () => OverlayState) => {
    server = createOverlayServer({ state, port: 0, coalesceMs: 10 });
    return server.start();
  };

  it('serves the page, the state once, and refuses the rest', async () => {
    const url = await start(() => overlayStateFrom(status(), game()));
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/overlay$/);
    const page = await get(url);
    expect(page).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
    expect(page.body).toContain("new EventSource('/events')");
    const state = await get(url.replace('/overlay', '/state.json'));
    expect(JSON.parse(state.body)).toMatchObject({ v: 1, table: 'Monster Bash', badge: { kind: 'live' } });
    expect((await get(url.replace('/overlay', '/nope'))).status).toBe(404);
    expect((await get(url, { method: 'POST' })).status).toBe(405);
  });

  it('refuses a request whose Host is not this loopback address (DNS rebinding)', async () => {
    const url = await start(() => overlayStateFrom(status(), null));
    expect((await get(url, { host: 'evil.example:80' })).status).toBe(403);
    expect((await get(url, { host: `localhost:${new URL(url).port}` })).status).toBe(200);
  });

  it('streams the state at connect, then each change once, coalesced', async () => {
    let g = game({ scores: [1000, 0, 0, 0] });
    const url = await start(() => overlayStateFrom(status(), g));
    const sub = subscribe(url);
    try {
      await sub.next(1);
      expect(sub.messages[0]?.game?.scores[0]).toBe(1000);
      expect(server!.clients()).toBe(1);
      g = game({ scores: [2000, 0, 0, 0] });
      server!.publish();
      g = game({ scores: [3000, 0, 0, 0] });
      server!.publish(); // inside the window: one message with the latest state
      await sub.next(2);
      expect(sub.messages[1]?.game?.scores[0]).toBe(3000);
      server!.publish(); // nothing changed: nothing sent
      g = game({ inGame: false, scores: [3000, 0, 0, 0], player: null, ball: null });
      await new Promise((r) => setTimeout(r, 30));
      server!.publish();
      await sub.next(3);
      expect(sub.messages).toHaveLength(3);
      expect(sub.messages[2]?.game).toMatchObject({ inGame: false, player: null });
    } finally {
      sub.close();
    }
  });

  it('a taken port rejects start, and stop ends the streams', async () => {
    const url = await start(() => overlayStateFrom(status(), null));
    const second = createOverlayServer({ state: () => overlayStateFrom(status(), null), port: Number(new URL(url).port) });
    await expect(second.start()).rejects.toThrow(/EADDRINUSE/);
    const sub = subscribe(url);
    await sub.next(1);
    await server!.stop();
    expect(server!.clients()).toBe(0);
    expect(server!.url()).toBeNull();
    sub.close();
  });
});
