/**
 * The rendered sidecars under the real VBScript engine (Windows Script Host, the engine VPX runs table scripts with),
 * without VPX: every recipe's sidecar COMPILES (`vpx-hook/spike/vbs-compile.vbs`, which runs none of it), and the
 * synthetic tables of the C1.4 overrides are DRIVEN through a game with the real `castcade.vbs`, their journal read
 * back and judged by `checkGameJournal`. The journal is also read WHILE the script runs, by the companion's own
 * `JournalTail` over the real file system (C16). Windows only: skipped where `cscript.exe` does not exist (the Linux CI job).
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { JournalTail } from '../witness/journal-tail.js';
import { classifyScript } from './classify.js';
import { renderSidecar } from './render-originals.js';
import {
  BURGER_BALLS_B_SCRIPT,
  BURGER_B_SCRIPT,
  DIABLO_B_SCRIPT,
  FUTURAMA_B_SCRIPT,
  GLF_B_SCRIPT,
  JACKS_B_SCRIPT,
  GOT_B_SCRIPT,
  JPSALAS_B_SCRIPT,
  MATRIX_B_SCRIPT,
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
const children: ChildProcessWithoutNullStreams[] = [];
afterAll(async () => {
  // A script a failed test left running still holds its journal open, and an open file cannot be removed.
  await Promise.all(children.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => new Promise((resolve) => c.once('exit', resolve).kill())));
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
 * A `cscript` process that stays up: it runs `prelude`, then each statement it is sent, in its global scope, and answers
 * `done` or `err <number> <description>` once the statement has returned. What it writes can be read between statements
 * while the process (and any file it holds open) is still alive.
 */
const driven = (name: string, prelude: string[], env: NodeJS.ProcessEnv = process.env) => {
  const harness = join(dir, `${name}-driven.vbs`);
  writeFileSync(
    harness,
    [
      ...prelude,
      'Dim Driven_s',
      'Do',
      '    Driven_s = WScript.StdIn.ReadLine',
      '    If Driven_s = "quit" Then Exit Do',
      '    On Error Resume Next',
      '    Err.Clear',
      '    ExecuteGlobal Driven_s',
      '    If Err.Number <> 0 Then',
      '        WScript.StdOut.WriteLine "err " & Err.Number & " " & Err.Description',
      '    Else',
      '        WScript.StdOut.WriteLine "done"',
      '    End If',
      '    On Error GoTo 0',
      'Loop',
    ].join('\r\n') + '\r\n',
  );
  const child = spawn(CSCRIPT, ['//nologo', harness], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const waiting: { resolve: (answer: string) => void; reject: (err: Error) => void }[] = [];
  let out = '';
  let errText = '';
  child.stdout.setEncoding('latin1');
  child.stdout.on('data', (d: string) => {
    out += d;
    for (let i = out.indexOf('\n'); i >= 0; i = out.indexOf('\n')) {
      const answer = out.slice(0, i).replace(/\r$/, '');
      out = out.slice(i + 1);
      waiting.shift()?.resolve(answer);
    }
  });
  child.stderr.setEncoding('latin1');
  child.stderr.on('data', (d: string) => (errText += d));
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      for (const w of waiting.splice(0)) w.reject(new Error(`cscript exited (${code}): ${errText}${out}`));
      resolve(code);
    }),
  );
  return {
    run: (statement: string): Promise<string> =>
      new Promise((resolve, reject) => {
        if (child.exitCode !== null) return reject(new Error(`cscript exited (${child.exitCode}): ${errText}${out}`));
        waiting.push({ resolve, reject });
        child.stdin.write(statement + '\r\n');
      }),
    running: (): boolean => child.exitCode === null && child.signalCode === null,
    quit: (): Promise<number | null> => {
      child.stdin.end('quit\r\n');
      return exited;
    },
  };
};

