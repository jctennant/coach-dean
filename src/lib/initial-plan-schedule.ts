/**
 * Day-by-day schedule bubble for the end of onboarding (`initial_plan`).
 *
 * `weekly_recap` has sent a deterministic day/date/distance schedule since the
 * 2026-04-16 redesign (computeArcWeekSkeleton → formatWeeklyPlanDigest, plus the
 * MMS schedule card), but `initial_plan` never got one: its prompt explicitly asks
 * for prose and says "not a day-by-day schedule". So an athlete finishing onboarding
 * got a paragraph describing the week rather than the schedule itself, and didn't see
 * a real one until the following Sunday (2026-08-08, Jake: "I'd like to get back to
 * the 'here's your schedule for the next week' Monday: X, Tuesday: Y").
 *
 * This renders that schedule from the same generator the Sunday recap uses, so the two
 * can't describe the same week differently, and no model call produces the numbers.
 *
 * Which week it shows: onboarding lands on an arbitrary weekday, and the tail of the
 * current week is often already spent (Jake onboarded on a Saturday having already run
 * 20 of his ~20 mi). When too little of the week is left to be worth scheduling — or
 * the week's mileage budget is already met — it shows the upcoming Mon–Sun week
 * instead, which is what the athlete actually needs to see.
 */

import { computeArcWeekSkeleton, formatWeeklyPlanDigest, type ArcWeekSlot } from "@/lib/training-plan";

export type SchedulePlanWeek = {
  week_number: number;
  mileage_target: number;
  long_run_target: number;
  key_workout: string;
  key_workout_2?: string | null;
};

const ORDERED_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Minimum days left in the current week for a "rest of this week" schedule to be worth sending. */
const MIN_DAYS_REMAINING = 3;

export function buildInitialPlanSchedule(params: {
  weeks: SchedulePlanWeek[];
  currentWeekNumber: number;
  trainingDays: string[];
  strengthDay: string | null;
  crosstrainingTools: string[];
  timezone: string;
  isMetric: boolean;
  /** Miles already run in the current Mon–Sun week. */
  weekMileageSoFar: number;
  /** Athlete's recent average weekly mileage, for the budget-met check. */
  avgWeeklyMileage: number | null;
  nowMs?: number;
}): string | null {
  const {
    weeks, currentWeekNumber, trainingDays, strengthDay, crosstrainingTools,
    timezone, isMetric, weekMileageSoFar, avgWeeklyMileage,
  } = params;

  if (!weeks.length || trainingDays.length === 0) return null;

  const now = params.nowMs != null ? new Date(params.nowMs) : new Date();
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "America/New_York" }).format(now);
  const [ty, tm, td] = localStr.split("-").map(Number);
  const dow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay(); // 0=Sun
  const todayIndex = dow === 0 ? 6 : dow - 1; // Mon=0 … Sun=6
  const daysRemaining = 7 - todayIndex; // includes today

  const budgetMet =
    weekMileageSoFar > 0 && avgWeeklyMileage != null && avgWeeklyMileage > 0 &&
    weekMileageSoFar >= avgWeeklyMileage * 0.75;
  const useNextWeek = daysRemaining < MIN_DAYS_REMAINING || budgetMet;

  const wanted = currentWeekNumber + (useNextWeek ? 1 : 0);
  const week = weeks.find((w) => w.week_number === wanted) ?? null;
  if (!week) return null;

  const skeleton = computeArcWeekSkeleton({
    trainingDays,
    weeklyTotalMiles: week.mileage_target,
    longRunMiles: week.long_run_target,
    keyWorkoutText: week.key_workout || null,
    keyWorkoutText2: week.key_workout_2 ?? null,
    strengthDay,
    crosstrainingTools,
    timezone,
    weekOffsetDays: useNextWeek ? 7 : 0,
  });
  if (skeleton.length === 0) return null;

  // Current-week schedules only cover days that haven't happened yet — a Thursday
  // onboard shouldn't be handed Monday's session as if it were still ahead of them.
  const visible: ArcWeekSlot[] = useNextWeek
    ? skeleton
    : skeleton.filter((s) => ORDERED_DAYS.indexOf(s.day) >= todayIndex);
  if (visible.filter((s) => s.type !== "rest").length === 0) return null;

  const heading = useNextWeek
    ? `Next week (${rangeLabel(ty, tm, td, todayIndex)}):`
    : "Rest of this week:";
  return formatWeeklyPlanDigest(visible, null, isMetric, heading);
}

/** "Aug 10–16" for the Mon–Sun week after the one containing the given local date. */
function rangeLabel(y: number, m: number, d: number, todayIndex: number): string {
  const monday = new Date(Date.UTC(y, m - 1, d - todayIndex + 7));
  const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
  const mon = monday.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const sun = sunday.getUTCMonth() === monday.getUTCMonth()
    ? String(sunday.getUTCDate())
    : sunday.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${mon}–${sun}`;
}
