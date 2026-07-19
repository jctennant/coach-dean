import { supabase } from "@/lib/supabase";
import { insertConversation } from "@/lib/conversations";
import { anthropic } from "@/lib/anthropic";
import { sendSMS } from "@/lib/linq";
import type { Json } from "@/lib/database.types";
import { composeStrengthRoutine } from "@/lib/strength-library";
import { CROSS_TRAINING_ALTERNATIVES, MODALITY_PATTERNS, MODALITY_DISPLAY_NAMES, DEFAULT_SAFE_MODALITIES } from "@/lib/exercise-library";

/**
 * Compute training phase for a pre-generated plan arc, based on position
 * within the plan rather than the actual calendar date.
 *
 * For race plans, thresholds scale proportionally so short plans (e.g. 12 weeks)
 * still have all four phases instead of collapsing everything into "build".
 */
export function computePhaseForPlan(weekNumber: number, totalWeeks: number, hasRace: boolean): string {
  if (!hasRace) {
    const cyclePos = (weekNumber - 1) % 12;
    return cyclePos < 6 ? "base" : "build";
  }
  const weeksFromEnd = totalWeeks - weekNumber;
  // 2-week taper max — 3 weeks is too long for short plans (e.g. 5-week half marathon)
  if (weeksFromEnd < 2) return "taper";
  // Scale peak/build thresholds down for shorter plans so a 12-week plan still
  // has base → build → peak → taper instead of just build → taper.
  const scale = Math.min(1, totalWeeks / 24);
  const peakThreshold = Math.max(4, Math.round(7 * scale));
  const buildThreshold = Math.max(peakThreshold + 2, Math.round(14 * scale));
  if (weeksFromEnd < peakThreshold) return "peak";
  if (weeksFromEnd < buildThreshold) return "build";
  return "base";
}

/**
 * Compute a sensible peak weekly mileage for a training plan based on race goal
 * and current fitness.
 *
 * Two constraints work together:
 *   - hardCap: upper bound regardless of starting volume (prevents 100+ mpw for
 *     non-ultra goals on long plans)
 *   - floor: lower bound so a low-mileage runner (5 mpw) still gets a plan that
 *     can actually prepare them for the target race distance
 *
 * The build factor in the arc loop is then derived dynamically from
 * (targetPeak / baseMileage)^(1/realBuildWeeks), clamped to 2%–10%/week.
 * This means a low-volume runner ramps faster (≈10%/week) while a runner already
 * near the cap ramps slowly or plateaus entirely.
 */
function getTargetPeakMileage(goal: string | null, baseMileage: number): number {
  const g = (goal ?? "").toLowerCase();
  let hardCap: number;
  let floor: number;

  // Floors are calibrated so that `floor × 0.42` (peak long run factor) reaches the
  // minimum adequate long run for that race distance. Rule of thumb: peak long run
  // should be 75-90% of race distance, capped at a sensible ceiling.
  //
  //   Race      Race dist  Min long run  Floor needed  (floor × 0.42)
  //   5K        3.1 mi     5 mi          ~12 mi         5.0 ✓
  //   10K       6.2 mi     8 mi          ~20 mi         8.4 ✓
  //   Half      13.1 mi    10 mi         ~25 mi        10.5 ✓  (30 gives headroom)
  //   Marathon  26.2 mi    18 mi         ~43 mi        18.1 ✓  (45 gives headroom)
  //   30K       18.6 mi    14 mi         ~34 mi        14.3 ✓
  //   50K       31 mi      20 mi         ~48 mi        20.2 ✓  (50 gives headroom)
  //   50mi      50 mi      22 mi         ~52 mi        21.8 ✓  (55 gives headroom)
  //   100K      62 mi      25 mi         ~60 mi        25.2 ✓  (65 gives headroom)
  //   100mi     100 mi     28 mi         ~67 mi        28.1 ✓  (70 gives headroom)
  //
  // Hard caps for ultra distances are intentionally conservative: recreational ultra
  // runners peak at 65-85 mi/week for 100K, 75-90 for 100mi. The old 110 cap allowed
  // the 2.0x multiplier to push a 48 mi/week runner to a 96-mile peak — too aggressive.

  if (g.includes("100mi") || g.includes("100 m")) {
    // 100-milers genuinely require high volume; cap is higher but still bounded.
    hardCap = 95; floor = 70;
  } else if (g.includes("100k")) {
    // 100K (62mi): recreational peak of 65-85 mi/week is sufficient. 85 cap prevents
    // doubling from a 48 mi/week base to 96 miles.
    hardCap = 85; floor = 65;
  } else if (g.includes("50mi") || g.includes("50 mi")) {
    hardCap = 80; floor = 55;
  } else if (g.includes("50k") || g.includes("50 k")) {
    hardCap = 90; floor = 50;
  } else if (g.includes("30k") || g.includes("30 k")) {
    hardCap = 80; floor = 35;
  } else if ((g.includes("marathon") || g.includes("26.2")) && !g.includes("half")) {
    // Floor raised from 35 → 45 so peak long runs reliably reach 18-19mi.
    // At the old 35mi floor, the long run was only ~14.7mi — inadequate for a marathon.
    hardCap = 75; floor = 45;
  } else if (g.includes("half") || g.includes("13.1")) {
    // Floor of 25 → peak long run ~10.5mi at 0.42 factor. Adequate for HM (needs 10+mi)
    // and achievable in a 14-week plan from 8mi/week. 30mi was slightly too high — it
    // creates arcs showing an unachievable peak for short plans from low bases.
    hardCap = 55; floor = 25;
  } else if (g.includes("10k") || g.includes("10 k")) {
    // Floor of 18 → peak long run ~7.6mi, more than the 6.2mi race distance.
    hardCap = 50; floor = 18;
  } else if (g.includes("5k") || g.includes("5 k")) {
    hardCap = 45; floor = 12;
  } else if (g === "mile" || g.includes("1 mile") || g.includes("1mi") || g.includes("sub-5") || g.includes("sub 5")) {
    // Mile time trial: speed-focused, moderate volume. No long runs needed.
    // Peak of 40mi provides enough aerobic base + room for quality sessions.
    hardCap = 40; floor = 15;
  } else if (g === "ironman") {
    // Ironman: marathon-distance run leg, but athletes also swim/bike heavily.
    // Run-specific volume is lower than standalone marathon training.
    hardCap = 55; floor = 30;
  } else if (g === "70.3") {
    // 70.3 / Half Ironman: half-marathon run leg. Cross-training burden reduces run volume.
    hardCap = 45; floor = 20;
  } else if (g === "olympic_tri") {
    // Olympic triathlon: 10K run leg. Run-only coaching keeps volume moderate.
    hardCap = 40; floor = 15;
  } else if (g === "sprint_tri") {
    // Sprint triathlon: 5K run leg. Athletes cross-train heavily; run volume stays low.
    hardCap = 30; floor = 10;
  } else {
    hardCap = 60; floor = 20;
  }
  // Growth multiplier: how much volume can increase over the full training cycle.
  // Ultra goals use 1.6x — doubling is too aggressive when the base is already high
  // (45 mi/week × 2.0 = 90, which overshoots what's appropriate for a recreational 100K).
  // Road races use 2.0x — a half marathon runner going from 15 → 30 mi/week is normal.
  const isUltra = g.includes("100k") || g.includes("100mi") || g.includes("100 m")
    || g.includes("50mi") || g.includes("50 mi") || g.includes("50k") || g.includes("50 k");
  const growthMultiplier = isUltra ? 1.6 : 2.0;
  return Math.round(Math.max(Math.min(baseMileage * growthMultiplier, hardCap), floor) * 2) / 2;
}

/**
 * Compute the peak long run achievable at a safe build rate (10%/week) in the
 * available build weeks. Used to flag under-prepared athletes before the initial plan.
 *
 * Returns { achievablePeakMiles, achievableLongRunMiles, minAdequateLongRun } or null
 * if there's not enough data to compute (no base, no race date).
 */
export function computeRacePreparedness(
  goal: string | null,
  baseMilesPerWeek: number | null,
  raceDateStr: string | null,
): { achievablePeak: number; achievableLongRun: number; minAdequateLongRun: number } | null {
  if (!baseMilesPerWeek || !raceDateStr || !goal) return null;

  const minAdequateLongRunByGoal: Record<string, number> = {
    "5k": 5, "10k": 8, "half_marathon": 10, "marathon": 18,
    "30k": 14, "50k": 20, "50mi": 22, "100k": 24, "100mi": 24,
  };
  const minAdequateLongRun = minAdequateLongRunByGoal[goal] ?? null;
  if (!minAdequateLongRun) return null;

  const raceDateMs = new Date(raceDateStr + "T12:00:00Z").getTime();
  const totalWeeks = Math.max(1, Math.ceil((raceDateMs - Date.now()) / (7 * 24 * 60 * 60 * 1000)));
  const realBuildWeeks = Math.max(1, totalWeeks - 2); // 2 taper weeks

  // Max achievable peak at 10%/week, capped at getTargetPeakMileage ceiling
  const rawAchievable = baseMilesPerWeek * Math.pow(1.10, realBuildWeeks);
  const peakCap = getTargetPeakMileage(goal, baseMilesPerWeek);
  const achievablePeak = Math.min(rawAchievable, peakCap);
  const achievableLongRun = Math.round(achievablePeak * 0.42 * 10) / 10;

  return { achievablePeak: Math.round(achievablePeak * 10) / 10, achievableLongRun, minAdequateLongRun };
}

/**
 * Validate and correct the stated distance prefix in a key_workout string.
 *
 * Haiku is instructed to make the prefix equal the sum of components
 * (SESSION MATH RULE), but sometimes gets it wrong. This function parses
 * patterns like "Tempo 3mi (1mi WU + 1.5mi @ threshold + 1mi CD)", sums the
 * component distances inside the parentheses, and corrects the prefix if it
 * differs.
 *
 * Only corrects when ALL parenthetical components have explicit distance values
 * in the target unit — if any component is time-based (e.g. "4×3min") or uses
 * rep-count notation (e.g. "6×800m"), the total is uncertain and the prefix is
 * left unchanged.
 *
 * @param kw       - The key_workout string from Haiku
 * @param unitLabel - "mi" or "km" — used to identify distance markers
 */
