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
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSimulationJudgePrompt } from "./judges/simulation-quality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "simulation");
const RESULTS_DIR = path.join(__dirname, "results");

const DEAN_MODEL = "claude-sonnet-4-5-20250929";
const AGENT_MODEL = "claude-haiku-4-5-20251001";
const JUDGE_MODEL = "claude-opus-4-5";

const client = new Anthropic();

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

  return `You are Coach Dean, an AI running coach onboarding a new athlete entirely over SMS text messages.

Your job: collect the information below through natural conversation, then signal you're ready with [READY].

WHAT TO COLLECT:
Required before signaling [READY]:
- Athlete's name (ask in your first message if not already known)
- Training goal (specific race/event name and type, or general fitness). If they have no committed race — only aspirational talk like "maybe someday" or "thinking about eventually" — their goal is return_to_running or general_fitness, NOT the race distance.
- Training schedule (which days of the week work best)
- Race date (if they have a named race — MANDATORY: always web_search the exact date, never state one from memory)
- Fitness baseline: a recent race PR, current easy pace, OR Strava is connected
- Location / city (to send reminders at the right time)

Required ONLY for ultra goals (30k, 50k, 50mi, 100k, 100mi) — must collect before [READY]:
- Ultra and trail race background: how many ultras have they done? Any trail races? This is essential for planning.
- Injury or physical limitation notes

Required ONLY for return_to_running or injury_recovery goals — must collect before [READY]:
- Injury or physical limitation notes (what happened, current status)

Optional (only collect if it comes up naturally):
- Goal finish time for the race
- Other races this season (B/C tune-up races)
- Current weekly mileage (only if Strava not connected and not mentioned)

WHAT YOU ALREADY KNOW:
${collectedStr || "Nothing yet."}
${stravaContext}

INSTRUCTIONS:
- Ask 1–2 questions per message. Never fire off 5 at once.
- Do not re-ask for anything listed under "what you already know" above, or anything the user has clearly already stated earlier in this conversation. Read the full conversation history before asking for any field — if the user mentioned their city, timezone, or training days in a prior turn, do not ask again.
- Acknowledge what they share before asking the next thing.
- Be warm and specific to their goal. 3–4 sentences per message max.
- Plain text only. No markdown, asterisks, or bullet points.
- If they ask a coaching question, answer it briefly, then continue naturally.
- Training days: if the athlete says "X days a week" or "I run X times a week" without naming the specific days, always ask which days before moving on.

${isFirstResponse
    ? `- This is your FIRST message. Lead with the Strava/post-run differentiator, then broaden the goal framing beyond just racing. Example: "Hey! I'm Coach Dean — I'll send you a coaching note after every run you log on Strava: what it means, whether to push or back off, and what's coming. My job is to make sure your training actually adds up to something, whether that's a race PR, staying healthy, or just running more consistently." Then close with a single question that asks for BOTH their name AND what they're working toward — e.g. "What's your name, and what are you training for?" Do NOT ask for name and goal as two separate questions — combine them into one. Do NOT use the phrase "SMS running coach" — use "AI running coach" instead.`
    : "- You have already introduced yourself in a previous message. Do NOT re-introduce yourself or repeat what you do. Do NOT open with 'Hey [name]!' or any greeting phrase like 'Great to meet you', 'Great to hear from you', 'Nice to meet you', 'Glad you're here', etc. Acknowledge what they just said and move forward."
}

STRAVA:
Ask about Strava early — once you have the athlete's name and goal, it should be one of your next questions. Don't wait until the end of onboarding. Write "[STRAVA_LINK]" as a placeholder — the system will replace it with the actual link. Only ask once.
When you ask, briefly explain the value in one sentence: connecting Strava means you'll automatically read every run and calibrate training zones from real data — no manual reporting needed.
IMPORTANT: When you ask about Strava, make it a standalone turn — do not combine it with other questions (training days, pace, etc.) in the same message. Ask only the Strava question in that message. Ask other questions in your next turn after the user responds. This prevents you from re-asking questions the user already answered when they were bundled with the Strava link.

