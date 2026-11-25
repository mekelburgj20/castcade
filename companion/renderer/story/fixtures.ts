/**
 * A17 step 9 (2026-11-27): the states of a lobby as fixtures, one per name, for the story pages in this folder
 * (match.html: the real Match tab; panel.html: the panel and the scoreboard pages; menu.html: the in-game menu as
 * text). Never shipped. Nothing here is a real lobby, address or path: the people are Owner (who opened the lobby),
 * Krobs, Chuck and Dana; the code is JHDFEF; the tables are named after real machines.
 *
 * A fixture says whose PC it is seen from (`me`) and what is the case; `status()` makes the `MatchStatus` the main
 * process would send for it. The story files are not typechecked with the app (they are loosely typed on purpose:
 * a fixture that lacks a key shows as a hole on the screen, which is the point of looking).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export const CODE = 'JHDFEF';
export const TABLE = 'Monster Bash (Williams 1998)';
export const OTHER_TABLE = 'Congo (Williams 1995)';
export const LINK = `https://arcaid.app/castcade/join/${CODE}`;
/** The record that cannot be saved: a folder and the system's word, as `cannotSaveSentence(folder, why)` takes them (a placeholder path, nobody's). */
export const SAVE_FOLDER = 'C:\\Users\\you\\AppData\\Roaming\\Castcade';
export const SAVE_ERROR = 'EPERM: operation not permitted';

export type Who = 'owner' | 'krobs' | 'chuck' | 'dana';
const ALL_NAMES: Record<Who, string> = { owner: 'Owner', krobs: 'Krobs', chuck: 'Chuck', dana: 'Dana' };
const RIGS: Record<Who, string> = { owner: 'vr_headset', krobs: 'vr_headset', chuck: 'vr_headset', dana: 'pc' };

export interface Fixture {
  /** One line for the index: what state this is, and from whose PC. */
  says: string;
  me: Who;
  /** Who is in the lobby, in the order they joined (the owner first); empty: no lobby. */
  here?: Who[];
  watch?: Who[];
  flags?: Partial<Record<Who, string[]>>;
  awaySince?: Partial<Record<Who, number>>;
  /** The open match: its players in turn order, the game, whether it is being played. */
  match?: { players: Who[]; game: number; state: 'game' | 'between' } | null;
  phase?: 'lobby' | 'playing' | 'paused' | 'over';
  up?: Who | null;
  ball?: number;
  scores?: Partial<Record<Who, [score: number | null, ballsDone: number]>>;
  message?: string | null;
  countdown?: number | null;
  start?: any;
  startWithout?: string | null;
  startOff?: string | null;
  startLine?: string;
  newMatch?: any;
  result?: Array<[Who, number]> | null;
  series?: Array<[Who, number, number]> | null;
  hostAway?: { minutesLeft: number } | null;
  over?: boolean;
  waitedFor?: Who | null;
  awayQuestion?: { who: Who; score: number } | null;
  giveUp?: boolean;
  endBall?: { score: number } | null;
  locked?: boolean;
  lastError?: string | null;
  relayNote?: string | null;
  via?: 'relay' | 'direct';
  table?: any;
  change?: any;
  launch?: any;
  resume?: any;
  pending?: any;
  advisories?: string[];
  startWarnings?: string[];
  left?: Who[];
  /** The opener's picked table that waits for Start the table (one-step.ts `tableToStart`; "Start the table as soon as I open the lobby" is off). */
  tableToStart?: string | null;
  /** Another name for one of the four (the longest a name can be), to see that nothing it touches breaks. */
  names?: Partial<Record<Who, string>>;
  /** The table that is open on this PC (the witness's word): the lobby's unless said; null: none is open. */
  open?: string | null;
  /** Balls per game (3 unless a state was reached in a game of one ball). */
  balls?: number;
  /** The match that ended last (controller.ts `LobbyStatus.lastMatch`): games, and the standing as [who, games won, total score]. */
  lastMatch?: { games: number; standing: Array<[Who, number, number]> } | null;
  /** The twenty seconds after a match ended: the panel's header reads MATCH OVER. */
  matchOver?: boolean;
}

const NOW = Date.now();

/** The `MatchStatus` of a fixture (see main/match-host.ts `status()`), and the `OneStepStatus` beside it. */
/** As match/short-name.ts `shortName` (held against it in main/story-fixtures-shell.test.ts). */
export function shown(name: string, max = 24): string {
  const chars = Array.from(name);
  return chars.length <= max ? name : `${chars.slice(0, max - 1).join('')}…`;
}

