/**
 * Test script: Fetches real Strava data and generates the same activity summary
 * that the coach/respond route would produce. Validates the data pipeline.
 */

const ACCESS_TOKEN = process.argv[2];
if (!ACCESS_TOKEN) {
  console.error("Usage: node scripts/test-strava-summary.js <strava_access_token>");
  process.exit(1);
}

async function main() {
  // 1. Fetch athlete stats
  const statsRes = await fetch("https://www.strava.com/api/v3/athletes/2162636/stats", {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const stats = await statsRes.json();

  console.log("=== ATHLETE STATS ===");
  console.log(`All-time: ${stats.all_run_totals.count} runs, ${Math.round(stats.all_run_totals.distance / 1609.34)} mi`);
  console.log(`YTD: ${stats.ytd_run_totals.count} runs, ${Math.round(stats.ytd_run_totals.distance / 1609.34)} mi`);
  console.log(`Recent 4 weeks: ${stats.recent_run_totals.count} runs, ${Math.round(stats.recent_run_totals.distance / 1609.34)} mi`);

  // 2. Assess fitness level (same logic as onboarding handler)
  const totalRuns = stats.all_run_totals.count;
  const totalMiles = stats.all_run_totals.distance / 1609.34;
  const recentWeeklyMiles = stats.recent_run_totals.distance / 1609.34 / 4;

  let fitnessLevel = "beginner";
  if ((totalRuns >= 200 || totalMiles >= 2000) && recentWeeklyMiles >= 20)
    fitnessLevel = "advanced";
  else if (totalRuns >= 50 || totalMiles >= 500 || recentWeeklyMiles >= 12)
    fitnessLevel = "intermediate";

  console.log(`\nAssessed fitness: ${fitnessLevel} (${totalRuns} runs, ${Math.round(totalMiles)} mi, recent ${recentWeeklyMiles.toFixed(1)} mi/wk)`);

  // Mileage target
  const weeklyTarget = Math.round(recentWeeklyMiles / 5) * 5 || 10;
  console.log(`Weekly mileage target: ${weeklyTarget} mi`);

  // 3. Fetch last 6 months of activities (like callback does)
  const sixMonthsAgo = Math.floor((Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) / 1000);
  let allActivities = [];
  let page = 1;

  while (page <= 5) {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${sixMonthsAgo}&page=${page}&per_page=200`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    const activities = await res.json();
    if (!Array.isArray(activities) || activities.length === 0) break;
    allActivities.push(...activities);
    if (activities.length < 200) break;
    page++;
  }

  const runs = allActivities.filter((a) =>
    ["Run", "TrailRun", "VirtualRun"].includes(a.type)
  );

  console.log(`\n=== ACTIVITY SYNC ===`);
  console.log(`Total activities (6mo): ${allActivities.length}`);
  console.log(`Run activities: ${runs.length}`);
  console.log(`Activity types: ${[...new Set(allActivities.map((a) => a.type))].join(", ")}`);

  // 4. Build activity summary (same logic as coach/respond)
  const weeks = {};
  for (const a of runs) {
    const d = new Date(a.start_date);
    const yr = d.getFullYear();
    const startOfYear = new Date(yr, 0, 1);
    const dayOfYear = Math.floor((d.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const weekNum = Math.ceil(dayOfYear / 7);
    const key = `${yr}-W${String(weekNum).padStart(2, "0")}`;

    const miles = a.distance / 1609.34;
    const paceMinPerMile = miles > 0 ? (a.moving_time / 60) / miles : 999;

    if (!weeks[key]) weeks[key] = { miles: 0, runs: 0, vert: 0, fastest: 999 };
    weeks[key].miles += miles;
    weeks[key].runs += 1;
    weeks[key].vert += a.total_elevation_gain || 0;
    if (paceMinPerMile < weeks[key].fastest) weeks[key].fastest = paceMinPerMile;
  }

  const sortedWeeks = Object.entries(weeks)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 12);

  console.log("\n=== WEEKLY MILEAGE (as coach would see) ===");
  for (const [week, data] of sortedWeeks) {
    const fastest = data.fastest;
    const fMin = Math.floor(fastest);
    const fSec = Math.round((fastest - fMin) * 60);
    console.log(
      `  ${week}: ${data.miles.toFixed(1)} mi (${data.runs} runs, ${Math.round(data.vert)}ft vert, fastest ${fMin}:${String(fSec).padStart(2, "0")}/mi)`
    );
  }

  // Pace analysis — road-like runs only
  const roadRuns = runs.filter((a) => {
    const miles = a.distance / 1609.34;
    const pace = miles > 0 ? (a.moving_time / 60) / miles : 999;
    return pace < 12 && miles > 0.5;
  });

  if (roadRuns.length > 0) {
    const paces = roadRuns
      .map((a) => (a.moving_time / 60) / (a.distance / 1609.34))
      .sort((a, b) => a - b);

    const formatPace = (p) => {
      const m = Math.floor(p);
      const s = Math.round((p - m) * 60);
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    console.log(`\n=== PACE ANALYSIS (${roadRuns.length} road-like runs) ===`);
    console.log(`  Fastest 3: ${paces.slice(0, 3).map(formatPace).join(", ")}/mi`);
    console.log(`  Median: ${formatPace(paces[Math.floor(paces.length / 2)])}/mi`);
    console.log(`  Slowest easy: ${formatPace(paces[paces.length - 1])}/mi`);
  }

  // Trail runs
  const trailRuns = runs.filter(
    (a) => a.type === "TrailRun" || (a.total_elevation_gain || 0) > 150
  );
  console.log(`\n=== TRAIL PROFILE ===`);
  console.log(`  Trail/high-vert runs: ${trailRuns.length} of ${runs.length}`);

  // HR
  const withHR = runs.filter((a) => a.average_heartrate);
  if (withHR.length > 0) {
    const avgHR = withHR.reduce((s, a) => s + a.average_heartrate, 0) / withHR.length;
    const maxHR = Math.max(...withHR.map((a) => a.average_heartrate));
    console.log(`\n=== HEART RATE ===`);
    console.log(`  Avg HR: ${Math.round(avgHR)} bpm`);
    console.log(`  Highest avg HR: ${maxHR} bpm`);
  }

  // User's verification points
  console.log("\n=== VERIFICATION ===");
  // Jan 26 - Feb 1
  let total = 0;
  for (const a of runs) {
    const d = new Date(a.start_date);
    if (d >= new Date("2026-01-26") && d <= new Date("2026-02-02")) {
      total += a.distance / 1609.34;
    }
  }
  console.log(`  Jan 26 - Feb 1: ${total.toFixed(1)} mi (user reported: 48 mi)`);

  // Feb 2-8
  total = 0;
  for (const a of runs) {
    const d = new Date(a.start_date);
    if (d >= new Date("2026-02-02") && d <= new Date("2026-02-09")) {
      total += a.distance / 1609.34;
    }
  }
  console.log(`  Feb 2 - Feb 8: ${total.toFixed(1)} mi (user reported: 27.6 mi)`);
}

main().catch(console.error);
