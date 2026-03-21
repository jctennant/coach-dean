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
  // Pass 1: near-dupe by start time (±2 min)
  const kept = [];
  for (const a of activities) {
    const aMs = new Date(a.start_date).getTime();
    const dupeIndex = kept.findIndex((k) => {
      if (k.activity_type !== a.activity_type) return false;
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

  // Pass 2: drop manual/conversation activities that have a Strava counterpart on the same UTC
  // date with similar distance.
  const stravaDates = new Map();
  for (const a of kept) {
    if (a.source === "strava" || a.source == null) {
      const dateKey = a.start_date.slice(0, 10);
      if (!stravaDates.has(dateKey)) stravaDates.set(dateKey, []);
      stravaDates.get(dateKey).push(a.distance_meters || 0);
    }
  }

  return kept.filter((a) => {
    if (a.source !== "manual" && a.source !== "conversation") return true;
    const dateKey = a.start_date.slice(0, 10);
    const stravaMiles = stravaDates.get(dateKey);
    if (!stravaMiles) return true;
    const aDist = a.distance_meters || 0;
    return !stravaMiles.some((d) => {
      const larger = Math.max(d, aDist);
      return larger > 0 && Math.abs(d - aDist) / larger < 0.15;
    });
  });
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

// Cross-type: bike + run within 2min, similar distance → both kept (issue 4)
const bikeRunSameTime = [
  { id: "M", start_date: "2026-03-15T14:00:00Z", distance_meters: 6437, average_heartrate: null, activity_type: "Run" },
  { id: "N", start_date: "2026-03-15T14:00:30Z", distance_meters: 6500, average_heartrate: 140,  activity_type: "Ride" },
];
assert("Cross-type (Run + Ride) not deduped even if distance/time match", deduplicateActivities(bikeRunSameTime).length, 2);

// ─── Pass 2: manual/conversation shadow of a Strava activity ─────────────────

console.log("\ndeduplicateActivities() — Pass 2: manual shadow removal");

// Jake's exact case: manual activity at noon UTC (from earlier SMS), Strava activity
// at actual run time (hours apart). Strava webhook race condition left both in DB.
const jakeShadow = [
  { id: "P1", start_date: "2026-03-21T00:24:33Z", distance_meters: 4911,  average_heartrate: 138.5, activity_type: "Run", source: "strava" },
  { id: "P2", start_date: "2026-03-21T12:00:00Z", distance_meters: 4828,  average_heartrate: null,  activity_type: "Run", source: "manual" },
];
const jakeShadowResult = deduplicateActivities(jakeShadow);
assert("Manual shadow on same UTC date → manual removed", jakeShadowResult.length, 1);
assert("Strava record kept", jakeShadowResult[0].source, "strava");

// Manual on different UTC date than Strava → both kept (no false positive)
const differentDayManual = [
  { id: "Q1", start_date: "2026-03-21T00:24:33Z", distance_meters: 4911, average_heartrate: 138.5, activity_type: "Run", source: "strava" },
  { id: "Q2", start_date: "2026-03-20T12:00:00Z", distance_meters: 4828, average_heartrate: null,  activity_type: "Run", source: "manual" },
];
assert("Manual on different UTC date → both kept", deduplicateActivities(differentDayManual).length, 2);

// Manual with very different distance → kept (not a shadow)
const differentDistanceManual = [
  { id: "R1", start_date: "2026-03-21T13:00:00Z", distance_meters: 8000, average_heartrate: 145, activity_type: "Run", source: "strava" },
  { id: "R2", start_date: "2026-03-21T12:00:00Z", distance_meters: 4800, average_heartrate: null, activity_type: "Run", source: "manual" },
];
assert("Manual with >15% distance diff → both kept", deduplicateActivities(differentDistanceManual).length, 2);

// Two Strava activities on same day with similar distance → NOT deduped by Pass 2 (different sources)
const twoStravasSameDay = [
  { id: "S1", start_date: "2026-03-21T07:00:00Z", distance_meters: 4800, average_heartrate: null, activity_type: "Run", source: "strava" },
  { id: "S2", start_date: "2026-03-21T18:00:00Z", distance_meters: 4900, average_heartrate: null, activity_type: "Run", source: "strava" },
];
assert("Two Strava runs same day, similar distance → both kept (legitimate double workout)", deduplicateActivities(twoStravasSameDay).length, 2);

// Conversation source treated same as manual
const conversationShadow = [
  { id: "T1", start_date: "2026-03-19T14:00:00Z", distance_meters: 5000, average_heartrate: 150, activity_type: "Run", source: "strava" },
  { id: "T2", start_date: "2026-03-19T12:00:00Z", distance_meters: 4900, average_heartrate: null, activity_type: "Run", source: "conversation" },
];
const convResult = deduplicateActivities(conversationShadow);
assert("Conversation shadow on same UTC date → removed", convResult.length, 1);
assert("Strava record kept over conversation shadow", convResult[0].source, "strava");

// ─── correctMileageTotal ──────────────────────────────────────────────────────

const sessionLineRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d+)\/(\d+)\s+·\s+(.+)$/gm;

function getUTCMonday(d) {
  const dow = d.getUTCDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  return d.getTime() - daysBack * 86_400_000;
}

function correctMileageTotal(message, alreadyCompletedMiles = 0) {
  let plannedMiles = 0;
  let hasSessionList = false;
  let earliestSessionMs = Infinity;
  let m;

  sessionLineRe.lastIndex = 0;
  while ((m = sessionLineRe.exec(message)) !== null) {
    hasSessionList = true;
    const monthNum = parseInt(m[2], 10);
    const dayNum = parseInt(m[3], 10);
    const desc = m[4];

    const now = new Date();
    const sessionDate = new Date(Date.UTC(now.getUTCFullYear(), monthNum - 1, dayNum));
    if (now.getTime() - sessionDate.getTime() > 180 * 24 * 60 * 60 * 1000) {
      sessionDate.setUTCFullYear(now.getUTCFullYear() + 1);
    }
    if (sessionDate.getTime() < earliestSessionMs) earliestSessionMs = sessionDate.getTime();

    const explicitTotal = desc.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi/i)
      || desc.match(/\((\d+(?:\.\d+)?)\s*mi(?:\s+total)?\)/i);
    const firstMi = desc.match(/(\d+(?:\.\d+)?)\s*mi/i);
    const miMatch = explicitTotal || firstMi;
    if (miMatch) plannedMiles += parseFloat(miMatch[1]);
  }

  if (!hasSessionList || plannedMiles === 0) return message;

  let effectiveCompleted = alreadyCompletedMiles;
  if (earliestSessionMs !== Infinity && alreadyCompletedMiles > 0) {
    const planMonday = getUTCMonday(new Date(earliestSessionMs));
    const todayMonday = getUTCMonday(new Date());
    if (planMonday > todayMonday) effectiveCompleted = 0;
  }

  const correctTotal = Math.round((plannedMiles + effectiveCompleted) * 10) / 10;
  const plannedRounded = Math.round(plannedMiles * 10) / 10;

  const totalPatterns = [
    /(Total:\s*~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?\s*(?:total|this week|for the week))/gi,
    /(week(?:ly)?\s+(?:mileage|total)[:\s]+~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(stays?\s+at\s+~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(staying\s+at\s+~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(puts\s+(?:you\s+at|the\s+week\s+at)\s+~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  ];

  let corrected = message;
  for (const pattern of totalPatterns) {
    corrected = corrected.replace(pattern, (full, pre, num, post) => {
      const stated = parseFloat(num);
      if (Math.abs(stated - correctTotal) <= 0.4) return full;
      if (effectiveCompleted > 0.5 && Math.abs(stated - effectiveCompleted) <= 0.4) return full;
      if (effectiveCompleted > 0.5 && Math.abs(stated - plannedRounded) <= 0.4) {
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

// ─── correctMileageTotal() future-week detection ─────────────────────────────

console.log("\ncorrectMileageTotal() future-week detection");

// Build next-week dates dynamically so the test doesn't rot as time passes
{
  const now = new Date();
  const todayDow = now.getUTCDay(); // 0=Sun
  const daysToNextMon = todayDow === 0 ? 1 : 8 - todayDow;
  const nextMon = new Date(now.getTime() + daysToNextMon * 86_400_000);
  const nextWed = new Date(nextMon.getTime() + 2 * 86_400_000);
  const nextThu = new Date(nextMon.getTime() + 3 * 86_400_000);
  const nextSat = new Date(nextMon.getTime() + 5 * 86_400_000);
  const fmt = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const dayName = (d) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];

  // Exact failing case: user asks for next week's plan mid-week (10 mi done this week).
  // Plan = 3+4+4+4 = 15 mi; alreadyCompletedMiles = 10. Dean states "15 mi total" which
  // is correct for next week but was being "corrected" to 25 because the function
  // added current-week miles to a future-week plan.
  const nextWeekMsg = `${dayName(nextMon)} ${fmt(nextMon)} · Easy 3mi @ 9:30–9:50
${dayName(nextWed)} ${fmt(nextWed)} · Easy 4mi @ 9:30–9:50
${dayName(nextThu)} ${fmt(nextThu)} · Easy 4mi @ 9:30–9:50
${dayName(nextSat)} ${fmt(nextSat)} · Easy 4mi @ 9:30–9:50

15 mi total, all easy pace.`;

  const nextWeekResult = correctMileageTotal(nextWeekMsg, 10);
  assert("Future-week plan: 15 mi total not inflated to 25 (bug fix)", nextWeekResult.includes("15 mi total"), true);
  assert("Future-week plan: does not contain 25", !nextWeekResult.includes("25"), true);

  // Dean states wrong total for a future-week plan — should still be corrected to planned sum
  const nextWeekWrong = `${dayName(nextMon)} ${fmt(nextMon)} · Easy 3mi @ 9:30–9:50
${dayName(nextWed)} ${fmt(nextWed)} · Easy 4mi @ 9:30–9:50
${dayName(nextSat)} ${fmt(nextSat)} · Easy 4mi @ 9:30–9:50

20 mi total, all easy pace.`;

  const nextWeekWrongResult = correctMileageTotal(nextWeekWrong, 10);
  // planned = 3+4+4 = 11mi; correct for future week = 11 (not 21)
  assert("Future-week plan: wrong total corrected to plan sum (not plan+completed)", nextWeekWrongResult.includes("11"), true);
}

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

// ─── correctMileageTotal() range-typo guard (issue 6) ────────────────────────

console.log("\ncorrectMileageTotal() range-typo guard");

// "34-36 miles total" — correctMileageTotal should NOT mangle it into "34-26"
// by replacing the second number in the range. The sessions sum to 36mi.
const rangeMsg = `Mon 3/23 · Easy 6mi
Tue 3/24 · Tempo 8mi
Thu 3/26 · Easy 6mi
Sat 3/28 · Long run 10mi
Sun 3/29 · Easy 6mi

That puts you at 34-36 miles total for the week.`;

const rangeResult = correctMileageTotal(rangeMsg, 0);
// plannedMiles = 6+8+6+10+6 = 36. correctTotal = 36.
// "36 miles total" IS the correct total → no replacement needed.
// But even if there were a correction attempted, "34" should NOT be
// turned into something else (it's a lower bound in a range, not a total).
assert("Range phrase not mangled: still contains '34-'", rangeResult.includes("34-"), true);

// Simulate the actual bug: sessions sum to 26mi but Dean wrote "34-36 miles total"
// (wrong total, range form). correctMileageTotal should correct to 26 but must NOT
// produce "34-26" — the correction should target the whole range, not just 36.
// In practice the session-list guardrail catches this, but the range guard prevents
// the worst-case "34-26" corruption even if the regex fires.
const rangeBugMsg = `Mon 3/23 · Easy 5mi
Tue 3/24 · Tempo 7mi
Thu 3/26 · Easy 4mi
Sat 3/28 · Long run 10mi

That puts you at 34-36 miles total for the week.`;
const rangeBugResult = correctMileageTotal(rangeBugMsg, 0);
// plannedMiles = 5+7+4+10 = 26. correctTotal = 26.
// Pattern 2 would previously match "36 miles total..." and replace 36→26 → "34-26 miles"
// With the fix ((?<!-) lookbehind), "36" is preceded by "-" → not replaced.
assert("Range-typo bug: '34-26' not produced", !rangeBugResult.includes("34-26"), true);

// ─── computeProjectedWeekMiles() ─────────────────────────────────────────────

console.log("\ncomputeProjectedWeekMiles()");

function computeProjectedWeekMiles(sessions, weekMileageSoFar) {
  if (!sessions || sessions.length === 0) return null;
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const activeSessions = sessions.filter(s => {
    const [m, d] = s.date.split("/").map(Number);
    if (isNaN(m) || isNaN(d)) return true;
    const sessionDate = new Date(Date.UTC(now.getUTCFullYear(), m - 1, d));
    return sessionDate.getTime() >= todayUTC.getTime();
  });
  if (activeSessions.length === 0) return weekMileageSoFar;
  let remainingMiles = 0;
  for (const s of activeSessions) {
    const explicitTotal = s.label.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi/i)
      || s.label.match(/\((\d+(?:\.\d+)?)\s*mi(?:\s+total)?\)/i);
    const firstMi = s.label.match(/(\d+(?:\.\d+)?)\s*mi/i);
    const mMatch = explicitTotal || firstMi;
    if (mMatch) remainingMiles += parseFloat(mMatch[1]);
  }
  return weekMileageSoFar + remainingMiles;
}

function correctProjectedTotal(message, projectedWeekMiles) {
  if (!projectedWeekMiles || projectedWeekMiles <= 0) return message;
  const projected = Math.round(projectedWeekMiles * 10) / 10;
  const patterns = [
    /(on\s+track\s+for\s+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(on\s+pace\s+for\s+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(projected\s+(?:(?:to\s+hit|total)[:\s]+)?~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  ];
  let corrected = message;
  for (const pattern of patterns) {
    corrected = corrected.replace(pattern, (full, pre, num, post) => {
      const stated = parseFloat(num);
      if (Math.abs(stated - projected) <= 0.4) return full;
      return `${pre}${projected}${post}`;
    });
  }
  return corrected;
}

{
  const now = new Date();
  // Build a date string for tomorrow (future session)
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const in2days = new Date(now.getTime() + 2 * 86_400_000);
  const yesterday = new Date(now.getTime() - 86_400_000);
  const fmt = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const dayName = (d) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];

  // Two upcoming sessions (4mi + 3mi), 5.1 done → projection = 12.1
  const sessions = [
    { day: dayName(tomorrow), date: fmt(tomorrow), label: "Long run 4mi easy" },
    { day: dayName(in2days), date: fmt(in2days), label: "Easy 3mi @ 9:30/mi" },
  ];
  const projected = computeProjectedWeekMiles(sessions, 5.1);
  assertClose("computeProjectedWeekMiles: 5.1 + 4 + 3 = 12.1", projected, 12.1, 0.05);

  // Past sessions only → returns weekMileageSoFar
  const pastSessions = [
    { day: dayName(yesterday), date: fmt(yesterday), label: "Easy 4mi" },
  ];
  const projectedPast = computeProjectedWeekMiles(pastSessions, 5.1);
  assertClose("computeProjectedWeekMiles: all past → returns done miles", projectedPast, 5.1, 0.05);

  // No sessions → null
  assert("computeProjectedWeekMiles: no sessions → null", computeProjectedWeekMiles(null, 5.1), null);

  // correctProjectedTotal: wrong "on track for" → corrected
  const postRunMsg = "Saw it — 2.5mi easy. You're at 5.1 mi this week, on track for 15 mi total. Sat long run (4mi) and Mon easy (3mi) are up next.";
  const fixedMsg = correctProjectedTotal(postRunMsg, 12.1);
  assert("correctProjectedTotal: 15 mi → 12.1 mi when projection is 12.1", fixedMsg.includes("on track for 12.1 mi"), true);
  assert("correctProjectedTotal: 15 removed", !fixedMsg.includes("on track for 15"), true);

  // correctProjectedTotal: correct value → unchanged
  const correctPostRun = "You're at 5.1 mi this week, on track for 12.1 mi total.";
  const notFixed = correctProjectedTotal(correctPostRun, 12.1);
  assert("correctProjectedTotal: correct value unchanged", notFixed === correctPostRun, true);

  // correctProjectedTotal: no projection → no-op
  const noProjection = "Nice easy 3mi today. Rest day tomorrow.";
  assert("correctProjectedTotal: no 'on track for' → no-op", correctProjectedTotal(noProjection, 12.1), noProjection);

  // correctProjectedTotal: null projection → no-op
  assert("correctProjectedTotal: null projection → no-op", correctProjectedTotal(postRunMsg, null), postRunMsg);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
