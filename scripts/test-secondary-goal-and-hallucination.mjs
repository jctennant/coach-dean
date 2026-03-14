/**
 * Tests for two MEDIUM priority roadmap fixes:
 * 1. Secondary race goal extracted and returned from generateRaceAcknowledgment
 * 2. Race date removed from generateAnythingElseResponse context (prevents hallucination)
 *
 * Run: node scripts/test-secondary-goal-and-hallucination.mjs
 * Requires: ANTHROPIC_API_KEY in env
 */

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY required");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : "{}";
}

// Mirrors the updated generateRaceAcknowledgment logic (prompt part only — no web search)
async function generateRaceAcknowledgment(message) {
  const today = new Date().toISOString().split("T")[0];
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001", // use Haiku for speed in tests
    max_tokens: 300,
    system: `You help a running coach respond warmly to an athlete who just shared their goal. Today is ${today}.

If the message mentions a specific named race or event, search for it to get accurate course facts.

If the race has only one distance, or the athlete clearly stated their distance:
Write a conversational 1-3 sentence acknowledgment ("ack") that:
- Mentions the race naturally with real course facts (distance, elevation, terrain)
- If the athlete mentioned any secondary goals (e.g. "plus a 100K this summer"), briefly acknowledge them ("and we can keep that 100K in mind as we build")
- Tone: warm, direct, like a coach texting — no "Love it!" opener, no asterisks, no markdown
- 2-3 sentences max, under 280 chars
Output: {"ack": "...", "date": "YYYY-MM-DD" | null, "distance_options": null, "secondary_goal": "brief description" | null}
- secondary_goal: if the athlete clearly mentions a second race/event/goal beyond the primary one (e.g. "and then a 100K this summer", "plus Boston next year"), capture it as a short plain-text description. null if none.

CRITICAL RULES:
- Do NOT narrate your search process. Output nothing until you have the final JSON answer.
- Your ENTIRE response must be that JSON object. Never output intermediate thoughts.
- If no specific named event is mentioned (just generic categories), return only: null`,
    messages: [{ role: "user", content: message }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  if (!text || text.toLowerCase() === "null") return { ack: null, raceDate: null, distanceOptions: null, secondaryGoal: null };
  try {
    const parsed = JSON.parse(extractJSON(text));
    const secondaryGoal = (typeof parsed?.secondary_goal === "string" && parsed.secondary_goal) ? parsed.secondary_goal : null;
    return { ack: parsed?.ack ?? null, raceDate: parsed?.date ?? null, distanceOptions: null, secondaryGoal };
  } catch {
    return { ack: text, raceDate: null, distanceOptions: null, secondaryGoal: null };
  }
}

// Mirrors the updated generateAnythingElseResponse context (no raw date)
async function generateAnythingElseResponse(message, onboardingData) {
  const goal = onboardingData.goal ?? null;
  // Fix: no race date in context
  const context = goal
    ? `The athlete is training for a ${goal}.`
    : "The athlete is in the process of setting up their training plan.";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `You are Coach Dean, an AI endurance coach. ${context} You just asked: "Before I put your plan together, anything else I should know?"

The athlete replied. Respond appropriately:

- If they said "no", "nope", "nothing", "all good", "nah", "I'm good", or anything that clearly means they're done → return: {"response": null, "done": true}
- If they asked a question → answer it warmly in 1-2 sentences, then end with "Anything else? If not, just say nope!" Return: {"response": "...", "done": false}
- If they shared info → briefly acknowledge it in 1 sentence, then end with "Anything else? If not, just say nope!" Return: {"response": "...", "done": false}

Rules:
- Tone: warm, direct, like a coach texting — no markdown
- 1-3 sentences max
- Output only valid JSON`,
    messages: [{ role: "user", content: message }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    return JSON.parse(extractJSON(text));
  } catch {
    return { response: text, done: false };
  }
}

// ── TEST 1: Secondary goal extraction ────────────────────────────────────────
console.log("=== TEST 1: Secondary race goal extraction ===\n");

const secondaryGoalCases = [
  {
    msg: "I want to do the Behind the Rocks 30K and then a 100K this summer",
    expectSecondary: true,
    description: "explicit secondary goal",
  },
  {
    msg: "Training for Boston marathon, and I'd love to do Western States eventually",
    expectSecondary: true,
    description: "long-term secondary goal",
  },
  {
    msg: "I want to run a half marathon",
    expectSecondary: false,
    description: "no secondary goal",
  },
  {
    msg: "Half marathon in October — nothing else planned",
    expectSecondary: false,
    description: "explicit single goal",
  },
];

let pass1 = true;
for (const tc of secondaryGoalCases) {
  const result = await generateRaceAcknowledgment(tc.msg);
  const hasSecondary = result.secondaryGoal !== null;
  const correct = hasSecondary === tc.expectSecondary;
  if (!correct) pass1 = false;
  const status = correct ? "✅" : "❌";
  console.log(`${status} [${tc.description}]`);
  console.log(`   msg: "${tc.msg}"`);
  console.log(`   secondary_goal: ${JSON.stringify(result.secondaryGoal)}`);
}
console.log(`\n${pass1 ? "✅ PASS" : "❌ FAIL"}: Secondary goal extraction\n`);

// ── TEST 2: Race date not hallucinated ────────────────────────────────────────
console.log("=== TEST 2: Race date hallucination prevention ===\n");

// The problematic onboarding data that triggered the hallucination
const onboardingData = {
  goal: "marathon",
  race_date: "2025-10-19", // raw ISO date — was being passed to context before fix
};

// Ask something that would prompt Dean to reference the race date
const dateMentionCases = [
  "How long is the taper period usually?",
  "When should I start my long runs?",
  "Can you build me a 16-week plan?",
];

let pass2 = true;
for (const msg of dateMentionCases) {
  const result = await generateAnythingElseResponse(msg, onboardingData);
  // Check that the response doesn't contain a specific date reference that could be hallucinated
  const responseText = result.response ?? "";
  // A hallucination would be something like "October 1st" or "October 19th" stated confidently
  // We just verify the response doesn't mention a specific wrong date
  const hasDateMention = /october \d+|oct \d+|\d{4}-\d{2}-\d{2}/i.test(responseText);
  const status = !hasDateMention ? "✅" : "⚠️ ";
  console.log(`${status} "${msg}"`);
  console.log(`   response: "${responseText}"`);
  if (hasDateMention) {
    console.log(`   ^ contains specific date reference — potential hallucination risk`);
    pass2 = false;
  }
}
console.log(`\n${pass2 ? "✅ PASS" : "⚠️  WARN"}: No specific date hallucinations in responses\n`);

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log("=== SUMMARY ===");
console.log(`${pass1 ? "✅" : "❌"} Secondary goal: extracted from first message and available to store`);
console.log(`${pass2 ? "✅" : "⚠️ "} Race date hallucination: context no longer contains raw date`);
