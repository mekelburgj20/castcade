/**
 * Live validation of an original (no-ROM) table's Castcade patch (WORK C1.4): launch VPX unattended on a STAGED copy
 * of the table with a freshly rendered sidecar, let a game drain to game over, and judge the hook's journal:
 * `table_loaded`, `game_start`, N `ball_end` in order, `game_end`. Run from the repo root:
 *
 *   npm run validate-original -w companion -- "<table.vpx>"            one table
 *   npm run validate-original -w companion -- --all "<tables folder>"  every original in the folder, one after another
 *
 * Options:
 *   --balls N          ball ends the game must journal before its game end (default 3)
 *   --minutes M        time budget for one game (default 8)
 *   --load-seconds S   how long to wait for table_loaded (default 180)
 *   --vpx-dir DIR      the VPX install (default C:\Users\mekel\Documents\Emulators\VPX\VisualPinballX)
 *   --exe NAME         the build to launch, inside --vpx-dir (default VPinballX_GL64.exe; VPinballX64.exe = desktop)
 *   --only TEXT        with --all: only tables whose file name contains TEXT; several, separated by "|" ("Diablo 2|SMGP")
 *   --mute             PlayMusic = 0 / PlaySound = 0 in the ini copy
 *   --also 156,57      extra scancodes pressed with every plunge (default: the ini's LockbarKey; "none" for none)
 *   --in-place         do not stage: launch the table where it is, with the sidecar Castcade already wrote beside it
 *   --allow-companion  run although Castcade is running (it will treat the run as a real game and may post its score)
 *   --dry-run          render, lint and compile the sidecar, print the plan, launch nothing, copy no table
 *   --journal FILE     judge an existing journal file and exit (no VPX)
 *
 * What it touches: `tmp/validate/` in this repo (gitignored: the staged .vpx copy, its sidecar, an ini copy, the
 * results) and the journal under %LOCALAPPDATA%\Castcade\journal (the staged run journals as `validate-<table>`, so it
 * never mixes with the table's real journal). Nothing is written to the tables folder or the VPX install: the keys are
 * set in a COPY of VPinballX.ini handed to VPX with -Ini, and `castcade.vbs` must already be in <vpx>\scripts (the
 * companion installs it; the runner checks its version and stops when it is missing or old).
 *
 * VPX reads the keyboard through DirectInput, so its player window must stay in the foreground for the whole run:
 * do not use the machine meanwhile. With a headset connected the GL build plays in VR; the run works the same.
 *
 * What the runner does beyond credit, Start and the plunger:
 * - it stages, beside the copy, the folders beside the original that the script loads from (a FlexDMD / UltraDMD
 *   project: without it Game of Thrones, Sonic, Thundercats and The Goonies stop at a dialog before any key arrives);
 * - it presses Start again while the journal shows no game start (a table still booting ignores the first press);
 * - it follows the per-table hints in `validate-hints.ts` (a second Start for a menu the first one opens, a longer
 *   budget): data, one record per table family, each with its evidence.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyScript } from '../src/patcher/classify.js';
import { libraryVersionOf, listVpxFiles, patchSource } from '../src/patcher/import.js';
import { recipeFor, renderSidecar } from '../src/patcher/render-originals.js';
import { LIB_VERSION, isOurSidecar } from '../src/patcher/render.js';
import { decodeScript } from '../src/patcher/script-text.js';
import { checkGameJournal, lintSidecar, resourceFolders, type JournalCheck } from '../src/patcher/validate.js';
import { nodeFs } from '../src/witness/fs.js';
import { readVpxScript } from '../src/witness/vpx-file.js';
import { afterStartArg, hintFor } from './validate-hints.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = join(REPO, 'tmp', 'validate');
const AUTOPLAY = join(REPO, 'vpx-hook', 'spike', 'autoplay.py');
const COMPILE = join(REPO, 'vpx-hook', 'spike', 'vbs-compile.vbs');
// The scancodes the ini copy binds and autoplay.py presses ("1", Enter, "5", Q).
const KEYS = { StartGameKey: 2, PlungerKey: 28, AddCreditKey: 6, ExitGameKey: 16 } as const;

interface Options {
  balls: number;
  minutes: number;
  loadSeconds: number;
  vpxDir: string;
  exe: string;
  only: string | null;
  mute: boolean;
  also: string | null;
  inPlace: boolean;
  allowCompanion: boolean;
  dryRun: boolean;
}

interface Result {
  table: string;
  cls: string;
  recipe: string | null;
  verdict: 'pass' | 'fail' | 'skipped' | 'dry-run';
  why: string[];
  notes: string[];
  partial: string[];
  /** Folders beside the original that are staged beside the copy (the script loads from them, or a hint names them). */
  folders: string[];
  ballEnds?: number;
  seconds?: number;
}

