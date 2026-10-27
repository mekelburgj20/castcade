/**
 * D1.1: the OBS overlay. A local web server on 127.0.0.1 that a streamer adds to OBS as a browser source: the page
 * (`/overlay`, transparent, no capture involved) shows the live score, ball, player and the Witness badge, and
 * follows them over server-sent events (`/events`); `/state.json` is the same state once. Nothing leaves the machine.
 *
 * The state is composed from the witness: its status (table, capture mode, pairing, the last post) and its live game
 * (`LiveGame`, from the hook's journal). Updates are coalesced (`coalesceMs`) and sent only when the state changed.
 * Requests whose Host is not this loopback address are refused, so a web page cannot reach the server through DNS
 * rebinding. No Electron import: the shell wires it (`main/index.ts`), the tests drive it with plain `http`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LiveGame, WitnessStatus } from '../witness/types.js';

/** The fixed port, so the URL a streamer pastes into OBS stays the same across restarts. */
export const DEFAULT_OVERLAY_PORT = 47390;

export interface OverlayBadge {
  /** `live`: every game posts as it ends; `basic`: only the last game, at close; `idle`: no table; `unpaired`. */
  kind: 'live' | 'basic' | 'idle' | 'unpaired';
  text: string;
}

/** What the page draws; also the `/state.json` and `/events` payload (`v` changes only with an incompatible shape). */
export interface OverlayState {
  v: 1;
  table: string | null;
  game: { inGame: boolean; scores: (number | null)[]; player: number | null; ball: number | null } | null;
  badge: OverlayBadge;
  /** The limited-attempts line for the game in progress, e.g. "Attempt 2 of 10". */
  attempt: string | null;
  /** The last score this machine posted, as the witness recorded it. */
  lastPost: { score: number | null; outcome: string; table: string } | null;
}

/** The overlay state from the witness's status and live game (pure). */
export function overlayStateFrom(status: WitnessStatus, game: LiveGame | null): OverlayState {
  const table = game?.table ?? status.currentTable ?? null;
  let badge: OverlayBadge;
  if (!status.paired) badge = { kind: 'unpaired', text: 'Castcade · not paired with ArcAid' };
  else if (!status.currentTable && !game) badge = { kind: 'idle', text: 'Arcaid Witness · waiting for a table' };
  else if (status.captureMode === 'live') badge = { kind: 'live', text: 'Arcaid Witness · live' };
  else badge = { kind: 'basic', text: 'Arcaid Witness · last game only' };
  const last = status.lastCapture;
  return {
    v: 1,
    table,
    game: game ? { inGame: game.inGame, scores: game.scores, player: game.player, ball: game.ball } : null,
    badge,
    attempt: status.attempt?.text ?? null,
    lastPost: last ? { score: last.score, outcome: last.outcome, table: last.table } : null,
  };
}

export interface OverlayServerOptions {
  /** The state to send right now (read on every publish and on every new client). */
  state: () => OverlayState;
  port?: number;
  /** Updates closer together than this are sent as one (scores change several times a second). */
  coalesceMs?: number;
  /** A comment line every this many ms keeps idle connections open through OBS. */
  keepAliveMs?: number;
  log?: (line: string) => void;
}

export interface OverlayServer {
  /** Listen on 127.0.0.1; resolves with the page URL. Rejects when the port is taken. */
  start(): Promise<string>;
  stop(): Promise<void>;
  /** The state changed (or may have): send it to every page, coalesced. */
  publish(): void;
  /** The page URL once listening, else null. */
  url(): string | null;
  /** Connected pages (for tests and the log). */
  clients(): number;
}

export function createOverlayServer(opts: OverlayServerOptions): OverlayServer {
  const port = opts.port ?? DEFAULT_OVERLAY_PORT;
  const coalesceMs = opts.coalesceMs ?? 100;
  const keepAliveMs = opts.keepAliveMs ?? 15_000;
  const log = opts.log ?? (() => {});
  const streams = new Set<ServerResponse>();
  let server: Server | null = null;
  let bound: number | null = null;
  let lastSent = '';
  let pending: NodeJS.Timeout | null = null;
  let keepAlive: NodeJS.Timeout | null = null;

  const hostAllowed = (host: string | undefined): boolean => host === `127.0.0.1:${bound}` || host === `localhost:${bound}`;

  const send = (res: ServerResponse, json: string) => res.write(`data: ${json}\n\n`);

  const flush = () => {
    pending = null;
    const json = JSON.stringify(opts.state());
    if (json === lastSent) return;
    lastSent = json;
    for (const res of streams) send(res, json);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }).end('method not allowed');
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' || path === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(req.method === 'HEAD' ? undefined : OVERLAY_HTML);
      return;
    }
    if (path === '/state.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(req.method === 'HEAD' ? undefined : JSON.stringify(opts.state()));
      return;
    }
    if (path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.write('retry: 2000\n\n');
      send(res, JSON.stringify(opts.state()));
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  };

  return {
    start() {
      if (server) return Promise.resolve(`http://127.0.0.1:${bound}/overlay`);
      return new Promise((resolve, reject) => {
        const s = createServer(handle);
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => {
          s.off('error', reject);
          s.on('error', (err) => log(`overlay: server error: ${err.message}`));
          server = s;
          bound = (s.address() as AddressInfo).port;
          lastSent = JSON.stringify(opts.state());
          keepAlive = setInterval(() => {
            for (const res of streams) res.write(': keep-alive\n\n');
          }, keepAliveMs);
          keepAlive.unref();
          const url = `http://127.0.0.1:${bound}/overlay`;
          log(`overlay: serving ${url}`);
          resolve(url);
        });
      });
    },

    async stop() {
      if (pending) clearTimeout(pending);
      pending = null;
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = null;
      for (const res of streams) res.end();
      streams.clear();
      const s = server;
      server = null;
      bound = null;
      if (s) await new Promise<void>((r) => s.close(() => r()));
    },

    publish() {
      if (!server || pending) return;
      pending = setTimeout(flush, coalesceMs);
    },

    url() {
      return bound === null ? null : `http://127.0.0.1:${bound}/overlay`;
    },

    clients() {
      return streams.size;
    },
  };
}