export function status(f: Fixture, base: any): { match: any; oneStep: any } {
  // The names of this fixture: whole in a row (`RAW`), cut inside a sentence (`NAMES`).
  const RAW: Record<Who, string> = { ...ALL_NAMES, ...(f.names ?? {}) };
  const NAMES = Object.fromEntries(Object.entries(RAW).map(([w, n]) => [w, shown(n)])) as Record<Who, string>;
  const here = f.here ?? [];
  const inLobby = here.length > 0;
  const watch = new Set(f.watch ?? []);
  const m = f.match ?? null;
  const phase = f.phase ?? (m ? (m.state === 'game' ? 'playing' : 'over') : 'lobby');
  const playing = phase === 'playing' || phase === 'paused';
  const starter = m ? (m.players[0] ?? null) : (here.find((w) => !watch.has(w) && !(f.flags?.[w] ?? []).includes('away')) ?? null);
  const members = here.map((w) => ({
    id: w,
    name: RAW[w],
    rig: RIGS[w],
    stance: watch.has(w) ? 'watch' : 'play',
    opener: w === 'owner',
    me: w === f.me,
    starter: w === starter,
    inMatch: m ? m.players.includes(w) : false,
    flags: f.flags?.[w] ?? [],
    awaySince: f.awaySince?.[w] !== undefined ? NOW - (f.awaySince[w] as number) * 1000 : (f.flags?.[w] ?? []).includes('away') ? NOW - 42_000 : null,
  }));
  // As controller.ts `panel()`: the players of the open match, and the members while none is open.
  const players = (m ? m.players : here).map((w) => ({
    id: w,
    name: RAW[w],
    score: f.scores?.[w]?.[0] ?? null,
    ballsDone: f.scores?.[w]?.[1] ?? 0,
    isUp: playing && f.up === w,
    flags: (f.flags?.[w] ?? []).includes('away') ? ['disconnected'] : [],
  }));
  const gameKey = m ? `${CODE}-1/${m.game}/${m.state}` : '';
  const between = phase === 'over' && m !== null;
  // As controller.ts `wouldPlay`: set to Play, here, with a copy of the table (the lobby's PC, while it is away, is still counted: its members only know that its link is down).
  const playSet = here.filter((w) => !watch.has(w) && !(f.flags?.[w] ?? []).some((x) => (x === 'away' && !(f.hostAway && w === 'owner')) || x === 'no_table'));
  const names = (ws: Who[]): string => {
    const n = ws.map((w) => NAMES[w]);
    return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  };
  const awayNow = here.filter((w) => (f.flags?.[w] ?? []).includes('away') && !playSet.includes(w));
  // As controller.ts: whoever is here and not in the start watches (set to Watch, or with no copy of the table).
  const watchers = here.filter((w) => !playSet.includes(w) && !awayNow.includes(w));
  const defaultLine = between
    ? `Game ${(m?.game ?? 1) + 1} of this match.${f.series ? ` ${f.series.map(([w, wins], i) => `${NAMES[w]} ${wins}${i === 0 ? (wins === 1 ? ' win' : ' wins') : ''}`).join(', ')}.` : ''}`
    : playSet.length >= 2
      ? `${names(playSet)} play.${watchers.length > 0 ? ` ${names(watchers)} ${watchers.length === 1 ? 'watches' : 'watch'}.` : ''}${awayNow.length > 0 ? ` ${names(awayNow)} ${awayNow.length === 1 ? 'is' : 'are'} away.` : ''}`
      : '';
  const onWay = playSet.filter((w) => (f.flags?.[w] ?? []).some((x) => x === 'changing' || x === 'close_table' || x === 'asked')).length;
  const waits = onWay > 0 ? ` A start waits for the table${onWay > 1 ? 's' : ''} that ${onWay > 1 ? 'are' : 'is'} not open yet.` : '';
  const off =
    f.startOff !== undefined
      ? f.startOff
      : f.over
        ? 'The lobby is closed.'
        : f.hostAway
          ? "The lobby's PC is away."
          : playing
            ? 'A game is being played.'
            : f.start
              ? 'A start is under way.'
              : playSet.length < 2
                ? 'Two people have to be set to Play.'
                : !between && f.table?.name === null
                  ? "Pick the lobby's table first."
                  : null;
  const lobby = inLobby
    ? {
        stance: watch.has(f.me) ? 'watch' : 'play',
        starter,
        members,
        match: m ? { id: `${CODE}-1`, game: m.game, state: m.state, players: m.players } : null,
        table: { name: TABLE, pickedBy: 'owner', pickedByName: 'Owner', off: f.over ? 'The lobby is closed.' : f.hostAway ? "The lobby's PC is away." : playing ? 'A game is being played: the table changes after it.' : f.start ? 'A match is starting: cancel the start to change the table.' : null, endsMatch: m !== null, changing: false, ...(f.table ?? {}) },
        start: f.start ?? null,
        startButton: { label: between ? 'Next game' : 'Start match', line: f.startLine ?? (defaultLine === '' ? '' : `${defaultLine}${waits}`), off },
        newMatch: f.newMatch ?? null,
        gameKey,
        startWithout: f.startWithout ?? null,
        end: f.over || f.hostAway ? null : between ? 'match' : playing && f.me === 'owner' ? 'everyone' : null,
        giveUp: f.giveUp ?? false,
        hostAway: f.hostAway ? { since: NOW - (20 - f.hostAway.minutesLeft) * 60_000, until: NOW + f.hostAway.minutesLeft * 60_000 } : null,
        over: f.over ?? false,
        lastMatch: f.lastMatch && !m ? { games: f.lastMatch.games, abandoned: null, standing: f.lastMatch.standing.map(([w, wins, total]) => ({ id: w, name: NAMES[w], wins, total })) } : null,
        waitedFor: f.waitedFor ? { player: f.waitedFor, name: RAW[f.waitedFor], minutes: 1 } : null,
        awayQuestion: f.awayQuestion ? { player: f.awayQuestion.who, name: RAW[f.awayQuestion.who], minutes: 3, score: f.awayQuestion.score } : null,
      }
    : null;
  const panel = inLobby
    ? {
        playerUp: playing ? (f.up ?? null) : null,
        myTurn: playing && f.up === f.me,
        ball: playing && f.up ? (f.ball ?? 1) : null,
        ballsPerGame: f.balls ?? 3,
        players,
        phase: phase === 'lobby' ? 'idle' : phase,
        result: f.result ? f.result.map(([w, score], i) => ({ id: w, name: NAMES[w], score, place: i + 1 })) : null,
        game: m?.game ?? 1,
        series: f.series ? f.series.map(([w, wins, games], i) => ({ id: w, name: NAMES[w], wins, games, total: 0, place: i + 1 })) : null,
        seriesOver: f.over ?? false,
        countdown: f.countdown ?? null,
        message: f.message ?? null,
        mic: 'open',
        members: members.map((x) => ({ id: x.id, name: x.name, stance: x.stance, flags: x.flags, inMatch: x.inMatch })),
        starter,
        stance: watch.has(f.me) ? 'watch' : 'play',
        // As controller.ts: the table's name while PCs are on their way to it; who a pause is for.
        ...(f.table?.changing && !playing ? { changingTable: f.table.name } : {}),
        ...(f.matchOver ? { matchOver: true } : {}),
        ...(phase === 'paused' && f.waitedFor ? { pausedFor: f.waitedFor } : {}),
      }
    : null;
  const host = f.me === 'owner';
  const match = {
    ...base,
    role: inLobby ? (host ? 'host' : 'client') : 'none',
    phase: inLobby ? phase : 'none',
    // As match-host.ts `status()`: the code for every member of a lobby through ArcAid; the address invite for the opener alone.
    invite: !inLobby ? null : f.via === 'direct' ? (host ? `castcade:ws://203.0.113.20:27401#${CODE}` : null) : CODE,
    via: inLobby ? (f.via ?? 'relay') : null,
    path: inLobby ? (f.via === 'direct' ? "Direct to Owner's PC" : 'Through ArcAid') : null,
    relayNote: f.relayNote ?? null,
    port: inLobby && host ? 27401 : null,
    code: inLobby ? CODE : null,
    localId: inLobby ? f.me : null,
    hostId: inLobby ? 'owner' : null,
    participants: here.map((w) => ({ id: w, name: RAW[w], rig: RIGS[w], tableMatch: true, tableNote: null, buildMatch: true, ballEnds: true })),
    lobby,
    startWarnings: f.startWarnings ?? [],
    wait3d: { players: [], seconds: 0, armed: null },
    advisories: f.advisories ?? [],
    canResume: false,
    pass: playing && host && f.up && f.up !== 'owner' ? { name: NAMES[f.up], ball: f.ball ?? 1, score: f.scores?.[f.up]?.[0] ?? 0 } : null,
    endBall: f.endBall ? { grantSeq: 7, ball: f.ball ?? 1, score: f.endBall.score, tableBall: false } : null,
    series: m ? { game: m.game, over: f.over ?? false, nextGameBlocker: null } : null,
    panel,
    media: inLobby ? { attached: true, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null } : null,
    locked: f.locked ?? false,
    settings: { ...base.settings, displayName: RAW[f.me], stance: watch.has(f.me) ? 'watch' : 'play' },
    defaultName: RAW[f.me],
    lastError: f.lastError ?? null,
    resume: f.resume ?? null,
  };
  const oneStep = {
    link: inLobby && f.via !== 'direct' ? LINK : null,
    message: inLobby && f.via !== 'direct' ? `Castcade lobby on ${TABLE}: ${LINK}` : null,
    copied: false,
    pending: f.pending ?? null,
    launch: f.launch ?? { state: 'idle', table: null, detail: null },
    tableToStart: f.tableToStart ?? null,
    change: f.change ?? null,
    notice: null,
    attention: 0,
  };
  return { match, oneStep };
}

