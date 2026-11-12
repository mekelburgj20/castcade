/**
 * The rendered sidecars under the real VBScript engine (Windows Script Host, the engine VPX runs table scripts with),
 * without VPX: every recipe's sidecar COMPILES (`vpx-hook/spike/vbs-compile.vbs`, which runs none of it), and the
 * synthetic tables of the C1.4 overrides are DRIVEN through a game with the real `castcade.vbs`, their journal read
 * back and judged by `checkGameJournal`. Windows only: skipped where `cscript.exe` does not exist (the Linux CI job).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyScript } from './classify.js';
import { renderSidecar } from './render-originals.js';
import {
  BURGER_BALLS_B_SCRIPT,
  BURGER_B_SCRIPT,
  DIABLO_B_SCRIPT,
  FUTURAMA_B_SCRIPT,
  GLF_B_SCRIPT,
  JACKS_B_SCRIPT,
  JPSALAS_B_SCRIPT,
  RATTLECAN_B_SCRIPT,
  RATTLECAN_TILT_B_SCRIPT,
  SCORBIT_C_SCRIPT,
  SCORESERVER_D_SCRIPT,
  VPM_SCRIPT,
  crlf,
  noFinalNewline,
} from './test-scripts.test-support.js';
import { checkGameJournal } from './validate.js';

const CSCRIPT = process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cscript.exe') : '';
const haveCscript = CSCRIPT !== '' && existsSync(CSCRIPT);
const HOOK = fileURLToPath(new URL('../../../vpx-hook/', import.meta.url));
const COMPILE = join(HOOK, 'spike', 'vbs-compile.vbs');
const LIB = join(HOOK, 'castcade.vbs');

const dir = haveCscript ? mkdtempSync(join(tmpdir(), 'castcade-cscript-')) : '';
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const cscript = (args: string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string } => {
  try {
    return { code: 0, out: execFileSync(CSCRIPT, ['//nologo', ...args], { encoding: 'latin1', env, timeout: 30_000 }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

/** Render `text` for a table named `id` and write the sidecar into the scratch folder. */
const sidecarFile = (id: string, text: string): string => {
  const path = join(dir, `${id}.vbs`);
  const r = renderSidecar(text, classifyScript(text), { tableId: id, rom: null, originalPath: join(dir, `${id}.vpx`), originalSize: 1, originalMtimeMs: 0, sidecarPath: path });
  writeFileSync(path, r.bytes);
  return path;
};

const vbs = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * Run the sidecar of `script` as VPX would (the host's `GetTextFile` hands it the real library; `host` declares what
 * the table expects from VPX), then `drive` it. Returns the journal's events without their `t`.
 */
const play = (id: string, script: readonly string[], host: string[], drive: string[]): { out: string; lines: string[]; events: Record<string, unknown>[] } => {
  const sidecar = sidecarFile(id, crlf(script));
  const local = join(dir, `${id}-localappdata`);
  mkdirSync(local, { recursive: true });
  const harness = join(dir, `${id}-harness.vbs`);
  writeFileSync(
    harness,
    [
      'Class HostThing',
      '    Public enabled',
      '    Private m_text',
      '    Public Property Get Text : Text = m_text : End Property',
      '    Public Property Let Text(v) : m_text = CStr(v) : End Property',
      'End Class',
      'Dim StartGameKey : StartGameKey = 2',
      ...host,
      'Function GetTextFile(name)',
      `    GetTextFile = CreateObject("Scripting.FileSystemObject").OpenTextFile(${vbs(LIB)}, 1, False, 0).ReadAll`,
      'End Function',
      `ExecuteGlobal CreateObject("Scripting.FileSystemObject").OpenTextFile(${vbs(sidecar)}, 1, False, 0).ReadAll`,
      ...drive,
      'WScript.Echo "driven"',
    ].join('\r\n') + '\r\n',
  );
  const { out } = cscript([harness], { ...process.env, LOCALAPPDATA: local });
  const journal = join(local, 'Castcade', 'journal', `${id}.jsonl`);
  const lines = existsSync(journal) ? readFileSync(journal, 'latin1').split(/\r?\n/).filter((l) => l !== '') : [];
  const events = lines.map((l) => {
    const { t: _t, ...rest } = JSON.parse(l) as Record<string, unknown>;
    return rest;
  });
  return { out, lines, events };
};

