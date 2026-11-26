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
 *
 * A table that can report ball ends is never displaced by one that cannot (I11.4.11 review): an imported table has the
 * sidecar patch, a file that was only found in the folder has not (the witness runs it in basic mode, the lobby says
 * its ball ends cannot be reported, and every ball of that player needs Pass the turn). So when any imported table
 * matches, the pick is among the imported ones (the identical file first), and a file that is not imported is only
 * picked when no imported copy of the game exists. `identical` then names the host's file when it is on this PC and
 * was passed over: the player can import it for 3D.
 *
 * I11.4.11 (2026-11-21): rung 1 needs a hash on this side, and a file that was only found in the folder has none (nor
 * has an imported one that changed since it was read). `unhashedCandidates` names the files that could still be the
 * host's: the caller hashes them (`table-hash.ts`) and asks again, so the identical file wins over a same-name copy.
 *
 * I11.4.15 (2026-11-24, Congo again on 2026-11-23): the file's bytes are not what the 3D view needs. Two PCs watch each
 * other in 3D when the Castcade VPX build names the same table objects on both (`fork-identity.ts`); that night two
 * tables of two had other bytes and the same objects (3D ran, the lobby had warned of a different file), and of two
 * imported copies of Congo, neither the host's bytes, the one played last won: a mod with other objects, 2D. So the
 * caller hands in the host's table objects and those of this PC's copies (`ObjectsEvidence`), and below the identical
 * file the copies rank: the host's objects, then objects not known, then objects known to be others; only then the
 * rung (ROM, whole name, title) and the list's order. The list's order (most recently played first) therefore never
 * chooses between a copy with the host's objects and one without. The rule of the imported table stands above all of
 * it. `sameObjects` names a copy with the host's objects that was passed over for an imported one with others.
 */
import type { GameFingerprint } from '@castcade/protocol';
import { sameForkIdentity, type ForkIdentity } from './fork-identity.js';
import type { KnownTable } from './known-tables.js';

export type TableMatchKind = 'same_file' | 'same_rom' | 'same_name';

/** I11.4.15: a copy's table objects against the host's: the same, known to be others, or not known (of either side). */
export type ObjectsProof = 'same' | 'unknown' | 'differs';

/** I11.4.15: what is known of the table objects (`fork-identity.ts`): the host's, and this PC's copies by `vpxPath`. */
export interface ObjectsEvidence {
  /** The host's table objects as HELLO_ACK said them; null: not said (no table yet, a host from before I11.4.15). */
  host: ForkIdentity | null;
  /** This PC's copies whose objects are known. A path that is not in it: not known. */
  local: ReadonlyMap<string, ForkIdentity>;
}

