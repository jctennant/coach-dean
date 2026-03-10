import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping, shareContactCard } from "@/lib/linq";
import { trackEvent } from "@/lib/track";
import { calculateVDOTPaces, estimatePacesFromEasyPace } from "@/lib/paces";
import type { Json } from "@/lib/database.types";

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
  // Skip awaiting_anything_else, awaiting_name, awaiting_cadence, awaiting_timezone, awaiting_goal_time — any response is valid for those.
  if (step && step !== "awaiting_goal" && step !== "awaiting_anything_else" && step !== "awaiting_name" && step !== "awaiting_cadence" && step !== "awaiting_ultra_background" && step !== "awaiting_strava" && step !== "awaiting_timezone" && step !== "awaiting_goal_time") {
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
    case "awaiting_ultra_background":
      result = await handleUltraBackground(user, message, onboardingData, chatId);
      break;
    case "awaiting_anything_else":
      result = await handleAnythingElse(user, message, onboardingData, chatId);
      break;
    case "awaiting_name":
      result = await handleName(user, message, onboardingData, chatId);
      break;
    case "awaiting_goal_time":
      result = await handleGoalTime(user, message, onboardingData);
      break;
    case "awaiting_strava":
      result = await handleStrava(user, message, onboardingData);
      break;
    case "awaiting_timezone":
      result = await handleTimezone(user, message, onboardingData);
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
  // Run goal parse and field extraction in parallel so we always capture the name,
  // even on messages that don't yet contain a goal (e.g. "Yo Jake it's Ian 🙏").
  const [parseResponse, extra] = await Promise.all([
    anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 128,
      system: `Classify whether the user's message contains a clear fitness or endurance goal. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "no_event": true|false, "goal": "5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"100k"|"sprint_tri"|"olympic_tri"|"70.3"|"ironman"|"cycling"|"general_fitness"|"injury_recovery"|null}

Rules:
- complete: true only if a clear training goal is identifiable
- no_event: true if the athlete explicitly says they have no race or event planned right now ("nothing on the calendar", "no race yet", "not signed up for anything", "no events planned") — regardless of whether complete is true or false
- Pure greetings with no goal context → complete: false, no_event: false, goal: null
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
    }),
    extractAdditionalFields(message),
  ]);

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] goal raw response:", parseText);

  let parsed: { complete: boolean; no_event: boolean; goal: string | null } = { complete: false, no_event: false, goal: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] goal parse failed:", e);
  }

  if (!parsed.complete || !parsed.goal) {
    // No goal detected (pure greeting, self-intro without a goal, etc.)
    // If we extracted a name, save it and send a personalized follow-up.
    // Otherwise send the full welcome message.
    const nameFromMessage = extra.name as string | null;
    const existingName = onboardingData.name as string | null;
    const name = nameFromMessage || existingName;

    if (nameFromMessage && !existingName) {
      void supabase
        .from("users")
        .update({ name: nameFromMessage, onboarding_data: { ...onboardingData, name: nameFromMessage } })
        .eq("id", user.id);
    }

    let responseText: string;
    if (parsed.no_event) {
      // They explicitly said no race on the calendar — don't force a goal, coax a direction
      const namePrefix = name ? `No worries, ${name}` : "No worries";
      responseText = `${namePrefix} — having a direction still helps even without a date locked in. What kind of event are you drawn to — a 5K, half marathon, something longer, or more just general fitness?`;
    } else if (name) {
      // We know their name — skip the intro, just ask what they're training for
      responseText = `Hey ${name}! What are you training for — a race, general fitness, something else?`;
    } else if (!existingName && Object.keys(onboardingData).length === 0) {
      // True first contact, no data at all — send the full welcome
      responseText = "Hey! I'm Coach Dean — your AI endurance coach. I can build you a personalized training plan, check in after workouts, and adapt things as your fitness builds.\n\nWhat's your name, and what are you training for?";
    } else {
      // They've already seen the welcome but we still couldn't catch their name — ask directly
      responseText = "Sorry, didn't quite catch your name — what should I call you?";
    }

    const { chatId: learnedChatId } = await sendAndStore(user.id, user.phone_number, responseText, "awaiting_goal");
    const effectiveChatId = chatId ?? learnedChatId;
    if (effectiveChatId) void shareContactCard(effectiveChatId);
    return NextResponse.json({ ok: true });
  }

  // Goal detected — run remaining parallel enrichment calls.
  const [immediateAnswer, raceInfo] = await Promise.all([
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

  // Build a personalized acknowledgment that reflects the athlete's specific situation
  // and explains concretely what Dean will do for them.
  let acknowledgment: string;
  if (raceInfo.ack) {
    // Specific named race found — lead with real course facts
    const whatDeanDoes = "I'll build your week-by-week plan, track your training via Strava, and check in after your key sessions.";
    acknowledgment = `Love it${name ? `, ${name}` : ""} — ${raceInfo.ack} ${whatDeanDoes}`;
  } else if (parsed.goal === "injury_recovery") {
    acknowledgment = `Got it${name ? `, ${name}` : ""} — coming back from injury safely is exactly what I'm here for. I'll build a return-to-run plan around your recovery, not a generic training schedule.`;
  } else if (parsed.goal === "general_fitness") {
    acknowledgment = `Love it${name ? `, ${name}` : ""} — building a consistent habit is a great foundation. I'll put together a plan that builds properly and adapts to your schedule.`;
  } else {
    // Race goal — vary the "what Dean does" slightly based on whether they seem newer or experienced
    const isNewer = (extra.experience_years as number | null) != null && (extra.experience_years as number) < 1;
    const whatDeanDoes = isNewer
      ? `I'll keep the plan manageable and build up at a pace that gets you to the start line healthy.`
      : `I'll put together a tailored plan, track your training via Strava, and adjust things as your fitness builds.`;
    acknowledgment = `Love it${name ? `, ${name}` : ""} — a ${goalLabel} is a great goal. ${whatDeanDoes}`;
  }

  const question = nextStep ? getStepQuestion(nextStep, mergedData, user.id) : "";

  let responseText: string;
  if (immediateAnswer) {
    // Bridge from the coaching answer back to the onboarding flow naturally
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

  if (nextStep) await sendAndStore(user.id, user.phone_number, getStepQuestion(nextStep, mergedData, user.id), nextStep);
  return NextResponse.json({ ok: true });
}

/**
 * awaiting_goal_time: ask if athlete has a specific finish time goal.
 * Parses time expressions like "sub-2", "1:55", "under 4:30", or "just want to finish".
 * Stores goal_time_minutes (number or null) and advances.
 */
async function handleGoalTime(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    system: `Extract a race finish time goal from this message. Convert to total minutes.
Examples: "sub-2 hours" → 120, "1:55" → 115, "under 4:30" → 270, "around 2:15" → 135, "23 minutes" → 23.
If no specific time goal (e.g. "just finish", "no goal", "build fitness", "not sure") → null.
Return ONLY valid JSON: {"goal_time_minutes": number | null}`,
    messages: [{ role: "user", content: message }],
  });

  let goalTimeMinutes: number | null = null;
  try {
    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    goalTimeMinutes = typeof parsed.goal_time_minutes === "number" ? parsed.goal_time_minutes : null;
  } catch {
    // Parsing failed — treat as no goal
  }

  const mergedData = { ...onboardingData, goal_time_minutes: goalTimeMinutes };
  const nextStep = findNextStep("awaiting_goal_time", mergedData);

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: mergedData as unknown as Json })
    .eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", { step: "goal_time", has_time_goal: goalTimeMinutes !== null });

  if (nextStep) {
    const question = getStepQuestion(nextStep, mergedData, user.id);
    await sendAndStore(user.id, user.phone_number, question, nextStep);
  } else {
    await completeOnboarding(user, mergedData);
  }

  return NextResponse.json({ ok: true });
}

