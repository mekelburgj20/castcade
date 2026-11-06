import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AUDIO_FRAME_BYTES, AUDIO_HELPER_EXE, createOutputParser, createTableAudioHelper, resolveAudioHelper, RESTART_MIN_MS, type HelperOutput } from './audio-helper.js';
import type { TableAudioStatus } from './match-media-types.js';

function frameBytes(fill: number, bytes = AUDIO_FRAME_BYTES): Buffer {
  const b = Buffer.alloc(8 + bytes, fill);
  b.write('CAU1', 0, 'latin1');
  b.writeUInt32LE(bytes, 4);
  return b;
}

function parse(chunks: Buffer[]): HelperOutput[] {
  const out: HelperOutput[] = [];
  const p = createOutputParser((o) => out.push(o));
  for (const c of chunks) p.push(c);
  return out;
}

const brief = (o: HelperOutput): string => (o.kind === 'frame' ? `frame ${o.pcm.length} ${o.pcm[0]}` : o.kind === 'line' ? `line ${o.text}` : `resync ${o.skipped}`);

describe('createOutputParser (D2.8)', () => {
  it('reads lines and frames back to back', () => {
    const all = Buffer.concat([Buffer.from('ready 0.1.0\n'), frameBytes(7), Buffer.from('tap-on 42\r\n'), frameBytes(9, 16)]);
    expect(parse([all]).map(brief)).toEqual(['line ready 0.1.0', `frame ${AUDIO_FRAME_BYTES} 7`, 'line tap-on 42', 'frame 16 9']);
  });

  it('reads the same stream split at every byte', () => {
    const all = Buffer.concat([Buffer.from('ready 0.1.0\n'), frameBytes(7, 24), Buffer.from('muted 5 3\n'), frameBytes(1, 8)]);
    const chunks: Buffer[] = [];
    for (let i = 0; i < all.length; i++) chunks.push(all.subarray(i, i + 1));
    expect(parse(chunks).map(brief)).toEqual(['line ready 0.1.0', 'frame 24 7', 'line muted 5 3', 'frame 8 1']);
  });

  it('keeps a frame payload that outlives its chunk', () => {
    const f = frameBytes(3, 8);
    const out = parse([f]);
    f.fill(0);
    expect(out[0]).toMatchObject({ kind: 'frame' });
    expect([...(out[0] as { pcm: Uint8Array }).pcm]).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
  });

  it('resyncs on a bad magic: skips to the next frame and says so once', () => {
    const junk = Buffer.from([0xff, 0x00, 0x13, 0x37, 0xfe]);
    expect(parse([Buffer.concat([junk, frameBytes(5, 8)])]).map(brief)).toEqual(['resync 5', 'frame 8 5']);
  });

  it('treats an impossible length as garbage and finds the frame after it', () => {
    const bad = Buffer.alloc(8);
    bad.write('CAU1', 0, 'latin1');
    bad.writeUInt32LE(0x7fffffff, 4);
    const odd = Buffer.alloc(8);
    odd.write('CAU1', 0, 'latin1');
    odd.writeUInt32LE(6, 4); // not whole float32 samples
    expect(parse([Buffer.concat([bad, odd, frameBytes(2, 8)])]).map(brief)).toEqual(['resync 8', 'resync 8', 'frame 8 2']);
  });

  it('waits for a partial frame, a partial magic and a partial line', () => {
    const out: HelperOutput[] = [];
    const p = createOutputParser((o) => out.push(o));
    const f = frameBytes(4, 8);
    p.push(f.subarray(0, 2));
    p.push(f.subarray(2, 10));
    expect(out).toEqual([]);
    p.push(f.subarray(10));
    p.push(Buffer.from('tap-o'));
    expect(out.map(brief)).toEqual(['frame 8 4']);
    p.push(Buffer.from('ff\n'));
    expect(out.map(brief)).toEqual(['frame 8 4', 'line tap-off']);
  });

  it('drops an endless run of text with no newline, keeping a magic prefix at its end', () => {
    const out: HelperOutput[] = [];
    const p = createOutputParser((o) => out.push(o));
    p.push(Buffer.concat([Buffer.alloc(5000, 0x41), Buffer.from('CA')]));
    expect(out.map(brief)).toEqual(['resync 5000']);
    p.push(frameBytes(6, 8).subarray(2));
    expect(out.map(brief)).toEqual(['resync 5000', 'frame 8 6']);
  });
});

