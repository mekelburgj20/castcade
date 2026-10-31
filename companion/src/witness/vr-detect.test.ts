import { describe, expect, it } from 'vitest';
import { createPowershellVrProbe, describeVr, describeVrEvidence, parseVrProbe, playDeviceFor, vrProbeQuery, vrRuntimeOf, type VrObservation } from './vr-detect.js';

const NOW = () => Date.UTC(2026, 9, 21, 1, 2, 3);

const probe = (o: { Modules?: string[]; Compositor?: string[]; Servers?: string[]; ActiveRuntime?: string | null }) =>
  parseVrProbe(JSON.stringify({ Alive: true, Modules: [], Compositor: [], Servers: [], ActiveRuntime: null, ...o }), NOW);

const VD_JSON = 'C:\\Program Files\\Virtual Desktop Streamer\\OpenXR\\virtualdesktop-openxr.json';
const OCULUS_JSON = 'C:\\Program Files\\Oculus\\Support\\oculus-runtime\\oculus_openxr_64.json';

describe('vr-detect', () => {
  it('reads "in VR" only when the OpenVR runtime client is in the process AND the SteamVR compositor runs', () => {
    const both = parseVrProbe('{"Alive":true,"Modules":["openvr_api64.dll","vrclient_x64.dll"],"Compositor":["vrcompositor","vrserver"]}', NOW);
    expect(both).toEqual({
      inVr: true,
      runtime: 'steamvr',
      runtimeLoaded: true,
      compositorRunning: true,
      vrCapableBuild: true,
      activeOpenXrRuntime: null,
      sampledAt: '2026-10-21T01:02:03.000Z',
    });
    expect(playDeviceFor(both)).toBe('vr_headset');
    expect(describeVr(both!)).toBe('played in a VR headset via SteamVR');
    expect(describeVrEvidence(both!)).toBe('vrclient loaded, compositor running');

    // The VR build on a monitor: openvr_api is linked in, nothing else.
    const flat = parseVrProbe('{"Alive":true,"Modules":["openvr_api64.dll"],"Compositor":[]}', NOW);
    expect(flat).toMatchObject({ inVr: false, runtime: null, runtimeLoaded: false, compositorRunning: false, vrCapableBuild: true });
    expect(playDeviceFor(flat)).toBe('pc');
    expect(describeVr(flat!)).toBe('played on the monitor');

    // SteamVR left open while VPX ran flat, or the client probed for a headset and found none.
    const stray = parseVrProbe('{"Alive":true,"Modules":["openvr_api64.dll","vrclient_x64.dll"],"Compositor":[]}', NOW);
    expect(stray).toMatchObject({ inVr: false, runtimeLoaded: true, compositorRunning: false });
    expect(describeVr(stray!)).toMatch(/monitor/);
    const idle = parseVrProbe('{"Alive":true,"Modules":[],"Compositor":["vrcompositor"]}', NOW);
    expect(idle).toMatchObject({ inVr: false, runtimeLoaded: false, compositorRunning: true, vrCapableBuild: false });
  });

  it("B22: the owner's rig (VPX 10.8.0.2078 Panasony on Virtual Desktop's OpenXR runtime, 2026-10-31) reads virtual-desktop", () => {
    const owner = probe({
      Modules: ['openvr_api64.dll', 'virtualdesktop-openxr.dll', 'openxr-oculus-compatibility.dll', 'VirtualDesktop.LibOVRRT64_1.dll'],
      Compositor: [],
      Servers: ['VirtualDesktop.Server'],
      ActiveRuntime: VD_JSON,
    });
    expect(owner).toMatchObject({ inVr: true, runtime: 'virtual-desktop', runtimeLoaded: false, compositorRunning: false, vrCapableBuild: true, activeOpenXrRuntime: VD_JSON });
    expect(playDeviceFor(owner)).toBe('vr_headset');
    expect(describeVr(owner!)).toBe('played in a VR headset via Virtual Desktop (OpenXR)');
    expect(describeVrEvidence(owner!)).toBe(`Virtual Desktop (OpenXR), vrclient not loaded, compositor not running, active OpenXR runtime ${VD_JSON}`);

    // The runtime dll alone is enough (the server's process name may change across Virtual Desktop versions).
    expect(probe({ Modules: ['virtualdesktop-openxr.dll'] })?.runtime).toBe('virtual-desktop');
    // A differently named VD runtime dll: the registry and the running server say whose it is.
    expect(probe({ Modules: ['openxr_loader.dll'], Servers: ['VirtualDesktop.Server'], ActiveRuntime: VD_JSON })?.runtime).toBe('virtual-desktop');
  });

  it('B22: VPX flat while Virtual Desktop streams the desktop stays on the monitor (no XR dll in the process)', () => {
    const flat = probe({ Modules: ['openvr_api64.dll'], Servers: ['VirtualDesktop.Server'], ActiveRuntime: VD_JSON });
    expect(flat).toMatchObject({ inVr: false, runtime: null, activeOpenXrRuntime: VD_JSON });
    expect(playDeviceFor(flat)).toBe('pc');
    expect(describeVrEvidence(flat!)).toBe(`vrclient not loaded, compositor not running, active OpenXR runtime ${VD_JSON}`);
  });

  it('B22: SteamVR wins over Virtual Desktop when VPX went through SteamVR (VD → Launch SteamVR)', () => {
    const viaSteam = probe({
      Modules: ['openvr_api64.dll', 'vrclient_x64.dll'],
      Compositor: ['vrcompositor', 'vrserver'],
      Servers: ['VirtualDesktop.Server'],
      ActiveRuntime: VD_JSON,
    });
    expect(viaSteam?.runtime).toBe('steamvr');
  });

  it('B22: the Oculus / Meta runtime needs OVRServer_x64, and VD\'s own LibOVRRT copy is not it', () => {
    expect(probe({ Modules: ['openvr_api64.dll', 'LibOVRRT64_1.dll'], Servers: ['OVRServer_x64'], ActiveRuntime: OCULUS_JSON })).toMatchObject({ inVr: true, runtime: 'oculus' });
    expect(probe({ Modules: ['openxr_loader.dll'], Servers: ['OVRServer_x64'], ActiveRuntime: OCULUS_JSON })?.runtime).toBe('oculus');
    expect(describeVr(probe({ Modules: ['LibOVRRT64_1.dll'], Servers: ['OVRServer_x64'] })!)).toBe('played in a VR headset via the Oculus / Meta runtime (OpenXR)');
    // The Oculus dll with no Oculus service: nothing is driving a headset through it.
    expect(probe({ Modules: ['LibOVRRT64_1.dll'], Servers: [] })?.runtime).toBeNull();
    // Virtual Desktop's compatibility shim and its renamed LibOVRRT copy do not read as Oculus.
    expect(probe({ Modules: ['VirtualDesktop.LibOVRRT64_1.dll'], Servers: ['OVRServer_x64'] })?.runtime).toBeNull();
  });

  it('B22: another OpenXR runtime: an OpenXR dll in the process and the registry naming a runtime', () => {
    const wmr = 'C:\\WINDOWS\\system32\\MixedRealityRuntime.json';
    expect(probe({ Modules: ['openxr_loader.dll'], ActiveRuntime: wmr })).toMatchObject({ inVr: true, runtime: 'openxr-other', activeOpenXrRuntime: wmr });
    expect(describeVr(probe({ Modules: ['openxr_loader.dll'], ActiveRuntime: wmr })!)).toBe('played in a VR headset via an OpenXR runtime');
    // The loader with no runtime registered: nothing to load, so no headset.
    expect(probe({ Modules: ['openxr_loader.dll'], ActiveRuntime: null })?.runtime).toBeNull();
    expect(probe({ Modules: ['openxr_loader.dll'], ActiveRuntime: '  ' })).toMatchObject({ runtime: null, activeOpenXrRuntime: null });
  });

  it('a sample from before B22 (no runtime field) keeps SteamVR\'s reading', () => {
    const old = { inVr: true, runtimeLoaded: true, compositorRunning: true, vrCapableBuild: true, sampledAt: '2026-10-21T00:00:00.000Z' } as unknown as VrObservation;
    expect(vrRuntimeOf(old)).toBe('steamvr');
    expect(describeVr(old)).toBe('played in a VR headset via SteamVR');
    expect(vrRuntimeOf({ ...old, inVr: false })).toBeNull();
    expect(vrRuntimeOf(null)).toBeNull();
  });

  it('tolerates PowerShell collapsing one-element lists to strings, and says nothing about a gone process', () => {
    expect(parseVrProbe('{"Alive":true,"Modules":"vrclient_x64.dll","Compositor":"vrcompositor"}', NOW)).toMatchObject({ inVr: true });
    expect(parseVrProbe('{"Alive":true,"Modules":"virtualdesktop-openxr.dll","Compositor":[],"Servers":"VirtualDesktop.Server","ActiveRuntime":null}', NOW)).toMatchObject({ runtime: 'virtual-desktop' });
    expect(parseVrProbe('{"Alive":false,"Modules":[],"Compositor":["vrcompositor"]}', NOW)).toBeNull();
    expect(parseVrProbe('', NOW)).toBeNull();
    expect(parseVrProbe('not json', NOW)).toBeNull();
    expect(playDeviceFor(null)).toBeNull();
  });

  it('asks PowerShell about the one pid, the SteamVR processes, the other runtimes\' servers and the active OpenXR runtime', async () => {
    const q = vrProbeQuery(4321);
    expect(q).toContain('$vpxPid = 4321;');
    expect(q).toContain('Get-Process -Name vrcompositor,vrserver');
    expect(q).toContain("Get-Process -Name 'VirtualDesktop.Server','OVRServer_x64'");
    expect(q).toContain("Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Khronos\\OpenXR\\1' -Name ActiveRuntime");
    expect(q).toContain("-match 'vrclient|openvr_api|openxr|libovrrt'");
    expect(() => vrProbeQuery(0)).toThrow();

    const calls: string[][] = [];
    const p = createPowershellVrProbe((file, args, cb) => {
      calls.push([file, ...args]);
      cb(null, '{"Alive":true,"Modules":["vrclient_x64.dll"],"Compositor":["vrcompositor"]}');
    }, NOW);
    expect(await p.sample(4321)).toMatchObject({ inVr: true });
    expect(calls[0]?.[0]).toBe('powershell.exe');
    expect(calls[0]?.slice(1, 4)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);

    const failing = createPowershellVrProbe((_f, _a, cb) => cb(new Error('no powershell')), NOW);
    await expect(failing.sample(1)).rejects.toThrow('no powershell');
  });
});
