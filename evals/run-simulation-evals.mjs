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

const PROVIDER = process.env.AI_PROVIDER ?? "anthropic";

const ULTRA_GOALS = ["30k", "50k", "50mi", "100k", "100mi"];

const DEAN_MODEL = "claude-sonnet-4-5-20250929";
const AGENT_MODEL = "claude-haiku-4-5-20251001";
// Sonnet judges too — Opus was overkill for this rubric-style scoring and cost
// meaningfully more per run with no measurable quality difference.
const JUDGE_MODEL = "claude-sonnet-4-5-20250929";

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
function summarizeCollected(data, today) {
  const nowMs = new Date(today + "T12:00:00Z").getTime();
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
    const daysUntil = Math.round(
      (new Date(data.race_date + "T12:00:00Z").getTime() - nowMs) / (24 * 60 * 60 * 1000)
    );
    const weeksUntil = Math.round(daysUntil / 7);
    // Mirrors the 2026-07-22 route.ts fix: one deterministic countdown, stated once, so every
    // message (goals stage, Strava-connected analysis, injury intake, completion) agrees.
    lines.push(`Race date: ${formatted} (${daysUntil} days / ${weeksUntil} week${weeksUntil !== 1 ? "s" : ""} away — always use this exact figure when stating the countdown; never recompute it from the date yourself)`);
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
  if (data.injury_history) lines.push(`Injury history: ${data.injury_history}`);
  if (data.current_niggles) lines.push(`Current niggles: ${data.current_niggles}`);
  if (data.injury_management) lines.push(`What they're doing for it: ${data.injury_management}`);
  if (data.reported_during) lines.push(`Injury timing: pain reported ${data.reported_during} runs`);
  if (data.injury_pain_character === "localized_or_rest_pain") lines.push(`RED FLAG: shin/tibia pain described as one specific spot or present at rest — possible stress fracture. Do not recommend continuing to run or add load until checked by a doctor.`);
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
function buildDeanSystemPrompt(collected, stravaContext, isFirstResponse, today) {
  const collectedStr = summarizeCollected(collected, today);

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
Do NOT write your own pitch sentence about connecting Strava (e.g. "I'll read your runs and text you a coaching note after each one") — the system appends that line automatically right after the link. Writing your own version will make it appear twice. Coaching notes are sent by SMS, not written back to the Strava activity — never say "add a note to your activity/Strava" or similar. Just lead naturally into [STRAVA_LINK]; a short transition or nothing at all before the placeholder is fine. Don't offer an opt-out, don't mention permission checkboxes, don't explain the technical mechanism, and don't mention friends seeing anything.
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
NAME COLLISION GUARD: Search results sometimes contain a different race with a confusingly similar name (e.g. same venue, different weekend — "Rocky Raccoon" vs. "Rocky 50"). Only use a result whose name matches what the athlete actually said. If the closest match isn't an exact name match, do not "correct" the athlete's date — ask them to confirm which race they mean instead.
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
  "injury_history": string | null,
  "current_niggles": string | null,
  "injury_management": string | null,
  "reported_during": "during"|"after"|"both" | null,
  "active_injury": boolean | null,
  "injury_severity": "mild"|"moderate"|"severe" | null,
  "injury_body_part_current": string | null,
  "injury_pain_character": "diffuse"|"localized_or_rest_pain" | null,
  "ultra_race_history": string | null,
  "other_races": [{"name": string|null, "date": "YYYY-MM-DD"|null, "priority": "B"|"C", "goal": string|null}] | null,
  "timezone": string | null,
  "strava_skipped": true | null
}

Rules:
- injury_history: historical injuries the athlete has recovered from — not current issues.
- current_niggles: current aches or pain being managed right now.
- injury_management: what the athlete is doing for a current injury (PT, rest, ice, etc.) — only from their own words.
- reported_during: when the pain occurs relative to running — 'during', 'after', or 'both'.
- active_injury: true if the athlete describes a CURRENT injury they're managing right now. False/null for historical/resolved injuries.
- injury_severity: mild=noticeable but running is UNCHANGED — same distance and effort as normal, just aware of it. moderate=training has ALREADY changed because of it — cutting runs short, skipping sessions, reducing pace/distance, or it's been going on for multiple weeks without resolving. severe=cannot run at all right now. If the athlete describes any actual change to their running (shorter runs, skipped days, reduced volume) or a persistent multi-week issue, that is moderate, not mild — mild is reserved for "I notice it but haven't changed anything."
- injury_body_part_current: body part of the CURRENT active injury. ALWAYS include laterality (left/right/bilateral) whenever the athlete states it — e.g. if they say "my left hamstring", extract "left hamstring", not just "hamstring". Never drop the side. Null for historical injuries.
- injury_pain_character: for shin/tibia pain only — 'diffuse' if the athlete has EXPLICITLY described the pain as spread along the bone AND said it eases with rest. A bare label like "shin splints" is NOT enough on its own — a self-diagnosis doesn't mean the actual pain character was described. 'localized_or_rest_pain' if one specific painful spot or pain even at rest/walking/night (possible stress fracture). Null unless the athlete has actually described the location/character of the pain.
- Only extract data clearly stated in the conversation. Do not infer or guess.
- goal: use "trail_race" for trail/mountain races that aren't standard road distances. Use standard buckets only for road races at those distances. IMPORTANT: if the athlete says they have no committed race — only aspirational/eventual talk ("maybe a marathon someday", "thinking about eventually") — use "return_to_running" or "general_fitness", NOT the race distance. The goal must reflect what they are actually training for right now, not what they might do later.
- external_plan_description: capture a brief factual summary when the athlete describes a training plan they're currently following (plan source/name, current week, weekly mileage). E.g. "Runna 16-week half marathon plan, week 6, ~35mi/week". Null if no current plan. Do NOT capture a plan Dean is going to build. (has_existing_plan / wants_plan are NOT extracted here — they come from Dean's [MODE:...] tag, which the runner parses separately.)
- training_days: lowercase full names only (e.g. ["tuesday","thursday","saturday","sunday"]). ONLY extract when the athlete names specific day(s). A bare frequency ("3x a week", "three days a week") is NOT training_days — that goes in days_per_week instead. Do NOT guess or invent which specific days those runs fall on. Null unless specific days were actually named.
- goal_time_minutes: total float minutes. "1:30" → 90.0, "17:40" → 17.67, "2:05:00" → 125.0
- race_date: use the most specific date mentioned. If a specific date (day + month) was stated by either participant, use that exact date. If only a month was given with no specific day (e.g. "in June", "sometime in July"), return null — do NOT default to the 1st of that month. Only extract a first-of-month date if someone explicitly said "the 1st" or "June 1st". Today is ${today}.
- recent_race_distance_km: distance of their most-cited PR or recent race (not the goal race)
- recent_race_time_minutes: finishing time of that race in total float minutes. M:SS format means minutes:seconds — "18:45" → 18.75, "38:20" → 38.33. H:MM:SS or H:MM format — "1:05:30" → 65.5, "1:52" → 112.0. Never convert M:SS as if the first number were hours.
- timezone: IANA string when a location is mentioned (e.g. "Chicago, IL" → "America/Chicago", "Seattle, WA" → "America/Los_Angeles", "Provo, UT" → "America/Denver")
- other_races: only B/C secondary races, not the main A race.
- ultra_race_history: summarize the athlete's actual racing background (marathons run, trail races done, prior ultras, or explicitly no prior ultras) ONLY when they've described it themselves. The goal itself being "first ultra" is NOT background — do not infer "no prior ultras" just because the athlete called it their first ultra or said they're new to the distance. Null until the athlete has actually described what races (if any) they've run before.
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

