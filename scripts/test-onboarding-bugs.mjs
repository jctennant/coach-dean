/**
 * Tests for 4 onboarding bug fixes:
 *   Bug 1: Questions in first message should be answered
 *   Bug 2: Intro included when name is known but intro_sent not set
 *   Bug 3: Name extraction (existingName falls back to user.name)
 *   Bug 4: Named races → complete: true; multi-distance → ask for clarification
 *
 * Run with: ANTHROPIC_API_KEY=... node scripts/test-onboarding-bugs.mjs
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Inlined classifier prompt (mirrors onboarding/handle/route.ts)
// ---------------------------------------------------------------------------

const GOAL_CLASSIFIER_SYSTEM = `Classify whether the user's message contains a clear fitness or endurance goal. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "no_event": true|false, "goal": "5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"100k"|"sprint_tri"|"olympic_tri"|"70.3"|"ironman"|"cycling"|"general_fitness"|"injury_recovery"|null}

Rules:
- complete: true only if a clear training goal is identifiable
- no_event: true if the athlete explicitly says they have no race or event planned right now ("nothing on the calendar", "no race yet", "not signed up for anything", "no events planned") — regardless of whether complete is true or false
- Pure greetings with no goal context → complete: false, no_event: false, goal: null
- Named specific race or event (e.g. "Behind the Rocks trail race", "Wasatch 100", "Boston Marathon", "local 5K next spring") → complete: true. Use any explicit distance cues in the message: "Wasatch 100" → "100k"; "Boston Marathon" → "marathon"; "local half" → "half_marathon". If the name contains no distance info (e.g. just "Behind the Rocks trail race"), use "50k" as a placeholder — the web search step will clarify if needed.
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
- When complete is false, goal must be null`;

async function classifyGoal(message) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 128,
    system: GOAL_CLASSIFIER_SYSTEM,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "{}";
  try {
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    return { complete: false, no_event: false, goal: null };
  }
}

// ---------------------------------------------------------------------------
// generateRaceAcknowledgment (with web search + distance_options)
// ---------------------------------------------------------------------------

async function generateRaceAcknowledgment(message) {
  const today = new Date().toISOString().split("T")[0];
  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 400,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: `You help a running coach respond warmly to an athlete who just shared their goal. Today is ${today}.

If the message mentions a specific named race or event, search for it to get accurate course facts.

IMPORTANT — Multi-distance races:
If the race offers multiple distance options (e.g. 10K, 30K, 50K, 50 miles) AND the athlete hasn't specified which distance they're doing, do NOT guess. Instead output:
{"ack": "<1-2 sentence acknowledgment of the race without assuming distance>", "date": "YYYY-MM-DD" | null, "distance_options": ["10K", "30K", "50K", "50 miles"]}
The "ack" in this case should mention the race name and terrain/character but NOT a specific distance.

If the race has only one distance, or the athlete clearly stated their distance:
Write a conversational 1-3 sentence acknowledgment ("ack") that:
- Mentions the race naturally with real course facts (distance, elevation, terrain) — not like a Wikipedia entry, more like "Behind the Rocks looks like a great one — 18 miles of slickrock with ~1,800ft of climbing"
- If the race is within 8 weeks of today, acknowledge the timeline naturally ("not a ton of runway, but totally doable" / "only X weeks out, so we'll keep it focused")
- If the athlete mentioned any secondary goals (e.g. "plus a 100K this summer"), briefly acknowledge them ("and we can keep that 100K in mind as we build")
- Tone: warm, direct, like a coach texting — no "Love it!" opener, no asterisks, no markdown
- 2-3 sentences max, under 280 chars
Output: {"ack": "...", "date": "YYYY-MM-DD" | null, "distance_options": null}

CRITICAL RULES:
- Do NOT narrate your search process. Output nothing until you have the final JSON answer.
- Your ENTIRE response must be that JSON object (or the word null). Never output intermediate thoughts.
- If results are ambiguous or conflicting, set "ack" to null.
- Only include "date" if you find a specific confirmed upcoming date — do not guess.
- If no specific named event is mentioned (just generic categories), return only: null`,
    messages: [{ role: "user", content: message }],
  });

  const textBlocks = response.content.filter(b => b.type === "text");
  const lastBlock = textBlocks[textBlocks.length - 1];
  const text = lastBlock?.type === "text" ? lastBlock.text.trim() : "";
  if (!text || text.toLowerCase() === "null") return { ack: null, raceDate: null, distanceOptions: null };
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    const distanceOptions = Array.isArray(parsed?.distance_options) && parsed.distance_options.length > 1
      ? parsed.distance_options
      : null;
    return { ack: parsed?.ack ?? null, raceDate: parsed?.date ?? null, distanceOptions };
  } catch {
    return { ack: text, raceDate: null, distanceOptions: null };
  }
}

// ---------------------------------------------------------------------------
// detectAndAnswerImmediate
// ---------------------------------------------------------------------------

async function detectAndAnswerImmediate(message, goal) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 250,
    system: `You are Coach Dean, a friendly AI endurance coach. A new athlete training for a ${goal} just sent their first message. It may contain immediate coaching questions alongside background info about themselves.

If the message contains a genuine immediate question (race prep, pacing advice, route suggestions, race-day tactics, etc.):
- Answer it briefly and helpfully in 2-3 sentences. Be specific and practical.
- Plain text only — no markdown, no bullet points, no asterisks.
- Return only your answer.

If there is no immediate question — just goal-setting or background info — return only: {"no_question": true}`,
    messages: [{ role: "user", content: message }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  // Only attempt JSON parse if the response actually contains a JSON object.
  // (Fallback to "{}" would parse fine and incorrectly fall through to return null.)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.no_question === true) return null;
    } catch {
      // malformed JSON — fall through
    }
  }
  // Either no JSON in response, or JSON wasn't {no_question: true} — it's an answer
  if (text.length > 10) return text;
  return null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function pass(label) { console.log(`  ✓ ${label}`); }
function fail(label) { console.log(`  ✗ ${label}`); }
function info(label) { console.log(`  ℹ ${label}`); }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testBug4Classifier() {
  console.log("\n=== BUG 4: Goal classifier — named races ===\n");

  const cases = [
    {
      msg: "I'm training for the Behind the Rocks trail race",
      expectComplete: true,
      label: "Named race, no explicit distance → complete: true",
    },
    {
      msg: "I want to do the Wasatch 100 this fall",
      expectComplete: true,
      expectGoal: "100k",
      label: "Wasatch 100 → goal: 100k",
    },
    {
      msg: "Training for Boston Marathon",
      expectComplete: true,
      expectGoal: "marathon",
      label: "Boston Marathon → goal: marathon",
    },
    {
      msg: "Hey there",
      expectComplete: false,
      label: "Pure greeting → complete: false",
    },
    {
      msg: "I want to run a local 5K next spring",
      expectComplete: true,
      expectGoal: "5k",
      label: "Local 5K → complete: true, goal: 5k",
    },
  ];

  for (const c of cases) {
    const result = await classifyGoal(c.msg);
    const completeOk = result.complete === c.expectComplete;
    const goalOk = !c.expectGoal || result.goal === c.expectGoal;

    if (completeOk && goalOk) {
      pass(`${c.label} → complete:${result.complete}, goal:${result.goal}`);
    } else {
      fail(`${c.label} → got complete:${result.complete}, goal:${result.goal} (expected complete:${c.expectComplete}${c.expectGoal ? `, goal:${c.expectGoal}` : ""})`);
    }
  }
}

async function testBug4MultiDistance() {
  console.log("\n=== BUG 4: Multi-distance race detection (web search) ===\n");

  console.log("Testing: 'I want to do the Behind the Rocks trail race'");
  const result = await generateRaceAcknowledgment("I want to do the Behind the Rocks trail race");
  info(`ack: ${result.ack}`);
  info(`raceDate: ${result.raceDate}`);
  info(`distanceOptions: ${JSON.stringify(result.distanceOptions)}`);

  if (result.distanceOptions && result.distanceOptions.length > 1) {
    pass("Returned multiple distance options — will ask athlete to clarify");
    pass(`Options: ${result.distanceOptions.join(", ")}`);
  } else if (result.ack) {
    fail("Did NOT return distance_options — assumed a specific distance");
    info("(This may be OK if web search couldn't confirm multiple distances)");
  } else {
    fail("No ack and no distance_options — web search may have failed");
  }

  console.log("\nTesting: 'I want to do the Boston Marathon' (single distance)");
  const bostonResult = await generateRaceAcknowledgment("I want to do the Boston Marathon");
  info(`ack: ${bostonResult.ack}`);
  info(`distanceOptions: ${JSON.stringify(bostonResult.distanceOptions)}`);

  if (!bostonResult.distanceOptions) {
    pass("Single-distance race — no clarification needed, ack returned directly");
  } else {
    fail("Boston Marathon incorrectly flagged as multi-distance");
  }
}

async function testBug1QuestionAnswering() {
  console.log("\n=== BUG 1: Questions in first message answered ===\n");

  const cases = [
    {
      msg: "I'm training for a marathon in October — how many days a week should I be running?",
      expectAnswer: true,
      label: "Coaching question (training frequency) in goal message",
    },
    {
      msg: "Hi I'm Jake, I want to train for a marathon",
      expectAnswer: false,
      label: "Goal statement only, no question → no immediate answer",
    },
    {
      msg: "I want to run a 5K — what's a good easy pace to train at?",
      expectAnswer: true,
      label: "Pacing question alongside goal",
    },
  ];

  for (const c of cases) {
    const answer = await detectAndAnswerImmediate(c.msg, "general fitness");
    const gotAnswer = !!answer;
    if (gotAnswer === c.expectAnswer) {
      if (c.expectAnswer) {
        pass(`${c.label}\n    → Answer: "${answer?.slice(0, 100)}..."`);
      } else {
        pass(`${c.label} → correctly returned null`);
      }
    } else {
      fail(`${c.label} → got answer:${gotAnswer}, expected:${c.expectAnswer}`);
      if (answer) info(`  Answer: "${answer?.slice(0, 120)}"`);
    }
  }
}

function testBug2IntroLogic() {
  console.log("\n=== BUG 2: Intro logic (intro_sent flag) ===\n");

  // Simulate the conditions in handleGoal
  function getResponseType(onboardingData, nameFromMessage, userDotName) {
    const existingName = (onboardingData.name ?? null) ?? (userDotName ?? null);
    const name = nameFromMessage || existingName;
    const introAlreadySent = !!onboardingData.intro_sent;

    if (!introAlreadySent) {
      return name ? "intro_with_name" : "intro_no_name";
    } else if (name) {
      return "ask_goal_with_name";
    } else {
      return "ask_for_name";
    }
  }

  const cases = [
    {
      onboardingData: { intro_sent: true },
      nameFromMessage: "Jake",
      userDotName: null,
      expected: "ask_goal_with_name",
      label: "Normal signup flow — intro_sent=true, name in message → skip intro",
    },
    {
      onboardingData: {},
      nameFromMessage: "Jake",
      userDotName: null,
      expected: "intro_with_name",
      label: "No intro_sent flag (testing/direct text) + name known → include intro",
    },
    {
      onboardingData: {},
      nameFromMessage: null,
      userDotName: null,
      expected: "intro_no_name",
      label: "No intro_sent, no name → full intro asking for name",
    },
    {
      onboardingData: { intro_sent: true },
      nameFromMessage: null,
      userDotName: "Jake",
      expected: "ask_goal_with_name",
      label: "intro_sent=true, name from user.name (Bug 3 fix) → skip intro",
    },
    {
      onboardingData: { intro_sent: true },
      nameFromMessage: null,
      userDotName: null,
      expected: "ask_for_name",
      label: "intro_sent=true, no name anywhere → ask for name",
    },
  ];

  for (const c of cases) {
    const result = getResponseType(c.onboardingData, c.nameFromMessage, c.userDotName);
    if (result === c.expected) {
      pass(`${c.label} → ${result}`);
    } else {
      fail(`${c.label} → got "${result}", expected "${c.expected}"`);
    }
  }
}

function testBug3NameFallback() {
  console.log("\n=== BUG 3: existingName falls back to user.name ===\n");

  // Simulate the existingName logic
  function getExistingName(onboardingData, userDotName) {
    return (onboardingData.name ?? null) ?? (userDotName ?? null);
  }

  const cases = [
    {
      onboardingData: { name: "Jake" },
      userDotName: null,
      expected: "Jake",
      label: "Name in onboarding_data → used",
    },
    {
      onboardingData: {},
      userDotName: "Jake",
      expected: "Jake",
      label: "Name only in user.name → falls back correctly (Bug 3 fix)",
    },
    {
      onboardingData: { name: "Jake" },
      userDotName: "JakeDifferent",
      expected: "Jake",
      label: "onboarding_data.name takes precedence over user.name",
    },
    {
      onboardingData: {},
      userDotName: null,
      expected: null,
      label: "No name anywhere → null",
    },
  ];

  for (const c of cases) {
    const result = getExistingName(c.onboardingData, c.userDotName);
    if (result === c.expected) {
      pass(`${c.label} → "${result}"`);
    } else {
      fail(`${c.label} → got "${result}", expected "${c.expected}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("Onboarding Bug Fix Tests");
  console.log("=".repeat(60));

  // Pure logic tests (no API)
  testBug3NameFallback();
  testBug2IntroLogic();

  // API tests
  await testBug1QuestionAnswering();
  await testBug4Classifier();
  await testBug4MultiDistance();

  console.log("\n" + "=".repeat(60) + "\n");
}

main().catch(console.error);
