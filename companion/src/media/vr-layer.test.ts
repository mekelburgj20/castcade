import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelFrame, PanelFrameSource, VrOverlayStatus } from './match-media-types.js';
import {
  CONNECT_RETRY_MS,
  createVrLayerOverlay,
  deleteArgs,
  OPENXR_IMPLICIT_LAYERS_KEY,
  parseRegQuery,
  registerArgs,
  resolveVrLayer,
  RESTART_VPX_AFTER_MS,
  VR_LAYER_JSON,
  VR_LAYER_PIPE,
  type Exec,
} from './vr-layer.js';

const JSON_PATH = 'C:\\Users\\p\\AppData\\Local\\Programs\\Castcade\\resources\\vr-layer\\XrApiLayer_castcade_panel.json';

/** A named-pipe client under the test's control: the test decides whether the layer answers. */
class FakePipe extends EventEmitter {
  readonly chunks: Buffer[] = [];
  writable = false;
  destroyed = false;
  constructor(readonly path: string) {
    super();
  }
  write(chunk: Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  /** The layer accepted the connection. */
  answer(): void {
    this.writable = true;
    this.emit('connect');
  }
  /** Nobody serves the pipe (VPX not running, or running without the layer). */
  refuse(): void {
    this.emit('error', Object.assign(new Error(`connect ENOENT ${this.path}`), { code: 'ENOENT' }));
    this.emit('close');
  }
  /** The layer went away (VPX exited). */
  hangUp(): void {
    this.writable = false;
    this.emit('close');
  }
  destroy(): void {
    this.destroyed = true;
    this.writable = false;
  }
  /** The first pixel byte of each frame written. */
  tags(): number[] {
    const all = Buffer.concat(this.chunks);
    const out: number[] = [];
    for (let at = 0; at < all.length; at += 16 + all.readUInt32LE(at + 12)) out.push(all[at + 16]!);
    return out;
  }
}

function frame(tag: number): PanelFrame {
  return { width: 2, height: 1, bgra: new Uint8Array(8).fill(tag) };
}

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

function setup(o: { jsonPath?: string | null; query?: string; vpx?: boolean; failAdd?: boolean } = {}) {
  const pipes: FakePipe[] = [];
  const regCalls: string[][] = [];
  const exec: Exec = vi.fn(async (file: string, args: string[]) => {
    expect(file).toBe('reg.exe');
    regCalls.push(args);
    if (args[0] === 'query') {
      if (o.query === undefined) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
      return { stdout: o.query };
    }
    if (args[0] === 'add' && o.failAdd) throw new Error('ERROR: Access is denied.');
    return { stdout: 'The operation completed successfully.\r\n' };
  });
  let clock = 0;
  let vpx = o.vpx ?? true;
  const log: string[] = [];
  const ov = createVrLayerOverlay({
    jsonPath: o.jsonPath === undefined ? JSON_PATH : o.jsonPath,
    log: (l) => log.push(l),
    exec,
    connect: (p) => {
      const pipe = new FakePipe(p);
      pipes.push(pipe);
      return pipe as never;
    },
    now: () => clock,
    vpxRunning: () => vpx,
  });
  const states: VrOverlayStatus[] = [];
  ov.onStatus((s) => states.push(s));
  return {
    ov,
    pipes,
    regCalls,
    log,
    states,
    ...source(),
    /** Fake time: the injected clock and vitest's timers together. */
    advance(ms: number) {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    setVpx(v: boolean) {
      vpx = v;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('resolveVrLayer', () => {
  const at = (...have: string[]) => (p: string) => have.includes(p);
  const companionDir = resolve('/repo/companion');
  const built = resolve(companionDir, '..', 'vr-layer', 'build', 'Release', VR_LAYER_JSON);
  const fetched = resolve(companionDir, 'resources', 'vr-layer', VR_LAYER_JSON);

  it('packaged: resources/vr-layer', () => {
    const p = join('/app/resources', 'vr-layer', VR_LAYER_JSON);
    expect(resolveVrLayer({ packaged: true, resourcesPath: '/app/resources', companionDir }, at(p))).toBe(p);
  });

  it('dev: the local CMake build first, then a fetched copy, else null', () => {
    const i = { packaged: false, resourcesPath: '', companionDir };
    expect(resolveVrLayer(i, at(built, fetched))).toBe(built);
    expect(resolveVrLayer(i, at(fetched))).toBe(fetched);
    expect(resolveVrLayer(i, at())).toBeNull();
  });
});

describe('the registry', () => {
  it('registers the json path as an enabled implicit layer for the current user', () => {
    expect(OPENXR_IMPLICIT_LAYERS_KEY).toBe('HKCU\\SOFTWARE\\Khronos\\OpenXR\\1\\ApiLayers\\Implicit');
    expect(registerArgs(JSON_PATH)).toEqual(['add', OPENXR_IMPLICIT_LAYERS_KEY, '/v', JSON_PATH, '/t', 'REG_DWORD', '/d', '0', '/f']);
    expect(deleteArgs('C:\\old\\x.json')).toEqual(['delete', OPENXR_IMPLICIT_LAYERS_KEY, '/v', 'C:\\old\\x.json', '/f']);
  });

  it("parses reg query's output, names with spaces included", () => {
    const out =
      '\r\nHKEY_CURRENT_USER\\SOFTWARE\\Khronos\\OpenXR\\1\\ApiLayers\\Implicit\r\n' +
      '    C:\\Program Files\\OpenXR-Toolkit\\XR_APILAYER_MBUCCHIA_toolkit.json    REG_DWORD    0x0\r\n' +
      `    ${JSON_PATH}    REG_DWORD    0x1\r\n` +
      '    odd    REG_SZ    text\r\n\r\n';
    expect(parseRegQuery(out)).toEqual([
      { name: 'C:\\Program Files\\OpenXR-Toolkit\\XR_APILAYER_MBUCCHIA_toolkit.json', value: 0 },
      { name: JSON_PATH, value: 1 },
      { name: 'odd', value: null },
    ]);
  });
});

describe('createVrLayerOverlay', () => {
  it('without the json: unavailable layer_missing, no registry write, no pipe', async () => {
    const { ov, regCalls, pipes, src } = setup({ jsonPath: null });
    expect(await ov.start(src)).toEqual({ state: 'unavailable', reason: 'layer_missing' });
    expect(regCalls).toEqual([]);
    expect(pipes).toEqual([]);
  });

  it('registers (key absent before), connects to the pipe, showing on connect; frames go up as header + BGRA', async () => {
    const { ov, regCalls, pipes, src, push, log, states } = setup();
    expect(await ov.start(src)).toEqual({ state: 'starting', reason: null });
    expect(regCalls).toEqual([['query', OPENXR_IMPLICIT_LAYERS_KEY], registerArgs(JSON_PATH)]);
    expect(log.some((l) => l.includes('registered now') && l.includes('restart'))).toBe(true);
    expect(pipes).toHaveLength(1);
    expect(pipes[0]!.path).toBe(VR_LAYER_PIPE);
    push(frame(3)); // before the connection: held
    pipes[0]!.answer();
    expect(ov.status()).toEqual({ state: 'showing', reason: null });
    expect(pipes[0]!.tags()).toEqual([3]);
    push(frame(4));
    expect(pipes[0]!.tags()).toEqual([3, 4]);
    expect(states.map((s) => s.state)).toEqual(['starting', 'showing']);
  });

  it('removes other registrations of the same json name and keeps unrelated layers', async () => {
    const old = 'C:\\code\\castcade\\vr-layer\\build\\Release\\XrApiLayer_castcade_panel.json';
    const toolkit = 'C:\\Program Files\\OpenXR-Toolkit\\XR_APILAYER_MBUCCHIA_toolkit.json';
    const query = `\r\nHKEY_CURRENT_USER\\x\r\n    ${old}    REG_DWORD    0x0\r\n    ${toolkit}    REG_DWORD    0x0\r\n    ${JSON_PATH}    REG_DWORD    0x0\r\n`;
    const { ov, regCalls, src, log } = setup({ query });
    await ov.start(src);
    expect(regCalls).toEqual([['query', OPENXR_IMPLICIT_LAYERS_KEY], deleteArgs(old), registerArgs(JSON_PATH)]);
    expect(log.some((l) => l.includes(`removed an older registration ${old}`))).toBe(true);
    expect(log.some((l) => l.startsWith(`vr-layer: registered ${JSON_PATH}`))).toBe(true);
  });

  it('a registration the player disabled (1) stays: unavailable layer_disabled, no pipe', async () => {
    const { ov, regCalls, pipes, src, listeners } = setup({ query: `    ${JSON_PATH}    REG_DWORD    0x1\r\n` });
    expect(await ov.start(src)).toEqual({ state: 'unavailable', reason: 'layer_disabled' });
    expect(regCalls).toEqual([['query', OPENXR_IMPLICIT_LAYERS_KEY]]);
    expect(pipes).toEqual([]);
    expect(listeners()).toBe(0);
  });

  it('retries every 2 s; no answer for 20 s while VPX runs → starting restart_vpx (logged once); still trying, then connects', async () => {
    vi.useFakeTimers();
    const { ov, pipes, src, advance, log } = setup();
    await ov.start(src);
    pipes[0]!.refuse();
    expect(ov.status()).toEqual({ state: 'starting', reason: null });
    advance(CONNECT_RETRY_MS - 1);
    expect(pipes).toHaveLength(1);
    advance(1);
    expect(pipes).toHaveLength(2);
    while (pipes.length * CONNECT_RETRY_MS <= RESTART_VPX_AFTER_MS) {
      pipes.at(-1)!.refuse();
      advance(CONNECT_RETRY_MS);
    }
    expect(ov.status()).toEqual({ state: 'starting', reason: null });
    pipes.at(-1)!.refuse(); // the first failure at or after 20 s
    expect(ov.status()).toEqual({ state: 'starting', reason: 'restart_vpx' });
    advance(CONNECT_RETRY_MS);
    pipes.at(-1)!.refuse();
    expect(log.filter((l) => l.includes('restart VPX'))).toHaveLength(1);
    expect(log.filter((l) => l.includes('waiting for VPX'))).toHaveLength(1);
    advance(CONNECT_RETRY_MS);
    pipes.at(-1)!.answer(); // VPX restarted with the layer
    expect(ov.status()).toEqual({ state: 'showing', reason: null });
  });

  it('VPX not running: no restart_vpx however long it takes; it clears when VPX closes', async () => {
    vi.useFakeTimers();
    const { ov, pipes, src, advance, setVpx } = setup({ vpx: false });
    await ov.start(src);
    for (let i = 0; i < 15; i++) {
      pipes.at(-1)!.refuse();
      advance(CONNECT_RETRY_MS);
    }
    expect(ov.status()).toEqual({ state: 'starting', reason: null });
    setVpx(true);
    pipes.at(-1)!.refuse();
    expect(ov.status().reason).toBe('restart_vpx');
    setVpx(false); // the player closed VPX to restart it
    advance(CONNECT_RETRY_MS);
    pipes.at(-1)!.refuse();
    expect(ov.status()).toEqual({ state: 'starting', reason: null });
  });

  it('the pipe closes while frames continue → hidden pipe_closed; reconnects and the last frame goes up at once', async () => {
    vi.useFakeTimers();
    const { ov, pipes, src, push, advance, states } = setup();
    await ov.start(src);
    pipes[0]!.answer();
    push(frame(1));
    pipes[0]!.hangUp();
    expect(ov.status()).toEqual({ state: 'hidden', reason: 'pipe_closed' });
    push(frame(2)); // no pipe: held
    advance(CONNECT_RETRY_MS);
    expect(pipes).toHaveLength(2);
    pipes[1]!.answer();
    expect(pipes[1]!.tags()).toEqual([2]);
    expect(pipes[0]!.tags()).toEqual([1]);
    expect(states.map((s) => s.state)).toEqual(['starting', 'showing', 'hidden', 'showing']);
    // A connection that went once never says restart_vpx, however long the next wait.
    pipes[1]!.hangUp();
    for (let i = 0; i < 15; i++) {
      advance(CONNECT_RETRY_MS);
      pipes.at(-1)!.refuse();
    }
    expect(ov.status()).toEqual({ state: 'hidden', reason: 'pipe_closed' });
  });

  it('a failed registration still tries the pipe (an earlier registration may stand); after 20 s the reason is register_failed', async () => {
    vi.useFakeTimers();
    const { ov, pipes, src, advance, log } = setup({ failAdd: true });
    expect(await ov.start(src)).toEqual({ state: 'starting', reason: null });
    expect(log.some((l) => l.includes('could not register the layer (ERROR: Access is denied.)'))).toBe(true);
    for (let i = 0; i <= RESTART_VPX_AFTER_MS / CONNECT_RETRY_MS; i++) {
      pipes.at(-1)!.refuse();
      advance(CONNECT_RETRY_MS);
    }
    expect(ov.status()).toEqual({ state: 'starting', reason: 'register_failed' });
  });

  it('stop() closes the pipe, lets the source go, stops retrying; the registry entry stays', async () => {
    vi.useFakeTimers();
    const { ov, pipes, src, regCalls, listeners, advance } = setup();
    await ov.start(src);
    pipes[0]!.answer();
    await ov.stop();
    expect(pipes[0]!.destroyed).toBe(true);
    expect(ov.status()).toEqual({ state: 'stopped', reason: null });
    expect(listeners()).toBe(0);
    pipes[0]!.hangUp(); // the close that follows destroy()
    advance(CONNECT_RETRY_MS * 3);
    expect(pipes).toHaveLength(1);
    expect(regCalls.some((a) => a[0] === 'delete')).toBe(false);
  });

  it('start() again after stop() registers again and reconnects', async () => {
    const { ov, pipes, src, regCalls } = setup();
    await ov.start(src);
    await ov.stop();
    await ov.start(src);
    expect(regCalls.filter((a) => a[0] === 'add')).toHaveLength(2);
    expect(pipes).toHaveLength(2);
    pipes[1]!.answer();
    expect(ov.status().state).toBe('showing');
  });
});
