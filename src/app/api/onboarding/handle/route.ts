import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping, shareContactCard } from "@/lib/linq";
import { trackEvent } from "@/lib/track";
import { calculateVDOTPaces, estimatePacesFromEasyPace, easyPaceRange, formatRaceDistance } from "@/lib/paces";
import { getCheckoutPageUrl } from "@/lib/stripe";
import type { Json } from "@/lib/database.types";

export const maxDuration = 60;

// Tracks userIds currently in a dry_run onboarding request.
// Allows sendAndStore / completeOnboarding to skip SMS without threading
// dry_run through every helper function signature.
const dryRunUsers = new Set<string>();

interface OnboardingRequest {
  userId: string;
  message: string;
  chatId?: string | null;
  dry_run?: boolean; // skip SMS send; responses still stored in conversations for test inspection
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
  const { userId, message, chatId, dry_run = false }: OnboardingRequest = await request.json();
  if (dry_run) dryRunUsers.add(userId);

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
  // Skip awaiting_strava — handleStrava has its own question detection that includes the Strava URL.
  // Skip awaiting_goal_time — handleGoalTime has its own web-search path for research questions.
  if (step && step !== "awaiting_goal" && step !== "awaiting_anything_else" && step !== "awaiting_name" && step !== "awaiting_strava" && step !== "awaiting_cadence" && step !== "awaiting_goal_time" && step !== "awaiting_payment") {
    const offTopicResult = await checkOffTopic(step, message, userId);
    if (offTopicResult.offTopic) {
      keepTypingAlive = false;
      await sendAndStore(user.id, user.phone_number, offTopicResult.response, step ?? undefined);
      return NextResponse.json({ ok: true });
    }
  }

  // Loop detection: if the last 2+ assistant messages within 2 minutes are identical,
  // we're stuck in a response loop (debounce wasn't enough, or race condition).
  // The de-escalation message is step-aware so the re-prompt makes sense wherever in
  // onboarding the loop occurred. If the de-escalation for this step was already sent,
  // stay silent — firing it again would just restart the loop with different content.
  const DEESCALATION_BY_STEP: Record<string, string> = {
    "awaiting_goal":              "Looks like something got confused on my end — sorry about that! I'm Coach Dean, your AI running coach. What are you training for?",
    "awaiting_race_date":         "Sorry, something got tangled on my end! When are you targeting for your race? A rough month and year works.",
    "awaiting_other_races":       "Sorry, something got tangled on my end! Is your stated race your main goal race this season, and do you have any other races on the calendar?",
    "awaiting_schedule":          "Sorry, something got tangled on my end! How many days a week are you looking to train?",
    "awaiting_ultra_background":  "Sorry, something got tangled on my end! Roughly how many miles a week are you currently running?",
    "awaiting_injury_background": "Sorry, something got tangled on my end! Can you tell me a bit about the injury you're recovering from?",
    "awaiting_anything_else":     "Sorry, something got tangled on my end! Anything else you'd like me to know before I put your plan together?",
    "awaiting_name":              "Sorry, something got tangled on my end! What should I call you?",
    "awaiting_goal_time":         "Sorry, something got tangled on my end! What's your goal time for the race?",
    "awaiting_mileage_baseline":  "Sorry, something got tangled on my end! Roughly how many miles a week are you currently running?",
    "awaiting_timezone":          "Sorry, something got tangled on my end! What time zone are you in?",
    "awaiting_cadence":           "Sorry, something got tangled on my end! Would you like a reminder the morning of each workout, or the evening before? If not, just say 'weekly' and I'll send you a Sunday plan.",
    "awaiting_payment":           "Sorry, something got tangled on my end! Here's the link to start your free 7-day trial again.",
  };
  const deEscalationMsg = step && DEESCALATION_BY_STEP[step]
    ? DEESCALATION_BY_STEP[step]
    : "Sorry, something got a bit tangled on my end — let's try again.";
  {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: recentMsgs } = await supabase
      .from("conversations")
      .select("content, created_at")
      .eq("user_id", userId)
      .eq("role", "assistant")
      .gte("created_at", twoMinutesAgo)
      .order("created_at", { ascending: false })
      .limit(3);

    const loopDetected = recentMsgs && recentMsgs.length >= 2 && recentMsgs[0].content === recentMsgs[1].content;
    const deEscalationAlreadySent = recentMsgs && recentMsgs[0]?.content === deEscalationMsg;

    if (loopDetected && !deEscalationAlreadySent) {
      console.log("[onboarding] loop detected: identical response sent 2+ times, de-escalating for", userId, "step:", step);
      keepTypingAlive = false;
      // For awaiting_goal only: mark intro_sent so the next non-goal message gets
      // the shorter "What are you training for?" follow-up, not the full intro again.
      if (step === "awaiting_goal") {
        const updatedData = { ...onboardingData, intro_sent: true };
        void supabase.from("users").update({ onboarding_data: updatedData as Json }).eq("id", userId);
      }
      await sendAndStore(user.id, user.phone_number, deEscalationMsg, step ?? undefined);
      if (dry_run) dryRunUsers.delete(userId);
      return NextResponse.json({ ok: true });
    }

    if (loopDetected && deEscalationAlreadySent) {
      console.log("[onboarding] loop detected but de-escalation already sent, staying silent for", userId, "step:", step);
      keepTypingAlive = false;
      if (dry_run) dryRunUsers.delete(userId);
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
    case "awaiting_other_races":
      result = await handleOtherRaces(user, message, onboardingData);
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
      result = await handleCadence({ ...user, onboarding_data: onboardingData }, message);
      break;
    case "awaiting_payment":
      result = await handleAwaitingPayment(user);
      break;
    default:
      result = NextResponse.json({ ok: true });
  }

