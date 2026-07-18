/**
 * Return-to-run ramp math, shared by the actual plan rebuild (handleInjuryClear,
 * fired on [INJURY_CLEAR]) and the predictive "what's the plan" answer Dean gives
 * while an athlete is still on injury hold. Single source of truth so the number
 * Dean quotes before clearance can't drift from the number the plan is actually
 * rebuilt with at clearance.
 */

export interface ReturnToRunRamp {
  weeksInjured: number;
  rampFactor: number; // 0.50 / 0.60 / 0.70
  returnBaseMiles: number | null; // rounded to nearest 0.5, null if no pre-injury target on file
}

/**
 * weeksInjured is computed from injury_hold_since to `now` (defaults to real time;
 * pass an explicit `now` in tests). Ramp: 1 week out → 70% of pre-injury weekly
 * mileage, 2 weeks → 60%, 3+ weeks → 50%.
 */
export function computeReturnToRunRamp(
  holdSince: string | null,
  preInjuryMileageTarget: number | null,
  now: Date = new Date(),
): ReturnToRunRamp | null {
  if (!holdSince) return null;
  const weeksInjured = Math.max(
    1,
    Math.ceil((now.getTime() - new Date(holdSince).getTime()) / (7 * 24 * 60 * 60 * 1000)),
  );
  const rampFactor = weeksInjured >= 3 ? 0.50 : weeksInjured >= 2 ? 0.60 : 0.70;
  const returnBaseMiles =
    preInjuryMileageTarget && preInjuryMileageTarget > 0
      ? Math.round(preInjuryMileageTarget * rampFactor * 2) / 2
      : null;
  return { weeksInjured, rampFactor, returnBaseMiles };
}
