import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import { getAllActivities, getAthleteStats } from "@/lib/strava";

/**
 * GET /api/auth/strava/callback
 * Handles the OAuth callback from Strava. Exchanges the code for tokens,
 * syncs athlete stats synchronously, then sends schedule SMS.
 * Activity import runs in the background (fire-and-forget).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const userId = searchParams.get("state"); // User ID passed via OAuth state

  console.log("[strava-callback] code:", !!code, "userId:", userId);

  if (!code || !userId) {
    console.error("[strava-callback] missing params");
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
    const errorBody = await tokenResponse.text();
    console.error("[strava-callback] token exchange failed:", tokenResponse.status, errorBody);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}?error=token_exchange_failed`
    );
  }

  const tokenData = await tokenResponse.json();
  const { access_token, refresh_token, expires_at, athlete } = tokenData;

  // Extract timezone from Strava athlete profile
  // Strava returns e.g. "(GMT-08:00) America/Los_Angeles" — extract the IANA part
  let timezone: string | null = null;
  if (athlete.timezone) {
    const tzMatch = (athlete.timezone as string).match(
      /\)\s*(.+)$/
    );
    timezone = tzMatch ? tzMatch[1] : athlete.timezone;
  }

  // Fetch athlete stats synchronously — this is a fast single API call
  // We need this data available before the user answers the schedule question
  let stats: Record<string, unknown> = {};
  try {
    stats = await getAthleteStats(access_token, athlete.id);
    console.log("[strava-callback] stats fetched:", {
      allTimeRuns: (stats.all_run_totals as Record<string, unknown>)?.count,
    });
  } catch (err) {
    console.error("[strava-callback] stats fetch failed (non-fatal):", err);
  }

  // Fetch current onboarding_data to merge with stats
  const { data: currentUser } = await supabase
    .from("users")
    .select("onboarding_data")
    .eq("id", userId)
    .single();

  const onboardingData =
    (currentUser?.onboarding_data as Record<string, unknown>) || {};

  // Update user with Strava tokens, timezone, and stats
  const { data: user, error } = await supabase
    .from("users")
    .update({
      strava_athlete_id: athlete.id,
      strava_access_token: access_token,
      strava_refresh_token: refresh_token,
      strava_token_expires_at: new Date(expires_at * 1000).toISOString(),
      name: athlete.firstname || athlete.username || null,
      onboarding_step: "awaiting_schedule",
      ...(timezone ? { timezone } : {}),
      onboarding_data: {
        ...onboardingData,
        strava_stats: {
          all_run_totals: stats.all_run_totals,
          ytd_run_totals: stats.ytd_run_totals,
          recent_run_totals: stats.recent_run_totals,
        },
      },
    })
    .eq("id", userId)
    .select("id, phone_number, name")
    .single();

  if (error || !user) {
    console.error("[strava-callback] db update failed:", error);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}?error=db_error`
    );
  }

  console.log("[strava-callback] user updated:", user.id, "tz:", timezone);

  // Fire-and-forget activity import (slow, paginated) — don't block redirect
  importStravaActivities(user.id, access_token).catch((err) =>
    console.error("[strava-callback] activity import error:", err)
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
 * Import recent activities (last 6 months) from Strava into the DB.
 * This is the slow part — paginated API calls + individual upserts.
 */
async function importStravaActivities(userId: string, accessToken: string) {
  const sixMonthsAgo = Math.floor(
    (Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) / 1000
  );

  const activities = await getAllActivities(accessToken, {
    after: sixMonthsAgo,
    maxPages: 5,
  });

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
    `[strava-callback] imported ${runActivities.length} activities for user ${userId}`
  );
}
