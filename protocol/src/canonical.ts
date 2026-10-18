/**
 * Canonical JSON: the one byte-for-byte serialization every participant uses before hashing or
 * signing. Rules: object keys sorted by UTF-16 code unit order, no whitespace, `undefined`
 * properties dropped, no NaN/Infinity (throws), numbers as JSON.stringify prints them.
 *
 * Both the companion and the fake client hash log entries and grants through this function, so
 * their log hashes agree. Any other implementation (a future producer in another language) must
 * reproduce it exactly; the conformance samples in `fixtures/canonical.json` pin the behaviour.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError(`canonicalJson: bigint at ${path}`);
    case 'undefined':
      throw new TypeError(`canonicalJson: undefined at ${path}`);
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => serialize(v === undefined ? null : v, `${path}[${i}]`)).join(',') + ']';
  }
  if (value instanceof Uint8Array) {
    throw new TypeError(`canonicalJson: binary at ${path}; encode as base64 first`);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k], `${path}.${k}`)).join(',') + '}';
}
