/**
 * Training analytics helpers for Coach Dean v2.
 * Computes longitudinal training signals from activity history:
 *   - Load trend (week-over-week mileage change)
 *   - Aerobic efficiency trend (pace-at-HR over time)
 *   - Cardiac drift trend (HR decoupling on long runs)
 *
 * All functions are pure (no side effects), designed to be called in the
 * post_run and weekly_recap coaching paths to give Dean longitudinal context.
 */

import { estimateMaxHR } from "./hr-utils";

export interface ActivityForAnalytics {
  start_date: string;
  activity_type: string | null;
  workout_type: number | null;         // 0/null=run, 1=race, 2=long run, 3=workout
  distance_meters: number | null;
  moving_time_seconds: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
  elevation_gain: number | null;       // meters
  average_cadence: number | null;      // steps per minute
  aerobic_efficiency: number | null;   // m/beat — stored by migration 029
  cardiac_decoupling_pct: number | null;
}

export interface LoadTrendResult {
  /** Miles per week for each of the last 8 complete weeks (oldest→newest) */
  weeklyMiles: number[];
  /** % change from the previous week to the most recent complete week */
  weekOverWeekChangePct: number | null;
  /** True if the most recent week's mileage increased >10% from the prior week */
  flagged: boolean;
  /** Human-readable summary for the system prompt */
  summary: string;
}

export interface AerobicEfficiencyResult {
  /** Most recent 4-week average aerobic efficiency (m/beat), null if no HR data */
  recentAvg: number | null;
  /** Prior 4-week average aerobic efficiency (m/beat), null if insufficient data */
  priorAvg: number | null;
  /** Direction of change */
  trend: "improving" | "worsening" | "stable" | "insufficient_data";
  /** Human-readable summary for the system prompt */
  summary: string;
}

export interface CardiacDriftResult {
  /** Most recent 4-week average cardiac decoupling (%), null if no data */
  recentAvg: number | null;
  /** Direction of change */
  trend: "improving" | "worsening" | "stable" | "insufficient_data";
  /** Human-readable summary for the system prompt */
  summary: string;
}

/** Returns the start of the ISO week (Mon) for a given date in a timezone. */
function getWeekStart(date: Date, timezone: string): Date {
  const localStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const [y, m, d] = localStr.split("-").map(Number);
  const local = new Date(Date.UTC(y, m - 1, d));
  const dow = local.getUTCDay(); // 0=Sun, 1=Mon...
  const daysToMon = dow === 0 ? 6 : dow - 1;
  return new Date(Date.UTC(y, m - 1, d - daysToMon));
}

function weekKey(date: Date, timezone: string): string {
  return getWeekStart(date, timezone).toISOString().slice(0, 10);
}

/**
 * Compute week-over-week mileage trend from recent activities.
 * Uses last 8 ISO weeks (Mon–Sun) in the athlete's timezone.
 */
export function computeLoadTrend(
  activities: ActivityForAnalytics[],
  timezone: string
): LoadTrendResult {
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  // Group running distances by week key
  const byWeek: Record<string, number> = {};
  for (const a of activities) {
    if (!RUN_TYPES.has(a.activity_type ?? "")) continue;
    if (!a.distance_meters || !a.start_date) continue;
    const k = weekKey(new Date(a.start_date), timezone);
    byWeek[k] = (byWeek[k] ?? 0) + a.distance_meters / 1609.34;
  }

  // Build the last 8 complete weeks (exclude the current partial week).
  // Anchor at the start of this week in the target TZ, then step back 7-day
  // increments from that Monday. (Stepping back from `now` in UTC and then
  // re-converting via weekKey skipped the most recent completed week whenever
  // UTC had rolled to Monday but the local TZ had not — or vice versa.)
  const now = new Date();
  const currentWeekStart = getWeekStart(now, timezone);
  const thisWeekKey = currentWeekStart.toISOString().slice(0, 10);
  const weeks: Array<{ key: string; miles: number }> = [];
  for (let i = 8; i >= 1; i--) {
    const d = new Date(Date.UTC(
      currentWeekStart.getUTCFullYear(),
      currentWeekStart.getUTCMonth(),
      currentWeekStart.getUTCDate() - i * 7
    ));
    const k = d.toISOString().slice(0, 10);
    if (k !== thisWeekKey) {
      weeks.push({ key: k, miles: Math.round((byWeek[k] ?? 0) * 10) / 10 });
    }
  }

  const weeklyMiles = weeks.map(w => w.miles);

  if (weeklyMiles.length < 2) {
    return { weeklyMiles, weekOverWeekChangePct: null, flagged: false, summary: "Insufficient weekly data for load trend." };
  }

  const recent = weeklyMiles[weeklyMiles.length - 1];
  const prior = weeklyMiles[weeklyMiles.length - 2];
  const weekOverWeekChangePct = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : null;
  const flagged = weekOverWeekChangePct !== null && weekOverWeekChangePct > 10;

  let summary: string;
  if (weeklyMiles.every(m => m === 0)) {
    summary = "No running activity in the last 8 weeks.";
  } else {
    const nonZero = weeklyMiles.filter(m => m > 0);
    const avg = Math.round((nonZero.reduce((s, m) => s + m, 0) / nonZero.length) * 10) / 10;
    summary = `8-week mileage trend: ${weeklyMiles.map(m => `${m}mi`).join(", ")} (avg ${avg}mi/week).`;
    if (weekOverWeekChangePct !== null) {
      const sign = weekOverWeekChangePct >= 0 ? "+" : "";
      summary += ` Most recent week: ${sign}${weekOverWeekChangePct}% vs prior week.`;
      if (flagged) {
        summary += ` ⚠️ Weekly mileage jumped >10% — mention load management if relevant.`;
      }
    }
  }

  return { weeklyMiles, weekOverWeekChangePct, flagged, summary };
}

