/**
 * A6 (2026-10-30): two match hosts on localhost over real WebSockets, Electron stubbed (the cue window only): host,
 * join with a different table file (accepted by the host's `advise` policy and flagged on both sides: the client from
 * HELLO_ACK's hostGame), start, the turn lock file on each rig, leave.
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
const { createMediaSettingsStore } = await import('../media/media-settings.js');
type MatchHost = ReturnType<typeof createMatchHost>;
type WitnessHost = Parameters<typeof createMatchHost>[0]['witness'];
type Logger = Parameters<typeof createMatchHost>[0]['log'];

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, file: '' } as unknown as Logger;

function witness(sha: string): WitnessHost {
  return {
    status: () => ({ paired: false, currentTable: 'Monster Bash', currentIdentity: { sha256: sha, tableInfo: null }, currentAttestation: null }),
    sampleVr: async () => null,
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

function make(name: string, sha: string, extra: Partial<Parameters<typeof createMatchHost>[0]> = {}): { mh: MatchHost; lock: string } {
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
    ...extra,
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
    // Same table name, another hash (D2.5, 2026-10-31): the same table in another file.
    expect(H.mh.status().panel?.message).toBe('same table, different file (a re-save or another download): Krobs');
    expect(C.mh.status().panel?.message).toBe('same table, different file (a re-save or another download): you');
    expect(H.mh.status().participants.find((p) => p.name === 'Krobs')).toMatchObject({ tableNote: 'same table, different file (a re-save or another download)', buildMatch: true });
    expect(C.mh.status().panel?.players.find((p) => p.name === 'Krobs')?.flags).toEqual(['table_mismatch']);

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

  it('microphone and mute: saved in media.json and live on the media layer when there is one (D2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'castcade-match-mic-'));
    dirs.push(dir);
    const file = join(dir, 'media.json');
    const bare = make('bare', 'ab'.repeat(32), { mediaSettings: createMediaSettingsStore(file) });
    expect(bare.mh.status()).toMatchObject({ microphones: [], micDeviceId: null, muted: false });
    expect(bare.mh.setMicrophone('headset-1')).toMatchObject({ micDeviceId: 'headset-1' });
    expect(bare.mh.setMuted(true)).toMatchObject({ muted: true });
    expect(createMediaSettingsStore(file).get()).toMatchObject({ micDeviceId: 'headset-1', muted: true });
    expect(bare.mh.setMicrophone(null).micDeviceId).toBeNull();

    const calls: string[] = [];
    const settings = createMediaSettingsStore(join(dir, 'media2.json'));
    let onMics: (() => void) | null = null;
    const media = {
      microphones: () => [{ deviceId: 'headset-1', label: 'Headset' }],
      onMicrophones: (cb: () => void) => {
        onMics = cb;
        return () => undefined;
      },
      setMicrophone: (id: string | null) => {
        calls.push(`mic ${id}`);
        settings.patch({ micDeviceId: id });
      },
      setMuted: (m: boolean) => {
        calls.push(`muted ${m}`);
        settings.patch({ muted: m });
      },
      onStatus: () => () => undefined,
      status: () => null,
    } as unknown as NonNullable<Parameters<typeof createMatchHost>[0]['media']>;
    const live = make('live', 'ab'.repeat(32), { media, mediaSettings: settings });
    const seen: number[] = [];
    live.mh.onStatus((st) => seen.push(st.microphones.length));
    expect(live.mh.status().microphones).toEqual([{ deviceId: 'headset-1', label: 'Headset' }]);
    live.mh.setMicrophone('headset-1');
    live.mh.setMuted(true);
    expect(calls).toEqual(['mic headset-1', 'muted true']);
    expect(live.mh.status()).toMatchObject({ micDeviceId: 'headset-1', muted: true });
    seen.length = 0;
    (onMics as (() => void) | null)?.();
    expect(seen).toEqual([1]);
  });
});

// ---- A6 (2026-10-31): the rig decision at host / join, and the late switch into the headset ----

type MediaOpt = NonNullable<Parameters<typeof createMatchHost>[0]['media']>;
type OverlayOpt = NonNullable<Parameters<typeof createMatchHost>[0]['vrOverlay']>;
type WStatus = ReturnType<WitnessHost['status']>;

type Vr = { inVr: boolean; runtime: string | null; runtimeLoaded: boolean; compositorRunning: boolean; vrCapableBuild: boolean; activeOpenXrRuntime: string | null; sampledAt: string };
const VR_ON: Vr = { inVr: true, runtime: 'steamvr', runtimeLoaded: true, compositorRunning: true, vrCapableBuild: true, activeOpenXrRuntime: null, sampledAt: '2026-10-31T06:07:47.000Z' };
const VR_OFF: Vr = { inVr: false, runtime: null, runtimeLoaded: false, compositorRunning: true, vrCapableBuild: true, activeOpenXrRuntime: null, sampledAt: '2026-10-31T06:07:40.000Z' };
/** B22: the owner's rig, VPX on Virtual Desktop's OpenXR runtime (no vrclient, no SteamVR). */
const VD_JSON = 'C:\\Program Files\\Virtual Desktop Streamer\\OpenXR\\virtualdesktop-openxr.json';
const VR_VD: Vr = { inVr: true, runtime: 'virtual-desktop', runtimeLoaded: false, compositorRunning: false, vrCapableBuild: true, activeOpenXrRuntime: VD_JSON, sampledAt: '2026-10-31T06:07:50.000Z' };

