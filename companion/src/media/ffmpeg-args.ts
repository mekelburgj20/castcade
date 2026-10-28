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
  /**
   * Raw PCM on stdin (`f32le`), from the companion's loopback capture; null = no audio. `lateMs`: how far the PCM trails
   * the picture (the capture path's latency, ~390 ms measured on the owner's rig with `--sync-test`); that much is cut
   * from the start of the audio so the two line up.
   */
  audio?: { sampleRate: number; channels: number; kbps: number; lateMs?: number } | null;
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

/** What the picture depends on: the same for the encode and the preview. */
export type PictureOptions = Pick<EncodeOptions, 'crop' | 'preset' | 'overlay'>;

/** The output picture's short side, in pixels: the preset's, never more than the capture's (no upscale). */
function outputShortSide(o: PictureOptions): number {
  const c = o.crop;
  return Math.min(o.preset.height, c.height > c.width ? c.width : c.height) & ~1;
}

/** The output picture's size in pixels (`scale=…:-2` rounds the long side to even). */
export function outputSize(o: PictureOptions): { width: number; height: number } {
  const c = o.crop;
  const short = outputShortSide(o);
  const long = Math.round((short * Math.max(c.width, c.height)) / Math.min(c.width, c.height) / 2) * 2;
  return c.height > c.width ? { width: short, height: long } : { width: long, height: short };
}

export function videoFilter(o: PictureOptions): string {
  return `${videoChain(o)}[v]`;
}

/**
 * Where `ddagrab` must cut, and how to turn the cut upright. Desktop Duplication hands over a rotated monitor's frame as
 * the panel scans it, not as the desktop shows it: the owner's display 2, set to portrait, reports DXGI rotation 4
 * (ROTATE270) and `ddagrab` gives 2560x1440 with the table on its side and the backbox on the right (2026-10-27). So the
 * crop (desktop coordinates) is mapped into the panel's frame, and the picture is turned back: rotation 4 a quarter
 * turn counter-clockwise, 2 clockwise, 3 a half turn.
 */
export function ddagrabRegion(c: DdagrabCrop): { x: number; y: number; width: number; height: number; turn: string | null } {
  const s = c.screen;
  if (!c.rotation || !s) return { x: c.offsetX, y: c.offsetY, width: c.width, height: c.height, turn: null };
  if (c.rotation === 3) return { x: s.width - c.offsetX - c.width, y: s.height - c.offsetY - c.height, width: c.width, height: c.height, turn: 'hflip,vflip' };
  // A quarter turn swaps the axes: the panel's frame is s.height wide and s.width tall.
  if (c.rotation === 4) return { x: s.height - c.offsetY - c.height, y: c.offsetX, width: c.height, height: c.width, turn: 'transpose=cclock' };
  return { x: c.offsetY, y: s.width - c.offsetX - c.width, width: c.height, height: c.width, turn: 'transpose=clock' };
}

/** The capture → picture chain with no output label (the encode labels it `[v]`; ffplay's lavfi input takes it bare). */
function videoChain(o: PictureOptions): string {
  const c = o.crop;
  // The preset names the short side (720p = 1280x720, or 720x1280 for a vertical window); never upscale.
  const portrait = c.height > c.width;
  const outH = outputShortSide(o);
  const g = ddagrabRegion(c);
  // A quarter turn is applied after the scale (a quarter of the pixels to move), so the scale runs in the panel's
  // orientation, where a portrait picture is still landscape.
  const scaleTall = g.turn?.startsWith('transpose') ? !portrait : portrait;
  const parts = [
    `ddagrab=output_idx=${c.outputIdx}:framerate=${o.preset.fps}:offset_x=${g.x}:offset_y=${g.y}:video_size=${g.width}x${g.height}:draw_mouse=0`,
    'hwdownload',
    'format=bgra',
    // Desktop Duplication only delivers a frame when the screen changes (a still desktop gave 192 frames in 20 s
    // on the owner's rig); repeat the last one so the stream is constant-rate, as RTMP ingests expect.
    `fps=${o.preset.fps}`,
    scaleTall ? `scale=${outH}:-2` : `scale=-2:${outH}`,
  ];
  if (g.turn) parts.push(g.turn);
  if (o.overlay) {
    parts.push(
      `drawtext=fontfile=${filterValue(o.overlay.fontFile)}:textfile=${filterValue(o.overlay.textFile)}:reload=1:fontsize=${Math.round(outH / 26)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=${Math.round(outH / 72)}:x=${Math.round(outH / 36)}:y=h-th-${Math.round(outH / 36)}`,
    );
  }
  parts.push('format=yuv420p');
  return parts.join(',');
}

export interface PreviewOptions extends PictureOptions {
  /** Where the preview window opens and how big, in virtual-desktop pixels (`previewPlacement`). */
  window: { left: number; top: number; width: number; height: number };
  title?: string;
}

/**
 * ffplay showing exactly what the stream would carry (same capture, crop, scale and overlay), with nothing encoded,
 * recorded or sent: the streamer checks the framing before going live (owner ask 2026-10-27). ffplay ships with ffmpeg.
 */
export function ffplayPreviewArgs(o: PreviewOptions): string[] {
  const w = o.window;
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    '-window_title', o.title ?? 'Castcade preview: what the stream shows (Q to close)',
    '-left', String(w.left), '-top', String(w.top), '-x', String(w.width), '-y', String(w.height),
    '-an', '-fflags', 'nobuffer', '-framedrop',
    '-f', 'lavfi', '-i', videoChain(o),
  ];
}

export function ffmpegArgs(o: EncodeOptions): string[] {
  const { mp4, rtmp } = o.outputs;
  if (!mp4 && !rtmp) throw new Error('ffmpegArgs: no output');
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-stats_period', '2'];
  if (o.audio) args.push('-thread_queue_size', '1024', '-f', 'f32le', '-ar', String(o.audio.sampleRate), '-ac', String(o.audio.channels), '-i', 'pipe:0');
  args.push('-filter_complex', videoFilter(o), '-map', '[v]');
  if (o.audio) {
    args.push('-map', '0:a');
    if (o.audio.lateMs) args.push('-af', `atrim=start=${(o.audio.lateMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`);
    args.push('-c:a', 'aac', '-b:a', `${o.audio.kbps}k`, '-ar', '48000');
  }
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
