/**
 * Minimal typed event emitter used by HostMatch and ClientMatch. Listeners are called
 * synchronously in registration order; `on()` returns an unsubscribe function.
 */

export class Emitter<E extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof E, Set<(payload: unknown) => void>>();

  on<K extends keyof E>(name: K, cb: (payload: E[K]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    const fn = cb as (payload: unknown) => void;
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  once<K extends keyof E>(name: K, cb: (payload: E[K]) => void): () => void {
    const off = this.on(name, (p) => {
      off();
      cb(p);
    });
    return off;
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) cb(payload);
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
