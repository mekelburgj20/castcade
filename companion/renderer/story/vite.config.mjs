// I11.4.1 (2026-11-16): the dev server for the story pages in this folder (watch.html: the 3D watch card in each of its
// states). Unlike companion/vite.config.ts it starts no Electron, and it listens on 127.0.0.1 only. Never part of a
// build: `vite build` reads companion/vite.config.ts, whose only input is renderer/index.html.
//
//   cd companion && npx vite --config renderer/story/vite.config.mjs
//   http://127.0.0.1:5199/story/watch.html?state=idle   (the states: watch-story.tsx, STATES)
//
// A17 step 9 (2026-11-27): the lobby's screens, each from a fixture of fixtures.ts (`?state=`):
//   /story/match.html?state=four-starter            the Match tab (match-story.tsx; no state: the list)
//   /story/panel.html?state=game-up&vr=1            the panel page as the headset draws it (960 x 640); vr=0: the desktop window (480 x 720); &menu=1: with the in-game menu open (&at=<line id>: that line chosen; &asked=1: its question asked)
//   /story/scoreboard.html?state=game-up            the headset's scoreboard card (512 x 384)
//   /story/menu.html?states=four-starter,game-up    the in-game menu as text: every line, what it says before it acts, why it is off
// The last three are the real pages (media/panel-page.ts, media/scoreboard-page.ts) and the real menu
// (match/match-menu.ts), fed the fixture's state through a stand-in for Electron's `ipcRenderer`.
// `node renderer/story/shoot.mjs <folder>` takes a picture of each (shots.ts).
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => `/@fs/${resolve(here, '../../src', p).replace(/\\/g, '/')}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The stand-in for `require('electron')` in a page of the main process's own making, and what it is handed once it has loaded. */
const stub = (deliveries, extraCss = '') => `<script>
(function () {
  var handlers = {};
  var ipc = {
    on: function (ch, cb) { (handlers[ch] = handlers[ch] || []).push(cb); return ipc; },
    once: function () { return ipc; },
    send: function () {},
    invoke: function () { return Promise.resolve(null); },
    removeListener: function () { return ipc; },
    removeAllListeners: function () { return ipc; },
  };
  window.require = function () { return { ipcRenderer: ipc }; };
  window.addEventListener('load', function () {
    setTimeout(function () {
      ${JSON.stringify(deliveries)}.forEach(function (d) { (handlers[d[0]] || []).forEach(function (cb) { cb({}, d[1]); }); });
      setTimeout(function () { document.documentElement.dataset.tall = String(window.innerHeight); }, 150);
    }, 100);
  });
})();
</script>${extraCss ? `<style>${extraCss}</style>` : ''}`;

function lobbyPages() {
  return {
    name: 'castcade-story-lobby-pages',
    configureServer(server) {
      const load = async () => {
        const [fx, base, panelPage, board, menu] = await Promise.all([
          server.ssrLoadModule('/story/fixtures.ts'),
          server.ssrLoadModule('/story/base.ts'),
          server.ssrLoadModule(src('media/panel-page.ts')),
          server.ssrLoadModule(src('media/scoreboard-page.ts')),
          server.ssrLoadModule(src('match/match-menu.ts')),
        ]);
        return { fx, base, panelPage, board, menu };
      };
      const page = (path, make) =>
        server.middlewares.use(path, (req, res, next) => {
          const q = new URL(req.url ?? '', 'http://127.0.0.1').searchParams;
          load()
            .then((m) => make(m, q))
            .then((html) => {
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.end(html);
            })
            .catch(next);
        });
      const statusOf = (m, name) => {
        const f = m.fx.FIXTURES[name];
        if (!f) throw new Error(`no fixture named ${name}`);
        return m.fx.status(f, m.base.MATCH).match;
      };
      // The menu's facts as the shell makes them (match-host.ts `menuFacts`): the lobby's part through the same
      // function (match-menu.ts `menuLobbyOf`); the volumes are the defaults, and the scoreboard line is there for a
      // headset during a game.
      const menuOf = (m, st) => {
        if (!st.lobby) return { facts: null, items: [] };
        const playing = st.phase === 'playing' || st.phase === 'paused';
        const facts = {
          role: st.role,
          phase: st.phase,
          players: st.participants.length,
          startWarnings: st.startWarnings,
          seriesOver: st.series?.over ?? false,
          nextGameBlocker: null,
          voice: 150,
          theirTable: 100,
          myTable: 100,
          mic: 'open',
          scoreboardPlace: st.rig === 'vr_headset' && playing ? 'ready' : null,
          endBall: st.endBall,
          lobby: m.menu.menuLobbyOf(st.lobby, st.role === 'host'),
        };
        return { facts, items: m.menu.menuItems(facts) };
      };
      const HINT = 'Ctrl+Alt+M: next line · Ctrl+Alt+K, or Ctrl+Alt+M twice quickly: choose · the arrow keys work too';

      page('/story/panel.html', (m, q) => {
        const st = statusOf(m, q.get('state') ?? '');
        const deliveries = [[m.panelPage.PANEL_CHANNELS.state, st.panel]];
        if (q.get('menu')) {
          const { items } = menuOf(m, st);
          // `&at=<line id>`: that line is the chosen one (the first otherwise); `&asked=1`: its question is on screen.
          const at = items.find((it) => it.id === q.get('at')) ?? items[0];
          const asked = q.get('asked') && at && at.confirm !== null;
          deliveries.push([m.panelPage.PANEL_CHANNELS.menu, m.menu.menuView({ open: true, at: at?.id ?? null, confirming: asked ? at.id : null, note: asked ? at.confirm : null }, items, HINT)]);
        }
        return m.panelPage.panelPageHtml({ vr: q.get('vr') !== '0' }).replace('<head>', `<head>${stub(deliveries)}`);
      });
      // The card is drawn over the game in the headset: a grey stands in for the game here (the page itself is see-through).
      page('/story/scoreboard.html', (m, q) => {
        const st = statusOf(m, q.get('state') ?? '');
        return m.board.scoreboardPageHtml().replace('<head>', `<head>${stub([[m.board.SCOREBOARD_CHANNEL, st.panel]], 'html { background: #39424e !important; }')}`);
      });
      page('/story/menu.html', (m, q) => {
        const cols = (q.get('states') ?? '').split(',').filter(Boolean).map((name) => {
          const st = statusOf(m, name);
          const { items } = menuOf(m, st);
          const rows = items.map((it) => `<li class="${it.off !== null ? 'off' : ''}"><b>${esc(it.label)}</b>${it.value !== null ? ` <i>${esc(it.value)}</i>` : ''}<code>${esc(it.id)}</code>${it.off !== null ? `<p class="why">off: ${esc(it.off)}</p>` : ''}${it.confirm !== null ? `<p class="ask">asks first: ${esc(it.confirm)}</p>` : ''}</li>`);
          return `<section><h2>${esc(name)}</h2><p class="says">${esc(m.fx.FIXTURES[name].says)} (${esc(m.fx.FIXTURES[name].me)}'s PC)</p><ol>${rows.join('')}</ol></section>`;
        });
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Castcade story: the in-game menu as text</title><style>
          body { margin: 0; padding: 12px; background: #14161a; color: #e6e6e6; font: 14px system-ui, sans-serif; display: flex; gap: 12px; align-items: flex-start; }
          section { width: 400px; background: #1b1e25; border: 1px solid #262a31; border-radius: 8px; padding: 10px 12px; }
          h2 { margin: 0; font-size: 15px; } .says { color: #9aa0a6; margin: 4px 0 8px; font-size: 12px; }
          ol { margin: 0; padding-left: 22px; } li { margin: 5px 0; } li.off b { color: #9aa0a6; }
          i { color: #4cc3ff; font-style: normal; margin-left: 6px; } code { color: #6b7280; font-size: 11px; margin-left: 8px; }
          p { margin: 2px 0 0; font-size: 12px; } .why { color: #9aa0a6; } .ask { color: #ffb84d; }
        </style></head><body>${cols.join('')}<script>setTimeout(function () { document.documentElement.dataset.tall = String(document.documentElement.scrollHeight); }, 100);</script></body></html>`;
      });
    },
  };
}

export default defineConfig({
  root: resolve(here, '..'),
  plugins: [react(), lobbyPages()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true, open: false },
});
