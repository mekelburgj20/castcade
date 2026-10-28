/**
 * D1.2 / D1.3 in the shell: the stream engine (`media/stream-engine.ts`) with its Electron parts. The game audio comes
 * from a hidden window that asks for display media with `audio: 'loopback'` (Windows) and posts raw f32le PCM over
 * IPC (the D1.0 spike's path: ffmpeg has no Windows loopback input of its own). The stream key lives in
 * `<userData>/stream.json` through the token codec (safeStorage); it is never logged, never shown back to the
 * renderer and never sent to ArcAid.
 */
import { BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENCODER_PREFERENCE, type VideoEncoder } from '../media/ffmpeg-args.js';
import type { FfmpegLocation } from '../media/ffmpeg-path.js';
import { StreamEngine, type EngineStatus, type FfmpegProcess } from '../media/stream-engine.js';
import { patchStreamSettings, planFor, readStreamSettings, writeStreamSettings, type StreamSettings } from '../media/stream-settings.js';
import { probeWindows } from '../media/window-geometry.js';
import type { LastCapture, LiveGame } from '../witness/types.js';
import type { Logger } from './log.js';
import type { TokenCodec } from './settings.js';

export interface StreamSettingsView extends StreamSettings {
  /** A key is stored (its value never leaves the main process). */
  hasKey: boolean;
  /** The folder sessions go to when `recordingsDir` is null. */
  defaultRecordingsDir: string;
}

export interface StreamHost {
  status(): EngineStatus;
  settings(): StreamSettingsView;
  setSettings(patch: Partial<StreamSettings>): StreamSettingsView;
  setKey(key: string | null): StreamSettingsView;
  start(want: { record: boolean; live: boolean }): Promise<EngineStatus>;
  stop(): Promise<EngineStatus>;
  recordingsDir(): string;
  onStatus(cb: (s: EngineStatus) => void): () => void;
  noteTable(table: string | null): void;
  noteGame(game: LiveGame | null): void;
  noteCapture(c: LastCapture): void;
}

const AUDIO_PARTITION = 'castcade-audio';
const PCM_CHANNEL = 'castcade-audio:pcm';
const AUDIO_STATUS_CHANNEL = 'castcade-audio:status';
const FONT = 'C:\\Windows\\Fonts\\segoeui.ttf';

