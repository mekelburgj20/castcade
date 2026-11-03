// D7.6.2 (2026-11-03): the layer's session report on the companion side: the CVS1 "session" kind in the reader, the
// overlay's `requestSession` (control `report: true`, outside the dedup), `bench()`, and `probeLayerSession`.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelFrame, PanelFrameSource, VrLayerBench } from './match-media-types.js';
import { BENCH_CONTROLS, createLayerReader, createVrLayerOverlay, parseSessionReport, probeLayerSession, sessionSummary, type Exec } from './vr-layer.js';

function hello(protocol: number): Buffer {
  const b = Buffer.alloc(8);
  b.write('CVH1', 0, 4, 'latin1');
  b.writeUInt32LE(protocol, 4);
  return b;
}

function status(json: object): Buffer {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const h = Buffer.alloc(8);
  h.write('CVS1', 0, 4, 'latin1');
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}

/** A report shaped like vr-layer/src/layer.cpp sessionFacts (a subset). */
const SESSION = {
  kind: 'session',
  layer: { name: 'XrApiLayer_castcade_panel', version: '0.5.0', build: 'abc1234', openxrHeaders: 'release-1.1.65', pipeProtocol: 3 },
  runtime: { name: 'VirtualDesktopXR', version: '1.0.9' },
  system: { id: '0x1', name: 'Quest 3', vendorId: '0x2833', maxLayers: 16, maxSwapchain: [4096, 4096], orientationTracking: true, positionTracking: true },
  graphics: { binding: 'OpenGL (Win32)', api: 'OpenGL', glVersion: '4.6.0 NVIDIA 566.36', glRenderer: null, glVendor: null, d3dFeatureLevel: null },
  openComposite: { verdict: 'likely (openvr_api.dll is loaded without SteamVR\'s vrclient, and VPX made an OpenXR instance)', namedOnInstance: false },
};

