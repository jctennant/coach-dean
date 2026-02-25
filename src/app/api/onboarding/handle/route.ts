import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS } from "@/lib/linq";

interface OnboardingRequest {
  userId: string;
  message: string;
}

/** Extract JSON from Claude's response, handling markdown code blocks */
function extractJSON(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text;
}

/**
 * POST /api/onboarding/handle
 *
 * Flow:
 *   awaiting_goal
 *   → awaiting_race_date
 *   → awaiting_schedule
 *   → awaiting_anything_else   ← "Before I put your plan together, anything else?"
 *   → null (complete → initial_plan fires)
 *
 * Steps are skipped automatically if data was already captured in an earlier message.
 */
export async function POST(request: Request) {
  const { userId, message }: OnboardingRequest = await request.json();

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, phone_number, name, onboarding_step, onboarding_data")
    .eq("id", userId)
    .single();

  if (userError || !user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const step = user.onboarding_step;
  const onboardingData = (user.onboarding_data as Record<string, unknown>) || {};

  // Before routing to a step handler, check if the message is off-topic.
  // Skip awaiting_goal — handleGoal already handles all cases (greetings, partial, off-topic).
  // Skip awaiting_anything_else — any response is valid there (user can write anything).
  if (step && step !== "awaiting_goal" && step !== "awaiting_anything_else") {
    const offTopicResult = await checkOffTopic(step, message);
    if (offTopicResult.offTopic) {
      await sendAndStore(user.id, user.phone_number, offTopicResult.response);
      return NextResponse.json({ ok: true });
    }
  }

  switch (step) {
    case "awaiting_goal":
      return handleGoal(user, message, onboardingData);
    case "awaiting_race_date":
      return handleRaceDate(user, message, onboardingData);
    case "awaiting_schedule":
      return handleSchedule(user, message, onboardingData);
    case "awaiting_anything_else":
      return handleAnythingElse(user, message, onboardingData);
    default:
      return NextResponse.json({ ok: true });
  }
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

async function handleGoal(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 128,
    system: `Classify whether the user's message contains a clear fitness or endurance goal. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "goal": "5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"100k"|"sprint_tri"|"olympic_tri"|"70.3"|"ironman"|"cycling"|"general_fitness"|null}

Rules:
- complete: true only if a clear training goal is identifiable
- Pure greetings with no goal context → complete: false, goal: null
- "half marathon" or "half" → "half_marathon"
- "full marathon" or "marathon" → "marathon"
- "ultra" without distance → "50k"
- "triathlon" or "tri" without a distance → "olympic_tri"
- "sprint tri" or "sprint triathlon" → "sprint_tri"
- "70.3", "half ironman", "half-ironman" → "70.3"
- "ironman", "full ironman", "140.6" → "ironman"
- "cycling", "gravel race", "gran fondo", "bike race" → "cycling"
- "just getting in shape", "get fit", "lose weight", "general" → "general_fitness"
- When complete is false, goal must be null`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] goal raw response:", parseText);

  let parsed: { complete: boolean; goal: string | null } = { complete: false, goal: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] goal parse failed:", e);
  }

  if (!parsed.complete || !parsed.goal) {
    // No goal detected (pure greeting, ambiguous message, etc.)
    // Send the welcome + goal question — this covers both new users arriving via SMS
    // and existing awaiting_goal users who sent something unclear.
    await sendAndStore(
      user.id,
      user.phone_number,
      "Hey, I'm Coach Dean! 👋 I'll be your endurance coach over text.\n\nWhat are you training for? (e.g. 5K, marathon, ultra, triathlon, 70.3, Ironman, cycling, or general fitness?)"
    );
    return NextResponse.json({ ok: true });
  }

  // Run in parallel: extract additional onboarding fields the user already answered in passing,
  // and detect any immediate coaching questions that deserve a quick answer.
  const [extra, immediateAnswer] = await Promise.all([
    extractAdditionalFields(message),
    detectAndAnswerImmediate(message, parsed.goal),
  ]);
  const sportType = getSportType(parsed.goal);
  const mergedData = { ...onboardingData, goal: parsed.goal, sport_type: sportType, ...extra };

  const nextStep = findNextStep("awaiting_goal", mergedData);

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: mergedData })
    .eq("id", user.id);

  const goalLabel = formatGoalInline(parsed.goal);
  const acknowledgment =
    parsed.goal === "general_fitness"
      ? "Love it — building consistent fitness is a great foundation."
      : `Love it, a ${goalLabel} — great goal.`;

  const question = nextStep ? getStepQuestion(nextStep, mergedData) : "";

  let responseText: string;
  if (immediateAnswer) {
    // Bridge from the coaching answer back to the onboarding flow naturally
    const bridge =
      parsed.goal === "general_fitness"
        ? "Would you like me to put together a training plan around your goals? I have just a few quick questions."
        : `Would you like me to build you a proper ${goalLabel} training plan? I just have a few quick questions.`;
    responseText = `${immediateAnswer}\n\n${bridge}${question ? `\n\n${question}` : ""}`.trim();
  } else {
    responseText = `${acknowledgment}${question ? ` ${question}` : ""}`.trim();
  }
  await sendAndStore(user.id, user.phone_number, responseText);
  return NextResponse.json({ ok: true });
}

