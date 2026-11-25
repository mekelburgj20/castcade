/**
 * A17 step 10 (2026-11-26, alpha-match.md 11.5): the lobby scenarios of the table change. A member picks another
 * table between the games of an open match: that match ends at its tally, every PC opens the picked table, and a new
 * match is played on it; and a pick while a start counts down is refused with a sentence. What must hold after every
 * lobby scenario is `lobbyProblems`.
 */
import { describe, expect, it } from 'vitest';
import { lobbyProblems, runLobbyScenario } from './lobby.js';
import { defaultFingerprint, loadScenario } from './scenario.js';

const AFM = 'Attack from Mars (Bally 1995) VPW 1.1';
const AFM_HASH = 'ef'.repeat(32);

describe('A17 step 10: the table changes in a lobby', () => {
  it("lobby-table-change: a pick between games ends the open match at its tally; everyone opens the table; the next match is on it", async () => {
    const run = await runLobbyScenario(loadScenario('lobby-table-change'));
    expect(lobbyProblems(run)).toEqual([]);
    for (const id of ['p1', 'p2', 'p3']) {
      const [m1, m2] = run.outcomes[id]?.matches ?? [];
      // The first match: one game on the table the lobby was opened with, ended by the pick, its tally kept.
      expect(m1?.matchId, id).toBe('TBLCHG-1');
      expect(m1?.ready.game.tableName, id).toBe(defaultFingerprint.tableName);
      expect(m1?.results, id).toHaveLength(1);
      expect(m1?.end, id).toMatchObject({ games: 1, reason: 'the table changed' });
      // The second: a new match, on the picked table. Its fingerprint is a full one (the open table of its first
      // player), never the pick: the pick holds the identity keys alone.
      expect(m2?.matchId, id).toBe('TBLCHG-2');
      expect(m2?.ready.playerOrder, id).toEqual(['p2', 'p1']);
      expect(m2?.ready.game, id).toMatchObject({ tableName: AFM, tableHash: AFM_HASH, romName: 'afm_113b', recipeVersion: defaultFingerprint.recipeVersion });
      expect(m2?.results, id).toHaveLength(1);
      expect(m2?.head, id).toEqual(run.outcomes['p1']?.matches[1]?.head);
    }
    // What every member last heard of the lobby: the pick (its identity keys), who made it, what the Castcade VPX
    // build says of it, and nobody on another table.
    for (const id of ['p2', 'p3']) {
      const l = run.outcomes[id]?.lobby;
      expect(l?.hostGame, id).toEqual({ kind: 'vpx', tableName: AFM, tableHash: AFM_HASH, romName: 'afm_113b', romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '' });
      expect(l?.tablePickedBy, id).toBe('p2');
      expect(l?.hostTableObjects, id).toEqual({ editables: 1203, hash: '00aa11bb22cc33dd' });
      expect([l?.otherTable, l?.loading, l?.tableMismatches], id).toEqual([[], [], []]);
    }
    // One pick, by a client, and nobody was refused anything.
    expect(run.outcomes['p2']?.sent['TABLE_PICK']).toBe(1);
    expect(run.outcomes['p1']?.refusals).toEqual([]);
  });

  it('lobby-pick-during-start: refused with the sentence; the start goes on, on the table the lobby had', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-pick-during-start'));
    expect(lobbyProblems(run, { rejects: ['p2'] })).toEqual([]);
    expect(run.outcomes['p2']?.rejects.map((r) => [r.refType, r.message])).toEqual([['TABLE_PICK', 'A match is starting: cancel the start to change the table.']]);
    for (const id of ['p1', 'p2']) {
      const [m1] = run.outcomes[id]?.matches ?? [];
      expect(m1?.ready.game.tableName, id).toBe(defaultFingerprint.tableName);
      expect(m1?.results, id).toHaveLength(1);
      expect(run.outcomes[id]?.lobby?.hostGame?.tableName, id).toBe(defaultFingerprint.tableName);
      expect(run.outcomes[id]?.lobby?.tablePickedBy, id).toBe('p1');
    }
    expect(run.outcomes['p2']?.starts).toEqual(['p1:p1,p2:new:countdown']);
  });
});
