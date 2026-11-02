/**
 * D7.3.3 (2026-11-02): the OpenXR layer runs from a per-version copy, never from the install folder, and the companion
 * says when the VPX running predates the layer it registered.
 *
 * Why: VPX maps the layer's dll for as long as it runs. An update that lands while VPX runs cannot replace a mapped dll
 * in `resources\vr-layer\`, so the install folder kept the old dll and every table after loaded it (0.2.28 → 0.2.29,
 * 2026-11-02). So:
 *   - at start the companion copies the layer's files from resources to `%LOCALAPPDATA%\Castcade\vr-layer\<version>\`
 *     when that folder lacks them or its dll's sha256 differs from the resource's, and registers the json there. The
 *     installer never touches that folder; a running VPX only ever holds an older version's folder;
 *   - other `<version>` folders are removed at start; one whose dll a running VPX maps cannot be deleted and is left
 *     (logged once) for the next start;
 *   - `registered-at` in the version folder holds when the registry value (or the files it names) last changed, so the
 *     rule "this VPX started before that moment: restart it" survives a companion restart;
 *   - a copy that fails (the folder's own dll mapped, only in a same-version reinstall) or a manifest whose dll does not
 *     resolve beside it falls back to the resource's json, as before D7.3.3.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const VR_LAYER_DLL = 'XrApiLayer_castcade_panel.dll';
const VR_LAYER_JSON_NAME = 'XrApiLayer_castcade_panel.json';
/** What a stage holds: the dll and manifest (required), the notices and the fetch stamp (when the resource has them). */
export const VR_LAYER_FILES = [VR_LAYER_DLL, VR_LAYER_JSON_NAME, 'THIRD-PARTY.md', 'VERSION'] as const;
export const REGISTERED_AT_FILE = 'registered-at';
/** How often the "VPX predates the layer" rule is looked at; it reads the witness's own facts, no process spawns. */
export const LAYER_AGE_CHECK_MS = 5000;

/** `%LOCALAPPDATA%\Castcade\vr-layer` (beside the hook's journal and lock), else `<userData>\vr-layer`. */
export function vrLayerStageRoot(env: NodeJS.ProcessEnv, userData: string): string {
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Castcade', 'vr-layer') : join(userData, 'vr-layer');
}

/** A version as a folder name: anything outside `[A-Za-z0-9._+-]` becomes `_`. */
export function stageFolderName(version: string): string {
  const v = version.trim().replace(/[^A-Za-z0-9._+-]/g, '_');
  return v && v !== '.' && v !== '..' ? v : 'unknown';
}

export interface StageFacts {
  /** This companion's folder name (`stageFolderName`). */
  version: string;
  /** sha256 of the resource's dll. */
  sourceSha: string;
  /** sha256 of the dll in this version's folder; null when it is not there. */
  stagedSha: string | null;
  /** Whether this version's folder has the manifest. */
  stagedJson: boolean;
  /** The folders under the stage root now. */
  folders: string[];
}

export interface StagePlan {
  /** Copy the resource's files into this version's folder. */
  copy: boolean;
  /** Folders to delete: every one but this version's. */
  remove: string[];
}

/** Copy when the folder lacks the dll or manifest, or its dll differs; remove every other version's folder. */
export function planStage(f: StageFacts): StagePlan {
  return {
    copy: !f.stagedJson || f.stagedSha === null || f.stagedSha !== f.sourceSha,
    remove: f.folders.filter((d) => d.toLowerCase() !== f.version.toLowerCase()),
  };
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The manifest's `api_layer.library_path` resolved against its folder, or null when it does not parse. */
export function manifestLibrary(jsonPath: string): string | null {
  try {
    const m = JSON.parse(readFileSync(jsonPath, 'utf8')) as { api_layer?: { library_path?: unknown } };
    const lib = m.api_layer?.library_path;
    return typeof lib === 'string' && lib ? resolve(dirname(jsonPath), lib) : null;
  } catch {
    return null;
  }
}

/** The first line of a layer folder's VERSION file (what fetch-vr-layer.mjs wrote), or null. */
export function versionText(dir: string): string | null {
  try {
    const line = readFileSync(join(dir, 'VERSION'), 'utf8').split(/\r?\n/)[0]?.trim();
    return line ? line : null;
  } catch {
    return null;
  }
}

export interface StagedLayer {
  dir: string;
  jsonPath: string;
  /** Whether the files were copied this start (the layer at that path changed). */
  copied: boolean;
}

export interface StageOptions {
  /** The resource folder (the json's folder). */
  sourceDir: string;
  /** `vrLayerStageRoot`. */
  root: string;
  /** The companion's version. */
  version: string;
  log: (line: string) => void;
  /** Test seam: delete one file or folder (throws when it cannot). */
  remove?: (path: string, recursive: boolean) => void;
}

const defaultRemove = (path: string, recursive: boolean): void => rmSync(path, { recursive, force: true });

/** Delete the other versions' folders: the dll first, so a folder whose dll VPX maps is left whole. */
function cleanOld(root: string, names: string[], opts: StageOptions): void {
  const remove = opts.remove ?? defaultRemove;
  for (const name of names) {
    const dir = join(root, name);
    try {
      remove(join(dir, VR_LAYER_DLL), false);
      remove(dir, true);
      opts.log(`vr-layer: removed the older layer copy ${dir}`);
    } catch (e) {
      opts.log(`vr-layer: left the older layer copy ${dir} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}: a running VPX holds its dll); the next start removes it`);
    }
  }
}

/**
 * Stage the layer for this version (see the file comment). Null when the resource lacks the dll or manifest, the copy
 * failed, or the staged manifest's dll does not resolve beside it: the caller registers the resource's json then.
 */
export function stageVrLayer(opts: StageOptions): StagedLayer | null {
  const { sourceDir, root } = opts;
  const version = stageFolderName(opts.version);
  const dir = join(root, version);
  const jsonPath = join(dir, VR_LAYER_JSON_NAME);
  const srcDll = join(sourceDir, VR_LAYER_DLL);
  if (!existsSync(srcDll) || !existsSync(join(sourceDir, VR_LAYER_JSON_NAME))) {
    opts.log(`vr-layer: ${sourceDir} lacks the dll or its manifest; nothing to stage`);
    return null;
  }
  let folders: string[] = [];
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    /* no root yet */
  }
  const stagedDll = join(dir, VR_LAYER_DLL);
  const plan = planStage({
    version,
    sourceSha: sha256File(srcDll),
    stagedSha: existsSync(stagedDll) ? sha256File(stagedDll) : null,
    stagedJson: existsSync(jsonPath),
    folders,
  });
  if (plan.copy) {
    try {
      mkdirSync(dir, { recursive: true });
      for (const f of VR_LAYER_FILES) {
        const src = join(sourceDir, f);
        if (existsSync(src)) copyFileSync(src, join(dir, f));
        else rmSync(join(dir, f), { force: true });
      }
      rmSync(join(dir, REGISTERED_AT_FILE), { force: true });
      opts.log(`vr-layer: copied the layer from ${sourceDir} to ${dir}`);
    } catch (e) {
      opts.log(`vr-layer: could not copy the layer to ${dir} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); registering it from ${sourceDir} this run`);
      cleanOld(root, plan.remove, opts);
      return null;
    }
  }
  cleanOld(root, plan.remove, opts);
  const lib = manifestLibrary(jsonPath);
  if (!lib || !existsSync(lib)) {
    opts.log(`vr-layer: the manifest in ${dir} names ${lib ?? 'no library'}, which is not there; registering it from ${sourceDir} this run`);
    return null;
  }
  return { dir, jsonPath, copied: plan.copy };
}