/**
 * awaiting_strava: user replied while waiting for them to click the Strava link.
 * Any SMS reply here means they're skipping Strava — advance to the next step.
 */
async function handleStrava(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const isSkip = /skip|no strava|don.?t have|no thanks|nope|later|next/i.test(message);

  const mergedData = { ...onboardingData, strava_skipped: true };
  const nextStep = findNextStep("awaiting_strava", mergedData);

  const updatePayload: Record<string, unknown> = {
    onboarding_step: nextStep,
    onboarding_data: mergedData as unknown as Json,
  };
  await supabase.from("users").update(updatePayload).eq("id", user.id);

  void trackEvent(user.id, "onboarding_strava_skipped", { message_hint: isSkip ? "explicit" : "implicit" });

  if (nextStep) {
    const reply = isSkip
      ? `No worries! ${getStepQuestion(nextStep, mergedData, user.id)}`
      : `Got it — ${getStepQuestion(nextStep, mergedData, user.id)}`;
    await sendAndStore(user.id, user.phone_number, reply, nextStep);
  } else {
    // All remaining steps already satisfied — go straight to plan generation
    await completeOnboarding(user, mergedData);
  }
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
    const nextQuestion = getStepQuestion(nextStep, mergedData, user.id);
    const completeResponse = acknowledgment ? `${acknowledgment}\n\n${nextQuestion}` : nextQuestion;
    await sendAndStore(user.id, user.phone_number, completeResponse, nextStep);
  }
  return NextResponse.json({ ok: true });
}

