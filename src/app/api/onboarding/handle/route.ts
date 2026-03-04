import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping, shareContactCard } from "@/lib/linq";
import { trackEvent } from "@/lib/track";
import { calculateVDOTPaces, estimatePacesFromEasyPace } from "@/lib/paces";

export const maxDuration = 60;

interface OnboardingRequest {
  userId: string;
  message: string;
  chatId?: string | null;
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
 *   awaiting_goal              ← intro + asks name + goal in one message
 *   → awaiting_race_date
 *   → awaiting_schedule
 *   → awaiting_anything_else   ← "Before I put your plan together, anything else?"
 *   → null (complete → initial_plan fires)
 *
 * Steps are skipped automatically if data was already captured in an earlier message.
 */
export async function POST(request: Request) {
  const { userId, message, chatId }: OnboardingRequest = await request.json();

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

  // Start a typing keep-alive loop here, before any Claude calls.
  // The webhook fires typing at 0s/4.5s/9s, but handleGoal with web search
  // can take 15-18s — the indicator would expire before the reply arrives.
  // This loop keeps it alive for the full duration of the step handler.
  let keepTypingAlive = false;
  if (chatId) {
    keepTypingAlive = true;
    const typingId = chatId;
    void (async () => {
      while (keepTypingAlive) {
        await new Promise((r) => setTimeout(r, 4500));
        if (keepTypingAlive) void startTyping(typingId);
      }
    })();
  }

  // Before routing to a step handler, check if the message is off-topic.
  // Skip awaiting_goal — handleGoal already handles all cases (greetings, partial, off-topic).
  // Skip awaiting_anything_else, awaiting_name, awaiting_cadence — any response is valid for those.
  if (step && step !== "awaiting_goal" && step !== "awaiting_anything_else" && step !== "awaiting_name" && step !== "awaiting_cadence") {
    const offTopicResult = await checkOffTopic(step, message);
    if (offTopicResult.offTopic) {
      keepTypingAlive = false;
      await sendAndStore(user.id, user.phone_number, offTopicResult.response, step ?? undefined);
      return NextResponse.json({ ok: true });
    }
  }

  let result: NextResponse;
  switch (step) {
    case "awaiting_goal":
      result = await handleGoal(user, message, onboardingData, chatId);
      break;
    case "awaiting_race_date":
      result = await handleRaceDate(user, message, onboardingData);
      break;
    case "awaiting_schedule":
      result = await handleSchedule(user, message, onboardingData);
      break;
    case "awaiting_anything_else":
      result = await handleAnythingElse(user, message, onboardingData, chatId);
      break;
    case "awaiting_name":
      result = await handleName(user, message, onboardingData, chatId);
      break;
    case "awaiting_cadence":
      result = await handleCadence(user, message);
      break;
    default:
      result = NextResponse.json({ ok: true });
  }

  keepTypingAlive = false;
  return result;
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

async function handleGoal(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>,
  chatId?: string | null
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
    const { chatId: learnedChatId } = await sendAndStore(
      user.id,
      user.phone_number,
      "Hey! I'm Coach Dean — your AI endurance coach. I can build you a personalized training plan, check in after workouts, and adapt things as your fitness builds.\n\nWhat's your name, and what are you training for?",
      "awaiting_goal"
    );
    const effectiveChatId = chatId ?? learnedChatId;
    if (effectiveChatId) void shareContactCard(effectiveChatId);
    return NextResponse.json({ ok: true });
  }

  // Run in parallel: extract onboarding fields, detect immediate coaching questions,
  // and search for the specific race (if named) to acknowledge real course details + date.
  const [extra, immediateAnswer, raceInfo] = await Promise.all([
    extractAdditionalFields(message),
    detectAndAnswerImmediate(message, parsed.goal),
    generateRaceAcknowledgment(message),
  ]);
  const sportType = getSportType(parsed.goal);
  // If the web search found the race date, pre-fill it so we skip asking the user.
  const mergedData = {
    ...onboardingData,
    goal: parsed.goal,
    sport_type: sportType,
    ...extra,
    ...(raceInfo.raceDate && !extra.race_date ? { race_date: raceInfo.raceDate } : {}),
  };

  const nextStep = findNextStep("awaiting_goal", mergedData);

  const updatePayload: Record<string, unknown> = { onboarding_step: nextStep, onboarding_data: mergedData };
  if (extra.name) updatePayload.name = extra.name;
  await supabase.from("users").update(updatePayload).eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", { step: "goal", goal: parsed.goal });

  const name = extra.name as string | undefined;
  const goalLabel = formatGoalInline(parsed.goal);
  // If we found a specific named race via web search, lead with real course details.
  // Otherwise fall back to the generic goal acknowledgment.
  const acknowledgment = raceInfo.ack
    ? `Love it${name ? `, ${name}` : ""} — ${raceInfo.ack}`
    : parsed.goal === "general_fitness"
      ? `Love it${name ? `, ${name}` : ""} — building consistent fitness is a great foundation.`
      : `Love it${name ? `, ${name}` : ""} — a ${goalLabel} is a great goal.`;

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
  const { chatId: learnedChatId } = await sendAndStore(user.id, user.phone_number, responseText, "awaiting_goal");
  const effectiveChatId = chatId ?? learnedChatId;
  if (effectiveChatId) void shareContactCard(effectiveChatId);
  return NextResponse.json({ ok: true });
}

async function handleRaceDate(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const [parseResponse, extra] = await Promise.all([
    anthropic.messages.create({
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
    }),
    extractAdditionalFields(message),
  ]);

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] race_date raw response:", parseText);

