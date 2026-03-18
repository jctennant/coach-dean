/**
 * Regression test for the weekly mileage hallucination bug (user b1b308cf).
 * Dean cited 26–27 miles when the actual total was 9.8 miles.
 * Root cause: stale `recent_run_totals` from Strava stats was included in the
 * system prompt and the model grabbed that aggregate instead of the authoritative
 * computeWeekMileage() value.
 *
 * Run with: node scripts/test-mileage-hallucination.mjs
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

function assertClose(label, actual, expected, tolerance = 0.05) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    expected: ${expected} (±${tolerance})`);
    console.error(`    actual:   ${actual}`);
    failed++;
  }
}

// ─── Replicated logic from route.ts ──────────────────────────────────────────

const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);

function localWeekMonday(date, timezone) {
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
  const [yr, mo, dy] = localDate.split('-').map(Number);
  const d = new Date(Date.UTC(yr, mo - 1, dy));
  const dow = d.getUTCDay();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const monday = new Date(Date.UTC(yr, mo - 1, dy - daysFromMon));
  return monday.toISOString().slice(0, 10);
}

function computeWeekMileage(activities, timezone) {
  const thisMonday = localWeekMonday(new Date(), timezone);
  return activities
    .filter((a) => {
      if (!RUN_TYPES.has(a.activity_type)) return false;
      const activityDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(a.start_date));
      return activityDate >= thisMonday;
    })
    .reduce((sum, a) => sum + (a.distance_meters || 0) / 1609.34, 0);
}

function buildAllTimeInfo(stravaStats) {
  let allTimeInfo = '';
  if (!stravaStats) return allTimeInfo;
  const allRun = stravaStats.all_run_totals;
  const ytdRun = stravaStats.ytd_run_totals;
  const recentRun = stravaStats.recent_run_totals;
  if (allRun) {
    allTimeInfo += `- All-time: ${allRun.count || 0} runs, ${Math.round((allRun.distance || 0) / 1609.34)} miles\n`;
  }
  if (ytdRun) {
    allTimeInfo += `- Year-to-date: ${ytdRun.count || 0} runs, ${Math.round((ytdRun.distance || 0) / 1609.34)} miles\n`;
  }
  // recent_run_totals intentionally omitted (see fix)
  void recentRun;
  return allTimeInfo;
}

function buildCurrentTrainingStateLine(weekMileageSoFar, weekRunCount) {
  return `⚠️ AUTHORITATIVE WEEKLY MILEAGE — USE THIS NUMBER ONLY: ${weekMileageSoFar.toFixed(1)} mi across ${weekRunCount} run${weekRunCount !== 1 ? 's' : ''} this week (computed live from Strava).`;
}

// ─── Exact activities from the bug report ────────────────────────────────────

// These are the three activities in the DB for user b1b308cf this week:
//   idx0: Run  11832.6m  2026-03-17 13:17:58+00  (Tuesday morning, 7.35mi)
//   idx1: Run   3912.6m  2026-03-17 01:20:36+00  (Monday evening, 2.43mi, avg pace 18:30/mi — a walk)
//   idx2: Workout    0m  2026-03-16 13:01:41+00  (Monday morning strength session)
const bugActivities = [
  { activity_type: 'Run',     distance_meters: 11832.6, start_date: '2026-03-17 13:17:58+00' },
  { activity_type: 'Run',     distance_meters:  3912.6, start_date: '2026-03-17 01:20:36+00' },
  { activity_type: 'Workout', distance_meters:       0, start_date: '2026-03-16 13:01:41+00' },
];

// Strava stats that were in onboarding_data — recent_run_totals showed ~27 miles
// (the figure Dean hallucinated)
const bugStravaStats = {
  all_run_totals:    { count: 312, distance: 2_500_000 },
  ytd_run_totals:    { count:  18, distance:   120_000 },
  recent_run_totals: { count:   7, distance:    43_000 }, // ~26.7 miles — the culprit
};

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\ncomputeWeekMileage() — bug-report activities');

// Week of 2026-03-18 (Wednesday), Monday = 2026-03-16
// Both Run activities fall in this week; Workout is excluded
for (const tz of ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']) {
  const miles = computeWeekMileage(bugActivities, tz);
  assertClose(`${tz}: ~9.8mi (not 27)`, miles, 9.78, 0.1);
}

console.log('\nrecent_run_totals removed from allTimeInfo');

const allTimeInfo = buildAllTimeInfo(bugStravaStats);
assert('recent_run_totals not in allTimeInfo', allTimeInfo.includes('Last 4 weeks'), false);
assert('recent_run_totals miles not in allTimeInfo', allTimeInfo.includes('26'), false);
assert('all_run_totals still present', allTimeInfo.includes('All-time'), true);
assert('ytd_run_totals still present', allTimeInfo.includes('Year-to-date'), true);

console.log('\nAuthoritative mileage line format');

const stateLine = buildCurrentTrainingStateLine(9.78, 2);
assert('⚠️ prefix present', stateLine.startsWith('⚠️ AUTHORITATIVE WEEKLY MILEAGE'), true);
assert('correct mileage in line', stateLine.includes('9.8 mi'), true);
assert('run count in line', stateLine.includes('2 runs'), true);
assert('does not reference Last 4 weeks', stateLine.includes('Last 4 weeks'), false);

console.log('\nWeek boundary edge cases');

// Activity at exactly midnight Monday in user's timezone should be included
const midnightMonday = [
  { activity_type: 'Run', distance_meters: 8000, start_date: '2026-03-16 05:00:00+00' }, // midnight ET (UTC-5)
];
const midnightMiles = computeWeekMileage(midnightMonday, 'America/New_York');
assertClose('Midnight Monday ET included in week', midnightMiles, 4.97, 0.05);

// Activity just before Monday (Sunday 11:59pm ET) should NOT be included.
// In mid-March New York is EDT (UTC-4), so Sunday 11:59pm ET = Monday 03:59 UTC.
// Use 03:59 UTC to land at 23:59 Sunday EDT.
const sundayNight = [
  { activity_type: 'Run', distance_meters: 8000, start_date: '2026-03-16 03:59:00+00' }, // 11:59pm Sunday EDT
];
const sundayMiles = computeWeekMileage(sundayNight, 'America/New_York');
assert('Sunday 11:59pm EDT excluded from current week', sundayMiles, 0);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
