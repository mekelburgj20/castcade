import { describe, expect, it } from 'vitest';
import { ddagrabRegion, ffmpegArgs, ffplayPreviewArgs, filterValue, outputSize, PRESETS, redactRtmp, videoFilter } from './ffmpeg-args.js';
import { ffmpegDir, resolveFfmpeg } from './ffmpeg-path.js';
import { cropFor, pickPlayfield, portraitSlice, previewPlacement, type DxgiOutput, type VpxWindow } from './window-geometry.js';

/** The owner's rig: two 2560x1440 monitors side by side (probe output, 2026-10-25). */
const OUTPUTS: DxgiOutput[] = [
  { index: 0, device: '\\\\.\\DISPLAY1', desktop: { left: 0, top: 0, width: 2560, height: 1440 }, monitor: '380248181' },
  { index: 1, device: '\\\\.\\DISPLAY2', desktop: { left: 2560, top: 0, width: 2560, height: 1440 }, monitor: '964304411' },
];
const win = (o: Partial<VpxWindow> & { client: VpxWindow['client'] }): VpxWindow => ({ pid: 10, title: 'Visual Pinball Player', monitor: '964304411', ...o });

describe('window geometry', () => {
  it('a window on the second monitor crops relative to output 1, sizes even', () => {
    expect(cropFor(win({ client: { left: 2660, top: 31, width: 1921, height: 1441 } }), OUTPUTS)).toEqual({ outputIdx: 1, offsetX: 100, offsetY: 31, width: 1920, height: 1408 });
  });

  it('two monitors of the same size are told apart by monitor handle, not size', () => {
    expect(cropFor(win({ monitor: '380248181', client: { left: 0, top: 0, width: 2560, height: 1440 } }), OUTPUTS)?.outputIdx).toBe(0);
  });

  it('a portrait slice is 9:16, centred, shifted and clamped inside the window', () => {
    const wide = { outputIdx: 0, offsetX: 640, offsetY: 0, width: 1440, height: 1392 };
    expect(portraitSlice(wide)).toEqual({ outputIdx: 0, offsetX: 640 + 329, offsetY: 0, width: 782, height: 1392 });
    expect(portraitSlice(wide, 0.1).offsetX).toBe(640 + 329 + 144);
    expect(portraitSlice(wide, 1).offsetX).toBe(640 + 1440 - 782);
    expect(portraitSlice({ ...wide, width: 500 })).toMatchObject({ offsetX: 640, width: 500 });
  });

  it('falls back to position when the handle is unknown; null off every output', () => {
    expect(cropFor(win({ monitor: '?', client: { left: 3000, top: 100, width: 800, height: 600 } }), OUTPUTS)).toMatchObject({ outputIdx: 1, offsetX: 440 });
    expect(cropFor(win({ monitor: '?', client: { left: 9000, top: 0, width: 800, height: 600 } }), OUTPUTS)).toBeNull();
  });

  it('the playfield is the window titled like the VPX player; the editor and DMD never are', () => {
    const dmd = win({ title: 'Virtual DMD', client: { left: 0, top: 0, width: 3000, height: 900 } });
    const editor = win({ title: 'Visual Pinball - [Monster Bash (Williams 1998) VPWmod v1.0]', client: { left: 558, top: 175, width: 1599, height: 1156 } });
    const pf = win({ title: 'Visual Pinball Player', client: { left: 0, top: 0, width: 1920, height: 1080 } });
    expect(pickPlayfield([dmd, editor, pf])).toBe(pf);
    expect(pickPlayfield([dmd, editor])).toBeNull();
    expect(pickPlayfield([])).toBeNull();
  });
});

