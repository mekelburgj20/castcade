/**
 * Clock abstraction for the match engine. Everything time-related in the host and client
 * (message `ts`, grant `issuedAt`, the ball-end and log-sign timeouts) goes through a `Clock`,
 * so tests drive a `ManualClock` instead of waiting twenty real minutes.
 */

export type TimerHandle = unknown;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Wall clock + Node timers. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface ManualTimer {
  id: number;
  due: number;
  fn: () => void;
}

/** A clock that only moves when `advance()` is called; due timers fire inside `advance()`. */
export class ManualClock implements Clock {
  private current: number;
  private nextId = 1;
  private timers: ManualTimer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const t: ManualTimer = { id: this.nextId++, due: this.current + Math.max(0, ms), fn };
    this.timers.push(t);
    return t.id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Number of timers waiting to fire. */
  pending(): number {
    return this.timers.length;
  }

  /** Move time forward, firing timers in due order (insertion order on ties). */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id);
      const next = due[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t.id !== next.id);
      this.current = Math.max(this.current, next.due);
      next.fn();
    }
    this.current = target;
  }
}
