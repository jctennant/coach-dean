/**
 * Race time predictor for Coach Dean.
 *
 * Given a runner's current fitness (derived from Strava activity history) and
 * a target race's characteristics, produces a predicted finish time range with
 * a plain-language explanation of the key factors.
 *
 * Algorithm:
 * 1.  Derive VDOT from recent race performance, best efforts, or training paces
 * 2.  If a course record is provided for a trail/mountain race → use percentile-based
 *     projection (more accurate than VDOT for terrain-limited races)
 * 3.  Otherwise: flat-road VDOT → Riegel → terrain/elevation/heat/altitude penalties
 *     — Riegel exponent scales with distance (1.06 → 1.15) to capture ultra fatigue
 *     — Elevation: grade-dependent total-gain penalty + steep descent penalty
 *     — Trail terrain: 4-level subtype + mountain for VK/sky races
 *     — Heat: tiered by temperature band + humidity modifier
 *     — Altitude: aerobic degradation above 5,000ft for unacclimatized runners
 * 4.  VDOT distance-mismatch flag: widened range when predicting much longer races
 * 5.  Return source label, confidence range, plain-language caveat
 */

import { calculateVDOTPaces } from "@/lib/paces";

// ─── Trail terrain subtypes ───────────────────────────────────────────────────

/**
 * Trail terrain subtype — drives the terrain penalty %.
 *
 * groomed          8–12%  fire road, groomed XC, hard-packed dirt
 * mixed           15–20%  mix of singletrack and fireroad
 * technical       22–30%  rocky singletrack, roots, significant technical sections
 * highly_technical 30–40%  stairs, scrambling, route-finding (Dipsea, Hardrock-style)
 * mountain        55–75%  VK / sky / Skyrunner-style — primarily steep hiking,
 *                         VDOT alone unreliable; use course record if available
 */
export type TrailSubtype =
  | "groomed"
  | "mixed"
  | "technical"
  | "highly_technical"
  | "mountain";

const TRAIL_PENALTY_PCT: Record<TrailSubtype, number> = {
  groomed:          0.10,
  mixed:            0.17,
  technical:        0.26,
  highly_technical: 0.35,
  mountain:         0.65, // fallback when no course record is provided
};

// ─── Input / output types ─────────────────────────────────────────────────────

export interface RacePredictionInput {
  /** Recent Strava activities (last 8 weeks minimum) */
  activities: Array<{
    activity_type: string | null;
    distance_meters: number | null;
    moving_time_seconds: number | null;
    average_heartrate: number | null;
    start_date: string;
    workout_type?: number | null;
    /** Strava best_efforts — used to find PR-quality performances for VDOT */
    best_efforts?: Array<{
      name: string;
      elapsed_time: number; // seconds
      distance: number;     // meters
    }> | null;
  }>;

  /** Goal race distance in miles */
  goalDistanceMiles: number;

  /** Total course elevation gain in feet (use total, not net) */
  elevationGainFeet?: number;
  /** Total course elevation loss in feet */
  elevationLossFeet?: number;

  /** Broad terrain classification */
  terrainType?: "road" | "trail" | "mixed";
  /**
   * Trail subtype for more precise terrain penalty.
   * If terrainType = "trail" and this is omitted, inferred from gain per mile.
   */
  trailSubtype?: TrailSubtype;

  /**
   * Known course record (fastest finish) in minutes.
   * When provided for trail or mixed terrain, enables percentile-based projection
   * instead of pure VDOT extrapolation — much more accurate for mountain/sky races
   * where terrain limits performance regardless of aerobic capacity.
   */
  courseRecordMinutes?: number;

  /** Expected race temperature in °F */
  expectedTempF?: number;
  /** Expected race humidity % (0–100). Adds to heat penalty when > 70%. */
  expectedHumidityPct?: number;

  /** Race start altitude in feet (for altitude penalty above 5,000ft) */
  raceAltitudeFt?: number;
  /**
   * Athlete's typical training altitude in feet.
   * If > 3,000ft below race altitude, a flag is added.
   */
  trainingAltitudeFt?: number;

