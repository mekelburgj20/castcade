/**
 * One hook that owns everything the three views need: the live witness status (seeded by
 * `witness.status()`, then pushed via `onStatus`), the redacted settings, versions and the
 * login-item state. Without the bridge (plain browser preview) it reports `bridge: null`.
 */
import { useCallback, useEffect, useState } from 'react';

export interface CastcadeState {
  bridge: CastcadeBridge | null;
  status: WitnessStatus | null;
  settings: RedactedSettings | null;
  versions: AppVersions | null;
  loginItem: LoginItemState | null;
  logPath: string | null;
  refreshSettings(): Promise<void>;
  setSettings(patch: SettingsPatch): Promise<void>;
  setLoginItem(on: boolean): Promise<void>;
  applyStatus(status: WitnessStatus): void;
}

export function useCastcade(): CastcadeState {
  const bridge = window.castcade ?? null;
  const [status, setStatus] = useState<WitnessStatus | null>(null);
  const [settings, setSettingsState] = useState<RedactedSettings | null>(null);
  const [versions, setVersions] = useState<AppVersions | null>(null);
  const [loginItem, setLoginItemState] = useState<LoginItemState | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const off = bridge.witness.onStatus((s) => {
      if (alive) setStatus(s);
    });
    void bridge.witness.status().then((s) => alive && setStatus(s));
    void bridge.settings.get().then((s) => alive && setSettingsState(s));
    void bridge.app.versions().then((v) => alive && setVersions(v));
    void bridge.app.loginItem.get().then((l) => alive && setLoginItemState(l));
    void bridge.app.logPath().then((p) => alive && setLogPath(p));
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  const refreshSettings = useCallback(async () => {
    if (bridge) setSettingsState(await bridge.settings.get());
  }, [bridge]);

  const setSettings = useCallback(
    async (patch: SettingsPatch) => {
      if (bridge) setSettingsState(await bridge.settings.set(patch));
    },
    [bridge],
  );

  const setLoginItem = useCallback(
    async (on: boolean) => {
      if (bridge) setLoginItemState(await bridge.app.loginItem.set(on));
    },
    [bridge],
  );

  return {
    bridge,
    status,
    settings,
    versions,
    loginItem,
    logPath,
    refreshSettings,
    setSettings,
    setLoginItem,
    applyStatus: setStatus,
  };
}

export function describe(e: unknown): string {
  if (e instanceof Error) {
    // Electron prefixes IPC errors with "Error invoking remote method 'x': Error: "; strip it.
    return e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  return String(e);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
