// D7.6.2 (2026-11-03): the VR report's pure builders: the file name, the counter lines of the last minute, the window
// fit, the flattening of the layer's facts and the markdown's shape (snapshot).
import { describe, expect, it } from 'vitest';
import {
  buildVrReportJson,
  buildVrReportMarkdown,
  flattenFacts,
  recentCounterLines,
  reportBaseName,
  tailLines,
  windowFacts,
  windowSettingsLines,
  windowTuneLines,
  type VrReportFacts,
} from './vr-report.js';

const NOW = Date.parse('2026-11-03T14:25:01.000Z');

const LOG = [
  '2026-11-03T14:23:50.000Z info  media: capture: 280 frames in 10 s, sent 1440x1392',
  '2026-11-03T14:24:05.000Z info  media: capture: 290 frames in 10 s, sent 1440x1392',
  '2026-11-03T14:24:20.000Z info  match: headset mode theater',
  '2026-11-03T14:24:30.000Z info  media: theater: 300 frames decoded at 1440x1392, 290 sent to the layer in 10 s',
  '2026-11-03T14:24:40.000Z info  vr-layer camera: 300 frames in 10 s (720x1440 per eye, 80 KB a frame); on',
  '2026-11-03T14:24:41.000Z info  theater: feeding 1440x1392 (sbs) to the layer',
  'garbage line with capture: but no time',
].join('\n');

function facts(): VrReportFacts {
  return {
    writtenAt: '2026-11-03T14:25:01.000Z',
    companion: { version: '0.2.33', protocol: 1 },
    layer: {
      source: 'match',
      connected: true,
      protocol: 3,
      fresh: true,
      note: "asked over the match's pipe connection",
      receivedAt: '2026-11-03T14:25:00.500Z',
      session: {
        layer: { version: '0.5.0', build: 'abc1234' },
        runtime: { name: 'VirtualDesktopXR', version: '1.0.9' },
        views: [{ recommended: [2064, 2208], max: [4096, 4096], samples: [1, 4] }, { recommended: [2064, 2208], max: [4096, 4096], samples: [1, 4] }],
        located: null,
        // D7.5.10 / D7.5.11: the window block with what the layer applied.
        window: { scale: 1, distanceM: 2.6, cropFromSender: true, tune: { depthM: 2.6, dyDeg: [0.5, -0.5] }, feather: 0.03 },
      },
    },
    rig: { rig: 'vr_headset', reason: 'VR at host', vrRuntime: 'virtual-desktop', witnessVr: { inVr: true, activeOpenXrRuntime: 'C:\\VD\\vdxr.json' }, vpxBeforeLayer: false, overlay: { state: 'showing', reason: null } },
    match: { role: 'host', phase: 'lobby', settings: { theaterScale: 1, cameraSource: 'screen', cameraView: 'whole', windowDepthM: null, eyeOffsetDeg: [0, 0], softEdge: 0.03 } },
    media: { attached: true, sending: false, captureSource: 'Visual Pinball Player', captureCrop: { width: 1440, height: 1392 }, captureStereo: 'sbs', captureWarning: null, lastError: null },
    ice: { description: '2 STUN, TURN turn:relay.example:3478', stun: ['stun:a:19302', 'stun:b:19302'], turn: { url: 'turn:relay.example:3478', username: 'me', credentialSet: true } },
    controls: [{ at: '2026-11-03T14:25:00.000Z', text: '{"mode":"panel","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"report":true}' }],
    camera: { state: 'off', why: null, lastFrameAt: null, frames: 0 },
    counters: { file: 'C:\\logs\\companion.log', lines: recentCounterLines(LOG, NOW), note: null },
    layerLog: { file: 'C:\\L\\vr-layer.log', lines: ['2026-11-03 15:25:00.700 [42] session: report sent to the companion (2048 bytes)'], note: null },
    window: windowFacts(
      {
        outputs: [{ index: 0, device: '\\\\.\\DISPLAY1', desktop: { left: 0, top: 0, width: 1920, height: 1080 }, monitor: '65537' }],
        windows: [{ pid: 42, title: 'Visual Pinball Player', client: { left: 0, top: 0, width: 1920, height: 1080 }, monitor: '65537' }],
      },
      null,
    ),
    ini: { path: 'C:\\VPX\\VPinballX.ini', entries: [{ key: 'VRPreview', value: '3' }, { key: 'PreviewWidth', value: '960' }], note: null },
  };
}

