import { describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import { MemoryFs } from './fs.js';
import { JournalTail } from './journal-tail.js';

const PATH = 'C:/Users/me/AppData/Local/Castcade/journal/Table.jsonl';

function harness(from: 'start' | 'end' = 'end') {
  const clock = new ManualClock();
  const fs = new MemoryFs(() => clock.now());
  const tail = new JournalTail(PATH, { fs, clock, pollMs: 250, from });
  const lines: string[] = [];
  const truncations: { from: number; size: number }[] = [];
  tail.on('line', (l) => lines.push(l));
  tail.on('truncated', (t) => truncations.push(t));
  const append = (text: string) => fs.put(PATH, (fs.text(PATH) ?? '') + text);
  return { clock, fs, tail, lines, truncations, append };
}

describe('JournalTail', () => {
  it('starts at the end of an existing file and delivers only what is appended', async () => {
    const h = harness();
    h.fs.put(PATH, '{"event":"table_loaded","t":0}\n{"event":"table_exit","t":9}\n');
    await h.tail.poll();
    expect(h.lines).toEqual([]);
    h.append('{"event":"table_loaded","t":0.1}\n');
    await h.tail.poll();
    expect(h.lines).toEqual(['{"event":"table_loaded","t":0.1}']);
  });

  it('from start replays the whole file first', async () => {
    const h = harness('start');
    h.fs.put(PATH, 'a\nb\n');
    await h.tail.poll();
    expect(h.lines).toEqual(['a', 'b']);
  });

  it('holds a torn line until its newline arrives, strips CRLF, and keeps blank lines', async () => {
    const h = harness();
    await h.tail.poll(); // file does not exist yet
    h.append('{"event":"nvram_delta","d":[[1,2,');
    await h.tail.poll();
    expect(h.lines).toEqual([]);
    expect(h.tail.position).toBe(33); // the torn bytes are consumed, held, not delivered
    h.append('3]]}\r\n\n{"x":1}\n');
    await h.tail.poll();
    expect(h.lines).toEqual(['{"event":"nvram_delta","d":[[1,2,3]]}', '', '{"x":1}']);
    expect(h.tail.position).toBe(h.fs.text(PATH)?.length);
  });

  it('a file that appears after start is read from its first byte', async () => {
    const h = harness('end');
    await h.tail.poll();
    h.fs.put(PATH, 'first\n');
    await h.tail.poll();
    expect(h.lines).toEqual(['first']);
  });

  it('a shorter file restarts from the top and reports the truncation', async () => {
    const h = harness('start');
    h.fs.put(PATH, 'one\ntwo\n');
    await h.tail.poll();
    h.fs.put(PATH, 'x\n');
    await h.tail.poll();
    expect(h.truncations).toEqual([{ from: 8, size: 2 }]);
    expect(h.lines).toEqual(['one', 'two', 'x']);
  });

  it('decodes UTF-8 split across two reads', async () => {
    const h = harness('start');
    const bytes = new TextEncoder().encode('Médiéval\n');
    h.fs.put(PATH, bytes.subarray(0, 2)); // 'M' + first byte of 'é'
    await h.tail.poll();
    h.fs.put(PATH, bytes);
    await h.tail.poll();
    expect(h.lines).toEqual(['Médiéval']);
  });

  it('polls on the clock while running and stops cleanly', async () => {
    const h = harness('start');
    h.tail.start();
    h.clock.advance(0);
    await Promise.resolve();
    await h.tail.poll();
    h.append('late\n');
    h.clock.advance(250);
    await h.tail.poll();
    expect(h.lines).toEqual(['late']);
    h.tail.stop();
    expect(h.clock.pending()).toBe(0);
  });
});
