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

export type Who = 'owner' | 'krobs' | 'chuck' | 'dana';
const NAMES: Record<Who, string> = { owner: 'Owner', krobs: 'Krobs', chuck: 'Chuck', dana: 'Dana' };
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
}

const NOW = Date.now();

/** The `MatchStatus` of a fixture (see main/match-host.ts `status()`), and the `OneStepStatus` beside it. */
export function status(f: Fixture, base: any): { match: any; oneStep: any } {
  const here = f.here ?? [];
  const inLobby = here.length > 0;
  const watch = new Set(f.watch ?? []);
  const m = f.match ?? null;
  const phase = f.phase ?? (m ? (m.state === 'game' ? 'playing' : 'over') : 'lobby');
  const playing = phase === 'playing' || phase === 'paused';
  const starter = m ? (m.players[0] ?? null) : (here.find((w) => !watch.has(w) && !(f.flags?.[w] ?? []).includes('away')) ?? null);
  const members = here.map((w) => ({
    id: w,
    name: NAMES[w],
    rig: RIGS[w],
    stance: watch.has(w) ? 'watch' : 'play',
    opener: w === 'owner',
    me: w === f.me,
    starter: w === starter,
    inMatch: m ? m.players.includes(w) : false,
    flags: f.flags?.[w] ?? [],
    awaySince: f.awaySince?.[w] !== undefined ? NOW - (f.awaySince[w] as number) * 1000 : (f.flags?.[w] ?? []).includes('away') ? NOW - 42_000 : null,
  }));
  const players = (m ? m.players : []).map((w) => ({
    id: w,
    name: NAMES[w],
    score: f.scores?.[w]?.[0] ?? (playing ? 0 : null),
    ballsDone: f.scores?.[w]?.[1] ?? 0,
    isUp: playing && f.up === w,
    flags: (f.flags?.[w] ?? []).includes('away') ? ['disconnected'] : [],
  }));
  const gameKey = m ? `${CODE}-1/${m.game}/${m.state}` : '';
  const between = phase === 'over' && m !== null;
  const playSet = here.filter((w) => !watch.has(w) && !(f.flags?.[w] ?? []).some((x) => x === 'away' || x === 'no_table'));
  const names = (ws: Who[]): string => {
    const n = ws.map((w) => NAMES[w]);
    return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  };
  const watchers = here.filter((w) => watch.has(w));
  const defaultLine = between
    ? `Game ${(m?.game ?? 1) + 1} of this match.${f.series ? ` ${f.series.map(([w, wins], i) => `${NAMES[w]} ${wins}${i === 0 ? (wins === 1 ? ' win' : ' wins') : ''}`).join(', ')}.` : ''}`
    : playSet.length >= 2
      ? `${names(playSet)} play.${watchers.length > 0 ? ` ${names(watchers)} ${watchers.length === 1 ? 'watches' : 'watch'}.` : ''}`
      : '';
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
                : null;
  const lobby = inLobby
    ? {
        stance: watch.has(f.me) ? 'watch' : 'play',
        starter,
        members,
        match: m ? { id: `${CODE}-1`, game: m.game, state: m.state, players: m.players } : null,
        table: { name: TABLE, pickedBy: 'owner', pickedByName: 'Owner', off: playing ? 'A game is being played: the table can be changed when it is over.' : null, endsMatch: m !== null, changing: false, ...(f.table ?? {}) },
        start: f.start ?? null,
        startButton: { label: between ? 'Next game' : 'Start match', line: f.startLine ?? defaultLine, off },
        newMatch: f.newMatch ?? null,
        gameKey,
        startWithout: f.startWithout ?? null,
        end: f.over || f.hostAway ? null : between ? 'match' : playing && f.me === 'owner' ? 'everyone' : null,
        giveUp: f.giveUp ?? false,
        hostAway: f.hostAway ? { since: NOW - (20 - f.hostAway.minutesLeft) * 60_000, until: NOW + f.hostAway.minutesLeft * 60_000 } : null,
        over: f.over ?? false,
        waitedFor: f.waitedFor ? { player: f.waitedFor, name: NAMES[f.waitedFor], minutes: 1 } : null,
        awayQuestion: f.awayQuestion ? { player: f.awayQuestion.who, name: NAMES[f.awayQuestion.who], minutes: 3, score: f.awayQuestion.score } : null,
      }
    : null;
  const panel = inLobby
    ? {
        playerUp: playing ? (f.up ?? null) : null,
        myTurn: playing && f.up === f.me,
        ball: playing ? (f.ball ?? 1) : null,
        ballsPerGame: 3,
        players: m ? players : [],
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
    participants: here.map((w) => ({ id: w, name: NAMES[w], rig: RIGS[w], tableMatch: true, tableNote: null, buildMatch: true, ballEnds: true })),
    lobby,
    startWarnings: f.startWarnings ?? [],
    wait3d: { players: [], seconds: 0, armed: null },
    advisories: f.advisories ?? [],
    pass: playing && host && f.up && f.up !== 'owner' ? { name: NAMES[f.up], ball: f.ball ?? 1, score: f.scores?.[f.up]?.[0] ?? 0 } : null,
    endBall: f.endBall ? { grantSeq: 7, ball: f.ball ?? 1, score: f.endBall.score, tableBall: false } : null,
    series: m ? { game: m.game, over: f.over ?? false, nextGameBlocker: null } : null,
    panel,
    media: inLobby ? { attached: true, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null } : null,
    locked: f.locked ?? false,
    settings: { ...base.settings, displayName: NAMES[f.me], stance: watch.has(f.me) ? 'watch' : 'play' },
    defaultName: NAMES[f.me],
    lastError: f.lastError ?? null,
    resume: f.resume ?? null,
  };
  const oneStep = {
    link: inLobby && f.via !== 'direct' ? LINK : null,
    message: inLobby && f.via !== 'direct' ? `Castcade lobby on ${TABLE}: ${LINK}` : null,
    copied: false,
    pending: f.pending ?? null,
    launch: f.launch ?? { state: 'idle', table: null, detail: null },
    tableToStart: null,
    change: f.change ?? null,
    notice: null,
    attention: 0,
  };
  return { match, oneStep };
}

