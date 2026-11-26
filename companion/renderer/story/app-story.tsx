/**
 * The Arcaid look (2026-11-25): the whole app as it opens, never shipped (the build's only input is index.html). It
 * renders the real `App` (the window's header, its tab bar, the update banner and the tab) with a stub
 * `window.castcade` that answers from the fixture `?state=` names (app-fixtures.ts), then presses the fixture's tab, so
 * every tab can be looked at in a browser without Electron:
 *
 *   npx vite --config renderer/story/vite.config.mjs      (from companion/; serves 127.0.0.1 only)
 *   http://127.0.0.1:5199/story/app.html?state=status-live
 *   http://127.0.0.1:5199/story/app.html                  (no state: the list)
 *
 * `&press=Preview what will change` presses the first button (or `summary`) with those words once the tab is drawn
 * (several, in order, with `|` between them), as match-story.tsx does. A fixture with `focus` shows only the card whose
 * heading begins with those words (the 3D watch card of the Match tab). shoot.mjs takes a picture of each (app-shots.ts).
 */
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App.js';
import '../src/app.css';
import { api, MATCH, ok } from './base.js';
import { StoryIndex } from './shell.js';
import { FIXTURES, OVERLAY_URL, PLAN, APPLIED, REMOVED, PREVIEW_OFF, SETTINGS, STATUS_LIVE, STATUS_UNPAIRED, STREAM_IDLE, STREAM_SETTINGS, TABLES_DEFAULTS, VERSIONS, WATCH } from './app-fixtures.js';

const q = new URLSearchParams(location.search);
const which = q.get('state');
const fixture = which !== null ? FIXTURES[which] : undefined;
const presses = (q.get('press') ?? '').split('|').filter((p) => p !== '');

const never = (): Promise<never> => new Promise(() => undefined);
const ONE_STEP = { link: null, message: null, copied: false, pending: null, launch: { state: 'idle', table: null, detail: null }, tableToStart: null, change: null, notice: null, attention: 0 };
const NO_UPDATE = { ready: null, waiting: null, installing: false, lastAttempt: null };
const TABLES = ['Monster Bash (Williams 1998)', 'Congo (Williams 1995)', 'Attack from Mars (Bally 1995)', 'Medieval Madness (Williams 1997)'].map((name, i) => ({
  path: `story:${i}`,
  name,
  rom: ['mb_106b', 'congo_21', 'afm_113b', 'mm_109c'][i],
  lastPlayedAt: null,
  imported: true,
}));

if (fixture) {
  /** A press's answer: the fixture's (an Error is a refusal), else the given one. */
  const answer =
    (name: string, otherwise: unknown) =>
    (): Promise<unknown> => {
      const a = fixture.answers?.[name];
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? otherwise);
    };
  const settings = fixture.settings ?? SETTINGS;
  const streamSettings = fixture.streamSettings ?? STREAM_SETTINGS;
  const bridge = api({
    appVersion: '0.2.51',
    protocolVersion: 7,
    platform: 'win32',
    edition: fixture.edition ?? 'full',
    witness: api({
      status: fixture.status === null ? never : ok(fixture.status),
      pair: answer('pair', STATUS_LIVE),
      unpair: answer('unpair', STATUS_UNPAIRED),
      setPaused: ok(fixture.status),
      startAttempts: ok(fixture.status),
      confirmTable: ok(fixture.status),
      sendLogs: answer('sendLogs', { ok: true, text: '' }),
    }),
    settings: api({ get: ok(settings), set: (patch: object) => Promise.resolve({ ...settings, ...patch }) }),
    stream: api({
      status: ok(fixture.stream ?? STREAM_IDLE),
      settings: streamSettings === 'never' ? never : ok(streamSettings),
      setSettings: ok(streamSettings),
      setKey: ok(streamSettings),
      preview: api({ status: ok(fixture.preview ?? PREVIEW_OFF) }),
    }),
    app: api({
      versions: ok(VERSIONS),
      logPath: ok(String.raw`C:\Users\Owner\AppData\Roaming\Castcade\logs\companion.log`),
      loginItem: api({ get: ok({ supported: true, openAtLogin: true }) }),
      clipboardText: ok('K7Q2MX'),
      overlayUrl: fixture.overlay === 'never' ? never : ok(fixture.overlay === undefined ? OVERLAY_URL : fixture.overlay),
      pickFolder: ok(null),
      openExternal: ok(true),
      update: api({ status: ok(fixture.update ?? NO_UPDATE) }),
    }),
    tables: api({
      defaults: ok(TABLES_DEFAULTS),
      plan: answer('plan', PLAN),
      apply: answer('apply', APPLIED),
      removeAll: answer('removeAll', REMOVED),
      patchNow: ok({ ok: true, text: 'patched; reopen the table so every game posts live' }),
    }),
    match: api({ status: ok(MATCH), benchClips: ok([]) }, MATCH),
    launch: api({ status: ok(ONE_STEP), tables: ok(TABLES), browse: ok([]), pick: ok(null) }),
    watch: api({ status: ok(fixture.watch ?? WATCH.idle), pickTable: ok(null) }),
  });
  Object.defineProperty(window, 'castcade', { value: bridge });
}

/** The card whose heading begins with `words`: every other thing in its tab is hidden (the header and tab bar stay). */
function focusOn(words: string): void {
  const heading = [...document.querySelectorAll('strong, h2, h3, .aw-label')].find((h) => h.textContent?.trim().startsWith(words));
  let node: Element | null = heading?.closest('.card, .aw-panel, .cc-panel') ?? null;
  while (node && node.parentElement && !node.parentElement.matches('main, .view')) {
    for (const sib of node.parentElement.children) if (sib !== node) (sib as HTMLElement).style.display = 'none';
    node = node.parentElement;
  }
  if (node?.parentElement) for (const sib of node.parentElement.children) if (sib !== node) (sib as HTMLElement).style.display = 'none';
}

/** Presses the fixture's tab, then the named buttons one after another, each once the one before has been drawn. */
function usePresses(): void {
  useEffect(() => {
    const want = [`tab:${fixture?.tab ?? 'Pairing'}`, ...presses];
    let i = 0;
    let tries = 0;
    const timer = setInterval(() => {
      const next = want[i];
      if (next === undefined || tries > 60) {
        clearInterval(timer);
        setTimeout(() => {
          if (fixture?.focus) focusOn(fixture.focus);
          // What shoot.mjs reads to take the picture as tall as the page, once the fonts are in.
          void document.fonts.ready.then(() =>
            requestAnimationFrame(() => {
              document.documentElement.dataset.tall = String(document.documentElement.scrollHeight);
            }),
          );
        }, 250);
        return;
      }
      const tab = next.startsWith('tab:');
      const words = tab ? next.slice(4) : next;
      const pool = tab ? document.querySelectorAll('nav button') : document.querySelectorAll('button, summary');
      const b = ([...pool] as HTMLButtonElement[]).find((x) => x.textContent?.trim() === words && !x.disabled);
      if (b) {
        b.click();
        i += 1;
        tries = 0;
      } else tries += 1;
    }, 50);
    return () => clearInterval(timer);
  }, []);
}

function Story() {
  usePresses();
  return <App />;
}

function Index() {
  return (
    <StoryIndex title="App stories" items={Object.entries(FIXTURES).map(([name, f]) => ({ name, says: f.says }))} />
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode>{fixture ? <Story /> : <Index />}</StrictMode>);
