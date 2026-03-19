/**
 * Tests for trigger-conditional system prompt (batch 1 token optimizations).
 *
 * Covers:
 *   1. Static flag logic — correct section inclusions/exclusions per trigger
 *   2. LLM behavioral checks — model still behaves correctly without removed sections
 *      a. morning_reminder: gives a valid reminder (no training philosophy lecture)
 *      b. post_run: handles "ran faster than prescribed" correctly (TONE section present)
 *      c. post_run: doesn't hallucinate product capabilities (section absent)
 *      d. user_message: handles "how do I connect Garmin?" (PRODUCT CAPABILITIES present)
 *      e. initial_plan: doesn't output [NO_REPLY] (section absent for plans)
 *      f. user_message: outputs [NO_REPLY] for a pure closing message (section present)
 *
 * Static checks (1) run without an API key.
 * LLM checks (2) require ANTHROPIC_API_KEY.
 *
 * Run: ANTHROPIC_API_KEY=... node scripts/test-trigger-conditional-prompt.mjs
 */

import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const MODEL = "claude-sonnet-4-6";

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
// Mirror the exact conditional logic from buildSystemPrompt
// ---------------------------------------------------------------------------

function buildFlags(trigger) {
  const isReminder = trigger === "morning_reminder" || trigger === "nightly_reminder";
  const isPlan = trigger === "initial_plan" || trigger === "weekly_recap";
  const isPostRun = trigger === "post_run";
  const isConversational = trigger === "user_message";
  const isRunReview = isPostRun || isConversational;
  return { isReminder, isPlan, isPostRun, isConversational, isRunReview };
}

// What sections each trigger should include/exclude
const SECTION_RULES = {
  TRAINING_PHILOSOPHY:     { includedWhen: (f) => !f.isReminder },
  WHEN_NOT_TO_REPLY:       { includedWhen: (f) => f.isRunReview || false },  // workout_image also but not tested here
  TONE_RUN_FASTER:         { includedWhen: (f) => f.isRunReview },
  TONE_DIFFERENT_WORKOUT:  { includedWhen: (f) => f.isRunReview },
  PRODUCT_CAPABILITIES:    { includedWhen: (f) => f.isConversational },
  STRENGTH_CROSSTRAINING:  { includedWhen: (f) => !f.isReminder && !f.isPostRun },
  ATHLETE_PHILOSOPHIES:    { includedWhen: (f) => f.isConversational },
};

// ---------------------------------------------------------------------------
// TEST 1: Static flag logic
// ---------------------------------------------------------------------------

section("1. Static flag logic — correct inclusions/exclusions per trigger");

const triggers = [
  "morning_reminder",
  "nightly_reminder",
  "post_run",
  "initial_plan",
  "weekly_recap",
  "user_message",
  "workout_image",
];

const expectations = {
  morning_reminder: {
    TRAINING_PHILOSOPHY: false,
    WHEN_NOT_TO_REPLY: false,
    TONE_RUN_FASTER: false,
    TONE_DIFFERENT_WORKOUT: false,
    PRODUCT_CAPABILITIES: false,
    STRENGTH_CROSSTRAINING: false,
    ATHLETE_PHILOSOPHIES: false,
  },
  nightly_reminder: {
    TRAINING_PHILOSOPHY: false,
    WHEN_NOT_TO_REPLY: false,
    TONE_RUN_FASTER: false,
    TONE_DIFFERENT_WORKOUT: false,
    PRODUCT_CAPABILITIES: false,
    STRENGTH_CROSSTRAINING: false,
    ATHLETE_PHILOSOPHIES: false,
  },
  post_run: {
    TRAINING_PHILOSOPHY: true,  // kept — coach needs 80/20 context when reviewing pace
    WHEN_NOT_TO_REPLY: true,
    TONE_RUN_FASTER: true,
    TONE_DIFFERENT_WORKOUT: true,
    PRODUCT_CAPABILITIES: false,
    STRENGTH_CROSSTRAINING: false,
    ATHLETE_PHILOSOPHIES: false,
  },
  initial_plan: {
    TRAINING_PHILOSOPHY: true,
    WHEN_NOT_TO_REPLY: false,
    TONE_RUN_FASTER: false,
    TONE_DIFFERENT_WORKOUT: false,
    PRODUCT_CAPABILITIES: false,
    STRENGTH_CROSSTRAINING: true,
    ATHLETE_PHILOSOPHIES: false,
  },
  weekly_recap: {
    TRAINING_PHILOSOPHY: true,
    WHEN_NOT_TO_REPLY: false,
    TONE_RUN_FASTER: false,
    TONE_DIFFERENT_WORKOUT: false,
    PRODUCT_CAPABILITIES: false,
    STRENGTH_CROSSTRAINING: true,
    ATHLETE_PHILOSOPHIES: false,
  },
  user_message: {
    TRAINING_PHILOSOPHY: true,
    WHEN_NOT_TO_REPLY: true,
    TONE_RUN_FASTER: true,
    TONE_DIFFERENT_WORKOUT: true,
    PRODUCT_CAPABILITIES: true,
    STRENGTH_CROSSTRAINING: true,
    ATHLETE_PHILOSOPHIES: true,
  },
};

