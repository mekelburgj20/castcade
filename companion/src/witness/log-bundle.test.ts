import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectLogBundle, JOURNAL_MAX_BYTES, JOURNAL_MAX_FILES, LOG_FILE_MAX_BYTES, maskIniSecrets, tarArchive, tarName, VPX_LOG_MAX_BYTES } from './log-bundle.js';

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

  it("E8.4: VPX's ini, log and crash report and the fork's stream logs go in; the ini's secrets and crash.dmp do not", async () => {
    const logs = join(dir, 'roaming', 'logs');
    const exeDir = join(dir, 'vpx');
    const prefDir = join(dir, 'appdata', 'VPinballX');
    const journals = join(dir, 'local', 'journal');
    for (const d of [logs, exeDir, prefDir, journals]) mkdirSync(d, { recursive: true });
    const at = (file: string, sec: number): void => utimesSync(file, sec, sec);
    writeFileSync(join(logs, 'companion.log'), 'app\n');
    writeFileSync(join(logs, 'vpx-stream-match.log'), 'x'.repeat(VPX_LOG_MAX_BYTES) + 'MATCH END');
    writeFileSync(join(logs, 'vpx-stream-watch.log'), 'watch\n');
    writeFileSync(join(logs, 'vpx-stream-notes.txt'), 'not a stream log');
    at(join(logs, 'vpx-stream-match.log'), 300);
    at(join(logs, 'vpx-stream-watch.log'), 200);
    // latin1 bytes outside the masked lines come through untouched
    writeFileSync(join(exeDir, 'VPinballX.ini'), Buffer.from('[Player]\r\nLFlipKey = 42\r\nName = caf\xe9\r\n[Plugin.X]\r\nApiKey = SECRET1\r\n password=SECRET2\r\n; token = a comment\r\n', 'latin1'));
    // the copy VPX wrote last wins, wherever it was started from
    writeFileSync(join(exeDir, 'vpinball.log'), 'old log\n');
    writeFileSync(join(prefDir, 'vpinball.log'), 'new log\n');
    at(join(exeDir, 'vpinball.log'), 100);
    at(join(prefDir, 'vpinball.log'), 500);
    writeFileSync(join(exeDir, 'crash.txt'), 'Crash report\n');
    writeFileSync(join(exeDir, 'crash.dmp'), 'MEMORYIMAGE');
    writeFileSync(join(journals, 'table.jsonl'), '{}\n');

    const b = await collectLogBundle({
      companionLog: join(logs, 'companion.log'),
      layerLog: null,
      journalDir: journals,
      vpxIni: join(exeDir, 'VPinballX.ini'),
      vpxDirs: [exeDir, prefDir, join(dir, 'missing')],
      about: [],
    });
    const entries = listTar(b.tar);
    expect(entries.map((e) => e.name)).toEqual(['manifest.txt', 'vpx/VPinballX.ini', 'vpx/crash.txt', 'companion.log', 'vpx/vpinball.log', 'vpx-stream-match.log', 'vpx-stream-watch.log', 'journal/table.jsonl']);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const iniAt = Buffer.from(b.tar).indexOf('[Player]');
    const ini = Buffer.from(b.tar.subarray(iniAt, iniAt + byName.get('vpx/VPinballX.ini')!.size)).toString('latin1');
    expect(ini).toBe('[Player]\r\nLFlipKey = 42\r\nName = caf\xe9\r\n[Plugin.X]\r\nApiKey =<removed>\r\n password=<removed>\r\n; token = a comment\r\n');
    expect(byName.get('vpx/vpinball.log')!.text).toBe('new log\n');
    const match = byName.get('vpx-stream-match.log')!;
    expect(match.size).toBe(VPX_LOG_MAX_BYTES);
    expect(match.text.endsWith('MATCH END')).toBe(true);
    const all = Buffer.from(b.tar).toString('latin1');
    for (const never of ['SECRET1', 'SECRET2', 'MEMORYIMAGE', 'not a stream log']) expect(all).not.toContain(never);
  });

  it('E8.4: maskIniSecrets blanks only the value of a key that names a secret', () => {
    expect(maskIniSecrets('LFlipKey = 42\nJoyCustom1Key=7\nAuthToken = abc\nApi_Key=k\n')).toBe('LFlipKey = 42\nJoyCustom1Key=7\nAuthToken =<removed>\nApi_Key=<removed>\n');
    expect(maskIniSecrets('[Token]\nA = 1\n')).toBe('[Token]\nA = 1\n');
  });

  it('E8.4: a file that finds no room is named in the manifest, and the journals are what gives way', async () => {
    const journals = join(dir, 'journal');
    mkdirSync(journals);
    writeFileSync(join(dir, 'companion.log'), 'app\n');
    writeFileSync(join(dir, 'VPinballX.ini'), '[Player]\n');
    // room for two journals of the three
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(journals, `t${i}.jsonl`), 'j'.repeat(JOURNAL_MAX_BYTES));
      utimesSync(join(journals, `t${i}.jsonl`), 1000 + i, 1000 + i);
    }
    const b = await collectLogBundle({ companionLog: join(dir, 'companion.log'), layerLog: null, journalDir: journals, vpxIni: join(dir, 'VPinballX.ini'), about: [], maxBytes: 2 * JOURNAL_MAX_BYTES + 1000 });
    const entries = listTar(b.tar);
    expect(entries.map((e) => e.name)).toEqual(['manifest.txt', 'vpx/VPinballX.ini', 'companion.log', 'journal/t2.jsonl', 'journal/t1.jsonl']);
    expect(entries[0]!.text).toContain('journal/t0.jsonl  left out: no room');
  });
});
