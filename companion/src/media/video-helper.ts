/**
 * D10.3 (2026-11-07, docs/design/spectator-video-native.md §6.2 / §6.4): the native spectator-video helper as the
 * companion drives it. Spawns `castcade-video.exe` (video-helper/README.md; the twin of `audio-helper.ts`), writes one
 * JSON object per line to its stdin (commands), reads one JSON object per line from its stdout (events) and copies its
 * stderr into the companion log. Nothing binary on these pipes: frames go through the shared-memory rings (§6.1). No
 * Electron here; the caller resolves the exe (`resolveVideoHelper`); `video-mesh.ts` owns what is said to it.
 *
 * Rules (the audio helper's):
 *   - started at `start()`; a missing exe → `unavailable helper_missing`; a start-up failure (an exit before `ready`,
 *     or exit 2 / 64) → `unavailable helper_failed:<code>`; any other exit we did not ask for → a restart, at most one
 *     every `RESTART_MIN_MS`. The helper's state dies with it: a new `generation` in the status (one per spawn, current
 *     before the `ready` event fans out) is the caller's cue to tell it everything again (`send` returns false until
 *     then); the mesh syncs once per generation, whichever of the status and the event it sees first (D10.3.4);
 *   - stderr goes to the log line by line; a stdout line that is not a JSON object with an `event` is logged once per
 *     run of the helper and skipped;
 *   - `ready` = available, with the probe's `encoder` / `decoder` in the status;
 *   - `stop()` writes `quit` and ends stdin (closing stdin does the same on the helper's side); killed after
 *     `STOP_GRACE_MS`.
 * Nothing here ever blocks a match: every failure is a status; the Electron video path is the setting's fallback.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const VIDEO_HELPER_EXE = 'castcade-video.exe';
export const RESTART_MIN_MS = 5000;
export const STOP_GRACE_MS = 3000;
/** A stdout line past this with no newline is not ours (an SDP is tens of KB at most). */
const MAX_LINE = 1 << 20;

// ---- where the exe is ----

export interface VideoHelperPathInput {
  packaged: boolean;
  /** process.resourcesPath when packaged. */
  resourcesPath: string;
  /** The companion package directory (dev runs). */
  companionDir: string;
}

/**
 * Packaged: `resources/video-helper/`. Dev: a local CMake build (`video-helper/build/Release/`) first, else a fetched
 * copy in `companion/resources/video-helper/`. Null when none.
 */
export function resolveVideoHelper(i: VideoHelperPathInput, exists: (p: string) => boolean = existsSync): string | null {
  const candidates = i.packaged
    ? [join(i.resourcesPath, 'video-helper', VIDEO_HELPER_EXE)]
    : [resolve(i.companionDir, '..', 'video-helper', 'build', 'Release', VIDEO_HELPER_EXE), resolve(i.companionDir, 'resources', 'video-helper', VIDEO_HELPER_EXE)];
  return candidates.find((p) => exists(p)) ?? null;
}

// ---- the protocol (§6.2) ----

/** `RTCIceServer` as the helper takes it: `urls` always a list. */
export interface VideoIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export type VideoSignalKind = 'offer' | 'answer' | 'ice';

export interface VideoSignalBody {
  /** The remote player's id. */
  id: string;
  kind: VideoSignalKind;
  sdp?: string;
  candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
}

/**
 * Where the frames this rig sends come from. D10.6 (2026-11-07): `wgc` is the VPX window itself, captured by the
 * helper with Windows Graphics Capture (video-helper/src/source_wgc.cpp): `pid` its process, `title` the words its
 * title must contain (the ones `pickCaptureWindow` matched), `width` x `height` the box the picture is scaled to fit
 * (never upscaled, aspect kept), `fps` the push rate. The helper looks for the window every second while it is missing.
 */
export type VideoSource =
  | { kind: 'ring'; token: string; width: number; height: number; fps: number }
  | { kind: 'bench'; width: number; height: number; fps: number }
  | { kind: 'wgc'; pid: number; title: string; width: number; height: number; fps: number }
  | { kind: 'none' };

