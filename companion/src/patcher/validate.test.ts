import { describe, expect, it } from 'vitest';
import { classifyScript } from './classify.js';
import { renderSidecar } from './render-originals.js';
import type { RenderOptions } from './render.js';
import { decodeScript, splitScript } from './script-text.js';
import {
  BURGER_BALLS_B_SCRIPT,
  BURGER_B_SCRIPT,
  DIABLO_B_SCRIPT,
  FUTURAMA_B_SCRIPT,
  GLF_B_SCRIPT,
  GOT_B_SCRIPT,
  JACKS_B_SCRIPT,
  JPSALAS_B_SCRIPT,
  MATRIX_B_SCRIPT,
  ORIGINAL_B_SCRIPT,
  RATTLECAN_B_SCRIPT,
  RATTLECAN_TILT_B_SCRIPT,
  SCORBIT_C_SCRIPT,
  SCORESERVER_D_SCRIPT,
  VPM_SCRIPT,
  crlf,
  lf,
  mixed,
  noFinalNewline,
} from './test-scripts.test-support.js';
import { blockBalance, checkGameJournal, lintSidecar, resourceFolders } from './validate.js';

const OPTS: RenderOptions = { tableId: 'T', rom: null, originalPath: 'C:\\VPX\\tables\\T.vpx', originalSize: 1, originalMtimeMs: 0, sidecarPath: 'C:\\VPX\\tables\\T.vbs' };
const rendered = (text: string): string => decodeScript(renderSidecar(text, classifyScript(text), OPTS).bytes);

const ALL: Record<string, readonly string[]> = {
  VPM_SCRIPT,
  ORIGINAL_B_SCRIPT,
  JPSALAS_B_SCRIPT,
  MATRIX_B_SCRIPT,
  GOT_B_SCRIPT,
  DIABLO_B_SCRIPT,
  JACKS_B_SCRIPT,
  FUTURAMA_B_SCRIPT,
  RATTLECAN_B_SCRIPT,
  RATTLECAN_TILT_B_SCRIPT,
  BURGER_B_SCRIPT,
  BURGER_BALLS_B_SCRIPT,
  GLF_B_SCRIPT,
  SCORBIT_C_SCRIPT,
  SCORESERVER_D_SCRIPT,
};

