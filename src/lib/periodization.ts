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
 *   ≤ 3 weeks  → taper
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
    if (weeksUntil <= 3) return "taper";
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
export function buildPeriodization(
  trigger: string,
  storedWeek: number | null,
  raceDate: string | null,
  avgWeeklyMileage: number | null
): PeriodizationContext {
  const rawWeek = storedWeek ?? 1;
  const effectiveWeek =
    trigger === "weekly_recap" ? rawWeek + 1 :
    trigger === "initial_plan" ? 1 :
    rawWeek;

  const phase = computePhase(effectiveWeek, raceDate);
  const isDeloadWeek = effectiveWeek % 4 === 0 && phase !== "taper";

  const suggestedWeeklyMiles: number | null = (() => {
    if (!avgWeeklyMileage || avgWeeklyMileage <= 0 || phase === "taper") return null;
    if (isDeloadWeek) return Math.round(avgWeeklyMileage * 0.70 * 2) / 2;
    if (phase === "peak") return Math.round(avgWeeklyMileage * 1.05 * 2) / 2;
    return Math.round(avgWeeklyMileage * 1.08 * 2) / 2;
  })();

  return { effectiveWeek, phase, isDeloadWeek, suggestedWeeklyMiles };
}
