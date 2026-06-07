/**
 * Impact load and fatigue load scoring for running activities.
 *
 * Two separate signals are tracked:
 *   running_impact_load — mechanical stress on the tissues that break down in running
 *     injuries (tibia, tendons, connective tissue). Used for spike detection.
 *   activity_fatigue_load — systemic fatigue affecting next-session quality. Includes
 *     all activity types. Used for coaching tone and same-day/next-day context.
 *
 * Leg-day activities (WeightTraining, Workout) return isLegDay=true and no load scores —
 * they're tracked via a boolean flag in training_state with a 36-hour TTL.
 */

const FULL_IMPACT_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);
const PARTIAL_IMPACT_TYPES = new Set(["Hike", "Elliptical"]);
const FATIGUE_ONLY_TYPES = new Set(["Ride", "VirtualRide", "Swim", "Yoga", "Rowing", "Kayaking", "StandUpPaddling"]);
const LEG_DAY_TYPES = new Set(["WeightTraining", "Workout"]);

export interface ActivityLoadInput {
  activity_type: string;
  moving_time_seconds: number | null;
  average_heartrate: number | null;
  max_hr_estimate: number | null;
  average_pace: string | null; // "M:SS/mi" format
  easy_pace: string | null;    // athlete's easy pace for zone fallback
  elevation_gain: number | null; // meters
  distance_meters: number | null;
}

export interface LoadScoreResult {
  running_impact_load: number | null;
  activity_fatigue_load: number | null;
  grade_modifier_source: string | null; // "gps" | "inferred_flat" | "inferred_walk" | null
  isLegDay: boolean;
}