  let parsed: { race_date: string | null } = { race_date: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] race_date parse failed:", e);
  }

  // Merge extra fields first, then apply the dedicated race_date parse result on top
  const mergedData = { ...onboardingData, ...removeNulls(extra), race_date: parsed.race_date };
  const nextStep = findNextStep("awaiting_race_date", mergedData);

  const updatePayload: Record<string, unknown> = { onboarding_step: nextStep, onboarding_data: mergedData };
  if (extra.name) updatePayload.name = extra.name;
  await supabase.from("users").update(updatePayload).eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", { step: "race_date", race_date: parsed.race_date });

  if (nextStep) await sendAndStore(user.id, user.phone_number, getStepQuestion(nextStep, mergedData), nextStep);
  return NextResponse.json({ ok: true });
}

async function handleSchedule(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const [parseResponse, extra, acknowledgment] = await Promise.all([
    anthropic.messages.create({
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
    }),
    extractAdditionalFields(message),
    acknowledgeSharedInfo(message),
  ]);

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] schedule raw response:", parseText);

  let parsed: {
    complete: boolean;
    days_per_week: number | null;
    training_days: string[] | null;
    follow_up: string | null;
  } = { complete: false, days_per_week: null, training_days: null, follow_up: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] schedule parse failed:", e);
  }

  if (!parsed.complete) {
    // Save any extra fields gleaned from this message even if schedule wasn't complete
    if (Object.keys(extra).length > 0) {
      const partialMerge = { ...onboardingData, ...removeNulls(extra) };
      const updatePayload: Record<string, unknown> = { onboarding_data: partialMerge };
      if (extra.name) updatePayload.name = extra.name;
      void supabase.from("users").update(updatePayload).eq("id", user.id);
    }
    const followUp =
      parsed.follow_up ||
      "Which specific days of the week work best for you?";
    const incompleteResponse = acknowledgment ? `${acknowledgment}\n\n${followUp}` : followUp;
    await sendAndStore(user.id, user.phone_number, incompleteResponse, "awaiting_schedule");
    return NextResponse.json({ ok: true });
  }

  // Infer days_per_week from training_days if not provided
  const trainingDays = parsed.training_days ?? ["tuesday", "thursday", "saturday", "sunday"];
  const daysPerWeek = parsed.days_per_week ?? trainingDays.length;

  // Merge extra fields, then apply the dedicated schedule parse results on top
  const mergedData = {
    ...onboardingData,
    ...removeNulls(extra),
    days_per_week: daysPerWeek,
    training_days: trainingDays,
  };
  const nextStep = findNextStep("awaiting_schedule", mergedData);

  const updatePayload: Record<string, unknown> = { onboarding_step: nextStep, onboarding_data: mergedData };
  if (extra.name) updatePayload.name = extra.name;
  await supabase.from("users").update(updatePayload).eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", { step: "days_per_week", days_per_week: daysPerWeek, training_days: trainingDays });

  if (nextStep) {
    const nextQuestion = getStepQuestion(nextStep, mergedData);
    const completeResponse = acknowledgment ? `${acknowledgment}\n\n${nextQuestion}` : nextQuestion;
    await sendAndStore(user.id, user.phone_number, completeResponse, nextStep);
  }
  return NextResponse.json({ ok: true });
}

