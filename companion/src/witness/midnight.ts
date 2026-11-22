/**
 * B26 (2026-11-16): Midnight Madness, by evidence. The owner: "a midnight madness happened for Krobs which is a really
 * unfair advantage. We need to monitor for this somehow and either disable it or flag it", and, of the first step
 * (a ball played across local midnight "may have run" it), B26.4: "I'd rather not guess based on clock time. I'd
 * rather check the actual setting where it is enabled and check for the signal during live play that it actually
 * occurred."
 *
 * Some Williams / Bally WPC ROMs from 1995 on start a bonus multiball when the machine's real-time clock passes
 * midnight during a ball. VPinMAME takes that clock from the PC, so it happens at each player's own LOCAL midnight:
 * in a match one player may get it and the other not. The ROM itself holds two pieces of evidence, both in NVRAM:
 *
 * - **The counter**: a feature audit that goes up when the mode starts (Congo B.4 31 "SPECIAL MODES", Johnny
 *   Mnemonic B.4 35 "Special Modes", Who Dunnit B.4 61 "SPECIAL MODES", …). The hook journals its bytes
 *   (`midnightWatchOffsets` joins the watch list), the journal detector raises `midnight_madness` when it goes up
 *   while a game is in play, and that is the flag: a fact, on the ball it happened on.
 * - **The setting**: the operator adjustment that enables the mode ("Special Mode", NO / YES, factory YES). Read from
 *   the same journal's NVRAM and shown to every player of a match before and during play.
 *
 * What is inferred and not yet confirmed on a rig: that the "Special Modes" audit counts Midnight Madness (the names
 * say so: adjustment "Special Mode", audit "Special Modes", and these ROMs have no other special-mode text). A game
 * with no known counter is NOT monitored: nothing is flagged and nothing is guessed from the clock.
 *
 * Read-only: nothing here, or anywhere in Castcade, writes a table's NVRAM. Pure: maps and bytes in, values out.
 */
import { descriptorOffsets, descriptorStoredValue, NvMemory, type AdjustmentDescriptor, type CompiledMap, type JsonObject } from './maps.js';

/** The ROM's own count of the mode: a feature audit. */
export interface MidnightCounter {
  /** `B.4 31 SPECIAL MODES`: the audit as the service menu numbers and names it. */
  name: string;
  /** The map's descriptor (an `int` of three bytes on every map that has one). */
  entry: JsonObject;
}

/** The operator adjustment that enables the mode. */
export interface MidnightSetting {
  /** `A.2 14 Special Mode`: the adjustment as the service menu numbers and names it. */
  name: string;
  entry: JsonObject;
  /** The stored values that read YES and NO; any other value is not a reading. */
  on: number;
  off: number;
}

export interface MidnightEvidence {
  counter: MidnightCounter | null;
  setting: MidnightSetting | null;
}

/**
 * The audit that counts the mode, by its label: "Special Mode(s)", or "Midnight Madness" by name. Anchored on purpose,
 * and a bare "Midnight" is NOT one: a machine with a clock in its own rules counts that clock there. FunHouse has
 * "MIDNIGHT GAMES" and "11:45 GAMES"; Theatre of Magic has "Midnight" beside "Got to 6 PM", which is its Midnight
 * Multiball (the stage clock reaching twelve), started in any long game. Taking either for Midnight Madness would
 * flag ordinary play as a fact.
 */
const COUNTER_LABEL = /^(special\s+modes?|midnight\s+madness)$/i;
/** The adjustment that enables it. */
const SETTING_LABEL = /^special\s+modes?$/i;

/**
 * What the maps corpus lacks, by ROM. Kept tiny: one entry per ROM whose NVRAM was read.
 *
 * `congo_21`: adjustment A.2 14 "SPECIAL MODE" (NO / YES). The corpus map has only the A.1 block. Located by layout
 * against one real congo_21 NVRAM (2026-11-16): the A.2 block starts at offset 7239 with two bytes per adjustment,
 * the value in the second; entries 08 to 13 (7253 to 7263) are the six difficulty settings, all 2 = MEDIUM, 05 "EX.
 * BALL PERCENT" reads 20 and 24 "DEF. DIAMD CHAMP" 100, so entry 14 is the pair at 7265 and read 1 = YES, the factory
 * default. NOT yet confirmed by toggling it in the service menu. The other ROMs of the Congo map (`congo_11`, `_13`,
 * `_20`, `_20s10k`) are left out: an adjustment table is not known to sit at the same offsets across ROM versions.
 */
const SETTING_SUPPLEMENT: Readonly<Record<string, MidnightSetting>> = {
  congo_21: { name: 'A.2 14 Special Mode', entry: { label: 'SPECIAL MODE', start: 7265, length: 2, encoding: 'int' }, on: 1, off: 0 },
};

