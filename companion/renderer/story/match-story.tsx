/**
 * A17 step 9 (2026-11-27): the Match tab in every state of a lobby, never shipped (the build's only input is
 * index.html). It renders the real Match view with a stub `window.castcade` whose status is the fixture `?state=`
 * names (fixtures.ts), so each state can be looked at in a browser without Electron:
 *
 *   npx vite --config renderer/story/vite.config.mjs      (from companion/; serves 127.0.0.1 only)
 *   http://127.0.0.1:5199/story/match.html?state=four-starter
 *   http://127.0.0.1:5199/story/match.html                (no state: the list of all of them)
 *
 * `&press=Leave lobby` presses the first button with those words once the tab is drawn (several, in order, with `|`
 * between them), for the states a click opens: a confirm row, the table picker. `select:Congo` in that list picks the
 * option of the picker's list whose words begin so. `&tables=0`: this PC knows no table. `&pick=wait`: a pick gets no
 * answer (the lobby's PC is asked); `&pick=refused`: it is refused with the lobby PC's sentence. shoot.mjs takes a screenshot of each.
 */
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Match } from '../src/views/Match.js';
import { useCastcade } from '../src/useCastcade.js';
import '../src/app.css';
import { installBridge, MATCH } from './base.js';
import { FIXTURES, PICK_REFUSED, TABLE, status } from './fixtures.js';
import { MatchWindow, StoryIndex } from './shell.js';

const q = new URLSearchParams(location.search);
const which = q.get('state');
const fixture = which !== null ? FIXTURES[which] : undefined;
const presses = (q.get('press') ?? '').split('|').filter((p) => p !== '');

if (fixture) {
  const { match, oneStep } = status(fixture, MATCH);
  installBridge(match, oneStep, { tables: q.get('tables') !== '0', pick: q.get('pick') === 'refused' ? PICK_REFUSED : q.get('pick'), tableOpen: fixture.open !== undefined ? fixture.open : fixture.here && fixture.here.length > 0 && !(fixture.flags?.[fixture.me] ?? []).includes('no_table') ? TABLE : null });
} else installBridge(MATCH, { link: null, message: null, copied: false, pending: null, launch: { state: 'idle', table: null, detail: null }, tableToStart: null, change: null, notice: null, attention: 0 });

/** Presses the named buttons one after another, each once the one before has been drawn. */
function usePresses(): void {
  useEffect(() => {
    let i = 0;
    let tries = 0;
    const timer = setInterval(() => {
      const want = presses[i];
      if (want === undefined || tries > 40) {
        clearInterval(timer);
        // What shoot.mjs reads to take the picture as tall as the page.
        // The picture ends under the heading of the settings (they are the same in every state), unless `&all=1`.
        setTimeout(() => {
          const rest = q.get('all') ? null : document.querySelector('#match-settings-title, h3.rest');
          document.documentElement.dataset.tall = String(rest ? Math.ceil(rest.getBoundingClientRect().bottom + window.scrollY + 12) : document.documentElement.scrollHeight);
        }, 200);
        return;
      }
      if (want.startsWith('select:')) {
        // A choice in the picker's list: the option whose words begin so, chosen as a person's click would.
        const option = [...document.querySelectorAll('select[size] option')].find((x) => x.textContent?.startsWith(want.slice(7))) as HTMLOptionElement | undefined;
        const list = option?.parentElement as HTMLSelectElement | null | undefined;
        if (option && list) {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(list, option.value);
          list.dispatchEvent(new Event('change', { bubbles: true }));
          i += 1;
          tries = 0;
        } else tries += 1;
        return;
      }
      const b = ([...document.querySelectorAll('button, summary')] as HTMLButtonElement[]).find((x) => x.textContent?.trim() === want && !x.disabled);
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
  const state = useCastcade();
  usePresses();
  return (
    <MatchWindow>
      <Match state={state} />
    </MatchWindow>
  );
}

function Index() {
  return (
    <StoryIndex title="Match tab stories" items={Object.entries(FIXTURES).map(([name, f]) => ({ name, says: `${f.says} (from ${f.me}'s PC)` }))} />
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>{fixture ? <Story /> : <Index />}</StrictMode>,
  );
