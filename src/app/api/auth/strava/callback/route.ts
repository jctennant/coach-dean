import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import { getAllActivities, getAthleteStats } from "@/lib/strava";
import type { Json } from "@/lib/database.types";

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

  // Strava reports the athlete's display preference as "feet" (imperial) or "meters" (metric).
  // Store this so all subsequent coaching messages use consistent units without guessing.
  const preferredUnits: "imperial" | "metric" =
    (athlete.measurement_preference as string) === "meters" ? "metric" : "imperial";

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

  // Fetch current user state to merge onboarding_data and check if already onboarded
  const { data: currentUser } = await supabase
    .from("users")
    .select("onboarding_data, onboarding_step")
    .eq("id", userId)
    .single();

  const onboardingData =
    (currentUser?.onboarding_data as Record<string, unknown>) || {};
  const alreadyOnboarded = currentUser?.onboarding_step === null;

  // Extract city and state from Strava athlete profile for timezone confirmation step
  const stravaCity = (athlete.city as string | null) || null;
  const stravaState = (athlete.state as string | null) || null;

  // Update user with Strava tokens, timezone, and stats
  const updatedOnboardingData = {
    ...onboardingData,
    strava_connected: true,
    strava_stats: {
      all_run_totals: stats.all_run_totals,
      ytd_run_totals: stats.ytd_run_totals,
      recent_run_totals: stats.recent_run_totals,
    },
    ...(stravaCity ? { strava_city: stravaCity } : {}),
    ...(stravaState ? { strava_state: stravaState } : {}),
  };

  const { data: user, error } = await supabase
    .from("users")
    .update({
      strava_athlete_id: athlete.id,
      strava_access_token: access_token,
      strava_refresh_token: refresh_token,
      strava_token_expires_at: new Date(expires_at * 1000).toISOString(),
      name: athlete.firstname || athlete.username || null,
      // Don't reset onboarding_step for already-onboarded users
      ...(!alreadyOnboarded ? { onboarding_step: "awaiting_schedule" } : {}),
      ...(timezone ? { timezone } : {}),
      onboarding_data: updatedOnboardingData as unknown as Json,
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

  console.log("[strava-callback] user updated:", user.id, "tz:", timezone, "units:", preferredUnits);

  // Persist preferred_units to training_profiles (upsert in case row doesn't exist yet).
  // This is fire-and-forget — a failure here doesn't block the flow.
  void supabase
    .from("training_profiles")
    .upsert({ user_id: user.id, preferred_units: preferredUnits, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  // Fire-and-forget activity import (slow, paginated) — don't block redirect
  importStravaActivities(user.id, access_token).catch((err) =>
    console.error("[strava-callback] activity import error:", err)
  );

  const firstName = user.name ? ` ${user.name}` : "";
  const smsMsg = alreadyOnboarded
    ? `Strava connected${firstName}! I'll pull in your training history and factor it into your plan going forward. Just keep doing what you're doing — I've got it from here.`
    : `Strava connected${firstName} — I can see your training history, this is going to help a lot. A couple more quick questions: which days of the week work best for you? (e.g. Mon, Wed, Fri, Sun)`;

  await Promise.all([
    sendSMS(user.phone_number, smsMsg),
    supabase.from("conversations").insert({
      user_id: user.id,
      role: "assistant",
      content: smsMsg,
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
  // Go back 2 years — captures full training history including races.
  // 3 pages × 200 = 600 activities, covers 2 years for all but the highest-volume athletes.
  const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * 24 * 60 * 60;

  const activities = await getAllActivities(accessToken, {
    after: twoYearsAgo,
    maxPages: 3,
  });

  const typedActivities = activities as Array<Record<string, unknown>>;
  const runActivities = typedActivities.filter((a) =>
    ["Run", "TrailRun", "VirtualRun"].includes(a.type as string)
  );

  // Build all rows first, then batch upsert in chunks of 50
  const rows = runActivities.map((activity) => {
    const distanceMeters = activity.distance as number;
    const movingTimeSeconds = activity.moving_time as number;
    const distanceMiles = distanceMeters / 1609.34;
    const movingTimeMinutes = movingTimeSeconds / 60;
    const avgPaceMinutes = distanceMiles > 0 ? movingTimeMinutes / distanceMiles : 0;
    const totalPaceSec = Math.round(avgPaceMinutes * 60);
    const paceMin = Math.floor(totalPaceSec / 60);
    const paceSec = totalPaceSec % 60;

    return {
      user_id: userId,
      strava_activity_id: activity.id as number,
      activity_type: activity.type as string,
      distance_meters: distanceMeters,
      moving_time_seconds: movingTimeSeconds,
      elapsed_time_seconds: activity.elapsed_time as number,
      average_heartrate: (activity.average_heartrate as number | null) || null,
      max_heartrate: (activity.max_heartrate as number | null) || null,
      average_cadence: (activity.average_cadence as number | null) || null,
      average_pace: `${paceMin}:${paceSec.toString().padStart(2, "0")}/mi`,
      elevation_gain: activity.total_elevation_gain as number | null,
      suffer_score: (activity.suffer_score as number | null) || null,
      workout_type: (activity.workout_type as number | null) ?? null,
      start_date: activity.start_date as string,
    };
  });

  // Upsert in chunks of 50 to avoid request size limits
  const chunkSize = 50;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await supabase.from("activities").upsert(chunk, { onConflict: "strava_activity_id" });
  }

  console.log(`[strava-callback] imported ${rows.length} activities for user ${userId}`);
}