  keepTypingAlive = false;
  if (dry_run) dryRunUsers.delete(userId);
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

Output format: {"complete": true|false, "no_event": true|false, "goal": "mile"|"5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"50mi"|"100k"|"100mi"|"sprint_tri"|"olympic_tri"|"70.3"|"ironman"|"cycling"|"general_fitness"|"return_to_running"|"injury_recovery"|null, "race_name": string|null, "goal_distance_miles": number|null}

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
- For non-standard distances mapped to the "mile" bucket (e.g. 1.5 mile, 2 mile): always output the exact distance → goal_distance_miles: 1.5, 2.0, etc.
- For general_fitness, return_to_running, injury_recovery, triathlon types, cycling → goal_distance_miles: null

Rules:
- complete: true only if a clear training goal is identifiable
- no_event: true if the athlete explicitly says they have no race or event planned right now ("nothing on the calendar", "no race yet", "not signed up for anything", "no events planned") — regardless of whether complete is true or false
- Pure greetings with no goal context → complete: false, no_event: false, goal: null
- Named specific race or event (e.g. "Behind the Rocks trail race", "Wasatch 100", "Boston Marathon", "local 5K next spring") → complete: true. Use any explicit distance cues in the message: "Wasatch 100" → "100k"; "Boston Marathon" → "marathon"; "local half" → "half_marathon". If the name contains no distance info (e.g. just "Behind the Rocks trail race"), use "50k" as a placeholder — the web search step will clarify if needed.
- "mile PR", "mile time trial", "1 mile", "track mile", "1-mile race", "sub-5 mile", "sub-4 mile", "mile repeat" as a goal → "mile"
- "half marathon" or "half" → "half_marathon"

- "full marathon" or "marathon" → "marathon"
- "50 miles", "50-mile", "50-miler", "50mi", "fifty miles", "50 mile ultra" → "50mi" (NOT "50k" — these are very different races)
- "100 miles", "100-mile", "100-miler", "100mi", "hundred miles", "100 mile ultra", "Western States", "Leadville", "UTMB" → "100mi"
- "ultra" without distance → "50k"
- Non-standard distances — map to nearest standard bucket:
  - Under ~5K (less than ~3 miles): 1.5 mile run, 2 mile race, 2.5 mile time trial → "mile" (same speed/neuromuscular training as a mile)
  - ~5K to ~10K (3 to 6 miles): 4-mile race, 8K, 5-mile race → "5k"
  - ~10K to half marathon (6 to 12 miles): 10-mile race, 15K → "10k"
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

  // Whitelist check: if the LLM returned an invalid bucket, treat as no goal detected
  if (parsed.goal && !VALID_GOAL_BUCKETS.has(parsed.goal)) {
    console.warn("[onboarding] invalid goal bucket from classifier:", parsed.goal);
    parsed.goal = null;
    parsed.complete = false;
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
        ? `Hey ${name}! I'm Coach Dean — your AI running coach, entirely over text. I can build you a personalized training plan, analyze your runs via Strava, incorporate strength and mobility work to keep you injury-free, and discuss race strategy and pacing.\n\nWhat are you training for?`
        : `I'm Coach Dean — your AI running coach, entirely over text. I can build you a personalized training plan, analyze your runs via Strava, incorporate strength and mobility work to keep you injury-free, and discuss race strategy and pacing.\n\nWhat's your name and what are you training for?`;
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
    // Mark intro as sent so subsequent messages don't re-append the identity note.
    // Must be awaited — void/fire-and-forget can be killed by Vercel before completing,
    // leaving intro_sent unset and causing "I'm Coach Dean" to repeat on the next message.
    // Also merge in any name extracted this message so it isn't overwritten.
    if (!introAlreadySent) {
      const mergedForIntro = {
        ...onboardingData,
        ...(nameFromMessage ? { name: nameFromMessage } : {}),
        intro_sent: true,
      };
      await supabase.from("users").update({ onboarding_data: mergedForIntro as Json }).eq("id", user.id);
    }
    return NextResponse.json({ ok: true });
  }

  // Goal detected — run remaining parallel enrichment calls.
  const otherNotes = extra.other_notes as string | null;
  const [immediateAnswer, raceInfo, constraintAck] = await Promise.all([
    detectAndAnswerImmediate(message, parsed.goal),
    generateRaceAcknowledgment(message),
    otherNotes ? generateConstraintAcknowledgment(otherNotes, parsed.race_name ?? formatGoalInline(parsed.goal)) : Promise.resolve(null),
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
    // Pre-fill the date from web search even when multiple races were mentioned.
    // We still leave race_date_confirmed: false so awaiting_race_date confirms it — but
    // the A race question (awaiting_other_races) is asked FIRST when secondary_goal is set,
    // and awaiting_race_date is revisited after the A race is confirmed.
    ...(raceInfo.raceDate && !extra.race_date ? { race_date: raceInfo.raceDate } : {}),
    ...(parsed.no_event && !extra.race_date && !raceInfo.raceDate ? { race_date: null, race_date_confirmed: true } : {}),
    ...(raceInfo.secondaryGoal || extra.secondary_goal
      ? { secondary_goal: raceInfo.secondaryGoal ?? extra.secondary_goal }
      : {}),
    // Store the specific race name / non-standard distance when it differs from the goal bucket.
    // This lets the coaching system display "25K Marin Headlands" instead of just "30K trail race".
    ...(parsed.race_name ? { race_name: parsed.race_name } : {}),
    // Store exact distance in miles when classifier extracted a non-standard value.
    // Fall back to web-search-extracted distance (e.g. Dipsea = 7.4mi) when the goal message
    // didn't include an explicit distance for the classifier to parse.
    // completeOnboarding will fall back to the bucket standard if this is null.
    ...(parsed.goal_distance_miles != null
      ? { goal_distance_miles: parsed.goal_distance_miles }
      : raceInfo.distanceMiles != null
        ? { goal_distance_miles: raceInfo.distanceMiles }
        : {}),
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
    // Prefix with name when known (race acks are race-focused and don't include it naturally).
    const namePrefix = name ? `Hey ${name} — ` : "";
    acknowledgment = constraintAck ? `${namePrefix}${raceInfo.ack} ${constraintAck}` : `${namePrefix}${raceInfo.ack}`;
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
    const raceLabel = parsed.race_name ? `the ${parsed.race_name}` : `a ${goalLabel}`;
    acknowledgment = `Love it${name ? `, ${name}` : ""} — ${raceLabel} is a great goal. ${whatDeanDoes}`;
  }

  if (constraintAck && !raceInfo.ack) acknowledgment += ` ${constraintAck}`;

  // Direct-text users skip the web signup intro ("I'm Coach Dean — your AI running coach...").
  // Append a one-line identity note so they know who they're texting.
  if (!onboardingData.intro_sent) {
    acknowledgment += ` I'm Coach Dean, your AI running coach.`;
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
          : `Would you like me to build you a proper ${parsed.race_name ?? goalLabel} training plan? I just have a few quick questions.`;
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
  const raceName = onboardingData.race_name as string | null;
  const existingDistanceMiles = onboardingData.goal_distance_miles as number | null;
  // Look up the race distance when the A race was recently promoted (goal_distance_miles was
  // cleared) but we have a name to search on. Run in parallel with date extraction.
  const shouldLookupDistance = !!raceName && existingDistanceMiles === null;

  // When there was a pre-filled date (not yet confirmed), check in parallel if the user
  // is indicating that date belongs to a DIFFERENT race (e.g. "Ah that's Sierre Zinal's date").
  const prefillDate = onboardingData.race_date as string | null;
  const prefillUnconfirmed = !!prefillDate && !onboardingData.race_date_confirmed;
  const [parseResponse, extra, acknowledgment, raceInfo, raceDateCorrection] = await Promise.all([
    anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
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
    shouldLookupDistance ? generateRaceAcknowledgment(raceName!) : Promise.resolve(null),
    // Only check for date-race mismatch if there was an unconfirmed pre-filled date
    prefillUnconfirmed ? anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      system: `The athlete was asked to confirm or correct a race date. The date shown was for "${raceName ?? "their race"}".

Did the athlete indicate this date actually belongs to a DIFFERENT race — not ${raceName ?? "their race"}?
Examples of this:
- "Ah that's the date of Sierre Zinal" → yes, different_race: "Sierre Zinal"
- "That's for the other race" → yes, different_race: "the other race"
- "No that's right" → no
- "August 8th" → no (just confirming/correcting the date itself)

Return ONLY valid JSON: {"different_race": string | null}`,
      messages: [{ role: "user", content: message }],
    }) : Promise.resolve(null),
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

  // Check if user indicated the pre-filled date belongs to a different race entirely.
  // If so, clear the date and re-ask rather than silently accepting the wrong assignment.
  if (raceDateCorrection) {
    const correctionText = raceDateCorrection.content[0].type === "text" ? raceDateCorrection.content[0].text : "{}";
    let differentRace: string | null = null;
    try {
      differentRace = JSON.parse(extractJSON(correctionText))?.different_race ?? null;
    } catch { /* ignore */ }
    if (differentRace) {
      console.log(`[onboarding] race_date mismatch: user said date belongs to "${differentRace}", not "${raceName}"`);
      const clearedData = { ...onboardingData, race_date: null, race_date_confirmed: false };
      await supabase.from("users").update({ onboarding_data: clearedData as unknown as Json }).eq("id", user.id);
      const raceRef = raceName ? `the ${raceName}` : "your race";
      await sendAndStore(user.id, user.phone_number, `Got it — so that date is for ${differentRace}. What's the date for ${raceRef}?`, "awaiting_race_date");
      return NextResponse.json({ ok: true });
    }
  }

  // Reject any date in the past — either the user typo'd the year or the LLM hallucinated
  const today = new Date().toISOString().split("T")[0];
  if (parsed.race_date && parsed.race_date < today) {
    console.warn("[onboarding] rejecting past race_date from user input:", parsed.race_date);
    parsed.race_date = null;
  }

  // Merge extra fields first, then apply the dedicated race_date parse result on top.
  // Set race_date_confirmed so isStepSatisfied knows the user explicitly answered.
  // When Haiku returns null (user said "yes"/"that's right" to confirm a pre-filled date),
  // fall back to the existing race_date from onboarding_data so it isn't overwritten with null.
  const finalRaceDate = parsed.race_date ?? (onboardingData.race_date as string | null) ?? null;
  const lookedUpDistance = raceInfo?.distanceMiles ?? null;
  const mergedData = {
    ...onboardingData,
    ...removeNulls(extra),
    race_date: finalRaceDate,
    race_date_confirmed: true,
    ...(lookedUpDistance !== null ? { goal_distance_miles: lookedUpDistance } : {}),
  };
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
 * Maps a distance in miles to the closest goal bucket string.
 * Mirrors the DISTANCE_TO_BUCKET thresholds used throughout onboarding.
 */
function distanceMilesToGoalBucket(miles: number): string {
  const DISTANCE_TO_BUCKET: Array<[number, string]> = [
    [3, "mile"], [6.5, "5k"], [13, "10k"], [26.5, "30k"], [27.5, "marathon"],
    [35, "50k"], [52, "50mi"], [80, "100k"], [200, "100mi"],
  ];
  return DISTANCE_TO_BUCKET.find(([threshold]) => miles <= threshold)?.[1] ?? "100mi";
}

/**
 * Given a distance option string like "VK", "31K", "50 miles", return km value.
 */
function parseOptionKm(opt: string): number | null {
  // VK = Vertical Kilometer ~1km vertical, treat as ~7.5km equivalent distance
  if (/\bvk\b/i.test(opt)) return 7.5;
  const m = opt.match(/(\d+(?:\.\d+)?)\s*(mi(?:les?)?|km?)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "k").toLowerCase();
  return unit.startsWith("mi") ? n * 1.609 : n;
}

/**
 * awaiting_other_races: after confirming their primary (A) race date, ask if they
 * have any other races on the calendar and whether this is truly their A race.
 * Parses any B/C races mentioned and stores them in onboarding_data.other_races.
 */
async function handleOtherRaces(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  // Re-entry: user is answering our "which distance?" question from a previous turn.
  const pendingOptions = onboardingData.pending_distance_options as string[] | null;
  if (pendingOptions && pendingOptions.length > 0) {
    const raceName = onboardingData.race_name as string | null;
    // Try to find which option the user picked by matching against known distance strings.
    const lowerMsg = message.toLowerCase();
    const picked = pendingOptions.find(opt => {
      const km = parseOptionKm(opt);
      if (!km) return false;
      // Match by km number, miles equivalent, or label (e.g. "vk", "31k")
      const optLower = opt.toLowerCase().replace(/\s+/g, "");
      if (lowerMsg.includes(optLower)) return true;
      // Also match by numeric km mention, e.g. "31k" or "31 km"
      const kmMatch = opt.match(/(\d+(?:\.\d+)?)/);
      if (kmMatch && lowerMsg.includes(kmMatch[1])) return true;
      return false;
    });
    if (picked) {
      const km = parseOptionKm(picked);
      const miles = km ? Math.round((km / 1.60934) * 100) / 100 : null;
      const updatedData: Record<string, unknown> = {
        ...onboardingData,
        pending_distance_options: null,
        other_races_answered: true,
        ...(miles !== null
          ? { goal_distance_miles: miles, goal: distanceMilesToGoalBucket(miles) }
          : {}),
      };
      const nextStep = findNextStep("awaiting_other_races", updatedData);
      await supabase.from("users")
        .update({ onboarding_step: nextStep, onboarding_data: updatedData as unknown as Json })
        .eq("id", user.id);
      if (nextStep) {
        const nextQuestion = getStepQuestion(nextStep, updatedData, user.id);
        await sendAndStore(user.id, user.phone_number, nextQuestion, nextStep);
      } else {
        await completeOnboarding(user, updatedData);
      }
      return NextResponse.json({ ok: true });
    }
    // Couldn't parse — re-ask
    const optionsList = pendingOptions.join(" or ");
    await sendAndStore(user.id, user.phone_number, `Which distance of the ${raceName ?? "race"} are you doing — ${optionsList}?`, "awaiting_other_races");
    return NextResponse.json({ ok: true });
  }

  const secondaryGoalContext = onboardingData.secondary_goal as string | null;
  const [parseResponse, acknowledgment] = await Promise.all([
    anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: `The athlete was asked which race is their top priority, and may confirm it or name a different one.
Return ONLY valid JSON, no other text.
${secondaryGoalContext ? `\nIMPORTANT — Previously mentioned races: The athlete already mentioned these other races in their first message: "${secondaryGoalContext}". Even if their reply is brief (e.g. "yes", "yep, that's my A race"), include those previously mentioned races in other_races with appropriate priorities. Do not omit them just because they weren't repeated.\n` : ""}
Output format: {
  "confirmed_a_race_date": "YYYY-MM-DD" | null,
  "other_races": [
    {
      "date": "YYYY-MM-DD",
      "name": string | null,
      "goal": "mile"|"5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"50mi"|"100k"|"100mi"|null,
      "priority": "B"|"C"
    }
  ],
  "new_a_race": {
    "name": string,
    "goal": "mile"|"5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"50mi"|"100k"|"100mi"|null,
    "date": "YYYY-MM-DD" | null
  } | null
}

confirmed_a_race_date rules:
- Set when the athlete confirms or corrects the date for the ORIGINAL asked-about race (not a promoted new A race)
- If they say "yes" to a pre-filled date: return that same date
- If they provide a correction ("no, it's June 21"): return the corrected date
- If they don't mention the A race date at all: return null
- Do NOT set this when new_a_race is set — use new_a_race.date instead

new_a_race rules:
- Set this when the athlete signals a different race is their top priority — this includes explicit statements AND implicit corrections like "No [race] is" or "No that one" responding to a yes/no question. Examples:
  - "the 100k is the top priority" → new_a_race: 100K race
  - "actually X is my A race" → new_a_race: X
  - "No Sierre Zinal is" (in response to "Is Dipsea your A race?") → new_a_race: Sierre Zinal
  - "No that one" (in response to "Is X your A race?") → new_a_race: the other race the athlete has mentioned
  - "Yes" or "That's right" → new_a_race: null (original is confirmed as A race)
  - "Sierre Zinal. Dipsea is June 14, Sierre Zinal August 8, A Basin Sep 6" → new_a_race: {name: "Sierre Zinal", date: "2026-08-08", goal: null} — IMPORTANT: when the athlete was asked "which is your A race?" and their reply leads with just a race name (a short first sentence or single word before the date list), that standalone name IS the A race answer. Extract it as new_a_race.
- If set, the original A race should appear in other_races with priority "B" (not "A").

other_races rules (races other than the new A race, or other than the original A race if no promotion):
- "B": tune-up or secondary goal race — the athlete plans to race it meaningfully
- "C": low-key, for-fun, or treat-as-workout race (e.g. "just a local 5K with friends")
- Default to "B" when priority is unclear for a non-trivial race
- Default to "C" for very short races (5K or shorter) when no priority context is given
- Do NOT include the new A race (if any) in other_races

Date rules:
- If only a month is given, assume current year (or next year if that month has passed)
- Today is ${new Date().toISOString().split("T")[0]}

If no other races mentioned AND no previously mentioned races context, return: {"other_races": [], "new_a_race": null}`,
      messages: [{ role: "user", content: message }],
    }),
    acknowledgeSharedInfo(message),
  ]);

  let otherRaces: Array<{ date: string; name: string | null; goal: string | null; priority: "B" | "C" }> = [];
  let newARace: { name: string; goal: string | null; date: string | null } | null = null;
  let confirmedARaceDate: string | null = null;
  try {
    const text = parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
    const parsed = JSON.parse(extractJSON(text));
    otherRaces = Array.isArray(parsed.other_races) ? parsed.other_races : [];
    newARace = parsed.new_a_race && typeof parsed.new_a_race === "object" ? parsed.new_a_race : null;
    confirmedARaceDate = typeof parsed.confirmed_a_race_date === "string" ? parsed.confirmed_a_race_date : null;
  } catch (e) {
    console.error("[onboarding] other_races parse failed:", e);
  }

  // Web-search dates for any B/C races that have a name but no date.
  // Haiku doesn't have web access, so named races without explicit date mentions often come back with null dates.
  const racesNeedingDates = otherRaces.filter(r => r.name && !r.date);
  if (racesNeedingDates.length > 0) {
    const lookups = await Promise.all(racesNeedingDates.map(r => lookupRaceDate(r.name!)));
    racesNeedingDates.forEach((r, i) => {
      if (lookups[i]) r.date = lookups[i]!;
    });
  }
  // Drop races that still have no date (DB requires race_date) — but keep the data in onboarding_data
  // so re-sync can retry later. Filter happens at completeOnboarding insert time.

  // If the user promoted a different race to A, update the stored A race fields.
  // The original A race becomes a B race (add to other_races if not already there).
  let mergedData: Record<string, unknown> = { ...onboardingData };
  if (newARace) {
    const oldRaceName = onboardingData.race_name as string | null;
    const oldGoal = onboardingData.goal as string | null;
    const oldDate = onboardingData.race_date as string | null;
    // Add the old A race to other_races as a B race if it's not already in the list
    const alreadyIncluded = otherRaces.some(r =>
      r.name && oldRaceName && r.name.toLowerCase().includes(oldRaceName.toLowerCase().split(" ")[0])
    );
    if (oldRaceName && !alreadyIncluded) {
      // Look up date for old A race if it doesn't have one — empty string would be filtered out at insert.
      const oldRaceDate = oldDate || (await lookupRaceDate(oldRaceName));
      otherRaces = [...otherRaces, { date: oldRaceDate || "", name: oldRaceName, goal: oldGoal, priority: "B" }];
    }
    // Remove any entries in other_races that match the new A race — Haiku sometimes includes
    // the promoted race in other_races despite being told not to.
    const newARaceFirstWord = newARace.name.toLowerCase().split(/\s+/)[0]!;
    otherRaces = otherRaces.filter(r =>
      !(r.name && r.name.toLowerCase().includes(newARaceFirstWord))
    );
    // If the promoted race has no date from parsing, try a web search for it.
    // Track whether the date came from the user (confirmed) vs web search (needs confirmation).
    const userProvidedDate = newARace.date ?? null;
    const promotedDate = userProvidedDate ?? (newARace.name ? await lookupRaceDate(newARace.name) : null);
    // Only mark confirmed when the user explicitly provided the date — web-search fallbacks
    // should still go through awaiting_race_date so the user can correct wrong dates.
    const promotedDateConfirmed = !!userProvidedDate;
    // goal_time_minutes must be deleted (not set to null) — the satisfaction check uses hasOwnProperty,
    // so null would incorrectly mark the step as answered and skip re-asking for the new race.
    const { goal_time_minutes: _gmt, ...mergedWithoutGoalTime } = mergedData;
    mergedData = {
      ...mergedWithoutGoalTime,
      race_name: newARace.name,
      goal: newARace.goal ?? oldGoal,
      race_date: promotedDate ?? null,
      // Only confirmed if the user explicitly gave a date — web search pre-fills ask for confirmation
      race_date_confirmed: promotedDateConfirmed,
      race_month: null,           // clear old A race's month
      goal_distance_miles: null,  // will be re-looked-up in handleRaceDate
      secondary_goal: null,       // was set when old race was A; now stale
    };
    console.log(`[onboarding] A race promoted: ${oldRaceName} → ${newARace.name}, date: ${promotedDate}, user-confirmed: ${promotedDateConfirmed}`);

    // When the user provided the date inline, awaiting_race_date is bypassed, so we never
    // hit handleRaceDate where the distance lookup normally happens. Do it here instead.
    if (promotedDateConfirmed) {
      const raceInfo = await generateRaceAcknowledgment(newARace.name);
      if (raceInfo.distanceOptions && raceInfo.distanceOptions.length > 0) {
        // Multi-distance race — ask which distance before continuing
        mergedData = {
          ...mergedData,
          pending_distance_options: raceInfo.distanceOptions,
          goal: null,
          goal_distance_miles: null,
        };
        const optionsList = raceInfo.distanceOptions.join(" or ");
        await supabase.from("users")
          .update({ onboarding_step: "awaiting_other_races", onboarding_data: mergedData as unknown as Json })
          .eq("id", user.id);
        const ackPrefix = acknowledgment ? `${acknowledgment}\n\n` : "";
        await sendAndStore(user.id, user.phone_number, `${ackPrefix}${newARace.name} has a few distance options — are you doing the ${optionsList}?`, "awaiting_other_races");
        return NextResponse.json({ ok: true });
      }
      if (raceInfo.distanceMiles !== null) {
        mergedData = {
          ...mergedData,
          goal_distance_miles: raceInfo.distanceMiles,
          goal: distanceMilesToGoalBucket(raceInfo.distanceMiles),
        };
        console.log(`[onboarding] distance looked up for promoted A race ${newARace.name}: ${raceInfo.distanceMiles}mi → goal: ${mergedData.goal}`);
      } else {
        // Distance lookup returned nothing — clear the stale goal from the old A race so the
        // dashboard doesn't show the wrong distance bucket.
        mergedData = { ...mergedData, goal: null };
        console.log(`[onboarding] distance lookup returned nothing for promoted A race ${newARace.name}, clearing stale goal`);
      }
    }
  } else if (confirmedARaceDate) {
    // Original A race confirmed — apply the date (may be correction of the pre-fill)
    mergedData = { ...mergedData, race_date: confirmedARaceDate, race_date_confirmed: true };
    console.log(`[onboarding] A race date confirmed inline: ${confirmedARaceDate}`);
  }

  mergedData = {
    ...mergedData,
    other_races: otherRaces,
    other_races_answered: true,
  };
  // Loop back to awaiting_race_date only when the A race date is still unconfirmed:
  // - Promoted race with no date found (user didn't provide one, web search returned nothing)
  // - Multi-race path where user gave no date info at all (no pre-fill and no inline date)
  // awaiting_race_date is earlier in STEP_ORDER so findNextStep won't reach it — override manually.
  const nextStep = !mergedData.race_date_confirmed
    ? "awaiting_race_date"
    : findNextStep("awaiting_other_races", mergedData);

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: mergedData as unknown as Json })
    .eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", {
    step: "other_races",
    other_race_count: otherRaces.length,
  });

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
 * Returns true if the message looks like a research question about race times/pacing
 * rather than a direct answer stating a goal time.
 */
function isGoalTimeResearchQuestion(message: string): boolean {
  const lower = message.toLowerCase();
  // Contains a question mark or explicit research/lookup keywords
  if (lower.includes("?")) return true;
  if (/\b(check|look\s*up|search|find|what.*(time|pace|finish|place|rank)|how\s*fast|top\s*\d+|black\s*shirt|podium|qualify|qualify|competitive)\b/.test(lower)) return true;
  return false;
}

/**
 * Uses web search to answer a research question about race times/competitive standards,
 * then ends with a re-ask for the athlete's personal goal time.
 * Returns null if search fails or is not applicable.
 */
async function searchGoalTimeInfo(
  question: string,
  raceName: string,
  raceDate: string | null
): Promise<string | null> {
  try {
    const today = new Date().toISOString().split("T")[0];
    const dateContext = raceDate ? ` on ${raceDate}` : "";
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 400,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      system: `You are Coach Dean, an AI running coach. An athlete is signing up and asked a research question about the ${raceName}${dateContext}. Today is ${today}.

Search for historical results for the ${raceName} to answer their question accurately. Focus on recent years' finish times, competitive standards, or placement cutoffs they asked about.

Write a direct, conversational reply (2-4 sentences) with the real information you find. Sound like a coach texting — no markdown, no asterisks. After answering, end with a single short question asking what their personal goal time is (e.g. "So what are you aiming for?").

CRITICAL RULES:
- Do NOT narrate your search process. Output nothing until you have the final answer.
- Your ENTIRE response must be the plain-text reply to send via SMS. No JSON, no formatting.
- Strip any citation tags from your output.
- If you can't find reliable data, say so honestly and still ask for their goal time.`,
      messages: [{ role: "user", content: question }],
    });

    // Take the last text block (intermediate search narration may appear before it)
    const textBlocks = response.content.filter(b => b.type === "text");
    const lastBlock = textBlocks[textBlocks.length - 1];
    const text = lastBlock?.type === "text" ? lastBlock.text.trim() : "";
    if (!text) return null;
    // Strip citation tags that sometimes leak through
    return text.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, "$1").replace(/<cite[^>]*\/>/g, "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * awaiting_goal_time: ask if athlete has a specific finish time goal.
 * Parses time expressions like "sub-2", "1:55", "under 4:30", or "just want to finish".
 * If the athlete asks a research question (e.g. "what time do I need for top 35?"),
 * does a web search and answers before re-asking.
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
      max_tokens: 100,
      system: `Extract a race finish time goal from this message. Convert to total minutes.
Examples: "sub-2 hours" → 120, "1:55" → 115, "under 4:30" → 270, "around 2:15" → 135, "23 minutes" → 23.
If the athlete explicitly states they have no time goal (e.g. "just finish", "no goal", "no specific time", "perform my best", "build fitness") → {"goal_time_minutes": null, "has_answered": true}.
If the athlete is uncertain or hasn't answered (e.g. "not sure", "I don't know", off-topic) → {"goal_time_minutes": null, "has_answered": false}.
Return ONLY valid JSON: {"goal_time_minutes": number | null, "has_answered": boolean}`,
      messages: [{ role: "user", content: message }],
    }),
    acknowledgeSharedInfo(message),
  ]);

