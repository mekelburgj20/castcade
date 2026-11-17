/**
 * E9 (2026-11-16): the Start menu entry is put back when it is missing. The owner's PC had none (only the Desktop
 * shortcut of the first install), and no update brings one back: electron-builder's installer keeps shortcuts on an
 * update (`KeepShortcuts` under its registry key; `addStartMenuLink` in templates/nsis/include/installer.nsh), so a
 * missing one stays missing. Without it the app cannot be found by search, and Windows ties an app's notifications to
 * the Start menu shortcut that carries its AppUserModelID.
 *
 * The shortcut is the one the installer writes (`CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe"
 * 0 "" "" "${APP_DESCRIPTION}"` from `$INSTDIR`, then `WinShell::SetLnkAUMI … "${APP_ID}"`): target and icon the
 * running exe, working folder its folder, the package description, AppUserModelID the appId. Only in an install made
 * by the installer (its uninstaller is beside the exe), never in a development or unpacked run, and never over a
 * shortcut that exists (per user or for all users); the Desktop shortcut is not looked at.
 */
import { win32 } from 'node:path';

/** Windows paths on any host (the tests run on Linux too). */
const { dirname, join } = win32;

/** electron-builder.yml `appId`, which the installer writes as the shortcuts' AppUserModelID; the app sets the same. */
export const APP_USER_MODEL_ID = 'app.arcaid.castcade';
/** electron-builder.yml `nsis.shortcutName` + `.lnk`. */
export const START_MENU_LINK = 'Castcade.lnk';
/** companion/package.json `description` (the installer's `APP_DESCRIPTION`, the shortcut's comment). */
export const SHORTCUT_DESCRIPTION = 'Castcade companion: Electron desktop app (host/client match engine, Witness producer, media, launch).';
/** `Uninstall ${PRODUCT_FILENAME}.exe`, which the installer writes beside the exe. */
export const UNINSTALLER = 'Uninstall Castcade.exe';

const PROGRAMS = ['Microsoft', 'Windows', 'Start Menu', 'Programs'];

/** What `shell.writeShortcutLink` takes (the fields Castcade sets). */
export interface ShortcutSpec {
  target: string;
  cwd: string;
  description: string;
  icon: string;
  iconIndex: number;
  appUserModelId: string;
}

export interface StartMenuDeps {
  platform: string;
  packaged: boolean;
  execPath: string;
  /** %APPDATA% (`app.getPath('appData')`): the per-user Start menu is under it. */
  appData: string;
  /** %ProgramData%: the all-users Start menu is under it; null when unknown. */
  programData: string | null;
  exists(path: string): boolean;
  /** `shell.writeShortcutLink(path, 'create', spec)`. */
  writeShortcut(path: string, spec: ShortcutSpec): boolean;
}

export type StartMenuResult = { result: 'created' | 'present' | 'skipped' | 'failed'; line: string };

export function ensureStartMenuShortcut(d: StartMenuDeps): StartMenuResult {
  if (d.platform !== 'win32') return { result: 'skipped', line: 'start menu: not Windows' };
  if (!d.packaged) return { result: 'skipped', line: 'start menu: development run, not touched' };
  const dir = dirname(d.execPath);
  if (!d.exists(join(dir, UNINSTALLER))) return { result: 'skipped', line: `start menu: ${dir} is not an installed copy (no ${UNINSTALLER}), not touched` };
  const mine = join(d.appData, ...PROGRAMS, START_MENU_LINK);
  const everyone = d.programData ? join(d.programData, ...PROGRAMS, START_MENU_LINK) : null;
  if (d.exists(mine)) return { result: 'present', line: `start menu: ${mine} is there` };
  if (everyone && d.exists(everyone)) return { result: 'present', line: `start menu: ${everyone} is there (all users)` };
  const spec: ShortcutSpec = { target: d.execPath, cwd: dir, description: SHORTCUT_DESCRIPTION, icon: d.execPath, iconIndex: 0, appUserModelId: APP_USER_MODEL_ID };
  let ok = false;
  let why = '';
  try {
    ok = d.writeShortcut(mine, spec);
  } catch (e) {
    why = `: ${e instanceof Error ? e.message : String(e)}`;
  }
  return ok
    ? { result: 'created', line: `start menu: ${START_MENU_LINK} was missing; created ${mine} -> ${d.execPath} (AppUserModelID ${APP_USER_MODEL_ID})` }
    : { result: 'failed', line: `start menu: ${START_MENU_LINK} is missing and could not be created at ${mine}${why}` };
}
