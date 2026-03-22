import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/cron/nightly-reminder
 * Runs daily at 02:00 UTC (6pm PST / 7pm PDT).
 * Sends a workout reminder to users who opted into nightly reminders and have a
 * training session scheduled for tomorrow.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Query users who opted into nightly reminders and have completed onboarding.
  // training_profiles.proactive_cadence = 'nightly_reminders'
  const { data: profiles, error } = await supabase
    .from("training_profiles")
    .select("user_id, training_days, last_nightly_reminder_date, skip_dates, users!inner(timezone, onboarding_step, messaging_opted_out, strava_access_token)")
    .eq("proactive_cadence", "nightly_reminders")
    .is("users.onboarding_step", null)
    .eq("users.messaging_opted_out", false);

  if (error) {
    console.error("[nightly-reminder] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!profiles || profiles.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  // Cron fires at 02:00 UTC (6pm PST). "Tomorrow" in Pacific time is the same
  // calendar day at 02:00 UTC, so just use the current UTC date + 1 day.
  const now = new Date();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const todayUTC = now.toISOString().slice(0, 10); // "YYYY-MM-DD" — dedup key

  // Skip nightly reminders on Sunday — the sunday-recap cron fires instead and
  // covers the full week including Monday's session.
  if (now.getUTCDay() === 0) {
    console.log("[nightly-reminder] Sunday — skipping, sunday-recap handles tonight");
    return NextResponse.json({ ok: true, sent: 0, skipped: "sunday_recap_day" });
  }

  let sent = 0;

  for (const profile of profiles) {
    const user = profile.users as unknown as { timezone: string | null; onboarding_step: string | null; strava_access_token: string | null };
    const tz = user.timezone || "America/New_York";
    const trainingDays = (profile.training_days as string[]) || [];

    // Skip if we already sent a reminder for this user today — guards against
    // Vercel cron retries and any double-fire scenarios.
    if (profile.last_nightly_reminder_date === todayUTC) {
      console.log(`[nightly-reminder] skipping ${profile.user_id} — already sent today (${todayUTC})`);
      continue;
    }

    // Find tomorrow's day name in the user's timezone
    const tomorrowWeekday = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
    }).format(tomorrow);
    const tomorrowDay = tomorrowWeekday.toLowerCase();

    // Only send if tomorrow is a scheduled training day
    if (!trainingDays.includes(tomorrowDay)) continue;

    // Skip if the user has marked tomorrow as a one-off skip
    const skipDates = (profile.skip_dates as string[]) || [];
    const tomorrowDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(tomorrow);
    if (skipDates.includes(tomorrowDateStr)) {
      console.log(`[nightly-reminder] skipping ${profile.user_id} — ${tomorrowDateStr} is a one-off skip`);
      continue;
    }

    // Determine whether to include a check-in on a workout.
    //
    // TODAY (non-Strava only): ask how it went since we have no data.
    //   Strava users are NOT checked for today — the nightly fires at ~6pm and many users
    //   run after work. "I didn't catch a run from you" at 6pm would fire before they head out.
    //
    // YESTERDAY (Strava only): for users who only get nightly reminders (no morning cron),
    //   the nightly is the only chance to follow up on a missed workout. By 6pm, yesterday
    //   is fully over and safe to call out. Uses a 40-hour lookback to cover any run time
    //   during the previous day.
    let includeWorkoutCheckin = false;
    let missedRunCheckin = false;

    const todayDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
      .format(now).toLowerCase();
    const todayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);

    if (!user.strava_access_token) {
      const hadWorkoutToday = trainingDays.includes(todayDay) && !skipDates.includes(todayDateStr);

      if (hadWorkoutToday) {
        const eighteenHoursAgo = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
        const { data: postRunMsg } = await supabase
          .from("conversations")
          .select("id")
          .eq("user_id", profile.user_id)
          .eq("message_type", "post_run")
          .gte("created_at", eighteenHoursAgo)
          .limit(1);
        if (!postRunMsg || postRunMsg.length === 0) {
          const { data: userMsgs } = await supabase
            .from("conversations")
            .select("id")
            .eq("user_id", profile.user_id)
            .eq("role", "user")
            .gte("created_at", eighteenHoursAgo)
            .limit(1);
          includeWorkoutCheckin = !userMsgs || userMsgs.length === 0;
        }
      }
    } else {
      // Strava user — check if yesterday was a training day with no run recorded.
      // 40-hour lookback covers any run time during the previous calendar day.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
        .format(yesterday).toLowerCase();
      const yesterdayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(yesterday);
      const hadWorkoutYesterday = trainingDays.includes(yesterdayDay) && !skipDates.includes(yesterdayDateStr);

      if (hadWorkoutYesterday) {
        const fortyHoursAgo = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
        const { data: postRunMsg } = await supabase
          .from("conversations")
          .select("id")
          .eq("user_id", profile.user_id)
          .eq("message_type", "post_run")
          .gte("created_at", fortyHoursAgo)
          .limit(1);
        const { data: userMsgs } = await supabase
          .from("conversations")
          .select("id")
          .eq("user_id", profile.user_id)
          .eq("role", "user")
          .gte("created_at", fortyHoursAgo)
          .limit(1);
        missedRunCheckin = (!postRunMsg || postRunMsg.length === 0) && (!userMsgs || userMsgs.length === 0);
      }
    }

    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: profile.user_id,
          trigger: "nightly_reminder",
          ...(includeWorkoutCheckin ? { includeWorkoutCheckin: true } : {}),
          ...(missedRunCheckin ? { missedRunCheckin: true } : {}),
        }),
      });
      // Mark as sent — prevents re-firing if cron retries today
      await supabase
        .from("training_profiles")
        .update({ last_nightly_reminder_date: todayUTC })
        .eq("user_id", profile.user_id);
      sent++;
    } catch (err) {
      console.error(`[nightly-reminder] failed for user ${profile.user_id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, sent });
}
