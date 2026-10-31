import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMediaSettingsStore,
  DEFAULT_MEDIA_SETTINGS,
  DEFAULT_STUN,
  describeIce,
  iceServers,
  patchMediaSettings,
  readMediaSettings,
  writeMediaSettings,
} from './media-settings.js';

const turn = { url: 'turn:turn.example.com:3478', username: 'u', credential: 's3cret' };

describe('media settings (D2)', () => {
  it('defaults: Windows default mic, open, Google STUN, no TURN; unreadable or other-version files read as the default', () => {
    expect(readMediaSettings(null)).toEqual(DEFAULT_MEDIA_SETTINGS);
    expect(readMediaSettings('nope')).toEqual(DEFAULT_MEDIA_SETTINGS);
    expect(readMediaSettings('{"version":2,"muted":true}').muted).toBe(false);
    expect(DEFAULT_MEDIA_SETTINGS.stun).toEqual(['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']);
  });

  it('round-trips and drops invalid fields to the default', () => {
    const s = { micDeviceId: 'abc123', muted: true, turn, stun: ['stun:stun.example.org:3478'] };
    expect(readMediaSettings(writeMediaSettings(s))).toEqual(s);
    const bad = readMediaSettings(JSON.stringify({ version: 1, micDeviceId: 7, muted: 'yes', turn: { url: 'http://x', username: 'u', credential: 'c' }, stun: 'stun:x' }));
    expect(bad).toEqual(DEFAULT_MEDIA_SETTINGS);
  });

  it('STUN: keeps valid stun:/stuns: URLs, trimmed, deduplicated, at most 8; an empty list stays empty', () => {
    const s = readMediaSettings(JSON.stringify({ version: 1, stun: [' stun:a.example:1 ', 'stun:a.example:1', 'turn:b', 42, 'stuns:c.example'] }));
    expect(s.stun).toEqual(['stun:a.example:1', 'stuns:c.example']);
    expect(readMediaSettings(JSON.stringify({ version: 1, stun: [] })).stun).toEqual([]);
    expect(readMediaSettings(JSON.stringify({ version: 1, stun: Array.from({ length: 12 }, (_, i) => `stun:s${i}`) })).stun).toHaveLength(8);
  });

  it('a patch keeps the current value for a bad field; null clears the mic and the TURN server', () => {
    const cur = { ...DEFAULT_MEDIA_SETTINGS, micDeviceId: 'mic-1', turn };
    expect(patchMediaSettings(cur, { muted: true, micDeviceId: 5 as never })).toMatchObject({ muted: true, micDeviceId: 'mic-1' });
    expect(patchMediaSettings(cur, { micDeviceId: null, turn: null })).toMatchObject({ micDeviceId: null, turn: null });
    expect(patchMediaSettings(cur, { turn: { url: 'turn:x', username: 'a' } as never }).turn).toEqual(turn);
  });

  it('ICE servers for RTCPeerConnection: the STUN list as one entry, then TURN; the log line never has the credential', () => {
    expect(iceServers(DEFAULT_MEDIA_SETTINGS)).toEqual([{ urls: DEFAULT_STUN }]);
    expect(iceServers({ ...DEFAULT_MEDIA_SETTINGS, stun: [], turn })).toEqual([{ urls: turn.url, username: 'u', credential: 's3cret' }]);
    expect(describeIce({ ...DEFAULT_MEDIA_SETTINGS, turn })).toBe('2 STUN, TURN turn:turn.example.com:3478');
    expect(describeIce({ ...DEFAULT_MEDIA_SETTINGS, turn })).not.toContain('s3cret');
  });

  describe('file store', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    it('reads <userData>/media.json once, writes every patch through', () => {
      dir = mkdtempSync(join(tmpdir(), 'castcade-media-'));
      const file = join(dir, 'media.json');
      const a = createMediaSettingsStore(file);
      expect(a.get()).toEqual(DEFAULT_MEDIA_SETTINGS);
      a.patch({ micDeviceId: 'headset', muted: true });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, micDeviceId: 'headset', muted: true });
      expect(createMediaSettingsStore(file).get()).toMatchObject({ micDeviceId: 'headset', muted: true });
    });

    it('a failed write keeps the value in memory and reports the error', () => {
      dir = mkdtempSync(join(tmpdir(), 'castcade-media-'));
      const errors: unknown[] = [];
      // A path under a file cannot be created.
      const store = createMediaSettingsStore(join(dir, 'media.json'));
      store.patch({ muted: true });
      const broken = createMediaSettingsStore(join(dir, 'media.json', 'nested.json'), (e) => errors.push(e));
      expect(broken.patch({ muted: true }).muted).toBe(true);
      expect(broken.get().muted).toBe(true);
      expect(errors).toHaveLength(1);
    });
  });
});
