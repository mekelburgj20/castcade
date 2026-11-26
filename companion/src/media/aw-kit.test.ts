/**
 * The Arcaid look (2026-11-25): the headset's pages carry the Witness kit inside themselves (aw-kit.ts), fonts and
 * all, because they are files opened from the user data folder with nothing beside them. A build that cannot read the
 * kit still draws, says so once in the log, and fails its `--smoke` (the release's smoke of the packaged app).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { kitCss, kitFallbackLine, kitLoad, kitSmokeLine, readKit, setKitLog, TOKENS_ONLY, useKitDir } from './aw-kit.js';
import { panelPageHtml } from './panel-page.js';
import { scoreboardPageHtml } from './scoreboard-page.js';

const KIT = new URL('../../renderer/src/aw-theme/', import.meta.url);
const NOWHERE = new URL('./no-such-kit-folder/', import.meta.url);

afterEach(() => {
  setKitLog(() => undefined);
  useKitDir(KIT);
});

describe('the kit inside the headset pages', () => {
  it('is the kit (its tokens and its three faces), every font a woff2 inside it and no URL left to resolve', () => {
    const css = kitCss();
    for (const token of ['--aw-ice:', '--aw-cyan:', '--aw-pink:', '--aw-red:', '--aw-canvas:', '--aw-font-display:']) expect(css).toContain(token);
    for (const face of ['"Audiowide"', '"Chakra Petch"', '"Orbitron"']) expect(css).toContain(`font-family: ${face}`);
    expect(css.match(/url\("data:font\/woff2;base64,/g)?.length).toBe(7);
    expect(css).not.toContain('url("fonts/');
  });

  it('is in the panel (both of its sizes) and in the scoreboard card, before the page`s own style, which draws with its tokens', () => {
    for (const html of [panelPageHtml({ vr: true }), panelPageHtml({ vr: false }), scoreboardPageHtml()]) {
      const kit = html.indexOf(kitCss());
      expect(kit).toBeGreaterThan(0);
      expect(html.indexOf('var(--aw-canvas)')).toBeGreaterThan(kit);
      // No colour of its own: the pages' style names the kit's tokens, not a value.
      const own = html.slice(kit + kitCss().length, html.indexOf('</style></head>'));
      expect(own).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });
});

describe('a build that cannot read the kit (the review of PR 144, finding 1)', () => {
  it('reads the kit of this build whole: the smoke prints `kit ok` and passes, and nothing is logged', () => {
    const r = readKit(KIT);
    expect(r.load).toEqual({ ok: true, file: null, error: null });
    expect(kitSmokeLine(r.load)).toEqual({ ok: true, line: 'kit ok' });
    expect(kitFallbackLine(r.load)).toBeNull();
  });

  it('falls back to the tokens without it, names the file and the error, and the smoke fails on it', () => {
    const r = readKit(NOWHERE);
    expect(r.css).toBe(TOKENS_ONLY);
    expect(r.load.ok).toBe(false);
    expect(r.load.file).toBe(new URL('aw-theme.css', NOWHERE).href);
    expect(r.load.error).toMatch(/ENOENT/);
    const smoke = kitSmokeLine(r.load);
    expect(smoke.ok).toBe(false);
    expect(smoke.line).toMatch(/^kit fallback .*aw-theme\.css: .*ENOENT/);
    expect(kitFallbackLine(r.load)).toMatch(/^headset pages: the Arcaid kit could not be read \(.*aw-theme\.css: .*ENOENT/);
  });

  it('says so once in the log, at the first page, and the pages still draw (with the tokens)', () => {
    const said: string[] = [];
    setKitLog((line) => said.push(line));
    useKitDir(NOWHERE);
    expect(kitLoad().ok).toBe(false);
    expect(panelPageHtml({ vr: true })).toContain(TOKENS_ONLY);
    expect(scoreboardPageHtml()).toContain(TOKENS_ONLY);
    expect(kitCss()).toBe(TOKENS_ONLY);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/the Arcaid kit could not be read/);
  });
});

describe('the headset header on this player`s own ball (the review of PR 144, finding 8)', () => {
  /** WCAG's relative luminance of an sRGB colour (0 to 255 per channel). */
  const lum = (rgb: number[]): number => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hex = (css: string, token: string): number[] => {
    const m = new RegExp(`${token}:\\s*#([0-9A-Fa-f]{6})`).exec(css);
    if (!m?.[1]) throw new Error(`no ${token}`);
    const v = m[1];
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  };

  it('is the kit`s pink pulled toward ice to 7:1 or better on the canvas, with no glow behind it', () => {
    const html = panelPageHtml({ vr: true });
    const m = /--mine-ink: color-mix\(in srgb, var\(--aw-pink\) (\d+)%, var\(--aw-ice\)\)/.exec(html);
    expect(m).not.toBeNull();
    const share = Number(m?.[1]) / 100;
    const css = kitCss();
    const pink = hex(css, '--aw-pink');
    const ice = hex(css, '--aw-ice');
    // color-mix in srgb mixes the encoded values.
    const ink = pink.map((v, i) => v * share + (ice[i] ?? 0) * (1 - share));
    const ratio = (lum(ink) + 0.05) / (lum(hex(css, '--aw-canvas')) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(7);
    expect(html).toContain('#head.mine { color: var(--mine-ink); }');
  });

  it('keeps the scoreboard`s names at 700, as before', () => {
    const html = scoreboardPageHtml();
    expect(html).toContain('font-family: var(--aw-font-ui); font-weight: 700;');
    expect(html).toMatch(/\.row \.name \{ overflow: hidden;/);
    expect(html).not.toMatch(/\.row \.name \{[^}]*font-weight/);
  });
});
