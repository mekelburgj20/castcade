// D1.0 spike (docs/design/solo-streaming-and-recording.md §4): capture the VPX window with ffmpeg (ddagrab → NVENC/AMF/QSV),
// game audio through Electron's loopback capture piped in as raw PCM, a live overlay line, an MP4 and optionally an RTMP push.
//
//   npm run spike:stream -w companion -- [--seconds 120] [--preset 720p30|1080p30|1080p60] [--mic] [--desktop]
//   RTMP: set CASTCADE_RTMP_URL (e.g. rtmp://live.twitch.tv/app/<key>) in the environment; it is never printed.
//
// Start VPX with a table first (windowed or fullscreen). --desktop captures 1280x720 of monitor 0 instead (no VPX needed).
// Prints one `D1.0 | ...` line at the end to paste back. Output: tmp/d1-spike/<timestamp>.mp4 (gitignored).
import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } from 'electron';
import { Buffer } from 'node:buffer';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENCODER_PREFERENCE, ffmpegArgs, PRESETS, redactRtmp } from '../dist/media/ffmpeg-args.js';
import { cropFor, pickPlayfield, probeWindows } from '../dist/media/window-geometry.js';

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
const outDir = resolve(here, '../../tmp/d1-spike');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const mp4 = join(outDir, `${stamp}.mp4`);
const overlayFile = join(outDir, 'overlay.txt');
const log = (...a) => console.log('[spike]', ...a);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function pickEncoder() {
  for (const e of ENCODER_PREFERENCE) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', e, '-f', 'null', '-'], { windowsHide: true });
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
    if (this.n >= 4800) { // ~100 ms per IPC message
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
    if (audio.length) ctx.createMediaStreamSource(new MediaStream(audio)).connect(node);
    if (${JSON.stringify(flag('mic'))}) {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
      ctx.createMediaStreamSource(mic).connect(node);
      ipcRenderer.send('status', { mic: mic.getAudioTracks()[0].label });
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
  if (flag('desktop')) crop = { outputIdx: 0, offsetX: 0, offsetY: 0, width: 1280, height: 720 };
  else {
    const probe = await probeWindows();
    log('outputs', JSON.stringify(probe.outputs.map((o) => ({ idx: o.index, device: o.device, at: o.desktop }))));
    log('VPX windows', JSON.stringify(probe.windows.map((w) => ({ title: w.title, client: w.client }))));
    const pf = pickPlayfield(probe.windows);
    if (!pf) {
      log('no VPX window found: start a table first (or use --desktop)');
      app.exit(2);
      return;
    }
    crop = cropFor(pf, probe.outputs);
    target = `"${pf.title}"`;
    if (!crop) {
      log('the VPX window is not on any DXGI output of the default adapter');
      app.exit(2);
      return;
    }
  }
  log('crop', JSON.stringify(crop), 'target', target);
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
    const args = ffmpegArgs({
      crop,
      preset,
      encoder,
      overlay: { textFile: 'overlay.txt', fontFile: 'C:\\Windows\\Fonts\\segoeui.ttf' },
      audio: { sampleRate: 48000, channels: 2, kbps: 160 },
      outputs: { mp4, ...(rtmp ? { rtmp } : {}) },
      seconds,
    });
    log('ffmpeg', redactRtmp(args.join(' ')));
    ff = spawn('ffmpeg', args, { cwd: outDir, windowsHide: true });
    ff.stdin.on('error', () => {});
    let last = '';
    let errors = [];
    ff.stderr.on('data', (b) => {
      for (const line of b.toString().split(/\r|\n/)) {
        if (/frame=/.test(line)) last = line.trim();
        else if (/error|failed|invalid/i.test(line)) errors.push(redactRtmp(line.trim()));
      }
    });
    const statsTimer = setInterval(() => last && log(last), 10_000);
    ff.on('close', (code) => {
      clearInterval(statsTimer);
      clearInterval(overlayTimer);
      let size = 0;
      try {
        size = statSync(mp4).size;
      } catch {
        // no file: ffmpeg failed before writing; the exit code says so
      }
      const m = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?(?:dup=(\d+))?.*?(?:drop=(\d+))?.*?speed=\s*([\d.]+)x/.exec(last) || [];
      if (errors.length) log('ffmpeg errors:', errors.slice(-5).join(' | '));
      console.log(
        `\nD1.0 | target=${target} | crop=${crop.width}x${crop.height}@out${crop.outputIdx}+${crop.offsetX},${crop.offsetY} | encoder=${encoder} | preset=${preset.id} | ` +
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
    if (ff && ff.stdin.writable) ff.stdin.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
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
      const silence = Buffer.alloc(4800 * 8);
      setInterval(() => ff && ff.stdin.writable && ff.stdin.write(silence), 100);
    }
  }, 10_000);
});
