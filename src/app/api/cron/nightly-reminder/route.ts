import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * GET /api/cron/nightly-reminder
 * Runs hourly 00:00–06:00 UTC, covering 8pm in all US timezones (EDT through HST).
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
    .select("user_id, training_days, users!inner(timezone, onboarding_step)")
    .eq("proactive_cadence", "nightly_reminders")
    .is("users.onboarding_step", null);

  if (error) {
    console.error("[nightly-reminder] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!profiles || profiles.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  const now = new Date();
  let sent = 0;

  for (const profile of profiles) {
    const user = profile.users as unknown as { timezone: string | null; onboarding_step: string | null };
    const tz = user.timezone || "America/New_York";
    const trainingDays = (profile.training_days as string[]) || [];

    // Check if it is currently the 8pm hour (20:xx) in the user's timezone
    const localHour = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }).format(now);

    if (parseInt(localHour, 10) !== 20) continue;

    // Find tomorrow's day name in the user's timezone
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
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
      sent++;
    } catch (err) {
      console.error(`[nightly-reminder] failed for user ${profile.user_id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, sent });
}
