/**
 * The shell's side of the table import (WORK C7): turns the IPC calls of the Settings card into
 * `patcher` runs with the production file system, resolves the folders from what the witness has
 * seen (the VPX exe → `tables\` and `scripts\`), and keeps every path decision in one place so the
 * folder watch (`sidecar-watch.ts`) and the IPC handlers agree.
 */
import { applyImport, planImport, removeAllSidecars, type ImportPlan, type PlanItem } from '../patcher/index.js';
import { nodeFs, type WitnessFs } from '../witness/fs.js';
import { createMapCorpus, gameStateOffsets } from '../witness/maps.js';
import type { WitnessStatus } from '../witness/types.js';
import type { TablesApplyResult, TablesDefaults, TablesPlan, TablesRemoveResult } from './ipc-types.js';
import type { Logger } from './log.js';
import type { SettingsStore } from './settings.js';

export interface TablesHostOptions {
  store: SettingsStore;
  /** The witness status (for the VPX exe it has seen). */
  witnessStatus: () => WitnessStatus;
  /** The bundled `castcade.vbs` to install. */
  libSource: string;
  /** Where manifests live (`<userData>/tables`). */
  manifestDir: string;
  fs?: WitnessFs;
  log: Logger;
}

export interface TablesHost {
  defaults(): Promise<TablesDefaults>;
  plan(dir: string | null): Promise<TablesPlan>;
  apply(dir: string | null): Promise<TablesApplyResult>;
  removeAll(dir: string | null): Promise<TablesRemoveResult>;
  /** The folder a null `dir` means right now, or null when nothing is known yet. */
  resolveTablesDir(dir: string | null): string | null;
  scriptsDir(): string | null;
  /** The NVRAM offsets the hook journals for a ROM: its map's `game_state` bytes, `[]` without a map. */
  watchOffsetsFor(rom: string): Promise<number[]>;
  /**
   * The one lock over the tables folder: plan / apply / remove-all run under it, and so does every
   * look of the sidecar watch, so a re-patch never runs twice over the same table at once.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  readonly manifestDir: string;
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i < 0 ? p : p.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/** `Castcade_LibVersion = "0.2.0"` from the library source. */
export function hookVersionOf(text: string): string {
  const m = /Castcade_LibVersion\s*=\s*"([^"]+)"/.exec(text);
  return m ? m[1]! : 'unknown';
}

function toPlanDto(dir: string, plan: ImportPlan): TablesPlan {
  return { dir, items: plan.items.map(toItemDto), counts: { ...plan.counts } };
}

function toItemDto(i: PlanItem): TablesPlan['items'][number] {
  return { vpxPath: i.vpxPath, tableId: i.tableId, action: i.action, cls: i.cls, rom: i.rom, reason: i.reason };
}

export function createTablesHost(opts: TablesHostOptions): TablesHost {
  const fs = opts.fs ?? nodeFs;
  const { store, log, libSource, manifestDir } = opts;
  let hookVersion: string | null = null;
  const corpus = createMapCorpus(store.get().mapsDir, fs);
  const watchOffsetsFor = async (rom: string): Promise<number[]> => {
    const map = await corpus.mapFor(rom).catch(() => null);
    return map ? gameStateOffsets(map) : [];
  };

  const vpxExe = (): string | null => opts.witnessStatus().vpxExe;
  const scriptsDir = (): string | null => {
    const exe = vpxExe();
    return exe ? joinPath(dirnameOf(exe), 'scripts') : null;
  };
  const resolveTablesDir = (dir: string | null): string | null => {
    if (dir && dir.trim() !== '') return dir.trim();
    const setting = store.get().tablesDir;
    if (setting) return setting;
    const exe = vpxExe();
    return exe ? joinPath(dirnameOf(exe), 'tables') : null;
  };
  const need = (dir: string | null): string => {
    const resolved = resolveTablesDir(dir);
    if (!resolved) throw new Error('No tables folder known yet: launch a table once, or type the folder');
    return resolved;
  };

  // A promise chain is enough for one process: each caller waits for the previous one, failures included.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    manifestDir,
    resolveTablesDir,
    scriptsDir,
    watchOffsetsFor,
    exclusive,

    async defaults() {
      if (hookVersion === null) {
        hookVersion = await fs
          .readFile(libSource)
          .then((b) => hookVersionOf(Buffer.from(b).toString('latin1')))
          .catch(() => 'missing');
      }
      return { tablesDir: resolveTablesDir(null), scriptsDir: scriptsDir(), vpxExe: vpxExe(), hookVersion };
    },

    plan(dir) {
      const tablesDir = need(dir);
      return exclusive(async () => {
        const plan = await planImport(fs, { tablesDir, manifestDir, recursive: true });
        log.info(`tables: plan ${tablesDir}: ${Object.entries(plan.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        return toPlanDto(tablesDir, plan);
      });
    },

    apply(dir) {
      const tablesDir = need(dir);
      const vpxScriptsDir = scriptsDir();
      if (!vpxScriptsDir) throw new Error('Launch a table once so Castcade knows where VPX (and its scripts folder) lives');
      return exclusive(async () => {
        const plan = await planImport(fs, { tablesDir, manifestDir, recursive: true });
        const result = await applyImport(fs, plan, {
          manifestDir,
          vpxScriptsDir,
          libSource,
          watchOffsetsFor,
          onProgress: (done, total, item) => log.info(`tables: ${done}/${total} ${item.tableId} (${item.action})`),
        });
        for (const f of result.failed) log.warn(`tables: ${f.item.tableId} failed: ${f.error}`);
        const already = result.skipped.filter((it) => it.action === 'already').length;
        log.info(`tables: patched ${result.patched.length}, already current ${already}, failed ${result.failed.length}, library ${result.libInstalled} in ${vpxScriptsDir}`);
        return {
          dir: tablesDir,
          patched: result.patched,
          failed: result.failed.map((f) => ({ tableId: f.item.tableId, error: f.error })),
          already,
          skipped: result.skipped.length - already,
          libInstalled: result.libInstalled,
          scriptsDir: vpxScriptsDir,
        };
      });
    },

    removeAll(dir) {
      const tablesDir = need(dir);
      return exclusive(async () => {
        const r = await removeAllSidecars(fs, { tablesDir, manifestDir, recursive: true });
        log.info(`tables: removed ${r.removed.length} sidecar(s) under ${tablesDir}; kept ${r.keptForeign.length} foreign`);
        return { dir: tablesDir, removed: r.removed, keptForeign: r.keptForeign };
      });
    },
  };
}
