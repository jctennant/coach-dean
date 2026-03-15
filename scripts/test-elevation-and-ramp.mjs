/**
 * Tests the two fixes from 2026-03-14:
 * 1. Elevation unit conversion in transformSplitForClaude (splits + laps)
 * 2. weekOverWeekRampPct now compares current week vs last completed week
 *
 * Run: node scripts/test-elevation-and-ramp.mjs
 */

// ── Helpers mirroring source code ─────────────────────────────────────────────

function fmtPace(minsPerMile, unit = "mi") {
  const totalSec = Math.round(minsPerMile * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}/${unit}`;
}

function transformSplitForClaude(split) {
  const speed = typeof split.average_speed === "number" ? split.average_speed : null;
  const elevDiff = typeof split.elevation_difference === "number" ? split.elevation_difference : null;
  const elevGain = typeof split.total_elevation_gain === "number" ? split.total_elevation_gain : null;
  const distMeters = typeof split.distance === "number" ? split.distance : null;

  const pace = speed && speed > 0
    ? fmtPace(1609.34 / speed / 60, "mi")
    : null;

  const result = { ...split };
  if (distMeters != null) result.distance_miles = Math.round((distMeters / 1609.34) * 100) / 100;
  if (pace) result.pace = pace;
  if (elevDiff != null) result.elevation_difference_feet = Math.round(elevDiff * 3.28084);
  if (elevGain != null) result.total_elevation_gain_feet = Math.round(elevGain * 3.28084);
  delete result.distance;
  delete result.average_speed;
  delete result.elevation_difference;
  delete result.total_elevation_gain;
  return result;
}

// ── Mirror of computeCoachingSignals ramp logic ────────────────────────────────

function localWeekMonday(date, timezone) {
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const [yr, mo, dy] = localDate.split("-").map(Number);
  const d = new Date(Date.UTC(yr, mo - 1, dy));
  const dow = d.getUTCDay();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const monday = new Date(Date.UTC(yr, mo - 1, dy - daysFromMon));
  return monday.toISOString().slice(0, 10);
}

const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

function computeRamp(activities, timezone, currentWeekMiles) {
  const thisMonday = localWeekMonday(new Date(), timezone);
  const weeklyMiles = {};
  for (const a of activities) {
    if (!RUN_TYPES.has(a.activity_type)) continue;
    const key = localWeekMonday(new Date(a.start_date), timezone);
    if (key >= thisMonday) continue;
    weeklyMiles[key] = (weeklyMiles[key] || 0) + (a.distance_meters || 0) / 1609.34;
  }
  const sortedCompleteWeeks = Object.keys(weeklyMiles).sort().reverse();
  const lastCompletedWeekMiles = sortedCompleteWeeks.length > 0 ? weeklyMiles[sortedCompleteWeeks[0]] : null;
  if (currentWeekMiles != null && lastCompletedWeekMiles != null && lastCompletedWeekMiles > 0) {
    return {
      rampPct: ((currentWeekMiles - lastCompletedWeekMiles) / lastCompletedWeekMiles) * 100,
      lastCompletedWeekMiles,
      lastCompletedWeekKey: sortedCompleteWeeks[0],
    };
  }
  return null;
}

let allPass = true;
function check(label, actual, expected, tolerance = 0) {
  const pass = Math.abs(actual - expected) <= tolerance;
  if (!pass) allPass = false;
  console.log(`${pass ? "✅" : "❌"} ${label}: ${actual} (expected ${expected}${tolerance ? ` ±${tolerance}` : ""})`);
  return pass;
}
function checkNull(label, value) {
  const pass = value === null || value === undefined;
  if (!pass) allPass = false;
  console.log(`${pass ? "✅" : "❌"} ${label}: ${JSON.stringify(value)} (expected null/undefined)`);
  return pass;
}
function checkExists(label, value) {
  const pass = value !== null && value !== undefined;
  if (!pass) allPass = false;
  console.log(`${pass ? "✅" : "❌"} ${label}: ${JSON.stringify(value)} (expected to exist)`);
  return pass;
}

// ── TEST 1: Splits (elevation_difference in meters) ───────────────────────────

console.log("\n" + "=".repeat(60));
console.log("TEST 1: splits_metric split with elevation_difference (meters)");
console.log("=".repeat(60));

const metricSplit = {
  split: 11,
  distance: 1609.34,         // 1 mile in meters
  moving_time: 2175,         // 36:15 pace
  elapsed_time: 2175,
  elevation_difference: 333, // 333 meters — should become ~1093ft
  average_speed: 0.74,       // ~36:15/mi
  pace_zone: 1,
};

const transformedSplit = transformSplitForClaude(metricSplit);
console.log("Transformed:", JSON.stringify(transformedSplit, null, 2));

check("elevation_difference_feet", transformedSplit.elevation_difference_feet, 1093, 2);
checkNull("elevation_difference (raw) removed", transformedSplit.elevation_difference);
checkNull("distance (raw) removed", transformedSplit.distance);
checkNull("average_speed (raw) removed", transformedSplit.average_speed);
checkExists("pace field added", transformedSplit.pace);

// ── TEST 2: Laps (total_elevation_gain in meters) ─────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("TEST 2: Strava lap with total_elevation_gain (meters)");
console.log("=".repeat(60));

const stravaLap = {
  id: 98765,
  lap_index: 11,
  distance: 1450,            // ~0.9 miles (partial last mile)
  moving_time: 1300,
  elapsed_time: 1310,
  total_elevation_gain: 333, // 333 meters — should become ~1093ft
  average_speed: 1.12,
  average_heartrate: 172,
  pace_zone: 2,
};

const transformedLap = transformSplitForClaude(stravaLap);
console.log("Transformed:", JSON.stringify(transformedLap, null, 2));

check("total_elevation_gain_feet", transformedLap.total_elevation_gain_feet, 1093, 2);
checkNull("total_elevation_gain (raw) removed", transformedLap.total_elevation_gain);
checkExists("pace field added", transformedLap.pace);

// ── TEST 3: Flat split (no elevation) ─────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("TEST 3: Flat split (elevation_difference = 0 or absent)");
console.log("=".repeat(60));

const flatSplit = {
  split: 1,
  distance: 1609.34,
  moving_time: 480,          // 8:00/mi
  elapsed_time: 480,
  elevation_difference: 0,
  average_speed: 3.354,
  pace_zone: 2,
};

const transformedFlat = transformSplitForClaude(flatSplit);
console.log("Transformed:", JSON.stringify(transformedFlat, null, 2));
check("elevation_difference_feet for 0m gain", transformedFlat.elevation_difference_feet, 0);
checkNull("elevation_difference (raw) removed", transformedFlat.elevation_difference);

// ── TEST 4: Small gain (verify rounding) ──────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("TEST 4: Small gain — verify rounding (25m → 82ft)");
console.log("=".repeat(60));

const smallSplit = {
  split: 3,
  distance: 1609.34,
  elevation_difference: 25, // 25 meters = 82ft
  average_speed: 2.8,
};
const transformedSmall = transformSplitForClaude(smallSplit);
check("elevation_difference_feet for 25m", transformedSmall.elevation_difference_feet, 82, 1);

// ── TEST 5: Weekly ramp — user scenario (31.6mi this week, 30mi last week) ────

console.log("\n" + "=".repeat(60));
console.log("TEST 5: Weekly ramp — 31.6mi this week, 30mi last week = ~5%");
console.log("=".repeat(60));

const timezone = "America/New_York";
const now = new Date();
const thisMonday = localWeekMonday(now, timezone);

// Last week's Monday
const lastMondayDate = new Date(now);
lastMondayDate.setDate(lastMondayDate.getDate() - 7);
const lastMonday = localWeekMonday(lastMondayDate, timezone);

// Build fake activities: 6 runs last week totaling 30mi, and this week already in DB
const fakeActivities = [
  // Last week: 6 runs × 5mi = 30mi
  { activity_type: "Run", distance_meters: 8046.7, start_date: `${lastMonday}T10:00:00Z` }, // 5mi
  { activity_type: "Run", distance_meters: 8046.7, start_date: `${lastMonday}T10:00:00Z` },
  { activity_type: "Run", distance_meters: 8046.7, start_date: `${lastMonday}T10:00:00Z` },
  { activity_type: "Run", distance_meters: 8046.7, start_date: `${lastMonday}T10:00:00Z` },
  { activity_type: "Run", distance_meters: 8046.7, start_date: `${lastMonday}T10:00:00Z` },
  { activity_type: "Run", distance_meters: 8046.7, start_date: `${lastMonday}T10:00:00Z` },
  // This week: will be skipped (key >= thisMonday)
  { activity_type: "Run", distance_meters: 18530, start_date: `${thisMonday}T10:00:00Z` }, // 11.5mi
];

const currentWeekMiles = 31.6;
const result5 = computeRamp(fakeActivities, timezone, currentWeekMiles);
console.log(`Last completed week (${result5?.lastCompletedWeekKey}): ${result5?.lastCompletedWeekMiles?.toFixed(1)} mi`);
console.log(`Current week: ${currentWeekMiles} mi`);
console.log(`Ramp: ${result5?.rampPct?.toFixed(1)}%`);
check("ramp % is ~5.3% (not 36%)", result5?.rampPct ?? 0, 5.3, 0.5);

// ── TEST 6: Weekly ramp — old bug scenario (23mi last week, 31.6mi this week = 36%) ──

console.log("\n" + "=".repeat(60));
console.log("TEST 6: Old bug scenario — 23mi last week = 36% ramp (should no longer happen with real 30mi)");
console.log("=".repeat(60));

// Simulate what happens if DB only has 23mi for last week (old bug scenario)
const fakeActivitiesSparse = [
  { activity_type: "Run", distance_meters: 6195.5, start_date: `${lastMonday}T10:00:00Z` }, // 3.85mi × 6 = 23.1mi
  { activity_type: "Run", distance_meters: 6195.5, start_date: `${lastMonday}T10:00:00Z` },
  { activity_type: "Run", distance_meters: 6195.5, start_date: `${lastMonday}T10:00:00Z` },
  { activity_type: "Run", distance_meters: 6195.5, start_date: `${lastMonday}T10:00:00Z` },
  { activity_type: "Run", distance_meters: 6195.5, start_date: `${lastMonday}T10:00:00Z` },
  { activity_type: "Run", distance_meters: 6195.5, start_date: `${lastMonday}T10:00:00Z` },
];

const result6 = computeRamp(fakeActivitiesSparse, timezone, currentWeekMiles);
console.log(`Last completed week: ${result6?.lastCompletedWeekMiles?.toFixed(1)} mi`);
console.log(`Current week: ${currentWeekMiles} mi`);
console.log(`Ramp: ${result6?.rampPct?.toFixed(1)}% — correct because it uses actual DB data`);
// This is technically correct behavior: if DB has 23mi, ramp IS 36%
// The fix ensures Dean is comparing current vs LAST (not last vs prev), even if DB data is sparse
const pass6 = Math.abs((result6?.rampPct ?? 0) - 36.2) < 1;
if (!pass6) allPass = false;
console.log(`${pass6 ? "✅" : "❌"} Ramp correctly computed from actual DB data (36% when DB has 23mi) — data completeness is a separate issue`);

// ── TEST 7: Pace formatter — no :60 rollover ──────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("TEST 7: fmtPace — no :60 rollover");
console.log("=".repeat(60));

// The old buggy pattern: Math.round((7.9999... - 7) * 60) = Math.round(59.999...) = 60 → "7:60/mi"
// speed = 3.354 m/s → paceMinPerMile = 1609.34 / 3.354 / 60 = exactly 8.0/mi (should be 8:00/mi)
const speed800 = 1609.34 / (8 * 60); // exactly 8:00/mi
const pace800 = fmtPace(1609.34 / speed800 / 60);
console.log(`8:00/mi speed → "${pace800}"`);
const p1 = pace800 === "8:00/mi";
if (!p1) allPass = false;
console.log(`${p1 ? "✅" : "❌"} 8:00/mi renders correctly (not 7:60/mi)`);

// Edge case that triggered the bug: speed slightly above 8:00/mi boundary
const speedSlightlyFaster = 1609.34 / (7.9999 * 60);
const paceFaster = fmtPace(1609.34 / speedSlightlyFaster / 60);
console.log(`Slightly faster than 8:00 → "${paceFaster}"`);
const p2 = !paceFaster.includes(":60");
if (!p2) allPass = false;
console.log(`${p2 ? "✅" : "❌"} No :60 in pace string`);

// Normal cases
const cases = [
  [7.5, "7:30/mi"],
  [9.0, "9:00/mi"],
  [10.25, "10:15/mi"],
  [36.25, "36:15/mi"],
];
for (const [input, expected] of cases) {
  const result = fmtPace(input);
  const pass = result === expected;
  if (!pass) allPass = false;
  console.log(`${pass ? "✅" : "❌"} fmtPace(${input}) = "${result}" (expected "${expected}")`);
}

// ── SUMMARY ────────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log(`OVERALL: ${allPass ? "✅ PASS" : "❌ FAIL"}`);
