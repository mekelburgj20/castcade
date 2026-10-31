/**
 * The OpenVR overlay helper as the match controller drives it (D7, 2026-10-30; docs/design/alpha-match.md §5): spawns
 * `castcade-vr-overlay.exe` (vr-overlay/README.md), pipes the panel's frames into its stdin and turns its stdout JSON
 * lines into `VrOverlayStatus`. No Electron here; the caller resolves the exe path (`resolveVrOverlay`) and hands in
 * the frame source.
 *
 * Rules:
 *   - frames: header (`frameHeader`) + BGRA bytes, as they come. While the previous write has not drained, new frames
 *     are not written; the newest one is written on `drain` (the ones in between are dropped: a VR panel wants the
 *     current picture, never a backlog);
 *   - keepalive: the panel page paints only when the picture changes, and the helper hides the overlay after 5 s
 *     without a frame, so the last frame is re-sent when nothing was written for `KEEPALIVE_MS`;
 *   - exit 2 (or SteamVR's quit) → `unavailable steamvr_not_running`; exit 3 (OpenVR error) or 64 (bad arguments) →
 *     `unavailable helper_failed:<code>` at once (a restart would fail the same way); any other exit we did not ask for
 *     → one restart after `RESTART_DELAY_MS`, then `unavailable helper_failed:<code>`;
 *   - `stop()` ends stdin (the helper hides, shuts OpenVR down and exits 0), waits up to `STOP_GRACE_MS`, then kills.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VR_OVERLAY_DEFAULTS, VR_OVERLAY_FRAME_MAGIC, type PanelFrame, type PanelFrameSource, type VrOverlay, type VrOverlayStatus } from './match-media-types.js';

export const VR_OVERLAY_EXE = 'castcade-vr-overlay.exe';
/** The helper refuses larger frames (exit 4); `frameHeader` refuses them first. */
export const VR_OVERLAY_MAX_SIDE = 4096;
export const RESTART_DELAY_MS = 2000;
export const STOP_GRACE_MS = 2000;
/** Below the helper's 5 s hide timeout, with room for a slow write. */
export const KEEPALIVE_MS = 2000;

/** Placement flags. Wider than `typeof VR_OVERLAY_DEFAULTS` (whose literals are `as const`), so any value fits. */
export interface VrOverlayPlacement {
  widthM: number;
  anchor: 'hmd' | 'world';
  /** Metres from the head: right, up, forward negative. */
  offset: readonly [number, number, number];
  alpha: number;
}

export interface VrOverlayPathInput {
  packaged: boolean;
  /** process.resourcesPath when packaged. */
  resourcesPath: string;
  /** The companion package directory (dev runs). */
  companionDir: string;
}

/**
 * Where the helper is: packaged, `resources/vr-overlay/` (fetch-vr-overlay.mjs, shipped by electron-builder.yml);
 * dev, a local CMake build (`vr-overlay/build/Release/`) first, else a fetched copy in `companion/resources/vr-overlay/`.
 * Null when none exists (the overlay then reports `unavailable helper_missing`).
 */
export function resolveVrOverlay(i: VrOverlayPathInput, exists: (p: string) => boolean = existsSync): string | null {
  const candidates = i.packaged
    ? [join(i.resourcesPath, 'vr-overlay', VR_OVERLAY_EXE)]
    : [resolve(i.companionDir, '..', 'vr-overlay', 'build', 'Release', VR_OVERLAY_EXE), resolve(i.companionDir, 'resources', 'vr-overlay', VR_OVERLAY_EXE)];
  return candidates.find((p) => exists(p)) ?? null;
}

/** The frame pipe's 16-byte little-endian header: "CVO1", width, height, byteLength (= width * height * 4). */
export function frameHeader(width: number, height: number): Buffer {
  for (const [name, v] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > VR_OVERLAY_MAX_SIDE) throw new RangeError(`frame ${name} ${v} is outside 1..${VR_OVERLAY_MAX_SIDE}`);
  }
  const h = Buffer.alloc(16);
  h.write(VR_OVERLAY_FRAME_MAGIC, 0, 'latin1');
  h.writeUInt32LE(width, 4);
  h.writeUInt32LE(height, 8);
  h.writeUInt32LE(width * height * 4, 12);
  return h;
}

/** The helper's command line for a placement. */
export function helperArgs(p: VrOverlayPlacement): string[] {
  return ['--width-m', String(p.widthM), '--anchor', p.anchor, '--offset', p.offset.map(String).join(','), '--alpha', String(p.alpha)];
}

