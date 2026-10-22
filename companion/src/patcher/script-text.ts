/**
 * Byte-faithful text handling for table scripts.
 *
 * VPX stores a table script as ANSI (cp1252) bytes. The patcher never needs to interpret them: it
 * only finds ASCII anchors and inserts ASCII lines. So a script travels as a latin1 string (one char
 * per byte, code points 0..255) and `encodeScript` gives back exactly the bytes it came from. Line
 * endings are kept as found (CRLF or LF, whichever dominates, as the Phase 0 renderer did).
 */

export function decodeScript(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

export function encodeScript(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

export type Newline = '\r\n' | '\n';

export interface ScriptLines {
  lines: string[];
  newline: Newline;
  /** Whether the text ended with `newline` (so the render can end the same way). */
  trailingNewline: boolean;
}

function count(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Split on the dominant newline (CRLF when at least half the LFs are CRLFs), dropping one trailing empty line. */
export function splitScript(text: string): ScriptLines {
  const crlf = count(text, '\r\n');
  const lf = count(text, '\n');
  const newline: Newline = crlf > 0 && crlf >= Math.floor(lf / 2) ? '\r\n' : '\n';
  const lines = text.split(newline);
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  return { lines, newline, trailingNewline };
}

export function joinScript(s: ScriptLines): string {
  return s.lines.join(s.newline) + (s.trailingNewline ? s.newline : '');
}

/** The code part of a VBScript line: the text before a `'` that is outside a string literal. */
export function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inStr = !inStr;
    else if (ch === "'" && !inStr) return line.slice(0, i);
  }
  return line;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index of the first line in `[start, end)` whose code part matches `rx` (case-insensitive), or -1. */
export function findLine(lines: readonly string[], rx: RegExp, start = 0, end = lines.length): number {
  const r = new RegExp(rx.source, rx.flags.includes('i') ? rx.flags : rx.flags + 'i');
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (line !== undefined && r.test(stripComment(line))) return i;
  }
  return -1;
}

/** `[start, end]` line indexes of `Sub <name>` ... `End Sub` (or Function), or `[-1, -1]`. */
export function findSub(lines: readonly string[], name: string): [number, number] {
  const s = findLine(lines, new RegExp(`^\\s*(Public\\s+|Private\\s+)?(Sub|Function)\\s+${escapeRegExp(name)}\\s*(\\(|$)`));
  if (s < 0) return [-1, -1];
  return [s, findLine(lines, /^\s*End\s+(Sub|Function)\b/, s + 1)];
}

/** True when `ident` appears as a whole word in the code part of any line. */
export function hasIdent(lines: readonly string[], ident: string): boolean {
  const rx = new RegExp(`\\b${escapeRegExp(ident)}\\b`, 'i');
  return lines.some((l) => rx.test(stripComment(l)));
}

/**
 * A VBScript string expression for `s` made of ASCII only: printable ASCII runs become `"..."` (with
 * `"` doubled) and every other character becomes `ChrW(n)`, so a path or table name with accents or
 * CJK characters is exact regardless of the code page VPX reads the sidecar with.
 */
export function vbStringLiteral(s: string): string {
  const parts: string[] = [];
  let run = '';
  const flush = () => {
    if (run !== '') parts.push(`"${run.replace(/"/g, '""')}"`);
    run = '';
  };
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code < 0x7f) run += s[i];
    else {
      flush();
      parts.push(`ChrW(${code})`);
    }
  }
  flush();
  return parts.length === 0 ? '""' : parts.join(' & ');
}