/** When the registration at this folder last changed, from its `registered-at` file; null when unknown. */
export function readRegisteredAt(dir: string): number | null {
  try {
    const n = Number(readFileSync(join(dir, REGISTERED_AT_FILE), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeRegisteredAt(dir: string, at: number): void {
  try {
    writeFileSync(join(dir, REGISTERED_AT_FILE), `${at}\n`);
  } catch {
    /* the warning then lasts only for this run */
  }
}

/**
 * The rule: the VPX running started before the layer it should load was registered (the registry value or the files
 * it names changed after VPX started): it runs an older layer, or none. Unknown times say nothing.
 */
export function vpxStartedBeforeRegistration(vpxStartedAt: number | null, registeredAt: number | null): boolean {
  return vpxStartedAt !== null && registeredAt !== null && vpxStartedAt < registeredAt;
}

export const VPX_BEFORE_LAYER_TEXT = 'VPX started before this layer was registered: restart VPX for the latest theater';

export interface LayerAge {
  /** True while the running VPX predates the registration. */
  stale(): boolean;
  onChange(cb: () => void): () => void;
}

export interface LayerAgeWatch extends LayerAge {
  setRegisteredAt(at: number | null): void;
  registeredAt(): number | null;
  /** Look now (the timer does it every `LAYER_AGE_CHECK_MS`). */
  check(): void;
  start(): void;
  stop(): void;
}

export interface LayerAgeOptions {
  /** The VPX the witness saw launch, until it exits (witness-host `vpxPid`). */
  vpxPid: () => number | null;
  /** That process's start, epoch ms (witness-host `vpxStartedAt`, from the process watch's own query). */
  vpxStartedAt: () => number | null;
  log: (line: string) => void;
  intervalMs?: number;
}

export function createLayerAgeWatch(opts: LayerAgeOptions): LayerAgeWatch {
  const listeners = new Set<() => void>();
  let registered: number | null = null;
  let isStale = false;
  let pid: number | null = null;
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const iso = (ms: number): string => new Date(ms).toISOString();

  const check = (): void => {
    const p = opts.vpxPid();
    if (p !== pid) {
      pid = p;
      startedAt = null;
    }
    // Once per pid: the start time of a process does not change.
    if (pid !== null && startedAt === null) startedAt = opts.vpxStartedAt();
    const next = pid !== null && vpxStartedBeforeRegistration(startedAt, registered);
    if (next === isStale) return;
    isStale = next;
    if (next) opts.log(`vr-layer: ${VPX_BEFORE_LAYER_TEXT} (VPX pid ${pid} started ${iso(startedAt!)}, the layer was registered ${iso(registered!)})`);
    else opts.log(pid === null ? 'vr-layer: the VPX that predated the layer exited' : `vr-layer: VPX restarted (pid ${pid}) after the layer was registered; it loads the latest layer`);
    for (const l of [...listeners]) l();
  };

  return {
    stale: () => isStale,
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    setRegisteredAt(at) {
      registered = at;
      check();
    },
    registeredAt: () => registered,
    check,
    start() {
      if (timer) return;
      timer = setInterval(check, opts.intervalMs ?? LAYER_AGE_CHECK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