describe('lintSidecar (static validation of a rendered sidecar)', () => {
  it('finds nothing in the sidecar of any recipe, in every line-ending shape', () => {
    for (const [name, script] of Object.entries(ALL)) {
      for (const text of [crlf(script), lf(script), mixed(script, 2, 12), noFinalNewline(script)]) {
        expect(lintSidecar(text, rendered(text)), name).toEqual([]);
      }
    }
  });

  it('blockBalance counts block statements, not one-line Ifs, continued statements or words in strings and comments', () => {
    const L = [
      'Sub A() : x = 1 : End Sub',
      'Function F(a, _',
      '    b)',
      '    If a Then b = 1',
      '    If a Then',
      "        MsgBox \"End Sub\" ' End If",
      '    ElseIf b Then : c = 1',
      '    End If',
      '    Select Case a : Case 1 : b = 2 : End Select',
      '    For i = 0 To 3 : Next',
      '    Do While a',
      '    Loop',
      '    With o',
      '    End With',
      'End Function',
      'Class K',
      '    Public Property Get P : P = 1 : End Property',
      'End Class',
    ];
    expect(blockBalance(L)).toEqual({ If: 0, Sub: 0, Function: 0, Property: 0, Class: 0, Select: 0, With: 0, For: 0, Do: 0, While: 0 });
    expect(blockBalance(['Sub A()', '    If x Then', 'End Sub'])).toMatchObject({ If: 1, Sub: 0 });
  });

  it('names an inexact undo, a line outside a sub, a line after Select Case, a missing anchor sub and a doubled handler', () => {
    const text = crlf(JPSALAS_B_SCRIPT);
    const good = rendered(text);
    const L = splitScript(good).lines;
    const join = (lines: string[]): string => lines.join('\r\n') + '\r\n';
    const ANCHOR = "    Castcade_B_BallEnd   ' Castcade: ball end";

    // a person's edit inside the sidecar: the undo no longer gives the table's script
    expect(lintSidecar(text, good.replace('Score(CurrentPlayer) + points', 'Score(CurrentPlayer) + points * 2'))).toEqual([expect.stringMatching(/^the undo is not exact: first difference at byte \d+/)]);

    // the anchor line moved out of its sub
    const at = L.indexOf(ANCHOR);
    const outside = [...L.slice(0, at - 1), ANCHOR, ...L.slice(at - 1, at), ...L.slice(at + 1)];
    expect(lintSidecar(text, join(outside))).toEqual([expect.stringMatching(/^line \d+ \(Castcade_B_BallEnd\) is outside any Sub or Function$/)]);

    // a statement between Select Case and its first Case is a syntax error
    const sel = ['Sub Table1_KeyDown(ByVal k)', 'End Sub', 'Sub ResetForNewGame()', 'End Sub', 'Sub AddScore(p)', '    Score = Score + p', 'End Sub', 'Sub EndOfGame()', 'End Sub', 'Sub EndOfBall()', '    Select Case x', '        Case 1', '    End Select', 'End Sub'];
    const selOut = splitScript(rendered(crlf(sel))).lines;
    const a = selOut.indexOf(ANCHOR);
    const moved = [...selOut.slice(0, a), selOut[a + 1] ?? '', ANCHOR, ...selOut.slice(a + 2)];
    expect(lintSidecar(crlf(sel), join(moved))).toEqual([expect.stringMatching(/^line \d+ \(Castcade_B_BallEnd\) sits between Select Case and its first Case$/)]);

    // the anchor block lost a sub the table's lines call
    const s = L.indexOf('Sub Castcade_B_BallEnd()');
    const cut = lintSidecar(text, join([...L.slice(0, s), ...L.slice(s + 4)]));
    expect(cut).toContain(`line ${at + 1} calls Castcade_B_BallEnd, which the sidecar does not define`);

    // a second definition of a handler our wrapper defines
    const dup = lintSidecar(text, join([...L, 'Sub Table1_KeyDown(ByVal k)', 'End Sub']));
    expect(dup).toContain('table1_keydown is defined 2 times');

    // the renamed definition is not the table's last one: the handler that really ran is left uncalled
    const orig = L.indexOf('Sub Castcade_Orig_Exit');
    const end = L.findIndex((l, i) => i > orig && /^End Sub/.test(l));
    const later = lintSidecar(text, join([...L.slice(0, end + 1), 'Sub Table1_Exit()', 'End Sub', ...L.slice(end + 1)]));
    expect(later).toContain(`line ${end + 2} defines table1_exit after the definition that was renamed: the handler the table really runs is not the one wrapped`);

    // an unbalanced block in our own lines
    const open = lintSidecar(text, join([...L, 'Sub Castcade_B_Extra()', '    If x Then']));
    expect(open).toEqual(expect.arrayContaining(['If blocks: the script was off by 0, the sidecar is off by 1', 'Sub blocks: the script was off by 0, the sidecar is off by 1']));

    expect(lintSidecar(text, text)).toContain('not a Castcade sidecar this build can undo');
  });
});

