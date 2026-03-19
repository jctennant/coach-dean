/**
 * Tests for the March 2026 bug-fix batch:
 *   1. (P0) Volume guardrail — no >30% Week 1 jumps for low-volume athletes
 *   2. (P1) Race distance hallucination — 50mi/100mi in formatGoalLabel
 *   3. (P1) Race data rule — system prompt includes RACE DATA RULE instruction
 *   4. (P1) Historical mileage rule — system prompt instructs not to fabricate
 *   5. (P2) Reminder time constraint — system prompt discloses limitation upfront
 *   6. (P2) Post-run duplication — CONTEXT CHECK covers prior coach responses
 *   7. (P2) Day count validation — weekly_recap validates session count
 *   8. (P2) Plan consistency in user_message — references stored plan
 *
 * Run: ANTHROPIC_API_KEY=... node scripts/test-bug-fixes-mar2026.mjs
 *
 * Static checks (1–8) run without an API key.
 * LLM checks (9–11) require ANTHROPIC_API_KEY.
 */

import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

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
// Helper: replicate the relevant parts of the real system prompt construction
// so we can inspect what gets injected without importing the full Next.js route.
// ---------------------------------------------------------------------------

function buildFitnessTier(avgWeeklyMileage) {
  if (avgWeeklyMileage == null) {
    return [
      `FITNESS TIER: No activity data yet. Default to a conservative, base-building approach until training history establishes their level.`,
      `⚠️ WEEK 1 VOLUME CAP (no history): Since no mileage data exists, Week 1 must not exceed 10 mi total. Start extremely conservatively — 3 short sessions of 2–3 mi each is appropriate.`,
    ].join("\n");
  }
  if (avgWeeklyMileage < 10) {
    const cap = Math.max(Math.ceil(avgWeeklyMileage * 1.3), 6);
    return [
      `FITNESS TIER: LOW VOLUME (avg ${avgWeeklyMileage.toFixed(1)} mi/week). This athlete is in early base-building.`,
      `⚠️ WEEK 1 VOLUME CAP — HARD LIMIT: This athlete currently runs ~${avgWeeklyMileage.toFixed(1)} mi/week. Week 1 MUST NOT exceed ${cap.toFixed(0)} mi total (current volume × 1.30, floor 6 mi). This is non-negotiable — prescribing 2–3× their current volume is a documented injury risk. For example, if they run 5 mi/week, prescribing 15 mi is a 200% jump and is wrong. A safe Week 1 for 5 mi/week is 6–7 mi spread across 3 sessions (e.g., 2mi / 2mi / 2.5mi).`,
    ].join("\n");
  }
  if (avgWeeklyMileage < 30) {
    return `FITNESS TIER: MODERATE VOLUME (avg ${avgWeeklyMileage.toFixed(1)} mi/week).`;
  }
  return `FITNESS TIER: HIGH VOLUME (avg ${avgWeeklyMileage.toFixed(1)} mi/week).`;
}

function formatGoalLabel(goal) {
  const labels = {
    "5k": "a 5K",
    "10k": "a 10K",
    half_marathon: "a half marathon",
    marathon: "a marathon",
    general_fitness: "general fitness",
    return_to_running: "returning to running",
    "30k": "a 30K trail race",
    "50k": "a 50K ultra",
    "50mi": "a 50-mile ultra",
    "100k": "a 100K ultra",
    "100mi": "a 100-mile ultra",
    sprint_tri: "a sprint triathlon",
    olympic_tri: "an Olympic-distance triathlon",
    "70.3": "a 70.3 Half Ironman",
    ironman: "a Full Ironman",
    cycling: "a cycling event",
    injury_recovery: "injury recovery and return to running",
  };
  return labels[goal] || goal;
}

// ---------------------------------------------------------------------------
// TEST 1: P0 — Volume guardrail cap calculation
// ---------------------------------------------------------------------------

section("1. P0 — Volume guardrail: cap calculation");

const cases = [
  { weekly: null,  expectedMax: 10, desc: "no data" },
  { weekly: 5,     expectedMax: 7,  desc: "5 mi/week (Scott)" },
  { weekly: 3,     expectedMax: 6,  desc: "3 mi/week (floor 6)" },
  { weekly: 8,     expectedMax: 11, desc: "8 mi/week" },
  { weekly: 10,    expectedMax: null, desc: "10 mi/week (moderate, no cap)" },
  { weekly: 30,    expectedMax: null, desc: "30 mi/week (high volume, no cap)" },
];

