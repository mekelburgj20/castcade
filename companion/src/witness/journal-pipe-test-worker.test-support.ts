/**
 * C16.2 test entry: the journal pipe's worker with faults injected. The real server (`serveJournalPipe`) behind a file
 * writer whose first `stallWrites` writes each wait `stallMs` first (a slow disk), and, with `exitAfterMs`, a worker that
 * dies that long after it listens (the restart); everything else is the production worker.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { nodeJournalFiles, serveJournalPipe, type JournalFiles, type JournalPipeWorkerData } from './journal-pipe-server.js';

const data = workerData as JournalPipeWorkerData & { stallMs?: number; stallWrites?: number; exitAfterMs?: number };
let stalls = 0;
const slowDisk: JournalFiles = {
  async open(path) {
    const file = await nodeJournalFiles.open(path);
    return {
      async write(bytes) {
        if (stalls < (data.stallWrites ?? 0)) {
          stalls++;
          parentPort?.postMessage({ type: 'note', detail: `test: write ${stalls} stalls ${data.stallMs ?? 0} ms` });
          await new Promise((r) => setTimeout(r, data.stallMs ?? 0));
        }
        await file.write(bytes);
      },
      close: () => file.close(),
    };
  },
};

if (parentPort) {
  const server = serveJournalPipe(parentPort, data, slowDisk);
  if (data.exitAfterMs !== undefined) void server.listening.then(() => setTimeout(() => process.exit(3), data.exitAfterMs));
}
