/**
 * Day-by-day schedule bubble — sent at the end of onboarding (`initial_plan`) and
 * whenever an athlete asks about their plan (`user_message`, plan_question intent).
 *
 * `weekly_recap` has sent a deterministic day/date/distance schedule since the
 * 2026-04-16 redesign (computeArcWeekSkeleton → formatWeeklyPlanDigest, plus the
 * MMS schedule card), but `initial_plan` never got one: its prompt explicitly asks
 * for prose and says "not a day-by-day schedule". So an athlete finishing onboarding
 * got a paragraph describing the week rather than the schedule itself, and didn't see
 * a real one until the following Sunday (2026-08-08, Jake: "I'd like to get back to
 * the 'here's your schedule for the next week' Monday: X, Tuesday: Y").
 *
 * SOURCE OF TRUTH. The current week is NOT recomputed here. By the time this runs,
 * initial_plan has already sliced the arc's week 1 down to the days remaining and
 * persisted it to `training_state.weekly_plan_sessions` (see the mid-week-onboard block
 * in coach/respond/route.ts) — that row is what the dashboard, the reminders and the
 * session-swap path all read. Re-deriving the same week from the arc here would be a
 * second computation of one thing, which is precisely how the stored plan and the plan
 * Dean describes drifted apart before (2026-07-26). Only the *next* week is computed,
 * because nothing has persisted it yet — the Sunday recap writes it.
 *
 * Which week it shows: onboarding lands on an arbitrary weekday and the tail of the
 * current week is often already spent (Jake onboarded Saturday having already run 20 of
 * his ~20 mi). When too little of the week is left to schedule — or the week's mileage
 * budget is already met, or the athlete literally asked about next week — it shows the
 * upcoming Mon–Sun week instead.
 */

import { computeArcWeekSkeleton, formatWeeklyPlanDigest } from "@/lib/training-plan";

export type SchedulePlanWeek = {
  week_number: number;
  mileage_target: number;
  long_run_target: number;
  key_workout: string;
  key_workout_2?: string | null;
};

/** Shape of a `training_state.weekly_plan_sessions` entry. */
export type PersistedSession = { day: string; date: string; label: string };

const ORDERED_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_INDEX: Record<string, number> = {
  mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6,
};

/** Minimum days left in the current week for a "rest of this week" schedule to be worth sending. */
const MIN_DAYS_REMAINING = 3;

function dayIndexOf(day: string): number | null {
  const key = day.toLowerCase().trim().slice(0, 3);
  return key in DAY_INDEX ? DAY_INDEX[key] : null;
}

export function buildScheduleDigest(params: {
  weeks: SchedulePlanWeek[];
  currentWeekNumber: number;
  /** training_state.weekly_plan_sessions — the already-sliced, already-labeled current week. */
  persistedSessions: PersistedSession[] | null;
  trainingDays: string[];
  strengthDay: string | null;
  crosstrainingTools: string[];
  timezone: string;
  isMetric: boolean;
  /** Miles already run in the current Mon–Sun week. */
  weekMileageSoFar: number;
  /** Athlete's recent average weekly mileage, for the budget-met check. */
  avgWeeklyMileage: number | null;
  /** True when a run is already logged today — today's session isn't prescribed back. */
  ranToday: boolean;
  /** Athlete explicitly asked about next week — skip the current-week path entirely. */
  preferNextWeek?: boolean;
  nowMs?: number;
}): string | null {
  const {
    weeks, currentWeekNumber, persistedSessions, trainingDays, strengthDay,
    crosstrainingTools, timezone, isMetric, weekMileageSoFar, avgWeeklyMileage, ranToday,
  } = params;

  const now = params.nowMs != null ? new Date(params.nowMs) : new Date();
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "America/New_York" }).format(now);
  const [ty, tm, td] = localStr.split("-").map(Number);
  const dow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay(); // 0=Sun
  const todayIndex = dow === 0 ? 6 : dow - 1; // Mon=0 … Sun=6
  const daysRemaining = 7 - todayIndex; // includes today

  const budgetMet =
    weekMileageSoFar > 0 && avgWeeklyMileage != null && avgWeeklyMileage > 0 &&
    weekMileageSoFar >= avgWeeklyMileage * 0.75;

  // Current week first, from what's actually stored.
  if (!params.preferNextWeek && daysRemaining >= MIN_DAYS_REMAINING && !budgetMet && persistedSessions?.length) {
    const firstIndex = ranToday ? todayIndex + 1 : todayIndex;
    const lines = persistedSessions
      .map((s) => ({ ...s, idx: dayIndexOf(s.day) }))
      .filter((s): s is PersistedSession & { idx: number } => s.idx != null && s.idx >= firstIndex)
      .sort((a, b) => a.idx - b.idx)
      .map((s) => `${ORDERED_DAYS[s.idx]} ${s.date} — ${s.label}`);
    if (lines.length > 0) return `Rest of this week:\n${lines.join("\n")}`;
    // Nothing left to run this week — fall through to next week rather than send nothing.
  }

  if (!weeks.length || trainingDays.length === 0) return null;
  const nextWeek = weeks.find((w) => w.week_number === currentWeekNumber + 1) ?? null;
  if (!nextWeek) return null;

  const skeleton = computeArcWeekSkeleton({
    trainingDays,
    weeklyTotalMiles: nextWeek.mileage_target,
    longRunMiles: nextWeek.long_run_target,
    keyWorkoutText: nextWeek.key_workout || null,
    keyWorkoutText2: nextWeek.key_workout_2 ?? null,
    strengthDay,
    crosstrainingTools,
    timezone,
    weekOffsetDays: 7,
  });
  if (skeleton.filter((s) => s.type !== "rest").length === 0) return null;

  return formatWeeklyPlanDigest(skeleton, null, isMetric, `Next week (${rangeLabel(ty, tm, td, todayIndex)}):`);
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

/**
 * How many lines of a message read as "<day> … <separator>" — i.e. a day-by-day schedule
 * the athlete can already read off. Used to suppress the schedule bubble when Dean's own
 * message already listed the days, which is now the expected shape for plan answers.
 */
export function countDayLabeledLines(message: string): number {
  return (message.match(
    /^\s*(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b[^\n]*[:—–-]/gim
  ) ?? []).length;
}
