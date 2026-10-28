/**
 * D1.2 + D1.3: the stream / recording engine (`docs/design/solo-streaming-and-recording.md`). No Electron here: the
 * host (`main/stream-host.ts`) injects the window probe, the ffmpeg launcher, the clock and the timers, and feeds the
 * loopback audio in with `pushPcm`.
 *
 * A session outlives one table (owner's rig, 2026-10-27: quitting to the editor closes the player window and ends
 * Desktop Duplication). Every 2 s the engine probes for VPX's player window:
 *   - window there and steady for two probes → capture it: an ffmpeg pair (grab → mux, `ffmpeg-pipeline.ts`) writing
 *     the next MP4 segment and / or the RTMP push (tee; the recording continues if the push fails);
 *   - window gone, moved or resized → stop that ffmpeg (the segment closes with its sha256);
 *   - no window while live → the slate (RTMP only, never recorded) keeps the broadcast up until the next table;
 *   - ffmpeg died on its own (lost Desktop Duplication, the push dropped) → back off 1, 2, 4 … 30 s and start again.
 * Twitch sees a short reconnect at each switch; the recording is one MP4 per capture run, listed in the manifest.
 */
import { EventEmitter } from 'node:events';
import type { LastCapture, LiveGame } from '../witness/types.js';
import { captureArgs, outputSize, redactRtmp, slateArgs, type QualityPreset, type VideoEncoder } from './ffmpeg-args.js';
import type { FfmpegCommand } from './ffmpeg-pipeline.js';
import { applyRetention, RecordingSession } from './recording.js';
import { cropFor, pickPlayfield, portraitSlice, type DdagrabCrop, type WindowProbe } from './window-geometry.js';

export type Rotate = 0 | 90 | 180 | 270;

export interface StreamPlan {
  preset: QualityPreset;
  /** Portrait = a 9:16 slice of the player window (moved by `shift`, a fraction of its width); landscape = all of it. */
  orientation: 'portrait' | 'landscape';
  shift: number;
  rotate: Rotate;
  record: boolean;
  /** The ingest URL with the stream key; null = record only. Never logged raw. */
  rtmpUrl: string | null;
  audio: { sampleRate: number; channels: number; kbps: number; /** ms; negative = the audio is early and is delayed */ lateMs: number } | null;
  recordingsDir: string;
  retention: { keepSessions: number; maxRecordings: number | null };
  /** For the slate's text; null draws a plain slate (a missing font crashes ffmpeg's drawtext, so the host checks). */
  fontFile: string | null;
  appVersion: string;
}

export interface FfmpegProcess {
  write(chunk: Uint8Array): void;
  kill(): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface EngineDeps {
  probe(): Promise<WindowProbe>;
  /** One process (`string[]`) or a capture's grab → mux pair; either way one run to the engine. */
  spawn(command: FfmpegCommand): FfmpegProcess;
  encoder(): Promise<VideoEncoder>;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log: { info(msg: string): void; warn(msg: string): void };
}

export type EngineState = 'idle' | 'waiting' | 'capturing' | 'slate';

export interface EngineHealth {
  frames: number;
  fps: number;
  speed: number;
}

export interface EngineStatus {
  state: EngineState;
  /** Pushing to the ingest right now (capture or slate). */
  live: boolean;
  /** Writing an MP4 segment right now. */
  recording: boolean;
  wantsLive: boolean;
  wantsRecording: boolean;
  session: string | null;
  segment: string | null;
  table: string | null;
  picture: { width: number; height: number } | null;
  health: EngineHealth | null;
  /** ffmpeg runs that ended on their own (each one restarted). */
  restarts: number;
  lastError: string | null;
  since: string | null;
}

export const POLL_MS = 2000;
export const STEADY_PROBES = 2;
export const MAX_BACKOFF_MS = 30_000;
/** A run this long resets the backoff. */
export const HEALTHY_RUN_MS = 60_000;
export const SLATE_TEXT = 'Back in a moment: next table loading';

/** The tee muxer's line when the push fails while the recording goes on (`onfail=ignore`). */
const PUSH_FAILED = /slave muxer #\d+ failed/i;

interface Running {
  kind: 'capture' | 'slate';
  proc: FfmpegProcess;
  key: string | null;
  startedAt: number;
  expected: boolean;
  stopReason?: string;
  exited: Promise<void>;
}

export class StreamEngine extends EventEmitter {
  private plan: StreamPlan | null = null;
  private state: EngineState = 'idle';
  private run: Running | null = null;
  private session: RecordingSession | null = null;
  private encoder: VideoEncoder | null = null;
  private timer: unknown = null;
  private ticking = false;
  private pendingKey: string | null = null;
  private steady = 0;
  private failures = 0;
  private backoffUntil = 0;
  private restarts = 0;
  private lastError: string | null = null;
  private errors: string[] = [];
  private health: EngineHealth | null = null;
  private picture: { width: number; height: number } | null = null;
  private table: string | null = null;
  private inGame = false;
  /** The segment recording at the last game start / end: a score posts ~1 s after its game, maybe after the segment closed. */
  private gameSegment: string | null = null;
  private since: string | null = null;