  let goalTimeMinutes: number | null = null;
  let hasAnswered = false;
  try {
    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    goalTimeMinutes = typeof parsed.goal_time_minutes === "number" ? parsed.goal_time_minutes : null;
    hasAnswered = goalTimeMinutes !== null || parsed.has_answered === true;
  } catch {
    // Parsing failed — treat as no goal, no answer
  }

  // If no time was extracted, check if it's a question we should answer before advancing or re-asking.
  if (goalTimeMinutes === null) {
    const raceName = onboardingData.race_name as string | null;
    if (isGoalTimeResearchQuestion(message) && raceName) {
      // Race-specific research question — answer with web search, then re-ask (they haven't answered yet)
      const raceDate = onboardingData.race_date as string | null;
      const researchReply = await searchGoalTimeInfo(message, raceName, raceDate);
      if (researchReply) {
        await sendAndStore(user.id, user.phone_number, researchReply, "awaiting_goal_time");
        return NextResponse.json({ ok: true });
      }
    } else if (!isGoalTimeResearchQuestion(message) && message.includes("?")) {
      // They asked a coaching question — answer it, then either advance (if they already said no goal) or re-ask
      const answerResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 300,
        system: `You are Coach Dean, an expert running and endurance coach. Answer the athlete's coaching question directly and knowledgeably in 2-4 sentences. Plain text only — no markdown, no asterisks. If there is no genuine coaching question (e.g. the athlete said "not sure" or "I don't know"), return only: {"no_question": true}`,
        messages: [{ role: "user", content: message }],
      });
      const answerText = answerResponse.content[0].type === "text" ? answerResponse.content[0].text.trim() : "";
      let isNoQuestion = false;
      try { isNoQuestion = JSON.parse(extractJSON(answerText))?.no_question === true; } catch { /* plain text answer */ }
      if (answerText && !isNoQuestion) {
        if (hasAnswered) {
          // They clearly stated no goal and asked a question — answer and advance
          const mergedData = { ...onboardingData, goal_time_minutes: null };
          const nextStep = findNextStep("awaiting_goal_time", mergedData);
          await supabase.from("users").update({ onboarding_step: nextStep, onboarding_data: mergedData as unknown as Json }).eq("id", user.id);
          void trackEvent(user.id, "onboarding_step_completed", { step: "goal_time", has_time_goal: false });
          const nextQuestion = nextStep ? getStepQuestion(nextStep, mergedData, user.id) : null;
          const reply = nextQuestion ? `${answerText}\n\n${nextQuestion}` : answerText;
          if (nextStep) {
            await sendAndStore(user.id, user.phone_number, reply, nextStep);
          } else {
            await sendAndStore(user.id, user.phone_number, answerText, "awaiting_goal_time");
            await completeOnboarding(user, mergedData);
          }
        } else {
          // They asked a question but haven't stated their goal — answer and re-ask
          await sendAndStore(user.id, user.phone_number, `${answerText}\n\nDo you have a time goal in mind, or are you focused on finishing?`, "awaiting_goal_time");
        }
        return NextResponse.json({ ok: true });
      }
    }
  }

  const mergedData: Record<string, unknown> = { ...onboardingData, goal_time_minutes: goalTimeMinutes };

  // If the user mentioned a specific race distance in this message (e.g. "I'm doing the 31k version"),
  // capture it now — this step is the last chance before completeOnboarding sets training_profiles.
  const distanceCorrectionMatch = message.match(/\b(\d+(?:\.\d+)?)\s*(?:k|km)\b/i);
  if (distanceCorrectionMatch) {
    const km = parseFloat(distanceCorrectionMatch[1]);
    if (km >= 1 && km <= 200) { // sanity check: ignore implausible values
      const miles = Math.round((km / 1.60934) * 100) / 100;
      mergedData.goal_distance_miles = miles;
      // Re-bucket the goal based on the corrected distance.
      // Thresholds in miles — matches the original goal classifier bucketing logic.
      // "30k" is the catch-all for non-standard 13K–42K (half-to-marathon) distances.
      const DISTANCE_TO_BUCKET: Array<[number, string]> = [
        [3, "mile"], [6.5, "5k"], [13, "10k"], [26.5, "30k"], [27.5, "marathon"],
        [35, "50k"], [52, "50mi"], [80, "100k"], [200, "100mi"],
      ];
      const bucket = DISTANCE_TO_BUCKET.find(([threshold]) => miles <= threshold)?.[1] ?? "100mi";
      if (VALID_GOAL_BUCKETS.has(bucket)) mergedData.goal = bucket;
      console.log(`[onboarding] distance correction in goal_time: ${km}km → ${miles}mi → bucket: ${bucket}`);
    }
  }

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
  const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
  if (/strava/i.test(message) && message.includes("?")) {
    // Strava-specific question — explain value and re-send the link
    const reply = `Yes, worth it — it's free and once connected I can automatically analyze every run without you having to report anything. Here's the link:\n\n${stravaUrl}\n\nAlready have it? Tap the link to connect. No Strava? Just reply "skip" and we'll go manual.`;
    await sendAndStore(user.id, user.phone_number, reply, "awaiting_strava");
    return NextResponse.json({ ok: true });
  }

  const isSkip = /skip|no strava|don.?t have|no thanks|nope|later|next/i.test(message);

  // Only call AI for non-skip messages that might contain a coaching question
  if (!isSkip) {
    const questionAnswer = await detectAndAnswerImmediate(message, (onboardingData.goal as string) || "general fitness");
    if (questionAnswer) {
      const reply = `${questionAnswer}\n\nWhile you're here — connect Strava for automatic run tracking: ${stravaUrl}\n\nOr reply "skip" to continue without it.`;
      await sendAndStore(user.id, user.phone_number, reply, "awaiting_strava");
      return NextResponse.json({ ok: true });
    }
  }

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
  const alreadyKnownDays = onboardingData.days_per_week as number | null | undefined;
  const [parseResponse, extra] = await Promise.all([
    anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `Extract training schedule preferences from the user's message. Respond with ONLY valid JSON, no other text.
${alreadyKnownDays ? `\nALREADY COLLECTED: The athlete already said they want ${alreadyKnownDays} days per week of training. days_per_week is already known — do NOT ask for it again. Only extract which specific days they prefer.\n` : ""}
Output format: {"complete": true|false, "days_per_week": number|null, "training_days": ["monday"|...|"sunday"]|null, "follow_up": string|null}

Rules:
- Normalize all day names to full lowercase
- complete: true whenever you have enough to build a schedule — even if every specific day isn't named
- "Weekdays" alone → complete: true, training_days: ["monday","tuesday","wednesday","thursday","friday"]
- "Weekends" → complete: true, training_days: ["saturday","sunday"]
- A count + day preference is enough: "4 days, prefer Mon/Wed/Fri/Sat" → complete: true, fill in all 4
- "doesn't matter", "no preference", "whatever works", "any days", "any day", "most days", "most days work", "most days are good", "whenever", "whenever I can", "flexible", "I'm flexible", "you pick", "you choose", "up to you", "doesn't matter to me", "no set days" → complete: true. Use a balanced default (e.g. Mon, Wed, Fri, Sun for 4 days; Mon, Wed, Sat for 3 days)
- A count alone (e.g. "3 days", "4 times a week", "maybe 3") is enough — mark complete: true and assign a balanced default for the days
- For a vague range like "3-4 days" with no other info → complete: false, follow_up asks which days work best
- complete: false ONLY if there is truly not enough to infer any schedule at all
- days_per_week: use the number or the midpoint of a range ("3-4" → 4); "maybe 3" or "around 3" → 3${alreadyKnownDays ? `; if days_per_week is already known (${alreadyKnownDays}), always output ${alreadyKnownDays}` : ""}
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
    // Save partial schedule data (days_per_week if extracted) alongside any extra fields.
    // Without this, a second message like "most days work" would cause Haiku to re-ask
    // for days_per_week since it has no memory of the previous "3 days" answer.
    const partialSchedule: Record<string, unknown> = {};
    if (parsed.days_per_week != null) partialSchedule.days_per_week = parsed.days_per_week;
    if (Object.keys(extra).length > 0 || Object.keys(partialSchedule).length > 0) {
      const partialMerge = { ...onboardingData, ...removeNulls(extra), ...partialSchedule };
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

  // Normalize and validate training days — reject any value not in the canonical set
  const VALID_DAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
  const rawDays = parsed.training_days ?? ["tuesday", "thursday", "saturday", "sunday"];
  const trainingDays = rawDays
    .map(d => d.toLowerCase().trim())
    .filter(d => VALID_DAYS.has(d));
  const finalDays = trainingDays.length > 0 ? trainingDays : ["tuesday", "thursday", "saturday", "sunday"];

  // Clamp days_per_week to 1–7 (anything outside is a hallucination)
  const rawDaysPerWeek = parsed.days_per_week ?? finalDays.length;
  const daysPerWeek = Math.max(1, Math.min(7, Math.round(rawDaysPerWeek)));

  // Merge extra fields, then apply the dedicated schedule parse results on top
  const mergedData: Record<string, unknown> = {
    ...onboardingData,
    ...removeNulls(extra),
    days_per_week: daysPerWeek,
    training_days: finalDays,
  };
  const nextStep = findNextStep("awaiting_schedule", mergedData);

  // If transitioning to awaiting_anything_else and user has Strava but no paces yet,
  // look up race history now so the question can reference it.
  let finalData = mergedData;
  if (nextStep === "awaiting_anything_else" && mergedData.strava_connected &&
      !mergedData.recent_race_distance_km && !mergedData.easy_pace) {
    const sbr = await lookupBestStravaRace(user.id);
    if (sbr) finalData = { ...mergedData, strava_best_race: sbr };
  }

  const updatePayload: Record<string, unknown> = { onboarding_step: nextStep, onboarding_data: finalData };
  if (extra.name) updatePayload.name = extra.name;
  await supabase.from("users").update(updatePayload).eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", { step: "days_per_week", days_per_week: daysPerWeek, training_days: trainingDays });

  if (nextStep) {
    // Use a schedule-specific acknowledgment that always references the confirmed days
    // and naturally handles any flexibility caveats the user mentioned.
    const [scheduleAck, nextQuestion] = await Promise.all([
      acknowledgeSchedule(message, trainingDays),
      Promise.resolve(getStepQuestion(nextStep, finalData, user.id)),
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

  let ultraFinalData = merged;
  if (nextStep === "awaiting_anything_else" && merged.strava_connected &&
      !merged.recent_race_distance_km && !merged.easy_pace) {
    const sbr = await lookupBestStravaRace(user.id);
    if (sbr) ultraFinalData = { ...merged, strava_best_race: sbr };
  }

  await supabase.from("users").update({ onboarding_step: nextStep, onboarding_data: ultraFinalData as unknown as Json }).eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", { step: "ultra_background", has_ultra_experience: extracted.has_ultra_experience });

  if (nextStep) {
    const nextQuestion = getStepQuestion(nextStep, ultraFinalData, user.id);
    const reply = acknowledgment ? `${acknowledgment}\n\n${nextQuestion}` : nextQuestion;
    await sendAndStore(user.id, user.phone_number, reply, nextStep);
  } else {
    await completeOnboarding(user, ultraFinalData, chatId);
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

  let injuryFinalData = merged;
  if (nextStep === "awaiting_anything_else" && merged.strava_connected &&
      !merged.recent_race_distance_km && !merged.easy_pace) {
    const sbr = await lookupBestStravaRace(user.id);
    if (sbr) injuryFinalData = { ...merged, strava_best_race: sbr };
  }

  await supabase.from("users").update({ onboarding_step: nextStep, onboarding_data: injuryFinalData as unknown as Json }).eq("id", user.id);

  void trackEvent(user.id, "onboarding_step_completed", { step: "injury_background", can_run_now: extracted.can_run_now });

  if (nextStep) {
    const nextQuestion = getStepQuestion(nextStep, injuryFinalData, user.id);
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

  // Compute paces — priority order:
  // 1. Race time from this message (or earlier in onboarding) → VDOT
  // 2. Easy pace from this message (or earlier) → estimate tempo/interval
  // 3. Strava-suggested race (strava_best_race) → user confirmed or didn't correct it
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
  } else if (onboardingData.strava_best_race) {
    // User didn't provide new pace data — apply the Strava-suggested paces they confirmed (or didn't correct)
    const sbr = onboardingData.strava_best_race as StravaRaceSuggestion;
    merged.easy_pace = sbr.easy_pace;
    merged.tempo_pace = sbr.tempo_pace;
    merged.interval_pace = sbr.interval_pace;
    merged.recent_race_distance_km = sbr.dist_km;
    merged.recent_race_time_minutes = sbr.time_minutes;
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
    // Athlete is done — send a brief holding message so they know something is happening,
    // then kick off plan generation (which can take 30–60 seconds).
    await sendAndStore(user.id, user.phone_number, "Perfect — I've got everything I need. Give me a moment and I'll send over your plan.", "awaiting_anything_else");
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

  const nextStep = findNextStep("awaiting_name", mergedData);
  if (!nextStep) {
    await completeOnboarding(user, mergedData, chatId);
    return NextResponse.json({ ok: true });
  }

  const updatePayload: Record<string, unknown> = { onboarding_step: nextStep, onboarding_data: mergedData };
  if (name) updatePayload.name = name;
  await supabase.from("users").update(updatePayload).eq("id", user.id);

  const question = getStepQuestion(nextStep, mergedData, user.id);
  const nameGreeting = name ? `Nice to meet you, ${name}! ` : "";
  await sendAndStore(user.id, user.phone_number, `${nameGreeting}${question}`, nextStep);
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

/**
 * User messaged back while still in awaiting_payment — re-send the checkout link.
 */
async function handleAwaitingPayment(user: { id: string; phone_number: string; name: string | null }) {
  const { data: userData } = await supabase
    .from("users")
    .select("dashboard_token")
    .eq("id", user.id)
    .single();

  const dashboardToken = userData?.dashboard_token as string | null;
  if (!dashboardToken) {
    return NextResponse.json({ ok: true });
  }

  const firstName = (user.name ?? "").split(" ")[0] || "Hey";
  const checkoutUrl = getCheckoutPageUrl(dashboardToken);
  const message = `${firstName}, your plan is ready and waiting! Start your free 7-day trial here: ${checkoutUrl}`;
  await sendAndStore(user.id, user.phone_number, message, "awaiting_payment");
  return NextResponse.json({ ok: true });
}

async function handleCadence(
  user: { id: string; phone_number: string; name: string | null; onboarding_data: Record<string, unknown> },
  message: string
) {
  // Only trust timezone if the user explicitly confirmed it during awaiting_timezone.
  // Strava-connected alone is no longer sufficient — Strava profile timezone can be stale.
  const timezoneAlreadyConfirmed = !!(user.onboarding_data.timezone_confirmed);

  // Run cadence classification and (when needed) timezone extraction in parallel.
  const [cadenceResponse, parsedTimezone] = await Promise.all([
    anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16,
      system: `The athlete is responding to the question: "Would you like a reminder the morning of each workout, or the evening before? If not, I'll just send you a weekly plan every Sunday."

Classify their reply. Return only one word: "morning", "nightly", "weekly", or "unclear".

- "morning", "day of", "morning of", "same day", "that morning", "morning works", "morning is fine", any specific morning time like "8am", "7am" → morning
- "evening", "night before", "nightly", "the night before", "evening before", "evening works", "night works" → nightly
- "no", "nope", "neither", "no thanks", "just the weekly", "just sunday", "weekly", "sunday", "sunday overview", "weekly plan", "just weekly", "that's fine", "sounds good", "no reminders" → weekly
- Anything that isn't clearly answering the reminder question (e.g. sharing an injury, asking a question, talking about something else) → unclear`,
      messages: [{ role: "user", content: message }],
    }),
    timezoneAlreadyConfirmed ? Promise.resolve(null) : parseTimezoneFromMessage(message),
  ]);

  const raw = cadenceResponse.content[0].type === "text" ? cadenceResponse.content[0].text.trim().toLowerCase() : "weekly";

  // If the message wasn't actually answering the cadence question, classify what it
  // actually is (plan feedback vs coaching question) and respond appropriately.
  if (raw.startsWith("unclear")) {
    return handleNonCadenceMessage(user, message);
  }

  const cadence = raw.startsWith("morning")
    ? "morning_reminders"
    : raw.startsWith("nightly")
      ? "nightly_reminders"
      : "weekly_only";

  // Check if the initial plan was ever sent — if plan generation timed out earlier,
  // re-trigger it instead of referencing a plan the athlete never received.
  const { data: planMessages } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", user.id)
    .eq("message_type", "initial_plan")
    .limit(1);
  const planAlreadySent = (planMessages?.length ?? 0) > 0;

  const userUpdate: Record<string, unknown> = { onboarding_step: null };
  if (!timezoneAlreadyConfirmed && parsedTimezone) {
    userUpdate.timezone = parsedTimezone;
    userUpdate.onboarding_data = { ...user.onboarding_data, timezone_confirmed: true };
  }

  await Promise.all([
    supabase.from("training_profiles").update({ proactive_cadence: cadence }).eq("user_id", user.id),
    supabase.from("users").update(userUpdate).eq("id", user.id),
  ]);

  void trackEvent(user.id, "cadence_preference_set", { cadence });

  if (!planAlreadySent) {
    // Plan generation timed out earlier — send a holding message and re-trigger it.
    await sendAndStore(user.id, user.phone_number, "Got it — and sorry for the delay! Let me get your plan together now.", "awaiting_cadence");
    after(async () => {
      try {
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, trigger: "initial_plan" }),
        });
      } catch (err) {
        console.error("[onboarding] cadence plan re-trigger failed:", err);
      }
    });
    return NextResponse.json({ ok: true });
  }

  const confirmation =
    cadence === "morning_reminders"
      ? "Perfect — I'll remind you the morning of each session. How does the plan look? Let me know if anything needs tweaking."
      : cadence === "nightly_reminders"
        ? "Perfect — I'll send you a heads-up the evening before each session. How does the plan look? Let me know if anything needs tweaking."
        : "Got it — I'll send you a weekly plan every Sunday. How does the plan look? Happy to adjust anything.";

  await sendAndStore(user.id, user.phone_number, confirmation, "awaiting_cadence");
  return NextResponse.json({ ok: true });
}

