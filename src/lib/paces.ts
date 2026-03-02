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
): { easy: string; tempo: string; interval: string } {
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
