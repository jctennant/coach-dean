/**
 * Parses the planned-mileage figure out of a stored session label (the
 * `weekly_plan_sessions` JSON on `training_state`, e.g. "Easy 5mi" or "Long run
 * ≈12mi total"). This is distinct from `plan-validation.ts`'s `parseSessionLines`,
 * which parses Claude's freshly *generated* response text — this module parses the
 * system's own stored plan data, used to build prompt context (FACTS block, plan
 * deviation detection, skipped-session detection).
 *
 * Before this extraction, three independent copies of this regex existed inline in
 * coach/respond/route.ts — in `planDeviationFlag`, in the (dead, never-called)
 * `computeProjectedWeekMiles`, and in the `sessionRows`/`projectedWeekMiles` IIFE —
 * and they had already drifted: only one had km-label support, and only one had the
 * `(?!n)` guard that stops "35 min" from being misread as "35 mi". This is the same
 * duplicate-formula shape the FITNESS TIER extraction (coach-fitness-tier.ts) closed —
 * one parser now, used everywhere a session label's mileage needs to be read.
 */

/**
 * Extracts the planned mileage from a session label. Prefers an explicit
 * "total"/"≈"/"~"/"=" marker over the first bare distance figure (so "Easy 5mi +
 * strides ≈6mi total" reads as 6, not 5). Falls back to km, converted to miles, when
 * no mi marker is present. Returns 0 for labels with no distance marker at all
 * (e.g. "Rest", "Strength").
 */
export function parseSessionMiles(label: string): number {
  const explicitTotal =
    label.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi(?!n)/i) ||
    label.match(/\((\d+(?:\.\d+)?)\s*mi(?!n)(?:\s+total)?\)/i);
  const firstMi = label.match(/(\d+(?:\.\d+)?)\s*mi(?!n)/i);
  const mMatch = explicitTotal || firstMi;
  if (mMatch) return parseFloat(mMatch[1]);

  // No mi marker — try km (metric-user session labels).
  const explicitKm =
    label.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*km/i) ||
    label.match(/\((\d+(?:\.\d+)?)\s*km(?:\s+total)?\)/i);
  const firstKm = label.match(/(\d+(?:\.\d+)?)\s*km/i);
  const kmMatch = explicitKm || firstKm;
  return kmMatch ? parseFloat(kmMatch[1]) / 1.60934 : 0;
}

/** Minimal shape of a `training_state.weekly_plan_sessions` entry. */
export type StoredSession = { day: string; date: string; label: string; type?: string };

/**
 * Recompute a week's stored running totals from its session labels.
 *
 * Used after a session swap. Before this existed, a swap rewrote the label on a day
 * and nothing else — so moving a 4mi easy day to a 7mi long run left
 * `weekly_mileage_target` and `weekly_long_run_miles` at their pre-swap values, and
 * the schedule the athlete could see no longer added up to the target Dean quoted
 * them (2026-08-09).
 *
 * Cross-training and strength slots contribute no mileage (parseSessionMiles returns
 * 0 for labels with no distance). `longRunMiles` is the largest single run in the
 * week, which is what the "long run" figure means to every consumer of it — reading it
 * off the label prefix instead would miss a swap that renamed the session.
 */
export function recomputeWeekTotalsFromSessions(
  sessions: StoredSession[]
): { totalMiles: number | null; longRunMiles: number | null } {
  const runMiles = sessions
    .filter((s) => s.type !== "cross_train" && s.type !== "strength")
    .map((s) => parseSessionMiles(s.label))
    .filter((m) => m > 0);
  if (runMiles.length === 0) return { totalMiles: null, longRunMiles: null };
  const total = runMiles.reduce((sum, m) => sum + m, 0);
  return {
    totalMiles: Math.round(total * 2) / 2,
    longRunMiles: Math.round(Math.max(...runMiles) * 2) / 2,
  };
}

/**
 * Parse a stored session date into a UTC Date.
 *
 * Sessions are written as "M/D" (computeArcWeekSkeleton). Rows written by the older
 * session-swap insert path carry ISO "YYYY-MM-DD", so both are accepted — new writes
 * are always "M/D". "M/D" carries no year: it's resolved against `refMs` (today), with
 * a ±1 year shift when the gap is more than six months, so a Dec/Jan week boundary
 * doesn't land a session eleven months away.
 */
export function parseStoredSessionDate(date: string, refMs: number = Date.now()): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], 12));

  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(date.trim());
  if (!md) return null;
  const month = +md[1];
  const day = +md[2];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const ref = new Date(refMs);
  let year = ref.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day, 12);
  const sixMonths = 182 * 24 * 60 * 60 * 1000;
  if (candidate - refMs > sixMonths) year -= 1;
  else if (refMs - candidate > sixMonths) year += 1;
  return new Date(Date.UTC(year, month - 1, day, 12));
}