/**
 * Called when the athlete sends something during awaiting_cadence that doesn't
 * answer the reminder preference question. Handles two important cases:
 *
 * 1. Plan feedback ("I'd like to run less / cycle more") — acknowledge the change,
 *    store the preference in conversation history, and re-trigger initial_plan so
 *    Dean rebuilds the plan. The new plan will include the cadence question again.
 *
 * 2. Coaching question ("Should I run a half before the race?") — answer it
 *    directly, then append the cadence question at the end.
 */
async function handleNonCadenceMessage(
  user: { id: string; phone_number: string; name: string | null },
  message: string
): Promise<NextResponse> {
  const cadenceQuestion = "Last thing — would you like a reminder the morning of each workout, or the evening before? If not, I'll just send you a weekly plan every Sunday.";

  // Classify what the athlete actually sent
  const classifyResponse = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 16,
    system: `The athlete just received their initial training plan and a post-run coaching message, and instead of answering a reminder preference question, sent a different message.

Classify it. Return only one word:
- "plan_feedback" — athlete wants to change the plan (fewer/more runs, different sports, schedule adjustments, volume concerns)
- "run_question" — athlete is asking about their most recent run (e.g. "what did I do?", "tell me more about my run", "what were my splits", "how did I do?", "elaborate on that")
- "coaching_question" — athlete is asking a genuine training or race prep question unrelated to a specific recent run
- "other" — everything else`,
    messages: [{ role: "user", content: message }],
  });

  const msgType = classifyResponse.content[0].type === "text"
    ? classifyResponse.content[0].text.trim().toLowerCase()
    : "other";

  if (msgType.startsWith("plan_feedback")) {
    // Acknowledge the change request, store the exchange in conversation history,
    // then re-trigger initial_plan — Claude will see the user's preference in the
    // conversation context and build a revised plan accordingly.
    const ackResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      system: `You are Coach Dean, an expert running and endurance coach. The athlete just asked to change their training plan. Acknowledge their request enthusiastically and specifically (e.g. confirm the exact change they asked for), and confirm you'll rebuild around those preferences. Keep it to 1-2 short sentences. Do NOT ask any questions.`,
      messages: [{ role: "user", content: message }],
    });

    const ack = ackResponse.content[0].type === "text"
      ? ackResponse.content[0].text.trim()
      : "Absolutely — I'll rebuild your plan around those preferences.";

    // Store the athlete's feedback as a user turn so initial_plan sees it in context
    await supabase.from("conversations").insert({
      user_id: user.id,
      role: "user",
      content: message,
      message_type: "user_message",
    });

    // Send and store the acknowledgment, then re-trigger initial_plan
    await sendAndStore(user.id, user.phone_number, ack, "awaiting_cadence");

    // Re-trigger initial_plan — it will set awaiting_cadence and send a revised plan
    // that incorporates the athlete's feedback from conversation history above.
    void fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, trigger: "initial_plan" }),
    });

    return NextResponse.json({ ok: true });
  }

  if (msgType.startsWith("run_question")) {
    // The athlete is asking about their most recent run. Pull the last few messages
    // (which will include the post_run coaching message with all the activity data)
    // and answer from that context rather than claiming ignorance.
    const { data: recentConvos } = await supabase
      .from("conversations")
      .select("role, content, message_type")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(6);

    const contextMessages = (recentConvos ?? [])
      .reverse()
      .map((c) => ({
        role: c.role as "user" | "assistant",
        content: c.content as string,
      }));

    const answerResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 300,
      system: `You are Coach Dean, an expert running and endurance coach. The athlete just asked about their recent run. You already described it in the conversation above — use that data to answer their question specifically and directly. Do NOT say you don't have access to their run data. After your answer, on a new line, add exactly: "${cadenceQuestion}"`,
      messages: contextMessages.length > 0
        ? [...contextMessages, { role: "user" as const, content: message }]
        : [{ role: "user" as const, content: message }],
    });

    const answer = answerResponse.content[0].type === "text"
      ? answerResponse.content[0].text.trim()
      : cadenceQuestion;

    await sendAndStore(user.id, user.phone_number, answer, "awaiting_cadence");
    return NextResponse.json({ ok: true });
  }

  if (msgType.startsWith("coaching_question")) {
    // Answer the question directly, then re-ask the cadence question at the end.
    const answerResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 300,
      system: `You are Coach Dean, an expert running and endurance coach. Answer the athlete's coaching question directly, concisely, and knowledgeably in 2-4 sentences. Do NOT ask any follow-up questions. After your answer, on a new line, add exactly: "${cadenceQuestion}"`,
      messages: [{ role: "user", content: message }],
    });

    const answer = answerResponse.content[0].type === "text"
      ? answerResponse.content[0].text.trim()
      : cadenceQuestion;

    await sendAndStore(user.id, user.phone_number, answer, "awaiting_cadence");
    return NextResponse.json({ ok: true });
  }

  // Fallback: just re-ask the cadence question
  await sendAndStore(
    user.id,
    user.phone_number,
    "Just one last thing — would you like a reminder the morning of each workout, or the evening before? If not, I'll just send you a weekly plan every Sunday.",
    "awaiting_cadence"
  );
  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Strava race history helpers for pace zone suggestion
