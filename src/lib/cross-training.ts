/**
 * Cross-training utility functions for Coach Dean.
 * Handles effort classification, aerobic equivalent minutes, and context building
 * for non-run Strava activities (bikes, swims, hikes, etc.).
 */

export const BIKE_TYPES = new Set([
  "Ride", "VirtualRide", "EBikeRide", "MountainBikeRide", "GravelRide",
]);

export const SWIM_TYPES = new Set(["Swim", "OpenWaterSwim"]);

// Recovery-grade activities that should never be labeled "moderate" by default when
// intensity data is missing — they're easy by their nature.
export const WALK_LIKE_TYPES = new Set([
  "Walk", "Hike", "Yoga", "Pilates",
]);

export const CROSS_TRAINING_TYPES = new Set([
  ...BIKE_TYPES, ...SWIM_TYPES,
  "Rowing", "Elliptical", "StairStepper", "Hike", "Walk",
  "WeightTraining", "Yoga", "Pilates", "Crossfit",
]);

// Canonical run-activity classification, shared across the engine so "is this a run" can't
// silently drift between call sites (route.ts previously redefined this ~10 times inline,
// two of which omitted "Treadmill").
export const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

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

  // Absolute-HR fallback when we have HR but no LTHR estimate. A low absolute HR is
  // unambiguously easy regardless of fitness — labeling an 82 bpm walk "moderate"
  // (the old default) is the kind of obviously-wrong call that destroys trust. Only
  // genuinely elevated absolute HR should read as moderate/hard without an LTHR anchor.
  if (averageHeartrate != null) {
    if (averageHeartrate < 115) return { effort: "easy", rationale: `avg HR ${Math.round(averageHeartrate)} bpm is low in absolute terms — clearly easy` };
    if (averageHeartrate < 145) return { effort: "moderate", rationale: `avg HR ${Math.round(averageHeartrate)} bpm — moderate (no LTHR anchor)` };
    return { effort: "hard", rationale: `avg HR ${Math.round(averageHeartrate)} bpm is high in absolute terms` };
  }

  // Power proxy for cycling (no FTP stored — rough absolute thresholds)
  if (BIKE_TYPES.has(activityType) && averageWatts != null) {
    if (averageWatts < 150) return { effort: "easy", rationale: "low average watts" };
    if (averageWatts < 220) return { effort: "moderate", rationale: "moderate average watts" };
    return { effort: "hard", rationale: "high average watts" };
  }

  // Walks, hikes, yoga, mobility, light strength are recovery-grade by nature — never
  // assume "moderate" for them when data is missing.
  if (WALK_LIKE_TYPES.has(activityType)) {
    return { effort: "easy", rationale: "walk/hike/recovery-grade activity with no intensity data — easy by nature" };
  }

  // Default when we genuinely have nothing: easy, not moderate. An unsupported "moderate"
  // label reads as the coach making things up; "easy" is the safe, low-friction assumption.
  return { effort: "easy", rationale: "insufficient data — defaulting to easy" };
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
  injuryNotes: string | null;
  injuryHoldSince?: string | null;
}): string {
  const { activityType, activityName, movingTimeSeconds, averageHeartrate, averageWatts,
    workoutType, lthrEstimate, crosstrainingTools, phase, weekAerobicMinutesSoFar,
    weekRunMileageSoFar, useMetric, injuryNotes, injuryHoldSince } = params;

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

  // Injury hold takes priority over general injury context: this session IS the prescribed plan.
  const hasActiveInjury = !!injuryNotes && !injuryNotes.toLowerCase().startsWith("past");
  const injuryRule = injuryHoldSince
    ? `- PRESCRIBED RECOVERY CROSS-TRAINING — MANDATORY FRAMING: Athlete is on a full injury hold (since ${injuryHoldSince}). This session IS the plan — not a substitute, not a consolation prize. Frame it as: "This is exactly what recovery looks like right now — staying aerobic while [body part] heals." Do NOT suggest they should be running or compare this to missing a run. Do NOT say "good alternative." End with a brief check-in on how the injury site is feeling today.`
    : hasActiveInjury
    ? `- INJURY CONTEXT — MANDATORY: Athlete has an active injury/concern: "${injuryNotes}". Connect this cross-training session to the injury — explain how it protects the injury site or maintains fitness while it heals. Do NOT skip this. Example: "This keeps you aerobic without loading the [body part]" or "Avoids the impact your [body part] needs to stay away from right now." End with a brief check-in on how the injury is feeling.`
    : null;

  const lines = [
    `CROSS-TRAINING ACTIVITY: ${activityType}${activityName ? ` ("${activityName}")` : ""}`,
    `Duration: ${durationStr} | Effort: ${effort} (${rationale})`,
    `Aerobic equivalent for this session: ~${aerobicMins} aerobic minutes`,
    `Week cross-training total (including this): ~${totalMinsThisWeek} aerobic minutes`,
    `Running this week: ${runLoadStr}`,
    `Phase: ${(phase ?? "base").toLowerCase()} — ${phaseGuidance(phase, effort)}`,
    ``,
    `RESPONSE GUIDELINES:`,
    `- 2–4 sentences. NEVER open with praise ("Great job", "Great work", "Impressive", "Nice", or any similar opener). Start with the specific observation about the session.`,
    `- Reference something specific from the session (effort level, duration, what it does for their fitness).`,
    `- Do NOT cite the week's running mileage total in this response.`,
    effort === "hard"
      ? `- This was a quality effort — acknowledge the training stimulus it provided, not just "great job cross-training".`
      : `- Easy cross-training = active recovery. Reinforce the positive: staying aerobic without impact.`,
    injuryRule,
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
  refDate: Date = new Date(),
): number {
  const currentMonday = weekMonday(refDate, timezone);
  let total = 0;
  for (const a of activities) {
    if (!a.activity_type || !a.moving_time_seconds) continue;
    if (CROSS_TRAINING_TYPES.has(a.activity_type) || !RUN_TYPES.has(a.activity_type)) {
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

export interface RunGapSignal {
  /** Days since the most recent run in the provided activity history, null if no run appears at all. */
  daysSinceLastRun: number | null;
  /**
   * Same as daysSinceLastRun, but only non-zero when at least one cross-training activity was
   * also logged in that gap — corroborating evidence the athlete has been actively
   * substituting cross-training for running, not just quiet/no data. 0 when there's no run gap
   * or no corroborating cross-training signal.
   */
  consecutiveCrossTrainOnlyDays: number;
}

/**
 * Deterministic "how long has it been since this athlete last ran" signal, computed purely
 * from Strava activity data — no LLM involved. Exists so injury-hold-adjacent prompt facts
 * don't have to rely on Claude reconstructing this from conversation memory (see the
 * 2026-07-17 changelog entry on why that drifted from the DB's actual injury_hold_since).
 */
export function computeRunGapSignal(
  activities: Array<{ activity_type: string | null; start_date: string }>,
  timezone: string,
  refDate: Date = new Date(),
): RunGapSignal {
  const tz = timezone || "America/New_York";
  const localDateStr = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const todayStr = localDateStr(refDate);

  const sorted = activities
    .filter((a): a is { activity_type: string; start_date: string } => !!a.activity_type)
    .map(a => ({ type: a.activity_type, dateStr: localDateStr(new Date(a.start_date)) }))
    .sort((a, b) => (a.dateStr < b.dateStr ? 1 : -1)); // most recent first

  let lastRunDateStr: string | null = null;
  let hasCrossTrainSinceLastRun = false;
  for (const a of sorted) {
    if (RUN_TYPES.has(a.type)) {
      lastRunDateStr = a.dateStr;
      break;
    }
    if (CROSS_TRAINING_TYPES.has(a.type)) hasCrossTrainSinceLastRun = true;
  }

  if (!lastRunDateStr) {
    return { daysSinceLastRun: null, consecutiveCrossTrainOnlyDays: 0 };
  }

  const daysSinceLastRun = Math.round(
    (new Date(`${todayStr}T00:00:00Z`).getTime() - new Date(`${lastRunDateStr}T00:00:00Z`).getTime()) / 86400000
  );

  return {
    daysSinceLastRun,
    consecutiveCrossTrainOnlyDays: hasCrossTrainSinceLastRun ? daysSinceLastRun : 0,
  };
}

/** Human-readable summary of this week's cross-training sessions, for weekly recap context. */
export function buildWeeklyCrossTrainingSummary(
  activities: ActivitySummary[],
  timezone: string,
  lthrEstimate: number | null,
  refDate: Date = new Date(),
): string {
  const currentMonday = weekMonday(refDate, timezone);
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