const log = (...a: unknown[]): void => console.log(new Date().toTimeString().slice(0, 8), ...a);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `Castcade_SafeName` in castcade.vbs: the journal's file name for a table id. */
function safeName(id: string): string {
  const r = [...id].map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : c === ' ' ? '_' : '')).join('');
  return r === '' ? 'table' : r;
}

const journalPathFor = (tableId: string): string => join(process.env['LOCALAPPDATA'] ?? '', 'Castcade', 'journal', `${safeName(tableId)}.jsonl`);

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'latin1').split(/\r?\n/).filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

function running(image: string): boolean {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'latin1' });
    return out.toLowerCase().includes(image.toLowerCase());
  } catch {
    return false;
  }
}

/** A copy of the rig's ini with the keys autoplay.py presses; returns the copy's path and the lockbar scancode in it. */
function stageIni(o: Options): { path: string; lockbar: number | null } {
  const src = join(o.vpxDir, 'VPinballX.ini');
  if (!existsSync(src)) throw new Error(`no VPinballX.ini beside the exe (${src}); pass --vpx-dir`);
  const want: Record<string, number> = { ...KEYS, ...(o.mute ? { PlayMusic: 0, PlaySound: 0 } : {}) };
  let section = '';
  let lockbar: number | null = null;
  const seen = new Set<string>();
  const out: string[] = [];
  const flush = (): void => {
    if (section.toLowerCase() !== 'player') return;
    for (const [k, v] of Object.entries(want)) if (!seen.has(k)) out.push(`${k} = ${v}`);
  };
  for (const line of readFileSync(src, 'latin1').split(/\r?\n/)) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) {
      flush();
      section = sec[1] ?? '';
      out.push(line);
      continue;
    }
    const kv = /^\s*(\w+)\s*=\s*(.*)$/.exec(line);
    if (section.toLowerCase() === 'player' && kv?.[1]) {
      if (kv[1] === 'LockbarKey' && /^\d+$/.test((kv[2] ?? '').trim())) lockbar = Number((kv[2] ?? '').trim());
      if (kv[1] in want) {
        out.push(`${kv[1]} = ${want[kv[1]]}`);
        seen.add(kv[1]);
        continue;
      }
    }
    out.push(line);
  }
  flush();
  mkdirSync(WORK, { recursive: true });
  const path = join(WORK, 'VPinballX.ini');
  writeFileSync(path, out.join('\r\n'), 'latin1');
  return { path, lockbar };
}