async function handleRaceDate(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 64,
    system: `Extract a race/target date from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"race_date": "YYYY-MM-DD" | null}

Rules:
- If they mention a month without a year, assume ${new Date().getFullYear()} — or next year if that month has already passed
- "no race", "not sure", "open-ended", "no date", "TBD" → null
- "end of October" → last day of October
- Today is ${new Date().toISOString().split("T")[0]}`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] race_date raw response:", parseText);

  let parsed: { race_date: string | null } = { race_date: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] race_date parse failed:", e);
  }

  const mergedData = { ...onboardingData, race_date: parsed.race_date };
  const nextStep = findNextStep("awaiting_race_date", mergedData);

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: mergedData })
    .eq("id", user.id);

  if (nextStep) await sendAndStore(user.id, user.phone_number, getStepQuestion(nextStep, mergedData));
  return NextResponse.json({ ok: true });
}

async function handleSchedule(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: `Extract training schedule preferences from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "days_per_week": number|null, "training_days": ["monday"|...|"sunday"]|null, "long_run_day": "<day>"|null, "follow_up": string|null}

Rules:
- Normalize all day names to full lowercase
- complete: true whenever you have enough to build a schedule — even if every specific day isn't named
- "3-4 days, weekdays better, Sunday long run" → complete: true. Pick 3 or 4 weekdays + Sunday, long_run_day: "sunday"
- "Weekdays" alone → complete: true, training_days: ["monday","tuesday","wednesday","thursday","friday"]
- "Weekends" → complete: true, training_days: ["saturday","sunday"]
- A count + day preference is enough: "4 days, prefer Mon/Wed/Fri/Sat" → complete: true, fill in all 4
- "doesn't matter", "no preference", "whatever works", "any days" → complete: true. Use a balanced default (e.g. Mon, Wed, Fri, Sun for 4 days). Set long_run_day: "sunday" unless otherwise stated.
- For a range like "3-4 days" with no other info → complete: false, follow_up asks preference or just long run day
- complete: false ONLY if there is truly not enough to infer any schedule at all
- long_run_day: null if not mentioned
- days_per_week: use the number or the midpoint of a range ("3-4" → 4)
- follow_up: only what's still missing — do NOT re-ask for info already given. If days_per_week is known, don't ask again.
- If complete is true, follow_up must be null`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] schedule raw response:", parseText);

  let parsed: {
    complete: boolean;
    days_per_week: number | null;
    training_days: string[] | null;
    long_run_day: string | null;
    follow_up: string | null;
  } = { complete: false, days_per_week: null, training_days: null, long_run_day: null, follow_up: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] schedule parse failed:", e);
  }

  if (!parsed.complete) {
    const followUp =
      parsed.follow_up ||
      "Which specific days of the week work best for you — and which day would you prefer for your long run?";
    await sendAndStore(user.id, user.phone_number, followUp);
    return NextResponse.json({ ok: true });
  }

  // Infer days_per_week from training_days if not provided
  const trainingDays = parsed.training_days ?? ["tuesday", "thursday", "saturday", "sunday"];
  const daysPerWeek = parsed.days_per_week ?? trainingDays.length;

  const mergedData = {
    ...onboardingData,
    days_per_week: daysPerWeek,
    training_days: trainingDays,
    long_run_day: parsed.long_run_day,
  };
  const nextStep = findNextStep("awaiting_schedule", mergedData);

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: mergedData })
    .eq("id", user.id);

  if (nextStep) await sendAndStore(user.id, user.phone_number, getStepQuestion(nextStep, mergedData));
  return NextResponse.json({ ok: true });
}

