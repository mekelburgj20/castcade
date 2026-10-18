/**
 * Minimal rotating append logger for `<userData>/logs/companion.log`. One live file plus one
 * `.1` backup; rotation when the live file passes `maxBytes`. Also mirrors to stderr in
 * development. No dependencies, no Electron import.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  readonly file: string;
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface LoggerOptions {
  file: string;
  maxBytes?: number;
  mirrorToStderr?: boolean;
  now?: () => Date;
}

export function createLogger(opts: LoggerOptions): Logger {
  const { file, maxBytes = 1_000_000, mirrorToStderr = false, now = () => new Date() } = opts;
  mkdirSync(dirname(file), { recursive: true });

  const rotateIfNeeded = (): void => {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;
    const backup = `${file}.1`;
    try {
      rmSync(backup, { force: true });
      renameSync(file, backup);
    } catch {
      // A reader may hold the file; keep appending to the live file instead of failing.
    }
  };

  const write = (level: LogLevel, msg: string): void => {
    const line = `${now().toISOString()} ${level.padEnd(5)} ${msg}\n`;
    try {
      rotateIfNeeded();
      appendFileSync(file, line, 'utf8');
    } catch {
      // Logging must never throw into the app.
    }
    if (mirrorToStderr) process.stderr.write(line);
  };

  return {
    file,
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  return String(e);
}
