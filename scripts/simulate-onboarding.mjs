/**
 * simulate-onboarding.mjs
 *
 * Simulates 10 different athletes going through the Coach Dean onboarding flow.
 * Uses the actual prompts from src/app/api/onboarding/handle/route.ts verbatim.
 *
 * Run with:
 *   ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY /path/to/.env.local | cut -d= -f2) \
 *     node scripts/simulate-onboarding.mjs 2>&1
 */

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Helpers copied verbatim from the route
// ---------------------------------------------------------------------------

function extractJSON(text) {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text;
}

function removeNulls(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

const ULTRA_GOALS = ["50k", "100k", "30k"];
const TRIATHLON_GOALS = ["sprint_tri", "olympic_tri", "70.3", "ironman"];
const CYCLING_GOALS = ["cycling"];

function getSportType(goal) {
  if (TRIATHLON_GOALS.includes(goal)) return "triathlon";
  if (CYCLING_GOALS.includes(goal)) return "cycling";
  if (goal === "general_fitness" || goal === "injury_recovery") return "general";
  return "running";
}

function formatGoalInline(goal) {
  const labels = {
    "5k": "5K",
    "10k": "10K",
    half_marathon: "half marathon",
    marathon: "full marathon",
    "30k": "30K trail race",
    "50k": "50K ultra",
    "100k": "100K ultra",
    sprint_tri: "sprint triathlon",
    olympic_tri: "Olympic-distance triathlon",
    "70.3": "70.3 Half Ironman",
    ironman: "Full Ironman",
    cycling: "cycling event",
    general_fitness: "general fitness",
    injury_recovery: "injury recovery",
  };
  return labels[goal] || goal;
}

function isStepSatisfied(step, data) {
  switch (step) {
    case "awaiting_race_date":
      if (data.goal === "injury_recovery") return true;
      return Object.prototype.hasOwnProperty.call(data, "race_date");
    case "awaiting_goal_time":
      if (
        data.goal === "general_fitness" ||
        data.goal === "injury_recovery" ||
        ULTRA_GOALS.includes(data.goal)
      )
        return true;
      return Object.prototype.hasOwnProperty.call(data, "goal_time_minutes");
    case "awaiting_strava":
      return !!(data.strava_connected || data.strava_skipped);
    case "awaiting_schedule":
      return Array.isArray(data.training_days) && data.training_days.length > 0;
    case "awaiting_ultra_background":
      if (!ULTRA_GOALS.includes(data.goal)) return true;
      if (data.strava_connected) return true;
      return !!(data.weekly_miles) && !!(data.ultra_race_history || data.experience_years != null);
    case "awaiting_timezone":
      if (data.strava_connected && !data.strava_city) return true;
      return !!(data.timezone_confirmed);
    case "awaiting_anything_else":
      return !!(data.weekly_miles || data.weekly_hours) && !!(data.recent_race_distance_km || data.easy_pace);
    case "awaiting_name":
      return typeof data.name === "string" && data.name.length > 0;
    default:
      return false;
  }
}

const STEP_ORDER = [
  "awaiting_race_date",
  "awaiting_goal_time",
  "awaiting_strava",
  "awaiting_schedule",
  "awaiting_ultra_background",
  "awaiting_timezone",
  "awaiting_anything_else",
];

function findNextStep(afterStep, data) {
  const afterIdx = STEP_ORDER.indexOf(afterStep);
  const remaining = afterIdx >= 0 ? STEP_ORDER.slice(afterIdx + 1) : [...STEP_ORDER];
  for (const step of remaining) {
    if (!isStepSatisfied(step, data)) return step;
  }
  return null;
}

function getStepQuestion(step, data) {
  const sport = data.sport_type || "running";
  const isTri = sport === "triathlon";
  const isCycling = sport === "cycling";

  switch (step) {
    case "awaiting_goal_time":
      return `Do you have a time goal for the race, or is it more about finishing strong and building your base? Either's totally valid — just helps me dial in the right pacing.`;
    case "awaiting_strava":
      return `Before I put your plan together — do you use Strava? If you connect it, I can pull in your training history and build something much sharper from day 1.\n\nhttps://coachdean.ai/api/auth/strava?userId=SIMULATED\n\nNo Strava? Just reply "skip".`;
    case "awaiting_race_date":
      return data.goal === "general_fitness"
        ? "Do you have a target event or date in mind? If not, just say 'no event' and we'll keep the plan open-ended."
        : "What's the date of your event? If you don't have one locked in yet, give me your best target and we can adjust later.";
    case "awaiting_schedule":
      if (isTri) return "How many days a week are you training total? And do you have any days that work better for longer sessions?";
      if (isCycling) return "How many days a week do you want to ride? And which days work best for you?";
      return "How many days a week do you want to run, and which days work best for you?";
    case "awaiting_ultra_background":
      return data.strava_connected
        ? "An ultra — love it. Have you run any before? Any experience with the distance is helpful to know."
        : "An ultra — love it. Have you run any before? And what's your current weekly mileage and longest recent long run?";
    case "awaiting_timezone":
      if (data.strava_connected && data.strava_city) {
        const location = data.strava_state
          ? `${data.strava_city}, ${data.strava_state}`
          : data.strava_city;
        return `Based on your Strava, looks like you're in ${location} — is that still accurate? Just want to make sure your reminders go out at the right time.`;
      }
      return "One quick one — what city are you in? Want to make sure your reminders go out at the right time, not 3am.";
    case "awaiting_anything_else":
      if (data.goal === "injury_recovery") {
        return "Tell me more about the injury — what is it, how long ago did it happen, and where are you in recovery? Are you able to run at all right now, or fully off it?";
      }
      return "Almost there — anything else worth knowing before I put this together? Injuries, current paces, strength work, cross-training — mention it now and I'll build it in.";
    case "awaiting_name":
      return "What's your name?";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Claude API calls (verbatim prompts from route)
// ---------------------------------------------------------------------------

async function classifyGoal(message) {
  const today = new Date().toISOString().split("T")[0];
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 128,
    system: `Classify whether the user's message contains a clear fitness or endurance goal. Respond with ONLY valid JSON, no other text.

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
- When complete is false, goal must be null`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "{}";
  try {
    return JSON.parse(extractJSON(text));
  } catch {
    return { complete: false, no_event: false, goal: null };
  }
}

async function extractAdditionalFields(message) {
  const today = new Date().toISOString().split("T")[0];
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `Extract any running/training information present in this message. Be generous with inference — if something is clearly implied, extract it.

Output format (omit fields that are not present):
{"race_date": "YYYY-MM-DD" | null, "experience_years": number | null, "weekly_miles": number | null, "easy_pace": "M:SS" | null, "recent_race_distance_km": number | null, "recent_race_time_minutes": number | null, "injury_mentioned": boolean, "injury_notes": string | null, "crosstraining_tools": string[] | null, "other_notes": string | null, "name": "FirstName" | null}

Rules:
- name: Extract if the athlete introduces themselves. Be generous — people introduce themselves in many ways:
  Explicit: "I'm Mark", "My name is Mark", "Call me Mark", "This is Mark", "It's Mark", "Hey it's Mark"
  Implicit: a message beginning with a single capitalized word followed by a period, comma, exclamation mark, or emoji (e.g. "Mark. Nothing on the calendar", "Mark, just getting started", "Mark!", "Mark 👋")
  Bare name: the entire message is just a first name (e.g. "Mark" with nothing else)
  With "here": "[Name] here" (e.g. "Mark here", "Hey, Mark here")
  NEVER extract from greetings directed at Coach Dean like "Hey Dean!" or "Hi Coach!" — those address the coach, not the athlete. Return null if genuinely ambiguous.
- race_date: if a specific target race date is mentioned. Today is ${today}.
- experience_years: infer from any experience signal. "new runner" or "just started" → 0. "fairly inexperienced" → 0.2. "completed an 8 week plan" with no prior context → 0.15. "a year" → 1. "5+ years" → 5.
- weekly_miles: total weekly running mileage. If stated as a per-day or per-weekday average (e.g. "I run 5-6 miles a day", "5-6 miles weekdays"), multiply by the number of days implied (weekdays = 5, "every day" = 7) to get a weekly total. Convert km to miles (×0.621).
- easy_pace: ONLY a stated comfortable, easy, or conversational running pace. Do NOT extract race pace, PR pace, or anything described as a PR, best time, or race effort. Format as M:SS per mile. "8:30/m" → "8:30". "5:00/km" → "8:03".
- recent_race_distance_km: if a PR or recent race is mentioned. 5K=5, 10K=10, half=21.0975, marathon=42.195, 1mi=1.609. If the athlete gives a pace rather than a time (e.g. "5K PR pace is 5:40/mi"), compute the total time: pace_per_mile × distance_in_miles (5K=3.107mi, 10K=6.214mi, half=13.109mi, marathon=26.219mi).
- recent_race_time_minutes: total race time in minutes for the PR/race above. If given as a pace, compute time = pace_sec/mile × distance_in_miles / 60.
- injury_mentioned: true if any injury or physical limitation is mentioned.
- injury_notes: brief description of injury type, severity, and recovery status if an injury is mentioned (e.g. "IT band syndrome, recovering, avoiding back-to-back days"). null if no injury.
- crosstraining_tools: normalized array of cross-training activities or equipment mentioned (e.g. ["cycling", "swimming", "gym", "yoga"]). null if none.
- other_notes: any other training-relevant context not captured above — strengthening preferences, target times, lifestyle constraints, etc. null if nothing else.
- Return {} if nothing is present.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    const parsed = JSON.parse(extractJSON(text));
    const result = {};
    if (parsed.race_date != null) result.race_date = parsed.race_date;
    if (parsed.experience_years != null) result.experience_years = parsed.experience_years;
    if (parsed.weekly_miles != null) result.weekly_miles = parsed.weekly_miles;
    if (parsed.easy_pace != null) result.easy_pace = parsed.easy_pace;
    if (parsed.recent_race_distance_km != null) result.recent_race_distance_km = parsed.recent_race_distance_km;
    if (parsed.recent_race_time_minutes != null) result.recent_race_time_minutes = parsed.recent_race_time_minutes;
    if (parsed.injury_mentioned === true) result.injury_mentioned = true;
    if (parsed.injury_notes != null) result.injury_notes = parsed.injury_notes;
    if (Array.isArray(parsed.crosstraining_tools) && parsed.crosstraining_tools.length > 0)
      result.crosstraining_tools = parsed.crosstraining_tools;
    if (parsed.other_notes != null) result.other_notes = parsed.other_notes;
    if (parsed.name != null) result.name = parsed.name;
    return result;
  } catch {
    return {};
  }
}

async function generateRaceAcknowledgment(message) {
  const empty = { ack: null, raceDate: null, distanceOptions: null };
  try {
    const today = new Date().toISOString().split("T")[0];
    const response = await anthropic.messages.create({
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

    const textBlocks = response.content.filter((b) => b.type === "text");
    const lastBlock = textBlocks[textBlocks.length - 1];
    const text = lastBlock?.type === "text" ? lastBlock.text.trim() : "";

    if (!text || text.toLowerCase() === "null") return empty;

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      const distanceOptions =
        Array.isArray(parsed?.distance_options) && parsed.distance_options.length > 1
          ? parsed.distance_options
          : null;
      return { ack: parsed?.ack ?? null, raceDate: parsed?.date ?? null, distanceOptions };
    } catch {
      return { ack: text, raceDate: null, distanceOptions: null };
    }
  } catch {
    return empty;
  }
}

async function detectAndAnswerImmediate(message, goal) {
  const response = await anthropic.messages.create({
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
  try {
    const parsed = JSON.parse(extractJSON(text));
    if (parsed.no_question === true) return null;
  } catch {
    if (text.length > 10) return text;
  }
  return null;
}

async function checkOffTopic(step, message) {
  const stepContext = {
    awaiting_race_date: { topic: "their race date or target event" },
    awaiting_schedule: { topic: "their weekly training schedule and availability" },
    awaiting_goal_time: { topic: "their finish time goal for the race (or whether they have one)" },
    awaiting_ultra_background: { topic: "their ultra running background and previous race experience" },
    awaiting_timezone: { topic: "what city or timezone they're in" },
    awaiting_cadence: {
      topic: "whether they want morning-of reminders, evening-before reminders, or a weekly Sunday overview",
    },
  };

  const ctx = stepContext[step];
  if (!ctx) return { offTopic: false };

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: `You are Coach Dean, an AI running coach onboarding a new athlete via SMS. You are currently collecting information about ${ctx.topic}.

Read the athlete's message and decide: is it ATTEMPTING to address the topic (even partially, vaguely, or incompletely), or is it COMPLETELY UNRELATED?

On-topic — return only this JSON: {"on_topic": true}
- Any answer to the question, even partial or brief
- Saying they don't know, aren't sure, or don't have the info
- Simple acknowledgments like "yeah", "not really", "not sure"
- Anything that touches on the subject even loosely

Off-topic — write a plain text response as Coach Dean:
- Questions about Dean's services or capabilities (e.g. "do you coach cycling?")
- Meta-questions about the onboarding process ("how many more questions?", "how long does this take?", "are we almost done?") — answer briefly (e.g. "Just this one!") then re-ask
- Advice-seeking questions about the topic rather than answering it ("What is a realistic finish time for a 30K?", "How many days a week should I train?") — answer briefly, then re-ask whether they have a personal answer
- Random chit-chat with no relation to the topic
- Completely unrelated statements or questions
If off-topic: answer warmly in 1 sentence, then re-ask your question naturally. No markdown, no asterisks.`,
    messages: [{ role: "user", content: message }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  try {
    const parsed = JSON.parse(extractJSON(text));
    if (parsed.on_topic === true) return { offTopic: false };
  } catch {
    // Not JSON — Claude wrote a plain-text off-topic response
  }
  return { offTopic: true, response: text };
}

async function parseRaceDate(message) {
  const today = new Date().toISOString().split("T")[0];
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 64,
    system: `Extract a race/target date from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"race_date": "YYYY-MM-DD" | null}

Rules:
- If they mention a month without a year, assume ${new Date().getFullYear()} — or next year if that month has already passed
- "no race", "not sure", "open-ended", "no date", "TBD" → null
- "end of October" → last day of October
- Today is ${today}`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "{}";
  try {
    return JSON.parse(extractJSON(text));
  } catch {
    return { race_date: null };
  }
}

async function parseSchedule(message) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: `Extract training schedule preferences from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "days_per_week": number|null, "training_days": ["monday"|...|"sunday"]|null, "follow_up": string|null}

Rules:
- Normalize all day names to full lowercase
- complete: true whenever you have enough to build a schedule — even if every specific day isn't named
- "Weekdays" alone → complete: true, training_days: ["monday","tuesday","wednesday","thursday","friday"]
- "Weekends" → complete: true, training_days: ["saturday","sunday"]
- A count + day preference is enough: "4 days, prefer Mon/Wed/Fri/Sat" → complete: true, fill in all 4
- "doesn't matter", "no preference", "whatever works", "any days" → complete: true. Use a balanced default (e.g. Mon, Wed, Fri, Sun for 4 days)
- For a range like "3-4 days" with no other info → complete: false, follow_up asks which days work best
- complete: false ONLY if there is truly not enough to infer any schedule at all
- days_per_week: use the number or the midpoint of a range ("3-4" → 4)
- follow_up: only what's still missing — do NOT re-ask for info already given. If days_per_week is known, don't ask again.
- If complete is true, follow_up must be null`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "{}";
  try {
    return JSON.parse(extractJSON(text));
  } catch {
    return { complete: false, days_per_week: null, training_days: null, follow_up: null };
  }
}

async function acknowledgeSharedInfo(message) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: `You are Coach Dean, a friendly endurance coach onboarding a new athlete via SMS.

The athlete just shared something during the onboarding process. If they shared anything substantive, respond with ONE short, warm, specific sentence that shows you heard them. Be concrete — reference what they actually said.

Count these as substantive:
- Personal context, emotions, goals, backstory ("I've been dreaming about this for years", "this is my first marathon")
- Training data they share (weekly miles, pace, recent races) — acknowledge it as a useful baseline
- Lifestyle constraints (work schedule, travel, family)
- Scheduling flexibility ("I may switch those around")
- Alternative tools (Garmin, Apple Watch) — acknowledge and note you can work with them
- Privacy concerns or hesitation, even while complying ("I'll skip — I'm a privacy person") — acknowledge and respect the choice
- Any question or concern worth noting

Return only the word: null if the message is a truly bare answer with no extra context — e.g. just a date, a number, "nope", "no", "I'm good", "Skip", "Yes", "Yeah that's right".

Plain text only — no markdown, no asterisks.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  if (!text || text.toLowerCase() === "null") return null;
  return text;
}

async function acknowledgeSchedule(message, trainingDays) {
  const dayList = trainingDays.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(", ");
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system: `You are Coach Dean, a friendly endurance coach onboarding a new athlete via SMS.

The athlete just confirmed their training schedule. Write ONE short, warm sentence (max 15 words) acknowledging the schedule. Their training days are: ${dayList}.

If they mentioned any flexibility or that they might swap days around, acknowledge that the plan can flex.
If they gave a plain answer with no caveats, just confirm you've got the days locked in.

Examples:
- Plain: "Perfect — I've got you down for ${dayList}."
- Flexibility caveat: "Works for me — we can always shuffle things around as life gets in the way."

Plain text only — no markdown.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  return text || `Perfect — I've got you down for ${dayList}.`;
}

async function parseGoalTime(message) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    system: `Extract a race finish time goal from this message. Convert to total minutes.
Examples: "sub-2 hours" → 120, "1:55" → 115, "under 4:30" → 270, "around 2:15" → 135, "23 minutes" → 23.
If no specific time goal (e.g. "just finish", "no goal", "build fitness", "not sure") → null.
Return ONLY valid JSON: {"goal_time_minutes": number | null}`,
    messages: [{ role: "user", content: message }],
  });
  try {
    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return typeof parsed.goal_time_minutes === "number" ? parsed.goal_time_minutes : null;
  } catch {
    return null;
  }
}

