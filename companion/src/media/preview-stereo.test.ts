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

  it('the Match-tab setting wins; on auto a monitor rig sends one picture, a VR rig both eyes only when its ini says so, else one eye (ADR 0009)', () => {
    expect(declaredStereo('sbs', false, null)).toBe('sbs');
    expect(declaredStereo('mono', true, 'sbs')).toBe('mono');
    expect(declaredStereo('auto', false, 'sbs')).toBe('mono');
    expect(declaredStereo('auto', true, 'sbs')).toBe('sbs'); // the picture really is both eyes: the receiver must place it so
    expect(declaredStereo('auto', true, 'mono')).toBe('mono');
    expect(declaredStereo('auto', true, null)).toBe('mono'); // no ini found: VPX's default is the left eye, the receivers no longer guess
  });

  it('the Match-tab advice (ADR 0009): both eyes asks for one eye whatever the window; one eye, or no picture, says nothing', () => {
    expect(previewAdvice({ inVr: true, declared: 'sbs', crop: { width: 1920, height: 1080 } })).toMatch(/^You are sending both eyes side by side.*Preview: Left Eye.*switch Camera to the VR layer\.$/);
    expect(previewAdvice({ inVr: true, declared: 'sbs', crop: { width: 1440, height: 1392 } })).toMatch(/^You are sending both eyes side by side/); // the owner's 0.2.35 window: still both eyes
    expect(previewAdvice({ inVr: true, declared: 'mono', crop: { width: 1280, height: 720 } })).toBeNull();
    expect(previewAdvice({ inVr: true, declared: null, crop: { width: 1280, height: 720 } })).toBeNull();
    expect(previewAdvice({ inVr: false, declared: 'sbs', crop: { width: 1920, height: 1080 } })).toBeNull(); // a monitor rig is never advised
    expect(previewAdvice({ inVr: true, declared: 'sbs', crop: null })).toBeNull();
  });
});
