/**
 * A14 (2026-11-12): which table on this PC is the host's game. The host announces a `GameFingerprint`
 * (`HELLO_ACK.hostGame`: the table's name, the `.vpx`'s SHA-256, a ROM name when the fingerprint carries one); the
 * lobby's table advisory compares the same fields (`match/controller.ts` `mismatchWords`). Strongest first:
 *
 * 1. `same_file`: the same SHA-256 (the advisory then says nothing).
 * 2. `same_rom`: the same ROM (the fingerprint carries none today, so this rung waits for one).
 * 3. `same_name`: the same table name, whole ("Monster Bash (Williams 1998) 2.1") or by its title ("Monster Bash"):
 *    the advisory then reads "same table, different file" or "different table file", as it does for a pasted invite.
 *
 * Within a rung an imported table wins over a file that was only found in the folder, then the most recently played.
 * The fingerprint comes from another PC: it is only ever compared with what is on this disk, never used as a path.
 */
import type { GameFingerprint } from '@castcade/protocol';
import type { KnownTable } from './known-tables.js';

export type TableMatchKind = 'same_file' | 'same_rom' | 'same_name';

export interface TableMatch {
  table: KnownTable;
  how: TableMatchKind;
}

const ZERO = /^0{64}$/;

/** Lower-case letters and digits only. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** "Monster Bash (Williams 1998) VPW v1.1" → "monsterbash": the words before the first bracket, without a version. */
export function titleOf(name: string): string {
  const head = name.split(/[([{]/)[0] ?? name;
  return squash(head.replace(/\bv?\d+(\.\d+)+\w*\b/gi, ' ').replace(/[_.]+/g, ' '));
}

const RANK: Record<TableMatchKind, number> = { same_file: 0, same_rom: 1, same_name: 2 };

export function findLocalTable(hostGame: Pick<GameFingerprint, 'tableName' | 'tableHash' | 'romName'>, tables: readonly KnownTable[]): TableMatch | null {
  const hash = ZERO.test(hostGame.tableHash) ? null : hostGame.tableHash.toLowerCase();
  const rom = hostGame.romName?.trim().toLowerCase() || null;
  const whole = squash(hostGame.tableName);
  const title = titleOf(hostGame.tableName);
  const scored: Array<{ m: TableMatch; score: number; order: number }> = [];
  tables.forEach((t, order) => {
    let how: TableMatchKind | null = null;
    let exact = false;
    if (hash && t.sha256 === hash) how = 'same_file';
    else if (rom && t.rom?.toLowerCase() === rom) how = 'same_rom';
    else {
      const names = [t.infoName, t.tableId].filter((n): n is string => !!n);
      if (whole.length >= 3 && names.some((n) => squash(n) === whole)) {
        how = 'same_name';
        exact = true;
      } else if (title.length >= 3 && names.some((n) => titleOf(n) === title)) how = 'same_name';
    }
    if (!how) return;
    // The rung, then the whole name before the title alone, then imported before found.
    scored.push({ m: { table: t, how }, score: RANK[how] * 4 + (exact || how !== 'same_name' ? 0 : 2) + (t.imported ? 0 : 1), order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored[0]?.m ?? null;
}
