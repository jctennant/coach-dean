/**
 * Cross-training utility functions for Coach Dean.
 * Handles effort classification, aerobic equivalent minutes, and context building
 * for non-run Strava activities (bikes, swims, hikes, etc.).
 */

export const BIKE_TYPES = new Set([
  "Ride", "VirtualRide", "EBikeRide", "MountainBikeRide", "GravelRide",
]);

export const SWIM_TYPES = new Set(["Swim", "OpenWaterSwim"]);

export const CROSS_TRAINING_TYPES = new Set([
  ...BIKE_TYPES, ...SWIM_TYPES,
  "Rowing", "Elliptical", "StairStepper", "Hike", "Walk",
  "WeightTraining", "Yoga", "Pilates", "Crossfit",
]);

const CROSS_TRAINING_RE = /\b(strength|mobility|stretch|yoga|bike|biking|cycling|swim|swimming|elliptical|cross.train|zwift|spin|row|rowing|hike|hiking)\b/i;

export function isCrossTrainingSession(label: string): boolean {
  return CROSS_TRAINING_RE.test(label);
}

export type CrossTrainingEffort = "easy" | "moderate" | "hard";

export function classifyCrossTrainingEffort(params: {
  activityType: string;
  movingTimeSeconds: number | null;
  averageHeartrate: number | null;
  averageWatts: number | null;
  workoutType: number | null;
  activityName: string | null;
  lthrEstimate: number | null;
}): { effort: CrossTrainingEffort; rationale: string } {
  const { activityType, averageHeartrate, averageWatts, workoutType, activityName, lthrEstimate } = params;

  // Activity name carries the athlete's own intent — highest confidence
  if (activityName) {
    const name = activityName.toLowerCase();
    if (/\b(easy|recovery|z1|z2|base|endurance|aerobic|active recovery)\b/.test(name)) {
      return { effort: "easy", rationale: "activity name indicates easy effort" };
    }
    if (/\b(tempo|threshold|sweetspot|sweet spot|interval|hard|ftp|race|vo2|effort|push)\b/.test(name)) {
      return { effort: "hard", rationale: "activity name indicates hard effort" };
    }
  }

  // workout_type=3 means athlete tagged it as a structured workout in Strava
  if (workoutType === 3) {
    return { effort: "hard", rationale: "athlete tagged as workout in Strava" };
  }

  // HR vs LTHR: most reliable objective signal
  if (averageHeartrate != null && lthrEstimate != null) {
    const pct = averageHeartrate / lthrEstimate;
    if (pct < 0.82) return { effort: "easy", rationale: "avg HR below 82% LTHR (Z1-Z2)" };
    if (pct < 0.94) return { effort: "moderate", rationale: "avg HR 82–94% LTHR (Z3)" };
    return { effort: "hard", rationale: "avg HR above 94% LTHR (Z4-Z5)" };
  }

  // Power proxy for cycling (no FTP stored — rough absolute thresholds)
  if (BIKE_TYPES.has(activityType) && averageWatts != null) {
    if (averageWatts < 150) return { effort: "easy", rationale: "low average watts" };
    if (averageWatts < 220) return { effort: "moderate", rationale: "moderate average watts" };
    return { effort: "hard", rationale: "high average watts" };
  }

  return { effort: "moderate", rationale: "insufficient data — defaulting to moderate" };
}

export function computeAerobicMinutes(
  activityType: string,
  movingTimeSeconds: number | null,
  effort: CrossTrainingEffort,
): number {
  if (!movingTimeSeconds) return 0;
  const minutes = movingTimeSeconds / 60;
  const category = BIKE_TYPES.has(activityType) ? "bike"
    : SWIM_TYPES.has(activityType) ? "swim"
    : "other";
  const mults: Record<string, Record<CrossTrainingEffort, number>> = {
    bike:  { easy: 0.50, moderate: 0.65, hard: 0.80 },
    swim:  { easy: 0.60, moderate: 0.75, hard: 0.90 },
    other: { easy: 0.50, moderate: 0.60, hard: 0.70 },
  };
  return Math.round(minutes * mults[category][effort]);
}

function fmtDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}min` : `${h}h`;
}

function phaseGuidance(phase: string | null, effort: CrossTrainingEffort): string {
  const p = (phase ?? "base").toLowerCase();
  if (p === "taper" || p === "peak") {
    return effort === "hard"
      ? "Taper/peak phase — this was an intense session. One sentence noting it's fine but remind them to protect their legs for the race."
      : "Taper/peak phase — easy cross-training here is ideal active recovery. Acknowledge that.";
  }
  if (p === "build") {
    return effort === "hard"
      ? "Build phase — a quality cross-training effort adds real aerobic stimulus. Count it as a quality session this week."
      : "Build phase — easy cross-training adds aerobic volume without run load. Good complement to the run build.";
  }
  // base / deload / default
  return effort === "hard"
    ? "Base phase — a hard cross-training session is a quality aerobic stimulus. Note that it contributes to the week's overall training load."
    : "Base phase — easy cross-training is perfect here. Aerobic base building without pounding.";
}

/**
 * Builds the context block injected into the user message for non-run post-activity messages.
 */
export function buildCrossTrainingContext(params: {
  activityType: string;
  activityName: string | null;
  movingTimeSeconds: number | null;
  averageHeartrate: number | null;
  averageWatts: number | null;
  workoutType: number | null;
  lthrEstimate: number | null;
  crosstrainingTools: string[] | null;
  phase: string | null;
  weekAerobicMinutesSoFar: number;
  weekRunMileageSoFar: number;
  useMetric: boolean;
}): string {
  const { activityType, activityName, movingTimeSeconds, averageHeartrate, averageWatts,
    workoutType, lthrEstimate, crosstrainingTools, phase, weekAerobicMinutesSoFar,
    weekRunMileageSoFar, useMetric } = params;

  const { effort, rationale } = classifyCrossTrainingEffort({
    activityType, movingTimeSeconds, averageHeartrate, averageWatts,
    workoutType, activityName, lthrEstimate,
  });
  const aerobicMins = computeAerobicMinutes(activityType, movingTimeSeconds, effort);
  const totalMinsThisWeek = weekAerobicMinutesSoFar + aerobicMins;
  const durationStr = movingTimeSeconds ? fmtDuration(movingTimeSeconds) : "unknown duration";
  const runLoadStr = useMetric
    ? `${(weekRunMileageSoFar * 1.60934).toFixed(1)} km`
    : `${weekRunMileageSoFar.toFixed(1)} mi`;

  const lines = [
    `CROSS-TRAINING ACTIVITY: ${activityType}${activityName ? ` ("${activityName}")` : ""}`,
    `Duration: ${durationStr} | Effort: ${effort} (${rationale})`,
    `Aerobic equivalent for this session: ~${aerobicMins} aerobic minutes`,
    `Week cross-training total (including this): ~${totalMinsThisWeek} aerobic minutes`,
    `Running this week: ${runLoadStr}`,
    `Phase: ${(phase ?? "base").toLowerCase()} — ${phaseGuidance(phase, effort)}`,
    ``,
    `RESPONSE GUIDELINES:`,
    `- 2–4 sentences. No generic openers. Don't treat this like a run debrief.`,
    `- Reference something specific from the session (effort level, duration, what it does for their fitness).`,
    `- Do NOT cite the week's running mileage total in this response.`,
    effort === "hard"
      ? `- This was a quality effort — acknowledge the training stimulus it provided, not just "great job cross-training".`
      : `- Easy cross-training = active recovery. Reinforce the positive: staying aerobic without impact.`,
    crosstrainingTools && crosstrainingTools.length > 0
      ? `- Athlete has these tools: ${crosstrainingTools.join(", ")} — if relevant, you can briefly suggest what to pair with this mid-week.`
      : null,
  ].filter(Boolean).join("\n");

  return lines;
}

type ActivitySummary = {
  activity_type: string | null;
  moving_time_seconds: number | null;
  average_heartrate: number | null;
  average_watts?: number | null;
  workout_type?: number | null;
  activity_name?: string | null;
  start_date: string;
};

function weekMonday(date: Date, timezone: string): string {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const [y, m, d] = local.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const mon = new Date(Date.UTC(y, m - 1, d - daysFromMon));
  return mon.toISOString().slice(0, 10);
}