async function handleAnythingElse(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>,
  chatId?: string | null
) {
  // Run extraction and acknowledgment in parallel — both are Haiku calls and
  // neither depends on the other's result.
  const [extracted, acknowledgment] = await Promise.all([
    extractAnythingElse(message),
    acknowledgeSharedInfo(message),
  ]);

  // Merge: strip nulls from extracted so pre-existing data isn't overwritten
  const merged = { ...onboardingData, ...removeNulls(extracted as unknown as Record<string, unknown>) };

  // Compute paces — prefer VDOT from race data, fall back to easy pace estimation.
  // Check both the current message extract AND earlier-captured onboarding data
  // (e.g. a PR mentioned in the first message is stored in onboardingData).
  const raceDistKm = extracted.recent_race_distance_km ?? (onboardingData.recent_race_distance_km as number | null);
  const raceTimeMin = extracted.recent_race_time_minutes ?? (onboardingData.recent_race_time_minutes as number | null);
  if (raceDistKm && raceTimeMin) {
    const paces = calculateVDOTPaces(raceDistKm, raceTimeMin);
    merged.easy_pace = paces.easy;
    merged.tempo_pace = paces.tempo;
    merged.interval_pace = paces.interval;
  } else if (extracted.easy_pace || merged.easy_pace) {
    const paces = estimatePacesFromEasyPace((extracted.easy_pace ?? merged.easy_pace) as string);
    merged.easy_pace = paces.easy;
    merged.tempo_pace = paces.tempo ?? merged.tempo_pace;
    merged.interval_pace = paces.interval ?? merged.interval_pace;
  }

  const nextStep = findNextStep("awaiting_anything_else", merged);

  void trackEvent(user.id, "onboarding_step_completed", { step: "anything_else" });

  if (!nextStep) {
    // Name was already captured in an earlier message — complete onboarding now
    if (acknowledgment) await sendAndStore(user.id, user.phone_number, acknowledgment, "awaiting_anything_else");
    await completeOnboarding(user, merged, chatId);
    return NextResponse.json({ ok: true });
  }

  // Save progress and ask the next question (typically awaiting_name)
  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: merged })
    .eq("id", user.id);

  const question = getStepQuestion(nextStep, merged);
  const responseText = acknowledgment ? `${acknowledgment}\n\n${question}` : question;
  await sendAndStore(user.id, user.phone_number, responseText, nextStep);
  return NextResponse.json({ ok: true });
}

async function handleName(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>,
  chatId?: string | null
) {
  const name = await extractName(message);
  const mergedData = name ? { ...onboardingData, name } : onboardingData;

  void trackEvent(user.id, "onboarding_step_completed", { step: "name" });
  await completeOnboarding(user, mergedData, chatId);
  return NextResponse.json({ ok: true });
}

