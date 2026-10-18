/**
 * Library entry of the companion: the pure match engine (host arbiter, client state machine,
 * log, keys, transports). The Electron process entry is `src/main/index.ts`; it must never be
 * imported from here, so `fakeclient/` and tests can use the engine without Electron.
 */
export * from './match/index.js';