for (const trigger of Object.keys(expectations)) {
  const flags = buildFlags(trigger);
  const expected = expectations[trigger];
  for (const [section_name, rule] of Object.entries(SECTION_RULES)) {
    const actual = rule.includedWhen(flags);
    const exp = expected[section_name];
    if (exp !== undefined) {
      check(
        `${trigger}: ${section_name} → ${exp ? "included" : "excluded"}`,
        actual === exp,
        `Got ${actual} (flags: ${JSON.stringify(flags)})`
      );
    }
  }
}

// Verify workout_image gets WHEN_NOT_TO_REPLY
// (handled separately via `trigger === "workout_image"` in the template)
const wiFlags = buildFlags("workout_image");
// workout_image: isRunReview = false, but the template has an extra `|| trigger === "workout_image"`
// We test this as a known edge case, not via the flag helper
check(
  "workout_image: WHEN_NOT_TO_REPLY handled by explicit trigger check (not isRunReview)",
  !wiFlags.isRunReview,
  "isRunReview should be false — workout_image gets it via separate clause"
);

// ---------------------------------------------------------------------------
// LLM checks
// ---------------------------------------------------------------------------

if (!client) {
  console.log("\n⚠️  Skipping LLM tests — no ANTHROPIC_API_KEY set\n");
  printSummary();
  process.exit(0);
}

// Shared minimal system prompt skeleton that mirrors what each trigger would receive.
// We don't need the full prompt — just the sections that ARE or ARE NOT present.
function buildTestPrompt(trigger) {
  const flags = buildFlags(trigger);

  const trainingPhilosophy = !flags.isReminder ? `
TRAINING PHILOSOPHY:
1. 80/20 INTENSITY DISTRIBUTION: ~80% of all training at genuinely easy effort. Easy runs are truly easy. Hard days are genuinely hard.
2. VDOT-CALIBRATED PACING: Use stored training paces. Never assign arbitrary paces.
3. PERIODIZATION: Progressive overload, no more than 10%/week increase.
` : "";

  const whenNotToReply = (flags.isRunReview) ? `
WHEN NOT TO REPLY — check this first:
If the athlete's last message is purely a closing acknowledgment — "Perfect", "Thanks!", "Sounds great", "Got it", "👍" — output exactly: [NO_REPLY]
` : "";

  const toneWhenFaster = flags.isRunReview ? `
TONE WHEN ATHLETE RUNS FASTER THAN PRESCRIBED:
- Lead with genuine excitement, then one brief note about why prescribed pace matters.
- Say it once lightly, then move on.
` : "";

  const productCapabilities = flags.isConversational ? `
PRODUCT CAPABILITIES:
- Activity tracking: Strava only. No Garmin, Apple Watch, or other platform sync.
- If asked about Garmin: "I only have Strava sync right now."
- Communication: SMS only. No app, no web dashboard.
` : "";

  return `You are Coach Dean, an AI running coach. You are coaching Alex for a marathon on 2026-06-15.

CRITICAL — OUTPUT RULES: Output only the message the athlete should receive. No internal reasoning.
LENGTH: Keep responses under 480 characters.
${trainingPhilosophy}${whenNotToReply}${toneWhenFaster}${productCapabilities}
ATHLETE HISTORY:
- Goal: a marathon on 2026-06-15
- Training days: Tuesday, Thursday, Saturday, Sunday
- Injury: None

CURRENT TRAINING STATE:
- Week 8 of training, phase: build
- Weekly mileage target: 35 mi
- Easy pace: 9:30/mi, Tempo: 8:15/mi, Interval: 7:30/mi

UPCOMING SESSIONS THIS WEEK:
Thursday 3/20 · Easy 6mi @ 9:30/mi
Saturday 3/22 · Long run 14mi easy
Sunday 3/23 · Easy 4mi recovery`;
}

async function ask(trigger, userMsg) {
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: buildTestPrompt(trigger),
    messages: [{ role: "user", content: userMsg }],
  });
  return r.content[0].type === "text" ? r.content[0].text.trim() : "";
}

// ---------------------------------------------------------------------------
// TEST 2a: morning_reminder — gives a valid reminder, not a philosophy lecture
// ---------------------------------------------------------------------------

section("2a. LLM morning_reminder — gives reminder, no training philosophy lecture");

const morningReminder = await ask(
  "morning_reminder",
  "[TRIGGER: morning_reminder] Today is Thursday. Upcoming session: Easy 6mi @ 9:30/mi."
);
console.log(`\n  Response: "${morningReminder.slice(0, 200)}"`);