/** `A.2 Feature Adjustments` + `12` + `Special Mode` → `A.2 12 Special Mode`; `B.4 FEATURE AUDS.` + `31` → `B.4 31 …`. */
function menuName(d: AdjustmentDescriptor, label: string = d.label): string {
  const menu = /^[A-Z]\.\d+/i.exec(d.group.trim())?.[0] ?? d.group.trim();
  return [menu, d.key, label].filter((x) => x !== null && x !== '').join(' ');
}

/** Every byte of the descriptor is inside the platform's NVRAM region (what the hook can journal). */
function inNvram(map: CompiledMap, entry: JsonObject): boolean {
  try {
    return regionOffsets(map, entry).length === descriptorOffsets(entry).length;
  } catch {
    return false;
  }
}

/** The descriptor's bytes as offsets from the start of the NVRAM region (the journal's index), those inside it. */
function regionOffsets(map: CompiledMap, entry: JsonObject): number[] {
  const region = map.platform.layout.find((r) => r.type === 'nvram');
  const base = region?.address ?? 0;
  const size = region && region.size > 0 ? region.size : Number.POSITIVE_INFINITY;
  return descriptorOffsets(entry)
    .map((addr) => addr - base)
    .filter((off) => Number.isInteger(off) && off >= 0 && off < size);
}

/** The stored values of an enum adjustment's YES and NO (`values: ["NO", "YES"]`); 1 and 0 for any other encoding. */
function yesNo(map: CompiledMap, entry: JsonObject): { on: number; off: number } | null {
  let values = entry['values'];
  if (typeof values === 'string') values = map.sharedValues[values] ?? null;
  if (!Array.isArray(values)) return entry['encoding'] === 'enum' ? null : { on: 1, off: 0 };
  const on = values.findIndex((v) => typeof v === 'string' && /^(yes|on)$/i.test(v.trim()));
  const off = values.findIndex((v) => typeof v === 'string' && /^(no|off)$/i.test(v.trim()));
  return on >= 0 && off >= 0 ? { on, off } : null;
}

const romKey = (rom: string | null | undefined): string => (rom ?? '').trim().toLowerCase();

/**
 * The evidence a ROM offers: the counter from the map's `audits`, the setting from its `adjustments` or, where the
 * corpus has none, from `SETTING_SUPPLEMENT` for exactly that ROM (`rom` as the table names it; case does not
 * matter). Both null: nothing is known about Midnight Madness on this machine, which is most machines.
 */
export function midnightEvidence(map: CompiledMap | null | undefined, rom?: string | null): MidnightEvidence {
  if (!map) return { counter: null, setting: null };
  const audit = map.audits.find((a) => COUNTER_LABEL.test(a.label.trim()) && a.entry['encoding'] === 'int' && inNvram(map, a.entry));
  const counter: MidnightCounter | null = audit ? { name: menuName(audit), entry: audit.entry } : null;

  let setting: MidnightSetting | null = null;
  const adj = map.adjustments.find((a) => SETTING_LABEL.test(a.label.trim()) && inNvram(map, a.entry));
  const values = adj ? yesNo(map, adj.entry) : null;
  if (adj && values) setting = { name: menuName(adj, 'Special Mode'), entry: adj.entry, ...values };
  if (!setting) {
    const extra = SETTING_SUPPLEMENT[romKey(rom)];
    if (extra && map.roms.includes(romKey(rom)) && inNvram(map, extra.entry)) setting = extra;
  }
  return { counter, setting };
}

/**
 * The NVRAM offsets the hook must journal for this ROM's Midnight Madness evidence (the counter's bytes and the
 * setting's), counted from the start of the NVRAM region like `watchOffsets`; none for a ROM without evidence.
 */
export function midnightWatchOffsets(map: CompiledMap | null | undefined, rom?: string | null): number[] {
  if (!map) return [];
  const e = midnightEvidence(map, rom);
  const out = new Set<number>();
  for (const entry of [e.counter?.entry, e.setting?.entry]) if (entry) for (const off of regionOffsets(map, entry)) out.add(off);
  return [...out].sort((a, b) => a - b);
}

/** The counter's value in these NVRAM bytes (a `.nv` file or the journal's shadow); null without a counter or its bytes. */
export function midnightCount(map: CompiledMap, evidence: MidnightEvidence, nv: Uint8Array): number | null {
  if (!evidence.counter) return null;
  return descriptorStoredValue(new NvMemory(map.platform, nv), evidence.counter.entry, map.platform);
}