async function parseUltraBackground(message) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `Extract ultra running background from this message. Respond with ONLY valid JSON.

Output format:
{
  "has_ultra_experience": boolean,
  "ultra_race_history": string | null,
  "weekly_miles": number | null,
  "current_long_run_miles": number | null,
  "experience_years": number | null
}

Rules:
- has_ultra_experience: true if they mention completing any ultra distance race (50K or longer)
- ultra_race_history: brief summary of their ultra background (e.g. "Western States finisher, multiple 50Ks and 100Ks"). null if none mentioned.
- weekly_miles: total current weekly mileage. If stated as per-day average (e.g. "50 miles a week", "~10 miles a day"), compute the weekly total. Convert km × 0.621.
- current_long_run_miles: their current typical longest run in miles. Convert km × 0.621.
- experience_years: infer from context. First ultra → 1. Multiple ultras over several years → 3+. Western States or similar prestigious finish → 5+.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    return JSON.parse(extractJSON(text));
  } catch {
    return {};
  }
}

async function extractAnythingElse(message) {
  const empty = {
    injury_notes: null,
    recent_race_distance_km: null,
    recent_race_time_minutes: null,
    easy_pace: null,
    experience_years: null,
    weekly_miles: null,
    crosstraining_tools: null,
    other_notes: null,
  };

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `Extract any training-relevant information from this message. Respond with ONLY valid JSON.