/**
 * Compute aerobic efficiency trend from activities with HR and efficiency data.
 * Compares recent 4 weeks vs prior 4 weeks.
 * Higher aerobic_efficiency (m/beat) = more economical = improving fitness.
 */
export function computeAerobicEfficiencyTrend(
  activities: ActivityForAnalytics[],
  timezone: string
): AerobicEfficiencyResult {
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  const runsWithData = activities.filter(
    a => RUN_TYPES.has(a.activity_type ?? "") &&
      a.aerobic_efficiency != null &&
      a.aerobic_efficiency > 0 &&
      a.average_heartrate != null &&
      a.distance_meters != null &&
      a.distance_meters > 3000 // only runs ≥ 3km (avoids warmup noise)
  ).sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

  if (runsWithData.length < 4) {
    return { recentAvg: null, priorAvg: null, trend: "insufficient_data", summary: "Insufficient activity data for aerobic efficiency trend." };
  }

  const half = Math.ceil(runsWithData.length / 2);
  const recentRuns = runsWithData.slice(-half);
  const priorRuns = runsWithData.slice(0, -half);

  const avg = (runs: typeof runsWithData) =>
    runs.reduce((s, a) => s + (a.aerobic_efficiency ?? 0), 0) / runs.length;

  const recentAvg = Math.round(avg(recentRuns) * 1000) / 1000;
  const priorAvg = Math.round(avg(priorRuns) * 1000) / 1000;
  const changePct = priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0;

  let trend: AerobicEfficiencyResult["trend"];
  if (Math.abs(changePct) < 2) trend = "stable";
  else if (changePct > 0) trend = "improving";
  else trend = "worsening";

  const recentPacePerBpm = recentAvg > 0
    ? `${(1000 / recentAvg / 60).toFixed(2)} min/km per bpm`
    : "N/A";

  const effTrend: AerobicEfficiencyResult["trend"] = trend;
  const trendMsg = effTrend === "improving" ? "Aerobic base is developing well." : effTrend === "worsening" ? "Consider more easy running to rebuild the aerobic base." : "Efficiency is holding steady.";
  const summary = `Aerobic efficiency (recent ${recentRuns.length} runs): ${recentAvg.toFixed(3)} m/beat (${trend}, ${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}% vs prior period). ${trendMsg}`;

  return { recentAvg, priorAvg, trend, summary };
  void recentPacePerBpm; // suppress unused warning
}

/**
 * Compute cardiac drift (HR decoupling) trend from long run data.
 * Lower decoupling % = aerobic system held together = improving.
 * Only uses runs ≥ 10 miles where cardiac_decoupling_pct is stored.
 */
export function computeCardiacDriftTrend(
  activities: ActivityForAnalytics[]
): CardiacDriftResult {
  const longRuns = activities.filter(
    a => ["Run", "TrailRun", "VirtualRun", "Treadmill"].includes(a.activity_type ?? "") &&
      a.cardiac_decoupling_pct != null &&
      a.distance_meters != null &&
      a.distance_meters >= 16090 // ≥10 miles
  ).sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

  if (longRuns.length < 3) {
    return { recentAvg: null, trend: "insufficient_data", summary: "Insufficient long run data for cardiac drift trend." };
  }

  const half = Math.ceil(longRuns.length / 2);
  const recent = longRuns.slice(-half);
  const prior = longRuns.slice(0, -half);

  const avg = (runs: typeof longRuns) =>
    runs.reduce((s, a) => s + (a.cardiac_decoupling_pct ?? 0), 0) / runs.length;

  const recentAvg = Math.round(avg(recent) * 10) / 10;
  const priorAvg = prior.length > 0 ? Math.round(avg(prior) * 10) / 10 : null;

  let trend: CardiacDriftResult["trend"];
  if (priorAvg === null) trend = "insufficient_data";
  else if (Math.abs(recentAvg - priorAvg) < 1.5) trend = "stable";
  else if (recentAvg < priorAvg) trend = "improving"; // lower drift = better
  else trend = "worsening";

  const diffStr = priorAvg !== null ? ` (${recentAvg < (priorAvg ?? 0) ? "-" : "+"}${Math.abs(recentAvg - (priorAvg ?? 0)).toFixed(1)}pp vs prior)` : "";
  const summary = `HR drift on long runs (recent avg): ${recentAvg}%${diffStr}. ${recentAvg <= 5 ? "Excellent aerobic coupling — base is solid." : recentAvg <= 10 ? "Normal drift range — aerobic base developing." : "Higher drift suggests fatigue or aerobic base needs more easy mileage."}`;

  return { recentAvg, trend, summary };
}

