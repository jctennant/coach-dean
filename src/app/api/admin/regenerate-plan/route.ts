import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { generateAndSaveFullPlan } from "@/lib/training-plan";

/**
 * POST /api/admin/regenerate-plan
 *
 * Regenerate the full training plan arc for a user, optionally with a new
 * week-1 mileage baseline. Useful when a user's initial plan was too
 * conservative (e.g. no Strava history at onboarding time) and needs to be
 * rebaselined after they reported their actual fitness.
 *
 * Body: {
 *   secret: string
 *   userId: string
 *   prescribedWeek1Miles?: number   — override the base mileage for the arc
 *   resetToWeek1?: boolean          — default false (keep current week position)
 * }
 */
export async function POST(request: Request) {
  const {
    secret,
    userId,
    prescribedWeek1Miles,
    resetToWeek1 = false,
  } = await request.json();

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // Fetch user + profile
  const [{ data: user, error: userErr }, { data: profile, error: profErr }] = await Promise.all([
    supabase.from("users").select("phone_number, strava_athlete_id").eq("id", userId).single(),
    supabase.from("training_profiles").select("*").eq("user_id", userId).single(),
  ]);

  if (userErr || !user) {
    return NextResponse.json({ error: "User not found", detail: userErr?.message }, { status: 404 });
  }
  if (profErr || !profile) {
    return NextResponse.json({ error: "Training profile not found", detail: profErr?.message }, { status: 404 });
  }

  // Compute avg weekly mileage from Strava if connected (last 8 weeks)
  let avgWeeklyMileage: number | null = null;
  if (user.strava_athlete_id) {
    const eightWeeksAgo = new Date();
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
    const { data: acts } = await supabase
      .from("activities")
      .select("distance_meters")
      .eq("user_id", userId)
      .gte("start_date", eightWeeksAgo.toISOString())
      .in("activity_type", ["Run", "TrailRun", "VirtualRun", "Treadmill"]);
    if (acts && acts.length > 0) {
      const totalMeters = acts.reduce((sum, a) => sum + ((a.distance_meters as number) ?? 0), 0);
      avgWeeklyMileage = Math.round((totalMeters / 1609.34 / 8) * 10) / 10;
    }
  }

  const planSummary = await generateAndSaveFullPlan(
    userId,
    user.phone_number as string,
    profile as Record<string, unknown>,
    avgWeeklyMileage,
    {
      skipLinkSms: true,
      prescribedWeek1Miles,
      resetToWeek1,
    }
  );

  return NextResponse.json({
    ok: true,
    userId,
    prescribedWeek1Miles: prescribedWeek1Miles ?? null,
    avgWeeklyMileage,
    resetToWeek1,
    planSummary,
  });
}
