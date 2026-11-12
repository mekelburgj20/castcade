import { describe, expect, it } from 'vitest';
import { ANCHOR_OVERRIDES, checkOverride, findOverride, overrideById, resolvePlace, type AnchorOverride } from './anchor-overrides.js';
import { classifyScript } from './classify.js';
import { renderSidecar } from './render-originals.js';
import { LIB_VERSION, ORIGINAL_LINE_INSERT, parseSidecarMarker, unpatchSidecar, type RenderOptions } from './render.js';
import { decodeScript, lineContexts, splitScript } from './script-text.js';
import {
  BURGER_BALLS_B_SCRIPT,
  BURGER_B_SCRIPT,
  DIABLO_B_SCRIPT,
  GLF_B_SCRIPT,
  JPSALAS_B_SCRIPT,
  RATTLECAN_B_SCRIPT,
  RATTLECAN_TILT_B_SCRIPT,
  VPM_SCRIPT,
  crlf,
  lf,
  mixed,
  noFinalNewline,
} from './test-scripts.test-support.js';
import { lintSidecar } from './validate.js';

const OPTS: RenderOptions = {
  tableId: 'Dark Chaos (apophis 2025) 2.0',
  rom: null,
  originalPath: 'C:\\VPX\\tables\\Dark Chaos (apophis 2025) 2.0.vpx',
  originalSize: 326_840_320,
  originalMtimeMs: new Date(2025, 7, 26, 13, 42, 58).getTime(),
  sidecarPath: 'C:\\VPX\\tables\\Dark Chaos (apophis 2025) 2.0.vbs',
};

const render = (lines: readonly string[], text = crlf(lines)) => {
  const cls = classifyScript(text);
  const r = renderSidecar(text, cls, OPTS);
  const out = decodeScript(r.bytes);
  return { text, cls, r, out, L: splitScript(out).lines };
};
const block = (L: string[]): string[] => L.slice(L.findIndex((l) => l.startsWith("' --- Castcade recipe B anchors")) + 1, L.indexOf("' --- end Castcade recipe B ---"));
const subLines = (L: string[], name: string): string[] => {
  const s = L.findIndex((l) => new RegExp(`^\\s*(?:Public\\s+)?(Sub|Function)\\s+${name}\\b`, 'i').test(l));
  const e = L.findIndex((l, i) => i > s && /^\s*End\s+(Sub|Function)\b/i.test(l));
  return L.slice(s, e + 1);
};
const line = (lines: readonly string[], text: string): number => lines.indexOf(text) + 1;

