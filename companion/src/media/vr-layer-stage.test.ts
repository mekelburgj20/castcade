import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLayerAgeWatch,
  planStage,
  readRegisteredAt,
  REGISTERED_AT_FILE,
  stageFolderName,
  stageVrLayer,
  VPX_BEFORE_LAYER_TEXT,
  vpxStartedBeforeRegistration,
  VR_LAYER_DLL,
  vrLayerStageRoot,
  writeRegisteredAt,
} from './vr-layer-stage.js';
import { VR_LAYER_JSON } from './vr-layer.js';

describe('planStage', () => {
  const base = { version: '0.2.30', sourceSha: 'aa', stagedSha: 'aa', stagedJson: true, folders: ['0.2.30'] };

  it('skips the copy when this version is staged with the same dll', () => {
    expect(planStage(base)).toEqual({ copy: false, remove: [] });
  });

  it('copies when the folder is missing, lacks the manifest, or its dll differs', () => {
    expect(planStage({ ...base, stagedSha: null, folders: [] }).copy).toBe(true);
    expect(planStage({ ...base, stagedJson: false }).copy).toBe(true);
    expect(planStage({ ...base, stagedSha: 'bb' }).copy).toBe(true);
  });

  it("removes every other version's folder, never this one (case-insensitive)", () => {
    expect(planStage({ ...base, version: '0.2.30', folders: ['0.2.28', '0.2.30', '0.2.29', 'dev'] }).remove).toEqual(['0.2.28', '0.2.29', 'dev']);
    expect(planStage({ ...base, version: '0.3.0-Beta', folders: ['0.3.0-beta'] }).remove).toEqual([]);
  });
});

describe('vpxStartedBeforeRegistration', () => {
  it('true only when both times are known and VPX started first', () => {
    expect(vpxStartedBeforeRegistration(1000, 2000)).toBe(true);
    expect(vpxStartedBeforeRegistration(2000, 2000)).toBe(false);
    expect(vpxStartedBeforeRegistration(3000, 2000)).toBe(false);
    expect(vpxStartedBeforeRegistration(null, 2000)).toBe(false);
    expect(vpxStartedBeforeRegistration(1000, null)).toBe(false);
  });
});

describe('paths', () => {
  it('stages under %LOCALAPPDATA%\\Castcade\\vr-layer, else userData', () => {
    expect(vrLayerStageRoot({ LOCALAPPDATA: 'C:\\L' }, 'C:\\U')).toBe(join('C:\\L', 'Castcade', 'vr-layer'));
    expect(vrLayerStageRoot({}, 'C:\\U')).toBe(join('C:\\U', 'vr-layer'));
  });

  it('a version is a safe folder name', () => {
    expect(stageFolderName('0.2.30')).toBe('0.2.30');
    expect(stageFolderName('0.3.0-beta.1')).toBe('0.3.0-beta.1');
    expect(stageFolderName('a/b\\c')).toBe('a_b_c');
    expect(stageFolderName('..')).toBe('unknown');
  });
});

