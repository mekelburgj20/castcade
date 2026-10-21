/**
 * Settings store: one JSON file (`<userData>/settings.json`) implementing the witness module's
 * `WitnessSettingsStore`. No Electron import here so it can be unit-tested; the shell injects the
 * file path, the derived defaults (mapsDir, dataDir) and the token codec (safeStorage or plain).
 *
 * Persisted: arcaidBaseUrl, deviceId, deviceLabel, nvramDir, token. Derived every run, never
 * persisted: mapsDir (depends on the install location) and dataDir.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WitnessSettings, WitnessSettingsStore } from '../witness/types.js';

export const SETTINGS_FILE_VERSION = 1;
export const DEFAULT_ARCAID_BASE_URL = 'https://arcaid.app';

/** Encrypts the token at rest. `scheme` is recorded in the file so a later run knows how to read it. */
export interface TokenCodec {
  readonly scheme: string;
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

export const plainTokenCodec: TokenCodec = {
  scheme: 'plain',
  encrypt: (s) => s,
  decrypt: (s) => s,
};

/** The on-disk shape. Keep additive; bump SETTINGS_FILE_VERSION only for incompatible changes. */
export interface SettingsFile {
  version: number;
  arcaidBaseUrl?: string;
  deviceId?: string;
  deviceLabel?: string;
  nvramDir?: string | null;
  tablesDir?: string | null;
  token?: { scheme: string; value: string } | null;
}

/** Everything the shell must supply; the store fills the rest from the file or generates it. */
export interface SettingsDefaults {
  mapsDir: string;
  vpsDir: string;
  dataDir: string;
  deviceLabel: string;
  newDeviceId: () => string;
}

export interface SettingsLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** `https://arcaid.app/` → `https://arcaid.app`; throws on anything that is not an http(s) origin. */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`ArcAid URL is not a valid URL: ${JSON.stringify(input)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`ArcAid URL must be http(s): ${JSON.stringify(input)}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`ArcAid URL must be a bare origin like https://arcaid.app: ${JSON.stringify(input)}`);
  }
  return url.origin;
}

export function parseSettingsFile(text: string): SettingsFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== SETTINGS_FILE_VERSION) return null;
  const out: SettingsFile = { version: SETTINGS_FILE_VERSION };
  if (typeof o.arcaidBaseUrl === 'string') out.arcaidBaseUrl = o.arcaidBaseUrl;
  if (typeof o.deviceId === 'string' && o.deviceId.length > 0) out.deviceId = o.deviceId;
  if (typeof o.deviceLabel === 'string' && o.deviceLabel.length > 0) out.deviceLabel = o.deviceLabel;
  if (typeof o.nvramDir === 'string' || o.nvramDir === null) out.nvramDir = o.nvramDir;
  if (o.token === null) out.token = null;
  else if (typeof o.token === 'object' && o.token !== null) {
    const t = o.token as Record<string, unknown>;
    if (typeof t.scheme === 'string' && typeof t.value === 'string') {
      out.token = { scheme: t.scheme, value: t.value };
    }
  }
  return out;
}

/** Resolve file contents + defaults into a full `WitnessSettings`. Pure. */
export function resolveSettings(
  file: SettingsFile | null,
  defaults: SettingsDefaults,
  codec: TokenCodec,
  log: SettingsLogger,
): { settings: WitnessSettings; dirty: boolean } {
  let dirty = file === null;
  let arcaidBaseUrl = DEFAULT_ARCAID_BASE_URL;
  if (file?.arcaidBaseUrl) {
    try {
      arcaidBaseUrl = normalizeBaseUrl(file.arcaidBaseUrl);
    } catch (e) {
      log.warn(`settings: ${(e as Error).message}; using ${DEFAULT_ARCAID_BASE_URL}`);
      dirty = true;
    }
  }
  let deviceId = file?.deviceId;
  if (!deviceId) {
    deviceId = defaults.newDeviceId();
    dirty = true;
  }
  const deviceLabel = file?.deviceLabel ?? defaults.deviceLabel;
  const nvramDir = file?.nvramDir ?? null;
  const tablesDir = file?.tablesDir ?? null;

  let token: string | null = null;
  if (file?.token) {
    if (file.token.scheme === codec.scheme) {
      try {
        token = codec.decrypt(file.token.value);
      } catch (e) {
        log.warn(`settings: could not decrypt the stored token (${(e as Error).message}); you will need to pair again`);
        dirty = true;
      }
    } else if (file.token.scheme === plainTokenCodec.scheme) {
      // Written by a run without encryption; re-encrypt on the next save.
      token = file.token.value;
      dirty = true;
    } else {
      log.warn(`settings: stored token uses unknown scheme "${file.token.scheme}"; you will need to pair again`);
      dirty = true;
    }
  }

  return {
    settings: {
      arcaidBaseUrl,
      deviceId,
      deviceLabel,
      token,
      mapsDir: defaults.mapsDir,
      nvramDir,
      dataDir: defaults.dataDir,
      vpsDir: defaults.vpsDir,
      tablesDir,
    },
    dirty,
  };
}