describe('resolveAudioHelper', () => {
  it('finds the packaged exe, else a local build, else a fetched copy', () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    const res = 'C:/app/resources';
    const dir = 'C:/repo/companion';
    const packaged = join(res, 'audio-helper', AUDIO_HELPER_EXE);
    const local = resolve(dir, '..', 'audio-helper', 'build', 'Release', AUDIO_HELPER_EXE);
    const fetched = resolve(dir, 'resources', 'audio-helper', AUDIO_HELPER_EXE);
    expect(resolveAudioHelper({ packaged: true, resourcesPath: res, companionDir: dir }, has([packaged]))).toBe(packaged);
    expect(resolveAudioHelper({ packaged: false, resourcesPath: res, companionDir: dir }, has([local, fetched]))).toBe(local);
    expect(resolveAudioHelper({ packaged: false, resourcesPath: res, companionDir: dir }, has([fetched]))).toBe(fetched);
    expect(resolveAudioHelper({ packaged: true, resourcesPath: res, companionDir: dir }, has([]))).toBeNull();
  });
});

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

class FakeHelper extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  constructor(readonly args: string[]) {
    super();
  }
  say(line: string): void {
    this.stdout.emit('data', Buffer.from(line + '\n'));
  }
  frame(fill: number): void {
    this.stdout.emit('data', frameBytes(fill, 8));
  }
  exit(code: number | null): void {
    this.emit('close', code, code === null ? 'SIGTERM' : null);
  }
  kill(): boolean {
    this.exit(null);
    return true;
  }
}

function setup(exePath: string | null = 'C:/x/castcade-audio.exe') {
  const helpers: FakeHelper[] = [];
  let t = 1000;
  const timers: Array<{ at: number; fn: () => void; done: boolean }> = [];
  const log = vi.fn<(line: string) => void>();
  const ta = createTableAudioHelper({
    exePath,
    stateFile: 'C:/u/castcade-audio-state.txt',
    log,
    spawn: ((_cmd: string, args: string[]) => {
      const h = new FakeHelper(args);
      helpers.push(h);
      return h;
    }) as never,
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = { at: t + ms, fn, done: false };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => {
      (h as { done: boolean }).done = true;
    },
  });
  const statuses: TableAudioStatus[] = [];
  ta.onStatus((s) => statuses.push(s));
  const advance = (ms: number) => {
    t += ms;
    for (const h of timers) {
      if (!h.done && h.at <= t) {
        h.done = true;
        h.fn();
      }
    }
  };
  return { ta, helpers, log, statuses, advance, last: () => helpers[helpers.length - 1]! };
}

