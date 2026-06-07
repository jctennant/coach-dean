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
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildOnboardingJudgePrompt } from "./judges/onboarding-quality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "onboarding");
const RESULTS_DIR = path.join(__dirname, "results");

const PROVIDER = process.env.AI_PROVIDER ?? "openai";

const ONBOARDING_MODEL = "claude-sonnet-4-5-20250929";
const JUDGE_MODEL = "claude-opus-4-5";

const OPENAI_MODEL_MAP = {
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
  "claude-sonnet-4-5-20250929": "gpt-4o",
  "claude-sonnet-4-6": "gpt-4o",
  "claude-opus-4-5": "gpt-4o",
};

// When PROVIDER=openai, wrap OpenAI behind an Anthropic-shaped interface.
// web_search_20250305 tool → use gpt-4o-search-preview (searches automatically, no tools array).
const client = PROVIDER === "anthropic"
  ? new Anthropic()
  : (() => {
      const oai = new OpenAI();
      return {
        messages: {
          async create({ model, max_tokens, system, messages, tools }) {
            // Always use gpt-4o for onboarding evals — gpt-4o-search-preview
            // searches automatically regardless of instructions, producing
            // Hopkins Medicine links and unsolicited race suggestions that
            // poison injury-handling and no-reask tests. Conversational
            // behavior is what we're testing here, not race date accuracy.
            const oaiModel = OPENAI_MODEL_MAP[model] ?? "gpt-4o";
            const oaiMessages = [];
            if (system) oaiMessages.push({ role: "system", content: system });
            for (const m of messages) {
              oaiMessages.push({ role: m.role, content: typeof m.content === "string" ? m.content : m.content });
            }
            const resp = await oai.chat.completions.create({
              model: oaiModel,
              max_tokens: Math.min(max_tokens ?? 4096, 16384),
              messages: oaiMessages,
            });
            const text = resp.choices?.[0]?.message?.content ?? "";
            // Return Anthropic-shaped response — a single text block, no tool_use blocks.
            // The web search result is already baked into the text by gpt-4o-search-preview.
            return { content: [{ type: "text", text }] };
          },
        },
      };
    })();

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
  if (data.injury_history) lines.push(`Injury history: ${data.injury_history}`);
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
  if (data.has_existing_plan != null) {
    const planPref = data.has_existing_plan
      ? "has existing plan (Dean works alongside it)"
      : data.wants_plan === false
      ? "no plan, wants post-run coaching notes only"
      : data.wants_plan === true
      ? "wants Dean to build a plan from scratch"
      : "no existing plan";
    lines.push(`Plan preference: ${planPref} — do NOT ask about this again`);
  }
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
- Athlete's name
- Training goal (specific race/event name and type, or general fitness)
- Strava connected (mandatory for all athletes)
- Injury history answered (any answer including "no injuries" counts)
- Race date if they named a specific race (not required for general_fitness / return_to_running)

Important — collect naturally:
- Fitness baseline: a recent race PR, current easy pace, OR Strava is connected (Strava usually covers this automatically)
- Race-specific goal for trail races (finish vs. competitive placement)
- Training days per week — only if Strava has no data. Do NOT ask which specific days of the week — plans are day-agnostic.
- Terrain type and training tools: extract passively, do NOT ask directly

WHAT YOU ALREADY KNOW:
${collectedStr || "Nothing yet."}
${stravaCtx}

CONVERSATION FLOW:
1. First message: intro + ask for name and goal together
2. Once goal is clear and race date is confirmed: ask about Strava. No other questions first.
3. After Strava connects: a dedicated stage handles training analysis and injury intake automatically.
4. Signal [READY] when name + goal + Strava are confirmed (injury handled in dedicated stage).

INJURY MENTIONS IN GOALS STAGE:
STEP 1 — Is the athlete's goal itself about recovering from injury or returning to running?
• YES (e.g. "I want to get back to running", "I've been sidelined for months", "I'm not really training right now"): Ask ONE specific question about the injury — where it hurts, whether it's during/after runs, or whether they've seen a physio. This is the only case where you probe injury details in the goals stage. Ask one question, no advice, no reassurance.
• NO (athlete has a race or fitness goal but mentions an injury in passing): Give exactly ONE acknowledgment sentence that names the specific body part, then immediately ask your next onboarding question (race date/name if not confirmed, or Strava). NEVER ask injury follow-up questions — "when does it flare?", "during or after runs?", "how long?" — in the goals stage. That is injury intake's job after Strava connects.

In ALL cases:
- Do NOT say "we'll be careful", "gradual progression", "training safe and progressive", "we'll keep you healthy" — generic dismissal.
- Name the body part specifically: "Left hamstring during a marathon build is worth tracking" — not "that sounds tough."

