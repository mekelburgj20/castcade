/**
 * Path rules of the import: where the sidecar, the manifest and the table id come from. Separator-
 * agnostic (tests run `MemoryFs` with `/`, production has Windows `\`): a joined path keeps the
 * separator its directory already uses.
 */
import { journalFileName } from '../witness/journal-tail.js';

const SEP_RX = /[\\/]/;

export function separatorOf(p: string): '\\' | '/' {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

export function joinPath(dir: string, name: string): string {
  const sep = separatorOf(dir);
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

export function basenameOf(p: string): string {
  const parts = p.split(SEP_RX);
  return parts[parts.length - 1] ?? p;
}

export function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '' : p.slice(0, i);
}

export function isVpxName(name: string): boolean {
  return /\.vpx$/i.test(name);
}

/** The table id: the `.vpx` basename without its extension (what `Castcade_Init` gets; the journal is named after it). */
export function tableIdFor(vpxPath: string): string {
  return basenameOf(vpxPath).replace(/\.vpx$/i, '');
}

/** The same-basename sidecar VPX auto-loads in place of the embedded script. */
export function sidecarPathFor(vpxPath: string): string {
  return vpxPath.replace(/\.vpx$/i, '') + '.vbs';
}

/** A disabled sidecar: what `Castcade_Guard` and `disableSidecar` rename it to. */
export function stalePathFor(vpxPath: string): string {
  return sidecarPathFor(vpxPath) + '.stale';
}

/** `<manifestDir>/<safe id>.json`, the same safe-name rule as the hook's journal file. */
export function manifestPathFor(manifestDir: string, tableId: string): string {
  return joinPath(manifestDir, journalFileName(tableId).replace(/\.jsonl$/, '.json'));
}

/** The `.vpx` a `.vbs` or `.vbs.stale` beside it belongs to. */
export function vpxPathForSidecar(sidecarPath: string): string {
  return sidecarPath.replace(/\.vbs(\.stale)?$/i, '') + '.vpx';
}
