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
  /**
   * The ending that followed each line as found (`\r\n`, `\n` or `\r`; `''` for a last line without one), one
   * per line. A script with mixed endings (VPW multi-author scripts: Krobs' Twilight Zone, 2026-11-06, C13) keeps
   * every line's own ending through a render and an unpatch, so the round trip stays byte-exact.
   */
  endings: string[];
  /** The dominant newline (CRLF when at least half the LFs are CRLFs): what inserted lines get. */
  newline: Newline;
  /** Whether the text ended with a newline (so the render can end the same way). */
  trailingNewline: boolean;
}

const NEWLINE_RX = /\r\n|\r|\n/g;

/**
 * Split on every newline (`\r\n`, `\n` or `\r`), so no logical line ever hides inside another: splitting on the
 * dominant newline alone (0.2.11–0.2.36) folded an LF-only run of a CRLF script into one chunk, where `^` could not
 * match and the first comment apostrophe cut the rest off, and the classifier refused the table with "no _KeyDown
 * handler". One trailing empty line is dropped and remembered as `trailingNewline`.
 */
export function splitScript(text: string): ScriptLines {
  const lines: string[] = [];
  const endings: string[] = [];
  let crlf = 0;
  let lf = 0;
  let last = 0;
  NEWLINE_RX.lastIndex = 0;
  for (let m = NEWLINE_RX.exec(text); m !== null; m = NEWLINE_RX.exec(text)) {
    lines.push(text.slice(last, m.index));
    endings.push(m[0]);
    if (m[0] === '\r\n') crlf++;
    else if (m[0] === '\n') lf++;
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  const trailingNewline = lines.length > 0 && tail === '';
  if (!trailingNewline) {
    lines.push(tail);
    endings.push('');
  }
  // `lf` here is the bare LFs; the rule counts every LF as before (CRLF when at least half of all LFs are CRLFs).
  const newline: Newline = crlf > 0 && crlf >= Math.floor((crlf + lf) / 2) ? '\r\n' : '\n';
  return { lines, endings, newline, trailingNewline };
}

/**
 * Join lines back to text: each line with its own ending where one is known (`endings[i]`, the same index as
 * `lines[i]`), the dominant `newline` for a line without one (an inserted line, or a last line that had none when
 * `trailingNewline` asks for one). The last line gets no ending unless `trailingNewline`.
 */
export function joinScript(s: Omit<ScriptLines, 'endings'> & { endings?: readonly string[] }): string {
  const n = s.lines.length;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(s.lines[i] ?? '');
    if (i < n - 1 || s.trailingNewline) parts.push(s.endings?.[i] || s.newline);
  }
  return parts.join('');
}

/**
 * True when the decoded text is UTF-16 rather than the ANSI VPX writes: a byte-order mark, or NULs through the
 * first 4 KB (every other byte of ASCII text). Decoded as latin1 such a script classifies as X with a misleading
 * "no _KeyDown handler"; the classifier names the encoding instead (C13).
 */
export function looksUtf16(text: string): boolean {
  if (text.startsWith('\u00ff\u00fe') || text.startsWith('\u00fe\u00ff')) return true;
  const head = text.slice(0, 4096);
  if (head.length < 16) return false;
  let nul = 0;
  for (let i = 0; i < head.length; i++) if (head.charCodeAt(i) === 0) nul++;
  return nul * 5 >= head.length;
}

/** What a refusal log names about a script's bytes, so the next odd script is readable from companion.log (C13). */
export function describeScriptText(text: string): string {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  let nul = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 0x0a) lf++;
    else if (c === 0) nul++;
  }
  const first = text.split(NEWLINE_RX).find((l) => l.trim() !== '') ?? '';
  const shown = first.trim().slice(0, 60).replace(/[^\x20-\x7e]/g, '?');
  return `script ${text.length} bytes, ${crlf} CRLF / ${lf} LF / ${cr} CR / ${nul} NUL; first line "${shown}"`;
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
