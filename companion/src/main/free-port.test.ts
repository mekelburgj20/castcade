/**
 * 2026-11-24: the tests' own port helper (`free-port.test-support.ts`): a port the system gives can be bound, a bind
 * refused because of the port is tried again on another one, and nothing else is.
 */
import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { freePort, portRefused, withFreePort } from './free-port.test-support.js';

const listen = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

describe('free-port test support', () => {
  it('freePort: a port that can be bound right away', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThanOrEqual(1024);
    const s = await listen(port);
    expect((s.address() as { port: number }).port).toBe(port);
    await close(s);
  });

  it('portRefused: Node\'s own errors and the match host\'s sentences about them, nothing else', () => {
    expect(portRefused(Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:41000'), { code: 'EADDRINUSE' }))).toBe(true);
    expect(portRefused(Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:51950'), { code: 'EACCES' }))).toBe(true);
    expect(portRefused(new Error('Port 41000 is already in use on this PC: pick another port'))).toBe(true);
    expect(portRefused(new Error('Could not listen on port 51950: Error: listen EACCES: permission denied 127.0.0.1:51950'))).toBe(true);
    expect(portRefused(new Error('expected 1 to be 2'))).toBe(false);
    expect(portRefused(new Error('The port must be a number from 1024 to 65535'))).toBe(false);
    expect(portRefused('EADDRINUSE')).toBe(false);
  });

  it('withFreePort: a port that turns out to be taken is replaced and the body runs again; a real bind decides', async () => {
    const blocker = await listen(0);
    const taken = (blocker.address() as { port: number }).port;
    const tried: number[] = [];
    try {
      const s = await withFreePort(async (port) => {
        tried.push(port);
        // The first port "was taken meanwhile": the bind is made on the blocker's port and fails as Node fails it.
        return listen(tried.length === 1 ? taken : port);
      });
      expect(tried).toHaveLength(2);
      expect((s.address() as { port: number }).port).toBe(tried[1]);
      await close(s);
    } finally {
      await close(blocker);
    }
  });

  it("withFreePort: an error that is not about the port is the test's, thrown at once; a port refused every time is thrown after the last try", async () => {
    let runs = 0;
    await expect(
      withFreePort(async () => {
        runs++;
        throw new Error('expected 1 to be 2');
      }),
    ).rejects.toThrow('expected 1 to be 2');
    expect(runs).toBe(1);
    runs = 0;
    await expect(
      withFreePort(
        async (port) => {
          runs++;
          throw new Error(`Port ${port} is already in use on this PC: pick another port`);
        },
        { tries: 3 },
      ),
    ).rejects.toThrow(/is already in use/);
    expect(runs).toBe(3);
  });
});
