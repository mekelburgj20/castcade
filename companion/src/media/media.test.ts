import { describe, expect, it } from 'vitest';
import { captureArgs, coverCommand, ddagrabRegion, ffplayPreviewArgs, filterValue, outputSize, PRESETS, redactRtmp, videoFilter } from './ffmpeg-args.js';
import { ffmpegDir, resolveFfmpeg } from './ffmpeg-path.js';
import { cropFor, pickPlayfield, portraitSlice, previewPlacement, type DdagrabCrop, type DxgiOutput, type VpxWindow } from './window-geometry.js';

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

  it('720p30 NVENC to an MP4 with loopback audio and the overlay: grab encodes the picture, mux adds the audio', () => {
    const { grab, mux } = captureArgs({ crop, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', overlay: { textFile: 'overlay.txt', fontFile: 'C:\\Windows\\Fonts\\segoeui.ttf' }, audio: { sampleRate: 48000, channels: 2, kbps: 160 }, outputs: { mp4: 'C:\\rec\\s.mp4' }, seconds: 120 });
    // grab: no audio input (one ffmpeg would hold the screen grab back while it waits for the late audio)
    expect(grab).not.toContain('pipe:0');
    // the grab is a lavfi input (so the graph can take the cover command, D1.9), the picture chain one graph after it
    expect(grab.slice(grab.indexOf('-f'), grab.indexOf('-f') + 4)).toEqual(['-f', 'lavfi', '-i', 'ddagrab=output_idx=1:framerate=30:offset_x=100:offset_y=31:video_size=1920x1080:draw_mouse=0,hwdownload,format=bgra']);
    const vf = grab[grab.indexOf('-filter_complex') + 1]!;
    expect(vf).toMatch(/^\[0\]fps=30,scale=-2:720,drawtext=fontfile='C\\:\/Windows\/Fonts\/segoeui.ttf':textfile='overlay.txt':reload=1:/);
    expect(vf.endsWith(',format=yuv420p[v]')).toBe(true);
    expect(grab).toEqual(expect.arrayContaining(['-c:v', 'h264_nvenc', '-b:v', '4500k', '-g', '60']));
    expect(grab.slice(-9)).toEqual(['-flags', '+global_header', '-f', 'matroska', '-live', '1', '-flush_packets', '1', 'pipe:1']);
    // mux: PCM first (input 0), grab's H.264 on fd 3 (input 1), copied
    expect(mux.slice(mux.indexOf('-f'), mux.indexOf('-f') + 8)).toEqual(['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0']);
    expect(mux).toEqual(expect.arrayContaining(['-f', 'matroska', '-i', 'pipe:3', '-map', '1:v', '-map', '0:a', '-c:v', 'copy', '-c:a', 'aac', '-t', '120']));
    expect(mux).not.toContain('-filter_complex');
    expect(mux.slice(-8)).toEqual(['-movflags', '+frag_keyframe+empty_moov', '-frag_duration', '1000000', '-f', 'mp4', '-y', 'C:\\rec\\s.mp4']);
  });

  it('MP4 and RTMP together go through tee, the recording surviving a dropped stream', () => {
    const { grab, mux } = captureArgs({ crop, preset: PRESETS['1080p60']!, encoder: 'h264_amf', outputs: { mp4: 'C:\\rec\\s.mp4', rtmp: 'rtmp://live.twitch.tv/app/live_123_secret' } });
    expect(mux.slice(-4)).toEqual(['+global_header', '-f', 'tee', '[f=mp4:movflags=+frag_keyframe+empty_moov:frag_duration=1000000:onfail=ignore]C:/rec/s.mp4|[f=flv:onfail=ignore]rtmp://live.twitch.tv/app/live_123_secret']);
    expect(grab).toEqual(expect.arrayContaining(['-c:v', 'h264_amf', '-g', '120']));
    expect(mux).toEqual(expect.arrayContaining(['-i', 'pipe:3', '-map', '0:v']));
    expect([...grab, ...mux]).not.toContain('pipe:0');
    expect(grab.join(' ')).not.toContain('rtmp');
  });

  it('a vertical window scales its short side to the preset (720p = 720x1280)', () => {
    expect(videoFilter({ crop: { ...crop, width: 810, height: 1440 }, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', outputs: { mp4: 'x' } })).toContain('scale=720:-2');
  });

  it('trims the capture latency off the start of the audio', () => {
    const a = captureArgs({ crop, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', audio: { sampleRate: 48000, channels: 2, kbps: 160, lateMs: 390 }, outputs: { mp4: 'x.mp4' } }).mux;
    expect(a[a.indexOf('-af') + 1]).toBe('atrim=start=0.390,asetpts=PTS-STARTPTS');
    const early = captureArgs({ crop, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', audio: { sampleRate: 48000, channels: 2, kbps: 160, lateMs: -90 }, outputs: { mp4: 'x.mp4' } }).mux;
    expect(early[early.indexOf('-af') + 1]).toBe('adelay=delays=90:all=1');
  });

  it('never upscales a small window', () => {
    expect(videoFilter({ crop: { ...crop, height: 600, width: 800 }, preset: PRESETS['1080p30']!, encoder: 'libx264', outputs: { mp4: 'x' } })).toContain('scale=-2:600');
  });

  it('D1.9: the grab carries the cover (off or on at start) last before the pixel format, and listens on stdin for it', () => {
    const font = 'C:\\Windows\\Fonts\\segoeui.ttf';
    const off = captureArgs({ crop, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', outputs: { mp4: 'x.mp4' }, cover: { on: false, fontFile: font } }).grab;
    // one graph, fed by the lavfi input (a graph with no input never reads ffmpeg's commands)
    expect(off.filter((a) => a === '-filter_complex')).toHaveLength(1);
    const vf = off[off.indexOf('-filter_complex') + 1]!;
    expect(vf).toMatch(/^\[0\]fps=30,.*,format=yuv420p,drawbox@cover=x=0:y=0:w=iw:h=ih:color=0x0d1117:t=fill:enable=0,drawtext@covertext=fontfile='C\\:\/Windows\/Fonts\/segoeui.ttf':text='Paused\\: back in a moment':fontsize=40:.*:enable=0\[v\]$/);
    expect(off).not.toContain('-nostdin');
    expect(off).toEqual(expect.arrayContaining(['-stats_period', '0.05', '-map', '[v]']));
    const on = captureArgs({ crop, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', outputs: { mp4: 'x.mp4' }, cover: { on: true, fontFile: null } }).grab;
    expect(on[on.indexOf('-filter_complex') + 1]).toMatch(/,format=yuv420p,drawbox@cover=x=0:y=0:w=iw:h=ih:color=0x0d1117:t=fill:enable=1\[v\]$/);
    // no cover asked for (the spike): no cover filters
    expect(captureArgs({ crop, preset: PRESETS['720p30']!, encoder: 'h264_nvenc', outputs: { mp4: 'x.mp4' } }).grab.join(' ')).not.toContain('@cover');
  });

  it('D1.9: the cover command is one ffmpeg `c` line per filter, with no newline after the c', () => {
    expect(coverCommand(true, true)).toBe('cdrawbox@cover -1 enable 1\ncdrawtext@covertext -1 enable 1\n');
    expect(coverCommand(false, false)).toBe('cdrawbox@cover -1 enable 0\n');
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

describe('--rotate: VPX cabinet mode on a landscape monitor that stands portrait (owner rig 2026-10-27)', () => {
  const cab: DdagrabCrop = { outputIdx: 1, offsetX: 0, offsetY: 0, width: 2560, height: 1440 };

  it('turns the landscape grab into an upright 720x1280 picture, scaling before the turn', () => {
    const f = videoFilter({ crop: cab, rotate: 90, preset: PRESETS['720p30'] });
    expect(f).toContain('video_size=2560x1440');
    expect(f).toContain('scale=-2:720,transpose=clock,');
    expect(outputSize({ crop: cab, rotate: 90, preset: PRESETS['720p30'] })).toEqual({ width: 720, height: 1280 });
    expect(videoFilter({ crop: cab, rotate: 270, preset: PRESETS['720p30'] })).toContain('transpose=cclock');
    expect(videoFilter({ crop: cab, rotate: 0, preset: PRESETS['720p30'] })).not.toContain('transpose');
  });

  it('adds to the monitor rotation: a flipped landscape (3) plus 90 is one counter-clockwise turn', () => {
    const flipped = { ...cab, rotation: 3 as const, screen: { width: 2560, height: 1440 } };
    const f = videoFilter({ crop: flipped, rotate: 90, preset: PRESETS['720p30'] });
    expect(f).toContain('transpose=cclock');
    expect(f).not.toContain('hflip');
    expect(videoFilter({ crop: flipped, rotate: 180, preset: PRESETS['720p30'] })).not.toMatch(/transpose|flip/);
  });

  it('the vertical slice runs along the window height when turned, and the shift follows the picture', () => {
    const wide = { ...cab, height: 1000 }; // a turned picture 1000 wide, 2560 tall: wider than 9:16 is 1440
    expect(portraitSlice(cab, 0.1, 90)).toEqual(cab); // 1440 across, 2560 tall: already 9:16
    const tall = { outputIdx: 0, offsetX: 0, offsetY: 0, width: 1000, height: 1440 };
    // turned, the picture is 1440 wide and 1000 tall: slice 562 of the 1440 rows, centred, + = right
    expect(portraitSlice(tall, 0, 90)).toMatchObject({ offsetY: 439, height: 562, width: 1000 });
    expect(portraitSlice(tall, 0.1, 90).offsetY).toBe(439 - 144); // 90 clockwise: the picture's right is the crop's top
    expect(portraitSlice(tall, 0.1, 270).offsetY).toBe(439 + 144);
    expect(portraitSlice(wide, 0, 0)).toMatchObject({ width: 562 });
  });
});