const INJURY_ACTION = {
  hamstring: "leg swings and walking lunges before your next run",
  "it band": "side-lying leg raises or banded walks before each run",
  itb: "side-lying leg raises or banded walks before each run",
  knee: "glute activation — clamshells or bridges — before your next run",
  achilles: "calf drops (straight + bent knee) after your next run",
  calf: "calf drops after your next run",
  shin: "reduce intensity for the next few days and ice if tender to touch",
  hip: "hip flexor stretch and single-leg glute work before your next run",
  plantar: "foot rolling and calf stretches first thing in the morning",
};
function getInjuryAction(bodyPart) {
  const lower = (bodyPart || "").toLowerCase();
  for (const [key, action] of Object.entries(INJURY_ACTION)) {
    if (lower.includes(key)) return action;
  }
  return "an easy warm-up before your next run";
}

// ─────────────────────────────────────────────
// Mirrors handleDataAnalysis's system prompt in onboarding/handle/route.ts —
// fires once, right after Strava connects, before the injury_intake stage.
// ─────────────────────────────────────────────
function buildStravaAnalysisPrompt(collected, stravaContext, firstName, today) {
  const raceName = collected.race_name;
  const raceDate = collected.race_date;
  const goal = collected.goal;
  const nowMs = new Date(today + "T12:00:00Z").getTime();

  let raceContext = "";
  if (raceName && raceDate) {
    const weeksUntil = Math.round(
      (new Date(raceDate + "T12:00:00Z").getTime() - nowMs) / (7 * 24 * 60 * 60 * 1000)
    );
    raceContext = `${raceName} on ${raceDate} (${weeksUntil} week${weeksUntil !== 1 ? "s" : ""} away)`;
  } else if (goal) {
    raceContext = goal.replace(/_/g, " ");
  }

  const injuryAlreadyCollected = !!(collected.injury_history || collected.current_niggles || collected.injury_notes);
  const injuryContext = [collected.current_niggles, collected.injury_notes, collected.injury_history]
    .filter(Boolean).join("; ") || null;

  return `You are Coach Dean, an AI running coach. ${firstName ? firstName + "'s" : "An athlete's"} Strava just connected.

ATHLETE CONTEXT:
${raceContext ? `Race/Goal: ${raceContext}` : "Goal: general fitness"}
${stravaContext}
${injuryAlreadyCollected && injuryContext ? `\nINJURY FLAGGED BEFORE STRAVA: ${injuryContext}` : ""}

${injuryAlreadyCollected ? `YOUR JOB — INJURY IS THE PRIMARY LENS:
The athlete already flagged an injury before connecting Strava. That injury is the primary coaching concern. Do NOT lead with HR zone distribution or aerobic efficiency. Use load/volume signals (weekly mileage, trend, weeks to race) as the data backbone, and connect everything back to the injury and race timeline.

EXACTLY 3 sentences, ONE clause each — no "X, and Y" or "X, which means Y" compound sentences:
1. The injury + one number from the STRAVA context above that speaks to risk given the race timeline (weekly mileage, weeks to race, or mileage trend). CRITICAL: only cite numbers that appear in the STRAVA data above — never invent figures.
2. The one specific signal you'll watch (load spike, pace drop, mileage jump) — name it, don't explain the mechanism behind it.
3. One forward-looking sentence: what the coaching relationship will monitor.

Close with ONE question on its own — ask what they're doing for the injury right now. Use the specific body part from the INJURY FLAGGED line. Example: "Are you doing anything for the [body part] right now — physio, rest, any treatment?"` : `YOUR JOB: Give a coaching opinion on what you see — not a data summary, but an interpretation connected to their specific race and timeline.

EXACTLY 3 sentences, ONE clause each — no "X, and Y" or "X, which means Y" compound sentences:
1. One insight connecting their training data to the race timeline, with one number from the Strava data.
2. One thing that needs attention — name it, don't explain the reasoning.
3. One forward-looking sentence: what the coaching will watch.

Then close with exactly: "Has injury ever been a factor for you, or anything you're managing right now? That affects how I set up the plan."`}`;
}

