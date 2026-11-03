import { describe, expect, it } from 'vitest';
import { BENCH_DESKTOP_HINT, BENCH_HEADSET_HINT, benchHint, benchReadout, benchReportFrom, benchRequestFrom, benchStep, benchWords, liveRefusal, type BenchPageReport } from './bench.js';

const report = (o: Partial<BenchPageReport> = {}): BenchPageReport => ({ path: 'direct', drawn: 30, bad: 0, fed: { width: 1440, height: 1440, stereo: 'sbs' }, fedFrames: 29, sent: null, bitrate: null, loopUp: true, error: null, ...o });

describe('the VR test bench, pure parts (D7.6)', () => {
  it('the request from the renderer: a source, a path (direct by default), a clip by folder name only', () => {
    expect(benchRequestFrom({ source: 'live' })).toEqual({ source: 'live', path: 'direct', clip: null });
    expect(benchRequestFrom({ source: 'clip', path: 'loop', clip: { name: '2026-11-03-101500', side: 'receiver' } })).toEqual({ source: 'clip', path: 'loop', clip: { name: '2026-11-03-101500', side: 'receiver' } });
    expect(benchRequestFrom({ source: 'clip', clip: { name: '2026-11-03-101500-2' } })).toMatchObject({ clip: { side: 'sender' } });
    expect(benchRequestFrom({ source: 'clip', clip: { name: '..\\..\\Windows' } })).toBe('Pick a saved clip (Save 2 s of frames makes one)');
    expect(benchRequestFrom({ source: 'pattern' })).toBe('Pick a source: a saved clip, or your own table live');
    expect(benchRequestFrom(null)).toBe('No bench settings given');
  });

  it('the state machine: refused while a match is on or when running; stop, a failure and a match end it and detach', () => {
    expect(benchStep('off', { kind: 'start', matchOn: true })).toEqual({ state: 'off', refuse: 'A match is on: the VR test bench runs only without a match. Leave the match first.' });
    expect(benchStep('running', { kind: 'start', matchOn: false }).refuse).toMatch(/running already/);
    expect(benchStep('off', { kind: 'start', matchOn: false })).toEqual({ state: 'starting' });
    expect(benchStep('starting', { kind: 'started' })).toEqual({ state: 'running' });
    expect(benchStep('off', { kind: 'started' })).toEqual({ state: 'off' });
    for (const kind of ['stop', 'failed', 'match'] as const) {
      expect(benchStep('running', { kind })).toEqual({ state: 'off', detach: true });
      expect(benchStep('starting', { kind })).toEqual({ state: 'off', detach: true });
      expect(benchStep('off', { kind })).toEqual({ state: 'off' });
    }
  });

  it('own table live needs VR off SteamVR with the layer', () => {
    expect(liveRefusal('pc', null, true)).toMatch(/needs VPX running in VR/);
    expect(liveRefusal('vr_headset', 'steamvr', true)).toMatch(/does not run under SteamVR/);
    expect(liveRefusal('vr_headset', 'virtual-desktop', false)).toMatch(/not in this build/);
    expect(liveRefusal('vr_headset', 'virtual-desktop', true)).toBeNull();
  });

  it('the page report is checked field by field', () => {
    expect(benchReportFrom({ path: 'loop', drawn: 30, fed: { width: 10, height: 20, stereo: 'sbs' }, sent: { width: 1440, height: 1440, kbps: 7800, fps: 30, limit: 'bandwidth' }, bitrate: 8e6, loopUp: true })).toEqual({
      path: 'loop',
      drawn: 30,
      bad: 0,
      fed: { width: 10, height: 20, stereo: 'sbs' },
      fedFrames: 0,
      sent: { width: 1440, height: 1440, kbps: 7800, fps: 30, limit: 'bandwidth' },
      bitrate: 8e6,
      loopUp: true,
      error: null,
    });
    expect(benchReportFrom({ drawn: -3, fed: 'x', sent: { kbps: 1 } })).toMatchObject({ path: 'direct', drawn: 0, fed: null, sent: null });
    expect(benchReportFrom('nope')).toBeNull();
  });

  it('the readout: fps drawn, the size handed to the layer, the encoder on the loop path; the layer camera while not on', () => {
    expect(benchReadout({ report: report(), headset: true, path: 'direct', source: 'clip' })).toBe('30 fps drawn · 1440x1440 sbs to the layer at 29 fps');
    expect(benchReadout({ report: report({ path: 'loop', sent: { width: 1440, height: 1440, kbps: 7812, fps: 29.6, limit: 'none' }, bitrate: 8_000_000 }), headset: true, path: 'loop', source: 'clip' })).toBe(
      '30 fps drawn · 1440x1440 sbs to the layer at 29 fps · encoder sent 1440x1440 at 7.8 Mbps (cap 8.0 Mbps), 30 fps, limited by none',
    );
    expect(benchReadout({ report: report({ path: 'loop', loopUp: false, fed: null }), headset: true, path: 'loop', source: 'clip' })).toBe('30 fps drawn · nothing handed to the layer yet · local WebRTC loop connecting');
    expect(benchReadout({ report: report({ drawn: 0, bad: 2 }), headset: false, path: 'direct', source: 'live', camera: { state: 'asked', why: 'pipe closed' } })).toBe(
      'no frame drawn (2 unreadable) · no headset layer: the picture is in the desktop panel · layer camera asked (pipe closed)',
    );
    expect(benchReadout({ report: null, headset: true, path: 'direct', source: 'live', camera: { state: 'on', why: null } })).toBe('the panel is starting');
  });

  it('the hint: the owner’s words in the headset, the desktop panel on a PC, the direct view while compared', () => {
    expect(BENCH_HEADSET_HINT).toBe('In the headset: a single window straight ahead, life size at Theater size 1; the picture should fuse without effort; compare detail with the direct view.');
    expect(benchHint(true, 'theater')).toBe(BENCH_HEADSET_HINT);
    expect(benchHint(false, 'theater')).toBe(BENCH_DESKTOP_HINT);
    expect(benchHint(true, 'direct')).toMatch(/VPX's own view is showing now/);
    expect(benchWords({ source: 'clip', path: 'loop', clip: { name: '2026-11-03-101500', side: 'sender', frames: 60, fps: 30 }, headset: true })).toBe('clip 2026-11-03-101500 (sender side, 60 frames at 30 fps), through a local WebRTC loop, theater in the headset');
    expect(benchWords({ source: 'live', path: 'direct', headset: false })).toBe('my own table, live (the layer camera), straight to the layer, the desktop panel');
  });
});