describe('stageVrLayer', () => {
  let tmp = '';
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  const manifest = (lib = './XrApiLayer_castcade_panel.dll') => JSON.stringify({ file_format_version: '1.0.0', api_layer: { name: 'XR_APILAYER_CASTCADE_panel', library_path: lib } });

  function fixture(dll = 'dll-v2') {
    tmp = mkdtempSync(join(tmpdir(), 'castcade-stage-'));
    const src = join(tmp, 'resources', 'vr-layer');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, VR_LAYER_DLL), dll);
    writeFileSync(join(src, VR_LAYER_JSON), manifest());
    writeFileSync(join(src, 'THIRD-PARTY.md'), 'notices');
    writeFileSync(join(src, 'VERSION'), 'castcade-vr-layer-v0.2.30-win-x64 sha256:x url\n');
    const root = join(tmp, 'stage');
    return { src, root };
  }

  it('copies into <root>/<version>, then skips while the dll matches, and re-copies when it changes', () => {
    const { src, root } = fixture();
    const log: string[] = [];
    const first = stageVrLayer({ sourceDir: src, root, version: '0.2.30', log: (l) => log.push(l) });
    expect(first).toEqual({ dir: join(root, '0.2.30'), jsonPath: join(root, '0.2.30', VR_LAYER_JSON), copied: true });
    for (const f of [VR_LAYER_DLL, VR_LAYER_JSON, 'THIRD-PARTY.md', 'VERSION']) expect(existsSync(join(root, '0.2.30', f))).toBe(true);

    writeRegisteredAt(first!.dir, 1234);
    expect(stageVrLayer({ sourceDir: src, root, version: '0.2.30', log: (l) => log.push(l) })?.copied).toBe(false);
    expect(readRegisteredAt(first!.dir)).toBe(1234);

    writeFileSync(join(src, VR_LAYER_DLL), 'dll-v3');
    const again = stageVrLayer({ sourceDir: src, root, version: '0.2.30', log: (l) => log.push(l) });
    expect(again?.copied).toBe(true);
    expect(readFileSync(join(root, '0.2.30', VR_LAYER_DLL), 'utf8')).toBe('dll-v3');
    // The stamp belonged to the old files.
    expect(existsSync(join(root, '0.2.30', REGISTERED_AT_FILE))).toBe(false);
  });

  it('removes older versions; one whose dll is held stays, logged', () => {
    const { src, root } = fixture();
    for (const v of ['0.2.28', '0.2.29']) {
      mkdirSync(join(root, v), { recursive: true });
      writeFileSync(join(root, v, VR_LAYER_DLL), 'old');
      writeFileSync(join(root, v, VR_LAYER_JSON), manifest());
    }
    const log: string[] = [];
    const remove = vi.fn((path: string, recursive: boolean) => {
      if (path === join(root, '0.2.29', VR_LAYER_DLL)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      rmSync(path, { recursive, force: true });
    });
    const out = stageVrLayer({ sourceDir: src, root, version: '0.2.30', log: (l) => log.push(l), remove });
    expect(out?.jsonPath).toBe(join(root, '0.2.30', VR_LAYER_JSON));
    expect(existsSync(join(root, '0.2.28'))).toBe(false);
    expect(existsSync(join(root, '0.2.29', VR_LAYER_DLL))).toBe(true);
    expect(existsSync(join(root, '0.2.29', VR_LAYER_JSON))).toBe(true);
    expect(log.filter((l) => l.includes('left the older layer copy') && l.includes('0.2.29') && l.includes('EBUSY'))).toHaveLength(1);
    expect(log.some((l) => l.includes('removed the older layer copy') && l.includes('0.2.28'))).toBe(true);
  });

  it("a manifest whose dll does not resolve beside it falls back (null), as does a resource without the dll", () => {
    const { src, root } = fixture();
    writeFileSync(join(src, VR_LAYER_JSON), manifest('./elsewhere/x.dll'));
    const log: string[] = [];
    expect(stageVrLayer({ sourceDir: src, root, version: '0.2.30', log: (l) => log.push(l) })).toBeNull();
    expect(log.some((l) => l.includes('is not there'))).toBe(true);
    rmSync(join(src, VR_LAYER_DLL));
    expect(stageVrLayer({ sourceDir: src, root, version: '0.2.30', log: (l) => log.push(l) })).toBeNull();
  });
});

describe('createLayerAgeWatch', () => {
  function setup() {
    let pid: number | null = null;
    let started: number | null = null;
    const startedCalls: number[] = [];
    const log: string[] = [];
    const w = createLayerAgeWatch({
      vpxPid: () => pid,
      vpxStartedAt: () => {
        startedCalls.push(pid!);
        return started;
      },
      log: (l) => log.push(l),
    });
    const changes = vi.fn();
    w.onChange(changes);
    return {
      w,
      log,
      changes,
      startedCalls,
      vpx(p: number | null, s: number | null = null) {
        pid = p;
        started = s;
      },
    };
  }

  it('stale while a VPX that started before the registration runs; clears on a new pid (restart); logs each', () => {
    const t = setup();
    t.vpx(10, 1000);
    t.w.setRegisteredAt(5000);
    expect(t.w.stale()).toBe(true);
    expect(t.log).toHaveLength(1);
    expect(t.log[0]).toContain(VPX_BEFORE_LAYER_TEXT);
    t.w.check();
    t.w.check();
    expect(t.log).toHaveLength(1);
    // The start time is looked up once per pid.
    expect(t.startedCalls).toEqual([10]);

    t.vpx(11, 9000);
    t.w.check();
    expect(t.w.stale()).toBe(false);
    expect(t.log[1]).toContain('VPX restarted (pid 11)');
    expect(t.changes).toHaveBeenCalledTimes(2);
  });

  it('a VPX started after the registration, an unknown start or no registration: never stale', () => {
    const t = setup();
    t.vpx(10, 9000);
    t.w.setRegisteredAt(5000);
    expect(t.w.stale()).toBe(false);
    t.vpx(12, null);
    t.w.check();
    expect(t.w.stale()).toBe(false);
    t.w.setRegisteredAt(null);
    t.vpx(13, 1);
    t.w.check();
    expect(t.w.stale()).toBe(false);
    expect(t.log).toEqual([]);
  });

  it('VPX exiting clears it', () => {
    const t = setup();
    t.vpx(10, 1000);
    t.w.setRegisteredAt(5000);
    t.vpx(null);
    t.w.check();
    expect(t.w.stale()).toBe(false);
    expect(t.log[1]).toContain('exited');
  });

  it('the timer looks every 5 s', () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.w.setRegisteredAt(5000);
      t.w.start();
      t.vpx(10, 1000);
      vi.advanceTimersByTime(4999);
      expect(t.w.stale()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(t.w.stale()).toBe(true);
      t.w.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