  /** Stored easy pace for VDOT fallback estimation */
  storedEasyPace?: string; // "M:SS" format

  /** Explicit recent race data — overrides everything else for VDOT */
  recentRaceDistKm?: number;
  recentRaceTimeMinutes?: number;
}

export interface RacePrediction {
  /** Predicted finish time in minutes (midpoint) */
  predictedMinutes: number;
  /** Low end of confidence range (minutes) */
  lowMinutes: number;
  /** High end of confidence range (minutes) */
  highMinutes: number;
  /** Human-readable finish time (e.g. "3:45:00") */
  predictedFormatted: string;
  /** Human-readable range */
  rangeFormatted: string;
  /** Label for the range, e.g. "Likely finish window" */
  rangeLabel: string;
  /** Source quality label — replaces "High/Medium/Low confidence" */
  sourceLabel: string;
  /**
   * Plain-language caveat for trail, ultra, or altitude predictions.
   * null when no meaningful caveat applies (short road race, good data).
   */
  caveat: string | null;
  /** Legacy confidence field — kept for backward compat */
  confidence: "high" | "medium" | "low";
  /** Key adjustment factors (for Dean's narrative use) */
  factors: string[];
  /** One-paragraph narrative for Dean to use in SMS */
  narrative: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.floor(totalMinutes % 60);
  const s = Math.round((totalMinutes % 1) * 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Riegel fatigue exponent — scales with race distance to capture the
 * disproportionate slowdown from muscular fatigue, fueling, and time-on-feet
 * that road-derived VDOT doesn't model.
 */
function riegelExponent(distanceMiles: number): number {
  if (distanceMiles >= 62.1) return 1.15; // 100K+
  if (distanceMiles >= 50)   return 1.12; // 50 mile
  if (distanceMiles >= 31.1) return 1.10; // 50K
  return 1.06;                             // up to marathon
}

/**
 * Infer trail subtype from gain per mile when the user hasn't specified.
 * Errs on the conservative (slower) side for safety.
 */
function inferTrailSubtype(gainFt: number, distanceMiles: number): TrailSubtype {
  const gainPerMile = distanceMiles > 0 ? gainFt / distanceMiles : 0;
  if (gainPerMile > 500) return "technical";
  if (gainPerMile > 250) return "mixed";
  return "groomed";
}

// ─── Course record projection ─────────────────────────────────────────────────

/**
 * Estimate how many times slower than the course record this athlete will run,
 * based on their VDOT. Mountain/trail races have compressed field spreads
 * vs. road because steep terrain limits performance regardless of aerobic capacity.
 *
 * Table entries: [minimum VDOT for this tier, multiplier from course record]
 * Tiers ordered highest → lowest VDOT.
 */
function courseRecordMultiplier(vdot: number, subtype: TrailSubtype): number {
  // Mountain races: tightest spread (sustained hiking compresses the field heavily)
  const mountainTable: [number, number][] = [
    [68, 1.10], [62, 1.22], [56, 1.35], [50, 1.52], [44, 1.72], [0, 1.95],
  ];
  // Highly technical: moderate compression (scrambling narrows the gap too)
  const highlyTechnicalTable: [number, number][] = [
    [68, 1.15], [62, 1.30], [56, 1.48], [50, 1.70], [44, 1.95], [0, 2.25],
  ];
  // Standard trail: spread closer to road — aerobic capacity still dominant
  const trailTable: [number, number][] = [
    [68, 1.20], [62, 1.40], [56, 1.62], [50, 1.88], [44, 2.15], [0, 2.50],
  ];

  const table = subtype === "mountain"          ? mountainTable
    : subtype === "highly_technical" ? highlyTechnicalTable
    : trailTable;

  for (const [minVdot, mult] of table) {
    if (vdot >= minVdot) return mult;
  }
  return table[table.length - 1]![1];
}

// ─── VDOT derivation ──────────────────────────────────────────────────────────

/**
 * Derive current VDOT from activity history.
 *
 * Priority (most → least reliable):
 * 1. Explicit recent race data provided by caller
 * 2. Strava activities flagged as race (workout_type = 1)
 * 3. Strava best_efforts ≥ 5K on any activity (catches PRs on non-race runs)
 * 4. Easy pace estimation (less precise)
 * 5. Long run pace estimation (rough)
 */
function deriveVDOT(input: RacePredictionInput): {
  vdot: number | null;
  source: string;
  sourceDistKm: number | null; // distance of the effort used for VDOT derivation
} {
  // 1. Explicit race data
  if (input.recentRaceDistKm && input.recentRaceTimeMinutes) {
    const paces = calculateVDOTPaces(input.recentRaceDistKm, input.recentRaceTimeMinutes);
    if (paces.vdot) {
      return { vdot: paces.vdot, source: `recent ${input.recentRaceDistKm}km race`, sourceDistKm: input.recentRaceDistKm };
    }
  }

  // 2. Strava race activities (workout_type = 1)
  const raceActivities = input.activities
    .filter(a =>
      a.workout_type === 1 &&
      a.distance_meters != null && a.distance_meters >= 3000 &&
      a.moving_time_seconds != null
    )
    .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())
    .slice(0, 5);

  for (const race of raceActivities) {
    const distKm = (race.distance_meters ?? 0) / 1000;
    const timeMin = (race.moving_time_seconds ?? 0) / 60;
    if (distKm < 3 || timeMin < 10) continue;
    const paces = calculateVDOTPaces(distKm, timeMin);
    if (paces.vdot) {
      return { vdot: paces.vdot, source: `${distKm.toFixed(1)}km Strava race`, sourceDistKm: distKm };
    }
  }

  // 3. Best efforts ≥ 5K (catches PRs on non-race-flagged workouts)
  let bestEffortVdot: number | null = null;
  let bestEffortSource = "";
  let bestEffortDistKm: number | null = null;
  for (const activity of input.activities) {
    for (const effort of activity.best_efforts ?? []) {
      if ((effort.distance ?? 0) < 4800) continue;
      const distKm = effort.distance / 1000;
      const timeMin = effort.elapsed_time / 60;
      if (timeMin < 15) continue;
      const paces = calculateVDOTPaces(distKm, timeMin);
      if (paces.vdot && (bestEffortVdot === null || paces.vdot > bestEffortVdot)) {
        bestEffortVdot = paces.vdot;
        bestEffortSource = `${distKm.toFixed(1)}km best effort`;
        bestEffortDistKm = distKm;
      }
    }
  }
  if (bestEffortVdot !== null) {
    return { vdot: bestEffortVdot, source: bestEffortSource, sourceDistKm: bestEffortDistKm };
  }

  // 4. Easy pace estimation
  if (input.storedEasyPace) {
    const parts = input.storedEasyPace.split(":");
    if (parts.length === 2) {
      const easyPaceMinPerMile = parseInt(parts[0]) + parseInt(parts[1]) / 60;
      const estimatedRacePaceMinPerMile = easyPaceMinPerMile * 0.86;
      const tenKTimeMin = estimatedRacePaceMinPerMile * 6.214;
      const paces = calculateVDOTPaces(10, tenKTimeMin);
      if (paces.vdot) {
        return { vdot: paces.vdot, source: "estimated from easy pace (less precise)", sourceDistKm: 10 };
      }
    }
  }

  // 5. Long run pace estimation
  const longRuns = input.activities
    .filter(a =>
      ["Run", "TrailRun", "VirtualRun"].includes(a.activity_type ?? "") &&
      a.distance_meters != null && a.distance_meters >= 12875 &&
      a.moving_time_seconds != null
    )
    .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime())
    .slice(0, 3);

