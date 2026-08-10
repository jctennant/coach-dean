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
import { parseStoredSessionDate } from "@/lib/session-mileage";
import { getRoutine } from "@/lib/strength-library";
import type { QualityPolicy } from "@/lib/week-mode";

export type SchedulePlanWeek = {
  week_number: number;
  mileage_target: number;
  long_run_target: number;
  key_workout: string;
  key_workout_2?: string | null;
};

/** Shape of a `training_state.weekly_plan_sessions` entry. */
export type PersistedSession = { day: string; date: string; label: string; rehab_routine_key?: string };

export interface ScheduleDigest {
  text: string;
  /** Rehab routine scheduled in the week this digest covers, for the follow-up bubble. */
  rehabRoutineKey: string | null;
  rehabDays: string[];
}

const ORDERED_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** training_profiles.injury_body_part — keeps next week's cross-training injury-safe. */
  injuryBodyPart?: string | null;
  /** How many quality sessions next week may carry (see resolveWeekMode). */
  qualityPolicy?: QualityPolicy;
  /** Rehab routine + severity, so next week's schedule carries the rehab days too. */
  rehab?: { routineKey: string | null; severity: "mild" | "moderate" | "severe" | null; activeInjury: boolean };
  nowMs?: number;
}): ScheduleDigest | null {
  const {
    weeks, currentWeekNumber, persistedSessions, trainingDays, strengthDay,
    crosstrainingTools, timezone, isMetric, weekMileageSoFar, avgWeeklyMileage, ranToday,
  } = params;

  const now = params.nowMs != null ? new Date(params.nowMs) : new Date();
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "America/New_York" }).format(now);
  const [ty, tm, td] = localStr.split("-").map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const dow = new Date(todayMs).getUTCDay(); // 0=Sun
  const todayIndex = dow === 0 ? 6 : dow - 1; // Mon=0 … Sun=6
  const endOfThisWeekMs = todayMs + (6 - todayIndex) * DAY_MS;

  const budgetMet =
    weekMileageSoFar > 0 && avgWeeklyMileage != null && avgWeeklyMileage > 0 &&
    weekMileageSoFar >= avgWeeklyMileage * 0.75;

  // Whatever is stored wins, whenever it still has days ahead of it.
  //
  // Selection used to hinge on how many days were left in the calendar week, which broke on
  // Sunday evening — the one moment the stored week is ALREADY next week's. With one day
  // "remaining" it fell through to recomputing from the arc, which threw away the athlete's
  // just-applied session swaps and rendered week N+1's mileage against next week's dates.
  // Jake asked to move bike to Monday and elliptical to Tuesday, both of which were stored
  // correctly, and got back a schedule showing neither (2026-08-10). Reading the dates the
  // sessions actually carry answers "is there anything left to show?" directly.
  if (!params.preferNextWeek && !budgetMet && persistedSessions?.length) {
    const earliestMs = ranToday ? todayMs + DAY_MS : todayMs;
    const upcoming = persistedSessions
      .map((s) => ({ session: s, date: parseStoredSessionDate(s.date, now.getTime()) }))
      .filter((x): x is { session: PersistedSession; date: Date } => x.date != null)
      .filter((x) => x.date.getTime() >= earliestMs)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    if (upcoming.length > 0) {
      const lines = upcoming.map(({ session, date }) => {
        // Day label comes from the date itself, so a stored day/date pair that drifted apart
        // can't render a weekday that contradicts its own date.
        const day = ORDERED_DAYS[(date.getUTCDay() + 6) % 7];
        // Stored labels carry the session only; the rehab routine rides in its own column, so
        // append it here exactly as formatWeeklyPlanDigest does for the computed path — the two
        // paths otherwise describe the same day differently depending on which one rendered it.
        const routine = session.rehab_routine_key ? getRoutine(session.rehab_routine_key) : null;
        const alreadyNamed = routine && session.label.toLowerCase().includes(routine.shortLabel.toLowerCase());
        const suffix = routine && !alreadyNamed ? ` + ${routine.shortLabel} routine` : "";
        return `${day} ${session.date} — ${session.label}${suffix}`;
      });
      const startsAfterThisWeek = upcoming[0].date.getTime() > endOfThisWeekMs;
      const heading = startsAfterThisWeek
        ? `Next week (${rangeFromDates(upcoming[0].date, upcoming[upcoming.length - 1].date)}):`
        : "Rest of this week:";
      const withRehab = upcoming.filter((x) => x.session.rehab_routine_key);
      return {
        text: `${heading}\n${lines.join("\n")}`,
        rehabRoutineKey: withRehab[0]?.session.rehab_routine_key ?? null,
        rehabDays: withRehab.map((x) => ORDERED_DAYS[(x.date.getUTCDay() + 6) % 7]),
      };
    }
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
    injuryBodyPart: params.injuryBodyPart ?? null,
    qualityPolicy: params.qualityPolicy ?? "both",
    rehab: params.rehab,
  });
  if (skeleton.filter((s) => s.type !== "rest").length === 0) return null;

  const rehabSlots = skeleton.filter((slot) => slot.rehab);
  return {
    text: formatWeeklyPlanDigest(skeleton, null, isMetric, `Next week (${rangeLabel(ty, tm, td, todayIndex)}):`),
    rehabRoutineKey: rehabSlots[0]?.rehab?.routineKey ?? null,
    rehabDays: rehabSlots.map((slot) => slot.day),
  };
}

/** "Aug 10–16" from the first and last dates actually being shown. */
function rangeFromDates(first: Date, last: Date): string {
  const start = first.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const end = last.getUTCMonth() === first.getUTCMonth()
    ? String(last.getUTCDate())
    : last.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${start}–${end}`;
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

const DAY_NAME = "(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?";
/** Day, optional date ("8/10", "Aug 10"), then a separator, then the session text. */
const DAY_SESSION_LINE = new RegExp(
  `^\\s*${DAY_NAME}\\b[,.]?\\s*(?:\\d{1,2}/\\d{1,2}|[A-Z][a-z]{2}\\.?\\s*\\d{1,2})?\\s*[·:.\\u2014\\u2013-]\\s+\\S`,
  "i"
);

/**
 * Lines that read as one day of a schedule. Dean writes these several ways — "Mon 8/10 · Easy 5mi",
 * "Mon 8/10. Easy 4mi", "Monday, Aug 10: Easy 2.5 mi" — and an earlier version of this only
 * recognised dash and colon separators, which is why a real transcript still got two schedules
 * (2026-08-09).
 */
export function countDayLabeledLines(message: string): number {
  return message.split("\n").filter((line) => DAY_SESSION_LINE.test(line)).length;
}

/**
 * Remove Dean's own day-by-day list from a message that's about to be followed by the
 * deterministic schedule.
 *
 * Suppressing the schedule bubble instead — what this used to do — was the wrong call: when both
 * appeared in one real transcript they didn't merely duplicate, they *disagreed*. Dean's prose
 * put the long run on Wednesday and 5mi easy on Monday while the stored plan had strides Monday
 * and the long run Saturday. Keeping his version and dropping the accurate one is the worse of
 * the two failures, so the schedule always wins and his lines come out.
 *
 * Only strips when there are at least two such lines — a single "Saturday's long run is the one
 * that matters" is prose, not a schedule.
 */
export function stripDayLabeledLines(message: string): string {
  const lines = message.split("\n");
  if (lines.filter((line) => DAY_SESSION_LINE.test(line)).length < 2) return message;
  return lines
    .filter((line) => !DAY_SESSION_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
