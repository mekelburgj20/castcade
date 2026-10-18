/**
 * Rebuild the NVRAM buffer a Castcade journal (`vpx-hook`, recipe A) describes: `nvram_full`
 * lines replace the buffer, `nvram_delta` lines patch it. Delta triples are `[index, new, old]`
 * (the order `vpx-hook/spike/tail-journal.py` applies: `for off, new, _old in e["d"]`). The
 * resulting buffer decodes exactly like the on-disk `.nv` (Phase 0: same indexing, offset 0).
 *
 * Used by the fixture tests today and by live mode (Phase 3) tomorrow; it does no I/O except in
 * `readJournalLines`, which is a convenience for tests and tooling.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export interface JournalReplay {
  table: string | null;
  rom: string | null;
  recipe: string | null;
  buffer: Uint8Array | null;
  fulls: number;
  deltas: number;
  /** Lines that were not JSON (a torn last line when VPX was killed is normal). */
  torn: number;
}

interface JournalLine {
  event?: unknown;
  table?: unknown;
  rom?: unknown;
  recipe?: unknown;
  bytes?: unknown;
  d?: unknown;
}

export function replayJournal(lines: Iterable<string>): JournalReplay {
  const out: JournalReplay = { table: null, rom: null, recipe: null, buffer: null, fulls: 0, deltas: 0, torn: 0 };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: JournalLine;
    try {
      e = JSON.parse(line) as JournalLine;
    } catch {
      out.torn++;
      continue;
    }
    switch (e.event) {
      case 'table_loaded':
        out.table = typeof e.table === 'string' ? e.table : null;
        out.rom = typeof e.rom === 'string' ? e.rom : null;
        out.recipe = typeof e.recipe === 'string' ? e.recipe : null;
        break;
      case 'nvram_full':
        if (Array.isArray(e.bytes)) {
          out.buffer = Uint8Array.from(e.bytes, (x) => Number(x) & 0xff);
          out.fulls++;
        }
        break;
      case 'nvram_delta':
        if (out.buffer && Array.isArray(e.d)) {
          for (const triple of e.d) {
            if (!Array.isArray(triple)) continue;
            const index = Number(triple[0]);
            const next = Number(triple[1]);
            if (index >= 0 && index < out.buffer.length) out.buffer[index] = next & 0xff;
          }
          out.deltas++;
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/** Read a `.jsonl` or `.jsonl.gz` journal into lines (synchronous; tests and tooling only). */
export function readJournalLines(path: string): string[] {
  let data = readFileSync(path);
  if (path.endsWith('.gz')) data = gunzipSync(data);
  return data.toString('utf8').split('\n');
}
