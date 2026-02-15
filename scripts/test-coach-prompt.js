/**
 * Simulates what the coach/respond route builds as a system prompt,
 * using real Strava data. Tests the buildActivitySummary logic.
 */

const ACCESS_TOKEN = process.argv[2] || "9bb1be55cfaf9a0b35856e8cbafb538595b4a075";

async function main() {
  // Fetch same data the coach would have
  const sixMonthsAgo = Math.floor((Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) / 1000);

  const [statsRes, activitiesRes] = await Promise.all([
    fetch("https://www.strava.com/api/v3/athletes/2162636/stats", {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    }),
    fetch(`https://www.strava.com/api/v3/athlete/activities?after=${sixMonthsAgo}&per_page=200`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    }),
  ]);

  const stats = await statsRes.json();
  const allActivities = await activitiesRes.json();
  const runs = allActivities.filter((a) => ["Run", "TrailRun", "VirtualRun"].includes(a.type));

  // Simulate the activity summary (same logic as coach/respond)
  const activities = runs.slice(0, 50).map((a) => ({
    activity_type: a.type,
    distance_meters: a.distance,
    moving_time_seconds: a.moving_time,
    average_heartrate: a.average_heartrate || null,
    elevation_gain: a.total_elevation_gain || null,
    average_pace: formatPaceFromRaw(a.distance, a.moving_time),
    start_date: a.start_date,
  }));

  const summary = buildActivitySummary(activities);

  console.log("=== SYSTEM PROMPT ACTIVITY SECTION ===\n");
  console.log(summary);

  console.log("\n=== ATHLETE HISTORY LINE ===");
  console.log(`- All-time: ${stats.all_run_totals.count} runs, ${Math.round(stats.all_run_totals.distance / 1609.34)} miles`);
  console.log(`- Fitness level: advanced`);

  // Now test a coaching response with this context
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You are Coach Dean, an expert running coach communicating via text message. You specialize in trail running, ultra running, and periodized training. You are coaching Jake for a 30K trail race on March 29, 2026.

TRAINING PHILOSOPHY:
- Follow periodized training: base → build → peak → taper
- 80/20 rule: ~80% easy effort, ~20% quality workouts
- Progressive overload: increase weekly mileage by no more than 10%/week
- For trail races: include vert-specific training, technical downhill practice, power hiking

ATHLETE HISTORY:
- All-time: ${stats.all_run_totals.count} runs, ${Math.round(stats.all_run_totals.distance / 1609.34)} miles
- Fitness level: advanced
- Training days: tuesday, thursday, saturday, sunday
- Constraints: None

${summary}

CURRENT TRAINING STATE:
- Week 1 of training, phase: base
- Weekly mileage target: 25 mi
- Mileage so far this week: 11.3 mi
- Current paces: Easy 8:45-9:30/mi, Tempo 7:15-7:30/mi, Interval 6:30-6:45/mi
- Last activity: {"type":"Run","distance_miles":7.0,"pace":"7:51/mi","hr":null}

COMMUNICATION STYLE:
- Text message tone: concise, encouraging, knowledgeable
- Use numbers and paces specifically — don't be vague
- Keep messages to 2-4 SMS segments (~320-640 chars)
- Use occasional emoji sparingly

RECENT CONVERSATION:
Coach: Strava connected — nice! Last question: which days of the week work best for running?
Athlete: Tuesdays, Thursdays, Saturdays, and Sundays`;

  console.log("\n=== TESTING SMS-LENGTH COACHING RESPONSE ===\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: "The athlete just sent you a message (see the most recent message in RECENT CONVERSATION above). Respond helpfully as their running coach. Use their activity history and training data to give specific, personalized advice.",
    }],
  });

  const msg = response.content[0].type === "text" ? response.content[0].text : "";
  console.log(msg);
  console.log(`\n--- ${msg.length} chars (${Math.ceil(msg.length / 160)} SMS segments) ---`);
}

function formatPaceFromRaw(distanceMeters, movingTimeSeconds) {
  const miles = distanceMeters / 1609.34;
  const paceMin = miles > 0 ? (movingTimeSeconds / 60) / miles : 0;
  const totalSec = Math.round(paceMin * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}/mi`;
}

function buildActivitySummary(activities) {
  if (activities.length === 0) return "No activity history available.";

  const weeks = {};
  for (const a of activities) {
    const d = new Date(a.start_date);
    const yr = d.getFullYear();
    const startOfYear = new Date(yr, 0, 1);
    const dayOfYear = Math.floor((d.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const weekNum = Math.ceil(dayOfYear / 7);
    const key = `${yr}-W${String(weekNum).padStart(2, "0")}`;

    const miles = a.distance_meters / 1609.34;
    const paceMinPerMile = miles > 0 ? a.moving_time_seconds / 60 / miles : 999;

    if (!weeks[key]) weeks[key] = { miles: 0, runs: 0, vert: 0, fastest: 999 };
    weeks[key].miles += miles;
    weeks[key].runs += 1;
    weeks[key].vert += a.elevation_gain || 0;
    if (paceMinPerMile < weeks[key].fastest) weeks[key].fastest = paceMinPerMile;
  }

  const sortedWeeks = Object.entries(weeks).sort(([a], [b]) => b.localeCompare(a)).slice(0, 8);

  let summary = "WEEKLY MILEAGE (recent):\n";
  for (const [week, data] of sortedWeeks) {
    const totalSec = Math.round(data.fastest * 60);
    const fMin = Math.floor(totalSec / 60);
    const fSec = totalSec % 60;
    summary += `  ${week}: ${data.miles.toFixed(1)} mi (${data.runs} runs, ${Math.round(data.vert)}ft vert, fastest ${fMin}:${String(fSec).padStart(2, "0")}/mi)\n`;
  }

  // Pace distribution
  const roadRuns = activities.filter((a) => {
    const miles = a.distance_meters / 1609.34;
    const pace = miles > 0 ? a.moving_time_seconds / 60 / miles : 999;
    return pace < 12 && miles > 0.5;
  });

  if (roadRuns.length > 0) {
    const paces = roadRuns.map((a) => a.moving_time_seconds / 60 / (a.distance_meters / 1609.34)).sort((a, b) => a - b);
    const formatPace = (p) => { const t = Math.round(p * 60); return `${Math.floor(t/60)}:${String(t%60).padStart(2,"0")}`; };
    summary += `\nPACE ANALYSIS (${roadRuns.length} road-like runs):\n`;
    summary += `  Fastest efforts: ${paces.slice(0,3).map(formatPace).join(", ")}/mi\n`;
    summary += `  Median pace: ${formatPace(paces[Math.floor(paces.length/2)])}/mi\n`;
    summary += `  Slowest easy: ${formatPace(paces[paces.length-1])}/mi\n`;
  }

  const trailRuns = activities.filter((a) => a.activity_type === "TrailRun" || (a.elevation_gain || 0) > 150);
  if (trailRuns.length > 0) {
    summary += `\nTRAIL RUNS: ${trailRuns.length} of ${activities.length} recent runs are trail/high-vert\n`;
  }

  const withHR = activities.filter((a) => a.average_heartrate);
  if (withHR.length > 0) {
    const avgHR = withHR.reduce((s, a) => s + a.average_heartrate, 0) / withHR.length;
    const maxHR = Math.max(...withHR.map((a) => a.average_heartrate));
    summary += `\nHEART RATE: avg ${Math.round(avgHR)} bpm across runs, highest avg ${maxHR} bpm\n`;
  }

  return summary;
}

main().catch(console.error);