/** The static half: classify, render, lint, compile. Throws nothing; the result says what stops the run. */
async function prepare(vpxPath: string, o: Options): Promise<{ result: Result; sidecar?: Uint8Array; tableId: string }> {
  const table = basename(vpxPath).replace(/\.vpx$/i, '');
  const tableId = o.inPlace ? table : `validate-${table}`;
  const base: Result = { table, cls: '?', recipe: null, verdict: 'skipped', why: [], notes: [], partial: [], folders: [] };
  let script;
  try {
    script = await readVpxScript(nodeFs, vpxPath);
  } catch (err) {
    return { result: { ...base, why: [`cannot read the table: ${err instanceof Error ? err.message : String(err)}`] }, tableId };
  }
  if (!script) return { result: { ...base, why: ['no script in the table'] }, tableId };
  const text = patchSource(decodeScript(script.bytes)).text;
  const cls = classifyScript(text);
  const recipe = recipeFor(cls.cls);
  base.cls = cls.cls;
  base.recipe = recipe;
  if (!o.inPlace) {
    let beside: string[] = [];
    try {
      beside = readdirSync(dirname(vpxPath), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // an unreadable folder stages nothing
    }
    const hinted = hintFor(table).folders ?? [];
    base.folders = [...new Set([...resourceFolders(text, beside), ...beside.filter((d) => hinted.some((h) => h.toLowerCase() === d.toLowerCase()))])];
  }
  if (cls.cls === 'A') return { result: { ...base, why: ['a ROM table (recipe A): not an original'] }, tableId };
  if (recipe === null) return { result: { ...base, why: [`class ${cls.cls} has no recipe${cls.facts.reason ? ` (${cls.facts.reason})` : ''}`] }, tableId };
  const stagedVpx = join(WORK, 'tables', basename(vpxPath));
  const target = o.inPlace ? vpxPath : stagedVpx;
  const rendered = renderSidecar(text, cls, { tableId, rom: null, originalPath: target, originalSize: script.size, originalMtimeMs: script.mtimeMs, sidecarPath: target.replace(/\.vpx$/i, '.vbs') });
  base.partial = rendered.partial ?? [];
  base.notes = rendered.warnings.filter((w) => !base.partial.includes(w));
  const lint = lintSidecar(text, decodeScript(rendered.bytes));
  if (lint.length > 0) return { result: { ...base, verdict: 'fail', why: lint.map((l) => `static: ${l}`) }, tableId };
  mkdirSync(join(WORK, 'sidecars'), { recursive: true });
  const probe = join(WORK, 'sidecars', `${table}.vbs`);
  writeFileSync(probe, rendered.bytes);
  // The compile check needs the Windows Script Host; elsewhere the lint above is all a dry run can say.
  const cs = process.platform === 'win32' ? spawnSync('cscript', ['//nologo', COMPILE, probe], { encoding: 'latin1' }) : { status: 0, stdout: '', stderr: '', error: undefined };
  if (cs.status !== 0) return { result: { ...base, verdict: 'fail', why: [`static: the sidecar does not compile: ${(cs.stdout || cs.stderr || String(cs.error ?? '')).trim()}`] }, tableId };
  return { result: base, sidecar: rendered.bytes, tableId };
}

async function validateOne(vpxPath: string, o: Options): Promise<Result> {
  const { result, sidecar, tableId } = await prepare(vpxPath, o);
  if (!sidecar) return result;
  const table = result.table;
  const journal = journalPathFor(tableId);
  const stagedVpx = join(WORK, 'tables', basename(vpxPath));
  const launch = o.inPlace ? vpxPath : stagedVpx;
  const exe = join(o.vpxDir, o.exe);
  log(`${table}: class ${result.cls}, recipe ${result.recipe}${result.partial.length > 0 ? `, PARTIAL (${result.partial.join('; ')})` : ''}; sidecar lints clean and compiles`);
  for (const n of result.notes) log(`   note: ${n}`);
  const hint = hintFor(table);
  const minutes = Math.max(o.minutes, hint.minutes ?? 0);
  const settle = hint.settleSeconds ?? 8;
  const afterStart = hint.afterStart ?? [];
  for (const w of hint.why) log(`   hint: ${w}`);
  if (afterStart.length > 0) log(`   hint: after Start, ${afterStart.map((s) => `${s.key} ${s.seconds} s later`).join(', then ')}`);
  if (minutes !== o.minutes) log(`   hint: a ${minutes} minute budget`);
  if (result.folders.length > 0) log(`   ${o.dryRun ? 'would stage' : 'staging'} beside the copy: ${result.folders.join(', ')}`);
  if (o.dryRun) {
    log(`   would launch: "${exe}" -Ini "${join(WORK, 'VPinballX.ini')}" -Play "${launch}"`);
    log(`   would follow: ${journal}`);
    return { ...result, verdict: 'dry-run' };
  }

  if (o.inPlace) {
    const beside = vpxPath.replace(/\.vpx$/i, '.vbs');
    if (!existsSync(beside) || !isOurSidecar(readFileSync(beside, 'latin1'))) return { ...result, verdict: 'fail', why: [`--in-place: no Castcade sidecar beside the table (${beside}); patch it from Castcade first`] };
  } else {
    mkdirSync(dirname(stagedVpx), { recursive: true });
    const src = statSync(vpxPath);
    const have = existsSync(stagedVpx) ? statSync(stagedVpx) : null;
    if (!have || have.size !== src.size || Math.abs(have.mtimeMs - src.mtimeMs) > 2000) {
      log(`   copying the table (${Math.round(src.size / 1048576)} MB) to ${stagedVpx}`);
      copyFileSync(vpxPath, stagedVpx);
      utimesSync(stagedVpx, src.atime, src.mtime); // the sidecar's stale guard compares size and mtime
    }
    for (const ext of ['.directb2s', '.ini', '.pov', '.res']) {
      const side = vpxPath.replace(/\.vpx$/i, ext);
      if (existsSync(side)) copyFileSync(side, stagedVpx.replace(/\.vpx$/i, ext));
    }
    // the folders the script loads from, as they are beside the original (a DMD project is a few MB)
    for (const f of result.folders) cpSync(join(dirname(vpxPath), f), join(dirname(stagedVpx), f), { recursive: true, force: true });
    writeFileSync(stagedVpx.replace(/\.vpx$/i, '.vbs'), sidecar);
  }

  const ini = stageIni(o);
  const also = o.also === 'none' ? [] : o.also ? o.also.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)) : ini.lockbar ? [String(ini.lockbar)] : [];
  const before = readLines(journal).length;
  const endsBefore = readLines(journal).filter((l) => l.includes('"event":"game_end"')).length;
  const startsBefore = readLines(journal).filter((l) => l.includes('"event":"game_start"')).length;
  const t0 = Date.now();
  log(`   launching ${o.exe}; journal ${journal}`);
  const vpx = spawn(exe, ['-Ini', ini.path, '-Play', launch], { cwd: o.vpxDir, stdio: 'ignore' });
  let exited = false;
  vpx.on('exit', () => {
    exited = true;
  });
  const fresh = (): string[] => readLines(journal).slice(before);
  const py = (args: string[], timeoutMs: number): void => {
    const r = spawnSync('python', ['-I', AUTOPLAY, ...args, '--start', String(KEYS.StartGameKey), '--plunge', String(KEYS.PlungerKey), '--credit', String(KEYS.AddCreditKey), '--exit', String(KEYS.ExitGameKey)], { stdio: 'inherit', timeout: timeoutMs });
    if (r.error) log(`   autoplay: ${r.error.message}`);
  };
  try {
    const loadBy = Date.now() + o.loadSeconds * 1000;
    while (!exited && Date.now() < loadBy && !fresh().some((l) => l.includes('"event":"table_loaded"'))) await sleep(1000);
    if (!fresh().some((l) => l.includes('"event":"table_loaded"'))) {
      log(exited ? '   VPX exited before the table loaded' : `   no table_loaded after ${o.loadSeconds} s`);
    } else {
      log(`   table_loaded; waiting ${settle} s for the table to settle, then playing`);
      await sleep(settle * 1000);
      py(
        [
          'game',
          ...['--credits', '2', '--minutes', String(minutes), '--plunge-every', '6'],
          ...['--until-file', journal, '--until-text', '"event":"game_end"', '--until-count', String(endsBefore + 1)],
          // Start again while the journal shows no game start (a table still booting ignores the first press)
          ...['--started-file', journal, '--started-text', '"event":"game_start"', '--started-count', String(startsBefore + 1)],
          ...(afterStart.length > 0 ? ['--after-start', afterStartArg(afterStart)] : []),
          ...(also.length > 0 ? ['--also', also.join(',')] : []),
        ],
        (minutes + 3) * 60_000,
      );
      await sleep(2000);
    }
  } finally {
    if (!exited) {
      py(['exit'], 30_000);
      for (let i = 0; i < 30 && !exited; i++) await sleep(1000);
      if (!exited) {
        log('   VPX did not close on the exit key; ending the process');
        vpx.kill();
        await sleep(2000);
      }
    }
  }
  const check: JournalCheck = checkGameJournal(fresh(), { balls: o.balls });
  const out: Result = {
    ...result,
    verdict: check.ok ? 'pass' : 'fail',
    why: check.problems,
    notes: [...result.notes, ...check.notes],
    ballEnds: check.summary.ballEnds.length,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  mkdirSync(join(WORK, 'results'), { recursive: true });
  writeFileSync(join(WORK, 'results', `${table}.json`), JSON.stringify({ ...out, summary: check.summary, journal, at: new Date().toISOString(), exe: o.exe }, null, 2) + '\n');
  writeFileSync(join(WORK, 'results', `${table}.jsonl`), fresh().filter((l) => !l.includes('"event":"current_scores"') && !l.includes('"event":"engine"')).join('\n') + '\n');
  log(`   ${check.ok ? 'PASS' : 'FAIL'}: ${check.summary.gameStarts} game start, ball ends [${check.summary.ballEnds.map((b) => `${b.ball}${(b.extraBalls ?? 0) > 0 ? '+' : ''}`).join(', ')}], ${check.summary.gameEnds.length} game end ${JSON.stringify(check.summary.gameEnds[0]?.scores ?? null)}`);
  for (const p of check.problems) log(`   problem: ${p}`);
  for (const n of check.notes) log(`   note: ${n}`);
  return out;
}