// ─────────────────────────────────────────────
// Mirrors handleInjuryIntake's completion gate in onboarding/handle/route.ts.
// injuryAlreadyKnown requires injury_severity too (2026-07-22 fix) — a bare injury
// mention is no longer enough on its own to skip the follow-up loop.
// ─────────────────────────────────────────────
function injuryShouldComplete(collected, followUpCount, lastUserReply) {
  // Allows one inserted qualifier word ("no current issues", "no major injuries") rather
  // than requiring the noun immediately after "no" — mirrors route.ts (2026-07-26,
  // sim-5k-pr-hunter). A generalized pattern, not another phrase added to the list.
  const noInjury = /\bno\s+(?:\w+\s+)?(injury|injuries|issues|pain|niggles|problems)\b|\b(all good|nothing|clean|healthy|fine|never|n\/a)\b/i
    .test(lastUserReply || "");
  // Trusting a populated injury_pain_character (rather than requiring the dedicated question
  // to have literally been asked) relies on the extraction prompt only setting this field from
  // an EXPLICIT description of location/rest-pain, never inferred from a bare "shin splints"
  // label alone — forcing a redundant ask when the athlete already explicitly volunteered both
  // halves reads as not having listened.
  const bodyPartForGate = (collected.injury_body_part_current || "").toLowerCase();
  const isShinRelatedForGate = /shin|tibia/.test(bodyPartForGate);
  const redFlagScreenAnswered = !isShinRelatedForGate || !!collected.injury_pain_character;
  // Gated on ultra_background_asked (a question actually having been sent), not just a
  // non-null ultra_race_history — extraction repeatedly treated the goal framing itself
  // ("this is my first ultra") as if it were racing background and filled in a plausible-
  // sounding value with no dedicated question ever asked. Two prompt-wording tightenings on
  // the extraction instruction each failed to fully stop this, so this is a tracked-ask gate
  // instead of a third wording iteration (2026-07-26, sim-ultra-first-timer).
  const isUltraGoalForGate = !!collected.goal && ULTRA_GOALS.includes(collected.goal);
  const ultraBackgroundAnswered = !isUltraGoalForGate || !!collected.ultra_background_asked;
  // Requiring reported_during here too (not just severity) closes a gap where an athlete who
  // flagged an injury with any free-text description could reach completion the moment
  // severity alone was known, skipping whether the pain even happens during runs at all
  // (2026-07-26, sim-active-injury-marathon).
  const injuryAlreadyKnown = !!(collected.injury_history || collected.current_niggles || collected.injury_notes)
    && !!collected.injury_severity
    && !!collected.reported_during
    && redFlagScreenAnswered
    && ultraBackgroundAnswered;
  const hasAllSymptomFields = !!(collected.injury_body_part_current && collected.injury_severity && collected.reported_during)
    && redFlagScreenAnswered
    && ultraBackgroundAnswered;
  // A purely historical, already-resolved injury (injury_history present, nothing active or
  // currently bothering them) doesn't need the current-symptom workup — body part, severity,
  // and reported_during only make sense for something actually happening right now. Mirrors
  // route.ts (2026-07-26, sim-5k-pr-hunter).
  const historicalInjuryOnlyNoActiveIssue = !!collected.injury_history
    && collected.active_injury !== true
    && !collected.current_niggles
    && ultraBackgroundAnswered;
  const hitFollowUpCap = followUpCount >= (ultraBackgroundAnswered ? 2 : 3);
  return (noInjury && ultraBackgroundAnswered) || injuryAlreadyKnown || hasAllSymptomFields || historicalInjuryOnlyNoActiveIssue || hitFollowUpCap;
}

