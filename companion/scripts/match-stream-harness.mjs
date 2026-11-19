// I11.4.2 (2026-11-19): the state stream inside a match, end to end on one PC, against the REAL VPX fork.
//
// Two or three "PCs" in ONE Electron main process. Each is what the app wires together for a match, as built in
// `dist/`: the real `createStream3dHost` (the control server the fork connects to, the machine, the launch), the real
// `createTunnelEnd` (a hidden page with a real RTCPeerConnection and data channel, the bridge, the loopback sockets),
// and a real fork instance started the way the app starts a match table (`Stream3dHost.launch`: role `match`, the two
// loopback addresses). What is not real: the match itself. The harness plays the match host's part towards the stream
// (`setPeers`, `setTarget(player up, grant)`, `whenPlaying` at a grant, `setSetting`), and the signalling between the
// tunnel ends crosses in memory instead of over MEDIA_SIGNAL.
//
//   <electron.exe> companion/scripts/match-stream-harness.mjs --out <dir> --exe <ccmatch_GL64.exe> --template <ini>
//       --tables <folder> --closer <match-stream-harness.ps1> [--only g1,g2,...] [--turns 20] [--rom-table <name>]
//
// Run it through `match-stream-harness.ps1` (beside this file): that script saves and puts back what a VPX start
// changes on this PC (the type-library registration, BAMViewSettings.xml, a ROM's nvram and cfg), and closes whatever
// this harness left running. Only with the companion's own electron.exe (the one with Windows Firewall rules).
//
// Rules this file keeps: every TCP port is in 48200-48299 on 127.0.0.1 (control 48201.., stream 48210.., the tunnel's
// watcher listeners 48250..); the fork runs from a copy named `ccmatch_GL64.exe` (the installed Castcade takes any
// `VPinballX*.exe` for a game), always with `-Ini` (a generated one: windowed, VR off, sound off) and
// `CASTCADE_TEST_NOPAUSE=1`; no keyboard or mouse input is sent to any window; a window is closed with WM_CLOSE by
// PID (through the .ps1), and only a process this harness started is ever killed (a scenario's own, or as a last
// resort at the end). The player's plain VPX is never started: where the code under test would start it (the
// "did not start" fall-back), the request is recorded.
//
// Groups (--only): `two` (hello and capability, 20 turns, a watcher's fork killed, the player's fork killed, the
// tunnel page restarted), `three` (a PC without the fork; then three forks and the re-aim), `off` (3D watch off from
// the start: no tunnel; turned on mid-match: the tunnel opens late; off again mid-watch), `mismatch` (two table
// files), `rom` (turns on a ROM table), `nostart` (a fork that never starts, through the real one-step and launcher).
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { createVpxLauncher, forkExeFor } from '../dist/launch/vpx-launch.js';
import { createOneStep } from '../dist/main/one-step.js';
import { createStream3dHost, listenControl } from '../dist/main/stream3d-host.js';
import { createTunnelEnd } from '../dist/watch/tunnel-end.js';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const out = resolve(opt('out', 'tmp/match-stream-harness'));
const CCMATCH = resolve(opt('exe', String.raw`C:\code\repos\castcade-vpx-wt-handoff\build\Release\cchand_GL64.exe`));
const TEMPLATE = resolve(opt('template', String.raw`C:\code\repos\castcade-vpx-deps\run\smoke.template.ini`));
const TABLES = resolve(opt('tables', String.raw`C:\code\repos\castcade-vpx-deps\run\tables`));
const CLOSER = resolve(opt('closer', join(dirname(fileURLToPath(import.meta.url)), 'match-stream-harness.ps1')));
const TURNS = Number(opt('turns', '20'));
const ROM_TABLE = opt('rom-table', 'Attack from Mars LE (Midway 1995) v600.vpx');
const ONLY = opt('only', 'two,three,off,mismatch,rom,nostart').split(',').map((s) => s.trim());
const NUDGE = join(TABLES, 'Nudge Test and Calibration.vpx');
/** The exe the companion "knows" on these PCs: never started; the fork is looked for beside it. */
const PLAIN_EXE = join(dirname(CCMATCH), 'VPinballX_GL64.exe');
const FORK_AS_APP_NAMES_IT = forkExeFor(PLAIN_EXE);
const W = 640;
const H = 360;

