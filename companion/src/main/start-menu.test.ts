import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_USER_MODEL_ID, SHORTCUT_DESCRIPTION, START_MENU_LINK, UNINSTALLER, ensureStartMenuShortcut, type ShortcutSpec, type StartMenuDeps } from './start-menu.js';

const companion = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));

const EXE = 'C:\\Users\\p\\AppData\\Local\\Programs\\Castcade\\Castcade.exe';
const MINE = 'C:\\Users\\p\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Castcade.lnk';
const EVERYONE = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Castcade.lnk';

function rig(files: string[], o: Partial<StartMenuDeps> = {}) {
  const have = new Set(files);
  const written: Array<{ path: string; spec: ShortcutSpec }> = [];
  const deps: StartMenuDeps = {
    platform: 'win32',
    packaged: true,
    execPath: EXE,
    appData: 'C:\\Users\\p\\AppData\\Roaming',
    programData: 'C:\\ProgramData',
    exists: (p) => have.has(p),
    writeShortcut: (path, spec) => {
      written.push({ path, spec });
      have.add(path);
      return true;
    },
    ...o,
  };
  return { deps, written };
}

const INSTALLED = 'C:\\Users\\p\\AppData\\Local\\Programs\\Castcade\\Uninstall Castcade.exe';

describe('the Start menu entry (E9)', () => {
  it('is created when missing, as the installer writes it (target, folder, icon, description, AppUserModelID)', () => {
    const r = rig([INSTALLED]);
    expect(ensureStartMenuShortcut(r.deps).result).toBe('created');
    expect(r.written).toEqual([
      {
        path: MINE,
        spec: { target: EXE, cwd: 'C:\\Users\\p\\AppData\\Local\\Programs\\Castcade', description: SHORTCUT_DESCRIPTION, icon: EXE, iconIndex: 0, appUserModelId: 'app.arcaid.castcade' },
      },
    ]);
    // Once there, the next start leaves it alone.
    expect(ensureStartMenuShortcut(r.deps).result).toBe('present');
    expect(r.written).toHaveLength(1);
  });

  it('is never touched when it exists, per user or for all users', () => {
    for (const lnk of [MINE, EVERYONE]) {
      const r = rig([INSTALLED, lnk]);
      expect(ensureStartMenuShortcut(r.deps).result).toBe('present');
      expect(r.written).toEqual([]);
    }
  });

  it('only in a packaged copy the installer made: not in a development run, an unpacked build, or off Windows', () => {
    for (const [files, o] of [
      [[INSTALLED], { packaged: false }],
      [[], {}],
      [[INSTALLED], { platform: 'linux' }],
    ] as Array<[string[], Partial<StartMenuDeps>]>) {
      const r = rig(files, o);
      expect(ensureStartMenuShortcut(r.deps).result).toBe('skipped');
      expect(r.written).toEqual([]);
    }
  });

  it('says so when Windows refuses it', () => {
    expect(ensureStartMenuShortcut(rig([INSTALLED], { writeShortcut: () => false }).deps).result).toBe('failed');
    const thrown = ensureStartMenuShortcut(
      rig([INSTALLED], {
        writeShortcut: () => {
          throw new Error('access denied');
        },
      }).deps,
    );
    expect(thrown).toMatchObject({ result: 'failed' });
    expect(thrown.line).toContain('access denied');
  });

  it("matches what electron-builder's installer writes: appId, shortcutName, the package description, the uninstaller's name", () => {
    const yml = readFileSync(companion('electron-builder.yml'), 'utf8');
    expect(yml).toMatch(new RegExp(`^appId: ${APP_USER_MODEL_ID.replace(/\./g, '\\.')}$`, 'm'));
    expect(yml).toMatch(new RegExp(`^\\s+shortcutName: ${START_MENU_LINK.replace(/\.lnk$/, '')}$`, 'm'));
    expect(yml).toMatch(/^productName: Castcade$/m);
    expect(UNINSTALLER).toBe('Uninstall Castcade.exe');
    const pkg = JSON.parse(readFileSync(companion('package.json'), 'utf8')) as { description: string };
    expect(SHORTCUT_DESCRIPTION).toBe(pkg.description);
  });
});
