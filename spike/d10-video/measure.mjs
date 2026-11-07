#!/usr/bin/env node
// D10.0.1 measurement runner (lead-only; one GPU). Two modes:
//   node measure.mjs run --candidate str0m --cmd "<cmd with {S} {C} {DUR} {OUT}>" [--shaper "<cmd with {S} {C} {SCHED} {LOG}>"]
//       starts the shaper, then the candidate; waits for exit; then summarizes.
//   node measure.mjs summarize --candidate str0m --sender <csv> --receiver <csv> [--shaper-log <csv>] [--exe <path>] [--loc <n>]
// CSV columns are the README's; the reducer finds them by header name, extra columns are ignored.
// Writes results/<stamp>-<candidate>.json and rebuilds results/RESULTS.md from every JSON in results/.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const results = join(here, 'results');
const args = process.argv.slice(2);
const mode = args.shift();
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

const SCHEDULE = opt('schedule', '20000:30,2000:20,20000:40');
const DROP_AT = 30, RESTORE_AT = 50, DURATION = Number(opt('duration', 90));
const S = Number(opt('s', 27410)), C = Number(opt('c', 27411));

function csv(path) {
  if (!path || !existsSync(path)) return [];
  const [head, ...rows] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',').map((s) => s.trim());
  return rows.filter(Boolean).map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], isNaN(Number(v)) ? v.trim() : Number(v)])));
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function reduce(candidate, sender, receiver, shaper, extra) {
  const rx = csv(receiver), tx = csv(sender), sh = csv(shaper);
  const t0 = rx.length ? rx[0].t : 0;
  const at = (rows, from, to) => rows.filter((r) => r.t - t0 >= from && r.t - t0 < to);
  const phase1 = at(rx, 5, DROP_AT), phase2 = at(rx, DROP_AT, RESTORE_AT), phase3 = at(rx, RESTORE_AT, DURATION);
  // settle: first second after the drop from which 5 consecutive seconds have no freeze > 500 ms
  let settle = null;
  for (let i = 0; i + 5 <= phase2.length; i++) if (phase2.slice(i, i + 5).every((r) => (r.freeze_ms_max ?? 0) <= 500)) { settle = phase2[i].t - t0 - DROP_AT; break; }
  let recover = null;
  for (let i = 0; i + 3 <= phase3.length; i++) if (phase3.slice(i, i + 3).every((r) => r.fps >= 55 && r.kbps_received >= 15000)) { recover = phase3[i].t - t0 - RESTORE_AT; break; }
  const out = {
    candidate, stamp: new Date().toISOString(), schedule: SCHEDULE, sender, receiver, shaper,
    encoder: tx.find((r) => r.encoder)?.encoder ?? null,
    fps_held_p1_median: med(phase1.map((r) => r.fps)), fps_min_p1: phase1.length ? Math.min(...phase1.map((r) => r.fps)) : null,
    kbps_p1_avg: avg(phase1.map((r) => r.kbps_received)), kbps_p2_avg: avg(phase2.map((r) => r.kbps_received)), kbps_p3_avg: avg(phase3.map((r) => r.kbps_received)),
    fps_p2_median: med(phase2.map((r) => r.fps)), fps_p3_median: med(phase3.map((r) => r.fps)),
    longest_freeze_ms_after_drop: Math.max(0, ...[...phase2, ...phase3].map((r) => r.freeze_ms_max ?? 0)),
    settle_s_after_drop: settle, recover_s_after_restore: recover,
    frames_delivered: rx.at(-1)?.frames_delivered ?? null, decode_failures: rx.filter((r) => r.decode_ok === 0).length,
    enc_cost_us_avg: avg(tx.map((r) => r.enc_cost_us_avg).filter((v) => typeof v === 'number')),
    rtt_ms_p2_max: Math.max(0, ...at(tx, DROP_AT, RESTORE_AT).map((r) => r.rtt_ms ?? 0)),
    shaper_dropped_total: sh.at(-1)?.dropped ?? null,
    exe_bytes: extra.exe && existsSync(extra.exe) ? statSync(extra.exe).size : null, loc: extra.loc ? Number(extra.loc) : null,
    notes: extra.notes ?? '',
  };
  const file = join(results, `${out.stamp.replace(/[:.]/g, '-')}-${candidate}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  rebuild();
  console.log(JSON.stringify(out, null, 2));
  return out;
}

function rebuild() {
  const all = readdirSync(results).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(results, f), 'utf8')));
  const f = (v, d = 1) => (v == null ? '—' : typeof v === 'number' ? Number(v.toFixed(d)) : v);
  const lines = ['# D10.0.1 results', '', `Protocol: ${SCHEDULE} (kbps:s), target 1354x1440 at 60 fps; reduced by measure.mjs. One row per run, newest last.`, '',
    '| run | candidate | encoder | fps held (p1 median / min) | kbps p1 / p2 / p3 | longest freeze after drop | settle after drop | recover after restore | fps p2 / p3 | enc µs | exe MB | LOC | notes |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of all.sort((a, b) => a.stamp.localeCompare(b.stamp)))
    lines.push(`| ${r.stamp.slice(0, 16)} | ${r.candidate} | ${f(r.encoder)} | ${f(r.fps_held_p1_median)} / ${f(r.fps_min_p1)} | ${f(r.kbps_p1_avg, 0)} / ${f(r.kbps_p2_avg, 0)} / ${f(r.kbps_p3_avg, 0)} | ${f(r.longest_freeze_ms_after_drop, 0)} ms | ${f(r.settle_s_after_drop)} s | ${f(r.recover_s_after_restore)} s | ${f(r.fps_p2_median)} / ${f(r.fps_p3_median)} | ${f(r.enc_cost_us_avg, 0)} | ${r.exe_bytes ? (r.exe_bytes / 1048576).toFixed(1) : '—'} | ${f(r.loc)} | ${r.notes} |`);
  writeFileSync(join(results, 'RESULTS.md'), lines.join('\n') + '\n');
}

function fill(s, map) { return Object.entries(map).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), s); }

if (mode === 'summarize') {
  reduce(opt('candidate'), opt('sender'), opt('receiver'), opt('shaper-log'), { exe: opt('exe'), loc: opt('loc'), notes: opt('notes') });
} else if (mode === 'run') {
  const candidate = opt('candidate'); const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join(results, `${stamp}-${candidate}`); const shaperLog = `${out}-shaper.csv`;
  const shaperCmd = fill(opt('shaper', `node ${join(here, 'shaper', 'shaper.mjs')} --s {S} --c {C} --schedule {SCHED} --log {LOG} --start-on-first-packet`), { S, C, SCHED: SCHEDULE, LOG: shaperLog });
  const cmd = fill(opt('cmd'), { S, C, DUR: DURATION, OUT: out });
  console.log(`shaper: ${shaperCmd}\ncandidate: ${cmd}`);
  const shaper = spawn(shaperCmd, { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((r) => setTimeout(r, 1000));
  const cand = spawn(cmd, { shell: true, stdio: 'inherit' });
  const code = await new Promise((r) => cand.on('exit', r));
  shaper.kill();
  console.log(`candidate exited ${code}`);
  reduce(candidate, `${out}-sender.csv`, `${out}-receiver.csv`, shaperLog, { exe: opt('exe'), loc: opt('loc'), notes: opt('notes') });
} else {
  console.error('usage: measure.mjs run|summarize ...'); process.exit(2);
}