class FakePipe extends EventEmitter {
  readonly chunks: Buffer[] = [];
  writable = false;
  destroyed = false;
  write(chunk: Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  answer(): void {
    this.writable = true;
    this.emit('connect');
  }
  hangUp(): void {
    this.writable = false;
    this.emit('close');
  }
  destroy(): void {
    this.writable = false;
    this.destroyed = true;
  }
  /** The CVC1 controls written, as their exact JSON text. */
  controlTexts(): string[] {
    const all = Buffer.concat(this.chunks);
    const out: string[] = [];
    let at = 0;
    while (at + 8 <= all.length) {
      const magic = all.toString('latin1', at, at + 4);
      if (magic === 'CVC1') {
        const n = all.readUInt32LE(at + 4);
        out.push(all.toString('utf8', at + 8, at + 8 + n));
        at += 8 + n;
      } else {
        at += 16 + all.readUInt32LE(at + 12);
      }
    }
    return out;
  }
}

function setup() {
  const pipes: FakePipe[] = [];
  const exec: Exec = vi.fn(async () => ({ stdout: '' }));
  let clock = 1_000;
  const log: string[] = [];
  const ov = createVrLayerOverlay({
    jsonPath: 'C:\\x\\XrApiLayer_castcade_panel.json',
    log: (l) => log.push(l),
    exec,
    connect: () => {
      const pipe = new FakePipe();
      pipes.push(pipe);
      return pipe as never;
    },
    now: () => clock,
  });
  const cbs = new Set<(f: PanelFrame) => void>();
  const src: PanelFrameSource = { onFrame: (cb) => (cbs.add(cb), () => void cbs.delete(cb)) };
  const benches: VrLayerBench[] = [];
  ov.onBench!((b) => benches.push(b));
  return {
    ov,
    pipes,
    log,
    src,
    benches,
    tick(ms: number) {
      clock += ms;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('the session report in the reader (D7.6.2)', () => {
  it('a CVS1 with kind "session" is a session message; a camera status stays a status', () => {
    const r = createLayerReader();
    const ms = r.push(Buffer.concat([status(SESSION), status({ camera: 'on', why: '' })]));
    expect(ms.map((m) => m.kind)).toEqual(['session', 'status']);
    const { kind: _kind, ...facts } = SESSION;
    expect(ms[0]).toEqual({ kind: 'session', facts });
  });

  it('parseSessionReport: only a JSON object whose kind is "session"', () => {
    expect(parseSessionReport(Buffer.from('{"kind":"session","a":1}'))).toEqual({ a: 1 });
    expect(parseSessionReport(Buffer.from('{"camera":"on"}'))).toBeNull();
    expect(parseSessionReport(Buffer.from('[1]'))).toBeNull();
    expect(parseSessionReport(Buffer.from('not json'))).toBeNull();
  });

  it('sessionSummary: one line, unknown where a fact is missing', () => {
    expect(sessionSummary(SESSION)).toBe(
      "layer 0.5.0 build abc1234; runtime 'VirtualDesktopXR' 1.0.9; system 'Quest 3'; graphics OpenGL (Win32); OpenComposite likely (openvr_api.dll is loaded without SteamVR's vrclient, and VPX made an OpenXR instance)",
    );
    expect(sessionSummary({})).toBe('layer unknown build unknown; runtime unknown; system unknown; graphics unknown; OpenComposite unknown');
  });
});

describe('createVrLayerOverlay: the bench and the report request (D7.6.2)', () => {
  it('the controls are byte for byte as before; report: true rides on one control only when asked, outside the dedup', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.src);
    const p = h.pipes[0]!;
    p.answer();
    p.emit('data', hello(3));
    expect(p.controlTexts()).toEqual(['{"mode":"panel","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null}']);
    expect(h.ov.bench!()).toMatchObject({ started: true, connected: true, protocol: 3, session: null });

    const asked = h.ov.requestSession!(4000);
    expect(p.controlTexts()[1]).toBe('{"mode":"panel","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"report":true}');
    expect(h.log).toContain('vr-layer: asked the layer for its session report');
    h.tick(50);
    p.emit('data', status(SESSION));
    const got = await asked;
    expect(got).toMatchObject({ receivedAt: 1_050, facts: { runtime: { name: 'VirtualDesktopXR' } } });
    expect(h.ov.bench!().session).toBe(got);
    expect(h.log.some((l) => l.startsWith("vr-layer: session report from the layer: layer 0.5.0 build abc1234; runtime 'VirtualDesktopXR'"))).toBe(true);

    // The next ordinary control compares against the control without `report`: the same control is not written again.
    h.ov.setTheaterScale!(1);
    expect(p.controlTexts()).toHaveLength(2);
    h.ov.setTheaterScale!(0.8);
    expect(p.controlTexts()[2]).toBe('{"mode":"panel","stereo":"mono","panelPos":"low","theaterScale":0.8,"camera":null}');
    expect(h.ov.bench!().controls.map((c) => c.text)).toEqual(p.controlTexts());
  });

  it('the bench keeps the last few controls; the report waits at most its timeout', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.src);
    const p = h.pipes[0]!;
    p.answer();
    p.emit('data', hello(3));
    for (const s of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) h.ov.setTheaterScale!(s);
    expect(h.ov.bench!().controls).toHaveLength(BENCH_CONTROLS);
    expect(h.ov.bench!().controls.at(-1)!.text).toContain('"theaterScale":0.8');
    const asked = h.ov.requestSession!(4000);
    vi.advanceTimersByTime(4000);
    expect(await asked).toBeNull();
  });

  it('a protocol-2 layer or no connection: no report request goes out', async () => {
    vi.useFakeTimers();
    const h = setup();
    expect(await h.ov.requestSession!(1000)).toBeNull(); // not started
    expect(h.ov.bench!()).toMatchObject({ started: false, connected: false, protocol: 0 });
    await h.ov.start(h.src);
    const p = h.pipes[0]!;
    p.answer();
    p.emit('data', hello(2));
    expect(await h.ov.requestSession!(1000)).toBeNull();
    expect(p.controlTexts()).toEqual(['{"mode":"panel","stereo":"mono","panelPos":"low","theaterScale":1}']);
    p.hangUp();
    expect(h.benches.at(-1)).toMatchObject({ connected: false, protocol: 0 });
  });
});

