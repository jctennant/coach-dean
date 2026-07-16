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
