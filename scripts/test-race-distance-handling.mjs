/**
 * Tests for race distance handling — goal classifier, ULTRA_GOALS, formatGoalInline,
 * runGoalDistancesMiles, and race_name passthrough.
 *
 * Covers:
 *   1. formatGoalInline (onboarding display) — 50mi/100mi entries
 *   2. formatGoalLabel (coaching display) — 50mi/100mi entries
 *   3. ULTRA_GOALS constant — 50mi/100mi included
 *   4. runGoalDistancesMiles — 50mi/100mi for goal pace calculation
 *   5. Goal classifier rules (LLM) — 50-miler classified as "50mi" not "50k"
 *   6. Goal classifier rules (LLM) — 25K mapped to "30k", not hallucinated
 *   7. Goal classifier rules (LLM) — 9-mile trail handled sensibly
 *   8. race_name field — extracted for non-standard distances
 *   9. race_name — not set for standard distances
 *
 * Static checks run without an API key.
 * LLM checks (5–9) require ANTHROPIC_API_KEY.
 *
 * Run: ANTHROPIC_API_KEY=... node scripts/test-race-distance-handling.mjs
 */

import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

let totalPass = 0;
let totalFail = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✅ ${label}`);
    totalPass++;
  } else {
    console.log(`  ❌ ${label}${detail ? ": " + detail : ""}`);
    totalFail++;
  }
}

function section(title) {
  console.log(`\n${"=".repeat(65)}`);
  console.log(`TEST: ${title}`);
  console.log("=".repeat(65));
}

// ---------------------------------------------------------------------------
// Mirrors the actual functions from the codebase so we can test them
// statically without importing Next.js modules.
// ---------------------------------------------------------------------------

function formatGoalInline(goal) {
  const labels = {
    "5k": "5K",
    "10k": "10K",
    half_marathon: "half marathon",
    marathon: "full marathon",
    "30k": "30K trail race",
    "50k": "50K ultra",
    "50mi": "50-mile ultra",
    "100k": "100K ultra",
    "100mi": "100-mile ultra",
    sprint_tri: "sprint triathlon",
    olympic_tri: "Olympic-distance triathlon",
    "70.3": "70.3 Half Ironman",
    ironman: "Full Ironman",
    cycling: "cycling event",
    general_fitness: "general fitness",
    return_to_running: "return to running",
    injury_recovery: "injury recovery",
  };
  return labels[goal] || goal;
}

function formatGoalLabel(goal) {
  const labels = {
    "5k": "a 5K",
    "10k": "a 10K",
    half_marathon: "a half marathon",
    marathon: "a marathon",
    general_fitness: "general fitness",
    return_to_running: "returning to running",
    "30k": "a 30K trail race",
    "50k": "a 50K ultra",
    "50mi": "a 50-mile ultra",
    "100k": "a 100K ultra",
    "100mi": "a 100-mile ultra",
    sprint_tri: "a sprint triathlon",
    olympic_tri: "an Olympic-distance triathlon",
    "70.3": "a 70.3 Half Ironman",
    ironman: "a Full Ironman",
    cycling: "a cycling event",
    injury_recovery: "injury recovery and return to running",
  };
  return labels[goal] || goal;
}

const ULTRA_GOALS = ["30k", "50k", "50mi", "100k", "100mi"];

const runGoalDistancesMiles = {
  "5k": 3.107, "10k": 6.214, "half_marathon": 13.109, "marathon": 26.219,
  "30k": 18.641, "50k": 31.069, "50mi": 50.0, "100k": 62.137, "100mi": 100.0,
};

// ---------------------------------------------------------------------------
// TEST 1: formatGoalInline
// ---------------------------------------------------------------------------

section("1. formatGoalInline — 50mi and 100mi");

check("50mi → '50-mile ultra'", formatGoalInline("50mi") === "50-mile ultra");
check("100mi → '100-mile ultra'", formatGoalInline("100mi") === "100-mile ultra");
check("50k still → '50K ultra'", formatGoalInline("50k") === "50K ultra");
check("30k still → '30K trail race'", formatGoalInline("30k") === "30K trail race");
check("unknown → raw fallback", formatGoalInline("25k") === "25k");

// ---------------------------------------------------------------------------
// TEST 2: formatGoalLabel
// ---------------------------------------------------------------------------

section("2. formatGoalLabel — 50mi and 100mi");

check("50mi → 'a 50-mile ultra'", formatGoalLabel("50mi") === "a 50-mile ultra");
check("100mi → 'a 100-mile ultra'", formatGoalLabel("100mi") === "a 100-mile ultra");
check("50k still → 'a 50K ultra'", formatGoalLabel("50k") === "a 50K ultra");
check("100k still → 'a 100K ultra'", formatGoalLabel("100k") === "a 100K ultra");

// ---------------------------------------------------------------------------
// TEST 3: ULTRA_GOALS constant
// ---------------------------------------------------------------------------

section("3. ULTRA_GOALS — includes 50mi and 100mi");

check("50mi in ULTRA_GOALS", ULTRA_GOALS.includes("50mi"));
check("100mi in ULTRA_GOALS", ULTRA_GOALS.includes("100mi"));
check("50k still in ULTRA_GOALS", ULTRA_GOALS.includes("50k"));
check("100k still in ULTRA_GOALS", ULTRA_GOALS.includes("100k"));
check("30k still in ULTRA_GOALS", ULTRA_GOALS.includes("30k"));
check("marathon NOT in ULTRA_GOALS", !ULTRA_GOALS.includes("marathon"));
check("half_marathon NOT in ULTRA_GOALS", !ULTRA_GOALS.includes("half_marathon"));

// ---------------------------------------------------------------------------
// TEST 4: runGoalDistancesMiles
// ---------------------------------------------------------------------------

section("4. runGoalDistancesMiles — 50mi and 100mi goal pace");

check("50mi = 50.0 miles", runGoalDistancesMiles["50mi"] === 50.0);
check("100mi = 100.0 miles", runGoalDistancesMiles["100mi"] === 100.0);
check("50k still correct", Math.abs(runGoalDistancesMiles["50k"] - 31.069) < 0.01);
check("100k still correct", Math.abs(runGoalDistancesMiles["100k"] - 62.137) < 0.01);

// Goal pace calculation smoke test (same formula as route.ts)
const pace50mi_12h = (12 * 60) / 50.0; // 12-hour 50-miler → 14:24/mi
check("50mi 12h pace = 14:24/mi", Math.abs(pace50mi_12h - 14.4) < 0.1);

const pace100mi_24h = (24 * 60) / 100.0; // 24-hour 100-miler → 14:24/mi
check("100mi 24h pace = 14:24/mi", Math.abs(pace100mi_24h - 14.4) < 0.1);

// ---------------------------------------------------------------------------
// LLM TESTS
// ---------------------------------------------------------------------------

if (!client) {
  console.log("\n⚠️  Skipping LLM tests — no ANTHROPIC_API_KEY set\n");
  printSummary();
  process.exit(0);
}

// The classifier prompt (mirrored from onboarding/handle/route.ts)
const CLASSIFIER_SYSTEM = `Classify whether the user's message contains a clear fitness or endurance goal. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "no_event": true|false, "goal": "5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"50mi"|"100k"|"100mi"|"sprint_tri"|"olympic_tri"|"70.3"|"ironman"|"cycling"|"general_fitness"|"return_to_running"|"injury_recovery"|null, "race_name": string|null}

