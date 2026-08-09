/**
 * Resolves which kind of week an athlete should get, and how much quality work belongs in it.
 *
 * Before this existed, the choice between the normal arc skeleton and the recovery skeleton was
 * a hand-rolled condition duplicated at each decision point in coach/respond/route.ts, and every
 * copy tested exactly one signal: `training_state.injury_hold_since`. That made three cases wrong:
 *
 * 1. An athlete with `active_injury = true` and no hold — still running, managing something —
 *    got the fully injury-blind arc skeleton: unsafe cross-training modalities and up to two
 *    quality sessions. This is the most common injury state, not an edge case, and it's also
 *    every return-to-run week (handleInjuryClear clears the hold at RTR phase 1).
 * 2. RTR phase 1 got a full arc week with a long run and a quality session while the prompt
 *    simultaneously told Dean "walk/run intervals only, max 3 sessions, zero long run".
 * 3. `syncWeekFromArc` never consulted the hold at all, so held athletes had a running week
 *    persisted to `weekly_plan_sessions` and read back by the reminders and the dashboard.
 *
 * The resolver is deliberately small: it decides SHAPE (which skeleton, how many quality slots),
 * never LOAD. Injury already discounts load upstream in three places — `computeMileageArc`'s
 * build factor, `computeWeekOneVolumeCap`/`computeLongRunCap`, and weekly_recap's 1.15× clamp
 * against last week's actual miles. Discounting again here would double-apply it, silently, and
 * only for athletes who happen to hit both paths.
 */

export type WeekMode =
  /** Normal arc week from computeArcWeekSkeleton. */
  | "arc"
  /** Cross-training/strength week from computeRecoveryWeekSkeleton — no running slots exist. */
  | "recovery"
  /** No deterministic skeleton: something else owns this week's structure. */
  | "none";

export type QualityPolicy =
  /** Long run + up to two quality sessions. */
  | "both"
  /** Long run + one quality session. */
  | "one"
  /** No quality sessions; easy running only. */
  | "none";

export interface WeekModeInput {
  /** training_state.injury_hold_since */
  injuryHoldSince: string | null;
  /** training_state.return_to_run_phase */
  returnToRunPhase: number | null;
  /** training_profiles.active_injury */
  activeInjury: boolean;
  isComplementMode: boolean;
  isAnalystMode: boolean;
}

export interface WeekModeResult {
  mode: WeekMode;
  qualityPolicy: QualityPolicy;
}

export function resolveWeekMode(input: WeekModeInput): WeekModeResult {
  // The athlete's sessions aren't ours to schedule at all.
  if (input.isComplementMode || input.isAnalystMode) {
    return { mode: "none", qualityPolicy: "none" };
  }

  // Can't run — the recovery skeleton has no run slot in its type.
  if (input.injuryHoldSince) {
    return { mode: "recovery", qualityPolicy: "none" };
  }

  // RTR phase 1 is walk/run intervals, capped session count, no long run. The return-to-run
  // prompt block already specifies that week completely; handing it an arc skeleton on top
  // produced two contradictory descriptions of the same week in one message. Yield to the
  // prompt until there's a real computeReturnToRunWeekSkeleton to give it.
  if (input.returnToRunPhase === 1) {
    return { mode: "none", qualityPolicy: "none" };
  }

  // Phase 2: running again, easy only.
  if (input.returnToRunPhase === 2) {
    return { mode: "arc", qualityPolicy: "none" };
  }

  // Running through an injury. One quality session, not two — mirroring the key_workout_2
  // suppression generateAndSaveFullPlan already applies at generation time. That only helps
  // when the injury predates the arc; an injury that appears mid-arc still had both quality
  // days placed until this ran.
  if (input.activeInjury) {
    return { mode: "arc", qualityPolicy: "one" };
  }

  return { mode: "arc", qualityPolicy: "both" };
}
