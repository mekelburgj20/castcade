/**
 * A17 step 6 (2026-11-25, alpha-match.md §11.5): the lobby's table is a PICK, not somebody's open VPX, and a pick is
 * made of what a table IS, not of the facts of one PC's copy of it. Of `GameFingerprint` the identity keys are
 * `kind`, `tableName`, `tableHash` (the SHA-256 of the `.vpx`) and `romName`; `romHash`, `physicsHash`,
 * `recipeVersion`, `sidecarHash` and `emulatorVersion` belong to one copy and are null or empty in a pick.
 *
 * So a member's table is compared with the pick on the identity keys alone (a comparison of every key, as a match
 * without a lobby makes against its host's fingerprint, would flag everyone against a pick), and falls into one of
 * three: the same file, the same game in another file (today's advisory), another game (`OTHER TABLE`: a start
 * waits for that member as it waits for a table that is still loading).
 *
 * "The same game" is what `launch/find-table.ts` takes for it when a joining PC looks for its copy: the same ROM, or
 * the same table name, whole or by its title (the words before the first bracket, without a version). The rule is
 * written again here, and not imported, because the engine depends on nothing outside `match/` and the protocol.
 */
import type { GameFingerprint, PayloadOf, PlayerId } from '@castcade/protocol';

export const IDENTITY_KEYS = ['kind', 'tableName', 'tableHash', 'romName'] as const;
export type IdentityKey = (typeof IDENTITY_KEYS)[number];

export type TableRelation = 'same_file' | 'same_game' | 'other';

const ZERO = /^0{64}$/;
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** "Monster Bash (Williams 1998) VPW v1.1" → "monsterbash" (as `find-table.ts` `titleOf`). */
function titleOf(name: string): string {
  const head = name.split(/[([{]/)[0] ?? name;
  return squash(head.replace(/\bv?\d+(\.\d+)+\w*\b/gi, ' ').replace(/[_.]+/g, ' '));
}

/** The pick a table makes: its identity keys, and nothing of the copy it was read from. */
export function pickOf(game: GameFingerprint): GameFingerprint {
  return { kind: game.kind, tableName: game.tableName, tableHash: game.tableHash, romName: game.romName, romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '' };
}

/** A pick with its identity keys alone (for a comparison that walks the keys of what it is given). */
export function identityOnly(game: GameFingerprint): Pick<GameFingerprint, IdentityKey> {
  return { kind: game.kind, tableName: game.tableName, tableHash: game.tableHash, romName: game.romName };
}

/** Two picks name the same table: every identity key is equal. */
export function samePick(a: GameFingerprint, b: GameFingerprint): boolean {
  return IDENTITY_KEYS.every((k) => a[k] === b[k]);
}

/**
 * What differs between a pick and a member's table, on the identity keys only, in the shape of a fingerprint mismatch.
 *
 * A17 step 10: only what is known on both sides can differ. A pick whose file was never hashed (zeros) says nothing
 * of the bytes, and a table whose PC names no ROM (a companion's own fingerprint carries none) says nothing of the
 * ROM: neither is a difference. So a pick made from a PC's table list, with its ROM, flags nobody for having the
 * same file open.
 */
export function compareWithPick(pick: GameFingerprint, received: GameFingerprint, expectedFrom: PlayerId): PayloadOf<'REFUSE'>['mismatches'] {
  const out: PayloadOf<'REFUSE'>['mismatches'] = [];
  for (const field of IDENTITY_KEYS) {
    const a = pick[field];
    const b = received[field];
    if (field === 'tableHash' && ZERO.test(pick.tableHash)) continue;
    if (field === 'romName' && (a === null || b === null)) continue;
    if (a !== b) out.push({ field, expected: a === null ? null : String(a), received: b === null ? null : String(b), expectedFrom });
  }
  return out;
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what a name must not hold
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** A17 step 10: a picked table's name as the lobby keeps it: no control character, no line break, one space between words. */
export function pickName(name: string): string {
  return name.replace(UNPRINTABLE, ' ').replace(/ {2,}/g, ' ').trim();
}

/** How a member's open table stands to the pick. Only meaningful when both are a table (a hash that is not zeros). */
export function tableRelation(pick: GameFingerprint, table: GameFingerprint): TableRelation {
  if (!ZERO.test(pick.tableHash) && pick.tableHash.toLowerCase() === table.tableHash.toLowerCase()) return 'same_file';
  if (pick.kind !== table.kind) return 'other';
  const rom = pick.romName?.trim().toLowerCase() || null;
  if (rom && table.romName?.trim().toLowerCase() === rom) return 'same_game';
  const whole = squash(pick.tableName);
  if (whole.length >= 3 && squash(table.tableName) === whole) return 'same_game';
  const title = titleOf(pick.tableName);
  if (title.length >= 3 && titleOf(table.tableName) === title) return 'same_game';
  return 'other';
}
