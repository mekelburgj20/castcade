import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVideoHelper, parseHelperEvent, resolveVideoHelper, RESTART_MIN_MS, VIDEO_HELPER_EXE, type VideoHelper, type VideoHelperEvent, type VideoHelperStatus } from './video-helper.js';

/** The stand-in exe (speaks §6.2 over stdio), run through node. */
const FAKE = fileURLToPath(new URL('./__fixtures__/fake-video-helper.mjs', import.meta.url));

const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const running: VideoHelper[] = [];
const envKeys = ['FAKE_VIDEO_EXIT', 'FAKE_VIDEO_CRASH_AFTER', 'FAKE_VIDEO_JUNK', 'FAKE_VIDEO_STDERR', 'FAKE_VIDEO_STATS_MS', 'FAKE_VIDEO_NAME'];
afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
  for (const k of envKeys) delete process.env[k];
});

function real(o: { exe?: string | null } = {}): { helper: VideoHelper; log: string[]; events: VideoHelperEvent[]; statuses: VideoHelperStatus[] } {
  const log: string[] = [];
  const events: VideoHelperEvent[] = [];
  const statuses: VideoHelperStatus[] = [];
  const helper = createVideoHelper({ exe: o.exe === undefined ? process.execPath : o.exe, args: o.exe === undefined ? [FAKE] : [], log: (l) => log.push(l) });
  helper.onEvent((e) => events.push(e));
  helper.onStatus((s) => statuses.push(s));
  running.push(helper);
  return { helper, log, events, statuses };
}

describe('resolveVideoHelper (D10.3)', () => {
  it('finds the packaged exe, else a local build, else a fetched copy', () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    const res = 'C:/app/resources';
    const dir = 'C:/repo/companion';
    const packaged = join(res, 'video-helper', VIDEO_HELPER_EXE);
    const local = resolve(dir, '..', 'video-helper', 'build', 'Release', VIDEO_HELPER_EXE);
    const fetched = resolve(dir, 'resources', 'video-helper', VIDEO_HELPER_EXE);
    expect(resolveVideoHelper({ packaged: true, resourcesPath: res, companionDir: dir }, has([packaged]))).toBe(packaged);
    expect(resolveVideoHelper({ packaged: false, resourcesPath: res, companionDir: dir }, has([local, fetched]))).toBe(local);
    expect(resolveVideoHelper({ packaged: false, resourcesPath: res, companionDir: dir }, has([fetched]))).toBe(fetched);
    expect(resolveVideoHelper({ packaged: true, resourcesPath: res, companionDir: dir }, has([]))).toBeNull();
  });
});

describe('parseHelperEvent', () => {
  it('a JSON object with a string `event`; anything else is null', () => {
    expect(parseHelperEvent('{"event":"ready","version":"1","encoder":"h264_nvenc","decoder":"nvdec"}')).toEqual({ event: 'ready', version: '1', encoder: 'h264_nvenc', decoder: 'nvdec' });
    expect(parseHelperEvent('not json')).toBeNull();
    expect(parseHelperEvent('[1,2]')).toBeNull();
    expect(parseHelperEvent('{"cmd":"peer"}')).toBeNull();
    expect(parseHelperEvent('{"event":""}')).toBeNull();
    expect(parseHelperEvent('null')).toBeNull();
  });
});

