import { describe, expect, it } from 'vitest';
import { ffmpegArgs, filterValue, PRESETS, redactRtmp, videoFilter } from './ffmpeg-args.js';
import { cropFor, pickPlayfield, type DxgiOutput, type VpxWindow } from './window-geometry.js';

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

  it('falls back to position when the handle is unknown; null off every output', () => {
    expect(cropFor(win({ monitor: '?', client: { left: 3000, top: 100, width: 800, height: 600 } }), OUTPUTS)).toMatchObject({ outputIdx: 1, offsetX: 440 });
    expect(cropFor(win({ monitor: '?', client: { left: 9000, top: 0, width: 800, height: 600 } }), OUTPUTS)).toBeNull();
  });

  it('the playfield is the window titled like the VPX player, else the largest', () => {
    const dmd = win({ title: 'DMD', client: { left: 0, top: 0, width: 3000, height: 900 } });
    const pf = win({ title: 'Visual Pinball Player', client: { left: 0, top: 0, width: 1920, height: 1080 } });
    expect(pickPlayfield([dmd, pf])).toBe(pf);
    expect(pickPlayfield([win({ title: 'a', client: { left: 0, top: 0, width: 100, height: 100 } }), dmd])).toBe(dmd);
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

  it('never upscales a small window', () => {
    expect(videoFilter({ crop: { ...crop, height: 600, width: 800 }, preset: PRESETS['1080p30']!, encoder: 'libx264', outputs: { mp4: 'x' } })).toContain('scale=-2:600');
  });

  it('a stream key never reaches a log', () => {
    expect(redactRtmp('… [f=flv]rtmp://live.twitch.tv/app/live_123_secret')).toBe('… [f=flv]rtmp://live.twitch.tv/app/***');
    expect(redactRtmp('rtmps://a.rtmps.youtube.com:443/live2/abcd-efgh')).toBe('rtmps://a.rtmps.youtube.com:443/live2/***');
  });
});
