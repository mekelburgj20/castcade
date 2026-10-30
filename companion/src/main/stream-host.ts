/**
 * D1.2 / D1.3 in the shell: the stream engine (`media/stream-engine.ts`) with its Electron parts. The game audio comes
 * from a hidden window that asks for display media with `audio: 'loopback'` (Windows) and posts raw f32le PCM over
 * IPC (the D1.0 spike's path: ffmpeg has no Windows loopback input of its own). The stream key lives in
 * `<userData>/stream.json` through the token codec (safeStorage); it is never logged, never shown back to the
 * renderer and never sent to ArcAid. The framing preview (D1.5) is an ffplay window on the stream's own picture chain
 * (`media/preview.ts`), separate from the engine: it may run beside a capture.
 */
import { BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_PRESET, ENCODER_PREFERENCE, PRESETS, type VideoEncoder } from '../media/ffmpeg-args.js';
import type { FfmpegLocation } from '../media/ffmpeg-path.js';
import { isVpxExe, watchFocus, type FocusWatch } from '../media/focus-watch.js';
import { spawnFfmpeg } from '../media/ffmpeg-pipeline.js';
import type { OverlayState } from '../media/overlay-server.js';
import { OVERLAY_TEXT_FILE, overlayText } from '../media/overlay-text.js';
import { previewCommand } from '../media/preview.js';
import { StreamEngine, type EngineStatus } from '../media/stream-engine.js';
import { patchStreamSettings, planFor, readStreamSettings, writeStreamSettings, type StreamSettings } from '../media/stream-settings.js';
import { probeWindows, type WindowProbe } from '../media/window-geometry.js';
import type { LastCapture, LiveGame } from '../witness/types.js';
import type { Logger } from './log.js';
import type { TokenCodec } from './settings.js';

export interface StreamSettingsView extends StreamSettings {
  /** A key is stored (its value never leaves the main process). */
  hasKey: boolean;
  /** The folder sessions go to when `recordingsDir` is null. */
  defaultRecordingsDir: string;
}

/** D1.5: the framing preview (an ffplay window showing what viewers would see). */
export interface PreviewStatus {
  previewing: boolean;
  picture: { width: number; height: number } | null;
  warning: string | null;
  error: string | null;
}

export const PREVIEW_OVERLAPS = 'The preview window sits inside the captured area; close it before going live or viewers will see it.';

