/**
 * Owns the one `Witness` instance for the process: creates it from the settings store, forwards
 * its events to the log and to status listeners, pauses/resumes, and recreates it when a setting
 * the module reads at start (ArcAid URL, nvram dir) changes. The shell talks to this, never to the
 * module directly, so recreation never leaks a stale instance into IPC handlers.
 */
import { createWitness } from '../witness/index.js';
import type { Witness, WitnessSettings, WitnessStatus, WitnessNotice } from '../witness/types.js';
import type { Logger } from './log.js';
import type { SettingsStore } from './settings.js';
import { describeError } from './log.js';

export interface WitnessHost {
  status(): WitnessStatus;
  pair(code: string): Promise<WitnessStatus>;
  unpair(): Promise<WitnessStatus>;
  confirmTable(filePath: string, vpsTableId: string | null): Promise<WitnessStatus>;
  /** Pause = stop watching (status.running false) without forgetting anything. */
  setPaused(paused: boolean): Promise<WitnessStatus>;
  isPaused(): boolean;
  /** Stop + recreate + start (unless paused). Used after arcaidBaseUrl / nvramDir change. */
  restart(reason: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  onStatus(listener: (status: WitnessStatus) => void): () => void;
  /** Player-facing notices (the shell shows a desktop notification). */
  onNotice(listener: (notice: WitnessNotice) => void): () => void;
}

/** Which settings require a restart of the module when they change. */
export function needsWitnessRestart(prev: WitnessSettings, next: WitnessSettings): boolean {
  return prev.arcaidBaseUrl !== next.arcaidBaseUrl || prev.nvramDir !== next.nvramDir;
}

export function createWitnessHost(store: SettingsStore, log: Logger): WitnessHost {
  const statusListeners = new Set<(status: WitnessStatus) => void>();
  let paused = false;
  let unsubscribe: Array<() => void> = [];
  const deps = { log: (line: string) => log.info(line) };
  let witness: Witness = attach(createWitness(store, deps));

  let lastCheckin: string | null = null;
  const noticeListeners = new Set<(n: WitnessNotice) => void>();

  function attach(w: Witness): Witness {
    for (const off of unsubscribe) off();
    unsubscribe = [
      w.on('status', (s) => {
        if (s.lastCheckinAt && s.lastCheckinAt !== lastCheckin) {
          lastCheckin = s.lastCheckinAt;
          log.info(`witness: checked in${s.sendingTo ? ` → ${s.sendingTo}` : ' (no routing line from ArcAid)'}`);
        }
        for (const l of statusListeners) l(s);
      }),
      w.on('launch', (i) => {
        log.info(`witness: launch ${i.table} (${i.exe}, pid ${i.pid})`);
        // Remember where VPX lives so the import can find scripts\ on the next run without a launch.
        if (i.exe && store.get().vpxExe !== i.exe) void store.set({ vpxExe: i.exe }).catch((err: unknown) => log.warn(`settings: could not remember the VPX exe: ${err instanceof Error ? err.message : String(err)}`));
      }),
      w.on('notice', (n) => {
        log.info(`witness: notice ${n.kind}: ${n.message}`);
        for (const l of noticeListeners) l(n);
      }),
      w.on('exit', (i) => log.info(`witness: exit ${i.table} after ${i.durationSec}s`)),
      w.on('capture', (c) =>
        log.info(
          `witness: capture ${c.table} rom=${c.rom ?? '-'} players=${c.players} score=${c.score ?? '-'} ` +
            `outcome=${c.outcome}${c.detail ? ` (${c.detail})` : ''}`,
        ),
      ),
      w.on('error', (m) => log.error(`witness: ${m}`)),
    ];
    return w;
  }

  const broadcast = (): void => {
    const s = witness.status();
    for (const l of statusListeners) l(s);
  };

  return {
    status: () => witness.status(),
    async pair(code) {
      await witness.pair(code.trim().toUpperCase());
      log.info('witness: paired');
      broadcast();
      return witness.status();
    },
    async unpair() {
      await witness.unpair();
      log.info('witness: unpaired');
      broadcast();
      return witness.status();
    },
    async confirmTable(filePath, vpsTableId) {
      await witness.confirmTable(filePath, vpsTableId);
      log.info(`witness: table confirmed ${vpsTableId ?? '(forgotten)'} for ${filePath}`);
      broadcast();
      return witness.status();
    },
    isPaused: () => paused,
    async setPaused(next) {
      if (next === paused) return witness.status();
      paused = next;
      if (paused) {
        await witness.stop();
        log.info('witness: paused');
      } else {
        await witness.start();
        log.info('witness: resumed');
      }
      broadcast();
      return witness.status();
    },
    async start() {
      if (paused) return;
      try {
        await witness.start();
        log.info('witness: started');
      } catch (e) {
        log.error(`witness: start failed: ${describeError(e)}`);
      }
      broadcast();
    },
    async stop() {
      try {
        await witness.stop();
      } catch (e) {
        log.error(`witness: stop failed: ${describeError(e)}`);
      }
    },
    async restart(reason) {
      log.info(`witness: restarting (${reason})`);
      try {
        await witness.stop();
      } catch (e) {
        log.error(`witness: stop before restart failed: ${describeError(e)}`);
      }
      witness = attach(createWitness(store, deps));
      if (!paused) {
        try {
          await witness.start();
        } catch (e) {
          log.error(`witness: start after restart failed: ${describeError(e)}`);
        }
      }
      broadcast();
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => {
        noticeListeners.delete(listener);
      };
    },
  };
}