export function fixKeyWorkoutMath(kw: string, unitLabel: "mi" | "km"): string {
  // Match: "Label Xunit (components...)" — e.g. "Tempo 3.5mi (1mi WU + 1.5mi @ threshold + 1mi CD)"
  const prefixRe = new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)${unitLabel}\\s+\\((.+)\\)(.*)$`);
  const m = prefixRe.exec(kw);
  if (!m) return kw;

  const [, label, prefixStr, inside, trailer] = m;
  const stated = parseFloat(prefixStr);

  // Extract all distance values from inside the parentheses.
  // A component is "unambiguous" if it has an explicit Xunit marker.
  // Time-based markers (min, sec) and rep-count notation (×) are ambiguous.
  const componentRe = new RegExp(`(\\d+(?:\\.\\d+)?)${unitLabel}`, "g");
  const ambiguousRe = /\d+\s*(?:min|sec|×|x)\b/i;

  if (ambiguousRe.test(inside)) return kw; // uncertain — leave as-is

  const components: number[] = [];
  let cm: RegExpExecArray | null;
  const re = new RegExp(componentRe.source, "g");
  while ((cm = re.exec(inside)) !== null) {
    components.push(parseFloat(cm[1]));
  }

  if (components.length < 2) return kw; // not enough components to validate

  const sum = Math.round(components.reduce((a, b) => a + b, 0) * 10) / 10;
  if (Math.abs(sum - stated) < 0.05) return kw; // already correct within rounding

  console.warn(
    `[fixKeyWorkoutMath] "${kw}" — stated ${stated}${unitLabel} but components sum to ${sum}${unitLabel}. Correcting.`
  );
  return `${label} ${sum}${unitLabel} (${inside})${trailer}`;
}

export interface MileageArcWeek {
  week_number: number;
  phase: string;
  mileage_target: number;
  long_run_target: number;
  key_workout: string;
  key_workout_2?: string | null;
  notes: string;
  cross_training?: string | null;
}

export interface MileageArcParams {
  /** Week 1 mileage — the arc's starting point (prescribed, or Strava-derived). */
  baseMileage: number;
  totalWeeks: number;
  goal: string | null;
  hasRace: boolean;
  /** A-race week number, if the plan extends past the A-race to cover a later B/C race. */
  aRaceWeekNum?: number | null;
  /** True when there are plan weeks after the A-race (B-race coverage). */
  planExtendsPostA?: boolean;
  /**
   * Override the computed target peak mileage (skips getTargetPeakMileage(goal, baseMileage)).
   * Use when a real peak is already known and shouldn't be re-derived from a temporarily
   * reduced baseMileage — e.g. projecting a return-to-run ramp from a low post-injury base
   * should still build back toward the athlete's actual established pre-injury peak, not a
   * smaller peak re-computed from the reduced starting point.
   */
  targetPeakOverride?: number | null;
}

/**
 * Pure week-by-week mileage/long-run/phase arc computation — no Haiku enrichment, no DB
 * writes, no side effects. This is the single source of truth for the mileage progression,
 * shared by generateAndSaveFullPlan (the real, persisted plan) and any predictive/preview
 * use (e.g. the "what's the plan" answer Dean gives an athlete still on injury hold, before
 * the arc is actually rebuilt at clearance) — so a projected number can't drift from what
 * the plan is actually built with once it's generated for real.
 */
export function computeMileageArc(params: MileageArcParams): MileageArcWeek[] {
  const { baseMileage, totalWeeks, goal, hasRace, aRaceWeekNum = null, planExtendsPostA = false, targetPeakOverride = null } = params;

  // Compute a race-type-aware peak with both a floor (low-mileage runners still get
  // a plan sufficient for the target distance) and a hard cap (no 100+ mpw marathon
  // plans on 7-month arcs). The build factor is then derived dynamically so the arc
  // reaches targetPeak at exactly the right rate regardless of plan length.
  const targetPeak = targetPeakOverride ?? getTargetPeakMileage(goal, baseMileage);

  // Count real build weeks (non-deload, non-taper, non-peak, after week 1) so we can
  // derive a build factor that reaches targetPeak by the START of peak phase — peak
  // weeks then plateau at targetPeak rather than continuing to ramp through peak.
  let realBuildWeeks = 0;
  for (let w = 2; w <= totalWeeks; w++) {
    const ph = computePhaseForPlan(w, totalWeeks, hasRace);
    const isD = w % 4 === 0 && ph !== "taper" && ph !== "peak";
    if (!isD && ph !== "taper" && ph !== "peak") realBuildWeeks++;
  }
  // Derived factor: (targetPeak / baseMileage) ^ (1 / realBuildWeeks)
  // Clamped to 2%–10%/week: never slower than a plateau, never faster than convention allows.
  const rawFactor = realBuildWeeks > 0 ? Math.pow(targetPeak / baseMileage, 1 / realBuildWeeks) : 1.07;
  const weeklyBuildFactor = Math.max(1.02, Math.min(1.10, rawFactor));

  // Build the arc week by week.
  // `buildMileage` tracks the real progression level (deloads and tapers branch off it).
  // Race-type-aware race week factor — represents pre-race training miles only.
  // Lowered significantly from a flat 0.50 to account for the race distance itself
  // being a major effort in that week (marathon adds 26.2mi on top of training).
  const isUltraGoal = ["50k","100k","50mi","100mi"].includes(goal ?? "");
  const isMarathonGoal = goal === "marathon" || goal === "30k";
  const isHalfGoal = goal === "half_marathon";
  const raceWeekFactor = isUltraGoal ? 0.25 : isMarathonGoal ? 0.25 : isHalfGoal ? 0.28 : 0.35;

  let buildMileage = baseMileage;
  let peakMileage = baseMileage;

  const planWeeks: MileageArcWeek[] = [];

  for (let week = 1; week <= totalWeeks; week++) {
    const phase = computePhaseForPlan(week, totalWeeks, hasRace);
    const weeksFromEnd = totalWeeks - week;

    // A-race taper/recovery: override mileage when the plan extends past the A-race.
    // Weeks immediately before/at the A-race get a 2-week taper; the week after gets
    // a recovery. This prevents the A-race week from showing as "build" (e.g. 48mi).
    const isATaperWeek = planExtendsPostA && aRaceWeekNum !== null &&
      week >= Math.max(1, aRaceWeekNum - 1) && week <= aRaceWeekNum;
    const isARecoveryWeek = planExtendsPostA && aRaceWeekNum !== null &&
      week === aRaceWeekNum + 1;

    const isDeload = week % 4 === 0 && phase !== "taper" && phase !== "peak" && !isATaperWeek && !isARecoveryWeek;

    let weekMileage: number;
    if (isATaperWeek) {
      // Use buildMileage as the peak reference — we may not have hit "peak" phase yet when
      // the A-race taper starts (e.g. a 10-week A-race in a 14-week plan has no peak phase
      // before the taper). effectivePeak persists so the post-A-race build tapers correctly.
      const effectivePeak = Math.max(peakMileage, buildMileage);
      peakMileage = effectivePeak;
      const taperFactor = week === aRaceWeekNum ? raceWeekFactor : 0.70;
      weekMileage = Math.round(effectivePeak * taperFactor * 2) / 2;
      // buildMileage NOT updated — resumes from pre-taper level after recovery week
    } else if (isARecoveryWeek) {
      // Recovery week after racing: ~50% of peak lets the athlete absorb the race effort
      // before rebuilding toward the B-race.
      weekMileage = Math.round(Math.max(peakMileage, buildMileage) * 0.50 * 2) / 2;
      // buildMileage NOT updated — resumes from pre-taper level in the next build week
    } else if (phase === "taper") {
      // 2-week taper: 70% → raceWeekFactor of peak.
      // Race week factor is intentionally low (0.25–0.35) because it represents
      // pre-race training miles only — the race distance itself is an additional
      // major effort in that week.
      const taperWeek = 2 - weeksFromEnd; // 1, 2
      const taperFactor = taperWeek >= 2 ? raceWeekFactor : 0.70;
      weekMileage = Math.round(peakMileage * taperFactor * 2) / 2;
    } else if (isDeload) {
      weekMileage = Math.round(buildMileage * 0.70 * 2) / 2;
      // buildMileage stays unchanged — resumes from pre-deload level next week
    } else {
      // Week 1 IS the base — don't apply buildFactor so the arc starts at exactly
      // prescribedWeek1Miles (or baseMileage). Build begins from week 2 onward.
      if (week > 1) {
        // Build toward targetPeak each week, capped at targetPeak.
        // In peak phase this naturally plateaus once targetPeak is reached — the min() prevents
        // exceeding it. We no longer force `buildMileage = targetPeak` because that created a
        // hard jump for low-mileage runners whose floor (e.g. 45mi marathon) is unreachable
        // in the available weeks (e.g. 5mi/week × 10% growth only reaches ~12mi in 15 weeks).
        buildMileage = Math.min(
          Math.round(buildMileage * weeklyBuildFactor * 2) / 2,
          targetPeak,
        );
      }
      weekMileage = buildMileage;
      if (phase === "peak") peakMileage = buildMileage;
    }

    // Peak long run takes a larger fraction of weekly volume for race-distance goals.
    // 0.42 is especially important for 3-day/week athletes where the long run is the primary
    // quality session — at 30mi/week that gives an 12.6mi long run (appropriate for HM prep).
    const effectivePhaseForLongRun = isATaperWeek ? "taper" : isARecoveryWeek ? "base" : phase;
    const longRunFactor = effectivePhaseForLongRun === "taper" ? 0.30 : effectivePhaseForLongRun === "peak" ? 0.42 : 0.33;
    // Goal-specific long run caps: short-race training doesn't need marathon-style long runs.
    const g2 = (goal ?? "").toLowerCase();
    const longRunCap = (g2.includes("5k") || g2.includes("5 k")) ? 7
      : (g2.includes("10k") || g2.includes("10 k")) ? 10
      : (g2.includes("half") || g2.includes("13.1")) ? 14
      : null;
    const rawLongRun = Math.round(weekMileage * longRunFactor * 2) / 2;
    const longRunTarget = longRunCap !== null ? Math.min(rawLongRun, longRunCap) : rawLongRun;

    // Display phase for dashboard: A-race taper weeks show "taper", recovery shows "base".
    let displayPhase: string;
    if (isATaperWeek) displayPhase = "taper";
    else if (isARecoveryWeek) displayPhase = "base";
    else displayPhase = isDeload ? "deload" : phase;

    planWeeks.push({
      week_number: week,
      phase: displayPhase,
      mileage_target: weekMileage,
      long_run_target: longRunTarget,
      key_workout: "",
      notes: "",
    });
  }

  return planWeeks;
}

/**
 * Compute the full multi-week training arc and save it to training_plans.
 * Generates a dashboard_token (used for billing checkout/cancel links) and sets trial_started_at.
 */
export async function generateAndSaveFullPlan(
  userId: string,
  phoneNumber: string,
  profile: Record<string, unknown> | null,
  avgWeeklyMileage: number | null,
  { prescribedWeek1Miles, bRaces, resetToWeek1 = true, week1Reset = false, preservedSessions, planReadyNote, wantsSpeedWork = false, otherNotes = null, anchorMonday }: {
    prescribedWeek1Miles?: number;
    bRaces?: Array<{ race_date: string; race_name: string | null; priority: string }>;
    /**
     * Whether to reset training_state.current_week to 1.
     * Set true (default) when this is a genuinely new plan — new race date, new goal,
     * or first-time onboarding. The user is starting from scratch.
     * Set false when regenerating mid-plan for the same race/goal (e.g. tweaking
     * mileage targets) so the user stays on their current week.
     */
    resetToWeek1?: boolean;
    /**
     * When true (and resetToWeek1 is false), this is a week-1 mid-plan rebuild.
     * Unlike normal mid-plan rebuilds, week 1 rebuilds DO update weekly_mileage_target
     * and weekly_plan_sessions (clearing future sessions, keeping past ones).
     */
    week1Reset?: boolean;
    /**
     * Past sessions to preserve when week1Reset is true. Sessions with dates before today
     * are kept so context about completed/missed sessions isn't lost.
     */
    preservedSessions?: Array<{ day: string; date: string; label: string }> | null;
    /** Custom context line appended to the post-rebuild dashboard SMS. */
    planReadyNote?: string;
    /** When true, inject speed-work-first guidance into Haiku enrichment */
    wantsSpeedWork?: boolean;
    /** Athlete preferences from onboarding_data.other_notes (hill repeats, cycling, etc.) */
    otherNotes?: string | null;
    /**
     * Override the Monday used to compute totalWeeks and aRaceWeekNum.
     * For mid-plan rebuilds (resetToWeek1=false), pass the plan's week-1 Monday
     * (= thisMonday - (currentWeek-1)*7) so that race week numbers align with the
     * dashboard's anchor rather than the current Monday.
     */
    anchorMonday?: Date;
  } = {},
): Promise<string> {
  // Fetch A race from the races table as the authoritative source.
  // Falls back to profile.race_date / profile.goal for backward compatibility
  // (e.g. legacy users who have no races row yet, or test environments).
  const { data: aRaceRow } = await supabase
    .from("races")
    .select("race_date, goal")
    .eq("user_id", userId)
    .eq("priority", "A")
    .single();

  const raceDate = (aRaceRow?.race_date as string | null) ?? (profile?.race_date as string | null) ?? null;
  const goal = (aRaceRow?.goal as string | null) ?? (profile?.goal as string | null) ?? null;
  const easyPace = (profile?.current_easy_pace as string | null) ?? null;
  const tempoPace = (profile?.current_tempo_pace as string | null) ?? null;
  const intervalPace = (profile?.current_interval_pace as string | null) ?? null;
  // Prefer the explicit days_per_week column; fall back to training_days array length
  // so Haiku enrichment always gets the right session count even if days_per_week is stale or null.
  const trainingDaysArray = (profile?.training_days as string[] | null) ?? [];
  const daysPerWeek = (profile?.days_per_week as number | null)
    ?? (trainingDaysArray.length > 0 ? trainingDaysArray.length : 4);
  const injuryNotes = (profile?.injury_notes as string | null) ?? null;
  const hasRace = !!raceDate;

  // Determine total weeks: anchor to the start of the current week (Monday) so the race
  // always falls within the last plan week rather than one week past it. Using "now" directly
  // is sensitive to the time of day — if the plan is generated after noon UTC, a race that's
  // exactly N weeks out can round down to N-1 weeks, leaving the race outside the plan.
  //
  // For mid-plan rebuilds (resetToWeek1=false), callers should pass anchorMonday set to the
  // plan's week-1 Monday (= thisMonday - (currentWeek-1)*7). This ensures totalWeeks and
  // aRaceWeekNum are computed relative to the plan's original start rather than today, so
  // race week numbers stay in sync with the dashboard's calendar anchor.
  let totalWeeks = 12;
  const now = new Date();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  // planMonday: the anchor used for totalWeeks / aRaceWeekNum / B-race week labels.
  // Defaults to the current Monday; overridden by anchorMonday for mid-plan rebuilds.
  const planMonday = anchorMonday ? new Date(anchorMonday) : monday;
  if (raceDate) {
    const race = new Date(raceDate + "T12:00:00Z");
    const weeksUntil = Math.ceil((race.getTime() - planMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    totalWeeks = Math.max(4, Math.min(52, weeksUntil));
  }

  // Extend plan to cover B/C races that fall after the A race but within 8 weeks of it.
  // This ensures a runner with e.g. Dipsea (A, June 14) + Snowbird (B, July 11) gets a
  // single continuous plan rather than a plan that ends at Dipsea and leaves Snowbird
  // unplanned. The arc phases naturally taper to the last race; intermediate races are
  // labeled via bRaceWeekLabels so Haiku can annotate them as tune-up efforts.
  console.log("[training-plan] generateAndSaveFullPlan: raceDate=", raceDate, "totalWeeks=", totalWeeks, "bRaces=", JSON.stringify(bRaces ?? []), "anchorMonday=", planMonday.toISOString());
  if (bRaces?.length && raceDate) {
    const lastPostARace = bRaces
      .filter(r => r.race_date > raceDate)
      .sort((a, b) => a.race_date.localeCompare(b.race_date))
      .pop();
    if (lastPostARace) {
      const lastRaceMs = new Date(lastPostARace.race_date + "T12:00:00Z").getTime();
      const weeksToLast = Math.ceil((lastRaceMs - planMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
      console.log("[training-plan] B/C race extension check: lastPostARace=", lastPostARace.race_date, "weeksToLast=", weeksToLast, "totalWeeks=", totalWeeks);
      if (weeksToLast > totalWeeks && weeksToLast <= totalWeeks + 8) {
        totalWeeks = Math.min(52, weeksToLast);
        console.log("[training-plan] Extended totalWeeks to", totalWeeks, "to cover", lastPostARace.race_name ?? lastPostARace.race_date);
      }
    }
  }

  // A-race week number (same ceil formula as totalWeeks so week numbers align).
  // Used to inject a proper 2-week taper around the A-race when the plan extends past it
  // (due to B/C race coverage). Without this, the A-race week shows as "build" (48mi) instead
  // of a taper (~15mi pre-race training only).
  const aRaceWeekNum: number | null = raceDate
    ? Math.max(1, Math.min(
        Math.ceil((new Date(raceDate + "T12:00:00Z").getTime() - planMonday.getTime()) / (7 * 24 * 60 * 60 * 1000)),
        totalWeeks,
      ))
    : null;
  // planExtendsPostA: true when there are plan weeks after the A-race (B-race coverage).
  // The final race's taper is already handled by computePhaseForPlan; we only need to
  // explicitly inject the A-race taper when it falls mid-plan.
  const planExtendsPostA = aRaceWeekNum !== null && aRaceWeekNum < totalWeeks;

  // Base mileage: use the prescribed week 1 total if available (keeps arc week 1 in sync
  // with what Dean actually sent), otherwise fall back to the Strava avg.
  // When there's no Strava history, use fitness_level to pick a sensible default rather
  // than a flat 15mi — intermediate/advanced users shouldn't get a beginner-tier arc.
  const fitnessLevel = (profile?.fitness_level as string | null) ?? "beginner";
  // Beginner lowered from 15 → 8: a true zero-to-runner does 3-6mi/week on run/walk
  // plans; 15mi caused the arc to start at 15mi even when sessions were 24-min intervals.
  const noHistoryDefault = fitnessLevel === "advanced" ? 30 : fitnessLevel === "intermediate" ? 20 : 8;
  // For users who explicitly self-identify as beginners, cap the Strava-derived base at
  // noHistoryDefault (8mi). Historical Strava data may not reflect current fitness — a
  // "never run before" user whose account has old running activity would otherwise start
  // at 16+ mi/week when they can only manage run/walk intervals.
  // Uses strict equality (not the ?? "beginner" default) so legacy profiles without a
  // fitness_level set are not affected.
  const isExplicitlyBeginner = (profile?.fitness_level as string | null) === "beginner";
  const effectiveAvgMileage = isExplicitlyBeginner && avgWeeklyMileage != null && avgWeeklyMileage > noHistoryDefault
    ? noHistoryDefault
    : avgWeeklyMileage;
  const baseMileage = prescribedWeek1Miles
    ? Math.max(5, prescribedWeek1Miles)
    : Math.max(5, Math.round((effectiveAvgMileage ?? noHistoryDefault) * 2) / 2);

  const crosstrainingTools = (profile?.crosstraining_tools as string[] | null)?.filter(Boolean) ?? [];

  const planWeeks: MileageArcWeek[] = computeMileageArc({
    baseMileage,
    totalWeeks,
    goal,
    hasRace,
    aRaceWeekNum,
    planExtendsPostA,
  });

  // Enrich each week with key_workout and notes via Claude Haiku (single call).
  // Include B/C race dates so Haiku can flag those weeks appropriately.
  // (now and monday were computed above for totalWeeks; reuse them here)

  // Map each B/C race to a week number so Haiku can reference them by week.
  const bRaceWeekLabels: string[] = [];
  for (const r of bRaces ?? []) {
    const raceMs = new Date(r.race_date + "T12:00:00Z").getTime();
    // Use Math.ceil to match how totalWeeks and aRaceWeekNum are computed above.
    // Math.round(...) + 1 was off by one for races that fall early in a week.
    const weekNum = Math.ceil((raceMs - planMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (weekNum >= 1 && weekNum <= totalWeeks) {
      const label = r.race_name ?? (r.priority === "B" ? "B race" : "C race");
      bRaceWeekLabels.push(`Week ${weekNum}: ${r.priority} race — ${label} on ${r.race_date}`);
    }
  }
  const bRaceContext = bRaceWeekLabels.length > 0
    ? `\n\nB/C RACES (tune-up races during the plan):\n${bRaceWeekLabels.join("\n")}\nFor B race weeks: keep key_workout brief or race-focused ("B race — tune-up effort" or similar). For C race weeks: treat as a quality workout day.`
    : "";

  const preferredUnits = (profile?.preferred_units as string | null) ?? "imperial";
  const useKm = preferredUnits === "metric";
  const unitLabel = useKm ? "km" : "mi";
  const miToDisplay = (mi: number) => useKm ? Math.round(mi * 1.60934 * 10) / 10 : mi;

  const arcSummary = planWeeks.map(w =>
    `Week ${w.week_number} (${w.phase}, ${miToDisplay(w.mileage_target)}${unitLabel}, long run ~${miToDisplay(w.long_run_target)}${unitLabel})`
  ).join("\n");

  // A runner with an established base (≥10 mi/week) doesn't need weeks of pure easy
  // aerobic miles at the start — they already have the base. Quality sessions (strides,
  // short tempos, fartleks) are appropriate from week 1. Only truly new runners building
  // from scratch should have pure easy base weeks.
  const hasEstablishedBase = baseMileage >= 10;
  const baseMileageDisplay = `${miToDisplay(baseMileage)}${unitLabel}`;
  const basePhaseGuidance = hasEstablishedBase
    ? `This runner already has an established aerobic base at ~${baseMileageDisplay}/week. Do NOT assign pure easy/base-building weeks — include quality sessions (strides, fartlek, short tempo, easy intervals) from week 1 onward. Reserve "easy aerobic miles" labels only for deload weeks.`
    : `This runner is building their base from scratch. Early base-phase weeks should be easy aerobic miles to develop the aerobic foundation before adding quality.`;

  // Ultra-specific enrichment guidance: back-to-back long runs are the central stimulus
  // for ultra preparation and must be introduced early — not saved for late in the plan.
  const isUltraEnrich = ["50k","50 k","100k","100 k","50mi","50 m","100mi","100 m","ultra"]
    .some(u => (goal ?? "").toLowerCase().includes(u));

  // Determine the athlete's actual back-to-back days from their training schedule.
  // Use the last two training days of the week (by weekday order) so we don't hardcode Sat+Sun.
  // For athletes who prefer Fri+Sat or Thu+Sat, this produces the correct day names.
  const WEEKDAY_ORDER: Record<string, number> = {
    monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
  };
  const rawTrainingDays = (profile?.training_days as string[] | null) ?? [];
  const sortedTrainingDays = [...rawTrainingDays]
    .map(d => d.toLowerCase())
    .sort((a, b) => (WEEKDAY_ORDER[a] ?? 0) - (WEEKDAY_ORDER[b] ?? 0));
  const capDay = (d: string) => d.charAt(0).toUpperCase() + d.slice(1, 3);
  // Back-to-back = the two highest-order training days (end of the athlete's week)
  const bbDay1 = sortedTrainingDays.length >= 2
    ? capDay(sortedTrainingDays[sortedTrainingDays.length - 2])
    : "Sat";
  const bbDay2 = sortedTrainingDays.length >= 1
    ? capDay(sortedTrainingDays[sortedTrainingDays.length - 1])
    : "Sun";

  const ultraGuidance = isUltraEnrich ? `

