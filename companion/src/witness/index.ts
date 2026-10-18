/**
 * STUB — discarded at merge. The real `witness` module is implemented in parallel against
 * `./types.ts`; this file exists only so the Electron shell compiles and can be exercised in the
 * worktree. It keeps everything in memory and does no I/O, no networking, no process watching.
 */
import type { Witness, WitnessEvents, WitnessSettingsStore, WitnessStatus } from './types.js';

export type { Witness, WitnessEvents, WitnessSettingsStore, WitnessStatus } from './types.js';

export function createWitness(store: WitnessSettingsStore, _deps?: unknown): Witness {
  const listeners: { [K in keyof WitnessEvents]: Set<WitnessEvents[K]> } = {
    status: new Set(),
    launch: new Set(),
    exit: new Set(),
    capture: new Set(),
    error: new Set(),
  };
  const status: WitnessStatus = {
    paired: store.get().token !== null,
    running: false,
    vpxExe: null,
    nvramDir: store.get().nvramDir,
    mapsVersion: 'stub',
    currentTable: null,
    lastCapture: null,
    queued: 0,
    lastHeartbeatAt: null,
    lastError: null,
  };
  const emitStatus = (): void => {
    for (const l of listeners.status) l({ ...status });
  };
  return {
    async start() {
      status.running = true;
      status.nvramDir = store.get().nvramDir;
      status.lastHeartbeatAt = new Date().toISOString();
      emitStatus();
    },
    async stop() {
      status.running = false;
      emitStatus();
    },
    async pair(code: string) {
      if (!/^[A-Za-z0-9]{6}$/.test(code)) throw new Error('pairing code must be 6 characters');
      await store.set({ token: `stub-token-${code.toUpperCase()}` });
      status.paired = true;
      emitStatus();
    },
    async unpair() {
      await store.set({ token: null });
      status.paired = false;
      emitStatus();
    },
    status: () => ({ ...status }),
    on(event, listener) {
      const set = listeners[event] as Set<typeof listener>;
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
}
