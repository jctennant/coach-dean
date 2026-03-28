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
  { skipLinkSms = false, prescribedWeek1Miles, bRaces }: { skipLinkSms?: boolean; prescribedWeek1Miles?: number; bRaces?: Array<{ race_date: string; race_name: string | null; priority: string }> } = {},
): Promise<string> {
  const raceDate = (profile?.race_date as string | null) ?? null;
  const goal = (profile?.goal as string | null) ?? null;
  const easyPace = (profile?.current_easy_pace as string | null) ?? null;
  const daysPerWeek = (profile?.days_per_week as number | null) ?? 4;
  const hasRace = !!raceDate;

  // Determine total weeks: race → use Math.round so the arc week count matches what
  // Dean computes in the plan text (which uses whole-week language like "~19 weeks").
  let totalWeeks = 12;
  if (raceDate) {
    const now = new Date();
    const race = new Date(raceDate + "T12:00:00Z");
    const weeksUntil = Math.ceil((race.getTime() - now.getTime()) / (7 * 24 * 60 * 60 * 1000));
    totalWeeks = Math.max(4, Math.min(52, weeksUntil));
  }

  // Base mileage: use the prescribed week 1 total if available (keeps arc week 1 in sync
  // with what Dean actually sent), otherwise fall back to the Strava avg.
  const baseMileage = prescribedWeek1Miles
    ? Math.max(5, prescribedWeek1Miles)
    : Math.max(5, Math.round((avgWeeklyMileage ?? 15) * 2) / 2);

  // Build the arc week by week.
  // `buildMileage` tracks the real progression level (deloads and tapers branch off it).
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
      // 2-week taper: 70% → 50% of peak
      const taperWeek = 2 - weeksFromEnd; // 1, 2
      const taperFactor = taperWeek >= 2 ? 0.50 : 0.70;
      weekMileage = Math.round(peakMileage * taperFactor * 2) / 2;
    } else if (isDeload) {
      weekMileage = Math.round(buildMileage * 0.70 * 2) / 2;
      // buildMileage stays unchanged — resumes from pre-deload level next week
    } else {
      const buildFactor = phase === "peak" ? 1.04 : 1.07;
      // Week 1 IS the base — don't apply buildFactor so the arc starts at exactly
      // prescribedWeek1Miles (or baseMileage). Build begins from week 2 onward.
      if (week > 1) {
        buildMileage = Math.round(buildMileage * buildFactor * 2) / 2;
      }
      weekMileage = buildMileage;
      if (phase === "peak") peakMileage = buildMileage;
    }

    const longRunFactor = phase === "taper" ? 0.30 : phase === "peak" ? 0.38 : 0.32;
    const longRunTarget = Math.round(weekMileage * longRunFactor * 2) / 2;

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

  try {
    const enrichResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2500,
      system: `You are a running coach generating a structured training plan arc.
For each week provide:
- key_workout: the defining session for that week (1 line). Examples: "6×800m @ 5K pace", "4mi tempo @ threshold", "12mi long run with 2mi @ goal pace", "Base building — easy aerobic miles", "Race simulation 5mi @ goal pace". Pure base/easy weeks get a motivating description, not a pacing prescription.
- notes: one coaching sentence. Vary these so each week feels distinct.

Return ONLY a valid JSON array:
[{"week_number": 1, "key_workout": "...", "notes": "..."}, ...]
No other text.`,
      messages: [{
        role: "user",
        content: `Goal: ${goal ?? "general running fitness"}\nRace date: ${raceDate ?? "none"}\nCurrent fitness: ~${baseMileage}mi/week${easyPace ? `, easy pace ${easyPace}` : ""}\nDays/week: ${daysPerWeek}${bRaceContext}\n\nWeeks:\n${arcSummary}`,
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

  // Sync training_state.weekly_mileage_target to match the actual prescribed week 1 mileage
  // so the dashboard's "Weekly target" for week 1 reflects what Dean actually sent.
  if (prescribedWeek1Miles) {
    await supabase.from("training_state")
      .update({ weekly_mileage_target: prescribedWeek1Miles })
      .eq("user_id", userId);
  }

  // Generate dashboard token and mark trial start
  const dashboardToken = crypto.randomUUID();
  await supabase.from("users").update({
    dashboard_token: dashboardToken,
    trial_started_at: new Date().toISOString(),
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