// ---------------------------------------------------------------------------

interface StravaRaceSuggestion {
  label: string;
  date_str: string;
  time_str: string;
  dist_km: number;
  time_minutes: number;
  easy_pace: string;
  tempo_pace: string;
  interval_pace: string;
  is_trail?: boolean;
}

/**
 * Scores a list of Strava race activities and returns the best one to use for
 * VDOT estimation. Prefers recent (<6 months), standard-distance (5K–marathon) road
 * races. Excludes ultras (>50km) — their pace doesn't translate to training zones.
 * Returns null if no usable race exists or all are older than 2.5 years.
 */
function selectBestRaceForPacing(
  races: Array<{ distance_meters: number | null; moving_time_seconds: number | null; start_date: string; activity_type?: string | null }>
): { distance_meters: number; moving_time_seconds: number; start_date: string; is_trail: boolean } | null {
  const now = Date.now();
  const STANDARD_KM = [5, 10, 15, 21.097, 42.195]; // 5K, 10K, 15K, half, marathon

  const scored = races
    .filter(r =>
      r.distance_meters != null && r.moving_time_seconds != null &&
      r.distance_meters >= 1500 && r.distance_meters <= 50000
    )
    .map(r => {
      const daysAgo = (now - new Date(r.start_date).getTime()) / (1000 * 60 * 60 * 24);
      if (daysAgo > 900) return null; // older than 2.5 years — too stale
      const recencyScore = daysAgo < 180 ? 3 : daysAgo < 365 ? 2 : 1;
      const distKm = r.distance_meters! / 1000;
      const isStandard = STANDARD_KM.some(d => Math.abs(distKm - d) / d <= 0.03);
      const distScore = isStandard ? 2 : 1;
      // Trail races run slower due to terrain — deprioritize for VDOT estimation.
      // A trail 10K at 60min doesn't map to road training zones the same way.
      const isTrail = r.activity_type === "TrailRun";
      const trailPenalty = isTrail ? 0.5 : 1;
      return { race: r, score: recencyScore * distScore * trailPenalty, isTrail };
    })
    .filter((x): x is { race: typeof races[number]; score: number; isTrail: boolean } => x !== null)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;
  return {
    distance_meters: best.race.distance_meters!,
    moving_time_seconds: best.race.moving_time_seconds!,
    start_date: best.race.start_date,
    is_trail: best.isTrail,
  };
}