describe('vr-report (D7.6.2)', () => {
  it('names the files by local time', () => {
    expect(reportBaseName(new Date(2026, 10, 3, 9, 5, 7))).toBe('vr-report-2026-11-03-090507');
  });

  it('keeps the counter lines of the last minute only', () => {
    expect(recentCounterLines(LOG, NOW)).toEqual([
      '2026-11-03T14:24:05.000Z info  media: capture: 290 frames in 10 s, sent 1440x1392',
      '2026-11-03T14:24:30.000Z info  media: theater: 300 frames decoded at 1440x1392, 290 sent to the layer in 10 s',
      '2026-11-03T14:24:40.000Z info  vr-layer camera: 300 frames in 10 s (720x1440 per eye, 80 KB a frame); on',
      '2026-11-03T14:24:41.000Z info  theater: feeding 1440x1392 (sbs) to the layer',
    ]);
    expect(tailLines('a\n\nb\nc\n', 2)).toEqual(['b', 'c']);
  });

  it('the window: the full-screen warning from capture-crop, or a note when there is no player window', () => {
    const w = facts().window;
    expect(w.fit).toEqual({ fillsDisplay: true, cut: { top: 0, bottom: 0, left: 0, right: 0 } });
    expect(w.warning).toMatch(/^the VPX preview window covers the whole 1920x1080 display/);
    expect(windowFacts({ outputs: [], windows: [] }, null).note).toBe('no "Visual Pinball Player" window (no table running, or VPX minimised)');
    expect(windowFacts(null, 'the window probe failed: timed out').note).toBe('the window probe failed: timed out');
  });

  it('flattens facts one per line', () => {
    expect(flattenFacts({ a: { b: [1, 2], c: null }, d: [{ e: 'x' }], f: [] }, 'k')).toEqual(['- k.a.b: 1, 2', '- k.a.c: unknown', '- k.d[0].e: x', '- k.f: none']);
  });

  it('the markdown has every section, one fact per line (snapshot)', () => {
    expect(buildVrReportMarkdown(facts())).toMatchSnapshot();
  });

  it('D7.5.9-D7.5.11: the window settings and the layer\'s applied tuning in words; absent keys print nothing', () => {
    const md = buildVrReportMarkdown(facts());
    expect(md).toContain('- Camera view: whole\n- Window depth: infinity\n- Vertical offset: left +0.0°, right +0.0°\n- Soft edge: 3%');
    expect(md).not.toContain('settings.windowDepthM');
    expect(md).toContain('- window.cropFromSender: true\n- window depth: 2.6 m\n- vertical offset: left +0.5°, right -0.5°\n- feather: 3%');
    expect(md).not.toContain('window.tune');
    expect(windowSettingsLines({ theaterScale: 1, windowDepthM: 1.5, eyeOffsetDeg: [-1, 0.2], softEdge: 0 })).toEqual({ rest: { theaterScale: 1 }, lines: ['- Window depth: 1.5 m', '- Vertical offset: left -1.0°, right +0.2°', '- Soft edge: 0%'] });
    expect(windowSettingsLines({ theaterScale: 1 })).toEqual({ rest: { theaterScale: 1 }, lines: [] });
    // An older layer's window block (no tune / feather): the block prints as before.
    expect(windowTuneLines({ scale: 1 })).toEqual({ rest: { scale: 1 }, lines: [] });
    expect(windowTuneLines({ scale: 1, tune: null, feather: null })).toEqual({ rest: { scale: 1 }, lines: ['- window depth: infinity (default)', '- vertical offset: none (default)', '- feather: none (default)'] });
    expect(windowTuneLines(null)).toEqual({ rest: null, lines: [] });
  });

  it('the json carries the same facts and never a TURN credential', () => {
    const json = buildVrReportJson(facts());
    expect(JSON.parse(json)).toEqual(facts());
    expect(json).not.toMatch(/"credential"/);
  });
});
