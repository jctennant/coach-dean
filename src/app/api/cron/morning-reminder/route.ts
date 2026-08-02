import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const ALL_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Returns the active training days for a profile — override if valid, else standing schedule.
 * training_days is only ever populated when the athlete named specific days during onboarding
 * (common for Strava-connected athletes to leave it empty — see onboarding/handle/route.ts).
 * An empty list must not be read as "no training days" or every proactive_cadence opt-in from
 * a Strava user with unset training_days would silently never fire.
 */
function effectiveTrainingDays(
  trainingDays: string[],
  overrideDays: string[] | null,
  overrideExpires: string | null,
  todayDateStr: string
): string[] {
  if (overrideDays && overrideDays.length > 0 && overrideExpires && todayDateStr <= overrideExpires) {
    return overrideDays;
  }
  return trainingDays.length > 0 ? trainingDays : ALL_WEEKDAYS;
}

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
    .select("user_id, training_days, this_week_override_days, this_week_override_expires, last_morning_reminder_date, skip_dates, users!inner(timezone, onboarding_step, messaging_opted_out, strava_access_token)")
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
  const eighteenHoursAgo = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
  const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // ── First pass: identify which users need each type of conversation lookup.
  // We can determine this from the profile data (training days, timezones, skip dates)
  // without any additional DB queries.
  const mondayUserIds: string[] = [];
  const needsActivityCheckIds: string[] = [];

  for (const profile of profiles) {
    if (profile.last_morning_reminder_date === todayUTC) continue; // already deduped
    const user = profile.users as unknown as { timezone: string | null; strava_access_token: string | null };
    const tz = user.timezone || "America/New_York";

    // Only send during 6am–9am in the user's local timezone.
    // The cron runs every 2 hours so each user is caught in the right window.
    const localHour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now), 10) % 24;
    if (localHour < 6 || localHour >= 10) continue;

    const skipDates = (profile.skip_dates as string[]) || [];

    const todayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const trainingDays = effectiveTrainingDays(
      (profile.training_days as string[]) || [],
      profile.this_week_override_days as string[] | null,
      profile.this_week_override_expires as string | null,
      todayDateStr
    );

    const todayWeekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
    const todayDay = todayWeekday.toLowerCase();
    if (!trainingDays.includes(todayDay)) continue;

    if (skipDates.includes(todayDateStr)) continue;

    if (todayWeekday === "Monday") mondayUserIds.push(profile.user_id);

    const yesterdayDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
      .format(yesterday).toLowerCase();
    const yesterdayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(yesterday);
    if (trainingDays.includes(yesterdayDay) && !skipDates.includes(yesterdayDateStr)) {
      needsActivityCheckIds.push(profile.user_id);
    }
  }

  // ── Batch queries: one round-trip per time window instead of O(n) queries.
  const [recapRows, activityRows] = await Promise.all([
    mondayUserIds.length > 0
      ? supabase
          .from("conversations")
          .select("user_id")
          .in("user_id", mondayUserIds)
          .eq("message_type", "weekly_recap")
          .gte("created_at", eighteenHoursAgo)
      : Promise.resolve({ data: [] }),
    needsActivityCheckIds.length > 0
      ? supabase
          .from("conversations")
          .select("user_id")
          .in("user_id", needsActivityCheckIds)
          .or("message_type.eq.post_run,role.eq.user")
          .gte("created_at", thirtyHoursAgo)
      : Promise.resolve({ data: [] }),
  ]);

  const usersWithRecentRecap = new Set((recapRows.data || []).map((r) => r.user_id));
  const usersWithRecentActivity = new Set((activityRows.data || []).map((r) => r.user_id));

  // ── Main loop: now purely local decisions + one fetch + one DB update per user.
  let sent = 0;
  const tasks: Array<Promise<void>> = [];

  for (const profile of profiles) {
    const user = profile.users as unknown as { timezone: string | null; onboarding_step: string | null; strava_access_token: string | null };
    const tz = user.timezone || "America/New_York";

    // Skip if we already sent a reminder for this user today
    if (profile.last_morning_reminder_date === todayUTC) {
      console.log(`[morning-reminder] skipping ${profile.user_id} — already sent today (${todayUTC})`);
      continue;
    }

    // Only send during 6am–9am in the user's local timezone (checked again here to guard
    // against edge cases where the first-pass filter and main loop see different times).
    const localHour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now), 10) % 24;
    if (localHour < 6 || localHour >= 10) continue;

    // Skip Monday morning reminder if a weekly recap was sent last night (Sunday)
    const todayWeekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
    if (todayWeekday === "Monday" && usersWithRecentRecap.has(profile.user_id)) {
      console.log(`[morning-reminder] skipping ${profile.user_id} — weekly recap sent last night covers Monday`);
      continue;
    }

    const skipDates = (profile.skip_dates as string[]) || [];
    const todayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const trainingDays = effectiveTrainingDays(
      (profile.training_days as string[]) || [],
      profile.this_week_override_days as string[] | null,
      profile.this_week_override_expires as string | null,
      todayDateStr
    );

    const todayDay = todayWeekday.toLowerCase();
    if (!trainingDays.includes(todayDay)) continue;

    if (skipDates.includes(todayDateStr)) {
      console.log(`[morning-reminder] skipping ${profile.user_id} — ${todayDateStr} is a one-off skip`);
      continue;
    }

    let includeWorkoutCheckin = false;
    let missedRunCheckin = false;

    const yesterdayDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
      .format(yesterday).toLowerCase();
    const yesterdayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(yesterday);
    const hadWorkoutYesterday = trainingDays.includes(yesterdayDay) && !skipDates.includes(yesterdayDateStr);

    if (hadWorkoutYesterday && !usersWithRecentActivity.has(profile.user_id)) {
      if (user.strava_access_token) {
        missedRunCheckin = true;
      } else {
        includeWorkoutCheckin = true;
      }
    }

    tasks.push(
      (async () => {
        try {
          await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: profile.user_id,
              trigger: "morning_reminder",
              ...(includeWorkoutCheckin ? { includeWorkoutCheckin: true } : {}),
              ...(missedRunCheckin ? { missedRunCheckin: true } : {}),
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
      })()
    );
  }

  await Promise.allSettled(tasks);

  return NextResponse.json({ ok: true, sent });
}
