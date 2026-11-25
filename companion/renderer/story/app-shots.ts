/**
 * The Arcaid look (2026-11-25): the pictures of the app's tabs other than the lobby's (app-story.tsx), for shoot.mjs
 * beside the Match tab's of shots.ts. Each is the window's width (420) and as tall as the page; the ones marked
 * `window` are also taken at the app's own window sizes (420 x 640 as it opens, 380 x 520 at its smallest), and the
 * `-wide` ones at 1200 wide, a window made larger on a desktop.
 */
import { FIXTURES } from './app-fixtures.js';
import type { Shot } from './shots.js';

/** The presses that open a state, by fixture (the tab itself is pressed by the story page). */
const PRESS: Record<string, string[]> = {
  'pairing-refused': ['Paste', 'Pair'],
  'pairing-unpaired-notice': ['Unpair'],
  'stream-custom': ['Advanced'],
  'settings-saved': ['Local', 'Save URL'],
  'settings-plan': ['Preview what will change'],
  'settings-applied': ['Patch my tables'],
  'settings-removed': ['Remove all Castcade patches'],
  'settings-logs': ['Send logs to Arcaid support'],
  'settings-logs-refused': ['Send logs to Arcaid support'],
};
const WINDOW = new Set(['pairing-unpaired', 'status-live', 'stream-idle', 'settings', 'settings-saved', 'update-ready', 'witness-status']);
const WIDE = new Set(['status-live', 'settings', 'stream-live']);

const page = (name: string): string => `app.html?state=${name}${PRESS[name] ? `&press=${encodeURIComponent(PRESS[name].join('|'))}` : ''}`;

export const SHOTS: Shot[] = Object.entries(FIXTURES).flatMap(([name, f]) => [
  { name: `app-${name}`, page: page(name), says: f.says, window: WINDOW.has(name) },
  ...(WIDE.has(name) ? [{ name: `app-${name}-wide`, page: page(name), says: `${f.says} (the window made 1200 wide)`, width: 1200, height: 800 }] : []),
]);
