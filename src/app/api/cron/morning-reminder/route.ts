import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/cron/morning-reminder
 * Runs daily at 14:00 UTC (6am PST / 7am MDT / 8am CST / 9am EST).
 * Sends a morning workout reminder to users who opted into morning reminders
 * and have a training session scheduled for today.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profiles, error } = await supabase
    .from("training_profiles")
    .select("user_id, training_days, last_morning_reminder_date, skip_dates, users!inner(timezone, onboarding_step, messaging_opted_out, strava_access_token)")
    .eq("proactive_cadence", "morning_reminders")
    .is("users.onboarding_step", null)
    .eq("users.messaging_opted_out", false);

  if (error) {
    console.error("[morning-reminder] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!profiles || profiles.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10); // dedup key
  let sent = 0;

  for (const profile of profiles) {
    const user = profile.users as unknown as { timezone: string | null; onboarding_step: string | null; strava_access_token: string | null };
    const tz = user.timezone || "America/New_York";
    const trainingDays = (profile.training_days as string[]) || [];

    // Skip if we already sent a reminder for this user today
    if (profile.last_morning_reminder_date === todayUTC) {
      console.log(`[morning-reminder] skipping ${profile.user_id} — already sent today (${todayUTC})`);
      continue;
    }

    // Find today's day name in the user's timezone
    const todayWeekday = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
    }).format(now);
    const todayDay = todayWeekday.toLowerCase();

    // Only send if today is a scheduled training day
    if (!trainingDays.includes(todayDay)) continue;

    // Skip if the user has marked today as a one-off skip
    const skipDates = (profile.skip_dates as string[]) || [];
    const todayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    if (skipDates.includes(todayDateStr)) {
      console.log(`[morning-reminder] skipping ${profile.user_id} — ${todayDateStr} is a one-off skip`);
      continue;
    }

    // Determine whether to include a check-in on yesterday's workout.
    // Only for users without Strava (Strava users get post-run feedback via webhook).
    // Skip if: Strava is connected, yesterday wasn't a training day, yesterday was a skip,
    // or the user already messaged about their workout (post_run or any inbound user_message
    // in the last 30 hours — means they already reported in).
    let includeWorkoutCheckin = false;
    if (!user.strava_access_token) {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
        .format(yesterday).toLowerCase();
      const yesterdayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(yesterday);
      const hadWorkoutYesterday = trainingDays.includes(yesterdayDay) && !skipDates.includes(yesterdayDateStr);

      if (hadWorkoutYesterday) {
        const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
        const { data: recentMsgs } = await supabase
          .from("conversations")
          .select("id")
          .eq("user_id", profile.user_id)
          .in("message_type", ["post_run", "user_message"])
          .gte("created_at", thirtyHoursAgo)
          .limit(1);
        // Only check in if there's been no post_run feedback AND no inbound message from the user
        const noRecentActivity = !recentMsgs || recentMsgs.length === 0;
        // user_message rows include both sent and received — filter to athlete's own messages
        // by checking role = 'user'
        if (noRecentActivity) {
          const { data: userMsgs } = await supabase
            .from("conversations")
            .select("id")
            .eq("user_id", profile.user_id)
            .eq("role", "user")
            .gte("created_at", thirtyHoursAgo)
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
          trigger: "morning_reminder",
          ...(includeWorkoutCheckin ? { includeWorkoutCheckin: true } : {}),
        }),
      });

      await supabase
        .from("training_profiles")
        .update({ last_morning_reminder_date: todayUTC })
        .eq("user_id", profile.user_id);

      sent++;
    } catch (err) {
      console.error(`[morning-reminder] failed for user ${profile.user_id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, sent });
}