/**
 * Queries the user's Strava activity history for races and returns a structured
 * suggestion (label, display time, computed VDOT paces) ready to show in onboarding.
 * Returns null if no usable race found.
 */
async function lookupBestStravaRace(userId: string): Promise<StravaRaceSuggestion | null> {
  const [{ data: races }, { data: profile }] = await Promise.all([
    supabase
      .from("activities")
      .select("distance_meters, moving_time_seconds, start_date, activity_type")
      .eq("user_id", userId)
      .eq("workout_type", 1)
      .order("start_date", { ascending: false })
      .limit(20),
    supabase
      .from("training_profiles")
      .select("preferred_units")
      .eq("user_id", userId)
      .single(),
  ]);

  const best = selectBestRaceForPacing((races || []).filter((r): r is typeof r & { start_date: string } => r.start_date != null));
  if (!best) return null;

  const preferredUnits = (profile?.preferred_units as "imperial" | "metric" | null) ?? "imperial";
  const distKm = best.distance_meters / 1000;
  const timeMin = best.moving_time_seconds / 60;
  const paces = calculateVDOTPaces(distKm, timeMin);
  const label = formatRaceDistance(best.distance_meters, preferredUnits);

  const dateStr = new Date(best.start_date).toLocaleDateString("en-US", {
    month: "short", year: "numeric", timeZone: "UTC",
  });

  const totalSec = best.moving_time_seconds;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const timeStr = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;

  return {
    label,
    date_str: dateStr,
    time_str: timeStr,
    dist_km: distKm,
    time_minutes: timeMin,
    easy_pace: paces.easy,
    tempo_pace: paces.tempo,
    interval_pace: paces.interval,
    is_trail: best.is_trail,
  };
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
    "mile": 1.0, "5k": 3.107, "10k": 6.214, "half_marathon": 13.109, "marathon": 26.219,
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

  // Check if billing is enabled for this user. If so, gate on payment before firing initial_plan.
  const { data: billingUser } = await supabase
    .from("users")
    .select("billing_enabled, dashboard_token, phone_number")
    .eq("id", user.id)
    .single();

  const billingEnabled = !!(billingUser?.billing_enabled);

  const userUpdatePayload: Record<string, unknown> = {
    onboarding_data: data as unknown as Json,
  };
  if (name) userUpdatePayload.name = name;

  if (billingEnabled) {
    // Pause at awaiting_payment — initial_plan fires from the Stripe webhook after checkout.
    // Generate a dashboard_token now if one doesn't exist yet (needed for the checkout URL).
    let dashboardToken = billingUser?.dashboard_token as string | null;
    if (!dashboardToken) {
      dashboardToken = crypto.randomUUID();
      userUpdatePayload.dashboard_token = dashboardToken;
    }
    userUpdatePayload.onboarding_step = "awaiting_payment";
    userUpdatePayload.payment_link_sent_at = new Date().toISOString();
  } else {
    userUpdatePayload.onboarding_step = null;
  }

  const userResult = await supabase
    .from("users")
    .update(userUpdatePayload)
    .eq("id", user.id);

  if (userResult.error) console.error("[onboarding] users update failed:", userResult.error);

  // Write all races (A + any B/C) to the races table.
  // Delete first so re-onboarding or plan resets don't accumulate duplicates.
  if (raceDate && goal) {
    await supabase.from("races").delete().eq("user_id", user.id);

    const racesToInsert = [
      // A race — always from the primary goal
      {
        user_id: user.id,
        race_date: raceDate,
        race_name: (data.race_name as string | null) ?? null,
        goal,
        priority: "A" as const,
        goal_time_minutes: (data.goal_time_minutes as number | null) ?? null,
        goal_distance_miles: goalDistanceMiles,
      },
      // B/C races captured in awaiting_other_races.
      // Only require a date — goal may be null for named races where Haiku couldn't
      // infer the distance; fall back to the A race's goal as a reasonable default.
      ...((data.other_races as Array<{ date: string; name: string | null; goal: string | null; priority: "B" | "C" }> | null) ?? [])
        .filter(r => r.date)
        .map(r => ({
          user_id: user.id,
          race_date: r.date,
          race_name: r.name ?? null,
          goal: r.goal ?? goal,
          priority: r.priority,
          goal_time_minutes: null,
          goal_distance_miles: null,
        })),
    ];

    const { error: racesError } = await supabase.from("races").insert(racesToInsert);
    if (racesError) console.error("[onboarding] races insert failed:", racesError);
  }

  if (billingEnabled) {
    // Send payment link SMS — initial_plan fires from Stripe webhook after checkout.
    const dashboardToken = (userUpdatePayload.dashboard_token as string | null)
      ?? (billingUser?.dashboard_token as string | null);
    if (dashboardToken) {
      const firstName = (name ?? "").split(" ")[0] || "Hey";
      const trialEndDate = new Date();
      trialEndDate.setDate(trialEndDate.getDate() + 7);
      const trialEndFormatted = trialEndDate.toLocaleDateString("en-US", { month: "long", day: "numeric" });
      const checkoutUrl = getCheckoutPageUrl(dashboardToken);
      const sms = `${firstName}, your plan is ready! Start your free 7-day trial to unlock it — no charge until ${trialEndFormatted}:\n\n${checkoutUrl}`;
      const phoneNumber = billingUser?.phone_number as string;
      await sendAndStore(user.id, phoneNumber, sms, "awaiting_payment");
    }
    void trackEvent(user.id, "onboarding_completed", { goal, billing_gate: true });
    return;
  }

  // No wrap-up SMS — the initial_plan IS the response, addressed by name.
  const isDryRun = dryRunUsers.has(user.id);
  if (isDryRun) {
    // dry_run: call coach/respond inline with dry_run=true, then store result ourselves
    // so the test runner can read it from conversations.
    try {
      await trackEvent(user.id, "onboarding_completed", { goal });
      const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, trigger: "initial_plan", dry_run: true }),
      });
      const { message } = (await res.json()) as { message?: string };
      if (message) {
        for (const part of message.split(/\n\n+/).filter(Boolean)) {
          await supabase.from("conversations").insert({
            user_id: user.id,
            role: "assistant",
            content: part,
            message_type: "initial_plan",
          });
        }
      }
    } catch (err) {
      console.error("[onboarding] dry_run coach trigger failed:", err);
    }
  } else {
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
  "awaiting_name",                // ask for name if not yet captured — first thing after goal
  "awaiting_race_date",
  "awaiting_other_races",         // confirm A race + capture any B/C races; skipped for non-race goals
  "awaiting_goal_time",           // only shown for race goals (not general fitness or ultras)
  "awaiting_strava",              // offer Strava connect; satisfied once strava_connected=true or user skips
  "awaiting_schedule",
  "awaiting_mileage_baseline",    // only for non-Strava users who haven't mentioned mileage yet
  "awaiting_ultra_background",    // only shown for 50K+ goals
  "awaiting_injury_background",   // only shown for injury_recovery goals
  "awaiting_anything_else",
  "awaiting_timezone",            // confirm city/timezone before plan fires; skipped once timezone_confirmed=true
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
      // Skip date confirmation when multiple races were mentioned — ask which is the A race first
      // (awaiting_other_races). After that step confirms the A race, we loop back here.
      if (data.secondary_goal) return true;
      // Must be explicitly confirmed by the user (race_date_confirmed: true).
      // Web-search-prefilled dates do NOT satisfy this — we still ask so the user
      // can correct an inaccurate web search result (e.g. wrong year, wrong event date).
      return !!data.race_date_confirmed;
    case "awaiting_other_races":
      // Skip for non-race goals — no primary race to compare against
      if (data.goal === "general_fitness" || data.goal === "return_to_running" || data.goal === "injury_recovery") return true;
      // Skip if no race date confirmed (can't ask about "other races" without a primary)
      if (!data.race_date) return true;
      // Satisfied once the user has explicitly answered this question
      return !!data.other_races_answered;
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
      // For non-Strava ultra athletes, always ask — it's a critical context question.
      // We avoid data-based skipping here because the extractor can pick up experience_years or
      // ultra_race_history from non-race context (e.g. "5 years of lottery attempts") and
      // incorrectly satisfy the step before the athlete has actually described their background.
      return false;
    case "awaiting_injury_background":
      // Only relevant for injury_recovery goals — skip entirely for everything else.
      if (data.goal !== "injury_recovery") return true;
      // Satisfied once we have injury notes captured.
      return !!(data.injury_notes);
    case "awaiting_timezone":
      // Skip once the user has explicitly confirmed their city/timezone.
      // Strava-provided timezone is NOT treated as confirmed — Strava profile timezone
      // can be stale (e.g. set years ago when the user lived somewhere else).
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
    case "awaiting_other_races": {
      const raceName = data.race_name as string | null;
      const raceGoal = data.goal as string | null;
      const raceRef = raceName ? `the ${raceName}` : raceGoal ? `your ${formatGoalInline(raceGoal)}` : "your race";
      // When we already know about multiple races, ask which is the A race without asking "do you have any others?"
      if (data.secondary_goal) {
        // Combined A race + date question. Don't show a pre-filled date here — the goal
        // classifier and the web search can pick different races as "primary", so the
        // date could be misattributed to the wrong race name. Ask for all dates together.
        return `Which of these is your A race — the one the whole plan peaks for? And can you give me the dates for each? Approximate is totally fine.`;
      }
      return `Is ${raceRef} your main goal race this season — the one we're building the whole plan around? And do you have any others on the calendar I should know about?`;
    }

    case "awaiting_goal_time": {
      const raceName = data.race_name as string | null;
      const raceRef = raceName ? `the ${raceName}` : "the race";
      return `Do you have a time goal for ${raceRef}, or is it more about finishing strong and building your base? Either's totally valid — just helps me dial in the right pacing.`;
    }

    case "awaiting_strava": {
      const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${userId || ""}`;
      return `Before I put your plan together — do you use Strava? If you connect it, I can pull in your training history and build something much sharper from day 1.\n\n${stravaUrl}\n\nNo Strava? Just reply "skip".`;
    }

    case "awaiting_race_date": {
      if (data.goal === "general_fitness") {
        return "Do you have a target event or date in mind? If not, just say 'no event' and we'll keep the plan open-ended.";
      }
      // Web search pre-filled a date — confirm it with the user rather than assuming it's correct
      const prefillDate = data.race_date as string | null;
      if (prefillDate) {
        const formatted = new Date(prefillDate + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
        const raceName = data.race_name as string | null;
        const raceLabel = raceName ? `the ${raceName}` : "the race";
        return `Looks like ${raceLabel} is on ${formatted} — does that match your registration? Just confirm or give me the correct date.`;
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

    case "awaiting_anything_else": {
      const sbr = data.strava_best_race as StravaRaceSuggestion | null | undefined;
      if (sbr) {
        const easyRange = easyPaceRange(sbr.easy_pace);
        const trailCaveat = sbr.is_trail
          ? " (heads up: this looks like a trail race — trail paces run slower than road, so your road training zones may be a bit faster than this suggests. If you have a road race time, share it and I'll use that instead.)"
          : "";
        return `Almost there! I spotted your ${sbr.label} from ${sbr.date_str} (${sbr.time_str}) in your Strava — I'd set your easy training pace at ${easyRange}${trailCaveat}. Does that work? If your fitness has changed, share a more recent race time or easy pace. Anything else to add (injuries, cross-training, target time)?`;
      }
      // Strava connected but no races found — ask explicitly for a PR or easy pace
      if (data.strava_connected && !data.recent_race_distance_km && !data.easy_pace) {
        return "Almost there! I don't see any race results in your Strava yet. Do you have a recent race time (5K, 10K, half, marathon) or comfortable easy pace I can use to set your training zones? If not, just say nope and I'll estimate from your mileage.";
      }
      // No Strava, race goal, no pace data yet — ask directly for a PR or easy pace
      const NON_PACE_GOALS = ["general_fitness", "return_to_running", "injury_recovery", "cycling"];
      const hasRaceGoal = data.goal && !NON_PACE_GOALS.includes(data.goal as string);
      if (!data.strava_connected && hasRaceGoal && !data.recent_race_distance_km && !data.easy_pace) {
        return "Almost there! Do you have a recent race time — 5K, 10K, half, marathon — or a comfortable easy pace I can use to set your training zones? If not, just say nope and I'll estimate from your mileage.";
      }
      return "Almost there — anything else before I put this together? Target paces, cross-training, strength work — mention it now and I'll build it in. If not, just say nope!";
    }

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
  /** Actual race distance in miles as found by web search (e.g. 7.4 for Dipsea) */
  distanceMiles: number | null;
  /** Secondary goal mentioned alongside the primary (e.g. "100K this summer") */
  secondaryGoal: string | null;
}

