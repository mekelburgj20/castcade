/**
 * Layer 1 of the stale-sidecar guard (`docs/design/table-import-and-patching.md` §6): the companion
 * is a tray app, so it watches the tables folder. A `.vpx` whose size or mtime changed since the
 * last look (a table update dropped over the old file) is checked against its manifest; a stale
 * sidecar is re-rendered when the new script still has a recipe (A–D, C1.1), else disabled, and the
 * player is told either way. The first look after start checks every patched table, because the
 * companion may not have been running when the file changed, and because a new companion build
 * (a newer hook library or recipe) makes every sidecar stale at once: those are re-made as one
 * batch with one notification, not a hundred.
 *
 * C11 (2026-10-31): a `.vpx` with no sidecar is planned too, on every look, and its `patch` item is applied in
 * the same batch as the re-makes: a table added to the folder after the last "Patch my tables" (Krobs' Freddy
 * posted only at VPX exit), or one an older build skipped for lack of a recipe (C1.1.3: originals of class
 * B/C/D have one now), gets its patch without the player going back to Settings. What the plan declines
 * (`skip`, `unsupported`, `unreadable`, `foreign`, `already`) or what failed to render is remembered in memory
 * by path + size + mtime and planned again only when the file changes (or after a reset / restart), so a
 * folder of a hundred unpatchable tables is not re-read every 30 s.
 *
 * Guard (orchestrator's decision, C11): new tables are patched only in a folder the player has imported
 * once already, i.e. the manifest dir holds at least one manifest or the folder holds at least one Castcade
 * sidecar. On a never-imported folder the watch patches nothing; the witness's "table not patched" notice
 * (with its Patch now action) does the asking.
 *
 * C11.2 (2026-11-01): a sidecar this watch wrote that is gone on a later look while the table file is unchanged was
 * removed by another program (the owner's rig: Windows Defender quarantined one rendered `.vbs` as
 * `Trojan:Script/ObfusScript.A!ml`, the table's own obfuscated script; the watch wrote it again every 30 s for an hour,
 * a balloon each time). Such a table is reported once (log, balloon, outcome) and remembered like a decline, until the
 * table file changes.
 *
 * Every look runs under the tables host's lock (`exclusive`), so it never interleaves with an
 * import or a remove-all the player started from the Settings card (2026-10-22: both re-patched
 * the same folder at the same time and the card reported a nonsense count).
 *
 * Polling, not `fs.watch`: a folder of a hundred tables is a few hundred stats every interval, which is
 * nothing, and Windows change notifications miss in-place rewrites by some downloaders.
 */
import { realClock, type Clock, type TimerHandle } from '../match/clock.js';
import {
  LIB_VERSION,
  applyImport,
  basenameOf,
  checkSidecar,
  countActions,
  decodeScript,
  disableSidecar,
  isOurSidecar,
  listVpxFiles,
  planImport,
  recipeFor,
  sidecarPathFor,
  stalePathFor,
  tableIdFor,
  type PlanItem,
} from '../patcher/index.js';
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
  /**
   * B12: can live mode read this ROM's machine (`TablesHost.liveSupportFor`)? Asked when a table with no sidecar is
   * planned (C11), so a machine the import refuses is not patched here either. Omitted = every ROM is taken as readable.
   */
  liveSupportFor?: (rom: string) => Promise<{ readable: boolean; reason: string }>;
  /** The lock shared with the import / remove-all actions (`TablesHost.exclusive`); omitted = unlocked (tests). */
  exclusive?: Exclusive;
  log: (line: string) => void;
  /** Tell the player (a desktop notification in the shell). */
  notify?: (title: string, body: string) => void;
}

/**
 * `patched`: a table with no sidecar got one (C11); `declined`: the plan would not patch it (the detail says why),
 * remembered until the file changes.
 */
export type SidecarWatchOutcome = { vpxPath: string; result: 'repatched' | 'patched' | 'declined' | 'disabled' | 'ok' | 'error'; detail: string };

interface Seen {
  size: number;
  mtimeMs: number;
}

/** C11: a table with no sidecar, to plan. `disabled`: a `.stale` copy sits beside it (an earlier patch was disabled). */
interface Fresh {
  vpxPath: string;
  tableId: string;
  st: Seen;
  disabled: boolean;
}

interface Stale {
  vpxPath: string;
  tableId: string;
  kind: 'version' | 'changed';
  why: string;
}