/** Whether another process could rename `path` right now: Windows refuses while a handle without delete sharing is open. */
const renamable = (path: string): boolean => {
  try {
    renameSync(path, `${path}.moved`);
  } catch (err) {
    if ((err as { code?: string }).code === 'EBUSY') return false;
    throw err;
  }
  renameSync(`${path}.moved`, path);
  return true;
};

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
      MATRIX_B_SCRIPT,
      GOT_B_SCRIPT,
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
    expect(events[0]).toMatchObject({ event: 'table_loaded', table: 'glf-game', recipe: 'B', recipe_version: '0.3.2', lib: '0.5.2' });
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

  it('The Matrix (Original) shape: an EndOfGame that zeroes the scores still journals the final score (B 0.3.1)', () => {
    const { out, lines, events } = play('matrix-game', MATRIX_B_SCRIPT, [], ['Table1_KeyDown StartGameKey', 'AddScore 500', 'EndOfBall', 'AddScore 20', 'EndOfBall', 'EndOfBall', 'Table1_Exit']);
    expect(out.trim()).toBe('driven');
    expect(game(events)).toEqual([
      { event: 'game_start', players: 1 },
      { event: 'current_scores', scores: [500], player: 1, ball: 1 },
      { event: 'ball_end', player: 1, ball: 1, extra_balls: 0 },
      { event: 'current_scores', scores: [1500], player: 1, ball: 1 },
      { event: 'current_scores', scores: [1520], player: 1, ball: 2 },
      { event: 'ball_end', player: 1, ball: 2, extra_balls: 0 },
      { event: 'current_scores', scores: [2520], player: 1, ball: 2 },
      { event: 'ball_end', player: 1, ball: 3, extra_balls: 0 },
      { event: 'current_scores', scores: [3520], player: 1, ball: 3 },
      { event: 'game_end', scores: [3520], players: 1 },
    ]);
    expect(checkGameJournal(lines)).toMatchObject({ ok: true, problems: [] });
  });

  it('Game of Thrones shape: a Start during the match sequence still leaves one game end per game, with the bonus (B 0.3.2)', () => {
    const balls = ['EndOfBall', 'EndOfBall', 'EndOfBall'];
    const { out, lines, events } = play(
      'got-game',
      GOT_B_SCRIPT,
      [],
      [
        'Table1_Init',
        'Table1_KeyDown StartGameKey',
        'AddScore 500',
        ...balls, // the third one is the game over: the flag is cleared, the match sequence runs
        'Table1_KeyDown StartGameKey', // a Start during the match sequence: the next game
        'EndOfGame', // the first game's timer fires now, and leaves at its guard
        'AddScore 10',
        ...balls,
        'EndOfGame', // nobody pressed Start this time: the end sub runs whole, and journals nothing twice
        'Table1_Exit',
      ],
    );
    expect(out.trim()).toBe('driven');
    const ends = game(events).filter((e) => e['event'] === 'game_start' || e['event'] === 'game_end' || e['event'] === 'ball_end');
    expect(ends).toEqual([
      { event: 'game_start', players: 1 },
      { event: 'ball_end', player: 1, ball: 1, extra_balls: 0 },
      { event: 'ball_end', player: 1, ball: 2, extra_balls: 0 },
      { event: 'ball_end', player: 1, ball: 3, extra_balls: 0 },
      { event: 'game_end', scores: [3500], players: 1 },
      { event: 'game_start', players: 1 },
      { event: 'ball_end', player: 1, ball: 1, extra_balls: 0 },
      { event: 'ball_end', player: 1, ball: 2, extra_balls: 0 },
      { event: 'ball_end', player: 1, ball: 3, extra_balls: 0 },
      { event: 'game_end', scores: [3010], players: 1 },
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

  it('C15 (lib 0.5.1): with a watch list, a watched NVRAM change after 300000 callbacks is still journaled', () => {
    const local = join(dir, 'long-sitting-localappdata');
    mkdirSync(local, { recursive: true });
    const harness = join(dir, 'long-sitting-harness.vbs');
    writeFileSync(
      harness,
      [
        `ExecuteGlobal CreateObject("Scripting.FileSystemObject").OpenTextFile(${vbs(LIB)}, 1, False, 0).ReadAll`,
        'Castcade_Init "long-sitting", "A", "0.3.1", "congo_21"',
        'Castcade_WatchBytes Array(5794)',
        'Dim chg(0, 2), i',
        'chg(0, 0) = 100 : chg(0, 1) = 1 : chg(0, 2) = 0',
        'For i = 1 To 300010 : Castcade_NVRAM chg : Next',
        'chg(0, 0) = 5794 : chg(0, 1) = 42 : chg(0, 2) = 7',
        'Castcade_NVRAM chg',
        'Castcade_Exit',
        'WScript.Echo "driven"',
      ].join('\r\n') + '\r\n',
    );
    const { out } = cscript([harness], { ...process.env, LOCALAPPDATA: local });
    expect(out).toContain('driven');
    const events = readFileSync(join(local, 'Castcade', 'journal', 'long-sitting.jsonl'), 'latin1')
      .split(/\r?\n/)
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ event: 'table_loaded', lib: '0.5.2' });
    expect(events.filter((e) => e['event'] === 'nvram_delta').map((e) => e['d'])).toEqual([[[5794, 42, 7]]]);
    expect(events.at(-1)).toMatchObject({ event: 'table_exit', nvram_callbacks: 300011 });
  });

  it('C16 premise: the journal tail reads a line on its first poll after a TextStream WriteLine, while the writer holds the file open', async () => {
    const journal = join(dir, 'premise.jsonl');
    const writer = driven('premise', ['Dim fso, ts', 'Set fso = CreateObject("Scripting.FileSystemObject")', `Set ts = fso.OpenTextFile(${vbs(journal)}, 8, True)`]);
    const tail = new JournalTail(journal, { from: 'start' }); // the real file system, as the witness reads a journal
    const seen: string[] = [];
    tail.on('line', (l) => seen.push(l));
    const written: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const line = JSON.stringify({ event: 'premise', t: i, d: [[5794, i, i - 1]] });
      expect(await writer.run(`ts.WriteLine ${vbs(line)}`)).toBe('done');
      written.push(line);
      await tail.poll(); // what each 250 ms tick does
      expect(seen).toEqual(written);
      expect(renamable(journal)).toBe(false); // never closed: the writer's handle is still open
    }
    expect(await writer.run('ts.Close')).toBe('done');
    expect(renamable(journal)).toBe(true);
    expect(await writer.quit()).toBe(0);
  });

  it('C16 (lib 0.5.2): every line goes through the handle opened at table load, readable at once, and the file closes only at table exit', async () => {
    const local = join(dir, 'held-open-localappdata');
    mkdirSync(local, { recursive: true });
    const journal = join(local, 'Castcade', 'journal', 'held-open.jsonl');
    const table = driven(
      'held-open',
      [
        'Class Castcade_TestController',
        '    Public Property Get NVRAM : NVRAM = Array(0, 1, 2, 3) : End Property',
        'End Class',
        'Dim Controller : Set Controller = New Castcade_TestController',
        `ExecuteGlobal CreateObject("Scripting.FileSystemObject").OpenTextFile(${vbs(LIB)}, 1, False, 0).ReadAll`,
        'Castcade_Init "held-open", "A", "0.3.2", "congo_21"',
        'Castcade_WatchBytes Array(5794)',
        'Dim chg(0, 2), ss',
      ],
      { ...process.env, LOCALAPPDATA: local },
    );
    const tail = new JournalTail(journal, { from: 'start' });
    const seen: Record<string, unknown>[] = [];
    tail.on('line', (l) => seen.push(JSON.parse(l) as Record<string, unknown>));
    /** Run one statement, then one poll of the tail: exactly the lines it wrote must arrive. */
    const step = async (statement: string, events: string[]): Promise<void> => {
      expect(await table.run(statement), statement).toBe('done');
      const before = seen.length;
      await tail.poll();
      expect(seen.slice(before).map((e) => e['event']), statement).toEqual(events);
    };
    await step('chg(0, 0) = 0', ['table_loaded']);
    // From here on nothing can open the journal for writing: a library that closed and reopened it would lose every later line.
    chmodSync(journal, 0o444);
    try {
      expect(() => closeSync(openSync(journal, 'a'))).toThrow(/EPERM/);
      await step('chg(0, 0) = 5794 : chg(0, 1) = 42 : chg(0, 2) = 7 : Castcade_NVRAM chg', ['nvram_full', 'nvram_delta']);
      await step('Castcade_GameStart 1', ['game_start']);
      await step('Castcade_Scores Array(1000), 1, 1', ['current_scores']);
      // 50 ms after the last delta the next one is written; one more change right after it is coalesced and held.
      await step('WScript.Sleep 100 : chg(0, 1) = 43 : chg(0, 2) = 42 : Castcade_NVRAM chg : chg(0, 1) = 44 : chg(0, 2) = 43 : Castcade_NVRAM chg', ['nvram_delta']);
      await step('Castcade_BallEnd 1, 1, 0', ['ball_end']);
      await step('Set ss = Castcade_ScoreServer() : ss.SetGameState 1, 1, 3, 3', ['score_server', 'score_server']);
      expect(renamable(journal)).toBe(false); // held open between lines
      // Table exit writes what was held (the shim's game end, the coalesced delta), then table_exit, then closes the file.
      await step('Castcade_Exit', ['game_end', 'nvram_delta', 'table_exit']);
      expect(table.running()).toBe(true);
      expect(renamable(journal)).toBe(true);
    } finally {
      chmodSync(journal, 0o666);
    }
    expect(await table.quit()).toBe(0);
    const lines = readFileSync(journal, 'latin1').split(/\r?\n/).filter((l) => l !== '');
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual(seen);
    expect(seen[0]).toMatchObject({ event: 'table_loaded', lib: '0.5.2' });
    expect(seen.filter((e) => e['event'] === 'nvram_delta').map((e) => e['d'])).toEqual([[[5794, 42, 7]], [[5794, 43, 42]], [[5794, 44, 43]]]);
    expect(seen.at(-1)).toMatchObject({ event: 'table_exit', lines: 11, nvram_callbacks: 3 });
  });
});