describe('ffmpeg args', () => {
  const crop = { outputIdx: 1, offsetX: 100, offsetY: 31, width: 1920, height: 1080 };

  it('escapes Windows paths for the filtergraph', () => {
    expect(filterValue('C:\\Windows\\Fonts\\segoeui.ttf')).toBe("'C\\:/Windows/Fonts/segoeui.ttf'");
  });

  it('720p30 NVENC to an MP4 with loopback audio and the overlay', () => {
    const a = ffmpegArgs({ crop, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', overlay: { textFile: 'overlay.txt', fontFile: 'C:\\Windows\\Fonts\\segoeui.ttf' }, audio: { sampleRate: 48000, channels: 2, kbps: 160 }, outputs: { mp4: 'C:\\rec\\s.mp4' }, seconds: 120 });
    expect(a.slice(a.indexOf('-f'), a.indexOf('-f') + 8)).toEqual(['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0']);
    const vf = a[a.indexOf('-filter_complex') + 1]!;
    expect(vf).toMatch(/^ddagrab=output_idx=1:framerate=30:offset_x=100:offset_y=31:video_size=1920x1080:draw_mouse=0,hwdownload,format=bgra,fps=30,scale=-2:720,drawtext=fontfile='C\\:\/Windows\/Fonts\/segoeui.ttf':textfile='overlay.txt':reload=1:/);
    expect(vf.endsWith(',format=yuv420p[v]')).toBe(true);
    expect(a).toEqual(expect.arrayContaining(['-c:v', 'h264_nvenc', '-b:v', '4500k', '-g', '60', '-c:a', 'aac', '-t', '120']));
    expect(a.slice(-6)).toEqual(['-movflags', '+frag_keyframe+empty_moov', '-f', 'mp4', '-y', 'C:\\rec\\s.mp4']);
  });

  it('MP4 and RTMP together go through tee, the recording surviving a dropped stream', () => {
    const a = ffmpegArgs({ crop, preset: PRESETS['1080p60']!, encoder: 'h264_amf', outputs: { mp4: 'C:\\rec\\s.mp4', rtmp: 'rtmp://live.twitch.tv/app/live_123_secret' } });
    expect(a.slice(-4)).toEqual(['+global_header', '-f', 'tee', '[f=mp4:movflags=+frag_keyframe+empty_moov:onfail=ignore]C:/rec/s.mp4|[f=flv:onfail=ignore]rtmp://live.twitch.tv/app/live_123_secret']);
    expect(a).toEqual(expect.arrayContaining(['-c:v', 'h264_amf', '-g', '120']));
    expect(a).not.toContain('pipe:0');
  });

  it('a vertical window scales its short side to the preset (720p = 720x1280)', () => {
    expect(videoFilter({ crop: { ...crop, width: 810, height: 1440 }, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', outputs: { mp4: 'x' } })).toContain('scale=720:-2');
  });

  it('trims the capture latency off the start of the audio', () => {
    const a = ffmpegArgs({ crop, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', audio: { sampleRate: 48000, channels: 2, kbps: 160, lateMs: 390 }, outputs: { mp4: 'x.mp4' } });
    expect(a[a.indexOf('-af') + 1]).toBe('atrim=start=0.390,asetpts=PTS-STARTPTS');
  });

  it('never upscales a small window', () => {
    expect(videoFilter({ crop: { ...crop, height: 600, width: 800 }, preset: PRESETS['1080p30']!, encoder: 'libx264', outputs: { mp4: 'x' } })).toContain('scale=-2:600');
  });

  it('a stream key never reaches a log', () => {
    expect(redactRtmp('… [f=flv]rtmp://live.twitch.tv/app/live_123_secret')).toBe('… [f=flv]rtmp://live.twitch.tv/app/***');
    expect(redactRtmp('rtmps://a.rtmps.youtube.com:443/live2/abcd-efgh')).toBe('rtmps://a.rtmps.youtube.com:443/live2/***');
  });
});

describe('stream preview (owner ask 2026-10-27: check the framing before going live)', () => {
  // The owner's rig, 2026-10-27: Monster Bash windowed on monitor 0, the 9:16 slice it streamed.
  const crop = { outputIdx: 0, offsetX: 1391, offsetY: 7, width: 806, height: 1432 };
  const two: DxgiOutput[] = [
    { index: 0, device: '\\\\.\\DISPLAY1', monitor: 'm0', desktop: { left: 0, top: 0, width: 2560, height: 1440 } },
    { index: 1, device: '\\\\.\\DISPLAY2', monitor: 'm1', desktop: { left: 2560, top: 0, width: 2560, height: 1440 } },
  ];
  const picture = outputSize({ crop, preset: PRESETS['720p30']! });

  it('the output picture is the preset on the short side, even, never upscaled', () => {
    expect(picture).toEqual({ width: 720, height: 1280 });
    expect(outputSize({ crop: { ...crop, width: 400, height: 712 }, preset: PRESETS['1080p30']! })).toEqual({ width: 400, height: 712 });
    expect(outputSize({ crop: { outputIdx: 0, offsetX: 0, offsetY: 0, width: 1920, height: 1080 }, preset: PRESETS['720p30']! })).toEqual({ width: 1280, height: 720 });
  });

  it('ffplay runs the same capture chain as the encode, with nothing encoded or sent', () => {
    const overlay = { textFile: 'overlay.txt', fontFile: 'C:\\Windows\\Fonts\\segoeui.ttf' };
    const args = ffplayPreviewArgs({ crop, preset: PRESETS['720p30']!, overlay, window: { left: 3000, top: 100, width: 690, height: 1224 } });
    const chain = args[args.indexOf('-i') + 1];
    expect(`${chain}[v]`).toBe(videoFilter({ crop, preset: PRESETS['720p30']!, overlay }));
    expect(args).toEqual(expect.arrayContaining(['-f', 'lavfi', '-an', '-left', '3000', '-top', '100', '-x', '690', '-y', '1224']));
    expect(args.join(' ')).not.toMatch(/rtmp|\.mp4|-c:v/);
  });

  it('opens on the other monitor when there is one, sized to the picture', () => {
    const p = previewPlacement(crop, two, picture);
    expect(p.overlapsCapture).toBe(false);
    expect(p.left).toBeGreaterThanOrEqual(2560);
    expect(p.height).toBeLessThanOrEqual(Math.round(1440 * 0.85));
    expect(Math.abs(p.width / p.height - 720 / 1280)).toBeLessThan(0.01);
  });

  it('with one monitor, opens beside the crop on the wider side, never on it', () => {
    const one = [two[0]!];
    const p = previewPlacement(crop, one, picture); // 1391 px free on the left, 363 on the right
    expect(p.overlapsCapture).toBe(false);
    expect(p.left + p.width).toBeLessThanOrEqual(1391);
    const full = previewPlacement({ outputIdx: 0, offsetX: 0, offsetY: 0, width: 2560, height: 1440 }, one, picture);
    expect(full.overlapsCapture).toBe(true);
  });
});

describe('ffmpeg location (D1.6)', () => {
  const dev = { packaged: false, resourcesPath: 'R', companionDir: 'C:/repo/companion' };
  const pkg = { packaged: true, resourcesPath: 'C:/Program Files/Castcade/resources', companionDir: 'x' };
  const slash = (p: string): string => p.replace(/[\\]/g, '/');

  it('the installer uses its bundled build and reports it from VERSION', () => {
    const loc = resolveFfmpeg(pkg, () => true, () => 'ffmpeg-8.1.1-essentials_build sha256:abc https://example\n');
    expect(loc).toMatchObject({ source: 'bundled', build: 'ffmpeg-8.1.1-essentials_build' });
    expect(slash(loc.ffmpeg)).toBe('C:/Program Files/Castcade/resources/ffmpeg/ffmpeg.exe');
    expect(slash(loc.ffplay)).toBe('C:/Program Files/Castcade/resources/ffmpeg/ffplay.exe');
  });

  it('a dev checkout without a fetched build falls back to PATH; a missing VERSION still counts as bundled', () => {
    expect(slash(ffmpegDir(dev))).toBe('C:/repo/companion/resources/ffmpeg');
    expect(resolveFfmpeg(dev, () => false)).toEqual({ ffmpeg: 'ffmpeg', ffplay: 'ffplay', source: 'path', build: null });
    expect(resolveFfmpeg(dev, (p) => !p.endsWith('ffplay.exe'))).toMatchObject({ source: 'path' });
    const noStamp = resolveFfmpeg(dev, () => true, () => {
      throw new Error('ENOENT');
    });
    expect(noStamp).toMatchObject({ source: 'bundled', build: null });
  });
});

describe('rotated monitors (owner rig 2026-10-27: display 2 set to portrait, DXGI rotation 4)', () => {
  const PORTRAIT: DxgiOutput[] = [OUTPUTS[0]!, { ...OUTPUTS[1]!, desktop: { left: 2560, top: 0, width: 1440, height: 2560 }, rotation: 4 }];
  const full = cropFor(win({ client: { left: 2560, top: 0, width: 1440, height: 2560 } }), PORTRAIT)!;

  it('the crop keeps desktop coordinates and carries the rotation; an unrotated output carries none', () => {
    expect(full).toEqual({ outputIdx: 1, offsetX: 0, offsetY: 0, width: 1440, height: 2560, rotation: 4, screen: { width: 1440, height: 2560 } });
    expect(cropFor(win({ monitor: '380248181', client: { left: 0, top: 0, width: 2560, height: 1440 } }), [{ ...OUTPUTS[0]!, rotation: 1 }])).not.toHaveProperty('rotation');
  });

  it('maps the crop into the panel frame and turns it upright, for each rotation', () => {
    expect(ddagrabRegion(full)).toEqual({ x: 0, y: 0, width: 2560, height: 1440, turn: 'transpose=cclock' });
    // The top of the portrait screen (the backbox) is the right of the panel's frame (captured on the rig).
    const top = { ...full, height: 1280 };
    expect(ddagrabRegion(top)).toEqual({ x: 1280, y: 0, width: 1280, height: 1440, turn: 'transpose=cclock' });
    expect(ddagrabRegion({ ...top, rotation: 2 })).toEqual({ x: 0, y: 0, width: 1280, height: 1440, turn: 'transpose=clock' });
    const land = { outputIdx: 0, offsetX: 0, offsetY: 0, width: 1280, height: 720, rotation: 3 as const, screen: { width: 2560, height: 1440 } };
    expect(ddagrabRegion(land)).toEqual({ x: 1280, y: 720, width: 1280, height: 720, turn: 'hflip,vflip' });
    expect(ddagrabRegion({ ...land, rotation: undefined })).toMatchObject({ x: 0, y: 0, turn: null });
  });

  it('the chain grabs the panel frame, scales it, then turns it: a 720x1280 picture', () => {
    const f = videoFilter({ crop: full, preset: PRESETS['720p30'] });
    expect(f).toContain('video_size=2560x1440');
    expect(f).toContain('scale=-2:720,transpose=cclock,');
    expect(outputSize({ crop: full, preset: PRESETS['720p30'] })).toEqual({ width: 720, height: 1280 });
  });
});
