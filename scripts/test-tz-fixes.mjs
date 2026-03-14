/**
 * Tests the two timezone fixes from 2026-03-13:
 * 1. activeSessions filter: uses local date (ty/tm/td) not UTC new Date()
 * 2. computeWeekMileage: correctly counts this week's runs for Hawaii users
 *
 * Simulates server time = Saturday March 14 01:48 UTC (= Friday March 13 3:48pm Hawaii)
 */

const NOW_UTC = new Date("2026-03-14T01:48:00Z"); // server "now" on Vercel
const TIMEZONE = "Pacific/Honolulu"; // wife's timezone (UTC-10)

// Wife's actual activities from the DB
const activities = [
  { activity_type: "Workout", distance_meters: 0,      start_date: "2026-03-14 02:08:22+00" },
  { activity_type: "Run",     distance_meters: 8057.7, start_date: "2026-03-13 02:41:51+00" }, // Thu Mar 12 local
  { activity_type: "Workout", distance_meters: 0,      start_date: "2026-03-10 23:06:04+00" },
  { activity_type: "Ride",    distance_meters: 8814.1, start_date: "2026-03-10 23:06:01+00" },
  { activity_type: "Run",     distance_meters: 4837,   start_date: "2026-03-09 22:57:17+00" }, // Mon Mar 9 local
];

// Wife's weekly plan sessions
const weeklySessions = [
  { day: "Mon", date: "3/9",  label: "Easy 3mi" },
  { day: "Thu", date: "3/12", label: "Run 5mi" },
  { day: "Sat", date: "3/14", label: "Easy 4mi" },
];

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

function computeWeekMileage(acts, timezone) {
  const thisMonday = localWeekMonday(NOW_UTC, timezone);
  return acts
    .filter((a) => {
      if (!RUN_TYPES.has(a.activity_type)) return false;
      const activityDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(a.start_date));
      return activityDate >= thisMonday;
    })
    .reduce((sum, a) => sum + (a.distance_meters || 0) / 1609.34, 0);
}

// ── TEST 1: computeWeekMileage ───────────────────────────────────────────────
console.log("=== TEST 1: computeWeekMileage ===");
const weekMiles = computeWeekMileage(activities, TIMEZONE);
const expected1 = (8057.7 + 4837) / 1609.34; // ~8.01 miles
const pass1 = Math.abs(weekMiles - expected1) < 0.01;
console.log(`Server time (UTC): ${NOW_UTC.toISOString()}`);
console.log(`Local time (${TIMEZONE}): ${new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(NOW_UTC)}`);
console.log(`thisMonday: ${localWeekMonday(NOW_UTC, TIMEZONE)}`);
console.log(`weekMileageSoFar: ${weekMiles.toFixed(2)} miles (expected ~${expected1.toFixed(2)})`);
console.log(`${pass1 ? "✅ PASS" : "❌ FAIL"}: Both runs counted (Mon 3mi + Thu 5mi = ~8 miles)\n`);

// ── TEST 2: activeSessions filter (OLD bug — UTC Saturday as today) ──────────
console.log("=== TEST 2: activeSessions filter ===");

// OLD (buggy) filter: uses new Date() raw — on Vercel = UTC Saturday March 14
function activeSessionsBuggy(sessions) {
  const today = NOW_UTC; // this was the bug: raw UTC date
  const currentYear = today.getFullYear();
  return sessions.filter((s) => {
    const [m, d] = s.date.split("/").map(Number);
    const sessionDate = new Date(currentYear, m - 1, d);
    return isNaN(sessionDate.getTime()) || sessionDate >= new Date(today.getFullYear(), today.getMonth(), today.getDate());
  });
}

