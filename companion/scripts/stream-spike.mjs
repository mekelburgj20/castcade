// D1.0 spike (docs/design/solo-streaming-and-recording.md §4): capture the VPX window with ffmpeg (ddagrab → NVENC/AMF/QSV),
// game audio through Electron's loopback capture piped in as raw PCM, a live overlay line, an MP4 and optionally an RTMP push.
//
//   npm run spike:stream -w companion -- [--seconds 120] [--preset 720p30|1080p30|1080p60] [--mic ["name"]] [--desktop]
//   [--game-volume 50] [--mic-volume 300]  (percent)   [--av-late -145]  (ms the audio trails the picture, negative = early; --desktop --sync-test measures it)   [--portrait 10 | --landscape]  (vertical slice shift %, + = right; default vertical, 10)
//   [--preview]  shows what the stream would carry (same crop, scale and overlay) in an ffplay window, and nothing is
//   recorded or sent: adjust --portrait N / --landscape / --preset until it looks right, close it (Q), then run again
//   without --preview and with the same options.
//   [--rotate 90|180|270]  turn the picture clockwise: for VPX in cabinet mode on a monitor Windows calls landscape
//   but that stands portrait (VPX draws the table on its side; the stream turns it back). Check it with --preview.
//   [--bundled]  use the build the installer ships (companion/resources/ffmpeg, `npm run fetch-ffmpeg -w companion`)
//   instead of the ffmpeg / ffplay on PATH.
//   Start it before or after the game: it waits up to 3 minutes for VPX's player window.
//   RTMP: set CASTCADE_RTMP_URL (e.g. rtmp://live.twitch.tv/app/<key>) in the environment; it is never printed.
//
// Start VPX with a table first (windowed or fullscreen). --desktop captures 1280x720 of monitor 0 instead (no VPX needed).
// Prints one `D1.0 | ...` line at the end to paste back. Output: tmp/d1-spike/<timestamp>.mp4 (gitignored).
import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } from 'electron';
import { Buffer } from 'node:buffer';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureArgs, ENCODER_PREFERENCE, ffplayPreviewArgs, outputSize, PRESETS, redactRtmp } from '../dist/media/ffmpeg-args.js';
import { spawnFfmpeg } from '../dist/media/ffmpeg-pipeline.js';
import { resolveFfmpeg } from '../dist/media/ffmpeg-path.js';
import { cropFor, pickPlayfield, portraitSlice, previewPlacement, probeWindows } from '../dist/media/window-geometry.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const seconds = Number(opt('seconds', '120'));
const preset = PRESETS[opt('preset', '720p30')];
if (!preset) throw new Error('unknown --preset');
const rtmp = process.env.CASTCADE_RTMP_URL || null;
// `--mic` = the Windows default input; `--mic "Shure"` = the first input whose name contains that text.
const micArg = opt('mic', '');
const micName = micArg.startsWith('--') ? '' : micArg;
// Mix levels in percent: --game-volume 50 --mic-volume 300 (defaults).
// How far the loopback audio trails the picture: positive is cut from its start, negative delays it (re-measured
// 2026-10-28 with --sync-test after the capture became grab → mux: about 110 ms early; about 145 once the grab became
// a lavfi input, D1.9).
const avLateMs = Number(opt('av-late', '-145'));
const gameVolume = Number(opt('game-volume', '50'));
const micVolume = Number(opt('mic-volume', '300'));
if (!(gameVolume >= 0 && micVolume >= 0)) throw new Error('--game-volume / --mic-volume take a percentage');
const outDir = resolve(here, '../../tmp/d1-spike');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const mp4 = join(outDir, `${stamp}.mp4`);
const overlayFile = join(outDir, 'overlay.txt');
const log = (...a) => console.log('[spike]', ...a);
const rotate = Number(opt('rotate', '0'));
if (![0, 90, 180, 270].includes(rotate)) throw new Error('--rotate takes 0, 90, 180 or 270');
// --bundled: the installer's pinned build (D1.6); otherwise whatever is on PATH.
const ffLoc = resolveFfmpeg({ packaged: false, resourcesPath: '', companionDir: resolve(here, '..') });
if (flag('bundled') && ffLoc.source !== 'bundled') throw new Error('--bundled: no build in companion/resources/ffmpeg (npm run fetch-ffmpeg -w companion)');
const FFMPEG = flag('bundled') ? ffLoc.ffmpeg : 'ffmpeg';
const FFPLAY = flag('bundled') ? ffLoc.ffplay : 'ffplay';
const ffBuild = flag('bundled') ? ffLoc.build : 'path';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function pickEncoder() {
  for (const e of ENCODER_PREFERENCE) {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', e, '-f', 'null', '-'], { windowsHide: true });
    if (r.status === 0) return e;
  }
  throw new Error('no working H.264 encoder (is ffmpeg on PATH?)');
}