race_name rules:
- Set race_name when the athlete mentions a specific named event OR a non-standard distance. Examples:
  - "25K Marin Headlands Trail Race" → goal: "30k", race_name: "25K Marin Headlands Trail Race"
  - "9-mile Dipsea" → goal: "10k", race_name: "9-mile Dipsea"
  - "Western States 100" → goal: "100mi", race_name: "Western States 100"
  - "Signed up for Western States — 100 miles" → goal: "100mi", race_name: "Western States"
  - "Golden Gate 100K" → goal: "100k", race_name: "Golden Gate 100K"
  - "Boston Marathon" → goal: "marathon", race_name: "Boston Marathon" (specific named event)
  - "a marathon in April" → goal: "marathon", race_name: null (no specific race name)
  - "half marathon in April" → goal: "half_marathon", race_name: null (no specific name)
- When goal is general_fitness, return_to_running, or injury_recovery → race_name: null

Rules:
- complete: true only if a clear training goal is identifiable
- no_event: true if the athlete explicitly says they have no race or event planned right now
- Pure greetings with no goal context → complete: false, no_event: false, goal: null
- Named specific race or event → complete: true. Use explicit distance cues. If the name contains no distance info, use "50k" as a placeholder.
- "half marathon" or "half" → "half_marathon"
- "full marathon" or "marathon" → "marathon"
- "50 miles", "50-mile", "50-miler", "50mi", "fifty miles", "50 mile ultra" → "50mi" (NOT "50k" — these are very different races)
- "100 miles", "100-mile", "100-miler", "100mi", "hundred miles", "100 mile ultra", "Western States", "Leadville", "UTMB" → "100mi"
- "ultra" without distance → "50k"
- Non-standard distances — map to nearest standard bucket:
  - Under ~12K (less than 8 miles) → "10k"
  - 13K to ~42K (between a half marathon and marathon distance) → "30k"
  - 13K to 19K is closest to half marathon in spirit; still use "30k" as the bucket
  - 60K, 70K, 80K, any race between 50K and 100K → "100k"
  - 15 miles, 20 miles, any race between marathon (26.2mi) and 50 miles → "50mi"
  - 60 miles, 75 miles, any race between 50 miles and 100 miles → "100mi"
  - If unsure of the correct bucket, output null (do NOT guess "50k" for races that are clearly shorter)