type Spawn = (cmd: string, args: string[], opts: { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess;

export interface VrOverlayOptions {
  /** From `resolveVrOverlay`; null → `unavailable helper_missing`. */
  exePath: string | null;
  spawn?: Spawn;
  log: (line: string) => void;
  defaults?: Partial<VrOverlayPlacement>;
}

export function createVrOverlay(opts: VrOverlayOptions): VrOverlay {
  const sp: Spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn);
  const placement: VrOverlayPlacement = { ...VR_OVERLAY_DEFAULTS, ...opts.defaults };
  const listeners = new Set<(s: VrOverlayStatus) => void>();
  let current: VrOverlayStatus = { state: 'stopped', reason: null };
  let child: ChildProcess | null = null;
  let unsubscribe: (() => void) | null = null;
  let restarted = false;
  let stopping = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The newest frame from the source, and whether the running helper has been sent it. */
  let latest: PanelFrame | null = null;
  let latestSent = false;
  /** The last write returned false: wait for `drain` before writing again. */
  let blocked = false;

  const set = (state: VrOverlayStatus['state'], reason: string | null = null) => {
    if (current.state === state && current.reason === reason) return;
    current = { state, reason };
    for (const l of [...listeners]) l(current);
  };

  const clearTimers = () => {
    if (restartTimer) clearTimeout(restartTimer);
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    restartTimer = keepaliveTimer = null;
  };

  /** The helper is gone for good: stop feeding it. */
  const giveUp = (reason: string) => {
    clearTimers();
    unsubscribe?.();
    unsubscribe = null;
    set('unavailable', reason);
  };

  const send = () => {
    const stdin = child?.stdin;
    if (!stdin || !stdin.writable || blocked || !latest || latestSent) return;
    const f = latest;
    latestSent = true;
    if (f.bgra.length !== f.width * f.height * 4) {
      opts.log(`vr-overlay: dropped a ${f.width}x${f.height} frame of ${f.bgra.length} bytes (want ${f.width * f.height * 4})`);
      return;
    }
    let header: Buffer;
    try {
      header = frameHeader(f.width, f.height);
    } catch (e) {
      opts.log(`vr-overlay: dropped a frame: ${(e as Error).message}`);
      return;
    }
    stdin.write(header);
    blocked = !stdin.write(f.bgra); // the header shares the same buffer, so the second answer covers both
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = null;
      latestSent = false;
      send(); // when blocked, `drain` sends it
    }, KEEPALIVE_MS);
  };

  const onFrame = (f: PanelFrame) => {
    latest = f;
    latestSent = false;
    send();
  };

  const launch = () => {
    const c = sp(opts.exePath!, helperArgs(placement), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = c;
    blocked = false;
    latestSent = false;
    let lastError: string | null = null;
    let steamVrGone = false;
    set('starting');
    c.stdin?.on('error', () => {}); // EPIPE when the helper exits first; the exit handler reports it
    c.stdin?.on('drain', () => {
      if (child !== c) return;
      blocked = false;
      send();
    });
    readLines(c.stdout, (line) => {
      let ev: { event?: unknown; reason?: unknown; detail?: unknown };
      try {
        ev = JSON.parse(line) as typeof ev;
      } catch {
        opts.log(`vr-overlay: ${line}`);
        return;
      }
      if (child !== c) return;
      switch (ev.event) {
        case 'ready':
        case 'showing':
          set('showing');
          break;
        case 'hidden':
          set('hidden');
          break;
        case 'unavailable':
        case 'quit':
          steamVrGone = true;
          opts.log(`vr-overlay: ${line}`);
          break;
        case 'error':
          lastError = line;
          opts.log(`vr-overlay: ${line}`);
          break;
        default:
          break; // eof, and anything a later helper adds
      }
    });
    readLines(c.stderr, (line) => opts.log(`vr-overlay: ${line}`));
    let exited = false;
    const onExit = (code: number | null, why: string) => {
      if (exited) return;
      exited = true;
      if (child !== c) return;
      child = null;
      if (keepaliveTimer) clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
      if (stopping) {
        set('stopped');
        return;
      }
      if (code === 2 || steamVrGone) return giveUp('steamvr_not_running');
      opts.log(`vr-overlay: helper exited (${why})${lastError ? `, last error ${lastError}` : ''}`);
      if (code === 3 || code === 64 || restarted) return giveUp(`helper_failed:${code ?? why}`);
      restarted = true;
      set('starting');
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!stopping) launch();
      }, RESTART_DELAY_MS);
    };
    c.on('error', (e: NodeJS.ErrnoException) => {
      opts.log(`vr-overlay: helper failed to start: ${e.message}`);
      if (child !== c) return;
      child = null;
      exited = true;
      giveUp(e.code === 'ENOENT' ? 'helper_missing' : `helper_failed:${e.code ?? 'spawn'}`);
    });
    c.on('close', (code: number | null, signal: NodeJS.Signals | null) => onExit(code, code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`));
    send(); // after a restart: the last frame goes up at once, not at the next paint
    return c;
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    clearTimers();
    unsubscribe?.();
    unsubscribe = null;
    latest = null;
    const c = child;
    if (!c) {
      set('stopped');
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
      c.stdin?.end();
    });
    child = null;
    set('stopped');
  };

  return {
    async start(source: PanelFrameSource): Promise<VrOverlayStatus> {
      if (child || restartTimer || unsubscribe) await stop();
      if (!opts.exePath) {
        set('unavailable', 'helper_missing');
        return current;
      }
      stopping = false;
      restarted = false;
      latest = null;
      unsubscribe = source.onFrame(onFrame);
      const c = launch();
      // Settle once the OS has started it (or refused to): a missing exe reports here, SteamVR's absence a moment later.
      await new Promise<void>((done) => {
        c.once('spawn', () => done());
        c.once('error', () => done());
        c.once('close', () => done());
      });
      return current;
    },

    stop,

    status: () => current,

    onStatus(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}

function readLines(stream: NodeJS.ReadableStream | null | undefined, cb: (line: string) => void): void {
  let carry = '';
  stream?.on('data', (b: Buffer) => {
    const parts = (carry + b.toString('utf8')).split(/\r?\n/);
    carry = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) cb(p.trim());
  });
  stream?.on('end', () => {
    if (carry.trim()) cb(carry.trim());
    carry = '';
  });
}
