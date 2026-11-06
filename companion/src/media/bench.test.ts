import { describe, expect, it } from 'vitest';
import { BENCH_DESKTOP_HINT, BENCH_HEADSET_HINT, benchHint, benchReadout, benchReportFrom, benchRequestFrom, benchStep, benchWords, liveRefusal, type BenchPageReport } from './bench.js';

const report = (o: Partial<BenchPageReport> = {}): BenchPageReport => ({ path: 'direct', drawn: 30, bad: 0, fed: { width: 1440, height: 1440, stereo: 'sbs' }, fedFrames: 29, sent: null, bitrate: null, loopUp: true, error: null, ...o });

describe('the VR test bench, pure parts (D7.6)', () => {
  it('the request from the renderer: a source, a path (direct by default), a clip by folder name only, the loop’s cap (D7.6.9)', () => {
    expect(benchRequestFrom({ source: 'live' })).toEqual({ source: 'live', path: 'direct', clip: null, bitrate: null });
    expect(benchRequestFrom({ source: 'clip', path: 'loop', clip: { name: '2026-11-03-101500', side: 'receiver' } })).toEqual({ source: 'clip', path: 'loop', clip: { name: '2026-11-03-101500', side: 'receiver' }, bitrate: null });
    expect(benchRequestFrom({ source: 'live', path: 'loop', bitrate: 16_000_000 })).toEqual({ source: 'live', path: 'loop', clip: null, bitrate: 16_000_000 });
    expect(benchRequestFrom({ source: 'clip', path: 'loop', clip: { name: '2026-11-03-101500' }, bitrate: null })).toMatchObject({ bitrate: null });
    expect(benchRequestFrom({ source: 'live', path: 'loop', bitrate: 1_000_000 })).toMatchObject({ bitrate: 1_000_000 });
    expect(benchRequestFrom({ source: 'live', path: 'loop', bitrate: 100_000_000 })).toMatchObject({ bitrate: 100_000_000 });
    for (const bad of [999_999, 100_000_001, 16.5, -1, '16000000', NaN, Infinity, {}]) {
      expect(benchRequestFrom({ source: 'live', path: 'loop', bitrate: bad })).toBe("The bitrate cap must be between 1 and 100 Mbps, or the match's rule");
    }
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

  it('the page report is checked field by field; the codec and encoder ride along, capped (D7.6.8)', () => {
    expect(benchReportFrom({ path: 'loop', drawn: 30, fed: { width: 10, height: 20, stereo: 'sbs' }, sent: { width: 1440, height: 1440, kbps: 7800, fps: 30, limit: 'bandwidth' }, bitrate: 8e6, loopUp: true })).toEqual({
      path: 'loop',
      drawn: 30,
      bad: 0,
      fed: { width: 10, height: 20, stereo: 'sbs' },
      fedFrames: 0,
      sent: { width: 1440, height: 1440, kbps: 7800, fps: 30, limit: 'bandwidth', codec: null, encoder: null },
      bitrate: 8e6,
      loopUp: true,
      error: null,
    });
    expect(benchReportFrom({ path: 'loop', sent: { width: 1440, height: 1440, kbps: 7800, fps: 30, limit: 'none', codec: 'VP8', encoder: 'libvpx' } })).toMatchObject({ sent: { codec: 'VP8', encoder: 'libvpx' } });
    expect(benchReportFrom({ path: 'loop', sent: { width: 1440, height: 1440, codec: 'H264', encoder: 'MediaFoundationVideoEncodeAccelerator (hw)' } })).toMatchObject({ sent: { codec: 'H264', encoder: 'MediaFoundationVideoEncodeAccelerator (hw)' } });
    const long = benchReportFrom({ path: 'loop', sent: { width: 1, height: 1, codec: 'x'.repeat(40), encoder: 'y'.repeat(80) } })!.sent!;
    expect(long.codec).toHaveLength(32);
    expect(long.encoder).toHaveLength(64);
    expect(benchReportFrom({ path: 'loop', sent: { width: 1, height: 1, codec: '', encoder: 7 } })).toMatchObject({ sent: { codec: null, encoder: null } });
    expect(benchReportFrom({ drawn: -3, fed: 'x', sent: { kbps: 1 } })).toMatchObject({ path: 'direct', drawn: 0, fed: null, sent: null });
    expect(benchReportFrom('nope')).toBeNull();
  });

  it('the readout: fps drawn, the size handed to the layer, the encoder on the loop path (with its codec, D7.6.8); the layer camera while not on', () => {
    expect(benchReadout({ report: report(), headset: true, path: 'direct', source: 'clip' })).toBe('30 fps drawn · 1440x1440 both eyes to the layer at 29 fps');
    expect(benchReadout({ report: report({ path: 'loop', sent: { width: 1440, height: 1440, kbps: 7812, fps: 29.6, limit: 'none', codec: null, encoder: null }, bitrate: 8_000_000 }), headset: true, path: 'loop', source: 'clip' })).toBe(
      '30 fps drawn · 1440x1440 both eyes to the layer at 29 fps · encoder sent 1440x1440 at 7.8 Mbps (cap 8.0 Mbps), 30 fps, limited by none',
    );
    expect(benchReadout({ report: report({ path: 'loop', sent: { width: 1440, height: 1440, kbps: 7812, fps: 29.6, limit: 'none', codec: 'VP8', encoder: 'libvpx' }, bitrate: 8_000_000 }), headset: true, path: 'loop', source: 'clip' })).toBe(
      '30 fps drawn · 1440x1440 both eyes to the layer at 29 fps · encoder sent 1440x1440 at 7.8 Mbps (cap 8.0 Mbps), 30 fps, VP8 via libvpx, limited by none',
    );
    // The codec alone when the engine names no encoder; the cap override shows as the cap (D7.6.9).
    expect(benchReadout({ report: report({ path: 'loop', sent: { width: 1440, height: 1440, kbps: 15_600, fps: 30, limit: 'cpu', codec: 'H264', encoder: null }, bitrate: 16_000_000 }), headset: true, path: 'loop', source: 'live' })).toBe(
      '30 fps drawn · 1440x1440 both eyes to the layer at 29 fps · encoder sent 1440x1440 at 15.6 Mbps (cap 16.0 Mbps), 30 fps, H264, limited by cpu',
    );
    // No codec: nothing about it (an encoder name alone is not printed).
    expect(benchReadout({ report: report({ path: 'loop', sent: { width: 1440, height: 1440, kbps: 7812, fps: 30, limit: 'none', codec: null, encoder: 'libvpx' }, bitrate: 8_000_000 }), headset: true, path: 'loop', source: 'clip' })).toBe(
      '30 fps drawn · 1440x1440 both eyes to the layer at 29 fps · encoder sent 1440x1440 at 7.8 Mbps (cap 8.0 Mbps), 30 fps, limited by none',
    );
    expect(benchReadout({ report: report({ path: 'loop', loopUp: false, fed: null }), headset: true, path: 'loop', source: 'clip' })).toBe('30 fps drawn · nothing handed to the layer yet · local WebRTC loop connecting');
    expect(benchReadout({ report: report({ drawn: 0, bad: 2 }), headset: false, path: 'direct', source: 'live', camera: { state: 'asked', why: 'pipe closed' } })).toBe(
      'no frame drawn (2 unreadable) · no headset layer: the picture is in the desktop panel · layer camera asked (pipe closed)',
    );
    expect(benchReadout({ report: null, headset: true, path: 'direct', source: 'live', camera: { state: 'on', why: null } })).toBe('the panel is starting');
  });

  it('the hint: the owner’s words in the headset, the desktop panel on a PC, the direct view while compared', () => {
    expect(BENCH_HEADSET_HINT).toBe('In the headset: your table as a flat screen straight ahead, as the other players will see it (Life size at Theater size); compare detail with the direct view.');
    expect(benchHint(true, 'theater')).toBe(BENCH_HEADSET_HINT);
    expect(benchHint(false, 'theater')).toBe(BENCH_DESKTOP_HINT);
    expect(benchHint(true, 'direct')).toMatch(/VPX's own view is showing now/);
    expect(benchWords({ source: 'clip', path: 'loop', clip: { name: '2026-11-03-101500', side: 'sender', frames: 60, fps: 30 }, headset: true })).toBe('clip 2026-11-03-101500 (sender side, 60 frames at 30 fps), through a local WebRTC loop, theater in the headset');
    expect(benchWords({ source: 'live', path: 'direct', headset: false })).toBe('my own table, live, as the other players see it (the layer camera), straight to the layer, the desktop panel');
    // D7.6.9: the loop's cap override is in the start line; not when it is the match's rule, not on the direct path.
    expect(benchWords({ source: 'live', path: 'loop', headset: true, bitrate: 16_000_000 })).toBe('my own table, live, as the other players see it (the layer camera), through a local WebRTC loop, theater in the headset, cap 16 Mbps');
    expect(benchWords({ source: 'live', path: 'loop', headset: true, bitrate: 12_500_000 })).toBe('my own table, live, as the other players see it (the layer camera), through a local WebRTC loop, theater in the headset, cap 12.5 Mbps');
    expect(benchWords({ source: 'live', path: 'loop', headset: true, bitrate: null })).toBe('my own table, live, as the other players see it (the layer camera), through a local WebRTC loop, theater in the headset');
    expect(benchWords({ source: 'live', path: 'direct', headset: true, bitrate: 16_000_000 })).toBe('my own table, live, as the other players see it (the layer camera), straight to the layer, theater in the headset');
    // D7.5.9: the camera's view on the live source only.
    expect(benchWords({ source: 'live', path: 'direct', headset: true, view: 'whole' })).toBe('my own table, live, as the other players see it (the layer camera, whole view), straight to the layer, theater in the headset');
    expect(benchWords({ source: 'live', path: 'direct', headset: true, view: 'window' })).toBe('my own table, live, as the other players see it (the layer camera, window view), straight to the layer, theater in the headset');
    expect(benchWords({ source: 'clip', path: 'direct', headset: true, view: 'whole' })).toBe('a clip, straight to the layer, theater in the headset');
  });
});
