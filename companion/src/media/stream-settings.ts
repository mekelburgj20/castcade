/**
 * D1.2 / D1.3 settings: `<userData>/stream.json`, apart from the witness settings. The stream key is stored through the
 * same codec as the pairing token (Electron `safeStorage` when the OS offers it); it is never logged and never sent
 * to ArcAid. No Electron import here so it can be unit-tested.
 */
import { DEFAULT_PRESET, PRESETS } from './ffmpeg-args.js';
import type { Rotate, StreamPlan } from './stream-engine.js';

export const STREAM_SETTINGS_VERSION = 1;

export type StreamService = 'twitch' | 'youtube' | 'custom';

/** Ingest bases; the key is appended. Twitch's global endpoint routes to the nearest server. */
export const INGEST: Record<Exclude<StreamService, 'custom'>, string> = {
  twitch: 'rtmp://live.twitch.tv/app/',
  youtube: 'rtmp://a.rtmp.youtube.com/live2/',
};

export interface StreamSettings {
  preset: string;
  orientation: 'portrait' | 'landscape';
  /** Portrait slice shift in percent of the window width (+ = right). 0 on desktop; the VR left eye wants ~10. */
  shiftPercent: number;
  rotate: Rotate;
  service: StreamService;
  /** For `custom`: the full ingest base, e.g. `rtmp://example.com/live/`. */
  customIngest: string | null;
  /** Where sessions go; null = the default (Videos\Castcade). */
  recordingsDir: string | null;
  keepSessions: number;
  maxRecordings: number | null;
  gameVolume: number;
  /**
   * How far the captured audio trails the picture, in ms: positive is cut from the audio's start, negative delays it.
   * Measured with the spike's `--desktop --sync-test` + `scripts/av-sync.py`. Renamed from `avLateMs` (390, the one-
   * process capture) when the capture became grab → mux (2026-10-28), so a stored 390 is dropped rather than misapplied.
   * Stored only when it differs from the default, so a retuned default reaches everyone who never set their own.
   */
  audioLateMs: number;
}

export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  preset: DEFAULT_PRESET,
  orientation: 'portrait',
  shiftPercent: 0,
  rotate: 0,
  service: 'twitch',
  customIngest: null,
  recordingsDir: null,
  keepSessions: 3,
  maxRecordings: null,
  gameVolume: 50,
  // grab → mux with 21 ms audio chunks: audio early by 121, 86 and 132 ms (medians of three runs, ±20 ms within a run;
  // rig 2026-10-28), so delayed 110. The grab as a lavfi input (D1.9) puts the picture ~35 ms later again (two runs at
  // -110: medians -30 and -40), so delayed 145: three check runs gave medians +40, +8 and +2 (late is the side viewers
  // notice less; runs differ by up to ~40 ms, more than within one run).
  audioLateMs: -145,
};

export interface StreamSettingsFile extends Partial<StreamSettings> {
  version: number;
  key?: { scheme: string; value: string } | null;
}

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

/** Settings from a file's contents; anything missing or out of range falls back to the default. Pure. */
export function readStreamSettings(text: string | null): { settings: StreamSettings; key: { scheme: string; value: string } | null } {
  let o: Record<string, unknown> = {};
  try {
    const raw: unknown = text ? JSON.parse(text) : {};
    if (typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === STREAM_SETTINGS_VERSION) o = raw as Record<string, unknown>;
  } catch {
    o = {};
  }
  const d = DEFAULT_STREAM_SETTINGS;
  return { settings: sanitize(o, d), key: readKey(o.key) };
}

function readKey(v: unknown): { scheme: string; value: string } | null {
  if (typeof v !== 'object' || v === null) return null;
  const k = v as Record<string, unknown>;
  return typeof k.scheme === 'string' && typeof k.value === 'string' ? { scheme: k.scheme, value: k.value } : null;
}

/** Apply a partial update from the UI over current settings; invalid fields keep their current value. Pure. */
export function patchStreamSettings(current: StreamSettings, patch: Partial<StreamSettings>): StreamSettings {
  return sanitize({ ...current, ...patch } as Record<string, unknown>, current);
}

function sanitize(o: Record<string, unknown>, d: StreamSettings): StreamSettings {
  const rotate = o.rotate === 0 || o.rotate === 90 || o.rotate === 180 || o.rotate === 270 ? o.rotate : d.rotate;
  const service = o.service === 'twitch' || o.service === 'youtube' || o.service === 'custom' ? o.service : d.service;
  return {
    preset: typeof o.preset === 'string' && o.preset in PRESETS ? o.preset : d.preset,
    orientation: o.orientation === 'portrait' || o.orientation === 'landscape' ? o.orientation : d.orientation,
    shiftPercent: num(o.shiftPercent, -50, 50) ?? d.shiftPercent,
    rotate,
    service,
    customIngest: typeof o.customIngest === 'string' && /^rtmps?:\/\/\S+$/i.test(o.customIngest.trim()) ? o.customIngest.trim() : o.customIngest === null ? null : d.customIngest,
    recordingsDir: typeof o.recordingsDir === 'string' && o.recordingsDir.trim() ? o.recordingsDir.trim() : o.recordingsDir === null ? null : d.recordingsDir,
    keepSessions: num(o.keepSessions, 0, 1000) !== undefined ? Math.floor(o.keepSessions as number) : d.keepSessions,
    maxRecordings: o.maxRecordings === null ? null : num(o.maxRecordings, 1, 100_000) !== undefined ? Math.floor(o.maxRecordings as number) : d.maxRecordings,
    gameVolume: num(o.gameVolume, 0, 400) ?? d.gameVolume,
    audioLateMs: num(o.audioLateMs, -1000, 2000) ?? d.audioLateMs,
  };
}

export function writeStreamSettings(settings: StreamSettings, key: { scheme: string; value: string } | null): string {
  const { audioLateMs, ...rest } = settings;
  const file: StreamSettingsFile = { version: STREAM_SETTINGS_VERSION, ...rest, ...(audioLateMs !== DEFAULT_STREAM_SETTINGS.audioLateMs ? { audioLateMs } : {}), key };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The ingest URL with the key, or null when there is no key (or no custom ingest). Never log the result. */
export function ingestUrl(s: StreamSettings, key: string | null): string | null {
  const k = key?.trim();
  if (!k) return null;
  const base = s.service === 'custom' ? s.customIngest : INGEST[s.service];
  if (!base) return null;
  return `${base.endsWith('/') ? base : `${base}/`}${k}`;
}

/** The engine's plan for a session: what to do (record, go live) from what is configured. */
export function planFor(
  s: StreamSettings,
  want: { record: boolean; live: boolean },
  ctx: { key: string | null; recordingsDir: string; fontFile: string | null; appVersion: string },
): StreamPlan {
  const rtmpUrl = want.live ? ingestUrl(s, ctx.key) : null;
  if (want.live && !rtmpUrl) throw new Error(s.service === 'custom' && !s.customIngest ? 'no ingest URL set' : 'no stream key set');
  return {
    preset: PRESETS[s.preset] ?? PRESETS[DEFAULT_PRESET]!,
    orientation: s.orientation,
    shift: s.shiftPercent / 100,
    rotate: s.rotate,
    record: want.record,
    rtmpUrl,
    audio: { sampleRate: 48000, channels: 2, kbps: 160, lateMs: s.audioLateMs },
    recordingsDir: s.recordingsDir ?? ctx.recordingsDir,
    retention: { keepSessions: s.keepSessions, maxRecordings: s.maxRecordings },
    fontFile: ctx.fontFile,
    appVersion: ctx.appVersion,
  };
}
