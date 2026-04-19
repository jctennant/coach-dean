#!/usr/bin/env node
/**
 * Onboarding eval runner for Coach Dean.
 *
 * Tests Dean's conversational behavior during the onboarding flow:
 *   1. Builds the onboarding system prompt from fixture data (mirrors handleConversation)
 *   2. Calls Claude Sonnet with the fixture's conversation history + inbound message
 *   3. Calls Claude Opus as judge to evaluate behavioral correctness
 *   4. Saves timestamped results to /evals/results/
 *
 * Usage:
 *   node evals/run-onboarding-evals.mjs
 *   node evals/run-onboarding-evals.mjs --fixture onboarding-first-message-intro
 *   node evals/run-onboarding-evals.mjs --category first_message
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildOnboardingJudgePrompt } from "./judges/onboarding-quality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "onboarding");
const RESULTS_DIR = path.join(__dirname, "results");

const ONBOARDING_MODEL = "claude-sonnet-4-5-20250929";
const JUDGE_MODEL = "claude-opus-4-5";

const client = new Anthropic();

// ─────────────────────────────────────────────
// System prompt (mirrors handleConversation in onboarding/handle/route.ts)
// Keep in sync with the key sections: WHAT TO COLLECT, INSTRUCTIONS,
// isFirstResponse branch, STRAVA, SIGNALING READY.
// ─────────────────────────────────────────────

function summarizeCollected(data) {
  const lines = [];
  if (data.name) lines.push(`Name: ${data.name}`);
  if (data.goal) {
    const distSuffix = data.goal_distance_miles ? `, ${data.goal_distance_miles} mi` : "";
    const goalStr = data.race_name
      ? `${data.race_name} (${data.goal}${distSuffix})`
      : data.goal;
    lines.push(`Goal: ${goalStr}`);
  }
  if (data.race_date) {
    const formatted = new Date(data.race_date + "T12:00:00Z")
      .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    lines.push(`Race date: ${formatted}`);
  }
  if (data.goal_time_minutes) {
    const h = Math.floor(data.goal_time_minutes / 60);
    const m = Math.round(data.goal_time_minutes % 60);
    lines.push(`Goal time: ${h > 0 ? `${h}h ` : ""}${m}min`);
  }
  if (Array.isArray(data.training_days) && data.training_days.length > 0) {
    lines.push(`Training days: ${data.training_days.join(", ")}`);
  }
  if (data.days_per_week) lines.push(`Days per week: ${data.days_per_week}`);
  if (data.weekly_miles) lines.push(`Current weekly mileage: ~${data.weekly_miles} miles`);
  if (data.easy_pace) lines.push(`Easy pace: ${data.easy_pace}/mi`);
  if (data.injury_notes) lines.push(`Injury/limitation: ${data.injury_notes}`);
  if (data.timezone) lines.push(`Timezone: ${data.timezone}`);
  if (data.strava_city) {
    const loc = data.strava_state ? `${data.strava_city}, ${data.strava_state}` : data.strava_city;
    lines.push(`Location (from Strava): ${loc}`);
  }
  if (Array.isArray(data.other_races) && data.other_races.length > 0) {
    const raceList = data.other_races
      .map((r) => `${r.name ?? "unnamed"} (${r.priority}, ${r.date ?? "no date"})`).join("; ");
    lines.push(`Other races: ${raceList}`);
  }
  if (data.has_existing_plan != null) lines.push(`Has existing plan: ${data.has_existing_plan ? "yes" : "no"}`);
  if (data.external_plan_description) lines.push(`Current plan: ${data.external_plan_description}`);
  return lines.join("\n");
}

function buildOnboardingSystemPrompt(fixture) {
  const { is_first_response, collected = {}, strava_context } = fixture;
  const collectedStr = summarizeCollected(collected);
  const stravaCtx = strava_context ?? "STRAVA: Not connected yet.";

  return `${!is_first_response ? `This is an ongoing conversation. You already introduced yourself — continue naturally without re-introducing or using first-meeting phrases.

` : ""}You are Coach Dean, an AI running coach onboarding a new athlete entirely over SMS text messages.

Your job: collect the information below through natural conversation, then signal you're ready with [READY].

WHAT TO COLLECT:
Required before signaling [READY]:
- Athlete's name (collect in your second message if not already known — do NOT ask in your first message)
- Training goal (specific race/event name and type, or general fitness)
- Training schedule (which days of the week work best)
- Terrain type and training tools: do NOT ask directly — extract passively from what they say

Important — collect naturally, don't skip:
- Race date (if they have a named race — use web_search to look it up if needed; not required for general_fitness / return_to_running)
- Fitness baseline: a recent race PR, current easy pace, OR Strava is connected
- Location / city (to send reminders at the right time)

Optional (only collect if it comes up naturally):
- Goal finish time for the race
- Other races this season (B/C tune-up races)
- Current weekly mileage (only if Strava not connected and not mentioned)
- Injury or physical limitation notes
- Ultra / trail background (only for 50K+ goals)

WHAT YOU ALREADY KNOW:
${collectedStr || "Nothing yet."}
${stravaCtx}

CONVERSATION MODE — read the athlete's first response and set the mode before collecting anything else:

PLAN COMPLEMENT (athlete already follows a plan — Runna, TrainingPeaks, coach-written, etc.):
- Confirm upfront: Dean works alongside their plan, not as a replacement. Value is post-run SMS debriefs, training Q&A, injury flagging, and the option to upload their plan as a PDF to the dashboard.
- Do NOT offer to rebuild their plan.

RACE-GOAL CHASER (has a specific event, no current plan):
- Acknowledge goal, connect fitness to it concretely. Collect race name + date first (web_search), then Strava, then fitness baseline and training days.
- Race date IS required before [READY] in this mode.

HEALTHY BUILDER / INJURY-PRONE (no specific race — staying consistent or recovering):
- Lead with curiosity about what's been happening. Don't push toward race-goal framing.
- Collect: name, injury/limitation context, current weekly mileage, training days.
- Race date is NOT required before [READY] in this mode.

INSTRUCTIONS:
- Ask 1–2 questions per message. Never fire off 5 at once.
- Do not re-ask for anything listed under "what you already know" above.
- Acknowledge what they share before asking the next thing.
- Be warm and specific to their goal. 3–4 sentences per message max.
- Plain text only. No markdown, asterisks, or bullet points.
- If they ask a coaching question, answer it briefly, then continue naturally.
- For named races you don't know the date of, use web_search (e.g. "Cirque Series Snowbird 2026 race date").
${is_first_response
  ? `- This is your FIRST message. Lead with the Strava/post-run differentiator, then broaden the goal framing beyond just racing. Example: "Hey! I'm Coach Dean — I'll send you a coaching note after every run you log on Strava: what it means, whether to push or back off, and what's coming. My job is to make sure your training actually adds up to something, whether that's a race PR, staying healthy, or just running more consistently." Then close with a single question that asks for BOTH their name AND what they're working toward — e.g. "What's your name, and what are you training for?" or "What's your name and what are you working toward?" Do NOT ask for name and goal as two separate questions — combine them into one. Do NOT reference specific tools like Runna or TrainingPeaks in the intro. Do NOT use the phrase "SMS running coach" — use "AI running coach" instead.`
  : `- You have already introduced yourself — it's in the conversation history above. Pick up where you left off: acknowledge what they just said and ask your next question. Good example: "Got it — any specific race on the calendar?" Bad example: "Hey Jake! I'm Coach Dean, your AI running coach..."`
}

STRAVA:
If Strava is not connected and you don't have pace data, ask about it. Write "[STRAVA_LINK]" as a placeholder in your message — the system will replace it with the actual link. Only do this once.

SIGNALING READY:
When you have goal + training_days + at least one of (pace/PR data OR Strava connected) + location, end your final message with [READY] on its own line. The [READY] tag is stripped before sending — do not reference or explain it. Do not include [READY] if you still need to ask something essential.
When you signal [READY], do not ask any more questions in that message. Wrap up warmly and set expectations (e.g. "I'll get your plan put together now") — the plan will be sent right after.`;
}

// ─────────────────────────────────────────────
// Main eval runner
// ─────────────────────────────────────────────

async function runEval(fixture) {
  const systemPrompt = buildOnboardingSystemPrompt(fixture);
  const { conversation_history = [], inbound_message } = fixture;

  // Build messages: history + current user turn
  const messages = [
    ...conversation_history,
    { role: "user", content: inbound_message },
  ];

  // Step 1: Get Dean's response (with web_search tool, same as real handler)
  let deanResponse = null;
  let coachError = null;
  try {
    const response = await client.messages.create({
      model: ONBOARDING_MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });

    // Mirror the route.ts logic: take only post-search text blocks
    let rawText = "";
    let lastToolIdx = -1;
    for (let i = 0; i < response.content.length; i++) {
      if (response.content[i].type === "tool_use") lastToolIdx = i;
    }
    for (let i = lastToolIdx + 1; i < response.content.length; i++) {
      if (response.content[i].type === "text") rawText += response.content[i].text;
    }
    if (!rawText.trim()) {
      for (const block of response.content) {
        if (block.type === "text") rawText += block.text;
      }
    }

    // Mirror route.ts post-processing: strip re-introduction on non-first messages
    if (!fixture.is_first_response) {
      if (/i'm coach dean/i.test(rawText.slice(0, 400))) {
        const qIdx = rawText.indexOf("?");
        if (qIdx !== -1) {
          const before = rawText.slice(0, qIdx);
          const nlIdx = before.lastIndexOf("\n");
          const dotIdx = before.lastIndexOf(". ");
          const sentenceStart = Math.max(nlIdx + 1, dotIdx + 2);
          rawText = rawText.slice(sentenceStart > 0 ? sentenceStart : 0).trimStart();
        }
      } else {
        rawText = rawText.replace(
          /^(nice|great|good|wonderful|so nice|really nice|so glad|happy)\s+to\s+(meet|have)\s+you[,!.]?\s*/i,
          ""
        );
      }
    }

    deanResponse = rawText.trim();
  } catch (err) {
    coachError = err.message;
  }

  if (!deanResponse) {
    return {
      fixture_id: fixture.id,
      category: fixture.category,
      description: fixture.description,
      dean_response: null,
      judgment: null,
      score: -1,
      flags: ["response_failed"],
      error: coachError || "No response generated",
    };
  }

  // Step 2: Judge the response
  const judgePromptStr = buildOnboardingJudgePrompt(fixture, deanResponse);
  let judgment = null;
  let judgeError = null;

  try {
    const judgeMsg = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: judgePromptStr }],
    });
    const judgeText = judgeMsg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text.trim())
      .join("")
      .trim();

    const stripped = judgeText.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in judge response: ${judgeText.slice(0, 200)}`);
    judgment = JSON.parse(jsonMatch[0]);
  } catch (err) {
    judgeError = err.message;
    console.error(`[${fixture.id}] Judge error:`, err.message);
  }

  return {
    fixture_id: fixture.id,
    category: fixture.category,
    description: fixture.description,
    dean_response: deanResponse,
    judgment,
    score: judgment?.score ?? -1,
    flags: judgment?.flags ?? [],
    error: judgeError || null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureFilter = args.indexOf("--fixture") !== -1
    ? args[args.indexOf("--fixture") + 1]
    : null;
  const categoryFilter = args.indexOf("--category") !== -1
    ? args[args.indexOf("--category") + 1]
    : null;

  const fixtureFiles = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let fixtures = fixtureFiles.map((f) =>
    JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8"))
  );

  if (fixtureFilter) {
    fixtures = fixtures.filter((f) => f.id === fixtureFilter);
    if (fixtures.length === 0) {
      console.error(`No fixture found with id: ${fixtureFilter}`);
      process.exit(1);
    }
  }
  if (categoryFilter) {
    fixtures = fixtures.filter((f) => f.category === categoryFilter);
    if (fixtures.length === 0) {
      console.error(`No fixtures found in category: ${categoryFilter}`);
      process.exit(1);
    }
  }

  console.log(`\nRunning ${fixtures.length} onboarding fixture${fixtures.length !== 1 ? "s" : ""}...\n`);

  const results = [];
  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.id} ... `);
    const result = await runEval(fixture);
    results.push(result);

    const score = result.score;
    const scoreStr = score === -1 ? "ERROR" : `${score}/10`;
    const status = score >= 7 ? "✓" : score === -1 ? "✗" : "⚠";
    console.log(`${status} ${scoreStr}${result.flags.length > 0 ? ` [${result.flags.join(", ")}]` : ""}`);
    if (result.judgment?.score_rationale) {
      console.log(`    → ${result.judgment.score_rationale}`);
    }
    if (result.error) {
      console.log(`    Error: ${result.error}`);
    }
  }

  // Save results
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const resultFile = path.join(RESULTS_DIR, `onboarding-${timestamp}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({ timestamp, results }, null, 2));
  console.log(`\nResults saved to ${path.relative(process.cwd(), resultFile)}`);

  // Summary
  const scored = results.filter((r) => r.score >= 0);
  const passed = scored.filter((r) => r.score >= 7);
  const failed = scored.filter((r) => r.score < 7);
  const errored = results.filter((r) => r.score === -1);
  const avg = scored.length > 0 ? (scored.reduce((s, r) => s + r.score, 0) / scored.length).toFixed(1) : "N/A";

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Onboarding Evals: ${passed.length}/${scored.length} passed  |  avg ${avg}/10`);
  if (failed.length > 0) {
    console.log(`\nFailed fixtures:`);
    for (const r of failed) {
      console.log(`  ✗ ${r.fixture_id} (${r.score}/10): ${r.judgment?.score_rationale ?? "no rationale"}`);
    }
  }
  if (errored.length > 0) {
    console.log(`\nErrored: ${errored.map((r) => r.fixture_id).join(", ")}`);
  }
  console.log();

  if (failed.length > 0 || errored.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
