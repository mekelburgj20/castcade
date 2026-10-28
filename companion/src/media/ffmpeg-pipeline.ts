/**
 * Runs an ffmpeg command for the stream engine: one process (the slate) or a capture's two (`captureArgs`: `grab` →
 * `mux`, see `ffmpeg-args.ts` for why). No Electron here, so the D1.0 spike runs the same code as the app.
 *
 * For a capture:
 *   - `grab`'s stdout goes to `mux`'s fd 3 with NO backpressure: Node holds what `mux` has not read yet (while it waits
 *     for audio, ~100 ms of video: ~180 KB in the test), so `grab` never stalls and never misses a frame;
 *   - PCM goes to `mux`'s stdin, starting with the first chunk after `grab`'s first video bytes, so audio and picture
 *     start together whatever ffmpeg's start-up time (the remaining offset is the audio path's, `lateMs`);
 *   - `kill()` stops `grab` only: its stdout ends, so `mux` gets the end of both inputs and finishes the MP4 cleanly
 *     (no fragment lost); `mux` is killed after `DRAIN_MS` if it has not exited by then;
 *   - either process ending ends the run (`grab` dying ends `mux`'s inputs; `mux` dying kills `grab`); the exit code
 *     is `grab`'s when it failed on its own, else `mux`'s.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { CaptureCommand } from './ffmpeg-args.js';
import type { FfmpegProcess } from './stream-engine.js';

export type FfmpegCommand = string[] | CaptureCommand;

/** How long `mux` may take to finish its files after `grab` stops. */
export const DRAIN_MS = 5000;

type Spawn = (cmd: string, args: string[], opts: { windowsHide: boolean; cwd?: string; stdio: ('pipe' | 'ignore')[] }) => ChildProcess;

export function spawnFfmpeg(ffmpeg: string, command: FfmpegCommand, opts: { cwd?: string; spawn?: Spawn } = {}): FfmpegProcess {
  const sp: Spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn);
  let lineCb: (l: string) => void = () => {};
  let exitCb: (c: number | null) => void = () => {};
  const line = (l: string) => lineCb(l);
  const start = (args: string[], stdio: ('pipe' | 'ignore')[], prefix: string) => {
    const child = sp(ffmpeg, args, { windowsHide: true, ...(opts.cwd ? { cwd: opts.cwd } : {}), stdio });
    readLines(child, prefix, line);
    const exited = new Promise<number | null>((resolve) => {
      let done = false;
      const finish = (code: number | null) => {
        if (!done) resolve(code);
        done = true;
      };
      child.on('error', (e) => {
        line(`${prefix}ffmpeg failed to start: ${e.message}`);
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
    return { child, exited };
  };

  if (Array.isArray(command)) {
    const one = start(command, ['pipe', 'ignore', 'pipe'], '');
    quiet(one.child.stdin);
    void one.exited.then((c) => exitCb(c));
    return {
      write: (c) => writeTo(one.child.stdin, c),
      kill: () => void one.child.kill(),
      onLine: (cb) => (lineCb = cb),
      onExit: (cb) => (exitCb = cb),
    };
  }

  const mux = start(command.mux, ['pipe', 'ignore', 'pipe', 'pipe'], '');
  const grab = start(command.grab, ['ignore', 'pipe', 'pipe'], 'grab: ');
  const video = mux.child.stdio[3] as Writable | null;
  quiet(mux.child.stdin);
  quiet(video);
  let videoFlowing = false;
  let stopping = false;
  let grabExit: number | null | undefined;
  grab.child.stdout?.on('data', (b: Buffer) => {
    videoFlowing = true;
    if (video && !video.destroyed && !video.writableEnded) video.write(b); // no backpressure, on purpose
  });
  const endInputs = () => {
    if (video && !video.writableEnded) video.end();
    if (mux.child.stdin && !mux.child.stdin.writableEnded) mux.child.stdin.end();
  };
  grab.child.stdout?.on('end', endInputs);
  void grab.exited.then((c) => {
    grabExit = c;
    endInputs();
  });
  void mux.exited.then(async (muxCode) => {
    const grabFailedFirst = grabExit !== undefined && grabExit !== 0 && !stopping;
    if (grabExit === undefined) grab.child.kill();
    await grab.exited;
    exitCb(grabFailedFirst ? grabExit! : muxCode);
  });
  return {
    write: (c) => {
      if (videoFlowing) writeTo(mux.child.stdin, c);
    },
    kill: () => {
      if (stopping) return;
      stopping = true;
      grab.child.kill();
      const t = setTimeout(() => mux.child.kill(), DRAIN_MS);
      void mux.exited.then(() => clearTimeout(t));
    },
    onLine: (cb) => (lineCb = cb),
    onExit: (cb) => (exitCb = cb),
  };
}

function quiet(s: Writable | null | undefined): void {
  s?.on('error', () => {}); // EPIPE when ffmpeg exits first; the exit handler reports it
}

function writeTo(s: Writable | null | undefined, c: Uint8Array): void {
  if (s && s.writable) s.write(c);
}

/** stderr split into lines (`\r` too: ffmpeg's progress line rewrites itself). */
function readLines(child: ChildProcess, prefix: string, cb: (l: string) => void): void {
  let carry = '';
  child.stderr?.on('data', (b: Buffer) => {
    const parts = (carry + b.toString('utf8')).split(/\r|\n/);
    carry = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) cb(prefix + p);
  });
  child.stderr?.on('end', () => {
    if (carry.trim()) cb(prefix + carry);
    carry = '';
  });
}