async function handleAnythingElse(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const extracted = await extractAnythingElse(message);

  // Merge: strip nulls from extracted so pre-existing data isn't overwritten
  const merged = { ...onboardingData, ...removeNulls(extracted as unknown as Record<string, unknown>) };

  // Compute paces from extracted race data or easy pace
  if (extracted.recent_race_distance_km && extracted.recent_race_time_minutes) {
    const paces = calculateVDOTPaces(extracted.recent_race_distance_km, extracted.recent_race_time_minutes);
    if (!merged.easy_pace) {
      merged.easy_pace = paces.easy;
      merged.tempo_pace = paces.tempo;
      merged.interval_pace = paces.interval;
    }
  } else if (extracted.easy_pace || merged.easy_pace) {
    const paces = estimatePacesFromEasyPace((extracted.easy_pace ?? merged.easy_pace) as string);
    if (!merged.easy_pace) {
      merged.easy_pace = paces.easy;
      merged.tempo_pace = paces.tempo;
      merged.interval_pace = paces.interval;
    }
  }

  const goal = (merged.goal as string) || "general_fitness";
  const raceDate = (merged.race_date as string) || null;
  const experienceYears = (merged.experience_years as number) ?? 1;
  const weeklyMiles = (merged.weekly_miles as number) ?? null;
  const weeklyHours = (merged.weekly_hours as number) || null;
  const crosstrain = (merged.crosstraining_tools as string[]) || [];
  const daysPerWeek = (merged.days_per_week as number) ?? 4;
  const trainingDays = (merged.training_days as string[]) || [];
  const easyPace = (merged.easy_pace as string) || null;
  const tempoPace = (merged.tempo_pace as string) || null;
  const intervalPace = (merged.interval_pace as string) || null;
  const injuryNotes = (merged.injury_notes as string) || null;

  const fitnessLevel = assessFitnessLevel(experienceYears, weeklyMiles, weeklyHours);
  const weeklyMilesRaw = weeklyMiles ?? 15;
  const weeklyMileage =
    weeklyMilesRaw <= 0 ? 10 :
    weeklyMilesRaw <= 10 ? Math.ceil(weeklyMilesRaw) :
    Math.round(weeklyMilesRaw / 5) * 5 || 15;
  const longRun = Math.round(weeklyMileage * 0.3);

  const [profileResult, stateResult, userResult] = await Promise.all([
    supabase.from("training_profiles").upsert(
      {
        user_id: user.id,
        goal,
        race_date: raceDate,
        fitness_level: fitnessLevel,
        days_per_week: daysPerWeek,
        training_days: trainingDays,
        current_easy_pace: easyPace,
        current_tempo_pace: tempoPace,
        current_interval_pace: intervalPace,
        crosstraining_tools: crosstrain,
        proactive_cadence: "weekly_only",
        injury_notes: injuryNotes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    ),
    supabase.from("training_state").upsert(
      {
        user_id: user.id,
        current_week: 1,
        current_phase: "base",
        weekly_mileage_target: weeklyMileage,
        long_run_target: longRun,
        week_mileage_so_far: 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    ),
    supabase
      .from("users")
      .update({
        onboarding_step: null,
        onboarding_data: merged,
      })
      .eq("id", user.id),
  ]);

  if (profileResult.error) console.error("[onboarding] training_profiles upsert failed:", profileResult.error);
  if (stateResult.error) console.error("[onboarding] training_state upsert failed:", stateResult.error);
  if (userResult.error) console.error("[onboarding] users update failed:", userResult.error);

  // No wrap-up SMS — the initial_plan IS the response.
  after(async () => {
    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, trigger: "initial_plan" }),
      });
    } catch (err) {
      console.error("[onboarding] coach trigger failed:", err);
    }
  });

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Pace calculation helpers
// ---------------------------------------------------------------------------

