/**
 * Quick tests for deduplicateActivities() and correctMileageTotal().
 * Run with: node scripts/test-dedup-mileage.mjs
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

// ─── deduplicateActivities ────────────────────────────────────────────────────

function deduplicateActivities(activities) {
  const kept = [];
  for (const a of activities) {
    const aMs = new Date(a.start_date).getTime();
    const dupeIndex = kept.findIndex((k) => {
      const kMs = new Date(k.start_date).getTime();
      if (Math.abs(aMs - kMs) > 120_000) return false;
      const larger = Math.max(k.distance_meters || 0, a.distance_meters || 0);
      if (larger === 0) return false;
      return Math.abs((k.distance_meters || 0) - (a.distance_meters || 0)) / larger < 0.15;
    });
    if (dupeIndex === -1) {
      kept.push(a);
    } else if (a.average_heartrate != null && kept[dupeIndex].average_heartrate == null) {
      kept[dupeIndex] = a;
    }
  }
  return kept;
}

console.log("\ndeduplicateActivities()");

// Luke's exact case: 7.0mi (no HR) + 6.61mi (has HR), 5 seconds apart
const lukeDupes = [
  { id: "A", strava_activity_id: 17685580607, start_date: "2026-03-11T13:15:30Z", distance_meters: 11265.4, average_heartrate: null,  activity_type: "Run" },
  { id: "B", strava_activity_id: 17685741306, start_date: "2026-03-11T13:15:25Z", distance_meters: 10642.7, average_heartrate: 152,   activity_type: "Run" },
];
const lukeResult = deduplicateActivities(lukeDupes);
assert("Luke: two near-dupes → one kept", lukeResult.length, 1);
assert("Luke: richer (HR) record kept", lukeResult[0].id, "B");

// Two distinct runs on the same day but far apart in time → both kept
const distinctRuns = [
  { id: "C", start_date: "2026-03-11T07:00:00Z", distance_meters: 8000, average_heartrate: null, activity_type: "Run" },
  { id: "D", start_date: "2026-03-11T18:00:00Z", distance_meters: 8000, average_heartrate: null, activity_type: "Run" },
];
assert("Distinct runs (>2min apart) → both kept", deduplicateActivities(distinctRuns).length, 2);

// Near-duplicate where existing is richer → keep existing, discard incoming
const existingRicher = [
  { id: "E", start_date: "2026-03-12T10:00:00Z", distance_meters: 7500, average_heartrate: 148, activity_type: "Run" },
  { id: "F", start_date: "2026-03-12T10:00:30Z", distance_meters: 7600, average_heartrate: null, activity_type: "Run" },
];
const richerResult = deduplicateActivities(existingRicher);
assert("Existing richer → keep existing", richerResult.length, 1);
assert("Existing richer → correct record kept", richerResult[0].id, "E");

// Exactly at the 2-minute boundary (120s) — should still deduplicate
const atBoundary = [
  { id: "G", start_date: "2026-03-13T08:00:00Z", distance_meters: 9000, average_heartrate: null, activity_type: "Run" },
  { id: "H", start_date: "2026-03-13T08:02:00Z", distance_meters: 9000, average_heartrate: null, activity_type: "Run" },
];
assert("At 120s boundary → deduped", deduplicateActivities(atBoundary).length, 1);

// Just over boundary (121s) → both kept
const overBoundary = [
  { id: "I", start_date: "2026-03-13T08:00:00Z", distance_meters: 9000, average_heartrate: null, activity_type: "Run" },
  { id: "J", start_date: "2026-03-13T08:02:01Z", distance_meters: 9000, average_heartrate: null, activity_type: "Run" },
];
assert("Just over 120s → both kept", deduplicateActivities(overBoundary).length, 2);

// Distance too different (>15%) → both kept
const differentDistance = [
  { id: "K", start_date: "2026-03-14T09:00:00Z", distance_meters: 5000, average_heartrate: null, activity_type: "Run" },
  { id: "L", start_date: "2026-03-14T09:00:10Z", distance_meters: 8000, average_heartrate: null, activity_type: "Run" },
];
assert("Distance >15% different → both kept", deduplicateActivities(differentDistance).length, 2);

// ─── correctMileageTotal ──────────────────────────────────────────────────────

const nonRunningRe = /strength|mobility|yoga|bike|swim|elliptical|cross.train|rest day|hike/i;
const sessionLineRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d+\/\d+\s+·\s+(.+)$/gm;

function correctMileageTotal(message, alreadyCompletedMiles = 0) {
  let plannedMiles = 0;
  let hasSessionList = false;
  let m;

  sessionLineRe.lastIndex = 0;
  while ((m = sessionLineRe.exec(message)) !== null) {
    hasSessionList = true;
    const desc = m[2];
    if (nonRunningRe.test(desc)) continue;
    const explicitTotal = desc.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi/i)
      || desc.match(/\((\d+(?:\.\d+)?)\s*mi(?:\s+total)?\)/i);
    const firstMi = desc.match(/(\d+(?:\.\d+)?)\s*mi/i);
    const miMatch = explicitTotal || firstMi;
    if (miMatch) plannedMiles += parseFloat(miMatch[1]);
  }

  if (!hasSessionList || plannedMiles === 0) return message;

  const correctTotal = Math.round((plannedMiles + alreadyCompletedMiles) * 10) / 10;
  const plannedRounded = Math.round(plannedMiles * 10) / 10;

  const totalPatterns = [
    /(Total:\s*~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?\s*(?:total|this week|for the week))/gi,
    /(week(?:ly)?\s+(?:mileage|total)[:\s]+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(stays?\s+at\s+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(staying\s+at\s+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(puts\s+(?:you\s+at|the\s+week\s+at)\s+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  ];

  let corrected = message;
  for (const pattern of totalPatterns) {
    corrected = corrected.replace(pattern, (full, pre, num, post) => {
      const stated = parseFloat(num);
      if (Math.abs(stated - correctTotal) <= 0.4) return full;
      if (alreadyCompletedMiles > 0.5 && Math.abs(stated - plannedRounded) <= 0.4) {
        return `${pre}${correctTotal}${post}`;
      }
      return `${pre}${correctTotal}${post}`;
    });
  }
  return corrected;
}

console.log("\ncorrectMileageTotal()");

// The exact failing case: 5 sessions summing to 26mi, stated as 16
const lukeFailingMsg = `Here's your taper week:

Mon 3/16 · Rest day
Tue 3/17 · Easy 5mi @ 9:30/mi
Wed 3/18 · Tempo 7mi (2mi easy, 3×1mi @ 7:00, 1mi cooldown)
Thu 3/19 · Easy 4mi
Sat 3/21 · Easy 6mi
Sun 3/22 · Long run 4mi easy

Total: ~16 miles for the week. Keeps you fresh and sharp heading into race week.`;

const corrected1 = correctMileageTotal(lukeFailingMsg);
assert("Luke failing case: corrects 16 → 26", corrected1.includes("26mi") || corrected1.includes("26 miles"), true);
assert("Luke failing case: no longer contains 16mi total", !corrected1.includes("Total: ~16"), true);

// Interval session with ≈ total marker
const intervalMsg = `Here's your week:

Mon 3/16 · Rest day
Tue 3/17 · Intervals 2mi easy, 3×1mi @ 6:45, 1mi cooldown ≈7mi
Wed 3/18 · Easy 5mi @ 9:30/mi
Sat 3/21 · Long run 10mi easy

Total: ~16mi for the week.`;

const corrected2 = correctMileageTotal(intervalMsg);
// Tue=7, Wed=5, Sat=10 = 22mi
assert("Interval ≈ marker: corrects to 22mi", corrected2.includes("22mi") || corrected2.includes("22 mi"), true);

// Correct total — should NOT be changed
const correctMsg = `Mon 3/16 · Easy 5mi @ 9:30/mi
Tue 3/17 · Tempo 6mi
Thu 3/19 · Easy 4mi
Sat 3/21 · Long run 8mi easy

Total: ~23 miles for the week.`;
const notCorrected = correctMileageTotal(correctMsg);
assert("Correct total unchanged", notCorrected.includes("~23 miles"), true);

// Strength day should not contribute mileage
const strengthMsg = `Mon 3/16 · Strength + mobility 30 min
Tue 3/17 · Easy 5mi @ 9:30/mi
Thu 3/19 · Easy 5mi

Total: ~10mi for the week.`;
const strengthResult = correctMileageTotal(strengthMsg);
assert("Strength day excluded from total", strengthResult.includes("~10mi"), true);

// No session list → no-op
const noSessionMsg = "Great work this week! You hit 25 miles total.";
assert("No session list → no-op", correctMileageTotal(noSessionMsg), noSessionMsg);

// ─── correctMileageTotal() with alreadyCompletedMiles (the b1b308cf bug) ─────

console.log("\ncorrectMileageTotal() with existing week miles");

// Exact bug: 9.8mi already done, plan = 8+6+5+10 = 29mi, Dean stated 29 (plan only)
const bugMsg = `Wed 3/18 · Easy 8mi @ 9:00/mi
Thu 3/19 · Easy 6mi @ 9:00/mi
Fri 3/20 · Easy 5mi @ 9:00/mi
Sat 3/21 · Long run 10mi easy

That puts you at 29 miles total for the week.`;

const bugCorrected = correctMileageTotal(bugMsg, 9.8);
assert("Bug: stated plan-only total (29) corrected to full week (38.8)", bugCorrected.includes("38.8"), true);
assert("Bug: original wrong total removed", !bugCorrected.includes("29 miles"), true);

// Dean correctly states the full week total — should NOT be changed
const correctWeekMsg = `Wed 3/18 · Easy 8mi @ 9:00/mi
Thu 3/19 · Easy 6mi @ 9:00/mi
Fri 3/20 · Easy 5mi @ 9:00/mi
Sat 3/21 · Long run 10mi easy

That puts you at 38.8 miles total for the week.`;

const notChangedWeek = correctMileageTotal(correctWeekMsg, 9.8);
assert("Correct full-week total (38.8) unchanged", notChangedWeek.includes("38.8 miles"), true);

// weekly_recap (alreadyCompletedMiles = 0) — plan total should be used as-is
const recapMsg = `Mon 3/23 · Easy 5mi
Wed 3/25 · Tempo 7mi
Sat 3/28 · Long run 12mi

Total: ~24 miles for the week.`;

const recapResult = correctMileageTotal(recapMsg, 0);
assert("Weekly recap (0 existing miles): correct total unchanged", recapResult.includes("~24 miles"), true);

// weekly_recap with wrong total, no existing miles
const recapWrong = `Mon 3/23 · Easy 5mi
Wed 3/25 · Tempo 7mi
Sat 3/28 · Long run 12mi

Total: ~20 miles for the week.`;

const recapFixed = correctMileageTotal(recapWrong, 0);
assert("Weekly recap wrong total (20→24) corrected", recapFixed.includes("24"), true);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