mkdirSync(out, { recursive: true });
app.setPath('userData', join(out, 'electron-user-data'));
const logFile = join(out, 'harness.log');
const stamp = () => {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};
const log = (line) => {
  const l = `[${stamp()}] ${line}`;
  console.log(l);
  appendFileSync(logFile, `${l}\n`);
};
process.on('uncaughtException', (e) => log(`UNCAUGHT ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`UNHANDLED ${e?.stack ?? e}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const until = async (cond, ms, step = 10) => {
  const end = now() + ms;
  for (;;) {
    if (cond()) return true;
    if (now() > end) return false;
    await sleep(step);
  }
};
const round = (v) => (v === null || v === undefined ? null : Math.round(v));
const stats = (arr) => {
  const s = arr.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (s.length === 0) return null;
  return { n: s.length, min: round(s[0]), median: round(s[Math.floor(s.length / 2)]), p90: round(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]), max: round(s[s.length - 1]) };
};
const statsWords = (arr) => {
  const s = stats(arr);
  return s ? `min ${s.min} / median ${s.median} / p90 ${s.p90} / max ${s.max} ms (n ${s.n})` : 'none';
};

// ------------------------------------------------------------------------------------ results --
const results = [];
const forkFindings = [];
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} [${group}] ${name}${detail ? `: ${detail}` : ''}`);
  return !!ok;
}
/** Something the FORK did that the contract does not say: recorded with what was sent and received, never worked around. */
function forkFinding(group, what, lines) {
  forkFindings.push({ group, what, lines });
  log(`FORK [${group}] ${what}`);
  for (const l of lines) log(`    ${l}`);
}

// -------------------------------------------------------------------------------------- ports --
// All TCP, all 127.0.0.1, all inside 48200-48299.
const CONTROL_PORT = { a: 48201, b: 48202, c: 48203 };
let streamNext = 48210; // one per fork start, up to 48249
let watchNext = 48250; // one per tunnel end, up to 48289
const nextStreamPort = () => {
  if (streamNext > 48249) throw new Error('out of stream ports (48210-48249)');
  return streamNext++;
};
const nextWatchPort = () => {
  if (watchNext > 48289) throw new Error('out of watcher listener ports (48250-48289)');
  return watchNext++;
};

// ------------------------------------------------------------------------- the fork instances --
const pidsFile = join(out, 'pids.json');
const pids = [];
const plainRequests = [];
const KEYS = { StartGameKey: 2, AddCreditKey: 6, PlungerKey: 28, LFlipKey: 42, RFlipKey: 54, ExitGameKey: 16 };

/** The ini of an instance: the template with a desktop window, VR off, sound off (as the fork's own test scripts write it). */
function writeIni(dest, index) {
  const set = {
    Player: { FullScreen: '0', Width: String(W), Height: String(H), Display: '-1', WindowPosX: String(20 + (index % 2) * (W + 20)), WindowPosY: String(60 + Math.floor(index / 2) * (H + 50)), PlaySound: '0', PlayMusic: '0', CacheMode: '0' },
    PlayerVR: { AskToTurnOn: '2' },
    Editor: { EnableLog: '1' },
  };
  for (const [k, v] of Object.entries(KEYS)) set.Player[k] = String(v);
  const outLines = [];
  const done = new Set();
  let sec = '';
  const flush = (s) => {
    for (const [k, v] of Object.entries(set[s] ?? {})) {
      if (done.has(`${s}/${k}`)) continue;
      outLines.push(`${k} = ${v}`);
      done.add(`${s}/${k}`);
    }
  };
  for (const l of readFileSync(TEMPLATE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*\[(.+?)\]\s*$/.exec(l);
    if (m) {
      flush(sec);
      sec = m[1];
      outLines.push(l);
      continue;
    }
    const kv = /^\s*([^=;#]+?)\s*=/.exec(l);
    if (set[sec] && kv) {
      const hit = Object.keys(set[sec]).find((k) => k.toLowerCase() === kv[1].toLowerCase());
      if (hit) {
        if (!done.has(`${sec}/${hit}`)) {
          outLines.push(`${kv[1]} = ${set[sec][hit]}`);
          done.add(`${sec}/${hit}`);
        }
        continue;
      }
    }
    outLines.push(l);
  }
  flush(sec);
  writeFileSync(dest, outLines.join('\r\n'));
}

/** Keys fired inside VPX (CASTCADE_TEST_INPUT): a game is started and played a little, so the stream has something to carry. */
function writeInput(dest, seed) {
  const ev = [];
  const tap = (t, key, hold) => ev.push([t, 1, `${t} down ${key}`], [t + hold, 0, `${t + hold} up ${key}`]);
  tap(8000, 'credit', 150);
  tap(8600, 'credit', 150);
  tap(9200, 'start', 150);
  tap(12350, 'plunger', 1200);
  tap(15200, 'start', 150);
  tap(18350, 'plunger', 1200);
  let s = seed >>> 0;
  const rnd = (n) => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) % n);
  let alt = 0;
  for (let t = 14000; t < 900_000; t += 700 + rnd(900)) {
    tap(t, alt++ % 2 ? 'rflip' : 'lflip', 120 + rnd(180));
    if (t % 12000 < 1600) tap(t + 300, 'plunger', 1200);
  }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  writeFileSync(dest, ['# match-stream-harness.mjs: <ms from first rendered frame> <down|up> <key>', ...ev.map((e) => e[2])].join('\r\n'));
}

/** WM_CLOSE to a process's player window, by PID, through the .ps1 (no input is sent, no focus is taken). */
function wmClose(pid) {
  return new Promise((done) => {
    const p = spawn('pwsh', ['-NoProfile', '-File', CLOSER, '-ClosePid', String(pid)], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => done(false));
    p.on('exit', (code) => done(code === 0));
  });
}

// ------------------------------------------------------------------------------------- one PC --
let pcIndex = 0;
function makePc(group, name, o = {}) {
  const dir = join(out, group, name);
  mkdirSync(dir, { recursive: true });
  const pc = {
    group,
    name,
    dir,
    index: pcIndex++ % 3,
    setting: o.setting ?? 'auto',
    forkBeside: o.forkBeside !== false,
    rec: [],
    lines: [],
    tunnels: [],
    fork: null,
    forks: [],
    forkSeq: 0,
    stream: null,
    hello: null,
    connected: false,
  };
  const t0 = now();
  const companionLog = join(dir, 'companion.log');
  const controlLog = join(dir, 'control.log');
  const pcLog = (l) => {
    pc.lines.push(l);
    appendFileSync(companionLog, `[${stamp()}] ${l}\n`);
  };
  const note = (d, line) => {
    const e = { t: now(), d, line };
    pc.rec.push(e);
    appendFileSync(controlLog, `${((e.t - t0) / 1000).toFixed(3)} ${d} ${line}\n`);
    return e;
  };
  // The real control listener, on this PC's port; every line in and out is kept with its time.
  const wrap = new Map();
  const listen = async (h) => {
    const l = await listenControl(
      {
        open(c) {
          const w = {
            send: (line) => {
              const ok = c.send(line);
              note('>', ok ? line : `${line}   (NOT SENT: the connection is gone)`);
              // A scenario's next step, taken once this line's sender has returned: still the same turn of the loop,
              // so what it sends is on the socket within the same millisecond.
              const then = pc.onSent;
              if (then) void Promise.resolve().then(() => then(line));
              return ok;
            },
            close: () => c.close(),
          };
          wrap.set(c, w);
          pc.lastRaw = c;
          note('+', 'connection');
          h.open(w);
        },
        line(c, text) {
          note('<', text);
          if (text.startsWith('hello ')) pc.hello = text;
          h.line(wrap.get(c), text);
        },
        close(c, why) {
          note('x', why);
          h.close(wrap.get(c), why);
          wrap.delete(c);
        },
      },
      CONTROL_PORT[name],
    );
    if (l.port !== CONTROL_PORT[name]) throw new Error(`control port ${CONTROL_PORT[name]} is not free on 127.0.0.1 (got ${l.port})`);
    return l;
  };
  pc.host = createStream3dHost({
    log: { info: pcLog, warn: (l) => pcLog(`WARN ${l}`) },
    logsDir: dir,
    pageDir: dir,
    vpxExe: () => PLAIN_EXE,
    // The fork "is beside the VPX exe" on a PC that has it; the harness starts it from its test name.
    exists: async (p) => (p === FORK_AS_APP_NAMES_IT ? pc.forkBeside : true),
    iceServers: () => [],
    tunnel: (t) => {
      const end = createTunnelEnd({ ...t, partition: `castcade-s3d-harness-${group}-${name}-${pc.tunnels.length}`, watchPort: nextWatchPort() });
      pc.tunnels.push(end);
      return end;
    },
    freePort: async () => nextStreamPort(),
    ports: { read: () => JSON.stringify({ controlPort: CONTROL_PORT[name] }), write: (text) => (pc.savedPorts = text) },
    listen,
  });
  /** The companion's side closes the control connection under the fork (what a line of over 2048 bytes does from the fork's side). */
  pc.cutControl = () => pc.lastRaw?.close();
  pc.mark = () => pc.rec.length;
  pc.waitRec = async (from, pred, ms) => {
    let hit = null;
    await until(() => (hit = pc.rec.slice(from).find(pred) ?? null) !== null, ms, 5);
    return hit;
  };
  pc.tunnel = () => pc.tunnels.at(-1) ?? null;
  pc.bytesIn = () => pc.tunnel()?.status().stats.bytesIn ?? 0;
  pc.view = (other) => pc.stream?.status().players.find((p) => p.id === other.name) ?? null;
  pc.since = (from) => pc.rec.slice(from).map((e) => `${e.d} ${e.line}`);
  return pc;
}

/** Start this PC's match table as the app does: `Stream3dHost.launch`, then the process with what it returned. */
async function startFork(pc, table, { waitReady = true } = {}) {
  const launch = await pc.host.launch(pc.setting);
  if (!launch) {
    plainRequests.push({ pc: `${pc.group}/${pc.name}`, table, why: `launch(${pc.setting}) returned null: the app starts the player's own VPX`, started: false });
    log(`${pc.name}: launch() returned null (${pc.setting}): the app would start the player's own VPX here; recorded, not started`);
    return null;
  }
  pc.forkSeq += 1;
  const instDir = join(pc.dir, `vpx-${pc.forkSeq}`);
  mkdirSync(instDir, { recursive: true });
  const ini = join(instDir, 'vpx.ini');
  writeIni(ini, pc.index);
  const input = join(instDir, 'input.txt');
  writeInput(input, pc.index + 1 + pc.forkSeq * 7);
  // The companion names one stream log per PC; an earlier instance's is kept beside it.
  const streamLog = launch.options.env.CASTCADE_STREAM_LOG;
  if (existsSync(streamLog)) renameSync(streamLog, streamLog.replace(/\.log$/, `.before-${pc.forkSeq}.log`));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CASTCADE_|ELECTRON_)/i.test(k)) env[k] = v;
  Object.assign(env, launch.options.env, { CASTCADE_TEST_NOPAUSE: '1', CASTCADE_TEST_INPUT: input });
  const mark = pc.mark();
  const child = spawn(CCMATCH, ['-Ini', ini, '/ExtMinimized', '-Play', table], { cwd: instDir, env, stdio: 'ignore', windowsHide: false });
  const f = { child, pid: child.pid ?? null, exited: false, code: null, dir: instDir, table, streamLog, askedStreamPort: Number(/:(\d+)$/.exec(launch.options.env.CASTCADE_STREAM_ADDR)?.[1]), startedAt: now(), didNotStart: null, killedByHarness: false };
  child.on('error', (e) => log(`${pc.name}: the fork did not start: ${e.message}`));
  child.on('exit', (code) => {
    f.exited = true;
    f.code = code;
    launch.options.onExit?.(code);
    log(`${pc.name}: fork PID ${f.pid} exited, code ${code}${f.killedByHarness ? ' (killed by the harness: its own process)' : ''}`);
  });
  void launch.didNotStart.then((failed) => (f.didNotStart = failed));
  pc.fork = f;
  pc.forks.push(f);
  if (f.pid) {
    pids.push({ name: `${pc.group}/${pc.name}`, pid: f.pid, exe: CCMATCH, startedAt: Date.now() });
    writeFileSync(pidsFile, JSON.stringify(pids, null, 2));
  }
  log(`${pc.name}: fork PID ${f.pid} started as the app would (${launch.options.exe} is run from ${CCMATCH}); ${launch.options.env.CASTCADE_STREAM_ADDR}, control ${launch.options.env.CASTCADE_STREAM_CONTROL}`);
  if (!waitReady) return f;
  const ready = await until(() => pc.rec.slice(mark).some((e) => e.d === '<' && e.line === 'state playing'), 150_000, 20);
  f.readyMs = ready ? now() - f.startedAt : null;
  if (!ready) log(`${pc.name}: the fork did not say hello and state playing within 150 s`);
  return f;
}

/** Close a fork's window with WM_CLOSE and wait for it; its own PID is killed only if it does not go. */
async function closeFork(pc) {
  const f = pc.fork;
  if (!f || f.exited) return true;
  await wmClose(f.pid);
  if (await until(() => f.exited, 25_000, 50)) return true;
  log(`${pc.name}: fork PID ${f.pid} did not close on WM_CLOSE; last resort: killing the harness's own process`);
  f.killedByHarness = true;
  f.child.kill();
  await until(() => f.exited, 10_000, 50);
  return false;
}

