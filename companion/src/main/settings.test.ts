import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeBaseUrl,
  openSettingsStore,
  parseSettingsFile,
  plainTokenCodec,
  redactSettings,
  resolveSettings,
  sanitizePatch,
  serializeSettings,
  type SettingsDefaults,
  type TokenCodec,
} from './settings.js';

const silent = { info: () => {}, warn: () => {} };
const rot13: TokenCodec = {
  scheme: 'rot13',
  encrypt: (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + 97)),
  decrypt: (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + 97)),
};
const defaults = (): SettingsDefaults => {
  let n = 0;
  return {
    mapsDir: 'X:/maps',
    dataDir: 'X:/data',
    deviceLabel: 'TESTBOX',
    newDeviceId: () => `id-${++n}`,
  };
};

describe('normalizeBaseUrl', () => {
  it('strips a trailing slash and keeps the origin', () => {
    expect(normalizeBaseUrl('https://arcaid.app/')).toBe('https://arcaid.app');
    expect(normalizeBaseUrl(' http://localhost:3001 ')).toBe('http://localhost:3001');
  });
  it('refuses non-http schemes, paths, credentials and junk', () => {
    expect(() => normalizeBaseUrl('ftp://arcaid.app')).toThrow();
    expect(() => normalizeBaseUrl('https://arcaid.app/account')).toThrow();
    expect(() => normalizeBaseUrl('https://u:p@arcaid.app')).toThrow();
    expect(() => normalizeBaseUrl('arcaid.app')).toThrow();
    expect(() => normalizeBaseUrl('')).toThrow();
  });
});

describe('resolveSettings', () => {
  it('generates a deviceId exactly once and marks the result dirty', () => {
    const d = defaults();
    const first = resolveSettings(null, d, plainTokenCodec, silent);
    expect(first.dirty).toBe(true);
    expect(first.settings.deviceId).toBe('id-1');
    expect(first.settings.deviceLabel).toBe('TESTBOX');
    expect(first.settings.arcaidBaseUrl).toBe('https://arcaid.app');
    expect(first.settings.token).toBeNull();
    const again = resolveSettings(parseSettingsFile(serializeSettings(first.settings, plainTokenCodec)), d, plainTokenCodec, silent);
    expect(again.dirty).toBe(false);
    expect(again.settings.deviceId).toBe('id-1');
  });

  it('remembers the VPX exe and the tables folder across runs (0.2.12: the import needs scripts\\ before any launch)', () => {
    const d = defaults();
    const { settings } = resolveSettings(null, d, plainTokenCodec, silent);
    expect(settings.vpxExe).toBeNull();
    const text = serializeSettings({ ...settings, vpxExe: 'C:\\VPX\\VPinballX64.exe', tablesDir: 'C:\\VPX\\tables' }, plainTokenCodec);
    const back = resolveSettings(parseSettingsFile(text), d, plainTokenCodec, silent).settings;
    expect(back.vpxExe).toBe('C:\\VPX\\VPinballX64.exe');
    expect(back.tablesDir).toBe('C:\\VPX\\tables');
  });
  it('round-trips the token through the codec', () => {
    const d = defaults();
    const { settings } = resolveSettings(null, d, rot13, silent);
    const text = serializeSettings({ ...settings, token: 'secret' }, rot13);
    expect(text).not.toContain('secret');
    expect(JSON.parse(text).token).toEqual({ scheme: 'rot13', value: 'frperg' });
    const back = resolveSettings(parseSettingsFile(text), d, rot13, silent);
    expect(back.settings.token).toBe('secret');
    expect(back.dirty).toBe(false);
  });
  it('accepts a plain token written by an unencrypted run and asks for a re-save', () => {
    const file = parseSettingsFile(JSON.stringify({ version: 1, deviceId: 'x', token: { scheme: 'plain', value: 'tok' } }));
    const r = resolveSettings(file, defaults(), rot13, silent);
    expect(r.settings.token).toBe('tok');
    expect(r.dirty).toBe(true);
  });
  it('drops an undecryptable or unknown-scheme token instead of crashing', () => {
    const bad: TokenCodec = { scheme: 'rot13', encrypt: (s) => s, decrypt: () => { throw new Error('nope'); } };
    const file = parseSettingsFile(JSON.stringify({ version: 1, deviceId: 'x', token: { scheme: 'rot13', value: 'v' } }));
    expect(resolveSettings(file, defaults(), bad, silent).settings.token).toBeNull();
    const other = parseSettingsFile(JSON.stringify({ version: 1, deviceId: 'x', token: { scheme: 'dpapi2', value: 'v' } }));
    expect(resolveSettings(other, defaults(), rot13, silent).settings.token).toBeNull();
  });
  it('falls back to the production URL when the stored one is invalid', () => {
    const file = parseSettingsFile(JSON.stringify({ version: 1, deviceId: 'x', arcaidBaseUrl: 'not a url' }));
    const r = resolveSettings(file, defaults(), plainTokenCodec, silent);
    expect(r.settings.arcaidBaseUrl).toBe('https://arcaid.app');
    expect(r.dirty).toBe(true);
  });
});