describe('createTableAudioHelper (D2.8)', () => {
  it('missing exe: unavailable, never spawns, apply is harmless', () => {
    const s = setup(null);
    s.ta.apply({ mutePid: 5, tapPid: null });
    expect(s.helpers).toHaveLength(0);
    expect(s.ta.status()).toEqual({ helper: 'unavailable', reason: 'helper_missing', muted: false, tapping: false });
  });

  it('starts on the first want, waits for ready, then sends only the differences', () => {
    const s = setup();
    s.ta.apply({ mutePid: null, tapPid: null });
    expect(s.helpers).toHaveLength(0);
    s.ta.apply({ mutePid: 42, tapPid: null });
    const h = s.last();
    expect(h.args).toEqual(['--state', 'C:/u/castcade-audio-state.txt']);
    expect(h.stdin.lines).toEqual([]);
    h.say('ready 0.1.0');
    expect(h.stdin.lines).toEqual(['mute 42']);
    h.say('muted 42 3');
    expect(s.ta.status()).toMatchObject({ helper: 'ready', muted: true, tapping: false });
    expect(s.log).toHaveBeenCalledWith('audio: muted VPX pid 42 (3 sessions)');
    s.ta.apply({ mutePid: 42, tapPid: null });
    expect(h.stdin.lines).toEqual(['mute 42']);
    // My turn: unmute, tap.
    s.ta.apply({ mutePid: null, tapPid: 42 });
    expect(h.stdin.lines).toEqual(['mute 42', 'unmute 42', 'tap 42']);
    h.say('unmuted 42 3');
    h.say('tap-on 42');
    expect(s.ta.status()).toMatchObject({ muted: false, tapping: true });
    // Another player is up again.
    s.ta.apply({ mutePid: 42, tapPid: null });
    expect(h.stdin.lines.slice(-2)).toEqual(['mute 42', 'untap']);
    // The capture re-picked another VPX while muted: the old one is released first.
    s.ta.apply({ mutePid: 7, tapPid: null });
    expect(h.stdin.lines.slice(-2)).toEqual(['unmute 42', 'mute 7']);
    // The match ended.
    s.ta.apply({ mutePid: null, tapPid: null });
    expect(h.stdin.lines.slice(-1)).toEqual(['unmute 7']);
  });

  it('passes frames on only while tapping', () => {
    const s = setup();
    const got: number[] = [];
    s.ta.onFrame((pcm) => got.push(pcm[0]!));
    s.ta.apply({ mutePid: null, tapPid: 9 });
    const h = s.last();
    h.say('ready 0.1.0');
    h.frame(1);
    h.say('tap-on 9');
    h.frame(2);
    h.say('tap-off');
    h.frame(3);
    expect(got).toEqual([2]);
  });

  it('tap-unavailable: muting carries on, the reason shows, no tap is asked for', () => {
    const s = setup();
    s.ta.apply({ mutePid: null, tapPid: 9 });
    const h = s.last();
    h.say('ready 0.1.0');
    h.say('tap-unavailable windows_too_old:18363');
    expect(s.ta.status()).toMatchObject({ helper: 'ready', reason: 'tap_unavailable:windows_too_old:18363', tapping: false });
    s.ta.apply({ mutePid: 9, tapPid: null });
    s.ta.apply({ mutePid: null, tapPid: 9 });
    expect(h.stdin.lines.filter((l) => l.startsWith('tap '))).toEqual(['tap 9']);
    expect(h.stdin.lines).toContain('mute 9');
  });

  it('a tap error is retried after a while if the tap is still wanted', () => {
    const s = setup();
    s.ta.apply({ mutePid: null, tapPid: 9 });
    const h = s.last();
    h.say('ready 0.1.0');
    h.say('tap-error activate_failed:0x80070005');
    expect(h.stdin.lines).toEqual(['tap 9']);
    s.advance(RESTART_MIN_MS);
    expect(h.stdin.lines).toEqual(['tap 9', 'tap 9']);
  });

  it('a crash restarts the helper at most every 5 s and tells the new one everything again', () => {
    const s = setup();
    s.ta.apply({ mutePid: 42, tapPid: null });
    const first = s.last();
    first.say('ready 0.1.0');
    first.say('muted 42 1');
    s.advance(1000);
    first.exit(3221225477);
    expect(s.ta.status()).toMatchObject({ helper: 'ready', muted: false });
    expect(s.helpers).toHaveLength(1);
    s.advance(3999);
    expect(s.helpers).toHaveLength(1);
    s.advance(1);
    expect(s.helpers).toHaveLength(2);
    s.last().say('ready 0.1.0');
    expect(s.last().stdin.lines).toEqual(['mute 42']);
  });

  it('a start-up failure (no ready) is final', () => {
    const s = setup();
    s.ta.apply({ mutePid: 42, tapPid: null });
    s.last().exit(2);
    expect(s.ta.status()).toEqual({ helper: 'unavailable', reason: 'helper_failed:2', muted: false, tapping: false });
    s.advance(60_000);
    expect(s.helpers).toHaveLength(1);
  });

  it('ENOENT from spawn reads as helper_missing', () => {
    const s = setup();
    s.ta.apply({ mutePid: 42, tapPid: null });
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    s.last().emit('error', err);
    expect(s.ta.status()).toMatchObject({ helper: 'unavailable', reason: 'helper_missing' });
  });

  it('stop says quit, ends stdin and waits for the exit', async () => {
    const s = setup();
    s.ta.apply({ mutePid: 42, tapPid: null });
    const h = s.last();
    h.say('ready 0.1.0');
    const done = s.ta.stop();
    expect(h.stdin.lines[h.stdin.lines.length - 1]).toBe('quit');
    expect(h.stdin.destroyed).toBe(true);
    h.exit(0);
    await done;
    expect(s.helpers).toHaveLength(1);
  });

  it('D2.10: level and unlevel go out as differences, follow the pid, and are replayed to a restarted helper', () => {
    const s = setup();
    s.ta.level(42, 60);
    const h = s.last();
    expect(h.stdin.lines).toEqual([]); // starts the helper, waits for ready
    h.say('ready 0.2.0');
    expect(s.log).toHaveBeenCalledWith('audio: helper 0.2.0 ready');
    expect(h.stdin.lines).toEqual(['level 42 60']);
    h.say('leveled 42 2');
    expect(s.log).toHaveBeenCalledWith('audio: my table at 60 % (VPX pid 42, 2 sessions)');
    s.ta.level(42, 60);
    expect(h.stdin.lines).toEqual(['level 42 60']); // the same again: nothing
    s.ta.level(42, 80);
    expect(h.stdin.lines.slice(-1)).toEqual(['level 42 80']); // a new percent on the same pid: no unlevel first
    s.ta.level(7, 80.4);
    expect(h.stdin.lines.slice(-2)).toEqual(['unlevel 42', 'level 7 80']); // another VPX: the old tree restored first
    s.ta.level(7, 3);
    expect(h.stdin.lines.slice(-1)).toEqual(['level 7 10']); // clamped to the helper's range
    s.ta.unlevel(42);
    expect(h.stdin.lines.slice(-1)).toEqual(['level 7 10']); // not the pid levelled: a no-op
    s.ta.unlevel(7);
    expect(h.stdin.lines.slice(-1)).toEqual(['unlevel 7']);
    h.say('unleveled 7 1');
    expect(s.log).toHaveBeenCalledWith('audio: my table back to its own volume (VPX pid 7, 1 session)');
    s.ta.unlevel();
    expect(h.stdin.lines.slice(-1)).toEqual(['unlevel 7']); // nothing levelled: nothing said
    // A crash while a level is wanted: the new helper is told it again, with the mute.
    s.ta.apply({ mutePid: 9, tapPid: null });
    s.ta.level(42, 50);
    s.advance(RESTART_MIN_MS);
    h.exit(3221225477);
    s.advance(RESTART_MIN_MS);
    s.last().say('ready 0.2.0');
    expect(s.last().stdin.lines).toEqual(['mute 9', 'level 42 50']);
  });

  it('D2.10: a helper without level (0.1.0) is told once and asked no more; a later unlevel sends nothing', () => {
    const s = setup();
    s.ta.level(42, 60);
    const h = s.last();
    h.say('ready 0.1.0');
    expect(h.stdin.lines).toEqual(['level 42 60']);
    h.say('error unknown_command level');
    expect(s.log).toHaveBeenCalledWith("audio: this helper (0.1.0) cannot change my table's volume; castcade-audio 0.2.0 or newer does");
    s.ta.level(42, 70);
    s.ta.unlevel();
    s.ta.level(7, 70);
    expect(h.stdin.lines).toEqual(['level 42 60']);
    h.say('error unknown_command level');
    expect(s.log.mock.calls.filter((c) => String(c[0]).includes('cannot change'))).toHaveLength(1);
    // Other errors still reach the log as before.
    h.say('error bad_pid mute');
    expect(s.log).toHaveBeenCalledWith('audio: error bad_pid mute');
    // The mute still works.
    s.ta.apply({ mutePid: 9, tapPid: null });
    expect(h.stdin.lines.slice(-1)).toEqual(['mute 9']);
  });

  it('D2.10: no exe: level is harmless and spawns nothing', () => {
    const s = setup(null);
    s.ta.level(5, 50);
    s.ta.unlevel();
    expect(s.helpers).toHaveLength(0);
    expect(s.ta.status()).toMatchObject({ helper: 'unavailable', reason: 'helper_missing' });
  });

  it('stderr lines reach the log with the audio: prefix, once', () => {
    const s = setup();
    s.ta.apply({ mutePid: 1, tapPid: null });
    s.last().stderr.emit('data', Buffer.from('audio: ready\nsomething else\n'));
    expect(s.log).toHaveBeenCalledWith('audio: ready');
    expect(s.log).toHaveBeenCalledWith('audio: something else');
  });
});
