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
  //   100K/mi   62+ mi     24 mi         ~57 mi        23.9 ✓  (65 gives headroom)

  if (g.includes("100k") || g.includes("100mi") || g.includes("100 m")) {
    hardCap = 110; floor = 65;
  } else if (g.includes("50mi") || g.includes("50 mi")) {
    hardCap = 100; floor = 55;
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
  } else {
    hardCap = 60; floor = 20;
  }
  // Allow up to 100% growth from base (doubles over a full training cycle),
  // but never outside [floor, hardCap]. Previous 1.5x cap was too conservative —
  // athletes routinely build from 15 to 30+ mi/week over a 14-week HM plan.
  return Math.max(Math.min(baseMileage * 2.0, hardCap), floor);
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
  { skipLinkSms = false, prescribedWeek1Miles, bRaces, resetToWeek1 = true, week1Reset = false, preservedSessions, planReadyNote, wantsSpeedWork = false, otherNotes = null }: {
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
  } = {},
): Promise<string> {
  const raceDate = (profile?.race_date as string | null) ?? null;
  const goal = (profile?.goal as string | null) ?? null;
  const easyPace = (profile?.current_easy_pace as string | null) ?? null;
  const tempoPace = (profile?.current_tempo_pace as string | null) ?? null;
  const intervalPace = (profile?.current_interval_pace as string | null) ?? null;
  const daysPerWeek = (profile?.days_per_week as number | null) ?? 4;
  const injuryNotes = (profile?.injury_notes as string | null) ?? null;
  const hasRace = !!raceDate;

  // Determine total weeks: anchor to the start of the current week (Monday) so the race
  // always falls within the last plan week rather than one week past it. Using "now" directly
  // is sensitive to the time of day — if the plan is generated after noon UTC, a race that's
  // exactly N weeks out can round down to N-1 weeks, leaving the race outside the plan.
  let totalWeeks = 12;
  const now = new Date();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  if (raceDate) {
    const race = new Date(raceDate + "T12:00:00Z");
    const weeksUntil = Math.ceil((race.getTime() - monday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    totalWeeks = Math.max(4, Math.min(52, weeksUntil));
  }

  // Extend plan to cover B/C races that fall after the A race but within 8 weeks of it.
  // This ensures a runner with e.g. Dipsea (A, June 14) + Snowbird (B, July 11) gets a
  // single continuous plan rather than a plan that ends at Dipsea and leaves Snowbird
  // unplanned. The arc phases naturally taper to the last race; intermediate races are
  // labeled via bRaceWeekLabels so Haiku can annotate them as tune-up efforts.
  console.log("[training-plan] generateAndSaveFullPlan: raceDate=", raceDate, "totalWeeks=", totalWeeks, "bRaces=", JSON.stringify(bRaces ?? []));
  if (bRaces?.length && raceDate) {
    const lastPostARace = bRaces
      .filter(r => r.race_date > raceDate)
      .sort((a, b) => a.race_date.localeCompare(b.race_date))
      .pop();
    if (lastPostARace) {
      const lastRaceMs = new Date(lastPostARace.race_date + "T12:00:00Z").getTime();
      const weeksToLast = Math.ceil((lastRaceMs - monday.getTime()) / (7 * 24 * 60 * 60 * 1000));
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
        Math.ceil((new Date(raceDate + "T12:00:00Z").getTime() - monday.getTime()) / (7 * 24 * 60 * 60 * 1000)),
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
  const baseMileage = prescribedWeek1Miles
    ? Math.max(5, prescribedWeek1Miles)
    : Math.max(5, Math.round((avgWeeklyMileage ?? noHistoryDefault) * 2) / 2);

  // Compute a race-type-aware peak with both a floor (low-mileage runners still get
  // a plan sufficient for the target distance) and a hard cap (no 100+ mpw marathon
  // plans on 7-month arcs). The build factor is then derived dynamically so the arc
  // reaches targetPeak at exactly the right rate regardless of plan length.
  const targetPeak = getTargetPeakMileage(goal, baseMileage);

  // Count real build weeks (non-deload, non-taper, after week 1) so we can derive
  // a build factor that reaches targetPeak smoothly by peak phase.
  let realBuildWeeks = 0;
  for (let w = 2; w <= totalWeeks; w++) {
    const ph = computePhaseForPlan(w, totalWeeks, hasRace);
    const isD = w % 4 === 0 && ph !== "taper" && ph !== "peak";
    if (!isD && ph !== "taper") realBuildWeeks++;
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
    const weekNum = Math.round((raceMs - monday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
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
  const ultraGuidance = isUltraEnrich ? `

ULTRA-SPECIFIC REQUIREMENTS (mandatory):
- Introduce back-to-back long run weekends (e.g. "Sat ${miToDisplay(18)}${unitLabel} + Sun ${miToDisplay(12)}${unitLabel} easy") no later than week ${Math.max(3, Math.round(totalWeeks * 0.25))} of ${totalWeeks}. This is the key ultra stimulus — do NOT delay it to the second half of the plan.
- Include trail-specific context from week 1: hiking steep uphills (power-hiking is faster than running them in a 50k/100k), running by time-on-feet rather than strict pace, and managing elevation.
- key_workout for back-to-back weekends should specify both Saturday and Sunday, e.g. "Sat ${miToDisplay(20)}${unitLabel} trail + Sun ${miToDisplay(14)}${unitLabel} easy (back-to-back)".
- Notes should reference the back-to-back adaptation, hiking uphills, and time-on-feet philosophy when applicable.` : "";

  try {
    const enrichResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: Math.min(8000, Math.max(2500, totalWeeks * 200)),
      system: `You are a running coach generating a structured training plan arc.
For each week provide:
- key_workout: the quality/speed session for that week (1 line). CRITICAL RULE: When a week includes BOTH a long run AND a quality session (tempo, intervals, strides, fartlek, hill repeats), set key_workout to the QUALITY session — NOT the long run. The long run is displayed separately in the dashboard. Only use the long run as key_workout for pure long-run-only weeks (recovery, low-volume deload). Examples: "6×800m @ 5K pace", "4${unitLabel} tempo @ threshold", "6×strides + easy 5${unitLabel}", "20min fartlek", "Race simulation 5${unitLabel} @ goal pace", "Hill repeats 6×90sec". Deload weeks: "Easy 30min + 4×strides" or similar. IMPORTANT: All distances in key_workout and notes must use ${unitLabel} (${useKm ? "kilometers" : "miles"}) — never mix units.
- notes: 2-3 sentences for the athlete to read on their dashboard. First sentence: the week's purpose and why it matters at this stage of training (e.g. "Week 6 is about building your aerobic base — consistent easy mileage here pays dividends in the peak phase."). Then 1-2 sentences on the key workout: what it is, the target effort or pace, and one brief execution tip (e.g. "The tempo run on Wednesday should feel comfortably hard — you should be able to speak in short phrases but not hold a conversation. Start controlled and aim to hold pace in the second half."). Deload weeks should acknowledge the pullback and why recovery is productive. Keep it direct and practical, not generic.

Return ONLY a valid JSON array:
[{"week_number": 1, "key_workout": "...", "notes": "..."}, ...]
No other text.`,
      messages: [{
        role: "user",
        content: `Goal: ${goal ?? "general running fitness"}\nRace date: ${raceDate ?? "none"}\nCurrent fitness: ~${baseMileageDisplay}/week${easyPace ? `, easy pace ${easyPace}` : ""}${tempoPace ? `, tempo pace ${tempoPace}` : ""}${intervalPace ? `, interval/5K pace ${intervalPace}` : ""}\nDays/week: ${daysPerWeek}\nPreferred units: ${unitLabel}\n\n${basePhaseGuidance}${ultraGuidance}${bRaceContext}${injuryNotes ? `\n\nINJURY/PHYSICAL LIMITATIONS: ${injuryNotes}. Avoid exercises that could aggravate this; suggest lower-impact alternatives where relevant.` : ""}${otherNotes ? `\n\nATHLETE PREFERENCES: ${otherNotes}. Incorporate these into key_workout and notes where appropriate — spread across multiple weeks (e.g. if hill repeats requested, designate 2-3 build/peak weeks with hill repeats as key_workout; if cycling requested, mention optional bike sessions in notes for rest/recovery days, not as the key_workout).` : ""}${wantsSpeedWork ? "\n\n⚠️ SPEED WORK PRIORITY: This athlete explicitly requested speed work. Include a dedicated quality session (intervals, tempo, strides, or fartlek) as key_workout starting from week 1. Do NOT delay speed work to week 7+ — introduce it immediately and increase intensity as the plan progresses." : ""}\n\nWeeks:\n${arcSummary}`,
      }],
    });

    const enrichText = enrichResponse.content[0].type === "text" ? enrichResponse.content[0].text.trim() : "[]";
    const enriched = JSON.parse(enrichText.match(/\[[\s\S]*\]/)?.[0] || "[]") as Array<{ week_number: number; key_workout: string; notes: string }>;
    for (const e of enriched) {
      const w = planWeeks.find(x => x.week_number === e.week_number);
      if (w) {
        w.key_workout = e.key_workout ?? "";
        w.notes = e.notes ?? "";
      }
    }
  } catch (err) {
    console.error("[generateAndSaveFullPlan] Haiku enrichment failed (non-fatal):", err);
  }

  // Save the plan
  await supabase.from("training_plans").insert({
    user_id: userId,
    race_date: raceDate,
    goal,
    total_weeks: totalWeeks,
    weeks: planWeeks as unknown as Json,
  });

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
  await supabase.from("training_state")
    .update({
      ...(resetToWeek1 ? { current_week: 1 } : {}),
      ...(resetToWeek1 && week1MileageTarget != null ? { weekly_mileage_target: week1MileageTarget } : {}),
      ...(resetToWeek1 ? { weekly_plan_sessions: null } : {}),
      // Week-1 mid-plan rebuild: update mileage target + clear future sessions (preserve past).
      ...(!resetToWeek1 && week1Reset && week1MileageTarget != null ? { weekly_mileage_target: week1MileageTarget } : {}),
      ...(!resetToWeek1 && week1Reset ? { weekly_plan_sessions: (preservedSessions ?? null) as unknown as Json } : {}),
    })
    .eq("user_id", userId);

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