  if (longRuns.length > 0) {
    const run = longRuns[0]!;
    const distKm = (run.distance_meters ?? 0) / 1000;
    const timeMin = (run.moving_time_seconds ?? 0) / 60;
    const estimated10KPacePerKm = (timeMin / distKm) * 0.88;
    const tenKTimeMin = estimated10KPacePerKm * 10;
    const paces = calculateVDOTPaces(10, tenKTimeMin);
    if (paces.vdot) {
      return { vdot: paces.vdot, source: "estimated from long run pace (rough)", sourceDistKm: distKm };
    }
  }

  return { vdot: null, source: "insufficient data", sourceDistKm: null };
}

// ─── VDOT → flat-road finish time ─────────────────────────────────────────────

/**
 * Predict flat-road finish time from VDOT using an interpolated lookup table
 * anchored to 10K, then scaled to target distance via Riegel's formula.
 * The Riegel exponent scales with distance to model ultra fatigue.
 */
function predictFromVDOT(vdot: number, distanceMiles: number): number | null {
  const vdotTable: [number, number][] = [
    [25, 88], [30, 73], [35, 64], [40, 56], [45, 50],
    [50, 46], [55, 42], [60, 38], [65, 35], [70, 33], [75, 31], [80, 29],
  ];

  let tenKMin: number | null = null;
  for (let i = 0; i < vdotTable.length - 1; i++) {
    const [v1, t1] = vdotTable[i]!;
    const [v2, t2] = vdotTable[i + 1]!;
    if (vdot >= v1 && vdot <= v2) {
      tenKMin = t1 + ((vdot - v1) / (v2 - v1)) * (t2 - t1);
      break;
    }
  }
  if (tenKMin === null) {
    tenKMin = vdot < 25 ? 88 + (25 - vdot) * 3 : 29 - (vdot - 80) * 0.3;
  }

  const refDistanceMiles = 6.214; // 10K in miles
  const exponent = riegelExponent(distanceMiles);
  return Math.round(tenKMin * Math.pow(distanceMiles / refDistanceMiles, exponent) * 10) / 10;
}

