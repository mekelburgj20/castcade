import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectLogBundle, JOURNAL_MAX_FILES, LOG_FILE_MAX_BYTES, tarArchive, tarName } from './log-bundle.js';

/** The names and sizes in a ustar archive, checking each header as ArcAid's `looksLikeTar` does (magic + checksum). */
function listTar(tar: Uint8Array): Array<{ name: string; size: number; text: string }> {
  const out: Array<{ name: string; size: number; text: string }> = [];
  const field = (at: number, len: number): string => {
    const raw = new TextDecoder().decode(tar.subarray(at, at + len));
    const end = raw.indexOf('\0');
    return end < 0 ? raw : raw.slice(0, end);
  };
  let at = 0;
  while (at + 512 <= tar.length && tar[at] !== 0) {
    expect(field(at + 257, 6)).toBe('ustar');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : tar[at + i]!;
    expect(parseInt(field(at + 148, 8).trim(), 8)).toBe(sum);
    const size = parseInt(field(at + 124, 12), 8);
    out.push({ name: field(at, 100), size, text: new TextDecoder().decode(tar.subarray(at + 512, at + 512 + size)) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  expect(tar.length % 512).toBe(0);
  expect(tar.subarray(at).every((b) => b === 0)).toBe(true);
  expect(tar.length - at).toBeGreaterThanOrEqual(1024);
  return out;
}

describe('log-bundle (E8, ArcAid W99)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'castcade-logs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('tarArchive: ustar headers with a valid checksum, data padded to 512, two zero blocks at the end', () => {
    const tar = tarArchive([
      { name: 'a.txt', data: new TextEncoder().encode('hello'), mtimeMs: 1_700_000_000_000 },
      { name: 'dir/b.log', data: new Uint8Array(513).fill(65), mtimeMs: 0 },
    ]);
    expect(listTar(tar).map((e) => [e.name, e.size])).toEqual([
      ['a.txt', 5],
      ['dir/b.log', 513],
    ]);
    expect(tar.length).toBe(512 + 512 + 512 + 1024 + 1024);
    expect(listTar(tarArchive([]))).toEqual([]);
  });

  it('tarName: ASCII only, forward slashes, at most 100 bytes (the end is kept)', () => {
    expect(tarName('journal\\Jäws (50th).jsonl')).toBe('journal/J_ws__50th_.jsonl');
    expect(tarName(`journal/${'x'.repeat(200)}.jsonl`)).toHaveLength(100);
    expect(tarName(`journal/${'x'.repeat(200)}.jsonl`).endsWith('.jsonl')).toBe(true);
  });

  it('collectLogBundle: the allow-list only, the newest report and journals, tails of long files, a manifest first; never settings', async () => {
    const logs = join(dir, 'roaming', 'logs');
    const local = join(dir, 'local', 'logs');
    const journals = join(dir, 'local', 'journal');
    for (const d of [logs, local, journals]) mkdirSync(d, { recursive: true });
    writeFileSync(join(dir, 'roaming', 'settings.json'), '{"token":"SECRET"}');
    writeFileSync(join(logs, 'companion.log'), 'x'.repeat(LOG_FILE_MAX_BYTES) + 'THE END');
    writeFileSync(join(logs, 'companion.log.1'), 'older\n');
    writeFileSync(join(logs, 'frames-secret.bin'), 'not on the list');
    writeFileSync(join(local, 'vr-layer.log'), 'layer\n');
    const at = (file: string, sec: number): void => utimesSync(file, sec, sec);
    for (const [n, t] of [['vr-report-2026-11-01-000000', 100], ['vr-report-2026-11-13-000000', 200]] as const) {
      for (const ext of ['.md', '.json']) {
        writeFileSync(join(logs, n + ext), n);
        at(join(logs, n + ext), t);
      }
    }
    for (let i = 0; i < JOURNAL_MAX_FILES + 2; i++) {
      writeFileSync(join(journals, `table_${i}.jsonl`), `{"n":${i}}\n`);
      at(join(journals, `table_${i}.jsonl`), 1000 + i);
    }
    writeFileSync(join(journals, 'notes.txt'), 'not a journal');

    const b = await collectLogBundle({
      companionLog: join(logs, 'companion.log'),
      layerLog: join(local, 'vr-layer.log'),
      journalDir: journals,
      about: ['castcade 0.2.41 protocol 5', 'device KROBS-PC (dev-2)'],
      now: () => Date.UTC(2026, 10, 14, 7, 0, 0),
    });
    const entries = listTar(b.tar);
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.txt',
      'companion.log',
      'companion.log.1',
      'vr-layer.log',
      'vr-report/vr-report-2026-11-13-000000.md',
      'vr-report/vr-report-2026-11-13-000000.json',
      ...Array.from({ length: JOURNAL_MAX_FILES }, (_, i) => `journal/table_${JOURNAL_MAX_FILES + 1 - i}.jsonl`),
    ]);
    const companion = entries[1]!;
    expect(companion.size).toBe(LOG_FILE_MAX_BYTES);
    expect(companion.text.endsWith('THE END')).toBe(true);
    expect(b.files[0]).toEqual({ name: 'companion.log', bytes: LOG_FILE_MAX_BYTES, tail: true });
    const manifest = entries[0]!.text;
    expect(manifest).toContain('made 2026-11-14T07:00:00.000Z');
    expect(manifest).toContain('device KROBS-PC (dev-2)');
    expect(manifest).toContain(`companion.log  ${LOG_FILE_MAX_BYTES} bytes  (the end of a longer file)`);
    expect(new TextDecoder().decode(b.tar)).not.toContain('SECRET');
  });

  it('collectLogBundle: a rig with nothing but its log (no VR layer, no journals) still answers', async () => {
    writeFileSync(join(dir, 'companion.log'), 'one line\n');
    const b = await collectLogBundle({ companionLog: join(dir, 'companion.log'), layerLog: null, journalDir: join(dir, 'missing'), about: [] });
    expect(listTar(b.tar).map((e) => e.name)).toEqual(['manifest.txt', 'companion.log']);
  });
});