/** A scenario kills its own fork (a crash, as the others see it). */
async function killFork(pc) {
  const f = pc.fork;
  if (!f || f.exited) return;
  f.killedByHarness = true;
  f.child.kill();
  await until(() => f.exited, 10_000, 20);
}

// ---------------------------------------------------------------------------------- the match --
/** The streams of a match on these PCs; the tunnels' signalling crosses in memory (MEDIA_SIGNAL `stream` in the app). */
function openMatch(pcs) {
  const by = Object.fromEntries(pcs.map((p) => [p.name, p]));
  for (const p of pcs) {
    p.signals = { out: 0, in: 0 };
    p.stream = p.host.open({
      localId: p.name,
      setting: p.setting,
      sendSignal: (to, s) => {
        if (p.muted) return;
        p.signals.out += 1;
        setImmediate(() => {
          const other = by[to];
          if (!other?.stream) return;
          other.signals.in += 1;
          other.stream.signal(p.name, { ...s, channel: 'stream' });
        });
      },
    });
  }
  for (const p of pcs) p.stream.setPeers(pcs.filter((x) => x !== p).map((x) => ({ id: x.name, name: x.name.toUpperCase() })));
}

/** As the match host's lock: at a grant, the table is unlocked once the fork is back on its own table (2 s at most). */
function lockAtGrant(pc) {
  const t0 = now();
  if (!pc.stream.away()) return Promise.resolve({ ms: 0, late: false, waited: false });
  return new Promise((done) => pc.stream.whenPlaying((late) => done({ ms: now() - t0, late, waited: true })));
}

/**
 * One grant: `up` is the player up from here on. Every other PC that shows it in 3D is sent to watch (its target is
 * the player and the grant); the player's own target is nobody, and its lock waits for its fork. `order`: which PC
 * hears of the grant first (in a match the two happen at the same moment on two PCs).
 */
async function grant(g, up, order = 'together') {
  g.turn += 1;
  const key = String(g.turn);
  const others = g.pcs.filter((p) => p !== up);
  const marks = new Map(g.pcs.map((p) => [p, p.mark()]));
  const plan = new Map();
  for (const p of others) plan.set(p, p.view(up)?.mode === '3d' ? 'watch' : p.stream.away() ? 'play' : 'stay');
  const upWasAway = up.stream.away();
  let lock = null;
  const player = () => {
    lock = lockAtGrant(up);
    up.stream.setTarget(null);
  };
  const watchers = () => {
    for (const p of others) p.stream.setTarget(up.name, key);
  };
  if (order === 'watch-first') {
    watchers();
    await sleep(150);
    player();
  } else if (order === 'play-first') {
    player();
    await sleep(150);
    watchers();
  } else if (order === 'held') {
    // The player who just finished holds its table for a second (a game still ending on the machine): no target yet.
    player();
    await sleep(1000);
    watchers();
  } else {
    player();
    watchers();
  }
  const row = { turn: g.turn, up: up.name, order, lockMs: null, lockLate: null, playingMs: null, watchers: {}, ok: true, why: [] };
  // The player's fork: called back, and the lock lifted with its answer.
  if (upWasAway) {
    const sent = await up.waitRec(marks.get(up), (e) => e.d === '>' && e.line === 'play', 3000);
    const ans = sent ? await up.waitRec(up.rec.indexOf(sent) + 1, (e) => e.d === '<' && /^state /.test(e.line), 4000) : null;
    if (!sent) {
      row.ok = false;
      row.why.push(`${up.name}: no play was sent`);
    } else if (!ans || ans.line !== 'state playing') {
      row.ok = false;
      row.why.push(`${up.name}: play answered by ${ans ? `"${ans.line}"` : 'nothing in 4 s'}`);
    } else row.playingMs = ans.t - sent.t;
  }
  const l = await Promise.race([lock, sleep(4000).then(() => null)]);
  if (!l) {
    row.ok = false;
    row.why.push(`${up.name}: the lock was not lifted within 4 s`);
  } else {
    row.lockMs = l.ms;
    row.lockLate = l.late;
    if (l.late) {
      row.ok = false;
      row.why.push(`${up.name}: the lock was lifted by the 2 s limit, not by state playing`);
    }
  }
  // The watchers.
  for (const p of others) {
    const what = plan.get(p);
    const w = { plan: what, watchingMs: null, answer: null, reaim: false, bytes: 0 };
    row.watchers[p.name] = w;
    if (what === 'watch') {
      const from = marks.get(p);
      const sent = await p.waitRec(from, (e) => e.d === '>' && e.line.startsWith('watch '), 4000);
      if (!sent) {
        row.ok = false;
        row.why.push(`${p.name}: no watch was sent`);
        continue;
      }
      // A re-aim: the fork was watching, and no play went out before this watch.
      w.reaim = !p.rec.slice(from, p.rec.indexOf(sent)).some((e) => e.d === '>' && e.line === 'play') && g.watching.get(p) !== undefined && g.watching.get(p) !== null;
      w.address = sent.line.slice(6);
      const ans = await p.waitRec(p.rec.indexOf(sent) + 1, (e) => e.d === '<' && /^state (watching|failed)/.test(e.line), 8000);
      w.answer = ans?.line ?? null;
      if (ans?.line === 'state watching') w.watchingMs = ans.t - sent.t;
      else {
        row.ok = false;
        row.why.push(`${p.name}: watch answered by ${ans ? `"${ans.line}"` : 'nothing in 8 s'}`);
      }
      g.watching.set(p, ans?.line === 'state watching' ? up : null);
    } else {
      if (what === 'play') {
        const ans = await p.waitRec(marks.get(p), (e) => e.d === '<' && e.line === 'state playing', 4000);
        if (!ans) {
          row.ok = false;
          row.why.push(`${p.name}: called back (2D for ${up.name}) and no state playing`);
        }
      }
      g.watching.set(p, null);
    }
  }
  g.watching.set(up, null);
  g.up = up;
  g.rows.push(row);
  return row;
}

/** Let the turn run, and measure what reached each watcher's fork through its tunnel meanwhile. */
async function playFor(g, row, ms) {
  const before = new Map(g.pcs.map((p) => [p, p.bytesIn()]));
  await sleep(ms);
  for (const p of g.pcs) if (row.watchers[p.name]?.plan === 'watch') row.watchers[p.name].bytes = p.bytesIn() - before.get(p);
}

const rowWords = (r) => {
  const ws = Object.entries(r.watchers)
    .map(([n, w]) => `${n} ${w.plan === 'watch' ? `${w.reaim ? 're-aimed, ' : ''}watching after ${round(w.watchingMs) ?? '?'} ms, ${w.bytes} B in` : w.plan === 'play' ? 'called back (2D)' : '2D, nothing sent'}`)
    .join('; ');
  return `turn ${r.turn} (${r.order}): ${r.up} up${r.playingMs !== null ? `, state playing after ${round(r.playingMs)} ms` : ''}, lock lifted after ${round(r.lockMs)} ms; ${ws}${r.ok ? '' : `   PROBLEM: ${r.why.join('; ')}`}`;
};

/**
 * Two commands that leave this PC within the same millisecond (a grant right after a turn change): the fork reads them
 * in one go and acts on, and answers, only the last. `second` is what the match host does the moment the first line
 * (a `watch`) is out. Returns what was sent and what came back, and waits out the watch's 5 s to see that nothing of
 * the first command is still waited for.
 */
async function backToBack(pc, first, second) {
  const mark = pc.mark();
  let done = false;
  pc.onSent = (line) => {
    if (done || !line.startsWith('watch ')) return;
    done = true;
    pc.onSent = null;
    second();
  };
  const t0 = now();
  first();
  await until(() => done, 3000, 1);
  pc.onSent = null;
  const sent = () => pc.rec.slice(mark).filter((e) => e.d === '>');
  const got = () => pc.rec.slice(mark).filter((e) => e.d === '<');
  await until(() => got().length >= 1, 4000, 2);
  const firstAnswerMs = got()[0] ? got()[0].t - t0 : null;
  const gapMs = sent().length >= 2 ? sent()[1].t - sent()[0].t : null;
  // Longer than the watch's time: a fall-back for a command that was replaced would show here.
  await sleep(6500);
  return { mark, sent: sent().map((e) => e.line), got: got().map((e) => e.line), gapMs, firstAnswerMs, lines: pc.since(mark) };
}

/** Everybody back to their own table (the lobby, the result): nobody is up. */
async function nobodyUp(g) {
  for (const p of g.pcs) p.stream?.setTarget(null);
  await until(() => g.pcs.every((p) => !p.stream || !p.stream.away()), 5000);
  for (const p of g.pcs) g.watching.set(p, null);
  g.up = null;
}

const newGroup = (name, pcs) => ({ name, pcs, turn: 0, rows: [], watching: new Map(), up: null });