// ─── Source labels ─────────────────────────────────────────────────────────────

function buildSourceLabel(vdotSource: string, usedCourseRecord: boolean): string {
  if (usedCourseRecord) return "Based on course record";
  if (vdotSource.includes("race") && !vdotSource.includes("estimated")) return "Based on recent race";
  if (vdotSource.includes("best effort")) return "Based on training data";
  if (vdotSource.includes("easy pace")) return "Estimated from easy pace";
  return "Estimated from long runs";
}

function buildCaveat(params: {
  terrainType: string;
  trailSubtype: TrailSubtype | null;
  goalDistanceMiles: number;
  sourceDistKm: number | null;
  altitudeFlagged: boolean;
  vdotSource: string;
  usedCourseRecord: boolean;
}): string | null {
  const { terrainType, trailSubtype, goalDistanceMiles, sourceDistKm, altitudeFlagged, vdotSource, usedCourseRecord } = params;
  const caveats: string[] = [];

  const isUltra = goalDistanceMiles >= 31;
  const isTrail = terrainType === "trail" || terrainType === "mixed";
  const isMountain = trailSubtype === "mountain";
  const isHighlyTechnical = trailSubtype === "highly_technical";
  const sourceDistMiles = sourceDistKm ? sourceDistKm * 0.621 : null;
  const hasDistanceMismatch = sourceDistMiles != null && goalDistanceMiles > sourceDistMiles * 2;
  const isEstimated = vdotSource.includes("estimated") || vdotSource.includes("long run");

  if (isMountain) {
    caveats.push(usedCourseRecord
      ? "Mountain race estimates are wider than standard — course conditions vary significantly"
      : "No course record provided — using VDOT estimate for mountain terrain (less accurate)");
  } else if (isHighlyTechnical) {
    caveats.push("Course terrain adds meaningful uncertainty");
  } else if (isTrail && !usedCourseRecord) {
    caveats.push("Trail factors may shift this significantly");
  }
  if (isUltra && (hasDistanceMismatch || isEstimated)) {
    caveats.push("Ultra-specific fitness not fully captured");
  }
  if (altitudeFlagged) {
    caveats.push("Racing well above your training altitude");
  }

  return caveats.length > 0 ? caveats.join(" · ") : null;
}