check(
  "Response is non-empty",
  morningReminder.length > 20
);
check(
  "Not [NO_REPLY]",
  !morningReminder.includes("[NO_REPLY]")
);
check(
  "Mentions today's session (6mi or easy or Thursday)",
  /6\s*mi|easy|thursday/i.test(morningReminder)
);
check(
  "Doesn't start with a philosophy lecture (no '80/20' or 'periodization' opener)",
  !/^(80\/20|periodization|aerobic base)/i.test(morningReminder)
);

// ---------------------------------------------------------------------------
// TEST 2b: post_run — handles "ran faster than prescribed" correctly
// ---------------------------------------------------------------------------

section("2b. LLM post_run — correctly handles faster-than-prescribed run");

const postRunFaster = await ask(
  "post_run",
  "Just finished my easy 6 miler — ended up running 8:45/mi, felt great though!"
);
console.log(`\n  Response: "${postRunFaster.slice(0, 200)}"`);

check(
  "Response is non-empty",
  postRunFaster.length > 20
);
check(
  "Not [NO_REPLY]",
  !postRunFaster.includes("[NO_REPLY]")
);
check(
  "Acknowledges the run positively (fitness / strong / great / solid / awesome / fit / energy)",
  /fitness|strong|great|solid|nice|well done|good|awesome|fit|energy/i.test(postRunFaster)
);
check(
  "Mentions pace context (easy pace / prescribed / 9:30 / effort / adapt)",
  /easy pace|9:30|prescribed|effort|adapt|recovery|aerobic/i.test(postRunFaster)
);

// ---------------------------------------------------------------------------
// TEST 2c: post_run — doesn't invent product capability answers
// ---------------------------------------------------------------------------

section("2c. LLM post_run — Garmin question handled without product capabilities section");

const postRunGarmin = await ask(
  "post_run",
  "By the way, can I connect my Garmin to track my runs?"
);
console.log(`\n  Response: "${postRunGarmin.slice(0, 200)}"`);

check(
  "Response is non-empty",
  postRunGarmin.length > 20
);
check(
  "Does NOT confidently claim full Garmin support (no 'yes, connect your Garmin' style answer)",
  !/yes.*garmin.*connect|connect.*garmin.*yes/i.test(postRunGarmin)
);
// Without the product capabilities section, the model should either say it doesn't have that
// info or give a cautious answer — it should NOT fabricate specific connection instructions.
check(
  "Does not provide fake step-by-step Garmin connection instructions",
  !/go to settings|open the app|sync.*garmin.*steps|garmin connect.*app/i.test(postRunGarmin)
);

// ---------------------------------------------------------------------------
// TEST 2d: user_message — handles "how do I connect Garmin?" with PRODUCT CAPABILITIES
// ---------------------------------------------------------------------------

section("2d. LLM user_message — handles Garmin question correctly (has PRODUCT CAPABILITIES)");

const userMsgGarmin = await ask(
  "user_message",
  "Hey, can I connect my Garmin to track my runs automatically?"
);
console.log(`\n  Response: "${userMsgGarmin.slice(0, 200)}"`);

check(
  "Response is non-empty",
  userMsgGarmin.length > 20
);
check(
  "Mentions Strava as the supported option",
  /strava/i.test(userMsgGarmin)
);
check(
  "Acknowledges Garmin is not supported (only, right now, just, don't have, etc.)",
  /only|right now|just|don't have|no garmin|not support/i.test(userMsgGarmin)
);

// ---------------------------------------------------------------------------
// TEST 2e: initial_plan — does NOT output [NO_REPLY]
// ---------------------------------------------------------------------------

section("2e. LLM initial_plan — never outputs [NO_REPLY] (section absent)");

const initialPlanResponse = await ask(
  "initial_plan",
  "[TRIGGER: initial_plan] Generate a training plan for this athlete."
);
console.log(`\n  Response: "${initialPlanResponse.slice(0, 200)}"`);

check(
  "Not [NO_REPLY]",
  !initialPlanResponse.includes("[NO_REPLY]")
);
check(
  "Response contains plan content (mentions days, miles, or sessions)",
  /thursday|saturday|sunday|mi|miles|easy|tempo|long run/i.test(initialPlanResponse)
);

// ---------------------------------------------------------------------------
// TEST 2f: user_message — outputs [NO_REPLY] for pure closing acknowledgment
// ---------------------------------------------------------------------------

section("2f. LLM user_message — outputs [NO_REPLY] for closing acknowledgment");

const closingAck = await ask(
  "user_message",
  "Perfect, thanks!"
);
console.log(`\n  Response: "${closingAck}"`);

check(
  "Outputs [NO_REPLY] for 'Perfect, thanks!'",
  closingAck.includes("[NO_REPLY]"),
  `Got: "${closingAck.slice(0, 100)}"`
);

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