async function handleCadence(
  user: { id: string; phone_number: string },
  message: string
) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 16,
    system: `The athlete is responding to a question about whether they want nightly workout reminders or just a weekly plan overview on Sundays.

Classify their reply. Return only one word: "nightly" or "weekly".

- "yes", "yeah", "sure", "please", "sounds good", "reminders", "nightly", "that works" → nightly
- "no", "nope", "weekly", "sunday", "just weekly", "no thanks" → weekly
- Anything ambiguous → weekly`,
    messages: [{ role: "user", content: message }],
  });

  const raw = response.content[0].type === "text" ? response.content[0].text.trim().toLowerCase() : "weekly";
  const cadence = raw.startsWith("nightly") ? "nightly_reminders" : "weekly_only";

  const confirmation =
    cadence === "nightly_reminders"
      ? "Perfect — I'll send you a heads-up the evening before each session. How does the plan look? Let me know if anything needs tweaking."
      : "Got it — I'll send you a weekly plan overview every Sunday. How does the plan look? Happy to adjust anything.";

  await Promise.all([
    supabase.from("training_profiles").update({ proactive_cadence: cadence }).eq("user_id", user.id),
    supabase.from("users").update({ onboarding_step: null }).eq("id", user.id),
    sendAndStore(user.id, user.phone_number, confirmation, "awaiting_cadence"),
  ]);

  void trackEvent(user.id, "cadence_preference_set", { cadence });
  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Onboarding completion
// ---------------------------------------------------------------------------

/**
 * Finalize onboarding: write training_profiles + training_state, mark user complete,
 * and fire the initial_plan coaching trigger. Called by handleName and by
 * handleAnythingElse when the name was already captured in an earlier message.
 */
async function completeOnboarding(
  user: { id: string },
  data: Record<string, unknown>,
  chatId?: string | null
): Promise<void> {
  const goal = (data.goal as string) || "general_fitness";
  const raceDate = (data.race_date as string) || null;
  const experienceYears = (data.experience_years as number) ?? 1;
  const weeklyMiles = (data.weekly_miles as number) ?? null;
  const weeklyHours = (data.weekly_hours as number) || null;
  const crosstrain = (data.crosstraining_tools as string[]) || [];
  const daysPerWeek = (data.days_per_week as number) ?? 4;
  const trainingDays = (data.training_days as string[]) || [];
  const easyPace = (data.easy_pace as string) || null;
  const tempoPace = (data.tempo_pace as string) || null;
  const intervalPace = (data.interval_pace as string) || null;
  const injuryNotes = (data.injury_notes as string) || null;
  const name = (data.name as string) || null;

  const fitnessLevel = assessFitnessLevel(experienceYears, weeklyMiles, weeklyHours);
  const weeklyMilesRaw = weeklyMiles ?? 15;
  const weeklyMileage =
    weeklyMilesRaw <= 0 ? 10 :
    weeklyMilesRaw <= 10 ? Math.ceil(weeklyMilesRaw) :
    Math.round(weeklyMilesRaw / 5) * 5 || 15;
  const longRun = Math.round(weeklyMileage * 0.3);

  const [profileResult, stateResult] = await Promise.all([
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
  ]);

  if (profileResult.error) {
    console.error("[onboarding] training_profiles upsert failed:", profileResult.error);
    return;
  }
  if (stateResult.error) {
    console.error("[onboarding] training_state upsert failed:", stateResult.error);
    return;
  }

  const userResult = await supabase
    .from("users")
    .update({
      name: name ?? undefined,
      onboarding_step: null,
      onboarding_data: data,
    })
    .eq("id", user.id);

  if (userResult.error) console.error("[onboarding] users update failed:", userResult.error);

  // No wrap-up SMS — the initial_plan IS the response, addressed by name.
  after(async () => {
    try {
      await trackEvent(user.id, "onboarding_completed", { goal });
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, trigger: "initial_plan", chatId: chatId ?? undefined }),
      });
    } catch (err) {
      console.error("[onboarding] coach trigger failed:", err);
    }
  });
}

