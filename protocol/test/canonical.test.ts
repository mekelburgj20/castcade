import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'canonical.json'), 'utf8')) as {
  input: unknown;
  output: string;
}[];

describe('canonicalJson', () => {
  it('matches the pinned samples', () => {
    for (const s of samples) expect(canonicalJson(s.input)).toBe(s.output);
  });
  it('drops undefined properties and turns undefined array items into null', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });
  it('rejects non-finite numbers and bigints', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
  });
  it('is stable under key insertion order', () => {
    const a = canonicalJson({ x: 1, y: { q: 1, p: 2 } });
    const b = canonicalJson({ y: { p: 2, q: 1 }, x: 1 });
    expect(a).toBe(b);
  });
});