/** The hidden window of a PC's tunnel page. */
function tunnelWindow(pc) {
  const page = join(pc.dir, 'stream3d-tunnel.html').toLowerCase();
  return (
    BrowserWindow.getAllWindows().find((x) => {
      try {
        return fileURLToPath(x.webContents.getURL()).toLowerCase() === page;
      } catch {
        return false;
      }
    }) ?? null
  );
}

// ------------------------------------------------------------------------ what the forks logged --
function analyzeForkLog(file) {
  const a = { file, exists: existsSync(file), keyframes: 0, keyframeFailed: 0, statsLines: 0, received: 0, replayFailed: 0, unresolved: 0, sessions: 0, sessionFrames: 0, backReasons: {}, physicsDifferent: 0, held: 0, served: 0, heldClosed: 0, warnings: [], errors: [], hello: null, listening: null };
  if (!a.exists) return a;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    let m;
    if (/\] balls t=/.test(line)) continue;
    if ((m = /keyframe applied: .*\((\d+) replayed, (\d+) failed or unresolved\)/.exec(line))) {
      a.keyframes += 1;
      a.keyframeFailed += Number(m[2]);
    } else if ((m = /\[watch pid \d+\] stats .*received (\d+) .*failed (\d+), unresolved (\d+)/.exec(line))) {
      a.statsLines += 1;
      a.received += Number(m[1]);
      a.replayFailed += Number(m[2]);
      a.unresolved += Number(m[3]);
    } else if ((m = /\[watch pid \d+\] whole session: .*frames (\d+),/.exec(line))) {
      a.sessions += 1;
      a.sessionFrames += Number(m[1]);
    } else if ((m = /back to playing \((.*?)\) after .*own physics state (identical|DIFFERENT)/.exec(line))) {
      a.backReasons[m[1]] = (a.backReasons[m[1]] ?? 0) + 1;
      if (m[2] === 'DIFFERENT') a.physicsDifferent += 1;
    } else if (/held: this table is not playing yet/.test(line)) a.held += 1;
    else if (/served after [\d.]+ ms on hold/.test(line)) a.served += 1;
    else if (/closed: held 10 s/.test(line)) a.heldClosed += 1;
    else if ((m = /control > (hello .*)$/.exec(line))) a.hello = m[1];
    else if ((m = /\] listening on 127\.0\.0\.1:(\d+)/.exec(line))) a.listening = Number(m[1]);
    if (/\] WARNING /.test(line) && !/names that do not resolve with GetIDsOfNames/.test(line)) a.warnings.push(line.slice(0, 300));
    if (/\] ERROR /.test(line)) a.errors.push(line.slice(0, 300));
  }
  return a;
}

/** Close the group's forks and streams, then read what each fork logged. */
async function endGroup(g) {
  await nobodyUp(g).catch(() => undefined);
  let clean = true;
  for (const p of g.pcs) clean = (await closeFork(p)) && clean;
  for (const p of g.pcs) await p.stream?.close().catch(() => undefined);
  for (const p of g.pcs) await p.host.stop().catch(() => undefined);
  const logs = [];
  for (const p of g.pcs) {
    for (const f of p.forks) {
      // The stream log of the last instance is still at the companion's name; earlier ones were moved aside.
      const idx = p.forks.indexOf(f) + 1;
      const file = idx === p.forks.length ? f.streamLog : f.streamLog.replace(/\.log$/, `.before-${idx + 1}.log`);
      const a = analyzeForkLog(file);
      a.pc = p.name;
      a.instance = idx;
      a.exit = f.code;
      a.killedByHarness = f.killedByHarness;
      logs.push(a);
    }
  }
  g.forkLogs = logs;
  const bad = logs.filter((a) => a.exists && (a.keyframeFailed > 0 || a.replayFailed > 0 || a.unresolved > 0 || a.physicsDifferent > 0 || a.errors.length > 0));
  check(g.name, 'the forks closed on WM_CLOSE (or were killed by their own scenario) and exited with code 0', clean && logs.every((a) => a.killedByHarness || a.exit === 0), logs.map((a) => `${a.pc}#${a.instance} exit ${a.exit}${a.killedByHarness ? ' (killed)' : ''}`).join(', '));
  check(
    g.name,
    'fork logs: replayed calls failed 0, unresolved 0, keyframe calls failed 0, own physics state identical after every watch, no ERROR',
    bad.length === 0,
    logs.map((a) => `${a.pc}#${a.instance}: ${a.keyframes} keyframes (${a.keyframeFailed} failed), frames received ${a.received} in ${a.statsLines} stats lines / ${a.sessionFrames} over ${a.sessions} sessions, failed ${a.replayFailed}, unresolved ${a.unresolved}, physics different ${a.physicsDifferent}, back to playing ${JSON.stringify(a.backReasons)}, held ${a.held} served ${a.served}, warnings ${a.warnings.length}, errors ${a.errors.length}`).join(' | '),
  );
  if (g.longWatches) {
    const first = logs.filter((a) => a.instance === 1);
    check(g.name, "the forks' own watch statistics (a line every 5 s): frames received, replayed calls failed 0, unresolved 0", first.length > 0 && first.every((a) => a.statsLines > 0 && a.received > 0 && a.replayFailed === 0 && a.unresolved === 0), first.map((a) => `${a.pc}: ${a.statsLines} stats lines, ${a.received} frames received, failed ${a.replayFailed}, unresolved ${a.unresolved}`).join('; '));
  }
  for (const a of logs) for (const w of [...a.warnings.slice(0, 5), ...a.errors.slice(0, 5)]) log(`   ${a.pc}#${a.instance}: ${w}`);
  return logs;
}

// -------------------------------------------------------------------------------- the groups --
const summary = { groups: {} };

/** Both PCs' forks up on `table`, the match open, each showing the other in 3D. */
async function twoForks(g, a, b, table) {
  const tOpen = now();
  openMatch(g.pcs);
  const fa = await startFork(a, table);
  const fb = await startFork(b, table);
  const channel = await until(() => a.tunnel()?.status().peers[b.name]?.channelOpen === true && b.tunnel()?.status().peers[a.name]?.channelOpen === true, 60_000);
  const both3d = await until(() => a.view(b)?.mode === '3d' && b.view(a)?.mode === '3d', 30_000);
  return { fa, fb, channel, both3d, tOpen };
}