/** Settings that change the picture: a running preview restarts on them so the streamer sees the change at once. */
const PICTURE_KEYS = ['orientation', 'shiftPercent', 'rotate', 'preset', 'overlay'] as const satisfies readonly (keyof StreamSettings)[];
const PREVIEW_RESTART_MS = 300;

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
  /** D1.4: the overlay state to burn into the capture. */
  noteOverlay(state: OverlayState): void;
  /** D1.5: open the preview (a running one is replaced); allowed while a capture runs. */
  startPreview(): Promise<PreviewStatus>;
  stopPreview(): Promise<PreviewStatus>;
  previewStatus(): PreviewStatus;
  onPreview(cb: (s: PreviewStatus) => void): () => void;
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

  const engine = new StreamEngine({
    probe: () => probeWindows(),
    spawn: (command) => spawnFfmpeg(opts.ffmpeg.ffmpeg, command),
    encoder: pickEncoder,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    // D1.4: in place (writeFileSync truncates the same file); a rename would stop ffmpeg's per-frame reads.
    writeText: (path, t) => writeFileSync(path, t),
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

  // ---- focus (D1.9): cover the capture whenever VPX is not the foreground window ----
  let focus: FocusWatch | null = null;
  const startFocus = (): void => {
    if (focus) return;
    focus = watchFocus(
      (c) => engine.noteFocus(isVpxExe(c.exe), c.exe || null),
      (why) => {
        focus = null;
        log.warn(`stream: the focus watch stopped (${why}); the stream is not covered when VPX loses focus`);
        engine.noteFocus(null);
      },
    );
  };
  const stopFocus = (): void => {
    focus?.stop();
    focus = null;
  };

  // ---- preview (D1.5): ffplay on the stream's own picture chain, in a window beside the capture ----
  const overlayTextFile = join(dirname(opts.file), OVERLAY_TEXT_FILE);
  const previewListeners = new Set<(s: PreviewStatus) => void>();
  const CLOSED: PreviewStatus = { previewing: false, picture: null, warning: null, error: null };
  let preview: PreviewStatus = CLOSED;
  let previewProc: ChildProcess | null = null;
  /** The overlay file is in the running preview's picture (the setting on, a font, the file written). */
  let previewOverlay = false;
  let previewWritten: string | null = null;
  /** The probe the preview opened on. A settings restart reuses it: the window has not moved, and a fresh probe is a
   * PowerShell start (about a second) the streamer would wait through on every change. */
  let previewProbe: WindowProbe | null = null;
  let previewStarting: Promise<PreviewStatus> | null = null;
  let previewRestart: ReturnType<typeof setTimeout> | null = null;
  /** The last state given to `noteOverlay` (the engine keeps its own copy). */
  let lastOverlay: OverlayState | null = null;

  const setPreview = (next: PreviewStatus): void => {
    preview = next;
    for (const l of previewListeners) l(next);
  };
  /** The engine's `writeOverlay`: the same text, the same file, overwritten in place (ffmpeg re-reads it every frame;
   * a rename makes that open fail on Windows). */
  const writePreviewOverlay = (force: boolean): boolean => {
    const t = lastOverlay ? overlayText(lastOverlay) : '';
    if (!force && t === previewWritten) return true;
    try {
      writeFileSync(overlayTextFile, t);
      previewWritten = t;
      return true;
    } catch (e) {
      log.warn(`stream: preview: could not write the overlay text: ${String(e)}`);
      return false;
    }
  };
  /** Kill the running ffplay; its exit is then ignored (`previewProc` no longer names it). */
  const killPreview = (): void => {
    if (previewRestart) clearTimeout(previewRestart);
    previewRestart = null;
    const p = previewProc;
    previewProc = null;
    previewOverlay = false;
    if (p && p.exitCode === null) p.kill();
  };
  const closePreview = (): void => {
    killPreview();
    if (preview !== CLOSED) setPreview(CLOSED);
  };
  // ffplay is a separate process: Windows does not end it with the app, whichever way the app quits.
  process.once('exit', () => previewProc?.kill());

  const openPreview = (reuseProbe: boolean): Promise<PreviewStatus> => {
    if (previewStarting) return previewStarting;
    previewStarting = (async (): Promise<PreviewStatus> => {
      try {
        const probe = reuseProbe && previewProbe ? previewProbe : await probeWindows();
        previewProbe = probe;
        const fontFile = existsSync(FONT) ? FONT : null;
        // As the engine does: the file exists before ffplay opens it, and a failed write previews without the overlay.
        const withOverlay = settings.overlay && fontFile !== null && writePreviewOverlay(true);
        const cmd = previewCommand({ probe, settings, preset: PRESETS[settings.preset] ?? PRESETS[DEFAULT_PRESET]!, fontFile, overlayTextFile: withOverlay ? overlayTextFile : null });
        killPreview();
        if ('error' in cmd) {
          setPreview({ ...CLOSED, error: cmd.error });
          return preview;
        }
        // windowsHide false: the preview IS a window.
        const p = spawn(opts.ffmpeg.ffplay, cmd.args, { windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
        previewProc = p;
        previewOverlay = withOverlay;
        let partial = '';
        let lastLine: string | null = null;
        p.stderr?.on('data', (b: Buffer) => {
          const lines = (partial + b.toString('utf8')).split(/\r?\n/);
          partial = lines.pop() ?? '';
          for (const l of lines.map((x) => x.trim()).filter(Boolean)) {
            lastLine = l;
            log.warn(`stream: preview: ffplay: ${l}`);
          }
        });
        const ended = (error: string | null): void => {
          if (previewProc !== p) return; // replaced or closed from here
          previewProc = null;
          previewOverlay = false;
          setPreview({ ...CLOSED, error });
        };
        p.on('error', (e) => ended(`ffplay did not start (${e.message}).`));
        // Q, Esc or the window's X end ffplay with 0; anything else is a failure worth showing (its last line).
        p.on('close', (code) => {
          if (previewProc === p) log.info(`stream: preview closed (ffplay exit ${code})`);
          ended(code === 0 ? null : (lastLine ?? `ffplay exited (${code})`));
        });
        log.info(`stream: preview ${cmd.picture.width}x${cmd.picture.height} (${settings.preset} ${settings.orientation}, rotate ${settings.rotate}${withOverlay ? ', overlay' : ''})${cmd.overlapsCapture ? ' inside the captured area' : ''}`);
        setPreview({ previewing: true, picture: cmd.picture, warning: cmd.overlapsCapture ? PREVIEW_OVERLAPS : null, error: null });
        return preview;
      } catch (e) {
        killPreview();
        setPreview({ ...CLOSED, error: `The preview could not start: ${e instanceof Error ? e.message : String(e)}` });
        return preview;
      } finally {
        previewStarting = null;
      }
    })();
    return previewStarting;
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
      const before = settings;
      settings = patchStreamSettings(settings, patch);
      save();
      // D1.5: a running preview follows a framing change at once (debounced: a typed shift is several changes).
      if (previewProc && PICTURE_KEYS.some((k) => before[k] !== settings[k])) {
        if (previewRestart) clearTimeout(previewRestart);
        previewRestart = setTimeout(() => {
          previewRestart = null;
          if (previewProc) void openPreview(true);
        }, PREVIEW_RESTART_MS);
      }
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
      const plan = planFor(settings, want, { key: plainKey(), recordingsDir: opts.defaultRecordingsDir, fontFile: existsSync(FONT) ? FONT : null, overlayTextFile, appVersion: opts.appVersion });
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
      startFocus();
      return engine.status();
    },
    async stop() {
      closePreview();
      stopFocus();
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
    noteOverlay: (st) => {
      lastOverlay = st;
      engine.noteOverlay(st);
      if (previewProc && previewOverlay) writePreviewOverlay(false);
    },
    startPreview: () => openPreview(false),
    async stopPreview() {
      closePreview();
      return preview;
    },
    previewStatus: () => preview,
    onPreview(cb) {
      previewListeners.add(cb);
      return () => {
        previewListeners.delete(cb);
      };
    },
  };
}

/** The hidden audio page: loopback → game gain → limiter → an AudioWorklet that posts ~21 ms of PCM per message
 * (1024 samples: a small chunk keeps the start of the audio within ~21 ms of the picture's, see `ffmpeg-pipeline.ts`). */
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
    if (this.n >= 1024) {
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
