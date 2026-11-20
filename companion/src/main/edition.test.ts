import { describe, expect, it } from 'vitest';
import { DEFAULT_EDITION, featuresFor, installerPrefix, resolveEdition, updateMatchesEdition } from './edition.js';
import { isCastcadeLayer, removeFullEditionLeftovers } from './edition-leftovers.js';
import { OPENXR_IMPLICIT_LAYERS_KEY } from '../media/vr-layer.js';

const pkg = (extra: Record<string, unknown> = {}): string => JSON.stringify({ name: '@castcade/companion', version: '0.2.46', ...extra });

describe('resolveEdition (E10)', () => {
  it('is full when nothing says otherwise', () => {
    expect(DEFAULT_EDITION).toBe('full');
    expect(resolveEdition({ packageJson: pkg(), env: {}, packaged: true })).toEqual({ edition: 'full', source: 'default', ignored: null });
    expect(resolveEdition({ packageJson: null, env: {}, packaged: false })).toEqual({ edition: 'full', source: 'default', ignored: null });
    expect(resolveEdition({ packageJson: 'not json', env: {}, packaged: true })).toEqual({ edition: 'full', source: 'default', ignored: null });
  });

  it('reads the packaged package.json (electron-builder.witness.yml extraMetadata)', () => {
    expect(resolveEdition({ packageJson: pkg({ castcadeEdition: 'witness' }), env: {}, packaged: true })).toEqual({ edition: 'witness', source: 'package', ignored: null });
    expect(resolveEdition({ packageJson: pkg({ castcadeEdition: 'full' }), env: {}, packaged: true })).toEqual({ edition: 'full', source: 'package', ignored: null });
    expect(resolveEdition({ packageJson: pkg({ castcadeEdition: ' Witness ' }), env: {}, packaged: true }).edition).toBe('witness');
  });

  it('the package wins over the environment', () => {
    expect(resolveEdition({ packageJson: pkg({ castcadeEdition: 'witness' }), env: { CASTCADE_EDITION: 'full' }, packaged: false }).edition).toBe('witness');
    expect(resolveEdition({ packageJson: pkg({ castcadeEdition: 'full' }), env: { CASTCADE_EDITION: 'witness' }, packaged: false }).edition).toBe('full');
  });

  it('CASTCADE_EDITION is a development override only: a packaged build never reads it', () => {
    expect(resolveEdition({ packageJson: pkg(), env: { CASTCADE_EDITION: 'witness' }, packaged: false })).toEqual({ edition: 'witness', source: 'env', ignored: null });
    expect(resolveEdition({ packageJson: pkg(), env: { CASTCADE_EDITION: 'full' }, packaged: false })).toEqual({ edition: 'full', source: 'env', ignored: null });
    expect(resolveEdition({ packageJson: pkg(), env: { CASTCADE_EDITION: 'witness' }, packaged: true })).toEqual({ edition: 'full', source: 'default', ignored: null });
    expect(resolveEdition({ packageJson: pkg(), env: { CASTCADE_EDITION: '  ' }, packaged: false }).source).toBe('default');
  });

  it('an unknown value is full and is reported for the log', () => {
    expect(resolveEdition({ packageJson: pkg(), env: { CASTCADE_EDITION: 'cabinet' }, packaged: false })).toEqual({ edition: 'full', source: 'env', ignored: 'cabinet' });
    expect(resolveEdition({ packageJson: pkg({ castcadeEdition: 'lite' }), env: {}, packaged: true })).toEqual({ edition: 'full', source: 'package', ignored: 'lite' });
    expect(resolveEdition({ packageJson: pkg({ castcadeEdition: 3 }), env: { CASTCADE_EDITION: 'witness' }, packaged: false })).toEqual({ edition: 'full', source: 'package', ignored: '3' });
  });
});

describe('featuresFor (E10)', () => {
  it('the full app runs everything; the Witness edition none of it', () => {
    expect(featuresFor('full')).toEqual({ stream: true, match: true, watch3d: true, overlayServer: true });
    expect(featuresFor('witness')).toEqual({ stream: false, match: false, watch3d: false, overlayServer: false });
  });

  it('names each installer', () => {
    expect(installerPrefix('full')).toBe('Castcade-Setup-');
    expect(installerPrefix('witness')).toBe('Castcade-Witness-Setup-');
  });
});