async function groupTwo() {
  const G = 'two';
  const a = makePc(G, 'a');
  const b = makePc(G, 'b');
  const g = newGroup(G, [a, b]);
  try {
    const { fa, fb, channel, both3d } = await twoForks(g, a, b, NUDGE);
    // ---- 1: hello, the stream port, the capability over a real data channel, the decision ----
    const helloRe = /^hello 1 (\S+) (\d+) ([0-9a-f]{16}) (\d+)$/;
    for (const [p, f] of [
      [a, fa],
      [b, fb],
    ]) {
      const m = helloRe.exec(p.hello ?? '');
      check(G, `${p.name}: the fork's hello is accepted (five fields after the word, the fifth a port)`, !!m && p.stream.status().fork === 'ready', `"${p.hello}" after ${round(f.readyMs)} ms; companion: fork ${p.stream.status().fork}, build ${p.stream.status().build}`);
      const port = m ? Number(m[4]) : null;
      check(G, `${p.name}: the port the tunnel serves is the one hello names`, port !== null && p.tunnel()?.status().playerPort === port, `hello ${port}, tunnel playerPort ${p.tunnel()?.status().playerPort}, asked at launch ${f.askedStreamPort}`);
    }
    const sa = a.tunnel()?.status().peers.b;
    check(G, 'a real data channel between the two tunnel pages is open', channel, `a's view of b: path ${sa?.path}, pair ${sa?.pair}, ice ${sa?.ice}`);
    check(G, "the capability reached the other PC over it (tunnel INFO) and both decide 3D", both3d, `a: "${a.view(b)?.line}"; b: "${b.view(a)?.line}"`);
    check(G, 'the lobby sends nothing to either fork', a.rec.every((e) => e.d !== '>') && b.rec.every((e) => e.d !== '>'));

    // ---- 2: the scripted match ----
    await sleep(6000); // both games start (credit, start) before the first turn
    const orders = ['together', 'watch-first', 'play-first', 'together', 'held'];
    let up = a;
    for (let n = 0; n < TURNS + 1; n++) {
      const row = await grant(g, up, n === 0 ? 'together' : orders[n % orders.length]);
      await playFor(g, row, 2500);
      log(rowWords(row));
      up = up === a ? b : a;
    }
    const rows = g.rows;
    const changes = rows.slice(1);
    const watchMs = rows.flatMap((r) => Object.values(r.watchers).map((w) => w.watchingMs));
    const playMs = changes.map((r) => r.playingMs);
    const lockMs = changes.map((r) => r.lockMs);
    const bytes = rows.flatMap((r) => Object.values(r.watchers).map((w) => w.bytes));
    check(G, `${changes.length} turn changes, each ending in state watching on the watcher and state playing on the player`, rows.every((r) => r.ok), rows.filter((r) => !r.ok).map(rowWords).join(' | ') || `watch to state watching ${statsWords(watchMs)}; play to state playing ${statsWords(playMs)}`);
    check(G, 'the lock at each grant is lifted by state playing, never by the 2 s limit', changes.every((r) => r.lockLate === false && r.lockMs !== null && r.lockMs < 2000), `lock wait ${statsWords(lockMs)}`);
    check(G, 'frames flow to the watcher through the tunnel in every turn', bytes.every((v) => v > 0), `bytes into the watcher's fork per 2.5 s turn: min ${Math.min(...bytes)}, max ${Math.max(...bytes)}`);
    for (const o of ['together', 'watch-first', 'play-first', 'held']) {
      const rs = changes.filter((r) => r.order === o);
      check(G, `the hand-over, order "${o}" (${rs.length} turns)`, rs.length > 0 && rs.every((r) => r.ok), `state watching ${statsWords(rs.flatMap((r) => Object.values(r.watchers).map((w) => w.watchingMs)))}; state playing ${statsWords(rs.map((r) => r.playingMs))}; lock ${statsWords(rs.map((r) => r.lockMs))}`);
    }
    summary.groups[G] = { turns: rows.map((r) => ({ ...r, lockMs: round(r.lockMs), playingMs: round(r.playingMs) })), watchMs: stats(watchMs), playMs: stats(playMs), lockMs: stats(lockMs) };

    // Two long turns: the fork's watch role logs what it received and what failed every 5 s.
    const long = [];
    for (let n = 0; n < 2; n++) {
      const row = await grant(g, up, 'together');
      await playFor(g, row, 12_500);
      log(rowWords(row));
      long.push(row);
      up = up === a ? b : a;
    }
    g.longWatches = true;
    check(G, 'two turns of 12 s each way', long.every((r) => r.ok && Object.values(r.watchers).every((w) => w.bytes > 0)), long.map(rowWords).join(' | '));

    // ---- the fork's fix round: of the commands of one read only the last is acted on and answered ----
    {
      const p = g.up;
      const w = p === a ? b : a;
      // The watcher is called back first (as if it held its table), so the watch below starts from its own table.
      w.stream.setTarget(null);
      await until(() => !w.stream.away(), 4000);
      g.turn += 1;
      const key = String(g.turn);
      let lock = null;
      const r = await backToBack(
        w,
        () => w.stream.setTarget(p.name, key),
        () => {
          // The turn comes to this PC the moment it was sent to watch: the lock, then nobody to watch.
          lock = lockAtGrant(w);
          w.stream.setTarget(null);
        },
      );
      const l = await Promise.race([lock ?? Promise.resolve(null), sleep(100).then(() => null)]);
      const watching = r.got.filter((x) => x === 'state watching').length;
      const playing = r.got.filter((x) => x === 'state playing').length;
      check(
        G,
        'watch, then play within the same millisecond: the fork ends on its own table, the lock is lifted by its state playing, and nothing waits for the watch (no fall-back in the 6.5 s after)',
        r.sent.length === 2 && r.sent[0].startsWith('watch ') && r.sent[1] === 'play' && playing === 1 && r.got.at(-1) === 'state playing' && r.got.every((x) => x === 'state watching' || x === 'state playing') && !!l && l.late === false && !w.stream.away() && w.view(p)?.mode === '3d',
        `the two lines left ${r.gapMs?.toFixed(2)} ms apart; the fork answered ${JSON.stringify(r.got)} (${watching === 0 ? 'the watch was not gone through: read in one go' : 'the watch was answered too: read apart'}), first answer after ${round(r.firstAnswerMs)} ms; lock lifted after ${l ? round(l.ms) : '?'} ms; line still "${w.view(p)?.line}"; control: ${r.lines.join(' | ')}`,
      );
      // Back to the turn as it was: the watcher watches the player.
      g.turn += 1;
      const mark = w.mark();
      w.stream.setTarget(p.name, String(g.turn));
      const again = await w.waitRec(mark, (e) => e.d === '<' && e.line === 'state watching', 6000);
      check(G, 'and the same watch asked again right after is answered', !!again, w.since(mark).join(' | '));
    }

    // ---- the control connection cut in the middle of a watch: the same VPX comes back with a new hello ----
    {
      const p = g.up;
      const w = p === a ? b : a;
      await until(() => w.stream.status().watching === p.name && !w.rec.slice(-1)[0]?.line.startsWith('watch '), 5000);
      const portBefore = Number(/ (\d+)$/.exec(w.hello ?? '')?.[1]);
      const mark = w.mark();
      const t0 = now();
      w.cutControl();
      const fell = await until(() => w.stream.status().fork === 'none' && w.stream.status().watching === null, 2000);
      const tFell = now() - t0;
      const hello = await w.waitRec(mark, (e) => e.d === '<' && e.line.startsWith('hello 1 '), 8000);
      const playing = hello ? await w.waitRec(w.rec.indexOf(hello) + 1, (e) => e.d === '<' && e.line === 'state playing', 3000) : null;
      const ready = await until(() => w.stream.status().fork === 'ready', 3000);
      const portAfter = Number(/ (\d+)$/.exec(hello?.line ?? '')?.[1]);
      await sleep(1500);
      const sentMeanwhile = w.rec.slice(mark).filter((e) => e.d === '>').map((e) => e.line);
      check(
        G,
        'the control connection cut in the middle of a watch: 2D at once, the fork is back on its own table by itself, connects again with a new hello (the same stream port), and this turn stays 2D',
        fell && !!hello && !!playing && ready && portAfter === portBefore && w.tunnel()?.status().playerPort === portAfter && sentMeanwhile.length === 0 && w.view(p)?.mode === '2d',
        `2D ${round(tFell)} ms after the cut; ${hello ? `"${hello.line}" ${round(hello.t - t0)} ms after it` : 'NO new hello in 8 s'}; lines sent to the fork meanwhile: ${JSON.stringify(sentMeanwhile)}; line: "${w.view(p)?.line}"; control: ${w.since(mark).join(' | ')}`,
      );
      // The next grant to the same player is 3D again.
      g.turn += 1;
      const mark2 = w.mark();
      w.stream.setTarget(p.name, String(g.turn));
      const again = await w.waitRec(mark2, (e) => e.d === '<' && e.line === 'state watching', 6000);
      check(G, 'and the next grant is watched in 3D over the new control connection', !!again, w.since(mark2).join(' | '));
    }

    // ---- 5b: the tunnel page restarted, on the watcher's PC and then on the player's ----
    for (const which of ['watcher', 'player']) {
      const p = g.up; // the player up
      const w = p === a ? b : a;
      const victim = which === 'watcher' ? w : p;
      await until(() => w.stream.status().watching === p.name, 5000);
      const mark = w.mark();
      const win = tunnelWindow(victim);
      if (!win) {
        check(G, `the tunnel page of the ${which}'s PC restarted`, false, `no window found for ${victim.dir}`);
        continue;
      }
      const t0 = now();
      win.webContents.forcefullyCrashRenderer();
      const lost = await until(() => w.view(p)?.mode === '2d', 8000);
      const tLost = now() - t0;
      const back = await until(() => a.tunnel()?.status().peers.b?.channelOpen === true && b.tunnel()?.status().peers.a?.channelOpen === true && w.view(p)?.mode === '3d', 40_000);
      const tBack = now() - t0;
      // The capability is back while the same player is up: the watch is asked again, within the same turn.
      const again = back ? await w.waitRec(mark, (e) => e.d === '<' && e.line === 'state watching', 15_000) : null;
      const before = w.bytesIn();
      await sleep(2000);
      check(
        G,
        `the tunnel page of the ${which}'s PC is killed during a watch: 2D at once, the page and the data channel come back, and the watch resumes`,
        lost && back && !!again && w.bytesIn() > before,
        `2D after ${round(tLost)} ms; channel and capability back after ${round(tBack)} ms; state watching again ${again ? `${round(again.t - t0)} ms after the kill` : 'NOT seen'}; ${w.bytesIn() - before} B in the 2 s after; the watcher's control lines: ${w.since(mark).join(' | ')}`,
      );
      // A turn change after it works as before.
      const row = await grant(g, w, 'together');
      await playFor(g, row, 2000);
      log(rowWords(row));
      check(G, `a turn change after that page restart`, row.ok, rowWords(row));
    }

    // ---- 4a: the watcher's fork is killed mid-watch ----
    {
      const p = g.up;
      const w = p === a ? b : a;
      await until(() => w.stream.status().watching === p.name, 5000);
      const mark = w.mark();
      const t0 = now();
      await killFork(w);
      const fell = await until(() => w.stream.status().fork === 'none' && w.stream.status().watching === null, 5000);
      check(G, "a watcher's fork killed mid-watch: its PC falls back (no fork, nothing shown in 3D)", fell, `after ${round(now() - t0)} ms; line for the player: "${w.view(p)?.line}"; control: ${w.since(mark).join(' | ')}`);
      const pv = await until(() => p.view(w)?.mode === '2d', 5000);
      check(G, 'the other PC shows that player in 2D from then on (told over the tunnel: no build there)', pv, `${round(now() - t0)} ms after the kill: "${p.view(w)?.line}"`);
      // The turn passes to that PC: its lock is lifted at once (there is no fork to wait for).
      const row = await grant(g, w, 'together');
      check(G, 'the turn lock still lifts for that PC at its grant', row.lockMs !== null && row.lockMs < 100 && row.lockLate === false, `lock lifted after ${round(row.lockMs)} ms; ${rowWords(row)}`);
      // The table is started again: a new fork, a new stream port from its hello, 3D again.
      const f2 = await startFork(w, NUDGE);
      const again3d = await until(() => p.view(w)?.mode === '3d' && w.view(p)?.mode === '3d', 30_000);
      const port = Number(/ (\d+)$/.exec(w.hello ?? '')?.[1]);
      check(G, 'the table started again: a new hello, its new stream port served, 3D both ways again', again3d && w.tunnel()?.status().playerPort === port, `hello "${w.hello}" after ${round(f2?.readyMs)} ms; tunnel playerPort ${w.tunnel()?.status().playerPort}`);
      await sleep(4000);
      const r2 = await grant(g, p, 'together');
      await playFor(g, r2, 2500);
      check(G, 'and a turn change with the new fork works', r2.ok && Object.values(r2.watchers).every((x) => x.bytes > 0), rowWords(r2));
    }

    // ---- 4b: the player's fork is killed while it is watched ----
    {
      const p = g.up;
      const w = p === a ? b : a;
      await until(() => w.stream.status().watching === p.name, 5000);
      const mark = w.mark();
      const t0 = now();
      await killFork(p);
      // Two things race to tell the watcher: its own fork (the stream closed: `state failed closed|lost`), and the
      // player's Castcade, which sees its VPX gone and says so over the tunnel (then this PC calls its fork back).
      const first = await w.waitRec(mark, (e) => (e.d === '<' && /^state failed/.test(e.line)) || (e.d === '>' && e.line === 'play'), 8000);
      const playing = first ? await w.waitRec(w.rec.indexOf(first) + 1, (e) => e.d === '<' && e.line === 'state playing', 4000) : null;
      const twoD = await until(() => w.stream.status().watching === null && w.view(p)?.mode === '2d' && !w.stream.away(), 8000);
      const byFork = first?.d === '<';
      const reason = byFork ? first.line.slice('state failed '.length) : null;
      check(
        G,
        "the player's fork killed while watched: the watcher is back on its own table with the 2D video",
        !!first && !!playing && twoD && (!byFork || /^(closed|lost)$/.test(reason)),
        `${!first ? 'neither a state failed nor a play in 8 s' : byFork ? `the fork said "${first.line}" ${round(first.t - t0)} ms after the kill` : `the player's Castcade told this PC first: play sent ${round(first.t - t0)} ms after the kill`}; ${playing ? `state playing ${round(playing.t - first.t)} ms later` : 'NO state playing'}; line: "${w.view(p)?.line}"; control: ${w.since(mark).join(' | ')}`,
      );
      if (byFork && !/^(closed|lost)$/.test(reason)) forkFinding(G, `after its player was killed the watcher's fork said "${first.line}" (the contract names closed or lost)`, w.since(mark));
      const lock = await grant(g, w, 'together');
      check(G, 'the watcher (now up) has its lock lifted', lock.lockMs !== null && lock.lockLate === false, rowWords(lock));

      // ---- 4b, the other way to lose a player: its whole PC is gone (no word from its Castcade either) ----
      // The fork has to notice by itself here: the stream delivers nothing more (rule 12: stalled after 3 s).
      await startFork(p, NUDGE);
      const again = await until(() => p.view(w)?.mode === '3d' && w.view(p)?.mode === '3d', 30_000);
      await sleep(3000);
      const r = await grant(g, p, 'together');
      await playFor(g, r, 2500);
      const mark2 = w.mark();
      const t1 = now();
      p.muted = true; // nothing of this PC's signalling reaches anyone any more
      tunnelWindow(p)?.webContents.forcefullyCrashRenderer(); // its data connections die without a goodbye
      await killFork(p);
      const failed = await w.waitRec(mark2, (e) => e.d === '<' && /^state failed/.test(e.line), 12_000);
      const back = failed ? await w.waitRec(w.rec.indexOf(failed) + 1, (e) => e.d === '<' && e.line === 'state playing', 4000) : null;
      const plays = w.rec.slice(mark2).filter((e) => e.d === '>' && e.line === 'play').length;
      const shown = await until(() => w.stream.status().watching === null && !w.stream.away(), 6000);
      const why = failed?.line.slice('state failed '.length) ?? null;
      check(
        G,
        "the player's whole PC vanishes while watched (no word from its Castcade): the watcher's fork leaves the watch by itself (state failed, then state playing), 2D",
        again && r.ok && !!failed && !!back && shown && /^(stalled|lost|closed)$/.test(why ?? '') && w.view(p)?.mode === '2d',
        `${failed ? `"${failed.line}" ${round(failed.t - t1)} ms after the PC vanished` : 'no state failed in 12 s'}; ${back ? `state playing ${round(back.t - failed.t)} ms later` : 'NO state playing'}; play lines sent by this PC meanwhile: ${plays}; line: "${w.view(p)?.line}"; control: ${w.since(mark2).join(' | ')}`,
      );
      if (failed && !/^(stalled|lost|closed)$/.test(why ?? '')) forkFinding(G, `after its player's PC vanished the watcher's fork said "${failed.line}"`, w.since(mark2));
      const lock2 = await grant(g, w, 'together');
      check(G, 'and its lock lifts at its own turn after that', lock2.lockMs !== null && lock2.lockLate === false && lock2.lockMs < 100, rowWords(lock2));
    }
  } catch (e) {
    check(G, 'the group ran to its end', false, e?.stack ?? String(e));
  } finally {
    await endGroup(g);
  }
}