/** Where decoded frames go. */
export type VideoSink = { kind: 'ring'; token: string } | { kind: 'window' } | { kind: 'none' };

export type VideoHelperCommand =
  | { cmd: 'ice'; servers: VideoIceServer[] }
  | { cmd: 'peer'; id: string; initiator: boolean }
  | ({ cmd: 'signal' } & VideoSignalBody)
  | { cmd: 'close'; id: string }
  | ({ cmd: 'source' } & VideoSource)
  | { cmd: 'send'; on: boolean }
  | { cmd: 'rungs'; max_kbps: number; pin?: number | null }
  | ({ cmd: 'sink' } & VideoSink)
  | { cmd: 'quit' };

export type VideoIceState = 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed';

export interface VideoStatsEvent {
  event: 'stats';
  id: string;
  dir: 'send' | 'recv';
  fps: number;
  kbps: number;
  width: number;
  height: number;
  rtt_ms?: number | null;
  loss_pct?: number | null;
  bwe_kbps?: number | null;
  enc_us?: number | null;
  dec_us?: number | null;
  freeze_ms?: number | null;
  encoder?: string | null;
  decoder?: string | null;
  quality_limitation?: string | null;
  /** D10.5 (send): the rung applied to this peer and the controller's state (`auto` | `probe` | `pin` | `trouble:<kinds>`). */
  rung?: number | null;
  rung_kbps?: number | null;
  rung_fps?: number | null;
  ctrl?: string | null;
  queue_ms?: number | null;
  peer_decode_fps?: number | null;
}

/**
 * D10.5: the rung the helper's controller (or the pin) applies to the frames sent to peer `id`, on each change:
 * `reason` is `start` | `probe` | `down:loss` | `down:rtt` | `down:bwe` | `down:fps` | `down:receiver` | `up` | `pin` | `ceiling`.
 */
export interface VideoRungEvent {
  event: 'rung';
  id: string;
  rung: number;
  width: number;
  height: number;
  fps: number;
  kbps: number;
  reason: string;
}

export type VideoHelperEvent =
  | { event: 'ready'; version: string; encoder: string; decoder: string }
  | ({ event: 'signal' } & VideoSignalBody)
  /**
   * D10.3.6 (2026-11-07): `restarts` counts the ICE restarts the helper made for this peer (with `connected`: how many it
   * took); `restarts_exhausted: true` with `failed` means it gave up (its restart policy is spent): the mesh falls back.
   */
  | { event: 'peer'; id: string; ice: VideoIceState; pair?: string | null; restarts?: number | null; restarts_exhausted?: boolean | null }
  | VideoStatsEvent
  | VideoRungEvent
  /** `window` (D10.6): the window a `wgc` source is capturing, `"<title>" WxH (pid n)`, while it has one. */
  | { event: 'source'; kind: VideoSource['kind']; state: 'ok' | 'missing' | 'dead'; fps_in: number; window?: string | null }
  | { event: 'error'; code: string; text?: string }
  | { event: 'log'; level: 'info' | 'warn'; text: string };

/** One stdout line as an event: a JSON object whose `event` is a string; anything else is null (the caller logs it once). */
export function parseHelperEvent(text: string): VideoHelperEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const e = v as { event?: unknown };
  if (typeof e.event !== 'string' || !e.event) return null;
  return v as VideoHelperEvent;
}

// ---- the process ----

export interface VideoHelperStatus {
  /** `stopped`: not started (or stopped); `starting`: spawned, no `ready` yet (or waiting to restart); `ready`; `unavailable`. */
  helper: 'stopped' | 'starting' | 'ready' | 'unavailable';
  /** `helper_missing`, `helper_failed:<code>`, `restarting` while a restart waits; else null. */
  reason: string | null;
  version: string | null;
  encoder: string | null;
  decoder: string | null;
  /**
   * D10.3.4 (2026-11-07): the spawn count: 0 before the first spawn, +1 at every spawn (a restart's too). The mesh keys
   * what it told the helper on it: a `ready` for a generation it has synced already is a no-op (the first match on
   * 0.2.37 synced at the status and again 200 ms later at the event, and the second `peer` command replaced a
   * connection that had already answered). The status is current before the `ready` event fans out.
   */
  generation: number;
}