ULTRA-SPECIFIC REQUIREMENTS (mandatory):
- Introduce back-to-back long run weekends (e.g. "${bbDay1} ${miToDisplay(18)}${unitLabel} + ${bbDay2} ${miToDisplay(12)}${unitLabel} easy") no later than week ${Math.max(3, Math.round(totalWeeks * 0.25))} of ${totalWeeks}. This is the key ultra stimulus — do NOT delay it to the second half of the plan.
- Include trail-specific context from week 1: hiking steep uphills (power-hiking is faster than running them in a 50k/100k), running by time-on-feet rather than strict pace, and managing elevation.
- key_workout for back-to-back weekends should specify both days, e.g. "${bbDay1} ${miToDisplay(20)}${unitLabel} trail + ${bbDay2} ${miToDisplay(14)}${unitLabel} easy (back-to-back)". Do NOT schedule the second back-to-back day on a day the athlete doesn't train — use the athlete's actual training days above.
- Notes should reference the back-to-back adaptation, hiking uphills, and time-on-feet philosophy when applicable.` : "";

  try {
    const enrichResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: Math.min(8000, Math.max(4000, totalWeeks * 400)),
      system: `You are a running coach generating a structured training plan arc.
For each week provide:
- key_workout: the quality/speed session for that week (1 line). CRITICAL RULE: key_workout must ALWAYS be a quality/form session — NEVER echo the long run (it's displayed separately on the dashboard). The long run is always shown on its own; if you put "Long run Xmi" here, the dashboard shows the same thing twice and the athlete gets no quality/form stimulus. Pick the most appropriate quality session for the week's context. Examples: "6×800m @ 5K pace", "4${unitLabel} tempo @ threshold", "6×strides + easy 5${unitLabel}", "20min fartlek", "Race simulation 5${unitLabel} @ goal pace", "Hill repeats 6×90sec". Beginner base-building weeks, recovery weeks, and deload weeks: always include strides at minimum — "Easy ${miToDisplay(2)}${unitLabel} + 4×20sec strides" — strides are low-impact form work appropriate from week 1 for any runner. IMPORTANT: All distances in key_workout and notes must use ${unitLabel} (${useKm ? "kilometers" : "miles"}) — never mix units.

WARM-UP / COOL-DOWN RULE: Every interval or tempo key_workout MUST include a 1${unitLabel} warm-up and 1${unitLabel} cool-down. Format: "Intervals Xmi (1${unitLabel} WU + main set + 1${unitLabel} CD)". This applies to all quality sessions including time-based intervals (e.g. "4×3min") — the WU/CD are distance-based even when the main set is time-based. Example: "Intervals 3.5${unitLabel} (1${unitLabel} WU + 4×3min @ 5K effort + 1${unitLabel} CD)". Strides and fartleks are exempt (they fold into an easy run).

SESSION MATH RULE: The distance prefix MUST equal the SUM of all components. Wrong: "Tempo 2${unitLabel} (1${unitLabel} WU + 1.5${unitLabel} @ threshold + 1${unitLabel} CD)" — 1+1.5+1=3.5, not 2. Right: "Tempo 3.5${unitLabel} (1${unitLabel} WU + 1.5${unitLabel} @ threshold + 1${unitLabel} CD)". For time-based main sets where total distance is uncertain, omit the prefix: "Intervals (1${unitLabel} WU + 4×3min @ 5K effort + 1${unitLabel} CD)".

- notes: 2-3 sentences for the athlete to read on their dashboard. First sentence: the week's purpose and why it matters at this stage of training (e.g. "Week 6 is about building your aerobic base — consistent easy mileage here pays dividends in the peak phase."). Then 1-2 sentences on the key workout: what it is, the target effort or pace, and one brief execution tip (e.g. "The tempo run on Wednesday should feel comfortably hard — you should be able to speak in short phrases but not hold a conversation. Start controlled and aim to hold pace in the second half."). Deload weeks should acknowledge the pullback and why recovery is productive. Keep it direct and practical, not generic.
${crosstrainingTools.length > 0 ? `
- cross_training: a single cross-training session prescription for the week (1 line). IMPORTANT: the athlete's tools are [${crosstrainingTools.join(", ")}] — ONLY use these. Do NOT suggest swimming if the athlete didn't mention it; do NOT suggest cycling if the athlete didn't mention it. Match the phase: base/deload = easy aerobic effort; build = moderate/sweetspot effort; peak = moderate effort; taper = easy only. Examples for cycling: "Z2 ride 45 min", "Sweetspot ride 45 min", "Easy spin 25 min". Examples for swimming: "Easy swim 30 min", "Swim drill sets 35 min". Keep it brief — just the session label. This replaces a rest day, it does NOT add to the running volume.` : ""}

- key_workout_2 (optional): a SECOND quality session. Use ONLY when the phase is "build" or "peak" AND either (a) goal is mile/5k/10k/half_marathon/marathon AND weekly mileage ≥40mi, or (b) goal is mile/5k/10k AND weekly mileage ≥30mi. Leave null for base, deload, taper, and all lower-volume weeks. Format and WU/CD rules identical to key_workout. Pick a complementary session type — e.g. if key_workout is tempo, key_workout_2 should be shorter intervals or strides; if key_workout is intervals, key_workout_2 could be a short tempo or fartlek. DO NOT generate key_workout_2 for athletes with injury notes. Leave null when unsure.

Return ONLY a valid JSON array:
[{"week_number": 1, "key_workout": "...", "key_workout_2": null, "notes": "..."${crosstrainingTools.length > 0 ? ', "cross_training": "..."' : ""}}, ...]
No other text.`,
      messages: [{
        role: "user",
        content: `Goal: ${goal ?? "general running fitness"}\nRace date: ${raceDate ?? "none"}\nCurrent fitness: ~${baseMileageDisplay}/week${easyPace ? `, easy pace ${easyPace}` : ""}${tempoPace ? `, tempo pace ${tempoPace}` : ""}${intervalPace ? `, interval/5K pace ${intervalPace}` : ""}\nDays/week: ${daysPerWeek}\nPreferred units: ${unitLabel}\n\n${basePhaseGuidance}${ultraGuidance}${bRaceContext}${!easyPace && !tempoPace && !intervalPace ? "\n\nNO PACE DATA: This athlete has not yet established pace baselines. In key_workout and notes, use effort-based language only: 'easy effort', 'comfortably hard', 'hard/near-maximal effort'. Do NOT invent or estimate specific minute/mile or minute/km pace targets — the athlete has no race time or VDOT on file yet." : ""}${injuryNotes ? `\n\nINJURY/PHYSICAL LIMITATIONS: ${injuryNotes}. Avoid exercises that could aggravate this. If you suggest lower-impact alternatives (cycling, pool running), make clear in the notes that these REPLACE a run session for that day — not supplement it.` : ""}${otherNotes ? `\n\nATHLETE PREFERENCES: ${otherNotes}. Incorporate these into key_workout and notes where appropriate — spread across multiple weeks (e.g. if hill repeats requested, designate 2-3 build/peak weeks with hill repeats as key_workout; if cycling requested, mention optional bike sessions in notes for rest/recovery days, not as the key_workout).` : ""}${wantsSpeedWork ? "\n\n⚠️ SPEED WORK PRIORITY: This athlete explicitly requested speed work. Include a dedicated quality session (intervals, tempo, strides, or fartlek) as key_workout starting from week 1. Do NOT delay speed work to week 7+ — introduce it immediately and increase intensity as the plan progresses." : ""}\n\nWeeks:\n${arcSummary}`,
      }],
    });

    const enrichText = enrichResponse.content[0].type === "text" ? enrichResponse.content[0].text.trim() : "[]";
    const enriched = JSON.parse(enrichText.match(/\[[\s\S]*\]/)?.[0] || "[]") as Array<{ week_number: number; key_workout: string; key_workout_2?: string | null; notes: string; cross_training?: string | null }>;
    for (const e of enriched) {
      const w = planWeeks.find(x => x.week_number === e.week_number);
      if (w) {
        w.key_workout = fixKeyWorkoutMath(e.key_workout ?? "", unitLabel);
        w.key_workout_2 = e.key_workout_2 ? fixKeyWorkoutMath(e.key_workout_2, unitLabel) : null;
        w.notes = e.notes ?? "";
        if (crosstrainingTools.length > 0) {
          // Use Haiku's cross_training if provided, otherwise fall back to the same
          // deterministic modality selection the weekly skeletons use — a short label
          // (e.g. "Bike"), not the full CROSS_TRAINING_WORKOUTS session text, to match this
          // field's existing one-line-per-week dashboard contract.
          const fallbackModality = safeModalitiesFor(null, crosstrainingTools)[0];
          w.cross_training = e.cross_training?.trim() || (fallbackModality ? MODALITY_DISPLAY_NAMES[fallbackModality] : null) || null;
        }
      }
    }
  } catch (err) {
    console.error("[generateAndSaveFullPlan] Haiku enrichment failed (non-fatal):", err);
  }

  // Post-process: if Haiku echoed the long run as key_workout (e.g. "Long run 1.5mi"),
  // returned an empty string, or produced a pure easy-run label with no quality component
  // (e.g. "Easy 6km"), substitute a strides session. The dashboard already shows the long
  // run separately; a pure easy key_workout leaves the athlete with no form/quality
  // stimulus. Strides are appropriate from week 1 and fix both issues.
  const isLongRunEcho = (s: string) => /^\s*long\s*run\b/i.test(s);
  // Matches "Easy 5km", "Easy run", "Easy 4mi easy", "easy aerobic miles", etc. — a label
  // that contains nothing beyond easy distance/effort with no quality marker.
  const isPureEasyLabel = (s: string) =>
    /^\s*easy\b[^+×x()\n]*(run|miles?|km|kilometers?|aerobic\s+miles?)?\s*$/i.test(s);
  for (const w of planWeeks) {
    if (!w.key_workout || !w.key_workout.trim() || isLongRunEcho(w.key_workout) || isPureEasyLabel(w.key_workout)) {
      w.key_workout = `Easy ${miToDisplay(2)}${unitLabel} + 4×20sec strides`;
    }
  }

  // Save the plan.
  // On a rebuild (resetToWeek1=false), UPDATE the existing row so that created_at is
  // preserved — the dashboard uses created_at to anchor week boundaries, and inserting
  // a new row on every rebuild shifts those boundaries, misattributing past activities
  // to the wrong week number.
  if (!resetToWeek1) {
    const { data: existingPlan } = await supabase
      .from("training_plans")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (existingPlan) {
      await supabase.from("training_plans").update({
        race_date: raceDate,
        goal,
        total_weeks: totalWeeks,
        weeks: planWeeks as unknown as Json,
        updated_at: new Date().toISOString(),
      }).eq("id", (existingPlan as { id: string }).id);
    } else {
      await supabase.from("training_plans").insert({
        user_id: userId,
        race_date: raceDate,
        goal,
        total_weeks: totalWeeks,
        weeks: planWeeks as unknown as Json,
      });
    }
  } else {
    await supabase.from("training_plans").insert({
      user_id: userId,
      race_date: raceDate,
      goal,
      total_weeks: totalWeeks,
      weeks: planWeeks as unknown as Json,
    });
  }

  // Sync training_state: reset week counter if this is a new plan; sync mileage target.
  // When resetToWeek1 is true (new plan, new race, onboarding): reset everything —
  // week counter, mileage target, and session list.
  // When resetToWeek1 is false, week1Reset is false (normal mid-plan rebuild — tweaking workouts):
  // leave weekly_mileage_target and weekly_plan_sessions alone. The current week is
  // already in progress; overwriting these would change this week's target mid-week
  // and wipe Dean's carefully scheduled sessions. The arc mileage is already anchored
  // by the caller passing prescribedWeek1Miles = existingTarget.
  // When resetToWeek1 is false, week1Reset is true (week-1 rebuild — first week plan changed):
  // update the mileage target and replace sessions, but keep any past sessions (already
  // completed/missed before today) so historical context isn't lost.
  const week1ArcMileage = planWeeks[0]?.mileage_target ?? null;
  const week1MileageTarget = prescribedWeek1Miles ?? week1ArcMileage;
  const week1Strength = computeWeeklyStrength(profile);
  // Use upsert so a missing training_state row (e.g. completeOnboarding didn't run cleanly)
  // gets created instead of silently no-oping. Without this, the dashboard shows no weekly
  // target / long run / quality.
  if (resetToWeek1) {
    await supabase.from("training_state").upsert({
      user_id: userId,
      current_week: 1,
      ...(week1MileageTarget != null ? { weekly_mileage_target: week1MileageTarget } : {}),
      weekly_plan_sessions: null,
      weekly_long_run_miles: planWeeks[0]?.long_run_target ?? null,
      weekly_quality_session: planWeeks[0]?.key_workout || null,
      weekly_strength_day: week1Strength.day,
      weekly_strength_routine_key: week1Strength.routineKey,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  } else if (week1Reset) {
    // Week-1 mid-plan rebuild: update mileage target + clear future sessions (preserve past).
    await supabase.from("training_state").upsert({
      user_id: userId,
      ...(week1MileageTarget != null ? { weekly_mileage_target: week1MileageTarget } : {}),
      weekly_plan_sessions: (preservedSessions ?? null) as unknown as Json,
      weekly_long_run_miles: planWeeks[0]?.long_run_target ?? null,
      weekly_quality_session: planWeeks[0]?.key_workout || null,
      weekly_strength_day: week1Strength.day,
      weekly_strength_routine_key: week1Strength.routineKey,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  }

  // Reuse the existing dashboard token so old links remain valid.
  // Only generate a new UUID (and stamp trial_started_at) if the user has never had one.
  const { data: existingUserData } = await supabase.from("users")
    .select("dashboard_token")
    .eq("id", userId)
    .single();
  const existingToken = (existingUserData as { dashboard_token: string | null } | null)?.dashboard_token ?? null;
  const dashboardToken = existingToken ?? crypto.randomUUID();
  const isNewToken = !existingToken;
  await supabase.from("users").update({
    dashboard_token: dashboardToken,
    ...(isNewToken ? { trial_started_at: new Date().toISOString() } : {}),
  }).eq("id", userId);

  // Send the rebuilt plan as a TEXT ARTIFACT. The plan lives in the conversation, not on a
  // dashboard — athletes who text "UPDATE PLAN" expect to actually SEE the new plan, not a
  // promise or a link. Skip on silent rebuilds (planReadyNote undefined). Show the current
  // week in full plus a compact arc so they have something concrete in hand immediately.
  if (planReadyNote && phoneNumber) {
    try {
      const { data: stateRow } = await supabase
        .from("training_state")
        .select("current_week")
        .eq("user_id", userId)
        .single();
      const currentWeekNum = resetToWeek1 ? 1 : ((stateRow?.current_week as number | null) ?? 1);
      const thisWeek = planWeeks.find(w => w.week_number === currentWeekNum) ?? planWeeks[0];
      const peak = planWeeks.reduce((mx, w) => (w.mileage_target > (mx?.mileage_target ?? 0) ? w : mx), planWeeks[0]);

      const fmtMi = (mi: number | null | undefined) => mi == null ? "—" : `${miToDisplay(mi)}${unitLabel}`;
      const lines: string[] = [planReadyNote];
      if (thisWeek) {
        lines.push(
          `\nThis week — Week ${thisWeek.week_number} of ${totalWeeks} (${thisWeek.phase}): ~${fmtMi(thisWeek.mileage_target)} total, long run ~${fmtMi(thisWeek.long_run_target)}.${thisWeek.key_workout ? ` Key session: ${thisWeek.key_workout}.` : ""}`
        );
      }
      // Compact forward arc: the next few weeks plus where it peaks.
      const upcoming = planWeeks.filter(w => w.week_number > currentWeekNum).slice(0, 3);
      if (upcoming.length) {
        const arc = upcoming.map(w => `W${w.week_number} ~${fmtMi(w.mileage_target)}`).join(", ");
        const peakNote = peak && peak.week_number !== currentWeekNum
          ? ` Peak is ~${fmtMi(peak.mileage_target)} around week ${peak.week_number}.`
          : "";
        lines.push(`\nFrom here: ${arc}.${peakNote} Ask me about any week and I'll break it down.`);
      }
      await sendSMS(phoneNumber, lines.join("\n"));

      // Log the artifact so dedup/recap logic sees the plan was actually delivered.
      await insertConversation({
        user_id: userId,
        role: "assistant",
        content: lines.join("\n"),
        message_type: "initial_plan_link",
      });
    } catch (smsErr) {
      console.error("[generateAndSaveFullPlan] plan-ready SMS failed (non-fatal):", smsErr);
    }
  }

  return dashboardToken;
}