async function groupThree() {
  const G = 'three';
  const a = makePc(G, 'a');
  const b = makePc(G, 'b');
  const c = makePc(G, 'c', { forkBeside: false });
  const g = newGroup(G, [a, b, c]);
  try {
    openMatch(g.pcs);
    await startFork(a, NUDGE);
    await startFork(b, NUDGE);
    // c's PC has no Castcade VPX build beside its VPX: the app starts its table in the player's own VPX.
    await startFork(c, NUDGE);
    const ready = await until(() => a.view(b)?.mode === '3d' && b.view(a)?.mode === '3d' && a.view(c)?.mode === '2d' && b.view(c)?.mode === '2d', 60_000);
    check(G, 'the PC without the fork decides 2D for everyone, and the others decide 2D for it', ready && c.view(a)?.mode === '2d' && c.view(b)?.mode === '2d', `a: "${a.view(c)?.line}"; b: "${b.view(c)?.line}"; c: "${c.view(a)?.line}" / "${c.view(b)?.line}"`);
    check(G, "c's own VPX was asked for, not the fork (recorded, not started)", plainRequests.some((r) => r.pc === `${G}/c`), JSON.stringify(plainRequests.filter((r) => r.pc === `${G}/c`)));
    await sleep(5000);
    // A round: a, b, c, a.
    for (const up of [a, b, c, a]) {
      const row = await grant(g, up, 'together');
      await playFor(g, row, 2200);
      log(rowWords(row));
    }
    check(G, 'a round with the 2D PC in it: the two fork PCs watch each other, both are called back while the 2D player is up', g.rows.every((r) => r.ok), g.rows.map(rowWords).join(' | '));
    check(G, "nothing was ever sent to the PC without the fork (no control connection, no watch through its tunnel)", c.rec.length === 0 && (c.tunnel()?.status().watchPort ?? null) === null && c.tunnel()?.status().stats.opened === 0, `control lines ${c.rec.length}; its tunnel: watch listener ${c.tunnel()?.status().watchPort ?? 'never opened'}, streams opened ${c.tunnel()?.status().stats.opened}`);
    await nobodyUp(g);

    // The third PC gets the fork (the build is copied beside its VPX and the table started in it): three forks.
    c.forkBeside = true;
    await startFork(c, NUDGE);
    const all3d = await until(() => [a, b, c].every((p) => [a, b, c].filter((x) => x !== p).every((x) => p.view(x)?.mode === '3d')), 40_000);
    check(G, 'three forks: every PC decides 3D for the two others', all3d, [a, b, c].map((p) => `${p.name}: ${p.stream.status().players.map((x) => x.mode).join('/')}`).join('; '));
    await sleep(5000);
    const from = g.rows.length;
    for (const [up, order] of [
      [a, 'together'],
      [b, 'together'],
      [c, 'watch-first'],
      [a, 'play-first'],
      [b, 'together'],
      [c, 'together'],
    ]) {
      const row = await grant(g, up, order);
      await playFor(g, row, 2500);
      log(rowWords(row));
    }
    const rows = g.rows.slice(from);
    const reaims = rows.flatMap((r) => Object.entries(r.watchers).filter(([, w]) => w.reaim).map(([n, w]) => ({ turn: r.turn, pc: n, ...w })));
    check(G, 'three forks, six turn changes: every watcher ends in state watching, every player in state playing', rows.every((r) => r.ok), rows.filter((r) => !r.ok).map(rowWords).join(' | ') || rows.map(rowWords).join(' | '));
    // A re-aim: the same address as the first watch of that PC (one listener for every player), no play in between.
    const addresses = {};
    for (const p of [a, b, c]) addresses[p.name] = [...new Set(p.rec.filter((e) => e.d === '>' && e.line.startsWith('watch ')).map((e) => e.line))];
    check(G, 'a re-aim when the next player is up: a second watch on the single listener (the same address), with no play between, answered by state watching', reaims.length >= 3 && reaims.every((w) => w.answer === 'state watching' && w.bytes > 0) && Object.values(addresses).every((x) => x.length === 1), `${reaims.length} re-aims: ${reaims.map((w) => `turn ${w.turn} ${w.pc} after ${round(w.watchingMs)} ms, ${w.bytes} B`).join('; ')}; watch addresses per PC ${JSON.stringify(addresses)}`);
    summary.groups[G] = { reaimMs: stats(reaims.map((w) => w.watchingMs)), watchMs: stats(rows.flatMap((r) => Object.values(r.watchers).filter((w) => !w.reaim).map((w) => w.watchingMs))) };

    // ---- the fork's fix round: watch A, then watch B within the same millisecond ----
    {
      const p = g.up; // the player up; the two others watch it
      const [w, other] = g.pcs.filter((x) => x !== p);
      w.stream.setTarget(null);
      await until(() => !w.stream.away(), 4000);
      g.turn += 1;
      const k1 = String(g.turn);
      g.turn += 1;
      const k2 = String(g.turn);
      const before = w.bytesIn();
      // Sent to watch one player, and the turn is the next player's before that line has left the socket's buffer.
      const r = await backToBack(
        w,
        () => w.stream.setTarget(other.name, k1),
        () => w.stream.setTarget(p.name, k2),
      );
      const watching = r.got.filter((x) => x === 'state watching').length;
      check(
        G,
        'watch A, then watch B within the same millisecond: the fork ends watching B, and nothing waits for an answer to A (no fall-back in the 6.5 s after)',
        r.sent.length === 2 && r.sent.every((x) => x.startsWith('watch ')) && watching >= 1 && r.got.every((x) => x === 'state watching') && w.stream.status().watching === p.name && w.view(other)?.mode === '3d' && w.view(p)?.mode === '3d' && w.bytesIn() > before,
        `the two lines left ${r.gapMs?.toFixed(2)} ms apart; the fork answered ${JSON.stringify(r.got)} (${watching === 1 ? 'one answer for the two: read in one go' : 'each answered: read apart'}), first answer after ${round(r.firstAnswerMs)} ms; watching ${w.stream.status().watching}; ${w.bytesIn() - before} B of ${p.name}'s stream in; control: ${r.lines.join(' | ')}`,
      );
    }
  } catch (e) {
    check(G, 'the group ran to its end', false, e?.stack ?? String(e));
  } finally {
    await endGroup(g);
  }
}

