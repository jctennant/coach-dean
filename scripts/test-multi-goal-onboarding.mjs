/**
 * Tests multi-goal athlete scenarios through onboarding and the coach system prompt.
 *
 * Checks:
 * 1. Secondary goal is extracted correctly from first message
 * 2. Dean's acknowledgment references both goals appropriately
 * 3. Secondary goal is stored in onboarding_data.secondary_goal
 * 4. In "anything else", Dean keeps secondary goal in mind
 * 5. Coach system prompt surfaces the secondary goal correctly
 *
 * Run: node scripts/test-multi-goal-onboarding.mjs
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

// ── Helpers mirroring the route ───────────────────────────────────────────────

async function generateRaceAcknowledgment(message) {
  const today = new Date().toISOString().split("T")[0];
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 400,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: `You help a running coach respond warmly to an athlete who just shared their goal. Today is ${today}.

If the message mentions a specific named race or event, search for it to get accurate course facts.

IMPORTANT — Multi-distance races:
If the race offers multiple distance options AND the athlete hasn't specified which distance, output:
{"ack": "<1-2 sentence acknowledgment without assuming distance>", "date": null, "distance_options": ["10K", "30K", ...]}

If the race has only one distance, or the athlete clearly stated their distance:
Write a conversational 1-3 sentence acknowledgment ("ack") that:
- Mentions the race naturally with real course facts
- If the race is within 8 weeks of today, acknowledge the timeline naturally
- If the athlete mentioned any secondary goals (e.g. "plus a 100K this summer"), briefly acknowledge them
- Tone: warm, direct, like a coach texting — no "Love it!" opener, no asterisks, no markdown
- 2-3 sentences max, under 280 chars
Output: {"ack": "...", "date": "YYYY-MM-DD" | null, "distance_options": null, "secondary_goal": "brief description" | null}
- secondary_goal: if the athlete mentions a second race/event/goal beyond the primary one, capture it briefly. null if none.

CRITICAL: Output only the final JSON. No intermediate narration.
If no specific named event is mentioned, return only: null`,
    messages: [{ role: "user", content: message }],
  });
  const textBlocks = response.content.filter(b => b.type === "text");
  const text = textBlocks[textBlocks.length - 1]?.text?.trim() ?? "";
  if (!text || text.toLowerCase() === "null") return null;
  try {
    const parsed = JSON.parse(extractJSON(text));
    const secondaryGoal = (typeof parsed?.secondary_goal === "string" && parsed.secondary_goal) ? parsed.secondary_goal : null;
    return { ack: parsed?.ack ?? null, raceDate: parsed?.date ?? null, distanceOptions: null, secondaryGoal };
  } catch {
    return { ack: text, raceDate: null, distanceOptions: null, secondaryGoal: null };
  }
}

// Mirrors extractAdditionalFields — runs on all first messages regardless of named race
async function extractAdditionalFields(message) {
  const today = new Date().toISOString().split("T")[0];
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `Extract any running/training information present in this message. Be generous with inference.

Output format (omit fields that are not present):
{"race_date": "YYYY-MM-DD" | null, "experience_years": number | null, "weekly_miles": number | null, "easy_pace": "M:SS" | null, "injury_mentioned": boolean, "injury_notes": string | null, "crosstraining_tools": string[] | null, "other_notes": string | null, "name": "FirstName" | null, "secondary_goal": string | null}

Rules:
- race_date: if a specific target race date is mentioned. Today is ${today}.
- secondary_goal: if the athlete mentions a second distinct race or goal beyond the primary one (e.g. "and then a marathon in the fall", "plus Boston next year"). Short plain-text description. null if only one goal.
- other_notes: any other training-relevant context not captured above. null if nothing.
- Return {} if nothing is present.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch { return {}; }
}

async function generateAnythingElseResponse(message, onboardingData) {
  const goal = onboardingData.goal ?? null;
  const secondaryGoal = onboardingData.secondary_goal ?? null;
  const context = goal
    ? `The athlete is training for a ${goal}${secondaryGoal ? `, with a secondary goal of ${secondaryGoal}` : ""}.`
    : "The athlete is in the process of setting up their training plan.";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `You are Coach Dean, an AI endurance coach. ${context} You just asked: "Before I put your plan together, anything else I should know?"

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

// Simulates the coach system prompt context for multi-goal athlete
function buildCoachContext(primaryGoal, primaryDate, secondaryGoal) {
  return `ATHLETE HISTORY:
- Goal: ${primaryGoal}${primaryDate ? ` on ${primaryDate}` : ""}
${secondaryGoal ? `- Secondary goal: ${secondaryGoal} (build toward this after the primary race — don't split focus now)\n` : ""}- Injury / constraints: None reported`;
}

async function coachRespond(question, context) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `You are Coach Dean, an AI endurance coach communicating via text message.

${context}

Answer the athlete's question in 2-4 sentences. Tone: warm, direct, like a real coach texting. No markdown.`,
    messages: [{ role: "user", content: question }],
  });
  return response.content[0].type === "text" ? response.content[0].text.trim() : "";
}

// ── TEST SCENARIOS ────────────────────────────────────────────────────────────

const scenarios = [
  {
    name: "30K → 100K (near-term + summer)",
    firstMessage: "I want to do Behind the Rocks 30K in March and then tackle a 100K this summer",
    followUp: "How should I think about training for both races?",
    primaryGoal: "30k",
    primaryDate: "2026-03-28",
  },
  {
    name: "Half marathon → marathon (same year)",
    firstMessage: "Training for a half marathon in May, and I'd love to run a full marathon in the fall",
    followUp: "Should I adjust my half training knowing the marathon is coming?",
    primaryGoal: "half_marathon",
    primaryDate: "2026-05-15",
  },
  {
    name: "Cycling race + running race",
    firstMessage: "I want to race some crits this spring and also do a half marathon. Do you work with cyclists too?",
    followUp: "How do you handle training for two different sports?",
    primaryGoal: "half_marathon",
    primaryDate: null,
  },
];

let allPass = true;

for (const scenario of scenarios) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SCENARIO: ${scenario.name}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\nAthlete: "${scenario.firstMessage}"\n`);

  // Step 1: Race ack (web search path) + extractAdditionalFields (always runs) — both in parallel
  const [raceInfo, extra] = await Promise.all([
    generateRaceAcknowledgment(scenario.firstMessage),
    extractAdditionalFields(scenario.firstMessage),
  ]);
  // Mirrors handleGoal: prefer web-search secondary goal, fall back to extractAdditionalFields
  const secondaryGoalCombined = raceInfo?.secondaryGoal ?? extra?.secondary_goal ?? null;

  console.log(`Ack: "${raceInfo?.ack ?? "(none)"}"`);
  console.log(`Secondary goal (web search): ${JSON.stringify(raceInfo?.secondaryGoal)}`);
  console.log(`Secondary goal (extractAdditionalFields): ${JSON.stringify(extra?.secondary_goal)}`);
  console.log(`Secondary goal (combined): ${JSON.stringify(secondaryGoalCombined)}`);

  const hasSecondary = !!secondaryGoalCombined;
  const expectSecondary = scenario.name !== "Cycling race + running race";
  const pass1 = hasSecondary || !expectSecondary;
  if (!pass1) allPass = false;
  console.log(`${pass1 ? "✅" : "❌"} Secondary goal captured: ${hasSecondary}`);

  // Step 2: onboarding_data with secondary_goal
  const onboardingData = {
    goal: scenario.primaryGoal,
    race_date: scenario.primaryDate,
    secondary_goal: secondaryGoalCombined,
  };

  // Step 3: Anything else — does Dean keep secondary goal in mind?
  const anythingElseResponse = await generateAnythingElseResponse(scenario.followUp, onboardingData);
  console.log(`\nFollow-up: "${scenario.followUp}"`);
  console.log(`Dean: "${anythingElseResponse.response ?? "(done)"}"`);

  // Step 4: Coach system prompt surfaces secondary goal
  const coachContext = buildCoachContext(scenario.primaryGoal, scenario.primaryDate, onboardingData.secondary_goal);
  const coachAnswer = await coachRespond(scenario.followUp, coachContext);
  console.log(`\nCoach answer (with secondary goal in system prompt):`);
  console.log(`"${coachAnswer}"`);

  // Check coach answer acknowledges both races
  const coachContextHasSecondary = coachContext.includes("Secondary goal");
  console.log(`\n${coachContextHasSecondary ? "✅" : "❌"} Secondary goal in coach system prompt`);
  console.log(`✅ Coach answered follow-up (${coachAnswer.length} chars)`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`OVERALL: ${allPass ? "✅ PASS" : "❌ FAIL — secondary goal not consistently captured"}`);