/**
 * Sync the simplified weekly plan fields (long_run_miles, quality_session) from the
 * stored training arc for a given week number.
 *
 * Called at the end of weekly_recap so the next week's targets are live in
 * training_state before the next morning_plan or reminder fires.
 */
// ─── Uploaded plan session utilities ─────────────────────────────────────────

export interface UploadedPlanSession {
  day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  label: string;
}

/**
 * Shared shape for entries stored in training_state.weekly_plan_sessions.
 * `type`/`routine_key` are optional so existing run-only sessions (and any code
 * reading the old `{day,date,label,optional?}` shape) keep working untouched.
 */
export interface PlanSession {
  day: string;
  date: string;
  label: string;
  optional?: boolean;
  /** Session kind. Absent/undefined means "run" for backwards compatibility. */
  type?: "run" | "strength" | "cross_train";
  /** For type: "strength" — the strength-library.ts routine key to look up exercises from. */
  routine_key?: string;
}

const WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const WEEK_DAY_ABBREV = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Deterministically compute this week's strength scheduling — day + routine — for every
 * athlete, every week. Intentionally NOT derived from Claude free text: day-level session
 * tracking was previously removed because LLM-extracted day assignments were unreliable
 * (see 2026-04-16 changelog). Both inputs here are already structured, reliable columns:
 *   - day: the first day of the week the athlete has no run scheduled (complement of
 *     training_profiles.training_days). Null if the athlete trains all 7 days — there's no
 *     day off to place a dedicated session on, so no day is scheduled that week.
 *   - routine_key: re-evaluated fresh each week from current injury_notes/injury_body_part
 *     via composeStrengthRoutine(), falling back to the universal hip_core base when there's
 *     no injury signal — every athlete gets a scheduled strength day regardless of injury status.
 */