async function groupOff() {
  const G = 'off';
  const a = makePc(G, 'a');
  const b = makePc(G, 'b', { setting: 'off' });
  const g = newGroup(G, [a, b]);
  try {
    openMatch(g.pcs);
    await startFork(a, NUDGE);
    // b: 3D watch off from the start: the app starts its table in the player's own VPX (recorded, not started).
    await startFork(b, NUDGE);
    await sleep(3000);
    check(G, '3D watch off from the start and no fork: no tunnel is opened on that PC (no page, no peer connection), and it sends no signal', b.tunnels.length === 0 && b.signals.out === 0, `tunnel ends made on b: ${b.tunnels.length}; signals b sent: ${b.signals.out}; signals a sent to nobody: ${a.signals.out}; b's line: "${b.view(a)?.line}"; a's line: "${a.view(b)?.line}"`);
    check(G, "its table was asked for in the player's own VPX (recorded, not started)", plainRequests.some((r) => r.pc === `${G}/b`));
    const r1 = await grant(g, a, 'together');
    await playFor(g, r1, 1500);
    const r2 = await grant(g, b, 'together');
    await playFor(g, r2, 1500);
    check(G, 'turns with that PC: 2D both ways, nothing sent to any fork', r1.ok && r2.ok && a.rec.every((e) => e.d !== '>'), `${rowWords(r1)} | ${rowWords(r2)}`);
    await nobodyUp(g);

    // ---- 5a: turned on mid-match: the tunnel opens late, against the real page on the other PC ----
    const t0 = now();
    b.setting = 'auto';
    b.stream.setSetting('auto');
    const opened = await until(() => b.tunnels.length === 1 && a.tunnel()?.status().peers.b?.channelOpen === true && b.tunnel()?.status().peers.a?.channelOpen === true, 40_000);
    check(G, 'turned on mid-match: the tunnel opens late and the real pages connect (the other side, whose offer went nowhere, starts over on reset)', opened, `data channel open ${round(now() - t0)} ms after the setting changed; a's restarts of that peer: ${a.tunnel()?.status().peers.b?.restarts}; b's line now: "${b.view(a)?.line}"; a's: "${a.view(b)?.line}"`);
    // The table is started again, in the fork this time.
    const fb = await startFork(b, NUDGE);
    const both = await until(() => a.view(b)?.mode === '3d' && b.view(a)?.mode === '3d', 30_000);
    check(G, 'its table started in the fork: hello, capability, 3D both ways over the late tunnel', both, `hello "${b.hello}" after ${round(fb?.readyMs)} ms; a: "${a.view(b)?.line}"; b: "${b.view(a)?.line}"`);
    await sleep(5000);
    const rows = [];
    for (const up of [a, b, a]) {
      const row = await grant(g, up, 'together');
      await playFor(g, row, 2500);
      log(rowWords(row));
      rows.push(row);
    }
    check(G, 'turn changes over the late tunnel', rows.every((r) => r.ok && Object.values(r.watchers).every((w) => w.bytes > 0)), rows.map(rowWords).join(' | '));

    // ---- off again in the middle of a watch (a is up, b watches) ----
    const mark = b.mark();
    b.setting = 'off';
    b.stream.setSetting('off');
    const play = await b.waitRec(mark, (e) => e.d === '>' && e.line === 'play', 3000);
    const back = play ? await b.waitRec(b.rec.indexOf(play) + 1, (e) => e.d === '<' && e.line === 'state playing', 4000) : null;
    check(G, 'turned off in the middle of a watch: the fork is called back, 2D on that PC', !!play && !!back && b.view(a)?.mode === '2d', `play, then state playing after ${back ? round(back.t - play.t) : '?'} ms; b's line: "${b.view(a)?.line}"`);
    const r3 = await grant(g, b, 'together');
    await playFor(g, r3, 2500);
    check(G, 'the others still watch that PC in 3D (off is for one PC)', r3.ok && r3.watchers.a?.plan === 'watch' && r3.watchers.a.bytes > 0, rowWords(r3));
    const r4 = await grant(g, a, 'together');
    await playFor(g, r4, 1500);
    check(G, 'and it shows them in 2D: nothing is sent to its fork while they are up', r4.ok && r4.watchers.b?.plan !== 'watch', rowWords(r4));
  } catch (e) {
    check(G, 'the group ran to its end', false, e?.stack ?? String(e));
  } finally {
    await endGroup(g);
  }
}

async function groupMismatch() {
  const G = 'mismatch';
  const a = makePc(G, 'a');
  const b = makePc(G, 'b');
  const g = newGroup(G, [a, b]);
  const other = join(TABLES, ROM_TABLE);
  try {
    openMatch(g.pcs);
    await startFork(a, NUDGE);
    await startFork(b, other);
    const decided = await until(() => a.view(b)?.line.includes('another table file') && b.view(a)?.line.includes('another table file'), 60_000);
    check(G, 'two different table files: both PCs decide 2D and say why', decided, `a: "${a.view(b)?.line}" (hello "${a.hello}"); b: "${b.view(a)?.line}" (hello "${b.hello}")`);
    for (const up of [a, b, a]) {
      const row = await grant(g, up, 'together');
      await playFor(g, row, 1500);
    }
    check(G, 'turns on mismatched tables: nothing is sent to either fork, every lock lifts at once', g.rows.every((r) => r.ok && r.lockMs < 100) && a.rec.every((e) => e.d !== '>') && b.rec.every((e) => e.d !== '>'), g.rows.map(rowWords).join(' | '));
  } catch (e) {
    check(G, 'the group ran to its end', false, e?.stack ?? String(e));
  } finally {
    await endGroup(g);
  }
}

