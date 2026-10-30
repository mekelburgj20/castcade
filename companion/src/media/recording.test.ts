import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRetention, GENESIS, listSessions, MANIFEST, planRetention, RecordingSession, sessionIdFor, verifyManifest } from './recording.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'castcade-rec-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse('2026-10-28T07:01:41.476Z');

describe('recording session (D1.2)', () => {
  it('names sessions sortably and never reuses a folder', async () => {
    expect(sessionIdFor(T0)).toBe('2026-10-28T07-01-41Z');
    const a = await RecordingSession.open(root, () => T0);
    const b = await RecordingSession.open(root, () => T0);
    expect([a.id, b.id]).toEqual(['2026-10-28T07-01-41Z', '2026-10-28T07-01-41Z-2']);
  });

  it('writes a hash-chained manifest: segments with their sha256, games and posted scores tied to the segment', async () => {
    let t = T0;
    const s = await RecordingSession.open(root, () => (t += 1000));
    await s.append({ kind: 'session_start', app: '0.2.19', preset: '720p30', streaming: true, recording: true });
    const path = await s.startSegment('Monster Bash', { width: 720, height: 1280 });
    expect(path.endsWith('seg-001.mp4')).toBe(true);
    writeFileSync(path, 'not really an mp4');
    await s.append({ kind: 'game_start', table: 'Monster Bash', segment: s.segment });
    await s.append({ kind: 'score_posted', table: 'Monster Bash', score: 1_234_560, outcome: 'ingested', mode: 'live', segment: s.segment });
    await s.close('stopped');
    const text = readFileSync(join(s.dir, MANIFEST), 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.kind)).toEqual(['session_start', 'segment_start', 'game_start', 'score_posted', 'segment_end', 'session_end']);
    expect(lines[0]).toMatchObject({ seq: 1, prev: GENESIS, at: '2026-10-28T07:01:43.476Z' });
    expect(lines[3]).toMatchObject({ segment: 'seg-001.mp4', score: 1_234_560 });
    expect(lines[4]).toMatchObject({ file: 'seg-001.mp4', bytes: 17, sha256: createHash('sha256').update('not really an mp4').digest('hex') });
    expect(verifyManifest(text)).toEqual({ ok: true, lines: 6 });
  });

  it('a changed, dropped or reordered line breaks the chain from there on', async () => {
    const s = await RecordingSession.open(root, () => T0);
    for (let i = 0; i < 4; i++) await s.append({ kind: 'game_start', table: `t${i}`, segment: null });
    const rows = readFileSync(join(s.dir, MANIFEST), 'utf8').trim().split('\n');
    expect(verifyManifest(rows.join('\n')).ok).toBe(true);
    expect(verifyManifest([rows[0], rows[1]!.replace('t1', 'tX'), rows[2], rows[3]].join('\n'))).toMatchObject({ ok: false, badAt: 3 });
    expect(verifyManifest([rows[0], rows[2], rows[3]].join('\n'))).toMatchObject({ ok: false, badAt: 2 });
    expect(verifyManifest([rows[1], rows[0]].join('\n'))).toMatchObject({ ok: false, badAt: 1 });
  });

  it('a segment ffmpeg never wrote still closes, with no hash', async () => {
    const s = await RecordingSession.open(root, () => T0);
    await s.startSegment(null, { width: 1280, height: 720 });
    await s.endSegment('ffmpeg failed');
    const last = JSON.parse(readFileSync(join(s.dir, MANIFEST), 'utf8').trim().split('\n').pop()!) as Record<string, unknown>;
    expect(last).toMatchObject({ kind: 'segment_end', sha256: null, bytes: 0, reason: 'ffmpeg failed' });
    expect(s.segment).toBeNull();
  });
});

