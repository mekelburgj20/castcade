import { describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import { ArcaidClient, type FetchLike } from './arcaid-client.js';
import { MemoryFs } from './fs.js';
import { PostQueue, QUEUE_FILE, type PostResult, type QueuedPost } from './queue.js';

function harness(opts: { token?: string | null; baseDelayMs?: number } = {}) {
  const clock = new ManualClock();
  const fs = new MemoryFs(() => clock.now());
  let respond: (url: URL) => { status: number; body?: unknown } | Error = () => ({ status: 200, body: { ok: true } });
  const calls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    calls.push(url);
    const r = respond(url);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  const client = new ArcaidClient({ baseUrl: 'https://arcaid.test', fetch });
  const settled: { post: QueuedPost; result: PostResult }[] = [];
  const errors: string[] = [];
  const make = () =>
    new PostQueue({
      dataDir: '/data',
      client: () => client,
      token: () => (opts.token === undefined ? 'tok' : opts.token),
      fs,
      clock,
      baseDelayMs: opts.baseDelayMs ?? 5000,
      onSettled: (post, result) => settled.push({ post, result }),
      onError: (m) => errors.push(m),
    });
  return {
    clock,
    fs,
    calls,
    settled,
    errors,
    make,
    setRespond(fn: typeof respond) {
      respond = fn;
    },
  };
}

const report = { kind: 'report' as const, params: { device: 'd', table: 'T', launch: 100, exit: 400, dur: 300 } };
const score = { kind: 'score' as const, params: { device: 'd', table: 'T', rom: 'mm_109c', score: 5, started: 100, ended: 400, dur: 300, reason: 'exit_sample' } };

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

describe('PostQueue', () => {
  it('delivers at once when ArcAid answers, and reports the wire status for scores', async () => {
    const h = harness();
    h.setRespond((url) => (url.pathname.endsWith('/score') ? { status: 200, body: { ok: true, status: 'duplicate', game: 'T' } } : { status: 200, body: { ok: true } }));
    const q = h.make();
    expect(await q.submit(report)).toEqual({ state: 'done', wire: null });
    expect(await q.submit(score)).toEqual({ state: 'done', wire: { status: 'duplicate', game: 'T', reasons: [], fallback: null } });
    expect(q.size()).toBe(0);
    expect(h.fs.has(`/data/${QUEUE_FILE}`)).toBe(false);
  });

  it('an attempt post delivers its answer at once, and is kept and replayed when ArcAid is unreachable', async () => {
    const h = harness();
    const attempt = { kind: 'attempt' as const, params: { device: 'd', table: 'T', rom: 'mm_109c', started: 100, key: 's#1', players: 1 } };
    h.setRespond((url) => (url.pathname.endsWith('/attempt') ? { status: 200, body: { ok: true, status: 'over_limit', game: 'T', attempt: 6, of: 5, remaining: 0, late: false } } : { status: 200, body: { ok: true } }));
    const q = h.make();
    expect(await q.submit(attempt)).toEqual({ state: 'done', wire: null, attempt: { status: 'over_limit', game: 'T', attempt: 6, of: 5, remaining: 0, late: false } });
    expect(q.size()).toBe(0);

    h.setRespond(() => new Error('ECONNREFUSED'));
    const queued = await q.submit({ ...attempt, params: { ...attempt.params, key: 's#2' } });
    expect(queued.state).toBe('queued');
    expect(q.size()).toBe(1);
    expect(h.fs.has(`/data/${QUEUE_FILE}`)).toBe(true);
    h.setRespond((url) => (url.pathname.endsWith('/attempt') ? { status: 200, body: { ok: true, status: 'counted', game: 'T', attempt: 1, of: 5, remaining: 4, late: true } } : { status: 200, body: { ok: true } }));
    h.clock.advance(5000);
    await flush();
    expect(q.size()).toBe(0);
    expect(h.settled.map((s) => s.post.kind)).toEqual(['attempt']);
    expect(h.settled[0]?.result).toMatchObject({ state: 'done', attempt: { status: 'counted', late: true } });
    q.stop();
  });

  it('keeps a post on network failure, persists it, retries with backoff and settles it later', async () => {
    const h = harness({ baseDelayMs: 1000 });
    h.setRespond(() => new TypeError('fetch failed'));
    const q = h.make();
    const first = await q.submit(score);
    expect(first.state).toBe('queued');
    expect(q.size()).toBe(1);
    const persisted = h.fs.text(`/data/${QUEUE_FILE}`);
    expect(persisted).toContain('"kind":"score"');
    expect(persisted?.trim().split('\n')).toHaveLength(1);
    expect(h.calls).toHaveLength(1);

    // first retry after 1 s, still failing -> second retry after 2 s
    h.clock.advance(1000);
    await flush();
    expect(h.calls).toHaveLength(2);
    h.clock.advance(1999);
    await flush();
    expect(h.calls).toHaveLength(2);

    h.setRespond(() => ({ status: 200, body: { ok: true, status: 'ingested' } }));
    h.clock.advance(1);
    await flush();
    expect(h.calls).toHaveLength(3);
    expect(q.size()).toBe(0);
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]?.result).toEqual({ state: 'done', wire: { status: 'ingested', game: null, reasons: [], fallback: null } });
    expect(h.fs.has(`/data/${QUEUE_FILE}`)).toBe(false);
    expect(h.clock.pending()).toBe(0);
  });

  it('treats 5xx as retryable and 4xx as final; a 401 drops the post', async () => {
    const h = harness();
    h.setRespond(() => ({ status: 502 }));
    const q = h.make();
    expect((await q.submit(report)).state).toBe('queued');
    h.setRespond(() => ({ status: 401, body: { ok: false } }));
    expect(await q.submit(score)).toMatchObject({ state: 'rejected', error: { kind: 'auth', message: 'unpaired by ArcAid' } });
    expect(q.size()).toBe(1);
    // the queued report is retried and now rejected too -> settled as rejected, queue empty
    h.clock.advance(5000);
    await flush();
    expect(q.size()).toBe(0);
    expect(h.settled.map((s) => s.result.state)).toEqual(['rejected']);
  });

  it('survives a restart: a new queue loads the file and retries in order', async () => {
    const h = harness({ baseDelayMs: 1000 });
    h.setRespond(() => new TypeError('offline'));
    const q1 = h.make();
    await q1.submit(report);
    await q1.submit(score);
    expect(q1.size()).toBe(2);
    q1.stop();

    // torn trailing line (crash mid-write) must not poison the rest
    h.fs.put(`/data/${QUEUE_FILE}`, (h.fs.text(`/data/${QUEUE_FILE}`) ?? '') + '{"id":"x","ki');

    const delivered: string[] = [];
    h.setRespond((url) => {
      delivered.push(url.pathname);
      return { status: 200, body: { ok: true, status: 'ingested' } };
    });
    const q2 = h.make();
    await q2.load();
    expect(q2.size()).toBe(2);
    expect(q2.pending().map((p) => p.kind)).toEqual(['report', 'score']);
    h.clock.advance(1000);
    await flush();
    expect(delivered).toEqual(['/api/witness/report', '/api/witness/score']);
    expect(q2.size()).toBe(0);
    expect(h.settled).toHaveLength(2);
    expect(h.errors).toEqual([]);
  });

  it('without a token nothing is sent and the post is rejected (not queued)', async () => {
    const h = harness({ token: null });
    const q = h.make();
    expect(await q.submit(report)).toMatchObject({ state: 'rejected', error: { kind: 'auth' } });
    expect(h.calls).toHaveLength(0);
  });

  it('backoff doubles from the base and caps', () => {
    const h = harness({ baseDelayMs: 5000 });
    const q = h.make();
    expect(q.delayFor(1)).toBe(5000);
    expect(q.delayFor(2)).toBe(10_000);
    expect(q.delayFor(4)).toBe(40_000);
    expect(q.delayFor(20)).toBe(10 * 60_000);
  });
});