/**
 * Calculate VDOT-based training paces from a race performance.
 * Uses Jack Daniels' Running Formula.
 */
function calculateVDOTPaces(
  distanceKm: number,
  timeMinutes: number
): { easy: string; tempo: string; interval: string } {
  const v = (distanceKm * 1000) / timeMinutes; // meters per minute

  const pctVO2 =
    0.8 +
    0.1894393 * Math.exp(-0.012778 * timeMinutes) +
    0.2989558 * Math.exp(-0.1932605 * timeMinutes);

  const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
  const vdot = vo2 / pctVO2;

  return {
    easy: paceAtVDOTPct(vdot, 0.65),
    tempo: paceAtVDOTPct(vdot, 0.86),
    interval: paceAtVDOTPct(vdot, 0.98),
  };
}

function paceAtVDOTPct(vdot: number, pct: number): string {
  const targetVO2 = vdot * pct;
  const a = 0.000104;
  const b = 0.182258;
  const c = -(targetVO2 + 4.60);
  const v = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  const minPerMile = 1609.34 / v;
  const min = Math.floor(minPerMile);
  const sec = Math.round((minPerMile - min) * 60);
  return `${min}:${String(sec).padStart(2, "0")}/mi`;
}

function estimatePacesFromEasyPace(paceStr: string | null): {
  easy: string | null;
  tempo: string | null;
  interval: string | null;
} {
  if (!paceStr) return { easy: null, tempo: null, interval: null };

  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return { easy: paceStr, tempo: null, interval: null };

  const easySec = parseInt(match[1]) * 60 + parseInt(match[2]);
  const fmt = (s: number) => {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${String(sec).padStart(2, "0")}/mi`;
  };

  return {
    easy: fmt(easySec),
    tempo: easySec > 90 ? fmt(easySec - 90) : null,
    interval: easySec > 150 ? fmt(easySec - 150) : null,
  };
}

// ---------------------------------------------------------------------------
// Step routing helpers
// ---------------------------------------------------------------------------

const TRIATHLON_GOALS = ["sprint_tri", "olympic_tri", "70.3", "ironman"];
const CYCLING_GOALS = ["cycling"];

function getSportType(goal: string): "running" | "triathlon" | "cycling" | "general" {
  if (TRIATHLON_GOALS.includes(goal)) return "triathlon";
  if (CYCLING_GOALS.includes(goal)) return "cycling";
  if (goal === "general_fitness") return "general";
  return "running";
}

/**
 * Ordered list of onboarding steps after awaiting_goal.
 * findNextStep walks this list and returns the first unsatisfied step.
 */
const STEP_ORDER = [
  "awaiting_race_date",
  "awaiting_schedule",
  "awaiting_anything_else",
];

/**
 * Returns true if the data collected so far already satisfies this step,
 * meaning we can skip asking about it.
 */
function isStepSatisfied(step: string, data: Record<string, unknown>): boolean {
  switch (step) {
    case "awaiting_race_date":
      // Satisfied if race_date key exists (even null = "no race")
      return Object.prototype.hasOwnProperty.call(data, "race_date");
    case "awaiting_schedule":
      return Array.isArray(data.training_days) && (data.training_days as string[]).length > 0;
    case "awaiting_anything_else":
      return false; // Always ask exactly once — never pre-satisfied
    default:
      return false;
  }
}

/**
 * Returns the next step the user needs to answer, or null if all are done.
 * Skips steps where data is already available.
 */
function findNextStep(afterStep: string, data: Record<string, unknown>): string | null {
  const afterIdx = STEP_ORDER.indexOf(afterStep);
  const remaining = afterIdx >= 0 ? STEP_ORDER.slice(afterIdx + 1) : [...STEP_ORDER];
  for (const step of remaining) {
    if (!isStepSatisfied(step, data)) return step;
  }
  return null;
}

/** Returns the question to ask for a given step, given current onboarding data. */
function getStepQuestion(step: string, data: Record<string, unknown>): string {
  const sport = (data.sport_type as string) || "running";
  const isTri = sport === "triathlon";
  const isCycling = sport === "cycling";

  switch (step) {
    case "awaiting_race_date":
      return data.goal === "general_fitness"
        ? "Do you have a target event or date in mind? If not, just say 'no event' and we'll keep the plan open-ended."
        : "What's the date of your event? If you don't have one locked in yet, give me your best target and we can adjust later.";

    case "awaiting_schedule":
      if (isTri) return "How many days a week are you training total? And do you have any days that work better for longer sessions like a long ride or long run?";
      if (isCycling) return "How many days a week do you want to ride? And which days work best for your longer rides?";
      return "How many days a week do you want to run? And which days work best for you — including which day you'd prefer for your long run?";

    case "awaiting_anything_else":
      return "Before I put your plan together — anything else worth knowing? Injuries, recent races, target paces, that sort of thing.";

    default:
      return "";
  }
}

/**
 * Tries to extract any additional onboarding fields from a message beyond
 * what the current step is asking for. Used to pre-fill data and skip questions
 * the user already answered in passing.
 */
async function extractAdditionalFields(
  message: string
): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().split("T")[0];
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    system: `Extract any running/training information present in this message. Be generous with inference — if something is clearly implied, extract it.

Output format (omit fields that are not present):
{"race_date": "YYYY-MM-DD" | null, "experience_years": number | null, "weekly_miles": number | null, "easy_pace": "M:SS" | null, "injury_mentioned": boolean}

Rules:
- race_date: if a specific target race date is mentioned. Today is ${today}.
- experience_years: infer from any experience signal. "new runner" or "just started" → 0. "fairly inexperienced" → 0.2. "completed an 8 week plan" with no prior context → 0.15. "a year" → 1. "5+ years" → 5.
- weekly_miles: if weekly running volume is stated or clearly implied. Convert km to miles (×0.621).
- easy_pace: any stated comfortable, easy, conversational, or GPS/Strava estimated running pace. Format as M:SS per mile. "8:30/m" or "8:30/mile" → "8:30". "5:00/km" → "8:03". Extract even if the athlete thinks they can beat it — it's still a useful baseline.
- injury_mentioned: true if any injury or physical limitation is mentioned.
- Return {} if nothing is present.`,
    messages: [{ role: "user", content: message }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    const parsed = JSON.parse(extractJSON(text));
    const result: Record<string, unknown> = {};
    if (parsed.race_date != null) result.race_date = parsed.race_date;
    if (parsed.experience_years != null) result.experience_years = parsed.experience_years;
    if (parsed.weekly_miles != null) result.weekly_miles = parsed.weekly_miles;
    if (parsed.easy_pace != null) result.easy_pace = parsed.easy_pace;
    if (parsed.injury_mentioned === true) result.injury_mentioned = true;
    return result;
  } catch {
    return {};
  }
}

/**
 * Extracts all training-relevant information from the "anything else" message.
 * Returns all nulls if the user says nothing.
 */
interface AnythingElseExtracted {
  injury_notes: string | null;
  recent_race_distance_km: number | null;
  recent_race_time_minutes: number | null;
  easy_pace: string | null;
  experience_years: number | null;
  weekly_miles: number | null;
  crosstraining_tools: string[] | null;
  other_notes: string | null;
}

async function extractAnythingElse(message: string): Promise<AnythingElseExtracted> {
  const empty: AnythingElseExtracted = {
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
- weekly_miles: weekly running mileage (convert km × 0.621)
- crosstraining_tools: normalized array e.g. ["cycling", "swimming", "gym"]. null if none mentioned.
- other_notes: any other relevant info not captured above (target time goals, lifestyle constraints, etc.)
- Return all fields, using null for those not present`,
    messages: [{ role: "user", content: message }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  console.log("[onboarding] anything_else raw response:", text);
  try {
    return JSON.parse(extractJSON(text));
  } catch (e) {
    console.error("[onboarding] anything_else parse failed:", e);
    return empty;
  }
}

/** Strip null/undefined values from an object so pre-existing data isn't overwritten. */
function removeNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Detects whether the user's first message contains an immediate coaching question
 * (e.g. race-day prep, pacing advice, route suggestions) and returns a brief answer.
 * Returns null if no immediate question is present.
 */
async function detectAndAnswerImmediate(
  message: string,
  goal: string
): Promise<string | null> {
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

// ---------------------------------------------------------------------------
// Off-topic detection
// ---------------------------------------------------------------------------

/**
 * Before processing a step, check whether the user's message actually answers
 * the expected question. If it's off-topic (a question, comment, or unrelated
 * statement), Claude responds naturally and re-asks the current question.
 *
 * Returns { offTopic: false } if the message is on-topic (caller should proceed).
 * Returns { offTopic: true, response: string } if it was handled here.
 */
async function checkOffTopic(
  step: string,
  message: string
): Promise<{ offTopic: false } | { offTopic: true; response: string }> {
  const stepContext: Record<string, { topic: string }> = {
    awaiting_race_date: { topic: "their race date or target event" },
    awaiting_schedule: { topic: "their weekly training schedule and availability" },
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
- Random chit-chat with no relation to the topic
- Completely unrelated statements or questions
If off-topic: answer warmly in 1 sentence, then re-ask your question naturally. No markdown, no asterisks.`,
    messages: [{ role: "user", content: message }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text.trim() : "";

  try {
    const parsed = JSON.parse(extractJSON(text));
    if (parsed.on_topic === true) return { offTopic: false };
  } catch {
    // Not JSON — Claude wrote a plain-text off-topic response
  }

  return { offTopic: true, response: text };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function sendAndStore(userId: string, phone: string, message: string) {
  await Promise.all([
    sendSMS(phone, message),
    supabase.from("conversations").insert({
      user_id: userId,
      role: "assistant",
      content: message,
      message_type: "coach_response",
    }),
  ]);
}

function assessFitnessLevel(experienceYears: number, weeklyMiles: number | null, weeklyHours: number | null): string {
  // Use hours as primary signal for multi-sport athletes
  if (weeklyHours != null) {
    if (weeklyHours >= 10 || experienceYears >= 3) return "advanced";
    if (weeklyHours >= 5 || experienceYears >= 1) return "intermediate";
    return "beginner";
  }
  const miles = weeklyMiles ?? 0;
  if (miles >= 30 || experienceYears >= 3) return "advanced";
  if (miles >= 15 || experienceYears >= 1) return "intermediate";
  return "beginner";
}

function formatGoalInline(goal: string): string {
  const labels: Record<string, string> = {
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
  };
  return labels[goal] || goal;
}
