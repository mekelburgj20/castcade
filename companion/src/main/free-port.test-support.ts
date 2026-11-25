/**
 * Test support (2026-11-24): the one way a test gets a TCP port.
 *
 * A test must not pick a port number itself. `41000 + random` and its like failed in two ways that had nothing to do
 * with the code under test: Windows keeps port ranges of its own that change at every boot (`netsh interface ipv4 show
 * excludedportrange protocol=tcp`; a bind inside one fails with EACCES: five tests of one run on the dev PC, and the
 * Windows CI job), and two test files running at once can draw the same number (EADDRINUSE).
 *
 * In order of preference:
 * 1. Bind port 0 and read back the port the system gave. Every listener of the companion's tests can: the match host
 *    through its `ephemeralPort` seam (`host({ port: 0 })`, the port is in the status and in the invite), the
 *    transports (`listen(0)`), the relay double.
 * 2. Where the number must be known before the bind (a test that connects to the port while the listener is not up
 *    yet, a restart that must come back on a port named up front): `withFreePort`, which asks the system for a port
 *    that is free now and, when the bind still fails because of the port, asks for another and runs the body again.
 *    `freePort` alone is for a body that cannot be run twice.
 *
 * A port the system hands out is never inside a range Windows excludes, so what is left is the moment between
 * `freePort` releasing the port and the test binding it, in which another process can take it: that is what the
 * retry is for.
 */
import { createServer } from 'node:net';

/** A TCP port the system says is free on `host` now: bound on port 0, read, released. */
export function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ host, port: 0 }, () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => (port > 0 ? resolve(port) : reject(new Error('the system gave no port'))));
    });
  });
}

/**
 * The bind failed because of the port, not because of the code under test: Node's own error (`code`), or one that
 * quotes it (the match host says "Port N is already in use on this PC" and "Could not listen on port N: ... EACCES").
 */
export function portRefused(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'EADDRINUSE' || code === 'EACCES') return true;
  const text = e instanceof Error ? e.message : '';
  return /\b(EADDRINUSE|EACCES)\b|\bPort \d+ is already in use\b/.test(text);
}

/**
 * Run `body` with a port that is free now. When it throws because the port was refused after all (`portRefused`),
 * run it again with another port, `tries` times in all; any other error is the test's and is thrown at once. The
 * body must clean up after its own failed bind (a match host does: a failed `host()` leaves nothing behind).
 */
export async function withFreePort<T>(body: (port: number) => Promise<T>, o: { host?: string; tries?: number } = {}): Promise<T> {
  const tries = Math.max(1, o.tries ?? 5);
  for (let k = 1; ; k++) {
    const port = await freePort(o.host);
    try {
      return await body(port);
    } catch (e) {
      if (k >= tries || !portRefused(e)) throw e;
    }
  }
}