// ─── ACWR ────────────────────────────────────────────────────────────────────

export interface ACWRResult {
  acuteLoad: number;
  chronicLoad: number;
  acwr: number | null;
  flagged: boolean;
  summary: string;
}

/**
 * Acute:Chronic Workload Ratio — 7-day acute load vs 28-day chronic average.
 * ACWR > 1.3 = injury risk zone (Tim Gabbett research).
 */
export function computeACWR(
  activities: ActivityForAnalytics[],
  timezone: string
): ACWRResult {
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  void timezone; // timezone-aware week bucketing not needed for rolling day windows

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twentyEightDaysAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

  const acuteMiles = activities
    .filter(a => RUN_TYPES.has(a.activity_type ?? "") && new Date(a.start_date) >= sevenDaysAgo)
    .reduce((sum, a) => sum + (a.distance_meters ?? 0) / 1609.34, 0);

  const chronicTotal = activities
    .filter(a => RUN_TYPES.has(a.activity_type ?? "") && new Date(a.start_date) >= twentyEightDaysAgo)
    .reduce((sum, a) => sum + (a.distance_meters ?? 0) / 1609.34, 0);
  const chronicLoad = chronicTotal / 4;

  if (chronicLoad < 1) {
    return { acuteLoad: acuteMiles, chronicLoad, acwr: null, flagged: false, summary: "Insufficient data for workload ratio." };
  }

  const acwr = Math.round((acuteMiles / chronicLoad) * 100) / 100;
  const flagged = acwr > 1.3;

  let summary = `Acute:chronic workload ratio: ${acwr.toFixed(2)} (7-day ${acuteMiles.toFixed(1)}mi vs 4-week avg ${chronicLoad.toFixed(1)}mi/week).`;
  if (flagged) {
    summary += ` ⚠️ In the high injury-risk zone (>1.3). This week's load significantly exceeds the rolling average — consider scaling back or adding an easy day.`;
  } else if (acwr < 0.7 && acuteMiles > 0) {
    summary += ` Load is well below the chronic average — good recovery week or planned step-back.`;
  }

  return { acuteLoad: acuteMiles, chronicLoad, acwr, flagged, summary };
}

// ─── Long run progression ─────────────────────────────────────────────────────

export interface LongRunProgressionResult {
  weeklyLongestRuns: number[];
  trend: "improving" | "stagnating" | "overreaching" | "insufficient_data";
  summary: string;
}

/**
 * Track the longest run per week over 8 weeks.
 * Flags stagnation (no growth in 4+ weeks) and overreaching (>25% single-week jump).
 */
export function computeLongRunProgression(
  activities: ActivityForAnalytics[],
  timezone: string
): LongRunProgressionResult {
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  const longestByWeek: Record<string, number> = {};
  for (const a of activities) {
    if (!RUN_TYPES.has(a.activity_type ?? "")) continue;
    if (!a.distance_meters || !a.start_date) continue;
    const k = weekKey(new Date(a.start_date), timezone);
    const miles = a.distance_meters / 1609.34;
    if (!longestByWeek[k] || miles > longestByWeek[k]) longestByWeek[k] = miles;
  }

  // Anchor at the start of this week in the target TZ, then step back 7-day
  // increments from that Monday — same fix as computeLoadTrend.
  const now = new Date();
  const currentWeekStart = getWeekStart(now, timezone);
  const thisWeekKey = currentWeekStart.toISOString().slice(0, 10);
  const weeks: number[] = [];
  for (let i = 8; i >= 1; i--) {
    const d = new Date(Date.UTC(
      currentWeekStart.getUTCFullYear(),
      currentWeekStart.getUTCMonth(),
      currentWeekStart.getUTCDate() - i * 7
    ));
    const k = d.toISOString().slice(0, 10);
    if (k !== thisWeekKey) {
      weeks.push(Math.round((longestByWeek[k] ?? 0) * 10) / 10);
    }
  }

  // Peek at current week's longest run separately — needed for overreach detection
  // but excluded from stagnation detection (week may be incomplete).
  const currentWeekLongest = Math.round((longestByWeek[thisWeekKey] ?? 0) * 10) / 10;

  const nonZero = weeks.filter(m => m > 0);
  if (nonZero.length < 3) {
    return { weeklyLongestRuns: weeks, trend: "insufficient_data", summary: "Insufficient data for long run progression." };
  }

  // Overreach: current week's long run jumped >25% vs most recent completed week.
  // Also catches jumps within completed weeks (lastTwo of nonZero).
  const lastCompletedLong = nonZero[nonZero.length - 1] ?? 0;
  const currentWeekJump = currentWeekLongest > 0 && lastCompletedLong > 0
    && currentWeekLongest > lastCompletedLong * 1.25 && currentWeekLongest > 8;
  const lastTwo = nonZero.slice(-2);
  const completedJump = lastTwo.length === 2 && lastTwo[1]! > lastTwo[0]! * 1.25 && lastTwo[1]! > 8;
  const jumpDetected = currentWeekJump || completedJump;

  // Stagnation: recent 4 long runs within 1 mile of each other (flat plateau)
  const recent4 = weeks.slice(-4).filter(m => m > 0);
  const isStagnating = recent4.length >= 4 &&
    Math.max(...recent4) - Math.min(...recent4) < 1.0 &&
    Math.max(...recent4) > 5;

  let trend: LongRunProgressionResult["trend"];
  if (jumpDetected) trend = "overreaching";
  else if (isStagnating) trend = "stagnating";
  else trend = "improving";

  const summary = `Long run progression (last 8 weeks, longest per week): ${nonZero.map(m => `${m}mi`).join(", ")}.${
    trend === "overreaching" ? ` ⚠️ Long run jumped >25% in one week — high overreach risk, encourage a step-back.` :
    trend === "stagnating" ? ` Long run has plateaued for 4+ weeks — consider adding 1-2 miles if the athlete feels ready.` : ""
  }`;

  return { weeklyLongestRuns: weeks, trend, summary };
}