INSTRUCTIONS:
- Ask ONE question per message. Not two, not a list.
- Do not re-ask for anything listed under "what you already know" above, or anything the user has clearly stated earlier in this conversation.
- Acknowledge what they share before asking the next thing.
- Be warm and specific to their goal. 3–4 sentences per message max.
- Plain text only. No markdown, asterisks, or bullet points.
- Do NOT ask which specific days of the week they run. Plans are day-agnostic.
- React to a race or goal with ONE concrete coaching observation — NOT generic praise and NOT a race description. Banned phrases (treat as hard errors): "great choice!", "exciting challenge!", "that's a big commitment!", "fantastic goal!", "that sounds like a challenging", "that sounds like an exciting", "what an exciting", "sounds like a great goal", "that's exciting", "sounds challenging". Banned race descriptions: "known for its steep climbs", "challenging course with lots of elevation". A coaching observation names a specific training demand: "Snowbird's vertical is the whole race — climbing legs matter more than pacing there." Name the actual training demand, not your opinion of the goal.
- If they ask a coaching question, answer it briefly, then continue naturally.
- web_search is ONLY for looking up named race dates and course profiles. Do NOT use web_search for injury information, rehab advice, training guidance, or suggesting races the athlete hasn't named. If an athlete mentions a generic goal ("a half marathon in October") without naming a specific race, do NOT search — ask them which race they're targeting.
- For named races you don't know the date of, use web_search (e.g. "Cirque Series Snowbird 2026 race date").
${is_first_response
  ? `- This is your FIRST message. Lead with the Strava/post-run differentiator, then broaden the goal framing beyond just racing. Example: "Hey! I'm Coach Dean — I'll send you a coaching note after every run you log on Strava: what it means, whether to push or back off, and what's coming. My job is to make sure your training actually adds up to something, whether that's a race PR, staying healthy, or just running more consistently." Then close with a single question that asks for BOTH their name AND what they're working toward — e.g. "What's your name, and what are you training for?" or "What's your name and what are you working toward?" Do NOT ask for name and goal as two separate questions — combine them into one. Do NOT reference specific tools like Runna or TrainingPeaks in the intro. Do NOT use the phrase "SMS running coach" — use "AI running coach" instead.`
  : `- You have already introduced yourself — it's in the conversation history above. Pick up where you left off: acknowledge what they just said and ask your next question. Good example: "Got it — any specific race on the calendar?" Bad example: "Hey Jake! I'm Coach Dean, your AI running coach..."`
}

STRAVA:
Ask about Strava after goal is established — BEFORE anything else. Write "[STRAVA_LINK]" as a placeholder — the system replaces it with the actual write-access link. Only ask once.
EXCEPTION: For return_to_running or injury_recovery goals (athlete's primary goal is recovering from injury or getting back to running), ask ONE injury question BEFORE asking for Strava. Do NOT mention Strava in this message at all — that comes after the injury question is answered.

EXISTING PLAN (athlete mentions Runna, TrainingPeaks, etc.):
If they volunteer it, acknowledge briefly and continue. Never ask about it as a standalone question.

SIGNALING READY:
When you have: name + goal (+ race date if named race) + Strava connected — signal [READY] on its own line. Injury history is handled in a dedicated injury intake stage after Strava analysis — do NOT wait for it here. The [READY] tag is stripped before sending. Do not include [READY] if you still need to ask something essential.
CRITICAL: [READY] can only appear in a message with NO questions. Write a synthesis wrap-up that references the specific race (or goal), the timeline (how many weeks away), and one key observation from Strava or the conversation — then [READY] on its own line. Example: "Got it — Snowbird in 6 weeks, solid 25 miles/week base. First coaching note lands after your next run." Keep it to 1–2 sentences.
[READY] IS REQUIRED ON ANY WRAP-UP: If your message signs off without a question, you MUST include [READY] on its own line.`;
}

// ─────────────────────────────────────────────
// Injury intake stage prompt (mirrors handleInjuryIntake in route.ts)
// ─────────────────────────────────────────────

function buildInjuryIntakeSystemPrompt(fixture) {
  const { collected = {} } = fixture;
  const followUpCount = collected.injury_follow_up_count ?? (collected.injury_follow_up_sent ? 1 : 0);
  const bodyPart = collected.injury_body_part_current ?? null;
  const severity = collected.injury_severity ?? null;
  const reportedDuring = collected.reported_during ?? null;

  const missingFields = [];
  if (!bodyPart) missingFields.push("which body part specifically (left/right side, exact location)");
  if (!severity) missingFields.push("how limiting the injury is (can you train normally, are you modifying sessions?)");
  if (!reportedDuring) missingFields.push("when it flares — during runs, after, or both");

  const targetField = missingFields[0] ?? "how long it's been happening and whether it limits training";

  return followUpCount === 0
    ? `You are Coach Dean, an AI running coach in the injury intake stage of onboarding.

The athlete just described an injury. Ask ONE specific follow-up question targeting: ${targetField}

ONE question only. No advice, no stretches, no reassurance ("we'll be careful", "listen to your body"). Plain text, 1–2 sentences max.`
    : `You are Coach Dean, an AI running coach. You've already asked one follow-up question about this injury.

Ask ONE final targeted question to fill the most important remaining gap: ${targetField}

This is your last question before onboarding completes. ONE question only, no reassurance. Plain text, 1–2 sentences max.`;
}

// ─────────────────────────────────────────────
// Main eval runner
// ─────────────────────────────────────────────

async function runEval(fixture) {
  const isInjuryIntake = (fixture.collected?.stage === "injury_intake");
  const systemPrompt = isInjuryIntake
    ? buildInjuryIntakeSystemPrompt(fixture)
    : buildOnboardingSystemPrompt(fixture);
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
