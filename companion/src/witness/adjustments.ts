/**
 * Operator ("machine") adjustments from a `.nv` through the maps corpus (F2). A map's
 * `adjustments` block lists, per group (`A.1 Standard Adjustments` …), the entries the operator menu
 * exposes, each a descriptor like any other plus `default` (the factory value), `min`/`max` and
 * sometimes `special_values`. The companion reports the fairness-relevant ones with a factory /
 * non-factory judgement where the map gives a default.
 *
 * Coverage caveat: at the pinned corpus commit, 92 of 383 maps carry an `adjustments` block
 * (Attack from Mars and Demolition Man yes; Medieval Madness, Monster Bash and Tales from the Crypt
 * no), so a null report is the common case and means "not measurable", never "factory".
 */
import type { AdjustmentReading, AdjustmentsReport } from './attestation-types.js';
import { descriptorEnum, descriptorStoredValue, descriptorValue, isObject, NvMemory, toInt, type CompiledMap } from './maps.js';

/** Labels that change what a game is worth: these are the ones Sanctioned play compares to factory. */
export const FAIRNESS_LABELS: RegExp[] = [
  /balls?\s*(per|\/)\s*game/i,
  /number of balls/i,
  /tilt\s*warn/i,
  /extra\s*ball|\be\.?\s?b\.?\b|ex\.?\s*ball/i,
  /ball\s*save/i,
  /replay/i,
  /free\s*play|pricing/i,
  /special\s*award/i,
  /\bmatch\b/i,
  /difficult/i,
  /timed\s*plunger/i,
  /buy[\s-]*in/i,
];

export const MAX_CHECKED = 24;

export function isFairnessLabel(label: string): boolean {
  return FAIRNESS_LABELS.some((re) => re.test(label));
}

/** Every adjustment the map describes, decoded against the `.nv` bytes. */
export function decodeAdjustments(map: CompiledMap, nv: Uint8Array): AdjustmentReading[] {
  const mem = new NvMemory(map.platform, nv);
  const out: AdjustmentReading[] = [];
  for (const d of map.adjustments) {
    const entry = d.entry;
    const value = descriptorStoredValue(mem, entry, map.platform);
    const shown = descriptorValue(mem, entry, map.platform);
    let text: string | null = null;
    if (value !== null) {
      if (entry['encoding'] === 'enum') {
        const e = descriptorEnum(mem, entry, map);
        text = e !== null && !e.startsWith('?') ? e : null;
      } else {
        // `special_values` are keyed by the stored value too.
        const special = entry['special_values'];
        if (isObject(special)) {
          const s = special[String(value)];
          if (typeof s === 'string') text = s;
        }
      }
    }
    const dflt = entry['default'];
    const factory = dflt === undefined || dflt === null ? null : toInt(dflt, Number.NaN);
    const factoryOk = factory !== null && Number.isFinite(factory) ? factory : null;
    out.push({
      group: d.group,
      label: d.label,
      value,
      shown,
      text,
      factory: factoryOk,
      isFactory: value === null || factoryOk === null ? null : value === factoryOk,
    });
  }
  return out;
}

/** The report a capture posts: the fairness subset of the readings, non-factory labels first in the list. */
export function adjustmentsReport(rom: string, readings: AdjustmentReading[]): AdjustmentsReport | null {
  if (readings.length === 0) return null;
  const checked = readings.filter((r) => isFairnessLabel(r.label) && r.value !== null).slice(0, MAX_CHECKED);
  return {
    rom,
    total: readings.length,
    checked,
    nonFactory: checked.filter((r) => r.isFactory === false).map((r) => r.label),
    unjudged: checked.filter((r) => r.isFactory === null).length,
  };
}

export function describeAdjustments(a: AdjustmentsReport | null): string {
  if (!a) return 'no adjustments map for this ROM';
  if (a.checked.length === 0) return `${a.total} adjustments in the map, none of the checked kind readable`;
  if (a.nonFactory.length === 0) return `${a.checked.length} adjustments checked, all factory${a.unjudged > 0 ? ` (${a.unjudged} without a known default)` : ''}`;
  return `non-factory adjustments: ${a.nonFactory.join(', ')}`;
}