export interface VideoHelper {
  /** Starts the helper if it is not running (idempotent); its availability shows in `status()`. */
  start(): void;
  /** One command line; false (nothing written) while the helper is not running and ready: say it again at the next `ready`. */
  send(cmd: VideoHelperCommand): boolean;
  /** Every event the helper sends, `ready` included (each one, a restart's too), in order. */
  onEvent(cb: (e: VideoHelperEvent) => void): () => void;
  status(): VideoHelperStatus;
  onStatus(cb: (s: VideoHelperStatus) => void): () => void;
  /** `quit`, end stdin, wait for the exit. */
  stop(): Promise<void>;
}

type Spawn = (cmd: string, args: string[], opts: { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess;

export interface VideoHelperOptions {
  /** From `resolveVideoHelper`; null → `unavailable helper_missing`. */
  exe: string | null;
  /** Arguments before the helper's own (none for the real exe; a test runs a script through node). */
  args?: string[];
  log: (line: string) => void;
  spawn?: Spawn;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

export function createVideoHelper(opts: VideoHelperOptions): VideoHelper {
  const sp: Spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn);
  const now = opts.now ?? Date.now;
  const later = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const statusListeners = new Set<(s: VideoHelperStatus) => void>();
  const eventListeners = new Set<(e: VideoHelperEvent) => void>();
  let child: ChildProcess | null = null;
  let ready = false;
  let stopping = false;
  let gaveUp: string | null = opts.exe ? null : 'helper_missing';
  let lastSpawn = -Infinity;
  let restartTimer: unknown = null;
  let probe: { version: string | null; encoder: string | null; decoder: string | null } = { version: null, encoder: null, decoder: null };
  let missingSaid = false;
  let generation = 0;
  let current: VideoHelperStatus = { helper: gaveUp ? 'unavailable' : 'stopped', reason: gaveUp, version: null, encoder: null, decoder: null, generation };

  const computed = (): VideoHelperStatus => ({
    helper: gaveUp ? 'unavailable' : ready ? 'ready' : child || restartTimer ? 'starting' : 'stopped',
    reason: gaveUp ?? (restartTimer ? 'restarting' : null),
    version: probe.version,
    encoder: probe.encoder,
    decoder: probe.decoder,
    generation,
  });
  const emit = (): void => {
    const s = computed();
    if (JSON.stringify(s) === JSON.stringify(current)) return;
    current = s;
    for (const l of [...statusListeners]) l(s);
  };
  const fan = (e: VideoHelperEvent): void => {
    for (const l of [...eventListeners]) {
      try {
        l(e);
      } catch (err) {
        opts.log(`video: an event listener failed on ${e.event}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const onEvent = (e: VideoHelperEvent): void => {
    switch (e.event) {
      case 'ready':
        ready = true;
        probe = { version: typeof e.version === 'string' ? e.version : null, encoder: typeof e.encoder === 'string' ? e.encoder : null, decoder: typeof e.decoder === 'string' ? e.decoder : null };
        opts.log(`video: helper ${probe.version ?? '(no version)'} ready (encoder ${probe.encoder ?? '?'}, decoder ${probe.decoder ?? '?'})`);
        emit();
        break;
      case 'error':
        opts.log(`video: helper error ${e.code}${e.text ? `: ${e.text}` : ''}`);
        break;
      case 'log':
        opts.log(`video: ${e.level === 'warn' ? 'warning: ' : ''}${e.text}`);
        break;
      default:
        break;
    }
    fan(e);
  };

  const launch = (): void => {
    if (!opts.exe || child || stopping || gaveUp) return;
    let c: ChildProcess;
    try {
      c = sp(opts.exe, opts.args ?? [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      giveUp(`helper_failed:${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    child = c;
    ready = false;
    generation += 1;
    lastSpawn = now();
    let sawReady = false;
    let unreadableSaid = false;
    c.stdin?.on('error', () => {}); // EPIPE when the helper exits first; the exit handler reports it
    readLines(c.stdout, MAX_LINE, (line) => {
      if (child !== c) return;
      const e = parseHelperEvent(line);
      if (!e) {
        if (!unreadableSaid) {
          unreadableSaid = true;
          opts.log(`video: an unreadable line from the helper, skipped (logged once per run of it): ${line.slice(0, 120)}`);
        }
        return;
      }
      if (e.event === 'ready') sawReady = true;
      onEvent(e);
    });
    readLines(c.stderr, 64 * 1024, (line) => opts.log(line.startsWith('video:') ? line : `video: ${line}`));
    let exited = false;
    const onExit = (code: number | null, why: string): void => {
      if (exited) return;
      exited = true;
      if (child !== c) return;
      child = null;
      ready = false;
      if (stopping) {
        emit();
        return;
      }
      if (!sawReady || code === 2 || code === 64) {
        giveUp(`helper_failed:${code ?? why}`);
        return;
      }
      const wait = Math.max(0, lastSpawn + RESTART_MIN_MS - now());
      opts.log(`video: helper exited (${why}); restarting in ${Math.round(wait / 100) / 10} s`);
      restartTimer = later(() => {
        restartTimer = null;
        launch();
        emit();
      }, wait);
      emit();
    };
    c.on('error', (e: NodeJS.ErrnoException) => {
      if (child !== c) return;
      opts.log(`video: helper failed to start: ${e.message}`);
      child = null;
      exited = true;
      giveUp(e.code === 'ENOENT' ? 'helper_missing' : `helper_failed:${e.code ?? 'spawn'}`);
    });
    c.on('close', (code: number | null, signal: NodeJS.Signals | null) => onExit(code, code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`));
    emit();
  };

  function giveUp(reason: string): void {
    gaveUp = reason;
    if (restartTimer) cancel(restartTimer);
    restartTimer = null;
    opts.log(`video: native spectator video unavailable (${reason}); the match goes on with the Electron video`);
    emit();
  }

  return {
    start() {
      if (!opts.exe) {
        if (!missingSaid) {
          missingSaid = true;
          opts.log('video: no spectator-video helper in this build; the Electron video path serves the match');
        }
        return;
      }
      if (child || restartTimer) return;
      stopping = false;
      launch();
    },
    send(cmd) {
      const c = child;
      if (!c || !ready || !c.stdin || c.stdin.destroyed) return false;
      c.stdin.write(`${JSON.stringify(cmd)}\n`);
      return true;
    },
    onEvent(cb) {
      eventListeners.add(cb);
      return () => void eventListeners.delete(cb);
    },
    status: () => current,
    onStatus(cb) {
      statusListeners.add(cb);
      return () => void statusListeners.delete(cb);
    },
    async stop() {
      stopping = true;
      if (restartTimer) cancel(restartTimer);
      restartTimer = null;
      const c = child;
      if (!c) {
        emit();
        return;
      }
      await new Promise<void>((done) => {
        const t = setTimeout(() => {
          c.kill();
          done();
        }, STOP_GRACE_MS);
        c.once('close', () => {
          clearTimeout(t);
          done();
        });
        if (c.stdin && !c.stdin.destroyed) {
          c.stdin.write('{"cmd":"quit"}\n');
          c.stdin.end();
        }
      });
      child = null;
      ready = false;
      emit();
    },
  };
}

/** Lines off a stream in whatever chunks it comes; a run past `max` with no newline is dropped (not ours). */
function readLines(stream: NodeJS.ReadableStream | null | undefined, max: number, cb: (line: string) => void): void {
  let carry = '';
  stream?.on('data', (b: Buffer) => {
    const parts = (carry + b.toString('utf8')).split(/\r?\n/);
    carry = parts.pop() ?? '';
    if (carry.length > max) carry = '';
    for (const p of parts) if (p.trim()) cb(p.trim());
  });
  stream?.on('end', () => {
    if (carry.trim()) cb(carry.trim());
    carry = '';
  });
}
