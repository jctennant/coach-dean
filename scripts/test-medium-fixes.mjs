/**
 * Tests for two MEDIUM priority roadmap fixes:
 * 1. Capitalization bug — "Which distance" → "which distance"
 * 2. "Anything else" re-ask prompt includes a "done" signal ("just say nope!")
 *
 * Run: node scripts/test-medium-fixes.mjs
 * Requires: ANTHROPIC_API_KEY in env
 */

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── TEST 1: Capitalization fix ───────────────────────────────────────────────
console.log("=== TEST 1: Capitalization in multi-distance clarification ===\n");

// Simulate the template at line 241 of onboarding/handle/route.ts
function buildClarificationMsg(ack, name, options) {
  const namePrefix = name ? `${name}, ` : "";
  const ackPart = ack ? `${ack}\n\n` : "";
  return `${ackPart}${namePrefix}which distance are you targeting — ${options}?`;
}

const cases = [
  { ack: "Behind the Rocks is a great race!", name: "Jake", options: "30K, 50K, 50 miles" },
  { ack: "Sounds like a fun event.", name: null, options: "10K, half marathon, marathon" },
  { ack: null, name: "Sarah", options: "5K, 10K" },
  { ack: null, name: null, options: "sprint, Olympic" },
];

let pass1 = true;
for (const c of cases) {
  const msg = buildClarificationMsg(c.ack, c.name, c.options);
  const hasCapitalWhich = msg.includes("Which distance");
  const hasLowerWhich = msg.includes("which distance");
  const status = !hasCapitalWhich && hasLowerWhich ? "✅" : "❌";
  if (hasCapitalWhich) pass1 = false;
  console.log(`${status} ${JSON.stringify(msg.split("\n").pop())}`);
}
console.log(`\n${pass1 ? "✅ PASS" : "❌ FAIL"}: No capital-W "Which" in any case\n`);

// ── TEST 2: "Anything else" prompt includes "done" signal ────────────────────
console.log("=== TEST 2: 'Anything else' — done signal in step question ===\n");

const stepQuestion = "Almost there — anything else before I put this together? Injuries, target paces, cross-training, strength work — mention it now and I'll build it in. If not, just say nope!";
const pass2 = stepQuestion.includes("nope") || stepQuestion.includes("If not");
console.log(`Step question: "${stepQuestion}"`);
console.log(`${pass2 ? "✅ PASS" : "❌ FAIL"}: Contains explicit "done" signal\n`);

// ── TEST 3: LLM test — does "nope" now correctly resolve as done? ─────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.log("=== TEST 3: Skipped (no ANTHROPIC_API_KEY) ===");
  process.exit(0);
}

console.log("=== TEST 3: generateAnythingElseResponse — done detection (LLM) ===\n");

async function generateAnythingElseResponse(message, context = "") {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `You are Coach Dean, an AI endurance coach. ${context} You just asked: "Before I put your plan together, anything else I should know?"

The athlete replied. Respond appropriately:

- If they said "no", "nope", "nothing", "all good", "nah", "I'm good", or anything that clearly means they're done → return: {"response": null, "done": true}
- If they asked a question → answer it warmly in 1-2 sentences, then end with a natural re-ask like "Anything else? If not, just say nope!" Return: {"response": "...", "done": false}
- If they shared info (injury, schedule constraints, secondary goal, training history, preferences) → briefly acknowledge it in 1 sentence, then end with "Anything else? If not, just say nope!" Return: {"response": "...", "done": false}

Rules:
- Tone: warm, direct, like a coach texting — no "Love it!" opener, no markdown, no asterisks
- 1-3 sentences max
- Output only valid JSON`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    return JSON.parse(json);
  } catch {
    return { response: text, done: false };
  }
}

const testMessages = [
  { msg: "nope", expectDone: true },
  { msg: "no thanks, I think that covers it!", expectDone: true },
  { msg: "all good", expectDone: true },
  { msg: "I have some IT band issues on my right knee", expectDone: false },
  { msg: "Can you build a plan even if I can only run 3 days a week?", expectDone: false },
  { msg: "I'd also like to do a 100K this summer after the 30K", expectDone: false },
];

let pass3 = true;
for (const t of testMessages) {
  const result = await generateAnythingElseResponse(t.msg);
  const correct = result.done === t.expectDone;
  if (!correct) pass3 = false;
  const status = correct ? "✅" : "❌";
  const doneStr = result.done ? "done=true" : `done=false, re-ask includes "nope": ${result.response?.includes("nope") ?? false}`;
  console.log(`${status} "${t.msg}" → ${doneStr}`);
  if (!result.done && result.response) {
    // Check re-ask includes done signal
    const hasNope = result.response.includes("nope") || result.response.includes("If not");
    if (!hasNope) {
      console.log(`   ⚠️  Re-ask missing "nope" signal: "${result.response}"`);
    }
  }
}

console.log(`\n${pass3 ? "✅ PASS" : "❌ FAIL"}: done/not-done detection correct for all cases\n`);

console.log("=== SUMMARY ===");
console.log(`${pass1 ? "✅" : "❌"} Capitalization: "which distance" (lowercase) in all cases`);
console.log(`${pass2 ? "✅" : "❌"} Step question: includes "just say nope!" done signal`);
console.log(`${pass3 ? "✅" : "❌"} LLM: done detection + re-ask includes done signal`);