// Mirrors the missingFields priority list in handleInjuryIntake, including the
// shin/tibia red-flag question ahead of the generic severity question.
function injuryMissingFields(collected) {
  const missingFields = [];
  if (!collected.injury_body_part_current) missingFields.push("which body part specifically");

  const bodyPartLower = (collected.injury_body_part_current || "").toLowerCase();
  const isShinRelated = /shin|tibia/.test(bodyPartLower);
  if (isShinRelated && !collected.injury_pain_character) {
    missingFields.push("whether the pain is a diffuse ache along the shin bone or one specific painful spot, and whether it hurts even at rest or walking (not just during runs) — this distinguishes ordinary shin splints from something that needs a doctor before any loading, like a stress fracture");
  }

  if (!collected.injury_management && !collected.reported_during) {
    missingFields.push("what they're doing for it (physio, rest, ice, etc.) and when the pain flares — ask both in one question");
  } else if (!collected.injury_management) {
    missingFields.push("what they're doing for it right now — any treatment, physio, rest");
  } else if (!collected.reported_during) {
    missingFields.push("when it flares (during runs, after, or both)");
  }
  if (!collected.injury_severity) missingFields.push("how limiting it is right now — can they run modified, or not at all");
  const isUltraGoal = !!collected.goal && ULTRA_GOALS.includes(collected.goal);
  if (isUltraGoal && !collected.ultra_background_asked) {
    missingFields.push("their ultra/trail race background — how many ultras they've done, or trail race experience, or if this is their first");
  }
  return missingFields;
}

