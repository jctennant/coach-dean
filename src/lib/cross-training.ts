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

export function weekMonday(date: Date, timezone: string): string {
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

export interface WeekActivityTotals {
  runMiles: number;
  bikeMiles: number;
  /** Count of non-run, non-bike sessions this week (swim, strength, elliptical, etc.) — a
   * session count rather than a distance, since duration/effort is the meaningful unit for
   * most cross-training, not mileage. */
  crossTrainSessions: number;
}

/**
 * Deterministic this-week (Mon–Sun) totals by activity category — run mileage, bike mileage,
 * and a cross-training session count. Computed purely from Strava activity rows so a post-run
 * message can state "up to X mi running, Y mi biking" as a fact rather than Dean reconstructing
 * or estimating it from conversation memory.
 */
export function computeWeekActivityTotals(
  activities: Array<{ activity_type: string | null; distance_meters: number | null; start_date: string }>,
  timezone: string,
  refDate: Date = new Date(),
): WeekActivityTotals {
  const currentMonday = weekMonday(refDate, timezone);
  let runMiles = 0;
  let bikeMiles = 0;
  let crossTrainSessions = 0;
  for (const a of activities) {
    if (!a.activity_type) continue;
    if (weekMonday(new Date(a.start_date), timezone) !== currentMonday) continue;
    const miles = (a.distance_meters ?? 0) / 1609.34;
    if (RUN_TYPES.has(a.activity_type)) {
      runMiles += miles;
    } else if (BIKE_TYPES.has(a.activity_type)) {
      bikeMiles += miles;
    } else {
      crossTrainSessions += 1;
    }
  }
  return {
    runMiles: Math.round(runMiles * 10) / 10,
    bikeMiles: Math.round(bikeMiles * 10) / 10,
    crossTrainSessions,
  };
}

const ACTIVITY_LABELS: Record<string, string> = {
  Run: "Run", TrailRun: "Trail run", VirtualRun: "Run", Treadmill: "Treadmill run",
  Ride: "Bike", VirtualRide: "Bike", EBikeRide: "E-bike ride", MountainBikeRide: "Mountain bike ride", GravelRide: "Gravel ride",
  Swim: "Swim", OpenWaterSwim: "Open water swim",
  Walk: "Walk", Hike: "Hike", Yoga: "Yoga", Pilates: "Pilates",
  WeightTraining: "Strength session", Crossfit: "Crossfit session", Elliptical: "Elliptical session", Rowing: "Row", StairStepper: "Stair-stepper session",
};

/** One activity as line 1 needs to see it. */
export interface PostRunLineActivity {
  activity_type: string | null;
  distance_meters: number | null;
  /** Used to describe sessions Strava records no distance for (strength, yoga, "Workout"). */
  moving_time_seconds?: number | null;
  /** UTC ISO start. Drives the day label; omit only if genuinely unknown. */
  start_date?: string | null;
}

/** "0.9mi walk", "787yd swim", "22min strength session" — the sport phrase, no day, no week. */
function activityPhrase(activity: PostRunLineActivity, isMetricUser: boolean): string {
  const { activity_type: activityType, distance_meters: distanceMeters } = activity;
  const fmtMi = (mi: number) => (isMetricUser ? `${(mi * 1.60934).toFixed(1)}km` : `${mi}mi`);

  const isRun = !!activityType && RUN_TYPES.has(activityType);
  const isBike = !!activityType && BIKE_TYPES.has(activityType);
  const isWalk = activityType === "Walk" || activityType === "Hike";
  const isSwim = !!activityType && SWIM_TYPES.has(activityType);
  const miles = distanceMeters != null ? Math.round((distanceMeters / 1609.34) * 10) / 10 : null;

  if ((isRun || isBike || isWalk) && miles != null && miles > 0) {
    const verb = isRun ? "run" : isBike ? "bike" : activityType === "Hike" ? "hike" : "walk";
    return `${fmtMi(miles)} ${verb}`;
  }
  if (isSwim && distanceMeters != null && distanceMeters > 0) {
    // Strava reports swim distance in meters regardless of pool unit, so this is exact —
    // yards is just the customary display unit for non-metric (largely US) swimmers.
    const swimDistance = isMetricUser
      ? `${Math.round(distanceMeters)}m`
      : `${Math.round(distanceMeters * 1.09361)}yd`;
    return `${swimDistance} ${activityType === "OpenWaterSwim" ? "open water swim" : "swim"}`;
  }

  const label = activityType ? (ACTIVITY_LABELS[activityType] ?? activityType) : "Session";
  // Distance-less sessions (strength, yoga, Strava's generic "Workout") used to render as a
  // bare "Workout today." — and when Dean's optional line 2 also came back empty, that one
  // fragment was the entire message the athlete received (observed 2026-08-04). Duration is
  // the only quantity Strava reliably has for these, so lead with it when it's there.
  const minutes = activity.moving_time_seconds != null ? Math.round(activity.moving_time_seconds / 60) : null;
  if (minutes != null && minutes > 0) return `${minutes}min ${label.toLowerCase()}`;
  return label.toLowerCase();
}

/**
 * "today" / "yesterday" / "Friday" / "Aug 8" for an activity, in the athlete's own timezone.
 *
 * Line 1 used to hardcode "today" regardless of when the activity actually happened, so a
 * retroactive upload — a phone syncing a backlog, a watch that couldn't reach the network —
 * was announced as if the athlete had just finished it. Gwyneth was told "0.9mi walk today"
 * on 2026-08-16 about a walk from the 15th. The prompt already had a rule about this
 * (route.ts's post_run dateNote), but that rule only governs Dean's own prose; line 1 is
 * deterministic code and simply ignored it.
 */
function dayLabel(startDate: string, timezone: string, now: Date): string | null {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const activityDay = fmt.format(new Date(startDate));
  const todayDay = fmt.format(now);
  if (activityDay === todayDay) return "today";

  // Compare as calendar dates in the athlete's zone, not as elapsed hours — a 9pm run and a
  // 6am message the next morning are 9 hours apart but genuinely "yesterday".
  const dayDiff = Math.round(
    (Date.parse(`${todayDay}T00:00:00Z`) - Date.parse(`${activityDay}T00:00:00Z`)) / 86_400_000
  );
  if (dayDiff === 1) return "yesterday";
  if (dayDiff > 1 && dayDiff < 7) {
    return new Date(`${activityDay}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  }
  if (dayDiff >= 7) {
    return new Date(`${activityDay}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  // Future-dated relative to the athlete's clock — possible mid-flight across a date line.
  // No honest label, so say nothing rather than guess.
  return null;
}

/**
 * Deterministic post-run "line 1" — the session(s) just logged plus the week's
 * mileage-by-category so far, computed entirely in code (never LLM-authored). This is the
 * fact-accuracy fix applied to the post-run message itself: rather than Dean writing
 * "8:58/mi, X miles this week" in prose (a repeated source of mileage-accuracy bugs — see
 * fact-check.ts), the numbers are stated here and Dean's own reply is limited to an optional
 * second line (injury check-in or a genuine standout observation). Also names the actual
 * sport for non-run/non-bike sessions (swim, walk, strength, etc.) instead of the message
 * defaulting to running-shaped language regardless of activity type.
 *
 * Takes a list rather than one activity because Strava bulk-syncs backlogs, and a burst of
 * webhooks used to become a burst of concurrent, interleaved coaching messages (see
 * src/lib/post-run-batch.ts). Coalescing them into one message means line 1 has to be able
 * to name all of them — and to date them separately when the batch spans days, which it
 * routinely does for a backlog.
 */
export function buildPostRunMileageLine(
  activities: PostRunLineActivity[],
  weekTotals: WeekActivityTotals,
  isMetricUser: boolean,
  timezone: string,
  now: Date = new Date(),
): string {
  const fmtMi = (mi: number) => (isMetricUser ? `${(mi * 1.60934).toFixed(1)}km` : `${mi}mi`);
  const weekParts: string[] = [];
  if (weekTotals.runMiles > 0) weekParts.push(`${fmtMi(weekTotals.runMiles)} running`);
  if (weekTotals.bikeMiles > 0) weekParts.push(`${fmtMi(weekTotals.bikeMiles)} biking`);
  if (weekTotals.crossTrainSessions > 0) {
    weekParts.push(`${weekTotals.crossTrainSessions} cross-training session${weekTotals.crossTrainSessions !== 1 ? "s" : ""}`);
  }
  const weekSummary = weekParts.length > 0 ? `${weekParts.join(", ")} this week` : "first session logged this week";
  const weekSentence = `${weekSummary.charAt(0).toUpperCase()}${weekSummary.slice(1)}.`;

  if (activities.length === 0) return weekSentence;

  // Oldest first, so a multi-day batch reads in the order the athlete lived it.
  const ordered = [...activities].sort(
    (a, b) => new Date(a.start_date ?? 0).getTime() - new Date(b.start_date ?? 0).getTime()
  );
  const labels = ordered.map((a) => (a.start_date ? dayLabel(a.start_date, timezone, now) : null));
  const phrases = ordered.map((a) => activityPhrase(a, isMetricUser));

  // One shared day label when every activity landed on the same day (the overwhelmingly
  // common case, including same-second bulk uploads of a single day's sessions); per-activity
  // labels only when the batch actually spans days, where one shared label would be a lie.
  const sameDay = labels.every((l) => l !== null && l === labels[0]);
  const activityText = sameDay
    ? `${phrases.join(" + ")} ${labels[0]}`
    : ordered.map((_, i) => (labels[i] ? `${phrases[i]} ${labels[i]}` : phrases[i])).join(", ");

  return `${activityText.charAt(0).toUpperCase()}${activityText.slice(1)}. ${weekSentence}`;
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
  /**
   * Days between the most recent run and the run before it — captures a layoff that a single
   * recent "testing the waters" run would otherwise erase. Without this, an athlete who takes
   * 2+ weeks off then logs one cautious test run has daysSinceLastRun snap back to 0/1, making
   * a fresh return-from-injury read exactly like an athlete training continuously — which
   * defeats every volume/long-run cap keyed off daysSinceLastRun (see the 2026-07-22
   * changelog: an 8.5mi long run was prescribed the same day a returning athlete logged one
   * easy treadmill test run after a 12-day gap). Null if fewer than two runs exist in history.
   */
  gapBeforeLastRun: number | null;
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
  let secondLastRunDateStr: string | null = null;
  let hasCrossTrainSinceLastRun = false;
  for (const a of sorted) {
    if (RUN_TYPES.has(a.type)) {
      if (lastRunDateStr == null) {
        lastRunDateStr = a.dateStr;
        continue;
      }
      if (a.dateStr !== lastRunDateStr) {
        secondLastRunDateStr = a.dateStr;
        break;
      }
      continue; // same-day second run — keep scanning for a genuinely earlier date
    }
    if (lastRunDateStr == null && CROSS_TRAINING_TYPES.has(a.type)) hasCrossTrainSinceLastRun = true;
  }

  if (!lastRunDateStr) {
    return { daysSinceLastRun: null, consecutiveCrossTrainOnlyDays: 0, gapBeforeLastRun: null };
  }

  const daysBetween = (aStr: string, bStr: string) => Math.round(
    (new Date(`${aStr}T00:00:00Z`).getTime() - new Date(`${bStr}T00:00:00Z`).getTime()) / 86400000
  );
  const daysSinceLastRun = daysBetween(todayStr, lastRunDateStr);
  const gapBeforeLastRun = secondLastRunDateStr != null ? daysBetween(lastRunDateStr, secondLastRunDateStr) : null;

  return {
    daysSinceLastRun,
    consecutiveCrossTrainOnlyDays: hasCrossTrainSinceLastRun ? daysSinceLastRun : 0,
    gapBeforeLastRun,
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
