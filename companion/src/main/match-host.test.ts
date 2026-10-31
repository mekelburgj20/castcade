/**
 * A6 (2026-10-30): two match hosts on localhost over real WebSockets, Electron stubbed (the cue window only): host,
 * join with a different table file (refused by the engine, re-joined with the host's fingerprint and flagged on both
 * sides), start, the turn lock file on each rig, leave.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  class BrowserWindow {
    webContents = { once: (_e: string, cb: () => void) => cb(), send: () => undefined };
    isDestroyed(): boolean {
      return false;
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): void {}
  }
  return { BrowserWindow, ipcMain: { on: () => undefined } };
});

const { createMatchHost } = await import('./match-host.js');
type MatchHost = ReturnType<typeof createMatchHost>;
type WitnessHost = Parameters<typeof createMatchHost>[0]['witness'];
type Logger = Parameters<typeof createMatchHost>[0]['log'];

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, file: '' } as unknown as Logger;

function witness(sha: string): WitnessHost {
  return {
    status: () => ({ paired: false, currentTable: 'Monster Bash', currentIdentity: { sha256: sha, tableInfo: null }, currentAttestation: null }),
    onEvent: () => () => undefined,
    onStatus: () => () => undefined,
  } as unknown as WitnessHost;
}

const dirs: string[] = [];
const hosts: MatchHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(name: string, sha: string): { mh: MatchHost; lock: string } {
  const dir = mkdtempSync(join(tmpdir(), `castcade-match-${name}-`));
  dirs.push(dir);
  const lock = join(dir, 'lock', 'turn.lock');
  const mh = createMatchHost({
    file: join(dir, 'match.json'),
    keysFile: join(dir, 'match-keys.json'),
    witness: witness(sha),
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.21',
    log: logger,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
  });
  hosts.push(mh);
  return { mh, lock };
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('match host (A6)', () => {
  it('host, join with a different table file (advisory), start: the lock follows the grant; leave unlocks', async () => {
    const H = make('host', 'ab'.repeat(32));
    const C = make('client', 'cd'.repeat(32));
    const port = 41000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    expect(hs).toMatchObject({ role: 'host', phase: 'lobby', ipSource: 'public', port });
    expect(hs.invite).toMatch(new RegExp(`^castcade:ws://127\\.0\\.0\\.1:${port}#[A-Z]{6}$`));
    expect(hs.panel).toMatchObject({ phase: 'idle', message: 'Waiting for players' });

    await expect(C.mh.join('castcade:nope', 'Krobs')).rejects.toThrow(/not a Castcade invite/);
    const cs = await C.mh.join(hs.invite!, 'Krobs');
    expect(cs).toMatchObject({ role: 'client', phase: 'lobby' });
    expect(cs.participants.map((p) => [p.name, p.tableMatch])).toEqual([
      ['Hosty', true],
      ['Krobs', false],
    ]);
    await until(() => H.mh.status().participants.length === 2);
    expect(H.mh.status().participants.find((p) => p.name === 'Krobs')?.tableMatch).toBe(false);
    expect(H.mh.status().panel?.message).toBe('different table file: Krobs');

    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing');
    // The host has ball 1: its table is open, the client's is locked.
    expect(H.mh.status()).toMatchObject({ phase: 'playing', locked: false });
    expect(existsSync(H.lock)).toBe(false);
    expect(C.mh.status().locked).toBe(true);
    expect(existsSync(C.lock)).toBe(true);
    expect(C.mh.status().panel).toMatchObject({ myTurn: false, ball: 1 });

    const left = await C.mh.leave();
    expect(left).toMatchObject({ role: 'none', phase: 'none', locked: false });
    expect(existsSync(C.lock)).toBe(false);
    await until(() => H.mh.status().panel?.players.find((p) => p.name === 'Krobs')?.flags.includes('disconnected') === true);
  }, 15_000);
});
