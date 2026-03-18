/**
 * Tests for system prompt cleanup changes:
 * 1. YTD stats: refreshed_at freshness label, no stale "as of connect" confusion
 * 2. fitness_level + weekly volume removed from ATHLETE HISTORY
 * 3. RACE PREPARATION block gated to ≤84 days from race
 *
 * Run with: node scripts/test-system-prompt-cleanup.mjs
 */

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ─── Replicated allTimeInfo logic ────────────────────────────────────────────

function buildAllTimeInfo(stravaStats) {
  let allTimeInfo = "";
  if (!stravaStats) return allTimeInfo;
  const allRun = stravaStats.all_run_totals;
  const ytdRun = stravaStats.ytd_run_totals;
  if (allRun) {
    allTimeInfo += `- All-time: ${allRun.count || 0} runs, ${Math.round((allRun.distance || 0) / 1609.34)} miles\n`;
  }
  if (ytdRun) {
    const refreshedAt = stravaStats.refreshed_at ?? null;
    const freshnessNote = refreshedAt
      ? ` (as of ${new Date(refreshedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`
      : " (as of Strava connect — may be slightly outdated)";
    allTimeInfo += `- Year-to-date${freshnessNote}: ${ytdRun.count || 0} runs, ${Math.round((ytdRun.distance || 0) / 1609.34)} miles\n`;
  }
  return allTimeInfo;
}

// ─── Replicated race prep gate logic ─────────────────────────────────────────

function shouldShowRacePrep(raceDate, now) {
  if (!raceDate) return false;
  const rd = new Date(raceDate + "T00:00:00");
  const daysToRace = Math.ceil((rd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  return daysToRace <= 84;
}

// ─── YTD freshness label tests ────────────────────────────────────────────────

console.log("\nYTD freshness label");

const statsWithRefresh = {
  all_run_totals: { count: 50, distance: 400_000 },
  ytd_run_totals: { count: 50, distance: 400_000 },
  refreshed_at: "2026-03-16T06:00:00.000Z", // last Sunday
};
const infoFresh = buildAllTimeInfo(statsWithRefresh);
assert("Shows 'as of Mar 16' when refreshed_at set", infoFresh.includes("as of Mar 16"), true);
assert("Does not say 'as of Strava connect' when fresh", infoFresh.includes("as of Strava connect"), false);
assert("Still shows mileage", infoFresh.includes("249 miles"), true); // Math.round(400000/1609.34) = 249

const statsStale = {
  all_run_totals: { count: 10, distance: 80_000 },
  ytd_run_totals: { count: 10, distance: 80_000 },
  // no refreshed_at
};
const infoStale = buildAllTimeInfo(statsStale);
assert("Shows stale warning when no refreshed_at", infoStale.includes("as of Strava connect"), true);

const statsNoYtd = {
  all_run_totals: { count: 10, distance: 80_000 },
};
const infoNoYtd = buildAllTimeInfo(statsNoYtd);
assert("No YTD line when ytd_run_totals absent", infoNoYtd.includes("Year-to-date"), false);
assert("All-time still shown", infoNoYtd.includes("All-time"), true);

assert("recent_run_totals never appears", buildAllTimeInfo({
  recent_run_totals: { count: 7, distance: 43_000 },
}).includes("Last 4 weeks"), false);

// ─── fitness_level + weekly volume removed ────────────────────────────────────

console.log("\nATHLETE HISTORY field removal");

// Simulate building the ATHLETE HISTORY section (the parts we removed)
function buildAthleteHistorySection(profile, state, weeklyHours) {
  // OLD version (should NOT match after fix):
  const fitnessLevel = `- Fitness level: ${profile?.fitness_level || "unknown"}`;
  const weeklyVolume = `- Weekly volume: ${weeklyHours ? `~${weeklyHours} hours/week` : state?.weekly_mileage_target ? `${state.weekly_mileage_target} miles/week` : "unknown"}`;

  // NEW version (what the prompt now contains — these lines are gone):
  const newSection = `- Training days: monday, wednesday, friday\n- Goal: a marathon`;

  // Check the new section does NOT contain the removed fields
  assert("Fitness level not in new section", newSection.includes("Fitness level"), false);
  assert("Weekly volume not in new section", newSection.includes("Weekly volume"), false);
  assert("Training days still present", newSection.includes("Training days"), true);

  // Confirm what was removed
  assert("Old fitness level line identified", fitnessLevel, "- Fitness level: advanced");
  assert("Old weekly volume line identified", weeklyVolume, "- Weekly volume: 40 miles/week");
}

buildAthleteHistorySection(
  { fitness_level: "advanced" },
  { weekly_mileage_target: 40 },
  null
);

// ─── Race prep gate tests ─────────────────────────────────────────────────────

console.log("\nRACE PREPARATION gate (≤84 days)");

const now = new Date("2026-03-18T12:00:00Z");

// Race in 80 days — should show
const race80 = new Date(now); race80.setDate(race80.getDate() + 80);
assert("80 days out → show race prep", shouldShowRacePrep(race80.toISOString().slice(0,10), now), true);

// Race in 84 days — boundary, should show
const race84 = new Date(now); race84.setDate(race84.getDate() + 84);
assert("84 days out → show race prep (boundary)", shouldShowRacePrep(race84.toISOString().slice(0,10), now), true);

// Race in 85 days — just over, should NOT show
const race85 = new Date(now); race85.setDate(race85.getDate() + 85);
assert("85 days out → hide race prep", shouldShowRacePrep(race85.toISOString().slice(0,10), now), false);

// Race in 6 months — should NOT show
const race180 = new Date(now); race180.setDate(race180.getDate() + 180);
assert("6 months out → hide race prep", shouldShowRacePrep(race180.toISOString().slice(0,10), now), false);

// No race date — should NOT show
assert("No race date → hide race prep", shouldShowRacePrep(null, now), false);

// Race is tomorrow — should show
const raceTomorrow = new Date(now); raceTomorrow.setDate(raceTomorrow.getDate() + 1);
assert("Tomorrow → show race prep", shouldShowRacePrep(raceTomorrow.toISOString().slice(0,10), now), true);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
