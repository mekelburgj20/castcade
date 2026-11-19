/**
 * E10: the Witness installer's electron-builder config is a standalone copy of the full one (`extends` would concatenate
 * the arrays it must drop), so this checks that the two agree on everything an install over the other depends on, and
 * that the Witness one differs only where it must.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installerPrefix } from './edition.js';

const companionDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The YAML parser electron-builder itself reads these files with (a dependency of electron-builder, a devDependency here).
const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };

type Config = Record<string, unknown> & {
  win: Record<string, unknown>;
  nsis: Record<string, unknown>;
  publish: Record<string, unknown>;
  extraResources: Array<{ from: string; to: string }>;
};
const load = (name: string): Config => yaml.load(readFileSync(join(companionDir, name), 'utf8')) as Config;
const without = (o: Record<string, unknown>, ...keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const full = load('electron-builder.yml');
const witness = load('electron-builder.witness.yml');

describe('electron-builder.witness.yml agrees with electron-builder.yml (E10)', () => {
  it('same app: appId, productName, and so the same userData folder and install over each other', () => {
    expect(witness.appId).toBe('app.arcaid.castcade');
    expect(witness.appId).toBe(full.appId);
    expect(witness.productName).toBe(full.productName);
    expect(witness.copyright).toBe(full.copyright);
  });

  it('same files, packaging switches, win and nsis keys (but the artifact name and the NSIS include)', () => {
    for (const key of ['directories', 'npmRebuild', 'asar', 'files']) expect(witness[key], key).toEqual(full[key]);
    expect(without(witness.win, 'artifactName')).toEqual(without(full.win, 'artifactName'));
    expect(without(witness.nsis, 'include')).toEqual(without(full.nsis, 'include'));
  });

  it('same publish target; the Witness one on its own update channel (witness.yml)', () => {
    for (const key of ['provider', 'owner', 'repo', 'releaseType']) expect(witness.publish[key], key).toEqual(full.publish[key]);
    expect(witness.publish.channel).toBe('witness');
    expect(full.publish.channel).toBeUndefined();
  });

  it("each installer's name starts as the app's update guard expects", () => {
    expect(String(full.win.artifactName).startsWith(installerPrefix('full'))).toBe(true);
    expect(String(witness.win.artifactName).startsWith(installerPrefix('witness'))).toBe(true);
  });

  it('the Witness edition is baked into its package.json, carries no helper, registers no link', () => {
    expect(witness.extraMetadata).toEqual({ castcadeEdition: 'witness' });
    expect(full.extraMetadata).toBeUndefined();
    expect(witness.extraResources.map((r) => r.to)).toEqual(['maps', 'vps', 'hook/castcade.vbs']);
    // Every resource it carries is one the full installer carries from the same place.
    for (const r of witness.extraResources) expect(full.extraResources).toContainEqual(r);
    expect(full.extraResources.map((r) => r.to)).toEqual(expect.arrayContaining(['ffmpeg', 'vr-overlay', 'vr-layer', 'audio-helper', 'video-helper']));
    expect(witness.protocols).toBeUndefined();
    expect(full.protocols).toBeDefined();
  });

  it('the NSIS include: the full installer as before, the Witness one through installer-witness.nsh', () => {
    expect(full.nsis.include).toBe('build/installer.nsh');
    expect(witness.nsis.include).toBe('build/installer-witness.nsh');
    const wrapper = readFileSync(join(companionDir, 'build', 'installer-witness.nsh'), 'utf8');
    expect(wrapper).toMatch(/^!define CASTCADE_WITNESS_EDITION\r?$/m);
    expect(wrapper).toMatch(/^!include "\$\{__FILEDIR__\}\\installer\.nsh"\r?$/m);
    const nsh = readFileSync(join(companionDir, 'build', 'installer.nsh'), 'utf8');
    // The firewall rule and the castcade:// keys are written in the !else branch only (the full installer).
    const install = /!macro customInstall\r?\n([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? '';
    const witnessPart = /!ifdef CASTCADE_WITNESS_EDITION\r?\n([\s\S]*?)!else\r?\n/.exec(install)?.[1] ?? '';
    const fullPart = /!else\r?\n([\s\S]*?)!endif\r?\n/.exec(install)?.[1] ?? '';
    expect(witnessPart).toContain('DeleteRegKey HKCU "Software\\Classes\\castcade"');
    expect(witnessPart).toContain('firewall delete rule name="Castcade video helper"');
    expect(witnessPart).not.toContain('add rule');
    expect(witnessPart).not.toContain('WriteRegStr');
    expect(fullPart).toContain('add rule');
    expect(fullPart).toContain('WriteRegStr HKCU "Software\\Classes\\castcade"');
    // E9's end of an update runs for both (after the !endif).
    expect(install.slice(install.indexOf('!endif'))).toContain('${isUpdated}');
  });
});
