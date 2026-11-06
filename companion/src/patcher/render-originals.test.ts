import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replayDetector } from '../witness/journal-detector.js';
import { classifyScript } from './classify.js';
import { callArgs, recipeFor, renderRecipeB, renderSidecar } from './render-originals.js';
import { LIB_VERSION, RECIPE_VERSION, RECIPE_VERSIONS, STUB, isRecipe, parseSidecarMarker, recipeVersionFor, renderRecipeA, unpatchSidecar, type RenderOptions } from './render.js';
import { decodeScript, splitScript } from './script-text.js';
import {
  JPSALAS_B_SCRIPT,
  ORIGINAL_B_SCRIPT,
  ORIGINAL_E_SCRIPT,
  SCORBIT_C_SCRIPT,
  SCORESERVER_D_SCRIPT,
  SCORESERVER_D_UNKNOWN_SCRIPT,
  VPM_SCRIPT,
  crlf,
  mixed,
  lf,
} from './test-scripts.test-support.js';

const OPTS: RenderOptions = {
  tableId: 'Total Nuclear Annihilation (Spooky 2017) VPW v2.3',
  rom: null,
  originalPath: 'C:\\VPX\\tables\\Total Nuclear Annihilation (Spooky 2017) VPW v2.3.vpx',
  originalSize: 444_555_666,
  originalMtimeMs: new Date(2026, 9, 28, 20, 1, 2).getTime(),
  sidecarPath: 'C:\\VPX\\tables\\Total Nuclear Annihilation (Spooky 2017) VPW v2.3.vbs',
};

const render = (lines: readonly string[], text = crlf(lines)) => {
  const cls = classifyScript(text);
  const r = renderSidecar(text, cls, OPTS);
  const out = decodeScript(r.bytes);
  return { text, cls, r, out, L: splitScript(out).lines };
};

/** The anchor block appended after the wrappers, without its marker lines. */
const block = (L: string[], recipe: string): string[] => {
  const s = L.findIndex((l) => l.startsWith(`' --- Castcade recipe ${recipe} anchors`));
  const e = L.indexOf(`' --- end Castcade recipe ${recipe} ---`);
  return L.slice(s + 1, e);
};

/** The table's own sub `name` as rendered (Sub line .. End Sub). */
const subLines = (L: string[], name: string): string[] => {
  const s = L.findIndex((l) => new RegExp(`^\\s*(Sub|Function)\\s+${name}\\b`, 'i').test(l));
  const e = L.findIndex((l, i) => i > s && /^\s*End\s+(Sub|Function)\b/i.test(l));
  return L.slice(s, e + 1);
};

describe('recipe versions', () => {
  it('each recipe carries its own version; recipe A keeps 0.3.1 so the lib bump alone re-makes A sidecars', () => {
    expect(RECIPE_VERSIONS).toEqual({ A: RECIPE_VERSION, B: '0.1.0', C: '0.1.0', D: '0.1.0' });
    expect(RECIPE_VERSION).toBe('0.3.1');
    expect(recipeVersionFor('B')).toBe('0.1.0');
    expect(recipeVersionFor('E')).toBeNull();
    expect(isRecipe('D')).toBe(true);
    expect(isRecipe('E')).toBe(false);
    expect(recipeFor('A')).toBe('A');
    expect(recipeFor('C')).toBe('C');
    expect(recipeFor('E')).toBeNull();
    expect(recipeFor('X')).toBeNull();
  });

  it('the library has everything the originals call, and the STUB covers what their anchor subs reach without it', () => {
    const lib = readFileSync(new URL('../../../vpx-hook/castcade.vbs', import.meta.url), 'latin1');
    for (const decl of [
      'Sub Castcade_GameStart(players)',
      'Sub Castcade_Scores(scores, player, ball)',
      'Sub Castcade_BallEnd(player, ball, extraBalls)',
      'Sub Castcade_GameEnd(scores, players)',
      'Function Castcade_PlayerScores(arr, base, players)',
      'Function Castcade_ScoreServer()',
      'Class Castcade_ScoreServerShim',
      'Public Sub SetGameName(name)',
      'Public Sub SetGameState(playerCount, currentPlayer, currentBall, gameState)',
      'Public Sub SetScoresArray(playerNames, scoreValues)',
      'Public Sub SetHighScoresArray(labels, initials, values)',
      'Public Sub AwardBadge(player, name, description)',
      'Public Sub ClearState()',
    ]) {
      expect(lib).toContain(decl);
    }
    expect(lib).toContain(`Castcade_LibVersion = "${LIB_VERSION}"`);
    expect(LIB_VERSION).toBe('0.5.0');
    // Without the library the anchor subs fail inside their own On Error Resume Next; the stubs keep the four entry points.
    for (const s of ['Sub Castcade_GameStart(p)', 'Sub Castcade_Scores(s,p,b)', 'Sub Castcade_BallEnd(p,b,e)', 'Sub Castcade_GameEnd(s,p)']) expect(STUB).toContain(s);
  });
});