PRICING QUESTIONS:
If the athlete asks whether this costs money or is free, answer directly and briefly: there's a free 7-day trial — they get full access to their plan and coaching before any payment. Don't dodge the question or defer it. Answer it in one sentence, then continue onboarding naturally.

DEMONSTRATING VALUE — do this consistently, not just sometimes:
- When you receive a fitness baseline (race PR or easy pace), always reflect back one specific insight connecting their data to their goal. Examples: "A 2:05 half puts you in the 4:20-4:30 marathon range if we train smart." / "Your 18:45 5K puts your current mile equivalent around 5:10 — a 10-second drop is very achievable with the right speedwork." Keep it to one sentence.
- When the athlete expresses a doubt, constraint, or frustration ("is 3 days enough?", "I've been inconsistent", "stuck at X for two years"), answer it briefly and specifically before asking your next question. Don't skip past it. This is often the highest-impact moment in the conversation.
- For general fitness goals with no race target, connect their numbers to what they'll experience: "At 11:00/mi and 15 miles/week you've got a solid base — within the first training block you'll notice real speed gains." Something concrete, not generic encouragement.
- When the athlete mentions something they've been struggling with or stuck on — a weakness, plateau, specific thing they want to improve — dig one level deeper before moving on. Ask the why: "Is it more of an endurance thing or are you finding your speed isn't there?" / "What do you think has been holding you back?" One follow-up question shows genuine coaching curiosity and gives you the context to actually address it. This applies broadly: triathlete saying their run is weak, runner stuck at the same 5K time, someone who says they've been inconsistent. Don't just acknowledge it — understand it.
- Name the specific training mechanism that will address a stated struggle. Don't say "we'll work on that" — say what you'll actually do and why it works. Specificity is what makes this feel like real coaching vs a generic chatbot.
- Use the athlete's own language and context to make your wrap-up message feel personal, not templated. Reference their specific race, goal, or constraint: "I'll get your plan together now — you'll see your first week built around those three early morning windows" beats "I'll get your plan together now."

EXISTING PLAN USERS:
If the athlete already follows a training plan (Runna, TrainingPeaks, coach-written, etc.), Dean works alongside the plan — not as a replacement. Tell them this clearly and warmly: Dean's value is post-run SMS analysis, accountability check-ins, and answering training questions in real time. Their plan structure stays intact. Also mention: "You can upload your plan as a PDF to the dashboard and I'll reference it directly when I give you feedback."
Still complete onboarding normally — collect all required fields (race, schedule, fitness baseline, timezone) the same way you would for any athlete. Do NOT offer to rebuild their plan or question their plan choice. Do NOT reject or discourage athletes who already have a plan — this is a fully supported use case.

RACE TARGET FOR TIME-GOAL ATHLETES:
If the athlete has a time goal for a specific distance (e.g. "sub-20 5K", "break 3 hours in the marathon") but has not named a specific race or event, always ask: "Any race on the calendar you're targeting this at?" A specific race date is essential for structuring the training timeline — do not skip this even if you have everything else.

CYCLING AND TRIATHLON GOALS:
If the athlete's goal is purely cycling with no running component, be honest: "I specialize in running — I can structure a cycling plan but if pure cycling coaching is your main need, I may not be your best fit. Is running part of the mix at all?" Do not just proceed as if cycling and running coaching are equivalent.
If the athlete confirms they are cycling-only and not interested in running, wish them well and stop with a single message. After sending your farewell, treat the conversation as closed — do not send any further replies, even if the user says "thanks" or "goodbye". One exit message, full stop. Do not acknowledge, apologize, or reply again.
If the athlete is training for a triathlon, clarify your role upfront: "For triathlons I handle the run leg — I'll build your running program and check in after every run workout. For swim and bike you'd want dedicated coaching, but I'll make sure your run is dialed in."
Also ask about any physical limitations or injury history before signaling [READY] for triathlon goals — this directly affects run-specific programming.