export function serializeSettings(settings: WitnessSettings, codec: TokenCodec): string {
  const file: SettingsFile = {
    version: SETTINGS_FILE_VERSION,
    arcaidBaseUrl: settings.arcaidBaseUrl,
    deviceId: settings.deviceId,
    deviceLabel: settings.deviceLabel,
    nvramDir: settings.nvramDir,
    tablesDir: settings.tablesDir,
    token: settings.token === null ? null : { scheme: codec.scheme, value: codec.encrypt(settings.token) },
  };
  return JSON.stringify(file, null, 2) + '\n';
}

/** What the renderer may see: the token reduced to a boolean. */
export interface RedactedSettings extends Omit<WitnessSettings, 'token'> {
  hasToken: boolean;
}

export function redactSettings(settings: WitnessSettings): RedactedSettings {
  const { token, ...rest } = settings;
  return { ...rest, hasToken: token !== null };
}

/** The subset the renderer may change through `settings:set`. */
export interface SettingsPatch {
  arcaidBaseUrl?: string;
  nvramDir?: string | null;
  tablesDir?: string | null;
  deviceLabel?: string;
}

/** Validates and normalizes a renderer patch; throws on bad input. Pure. */
export function sanitizePatch(patch: unknown): Partial<WitnessSettings> {
  if (typeof patch !== 'object' || patch === null) throw new Error('settings patch must be an object');
  const p = patch as Record<string, unknown>;
  const out: Partial<WitnessSettings> = {};
  if ('arcaidBaseUrl' in p) {
    if (typeof p.arcaidBaseUrl !== 'string') throw new Error('arcaidBaseUrl must be a string');
    out.arcaidBaseUrl = normalizeBaseUrl(p.arcaidBaseUrl);
  }
  if ('nvramDir' in p) {
    if (p.nvramDir === null || (typeof p.nvramDir === 'string' && p.nvramDir.trim() === '')) out.nvramDir = null;
    else if (typeof p.nvramDir === 'string') out.nvramDir = p.nvramDir.trim();
    else throw new Error('nvramDir must be a string or null');
  }
  if ('tablesDir' in p) {
    if (p.tablesDir === null || (typeof p.tablesDir === 'string' && p.tablesDir.trim() === '')) out.tablesDir = null;
    else if (typeof p.tablesDir === 'string') out.tablesDir = p.tablesDir.trim();
    else throw new Error('tablesDir must be a string or null');
  }
  if ('deviceLabel' in p) {
    if (typeof p.deviceLabel !== 'string') throw new Error('deviceLabel must be a string');
    const label = p.deviceLabel.trim().slice(0, 64);
    if (label.length === 0) throw new Error('deviceLabel must not be empty');
    out.deviceLabel = label;
  }
  return out;
}

export interface SettingsStore extends WitnessSettingsStore {
  readonly file: string;
  /** Fires after every successful `set`, with the previous and new values. */
  onChange(listener: (next: WitnessSettings, prev: WitnessSettings) => void): () => void;
}

export interface SettingsStoreOptions {
  file: string;
  defaults: SettingsDefaults;
  codec: TokenCodec;
  log: SettingsLogger;
}

/** Loads (or creates) the settings file synchronously; writes are atomic (tmp + rename). */
export function openSettingsStore(opts: SettingsStoreOptions): SettingsStore {
  const { file, defaults, codec, log } = opts;
  let text: string | null;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  const parsed = text === null ? null : parseSettingsFile(text);
  if (text !== null && parsed === null) log.warn(`settings: ${file} is unreadable; starting from defaults`);
  const resolved = resolveSettings(parsed, defaults, codec, log);
  let current = resolved.settings;
  const listeners = new Set<(next: WitnessSettings, prev: WitnessSettings) => void>();

  const write = (settings: WitnessSettings): void => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, serializeSettings(settings, codec), 'utf8');
    renameSync(tmp, file);
  };
  if (resolved.dirty) {
    write(current);
    log.info(`settings: wrote ${file}`);
  }

  return {
    file,
    get: () => ({ ...current }),
    async set(patch) {
      const prev = current;
      const next: WitnessSettings = { ...current, ...patch };
      if (patch.arcaidBaseUrl !== undefined) next.arcaidBaseUrl = normalizeBaseUrl(patch.arcaidBaseUrl);
      write(next);
      current = next;
      for (const l of listeners) l({ ...next }, { ...prev });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
