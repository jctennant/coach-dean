/**
 * FITNESS TIER block — the volume-cap section of buildSystemPrompt's dynamicContext
 * (coach/respond/route.ts). Third slice of the CoachContext extraction (see
 * coach-date-context.ts and coach-race-context.ts for the first two, and CHANGELOG
 * for the bug that motivated starting this).
 *
 * This slice closes a gap `plan-validation.ts` has flagged in its own comments since
 * it was written: `computeWeekOneVolumeCap`/`computeLongRunCap` compute the exact same
 * Week-1 volume-cap numbers that used to be re-derived separately, inline, in this
 * prompt block — two independent copies of `avgWeeklyMileage * 1.3`, `* 0.35`, `* 0.90`,
 * etc. that had to be manually kept in sync by comment discipline alone ("if you change
 * one, change the other and verify the numbers still match"). This module now calls
 * those functions directly for every hard floor/ceiling, so the prompt text and the
 * `plan.weekly_total`/long-run validators derive from one arithmetic source instead of
 * two that could silently drift apart — exactly the kind of duplicate-formula risk the
 * date-reformatting bug turned out to be, closed here before it caused a mismatch.
 *
 * The "target range" numbers shown in some tiers (e.g. "Start at 25–35mi" for a
 * no-history advanced self-report) are prompt-only display guidance, not part of the
 * validators' contract (see computeWeekOneVolumeCap's doc comment: it only enforces a
 * floor for those tiers, never a ceiling) — those stay as named constants in this
 * module, clearly separated from the shared hard-cap numbers.
 */

import { computeWeekOneVolumeCap, computeLongRunCap } from "./plan-validation";

export interface FitnessTierParams {
  avgWeeklyMileage: number | null;
  forceBeginnerTier: boolean;
  fitnessLevel: string | null;
  daysPerWeek: number | null;
  isMetric: boolean;
  /** Days since the athlete's most recent logged run — reduces the Week-1 cap on a real layoff. Null/omitted when not applicable (only meaningful for initial_plan). */
  daysSinceLastRun?: number | null;
}

function buildNoHistoryTier(params: FitnessTierParams, spMi: (miles: number) => string): string {
  const { forceBeginnerTier, fitnessLevel, avgWeeklyMileage, daysPerWeek } = params;
  // forceBeginnerTier=true forces this same branch inside computeWeekOneVolumeCap
  // regardless of avgWeeklyMileage's actual value — covers both "genuinely no Strava
  // data" (avgWeeklyMileage null) and "stale history, self-reports as beginner"
  // (avgWeeklyMileage non-null but the caller has decided not to trust it).
  const cap = computeWeekOneVolumeCap(avgWeeklyMileage, fitnessLevel, true);

  if (fitnessLevel === "advanced") {
    return `FITNESS TIER: No Strava history yet, but athlete self-reports as ADVANCED. Treat this like a moderate-to-high volume athlete returning to training — do not apply beginner volume defaults.
<rule>WEEK 1 VOLUME CAP (no history, advanced): Start at ${spMi(25)}–${spMi(35)} for the week. Spread across ${daysPerWeek ?? 5}+ days. Include 1 quality session. Do not prescribe fewer than ${spMi(cap.min)} — that is inconsistent with advanced fitness.</rule>`;
  }
  if (fitnessLevel === "intermediate") {
    return `FITNESS TIER: No Strava history yet, but athlete self-reports as INTERMEDIATE. Treat as an athlete with an established aerobic base — do not apply beginner volume defaults.
<rule>WEEK 1 VOLUME CAP (no history, intermediate): Start at ${spMi(15)}–${spMi(25)} for the week. Spread across ${daysPerWeek ?? 4}+ days. Include at least 1 easy quality session (strides or short tempo). Do not prescribe fewer than ${spMi(cap.min)} — that is inconsistent with intermediate fitness.</rule>`;
  }
  // Beginner: "stale history" (forceBeginnerTier — Strava shows volume but athlete
  // self-reports as a current beginner) vs. genuinely no data yet. Same hard cap
  // (cap.max, from the shared "beginner, stale or no history" branch) either way —
  // only the surrounding explanation differs.
  if (forceBeginnerTier) {
    return `FITNESS TIER: Beginner self-report. Strava shows ${spMi(avgWeeklyMileage ?? 0)} avg but athlete self-identifies as a current beginner — historical Strava data reflects past fitness, not current ability. Default to a conservative, base-building approach.
<rule>WEEK 1 VOLUME CAP (beginner, stale history): Week 1 must not exceed ${spMi(cap.max!)} total. Start extremely conservatively — 3–4 short sessions of ${spMi(2)}–${spMi(3)} each is appropriate. Do NOT use the Strava historical average to set this week's volume. It is much easier to add volume next week than to walk back an injury in week one.</rule>`;
  }
  return `FITNESS TIER: No activity data yet. Default to a conservative, base-building approach until training history establishes their level.
<rule>WEEK 1 VOLUME CAP (no history, beginner): Since no mileage data exists and this is a beginner, Week 1 must not exceed ${spMi(cap.max!)} total. Start extremely conservatively — 3 short sessions of ${spMi(2)}–${spMi(3)} each is appropriate. It is much easier to add volume next week than to walk back an injury in week one.</rule>`;
}