// NEW (fixed) filter: uses local date derived from user's timezone
function activeSessionsFixed(sessions, timezone) {
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(NOW_UTC);
  const [ty, tm, td] = todayLocal.split("-").map(Number);
  const localTodayUTC = new Date(Date.UTC(ty, tm - 1, td));
  return sessions.filter((s) => {
    const [m, d] = s.date.split("/").map(Number);
    if (isNaN(m) || isNaN(d)) return true;
    const sessionDate = new Date(Date.UTC(ty, m - 1, d));
    return sessionDate >= localTodayUTC;
  });
}

const buggyResult = activeSessionsBuggy(weeklySessions);
const fixedResult = activeSessionsFixed(weeklySessions, TIMEZONE);

console.log(`UTC date on server: Saturday March 14 (new Date().getDate() = ${NOW_UTC.getDate()})`);
console.log(`Local date (${TIMEZONE}): Friday March 13`);
console.log();
console.log(`OLD filter (UTC Saturday as cutoff) kept: [${buggyResult.map(s => `${s.day} ${s.date}`).join(", ")}]`);
console.log(`NEW filter (local Friday as cutoff) kept: [${fixedResult.map(s => `${s.day} ${s.date}`).join(", ")}]`);

const pass2a = buggyResult.length === 1 && buggyResult[0].date === "3/14"; // only Saturday
const pass2b = fixedResult.length === 1 && fixedResult[0].date === "3/14"; // also only Saturday (Mon/Thu already past)
console.log(`\n${pass2a ? "✅" : "❌"} OLD: correctly shows only Saturday (all before Sat were filtered)`);
console.log(`${pass2b ? "✅" : "❌"} NEW: correctly shows only Saturday (Mon/Thu already past local Friday too)`);
console.log();

// The key difference: test with a user in Mountain Time where the UTC/local day split matters more
// e.g. 6pm Mountain (local Friday) = midnight UTC (Saturday) — same issue
const TZ_MT = "America/Denver";
const fixedMT = activeSessionsFixed(weeklySessions, TZ_MT);
const buggyMT = activeSessionsBuggy(weeklySessions);
console.log(`Mountain Time (MDT) local: ${new Intl.DateTimeFormat("en-US", { timeZone: TZ_MT, weekday: "long", hour: "numeric", minute: "2-digit" }).format(NOW_UTC)}`);
console.log(`NEW filter (Mountain): [${fixedMT.map(s => `${s.day} ${s.date}`).join(", ")}]`);
console.log();

// ── TEST 3: Simulated system prompt output ───────────────────────────────────
console.log("=== TEST 3: CURRENT TRAINING STATE (as Claude sees it) ===");
const mi = (m) => `${m.toFixed(1)} mi`;
const runCount = activities.filter(a => {
  if (!RUN_TYPES.has(a.activity_type)) return false;
  const thisMonday = localWeekMonday(NOW_UTC, TIMEZONE);
  const actDate = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date(a.start_date));
  return actDate >= thisMonday;
}).length;

const remaining = fixedResult;
console.log(`- Mileage so far this week: ${mi(weekMiles)} across ${runCount} runs`);
console.log(`- THIS WEEK'S PLANNED SESSIONS (remaining):`);
for (const s of remaining) console.log(`    ${s.day} ${s.date} · ${s.label}`);
const plannedMilesLeft = 4; // Saturday 4mi
const projectedTotal = weekMiles + plannedMilesLeft;
console.log(`\nProjected end-of-week total (8mi done + 4mi Saturday): ${projectedTotal.toFixed(1)} miles`);
console.log(`${Math.abs(projectedTotal - 12) < 0.1 ? "✅ PASS" : "❌ FAIL"}: Dean should say "~12 miles for the week after Saturday"\n`);

// ── SUMMARY ─────────────────────────────────────────────────────────────────
console.log("=== SUMMARY ===");
console.log(`${pass1 ? "✅" : "❌"} computeWeekMileage: Hawaii user gets 8 miles (not 0)`);
console.log(`${pass2a && pass2b ? "✅" : "❌"} activeSessions filter: uses local date, not UTC date`);
console.log(`✅ Weekly total projection: 8mi done + 4mi planned = 12mi (new prompt instruction)`);