// ---------------------------------------------------------------------------
// Pace calculation helpers moved to @/lib/paces
// ---------------------------------------------------------------------------

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
      // Skip if the user already shared mileage AND some fitness/pace reference —
      // that's the core of what this question is designed to capture.
      // If they've given both, asking again feels like a generic script, not a listening coach.
      return !!(data.weekly_miles || data.weekly_hours) && !!(data.recent_race_distance_km || data.easy_pace);
    case "awaiting_name":
      return typeof data.name === "string" && (data.name as string).length > 0;
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
      if (isTri) return "How many days a week are you training total? And do you have any days that work better for longer sessions?";
      if (isCycling) return "How many days a week do you want to ride? And which days work best for you?";
      return "How many days a week do you want to run, and which days work best for you?";

    case "awaiting_anything_else":
      return "Before I put your plan together — anything else worth knowing? Current weekly mileage, injuries, recent races, target paces, that sort of thing.";

    case "awaiting_name":
      return "What's your name?";

    default:
      return "";
  }
}

/**
 * Tries to extract any additional onboarding fields from a message beyond
 * what the current step is asking for. Used to pre-fill data and skip questions
 * the user already answered in passing.
 */
/**
 * Search for a specific named race and return one sentence of course facts.
 * Returns null if no specific named event is found or search fails.
 * Runs in parallel with the Haiku extraction calls in handleGoal.
 */
interface RaceInfo {
  ack: string | null;
  raceDate: string | null;
}

async function generateRaceAcknowledgment(message: string): Promise<RaceInfo> {
  const empty: RaceInfo = { ack: null, raceDate: null };
  try {
    const today = new Date().toISOString().split("T")[0];
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 300,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      system: `You help a running coach identify a specific race from an athlete's message. Today is ${today}.

If the message mentions a specific named race or event, search for it, then output a JSON object:
- "ack": ONE plain-text sentence with the verified facts: exact distance (in km and miles), total elevation gain, terrain. Start with the race name. Under 150 chars. No markdown, no asterisks.
- "date": The confirmed date of the upcoming or current-year edition as "YYYY-MM-DD", or null if not found.

Example: {"ack": "Broken Arrow 46K is a technical Sierra Nevada skyrace with 10,200ft of elevation gain.", "date": "2026-06-20"}

CRITICAL RULES:
- Do NOT narrate your search process. Output nothing until you have the final JSON answer.
- Your ENTIRE response must be that JSON object (or the word null). Never output intermediate thoughts.
- If results are ambiguous or conflicting, set "ack" to null.
- Only include "date" if you find a specific confirmed upcoming date — do not guess.
- If no specific named event is mentioned (just generic categories), return only: null`,
      messages: [{ role: "user", content: message }],
    });

    // Only take the LAST text block — intermediate blocks are Claude's between-search narration.
    const textBlocks = response.content.filter(b => b.type === "text");
    const lastBlock = textBlocks[textBlocks.length - 1];
    const text = lastBlock?.type === "text" ? lastBlock.text.trim() : "";

    if (!text || text.toLowerCase() === "null") return empty;

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      return { ack: parsed?.ack ?? null, raceDate: parsed?.date ?? null };
    } catch {
      // Fallback: treat as plain-text ack if JSON parse fails
      return { ack: text, raceDate: null };
    }
  } catch {
    return empty;
  }
}

