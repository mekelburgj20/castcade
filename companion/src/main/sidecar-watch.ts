/**
 * Layer 1 of the stale-sidecar guard (`docs/design/table-import-and-patching.md` §6): the companion
 * is a tray app, so it watches the tables folder. A `.vpx` whose size or mtime changed since the
 * last look (a table update dropped over the old file) is checked against its manifest; a stale
 * sidecar is re-rendered when the new script still classifies as recipe A, else disabled, and the
 * player is told either way. The first look after start checks every patched table, because the
 * companion may not have been running when the file changed, and because a new companion build
 * (a newer hook library or recipe) makes every sidecar stale at once: those are re-made as one
 * batch with one notification, not a hundred.
 *
 * Every look runs under the tables host's lock (`exclusive`), so it never interleaves with an
 * import or a remove-all the player started from the Settings card (2026-10-22: both re-patched
 * the same folder at the same time and the card reported a nonsense count).
 *
 * Polling, not `fs.watch`: a folder of a hundred tables is a hundred stats every interval, which is
 * nothing, and Windows change notifications miss in-place rewrites by some downloaders.
 */
import { realClock, type Clock, type TimerHandle } from '../match/clock.js';
import { LIB_VERSION, applyImport, checkSidecar, disableSidecar, listVpxFiles, planImport, sidecarPathFor, tableIdFor } from '../patcher/index.js';
import { isNotFound, nodeFs, type WitnessFs } from '../witness/fs.js';

export const DEFAULT_SIDECAR_WATCH_MS = 30_000;

export type Exclusive = <T>(fn: () => Promise<T>) => Promise<T>;

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
  /** The lock shared with the import / remove-all actions (`TablesHost.exclusive`); omitted = unlocked (tests). */
  exclusive?: Exclusive;
  log: (line: string) => void;
  /** Tell the player (a desktop notification in the shell). */
  notify?: (title: string, body: string) => void;
}

export type SidecarWatchOutcome = { vpxPath: string; result: 'repatched' | 'disabled' | 'ok' | 'error'; detail: string };

interface Seen {
  size: number;
  mtimeMs: number;
}

interface Stale {
  vpxPath: string;
  tableId: string;
  kind: 'version' | 'changed';
  why: string;
}

const unlocked: Exclusive = (fn) => fn();

export class SidecarWatch {
  private readonly fs: WitnessFs;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly exclusive: Exclusive;
  private seen = new Map<string, Seen>();
  private primed = false;
  private timer: TimerHandle | null = null;
  private running = false;
  private ticking: Promise<SidecarWatchOutcome[]> | null = null;

