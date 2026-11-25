// A17 step 9 (2026-11-27): screenshots of the story pages, one PNG per state, without Electron and without a window.
// It starts the story dev server (127.0.0.1 only, on a free port) and one headless Edge or Chrome with a profile folder of its own
// (so it never joins a browser that is already open), drives that browser over its DevTools connection (loopback,
// a port the browser picks), and closes both again. No dependency: Node's own WebSocket.
//
//   cd companion && node renderer/story/shoot.mjs <out folder> [name filter]
//
// The list of pictures is shots.ts. Each is taken as tall as its page, so nothing is cut off; the ones marked
// `window` are also taken at the app's own window sizes (420 x 640 as it opens, 380 x 520 at its smallest).
// STORY_BROWSER names another browser exe.
/* global WebSocket */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? 'story-shots');
const filter = process.argv[3] ?? '';
const BROWSERS = [
  process.env.STORY_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];
const exe = BROWSERS.find((p) => p && existsSync(p));
if (!exe) throw new Error('no Edge or Chrome found: set STORY_BROWSER to a Chromium browser exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The headless browser and a `send(method, params, session?)` over its DevTools connection. */
async function openBrowser(profile) {
  spawn(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  // The browser writes the port it took and the path of its own connection into its profile folder.
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !existsSync(portFile); i += 1) await sleep(100);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok);
    ws.addEventListener('error', fail);
  });
  let next = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.fail(new Error(m.error.message));
    else w.ok(m.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      next += 1;
      waiting.set(next, { ok, fail });
      ws.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, closed: () => new Promise((ok) => ws.addEventListener('close', ok)) };
}

const pieces = Number(process.env.STORY_PIECES ?? 0);
mkdirSync(pieces > 0 ? join(out, 'pieces') : out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'castcade-story-'));
// The final review (2026-11-28, finding 16): a port of its own. 5199 (the story server's own, for a person's browser)
// may be another program's on this PC; the pictures would then be of that program's pages, or the run would fail.
const port = await new Promise((ok, fail) => {
  const probe = createNetServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => ok(free));
  });
});
const server = await createServer({ configFile: join(here, 'vite.config.mjs'), logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true, open: false } });
await server.listen();
// The list is TypeScript beside the fixtures it names: the story server reads it.
// STORY_SHEETS=1: the side-by-side sheets in place of the single pictures.
const shots = await server.ssrLoadModule('/story/shots.ts');
const SHOTS = process.env.STORY_SHEETS ? shots.SHEETS : shots.SHOTS;
const index = [];
const browser = await openBrowser(profile);
try {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => browser.send(method, params, sessionId);
  const size = (width, height) => page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const value = async (expression) => (await page('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  for (const shot of SHOTS) {
    if (filter && !shot.name.includes(filter)) continue;
    const width = shot.width ?? 420;
    const low = shot.height ?? 640;
    await size(width, low);
    // A page left behind by the shot before would answer for this one: start from an empty page.
    await page('Page.navigate', { url: 'about:blank' });
    await page('Page.navigate', { url: `http://127.0.0.1:${port}/story/${shot.page}` });
    // The page says how tall it is once it has drawn (and pressed what the shot asks it to press).
    let tall = 0;
    for (let i = 0; i < 200 && !(tall > 0); i += 1) {
      await sleep(50);
      tall = Number((await value('document.documentElement.dataset.tall')) ?? 0);
    }
    if (!(tall > 0)) throw new Error(`${shot.name}: the page did not draw`);
    const sizes = [[shot.name, width, Math.max(low, tall)]];
    if (shot.window) sizes.push([`${shot.name}@420x640`, 420, 640], [`${shot.name}@380x520`, 380, 520]);
    for (const [name, w, h] of sizes) {
      // The final review (finding 9): the window keeps a window's height, and the picture is taken of the page's own
      // height beyond it. The window was made as tall as the page and the picture taken 120 ms later: now and then
      // the page was not drawn again by then, and the picture held it three times, one under the other
      // (tab-resume-v1.png). Two frames are waited for as well.
      await size(w, Math.min(h, 900));
      await page('Runtime.evaluate', { expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', awaitPromise: true });
      await sleep(60);
      const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
      writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'));
      index.push(`${name}.png\t${shot.says}${name.includes('@') ? ` (the window at ${w} x ${h}: what is seen without scrolling)` : ''}`);
      process.stdout.write(`${name}.png ${w}x${h}\n`);
      // STORY_PIECES=900: a tall picture also in pieces of that height (in pieces/), for a reader that shrinks a long image.
      for (let y = 0, n = 1; pieces > 0 && h > pieces && y < h; y += pieces, n += 1) {
        const part = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: w, height: Math.min(pieces, h - y), scale: 1 } });
        writeFileSync(join(out, 'pieces', `${name}.${n}.png`), Buffer.from(part.data, 'base64'));
      }
    }
  }
} finally {
  const gone = browser.closed();
  await browser.send('Browser.close').catch(() => undefined);
  await Promise.race([gone, sleep(5000)]);
  await server.close();
  // The final review (finding 16): the browser's last process lets go of its profile folder a moment after it
  // closes, and a short run was over before it had. The folder is tried for until it is gone (20 s at most); a
  // folder that stays fails the run, and says where it is.
  let removed = false;
  for (let i = 0; i < 40 && !removed; i += 1) {
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
      removed = !existsSync(profile);
    } catch {
      removed = false;
    }
  }
  if (!removed) {
    process.stderr.write(`the browser's profile folder could not be removed: ${profile}\n`);
    process.exitCode = 1;
  }
}
if (!filter) writeFileSync(join(out, 'index.txt'), `${index.join('\n')}\n`);
