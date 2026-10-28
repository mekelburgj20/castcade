import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from './ffmpeg-args.js';
import { MANIFEST, verifyManifest } from './recording.js';
import { SLATE_TEXT, StreamEngine, type EngineDeps, type FfmpegProcess, type StreamPlan } from './stream-engine.js';
import type { DxgiOutput, VpxWindow, WindowProbe } from './window-geometry.js';

const OUTPUTS: DxgiOutput[] = [
  { index: 0, device: '\\\\.\\DISPLAY1', desktop: { left: 0, top: 0, width: 2560, height: 1440 }, monitor: '1', rotation: 1 },
  { index: 1, device: '\\\\.\\DISPLAY2', desktop: { left: 2560, top: 0, width: 2560, height: 1440 }, monitor: '2', rotation: 1 },
];
/** The owner's rig in cabinet mode (2026-10-27): the player fills display 2. */
const PLAYER: VpxWindow = { pid: 7, title: 'Visual Pinball Player', client: { left: 2560, top: 0, width: 2560, height: 1440 }, monitor: '2' };
const EDITOR: VpxWindow = { pid: 7, title: 'Visual Pinball - [Monster Bash]', client: { left: 700, top: 100, width: 1600, height: 1100 }, monitor: '1' };

class FakeProc implements FfmpegProcess {
  written = 0;
  killed = false;
  private lineCb: (l: string) => void = () => {};
  private exitCb: (c: number | null) => void = () => {};
  constructor(
    readonly args: string[],
    private readonly mp4: string | null,
  ) {
    if (mp4) writeFileSync(mp4, 'mp4 bytes'); // ffmpeg creates the file at once
  }
  write(c: Uint8Array): void {
    this.written += c.length;
  }
  kill(): void {
    this.killed = true;
    queueMicrotask(() => this.exitCb(1));
  }
  onLine(cb: (l: string) => void): void {
    this.lineCb = cb;
  }
  onExit(cb: (c: number | null) => void): void {
    this.exitCb = cb;
  }
  line(l: string): void {
    this.lineCb(l);
  }
  die(code = -542398533): void {
    this.exitCb(code);
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'castcade-eng-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function harness(plan: Partial<StreamPlan> = {}) {
  let t = Date.parse('2026-10-28T08:00:00Z');
  let windows: VpxWindow[] = [EDITOR];
  const procs: FakeProc[] = [];
  const logs: string[] = [];
  const deps: EngineDeps = {
    probe: async (): Promise<WindowProbe> => ({ outputs: OUTPUTS, windows }),
    spawn: (args) => {
      const i = args.indexOf('-f');
      const tee = args.find((a) => a.startsWith('[f=mp4'));
      const mp4 = tee ? tee.slice(tee.indexOf(']') + 1, tee.indexOf('|')) : args[i + 1] === 'mp4' ? args.at(-1)! : null;
      const p = new FakeProc(args, mp4);
      procs.push(p);
      return p;
    },
    encoder: async () => 'h264_nvenc',
    now: () => t,
    setTimeout: () => null, // the test drives tick() by hand
    clearTimeout: () => {},
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  };
  const full: StreamPlan = {
    preset: PRESETS['720p30']!,
    orientation: 'portrait',
    shift: 0,
    rotate: 90,
    record: true,
    rtmpUrl: 'rtmp://live.twitch.tv/app/live_SECRET',
    audio: { sampleRate: 48000, channels: 2, kbps: 160, lateMs: 390 },
    recordingsDir: root,
    retention: { keepSessions: 3, maxRecordings: null },
    fontFile: 'C:/Windows/Fonts/segoeui.ttf',
    appVersion: '0.2.19',
    ...plan,
  };
  const engine = new StreamEngine(deps);
  const tick = async (ms = 2000) => {
    t += ms;
    await engine.tick();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    engine,
    plan: full,
    procs,
    logs,
    tick,
    setWindows: (w: VpxWindow[]) => (windows = w),
  };
}

describe('stream engine (D1.2 + D1.3)', () => {
  it('needs a recording or a stream key', async () => {
    const h = harness({ record: false, rtmpUrl: null });
    await expect(h.engine.start(h.plan)).rejects.toThrow(/nothing to do/);
  });

  it('live with no table open: the slate keeps the broadcast up, and it is never recorded', async () => {
    const h = harness();
    await h.engine.start(h.plan);
    await h.tick();
    expect(h.engine.status()).toMatchObject({ state: 'slate', live: true, recording: false });
    const slate = h.procs[0]!;
    expect(slate.args.join(' ')).toContain(SLATE_TEXT.replace(':', '\\:'));
    expect(slate.args.join(' ')).toMatch(/color=c=0x0d1117:s=720x1280/);
    expect(slate.args.some((a) => a.includes('.mp4'))).toBe(false);
    expect(h.logs.join('\n')).not.toContain('SECRET');
  });

  it('a player window steady for two probes is captured: rotated, sliced, recorded and pushed in one encode', async () => {
    const h = harness();
    await h.engine.start(h.plan);
    await h.tick(); // slate
    h.setWindows([EDITOR, PLAYER]);
    await h.tick(); // seen once: not yet
    expect(h.engine.status().state).toBe('slate');
    await h.tick(); // steady: switch
    expect(h.procs[0]!.killed).toBe(true);
    const cap = h.procs[1]!;
    const args = cap.args.join(' ');
    expect(args).toContain('ddagrab=output_idx=1');
    expect(args).toContain('transpose=clock');
    expect(args).toMatch(/\[f=mp4[^\]]*\].*seg-001\.mp4\|\[f=flv[^\]]*\]rtmp:/);
    expect(h.engine.status()).toMatchObject({ state: 'capturing', live: true, recording: true, segment: 'seg-001.mp4', picture: { width: 720, height: 1280 } });
    h.engine.pushPcm(new Uint8Array(4800));
    expect(cap.written).toBe(4800);
    cap.line('frame=  232 fps= 29 q=10.0 size=N/A time=00:00:07.65 bitrate=N/A speed=0.95x');
    expect(h.engine.status().health).toEqual({ frames: 232, fps: 29, speed: 0.95 });
  });

