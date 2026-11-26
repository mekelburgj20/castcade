/**
 * A17 step 6 (2026-11-25): the lobby scenarios of asking and of dropping. Scripted members ask for a match from a
 * button and from a table, at the same moment, press again to start without somebody; the lobby's PC ends a match
 * for everyone; and links drop and come back: a watcher's, a waiting player's, the player's who is up, across a
 * match's end, and with the RECONNECT sent a second time. The drops run on real time with short waits (a grace of
 * 20 ms, a turn clock of 80 ms) over links that can be cut (`TapTransport`); the clocks themselves, minute by minute,
 * are `companion/src/match/lobby-away.test.ts`. What must hold after every one of them is `lobbyProblems`.
 */
import { describe, expect, it } from 'vitest';
import type { AnyMessage, PlayerId } from '@castcade/protocol';
import { MemoryBus, type HostMatch, type Transport } from '@castcade/companion';
import { TapTransport, type RecordedFrame } from '../../companion/src/match/lobby-off.test-support.js';
import { lobbyProblems, runLobbyScenario, type LobbyRun, type RunLobbyOptions } from './lobby.js';
import { loadScenario, type Scenario } from './scenario.js';

/** Links that can drop: every player on a `TapTransport` over one bus, and how the runner cuts and mends one. */
function links(scenario: Scenario): { frames: RecordedFrame[]; opts: Pick<RunLobbyOptions, 'transportOf' | 'links' | 'disconnectGraceMs' | 'reconnect'> } {
  const bus = new MemoryBus();
  const taps = new Map<PlayerId, TapTransport>();
  const frames: RecordedFrame[] = [];
  for (const p of scenario.players) new TapTransport(bus.transport(p.playerId), bus, taps, frames);
  const tap = (id: PlayerId): TapTransport => {
    const t = taps.get(id);
    if (!t) throw new Error(`no link for ${id}`);
    return t;
  };
  return {
    frames,
    opts: {
      transportOf: (id): Transport => tap(id),
      links: {
        cut: (id) => {
          tap(id).unreachable = true;
          tap(id).cut(scenario.host);
        },
        mend: (id) => {
          tap(id).unreachable = false;
        },
      },
      disconnectGraceMs: 20,
      reconnect: { delayMs: 5 },
    },
  };
}

const logTypes = (run: LobbyRun, match = 0): string[] => (run.outcomes[run.scenario.host]?.matches[match]?.log?.entries() ?? []).map((e) => `${e.message?.type}${e.message?.type === 'PAUSE' ? ` ${e.message.payload.player}` : ''}`);

describe('lobby scenarios: asking for a start (A17 step 6)', () => {
  it('lobby-start-by-client: a client asks from a button, everyone sees the start with their name, and they go first', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-start-by-client'));
    expect(lobbyProblems(run)).toEqual([]);
    const m = run.outcomes['p1']?.matches[0];
    expect(m?.ready.playerOrder).toEqual(['p2', 'p1']);
    expect(m?.results.map((r) => r.result.game)).toEqual([1, 2]);
    const next = m?.log?.entries().flatMap((e) => (e.message?.type === 'NEXT_GAME' ? [e.message.payload.playerOrder] : []));
    expect(next).toEqual([['p2', 'p1']]);
    // Every member was told both starts, counting down, with the asker's name; the watcher among them.
    for (const id of ['p1', 'p2', 'p3']) expect(run.outcomes[id]?.starts, id).toEqual(['p2:p2,p1:new:countdown', 'p2:p2,p1:next:countdown']);
    expect(run.outcomes['p2']?.sent['START_REQUEST']).toBe(2);
    expect(run.outcomes['p3']?.sent['START_REQUEST']).toBeUndefined();
    expect(run.outcomes['p1']?.refusals).toEqual([]);
  });

  it('lobby-start-from-starter-table: only the starter`s game on a table is a request', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-start-from-starter-table'));
    expect(lobbyProblems(run, { rejects: ['p3'] })).toEqual([]);
    expect(run.outcomes['p1']?.matches[0]?.ready.playerOrder).toEqual(['p1', 'p2', 'p3']);
    expect(run.outcomes['p3']?.rejects.map((r) => [r.refType, r.message])).toEqual([['START_REQUEST', 'Only Lobby PC starts a match from the table. To start it yourself, use Start in the menu.']]);
    expect(run.outcomes['p2']?.starts).toEqual(['p1:p1,p2,p3:new:countdown']);
    expect(run.outcomes['p1']?.matches).toHaveLength(1);
  });

  it('lobby-two-starts: a button and the starter`s table in the same moment: one match, the starter first', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-two-starts'));
    expect(lobbyProblems(run)).toEqual([]);
    const h = run.outcomes['p1'];
    expect(h?.matches).toHaveLength(1);
    expect(h?.matches[0]?.ready.playerOrder).toEqual(['p1', 'p2', 'p3']);
    // One start, asked by the client; the starter's table moved the starter to the front of it.
    expect(run.outcomes['p3']?.starts).toEqual(['p2:p2,p1,p3:new:countdown', 'p2:p1,p2,p3:new:countdown']);
    expect(h?.matches[0]?.log?.entries().filter((e) => e.message?.type === 'MATCH_READY')).toHaveLength(1);
  });

  it('lobby-start-without: the start waits for a table that is not open; a second press starts without that person', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-start-without'));
    expect(lobbyProblems(run)).toEqual([]);
    expect(run.outcomes['p1']?.matches[0]?.ready.playerOrder).toEqual(['p1', 'p2']);
    expect(run.outcomes['p3']?.starts).toEqual(['p1:p1,p2,p3:new:tables', 'p1:p1,p2:new:countdown']);
    // The one left out is still in the lobby, holds the match's log as a watcher, and played nothing.
    expect(run.outcomes['p3']?.matches[0]?.head).toEqual(run.outcomes['p1']?.matches[0]?.head);
    expect(run.outcomes['p3']?.sent['BALL_END']).toBeUndefined();
    expect(run.outcomes['p3']?.lobby?.loading).toEqual(['p3']);
  });

  it('lobby-ended-for-everyone: no RESULT for the game that was being played, the tally unchanged, and the lobby goes on', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-ended-for-everyone'));
    expect(lobbyProblems(run)).toEqual([]);
    for (const id of ['p1', 'p2']) {
      const [m1, m2] = run.outcomes[id]?.matches ?? [];
      expect(m1?.end, id).toEqual({ games: 1, reason: 'ended for everyone', abandoned: 2 });
      expect(m1?.results.map((r) => r.result.game), id).toEqual([1]);
      expect(m1?.results[0]?.result.series.map((s) => [s.playerId, s.games, s.wins]), id).toEqual([
        ['p1', 1, 0],
        ['p2', 1, 1],
      ]);
      expect(m2?.matchId, id).toBe('ENDALL-2');
      expect(m2?.results).toHaveLength(1);
    }
    // The log stops in the middle of game 2: its NEXT_GAME and two grants, and no end of anybody's game after them.
    const types = logTypes(run);
    expect(types.slice(types.indexOf('NEXT_GAME'))).toEqual(['NEXT_GAME', 'TURN_GRANT', 'BALL_END', 'TURN_GRANT']);
    expect(types).not.toContain('FORFEIT');
    expect(run.outcomes['p1']?.sent['RESULT']).toBe(2);
  });
});