const four: Who[] = ['owner', 'krobs', 'chuck', 'dana'];
const AWAY_LINE = (left: number, what = 'match'): string => `Owner's PC is away. The ${what} goes on when it is back: waiting up to 20 minutes (${left} min left). You can keep talking; Leave lobby ends the wait for you.`;
const KEPT_LINE = (left: number): string => `Owner closed Castcade and kept the lobby: it goes on if Owner opens Castcade again within 20 minutes (${left} min left). You can wait and keep talking; Leave lobby frees your table now.`;
const GIVEN_UP_WAIT = 'The game you gave up is still on your table, which is yours meanwhile: play it out (it counts for nothing) or restart the table. The next game waits for it';
// While tables are being changed the lobby's line is its ordinary one, with the tables that are not open yet (controller.ts `lobbyLine`).
const CHANGING_LINE = "Owner starts the match from their table. To start it yourself: Start match in the menu · Krobs', Chuck's tables are not open yet";
const START = (by: Who, players: Who[], o: any = {}): any => ({ by, players, newMatch: true, waitsFor: null, waitsOn: [], seconds: 4, line: '', ...o });

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
  'four-starter': { says: 'Four people, two set to Watch, seen by the starter (the owner)', me: 'owner', here: four, watch: ['chuck', 'dana'], message: 'Everyone in? Start a game on your table (or Start match in the menu)' },
  'four-player': { says: 'Four people, seen by another player', me: 'krobs', here: four, watch: ['chuck', 'dana'], message: 'Owner starts the match from their table. To start it yourself: Start match in the menu' },
  'four-watcher': { says: 'Four people, seen by a watcher', me: 'chuck', here: four, watch: ['chuck', 'dana'], message: 'You are set to Watch: the match starts without you' },
  'four-owner-watches': { says: "Four people, the lobby's PC is set to Watch", me: 'owner', here: four, watch: ['owner'], message: 'You are set to Watch: the match starts without you' },
  'full-direct': { says: 'A full lobby over a direct link (address invite, port forward)', me: 'owner', here: four, via: 'direct', message: 'Everyone in? Start a game on your table (or Start match in the menu)' },
  'start-countdown': { says: 'A start counts down, seen by somebody in it', me: 'krobs', here: four, watch: ['dana'], countdown: 4, locked: true, start: START('owner', ['owner', 'krobs', 'chuck'], { line: 'Owner starts the match: Owner, you, Chuck' }), message: 'Owner starts the match: Owner, you, Chuck' },
  'start-waits-table': { says: "A start waits for a player's table to open", me: 'owner', here: four, flags: { chuck: ['loading'] }, start: START('owner', four, { waitsFor: 'tables', waitsOn: ['chuck'], seconds: null, line: "You start the match once Chuck's table is open" }), startWithout: 'Start without Chuck', message: "You start the match once Chuck's table is open" },
  'start-waits-3d': { says: 'A start waits for the 3D connections', me: 'krobs', here: ['owner', 'krobs'], start: START('krobs', ['krobs', 'owner'], { waitsFor: '3d', waitsOn: ['owner'], seconds: null, line: 'You start the match once the 3D connection to Owner is up (45 s at most; started without it, the first turn may be the 2D video)' }), startWithout: 'Start without 3D', message: 'You start the match once the 3D connection to Owner is up (45 s at most; started without it, the first turn may be the 2D video)' },
  'start-held-grace': { says: "A start's countdown ran out and is held for a player whose link dropped a moment ago", me: 'owner', here: ['owner', 'krobs', 'chuck'], countdown: 0, start: START('owner', ['owner', 'krobs', 'chuck'], { seconds: 0, line: "You start the match in a few seconds (a player's link dropped a moment ago: waiting to see whether they are back)" }), message: "You start the match in a few seconds (a player's link dropped a moment ago: waiting to see whether they are back)" },
  'member-away-lobby': { says: 'A member is away in the lobby (the row says since when)', me: 'owner', here: four, flags: { dana: ['away'] }, message: 'Everyone in? Start a game on your table (or Start match in the menu)' },
  'no-table': { says: "A member has no copy of the lobby's table: they are not counted for a start", me: 'dana', here: four, flags: { dana: ['no_table'] }, launch: { state: 'needed', table: TABLE, detail: `The host plays ${TABLE}. Castcade found no copy of it on this PC: open it in VPX if you have it under another name. You stay in the match.` }, message: "Castcade found no copy of the lobby's table on this PC: you can watch" },
  'cannot-save': { says: "The lobby's record cannot be written on this PC", me: 'owner', here: ['owner', 'krobs'], lastError: 'Castcade cannot save this lobby (the folder C:\\Users\\you\\AppData\\Roaming\\Castcade: EPERM: operation not permitted). The lobby goes on. If Castcade closes before it can be saved again, it comes back as it was last saved, or not at all.', message: 'Castcade cannot save this lobby on this PC: see the Match tab' },
  'relay-waiting': { says: "The lobby's PC started again and ArcAid does not answer yet", me: 'owner', here: four, flags: { krobs: [], chuck: [], dana: [] }, relayNote: 'ArcAid is not carrying this lobby yet (it did not answer when Castcade started again). Castcade keeps asking; the others can come back once it does', lastError: `Castcade on this PC started again: the lobby ${CODE} is open again as it was. Castcade is waiting for ArcAid to carry it again: the others can come back once it does.`, message: 'Everyone in? Start a game on your table (or Start match in the menu)' },

  // ---- a game
  'game-up': { says: 'A game in play, seen by the player who is up', me: 'krobs', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 2, scores: { owner: [1_234_560, 2], krobs: [987_650, 1], chuck: [455_000, 1] }, giveUp: true, endBall: { score: 987_650 } },
  'game-waiting': { says: 'A game in play, seen by a player who waits for their turn', me: 'chuck', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 2, scores: { owner: [1_234_560, 2], krobs: [987_650, 1], chuck: [455_000, 1] }, giveUp: true, locked: true },
  'game-watcher': { says: 'A game in play, seen by a watcher', me: 'dana', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 2, scores: { owner: [1_234_560, 2], krobs: [987_650, 1], chuck: [455_000, 1] }, locked: true },
  'game-owner': { says: "A game in play, seen by the lobby's PC (Pass the turn, End match for everyone)", me: 'owner', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 2, scores: { owner: [1_234_560, 2], krobs: [987_650, 1], chuck: [455_000, 1] }, giveUp: true, locked: true },
  'between': { says: 'Between games with the result, seen by the starter of the next game', me: 'owner', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'between' }, scores: { owner: [3_456_780, 3], krobs: [2_100_000, 3], chuck: [990_000, 3] }, result: [['owner', 3_456_780], ['krobs', 2_100_000], ['chuck', 990_000]], series: [['owner', 1, 1], ['krobs', 0, 1], ['chuck', 0, 1]], message: 'Next game: start a game on your table (or Next game in the menu)' },
  'between-newmatch': { says: 'Between games, somebody outside the match is set to Play: Start a new match is offered', me: 'dana', here: four, match: { players: ['owner', 'krobs', 'chuck'], game: 2, state: 'between' }, scores: { owner: [3_456_780, 3], krobs: [2_100_000, 3], chuck: [990_000, 3] }, result: [['owner', 3_456_780], ['krobs', 2_100_000], ['chuck', 990_000]], series: [['owner', 2, 2], ['krobs', 0, 2], ['chuck', 0, 2]], newMatch: { line: 'Dana plays too. The match that is open ends at Owner 2, Krobs 0, Chuck 0.', warnings: [] }, message: 'You are watching this match: you are in when somebody starts a new match' },
  'match-ended': { says: 'End match was pressed: back in the lobby with the tally', me: 'krobs', here: four, watch: ['dana'], message: 'Match over after 2 games · Owner 2 wins, Krobs 0, Chuck 0 · Owner starts the match from their table. To start it yourself: Start match in the menu' },

  // ---- away
  'waited-for': { says: "A waiting player is away at their own turn: the lobby's PC can play on without them", me: 'owner', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, phase: 'paused', up: 'chuck', ball: 1, flags: { chuck: ['away'] }, awaySince: { chuck: 75 }, scores: { owner: [1_234_560, 1], krobs: [987_650, 1], chuck: [0, 0] }, waitedFor: 'chuck', message: 'Waiting for Chuck to come back', locked: true },
  'away-question': { says: "The player who is up is out of reach and still seen playing: the question on the lobby's PC", me: 'owner', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, phase: 'paused', up: 'krobs', ball: 2, flags: { krobs: ['away'] }, awaySince: { krobs: 185 }, scores: { owner: [1_234_560, 2], krobs: [2_345_670, 1], chuck: [455_000, 1] }, waitedFor: 'krobs', awayQuestion: { who: 'krobs', score: 2_345_670 }, message: 'Waiting for Krobs to come back', locked: true },
  'host-away': { says: "The lobby's PC is away, seen by a member who is on a ball", me: 'krobs', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'game' }, up: 'krobs', ball: 2, flags: { owner: ['away'] }, awaySince: { owner: 108 }, scores: { owner: [1_234_560, 2], krobs: [987_650, 1], chuck: [455_000, 1] }, hostAway: { minutesLeft: 18 }, message: AWAY_LINE(18) },
  'host-kept-quit': { says: "The lobby's PC was quit and kept the lobby, seen by a member between games", me: 'chuck', here: four, watch: ['dana'], match: { players: ['owner', 'krobs', 'chuck'], game: 1, state: 'between' }, flags: { owner: ['away'] }, awaySince: { owner: 240 }, scores: { owner: [3_456_780, 3], krobs: [2_100_000, 3], chuck: [990_000, 3] }, result: [['owner', 3_456_780], ['krobs', 2_100_000], ['chuck', 990_000]], series: [['owner', 1, 1], ['krobs', 0, 1], ['chuck', 0, 1]], hostAway: { minutesLeft: 16 }, message: KEPT_LINE(16), locked: true },
  'lobby-closed': { says: 'The lobby was closed by its owner: what a member reads before the tab goes back to Open / Join', me: 'krobs', here: four, over: true, message: 'The lobby is closed: Owner closed the lobby' },

  // ---- the game somebody gave up
  'given-up-me': { says: 'I gave up a game and it is still on my table: the next game waits for it', me: 'krobs', here: ['owner', 'krobs'], match: { players: ['owner', 'krobs'], game: 1, state: 'between' }, flags: { krobs: ['own_game'] }, scores: { owner: [3_456_780, 3], krobs: [50_000, 1] }, result: [['owner', 3_456_780], ['krobs', 50_000]], series: [['owner', 1, 1], ['krobs', 0, 1]], start: START('owner', ['owner', 'krobs'], { newMatch: false, waitsFor: 'own_games', waitsOn: ['krobs'], seconds: null, line: 'Owner starts the next game once the game on your table has ended' }), startWithout: 'Start now: I play that game out at my turn', message: GIVEN_UP_WAIT },
  'given-up-others': { says: 'Krobs gave up a game that is still on his table, seen by the other player', me: 'owner', here: ['owner', 'krobs'], match: { players: ['owner', 'krobs'], game: 1, state: 'between' }, flags: { krobs: ['own_game'] }, scores: { owner: [3_456_780, 3], krobs: [50_000, 1] }, result: [['owner', 3_456_780], ['krobs', 50_000]], series: [['owner', 1, 1], ['krobs', 0, 1]], start: START('owner', ['owner', 'krobs'], { newMatch: false, waitsFor: 'own_games', waitsOn: ['krobs'], seconds: null, line: "You start the next game once the game on Krobs' table has ended" }), startWithout: 'Start without Krobs', message: "You start the next game once the game on Krobs' table has ended" },

  // ---- the table changes
  'table-changing': { says: 'The table was changed: every PC is on its way to it, each row in its own state', me: 'owner', here: four, flags: { krobs: ['changing'], chuck: ['close_table'], dana: ['no_table'] }, table: { name: OTHER_TABLE, pickedBy: 'krobs', pickedByName: 'Krobs', changing: true, endsMatch: false }, message: "Everyone in? Start a game on your table (or Start match in the menu) · Krobs', Chuck's tables are not open yet" },
  'table-close-it': { says: 'The table was changed and this PC has to close the table that is open on it', me: 'chuck', here: four, flags: { krobs: ['changing'], chuck: ['close_table'], dana: ['no_table'] }, table: { name: OTHER_TABLE, pickedBy: 'krobs', pickedByName: 'Krobs', changing: true, endsMatch: false }, change: { state: 'close_it', table: OTHER_TABLE, open: TABLE, detail: `Close the table on this PC: Castcade opens ${OTHER_TABLE} when it is closed.` }, message: CHANGING_LINE },
  'table-open-it': { says: 'The table was changed and this PC asks first (Change tables for me is off): Open it', me: 'dana', here: four, flags: { dana: ['asked'] }, table: { name: OTHER_TABLE, pickedBy: 'krobs', pickedByName: 'Krobs', changing: true, endsMatch: false }, change: { state: 'offered', table: OTHER_TABLE, open: TABLE, detail: `The lobby's table is now ${OTHER_TABLE}. Open it: Castcade closes ${TABLE} and opens ${OTHER_TABLE}.` }, message: CHANGING_LINE },
};

/**
 * The in-game menu's facts for a status, as main/match-host.ts `menuFacts` and `menuLobby` make them from the
 * controller's status (the volumes are the defaults; the scoreboard line is there for a headset during a game).
 */
export function menuFacts(st: any): any {
  const l = st.lobby;
  if (!l) return null;
  const playing = st.phase === 'playing' || st.phase === 'paused';
  return {
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
    lobby: {
      opener: st.role === 'host',
      stance: l.stance,
      start: { label: l.startButton.label, off: l.startButton.off },
      announced: l.start ? { without: l.startWithout } : null,
      newMatch: l.newMatch ? { warnings: l.newMatch.warnings } : null,
      game: l.gameKey,
      hostAway: l.hostAway !== null,
      over: l.over,
      end: l.end,
      giveUp: l.giveUp,
      waitedFor: l.waitedFor?.name ?? null,
      awayQuestion: l.awayQuestion ? { name: l.awayQuestion.name, score: l.awayQuestion.score } : null,
    },
  };
}
