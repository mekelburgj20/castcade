import { describe, expect, it } from 'vitest';
import { exportPublicKeyB64, generateKeys, importPublicKey, sha256Hex, signCanonical, verifyCanonical } from './keys.js';

describe('keys', () => {
  it('exports a 32-byte raw public key as base64 and imports it back', () => {
    const k = generateKeys();
    const raw = Buffer.from(k.publicKeyB64, 'base64');
    expect(raw.length).toBe(32);
    expect(k.publicKeyB64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const back = importPublicKey(k.publicKeyB64);
    expect(exportPublicKeyB64(back)).toBe(k.publicKeyB64);
    expect(() => importPublicKey(Buffer.alloc(31).toString('base64'))).toThrow(/32 raw bytes/);
  });

  it('signs canonical JSON regardless of key order and rejects tampering or the wrong key', () => {
    const k = generateKeys();
    const other = generateKeys();
    const sig = signCanonical({ b: 1, a: 'x' }, k.privateKey);
    expect(Buffer.from(sig, 'base64').length).toBe(64);
    expect(verifyCanonical({ a: 'x', b: 1 }, sig, k.publicKeyB64)).toBe(true);
    expect(verifyCanonical({ a: 'x', b: 2 }, sig, k.publicKeyB64)).toBe(false);
    expect(verifyCanonical({ a: 'x', b: 1 }, sig, other.publicKeyB64)).toBe(false);
    expect(verifyCanonical({ a: 'x', b: 1 }, 'not base64 at all!', k.publicKeyB64)).toBe(false);
    expect(verifyCanonical({ a: 'x', b: 1 }, sig, 'AAAA')).toBe(false);
  });

  it('sha256Hex matches the known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
