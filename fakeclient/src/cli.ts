#!/usr/bin/env node
/**
 * fakeclient CLI.
 *   fakeclient local --players 4 --balls 3 [--transfer | --host-left] [--scenario name|file] [--ball-ms 20]
 *   fakeclient host  --players N --balls B --port P [--player p1] [--match ID] [--table-hash H] [--scores a,b,c]
 *   fakeclient join  ws://127.0.0.1:P --player p2 [--match ID] [--table-hash H] [--scores a,b,c] [--balls B]
 * Prints the RESULT (and, for `local`, every participant's log head) as JSON. Exit 1 on refuse or timeout.
 */
import { parseArgs } from 'node:util';
import { WsClientTransport, WsHostTransport } from '@castcade/companion';
import { FakePlayer, runLocalScenario } from './lib.js';
import { defaultScores, generateScenario, loadScenario, type PlayerScript, type Scenario } from './scenario.js';

const USAGE = `usage:
  fakeclient local --players 4 --balls 3 [--transfer | --host-left] [--scenario name|file] [--ball-ms 20]
  fakeclient host  --players N --balls B --port P [--player p1] [--match ID] [--table-hash H] [--scores a,b,c]
  fakeclient join  ws://host:port --player p2 [--match ID] [--table-hash H] [--scores a,b,c] [--balls B]`;

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return n;
}

function scoresArg(v: string | undefined, playerId: string, balls: number): number[] {
  if (!v) return defaultScores(playerId, balls);
  return v.split(',').map((x) => Number(x.trim()));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      players: { type: 'string' },
      balls: { type: 'string' },
      port: { type: 'string' },
      player: { type: 'string' },
      match: { type: 'string' },
      scenario: { type: 'string' },
      'table-hash': { type: 'string' },
      scores: { type: 'string' },
      'ball-ms': { type: 'string' },
      timeout: { type: 'string' },
      transfer: { type: 'boolean' },
      'host-left': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const ballMs = num(values['ball-ms'], 20);
  const timeoutMs = num(values.timeout, 10 * 60 * 1000);

  if (command === 'local') {
    const scenario: Scenario = values.scenario
      ? loadScenario(values.scenario)
      : generateScenario({
          players: num(values.players, 4),
          ballsPerGame: num(values.balls, 3),
          matchId: values.match,
          transfer: values['host-left'] ? 'host_left' : values.transfer ? 'host_requested' : null,
        });
    const run = await runLocalScenario(scenario, { ballMs, timeoutMs });
    const finalHost = Object.values(run.outcomes).find((o) => o.result && o.rolesHeld[o.rolesHeld.length - 1] === 'host');
    const out = {
      scenario: scenario.name,
      result: finalHost?.result ?? null,
      logHeads: Object.fromEntries(Object.values(run.outcomes).map((o) => [o.playerId, { ...o.logHead, left: o.left, refused: o.refused?.code ?? null }])),
      grants: Object.values(run.outcomes).flatMap((o) => o.issuedGrants.map((g) => `${o.playerId}:${g.player}b${g.ballNumber}#${g.grantSeq}`)),
      rejects: Object.fromEntries(Object.values(run.outcomes).map((o) => [o.playerId, o.rejects.map((r) => r.code)])),
    };
    console.log(JSON.stringify(out, null, 2));
    return finalHost?.result ? 0 : 1;
  }

  if (command === 'host') {
    const players = num(values.players, 2);
    const balls = num(values.balls, 3);
    const playerId = values.player ?? 'p1';
    const scenario = generateScenario({ players, ballsPerGame: balls, matchId: values.match ?? 'LOCAL-1', hostId: playerId });
    const script: PlayerScript = { playerId, scores: scoresArg(values.scores, playerId, balls) };
    if (values['table-hash']) script.game = { tableHash: values['table-hash'] };
    scenario.players = [script];
    const transport = new WsHostTransport({ localId: playerId, port: num(values.port, 7777) });
    const port = await transport.listen();
    console.error(`fakeclient host ${playerId}: listening on ws://127.0.0.1:${port}, waiting for ${players - 1} player(s)`);
    const player = new FakePlayer({ role: 'host', transport, script, scenario, ballMs, expectedJoins: players - 1 });
    try {
      const outcome = await withTimeout(player.done, timeoutMs, 'match');
      console.log(JSON.stringify({ result: outcome.result, logHead: outcome.logHead }, null, 2));
      return outcome.result ? 0 : 1;
    } finally {
      transport.close();
    }
  }

  if (command === 'join') {
    if (!target || !values.player) throw new Error(USAGE);
    const playerId = values.player;
    const balls = num(values.balls, 3);
    const scenario = generateScenario({ players: 2, ballsPerGame: balls, matchId: values.match ?? 'LOCAL-1', hostId: 'host' });
    const script: PlayerScript = { playerId, scores: scoresArg(values.scores, playerId, balls) };
    if (values['table-hash']) script.game = { tableHash: values['table-hash'] };
    scenario.players = [{ playerId: 'host', scores: [] }, script];
    const transport = new WsClientTransport({ localId: playerId, url: target });
    await transport.connect();
    const player = new FakePlayer({ role: 'client', transport, script, scenario, ballMs });
    player.start();
    try {
      const outcome = await withTimeout(player.done, timeoutMs, 'match');
      if (outcome.refused) {
        console.error(`refused: ${outcome.refused.code}: ${outcome.refused.message}`);
        console.log(JSON.stringify({ refused: outcome.refused }, null, 2));
        return 1;
      }
      console.log(JSON.stringify({ result: outcome.result, logHead: outcome.logHead, resultInfo: outcome.resultInfo }, null, 2));
      return outcome.result ? 0 : 1;
    } finally {
      transport.close();
    }
  }

  console.error(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