const RENDERER = `<!doctype html><meta charset="utf-8"><script>
const { ipcRenderer } = require('electron');
const WORKLET = \`class P extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const i = inputs[0];
    const l = i && i[0] ? i[0] : new Float32Array(128);
    const r = i && i[1] ? i[1] : l;
    const out = new Float32Array(l.length * 2);
    for (let k = 0; k < l.length; k++) { out[2 * k] = l[k]; out[2 * k + 1] = r[k]; }
    this.buf.push(out); this.n += l.length;
    if (this.n >= 1024) { // ~21 ms per IPC message, as the app (src/main/stream-host.ts)
      const all = new Float32Array(this.n * 2); let o = 0;
      for (const b of this.buf) { all.set(b, o); o += b.length; }
      this.port.postMessage(all.buffer, [all.buffer]); this.buf = []; this.n = 0;
    }
    return true;
  }
}
registerProcessor('pcm', P);\`;
(async () => {
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audio = display.getAudioTracks();
    ipcRenderer.send('status', { loopbackTracks: audio.length, label: audio[0] ? audio[0].label : null });
    if (!${JSON.stringify(flag('keep-video-track'))}) display.getVideoTracks().forEach((t) => t.stop());
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
    const node = new AudioWorkletNode(ctx, 'pcm', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    node.port.onmessage = (e) => ipcRenderer.send('pcm', new Uint8Array(e.data));
    // Game (loopback) and voice levels: the game is mixed hot, a headset mic quiet (rig run 3), so the game is
    // turned down and the voice compressed and turned up.
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    limiter.connect(node);
    const gameGain = new GainNode(ctx, { gain: ${gameVolume} / 100 });
    gameGain.connect(limiter);
    if (audio.length) ctx.createMediaStreamSource(new MediaStream(audio)).connect(gameGain);
    if (${JSON.stringify(flag('mic'))}) {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop())); // unlocks device labels
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      ipcRenderer.send('status', { microphones: inputs.map((d) => d.label) });
      const want = ${JSON.stringify(micName)};
      const pick = want ? inputs.find((d) => d.label.toLowerCase().includes(want.toLowerCase())) : null;
      if (want && !pick) ipcRenderer.send('status', { error: 'no microphone matching ' + want + '; using the Windows default' });
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { ...(pick ? { deviceId: { exact: pick.deviceId } } : {}), echoCancellation: false, noiseSuppression: true } });
      const comp = new DynamicsCompressorNode(ctx, { threshold: -30, knee: 10, ratio: 4, attack: 0.005, release: 0.2 });
      const micGain = new GainNode(ctx, { gain: ${micVolume} / 100 });
      ctx.createMediaStreamSource(mic).connect(comp).connect(micGain).connect(limiter);
      ipcRenderer.send('status', { mic: mic.getAudioTracks()[0].label, gameVolume: ${gameVolume}, micVolume: ${micVolume} });
    }
    await ctx.resume();
    ipcRenderer.send('status', { audioContext: ctx.state, sampleRate: ctx.sampleRate });
  } catch (e) { ipcRenderer.send('status', { error: String(e) }); }
})();
</script>`;