Output format:
{
  "injury_notes": string | null,
  "recent_race_distance_km": number | null,
  "recent_race_time_minutes": number | null,
  "easy_pace": "M:SS" | null,
  "experience_years": number | null,
  "weekly_miles": number | null,
  "crosstraining_tools": string[] | null,
  "other_notes": string | null
}

Rules:
- "nope", "no", "nothing", "all good", "nah", "none", "I'm good" → all null fields, crosstraining_tools: null
- injury_notes: brief description of injury type, severity, and recovery status (e.g. "IT band syndrome, recovering, avoiding back-to-back days")
- recent_race_distance_km: running distance in km (5K=5, 10K=10, half=21.0975, marathon=42.195, 1mi=1.609)
- recent_race_time_minutes: total race time in minutes (e.g. "25:30" → 25.5, "1:45:00" → 105, "2:05 half marathon" → 125)
- easy_pace: comfortable conversational running pace in M:SS per mile. Convert from km if needed (÷0.621)
- experience_years: years running/training. "new" → 0, "a few months" → 0.3, "a year" → 1, "5+ years" → 5
- weekly_miles: total weekly running mileage. If stated as a per-day or per-weekday average (e.g. "I average 5-6 miles a day", "5-6 miles weekdays"), multiply by the number of days implied (weekdays = 5, "every day" = 7) to get a weekly total. Convert km × 0.621.
- crosstraining_tools: normalized array e.g. ["cycling", "swimming", "gym"]. null if none mentioned.
- other_notes: any other relevant info not captured above (target time goals, lifestyle constraints, etc.)
- Return all fields, using null for those not present`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    return JSON.parse(extractJSON(text));
  } catch {
    return empty;
  }
}

async function generateAnythingElseResponse(message, onboardingData) {
  const goal = onboardingData.goal ?? null;
  const raceDate = onboardingData.race_date ?? null;
  const context = goal
    ? `The athlete is training for a ${goal}${raceDate ? ` on ${raceDate}` : ""}.`
    : "The athlete is in the process of setting up their training plan.";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: `You are Coach Dean, an AI endurance coach. ${context} You just asked: "Before I put your plan together, anything else I should know?"