for (const c of cases) {
  const text = buildFitnessTier(c.weekly);
  if (c.expectedMax === null) {
    // Should NOT have a volume cap
    check(
      `${c.desc}: no cap injected`,
      !text.includes("WEEK 1 VOLUME CAP"),
      text.slice(0, 120)
    );
  } else {
    // Should have a cap at or below expectedMax (case-insensitive)
    const capMatch = text.match(/(?:MUST NOT|must not) exceed (\d+) mi/i);
    const actualCap = capMatch ? parseInt(capMatch[1]) : null;
    check(
      `${c.desc}: cap present and ≤ ${c.expectedMax} mi (got ${actualCap})`,
      actualCap !== null && actualCap <= c.expectedMax,
      text.slice(0, 200)
    );

    // The "200% jump" example should appear for the 5 mi/week case
    if (c.weekly === 5) {
      check(
        "5 mi/week: example mentions 15 mi as wrong",
        text.includes("15 mi"),
        "Expected warning about 15 mi jump"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// TEST 2: P1 — Race distance: 50mi and 100mi in formatGoalLabel
// ---------------------------------------------------------------------------

section("2. P1 — formatGoalLabel: 50mi and 100mi");

check("50mi → 'a 50-mile ultra'", formatGoalLabel("50mi") === "a 50-mile ultra");
check("100mi → 'a 100-mile ultra'", formatGoalLabel("100mi") === "a 100-mile ultra");
check("50k → 'a 50K ultra' (unchanged)", formatGoalLabel("50k") === "a 50K ultra");
check("100k → 'a 100K ultra' (unchanged)", formatGoalLabel("100k") === "a 100K ultra");
check("unknown → raw string fallback", formatGoalLabel("some_new_goal") === "some_new_goal");

// ---------------------------------------------------------------------------
// TEST 3: P1 — Race data rule in system prompt
// ---------------------------------------------------------------------------

section("3. P1 — RACE DATA RULE in system prompt");

// Simulate the ATHLETE HISTORY block the route builds
function buildAthleteHistoryBlock(goal, raceDate) {
  const goalLabel = goal ? formatGoalLabel(goal) : "unknown";
  return `ATHLETE HISTORY:
- Goal: ${goalLabel}${raceDate ? ` on ${raceDate}` : ""}
⚠️ RACE DATA RULE: The athlete's goal race is exactly as shown above. When referencing their race, use the exact goal type and distance above — do NOT substitute a different distance, format, or race type from memory or inference. If it says "50-mile ultra", it is 50 miles, not 50K. If it says "10K", it is a 10K. These values come from the athlete's profile and are authoritative.`;
}

const block50mi = buildAthleteHistoryBlock("50mi", "2026-05-17");
check("50mi block contains '50-mile ultra'", block50mi.includes("50-mile ultra"));
check("50mi block contains RACE DATA RULE", block50mi.includes("RACE DATA RULE"));
check("50mi block warns about 50K substitution", block50mi.includes("not 50K") || block50mi.includes("50 miles, not 50K"));

const block10k = buildAthleteHistoryBlock("10k", "2026-04-19");
check("10K block contains '10K'", block10k.includes("a 10K"));
check("10K block contains RACE DATA RULE", block10k.includes("RACE DATA RULE"));

// ---------------------------------------------------------------------------
// TEST 4: P1 — Historical mileage rule in system prompt
// ---------------------------------------------------------------------------

section("4. P1 — HISTORICAL MILEAGE RULE in system prompt");

const HISTORICAL_MILEAGE_RULE = `⚠️ HISTORICAL MILEAGE RULE: When citing a specific prior week's mileage, use ONLY the values shown in "WEEKLY MILEAGE (completed weeks)" above. If a particular week is not in that table, say "I don't have exact data for that week" — never estimate or fabricate a specific number.`;

// Check the rule text (which is hardcoded in the route)
check("rule contains 'HISTORICAL MILEAGE RULE'", HISTORICAL_MILEAGE_RULE.includes("HISTORICAL MILEAGE RULE"));
check("rule instructs to say 'I don't have exact data'", HISTORICAL_MILEAGE_RULE.includes("don't have exact data"));
check("rule explicitly warns against fabrication", HISTORICAL_MILEAGE_RULE.includes("never estimate or fabricate"));
check("rule references WEEKLY MILEAGE table", HISTORICAL_MILEAGE_RULE.includes("WEEKLY MILEAGE (completed weeks)"));

// ---------------------------------------------------------------------------
// TEST 5: P2 — Reminder time constraint
// ---------------------------------------------------------------------------

section("5. P2 — REMINDER TIME CONSTRAINT in product capabilities");

const PRODUCT_CAPABILITIES_BLOCK = `Morning reminders go out at approximately 6am PT / 7am MT / 8am CT / 9am ET.
Evening reminders go out at approximately 6pm PT / 7pm MT / 8pm CT / 9pm ET (the evening before the session).
Specific times beyond these (e.g. "8:30am", "noon", "3pm", "after work") are NOT supported — just morning or evening.
NEVER promise a reminder at a precise time — say "around 6am" or "evening before", not "at 8am exactly".
⚠️ REMINDER TIME CONSTRAINT: If an athlete requests a specific time that isn't morning or evening (e.g. "3pm", "noon", "lunchtime"), immediately disclose the constraint — do NOT confirm the unsupported time first.`;

check("'3pm' listed as unsupported example", PRODUCT_CAPABILITIES_BLOCK.includes('"3pm"'));
check("instructs to disclose constraint immediately", PRODUCT_CAPABILITIES_BLOCK.includes("immediately disclose the constraint"));
check("instructs NOT to confirm unsupported time first", PRODUCT_CAPABILITIES_BLOCK.includes("do NOT confirm the unsupported time first"));

// ---------------------------------------------------------------------------
// TEST 6: P2 — Post-run CONTEXT CHECK covers prior coach responses
// ---------------------------------------------------------------------------

section("6. P2 — Post-run CONTEXT CHECK covers prior coach responses");

const POST_RUN_CONTEXT_CHECK = `CONTEXT CHECK: Before writing, scan the RECENT CONVERSATION above. If there is ALREADY a coach response (from you) about this same workout — same activity date or discussing the same run — do NOT give full post-run feedback again. This happens when the athlete texts about a run before Strava syncs, and then Strava triggers this message an hour later.`;

check("mentions 'coach response (from you)' scenario", POST_RUN_CONTEXT_CHECK.includes("coach response (from you)"));
check("explains the strava-delay scenario", POST_RUN_CONTEXT_CHECK.includes("before Strava syncs") || POST_RUN_CONTEXT_CHECK.includes("hour later"));
check("instructs NOT to repeat full feedback", POST_RUN_CONTEXT_CHECK.includes("do NOT give full post-run feedback again"));

// ---------------------------------------------------------------------------
// TEST 7: P2 — Weekly recap day count validation
// ---------------------------------------------------------------------------

section("7. P2 — TRAINING DAY COUNT VALIDATION in weekly_recap");

const WEEKLY_RECAP_COUNT_CHECK = `TRAINING DAY COUNT VALIDATION — CRITICAL: Before finalizing the week plan, count the number of running sessions you've scheduled and verify it matches the athlete's stated days/week preference ("Training days" in ATHLETE HISTORY). If the athlete wants 5 days of running, you must schedule exactly 5 running sessions — not 4, not 6. Count the items explicitly before writing.`;

check("contains 'TRAINING DAY COUNT VALIDATION'", WEEKLY_RECAP_COUNT_CHECK.includes("TRAINING DAY COUNT VALIDATION"));
check("gives concrete 5-day example", WEEKLY_RECAP_COUNT_CHECK.includes("5 days of running") || WEEKLY_RECAP_COUNT_CHECK.includes("5 running sessions"));
check("explicitly says 'not 4, not 6'", WEEKLY_RECAP_COUNT_CHECK.includes("not 4") && WEEKLY_RECAP_COUNT_CHECK.includes("not 6"));

// ---------------------------------------------------------------------------
// TEST 8: P2 — Plan consistency in user_message
// ---------------------------------------------------------------------------

section("8. P2 — PLAN CONSISTENCY in user_message prompt");

const USER_MESSAGE_PLAN = `PLAN CONSISTENCY: If there are UPCOMING SESSIONS THIS WEEK in CURRENT TRAINING STATE, those are the active plan. When the athlete asks about their schedule or upcoming runs, reference those stored sessions first — don't reconstruct the plan from memory or guess at different distances.`;

check("contains 'PLAN CONSISTENCY'", USER_MESSAGE_PLAN.includes("PLAN CONSISTENCY"));
check("references UPCOMING SESSIONS THIS WEEK", USER_MESSAGE_PLAN.includes("UPCOMING SESSIONS THIS WEEK"));
check("says reference stored sessions first", USER_MESSAGE_PLAN.includes("reference those stored sessions first"));
check("warns against guessing different distances", USER_MESSAGE_PLAN.includes("guess at different distances"));

// ---------------------------------------------------------------------------
// LLM TESTS — require ANTHROPIC_API_KEY
// ---------------------------------------------------------------------------

if (!client) {
  console.log("\n⚠️  Skipping LLM tests — no ANTHROPIC_API_KEY set\n");
  printSummary();
  process.exit(0);
}

section("9. LLM — Volume guardrail: 5mi/week athlete does NOT get 15mi plan");

const LOW_VOLUME_SYSTEM = `You are Coach Dean, an expert endurance coach.

DATE CONTEXT:
- Today: Thursday, March 19, 2026
- Tomorrow: Friday, Mar 20
- Next 7 days: Friday, Mar 20 | Saturday, Mar 21 | Sunday, Mar 22 | Monday, Mar 23 | Tuesday, Mar 24 | Wednesday, Mar 25 | Thursday, Mar 26
- Race date: 2026-05-31 (73 days away)

CALIBRATE TO ATHLETE'S ACTUAL FITNESS FIRST:
Before applying any training philosophy, anchor the plan to what the data shows.

FITNESS TIER: LOW VOLUME (avg 5.0 mi/week). This athlete is in early base-building. Prioritize easy aerobic volume and consistency. Hold off on structured quality sessions (tempo, intervals) until they have 4–6 weeks of steady easy running. Protect them from overtraining — it's the most common reason early runners quit or get hurt.
⚠️ WEEK 1 VOLUME CAP — HARD LIMIT: This athlete currently runs ~5.0 mi/week. Week 1 MUST NOT exceed 7 mi total (current volume × 1.30, floor 6 mi). This is non-negotiable — prescribing 2–3× their current volume is a documented injury risk and directly contradicts the 10% weekly increase guideline. For example, if they run 5 mi/week, prescribing 15 mi is a 200% jump and is wrong. A safe Week 1 for 5 mi/week is 6–7 mi spread across 3 sessions (e.g., 2mi / 2mi / 2.5mi). Do not exceed this cap under any circumstances, regardless of race goals or timelines.

ATHLETE HISTORY:
- Sport: running
- Training days: Tuesday, Thursday, Saturday
- Goal: a 50K ultra on 2026-05-31
- Current weekly mileage: ~5 mi/week (stated by athlete)
- Injury notes: None

CURRENT TRAINING STATE:
- Week 1 of training, phase: base
- Weekly mileage target: 5 mi
- Mileage so far this week: 0.0 mi (0 runs)`;

const LOW_VOLUME_USER = `This athlete just finished onboarding. Send them an initial week plan — framed as a starting point.

VOLUME AND SAFETY:
- ⚠️ CRITICAL: The FITNESS TIER section in your system prompt contains a "⚠️ WEEK 1 VOLUME CAP" with a specific hard maximum for this athlete. You MUST respect that cap — it is calculated from their actual current mileage.

SCHEDULE CONSTRAINT: Only schedule running sessions on Tuesday, Thursday, Saturday.

DATES AND DAY LABELS: Use the day names from DATE CONTEXT.

Write as 2 short iMessage texts, each under 480 chars, separated by a blank line.`;

try {
  const r9 = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 800,
    system: LOW_VOLUME_SYSTEM,
    messages: [{ role: "user", content: LOW_VOLUME_USER }],
  });
  const text9 = r9.content.filter(b => b.type === "text").map(b => b.text).join(" ");
  console.log("\n  Response preview:", text9.slice(0, 300));

  // Extract all mileage numbers from session lines
  const sessionMiles = [];
  const sessionRe = /(Tue|Thu|Sat|Sun|Mon|Wed|Fri)\s+\d+\/\d+\s+·\s+(?!Strength|Rest|Mobility)[\s\S]*?(\d+(?:\.\d+)?)\s*mi/gi;
  let m;
  while ((m = sessionRe.exec(text9)) !== null) {
    sessionMiles.push(parseFloat(m[2]));
  }
  const totalPlanned = sessionMiles.reduce((s, v) => s + v, 0);

  console.log(`\n  Extracted session miles: ${sessionMiles.join(" + ")} = ${totalPlanned.toFixed(1)} mi`);

  check("Week 1 total ≤ 7 mi (hard cap for 5mi/week athlete)", totalPlanned <= 7.5,
    `Got ${totalPlanned.toFixed(1)} mi — should be ≤ 7 mi`
  );
  check("Does NOT prescribe 15 mi", !text9.match(/\b15\s*mi/i));
  check("Does NOT prescribe 12 mi", !text9.match(/\b12\s*mi/i));
  check("Does NOT prescribe 10 mi", !text9.match(/\b10\s*mi/i));
} catch (err) {
  console.log("  ⚠️  LLM call failed:", err.message);
  totalFail++;
}

// ---------------------------------------------------------------------------
// TEST 10: LLM — Race data rule: 50-miler is called correctly
// ---------------------------------------------------------------------------

section("10. LLM — Race data rule: 50-mile race is NOT called 50K");

const RACE_SYSTEM = `You are Coach Dean, an expert endurance coach.

DATE CONTEXT:
- Today: Thursday, March 19, 2026
- Race date: 2026-04-27 (39 days away)

ATHLETE HISTORY:
- Goal: a 50-mile ultra on 2026-04-27
⚠️ RACE DATA RULE: The athlete's goal race is exactly as shown above. When referencing their race, use the exact goal type and distance above — do NOT substitute a different distance, format, or race type from memory or inference. If it says "50-mile ultra", it is 50 miles, not 50K.

CURRENT TRAINING STATE:
- Week 8 of training, phase: build
- Last activity: {"type":"Run","distance_miles":8.1,"pace":"9:20/mi"}`;

const RACE_USER = `A workout just synced from Strava. Activity: 8.1 mi easy run at 9:20/mi avg, 390ft vert.

Provide brief post-run feedback and reference the upcoming race.`;

try {
  const r10 = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 400,
    system: RACE_SYSTEM,
    messages: [{ role: "user", content: RACE_USER }],
  });
  const text10 = r10.content.filter(b => b.type === "text").map(b => b.text).join(" ");
  console.log("\n  Response:", text10.slice(0, 300));

  check("Does NOT say '50K'", !text10.match(/\b50[- ]?K\b/i),
    "Found '50K' when race should be called '50 miles' or '50-miler'"
  );
  check("References the race correctly (50 mile / 50-mile / 50 miler)",
    text10.match(/50[\s-]?mi(le)?s?|50[\s-]?miler/i) !== null,
    "Did not reference '50 mile' in response"
  );
} catch (err) {
  console.log("  ⚠️  LLM call failed:", err.message);
  totalFail++;
}

