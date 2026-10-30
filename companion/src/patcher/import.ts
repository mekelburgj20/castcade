/**
 * Import a tables folder (WORK C7, owner ruling 2026-10-21): plan (dry run) → apply. For every `.vpx`
 * the script is extracted and classified; recipe A (VPM / ROM tables) gets a same-basename sidecar
 * and a manifest, unless its machine's live score is out of the hook's reach (`unreadable`, B12);
 * originals are skipped with the reason until recipes B/C exist; a `.vbs` that is
 * not ours is never touched. The shared library `castcade.vbs` is installed into the VPX `scripts\`
 * folder once per apply. Nothing here ever writes to a `.vpx`.
 *
 * C10: a table's own script can be Castcade's patch itself (the VPX editor loads a sidecar as the table's script
 * and saves it back into the `.vpx`); `patchSource` undoes it exactly and the table is patched from the script
 * underneath, so the plan never refuses a table a player merely edited.
 *
 * Also the companion-side half of the stale-sidecar guard (§6): `checkSidecar` compares a table
 * with its manifest, `disableSidecar` renames the sidecar `.stale`, `removeAllSidecars` reverts.
 */
import { createHash } from 'node:crypto';
import { isNotFound, type WitnessFs } from '../witness/fs.js';
import { readVpxScript, sha256File } from '../witness/vpx-file.js';
import { classifyScript, describeClass, type ClassifyResult, type ScriptClass } from './classify.js';
import { readManifest, writeManifest, type Manifest } from './manifest.js';
import { basenameOf, isVpxName, joinPath, manifestPathFor, sidecarPathFor, stalePathFor, tableIdFor, vpxPathForSidecar } from './paths.js';
import { GUARD_MTIME_TOLERANCE_SEC, LIB_VERSION, RECIPE_VERSION, isOurSidecar, renderRecipeA, unpatchRecipeA } from './render.js';
import { decodeScript } from './script-text.js';

export type PlanAction = 'patch' | 'repatch' | 'already' | 'skip' | 'foreign' | 'unsupported' | 'unreadable';

export interface PlanItem {
  vpxPath: string;
  tableId: string;
  action: PlanAction;
  /** `null` when the script was not read (foreign sidecar, unreadable file). */
  cls: ScriptClass | null;
  rom: string | null;
  reason: string;
  /** B12.1: an `unreadable` table that carries Castcade's own patch from before B12; the apply removes it. */
  removeSidecar?: boolean;
  /** C10: the embedded script was Castcade's patch (saved into the `.vpx` by the VPX editor); the plan is for the script underneath. */
  embeddedPatch?: boolean;
}

export interface ImportPlan {
  items: PlanItem[];
  counts: Record<PlanAction, number>;
}

export interface PlanOptions {
  tablesDir?: string;
  /** Explicit `.vpx` paths (the one-table flow); may be combined with `tablesDir`. */
  paths?: string[];
  manifestDir: string;
  recursive?: boolean;
  /**
   * B12: can live mode read this ROM's machine (`liveSupport` over its map)? A recipe-A table whose ROM
   * answers no is `unreadable` and is not patched. Omitted = every ROM is taken as readable (the sidecar
   * watch, which only re-makes sidecars that exist).
   */
  liveSupportFor?: (rom: string) => Promise<{ readable: boolean; reason: string }>;
}

export type SidecarCheck =
  | { state: 'none' }
  | { state: 'foreign' }
  | { state: 'ok'; manifest: Manifest }
  /** `kind`: `version` = this build renders differently (re-make quietly); `changed` = the table or the sidecar moved under us. */
  | { state: 'stale'; manifest: Manifest | null; why: string; kind: 'version' | 'changed' }
  | { state: 'disabled'; stalePath: string };

export interface ApplyOptions {
  manifestDir: string;
  /** The VPX `scripts\` folder (beside `core.vbs`) where `castcade.vbs` is installed. */
  vpxScriptsDir: string;
  /** Path of the `castcade.vbs` to install (bundled with the companion). */
  libSource: string;
  /** Default true: sha256 each patched `.vpx` (streamed; the slow part on a 1 GB table). */
  hashOriginals?: boolean;
  onProgress?: (done: number, total: number, item: PlanItem) => void;
  /** Wall clock for `renderedAt`; tests pass a fixed one. */
  now?: () => number;
  /**
   * The NVRAM offsets the hook should journal for a ROM (the map's `game_state` bytes; `[]` when
   * the corpus has no map for it). Omitted = no watch list is rendered (every changed byte is journaled).
   */
  watchOffsetsFor?: (rom: string) => Promise<number[]>;
}

