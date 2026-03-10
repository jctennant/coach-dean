/**
 * Onboarding flow test script.
 * Run with: ANTHROPIC_API_KEY=... node scripts/test-onboarding.mjs
 *
 * Tests two things:
 * 1. Goal classifier — runs real Claude calls against a set of representative
 *    opening messages and shows what goal is detected + what acknowledgment
 *    and step routing would result.
 * 2. Step routing — pure logic tests for findNextStep / isStepSatisfied
 *    across the three main personas.
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Inlined classifier prompt (mirrors onboarding/handle/route.ts)
// ---------------------------------------------------------------------------

async function extractAdditionalFields(message) {
  const today = new Date().toISOString().split("T")[0];
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `Extract any running/training information present in this message. Be generous with inference — if something is clearly implied, extract it.

Output format (omit fields that are not present):
{"race_date": "YYYY-MM-DD" | null, "experience_years": number | null, "weekly_miles": number | null, "easy_pace": "M:SS" | null, "name": "FirstName" | null}

Rules:
- name: Extract if the athlete introduces themselves.
- experience_years: infer from any experience signal. "new runner" or "just started" → 0. "a few months" → 0.25. "a year" → 1. "5+ years" → 5.
- weekly_miles: total weekly running mileage. Convert km × 0.621.
- easy_pace: ONLY a stated comfortable, easy, or conversational running pace.
- race_date: if a specific target race date is mentioned. Today is ${today}.
- Return {} if nothing is present.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try { return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}"); }
  catch { return {}; }
}

async function classifyGoal(message) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 128,
    system: `Classify whether the user's message contains a clear fitness or endurance goal. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "no_event": true|false, "goal": "5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"100k"|"sprint_tri"|"olympic_tri"|"70.3"|"ironman"|"cycling"|"general_fitness"|"injury_recovery"|null}

Rules:
- complete: true only if a clear training goal is identifiable
- no_event: true if the athlete explicitly says they have no race or event planned right now ("nothing on the calendar", "no race yet", "not signed up for anything", "no events planned") — regardless of whether complete is true or false
- Pure greetings with no goal context → complete: false, no_event: false, goal: null
- "half marathon" or "half" → "half_marathon"
- "full marathon" or "marathon" → "marathon"
- "ultra" without distance → "50k"
- "triathlon" or "tri" without a distance → "olympic_tri"
- "sprint tri" or "sprint triathlon" → "sprint_tri"
- "70.3", "half ironman", "half-ironman" → "70.3"
- "ironman", "full ironman", "140.6" → "ironman"
- "cycling", "gravel race", "gran fondo", "bike race" → "cycling"
- "just getting in shape", "get fit", "lose weight", "general" → "general_fitness"
- "recovering from injury", "coming back from injury", "injured", "IT band", "stress fracture", "shin splints", "return to running", "rebuilding after injury" → "injury_recovery"
- When complete is false, goal must be null`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "{}";
  try { return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}"); }
  catch { return {}; }
}

// ---------------------------------------------------------------------------
// Inlined acknowledgment builder (mirrors handleGoal in route.ts)
// ---------------------------------------------------------------------------

function buildAcknowledgment(goal, name, experienceYears, raceAck) {
  if (raceAck) {
    return `Love it${name ? `, ${name}` : ""} — ${raceAck} I'll build your week-by-week plan, track your training via Strava, and check in after your key sessions.`;
  }
  if (goal === "injury_recovery") {
    return `Got it${name ? `, ${name}` : ""} — coming back from injury safely is exactly what I'm here for. I'll build a return-to-run plan around your recovery, not a generic training schedule.`;
  }
  if (goal === "general_fitness") {
    return `Love it${name ? `, ${name}` : ""} — building a consistent habit is a great foundation. I'll put together a plan that builds properly and adapts to your schedule.`;
  }
  const isNewer = experienceYears != null && experienceYears < 1;
  const whatDeanDoes = isNewer
    ? "I'll keep the plan manageable and build up at a pace that gets you to the start line healthy."
    : "I'll put together a tailored plan, track your training via Strava, and adjust things as your fitness builds.";
  const goalLabel = formatGoalInline(goal);
  return `Love it${name ? `, ${name}` : ""} — a ${goalLabel} is a great goal. ${whatDeanDoes}`;
}

// ---------------------------------------------------------------------------
// Inlined step routing (mirrors onboarding/handle/route.ts)
// ---------------------------------------------------------------------------

const ULTRA_GOALS = ["50k", "100k", "30k"];
const STEP_ORDER = [
  "awaiting_race_date",
  "awaiting_goal_time",
  "awaiting_strava",
  "awaiting_schedule",
  "awaiting_ultra_background",
  "awaiting_timezone",
  "awaiting_anything_else",
];

function isStepSatisfied(step, data) {
  switch (step) {
    case "awaiting_race_date":
      if (data.goal === "injury_recovery") return true;
      return Object.prototype.hasOwnProperty.call(data, "race_date");
    case "awaiting_goal_time":
      if (data.goal === "general_fitness" || data.goal === "injury_recovery" || ULTRA_GOALS.includes(data.goal)) return true;
      return Object.prototype.hasOwnProperty.call(data, "goal_time_minutes");
    case "awaiting_strava":
      return !!(data.strava_connected || data.strava_skipped);
    case "awaiting_schedule":
      return Array.isArray(data.training_days) && data.training_days.length > 0;
    case "awaiting_ultra_background":
      if (!ULTRA_GOALS.includes(data.goal)) return true;
      if (data.strava_connected) return true;
      return !!(data.weekly_miles) && !!(data.ultra_race_history || data.experience_years != null);
    case "awaiting_timezone":
      if (data.strava_connected && !data.strava_city) return true;
      return !!(data.timezone_confirmed);
    case "awaiting_anything_else":
      return !!(data.weekly_miles || data.weekly_hours) && !!(data.recent_race_distance_km || data.easy_pace);
    default:
      return false;
  }
}

function findNextStep(afterStep, data) {
  const afterIdx = STEP_ORDER.indexOf(afterStep);
  const remaining = afterIdx >= 0 ? STEP_ORDER.slice(afterIdx + 1) : [...STEP_ORDER];
  for (const step of remaining) {
    if (!isStepSatisfied(step, data)) return step;
  }
  return null;
}

function formatGoalInline(goal) {
  const labels = {
    "5k": "5K", "10k": "10K", half_marathon: "half marathon",
    marathon: "full marathon", "30k": "30K trail race", "50k": "50K ultra",
    "100k": "100K ultra", sprint_tri: "sprint triathlon",
    olympic_tri: "Olympic triathlon", "70.3": "70.3", ironman: "Full Ironman",
    cycling: "cycling event", general_fitness: "general fitness",
    injury_recovery: "injury recovery",
  };
  return labels[goal] || goal;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const CLASSIFIER_CASES = [
  // ── Injury recovery ─────────────────────────────────────────────────────
  { persona: "Injury recovery", msg: "Sarah — I've had IT band syndrome for 6 weeks and want to get back to running", expectGoal: "injury_recovery" },
  { persona: "Injury recovery", msg: "Recovering from a stress fracture in my foot, hoping to start running again soon", expectGoal: "injury_recovery" },
  { persona: "Injury recovery", msg: "I'm coming back from shin splints and don't really have a race in mind yet", expectGoal: "injury_recovery" },
  { persona: "Injury recovery", msg: "Been off running for 3 months with a hip flexor strain. Want to rebuild safely", expectGoal: "injury_recovery" },
  { persona: "Injury recovery", msg: "I hurt my achilles last fall and I'm finally cleared to run again", expectGoal: "injury_recovery" },

  // ── Newer runner / first race ────────────────────────────────────────────
  { persona: "New runner", msg: "Jake. Just started running a few months ago and want to do my first 5K", expectGoal: "5k" },
  { persona: "New runner", msg: "Hi! I'm Maria — never run a race before but signed up for a half marathon in October", expectGoal: "half_marathon" },
  { persona: "New runner", msg: "Just getting started, thinking about a 10K in the spring as my first race", expectGoal: "10k" },
  { persona: "New runner", msg: "Total beginner here. My goal is just to run a 5K without stopping", expectGoal: "5k" },

  // ── Experienced runner ───────────────────────────────────────────────────
  { persona: "Experienced runner", msg: "Mike — been running 5 years, targeting Boston in April, currently at 55 miles/week", expectGoal: "marathon" },
  { persona: "Experienced runner", msg: "Training for my third half marathon, looking to PR this time", expectGoal: "half_marathon" },
  { persona: "Experienced runner", msg: "I want to run a 50K trail race next fall. Done a couple marathons before", expectGoal: "50k" },
  { persona: "Experienced runner", msg: "Getting back into racing after a break — want to do a 10K in 3 months", expectGoal: "10k" },

  // ── General / ambiguous ──────────────────────────────────────────────────
  { persona: "General fitness", msg: "Just want to get in better shape and run consistently, no race in mind", expectGoal: "general_fitness" },
  { persona: "General fitness", msg: "No specific race planned — just building a habit", expectGoal: "general_fitness" },
  { persona: "Ambiguous / greeting", msg: "Hey!", expectGoal: null },
  { persona: "Ambiguous / greeting", msg: "Tom here 👋", expectGoal: null },
];

const ROUTING_CASES = [
  {
    label: "Injury recovery — minimal data (just goal)",
    data: { goal: "injury_recovery" },
    expectedSteps: ["awaiting_strava", "awaiting_schedule", "awaiting_timezone", "awaiting_anything_else"],
  },
  {
    label: "Injury recovery — strava connected",
    data: { goal: "injury_recovery", strava_connected: true, strava_city: "Denver", strava_state: "CO" },
    expectedSteps: ["awaiting_schedule", "awaiting_timezone", "awaiting_anything_else"],
  },
  {
    label: "New runner — half marathon, no data yet",
    data: { goal: "half_marathon" },
    expectedSteps: ["awaiting_race_date", "awaiting_goal_time", "awaiting_strava", "awaiting_schedule", "awaiting_timezone", "awaiting_anything_else"],
  },
  {
    label: "Experienced runner — marathon, has strava + schedule",
    data: { goal: "marathon", strava_connected: true, strava_city: "New York", strava_state: "NY", training_days: ["monday", "wednesday", "friday", "saturday", "sunday"] },
    expectedSteps: ["awaiting_race_date", "awaiting_goal_time", "awaiting_timezone", "awaiting_anything_else"],
  },
  {
    label: "Experienced runner — everything provided in first message",
    data: { goal: "marathon", race_date: "2026-04-20", goal_time_minutes: 210, strava_connected: true, strava_city: "Boston", strava_state: "MA", training_days: ["mon","tue","wed","thu","fri","sat","sun"], timezone_confirmed: true, weekly_miles: 55, easy_pace: "8:30" },
    expectedSteps: [],
  },
  {
    label: "Ultra — 50K, no data",
    data: { goal: "50k" },
    expectedSteps: ["awaiting_race_date", "awaiting_strava", "awaiting_schedule", "awaiting_ultra_background", "awaiting_timezone", "awaiting_anything_else"],
  },
  {
    label: "General fitness — no race",
    data: { goal: "general_fitness", race_date: null },
    expectedSteps: ["awaiting_strava", "awaiting_schedule", "awaiting_timezone", "awaiting_anything_else"],
  },
  {
    label: "Ultra — 50K, Strava already connected (skip ultra background Q)",
    data: { goal: "50k", strava_connected: true, strava_city: "Moab", strava_state: "UT" },
    expectedSteps: ["awaiting_race_date", "awaiting_schedule", "awaiting_timezone", "awaiting_anything_else"],
  },
  {
    label: "General fitness — no_event pre-filled (skip race date Q)",
    data: { goal: "general_fitness", race_date: null },
    expectedSteps: ["awaiting_strava", "awaiting_schedule", "awaiting_timezone", "awaiting_anything_else"],
  },
];

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

function pass(label) { return `  ✓ ${label}`; }
function fail(label, got, expected) { return `  ✗ ${label}\n    expected: ${expected}\n    got:      ${got}`; }

// ── Part 1: Routing logic (no API calls) ────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log("PART 1: Step routing logic (pure, no API calls)");
console.log("=".repeat(60));

let routingPassed = 0;
let routingFailed = 0;

for (const tc of ROUTING_CASES) {
  console.log(`\n  ${tc.label}`);
  const steps = [];
  let current = "awaiting_goal";
  // Walk the full step sequence from awaiting_goal
  while (true) {
    const next = findNextStep(current, tc.data);
    if (!next) break;
    steps.push(next);
    // Simulate satisfying the step so we advance (we just want to see the order)
    current = next;
    if (steps.length > 10) break; // safety
  }

  const got = JSON.stringify(steps);
  const expected = JSON.stringify(tc.expectedSteps);
  if (got === expected) {
    console.log(pass(`Steps: ${steps.join(" → ") || "(none — complete)"}`));
    routingPassed++;
  } else {
    console.log(fail("Step sequence mismatch", steps.join(" → "), tc.expectedSteps.join(" → ")));
    routingFailed++;
  }
}

console.log(`\n  Routing: ${routingPassed} passed, ${routingFailed} failed`);

// ── Part 2: Goal classifier + acknowledgment (Claude API calls) ──────────────
console.log("\n" + "=".repeat(60));
console.log("PART 2: Goal classifier + acknowledgment (Claude API)");
console.log("=".repeat(60));

let classifierPassed = 0;
let classifierFailed = 0;
let classifierWrong = 0;

for (const tc of CLASSIFIER_CASES) {
  process.stdout.write(`\n  [${tc.persona}]\n  "${tc.msg}"\n`);
  try {
    const [result, extra] = await Promise.all([
      classifyGoal(tc.msg),
      extractAdditionalFields(tc.msg),
    ]);
    const goalMatch = result.goal === tc.expectGoal;

    if (goalMatch) {
      classifierPassed++;
      process.stdout.write(`  ✓ classified: ${result.goal ?? "null"} (complete=${result.complete})\n`);
    } else {
      classifierFailed++;
      process.stdout.write(`  ✗ classified: ${result.goal ?? "null"} — expected: ${tc.expectGoal ?? "null"} (complete=${result.complete})\n`);
    }

    // Show the acknowledgment if goal was detected
    if (result.complete && result.goal) {
      const name = extra.name ?? null;
      const experienceYears = extra.experience_years ?? null;
      const ack = buildAcknowledgment(result.goal, name ?? "Alex", experienceYears, null);
      const extraStr = [name && `name=${name}`, experienceYears != null && `exp=${experienceYears}yr`].filter(Boolean).join(", ");
      process.stdout.write(`  → Extra: {${extraStr || "none"}}\n`);
      process.stdout.write(`  → Ack: "${ack}"\n`);
      const nextStep = findNextStep("awaiting_goal", { goal: result.goal });
      process.stdout.write(`  → Next step: ${nextStep ?? "(complete)"}\n`);
    }
  } catch (err) {
    classifierWrong++;
    process.stdout.write(`  ✗ ERROR: ${err.message}\n`);
  }
}

console.log(`\n  Classifier: ${classifierPassed} passed, ${classifierFailed} wrong classification, ${classifierWrong} errors`);

console.log("\n" + "=".repeat(60));
console.log("Done.");
console.log("=".repeat(60) + "\n");