// ─── Intensity distribution ───────────────────────────────────────────────────

export interface IntensityDistributionResult {
  easyPct: number;
  moderatePct: number;
  hardPct: number;
  observedMaxHR: number | null;
  inZone3Trap: boolean;
  summary: string;
}

/**
 * Classify runs by HR intensity relative to observed max HR.
 * Easy: <75% of max  Moderate (zone 3): 75-88%  Hard: >88%
 * The "zone 3 trap" = spending most training time in moderate intensity,
 * which accumulates fatigue without the aerobic gains of easy running
 * or the speed gains of hard running.
 *
 * Pass `estimatedMaxHR` from `estimateMaxHR()` (hr-utils) for the most accurate
 * zone classification. If omitted, this function will compute it itself using
 * the same tiered approach (race > workout > all-runs, with spike filtering).
 * Never use raw Math.max(max_heartrate) — single-run sensor spikes will inflate
 * the denominator and shift every classification down a zone.
 */
export function computeIntensityDistribution(
  activities: ActivityForAnalytics[],
  estimatedMaxHR?: number | null
): IntensityDistributionResult {
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  const runsWithHR = activities.filter(
    a => RUN_TYPES.has(a.activity_type ?? "") &&
      a.average_heartrate != null &&
      a.average_heartrate > 90 &&
      a.distance_meters != null &&
      a.distance_meters > 1600
  );

  if (runsWithHR.length < 5) {
    return { easyPct: 0, moderatePct: 0, hardPct: 0, observedMaxHR: null, inZone3Trap: false, summary: "Insufficient HR data for intensity distribution." };
  }

  const observedMaxHR = estimatedMaxHR ?? estimateMaxHR(activities);

  if (!observedMaxHR || observedMaxHR < 130) {
    return { easyPct: 0, moderatePct: 0, hardPct: 0, observedMaxHR: null, inZone3Trap: false, summary: "Insufficient HR data for intensity distribution." };
  }

  let easy = 0, moderate = 0, hard = 0;
  for (const a of runsWithHR) {
    const intensity = (a.average_heartrate ?? 0) / observedMaxHR;
    if (intensity < 0.75) easy++;
    else if (intensity < 0.88) moderate++;
    else hard++;
  }

  const total = runsWithHR.length;
  const easyPct = Math.round(easy / total * 100);
  const moderatePct = Math.round(moderate / total * 100);
  const hardPct = Math.round(hard / total * 100);
  const inZone3Trap = moderatePct > 50;

  let summary = `Training intensity distribution (${total} runs with HR): ${easyPct}% easy, ${moderatePct}% moderate, ${hardPct}% hard.`;
  if (inZone3Trap) {
    summary += ` ⚠️ Most runs are in the moderate "gray zone" — accumulating fatigue without the aerobic or speed benefits of proper easy/hard polarization. Encourage easier easy days.`;
  } else if (easyPct >= 75) {
    summary += ` Good polarized distribution (80/20 model).`;
  }

  return { easyPct, moderatePct, hardPct, observedMaxHR, inZone3Trap, summary };
}

// ─── Cadence trend ────────────────────────────────────────────────────────────

export interface CadenceTrendResult {
  recentAvgSpm: number | null;
  trend: "improving" | "declining" | "stable" | "insufficient_data";
  flaggedLow: boolean;
  summary: string;
}

/**
 * Average cadence (spm) trend over recent runs.
 * Strava stores per-foot steps per minute. Target: 170-180 spm.
 * Below 170 = overstriding risk.
 */
