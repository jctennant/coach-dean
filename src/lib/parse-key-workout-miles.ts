/**
 * Estimate the distance (in miles) of a key_workout string from the training plan arc.
 *
 * Resolution order:
 *  1. Explicit total at start:        "4.5mi tempo" → 4.5
 *  2. Explicit total after label:     "Tempo 3.5mi (...)" → 3.5
 *  3. Distance-based reps:            "4×800m" → 2.0, "6×1mi" → 6.0
 *     + WU/CD if present:             "4×800m (1mi WU + ... + 1mi CD)" → 4.0
 *  4. Time-based reps + pace:         "4×3min @ 8:30/mi with 2min recovery" → estimated
 *     work distance + recovery distance (N-1 recoveries) + WU/CD if present
 *  5. WU/CD only:                     "Intervals (1mi WU + 4×3min + 1mi CD)" → 2.0
 *  6. null → caller uses 20% fallback
 */
export function parseKeyWorkoutMiles(text: string): number | null {
  // 1. Explicit total at start: "4.5mi tempo"
  //    (?!\w) prevents matching "mi" inside "min" (e.g. "20min fartlek" must not → 20).
  const direct = text.match(/^(\d+(?:\.\d+)?)\s*mi(?!\w)/i);
  if (direct) return parseFloat(direct[1]!);

  // 2. Explicit total after a session-type word: "Tempo 3.5mi (...)", "Intervals 4mi (...)"
  //    Guard: no × before the number (avoids grabbing a rep count like in "6×1mi repeats")
  const labelDist = text.match(/^[A-Za-z][A-Za-z\s]*?(\d+(?:\.\d+)?)\s*mi(?!\w)/i);
  if (labelDist && !/[x×]/.test(text.slice(0, (labelDist.index ?? 0) + labelDist[0].length))) {
    return parseFloat(labelDist[1]!);
  }

  // 3. Distance-based reps: "4×800m", "6×1mi", "5×1000m"
  //    (mi|km|m)(?!\w): capture group gets the unit; lookahead outside prevents "mi"
  //    matching inside "min", and "m" matching inside "mi"/"min".
  const distRep = text.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mi|km|m)(?!\w)/i);
  if (distRep) {
    const reps = parseInt(distRep[1]!);
    const dist = parseFloat(distRep[2]!);
    const unit = distRep[3]!.toLowerCase();
    const distMi = unit === "mi" ? dist : unit === "km" ? dist * 0.621371 : dist / 1609.34;
    const wuCd = sumWuCd(text);
    return Math.round((reps * distMi + wuCd) * 10) / 10;
  }

  // 4. Time-based reps with pace: "4×3min @ 8:30/mi with 2min recovery jog"
  //    Estimate work + recovery distances from time and pace.
  const timeRep = text.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*min/i);
  const pace = text.match(/\(?\s*(\d+):(\d+)\s*\/\s*(mi|km)/i);
  if (timeRep && pace) {
    const reps = parseInt(timeRep[1]!);
    const workMin = parseFloat(timeRep[2]!);
    const paceDecimal = parseInt(pace[1]!) + parseInt(pace[2]!) / 60; // e.g. 8.5 for 8:30
    // Convert to min/mi regardless of stated unit
    const paceMinPerMi = pace[3]!.toLowerCase() === "km" ? paceDecimal / 0.621371 : paceDecimal;
    // Recovery: look for "Nmin recovery/jog/rest" or "with Nmin ...", default 2min
    const recMatch = text.match(/(?:with\s+)?(\d+(?:\.\d+)?)\s*min\s+(?:recovery|jog|rest)/i)
      ?? text.match(/with\s+(\d+(?:\.\d+)?)\s*min/i);
    const recoveryMin = recMatch ? parseFloat(recMatch[1]!) : 2;
    const recoveryPaceMinPerMi = paceMinPerMi + 2; // easy jog ≈ interval pace + 2:00/mi
    const workDist = (reps * workMin) / paceMinPerMi;
    const recoveryDist = ((reps - 1) * recoveryMin) / recoveryPaceMinPerMi; // N-1 between reps
    const wuCd = sumWuCd(text);
    return Math.round((workDist + recoveryDist + wuCd) * 10) / 10;
  }

  // 5. WU/CD only — main set has no parseable distance or pace
  const wuCdTotal = sumWuCd(text);
  if (wuCdTotal > 0) return wuCdTotal;

  return null;
}

function sumWuCd(text: string): number {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*mi\s+(?:WU|CD|warm|cool)/gi)]
    .reduce((s, m) => s + parseFloat(m[1]!), 0);
}