async function getInjuryFollowUp(missingFields, followUpCount, noInjuryUltraOnly, lastUserReply, isShinRedFlagPending) {
  // Shin/tibia red-flag screen: asked verbatim, not left to Haiku to compress into one
  // question — an earlier version let the two-part ask (location AND rest-pain) get
  // paraphrased down to just one half (usually dropping location), so even a clear answer
  // couldn't satisfy the injury_pain_character extraction criteria. Mirrors the same
  // deterministic branch in handleInjuryIntake (2026-07-26, sim-shin-splint-trail-race).
  if (isShinRedFlagPending) {
    return "Is the pain one specific spot, or a general ache along the shin? And does it hurt at all when you're resting or just walking, not just during runs?";
  }

  // Mirrors handleInjuryIntake's messages: [{ role: "user", content: message }] — the real
  // last inbound SMS anchors the call. A placeholder like "(continue)" gives Haiku nothing
  // to ground the question in, which let it produce a confused meta-response instead of an
  // actual question (found via sim-shin-splint-trail-race: "I need the athlete's injury
  // description to ask my follow-up question" leaked straight into the SMS, 2026-07-26).
  const userContent = lastUserReply || "(continue)";

  // "no injury" + missing ultra background: not an injury follow-up at all — mirrors the
  // plain race-background question route.ts asks in this branch.
  if (noInjuryUltraOnly) {
    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 120,
      system: `You are Coach Dean. The athlete just said they have no current injury. Ask ONE question about their ultra/trail race background — how many ultras they've done, or trail race experience, or whether this would be their first.

ONE question only. No advice, no reassurance. Just the question.
Plain text, 1–2 sentences max.`,
      messages: [{ role: "user", content: userContent }],
    });
    return response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim()
      || "Have you run any ultras before, or would this be your first?";
  }

  const system = followUpCount === 0
    ? `You are Coach Dean. An athlete just described an injury. Ask ONE specific follow-up question targeting the most important unknown: ${missingFields[0] ?? "how long it's been happening and whether they're doing anything for it"}.

ONE question only. No advice, no stretches, no reassurance. Just the question.
Plain text, 1–2 sentences max.`
    : `You are Coach Dean. You've asked one follow-up about an injury. Ask ONE final targeted question to fill the most important remaining gap: ${missingFields[0] ?? "whether they're doing anything for it and how limiting it is"}.

This is the last question before onboarding completes — make it count. ONE question, no reassurance.
Plain text, 1–2 sentences max.`;

  const response = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 120,
    system,
    messages: [{ role: "user", content: userContent }],
  });
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim()
    || "How long has it been bothering you, and do you feel it during runs, after, or both?";
}