The athlete replied. Respond appropriately:

- If they said "no", "nope", "nothing", "all good", "nah", "I'm good", or anything that clearly means they're done → return: {"response": null, "done": true}
- If they asked a question → answer it warmly in 1-2 sentences, then end with a natural re-ask like "Anything else I should know?" Return: {"response": "...", "done": false}
- If they shared info (injury, schedule constraints, secondary goal, training history, preferences) → briefly acknowledge it in 1 sentence, then end with "Anything else?" Return: {"response": "...", "done": false}

Rules:
- Tone: warm, direct, like a coach texting — no "Love it!" opener, no markdown, no asterisks
- 1-3 sentences max
- Output only valid JSON`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    const parsed = JSON.parse(extractJSON(text));
    if (parsed.done === true) return { response: null, isDone: true };
    return { response: parsed.response ?? null, isDone: false };
  } catch {
    return { response: text.length > 5 ? text : null, isDone: false };
  }
}

// ---------------------------------------------------------------------------
// Simulation engine
// ---------------------------------------------------------------------------

const SIGNUP_MESSAGE = `Hey, I'm Coach Dean — your AI running coach, working entirely over text.

I help with a few things: training for a race (5K up to ultra), building a consistent running habit, coming back from injury and rebuilding safely, or just general coaching on pacing, nutrition, and gear.

