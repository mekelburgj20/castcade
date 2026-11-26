/**
 * A17 step 3 (review of PR 137, finding 1): what tells a table that somebody picked while this PC was in the lobby from
 * the lobby as this PC finds it. `ClientMatch.lobbyTable()` gives the pick with `joins`, which stands still while the
 * client is in the lobby and moves when it finds the lobby anew: at the HELLO_ACK that answers its own HELLO, and at
 * the first HELLO_ACK after a RECONNECT of its own was taken. And on the lobby's PC a pick, once made, is changed by
 * `pickTable` alone: its own table opened by hand afterwards is its row's business.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint } from '@castcade/protocol';
import type { ClientMatch } from './client.js';
import { flush, starLobby, TABLE, type StarRig } from './lobby.test-support.js';

const client = (r: StarRig, id: string): ClientMatch => r.clients[id] as ClientMatch;
const table = (tableName: string, hash: string): GameFingerprint => ({ ...TABLE, tableName, tableHash: hash.repeat(32) });
const MIN = 60_000;

describe("A17 step 3: the lobby's table, and whether this PC was there when it changed", () => {
  it('a pick made while the client is in the lobby comes under the same `joins`; one made while its link was down is found at the reconnect, under another', async () => {
    // (The limits on how often the table can change are another test's: `lobby-table-pick.test.ts`.)
    const r = await starLobby(['a', 'b'], { lobby: { pickGapMs: 0, pickMemberGapMs: 0 } });
    const a = client(r, 'a');
    expect(a.lobbyTable()).toMatchObject({ game: { tableName: TABLE.tableName }, joins: 1 });
    // b picks another table: every member hears it, and a was there.
    expect(r.host.pickTable(table('Attack from Mars', 'cd'), 'b')).toBeNull();
    await flush();
    expect(a.lobbyTable()).toMatchObject({ game: { tableName: 'Attack from Mars' }, joins: 1 });
    // More words on the lobby (a member's choice) change nothing of it.
    client(r, 'b').updateInLobby({ stance: 'watch' });
    await flush();
    expect(a.lobbyTable()).toMatchObject({ game: { tableName: 'Attack from Mars' }, joins: 1 });

    // a's link drops; b picks again meanwhile; a comes back with RECONNECT.
    await r.cut('a');
    await r.tick(5000);
    expect(r.host.pickTable(table('Medieval Madness', 'ef'), 'b')).toBeNull();
    await flush();
    expect(a.lobbyTable()).toMatchObject({ game: { tableName: 'Attack from Mars' }, joins: 1 });
    await r.mend('a');
    expect(r.events['a']?.slice(-1)).toEqual(['reconnected 0']);
    // The lobby as a finds it: the table is another one and so is `joins`, in the same answer.
    expect(a.lobbyTable()).toMatchObject({ game: { tableName: 'Medieval Madness' }, joins: 2 });
    // And from here a pick is a change again.
    expect(r.host.pickTable(table('Attack from Mars', 'cd'), 'b')).toBeNull();
    await flush();
    expect(a.lobbyTable()).toMatchObject({ game: { tableName: 'Attack from Mars' }, joins: 2 });
  });

  it('a place that ran out and the join again as a newcomer: found anew', async () => {
    const r = await starLobby(['a', 'b']);
    const a = client(r, 'a');
    await r.cut('a');
    await r.tick(5000);
    await r.tick(3 * MIN);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'b']);
    expect(r.host.pickTable(table('Attack from Mars', 'cd'), 'b')).toBeNull();
    const at = r.events['a']?.length ?? 0;
    await r.mend('a');
    expect(r.events['a']?.slice(at, at + 3)).toEqual(['reconnectRejected unknown_player', 'rejoining', 'joined']);
    expect(a.lobbyTable()).toMatchObject({ game: { tableName: 'Attack from Mars' }, joins: 2 });
  });

  it("on the lobby's PC a pick, once made, is only changed by a pick: its own table opened by hand afterwards is not one", async () => {
    const r = await starLobby(['a']);
    const a = client(r, 'a');
    expect(r.host.table()).toMatchObject({ game: { tableName: TABLE.tableName }, pickedBy: 'h' });
    // The owner of the lobby's PC closes that table and opens another.
    r.host.updateLocal({ game: table('Attack from Mars', 'cd') });
    await flush();
    expect(r.host.table().game.tableName).toBe(TABLE.tableName);
    expect(a.lobbyTable()).toMatchObject({ game: { tableName: TABLE.tableName }, joins: 1 });
  });
});
