/**
 * A17 step 9 (2026-11-27): the story fixtures are true to the code. The pictures of the lobby's screens are drawn
 * from `companion/renderer/story/fixtures.ts`; a picture of a sentence the app never says is worse than no picture.
 * Here the real engines and the real MatchController (a MemoryBus, a ManualClock, as controller-lobby.test.ts) are
 * taken through the states of an evening, and at each state the fixture of that name is held against what the
 * controller says from that seat: the headline, the line, the start's line and its second press, the start button's
 * words and why it is off, the new match's line, the table's line and why it cannot be changed, every member's
 * choice and row state, who starts, and what can be ended or given up.
 *
 * A fixture that is not in `SEEN` at the end has no scene here: the test names it, so that a new fixture is not
 * believed before it is checked. The sentences the controller does not make (the shell's and one-step's) are held
 * against their own functions in main/story-fixtures-shell.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint, ParticipantInfo } from '@castcade/protocol';
import type { MatchMedia, MediaStatus, PanelState } from '../media/match-media-types.js';
import { headerText } from '../media/panel-page.js';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { COUNTDOWN_HELD_MS, MatchController, type ControllerFeed } from './controller.js';
import { HostMatch } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { NO_TABLE } from './lobby.test-support.js';
import { MemoryBus } from './transport.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// The story files are not part of this project's TypeScript build (they are loosely typed, for the browser): loaded by path.
const story = (file: string): Promise<any> => import(/* @vite-ignore */ new URL(`../../renderer/story/${file}`, import.meta.url).href);

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const hex = 'ab'.repeat(32);
const table = (tableName: string, h = hex): GameFingerprint => ({ kind: 'vpx', tableName, tableHash: h, romName: null, romHash: null, physicsHash: null, recipeVersion: '0.3.1', sidecarHash: null, emulatorVersion: '10.8.0' });
const NAMES: Record<string, string> = { owner: 'Owner', krobs: 'Krobs', chuck: 'Chuck', dana: 'Dana' };
const who = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: NAMES[id] ?? id, publicKey: keys.publicKeyB64, rig: id === 'dana' ? 'pc' : 'vr_headset' });

class FakeMedia implements MatchMedia {
  attach(): Promise<void> {
    return Promise.resolve();
  }
  addPeer(): void {}
  removePeer(): void {}
  setSending(): void {}
  setPanelState(_s: PanelState): void {}
  setMuted(): void {}
  status(): MediaStatus {
    return { attached: true, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null };
  }
  onStatus(): () => void {
    return () => undefined;
  }
  frames(): null {
    return null;
  }
  showPanel(): void {}
  detach(): Promise<void> {
    return Promise.resolve();
  }
}

function seat(role: HostMatch | ClientMatch, clock: ManualClock): MatchController {
  return new MatchController({
    role,
    localId: role.localId,
    lock: { lock: () => undefined, unlock: () => undefined },
    cue: { play: () => undefined },
    media: new FakeMedia(),
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    log: () => undefined,
  });
}

/** A lobby opened by Owner on Monster Bash, with the members named, every one set to Play. */
async function lobby(members: string[], tableName: string, graceMs = 0, balls = 3) {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const game = table(tableName);
  const host = new HostMatch({ disconnectGraceMs: graceMs, transport: bus.transport('owner'), keys: hk, matchId: 'JHDFEF', ballsPerGame: balls, hostParticipant: who('owner', hk), hostGame: game, clock, lobby: { stance: 'play', countdownMs: 5000 } });
  const seats: Record<string, MatchController> = { owner: seat(host, clock) };
  await seats['owner']!.open();
  const clients: Record<string, ClientMatch> = {};
  for (const id of members) {
    const k = generateKeys();
    const c = new ClientMatch({ disconnectGraceMs: graceMs, transport: bus.transport(id), keys: k, participant: who(id, k), game, throwdownCode: 'JHDFEF', hostId: 'owner', clock, reconnect: { attempts: 1000, delayMs: 5000, maxMs: 20 * 60_000 }, hostLeftTransfer: false, lobby: { stance: 'play' } });
    clients[id] = c;
    seats[id] = seat(c, clock);
    await seats[id]!.open();
    c.join();
    await flush();
  }
  const tick = async (ms: number): Promise<void> => {
    clock.advance(ms);
    await flush();
  };
  return { bus, clock, host, clients, seats, tick, game };
}
type Rig = Awaited<ReturnType<typeof lobby>>;

const start: ControllerFeed = { kind: 'game_start', t: 0, players: 1 };
const scores = (s: number, ball: number): ControllerFeed => ({ kind: 'current_scores', t: 0, scores: [s], player: 1, ball });
const ballEnd = (ball: number): ControllerFeed => ({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 });
const gameEnd = (s: number): ControllerFeed => ({ kind: 'game_end', t: 0, scores: [s], players: 1 });