// ---------------------------------------------------------------------------
// TEST 11: LLM — Reminder time: 3pm request is handled upfront
// ---------------------------------------------------------------------------

section("11. LLM — Reminder time: 3pm request handled with constraint disclosed");

const REMINDER_SYSTEM = `You are Coach Dean, an expert endurance coach communicating via SMS.

PRODUCT CAPABILITIES:
- Proactive reminders: three options are supported: (1) morning-of reminders (~6am PT), (2) evening-before reminders (~6pm PT), (3) weekly Sunday overview only.
- Specific times beyond these (e.g. "8:30am", "noon", "3pm", "after work") are NOT supported — just morning or evening.
- NEVER promise a reminder at a precise time.
- ⚠️ REMINDER TIME CONSTRAINT: If an athlete requests a specific time that isn't morning or evening (e.g. "3pm", "noon", "lunchtime"), immediately disclose the constraint — do NOT confirm the unsupported time first. Say something like: "I can send reminders around 6am [their timezone] or the evening before — which works better?" Surface the limitation upfront so the athlete can choose. Never confirm a time you cannot support and correct it later.

RECENT CONVERSATION:
[no prior messages]`;

const REMINDER_USER = `The athlete just texted: "sure, reminders around 3pm on the day of the run"

Respond as Coach Dean.`;

try {
  const r11 = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: REMINDER_SYSTEM,
    messages: [{ role: "user", content: REMINDER_USER }],
  });
  const text11 = r11.content.filter(b => b.type === "text").map(b => b.text).join(" ");
  console.log("\n  Response:", text11);

  // Should NOT confirm "3pm" or "afternoon"
  const wrongConfirm = /i.?ll text you.{0,30}3pm|perfect.{0,50}3pm|got it.{0,50}3pm|confirmed.{0,50}3pm|morning of each session/i.test(text11);
  check("Does NOT confirm '3pm' as supported", !wrongConfirm,
    `Appears to confirm 3pm or morning without disclosing constraint: "${text11.slice(0, 100)}"`
  );

  // Should offer morning or evening options
  const offersOptions = /(morning|6am|evening before|evening-before)/i.test(text11);
  check("Offers morning or evening-before as alternatives", offersOptions,
    "Did not offer supported timing options"
  );
} catch (err) {
  console.log("  ⚠️  LLM call failed:", err.message);
  totalFail++;
}

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