// ─── Main prediction ───────────────────────────────────────────────────────────

export function predictRaceTime(input: RacePredictionInput): RacePrediction | null {
  const { vdot, source: vdotSource, sourceDistKm } = deriveVDOT(input);
  if (vdot === null || vdot < 20) return null;

  const factors: string[] = [];
  let adjustedMinutes: number;
  let usedCourseRecord = false;

  const gainFt    = input.elevationGainFeet ?? 0;
  const lossFt    = input.elevationLossFeet ?? 0;
  const distMiles = input.goalDistanceMiles;
  const distFt    = distMiles * 5280;
  const isTrail   = input.terrainType === "trail";
  const isMixed   = input.terrainType === "mixed";

  const resolvedSubtype: TrailSubtype | null = isTrail
    ? (input.trailSubtype ?? inferTrailSubtype(gainFt, distMiles))
    : (isMixed ? (input.trailSubtype ?? null) : null);

  // ── Path A: course record projection ─────────────────────────────────────
  // Used when a course record is provided for trail/mixed terrain.
  // More accurate than VDOT for mountain/technical races where terrain limits
  // performance independently of aerobic capacity.
  if (input.courseRecordMinutes && (isTrail || isMixed)) {
    usedCourseRecord = true;
    const subtype = resolvedSubtype ?? "groomed";
    const mult = courseRecordMultiplier(vdot, subtype);
    adjustedMinutes = input.courseRecordMinutes * mult;

    const pctBack = Math.round((mult - 1) * 100);
    factors.push(`Fitness baseline: VDOT ${Math.round(vdot)} (${vdotSource})`);
    factors.push(`Course record: ${formatTime(input.courseRecordMinutes)} — estimated ~${pctBack}% back`);

  } else {
    // ── Path B: VDOT-based prediction ──────────────────────────────────────
    const baseMinutes = predictFromVDOT(vdot, distMiles);
    if (!baseMinutes) return null;

    adjustedMinutes = baseMinutes;
    factors.push(`Fitness baseline: VDOT ${Math.round(vdot)} (${vdotSource})`);

    // Elevation gain penalty
    if (gainFt > 100) {
      const avgGainGradePct = distFt > 0 ? (gainFt / distFt) * 100 : 0;
      let gainPenaltyPer1000ft: number;
      if (isTrail || isMixed) {
        gainPenaltyPer1000ft = avgGainGradePct > 10 ? 2.0 : 1.5;
      } else {
        gainPenaltyPer1000ft = 1.0; // road
      }
      const gainPenaltyMin = (gainFt / 1000) * gainPenaltyPer1000ft;
      adjustedMinutes += gainPenaltyMin;
      factors.push(
        `+${gainPenaltyMin.toFixed(1)} min — ${Math.round(gainFt).toLocaleString()}ft gain` +
        (isTrail ? ` (avg ${avgGainGradePct.toFixed(0)}% grade, ${gainPenaltyPer1000ft.toFixed(1)} min/1000ft)` : "")
      );
    }

    // Descent penalty for steep courses
    if (lossFt > 0) {
      const avgDescentGradePct = distFt > 0 ? (lossFt / distFt) * 100 : 0;
      if (avgDescentGradePct > 12) {
        const descentPenaltyMin = (lossFt / 1000) * 0.5;
        adjustedMinutes += descentPenaltyMin;
        factors.push(`+${descentPenaltyMin.toFixed(1)} min — steep descent penalty (${avgDescentGradePct.toFixed(0)}% avg grade)`);
      }
    }

    // Trail terrain penalty
    if (isTrail) {
      const subtype = resolvedSubtype ?? inferTrailSubtype(gainFt, distMiles);
      const penaltyPct = TRAIL_PENALTY_PCT[subtype];
      const trailPenaltyMin = baseMinutes * penaltyPct;
      adjustedMinutes += trailPenaltyMin;
      const subtypeLabel: Record<TrailSubtype, string> = {
        groomed:          "groomed/fire road",
        mixed:            "mixed singletrack",
        technical:        "technical singletrack",
        highly_technical: "highly technical terrain",
        mountain:         "mountain/sky race",
      };
      factors.push(`+${Math.round(penaltyPct * 100)}% trail penalty (${subtypeLabel[subtype]})`);
    } else if (isMixed) {
      adjustedMinutes += baseMinutes * 0.08;
      factors.push("+8% mixed terrain adjustment");
    }
  }

  // ── Heat penalty (applied in both paths) ─────────────────────────────────
  const tempF = input.expectedTempF;
  if (tempF !== undefined && tempF > 75) {
    let heatPct = 0;
    const tier1 = Math.min(tempF, 85) - 75;
    const tier2 = Math.max(0, Math.min(tempF, 95) - 85);
    heatPct += (tier1 / 5) * 0.02 + (tier2 / 5) * 0.035;
    const humidityPct = input.expectedHumidityPct ?? 0;
    if (humidityPct > 70) {
      heatPct += 0.015;
      factors.push(`+${Math.round(heatPct * 100)}% heat/humidity penalty (${tempF}°F, ${humidityPct}% humidity)`);
    } else {
      factors.push(`+${Math.round(heatPct * 100)}% heat penalty (${tempF}°F)`);
    }
    heatPct = Math.min(heatPct, 0.15);
    adjustedMinutes += adjustedMinutes * heatPct;
  }

  // ── Altitude penalty (applied in both paths) ──────────────────────────────
  const raceAlt = input.raceAltitudeFt ?? 0;
  const trainingAlt = input.trainingAltitudeFt ?? 0;
  let altitudeFlagged = false;
  if (raceAlt > 5000) {
    const altPenaltyPct = Math.min(((raceAlt - 5000) / 1000) * 0.02, 0.10);
    adjustedMinutes += adjustedMinutes * altPenaltyPct;
    factors.push(`+${Math.round(altPenaltyPct * 100)}% altitude penalty (${Math.round(raceAlt).toLocaleString()}ft)`);
    if (raceAlt - trainingAlt > 3000) {
      altitudeFlagged = true;
    }
  }

  // ── VDOT distance mismatch (path B only) ──────────────────────────────────
  const sourceDistMiles = sourceDistKm ? sourceDistKm * 0.621 : null;
  const distanceMismatch = !usedCourseRecord && sourceDistMiles != null && distMiles > sourceDistMiles * 2;

  // ── Confidence / range ────────────────────────────────────────────────────
  const baseConfidence: RacePrediction["confidence"] =
    vdotSource.includes("race") && !vdotSource.includes("estimated") ? "high" :
    vdotSource.includes("estimated from easy pace") ? "low" : "medium";

  let rangePct: number;
  if (usedCourseRecord) {
    // Course record predictions: tighter for mountain (compressed field), wider for standard trail
    rangePct = resolvedSubtype === "mountain" ? 0.07 : 0.06;
    rangePct += baseConfidence === "low" ? 0.03 : 0;
  } else {
    rangePct = baseConfidence === "high" ? 0.04 : baseConfidence === "medium" ? 0.06 : 0.10;
    if (input.trailSubtype === "highly_technical" || distanceMismatch) rangePct += 0.04;
    if (input.trailSubtype === "mountain") rangePct += 0.05; // no course record + mountain = wide
    if (distMiles >= 50) rangePct += 0.02;
  }

  const lowMinutes  = Math.round(adjustedMinutes * (1 - rangePct) * 10) / 10;
  const highMinutes = Math.round(adjustedMinutes * (1 + rangePct) * 10) / 10;

  // ── Labels ────────────────────────────────────────────────────────────────
  const sourceLabel = buildSourceLabel(vdotSource, usedCourseRecord);
  const caveat = buildCaveat({
    terrainType:      input.terrainType ?? "road",
    trailSubtype:     resolvedSubtype,
    goalDistanceMiles: distMiles,
    sourceDistKm,
    altitudeFlagged,
    vdotSource,
    usedCourseRecord,
  });

  const narrative = buildNarrative(
    distMiles, adjustedMinutes, lowMinutes, highMinutes,
    factors, baseConfidence, vdotSource, caveat, usedCourseRecord,
    input.courseRecordMinutes
  );

  return {
    predictedMinutes:   Math.round(adjustedMinutes),
    lowMinutes,
    highMinutes,
    predictedFormatted: formatTime(adjustedMinutes),
    rangeFormatted:     `${formatTime(lowMinutes)}–${formatTime(highMinutes)}`,
    rangeLabel:         "Likely finish window",
    sourceLabel,
    caveat,
    confidence: baseConfidence,
    factors,
    narrative,
  };
}

