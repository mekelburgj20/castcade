/**
 * D2.8 (2026-11-01): when this rig's table is muted, tapped and when the others' tables are played. Architecture B
 * runs one VPX per player, so each rig hears its own table unless told otherwise (the owner's first run on 0.2.28: his
 * own table, and his own game-end sounds, all through Krobs' turn). Pure: the match host feeds it the panel state and
 * the Match tab's three settings, and drives the helper (`audio-helper.ts`) and the panel page from the answer.
 *
 *   - mute mine: the match is playing or paused and it is not my ball (another player is up, or the gap between grants);
 *   - tap mine: it is my ball (this rig sends video then, and now its table's sound with it);
 *   - play the table of: the player up, when that is not me;
 *   - level mine (D2.10, 2026-11-05): while it is my ball, my own VPX's session volume is set to `myTableWhileUp`
 *     percent when that is under 100 (the helper's `level`), so my voice chat sits over my table; 100 leaves it alone,
 *     and leaving the up state restores it (`unlevel`).
 *
 * The lobby (`idle`), the result (`over`) and no match at all mute nothing, tap nothing and level nothing.
 */
import type { MatchPlayerId, PanelState } from './match-media-types.js';

/** The Match tab's table-sound settings (match settings, `<userData>/match.json`); all default on. */
export interface TableAudioSettings {
  /** "Table sound: mute mine while others play". */
  tableMuteMine: boolean;
  /** "Send my table's sound". */
  tableSendMine: boolean;
  /** "Hear the other table". */
  tableHearOthers: boolean;
  /** D2.10: "My table while I play", 10–100 percent; 100 (or absent, in callers from before D2.10) levels nothing. */
  myTableWhileUp?: number;
}

export interface TableAudioPlan {
  muteMine: boolean;
  tapMine: boolean;
  playTableOf: MatchPlayerId | null;
  /** D2.10: the percent to set my VPX's sessions to while I am up, or null for untouched. */
  levelMine: number | null;
}

export const NO_TABLE_AUDIO: TableAudioPlan = { muteMine: false, tapMine: false, playTableOf: null, levelMine: null };

export function tableAudioPlan(panel: Pick<PanelState, 'phase' | 'myTurn' | 'playerUp'> | null, s: TableAudioSettings): TableAudioPlan {
  if (!panel || (panel.phase !== 'playing' && panel.phase !== 'paused')) return NO_TABLE_AUDIO;
  if (panel.myTurn) return { muteMine: false, tapMine: s.tableSendMine, playTableOf: null, levelMine: levelFor(s.myTableWhileUp) };
  return { muteMine: s.tableMuteMine, tapMine: false, playTableOf: s.tableHearOthers ? panel.playerUp : null, levelMine: null };
}

/** D2.10: the level to ask for from the setting: a whole percent in 10–99, else null (100 and above, or no setting, is untouched). */
export function levelFor(myTableWhileUp: number | undefined): number | null {
  if (typeof myTableWhileUp !== 'number' || !Number.isFinite(myTableWhileUp)) return null;
  const pct = Math.round(myTableWhileUp);
  return pct >= 100 ? null : Math.max(10, pct);
}

/**
 * The VPX process the match uses: the capture's window pid (the "Visual Pinball Player" window being sent) when there
 * is one, else the pid the witness saw launch. Null when neither knows one (nothing is muted or tapped then).
 */
export function tableAudioPid(capturePid: number | null | undefined, launchPid: number | null | undefined): number | null {
  const ok = (p: number | null | undefined): p is number => typeof p === 'number' && Number.isInteger(p) && p > 0;
  if (ok(capturePid)) return capturePid;
  return ok(launchPid) ? launchPid : null;
}