describe('updateMatchesEdition (E10, the update guard)', () => {
  const full = ['Castcade-Setup-0.2.46.exe'];
  const witness = ['Castcade-Witness-Setup-0.2.46.exe'];

  it("a Witness edition takes only a Witness installer (the latest.yml fallback is refused)", () => {
    expect(updateMatchesEdition('witness', witness)).toBe(true);
    expect(updateMatchesEdition('witness', full)).toBe(false);
    expect(updateMatchesEdition('witness', [])).toBe(false);
  });

  it('a full edition refuses a Witness installer and takes anything else, as before', () => {
    expect(updateMatchesEdition('full', full)).toBe(true);
    expect(updateMatchesEdition('full', witness)).toBe(false);
    expect(updateMatchesEdition('full', [])).toBe(true);
  });

  it('reads the installer (.exe) out of URLs, paths and the other files of an update', () => {
    expect(updateMatchesEdition('witness', ['https://github.com/o/r/releases/download/v0.2.46/Castcade-Witness-Setup-0.2.46.exe', 'Castcade-Witness-Setup-0.2.46.exe'])).toBe(true);
    expect(updateMatchesEdition('witness', ['Castcade-Witness-Setup-0.2.46.exe', 'Castcade-Witness-Setup-0.2.46.exe.blockmap'])).toBe(true);
    expect(updateMatchesEdition('witness', ['castcade-witness-setup-0.2.46.EXE?x=1'])).toBe(true);
    expect(updateMatchesEdition('witness', ['Castcade-Witness-Setup-0.2.46.exe', 'Castcade-Setup-0.2.46.exe'])).toBe(false);
    expect(updateMatchesEdition('full', ['C:\\cache\\Castcade-Witness-Setup-0.2.46.exe'])).toBe(false);
    // No .exe at all: every name counts.
    expect(updateMatchesEdition('witness', ['Castcade-Witness-Setup-0.2.46.7z'])).toBe(true);
    expect(updateMatchesEdition('full', ['Castcade-Witness-Setup-0.2.46.7z'])).toBe(false);
  });
});

describe('removeFullEditionLeftovers (E10)', () => {
  const ours = String.raw`C:\Users\p\AppData\Local\Castcade\vr-layer\0.2.45\XrApiLayer_castcade_panel.json`;
  const installed = String.raw`C:\Users\p\AppData\Local\Programs\Castcade\resources\vr-layer\XrApiLayer_castcade_panel.json`;
  const other = String.raw`C:\Program Files\OBS\obs-mirror\XrApiLayer_obs_mirror.json`;
  const query = (names: string[]): string =>
    `\r\n${OPENXR_IMPLICIT_LAYERS_KEY.replace('HKCU', 'HKEY_CURRENT_USER')}\r\n${names.map((n) => `    ${n}    REG_DWORD    0x0`).join('\r\n')}\r\n\r\n`;

  const rig = (o: { names?: string[]; queryFails?: boolean; deleteFails?: boolean; protocol?: boolean | Error } = {}) => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const removedSchemes: string[] = [];
    const run = removeFullEditionLeftovers({
      exec: async (file, args) => {
        calls.push([file, ...args]);
        if (args[0] === 'query') {
          if (o.queryFails) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
          return { stdout: query(o.names ?? []) };
        }
        if (o.deleteFails) throw new Error('access denied');
        return { stdout: 'The operation completed successfully.' };
      },
      protocol: {
        removeAsDefaultProtocolClient: (scheme) => {
          removedSchemes.push(scheme);
          if (o.protocol instanceof Error) throw o.protocol;
          return o.protocol ?? true;
        },
      },
      log: (line) => logs.push(line),
    });
    return { run, calls, logs, removedSchemes };
  };

  it("removes only Castcade's layer registrations, wherever they point, and the castcade:// link", async () => {
    const r = rig({ names: [ours, other, installed] });
    expect(await r.run).toEqual({ layers: [ours, installed], link: true });
    const deletes = r.calls.filter((c) => c[1] === 'delete');
    expect(deletes).toEqual([
      ['reg.exe', 'delete', OPENXR_IMPLICIT_LAYERS_KEY, '/v', ours, '/f'],
      ['reg.exe', 'delete', OPENXR_IMPLICIT_LAYERS_KEY, '/v', installed, '/f'],
    ]);
    expect(r.removedSchemes).toEqual(['castcade']);
    expect(r.logs.filter((l) => l.includes('removed'))).toHaveLength(2);
  });

  it('leaves another layer alone and says there was nothing of Castcade', async () => {
    const r = rig({ names: [other] });
    expect(await r.run).toEqual({ layers: [], link: true });
    expect(r.calls.filter((c) => c[1] === 'delete')).toEqual([]);
    expect(r.logs.some((l) => l.includes('no Castcade OpenXR layer registration'))).toBe(true);
  });

  it('never throws: a missing key, a refused delete, a protocol call that throws', async () => {
    expect(await rig({ queryFails: true }).run).toEqual({ layers: [], link: true });
    const refused = rig({ names: [ours], deleteFails: true, protocol: new Error('registry locked') });
    expect(await refused.run).toEqual({ layers: [], link: null });
    expect(refused.logs.some((l) => l.includes('could not remove the OpenXR layer registration'))).toBe(true);
    expect(refused.logs.some((l) => l.includes('registry locked'))).toBe(true);
    expect((await rig({ protocol: false }).run).link).toBe(false);
  });

  it("knows Castcade's manifest by its file name only", () => {
    expect(isCastcadeLayer(ours)).toBe(true);
    expect(isCastcadeLayer('XrApiLayer_castcade_panel.json')).toBe(true);
    expect(isCastcadeLayer(String.raw`D:\dev\castcade\vr-layer\build\Release\XRAPILAYER_CASTCADE_PANEL.JSON`)).toBe(true);
    expect(isCastcadeLayer(other)).toBe(false);
    expect(isCastcadeLayer(String.raw`C:\x\not_XrApiLayer_castcade_panel.json.bak`)).toBe(false);
    expect(isCastcadeLayer(String.raw`C:\x\myXrApiLayer_castcade_panel.json`)).toBe(false);
  });
});
