/**
 * Layer 1 of the stale-sidecar guard (`docs/design/table-import-and-patching.md` §6): the companion
 * is a tray app, so it watches the tables folder. A `.vpx` whose size or mtime changed since the
 * last look (a table update dropped over the old file) is checked against its manifest; a stale
 * sidecar is re-rendered when the new script still classifies as recipe A, else disabled, and the
 * player is told either way. The first look after start checks every patched table, because the
 * companion may not have been running when the file changed.
 *
 * Polling, not `fs.watch`: a folder of a hundred tables is a hundred stats every interval, which is
 * nothing, and Windows change notifications miss in-place rewrites by some downloaders.
 */
import { realClock, type Clock, type TimerHandle } from '../match/clock.js';
import { applyImport, checkSidecar, disableSidecar, listVpxFiles, planImport, sidecarPathFor, tableIdFor, type SidecarCheck } from '../patcher/index.js';
import { isNotFound, nodeFs, type WitnessFs } from '../witness/fs.js';

export const DEFAULT_SIDECAR_WATCH_MS = 30_000;

export interface SidecarWatchOptions {
  fs?: WitnessFs;
  clock?: Clock;
  intervalMs?: number;
  /** The folder to watch right now (the setting, else beside the VPX exe); null = nothing known yet. */
  tablesDir: () => string | null;
  /** The VPX `scripts\` folder, needed to re-render (the library is re-installed if it drifted); null = disable only. */
  scriptsDir: () => string | null;
  manifestDir: string;
  libSource: string;
  /** The hook's watch list for a ROM (see `TablesHost.watchOffsetsFor`); omitted = no watch list rendered. */
  watchOffsetsFor?: (rom: string) => Promise<number[]>;
  log: (line: string) => void;
  /** Tell the player (a desktop notification in the shell). */
  notify?: (title: string, body: string) => void;
}

export type SidecarWatchOutcome = { vpxPath: string; result: 'repatched' | 'disabled' | 'ok' | 'error'; detail: string };

interface Seen {
  size: number;
  mtimeMs: number;
}

export class SidecarWatch {
  private readonly fs: WitnessFs;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private seen = new Map<string, Seen>();
  private primed = false;
  private timer: TimerHandle | null = null;
  private running = false;
  private ticking: Promise<SidecarWatchOutcome[]> | null = null;

  constructor(private readonly opts: SidecarWatchOptions) {
    this.fs = opts.fs ?? nodeFs;
    this.clock = opts.clock ?? realClock;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SIDECAR_WATCH_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** After an import or a remove-all the folder is as the player wants it: forget what changed. */
  reset(): void {
    this.seen.clear();
    this.primed = false;
  }

  /** One look at the folder; returns what was done. Safe to call while running. */
  tick(): Promise<SidecarWatchOutcome[]> {
    if (this.ticking) return this.ticking;
    this.ticking = this.look().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.tick()
        .catch((err: unknown) => this.opts.log(`sidecar watch: ${err instanceof Error ? err.message : String(err)}`))
        .then(() => this.schedule(this.intervalMs));
    }, ms);
  }

  private async look(): Promise<SidecarWatchOutcome[]> {
    const dir = this.opts.tablesDir();
    if (!dir) return [];
    let files: string[];
    try {
      files = await listVpxFiles(this.fs, dir, true);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const next = new Map<string, Seen>();
    const changed: string[] = [];
    for (const path of files) {
      let st: Seen;
      try {
        const s = await this.fs.stat(path);
        st = { size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        continue;
      }
      next.set(path, st);
      const prev = this.seen.get(path);
      if (!this.primed) {
        // First look: every table that has a sidecar beside it is checked once.
        if (await this.hasSidecar(path)) changed.push(path);
      } else if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
        changed.push(path);
      }
    }
    this.seen = next;
    this.primed = true;
    const outcomes: SidecarWatchOutcome[] = [];
    for (const path of changed) outcomes.push(await this.handle(path));
    return outcomes.filter((o) => o.result !== 'ok');
  }

  private async hasSidecar(vpxPath: string): Promise<boolean> {
    try {
      await this.fs.stat(sidecarPathFor(vpxPath));
      return true;
    } catch {
      return false;
    }
  }

  private async handle(vpxPath: string): Promise<SidecarWatchOutcome> {
    const tableId = tableIdFor(vpxPath);
    let check: SidecarCheck;
    try {
      check = await checkSidecar(this.fs, vpxPath, this.opts.manifestDir);
    } catch (err) {
      return { vpxPath, result: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
    if (check.state !== 'stale') return { vpxPath, result: 'ok', detail: check.state };
    this.opts.log(`sidecar watch: ${tableId} is stale (${check.why})`);
    const scriptsDir = this.opts.scriptsDir();
    try {
      if (scriptsDir) {
        const plan = await planImport(this.fs, { paths: [vpxPath], manifestDir: this.opts.manifestDir });
        const item = plan.items[0];
        if (item && (item.action === 'repatch' || item.action === 'patch')) {
          const applied = await applyImport(this.fs, plan, {
            manifestDir: this.opts.manifestDir,
            vpxScriptsDir: scriptsDir,
            libSource: this.opts.libSource,
            ...(this.opts.watchOffsetsFor ? { watchOffsetsFor: this.opts.watchOffsetsFor } : {}),
          });
          const failure = applied.failed[0];
          if (!failure) {
            const detail = `${tableId} changed on disk; its Castcade patch was re-made for the new version`;
            this.opts.log(`sidecar watch: ${detail}`);
            this.opts.notify?.('Castcade re-patched a table', detail);
            return { vpxPath, result: 'repatched', detail };
          }
          this.opts.log(`sidecar watch: re-patch of ${tableId} failed: ${failure.error}`);
        }
      }
      const stalePath = await disableSidecar(this.fs, vpxPath);
      const detail = `${tableId} changed on disk and its Castcade patch no longer fits; it was disabled (${stalePath}). Re-import the table from Castcade.`;
      this.opts.log(`sidecar watch: ${detail}`);
      this.opts.notify?.('Castcade patch disabled', detail);
      return { vpxPath, result: 'disabled', detail };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.opts.log(`sidecar watch: ${tableId}: ${detail}`);
      return { vpxPath, result: 'error', detail };
    }
  }
}
