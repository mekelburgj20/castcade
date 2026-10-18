/**
 * Renders the zod schemas to JSON Schema files and SPEC.md.
 *   npm run generate -w protocol          writes the files
 *   npm run generate -w protocol -- --check   exits 1 if the files on disk are stale (CI)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAll } from '../src/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const check = process.argv.includes('--check');

const prose = readFileSync(join(root, 'docs', 'prose.md'), 'utf8');
const files = renderAll(prose);

let stale = 0;
for (const [rel, content] of Object.entries(files)) {
  const abs = join(root, rel);
  if (check) {
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (current !== content) {
      console.error(`stale: ${rel}`);
      stale++;
    }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    console.log(`wrote ${rel}`);
  }
}
if (check) {
  if (stale) {
    console.error(`${stale} generated file(s) out of date; run: npm run protocol:generate`);
    process.exit(1);
  }
  console.log('generated files are up to date');
}