describe('checkGameJournal (the live-validation verdict)', () => {
  const loaded = '{"event":"table_loaded","t":0.01,"table":"T","recipe":"B","recipe_version":"0.3.0","rom":"","lib":"0.5.0","session":"s","locked":false}';
  const game = [
    loaded,
    '{"event":"game_start","t":1,"players":1}',
    '{"event":"current_scores","t":2,"scores":[500],"player":1,"ball":1}',
    '{"event":"ball_end","t":3,"player":1,"ball":1,"extra_balls":0}',
    '{"event":"ball_end","t":4,"player":1,"ball":2,"extra_balls":1}',
    '{"event":"ball_end","t":5,"player":1,"ball":2,"extra_balls":0}',
    '{"event":"ball_end","t":6,"player":1,"ball":3,"extra_balls":0}',
    '{"event":"game_end","t":7,"scores":[1500],"players":1}',
    '{"event":"table_exit","t":8,"lines":9,"nvram_callbacks":0,"blocked_keys":0,"filtered_bytes":0}',
  ];

  it('passes one whole game: loaded, started, three ball ends in order (a shoot-again is not counted), ended with a score', () => {
    const c = checkGameJournal(game);
    expect(c.ok).toBe(true);
    expect(c.problems).toEqual([]);
    expect(c.notes).toEqual([]);
    expect(c.summary).toMatchObject({ tableLoaded: true, recipe: 'B', recipeVersion: '0.3.0', lib: '0.5.0', gameStarts: 1, scoreLines: 1, tableExit: true });
    expect(c.summary.ballEnds.map((b) => b.ball)).toEqual([1, 2, 2, 3]);
    expect(c.summary.gameEnds).toEqual([{ scores: [1500], players: 1 }]);
    // a 5-ball expectation fails the same journal, and says how many it saw
    expect(checkGameJournal(game, { balls: 5 }).problems).toEqual(['game_end after 3 ball ends; expected 5']);
    expect(checkGameJournal(game, { balls: 1 }).ok).toBe(true);
  });

  it('judges the LAST session of an appended journal', () => {
    const older = [loaded, '{"event":"game_start","t":1,"players":1}'];
    expect(checkGameJournal([...older, ...game]).ok).toBe(true);
    expect(checkGameJournal([...game, ...older]).problems).toEqual(['no game_end (the game journaled 0 ball ends)']);
  });

  it('names each thing a broken patch leaves out', () => {
    expect(checkGameJournal([]).problems).toEqual(["no table_loaded: the sidecar did not load (VPX ran the table's own script, or the script failed to compile)"]);
    expect(checkGameJournal([loaded]).problems).toEqual(['no game_start']);
    // Dark Chaos before C1.4, had it been patched at all: a start and scores, never a ball end
    const noBalls = game.filter((l) => !l.includes('"ball_end"'));
    expect(checkGameJournal(noBalls).problems).toEqual(['game_end after 0 ball ends; expected 3']);
    const noEnd = game.filter((l) => !l.includes('"game_end"'));
    expect(checkGameJournal(noEnd).problems).toEqual(['no game_end (the game journaled 3 ball ends)']);
    const ballZero = game.map((l) => l.replace('"ball":1,"extra_balls":0', '"ball":0,"extra_balls":0'));
    expect(checkGameJournal(ballZero).problems).toEqual(['ball_end carries ball 0; the ball number was not read']);
    const down = game.map((l) => l.replace('"ball":3,"extra_balls":0', '"ball":1,"extra_balls":0'));
    expect(checkGameJournal(down).problems).toEqual(['ball_end ball 1 after ball 2: the ball number went down']);
    const noScores = game.map((l) => l.replace('"scores":[1500]', '"scores":[]'));
    expect(checkGameJournal(noScores).problems).toEqual(['game_end carries scores []']);
    const early = [loaded, game[3] ?? '', ...game.slice(1)];
    expect(checkGameJournal(early).problems).toEqual(['ball_end (ball 1) before any game_start']);
    expect(checkGameJournal([...game, 'not json']).problems).toEqual(['1 journal line is not JSON']);
  });

  it('fails a game end whose scores are below the last live scores (The Matrix (Original): the end sub cleared them first)', () => {
    const cleared = game.map((l) => l.replace('"scores":[1500]', '"scores":[0]'));
    expect(checkGameJournal(cleared).problems).toEqual(['game_end carries scores [0], below the last live scores [500]: the table cleared its scores before the game end was journaled']);
    // a final score above the last live one is the usual case (a bonus added outside AddScore), and equal is fine
    expect(checkGameJournal(game.map((l) => l.replace('"scores":[1500]', '"scores":[500]'))).ok).toBe(true);
    // per player: player 2's final below their live score
    const two = game.map((l) => l.replace('"scores":[500],"player":1', '"scores":[500,700],"player":2').replace('"scores":[1500],"players":1', '"scores":[900,0],"players":2'));
    expect(checkGameJournal(two).problems).toEqual(['game_end carries scores [900,0], below the last live scores [500,700]: the table cleared its scores before the game end was journaled']);
    // live scores of an earlier game in the session do not count
    const earlier = [loaded, '{"event":"current_scores","t":0.5,"scores":[99999],"player":1,"ball":3}', ...game.slice(1)];
    expect(checkGameJournal(earlier).ok).toBe(true);
  });

  it('notes a final score of 0 it cannot vouch for (Diablo 2 1.2.1: nothing scored all game), and a session with more games than one', () => {
    const zero = game.map((l) => l.replace('"scores":[500]', '"scores":[0]').replace('"scores":[1500]', '"scores":[0]'));
    const c = checkGameJournal(zero);
    expect(c.ok).toBe(true);
    expect(c.notes).toEqual(['the final score is 0 and no live score was above 0: a game in which nothing scored, or a score cleared before it was journaled; the journal cannot tell which']);
    // Game of Thrones, 2026-11-12: the runner's lockbar key began the next game after each game over
    const again = checkGameJournal([...game.slice(0, -1), '{"event":"game_start","t":9,"players":1}', '{"event":"ball_end","t":10,"player":1,"ball":1,"extra_balls":0}']);
    expect(again.ok).toBe(true);
    expect(again.notes).toContain('2 game starts in the session: only the first game is judged');
  });

  it('notes a session no key press reached (a dialog over the player), by the missing lock line', () => {
    const blocked = checkGameJournal([loaded]);
    expect(blocked.problems).toEqual(['no game_start']);
    expect(blocked.notes).toContain('no key press reached the table: a dialog was open over the player (a file or folder the table asks for is missing?), or the window never had the keyboard');
    expect(blocked.summary.keysSeen).toBe(false);
    const pressed = checkGameJournal([loaded, '{"event":"lock","t":8.2,"locked":false}']);
    expect(pressed.summary.keysSeen).toBe(true);
    expect(pressed.notes.some((n) => n.startsWith('no key press'))).toBe(false);
  });

  it('notes, without failing, a game with no score line, hook warnings and a missing table_exit', () => {
    const quiet = game.filter((l) => !l.includes('"current_scores"') && !l.includes('"table_exit"'));
    const c = checkGameJournal([...quiet, '{"event":"warn","t":9,"msg":"lock read failed","err":"53"}']);
    expect(c.ok).toBe(true);
    expect(c.notes).toEqual([
      'no current_scores line: either nothing scored, or the live score is not journaled',
      '1 warn line from the hook: lock read failed',
      'no table_exit: VPX did not close the table cleanly (or the journal was read before it did)',
    ]);
  });
});

