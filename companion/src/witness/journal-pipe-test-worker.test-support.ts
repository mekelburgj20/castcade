/**
 * C16.2 test entry: the journal pipe's worker with faults injected. The real server (`serveJournalPipe`) behind a file
 * writer whose first `stallWrites` writes are each held back first (a slow disk), and, with `exitAfterMs`, a worker that
 * dies that long after it listens (the restart); everything else is the production worker.
 *
 * How long a write is held (2026-11-24): for `stallMs`, counted from the write, or, with `stallUntilDrains`, from the
 * moment the main thread asked this worker to drain that many times. The second is for a test that must find the
 * write still stuck when it asks: a fixed 1.5 s from the write was also a deadline for the test's own steps before its
 * first ask (the hook's pipe closing, which on Windows waits for a thread of the pool), and a busy PC can miss it.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { nodeJournalFiles, serveJournalPipe, type JournalFiles, type JournalPipeCommand, type JournalPipeWorkerData } from './journal-pipe-server.js';

const data = workerData as JournalPipeWorkerData & { stallMs?: number; stallWrites?: number; stallUntilDrains?: number; exitAfterMs?: number };
let stalls = 0;
let drains = 0;
let drainWaiters: { n: number; done: () => void }[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Resolves once the main thread has asked for `n` drains (at once when it already has). */
const drainsAsked = (n: number): Promise<void> => (drains >= n ? Promise.resolve() : new Promise((done) => drainWaiters.push({ n, done })));
const slowDisk: JournalFiles = {
  async open(path) {
    const file = await nodeJournalFiles.open(path);
    return {
      async write(bytes) {
        if (stalls < (data.stallWrites ?? 0)) {
          stalls++;
          const until = data.stallUntilDrains;
          parentPort?.postMessage({ type: 'note', detail: `test: write ${stalls} stalls ${data.stallMs ?? 0} ms${until !== undefined ? ` from drain request ${until}` : ''}` });
          if (until !== undefined) await drainsAsked(until);
          await sleep(data.stallMs ?? 0);
        }
        await file.write(bytes);
      },
      close: () => file.close(),
    };
  },
};

if (parentPort) {
  // Counted in the same message event the server answers the drain in, so `stallMs` after it is also the least the
  // server reports having waited for that drain.
  parentPort.on('message', (m: JournalPipeCommand) => {
    if (m.type !== 'drain') return;
    drains++;
    const due = drainWaiters.filter((w) => drains >= w.n);
    drainWaiters = drainWaiters.filter((w) => drains < w.n);
    for (const w of due) w.done();
  });
  const server = serveJournalPipe(parentPort, data, slowDisk);
  if (data.exitAfterMs !== undefined) void server.listening.then(() => setTimeout(() => process.exit(3), data.exitAfterMs));
}
