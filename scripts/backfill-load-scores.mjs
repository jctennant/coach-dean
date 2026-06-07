/**
 * Backfill running_impact_load and activity_fatigue_load for all existing activities.
 *
 * Run this BEFORE deploying the load-score webhook changes to production, so historical
 * data is accurate and rolling_30d_max_running_load is correct for all users.
 *
 * Safe to re-run: activities with both load scores already set are skipped (idempotent).
 *
 * Usage:
 *   node scripts/backfill-load-scores.mjs
 *   node scripts/backfill-load-scores.mjs --dry-run
 *   node scripts/backfill-load-scores.mjs --user-id <uuid>
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DRY_RUN = process.argv.includes("--dry-run");
const TARGET_USER = (() => {
  const idx = process.argv.indexOf("--user-id");
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

const FULL_IMPACT_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);
const PARTIAL_IMPACT_TYPES = new Set(["Hike", "Elliptical"]);
const FATIGUE_ONLY_TYPES = new Set(["Ride", "VirtualRide", "Swim", "Yoga", "Rowing", "Kayaking", "StandUpPaddling"]);
const LEG_DAY_TYPES = new Set(["WeightTraining", "Workout"]);
const RUNNING_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Treadmill"]);

function parsePaceToSecPerMile(pace) {
  if (!pace) return null;
  const match = pace.match(/^(\d+):(\d{2})/);
  if (!match) return null;
  return parseInt(match[1]) * 60 + parseInt(match[2]);
}

function computeZoneMultiplier(avgHR, maxHR, avgPaceSec, easyPaceSec) {
  if (avgHR && maxHR && maxHR > 100) {
    const hrPct = avgHR / maxHR;
    if (hrPct >= 0.93) return 3.0;
    if (hrPct >= 0.87) return 2.0;
    if (hrPct >= 0.80) return 1.5;
    return 1.0;
  }
  if (avgPaceSec && easyPaceSec && easyPaceSec > 0) {
    const tempoPaceSec = easyPaceSec * 0.85;
    if (avgPaceSec < tempoPaceSec * 0.92) return 2.0;
    if (avgPaceSec < easyPaceSec * 0.95) return 1.5;
    return 1.0;
  }
  return 1.0;
}

function computeTrailGradeModifier(elevGain, distance) {
  if (!elevGain || !distance || distance < 100) return 1.0;
  const grade = elevGain / distance;
  if (grade <= 0.08) return 1.0;
  return Math.min(1.0 + (grade - 0.08) * 2, 1.4);
}

function inferTreadmillModifier(elevGain, distance, movingTimeSec) {
  if (elevGain && elevGain > 0 && distance) {
    const grade = elevGain / distance;
    if (grade > 0.05) return { modifier: 0.65, source: "gps" };
    return { modifier: 1.0, source: "inferred_flat" };
  }
  if (distance && movingTimeSec && movingTimeSec > 0) {
    const speedMs = distance / movingTimeSec;
    if (speedMs < 1.8) return { modifier: 0.65, source: "inferred_walk" };
  }
  return { modifier: 1.0, source: "inferred_flat" };
}

function computeScores(activity, maxHR, easyPace) {
  const { activity_type, moving_time_seconds, average_heartrate, average_pace, elevation_gain, distance_meters } = activity;
  if (!moving_time_seconds || moving_time_seconds <= 0) return null;
  if (LEG_DAY_TYPES.has(activity_type)) return { running_impact_load: null, activity_fatigue_load: null, grade_modifier_source: null, isLegDay: true };

  const durationMin = moving_time_seconds / 60;
  const zone = computeZoneMultiplier(
    average_heartrate, maxHR,
    parsePaceToSecPerMile(average_pace),
    parsePaceToSecPerMile(easyPace)
  );
  const base = durationMin * zone;

  if (FULL_IMPACT_TYPES.has(activity_type)) {
    let gradeModifier = 1.0;
    let source = null;
    if (activity_type === "TrailRun" && elevation_gain && elevation_gain > 0) {
      gradeModifier = computeTrailGradeModifier(elevation_gain, distance_meters);
      source = "gps";
    }
    return {
      running_impact_load: Math.round(base * gradeModifier * 10) / 10,
      activity_fatigue_load: Math.round(base * 10) / 10,
      grade_modifier_source: source,
      isLegDay: false,
    };
  }

  if (activity_type === "Treadmill") {
    const { modifier, source } = inferTreadmillModifier(elevation_gain, distance_meters, moving_time_seconds);
    return {
      running_impact_load: Math.round(base * modifier * 10) / 10,
      activity_fatigue_load: Math.round(base * 10) / 10,
      grade_modifier_source: source,
      isLegDay: false,
    };
  }

  if (PARTIAL_IMPACT_TYPES.has(activity_type)) {
    return {
      running_impact_load: Math.round(base * 0.65 * 10) / 10,
      activity_fatigue_load: Math.round(base * 0.7 * 10) / 10,
      grade_modifier_source: null,
      isLegDay: false,
    };
  }

  if (FATIGUE_ONLY_TYPES.has(activity_type)) {
    return {
      running_impact_load: 0,
      activity_fatigue_load: Math.round(base * 0.8 * 10) / 10,
      grade_modifier_source: null,
      isLegDay: false,
    };
  }

  return {
    running_impact_load: 0,
    activity_fatigue_load: Math.round(base * 0.5 * 10) / 10,
    grade_modifier_source: null,
    isLegDay: false,
  };
}

async function processUser(userId, maxHR, easyPace) {
  // Fetch all activities in chronological order (oldest first).
  // Chronological order is required so rolling_30d_max_running_load is correct
  // after the script finishes — each activity needs to see the correct prior window.
  const { data: activities, error } = await supabase
    .from("activities")
    .select("id, strava_activity_id, activity_type, moving_time_seconds, average_heartrate, average_pace, elevation_gain, distance_meters, start_date, running_impact_load, activity_fatigue_load")
    .eq("user_id", userId)
    .order("start_date", { ascending: true });

  if (error) {
    console.error(`  [${userId}] activities fetch error:`, error.message);
    return { updated: 0, skipped: 0, errors: 1 };
  }

  if (!activities || activities.length === 0) {
    return { updated: 0, skipped: 0, errors: 0 };
  }

  let updated = 0, skipped = 0, errors = 0;
  let rolling30dMax = null;

  for (const activity of activities) {
    // Idempotency: skip if both load scores are already set
    if (activity.running_impact_load != null && activity.activity_fatigue_load != null) {
      // Still track this for rolling max computation
      if (RUNNING_TYPES.has(activity.activity_type) && activity.running_impact_load > 0) {
        const actTime = new Date(activity.start_date).getTime();
        const thirtyDaysAgo = actTime - 30 * 24 * 60 * 60 * 1000;
        rolling30dMax = rolling30dMax === null || activity.running_impact_load > rolling30dMax
          ? activity.running_impact_load
          : rolling30dMax;
      }
      skipped++;
      continue;
    }

    const scores = computeScores(activity, maxHR, easyPace);
    if (!scores) { skipped++; continue; }

    if (!DRY_RUN) {
      const update = {};
      if (scores.running_impact_load !== null) update.running_impact_load = scores.running_impact_load;
      if (scores.activity_fatigue_load !== null) update.activity_fatigue_load = scores.activity_fatigue_load;
      if (scores.grade_modifier_source) update.grade_modifier_source = scores.grade_modifier_source;
      const { error: updateErr } = await supabase.from("activities").update(update).eq("id", activity.id);
      if (updateErr) {
        console.error(`  [${userId}] update failed for activity ${activity.id}:`, updateErr.message);
        errors++;
        continue;
      }
    }

    if (RUNNING_TYPES.has(activity.activity_type) && scores.running_impact_load && scores.running_impact_load > 0) {
      rolling30dMax = rolling30dMax === null || scores.running_impact_load > rolling30dMax
        ? scores.running_impact_load
        : rolling30dMax;
    }
    updated++;
  }

  // Write rolling_30d_max_running_load to training_state for this user
  if (rolling30dMax !== null && !DRY_RUN) {
    await supabase.from("training_state")
      .update({ rolling_30d_max_running_load: rolling30dMax })
      .eq("user_id", userId);
  }

  return { updated, skipped, errors, rolling30dMax };
}

async function main() {
  console.log(`[backfill-load-scores] ${DRY_RUN ? "DRY RUN — no writes" : "LIVE"}`);
  if (TARGET_USER) console.log(`[backfill-load-scores] targeting single user: ${TARGET_USER}`);

  // Fetch all users (or single user)
  let usersQuery = supabase.from("users").select("id");
  if (TARGET_USER) usersQuery = usersQuery.eq("id", TARGET_USER);
  const { data: users, error: usersErr } = await usersQuery;
  if (usersErr || !users) { console.error("users fetch failed:", usersErr); process.exit(1); }

  // Fetch training profiles for maxHR and easy pace
  const { data: profiles } = await supabase
    .from("training_profiles")
    .select("user_id, max_hr_estimate, current_easy_pace");
  const profileMap = {};
  for (const p of profiles ?? []) profileMap[p.user_id] = p;

  let totalUpdated = 0, totalSkipped = 0, totalErrors = 0;

  for (const user of users) {
    const profile = profileMap[user.id];
    const maxHR = profile?.max_hr_estimate ?? null;
    const easyPace = profile?.current_easy_pace ?? null;
    const result = await processUser(user.id, maxHR, easyPace);
    totalUpdated += result.updated;
    totalSkipped += result.skipped;
    totalErrors += result.errors;
    if (result.updated > 0 || result.errors > 0) {
      console.log(`  userId=${user.id}: updated=${result.updated} skipped=${result.skipped} errors=${result.errors} rolling30dMax=${result.rolling30dMax?.toFixed(1) ?? "null"}`);
    }
  }

  console.log(`\n[backfill-load-scores] DONE: ${totalUpdated} updated, ${totalSkipped} skipped, ${totalErrors} errors`);
  if (DRY_RUN) console.log("[backfill-load-scores] DRY RUN — re-run without --dry-run to apply");
}

main().catch(e => { console.error(e); process.exit(1); });
