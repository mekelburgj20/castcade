/**
 * D8.12 (2026-11-15): the corner scoreboard on the layer's pipe (`createVrLayerOverlay.setScoreboard`): `CVB1` frames
 * and `scoreboard: {corner}` on the control, to a protocol-4 layer only. A file of its own beside vr-layer.test.ts.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VR_LAYER_SCOREBOARD_MAGIC, type PanelFrame, type PanelFrameSource } from './match-media-types.js';
import { KEEPALIVE_MS } from './panel-frame-writer.js';
import { CONNECT_RETRY_MS, createVrLayerOverlay, VR_LAYER_PROTOCOL, VR_LAYER_SCOREBOARD_PROTOCOL, type Exec } from './vr-layer.js';

class FakePipe extends EventEmitter {
  readonly chunks: Buffer[] = [];
  writable = false;
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
  }
}

/** Everything written to the pipe, in order: controls as their JSON text, frames as [magic, width, height, first pixel byte]. */
function written(pipe: FakePipe): Array<string | [string, number, number, number]> {
  const all = Buffer.concat(pipe.chunks);
  const out: Array<string | [string, number, number, number]> = [];
  for (let at = 0; at < all.length; ) {
    const magic = all.toString('latin1', at, at + 4);
    if (magic === 'CVC1') {
      const n = all.readUInt32LE(at + 4);
      out.push(all.toString('utf8', at + 8, at + 8 + n));
      at += 8 + n;
    } else {
      out.push([magic, all.readUInt32LE(at + 4), all.readUInt32LE(at + 8), all[at + 16]!]);
      at += 16 + all.readUInt32LE(at + 12);
    }
  }
  return out;
}

const hello = (v: number): Buffer => {
  const b = Buffer.alloc(8);
  b.write('CVH1', 0, 'latin1');
  b.writeUInt32LE(v, 4);
  return b;
};

const frame = (tag: number): PanelFrame => ({ width: 2, height: 1, bgra: new Uint8Array(8).fill(tag) });

function source() {
  const cbs = new Set<(f: PanelFrame) => void>();
  const src: PanelFrameSource = {
    onFrame(cb) {
      cbs.add(cb);
      return () => void cbs.delete(cb);
    },
  };
  return { src, push: (f: PanelFrame) => cbs.forEach((cb) => cb(f)), listeners: () => cbs.size };
}

function setup() {
  const pipes: FakePipe[] = [];
  const exec: Exec = async (_file, args) => {
    if (args[0] === 'query') throw new Error('no key');
    return { stdout: '' };
  };
  const log: string[] = [];
  const ov = createVrLayerOverlay({
    jsonPath: 'C:\\layer\\XrApiLayer_castcade_panel.json',
    log: (l) => log.push(l),
    exec,
    connect: () => {
      const p = new FakePipe();
      pipes.push(p);
      return p as never;
    },
  });
  return { ov, pipes, log, panel: source(), board: source() };
}

/** The control a 0.2.40 companion sends a protocol-3 layer, and this one sends any layer while no scoreboard is asked. */
const PLAIN = (mode: string): string => `{"mode":"${mode}","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null}`;

afterEach(() => vi.useRealTimers());

