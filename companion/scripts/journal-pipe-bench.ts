/**
 * C16.2 bench, not run by CI (3 minutes a run, Windows, 32-bit PowerShell): the spike's interleaved run against the real
 * journal pipe worker. Starts the worker (`src/witness/journal-pipe.ts`, from source on a worker thread) on a pipe of its
 * own, runs `vpx-hook/spike/journal-pipe-bench.ps1` (the real castcade.vbs in MSScriptControl, every call timed: a journal
 * line through the pipe, a line appended to a held 400 KB file, FileExists on an existing and on a missing file, a no-op),
 * then prints the distribution of each and checks that the worker wrote every piped line, in order.
 *
 *   npx tsx companion/scripts/journal-pipe-bench.ts [--cycles 9000] [--pace 20] [--label run1] [--keep]
 *
 * Everything lives in a temporary folder on the system drive (the same volume as %LOCALAPPDATA%); never the player's
 * journals or `\\.\pipe\castcade-journal`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startJournalPipe } from '../src/witness/journal-pipe.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const cycles = Number(arg('cycles', '9000'));
const pace = Number(arg('pace', '20'));
const label = arg('label', 'run');
const keep = process.argv.includes('--keep');

const repo = fileURLToPath(new URL('../../', import.meta.url));
const lib = join(repo, 'vpx-hook', 'castcade.vbs');
const ps1 = join(repo, 'vpx-hook', 'spike', 'journal-pipe-bench.ps1');
const ps32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;

const root = mkdtempSync(join(tmpdir(), `castcade-pipe-bench-${label}-`));
const journals = join(root, 'Castcade', 'journal');
const csv = join(root, `${label}.csv`);
const pipeName = `\\\\.\\pipe\\castcade-bench-${process.pid}`;

const logs: string[] = [];
const pipe = startJournalPipe({
  journalDir: journals,
  pipeName,
  workerUrl: new URL('../src/witness/journal-pipe-worker.ts', import.meta.url),
  execArgv: ['--import', tsx],
  log: { info: (l) => logs.push(l), warn: (l) => logs.push(`WARN ${l}`), error: (l) => logs.push(`ERROR ${l}`) },
});

const stats = (name: string, us: number[]): string => {
  const s = [...us].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]! / 1000;
  const over = (ms: number): number => us.filter((v) => v >= ms * 1000).length;
  return `${name.padEnd(8)} n=${us.length} median=${q(0.5).toFixed(3)}ms p99=${q(0.99).toFixed(3)}ms p99.9=${q(0.999).toFixed(3)}ms >=5ms:${over(5)} >=50ms:${over(50)} >=200ms:${over(200)} max=${(s.at(-1)! / 1000).toFixed(1)}ms`;
};

async function main(): Promise<number> {
  if (!(await pipe.ready(15_000))) throw new Error(`the worker did not listen: ${logs.join(' | ')}`);
  console.log(`${label}: ${cycles} cycles every ${pace} ms (about ${Math.round((cycles * pace) / 60_000)} min); worker on ${pipeName}; folder ${root}`);
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(ps32, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Lib', lib, '-Pipe', pipeName, '-Root', root, '-Csv', csv, '-Cycles', String(cycles), '-PaceMs', String(pace)], {
      env: { ...process.env, LOCALAPPDATA: root },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', resolve);
  });
  if (code !== 0) throw new Error(`the bench script failed (exit ${code})`);
  const rows = readFileSync(csv, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',').map(Number));
  const col = (k: number): number[] => rows.map((r) => r[k]!);
  const report = [stats('pipe', col(2)), stats('file', col(3)), stats('exists', col(4)), stats('missing', col(5)), stats('noop', col(6))];
  const fileStalls = rows.filter((r) => r[3]! >= 50_000);
  report.push(`file writes >= 50 ms: ${fileStalls.length}; in those cycles the pipe write took >= 5 ms ${fileStalls.filter((r) => r[2]! >= 5_000).length} times`);
  // Every piped line in the journal file the worker wrote, in order.
  await pipe.drain(join(journals, 'journal_pipe_bench.jsonl'));
  const got = readFileSync(join(journals, 'journal_pipe_bench.jsonl'), 'latin1')
    .split('\r\n')
    .filter((l) => l.includes('"event":"bench"'))
    .map((l) => (JSON.parse(l) as { i: number }).i);
  const inOrder = got.every((v, k) => v === k);
  report.push(`journal: ${got.length} of ${rows.length} piped lines written by the worker, ${inOrder ? 'in order' : 'OUT OF ORDER'}`);
  report.push(...logs.filter((l) => l.startsWith('WARN') || l.startsWith('ERROR')));
  console.log(report.join('\n'));
  return got.length === rows.length && inOrder ? 0 : 1;
}

main()
  .then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  )
  .finally(async () => {
    await pipe.stop(2_000);
    if (!keep) rmSync(root, { recursive: true, force: true });
  });
