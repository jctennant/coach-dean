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

export interface ActivityForAnalytics {
  start_date: string;
  activity_type: string | null;
  distance_meters: number | null;
  moving_time_seconds: number | null;
  average_heartrate: number | null;
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

  // Build the last 8 complete weeks (exclude the current partial week)
  const now = new Date();
  const thisWeekKey = weekKey(now, timezone);
  const weeks: Array<{ key: string; miles: number }> = [];
  for (let i = 8; i >= 1; i--) {
    const d = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - i * 7
    ));
    const k = weekKey(d, timezone);
    if (k !== thisWeekKey) {
      weeks.push({ key: k, miles: Math.round((byWeek[k] ?? 0) * 10) / 10 });
    }
  }

  // Remove trailing duplicate keys
  const seen = new Set<string>();
  const dedupedWeeks = weeks.filter(w => {
    if (seen.has(w.key)) return false;
    seen.add(w.key);
    return true;
  });

  const weeklyMiles = dedupedWeeks.map(w => w.miles);

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

/**
 * Build a combined longitudinal analysis block for the coaching system prompt.
 * Returns an empty string if there's insufficient data for any meaningful insight.
 */
export function buildLongitudinalBlock(
  activities: ActivityForAnalytics[],
  timezone: string
): string {
  const load = computeLoadTrend(activities, timezone);
  const efficiency = computeAerobicEfficiencyTrend(activities, timezone);
  const drift = computeCardiacDriftTrend(activities);

  const lines: string[] = [];
  if (load.weeklyMiles.some(m => m > 0)) lines.push(load.summary);
  if (efficiency.trend !== "insufficient_data") lines.push(efficiency.summary);
  if (drift.trend !== "insufficient_data") lines.push(drift.summary);

  if (lines.length === 0) return "";

  return `LONGITUDINAL TRAINING ANALYSIS (8-week trends — use this context to make insights actionable, not just descriptive):
${lines.join("\n")}
Use these signals to inform your post-run insights — e.g. flag a load spike, acknowledge improving aerobic efficiency, or note if long-run HR drift is improving. Do not just repeat these stats verbatim — synthesize them into 1 actionable coaching observation.

`;
}