export function computeCadenceTrend(
  activities: ActivityForAnalytics[]
): CadenceTrendResult {
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  const runsWithCadence = activities.filter(
    a => RUN_TYPES.has(a.activity_type ?? "") &&
      a.average_cadence != null &&
      a.average_cadence > 100 &&
      a.distance_meters != null &&
      a.distance_meters > 1600
  ).sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

  if (runsWithCadence.length < 4) {
    return { recentAvgSpm: null, trend: "insufficient_data", flaggedLow: false, summary: "Insufficient cadence data." };
  }

  const half = Math.ceil(runsWithCadence.length / 2);
  const recent = runsWithCadence.slice(-half);
  const prior = runsWithCadence.slice(0, -half);

  const avg = (runs: typeof runsWithCadence) =>
    Math.round(runs.reduce((s, a) => s + (a.average_cadence ?? 0), 0) / runs.length);

  const recentAvg = avg(recent);
  const priorAvg = prior.length > 0 ? avg(prior) : null;
  const flaggedLow = recentAvg < 170;

  let trend: CadenceTrendResult["trend"];
  if (priorAvg === null || Math.abs(recentAvg - priorAvg) < 3) trend = "stable";
  else if (recentAvg > priorAvg) trend = "improving";
  else trend = "declining";

  let summary = `Cadence: avg ${recentAvg} spm.`;
  if (flaggedLow) {
    summary += ` ⚠️ Below 170 spm target — associated with overstriding and elevated injury risk. Suggest focus on quicker turnover on easy runs.`;
  } else if (trend === "improving" && priorAvg !== null) {
    summary += ` Up from ${priorAvg} spm — good turnover improvement.`;
  }

  return { recentAvgSpm: recentAvg, trend, flaggedLow, summary };
}

// ─── Elevation load trend ─────────────────────────────────────────────────────

export interface ElevationLoadResult {
  weeklyVertFeet: number[];
  trend: "increasing" | "decreasing" | "stable" | "insufficient_data";
  avgWeeklyVertFeet: number;
  summary: string;
}

/**
 * Weekly vertical gain in feet over 8 weeks.
 * Only meaningful for trail runners or anyone with consistent vert (>200ft/week avg).
 */
export function computeElevationLoadTrend(
  activities: ActivityForAnalytics[],
  timezone: string
): ElevationLoadResult {
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  const byWeek: Record<string, number> = {};
  for (const a of activities) {
    if (!RUN_TYPES.has(a.activity_type ?? "")) continue;
    if (!a.elevation_gain || !a.start_date) continue;
    const k = weekKey(new Date(a.start_date), timezone);
    byWeek[k] = (byWeek[k] ?? 0) + a.elevation_gain * 3.28084; // meters to feet
  }

  const now = new Date();
  const thisWeekKey = weekKey(now, timezone);
  const weeks: number[] = [];
  for (let i = 8; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i * 7));
    const k = weekKey(d, timezone);
    if (k !== thisWeekKey) {
      weeks.push(Math.round(byWeek[k] ?? 0));
    }
  }

  const nonZero = weeks.filter(v => v > 0);
  const avgWeeklyVertFeet = nonZero.length > 0
    ? Math.round(nonZero.reduce((s, v) => s + v, 0) / nonZero.length)
    : 0;

  if (nonZero.length < 3 || avgWeeklyVertFeet < 200) {
    return { weeklyVertFeet: weeks, trend: "insufficient_data", avgWeeklyVertFeet, summary: "Insufficient elevation data for vert trend." };
  }

  const recent4 = weeks.slice(-4).filter(v => v > 0);
  const prior4 = weeks.slice(0, -4).filter(v => v > 0);
  const recentAvg = recent4.length > 0 ? recent4.reduce((s, v) => s + v, 0) / recent4.length : 0;
  const priorAvg = prior4.length > 0 ? prior4.reduce((s, v) => s + v, 0) / prior4.length : 0;

  let trend: ElevationLoadResult["trend"];
  if (priorAvg === 0) trend = "insufficient_data";
  else if (recentAvg > priorAvg * 1.15) trend = "increasing";
  else if (recentAvg < priorAvg * 0.85) trend = "decreasing";
  else trend = "stable";

  const summary = `Elevation load (avg ${avgWeeklyVertFeet.toLocaleString()}ft/week over last 8 weeks). Trend: ${trend}.${
    trend === "increasing" ? " Vert is climbing — monitor for accumulated quad/calf fatigue." : ""
  }`;

  return { weeklyVertFeet: weeks, trend, avgWeeklyVertFeet, summary };
}

// ─── Interval pattern detection ──────────────────────────────────────────────

interface RawLap {
  distance: number;       // meters
  moving_time: number;    // seconds
  average_speed: number;  // m/s
  pace_zone?: number;     // 1–5 (Strava zone)
}

/**
 * Detect structured interval workouts from Strava lap data.
 *
 * Returns a plain-English summary string for injection into the coaching prompt,
 * or null if no clear interval structure is found.
 *
 * Handles two patterns:
 *   1. Alternating intervals — short laps flip between hard (zone 4–5) and easy (zone 1–2)
 *   2. Single tempo block — one or more consecutive long hard laps bookended by easy laps
 *
 * Warmup/cooldown laps are detected as long-distance laps (>400m AND >2min) that appear
 * at the start or end of the session.
 */