  constructor(private readonly deps: EngineDeps) {
    super();
  }

  status(): EngineStatus {
    const p = this.plan;
    return {
      state: this.state,
      live: !!p?.rtmpUrl && this.run !== null,
      recording: this.session?.segment != null,
      wantsLive: !!p?.rtmpUrl,
      wantsRecording: !!p?.record,
      session: this.session?.id ?? null,
      segment: this.session?.segment ?? null,
      table: this.table,
      picture: this.picture,
      health: this.health,
      restarts: this.restarts,
      lastError: this.lastError,
      since: this.since,
    };
  }

  async start(plan: StreamPlan): Promise<void> {
    if (this.state !== 'idle') throw new Error('already running');
    if (!plan.record && !plan.rtmpUrl) throw new Error('nothing to do: neither recording nor a stream key');
    this.encoder = this.encoder ?? (await this.deps.encoder());
    this.plan = plan;
    Object.assign(this, { restarts: 0, failures: 0, backoffUntil: 0, lastError: null, errors: [], health: null, picture: null, pendingKey: null, steady: 0, gameSegment: null });
    this.since = new Date(this.deps.now()).toISOString();
    if (plan.record) {
      this.session = await RecordingSession.open(plan.recordingsDir, this.deps.now);
      await this.session.append({ kind: 'session_start', app: plan.appVersion, preset: plan.preset.id, streaming: !!plan.rtmpUrl, recording: true });
      const gone = await applyRetention(plan.recordingsDir, plan.retention, this.session.id).catch((e: unknown) => {
        this.deps.log.warn(`stream: retention failed: ${String(e)}`);
        return [];
      });
      if (gone.length) this.deps.log.info(`stream: retention removed ${gone.length} old session(s): ${gone.join(', ')}`);
    }
    this.deps.log.info(`stream: started (${plan.record ? 'recording' : 'no recording'}, ${plan.rtmpUrl ? redactRtmp(plan.rtmpUrl) : 'not live'}, ${plan.preset.id} ${plan.orientation}, rotate ${plan.rotate}, ${this.encoder})`);
    this.setState('waiting');
    void this.tick();
  }

  async stop(reason = 'stopped'): Promise<void> {
    if (this.state === 'idle') return;
    this.state = 'idle';
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    await this.stopRun(reason);
    if (this.session) await this.session.close(reason);
    this.session = null;
    this.plan = null;
    this.since = null;
    this.health = null;
    this.deps.log.info(`stream: stopped (${reason})`);
    this.emitStatus();
  }

  /** Raw f32le PCM from the loopback capture; dropped while no ffmpeg runs. */
  pushPcm(chunk: Uint8Array): void {
    this.run?.proc.write(chunk);
  }

