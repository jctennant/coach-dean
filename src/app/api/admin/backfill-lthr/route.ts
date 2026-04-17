/**
 * POST /api/admin/backfill-lthr
 *
 * Computes LTHR estimates for users who have Strava connected and an existing
 * training_profiles row but no lthr_estimate yet. Safe to run multiple times —
 * skips users already upgraded unless force=true.
 *
 * Body: { userId?: string, force?: boolean }
 *   userId — single user; omit to backfill all eligible users
 *   force  — re-estimate even if lthr_estimate is already set
 *
 * Returns: { ok: true, updated: number, skipped: number, noRaces: number }
 */

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { estimateLTHRFromRaces } from "@/lib/hr-zones";
import { estimateMaxHR } from "@/lib/hr-utils";

export const maxDuration = 300;

export async function POST(request: Request) {
  let body: { userId?: string; force?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { userId, force = false } = body;

  // Fetch eligible users: have Strava connected and an existing profile
  const usersQuery = supabase
    .from("users")
    .select("id")
    .not("strava_athlete_id", "is", null);
  if (userId) usersQuery.eq("id", userId);
  const { data: users } = await usersQuery;

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, skipped: 0, noRaces: 0 });
  }

  let updated = 0;
  let skipped = 0;
  let noRaces = 0;

  for (const user of users) {
    // Check profile exists and whether LTHR already set
    const { data: profile } = await supabase
      .from("training_profiles")
      .select("lthr_estimate")
      .eq("user_id", user.id)
      .single();

    if (!profile) { skipped++; continue; }
    if (profile.lthr_estimate != null && !force) { skipped++; continue; }

    // Fetch stored activities for LTHR estimation
    const { data: activities } = await supabase
      .from("activities")
      .select("workout_type, average_heartrate, moving_time_seconds, activity_name, start_date, activity_type, max_heartrate")
      .eq("user_id", user.id)
      .order("start_date", { ascending: false })
      .limit(200);

    if (!activities || activities.length === 0) { noRaces++; continue; }

    const maxHR = estimateMaxHR(activities.map(a => ({
      activity_type: a.activity_type,
      workout_type: a.workout_type ?? null,
      average_heartrate: a.average_heartrate ?? null,
      max_heartrate: a.max_heartrate ?? null,
    })));

    const lthrResult = estimateLTHRFromRaces(
      activities.map(a => ({
        workout_type: a.workout_type ?? null,
        average_heartrate: a.average_heartrate ?? null,
        moving_time_seconds: a.moving_time_seconds ?? null,
        activity_name: a.activity_name ?? null,
        start_date: a.start_date ?? null,
      })),
      maxHR
    );

    if (!lthrResult) { noRaces++; continue; }

    const { error } = await supabase.from("training_profiles").update({
      lthr_estimate: lthrResult.lthr,
      lthr_source: lthrResult.source,
      lthr_confidence: lthrResult.confidence,
      lthr_last_updated: new Date().toISOString(),
      hr_zone_method: "lthr",
    }).eq("user_id", user.id);

    if (error) {
      console.error(`[backfill-lthr] update failed for user ${user.id}:`, error);
      skipped++;
    } else {
      console.log(`[backfill-lthr] user ${user.id}: LTHR=${lthrResult.lthr} bpm (${lthrResult.confidence})`);
      updated++;
    }
  }

  return NextResponse.json({ ok: true, updated, skipped, noRaces });
}