export function computeWeeklyStrength(profile: Record<string, unknown> | null): {
  day: string | null;
  routineKey: string | null;
} {
  const trainingDays = new Set(
    ((profile?.training_days as string[] | null) ?? []).map(d => d.toLowerCase().trim())
  );
  const dayIndex = WEEK_DAYS.findIndex(d => !trainingDays.has(d));
  const day = dayIndex === -1 ? null : WEEK_DAY_ABBREV[dayIndex];

  const composed = composeStrengthRoutine({
    bodyParts: [
      profile?.injury_body_part as string | null,
      ...(((profile?.injury_body_parts as string[] | null) ?? [])),
    ],
    injuryText: (profile?.injury_notes as string | null) ?? null,
  });
  const routineKey = composed?.routine_key ?? "hip_core";

  return { day, routineKey };
}

export interface UploadedPlanWeek {
  week_number: number;
  sessions: UploadedPlanSession[];
}

/**
 * Given a week's sessions (day-of-week + label) and the Monday date of that week,
 * compute absolute M/D dates for each session so they can be stored in
 * training_state.weekly_plan_sessions and shown in morning_plan.
 */
export function computeWeekSessions(
  allWeeks: UploadedPlanWeek[],
  weekNumber: number,
  timezone: string
): Array<{ day: string; date: string; label: string }> {
  const week = allWeeks.find(w => w.week_number === weekNumber);
  if (!week) return [];

  const dayOffset: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  // Find this week's Monday in the user's timezone.
  const tz = timezone || "America/New_York";
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const [ty, tm, td] = localStr.split("-").map(Number);
  const todayDow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay(); // 0=Sun
  const daysFromMonday = todayDow === 0 ? 6 : todayDow - 1;
  const mondayUTC = new Date(Date.UTC(ty, tm - 1, td - daysFromMonday));

  return week.sessions
    .filter(s => s.day in dayOffset)
    .map(s => {
      const offset = dayOffset[s.day]!;
      const d = new Date(Date.UTC(
        mondayUTC.getUTCFullYear(),
        mondayUTC.getUTCMonth(),
        mondayUTC.getUTCDate() + offset
      ));
      return {
        day: s.day,
        date: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
        label: s.label,
      };
    });
}

