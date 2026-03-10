/**
 * Test plan session extraction and mid-week update logic.
 * Run with: ANTHROPIC_API_KEY=... node scripts/test-plan-sessions.mjs
 *
 * Tests two functions (inlined from route.ts):
 *   extractAndStorePlanSessions — parses a weekly plan message into structured sessions
 *   maybeUpdatePlanSessions     — detects mid-week changes from user_message exchanges
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Inlined from route.ts
// ---------------------------------------------------------------------------

async function extractPlanSessions(planText) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: `Extract the list of planned training sessions from this coaching message.
Return ONLY valid JSON array, nothing else.
Each session object: {"day": "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun", "date": "M/D" (e.g. "3/10"), "label": "the full session description as written"}
Example: [{"day":"Tue","date":"3/10","label":"Easy 6.5 km"},{"day":"Thu","date":"3/12","label":"Easy 6.5 km"},{"day":"Sat","date":"3/14","label":"Easy 8 km"}]
If no session list is found, return [].`,
    messages: [{ role: "user", content: planText }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
  try {
    const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function checkPlanUpdate(currentSessions, userMessage, coachResponse) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: `You are checking whether a conversation exchange changed any planned training sessions for the week.

Current planned sessions (JSON):
${JSON.stringify(currentSessions)}

The athlete sent a message and the coach responded. Determine if any sessions were changed (different day, different distance, cancelled, added, or replaced).

If NO changes were made, return exactly: {"changed": false}
If changes WERE made, return the full updated sessions list reflecting the agreed changes:
{"changed": true, "sessions": [{"day": "Mon"|"Tue"|..., "date": "M/D", "label": "..."}]}

Rules:
- Only mark changed=true if the coach explicitly agreed to a change
- Preserve all unchanged sessions exactly as-is
- If a session was cancelled with no replacement, omit it from the list
- Return ONLY valid JSON, no other text`,
    messages: [{ role: "user", content: `Athlete: ${userMessage}\n\nCoach: ${coachResponse}` }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    return { changed: false };
  }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// The plan Isaac received (Isaac's real scenario)
const ISAAC_PLAN = `Last week you banked 14.3 km on Sunday — solid reset run despite the soreness. This week we're keeping volume steady at ~24 km to let those running-specific muscles adapt while your skiing and skating fitness carries you. Base building, no rush.

Tue 3/10 · Easy 6.5 km
Thu 3/12 · Easy 6.5 km
Sat 3/14 · Easy 8 km
Mon 3/9 · Strength + mobility 20 min

Keep them all conversational. If the legs still feel heavy Tuesday, text me and we'll adjust Thursday.`;

// A typical initial plan with paces
const IMPERIAL_PLAN = `Looking at your Strava, you've been hitting 35 miles/week with some efforts down to 7:45/mi — solid base. Starting conservative this week given the hip, easier to add than walk back a flare-up.

Mon 3/9 · Easy 5 mi @ easy effort
Wed 3/11 · Easy 6 mi
Sat 3/14 · Long run 8 mi easy
Sun 3/15 · Strength + mobility 30 min

How does this look? Happy to adjust anything. I can also shoot you a reminder the morning of each session — just let me know.`;

// A multi-week plan (should only extract this week's sessions)
const MULTI_WEEK_PLAN = `Good week! 28 miles with your long run feeling controlled — exactly the kind of build we want.

This week stepping up to 32 miles:
Mon 3/9 · Rest
Tue 3/10 · Easy 6 mi
Wed 3/11 · Tempo 5 mi (3 mi @ 8:00/mi)
Thu 3/12 · Easy 5 mi
Sat 3/14 · Long run 10 mi
Sun 3/15 · Easy 6 mi`;

const STORED_SESSIONS = [
  { day: "Tue", date: "3/10", label: "Easy 6.5 km" },
  { day: "Thu", date: "3/12", label: "Easy 6.5 km" },
  { day: "Sat", date: "3/14", label: "Easy 8 km" },
  { day: "Mon", date: "3/9", label: "Strength + mobility 20 min" },
];

const UPDATE_CASES = [
  // ── Changes Dean agrees to ──────────────────────────────────────────────
  {
    label: "Long run day swap + distance bump",
    user: "Can we move the long run to Sunday and bump it to 10 mi? Saturday doesn't work for me this week.",
    coach: "Absolutely — let's move it. Dropping Saturday and adding Sun 3/15 · Long run 10 mi. Rest of the week stays the same.",
    expectChanged: true,
    expectSaturday: false,
    expectSunday: true,
  },
  {
    label: "Distance reduction on one session",
    user: "I want to do my long run Sunday instead, let's do 10 mi instead of 8",
    coach: "Done — I'll swap Saturday's 8 km to Sunday 3/15 · Long run 10 mi. Thursday and Tuesday stay as planned.",
    expectChanged: true,
    expectSaturday: false,
    expectSunday: true,
  },
  {
    label: "Cancel a session",
    user: "Something came up Thursday — can we skip it this week?",
    coach: "No problem, just skip Thursday. Tuesday and Saturday are still on — you'll still get a solid week.",
    expectChanged: true,
    expectThursday: false,
  },
  {
    label: "Shorten a session",
    user: "Can we cut Saturday down to 5 km? I'm feeling a bit run down.",
    coach: "Totally — let's keep Saturday easy and short. Changed to Easy 5 km. Listen to your body.",
    expectChanged: true,
  },

  // ── No changes ──────────────────────────────────────────────────────────
  {
    label: "Normal check-in (no plan change)",
    user: "Legs feeling good. Thanks.",
    coach: "Perfect — you're all set for the week. Enjoy the easy runs and let those legs recover.",
    expectChanged: false,
  },
  {
    label: "Question about upcoming run (no change)",
    user: "What pace should I run Thursday at?",
    coach: "Keep Thursday fully conversational — something like 6:00-6:30/km. No pressure, just easy.",
    expectChanged: false,
  },
  {
    label: "Asking about the plan without changing it",
    user: "Can you remind me what's on for this week?",
    coach: "This week: Tue Easy 6.5 km, Thu Easy 6.5 km, Sat Easy 8 km, Mon strength. All easy — just build the base.",
    expectChanged: false,
  },
  {
    label: "Coach suggests but athlete doesn't confirm",
    user: "My legs are a bit sore",
    coach: "Totally normal after a big Sunday. If Tuesday feels rough, you could shorten it to 4 km — but see how the warmup goes first.",
    expectChanged: false,
  },
];

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(label) { return `  ✓ ${label}`; }
function fail(label, detail) { return `  ✗ ${label}\n    ${detail}`; }

// ── Part 1: Session extraction ───────────────────────────────────────────────
console.log("\n" + "=".repeat(65));
console.log("PART 1: Plan session extraction");
console.log("=".repeat(65));

const extractCases = [
  { label: "Isaac's metric plan (km)", plan: ISAAC_PLAN, minSessions: 3 },
  { label: "Imperial plan with paces", plan: IMPERIAL_PLAN, minSessions: 3 },
  { label: "Full week plan", plan: MULTI_WEEK_PLAN, minSessions: 4 },
];

for (const tc of extractCases) {
  process.stdout.write(`\n  ${tc.label}\n`);
  const sessions = await extractPlanSessions(tc.plan);
  if (sessions.length >= tc.minSessions) {
    passed++;
    console.log(pass(`Extracted ${sessions.length} sessions:`));
    for (const s of sessions) {
      console.log(`    ${s.day} ${s.date} · ${s.label}`);
    }
  } else {
    failed++;
    console.log(fail(`Only extracted ${sessions.length} sessions (expected ≥${tc.minSessions})`, JSON.stringify(sessions)));
  }
}

// ── Part 2: Mid-week update detection ───────────────────────────────────────
console.log("\n" + "=".repeat(65));
console.log("PART 2: Mid-week plan change detection");
console.log("=".repeat(65));
console.log(`\n  Current stored sessions: ${STORED_SESSIONS.map(s => `${s.day} ${s.date} · ${s.label}`).join(" | ")}`);

// Run all update cases in parallel
const updateResults = await Promise.all(
  UPDATE_CASES.map(async (tc) => {
    const result = await checkPlanUpdate(STORED_SESSIONS, tc.user, tc.coach);
    return { tc, result };
  })
);

for (const { tc, result } of updateResults) {
  process.stdout.write(`\n  "${tc.user.slice(0, 60)}${tc.user.length > 60 ? "…" : ""}"\n`);
  process.stdout.write(`  [${tc.label}]\n`);

  const gotChanged = result.changed === true;
  const expectedChanged = tc.expectChanged;

  if (gotChanged !== expectedChanged) {
    failed++;
    console.log(fail(`changed=${gotChanged} but expected changed=${expectedChanged}`, `Result: ${JSON.stringify(result)}`));
    continue;
  }

  if (!gotChanged) {
    passed++;
    console.log(pass("Correctly detected no change"));
    continue;
  }

  // Verify the updated session list looks sensible
  const sessions = result.sessions ?? [];
  let sessionOk = sessions.length > 0;

  if (tc.expectSaturday === false) {
    const hasSat = sessions.some(s => s.day === "Sat");
    if (hasSat) { sessionOk = false; }
  }
  if (tc.expectSunday === true) {
    const hasSun = sessions.some(s => s.day === "Sun");
    if (!hasSun) { sessionOk = false; }
  }
  if (tc.expectThursday === false) {
    const hasThu = sessions.some(s => s.day === "Thu");
    if (hasThu) { sessionOk = false; }
  }

  if (sessionOk) {
    passed++;
    console.log(pass(`Changed=true, updated sessions:`));
    for (const s of sessions) {
      console.log(`    ${s.day} ${s.date} · ${s.label}`);
    }
  } else {
    failed++;
    console.log(fail("Session list didn't match expectations", JSON.stringify(sessions)));
  }
}

console.log(`\n${"=".repeat(65)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(65) + "\n");
