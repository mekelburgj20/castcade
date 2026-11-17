/**
 * C16.2: the journal pipe's worker thread (`journal-pipe.ts` starts it). It does one thing: drain the hooks' pipe into
 * the journal files (`journal-pipe-server.ts`), so a busy or blocked main thread never leaves a hook's `WriteLine`
 * waiting.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { serveJournalPipe, type JournalPipeWorkerData } from './journal-pipe-server.js';

if (parentPort) serveJournalPipe(parentPort, workerData as JournalPipeWorkerData);
