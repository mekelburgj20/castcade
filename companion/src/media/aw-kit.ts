/**
 * The Arcaid look (2026-11-25): the Arcaid Witness kit for the pages the main process writes for the headset (the
 * match panel, `panel-page.ts`; the scoreboard card, `scoreboard-page.ts`). Those pages are files written to the user
 * data folder and opened there, so they cannot reach the renderer's bundled fonts: the kit's two style sheets
 * (renderer/src/aw-theme/, verbatim, never edited) are put in the page whole, with each font's URL replaced by the
 * font itself (a woff2 `data:` URL). Nothing is fetched, so the pages draw the kit offline and in a headset.
 *
 * The files ship with the app (electron-builder `files`: `renderer/src/aw-theme/**`) and are read once. A build
 * that lacks them still draws its pages, with the kit's colour tokens below and the system's face; it says so once in
 * the log (`setKitLog`), and `--smoke` prints `kit fallback` and fails (main/index.ts), so the release's smoke of the
 * packaged app stops a build without the kit before it ships.
 */
import { readFileSync } from 'node:fs';

const KIT = new URL('../../renderer/src/aw-theme/', import.meta.url);
const SHEETS = ['aw-theme.css', 'aw-theme-ext.css'] as const;

/** The kit's colour and face tokens (aw-theme.css, aw-theme-ext.css): only for a build whose kit files cannot be read. */
export const TOKENS_ONLY = `:root { --aw-ice: #EAF6FF; --aw-cyan: #4FD6FF; --aw-pink: #FF3D7F; --aw-chrome: #B9C3D3; --aw-gunmetal: #6B7488; --aw-canvas: #07090F;
  --aw-panel: rgba(9, 13, 26, 0.80); --aw-panel-border: rgba(79, 214, 255, 0.28); --aw-divider: rgba(107, 116, 136, 0.30); --aw-red: #FF4B4B;
  --aw-font-brand: "Audiowide", sans-serif; --aw-font-display: "Orbitron", sans-serif; --aw-font-ui: "Chakra Petch", sans-serif; }`;

/** How the kit was read: whole (`ok`), or the file that could not be read and why (the pages then use `TOKENS_ONLY`). */
export interface KitLoad {
  ok: boolean;
  file: string | null;
  error: string | null;
}

/** Reads the kit in `dir` (a folder URL ending in `/`): its style sheets with the fonts inside, or the fallback and why. */
export function readKit(dir: URL = KIT): { css: string; load: KitLoad } {
  const read: { file: string } = { file: SHEETS[0] };
  try {
    const sheets: string[] = [];
    for (const f of SHEETS) {
      read.file = f;
      sheets.push(readFileSync(new URL(f, dir), 'utf8'));
    }
    const inlined = sheets.join('\n').replace(/url\("fonts\/([\w.-]+\.woff2)"\)/g, (_all, font: string) => {
      read.file = `fonts/${font}`;
      return `url("data:font/woff2;base64,${readFileSync(new URL(read.file, dir)).toString('base64')}")`;
    });
    return { css: inlined, load: { ok: true, file: null, error: null } };
  } catch (err) {
    return { css: TOKENS_ONLY, load: { ok: false, file: new URL(read.file, dir).href, error: err instanceof Error ? err.message : String(err) } };
  }
}

/** The log line of a kit that could not be read, or null for a kit read whole. */
export function kitFallbackLine(load: KitLoad): string | null {
  return load.ok ? null : `headset pages: the Arcaid kit could not be read (${load.file ?? '?'}: ${load.error ?? 'unknown'}); they draw with its colours in the system's face`;
}

/** What `--smoke` prints of the kit, and whether the smoke passes on it. */
export function kitSmokeLine(load: KitLoad): { ok: boolean; line: string } {
  return load.ok ? { ok: true, line: 'kit ok' } : { ok: false, line: `kit fallback ${load.file ?? '?'}: ${load.error ?? 'unknown'}` };
}

let cached: { css: string; load: KitLoad } | null = null;
let warn: (line: string) => void = () => undefined;
let kitDir: URL = KIT;

/** Tests only: read the kit from `dir` from now on (the next read is a first read again). */
export function useKitDir(dir: URL): void {
  kitDir = dir;
  cached = null;
}

/** Where a kit that could not be read is said (main/index.ts: the app's log); said once, at the first read. */
export function setKitLog(fn: (line: string) => void): void {
  warn = fn;
}

function kit(): { css: string; load: KitLoad } {
  if (cached === null) {
    cached = readKit(kitDir);
    const line = kitFallbackLine(cached.load);
    if (line !== null) warn(line);
  }
  return cached;
}

/** The kit's style sheets, fonts inside, for a page's `<style>`. */
export function kitCss(): string {
  return kit().css;
}

/** How the kit was read (read once, then remembered). */
export function kitLoad(): KitLoad {
  return kit().load;
}
