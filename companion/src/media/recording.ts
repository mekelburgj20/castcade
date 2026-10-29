/**
 * D1.2: local recordings (`docs/design/solo-streaming-and-recording.md` §2, §4). One folder per session under the
 * recordings directory: `seg-001.mp4`, `seg-002.mp4`, … (a new segment each time the capture starts: a table opened,
 * the capture restarted after a loss) and `manifest.jsonl`, one JSON line per event.
 *
 * The manifest is hash-chained: every line carries `prev`, the sha256 of the previous line's text (64 zeros for the
 * first), so an edit, a removal or a reorder anywhere breaks every later link. A closed segment's line holds the MP4's
 * own sha256 and size; a posted score's line names the segment that was recording when it posted. That is what "tied
 * to posted scores" means here; sending the recording's hash with the score is a later ArcAid step.
 *
 * Retention: keep the newest N sessions (default 3) and, optionally, cap the number of MP4s kept; a session holding a
 * score marked Sanctioned is never pruned by either rule (owner ruling 2026-10-25; "until its tournament closes" needs
 * the close date from ArcAid, a later item).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type ManifestEntry =
  | { kind: 'session_start'; app: string; preset: string; streaming: boolean; recording: boolean }
  | { kind: 'segment_start'; file: string; table: string | null; picture: { width: number; height: number } }
  | { kind: 'segment_end'; file: string; sha256: string | null; bytes: number; reason: string }
  | { kind: 'game_start'; table: string; segment: string | null }
  | { kind: 'game_end'; table: string; scores: (number | null)[]; segment: string | null }
  | {
      kind: 'score_posted';
      table: string;
      score: number | null;
      outcome: string;
      mode: string | null;
      segment: string | null;
      /** Set once ArcAid says the score went to a Sanctioned tournament; such a session is never pruned. */
      sanctioned?: boolean;
    }
  /** The capture was covered (VPX not in front, D1.9) / uncovered; a segment's covered stretches show no table. */
  | { kind: 'cover_start'; reason: string; segment: string | null }
  | { kind: 'cover_end'; segment: string | null }
  | { kind: 'session_end'; reason: string };

export type ManifestLine = ManifestEntry & { seq: number; at: string; prev: string };

export const GENESIS = '0'.repeat(64);
export const MANIFEST = 'manifest.jsonl';

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** One manifest line's text and its hash (what the next line's `prev` must be). */
export function chainLine(entry: ManifestEntry, seq: number, at: string, prev: string): { text: string; hash: string } {
  const text = JSON.stringify({ seq, at, prev, ...entry });
  return { text, hash: sha256Hex(text) };
}