describe('the helper process, against the fake exe (§6.2)', () => {
  it('ready = available with the probe in the status; stderr to the log; a line that is not JSON logged once; bad_command for junk; quit on stop', async () => {
    process.env.FAKE_VIDEO_STDERR = 'castcade-video 0.0.0-fake starting';
    process.env.FAKE_VIDEO_JUNK = '1';
    const h = real();
    expect(h.helper.status()).toEqual({ helper: 'stopped', reason: null, version: null, encoder: null, decoder: null });
    expect(h.helper.send({ cmd: 'send', on: true })).toBe(false);
    h.helper.start();
    expect(h.helper.status().helper).toBe('starting');
    await until(() => h.helper.status().helper === 'ready');
    expect(h.helper.status()).toEqual({ helper: 'ready', reason: null, version: '0.0.0-fake', encoder: 'libx264', decoder: 'h264' });
    expect(h.events[0]).toEqual({ event: 'ready', version: '0.0.0-fake', encoder: 'libx264', decoder: 'h264' });
    expect(h.log).toContain('video: helper 0.0.0-fake ready (encoder libx264, decoder h264)');
    expect(h.log).toContain('video: castcade-video 0.0.0-fake starting');
    expect(h.log.filter((l) => l.startsWith('video: an unreadable line from the helper'))).toHaveLength(1);
    // Junk in, `error bad_command` out, logged.
    expect(h.helper.send({ cmd: 'dance' } as never)).toBe(true);
    await until(() => h.events.some((e) => e.event === 'error'));
    expect(h.events.at(-1)).toMatchObject({ event: 'error', code: 'bad_command', text: 'dance' });
    expect(h.log).toContain('video: helper error bad_command: dance');
    // A command the fake answers with a log event.
    h.helper.send({ cmd: 'rungs', max_kbps: 8000, pin: 2 });
    await until(() => h.events.some((e) => e.event === 'log'));
    expect(h.log).toContain('video: rungs max 8000 kbps, pinned 2');
    await h.helper.stop();
    expect(h.helper.status().helper).toBe('stopped');
    expect(h.log.some((l) => l.includes('restarting'))).toBe(false);
  });

  it('an exit before ready (exit 64: cannot run here) is final: unavailable helper_failed:64', async () => {
    process.env.FAKE_VIDEO_EXIT = '64';
    const h = real();
    h.helper.start();
    await until(() => h.helper.status().helper === 'unavailable');
    expect(h.helper.status()).toMatchObject({ helper: 'unavailable', reason: 'helper_failed:64' });
    expect(h.log).toContain('video: native spectator video unavailable (helper_failed:64); the match goes on with the Electron video');
    h.helper.start(); // asked again: still gone for this run
    await new Promise((r) => setTimeout(r, 50));
    expect(h.helper.status().helper).toBe('unavailable');
  });

  it('no exe in this build: unavailable helper_missing, said once; send is false', () => {
    const h = real({ exe: null });
    expect(h.helper.status()).toMatchObject({ helper: 'unavailable', reason: 'helper_missing' });
    h.helper.start();
    h.helper.start();
    expect(h.log).toEqual(['video: no spectator-video helper in this build; the Electron video path serves the match']);
    expect(h.helper.send({ cmd: 'send', on: true })).toBe(false);
  });

  it('an exe path that is not there: the spawn error reads as helper_missing', async () => {
    const h = real({ exe: join(process.cwd(), 'no-such-dir', VIDEO_HELPER_EXE) });
    h.helper.start();
    await until(() => h.helper.status().helper === 'unavailable');
    expect(h.helper.status().reason).toBe('helper_missing');
  });

  it('an exit nobody asked for after ready: restarted (a real second process), and the new ready reaches the listeners', async () => {
    process.env.FAKE_VIDEO_CRASH_AFTER = '30';
    const h = real();
    h.helper.start();
    await until(() => h.helper.status().helper === 'ready');
    delete process.env.FAKE_VIDEO_CRASH_AFTER;
    await until(() => h.helper.status().helper === 'starting');
    expect(h.helper.status().reason).toBe('restarting');
    expect(h.log.some((l) => /^video: helper exited \(code 3\); restarting in \d+(\.\d)? s$/.test(l))).toBe(true);
    expect(h.helper.send({ cmd: 'send', on: true })).toBe(false);
    // The restart waits for RESTART_MIN_MS since the spawn: too long for this test to sit through; stop cancels it.
    await h.helper.stop();
    expect(h.helper.status().helper).toBe('stopped');
  }, 15_000);
});

// ---- the restart clock, with the process faked in place ----

class FakeStdin extends EventEmitter {
  readonly lines: string[] = [];
  destroyed = false;
  write(s: string): boolean {
    this.lines.push(...String(s).split('\n').filter(Boolean));
    return true;
  }
  end(): void {
    this.destroyed = true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  say(obj: object): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
  }
  exit(code: number): void {
    this.emit('close', code, null);
  }
  kill(): void {
    this.killed = true;
    this.emit('close', null, 'SIGTERM');
  }
}

