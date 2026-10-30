/**
 * B18: find the hook journal a running VPX process is writing, for a Castcade started while the player window
 * was already up (the title `Visual Pinball Player` names no table; rig 2026-10-30T03:49Z). The journal of
 * the table in play is the newest one whose `table_loaded` falls inside the process's lifetime.
 */
import { isNotFound, type WitnessFs } from './fs.js';

export interface JournalCandidate {
  /** The file's base name without `.jsonl`: the hook's safe name, lossy (spaces → `_`, punctuation dropped). */
  tableId: string;
  /** The `table` field of the last `table_loaded`: the table id the patch was rendered for, unsanitised. */
  table: string | null;
  path: string;
  sessionStamp: string | null;
  stampMs: number | null;
  mtimeMs: number;
}

/** The hook's `session` stamp (`Castcade_Stamp`, local time `yyyy-mm-ddThh:mm:ss`) as epoch ms, or null when unparseable. */
export function parseSessionStamp(stamp: string | null): number | null {
  if (!stamp) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

function joinPath(dir: string, name: string): string {
  const sepChar = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sepChar + name;
}

/** The last `table_loaded` line of a journal's text; torn or non-JSON lines are skipped. */
function lastTableLoaded(text: string): { table: string | null; session: string | null } | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.includes('table_loaded')) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    if (o['event'] !== 'table_loaded') continue;
    return { table: typeof o['table'] === 'string' ? o['table'] : null, session: typeof o['session'] === 'string' ? o['session'] : null };
  }
  return null;
}

/**
 * The newest journal in `dir` whose last `table_loaded` is at or after `sinceMs` (an unparseable stamp is
 * allowed, as `onJournalEvent` allows it). Files last written before `sinceMs` are never opened. Null when
 * the directory is missing or nothing qualifies.
 */
export async function newestJournalSince(fs: WitnessFs, dir: string, sinceMs: number): Promise<JournalCandidate | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  let best: JournalCandidate | null = null;
  for (const name of names) {
    if (!/\.jsonl$/i.test(name)) continue;
    const path = joinPath(dir, name);
    const st = await fs.stat(path).catch(() => null);
    if (!st || st.mtimeMs < sinceMs) continue;
    // The whole file: since hook 0.3.0 a session is a few lines per score change, hundreds of KB at most.
    const text = await fs.readFile(path).then((b) => new TextDecoder().decode(b)).catch(() => null);
    if (text === null) continue;
    const loaded = lastTableLoaded(text);
    if (!loaded) continue;
    const stampMs = parseSessionStamp(loaded.session);
    if (stampMs !== null && stampMs < sinceMs) continue;
    const c: JournalCandidate = { tableId: name.replace(/\.jsonl$/i, ''), table: loaded.table, path, sessionStamp: loaded.session, stampMs, mtimeMs: st.mtimeMs };
    if (!best || newer(c, best)) best = c;
  }
  return best;
}

/** Greater session stamp wins; a tie, or a missing stamp on either side, goes to the later write. */
function newer(a: JournalCandidate, b: JournalCandidate): boolean {
  if (a.stampMs !== null && b.stampMs !== null && a.stampMs !== b.stampMs) return a.stampMs > b.stampMs;
  return a.mtimeMs > b.mtimeMs;
}
