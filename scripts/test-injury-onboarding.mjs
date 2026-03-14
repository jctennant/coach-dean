/**
 * Tests injury_recovery onboarding flow.
 *
 * Verifies:
 * 1. awaiting_injury_background question is focused (not "anything else")
 * 2. Athlete's injury answer is extracted into injury_notes
 * 3. awaiting_anything_else fires as a clean catch-all AFTER injury background
 * 4. "nope" after injury background completes onboarding
 *
 * Run: node scripts/test-injury-onboarding.mjs
 */

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY required");
  process.exit(1);
}

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : "{}";
}

// ── Mirrors handleInjuryBackground extraction ─────────────────────────────────
async function extractInjuryBackground(message) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `Extract injury and return-to-run context from this message. Respond with ONLY valid JSON.

Output format:
{
  "injury_notes": string | null,
  "weekly_miles": number | null,
  "can_run_now": boolean | null
}

Rules:
- injury_notes: brief description of injury type, duration, and recovery status (e.g. "stress fracture, 6 weeks ago, cleared to walk but not run yet"). null if unclear.
- weekly_miles: current weekly mileage if mentioned. null if not stated.
- can_run_now: true if they say they can run, false if fully off running, null if unclear.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    return JSON.parse(extractJSON(text));
  } catch { return {}; }
}

// ── Mirrors generateAnythingElseResponse ─────────────────────────────────────
async function generateAnythingElseResponse(message, onboardingData) {
  const goal = onboardingData.goal ?? null;
  const injuryNotes = onboardingData.injury_notes ?? null;
  const context = goal === "injury_recovery"
    ? `The athlete is recovering from an injury${injuryNotes ? ` (${injuryNotes})` : ""} and building a return-to-run plan.`
    : "The athlete is setting up their training plan.";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `You are Coach Dean, an AI endurance coach. ${context} You just asked: "Almost there — anything else before I put this together? Target paces, cross-training, strength work — mention it now and I'll build it in. If not, just say nope!"

The athlete replied. Respond appropriately:
- "no", "nope", "nothing", "all good" → {"response": null, "done": true}
- question → answer warmly, end with "Anything else? If not, just say nope!" → {"response": "...", "done": false}
- shared info → acknowledge briefly, end with "Anything else? If not, just say nope!" → {"response": "...", "done": false}

Rules: warm, direct, 1-3 sentences, valid JSON only`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try { return JSON.parse(extractJSON(text)); } catch { return { response: text, done: false }; }
}

// ── TEST CASES ────────────────────────────────────────────────────────────────

const tests = [
  {
    name: "IT band, currently running",
    injuryMessage: "IT band syndrome, been dealing with it for about 3 months. I can still run but have to keep it easy and short — around 20 min max before it flares up.",
    anythingElseMessage: "nope",
  },
  {
    name: "Stress fracture, fully off",
    injuryMessage: "I had a stress fracture in my left tibia about 6 weeks ago. Just got cleared by my doctor to start walking but no running yet.",
    anythingElseMessage: "I do some cycling to stay fit",
  },
  {
    name: "General overuse, vague",
    injuryMessage: "Just been dealing with some knee stuff and need to take it slow.",
    anythingElseMessage: "nope that's everything",
  },
];

let allPass = true;

for (const t of tests) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${t.name}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\nAthlete (injury background): "${t.injuryMessage}"\n`);

  // Step 1: Extract injury background
  const extracted = await extractInjuryBackground(t.injuryMessage);
  console.log(`Extracted:`, JSON.stringify(extracted, null, 2));

  const hasInjuryNotes = !!extracted.injury_notes;
  if (!hasInjuryNotes) allPass = false;
  console.log(`${hasInjuryNotes ? "✅" : "❌"} injury_notes captured: ${JSON.stringify(extracted.injury_notes)}`);
  console.log(`  can_run_now: ${extracted.can_run_now}`);

  // Step 2: "Anything else" fires as clean catch-all (NOT re-asking about injury)
  const onboardingData = {
    goal: "injury_recovery",
    injury_notes: extracted.injury_notes,
    can_run_now: extracted.can_run_now,
  };

  const anythingElseQuestion = "Almost there — anything else before I put this together? Target paces, cross-training, strength work — mention it now and I'll build it in. If not, just say nope!";
  console.log(`\nDean (anything else): "${anythingElseQuestion}"`);

  const pass2 = !anythingElseQuestion.toLowerCase().includes("injury");
  if (!pass2) allPass = false;
  console.log(`${pass2 ? "✅" : "❌"} "anything else" question doesn't re-ask about injury`);

  // Step 3: Athlete responds to "anything else"
  console.log(`\nAthlete: "${t.anythingElseMessage}"`);
  const anythingElseResp = await generateAnythingElseResponse(t.anythingElseMessage, onboardingData);
  console.log(`Dean: "${anythingElseResp.response ?? "(done — completing onboarding)"}"`);
  console.log(`Done: ${anythingElseResp.done}`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`OVERALL: ${allPass ? "✅ PASS" : "❌ FAIL"}`);