describe('resourceFolders (what a staged copy needs beside it)', () => {
  const DIRS = ['B2STools', 'BloodMachinesDMD', 'Diablo 2 Beta.FlexDMD', 'Diablo 2.FlexDMD', 'gameofthrones.FlexDMD', 'Music', 'Plugins', 'Sonic.UltraDMD', 'TheGooniesDMD', 'Thundercats.UltraDMD'];
  const of = (lines: string[]): string[] => resourceFolders(crlf(lines), DIRS);

  it('takes a DMD project folder the script names whole in a string literal', () => {
    expect(of(['With FlexDMD', '    .ProjectFolder = "./TheGooniesDMD/"', 'End With'])).toEqual(['TheGooniesDMD']);
    // "Diablo 2.FlexDMD", not its Beta sibling
    expect(of(['FlexDMD.ProjectFolder = "./Diablo 2.FlexDMD/"'])).toEqual(['Diablo 2.FlexDMD']);
  });

  it('takes <stem>.UltraDMD / <stem>.FlexDMD when the script builds the name from a constant', () => {
    expect(of(['Const TableName = "Sonic"', 'DirName = curDir& "\\" &TableName& ".UltraDMD"'])).toEqual(['Sonic.UltraDMD']);
    expect(of(['Const cGameName = "Thundercats"', 'DirName = curDir& "\\" &cGameName& ".UltraDMD"'])).toEqual(['Thundercats.UltraDMD']);
    expect(of(['Const myGameName = "gameofthrones"', '    .ProjectFolder = ".\\"&myGameName&".FlexDMD\\"'])).toEqual(['gameofthrones.FlexDMD']);
    // the constant alone, or the suffix alone, is not enough
    expect(of(['Const TableName = "Sonic"'])).toEqual([]);
    expect(of(['DirName = curDir & ".UltraDMD"'])).toEqual([]);
  });

  it('ignores comments and folders that are not a DMD project, whatever the script says', () => {
    expect(of(["' .ProjectFolder = \"./TheGooniesDMD/\"", 'PlayMusic "Music/intro.mp3"', 'x = "Plugins"'])).toEqual([]);
    expect(resourceFolders(crlf(JPSALAS_B_SCRIPT), DIRS)).toEqual([]);
  });
});
