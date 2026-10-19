/**
 * Composes the three identity modules into a `TableIdentity` for one session (F1 of
 * `docs/design/fairness-and-table-identity.md`).
 *
 * Two phases, because the evidence arrives at two moments: at LAUNCH the companion knows the file
 * (from `-Play`, or found under the tables folder from the editor title) and reads its TableInfo,
 * which names the game by table name / manufacturer / year and the table by author / version; at
 * CAPTURE it also knows the ROM, which pins the game more reliably than any name. The second phase
 * only ever upgrades: a ROM hit replaces a name-based game, never the other way round.
 *
 * The player's one-time confirmation ("this file is VPS table X") wins over the matcher whenever the
 * confirmed table belongs to the resolved game. The whole-file hash is computed in the background
 * after the cheap facts and filled in when it lands; identity never delays a post.
 */
import type { WitnessFs } from './fs.js';
import type { IdentityStore } from './identity-store.js';
import type { GameMatch, MatchConfidence, TableIdentity, TableMatch, VpsGameEntry, VpsIndex, VpsTableEntry, VpxFileFacts } from './identity-types.js';
import { matchGame, matchTable } from './table-match.js';
import { tableLabel } from './vps-index.js';
import { readVpxFacts, sha256File } from './vpx-file.js';

export interface IdentityResolverDeps {
  fs: WitnessFs;
  index: VpsIndex;
  store: IdentityStore;
  now: () => number;
  log?: (line: string) => void;
}

export interface IdentityResolver {
  /** Phase 1: what the file (or, failing that, the file name) says. Never throws. */
  fromFile(filePath: string | null, fileName: string | null): Promise<TableIdentity>;
  /** Phase 2: upgrade the game (and re-match the table) with the ROM seen at capture. Never throws. */
  withRom(identity: TableIdentity, rom: string | null, romName: string | null): Promise<TableIdentity>;
  /** Compute the whole-file SHA-256 (cached by path/size/mtime). Resolves to the identity with `sha256` set. */
  hash(identity: TableIdentity): Promise<TableIdentity>;
  /** Re-apply the stored confirmation for the identity's file (after `confirmTable`). */
  applyConfirmation(identity: TableIdentity): TableIdentity;
}

const EMPTY: Omit<TableIdentity, 'filePath'> = {
  vpsGame: null,
  gameConfidence: 'none',
  gameSource: 'none',
  vpsTable: null,
  tableConfidence: 'none',
  confirmed: false,
  tableChoices: [],
  sha256: null,
  saveRev: null,
  tableInfo: null,
  physics: null,
  notes: [],
};

function gameRef(g: VpsGameEntry) {
  return { id: g.id, name: g.name, manufacturer: g.manufacturer, year: g.year };
}

function tableRef(t: VpsTableEntry) {
  return { id: t.id, label: tableLabel(t) };
}

const RANK: Record<MatchConfidence, number> = { none: 0, ambiguous: 1, likely: 2, exact: 3 };