const four: Who[] = ['owner', 'krobs', 'chuck', 'dana'];
const AWAY_LINE = (left: number, what = 'match'): string => `Owner's PC is away. The ${what} goes on when it is back: waiting up to 20 minutes (${left} min left). You can keep talking; Leave lobby ends the wait for you.`;
const KEPT_LINE = (left: number): string => `Owner closed Castcade and kept the lobby: it goes on if Owner opens Castcade again within 20 minutes (${left} min left). You can wait and keep talking; Leave lobby frees your table now.`;
const KEPT_MINE_LINE = (left: number): string => `Owner closed Castcade and kept the lobby: it goes on if Owner opens Castcade again within 20 minutes (${left} min left). Your ball goes on: play it out, and its end is reported when Owner is back. Leave lobby ends the wait for you.`;
const GIVEN_UP_WAIT = 'The game you gave up is still on your table, which is yours meanwhile: play it out (it counts for nothing) or restart the table. The next game waits for it';
const START = (by: Who, players: Who[], o: any = {}): any => ({ by, players, newMatch: true, waitsFor: null, waitsOn: [], seconds: 4, line: '', ...o });

/**
 * A table change as one-step.ts says it on this PC (`OneStepStatus.change`, and the panel's line through
 * `setTableChange`): `detail` is `changeWords(state, table, open, why, by)`, word for word.
 */