// ─────────────────────────────────────────────
// Mirrors buildDeterministicCompletion in onboarding/handle/route.ts. Previously only
// ported the opening + active-injury branch, which meant any fixture with no active injury
// (historical injury_history only, or nothing at all) produced a bare one-line message the
// judge repeatedly flagged as "truncated"/"abrupt" — a harness fidelity gap, not a real
// production behavior, since production always adds the Strava observation line and/or an
// injury-history acknowledgment in these cases. Now ports the observation line (using
// weekly_miles — this harness doesn't compute HR-zone/mileage-trend stats, so that part of
// production's observation branch has no equivalent here) and the historical/niggles
// injuryNote fallbacks, plus the closing sentence. (2026-07-26, sim-5k-pr-hunter)
// ─────────────────────────────────────────────
function buildCompletionMessage(collected, today) {
  const firstName = (collected.name || "Hey").split(" ")[0];
  const raceName = collected.race_name;
  const raceDate = collected.race_date;
  const avgMiles = collected.weekly_miles || null;
  const currentNiggles = collected.current_niggles || null;
  const injuryHistory = collected.injury_history || null;
  const activeInjury = collected.active_injury === true;
  const injuryBodyPart = collected.injury_body_part_current || null;
  const injurySeverity = collected.injury_severity || null;
  const injuryManagement = collected.injury_management || null;
  const injuryPainCharacter = collected.injury_pain_character || null;
  const reportedDuring = collected.reported_during || null;
  const stravaConnected = !!collected.strava_connected;

  let opening = "";
  if (raceName && raceDate) {
    const nowMs = new Date(today + "T12:00:00Z").getTime();
    const weeksUntil = Math.round((new Date(raceDate + "T12:00:00Z").getTime() - nowMs) / (7 * 24 * 60 * 60 * 1000));
    const timelineStr = weeksUntil <= 1 ? "this week" : weeksUntil === 2 ? "2 weeks out" : `${weeksUntil} weeks out`;
    opening = `${firstName}, ${raceName} ${timelineStr}.`;
  } else {
    opening = `${firstName}, you're set up.`;
  }

  const observation = avgMiles ? `Your base at ${avgMiles} mi/week gives us room to work.` : "";

  let injuryNote = "";
  if (activeInjury && injuryBodyPart) {
    const action = getInjuryAction(injuryBodyPart);
    const whenStr = reportedDuring === "during" ? "during runs"
      : reportedDuring === "after" ? "after runs"
      : reportedDuring === "both" ? "during and after runs"
      : null;
    const duringNote = whenStr ? ` Pain ${whenStr} is the watch-point for whether a session stays or gets swapped.` : "";

    if (injuryPainCharacter === "localized_or_rest_pain") {
      injuryNote = `One thing before anything else: a specific painful spot (rather than a general ache) or pain even at rest can point to a stress fracture, not standard shin splints — get that checked by a doctor before adding any more running load, including easy miles or incline treadmill work.`;
    } else if (injuryManagement) {
      injuryNote = `${injuryManagement} for the ${injuryBodyPart} — good. Before your next run, also ${action}.${duringNote}`;
    } else {
      const severityNote = injurySeverity === "severe" ? "Given the severity, "
        : injurySeverity === "moderate" ? "Given how it's affecting training, " : "";
      injuryNote = `${severityNote}Before your next run, do ${action}.${duringNote}`;
    }
  } else if (currentNiggles && !/\b(none|no injury|healthy|fine)\b/i.test(currentNiggles)) {
    injuryNote = "Injury history noted — it factors into how I set your volume and easy/hard balance.";
  } else if (injuryHistory && !/\b(none|no injury|no injuries|healthy|fine)\b/i.test(injuryHistory)) {
    injuryNote = "Injury history noted — it factors into how I set your volume and easy/hard balance.";
  }

  const parts = [opening];
  if (activeInjury && injuryNote) {
    parts.push(injuryNote);
    if (observation) parts.push(observation);
  } else {
    if (observation) parts.push(observation);
    if (injuryNote) parts.push(injuryNote);
  }

  if (activeInjury && injuryBodyPart) {
    // No additional closing sentence — mirrors route.ts: the plan-delivery message closes the loop.
  } else if (stravaConnected) {
    parts.push("After your next run, I'll send a coaching note — what it means for the week ahead and what to watch for. That's where we start.");
  } else {
    parts.push("Your first coaching note lands after your first run — what it means for the week ahead and what to watch for.");
  }

  return parts.join(" ");
}