export function detectIntervalPattern(laps: RawLap[]): string | null {
  if (!laps || laps.length < 4) return null;

  const fmtPaceStr = (speedMs: number): string => {
    if (speedMs <= 0) return "?";
    const minPerMile = 1609.34 / speedMs / 60;
    const totalSec = Math.round(minPerMile * 60);
    return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}/mi`;
  };

  const fmtDur = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}sec`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}min ${s}sec` : `${m}min`;
  };

  // Classify each lap as "long" (likely warmup/cooldown) or "short" (likely interval press)
  const isLong = (lap: RawLap) => lap.distance > 400 && lap.moving_time > 120;

  // Peel warmup laps from the front and cooldown laps from the back
  let start = 0;
  while (start < laps.length && isLong(laps[start])) start++;
  let end = laps.length - 1;
  while (end > start && isLong(laps[end])) end--;

  const warmupLaps = laps.slice(0, start);
  const cooldownLaps = laps.slice(end + 1);
  const middleLaps = laps.slice(start, end + 1);

  if (middleLaps.length < 2) return null;

  // ── Pattern 1: Alternating intervals ─────────────────────────────────────
  // Hard laps: pace_zone >= 4 OR significantly faster than the median pace
  // Recovery laps: pace_zone <= 2 OR significantly slower than median

  const speeds = middleLaps.map(l => l.average_speed).filter(s => s > 0).sort((a, b) => a - b);
  const medianSpeed = speeds[Math.floor(speeds.length / 2)] ?? 0;
  // "Hard" = top 40% of speeds observed; "easy" = bottom 40%
  const hardThreshold = speeds[Math.floor(speeds.length * 0.6)] ?? medianSpeed;
  const easyThreshold = speeds[Math.floor(speeds.length * 0.4)] ?? medianSpeed;

  const classify = (lap: RawLap): "hard" | "easy" | "mixed" => {
    if (lap.pace_zone != null) {
      if (lap.pace_zone >= 4) return "hard";
      if (lap.pace_zone <= 2) return "easy";
    }
    if (lap.average_speed >= hardThreshold) return "hard";
    if (lap.average_speed <= easyThreshold) return "easy";
    return "mixed";
  };

  const classified = middleLaps.map(classify);

  // Count alternating pairs: consecutive hard→easy or easy→hard transitions
  let transitions = 0;
  for (let i = 1; i < classified.length; i++) {
    if (classified[i] !== classified[i - 1] && classified[i] !== "mixed" && classified[i - 1] !== "mixed") {
      transitions++;
    }
  }
  const isAlternating = transitions >= Math.floor(middleLaps.length * 0.6);

  if (isAlternating) {
    const hardLaps = middleLaps.filter((_, i) => classified[i] === "hard");
    const easyLaps = middleLaps.filter((_, i) => classified[i] === "easy");

    if (hardLaps.length < 2) return null;

    const avgHardSpeed = hardLaps.reduce((s, l) => s + l.average_speed, 0) / hardLaps.length;
    const avgEasySpeed = easyLaps.length > 0
      ? easyLaps.reduce((s, l) => s + l.average_speed, 0) / easyLaps.length
      : null;
    const medianHardDur = [...hardLaps].sort((a, b) => a.moving_time - b.moving_time)[Math.floor(hardLaps.length / 2)].moving_time;
    const medianEasyDur = easyLaps.length > 0
      ? [...easyLaps].sort((a, b) => a.moving_time - b.moving_time)[Math.floor(easyLaps.length / 2)].moving_time
      : null;

    const totalWarmupMi = warmupLaps.reduce((s, l) => s + l.distance, 0) / 1609.34;
    const warmupDesc = warmupLaps.length > 0
      ? `${totalWarmupMi.toFixed(1)}mi warmup, then `
      : "";
    const totalCooldownMi = cooldownLaps.reduce((s, l) => s + l.distance, 0) / 1609.34;
    const cooldownDesc = cooldownLaps.length > 0
      ? `, then ${totalCooldownMi.toFixed(1)}mi cooldown`
      : "";
    const recoveryDesc = avgEasySpeed != null && medianEasyDur != null
      ? ` alternating with ~${fmtDur(medianEasyDur)} recoveries (~${fmtPaceStr(avgEasySpeed)})`
      : "";

    return `INTERVAL WORKOUT DETECTED: ${warmupDesc}${hardLaps.length}×~${fmtDur(medianHardDur)} hard efforts (~${fmtPaceStr(avgHardSpeed)})${recoveryDesc}${cooldownDesc}. Focus your feedback on the interval execution — do NOT describe this run primarily by its overall average pace, and do NOT call it a continuous easy run or tempo run.`;
  }

  // ── Pattern 2: Single tempo block ────────────────────────────────────────
  // One or more consecutive hard laps in the middle, bookended by easy laps
  const hardIndices = classified.map((c, i) => (c === "hard" ? i : -1)).filter(i => i >= 0);
  if (hardIndices.length >= 1 && hardLaps(classified)) {
    const tempoLaps = middleLaps.filter((_, i) => classified[i] === "hard");
    const totalTempoMeters = tempoLaps.reduce((s, l) => s + l.distance, 0);
    const avgTempoSpeed = tempoLaps.reduce((s, l) => s + l.average_speed, 0) / tempoLaps.length;
    const tempoMiles = (totalTempoMeters / 1609.34).toFixed(1);

    const warmupDesc = warmupLaps.length > 0
      ? `${(warmupLaps.reduce((s, l) => s + l.distance, 0) / 1609.34).toFixed(1)}mi warmup, then `
      : "";
    const cooldownMi = (cooldownLaps.reduce((s, l) => s + l.distance, 0) / 1609.34).toFixed(1);
    const cooldownDesc = cooldownLaps.length > 0
      ? `, then ${cooldownMi}mi cooldown`
      : "";

    return `TEMPO/THRESHOLD WORKOUT DETECTED: ${warmupDesc}${tempoMiles}mi at sustained hard effort (~${fmtPaceStr(avgTempoSpeed)})${cooldownDesc}. Treat this as a threshold run — do NOT describe it as an easy run.`;
  }

  return null;
}

// Helper: checks that hard laps form a contiguous block (not scattered)
function hardLaps(classified: ("hard" | "easy" | "mixed")[]): boolean {
  const firstHard = classified.indexOf("hard");
  const lastHard = classified.lastIndexOf("hard");
  if (firstHard === -1) return false;
  // All laps between first and last hard should be hard or mixed (no easy gaps)
  for (let i = firstHard; i <= lastHard; i++) {
    if (classified[i] === "easy") return false;
  }
  return true;
}

// ─── Run execution quality ────────────────────────────────────────────────────

interface StravaSplit {
  average_speed: number;                    // m/s (raw)
  moving_time: number;                      // seconds
  distance: number;                         // meters
  elevation_difference?: number;            // meters (positive = gain, negative = loss)
  average_grade_adjusted_speed?: number;   // m/s (GAP from Strava)
}

export interface RunExecutionResult {
  firstHalfPaceMinPerMile: number | null;
  secondHalfPaceMinPerMile: number | null;
  fadeSecs: number | null;  // positive = positive split (slower 2nd half)
  executionQuality: "negative_split" | "even" | "positive_split" | "significant_fade" | "insufficient_data";
  summary: string;
}

/**
 * Analyze pace execution from per-mile Strava splits.
 * Compares first-half pace vs second-half pace to detect fade or negative splits.
 * Only meaningful for runs with ≥4 complete-mile splits.
 */
export function buildRunExecutionAnalysis(
  splits: StravaSplit[] | null | undefined
): RunExecutionResult {
  const empty: RunExecutionResult = { firstHalfPaceMinPerMile: null, secondHalfPaceMinPerMile: null, fadeSecs: null, executionQuality: "insufficient_data", summary: "" };

  if (!splits || splits.length < 4) return empty;

  // Filter out partial last splits (less than ~80% of a full mile)
  const fullSplits = splits.filter(s => s.average_speed > 0 && s.distance >= 1287);
  if (fullSplits.length < 3) return empty;

  // Use grade-adjusted speed (GAP) when available on the majority of splits — it accounts
  // for elevation so we don't credit a downhill second half as "pacing discipline".
  const gapCount = fullSplits.filter(s => s.average_grade_adjusted_speed != null && s.average_grade_adjusted_speed > 0).length;
  const useGap = gapCount >= Math.ceil(fullSplits.length / 2);

  // m/s to min/mi: 1 mile = 1609.34m; pace = (1609.34 / speed) / 60
  const paces = fullSplits.map(s => {
    const speed = useGap && s.average_grade_adjusted_speed != null && s.average_grade_adjusted_speed > 0
      ? s.average_grade_adjusted_speed
      : s.average_speed;
    return 1609.34 / speed / 60;
  });

  const half = Math.floor(paces.length / 2);
  const avgFirst = paces.slice(0, half).reduce((s, p) => s + p, 0) / half;
  const avgSecond = paces.slice(-half).reduce((s, p) => s + p, 0) / half;

  const fadeSecs = Math.round((avgSecond - avgFirst) * 60);

  // When GAP is not available, detect elevation-assisted second-half to avoid misleading notes.
  // Net elevation change per half: negative = net loss (downhill).
  const firstHalfElevNet = !useGap && fullSplits.slice(0, half).reduce((sum, s) => sum + (s.elevation_difference ?? 0), 0);
  const secondHalfElevNet = !useGap && fullSplits.slice(-half).reduce((sum, s) => sum + (s.elevation_difference ?? 0), 0);
  // Flag if second half has >50m more net descent than first half
  const elevationAssistedSecondHalf = typeof firstHalfElevNet === "number" && typeof secondHalfElevNet === "number"
    && (firstHalfElevNet - secondHalfElevNet) > 50;

  const fmt = (minPerMile: number) => {
    const totalSec = Math.round(minPerMile * 60);
    return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
  };

  let executionQuality: RunExecutionResult["executionQuality"];
  if (fadeSecs <= -6) executionQuality = "negative_split";
  else if (Math.abs(fadeSecs) <= 6) executionQuality = "even";
  else if (fadeSecs <= 15) executionQuality = "positive_split";
  else executionQuality = "significant_fade";

  const paceLabel = useGap ? "grade-adjusted pace" : "pace";
  const gapNote = useGap ? " (grade-adjusted for elevation)" : "";

  let summary = "";
  if (executionQuality === "significant_fade") {
    summary = `PACING NOTE: ${paceLabel.charAt(0).toUpperCase() + paceLabel.slice(1)} faded ${fadeSecs}s/mi from first half (${fmt(avgFirst)}/mi${gapNote}) to second half (${fmt(avgSecond)}/mi) — likely went out too fast. Mention this once with a note on conservative starts.`;
  } else if (executionQuality === "negative_split") {
    if (useGap) {
      summary = `PACING NOTE: Excellent negative split (grade-adjusted) — ran ${Math.abs(fadeSecs)}s/mi faster in the second half (${fmt(avgFirst)}/mi → ${fmt(avgSecond)}/mi GAP). This reflects genuine pacing discipline even accounting for elevation changes.`;
    } else if (elevationAssistedSecondHalf) {
      summary = `PACING NOTE: Pace was faster in the second half (${fmt(avgFirst)}/mi → ${fmt(avgSecond)}/mi) but the course descended in the second half — this is likely elevation-assisted, not a genuine negative split. Acknowledge the faster second half but attribute it to the downhill terrain.`;
    } else {
      summary = `PACING NOTE: Excellent negative split — ran ${Math.abs(fadeSecs)}s/mi faster in the second half (${fmt(avgFirst)}/mi → ${fmt(avgSecond)}/mi). Strong pacing discipline worth acknowledging.`;
    }
  } else if (executionQuality === "even") {
    summary = `PACING NOTE: Very even pacing across the run (${fmt(avgFirst)}/mi first half vs ${fmt(avgSecond)}/mi second half${gapNote}). Good execution.`;
  }
  // positive_split (small fade): not worth a specific note — common and minor

  return {
    firstHalfPaceMinPerMile: Math.round(avgFirst * 100) / 100,
    secondHalfPaceMinPerMile: Math.round(avgSecond * 100) / 100,
    fadeSecs,
    executionQuality,
    summary,
  };
}

// ─── Combined longitudinal block ──────────────────────────────────────────────

/**
 * Build a combined longitudinal analysis block for the coaching system prompt.
 * Returns an empty string if there's insufficient data for any meaningful insight.
 */
export function buildLongitudinalBlock(
  activities: ActivityForAnalytics[],
  timezone: string,
  estimatedMaxHR?: number | null
): string {
  const load = computeLoadTrend(activities, timezone);
  const acwr = computeACWR(activities, timezone);
  const efficiency = computeAerobicEfficiencyTrend(activities, timezone);
  const drift = computeCardiacDriftTrend(activities);
  const longRun = computeLongRunProgression(activities, timezone);
  const intensity = computeIntensityDistribution(activities, estimatedMaxHR);
  const cadence = computeCadenceTrend(activities);
  const elevation = computeElevationLoadTrend(activities, timezone);

  const lines: string[] = [];

  // Load trend + ACWR
  if (load.weeklyMiles.some(m => m > 0)) lines.push(load.summary);
  if (acwr.acwr !== null && (acwr.flagged || acwr.acwr < 0.7)) lines.push(acwr.summary);

  // Long run progression — only when there's something actionable
  if (longRun.trend === "stagnating" || longRun.trend === "overreaching") lines.push(longRun.summary);

  // Aerobic efficiency + cardiac drift
  if (efficiency.trend !== "insufficient_data") lines.push(efficiency.summary);
  if (drift.trend !== "insufficient_data") lines.push(drift.summary);

  // Intensity distribution — only when the zone 3 trap is present
  if (intensity.inZone3Trap) lines.push(intensity.summary);

  // Cadence — only when flagged low (actionable)
  if (cadence.trend !== "insufficient_data" && cadence.flaggedLow) lines.push(cadence.summary);

  // Elevation load — only for runners with significant vert (trail/mountain)
  if (elevation.trend !== "insufficient_data" && elevation.avgWeeklyVertFeet > 500) lines.push(elevation.summary);

  if (lines.length === 0) return "";

  return `LONGITUDINAL TRAINING ANALYSIS (8-week trends):
