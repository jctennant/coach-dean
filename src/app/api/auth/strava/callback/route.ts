import { NextResponse, after } from "next/server";
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
    .select("onboarding_data, onboarding_step, name, linq_chat_id")
    .eq("id", userId)
    .single();

  const onboardingData =
    (currentUser?.onboarding_data as Record<string, unknown>) || {};
  const alreadyOnboarded = currentUser?.onboarding_step === null;

  // Don't overwrite a name already captured during onboarding (e.g. "Hi, I'm Shaun")
  // with the Strava athlete profile name (e.g. "Spicy") — only fall back to Strava
  // if we have no name yet.
  const existingName = (onboardingData.name as string | null) ?? currentUser?.name ?? null;
  const nameFromStrava = (athlete.firstname as string | null) || (athlete.username as string | null) || null;
  const resolvedName = existingName || nameFromStrava;

  // Extract city and state from Strava athlete profile for timezone confirmation step
  const stravaCity = (athlete.city as string | null) || null;
  const stravaState = (athlete.state as string | null) || null;

  // Update user with Strava tokens, timezone, and stats
  const updatedOnboardingData: Record<string, unknown> = {
    ...onboardingData,
    strava_connected: true,
    strava_stats: {
      all_run_totals: stats.all_run_totals,
      ytd_run_totals: stats.ytd_run_totals,
      recent_run_totals: stats.recent_run_totals,
    },
    // Store computed weekly analytics so onboarding/handle's stravaContext can use them
    // without re-querying activities. Computed below after the 8-week import.
    // These will be overwritten after the analytics block runs.
    ...(stravaCity ? { strava_city: stravaCity } : {}),
    ...(stravaState ? { strava_state: stravaState } : {}),
  };

  // Only advance to onboarding if the user is currently on awaiting_strava.
  // If they've already progressed past it (e.g. they texted during the Strava step
  // and handleStrava advanced them), leave the step as-is — overwriting it would
  // reset them backwards and repeat already-answered questions.
  const shouldAdvanceToSchedule = !alreadyOnboarded && currentUser?.onboarding_step === "awaiting_strava";

  const { data: user, error } = await supabase
    .from("users")
    .update({
      strava_athlete_id: athlete.id,
      strava_access_token: access_token,
      strava_refresh_token: refresh_token,
      strava_token_expires_at: new Date(expires_at * 1000).toISOString(),
      name: resolvedName,
      ...(shouldAdvanceToSchedule ? { onboarding_step: "onboarding" } : {}),
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

  // Synchronously import the last 8 weeks so current-week mileage AND the 6-week
  // average are accurate when initial_plan fires. The full 2-year history import
  // runs in the background for race history and deeper analytics.
  await importRecentActivities(user.id, access_token).catch((err) =>
    console.error("[strava-callback] recent activity import error:", err)
  );

  // Query 8 weeks of activity data from the DB (just synced above) for rich analytics.
  const eightWeeksAgo = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000).toISOString();
  const { data: activities8w } = await supabase
    .from("activities")
    .select("distance_meters, moving_time_seconds, elevation_gain, average_heartrate, start_date, activity_type, workout_type")
    .eq("user_id", user.id)
    .gte("start_date", eightWeeksAgo)
    .order("start_date", { ascending: true });

  // Only count running activity types — exclude cycling, swimming, etc.
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  const runs8w = (activities8w ?? []).filter(
    (a) => (a.distance_meters ?? 0) > 400 && RUN_TYPES.has(a.activity_type ?? "")
  );

  // --- Weekly breakdown ---
  const now = Date.now();
  // Bucket each run into one of 8 individual week slots (index 0 = most recent week)
  const weeklyMilesArr: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const a of runs8w) {
    const daysAgo = (now - new Date(a.start_date!).getTime()) / (1000 * 60 * 60 * 24);
    const weekIdx = Math.min(7, Math.floor(daysAgo / 7));
    weeklyMilesArr[weekIdx] += (a.distance_meters ?? 0) / 1609.34;
  }

  const recentWeeksMiles = weeklyMilesArr[0] + weeklyMilesArr[1]; // last 2 weeks
  const priorWeeksMiles = weeklyMilesArr[2] + weeklyMilesArr[3];  // prior 2 weeks

  // Use 4-week average (more representative of current fitness than 8-week)
  const last4WeeksMiles = weeklyMilesArr.slice(0, 4).reduce((s, m) => s + m, 0);
  const avgWeeklyMiles = runs8w.length > 0
    ? Math.round(last4WeeksMiles / 4)
    : null;

  // Trend: last 2 weeks vs prior 2 weeks (only meaningful if we have enough data)
  let mileageTrend: "building" | "steady" | "declining" | null = null;
  if (priorWeeksMiles > 5) {
    const ratio = recentWeeksMiles / priorWeeksMiles;
    mileageTrend = ratio > 1.12 ? "building" : ratio < 0.88 ? "declining" : "steady";
  }

  // Longest single run
  const longestRunMiles = runs8w.length > 0
    ? Math.max(...runs8w.map((a) => (a.distance_meters ?? 0) / 1609.34))
    : null;

  // Average runs per week (unique calendar weeks)
  const uniqueDays = new Set(runs8w.map((a) => (a.start_date ?? "").slice(0, 10)).filter(Boolean)).size;
  const avgRunsPerWeek = runs8w.length > 0 ? Math.round((uniqueDays / 8) * 10) / 10 : null;

  // Elevation (vert) — useful for trail/mountain runners
  const totalElevFt = runs8w.reduce((s, a) => s + (a.elevation_gain ?? 0) * 3.28084, 0);
  const avgElevFtPerRun = runs8w.length > 0 ? Math.round(totalElevFt / runs8w.length) : 0;


  // Persist weekly analytics into onboarding_data so onboarding/handle's stravaContext
  // can surface them to Claude without re-querying activities.
  if (avgWeeklyMiles != null) updatedOnboardingData.strava_avg_weekly_miles = avgWeeklyMiles;
  if (mileageTrend) updatedOnboardingData.strava_mileage_trend = mileageTrend;
  if (avgElevFtPerRun > 200) updatedOnboardingData.strava_avg_elev_ft_per_run = avgElevFtPerRun;
  if (longestRunMiles != null) updatedOnboardingData.strava_longest_run_miles = Math.round(longestRunMiles * 10) / 10;

  // Background imports run in after() so Vercel keeps the process alive after
  // the redirect response is sent. Plain fire-and-forget gets killed on response.
  after(async () => {
    try {
      // ~6 months of general activity history (1 page × 200) — enough for weekly
      // analytics (8-week lookback is the deepest we use).
      await importStravaActivities(user.id, access_token);
      // Races from the past 2 years — separate pass so Dean knows about older PRs
      // and races even if they fall outside the 6-month general window.
      await importRaceHistory(user.id, access_token);
    } catch (err) {
      console.error("[strava-callback] activity import error:", err);
    }
  });

  const firstName = user.name ? ` ${user.name}` : "";

  // Don't re-ask for training days if they were already captured during the conversation
  // before the user tapped the Strava link.
  const trainingDaysAlreadyKnown =
    Array.isArray(onboardingData.training_days) &&
    (onboardingData.training_days as string[]).length > 0;

  // Brief acknowledgment only — no question, no insight here.
  // For mid-onboarding users, onboarding/handle fires 2 seconds later and generates
  // a single rich message with the Strava context + next question, avoiding a double text.
  const smsMsg = alreadyOnboarded
    ? `Strava connected${firstName}! I'll pull in your training history and factor it into your plan going forward. Just keep doing what you're doing — I've got it from here.`
    : `Strava connected${firstName}! Give me a moment to pull in your history.`;

  await Promise.all([
    sendSMS(user.phone_number, smsMsg),
    supabase.from("conversations").insert({
      user_id: user.id,
      role: "assistant",
      content: smsMsg,
      message_type: "coach_response",
    }),
  ]);

  // For mid-onboarding users, automatically continue the conversation after Strava connects
  // so Dean picks up where he left off without the user having to text first.
  // Recent activities are already imported synchronously above — Claude has good context.
  if (!alreadyOnboarded) {
    const chatId = currentUser?.linq_chat_id as string | null;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    after(async () => {
      // Short delay so the Strava confirmation lands in the conversation first
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await fetch(`${appUrl}/api/onboarding/handle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user.id,
            message: "(strava connected)",
            ...(chatId ? { chatId } : {}),
          }),
        });
      } catch (err) {
        console.error("[strava-callback] onboarding continuation failed:", err);
      }
    });
  }

  // Redirect browser to confirmation page
  return NextResponse.redirect(
    `${process.env.NEXT_PUBLIC_APP_URL}/strava-connected`
  );
}

/** Build a DB row from a raw Strava activity object. */
function buildActivityRow(userId: string, activity: Record<string, unknown>) {
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
}

/** Upsert a list of raw Strava activities into the DB in chunks of 50. */
async function upsertActivities(userId: string, activities: Array<Record<string, unknown>>) {
  const rows = activities.map((a) => buildActivityRow(userId, a));
  const chunkSize = 50;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await supabase.from("activities").upsert(rows.slice(i, i + chunkSize), { onConflict: "strava_activity_id" });
  }
  return rows.length;
}

/**
 * Synchronously import the last 8 weeks of activities so that both current-week
 * mileage AND the 6-week average are accurate when initial_plan fires.
 * Fast — typically 1 API page (200 activities covers 8 weeks for any runner).
 */
async function importRecentActivities(userId: string, accessToken: string) {
  const eightWeeksAgo = Math.floor(Date.now() / 1000) - 56 * 24 * 60 * 60;
  const activities = await getAllActivities(accessToken, { after: eightWeeksAgo, maxPages: 1 });
  const count = await upsertActivities(userId, activities as Array<Record<string, unknown>>);
  console.log(`[strava-callback] synced ${count} recent activities for user ${userId}`);
}

/**
 * Background import of ~6 months of general activity history (1 page × 200).
 * Covers the 8-week lookback used for weekly analytics and fitness tier.
 */
async function importStravaActivities(userId: string, accessToken: string) {
  const sixMonthsAgo = Math.floor(Date.now() / 1000) - 180 * 24 * 60 * 60;
  const activities = await getAllActivities(accessToken, { after: sixMonthsAgo, maxPages: 1 });
  const count = await upsertActivities(userId, activities as Array<Record<string, unknown>>);
  console.log(`[strava-callback] imported ${count} recent activities for user ${userId}`);
}

/**
 * Import races (workout_type === 1) from the past 2 years.
 * Fetches up to 3 pages but only saves race-flagged activities, so DB impact
 * is minimal (most athletes race 4–12 times/year → ~8–24 rows).
 */
async function importRaceHistory(userId: string, accessToken: string) {
  const twoYearsAgo = Math.floor(Date.now() / 1000) - 2 * 365 * 24 * 60 * 60;
  const activities = await getAllActivities(accessToken, { after: twoYearsAgo, maxPages: 3 });
  const races = (activities as Array<Record<string, unknown>>).filter(
    (a) => (a.workout_type as number | null) === 1
  );
  const count = await upsertActivities(userId, races);
  console.log(`[strava-callback] imported ${count} races for user ${userId}`);
}