const game = (events: Record<string, unknown>[]): Record<string, unknown>[] => events.filter((e) => ['game_start', 'current_scores', 'ball_end', 'game_end'].includes(String(e['event'])));

describe.skipIf(!haveCscript)('rendered sidecars under the Windows VBScript engine', () => {
  it('vbs-compile.vbs reports a syntax error, passes a script that compiles, and runs neither', () => {
    const bad = join(dir, 'bad.vbs');
    const ran = join(dir, 'ran.txt');
    writeFileSync(bad, ['Option Explicit', 'Dim a', `CreateObject("Scripting.FileSystemObject").CreateTextFile ${vbs(ran)}`, 'Sub X()', '    If a Then', '    a = 1', 'End Sub', ''].join('\r\n'));
    expect(cscript([COMPILE, bad])).toEqual({ code: 1, out: expect.stringMatching(/^SYNTAX .*compilation error 1012: Expected 'If'/) });
    const good = join(dir, 'good.vbs');
    writeFileSync(good, ['Option Explicit', 'Dim a', `CreateObject("Scripting.FileSystemObject").CreateTextFile ${vbs(ran)}`, 'Sub X()', '    If a Then', '    a = 1', '    End If', 'End Sub', ''].join('\r\n'));
    expect(cscript([COMPILE, good])).toEqual({ code: 0, out: expect.stringMatching(/^OK /) });
    expect(existsSync(ran)).toBe(false);
  });

  it('the sidecar of every recipe and every fixture shape compiles', () => {
    const scripts: Record<string, readonly string[]> = {
      VPM_SCRIPT,
      JPSALAS_B_SCRIPT,
      DIABLO_B_SCRIPT,
      JACKS_B_SCRIPT,
      FUTURAMA_B_SCRIPT,
      RATTLECAN_B_SCRIPT,
      RATTLECAN_TILT_B_SCRIPT,
      BURGER_B_SCRIPT,
      BURGER_BALLS_B_SCRIPT,
      GLF_B_SCRIPT,
      SCORBIT_C_SCRIPT,
      SCORESERVER_D_SCRIPT,
    };
    for (const [name, script] of Object.entries(scripts)) {
      for (const [shape, text] of [['crlf', crlf(script)], ['no-final-newline', noFinalNewline(script)]] as const) {
        const r = cscript([COMPILE, sidecarFile(`${name}-${shape}`, text)]);
        expect(r.out.trim(), `${name} ${shape}`).toMatch(/^OK /);
        expect(r.code).toBe(0);
      }
    }
  });

  it('GLF (Dark Chaos): a three-ball game with a shoot-again journals start, scores, four ball ends and one game end', () => {
    const { out, lines, events } = play(
      'glf-game',
      GLF_B_SCRIPT,
      [],
      [
        'Table1_KeyDown StartGameKey',
        'Table1_KeyDown StartGameKey', // a second Start press while the game runs starts nothing
        'SetPlayerState "score", 100',
        'SetPlayerState "some_mode_progress", 3', // any other player variable journals nothing
        'Glf_EndOfBall Null',
        'SetPlayerState "score", 250',
        'SetPlayerState "extra_balls", 1',
        'Glf_EndOfBall Null', // the extra ball: same player, same ball
        'Glf_EndOfBall Null',
        'SetPlayerState "score", 900',
        'Glf_EndOfBall Null', // ball 3: the framework ends the game
        'Glf_EndGame Null', // a cancel with no game running journals nothing
        'Table1_Exit',
      ],
    );
    expect(out.trim()).toBe('driven');
    expect(events[0]).toMatchObject({ event: 'table_loaded', table: 'glf-game', recipe: 'B', recipe_version: '0.3.0', lib: '0.5.0' });
    expect(game(events)).toEqual([
      { event: 'game_start', players: 1 },
      { event: 'current_scores', scores: [100], player: 1, ball: 1 },
      { event: 'ball_end', player: 1, ball: 1, extra_balls: 0 },
      { event: 'current_scores', scores: [250], player: 1, ball: 2 },
      { event: 'ball_end', player: 1, ball: 2, extra_balls: 1 },
      { event: 'ball_end', player: 1, ball: 2, extra_balls: 0 },
      { event: 'current_scores', scores: [900], player: 1, ball: 3 },
      { event: 'ball_end', player: 1, ball: 3, extra_balls: 0 },
      { event: 'game_end', scores: [900], players: 1 },
    ]);
    expect(events.at(-1)).toMatchObject({ event: 'table_exit' });
    expect(events.some((e) => e['event'] === 'warn')).toBe(false);
    expect(checkGameJournal(lines)).toMatchObject({ ok: true, problems: [], notes: [] });
  });

  it('Burger template: the ball end carries DMDballnum, an extra ball reads as a shoot-again, the last Case ends the game', () => {
    const drain = ['BallsOnPlayfield = 1', 'Drain_Hit', 'endballcase_timer'];
    const { out, lines, events } = play(
      'burger-game',
      BURGER_BALLS_B_SCRIPT,
      ['Dim ballstext : Set ballstext = New HostThing', 'Dim endballcase : Set endballcase = New HostThing'],
      ['table1_init', 'Table1_KeyDown StartGameKey', 'AddScore 500', ...drain, 'AddScore 500000', ...drain, ...drain, 'AddScore 10', ...drain, 'table1_exit'],
    );
    expect(out.trim()).toBe('driven');
    expect(game(events)).toEqual([
      { event: 'game_start', players: 1 },
      { event: 'current_scores', scores: [500], player: 1, ball: 1 },
      { event: 'ball_end', player: 1, ball: 1, extra_balls: 0 },
      { event: 'current_scores', scores: [500500], player: 1, ball: 2 },
      { event: 'ball_end', player: 1, ball: 2, extra_balls: 1 },
      { event: 'ball_end', player: 1, ball: 2, extra_balls: 0 },
      { event: 'current_scores', scores: [500510], player: 1, ball: 3 },
      { event: 'ball_end', player: 1, ball: 3, extra_balls: 0 },
      { event: 'game_end', scores: [500510], players: 1 },
    ]);
    expect(checkGameJournal(lines)).toMatchObject({ ok: true, problems: [] });
  });

  it('Rattlecan: a ball end from either drain timer, and the game end after a tilted last ball', () => {
    const { out, lines, events } = play(
      'rattlecan-game',
      RATTLECAN_TILT_B_SCRIPT,
      ['Dim ShootAgain : Set ShootAgain = New HostThing', 'Dim ShootAgainAfterTilt : Set ShootAgainAfterTilt = New HostThing'],
      [
        'Table1_Init',
        'Table1_KeyDown StartGameKey',
        'AddScore 100',
        'DrainBehavior : ShootAgain_Timer', // ball 1
        'ExtraBalls = 1',
        'DrainBehavior : ShootAgain_Timer', // ball 2, shoot again
        'TableTilted = 1',
        'DrainBehavior : ShootAgainAfterTilt_Timer', // ball 2 after a tilt
        'AddScore 50',
        'TableTilted = 1',
        'DrainBehavior : ShootAgainAfterTilt_Timer', // ball 3 after a tilt: game over on the second timer
      ],
    );
    expect(out.trim()).toBe('driven');
    expect(game(events)).toEqual([
      { event: 'game_start', players: 1 },
      { event: 'current_scores', scores: [100], player: 1, ball: 1 },
      { event: 'ball_end', player: 1, ball: 1, extra_balls: 0 },
      { event: 'ball_end', player: 1, ball: 2, extra_balls: 1 },
      { event: 'ball_end', player: 1, ball: 2, extra_balls: 0 },
      { event: 'current_scores', scores: [150], player: 1, ball: 3 },
      { event: 'ball_end', player: 1, ball: 3, extra_balls: 0 },
      { event: 'game_end', scores: [150], players: 1 },
    ]);
    expect(checkGameJournal(lines)).toMatchObject({ ok: true, problems: [] });
  });

  it('a game-flag clear outside a game journals no game end (one game end per game start)', () => {
    const { events } = play(
      'rattlecan-idle',
      RATTLECAN_TILT_B_SCRIPT,
      ['Dim ShootAgain : Set ShootAgain = New HostThing', 'Dim ShootAgainAfterTilt : Set ShootAgainAfterTilt = New HostThing'],
      ['Table1_Init', 'BallInPlay = 3', 'ShootAgain_Timer', 'ShootAgain_Timer'],
    );
    expect(events.filter((e) => e['event'] === 'game_end')).toEqual([]);
    expect(events.filter((e) => e['event'] === 'ball_end')).toHaveLength(2);
  });
});
