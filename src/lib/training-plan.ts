import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS } from "@/lib/linq";
import type { Json } from "@/lib/database.types";

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

/**
 * Compute the full multi-week training arc and save it to training_plans.
 * Generates a dashboard_token and sets trial_started_at on the user record.
 *
 * @param skipLinkSms - When true, skips the "your plan is ready" SMS (used
 *   for backfill of existing users who already use the app).
 */
export async function generateAndSaveFullPlan(
  userId: string,
  phoneNumber: string,
  profile: Record<string, unknown> | null,
  avgWeeklyMileage: number | null,
  { skipLinkSms = false, prescribedWeek1Miles, bRaces, resetToWeek1 = true, week1Reset = false, preservedSessions, planReadyNote, wantsSpeedWork = false, otherNotes = null, anchorMonday }: {
    skipLinkSms?: boolean;
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

  // Compute a race-type-aware peak with both a floor (low-mileage runners still get
  // a plan sufficient for the target distance) and a hard cap (no 100+ mpw marathon
  // plans on 7-month arcs). The build factor is then derived dynamically so the arc
  // reaches targetPeak at exactly the right rate regardless of plan length.
  const targetPeak = getTargetPeakMileage(goal, baseMileage);

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

  const planWeeks: Array<{
    week_number: number;
    phase: string;
    mileage_target: number;
    long_run_target: number;
    key_workout: string;
    notes: string;
  }> = [];

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
- key_workout: the quality/speed session for that week (1 line). CRITICAL RULE: When a week includes BOTH a long run AND a quality session (tempo, intervals, strides, fartlek, hill repeats), set key_workout to the QUALITY session — NOT the long run. The long run is displayed separately in the dashboard. Only use the long run as key_workout for pure long-run-only weeks (recovery, low-volume deload). Examples: "6×800m @ 5K pace", "4${unitLabel} tempo @ threshold", "6×strides + easy 5${unitLabel}", "20min fartlek", "Race simulation 5${unitLabel} @ goal pace", "Hill repeats 6×90sec". Deload weeks: "Easy 30min + 4×strides" or similar. IMPORTANT: All distances in key_workout and notes must use ${unitLabel} (${useKm ? "kilometers" : "miles"}) — never mix units.

WARM-UP / COOL-DOWN RULE: Every interval or tempo key_workout MUST include a 1${unitLabel} warm-up and 1${unitLabel} cool-down. Format: "Intervals Xmi (1${unitLabel} WU + main set + 1${unitLabel} CD)". This applies to all quality sessions including time-based intervals (e.g. "4×3min") — the WU/CD are distance-based even when the main set is time-based. Example: "Intervals 3.5${unitLabel} (1${unitLabel} WU + 4×3min @ 5K effort + 1${unitLabel} CD)". Strides and fartleks are exempt (they fold into an easy run).

SESSION MATH RULE: The distance prefix MUST equal the SUM of all components. Wrong: "Tempo 2${unitLabel} (1${unitLabel} WU + 1.5${unitLabel} @ threshold + 1${unitLabel} CD)" — 1+1.5+1=3.5, not 2. Right: "Tempo 3.5${unitLabel} (1${unitLabel} WU + 1.5${unitLabel} @ threshold + 1${unitLabel} CD)". For time-based main sets where total distance is uncertain, omit the prefix: "Intervals (1${unitLabel} WU + 4×3min @ 5K effort + 1${unitLabel} CD)".

- notes: 2-3 sentences for the athlete to read on their dashboard. First sentence: the week's purpose and why it matters at this stage of training (e.g. "Week 6 is about building your aerobic base — consistent easy mileage here pays dividends in the peak phase."). Then 1-2 sentences on the key workout: what it is, the target effort or pace, and one brief execution tip (e.g. "The tempo run on Wednesday should feel comfortably hard — you should be able to speak in short phrases but not hold a conversation. Start controlled and aim to hold pace in the second half."). Deload weeks should acknowledge the pullback and why recovery is productive. Keep it direct and practical, not generic.

Return ONLY a valid JSON array:
[{"week_number": 1, "key_workout": "...", "notes": "..."}, ...]
No other text.`,
      messages: [{
        role: "user",
        content: `Goal: ${goal ?? "general running fitness"}\nRace date: ${raceDate ?? "none"}\nCurrent fitness: ~${baseMileageDisplay}/week${easyPace ? `, easy pace ${easyPace}` : ""}${tempoPace ? `, tempo pace ${tempoPace}` : ""}${intervalPace ? `, interval/5K pace ${intervalPace}` : ""}\nDays/week: ${daysPerWeek}\nPreferred units: ${unitLabel}\n\n${basePhaseGuidance}${ultraGuidance}${bRaceContext}${!easyPace && !tempoPace && !intervalPace ? "\n\nNO PACE DATA: This athlete has not yet established pace baselines. In key_workout and notes, use effort-based language only: 'easy effort', 'comfortably hard', 'hard/near-maximal effort'. Do NOT invent or estimate specific minute/mile or minute/km pace targets — the athlete has no race time or VDOT on file yet." : ""}${injuryNotes ? `\n\nINJURY/PHYSICAL LIMITATIONS: ${injuryNotes}. Avoid exercises that could aggravate this. If you suggest lower-impact alternatives (cycling, pool running), make clear in the notes that these REPLACE a run session for that day — not supplement it.` : ""}${otherNotes ? `\n\nATHLETE PREFERENCES: ${otherNotes}. Incorporate these into key_workout and notes where appropriate — spread across multiple weeks (e.g. if hill repeats requested, designate 2-3 build/peak weeks with hill repeats as key_workout; if cycling requested, mention optional bike sessions in notes for rest/recovery days, not as the key_workout).` : ""}${wantsSpeedWork ? "\n\n⚠️ SPEED WORK PRIORITY: This athlete explicitly requested speed work. Include a dedicated quality session (intervals, tempo, strides, or fartlek) as key_workout starting from week 1. Do NOT delay speed work to week 7+ — introduce it immediately and increase intensity as the plan progresses." : ""}\n\nWeeks:\n${arcSummary}`,
      }],
    });

    const enrichText = enrichResponse.content[0].type === "text" ? enrichResponse.content[0].text.trim() : "[]";
    const enriched = JSON.parse(enrichText.match(/\[[\s\S]*\]/)?.[0] || "[]") as Array<{ week_number: number; key_workout: string; notes: string }>;
    for (const e of enriched) {
      const w = planWeeks.find(x => x.week_number === e.week_number);
      if (w) {
        w.key_workout = fixKeyWorkoutMath(e.key_workout ?? "", unitLabel);
        w.notes = e.notes ?? "";
      }
    }
  } catch (err) {
    console.error("[generateAndSaveFullPlan] Haiku enrichment failed (non-fatal):", err);
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

  if (!skipLinkSms) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    const planUrl = `${appUrl}/dashboard?token=${dashboardToken}`;
    // For rebuilds, use the caller-supplied context note so the athlete knows exactly
    // what changed. For new plans (onboarding), use the standard welcome message.
    const smsBody = planReadyNote
      ? `Your updated plan is ready: ${planUrl}\n\n${planReadyNote}`
      : `Your full ${totalWeeks}-week training plan is ready: ${planUrl}\n\nI'll send you the specifics each week and keep this updated as your training progresses.`;
    try {
      await sendSMS(phoneNumber, smsBody);
    } catch (err) {
      console.error("[generateAndSaveFullPlan] dashboard link SMS failed (non-fatal):", err);
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
export async function syncWeekFromArc(userId: string, weekNum: number): Promise<void> {
  const { data: plan } = await supabase
    .from("training_plans")
    .select("weeks, plan_source")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!plan?.weeks || !Array.isArray(plan.weeks)) return;

  type UploadedSession = { type: string; description: string; targetDistanceMiles?: number | null };
  type UploadedWeek = { week_number: number; sessions: UploadedSession[]; total_miles: number };
  type DeanWeek = { week_number: number; long_run_target: number; key_workout: string };

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
    }).eq("user_id", userId);
  } else {
    const weeks = plan.weeks as DeanWeek[];
    const week = weeks.find(w => w.week_number === weekNum);
    if (!week) return;
    await supabase.from("training_state").update({
      weekly_long_run_miles: week.long_run_target ?? null,
      weekly_quality_session: week.key_workout || null,
    }).eq("user_id", userId);
  }
}