async function handleUltraBackground(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>,
  chatId?: string | null
) {
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
  let extracted: {
    has_ultra_experience?: boolean;
    ultra_race_history?: string | null;
    weekly_miles?: number | null;
    current_long_run_miles?: number | null;
    experience_years?: number | null;
  } = {};
  try {
    extracted = JSON.parse(extractJSON(text));
  } catch {
    extracted = {};
  }

  const merged: Record<string, unknown> = { ...onboardingData };
  if (extracted.ultra_race_history) merged.ultra_race_history = extracted.ultra_race_history;
  if (extracted.weekly_miles != null) merged.weekly_miles = extracted.weekly_miles;
  if (extracted.current_long_run_miles != null) merged.current_long_run_miles = extracted.current_long_run_miles;
  if (extracted.experience_years != null) merged.experience_years = extracted.experience_years;
  // Append to other_notes so it surfaces in the coach system prompt
  if (extracted.ultra_race_history) {
    const existing = (onboardingData.other_notes as string) || "";
    merged.other_notes = existing ? `${existing}; ${extracted.ultra_race_history}` : extracted.ultra_race_history;
  }

  const nextStep = findNextStep("awaiting_ultra_background", merged);
  await supabase.from("users").update({ onboarding_step: nextStep, onboarding_data: merged as unknown as Json }).eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", { step: "ultra_background", has_ultra_experience: extracted.has_ultra_experience });

  if (nextStep) {
    const question = getStepQuestion(nextStep, merged, user.id);
    await sendAndStore(user.id, user.phone_number, question, nextStep);
  } else {
    await completeOnboarding(user, merged, chatId);
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
    // Name was already captured in an earlier message — complete onboarding now.
    // Do NOT send the acknowledgment here — the initial_plan message opens with
    // a natural reference to what was just shared, so a separate "Got it" first
    // produces an awkward double-acknowledgment.
    await completeOnboarding(user, merged, chatId);
    return NextResponse.json({ ok: true });
  }

  // Save progress and ask the next question (typically awaiting_name)
  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: merged as unknown as Json })
    .eq("id", user.id);

  const question = getStepQuestion(nextStep, merged, user.id);
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

async function parseTimezoneFromMessage(message: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    system: `Convert the location in this message to an IANA timezone string. Return ONLY the IANA string (e.g. "America/Denver", "America/Los_Angeles", "America/New_York", "America/Chicago"). If unclear or unrecognized, return "America/New_York".`,
    messages: [{ role: "user", content: message }],
  });
  const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "America/New_York";
  // Validate it looks like a plausible IANA timezone string
  return /^[A-Za-z_]+\/[A-Za-z_]+$/.test(raw) ? raw : "America/New_York";
}