function parseArgs(argv: string[]): { o: Options; table: string | null; all: string | null; journal: string | null } {
  const o: Options = {
    balls: 3,
    minutes: 8,
    loadSeconds: 180,
    vpxDir: 'C:\\Users\\mekel\\Documents\\Emulators\\VPX\\VisualPinballX',
    exe: 'VPinballX_GL64.exe',
    only: null,
    mute: false,
    also: null,
    inPlace: false,
    allowCompanion: false,
    dryRun: false,
  };
  let table: string | null = null;
  let all: string | null = null;
  let journal: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--balls') o.balls = Number(next());
    else if (a === '--minutes') o.minutes = Number(next());
    else if (a === '--load-seconds') o.loadSeconds = Number(next());
    else if (a === '--vpx-dir') o.vpxDir = next();
    else if (a === '--exe') o.exe = next();
    else if (a === '--only') o.only = next();
    else if (a === '--also') o.also = next();
    else if (a === '--all') all = next();
    else if (a === '--journal') journal = next();
    else if (a === '--mute') o.mute = true;
    else if (a === '--in-place') o.inPlace = true;
    else if (a === '--allow-companion') o.allowCompanion = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else table = a;
  }
  if (![o.balls, o.minutes, o.loadSeconds].every((n) => Number.isFinite(n) && n > 0)) throw new Error('--balls, --minutes and --load-seconds are positive numbers');
  return { o, table, all, journal };
}