// ─────────────────────────────────────────────
// Mirrors maybeEnterScheduleConfirm + handleScheduleConfirm in onboarding/handle/route.ts.
// Fires right before completion whenever training_days isn't already known (Strava-inferred
// or explicitly stated) — a deterministic ask (not an LLM turn) confirming the schedule before
// the plan generates, then one user reply + extraction resolves it. Skipped entirely when the
// athlete already stated their training days during the normal conversation, same as
// production (a redundant confirm on top of an explicit answer would just be more noise).
// ─────────────────────────────────────────────
async function maybeRunScheduleConfirm(collected, history, persona, today, verbose) {
  if (collected.schedule_confirmed) return collected;
  if (Array.isArray(collected.training_days) && collected.training_days.length > 0) return collected;

  const ask = "What days of the week do you want to run, and anything specific you want out of the plan?";
  history.push({ role: "assistant", content: ask });
  if (verbose) console.log(`\n  Dean (schedule confirm): ${ask}`);

  const userReply = await getUserAgentResponse(persona, history);
  history.push({ role: "user", content: userReply });
  if (verbose) console.log(`\n  User: ${userReply}`);

  const extracted = await extractFields(history, today);
  let next = mergeCollected(collected, extracted);
  next.schedule_confirmed = true;
  return next;
}