  constructor(private readonly opts: SidecarWatchOptions) {
    this.fs = opts.fs ?? nodeFs;
    this.clock = opts.clock ?? realClock;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SIDECAR_WATCH_MS;
    this.exclusive = opts.exclusive ?? unlocked;
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

  /** One look at the folder (under the lock); returns what was done. Safe to call while running. */
  tick(): Promise<SidecarWatchOutcome[]> {
    if (this.ticking) return this.ticking;
    this.ticking = this.exclusive(() => this.look()).finally(() => {
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
    if (changed.length === 0) return [];

    const outcomes: SidecarWatchOutcome[] = [];
    const stale: Stale[] = [];
    for (const vpxPath of changed) {
      const tableId = tableIdFor(vpxPath);
      try {
        const check = await checkSidecar(this.fs, vpxPath, this.opts.manifestDir);
        if (check.state === 'stale') stale.push({ vpxPath, tableId, kind: check.kind, why: check.why });
      } catch (err) {
        outcomes.push({ vpxPath, result: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    }
    if (stale.length > 0) outcomes.push(...(await this.fix(stale)));
    return outcomes;
  }

  private async hasSidecar(vpxPath: string): Promise<boolean> {
    try {
      await this.fs.stat(sidecarPathFor(vpxPath));
      return true;
    } catch {
      return false;
    }
  }

  /** Re-make every stale sidecar in one import run (library installed once), disable what no longer fits, tell the player once. */
  private async fix(stale: Stale[]): Promise<SidecarWatchOutcome[]> {
    for (const s of stale) this.opts.log(`sidecar watch: ${s.tableId} is stale (${s.why})`);
    const scriptsDir = this.opts.scriptsDir();
    const remade = new Set<string>();
    if (scriptsDir) {
      try {
        const plan = await planImport(this.fs, { paths: stale.map((s) => s.vpxPath), manifestDir: this.opts.manifestDir });
        const applied = await applyImport(this.fs, plan, {
          manifestDir: this.opts.manifestDir,
          vpxScriptsDir: scriptsDir,
          libSource: this.opts.libSource,
          ...(this.opts.watchOffsetsFor ? { watchOffsetsFor: this.opts.watchOffsetsFor } : {}),
          onProgress: (done, total, item) => this.opts.log(`sidecar watch: ${done}/${total} ${item.tableId} re-made`),
        });
        for (const p of applied.patched) remade.add(p);
        for (const f of applied.failed) this.opts.log(`sidecar watch: re-patch of ${f.item.tableId} failed: ${f.error}`);
        if (applied.libInstalled !== 'unchanged') this.opts.log(`sidecar watch: library ${applied.libInstalled} in ${scriptsDir}`);
      } catch (err) {
        // Nothing was re-made and nothing is disabled: the sidecars stay as they were and the next look tries again.
        const detail = err instanceof Error ? err.message : String(err);
        this.opts.log(`sidecar watch: re-patch failed before any table was touched: ${detail}`);
        return stale.map((s) => ({ vpxPath: s.vpxPath, result: 'error', detail }));
      }
    }

    const outcomes: SidecarWatchOutcome[] = [];
    const repatched: Stale[] = [];
    const disabled: Stale[] = [];
    for (const s of stale) {
      if (remade.has(s.vpxPath)) {
        repatched.push(s);
        const detail = s.kind === 'version' ? `${s.tableId}: its Castcade patch was re-made for hook ${LIB_VERSION}` : `${s.tableId} changed on disk; its Castcade patch was re-made for the new version`;
        outcomes.push({ vpxPath: s.vpxPath, result: 'repatched', detail });
        continue;
      }
      try {
        const stalePath = await disableSidecar(this.fs, s.vpxPath);
        disabled.push(s);
        const detail = `${s.tableId} changed on disk and its Castcade patch no longer fits; it was disabled (${stalePath}). Re-import the table from Castcade.`;
        this.opts.log(`sidecar watch: ${detail}`);
        outcomes.push({ vpxPath: s.vpxPath, result: 'disabled', detail });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.opts.log(`sidecar watch: ${s.tableId}: ${detail}`);
        outcomes.push({ vpxPath: s.vpxPath, result: 'error', detail });
      }
    }
    this.announce(repatched, disabled, outcomes);
    return outcomes;
  }

  /** One notification per kind per look, never one per table. */
  private announce(repatched: Stale[], disabled: Stale[], outcomes: SidecarWatchOutcome[]): void {
    const detailOf = (s: Stale): string => outcomes.find((o) => o.vpxPath === s.vpxPath)?.detail ?? s.tableId;
    const n = (k: number, word: string): string => `${k} ${word}${k === 1 ? '' : 's'}`;
    if (repatched.length > 0) {
      const changed = repatched.filter((s) => s.kind === 'changed');
      if (changed.length === 0) {
        const line = `${repatched.length} table ${repatched.length === 1 ? 'patch' : 'patches'} re-made for hook ${LIB_VERSION}; nothing to do.`;
        this.opts.log(`sidecar watch: ${line}`);
        this.opts.notify?.('Castcade updated its table patches', line);
      } else if (repatched.length === 1 && changed[0]) {
        this.opts.log(`sidecar watch: ${detailOf(changed[0])}`);
        this.opts.notify?.('Castcade re-patched a table', detailOf(changed[0]));
      } else {
        const line = `${n(changed.length, 'table')} changed on disk${repatched.length > changed.length ? ` (and ${repatched.length - changed.length} re-made for hook ${LIB_VERSION})` : ''}; the Castcade patches were re-made.`;
        this.opts.log(`sidecar watch: ${line}`);
        this.opts.notify?.('Castcade re-patched tables', line);
      }
    }
    if (disabled.length > 0) {
      const only = disabled[0];
      const line = disabled.length === 1 && only ? detailOf(only) : `${n(disabled.length, 'table')} changed on disk and their Castcade patches no longer fit; they were disabled. Re-import the folder from Castcade.`;
      this.opts.notify?.('Castcade patch disabled', line);
    }
  }
}
