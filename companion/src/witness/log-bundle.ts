/**
 * E8 (2026-11-13): this rig's logs as one archive for ArcAid's log pull (ArcAid ADR 0040, W99: a player asks for a
 * paired device's logs from Account Settings; the request id rides the heartbeat answer; the device answers with one
 * `POST /api/witness/logs`). The server takes ONE uncompressed POSIX ustar archive of at most 16 MB and checks the
 * `ustar` magic and the first header's checksum, so the archive is written here, by hand, as the cabinet does.
 *
 * What goes in is a fixed allow-list, never a folder walk: `manifest.txt`, `companion.log` (+ `.1`), `vr-layer.log`
 * (+ `.1`), the newest VR report (`.md` + `.json`) and the newest table journals. Never `settings.json` (the device
 * token), `media.json` (a TURN credential), a table, a ROM or a `.nv` file. A file over its cap gives its TAIL (the
 * newest lines are the ones wanted); the whole archive stays under `LOG_BUNDLE_MAX_BYTES`.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Under ArcAid's `WITNESS_LOG_MAX_BYTES` (16 MiB) with room for headers. */
export const LOG_BUNDLE_MAX_BYTES = 12 * 1024 * 1024;
/** The two rotating logs are 1 MB each by their own writers; a little over, for a line that crossed the limit. */
export const LOG_FILE_MAX_BYTES = 1_200_000;
/** One journal's tail, and how many of the newest go in. */
export const JOURNAL_MAX_BYTES = 1_000_000;
export const JOURNAL_MAX_FILES = 6;

export interface TarEntry {
  /** Path inside the archive: ASCII, forward slashes, at most 100 bytes. */
  name: string;
  data: Uint8Array;
  /** Modification time, ms since the epoch. */
  mtimeMs: number;
}

const BLOCK = 512;

/** A name safe for a ustar header: ASCII letters, digits, `._-/`, anything else `_`, cut to 100 bytes from the right. */
export function tarName(name: string): string {
  const clean = name.replace(/\\/g, '/').replace(/[^A-Za-z0-9._\-/]/g, '_');
  return clean.length <= 100 ? clean : clean.slice(clean.length - 100);
}

function header(e: TarEntry): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (text: string, at: number): void => {
    for (let i = 0; i < text.length; i++) h[at + i] = text.charCodeAt(i) & 0x7f;
  };
  const octal = (n: number, width: number): string => Math.max(0, Math.floor(n)).toString(8).padStart(width - 1, '0').slice(-(width - 1)) + '\0';
  put(tarName(e.name), 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(e.data.length, 12), 124);
  put(octal(e.mtimeMs / 1000, 12), 136);
  put('        ', 148); // the checksum field counts as spaces while summing
  put('0', 156); // a regular file
  put('ustar\0', 257);
  put('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** One uncompressed POSIX ustar archive: each entry's header and data padded to 512, then two zero blocks. */
export function tarArchive(entries: readonly TarEntry[]): Uint8Array {
  const padded = (n: number): number => Math.ceil(n / BLOCK) * BLOCK;
  const out = new Uint8Array(entries.reduce((n, e) => n + BLOCK + padded(e.data.length), 0) + 2 * BLOCK);
  let at = 0;
  for (const e of entries) {
    out.set(header(e), at);
    out.set(e.data, at + BLOCK);
    at += BLOCK + padded(e.data.length);
  }
  return out;
}

export interface LogBundleSources {
  /** `<userData>/logs/companion.log`; its folder also holds `companion.log.1` and the VR reports. */
  companionLog: string;
  /** `%LOCALAPPDATA%\Castcade\logs\vr-layer.log`, or null when the environment has no LOCALAPPDATA. */
  layerLog: string | null;
  /** `%LOCALAPPDATA%\Castcade\journal`, or null. */
  journalDir: string | null;
  /** Lines for `manifest.txt` (the app version, the device label; never the token). */
  about: string[];
  now?: () => number;
}

export interface LogBundle {
  tar: Uint8Array;
  /** What went in: archive name, bytes sent, and whether it is only the file's tail. */
  files: Array<{ name: string; bytes: number; tail: boolean }>;
}

async function tailOf(path: string, max: number): Promise<{ data: Uint8Array; mtimeMs: number; tail: boolean } | null> {
  try {
    const [buf, st] = await Promise.all([readFile(path), stat(path)]);
    const tail = buf.length > max;
    return { data: tail ? buf.subarray(buf.length - max) : buf, mtimeMs: st.mtimeMs, tail };
  } catch {
    return null; // not there (no VR layer on this rig, no rotation yet): simply not in the bundle
  }
}

/** The newest `count` files in `dir` whose name passes `pick`, newest first. */
async function newest(dir: string, pick: (name: string) => boolean, count: number): Promise<string[]> {
  try {
    const names = (await readdir(dir)).filter(pick);
    const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
    return dated.sort((a, b) => b.t - a.t).slice(0, count).map((d) => d.n);
  } catch {
    return [];
  }
}

/** Read the allow-list and write the archive. Never throws for a missing file; an empty rig still sends its manifest. */
export async function collectLogBundle(src: LogBundleSources): Promise<LogBundle> {
  const now = src.now ?? Date.now;
  const logsDir = join(src.companionLog, '..');
  const wanted: Array<{ name: string; path: string; max: number }> = [
    { name: 'companion.log', path: src.companionLog, max: LOG_FILE_MAX_BYTES },
    { name: 'companion.log.1', path: `${src.companionLog}.1`, max: LOG_FILE_MAX_BYTES },
  ];
  if (src.layerLog) {
    wanted.push({ name: 'vr-layer.log', path: src.layerLog, max: LOG_FILE_MAX_BYTES }, { name: 'vr-layer.log.1', path: `${src.layerLog}.1`, max: LOG_FILE_MAX_BYTES });
  }
  for (const ext of ['.md', '.json']) {
    for (const n of await newest(logsDir, (f) => /^vr-report-[\d-]+/.test(f) && f.endsWith(ext), 1)) wanted.push({ name: `vr-report/${n}`, path: join(logsDir, n), max: LOG_FILE_MAX_BYTES });
  }
  if (src.journalDir) {
    for (const n of await newest(src.journalDir, (f) => f.endsWith('.jsonl'), JOURNAL_MAX_FILES)) wanted.push({ name: `journal/${n}`, path: join(src.journalDir, n), max: JOURNAL_MAX_BYTES });
  }
  const entries: TarEntry[] = [];
  const files: LogBundle['files'] = [];
  let total = 0;
  for (const w of wanted) {
    const f = await tailOf(w.path, w.max);
    if (!f || total + f.data.length > LOG_BUNDLE_MAX_BYTES) continue;
    total += f.data.length;
    entries.push({ name: w.name, data: f.data, mtimeMs: f.mtimeMs });
    files.push({ name: tarName(w.name), bytes: f.data.length, tail: f.tail });
  }
  const manifest = [
    'Castcade log bundle',
    `made ${new Date(now()).toISOString()}`,
    ...src.about,
    '',
    ...files.map((f) => `${f.name}  ${f.bytes} bytes${f.tail ? '  (the end of a longer file)' : ''}`),
    '',
  ].join('\n');
  entries.unshift({ name: 'manifest.txt', data: new TextEncoder().encode(manifest), mtimeMs: now() });
  return { tar: tarArchive(entries), files };
}
