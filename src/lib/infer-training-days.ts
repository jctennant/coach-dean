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

// Monday-first ordering, matching training_profiles.training_days and WEEK_DAYS in
// training-plan.ts (computeArcWeekSkeleton normalizes against those names).
const WEEK_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * Day patterns used when history can't supply enough days. Built to match what
 * computeArcWeekSkeleton does with them rather than to look tidy on their own:
 *  - Sunday is in every pattern, because the skeleton picks the long-run day as
 *    Sun > Sat > chronologically-last. Omitting the weekend would push the long run onto
 *    a weekday for an athlete we know nothing about.
 *  - The rest alternate with a rest day between them where the count allows, and avoid
 *    sitting adjacent to Sunday — the skeleton's quality-day pick prefers a day more than
 *    one off the long run, and falls back to an adjacent one only if it has no choice.
 */
const FALLBACK_TEMPLATES: Record<number, string[]> = {
  1: ["sunday"],
  2: ["wednesday", "sunday"],
  3: ["tuesday", "thursday", "sunday"],
  4: ["monday", "wednesday", "friday", "sunday"],
  5: ["monday", "tuesday", "thursday", "friday", "sunday"],
  6: ["monday", "tuesday", "wednesday", "thursday", "friday", "sunday"],
  7: [...WEEK_ORDER],
};

export interface TrainingDaysFallback {
  /** Never empty. */
  days: string[];
  /** "history" — every day came from real runs; "mixed" — topped up from a template; "template" — no usable history at all. */
  source: "history" | "mixed" | "template";
}

/**
 * Last-resort standing schedule, for when inferTrainingDaysFromActivities returns null.
 *
 * That function is deliberately strict (2+ distinct weeks, a day present in half of them),
 * so it says null for exactly the athletes who most need a schedule: someone rebuilding
 * after a layoff, someone who just connected Strava with one week of runs, someone whose
 * days genuinely move around. Leaving training_days empty for them was not a neutral
 * outcome — computeArcWeekSkeleton returns [] for an empty list, so the week lost its
 * day-by-day breakdown entirely and fell back to free-hand prose with a hardcoded 4/week
 * guess, which is both less accurate than this and invisible to the reminder crons.
 *
 * This never returns null. It prefers the athlete's real (if weak) pattern, tops up from a
 * spacing-aware template, and sizes itself from observed run frequency before falling back
 * to their stated days_per_week. The caller is expected to state the result and invite a
 * correction — it's a starting point, not a claim about their habits.
 */
export function deriveTrainingDaysFallback(params: {
  activities: InferableActivity[];
  timezone: string;
  /** training_profiles.days_per_week. Only consulted when there's no run history to size from. */
  daysPerWeek?: number | null;
  /** Wider than the inference default: this runs precisely when recent history is thin. */
  lookbackDays?: number;
}): TrainingDaysFallback {
  const { activities, timezone, daysPerWeek, lookbackDays = 56 } = params;

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const runs = activities.filter(
    (a) => a.activity_type && RUN_TYPES.has(a.activity_type) && new Date(a.start_date).getTime() >= cutoff
  );

  const countByWeekday = new Map<string, number>();
  const weekdaysByWeek = new Map<string, Set<string>>();
  for (const run of runs) {
    const d = new Date(run.start_date);
    const monday = weekMonday(d, timezone);
    const localDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d);
    const name = WEEKDAY_NAMES[new Date(localDateStr + "T12:00:00Z").getUTCDay()]!;
    countByWeekday.set(name, (countByWeekday.get(name) ?? 0) + 1);
    if (!weekdaysByWeek.has(monday)) weekdaysByWeek.set(monday, new Set());
    weekdaysByWeek.get(monday)!.add(name);
  }

  const clamp = (n: number) => Math.max(1, Math.min(7, n));
  // Size from the busiest single week, measured in distinct weekdays run.
  //
  // Not `runs / weeksObserved`: the lookback window clips whichever weeks sit at its edges,
  // and a partial week counts as a whole one in that denominator. Six runs falling either
  // side of a Monday reads as two weeks and averages to three days — half the athlete's
  // actual frequency — which is exactly the direction that hurts, since the result becomes
  // the week's session count. The busiest week is the most complete view of their schedule
  // in the window, and erring one day high is safely absorbed: the caller states the days
  // and asks the athlete to confirm.
  const busiestWeek = Math.max(0, ...[...weekdaysByWeek.values()].map((s) => s.size));
  // days_per_week defaults to 4 in completeOnboarding whether or not the athlete ever said
  // a number, so it can't be told apart from a real answer — real runs always win over it.
  const target = busiestWeek > 0
    ? clamp(busiestWeek)
    : clamp(daysPerWeek && daysPerWeek > 0 ? Math.round(daysPerWeek) : 4);

  // Real days first, most-run-on first; ties broken by week order so the result is stable
  // for the same input rather than depending on Map insertion order.
  const fromHistory = [...countByWeekday.entries()]
    .sort((a, b) => (b[1] - a[1]) || (WEEK_ORDER.indexOf(a[0]) - WEEK_ORDER.indexOf(b[0])))
    .map(([day]) => day)
    .slice(0, target);

  const picked = new Set(fromHistory);
  for (const day of FALLBACK_TEMPLATES[target] ?? FALLBACK_TEMPLATES[4]!) {
    if (picked.size >= target) break;
    picked.add(day);
  }
  // Template exhausted without reaching target (possible when history contributed days the
  // template also contains) — top up from week order so the count is always honoured.
  for (const day of WEEK_ORDER) {
    if (picked.size >= target) break;
    picked.add(day);
  }

  const days = WEEK_ORDER.filter((d) => picked.has(d));
  const source: TrainingDaysFallback["source"] =
    fromHistory.length === 0 ? "template" : fromHistory.length >= target ? "history" : "mixed";

  return { days, source };
}
