/**
 * A17 step 3, the rig check: does VPX leave cleanly when Castcade asks it to (`src/launch/vpx-close.ts`)? This starts
 * one VPX on one table, waits, asks it to close exactly as the app does, and reports what happened. It is the check
 * the design asks for before the lobby's table change depends on it (alpha-match.md section 11.13, open point 3).
 * Run from the repo root, with no VPX open:
 *
 *   npx tsx companion/scripts/vpx-close-check.ts --exe "<VPinballX exe>" --table "<table.vpx>" [--nvram "<rom>.nv"]
 *
 * - With the Castcade VPX build (`VPinballX_GL64_castcade.exe`) the table is started in the match role with a control
 *   connection to this script, and the line `quit` is sent on it (rung 1).
 * - With any other VPX the table is started the way Castcade starts one (`-Play` and nothing else) and its main window
 *   is asked to close with the app's own code, `askVpxWindowToClose` (rung 2: the front-end close request,
 *   `PinSim::FrontEndControls` CLOSE_APP, after the window said it takes it; never `WM_CLOSE`, which left VPX with
 *   exit code 0x80000003 and its NVRAM not written on the owner's rig, 2026-11-25).
 *
 * Options:
 *   --seconds N        how long the table stays open before it is asked to close (default 30): time to start a game
 *                      and score, when the question is whether a high score survives
 *   --fork             the exe is the Castcade VPX build under another name (a local build: `build\Release\VPinballX_GL64.exe`)
 *   --nvram FILE       the ROM's `.nv` file: its time of writing is read before and after
 *   --allow-companion  run although Castcade is running (it takes the run for a real game: a Witness report, and it
 *                      may remember this exe as the VPX exe)
 *
 * What to look for: "VPX left N s after it was asked" and exit code 0; "NVRAM written" when `--nvram` was given; no
 * "VPX shows a dialog" line. Nothing here ever ends the process: a VPX that stays open is reported and left open.
 * Windows only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { askVpxWindowToClose, powershellWindows, type VpxProcessWindow } from '../src/launch/vpx-close.js';
import { forkMatchEnv } from '../src/launch/vpx-launch.js';
import { isForkExe, isVpxExe } from '../src/witness/process-watch.js';

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] as string) : null;
};
const say = (line: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
const stop = (line: string): never => {
  console.error(line);
  process.exit(2);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/**
 * The image names of every running process, whole. `tasklist`'s table cuts a name at 25 characters and its CSV does
 * not (`VPinballX_GL64_castcade.exe` has 27). An empty list means the listing failed, which is a reason to stop.
 */
const images = (): string[] =>
  (spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout ?? '')
    .split(/\r?\n/)
    .map((line) => /^"([^"]+)"/.exec(line)?.[1] ?? '')
    .filter((name) => name !== '');
/** The windows of a process as the app's own script lists them; the run is ended with nothing asked. */
const windowsOf = async (process: number): Promise<VpxProcessWindow[]> => {
  const run = await powershellWindows.open(process);
  run.cancel();
  return run.windows;
};
const written = (file: string | null): string | null => (file && existsSync(file) ? statSync(file).mtime.toISOString() : null);

const exe = opt('exe') ?? stop('--exe "<VPinballX exe>" is missing');
const table = opt('table') ?? stop('--table "<table.vpx>" is missing');
const nvram = opt('nvram');
const seconds = Math.max(5, Number(opt('seconds') ?? 30) || 30);
if (!win32.isAbsolute(exe) || !isVpxExe(exe) || !existsSync(exe)) stop(`not a VPinballX exe that exists: ${exe}`);
if (!win32.isAbsolute(table) || !/\.vpx$/i.test(table) || !existsSync(table)) stop(`not a table file that exists: ${table}`);
const runningNow = images();
if (runningNow.length === 0) stop('the list of running programs could not be read (tasklist): nothing is started');
// Any VPX at all, under whatever name it runs: a second VPX would take the headset, and two VPinMAME would write one .nv.
const vpxRunning = [...new Set(runningNow.filter((name) => /^VPinballX/i.test(name)))];
if (vpxRunning.length > 0) stop(`VPX is already running (${vpxRunning.join(', ')}): close every VPX first`);
if (runningNow.some((name) => /^Castcade\.exe$/i.test(name)) && !args.includes('--allow-companion')) stop('Castcade is running: quit it from the tray first (or pass --allow-companion: it then takes this run for a real game)');

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ host: '127.0.0.1', port: 0 }, () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });

const fork = isForkExe(exe) || args.includes('--fork');
const streamLog = win32.join(tmpdir(), `castcade-close-check-${Date.now()}.log`);
let control: Socket | null = null;
let hello: string | null = null;
let env: Record<string, string | undefined> = { ...process.env };
if (fork) {
  const server = createServer((sock) => {
    control = sock;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      for (const line of d.split('\n').filter(Boolean)) {
        say(`control < ${line}`);
        if (line.startsWith('hello ')) hello = line;
      }
    });
    sock.on('close', () => say('control: the connection closed'));
    sock.on('error', () => undefined);
  });
  const controlPort = await new Promise<number>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, () => resolve((server.address() as { port: number }).port)));
  env = { ...env, ...forkMatchEnv(await freePort(), controlPort, streamLog) };
  say(`the Castcade VPX build: role match, control on 127.0.0.1:${controlPort}, its stream log is ${streamLog}`);
} else say('a VPX that is not the Castcade build: its main window will be asked to close (the front-end close request)');

const before = written(nvram);
say(`starting ${win32.basename(exe)} -Play "${win32.basename(table)}"`);
const child = spawn(exe, ['-Play', table], { cwd: win32.dirname(exe), stdio: 'ignore', shell: false, env });
let exit: { code: number | null; at: number } | null = null;
child.on('exit', (code) => (exit = { code, at: Date.now() }));
child.on('error', (e) => stop(`VPX did not start: ${e.message}`));
const pid = child.pid ?? stop('VPX did not start (no process id)');

// The table is open when the build says hello, or when the player window is there.
const loadBy = Date.now() + 240_000;
for (;;) {
  if (exit) stop(`VPX ended by itself before the table was open (exit ${String((exit as { code: number | null }).code)})`);
  if (Date.now() > loadBy) stop('the table did not open in 4 minutes; VPX is left as it is');
  if (fork ? hello !== null : (await windowsOf(pid).catch(() => [])).some((w) => /^Visual Pinball(?: X)? Player\b/i.test(w.title))) break;
  await sleep(3_000);
}
say(`the table is open. It is asked to close in ${seconds} s: start a game and score now, if the question is whether a high score survives`);
await sleep(seconds * 1000);
if (exit) stop('VPX was closed by hand before it was asked');

const askedAt = Date.now();
if (fork) {
  const sent = (control as Socket | null)?.write('quit\n') ?? false;
  say(sent ? 'control > quit' : 'quit could not be sent: the control connection is gone');
} else {
  const r = await askVpxWindowToClose(pid);
  say(r.asked ? 'asked the VPX main window to close (the front-end close request)' : `the window could not be asked: ${r.held ? 'held' : r.reason}`);
}

// 30 s for it to leave (the app asks the person after 15 s). A dialog on the way is said; nothing is ended.
const leaveBy = askedAt + 30_000;
while (!exit && Date.now() < leaveBy) {
  await sleep(2_000);
  if (exit) break;
  const dialogs = (await windowsOf(pid).catch(() => [])).filter((w) => w.visible && w.className === '#32770');
  for (const d of dialogs) say(`VPX shows a dialog: "${d.title}" (NOT a clean exit: say which one)`);
}
const after = written(nvram);
const done = exit as { code: number | null; at: number } | null;
console.log('');
if (done) say(`RESULT: VPX left ${((done.at - askedAt) / 1000).toFixed(1)} s after it was asked, exit code ${String(done.code)}${done.code === 0 ? '' : ' (NOT a clean exit: a clean one is 0)'}${done.at - askedAt > 15_000 ? ' (later than the 15 s the app waits: the app would have asked the person)' : ''}`);
else say('RESULT: VPX is STILL OPEN 30 s after it was asked (not clean). It is left open: close it by hand and say what was on screen');
if (nvram) say(before === after ? `NVRAM NOT written (${nvram}: ${before ?? 'no such file'})` : `NVRAM written (${nvram}: ${before ?? 'no file'} -> ${after ?? 'no file'})`);
if (fork && existsSync(streamLog)) {
  const lines = readFileSync(streamLog, 'utf8').split(/\r?\n/).filter((l) => /quit|role match:|control/.test(l));
  console.log(`\nThe build's own log (${streamLog}), the lines about the control connection:\n${lines.slice(-12).join('\n')}`);
}
process.exit(done ? 0 : 1);