describe('renderRecipeB (JPSalas original)', () => {
  it('places block 0, the wrappers and every anchor (CRLF, 1-based players, Balls function)', () => {
    const { r, L, cls } = render(JPSALAS_B_SCRIPT);
    expect(cls.cls).toBe('B');
    expect(L[0]).toBe('Option Explicit');
    expect(parseSidecarMarker(L[1] ?? '')).toEqual({ recipe: 'B', recipeVersion: '0.1.0', libVersion: LIB_VERSION });
    expect(L).toContain(`Castcade_Init "Total Nuclear Annihilation (Spooky 2017) VPW v2.3", "B", "0.1.0", ""`);
    expect(L.some((l) => l.startsWith('Castcade_Guard "C:\\VPX\\tables\\Total Nuclear Annihilation'))).toBe(true);
    expect(L.some((l) => /^(Dim UseVPMNVRAM|UseVPMNVRAM =|Castcade_RegisterNVRAM|Castcade_WatchBytes)/.test(l))).toBe(false);
    expect(L).toContain('Sub Castcade_Orig_KeyDown(ByVal keycode)');
    expect(L).toContain('Sub Castcade_Orig_KeyUp(ByVal keycode)');
    expect(L).toContain('Sub Castcade_Orig_Exit');

    expect(subLines(L, 'ResetForNewGame').at(-2)).toBe("    Castcade_B_GameStart   ' Castcade: game start");
    expect(subLines(L, 'AddScore')).toEqual([
      'Sub AddScore(points)',
      "    If Tilted Then Castcade_B_Scores : Exit Sub ' no points while tilted",
      '    Score(CurrentPlayer) = Score(CurrentPlayer) + points',
      "    Castcade_B_Scores   ' Castcade: current scores",
      'End Sub',
    ]);
    expect(subLines(L, 'EndOfBall')[1]).toBe("    Castcade_B_BallEnd   ' Castcade: ball end");
    expect(subLines(L, 'EndOfGame')).toEqual(['Sub EndOfGame()', '    If bGameInPlay = False Then Exit Sub', '    bGameInPlay = False', "    Castcade_B_GameEnd   ' Castcade: game end", 'End Sub']);
    expect(block(L, 'B')).toEqual([
      'Dim Castcade_B_Players : Castcade_B_Players = 1',
      'Function Castcade_B_Count()',
      '    On Error Resume Next',
      '    Dim n',
      '    n = 0',
      '    n = CLng(PlayersPlayingGame)',
      '    If n > 0 Then Castcade_B_Players = n',
      '    Castcade_B_Count = Castcade_B_Players',
      'End Function',
      'Sub Castcade_B_GameStart()',
      '    On Error Resume Next',
      '    Castcade_B_Players = 1',
      '    Castcade_GameStart Castcade_B_Count()',
      'End Sub',
      'Sub Castcade_B_Scores()',
      '    On Error Resume Next',
      '    Castcade_Scores Castcade_PlayerScores(Score, 1, Castcade_B_Count()), CurrentPlayer, Balls',
      'End Sub',
      'Sub Castcade_B_BallEnd()',
      '    On Error Resume Next',
      '    Castcade_BallEnd CurrentPlayer, Balls, ExtraBallsAwards(CurrentPlayer)',
      'End Sub',
      'Sub Castcade_B_GameEnd()',
      '    On Error Resume Next',
      '    Castcade_GameEnd Castcade_PlayerScores(Score, 1, Castcade_B_Count()), Castcade_B_Count()',
      'End Sub',
    ]);
    // the wrappers come before the anchor block, the block is the last thing in the file
    expect(L.indexOf("' --- end Castcade ---")).toBeLessThan(L.findIndex((l) => l.startsWith("' --- Castcade recipe B anchors")));
    expect(L.at(-1)).toBe("' --- end Castcade recipe B ---");
    expect(r.warnings).toEqual(['Sub EndOfGame has 1 early Exit Sub; no game end is journaled on that path']);
    expect(r.partial).toEqual([]);
    expect(r.anchors).toMatchObject({
      scores: 'end of Sub AddScore (line 33) and before its 1 early Exit Sub',
      gameStart: 'end of Sub ResetForNewGame (line 28)',
      gameEnd: 'end of Sub EndOfGame (line 48)',
      ballEnd: 'top of Sub EndOfBall (line 35)',
      vars: 'Score base 1, player CurrentPlayer, ball Balls, players PlayersPlayingGame',
    });
  });

  it('reads a 0-based table (CurrentPlayer = 0) and a ball counter without Balls', () => {
    const lines = JPSALAS_B_SCRIPT.map((l) => l.replace('CurrentPlayer = 1', 'CurrentPlayer = 0')).filter((l, i, a) => !(i >= a.indexOf('Function Balls')));
    const { L, r } = render(lines);
    expect(block(L, 'B')).toContain('    Castcade_Scores Castcade_PlayerScores(Score, 0, Castcade_B_Count()), CurrentPlayer + 1, BallsPerGame - BallsRemaining(CurrentPlayer) + 1');
    expect(block(L, 'B')).toContain('    Castcade_BallEnd CurrentPlayer + 1, BallsPerGame - BallsRemaining(CurrentPlayer) + 1, ExtraBallsAwards(CurrentPlayer)');
    expect(r.anchors['vars']).toBe('Score base 0, player CurrentPlayer + 1, ball BallsPerGame - BallsRemaining(CurrentPlayer) + 1, players PlayersPlayingGame');
  });

  it('with no EndOfBall, anchors the ball end before the BallsRemaining decrement', () => {
    const lines = JPSALAS_B_SCRIPT.filter((_, i, a) => i < a.indexOf('Sub EndOfBall()') || i > a.indexOf('Sub EndOfBall()') + 3);
    const { L, r } = render(lines);
    const dec = L.findIndex((l) => l.startsWith('    BallsRemaining(CurrentPlayer) = BallsRemaining(CurrentPlayer) - 1'));
    expect(L[dec - 1]).toBe("    Castcade_B_BallEnd   ' Castcade: ball end");
    expect(r.anchors['ballEnd']).toMatch(/^before the BallsRemaining decrement \(line \d+\)$/);
  });

  it('renders the minimal JPSalas shape partially: no ball number, no EndOfBall, warnings say what is missing', () => {
    const { r, L } = render(ORIGINAL_B_SCRIPT);
    expect(r.partial).toEqual([]);
    expect(r.warnings).toEqual([
      'no "CurrentPlayer = 0" or "= 1" found; player 1 is taken as Score(1)',
      'no ball number (Balls, BallsPerGame / BallsRemaining); ball fields are 0',
      'no EndOfBall sub and no BallsRemaining(CurrentPlayer) decrement; no ball end is journaled',
    ]);
    expect(block(L, 'B')).toContain('    Castcade_Scores Castcade_PlayerScores(Score, 1, Castcade_B_Count()), CurrentPlayer, 0');
  });

  it('is partial without a Score array: no scores call is anchored and the game end journals no scores', () => {
    const lines = ['Sub Table1_KeyDown(ByVal k)', 'End Sub', 'Sub ResetForNewGame()', 'End Sub', 'Sub AddScore(p)', 'End Sub', 'Sub EndOfGame()', 'End Sub'];
    const { r, L } = render(lines, lf(lines));
    expect(r.partial).toEqual(['no Dim Score( array; scores are not journaled']);
    expect(L.some((l) => l.includes("Castcade_B_Scores   ' Castcade"))).toBe(false);
    expect(block(L, 'B')).toContain('    Castcade_GameEnd Array(), Castcade_B_Count()');
    expect(r.warnings).toContain('no PlayersPlayingGame variable; games are journaled as 1 player');
    expect(r.warnings).toContain('no "CurrentPlayer = 0" or "= 1" found; player 1 is taken as Score(1)');
  });

  it('a one-line sub cannot carry an anchor and says so', () => {
    const lines = JPSALAS_B_SCRIPT.map((l) => (l === 'Sub EndOfGame()' ? 'Sub EndOfGame() : bGameInPlay = False : End Sub' : l)).filter(
      (l, i, a) => !(i > a.indexOf('Sub EndOfGame() : bGameInPlay = False : End Sub') && i <= a.indexOf('Sub EndOfGame() : bGameInPlay = False : End Sub') + 3),
    );
    const { r } = render(lines);
    expect(r.partial).toEqual(['Sub EndOfGame is written on one line; no game end is journaled']);
  });

  it('refuses a script that is not class B or already carries Castcade_Init', () => {
    const vpm = crlf(VPM_SCRIPT);
    expect(() => renderRecipeB(vpm, classifyScript(vpm), OPTS)).toThrow(/class A is not class B/);
    const done = decodeScript(render(JPSALAS_B_SCRIPT).r.bytes);
    expect(() => renderSidecar(done, classifyScript(done), OPTS)).toThrow(/already patched/);
    const e = lf(ORIGINAL_E_SCRIPT);
    expect(() => renderSidecar(e, classifyScript(e), OPTS)).toThrow(/class E has no recipe/);
  });

  it('is deterministic, and the undo gives back the table script byte for byte (CRLF, LF and mixed)', () => {
    for (const text of [crlf(JPSALAS_B_SCRIPT), lf(JPSALAS_B_SCRIPT), mixed(JPSALAS_B_SCRIPT, 5, 30), crlf(ORIGINAL_B_SCRIPT)]) {
      const a = render(JPSALAS_B_SCRIPT, text);
      const b = render(JPSALAS_B_SCRIPT, text);
      expect(b.r.sha256).toBe(a.r.sha256);
      expect(unpatchSidecar(a.out)).toBe(text);
      // re-render from the undone script: the same sidecar (what the importer does with an editor-saved patch)
      const again = renderSidecar(unpatchSidecar(a.out)!, classifyScript(unpatchSidecar(a.out)!), OPTS);
      expect(again.sha256).toBe(a.r.sha256);
    }
  });

  it('the rendered sidecar replays through the journal detector as one game (journal recorded from it under cscript)', () => {
    // Lines this recipe's sidecar wrote when the synthetic script above was driven through a game under cscript
    // (StartGame, two AddScore, a tilted AddScore, three drains); t trimmed.
    const journal = [
      '{"event":"table_loaded","t":0.008,"table":"jpsalas","recipe":"B","recipe_version":"0.1.0","rom":"","lib":"0.5.0","session":"2026-10-31T17:46:11","locked":false}',
      '{"event":"game_start","t":0.047,"players":1}',
      '{"event":"current_scores","t":0.062,"scores":[500],"player":1,"ball":1}',
      '{"event":"current_scores","t":0.062,"scores":[750],"player":1,"ball":1}',
      '{"event":"ball_end","t":0.062,"player":1,"ball":1,"extra_balls":0}',
      '{"event":"current_scores","t":0.078,"scores":[1750],"player":1,"ball":1}',
      '{"event":"current_scores","t":0.078,"scores":[1770],"player":1,"ball":2}',
      '{"event":"ball_end","t":0.078,"player":1,"ball":2,"extra_balls":0}',
      '{"event":"current_scores","t":0.09,"scores":[2770],"player":1,"ball":2}',
      '{"event":"ball_end","t":0.094,"player":1,"ball":3,"extra_balls":0}',
      '{"event":"current_scores","t":0.105,"scores":[3770],"player":1,"ball":3}',
      '{"event":"game_end","t":0.105,"scores":[3770],"players":1}',
      '{"event":"table_exit","t":0.125,"lines":13,"nvram_callbacks":0,"blocked_keys":0,"filtered_bytes":0}',
    ];
    const { events, detector } = replayDetector(journal);
    expect(events.filter((e) => e.kind === 'game_end')).toEqual([{ kind: 'game_end', t: 0.105, scores: [3770], players: 1 }]);
    expect(events.some((e) => e.kind === 'game_abandoned')).toBe(false);
    expect(detector.summary()).toMatchObject({ recipe: 'B', inGame: false, maxBall: 3, scores: [3770] });
  });
});

