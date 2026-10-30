/**
 * B4.1: record the tag census of a real .vpx into fixtures/playfield/tags.json. Run from the repo root:
 *   npm run playfield-tags -w companion -- "<table.vpx>"   (or: npx tsx companion/scripts/playfield-tags.ts "<table.vpx>")
 * Writes tag names and counts only, never table data.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFs } from '../src/witness/fs.js';
import { fingerprintTagList, playfieldTagCensus } from '../src/witness/playfield-fingerprint.js';
import { readVpxFacts, readVpxPlayfieldStreams } from '../src/witness/vpx-file.js';

const input = process.argv[2];
if (!input) {
  console.error('usage: playfield-tags <table.vpx>');
  process.exit(2);
}
const path = resolve(input);
const facts = await readVpxFacts(nodeFs, path);
const census = playfieldTagCensus(await readVpxPlayfieldStreams(nodeFs, path));
const table = facts.tableInfo.tableName || basename(path).replace(/.vpx$/i, '');
// The file records no VPX version string; fileVersion (e.g. 1080) stands in for it.
const vpxVersion: string | null = null;
const out = { recordedAt: new Date().toISOString(), table, fileVersion: facts.fileVersion, vpxVersion, pinned: fingerprintTagList(), census };
const dest = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/playfield/tags.json');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${dest} (${table}, file version ${facts.fileVersion})`);
