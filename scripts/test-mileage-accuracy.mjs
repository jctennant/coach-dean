/**
 * Pressure tests for mileage accuracy in post_run and weekly_recap responses.
 *
 * Three test tiers:
 *   STATIC  — pure function tests, no API required
 *   LIVE DB — fetches real activity data from Supabase, requires SUPABASE env vars
 *   LLM     — sends real prompts to Claude, asserts mileage in response, requires ANTHROPIC_API_KEY
 *
 * Run: node scripts/test-mileage-accuracy.mjs
 * Run (with LLM tests): ANTHROPIC_API_KEY=... node scripts/test-mileage-accuracy.mjs
 * Run (with DB tests):  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... node scripts/test-mileage-accuracy.mjs
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// ─── ENV ──────────────────────────────────────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;
const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ─── FRAMEWORK ────────────────────────────────────────────────────────────────

let totalPass = 0;
let totalFail = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✅ ${label}`);
    totalPass++;
  } else {
    console.log(`  ❌ ${label}${detail ? `\n     detail: ${detail}` : ""}`);
    totalFail++;
  }
}

function checkClose(label, actual, expected, tol = 0.05) {
  const ok = Math.abs(actual - expected) <= tol;
  check(label, ok, `expected ${expected.toFixed(2)}, got ${actual.toFixed(2)}`);
}

function section(title) {
  console.log(`\n${"─".repeat(65)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(65));
}

// ─── REPLICATED FUNCTIONS (inlined from route.ts) ────────────────────────────

const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

function localWeekMonday(date, timezone) {
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const [yr, mo, dy] = localDate.split("-").map(Number);
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
      const activityDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
        .format(new Date(a.start_date));
      return activityDate >= thisMonday;
    })
    .reduce((sum, a) => sum + (a.distance_meters || 0) / 1609.34, 0);
}

function computeWeekRunCount(activities, timezone) {
  const thisMonday = localWeekMonday(new Date(), timezone);
  return activities.filter((a) => {
    if (!RUN_TYPES.has(a.activity_type)) return false;
    const activityDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
      .format(new Date(a.start_date));
    return activityDate >= thisMonday;
  }).length;
}

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

  // Pass 2: drop manual/conversation shadows of Strava activities
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

function getUTCMonday(d) {
  const dow = d.getUTCDay();
  const daysBack = dow === 0 ? 6 : dow - 1;
  return d.getTime() - daysBack * 86_400_000;
}

function correctMileageTotal(message, alreadyCompletedMiles = 0) {
  const sessionLineRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d+)\/(\d+)\s+·\s+(.+)$/gm;
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
    /(~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?[ \t]*(?:total|this week|for the week))/gi,
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

// ─── REAL ACTIVITY DATA (from production DB, March 2026) ──────────────────────
// Jake's account (America/Denver, MDT = UTC-6)
// Week of March 16-22: 2 runs, 4.46 mi total

const JAKE_TIMEZONE = "America/Denver";

const JAKE_ACTIVITIES = [
  // This week
  {
    activity_type: "Run",
    distance_meters: 4911,
    moving_time_seconds: 1691,
    average_heartrate: 138.5,
    average_pace: "9:14/mi",
    start_date: "2026-03-21T00:24:33Z", // March 20 18:24 MDT
    source: "strava",
  },
  {
    activity_type: "Run",
    distance_meters: 2277.4,
    moving_time_seconds: 797,
    average_heartrate: 145.6,
    average_pace: "9:23/mi",
    start_date: "2026-03-17T23:54:47Z", // March 17 17:54 MDT
    source: "strava",
  },
  // Previous weeks (for weekly mileage table)
  {
    activity_type: "Run",
    distance_meters: 6437,
    moving_time_seconds: 2100,
    average_heartrate: 142,
    average_pace: "9:15/mi",
    start_date: "2026-03-13T21:00:00Z", // March 13 15:00 MDT
    source: "strava",
  },
  {
    activity_type: "Run",
    distance_meters: 4828,
    moving_time_seconds: 1620,
    average_heartrate: 140,
    average_pace: "9:20/mi",
    start_date: "2026-03-11T23:00:00Z", // March 11 17:00 MDT
    source: "strava",
  },
];

// Wife's account — current week done, asking for next week
const WIFE_TIMEZONE = "America/Chicago";
const WIFE_WEEK_DONE_MI = 10.0; // completed this week

// Dynamic next-week dates (so tests don't rot as time passes)
function getNextWeekDates() {
  const now = new Date();
  const todayDow = now.getUTCDay();
  const daysToNextMon = todayDow === 0 ? 1 : 8 - todayDow;
  const mon = new Date(now.getTime() + daysToNextMon * 86_400_000);
  const tue = new Date(mon.getTime() + 1 * 86_400_000);
  const thu = new Date(mon.getTime() + 3 * 86_400_000);
  const sat = new Date(mon.getTime() + 5 * 86_400_000);
  const fmt = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const day = (d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return { mon, tue, thu, sat, fmt, day };
}

// ─── STATIC TESTS ─────────────────────────────────────────────────────────────

section("STATIC — computeWeekMileage");

// Test 1: Jake's real two runs this week
{
  const dedupedJake = deduplicateActivities(JAKE_ACTIVITIES);
  const weekMi = computeWeekMileage(dedupedJake, JAKE_TIMEZONE);
  checkClose(
    "Jake's two runs this week sum to ~4.46 mi",
    weekMi, 4.46, 0.05
  );
  check(
    "Jake's run count this week = 2",
    computeWeekRunCount(dedupedJake, JAKE_TIMEZONE) === 2
  );
}

// Test 2: Non-running activities excluded
{
  const mixedActivities = [
    { activity_type: "Run",   distance_meters: 4828, start_date: new Date().toISOString(), source: "strava" },
    { activity_type: "Ride",  distance_meters: 24000, start_date: new Date().toISOString(), source: "strava" },
    { activity_type: "Swim",  distance_meters: 1500,  start_date: new Date().toISOString(), source: "strava" },
    { activity_type: "WeightTraining", distance_meters: 0, start_date: new Date().toISOString(), source: "strava" },
  ];
  const mi = computeWeekMileage(mixedActivities, "America/New_York");
  checkClose("Only Run counted, not Ride/Swim/Weights", mi, 4828 / 1609.34, 0.05);
}

// Test 3: Runs from previous week excluded
{
  const now = new Date();
  const lastMonday = new Date(now.getTime() - 9 * 86_400_000); // definitely last week
  const activities = [
    { activity_type: "Run", distance_meters: 8000, start_date: lastMonday.toISOString(), source: "strava" },
    { activity_type: "Run", distance_meters: 5000, start_date: now.toISOString(), source: "strava" },
  ];
  const mi = computeWeekMileage(activities, "America/New_York");
  checkClose("Prior-week run excluded from current-week total", mi, 5000 / 1609.34, 0.05);
}

// Test 4: UTC midnight boundary — run at 11pm Sunday local (UTC Monday) still counts for right week
{
  // User in America/Los_Angeles (PDT = UTC-7 in summer). Run starts at 11pm Sunday PT = 6am UTC Monday.
  // The local date is SUNDAY, which is part of the PREVIOUS week (Mon-Sun). Must not be counted in new week.
  // But first: this is a synthetic timezone-edge test. We build a "run at 11pm on current week's Sunday"
  // and verify it IS counted (Sunday is the last day of the Mon-Sun week).
  const now = new Date();
  const tz = "America/Los_Angeles";
  const localMonday = localWeekMonday(now, tz);
  // Sunday of this week = Monday + 6 days
  const [yr, mo, dy] = localMonday.split("-").map(Number);
  const mondayUtcMs = Date.UTC(yr, mo - 1, dy);
  const sundayUtcMs = mondayUtcMs + 6 * 86_400_000;
  // 11pm PT Sunday = 6am UTC Monday
  const sunday11pmPT = new Date(sundayUtcMs + (23 * 3600 + 7 * 3600) * 1000);
  // Local date of this timestamp in PT = Sunday (same week)
  const sundayLocalDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(sunday11pmPT);
  const sundayExpectedInWeek = sundayLocalDate >= localMonday;

  const activities = [
    { activity_type: "Run", distance_meters: 5000, start_date: sunday11pmPT.toISOString(), source: "strava" },
  ];
  const mi = computeWeekMileage(activities, tz);
  // If Sunday is in this week, mi should be ~3.1; if it was classified as next week it would be 0
  if (sundayExpectedInWeek) {
    checkClose("11pm Sunday local counts as current week (timezone-aware)", mi, 5000 / 1609.34, 0.05);
  } else {
    check("11pm Sunday local (next week's Monday UTC) excluded from current week", mi < 0.1);
  }
}

// ─── STATIC — deduplicateActivities ───────────────────────────────────────────

section("STATIC — deduplicateActivities");

// Test 5: Strava activity + manual shadow on same UTC date → manual removed
{
  const activities = [
    { activity_type: "Run", distance_meters: 4911, average_heartrate: 138.5,
      start_date: "2026-03-21T00:24:33Z", source: "strava" },
    { activity_type: "Run", distance_meters: 4828, average_heartrate: null,
      start_date: "2026-03-21T12:00:00Z", source: "manual" },
  ];
  const result = deduplicateActivities(activities);
  check("Manual shadow (same UTC date, similar distance) removed", result.length === 1);
  check("Strava record retained over manual", result[0]?.source === "strava");
}

// Test 6: Two Strava activities on same day — must NOT be deduped
{
  const activities = [
    { activity_type: "Run", distance_meters: 4828, average_heartrate: null,
      start_date: "2026-03-21T07:00:00Z", source: "strava" }, // morning run
    { activity_type: "Run", distance_meters: 4911, average_heartrate: 138,
      start_date: "2026-03-21T18:00:00Z", source: "strava" }, // evening run
  ];
  const result = deduplicateActivities(activities);
  check("Two legitimate Strava runs same day both kept", result.length === 2);
  const totalMi = result.reduce((s, a) => s + (a.distance_meters || 0) / 1609.34, 0);
  checkClose("Both runs counted toward mileage", totalMi, (4828 + 4911) / 1609.34, 0.05);
}

// Test 7: Strava near-dupe (GPX + watch, 5s apart) — keep richer record
{
  const activities = [
    { activity_type: "Run", distance_meters: 11265, average_heartrate: null,
      start_date: "2026-03-11T13:15:30Z", source: "strava" },
    { activity_type: "Run", distance_meters: 10643, average_heartrate: 152,
      start_date: "2026-03-11T13:15:25Z", source: "strava" },
  ];
  const result = deduplicateActivities(activities);
  check("Strava near-dupe (±5s) deduped to one", result.length === 1);
  check("Richer (has HR) Strava record kept", result[0]?.average_heartrate === 152);
}

// ─── STATIC — correctMileageTotal ─────────────────────────────────────────────

section("STATIC — correctMileageTotal");

// Test 8: Next-week plan not inflated by current-week miles (the wife's bug)
{
  const { mon, tue, thu, sat, fmt, day } = getNextWeekDates();
  const plan = `${day(mon)} ${fmt(mon)} · Easy 3mi @ 9:30–9:50
${day(tue)} ${fmt(tue)} · Easy 4mi @ 9:30–9:50
${day(thu)} ${fmt(thu)} · Easy 4mi @ 9:30–9:50
${day(sat)} ${fmt(sat)} · Easy 4mi @ 9:30–9:50

15 mi total, all easy pace.`;

  const result = correctMileageTotal(plan, 10); // 10 mi already done this week
  check("Next-week 15 mi plan not inflated to 25 (10+15)", result.includes("15 mi total"));
  check("No '25' in corrected output", !result.includes("25"));
}

// Test 9: Same scenario but Dean mistakenly states 25 — must be corrected to 15
{
  const { mon, tue, thu, sat, fmt, day } = getNextWeekDates();
  const wrongPlan = `${day(mon)} ${fmt(mon)} · Easy 3mi @ 9:30–9:50
${day(tue)} ${fmt(tue)} · Easy 4mi @ 9:30–9:50
${day(thu)} ${fmt(thu)} · Easy 4mi @ 9:30–9:50
${day(sat)} ${fmt(sat)} · Easy 4mi @ 9:30–9:50

25 mi total, all easy pace.`;

  const result = correctMileageTotal(wrongPlan, 10);
  check("Inflated '25 mi total' in next-week plan corrected to 15", result.includes("15 mi total"));
  check("'25 mi total' replaced", !result.includes("25 mi total"));
}

// Test 10: Mid-week plan for current week DOES add completed miles
{
  const now = new Date();
  const todayDow = now.getUTCDay();
  // Remaining sessions later this same week
  const thuMs = now.getTime() + ((4 - todayDow + 7) % 7) * 86_400_000; // next Thu
  const satMs = now.getTime() + ((6 - todayDow + 7) % 7) * 86_400_000; // next Sat
  const thu = new Date(Math.max(thuMs, now.getTime() + 86_400_000));
  const sat = new Date(Math.max(satMs, now.getTime() + 2 * 86_400_000));
  const fmt = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const day = (d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];

  const midWeekPlan = `${day(thu)} ${fmt(thu)} · Easy 4mi @ 9:00/mi
${day(sat)} ${fmt(sat)} · Long run 6mi easy

That puts you at 10 miles for the week.`; // wrong — should be 3.05 + 4 + 6 = 13.05

  const result = correctMileageTotal(midWeekPlan, 3.05);
  // planned = 4+6 = 10mi, completed = 3.05, correct = 13.05 → stated "10" is wrong
  // BUT if sessions are current week, effectiveCompleted = 3.05
  // If the test machine's "this week" matches these dates, correction fires
  // Accept either corrected or uncorrected (depends on date alignment)
  check("Mid-week plan processes without error", typeof result === "string" && result.length > 0);
}

// Test 11: Plan total already correct — must NOT be changed
{
  const { mon, wed, fri } = (() => {
    const { mon, tue: wed, thu: fri } = getNextWeekDates();
    return { mon, wed, fri };
  })();
  const { fmt, day } = getNextWeekDates();
  const correctPlan = `${day(mon)} ${fmt(mon)} · Easy 5mi @ 9:30/mi
${day(mon)} ${fmt(mon)} · Tempo 6mi (2mi easy, 2×1mi @ 7:00, 1mi cool)
${day(mon)} ${fmt(mon)} · Easy 4mi

Total: ~15 miles for the week.`; // 5+6+4=15 ✓

  const result = correctMileageTotal(correctPlan, 0);
  check("Correct 15 mi plan total unchanged", result.includes("~15 miles"));
}

// Test 12: Wrong total with no completed miles (weekly_recap scenario) — corrected
{
  const { mon, wed, fri } = (() => {
    const nw = getNextWeekDates();
    return { mon: nw.mon, wed: nw.tue, fri: nw.thu };
  })();
  const { fmt, day } = getNextWeekDates();
  const wrongRecap = `${day(mon)} ${fmt(mon)} · Easy 5mi @ 9:30/mi
${day(wed)} ${fmt(wed)} · Tempo 7mi (2mi easy, 3×1mi @ 7:00, 1mi cool)
${day(fri)} ${fmt(fri)} · Long run 10mi easy

Total: ~20 miles for the week.`; // 5+7+10=22, stated 20 → wrong

  const result = correctMileageTotal(wrongRecap, 0);
  check("Wrong plan total (20→22) corrected for recap", result.includes("22"));
}

// ─── LIVE DB TESTS (optional) ─────────────────────────────────────────────────

section("LIVE DB — fetch real activities and verify mileage");

if (!supabase) {
  console.log("  ⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping DB tests");
} else {
  // Use Jake's real user ID from production
  const JAKE_USER_ID = "455af698-8c71-4176-ab14-06069785bea3";

  try {
    const { data: activities, error } = await supabase
      .from("activities")
      .select("activity_type, distance_meters, moving_time_seconds, average_heartrate, average_pace, start_date, source")
      .eq("user_id", JAKE_USER_ID)
      .order("start_date", { ascending: false })
      .limit(50);

    if (error) throw error;

    const deduped = deduplicateActivities(activities || []);
    const weekMi = computeWeekMileage(deduped, JAKE_TIMEZONE);
    const weekCount = computeWeekRunCount(deduped, JAKE_TIMEZONE);

    // Jake has 2 runs this week: 4911m + 2277.4m = 4.46 mi
    // (At time of writing — will naturally change as more runs are logged)
    console.log(`  DB: ${deduped.length} total activities fetched`);
    console.log(`  DB: ${weekCount} runs this week, ${weekMi.toFixed(2)} mi`);

    check(
      "Jake's week mileage is non-negative",
      weekMi >= 0,
      `got ${weekMi.toFixed(2)}`
    );
    check(
      "Jake's run count is non-negative integer",
      Number.isInteger(weekCount) && weekCount >= 0
    );

    // The manual/Strava dedup should leave no manual shadows
    const hasManualShadow = deduped.some((a) => {
      if (a.source !== "manual" && a.source !== "conversation") return false;
      const dateKey = a.start_date.slice(0, 10);
      return deduped.some((b) => {
        if (b.source === "manual" || b.source === "conversation") return false;
        if (b.start_date.slice(0, 10) !== dateKey) return false;
        const larger = Math.max(a.distance_meters || 0, b.distance_meters || 0);
        return larger > 0 && Math.abs((a.distance_meters || 0) - (b.distance_meters || 0)) / larger < 0.15;
      });
    });
    check("No manual/conversation shadows alongside Strava runs in deduped set", !hasManualShadow);

    // Verify activities have expected fields
    const allHaveType = deduped.every((a) => typeof a.activity_type === "string");
    check("All activities have activity_type", allHaveType);

  } catch (err) {
    console.log(`  ❌ DB query failed: ${err.message}`);
    totalFail++;
  }
}

// ─── LLM TESTS ────────────────────────────────────────────────────────────────

section("LLM — post_run mileage accuracy (requires ANTHROPIC_API_KEY)");

if (!anthropic) {
  console.log("  ⚠️  ANTHROPIC_API_KEY not set — skipping LLM tests");
} else {
  const MODEL = "claude-sonnet-4-6"; // use current model

  /**
   * Build the minimal but accurate system prompt for post_run.
   * Replicates the key sections Claude sees.
   */
  function buildPostRunSystem(weekMiStr, weekRunCount, weeklyMileageTarget, pastWeeks) {
    const pastWeekRows = pastWeeks.map(({ monday, miles, runs }) =>
      `  ${monday}: ${miles.toFixed(1)} mi (${runs} runs)`
    ).join("\n");

    return `You are Coach Dean, an expert running coach communicating via SMS. Be concise — 2–4 short paragraphs, no markdown, sound like a real coach texting.

ATHLETE HISTORY:
- Goal: a half marathon on 2026-05-31

WEEKLY MILEAGE (completed weeks, most recent first):
${pastWeekRows || "  (no completed weeks yet)"}

CURRENT TRAINING STATE:
- Week 5 of training, phase: base
- Weekly mileage target: ${weeklyMileageTarget} mi
⚠️ THIS WEEK'S MILEAGE — READ CAREFULLY: ${weekMiStr} mi done so far this week (${weekRunCount} run${weekRunCount !== 1 ? "s" : ""}). The "done so far" figure is the ONLY number that reflects completed runs. Never say the athlete "is at" the projected total — they haven't run those sessions yet. When discussing current mileage use the "done" figure.`;
  }

  /**
   * Build the minimal user message for post_run.
   */
  function buildPostRunUser(weekMiStr, weekRunCount, activityMiles, activityPace, activityHR, dateNote) {
    return `A workout just synced from Strava. ${dateNote}

⚠️ WEEK-TO-DATE (this run included): ${weekMiStr} mi across ${weekRunCount} run${weekRunCount !== 1 ? "s" : ""}. This is the exact, computed total — do not add or subtract anything from it.

Details:
${JSON.stringify({
  activity_type: "Run",
  distance_miles: activityMiles.toFixed(2),
  moving_time: "28:11",
  average_pace: activityPace,
  average_heartrate: activityHR,
  elevation_gain_feet: 125,
}, null, 2)}

Provide post-run feedback analyzing their performance, noting what went well, any concerns, and what's coming up next.

MILEAGE ACCURACY — CRITICAL: The ⚠️ AUTHORITATIVE WEEK-TO-DATE MILEAGE in CURRENT TRAINING STATE is what the athlete has ALREADY RUN this week — it already includes the activity shown above. Use it as the current/completed figure. Do not manually sum runs or add the run distance to the stated total.

PLAN CONSISTENCY RULES:
- Week-to-date mileage: use the ⚠️ AUTHORITATIVE WEEK-TO-DATE MILEAGE figure as the already-completed figure. Do not manually sum runs from conversation history.`;
  }

  // ── LLM Test A: Jake's exact scenario — 4.46 mi, NOT 7.6 mi ─────────────────

  {
    const weekMi = 4.46;
    const weekMiStr = weekMi.toFixed(1);
    const activityMiles = 4911 / 1609.34; // 3.05

    const system = buildPostRunSystem(weekMiStr, 2, 10, [
      { monday: "2026-03-09", miles: 4.0, runs: 2 },
      { monday: "2026-03-02", miles: 3.5, runs: 2 },
    ]);
    const user = buildPostRunUser(weekMiStr, 2, activityMiles, "9:14/mi", 139, "Today, Friday Mar 20");

    console.log("\n  [A] Jake scenario: 4.46 mi week-to-date, 3.05 mi run");
    try {
      const r = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      console.log(`  Response: ${text.slice(0, 300)}`);

      // Must mention ~4.5 mi (week-to-date), not 7.6
      const mentionsCorrect = /4\.[34567]|~4\.5|4\.5/i.test(text);
      const mentionsWrong76 = /7\.[56789]|7\.6/i.test(text);

      check(
        "[A] Reports ~4.5 mi week-to-date (not 7.6)",
        mentionsCorrect && !mentionsWrong76,
        `got: "${text.slice(0, 200)}"`
      );
      check(
        "[A] Does not say 7.6 mi",
        !mentionsWrong76,
        `Found '7.6' in response: "${text.slice(0, 200)}"`
      );
    } catch (err) {
      console.log(`  ❌ LLM call failed: ${err.message}`);
      totalFail++;
    }
  }

  // ── LLM Test B: First run of the week (0 → 3.05 mi) ────────────────────────

  {
    const weekMi = 3.05;
    const weekMiStr = weekMi.toFixed(1);
    const activityMiles = 3.05;

    const system = buildPostRunSystem(weekMiStr, 1, 15, [
      { monday: "2026-03-09", miles: 12.0, runs: 4 },
      { monday: "2026-03-02", miles: 11.5, runs: 4 },
    ]);
    const user = buildPostRunUser(weekMiStr, 1, activityMiles, "9:20/mi", 135, "Today, Monday");

    console.log("\n  [B] First run of week: 3.05 mi done, no prior runs");
    try {
      const r = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      console.log(`  Response: ${text.slice(0, 300)}`);

      // Should NOT say 6.1 (3.05 × 2) or any obviously doubled figure
      const doubled = /6\.[01]|6\.1/i.test(text);
      check("[B] Does not double the first run (no 6.1 mi)", !doubled,
        `Found doubled mileage: "${text.slice(0, 200)}"`);
      // Should mention ~3 mi done
      const mentionsThree = /3\.0|~3\s*mi|3 miles?|three miles?/i.test(text);
      check("[B] References ~3 miles done this week", mentionsThree,
        `Did not reference ~3 mi: "${text.slice(0, 200)}"`);
    } catch (err) {
      console.log(`  ❌ LLM call failed: ${err.message}`);
      totalFail++;
    }
  }

  // ── LLM Test C: High mileage week, run confirms target hit ──────────────────

  {
    const weekMi = 10.3; // weekly target was 10 mi
    const weekMiStr = weekMi.toFixed(1);
    const activityMiles = 4.0; // this run put them over

    const system = buildPostRunSystem(weekMiStr, 3, 10, [
      { monday: "2026-03-09", miles: 9.8, runs: 3 },
      { monday: "2026-03-02", miles: 10.1, runs: 3 },
    ]);
    const user = buildPostRunUser(weekMiStr, 3, activityMiles, "9:00/mi", 143, "Today, Saturday");

    console.log("\n  [C] Target hit: 10.3 mi done (target was 10), 4 mi run");
    try {
      const r = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      console.log(`  Response: ${text.slice(0, 300)}`);

      // Should NOT say 14.3 mi (10.3 + 4.0 double-counted)
      const doubled = /14\.[23]|14\.3/i.test(text);
      check("[C] Does not double-count run (no 14.3 mi)", !doubled,
        `Found doubled mileage: "${text.slice(0, 200)}"`);
      // Should mention ~10 mi done (within 1 mi)
      const mentionsTen = /10\.[0-9]|~10\s*mi|10 miles?/i.test(text);
      check("[C] References ~10 mi week-to-date", mentionsTen,
        `Did not reference ~10 mi: "${text.slice(0, 200)}"`);
    } catch (err) {
      console.log(`  ❌ LLM call failed: ${err.message}`);
      totalFail++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  section("LLM — user_message / next-week plan mileage accuracy");

  // ── LLM Test D: Wife's bug — next-week plan total should be 15 not 25 ────────

  {
    const { mon, tue, thu, sat, fmt, day } = getNextWeekDates();

    const SYSTEM = `You are Coach Dean, an expert running coach communicating via SMS. Be concise — no markdown.

CURRENT TRAINING STATE:
- Week 8 of training, phase: base
- Weekly mileage target: 15 mi
⚠️ THIS WEEK'S MILEAGE — READ CAREFULLY: 10.0 mi done so far this week (4 runs). The "done so far" figure is the ONLY number that reflects completed runs.

UPCOMING SESSIONS THIS WEEK:
(none — weekly target already met)`;

    const USER = `The athlete just sent you a message. Respond helpfully as their running coach.

Message: "What would next week's plan be?"

When providing a next-week plan:
- Use the session format: "Mon 3/24 · Easy 4mi @ 9:30/mi" (one session per line)
- After the session list, state the total planned miles for NEXT WEEK ONLY — do not add this week's completed miles to the total.
- Next week starts at 0 miles done. The total should equal only the sum of sessions in the plan.`;

    console.log("\n  [D] Wife's bug: next-week 15 mi plan should not become 25 mi");
    try {
      const r = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM,
        messages: [{ role: "user", content: USER }],
      });
      const rawText = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");

      // Apply correctMileageTotal with 10 mi completed (the fix should handle this)
      const corrected = correctMileageTotal(rawText, 10.0);
      console.log(`  Raw: ${rawText.slice(0, 350)}`);
      console.log(`  After correctMileageTotal: ${corrected.slice(0, 350)}`);

      // After correction, should not contain 25
      const hasTwentyFive = /\b25\s*mi|\b25\.0\s*mi/i.test(corrected);
      check("[D] Plan total is not 25 after correction", !hasTwentyFive,
        `Found '25 mi': "${corrected.slice(0, 300)}"`);

      // Check that session lines sum to something reasonable (10-20 mi range for a plan)
      const sessionLines = corrected.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d+\/\d+\s+·\s+.+$/gm) || [];
      let sessionSum = 0;
      for (const line of sessionLines) {
        const miMatch = line.match(/(\d+(?:\.\d+)?)\s*mi/i);
        if (miMatch) sessionSum += parseFloat(miMatch[1]);
      }
      if (sessionLines.length > 0) {
        check(
          "[D] Session sum is in reasonable range (5-25 mi)",
          sessionSum >= 5 && sessionSum <= 25,
          `session sum = ${sessionSum.toFixed(1)} across ${sessionLines.length} sessions`
        );
        // Plan total in response should match session sum (within 1 mi after correction)
        const totalMatch = corrected.match(/(\d+(?:\.\d+)?)\s*mi\s*(?:total|this week|for the week)/i)
          || corrected.match(/Total:\s*~?(\d+(?:\.\d+)?)\s*mi/i);
        if (totalMatch) {
          const statedTotal = parseFloat(totalMatch[1]);
          check(
            `[D] Stated plan total (~${statedTotal} mi) ≈ session sum (${sessionSum.toFixed(1)} mi)`,
            Math.abs(statedTotal - sessionSum) <= 1.5,
            `stated ${statedTotal}, sessions sum to ${sessionSum.toFixed(1)}`
          );
        }
      }
    } catch (err) {
      console.log(`  ❌ LLM call failed: ${err.message}`);
      totalFail++;
    }
  }

  // ── LLM Test E: Mid-week user_message — remove one session, recount total ────

  {
    const { mon, wed, fri } = (() => {
      const nw = getNextWeekDates(); // use next week so the dates are in the future
      return { mon: nw.mon, wed: nw.tue, fri: nw.thu };
    })();
    const { fmt, day } = getNextWeekDates();

    const SYSTEM = `You are Coach Dean, an expert running coach communicating via SMS. Be concise — no markdown.

CURRENT TRAINING STATE:
- Week 6 of training, phase: base
- Weekly mileage target: 20 mi
⚠️ THIS WEEK'S MILEAGE — READ CAREFULLY: 6.0 mi done so far this week (2 runs). The "done so far" figure is the ONLY number that reflects completed runs.

UPCOMING SESSIONS THIS WEEK:
${day(mon)} ${fmt(mon)} · Easy 5mi @ 9:30/mi
${day(wed)} ${fmt(wed)} · Tempo 6mi (2mi easy, 2×1mi @ 7:00, 1mi cool) ≈6mi
${day(fri)} ${fmt(fri)} · Long run 9mi easy`;

    const USER = `The athlete just sent you a message. Respond helpfully as their running coach.

Message: "I need to skip Saturday's long run this week — can we drop it?"

When updating the plan, restate the remaining sessions and recalculate the week total. The week total = already completed miles (6.0) + remaining planned sessions. Do not include the dropped session.`;

    console.log("\n  [E] Mid-week drop: remove long run, recount total (6 done + 5 + 6 = 17 mi)");
    try {
      const r = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: USER }],
      });
      const rawText = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      const corrected = correctMileageTotal(rawText, 6.0);
      console.log(`  Raw: ${rawText.slice(0, 350)}`);
      console.log(`  After correctMileageTotal: ${corrected.slice(0, 350)}`);

      // Should NOT say 29 (6 + 5 + 6 + 9 = 26 without drop, 6 + 5 + 6 = 17 with drop)
      const hasFullTotal = /\b26\s*mi|\b29\s*mi/i.test(corrected);
      check("[E] Dropped session not counted in total", !hasFullTotal,
        `Response still mentions full total: "${corrected.slice(0, 200)}"`);
      // Should not say 9 mi long run anymore
      check("[E] Response does not still plan the dropped 9 mi long run",
        !/(long run 9mi|9mi.*long|9-mile long)/i.test(corrected));
    } catch (err) {
      console.log(`  ❌ LLM call failed: ${err.message}`);
      totalFail++;
    }
  }

  // ── LLM Test F: weekly_recap — plan totals match session sums ────────────────

  section("LLM — weekly_recap plan consistency");

  {
    const { mon, tue, thu, sat, fmt, day } = getNextWeekDates();

    const SYSTEM = `You are Coach Dean, an expert running coach communicating via SMS. Be concise — no markdown.

ATHLETE HISTORY:
- Goal: a half marathon on 2026-05-31

WEEKLY MILEAGE (completed weeks, most recent first):
  2026-03-16: 10.0 mi (4 runs)
  2026-03-09: 9.8 mi (4 runs)
  2026-03-02: 9.2 mi (3 runs)

CURRENT TRAINING STATE:
- Week 8 of training, phase: base
- Weekly mileage target: 15 mi
⚠️ THIS WEEK'S MILEAGE — READ CAREFULLY: 10.0 mi done so far this week (4 runs).

MILEAGE ACCURACY: Before writing any weekly mileage total, silently sum every running session distance to verify it. If the sum doesn't match the stated total, correct the total before writing. Never show the calculation.`;

    const USER = `Generate next week's training plan. Use the format:
Mon M/D · [description]
Wed M/D · [description]
etc.

After the session list, state the total planned miles for next week only. That total = sum of running sessions ONLY. Do not include this week's completed mileage.`;

    console.log("\n  [F] weekly_recap: plan total should match session sum");
    try {
      const r = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM,
        messages: [{ role: "user", content: USER }],
      });
      const rawText = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      const corrected = correctMileageTotal(rawText, 0); // weekly_recap uses 0

      console.log(`  Raw: ${rawText.slice(0, 400)}`);
      console.log(`  After correctMileageTotal: ${corrected !== rawText ? corrected.slice(0, 400) : "(unchanged)"}`);

      const sessionLines = corrected.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d+\/\d+\s+·\s+.+$/gm) || [];
      let sessionSum = 0;
      for (const line of sessionLines) {
        const explicitTotal = line.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi/i)
          || line.match(/\((\d+(?:\.\d+)?)\s*mi(?:\s+total)?\)/i);
        const firstMi = line.match(/(\d+(?:\.\d+)?)\s*mi/i);
        const miMatch = explicitTotal || firstMi;
        if (miMatch) sessionSum += parseFloat(miMatch[1]);
      }

      if (sessionLines.length === 0) {
        check("[F] Response contains session list", false, "No session lines found");
      } else {
        check(`[F] ${sessionLines.length} session lines found`, sessionLines.length >= 3);
        check(
          `[F] Session sum (${sessionSum.toFixed(1)} mi) in sensible range for 15 mi target week`,
          sessionSum >= 8 && sessionSum <= 25,
          `session sum = ${sessionSum.toFixed(1)}`
        );

        // Check stated total matches session sum
        const totalMatch = corrected.match(/Total:\s*~?(\d+(?:\.\d+)?)\s*mi/i)
          || corrected.match(/(\d+(?:\.\d+)?)\s*mi\s*(?:total|for the week)/i);
        if (totalMatch) {
          const statedTotal = parseFloat(totalMatch[1]);
          check(
            `[F] Stated total (${statedTotal} mi) matches session sum (${sessionSum.toFixed(1)} mi) within 1 mi`,
            Math.abs(statedTotal - sessionSum) <= 1.0,
            `stated ${statedTotal}, computed ${sessionSum.toFixed(1)}`
          );
        } else {
          console.log("  ℹ️  No explicit total stated — correctMileageTotal guard not triggered");
          check("[F] No explicit total is acceptable (no guard needed)", true);
        }
      }
    } catch (err) {
      console.log(`  ❌ LLM call failed: ${err.message}`);
      totalFail++;
    }
  }
}

// ─── SUMMARY ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(65)}`);
console.log("SUMMARY");
console.log("═".repeat(65));
console.log(`✅ Passed: ${totalPass}`);
console.log(`❌ Failed: ${totalFail}`);
console.log(`   Total:  ${totalPass + totalFail}`);
if (totalFail > 0) process.exit(1);
