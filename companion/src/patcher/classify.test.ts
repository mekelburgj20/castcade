import { describe, expect, it } from 'vitest';
import { classifyScript, describeClass } from './classify.js';
import { decodeScript, describeScriptText, encodeScript, joinScript, lineContexts, looksUtf16, splitScript, stripComment, vbStringLiteral } from './script-text.js';
import {
  BURGER_B_SCRIPT,
  COMMENTED_LOADVPM_SCRIPT,
  DIABLO_B_SCRIPT,
  FUTURAMA_B_SCRIPT,
  JACKS_B_SCRIPT,
  JPSALAS_B_SCRIPT,
  RATTLECAN_B_SCRIPT,
  NO_KEYDOWN_SCRIPT,
  ORIGINAL_B_SCRIPT,
  ORIGINAL_C_SCRIPT,
  ORIGINAL_E_SCRIPT,
  PATCHED_VPM_SCRIPT,
  SCORBIT_C_SCRIPT,
  SCORESERVER_D_SCRIPT,
  SCORESERVER_D_UNKNOWN_SCRIPT,
  VPM_DECLARED_SCRIPT,
  VPM_NO_LOADVPM_SCRIPT,
  VPM_SCRIPT,
  crlf,
  lf,
  mixed,
} from './test-scripts.test-support.js';

describe('script text', () => {
  it('decode/encode round-trips every byte', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(encodeScript(decodeScript(bytes))).toEqual(bytes);
  });

  it('splits on every newline, keeps each line\'s own ending and remembers the dominant one', () => {
    expect(splitScript('a\r\nb\r\n')).toEqual({ lines: ['a', 'b'], endings: ['\r\n', '\r\n'], newline: '\r\n', trailingNewline: true });
    expect(splitScript('a\nb')).toEqual({ lines: ['a', 'b'], endings: ['\n', ''], newline: '\n', trailingNewline: false });
    expect(splitScript('a\r\nb\nc\r\n').newline).toBe('\r\n');
    expect(splitScript('a\r\nb\nc\rd')).toEqual({ lines: ['a', 'b', 'c', 'd'], endings: ['\r\n', '\n', '\r', ''], newline: '\r\n', trailingNewline: false });
    expect(splitScript('')).toEqual({ lines: [''], endings: [''], newline: '\n', trailingNewline: false });
    // C13: a CRLF-majority script's LF-only run is lines, not one chunk.
    expect(splitScript('a\r\nb\nc\nd\r\n').lines).toEqual(['a', 'b', 'c', 'd']);
  });

  it('joinScript gives back mixed endings byte for byte, and the dominant newline to a line without one', () => {
    for (const t of ['a\r\nb\nc\rd', 'a\r\nb\nc\nd\r\n', 'x', '', '\n', 'a\n\n\nb']) expect(joinScript(splitScript(t))).toBe(t);
    // one CRLF in four is not dominant (the rule: CRLF when at least half of all LFs are CRLFs); the new line gets LF
    const s = splitScript('a\nb\nc\nd\r\ne');
    expect(s.newline).toBe('\n');
    expect(joinScript({ ...s, lines: [...s.lines, 'new'], endings: [...s.endings], trailingNewline: true })).toBe('a\nb\nc\nd\r\ne\nnew\n');
    expect(joinScript({ lines: ['a', 'b'], newline: '\r\n', trailingNewline: true })).toBe('a\r\nb\r\n');
  });

  it('names a script\'s bytes for the refusal log, and spots UTF-16', () => {
    expect(describeScriptText('\r\n  Option Explicit\r\nx\ny\rz')).toBe('script 26 bytes, 2 CRLF / 1 LF / 1 CR / 0 NUL; first line "Option Explicit"');
    expect(looksUtf16(crlf(VPM_SCRIPT))).toBe(false);
    expect(looksUtf16(decodeScript(new Uint8Array(Buffer.from(crlf(VPM_SCRIPT), 'utf16le'))))).toBe(true);
    expect(looksUtf16('\u00ff\u00fe' + 'x')).toBe(true);
  });

  it('strips a comment outside a string only', () => {
    expect(stripComment("x = 1 ' note")).toBe('x = 1 ');
    expect(stripComment('s = "it\'s" \' c')).toBe('s = "it\'s" ');
    expect(stripComment("' whole line")).toBe('');
  });

  it('knows which procedure and class each line is in (one-line subs are not entered)', () => {
    const L = ['Dim a', 'Sub One()', '  x = 1', 'End Sub', 'Sub Two : y = 2 : End Sub', 'Class K', '  Private v', '  Public Sub M()', '    z = 3', '  End Sub', 'End Class', 'Function F(a)', 'End Function'];
    expect(lineContexts(L).map((c) => `${c.proc}:${c.procName}:${c.inClass ? 'C' : ''}`)).toEqual([
      '-1::',
      '1:One:',
      '1:One:',
      '1:One:',
      '-1::',
      '-1::C',
      '-1::C',
      '7:M:C',
      '7:M:C',
      '7:M:C',
      '-1::C',
      '11:F:',
      '11:F:',
    ]);
  });

  it('renders ASCII-only VBScript string literals', () => {
    expect(vbStringLiteral('plain')).toBe('"plain"');
    expect(vbStringLiteral('say "hi"')).toBe('"say ""hi"""');
    expect(vbStringLiteral('Pokémon')).toBe('"Pok" & ChrW(233) & "mon"');
    expect(vbStringLiteral('')).toBe('""');
  });
});

