import { describe, expect, it } from 'vitest';
import { classifyHunk, describeScriptDiff, diffStatements, normalizeScript, scriptDiffReport, scriptDiffWire, type Hunk } from './script-diff.js';

/** Apply hunks to `a` (hunk `at` is 1-based into `a`). */
function apply(a: string[], hunks: Hunk[]): string[] {
  const out: string[] = [];
  let i = 0;
  for (const h of hunks) {
    while (i < h.at - 1) out.push(a[i++]!);
    i += h.del.length;
    out.push(...h.add);
  }
  while (i < a.length) out.push(a[i++]!);
  return out;
}

/** Reference: the minimal number of deleted + added lines, from an LCS table (small inputs only). */
function editDistance(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return a.length + b.length - 2 * dp[a.length]![b.length]!;
}

describe('normalizeScript', () => {
  it('drops comments and Rem, keeps a quote inside a string, splits on colons outside strings, joins continuations', () => {
    const text = [
      "Option Explicit ' a comment",
      'Const   VRRoom = 1 ',
      'Rem old style comment',
      'msg = "it\'s: fine" : x = 2',
      'Call Foo(1, _',
      '   2)',
      '',
      'S = "say ""hi"" : Ok"',
    ].join('\r\n');
    expect(normalizeScript(text)).toEqual(['option explicit', 'const vrroom = 1', 'msg = "it\'s: fine"', 'x = 2', 'call foo(1, 2)', 's = "say ""hi"" : Ok"']);
  });

  it('is case-insensitive outside strings but keeps string contents', () => {
    expect(normalizeScript('Const cGameName = "MB_106b"')).toEqual(['const cgamename = "MB_106b"']);
    expect(normalizeScript('CONST CGAMENAME = "MB_106b"')).toEqual(normalizeScript('const cgamename = "MB_106b"'));
  });
});

