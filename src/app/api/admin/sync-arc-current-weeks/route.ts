import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";

/**
 * POST /api/admin/sync-arc-current-weeks
 *
 * Backfill fix: re-derives long_run_target and weekly_mileage_target from each
 * user's stored weekly_plan_sessions (the authoritative source extracted from
 * Dean's text) and patches training_plans.weeks + training_state — no SMS sent.
 *
 * Use this when the dashboard numbers diverge from what Dean actually texted.
 *
 * Body: { secret: string, userId?: string }
 *   userId — optional; limits the run to a single user for spot-checking.
 */
export async function POST(request: Request) {
  const { secret, userId: singleUserId } = await request.json();

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch all fully-onboarded users (or just the one requested)
  let query = supabase
    .from("users")
    .select("id")
    .is("onboarding_step", null);
  if (singleUserId) query = query.eq("id", singleUserId);

  const { data: users } = await query;
  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, skipped: 0 });
  }

  function parseMilesFromLabel(label: string): number {
    const m = label.match(/(\d+(?:\.\d+)?)\s*mi(?!\w)/i);
    return m ? parseFloat(m[1]!) : 0;
  }

  const CROSS_TRAINING_RE = /\b(strength|mobility|stretch|yoga|bike|biking|cycling|swim|swimming|elliptical|cross.train|zwift|spin)\b/i;

  const results: Array<{ userId: string; status: string; actualMiles?: number; longRunMiles?: number }> = [];

  for (const user of users) {
    const userId = user.id as string;

    // Fetch training state + profile in parallel
    const [{ data: stateRow }, { data: profileRow }, { data: planRow }] = await Promise.all([
      supabase
        .from("training_state")
        .select("current_week, current_phase, weekly_plan_sessions")
        .eq("user_id", userId)
        .single(),
      supabase
        .from("training_profiles")
        .select("goal")
        .eq("user_id", userId)
        .single(),
      supabase
        .from("training_plans")
        .select("id, weeks")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single(),
    ]);

    const sessions = (stateRow?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }> | null) ?? [];
    if (sessions.length === 0 || !stateRow || !planRow) {
      results.push({ userId, status: "skipped_no_sessions" });
      continue;
    }

    const currentWeekNum = stateRow.current_week as number;

    // Compute actual total miles from running sessions only
    const actualMiles = Math.round(
      sessions.reduce((sum, s) => sum + parseMilesFromLabel(s.label), 0) * 2
    ) / 2;

    // Long run: prefer explicit "long" label, fall back to highest-mileage running session
    const longRunByLabel = sessions.find(s => s.label.toLowerCase().includes("long"));
    const longRunByMileage = sessions
      .filter(s => !CROSS_TRAINING_RE.test(s.label))
      .reduce<{ day: string; date: string; label: string } | null>((best, s) =>
        parseMilesFromLabel(s.label) > parseMilesFromLabel(best?.label ?? "") ? s : best
      , null);
    const longRunSession = longRunByLabel ?? longRunByMileage;
    const longRunMiles = longRunSession ? parseMilesFromLabel(longRunSession.label) : 0;

    if (actualMiles === 0) {
      results.push({ userId, status: "skipped_zero_miles" });
      continue;
    }

    // Patch the current week entry in the training arc
    const planWeeks = (planRow.weeks as Array<{
      week_number: number;
      mileage_target: number;
      long_run_target: number;
      [key: string]: unknown;
    }>) ?? [];

    const updatedWeeks = planWeeks.map(w =>
      w.week_number === currentWeekNum
        ? {
            ...w,
            mileage_target: actualMiles,
            ...(longRunMiles > 0 ? { long_run_target: longRunMiles } : {}),
          }
        : w
    );

    await Promise.all([
      supabase
        .from("training_plans")
        .update({ weeks: updatedWeeks as unknown as Json, updated_at: new Date().toISOString() })
        .eq("id", planRow.id as string),
      supabase
        .from("training_state")
        .update({ weekly_mileage_target: actualMiles })
        .eq("user_id", userId),
    ]);

    results.push({ userId, status: "updated", actualMiles, longRunMiles });
    console.log(`[sync-arc-current-weeks] user ${userId}: ${actualMiles}mi total, ${longRunMiles}mi long run`);
  }

  const updated = results.filter(r => r.status === "updated").length;
  const skipped = results.filter(r => r.status.startsWith("skipped")).length;
  return NextResponse.json({ ok: true, updated, skipped, results });
}