/** Aerobic minutes from all cross-training activities in the current Mon–Sun week. */
export function computeWeekCrossTrainingAerobicMinutes(
  activities: ActivitySummary[],
  timezone: string,
  lthrEstimate: number | null,
): number {
  const now = new Date();
  const currentMonday = weekMonday(now, timezone);
  let total = 0;
  for (const a of activities) {
    if (!a.activity_type || !a.moving_time_seconds) continue;
    if (CROSS_TRAINING_TYPES.has(a.activity_type) || !["Run", "TrailRun", "VirtualRun", "Treadmill"].includes(a.activity_type)) {
      const actMonday = weekMonday(new Date(a.start_date), timezone);
      if (actMonday !== currentMonday) continue;
      const { effort } = classifyCrossTrainingEffort({
        activityType: a.activity_type,
        movingTimeSeconds: a.moving_time_seconds,
        averageHeartrate: a.average_heartrate ?? null,
        averageWatts: a.average_watts ?? null,
        workoutType: a.workout_type ?? null,
        activityName: a.activity_name ?? null,
        lthrEstimate,
      });
      total += computeAerobicMinutes(a.activity_type, a.moving_time_seconds, effort);
    }
  }
  return total;
}

/** Human-readable summary of this week's cross-training sessions, for weekly recap context. */
export function buildWeeklyCrossTrainingSummary(
  activities: ActivitySummary[],
  timezone: string,
  lthrEstimate: number | null,
): string {
  const now = new Date();
  const currentMonday = weekMonday(now, timezone);
  const runTypes = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

  const sessions = activities
    .filter(a => {
      if (!a.activity_type || !a.moving_time_seconds) return false;
      if (runTypes.has(a.activity_type)) return false;
      return weekMonday(new Date(a.start_date), timezone) === currentMonday;
    })
    .map(a => {
      const { effort } = classifyCrossTrainingEffort({
        activityType: a.activity_type!,
        movingTimeSeconds: a.moving_time_seconds!,
        averageHeartrate: a.average_heartrate ?? null,
        averageWatts: a.average_watts ?? null,
        workoutType: a.workout_type ?? null,
        activityName: a.activity_name ?? null,
        lthrEstimate,
      });
      const aerobicMins = computeAerobicMinutes(a.activity_type!, a.moving_time_seconds!, effort);
      const dayName = new Date(a.start_date).toLocaleDateString("en-US", {
        timeZone: timezone, weekday: "short",
      });
      return `${dayName} ${a.activity_type} ${fmtDuration(a.moving_time_seconds!)} (${effort} effort — ~${aerobicMins} aerobic mins)`;
    });

  return sessions.join("; ");
}

/**
 * Phase-appropriate cross-training prescription string for the plan arc.
 * Used by Haiku enrichment when the athlete has bike/pool tools.
 */
export function prescribeCrossTrainingForPhase(
  phase: string,
  crosstrainingTools: string[],
): string | null {
  const hasBike = crosstrainingTools.some(t => /bike|cycling|zwift|spin/i.test(t));
  const hasPool = crosstrainingTools.some(t => /swim|pool/i.test(t));
  if (!hasBike && !hasPool) return null;

  const p = phase.toLowerCase();

  if (hasBike) {
    if (p === "base" || p === "deload") return "Z2 ride 45 min (easy aerobic, keep HR in Z2)";
    if (p === "build") return "Sweetspot ride 45 min (15 min easy + 20 min moderate effort + 10 min easy)";
    if (p === "peak") return "Sweetspot ride 40 min or easy spin 30 min";
    if (p === "taper") return "Easy spin 25–30 min (active recovery only — no intensity)";
    return "Easy Z2 ride 40 min";
  }

  if (hasPool) {
    if (p === "base" || p === "deload") return "Easy aerobic swim 30 min";
    if (p === "build") return "Swim drill sets 40 min (500m warm-up + 6×100m moderate + 200m cool-down)";
    if (p === "peak") return "Steady swim 30 min or drill set 35 min";
    if (p === "taper") return "Easy swim 20 min, focus on form";
    return "Easy swim 30 min";
  }

  return null;
}