/**
 * The page OBS loads. Transparent, one block in the lower left; sized for a 1920x1080 canvas and scaled by OBS. Query
 * options: `?scale=1.5` (size), `?side=right` (anchor). It reconnects by itself (EventSource) when the companion restarts.
 */
export const OVERLAY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Castcade overlay</title>
<style>
  :root { --scale: 1; }
  html, body { margin: 0; background: transparent; overflow: hidden; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #fff; }
  .card { position: fixed; bottom: calc(32px * var(--scale)); left: calc(32px * var(--scale)); min-width: calc(360px * var(--scale));
    padding: calc(14px * var(--scale)) calc(20px * var(--scale)); border-radius: calc(10px * var(--scale));
    background: rgba(10, 12, 16, 0.72); box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35); }
  body.right .card { left: auto; right: calc(32px * var(--scale)); }
  .table { font-size: calc(15px * var(--scale)); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: calc(640px * var(--scale)); }
  .score { font-size: calc(48px * var(--scale)); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; letter-spacing: 0.01em; }
  .meta { font-size: calc(17px * var(--scale)); opacity: 0.9; font-variant-numeric: tabular-nums; }
  .others { font-size: calc(17px * var(--scale)); opacity: 0.85; font-variant-numeric: tabular-nums; margin-top: calc(4px * var(--scale)); }
  .others span { margin-right: calc(14px * var(--scale)); }
  .others .up { font-weight: 700; opacity: 1; }
  .badge { display: inline-block; margin-top: calc(8px * var(--scale)); padding: calc(3px * var(--scale)) calc(10px * var(--scale));
    border-radius: 999px; font-size: calc(13px * var(--scale)); font-weight: 600; letter-spacing: 0.02em; }
  .b-live { background: #2f8f4e; } .b-basic { background: #9a6a12; } .b-idle, .b-unpaired { background: #4a4f5a; }
  .attempt { font-size: calc(14px * var(--scale)); opacity: 0.85; margin-left: calc(8px * var(--scale)); }
  .hidden { display: none; }
</style></head>
<body>
<div class="card" id="card">
  <div class="table" id="table"></div>
  <div class="score" id="score"></div>
  <div class="meta" id="meta"></div>
  <div class="others" id="others"></div>
  <div><span class="badge" id="badge"></span><span class="attempt" id="attempt"></span></div>
</div>
<script>
  const q = new URLSearchParams(location.search);
  const scale = Number(q.get('scale'));
  if (scale > 0 && scale < 10) document.documentElement.style.setProperty('--scale', String(scale));
  if (q.get('side') === 'right') document.body.classList.add('right');
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '');
  function draw(s) {
    $('table').textContent = s.table || '';
    $('table').classList.toggle('hidden', !s.table);
    const g = s.game;
    const scores = g ? g.scores : [];
    const up = g && g.player ? g.player : 1;
    const shown = scores.length ? scores[up - 1] : null;
    $('score').textContent = fmt(shown);
    $('score').classList.toggle('hidden', shown === null || shown === undefined);
    const meta = [];
    if (g && g.inGame && g.player) meta.push('Player ' + g.player);
    if (g && g.inGame && g.ball) meta.push('Ball ' + g.ball);
    if (g && !g.inGame && scores.length) meta.push('Game over');
    $('meta').textContent = meta.join('  ·  ');
    $('meta').classList.toggle('hidden', !meta.length);
    let last = 0;
    scores.forEach((v, i) => { if (typeof v === 'number' && v > 0) last = i + 1; });
    const count = Math.max(last, g && g.player ? g.player : 0);
    $('others').innerHTML = '';
    if (count > 1) for (let i = 0; i < count; i++) {
      const el = document.createElement('span');
      el.textContent = 'P' + (i + 1) + ' ' + fmt(scores[i] ?? 0);
      if (i + 1 === up && g && g.inGame) el.className = 'up';
      $('others').appendChild(el);
    }
    $('others').classList.toggle('hidden', count <= 1);
    $('badge').textContent = s.badge.text;
    $('badge').className = 'badge b-' + s.badge.kind;
    $('attempt').textContent = s.attempt || '';
  }
  const es = new EventSource('/events');
  es.onmessage = (e) => { try { draw(JSON.parse(e.data)); } catch (err) {} };
</script>
</body></html>
`;