describe('the shipped anchor overrides (C1.4)', () => {
  it('are well-formed data with distinct ids', () => {
    for (const o of ANCHOR_OVERRIDES) expect(checkOverride(o)).toEqual([]);
    expect(new Set(ANCHOR_OVERRIDES.map((o) => o.id)).size).toBe(ANCHOR_OVERRIDES.length);
    expect(ANCHOR_OVERRIDES.map((o) => o.id)).toEqual(['glf', 'burger', 'rattlecan']);
    expect(overrideById('glf')?.title).toBe('VPX Game Logic Framework (GLF)');
    expect(overrideById('nope')).toBeNull();
    expect(overrideById(null)).toBeNull();
  });

  it('checkOverride names what is wrong with a record', () => {
    const bad: AnchorOverride = {
      id: 'Bad Id',
      title: 'x',
      signature: ['('],
      anchors: { ballEnd: [{ at: 'top', sub: 'Not A Name', pass: 'key' }], scores: [{ at: 'before', line: '[', pass: 'a + b' }] },
      exprs: { ball: ' ' },
    };
    const problems = checkOverride(bad);
    expect(problems).toHaveLength(8);
    expect(problems.join('\n')).toMatch(/the id is lower-case/);
    expect(problems.join('\n')).toMatch(/signature \/\(\/ is not a regular expression/);
    expect(problems.join('\n')).toMatch(/ballEnd sub "Not A Name" is not a name/);
    expect(problems.join('\n')).toMatch(/only a scores place can pass a value/);
    expect(problems.join('\n')).toMatch(/scores line \/\[\/ is not a regular expression/);
    expect(problems.join('\n')).toMatch(/scores passes "a \+ b", which is not a plain identifier/);
    expect(problems.join('\n')).toMatch(/a scores place with pass needs scoresOnly/);
    expect(problems.join('\n')).toMatch(/expression ball is empty/);
    expect(checkOverride({ id: 'x', title: 'x', signature: [] })).toEqual(['x: an empty signature would match every script']);
  });

  it('match by signature: every expression must match a code line; comments do not count', () => {
    expect(findOverride(GLF_B_SCRIPT)?.id).toBe('glf');
    expect(findOverride(BURGER_BALLS_B_SCRIPT)?.id).toBe('burger');
    expect(findOverride(RATTLECAN_TILT_B_SCRIPT)?.id).toBe('rattlecan');
    // the older fixtures lack part of each signature and stay with the vocabulary
    for (const s of [BURGER_B_SCRIPT, RATTLECAN_B_SCRIPT, JPSALAS_B_SCRIPT, DIABLO_B_SCRIPT, VPM_SCRIPT]) expect(findOverride(s)).toBeNull();
    expect(findOverride(GLF_B_SCRIPT.map((l) => (l.startsWith('Function Glf_EndGame') ? `' ${l}` : l)))).toBeNull();
    expect(findOverride(GLF_B_SCRIPT, [])).toBeNull();
  });

  it('a script an override knows is class B, ahead of the vocabulary, with the override named in its facts', () => {
    const glf = classifyScript(crlf(GLF_B_SCRIPT));
    expect(glf.cls).toBe('B');
    expect(glf.facts.override).toBe('glf');
    expect(glf.facts.subs).toMatchObject({ AddScore: null, start: null, end: null, ballEnd: null });
    expect(classifyScript(crlf(JPSALAS_B_SCRIPT)).facts.override).toBeNull();
    // a ROM table is class A whatever else it carries
    expect(classifyScript(crlf([...GLF_B_SCRIPT.slice(1), 'LoadVPM "01560000", "WPC.VBS", 3.26'])).cls).toBe('A');
    // without the override's functions the same script has nothing the vocabulary reads: class E, as Dark Chaos was
    const stripped = GLF_B_SCRIPT.map((l) => l.replace(/\bGlf_EndOfBall\b/g, 'Glf_BallOver'));
    expect(classifyScript(crlf(stripped))).toMatchObject({ cls: 'E', facts: { override: null } });
  });
});

describe('resolvePlace', () => {
  const L = ['Sub A()', '    x = 1', '    Select Case x', '        Case 1', '            y = 1 _', '              + 2', '    End Select', 'End Sub', 'Sub B() : x = 2 : End Sub', 'Class C', '    Sub M()', '        x = 3', '    End Sub', 'End Class', 'x = 4'];
  const ctx = lineContexts(L);
  it('top and end of a multi-line sub', () => {
    expect(resolvePlace(L, ctx, { at: 'top', sub: 'A' })).toEqual([{ idx: 1, where: 'top of Sub A (line 1)' }]);
    expect(resolvePlace(L, ctx, { at: 'end', sub: 'a' })).toEqual([{ idx: 7, where: 'end of Sub a (line 8)' }]);
  });
  it('refuses what cannot carry a line, and says why', () => {
    expect(resolvePlace(L, ctx, { at: 'top', sub: 'Nope' })).toBe('no Sub Nope');
    expect(resolvePlace(L, ctx, { at: 'top', sub: 'B' })).toBe('Sub B is written on one line');
    expect(resolvePlace(L, ctx, { at: 'top', sub: 'M' })).toBe('Sub M is a Class member');
    // module-level code and class members are never matched by a line place
    expect(resolvePlace(L, ctx, { at: 'before', line: 'x = [34]' })).toBe('no line matching /x = [34]/ inside a Sub');
    expect(resolvePlace(L, ctx, { at: 'before', line: 'x = 1', sub: 'B' })).toBe('no line matching /x = 1/ in Sub B');
  });
  it('before / after a line, never inside a continued statement or straight after Select Case', () => {
    expect(resolvePlace(L, ctx, { at: 'before', line: '^\\s*Select\\s+Case\\s+x' })).toEqual([{ idx: 2, where: 'before "Select Case x" in Sub A (line 3)' }]);
    expect(resolvePlace(L, ctx, { at: 'after', line: 'x = 1' })).toEqual([{ idx: 2, where: 'after "x = 1" in Sub A (line 2)' }]);
    expect(resolvePlace(L, ctx, { at: 'after', line: '^\\s*Select\\s+Case' })).toMatch(/line 3 is a Select Case with no Case before the anchor/);
    expect(resolvePlace(L, ctx, { at: 'after', line: 'y = 1' })).toMatch(/continues on the next line/);
    expect(resolvePlace(L, ctx, { at: 'before', line: '\\+ 2' })).toMatch(/continues on the next line/);
    expect(resolvePlace(L, ctx, { at: 'before', line: '=', every: true })).toEqual([
      { idx: 1, where: 'before "x = 1" in Sub A (line 2)' },
      { idx: 4, where: 'before "y = 1 _" in Sub A (line 5)' },
    ]);
  });
});

describe('recipe B with the GLF override (Dark Chaos)', () => {
  it('anchors the four roles in the framework functions and journals from the player state', () => {
    const { r, L, cls } = render(GLF_B_SCRIPT);
    expect(cls.cls).toBe('B');
    expect(parseSidecarMarker(L[1] ?? '')).toEqual({ recipe: 'B', recipeVersion: '0.3.1', libVersion: LIB_VERSION });
    // the framework's own `Glf_KeyDown` comes after the table's handler and is not taken for it
    expect(cls.facts.tableObject).toBe('Table1');
    expect(L).toContain('Public Sub Glf_KeyDown(ByVal keycode)');
    expect(L.slice(L.indexOf('Sub Table1_Exit()'), L.indexOf('Sub Table1_Exit()') + 4)).toEqual(['Sub Table1_Exit()', '    Castcade_Exit', '    Castcade_Orig_Exit', 'End Sub']);
    expect(subLines(L, 'Glf_DispatchGameStarted')).toEqual(['Public Function Glf_DispatchGameStarted(args)', "    Castcade_B_GameStart   ' Castcade: game start", '    DispatchPinEvent "game_started", Null', 'End Function']);
    // Glf_StartGame runs for every Start press and carries nothing
    expect(subLines(L, 'Glf_StartGame').some((l) => l.includes('Castcade'))).toBe(false);
    expect(subLines(L, 'Glf_EndOfBall').slice(0, 3)).toEqual(['Function Glf_EndOfBall(args)', "    Castcade_B_BallEnd   ' Castcade: ball end", '']);
    expect(subLines(L, 'Glf_EndGame').slice(0, 3)).toEqual(['Function Glf_EndGame(args)', "    Castcade_B_GameEnd   ' Castcade: game end", '    glf_gameStarted = False']);
    expect(subLines(L, 'SetPlayerState').slice(-3)).toEqual(['    SetPlayerState = Null', "    Castcade_B_ScoresFor key   ' Castcade: current scores", 'End Function']);
    const SCORES = 'Array(GetPlayerStateForPlayer(0, "score"), GetPlayerStateForPlayer(1, "score"), GetPlayerStateForPlayer(2, "score"), GetPlayerStateForPlayer(3, "score"))';
    expect(block(L)).toEqual([
      'Dim Castcade_B_Players : Castcade_B_Players = 1',
      'Function Castcade_B_Count()',
      '    On Error Resume Next',
      '    Dim n',
      '    n = 0',
      '    n = CLng(UBound(glf_playerState.Keys()) + 1)',
      '    If n > 0 Then Castcade_B_Players = n',
      '    Castcade_B_Count = Castcade_B_Players',
      'End Function',
      'Dim Castcade_B_InGame : Castcade_B_InGame = False',
      'Sub Castcade_B_GameStart()',
      '    On Error Resume Next',
      '    Castcade_B_Players = 1',
      '    Castcade_B_InGame = True',
      '    Castcade_GameStart Castcade_B_Count()',
      'End Sub',
      'Sub Castcade_B_Scores()',
      '    On Error Resume Next',
      `    Castcade_Scores Castcade_PlayerScores(${SCORES}, 0, Castcade_B_Count()), Getglf_currentPlayerNumber() + 1, GetPlayerState("ball")`,
      'End Sub',
      'Sub Castcade_B_ScoresFor(a)',
      '    On Error Resume Next',
      '    If a = "score" Then Castcade_B_Scores',
      'End Sub',
      'Sub Castcade_B_BallEnd()',
      '    On Error Resume Next',
      '    Castcade_BallEnd Getglf_currentPlayerNumber() + 1, GetPlayerState("ball"), GetPlayerState("extra_balls")',
      'End Sub',
      'Sub Castcade_B_GameEnd()',
      '    On Error Resume Next',
      '    If Not Castcade_B_InGame Then Exit Sub',
      '    Castcade_B_InGame = False',
      `    Castcade_GameEnd Castcade_PlayerScores(${SCORES}, 0, Castcade_B_Count()), Castcade_B_Count()`,
      'End Sub',
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.partial).toEqual([]);
    expect(r.anchors).toMatchObject({
      override: 'glf: VPX Game Logic Framework (GLF)',
      gameStart: `top of Sub Glf_DispatchGameStarted (line ${line(GLF_B_SCRIPT, 'Public Function Glf_DispatchGameStarted(args)')}) (override glf)`,
      scores: `end of Sub SetPlayerState (line ${GLF_B_SCRIPT.length}) (override glf)`,
      ballEnd: `top of Sub Glf_EndOfBall (line ${line(GLF_B_SCRIPT, 'Function Glf_EndOfBall(args)')}) (override glf)`,
      gameEnd: `top of Sub Glf_EndGame (line ${line(GLF_B_SCRIPT, 'Function Glf_EndGame(args)')}) (override glf)`,
      subs: 'AddScore none, start none, end none, ball end none',
    });
    expect(r.anchors['scoreStore']).toBeUndefined();
  });

  it('a place the script lacks is reported, and makes the patch partial when it is the game start or end', () => {
    // a GLF build whose Glf_EndGame is written on one line: no game end can be anchored
    const at = GLF_B_SCRIPT.indexOf('Function Glf_EndGame(args)');
    const lines = [...GLF_B_SCRIPT.slice(0, at), 'Function Glf_EndGame(args) : glf_playerState.RemoveAll() : End Function', ...GLF_B_SCRIPT.slice(at + 5)];
    const { r, L } = render(lines);
    expect(r.partial).toEqual(['override glf: Sub Glf_EndGame is written on one line; no game end is journaled']);
    expect(L.some((l) => l.includes("Castcade_B_GameEnd   '"))).toBe(false);
    expect(L.some((l) => l.includes("Castcade_B_BallEnd   '"))).toBe(true);
  });
});

describe('recipe B with the Burger override (2001, Star Wars)', () => {
  it('journals the ball end before the switch on the ball counter, with DMDballnum and the extra ball read from the counter text', () => {
    const { r, L, cls } = render(BURGER_BALLS_B_SCRIPT);
    expect(cls).toMatchObject({ cls: 'B', facts: { override: 'burger' } });
    expect(subLines(L, 'endballcase_timer').slice(0, 3)).toEqual(['sub endballcase_timer', "    Castcade_B_BallEnd   ' Castcade: ball end", ' Select Case ballstext.text']);
    expect(L.filter((l) => l.includes("Castcade_B_BallEnd   '"))).toHaveLength(1);
    const at = L.indexOf('\t\t\t\tgameon = 0');
    expect(L.slice(at, at + 3)).toEqual(['\t\t\t\tgameon = 0', "    Castcade_B_GameEnd   ' Castcade: game end", '\t\t\t\tnumplay = 2']);
    const b = block(L);
    expect(b).toContain('    Castcade_Scores Castcade_PlayerScores(Array(p1score, p2score, p3score, p4score), 0, Castcade_B_Count()), cp, DMDballnum');
    expect(b).toContain('    Castcade_BallEnd cp, DMDballnum, Abs(CLng(ballstext.text) = 999 Or CLng(ballstext.text) < CLng(DMDballnum))');
    expect(b.some((l) => l.includes('ScoresFor'))).toBe(false);
    const flagLine = line(BURGER_BALLS_B_SCRIPT, '\t\t\t\tgameon = 0');
    expect(r.warnings).toEqual([
      `no Sub EndOfGame / GameOver / EndGame; the game end is anchored after "gameon = 0" in Sub endballcase_timer (line ${flagLine}), the first place the game flag is cleared`,
      'Burger template: the extra-ball flag is read from the ball counter text (one behind the ball shown, or 999)',
    ]);
    expect(r.partial).toEqual([]);
    expect(r.anchors).toMatchObject({
      override: 'burger: the Burger template (2001: A Space Odyssey, Star Wars)',
      ballEnd: `before "Select Case ballstext.text" in Sub endballcase_timer (line ${line(BURGER_BALLS_B_SCRIPT, ' Select Case ballstext.text')}) (override burger)`,
      vars: 'Array(p1score, p2score, p3score, p4score) base 0, player cp, ball DMDballnum, players numplay - 1, extra balls Abs(CLng(ballstext.text) = 999 Or CLng(ballstext.text) < CLng(DMDballnum))',
      gameStart: expect.stringMatching(/^end of Sub StartGame/),
      scores: expect.stringMatching(/^end of Sub AddScore/),
    });
  });
});

describe('recipe B with the Rattlecan override', () => {
  it('journals the ball end at the top of both drain timers and the game end after both GameOver=1', () => {
    const { r, L, cls } = render(RATTLECAN_TILT_B_SCRIPT);
    expect(cls).toMatchObject({ cls: 'B', facts: { override: 'rattlecan' } });
    expect(subLines(L, 'ShootAgain_Timer').slice(0, 3)).toEqual(['Sub ShootAgain_Timer', "    Castcade_B_BallEnd   ' Castcade: ball end", '\tSelect Case ExtraBalls']);
    expect(subLines(L, 'ShootAgainAfterTilt_Timer').slice(0, 3)).toEqual(['Sub ShootAgainAfterTilt_Timer', "    Castcade_B_BallEnd   ' Castcade: ball end", '\tTableTilted=0']);
    // GameOver = 1 in Table1_Init and GameOver = 0 in StartGame carry nothing; each timer's GameOver=1 does
    const ends = L.map((l, i) => (l.includes("Castcade_B_GameEnd   '") ? L[i - 1] : null)).filter((l) => l !== null);
    expect(ends).toEqual(['\t\t\t\t\tGameOver=1', '\t\t\t\t\tGameOver=1']);
    expect(block(L)).toContain('    Castcade_BallEnd 1, BallInPlay, ExtraBalls');
    const first = RATTLECAN_TILT_B_SCRIPT.indexOf('\t\t\t\t\tGameOver=1') + 1;
    const second = RATTLECAN_TILT_B_SCRIPT.lastIndexOf('\t\t\t\t\tGameOver=1') + 1;
    expect(r.anchors).toMatchObject({
      override: 'rattlecan: Rattlecan',
      ballEnd: `top of Sub ShootAgain_Timer (line ${line(RATTLECAN_TILT_B_SCRIPT, 'Sub ShootAgain_Timer')}); top of Sub ShootAgainAfterTilt_Timer (line ${line(RATTLECAN_TILT_B_SCRIPT, 'Sub ShootAgainAfterTilt_Timer')}) (override rattlecan)`,
      gameEnd: `after "GameOver=1" in Sub ShootAgain_Timer (line ${first}); after "GameOver=1" in Sub ShootAgainAfterTilt_Timer (line ${second})`,
      subs: expect.stringContaining(`end "GameOver=1" in Sub ShootAgain_Timer (line ${first}) and 1 more, ball end none`),
    });
    expect(r.warnings).toContain(
      `no Sub EndOfGame / GameOver / EndGame; the game end is anchored after "GameOver=1" in Sub ShootAgain_Timer (line ${first}), the first place the game flag is cleared, and after 1 more such statement (Sub ShootAgainAfterTilt_Timer line ${second})`,
    );
    expect(r.warnings.some((w) => /no ball end is journaled/.test(w))).toBe(false);
    expect(r.partial).toEqual([]);
  });
});

describe('recipe B 0.3.0: what changed for every original', () => {
  it('takes `Score` for the score store ahead of an earlier `...Score(...)` with two indexes (JP\'s Foo Fighters)', () => {
    const at = JPSALAS_B_SCRIPT.indexOf('    Score(CurrentPlayer) = Score(CurrentPlayer) + points');
    const lines = [...JPSALAS_B_SCRIPT.slice(0, at), '    If ModeActive > 0 Then', '        CurrentCityScore(CurrentPlayer, ModeActive) = CurrentCityScore(CurrentPlayer, ModeActive) + points', '    End If', ...JPSALAS_B_SCRIPT.slice(at)];
    const { r, L } = render(lines);
    expect(r.anchors['scoreStore']).toBe(`Score(CurrentPlayer) = Score(CurrentPlayer) + points (Sub AddScore, line ${at + 4})`);
    expect(r.anchors['vars']).toBe('Score base 1, player CurrentPlayer, ball Balls, players PlayersPlayingGame, extra balls ExtraBallsAwards(CurrentPlayer)');
    expect(block(L)).toContain('    Castcade_BallEnd CurrentPlayer, Balls, ExtraBallsAwards(CurrentPlayer)');
    expect(r.warnings.some((w) => /is not a variable/.test(w))).toBe(false);
  });

  it('renames the LAST definition of a handler a table defines twice: the one VBScript runs', () => {
    const lines = [...JPSALAS_B_SCRIPT, 'Sub Table1_exit()', '    SaveLUT', 'End Sub'];
    const { L, cls } = render(lines);
    expect(cls.facts.exitLine).toBe(lines.length - 2);
    // the first (dead) definition keeps its name, the last one is what our wrapper calls
    expect(L.filter((l) => /^Sub Table1_Exit\b/i.test(l))).toEqual(['Sub Table1_Exit', 'Sub Table1_exit()']);
    const renamed = L.indexOf('Sub Castcade_Orig_Exit()');
    expect(L[renamed + 1]).toBe('    SaveLUT');
    expect(L.slice(L.indexOf('Sub Table1_exit()'), L.indexOf('Sub Table1_exit()') + 4)).toEqual(['Sub Table1_exit()', '    Castcade_Exit', '    Castcade_Orig_Exit', 'End Sub']);
    expect(unpatchSidecar(render(lines).out)).toBe(crlf(lines));
  });

  it('the undo is byte-exact for a script without a final newline and for handlers spelled in different cases', () => {
    for (const script of [GLF_B_SCRIPT, BURGER_BALLS_B_SCRIPT, RATTLECAN_TILT_B_SCRIPT]) {
      for (const text of [crlf(script), lf(script), mixed(script, 4, 30), noFinalNewline(script)]) {
        const a = render(script, text);
        expect(render(script, text).r.sha256).toBe(a.r.sha256);
        const undone = unpatchSidecar(a.out);
        expect(undone).toBe(text);
        expect(renderSidecar(undone!, classifyScript(undone!), OPTS).sha256).toBe(a.r.sha256);
        // the sidecar ends as the script did
        expect(a.out.endsWith('\n')).toBe(text.endsWith('\n'));
        expect(lintSidecar(text, a.out)).toEqual([]);
      }
    }
    // BURGER_BALLS spells its handlers table1_init / table1_exit / Table1_KeyDown: each wrapper takes its own spelling
    const b = render(BURGER_BALLS_B_SCRIPT);
    expect(b.L).toContain('Sub Table1_KeyDown(ByVal KeyCode)');
    expect(b.L).toContain('Sub table1_exit()');
    expect(b.L).toContain('Sub Castcade_Orig_Exit()');
  });

  it('every anchor line, with or without a passed value, matches the template the undo removes', () => {
    for (const script of [GLF_B_SCRIPT, BURGER_BALLS_B_SCRIPT, RATTLECAN_TILT_B_SCRIPT, JPSALAS_B_SCRIPT]) {
      const { L } = render(script);
      const ours = L.filter((l) => /^\s+Castcade_B_\w+.*' Castcade: /.test(l));
      expect(ours.length).toBeGreaterThanOrEqual(4);
      for (const l of ours) expect(l).toMatch(ORIGINAL_LINE_INSERT);
    }
  });
});
