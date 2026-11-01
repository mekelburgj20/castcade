import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../witness/fs.js';
import { declaredStereo, previewAdvice, readIniStereo, stereoFromIni } from './preview-stereo.js';

const EXE = 'C:\\VPX\\VPinballX64.exe';
const APPDATA = 'C:\\Users\\p\\AppData\\Roaming';

describe('the sender declares its stereo (D7.4.3, 2026-11-01)', () => {
  it('[PlayerVR] VRPreview = 3 is both eyes; any other value, or none (VPX defaults to the left eye), one picture', () => {
    expect(stereoFromIni('[PlayerVR]\r\nVRPreview = 3\r\n')).toBe('sbs');
    expect(stereoFromIni('[playervr]\nvrpreview=3.0\n')).toBe('sbs');
    expect(stereoFromIni('[PlayerVR]\nVRPreview = 1\n')).toBe('mono');
    expect(stereoFromIni('[PlayerVR]\nVRPreview = 0\n')).toBe('mono');
    expect(stereoFromIni('[Player]\nVRPreview = 3\n')).toBe('mono'); // another section
    expect(stereoFromIni('[PlayerVR]\nVRPreview = 3\nVRPreview = 1\n')).toBe('mono'); // the last one wins, as in VPX
    expect(stereoFromIni('')).toBe('mono');
    expect(stereoFromIni(null)).toBeNull();
  });

  it('reads the active ini: the one beside the exe wins over the per-user one; none, or no exe known, is null', async () => {
    const fs = new MemoryFs();
    const env = { APPDATA };
    expect(await readIniStereo({ fs, exe: null, env })).toEqual({ stereo: null, ini: null });
    expect(await readIniStereo({ fs, exe: EXE, env })).toEqual({ stereo: null, ini: null });
    fs.put(`${APPDATA}\\VPinballX\\VPinballX.ini`, '[PlayerVR]\nVRPreview = 3\n');
    expect(await readIniStereo({ fs, exe: EXE, env })).toEqual({ stereo: 'sbs', ini: `${APPDATA}\\VPinballX\\VPinballX.ini` });
    fs.put('C:\\VPX\\VPinballX.ini', '[PlayerVR]\nVRPreview = 1\n');
    expect(await readIniStereo({ fs, exe: EXE, env })).toEqual({ stereo: 'mono', ini: 'C:\\VPX\\VPinballX.ini' });
  });

  it('the Match-tab setting wins; on auto a monitor rig sends one picture and a VR rig says what its ini says', () => {
    expect(declaredStereo('sbs', false, null)).toBe('sbs');
    expect(declaredStereo('mono', true, 'sbs')).toBe('mono');
    expect(declaredStereo('auto', false, 'sbs')).toBe('mono');
    expect(declaredStereo('auto', true, 'sbs')).toBe('sbs');
    expect(declaredStereo('auto', true, null)).toBeNull();
  });

  it('the Match-tab advice: both eyes in a 16:9 window says so; a tall-enough window says nothing; one eye asks for both', () => {
    expect(previewAdvice({ inVr: true, declared: 'sbs', crop: { width: 1920, height: 1080 } })).toMatch(/^Both eyes is on but the window is 16:9 \(1920x1080\).*as tall as your monitor and about as wide/);
    expect(previewAdvice({ inVr: true, declared: 'sbs', crop: { width: 1920, height: 540 } })).toMatch(/^Both eyes is on but the window is wider than tall \(1920x540\)/);
    expect(previewAdvice({ inVr: true, declared: 'sbs', crop: { width: 1440, height: 1392 } })).toBeNull(); // the owner's
    expect(previewAdvice({ inVr: true, declared: 'sbs', crop: { width: 1080, height: 1080 } })).toBeNull();
    expect(previewAdvice({ inVr: true, declared: 'mono', crop: { width: 1280, height: 720 } })).toMatch(/^You are sending one eye\. Set VPX's VR preview to both eyes/);
    expect(previewAdvice({ inVr: true, declared: null, crop: { width: 1280, height: 720 } })).toMatch(/could not read VPX's VR preview setting/);
    expect(previewAdvice({ inVr: false, declared: 'mono', crop: { width: 1280, height: 720 } })).toBeNull();
    expect(previewAdvice({ inVr: true, declared: 'mono', crop: null })).toBeNull();
  });
});
