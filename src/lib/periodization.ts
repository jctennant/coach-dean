export interface PeriodizationContext {
  effectiveWeek: number;
  phase: string;
  isDeloadWeek: boolean;
  suggestedWeeklyMiles: number | null;
}

/**
 * Compute the training phase from week number and race date.
 *
 * When a race date exists, phase is derived by counting weeks-to-race
 * (working backwards from race day):
 *   ≤ 2 weeks  → taper
 *   ≤ 7 weeks  → peak
 *   ≤ 14 weeks → build
 *   > 14 weeks → base
 *
 * Without a race date, phases cycle on a 12-week calendar:
 *   weeks 1–6  → base
 *   weeks 7–12 → build
 *   (then repeats)
 */
export function computePhase(currentWeek: number, raceDate: string | null): string {
  if (raceDate) {
    const now = new Date();
    const race = new Date(raceDate + "T12:00:00Z");
    const daysUntil = Math.ceil((race.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    const weeksUntil = Math.floor(daysUntil / 7);
    if (weeksUntil <= 2) return "taper";
    if (weeksUntil <= 7) return "peak";
    if (weeksUntil <= 14) return "build";
    return "base";
  }
  // No race: 6-week base → 6-week build, cycling
  const cyclePos = (currentWeek - 1) % 12;
  return cyclePos < 6 ? "base" : "build";
}

/**
 * Build the full periodization context for a given plan trigger.
 *
 * - initial_plan always resets to week 1
 * - weekly_recap plans the NEXT week (increments the counter)
 * - all other triggers read the stored week as-is
 */

/**
 * Which plan week the recap is planning.
 *
 * This used to be `storedWeek + 1` — a blind increment, anchored to nothing. Every run
 * advanced the athlete's plan by a week, so a manual re-trigger, a retried cron, or two
 * recaps in one evening aged the plan by two weeks. It bit for real on 2026-08-09: two
 * recaps ~90 minutes apart moved an athlete from week 2 of 4 to week 4 of 4, dropping him
 * onto race-week volume (6 mi, a 2 mi long run) eighteen days before his race.
 *
 * With a race date and a plan length, the week is a function of the calendar instead:
 * count back from race week to the week that starts tomorrow. That makes it idempotent —
 * running the recap twice lands on the same week — and self-correcting, since a cron that
 * fails one Sunday no longer leaves the athlete a week behind forever.
 *
 * Without both, there's nothing to anchor to, so the old increment stands.
 */
function recapWeek(storedWeek: number, raceDate: string | null, totalWeeks: number | null, now: Date): number {
  if (!raceDate || !totalWeeks || totalWeeks < 1) return storedWeek + 1;

  // Count from the Monday of the week being planned — the one starting tomorrow when the
  // recap runs on Sunday evening — not from today, so the answer doesn't drift by weekday.
  const upcomingMonday = new Date(now);
  const dow = upcomingMonday.getUTCDay(); // 0=Sun
  const daysToMonday = dow === 1 ? 0 : (8 - dow) % 7;
  upcomingMonday.setUTCDate(upcomingMonday.getUTCDate() + daysToMonday);
  upcomingMonday.setUTCHours(0, 0, 0, 0);

  const race = new Date(raceDate + "T12:00:00Z");
  const daysUntilRace = Math.ceil((race.getTime() - upcomingMonday.getTime()) / (24 * 60 * 60 * 1000));
  if (daysUntilRace < 0) return storedWeek + 1; // race already run — the arc no longer applies

  const weeksUntilRace = Math.max(1, Math.ceil(daysUntilRace / 7));
  return Math.min(totalWeeks, Math.max(1, totalWeeks - weeksUntilRace + 1));
}

export function buildPeriodization(
  trigger: string,
  storedWeek: number | null,
  raceDate: string | null,
  avgWeeklyMileage: number | null,
  opts: {
    /** training_plans.total_weeks — lets the recap anchor its week to the race date. */
    totalWeeks?: number | null;
    /** Injectable clock for tests. */
    now?: Date;
  } = {}
): PeriodizationContext {
  const rawWeek = storedWeek ?? 1;
  const effectiveWeek =
    trigger === "weekly_recap" ? recapWeek(rawWeek, raceDate, opts.totalWeeks ?? null, opts.now ?? new Date()) :
    trigger === "initial_plan" ? 1 :
    rawWeek;

  const phase = computePhase(effectiveWeek, raceDate);
  const isDeloadWeek = effectiveWeek % 4 === 0 && phase !== "taper" && phase !== "peak";

  const suggestedWeeklyMiles: number | null = (() => {
    if (!avgWeeklyMileage || avgWeeklyMileage <= 0 || phase === "taper") return null;
    if (isDeloadWeek) return Math.round(avgWeeklyMileage * 0.70 * 2) / 2;
    if (phase === "peak") return Math.round(avgWeeklyMileage * 1.05 * 2) / 2;
    return Math.round(avgWeeklyMileage * 1.08 * 2) / 2;
  })();

  return { effectiveWeek, phase, isDeloadWeek, suggestedWeeklyMiles };
}