/** Builds the FITNESS TIER block: tier label + prose + hard volume/long-run caps. */
export function buildFitnessTierBlock(params: FitnessTierParams): string {
  const { avgWeeklyMileage, forceBeginnerTier, isMetric, daysSinceLastRun } = params;
  const spMi = (miles: number) => (isMetric ? `${(miles * 1.60934).toFixed(1)} km` : `${miles.toFixed(1)} mi`);

  if (avgWeeklyMileage == null || forceBeginnerTier) {
    return buildNoHistoryTier(params, spMi);
  }

  const cap = computeWeekOneVolumeCap(avgWeeklyMileage, null, false, daysSinceLastRun ?? null);
  const gapApplies = daysSinceLastRun != null && daysSinceLastRun >= 7;
  const gapNote = gapApplies
    ? ` GAP SINCE LAST RUN: ${daysSinceLastRun} days. That average was built before this gap and overstates current readiness — it's already been factored into the caps below, do not layer your own additional reduction or add it back on top.`
    : "";

  if (avgWeeklyMileage < 10) {
    const longRunCap = computeLongRunCap(avgWeeklyMileage)!;
    return `FITNESS TIER: LOW VOLUME (avg ${spMi(avgWeeklyMileage)}).${gapNote} Prioritize easy aerobic volume and consistency. Include at least 1 quality session per week (strides, a short tempo, or brief intervals) — even low-volume athletes benefit from variety and it keeps training engaging. Calibrate the intensity and duration of quality work to their actual experience level (check all-time Strava mileage) and race goal — a true beginner building their first base needs gentler introductions to quality work than an experienced runner who's simply at low volume right now.
<rule>WEEK 1 VOLUME CAP — HARD LIMIT: This athlete currently runs ~${spMi(avgWeeklyMileage)}. Week 1 MUST NOT exceed ${spMi(cap.max!)} total${gapApplies ? "" : ` (current volume × 1.30, floor ${spMi(6)})`}. This is non-negotiable — prescribing 2–3× their current volume is a guaranteed injury risk. Do not exceed this cap under any circumstances, regardless of race goals or timelines.</rule>
<rule>LONG RUN CAP — HARD LIMIT: The single longest run in Week 1 must not exceed ${spMi(longRunCap)} (35% of current weekly volume, floor ${spMi(3)}). A long run that equals or exceeds the athlete's entire weekly baseline is a serious injury risk. State your long run distance, then verify it does not exceed this cap before sending.</rule>`;
  }

  if (avgWeeklyMileage < 30) {
    const targetMin = gapApplies ? cap.min : Math.round(avgWeeklyMileage * 1.05);
    const targetMax = gapApplies ? cap.max! : Math.round(avgWeeklyMileage * 1.15);
    return `FITNESS TIER: MODERATE VOLUME (avg ${spMi(avgWeeklyMileage)}).${gapNote} This athlete has an established aerobic base${gapApplies ? ", but hasn't been holding that volume recently" : ""}. 1–2 quality sessions per week (tempo or interval work) are appropriate and expected alongside easy volume. The 80/20 principle applies — most miles easy, but don't withhold quality work.
<rule>WEEK 1 VOLUME CAP — LIMIT: Week 1 should target ${spMi(targetMin)}–${spMi(targetMax)}. Do not exceed ${spMi(cap.max!)} — if your sessions sum above this ceiling, reduce at least one easy run until the total is under it. A first-week spike risks overuse injury at the start of the plan.</rule>
<rule>WEEK 1 MINIMUM FLOOR: Week 1 must not fall below ${spMi(cap.min)}.${gapApplies ? "" : " Starting below the athlete's current base has no training rationale — they are already adapted to their current volume. Even for first-timers, dropping significantly below current base wastes existing fitness."}</rule>`;
  }

  const targetMax = gapApplies ? cap.max! : Math.round(avgWeeklyMileage * 1.05);
  return `FITNESS TIER: HIGH VOLUME (avg ${spMi(avgWeeklyMileage)}).${gapNote} This is an experienced, high-volume runner. Skip base-building preamble — they already have the base. Quality sessions are appropriate from the start. Plan to their current training level, not a conservative floor. Don't apply beginner defaults to an athlete running this kind of volume.
<rule>WEEK 1 VOLUME CAP — GUIDELINE: ${gapApplies ? `Given the layoff, Week 1 target is ${spMi(cap.min)}–${spMi(cap.max!)}` : `Even for high-volume runners, Week 1 of a new plan should not spike more than 10–15% above current base. Week 1 target: ${spMi(targetMax)}–${spMi(cap.max!)}`}. Don't jump to peak volume on Day 1.</rule>
<rule>WEEK 1 MINIMUM FLOOR: Week 1 must not fall below ${spMi(cap.min)}.${gapApplies ? "" : " Even for masters athletes, first-timers, or conservative builds, starting significantly below current base wastes the fitness already built. 90% of current average is the floor."}</rule>`;
}
