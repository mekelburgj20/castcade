/**
 * Score plausibility (B6.1, fairness doc §5 "memory trainers"): facts about how player 1's score moved during one
 * live game, measured from the journal's `current_scores` samples. A memory editor that writes a score shows up as
 * one jump; this module reports the jumps and never decides anything.
 *
 * - `largest`: the biggest single jump, with when and on which ball. No ceiling is applied: the maps carry no award
 *   values, and a hand-written per-game maximum was ruled out (owner, 2026-10-25). A runner reads the number.
 * - `gcd` and `off_step`: ROM games (recipe A) move in steps of 10 on every recording we have (Monster Bash, Medieval
 *   Madness, Tales from the Crypt); a jump that is not a multiple of 10 is the one thing flagged. Original tables
 *   (script recipes) score whatever their script says, so they get the facts and no flag.
 *
 * Flag only, never a gate (owner ruling 2026-10-25): ArcAid shows it, no rule fails on it.
 * A sample is one journal callback; hook 0.3.0+ coalesces deltas, so one jump can be several awards at once.
 */

/** Every ROM score recorded so far moves in multiples of this. */
export const ROM_SCORE_STEP = 10;

export interface ScorePlausibility {
  /** Score changes seen during the game (up or down). */
  samples: number;
  /** Greatest common divisor of every upward jump; null with no jump. */
  gcd: number | null;
  /** The step the jumps are checked against (10 for ROM games), or null when not checked (script recipes). */
  step: number | null;
  /** Upward jumps that are not a multiple of `step`. */
  offStep: number;
  /** The biggest single upward jump. */
  largest: { points: number; t: number; ball: number | null } | null;
  /** A short sentence when something is flagged, else null. */
  flag: string | null;
}

const gcdOf = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b];
  return a;
};

/** Accumulates one game's samples. `reset()` at game start, `add()` per `current_scores`, `result()` at capture. */
export class ScoreTrack {
  private prev: number | null = null;
  private samples = 0;
  private gcd = 0;
  private offStep = 0;
  private firstOff: number | null = null;
  private largest: ScorePlausibility['largest'] = null;

  constructor(private readonly step: number | null = ROM_SCORE_STEP) {}

  reset(): void {
    this.prev = null;
    this.samples = 0;
    this.gcd = 0;
    this.offStep = 0;
    this.firstOff = null;
    this.largest = null;
  }

  /**
   * One sample of player 1's score. The first sample of a game is the baseline (the ROM's reset to 0, or the
   * previous game's score still on display); a drop moves the baseline and is not a jump.
   */
  add(score: number | null, t: number, ball: number | null): void {
    if (score === null || !Number.isInteger(score) || score < 0) return;
    if (this.prev === null) {
      this.prev = score;
      return;
    }
    const d = score - this.prev;
    this.prev = score;
    if (d === 0) return;
    this.samples++;
    if (d < 0) return;
    this.gcd = gcdOf(this.gcd, d);
    if (this.step !== null && d % this.step !== 0) {
      this.offStep++;
      if (this.firstOff === null) this.firstOff = d;
    }
    if (!this.largest || d > this.largest.points) this.largest = { points: d, t, ball };
  }

  result(): ScorePlausibility {
    const flag = this.offStep > 0
      ? `${this.offStep} score change${this.offStep === 1 ? '' : 's'} not a multiple of ${this.step} (first +${this.firstOff!.toLocaleString('en-US')}); ROM scores move in steps of ${this.step}`
      : null;
    return { samples: this.samples, gcd: this.gcd || null, step: this.step, offStep: this.offStep, largest: this.largest, flag };
  }
}

/** The compact `score_plausibility` JSON on the score; null when the game had no score change to report. */
export function scorePlausibilityWire(p: ScorePlausibility | null): string | null {
  if (!p || p.samples === 0) return null;
  return JSON.stringify({
    samples: p.samples,
    gcd: p.gcd,
    step: p.step,
    off_step: p.offStep,
    largest: p.largest ? { points: p.largest.points, t: Math.round(p.largest.t * 1000) / 1000, ball: p.largest.ball } : null,
    flag: p.flag,
  });
}

/** One line for the capture detail and the log. */
export function describeScorePlausibility(p: ScorePlausibility | null): string {
  if (!p || p.samples === 0) return 'score plausibility: no live samples';
  const big = p.largest ? `largest jump +${p.largest.points.toLocaleString('en-US')}${p.largest.ball !== null ? ` on ball ${p.largest.ball}` : ''}` : 'no upward jump';
  const head = `score plausibility: ${p.samples} changes, ${big}`;
  return p.flag ? `${head}; FLAG: ${p.flag}` : `${head}${p.step !== null ? `, all in steps of ${p.step}` : ''}`;
}
