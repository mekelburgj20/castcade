/**
 * The Arcaid look (2026-11-25): the Arcaid Witness kit for the pages the main process writes for the headset (the
 * match panel, `panel-page.ts`; the scoreboard card, `scoreboard-page.ts`). Those pages are files written to the user
 * data folder and opened there, so they cannot reach the renderer's bundled fonts: the kit's two style sheets
 * (renderer/src/aw-theme/, verbatim, never edited) are put in the page whole, with each font's URL replaced by the
 * font itself (a woff2 `data:` URL). Nothing is fetched, so the pages draw the kit offline and in a headset.
 *
 * The files ship with the app (electron-builder `files`: `renderer/src/aw-theme/**`) and are read once. A build
 * that lacks them still draws its pages: with the kit's colour tokens below and the system's face.
 */
import { readFileSync } from 'node:fs';

const KIT = new URL('../../renderer/src/aw-theme/', import.meta.url);

/** The kit's colour and face tokens (aw-theme.css, aw-theme-ext.css): only for a build whose kit files cannot be read. */
const TOKENS_ONLY = `:root { --aw-ice: #EAF6FF; --aw-cyan: #4FD6FF; --aw-pink: #FF3D7F; --aw-chrome: #B9C3D3; --aw-gunmetal: #6B7488; --aw-canvas: #07090F;
  --aw-panel: rgba(9, 13, 26, 0.80); --aw-panel-border: rgba(79, 214, 255, 0.28); --aw-divider: rgba(107, 116, 136, 0.30); --aw-red: #FF4B4B;
  --aw-font-brand: "Audiowide", sans-serif; --aw-font-display: "Orbitron", sans-serif; --aw-font-ui: "Chakra Petch", sans-serif; }`;

let cached: string | null = null;

/** The kit's style sheets, fonts inside, for a page's `<style>`. */
export function kitCss(): string {
  if (cached !== null) return cached;
  try {
    const css = ['aw-theme.css', 'aw-theme-ext.css'].map((f) => readFileSync(new URL(f, KIT), 'utf8')).join('\n');
    cached = css.replace(/url\("fonts\/([\w.-]+\.woff2)"\)/g, (_all, file: string) => `url("data:font/woff2;base64,${readFileSync(new URL(`fonts/${file}`, KIT)).toString('base64')}")`);
  } catch {
    cached = TOKENS_ONLY;
  }
  return cached;
}
