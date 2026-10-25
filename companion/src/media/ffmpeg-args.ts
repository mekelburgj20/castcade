/**
 * The ffmpeg command line for solo streaming and recording (D1, architecture A in
 * `docs/design/solo-streaming-and-recording.md`): `ddagrab` cropped to the VPX window → CPU frames (`hwdownload`, the
 * path the Phase 0 spike measured; the GPU-resident `hwmap` failed on that build) → constant frame rate → scale → optional
 * live overlay text (`drawtext` with `reload=1`: the companion OVERWRITES the file in place; replacing it by rename makes
 * ffmpeg's per-frame open fail with "Permission denied" on Windows and the encode stops) → hardware H.264; game audio
 * arrives as raw PCM on stdin
 * (Electron's loopback capture; ffmpeg has no Windows loopback input of its own) and is encoded with the native `aac`.
 *
 * One output or two: MP4 (fragmented, so a crash still leaves a playable file) and / or FLV to an RTMP ingest. With
 * both, the `tee` muxer writes them from one encode, and `onfail=ignore` keeps the recording going if the stream drops.
 */
import type { DdagrabCrop } from './window-geometry.js';

export type VideoEncoder = 'h264_nvenc' | 'h264_amf' | 'h264_qsv' | 'libx264';

/** Order to try: NVIDIA, AMD, Intel, then the CPU. */
export const ENCODER_PREFERENCE: VideoEncoder[] = ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'];

export interface QualityPreset {
  id: string;
  height: number;
  fps: number;
  videoKbps: number;
}

/** 720p30 is the default (owner ruling 2026-10-25); the others are opt-in. */
export const PRESETS: Record<string, QualityPreset> = {
  '720p30': { id: '720p30', height: 720, fps: 30, videoKbps: 4500 },
  '1080p30': { id: '1080p30', height: 1080, fps: 30, videoKbps: 6000 },
  '1080p60': { id: '1080p60', height: 1080, fps: 60, videoKbps: 6000 },
};
export const DEFAULT_PRESET = '720p30';

export interface EncodeOptions {
  crop: DdagrabCrop;
  preset: QualityPreset;
  encoder: VideoEncoder;
  /** Live overlay text: the file ffmpeg re-reads every frame, and a TrueType font. */
  overlay?: { textFile: string; fontFile: string } | null;
  /** Raw PCM on stdin (`f32le`), from the companion's loopback capture; null = no audio. */
  audio?: { sampleRate: number; channels: number; kbps: number } | null;
  /** Where the encode goes: an MP4 path and / or an RTMP URL (stream key included; never log it raw). */
  outputs: { mp4?: string; rtmp?: string };
  /** Stop after this many seconds (spike runs); omit to run until stopped. */
  seconds?: number;
}

/** Escape a value for a filtergraph option inside single quotes (`C:/x` → `C\:/x`). */
export function filterValue(v: string): string {
  return `'${v.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
}

/** The tee muxer reads `\` as an escape: hand it forward slashes. */
const teePath = (p: string) => p.replace(/\\/g, '/');

function encoderArgs(e: VideoEncoder, p: QualityPreset): string[] {
  const k = `${p.videoKbps}k`;
  const buf = `${p.videoKbps * 2}k`;
  const gop = String(p.fps * 2); // a keyframe every 2 s (Twitch's requirement)
  switch (e) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-b:v', k, '-maxrate', k, '-bufsize', buf, '-g', gop];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-rc', 'cbr', '-b:v', k, '-maxrate', k, '-bufsize', buf, '-g', gop];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', k, '-maxrate', k, '-bufsize', buf, '-g', gop];
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', k, '-maxrate', k, '-bufsize', buf, '-g', gop];
  }
}

export function videoFilter(o: EncodeOptions): string {
  const c = o.crop;
  const outH = Math.min(o.preset.height, c.height) & ~1;
  const parts = [
    `ddagrab=output_idx=${c.outputIdx}:framerate=${o.preset.fps}:offset_x=${c.offsetX}:offset_y=${c.offsetY}:video_size=${c.width}x${c.height}:draw_mouse=0`,
    'hwdownload',
    'format=bgra',
    // Desktop Duplication only delivers a frame when the screen changes (a still desktop gave 192 frames in 20 s
    // on the owner's rig); repeat the last one so the stream is constant-rate, as RTMP ingests expect.
    `fps=${o.preset.fps}`,
    `scale=-2:${outH}`,
  ];
  if (o.overlay) {
    parts.push(
      `drawtext=fontfile=${filterValue(o.overlay.fontFile)}:textfile=${filterValue(o.overlay.textFile)}:reload=1:fontsize=${Math.round(outH / 26)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=${Math.round(outH / 72)}:x=${Math.round(outH / 36)}:y=h-th-${Math.round(outH / 36)}`,
    );
  }
  parts.push('format=yuv420p');
  return `${parts.join(',')}[v]`;
}

export function ffmpegArgs(o: EncodeOptions): string[] {
  const { mp4, rtmp } = o.outputs;
  if (!mp4 && !rtmp) throw new Error('ffmpegArgs: no output');
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-stats_period', '2'];
  if (o.audio) args.push('-thread_queue_size', '1024', '-f', 'f32le', '-ar', String(o.audio.sampleRate), '-ac', String(o.audio.channels), '-i', 'pipe:0');
  args.push('-filter_complex', videoFilter(o), '-map', '[v]');
  if (o.audio) args.push('-map', '0:a', '-c:a', 'aac', '-b:a', `${o.audio.kbps}k`, '-ar', '48000');
  args.push(...encoderArgs(o.encoder, o.preset));
  if (o.seconds !== undefined) args.push('-t', String(o.seconds));
  if (mp4 && rtmp) {
    args.push('-flags', '+global_header', '-f', 'tee', `[f=mp4:movflags=+frag_keyframe+empty_moov:onfail=ignore]${teePath(mp4)}|[f=flv:onfail=ignore]${rtmp}`);
  } else if (mp4) {
    args.push('-movflags', '+frag_keyframe+empty_moov', '-f', 'mp4', '-y', mp4);
  } else {
    args.push('-f', 'flv', rtmp!);
  }
  return args;
}

/** An RTMP URL with its stream key (the last path segment) hidden, for logs. */
export function redactRtmp(s: string): string {
  return s.replace(/(rtmps?:\/\/[^\s|]+\/)([^/\s|]+)/gi, '$1***');
}