describe('retention (owner ruling 2026-10-25: last 3 sessions, optional cap, Sanctioned kept)', () => {
  const S = (id: string, recordings = 1, keep = false) => ({ id, recordings, keep });

  it('keeps the newest N, never the current or a Sanctioned one', () => {
    const sessions = [S('a'), S('b', 1, true), S('c'), S('d'), S('e')];
    expect(planRetention(sessions, { keepSessions: 3, maxRecordings: null }, null)).toEqual(['a']);
    expect(planRetention(sessions, { keepSessions: 3, maxRecordings: null }, 'e')).toEqual(['a']);
    expect(planRetention(sessions, { keepSessions: 1, maxRecordings: null }, 'e')).toEqual(['a', 'c', 'd']);
    expect(planRetention(sessions, { keepSessions: 0, maxRecordings: null }, 'a')).toEqual(['c', 'd', 'e']);
  });

  it('then caps the MP4 count, oldest first; Sanctioned recordings count toward neither limit', () => {
    const sessions = [S('a', 4), S('b', 9, true), S('c', 3), S('d', 2)];
    expect(planRetention(sessions, { keepSessions: 3, maxRecordings: 5 }, null)).toEqual(['a']);
    expect(planRetention(sessions, { keepSessions: 3, maxRecordings: 4 }, null)).toEqual(['a', 'c']);
    expect(planRetention(sessions, { keepSessions: 3, maxRecordings: null }, null)).toEqual([]);
  });

  it('reads sessions from disk, marks Sanctioned ones, ignores foreign folders, and deletes what the plan says', async () => {
    for (const [id, sanctioned] of [['2026-10-01T00-00-00Z', false], ['2026-10-02T00-00-00Z', true], ['2026-10-03T00-00-00Z', false]] as const) {
      await mkdir(join(root, id));
      await writeFile(join(root, id, 'seg-001.mp4'), 'x');
      await writeFile(join(root, id, MANIFEST), `${JSON.stringify({ kind: 'score_posted', sanctioned })}\n`);
    }
    await mkdir(join(root, 'not-a-session'));
    expect(await listSessions(root)).toEqual([
      { id: '2026-10-01T00-00-00Z', recordings: 1, keep: false },
      { id: '2026-10-02T00-00-00Z', recordings: 1, keep: true },
      { id: '2026-10-03T00-00-00Z', recordings: 1, keep: false },
    ]);
    expect(await applyRetention(root, { keepSessions: 1, maxRecordings: null }, null)).toEqual(['2026-10-01T00-00-00Z']);
    expect((await listSessions(root)).map((s) => s.id)).toEqual(['2026-10-02T00-00-00Z', '2026-10-03T00-00-00Z']);
    expect(await listSessions(join(root, 'missing'))).toEqual([]);
  });

  it('D1.7: a Sanctioned session is kept while its tournament is open or has no end date, and pruned once it closes', async () => {
    const cases: [string, unknown][] = [
      ['2026-10-01T00-00-00Z', { id: '1', name: 'T', closesAt: '2026-11-01T00:00:00Z' }],
      ['2026-10-02T00-00-00Z', { id: '2', name: 'T', closesAt: null }],
      ['2026-10-03T00-00-00Z', undefined],
    ];
    for (const [id, tournament] of cases) {
      await mkdir(join(root, id));
      await writeFile(join(root, id, MANIFEST), `not json\n${JSON.stringify({ kind: 'score_posted', sanctioned: true, ...(tournament ? { tournament } : {}) })}\n`);
    }
    const keeps = async (nowIso: string) => (await listSessions(root, () => Date.parse(nowIso))).map((s) => s.keep);
    expect(await keeps('2026-10-31T00:00:00Z')).toEqual([true, true, true]);
    expect(await keeps('2026-11-02T00:00:00Z')).toEqual([false, true, true]);
    expect(await applyRetention(root, { keepSessions: 0, maxRecordings: null }, null, () => Date.parse('2026-11-02T00:00:00Z'))).toEqual(['2026-10-01T00-00-00Z']);
  });
});
