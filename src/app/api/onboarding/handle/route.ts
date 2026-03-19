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
 *   → awaiting_ultra_background   ← only for 50K+ goals
 *   → awaiting_injury_background  ← only for injury_recovery goals
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
  if (step && step !== "awaiting_goal" && step !== "awaiting_anything_else" && step !== "awaiting_name" && step !== "awaiting_strava") {
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
    case "awaiting_injury_background":
      result = await handleInjuryBackground(user, message, onboardingData, chatId);
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
    case "awaiting_mileage_baseline":
      result = await handleMileageBaseline(user, message, onboardingData);
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
  user: { id: string; phone_number: string; name?: string | null },
  message: string,
  onboardingData: Record<string, unknown>,
  chatId?: string | null
) {
  // Run goal parse and field extraction in parallel so we always capture the name,
  // even on messages that don't yet contain a goal (e.g. "Yo Jake it's Ian 🙏").
  const [parseResponse, extra] = await Promise.all([
    anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 256,
      system: `Classify whether the user's message contains a clear fitness or endurance goal. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "no_event": true|false, "goal": "5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"50mi"|"100k"|"100mi"|"sprint_tri"|"olympic_tri"|"70.3"|"ironman"|"cycling"|"general_fitness"|"return_to_running"|"injury_recovery"|null, "race_name": string|null, "goal_distance_miles": number|null}

race_name rules:
- Set race_name when the athlete mentions a specific named event OR a non-standard distance. Examples:
  - "25K Marin Headlands Trail Race" → goal: "30k", race_name: "25K Marin Headlands Trail Race"
  - "9-mile Dipsea" → goal: "10k", race_name: "9-mile Dipsea"
  - "Western States 100" → goal: "100mi", race_name: "Western States 100"
  - "Signed up for Western States — 100 miles" → goal: "100mi", race_name: "Western States"
  - "Golden Gate 100K" → goal: "100k", race_name: "Golden Gate 100K"
  - "Boston Marathon" → goal: "marathon", race_name: "Boston Marathon" (specific named event)
  - "a marathon in April" → goal: "marathon", race_name: null (no specific race name, just a distance)
  - "half marathon in April" → goal: "half_marathon", race_name: null (no specific name)
- When goal is general_fitness, return_to_running, or injury_recovery → race_name: null

goal_distance_miles rules:
- When the athlete mentions a non-standard distance, output the exact distance in miles. Examples:
  - "25K Marin Headlands" → goal_distance_miles: 15.53
  - "9-mile Dipsea" → goal_distance_miles: 9.0
  - "80K ultra" → goal_distance_miles: 49.71
  - "15-mile trail race" → goal_distance_miles: 15.0
- For standard goal types (5K, 10K, half marathon, marathon, 30K, 50K, 50 miles, 100K, 100 miles) where no non-standard distance is mentioned → goal_distance_miles: null (system fills this in)
- For general_fitness, return_to_running, injury_recovery, triathlon types, cycling → goal_distance_miles: null

Rules:
- complete: true only if a clear training goal is identifiable
- no_event: true if the athlete explicitly says they have no race or event planned right now ("nothing on the calendar", "no race yet", "not signed up for anything", "no events planned") — regardless of whether complete is true or false
- Pure greetings with no goal context → complete: false, no_event: false, goal: null
- Named specific race or event (e.g. "Behind the Rocks trail race", "Wasatch 100", "Boston Marathon", "local 5K next spring") → complete: true. Use any explicit distance cues in the message: "Wasatch 100" → "100k"; "Boston Marathon" → "marathon"; "local half" → "half_marathon". If the name contains no distance info (e.g. just "Behind the Rocks trail race"), use "50k" as a placeholder — the web search step will clarify if needed.
- "half marathon" or "half" → "half_marathon"
- "full marathon" or "marathon" → "marathon"
- "50 miles", "50-mile", "50-miler", "50mi", "fifty miles", "50 mile ultra" → "50mi" (NOT "50k" — these are very different races)
- "100 miles", "100-mile", "100-miler", "100mi", "hundred miles", "100 mile ultra", "Western States", "Leadville", "UTMB" → "100mi"
- "ultra" without distance → "50k"
- Non-standard distances — map to nearest standard bucket:
  - Under ~12K (less than 8 miles) → "10k"
  - 13K to ~42K (between a half marathon and marathon distance) → "30k"
  - 13K to 19K is closest to half marathon in spirit; still use "30k" as the bucket
  - 60K, 70K, 80K, any race between 50K and 100K → "100k"
  - 15 miles, 20 miles, any race between marathon (26.2mi) and 50 miles → "50mi"
  - 60 miles, 75 miles, any race between 50 miles and 100 miles → "100mi"
  - If unsure of the correct bucket, output null (do NOT guess "50k" for races that are clearly shorter)
- "triathlon" or "tri" without a distance → "olympic_tri"
- "sprint tri" or "sprint triathlon" → "sprint_tri"
- "70.3", "half ironman", "half-ironman" → "70.3"
- "ironman", "full ironman", "140.6" → "ironman"
- "cycling", "gravel race", "gran fondo", "bike race" → "cycling"
- "just getting in shape", "get fit", "lose weight", "general" → "general_fitness"
- "ran in college/high school and returning", "returning to running after X years off", "getting back into running", "haven't run in years", "rebuilding my base" (without injury context) → "return_to_running"
- "recovering from injury", "coming back from injury", "injured", "IT band", "stress fracture", "shin splints", "rebuilding after injury" → "injury_recovery"
- When complete is false, goal must be null`,
      messages: [{ role: "user", content: message }],
    }),
    extractAdditionalFields(message),
  ]);

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] goal raw response:", parseText);

  let parsed: { complete: boolean; no_event: boolean; goal: string | null; race_name?: string | null; goal_distance_miles?: number | null } = { complete: false, no_event: false, goal: null };
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
    // Bug fix: also fall back to user.name (may be set from signup form or prior partial test)
    const existingName = (onboardingData.name as string | null) ?? (user.name ?? null);
    const name = nameFromMessage || existingName;

    if (nameFromMessage && !existingName) {
      await supabase
        .from("users")
        .update({ name: nameFromMessage, onboarding_data: { ...onboardingData, name: nameFromMessage } })
        .eq("id", user.id);
    }

    // Detect if the user asked a question we should answer before asking ours
    let questionAnswer: string | null = null;
    if (message.includes("?")) {
      questionAnswer = await detectAndAnswerImmediate(message, "general fitness");
    }

    // intro_sent flag is set by the signup API. If not present, this is a first-contact
    // path where the welcome hasn't been sent yet (e.g., texting directly).
    const introAlreadySent = !!onboardingData.intro_sent;

    let responseText: string;
    if (parsed.no_event) {
      // They explicitly said no race on the calendar — don't force a goal, coax a direction
      const namePrefix = name ? `No worries, ${name}` : "No worries";
      responseText = `${namePrefix} — having a direction still helps even without a date locked in. What kind of event are you drawn to — a 5K, half marathon, something longer, or more just general fitness?`;
    } else if (!introAlreadySent) {
      // Intro not yet sent — include it now, personalized with name if known
      responseText = name
        ? `Hey ${name}! I'm Coach Dean — your AI endurance coach. I can build you a personalized training plan, check in after workouts, and adapt things as your fitness builds.\n\nWhat are you training for?`
        : `Hey! I'm Coach Dean — your AI endurance coach. I can build you a personalized training plan, check in after workouts, and adapt things as your fitness builds.\n\nWhat's your name, and what are you training for?`;
    } else if (name) {
      // Intro already sent, name known — just ask the question
      responseText = `Hey ${name}! What are you training for — a race, general fitness, something else?`;
    } else {
      // They've already seen the welcome but we still couldn't catch their name — ask directly
      responseText = "Sorry, didn't quite catch your name — what should I call you?";
    }

    // Prepend any immediate question answer (Bug 1 fix)
    if (questionAnswer) {
      responseText = `${questionAnswer}\n\n${responseText}`;
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

  // Multi-distance race: web search found several options and athlete didn't specify which.
  // Ask for clarification and stay on awaiting_goal so the next message can resolve it.
  if (raceInfo.distanceOptions && raceInfo.distanceOptions.length > 1) {
    const namePrefix = (extra.name as string | null) ? `${extra.name as string}, ` : "";
    const options = raceInfo.distanceOptions.join(", ");
    const ackPart = raceInfo.ack ? `${raceInfo.ack}\n\n` : "";
    const clarificationMsg = `${ackPart}${namePrefix}which distance are you targeting — ${options}?`;
    await sendAndStore(user.id, user.phone_number, clarificationMsg, "awaiting_goal");
    return NextResponse.json({ ok: true });
  }

  const sportType = getSportType(parsed.goal);
  // Pre-fill race_date if:
  // - web search found a specific date, or
  // - athlete explicitly said no event (no_event=true) → null satisfies awaiting_race_date and skips the question
  const mergedData = {
    ...onboardingData,
    goal: parsed.goal,
    sport_type: sportType,
    ...extra,
    ...(raceInfo.raceDate && !extra.race_date ? { race_date: raceInfo.raceDate } : {}),
    ...(parsed.no_event && !extra.race_date && !raceInfo.raceDate ? { race_date: null } : {}),
    ...(raceInfo.secondaryGoal || extra.secondary_goal
      ? { secondary_goal: raceInfo.secondaryGoal ?? extra.secondary_goal }
      : {}),
    // Store the specific race name / non-standard distance when it differs from the goal bucket.
    // This lets the coaching system display "25K Marin Headlands" instead of just "30K trail race".
    ...(parsed.race_name ? { race_name: parsed.race_name } : {}),
    // Store exact distance in miles when classifier extracted a non-standard value.
    // completeOnboarding will fall back to the bucket standard if this is null.
    ...(parsed.goal_distance_miles != null ? { goal_distance_miles: parsed.goal_distance_miles } : {}),
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
    // Specific named race found — use the conversational acknowledgment directly.
    // The generated text already handles tone; no scripted prefix needed.
    acknowledgment = raceInfo.ack;
  } else if (parsed.goal === "injury_recovery") {
    acknowledgment = `Got it${name ? `, ${name}` : ""} — coming back from injury safely is exactly what I'm here for. I'll build a return-to-run plan around your recovery, not a generic training schedule.`;
  } else if (parsed.goal === "return_to_running") {
    acknowledgment = `Perfect${name ? `, ${name}` : ""} — getting back into it after a break is a unique challenge. I'll build something that respects where you are now while taking advantage of your fitness base. We'll ramp carefully so you don't get hurt coming back.`;
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
        : (parsed.goal === "general_fitness" || parsed.goal === "return_to_running")
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
  const [parseResponse, extra, acknowledgment] = await Promise.all([
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
    acknowledgeSharedInfo(message),
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

  if (nextStep) {
    const nextQuestion = getStepQuestion(nextStep, mergedData, user.id);
    const reply = acknowledgment ? `${acknowledgment}\n\n${nextQuestion}` : nextQuestion;
    await sendAndStore(user.id, user.phone_number, reply, nextStep);
  }
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
  const [response, acknowledgment] = await Promise.all([
    anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      system: `Extract a race finish time goal from this message. Convert to total minutes.
Examples: "sub-2 hours" → 120, "1:55" → 115, "under 4:30" → 270, "around 2:15" → 135, "23 minutes" → 23.
If no specific time goal (e.g. "just finish", "no goal", "build fitness", "not sure") → null.
Return ONLY valid JSON: {"goal_time_minutes": number | null}`,
      messages: [{ role: "user", content: message }],
    }),
    acknowledgeSharedInfo(message),
  ]);

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
    const nextQuestion = getStepQuestion(nextStep, mergedData, user.id);
    const reply = acknowledgment ? `${acknowledgment}\n\n${nextQuestion}` : nextQuestion;
    await sendAndStore(user.id, user.phone_number, reply, nextStep);
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
    const [nextQuestion, acknowledgment] = await Promise.all([
      Promise.resolve(getStepQuestion(nextStep, mergedData, user.id)),
      acknowledgeSharedInfo(message),
    ]);
    // Use a warm acknowledgment if the user said something substantive,
    // otherwise fall back to a simple "No worries" / "Got it" prefix.
    const reply = acknowledgment
      ? `${acknowledgment}\n\n${nextQuestion}`
      : isSkip
        ? `No worries! ${nextQuestion}`
        : `Got it — ${nextQuestion}`;
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
  const [parseResponse, extra] = await Promise.all([
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
    const acknowledgment = await acknowledgeSharedInfo(message);
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
    // Use a schedule-specific acknowledgment that always references the confirmed days
    // and naturally handles any flexibility caveats the user mentioned.
    const [scheduleAck, nextQuestion] = await Promise.all([
      acknowledgeSchedule(message, trainingDays),
      Promise.resolve(getStepQuestion(nextStep, mergedData, user.id)),
    ]);
    const completeResponse = `${scheduleAck}\n\n${nextQuestion}`;
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
  const [parseResponse, acknowledgment] = await Promise.all([
    anthropic.messages.create({
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
    }),
    acknowledgeSharedInfo(message),
  ]);

  const text = parseResponse.content[0].type === "text" ? parseResponse.content[0].text.trim() : "{}";
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
    const nextQuestion = getStepQuestion(nextStep, merged, user.id);
    const reply = acknowledgment ? `${acknowledgment}\n\n${nextQuestion}` : nextQuestion;
    await sendAndStore(user.id, user.phone_number, reply, nextStep);
  } else {
    await completeOnboarding(user, merged, chatId);
  }

  return NextResponse.json({ ok: true });
}

async function handleInjuryBackground(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>,
  chatId?: string | null
) {
  const [parseResponse, acknowledgment] = await Promise.all([
    anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `Extract injury and return-to-run context from this message. Respond with ONLY valid JSON.

Output format:
{
  "injury_notes": string | null,
  "weekly_miles": number | null,
  "can_run_now": boolean | null
}

Rules:
- injury_notes: brief description of injury type, duration, and recovery status (e.g. "stress fracture, 6 weeks ago, cleared to walk but not run yet"). null if unclear.
- weekly_miles: current weekly mileage if mentioned. null if not stated.
- can_run_now: true if they say they can run, false if fully off running, null if unclear.`,
      messages: [{ role: "user", content: message }],
    }),
    acknowledgeSharedInfo(message),
  ]);

  const text = parseResponse.content[0].type === "text" ? parseResponse.content[0].text.trim() : "{}";
  let extracted: {
    injury_notes?: string | null;
    weekly_miles?: number | null;
    can_run_now?: boolean | null;
  } = {};
  try {
    extracted = JSON.parse(extractJSON(text));
  } catch {
    extracted = {};
  }

  const merged: Record<string, unknown> = { ...onboardingData };
  if (extracted.injury_notes) merged.injury_notes = extracted.injury_notes;
  if (extracted.weekly_miles != null) merged.weekly_miles = extracted.weekly_miles;
  if (extracted.can_run_now != null) merged.can_run_now = extracted.can_run_now;

  const nextStep = findNextStep("awaiting_injury_background", merged);
  await supabase.from("users").update({ onboarding_step: nextStep, onboarding_data: merged as unknown as Json }).eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", { step: "injury_background", can_run_now: extracted.can_run_now });

  if (nextStep) {
    const nextQuestion = getStepQuestion(nextStep, merged, user.id);
    const reply = acknowledgment ? `${acknowledgment}\n\n${nextQuestion}` : nextQuestion;
    await sendAndStore(user.id, user.phone_number, reply, nextStep);
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
  // Run extraction and conversational response in parallel.
  // extractAnythingElse captures training data even from question messages.
  // generateAnythingElseResponse decides whether we're done or need to respond + re-ask.
  const [extracted, conversational] = await Promise.all([
    extractAnythingElse(message),
    generateAnythingElseResponse(message, onboardingData),
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

  // If the athlete asked a question or shared something that needs a reply,
  // respond naturally and stay on this step so they can say "that's all" next.
  if (!conversational.isDone && conversational.response) {
    // Still save any training data extracted from this message
    void supabase
      .from("users")
      .update({ onboarding_data: merged as unknown as Json })
      .eq("id", user.id);
    await sendAndStore(user.id, user.phone_number, conversational.response, "awaiting_anything_else");
    return NextResponse.json({ ok: true });
  }

  const nextStep = findNextStep("awaiting_anything_else", merged);

  void trackEvent(user.id, "onboarding_step_completed", { step: "anything_else" });

  if (!nextStep) {
    // Athlete is done — complete onboarding.
    // Don't send an extra ack here; the initial_plan message opens with natural
    // context so a separate "Got it" would produce an awkward double-acknowledgment.
    await completeOnboarding(user, merged, chatId);
    return NextResponse.json({ ok: true });
  }

  // Save progress and ask the next question (typically awaiting_name)
  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: merged as unknown as Json })
    .eq("id", user.id);

  const question = getStepQuestion(nextStep, merged, user.id);
  await sendAndStore(user.id, user.phone_number, question, nextStep);
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

/**
 * awaiting_mileage_baseline: ask non-Strava users for their current weekly mileage
 * so the initial plan is calibrated to their actual fitness, not a beginner default.
 */
async function handleMileageBaseline(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  // Extract weekly mileage from their answer
  let weeklyMiles: number | null = null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      system: `Extract weekly running mileage from this message. Return ONLY: {"weekly_miles": number | null}. Convert km × 0.621. If a range is given (e.g. "30-35"), use the midpoint. Today: ${today}.`,
      messages: [{ role: "user", content: message }],
    });
    const text = resp.content[0].type === "text" ? resp.content[0].text.trim() : "{}";
    const parsed = JSON.parse(extractJSON(text));
    weeklyMiles = typeof parsed.weekly_miles === "number" ? parsed.weekly_miles : null;
  } catch {
    // best-effort — null means completeOnboarding falls back to 15mi default
  }

  const merged: Record<string, unknown> = { ...onboardingData };
  if (weeklyMiles != null) merged.weekly_miles = weeklyMiles;

  const nextStep = findNextStep("awaiting_mileage_baseline", merged);

  void trackEvent(user.id, "onboarding_step_completed", { step: "mileage_baseline", weekly_miles: weeklyMiles });

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: merged as unknown as Json })
    .eq("id", user.id);

  if (nextStep) {
    const ack = weeklyMiles != null
      ? `Got it — ${Math.round(weeklyMiles)} miles a week.`
      : "Got it.";
    const nextQuestion = getStepQuestion(nextStep, merged, user.id);
    await sendAndStore(user.id, user.phone_number, `${ack}\n\n${nextQuestion}`, nextStep);
  } else {
    await completeOnboarding(user, merged, null);
  }

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
    const [nextQuestion, acknowledgment] = await Promise.all([
      Promise.resolve(getStepQuestion(nextStep, mergedData, user.id)),
      acknowledgeSharedInfo(message),
    ]);
    const reply = acknowledgment ? `${acknowledgment}\n\n${nextQuestion}` : nextQuestion;
    await sendAndStore(user.id, user.phone_number, reply, nextStep);
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

  // If the message wasn't actually answering the cadence question, re-ask naturally.
  // (checkOffTopic handles most off-topic cases before we get here; this is a
  // safety net for ambiguous messages that slipped through.)
  if (raw.startsWith("unclear")) {
    await sendAndStore(
      user.id,
      user.phone_number,
      "Just one last thing before your plan: would you prefer reminders the morning of each session, the evening before, or just a weekly Sunday overview?",
      "awaiting_cadence"
    );
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

  // Exact race distance: prefer classifier-extracted value (non-standard distances),
  // fall back to the canonical bucket distance for standard goals.
  const runGoalDistancesMilesStandard: Record<string, number> = {
    "5k": 3.107, "10k": 6.214, "half_marathon": 13.109, "marathon": 26.219,
    "30k": 18.641, "50k": 31.069, "50mi": 50.0, "100k": 62.137, "100mi": 100.0,
  };
  const goalDistanceMiles =
    (data.goal_distance_miles as number | null) ?? runGoalDistancesMilesStandard[goal] ?? null;

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
        goal_distance_miles: goalDistanceMiles,
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
  if (goal === "general_fitness" || goal === "return_to_running" || goal === "injury_recovery") return "general";
  return "running";
}

