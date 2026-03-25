/**
 * Test maybeUpdateTrainingPlanWeeks extraction logic.
 * Run with: ANTHROPIC_API_KEY=... node scripts/test-plan-week-adjustment.mjs
 *
 * Tests the Haiku extraction that detects when Dean committed to modifying
 * an upcoming training plan week (illness, injury, travel, priority change).
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Inlined from route.ts
// ---------------------------------------------------------------------------

const SAMPLE_WEEKS = [
  { week_number: 4, phase: "base", mileage_target: 28, long_run_target: 10, key_workout: "Easy 6 mi @ conversational pace", notes: "Keep effort low, just building aerobic base." },
  { week_number: 5, phase: "base", mileage_target: 32, long_run_target: 12, key_workout: "Tempo 5 mi (3 mi @ threshold)", notes: "First quality session of the block." },
  { week_number: 6, phase: "build", mileage_target: 35, long_run_target: 13, key_workout: "4x1 mi @ 5K effort w/ 2 min rest", notes: "First interval session. Start conservatively." },
];

async function checkPlanWeekUpdate(allWeeks, userMessage, coachResponse) {
  const upcomingWeeks = allWeeks.slice(0, 8);

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `You are checking whether a coaching exchange committed to changing an upcoming training plan week.

Upcoming plan weeks (JSON):
${JSON.stringify(upcomingWeeks)}

If the coach did NOT explicitly commit to changing a plan week, return: {"changed": false}
If the coach DID commit (e.g. said "I've updated week X", "I've adjusted next week", "dropping week X to...", "I'll make it a recovery week"), return:
{"changed": true, "weeks": [{"week_number": N, "mileage_target": X, "key_workout": "...", "notes": "..."}]}

Rules:
- Only return changed=true if the coach explicitly stated it is making a plan change — not just giving advice
- week_number must match an existing week in the list above
- For a recovery/rest week: mileage_target should be ~30% of the original, key_workout "Easy recovery — no quality work"
- Only include fields that are actually changing; always include week_number
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

const CASES = [
  // ── Should trigger a plan change ─────────────────────────────────────────
  {
    label: "Full illness — recovery week",
    user: "I've been sick all week with a fever. Can't really run.",
    coach: "Take it easy — I've updated week 5 on your dashboard. Dropping it to a recovery week, around 10 miles of easy running only. No tempo. Just get better.",
    expectChanged: true,
    expectWeek: 5,
    expectMileageLow: true, // should be lower than original 32
  },
  {
    label: "Travel — drop mileage and remove quality",
    user: "I'm traveling for work next week, going to be hard to get long runs in.",
    coach: "No problem — I've adjusted week 5 for travel. Dropping it to 18 miles with easy short runs only, removing the tempo. Just stay consistent where you can.",
    expectChanged: true,
    expectWeek: 5,
    expectMileageLow: true,
  },
  {
    label: "Injury — swap key workout",
    user: "My calf has been tight, I don't think I can do the tempo next week.",
    coach: "Smart call. I've updated week 5 on your dashboard — swapped the tempo for an easy 5 miler. Listen to the calf and we'll reintroduce quality in week 6 if it's feeling better.",
    expectChanged: true,
    expectWeek: 5,
  },
  {
    label: "Priority change — reduce mileage",
    user: "Things are really busy at work, I think next week I can only realistically do 20 miles.",
    coach: "That's totally fine — I've updated week 5 to 20 miles. Keeping one quality session but trimming the easy runs. Life happens.",
    expectChanged: true,
    expectWeek: 5,
    expectMileage: 20,
  },
  {
    label: "Remove key workout only",
    user: "Can we skip the intervals next week? I want to focus on just easy running.",
    coach: "Done — I've updated week 6 on your dashboard. Removed the interval session and replaced it with an easy 6 miles. Volume stays the same.",
    expectChanged: true,
    expectWeek: 6,
  },

  // ── Should NOT trigger a plan change ─────────────────────────────────────
  {
    label: "General illness advice (no commit)",
    user: "Feeling a bit under the weather today.",
    coach: "Take it easy — if you're not better by tomorrow, skip the run and rest up. One missed day won't hurt your fitness.",
    expectChanged: false,
  },
  {
    label: "Pace question (no plan change)",
    user: "What pace should I run the tempo at?",
    coach: "For the tempo portion, aim for around 8:00/mi — that's your threshold based on your recent race. Warm up 1 mile easy first.",
    expectChanged: false,
  },
  {
    label: "Athlete mentions injury but coach just advises",
    user: "My knee is a bit sore after the long run.",
    coach: "That's pretty normal after a big weekend. Take Monday fully off, and if it's still sore Tuesday just shorten the run to 3 miles easy. Check in with me before the tempo.",
    expectChanged: false,
  },
  {
    label: "Travel mentioned but no plan change committed",
    user: "I'll be traveling next weekend — is that a problem?",
    coach: "Not at all! Hotel treadmill or outdoor exploring both count. The long run can be split into two shorter runs if needed. Just keep the effort easy.",
    expectChanged: false,
  },
  {
    label: "Normal conversation, no plan context",
    user: "How's my progress looking overall?",
    coach: "Really solid! You've been consistent and your easy pace has dropped about 15 sec/mile over the last month. Keep doing what you're doing.",
    expectChanged: false,
  },
];

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(65));
console.log("TEST: Training plan week adjustment detection");
console.log("=".repeat(65));
console.log(`\nPlan context: Weeks ${SAMPLE_WEEKS.map(w => w.week_number).join(", ")}`);
for (const w of SAMPLE_WEEKS) {
  console.log(`  Week ${w.week_number}: ${w.mileage_target} mi, key: ${w.key_workout}`);
}

// Run all in parallel
const results = await Promise.all(
  CASES.map(async (tc) => {
    const result = await checkPlanWeekUpdate(SAMPLE_WEEKS, tc.user, tc.coach);
    return { tc, result };
  })
);

let passed = 0;
let failed = 0;

const pass = (label) => `  ✓ ${label}`;
const fail = (label, detail) => `  ✗ ${label}\n    ${detail}`;

for (const { tc, result } of results) {
  console.log(`\n  "${tc.user.slice(0, 70)}${tc.user.length > 70 ? "…" : ""}"`);
  console.log(`  [${tc.label}]`);

  const gotChanged = result.changed === true;

  if (gotChanged !== tc.expectChanged) {
    failed++;
    console.log(fail(
      `changed=${gotChanged} but expected changed=${tc.expectChanged}`,
      `Result: ${JSON.stringify(result)}`
    ));
    continue;
  }

  if (!gotChanged) {
    passed++;
    console.log(pass("Correctly detected no plan change"));
    continue;
  }

  // Verify changed=true cases
  const changedWeeks = result.weeks ?? [];
  let ok = changedWeeks.length > 0;
  const issues = [];

  if (tc.expectWeek != null) {
    const found = changedWeeks.find(w => w.week_number === tc.expectWeek);
    if (!found) {
      ok = false;
      issues.push(`expected week_number ${tc.expectWeek} not found in result`);
    } else {
      if (tc.expectMileage != null && found.mileage_target !== tc.expectMileage) {
        ok = false;
        issues.push(`expected mileage_target=${tc.expectMileage}, got ${found.mileage_target}`);
      }
      if (tc.expectMileageLow) {
        const original = SAMPLE_WEEKS.find(w => w.week_number === tc.expectWeek);
        if (original && found.mileage_target != null && found.mileage_target >= original.mileage_target) {
          ok = false;
          issues.push(`expected mileage to be lower than ${original.mileage_target}, got ${found.mileage_target}`);
        }
      }
    }
  }

  if (ok) {
    passed++;
    console.log(pass(`Changed=true, week updates:`));
    for (const w of changedWeeks) {
      console.log(`    Week ${w.week_number}: ${w.mileage_target != null ? w.mileage_target + " mi" : "(mileage unchanged)"} | ${w.key_workout ?? "(workout unchanged)"}`);
    }
  } else {
    failed++;
    console.log(fail("Unexpected result", issues.join("; ") + " | " + JSON.stringify(result)));
  }
}

console.log(`\n${"=".repeat(65)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(65) + "\n");