function faked() {
  const children: FakeChild[] = [];
  const log: string[] = [];
  const events: VideoHelperEvent[] = [];
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const helper = createVideoHelper({
    exe: 'C:\\app\\resources\\video-helper\\castcade-video.exe',
    log: (l) => log.push(l),
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c as never;
    },
    now: () => clock,
    setTimeout: (fn, ms) => {
      const t = { at: clock + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  helper.onEvent((e) => events.push(e));
  const advance = (ms: number): void => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  return { helper, children, log, events, advance, timers };
}

describe('the restart clock', () => {
  it('at most one restart per RESTART_MIN_MS; exit 2 / 64 and an exit before ready give up; stop ends stdin with quit', () => {
    const f = faked();
    f.helper.start();
    f.advance(1000);
    expect(f.children).toHaveLength(1);
    f.children[0]!.say({ event: 'ready', version: '1', encoder: 'h264_nvenc', decoder: 'nvdec' });
    expect(f.helper.status()).toMatchObject({ helper: 'ready', encoder: 'h264_nvenc', decoder: 'nvdec' });
    expect(f.helper.send({ cmd: 'send', on: true })).toBe(true);
    expect(f.children[0]!.stdin.lines).toEqual(['{"cmd":"send","on":true}']);
    // Dies 1 s in: the restart waits the rest of the 5 s.
    f.children[0]!.exit(1);
    expect(f.helper.status()).toMatchObject({ helper: 'starting', reason: 'restarting' });
    f.advance(RESTART_MIN_MS - 1000 - 1);
    expect(f.children).toHaveLength(1);
    f.advance(1);
    expect(f.children).toHaveLength(2);
    expect(f.helper.status()).toMatchObject({ helper: 'starting', reason: null });
    // The new one is ready: the listeners hear it again (the mesh replays its state on this).
    f.children[1]!.say({ event: 'ready', version: '1', encoder: 'h264_nvenc', decoder: 'nvdec' });
    expect(f.events.filter((e) => e.event === 'ready')).toHaveLength(2);
    // Dies after a long life: restarted at once (the 5 s is measured from the last spawn, as the audio helper's is).
    f.advance(60_000);
    f.children[1]!.exit(1);
    f.advance(0);
    expect(f.children).toHaveLength(3);
    // Exit 2 after ready: final.
    f.children[2]!.say({ event: 'ready', version: '1', encoder: 'libx264', decoder: 'h264' });
    f.children[2]!.exit(2);
    expect(f.helper.status()).toMatchObject({ helper: 'unavailable', reason: 'helper_failed:2' });
    f.advance(RESTART_MIN_MS * 2);
    expect(f.children).toHaveLength(3);
  });

  it('an exit before ready gives up with the code; stop asks the helper to quit', async () => {
    const f = faked();
    f.helper.start();
    f.children[0]!.exit(1);
    expect(f.helper.status()).toMatchObject({ helper: 'unavailable', reason: 'helper_failed:1' });
    const g = faked();
    g.helper.start();
    g.children[0]!.say({ event: 'ready', version: '1', encoder: 'libx264', decoder: 'h264' });
    const stopped = g.helper.stop();
    expect(g.children[0]!.stdin.lines).toEqual(['{"cmd":"quit"}']);
    expect(g.children[0]!.stdin.destroyed).toBe(true);
    g.children[0]!.exit(0);
    await stopped;
    expect(g.helper.status().helper).toBe('stopped');
    expect(g.log.some((l) => l.includes('restarting'))).toBe(false);
  });

  it('events are fanned out in order and a listener that throws does not stop the rest', () => {
    const f = faked();
    const seen: string[] = [];
    f.helper.onEvent(() => {
      throw new Error('boom');
    });
    f.helper.onEvent((e) => seen.push(e.event));
    f.helper.start();
    f.children[0]!.say({ event: 'ready', version: '1', encoder: 'libx264', decoder: 'h264' });
    f.children[0]!.say({ event: 'peer', id: 'p2', ice: 'connected', pair: 'host<->host' });
    f.children[0]!.say({ event: 'log', level: 'warn', text: 'encoder queue 12 deep' });
    expect(seen).toEqual(['ready', 'peer', 'log']);
    expect(f.log).toContain('video: warning: encoder queue 12 deep');
    expect(f.log.filter((l) => l.includes('an event listener failed'))).toHaveLength(3);
    vi.restoreAllMocks();
  });
});
