import { RUN_TYPES, weekMonday } from "@/lib/cross-training";

export interface InferableActivity {
  activity_type: string | null;
  start_date: string;
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Infers an athlete's standing training days from recent run history. Strava-connected
 * athletes are never asked to name their days explicitly during onboarding (only non-Strava
 * athletes are), so without this, training_days stays empty for the life of the account —
 * the plan generator then has no day-by-day skeleton to work from (falls back to prose +
 * a hardcoded 4/week guess) and the reminder crons have nothing to gate on.
 *
 * Requires at least 2 distinct weeks of run history and a day that shows up in at least
 * half of them — a single week or a scattershot pattern isn't enough to lock in a standing
 * schedule. Returns null when the signal isn't there, so the caller can ask instead of guessing.
 */
export function inferTrainingDaysFromActivities(
  activities: InferableActivity[],
  timezone: string,
  lookbackDays: number = 28,
): string[] | null {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const runs = activities.filter(
    (a) => a.activity_type && RUN_TYPES.has(a.activity_type) && new Date(a.start_date).getTime() >= cutoff
  );
  if (runs.length === 0) return null;

  const weekdayWeeks = new Map<number, Set<string>>(); // weekday index -> Mondays it occurred in
  const allWeeks = new Set<string>();
  for (const run of runs) {
    const d = new Date(run.start_date);
    const monday = weekMonday(d, timezone);
    allWeeks.add(monday);
    const localDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d);
    const weekdayIdx = new Date(localDateStr + "T12:00:00Z").getUTCDay();
    if (!weekdayWeeks.has(weekdayIdx)) weekdayWeeks.set(weekdayIdx, new Set());
    weekdayWeeks.get(weekdayIdx)!.add(monday);
  }

  const weeksObserved = allWeeks.size;
  if (weeksObserved < 2) return null;

  const threshold = Math.ceil(weeksObserved / 2);
  const qualifyingDays = Array.from(weekdayWeeks.entries())
    .filter(([, weeks]) => weeks.size >= threshold)
    .map(([idx]) => idx)
    .sort((a, b) => a - b);

  if (qualifyingDays.length < 2) return null;

  return qualifyingDays.map((idx) => WEEKDAY_NAMES[idx]!);
}