async function handleTimezone(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const stravaCity = onboardingData.strava_city as string | null;
  const stravaConnected = !!(onboardingData.strava_connected);

  let newTimezone: string | null = null;

  if (stravaConnected && stravaCity) {
    // We asked them to confirm their Strava location — detect yes/no
    const isConfirmation = /\b(yes|yeah|yep|yup|correct|right|accurate|still|good|great|confirmed|that'?s right)\b/i.test(message);
    if (!isConfirmation) {
      // They corrected it — parse the new location
      newTimezone = await parseTimezoneFromMessage(message);
    }
    // If confirmed, keep the existing timezone already set from Strava
  } else {
    // No Strava city — parse whatever city/location they gave us
    newTimezone = await parseTimezoneFromMessage(message);
  }

  const mergedData = { ...onboardingData, timezone_confirmed: true };
  const nextStep = findNextStep("awaiting_timezone", mergedData);

  const updatePayload: Record<string, unknown> = {
    onboarding_data: mergedData as unknown as Json,
    onboarding_step: nextStep,
  };
  if (newTimezone) updatePayload.timezone = newTimezone;

  await supabase.from("users").update(updatePayload).eq("id", user.id);
  void trackEvent(user.id, "onboarding_step_completed", { step: "timezone" });

  if (nextStep) {
    const question = getStepQuestion(nextStep, mergedData, user.id);
    await sendAndStore(user.id, user.phone_number, question, nextStep);
  } else {
    await completeOnboarding(user, mergedData);
  }

  return NextResponse.json({ ok: true });
}

async function handleCadence(
  user: { id: string; phone_number: string; name: string | null },
  message: string
) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 16,
    system: `The athlete is responding to a question offering three reminder options: morning-of reminders, evening-before reminders, or a weekly Sunday overview only.

Classify their reply. Return only one word: "morning", "nightly", "weekly", or "unclear".

- "morning", "day of", "day-of", "morning of", "same day", "that morning", "am", "wake up", "start of day", any specific morning time like "8am", "7am" → morning
- "evening", "night before", "nightly", "night of", "the night before", "yes", "yeah", "sure", "please", "sounds good", "reminders", "that works" → nightly
- "weekly", "sunday", "just weekly", "no", "nope", "no thanks", "just the overview" → weekly
- Anything that isn't clearly answering the reminder question (e.g. sharing an injury, asking a question, talking about something else) → unclear`,
    messages: [{ role: "user", content: message }],
  });

  const raw = response.content[0].type === "text" ? response.content[0].text.trim().toLowerCase() : "nightly";

  // If the message wasn't actually answering the cadence question, save it as
  // a note on their profile and re-ask.
  if (raw.startsWith("unclear")) {
    await Promise.all([
      supabase
        .from("training_profiles")
        .update({ injury_notes: message, updated_at: new Date().toISOString() })
        .eq("user_id", user.id),
      sendAndStore(
        user.id,
        user.phone_number,
        "Noted — I'll keep that in mind when putting your plan together. One quick question before I do: would you prefer reminders the morning of your sessions, the evening before, or just a weekly Sunday overview?",
        "awaiting_cadence"
      ),
    ]);
    return NextResponse.json({ ok: true });
  }

  const cadence = raw.startsWith("morning")
    ? "morning_reminders"
    : raw.startsWith("nightly")
      ? "nightly_reminders"
      : "weekly_only";

  const confirmation =
    cadence === "morning_reminders"
      ? "Perfect — I'll text you the morning of each session. How does the plan look? Let me know if anything needs tweaking."
      : cadence === "nightly_reminders"
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

  const isUltra = ULTRA_GOALS.includes(goal);
  const fitnessLevel = assessFitnessLevel(experienceYears, weeklyMiles, weeklyHours, goal, daysPerWeek);
  const weeklyMilesRaw = weeklyMiles ?? (isUltra ? 30 : 15);
  const weeklyMileage =
    weeklyMilesRaw <= 0 ? 10 :
    weeklyMilesRaw <= 10 ? Math.ceil(weeklyMilesRaw) :
    Math.round(weeklyMilesRaw / 5) * 5 || 15;
  // Use stated current long run if available (ultra background step captures this),
  // otherwise fall back to 30% of weekly mileage with a 10mi floor for ultras.
  const currentLongRunMiles = (data.current_long_run_miles as number) ?? null;
  const longRunRaw = Math.round(weeklyMileage * 0.3);
  const longRun = currentLongRunMiles ?? (isUltra ? Math.max(longRunRaw, 10) : longRunRaw);

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
      onboarding_data: data as unknown as Json,
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
  if (goal === "general_fitness" || goal === "injury_recovery") return "general";
  return "running";
}

/**
 * Ordered list of onboarding steps after awaiting_goal.
 * findNextStep walks this list and returns the first unsatisfied step.
 */
const STEP_ORDER = [
  "awaiting_race_date",
  "awaiting_goal_time",         // only shown for race goals (not general fitness or ultras)
  "awaiting_strava",            // offer Strava connect; satisfied once strava_connected=true or user skips
  "awaiting_schedule",
  "awaiting_ultra_background",  // only shown for 50K+ goals
  "awaiting_timezone",          // confirm/set timezone for accurate reminder timing
  "awaiting_anything_else",
];

