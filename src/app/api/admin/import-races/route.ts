/**
 * POST /api/admin/import-races
 *
 * Imports all historical races (workout_type=1) from a user's full Strava
 * history, then fetches best_efforts for each.
 *
 * Body: { userId: string }
 * Returns: { ok: true, racesImported: number, bestEffortsUpdated: number }
 */

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getValidAccessToken, getAllActivities, fetchAndStoreBestEfforts } from "@/lib/strava";

export const maxDuration = 300;

export async function POST(request: Request) {
  let body: { userId?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { userId } = body;
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const { data: user } = await supabase
    .from("users")
    .select("id, strava_athlete_id")
    .eq("id", userId)
    .single();

  if (!user?.strava_athlete_id) {
    return NextResponse.json({ error: "User not found or no Strava connection" }, { status: 404 });
  }

  const accessToken = await getValidAccessToken(userId);

  // Page through ALL Strava history, filter to races only
  console.log(`[import-races] fetching full Strava history for user ${userId}...`);
  const allActivities = await getAllActivities(accessToken, { maxPages: 50 });
  const races = (allActivities as Array<Record<string, unknown>>).filter(
    a => (a.workout_type as number | null) === 1
  );
  console.log(`[import-races] found ${races.length} races out of ${allActivities.length} total activities`);

  // Upsert race activities
  const rows = races.map(a => {
    const dist = a.distance as number;
    const move = a.moving_time as number;
    const distMiles = dist / 1609.34;
    const moveMins = move / 60;
    const avgPaceSec = distMiles > 0 ? Math.round((moveMins / distMiles) * 60) : 0;
    return {
      user_id: userId,
      strava_activity_id: a.id as number,
      activity_type: a.type as string,
      activity_name: (a.name as string | null) ?? null,
      distance_meters: dist,
      moving_time_seconds: move,
      elapsed_time_seconds: a.elapsed_time as number,
      average_heartrate: (a.average_heartrate as number | null) ?? null,
      max_heartrate: (a.max_heartrate as number | null) ?? null,
      average_cadence: (a.average_cadence as number | null) ?? null,
      average_pace: `${Math.floor(avgPaceSec / 60)}:${String(avgPaceSec % 60).padStart(2, "0")}/mi`,
      elevation_gain: (a.total_elevation_gain as number | null) ?? null,
      suffer_score: (a.suffer_score as number | null) ?? null,
      workout_type: 1,
      start_date: a.start_date as string,
    };
  });

  for (let i = 0; i < rows.length; i += 50) {
    await supabase.from("activities").upsert(rows.slice(i, i + 50), { onConflict: "strava_activity_id" });
  }

  // Now fetch best_efforts for all imported races
  const { updated } = await fetchAndStoreBestEfforts(userId, accessToken, { forceRefresh: true });

  return NextResponse.json({
    ok: true,
    totalScanned: allActivities.length,
    racesImported: races.length,
    bestEffortsUpdated: updated,
  });
}