/**
 * Ordered list of onboarding steps after awaiting_goal.
 * findNextStep walks this list and returns the first unsatisfied step.
 */
const STEP_ORDER = [
  "awaiting_race_date",
  "awaiting_goal_time",           // only shown for race goals (not general fitness or ultras)
  "awaiting_strava",              // offer Strava connect; satisfied once strava_connected=true or user skips
  "awaiting_schedule",
  "awaiting_mileage_baseline",    // only for non-Strava users who haven't mentioned mileage yet
  "awaiting_ultra_background",    // only shown for 50K+ goals
  "awaiting_injury_background",   // only shown for injury_recovery goals
  "awaiting_timezone",            // confirm/set timezone for accurate reminder timing
  "awaiting_anything_else",
];

/**
 * Returns true if the data collected so far already satisfies this step,
 * meaning we can skip asking about it.
 */
function isStepSatisfied(step: string, data: Record<string, unknown>): boolean {
  switch (step) {
    case "awaiting_race_date":
      // Skip for injury recovery and return_to_running — no race date needed
      if (data.goal === "injury_recovery" || data.goal === "return_to_running") return true;
      // Satisfied if race_date key exists (even null = "no race")
      return Object.prototype.hasOwnProperty.call(data, "race_date");
    case "awaiting_goal_time":
      // Skip for general fitness, return_to_running, injury recovery, and ultras (cutoffs matter more than finish times)
      if (data.goal === "general_fitness" || data.goal === "return_to_running" || data.goal === "injury_recovery" || ULTRA_GOALS.includes(data.goal as string)) return true;
      // Satisfied once goal_time_minutes key exists (even null = "no specific goal")
      return Object.prototype.hasOwnProperty.call(data, "goal_time_minutes");
    case "awaiting_strava":
      // Satisfied once the user has connected Strava OR explicitly skipped
      return !!(data.strava_connected || data.strava_skipped);
    case "awaiting_schedule":
      return Array.isArray(data.training_days) && (data.training_days as string[]).length > 0;
    case "awaiting_mileage_baseline":
      // Skip for Strava users — we have real activity data
      if (data.strava_connected) return true;
      // Skip if mileage was already captured (in goal message, injury bg, etc.)
      if (data.weekly_miles != null || data.weekly_hours != null) return true;
      // Skip for injury_recovery — awaiting_injury_background collects current mileage
      if (data.goal === "injury_recovery") return true;
      return false;
    case "awaiting_ultra_background":
      // Only relevant for ultra goals — skip entirely for everything else.
      if (!ULTRA_GOALS.includes(data.goal as string)) return true;
      // If Strava is connected, we can infer training background from activity history — skip the question.
      if (data.strava_connected) return true;
      // Satisfied if we already have both weekly mileage and some race/experience context.
      return !!(data.weekly_miles) && !!(data.ultra_race_history || data.experience_years != null);
    case "awaiting_injury_background":
      // Only relevant for injury_recovery goals — skip entirely for everything else.
      if (data.goal !== "injury_recovery") return true;
      // Satisfied once we have injury notes captured.
      return !!(data.injury_notes);
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

    case "awaiting_race_date": {
      if (data.goal === "general_fitness") {
        return "Do you have a target event or date in mind? If not, just say 'no event' and we'll keep the plan open-ended.";
      }
      // Pre-fill if a month was mentioned but no specific date captured yet
      const raceMonth = data.race_month as string | null;
      if (raceMonth) {
        return `You mentioned ${raceMonth} — do you have a specific date in mind, or is it more like "sometime in ${raceMonth}"? A rough date is totally fine.`;
      }
      // Softer tone for beginners with vague timelines
      const experienceYears = (data.experience_years as number) ?? null;
      if (experienceYears !== null && experienceYears < 0.5) {
        return "Do you have a specific date in mind, or is it more like 'sometime this summer'? Either's fine — we can lock it in later.";
      }
      return "What's the date of your event? If you don't have one locked in yet, give me your best target and we can adjust later.";
    }

    case "awaiting_schedule":
      if (isTri) return "How many days a week are you training total? And do you have any days that work better for longer sessions?";
      if (isCycling) return "How many days a week do you want to ride? And which days work best for you?";
      return "How many days a week do you want to run, and which days work best for you?";

    case "awaiting_mileage_baseline": {
      const units = (data.preferred_units as string) === "metric" ? "km" : "miles";
      return `One more quick one: roughly how many ${units} a week are you running right now? A ballpark is totally fine.`;
    }

    case "awaiting_ultra_background":
      // Don't re-ask for mileage if awaiting_mileage_baseline already captured it
      return (data.strava_connected || data.weekly_miles != null)
        ? "An ultra — love it. Have you run any before? Any experience with the distance is helpful to know."
        : "An ultra — love it. Have you run any before? And what's your current weekly mileage and longest recent long run?";

    case "awaiting_injury_background":
      return "Tell me more about the injury — what is it, how long ago did it happen, and where are you in recovery? Are you able to run at all right now, or fully off it?";

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
      return "Almost there — anything else before I put this together? Target paces, cross-training, strength work — mention it now and I'll build it in. If not, just say nope!";

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
  /** Non-null when the race offers multiple distances and the athlete hasn't specified which one */
  distanceOptions: string[] | null;
  /** Secondary goal mentioned alongside the primary (e.g. "100K this summer") */
  secondaryGoal: string | null;
}

async function generateRaceAcknowledgment(message: string): Promise<RaceInfo> {
  const empty: RaceInfo = { ack: null, raceDate: null, distanceOptions: null, secondaryGoal: null };
  try {
    const today = new Date().toISOString().split("T")[0];
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 400,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
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
Output: {"ack": "...", "date": "YYYY-MM-DD" | null, "distance_options": null, "secondary_goal": "brief description" | null}
- secondary_goal: if the athlete clearly mentions a second race/event/goal beyond the primary one (e.g. "and then a 100K this summer", "plus Boston next year"), capture it as a short plain-text description. null if none.

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
      const distanceOptions = Array.isArray(parsed?.distance_options) && parsed.distance_options.length > 1
        ? parsed.distance_options as string[]
        : null;
      const secondaryGoal = (typeof parsed?.secondary_goal === "string" && parsed.secondary_goal) ? parsed.secondary_goal : null;
      return { ack: parsed?.ack ?? null, raceDate: parsed?.date ?? null, distanceOptions, secondaryGoal };
    } catch {
      // Fallback: treat as plain-text ack if JSON parse fails
      return { ack: text, raceDate: null, distanceOptions: null, secondaryGoal: null };
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
{"race_date": "YYYY-MM-DD" | null, "race_month": "Month" | null, "experience_years": number | null, "weekly_miles": number | null, "easy_pace": "M:SS" | null, "recent_race_distance_km": number | null, "recent_race_time_minutes": number | null, "pr_year": number | null, "injury_mentioned": boolean, "injury_notes": string | null, "crosstraining_tools": string[] | null, "other_notes": string | null, "name": "FirstName" | null, "secondary_goal": string | null}

Rules:
- name: Extract if the athlete introduces themselves. Be generous — people introduce themselves in many ways:
  Explicit: "I'm Mark", "My name is Mark", "Call me Mark", "This is Mark", "It's Mark", "Hey it's Mark"
  Implicit: a message beginning with a single capitalized word followed by a period, comma, exclamation mark, or emoji (e.g. "Mark. Nothing on the calendar", "Mark, just getting started", "Mark!", "Mark 👋")
  Bare name: the entire message is just a first name (e.g. "Mark" with nothing else)
  With "here": "[Name] here" (e.g. "Mark here", "Hey, Mark here")
  NEVER extract from greetings directed at Coach Dean like "Hey Dean!" or "Hi Coach!" — those address the coach, not the athlete. Return null if genuinely ambiguous.
- race_date: if a specific target race date is mentioned. Today is ${today}.
- race_month: if a month is mentioned as a rough race timing but no specific date is given (e.g. "in October", "sometime this spring", "around June"). Use the month name (e.g. "October", "June"). Set race_date instead if a specific date is known. null if a full date is extracted or nothing mentioned.
- experience_years: infer from any experience signal. "new runner" or "just started" → 0. "fairly inexperienced" → 0.2. "completed an 8 week plan" with no prior context → 0.15. "a year" → 1. "5+ years" → 5.
- weekly_miles: total weekly running mileage. If stated as a per-day or per-weekday average (e.g. "I run 5-6 miles a day", "5-6 miles weekdays"), multiply by the number of days implied (weekdays = 5, "every day" = 7) to get a weekly total. Convert km to miles (×0.621).
- easy_pace: ONLY a stated comfortable, easy, or conversational running pace. Do NOT extract race pace, PR pace, or anything described as a PR, best time, or race effort. Format as M:SS per mile. "8:30/m" → "8:30". "5:00/km" → "8:03".
- recent_race_distance_km: if a PR or recent race is mentioned. 5K=5, 10K=10, half=21.0975, marathon=42.195, 1mi=1.609. If the athlete gives a pace rather than a time (e.g. "5K PR pace is 5:40/mi"), compute the total time: pace_per_mile × distance_in_miles (5K=3.107mi, 10K=6.214mi, half=13.109mi, marathon=26.219mi).
- recent_race_time_minutes: total race time in minutes for the PR/race above. If given as a pace, compute time = pace_sec/mile × distance_in_miles / 60.
- pr_year: the year the PR was run if mentioned (e.g. "my 1:42 half from 2019", "ran a 3:45 marathon last year"). Use the actual year number. null if not mentioned.
- injury_mentioned: true if any injury or physical limitation is mentioned.
- injury_notes: brief description of injury type, severity, and recovery status if an injury is mentioned (e.g. "IT band syndrome, recovering, avoiding back-to-back days"). null if no injury.
- crosstraining_tools: normalized array of cross-training activities or equipment mentioned (e.g. ["cycling", "swimming", "gym", "yoga"]). null if none.
- other_notes: any other training-relevant context not captured above — strengthening preferences, target times, lifestyle constraints, etc. null if nothing else.
- secondary_goal: if the athlete mentions a second distinct race or goal beyond the primary one (e.g. "and then a marathon in the fall", "plus Boston next year", "also want to do a crit series"). Short plain-text description. null if only one goal is mentioned.
- Return {} if nothing is present.`,
    messages: [{ role: "user", content: message }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    const parsed = JSON.parse(extractJSON(text));
    const result: Record<string, unknown> = {};
    if (parsed.race_date != null) result.race_date = parsed.race_date;
    if (parsed.race_month != null) result.race_month = parsed.race_month;
    if (parsed.experience_years != null) result.experience_years = parsed.experience_years;
    if (parsed.weekly_miles != null) result.weekly_miles = parsed.weekly_miles;
    if (parsed.easy_pace != null) result.easy_pace = parsed.easy_pace;
    if (parsed.recent_race_distance_km != null) result.recent_race_distance_km = parsed.recent_race_distance_km;
    if (parsed.recent_race_time_minutes != null) result.recent_race_time_minutes = parsed.recent_race_time_minutes;
    if (parsed.pr_year != null) result.pr_year = parsed.pr_year;
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

/**
 * Responds naturally to whatever the athlete said in the "anything else?" step.
 * - Questions → answer + re-ask "Anything else?"
 * - Substantive info → acknowledge + re-ask "Anything else?"
 * - "Nope / nothing / all good" → { response: null, isDone: true }
 *
 * Returns isDone: true when the athlete is finished and onboarding should complete.
 */
async function generateAnythingElseResponse(
  message: string,
  onboardingData: Record<string, unknown>
): Promise<{ response: string | null; isDone: boolean }> {
  const goal = onboardingData.goal as string | null;
  // Intentionally omit the raw race_date — passing "2025-10-19" caused Dean to hallucinate
  // a wrong date ("October 1st") in conversational responses. Goal label is enough context.
  const context = goal
    ? `The athlete is training for a ${goal}.`
    : "The athlete is in the process of setting up their training plan.";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: `You are Coach Dean, an AI endurance coach. ${context} You just asked: "Before I put your plan together, anything else I should know?"

The athlete replied. Respond appropriately:

- If they said "no", "nope", "nothing", "all good", "nah", "I'm good", or anything that clearly means they're done → return: {"response": null, "done": true}
- If they asked a question → answer it warmly in 1-2 sentences, then end with a natural re-ask like "Anything else? If not, just say nope!" Return: {"response": "...", "done": false}
- If they shared info (injury, schedule constraints, secondary goal, training history, preferences) → briefly acknowledge it in 1 sentence, then end with "Anything else? If not, just say nope!" Return: {"response": "...", "done": false}

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
    // Fallback: if parse fails, treat as a response that needs re-asking
    return { response: text.length > 5 ? text : null, isDone: false };
  }
}

/**
 * Generates a schedule-specific acknowledgment that always references the parsed days
 * and handles any flexibility/caveat the user added (e.g. "may switch those around").
 */
async function acknowledgeSchedule(message: string, trainingDays: string[]): Promise<string> {
  const dayList = trainingDays.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(", ");
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
 * Detects whether the user's first message contains an immediate question — either a
 * coaching question (pacing, race-day tactics, training advice) or a capability/service
 * question ("do you work with cyclists?", "can you help with triathlon?") — and returns
 * a brief answer. Returns null if no question is present.
 */
async function detectAndAnswerImmediate(
  message: string,
  goal: string
): Promise<string | null> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 250,
    system: `You are Coach Dean, a friendly AI endurance coach. A new athlete training for ${goal} just sent their first message. It may contain a question alongside background info about themselves.

If the message contains a genuine question of any of these types:
- Coaching questions: race prep, pacing advice, training volume, race-day tactics, nutrition, gear
- Capability/service questions: whether Dean works with a certain type of athlete or sport ("do you work with cyclists?", "can you help with triathlon?", "do you coach beginners?")
Answer it briefly and helpfully in 1-2 sentences. Be warm and specific. Plain text only — no markdown, no bullet points, no asterisks. Return only your answer.

If there is no question — just goal-setting or background info — return only: {"no_question": true}`,
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
    awaiting_goal_time: { topic: "their finish time goal for the race (or whether they have one)" },
    awaiting_ultra_background: { topic: "their ultra running background and previous race experience" },
    awaiting_timezone: { topic: "what city or timezone they're in" },
    awaiting_cadence: { topic: "whether they want morning-of reminders, evening-before reminders, or a weekly Sunday overview" },
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

const ULTRA_GOALS = ["30k", "50k", "50mi", "100k", "100mi"];

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
    "50mi": "50-mile ultra",
    "100k": "100K ultra",
    "100mi": "100-mile ultra",
    sprint_tri: "sprint triathlon",
    olympic_tri: "Olympic-distance triathlon",
    "70.3": "70.3 Half Ironman",
    ironman: "Full Ironman",
    cycling: "cycling event",
    general_fitness: "general fitness",
    return_to_running: "return to running",
    injury_recovery: "injury recovery",
  };
  return labels[goal] || goal;
}
