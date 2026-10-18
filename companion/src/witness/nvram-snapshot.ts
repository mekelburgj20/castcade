/**
 * Snapshots of the VPinMAME nvram directory, and the wait for the `.nv` VPinMAME rewrites when a
 * table closes. Basic mode has no hook inside VPX, so "which ROM did this session run" is
 * answered by diffing the directory: the `.nv` whose size or mtime changed (or that appeared) is
 * the ROM, and its bytes before the session are what a decoded "no new game" is compared against.
 */
import { realClock, type Clock } from '../match/clock.js';
import { isNotFound, type WitnessFs } from './fs.js';

export interface NvFileSnapshot {
  name: string;
  size: number;
  mtimeMs: number;
  /** File contents when the snapshot was taken with `readBytes`, else null. */
  bytes: Uint8Array | null;
}

export type NvSnapshot = Map<string, NvFileSnapshot>;

export interface SnapshotOptions {
  /** Read each file's contents (launch-time snapshot). Files larger than `maxBytes` are not read. */
  readBytes?: boolean;
  maxBytes?: number;
}

export const DEFAULT_MAX_NV_BYTES = 1 << 20;

export function isNvName(name: string): boolean {
  return /\.nv$/i.test(name);
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/** Stat (and optionally read) every `.nv` in `dir`. A missing directory is an empty snapshot. */
export async function snapshotNvFiles(fs: WitnessFs, dir: string, opts: SnapshotOptions = {}): Promise<NvSnapshot> {
  const snap: NvSnapshot = new Map();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return snap;
    throw err;
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_NV_BYTES;
  for (const name of names) {
    if (!isNvName(name)) continue;
    const path = joinPath(dir, name);
    try {
      const st = await fs.stat(path);
      let bytes: Uint8Array | null = null;
      if (opts.readBytes && st.size <= maxBytes) bytes = await fs.readFile(path);
      snap.set(name, { name, size: st.size, mtimeMs: st.mtimeMs, bytes });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // Deleted between readdir and stat: not part of the snapshot.
    }
  }
  return snap;
}

/** Names present in `after` that are new or whose size/mtime differ from `before`, newest first. */
export function changedNvFiles(before: NvSnapshot, after: NvSnapshot): string[] {
  const changed: NvFileSnapshot[] = [];
  for (const [name, now] of after) {
    const was = before.get(name);
    if (!was || was.size !== now.size || was.mtimeMs !== now.mtimeMs) changed.push(now);
  }
  return changed.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.name);
}

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}

export interface WaitForNvChangeOptions {
  clock?: Clock;
  /** How long to keep polling after the exit before giving up (VPinMAME writes within ~1 s). */
  timeoutMs?: number;
  pollMs?: number;
}

export interface NvChange {
  changed: string[];
  after: NvSnapshot;
}

export const DEFAULT_NV_SETTLE_MS = 5_000;
export const DEFAULT_NV_POLL_MS = 500;

/** Poll the directory until some `.nv` differs from `before`, or the timeout passes. */
export async function waitForNvChange(fs: WitnessFs, dir: string, before: NvSnapshot, opts: WaitForNvChangeOptions = {}): Promise<NvChange> {
  const clock = opts.clock ?? realClock;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_NV_SETTLE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_NV_POLL_MS;
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const after = await snapshotNvFiles(fs, dir);
    const changed = changedNvFiles(before, after);
    if (changed.length > 0 || clock.now() >= deadline) return { changed, after };
    await sleep(clock, Math.min(pollMs, Math.max(1, deadline - clock.now())));
  }
}