  it('quitting to the editor closes the segment (hashed) and goes back to the slate; the next table opens seg-002', async () => {
    const h = harness();
    h.setWindows([PLAYER]);
    await h.engine.start(h.plan);
    await h.tick();
    await h.tick();
    expect(h.engine.status().segment).toBe('seg-001.mp4');
    h.engine.noteTable('Monster Bash');
    h.engine.noteGame({ table: 'Monster Bash', inGame: true, scores: [], player: 1, ball: 1 });
    h.engine.noteGame({ table: 'Monster Bash', inGame: false, scores: [1_500_000], player: 1, ball: 3 });
    h.engine.noteCapture({ table: 'Monster Bash', rom: 'mb_106b', players: 1, score: 1_500_000, launchedAt: '', exitedAt: '', outcome: 'ingested', mode: 'live' });
    h.setWindows([EDITOR]);
    await h.tick();
    expect(h.engine.status()).toMatchObject({ state: 'slate', recording: false, segment: null });
    h.setWindows([PLAYER]);
    await h.tick();
    await h.tick();
    expect(h.engine.status().segment).toBe('seg-002.mp4');
    await h.engine.stop();
    const text = readFileSync(join(root, readdirSync(root)[0]!, MANIFEST), 'utf8');
    expect(verifyManifest(text).ok).toBe(true);
    const kinds = text.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; segment?: string; reason?: string; sha256?: string });
    expect(kinds.map((k) => k.kind)).toEqual(['session_start', 'segment_start', 'game_start', 'game_end', 'score_posted', 'segment_end', 'segment_start', 'segment_end', 'session_end']);
    expect(kinds[4]).toMatchObject({ segment: 'seg-001.mp4' });
    expect(kinds[5]).toMatchObject({ reason: 'player closed', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(kinds[7]).toMatchObject({ reason: 'stopped' });
  });

  it('a capture that dies on its own (lost Desktop Duplication) restarts after a backoff that grows, then resets', async () => {
    const h = harness({ rtmpUrl: null });
    h.setWindows([PLAYER]);
    await h.engine.start(h.plan);
    await h.tick();
    await h.tick();
    h.procs[0]!.line('[fc#0 @ 0001] Task finished with error code: -542398533 (Generic error in an external library)');
    h.procs[0]!.die();
    await vi.waitFor(() => expect(h.engine.status()).toMatchObject({ state: 'waiting', restarts: 1, lastError: expect.stringMatching(/Generic error/) }));
    await h.tick(300); // inside the 1 s backoff, and the window must be steady again
    await h.tick(300);
    expect(h.procs).toHaveLength(1);
    await h.tick(2000);
    expect(h.procs).toHaveLength(2);
    expect(h.engine.status().segment).toBe('seg-002.mp4');
    h.procs[1]!.die();
    await vi.waitFor(() => expect(h.engine.status().state).toBe('waiting'));
    await h.tick(1000);
    await h.tick(500);
    expect(h.procs).toHaveLength(2); // second failure: 2 s backoff
    await h.tick(1000);
    expect(h.procs).toHaveLength(3);
  });

  it('a dropped push (tee keeps the MP4 going) restarts the run so the stream reconnects', async () => {
    const h = harness();
    h.setWindows([PLAYER]);
    await h.engine.start(h.plan);
    await h.tick();
    await h.tick();
    h.procs[0]!.line('[tee @ 0002] Slave muxer #1 failed: Broken pipe, continuing with 1/2 slaves.');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.procs[0]!.killed).toBe(true);
    expect(h.engine.status()).toMatchObject({ restarts: 1, lastError: 'the stream connection dropped; reconnecting' });
    await h.tick(1000);
    await h.tick(1000);
    expect(h.procs).toHaveLength(2);
    expect(h.engine.status().segment).toBe('seg-002.mp4');
  });

  it('record only: no slate between tables; landscape films the whole window; a moved window restarts', async () => {
    const h = harness({ rtmpUrl: null, orientation: 'landscape', rotate: 0 });
    await h.engine.start(h.plan);
    await h.tick();
    expect(h.procs).toHaveLength(0);
    expect(h.engine.status().state).toBe('waiting');
    h.setWindows([PLAYER]);
    await h.tick();
    await h.tick();
    expect(h.procs[0]!.args.join(' ')).toContain('video_size=2560x1440');
    expect(h.engine.status().picture).toEqual({ width: 1280, height: 720 });
    h.setWindows([{ ...PLAYER, client: { ...PLAYER.client, width: 1920 } }]);
    await h.tick();
    expect(h.procs[0]!.killed).toBe(true);
    await h.tick();
    expect(h.procs).toHaveLength(2);
    expect(h.procs[1]!.args.join(' ')).toContain('video_size=1920x1440');
  });

  it('no font: a plain slate (a missing font file crashes ffmpeg drawtext)', async () => {
    const h = harness({ fontFile: null });
    await h.engine.start(h.plan);
    await h.tick();
    expect(h.procs[0]!.args.join(' ')).not.toContain('drawtext');
  });
});
