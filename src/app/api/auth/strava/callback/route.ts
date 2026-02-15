import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/twilio";
import { getAllActivities, getAthleteStats } from "@/lib/strava";

/**
 * GET /api/auth/strava/callback
 * Handles the OAuth callback from Strava. Exchanges the code for tokens,
 * updates the user, syncs historical activities, and advances onboarding.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const userId = searchParams.get("state"); // User ID passed via OAuth state

  if (!code || !userId) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}?error=missing_params`
    );
  }

  // Exchange authorization code for tokens
  const tokenResponse = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}?error=token_exchange_failed`
    );
  }

  const tokenData = await tokenResponse.json();
  const { access_token, refresh_token, expires_at, athlete } = tokenData;

  // Update user with Strava tokens
  const { data: user, error } = await supabase
    .from("users")
    .update({
      strava_athlete_id: athlete.id,
      strava_access_token: access_token,
      strava_refresh_token: refresh_token,
      strava_token_expires_at: new Date(expires_at * 1000).toISOString(),
      name: athlete.firstname || athlete.username || null,
      onboarding_step: "awaiting_schedule",
    })
    .eq("id", userId)
    .select("id, phone_number, name")
    .single();

  if (error || !user) {
    console.error("Error updating user with Strava tokens:", error);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}?error=db_error`
    );
  }

  // Sync historical activities and athlete stats in the background
  // Don't block the redirect — fire and forget
  syncStravaHistory(user.id, access_token, athlete.id).catch((err) =>
    console.error("Error syncing Strava history:", err)
  );

  // Send SMS asking about training schedule
  const scheduleMsg = `Strava connected — nice! Last question: which days of the week work best for running? (e.g., Tue, Thu, Sat, Sun)`;

  await Promise.all([
    sendSMS(user.phone_number, scheduleMsg),
    supabase.from("conversations").insert({
      user_id: user.id,
      role: "assistant",
      content: scheduleMsg,
      message_type: "coach_response",
    }),
  ]);

  // Redirect browser to confirmation page
  return NextResponse.redirect(
    `${process.env.NEXT_PUBLIC_APP_URL}/strava-connected`
  );
}

/**
 * Import recent activities (last 6 months) and athlete stats from Strava.
 * Stores activities in the DB and saves athlete stats in onboarding_data.
 */
async function syncStravaHistory(
  userId: string,
  accessToken: string,
  athleteId: number
) {
  // Fetch athlete stats and recent activities in parallel
  const sixMonthsAgo = Math.floor(
    (Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) / 1000
  );

  const [stats, activities] = await Promise.all([
    getAthleteStats(accessToken, athleteId),
    getAllActivities(accessToken, { after: sixMonthsAgo, maxPages: 5 }),
  ]);

  // Store athlete stats in onboarding_data for later use
  const { data: currentUser } = await supabase
    .from("users")
    .select("onboarding_data")
    .eq("id", userId)
    .single();

  const onboardingData =
    (currentUser?.onboarding_data as Record<string, unknown>) || {};

  await supabase
    .from("users")
    .update({
      onboarding_data: {
        ...onboardingData,
        strava_stats: {
          all_run_totals: stats.all_run_totals,
          ytd_run_totals: stats.ytd_run_totals,
          recent_run_totals: stats.recent_run_totals,
        },
      },
    })
    .eq("id", userId);

  // Store activities — batch upsert
  const typedActivities = activities as Array<Record<string, unknown>>;
  const runActivities = typedActivities.filter((a) =>
    ["Run", "TrailRun", "VirtualRun"].includes(a.type as string)
  );

  for (const activity of runActivities) {
    const distanceMeters = activity.distance as number;
    const movingTimeSeconds = activity.moving_time as number;
    const distanceMiles = distanceMeters / 1609.34;
    const movingTimeMinutes = movingTimeSeconds / 60;
    const avgPaceMinutes =
      distanceMiles > 0 ? movingTimeMinutes / distanceMiles : 0;
    const totalPaceSec = Math.round(avgPaceMinutes * 60);
    const paceMin = Math.floor(totalPaceSec / 60);
    const paceSec = totalPaceSec % 60;

    await supabase.from("activities").upsert(
      {
        user_id: userId,
        strava_activity_id: activity.id,
        activity_type: activity.type,
        distance_meters: distanceMeters,
        moving_time_seconds: movingTimeSeconds,
        elapsed_time_seconds: activity.elapsed_time,
        average_heartrate: activity.average_heartrate || null,
        max_heartrate: activity.max_heartrate || null,
        average_cadence: activity.average_cadence || null,
        average_pace: `${paceMin}:${paceSec.toString().padStart(2, "0")}/mi`,
        elevation_gain: activity.total_elevation_gain,
        suffer_score: activity.suffer_score || null,
        start_date: activity.start_date,
      },
      { onConflict: "strava_activity_id" }
    );
  }

  console.log(
    `Synced ${runActivities.length} activities for user ${userId}. ` +
      `All-time: ${stats.all_run_totals?.count} runs, ${Math.round((stats.all_run_totals?.distance || 0) / 1609.34)} mi`
  );
}
