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
    .select("user_id, training_days, last_morning_reminder_date, skip_dates, users!inner(timezone, onboarding_step, messaging_opted_out)")
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
    const user = profile.users as unknown as { timezone: string | null; onboarding_step: string | null };
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
    const todayDateStr = now.toISOString().slice(0, 10);
    if (skipDates.includes(todayDateStr)) {
      console.log(`[morning-reminder] skipping ${profile.user_id} — ${todayDateStr} is a one-off skip`);
      continue;
    }

    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: profile.user_id, trigger: "morning_reminder" }),
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