/**
 * Is the mode enabled in these NVRAM bytes? True / false only when the adjustment holds exactly its YES / NO value;
 * null for anything else (no setting known, bytes missing, or the 0x55 / 0xAA fill of a WPC boot's RAM test).
 */
export function midnightEnabled(map: CompiledMap, evidence: MidnightEvidence, nv: Uint8Array): boolean | null {
  const s = evidence.setting;
  if (!s) return null;
  const v = descriptorStoredValue(new NvMemory(map.platform, nv), s.entry, map.platform);
  return v === s.on ? true : v === s.off ? false : null;
}

/** What a rig reports about its own table: the setting as it reads, and which adjustment that is. */
export interface MidnightSettingReport {
  enabled: boolean;
  /** `A.2 14 Special Mode`. */
  adjustment: string;
}

/** `Krobs'`, `Hosty's`. */
export function possessive(name: string): string {
  return `${name}${/s$/i.test(name) ? "'" : "'s"}`;
}

const listOf = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * The one line every player of a match sees about the setting (Match tab, lobby and game; the panel at each game's
 * start), or null when there is nothing to say: the mode is ON on no table that could be read. `rigs`: every
 * participant in roster order, `name` null for this player, `setting` null when that rig reported nothing (no table
 * open, an unknown game, an older Castcade): such a rig is left out, never guessed.
 *
 * - ON on every table of the match: `Midnight Madness is ON on every table (adjustment A.2 14 Special Mode)`.
 * - ON on some, the rest unknown: `Midnight Madness is ON on Krobs' table (adjustment …)`.
 * - ON on some and OFF on others: `Midnight Madness differs between tables: ON on Krobs' table, OFF on your table (adjustment …)`.
 */
export function midnightSettingLine(rigs: ReadonlyArray<{ name: string | null; setting: MidnightSettingReport | null }>): string | null {
  const table = (r: { name: string | null }): string => (r.name === null ? 'your table' : `${possessive(r.name)} table`);
  const on = rigs.filter((r) => r.setting?.enabled === true);
  const off = rigs.filter((r) => r.setting?.enabled === false);
  if (on.length === 0) return null;
  const adjustment = ` (adjustment ${on[0]!.setting!.adjustment})`;
  if (off.length > 0) return `Midnight Madness differs between tables: ON on ${listOf(on.map(table))}, OFF on ${listOf(off.map(table))}${adjustment}`;
  if (on.length === rigs.length && rigs.length > 1) return `Midnight Madness is ON on every table${adjustment}`;
  return `Midnight Madness is ON on ${listOf(on.map(table))}${adjustment}`;
}

/** The match's line for a ball the mode ran on (panel, Match tab). `name` null: this player's own ball. */
export function midnightLine(name: string | null, ball: number): string {
  if (name === null) return `Midnight Madness ran on your ball ${ball} (counted by your table's ROM)`;
  return `Midnight Madness ran on ${possessive(name)} ball ${ball} (counted by that table's ROM)`;
}

/**
 * B26.6 (owner ruling 2026-11-22): a tournament may refuse, or only flag, a game of a Midnight Madness title that was in
 * play at the device's local midnight. ArcAid decides that from the game's `started` / `ended` (epoch seconds) and the
 * device's offset from UTC, which only the device knows. Minutes EAST of UTC (Los Angeles in winter: -480), read at the
 * game's start: a daylight-saving change falls after midnight, so the offset at the start is the one in force at the
 * midnight inside the game.
 */
export function utcOffsetMinutes(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}

/**
 * The compact `midnight` JSON on a score: what this rig knows about the mode on the table the score came from. Null
 * (the param is not sent) when it knows nothing, which is most machines.
 *
 * - `setting` `on` / `off` and `adjustment` (`A.2 14 Special Mode`): the operator adjustment as it reads in the NVRAM
 *   bytes the score came from. The owner's stated end state: a game on a table with the mode OFF is permitted.
 * - `ran`: the ROM's own audit of the mode went up during this game (true) or did not (false). Only from live mode on a
 *   ROM with such an audit; absent means not monitored, never "did not run".
 */
export function midnightWire(p: { setting: MidnightSettingReport | null; ran: boolean | null }): string | null {
  if (!p.setting && p.ran === null) return null;
  return JSON.stringify({
    ...(p.setting ? { setting: p.setting.enabled ? 'on' : 'off', adjustment: p.setting.adjustment } : {}),
    ...(p.ran !== null ? { ran: p.ran } : {}),
  });
}

/** The witness's capture detail and log wording for a solo game the mode ran in. */
export const MIDNIGHT_GAME_NOTE = 'Midnight Madness ran during the game (counted by the ROM)';
