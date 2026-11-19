/**
 * E10 (2026-11-19): the edition of this build. Two installers come from the same tag and the same code:
 * `Castcade-Setup-<version>.exe` (the full app) and `Castcade-Witness-Setup-<version>.exe` (the Witness edition, for
 * cabinets: pairing, table import and patching, live score capture, posting to ArcAid, updates, the log pull; none of
 * the experimental features and none of their helper executables).
 *
 * The edition is baked at package time: `electron-builder.witness.yml` sets `extraMetadata.castcadeEdition: witness`,
 * so the packaged `package.json` carries it. A development run may set `CASTCADE_EDITION=witness|full` instead; a
 * packaged build never reads the environment (a stray variable cannot turn an installed full app into the Witness
 * edition, or the other way round). Nothing said, or a value that is neither: `full` (an unknown value is reported in
 * `ignored`, for the log). Pure: the caller reads the file and hands over its text.
 */

export type Edition = 'full' | 'witness';

export const DEFAULT_EDITION: Edition = 'full';
/** The key `electron-builder.witness.yml` puts into the packaged package.json (`extraMetadata`). */
export const EDITION_METADATA_KEY = 'castcadeEdition';
/** The development override. */
export const EDITION_ENV = 'CASTCADE_EDITION';

export interface EditionPick {
  edition: Edition;
  /** Where it came from: the packaged package.json, the environment (development runs only), or the default. */
  source: 'package' | 'env' | 'default';
  /** A value that was read and is not an edition (the edition is then `full`), for the log; else null. */
  ignored: string | null;
}

const asEdition = (v: string): Edition | null => {
  const t = v.trim().toLowerCase();
  return t === 'full' || t === 'witness' ? t : null;
};

/** The edition of this run: the packaged package.json's `castcadeEdition`, else (development only) the environment, else full. */
export function resolveEdition(i: { packageJson: string | null; env: Readonly<Record<string, string | undefined>>; packaged: boolean }): EditionPick {
  let meta: unknown;
  if (i.packageJson !== null) {
    try {
      const parsed: unknown = JSON.parse(i.packageJson);
      meta = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[EDITION_METADATA_KEY] : undefined;
    } catch {
      meta = undefined;
    }
  }
  if (meta !== undefined && meta !== null) {
    const e = typeof meta === 'string' ? asEdition(meta) : null;
    return e ? { edition: e, source: 'package', ignored: null } : { edition: DEFAULT_EDITION, source: 'package', ignored: String(meta) };
  }
  const env = i.packaged ? undefined : i.env[EDITION_ENV];
  if (env !== undefined && env.trim() !== '') {
    const e = asEdition(env);
    return e ? { edition: e, source: 'env', ignored: null } : { edition: DEFAULT_EDITION, source: 'env', ignored: env };
  }
  return { edition: DEFAULT_EDITION, source: 'default', ignored: null };
}

/** What an edition runs, beyond the Witness part every edition runs (logger, settings, journal pipe, witness, tables, sidecar watch, tray, updater, log bundle, login item). */
export interface Features {
  /** D1.2 / D1.3: solo streaming and recording (ffmpeg). */
  stream: boolean;
  /**
   * Matches and all they bring: the match host, media / RTC host, the VR overlay helper, the OpenXR layer (and its
   * registration), the table-sound helper, the video helper, the stream3d host, one step to a match, the `castcade://`
   * link protocol, the in-game global shortcuts.
   */
  match: boolean;
  /** I11.4.1: the standalone 3D watch session. */
  watch3d: boolean;
  /** D1.1: the OBS overlay page on 127.0.0.1. */
  overlayServer: boolean;
}

export function featuresFor(edition: Edition): Features {
  const on = edition === 'full';
  return { stream: on, match: on, watch3d: on, overlayServer: on };
}

/** The start of the installer's file name (`artifactName` in each electron-builder config). */
export function installerPrefix(edition: Edition): string {
  return edition === 'witness' ? 'Castcade-Witness-Setup-' : 'Castcade-Setup-';
}

/** The last path segment of a file name or URL (electron-updater's `files[].url` may be a full URL). */
const baseName = (name: string): string => {
  const noQuery = name.split(/[?#]/, 1)[0] ?? '';
  const parts = noQuery.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
};

/**
 * The update guard (electron-updater's `isUpdateSupported`, before any download): whether an update whose files are
 * `fileNames` (`updateInfo.files[].url` and `path`) is this edition's. The installer is the `.exe` among them (every
 * name when none ends in `.exe`). A Witness edition accepts an update only when its installer's name starts with
 * `Castcade-Witness-Setup-`; a full edition refuses one that does. The GitHub provider falls back to `latest.yml` when
 * a release has no `witness.yml`: this is what keeps that from updating a Witness install into the full app.
 */
export function updateMatchesEdition(edition: Edition, fileNames: readonly string[]): boolean {
  const names = fileNames.map(baseName).filter((n) => n !== '');
  const exes = names.filter((n) => n.toLowerCase().endsWith('.exe'));
  const installers = exes.length > 0 ? exes : names;
  const witnessPrefix = installerPrefix('witness').toLowerCase();
  const isWitness = (n: string): boolean => n.toLowerCase().startsWith(witnessPrefix);
  if (edition === 'witness') return installers.length > 0 && installers.every(isWitness);
  return !installers.some(isWitness);
}