describe('lobby scenarios: links that drop (A17 step 6)', () => {
  it('lobby-watcher-drops: no player sees anything; the watcher comes back by itself and holds the same log', async () => {
    const scenario = loadScenario('lobby-watcher-drops');
    const l = links(scenario);
    const run = await runLobbyScenario(scenario, l.opts);
    expect(lobbyProblems(run)).toEqual([]);
    for (const id of ['p1', 'p2', 'p3']) expect(run.outcomes[id]?.pauses, id).toEqual([]);
    expect(logTypes(run).filter((t) => t.startsWith('PAUSE') || t === 'FORFEIT')).toEqual([]);
    expect(run.outcomes['p3']?.reconnects.length).toBe(1);
    expect(run.outcomes['p3']?.rejoins).toBe(0);
    expect(run.outcomes['p1']?.matches[0]?.results.map((r) => r.result.entries.map((e) => e.status))).toEqual([
      ['finished', 'finished'],
      ['finished', 'finished'],
    ]);
  });

  it('lobby-waiting-player-drops: nothing pauses during another player`s ball; at their turn the game waits, then goes on without them', async () => {
    const scenario = loadScenario('lobby-waiting-player-drops');
    const l = links(scenario);
    const run = await runLobbyScenario(scenario, l.opts);
    expect(lobbyProblems(run)).toEqual([]);
    const types = logTypes(run);
    // One pause, for the player who was away, and it comes only after the two balls before their turn.
    expect(types.filter((t) => t.startsWith('PAUSE'))).toEqual(['PAUSE p3']);
    expect(types.slice(0, types.indexOf('PAUSE p3'))).toEqual(['MATCH_READY', 'TURN_GRANT', 'BALL_END', 'TURN_GRANT', 'BALL_END']);
    expect(types.slice(types.indexOf('PAUSE p3'), types.indexOf('PAUSE p3') + 4)).toEqual(['PAUSE p3', 'FORFEIT', 'RESUME', 'TURN_GRANT']);
    const result = run.outcomes['p1']?.matches[0]?.results[0]?.result;
    expect(result?.entries.map((e) => [e.playerId, e.status])).toEqual([
      ['p1', 'finished'],
      ['p2', 'finished'],
      ['p3', 'disconnected'],
    ]);
    expect(result?.signatures.map((s) => s.playerId)).toEqual(['p2']);
    // They are back, by RECONNECT, and hold the whole log of the game they are out of.
    expect(run.outcomes['p3']?.reconnects.length).toBe(1);
    expect(run.outcomes['p3']?.matches[0]?.head).toEqual(run.outcomes['p1']?.matches[0]?.head);
    expect(run.outcomes['p3']?.sent['BALL_END']).toBeUndefined();
  });

  it('lobby-player-up-drops: the pause at their own turn, their return, the ball end reported once, nobody forfeited', async () => {
    const scenario = loadScenario('lobby-player-up-drops');
    const l = links(scenario);
    const run = await runLobbyScenario(scenario, l.opts);
    expect(lobbyProblems(run)).toEqual([]);
    const types = logTypes(run);
    expect(types.filter((t) => t.startsWith('PAUSE'))).toEqual(['PAUSE p2']);
    expect(types).not.toContain('FORFEIT');
    expect(types.filter((t) => t === 'RESUME')).toHaveLength(1);
    // The watcher saw the pause as everyone did.
    expect(run.outcomes['p3']?.pauses).toEqual(['disconnect p2']);
    const log = run.outcomes['p1']?.matches[0]?.log;
    const ends = log?.entries().flatMap((e) => (e.message?.type === 'BALL_END' && e.from === 'p2' ? [e.message.payload.ballNumber] : []));
    expect(ends).toEqual([1, 2]);
    expect(run.outcomes['p1']?.matches[0]?.results[0]?.result.entries.map((e) => [e.playerId, e.score, e.status])).toEqual([
      ['p1', 2000, 'finished'],
      ['p2', 3000, 'finished'],
    ]);
    expect(run.outcomes['p2']?.sent['RESUME']).toBe(1);
  });

  it('lobby-rejoin-other-match: back during the next match: the old match brought to its end, then the open one whole', async () => {
    const scenario = loadScenario('lobby-rejoin-other-match');
    const l = links(scenario);
    const run = await runLobbyScenario(scenario, l.opts);
    expect(lobbyProblems(run)).toEqual([]);
    const w = run.outcomes['p3'];
    const acks = l.frames.filter((f) => f.by === 'p1' && f.to === 'p3').map((f) => JSON.parse(f.frame) as AnyMessage).filter((m) => m.type === 'RECONNECT_ACK');
    expect(acks.map((m) => m.type === 'RECONNECT_ACK' && [m.payload.accept, m.payload.closed, m.payload.match])).toEqual([[true, true, 'REJOIN-2']]);
    // The match it was away for ended as it ended for everyone: the real MATCH_END, the same RESULT, the same log.
    expect(w?.matches.map((m) => [m.matchId, m.end?.reason])).toEqual([
      ['REJOIN-1', 'match 1 is over'],
      ['REJOIN-2', 'match 2 is over'],
    ]);
    expect(w?.caughtUp.map((c) => c.match)).toEqual(['REJOIN-2']);
    expect(w?.matches[0]?.head).toEqual(run.outcomes['p1']?.matches[0]?.head);
    expect(w?.matches[0]?.results.map((r) => r.result)).toEqual(run.outcomes['p1']?.matches[0]?.results.map((r) => r.result));
    expect(w?.matches[1]?.head).toEqual(run.outcomes['p1']?.matches[1]?.head);
    expect(w?.matches[1]?.results.map((r) => [r.logMatches, r.signatureValid])).toEqual([[true, true]]);
  });

  it('lobby-reconnect-replayed: the same RECONNECT a second time is refused, and nothing about the player changes', async () => {
    const scenario = loadScenario('lobby-reconnect-replayed');
    const l = links(scenario);
    let host: HostMatch | null = null;
    let replayed = 0;
    const run = await runLobbyScenario(scenario, {
      ...l.opts,
      disconnectGraceMs: 2000,
      onPlayers: (players) => {
        host = players.find((p) => p.playerId === 'p1')?.host ?? null;
      },
      onEvent: (player, event) => {
        if (player !== 'p1' || event !== 'reconnected' || replayed > 0) return;
        const sent = l.frames.filter((f) => f.by === 'p2').map((f) => JSON.parse(f.frame) as AnyMessage).find((m) => m.type === 'RECONNECT');
        if (!sent || !host) return;
        replayed += 1;
        // As it arrived, once more.
        (host as HostMatch).handle('p2', sent);
      },
    });
    expect(replayed).toBe(1);
    // The one thing out of the ordinary: the refusal went to the player's own link (there is no other under that
    // name), and the player, who was not asking for anything, let it fall.
    expect(lobbyProblems(run)).toEqual(['p2 dropped frames: RECONNECT_ACK:unexpected']);
    expect(run.outcomes['p1']?.reconnectRejected).toEqual(['p2 stale_seq']);
    expect(run.outcomes['p1']?.reconnects).toEqual(['p2 quiet']);
    expect(run.outcomes['p1']?.lobby?.participants.map((p) => p.playerId)).toEqual(['p1', 'p2']);
    expect(run.outcomes['p1']?.pauses).toEqual([]);
    expect(run.outcomes['p2']?.matches[0]?.head).toEqual(run.outcomes['p1']?.matches[0]?.head);
    expect(run.outcomes['p1']?.matches[0]?.results[0]?.result.entries.map((e) => e.status)).toEqual(['finished', 'finished']);
  });
});
