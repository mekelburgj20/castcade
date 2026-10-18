/**
 * Ed25519 keys and the two signing helpers every participant uses: `signCanonical` /
 * `verifyCanonical` sign the canonical JSON of an object (grants, log heads, results), and
 * `sha256Hex` is the log hash. Public keys travel as the 32 raw bytes in base64, as the
 * protocol's `PublicKey` demands; `node:crypto` wants SPKI DER, so we add/strip the fixed
 * 12-byte Ed25519 SPKI prefix.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@castcade/protocol';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface KeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  /** The 32 raw public-key bytes, base64. What goes into ParticipantInfo.publicKey. */
  readonly publicKeyB64: string;
}

export function generateKeys(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey, publicKeyB64: exportPublicKeyB64(publicKey) };
}

export function exportPublicKeyB64(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

export function importPublicKey(b64: string): KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error(`public key must be 32 raw bytes, got ${raw.length}`);
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Ed25519 signature over the UTF-8 bytes of canonicalJson(obj), base64. */
export function signCanonical(obj: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalJson(obj), 'utf8'), privateKey).toString('base64');
}

/** Returns false on a bad signature or an unparsable key; never throws. */
export function verifyCanonical(obj: unknown, sigB64: string, publicKeyB64: string): boolean {
  try {
    const data = Buffer.from(canonicalJson(obj), 'utf8');
    return verify(null, data, importPublicKey(publicKeyB64), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
