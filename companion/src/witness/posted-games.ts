/**
 * The live games this machine already posted, kept across Castcade runs (B17). Live mode re-reads a
 * table's journal from the top on every arm, so a Castcade restart while the same VPX process stays
 * open replays that process's earlier games (rig 2026-10-29: two restarts re-sent 927770 and 4571120;
 * ArcAid answered `duplicate`). The in-memory `liveRead` guard dies with the run; this file does not.
 *
 * A key is `<tableId>@<attempt key>`, the attempt key being the one ArcAid already dedupes on
 * (`<session stamp>#<game start t in ms>`). Games the companion never saw (it was not running) are
 * not in here, so they still post. One JSON file under the module's data dir, rewritten whole; it is
 * tiny and capped.
 */
import type { WitnessFs } from './fs.js';

export const POSTED_GAMES_FILE = 'posted-games.json';
export const MAX_POSTED_GAMES = 2000;

/** The attempt key ArcAid sees for a live game; the score call repeats it. Do not change its format. */
export function attemptKey(sessionStamp: string | null, loadedAtMs: number | null, t: number): string {
  return `${sessionStamp ?? String(loadedAtMs ?? 0)}#${Math.round(t * 1000)}`;
}

/** One live game, across runs: the table's journal id and the game's attempt key. */
export function postedGameKey(tableId: string, attemptKeyPart: string): string {
  return `${tableId}@${attemptKeyPart}`;
}

interface PostedGamesFile {
  version: 1;
  /** Key → ISO time it was added (the oldest go first past the cap). */
  keys: Record<string, string>;
}

export interface PostedGames {
  load(): Promise<void>;
  has(key: string): boolean;
  add(key: string): Promise<void>;
  size(): number;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

export function createPostedGames(fs: WitnessFs, dataDir: string, now: () => number = () => Date.now()): PostedGames {
  const file = joinPath(dataDir, POSTED_GAMES_FILE);
  let data: PostedGamesFile = { version: 1, keys: {} };

  const persist = async (): Promise<void> => {
    const keys = Object.keys(data.keys);
    if (keys.length > MAX_POSTED_GAMES) {
      keys.sort((a, b) => (data.keys[a] ?? '').localeCompare(data.keys[b] ?? ''));
      for (const k of keys.slice(0, keys.length - MAX_POSTED_GAMES)) delete data.keys[k];
    }
    await fs.mkdir(dataDir);
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await fs.rename(tmp, file);
  };

  return {
    async load() {
      data = { version: 1, keys: {} };
      let text: string;
      try {
        text = new TextDecoder().decode(await fs.readFile(file));
      } catch {
        // Missing is the first run. Anything else unreadable starts empty too: the worst case is a
        // re-sent game that ArcAid answers `duplicate`, which beats a witness that will not start.
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
          const keys = (parsed as { keys?: unknown }).keys;
          if (typeof keys === 'object' && keys !== null && !Array.isArray(keys)) {
            for (const [k, v] of Object.entries(keys)) if (typeof v === 'string') data.keys[k] = v;
          }
        }
      } catch {
        // A torn file: start clean; the next add rewrites it.
      }
    },
    has: (key) => Object.prototype.hasOwnProperty.call(data.keys, key),
    async add(key) {
      if (Object.prototype.hasOwnProperty.call(data.keys, key)) return;
      data.keys[key] = new Date(now()).toISOString();
      await persist();
    },
    size: () => Object.keys(data.keys).length,
  };
}
