import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelFrame } from './match-media-types.js';
import { CONTROL_MAX_BYTES, controlMessage, createPanelFrameWriter, frameHeader, KEEPALIVE_MS } from './panel-frame-writer.js';

/** A stream under the test's control: `accept = false` makes `write` report a full pipe until `drain()`. */
class FakeStream extends EventEmitter {
  readonly chunks: Buffer[] = [];
  accept = true;
  writable = true;
  write(chunk: Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk));
    return this.accept;
  }
  drain(): void {
    this.accept = true;
    this.emit('drain');
  }
  /** The first pixel byte of each frame written so far (each frame is header + BGRA). */
  tags(): number[] {
    const all = Buffer.concat(this.chunks);
    const out: number[] = [];
    for (let at = 0; at < all.length; ) {
      expect(all.subarray(at, at + 4).toString('latin1')).toBe('CVO1');
      out.push(all[at + 16]!);
      at += 16 + all.readUInt32LE(at + 12);
    }
    return out;
  }
}

function frame(tag: number, width = 2, height = 1): PanelFrame {
  return { width, height, bgra: new Uint8Array(width * height * 4).fill(tag) };
}

function setup() {
  const log: string[] = [];
  const w = createPanelFrameWriter({ log: (l) => log.push(l), tag: 'test' });
  return { w, log };
}

afterEach(() => vi.useRealTimers());

describe('frameHeader', () => {
  it('is "CVO1" then width, height and width*height*4 as u32 little-endian', () => {
    const h = frameHeader(1280, 720);
    expect(h.length).toBe(16);
    expect([...h]).toEqual([0x43, 0x56, 0x4f, 0x31, 0x00, 0x05, 0, 0, 0xd0, 0x02, 0, 0, 0x00, 0x40, 0x38, 0x00]);
    expect(h.readUInt32LE(12)).toBe(1280 * 720 * 4);
  });

  it('D7.4: another magic for the video stream, same layout', () => {
    const h = frameHeader(2, 1, 'CVO2');
    expect(h.toString('latin1', 0, 4)).toBe('CVO2');
    expect(h.readUInt32LE(12)).toBe(8);
  });

  it('refuses what the helper and the layer would refuse', () => {
    expect(() => frameHeader(0, 10)).toThrow(RangeError);
    expect(() => frameHeader(4097, 10)).toThrow(RangeError);
    expect(() => frameHeader(10.5, 10)).toThrow(RangeError);
    expect(frameHeader(4096, 4096).readUInt32LE(12)).toBe(4096 * 4096 * 4);
  });
});

describe('createPanelFrameWriter', () => {
  it('holds a frame until a stream is attached, then writes header + BGRA at once', () => {
    const { w } = setup();
    w.push(frame(7));
    const s = new FakeStream();
    w.attach(s);
    expect(s.tags()).toEqual([7]);
    expect(s.chunks[0]!.length).toBe(16);
    expect(s.chunks[1]!.length).toBe(8);
  });

  it('drops frames while the stream is behind and writes the newest on drain', () => {
    const { w } = setup();
    const s = new FakeStream();
    w.attach(s);
    s.accept = false;
    w.push(frame(1)); // written; the stream now reports full
    w.push(frame(2)); // skipped
    w.push(frame(3)); // skipped
    expect(s.tags()).toEqual([1]);
    s.drain();
    expect(s.tags()).toEqual([1, 3]);
    w.push(frame(4));
    expect(s.tags()).toEqual([1, 3, 4]);
  });

  it('a new stream gets the last frame at once; the old one gets nothing more, even on its drain', () => {
    const { w } = setup();
    const a = new FakeStream();
    w.attach(a);
    a.accept = false;
    w.push(frame(1));
    const b = new FakeStream();
    w.attach(b);
    expect(b.tags()).toEqual([1]);
    a.drain();
    w.push(frame(2));
    expect(a.tags()).toEqual([1]);
    expect(b.tags()).toEqual([1, 2]);
    expect(a.listenerCount('drain')).toBe(0);
  });

  it('re-sends the last frame when nothing was written for the keepalive interval; none without a stream', () => {
    vi.useFakeTimers();
    const { w } = setup();
    const s = new FakeStream();
    w.attach(s);
    w.push(frame(5));
    vi.advanceTimersByTime(KEEPALIVE_MS - 1);
    expect(s.tags()).toEqual([5]);
    vi.advanceTimersByTime(1);
    expect(s.tags()).toEqual([5, 5]);
    w.attach(null);
    vi.advanceTimersByTime(KEEPALIVE_MS * 3);
    expect(s.tags()).toEqual([5, 5]);
  });

  it('a frame whose bytes do not match its size is dropped with a log line, not sent', () => {
    const { w, log } = setup();
    const s = new FakeStream();
    w.attach(s);
    w.push({ width: 4, height: 4, bgra: new Uint8Array(10) });
    w.push({ width: 5000, height: 1, bgra: new Uint8Array(5000 * 4) });
    expect(s.chunks).toEqual([]);
    expect(log[0]).toMatch(/^test: dropped a 4x4 frame of 10 bytes/);
    expect(log[1]).toMatch(/^test: dropped a frame: frame width 5000/);
  });

  it('clear() forgets the frame: a later stream gets nothing until the next one', () => {
    const { w } = setup();
    w.push(frame(9));
    w.clear();
    const s = new FakeStream();
    w.attach(s);
    expect(s.chunks).toEqual([]);
    w.push(frame(10));
    expect(s.tags()).toEqual([10]);
  });

  it('writes nothing to a stream that is no longer writable', () => {
    const { w } = setup();
    const s = new FakeStream();
    s.writable = false;
    w.attach(s);
    w.push(frame(1));
    expect(s.chunks).toEqual([]);
  });
});

describe('D7.4: the layer control and the video writer', () => {
  it('controlMessage is "CVC1", u32 byteLength, then the JSON in UTF-8', () => {
    const m = controlMessage({ mode: 'theater', stereo: 'sbs', panelPos: 'low' });
    expect(m.toString('latin1', 0, 4)).toBe('CVC1');
    const n = m.readUInt32LE(4);
    expect(n).toBe(m.length - 8);
    expect(JSON.parse(m.toString('utf8', 8))).toEqual({ mode: 'theater', stereo: 'sbs', panelPos: 'low' });
    expect(() => controlMessage({ pad: 'x'.repeat(CONTROL_MAX_BYTES) })).toThrow(RangeError);
  });

  it('a writer with magic CVO2 writes RGBA video frames under that magic, with the same drop-when-behind', () => {
    const w = createPanelFrameWriter({ log: () => undefined, tag: 'video', magic: 'CVO2' });
    const s = new FakeStream();
    w.attach(s);
    s.accept = false;
    w.push({ width: 2, height: 1, rgba: new Uint8Array(8).fill(9), stereo: 'mono' });
    w.push({ width: 2, height: 1, rgba: new Uint8Array(8).fill(10), stereo: 'mono' }); // blocked: held, newest wins
    w.push({ width: 2, height: 1, rgba: new Uint8Array(8).fill(11), stereo: 'sbs' });
    s.drain();
    const all = Buffer.concat(s.chunks);
    expect(all.toString('latin1', 0, 4)).toBe('CVO2');
    expect(all.length).toBe(2 * 24);
    expect([all[16], all[24 + 16]]).toEqual([9, 11]);
    w.clear();
  });
});
