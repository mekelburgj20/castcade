/**
 * Find the `.vpx` behind a table NAME. A `-Play` launch names the file on the command line, but a
 * table opened from the editor (recent files, File → Open, a double-clicked file) only shows up in
 * the window title as `Visual Pinball - [<name>]`, so the companion has to look for `<name>.vpx`
 * itself. VPX's default tables folder is `tables` beside the executable; players with a frontend
 * often keep tables elsewhere, hence the optional extra roots (the `tablesDir` setting).
 *
 * The search is shallow and cheap on purpose (a few directory listings), never a full-disk scan.
 */
import { isNotFound, type WitnessFs } from './fs.js';

export const DEFAULT_MAX_DEPTH = 3;

function sepOf(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

export function joinPath(dir: string, name: string): string {
  return dir.replace(/[\\/]+$/, '') + sepOf(dir) + name;
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i <= 0 ? p : p.slice(0, i);
}

/** The folders to search for a VPX build at `exe`, in order: `<exe dir>\tables` first, then overrides. */
export async function tableRootsFor(fs: WitnessFs, exe: string | null, extraRoots: Array<string | null | undefined> = []): Promise<string[]> {
  const roots: string[] = [];
  if (exe) {
    const dir = dirnameOf(exe);
    try {
      // Windows is case-insensitive but the listing keeps the real spelling; match either.
      const entries = await fs.readdir(dir);
      const tables = entries.find((e) => e.toLowerCase() === 'tables');
      if (tables) roots.push(joinPath(dir, tables));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  for (const r of extraRoots) {
    if (r && r.trim() && !roots.some((x) => x.toLowerCase() === r.trim().toLowerCase())) roots.push(r.trim());
  }
  return roots;
}

/**
 * Breadth-first search for `<name>.vpx` (case-insensitive) under `roots`, at most `maxDepth` levels
 * deep. Returns the first hit in root order, or null. Entries that fail to list are treated as files.
 */
export async function findTableFile(fs: WitnessFs, name: string, roots: string[], opts: { maxDepth?: number } = {}): Promise<string | null> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const want = `${name.trim().toLowerCase()}.vpx`;
  if (want === '.vpx') return null;
  for (const root of roots) {
    let level: string[] = [root];
    for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        let entries: string[];
        try {
          entries = await fs.readdir(dir);
        } catch {
          continue;
        }
        for (const e of entries) {
          const lower = e.toLowerCase();
          if (lower === want) return joinPath(dir, e);
          if (!lower.endsWith('.vpx') && !lower.includes('.')) next.push(joinPath(dir, e));
        }
      }
      level = next;
    }
  }
  return null;
}

/** File name without directory and `.vpx` extension (what VPS matching and Status use). */
export function tableBaseName(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return path.slice(i + 1).replace(/\.vpx$/i, '');
}