describe('renderRecipeC (Scorbit-anchored)', () => {
  it('journals what Scorbit.SendUpdate is told, anchored outside the Scorbit guards', () => {
    const { r, L, cls } = render(SCORBIT_C_SCRIPT);
    expect(cls.cls).toBe('C');
    expect(parseSidecarMarker(L[1] ?? '')?.recipe).toBe('C');
    // StartSession is inside an If in StartGame: the call goes at the end of StartGame, outside the If
    expect(subLines(L, 'StartGame').slice(-3)).toEqual(['    End If', "    Castcade_C_GameStart   ' Castcade: game start", 'End Sub']);
    // StopSession is in the helper StopScorbit, called behind a session guard: one level up, end of FinishGame
    expect(subLines(L, 'FinishGame').slice(-3)).toEqual(['    End If', "    Castcade_C_GameEnd   ' Castcade: game end", 'End Sub']);
    expect(subLines(L, 'StopScorbit')).toEqual(['Sub StopScorbit', '    Scorbit.StopSession aScore(0), aScore(1), aScore(2), aScore(3), nPlayers', 'End Sub']);
    expect(subLines(L, 'AddScore')[2]).toBe('    If Not bShowPup Then Castcade_C_Scores : Exit Sub');
    expect(subLines(L, 'EndBall')[1]).toBe("    Castcade_C_BallEnd   ' Castcade: ball end");
    const b = block(L, 'C');
    expect(b).toContain('    n = CLng(nPlayers)');
    expect(b).toContain('    Castcade_Scores Castcade_PlayerScores(Array(aScore(0), aScore(1), aScore(2), aScore(3)), 0, Castcade_C_Count()), nPlayer+1, nBall');
    expect(b).toContain('    Castcade_BallEnd nPlayer+1, nBall, 0');
    expect(b).toContain('    Castcade_GameEnd Castcade_PlayerScores(Array(aScore(0), aScore(1), aScore(2), aScore(3)), 0, Castcade_C_Count()), Castcade_C_Count()');
    expect(r.anchors['gameEnd']).toBe('end of Sub FinishGame (line 36) (the caller of StopScorbit, which calls Scorbit.StopSession)');
    expect(r.anchors['vars']).toBe('Scorbit.SendUpdate arguments (line 51)');
    expect(r.warnings).toEqual([]);
    expect(r.partial).toEqual([]);
    expect(unpatchSidecar(decodeScript(r.bytes))).toBe(crlf(SCORBIT_C_SCRIPT));
  });

  it('is partial when the only call sites are inside the Scorbit class or a key handler', () => {
    const { r } = render(['Sub Table1_KeyDown(ByVal k)', '    Scorbit.StartSession', 'End Sub', 'Class ScorbitIF', '  Sub Tick()', '    Scorbit.SendUpdate 1, 2, 3, 4, 5, 6, 7', '    Scorbit.StopSession 1, 2, 3, 4, 1', '  End Sub', 'End Class']);
    expect(r.partial).toEqual([
      'no anchor for Scorbit.StartSession (the call on line 2 is in the event handler Table1_KeyDown); no game start is journaled',
      'no anchor for Scorbit.StopSession (the call on line 7 is inside a Class (Tick)); no game end is journaled',
    ]);
  });

  it('is partial without a 7-argument SendUpdate (the legacy shape in ORIGINAL_C_SCRIPT)', () => {
    const text = lf(['Sub Table1_KeyDown(ByVal k)', 'End Sub', 'Sub StartGame()', '    Scorbit.StartSession', 'End Sub', 'Sub Tick()', '    Scorbit.SendUpdate', 'End Sub', 'Sub GameOver()', '    Scorbit.StopSession', 'End Sub']);
    const cls = classifyScript(text);
    expect(cls.cls).toBe('C');
    const r = renderSidecar(text, cls, OPTS);
    expect(r.partial).toEqual(['no Scorbit.SendUpdate call with its 7 arguments; scores are not journaled']);
    expect(r.anchors['gameStart']).toBe('end of Sub StartGame (line 5)');
  });
});

