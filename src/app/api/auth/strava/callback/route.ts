import { NextResponse } from "next/server";
import { runAfter } from "@/lib/safe-after";
import { supabase } from "@/lib/supabase";
import { insertConversation } from "@/lib/conversations";
import { sendSMS } from "@/lib/linq";
import { getAllActivities, getAthleteStats, fetchAndStoreBestEfforts } from "@/lib/strava";
import { trackEvent } from "@/lib/track";
import type { Json } from "@/lib/database.types";
import { parseTimezoneFromLocation } from "@/lib/timezone";
import { estimateMaxHR } from "@/lib/hr-utils";
import { estimateLTHRFromRaces } from "@/lib/hr-zones";

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
  const urlScope = searchParams.get("scope"); // Strava includes granted scope in redirect URL

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
  const { access_token, refresh_token, expires_at, athlete, scope } = tokenData;
  // Strava sometimes omits `scope` from the token response body on re-auth.
  // Fall back to the scope param Strava always includes in the redirect URL.
  const effectiveScope = scope ?? urlScope ?? "";
  const hasWriteScope = typeof effectiveScope === "string" && effectiveScope.includes("activity:write");
  const hasReadScope = typeof effectiveScope === "string" && effectiveScope.includes("activity:read_all");
  console.log("[strava-callback] scope returned:", scope, "urlScope:", urlScope, "hasWriteScope:", hasWriteScope, "hasReadScope:", hasReadScope);

  // Derive timezone from athlete city/state — more reliable than athlete.timezone,
  // which reflects an account preference that users rarely update when they move.
  // Fall back to parsing athlete.timezone if no city is available.
  const athleteCity = (athlete.city as string | null) || null;
  const athleteState = (athlete.state as string | null) || null;
  let timezone: string | null = null;
  if (athleteCity) {
    const location = athleteState ? `${athleteCity}, ${athleteState}` : athleteCity;
    timezone = await parseTimezoneFromLocation(location);
  }
  if (!timezone && athlete.timezone) {
    const tzMatch = (athlete.timezone as string).match(/\)\s*(.+)$/);
    timezone = tzMatch ? tzMatch[1] : (athlete.timezone as string);
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

  // Fetch current user state to merge onboarding_data and check if already onboarded.
  // Also fetch strava_access_token so we can detect re-auth flows and skip the
  // "Strava connected" welcome message when Strava was already connected.
  const { data: currentUser } = await supabase
    .from("users")
    .select("onboarding_data, onboarding_step, name, linq_chat_id, strava_access_token")
    .eq("id", userId)
    .single();

  const onboardingData =
    (currentUser?.onboarding_data as Record<string, unknown>) || {};
  const alreadyOnboarded = currentUser?.onboarding_step === null;
  // If Strava was already connected (token existed before this callback), skip
  // the welcome message — it's a re-auth and the user knows Strava is connected.
  // This prevents the "Strava connected" message from firing on every re-auth click.
  const stravaWasAlreadyConnected = !!currentUser?.strava_access_token;

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
      strava_write_enabled: hasWriteScope,
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
  void trackEvent(user.id, "strava_connected", { during_onboarding: !alreadyOnboarded });

  // Persist preferred_units to training_profiles (upsert in case row doesn't exist yet).
  // This is fire-and-forget — a failure here doesn't block the flow.
  void supabase
    .from("training_profiles")
    .upsert({ user_id: user.id, preferred_units: preferredUnits, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  // Synchronously import the last 8 weeks so current-week mileage AND the 6-week
  // average are accurate when initial_plan fires. The full 2-year history import
  // runs in the background for race history and deeper analytics.
  // Skip entirely if the user didn't grant activity:read_all — API calls would fail.
  if (hasReadScope) {
    await importRecentActivities(user.id, access_token).catch((err) =>
      console.error("[strava-callback] recent activity import error:", err)
    );
  }

  // Query activity data from the DB (just synced above) for rich analytics. Fetches 9 weeks
  // back so that 8 full completed calendar weeks (weeks 1-8) are resolvable in the breakdown
  // below — the 8th completed week wouldn't be fully covered by an 8-week-back fetch, since
  // day 56 falls partway through it.
  const nineWeeksAgo = new Date(Date.now() - 63 * 24 * 60 * 60 * 1000).toISOString();
  const { data: activities8w } = await supabase
    .from("activities")
    .select("distance_meters, moving_time_seconds, elevation_gain, average_heartrate, max_heartrate, start_date, activity_type, workout_type, activity_name")
    .eq("user_id", user.id)
    .gte("start_date", nineWeeksAgo)
    .order("start_date", { ascending: true });

  // Only count running activity types — exclude cycling, swimming, etc.
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  const runs8w = (activities8w ?? []).filter(
    (a) => (a.distance_meters ?? 0) > 400 && RUN_TYPES.has(a.activity_type ?? "")
  );

  // --- Weekly breakdown (calendar-week aligned, Monday boundaries in UTC) ---
  // Using calendar weeks avoids rolling-window misalignment: a Sunday evening connect
  // with a full Mon–Sat training week would otherwise put that whole week in slot 0
  // (excluded as "partial"), pulling in an older week instead.
  // Week 0 = current (possibly partial) calendar week; weeks 1–8 = last 8 complete weeks
  // (the fetch above goes back 9 weeks so week 8 is fully resolvable, not truncated).
  const now = Date.now();
  const nowDate = new Date(now);
  const dayOfWeekUTC = nowDate.getUTCDay(); // 0=Sun, 1=Mon...
  const daysSinceMondayUTC = (dayOfWeekUTC + 6) % 7; // 0 on Mon, 6 on Sun
  const currentWeekStartMs = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate() - daysSinceMondayUTC
  );
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;

  const weeklyMilesArr: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const a of runs8w) {
    const runTime = new Date(a.start_date!).getTime();
    let weekIdx: number;
    if (runTime >= currentWeekStartMs) {
      weekIdx = 0; // Current (possibly partial) calendar week
    } else {
      // ceil maps: [Mon-1 to Mon) → 1, [Mon-2 to Mon-1) → 2, etc.
      weekIdx = Math.min(8, Math.ceil((currentWeekStartMs - runTime) / msPerWeek));
    }
    weeklyMilesArr[weekIdx] += (a.distance_meters ?? 0) / 1609.34;
  }

  // Skip slot 0 (current partial calendar week). Use weeks 1–4 for a stable baseline.
  const recentWeeksMiles = weeklyMilesArr[1] + weeklyMilesArr[2]; // weeks 1–2 (completed)
  const priorWeeksMiles = weeklyMilesArr[3] + weeklyMilesArr[4];  // weeks 3–4 (completed)

  // Use 4-week average over completed calendar weeks 1–4
  const last4WeeksMiles = weeklyMilesArr.slice(1, 5).reduce((s, m) => s + m, 0);
  const avgWeeklyMiles = runs8w.length > 0
    ? Math.round(last4WeeksMiles / 4)
    : null;

  // Trend: completed weeks 1–2 vs completed weeks 3–4
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

  // Recent 8 completed weeks, most-recent first (weeks 1–8 from weeklyMilesArr) — matches the
  // "last 8 weeks" language already used in the post-connect SMS, and gives the plan generator
  // (estimateCurrentWeeklyMileage) enough history to see a longer injury pause/rebuild than a
  // 4-week window could (see the 2026-08-03 changelog on Jake's case, which only needed 4 weeks
  // but flagged this as worth widening).
  // Round to 1 decimal for readability. Only store if we have meaningful data.
  const recentWeeks = weeklyMilesArr.slice(1, 9).map((m) => Math.round(m * 10) / 10);
  const hasRecentData = recentWeeks.some((m) => m > 0);

  // HR zone distribution — requires max_heartrate per activity.
  // Use estimateMaxHR to get a spike-filtered max, then bucket each run by avg HR %.
  const estimatedMaxHR = estimateMaxHR(
    runs8w.map((a) => ({
      activity_type: a.activity_type,
      workout_type: a.workout_type ?? null,
      average_heartrate: a.average_heartrate ?? null,
      max_heartrate: (a as { max_heartrate?: number | null }).max_heartrate ?? null,
    }))
  );
  if (estimatedMaxHR != null) {
    const zoneCounts = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
    let runsWithHR = 0;
    for (const run of runs8w) {
      if (!run.average_heartrate) continue;
      runsWithHR++;
      const pct = run.average_heartrate / estimatedMaxHR;
      if (pct < 0.60) zoneCounts.z1++;
      else if (pct < 0.75) zoneCounts.z2++;
      else if (pct < 0.85) zoneCounts.z3++;
      else if (pct < 0.92) zoneCounts.z4++;
      else zoneCounts.z5++;
    }
    if (runsWithHR >= 3) {
      updatedOnboardingData.strava_hr_zone_pct = {
        z1: Math.round((zoneCounts.z1 / runsWithHR) * 100),
        z2: Math.round((zoneCounts.z2 / runsWithHR) * 100),
        z3: Math.round((zoneCounts.z3 / runsWithHR) * 100),
        z4: Math.round((zoneCounts.z4 / runsWithHR) * 100),
        z5: Math.round((zoneCounts.z5 / runsWithHR) * 100),
      };
      updatedOnboardingData.strava_estimated_max_hr = Math.round(estimatedMaxHR);
    }
  }

  // LTHR estimation from race history
  const lthrResult = estimateLTHRFromRaces(
    runs8w.map(a => ({
      workout_type: a.workout_type ?? null,
      average_heartrate: a.average_heartrate ?? null,
      moving_time_seconds: a.moving_time_seconds ?? null,
      activity_name: (a as { activity_name?: string | null }).activity_name ?? null,
      start_date: a.start_date ?? null,
    })),
    estimatedMaxHR ?? null
  );
  if (lthrResult) {
    updatedOnboardingData.strava_lthr_estimate = lthrResult.lthr;
    updatedOnboardingData.strava_lthr_source = lthrResult.source;
    updatedOnboardingData.strava_lthr_confidence = lthrResult.confidence;
  }

  // Persist the tiered max HR estimate to training_profiles so the coach,
  // dashboard, and longitudinal analytics share one value (rather than each
  // recomputing — which can diverge if filtering changes).
  if (estimatedMaxHR != null) {
    await supabase
      .from("training_profiles")
      .update({
        max_hr_estimate: Math.round(estimatedMaxHR),
        max_hr_estimate_updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);
  }

  // Mileage spike detection — largest week-over-week increase in the 4-week window.
  // Recent-to-older: completedWeeks[0] = last week, [1] = 2 weeks ago, etc.
  const completedWeeks = weeklyMilesArr.slice(1, 5);
  let maxSpikePct = 0;
  for (let i = 0; i < completedWeeks.length - 1; i++) {
    const olderWeek = completedWeeks[i + 1];
    const newerWeek = completedWeeks[i];
    if (olderWeek > 3) {
      const spike = (newerWeek - olderWeek) / olderWeek;
      if (spike > maxSpikePct) maxSpikePct = spike;
    }
  }
  if (maxSpikePct > 0.10) {
    updatedOnboardingData.strava_max_weekly_spike_pct = Math.round(maxSpikePct * 100);
  }

  // Long run as % of weekly volume — signals training polarization / balance
  if (longestRunMiles != null && avgWeeklyMiles != null && avgWeeklyMiles > 0) {
    updatedOnboardingData.strava_long_run_pct = Math.round((longestRunMiles / avgWeeklyMiles) * 100);
  }

  // Most recent run date — flag inactivity gaps that affect training plan timing
  if (runs8w.length > 0) {
    const mostRecent = runs8w.reduce((a, b) =>
      new Date(a.start_date!).getTime() > new Date(b.start_date!).getTime() ? a : b
    );
    updatedOnboardingData.strava_days_since_last_run = Math.round(
      (Date.now() - new Date(mostRecent.start_date!).getTime()) / (24 * 60 * 60 * 1000)
    );
  }

  // Easy pace trend — compare avg pace of Z2 runs in older 4 weeks vs. newer 4 weeks.
  // Uses estimated max HR to isolate aerobic-effort runs for a consistent comparison.
  if (estimatedMaxHR != null) {
    const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
    const z2Runs = runs8w.filter(r => {
      if (!r.average_heartrate || !r.distance_meters || !r.moving_time_seconds) return false;
      if ((r.distance_meters ?? 0) < 800) return false;
      const pct = r.average_heartrate / estimatedMaxHR;
      return pct >= 0.60 && pct < 0.75;
    });
    const olderZ2 = z2Runs.filter(r => new Date(r.start_date!) < fourWeeksAgo);
    const newerZ2 = z2Runs.filter(r => new Date(r.start_date!) >= fourWeeksAgo);
    const avgPaceSPM = (runs: typeof z2Runs): number | null => {
      if (!runs.length) return null;
      return runs.reduce((s, r) =>
        s + r.moving_time_seconds! / (r.distance_meters! / 1609.34), 0
      ) / runs.length;
    };
    const olderPace = avgPaceSPM(olderZ2);
    const newerPace = avgPaceSPM(newerZ2);
    if (olderPace != null && newerPace != null) {
      const ratio = newerPace / olderPace;
      const trend = ratio < 0.97 ? "improving" : ratio > 1.03 ? "declining" : "steady";
      updatedOnboardingData.strava_easy_pace_trend = trend;
      const deltaSec = Math.round(Math.abs(olderPace - newerPace));
      if (deltaSec >= 5) updatedOnboardingData.strava_easy_pace_trend_delta_sec = deltaSec;
    }
  }

  // Recent races from 8-week window — activity_name + workout_type:1 from Strava
  const formatRaceTime = (secs: number): string => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.round(secs % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  };
  const races8w = runs8w
    .filter(r => r.workout_type === 1 && (r.distance_meters ?? 0) > 400)
    .sort((a, b) => new Date(b.start_date!).getTime() - new Date(a.start_date!).getTime())
    .slice(0, 3)
    .map(r => ({
      name: r.activity_name ?? "Race",
      date: r.start_date?.slice(0, 10) ?? "",
      distance_km: Math.round((r.distance_meters ?? 0) / 100) / 10,
      time_str: formatRaceTime(r.moving_time_seconds ?? 0),
    }));
  if (races8w.length > 0) updatedOnboardingData.strava_recent_races = races8w;

  // Write analytics into onboarding_data. This is a second DB update — analytics depend
  // on importRecentActivities (line ~170), which runs after the first update at line ~136.
  if (avgWeeklyMiles != null) updatedOnboardingData.strava_avg_weekly_miles = avgWeeklyMiles;
  if (mileageTrend) updatedOnboardingData.strava_mileage_trend = mileageTrend;
  if (avgElevFtPerRun > 200) updatedOnboardingData.strava_avg_elev_ft_per_run = avgElevFtPerRun;
  if (longestRunMiles != null) updatedOnboardingData.strava_longest_run_miles = Math.round(longestRunMiles * 10) / 10;
  if (avgRunsPerWeek != null) updatedOnboardingData.strava_avg_runs_per_week = avgRunsPerWeek;
  if (hasRecentData) updatedOnboardingData.strava_recent_weeks = recentWeeks;

  await supabase
    .from("users")
    .update({ onboarding_data: updatedOnboardingData as unknown as Json })
    .eq("id", user.id);

  // Background imports run in after() so Vercel keeps the process alive after
  // the redirect response is sent. Plain fire-and-forget gets killed on response.
  // Skip if the user didn't grant activity:read_all — API calls would fail.
  if (hasReadScope) {
    runAfter("strava-callback/import", async () => {
      try {
        // ~6 months of general activity history (1 page × 200) — enough for weekly
        // analytics (8-week lookback is the deepest we use).
        await importStravaActivities(user.id, access_token);
        // Races from the past 2 years — separate pass so Dean knows about older PRs
        // and races even if they fall outside the 6-month general window.
        await importRaceHistory(user.id, access_token);
        // Fetch best_efforts + activity_name for all imported activities by calling
        // the detail endpoint for each. This is the only way to get Strava's lifetime
        // best-effort data — it's not included in list responses.
        await fetchAndStoreBestEfforts(user.id, access_token);
      } catch (err) {
        console.error("[strava-callback] activity import error:", err);
      }
    });
  }

  const _nameRaw = user.name && user.name.toLowerCase() !== "athlete" ? user.name : null;
  const firstName = _nameRaw ? ` ${_nameRaw}` : "";

  // Don't re-ask for training days if they were already captured during the conversation
  // before the user tapped the Strava link.
  const trainingDaysAlreadyKnown =
    Array.isArray(onboardingData.training_days) &&
    (onboardingData.training_days as string[]).length > 0;

  // Brief acknowledgment that names what Dean just read — the "magic moment" of the
  // product. We surface 8-week analytics computed above (avg weekly miles, longest run,
  // trend direction) so the athlete sees Dean responding to their actual data, not a
  // generic confirmation.
  // For mid-onboarding users, onboarding/handle fires 2 seconds later and generates
  // a single rich message with the Strava context + next question, avoiding a double text.
  const stravaSyncedDetails = (() => {
    const parts: string[] = [];
    if (avgWeeklyMiles != null && avgWeeklyMiles > 0) {
      parts.push(preferredUnits === "metric"
        ? `~${Math.round(avgWeeklyMiles * 1.60934)} km/week avg`
        : `~${avgWeeklyMiles} mi/week avg`);
    }
    if (longestRunMiles != null && longestRunMiles > 0) {
      parts.push(preferredUnits === "metric"
        ? `longest ${(longestRunMiles * 1.60934).toFixed(1)} km`
        : `longest ${longestRunMiles.toFixed(1)} mi`);
    }
    if (mileageTrend === "building") parts.push("trending up");
    else if (mileageTrend === "declining") parts.push("backed off recently");
    return parts.length > 0 ? parts.join(", ") : null;
  })();
  const smsMsg = alreadyOnboarded
    ? (stravaSyncedDetails
        ? `Strava connected${firstName}! Just read your last 8 weeks — ${stravaSyncedDetails}. I'll factor it all into your coaching going forward.`
        : `Strava connected${firstName}! I'll pull in your training history and factor it into your plan going forward. Just keep doing what you're doing — I've got it from here.`)
    : (stravaSyncedDetails
        ? `Strava connected${firstName}! Just read your last 8 weeks — ${stravaSyncedDetails}.`
        : `Strava connected${firstName}!`);

  // Only send "Strava connected" the first time — skip on re-auth flows where
  // the token was already present. This prevents duplicate messages when users
  // click the Strava button multiple times or re-authorize for write scope.
  if (!stravaWasAlreadyConnected) {
    await Promise.all([
      sendSMS(user.phone_number, smsMsg),
      insertConversation({
        user_id: user.id,
        role: "assistant",
        content: smsMsg,
        message_type: "coach_response",
      }),
    ]);
  } else {
    console.log(`[strava-callback] strava was already connected for user ${user.id}, skipping welcome SMS`);
  }

  // If the user unchecked "View activity data", Dean can't see their runs.
  // Send a follow-up explaining what's broken and how to fix it.
  if (!hasReadScope) {
    const reconnectUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
    const noReadMsg = `One thing — it looks like you unchecked "View activity data" when authorizing. Without that, I can't see your runs or calibrate your training zones. To fix it, reconnect here and make sure that box is checked:\n\n${reconnectUrl}`;
    await Promise.all([
      sendSMS(user.phone_number, noReadMsg),
      insertConversation({
        user_id: user.id,
        role: "assistant",
        content: noReadMsg,
        message_type: "coach_response",
      }),
    ]);
  }

  // For mid-onboarding users, automatically continue the conversation after Strava connects
  // so Dean picks up where he left off without the user having to text first.
  // Recent activities are already imported synchronously above — Claude has good context.
  //
  // Note: the injury question and (when Strava has no day-level data) the training-days
  // question both live inside handleDataAnalysis / the goals-stage Sonnet prompt as
  // context-dependent, personalized text — not fixed deterministic prompts — so they're
  // not good poll candidates without either stripping a question out of Sonnet-generated
  // text (fragile) or double-asking. Only the goal question (asked deterministically in
  // handleConversation before a name is known) gets a poll for now — see polls.ts.
  if (!alreadyOnboarded) {
    const chatId = currentUser?.linq_chat_id as string | null;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    runAfter("strava-callback/onboarding-continue", async () => {
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
    // Historical import, not a live upload — stamp it as already handled so the post-run
    // batch collector (src/lib/post-run-batch.ts) never sweeps an athlete's whole back
    // catalogue into a coaching message the first time they log a run after connecting.
    post_run_coached_at: new Date().toISOString(),
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
 * Import all races (workout_type === 1) from the athlete's full Strava history.
 * No time limit — races are the most valuable source of best_efforts and VDOT data.
 * Fetches up to 50 pages (10,000 activities) which covers any realistic history.
 * Only race-flagged activities are saved, so DB impact is minimal
 * (most athletes race 4–12 times/year → well under 200 rows total).
 */
async function importRaceHistory(userId: string, accessToken: string) {
  const activities = await getAllActivities(accessToken, { maxPages: 50 });
  const races = (activities as Array<Record<string, unknown>>).filter(
    (a) => (a.workout_type as number | null) === 1
  );
  const count = await upsertActivities(userId, races);
  console.log(`[strava-callback] imported ${count} all-time races for user ${userId}`);
}