export function createStreamHost(opts: {
  file: string;
  codec: TokenCodec;
  defaultRecordingsDir: string;
  ffmpeg: FfmpegLocation;
  appVersion: string;
  log: Logger;
}): StreamHost {
  const { log } = opts;
  let text: string | null;
  try {
    text = readFileSync(opts.file, 'utf8');
  } catch {
    text = null;
  }
  let { settings, key } = readStreamSettings(text);
  const save = (): void => {
    mkdirSync(dirname(opts.file), { recursive: true });
    const tmp = `${opts.file}.tmp`;
    writeFileSync(tmp, writeStreamSettings(settings, key));
    renameSync(tmp, opts.file);
  };
  const plainKey = (): string | null => {
    if (!key) return null;
    try {
      return key.scheme === opts.codec.scheme ? opts.codec.decrypt(key.value) : null;
    } catch {
      log.warn('stream: the stored stream key could not be decrypted; enter it again');
      return null;
    }
  };
  const view = (): StreamSettingsView => ({ ...settings, hasKey: key !== null, defaultRecordingsDir: opts.defaultRecordingsDir });

  let encoder: VideoEncoder | null = null;
  const pickEncoder = async (): Promise<VideoEncoder> => {
    if (encoder) return encoder;
    for (const e of ENCODER_PREFERENCE) {
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(opts.ffmpeg.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.2', '-c:v', e, '-f', 'null', '-'], { windowsHide: true, stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
      });
      if (ok) {
        encoder = e;
        log.info(`stream: encoder ${e} (ffmpeg ${opts.ffmpeg.source === 'bundled' ? `bundled ${opts.ffmpeg.build ?? ''}` : 'from PATH'})`);
        return e;
      }
    }
    throw new Error('no working H.264 encoder in ffmpeg');
  };

  const spawnFfmpeg = (args: string[]): FfmpegProcess => {
    const child = spawn(opts.ffmpeg.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.on('error', () => {});
    let lineCb: (l: string) => void = () => {};
    let exitCb: (c: number | null) => void = () => {};
    let carry = '';
    child.stderr.on('data', (b: Buffer) => {
      const parts = (carry + b.toString('utf8')).split(/\r|\n/);
      carry = parts.pop() ?? '';
      for (const p of parts) if (p.trim()) lineCb(p);
    });
    let exited = false;
    const finish = (code: number | null): void => {
      if (exited) return;
      exited = true;
      if (carry.trim()) lineCb(carry);
      exitCb(code);
    };
    child.on('error', (e) => {
      lineCb(`ffmpeg failed to start: ${e.message}`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
    return {
      write: (c) => {
        if (child.stdin.writable) child.stdin.write(c);
      },
      kill: () => {
        child.kill();
      },
      onLine: (cb) => (lineCb = cb),
      onExit: (cb) => (exitCb = cb),
    };
  };

  const engine = new StreamEngine({
    probe: () => probeWindows(),
    spawn: spawnFfmpeg,
    encoder: pickEncoder,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log,
  });

  // ---- loopback audio ----
  let audioWin: BrowserWindow | null = null;
  const audioSession = session.fromPartition(AUDIO_PARTITION);
  audioSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    cb({ video: sources[0], audio: 'loopback' });
  });
  let firstPcm: (() => void) | null = null;
  ipcMain.on(PCM_CHANNEL, (e, chunk: Uint8Array) => {
    if (!audioWin || e.sender !== audioWin.webContents) return;
    firstPcm?.();
    engine.pushPcm(chunk);
  });
  /** True once PCM flows; false after `ms` without any (ffmpeg would wait on its audio input forever). */
  const audioFlowing = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        firstPcm = null;
        resolve(false);
      }, ms);
      firstPcm = () => {
        clearTimeout(t);
        firstPcm = null;
        resolve(true);
      };
    });
  ipcMain.on(AUDIO_STATUS_CHANNEL, (e, s: unknown) => {
    if (audioWin && e.sender === audioWin.webContents) log.info(`stream: audio ${JSON.stringify(s)}`);
  });
  const startAudio = (): void => {
    if (audioWin && !audioWin.isDestroyed()) return;
    audioWin = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      // Local content only (a page written here); node for ipcRenderer, in its own session.
      webPreferences: { partition: AUDIO_PARTITION, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    });
    // A file, not a data: URL: getDisplayMedia needs a secure context, which file:// is and data: is not
    // (navigator.mediaDevices was undefined in the first in-app run, 2026-10-28; the spike loads a file too).
    const page = join(dirname(opts.file), 'stream-audio.html');
    writeFileSync(page, audioPage(settings.gameVolume));
    void audioWin.loadFile(page);
  };
  const stopAudio = (): void => {
    if (audioWin && !audioWin.isDestroyed()) audioWin.destroy();
    audioWin = null;
  };

  const listeners = new Set<(s: EngineStatus) => void>();
  engine.on('status', (s: EngineStatus) => {
    for (const l of listeners) l(s);
  });

  const recordingsDir = (): string => settings.recordingsDir ?? opts.defaultRecordingsDir;

  return {
    status: () => engine.status(),
    settings: view,
    setSettings(patch) {
      settings = patchStreamSettings(settings, patch);
      save();
      return view();
    },
    setKey(k) {
      const v = k?.trim() ?? '';
      key = v ? { scheme: opts.codec.scheme, value: opts.codec.encrypt(v) } : null;
      save();
      log.info(`stream: key ${key ? 'saved' : 'cleared'}`);
      return view();
    },
    async start(want) {
      const plan = planFor(settings, want, { key: plainKey(), recordingsDir: opts.defaultRecordingsDir, fontFile: existsSync(FONT) ? FONT : null, appVersion: opts.appVersion });
      if (plan.record) mkdirSync(plan.recordingsDir, { recursive: true });
      const flowing = audioFlowing(5000);
      startAudio();
      if (!(await flowing)) {
        log.warn('stream: no game sound from the loopback capture after 5 s; going on without sound');
        plan.audio = null;
        stopAudio();
      }
      try {
        await engine.start(plan);
      } catch (e) {
        stopAudio();
        throw e;
      }
      return engine.status();
    },
    async stop() {
      await engine.stop();
      stopAudio();
      return engine.status();
    },
    recordingsDir,
    onStatus(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    noteTable: (t) => engine.noteTable(t),
    noteGame: (g) => engine.noteGame(g),
    noteCapture: (c) => engine.noteCapture(c),
  };
}

/** The hidden audio page: loopback → game gain → limiter → an AudioWorklet that posts ~100 ms of PCM per message. */
function audioPage(gameVolume: number): string {
  return `<!doctype html><meta charset="utf-8"><script>
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
    if (this.n >= 4800) {
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
    display.getVideoTracks().forEach((t) => t.stop());
    ipcRenderer.send('${AUDIO_STATUS_CHANNEL}', { loopbackTracks: audio.length });
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
    const node = new AudioWorkletNode(ctx, 'pcm', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    node.port.onmessage = (e) => ipcRenderer.send('${PCM_CHANNEL}', new Uint8Array(e.data));
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    limiter.connect(node);
    const game = new GainNode(ctx, { gain: ${Number(gameVolume) / 100} });
    game.connect(limiter);
    if (audio.length) ctx.createMediaStreamSource(new MediaStream(audio)).connect(game);
    await ctx.resume();
    ipcRenderer.send('${AUDIO_STATUS_CHANNEL}', { audioContext: ctx.state, sampleRate: ctx.sampleRate });
  } catch (e) { ipcRenderer.send('${AUDIO_STATUS_CHANNEL}', { error: String(e) }); }
})();
</script>`;
}
