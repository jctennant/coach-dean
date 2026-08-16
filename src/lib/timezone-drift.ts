/**
 * Detects when an athlete has relocated and their stored timezone has gone stale.
 *
 * `users.timezone` is captured once (from Strava at connect, or from the city they give
 * during onboarding) and never revisited. Every proactive message is scheduled against it
 * and every "today"/"yesterday" boundary is computed from it, so once it's wrong the athlete
 * gets nightly reminders in the middle of their afternoon and post-run messages that name
 * the wrong day.
 *
 * Observed 2026-08-16: an athlete travelling in Europe with America/Denver still on file was
 * texted at 12:51am and 1:17am her stored local time across consecutive days, and her
 * activities read as 2am walks.
 *
 * Strava's detailed activity payload reports the zone each activity was recorded in, so the
 * signal is already arriving on every webhook — it was just being discarded. The only real
 * design question is how eager to be about acting on it, since flipping an athlete's
 * schedule on a single data point would mean a weekend race out of state silently moves
 * their reminders. Hence the agreement requirement below.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How many recent zone-carrying activities must agree before a switch. Three is enough to
 * rule out a single mis-tagged upload while still catching a relocation within a couple of
 * days of normal training.
 */
export const DRIFT_AGREEMENT_COUNT = 3;

/**
 * The agreeing activities must also span at least this long. Without it, three activities
 * logged on one out-of-town race weekend would satisfy the count on their own — a trip, not
 * a move. A day and a half of consistent activity in a new zone is a much better signal.
 */
export const DRIFT_MIN_SPAN_MS = 36 * 60 * 60 * 1000;

/**
 * Pull the IANA zone out of Strava's timezone string, which arrives as a GMT-offset prefix
 * followed by the zone name: "(GMT-06:00) America/Denver".
 *
 * Returns null for anything that doesn't parse to a zone the runtime actually recognises —
 * writing an unvalidated string into users.timezone would make every subsequent
 * Intl.DateTimeFormat call throw, which is a far worse failure than a stale zone.
 */
export function parseStravaTimezone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = raw.match(/([A-Za-z]+\/[A-Za-z0-9_+\-/]+)/);
  if (!match) return null;
  const zone = match[1];
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return null;
  }
}

export interface DriftCandidate {
  activity_timezone: string | null;
  start_date: string;
}

/**
 * Decide whether the recent activity history justifies moving the athlete's stored zone.
 *
 * Pure so the thresholds can be tested without a database. `activities` is expected newest
 * first; rows without a captured zone are skipped rather than breaking the run, so history
 * predating the activity_timezone column doesn't block detection indefinitely.
 */
export function detectTimezoneDrift(
  activities: DriftCandidate[],
  storedTimezone: string | null,
): string | null {
  const zoned = activities.filter((a): a is DriftCandidate & { activity_timezone: string } => !!a.activity_timezone);
  if (zoned.length < DRIFT_AGREEMENT_COUNT) return null;

  const recent = zoned.slice(0, DRIFT_AGREEMENT_COUNT);
  const candidate = recent[0].activity_timezone;
  if (candidate === storedTimezone) return null;
  if (!recent.every((a) => a.activity_timezone === candidate)) return null;

  const times = recent.map((a) => new Date(a.start_date).getTime());
  const span = Math.max(...times) - Math.min(...times);
  if (span < DRIFT_MIN_SPAN_MS) return null;

  return candidate;
}

/**
 * Check the athlete's recent activities and move users.timezone if they've clearly relocated.
 *
 * Best-effort throughout: this runs on the activity-upload path, and a timezone refresh
 * failing must never cost the athlete their coaching message.
 */
export async function syncTimezoneFromActivities(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  storedTimezone: string | null,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("activities")
      .select("activity_timezone, start_date")
      .eq("user_id", userId)
      .not("activity_timezone", "is", null)
      .order("start_date", { ascending: false })
      .limit(DRIFT_AGREEMENT_COUNT);
    if (error || !data) return null;

    const next = detectTimezoneDrift(data as DriftCandidate[], storedTimezone);
    if (!next) return null;

    const { error: updateErr } = await supabase.from("users").update({ timezone: next }).eq("id", userId);
    if (updateErr) {
      console.error(`[timezone-drift] failed to update timezone for user ${userId}:`, updateErr.message);
      return null;
    }
    console.log(`[timezone-drift] user ${userId} timezone ${storedTimezone ?? "(unset)"} -> ${next}`);
    return next;
  } catch (err) {
    console.warn("[timezone-drift] sync failed (non-fatal):", err);
    return null;
  }
}
