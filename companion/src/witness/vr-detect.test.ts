import { describe, expect, it } from 'vitest';
import { createPowershellVrProbe, describeVr, parseVrProbe, playDeviceFor, vrProbeQuery } from './vr-detect.js';

const NOW = () => Date.UTC(2026, 9, 21, 1, 2, 3);

describe('vr-detect', () => {
  it('reads "in VR" only when the OpenVR runtime client is in the process AND the SteamVR compositor runs', () => {
    const both = parseVrProbe('{"Alive":true,"Modules":["openvr_api64.dll","vrclient_x64.dll"],"Compositor":["vrcompositor","vrserver"]}', NOW);
    expect(both).toEqual({ inVr: true, runtimeLoaded: true, compositorRunning: true, vrCapableBuild: true, sampledAt: '2026-10-21T01:02:03.000Z' });
    expect(playDeviceFor(both)).toBe('vr_headset');
    expect(describeVr(both!)).toBe('played in a VR headset');

    // The VR build on a monitor: openvr_api is linked in, nothing else.
    const flat = parseVrProbe('{"Alive":true,"Modules":["openvr_api64.dll"],"Compositor":[]}', NOW);
    expect(flat).toMatchObject({ inVr: false, runtimeLoaded: false, compositorRunning: false, vrCapableBuild: true });
    expect(playDeviceFor(flat)).toBe('pc');
    expect(describeVr(flat!)).toBe('played on the monitor');

    // SteamVR left open while VPX ran flat, or the client probed for a headset and found none.
    const stray = parseVrProbe('{"Alive":true,"Modules":["openvr_api64.dll","vrclient_x64.dll"],"Compositor":[]}', NOW);
    expect(stray).toMatchObject({ inVr: false, runtimeLoaded: true, compositorRunning: false });
    expect(describeVr(stray!)).toMatch(/monitor/);
    const idle = parseVrProbe('{"Alive":true,"Modules":[],"Compositor":["vrcompositor"]}', NOW);
    expect(idle).toMatchObject({ inVr: false, runtimeLoaded: false, compositorRunning: true, vrCapableBuild: false });
  });

  it('tolerates PowerShell collapsing one-element lists to strings, and says nothing about a gone process', () => {
    expect(parseVrProbe('{"Alive":true,"Modules":"vrclient_x64.dll","Compositor":"vrcompositor"}', NOW)).toMatchObject({ inVr: true });
    expect(parseVrProbe('{"Alive":false,"Modules":[],"Compositor":["vrcompositor"]}', NOW)).toBeNull();
    expect(parseVrProbe('', NOW)).toBeNull();
    expect(parseVrProbe('not json', NOW)).toBeNull();
    expect(playDeviceFor(null)).toBeNull();
  });

  it('asks PowerShell about the one pid and the SteamVR processes', async () => {
    expect(vrProbeQuery(4321)).toContain('$vpxPid = 4321;');
    expect(vrProbeQuery(4321)).toContain('Get-Process -Name vrcompositor,vrserver');
    expect(() => vrProbeQuery(0)).toThrow();

    const calls: string[][] = [];
    const probe = createPowershellVrProbe((file, args, cb) => {
      calls.push([file, ...args]);
      cb(null, '{"Alive":true,"Modules":["vrclient_x64.dll"],"Compositor":["vrcompositor"]}');
    }, NOW);
    expect(await probe.sample(4321)).toMatchObject({ inVr: true });
    expect(calls[0]?.[0]).toBe('powershell.exe');
    expect(calls[0]?.slice(1, 4)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);

    const failing = createPowershellVrProbe((_f, _a, cb) => cb(new Error('no powershell')), NOW);
    await expect(failing.sample(1)).rejects.toThrow('no powershell');
  });
});
