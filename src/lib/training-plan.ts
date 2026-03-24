import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS } from "@/lib/linq";
import type { Json } from "@/lib/database.types";

/**
 * Compute training phase for a pre-generated plan arc, based on position
 * within the plan rather than the actual calendar date.
 */
export function computePhaseForPlan(weekNumber: number, totalWeeks: number, hasRace: boolean): string {
  if (!hasRace) {
    const cyclePos = (weekNumber - 1) % 12;
    return cyclePos < 6 ? "base" : "build";
  }
  const weeksFromEnd = totalWeeks - weekNumber;
  if (weeksFromEnd < 3) return "taper";
  if (weeksFromEnd < 7) return "peak";
  if (weeksFromEnd < 14) return "build";
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
  { skipLinkSms = false }: { skipLinkSms?: boolean } = {},
): Promise<string> {
  const raceDate = (profile?.race_date as string | null) ?? null;
  const goal = (profile?.goal as string | null) ?? null;
  const easyPace = (profile?.current_easy_pace as string | null) ?? null;
  const daysPerWeek = (profile?.days_per_week as number | null) ?? 4;
  const hasRace = !!raceDate;

  // Determine total weeks: race → cap 4–24 weeks; no race → 12-week cycle
  let totalWeeks = 12;
  if (raceDate) {
    const now = new Date();
    const race = new Date(raceDate + "T12:00:00Z");
    const weeksUntil = Math.ceil((race.getTime() - now.getTime()) / (7 * 24 * 60 * 60 * 1000));
    totalWeeks = Math.max(4, Math.min(24, weeksUntil));
  }

  // Base mileage: current avg or a sensible default
  const baseMileage = Math.max(5, Math.round((avgWeeklyMileage ?? 15) * 2) / 2);

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
      // 3-week taper: 75% → 65% → 50% of peak
      const taperWeek = 3 - weeksFromEnd; // 1, 2, 3
      const taperFactor = taperWeek >= 3 ? 0.50 : taperWeek === 2 ? 0.65 : 0.75;
      weekMileage = Math.round(peakMileage * taperFactor * 2) / 2;
    } else if (isDeload) {
      weekMileage = Math.round(buildMileage * 0.70 * 2) / 2;
      // buildMileage stays unchanged — resumes from pre-deload level next week
    } else {
      const buildFactor = phase === "peak" ? 1.04 : 1.07;
      buildMileage = Math.round(buildMileage * buildFactor * 2) / 2;
      weekMileage = buildMileage;
      if (phase === "peak") peakMileage = buildMileage;
    }

    const longRunFactor = phase === "taper" ? 0.30 : phase === "peak" ? 0.38 : 0.32;
    const longRunTarget = Math.round(weekMileage * longRunFactor * 2) / 2;

    planWeeks.push({
      week_number: week,
      phase,
      mileage_target: weekMileage,
      long_run_target: longRunTarget,
      key_workout: "",
      notes: "",
    });
  }

  // Enrich each week with key_workout and notes via Claude Haiku (single call)
  const arcSummary = planWeeks.map(w =>
    `Week ${w.week_number} (${w.phase}, ${w.mileage_target}mi, long run ~${w.long_run_target}mi)`
  ).join("\n");

  try {
    const enrichResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: `You are a running coach generating a structured training plan arc.
For each week provide:
- key_workout: the defining session for that week (1 line). Examples: "6×800m @ 5K pace", "4mi tempo @ threshold", "12mi long run with 2mi @ goal pace", "Base building — easy aerobic miles", "Race simulation 5mi @ goal pace". Pure base/easy weeks get a motivating description, not a pacing prescription.
- notes: one coaching sentence. Vary these so each week feels distinct.

Return ONLY a valid JSON array:
[{"week_number": 1, "key_workout": "...", "notes": "..."}, ...]
No other text.`,
      messages: [{
        role: "user",
        content: `Goal: ${goal ?? "general running fitness"}\nRace date: ${raceDate ?? "none"}\nCurrent fitness: ~${baseMileage}mi/week${easyPace ? `, easy pace ${easyPace}` : ""}\nDays/week: ${daysPerWeek}\n\nWeeks:\n${arcSummary}`,
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
      await sendSMS(phoneNumber, `Your full ${totalWeeks}-week training plan is ready to view: ${planUrl}`);
    } catch (err) {
      console.error("[generateAndSaveFullPlan] dashboard link SMS failed (non-fatal):", err);
    }
  }

  return dashboardToken;
}
