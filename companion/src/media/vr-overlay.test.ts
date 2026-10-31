import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelFrame, PanelFrameSource, VrOverlayStatus } from './match-media-types.js';
import { KEEPALIVE_MS } from './panel-frame-writer.js';
import { createVrOverlay, helperArgs, resolveVrOverlay, RESTART_DELAY_MS, STOP_GRACE_MS, VR_OVERLAY_EXE } from './vr-overlay.js';

/** stdin under the test's control: `accept = false` makes `write` report a full pipe until `drain()`. */
class FakeStdin extends EventEmitter {
  readonly chunks: Buffer[] = [];
  accept = true;
  ended = false;
  writable = true;
  write(chunk: Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk));
    return this.accept;
  }
  end(): void {
    this.ended = true;
    this.writable = false;
  }
  drain(): void {
    this.accept = true;
    this.emit('drain');
  }
}

/** A scripted helper: the test prints its stdout lines and decides when it exits. Events are synchronous. */
class FakeHelper extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  constructor(readonly args: string[]) {
    super();
    queueMicrotask(() => this.emit('spawn'));
  }
  say(event: string, extra: Record<string, string> = {}): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify({ event, ...extra }) + '\n'));
  }
  exit(code: number | null): void {
    this.emit('close', code, code === null ? 'SIGTERM' : null);
  }
  kill(): boolean {
    this.killed = true;
    this.exit(null);
    return true;
  }
  /** Frames written so far, as [width, height, first pixel byte]. */
  frames(): Array<[number, number, number]> {
    const all = Buffer.concat(this.stdin.chunks);
    const out: Array<[number, number, number]> = [];
    for (let at = 0; at < all.length; ) {
      expect(all.subarray(at, at + 4).toString('latin1')).toBe('CVO1');
      const w = all.readUInt32LE(at + 4), h = all.readUInt32LE(at + 8), n = all.readUInt32LE(at + 12);
      out.push([w, h, all[at + 16]!]);
      at += 16 + n;
    }
    return out;
  }
}

function frame(tag: number, width = 2, height = 1): PanelFrame {
  return { width, height, bgra: new Uint8Array(width * height * 4).fill(tag) };
}

function source() {
  const cbs = new Set<(f: PanelFrame) => void>();
  const src: PanelFrameSource = {
    onFrame(cb) {
      cbs.add(cb);
      return () => void cbs.delete(cb);
    },
  };
  return { src, push: (f: PanelFrame) => cbs.forEach((cb) => cb(f)), listeners: () => cbs.size };
}

function setup(exePath: string | null = 'C:/x/castcade-vr-overlay.exe') {
  const helpers: FakeHelper[] = [];
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const h = new FakeHelper(args);
    helpers.push(h);
    return h as never;
  });
  const log: string[] = [];
  const ov = createVrOverlay({ exePath, spawn, log: (l) => log.push(l) });
  const states: VrOverlayStatus[] = [];
  ov.onStatus((s) => states.push(s));
  return { ov, spawn, helpers, log, states, ...source() };
}

afterEach(() => vi.useRealTimers());

describe('resolveVrOverlay', () => {
  const at = (...have: string[]) => (p: string) => have.includes(p);
  const companionDir = resolve('/repo/companion');
  const built = resolve(companionDir, '..', 'vr-overlay', 'build', 'Release', VR_OVERLAY_EXE);
  const fetched = resolve(companionDir, 'resources', 'vr-overlay', VR_OVERLAY_EXE);

  it('packaged: resources/vr-overlay', () => {
    const p = join('/app/resources', 'vr-overlay', VR_OVERLAY_EXE);
    expect(resolveVrOverlay({ packaged: true, resourcesPath: '/app/resources', companionDir }, at(p))).toBe(p);
  });

  it('dev: the local CMake build first, then a fetched copy, else null', () => {
    const i = { packaged: false, resourcesPath: '', companionDir };
    expect(resolveVrOverlay(i, at(built, fetched))).toBe(built);
    expect(resolveVrOverlay(i, at(fetched))).toBe(fetched);
    expect(resolveVrOverlay(i, at())).toBeNull();
  });
});