const ORDERED_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface ArcWeekSlot {
  day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  date: string; // "M/D"
  type: "long_run" | "quality" | "easy" | "rest" | "strength" | "cross_train";
  distanceMiles: number | null;
  /** Full key_workout text (with WU/CD breakdown) — set only on quality slots. */
  keyWorkoutText?: string;
  /** Canonical modality key (e.g. "bike", "swimming") — cross_train slots only. */
  modality?: string;
}

/**
 * Parse the leading distance out of a key_workout string like
 * "Tempo 3.5mi (1mi WU + 1.5mi @ threshold + 1mi CD)" — reuses the same prefix
 * shape fixKeyWorkoutMath already validates, since Dean's arc-generated
 * key_workout text always carries this format.
 */
function parseLeadingDistanceMiles(text: string): number | null {
  const prefixRe = /^(.+?)\s+(\d+(?:\.\d+)?)mi\b/;
  const m = prefixRe.exec(text.trim());
  if (m) return parseFloat(m[2]);
  const loose = /(\d+(?:\.\d+)?)\s*mi\b/.exec(text);
  return loose ? parseFloat(loose[1]) : null;
}

/**
 * Deterministically compute a full week's session skeleton (day, date, type,
 * distance) for an arc-generated week — the same "compute it in code, don't
 * trust LLM free text" pattern as computeWeeklyStrength/computeWeekSessions
 * above, extended to arc-generated plans (which previously had no day/date
 * assignment logic at all; Claude free-handed both in weekly_recap prose).
 *
 * Distance/day/date here are treated as ground truth — an LLM only supplies
 * descriptive content (pace, purpose, terrain cues) for the slots this
 * function has already placed.
 */
/**
 * Deterministically resolve the ordered list of canonical cross-training modality keys to
 * rotate an athlete through — shared by computeArcWeekSkeleton (non-injured, supplementary),
 * computeRecoveryWeekSkeleton (injured, full weekly takeover), and generateAndSaveFullPlan's
 * fallback cross-training label. One source of truth so an injured athlete's safe-modality
 * list and a healthy athlete's tool-based list can't drift into different logic.
 *
 * bodyPart set (injury context): starts from CROSS_TRAINING_ALTERNATIVES[bodyPart] (excluding
 * "Avoid ..." entries), falling back to DEFAULT_SAFE_MODALITIES for an unlisted body part —
 * an injured athlete always gets something concrete, even with zero tools on file.
 * bodyPart null (non-injured): modalities come only from crosstrainingTools — no tools means
 * no cross-training slot gets placed at all (matches the prior prescribeCrossTrainingForPhase
 * behavior for healthy athletes).
 */
function safeModalitiesFor(bodyPart: string | null, crosstrainingTools: string[]): string[] {
  const toKey = (text: string) => MODALITY_PATTERNS.find(([re]) => re.test(text.toLowerCase()))?.[1];

  let candidates: string[] = [];
  if (bodyPart) {
    const alternatives = CROSS_TRAINING_ALTERNATIVES[bodyPart];
    const safeText = alternatives
      ? alternatives.filter(o => !o.toLowerCase().startsWith("avoid"))
      : null;
    const mapped = safeText ? safeText.map(toKey).filter((k): k is string => !!k) : [];
    candidates = mapped.length > 0 ? Array.from(new Set(mapped)) : DEFAULT_SAFE_MODALITIES;
  }

  if (crosstrainingTools.length > 0) {
    const toolKeys = Array.from(new Set(crosstrainingTools.map(toKey).filter((k): k is string => !!k)));
    if (candidates.length > 0) {
      // Injury context: prioritize tool matches within the safe list, keep other safe options too.
      const matched = candidates.filter(k => toolKeys.includes(k));
      const rest = candidates.filter(k => !toolKeys.includes(k));
      return [...matched, ...rest];
    }
    // No injury: use exactly the athlete's tools.
    return toolKeys;
  }

  // No tools specified: injured athletes still get the safe list; healthy athletes get none.
  return candidates;
}

/** Round-robin assign modalities across the given days. Empty modalities -> no slots. */
function assignCrossTrainSlots(days: string[], modalities: string[]): Array<{ day: string; modality: string }> {
  if (modalities.length === 0) return [];
  return days.map((day, i) => ({ day, modality: modalities[i % modalities.length]! }));
}