describe('parseSettingsFile', () => {
  it('returns null for junk, non-objects and other versions', () => {
    expect(parseSettingsFile('{')).toBeNull();
    expect(parseSettingsFile('42')).toBeNull();
    expect(parseSettingsFile(JSON.stringify({ version: 99 }))).toBeNull();
  });
});

describe('sanitizePatch / redactSettings', () => {
  it('normalizes the URL, trims the label, maps empty nvramDir to null', () => {
    expect(sanitizePatch({ arcaidBaseUrl: 'http://localhost:3001/', nvramDir: '  ', deviceLabel: '  Rig  ' })).toEqual({
      arcaidBaseUrl: 'http://localhost:3001',
      nvramDir: null,
      deviceLabel: 'Rig',
    });
    expect(sanitizePatch({ nvramDir: 'C:\\vpm\\nvram' })).toEqual({ nvramDir: 'C:\\vpm\\nvram' });
  });
  it('rejects wrong types and ignores unknown keys', () => {
    expect(() => sanitizePatch({ arcaidBaseUrl: 5 })).toThrow();
    expect(() => sanitizePatch({ deviceLabel: '' })).toThrow();
    expect(() => sanitizePatch('x')).toThrow();
    expect(sanitizePatch({ token: 'evil' })).toEqual({});
  });
  it('redacts the token to a boolean', () => {
    const { settings } = resolveSettings(null, defaults(), plainTokenCodec, silent);
    const red = redactSettings({ ...settings, token: 'secret' });
    expect(red.hasToken).toBe(true);
    expect('token' in red).toBe(false);
  });
});

describe('openSettingsStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'castcade-settings-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file on first open, persists set(), and notifies listeners', async () => {
    const file = join(dir, 'nested', 'settings.json');
    const store = openSettingsStore({ file, defaults: defaults(), codec: rot13, log: silent });
    expect(JSON.parse(readFileSync(file, 'utf8')).deviceId).toBe('id-1');

    const seen: string[] = [];
    store.onChange((next, prev) => seen.push(`${prev.arcaidBaseUrl}->${next.arcaidBaseUrl}`));
    await store.set({ arcaidBaseUrl: 'http://localhost:3001/', token: 'secret' });
    expect(seen).toEqual(['https://arcaid.app->http://localhost:3001']);
    expect(store.get().token).toBe('secret');
    expect(readFileSync(file, 'utf8')).not.toContain('secret');

    const reopened = openSettingsStore({ file, defaults: defaults(), codec: rot13, log: silent });
    expect(reopened.get()).toMatchObject({
      arcaidBaseUrl: 'http://localhost:3001',
      deviceId: 'id-1',
      token: 'secret',
      mapsDir: 'X:/maps',
      dataDir: 'X:/data',
    });
  });

  it('survives a corrupt file by starting from defaults and rewriting it', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{not json', 'utf8');
    const store = openSettingsStore({ file, defaults: defaults(), codec: plainTokenCodec, log: silent });
    expect(store.get().deviceId).toBe('id-1');
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('get() returns a copy', () => {
    const store = openSettingsStore({ file: join(dir, 's.json'), defaults: defaults(), codec: plainTokenCodec, log: silent });
    const a = store.get();
    a.deviceLabel = 'mutated';
    expect(store.get().deviceLabel).toBe('TESTBOX');
  });
});