// ─────────────────────────────────────────────
// Get Dean's response for a given history
// ─────────────────────────────────────────────
async function getDeanResponse(collected, stravaContext, history, isFirstResponse, today) {
  const systemPrompt = buildDeanSystemPrompt(collected, stravaContext, isFirstResponse, today);

  // race_date_verified (not mere race_date presence) gates the lookup — mirrors route.ts.
  // Extraction pulls race_date from "whichever date is stated... athlete's or Dean's",
  // including the athlete's own unverified claim, on the SAME turn before Dean has said
  // anything back. Gating on race_date alone meant an athlete stating a date made
  // collected.race_date non-null immediately, permanently defeating the lookup (and the
  // forced tool_choice) even though nothing had actually been searched yet. Confirmed via
  // direct reproduction, 2026-07-26: two real, similarly-named races existed for the same
  // athlete-stated race, and Dean never got a chance to search because the gate was already
  // closed by the raw extraction pass.
  const raceNameChangedSinceVerification = collected.race_name !== collected.race_date_verified_for;
  const needsRaceDateLookup = !!collected.race_name && (!collected.race_date_verified || raceNameChangedSinceVerification);

  const response = await client.messages.create({
    model: DEAN_MODEL,
    max_tokens: 600,
    system: systemPrompt,
    messages: history,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    ...(needsRaceDateLookup ? { tool_choice: { type: "tool", name: "web_search" } } : {}),
  });

  // tool_choice forces the search to have happened this turn — mark it verified so later
  // turns don't force a redundant re-search once the date is confirmed.
  if (needsRaceDateLookup) {
    collected.race_date_verified = true;
    collected.race_date_verified_for = collected.race_name;
  }

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

    // Extract BEFORE generating Dean's response, on history as it stands (already ending
    // with the latest user message) — mirrors route.ts's "EXTRACT FIRST" comment: Haiku
    // extraction runs on the current message before the system prompt is built, so a
    // race_date given in THIS message is already in `collected` (and its deterministic
    // countdown line) for THIS SAME response, not one turn late. Without this, the very
    // first Dean reply always free-hands the countdown from scratch (2026-07-22 bug).
    const preExtracted = await extractFields(history, today);
    collected = mergeCollected(collected, preExtracted);

    // Get Dean's response
    const rawDeanResponse = await getDeanResponse(collected, stravaContext, history, isFirstResponse, today);

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
      // Structural fix mirror (2026-07-22): the honest pitch line is appended by code,
      // not written by the model — this is what makes strava_scope_honest a guaranteed
      // pass rather than a hope that the LLM chooses accurate wording every time.
      deanText += `\n\nhttps://coachdean.ai/api/auth/strava?userId=sim\n\nI'll read your runs and text you a coaching note after each one.\n\nNo Strava? Just reply "skip".`;
    }

    history.push({ role: "assistant", content: deanText });
    deanTurns++;

    if (verbose) {
      console.log(`\n  Dean [${deanTurns}]: ${deanText}`);
    }

    if (isReady) {
      // Final extraction
      const extracted = await extractFields(history, today);
      collected = mergeCollected(collected, extracted);
      collected = await maybeRunScheduleConfirm(collected, history, persona, today, verbose);
      readyFired = true;
      break;
    }

    // Handle Strava link
    if (wantsStravaLink && persona.strava_connected) {
      collected = mergeCollected(collected, { strava_connected: true });
      stravaContext = fixture.persona.strava_context_after_connect
        ?? "STRAVA: Connected. No races found for VDOT calculation — ask for a recent race time or PR to set training paces.";

      // Real Strava-connected data-analysis message (mirrors handleDataAnalysis in
      // onboarding/handle/route.ts) — generated live, not a static placeholder, so the
      // race-countdown consistency and Strava-scope wording this message produces are
      // actually exercised, not hardcoded around.
      const analysisPrompt = buildStravaAnalysisPrompt(collected, stravaContext, (collected.name || "").split(" ")[0], today);
      const analysisResp = await client.messages.create({
        model: DEAN_MODEL,
        max_tokens: 400,
        system: analysisPrompt,
        messages: [{ role: "user", content: "(Strava just connected — write your message now.)" }],
      });
      const stravaMsg = analysisResp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      history.push({ role: "assistant", content: stravaMsg });

      if (verbose) {
        console.log(`\n  [Strava OAuth simulated]`);
        console.log(`  Dean (auto): ${stravaMsg}`);
      }

      // User agent responds to the analysis message
      let userReply = await getUserAgentResponse(persona, history);
      history.push({ role: "user", content: userReply });
      if (verbose) console.log(`\n  User: ${userReply}`);

      let extracted = await extractFields(history, today);
      collected = mergeCollected(collected, extracted);

      // Injury intake stage (mirrors handleInjuryIntake) — runs for every athlete after
      // Strava connects, same as production. Bounded at 2 follow-ups.
      let followUpCount = 0;
      while (!injuryShouldComplete(collected, followUpCount, userReply)) {
        const missingFields = injuryMissingFields(collected);
        const noInjuryDetected = /\bno\s+(?:\w+\s+)?(injury|injuries|issues|pain|niggles|problems)\b|\b(all good|nothing|clean|healthy|fine|never|n\/a)\b/i
          .test(userReply || "");
        const isUltraGoal = !!collected.goal && ULTRA_GOALS.includes(collected.goal);
        const noInjuryUltraOnly = noInjuryDetected && isUltraGoal && !collected.ultra_background_asked;
        const bodyPartLower = (collected.injury_body_part_current || "").toLowerCase();
        const isShinRedFlagPending = /shin|tibia/.test(bodyPartLower) && !collected.injury_pain_character;
        // Only entry left in missingFields once every earlier injury-symptom gap is filled —
        // used to mark the tracked-ask flag when the general follow-up ends up asking it.
        const onlyMissingIsUltraBackground = isUltraGoal && !collected.ultra_background_asked && missingFields.length === 1;
        if (noInjuryUltraOnly || onlyMissingIsUltraBackground) collected.ultra_background_asked = true;
        const followUpText = await getInjuryFollowUp(missingFields, followUpCount, noInjuryUltraOnly, userReply, isShinRedFlagPending);
        history.push({ role: "assistant", content: followUpText });
        followUpCount++;
        if (verbose) console.log(`\n  Dean (injury intake): ${followUpText}`);

        userReply = await getUserAgentResponse(persona, history);
        history.push({ role: "user", content: userReply });
        if (verbose) console.log(`\n  User: ${userReply}`);

        extracted = await extractFields(history, today);
        collected = mergeCollected(collected, extracted);
      }

      // Schedule/preferences checkpoint, then completion — mirrors
      // maybeEnterScheduleConfirm + buildDeterministicCompletion + completeOnboarding firing.
      // This ends the simulation the same way production ends onboarding from this
      // stage: no further [READY]-seeking turns, straight to the wrap-up message.
      collected = await maybeRunScheduleConfirm(collected, history, persona, today, verbose);
      const completionMsg = buildCompletionMessage(collected, today);
      history.push({ role: "assistant", content: completionMsg });
      deanTurns++;
      readyFired = true;
      if (verbose) console.log(`\n  Dean (completion): ${completionMsg}`);
      break;

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
      max_tokens: 1300, // bumped 2026-07-22 for the 3 added judge dimensions (strava_scope_honest, race_countdown_consistent, injury_redflag_screened) — 800 was truncating responses mid-JSON
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