/** The seat plays its ball `ball` of a game of `balls` on its own table, to `score`. */
async function playBall(r: Rig, id: string, ball: number, score: number, balls = 3): Promise<void> {
  const c = r.seats[id] as MatchController;
  if (ball === 1) c.feed(start);
  c.feed(scores(score, ball));
  c.feed(ballEnd(ball));
  await r.tick(2500);
  if (ball === balls) {
    c.feed(gameEnd(score));
    await flush();
  }
}

/**
 * How long the lobby's PC has been away and for how long this member goes on asking for it is the link layer's
 * (`ClientMatch.hostAway()`: a relay transport's attempts and their window, lobby-away.test.ts and
 * match-restart.test.ts). The memory bus of this rig has no such layer, so the scene says it in its place; the
 * sentence made from it is the controller's own.
 */
function linkSays(r: Rig, id: string, awayMin: number, leftMin: number): void {
  const c = r.clients[id] as ClientMatch;
  const now = r.clock.now();
  c.hostAway = () => ({ since: now - awayMin * 60_000, until: now + leftMin * 60_000 });
  (r.seats[id] as MatchController).refresh();
}

/** Numbers that move (a countdown, the minutes left, a ball) do not make two sentences different. */
const still = (s: string | null | undefined): string | null => (s == null ? null : s.replace(/\d+/g, 'N'));

/** What a person reads of the lobby, as the controller makes it. */
function real(c: MatchController): unknown {
  const st = c.status();
  const l = st.lobby;
  const p = c.panel();
  if (!l) return null;
  return {
    phase: st.phase,
    header: still(headerText(p)),
    message: still(p.message),
    stance: l.stance,
    starter: l.starter,
    members: l.members.map((m) => `${m.id} ${m.stance}${m.inMatch ? ' in' : ''}${m.flags.length > 0 ? ` [${m.flags.join(' ')}]` : ''}`),
    table: { name: l.table.name, by: l.table.pickedByName, off: l.table.off, changing: l.table.changing },
    start: l.start ? { by: l.start.by, players: l.start.players.join(' '), waitsFor: l.start.waitsFor, waitsOn: l.start.waitsOn.join(' '), line: still(l.start.line) } : null,
    startWithout: l.startWithout,
    button: `${l.startButton.label} | ${still(l.startButton.line)} | ${l.startButton.off}`,
    newMatch: l.newMatch ? l.newMatch.line : null,
    end: l.end,
    giveUp: l.giveUp,
    over: l.over,
    hostAway: l.hostAway !== null,
  };
}

/** The same of a fixture, through the story's own `status()`. */
function told(st: any): unknown {
  const l = st.lobby;
  const p = st.panel as PanelState;
  return {
    phase: st.phase,
    header: still(headerText(p)),
    message: still(p.message),
    stance: l.stance,
    starter: l.starter,
    members: l.members.map((m: any) => `${m.id} ${m.stance}${m.inMatch ? ' in' : ''}${m.flags.length > 0 ? ` [${m.flags.join(' ')}]` : ''}`),
    table: { name: l.table.name, by: l.table.pickedByName, off: l.table.off, changing: l.table.changing },
    start: l.start ? { by: l.start.by, players: l.start.players.join(' '), waitsFor: l.start.waitsFor, waitsOn: l.start.waitsOn.join(' '), line: still(l.start.line) } : null,
    startWithout: l.startWithout,
    button: `${l.startButton.label} | ${still(l.startButton.line)} | ${l.startButton.off}`,
    newMatch: l.newMatch ? l.newMatch.line : null,
    end: l.end,
    giveUp: l.giveUp,
    over: l.over,
    hostAway: l.hostAway !== null,
  };
}