// ─── Narrative ─────────────────────────────────────────────────────────────────

function buildNarrative(
  distanceMiles: number,
  predictedMin: number,
  lowMin: number,
  highMin: number,
  factors: string[],
  confidence: RacePrediction["confidence"],
  vdotSource: string,
  caveat: string | null,
  usedCourseRecord: boolean,
  courseRecordMinutes?: number,
): string {
  const distLabel =
    distanceMiles >= 60 ? "100K"
    : distanceMiles >= 49 ? "50 mile"
    : distanceMiles >= 30 ? "50K"
    : distanceMiles >= 25 ? "marathon"
    : distanceMiles >= 12 ? "half marathon"
    : distanceMiles >= 5.5 ? "10K"
    : distanceMiles >= 2.8 ? "5K"
    : `${distanceMiles.toFixed(1)}-mile race`;

  const range   = `${formatTime(lowMin)}–${formatTime(highMin)}`;
  const midpoint = formatTime(predictedMin);
  const adjustments = factors.slice(usedCourseRecord ? 2 : 1).join("; ").trim();
  const caveatNote = caveat ? ` Note: ${caveat}.` : "";

  let text: string;
  if (usedCourseRecord && courseRecordMinutes) {
    const crStr = formatTime(courseRecordMinutes);
    const pctFactorEntry = factors.find(f => f.includes("% back"));
    const pctBack = pctFactorEntry?.match(/~(\d+)%/)?.[1] ?? "?";
    text = `Course record is ${crStr}. Based on your fitness (${vdotSource}), I'd project you finishing about ${pctBack}% back — around ${range}`;
    if (midpoint && midpoint !== range) text += `, with ${midpoint} as the midpoint`;
    text += ".";
    text += " Mountain race estimates are wider than road — conditions and course-specific demands matter a lot.";
  } else {
    const sourceNote =
      confidence === "high"
        ? "Based on solid race data."
        : confidence === "medium"
        ? "Based on training data — a recent race result would sharpen this."
        : "Rough estimate from pace data — a 5K or 10K result would sharpen this significantly.";
    text = `Based on your current fitness (${vdotSource}), I'd project a ${range} finish for the ${distLabel}`;
    if (midpoint && midpoint !== range) text += ` — around ${midpoint} in the middle`;
    text += `. ${sourceNote}`;
    if (adjustments) text += ` Key adjustments: ${adjustments}.`;
  }
  text += caveatNote;

  return text;
}

// ─── Public helpers ────────────────────────────────────────────────────────────

/**
 * Predict finish time (minutes) from a known VDOT for a given distance.
 * Returns null if VDOT is out of range.
 */
export function predictTimeFromVDOT(vdot: number, distanceMiles: number): number | null {
  return predictFromVDOT(vdot, distanceMiles);
}

/**
 * Estimate current VDOT from activity history.
 * Returns the VDOT value and a plain-language source description.
 */
export function estimateVDOT(
  activities: RacePredictionInput["activities"],
  storedEasyPace?: string
): { vdot: number | null; source: string } {
  const { vdot, source } = deriveVDOT({ activities, goalDistanceMiles: 6.2, storedEasyPace });
  return { vdot, source };
}