describe('classifyScript', () => {
  it('a VPM script is class A with its ROM and anchors', () => {
    const r = classifyScript(crlf(VPM_SCRIPT));
    expect(r.cls).toBe('A');
    expect(r.facts.rom).toBe('mb_106b');
    expect(r.facts.tableObject).toBe('Table1');
    expect(r.facts.optionExplicitLine).toBe(1);
    expect(r.facts.loadVpmLine).toBe(8);
    expect(r.facts.keyDownLine).toBe(21);
    expect(r.facts.keyUpLine).toBe(26);
    expect(r.facts.exitLine).toBe(30);
    expect(r.facts.useVpmNvramDeclared).toBe(false);
    expect(r.facts.nvramCallbackAlreadySet).toBe(false);
    expect(r.facts.alreadyPatched).toBe(false);
  });

  it('notices UseVPMNVRAM declared and NVRAMCallback already set', () => {
    const r = classifyScript(lf(VPM_DECLARED_SCRIPT));
    expect(r.cls).toBe('A');
    expect(r.facts.rom).toBe('afm_113b');
    expect(r.facts.useVpmNvramDeclared).toBe(true);
    expect(r.facts.nvramCallbackAlreadySet).toBe(true);
    expect(r.facts.keyUpLine).toBeNull();
    expect(r.facts.exitLine).toBeNull();
  });

  it('CreateObject("VPinMAME.Controller") alone is class A without a LoadVPM line or ROM', () => {
    const r = classifyScript(lf(VPM_NO_LOADVPM_SCRIPT));
    expect(r.cls).toBe('A');
    expect(r.facts.loadVpmLine).toBeNull();
    expect(r.facts.rom).toBeNull();
  });

  it('a JPSalas-style original is class B', () => {
    const r = classifyScript(crlf(ORIGINAL_B_SCRIPT));
    expect(r.cls).toBe('B');
    expect(r.facts.subs).toEqual({ AddScore: { name: 'AddScore', line: 15 }, start: { name: 'ResetForNewGame', line: 11 }, end: { name: 'EndOfGame', line: 19 }, ballEnd: null });
    expect(r.facts.gameEndFlag).toBeNull();
    expect(r.facts.scoreArray).toBe(true);
  });

  it('Scorbit call sites make class C', () => {
    expect(classifyScript(lf(ORIGINAL_C_SCRIPT)).cls).toBe('C');
  });

  it('a CRLF script with an LF-only run through the KEYS section is still class A (C13, Krobs\' Twilight Zone)', () => {
    const kd = VPM_SCRIPT.findIndex((l) => l.startsWith('Sub Table1_KeyDown'));
    const text = mixed(VPM_SCRIPT, kd - 2, kd + 9);
    const r = classifyScript(text);
    expect(r.cls).toBe('A');
    expect(r.facts.keyDownLine).toBe(kd + 1);
    expect(r.facts.tableObject).toBe('Table1');
    // The other shapes the ArcAid session reproduced: an LF run at the top, CRLF scattered through an LF script.
    expect(classifyScript(mixed(VPM_SCRIPT, 0, 12)).cls).toBe('A');
    expect(classifyScript(VPM_SCRIPT.map((l, i) => l + (i % 3 === 0 ? '\r\n' : '\n')).join('')).cls).toBe('A');
  });

  it('a UTF-16 script is refused for its encoding, never as "no _KeyDown handler"', () => {
    const r = classifyScript(decodeScript(new Uint8Array(Buffer.from('\ufeff' + crlf(VPM_SCRIPT), 'utf16le'))));
    expect(r.cls).toBe('X');
    expect(r.facts.reason).toMatch(/UTF-16/);
  });

  it('no _KeyDown handler is class X', () => {
    const r = classifyScript(lf(NO_KEYDOWN_SCRIPT));
    expect(r.cls).toBe('X');
    expect(r.facts.reason).toBe('no _KeyDown handler');
  });

  it("classifies the recipe tests' synthetic originals as their recipes expect (C1.1)", () => {
    const b = classifyScript(crlf(JPSALAS_B_SCRIPT));
    expect(b.cls).toBe('B');
    expect(b.facts.subs).toEqual({ AddScore: { name: 'AddScore', line: 30 }, start: { name: 'ResetForNewGame', line: 18 }, end: { name: 'EndOfGame', line: 45 }, ballEnd: { name: 'EndOfBall', line: 35 } });
    expect(b.facts.scoreArray).toBe(true);
    const c = classifyScript(crlf(SCORBIT_C_SCRIPT));
    expect(c.cls).toBe('C');
    expect(c.facts.scorbitAnchors).toEqual({ StartSession: 13, SendUpdate: 51, StopSession: 39 });
    const d = classifyScript(crlf(SCORESERVER_D_SCRIPT));
    expect(d.cls).toBe('D');
    expect(d.facts.scoreServer).toBe(true);
    expect(classifyScript(lf(SCORESERVER_D_UNKNOWN_SCRIPT)).cls).toBe('D');
    expect(classifyScript(lf(ORIGINAL_E_SCRIPT)).cls).toBe('E');
  });

  it('a commented-out LoadVPM does not count', () => {
    expect(classifyScript(lf(COMMENTED_LOADVPM_SCRIPT)).cls).toBe('B');
  });

  describe('the original-table vocabulary (C1.3): class B beyond the JPSalas names', () => {
    const line = (lines: readonly string[], text: string): number => lines.indexOf(text) + 1;

    it('Diablo 2: StartGame / AddScore / EndPlayerTurn / GameOver', () => {
      const r = classifyScript(crlf(DIABLO_B_SCRIPT));
      expect(r.cls).toBe('B');
      expect(r.facts.subs).toEqual({
        AddScore: { name: 'AddScore', line: line(DIABLO_B_SCRIPT, 'Sub AddScore(points)') },
        start: { name: 'StartGame', line: line(DIABLO_B_SCRIPT, 'Sub StartGame()') },
        end: { name: 'GameOver', line: line(DIABLO_B_SCRIPT, 'Sub GameOver()') },
        ballEnd: { name: 'EndPlayerTurn', line: line(DIABLO_B_SCRIPT, 'Sub EndPlayerTurn()') },
      });
      expect(r.facts.gameEndFlag).toBeNull();
      expect(r.facts.scoreArray).toBe(false);
      expect(describeClass('B')).toBe('original table (script anchors)');
    });

    it('Jacks Open: Sub StartGame without parentheses, EndOfBall, GameOver', () => {
      const r = classifyScript(crlf(JACKS_B_SCRIPT));
      expect(r.cls).toBe('B');
      expect(r.facts.subs).toMatchObject({ start: { name: 'StartGame' }, end: { name: 'GameOver' }, ballEnd: { name: 'EndOfBall' } });
    });

    it('Futurama: InitGame, "Sub Addscore (value)" with a space before the parenthesis, EndBall, EndGame', () => {
      const r = classifyScript(crlf(FUTURAMA_B_SCRIPT));
      expect(r.cls).toBe('B');
      expect(r.facts.subs).toEqual({
        AddScore: { name: 'Addscore', line: line(FUTURAMA_B_SCRIPT, 'Sub Addscore (value)') },
        start: { name: 'InitGame', line: line(FUTURAMA_B_SCRIPT, 'Sub InitGame(bFastRestart)') },
        end: { name: 'EndGame', line: line(FUTURAMA_B_SCRIPT, 'Sub EndGame') },
        ballEnd: { name: 'EndBall', line: line(FUTURAMA_B_SCRIPT, 'Sub EndBall') },
      });
    });

    it('a variable named GameOver is not an end sub; the game-flag clear stands in, skipping Table1_Init and StartGame', () => {
      const r = classifyScript(crlf(RATTLECAN_B_SCRIPT));
      expect(r.cls).toBe('B');
      expect(r.facts.subs).toMatchObject({ AddScore: { name: 'AddScore' }, start: { name: 'StartGame' }, end: null, ballEnd: null });
      expect(r.facts.gameEndFlag).toEqual({ line: line(RATTLECAN_B_SCRIPT, '\t\t\t\tGameOver=1'), sub: 'ShootAgain_Timer', text: 'GameOver=1' });
      // the same script with a Sub GameOver: the sub is the end, no flag is looked for
      const withSub = classifyScript(crlf([...RATTLECAN_B_SCRIPT, 'Sub GameOver', 'End Sub']));
      expect(withSub.cls).toBe('B');
      expect(withSub.facts.subs?.end).toEqual({ name: 'GameOver', line: RATTLECAN_B_SCRIPT.length + 1 });
      expect(withSub.facts.gameEndFlag).toBeNull();
    });

    it('Burger template: gameon = 0 in table1_init and at the top of StartGame are skipped; the one in Drain_Hit is the end', () => {
      const r = classifyScript(crlf(BURGER_B_SCRIPT));
      expect(r.cls).toBe('B');
      expect(r.facts.subs).toMatchObject({ AddScore: { name: 'AddScore' }, start: { name: 'StartGame' }, end: null, ballEnd: null });
      expect(r.facts.gameEndFlag).toEqual({ line: line(BURGER_B_SCRIPT, '\t\t\t\tgameon = 0'), sub: 'Drain_Hit', text: 'gameon = 0' });
      // a flag clear that is the `x` of a one-line If, or at module level, never counts
      const oneLiner = BURGER_B_SCRIPT.map((l) => (l === '\t\t\t\tgameon = 0' ? '\t\t\t\tIf cp = 1 Then gameon = 0' : l));
      expect(classifyScript(crlf(oneLiner)).cls).toBe('E');
      expect(classifyScript(crlf([...oneLiner, 'gameon = 0'])).cls).toBe('E');
    });

    it('the JPSalas trio stays class B ahead of Scorbit; a table that is B only through the wider names yields to C', () => {
      const jpWithScorbit = [...JPSALAS_B_SCRIPT, 'Sub Tick()', '    Scorbit.StartSession', '    Scorbit.SendUpdate 1, 2, 3, 4, 5, 6, 7', '    Scorbit.StopSession', 'End Sub'];
      expect(classifyScript(crlf(jpWithScorbit)).cls).toBe('B');
      const scorbitWithEndGame = SCORBIT_C_SCRIPT.map((l) => l.replace(/FinishGame/g, 'EndGame'));
      const c = classifyScript(crlf(scorbitWithEndGame));
      expect(c.cls).toBe('C');
      expect(c.facts.subs).toMatchObject({ AddScore: { name: 'AddScore' }, start: { name: 'StartGame' }, end: { name: 'EndGame' }, ballEnd: { name: 'EndBall' } });
    });

    it('class E remains for scoring scripts with no usable anchors', () => {
      // AddScore and a start sub, but no end sub and no game-flag clear
      expect(classifyScript(lf(['Sub Table1_KeyDown(ByVal k)', 'End Sub', 'Sub StartGame()', 'End Sub', 'Sub AddScore(p)', '  Score = Score + p', 'End Sub'])).cls).toBe('E');
      // an end sub and a start sub, but no AddScore
      expect(classifyScript(lf(['Sub Table1_KeyDown(ByVal k)', 'End Sub', 'Sub StartGame()', 'End Sub', 'Sub GameOver()', '  Score = 0', 'End Sub'])).cls).toBe('E');
    });
  });

  it('a script with Castcade_Init outside comments is flagged already patched', () => {
    const r = classifyScript(lf(PATCHED_VPM_SCRIPT));
    expect(r.cls).toBe('A');
    expect(r.facts.alreadyPatched).toBe(true);
    expect(classifyScript(lf(["' Castcade_Init mentioned in a comment", ...VPM_SCRIPT])).facts.alreadyPatched).toBe(false);
  });
});
