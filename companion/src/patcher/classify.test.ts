import { describe, expect, it } from 'vitest';
import { classifyScript } from './classify.js';
import { decodeScript, encodeScript, splitScript, stripComment, vbStringLiteral } from './script-text.js';
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
} from './test-scripts.test-support.js';

describe('script text', () => {
  it('decode/encode round-trips every byte', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(encodeScript(decodeScript(bytes))).toEqual(bytes);
  });

  it('splits on the dominant newline and remembers it', () => {
    expect(splitScript('a\r\nb\r\n')).toEqual({ lines: ['a', 'b'], newline: '\r\n', trailingNewline: true });
    expect(splitScript('a\nb')).toEqual({ lines: ['a', 'b'], newline: '\n', trailingNewline: false });
    expect(splitScript('a\r\nb\nc\r\n').newline).toBe('\r\n');
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