/**
 * Generate a short natural acknowledgment of a training constraint or context
 * (e.g. stroller running, night shifts, bad knees) to weave into the goal response.
 */
async function generateConstraintAcknowledgment(otherNotes: string, goalLabel: string): Promise<string | null> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      system: `You are Coach Dean, an AI running coach. The athlete mentioned a training constraint or context alongside their goal. Write ONE short sentence (max 15 words) acknowledging it warmly and naturally — sound like a real coach, not a system confirming a data entry. No markdown, no asterisks.`,
      messages: [{ role: "user", content: `Goal: ${goalLabel}. Context they mentioned: ${otherNotes}` }],
    });
    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    return text || null;
  } catch {
    return null;
  }
}

async function generateRaceAcknowledgment(message: string): Promise<RaceInfo> {
  const empty: RaceInfo = { ack: null, raceDate: null, distanceOptions: null, distanceMiles: null, secondaryGoal: null };
  const timeout = new Promise<RaceInfo>((resolve) => setTimeout(() => resolve(empty), 15000));
  try {
    const today = new Date().toISOString().split("T")[0];
    const responsePromise = anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 400,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      system: `You help a running coach respond warmly to an athlete who just shared their goal. Today is ${today}.

If the message mentions a specific named race or event, search for it to get accurate course facts.

IMPORTANT — Multi-distance races:
If the race offers multiple distance options (e.g. 10K, 30K, 50K, 50 miles) AND the athlete hasn't specified which distance they're doing, do NOT guess. Instead output:
{"ack": "<1-2 sentence acknowledgment of the race without assuming distance>", "date": "YYYY-MM-DD" | null, "distance_options": ["10K", "30K", "50K", "50 miles"]}
The "ack" in this case should mention the race name and terrain/character but NOT a specific distance.

IMPORTANT — Multi-race messages: When an athlete mentions several races, identify their PRIMARY goal (usually the one mentioned first, or the one they say is their "main objective", "A race", or the most important event). All fields below refer to that primary race only. CRITICAL: if the athlete mentioned a specific month or season for the primary race (e.g. "Dipsea in June"), the date you return MUST fall in that month/season. Do NOT return a date from a secondary race. If you can't find a date for the primary race that matches what the athlete said, return null for date.

If the race has only one distance, or the athlete clearly stated their distance:
Write a conversational 1-3 sentence acknowledgment ("ack") that:
- Mentions the race naturally with real course facts (distance, elevation, terrain) — not like a Wikipedia entry, more like "Behind the Rocks looks like a great one — 18 miles of slickrock with ~1,800ft of climbing"
- If secondary races were mentioned, briefly acknowledge them — but DO NOT frame them as "leading into" or "building towards" the primary race. We don't yet know which is the A race, so don't imply a hierarchy. Just note them naturally: "You've also got Sierre Zinal and A Basin on the calendar" or similar.
- If the race is within 8 weeks of today, acknowledge the timeline naturally ("not a ton of runway, but totally doable" / "only X weeks out, so we'll keep it focused")
- Tone: warm, direct, like a coach texting — no "Love it!" opener, no asterisks, no markdown
- 2-3 sentences max, under 280 chars
Output: {"ack": "...", "date": "YYYY-MM-DD" | null, "distance_options": null, "distance_miles": number | null, "secondary_goal": "brief description" | null}
- distance_miles: the PRIMARY race's actual distance in miles. null for standard distances like exact 5K, 10K, half, marathon, 50K, 100K, 100mi where the bucket label is accurate enough. Set this only when the primary race has a non-standard or unusual distance (e.g. Dipsea = 7.4mi, a 25K = 15.53mi). CRITICAL: if the athlete mentions multiple races and their primary goal is a standard distance (e.g. 100K, 50K, marathon), return distance_miles: null — do NOT return the distance of a secondary race.
- secondary_goal: if the athlete clearly mentions a second race/event/goal beyond the primary one (e.g. "and then a 100K this summer", "plus Boston next year"), capture it as a short plain-text description. null if none.

CRITICAL RULES:
- Do NOT narrate your search process. Output nothing until you have the final JSON answer.
- Your ENTIRE response must be that JSON object (or the word null). Never output intermediate thoughts.
- If results are ambiguous or conflicting, set "ack" to null.
- Only include "date" if you find a specific confirmed upcoming date from a reliable source — do not guess or infer from relative expressions like "5 months from now".
- Never include timeline or countdown language ("X weeks out", "not much runway", "plenty of time") in the ack unless you set a confirmed "date" from web search — if you don't know the date, don't reference the timeline.
- For distance_options: ONLY list distinct, officially separate entry categories (e.g. a race that lets athletes register for a 10K OR a 50K as separate events). Do NOT list measurement variants of the same course — if one source says "7.46 miles" and another says "12K", that is the SAME course measured in different units, not two different options. distance_options must be null for any race where all participants run the same course. When uncertain, set distance_options: null. NOTE: a Vertical Kilometer (VK) is always a completely separate race from a longer trail distance (e.g. 31K, 50K) even if offered at the same event — always list them as separate distance_options.
- NEVER assume a specific distance in the ack when the athlete hasn't stated which distance they're doing. If the race has multiple options and the athlete hasn't specified, the ack must not mention any distance.
- If no specific named event is mentioned (just generic categories), return only: null`,
      messages: [{ role: "user", content: message }],
    });
    const result = await Promise.race([responsePromise.then(r => ({ ok: true as const, r })), timeout.then(() => ({ ok: false as const }))]);
    if (!result.ok) {
      console.warn("[onboarding] generateRaceAcknowledgment timed out after 15s, using empty ack");
      return empty;
    }
    const response = result.r;

    // Only take the LAST text block — intermediate blocks are Claude's between-search narration.
    const textBlocks = response.content.filter(b => b.type === "text");
    const lastBlock = textBlocks[textBlocks.length - 1];
    const text = lastBlock?.type === "text" ? lastBlock.text.trim() : "";

    if (!text || text.toLowerCase() === "null") return empty;

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      // Parse a km value from a distance string like "12K", "50 miles", "50K", "10 km"
      const parseKm = (s: string): number | null => {
        const m = s.match(/(\d+(?:\.\d+)?)\s*(mi(?:les?)?|km?)?/i);
        if (!m) return null;
        const n = parseFloat(m[1]);
        const unit = (m[2] || "k").toLowerCase();
        return unit.startsWith("mi") ? n * 1.609 : n;
      };
      // Only keep distanceOptions if there are 2+ entries AND they differ by ≥30% in distance.
      // This filters out confabulated variants of the same course (e.g. "12K" vs "15K" for Bay to Breakers).
      const rawOptions = Array.isArray(parsed?.distance_options) && parsed.distance_options.length > 1
        ? parsed.distance_options as string[]
        : null;
      const distanceOptions = rawOptions ? (() => {
        const kms = rawOptions.map(parseKm).filter((d): d is number => d != null);
        if (kms.length >= 2) {
          const min = Math.min(...kms);
          const max = Math.max(...kms);
          if (max / min < 1.3) return null; // too similar — likely confabulation or unit variants
        }
        return rawOptions;
      })() : null;
      const secondaryGoal = (typeof parsed?.secondary_goal === "string" && parsed.secondary_goal) ? parsed.secondary_goal : null;
      const rawAck = parsed?.ack ?? null;
      const ack = rawAck ? rawAck.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, "$1").replace(/<cite[^>]*\/>/g, "").trim() : null;
      // Validate raceDate is actually in the future — discard if in the past (hallucinated date)
      let raceDate = parsed?.date ?? null;
      if (raceDate && raceDate < today) raceDate = null;
      const distanceMiles = (typeof parsed?.distance_miles === "number" && parsed.distance_miles > 0)
        ? parsed.distance_miles
        : null;
      return { ack, raceDate, distanceOptions, distanceMiles, secondaryGoal };
    } catch {
      // Fallback: treat as plain-text ack if JSON parse fails
      const cleanText = text.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, "$1").replace(/<cite[^>]*\/>/g, "").trim();
      return { ack: cleanText, raceDate: null, distanceOptions: null, distanceMiles: null, secondaryGoal: null };
    }
  } catch {
    return empty;
  }
}

