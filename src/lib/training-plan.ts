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
  if (g.includes("ultra") || g.includes("50k") || g.includes("50 k") || g.includes("100k") || g.includes("100 m")) {
    hardCap = 100; floor = 45;
  } else if ((g.includes("marathon") || g.includes("26.2")) && !g.includes("half")) {
    hardCap = 70; floor = 35;
  } else if (g.includes("half") || g.includes("13.1")) {
    hardCap = 55; floor = 22;
  } else if (g.includes("10k") || g.includes("10 k")) {
    hardCap = 50; floor = 15;
  } else if (g.includes("5k") || g.includes("5 k")) {
    hardCap = 45; floor = 12;
  } else {
    hardCap = 60; floor = 20;
  }
  // Allow up to 80% growth from base, but never outside [floor, hardCap]
  return Math.max(Math.min(baseMileage * 1.8, hardCap), floor);
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
  { skipLinkSms = false, prescribedWeek1Miles, bRaces, resetToWeek1 = true }: {
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
  } = {},
): Promise<string> {
  const raceDate = (profile?.race_date as string | null) ?? null;
  const goal = (profile?.goal as string | null) ?? null;
  const easyPace = (profile?.current_easy_pace as string | null) ?? null;
  const daysPerWeek = (profile?.days_per_week as number | null) ?? 4;
  const hasRace = !!raceDate;

  // Determine total weeks: anchor to the start of the current week (Monday) so the race
  // always falls within the last plan week rather than one week past it. Using "now" directly
  // is sensitive to the time of day — if the plan is generated after noon UTC, a race that's
  // exactly N weeks out can round down to N-1 weeks, leaving the race outside the plan.
  let totalWeeks = 12;
  if (raceDate) {
    const now = new Date();
    const race = new Date(raceDate + "T12:00:00Z");
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    monday.setUTCHours(0, 0, 0, 0);
    const weeksUntil = Math.ceil((race.getTime() - monday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    totalWeeks = Math.max(4, Math.min(52, weeksUntil));
  }

  // Base mileage: use the prescribed week 1 total if available (keeps arc week 1 in sync
  // with what Dean actually sent), otherwise fall back to the Strava avg.
  const baseMileage = prescribedWeek1Miles
    ? Math.max(5, prescribedWeek1Miles)
    : Math.max(5, Math.round((avgWeeklyMileage ?? 15) * 2) / 2);

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
    const isDeload = week % 4 === 0 && phase !== "taper" && phase !== "peak";

    let weekMileage: number;
    if (phase === "taper") {
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

    const longRunFactor = phase === "taper" ? 0.30 : phase === "peak" ? 0.38 : 0.32;
    // Goal-specific long run caps: short-race training doesn't need marathon-style long runs.
    const g2 = (goal ?? "").toLowerCase();
    const longRunCap = (g2.includes("5k") || g2.includes("5 k")) ? 7
      : (g2.includes("10k") || g2.includes("10 k")) ? 10
      : (g2.includes("half") || g2.includes("13.1")) ? 14
      : null;
    const rawLongRun = Math.round(weekMileage * longRunFactor * 2) / 2;
    const longRunTarget = longRunCap !== null ? Math.min(rawLongRun, longRunCap) : rawLongRun;

    // Label deload weeks explicitly so the dashboard can surface them distinctly.
    // The phase value is used for mileage logic above; displayPhase is what gets stored.
    const displayPhase = isDeload ? "deload" : phase;
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
  const now = new Date();
  const week1Monday = new Date(now);
  week1Monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // back to Monday
  week1Monday.setHours(0, 0, 0, 0);

  // Map each B/C race to a week number so Haiku can reference them by week.
  const bRaceWeekLabels: string[] = [];
  for (const r of bRaces ?? []) {
    const raceMs = new Date(r.race_date + "T12:00:00Z").getTime();
    const weekNum = Math.round((raceMs - week1Monday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
    if (weekNum >= 1 && weekNum <= totalWeeks) {
      const label = r.race_name ?? (r.priority === "B" ? "B race" : "C race");
      bRaceWeekLabels.push(`Week ${weekNum}: ${r.priority} race — ${label} on ${r.race_date}`);
    }
  }
  const bRaceContext = bRaceWeekLabels.length > 0
    ? `\n\nB/C RACES (tune-up races during the plan):\n${bRaceWeekLabels.join("\n")}\nFor B race weeks: keep key_workout brief or race-focused ("B race — tune-up effort" or similar). For C race weeks: treat as a quality workout day.`
    : "";

  const arcSummary = planWeeks.map(w =>
    `Week ${w.week_number} (${w.phase}, ${w.mileage_target}mi, long run ~${w.long_run_target}mi)`
  ).join("\n");

  // A runner with an established base (≥15 mi/week) doesn't need weeks of pure easy
  // aerobic miles at the start — they already have the base. Quality sessions (strides,
  // short tempos, fartleks) are appropriate from week 1. Only truly new runners building
  // from scratch should have pure easy base weeks.
  const hasEstablishedBase = baseMileage >= 15;
  const basePhaseGuidance = hasEstablishedBase
    ? `This runner already has an established aerobic base at ~${baseMileage}mi/week. Do NOT assign pure easy/base-building weeks — include quality sessions (strides, fartlek, short tempo, easy intervals) from week 1 onward. Reserve "easy aerobic miles" labels only for deload weeks.`
    : `This runner is building their base from scratch. Early base-phase weeks should be easy aerobic miles to develop the aerobic foundation before adding quality.`;

  // Ultra-specific enrichment guidance: back-to-back long runs are the central stimulus
  // for ultra preparation and must be introduced early — not saved for late in the plan.
  const isUltraEnrich = ["50k","50 k","100k","100 k","50mi","50 m","100mi","100 m","ultra"]
    .some(u => (goal ?? "").toLowerCase().includes(u));
  const ultraGuidance = isUltraEnrich ? `

ULTRA-SPECIFIC REQUIREMENTS (mandatory):
- Introduce back-to-back long run weekends (e.g. "Sat 18mi + Sun 12mi easy") no later than week ${Math.max(3, Math.round(totalWeeks * 0.25))} of ${totalWeeks}. This is the key ultra stimulus — do NOT delay it to the second half of the plan.
- Include trail-specific context from week 1: hiking steep uphills (power-hiking is faster than running them in a 50k/100k), running by time-on-feet rather than strict pace, and managing elevation.
- key_workout for back-to-back weekends should specify both Saturday and Sunday, e.g. "Sat 20mi trail + Sun 14mi easy (back-to-back)".
- Notes should reference the back-to-back adaptation, hiking uphills, and time-on-feet philosophy when applicable.` : "";

  try {
    const enrichResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2500,
      system: `You are a running coach generating a structured training plan arc.
For each week provide:
- key_workout: the defining session for that week (1 line). Examples: "6×800m @ 5K pace", "4mi tempo @ threshold", "12mi long run with 2mi @ goal pace", "6×strides + easy 5mi", "20min fartlek", "Race simulation 5mi @ goal pace". Deload weeks get a low-key description.
- notes: 2-3 sentences for the athlete to read on their dashboard. First sentence: the week's purpose and why it matters at this stage of training (e.g. "Week 6 is about building your aerobic base — consistent easy mileage here pays dividends in the peak phase."). Then 1-2 sentences on the key workout: what it is, the target effort or pace, and one brief execution tip (e.g. "The tempo run on Wednesday should feel comfortably hard — you should be able to speak in short phrases but not hold a conversation. Start controlled and aim to hold pace in the second half."). Deload weeks should acknowledge the pullback and why recovery is productive. Keep it direct and practical, not generic.

Return ONLY a valid JSON array:
[{"week_number": 1, "key_workout": "...", "notes": "..."}, ...]
No other text.`,
      messages: [{
        role: "user",
        content: `Goal: ${goal ?? "general running fitness"}\nRace date: ${raceDate ?? "none"}\nCurrent fitness: ~${baseMileage}mi/week${easyPace ? `, easy pace ${easyPace}` : ""}\nDays/week: ${daysPerWeek}\n\n${basePhaseGuidance}${ultraGuidance}${bRaceContext}\n\nWeeks:\n${arcSummary}`,
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
  // Always sync weekly_mileage_target: use prescribedWeek1Miles (what Dean told the athlete) if
  // provided, otherwise fall back to the computed arc week 1 so the dashboard stays consistent
  // with the plan (fixes the "dashboard shows 15mi but plan says 13mi" mismatch after race date
  // changes that trigger a full regen without a fresh prescribed value).
  const week1ArcMileage = planWeeks[0]?.mileage_target ?? null;
  const week1MileageTarget = prescribedWeek1Miles ?? week1ArcMileage;
  await supabase.from("training_state")
    .update({
      ...(resetToWeek1 ? { current_week: 1 } : {}),
      ...(week1MileageTarget != null ? { weekly_mileage_target: week1MileageTarget } : {}),
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
    try {
      await sendSMS(phoneNumber, `Your full ${totalWeeks}-week training plan is ready: ${planUrl}\n\nI'll send you the specifics each week and keep this updated as your training progresses.`);
    } catch (err) {
      console.error("[generateAndSaveFullPlan] dashboard link SMS failed (non-fatal):", err);
    }
  }

  return dashboardToken;
}