  /** The witness's table name (the probe only sees "Visual Pinball Player"). */
  noteTable(table: string | null): void {
    this.table = table;
  }

  /** The witness's live game: a start and an end become manifest markers in the segment being recorded. */
  noteGame(game: LiveGame | null): void {
    const now = !!game?.inGame;
    if (game && now !== this.inGame && this.session) {
      // A game that ends as its table closes (the segment closed first) keeps the segment it started in.
      const segment = now ? this.session.segment : (this.session.segment ?? this.gameSegment);
      this.gameSegment = segment;
      void this.session.append(now ? { kind: 'game_start', table: game.table, segment } : { kind: 'game_end', table: game.table, scores: game.scores, segment });
    }
    this.inGame = now;
  }

  /**
   * A score the witness captured (posted, queued or skipped): tied to the segment its game ended in. It posts about a
   * second after the game, so quitting the table at once closes the segment first (rig 2026-10-28: `segment: null`).
   */
  noteCapture(c: LastCapture): void {
    if (!this.session) return;
    void this.session.append({ kind: 'score_posted', table: c.table, score: c.score, outcome: c.outcome, mode: c.mode ?? null, segment: this.gameSegment ?? this.session.segment });
  }

  private setState(s: EngineState): void {
    this.state = s;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }

  private schedule(ms = POLL_MS): void {
    if (this.state === 'idle') return;
    this.timer = this.deps.setTimeout(() => void this.tick(), ms);
  }