describe('renderRecipeD (ScoreServer)', () => {
  it("redirects CreateObject(\"VPinball.ScoreServer\") to the library's shim and checks every method call", () => {
    const { r, L, cls } = render(SCORESERVER_D_SCRIPT);
    expect(cls.cls).toBe('D');
    expect(L).toContain('    Set ScoreServer = Castcade_D_ScoreServer()');
    expect(L.filter((l) => l.includes('CreateObject("VPinball.ScoreServer")'))).toEqual(['    If o Is Nothing Then Set o = CreateObject("VPinball.ScoreServer")']);
    expect(block(L, 'D')).toEqual([
      'Function Castcade_D_ScoreServer()',
      '    Dim o',
      '    On Error Resume Next',
      '    Set o = Nothing',
      '    Set o = Castcade_ScoreServer()',
      '    If o Is Nothing Then Set o = CreateObject("VPinball.ScoreServer")',
      '    If o Is Nothing Then',
      '        On Error Goto 0',
      '        Err.Raise 429, "Castcade", "ActiveX component can\'t create object: VPinball.ScoreServer"',
      '    End If',
      '    Set Castcade_D_ScoreServer = o',
      'End Function',
    ]);
    expect(r.partial).toEqual([]);
    expect(r.anchors['scoreServer']).toBe('CreateObject("VPinball.ScoreServer") redirected to the library\'s shim (line 6)');
    expect(unpatchSidecar(decodeScript(r.bytes))).toBe(crlf(SCORESERVER_D_SCRIPT));
  });

  it('leaves the ScoreServer alone (partial) when the table calls a method the shim lacks or with another arity', () => {
    const { r, L } = render(SCORESERVER_D_UNKNOWN_SCRIPT);
    expect(L).toContain('    Set ScoreServer = CreateObject("VPinball.ScoreServer")');
    expect(L.some((l) => l.includes('= Castcade_D_ScoreServer()'))).toBe(false);
    expect(r.partial).toEqual([
      'ScoreServer left unredirected, the shim could stop the table: ScoreServer.SetHighScoresArray (line 6) passes 2 arguments, the API takes 3; ScoreServer.Reconnect (line 7) is not a ScoreServer method the shim has',
    ]);
  });

  it('a class-D script with no CreateObject to redirect is partial', () => {
    const { r } = render(['Sub Table1_KeyDown(ByVal k)', 'End Sub', 'Sub Report()', '    ScoreServer.SetScoresArray "Player 1", "10"', 'End Sub']);
    expect(r.partial).toEqual(['no CreateObject("VPinball.ScoreServer") to redirect; nothing the table reports is journaled']);
  });

  it('the shim journal (recorded under cscript) gives game_end with the final scores sent after state 3', () => {
    const journal = [
      '{"event":"table_loaded","t":0.004,"table":"scoreserver","recipe":"D","recipe_version":"0.1.0","rom":"","lib":"0.5.0","session":"2026-10-31T17:46:22","locked":false}',
      '{"event":"score_server","t":0.023,"call":"connect","real":false}',
      '{"event":"score_server","t":0.027,"call":"SetGameName","name":"SyntheticTable"}',
      '{"event":"score_server","t":0.055,"call":"SetGameState","players":1,"player":1,"ball":1,"state":1}',
      '{"event":"game_start","t":0.062,"players":1}',
      '{"event":"current_scores","t":0.066,"scores":[0],"player":1,"ball":1}',
      '{"event":"current_scores","t":0.074,"scores":[12345],"player":1,"ball":1}',
      '{"event":"current_scores","t":0.09,"scores":[99999],"player":1,"ball":3}',
      '{"event":"score_server","t":0.09,"call":"SetGameState","players":1,"player":1,"ball":4,"state":3}',
      '{"event":"current_scores","t":0.094,"scores":[99999],"player":1,"ball":4}',
      '{"event":"game_end","t":0.094,"scores":[99999],"players":1}',
      '{"event":"table_exit","t":0.102,"lines":18,"nvram_callbacks":0,"blocked_keys":0,"filtered_bytes":0}',
    ];
    const { events } = replayDetector(journal);
    expect(events.filter((e) => e.kind === 'game_start' || e.kind === 'game_end' || e.kind === 'game_abandoned').map((e) => e.kind)).toEqual(['game_start', 'game_end']);
    expect(events.find((e) => e.kind === 'game_end')).toMatchObject({ scores: [99999] });
  });
});