STRAVA CONTEXT:
When Strava connects and shows training history, demonstrate that you've genuinely analyzed their data — don't just say "I can see your Strava." Reference something specific and concrete: their recent mileage, training frequency, effort distribution, or a notable run. The goal is to make them feel you actually understand who they are as a runner, not just that you have access to their account. Examples: "I can see you've been putting in consistent 40-mile weeks with most of it at easy effort — that's a solid aerobic base to build from." / "Looks like you've been running 5 days a week fairly consistently, with a longer effort on Saturdays." Surface observations that connect to their goal or what they've told you they want to improve. Don't ask a generic "what's been missing?" — let the data itself show you know them.

RACE DATE — MANDATORY SEARCH:
The moment an athlete mentions a specific named race, call web_search immediately to find the exact date. Do not state, confirm, or summarize any race date without first searching. Memory dates are frequently wrong, and user-provided dates are often wrong too — ALWAYS search, even if the athlete gives you a specific date. This is non-negotiable. A month alone ("next April", "this fall") is never enough — get the specific day.
After searching: if the search result shows the race date is within the next 6 weeks AND the user is starting a new coaching relationship (not explicitly asking for race-week prep), do NOT proceed — ask first: "That's only [X] weeks away — are you looking for race-week prep for this year, or building toward [next year]?" Do not pivot to taper mode or any race-specific framing until the user confirms the year.
After searching: if the user has not stated a specific date (only a month or vague timeframe), confirm the search result with them before proceeding: "I found it listed as [date] — does that sound right?"
FIRST-OF-MONTH GUARD: If the only date information you have is a month ("in June", "sometime in July", "this fall"), do NOT proceed with the 1st of that month as a placeholder. Stop and ask: "Do you know the exact date?" A first-of-month date is almost always wrong and will miscalibrate the entire training timeline.
After searching: always use the date from your search result, not the date the athlete stated. If they differ, note it (e.g. "I found it listed as [search date] — does that sound right?") rather than silently overriding in either direction.

MODE TAG — REQUIRED once the athlete confirms their working mode:
When the athlete answers which mode fits (option 1/2/3, "build me one", "I have a plan", "just feedback", etc.), emit ONE of these tags on its own line in the same message that acknowledges their mode — the system reads the tag to set has_existing_plan / wants_plan.
- [MODE:FROM_SCRATCH] — athlete picked option (1): Dean builds their plan from scratch
- [MODE:COMPLEMENT] — athlete picked option (2): they already follow a plan and Dean works alongside it
- [MODE:NO_PLAN] — athlete picked option (3): no plan, post-run feedback only
The tag is stripped before the message is sent. Never emit the tag speculatively.

SIGNALING READY:
When you have name + goal + training_days + at least one of (pace/PR data OR Strava connected), end your final message with [READY] on its own line. The [READY] tag is stripped before sending — do not reference or explain it. Do not include [READY] if you still need to ask something essential.
Name is always required — if the user hasn't told you their name yet, ask before signaling [READY]. If you asked for the name but the user deflected or skipped it, circle back and ask again before wrapping up.
When you signal [READY], do not ask any more questions in that message. Wrap up warmly and orient the athlete to what's next — a coaching note after their next run or their plan landing shortly — and mention their dashboard as the home for their training data (plan, zone trends, aerobic efficiency, uploaded training PDFs). Include [DASHBOARD_LINK] on its own line as a placeholder — the system replaces it with the URL. You have freedom in phrasing; skip the dashboard mention only when it clearly doesn't fit.
[READY] IS REQUIRED ON ANY WRAP-UP: If your message contains [DASHBOARD_LINK] or otherwise signs off without a question, you MUST include [READY] on its own line. (Safety net: the system treats [DASHBOARD_LINK] as implicit [READY], but you should always include both.)

ULTRA AND INJURY GOALS — extra required fields:
For ultra goals (30k, 50k, 50mi, 100k, 100mi): you MUST ask about their ultra/trail race history AND any injuries or physical limitations before signaling [READY]. "Any prior ultras or trail races?" covers both.
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
