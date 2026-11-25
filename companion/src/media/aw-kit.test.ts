/**
 * The Arcaid look (2026-11-25): the headset's pages carry the Witness kit inside themselves (aw-kit.ts), fonts and
 * all, because they are files opened from the user data folder with nothing beside them.
 */
import { describe, expect, it } from 'vitest';
import { kitCss } from './aw-kit.js';
import { panelPageHtml } from './panel-page.js';
import { scoreboardPageHtml } from './scoreboard-page.js';

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