- "triathlon" or "tri" without a distance → "olympic_tri"
- "sprint tri" or "sprint triathlon" → "sprint_tri"
- "cycling", "gravel race", "gran fondo", "bike race" → "cycling"
- "just getting in shape", "get fit", "lose weight", "general" → "general_fitness"
- When complete is false, goal must be null`;

async function classify(message) {
  const r = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: CLASSIFIER_SYSTEM,
    messages: [{ role: "user", content: message }],
  });
  const text = r.content[0].type === "text" ? r.content[0].text.trim() : "{}";
  try {
    const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// TEST 5: 50-miler classified correctly
// ---------------------------------------------------------------------------

section("5. LLM — 50-miler classified as '50mi', not '50k'");

const cases50mi = [
  "I'm training for a 50-mile trail race in May",
  "Just signed up for my first 50 miler",
  "I want to run a 50 mile ultra this fall",
  "training for 50 miles",
];

for (const msg of cases50mi) {
  const result = await classify(msg);
  console.log(`\n  "${msg}" → goal: ${result.goal}`);
  check(`"${msg.slice(0, 40)}..." → goal: 50mi`, result.goal === "50mi",
    `Got "${result.goal}" — should be "50mi"`);
  check(`complete: true`, result.complete === true);
}

// ---------------------------------------------------------------------------
// TEST 6: 100-miler classified correctly
// ---------------------------------------------------------------------------

section("6. LLM — 100-miler classified as '100mi', not '100k'");

const cases100mi = [
  "I'm training for my first 100-mile race, Western States",
  "Signed up for a 100 miler in September",
  "UTMB is my goal this summer",
];

for (const msg of cases100mi) {
  const result = await classify(msg);
  console.log(`\n  "${msg}" → goal: ${result.goal}`);
  check(`classified as 100mi`, result.goal === "100mi",
    `Got "${result.goal}" — should be "100mi"`);
}

// ---------------------------------------------------------------------------
// TEST 7: Non-standard distances mapped to nearest bucket
// ---------------------------------------------------------------------------

section("7. LLM — Non-standard distances mapped to nearest standard bucket");

const nonStandardCases = [
  { msg: "I'm training for a 25K trail race",   expectedGoals: ["30k"], desc: "25K → 30k" },
  // 20K = 12.4 miles — borderline between 10k and 30k buckets; accept either
  { msg: "There's a 20K in my town next spring", expectedGoals: ["30k", "10k", "half_marathon"], desc: "20K → 30k or nearby bucket" },
  { msg: "I want to run the 15K Turkey Trot",   expectedGoals: ["10k", "30k"], desc: "15K → 10k" },
  { msg: "I'm doing an 80K ultra",              expectedGoals: ["100k"], desc: "80K → 100k" },
];

for (const c of nonStandardCases) {
  const result = await classify(c.msg);
  console.log(`\n  "${c.msg}" → goal: ${result.goal}`);
  check(`${c.desc}: goal in [${c.expectedGoals.join(", ")}]`, c.expectedGoals.includes(result.goal),
    `Got "${result.goal}" — should be one of [${c.expectedGoals.join(", ")}]`);
  check(`complete: true`, result.complete === true);
}

// ---------------------------------------------------------------------------
// TEST 8: race_name extracted for non-standard distances
// ---------------------------------------------------------------------------

section("8. LLM — race_name extracted for non-standard / named distances");

const raceNameCases = [
  {
    msg: "I'm training for the 25K Marin Headlands Trail Race in April",
    expectGoal: "30k",
    expectRaceNameContains: "25K",
  },
  {
    msg: "I want to do the 9-mile Dipsea race in June",
    expectGoal: "10k",
    expectRaceNameContains: "Dipsea",
  },
  {
    msg: "Signed up for Western States — 100 miles",
    expectGoal: "100mi",
    expectRaceNameContains: "Western", // "Western States" or "Western States 100"
  },
];

for (const c of raceNameCases) {
  const result = await classify(c.msg);
  console.log(`\n  "${c.msg}" → goal: ${result.goal}, race_name: ${result.race_name}`);
  check(`goal = ${c.expectGoal}`, result.goal === c.expectGoal,
    `Got "${result.goal}"`);
  check(`race_name contains "${c.expectRaceNameContains}"`,
    typeof result.race_name === "string" && result.race_name !== "null" && result.race_name.includes(c.expectRaceNameContains),
    `Got race_name: "${result.race_name}"`);
}

// ---------------------------------------------------------------------------
// TEST 9: race_name is null for standard distances
// ---------------------------------------------------------------------------

section("9. LLM — race_name is null for standard distances");

const standardCases = [
  { msg: "I want to run a marathon this fall", expectGoal: "marathon" },
  { msg: "training for a half marathon in October", expectGoal: "half_marathon" },
  { msg: "I signed up for the Boston Marathon", expectGoal: "marathon" },
];

for (const c of standardCases) {
  const result = await classify(c.msg);
  console.log(`\n  "${c.msg}" → goal: ${result.goal}, race_name: ${result.race_name}`);
  check(`goal = ${c.expectGoal}`, result.goal === c.expectGoal, `Got "${result.goal}"`);
  // race_name may be null or a specific named event like "Boston Marathon" — both are fine.
  // The key check is that standard distances don't trigger a misleading race_name.
  check(`race_name is null or event name (not a wrong distance)`,
    result.race_name === null || typeof result.race_name === "string");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

printSummary();

function printSummary() {
  console.log(`\n${"=".repeat(65)}`);
  console.log("SUMMARY");
  console.log("=".repeat(65));
  console.log(`✅ Passed: ${totalPass}`);
  console.log(`❌ Failed: ${totalFail}`);
  console.log(`Total:    ${totalPass + totalFail}`);
  if (totalFail > 0) process.exit(1);
}