function parsePaceToSecPerMile(pace: string | null): number | null {
  if (!pace) return null;
  const match = pace.match(/^(\d+):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function computeZoneMultiplier(
  avgHR: number | null,
  maxHR: number | null,
  avgPaceSecPerMile: number | null,
  easyPaceSecPerMile: number | null
): number {
  if (avgHR && maxHR && maxHR > 100) {
    const hrPct = avgHR / maxHR;
    if (hrPct >= 0.93) return 3.0; // Zone 5 / race effort
    if (hrPct >= 0.87) return 2.0; // Zone 4 / tempo
    if (hrPct >= 0.80) return 1.5; // Zone 3 / moderate
    return 1.0;                    // Zone 1-2 / easy
  }

  if (avgPaceSecPerMile && easyPaceSecPerMile && easyPaceSecPerMile > 0) {
    const tempoPaceSec = easyPaceSecPerMile * 0.85;
    if (avgPaceSecPerMile < tempoPaceSec * 0.92) return 2.0;
    if (avgPaceSecPerMile < easyPaceSecPerMile * 0.95) return 1.5;
    return 1.0;
  }

  return 1.0;
}

function computeTrailGradeModifier(elevationGainMeters: number | null, distanceMeters: number | null): number {
  if (!elevationGainMeters || !distanceMeters || distanceMeters < 100) return 1.0;
  const grade = elevationGainMeters / distanceMeters;
  if (grade <= 0.08) return 1.0;
  return Math.min(1.0 + (grade - 0.08) * 2, 1.4);
}

function inferTreadmillGradeModifier(
  elevationGainMeters: number | null,
  distanceMeters: number | null,
  movingTimeSec: number | null
): { modifier: number; source: string } {
  // Strava treadmill activities commonly report elevation_gain = 0 even with significant
  // incline because GPS is inactive and grade is a separate field Strava may not surface.
  if (elevationGainMeters && elevationGainMeters > 0 && distanceMeters) {
    const grade = elevationGainMeters / distanceMeters;
    if (grade > 0.05) return { modifier: 0.65, source: "gps" };
    return { modifier: 1.0, source: "inferred_flat" };
  }

  // elevation_gain = 0 or null — fall back to speed-based inference.
  // < 1.8 m/s (~11 min/mile) suggests walking-pace incline work.
  if (distanceMeters && movingTimeSec && movingTimeSec > 0) {
    const avgSpeedMs = distanceMeters / movingTimeSec;
    if (avgSpeedMs < 1.8) return { modifier: 0.65, source: "inferred_walk" };
  }

  return { modifier: 1.0, source: "inferred_flat" };
}

export function computeLoadScores(input: ActivityLoadInput): LoadScoreResult {
  const { activity_type, moving_time_seconds, average_heartrate, max_hr_estimate,
    average_pace, easy_pace, elevation_gain, distance_meters } = input;

  if (!moving_time_seconds || moving_time_seconds <= 0) {
    return { running_impact_load: null, activity_fatigue_load: null, grade_modifier_source: null, isLegDay: false };
  }

  if (LEG_DAY_TYPES.has(activity_type)) {
    return { running_impact_load: null, activity_fatigue_load: null, grade_modifier_source: null, isLegDay: true };
  }

  const durationMin = moving_time_seconds / 60;
  const zoneMultiplier = computeZoneMultiplier(
    average_heartrate, max_hr_estimate,
    parsePaceToSecPerMile(average_pace),
    parsePaceToSecPerMile(easy_pace)
  );
  const baseLoad = durationMin * zoneMultiplier;

  if (FULL_IMPACT_TYPES.has(activity_type)) {
    let gradeModifier = 1.0;
    let gradeSource: string | null = null;
    if (activity_type === "TrailRun" && elevation_gain && elevation_gain > 0) {
      gradeModifier = computeTrailGradeModifier(elevation_gain, distance_meters);
      gradeSource = "gps";
    }
    return {
      running_impact_load: Math.round(baseLoad * gradeModifier * 10) / 10,
      activity_fatigue_load: Math.round(baseLoad * 10) / 10,
      grade_modifier_source: gradeSource,
      isLegDay: false,
    };
  }

  if (activity_type === "Treadmill") {
    const { modifier, source } = inferTreadmillGradeModifier(elevation_gain, distance_meters, moving_time_seconds);
    return {
      running_impact_load: Math.round(baseLoad * modifier * 10) / 10,
      activity_fatigue_load: Math.round(baseLoad * 10) / 10,
      grade_modifier_source: source,
      isLegDay: false,
    };
  }

  if (PARTIAL_IMPACT_TYPES.has(activity_type)) {
    return {
      running_impact_load: Math.round(baseLoad * 0.65 * 10) / 10,
      activity_fatigue_load: Math.round(baseLoad * 0.7 * 10) / 10,
      grade_modifier_source: null,
      isLegDay: false,
    };
  }

  if (FATIGUE_ONLY_TYPES.has(activity_type)) {
    return {
      running_impact_load: 0,
      activity_fatigue_load: Math.round(baseLoad * 0.8 * 10) / 10,
      grade_modifier_source: null,
      isLegDay: false,
    };
  }

  // Unknown type — conservative fatigue-only treatment
  return {
    running_impact_load: 0,
    activity_fatigue_load: Math.round(baseLoad * 0.5 * 10) / 10,
    grade_modifier_source: null,
    isLegDay: false,
  };
}

/**
 * Compute the rolling 30-day max running impact load from an activity list.
 * Excludes the current activity (pass activities BEFORE the current one).
 * Used for spike detection: if current session > max × 1.10, flag a checkin.
 */
export function computeRolling30dMaxRunningLoad(
  activities: Array<{ running_impact_load: number | null; start_date: string; activity_type: string }>
): number | null {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const RUNNING_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);
  let max: number | null = null;
  for (const a of activities) {
    if (!a.running_impact_load || !RUNNING_TYPES.has(a.activity_type)) continue;
    if (new Date(a.start_date).getTime() < thirtyDaysAgo) continue;
    if (max === null || a.running_impact_load > max) max = a.running_impact_load;
  }
  return max;
}

/**
 * Sum activity_fatigue_load for activities in the last N hours.
 * Used to surface "you had a hard incline session yesterday" context.
 */
export function computeRecentFatigueLoad(
  activities: Array<{ activity_fatigue_load: number | null; start_date: string }>,
  windowHours = 48
): number {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  return activities
    .filter(a => a.activity_fatigue_load != null && new Date(a.start_date).getTime() >= cutoff)
    .reduce((sum, a) => sum + (a.activity_fatigue_load ?? 0), 0);
}
