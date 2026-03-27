import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * POST /api/admin/resync-races
 *
 * Two modes:
 *
 * MODE 1 — Add explicit races (add_races is provided):
 *   Appends the provided races to the existing races table without touching A race.
 *   Useful when B/C races were never captured in onboarding_data.
 *   Body: { secret, userId, add_races: [{ race_date, race_name, goal, priority, goal_distance_miles? }], dry_run? }
 *
 * MODE 2 — Resync from onboarding_data (no add_races):
 *   Re-syncs the entire races table from onboarding_data.other_races.
 *   Replaces all races for the user. Requires race_date + goal in onboarding_data.
 *   Body: { secret, userId, dry_run? }
 */
export async function POST(request: Request) {
  const { secret, userId, add_races, dry_run = false } = await request.json();

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  // MODE 1: Explicit race insertion — just append the given races, leave A race alone.
  if (Array.isArray(add_races) && add_races.length > 0) {
    const racesToInsert = add_races.map((r: { race_date: string; race_name?: string | null; goal: string; priority: string; goal_distance_miles?: number | null }) => ({
      user_id: userId,
      race_date: r.race_date,
      race_name: r.race_name ?? null,
      goal: r.goal,
      priority: r.priority,
      goal_time_minutes: null,
      goal_distance_miles: r.goal_distance_miles ?? null,
    }));

    if (dry_run) {
      return NextResponse.json({ dry_run: true, would_insert: racesToInsert });
    }

    const { error: insertErr } = await supabase.from("races").insert(racesToInsert);
    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, inserted: racesToInsert });
  }

  // MODE 2: Resync from onboarding_data.
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
      error: "No A race in onboarding_data — use add_races mode instead",
      hint: 'Pass add_races: [{ race_date, race_name, goal, priority }] to insert B/C races directly without touching the A race',
      onboarding_data: data,
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
    return NextResponse.json({ dry_run: true, would_insert: racesToInsert, dropped });
  }

  await supabase.from("races").delete().eq("user_id", userId);
  const { error: insertErr } = await supabase.from("races").insert(racesToInsert);
  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: racesToInsert, dropped });
}
