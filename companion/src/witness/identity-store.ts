/**
 * Persistence for table identity: the facts the companion computed about a `.vpx` (keyed by path,
 * size and mtime, so a re-saved file is re-read and a hash is never computed twice for the same
 * bytes) and the player's one-time confirmations ("this file is VPS table X", keyed by path alone so
 * it survives a re-save). One JSON file under the module's data dir, rewritten whole; it is small.
 */
import { isNotFound, normalizePath, type WitnessFs } from './fs.js';
import type { VpxTableInfo, VpxTablePhysics } from './identity-types.js';

export const IDENTITY_FILE = 'table-identity.json';

export interface CachedFacts {
  fileVersion: number | null;
  tableInfo: VpxTableInfo;
  physics: VpxTablePhysics | null;
  scriptBytes: number | null;
  sha256: string | null;
  computedAt: string;
}

export interface Confirmation {
  vpsGameId: string | null;
  vpsTableId: string | null;
  at: string;
}

interface IdentityFile {
  /** 2 since 0.2.5: cached physics gained difficulty / override fields, so v1 facts are dropped (confirmations kept). */
  version: 2;
  facts: Record<string, CachedFacts>;
  confirmations: Record<string, Confirmation>;
}

export interface IdentityStore {
  load(): Promise<void>;
  /** The key for a file as it is right now. */
  key(path: string, size: number, mtimeMs: number): string;
  facts(key: string): CachedFacts | null;
  setFacts(key: string, facts: CachedFacts): Promise<void>;
  /** Fill in the hash of already-cached facts (computed later, in the background). */
  setSha256(key: string, sha256: string): Promise<void>;
  confirmation(path: string): Confirmation | null;
  confirm(path: string, c: { vpsGameId: string | null; vpsTableId: string | null } | null): Promise<void>;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

const MAX_FACTS = 500;

export function createIdentityStore(fs: WitnessFs, dataDir: string, now: () => number = () => Date.now()): IdentityStore {
  const file = joinPath(dataDir, IDENTITY_FILE);
  let data: IdentityFile = { version: 2, facts: {}, confirmations: {} };

  const persist = async (): Promise<void> => {
    // Keep the facts cache bounded: drop the oldest entries past the cap.
    const keys = Object.keys(data.facts);
    if (keys.length > MAX_FACTS) {
      keys.sort((a, b) => (data.facts[a]?.computedAt ?? '').localeCompare(data.facts[b]?.computedAt ?? ''));
      for (const k of keys.slice(0, keys.length - MAX_FACTS)) delete data.facts[k];
    }
    await fs.mkdir(dataDir);
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await fs.rename(tmp, file);
  };

  return {
    async load() {
      let text: string;
      try {
        text = new TextDecoder().decode(await fs.readFile(file));
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
          const p = parsed as Partial<IdentityFile> & { version?: unknown };
          // Confirmations are the player's answers and survive a format bump; cached facts are recomputed.
          data = { version: 2, facts: p.version === 2 ? (p.facts ?? {}) : {}, confirmations: p.confirmations ?? {} };
        }
      } catch {
        // A torn file: start clean; everything in it can be recomputed or re-confirmed.
      }
    },
    key: (path, size, mtimeMs) => `${normalizePath(path).toLowerCase()}|${size}|${Math.floor(mtimeMs)}`,
    facts: (key) => data.facts[key] ?? null,
    async setFacts(key, facts) {
      data.facts[key] = facts;
      await persist();
    },
    async setSha256(key, sha256) {
      const f = data.facts[key];
      if (!f) return;
      f.sha256 = sha256;
      await persist();
    },
    confirmation: (path) => data.confirmations[normalizePath(path).toLowerCase()] ?? null,
    async confirm(path, c) {
      const k = normalizePath(path).toLowerCase();
      if (c === null) delete data.confirmations[k];
      else data.confirmations[k] = { ...c, at: new Date(now()).toISOString() };
      await persist();
    },
  };
}
