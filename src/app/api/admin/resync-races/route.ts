import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * POST /api/admin/resync-races
 *
 * Re-syncs the races table for a user from their onboarding_data.other_races.
 * Useful when races were captured in onboarding_data but not inserted into the
 * races table (e.g. Haiku returned null dates that were filtered out at insert time).
 *
 * Body:
 *   secret   string   — must match ADMIN_SECRET
 *   userId   string   — user UUID from the users table
 *   dry_run  boolean  — if true, returns what would be inserted without writing (default false)
 */
export async function POST(request: Request) {
  const { secret, userId, dry_run = false } = await request.json();

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, onboarding_data")
    .eq("id", userId)
    .single();

  if (userErr || !user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const data = (user.onboarding_data as Record<string, unknown>) ?? {};
  const raceDate = data.race_date as string | null;
  const goal = data.goal as string | null;
  const raceName = data.race_name as string | null;
  const goalDistanceMiles = data.goal_distance_miles as number | null;
  const goalTimeMinutes = data.goal_time_minutes as number | null;
  const otherRaces = (data.other_races as Array<{ date: string; name: string | null; goal: string | null; priority: "B" | "C" }> | null) ?? [];

  if (!raceDate || !goal) {
    return NextResponse.json({
      error: "No A race in onboarding_data — cannot resync",
      onboarding_data_keys: Object.keys(data),
    }, { status: 400 });
  }

  const aRace = {
    user_id: userId,
    race_date: raceDate,
    race_name: raceName,
    goal,
    priority: "A",
    goal_time_minutes: goalTimeMinutes,
    goal_distance_miles: goalDistanceMiles,
  };

  const bCRaces = otherRaces
    .filter(r => r.date && r.goal)
    .map(r => ({
      user_id: userId,
      race_date: r.date,
      race_name: r.name ?? null,
      goal: r.goal!,
      priority: r.priority,
      goal_time_minutes: null,
      goal_distance_miles: null,
    }));

  const dropped = otherRaces.filter(r => !r.date || !r.goal);

  const racesToInsert = [aRace, ...bCRaces];

  if (dry_run) {
    return NextResponse.json({
      dry_run: true,
      would_insert: racesToInsert,
      dropped_missing_date_or_goal: dropped,
    });
  }

  await supabase.from("races").delete().eq("user_id", userId);
  const { error: insertErr } = await supabase.from("races").insert(racesToInsert);

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    inserted: racesToInsert,
    dropped_missing_date_or_goal: dropped,
  });
}
