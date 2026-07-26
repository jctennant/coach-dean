/**
 * Fact-check for onboarding's Strava-connect analysis message (handleDataAnalysis in
 * onboarding/handle/route.ts) — the same bug family Phase B (src/lib/fact-check.ts)
 * closed for coach/respond's post_run/user_message/morning_plan/weekly_recap/
 * initial_plan triggers, but that gate never covered this call: it's a bare
 * anthropic.messages.create with no tool constraint, protected only by a prompt
 * sentence ("only cite numbers that appear in the STRAVA data above").
 *
 * This call's shape is narrower than route.ts's named-fact checks (week_number,
 * weekly_target, etc.) — Dean can cite several different mileage/frequency numbers
 * in free prose, not a fixed set of fields. So instead of named facts, the model
 * echoes every specific mileage/frequency/elevation number its message states, and
 * each one is checked against an allow-list of the real numbers actually injected
 * into the STRAVA context for this athlete (plus km equivalents, since the
 * athlete's unit preference isn't always settled yet at this stage of onboarding).
 */
export function checkStravaAnalysisNumbers(stated: number[], groundTruth: number[]): number[] {
  if (stated.length === 0 || groundTruth.length === 0) return [];
  const allowed = new Set<number>();
  for (const t of groundTruth) {
    allowed.add(Math.round(t));
    allowed.add(Math.round(t * 1.60934)); // km equivalent
    allowed.add(Math.round(t / 1.60934)); // in case ground truth was itself stored in km
  }
  return stated.filter((s) => {
    const r = Math.round(s);
    for (const a of allowed) {
      // Rounding + display slack: exact match, or within ~5% (min 1 unit).
      if (Math.abs(r - a) <= Math.max(1, Math.round(a * 0.05))) return false;
    }
    return true;
  });
}

export function buildStravaFactCorrection(mismatches: number[]): string {
  return (
    "DELIVERY REJECTED — fact check failed. Your message states figure(s) that don't match any number in the STRAVA context above: " +
    mismatches.join(", ") +
    ". Call save_analysis again using only numbers that literally appear in the STRAVA context — do not estimate, round differently, or combine figures into a new number. If you can't support a claim with an actual figure from the context, drop the specific number and speak qualitatively instead."
  );
}