What's your name, and what's brought you here?`;

/**
 * Simulates the full onboarding flow for a single athlete.
 * Returns an array of { role: 'DEAN'|'ATHLETE', message: string } turns.
 */
async function simulateAthlete(persona) {
  const transcript = [];
  const issues = [];

  function log(role, message) {
    transcript.push({ role, message });
  }

  function issue(msg) {
    issues.push(msg);
  }

  // Dean sends the signup intro
  log("DEAN", SIGNUP_MESSAGE);

  // Athlete sends their first message
  log("ATHLETE", persona.firstMessage);

  // State
  let onboardingData = { intro_sent: true };
  let step = "awaiting_goal";
  let name = null;

  // -------------------------------------------------------------------------
  // Step: awaiting_goal
  // -------------------------------------------------------------------------
  {
    const [parsed, extra] = await Promise.all([
      classifyGoal(persona.firstMessage),
      extractAdditionalFields(persona.firstMessage),
    ]);

    if (extra.name) name = extra.name;

    if (!parsed.complete || !parsed.goal) {
      // No goal yet — Dean asks for clarification
      const namePrefix = name ? `Hey ${name}!` : null;
      let responseText;
      if (parsed.no_event) {
        const np = name ? `No worries, ${name}` : "No worries";
        responseText = `${np} — having a direction still helps even without a date locked in. What kind of event are you drawn to — a 5K, half marathon, something longer, or more just general fitness?`;
      } else if (namePrefix) {
        responseText = `${namePrefix} What are you training for — a race, general fitness, something else?`;
      } else {
        responseText = "Sorry, didn't quite catch your name — what should I call you?";
      }
      log("DEAN", responseText);

      // Simulate athlete giving a follow-up with their actual goal
      if (persona.followUpGoalMessage) {
        log("ATHLETE", persona.followUpGoalMessage);
        // Re-run goal classification on follow-up
        const [parsed2, extra2] = await Promise.all([
          classifyGoal(persona.followUpGoalMessage),
          extractAdditionalFields(persona.followUpGoalMessage),
        ]);
        if (extra2.name && !name) name = extra2.name;
        if (!parsed2.complete || !parsed2.goal) {
          issue("Goal classifier failed to identify goal even on follow-up message");
          log("DEAN", "[SIMULATION NOTE: Goal still not detected — flow would stall here]");
          return { transcript, issues };
        }
        // Continue with the follow-up parse
        Object.assign(parsed, parsed2);
        Object.assign(extra, removeNulls(extra2));
      } else {
        // No follow-up defined — note the issue and stop
        issue(`Goal not detected from first message. Dean asked for clarification but no followUpGoalMessage defined for this persona.`);
        return { transcript, issues };
      }
    }

    // Goal detected — run enrichment
    const [immediateAnswer, raceInfo] = await Promise.all([
      detectAndAnswerImmediate(persona.followUpGoalMessage || persona.firstMessage, parsed.goal),
      generateRaceAcknowledgment(persona.followUpGoalMessage || persona.firstMessage),
    ]);

    if (raceInfo.distanceOptions && raceInfo.distanceOptions.length > 1) {
      // Multi-distance clarification needed
      const namePrefix = name ? `${name}, ` : "";
      const options = raceInfo.distanceOptions.join(", ");
      const ackPart = raceInfo.ack ? `${raceInfo.ack}\n\n` : "";
      const clarificationMsg = `${ackPart}${namePrefix}Which distance are you targeting — ${options}?`;
      log("DEAN", clarificationMsg);
      issue("Race has multiple distances — Dean asks for clarification (this path ends the simulation for this persona)");
      return { transcript, issues };
    }

    const sportType = getSportType(parsed.goal);
    const mergedData = {
      ...onboardingData,
      goal: parsed.goal,
      sport_type: sportType,
      ...extra,
      ...(raceInfo.raceDate && !extra.race_date ? { race_date: raceInfo.raceDate } : {}),
      ...(parsed.no_event && !extra.race_date && !raceInfo.raceDate ? { race_date: null } : {}),
    };

    if (extra.name) mergedData.name = extra.name;
    if (name && !mergedData.name) mergedData.name = name;

    const nextStep = findNextStep("awaiting_goal", mergedData);
    onboardingData = mergedData;
    step = nextStep;

    const goalLabel = formatGoalInline(parsed.goal);
    let acknowledgment;
    if (raceInfo.ack) {
      acknowledgment = raceInfo.ack;
    } else if (parsed.goal === "injury_recovery") {
      acknowledgment = `Got it${name ? `, ${name}` : ""} — coming back from injury safely is exactly what I'm here for. I'll build a return-to-run plan around your recovery, not a generic training schedule.`;
    } else if (parsed.goal === "general_fitness") {
      acknowledgment = `Love it${name ? `, ${name}` : ""} — building a consistent habit is a great foundation. I'll put together a plan that builds properly and adapts to your schedule.`;
    } else {
      const isNewer = extra.experience_years != null && extra.experience_years < 1;
      const whatDeanDoes = isNewer
        ? `I'll keep the plan manageable and build up at a pace that gets you to the start line healthy.`
        : `I'll put together a tailored plan, track your training via Strava, and adjust things as your fitness builds.`;
      acknowledgment = `Love it${name ? `, ${name}` : ""} — a ${goalLabel} is a great goal. ${whatDeanDoes}`;
    }

    const question = nextStep ? getStepQuestion(nextStep, onboardingData) : "";
    let responseText;
    if (immediateAnswer) {
      const bridge =
        parsed.goal === "injury_recovery"
          ? "Want me to put together a return-to-run plan? A few quick questions first."
          : parsed.goal === "general_fitness"
          ? "Would you like me to put together a training plan around your goals? I have just a few quick questions."
          : `Would you like me to build you a proper ${goalLabel} training plan? I just have a few quick questions.`;
      responseText = `${immediateAnswer}\n\n${bridge}${question ? `\n\n${question}` : ""}`.trim();
    } else {
      responseText = `${acknowledgment}${question ? ` ${question}` : ""}`.trim();
    }
    log("DEAN", responseText);
    if (!nextStep) {
      log("DEAN", "[ONBOARDING COMPLETE — plan would be generated]");
      return { transcript, issues };
    }
  }

  // -------------------------------------------------------------------------
  // Remaining steps — iterate through the queue
  // -------------------------------------------------------------------------
  const maxSteps = 10;
  let stepCount = 0;

  while (step && stepCount < maxSteps) {
    stepCount++;

    // Get the athlete's reply for this step from persona.replies
    const athleteReply = persona.replies && persona.replies[step];
    if (!athleteReply) {
      issue(`No reply defined for step "${step}" — simulation ends here`);
      break;
    }

    // Check off-topic (skip for awaiting_anything_else, awaiting_name)
    if (step !== "awaiting_anything_else" && step !== "awaiting_name" && step !== "awaiting_strava") {
      const offTopicResult = await checkOffTopic(step, athleteReply);
      if (offTopicResult.offTopic) {
        log("ATHLETE", athleteReply);
        log("DEAN", offTopicResult.response);
        issue(`Off-topic detected at step "${step}": athlete message was flagged as off-topic`);
        // Use a fallback on-topic reply if provided
        const fallbackReply = persona.replies[step + "_fallback"];
        if (!fallbackReply) {
          issue(`No fallback reply for off-topic at "${step}" — simulation ends`);
          break;
        }
        log("ATHLETE", fallbackReply);
        // Re-check (usually won't be off-topic twice)
      } else {
        log("ATHLETE", athleteReply);
      }
    } else {
      log("ATHLETE", athleteReply);
    }

    // Process the step
    let nextStep = null;
    let deanResponse = null;

    if (step === "awaiting_race_date") {
      const [parsed, extra, ack] = await Promise.all([
        parseRaceDate(athleteReply),
        extractAdditionalFields(athleteReply),
        acknowledgeSharedInfo(athleteReply),
      ]);
      const mergedData = { ...onboardingData, ...removeNulls(extra), race_date: parsed.race_date };
      nextStep = findNextStep("awaiting_race_date", mergedData);
      onboardingData = mergedData;
      if (nextStep) {
        const nextQuestion = getStepQuestion(nextStep, onboardingData);
        deanResponse = ack ? `${ack}\n\n${nextQuestion}` : nextQuestion;
      }

    } else if (step === "awaiting_goal_time") {
      const [goalTimeMinutes, ack] = await Promise.all([
        parseGoalTime(athleteReply),
        acknowledgeSharedInfo(athleteReply),
      ]);
      const mergedData = { ...onboardingData, goal_time_minutes: goalTimeMinutes };
      nextStep = findNextStep("awaiting_goal_time", mergedData);
      onboardingData = mergedData;
      if (nextStep) {
        const nextQuestion = getStepQuestion(nextStep, onboardingData);
        deanResponse = ack ? `${ack}\n\n${nextQuestion}` : nextQuestion;
      }

    } else if (step === "awaiting_strava") {
      // Simulate athlete skipping Strava
      const mergedData = { ...onboardingData, strava_skipped: true };
      nextStep = findNextStep("awaiting_strava", mergedData);
      onboardingData = mergedData;
      const isSkip = /skip|no strava|don.?t have|no thanks|nope|later|next/i.test(athleteReply);
      if (nextStep) {
        const [nextQuestion, ack] = await Promise.all([
          Promise.resolve(getStepQuestion(nextStep, onboardingData)),
          acknowledgeSharedInfo(athleteReply),
        ]);
        deanResponse = ack
          ? `${ack}\n\n${nextQuestion}`
          : isSkip
          ? `No worries! ${nextQuestion}`
          : `Got it — ${nextQuestion}`;
      }

    } else if (step === "awaiting_schedule") {
      const [parsed, extra] = await Promise.all([
        parseSchedule(athleteReply),
        extractAdditionalFields(athleteReply),
      ]);
      if (!parsed.complete) {
        const ack = await acknowledgeSharedInfo(athleteReply);
        const followUp = parsed.follow_up || "Which specific days of the week work best for you?";
        deanResponse = ack ? `${ack}\n\n${followUp}` : followUp;
        issue(`Schedule parse incomplete at step "${step}" — will re-ask`);
        log("DEAN", deanResponse);
        // Use schedule_retry reply if available
        const retryReply = persona.replies["awaiting_schedule_retry"];
        if (retryReply) {
          log("ATHLETE", retryReply);
          const parsed2 = await parseSchedule(retryReply);
          if (parsed2.complete) {
            const trainingDays = parsed2.training_days ?? ["tuesday", "thursday", "saturday", "sunday"];
            const daysPerWeek = parsed2.days_per_week ?? trainingDays.length;
            const mergedData2 = { ...onboardingData, ...removeNulls(extra), days_per_week: daysPerWeek, training_days: trainingDays };
            nextStep = findNextStep("awaiting_schedule", mergedData2);
            onboardingData = mergedData2;
            const [scheduleAck, nextQuestion] = await Promise.all([
              acknowledgeSchedule(retryReply, trainingDays),
              Promise.resolve(nextStep ? getStepQuestion(nextStep, onboardingData) : ""),
            ]);
            deanResponse = nextQuestion ? `${scheduleAck}\n\n${nextQuestion}` : scheduleAck;
          }
        } else {
          issue(`No schedule_retry reply for persona — simulation ends at schedule`);
          break;
        }
      } else {
        const trainingDays = parsed.training_days ?? ["tuesday", "thursday", "saturday", "sunday"];
        const daysPerWeek = parsed.days_per_week ?? trainingDays.length;
        const mergedData = { ...onboardingData, ...removeNulls(extra), days_per_week: daysPerWeek, training_days: trainingDays };
        nextStep = findNextStep("awaiting_schedule", mergedData);
        onboardingData = mergedData;
        const [scheduleAck, nextQuestion] = await Promise.all([
          acknowledgeSchedule(athleteReply, trainingDays),
          Promise.resolve(nextStep ? getStepQuestion(nextStep, onboardingData) : ""),
        ]);
        deanResponse = nextQuestion ? `${scheduleAck}\n\n${nextQuestion}` : scheduleAck;
      }

    } else if (step === "awaiting_ultra_background") {
      const [extracted, ack] = await Promise.all([
        parseUltraBackground(athleteReply),
        acknowledgeSharedInfo(athleteReply),
      ]);
      const merged = { ...onboardingData };
      if (extracted.ultra_race_history) merged.ultra_race_history = extracted.ultra_race_history;
      if (extracted.weekly_miles != null) merged.weekly_miles = extracted.weekly_miles;
      if (extracted.current_long_run_miles != null) merged.current_long_run_miles = extracted.current_long_run_miles;
      if (extracted.experience_years != null) merged.experience_years = extracted.experience_years;
      if (extracted.ultra_race_history) {
        const existing = onboardingData.other_notes || "";
        merged.other_notes = existing ? `${existing}; ${extracted.ultra_race_history}` : extracted.ultra_race_history;
      }
      nextStep = findNextStep("awaiting_ultra_background", merged);
      onboardingData = merged;
      if (nextStep) {
        const nextQuestion = getStepQuestion(nextStep, onboardingData);
        deanResponse = ack ? `${ack}\n\n${nextQuestion}` : nextQuestion;
      }

    } else if (step === "awaiting_timezone") {
      // Simulate simple timezone capture
      const mergedData = { ...onboardingData, timezone_confirmed: true };
      nextStep = findNextStep("awaiting_timezone", mergedData);
      onboardingData = mergedData;
      if (nextStep) {
        const [nextQuestion, ack] = await Promise.all([
          Promise.resolve(getStepQuestion(nextStep, onboardingData)),
          acknowledgeSharedInfo(athleteReply),
        ]);
        deanResponse = ack ? `${ack}\n\n${nextQuestion}` : nextQuestion;
      }

    } else if (step === "awaiting_anything_else") {
      const [extracted, conversational] = await Promise.all([
        extractAnythingElse(athleteReply),
        generateAnythingElseResponse(athleteReply, onboardingData),
      ]);
      const merged = { ...onboardingData, ...removeNulls(extracted) };

      if (!conversational.isDone && conversational.response) {
        // Athlete asked a question or shared info — respond and re-ask
        log("DEAN", conversational.response);
        issue(`"anything else" step required a follow-up — athlete message generated a conversational response rather than completing`);
        // Use follow-up reply if provided
        const followupReply = persona.replies["awaiting_anything_else_followup"];
        if (followupReply) {
          log("ATHLETE", followupReply);
          const [extracted2, conversational2] = await Promise.all([
            extractAnythingElse(followupReply),
            generateAnythingElseResponse(followupReply, merged),
          ]);
          const merged2 = { ...merged, ...removeNulls(extracted2) };
          if (conversational2.isDone) {
            onboardingData = merged2;
            nextStep = findNextStep("awaiting_anything_else", merged2);
          } else {
            log("DEAN", conversational2.response || "[Still not done — would re-ask again]");
            issue(`"anything else" step still not resolved after follow-up`);
            break;
          }
        } else {
          onboardingData = merged;
          nextStep = findNextStep("awaiting_anything_else", merged);
        }
      } else {
        onboardingData = merged;
        nextStep = findNextStep("awaiting_anything_else", merged);
      }

      if (!nextStep) {
        // Onboarding complete
        deanResponse = "[ONBOARDING COMPLETE — initial_plan would be generated and sent]";
        log("DEAN", deanResponse);
        step = null;
        break;
      }

    } else if (step === "awaiting_name") {
      // Extract name and complete
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 32,
        system: `Extract the person's name from their message. Return ONLY the name — no punctuation, no extra words. Capitalize properly (e.g. "sarah" → "Sarah", "sarah thomas" → "Sarah Thomas"). If no name is present, return the single word: null`,
        messages: [{ role: "user", content: athleteReply }],
      });
      const nameText = response.content[0].type === "text" ? response.content[0].text.trim() : "";
      if (nameText && nameText.toLowerCase() !== "null") {
        onboardingData.name = nameText;
      }
      deanResponse = "[ONBOARDING COMPLETE — initial_plan would be generated and sent]";
      log("DEAN", deanResponse);
      step = null;
      break;
    }

    if (deanResponse) log("DEAN", deanResponse);
    step = nextStep;
  }

  if (step) {
    issue(`Simulation ended with step "${step}" still active (max iterations or missing replies)`);
  }

  return { transcript, issues };
}