/** Check a manifest's chain: `ok` false names the first line (1-based) whose `prev` or `seq` does not follow. */
export function verifyManifest(text: string): { ok: boolean; lines: number; badAt?: number } {
  const rows = text.split('\n').filter((l) => l.length > 0);
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let parsed: { prev?: unknown; seq?: unknown };
    try {
      parsed = JSON.parse(row) as { prev?: unknown; seq?: unknown };
    } catch {
      return { ok: false, lines: rows.length, badAt: i + 1 };
    }
    if (parsed.prev !== prev || parsed.seq !== i + 1) return { ok: false, lines: rows.length, badAt: i + 1 };
    prev = sha256Hex(row);
  }
  return { ok: true, lines: rows.length };
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** `2026-10-28T07:01:41.476Z` → `2026-10-28T07-01-41Z`: sortable, and a valid Windows folder name. */
export function sessionIdFor(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

export class RecordingSession {
  private seq = 0;
  private prev = GENESIS;
  private segIndex = 0;
  private current: string | null = null;
  /** Appends run one at a time, in order, so the chain never forks. */
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    readonly id: string,
    readonly dir: string,
    private readonly now: () => number,
  ) {}

  /** A new session folder (the id gets `-2`, `-3` if a session started in the same second). */
  static async open(root: string, now: () => number): Promise<RecordingSession> {
    await mkdir(root, { recursive: true });
    const base = sessionIdFor(now());
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      const dir = join(root, id);
      try {
        await mkdir(dir);
        return new RecordingSession(id, dir, now);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  }

  /** The segment being written, as its file name; null between segments. */
  get segment(): string | null {
    return this.current;
  }

  append(entry: ManifestEntry): Promise<void> {
    const run = async (): Promise<void> => {
      const { text, hash } = chainLine(entry, this.seq + 1, new Date(this.now()).toISOString(), this.prev);
      await appendFile(join(this.dir, MANIFEST), `${text}\n`);
      this.seq += 1;
      this.prev = hash;
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** Start the next segment: its absolute path for ffmpeg. */
  async startSegment(table: string | null, picture: { width: number; height: number }): Promise<string> {
    this.segIndex += 1;
    const file = `seg-${String(this.segIndex).padStart(3, '0')}.mp4`;
    this.current = file;
    await this.append({ kind: 'segment_start', file, table, picture });
    return join(this.dir, file);
  }

  /** Close the current segment: hash the file ffmpeg wrote (fragmented MP4, so a killed encode still plays). */
  async endSegment(reason: string): Promise<void> {
    const file = this.current;
    if (!file) return;
    this.current = null;
    const path = join(this.dir, file);
    let bytes = 0;
    let sha: string | null = null;
    try {
      bytes = (await stat(path)).size;
      sha = await sha256File(path);
    } catch {
      // ffmpeg failed before writing: the line still says the segment ended, with no hash.
    }
    await this.append({ kind: 'segment_end', file, sha256: sha, bytes, reason });
  }

  async close(reason: string): Promise<void> {
    await this.endSegment(reason);
    await this.append({ kind: 'session_end', reason });
  }
}

export interface SessionSummary {
  id: string;
  /** MP4 files in the folder. */
  recordings: number;
  /** Holds a score marked Sanctioned: never pruned. */
  keep: boolean;
}

export async function listSessions(root: string): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const id of names.sort()) {
    const dir = join(root, id);
    let files: string[];
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      files = await readdir(dir);
    } catch {
      continue;
    }
    if (!files.includes(MANIFEST)) continue; // not ours
    let keep: boolean;
    try {
      const text = await readFile(join(dir, MANIFEST), 'utf8');
      keep = text.split('\n').some((l) => l.includes('"score_posted"') && l.includes('"sanctioned":true'));
    } catch {
      keep = false;
    }
    out.push({ id, recordings: files.filter((f) => f.endsWith('.mp4')).length, keep });
  }
  return out;
}

/**
 * Which sessions to delete, oldest first. Never the current one and never a kept (Sanctioned) one. Keep the newest
 * `keepSessions`; then, if `maxRecordings` is set, drop the oldest remaining until the MP4 count fits.
 */
export function planRetention(sessions: SessionSummary[], opts: { keepSessions: number; maxRecordings: number | null }, currentId: string | null): string[] {
  const prunable = [...sessions].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((s) => !s.keep && s.id !== currentId);
  const doomed = new Set<string>();
  const others = sessions.filter((s) => !s.keep && s.id === currentId).length; // the current counts toward N
  const keepN = Math.max(0, opts.keepSessions - others);
  prunable.slice(0, Math.max(0, prunable.length - keepN)).forEach((s) => doomed.add(s.id));
  if (opts.maxRecordings !== null) {
    let total = sessions.filter((s) => !s.keep && !doomed.has(s.id)).reduce((n, s) => n + s.recordings, 0);
    for (const s of prunable) {
      if (total <= opts.maxRecordings) break;
      if (doomed.has(s.id)) continue;
      doomed.add(s.id);
      total -= s.recordings;
    }
  }
  return prunable.filter((s) => doomed.has(s.id)).map((s) => s.id);
}

export async function applyRetention(root: string, opts: { keepSessions: number; maxRecordings: number | null }, currentId: string | null): Promise<string[]> {
  const doomed = planRetention(await listSessions(root), opts, currentId);
  for (const id of doomed) await rm(join(root, id), { recursive: true, force: true });
  return doomed;
}