describe('callArgs', () => {
  const at = (line: string, name: string, more: string[] = []) => callArgs([line, ...more], 0, line.indexOf(name) + name.length);
  it('splits at top-level commas, drops whole-list brackets, stops at : and Else, joins continuations', () => {
    expect(at('    Scorbit.SendUpdate Score(1), Score(2), x(1, 2), "a,b", Balls, CurrentPlayer+1, n', 'SendUpdate')).toEqual(['Score(1)', 'Score(2)', 'x(1, 2)', '"a,b"', 'Balls', 'CurrentPlayer+1', 'n']);
    expect(at('Scorbit.StartSession()', 'StartSession')).toEqual([]);
    expect(at('Scorbit.StartSession', 'StartSession')).toEqual([]);
    expect(at('o.SetGameName("x") : foo', 'SetGameName')).toEqual(['"x"']);
    expect(at('If a Then o.ClearState Else o.SetGameName 1', 'ClearState')).toEqual([]);
    expect(at("o.SetScoresArray a, _", 'SetScoresArray', ["    b ' comment"])).toEqual(['a', 'b']);
    expect(at('o.SetGameState (a), b, c, d', 'SetGameState')).toEqual(['(a)', 'b', 'c', 'd']);
  });
});

describe('recipe A is unchanged by C1.1', () => {
  it('renders the same bytes as before apart from the marker lib version', () => {
    const text = crlf(VPM_SCRIPT);
    const r = renderRecipeA(text, classifyScript(text), { ...OPTS, rom: 'mb_106b' });
    const L = splitScript(decodeScript(r.bytes)).lines;
    expect(L[1]).toBe(`' --- Castcade (recipe A v0.3.1, lib ${LIB_VERSION}) --- do not edit; delete this .vbs to revert to the embedded script`);
    expect(L.some((l) => l.includes('Castcade recipe') || /Castcade_[BCD]_/.test(l))).toBe(false);
    expect(unpatchSidecar(decodeScript(r.bytes))).toBe(text);
  });

  it('the undo refuses a marker of a recipe this build does not render', () => {
    const e = "' --- Castcade (recipe E v0.1.0, lib 0.5.0) --- do not edit\nCastcade_Init \"x\", \"E\", \"0.1.0\", \"\"\n";
    expect(unpatchSidecar(e)).toBeNull();
  });
});