describe('the story fixtures say what the controller says (A17 step 9)', () => {
  it('every lobby fixture, held against the real controller in that state, from that seat', async () => {
    const fx = await story('fixtures.ts');
    const base = await story('base.ts');
    const TABLE: string = fx.TABLE;
    const seen = new Set<string>();
    const wrong: Array<{ fixture: string; told: unknown; real: unknown }> = [];
    /** The fixture `name` is what `c` says now. */
    const check = (name: string, c: MatchController | undefined, except: string[] = []): void => {
      const f = fx.FIXTURES[name];
      expect(f, `no fixture named ${name}`).toBeDefined();
      expect(c, name).toBeDefined();
      seen.add(name);
      const a = told(fx.status(f, base.MATCH).match) as Record<string, unknown>;
      const b = real(c as MatchController) as Record<string, unknown>;
      for (const key of except) {
        delete a[key];
        delete b[key];
      }
      try {
        expect(a).toEqual(b);
      } catch {
        wrong.push({ fixture: name, told: a, real: b });
      }
    };

    // ---- a lobby alone
    {
      const r = await lobby([], TABLE);
      check('alone', r.seats['owner']);
    }
    // ---- four people, two set to Watch; then a start that counts down; a game from each seat; between games; the match ended
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      const S = r.seats as Record<string, MatchController>;
      check('full-direct', S['owner']);
      S['chuck']!.setStance('watch');
      S['dana']!.setStance('watch');
      await flush();
      check('four-starter', S['owner']);
      check('four-player', S['krobs']);
      check('four-watcher', S['chuck']);
      S['chuck']!.setStance('play');
      await flush();
      expect(S['owner']!.requestStart()).toBeNull();
      await r.tick(1000);
      check('start-countdown', S['krobs']);
      await r.tick(4000);
      await playBall(r, 'owner', 1, 1_234_560);
      S['krobs']!.feed(start);
      S['krobs']!.feed(scores(987_650, 1));
      await flush();
      check('game-up', S['krobs']);
      check('game-waiting', S['chuck']);
      check('game-watcher', S['dana']);
      check('game-owner', S['owner']);
      S['krobs']!.feed(ballEnd(1));
      await r.tick(2500);
      await playBall(r, 'chuck', 1, 455_000);
      const total: Record<string, number> = { owner: 3_456_780, krobs: 2_100_000, chuck: 990_000 };
      for (const ball of [2, 3]) for (const id of ['owner', 'krobs', 'chuck']) await playBall(r, id, ball, ball === 3 ? (total[id] as number) : ball * 400_000);
      await r.tick(100);
      check('between', S['owner']);
      S['dana']!.setStance('play');
      await flush();
      check('between-newmatch', S['dana']);
      S['dana']!.setStance('watch');
      await flush();
      expect(S['krobs']!.requestEnd()).toBeNull();
      await r.tick(100);
      check('match-ended', S['krobs']);
    }
    // ---- the lobby's PC is set to Watch
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      r.seats['owner']!.setStance('watch');
      await flush();
      check('four-owner-watches', r.seats['owner']);
    }
    // ---- a member is away in the lobby; the lobby is closed by its owner
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      r.bus.disconnect('dana');
      await r.tick(1000);
      check('member-away-lobby', r.seats['owner']);
    }
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      r.host.closeLobby('Owner closed the lobby');
      await r.tick(100);
      check('lobby-closed', r.seats['krobs']);
    }

    // ---- starts that wait: for a table, for 3D, for a player whose link dropped a moment ago
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      r.clients['chuck']!.updateParticipant({ game: NO_TABLE });
      await flush();
      expect(r.seats['owner']!.requestStart()).toBeNull();
      await flush();
      check('start-waits-table', r.seats['owner']);
    }
    {
      const r = await lobby(['krobs'], TABLE);
      r.host.updateLocal({ stream3dWaitMs: 45_000 });
      await flush();
      expect(r.seats['krobs']!.requestStart()).toBeNull();
      await flush();
      check('start-waits-3d', r.seats['krobs']);
    }
    {
      const r = await lobby(['krobs', 'chuck'], TABLE, 30_000);
      expect(r.seats['owner']!.requestStart()).toBeNull();
      await r.tick(4400);
      r.bus.disconnect('chuck');
      await flush();
      await r.tick(600);
      await r.tick(COUNTDOWN_HELD_MS);
      check('start-held-grace', r.seats['owner']);
    }
    // ---- a member with no copy of the lobby's table; a member with another table open
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      r.clients['dana']!.updateParticipant({ noCopy: true });
      await flush();
      check('no-table', r.seats['dana']);
    }
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      r.clients['chuck']!.updateParticipant({ game: table(fx.OTHER_TABLE, 'cd'.repeat(32)) });
      await flush();
      check('other-table', r.seats['owner']);
      // Step 10's fix round: the same table under another name is that PC's copy of the pick once it says so: no OTHER TABLE.
      r.seats['chuck']!.setPickCopy({ pick: TABLE, tableName: fx.OTHER_TABLE, tableHash: 'cd'.repeat(32) });
      await flush();
      expect(r.seats['owner']!.status().lobby?.members.find((m) => m.id === 'chuck')?.flags).toEqual([]);
    }
    // ---- a player who is away at their own turn; the player who is up and away; the lobby's PC away, and its kept quit
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      const S = r.seats as Record<string, MatchController>;
      S['dana']!.setStance('watch');
      await flush();
      expect(S['owner']!.requestStart()).toBeNull();
      await r.tick(5000);
      await playBall(r, 'owner', 1, 1_234_560);
      await playBall(r, 'krobs', 1, 987_650);
      r.bus.disconnect('chuck');
      await r.tick(1000);
      check('waited-for', S['owner']);
    }
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      const S = r.seats as Record<string, MatchController>;
      S['dana']!.setStance('watch');
      await flush();
      expect(S['owner']!.requestStart()).toBeNull();
      await r.tick(5000);
      await playBall(r, 'owner', 1, 1_234_560);
      S['krobs']!.feed(start);
      S['krobs']!.feed(scores(987_650, 1));
      await flush();
      r.bus.disconnect('krobs');
      await r.tick(1000);
      check('away-question', S['owner']);
    }
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      const S = r.seats as Record<string, MatchController>;
      S['dana']!.setStance('watch');
      await flush();
      expect(S['owner']!.requestStart()).toBeNull();
      await r.tick(5000);
      await playBall(r, 'owner', 1, 1_234_560);
      S['krobs']!.feed(start);
      S['krobs']!.feed(scores(987_650, 1));
      await flush();
      r.bus.disconnect('owner');
      await r.tick(2 * 60_000);
      linkSays(r, 'krobs', 2, 18);
      check('host-away', S['krobs']);
    }
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE, 0, 1);
      const S = r.seats as Record<string, MatchController>;
      S['dana']!.setStance('watch');
      await flush();
      expect(S['owner']!.requestStart()).toBeNull();
      await r.tick(5000);
      for (const [id, score] of [['owner', 3_456_780], ['krobs', 2_100_000], ['chuck', 990_000]] as const) await playBall(r, id, 1, score, 1);
      await r.tick(100);
      r.host.sayKept(20 * 60_000);
      await flush();
      r.bus.disconnect('owner');
      await r.tick(4 * 60_000);
      linkSays(r, 'chuck', 4, 16);
      check('host-kept-quit', S['chuck']);
    }
    // ---- the game somebody gave up, still on their table
    {
      const r = await lobby(['krobs'], TABLE, 0, 1);
      const S = r.seats as Record<string, MatchController>;
      expect(S['owner']!.requestStart()).toBeNull();
      await r.tick(5000);
      await playBall(r, 'owner', 1, 3_456_780, 1);
      S['krobs']!.feed(start);
      S['krobs']!.feed(scores(50_000, 1));
      await flush();
      expect(S['krobs']!.giveUp()).toBe(true);
      await r.tick(100);
      expect(S['owner']!.requestStart()).toBeNull();
      await flush();
      check('given-up-me', S['krobs']);
      check('given-up-others', S['owner']);
    }
    // ---- the table is changed: every PC on its way to it
    {
      const r = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      const S = r.seats as Record<string, MatchController>;
      const congo = table(fx.OTHER_TABLE, 'cd'.repeat(32));
      expect(S['krobs']!.pickTable(congo, null)).toBeNull();
      await flush();
      const line = (name: string): string | null => fx.FIXTURES[name].change?.detail ?? null;
      S['krobs']!.setTableChange('opening', null);
      S['owner']!.setTableChange('closing', line('table-changing'));
      S['chuck']!.setTableChange('waits_person', line('table-close-it'));
      S['dana']!.setTableChange('offered', line('table-open-it'));
      await flush();
      check('table-changing', S['owner']);
      check('table-close-it', S['chuck']);
      check('table-open-it', S['dana']);
      // Everybody but one has the table open: nobody is closing or opening, and the header is the lobby's again.
      S['krobs']!.setTableChange(null, null);
      S['owner']!.setTableChange(null, null);
      S['chuck']!.setTableChange(null, null);
      for (const id of ['krobs', 'chuck']) r.clients[id]!.updateParticipant({ game: congo });
      r.host.updateLocal({ game: congo });
      S['dana']!.setTableChange('offered', line('table-asked-after-away'));
      await flush();
      check('table-asked-after-away', S['dana']);
      check('table-one-asked', S['owner']);
    }
    // ---- states that are a lobby as above, with a sentence of the shell's over it (held in main/story-fixtures-shell.test.ts)
    {
      const r = await lobby(['krobs'], TABLE);
      check('cannot-save', r.seats['owner'], ['message']);
      const q = await lobby(['krobs', 'chuck', 'dana'], TABLE);
      check('relay-waiting', q.seats['owner']);
    }

    expect(wrong, JSON.stringify(wrong, null, 1)).toEqual([]);
    // No lobby fixture is believed before it has a scene here.
    const unseen = Object.keys(fx.FIXTURES).filter((name) => (fx.FIXTURES[name].here ?? []).length > 0 && !seen.has(name));
    expect(unseen).toEqual([]);
  }, 120_000);
});
