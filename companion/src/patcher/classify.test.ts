import { describe, expect, it } from 'vitest';
import { classifyScript } from './classify.js';
import { decodeScript, describeScriptText, encodeScript, joinScript, looksUtf16, splitScript, stripComment, vbStringLiteral } from './script-text.js';
import {
  COMMENTED_LOADVPM_SCRIPT,
  JPSALAS_B_SCRIPT,
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
    expect(r.facts.subs).toEqual({ AddScore: 15, ResetForNewGame: 11, EndOfGame: 19, EndOfBall: null });
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
    expect(b.facts.subs).toEqual({ AddScore: 30, ResetForNewGame: 18, EndOfGame: 45, EndOfBall: 35 });
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

  it('a script with Castcade_Init outside comments is flagged already patched', () => {
    const r = classifyScript(lf(PATCHED_VPM_SCRIPT));
    expect(r.cls).toBe('A');
    expect(r.facts.alreadyPatched).toBe(true);
    expect(classifyScript(lf(["' Castcade_Init mentioned in a comment", ...VPM_SCRIPT])).facts.alreadyPatched).toBe(false);
  });
});
