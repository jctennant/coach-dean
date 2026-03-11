/**
 * Test initial_plan generation for correctness:
 *   1. Day labels match DATE CONTEXT (not independently computed)
 *   2. Week mileage already done is acknowledged
 *   3. Plan starts from tomorrow, not today
 *   4. Only the last text block is used (no internal narration leaking)
 *
 * Run with: ANTHROPIC_API_KEY=... node scripts/test-initial-plan.mjs
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Simulate today as Tuesday March 10, 2026 (matching the real scenario)
const TODAY = "Tuesday, March 10, 2026";
const TOMORROW = "Wednesday, March 11, 2026";
const NEXT_7_DAYS =
  "Wednesday, Mar 11 | Thursday, Mar 12 | Friday, Mar 13 | Saturday, Mar 14 | Sunday, Mar 15 | Monday, Mar 16 | Tuesday, Mar 17";

// Simulate Jake's context
const systemPrompt = `You are Coach Dean, an expert endurance running coach.

DATE CONTEXT:
- Today: ${TODAY}
- Tomorrow: ${TOMORROW}
- Next 7 days: ${NEXT_7_DAYS}
- Timezone: America/Denver
- Always use specific calendar dates (e.g. "Friday, Feb 27") rather than relative terms like "tomorrow" or "next Monday" — messages may be read after the day they're sent.
- Race date: 2026-03-28 (18 days / ~3 weeks away)
- Plan backwards from race date: allocate taper (2 weeks), peak (2-3 weeks), build, and base phases

ATHLETE PROFILE:
- Name: Jake
- Goal: 30K trail race (Behind the Rocks, March 28, 2026)
- Training days: Tue, Wed, Thu, Sat, Sun
- Preferred units: imperial
- Injury notes: History of IT Band syndrome and shin splints (currently healthy)
- CrossFit 2x/week (Mon/Fri). Has Zwift bike at home, wants ~1 bike/week for cross-training.
- Secondary goal: improve speed/running economy for shorter races this summer

CURRENT TRAINING STATE:
- Week 1 of training, phase: sharpening/taper
- Weekly mileage target: 20 mi
- Mileage so far this week: 5.0 mi (Strava-synced; authoritative — do NOT add runs from conversation history or previous weeks to this figure)
- Athlete preferred units: imperial — use miles and min/mile in all responses
- Current paces: Easy 8:30–9:00/mi, Tempo 7:30/mi, Interval 6:45/mi

ATHLETE HISTORY (from Strava):
- Recent weekly mileage: avg ~22 mi/week over last 4 weeks
- Year-to-date: 251 miles over 39 runs (~6.4 mi/run avg)
- All-time: 6,699 miles — advanced, well-trained runner
- Fitness tier: HIGH VOLUME (20+ miles/week)`;

const userMessage = `This athlete just finished onboarding. Send them an initial week plan — framed as a starting point, not a finished prescription. The goal is to get something in front of them quickly and invite them to shape it.

USE STRAVA DATA — this is critical:
- Look at WEEKLY MILEAGE, PACE ANALYSIS, and RECENT WORKOUTS before writing a single word of the plan.
- If Strava data exists, reference it specifically.
- Set all training paces based on observed fitness from Strava.

DATES AND DAY LABELS:
- CRITICAL: Use the day names from DATE CONTEXT above — do not compute weekdays yourself. DATE CONTEXT lists tomorrow and the next 7 days with correct day names. Copy them directly. "Wed, Mar 11" → use "Wed 3/11". Getting these wrong destroys trust.
- Start the plan from tomorrow or later — do not add a session for today.
- If "Mileage so far this week" in CURRENT TRAINING STATE is > 0, acknowledge it in the first bubble ("You've already got X miles in this week") and factor it into the weekly total. Do not ignore it.

ULTRA DISTANCE GOALS (50K, 100K, and beyond): N/A for 30K.

SPORT-SPECIFIC GUIDANCE:
- Include CrossFit on Mon/Fri (already scheduled). Include one Zwift bike session.
- Account for IT band history — avoid overloading downhill running in first week.

MILEAGE ACCURACY: If you state a weekly mileage total, you must verify it by enumerating every running session distance and summing them before writing the number.

Write as 2 short iMessage texts separated by a blank line. Each under 480 characters.

First bubble: 2-3 sentences. Lead with key context (race timeline, mileage already done, rationale). Do NOT open with "Got it" or restate the goal.

Second bubble: this week's sessions, one per line, sorted chronologically by date (use day abbreviations and M/D dates from DATE CONTEXT):
Wed 3/11 · Easy 4mi
Thu 3/12 · ...
Then close with: feedback invite, reminder offer, open line.`;

async function runTest() {
  console.log("=".repeat(65));
  console.log("TEST: initial_plan generation");
  console.log("=".repeat(65));
  console.log(`\nToday: ${TODAY}`);
  console.log(`Correct upcoming days: Wed 3/11, Thu 3/12, Fri 3/13, Sat 3/14, Sun 3/15\n`);

  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  // Use last text block only (matching the fix in coach/respond)
  const textBlocks = response.content.filter(b => b.type === "text");
  const rawText = textBlocks[textBlocks.length - 1]?.text ?? "";

  console.log("--- RESPONSE ---\n");
  console.log(rawText);
  console.log("\n--- CHECKS ---\n");

  // Check 1: No wrong day labels
  const wrongLabels = ["Tue 3/11", "Wed 3/12", "Thu 3/13"].filter(wrong => {
    // Tue 3/11 is wrong (3/11 is Wed), Wed 3/12 is wrong (3/12 is Thu), Thu 3/13 is wrong (3/13 is Fri)
    return rawText.includes(wrong);
  });
  if (wrongLabels.length > 0) {
    console.log(`✗ WRONG DAY LABELS: ${wrongLabels.join(", ")} — these are off by one`);
  } else {
    console.log("✓ Day labels appear correct (no off-by-one found)");
  }

  // Check 2: Correct labels present
  const correctLabels = ["Wed 3/11", "Thu 3/12", "Fri 3/13"].filter(c => rawText.includes(c));
  if (correctLabels.length > 0) {
    console.log(`✓ Correct day labels found: ${correctLabels.join(", ")}`);
  }

  // Check 3: Acknowledges 5 miles already done
  const acknowledgesMileage = /5(\.\d+)? mi|already (got|have|run|done)|so far this week/i.test(rawText);
  if (acknowledgesMileage) {
    console.log("✓ Acknowledges mileage already done this week");
  } else {
    console.log("✗ Does NOT acknowledge the 5 miles already run today");
  }

  // Check 4: Plan doesn't include today (Tue 3/10)
  const includesToday = rawText.includes("3/10") || rawText.includes("Tue 3/10");
  if (includesToday) {
    console.log("✗ Plan includes today (3/10) — should start from tomorrow");
  } else {
    console.log("✓ Plan correctly starts from tomorrow (not today)");
  }

  // Check 5: Multiple text blocks test (narration leak)
  if (textBlocks.length > 1) {
    console.log(`⚠ ${textBlocks.length} text blocks in response — last block used, ${textBlocks.length - 1} narration block(s) discarded`);
    console.log("  Discarded:", textBlocks.slice(0, -1).map(b => b.text.slice(0, 80) + "...").join("\n  "));
  } else {
    console.log("✓ Single text block — no narration leak possible");
  }

  console.log("\n" + "=".repeat(65) + "\n");
}

runTest().catch(console.error);
