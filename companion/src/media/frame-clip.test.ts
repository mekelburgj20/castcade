import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIP_INDEX,
  FRAME_SAVE_MAX,
  clipFolderName,
  createFrameSaver,
  fpsOf,
  listClips,
  loadClip,
  orderFrames,
  parseClipIndex,
  playbackFps,
  playbackIndex,
  receivedFrameFrom,
  receiverFiles,
  savedLine,
  senderFiles,
  type ReceivedFrame,
} from './frame-clip.js';
import type { LayerCameraEyeGeometry, LayerCameraFrame } from './match-media-types.js';

const GEO: LayerCameraEyeGeometry = { fov: [-0.9, 0.8, 0.9, -0.95], rect: [100, 0, 1632, 3264], render: [1832, 3264] };

const camFrame = (n: number, t: number, o: Partial<LayerCameraFrame> = {}): LayerCameraFrame => ({
  n,
  t,
  encoding: 'jpeg',
  width: 720,
  height: 1440,
  eyes: [
    { ...GEO, data: Buffer.from([0xff, 0xd8, n, 1]) },
    { ...GEO, data: Buffer.from([0xff, 0xd8, n, 2]) },
  ],
  us: { issue: 100, map: 200, copy: 300, enc: 9000 },
  ...o,
});

const inFrame = (at: number, o: Partial<ReceivedFrame> = {}): ReceivedFrame => ({
  jpeg: new Uint8Array([0xff, 0xd8, 7]),
  width: 1440,
  height: 1440,
  stereo: 'sbs',
  eyes: null,
  at,
  source: 'peer krobs',
  skipped: 0,
  ...o,
});

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'castcade-frames-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('saved frames: names (D7.6.3)', () => {
  it('folder per save in local time; four-digit frame numbers; the sender and receiver file names', () => {
    expect(clipFolderName(new Date(2026, 10, 3, 9, 5, 7))).toBe('2026-11-03-090507');
    expect(senderFiles(7)).toEqual({ left: '0007-L.jpg', right: '0007-R.jpg', header: '0007.json' });
    expect(receiverFiles(12)).toEqual({ image: 'in-0012.jpg', header: 'in-0012.json' });
  });

  it('fps from the frames’ times: layer microseconds or page milliseconds; null under two frames', () => {
    expect(fpsOf([0, 33_333, 66_666, 100_000], 1e6)).toBe(30);
    expect(fpsOf([1000, 1050, 1100], 1000)).toBe(20);
    expect(fpsOf([5], 1000)).toBeNull();
    expect(fpsOf([5, 5], 1000)).toBeNull();
  });

  it('a page message is checked: a JPEG and whole sizes, else nothing', () => {
    expect(receivedFrameFrom({ jpeg: new Uint8Array([1]), width: 10, height: 20, stereo: 'sbs', eyes: [GEO, GEO], at: 5, source: 'bench (direct)', skipped: 2 })).toMatchObject({ width: 10, stereo: 'sbs', eyes: [GEO, GEO], skipped: 2 });
    expect(receivedFrameFrom({ jpeg: new Uint8Array(0), width: 10, height: 20 })).toBeNull();
    expect(receivedFrameFrom({ jpeg: [1], width: 10, height: 20 })).toBeNull();
    expect(receivedFrameFrom({ jpeg: new Uint8Array([1]), width: 10.5, height: 20 })).toBeNull();
    expect(receivedFrameFrom({ jpeg: new Uint8Array([1]), width: 10, height: 20, stereo: 'what' })?.stereo).toBe('mono');
  });
});