/**
 * Looks up a race's date via web search. Used when the A race is promoted mid-onboarding
 * and we don't yet have a confirmed date for the new primary race.
 */
async function lookupRaceDate(raceName: string): Promise<string | null> {
  const today = new Date().toISOString().split("T")[0];
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 12000));
  try {
    const responsePromise = anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
      system: `Search for the next upcoming date of the "${raceName}" race. Today is ${today}.
Output ONLY a JSON object: {"date": "YYYY-MM-DD"} if you find a confirmed future date, or {"date": null} if not found.
Do NOT output anything else — no explanation, no markdown.`,
      messages: [{ role: "user", content: raceName }],
    });
    const result = await Promise.race([responsePromise.then(r => ({ ok: true as const, r })), timeout.then(() => ({ ok: false as const }))]);
    if (!result.ok) return null;
    const textBlocks = result.r.content.filter(b => b.type === "text");
    const last = textBlocks[textBlocks.length - 1];
    const text = last?.type === "text" ? last.text.trim() : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const date = typeof parsed?.date === "string" ? parsed.date : null;
    return date && date > today ? date : null;
  } catch {
    return null;
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
{"race_date": "YYYY-MM-DD" | null, "race_month": "Month" | null, "experience_years": number | null, "weekly_miles": number | null, "easy_pace": "M:SS" | null, "recent_race_distance_km": number | null, "recent_race_time_minutes": number | null, "pr_year": number | null, "injury_mentioned": boolean, "injury_notes": string | null, "crosstraining_tools": string[] | null, "other_notes": string | null, "name": "FirstName" | null, "secondary_goal": string | null, "goal_time_minutes": number, "ultra_race_history": string | null}

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
- other_notes: any other training-relevant context not captured above — strengthening preferences, target times, lifestyle constraints, stroller running, etc. null if nothing else.
- secondary_goal: if the athlete mentions a second distinct race or goal beyond the primary one (e.g. "and then a marathon in the fall", "plus Boston next year", "also want to do a crit series"). Short plain-text description. null if only one goal is mentioned.
- goal_time_minutes: ONLY include this field if the athlete EXPLICITLY states a specific finish-time goal (e.g. "sub 3:05" → 185, "under 2 hours" → 120, "1:55" → 115, "around 23 minutes" → 23). Convert to total minutes as a number. OMIT THIS FIELD ENTIRELY if no specific finish time is mentioned — do NOT set it to null. Never infer a time goal that wasn't explicitly stated.
- ultra_race_history: if the athlete explicitly describes their trail or ultra race background (e.g. "done two 100Ks", "finished a 50-miler last year", "ran Western States in 2022", "completed three 50Ks"). Short plain-text summary. null if not mentioned. IMPORTANT: do NOT set this from lottery attempts, general hiking, or non-race experience — it must describe actual races completed.
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
    if (typeof parsed.goal_time_minutes === "number") result.goal_time_minutes = parsed.goal_time_minutes;
    if (parsed.ultra_race_history != null) result.ultra_race_history = parsed.ultra_race_history;
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
- other_notes: any other relevant info not captured above (target time goals, lifestyle constraints, stroller running, etc.)
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

Return only the word: null if the message is a truly bare answer with no extra context — e.g. just a date, a number, "nope", "no", "I'm good", "Skip", "Yes", "Yeah that's right", or a race name with a date ("Sierre Zinal is on August 8th").

CRITICAL: Do NOT use your knowledge of races, events, or places to characterize them (e.g. do not say "legendary vertical kilometer" or "iconic trail race"). Only reflect what the athlete explicitly said about themselves, their feelings, or their personal context.

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
  const raceName = onboardingData.race_name as string | null;
  const goalDistanceMiles = onboardingData.goal_distance_miles as number | null;
  // Intentionally omit the raw race_date — passing "2025-10-19" caused Dean to hallucinate
  // a wrong date ("October 1st") in conversational responses.
  // Prefer the specific race name + distance over the generic bucket label when available.
  const context = raceName
    ? `The athlete is training for the ${raceName}${goalDistanceMiles ? ` (${goalDistanceMiles} miles)` : ""}.`
    : goal
    ? `The athlete is training for a ${formatGoalInline(goal)}.`
    : "The athlete is in the process of setting up their training plan.";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
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

IMPORTANT: Do NOT ask follow-up questions. Do NOT request more information from the athlete. If you would need to ask a question to answer properly, just return {"no_question": true} instead.

If there is no question — just goal-setting, background info, or race/training context — return only: {"no_question": true}`,
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
  message: string,
  userId: string
): Promise<{ offTopic: false } | { offTopic: true; response: string }> {
  const stepContext: Record<string, { topic: string; reAsk: string }> = {
    awaiting_race_date:       { topic: "their race date or target event",                                reAsk: "When is your race?" },
    awaiting_other_races:     { topic: "whether they have other goal races this season",                 reAsk: "Any other races on the calendar this season?" },
    awaiting_schedule:        { topic: "their weekly training schedule and availability",                reAsk: "How many days a week are you looking to train?" },
    awaiting_mileage_baseline:{ topic: "their current weekly running mileage",                          reAsk: "Roughly how many miles a week are you running right now?" },
    awaiting_ultra_background:{ topic: "their ultra running background and previous race experience",    reAsk: "What's your ultra background — any previous ultras or long efforts?" },
    awaiting_injury_background:{ topic: "their injury history and current physical status",             reAsk: "Can you tell me more about where things stand with the injury right now?" },
    awaiting_goal_time:       { topic: "their finish time goal for the race (or whether they have one)", reAsk: "Do you have a time goal in mind, or are you focused on finishing?" },
    awaiting_timezone:        { topic: "what city or timezone they're in",                              reAsk: "What city or state are you in?" },
    awaiting_cadence:         { topic: "whether they want morning-of reminders, evening-before reminders, or just a weekly Sunday plan", reAsk: "Would you like a reminder the morning of each workout, or the evening before? If not, I'll just send you a weekly plan every Sunday." },
  };

  const ctx = stepContext[step];
  if (!ctx) return { offTopic: false };

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    system: `You are Coach Dean, an AI running coach onboarding a new athlete via SMS. You are currently collecting information about ${ctx.topic}.

Read the athlete's message and decide: is it ATTEMPTING to address the topic (even partially, vaguely, or incompletely), or is it COMPLETELY UNRELATED?

Always respond with valid JSON in exactly one of these formats:
On-topic: {"on_topic": true}
Off-topic coaching question: {"on_topic": false, "type": "coaching_question"}
Other off-topic: {"on_topic": false, "type": "other", "response": "Your warm 1-sentence reply + re-ask. No markdown, no asterisks."}

ON-TOPIC ({"on_topic": true}):
- Any answer to the question, even partial or brief
- Saying they don't know, aren't sure, or don't have the info
- Simple acknowledgments like "yeah", "not really", "not sure"
- Anything that touches on the subject even loosely
- Comments about fitness level, training history, or running experience
- Pushback on training volume, intensity, or plan structure
- Requests to adjust the plan based on their experience

OFF-TOPIC run question ({"on_topic": false, "type": "run_question"}):
- Asking about a recent run ("what did I do?", "tell me about my run", "what were my splits", "how did I do?", "elaborate on that")
- Any question clearly referencing a specific run they just completed

OFF-TOPIC coaching question ({"on_topic": false, "type": "coaching_question"}):
- Questions about training methodology, race prep, pacing, nutrition, gear
- Questions about Dean's services or capabilities ("do you coach cycling?")
- Any genuine advice-seeking question unrelated to the current topic and not about a specific recent run

Other off-topic ({"on_topic": false, "type": "other", "response": "..."}):
- Meta-questions about the onboarding process ("how many more questions?", "how long does this take?")
- Random chit-chat with no relation to running or training`,
    messages: [{ role: "user", content: message }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text.trim() : "";

  try {
    const parsed = JSON.parse(extractJSON(text));
    if (parsed.on_topic === true) return { offTopic: false };

    if (parsed.on_topic === false) {
      if (parsed.type === "run_question") {
        // Answer using recent conversation context (includes the post_run message with activity data)
        const { data: recentConvos } = await supabase
          .from("conversations")
          .select("role, content")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(6);
        const contextMessages = (recentConvos ?? [])
          .reverse()
          .map((c) => ({ role: c.role as "user" | "assistant", content: c.content as string }));
        const answerResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 300,
          system: `You are Coach Dean, an expert running and endurance coach. The athlete is asking about their recent run. You already described it in the conversation above — use that data to answer specifically and directly. Do NOT say you don't have access to their run data. Plain text only — no markdown, no asterisks. After your answer, on a new line, add: "${ctx.reAsk}"`,
          messages: contextMessages.length > 0
            ? [...contextMessages, { role: "user" as const, content: message }]
            : [{ role: "user" as const, content: message }],
        });
        const answer = answerResponse.content[0].type === "text"
          ? answerResponse.content[0].text.trim()
          : ctx.reAsk;
        return { offTopic: true, response: answer };
      }

      if (parsed.type === "coaching_question") {
        // Generate a real coaching answer with Sonnet, then re-ask the current step question
        const answerResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 300,
          system: `You are Coach Dean, an expert running and endurance coach. Answer the athlete's question directly and knowledgeably in 2-4 sentences. Plain text only — no markdown, no asterisks. After your answer, on a new line, add: "${ctx.reAsk}"`,
          messages: [{ role: "user", content: message }],
        });
        const answer = answerResponse.content[0].type === "text"
          ? answerResponse.content[0].text.trim()
          : ctx.reAsk;
        return { offTopic: true, response: answer };
      }

      if (typeof parsed.response === "string" && parsed.response.trim()) {
        return { offTopic: true, response: parsed.response.trim() };
      }
    }

    // Malformed JSON — safe default: treat as on-topic so we never silently drop a message
    return { offTopic: false };
  } catch {
    // Not valid JSON — safe default
    return { offTopic: false };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function sendAndStore(userId: string, phone: string, message: string, step?: string): Promise<{ chatId: string | null }> {
  // Safety guard: never deliver raw JSON to the athlete. If a classification
  // response was mis-routed as the reply text, block it here rather than
  // exposing internal payloads. Log for monitoring.
  if (/^\s*\{/.test(message)) {
    console.error("[onboarding/sendAndStore] blocked JSON-starting message:", message.slice(0, 120), "step:", step);
    return { chatId: null };
  }
  // dry_run: store in conversations for test inspection but skip actual SMS send
  if (dryRunUsers.has(userId)) {
    await supabase.from("conversations").insert({
      user_id: userId,
      role: "assistant",
      content: message,
      message_type: "coach_response",
    });
    return { chatId: null };
  }
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

const VALID_GOAL_BUCKETS = new Set([
  "mile", "5k", "10k", "half_marathon", "marathon", "30k", "50k", "50mi", "100k", "100mi",
  "sprint_tri", "olympic_tri", "70.3", "ironman", "cycling",
  "general_fitness", "return_to_running", "injury_recovery",
]);

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
    mile: "mile time trial",
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