  /** Probe, then move between waiting, capturing and slate. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.state === 'idle' || this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } catch (e) {
      this.lastError = String(e instanceof Error ? e.message : e);
      this.deps.log.warn(`stream: ${this.lastError}`);
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }

  private async step(): Promise<void> {
    const plan = this.plan!;
    let crop: DdagrabCrop | null;
    try {
      const probe = await this.deps.probe();
      const pf = pickPlayfield(probe.windows);
      crop = pf ? cropFor(pf, probe.outputs) : null;
      if (crop && plan.orientation === 'portrait') crop = portraitSlice(crop, plan.shift, plan.rotate);
    } catch (e) {
      this.deps.log.warn(`stream: window probe failed: ${String(e)}`);
      return; // keep whatever runs; try again next poll
    }
    if (this.state === 'idle') return;
    const key = crop ? JSON.stringify(crop) : null;
    const now = this.deps.now();

    if (this.run?.kind === 'capture') {
      if (key === this.run.key) return;
      await this.stopRun(key ? 'window moved' : 'player closed');
    }
    if (crop) {
      this.steady = key === this.pendingKey ? this.steady + 1 : 1;
      this.pendingKey = key;
      if (this.steady >= STEADY_PROBES && now >= this.backoffUntil) {
        if (this.run?.kind === 'slate') await this.stopRun('table open');
        await this.startCapture(crop, key!);
      }
    } else {
      this.steady = 0;
      this.pendingKey = null;
      if (plan.rtmpUrl && !this.run && now >= this.backoffUntil) this.startSlate();
      else if (!this.run && this.state !== 'waiting') this.setState('waiting');
    }
  }

  private async startCapture(crop: DdagrabCrop, key: string): Promise<void> {
    const plan = this.plan!;
    const picture = outputSize({ crop, rotate: plan.rotate, preset: plan.preset });
    this.picture = picture;
    const mp4 = this.session ? await this.session.startSegment(this.table, picture) : undefined;
    const args = captureArgs({
      crop,
      rotate: plan.rotate,
      preset: plan.preset,
      encoder: this.encoder!,
      overlay: null,
      audio: plan.audio,
      outputs: { ...(mp4 ? { mp4 } : {}), ...(plan.rtmpUrl ? { rtmp: plan.rtmpUrl } : {}) },
    });
    this.launch('capture', args, key);
    this.deps.log.info(`stream: capturing ${crop.width}x${crop.height}@out${crop.outputIdx}+${crop.offsetX},${crop.offsetY} → ${picture.width}x${picture.height}${mp4 ? ` into ${this.session!.segment}` : ''}`);
    this.setState('capturing');
  }

  private startSlate(): void {
    const plan = this.plan!;
    const size = this.picture ?? (plan.orientation === 'portrait' ? { width: plan.preset.height, height: Math.round((plan.preset.height * 16) / 9 / 2) * 2 } : { width: Math.round((plan.preset.height * 16) / 9 / 2) * 2, height: plan.preset.height });
    const args = slateArgs({ size, text: SLATE_TEXT, fontFile: plan.fontFile ?? '', rtmp: plan.rtmpUrl!, preset: plan.preset, encoder: this.encoder!, audio: plan.audio });
    // No font: drop the drawtext (ffmpeg crashes on a missing font file).
    const fc = args.indexOf('-filter_complex');
    if (!plan.fontFile && fc >= 0) args[fc + 1] = args[fc + 1]!.replace(/drawtext=[^,]*,/, '');
    this.launch('slate', args, null);
    this.deps.log.info(`stream: no table open; slate at ${size.width}x${size.height}`);
    this.setState('slate');
  }

  private launch(kind: Running['kind'], args: FfmpegCommand, key: string | null): void {
    const proc = this.deps.spawn(args);
    let done!: () => void;
    const exited = new Promise<void>((r) => (done = r));
    const run: Running = { kind, proc, key, startedAt: this.deps.now(), expected: false, exited };
    this.run = run;
    this.health = null;
    proc.onLine((line) => this.onLine(run, line));
    proc.onExit((code) => {
      void this.onExit(run, code).finally(done);
    });
  }

  private onLine(run: Running, line: string): void {
    const m = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?speed=\s*([\d.]+)x/.exec(line);
    if (m) {
      if (this.run === run) {
        this.health = { frames: Number(m[1]), fps: Number(m[2]), speed: Number(m[3]) };
        this.emitStatus();
      }
      return;
    }
    if (/error|failed|invalid/i.test(line)) {
      this.errors = [...this.errors.slice(-4), redactRtmp(line.trim())];
      this.deps.log.warn(`stream: ffmpeg: ${redactRtmp(line.trim())}`);
    }
    // The push failed but the recording goes on: restart the run so the stream reconnects (a new segment begins).
    if (PUSH_FAILED.test(line) && this.run === run && !run.expected) {
      this.lastError = 'the stream connection dropped; reconnecting';
      this.noteFailure(run);
      void this.stopRun('stream dropped');
    }
  }

  private noteFailure(run: Running): void {
    const now = this.deps.now();
    if (now - run.startedAt >= HEALTHY_RUN_MS) this.failures = 0;
    this.failures += 1;
    this.restarts += 1;
    this.backoffUntil = now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures - 1));
  }

  private async onExit(run: Running, code: number | null): Promise<void> {
    if (this.run === run) this.run = null;
    if (run.kind === 'capture' && this.session) await this.session.endSegment(run.stopReason ?? `ffmpeg exited (${code})`);
    if (!run.expected) {
      this.noteFailure(run);
      this.lastError = this.errors.at(-1) ?? `ffmpeg exited (${code})`;
      this.deps.log.warn(`stream: ${run.kind} ended on its own (exit ${code}); retrying in ${Math.round((this.backoffUntil - this.deps.now()) / 1000)} s`);
      this.pendingKey = null;
      this.steady = 0;
    }
    this.errors = [];
    this.health = null;
    if (this.state !== 'idle' && !this.run) this.setState('waiting');
  }

  private async stopRun(reason: string): Promise<void> {
    const run = this.run;
    if (!run) return;
    run.expected = true; // a dropped push was already counted as a failure in onLine
    run.stopReason = reason;
    this.deps.log.info(`stream: stopping ${run.kind} (${reason})`);
    run.proc.kill();
    await run.exited;
  }
}