async function groupRom() {
  const G = 'rom';
  const a = makePc(G, 'a');
  const b = makePc(G, 'b');
  const g = newGroup(G, [a, b]);
  const table = join(TABLES, ROM_TABLE);
  try {
    const { fa, fb, both3d } = await twoForks(g, a, b, table);
    check(G, `a ROM table (${ROM_TABLE}): both forks say hello and both PCs decide 3D`, both3d, `a: "${a.hello}" after ${round(fa?.readyMs)} ms; b: "${b.hello}" after ${round(fb?.readyMs)} ms`);
    await sleep(22_000); // the ROM boots, the scripted games start
    let up = a;
    for (let n = 0; n < 9; n++) {
      const row = await grant(g, up, ['together', 'watch-first', 'play-first'][n % 3]);
      await playFor(g, row, 3000);
      log(rowWords(row));
      up = up === a ? b : a;
    }
    const rows = g.rows;
    const bytes = rows.flatMap((r) => Object.values(r.watchers).map((w) => w.bytes));
    check(G, `${rows.length - 1} turn changes on the ROM table`, rows.every((r) => r.ok) && bytes.every((v) => v > 0), `state watching ${statsWords(rows.flatMap((r) => Object.values(r.watchers).map((w) => w.watchingMs)))}; state playing ${statsWords(rows.slice(1).map((r) => r.playingMs))}; lock ${statsWords(rows.slice(1).map((r) => r.lockMs))}; bytes per turn min ${Math.min(...bytes)} max ${Math.max(...bytes)}${rows.every((r) => r.ok) ? '' : ` | ${rows.filter((r) => !r.ok).map(rowWords).join(' | ')}`}`);
    summary.groups[G] = { watchMs: stats(rows.flatMap((r) => Object.values(r.watchers).map((w) => w.watchingMs))), playMs: stats(rows.slice(1).map((r) => r.playingMs)), lockMs: stats(rows.slice(1).map((r) => r.lockMs)) };
  } catch (e) {
    check(G, 'the group ran to its end', false, e?.stack ?? String(e));
  } finally {
    await endGroup(g);
  }
}

/** A fork that never starts, through the app's own one-step and launcher; only the process spawner is the harness's. */
async function groupNoStart() {
  const G = 'nostart';
  for (const [how, what, name] of [
    ['enoent', 'the exe is gone by the time it is started (the error arrives after spawn() returned)', 'a'],
    ['notprogram', 'a file that is not a program', 'b'],
    ['exits', 'a process that ends at once (exit code 3)', 'c'],
  ]) {
    const a = makePc(G, name);
    const g = newGroup(G, [a]);
    const requests = [];
    const lines = [];
    try {
      openMatch(g.pcs);
      const notAProgram = join(a.dir, 'not-a-program.exe');
      writeFileSync(notAProgram, 'this is a text file, not a program\r\n');
      const launcher = createVpxLauncher({
        spawn: (command, args, options) => {
          if (command !== FORK_AS_APP_NAMES_IT) {
            // The player's own VPX: never started here. What the app asked for is kept.
            requests.push({ command, args: [...args], env: options.env ? Object.keys(options.env).filter((k) => /^CASTCADE_/.test(k)) : [] });
            return { pid: undefined, unref: () => undefined, on: () => undefined };
          }
          if (how === 'enoent') return spawn(join(a.dir, 'gone.exe'), [...args], { cwd: a.dir, stdio: 'ignore' });
          if (how === 'notprogram') return spawn(notAProgram, [...args], { cwd: a.dir, stdio: 'ignore' });
          return spawn(join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'cmd.exe'), ['/c', 'exit', '3'], { cwd: a.dir, stdio: 'ignore', windowsHide: true });
        },
        exists: async () => true,
        exe: () => PLAIN_EXE,
        log: (l) => lines.push(l),
      });
      const status = { role: 'host', phase: 'lobby', code: 'HARNES', invite: 'HARNES' };
      const one = createOneStep({
        match: { host: async () => status, join: async () => status, status: () => status, onStatus: () => () => undefined, hostGame: () => null, tableLaunch: () => a.host.launch('auto') },
        witness: { status: () => ({ currentTable: null }), onStatus: () => () => undefined },
        launcher,
        clipboard: { writeText: () => undefined },
        tables: async () => [{ tableId: 'Nudge Test and Calibration', vpxPath: NUDGE, infoName: null, rom: null, sha256: null, imported: false, lastPlayedAt: null, patchedAt: null }],
        log: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
      });
      const t0 = now();
      await one.host({ tablePath: NUDGE, startTable: true, ballsPerGame: 3, displayName: 'Harness' });
      const fell = await until(() => requests.length === 1, 9000);
      const ms = now() - t0;
      one.stop();
      for (const l of lines) log(`   ${a.name}: ${l}`);
      check(G, `the fork never starts: ${what}: the app notices and starts the table in the player's own VPX (recorded, not started)`, fell && requests[0].command === PLAIN_EXE && requests[0].args.join(' ') === `-Play ${NUDGE}` && requests[0].env.length === 0 && lines.some((l) => l.includes('the Castcade VPX build did not start')), `${fell ? `${round(ms)} ms after Host` : 'NO request for the own VPX within 9 s'}: ${JSON.stringify(requests)}`);
      if (fell) plainRequests.push({ pc: `${G}/${a.name}`, table: NUDGE, why: `the fork did not start (${how})`, started: false });
      await sleep(500);
      check(G, `and that PC shows 2D (${how})`, a.stream.status().fork === 'none', `fork ${a.stream.status().fork}; control lines ${a.rec.length}`);
    } catch (e) {
      check(G, `the nostart case "${how}" ran to its end`, false, e?.stack ?? String(e));
    } finally {
      await a.stream?.close().catch(() => undefined);
      await a.host.stop().catch(() => undefined);
    }
  }
}

// --------------------------------------------------------------------------------------- main --
async function main() {
  log(`match-stream-harness: out ${out}; fork ${CCMATCH}; electron ${process.versions.electron} (${process.execPath}); groups ${ONLY.join(', ')}; ${TURNS} turn changes`);
  for (const f of [CCMATCH, TEMPLATE, NUDGE, CLOSER]) if (!existsSync(f)) throw new Error(`missing: ${f}`);
  if (/^vpinballx/i.test(CCMATCH.split(/[\\/]/).pop())) throw new Error('the fork must run under a name that does not start with VPinballX (the installed Castcade would take it for a game)');
  const t0 = now();
  const groups = { two: groupTwo, three: groupThree, off: groupOff, mismatch: groupMismatch, rom: groupRom, nostart: groupNoStart };
  for (const name of ONLY) {
    if (!groups[name]) throw new Error(`no such group: ${name}`);
    log(`==== group ${name} ====`);
    const g0 = now();
    await groups[name]();
    log(`==== group ${name} done in ${Math.round((now() - g0) / 1000)} s ====`);
    await sleep(1500);
  }
  const failed = results.filter((r) => !r.ok);
  log('');
  log('================ SUMMARY ================');
  for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'} [${r.group}] ${r.name}`);
  log('');
  for (const [name, s] of Object.entries(summary.groups)) {
    const w = (x) => (x ? `min ${x.min} / median ${x.median} / p90 ${x.p90} / max ${x.max} ms (n ${x.n})` : 'none');
    if (s.watchMs) log(`times [${name}] watch sent -> state watching: ${w(s.watchMs)}`);
    if (s.reaimMs) log(`times [${name}] re-aim (second watch) -> state watching: ${w(s.reaimMs)}`);
    if (s.playMs) log(`times [${name}] play sent -> state playing: ${w(s.playMs)}`);
    if (s.lockMs) log(`times [${name}] grant -> lock lifted: ${w(s.lockMs)}`);
  }
  log(`the player's own VPX was asked for ${plainRequests.length} time(s) and never started: ${plainRequests.map((r) => `${r.pc} (${r.why})`).join('; ') || 'none'}`);
  log(`fork findings (behaviour the contract does not say): ${forkFindings.length}`);
  for (const f of forkFindings) log(`   [${f.group}] ${f.what}`);
  log(`${results.length - failed.length} of ${results.length} checks passed in ${Math.round((now() - t0) / 1000)} s; ${failed.length ? 'HARNESS FAILED' : 'HARNESS OK'}`);
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ ok: failed.length === 0, results, times: summary.groups, plainRequests, forkFindings, pids }, null, 2));
  return failed.length === 0 ? 0 : 1;
}

app.on('window-all-closed', () => {
  /* hidden pages only: keep running */
});
void app
  .whenReady()
  .then(main)
  .then(
    (code) => app.exit(code),
    (e) => {
      log(`harness failed: ${e?.stack ?? e}`);
      app.exit(3);
    },
  );
