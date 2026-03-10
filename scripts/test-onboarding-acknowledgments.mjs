/**
 * Onboarding acknowledgment test script.
 * Run with: ANTHROPIC_API_KEY=... node scripts/test-onboarding-acknowledgments.mjs
 *
 * Tests that Dean acknowledges what the user actually says at each onboarding step,
 * rather than blindly moving to the next question. Covers:
 *   - acknowledgeSharedInfo() — the general acknowledgment function used by most steps
 *   - acknowledgeSchedule()   — schedule-specific acknowledgment that always fires
 *
 * For each step we test:
 *   SUBSTANTIVE messages → should produce a non-null, contextually relevant acknowledgment
 *   BARE messages       → should return null (no unnecessary "Great!" noise)
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Inlined from route.ts
// ---------------------------------------------------------------------------

async function acknowledgeSharedInfo(message) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: `You are Coach Dean, a friendly endurance coach onboarding a new athlete via SMS.

The athlete just shared something during the onboarding process. If they shared anything substantive, respond with ONE short, warm, specific sentence that shows you heard them. Be concrete — reference what they actually said.

Count these as substantive:
- Personal context, emotions, goals, backstory ("I've been dreaming about this for years", "this is my first marathon")
- Training data they share (weekly miles, pace, recent races) — acknowledge it as a useful baseline
- Lifestyle constraints (work schedule, travel, family)
- Scheduling flexibility ("I may switch those around")
- Alternative tools (Garmin, Apple Watch) — acknowledge and note you can work with them
- Privacy concerns or hesitation, even while complying ("I'll skip — I'm a privacy person") — acknowledge and respect the choice
- Any question or concern worth noting

Return only the word: null if the message is a truly bare answer with no extra context — e.g. just a date, a number, "nope", "no", "I'm good", "Skip", "Yes", "Yeah that's right".

Plain text only — no markdown, no asterisks.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  if (!text || text.toLowerCase() === "null") return null;
  return text;
}

async function acknowledgeSchedule(message, trainingDays) {
  const dayList = trainingDays.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(", ");
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system: `You are Coach Dean, a friendly endurance coach onboarding a new athlete via SMS.

The athlete just confirmed their training schedule. Write ONE short, warm sentence (max 15 words) acknowledging the schedule. Their training days are: ${dayList}.

If they mentioned any flexibility or that they might swap days around, acknowledge that the plan can flex.
If they gave a plain answer with no caveats, just confirm you've got the days locked in.

Examples:
- Plain: "Perfect — I've got you down for ${dayList}."
- Flexibility caveat: "Works for me — we can always shuffle things around as life gets in the way."

Plain text only — no markdown.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  return text || `Perfect — I've got you down for ${dayList}.`;
}

// ---------------------------------------------------------------------------
// Test cases by step
// ---------------------------------------------------------------------------

const STEP_CASES = [
  // ── awaiting_race_date ──────────────────────────────────────────────────
  {
    step: "awaiting_race_date",
    cases: [
      { type: "SUBSTANTIVE", msg: "April 21st — it's the Boston Marathon. I've been working toward this for 3 years.", expectNull: false },
      { type: "SUBSTANTIVE", msg: "October 12th. I got in through the lottery and I'm kind of freaking out!", expectNull: false },
      { type: "SUBSTANTIVE", msg: "I'm thinking late September — I want to do it before the weather gets bad here in Denver", expectNull: false },
      { type: "BARE", msg: "April 21st", expectNull: true },
      { type: "BARE", msg: "October", expectNull: true },
      { type: "BARE", msg: "Not sure yet, maybe next spring", expectNull: true },
    ],
  },

  // ── awaiting_goal_time ──────────────────────────────────────────────────
  {
    step: "awaiting_goal_time",
    cases: [
      { type: "SUBSTANTIVE", msg: "Sub-3:30 would be incredible. I ran 3:47 last year and I've been working really hard on my long runs.", expectNull: false },
      { type: "SUBSTANTIVE", msg: "Honestly just want to finish — this is my first marathon and I'm already nervous about making it to the start line!", expectNull: false },
      { type: "SUBSTANTIVE", msg: "Around 1:55. I'm 52 and just did a 2:03 so I think it's within reach if I stay healthy.", expectNull: false },
      { type: "BARE", msg: "Sub-4 hours", expectNull: true },
      { type: "BARE", msg: "1:55", expectNull: true },
      { type: "BARE", msg: "No specific time goal", expectNull: true },
    ],
  },

  // ── awaiting_strava (skip) ──────────────────────────────────────────────
  {
    step: "awaiting_strava",
    cases: [
      { type: "SUBSTANTIVE", msg: "I use Garmin Connect mostly — is there a way to connect that instead?", expectNull: false },
      { type: "SUBSTANTIVE", msg: "I don't have Strava, I just track everything in my head honestly!", expectNull: false },
      { type: "SUBSTANTIVE", msg: "I'll skip for now — I'm kind of a privacy person and not sure I want to share my data", expectNull: false },
      { type: "BARE", msg: "Skip", expectNull: true },
      { type: "BARE", msg: "No thanks", expectNull: true },
      { type: "BARE", msg: "nope", expectNull: true },
    ],
  },

  // ── awaiting_schedule ───────────────────────────────────────────────────
  {
    step: "awaiting_schedule (bare — uses acknowledgeSchedule)",
    useSchedule: true,
    trainingDays: ["tuesday", "thursday", "saturday", "sunday"],
    cases: [
      { type: "SUBSTANTIVE", msg: "Tue, Thu, Sat, Sun — but I may switch those around depending on life", expectNull: false },
      { type: "SUBSTANTIVE", msg: "I work long shifts Mon/Wed/Fri so I can only really train on the other days", expectNull: false },
      { type: "SUBSTANTIVE", msg: "Tuesday, Thursday, Saturday, and Sunday work best. I try to do my long run Sunday mornings before the family wakes up.", expectNull: false },
      // Note: acknowledgeSchedule ALWAYS returns something, so "bare" still gets a confirmation
      { type: "BARE (still gets confirmation)", msg: "Tuesday, Thursday, Saturday, Sunday", expectNull: false },
      { type: "BARE (still gets confirmation)", msg: "4 days — Mon, Wed, Fri, Sun", expectNull: false },
    ],
  },

  // ── awaiting_ultra_background ───────────────────────────────────────────
  {
    step: "awaiting_ultra_background",
    cases: [
      { type: "SUBSTANTIVE", msg: "I finished the Leadville 100 last year and have done 3 50Ks. Running about 60 miles a week, long runs around 18-20 miles.", expectNull: false },
      { type: "SUBSTANTIVE", msg: "This would be my first ultra! I've only done road marathons. Currently at about 40 miles/week.", expectNull: false },
      { type: "SUBSTANTIVE", msg: "Done two 50Ks — both trail. Weekly mileage is around 50, longest run is maybe 16 miles right now. Trails are my thing.", expectNull: false },
      { type: "SUBSTANTIVE", msg: "No ultra experience, running about 45 miles a week", expectNull: false },
    ],
  },

  // ── awaiting_timezone ───────────────────────────────────────────────────
  {
    step: "awaiting_timezone",
    cases: [
      { type: "SUBSTANTIVE", msg: "Denver, Colorado — I love running in the mountains here, the altitude makes everything harder!", expectNull: false },
      { type: "SUBSTANTIVE", msg: "I'm in Phoenix but I'm moving to Seattle in a couple months — not sure if that matters?", expectNull: false },
      { type: "BARE", msg: "Denver", expectNull: true },
      { type: "BARE", msg: "New York", expectNull: true },
      { type: "BARE", msg: "Yeah that's right", expectNull: true },
    ],
  },

  // ── awaiting_anything_else ──────────────────────────────────────────────
  {
    step: "awaiting_anything_else",
    cases: [
      { type: "SUBSTANTIVE", msg: "I've had some IT band issues on my left knee — been fine for 3 months but want to be careful. Also I do yoga twice a week.", expectNull: false },
      { type: "SUBSTANTIVE", msg: "Running about 35 miles a week, easy pace is around 9:30. Last race was a half in 2:01.", expectNull: false },
      { type: "SUBSTANTIVE", msg: "Nothing major — just that I travel for work a lot so some weeks I'm running on hotel treadmills.", expectNull: false },
      { type: "BARE", msg: "Nope, that's it!", expectNull: true },
      { type: "BARE", msg: "I'm good", expectNull: true },
      { type: "BARE", msg: "No", expectNull: true },
    ],
  },
];

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

let totalPassed = 0;
let totalFailed = 0;

function pass(label) { return `  ✓ ${label}`; }
function fail(label, detail) { return `  ✗ ${label}\n    ${detail}`; }

console.log("\n" + "=".repeat(70));
console.log("Onboarding acknowledgment tests");
console.log("=".repeat(70));
console.log("Tests that Dean responds to what users actually say at each step,");
console.log("rather than blindly jumping to the next question.\n");

for (const stepGroup of STEP_CASES) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`STEP: ${stepGroup.step}`);
  console.log("─".repeat(70));

  // Run all cases in this step concurrently
  const results = await Promise.all(
    stepGroup.cases.map(async (tc) => {
      let ack;
      if (stepGroup.useSchedule) {
        ack = await acknowledgeSchedule(tc.msg, stepGroup.trainingDays);
      } else {
        ack = await acknowledgeSharedInfo(tc.msg);
      }
      return { tc, ack };
    })
  );

  for (const { tc, ack } of results) {
    const isNull = ack === null || ack === undefined;
    const passed = tc.expectNull ? isNull : !isNull;

    const shortMsg = tc.msg.length > 60 ? tc.msg.slice(0, 60) + "…" : tc.msg;
    const label = `[${tc.type}] "${shortMsg}"`;

    if (passed) {
      totalPassed++;
      console.log(pass(label));
      if (!isNull) console.log(`    → "${ack}"`);
    } else {
      totalFailed++;
      const detail = tc.expectNull
        ? `Expected null (bare answer) but got: "${ack}"`
        : `Expected an acknowledgment but got null`;
      console.log(fail(label, detail));
    }
  }
}

console.log(`\n${"=".repeat(70)}`);
console.log(`Results: ${totalPassed} passed, ${totalFailed} failed`);
console.log("=".repeat(70) + "\n");
