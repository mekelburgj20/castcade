import { describe, expect, it } from 'vitest';
import { classifyScript } from './classify.js';
import { decodeScript, encodeScript, splitScript, stripComment, vbStringLiteral } from './script-text.js';
import {
  COMMENTED_LOADVPM_SCRIPT,
  NO_KEYDOWN_SCRIPT,
  ORIGINAL_B_SCRIPT,
  ORIGINAL_C_SCRIPT,
  PATCHED_VPM_SCRIPT,
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