describe('createVrLayerOverlay: the calibration pattern (D7.6.1)', () => {
  it('test: "pattern" is on the control only while set, only to a protocol-3 layer; off is the control as before', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.ov.setTest!('pattern'); // before any connection: kept, sent with the first control
    await h.ov.start(h.src); // start() runs stop() only when already running; nothing to clear here
    const p = h.pipes[0]!;
    p.answer();
    p.emit('data', hello(3));
    expect(p.controlTexts()).toEqual(['{"mode":"panel","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"test":"pattern"}']);
    expect(h.ov.bench!().test).toBe('pattern');
    h.ov.setTest!('pattern'); // the same again: nothing written
    expect(p.controlTexts()).toHaveLength(1);
    h.ov.setTest!(null);
    expect(p.controlTexts()[1]).toBe('{"mode":"panel","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null}');
    expect(h.benches.at(-1)!.test).toBeNull();
    expect(h.log).toContain('vr-layer: calibration pattern off');

    // A new connection (VPX restarted) gets it again while set.
    h.ov.setTest!('pattern');
    p.hangUp();
    vi.advanceTimersByTime(2000);
    const p2 = h.pipes[1]!;
    p2.answer();
    p2.emit('data', hello(3));
    expect(p2.controlTexts()[0]).toContain('"test":"pattern"');

    // stop() clears it: the next match starts without the pattern.
    await h.ov.stop();
    expect(h.ov.bench!().test).toBeNull();
  });

  it('a protocol-2 layer never sees the key', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.src);
    const p = h.pipes[0]!;
    p.answer();
    p.emit('data', hello(2));
    h.ov.setTest!('pattern');
    expect(p.controlTexts()).toEqual(['{"mode":"panel","stereo":"mono","panelPos":"low","theaterScale":1}']);
  });
});

describe('probeLayerSession (D7.6.2)', () => {
  it('reads the hello and the report, writes nothing, closes', async () => {
    vi.useFakeTimers();
    const pipe = new FakePipe();
    const done = probeLayerSession({ timeoutMs: 4000, connect: () => pipe as never, now: () => 7 });
    pipe.answer();
    pipe.emit('data', Buffer.concat([hello(3), status(SESSION)]));
    const r = await done;
    expect(r).toMatchObject({ connected: true, protocol: 3, session: { receivedAt: 7, facts: { system: { name: 'Quest 3' } } } });
    expect(pipe.chunks).toEqual([]);
    expect(pipe.destroyed).toBe(true);
  });

  it('says why when there is no report: no layer, an old protocol, silence', async () => {
    vi.useFakeTimers();
    const none = new FakePipe();
    const p1 = probeLayerSession({ timeoutMs: 4000, connect: () => none as never });
    none.emit('error', Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }));
    expect((await p1).note).toBe('no layer answered on the pipe (ENOENT): VPX not running in VR, or the layer not loaded in it');

    const old = new FakePipe();
    const p2 = probeLayerSession({ timeoutMs: 4000, connect: () => old as never });
    old.answer();
    old.emit('data', hello(2));
    expect(await p2).toMatchObject({ connected: true, protocol: 2, session: null });

    const quiet = new FakePipe();
    const p3 = probeLayerSession({ timeoutMs: 4000, connect: () => quiet as never });
    quiet.answer();
    quiet.emit('data', hello(3));
    vi.advanceTimersByTime(4000);
    expect((await p3).note).toBe('the layer (pipe protocol 3) sent no session report within 4 s (a layer before 0.5.0, or VPX is not rendering VR frames)');
  });
});