// ---------------------------------------------------------------------------
// The 10 athlete personas
// ---------------------------------------------------------------------------

const personas = [
  {
    id: 1,
    label: "Beginner, no race goal",
    firstMessage: "Hi I'm Sarah, I just want to start running regularly, no races in mind",
    replies: {
      awaiting_race_date: "no event in mind right now, just building a habit",
      awaiting_strava: "skip",
      awaiting_schedule: "3 days a week, maybe Tuesday, Thursday, and Saturday?",
      awaiting_timezone: "Salt Lake City",
      awaiting_anything_else: "nope, that's it!",
    },
  },
  {
    id: 2,
    label: "Beginner, 5K goal",
    firstMessage: "Hey, I'm Mike. I've never run before but I want to do a 5K in about 3 months",
    replies: {
      awaiting_race_date: "end of June probably",
      awaiting_goal_time: "no specific time goal, just want to finish running the whole way",
      awaiting_strava: "skip — no strava",
      awaiting_schedule: "4 days a week, Monday Wednesday Friday and Sunday",
      awaiting_timezone: "Phoenix AZ",
      awaiting_anything_else: "nope that's all",
    },
  },
  {
    id: 3,
    label: "Intermediate, first half marathon",
    firstMessage: "I'm Lisa, training for my first half marathon in October",
    replies: {
      awaiting_goal_time: "just want to finish — no time goal",
      awaiting_strava: "skip",
      awaiting_schedule: "4 days, Mon/Wed/Fri/Sun works",
      awaiting_timezone: "Denver",
      awaiting_anything_else: "I do some yoga and strength training but nothing too structured",
    },
  },
  {
    id: 4,
    label: "Advanced with sub-3 marathon goal",
    firstMessage: "Tom here. Running Boston Marathon, I want to go sub-3:00",
    replies: {
      awaiting_goal_time: "sub-3:00 — 2:59 ideally",
      awaiting_strava: "skip",
      awaiting_schedule: "6 days a week — Mon through Sat",
      awaiting_timezone: "Boston MA",
      awaiting_anything_else: "I run about 60 miles a week right now, easy pace around 8:30/mile",
    },
  },
  {
    id: 5,
    label: "Multiple races (BTR trail + 100K)",
    firstMessage: "I'm Jake, I want to do the Behind the Rocks trail race in March, and then a 100K this summer",
    replies: {
      awaiting_strava: "skip",
      awaiting_schedule: "5 days — Mon, Tue, Thu, Fri, Sat",
      awaiting_ultra_background: "I've done 3 50Ks and one 50-miler. Running about 50 miles a week, long runs are usually around 18-20 miles.",
      awaiting_timezone: "Moab Utah",
      awaiting_anything_else: "nope, that covers it",
    },
  },
  {
    id: 6,
    label: "Injured athlete returning to running",
    firstMessage: "Hey, I'm Amy. I had a stress fracture 6 weeks ago and want to start running again carefully",
    replies: {
      awaiting_strava: "skip",
      awaiting_schedule: "3 days a week to start, maybe Monday Wednesday Friday",
      awaiting_timezone: "Chicago",
      awaiting_anything_else: "The fracture was in my left metatarsal — docs cleared me to start easy running last week. Still a bit nervous about it.",
      awaiting_anything_else_followup: "nope that's everything",
    },
  },
  {
    id: 7,
    label: "Ultra runner (multiple 50Ks → first 100K)",
    firstMessage: "Dan here. I've done several 50Ks and want to do my first 100K",
    replies: {
      awaiting_race_date: "August, no specific race yet",
      awaiting_strava: "skip",
      awaiting_schedule: "6 days a week, Mon through Sat",
      awaiting_ultra_background: "Done 5 50Ks over the last 3 years. Currently running about 55 miles a week, long runs up to 22 miles. No 100K yet.",
      awaiting_timezone: "Portland Oregon",
      awaiting_anything_else: "nope all good",
    },
  },
  {
    id: 8,
    label: "Asks about cycling + half marathon",
    firstMessage: "Hi I'm Chris! Quick question first — do you work with people who also do cycling? I want to train for a half marathon but also race some crits",
    replies: {
      awaiting_race_date: "October, no exact date yet",
      awaiting_goal_time: "not sure, ideally around 1:45 but honestly just want to finish strong",
      awaiting_strava: "skip",
      awaiting_schedule: "5 days — mix of running and cycling, Mon/Wed/Fri for running, Tue/Thu for cycling",
      awaiting_timezone: "Austin Texas",
      awaiting_anything_else: "nope that should cover it",
    },
  },
  {
    id: 9,
    label: "College runner returning, no event yet",
    firstMessage: "I'm Rachel. I used to run in college but haven't in 5 years. I'm not signed up for anything yet but want to get back into it",
    replies: {
      awaiting_race_date: "no event yet — let's keep it open-ended for now",
      awaiting_strava: "skip",
      awaiting_schedule: "4 days a week, Tuesday Wednesday Friday and Sunday",
      awaiting_timezone: "Seattle WA",
      awaiting_anything_else: "I did a 1:42 half in college. Probably in much worse shape now but that's a rough reference",
      awaiting_anything_else_followup: "nah that's it",
    },
  },
  {
    id: 10,
    label: "Asks a planning question in 'anything else'",
    firstMessage: "I'm Jordan, I've been running for 2 years and want to do a marathon in October",
    replies: {
      awaiting_race_date: "October 19th",
      awaiting_goal_time: "probably around 4 hours, maybe a little under",
      awaiting_strava: "skip",
      awaiting_schedule: "4 days a week — Mon, Wed, Fri, Sun",
      awaiting_timezone: "Minneapolis",
      awaiting_anything_else: "Can you build the plan for my race first, then we'll do a base-building block after?",
      awaiting_anything_else_followup: "sounds good, nothing else from me",
    },
  },
];

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main() {
  const allIssues = [];

  for (const persona of personas) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`=== ATHLETE ${persona.id}: ${persona.label} ===`);
    console.log(`${"=".repeat(70)}\n`);

    let result;
    try {
      result = await simulateAthlete(persona);
    } catch (err) {
      console.error(`ERROR simulating athlete ${persona.id}:`, err);
      allIssues.push({ athleteId: persona.id, label: persona.label, issues: [`CRASH: ${err.message}`] });
      continue;
    }

    const { transcript, issues } = result;

    for (const turn of transcript) {
      console.log(`${turn.role}: ${turn.message}\n`);
    }

    console.log("--- Issues observed ---");
    if (issues.length === 0) {
      console.log("(none)");
    } else {
      for (const issue of issues) {
        console.log(`- ${issue}`);
      }
    }

    allIssues.push({ athleteId: persona.id, label: persona.label, issues });
  }

  // ---------------------------------------------------------------------------
  // Consolidated report
  // ---------------------------------------------------------------------------
  console.log(`\n${"=".repeat(70)}`);
  console.log("=== CONSOLIDATED REPORT ===");
  console.log(`${"=".repeat(70)}\n`);

  // Aggregate all issues
  const highIssues = [];
  const mediumIssues = [];
  const lowIssues = [];

  for (const { athleteId, label, issues } of allIssues) {
    for (const issue of issues) {
      const entry = `[Athlete ${athleteId} — ${label}] ${issue}`;
      // Classify by keywords
      if (
        issue.includes("CRASH") ||
        issue.includes("failed") ||
        issue.includes("stall") ||
        issue.includes("not detected") ||
        issue.includes("still not resolved")
      ) {
        highIssues.push(entry);
      } else if (
        issue.includes("incomplete") ||
        issue.includes("Off-topic detected") ||
        issue.includes("required a follow-up") ||
        issue.includes("simulation ends")
      ) {
        mediumIssues.push(entry);
      } else {
        lowIssues.push(entry);
      }
    }
  }

  console.log("HIGH severity:");
  if (highIssues.length === 0) {
    console.log("  (none)");
  } else {
    for (const i of highIssues) console.log(`  - ${i}`);
  }

  console.log("\nMEDIUM severity:");
  if (mediumIssues.length === 0) {
    console.log("  (none)");
  } else {
    for (const i of mediumIssues) console.log(`  - ${i}`);
  }

  console.log("\nLOW severity:");
  if (lowIssues.length === 0) {
    console.log("  (none)");
  } else {
    for (const i of lowIssues) console.log(`  - ${i}`);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("NOTE: This simulation SKIPS the awaiting_strava step for all athletes");
  console.log("(all personas reply 'skip' to the Strava prompt).");
  console.log("Real users may connect Strava, which skips ultra_background and timezone steps.");
  console.log(`${"=".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
