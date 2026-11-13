/**
 * Owns the one `Witness` instance for the process: creates it from the settings store, forwards
 * its events to the log and to status listeners, pauses/resumes, and recreates it when a setting
 * the module reads at start (ArcAid URL, nvram dir) changes. The shell talks to this, never to the
 * module directly, so recreation never leaks a stale instance into IPC handlers. A recreation hands the
 * new instance the old one's journal mark (A15), so a match is not fed the game in progress twice.
 */
import { createWitness, DEFAULT_ROM_MAP_REFRESH_MS, DEFAULT_VPS_REFRESH_MS, type WitnessDeps } from '../witness/index.js';
import type { JournalMark, LastCapture, LiveGame, Witness, WitnessSettings, WitnessStatus, WitnessNotice } from '../witness/types.js';
import type { GameEvent } from '../witness/journal-detector.js';
import type { VrObservation } from '../witness/vr-detect.js';
import type { Logger } from './log.js';
import type { SettingsStore } from './settings.js';
import { describeError } from './log.js';

export interface WitnessHost {
  status(): WitnessStatus;
  pair(code: string): Promise<WitnessStatus>;
  unpair(): Promise<WitnessStatus>;
  confirmTable(filePath: string, vpsTableId: string | null): Promise<WitnessStatus>;
  /** B21: press "Start attempts" on ArcAid for the loaded table (or every start-required table this device routes to). */
  startAttempts(): Promise<WitnessStatus>;
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
  /** D1.1: the game on screen (live mode), for the OBS overlay. */
  liveGame(): LiveGame | null;
  /** A6 (2026-10-31): VR probed on the running VPX process now (null: no VPX open, or no answer). For the match rig. */
  sampleVr(): Promise<VrObservation | null>;
  onGame(listener: (game: LiveGame | null) => void): () => void;
  /** D1.2: every capture (posted, queued, skipped), so a recording can tie the score to its segment. */
  onCapture(listener: (capture: LastCapture) => void): () => void;
  /**
   * A6 (2026-10-30): every detector game event of the live session, plus `table_exit` when the VPX process ends,
   * for the match controller. A15: `meta.backlog`: the event was in the journal before the witness began to read it
   * (Castcade started while the table was open); `meta.mark`: where in the journal it is, null for `table_exit`.
   */
  onEvent(listener: (event: GameEvent | { kind: 'table_exit' }, meta?: WitnessEventMeta) => void): () => void;
  /** A15: how far into the open table's journal the game events were delivered (`Witness.journalMark`). */
  journalMark?(): JournalMark | null;
  /** D2.8 (2026-11-01): the pid of the VPX the witness last saw launch, until it exits; null when none runs. */
  vpxPid?(): number | null;
  /** D7.3.3 (2026-11-02): that VPX's process start, epoch ms (the process watch's own query); null when unknown or none runs. */
  vpxStartedAt?(): number | null;
}

/** A15: what `onEvent` says about an event beside the event itself. */
export interface WitnessEventMeta {
  backlog: boolean;
  mark: JournalMark | null;
}

/** Which settings require a restart of the module when they change. */
export function needsWitnessRestart(prev: WitnessSettings, next: WitnessSettings): boolean {
  return prev.arcaidBaseUrl !== next.arcaidBaseUrl || prev.nvramDir !== next.nvramDir;
}

/** `overrides`: the module's dependencies for a test (a memory file system, a scripted process list); the shell passes none. */
export function createWitnessHost(store: SettingsStore, log: Logger, overrides: Partial<WitnessDeps> = {}): WitnessHost {
  const statusListeners = new Set<(status: WitnessStatus) => void>();
  let paused = false;
  let unsubscribe: Array<() => void> = [];
  // B8: ArcAid's ROM → VPS game map, fetched at start and daily; B24: the VPS index itself, rebuilt from vps-db daily.
  // Both module defaults are off for its tests.
  const deps: WitnessDeps = { log: (line: string) => log.info(line), romMapRefreshMs: DEFAULT_ROM_MAP_REFRESH_MS, vpsRefreshMs: DEFAULT_VPS_REFRESH_MS, ...overrides };
  /** D2.8: the running VPX's pid (the table-sound helper's fallback when the match capture has no window). */
  let launchPid: number | null = null;
  /** D7.3.3: its process start (the OpenXR layer's "VPX predates the registration" rule). */
  let launchStartedAt: number | null = null;
  let witness: Witness = attach(createWitness(store, deps));

  let lastCheckin: string | null = null;
  const noticeListeners = new Set<(n: WitnessNotice) => void>();
  const gameListeners = new Set<(g: LiveGame | null) => void>();
  const captureListeners = new Set<(c: LastCapture) => void>();
  const eventListeners = new Set<(e: GameEvent | { kind: 'table_exit' }, meta?: WitnessEventMeta) => void>();

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
        launchPid = i.pid;
        launchStartedAt = i.startedAt;
        // Remember where VPX lives so the import can find scripts\ on the next run without a launch.
        if (i.exe && store.get().vpxExe !== i.exe) void store.set({ vpxExe: i.exe }).catch((err: unknown) => log.warn(`settings: could not remember the VPX exe: ${err instanceof Error ? err.message : String(err)}`));
      }),
      w.on('notice', (n) => {
        log.info(`witness: notice ${n.kind}: ${n.message}`);
        for (const l of noticeListeners) l(n);
      }),
      w.on('exit', (i) => {
        log.info(`witness: exit ${i.table} after ${i.durationSec}s`);
        launchPid = null;
        launchStartedAt = null;
        for (const l of eventListeners) l({ kind: 'table_exit' }, { backlog: false, mark: null });
      }),
      w.on('capture', (c) => {
        log.info(
          `witness: capture ${c.table} rom=${c.rom ?? '-'} players=${c.players} score=${c.score ?? '-'} ` +
            `outcome=${c.outcome}${c.detail ? ` (${c.detail})` : ''}`,
        );
        for (const l of captureListeners) l(c);
      }),
      w.on('error', (m) => log.error(`witness: ${m}`)),
      w.on('game', (g) => {
        for (const l of gameListeners) l(g);
      }),
      w.on('event', (e) => {
        const meta: WitnessEventMeta = { backlog: w.deliveringBacklog(), mark: w.journalMark() };
        for (const l of eventListeners) l(e, meta);
      }),
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
    // The module logs the answer (or the failure) and emits the status itself.
    startAttempts: () => witness.startAttempts(),
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
      // A15: the new witness reads the open table's journal again from the top; what the old one already delivered
      // (to a match: turns passed, a game started) is not delivered a second time.
      witness = attach(createWitness(store, { ...deps, resume: witness.journalMark() }));
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
    liveGame: () => witness.liveGame(),
    sampleVr: () => witness.sampleVr(),
    onGame(listener) {
      gameListeners.add(listener);
      return () => {
        gameListeners.delete(listener);
      };
    },
    onCapture(listener) {
      captureListeners.add(listener);
      return () => {
        captureListeners.delete(listener);
      };
    },
    journalMark: () => witness.journalMark(),
    vpxPid: () => launchPid,
    vpxStartedAt: () => launchStartedAt,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
  };
}
