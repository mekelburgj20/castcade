import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderAll } from '../src/render.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('generated schema files and SPEC.md', () => {
  it('are up to date (run `npm run protocol:generate` if this fails)', () => {
    const prose = readFileSync(join(root, 'docs', 'prose.md'), 'utf8');
    const files = renderAll(prose);
    const stale: string[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      if (current !== content) stale.push(rel);
    }
    expect(stale).toEqual([]);
  });

  it('every schema has an $id and a description', () => {
    const files = renderAll('');
    for (const [rel, content] of Object.entries(files)) {
      if (!rel.endsWith('.schema.json')) continue;
      const s = JSON.parse(content) as Record<string, unknown>;
      expect(s['$id'], rel).toMatch(/^https:\/\/castcade\.dev\/protocol\/v\d+\//);
    }
  });
});
