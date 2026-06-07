#!/usr/bin/env node
/**
 * Multi-turn onboarding simulation eval runner for Coach Dean.
 *
 * Each fixture defines a user persona. The runner:
 *   1. Alternates between Dean (Sonnet) and a user agent (Haiku playing the persona)
 *   2. Runs Haiku field extraction after each exchange to update Dean's context
 *   3. Detects [READY] to end the simulation
 *   4. Judges the full transcript with Claude Opus
 *
 * Usage:
 *   node evals/run-simulation-evals.mjs
 *   node evals/run-simulation-evals.mjs --fixture sim-marathon-first-timer
 *   node evals/run-simulation-evals.mjs --verbose
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSimulationJudgePrompt } from "./judges/simulation-quality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "simulation");
const RESULTS_DIR = path.join(__dirname, "results");

const PROVIDER = process.env.AI_PROVIDER ?? "openai";

const DEAN_MODEL = "claude-sonnet-4-5-20250929";
const AGENT_MODEL = "claude-haiku-4-5-20251001";
const JUDGE_MODEL = "claude-opus-4-5";

const OPENAI_MODEL_MAP = {
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
  "claude-sonnet-4-5-20250929": "gpt-4o",
  "claude-sonnet-4-6": "gpt-4o",
  "claude-opus-4-5": "gpt-4o",
};

const client = PROVIDER === "anthropic"
  ? new Anthropic()
  : (() => {
      const oai = new OpenAI();
      return {
        messages: {
          async create({ model, max_tokens, system, messages, tools }) {
            const hasWebSearch = (tools ?? []).some(
              (t) => t.type === "web_search_20250305"
            );
            const oaiModel = hasWebSearch ? "gpt-4o-search-preview" : (OPENAI_MODEL_MAP[model] ?? "gpt-4o");
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
            return { content: [{ type: "text", text }] };
          },
        },
      };
    })();

const VALID_GOAL_BUCKETS = new Set([
  "mile", "5k", "10k", "half_marathon", "marathon", "trail_race",
  "30k", "50k", "50mi", "100k", "100mi",
  "sprint_tri", "olympic_tri", "70.3", "ironman", "cycling",
  "general_fitness", "return_to_running", "injury_recovery",
]);

// ─────────────────────────────────────────────
// Mirrors summarizeCollected in onboarding/handle/route.ts
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
  if (Array.isArray(data.training_tools) && data.training_tools.length > 0) {
    lines.push(`Training tools: ${data.training_tools.join(", ")}`);
  }
  if (data.terrain_type) lines.push(`Terrain: ${data.terrain_type}`);
  if (data.has_existing_plan != null) lines.push(`Has existing plan: ${data.has_existing_plan ? "yes" : "no"}`);
  if (data.external_plan_description) lines.push(`Current plan: ${data.external_plan_description}`);
  if (data.wants_weekly_recap != null) lines.push(`Wants weekly recap: ${data.wants_weekly_recap ? "yes" : "no"}`);
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
  return lines.join("\n");
}

// ─────────────────────────────────────────────
// Mirrors handleConversation system prompt in onboarding/handle/route.ts
// ─────────────────────────────────────────────
function buildDeanSystemPrompt(collected, stravaContext, isFirstResponse) {
  const collectedStr = summarizeCollected(collected);

  return `${!isFirstResponse ? `This is an ongoing conversation. You already introduced yourself — continue naturally without re-introducing or using first-meeting phrases.\n\n` : ""}You are Coach Dean, an AI running coach onboarding a new athlete entirely over SMS text messages.

Dean's core job: help athletes get faster without getting injured. Every conversation should calibrate both performance and injury risk from the start.

Your job: collect the information below through natural conversation, then signal you're ready with [READY].

WHAT TO COLLECT:
Required before signaling [READY] — for ALL athletes:
- Athlete's name — ask in your FIRST message, combined with the training context question. Never address the athlete as "Athlete" or use a placeholder — if you don't have their name, you must ask.
- Training goal (specific race/event name and type, or general fitness/consistency). If they have no committed race — only aspirational talk like "maybe someday" or "thinking about eventually" — their goal is return_to_running or general_fitness, NOT the race distance.
- Strava — REQUIRED. Ask right after goal is established, BEFORE injury history or any other questions. Strava is the primary data source and answers fitness questions automatically. Do NOT offer a skip option.
- Injury history — REQUIRED FOR ALL ATHLETES. Handled in a dedicated stage after Strava connects — do NOT ask about it here. If the athlete volunteers injury info, acknowledge it briefly and continue.

Additional required fields by situation:
- Race date — required for any named race goal. MANDATORY web_search before stating any date.
- Ultra background (30k+): how many ultras, any trail races — must collect before [READY]
- Goal finish time (mile/5k/10k only): pacing depends entirely on this — ask directly once goal type is confirmed.
- Race goal for trail/mountain races: ask once the race is confirmed — "Are you racing to finish, or is there a time or placement you're targeting?" Don't assume.
- Prior race experience (trail/mountain races): "Have you run [race name] before?" — one question, ask naturally.
- Training days per week: ask if Strava has no data — "How many days a week are you looking to train?" (Don't ask which specific days — the athlete chooses their own schedule. Plans are day-agnostic.)

Optional (collect passively if mentioned — do NOT ask for these):
- Fitness baseline (pace/PR): Strava provides this automatically. Only ask if Strava has no usable race data.
- Current weekly mileage: Strava provides this. Only ask if Strava has no data.
- Strength & cross-training: extract if mentioned naturally.
- Terrain type and training tools: extract passively from context.
- Goal finish time for longer races (half marathon, marathon, trail)
- Other races this season (B/C tune-up races)

WHAT YOU ALREADY KNOW:
${collectedStr || "Nothing yet."}
${stravaContext}

CONVERSATION FLOW:
Everyone gets the same core intake. The order is roughly:
1. First message: intro + ask for their name and what they're working toward in one question
2. Once goal is clear and any race dates are confirmed: ask about Strava. No other questions first.
3. After Strava connects: a dedicated stage handles training analysis and injury intake automatically — you don't need to ask about it.
4. Signal [READY] when name + goal + Strava are confirmed (injury handled in dedicated stage).

EXISTING PLAN (athlete mentions Runna, TrainingPeaks, a coach-written plan, etc.):
Dean works alongside their plan — no competing structure, no rebuilding. Never ask "are you working from a training plan?" as a standalone question. If they volunteer it, acknowledge briefly and continue. Plan context is captured passively and informs how Dean frames coaching.

INSTRUCTIONS:
- Ask ONE question per message. Not two, not a list. If you need multiple things, prioritize and ask the single most important one.
- Do not re-ask for anything listed under "what you already know" above, or anything the user has clearly stated earlier in this conversation.
- Acknowledge what they share before asking the next thing.
- Be warm and specific to their goal. 3–4 sentences per message max.
- Plain text only. No markdown, asterisks, or bullet points.
- Never start a message with just the athlete's name alone on its own line. Use the name naturally within a sentence instead.
- When the athlete tells you their name for the first time, acknowledge it warmly — e.g. "Jake!" or "Hey Jake —" before continuing. Do NOT use "Nice to meet you" or any formal first-meeting phrase.
- React to a race or goal with ONE concrete coaching observation, not generic praise ("great choice!", "exciting challenge!", "big commitment!"). Show you understand what that specific goal demands.
- If they ask a coaching question, answer it briefly, then continue naturally.
- Training days: do NOT ask which days of the week they run. Plans are day-agnostic — the athlete picks their own days. If they mention a weekly count (e.g. "5 days a week"), acknowledge it but don't follow up with "which days".

${isFirstResponse
    ? `- This is your FIRST message. Lead with the Strava/post-run differentiator, then broaden the goal framing beyond just racing. Example: "Hey! I'm Coach Dean — I'll send you a coaching note after every run you log on Strava: what it means, whether to push or back off, and what's coming. My job is to make sure your training actually adds up to something, whether that's a race PR, staying healthy, or just running more consistently." Then close with a single question that asks for BOTH their name AND what they're working toward — e.g. "What's your name, and what are you training for?" Do NOT ask for name and goal as two separate questions — combine them into one. Do NOT use the phrase "SMS running coach" — use "AI running coach" instead.`
    : ""
}

INJURY MENTIONS IN GOALS STAGE:
Injury intake happens in a dedicated stage after Strava connects — do not probe for details here. If the athlete mentions an injury or health concern, acknowledge it briefly ("That's important context — we'll get into that after Strava connects") and continue collecting goal information and asking about Strava. The extraction captures whatever is mentioned automatically.
EXCEPTION — injury_recovery or return_to_running goals: If the athlete's goal IS recovery from an injury or return to running (including messages like "I want to get back to running", "I've been dealing with X for months", "I'm not really training right now"), you must collect injury context before moving on. Ask ONE specific question about the injury — where exactly it hurts, when it flares (during/after runs), or whether they've seen a physio or PT. Do NOT ask about cross-training, general recovery, or other onboarding fields until you understand the injury. Do NOT give advice or suggest treatments — just collect information.

STRAVA:
Ask about Strava after goal is established — BEFORE anything else. Write "[STRAVA_LINK]" as a placeholder — the system will replace it with the actual link. Only ask once.
Keep the pitch simple: "I'll connect to Strava and add a short coaching note to each activity after every run — your friends will see it too." Don't offer an opt-out, don't mention permission checkboxes, don't explain the technical mechanism. The benefit is the coaching note in their feed.
CRITICAL: Even if the athlete volunteers race history or pace info before Strava — do NOT follow up on that data yet. Ask about Strava first.
IMPORTANT: Strava ask must be a standalone turn — don't combine it with other questions. Ask only the Strava question in that message.
PLACEMENT: [STRAVA_LINK] must appear on its own line at the very end of the message.

PRICING QUESTIONS:
If the athlete asks whether this costs money, answer directly: there's a free 7-day trial. Answer in one sentence, then continue onboarding naturally.

DEMONSTRATING VALUE — do this consistently, not just sometimes:
- When the athlete names their race: react with a concrete coaching insight about the timeline or what the race demands — NOT generic praise. Tell them what their window means or what to watch for.
- When you receive a fitness baseline (race PR or easy pace), reflect back one specific insight connecting their data to their goal. Keep it to one sentence.
- When the athlete expresses a doubt, constraint, or frustration, answer it briefly and specifically before asking your next question. This is often the highest-impact moment.
- When they mention a struggle or plateau, dig one level deeper before moving on. One follow-up question shows genuine coaching curiosity.
- Name the specific training mechanism that will address a stated struggle. Specificity is what makes this feel like real coaching.

RACE TARGET FOR TIME-GOAL ATHLETES:
If the athlete has a time goal for a specific distance but has not named a specific race, ask: "Any race on the calendar you're targeting this at?" A specific race date is essential for structuring the training timeline.

CYCLING AND TRIATHLON GOALS:
If the athlete's goal is purely cycling with no running component, be honest: "I specialize in running — I can structure a cycling plan but if pure cycling coaching is your main need, I may not be your best fit. Is running part of the mix at all?"
If the athlete confirms they are cycling-only and not interested in running, wish them well and stop with a single message. One exit message, full stop. Do not acknowledge, apologize, or reply again.
If the athlete is training for a triathlon, clarify your role upfront: "For triathlons I handle the run leg — I'll build your running program and check in after every run workout. For swim and bike you'd want dedicated coaching, but I'll make sure your run is dialed in."

RACE DATE — MANDATORY SEARCH:
The moment an athlete mentions a specific named race, call web_search immediately to find the exact date. Do not state, confirm, or summarize any race date without first searching. Memory dates are frequently wrong, and user-provided dates are often wrong too — ALWAYS search, even if the athlete gives you a specific date. This is non-negotiable.
After searching: if the search result shows the race date is within the next 6 weeks AND the user is starting a new coaching relationship, do NOT proceed — ask first: "That's only [X] weeks away — are you looking for race-week prep for this year, or building toward [next year]?"
After searching: if the user has not stated a specific date (only a month or vague timeframe), confirm the search result with them before proceeding.
FIRST-OF-MONTH GUARD: If the only date information you have is a month, do NOT proceed with the 1st of that month as a placeholder. Stop and ask: "Do you know the exact date?"

SIGNALING READY:
READY CHECK — do this before every reply: scan WHAT YOU ALREADY KNOW for these three items:
1. Name ✓
2. Goal (+ race date if a named race) ✓
3. Strava connected ✓ (shown as "STRAVA: Connected" in the context above)

Injury history is collected in a dedicated injury intake stage AFTER Strava connects — do NOT wait for it here.

If all three are present: signal [READY] in THIS message. Do not ask ANY follow-up question. Write a synthesis wrap-up that references the specific race (or goal), the timeline (how many weeks away), and one key observation from Strava or the conversation — then [READY] on its own line. Example: "Got it — Snowbird in 6 weeks, solid 25 miles/week base. First coaching note lands after your next run." Keep it to 1–2 sentences.

The [READY] tag is stripped before sending — do not reference or explain it. Do not include [READY] if you still need to ask something essential.
[READY] IS REQUIRED ON ANY WRAP-UP: If your message says anything like "you're all set", "ready to kick off", "we're good to go", or otherwise signs off without a question, you MUST include [READY] on its own line.
Name is always required — if the user hasn't told you their name yet, ask before signaling [READY].
CRITICAL — [READY] means zero open questions: [READY] can only appear in a message that contains NO questions of any kind.

ULTRA AND INJURY GOALS — extra required fields:
For ultra goals (30k, 50k, 50mi, 100k, 100mi): you MUST ask about their ultra/trail race history before signaling [READY].
For return_to_running or injury_recovery goals: you MUST ask about the injury/limitation and current status before [READY].`;
}

// ─────────────────────────────────────────────
// Mirrors extractFields + merge in onboarding/handle/route.ts
// ─────────────────────────────────────────────
function extractJSON(text) {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1].trim();
  const jsonBlock = text.match(/\{[\s\S]*\}/);
  if (jsonBlock) return jsonBlock[0];
  return text;
}

async function extractFields(history, today) {
  const transcript = history
    .map((m) => `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 600,
    system: `Extract training data from this conversation. Return ONLY valid JSON. Today is ${today}.

Output format (include only fields that are clearly stated — use null for anything not mentioned):
{
  "name": string | null,
  "goal": "mile"|"5k"|"10k"|"half_marathon"|"marathon"|"trail_race"|"30k"|"50k"|"50mi"|"100k"|"100mi"|"sprint_tri"|"olympic_tri"|"70.3"|"ironman"|"cycling"|"general_fitness"|"return_to_running"|"injury_recovery" | null,
  "race_name": string | null,
  "race_date": "YYYY-MM-DD" | null,
  "goal_distance_miles": number | null,
  "goal_time_minutes": number | null,
  "training_days": ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] (any subset) | null,
  "days_per_week": number | null,
  "easy_pace": "M:SS" | null,
  "weekly_miles": number | null,
  "recent_race_distance_km": number | null,
  "recent_race_time_minutes": number | null,
  "injury_notes": string | null,
  "ultra_race_history": string | null,
  "other_races": [{"name": string|null, "date": "YYYY-MM-DD"|null, "priority": "B"|"C", "goal": string|null}] | null,
  "timezone": string | null,
  "strava_skipped": true | null
}

Rules:
- Only extract data clearly stated in the conversation. Do not infer or guess.
- goal: use "trail_race" for trail/mountain races that aren't standard road distances. Use standard buckets only for road races at those distances. IMPORTANT: if the athlete says they have no committed race — only aspirational/eventual talk ("maybe a marathon someday", "thinking about eventually") — use "return_to_running" or "general_fitness", NOT the race distance. The goal must reflect what they are actually training for right now, not what they might do later.
- external_plan_description: capture a brief factual summary when the athlete describes a training plan they're currently following (plan source/name, current week, weekly mileage). E.g. "Runna 16-week half marathon plan, week 6, ~35mi/week". Null if no current plan. Do NOT capture a plan Dean is going to build. (has_existing_plan / wants_plan are NOT extracted here — they come from Dean's [MODE:...] tag, which the runner parses separately.)
- training_days: lowercase full names only (e.g. ["tuesday","thursday","saturday","sunday"])
- goal_time_minutes: total float minutes. "1:30" → 90.0, "17:40" → 17.67, "2:05:00" → 125.0
- race_date: use the most specific date mentioned. If a specific date (day + month) was stated by either participant, use that exact date. If only a month was given with no specific day (e.g. "in June", "sometime in July"), return null — do NOT default to the 1st of that month. Only extract a first-of-month date if someone explicitly said "the 1st" or "June 1st". Today is ${today}.
- recent_race_distance_km: distance of their most-cited PR or recent race (not the goal race)
- recent_race_time_minutes: finishing time of that race in total float minutes. M:SS format means minutes:seconds — "18:45" → 18.75, "38:20" → 38.33. H:MM:SS or H:MM format — "1:05:30" → 65.5, "1:52" → 112.0. Never convert M:SS as if the first number were hours.
- timezone: IANA string when a location is mentioned (e.g. "Chicago, IL" → "America/Chicago", "Seattle, WA" → "America/Los_Angeles", "Provo, UT" → "America/Denver")
- other_races: only B/C secondary races, not the main A race.
- ultra_race_history: summarize any ultra or trail race background mentioned (e.g. "3 marathons PR 3:45, 2 trail halves, no prior ultras"). Populate whenever the athlete describes their racing/ultra history, even if they say they have none.
- strava_skipped: set to true if the athlete explicitly says they don't have Strava, won't use it, or skip it. Leave null if the topic hasn't come up.`,
    messages: [{ role: "user", content: transcript }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
  try {
    return JSON.parse(extractJSON(text));
  } catch {
    return {};
  }
}

function mergeCollected(existing, extracted) {
  const merged = { ...existing };
  for (const [k, v] of Object.entries(extracted)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    merged[k] = v;
  }
  if (merged.goal && !VALID_GOAL_BUCKETS.has(merged.goal)) {
    delete merged.goal;
  }
  return merged;
}

// ─────────────────────────────────────────────
// Get Dean's response for a given history
// ─────────────────────────────────────────────
async function getDeanResponse(collected, stravaContext, history, isFirstResponse) {
  const systemPrompt = buildDeanSystemPrompt(collected, stravaContext, isFirstResponse);

  const response = await client.messages.create({
    model: DEAN_MODEL,
    max_tokens: 600,
    system: systemPrompt,
    messages: history,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });

  // Mirror route.ts: take only post-search text blocks
  // The hosted web_search tool returns "server_tool_use" blocks (not "tool_use")
  let rawText = "";
  let lastToolIdx = -1;
  for (let i = 0; i < response.content.length; i++) {
    const t = response.content[i].type;
    if (t === "tool_use" || t === "server_tool_use") lastToolIdx = i;
  }
  for (let i = lastToolIdx + 1; i < response.content.length; i++) {
    if (response.content[i].type === "text") rawText += response.content[i].text;
  }
  if (!rawText.trim()) {
    for (const b of response.content) {
      if (b.type === "text") rawText += b.text;
    }
  }

  return rawText.trim();
}

// ─────────────────────────────────────────────
// Get user agent response (Haiku playing the persona)
// ─────────────────────────────────────────────
async function getUserAgentResponse(persona, history) {
  const transcript = history
    .map((m) => `${m.role === "assistant" ? "Coach Dean" : "You"}: ${m.content}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 150,
    system: `${persona.user_agent_prompt}

You are responding via SMS. Keep your response brief and natural — 1-3 sentences at most. Only respond to what was just asked. Do not answer questions that weren't asked.`,
    messages: [{ role: "user", content: `Conversation so far:\n\n${transcript}\n\nReply as yourself (the athlete) to Coach Dean's last message:` }],
  });

  return response.content[0]?.type === "text" ? response.content[0].text.trim() : "ok";
}

// ─────────────────────────────────────────────
// Main simulation loop
// ─────────────────────────────────────────────
async function runSimulation(fixture, verbose) {
  const { persona, today = "2026-04-06", max_turns = 12 } = fixture;

  let collected = {};
  let stravaContext = "STRAVA: Not connected yet.";
  const history = [{ role: "user", content: persona.opening_message }];
  let deanTurns = 0;
  let readyFired = false;

  if (verbose) {
    console.log(`\n  ${"─".repeat(60)}`);
    console.log(`  User: ${persona.opening_message}`);
  }

  while (deanTurns < max_turns && !readyFired) {
    const isFirstResponse = deanTurns === 0;

    // Get Dean's response
    const rawDeanResponse = await getDeanResponse(collected, stravaContext, history, isFirstResponse);

    const wantsStravaLink = /\[STRAVA_LINK\]/i.test(rawDeanResponse);
    const wantsDashboardLink = /\[DASHBOARD_LINK\]/i.test(rawDeanResponse);
    // [DASHBOARD_LINK] is implicit [READY] — matches route.ts parity.
    const isReady = /\[READY\]/i.test(rawDeanResponse) || wantsDashboardLink;

    // Parse [MODE:...] tag — tag-driven, matches route.ts parity.
    const modeMatch = rawDeanResponse.match(/\[MODE:(FROM_SCRATCH|COMPLEMENT|NO_PLAN)\]/i);
    if (modeMatch) {
      const mode = modeMatch[1].toUpperCase();
      if (mode === "FROM_SCRATCH") collected = mergeCollected(collected, { has_existing_plan: false, wants_plan: true });
      else if (mode === "COMPLEMENT") collected = mergeCollected(collected, { has_existing_plan: true, wants_plan: false });
      else if (mode === "NO_PLAN") collected = mergeCollected(collected, { has_existing_plan: false, wants_plan: false });
    }

    // Clean signals from displayed text
    let deanText = rawDeanResponse
      .replace(/\[READY\]/gi, "")
      .replace(/\[STRAVA_LINK\]/gi, "")
      .replace(/\[MODE:(?:FROM_SCRATCH|COMPLEMENT|NO_PLAN)\]/gi, "")
      .replace(/\[DASHBOARD_LINK\]/gi, "https://coachdean.ai/dashboard?token=sim")
      .trim();

    if (wantsStravaLink) {
      deanText += `\n\nhttps://coachdean.ai/api/auth/strava?userId=sim\n\nNo Strava? Just reply "skip".`;
    }

    history.push({ role: "assistant", content: deanText });
    deanTurns++;

    if (verbose) {
      console.log(`\n  Dean [${deanTurns}]: ${deanText}`);
    }

    if (isReady) {
      readyFired = true;
      // Final extraction
      const extracted = await extractFields(history, today);
      collected = mergeCollected(collected, extracted);
      break;
    }

    // Handle Strava link
    if (wantsStravaLink && persona.strava_connected) {
      // Simulate OAuth callback — inject Strava connected message
      const stravaMsg = persona.strava_summary || "Strava connected! I can see your training history — that's great context.";
      history.push({ role: "assistant", content: stravaMsg });
      collected = mergeCollected(collected, { strava_connected: true });
      stravaContext = fixture.persona.strava_context_after_connect
        ?? "STRAVA: Connected. No races found for VDOT calculation — ask for a recent race time or PR to set training paces.";

      if (verbose) {
        console.log(`\n  [Strava OAuth simulated]`);
        console.log(`  Dean (auto): ${stravaMsg}`);
      }

      // User agent responds to Strava connected message
      const userReply = await getUserAgentResponse(persona, history);
      history.push({ role: "user", content: userReply });

      if (verbose) console.log(`\n  User: ${userReply}`);

    } else if (wantsStravaLink && !persona.strava_connected) {
      // Persona doesn't have Strava — simulate skip
      history.push({ role: "user", content: "skip" });
      collected = mergeCollected(collected, { strava_skipped: true });
      stravaContext = "STRAVA: User skipped Strava. Collect mileage + pace data manually.";

      if (verbose) console.log(`\n  User: skip`);

    } else {
      // Normal user agent response
      const userReply = await getUserAgentResponse(persona, history);
      history.push({ role: "user", content: userReply });

      if (verbose) console.log(`\n  User: ${userReply}`);
    }

    // Extract fields after each full exchange
    const extracted = await extractFields(history, today);
    collected = mergeCollected(collected, extracted);

    if (verbose) {
      const collectedKeys = Object.keys(collected).filter(k => collected[k] !== null && collected[k] !== undefined);
      console.log(`  [collected: ${collectedKeys.join(", ")}]`);
    }
  }

  // Build transcript for judge
  const transcript = history
    .map((m, i) => `[${m.role === "user" ? "User" : "Dean"}]: ${m.content}`)
    .join("\n\n");

  return { transcript, finalCollected: collected, deanTurns, readyFired };
}

// ─────────────────────────────────────────────
// Run one fixture end-to-end
// ─────────────────────────────────────────────
async function runEval(fixture, verbose) {
  let simResult;
  let simError = null;

  try {
    simResult = await runSimulation(fixture, verbose);
  } catch (err) {
    simError = err.message;
    console.error(`  [${fixture.id}] Simulation error:`, err.message);
    return {
      fixture_id: fixture.id,
      category: fixture.category,
      description: fixture.description,
      transcript: null,
      final_collected: null,
      dean_turns: -1,
      ready_fired: false,
      judgment: null,
      score: -1,
      flags: ["simulation_failed"],
      error: simError,
    };
  }

  const { transcript, finalCollected, deanTurns, readyFired } = simResult;

  // Judge the full transcript
  const judgePromptStr = buildSimulationJudgePrompt(fixture, transcript, finalCollected, deanTurns, readyFired);
  let judgment = null;
  let judgeError = null;

  try {
    const judgeMsg = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 800,
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
    console.error(`  [${fixture.id}] Judge error:`, err.message);
  }

  return {
    fixture_id: fixture.id,
    category: fixture.category,
    description: fixture.description,
    transcript,
    final_collected: finalCollected,
    dean_turns: deanTurns,
    ready_fired: readyFired,
    judgment,
    score: judgment?.overall_score ?? -1,
    flags: [...(judgment?.flags ?? []), ...(judgment?.field_errors ?? []), ...(judgment?.repetition_examples ?? [])],
    error: judgeError || null,
  };
}

// ─────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const fixtureFilter = args.indexOf("--fixture") !== -1 ? args[args.indexOf("--fixture") + 1] : null;
  const verbose = args.includes("--verbose");

  const fixtureFiles = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort();
  let fixtures = fixtureFiles.map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8")));

  if (fixtureFilter) {
    fixtures = fixtures.filter((f) => f.id === fixtureFilter);
    if (fixtures.length === 0) {
      console.error(`No fixture found with id: ${fixtureFilter}`);
      process.exit(1);
    }
  }

  console.log(`\nRunning ${fixtures.length} simulation${fixtures.length !== 1 ? "s" : ""}...\n`);

  const results = [];
  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.id} (${fixture.persona.name}) ... `);
    const result = await runEval(fixture, verbose);
    results.push(result);

    const score = result.score;
    const scoreStr = score === -1 ? "ERROR" : `${score}/10`;
    const status = score >= 7 ? "✓" : score === -1 ? "✗" : "⚠";
    const turns = result.dean_turns >= 0 ? ` [${result.dean_turns} turns]` : "";
    const ready = result.ready_fired ? "" : " [NO READY]";
    console.log(`${status} ${scoreStr}${turns}${ready}`);
    if (result.judgment?.score_rationale) {
      console.log(`    → ${result.judgment.score_rationale}`);
    }
    if (result.flags?.length > 0) {
      for (const f of result.flags.slice(0, 3)) {
        console.log(`    ⚠ ${f}`);
      }
    }
    if (result.error) console.log(`    Error: ${result.error}`);
  }

  // Save results
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const resultFile = path.join(RESULTS_DIR, `simulation-${timestamp}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({ timestamp, results }, null, 2));
  console.log(`\nResults saved to ${path.relative(process.cwd(), resultFile)}`);

  const scored = results.filter((r) => r.score >= 0);
  const passed = scored.filter((r) => r.score >= 7);
  const avg = scored.length > 0
    ? (scored.reduce((s, r) => s + r.score, 0) / scored.length).toFixed(1)
    : "N/A";

  console.log(`\n${"─".repeat(55)}`);
  console.log(`Simulations: ${passed.length}/${scored.length} passed  |  avg ${avg}/10`);
  if (scored.length > 0) {
    for (const r of scored) {
      const icon = r.score >= 7 ? "✓" : "✗";
      console.log(`  ${icon} ${r.fixture_id}: ${r.score}/10 (${r.dean_turns} turns, ready=${r.ready_fired})`);
    }
  }
  console.log();

  const failed = scored.filter((r) => r.score < 7);
  const errored = results.filter((r) => r.score === -1);
  if (failed.length > 0 || errored.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