export function createIdentityResolver(deps: IdentityResolverDeps): IdentityResolver {
  const { fs, index, store } = deps;
  const log = deps.log ?? (() => {});
  /** Facts keyed by the store key, kept in memory for the hash step (the store caches them on disk too). */
  const facts = new Map<string, { key: string; facts: VpxFileFacts }>();

  const applyGame = (identity: TableIdentity, match: GameMatch, fileName: string | null): TableIdentity => {
    const next: TableIdentity = { ...identity, notes: [...identity.notes] };
    if (!match.game) {
      if (match.candidates.length > 1) next.notes.push(`${match.candidates.length} VPS games could match; not guessing`);
      return next;
    }
    const changed = next.vpsGame?.id !== match.game.id;
    next.vpsGame = gameRef(match.game);
    next.gameConfidence = match.confidence;
    next.gameSource = match.source;
    if (changed || next.tableChoices.length === 0) {
      const tm: TableMatch = matchTable(match.game, { fileName, tableInfo: next.tableInfo });
      next.tableChoices = tm.candidates.map((c) => tableRef(c.table));
      next.vpsTable = tm.table ? tableRef(tm.table) : null;
      next.tableConfidence = tm.confidence;
      next.confirmed = false;
      if (tm.table && tm.candidates[0]?.reasons.length) next.notes.push(`table matched on ${tm.candidates[0].reasons.join(', ')}`);
      if (tm.confidence === 'ambiguous') next.notes.push('several VPS tables fit; please confirm which one in Status');
    }
    return applyConfirmation(next);
  };

  const applyConfirmation = (identity: TableIdentity): TableIdentity => {
    if (!identity.filePath) return identity;
    const c = store.confirmation(identity.filePath);
    if (!c || !c.vpsTableId) {
      if (identity.confirmed) {
        // The confirmation was forgotten: fall back to the matcher's own answer.
        return { ...identity, confirmed: false, vpsTable: identity.tableChoices[0] ?? null, tableConfidence: identity.tableChoices.length === 1 ? 'exact' : identity.tableChoices.length > 1 ? 'ambiguous' : 'none' };
      }
      return identity;
    }
    const chosen = identity.tableChoices.find((t) => t.id === c.vpsTableId);
    if (!chosen) return identity; // confirmed for a different game than the one resolved now
    return { ...identity, vpsTable: chosen, tableConfidence: 'exact', confirmed: true };
  };

  return {
    async fromFile(filePath, fileName) {
      let identity: TableIdentity = { ...EMPTY, filePath, notes: [] };
      if (filePath) {
        try {
          const st = await fs.stat(filePath);
          const key = store.key(filePath, st.size, st.mtimeMs);
          const cached = store.facts(key);
          let f: VpxFileFacts;
          if (cached) {
            f = { path: filePath, size: st.size, mtimeMs: st.mtimeMs, fileVersion: cached.fileVersion, tableInfo: cached.tableInfo, physics: cached.physics, scriptBytes: cached.scriptBytes };
            identity.sha256 = cached.sha256;
          } else {
            f = await readVpxFacts(fs, filePath);
            await store.setFacts(key, { fileVersion: f.fileVersion, tableInfo: f.tableInfo, physics: f.physics, scriptBytes: f.scriptBytes, sha256: null, computedAt: new Date(deps.now()).toISOString() });
          }
          facts.set(filePath, { key, facts: f });
          identity.tableInfo = f.tableInfo;
          identity.physics = f.physics;
          identity.saveRev = f.tableInfo.saveRev;
          identity.notes.push(`table info read from the file${cached ? ' (cached)' : ''}`);
        } catch (err) {
          identity.notes.push(`could not read the table file: ${err instanceof Error ? err.message : String(err)}`);
          log(`identity: ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        identity.notes.push('table file not found; identity from the name only');
      }
      try {
        const gm = await matchGame(index, { rom: null, romName: null, fileName, tableInfo: identity.tableInfo });
        identity = applyGame(identity, gm, fileName);
      } catch (err) {
        identity.notes.push(`VPS index unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      return identity;
    },

    async withRom(identity, rom, romName) {
      if (!rom) return identity;
      try {
        const fileName = identity.filePath ? identity.filePath.replace(/^.*[\\/]/, '').replace(/\.vpx$/i, '') : null;
        const gm = await matchGame(index, { rom, romName, fileName, tableInfo: identity.tableInfo });
        if (!gm.game) return identity;
        const better = RANK[gm.confidence] > RANK[identity.gameConfidence] || gm.source === 'rom';
        if (!better && identity.vpsGame) return identity;
        const next = applyGame(identity, gm, fileName);
        next.notes.push(`game pinned by ROM ${rom}`);
        return next;
      } catch (err) {
        return { ...identity, notes: [...identity.notes, `ROM lookup failed: ${err instanceof Error ? err.message : String(err)}`] };
      }
    },

    async hash(identity) {
      if (!identity.filePath || identity.sha256) return identity;
      const known = facts.get(identity.filePath);
      try {
        const sha256 = await sha256File(fs, identity.filePath);
        if (known) await store.setSha256(known.key, sha256);
        return { ...identity, sha256 };
      } catch (err) {
        return { ...identity, notes: [...identity.notes, `hash failed: ${err instanceof Error ? err.message : String(err)}`] };
      }
    },

    applyConfirmation,
  };
}
