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
    .select("user_id, training_days, last_nightly_reminder_date, users!inner(timezone, onboarding_step, messaging_opted_out)")
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
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const todayUTC = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" — dedup key
  let sent = 0;

  for (const profile of profiles) {
    const user = profile.users as unknown as { timezone: string | null; onboarding_step: string | null };
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

    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: profile.user_id,
          trigger: "nightly_reminder",
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