async function extractAdditionalFields(
  message: string
): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().split("T")[0];
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `Extract any running/training information present in this message. Be generous with inference — if something is clearly implied, extract it.

Output format (omit fields that are not present):
{"race_date": "YYYY-MM-DD" | null, "experience_years": number | null, "weekly_miles": number | null, "easy_pace": "M:SS" | null, "recent_race_distance_km": number | null, "recent_race_time_minutes": number | null, "injury_mentioned": boolean, "injury_notes": string | null, "crosstraining_tools": string[] | null, "other_notes": string | null, "name": "FirstName" | null}

Rules:
- name: ONLY extract if the athlete explicitly introduces themselves — phrases like "I'm [name]", "My name is [name]", "Hi, this is [name]", "Call me [name]". NEVER extract from greetings like "Hey Dean!" or "Hi Coach!" — those address Coach Dean, not the athlete. Return null if there is any doubt.
- race_date: if a specific target race date is mentioned. Today is ${today}.
- experience_years: infer from any experience signal. "new runner" or "just started" → 0. "fairly inexperienced" → 0.2. "completed an 8 week plan" with no prior context → 0.15. "a year" → 1. "5+ years" → 5.
- weekly_miles: if weekly running volume is stated or clearly implied. Convert km to miles (×0.621).
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
    const result: Record<string, unknown> = {};
    if (parsed.race_date != null) result.race_date = parsed.race_date;
    if (parsed.experience_years != null) result.experience_years = parsed.experience_years;
    if (parsed.weekly_miles != null) result.weekly_miles = parsed.weekly_miles;
    if (parsed.easy_pace != null) result.easy_pace = parsed.easy_pace;
    if (parsed.recent_race_distance_km != null) result.recent_race_distance_km = parsed.recent_race_distance_km;
    if (parsed.recent_race_time_minutes != null) result.recent_race_time_minutes = parsed.recent_race_time_minutes;
    if (parsed.injury_mentioned === true) result.injury_mentioned = true;
    if (parsed.injury_notes != null) result.injury_notes = parsed.injury_notes;
    if (Array.isArray(parsed.crosstraining_tools) && parsed.crosstraining_tools.length > 0) result.crosstraining_tools = parsed.crosstraining_tools;
    if (parsed.other_notes != null) result.other_notes = parsed.other_notes;
    if (parsed.name != null) result.name = parsed.name;
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

/**
 * Extracts a first name (or full name) from the user's response.
 * Handles "I'm Sarah", "Sarah Thomas", "it's Sarah", etc.
 */
async function extractName(message: string): Promise<string | null> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 32,
    system: `Extract the person's name from their message. Return ONLY the name — no punctuation, no extra words. Capitalize properly (e.g. "sarah" → "Sarah", "sarah thomas" → "Sarah Thomas"). If no name is present, return the single word: null`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  console.log("[onboarding] name raw response:", text);
  if (!text || text.toLowerCase() === "null") return null;
  return text;
}

/**
 * Generates a warm, specific acknowledgment of whatever the athlete shared in response
 * to "anything else worth knowing?" — injuries, strengthening preferences, cross-training
 * goals, race history, target paces, or any other context they offered.
 * Returns null if they said nothing ("nope", "no", "I'm good", etc.).
 */
async function acknowledgeSharedInfo(message: string): Promise<string | null> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: `You are Coach Dean, a friendly endurance coach onboarding a new athlete via SMS.

The athlete just shared something during the onboarding process. If they shared anything substantive — personal context, lifestyle constraints, logistical details, cross-training, injuries, race history, goals, or anything worth acknowledging — respond with ONE short, warm, specific sentence that shows you actually heard them. Be concrete: reference what they actually said. Don't be generic.

If they said only a bare answer with nothing personal or extra (e.g. just "2 days", "Monday and Thursday", "nope", "no", "I'm good"), return only the word: null

Plain text only — no markdown, no asterisks.`,
    messages: [{ role: "user", content: message }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
  if (!text || text.toLowerCase() === "null") return null;
  return text;
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

async function sendAndStore(userId: string, phone: string, message: string, step?: string): Promise<{ chatId: string | null }> {
  const [{ chatId }] = await Promise.all([
    sendSMS(phone, message),
    supabase.from("conversations").insert({
      user_id: userId,
      role: "assistant",
      content: message,
      message_type: "coach_response",
    }),
  ]);
  // Persist chatId when we learn it from an outbound message — same pattern as coach/respond.
  // This ensures linq_chat_id is set after the first reply even if the signup sendSMS missed it.
  if (chatId) {
    void supabase.from("users").update({ linq_chat_id: chatId }).eq("id", userId).is("linq_chat_id", null);
  }
  void trackEvent(userId, "coaching_response_sent", { onboarding: true, trigger: step ?? "onboarding" });
  return { chatId };
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