describe('diffStatements', () => {
  it('no change, pure insertion, pure deletion, replacement', () => {
    expect(diffStatements(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(diffStatements(['a', 'c'], ['a', 'b', 'c'])).toEqual([{ at: 2, del: [], add: ['b'] }]);
    expect(diffStatements(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ at: 2, del: ['b'], add: [] }]);
    expect(diffStatements(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([{ at: 2, del: ['b'], add: ['x'] }]);
  });

  it('random cases: applying the hunks gives the target, with the minimal number of edits', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 300; n++) {
      const a = Array.from({ length: Math.floor(rnd() * 25) }, () => 'abcdef'[Math.floor(rnd() * 6)]!);
      const b = Array.from({ length: Math.floor(rnd() * 25) }, () => 'abcdef'[Math.floor(rnd() * 6)]!);
      const h = diffStatements(a, b)!;
      expect(apply(a, h)).toEqual(b);
      expect(h.reduce((s, x) => s + x.del.length + x.add.length, 0)).toBe(editDistance(a, b));
    }
  });

  it('gives up past the edit-distance cap', () => {
    expect(diffStatements(['a', 'b', 'c'], ['x', 'y', 'z'], 2)).toBeNull();
  });
});

describe('classifyHunk', () => {
  const h = (del: string[], add: string[]): Hunk => ({ at: 1, del, add });

  it('a cosmetic literal change is allowed', () => {
    expect(classifyHunk(h(['const vrroom = 1'], ['const vrroom = 0']))).toMatchObject({ cls: 'allowed', why: 'cosmetic option vrroom' });
    expect(classifyHunk(h(['const volumedial = 0.1'], ['const volumedial = 0.8']))).toMatchObject({ cls: 'allowed' });
  });

  it('options-block values that change play are restricted, even beside the cosmetic ones', () => {
    expect(classifyHunk(h(['const outlanedifficulty = 2'], ['const outlanedifficulty = 0']))).toMatchObject({ cls: 'restricted', why: 'touches outlanedifficulty' });
    expect(classifyHunk(h(['const ballsize = 50'], ['const ballsize = 45']))).toMatchObject({ cls: 'restricted' });
    expect(classifyHunk(h(['ballsavertime = 20'], ['ballsavertime = 999']))).toMatchObject({ cls: 'restricted' });
    expect(classifyHunk(h(['leftflipper.strength = 3250'], ['leftflipper.strength = 4000']))).toMatchObject({ cls: 'restricted' });
    expect(classifyHunk(h(['const cgamename = "mb_106b"'], ['const cgamename = "mb_10"']))).toMatchObject({ cls: 'restricted' });
  });

  it('a NEW ball, switch write or dynamic code is restricted; an existing one moved is not', () => {
    expect(classifyHunk(h([], ['bstrough.createball']))).toMatchObject({ cls: 'restricted', why: 'adds createball' });
    expect(classifyHunk(h([], ['controller.switch(23) = 1']))).toMatchObject({ cls: 'restricted', why: 'adds a switch write' });
    expect(classifyHunk(h([], ['executeglobal s']))).toMatchObject({ cls: 'restricted', why: 'adds executeglobal' });
    expect(classifyHunk(h(['executeglobal gettextfile("core.vbs")'], ['executeglobal gettextfile("core.vbs")', 'x = 1']))).toMatchObject({ cls: 'unknown' });
  });

  it('a name inside a string is not a restricted name', () => {
    expect(classifyHunk(h(['msg = "tilt"'], ['msg = "tilted"']))).toMatchObject({ cls: 'unknown' });
  });

  it('anything else is unknown', () => {
    expect(classifyHunk(h(['x = 1'], ['x = 2']))).toMatchObject({ cls: 'unknown' });
    expect(classifyHunk(h(['const vrroom = 1'], ['const vrroom = 1', 'call foo']))).toMatchObject({ cls: 'unknown' });
  });
});

describe('scriptDiffReport and its wire form', () => {
  const base = ['Option Explicit', 'Const VRRoom = 1', 'Const BallSaverTime = 20', 'Sub Table1_Init', '  x = 1', 'End Sub'].join('\r\n');

  it('the same script reformatted and re-cased is no change, and no wire', () => {
    const same = ['option explicit', "const vrroom = 1 ' note", 'CONST BallSaverTime   =   20', 'sub table1_init : x = 1', 'end sub'].join('\n');
    const r = scriptDiffReport(base, same, { ran: 'foreign', baseline: 'embedded' });
    expect(r.hunks).toEqual([]);
    expect(r.ranSha256).toBe(r.baselineSha256);
    expect(scriptDiffWire(r)).toBeNull();
    expect(describeScriptDiff(r)).toBe("script: a sidecar .vbs that is not Castcade's, no change from the embedded script");
  });

  it('one allowed and one restricted edit: restricted listed first on the wire', () => {
    const ran = base.replace('VRRoom = 1', 'VRRoom = 0').replace('BallSaverTime = 20', 'BallSaverTime = 999');
    const r = scriptDiffReport(base, ran, { ran: 'foreign', baseline: 'embedded' });
    expect(r.counts).toEqual({ allowed: 0, restricted: 1, unknown: 0 });
    // Adjacent edits form one hunk; a restricted name anywhere in it makes it restricted.
    const w = JSON.parse(scriptDiffWire(r)!);
    expect(w).toMatchObject({ v: 1, ran: 'foreign', baseline: 'embedded', counts: { restricted: 1 }, truncated: false });
    expect(w.hunks[0]).toMatchObject({ cls: 'restricted', del: ['const vrroom = 1', 'const ballsavertime = 20'], add: ['const vrroom = 0', 'const ballsavertime = 999'] });
    expect(describeScriptDiff(r)).toMatch(/1 restricted vs the embedded script \(first restricted: touches ballsavertime\)/);
  });

  it('separate edits stay separate hunks, each classified', () => {
    const lines = ['Const VRRoom = 1', 'a = 1', 'b = 2', 'c = 3', 'Const BallSaverTime = 20'];
    const ran = ['Const VRRoom = 0', 'a = 1', 'b = 2', 'c = 3', 'Const BallSaverTime = 999'];
    const r = scriptDiffReport(lines.join('\n'), ran.join('\n'), { ran: 'foreign', baseline: 'embedded' });
    expect(r.counts).toEqual({ allowed: 1, restricted: 1, unknown: 0 });
  });

  it('the wire stays under its cap and says when it was cut', () => {
    const many = Array.from({ length: 200 }, (_, i) => `v${i} = ${i}`);
    const changed = many.map((l, i) => (i % 2 === 0 ? `${l}0` : l));
    const r = scriptDiffReport(many.join('\n'), changed.join('\n'), { ran: 'foreign', baseline: 'embedded' });
    const wire = scriptDiffWire(r)!;
    expect(wire.length).toBeLessThanOrEqual(3000);
    expect(JSON.parse(wire)).toMatchObject({ truncated: true, counts: { unknown: 100 } });
  });
});