${lines.join("\n")}
CITATION RULE: When referencing any value from this block, quote it directly — do NOT paraphrase or round it. Only cite a metric if its value appears explicitly above. If a metric is not listed here, do not reference it at all.

`;
}

export interface LongitudinalSignals {
  hasLoadSpike: boolean;
  hasLongRunPlateau: boolean;
  hasZone3Trap: boolean;
  requiredMentions: string[];
}

/**
 * Returns structured flags for high-signal longitudinal patterns that Dean MUST address.
 * Separate from buildLongitudinalBlock so callers can inject a required-mention directive
 * alongside the data block rather than burying the obligation in the data itself.
 */
export function buildLongitudinalSignals(
  activities: ActivityForAnalytics[],
  timezone: string,
  estimatedMaxHR?: number | null
): LongitudinalSignals {
  const acwr = computeACWR(activities, timezone);
  const longRun = computeLongRunProgression(activities, timezone);
  const intensity = computeIntensityDistribution(activities, estimatedMaxHR);

  const requiredMentions: string[] = [];
  const hasLoadSpike = acwr.flagged;
  const hasLongRunPlateau = longRun.trend === "stagnating";
  const hasZone3Trap = intensity.inZone3Trap;

  if (hasLoadSpike) {
    requiredMentions.push(`load spike (ACWR ~${acwr.acwr?.toFixed(2) ?? "high"} — in injury risk zone)`);
  }
  if (hasLongRunPlateau) {
    requiredMentions.push("4-week long run plateau (no progression)");
  }
  if (hasZone3Trap) {
    requiredMentions.push("zone 3 intensity trap (too much moderate effort, not enough easy or hard)");
  }

  return { hasLoadSpike, hasLongRunPlateau, hasZone3Trap, requiredMentions };
}
