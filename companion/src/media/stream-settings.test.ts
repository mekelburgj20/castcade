import { describe, expect, it } from 'vitest';
import { DEFAULT_STREAM_SETTINGS, ingestUrl, patchStreamSettings, planFor, readStreamSettings, writeStreamSettings } from './stream-settings.js';

describe('stream settings (D1.2 / D1.3)', () => {
  it('defaults: 720p30 portrait, Twitch, keep 3 sessions, game at 50 %, 390 ms audio trim', () => {
    expect(readStreamSettings(null)).toEqual({ settings: DEFAULT_STREAM_SETTINGS, key: null });
    expect(readStreamSettings('not json').settings).toEqual(DEFAULT_STREAM_SETTINGS);
    expect(readStreamSettings('{"version":99,"rotate":90}').settings.rotate).toBe(0);
  });

  it('round-trips, with the key as the codec stored it, and drops invalid values to the default', () => {
    const s = { ...DEFAULT_STREAM_SETTINGS, rotate: 90 as const, preset: '1080p30', maxRecordings: 20 };
    const text = writeStreamSettings(s, { scheme: 'safeStorage', value: 'b64' });
    expect(readStreamSettings(text)).toEqual({ settings: s, key: { scheme: 'safeStorage', value: 'b64' } });
    const bad = readStreamSettings(JSON.stringify({ version: 1, rotate: 45, preset: '4k', shiftPercent: 99, keepSessions: -1, service: 'kick', customIngest: 'http://x' }));
    expect(bad.settings).toEqual(DEFAULT_STREAM_SETTINGS);
  });

  it('a patch from the UI keeps the current value for a bad field', () => {
    const cur = { ...DEFAULT_STREAM_SETTINGS, rotate: 90 as const };
    expect(patchStreamSettings(cur, { orientation: 'landscape', rotate: 45 as never })).toMatchObject({ orientation: 'landscape', rotate: 90 });
    expect(patchStreamSettings(cur, { maxRecordings: null }).maxRecordings).toBeNull();
  });

  it('builds the ingest URL from the service and the key; none without a key', () => {
    expect(ingestUrl(DEFAULT_STREAM_SETTINGS, ' live_123 ')).toBe('rtmp://live.twitch.tv/app/live_123');
    expect(ingestUrl({ ...DEFAULT_STREAM_SETTINGS, service: 'youtube' }, 'abc')).toBe('rtmp://a.rtmp.youtube.com/live2/abc');
    expect(ingestUrl({ ...DEFAULT_STREAM_SETTINGS, service: 'custom', customIngest: 'rtmp://example.com/live' }, 'k')).toBe('rtmp://example.com/live/k');
    expect(ingestUrl({ ...DEFAULT_STREAM_SETTINGS, service: 'custom' }, 'k')).toBeNull();
    expect(ingestUrl(DEFAULT_STREAM_SETTINGS, '  ')).toBeNull();
  });

  it('plans a session: going live needs a key; record-only does not', () => {
    const ctx = { key: null, recordingsDir: 'C:/Videos/Castcade', fontFile: null, appVersion: '0.2.19' };
    expect(() => planFor(DEFAULT_STREAM_SETTINGS, { record: true, live: true }, ctx)).toThrow(/no stream key/);
    const p = planFor({ ...DEFAULT_STREAM_SETTINGS, rotate: 90, shiftPercent: 10 }, { record: true, live: false }, ctx);
    expect(p).toMatchObject({ record: true, rtmpUrl: null, rotate: 90, shift: 0.1, recordingsDir: 'C:/Videos/Castcade', retention: { keepSessions: 3, maxRecordings: null } });
    expect(p.preset.id).toBe('720p30');
    expect(planFor(DEFAULT_STREAM_SETTINGS, { record: false, live: true }, { ...ctx, key: 'k' }).rtmpUrl).toBe('rtmp://live.twitch.tv/app/k');
  });
});