describe('createVrLayerOverlay: the corner scoreboard (D8.12)', () => {
  it('this side speaks protocol 4, the first with the scoreboard; its frames are CVB1', () => {
    expect(VR_LAYER_PROTOCOL).toBe(4);
    expect(VR_LAYER_SCOREBOARD_PROTOCOL).toBe(4);
    expect(VR_LAYER_SCOREBOARD_MAGIC).toBe('CVB1');
  });

  it('a protocol-4 layer: the corner rides on the control, the frames go as CVB1 (the newest at once, then each change, then the keepalive)', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.panel.src);
    h.ov.setMode('hidden');
    // Asked before the layer is there: kept, and the page's first paint is kept too.
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-right' });
    h.board.push(frame(7));
    expect(h.log).toContain('vr-layer: scoreboard top-right (sent once a protocol-4 layer is connected)');
    h.pipes[0]!.answer();
    expect(written(h.pipes[0]!)).toEqual([]); // nothing but panel frames before the hello (none was painted)
    h.pipes[0]!.emit('data', hello(4));
    expect(h.log).toContain('vr-layer: the layer speaks pipe protocol 4 (modes, theater, camera, scoreboard)');
    expect(written(h.pipes[0]!)).toEqual(['{"mode":"hidden","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"scoreboard":{"corner":"top-right"}}', ['CVB1', 2, 1, 7]]);
    expect(h.log).toContain('vr-layer: mode hidden (mono, camera off, scoreboard top-right)');
    // The same again: no control, no frame.
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-right' });
    expect(written(h.pipes[0]!)).toHaveLength(2);
    h.board.push(frame(8));
    expect(written(h.pipes[0]!).at(-1)).toEqual(['CVB1', 2, 1, 8]);
    // The layer hides a stream after 5 s without a frame: a still scoreboard is re-sent.
    vi.advanceTimersByTime(KEEPALIVE_MS);
    expect(written(h.pipes[0]!).slice(2)).toEqual([['CVB1', 2, 1, 8], ['CVB1', 2, 1, 8]]);
    // The other corner: a control, no frame of its own.
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-left' });
    expect(written(h.pipes[0]!).at(-1)).toBe('{"mode":"hidden","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"scoreboard":{"corner":"top-left"}}');
    // Theater keeps it; the mode is the match host's business, the layer leaves the scoreboard out of panel mode itself.
    h.ov.setMode('theater');
    expect(written(h.pipes[0]!).at(-1)).toBe('{"mode":"theater","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"scoreboard":{"corner":"top-left"}}');
    await h.ov.stop();
  });

  it('no corner (the lobby): the control is byte for byte the one without a scoreboard and no frame goes; the newest frame goes the moment a corner is back', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.panel.src);
    h.pipes[0]!.answer();
    h.pipes[0]!.emit('data', hello(4));
    expect(written(h.pipes[0]!)).toEqual([PLAIN('panel')]);
    h.ov.setScoreboard?.({ frames: h.board.src, corner: null });
    h.board.push(frame(1));
    h.board.push(frame(2));
    vi.advanceTimersByTime(3 * KEEPALIVE_MS);
    expect(written(h.pipes[0]!)).toEqual([PLAIN('panel')]);
    expect(h.board.listeners()).toBe(1); // subscribed all the same: the page paints only on a change
    h.ov.setMode('hidden');
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-right' });
    expect(written(h.pipes[0]!).slice(1)).toEqual([PLAIN('hidden'), '{"mode":"hidden","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"scoreboard":{"corner":"top-right"}}', ['CVB1', 2, 1, 2]]);
    // Off again (back in the lobby): the control drops the field, the frames stop, the keepalive too.
    h.ov.setScoreboard?.({ frames: h.board.src, corner: null });
    const n = written(h.pipes[0]!).length;
    expect(written(h.pipes[0]!).at(-1)).toBe(PLAIN('hidden'));
    h.board.push(frame(3));
    vi.advanceTimersByTime(3 * KEEPALIVE_MS);
    expect(written(h.pipes[0]!)).toHaveLength(n);
    // No page at all (the setting is off): unsubscribed; a corner without frames asks for nothing.
    h.ov.setScoreboard?.({ frames: null, corner: 'top-right' });
    expect(h.board.listeners()).toBe(0);
    expect(written(h.pipes[0]!)).toHaveLength(n);
    await h.ov.stop();
  });

  it('a protocol-3 layer (0.6.0): never a CVB1 (it would lose its place in the stream), its control byte for byte the 0.2.40 one; said once; a new layer after a VPX restart gets both', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.panel.src);
    h.ov.setMode('hidden');
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-right' });
    h.board.push(frame(5));
    h.pipes[0]!.answer();
    h.pipes[0]!.emit('data', hello(3));
    h.board.push(frame(6));
    h.ov.setMode('theater');
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-left' });
    vi.advanceTimersByTime(3 * KEEPALIVE_MS);
    expect(written(h.pipes[0]!)).toEqual([PLAIN('hidden'), PLAIN('theater')]);
    expect(h.log.filter((l) => l.includes('before the corner scoreboard'))).toEqual([
      'vr-layer: the scoreboard is asked, but the layer in VPX speaks pipe protocol 3 (before the corner scoreboard): no scoreboard in the headset until VPX restarts with the new layer',
    ]);
    // VPX restarts with layer 0.7.0: the next connection gets the corner and the newest frame.
    h.pipes[0]!.hangUp();
    vi.advanceTimersByTime(CONNECT_RETRY_MS);
    h.pipes[1]!.answer();
    h.pipes[1]!.emit('data', hello(4));
    expect(written(h.pipes[1]!)).toEqual(['{"mode":"theater","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"scoreboard":{"corner":"top-left"}}', ['CVB1', 2, 1, 6]]);
    await h.ov.stop();
  });

  it('a protocol-2 layer and one without a hello get nothing new either; a companion that never asks sends a protocol-4 layer the old control', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.panel.src);
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-right' });
    h.board.push(frame(5));
    h.pipes[0]!.answer();
    h.panel.push(frame(1));
    expect(written(h.pipes[0]!)).toEqual([['CVO1', 2, 1, 1]]); // no hello: panel frames only, as 0.2.26
    h.pipes[0]!.emit('data', hello(2));
    expect(written(h.pipes[0]!).slice(1)).toEqual(['{"mode":"panel","stereo":"mono","panelPos":"low","theaterScale":1}']);
    await h.ov.stop();
    const g = setup();
    await g.ov.start(g.panel.src);
    g.pipes[0]!.answer();
    g.pipes[0]!.emit('data', hello(4));
    g.ov.setMode('hidden');
    expect(written(g.pipes[0]!)).toEqual([PLAIN('panel'), PLAIN('hidden')]);
    await g.ov.stop();
  });

  it('a place from match.json rides in the scoreboard object, live; without one the object is the corner alone', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.panel.src);
    h.ov.setMode('hidden');
    h.pipes[0]!.answer();
    h.pipes[0]!.emit('data', hello(4));
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-right', place: { offset: [0.5, 0.45, 1.2], widthM: 0.4 } });
    expect(written(h.pipes[0]!).at(-1)).toBe('{"mode":"hidden","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"scoreboard":{"corner":"top-right","offset":[0.5,0.45,1.2],"widthM":0.4}}');
    expect(h.log).toContain('vr-layer: mode hidden (mono, camera off, scoreboard top-right at 0.5, 0.45, 1.2 m, 0.4 m wide)');
    const n = written(h.pipes[0]!).length;
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-right', place: { offset: [0.5, 0.45, 1.2], widthM: 0.4 } });
    expect(written(h.pipes[0]!)).toHaveLength(n);
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-right', place: null });
    expect(written(h.pipes[0]!).at(-1)).toBe('{"mode":"hidden","stereo":"mono","panelPos":"low","theaterScale":1,"camera":null,"scoreboard":{"corner":"top-right"}}');
    await h.ov.stop();
  });

  it('stop lets go of the scoreboard: unsubscribed, and the next start begins without one', async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.ov.start(h.panel.src);
    h.ov.setScoreboard?.({ frames: h.board.src, corner: 'top-right' });
    expect(h.board.listeners()).toBe(1);
    await h.ov.stop();
    expect(h.board.listeners()).toBe(0);
    await h.ov.start(h.panel.src);
    h.pipes.at(-1)!.answer();
    h.pipes.at(-1)!.emit('data', hello(4));
    h.board.push(frame(9));
    expect(written(h.pipes.at(-1)!)).toEqual([PLAIN('panel')]);
    await h.ov.stop();
  });
});