describe('the frame saver (D7.6.3)', () => {
  it('writes both eyes and the header per sender frame, the JPEG and its JSON per received frame, and a clip.json index', async () => {
    const root = tmp();
    const dir = join(root, '2026-11-03-101500');
    let now = 1_000_000;
    const saver = createFrameSaver({ dir, folder: '2026-11-03-101500', settings: { match: { theaterScale: 1 } }, now: () => now });
    for (let k = 0; k < 3; k++) {
      expect(saver.senderFrame(camFrame(10 + k, k * 33_333))).toBe(true);
      expect(saver.receiverFrame(inFrame(now, { skipped: k }))).toBe(true);
      now += 33;
    }
    const index = await saver.finish(['a note']);
    expect(index).not.toBeNull();
    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      '0000-L.jpg', '0000-R.jpg', '0000.json', '0001-L.jpg', '0001-R.jpg', '0001.json', '0002-L.jpg', '0002-R.jpg', '0002.json',
      CLIP_INDEX, 'in-0000.jpg', 'in-0000.json', 'in-0001.jpg', 'in-0001.json', 'in-0002.jpg', 'in-0002.json',
    ]);
    expect([...readFileSync(join(dir, '0001-R.jpg'))]).toEqual([0xff, 0xd8, 11, 2]);
    expect(JSON.parse(readFileSync(join(dir, '0001.json'), 'utf8'))).toEqual({ n: 11, t: 33_333, w: 720, h: 1440, us: { issue: 100, map: 200, copy: 300, enc: 9000 }, eyes: [GEO, GEO] });
    expect(JSON.parse(readFileSync(join(dir, 'in-0002.json'), 'utf8'))).toEqual({ width: 1440, height: 1440, stereo: 'sbs', eyes: null, at: 1_000_066, source: 'peer krobs' });
    const clip = parseClipIndex(readFileSync(join(dir, CLIP_INDEX), 'utf8'))!;
    expect(clip).toMatchObject({ folder: '2026-11-03-101500', durationMs: 2000, cap: FRAME_SAVE_MAX, settings: { match: { theaterScale: 1 } }, notes: ['a note'] });
    expect(clip.sender).toMatchObject({ count: 3, fps: 30, eye: { width: 720, height: 1440 }, eyes: [GEO, GEO] });
    expect(clip.sender!.frames[2]).toEqual({ i: 2, n: 12, t: 66_666, left: '0002-L.jpg', right: '0002-R.jpg', header: '0002.json' });
    expect(clip.receiver).toMatchObject({ count: 3, size: { width: 1440, height: 1440 }, stereo: 'sbs', source: 'peer krobs', skipped: 3 });
    expect(clip.receiver!.frames.map((f) => f.at)).toEqual([0, 33, 66]);
    expect(savedLine(dir, clip)).toBe(`media: frames: saved 3 sender frame(s) (720x1440 per eye, 30 fps) and 3 received frame(s) (1440x1440 sbs, 30.3 fps, 3 skipped while encoding) to ${dir}`);
  });

  it('keeps at most the cap per side and only frames within the 2 s; says how many it dropped', async () => {
    const root = tmp();
    const dir = join(root, 'c');
    let now = 0;
    const saver = createFrameSaver({ dir, folder: 'c', settings: {}, now: () => now, max: 4 });
    for (let k = 0; k < 6; k++) saver.senderFrame(camFrame(k, k * 1000));
    for (let k = 0; k < 5; k++) saver.receiverFrame(inFrame(k));
    expect(saver.counts()).toEqual({ sender: 4, receiver: 4, capped: { sender: 2, receiver: 1 } });
    now = 2001;
    expect(saver.senderFrame(camFrame(9, 9))).toBe(false); // past the window: not even counted
    const index = await saver.finish();
    expect(index!.notes).toEqual(['sender: 2 frame(s) past the cap of 4 not kept', 'receiver: 1 frame(s) past the cap of 4 not kept']);
    expect(readdirSync(dir).filter((f) => f.endsWith('-L.jpg'))).toHaveLength(4);
    expect(saver.senderFrame(camFrame(10, 10))).toBe(false); // finished
  });

  it('no frame at all: no folder, null, and a line that says so', async () => {
    const root = tmp();
    const dir = join(root, 'none');
    const saver = createFrameSaver({ dir, folder: 'none', settings: {} });
    expect(await saver.finish()).toBeNull();
    expect(readdirSync(root)).toEqual([]);
    expect(savedLine(dir, null)).toBe('media: frames: nothing saved (no layer camera frame and no theater frame in 2 s)');
  });

  it('copies the eyes at once: the pipe buffer they view may be reused', async () => {
    const root = tmp();
    const dir = join(root, 'copy');
    const saver = createFrameSaver({ dir, folder: 'copy', settings: {} });
    const f = camFrame(1, 0);
    saver.senderFrame(f);
    f.eyes[0]!.data.fill(0);
    await saver.finish();
    expect([...readFileSync(join(dir, '0000-L.jpg'))]).toEqual([0xff, 0xd8, 1, 1]);
  });
});