app.whenReady().then(async () => {
  // 1. Where to capture.
  let crop;
  let target = 'desktop';
  let outputs = [];
  if (flag('desktop')) {
    crop = { outputIdx: 0, offsetX: 0, offsetY: 0, width: 1280, height: 720 };
    if (flag('preview')) outputs = (await probeWindows()).outputs;
  } else {
    // Wait for a game: the editor window alone is not the playfield.
    let probe = await probeWindows();
    let pf = pickPlayfield(probe.windows);
    for (let waited = 0; !pf && waited < 180; waited += 3) {
      if (waited === 0) log('waiting for a game: start the table in VPX (up to 3 minutes)...');
      await new Promise((r) => setTimeout(r, 3000));
      probe = await probeWindows();
      pf = pickPlayfield(probe.windows);
    }
    log('outputs', JSON.stringify(probe.outputs.map((o) => ({ idx: o.index, device: o.device, at: o.desktop }))));
    log('VPX windows', JSON.stringify(probe.windows.map((w) => ({ title: w.title, client: w.client }))));
    if (!pf) {
      log('no game window ("Visual Pinball Player") found: start a table first (or use --desktop)');
      app.exit(2);
      return;
    }
    // Let a fullscreen or VR player settle before Desktop Duplication starts (a mode change ends the capture).
    await new Promise((r) => setTimeout(r, 5000));
    probe = await probeWindows();
    pf = pickPlayfield(probe.windows) ?? pf;
    crop = cropFor(pf, probe.outputs);
    outputs = probe.outputs;
    target = `"${pf.title}"`;
    if (!crop) {
      log('the VPX window is not on any DXGI output of the default adapter');
      app.exit(2);
      return;
    }
  }
  // Vertical by default (owner's pick, 2026-10-25): a 9:16 slice of the game window, moved right by 10 % of its width.
  // --portrait N changes the shift (+ = right, - = left); --landscape films the whole window. Not with --desktop.
  if (!flag('landscape') && !flag('desktop')) {
    const s = opt('portrait', '10');
    crop = portraitSlice(crop, (s.startsWith('--') ? 10 : Number(s)) / 100, rotate);
  }
  log('crop', JSON.stringify(crop), 'target', target);
  if (flag('preview')) {
    preview(crop, outputs);
    return;
  }
  const encoder = pickEncoder();
  log('encoder', encoder, 'preset', preset.id, rtmp ? 'RTMP on' : 'RTMP off');

  // 2. Overlay text, overwritten in place (a rename-replace makes ffmpeg's per-frame open fail).
  const t0 = Date.now();
  let overlayErrors = 0;
  const writeOverlay = () => {
    try {
      const s = Math.floor((Date.now() - t0) / 1000);
      writeFileSync(overlayFile, `Castcade D1.0 spike   ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    } catch {
      overlayErrors++;
    }
  };
  writeOverlay();
  const overlayTimer = setInterval(writeOverlay, 500);

  // 3. Loopback audio from a hidden window.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    cb({ video: sources[0], audio: 'loopback' });
  });
  let ff = null;
  let pcmChunks = 0;
  let pcmBytes = 0;
  const status = {};
  ipcMain.on('status', (_e, s) => {
    Object.assign(status, s);
    log('audio', JSON.stringify(s));
  });
  const startFfmpeg = () => {
    const args = captureArgs({
      crop,
      rotate,
      preset,
      encoder,
      overlay: { textFile: 'overlay.txt', fontFile: 'C:\\Windows\\Fonts\\segoeui.ttf' },
      audio: { sampleRate: 48000, channels: 2, kbps: 160, lateMs: avLateMs },
      outputs: { mp4, ...(rtmp ? { rtmp } : {}) },
      seconds,
    });
    log('ffmpeg grab', args.grab.join(' '));
    log('ffmpeg mux', redactRtmp(args.mux.join(' ')));
    // The app's runner: grab → mux, PCM from the first video on (see src/media/ffmpeg-pipeline.ts).
    ff = spawnFfmpeg(FFMPEG, args, { cwd: outDir });
    let last = '';
    let errors = [];
    // ffmpeg's whole log beside the MP4 (stream key redacted): the first error names the cause, which the summary's
    // last five lines lost (rig 2026-10-27: two runs ended with only "Generic error in an external library").
    const ffLog = mp4.replace(/\.mp4$/, '.ffmpeg.log');
    const t0ff = Date.now();
    ff.onLine((line) => {
      if (/frame=/.test(line)) last = line.trim();
      else {
        try {
          appendFileSync(ffLog, `${((Date.now() - t0ff) / 1000).toFixed(1)}s ${redactRtmp(line.trim())}\n`);
        } catch {
          /* a diagnostic; never stop the capture for it */
        }
        if (/error|failed|invalid|lost/i.test(line)) errors.push(redactRtmp(line.trim()));
      }
    });
    const statsTimer = setInterval(() => last && log(last), 10_000);
    ff.onExit((code) => {
      clearInterval(statsTimer);
      clearInterval(overlayTimer);
      let size = 0;
      try {
        size = statSync(mp4).size;
      } catch {
        // no file: ffmpeg failed before writing; the exit code says so
      }
      const m = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?(?:dup=(\d+))?.*?(?:drop=(\d+))?.*?speed=\s*([\d.]+)x/.exec(last) || [];
      if (errors.length) log('ffmpeg errors (first 3, last 3):', [...errors.slice(0, 3), '…', ...errors.slice(-3)].join(' | '));
      log('ffmpeg log:', ffLog);
      console.log(
        `\nD1.0 | target=${target} | crop=${crop.width}x${crop.height}@out${crop.outputIdx}+${crop.offsetX},${crop.offsetY} | rotate=${rotate} | encoder=${encoder} | ffmpeg=${ffBuild} | preset=${preset.id} | ` +
          `frames=${m[1] ?? '?'}/${seconds * preset.fps} | speed=${m[5] ?? '?'}x | ffmpeg exit=${code} | loopback=${status.loopbackTracks ?? '?'} | pcm=${pcmChunks} chunks ${(pcmBytes / 1e6).toFixed(1)} MB | ` +
          `overlay errors=${overlayErrors} | rtmp=${rtmp ? 'on' : 'off'} | mp4=${(size / 1e6).toFixed(1)} MB | vpx fps before=__ during=__\n`,
      );
      log('recording:', mp4);
      if (size > 0) shell.showItemInFolder(mp4);
      app.exit(code === 0 ? 0 : 1);
    });
  };
  ipcMain.on('pcm', (_e, chunk) => {
    pcmChunks++;
    pcmBytes += chunk.byteLength;
    if (!ff) startFfmpeg(); // start once audio flows, so the two inputs begin together
    ff?.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
  // --sync-test (with --desktop): a window at the capture's top-left flashes white and beeps every 2 s, so the recording
  // shows how far the audio trails the picture (analyse with scripts/av-sync.py).
  if (flag('sync-test')) {
    const flash = new BrowserWindow({ x: 0, y: 0, width: 640, height: 360, frame: false, alwaysOnTop: true, backgroundColor: '#000', webPreferences: { nodeIntegration: true, contextIsolation: false } });
    const html = `<!doctype html><body style="margin:0;background:#000"><script>
const ctx = new AudioContext();
setInterval(() => {
  document.body.style.background = '#fff';
  const o = new OscillatorNode(ctx, { frequency: 1000 }); o.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.1);
  setTimeout(() => { document.body.style.background = '#000'; }, 100);
}, 2000);
</script>`;
    const p = join(outDir, 'sync-flash.html');
    writeFileSync(p, html);
    await flash.loadFile(p);
  }
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  // A file:// page, not data:, so the page is a secure context and navigator.mediaDevices exists.
  const page = join(outDir, 'spike-renderer.html');
  writeFileSync(page, RENDERER);
  await win.loadFile(page);
  setTimeout(() => {
    if (!ff) {
      log('no audio after 10 s; recording video without the loopback track', JSON.stringify(status));
      startFfmpeg();
      // keep ffmpeg's stdin fed with silence so the audio input exists
      const silence = Buffer.alloc(1024 * 8);
      setInterval(() => ff?.write(silence), 21);
    }
  }, 10_000);
});

/** --preview: the stream's picture in an ffplay window; nothing encoded, recorded or sent. */
function preview(crop, outputs) {
  const overlayFile0 = overlayFile;
  const t0 = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    try {
      writeFileSync(overlayFile0, `Castcade D1.0 preview   ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    } catch {
      // the next tick writes it
    }
  };
  tick();
  const timer = setInterval(tick, 500);
  const overlay = { textFile: 'overlay.txt', fontFile: 'C:\\Windows\\Fonts\\segoeui.ttf' };
  const picture = outputSize({ crop, rotate, preset, overlay });
  const place = previewPlacement(crop, outputs, picture);
  if (place.overlapsCapture) log('warning: no room beside the capture on this monitor; the preview may film itself. Move it aside.');
  const args = ffplayPreviewArgs({ crop, rotate, preset, overlay, window: place });
  log(`preview: ${picture.width}x${picture.height} (${preset.id}) in a window at ${place.left},${place.top}. Close it (Q or the X) when the framing is right.`);
  const fp = spawn(FFPLAY, args, { cwd: outDir, windowsHide: false });
  fp.stderr.on('data', (b) => {
    const line = b.toString().trim();
    if (line) log('ffplay:', line);
  });
  fp.on('error', (e) => {
    log('ffplay did not start (it ships with ffmpeg; is it on PATH?):', String(e));
    app.exit(2);
  });
  fp.on('close', (code) => {
    clearInterval(timer);
    const opts = argv.filter((a) => a !== '--preview').join(' ');
    console.log(`\nD1.0 preview | crop=${crop.width}x${crop.height}@out${crop.outputIdx}+${crop.offsetX},${crop.offsetY} | rotate=${rotate} | picture=${picture.width}x${picture.height} | ffplay exit=${code}`);
    console.log(`To go live with this framing: npm run spike:stream -w companion -- ${opts}\n`);
    app.exit(0);
  });
}
