#!/usr/bin/env node
// D10.0.1 GStreamer candidate runner: receiver, then (unless --direct) the WHIP proxy, then the sender; waits
// for both to exit; prints the CSV tails. Sets the portable runtime's PATH / GST_PLUGIN_PATH for the children.
//   node run.mjs [--duration 90] [--direct] [--s 27410 --c 27411] [--out ../results/<stamp>-gstreamer]
//                [--harness <dll>] [--encoder nvh264enc] [--decoder nvh264dec] [--start-kbps 20000] [--max-kbps 20000]
//                [--mitigation none] [--exe target/release/spike-gst.exe]
// measure.mjs template: node spike/d10-video/gstreamer/run.mjs --s {S} --c {C} --duration {DUR} --out {OUT}
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProxy } from './whip-proxy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);

const gstRoot = resolve(here, '..', 'deps', 'gstreamer', '1.0', 'msvc_x86_64');
const env = { ...process.env, PATH: `${join(gstRoot, 'bin')};${process.env.PATH}`, GST_PLUGIN_PATH: join(gstRoot, 'lib', 'gstreamer-1.0'), GST_REGISTRY: resolve(here, '..', 'deps', 'gstreamer', 'registry.bin'), GSTREAMER_1_0_ROOT_MSVC_X86_64: gstRoot };
if (process.env.GST_DEBUG) env.GST_DEBUG = process.env.GST_DEBUG;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(opt('out', join(here, '..', 'results', `${stamp}-gstreamer`)));
const exe = resolve(opt('exe', join(here, 'target', 'release', 'spike-gst.exe')));
const duration = opt('duration', '90');
const direct = flag('direct');
const S = Number(opt('s', 27410)), C = Number(opt('c', 27411));
const listen = 'http://127.0.0.1:8080';
const proxyPort = 8090;
const common = ['--duration', duration, '--out', out];
for (const k of ['harness', 'encoder', 'decoder', 'start-kbps', 'min-kbps', 'max-kbps', 'mitigation', 'strip-block', 'local-ip']) if (opt(k)) common.push(`--${k}`, opt(k));

if (!existsSync(exe)) { console.error(`missing ${exe}: build with cargo build --release (env.ps1 dot-sourced)`); process.exit(2); }
const run = (name, a) => { console.log(`${name}: ${exe} ${a.join(' ')}`); const p = spawn(exe, a, { env, stdio: 'inherit', cwd: here }); return p; };

const receiver = run('receiver', ['receiver', '--listen', listen, '--port-min', '27500', '--port-max', '27500', ...common]);
await new Promise((r) => setTimeout(r, 1500));
let proxy = null;
if (!direct) proxy = startProxy({ listen: proxyPort, upstream: listen, s: S, c: C });
const endpoint = direct ? `${listen}/whip/endpoint` : `http://127.0.0.1:${proxyPort}/whip/endpoint`;
const sender = run('sender', ['sender', '--endpoint', endpoint, '--port-min', '27510', '--port-max', '27510', ...common]);

const senderCode = await new Promise((r) => sender.on('exit', r));
console.log(`sender exited ${senderCode}`);
const receiverCode = await Promise.race([new Promise((r) => receiver.on('exit', r)), new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
if (receiverCode === 'timeout') receiver.kill();
console.log(`receiver exited ${receiverCode}`);
proxy?.close();
for (const side of ['sender', 'receiver']) {
  const f = `${out}-${side}.csv`;
  if (!existsSync(f)) { console.log(`${f}: missing`); continue; }
  const lines = readFileSync(f, 'utf8').trim().split(/\r?\n/);
  console.log(`--- ${f} (${lines.length - 1} rows)\n${[lines[0], ...lines.slice(-6)].join('\n')}`);
}
