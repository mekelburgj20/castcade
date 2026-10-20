import { describe, expect, it } from 'vitest';
import { CHECK_INTERVAL_MS, RETRY_AFTER_FAILURE_MS, nextCheckDelayMs } from './updater.js';

describe('nextCheckDelayMs', () => {
  it('re-checks every few hours after a successful check (tray apps run for days)', () => {
    expect(nextCheckDelayMs('ok')).toBe(CHECK_INTERVAL_MS);
    expect(CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(CHECK_INTERVAL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('retries sooner after a failed check (offline at boot, 404 while a release uploads)', () => {
    expect(nextCheckDelayMs('failed')).toBe(RETRY_AFTER_FAILURE_MS);
    expect(RETRY_AFTER_FAILURE_MS).toBeLessThan(CHECK_INTERVAL_MS);
    expect(RETRY_AFTER_FAILURE_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('stops once an update is downloaded; it installs on the next quit', () => {
    expect(nextCheckDelayMs('downloaded')).toBeNull();
  });
});
