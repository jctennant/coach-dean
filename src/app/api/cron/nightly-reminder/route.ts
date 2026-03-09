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

    // Determine whether to include a check-in on today's workout.
    // Only for users without Strava (Strava users get post-run feedback via webhook).
    // Skip if today wasn't a training day, today was a skip, or the user already
    // messaged about their workout (post_run or any inbound user_message in the last 18 hours).
    let includeWorkoutCheckin = false;
    if (!user.strava_access_token) {
      const todayDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
        .format(now).toLowerCase();
      const todayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
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
          // Also check if the athlete already texted in about their workout today
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
    }

    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: profile.user_id,
          trigger: "nightly_reminder",
          ...(includeWorkoutCheckin ? { includeWorkoutCheckin: true } : {}),
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