const CHANGE = (state: 'offered' | 'own_game' | 'closing' | 'close_it', why: string | null, detail: string): any => ({ state, table: OTHER_TABLE, open: TABLE, why, by: 'Krobs', detail });
const CLOSING = CHANGE('closing', null, `Krobs changed the lobby's table to ${OTHER_TABLE}. Closing ${TABLE}; ${OTHER_TABLE} opens next.`);
const CLOSE_IT = CHANGE('close_it', null, `Close the table on this PC: Castcade opens ${OTHER_TABLE} when it is closed.`);
const ASKS_OFTEN = CHANGE('offered', 'often', `Krobs changed the lobby's table to ${OTHER_TABLE}. Open it: Castcade closes ${TABLE} and opens ${OTHER_TABLE}. The table has changed several times in a few minutes, so Castcade asks before it changes tables again.`);
const ASKS_AWAY = CHANGE('offered', 'away', `Krobs changed the lobby's table to ${OTHER_TABLE} while this PC was away from the lobby. Open it: Castcade closes ${TABLE} and opens ${OTHER_TABLE}.`);
// The lobby's table is offered to a PC whose open table is not its copy of it (one-step.ts, `why: 'here'`): with
// another table open, and with nothing open (a join by code starts no table).
const OFFER_OTHER = { state: 'offered', table: TABLE, open: OTHER_TABLE, why: 'here', by: null, detail: `The lobby's table is ${TABLE}, and ${OTHER_TABLE} is open on this PC. Open it: Castcade closes ${OTHER_TABLE} and opens ${TABLE}.` };
const OFFER_NONE = { state: 'offered', table: TABLE, open: null, why: 'here', by: null, detail: `The lobby's table is ${TABLE}, and no table is open on this PC. Open it: Castcade opens ${TABLE}.` };
/** An offer on this PC's own panel: its Open it is on the Match tab (controller.ts `offerOnPanel`; held in main/story-fixtures-shell.test.ts). */
const ON_PANEL = (line: string): string => line.replace('Open it:', 'Open it on the Match tab:').replace('(Open it)', '(Open it on the Match tab)');
/** What the lobby's PC answers to a member's pick a second after the table was changed (host.ts; held in match/story-fixtures.test.ts). */
export const PICK_REFUSED = "The lobby's table was changed a moment ago: it can be changed again in 9 s.";
const PICKED = { name: OTHER_TABLE, pickedBy: 'krobs', pickedByName: 'Krobs', endsMatch: false };
const ON_THE_WAY = { owner: ['changing'], krobs: ['changing'], chuck: ['close_table'], dana: ['asked'] };

