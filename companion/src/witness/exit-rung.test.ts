import { describe, expect, it } from 'vitest';
import { exitRungFor, type LiveFacts, type UnpatchedFacts } from './exit-rung.js';
import type { SessionSummary } from './journal-detector.js';

const T = 'Freddy A Nightmare on Elm Street (Gottlieb 1994)';
const unpatched = (patch: Partial<UnpatchedFacts>): UnpatchedFacts => ({ cls: 'A', clsReason: null, rom: 'freddy', patchable: true, support: { readable: true, reason: 'live fields in NVRAM' }, noMap: false, hadManifest: false, patchRemoved: false, ...patch });
const summary = (patch: Partial<SessionSummary> = {}): SessionSummary => ({
  table: T,
  recipe: 'A',
  rom: 'freddy',
  counts: { game_start: 0, current_scores: 0, ball_end: 0, game_end: 0, game_abandoned: 0 },
  lines: { table_loaded: 1, nvram_full: 1, nvram_delta: 312 },
  ballsSeen: [],
  maxBall: 0,
  scores: [0, 0, 0, 0],
  inGame: false,
  exited: true,
  torn: 0,
  orphanDeltas: 0,
  ...patch,
});
const live = (patch: Partial<LiveFacts> = {}): LiveFacts => ({
  sidecar: true,
  loaded: true,
  lib: '0.5.0',
  recipe: 'A',
  recipeVersion: '0.3.1',
  rom: 'freddy',
  unreadable: null,
  noMap: false,
  partial: [],
  summary: summary(),
  state: { scores: [0, 0, 0, 0], playerCount: 1, currentPlayer: 1, currentBall: 0, gameOver: true, ballCount: 3, extraBalls: 0, credits: 0, other: {} },
  ...patch,
});

describe('exitRungFor (C11: why a score was read only at close)', () => {
  it('(a) a table with no patch that the import would patch', () => {
    const r = exitRungFor({ table: T, live: null, unpatched: unpatched({}) });
    expect(r).toMatchObject({ rung: 'a', kind: 'not_patched', patchable: true, detail: 'table not patched (new file; the import would patch it: VPM / ROM table, ROM freddy)' });
    expect(r.note).toBe(`${T}: only the score at close was read, not every game, because it is not patched. Press Patch now, then reopen the table so every game posts live.`);
    expect(exitRungFor({ table: T, live: null, unpatched: unpatched({ hadManifest: true }) }).detail).toMatch(/its earlier patch is gone/);
    // C11.2: the sidecar vanished while the table file stayed as the manifest recorded it: an antivirus took it.
    const removed = exitRungFor({ table: T, live: null, unpatched: unpatched({ hadManifest: true, patchRemoved: true }) });
    expect(removed.kind).toBe('not_patched');
    expect(removed.patchable).toBe(true);
    expect(removed.detail).toMatch(/removed from disk by another program, most likely an antivirus quarantine/);
    expect(removed.note).toMatch(/Windows Security → Protection history, then press Patch now/);
    expect(exitRungFor({ table: T, live: null, unpatched: unpatched({ cls: 'B', rom: null, support: null }) }).detail).toBe('table not patched (new file; the import would patch it: original table (script anchors))');
  });

  it('(b) a machine whose live score is out of reach, or no map for the ROM', () => {
    const cpu = exitRungFor({ table: T, live: null, unpatched: unpatched({ patchable: false, support: { readable: false, reason: 'gottlieb-system80: scores in CPU RAM' } }) });
    expect(cpu).toMatchObject({ rung: 'b', kind: 'unreadable', patchable: false, detail: 'live score not readable on gottlieb-system80 (scores in CPU RAM)' });
    expect(cpu.note).toMatch(/can't be read yet \(gottlieb-system80: scores in CPU RAM\)\. Nothing to do yet\.$/);
    const nomap = exitRungFor({ table: T, live: null, unpatched: unpatched({ rom: 'xyz', patchable: false, noMap: true, support: { readable: false, reason: 'no NVRAM map for this ROM' } }) });
    expect(nomap).toMatchObject({ rung: 'b', kind: 'no_map', detail: 'no map for ROM xyz' });
    expect(exitRungFor({ table: T, live: live({ unreadable: 'no NVRAM map for this ROM', noMap: true, rom: 'xyz' }), unpatched: null }).detail).toBe('no map for ROM xyz');
  });

  it('(c) no recipe for the script', () => {
    expect(exitRungFor({ table: T, live: null, unpatched: unpatched({ cls: 'E', rom: null, patchable: false, support: null }) })).toMatchObject({ rung: 'c', detail: 'not patched; no recipe for this script (class E)' });
    expect(exitRungFor({ table: T, live: null, unpatched: unpatched({ cls: 'X', clsReason: 'no _KeyDown handler', rom: null, patchable: false, support: null }) }).detail).toBe('not patched; no recipe for this script (class X: no _KeyDown handler)');
  });

  it('(d) a partial recipe', () => {
    const r = exitRungFor({ table: T, live: live({ recipe: 'B', partial: ['no anchor for EndOfGame; no game end is journaled'] }), unpatched: null });
    expect(r).toMatchObject({ rung: 'd', kind: 'partial', detail: 'the Castcade patch is partial on this script (no anchor for EndOfGame; no game end is journaled)' });
  });

  it('(f1) a sidecar beside the table and no table_loaded', () => {
    const r = exitRungFor({ table: T, live: live({ loaded: false, summary: null, state: null }), unpatched: null });
    expect(r).toMatchObject({ rung: 'f1', kind: 'hook_silent', detail: "sidecar present but the hook never reported in (VPX ran the table's own script?)" });
    expect(r.note).toMatch(/Open the table from the folder Castcade patched/);
    expect(exitRungFor({ table: T, live: live({ loaded: false, sidecar: false }), unpatched: null }).detail).toBe('the patch inside the table never reported in');
  });

  it('(f2) the hook reported in and the detector saw no game end, with the counts', () => {
    const r = exitRungFor({ table: T, live: live(), unpatched: null });
    expect(r).toMatchObject({ rung: 'f2', kind: 'no_game_end' });
    expect(r.detail).toBe('live mode followed the journal (hook 0.5.0, recipe A 0.3.1, 1 nvram_full, 312 nvram_delta, 0 orphan; game_start seen: no; last state scores [0,0,0,0] ball 0 player 1 game over) and saw no game end');
    const scripted = exitRungFor({ table: T, live: live({ recipe: 'C', recipeVersion: null, state: null, summary: summary({ lines: { table_loaded: 1, current_scores: 9 }, counts: { game_start: 1, current_scores: 9, ball_end: 2, game_end: 0, game_abandoned: 0 }, scores: [1200, null] }) }), unpatched: null });
    expect(scripted.detail).toBe('live mode followed the journal (hook 0.5.0, recipe C, 10 journal lines, 9 current_scores; game_start seen: yes; 2 ball_end; last scores [1200,?]) and saw no game end');
  });

  it('no table file, or a script that could not be read', () => {
    expect(exitRungFor({ table: T, live: null, unpatched: null })).toMatchObject({ rung: '?', kind: 'no_table_file' });
    expect(exitRungFor({ table: T, live: null, unpatched: unpatched({ cls: null }) })).toMatchObject({ rung: '?', kind: 'script_unread' });
  });
});