/** A witness whose status the test changes and announces, and whose live probe answers `live`. */
function liveWitness(live: Vr | null, vr: Vr | null = VR_OFF) {
  const listeners = new Set<(s: WStatus) => void>();
  let attestation: { vr: Vr | null } | null = vr ? { vr } : null;
  const status = (): WStatus => ({ paired: false, currentTable: 'Monster Bash', currentIdentity: { sha256: 'ab'.repeat(32), tableInfo: null }, currentAttestation: attestation }) as unknown as WStatus;
  const w = {
    status,
    sampleVr: async () => live,
    onEvent: () => () => undefined,
    onStatus: (cb: (s: WStatus) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as WitnessHost;
  return {
    w,
    /** The witness re-sampled (table_loaded) and emitted its status. */
    setVr(next: Vr | null) {
      attestation = { vr: next };
      for (const l of listeners) l(status());
    },
  };
}

/** `RtcHost` as the match host sees it: records calls; frames only from an offscreen (VR) panel. */
function fakeMedia() {
  const calls: string[] = [];
  let vr = false;
  let attached = false;
  const source = { onFrame: () => () => undefined };
  const media = {
    async attach(_sig: unknown, peers: string[]) {
      attached = true;
      calls.push(`attach ${vr ? 'vr' : 'desktop'} ${peers.length}`);
    },
    addPeer: () => undefined,
    removePeer: () => undefined,
    setSending: () => undefined,
    setPanelState: () => undefined,
    setMuted: () => undefined,
    status: () => ({ attached, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null }),
    onStatus: () => () => undefined,
    frames: () => (attached && vr ? source : null),
    showPanel: () => {
      if (!vr) calls.push('showPanel');
    },
    async detach() {
      attached = false;
      calls.push('detach');
    },
    async setVr(rig: { inVr: boolean; headsetPanel: boolean }) {
      // `setVr true` / `false`: the panel window kind; ` (in VR)` marks a VR rig with a desktop panel (B22).
      calls.push(`setVr ${rig.headsetPanel}${rig.inVr && !rig.headsetPanel ? ' (in VR)' : ''}`);
      // As RtcHost: headset -> desktop while attached is ignored.
      if (attached && !rig.headsetPanel) return;
      vr = rig.headsetPanel;
    },
    refreshMicrophones: async () => {
      calls.push('refreshMicrophones');
    },
  };
  return { media: media as unknown as MediaOpt, calls, source };
}

function fakeOverlay() {
  const started: unknown[] = [];
  let stops = 0;
  let state: 'stopped' | 'showing' = 'stopped';
  const overlay = {
    async start(src: unknown) {
      started.push(src);
      state = 'showing';
      return { state, reason: null };
    },
    async stop() {
      stops++;
      state = 'stopped';
    },
    status: () => ({ state, reason: null }),
    onStatus: () => () => undefined,
  };
  return { overlay: overlay as unknown as OverlayOpt, started, stops: () => stops };
}

describe('match host: the rig (A6, 2026-10-31)', () => {
  const port = (): number => 43000 + Math.floor(Math.random() * 2000);
  const logLines = (): { log: Logger; lines: string[] } => {
    const lines: string[] = [];
    const push = (l: string): number => lines.push(l);
    return { log: { info: push, warn: push, error: push, file: '' } as unknown as Logger, lines };
  };

  it('host: the running VPX probed now says VR → offscreen panel and the overlay at once, whatever the stale attestation said', async () => {
    const wit = liveWitness(VR_ON, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const { log, lines } = logLines();
    const H = make('vr', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, log });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(m.calls).toEqual(['setVr true', 'attach vr 0']);
    expect(o.started).toEqual([m.source]);
    expect(st).toMatchObject({ rig: 'vr_headset', rigReason: 'VPX probed now: vrclient loaded, compositor running', vrOverlay: { state: 'showing' } });
    expect(st.participants[0]?.rig).toBe('vr_headset');
    expect(lines).toContain('match: rig vr_headset via steamvr (VPX probed now: vrclient loaded, compositor running)');
  });

  it('host on the monitor reading, then the witness reads VR (table_loaded): the panel moves into the headset and the overlay starts; the reverse is ignored', async () => {
    const wit = liveWitness(null, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const { log, lines } = logLines();
    const H = make('late', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, log });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(st).toMatchObject({ rig: 'pc', rigReason: "the witness's sample at 2026-10-31T06:07:40.000Z: vrclient not loaded, compositor running" });
    expect(m.calls).toEqual(['setVr false', 'attach desktop 0', 'showPanel']);
    expect(o.started).toEqual([]);

    const seen: string[] = [];
    H.mh.onStatus((s) => seen.push(s.rig));
    wit.setVr(VR_ON);
    await until(() => o.started.length === 1);
    expect(m.calls.slice(3)).toEqual(['setVr true']);
    expect(o.started).toEqual([m.source]);
    expect(H.mh.status()).toMatchObject({ rig: 'vr_headset', vrOverlay: { state: 'showing' } });
    expect(H.mh.status().rigReason).toMatch(/^switched after hosting: the witness's sample at .*: vrclient loaded, compositor running$/);
    expect(seen).toContain('vr_headset');
    expect(lines.some((l) => l.startsWith('match: rig vr_headset (switched after hosting'))).toBe(true);

    // A second VR status: nothing more. VR -> monitor: logged once, the headset panel stays.
    wit.setVr(VR_ON);
    wit.setVr(VR_OFF);
    wit.setVr(VR_OFF);
    await new Promise((r) => setTimeout(r, 20));
    expect(o.started).toHaveLength(1);
    expect(m.calls.slice(3)).toEqual(['setVr true']);
    expect(H.mh.status().rig).toBe('vr_headset');
    expect(lines.filter((l) => l.includes('the panel stays in the headset'))).toHaveLength(1);
  });

  it('no VPX open and no sample: the monitor, said so; no match shows the witness reading', async () => {
    const wit = liveWitness(null, null);
    const m = fakeMedia();
    const H = make('none', 'ab'.repeat(32), { witness: wit.w, media: m.media });
    expect(H.mh.status()).toMatchObject({ rig: 'pc', rigReason: 'no match; decided again when you host or join (no VPX table open to probe; monitor assumed)' });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(st).toMatchObject({ rig: 'pc', rigReason: 'no VPX table open to probe; monitor assumed', vrRuntime: null });
  });

  it("D7.3 (2026-10-31): VR on Virtual Desktop's OpenXR runtime: offscreen panel into the OpenXR layer, not the SteamVR helper", async () => {
    const wit = liveWitness(VR_VD, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const layer = fakeOverlay();
    const { log, lines } = logLines();
    const H = make('vd', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, vrLayer: layer.overlay, log });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(m.calls).toEqual(['setVr true', 'attach vr 0']);
    expect(layer.started).toEqual([m.source]);
    expect(o.started).toEqual([]);
    expect(st).toMatchObject({ rig: 'vr_headset', vrRuntime: 'virtual-desktop', vrOverlay: { state: 'showing' } });
    expect(st.rigReason).toBe(`VPX probed now: Virtual Desktop (OpenXR), vrclient not loaded, compositor not running, active OpenXR runtime ${VD_JSON}`);
    expect(st.participants[0]?.rig).toBe('vr_headset');
    expect(lines.some((l) => l.startsWith('match: rig vr_headset via virtual-desktop ('))).toBe(true);
    expect(lines).toContain('match: VR overlay showing via the OpenXR layer (virtual-desktop)');

    // More VD readings change nothing; a SteamVR reading (VPX restarted through SteamVR) swaps the layer for the helper.
    wit.setVr(VR_VD);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.calls).toHaveLength(2);
    expect(layer.started).toHaveLength(1);
    wit.setVr(VR_ON);
    await until(() => o.started.length === 1);
    expect(layer.stops()).toBe(1);
    expect(o.started).toEqual([m.source]);
    expect(m.calls.slice(2)).toEqual(['setVr true']);
    expect(H.mh.status()).toMatchObject({ rig: 'vr_headset', vrRuntime: 'steamvr', vrOverlay: { state: 'showing' } });
    await H.mh.leave();
    expect(o.stops()).toBe(1);
    expect(layer.stops()).toBe(1);
  });

  it('D7.3: hosted on the monitor reading, then the witness reads VR on Virtual Desktop: the panel moves into the headset through the layer', async () => {
    const wit = liveWitness(null, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const layer = fakeOverlay();
    const H = make('vd-late', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, vrLayer: layer.overlay });
    await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(m.calls).toEqual(['setVr false', 'attach desktop 0', 'showPanel']);
    expect(H.mh.status().vrOverlay).toEqual({ state: 'stopped', reason: null }); // the monitor: the SteamVR helper's (idle) status, as before
    wit.setVr(VR_VD);
    await until(() => layer.started.length === 1);
    expect(m.calls.slice(3)).toEqual(['setVr true']);
    expect(o.started).toEqual([]);
    expect(H.mh.status()).toMatchObject({ rig: 'vr_headset', vrRuntime: 'virtual-desktop', vrOverlay: { state: 'showing' } });
  });

  it('D7.3: an OpenXR runtime with no layer set up: no overlay status, and the log says why', async () => {
    const wit = liveWitness(VR_VD, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const { log, lines } = logLines();
    const H = make('vd-nolayer', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, log });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(o.started).toEqual([]);
    expect(st).toMatchObject({ rig: 'vr_headset', vrRuntime: 'virtual-desktop', vrOverlay: null });
    expect(lines).toContain('match: in VR but no OpenXR layer; showing the desktop panel');
  });

  it('B22: the Match tab opening lists the microphones when no match runs, never during one', async () => {
    const m = fakeMedia();
    const H = make('mics', 'ab'.repeat(32), { witness: liveWitness(null, null).w, media: m.media });
    H.mh.refreshMicrophones();
    expect(m.calls).toEqual(['refreshMicrophones']);
    await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    H.mh.refreshMicrophones();
    expect(m.calls.filter((c) => c === 'refreshMicrophones')).toHaveLength(1);
    // A bare media layer (no picker) is fine.
    make('mics-bare', 'ab'.repeat(32)).mh.refreshMicrophones();
  });
});

// ---- A6 (2026-10-31): the lobby refresh of the rig and the table (the first two-player match) ----

/** A witness with no table until `load`: then a table (sha) and a VR sample, announced like a `table_loaded` status. */
function loadingWitness() {
  const listeners = new Set<(s: WStatus) => void>();
  let table: { sha: string; vr: Vr | null } | null = null;
  const status = (): WStatus =>
    ({
      paired: false,
      currentTable: table ? 'Monster Bash' : null,
      currentIdentity: table ? { sha256: table.sha, tableInfo: null } : null,
      currentAttestation: table?.vr ? { vr: table.vr } : null,
    }) as unknown as WStatus;
  const w = {
    status,
    // The live probe reads the running VPX: nothing before the table opens.
    sampleVr: async () => table?.vr ?? null,
    onEvent: () => () => undefined,
    onStatus: (cb: (s: WStatus) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as WitnessHost;
  return {
    w,
    load(sha: string, vr: Vr | null) {
      table = { sha, vr };
      for (const l of listeners) l(status());
    },
  };
}

describe('match host: the lobby refresh (A6, 2026-10-31)', () => {
  const port = (): number => 45000 + Math.floor(Math.random() * 2000);
  const row = (mh: MatchHost, name: string) => mh.status().participants.find((p) => p.name === name);

  it('a client whose table loads after joining: the right rig and no false mismatch on both sides; a real mismatch still flags; after the start nothing changes', async () => {
    const H = make('lobby-host', 'ab'.repeat(32));
    const krobs = loadingWitness();
    const C = make('lobby-client', 'ab'.repeat(32), { witness: krobs.w });
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    // As in the match: joined before the table loaded.
    expect(row(H.mh, 'Krobs')).toMatchObject({ rig: 'pc', tableMatch: false });
    expect(row(C.mh, 'Krobs')).toMatchObject({ rig: 'pc', tableMatch: false });

    krobs.load('ab'.repeat(32), VR_VD);
    await until(() => row(H.mh, 'Krobs')?.rig === 'vr_headset' && row(H.mh, 'Krobs')?.tableMatch === true);
    await until(() => row(C.mh, 'Krobs')?.rig === 'vr_headset' && row(C.mh, 'Krobs')?.tableMatch === true);
    expect(C.mh.status().rig).toBe('vr_headset');
    expect(H.mh.status().panel?.message).toBe('Everyone in? Press Start match');
    expect(C.mh.status().panel?.message).toBe('Waiting for the host to start');

    // A different table file is still a difference.
    krobs.load('cd'.repeat(32), VR_VD);
    await until(() => row(H.mh, 'Krobs')?.tableMatch === false && row(C.mh, 'Krobs')?.tableMatch === false);
    expect(H.mh.status().panel?.message).toBe('same table, different file (a re-save or another download): Krobs');

    // After MATCH_READY the roster is final: a table load changes nothing.
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing');
    krobs.load('ab'.repeat(32), VR_VD);
    await new Promise((r) => setTimeout(r, 100));
    expect(row(H.mh, 'Krobs')).toMatchObject({ rig: 'vr_headset', tableMatch: false });
    expect(row(C.mh, 'Krobs')).toMatchObject({ rig: 'vr_headset', tableMatch: false });
  }, 15_000);

  it("the host's own table loads after hosting: its row and the client's flag follow", async () => {
    const owner = loadingWitness();
    const H = make('lobby-host2', 'ab'.repeat(32), { witness: owner.w });
    const C = make('lobby-client2', 'ab'.repeat(32));
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    expect(row(H.mh, 'Krobs')?.tableMatch).toBe(false);
    expect(row(C.mh, 'Owner')?.rig).toBe('pc');

    owner.load('ab'.repeat(32), VR_ON);
    await until(() => row(H.mh, 'Krobs')?.tableMatch === true && row(C.mh, 'Krobs')?.tableMatch === true);
    await until(() => row(C.mh, 'Owner')?.rig === 'vr_headset');
    expect(row(H.mh, 'Owner')?.rig).toBe('vr_headset');
  }, 15_000);
});