export const FIXTURES: Record<string, Fixture> = {
  // ---- no lobby
  'none': { says: 'No lobby: Open a lobby and Join a lobby', me: 'owner' },
  'none-link': { says: 'No lobby, a join link was clicked outside the app and waits for the click', me: 'krobs', pending: { code: CODE, address: null } },
  'resume-quit': { says: "Castcade started again on the lobby's PC after its owner quit and kept the lobby: offered, not reopened", me: 'owner', resume: { code: CODE, role: 'host', names: ['Krobs', 'Chuck', 'Dana'], auto: false, match: true, lost: false } },
  'resume-crash-member': { says: "A member's Castcade started again more than a minute after a crash: the lobby is offered", me: 'krobs', resume: { code: CODE, role: 'client', names: ['Owner', 'Chuck', 'Dana'], auto: false, match: true, lost: false } },
  'resume-damaged': { says: "The lobby PC's record failed its own check: the card says the lobby can only be opened again empty", me: 'owner', resume: { code: CODE, role: 'host', names: ['Krobs', 'Chuck'], auto: false, match: true, lost: true } },
  'resume-v1': { says: 'A saved match from Castcade 0.2.50 was found: said once, nothing offered', me: 'krobs', lastError: 'Castcade closed during the match JHDFEF with Owner, which was played on an older Castcade (protocol 6). This version cannot go back into it: open a lobby, or join one, and play on from there.' },
  'refused-old-here': { says: 'Joining a lobby whose PC runs an older Castcade: the sentence on the PC that tried', me: 'krobs', lastError: "The lobby's PC runs another version of Castcade (protocol 6; this PC has 7). Both need the same: Castcade is updated on the lobby's PC (Settings, Check for updates), then join again." },
  'refused-old-there': { says: 'This PC runs the older Castcade and tried to join a newer lobby: the sentence it is sent', me: 'krobs', lastError: 'This lobby needs Castcade 0.2.51 or newer (protocol 7; this PC sent 6). Update Castcade on this PC (Settings, Check for updates) and join again.' },
  'refused-full': { says: 'Joining a lobby that already holds four people', me: 'dana', lastError: 'This lobby is full (four people).' },
  'unpaired-closed': { says: "The lobby's PC is no longer paired with ArcAid: the lobby was closed on it", me: 'owner', lastError: `The lobby ${CODE} is closed on this PC: this PC is no longer paired with ArcAid, so the others cannot reach it. Pair it again in Settings (Pair with ArcAid), then open a new lobby and send the new code.` },

  // ---- a lobby, no match
  'alone': { says: 'A lobby just opened, nobody has joined yet', me: 'owner', here: ['owner'], message: 'Waiting for a second player: only you are set to Play' },
  'alone-start-table': { says: 'A lobby just opened with "Start the table as soon as I open the lobby" off: the picked table waits for Start the table', me: 'owner', here: ['owner'], tableToStart: TABLE, message: 'Waiting for a second player: only you are set to Play' },
  'four-starter': { says: 'Four people, two set to Watch, seen by the starter (the owner)', me: 'owner', here: four, watch: ['chuck', 'dana'], message: 'Everyone in? Start a game on your table (or Start match in the menu)' },
  'four-player': { says: 'Four people, seen by another player', me: 'krobs', here: four, watch: ['chuck', 'dana'], message: 'Owner starts the match from their table. To start it yourself: Start match in the menu' },
  'four-watcher': { says: 'Four people, seen by a watcher', me: 'chuck', here: four, watch: ['chuck', 'dana'], message: 'You are set to Watch: the match starts without you' },
  'four-owner-watches': { says: "Four people, the lobby's PC is set to Watch", me: 'owner', here: four, watch: ['owner'], message: 'You are set to Watch: the match starts without you' },
  'full-direct': { says: 'A full lobby over a direct link (address invite, port forward)', me: 'owner', here: four, via: 'direct', message: 'Everyone in? Start a game on your table (or Start match in the menu)' },
  'start-countdown': { says: 'A start counts down, seen by somebody in it', me: 'krobs', here: four, watch: ['dana'], countdown: 4, locked: true, start: START('owner', ['owner', 'krobs', 'chuck'], { line: 'Owner starts the match: Owner, you, Chuck' }), message: 'Owner starts the match: Owner, you, Chuck' },
  'start-waits-table': { says: "A start waits for a player's table to open", me: 'owner', here: four, flags: { chuck: ['loading'] }, start: START('owner', four, { waitsFor: 'tables', waitsOn: ['chuck'], seconds: null, line: "You start the match once Chuck's table is open" }), startWithout: 'Start without Chuck', message: "You start the match once Chuck's table is open" },
  'start-waits-3d': { says: 'A start waits for the 3D connections', me: 'krobs', here: ['owner', 'krobs'], start: START('krobs', ['krobs', 'owner'], { waitsFor: '3d', waitsOn: ['owner'], seconds: null, line: 'You start the match once the 3D connection to Owner is up (45 s at most; started without it, the first turn may be the 2D video)' }), startWithout: 'Start without 3D', message: 'You start the match once the 3D connection to Owner is up (45 s at most; started without it, the first turn may be the 2D video)' },
  'start-held-grace': { says: "A start's countdown ran out and is held for a player whose link dropped a moment ago", me: 'owner', here: ['owner', 'krobs', 'chuck'], countdown: 0, locked: true, start: START('owner', ['owner', 'krobs', 'chuck'], { seconds: 0, line: "You start the match in a few seconds (a player's link dropped a moment ago: waiting to see whether they are back)" }), message: "You start the match in a few seconds (a player's link dropped a moment ago: waiting to see whether they are back)" },
  'member-away-lobby': { says: 'A member is away in the lobby (the row says since when)', me: 'owner', here: four, flags: { dana: ['away'] }, message: 'Everyone in? Start a game on your table (or Start match in the menu)' },
  'no-table': { says: "A member has no copy of the lobby's table: they are not counted for a start", me: 'dana', here: four, flags: { dana: ['no_table'] }, launch: { state: 'needed', table: TABLE, detail: `The lobby's table is ${TABLE}. Castcade found no copy of it on this PC. If you have it under another name, open it in VPX: Castcade takes it when it can tell it is the same game. Otherwise you can watch, or pick another table.` }, message: "Castcade found no copy of the lobby's table on this PC: you can watch" },
  'cannot-save': { says: "The lobby's record cannot be written on this PC", me: 'owner', here: ['owner', 'krobs'], lastError: `Castcade cannot save this lobby (the folder ${SAVE_FOLDER}: ${SAVE_ERROR}). The lobby goes on. If Castcade closes before it can be saved again, it comes back as it was last saved, or not at all.`, message: 'Castcade cannot save this lobby on this PC: see the Match tab' },
  'relay-waiting': { says: "The lobby's PC started again and ArcAid does not answer yet", me: 'owner', here: four, flags: { krobs: [], chuck: [], dana: [] }, relayNote: 'ArcAid is not carrying this lobby yet (it did not answer when Castcade started again). Castcade keeps asking; the others can come back once it does', lastError: `Castcade on this PC started again: the lobby ${CODE} is open again as it was. Castcade is waiting for ArcAid to carry it again: the others can come back once it does.`, message: 'Everyone in? Start a game on your table (or Start match in the menu)' },

  // ---- a game
  'game-up': { says: 'A game in play, seen by the player who is up', me: 'krobs', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 1, scores: { owner: [1_234_560, 1], krobs: [987_650, 0] }, giveUp: true, endBall: { score: 987_650 } },
  'game-waiting': { says: 'A game in play, seen by a player who waits for their turn', me: 'chuck', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 1, scores: { owner: [1_234_560, 1], krobs: [987_650, 0] }, giveUp: true, locked: true },
  'game-watcher': { says: 'A game in play, seen by a watcher', me: 'dana', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 1, scores: { owner: [1_234_560, 1], krobs: [987_650, 0] }, locked: true },
  'game-owner': { says: "A game in play, seen by the lobby's PC (Pass the turn, End match for everyone)", me: 'owner', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 1, scores: { owner: [1_234_560, 1], krobs: [987_650, 0] }, giveUp: true, locked: true },
  'between': { says: 'Between games with the result, seen by the starter of the next game', me: 'owner', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'between' }, scores: { owner: [3_456_780, 3], krobs: [2_100_000, 3], chuck: [990_000, 3] }, result: [['owner', 3_456_780], ['krobs', 2_100_000], ['chuck', 990_000]], series: [['owner', 1, 1], ['krobs', 0, 1], ['chuck', 0, 1]], message: 'Next game: start a game on your table (or Next game in the menu)' },
  'between-newmatch': { says: 'Between games, somebody outside the match is set to Play: Start a new match is offered', me: 'dana', here: four, match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'between' }, scores: { owner: [3_456_780, 3], krobs: [2_100_000, 3], chuck: [990_000, 3] }, result: [['owner', 3_456_780], ['krobs', 2_100_000], ['chuck', 990_000]], series: [['owner', 1, 1], ['krobs', 0, 1], ['chuck', 0, 1]], newMatch: { line: 'Dana plays too. The match that is open ends at Owner 1, Krobs 0, Chuck 0.', warnings: [] }, message: 'You are watching this match: you are in when somebody starts a new match' },
  'match-ended': { says: 'End match was pressed: back in the lobby, with the final standing of the match that ended', me: 'krobs', here: four, watch: ['dana'], matchOver: true, series: [['owner', 1, 1], ['krobs', 0, 1], ['chuck', 0, 1]], lastMatch: { games: 1, standing: [['owner', 1, 3_456_780], ['krobs', 0, 2_100_000], ['chuck', 0, 990_000]] }, message: 'Match over after 1 game · Owner 1 win, Krobs 0, Chuck 0 · Owner starts the match from their table. To start it yourself: Start match in the menu' },

  // ---- away
  'waited-for': { says: "Chuck's link dropped during Krobs' ball; that ball has ended and the game waits for Chuck: the lobby's PC can play on without him", me: 'owner', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, phase: 'paused', up: null, flags: { chuck: ['away'] }, awaySince: { chuck: 75 }, scores: { owner: [1_234_560, 1], krobs: [987_650, 1] }, waitedFor: 'chuck', giveUp: true, message: "The game waits at Chuck's turn until they are back. Play on without Chuck takes them out of this game", locked: true },
  'away-question': { says: "The player who is up is out of reach and still seen playing: the question on the lobby's PC", me: 'owner', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, phase: 'paused', up: 'krobs', ball: 1, flags: { krobs: ['away'] }, awaySince: { krobs: 185 }, scores: { owner: [1_234_560, 1], krobs: [2_345_670, 0] }, waitedFor: 'krobs', giveUp: true, awayQuestion: { who: 'krobs', score: 2_345_670 }, message: 'Krobs is out of reach and still playing. Keep waiting, end their ball, or play on without them: open the menu (Ctrl+Alt+M) or the Match tab', locked: true },
  'host-away': { says: "The lobby's PC is away, seen by a member who is on a ball", me: 'krobs', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 1, flags: { owner: ['away'] }, awaySince: { owner: 108 }, scores: { owner: [1_234_560, 1], krobs: [987_650, 0] }, hostAway: { minutesLeft: 18 }, giveUp: true, endBall: { score: 987_650 }, message: AWAY_LINE(18) },
  'host-kept-quit': { says: "The lobby's PC was quit and kept the lobby, seen by a member between games", me: 'chuck', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'between' }, flags: { owner: ['away'] }, awaySince: { owner: 240 }, scores: { owner: [3_456_780, 3], krobs: [2_100_000, 3], chuck: [990_000, 3] }, result: [['owner', 3_456_780], ['krobs', 2_100_000], ['chuck', 990_000]], series: [['owner', 1, 1], ['krobs', 0, 1], ['chuck', 0, 1]], hostAway: { minutesLeft: 16 }, message: KEPT_LINE(16), locked: true },
  'host-kept-quit-my-ball': { says: "The lobby's PC was quit and kept the lobby, seen by the member whose ball it is", me: 'krobs', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 1, flags: { owner: ['away'] }, awaySince: { owner: 108 }, scores: { owner: [1_234_560, 1], krobs: [987_650, 0] }, hostAway: { minutesLeft: 18 }, giveUp: true, endBall: { score: 987_650 }, message: KEPT_MINE_LINE(18) },
  'lobby-closed': { says: 'The lobby was closed by its owner: what a member reads before the tab goes back to Open / Join', me: 'krobs', here: four, over: true, message: 'The lobby is closed: Owner closed the lobby' },

  // ---- the game somebody gave up
  'given-up-me': { says: 'I gave up a game and it is still on my table: the next game waits for it', me: 'krobs', here: ['owner', 'krobs'], match: { players: ['owner', 'krobs'], game: 1, state: 'between' }, flags: { krobs: ['own_game'] }, balls: 1, scores: { owner: [3_456_780, 1], krobs: [0, 0] }, result: [['owner', 3_456_780], ['krobs', 0]], series: [['owner', 1, 1], ['krobs', 0, 1]], start: START('owner', ['owner', 'krobs'], { newMatch: false, waitsFor: 'own_games', waitsOn: ['krobs'], seconds: null, line: 'Owner starts the next game once the game on your table has ended' }), startWithout: 'Start now: I play that game out at my turn', message: GIVEN_UP_WAIT },
  'given-up-others': { says: 'Krobs gave up a game that is still on his table, seen by the other player', me: 'owner', here: ['owner', 'krobs'], match: { players: ['owner', 'krobs'], game: 1, state: 'between' }, flags: { krobs: ['own_game'] }, balls: 1, scores: { owner: [3_456_780, 1], krobs: [0, 0] }, result: [['owner', 3_456_780], ['krobs', 0]], series: [['owner', 1, 1], ['krobs', 0, 1]], start: START('owner', ['owner', 'krobs'], { newMatch: false, waitsFor: 'own_games', waitsOn: ['krobs'], seconds: null, line: "You start the next game once the game on Krobs' table has ended" }), startWithout: 'Start without Krobs', message: "You start the next game once the game on Krobs' table has ended" },

  // ---- the table changes
  'table-changing': { says: "Krobs changed the table: every PC is on its way to it, each row in its own state; this PC is closing its table", me: 'owner', here: four, flags: ON_THE_WAY, table: { ...PICKED, changing: true }, change: CLOSING, message: CLOSING.detail },
  'table-close-it': { says: 'The table was changed and this PC has to close the table that is open on it', me: 'chuck', here: four, flags: ON_THE_WAY, table: { ...PICKED, changing: true }, change: CLOSE_IT, message: CLOSE_IT.detail },
  'table-open-it': { says: 'The table was changed for the fourth time in a few minutes: this PC asks before it changes tables again (Open it)', me: 'dana', here: four, flags: ON_THE_WAY, table: { ...PICKED, changing: true }, change: ASKS_OFTEN, message: ON_PANEL(ASKS_OFTEN.detail) },
  'table-asked-after-away': { says: 'The table was changed while this PC was away from the lobby: it is offered, never opened by itself (Open it)', me: 'dana', here: four, flags: { dana: ['asked'] }, table: { ...PICKED, changing: false }, change: ASKS_AWAY, message: ON_PANEL(ASKS_AWAY.detail) },
  'table-one-asked': { says: 'Everybody has the new table open but one PC, which was asked: nobody is closing or opening, so the header is the lobby again', me: 'owner', here: four, flags: { dana: ['asked'] }, table: { ...PICKED, changing: false }, message: "Waiting for Dana to open the lobby's table. A start waits for them (start a game on your table, or Start match in the menu)" },
  'other-table': { says: "A member has another table open than the lobby's", me: 'owner', here: four, flags: { chuck: ['other_table'] }, message: 'Everyone in? Start a game on your table (or Start match in the menu) · different table file: Chuck' },
  'offer-other-table': { says: "A member has another table open than the lobby's: the lobby's table is offered (Open it), and their row says so", me: 'dana', here: four, open: OTHER_TABLE, flags: { dana: ['asked'] }, change: OFFER_OTHER, message: ON_PANEL(OFFER_OTHER.detail) },
  'offer-nothing-open': { says: "A member joined by the code with no table open: the lobby's table is offered (Open it)", me: 'krobs', here: four, open: null, flags: { krobs: ['asked'] }, change: OFFER_NONE, message: ON_PANEL(OFFER_NONE.detail) },
  'no-table-yet': { says: 'A lobby opened with "No table: I open it myself": it has no table yet, and anyone can pick the first', me: 'krobs', here: ['owner', 'krobs'], open: null, flags: { owner: ['loading'], krobs: ['loading'] }, table: { name: null, pickedBy: null, pickedByName: null, endsMatch: false, changing: false }, message: 'The lobby has no table yet: pick one, see the Match tab' },
};

// ---- a name of 64 characters without a space (the longest the name field takes), in the states where a name is
// part of a header, a sentence, a row with something beside it, and a button. Each is the fixture it names with
// Krobs' name replaced: whole in his row, cut where a sentence has it (as the controller's `nameOf` cuts it).
export const LONG_NAME = 'Krobs'.padEnd(64, 'wxyz');
for (const [name, from, says] of [
  ['long-four', 'four-starter', 'Four people, one with a name of 64 characters'],
  ['long-game', 'game-waiting', 'A game in play; the player who is up has a name of 64 characters'],
  ['long-away-question', 'away-question', "The question on the lobby's PC about a player with a name of 64 characters"],
  ['long-between', 'between', 'Between games; one player has a name of 64 characters'],
] as const) {
  const copy = JSON.parse(JSON.stringify(FIXTURES[from]).split('Krobs').join(shown(LONG_NAME))) as Fixture;
  FIXTURES[name] = { ...copy, says, names: { krobs: LONG_NAME } };
}
