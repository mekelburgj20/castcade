import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAIN_MS, spawnFfmpeg } from './ffmpeg-pipeline.js';

/** A child process with real streams: what `spawnFfmpeg` wires together. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly fd3 = new PassThrough();
  readonly stdio: unknown[];
  readonly got: { stdin: Buffer[]; fd3: Buffer[] } = { stdin: [], fd3: [] };
  inputsEnded = { stdin: false, fd3: false };
  killed = false;
  constructor(readonly args: string[]) {
    super();
    this.stdio = [this.stdin, this.stdout, this.stderr, this.fd3];
    this.stdin.on('data', (b: Buffer) => this.got.stdin.push(b));
    this.fd3.on('data', (b: Buffer) => this.got.fd3.push(b));
    this.stdin.on('end', () => (this.inputsEnded.stdin = true));
    this.fd3.on('end', () => (this.inputsEnded.fd3 = true));
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.exit(1));
    return true;
  }
  exit(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code);
  }
}

function setup() {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const c = new FakeChild(args);
    children.push(c);
    return c as never;
  });
  const proc = spawnFfmpeg('ffmpeg', { grab: ['grab-args'], mux: ['mux-args'] }, { spawn });
  const [mux, grab] = children as [FakeChild, FakeChild];
  const lines: string[] = [];
  const exits: (number | null)[] = [];
  proc.onLine((l) => lines.push(l));
  proc.onExit((c) => exits.push(c));
  return { proc, mux, grab, lines, exits, spawn };
}

const tick = () => new Promise((r) => setImmediate(r));

afterEach(() => vi.useRealTimers());

describe('ffmpeg pipeline: a capture is grab → mux', () => {
  it('starts mux (stdin + fd 3) and grab (stdout), and copies grab\'s video to mux\'s fd 3', async () => {
    const { mux, grab, spawn } = setup();
    expect(spawn.mock.calls.map((c) => [c[1], (c[2] as { stdio: string[] }).stdio])).toEqual([
      [['mux-args'], ['pipe', 'ignore', 'pipe', 'pipe']],
      [['grab-args'], ['ignore', 'pipe', 'pipe']],
    ]);
    grab.stdout.write(Buffer.from('ts-1'));
    grab.stdout.write(Buffer.from('ts-2'));
    await tick();
    expect(Buffer.concat(mux.got.fd3).toString()).toBe('ts-1ts-2');
  });

  it('drops PCM until the first video arrives, so audio and picture start together', async () => {
    const { proc, mux, grab } = setup();
    proc.write(new Uint8Array([1, 1]));
    await tick();
    expect(mux.got.stdin).toEqual([]);
    grab.stdout.write(Buffer.from('ts'));
    await tick();
    proc.write(new Uint8Array([2, 2]));
    await tick();
    expect(Buffer.concat(mux.got.stdin)).toEqual(Buffer.from([2, 2]));
  });

  it('prefixes grab\'s log lines and splits progress lines on \\r', async () => {
    const { mux, grab, lines } = setup();
    grab.stderr.write('AcquireNextFrame failed: 887a0026\n');
    mux.stderr.write('frame=  1 fps=0\rframe=  2 fps=60\n');
    await tick();
    expect(lines).toEqual(['grab: AcquireNextFrame failed: 887a0026', 'frame=  1 fps=0', 'frame=  2 fps=60']);
  });

  it('kill stops grab only; mux gets the end of both inputs and finishes its files; one exit, mux\'s code', async () => {
    const { proc, mux, grab, exits } = setup();
    proc.kill();
    expect(grab.killed).toBe(true);
    expect(mux.killed).toBe(false);
    await tick();
    await tick();
    expect(mux.inputsEnded).toEqual({ stdin: true, fd3: true });
    mux.exit(0);
    await tick();
    expect(exits).toEqual([0]);
  });

  it('kills mux if it has not finished DRAIN_MS after a stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { proc, mux } = setup();
    proc.kill();
    await tick();
    expect(mux.killed).toBe(false);
    vi.advanceTimersByTime(DRAIN_MS);
    expect(mux.killed).toBe(true);
  });

  it('grab dying on its own (lost Desktop Duplication) ends the run with grab\'s code', async () => {
    const { mux, grab, exits } = setup();
    grab.exit(3752568763);
    await tick();
    expect(mux.inputsEnded).toEqual({ stdin: true, fd3: true });
    mux.exit(0);
    await tick();
    expect(exits).toEqual([3752568763]);
  });

  it('mux dying on its own (the ingest refused the push) kills grab and reports mux\'s code', async () => {
    const { mux, grab, exits } = setup();
    mux.exit(1);
    await tick();
    await tick();
    expect(grab.killed).toBe(true);
    expect(exits).toEqual([1]);
  });

  it('a single command (the slate) is one plain process', async () => {
    const children: FakeChild[] = [];
    const proc = spawnFfmpeg('ffmpeg', ['slate-args'], {
      spawn: (_c, args) => {
        const c = new FakeChild(args);
        children.push(c);
        return c as never;
      },
    });
    const exits: (number | null)[] = [];
    proc.onExit((c) => exits.push(c));
    expect(children).toHaveLength(1);
    proc.write(new Uint8Array([7]));
    await tick();
    expect(Buffer.concat(children[0]!.got.stdin)).toEqual(Buffer.from([7]));
    proc.kill();
    await tick();
    await tick();
    expect(exits).toEqual([1]);
  });
});