export function computeArcWeekSkeleton(params: {
  trainingDays: string[]; // lowercase day names, training_profiles.training_days
  weeklyTotalMiles: number; // pre-clamped by the caller
  longRunMiles: number;
  keyWorkoutText: string | null;
  keyWorkoutText2?: string | null;
  strengthDay: string | null; // "Mon".."Sun", from computeWeeklyStrength()
  crosstrainingTools?: string[]; // training_profiles.crosstraining_tools — up to 2 supplementary cross-train slots on rest days
  timezone: string;
}): ArcWeekSlot[] {
  const { trainingDays, weeklyTotalMiles, longRunMiles, keyWorkoutText, keyWorkoutText2, strengthDay, crosstrainingTools = [], timezone } = params;

  const dayOffset: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const tz = timezone || "America/New_York";
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const [ty, tm, td] = localStr.split("-").map(Number);
  const todayDow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay(); // 0=Sun
  const daysFromMonday = todayDow === 0 ? 6 : todayDow - 1;
  const mondayUTC = new Date(Date.UTC(ty, tm - 1, td - daysFromMonday));
  const dateFor = (abbrev: string) => {
    const offset = dayOffset[abbrev]!;
    const d = new Date(Date.UTC(
      mondayUTC.getUTCFullYear(),
      mondayUTC.getUTCMonth(),
      mondayUTC.getUTCDate() + offset
    ));
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };

  const normalizedTrainingDays = new Set(trainingDays.map(d => d.toLowerCase().trim()));
  const trainDayAbbrevs = WEEK_DAYS
    .map((full, i) => (normalizedTrainingDays.has(full) ? WEEK_DAY_ABBREV[i] : null))
    .filter((d): d is string => d !== null);

  if (trainDayAbbrevs.length === 0) return [];

  const dayDistance = (a: string, b: string) => {
    const ia = ORDERED_DAYS.indexOf(a as typeof ORDERED_DAYS[number]);
    const ib = ORDERED_DAYS.indexOf(b as typeof ORDERED_DAYS[number]);
    return Math.min(Math.abs(ia - ib), 7 - Math.abs(ia - ib));
  };

  // Long-run day: prefer Sun, then Sat, else the chronologically-last training day.
  const longRunDay = trainDayAbbrevs.includes("Sun")
    ? "Sun"
    : trainDayAbbrevs.includes("Sat")
    ? "Sat"
    : trainDayAbbrevs[trainDayAbbrevs.length - 1]!;

  // Quality day(s): training days that aren't the long-run day, preferring ones
  // not immediately adjacent to it.
  const candidateQualityDays = trainDayAbbrevs.filter(d => d !== longRunDay);
  const nonAdjacent = candidateQualityDays.filter(d => dayDistance(d, longRunDay) > 1);
  const qualityDay = nonAdjacent[0] ?? candidateQualityDays[0] ?? null;

  let qualityDay2: string | null = null;
  if (keyWorkoutText2 && qualityDay) {
    const remaining = candidateQualityDays.filter(d => d !== qualityDay);
    const remainingNonAdjacent = remaining.filter(d => dayDistance(d, longRunDay) > 1);
    qualityDay2 = remainingNonAdjacent[0] ?? remaining[0] ?? null;
    if (!qualityDay2) {
      console.warn("[computeArcWeekSkeleton] no room for a second quality session this week — dropping key_workout_2");
    }
  }

  // Ultra plans use a "back-to-back long run weekend" key_workout format that names its own
  // days directly (e.g. "Sat 14mi trail + Sun 10mi easy (back-to-back long run weekend)" —
  // see the ultraGuidance enrichment prompt above). That text is NOT a normal midweek quality
  // session — placing it on this function's own computed quality day (e.g. Tuesday) produces
  // a nonsensical slot whose own text names different days than the one it's attached to.
  // Exclude it from deterministic quality-slot placement entirely; its mileage flows into the
  // leftover pool and gets distributed across easy days instead. Dean's own prose (which reads
  // key_workout directly, not through this skeleton) still describes the back-to-back weekend.
  const isBackToBackText = (text: string) => /back-to-back/i.test(text);
  const keyWorkoutUsable = !!keyWorkoutText && !isBackToBackText(keyWorkoutText);
  const keyWorkoutText2Usable = !!keyWorkoutText2 && !isBackToBackText(keyWorkoutText2);
  if (keyWorkoutText && !keyWorkoutUsable) {
    console.warn(`[computeArcWeekSkeleton] key_workout is a back-to-back long run weekend — excluding from quality-slot placement: "${keyWorkoutText}"`);
  }

  const qualityDistance = keyWorkoutUsable ? parseLeadingDistanceMiles(keyWorkoutText!) : null;
  const qualityDistance2 = keyWorkoutText2Usable ? parseLeadingDistanceMiles(keyWorkoutText2!) : null;
  if (keyWorkoutUsable && qualityDistance == null) {
    console.warn(`[computeArcWeekSkeleton] could not parse a distance from key_workout: "${keyWorkoutText}"`);
  }

  const slots: ArcWeekSlot[] = [];
  const usedDays = new Set<string>();

  slots.push({ day: longRunDay as ArcWeekSlot["day"], date: dateFor(longRunDay), type: "long_run", distanceMiles: longRunMiles });
  usedDays.add(longRunDay);

  if (qualityDay && keyWorkoutUsable) {
    slots.push({ day: qualityDay as ArcWeekSlot["day"], date: dateFor(qualityDay), type: "quality", distanceMiles: qualityDistance, keyWorkoutText: keyWorkoutText! });
    usedDays.add(qualityDay);
  }
  if (qualityDay2 && keyWorkoutText2Usable) {
    slots.push({ day: qualityDay2 as ArcWeekSlot["day"], date: dateFor(qualityDay2), type: "quality", distanceMiles: qualityDistance2, keyWorkoutText: keyWorkoutText2! });
    usedDays.add(qualityDay2);
  }

  // Remaining training days -> easy, splitting leftover mileage evenly (rounded to
  // the nearest 0.5, with the exact remainder absorbed into the last easy slot).
  const easyDays = trainDayAbbrevs.filter(d => !usedDays.has(d));
  const qualityTotal = (qualityDistance ?? 0) + (qualityDistance2 ?? 0);
  const leftover = Math.max(0, weeklyTotalMiles - longRunMiles - qualityTotal);
  if (easyDays.length > 0) {
    const base = Math.floor((leftover / easyDays.length) * 2) / 2;
    let assigned = 0;
    easyDays.forEach((d, i) => {
      const isLast = i === easyDays.length - 1;
      const dist = isLast ? Math.round((leftover - assigned) * 10) / 10 : base;
      assigned += dist;
      slots.push({ day: d as ArcWeekSlot["day"], date: dateFor(d), type: "easy", distanceMiles: Math.max(0, dist) });
    });
  }

  // Non-training, non-strength days -> up to 2 supplementary cross-train slots (when the
  // athlete has tools on file), remainder -> rest.
  const restCandidates = ORDERED_DAYS.filter(d => !trainDayAbbrevs.includes(d) && d !== strengthDay);
  const ctModalities = safeModalitiesFor(null, crosstrainingTools);
  const ctDays = restCandidates.slice(0, 2);
  const ctAssignments = assignCrossTrainSlots(ctDays, ctModalities);
  const ctByDay = new Map(ctAssignments.map(a => [a.day, a.modality]));

  ORDERED_DAYS.forEach(d => {
    if (trainDayAbbrevs.includes(d)) return;
    const modality = ctByDay.get(d);
    slots.push({
      day: d,
      date: dateFor(d),
      type: strengthDay === d ? "strength" : modality ? "cross_train" : "rest",
      distanceMiles: null,
      ...(modality ? { modality } : {}),
    });
  });

  return slots.sort((a, b) => ORDERED_DAYS.indexOf(a.day) - ORDERED_DAYS.indexOf(b.day));
}

/**
 * Read plan_sessions_all_weeks from the user's onboarding_data, compute absolute
 * dates for the given week number, and write to training_state.weekly_plan_sessions.
 * Called at upload time (week 1) and on each Sunday recap to advance to the next week.
 */