async function main(): Promise<number> {
  const { o, table, all, journal } = parseArgs(process.argv.slice(2));
  if (journal) {
    const c = checkGameJournal(readLines(resolve(journal)), { balls: o.balls });
    console.log(JSON.stringify(c, null, 2));
    return c.ok ? 0 : 1;
  }
  if (!table && !all) {
    console.error('usage: validate-original "<table.vpx>" | --all "<tables folder>"   (see the header of companion/scripts/validate-original.ts)');
    return 2;
  }
  if (!o.dryRun) {
    if (process.platform !== 'win32') throw new Error('the live run needs Windows (VPX, SendInput); use --dry-run or --journal elsewhere');
    const exe = join(o.vpxDir, o.exe);
    if (!existsSync(exe)) throw new Error(`no ${exe}; pass --vpx-dir / --exe`);
    const lib = join(o.vpxDir, 'scripts', 'castcade.vbs');
    const have = existsSync(lib) ? libraryVersionOf(readFileSync(lib, 'latin1')) : null;
    if (have !== LIB_VERSION) throw new Error(`${lib} is ${have ? `version ${have}` : 'missing'}; this build's sidecars need ${LIB_VERSION}. Open Castcade and run Patch my tables once (it installs the library), then close Castcade.`);
    if (['VPinballX_GL64.exe', 'VPinballX64.exe', 'VPinballX_GL.exe', 'VPinballX.exe'].some(running)) throw new Error('VPX is already running; close it first');
    if (!o.allowCompanion && running('Castcade.exe')) throw new Error('Castcade is running: it would follow this run as a real game and could post its score. Quit it from the tray (or pass --allow-companion).');
    if (spawnSync('python', ['--version'], { encoding: 'utf8' }).status !== 0) throw new Error('python is not on PATH (autoplay.py presses the keys)');
  }
  const only = (o.only ?? '').split('|').map((t) => t.trim().toLowerCase()).filter((t) => t !== '');
  const paths = all ?(await listVpxFiles(nodeFs, resolve(all))).filter((p) => only.length === 0 || only.some((t) => basename(p).toLowerCase().includes(t))) : [resolve(table ?? '')];
  const results: Result[] = [];
  for (const p of paths) {
    const r = await validateOne(p, o);
    // --all walks the whole folder: ROM tables and unsupported files are not this runner's business
    if (all && r.verdict === 'skipped') continue;
    if (r.verdict === 'skipped') log(`${r.table}: skipped (${r.why.join('; ')})`);
    if (r.verdict === 'fail' && r.seconds === undefined) for (const w of r.why) log(`${r.table}: ${w}`);
    results.push(r);
    if (all && !o.dryRun) await sleep(5000);
  }
  if (results.length > 1 || all) {
    console.log('\ntable | class | recipe | verdict | ball ends | what');
    for (const r of results) console.log(`${r.table} | ${r.cls} | ${r.recipe ?? '-'} | ${r.verdict}${r.partial.length > 0 ? ' (partial patch)' : ''} | ${r.ballEnds ?? '-'} | ${r.why.join('; ')}`);
    mkdirSync(join(WORK, 'results'), { recursive: true });
    writeFileSync(join(WORK, 'results', '_summary.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n');
    console.log(`\n${results.filter((r) => r.verdict === 'pass').length} pass, ${results.filter((r) => r.verdict === 'fail').length} fail, ${results.filter((r) => r.verdict === 'dry-run').length} dry-run; details in ${join(WORK, 'results')}`);
  }
  return results.some((r) => r.verdict === 'fail') ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
