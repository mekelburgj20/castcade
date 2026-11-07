/**
 * D2 match media settings: `<userData>/media.json`, apart from the stream settings. The microphone (by device id: the
 * Windows default is often a virtual device in VR, solo-streaming-and-recording.md rig run 2), the mute state, the STUN
 * servers (Google's two by default, alpha-match.md §4) and an optional TURN server of the player's own (we run none
 * yet). The TURN credential is a relay password, not an account secret: stored as given, never logged. No Electron
 * import, so it unit-tests.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MEDIA_SETTINGS_VERSION = 1;

export interface TurnServer {
  /** `turn:` or `turns:` URL, e.g. `turn:turn.example.com:3478?transport=udp`. */
  url: string;
  username: string;
  credential: string;
}

export interface MediaSettings {
  /** `MediaDeviceInfo.deviceId` of the microphone; null = the Windows default. */
  micDeviceId: string | null;
  muted: boolean;
  turn: TurnServer | null;
  /** `stun:` URLs. An empty list is allowed (a LAN match needs none). */
  stun: string[];
  /**
   * D2.6 (2026-11-01): where the main window was last (DIPs), restored at the next run when it is still on a display;
   * null = never moved, centred as before. Lives here because media.json is the small settings file the shell already
   * patches and saves; the match panel is placed beside this window.
   */
  mainBounds: { x: number; y: number; width: number; height: number } | null;
  /**
   * D10.3 (2026-11-07, spectator-video-native.md §6.4): which path carries the spectator video. `native`: the
   * `castcade-video.exe` helper (hardware H.264, the frame rings; the Electron page's video track is held back where
   * the helper has a source); `electron`: the 0.2.36 path, untouched. Kept for one release (D10.7 removes it).
   */
  videoPath: VideoPath;
}

export type VideoPath = 'native' | 'electron';

export const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = { micDeviceId: null, muted: false, turn: null, stun: [...DEFAULT_STUN], mainBounds: null, videoPath: 'native' };

/** `RTCIceServer` without the DOM lib. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const MAX_STUN = 8;
const STUN_URL = /^stuns?:[^\s]+$/i;
const TURN_URL = /^turns?:[^\s]+$/i;

/** Settings from a file's contents; anything missing or invalid falls back to the default. Pure. */
export function readMediaSettings(text: string | null): MediaSettings {
  let o: Record<string, unknown> = {};
  try {
    const raw: unknown = text ? JSON.parse(text) : {};
    if (typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === MEDIA_SETTINGS_VERSION) o = raw as Record<string, unknown>;
  } catch {
    o = {};
  }
  return sanitize(o, DEFAULT_MEDIA_SETTINGS);
}

/** A partial update over the current settings; an invalid field keeps its current value. Pure. */
export function patchMediaSettings(current: MediaSettings, patch: Partial<MediaSettings>): MediaSettings {
  return sanitize({ ...current, ...patch } as Record<string, unknown>, current);
}

export function writeMediaSettings(s: MediaSettings): string {
  return `${JSON.stringify({ version: MEDIA_SETTINGS_VERSION, ...s }, null, 2)}\n`;
}

/** What the panel page gives `RTCPeerConnection`: the STUN URLs as one entry, then the TURN server if set. */
export function iceServers(s: MediaSettings): IceServer[] {
  const out: IceServer[] = [];
  if (s.stun.length) out.push({ urls: [...s.stun] });
  if (s.turn) out.push({ urls: s.turn.url, username: s.turn.username, credential: s.turn.credential });
  return out;
}

/** For the log: which servers, never the TURN credential. */
export function describeIce(s: MediaSettings): string {
  return `${s.stun.length} STUN${s.turn ? `, TURN ${s.turn.url}` : ', no TURN'}`;
}

function sanitize(o: Record<string, unknown>, d: MediaSettings): MediaSettings {
  return {
    micDeviceId: typeof o.micDeviceId === 'string' && o.micDeviceId.trim() && o.micDeviceId.length <= 512 ? o.micDeviceId : o.micDeviceId === null ? null : d.micDeviceId,
    muted: typeof o.muted === 'boolean' ? o.muted : d.muted,
    turn: o.turn === null ? null : (readTurn(o.turn) ?? d.turn),
    stun: Array.isArray(o.stun) ? readStun(o.stun) : [...d.stun],
    mainBounds: o.mainBounds === null ? null : (readBounds(o.mainBounds) ?? d.mainBounds),
    videoPath: o.videoPath === 'native' || o.videoPath === 'electron' ? o.videoPath : d.videoPath,
  };
}

function readBounds(v: unknown): MediaSettings['mainBounds'] {
  if (typeof v !== 'object' || v === null) return null;
  const b = v as Record<string, unknown>;
  const n = [b.x, b.y, b.width, b.height];
  if (!n.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 100_000)) return null;
  return { x: Math.round(b.x as number), y: Math.round(b.y as number), width: Math.round(b.width as number), height: Math.round(b.height as number) };
}

function readStun(v: unknown[]): string[] {
  const urls = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => STUN_URL.test(x));
  return [...new Set(urls)].slice(0, MAX_STUN);
}

function readTurn(v: unknown): TurnServer | null {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as Record<string, unknown>;
  const url = typeof t.url === 'string' ? t.url.trim() : '';
  if (!TURN_URL.test(url) || typeof t.username !== 'string' || typeof t.credential !== 'string') return null;
  if (t.username.length > 512 || t.credential.length > 512) return null;
  return { url, username: t.username, credential: t.credential };
}

/** The settings as the rest of the app holds them: read once, patched and written through. */
export interface MediaSettingsStore {
  get(): MediaSettings;
  patch(p: Partial<MediaSettings>): MediaSettings;
}

/** A file-backed store at `file` (`<userData>/media.json`); a write that fails keeps the new value in memory. */
export function createMediaSettingsStore(file: string, onWriteError: (e: unknown) => void = () => undefined): MediaSettingsStore {
  let text: string | null;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  let current = readMediaSettings(text);
  return {
    get: () => current,
    patch(p) {
      current = patchMediaSettings(current, p);
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, writeMediaSettings(current));
        renameSync(tmp, file);
      } catch (e) {
        onWriteError(e);
      }
      return current;
    },
  };
}
