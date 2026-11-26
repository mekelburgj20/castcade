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
import { countDown, flush, NO_TABLE, OTHER_GAME as OTHER, playGame, starLobby, TABLE, type StarRig } from './lobby.test-support.js';
import { compareWithPick, pickName, pickOf, sameTableAs, tableWords } from './table-identity.js';

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
    // The table it already is, picked again by somebody who did not pick it: nothing is taken from them.
    expect(r.host.pickTable(MM, 'a', CC)).toBeNull();
    await flush();
    expect(r.lobby('b').hostTableObjects).toBeNull();
    // By its picker, with its objects known now: they are kept, and nothing else changes.
    expect(r.host.pickTable(MM, 'b', CC)).toBeNull();
    await flush();
    expect(r.lobby('a').hostTableObjects).toEqual(CC);
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
    // Two ROMs that are both known and differ are a difference (of another file: the same bytes are the same table).
    expect(compareWithPick(pickOf(pick), { ...mine, tableHash: '77'.repeat(32), romName: 'mb_10' }, 'h').map((m) => m.field)).toEqual(['tableHash', 'romName']);
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

describe("A17 step 10, review of PR 139: the table the lobby already has, and a PC's own copy of it", () => {
  /** The shell counts a named table as open (`isTableOpen`): a pick can be by name alone. */
  const named = (g: GameFingerprint): boolean => g.tableHash !== UNHASHED || g.tableName !== NO_TABLE.tableName;
  const FALSE = { editables: 1, hash: 'ffffffffffffffff' };

  it('a pick that differs from the lobby`s table only in letter case, or adds a file hash, a ROM or the table objects, is no change: it ends no match, moves no "picked by" and drops nothing that was known', async () => {
    const r = await starLobby(['a', 'b'], { lobby: { pickGapMs: 0, pickMemberGapMs: 0 }, tableOpen: named });
    const picked: string[] = [];
    r.host.on('tablePicked', (p) => picked.push(p.by));
    r.host.setHostTableObjects(CONGO);
    r.host.requestStart();
    await countDown(r);
    await playGame(r);
    expect(r.host.openMatch()?.matchId).toBe('JHDFEF-1');
    const before = r.host.table();
    expect(before).toEqual({ game: pickOf(TABLE), pickedBy: 'h' });
    // Another member, by name only, in capitals: the same table. The hash, the ROM and the objects the lobby had stay.
    expect(r.host.pickTable({ ...TABLE, tableName: TABLE.tableName.toUpperCase(), tableHash: UNHASHED, romName: null }, 'a', FALSE)).toBeNull();
    client(r, 'b').pickTable({ ...TABLE, tableName: ` ${TABLE.tableName.toLowerCase()} `, romName: null });
    await flush();
    expect(r.host.table()).toEqual(before);
    expect(r.host.tableObjects()).toEqual(CONGO);
    expect(r.lobby('a').hostGame).toEqual(pickOf(TABLE));
    expect(r.host.openMatch()?.matchId).toBe('JHDFEF-1');
    expect(picked).toEqual([]);
    expect(r.said['b'] ?? []).toEqual([]);
    // The same name with another file's hash is another file: that is a pick, and it ends the match.
    expect(r.host.pickTable({ ...TABLE, tableHash: '77'.repeat(32) }, 'a')).toBeNull();
    expect(picked).toEqual(['a']);
    expect(r.host.openMatch()).toBeNull();
  });

  it('a pick made by name alone takes its file hash and its ROM when its picker says them later, and keeps them when somebody else picks it by name', async () => {
    const byName = { ...TABLE, tableHash: UNHASHED, romName: null };
    const r = await starLobby(['a', 'b'], { tables: { h: NO_TABLE }, lobby: { pickGapMs: 0, pickMemberGapMs: 0 }, tableOpen: named });
    client(r, 'a').pickTable(byName);
    await flush();
    expect(r.host.table()).toEqual({ game: pickOf(byName), pickedBy: 'a' });
    // Somebody else adds nothing to another person's pick.
    client(r, 'b').pickTable(TABLE, FALSE);
    await flush();
    expect(r.host.table().game.tableHash).toBe(UNHASHED);
    expect(r.host.tableObjects()).toBeNull();
    // Its picker does: the hash, the ROM, the table objects.
    client(r, 'a').pickTable(TABLE, CC);
    await flush();
    expect(r.host.table()).toEqual({ game: pickOf(TABLE), pickedBy: 'a' });
    expect(r.lobby('b').hostGame).toEqual(pickOf(TABLE));
    expect(r.lobby('b').hostTableObjects).toEqual(CC);
    // By name alone again, by anyone: nothing is erased.
    client(r, 'b').pickTable(byName);
    client(r, 'a').pickTable(byName);
    await flush();
    expect(r.host.table()).toEqual({ game: pickOf(TABLE), pickedBy: 'a' });
    expect(r.lobby('b').hostTableObjects).toEqual(CC);
  });

  it("the table objects of the table the lobby has: only from the member who picked it or from the lobby's PC, inside the limits; the owner corrects a wrong value; the lobby PC's own VPX word replaces them while its table is the picked file", async () => {
    const r = await starLobby(['a', 'b']);
    client(r, 'b').pickTable(MM);
    await flush();
    // A member who did not make the pick names the lobby's table with table objects of their choosing: not taken.
    client(r, 'a').pickTable(MM, FALSE);
    await flush();
    expect(r.host.tableObjects()).toBeNull();
    expect(r.lobby('b').hostTableObjects).toBeNull();
    expect(r.said['a'] ?? []).toEqual([]);
    // The picker at once: inside the limits, like a change.
    client(r, 'b').pickTable(MM, CC);
    await flush();
    expect(r.said['b']).toEqual(["You changed the lobby's table a moment ago: you can change it again in 30 s."]);
    expect(r.host.tableObjects()).toBeNull();
    await r.tick(30_000);
    client(r, 'b').pickTable(MM, FALSE);
    await flush();
    expect(r.lobby('a').hostTableObjects).toEqual(FALSE);
    // The lobby's PC is held by the lobby's own 10 s too, then corrects the value; "picked by" stays.
    expect(r.host.pickTable(MM, 'h', CC)).toBe("The lobby's table was changed a moment ago: it can be changed again in 10 s.");
    await r.tick(10_000);
    expect(r.host.pickTable(MM, 'h', CC)).toBeNull();
    await flush();
    expect(r.lobby('a').hostTableObjects).toEqual(CC);
    expect(r.host.table().pickedBy).toBe('b');
    // The lobby PC's own VPX has the picked file open and says what it holds: that word is the lobby's while it stands.
    r.host.updateLocal({ game: MM });
    expect(r.host.setHostTableObjects(CONGO)).toBe(true);
    await flush();
    expect(r.lobby('a').hostTableObjects).toEqual(CONGO);
    // Its table is another one again: what was said with the pick.
    r.host.updateLocal({ game: AFM });
    await flush();
    expect(r.lobby('a').hostTableObjects).toEqual(CC);
  });

  it("every pick that reaches the lobby's PC is told with who made it and what became of it, taken or not", async () => {
    const r = await starLobby(['a', 'b']);
    const judged: string[] = [];
    r.host.on('tablePickJudged', (j) => judged.push(`${j.byName} (${j.by}) ${j.outcome} ${j.table}${j.why ? `: ${j.why}` : ''}`));
    client(r, 'a').pickTable({ ...AFM, tableName: 'Attack\r\nfrom\tMars' }, CC);
    await flush();
    client(r, 'a').pickTable(MM);
    client(r, 'b').pickTable(AFM);
    await flush();
    await r.tick(30_000);
    client(r, 'a').pickTable(AFM, CONGO);
    await flush();
    r.host.requestStart();
    await flush();
    client(r, 'b').pickTable(MM);
    await flush();
    expect(judged).toEqual([
      'A (a) changed Attack from Mars',
      "A (a) refused Medieval Madness: You changed the lobby's table a moment ago: you can change it again in 30 s.",
      'B (b) same Attack from Mars',
      'A (a) added Attack from Mars',
      'B (b) refused Medieval Madness: A match is starting: cancel the start to change the table.',
    ]);
  });

  it("finding 1: a PC says that its open table is its own copy of the lobby's table: the lobby does not call it another table, for as long as the word names the lobby's table and the table that row names", async () => {
    const pick = table('Attack from Mars', 'cd', 'afm_113b');
    // A copy whose file and names share nothing with the title: the PC found it by the ROM its own list knows.
    const copy = table('AFM_VPW_v1.2', '77');
    const word = { pick: 'Attack from Mars', tableName: copy.tableName, tableHash: copy.tableHash };
    const r = await starLobby(['a', 'b'], { lobby: { pickGapMs: 0, pickMemberGapMs: 0 } });
    expect(r.host.pickTable(pick, 'b')).toBeNull();
    r.host.updateLocal({ game: { ...pick, romName: null } });
    client(r, 'b').updateParticipant({ game: { ...pick, romName: null } });
    client(r, 'a').updateParticipant({ game: copy });
    await flush();
    // What the review found: the row names another table, and a start waits for that person for ever.
    expect(r.lobby('b').otherTable).toEqual(['a']);
    r.host.requestStart();
    await flush();
    expect(r.lobby('a').start).toMatchObject({ waitsFor: 'other_tables', waitsOn: ['a'] });
    // The PC says it: the start waits no longer. The lobby still says that the file differs (the advisory).
    client(r, 'a').updateParticipant({ pickCopy: word });
    await flush();
    expect(r.lobby('b').otherTable).toEqual([]);
    expect(r.lobby('b').start).toMatchObject({ waitsFor: null });
    expect(r.lobby('b').tableMismatches.find((t) => t.playerId === 'a')?.mismatches.map((x) => x.field)).toEqual(['tableName', 'tableHash']);
    r.host.cancelStart();
    await flush();
    // The word is about one table: another table in that row is another table again.
    client(r, 'a').updateParticipant({ game: OTHER });
    await flush();
    expect(r.lobby('b').otherTable).toEqual(['a']);
    client(r, 'a').updateParticipant({ game: copy });
    await flush();
    expect(r.lobby('b').otherTable).toEqual([]);
    // And about one pick: the lobby's table changes, and the copy of the table before is no copy of it.
    expect(r.host.pickTable(MM, 'b')).toBeNull();
    await flush();
    expect(r.lobby('b').otherTable).toEqual(['h', 'a', 'b']);
    expect(r.host.pickTable(pick, 'a')).toBeNull();
    await flush();
    expect(r.lobby('b').otherTable).toEqual([]);
    // Taken back with null; and the lobby PC's own row says it the same way.
    client(r, 'a').updateParticipant({ pickCopy: null });
    r.host.updateLocal({ game: copy });
    await flush();
    expect(r.lobby('b').otherTable).toEqual(['h', 'a']);
    r.host.updateLocal({ pickCopy: word });
    await flush();
    expect(r.lobby('b').otherTable).toEqual(['a']);
    // A newcomer with such a copy has said nothing yet.
    await r.join('c', { game: copy });
    expect(r.lobby('b').otherTable).toEqual(['a', 'c']);
  });

  it('finding 1: the word is said again by itself when the member comes back after a dropped link', async () => {
    const pick = table('Attack from Mars', 'cd', 'afm_113b');
    const copy = table('AFM_VPW_v1.2', '77');
    const r = await starLobby(['a', 'b'], { lobby: { pickGapMs: 0, pickMemberGapMs: 0, placeMs: 10_000 } });
    expect(r.host.pickTable(pick, 'b')).toBeNull();
    client(r, 'a').updateParticipant({ game: copy, pickCopy: { pick: pick.tableName, tableName: copy.tableName, tableHash: copy.tableHash } });
    await flush();
    expect(r.lobby('b').otherTable).not.toContain('a');
    // The place runs out while the link is down; the member joins again as a newcomer and says its row again.
    await r.cut('a');
    await r.tick(5_000);
    await r.tick(10_000);
    expect(r.host.members().map((p) => p.playerId)).not.toContain('a');
    await r.mend('a');
    await flush();
    expect(r.host.members().map((p) => p.playerId)).toContain('a');
    expect(r.lobby('b').otherTable).not.toContain('a');
  });

  it('finding 6: a PC that says its table is closing has no table for a start, whatever its row still names', async () => {
    const r = await starLobby(['a']);
    client(r, 'a').updateParticipant({ tableChange: 'closing' });
    await flush();
    r.host.requestStart();
    await flush();
    expect(r.lobby('a').start).toMatchObject({ waitsFor: 'tables', waitsOn: ['a'] });
    // It has closed, and the table is open again: the start counts down.
    client(r, 'a').updateParticipant({ game: NO_TABLE, tableChange: 'opening' });
    await flush();
    expect(r.lobby('a').start).toMatchObject({ waitsFor: 'tables', waitsOn: ['a'] });
    client(r, 'a').updateParticipant({ game: TABLE, tableChange: null });
    await flush();
    expect(r.lobby('a').start).toMatchObject({ waitsFor: null });
  });

  it('finding 8: the same bytes are the same table whatever the pick is named; names are compared as they are shown', () => {
    const mine = { ...TABLE, romName: null };
    // A pick named from the file where the row is named from the table's own name: the identical file.
    expect(compareWithPick(pickOf({ ...TABLE, tableName: 'mb_vpw_1.1' }), mine, 'h')).toEqual([]);
    // Two spaces, a line break, other letter case: one name.
    expect(compareWithPick(pickOf({ ...TABLE, tableHash: UNHASHED, tableName: 'Monster  Bash\n(Williams 1998) 2.1' }), { ...mine, tableName: 'monster bash (williams 1998) 2.1' }, 'h')).toEqual([]);
    expect(sameTableAs(pickOf(TABLE), { ...TABLE, tableName: TABLE.tableName.toUpperCase(), tableHash: UNHASHED, romName: null })).toBe(true);
    expect(sameTableAs(pickOf(TABLE), { ...TABLE, romName: 'mb_10' })).toBe(false);
    expect(tableWords(`  Attack\u0007 from\r\nMars ${'x'.repeat(200)}`)).toHaveLength(80);
  });
});
