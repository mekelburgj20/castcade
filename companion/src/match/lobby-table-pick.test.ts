/**
 * A17 step 10 (2026-11-26, alpha-match.md 11.5): the lobby's table changes. The engine's side: how often it can change,
 * what a pick carries beside its identity keys (the Castcade VPX build's identity of the picked table), what a
 * member's row is compared on, and where each PC stands on its way to the new table. The pick itself, who may make
 * it and when, is `lobby-start.test.ts` ("the lobby`s table is a pick").
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint } from '@castcade/protocol';
import type { ClientMatch } from './client.js';
import { PICK_GAP_MS, PICK_MEMBER_GAP_MS } from './host.js';
import { countDown, flush, NO_TABLE, starLobby, TABLE, type StarRig } from './lobby.test-support.js';
import { compareWithPick, pickName, pickOf } from './table-identity.js';

const client = (r: StarRig, id: string): ClientMatch => r.clients[id] as ClientMatch;
const table = (tableName: string, hash: string, romName: string | null = null): GameFingerprint => ({ ...TABLE, tableName, tableHash: hash.repeat(32), romName });
const AFM = table('Attack from Mars', 'cd');
const MM = table('Medieval Madness', 'ef');
const CONGO = { editables: 617, hash: '9f3a61c2d4e5b701' };
const CC = { editables: 1203, hash: '00aa11bb22cc33dd' };
const UNHASHED = '0'.repeat(64);

describe("A17 step 10: how often the lobby's table can change", () => {
  it('the numbers: 10 s between two picks by anyone, 30 s between two picks by one member', () => {
    expect([PICK_GAP_MS, PICK_MEMBER_GAP_MS]).toEqual([10_000, 30_000]);
  });

  it('a second pick by the same member inside 30 s, and a pick by anyone inside 10 s of the last, are refused with a sentence; the table it already is is no pick at all', async () => {
    const r = await starLobby(['a', 'b']);
    expect(r.host.pickTable(AFM, 'a')).toBeNull();
    // The same member again, at once and 29 s later.
    expect(r.host.pickTable(MM, 'a')).toBe("You changed the lobby's table a moment ago: you can change it again in 30 s.");
    await r.tick(29_000);
    expect(r.host.pickTable(MM, 'a')).toBe("You changed the lobby's table a moment ago: you can change it again in 1 s.");
    // Somebody else, 29 s after that pick: theirs is taken (the lobby's 10 s are over).
    expect(r.host.pickTable(MM, 'b')).toBeNull();
    // And the first member, 1 s later (their own 30 s are over): the lobby's 10 s are not.
    await r.tick(1_000);
    expect(r.host.pickTable(AFM, 'a')).toBe("The lobby's table was changed a moment ago: it can be changed again in 9 s.");
    // Picking the table the lobby already has changes nothing and counts for nothing.
    expect(r.host.pickTable(MM, 'a')).toBeNull();
    expect(r.host.table().pickedBy).toBe('b');
    await r.tick(9_000);
    expect(r.host.pickTable(AFM, 'a')).toBeNull();
    expect(r.host.table()).toEqual({ game: pickOf(AFM), pickedBy: 'a' });
  });

  it('a member who is refused is told why; nobody else hears of it, and the table stands', async () => {
    const r = await starLobby(['a', 'b']);
    client(r, 'a').pickTable(AFM);
    await flush();
    const acks = r.sent('h', 'b').filter((m) => m.type === 'HELLO_ACK').length;
    client(r, 'a').pickTable(MM);
    await flush();
    expect(r.said['a']).toEqual(["You changed the lobby's table a moment ago: you can change it again in 30 s."]);
    expect(r.said['b'] ?? []).toEqual([]);
    expect(r.sent('h', 'b').filter((m) => m.type === 'HELLO_ACK').length).toBe(acks);
    expect(r.lobby('b').hostGame?.tableName).toBe('Attack from Mars');
  });

  it("a pick refused for another reason does not start the limits; a member's own time runs on while they are out of the lobby", async () => {
    const r = await starLobby(['a', 'b'], { lobby: { placeMs: 10_000 } });
    r.host.requestStart();
    await flush();
    expect(r.host.pickTable(AFM, 'a')).toBe('A match is starting: cancel the start to change the table.');
    r.host.cancelStart();
    await flush();
    expect(r.host.pickTable(AFM, 'a')).toBeNull();
    // The member's place runs out (their link is down for 15 s) and they join again as a newcomer: their own 30 s still run.
    await r.cut('a');
    await r.tick(5_000);
    await r.tick(10_000);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'b']);
    await r.mend('a');
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'b', 'a']);
    expect(r.host.pickTable(MM, 'a')).toMatch(/^You changed the lobby's table a moment ago: you can change it again in \d+ s\.$/);
    await r.tick(15_000);
    expect(r.host.pickTable(MM, 'a')).toBeNull();
  });

  it('after a change every VPX is new: a start on the picked table waits for the 3D connections of the people who play, as any start of a lobby does', async () => {
    const r = await starLobby(['a']);
    client(r, 'a').pickTable(AFM);
    await flush();
    // Each PC closes its table and starts the picked one in the Castcade VPX build: its connection is being made again.
    client(r, 'a').updateParticipant({ game: AFM, stream3dWaitMs: 30_000 });
    r.host.updateLocal({ game: AFM });
    await flush();
    r.host.requestStart();
    await flush();
    expect(r.lobby('a').start).toMatchObject({ waitsFor: '3d', waitsOn: ['a'] });
    client(r, 'a').updateParticipant({ stream3dWaitMs: 0 });
    await countDown(r);
    expect(r.host.state.game).toEqual(AFM);
  });
});

describe('A17 step 10: what a pick is made of', () => {
  it("a picked name is kept clean, and a pick has to name a table", async () => {
    expect(pickName('  Monster\r\n\tBash   (Williams 1998) ')).toBe('Monster Bash (Williams 1998)');
    const r = await starLobby(['a'], { lobby: { pickGapMs: 0, pickMemberGapMs: 0 } });
    expect(r.host.pickTable({ ...AFM, tableName: 'Attack\r\nfrom\tMars' }, 'a')).toBeNull();
    expect(r.host.table().game.tableName).toBe('Attack from Mars');
    await flush();
    expect(r.lobby('a').hostGame?.tableName).toBe('Attack from Mars');
    expect(r.host.pickTable({ ...AFM, tableName: ' \r\n ', tableHash: UNHASHED }, 'a')).toBe('That is not a table: pick one from the list.');
    expect(r.host.pickTable(NO_TABLE, 'a')).toBe('That is not a table: pick one from the list.');
    expect(r.host.table().game.tableName).toBe('Attack from Mars');
  });

  it("the Castcade VPX build's identity of the lobby's table is the picked table's: said with the pick, and never a table the lobby's PC has open beside it", async () => {
    const r = await starLobby(['a', 'b'], { lobby: { pickGapMs: 0, pickMemberGapMs: 0 } });
    // The default pick is the lobby PC's own table: what its PC says of that table is the lobby's.
    expect(r.host.setHostTableObjects(CONGO)).toBe(true);
    await flush();
    expect(r.lobby('a').hostTableObjects).toEqual(CONGO);
    // A member picks another table and says what their copy of it holds.
    client(r, 'a').pickTable(AFM, CC);
    await flush();
    expect(r.lobby('b').hostTableObjects).toEqual(CC);
    expect(r.host.tableObjects()).toEqual(CC);
    // The lobby's PC still has its old table open, and its Castcade says that table's objects again: not the lobby's.
    expect(r.host.setHostTableObjects({ ...CONGO, editables: 618 })).toBe(false);
    expect(r.lobby('b').hostTableObjects).toEqual(CC);
    // A pick with nothing known of it: nothing is said, until the lobby's PC has that very file open.
    client(r, 'b').pickTable(MM);
    await flush();
    expect(r.lobby('a').hostTableObjects).toBeNull();
    r.host.updateLocal({ game: MM });
    expect(r.host.setHostTableObjects(CONGO)).toBe(true);
    await flush();
    expect(r.lobby('a').hostTableObjects).toEqual(CONGO);
    r.host.updateLocal({ game: AFM });
    await flush();
    expect(r.lobby('a').hostTableObjects).toBeNull();
    // The table it already is, picked again with its objects known: they are kept, and nothing else changes.
    expect(r.host.pickTable(MM, 'a', CC)).toBeNull();
    await flush();
    expect(r.lobby('b').hostTableObjects).toEqual(CC);
    expect(r.host.table().pickedBy).toBe('b');
  });

  it("the default pick: after it the lobby PC's own table opened by hand says nothing of the lobby's table", async () => {
    const r = await starLobby(['a']);
    r.host.setHostTableObjects(CONGO);
    r.host.updateLocal({ game: AFM });
    await flush();
    expect(r.host.table().game.tableName).toBe(TABLE.tableName);
    expect(r.lobby('a').hostTableObjects).toBeNull();
    expect(r.lobby('a').otherTable).toEqual(['h']);
  });

  it('a table is named a moment before its file is hashed: the default pick made at the name takes the hash when it comes', async () => {
    // The shell counts a named table as open (`isTableOpen`).
    const named = (g: GameFingerprint): boolean => g.tableHash !== UNHASHED || g.tableName !== NO_TABLE.tableName;
    const r = await starLobby(['a'], { tables: { h: NO_TABLE }, lobby: {}, tableOpen: named });
    r.host.updateLocal({ game: { ...TABLE, tableHash: UNHASHED } });
    await flush();
    expect(r.host.table()).toEqual({ game: pickOf({ ...TABLE, tableHash: UNHASHED }), pickedBy: 'h' });
    // The member has that file open: nothing can be said against it yet.
    expect(r.lobby('a').tableMismatches).toEqual([]);
    r.host.updateLocal({ game: TABLE });
    await flush();
    expect(r.host.table().game.tableHash).toBe(TABLE.tableHash);
    expect(r.lobby('a').hostGame?.tableHash).toBe(TABLE.tableHash);
    expect(r.lobby('a').tableMismatches).toEqual([]);
    // Another table by hand after that is not the pick.
    r.host.updateLocal({ game: AFM });
    await flush();
    expect(r.host.table().game.tableName).toBe(TABLE.tableName);
  });
});

describe('A17 step 10: a row is compared with the pick on what both sides know', () => {
  it('a pick before the picker`s table is open flags nobody: the same file open is the same file, whatever the pick knows of its ROM', async () => {
    // The lobby is opened with a pick from its PC's table list (with the ROM the import read); no VPX is open there.
    const pick = { ...TABLE, romName: 'mb_106b' };
    const mine = { ...TABLE, romName: null };
    const r = await starLobby(['a', 'b'], { tables: { h: NO_TABLE, a: mine, b: AFM }, lobby: { table: pick } });
    expect(r.lobby('a').hostGame).toEqual(pickOf(pick));
    // a has the picked file open: not flagged. The lobby's PC has no table open (its row is the loading one, and
    // the list of differences holds it as it holds any PC without the table). b has another game.
    expect(r.lobby('a').tableMismatches.map((t) => t.playerId)).toEqual(['h', 'b']);
    expect(r.lobby('a').loading).toEqual(['h']);
    expect(r.lobby('a').otherTable).toEqual(['b']);
    expect(Object.keys(client(r, 'a').tableMismatches()).sort()).toEqual(['b', 'h']);
    expect(compareWithPick(pickOf(pick), mine, 'h')).toEqual([]);
    // A pick whose file was never hashed says nothing of anybody's bytes; another name is still another table.
    expect(compareWithPick(pickOf({ ...TABLE, tableHash: UNHASHED }), mine, 'h')).toEqual([]);
    expect(compareWithPick(pickOf({ ...TABLE, tableHash: UNHASHED }), AFM, 'h').map((m) => m.field)).toEqual(['tableName']);
    // Two ROMs that are both known and differ are a difference.
    expect(compareWithPick(pickOf(pick), { ...mine, romName: 'mb_10' }, 'h').map((m) => m.field)).toEqual(['romName']);
  });
});

describe('A17 step 10: where each PC stands on its way to the new table', () => {
  it('a member says it, every member hears it; null takes it back; it stands across a new pick, and goes with a member who leaves', async () => {
    const r = await starLobby(['a', 'b'], { lobby: { pickGapMs: 0, pickMemberGapMs: 0 } });
    expect(r.lobby('a').tableChange).toEqual([]);
    client(r, 'a').pickTable(AFM);
    await flush();
    client(r, 'a').updateParticipant({ tableChange: 'closing' });
    client(r, 'b').updateParticipant({ tableChange: 'waits_person' });
    r.host.updateLocal({ tableChange: 'waits_game' });
    await flush();
    expect(r.lobby('b').tableChange).toEqual([
      { playerId: 'h', state: 'waits_game' },
      { playerId: 'a', state: 'closing' },
      { playerId: 'b', state: 'waits_person' },
    ]);
    // The same word again is no news.
    const acks = r.sent('h', 'b').filter((m) => m.type === 'HELLO_ACK').length;
    client(r, 'a').updateParticipant({ tableChange: 'closing' });
    await flush();
    expect(r.sent('h', 'b').filter((m) => m.type === 'HELLO_ACK').length).toBe(acks);
    client(r, 'a').updateParticipant({ tableChange: 'opening' });
    await flush();
    client(r, 'a').updateParticipant({ tableChange: null, game: AFM });
    await flush();
    expect(r.lobby('b').tableChange).toEqual([
      { playerId: 'h', state: 'waits_game' },
      { playerId: 'b', state: 'waits_person' },
    ]);
    // A start waits for the two who are not on the table yet, as it does for any other table.
    client(r, 'a').requestStart();
    await flush();
    expect(r.lobby('a').start).toMatchObject({ waitsFor: 'other_tables', waitsOn: ['h', 'b'] });
    client(r, 'a').cancelStart();
    await flush();
    // Another pick: where a PC stands is its own word until it says otherwise (one that was waiting for its person
    // still is); a member who leaves takes theirs along.
    expect(r.host.pickTable(MM, 'b')).toBeNull();
    await flush();
    expect(r.lobby('a').tableChange).toEqual([
      { playerId: 'h', state: 'waits_game' },
      { playerId: 'b', state: 'waits_person' },
    ]);
    client(r, 'b').updateParticipant({ tableChange: 'offered' });
    r.host.updateLocal({ tableChange: null });
    await flush();
    expect(r.host.tableChanges()).toEqual([{ playerId: 'b', state: 'offered' }]);
    client(r, 'b').leave();
    await flush();
    expect(r.host.tableChanges()).toEqual([]);
  });

  it('a match on the new table: everyone opens it, the rows clear, and the start counts down as any', async () => {
    const r = await starLobby(['a']);
    client(r, 'a').pickTable(AFM, CC);
    await flush();
    expect(r.lobby('a').otherTable).toEqual(['h', 'a']);
    client(r, 'a').updateParticipant({ game: NO_TABLE, tableChange: 'opening' });
    r.host.updateLocal({ game: NO_TABLE, tableChange: 'opening' });
    await flush();
    expect(r.lobby('a').loading).toEqual(['h', 'a']);
    client(r, 'a').updateParticipant({ game: AFM, tableChange: null });
    r.host.updateLocal({ game: AFM, tableChange: null });
    await flush();
    expect(r.lobby('a')).toMatchObject({ otherTable: [], loading: [], tableChange: [], tableMismatches: [], hostTableObjects: CC, tablePickedBy: 'a' });
    r.host.requestStart();
    await countDown(r);
    expect(r.host.state.game).toEqual(AFM);
    expect(r.host.openMatch()?.matchId).toBe('JHDFEF-1');
  });
});
