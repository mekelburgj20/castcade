/**
 * C16.2 test support: the journal pipe's worker run from its TypeScript source on a real worker thread (tsx registered in
 * that thread), so the tests exercise the code the build ships, not a copy and not a stale `dist`.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;

/** `workerUrl` + `execArgv` for `startJournalPipe` (or a bare `Worker`): the production entry, or a test entry beside it. */
export function tsWorker(entry = './journal-pipe-worker.ts'): { workerUrl: URL; execArgv: string[] } {
  return { workerUrl: new URL(entry, import.meta.url), execArgv: ['--import', TSX] };
}

let n = 0;
/** A pipe name no Castcade and no other test uses (never `\\.\pipe\castcade-journal`). */
export function testPipeName(tag: string): string {
  return `\\\\.\\pipe\\castcade-test-${tag}-${process.pid}-${++n}`;
}