export interface TableMatch {
  table: KnownTable;
  how: TableMatchKind;
  /** I11.4.15: the picked copy's table objects against the host's (`same` for the identical file). */
  objects: ObjectsProof;
  /** The host's identical file on this PC, when it is not imported and an imported copy without the host's objects was picked instead. */
  identical?: KnownTable;
  /** I11.4.15: a copy with the host's table objects, not imported, when an imported copy with other objects was picked instead (and no `identical`). */
  sameObjects?: KnownTable;
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

/** I11.4.11: an imported copy was started although the host's identical file is on this PC, not imported (`file`: its name). */
export const identicalFileNote = (file: string): string => `For 3D: the host's file is on this PC as "${file}", not imported. Import it in Castcade and rejoin`;

/** The host's file hash, lower-case; null when its fingerprint carries none yet (zeros). */
export function hostHash(hostGame: Pick<GameFingerprint, 'tableHash'>): string | null {
  return ZERO.test(hostGame.tableHash) ? null : hostGame.tableHash.toLowerCase();
}

/** How many files of one title are hashed for one join, at most (imported ones first, then by the list's order): the caller's cut. */
export const HASH_CANDIDATES_MAX = 8;

/**
 * I11.4.11: when the host's hash is known and no table here has it, the tables that could still be that file: the
 * same name or title as the host's game (or its ROM), and no hash yet. Empty when a table with the host's hash is
 * known already, or the host's hash is not. All of them, imported first: the caller hashes `HASH_CANDIDATES_MAX`.
 */
export function unhashedCandidates(hostGame: Pick<GameFingerprint, 'tableName' | 'tableHash' | 'romName'>, tables: readonly KnownTable[]): KnownTable[] {
  const hash = hostHash(hostGame);
  if (!hash || tables.some((t) => t.sha256 === hash)) return [];
  const out = tables.filter((t) => t.sha256 === null && findLocalTable({ ...hostGame, tableHash: '0'.repeat(64) }, [t]) !== null);
  return [...out.filter((t) => t.imported), ...out.filter((t) => !t.imported)];
}

/** I11.4.15: an imported copy with other table objects was started although a copy with the host's objects is on this PC, not imported (`file`: its name). */
export const sameObjectsNote = (file: string): string => `For 3D: "${file}" on this PC holds the same table objects as the host's file and is not imported. Import it in Castcade and rejoin`;

/** I11.4.15: the copies whose table objects are read for one join, at most (the caller's cut, as `HASH_CANDIDATES_MAX`). */
export const OBJECTS_CANDIDATES_MAX = 8;

/**
 * I11.4.15: the copies of the host's game on this PC (by its file, ROM, name or title), imported first, then in the
 * list's order: the ones whose table objects are worth knowing. All of them: the caller reads `OBJECTS_CANDIDATES_MAX`.
 */
export function objectsCandidates(hostGame: Pick<GameFingerprint, 'tableName' | 'tableHash' | 'romName'>, tables: readonly KnownTable[]): KnownTable[] {
  const out = tables.filter((t) => findLocalTable(hostGame, [t]) !== null);
  return [...out.filter((t) => t.imported), ...out.filter((t) => !t.imported)];
}

const OBJECTS_RANK: Record<ObjectsProof, number> = { same: 0, unknown: 1, differs: 2 };

export function findLocalTable(hostGame: Pick<GameFingerprint, 'tableName' | 'tableHash' | 'romName'>, tables: readonly KnownTable[], evidence?: ObjectsEvidence): TableMatch | null {
  const hash = ZERO.test(hostGame.tableHash) ? null : hostGame.tableHash.toLowerCase();
  const rom = hostGame.romName?.trim().toLowerCase() || null;
  const whole = squash(hostGame.tableName);
  const title = titleOf(hostGame.tableName);
  const hostObjects = evidence?.host ?? null;
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
    // I11.4.15: the identical file holds the host's objects by definition; any other copy by what is known of both.
    const own = evidence?.local.get(t.vpxPath) ?? null;
    const objects: ObjectsProof = how === 'same_file' ? 'same' : hostObjects && own ? (sameForkIdentity(hostObjects, own) ? 'same' : 'differs') : 'unknown';
    // The identical file; then the table objects (the host's, not known, others); then the rung, the whole name
    // before the title alone, and imported before found.
    const rung = RANK[how] * 4 + (exact || how !== 'same_name' ? 0 : 2) + (t.imported ? 0 : 1);
    scored.push({ m: { table: t, how, objects }, score: (how === 'same_file' ? 0 : 100) + OBJECTS_RANK[objects] * 20 + rung, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  // A table that can report ball ends (an imported one) is never displaced by one that cannot.
  const imported = scored.filter((x) => x.m.table.imported);
  const best = (imported.length > 0 ? imported : scored)[0]?.m ?? null;
  // The identical file, or a copy with its objects: 3D works with it, and nothing better is on this PC.
  if (!best || best.how === 'same_file' || best.objects === 'same') return best;
  const identical = scored.find((x) => x.m.how === 'same_file' && !x.m.table.imported)?.m.table;
  if (identical) return { ...best, identical };
  const sameObjects = best.objects === 'differs' ? scored.find((x) => x.m.objects === 'same' && !x.m.table.imported)?.m.table : undefined;
  return sameObjects ? { ...best, sameObjects } : best;
}
