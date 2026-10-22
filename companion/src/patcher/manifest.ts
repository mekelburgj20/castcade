/**
 * The import manifest (`docs/design/table-import-and-patching.md` §6): one JSON file per imported
 * table under the companion's manifest dir, pinning the original `.vpx` (sha256, size, mtime), the
 * script, the recipe and library versions and the rendered sidecar. `checkSidecar` compares a table
 * against it; `HELLO` (C4) will carry its hashes.
 */
import { isNotFound, type WitnessFs } from '../witness/fs.js';
import type { ScriptClass } from './classify.js';

export interface ManifestVerification {
  at: string;
  result: 'ok' | 'failed';
  detail: string;
}

export interface Manifest {
  tableId: string;
  vpxPath: string;
  /** sha256 of the whole original `.vpx`; `null` when the import skipped hashing (`hashOriginals: false`). */
  vpxSha256: string | null;
  vpxSize: number;
  vpxMtimeMs: number;
  /** sha256 of the extracted script bytes. */
  scriptSha256: string;
  class: ScriptClass;
  recipe: 'A';
  recipeVersion: string;
  libVersion: string;
  rom: string | null;
  sidecarPath: string;
  sidecarSha256: string;
  anchors: Record<string, string>;
  warnings: string[];
  /** ISO 8601. */
  renderedAt: string;
  /** The verification launch (§7); `null` until a table verifies on first play. */
  verified: ManifestVerification | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural check of a parsed manifest; a file that fails it is treated as absent. */
export function isManifest(v: unknown): v is Manifest {
  if (!isRecord(v)) return false;
  return (
    typeof v['tableId'] === 'string' &&
    typeof v['vpxPath'] === 'string' &&
    (typeof v['vpxSha256'] === 'string' || v['vpxSha256'] === null) &&
    typeof v['vpxSize'] === 'number' &&
    typeof v['vpxMtimeMs'] === 'number' &&
    typeof v['scriptSha256'] === 'string' &&
    typeof v['class'] === 'string' &&
    v['recipe'] === 'A' &&
    typeof v['recipeVersion'] === 'string' &&
    typeof v['libVersion'] === 'string' &&
    (typeof v['rom'] === 'string' || v['rom'] === null) &&
    typeof v['sidecarPath'] === 'string' &&
    typeof v['sidecarSha256'] === 'string' &&
    isRecord(v['anchors']) &&
    Array.isArray(v['warnings']) &&
    typeof v['renderedAt'] === 'string' &&
    (v['verified'] === null || isRecord(v['verified']))
  );
}

/** The manifest at `path`, or `null` when it is missing or not a manifest. */
export async function readManifest(fs: WitnessFs, path: string): Promise<Manifest | null> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeManifest(fs: WitnessFs, path: string, manifest: Manifest): Promise<void> {
  await fs.writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}