describe('saved clips read back (D7.6 bench)', () => {
  it('frame ordering by name: sender frames need both eyes, the header optional; receiver frames; the rest ignored', () => {
    const o = orderFrames(['0010-L.jpg', '0002-L.jpg', '0002-R.jpg', '0002.json', '0010-R.jpg', '0003-L.jpg', 'in-0001.jpg', 'in-0000.jpg', 'in-0000.json', 'clip.json', 'notes.txt']);
    expect(o.sender).toEqual([
      { i: 2, left: '0002-L.jpg', right: '0002-R.jpg', header: '0002.json' },
      { i: 10, left: '0010-L.jpg', right: '0010-R.jpg', header: null },
    ]);
    expect(o.receiver).toEqual([
      { i: 0, image: 'in-0000.jpg', header: 'in-0000.json' },
      { i: 1, image: 'in-0001.jpg', header: null },
    ]);
  });

  it('clip.json is checked: format, version, safe file names', () => {
    const ok = { format: 'castcade-frames', version: 1, folder: 'x', sender: { frames: [{ i: 0, n: 0, t: 0, left: '0000-L.jpg', right: '0000-R.jpg', header: '0000.json' }] }, receiver: null };
    expect(parseClipIndex(JSON.stringify(ok))).not.toBeNull();
    expect(parseClipIndex('not json')).toBeNull();
    expect(parseClipIndex(JSON.stringify({ ...ok, version: 2 }))).toBeNull();
    expect(parseClipIndex(JSON.stringify({ ...ok, sender: { frames: [{ ...ok.sender.frames[0], left: '..\\..\\secret.jpg' }] } }))).toBeNull();
  });

  it('lists the saved clips newest first with their counts; folders without a clip.json are skipped', async () => {
    const root = tmp();
    for (const name of ['2026-11-03-090000', '2026-11-03-100000']) {
      const s = createFrameSaver({ dir: join(root, name), folder: name, settings: {} });
      s.senderFrame(camFrame(0, 0));
      s.senderFrame(camFrame(1, 33_333));
      if (name.endsWith('100000')) s.receiverFrame(inFrame(Date.now()));
      await s.finish();
    }
    mkdirSync(join(root, '2026-11-03-110000'));
    mkdirSync(join(root, 'other'));
    const list = listClips(root);
    expect(list.map((c) => c.name)).toEqual(['2026-11-03-100000', '2026-11-03-090000']);
    expect(list[0]).toMatchObject({ sender: { count: 2, fps: 30, eye: { width: 720, height: 1440 } }, receiver: { count: 1, size: { width: 1440, height: 1440 }, stereo: 'sbs' } });
    expect(list[1]!.receiver).toBeNull();
    expect(listClips(join(root, 'missing'))).toEqual([]);
  });

  it('loads a side for playback: files present and listed, in order, with sizes, stereo and eyes; fps from the index', async () => {
    const root = tmp();
    const dir = join(root, '2026-11-03-120000');
    let now = 0;
    const s = createFrameSaver({ dir, folder: 'x', settings: {}, now: () => now });
    for (let k = 0; k < 3; k++) {
      s.senderFrame(camFrame(k, k * 50_000));
      s.receiverFrame(inFrame(now, { stereo: 'mono', width: 1280, height: 720, eyes: [GEO, GEO] }));
      now += 50;
    }
    await s.finish();
    rmSync(join(dir, '0001-R.jpg'));
    const send = loadClip(dir, 'sender')!;
    expect(send.fps).toBe(20);
    expect(send.frames.map((f) => [f.i, f.left, f.right, f.width, f.height, f.stereo])).toEqual([
      [0, '0000-L.jpg', '0000-R.jpg', 720, 1440, 'sbs'],
      [2, '0002-L.jpg', '0002-R.jpg', 720, 1440, 'sbs'],
    ]);
    expect(send.frames[0]!.eyes).toEqual([GEO, GEO]);
    const recv = loadClip(dir, 'receiver')!;
    expect(recv.frames.map((f) => [f.left, f.right, f.width, f.height, f.stereo])).toEqual([
      ['in-0000.jpg', null, 1280, 720, 'mono'],
      ['in-0001.jpg', null, 1280, 720, 'mono'],
      ['in-0002.jpg', null, 1280, 720, 'mono'],
    ]);
    expect(recv.frames[1]!.eyes).toEqual([GEO, GEO]);
    writeFileSync(join(dir, CLIP_INDEX), '{}');
    expect(loadClip(dir, 'sender')).toBeNull();
  });

  it('playback loops at the recorded fps by the wall clock', () => {
    expect(playbackFps(null)).toBe(30);
    expect(playbackFps(120)).toBe(60);
    expect(playbackFps(24.5)).toBe(24.5);
    expect(playbackIndex(60, 1000, 1000, 30)).toBe(0);
    expect(playbackIndex(60, 1000, 1999, 30)).toBe(29);
    expect(playbackIndex(60, 1000, 3000, 30)).toBe(0);
    expect(playbackIndex(60, 1000, 3100, 30)).toBe(3);
    expect(playbackIndex(0, 0, 100, 30)).toBe(0);
  });
});