export interface ApplyResult {
  /** `.vpx` paths that now have a current sidecar + manifest. */
  patched: string[];
  /** Plan items the apply did not act on (everything but `patch` / `repatch`). */
  skipped: PlanItem[];
  failed: { item: PlanItem; error: string }[];
  libInstalled: 'installed' | 'updated' | 'unchanged';
  /** B12.1: `.vpx` paths whose Castcade patch was removed because their machine's live score can't be read. */
  unpatched: string[];
}

const ACTIONS: readonly PlanAction[] = ['patch', 'repatch', 'already', 'skip', 'foreign', 'unsupported', 'unreadable'];

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function exists(fs: WitnessFs, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function readTextIfExists(fs: WitnessFs, path: string): Promise<string | null> {
  try {
    return decodeScript(await fs.readFile(path));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function tryReaddir(fs: WitnessFs, dir: string): Promise<string[] | null> {
  try {
    return await fs.readdir(dir);
  } catch {
    // ENOENT on MemoryFs, ENOTDIR on a real file: either way not a directory we can list.
    return null;
  }
}

/** Every `.vpx` under `dir` (sorted; subfolders only when `recursive`). Non-`.vpx` names are ignored. */
export async function listVpxFiles(fs: WitnessFs, dir: string, recursive = false): Promise<string[]> {
  const out: string[] = [];
  const names = await fs.readdir(dir);
  for (const name of names) {
    const p = joinPath(dir, name);
    if (isVpxName(name)) out.push(p);
    else if (recursive && (await tryReaddir(fs, p)) !== null) out.push(...(await listVpxFiles(fs, p, true)));
  }
  return out.sort();
}

/**
 * The state of a table's sidecar against its manifest. Cheap first (size + mtime), the sha256 of
 * the `.vpx` only when the sizes match, the mtime moved and the manifest has a hash to confirm
 * against. Version drift (an older recipe or library than this build) is `stale` too.
 */
export async function checkSidecar(fs: WitnessFs, vpxPath: string, manifestDir: string): Promise<SidecarCheck> {
  const sidecarPath = sidecarPathFor(vpxPath);
  const text = await readTextIfExists(fs, sidecarPath);
  if (text === null) {
    const stalePath = stalePathFor(vpxPath);
    return (await exists(fs, stalePath)) ? { state: 'disabled', stalePath } : { state: 'none' };
  }
  if (!isOurSidecar(text)) return { state: 'foreign' };

  const manifest = await readManifest(fs, manifestPathFor(manifestDir, tableIdFor(vpxPath)));
  if (!manifest) return { state: 'stale', manifest: null, why: 'no manifest for this sidecar', kind: 'changed' };
  if (manifest.recipeVersion !== RECIPE_VERSION || manifest.libVersion !== LIB_VERSION) {
    return { state: 'stale', manifest, why: `rendered with recipe ${manifest.recipeVersion} / lib ${manifest.libVersion}; this build is ${RECIPE_VERSION} / ${LIB_VERSION}`, kind: 'version' };
  }
  const sidecarSha = createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex');
  if (sidecarSha !== manifest.sidecarSha256) return { state: 'stale', manifest, why: 'sidecar bytes differ from the manifest (edited by hand?)', kind: 'changed' };

  let st: { size: number; mtimeMs: number };
  try {
    st = await fs.stat(vpxPath);
  } catch (err) {
    if (isNotFound(err)) return { state: 'stale', manifest, why: 'original .vpx is missing', kind: 'changed' };
    throw err;
  }
  if (st.size !== manifest.vpxSize) return { state: 'stale', manifest, why: `size ${st.size} vs ${manifest.vpxSize} in the manifest`, kind: 'changed' };
  if (st.mtimeMs !== manifest.vpxMtimeMs) {
    if (manifest.vpxSha256 === null) return { state: 'stale', manifest, why: 'mtime changed and the manifest has no hash to confirm against', kind: 'changed' };
    const sha = await sha256File(fs, vpxPath);
    if (sha !== manifest.vpxSha256) return { state: 'stale', manifest, why: 'sha256 of the .vpx differs from the manifest', kind: 'changed' };
  }
  return { state: 'ok', manifest };
}

/**
 * C10: the script a table is patched from. When the embedded script is Castcade's own sidecar (the VPX editor saved
 * it into the `.vpx`), it is undone exactly and the script underneath is what gets patched. Someone else's
 * `Castcade_Init` (no marker, or an unpatch that fails) is left to the classifier's `alreadyPatched`.
 */
export function patchSource(text: string): { text: string; embeddedPatch: boolean } {
  if (!isOurSidecar(text)) return { text, embeddedPatch: false };
  const underneath = unpatchRecipeA(text);
  return underneath === null ? { text, embeddedPatch: false } : { text: underneath, embeddedPatch: true };
}

async function planOne(fs: WitnessFs, vpxPath: string, opts: PlanOptions): Promise<PlanItem> {
  const { manifestDir } = opts;
  const tableId = tableIdFor(vpxPath);
  const item = (action: PlanAction, cls: ScriptClass | null, rom: string | null, reason: string): PlanItem => ({ vpxPath, tableId, action, cls, rom, reason });

  const check = await checkSidecar(fs, vpxPath, manifestDir);
  if (check.state === 'foreign') return item('foreign', null, null, `an external ${basenameOf(sidecarPathFor(vpxPath))} beside the table is not Castcade's; left alone`);

  let script;
  try {
    script = await readVpxScript(fs, vpxPath);
  } catch (err) {
    return item('unsupported', null, null, `cannot read the table: ${errorMessage(err)}`);
  }
  if (!script) return item('unsupported', null, null, 'no script in the table (no GameStg/GameData/CODE record)');

  const source = patchSource(decodeScript(script.bytes));
  const { cls, facts } = classifyScript(source.text);
  const rom = facts.rom ?? null;
  const sidecarNote = check.state === 'none' || check.state === 'disabled' ? '' : '; an existing Castcade sidecar remains (remove-all deletes it)';
  if (cls === 'X') return item('unsupported', cls, rom, `${facts.reason ?? 'unsupported'}${sidecarNote}`);
  if (cls !== 'A') return item('skip', cls, rom, `${describeClass(cls)} (class ${cls}): recipe B/C not built yet${sidecarNote}`);
  if (facts.alreadyPatched) return item('already', cls, rom, 'the embedded script already contains Castcade_Init');
  // B12: a patch on a machine whose live score the hook cannot see would read as ready and post nothing live.
  // A table with no ROM name is still patched: the hook reports the ROM it really runs.
  if (rom && opts.liveSupportFor) {
    const live = await opts.liveSupportFor(rom);
    if (!live.readable) {
      // B12.1: Castcade's own patch from before B12 does nothing live here; the apply removes it (never a foreign file).
      if (check.state === 'none') return item('unreadable', cls, rom, live.reason);
      return { ...item('unreadable', cls, rom, `${live.reason}; Castcade's earlier patch will be removed`), removeSidecar: true };
    }
  }

  // C10: the reason names the cause (it is what the plan list shows) and the item carries the flag.
  const underneath = source.embeddedPatch ? "; the table's own script carries Castcade's patch (the VPX editor saved it there), so the fresh patch is made from the script underneath" : '';
  const planned = ((): PlanItem => {
    switch (check.state) {
      case 'none':
        return item('patch', cls, rom, `${describeClass(cls)}${rom ? `, ROM ${rom}` : ', no cGameName'}${underneath}`);
      case 'disabled':
        return item('patch', cls, rom, `previous sidecar was disabled as stale (${basenameOf(check.stalePath)}); re-render${underneath}`);
      case 'stale':
        return item('repatch', cls, rom, `${check.why}${underneath}`);
      case 'ok': {
        // The hash matched but the stamp the sidecar checks at load is size + mtime; re-render when the
        // mtime moved further than Castcade_Guard tolerates or the guard would disable it at launch.
        const drift = Math.abs(script.mtimeMs - check.manifest.vpxMtimeMs) / 1000;
        if (drift > GUARD_MTIME_TOLERANCE_SEC) return item('repatch', cls, rom, `the .vpx timestamp moved ${Math.round(drift)} s; the in-script stamp must be re-rendered${underneath}`);
        return item('already', cls, rom, `sidecar current (recipe ${check.manifest.recipeVersion}, lib ${check.manifest.libVersion})`);
      }
    }
  })();
  return source.embeddedPatch ? { ...planned, embeddedPatch: true } : planned;
}

/** Dry run: what an apply would do, per table. Writes nothing. */
export async function planImport(fs: WitnessFs, opts: PlanOptions): Promise<ImportPlan> {
  if (!opts.tablesDir && !opts.paths) throw new Error('planImport: give tablesDir and/or paths');
  const paths = new Set<string>();
  if (opts.tablesDir) for (const p of await listVpxFiles(fs, opts.tablesDir, opts.recursive ?? false)) paths.add(p);
  for (const p of opts.paths ?? []) if (isVpxName(basenameOf(p))) paths.add(p);

  const items: PlanItem[] = [];
  for (const p of [...paths].sort()) items.push(await planOne(fs, p, opts));
  return { items, counts: countActions(items) };
}

export function countActions(items: readonly PlanItem[]): Record<PlanAction, number> {
  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<PlanAction, number>;
  for (const it of items) counts[it.action]++;
  return counts;
}

const LIB_VERSION_RX = /^\s*Dim\s+Castcade_LibVersion\s*:\s*Castcade_LibVersion\s*=\s*"([^"]+)"/m;

/** The `Castcade_LibVersion` a `castcade.vbs` text declares, or `null`. */
export function libraryVersionOf(text: string): string | null {
  return LIB_VERSION_RX.exec(text)?.[1] ?? null;
}

/**
 * Install `castcade.vbs` into the VPX `scripts\` folder: a new file beside `core.vbs`, written only
 * when the bytes differ. Throws when the source does not declare this build's `LIB_VERSION` (a
 * bundle/code drift the sidecars would then run against).
 */
export async function installLibrary(fs: WitnessFs, libSource: string, vpxScriptsDir: string): Promise<'installed' | 'updated' | 'unchanged'> {
  const src = await fs.readFile(libSource);
  const declared = libraryVersionOf(decodeScript(src));
  if (declared !== LIB_VERSION) throw new Error(`installLibrary: ${libSource} declares Castcade_LibVersion ${declared ?? '(none)'}, this build needs ${LIB_VERSION}`);
  const dest = joinPath(vpxScriptsDir, 'castcade.vbs');
  let current: Uint8Array | null = null;
  try {
    current = await fs.readFile(dest);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (current && Buffer.compare(Buffer.from(current), Buffer.from(src)) === 0) return 'unchanged';
  await fs.writeFile(dest, src);
  return current ? 'updated' : 'installed';
}

/** Apply a plan: install the library once, then render sidecar + manifest for every `patch` / `repatch` item. */
export async function applyImport(fs: WitnessFs, plan: ImportPlan, opts: ApplyOptions): Promise<ApplyResult> {
  const todo = plan.items.filter((it) => it.action === 'patch' || it.action === 'repatch');
  const result: ApplyResult = { patched: [], skipped: plan.items.filter((it) => !todo.includes(it)), failed: [], libInstalled: 'unchanged', unpatched: [] };
  for (const item of plan.items.filter((it) => it.removeSidecar)) {
    try {
      await unpatchOne(fs, item.vpxPath, opts.manifestDir);
      result.unpatched.push(item.vpxPath);
    } catch (err) {
      result.failed.push({ item, error: errorMessage(err) });
    }
  }
  if (todo.length === 0) return result;

  result.libInstalled = await installLibrary(fs, opts.libSource, opts.vpxScriptsDir);
  await fs.mkdir(opts.manifestDir);
  const now = opts.now ?? Date.now;
  let done = 0;
  for (const item of todo) {
    try {
      await patchOne(fs, item, opts, now);
      result.patched.push(item.vpxPath);
    } catch (err) {
      result.failed.push({ item, error: errorMessage(err) });
    }
    done++;
    opts.onProgress?.(done, todo.length, item);
  }
  return result;
}

async function patchOne(fs: WitnessFs, item: PlanItem, opts: ApplyOptions, now: () => number): Promise<void> {
  const script = await readVpxScript(fs, item.vpxPath);
  if (!script) throw new Error('no script in the table');
  const text = patchSource(decodeScript(script.bytes)).text;
  const cls: ClassifyResult = classifyScript(text);
  const sidecarPath = sidecarPathFor(item.vpxPath);
  const rom = cls.facts.rom ?? null;
  const watchOffsets = opts.watchOffsetsFor && rom ? await opts.watchOffsetsFor(rom) : undefined;
  const rendered = renderRecipeA(text, cls, {
    tableId: item.tableId,
    rom,
    originalPath: item.vpxPath,
    originalSize: script.size,
    originalMtimeMs: script.mtimeMs,
    sidecarPath,
    ...(watchOffsets !== undefined ? { watchOffsets } : {}),
  });
  // B15: the table file has not moved since its last render (same path, size and timestamp: the trust `checkSidecar`
  // gives it): keep its hash. A re-make for a new recipe or hook then costs a script read, not a hash of the whole
  // `.vpx` (~0.5 s a table from a hard disk, three minutes over 334 tables, during which a table opened ran its old patch).
  const previous = await readManifest(fs, manifestPathFor(opts.manifestDir, item.tableId)).catch(() => null);
  const unchanged = previous !== null && previous.vpxSha256 !== null && previous.vpxPath === item.vpxPath && previous.vpxSize === script.size && previous.vpxMtimeMs === script.mtimeMs;
  const vpxSha256 = unchanged ? previous.vpxSha256 : (opts.hashOriginals ?? true) ? await sha256File(fs, item.vpxPath) : null;
  const manifest: Manifest = {
    tableId: item.tableId,
    vpxPath: item.vpxPath,
    vpxSha256,
    vpxSize: script.size,
    vpxMtimeMs: script.mtimeMs,
    scriptSha256: script.sha256,
    class: cls.cls,
    recipe: 'A',
    recipeVersion: RECIPE_VERSION,
    libVersion: LIB_VERSION,
    rom: cls.facts.rom ?? null,
    sidecarPath,
    sidecarSha256: rendered.sha256,
    anchors: rendered.anchors,
    warnings: rendered.warnings,
    renderedAt: new Date(now()).toISOString(),
    verified: null,
  };
  await fs.writeFile(sidecarPath, rendered.bytes);
  await writeManifest(fs, manifestPathFor(opts.manifestDir, item.tableId), manifest);
  const stalePath = stalePathFor(item.vpxPath);
  if (await exists(fs, stalePath)) await fs.unlink(stalePath);
}

/**
 * B12.1: remove Castcade's patch from one table: its sidecar, a disabled `.stale` copy and its manifest. A `.vbs`
 * that is not ours stays. VPX loads the table's embedded script again at the next launch.
 */
async function unpatchOne(fs: WitnessFs, vpxPath: string, manifestDir: string): Promise<void> {
  for (const p of [sidecarPathFor(vpxPath), stalePathFor(vpxPath)]) {
    const text = await readTextIfExists(fs, p);
    if (text !== null && isOurSidecar(text)) await fs.unlink(p);
  }
  const manifestPath = manifestPathFor(manifestDir, tableIdFor(vpxPath));
  if (await exists(fs, manifestPath)) await fs.unlink(manifestPath);
}

/**
 * Rename `<Table>.vbs` to `<Table>.vbs.stale` (replacing an older `.stale`) so VPX loads the embedded
 * script again. Refuses a `.vbs` that is not ours. Returns the new path.
 */
export async function disableSidecar(fs: WitnessFs, vpxPath: string): Promise<string> {
  const sidecarPath = sidecarPathFor(vpxPath);
  const text = decodeScript(await fs.readFile(sidecarPath));
  if (!isOurSidecar(text)) throw new Error(`disableSidecar: ${sidecarPath} is not a Castcade sidecar; left alone`);
  const stalePath = stalePathFor(vpxPath);
  if (await exists(fs, stalePath)) await fs.unlink(stalePath);
  await fs.rename(sidecarPath, stalePath);
  return stalePath;
}

/** Revert: delete every Castcade sidecar (`.vbs` and `.vbs.stale`) under `tablesDir` and its manifest; foreign `.vbs` files stay. */
export async function removeAllSidecars(fs: WitnessFs, opts: { tablesDir: string; manifestDir: string; recursive?: boolean }): Promise<{ removed: string[]; keptForeign: string[] }> {
  const removed: string[] = [];
  const keptForeign: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of await fs.readdir(dir)) {
      const p = joinPath(dir, name);
      if (/\.vbs(\.stale)?$/i.test(name)) {
        const text = await readTextIfExists(fs, p);
        if (text === null) continue;
        if (!isOurSidecar(text)) {
          keptForeign.push(p);
          continue;
        }
        await fs.unlink(p);
        removed.push(p);
        const manifestPath = manifestPathFor(opts.manifestDir, tableIdFor(vpxPathForSidecar(p)));
        if (await exists(fs, manifestPath)) {
          await fs.unlink(manifestPath);
          removed.push(manifestPath);
        }
      } else if (opts.recursive && !isVpxName(name) && (await tryReaddir(fs, p)) !== null) {
        await walk(p);
      }
    }
  };
  await walk(opts.tablesDir);
  return { removed, keptForeign };
}
