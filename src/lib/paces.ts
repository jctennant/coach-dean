/**
 * Shared pace calculation utilities (Jack Daniels' VDOT formula).
 * Used by both the onboarding handler and the coach/respond handler.
 */

/**
 * Calculate VDOT-based training paces from a race performance.
 * Uses Jack Daniels' Running Formula.
 */
export function calculateVDOTPaces(
  distanceKm: number,
  timeMinutes: number
): { easy: string; tempo: string; interval: string; vdot: number } {
  const v = (distanceKm * 1000) / timeMinutes; // meters per minute

  const pctVO2 =
    0.8 +
    0.1894393 * Math.exp(-0.012778 * timeMinutes) +
    0.2989558 * Math.exp(-0.1932605 * timeMinutes);

  const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
  const vdot = vo2 / pctVO2;

  return {
    easy: paceAtVDOTPct(vdot, 0.65),
    tempo: paceAtVDOTPct(vdot, 0.86),
    interval: paceAtVDOTPct(vdot, 0.98),
    vdot: Math.round(vdot * 10) / 10,
  };
}

function paceAtVDOTPct(vdot: number, pct: number): string {
  const targetVO2 = vdot * pct;
  const a = 0.000104;
  const b = 0.182258;
  const c = -(targetVO2 + 4.60);
  const v = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  const minPerMile = 1609.34 / v;
  const min = Math.floor(minPerMile);
  const sec = Math.round((minPerMile - min) * 60);
  return `${min}:${String(sec).padStart(2, "0")}/mi`;
}

/**
 * Convert a stored exact easy pace (always stored as min/mile, e.g. "7:44/mi")
 * into a display range. Rounds to nearest 5 seconds, adds 30s for the upper bound.
 * e.g. "7:44/mi" → "7:45–8:15/mi" (imperial) or "4:47–5:03/km" (metric)
 */
export function easyPaceRange(paceStr: string | null, useMetric = false): string | null {
  if (!paceStr) return null;
  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return paceStr;

  let totalSec = parseInt(match[1]) * 60 + parseInt(match[2]);
  // Paces are always stored as min/mile. Convert to min/km if needed.
  if (useMetric) totalSec = Math.round(totalSec / 1.60934);

  const rounded = Math.round(totalSec / 5) * 5;
  const upper = rounded + 30;

  const fmt = (s: number) => {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
  };

  return `${fmt(rounded)}–${fmt(upper)}${useMetric ? "/km" : "/mi"}`;
}

/**
 * Derive tempo and interval paces from a stated easy pace.
 * Used as a fallback when no race time is available.
 */
export function estimatePacesFromEasyPace(paceStr: string | null): {
  easy: string | null;
  tempo: string | null;
  interval: string | null;
} {
  if (!paceStr) return { easy: null, tempo: null, interval: null };

  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return { easy: paceStr, tempo: null, interval: null };

  const easySec = parseInt(match[1]) * 60 + parseInt(match[2]);
  const fmt = (s: number) => {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${String(sec).padStart(2, "0")}/mi`;
  };

  return {
    easy: fmt(easySec),
    tempo: easySec > 90 ? fmt(easySec - 90) : null,
    interval: easySec > 150 ? fmt(easySec - 150) : null,
  };
}