/** C11.2: a table whose sidecar, written by this watch, is gone while the table file is still at `st`. */
interface Gone {
  vpxPath: string;
  st: Seen;
}

const unlocked: Exclusive = (fn) => fn();
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class SidecarWatch {
  private readonly fs: WitnessFs;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly exclusive: Exclusive;
  private seen = new Map<string, Seen>();
  /** C11: tables with no sidecar the plan declined (or that failed to render), at the size + mtime it was decided for. */
  private declined = new Map<string, Seen>();
  /** C11.2: tables whose sidecar this watch wrote or re-made, at the table file's size + mtime then. */
  private patchedHere = new Map<string, Seen>();
  /** C11: the folder was found imported once (the guard); only a reset forgets it. */
  private imported = false;
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
    this.declined.clear();
    this.patchedHere.clear();
    this.imported = false;
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
        .catch((err: unknown) => this.opts.log(`sidecar watch: ${errorText(err)}`))
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
    /** C11: tables with no sidecar that were not already declined at this size + mtime. */
    const unpatched: { vpxPath: string; st: Seen }[] = [];
    /** C11.2: sidecars this watch wrote that are gone while the table file is unchanged. */
    const vanished: Gone[] = [];
    const withSidecar: string[] = [];
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
      const sidecar = await this.exists(sidecarPathFor(path));
      if (sidecar) {
        withSidecar.push(path);
        // First look: every table that has a sidecar beside it is checked once; later, only one that moved.
        if (!this.primed || !prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) changed.push(path);
      } else {
        const here = this.patchedHere.get(path);
        if (here && here.size === st.size && here.mtimeMs === st.mtimeMs) {
          // C11.2: this watch wrote that sidecar and the table file has not changed since: another program removed it.
          vanished.push({ vpxPath: path, st });
          continue;
        }
        const d = this.declined.get(path);
        if (!d || d.size !== st.size || d.mtimeMs !== st.mtimeMs) unpatched.push({ vpxPath: path, st });
      }
    }
    this.seen = next;
    this.primed = true;
    for (const p of [...this.declined.keys()]) if (!next.has(p)) this.declined.delete(p);
    for (const p of [...this.patchedHere.keys()]) if (!next.has(p)) this.patchedHere.delete(p);

    const outcomes: SidecarWatchOutcome[] = this.lost(vanished);
    const stale: Stale[] = [];
    for (const vpxPath of changed) {
      const tableId = tableIdFor(vpxPath);
      try {
        const check = await checkSidecar(this.fs, vpxPath, this.opts.manifestDir);
        if (check.state === 'stale') stale.push({ vpxPath, tableId, kind: check.kind, why: check.why });
      } catch (err) {
        outcomes.push({ vpxPath, result: 'error', detail: errorText(err) });
      }
    }
    // C11: new tables are patched only where the player has imported once, and only when VPX's scripts folder is known.
    const fresh: Fresh[] = [];
    if (unpatched.length > 0 && this.opts.scriptsDir() !== null && (await this.isImported(withSidecar))) {
      for (const u of unpatched) fresh.push({ vpxPath: u.vpxPath, tableId: tableIdFor(u.vpxPath), st: u.st, disabled: await this.exists(stalePathFor(u.vpxPath)) });
    }
    if (stale.length > 0 || fresh.length > 0) outcomes.push(...(await this.fix(stale, fresh)));
    return outcomes;
  }

  /** The C11 guard: a manifest in the manifest dir, or a Castcade sidecar beside one of the tables. */
  private async isImported(withSidecar: string[]): Promise<boolean> {
    if (this.imported) return true;
    const manifests = await this.fs.readdir(this.opts.manifestDir).catch(() => [] as string[]);
    let found = manifests.some((n) => n.toLowerCase().endsWith('.json'));
    for (const p of withSidecar) {
      if (found) break;
      const text = await this.fs
        .readFile(sidecarPathFor(p))
        .then((b) => decodeScript(b))
        .catch(() => null);
      found = text !== null && isOurSidecar(text);
    }
    this.imported = found;
    return found;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-make every stale sidecar and patch every new table in one import run (library installed once), disable
   * what no longer fits, tell the player once.
   */
  private async fix(stale: Stale[], fresh: Fresh[]): Promise<SidecarWatchOutcome[]> {
    for (const s of stale) this.opts.log(`sidecar watch: ${s.tableId} is stale (${s.why})`);
    const scriptsDir = this.opts.scriptsDir();
    const remade = new Set<string>();
    const failed = new Map<string, string>();
    /** C11: the fresh tables the plan would patch, by path. */
    const toPatch = new Map<string, PlanItem>();
    const outcomes: SidecarWatchOutcome[] = [];
    if (scriptsDir) {
      try {
        const stalePlan = stale.length > 0 ? await planImport(this.fs, { paths: stale.map((s) => s.vpxPath), manifestDir: this.opts.manifestDir }) : null;
        const freshPlan =
          fresh.length > 0
            ? await planImport(this.fs, { paths: fresh.map((f) => f.vpxPath), manifestDir: this.opts.manifestDir, ...(this.opts.liveSupportFor ? { liveSupportFor: this.opts.liveSupportFor } : {}) })
            : null;
        for (const item of freshPlan?.items ?? []) if (item.action === 'patch' || item.action === 'repatch') toPatch.set(item.vpxPath, item);
        // Only the `patch` items of the fresh plan are applied: a declined table is never touched here.
        const items = [...(stalePlan?.items ?? []), ...toPatch.values()];
        const applied = await applyImport(this.fs, { items, counts: countActions(items) }, {
          manifestDir: this.opts.manifestDir,
          vpxScriptsDir: scriptsDir,
          libSource: this.opts.libSource,
          ...(this.opts.watchOffsetsFor ? { watchOffsetsFor: this.opts.watchOffsetsFor } : {}),
          onProgress: (done, total, item) => this.opts.log(`sidecar watch: ${done}/${total} ${item.tableId} ${toPatch.has(item.vpxPath) ? 'patched' : 're-made'}`),
        });
        for (const p of applied.patched) remade.add(p);
        for (const f of applied.failed) {
          failed.set(f.item.vpxPath, f.error);
          this.opts.log(`sidecar watch: ${toPatch.has(f.item.vpxPath) ? 'patch' : 're-patch'} of ${f.item.tableId} failed: ${f.error}`);
        }
        if (applied.libInstalled !== 'unchanged') this.opts.log(`sidecar watch: library ${applied.libInstalled} in ${scriptsDir}`);
        // What the plan declined is remembered at this size + mtime and not read again until the file changes.
        for (const item of freshPlan?.items ?? []) {
          if (toPatch.has(item.vpxPath)) continue;
          const f = fresh.find((x) => x.vpxPath === item.vpxPath);
          if (f) this.declined.set(f.vpxPath, f.st);
          const detail = `${item.tableId} not patched (${item.action}: ${item.reason})`;
          this.opts.log(`sidecar watch: ${detail}`);
          outcomes.push({ vpxPath: item.vpxPath, result: 'declined', detail });
        }
      } catch (err) {
        // Nothing was re-made, patched or disabled: the folder stays as it was and the next look tries again.
        const detail = errorText(err);
        this.opts.log(`sidecar watch: re-patch failed before any table was touched: ${detail}`);
        return [...stale, ...fresh].map((s) => ({ vpxPath: s.vpxPath, result: 'error', detail }));
      }
    }

    const patched: Fresh[] = [];
    const gone: Gone[] = [];
    for (const f of fresh) {
      const item = toPatch.get(f.vpxPath);
      if (!item) continue;
      if (remade.has(f.vpxPath)) {
        if (!(await this.exists(sidecarPathFor(f.vpxPath)))) {
          // C11.2: written and already gone (an antivirus that scans the file on close): reported once, not written again.
          gone.push({ vpxPath: f.vpxPath, st: f.st });
          continue;
        }
        this.patchedHere.set(f.vpxPath, f.st);
        const recipe = item.cls ? recipeFor(item.cls) : null;
        patched.push(f);
        this.opts.log(`sidecar watch: ${f.tableId} patched (${f.disabled ? 'its earlier patch was disabled' : 'new table'}, recipe ${recipe ?? '?'})`);
        outcomes.push({ vpxPath: f.vpxPath, result: 'patched', detail: `${f.tableId} is patched (recipe ${recipe ?? '?'}): every game on it posts live from its next launch.` });
      } else {
        // A render failure on one table: remembered like a decline so it is not retried (and logged) every look.
        this.declined.set(f.vpxPath, f.st);
        outcomes.push({ vpxPath: f.vpxPath, result: 'error', detail: failed.get(f.vpxPath) ?? 'not patched' });
      }
    }

    const repatched: Stale[] = [];
    const disabled: Stale[] = [];
    for (const s of stale) {
      if (remade.has(s.vpxPath)) {
        repatched.push(s);
        const st = this.seen.get(s.vpxPath);
        if (st) this.patchedHere.set(s.vpxPath, st);
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
        const detail = errorText(err);
        this.opts.log(`sidecar watch: ${s.tableId}: ${detail}`);
        outcomes.push({ vpxPath: s.vpxPath, result: 'error', detail });
      }
    }
    this.announce(repatched, disabled, patched, outcomes);
    outcomes.push(...this.lost(gone));
    return outcomes;
  }

  /**
   * C11.2: sidecars this watch wrote that another program removed while the table file stayed as it was. Each is
   * reported once (log, outcome, one balloon per look) and remembered like a decline, so it is not written again until
   * the table file changes: the only thing the player can do is allow the file where it was quarantined.
   */
  private lost(gone: Gone[]): SidecarWatchOutcome[] {
    const outcomes: SidecarWatchOutcome[] = [];
    for (const g of gone) {
      this.declined.set(g.vpxPath, g.st);
      this.patchedHere.delete(g.vpxPath);
      const detail = `${tableIdFor(g.vpxPath)}: its Castcade patch (${basenameOf(sidecarPathFor(g.vpxPath))}) was removed right after Castcade wrote it, most likely by an antivirus quarantine of the .vbs (Windows Security → Protection history names it). Allow it there, or the table stays in basic mode; Castcade will not write it again until the table file changes.`;
      this.opts.log(`sidecar watch: ${detail}`);
      outcomes.push({ vpxPath: g.vpxPath, result: 'error', detail });
    }
    const only = outcomes[0];
    if (only) {
      const line =
        outcomes.length === 1
          ? only.detail
          : `${outcomes.length} table patches Castcade wrote were removed right after, most likely by an antivirus quarantine of the .vbs files (Windows Security → Protection history). Allow them there, or those tables stay in basic mode.`;
      this.opts.notify?.('Castcade could not keep a table patch', line);
    }
    return outcomes;
  }

  /** One notification per look for what was made or re-made, one for what was disabled; never one per table. */
  private announce(repatched: Stale[], disabled: Stale[], patched: Fresh[], outcomes: SidecarWatchOutcome[]): void {
    const detailOf = (s: { vpxPath: string; tableId: string }): string => outcomes.find((o) => o.vpxPath === s.vpxPath)?.detail ?? s.tableId;
    const n = (k: number, word: string): string => `${k} ${word}${k === 1 ? '' : 's'}`;
    let made: { title: string; line: string } | null = null;
    if (repatched.length > 0) {
      const changed = repatched.filter((s) => s.kind === 'changed');
      if (changed.length === 0) {
        made = { title: 'Castcade updated its table patches', line: `${repatched.length} table ${repatched.length === 1 ? 'patch' : 'patches'} re-made for hook ${LIB_VERSION}; nothing to do.` };
      } else if (repatched.length === 1 && changed[0]) {
        made = { title: 'Castcade re-patched a table', line: detailOf(changed[0]) };
      } else {
        made = {
          title: 'Castcade re-patched tables',
          line: `${n(changed.length, 'table')} changed on disk${repatched.length > changed.length ? ` (and ${repatched.length - changed.length} re-made for hook ${LIB_VERSION})` : ''}; the Castcade patches were re-made.`,
        };
      }
    }
    if (patched.length > 0) {
      // C11: new tables share this look's one notice with the re-makes.
      const only = patched[0];
      const line = patched.length === 1 && only ? detailOf(only) : `Castcade patched ${n(patched.length, 'new table')}: every game on them posts live from their next launch.`;
      const title = patched.length === 1 ? 'Castcade patched a new table' : 'Castcade patched new tables';
      made = made ? { title: 'Castcade patched tables', line: `${line} ${made.line}` } : { title, line };
    }
    if (made) {
      this.opts.log(`sidecar watch: ${made.line}`);
      this.opts.notify?.(made.title, made.line);
    }
    if (disabled.length > 0) {
      const only = disabled[0];
      const line = disabled.length === 1 && only ? detailOf(only) : `${n(disabled.length, 'table')} changed on disk and their Castcade patches no longer fit; they were disabled. Re-import the folder from Castcade.`;
      this.opts.notify?.('Castcade patch disabled', line);
    }
  }
}