describe('createVrOverlay', () => {
  it('passes the default placement on the command line', async () => {
    const { ov, spawn, src } = setup();
    await ov.start(src);
    expect(spawn.mock.calls[0]![0]).toBe('C:/x/castcade-vr-overlay.exe');
    expect(spawn.mock.calls[0]![1]).toEqual(['--width-m', '0.55', '--anchor', 'hmd', '--offset', '0,-0.28,-0.9', '--alpha', '0.95']);
    expect(helperArgs({ widthM: 0.7, anchor: 'world', offset: [0.1, 0, -1], alpha: 1 })).toEqual(['--width-m', '0.7', '--anchor', 'world', '--offset', '0.1,0,-1', '--alpha', '1']);
  });

  it('without the exe: unavailable helper_missing, nothing spawned', async () => {
    const { ov, spawn, src } = setup(null);
    expect(await ov.start(src)).toEqual({ state: 'unavailable', reason: 'helper_missing' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starting → showing on ready, hidden, showing again; frames go up as header + BGRA', async () => {
    const { ov, helpers, states, src, push } = setup();
    expect(await ov.start(src)).toEqual({ state: 'starting', reason: null });
    const h = helpers[0]!;
    push(frame(7));
    expect(h.frames()).toEqual([[2, 1, 7]]);
    expect(h.stdin.chunks[1]!.length).toBe(8);
    h.say('ready');
    expect(ov.status().state).toBe('showing');
    h.say('hidden');
    h.say('showing');
    h.stderr.emit('data', Buffer.from('castcade-vr-overlay 0.1.0 (OpenVR v2.15.6)\n'));
    expect(states.map((s) => s.state)).toEqual(['starting', 'showing', 'hidden', 'showing']);
  });

  it('exit 2: unavailable steamvr_not_running, no restart, the source is let go', async () => {
    vi.useFakeTimers();
    const { ov, spawn, helpers, src, listeners } = setup();
    await ov.start(src);
    helpers[0]!.say('unavailable', { reason: 'steamvr_not_running' });
    helpers[0]!.exit(2);
    expect(ov.status()).toEqual({ state: 'unavailable', reason: 'steamvr_not_running' });
    vi.advanceTimersByTime(RESTART_DELAY_MS * 2);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(listeners()).toBe(0);
  });

  it('an unexpected exit restarts once after 2 s (the last frame re-sent at once); a second one gives up', async () => {
    vi.useFakeTimers();
    const { ov, spawn, helpers, src, push, log } = setup();
    await ov.start(src);
    push(frame(1));
    helpers[0]!.say('ready');
    helpers[0]!.exit(1);
    expect(ov.status()).toEqual({ state: 'starting', reason: null });
    vi.advanceTimersByTime(RESTART_DELAY_MS - 1);
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(helpers[1]!.frames()).toEqual([[2, 1, 1]]);
    push(frame(2));
    expect(helpers[1]!.frames()).toEqual([[2, 1, 1], [2, 1, 2]]);
    helpers[1]!.exit(1);
    expect(ov.status()).toEqual({ state: 'unavailable', reason: 'helper_failed:1' });
    vi.advanceTimersByTime(RESTART_DELAY_MS * 2);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(log.some((l) => l.includes('helper exited (code 1)'))).toBe(true);
  });

  it('exit 3 (an OpenVR error) gives up at once', async () => {
    const { ov, spawn, helpers, src } = setup();
    await ov.start(src);
    helpers[0]!.say('error', { reason: 'overlay_create', detail: 'VROverlayError_KeyInUse' });
    helpers[0]!.exit(3);
    expect(ov.status()).toEqual({ state: 'unavailable', reason: 'helper_failed:3' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('drops frames while the pipe is behind and writes the newest on drain', async () => {
    const { ov, helpers, src, push } = setup();
    await ov.start(src);
    const h = helpers[0]!;
    h.stdin.accept = false;
    push(frame(1)); // written; the pipe now reports full
    push(frame(2)); // skipped
    push(frame(3)); // skipped
    expect(h.frames().map((f) => f[2])).toEqual([1]);
    h.stdin.drain();
    expect(h.frames().map((f) => f[2])).toEqual([1, 3]);
    push(frame(4));
    expect(h.frames().map((f) => f[2])).toEqual([1, 3, 4]);
  });

  it('a frame whose bytes do not match its size is dropped, not sent (it would end the helper)', async () => {
    const { ov, helpers, src, push, log } = setup();
    await ov.start(src);
    push({ width: 4, height: 4, bgra: new Uint8Array(10) });
    expect(helpers[0]!.stdin.chunks).toEqual([]);
    expect(log[0]).toMatch(/dropped a 4x4 frame of 10 bytes/);
  });

  it('re-sends the last frame when the panel has been still for the keepalive interval', async () => {
    vi.useFakeTimers();
    const { ov, helpers, src, push } = setup();
    await ov.start(src);
    push(frame(5));
    vi.advanceTimersByTime(KEEPALIVE_MS - 1);
    expect(helpers[0]!.frames()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(helpers[0]!.frames()).toEqual([[2, 1, 5], [2, 1, 5]]);
  });

  it('stop() ends stdin and waits for the helper to exit; stopped, no restart', async () => {
    vi.useFakeTimers();
    const { ov, spawn, helpers, src, listeners } = setup();
    await ov.start(src);
    const stopped = ov.stop();
    expect(helpers[0]!.stdin.ended).toBe(true);
    helpers[0]!.say('eof');
    helpers[0]!.exit(0);
    await stopped;
    expect(ov.status()).toEqual({ state: 'stopped', reason: null });
    expect(helpers[0]!.killed).toBe(false);
    expect(listeners()).toBe(0);
    vi.advanceTimersByTime(RESTART_DELAY_MS * 2);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('stop() kills a helper that has not exited after 2 s', async () => {
    vi.useFakeTimers();
    const { ov, helpers, src } = setup();
    await ov.start(src);
    const stopped = ov.stop();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    await stopped;
    expect(helpers[0]!.killed).toBe(true);
    expect(ov.status().state).toBe('stopped');
  });

  it('a spawn failure (ENOENT) reports helper_missing, without a restart', async () => {
    const spawn = vi.fn(() => {
      const c = new EventEmitter() as EventEmitter & { stdin: FakeStdin; stdout: EventEmitter; stderr: EventEmitter };
      Object.assign(c, { stdin: new FakeStdin(), stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        c.emit('error', Object.assign(new Error('spawn castcade-vr-overlay.exe ENOENT'), { code: 'ENOENT' }));
        c.emit('close', -4058, null);
      });
      return c as never;
    });
    const ov = createVrOverlay({ exePath: 'C:/gone.exe', spawn, log: () => {} });
    expect(await ov.start(source().src)).toEqual({ state: 'unavailable', reason: 'helper_missing' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
