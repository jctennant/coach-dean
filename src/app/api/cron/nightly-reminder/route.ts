import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { localTomorrowNoon } from "@/lib/cron-utils";

/** Returns the active training days for a profile — override if valid, else standing schedule. */
function effectiveTrainingDays(
  trainingDays: string[],
  overrideDays: string[] | null,
  overrideExpires: string | null,
  todayDateStr: string
): string[] {
  if (overrideDays && overrideDays.length > 0 && overrideExpires && todayDateStr <= overrideExpires) {
    return overrideDays;
  }
  return trainingDays;
}


/**
 * GET /api/cron/nightly-reminder
 * Runs every 2 hours. Sends a workout reminder to users who opted into nightly reminders,
 * have a training session scheduled for tomorrow, and are currently between 8pm–10pm local.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Disabled in v2.0 — nightly reminders replaced by reactive post-run analysis.
  // Preserved for potential reactivation. Remove this block to re-enable.
  // Cast to boolean so TypeScript doesn't treat the rest of the function as dead code.
  if (true as boolean) return NextResponse.json({ ok: true, sent: 0, disabled: true });

  // Query users who opted into nightly reminders and have completed onboarding.
  // training_profiles.proactive_cadence = 'nightly_reminders'
  const { data: profiles, error } = await supabase
    .from("training_profiles")
    .select("user_id, training_days, this_week_override_days, this_week_override_expires, last_nightly_reminder_date, skip_dates, users!inner(timezone, onboarding_step, messaging_opted_out, strava_access_token)")
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

  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10); // "YYYY-MM-DD" — dedup key

  // Skip nightly reminders on Sunday — the sunday-recap cron fires instead and
  // covers the full week including Monday's session.
  if (now.getUTCDay() === 0) {
    console.log("[nightly-reminder] Sunday — skipping, sunday-recap handles tonight");
    return NextResponse.json({ ok: true, sent: 0, skipped: "sunday_recap_day" });
  }

  const eighteenHoursAgo = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
  const fortyHoursAgo = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // ── First pass: identify which users need conversation lookups — no DB calls.
  const needsCheckinTodayIds: string[] = [];  // non-Strava users with a workout today
  const needsMissedRunIds: string[] = [];     // Strava users with a workout yesterday

  for (const profile of profiles) {
    if (profile.last_nightly_reminder_date === todayUTC) continue;
    const user = profile.users as unknown as { timezone: string | null; strava_access_token: string | null };
    const tz = user.timezone || "America/New_York";

    // Only send during 8pm–10pm in the user's local timezone.
    // The cron runs every 2 hours so each user is caught in their correct window.
    const localHour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now), 10) % 24;
    if (localHour < 20 || localHour >= 22) continue;

    const skipDates = (profile.skip_dates as string[]) || [];
    const todayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const trainingDays = effectiveTrainingDays(
      (profile.training_days as string[]) || [],
      profile.this_week_override_days as string[] | null,
      profile.this_week_override_expires as string | null,
      todayDateStr
    );

    // Use local-date-based tomorrow so the correct weekday is computed regardless of
    // which UTC hour the cron fires (8-9pm local often crosses UTC midnight).
    const tomorrowDate = localTomorrowNoon(now, tz);
    const tomorrowWeekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(tomorrowDate);
    if (!trainingDays.includes(tomorrowWeekday.toLowerCase())) continue;
    const tomorrowDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(tomorrowDate);
    if (skipDates.includes(tomorrowDateStr)) continue;

    if (!user.strava_access_token) {
      const todayDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now).toLowerCase();
      if (trainingDays.includes(todayDay) && !skipDates.includes(todayDateStr)) {
        needsCheckinTodayIds.push(profile.user_id);
      }
    } else {
      const yesterdayDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(yesterday).toLowerCase();
      const yesterdayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(yesterday);
      if (trainingDays.includes(yesterdayDay) && !skipDates.includes(yesterdayDateStr)) {
        needsMissedRunIds.push(profile.user_id);
      }
    }
  }

  // ── Batch queries: 2 round-trips instead of O(n).
  const [checkinRows, missedRunRows] = await Promise.all([
    needsCheckinTodayIds.length > 0
      ? supabase
          .from("conversations")
          .select("user_id")
          .in("user_id", needsCheckinTodayIds)
          .or("message_type.eq.post_run,role.eq.user")
          .gte("created_at", eighteenHoursAgo)
      : Promise.resolve({ data: [] }),
    needsMissedRunIds.length > 0
      ? supabase
          .from("conversations")
          .select("user_id")
          .in("user_id", needsMissedRunIds)
          .or("message_type.eq.post_run,role.eq.user")
          .gte("created_at", fortyHoursAgo)
      : Promise.resolve({ data: [] }),
  ]);

  const usersWithRecentCheckinActivity = new Set((checkinRows.data || []).map((r) => r.user_id));
  const usersWithRecentMissedRunActivity = new Set((missedRunRows.data || []).map((r) => r.user_id));

  // ── Main loop: purely local decisions + one fetch + one DB update per user.
  let sent = 0;
  const tasks: Array<Promise<void>> = [];

  for (const profile of profiles) {
    const user = profile.users as unknown as { timezone: string | null; onboarding_step: string | null; strava_access_token: string | null };
    const tz = user.timezone || "America/New_York";

    if (profile.last_nightly_reminder_date === todayUTC) {
      console.log(`[nightly-reminder] skipping ${profile.user_id} — already sent today (${todayUTC})`);
      continue;
    }

    // Only send during 8pm–10pm in the user's local timezone.
    const localHour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now), 10) % 24;
    if (localHour < 20 || localHour >= 22) continue;

    const skipDates = (profile.skip_dates as string[]) || [];
    const todayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const trainingDays = effectiveTrainingDays(
      (profile.training_days as string[]) || [],
      profile.this_week_override_days as string[] | null,
      profile.this_week_override_expires as string | null,
      todayDateStr
    );

    const tomorrowDate = localTomorrowNoon(now, tz);
    const tomorrowWeekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(tomorrowDate);
    const tomorrowDay = tomorrowWeekday.toLowerCase();
    if (!trainingDays.includes(tomorrowDay)) continue;

    const tomorrowDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(tomorrowDate);
    if (skipDates.includes(tomorrowDateStr)) {
      console.log(`[nightly-reminder] skipping ${profile.user_id} — ${tomorrowDateStr} is a one-off skip`);
      continue;
    }

    let includeWorkoutCheckin = false;
    let missedRunCheckin = false;

    if (!user.strava_access_token) {
      // Non-Strava: check if we should ask how today's workout went
      if (needsCheckinTodayIds.includes(profile.user_id) && !usersWithRecentCheckinActivity.has(profile.user_id)) {
        includeWorkoutCheckin = true;
      }
    } else {
      // Strava: check if yesterday was a training day with no run recorded
      if (needsMissedRunIds.includes(profile.user_id) && !usersWithRecentMissedRunActivity.has(profile.user_id)) {
        missedRunCheckin = true;
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
              trigger: "nightly_reminder",
              ...(includeWorkoutCheckin ? { includeWorkoutCheckin: true } : {}),
              ...(missedRunCheckin ? { missedRunCheckin: true } : {}),
            }),
          });
          await supabase
            .from("training_profiles")
            .update({ last_nightly_reminder_date: todayUTC })
            .eq("user_id", profile.user_id);
          sent++;
        } catch (err) {
          console.error(`[nightly-reminder] failed for user ${profile.user_id}:`, err);
        }
      })()
    );
  }

  await Promise.allSettled(tasks);

  return NextResponse.json({ ok: true, sent });
}