export async function syncWeekFromUploadedPlan(
  userId: string,
  weekNumber: number,
  timezone: string
): Promise<void> {
  const { data: user } = await supabase
    .from("users")
    .select("onboarding_data")
    .eq("id", userId)
    .single();

  if (!user) return;

  const allWeeks = ((user.onboarding_data as Record<string, unknown> | null)
    ?.plan_sessions_all_weeks as UploadedPlanWeek[] | null) ?? [];

  if (!allWeeks.length) return;

  const sessions = computeWeekSessions(allWeeks, weekNumber, timezone);
  if (!sessions.length) {
    console.log(`[syncWeekFromUploadedPlan] no sessions found for week ${weekNumber} (plan has ${allWeeks.length} weeks)`);
    return;
  }

  await supabase
    .from("training_state")
    .update({ weekly_plan_sessions: sessions as unknown as Json, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  console.log(`[syncWeekFromUploadedPlan] wrote ${sessions.length} sessions for week ${weekNumber} to training_state`);
}

export async function syncWeekFromArc(userId: string, weekNum: number, timezone = "America/New_York"): Promise<void> {
  const { data: plan } = await supabase
    .from("training_plans")
    .select("weeks, plan_source")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!plan?.weeks || !Array.isArray(plan.weeks)) return;

  const { data: profile } = await supabase
    .from("training_profiles")
    .select("training_days, injury_notes, injury_body_part, injury_body_parts, preferred_units, crosstraining_tools")
    .eq("user_id", userId)
    .single();
  const strength = computeWeeklyStrength(profile as Record<string, unknown> | null);
  const isMetric = (profile?.preferred_units as string | null) === "metric";
  const crosstrainingTools = (profile?.crosstraining_tools as string[] | null)?.filter(Boolean) ?? [];

  type UploadedSession = { type: string; description: string; targetDistanceMiles?: number | null };
  type UploadedWeek = { week_number: number; sessions: UploadedSession[]; total_miles: number };
  type DeanWeek = { week_number: number; long_run_target: number; key_workout: string; key_workout_2?: string | null; mileage_target?: number };

  if (plan.plan_source === "uploaded") {
    const weeks = plan.weeks as UploadedWeek[];
    const week = weeks.find(w => w.week_number === weekNum);
    if (!week) return;
    const longRun = week.sessions.find(s => s.type === "long");
    const quality = week.sessions.find(s => s.type === "tempo" || s.type === "interval");
    const qualitySessions = week.sessions
      .filter(s => s.type === "tempo" || s.type === "interval")
      .map(s => s.description)
      .join("; ") || null;
    await supabase.from("training_state").update({
      weekly_long_run_miles: longRun?.targetDistanceMiles ?? null,
      weekly_quality_session: qualitySessions,
      weekly_mileage_target: week.total_miles || null,
      weekly_strength_day: strength.day,
      weekly_strength_routine_key: strength.routineKey,
    }).eq("user_id", userId);
  } else {
    const weeks = plan.weeks as DeanWeek[];
    const week = weeks.find(w => w.week_number === weekNum);
    if (!week) return;
    // Recompute the same deterministic skeleton weekly_recap builds at response time
    // (see computeArcWeekSkeleton above) rather than threading Claude's slot_annotations
    // through — everything it needs is derivable from DB state, so this stays correct
    // even when called from a path other than the weekly_recap response (e.g. after a
    // plan patch in user_message, see the syncWeekFromArc call sites in route.ts).
    const trainingDays = (profile?.training_days as string[] | null) ?? [];
    const skeleton = computeArcWeekSkeleton({
      trainingDays,
      weeklyTotalMiles: week.mileage_target ?? 0,
      longRunMiles: week.long_run_target ?? 0,
      keyWorkoutText: week.key_workout || null,
      keyWorkoutText2: week.key_workout_2 ?? null,
      strengthDay: strength.day,
      crosstrainingTools,
      timezone,
    });
    const planSessions: PlanSession[] = skeleton
      .filter(s => s.type !== "rest")
      .map(s => ({
        day: s.day,
        date: s.date,
        label: arcWeekSlotLabel(s, isMetric),
        type: s.type === "long_run" || s.type === "quality" || s.type === "easy"
          ? "run"
          : s.type === "cross_train" ? "cross_train" : "strength",
        routine_key: s.type === "strength" ? (strength.routineKey ?? undefined) : undefined,
      }));
    await supabase.from("training_state").update({
      weekly_long_run_miles: week.long_run_target ?? null,
      weekly_quality_session: week.key_workout || null,
      weekly_mileage_target: week.mileage_target || null,
      weekly_strength_day: strength.day,
      weekly_strength_routine_key: strength.routineKey,
      ...(planSessions.length > 0 ? { weekly_plan_sessions: planSessions as unknown as Json } : {}),
    }).eq("user_id", userId);
  }
}

/**
 * Render an arc week slot's session label — shared by syncWeekFromArc (persisted to
 * training_state.weekly_plan_sessions) and formatWeeklyPlanDigest (the athlete-facing SMS
 * bubble), so the two never drift into describing the same slot differently.
 * `isMetric` mirrors route.ts's recapMi() conversion (miles * 1.60934, 1 decimal, "km") so
 * this label matches the units Dean's own weekly_recap prose uses for the same athlete —
 * distanceMiles is always stored in miles internally regardless of preferred_units.
 * keyWorkoutText (quality sessions) is left as-is: it's baked in the athlete's preferred
 * units at plan-generation time already, same assumption Dean's own prompt makes.
 */
function arcWeekSlotLabel(slot: ArcWeekSlot, isMetric = false): string {
  const fmtDist = (miles: number) => isMetric ? `${(miles * 1.60934).toFixed(1)}km` : `${miles}mi`;
  return slot.type === "long_run"
    ? `Long run ${fmtDist(slot.distanceMiles ?? 0)}`
    : slot.type === "quality"
    ? (slot.keyWorkoutText ?? `Quality ${fmtDist(slot.distanceMiles ?? 0)}`)
    : slot.type === "easy"
    ? `Easy ${fmtDist(slot.distanceMiles ?? 0)}`
    : slot.type === "cross_train"
    ? (MODALITY_DISPLAY_NAMES[slot.modality ?? ""] ?? "Cross-training")
    : "Strength + mobility";
}

/**
 * Deterministically format an arc week skeleton into a plain-text SMS bubble — no LLM
 * call. This is pure string templating over the same fixed skeleton Claude was constrained
 * to during weekly_recap (see computeArcWeekSkeleton above and the "THIS WEEK'S SCHEDULE IS
 * ALREADY DECIDED" prompt block in route.ts), which deliberately keeps Claude's own prose
 * free of a day-by-day list. The prior day-level weekly plan feature was removed on
 * 2026-04-16 because Claude free-handed these numbers in prose; this can't drift because no
 * model call produces it. `slotAnnotations` (pace/why), when present, come from Claude's
 * already schema-validated skeleton_annotations tool call — merged in as flavor text only.
 */
export function formatWeeklyPlanDigest(
  skeleton: ArcWeekSlot[],
  slotAnnotations?: Array<{ day: string; pace?: string; why?: string }> | null,
  isMetric = false
): string {
  const annotationByDay = new Map((slotAnnotations ?? []).map(a => [a.day, a]));
  const lines = skeleton
    .filter(s => s.type !== "rest")
    .map(s => {
      const annotation = annotationByDay.get(s.day);
      const pace = annotation?.pace ? ` (${annotation.pace})` : "";
      return `${s.day} ${s.date} — ${arcWeekSlotLabel(s, isMetric)}${pace}`;
    });
  return `This week's plan:\n${lines.join("\n")}`;
}

export interface RecoveryWeekSlot {
  day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  date: string; // "M/D"
  type: "cross_train" | "strength" | "rest";
  modality?: string; // canonical key, cross_train slots only
}

/**
 * Deterministically compute a full week's cross-training/strength skeleton for an athlete
 * on an injury hold — the same "compute it in code, don't trust LLM free text" pattern as
 * computeArcWeekSkeleton, extended to recovery weeks (which previously had no day/modality
 * placement logic at all; Claude free-handed both via the injuryHoldInstruction prompt
 * block). Day/modality here are ground truth — an LLM only supplies purpose/pain-threshold
 * framing and judges whether a test-run probe fits this week.
 */
export function computeRecoveryWeekSkeleton(params: {
  trainingDays: string[]; // lowercase day names, training_profiles.training_days
  crosstrainingDays?: string[] | null; // lowercase day names, training_profiles.crosstraining_days override
  crosstrainingTools: string[];
  bodyPart: string | null; // training_profiles.injury_body_part
  strengthDay: string | null; // "Mon".."Sun", from computeWeeklyStrength()
  timezone: string;
}): RecoveryWeekSlot[] {
  const { trainingDays, crosstrainingDays, crosstrainingTools, bodyPart, strengthDay, timezone } = params;

  const dayOffset: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const tz = timezone || "America/New_York";
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const [ty, tm, td] = localStr.split("-").map(Number);
  const todayDow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay(); // 0=Sun
  const daysFromMonday = todayDow === 0 ? 6 : todayDow - 1;
  const mondayUTC = new Date(Date.UTC(ty, tm - 1, td - daysFromMonday));
  const dateFor = (abbrev: string) => {
    const offset = dayOffset[abbrev]!;
    const d = new Date(Date.UTC(
      mondayUTC.getUTCFullYear(),
      mondayUTC.getUTCMonth(),
      mondayUTC.getUTCDate() + offset
    ));
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };

  const abbrevsFromLowerDays = (days: string[]) => {
    const normalized = new Set(days.map(d => d.toLowerCase().trim()));
    return WEEK_DAYS
      .map((full, i) => (normalized.has(full) ? WEEK_DAY_ABBREV[i] : null))
      .filter((d): d is string => d !== null);
  };

  // CT days: explicit crosstraining_days override, else mirror the athlete's normal
  // training_days pattern, else a fixed default cadence so an athlete with no data on file
  // still gets a real week instead of an empty one.
  const ctDays = crosstrainingDays && crosstrainingDays.length > 0
    ? abbrevsFromLowerDays(crosstrainingDays)
    : trainingDays.length > 0
    ? abbrevsFromLowerDays(trainingDays)
    : ["Mon", "Wed", "Fri", "Sat"];

  const modalities = safeModalitiesFor(bodyPart, crosstrainingTools);
  const assignments = assignCrossTrainSlots(ctDays, modalities);
  const ctByDay = new Map(assignments.map(a => [a.day, a.modality]));

  const slots: RecoveryWeekSlot[] = ORDERED_DAYS.map(d => {
    const modality = ctByDay.get(d);
    return {
      day: d,
      date: dateFor(d),
      type: strengthDay === d ? "strength" : modality ? "cross_train" : "rest",
      ...(modality && strengthDay !== d ? { modality } : {}),
    };
  });

  return slots;
}

/**
 * Deterministically format a recovery week skeleton into a plain-text SMS bubble — no LLM
 * call, same reliability guarantee as formatWeeklyPlanDigest. No unit conversion needed:
 * there are no distances here, only modality names — durations/effort live in the fixed
 * CROSS_TRAINING_WORKOUTS text Claude references in its own prose, not in this compact list.
 */
export function formatRecoveryWeekDigest(skeleton: RecoveryWeekSlot[]): string {
  const lines = skeleton
    .filter(s => s.type !== "rest")
    .map(s => {
      const label = s.type === "strength" ? "Strength + mobility" : (MODALITY_DISPLAY_NAMES[s.modality ?? ""] ?? "Cross-training");
      return `${s.day} ${s.date} — ${label}`;
    });
  return `This week's recovery plan:\n${lines.join("\n")}`;
}