/**
 * Returns true if the data collected so far already satisfies this step,
 * meaning we can skip asking about it.
 */
function isStepSatisfied(step: string, data: Record<string, unknown>): boolean {
  switch (step) {
    case "awaiting_race_date":
      // Skip entirely for injury recovery — no race date needed
      if (data.goal === "injury_recovery") return true;
      // Satisfied if race_date key exists (even null = "no race")
      return Object.prototype.hasOwnProperty.call(data, "race_date");
    case "awaiting_goal_time":
      // Skip for general fitness, injury recovery, and ultras (cutoffs matter more than finish times)
      if (data.goal === "general_fitness" || data.goal === "injury_recovery" || ULTRA_GOALS.includes(data.goal as string)) return true;
      // Satisfied once goal_time_minutes key exists (even null = "no specific goal")
      return Object.prototype.hasOwnProperty.call(data, "goal_time_minutes");
    case "awaiting_strava":
      // Satisfied once the user has connected Strava OR explicitly skipped
      return !!(data.strava_connected || data.strava_skipped);
    case "awaiting_schedule":
      return Array.isArray(data.training_days) && (data.training_days as string[]).length > 0;
    case "awaiting_ultra_background":
      // Only relevant for ultra goals — skip entirely for everything else.
      if (!ULTRA_GOALS.includes(data.goal as string)) return true;
      // Satisfied if we already have both weekly mileage and some race/experience context.
      return !!(data.weekly_miles) && !!(data.ultra_race_history || data.experience_years != null);
    case "awaiting_timezone":
      // Auto-satisfy if Strava is connected but no city available to confirm
      // (timezone already set from Strava athlete profile, nothing meaningful to ask).
      if (data.strava_connected && !data.strava_city) return true;
      return !!(data.timezone_confirmed);
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
function getStepQuestion(step: string, data: Record<string, unknown>, userId?: string): string {
  const sport = (data.sport_type as string) || "running";
  const isTri = sport === "triathlon";
  const isCycling = sport === "cycling";

  switch (step) {
    case "awaiting_goal_time":
      return `Do you have a time goal for the race, or is it more about finishing strong and building your base? Either's totally valid — just helps me dial in the right pacing.`;

    case "awaiting_strava": {
      const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${userId || ""}`;
      return `Before I put your plan together — do you use Strava? If you connect it, I can pull in your training history and build something much sharper from day 1.\n\n${stravaUrl}\n\nNo Strava? Just reply "skip".`;
    }

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

    case "awaiting_timezone": {
      if (data.strava_connected && data.strava_city) {
        const location = data.strava_state
          ? `${data.strava_city}, ${data.strava_state}`
          : (data.strava_city as string);
        return `Based on your Strava, looks like you're in ${location} — is that still accurate? Just want to make sure your reminders go out at the right time.`;
      }
      return "One quick one — what city are you in? Want to make sure your reminders go out at the right time, not 3am.";
    }

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
- weekly_miles: total weekly running mileage. If stated as a per-day or per-weekday average (e.g. "I average 5-6 miles a day", "5-6 miles weekdays"), multiply by the number of days implied (weekdays = 5, "every day" = 7) to get a weekly total. Convert km × 0.621.
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

const ULTRA_GOALS = ["50k", "100k", "30k"];

function assessFitnessLevel(experienceYears: number, weeklyMiles: number | null, weeklyHours: number | null, goal?: string, daysPerWeek?: number): string {
  // Use hours as primary signal for multi-sport athletes
  if (weeklyHours != null) {
    if (weeklyHours >= 10 || experienceYears >= 3) return "advanced";
    if (weeklyHours >= 5 || experienceYears >= 1) return "intermediate";
    return "beginner";
  }
  const miles = weeklyMiles ?? 0;
  // Anyone training for an ultra running 5+ days/week is at minimum intermediate,
  // almost certainly advanced — don't let missing experience data drag them to beginner.
  if (goal && ULTRA_GOALS.includes(goal) && (daysPerWeek ?? 0) >= 5) return "advanced";
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
    injury_recovery: "injury recovery",
  };
  return labels[goal] || goal;
}
