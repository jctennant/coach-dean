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
 *   → awaiting_experience
 *   → awaiting_pacing            (race time / best effort → VDOT paces)
 *     → awaiting_conversational_pace  (fallback if no race data)
 *   → awaiting_crosstraining
 *   → awaiting_schedule          (days per week + preferred days)
 *   → awaiting_preferences       (nightly reminder cadence)
 *   → null (complete)
 *
 * Each step that expects multiple pieces of information checks for completeness
 * before advancing. If the user's answer is partial, Dean acknowledges what was
 * shared and asks specifically for the missing piece — staying on the same step.
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
  // For all other steps: only intercept messages that are CLEARLY unrelated (questions about
  // Dean's services, chit-chat, etc.). Partial answers pass through to the step handler
  // which has its own completeness logic.
  if (step && step !== "awaiting_goal") {
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
    case "awaiting_experience":
      return handleExperience(user, message, onboardingData);
    case "awaiting_injury":
      return handleInjury(user, message, onboardingData);
    case "awaiting_pacing":
      return handlePacing(user, message, onboardingData);
    case "awaiting_conversational_pace":
      return handleConversationalPace(user, message, onboardingData);
    case "awaiting_crosstraining":
      return handleCrossTraining(user, message, onboardingData);
    case "awaiting_schedule":
      return handleSchedule(user, message, onboardingData);
    case "awaiting_preferences":
      return handlePreferences(user, message, onboardingData);
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

async function handleExperience(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const sport = (onboardingData.sport_type as string) || "running";
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: `Extract training experience and weekly volume from the user's message. The athlete is training for a ${sport} goal. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "experience_years": number|null, "weekly_miles": number|null, "weekly_hours": number|null, "injury_mentioned": boolean, "follow_up": string|null}

Rules:
- complete: true only if BOTH experience duration AND some training volume are clearly stated or strongly implied
- experience_years: how long they've been training in this sport. "a few months" → 0.3, "about a year" → 1, "5+ years" → 5
- weekly_miles: weekly running/cycling miles (convert km if needed, 1km = 0.621mi). For cyclists use riding miles.
- weekly_hours: total weekly training hours across all disciplines. Use this for triathletes or when volume is given in hours.
- At least one of weekly_miles or weekly_hours should be set when complete is true.
- injury_mentioned: true if any injury, pain, or physical limitation is mentioned
- follow_up: short natural message acknowledging what was shared and asking for the missing piece
- If complete is true, follow_up must be null`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] experience raw response:", parseText);

  let parsed: {
    complete: boolean;
    experience_years: number | null;
    weekly_miles: number | null;
    weekly_hours: number | null;
    injury_mentioned: boolean;
    follow_up: string | null;
  } = { complete: false, experience_years: null, weekly_miles: null, weekly_hours: null, injury_mentioned: false, follow_up: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] experience parse failed:", e);
  }

  if (!parsed.complete) {
    const followUp =
      parsed.follow_up ||
      "Got part of that! Could you share both how long you've been running and roughly how many miles (or km) per week you're doing?";
    await sendAndStore(user.id, user.phone_number, followUp);
    return NextResponse.json({ ok: true });
  }

  const updatedData: Record<string, unknown> = {
    ...onboardingData,
    experience_years: parsed.experience_years ?? 1,
    weekly_miles: parsed.weekly_miles ?? null,
    ...(parsed.weekly_hours != null ? { weekly_hours: parsed.weekly_hours } : {}),
  };

  const nextStep = findNextStep("awaiting_experience", updatedData);

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: updatedData })
    .eq("id", user.id);

  if (nextStep) await sendAndStore(user.id, user.phone_number, getStepQuestion(nextStep, updatedData));
  return NextResponse.json({ ok: true });
}

async function handleInjury(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 128,
    system: `Summarize an athlete's injury situation from their message. Respond with ONLY valid JSON, no other text.

Output format: {"injury_type": string|null, "notes": string}

Rules:
- injury_type: brief label (e.g. "knee pain", "stress fracture", "IT band syndrome", "achilles tendinopathy", "shin splints")
- notes: a single concise sentence capturing what the injury is, how far along recovery is, and any running constraints mentioned
- If vague, still summarize what was shared
- Example: {"injury_type": "knee pain", "notes": "Recovering from knee pain, currently limited to 2 miles/week, avoiding hills and back-to-back run days."}`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] injury raw response:", parseText);

  let parsed: { injury_type: string | null; notes: string } = { injury_type: null, notes: message };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] injury parse failed:", e);
  }

  const injuryNotes = parsed.notes || message;

  const mergedData = { ...onboardingData, injury_notes: injuryNotes };
  const nextStep = findNextStep("awaiting_injury", mergedData);

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: mergedData })
    .eq("id", user.id);

  if (nextStep) {
    const q = getStepQuestion(nextStep, mergedData);
    await sendAndStore(user.id, user.phone_number, `Got it — I'll keep that in mind and make sure we build back carefully. ${q}`);
  }
  return NextResponse.json({ ok: true });
}

async function handlePacing(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const sport = (onboardingData.sport_type as string) || "running";
  const isTri = sport === "triathlon";

  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 256,
    system: `Extract performance/pacing data from the user's message. The athlete is training for a ${sport} goal. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "has_performance_data": true|false, "run_distance_km": number|null, "run_time_minutes": number|null, "swim_pace": string|null, "bike_info": string|null, "run_pace": string|null, "follow_up": string|null}

Rules:
- has_performance_data: true if they share any race, time trial, or estimated pace
- complete: true if has_performance_data is false (no data is a valid answer)
- complete: true if has_performance_data is true and at least one usable time or pace is present
- complete: false only if they say they have raced but give NO times or paces at all
- run_distance_km: running race distance for the best time given (5K=5, 10K=10, half=21.0975, marathon=42.195, 1mi=1.609)
- run_time_minutes: extract any explicitly stated run time, even if the user qualifies it ("I'm slower now", "that was last year", "my best was"). A historical or approximate time is far more useful than nothing. "17:23"=17.38, "25:30"=25.5, "1:45:00"=105
- If the user mentions multiple races, prefer the one with the most specific time. A 5K time is more useful for pace calibration than a 100K without a time.
- swim_pace: swim pace per 100m if mentioned
- bike_info: any bike split, speed, or power mentioned as a string
- run_pace: easy or conversational run pace if explicitly stated (e.g. "9:30/mi")
- "no", "never raced", "don't have any" → has_performance_data: false, complete: true
- If complete is true, follow_up must be null`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] pacing raw response:", parseText);

  let parsed: {
    complete: boolean;
    has_performance_data: boolean;
    run_distance_km: number | null;
    run_time_minutes: number | null;
    swim_pace: string | null;
    bike_info: string | null;
    run_pace: string | null;
    follow_up: string | null;
  } = { complete: false, has_performance_data: false, run_distance_km: null, run_time_minutes: null, swim_pace: null, bike_info: null, run_pace: null, follow_up: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] pacing parse failed:", e);
  }

  if (!parsed.complete) {
    const followUp = parsed.follow_up || (isTri
      ? "What event and roughly what were your splits or finish time?"
      : "What race and roughly what was your time? Even a ballpark helps.");
    await sendAndStore(user.id, user.phone_number, followUp);
    return NextResponse.json({ ok: true });
  }

  // Build pace data from whatever was provided
  let paceData: Record<string, string | null> = { easy_pace: null, tempo_pace: null, interval_pace: null };

  if (parsed.run_distance_km && parsed.run_time_minutes) {
    // Use VDOT for running pace zones if we have a run result
    const vdotPaces = calculateVDOTPaces(parsed.run_distance_km, parsed.run_time_minutes);
    paceData = vdotPaces;
  } else if (parsed.run_pace) {
    // Use stated easy pace as fallback
    const estimated = estimatePacesFromEasyPace(parsed.run_pace);
    paceData = estimated;
  }

  const mergedData = {
    ...onboardingData,
    ...paceData,
    ...(parsed.swim_pace ? { swim_pace: parsed.swim_pace } : {}),
    ...(parsed.bike_info ? { bike_info: parsed.bike_info } : {}),
  };

  const nextStep = findNextStep("awaiting_pacing", mergedData);

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: mergedData })
    .eq("id", user.id);

  if (nextStep) {
    const hasPaces = paceData.easy_pace != null;
    const q = getStepQuestion(nextStep, mergedData);
    const ack = hasPaces ? "Perfect, that gives me what I need to set your training paces." : "Got it.";
    await sendAndStore(user.id, user.phone_number, `${ack} ${q}`);
  }

  return NextResponse.json({ ok: true });
}

async function handleConversationalPace(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 128,
    system: `Extract comfortable training paces from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"run_pace": "M:SS" | null, "swim_pace": string | null, "bike_info": string | null}

Rules:
- run_pace: comfortable easy running pace in M:SS format ("9:30", "10 minute mile" → "10:00")
- swim_pace: swim pace per 100m if mentioned (e.g. "1:45/100m", "2 minutes per 100")
- bike_info: bike speed or effort if mentioned (e.g. "18 mph", "zone 2 on the bike")
- Set fields to null if not clearly stated`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] conversational pace raw response:", parseText);

  let parsed: { run_pace: string | null; swim_pace: string | null; bike_info: string | null } = { run_pace: null, swim_pace: null, bike_info: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] conversational pace parse failed:", e);
  }

  const paces = estimatePacesFromEasyPace(parsed.run_pace);

  const mergedData = {
    ...onboardingData,
    easy_pace: paces.easy,
    tempo_pace: paces.tempo,
    interval_pace: paces.interval,
    ...(parsed.swim_pace ? { swim_pace: parsed.swim_pace } : {}),
    ...(parsed.bike_info ? { bike_info: parsed.bike_info } : {}),
  };
  const nextStep = findNextStep("awaiting_conversational_pace", mergedData);

  await supabase
    .from("users")
    .update({ onboarding_step: nextStep, onboarding_data: mergedData })
    .eq("id", user.id);

  if (nextStep) {
    const q = getStepQuestion(nextStep, mergedData);
    await sendAndStore(user.id, user.phone_number, `Got it. ${q}`);
  }
  return NextResponse.json({ ok: true });
}

async function handleCrossTraining(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 64,
    system: `Extract cross-training activities from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"crosstraining_tools": [<string>, ...]}

Rules:
- Empty array if they say "no", "nothing", "just running", or similar
- Normalize to simple lowercase terms: "go to the gym" → ["gym"], "bike and swim" → ["cycling", "swimming"]`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] crosstraining raw response:", parseText);

  let parsed: { crosstraining_tools: string[] } = { crosstraining_tools: [] };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] crosstraining parse failed:", e);
  }

  const mergedData = { ...onboardingData, crosstraining_tools: parsed.crosstraining_tools };
  const nextStep = findNextStep("awaiting_crosstraining", mergedData);

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
- complete: true only if SPECIFIC DAYS are provided or clearly implied (e.g. "weekdays", "Mon/Wed/Fri")
- "4 days" alone with no day names → complete: false, days_per_week: 4, follow_up asks which specific days and preferred long run day
- "Weekdays" → complete: true, training_days: ["monday","tuesday","wednesday","thursday","friday"]
- "Weekends" → complete: true, training_days: ["saturday","sunday"]
- long_run_day: null if not mentioned
- follow_up: short, natural message. Example: "4 days works great! Which days of the week, and which would you prefer for your long run?"
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

async function handlePreferences(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 32,
    system: `Classify messaging cadence preference. Respond with ONLY valid JSON, no other text.

Output format: {"nightly_reminders": true | false}

Rules:
- true if they want nightly reminders, "both", or "either"
- false if weekly-only, "just Sunday", or unclear`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] preferences raw response:", parseText);

  let parsed: { nightly_reminders: boolean } = { nightly_reminders: false };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] preferences parse failed:", e);
  }

  const goal = (onboardingData.goal as string) || "general_fitness";
  const raceDate = (onboardingData.race_date as string) || null;
  const experienceYears = (onboardingData.experience_years as number) ?? 1;
  const weeklyMiles = (onboardingData.weekly_miles as number) ?? 15;
  const crosstrain = (onboardingData.crosstraining_tools as string[]) || [];
  const daysPerWeek = (onboardingData.days_per_week as number) ?? 4;
  const trainingDays = (onboardingData.training_days as string[]) || [];
  const easyPace = (onboardingData.easy_pace as string) || null;
  const tempoPace = (onboardingData.tempo_pace as string) || null;
  const intervalPace = (onboardingData.interval_pace as string) || null;
  const injuryNotes = (onboardingData.injury_notes as string) || null;
  const proactiveCadence = parsed.nightly_reminders ? "nightly_reminders" : "weekly_only";

  const weeklyHours = (onboardingData.weekly_hours as number) || null;
  const swimPace = (onboardingData.swim_pace as string) || null;
  const bikeInfo = (onboardingData.bike_info as string) || null;
  const sportType = (onboardingData.sport_type as string) || "running";

  const fitnessLevel = assessFitnessLevel(experienceYears, weeklyMiles, weeklyHours);
  // Reflect the athlete's actual current volume — don't round up or impose a minimum.
  // Very low mileage (< 5 miles/week) signals to the coach prompt to use walk-jog sessions
  // rather than prescribing pure running distances that would be unsafe.
  const weeklyMileage =
    weeklyMiles <= 0 ? 10 :
    weeklyMiles <= 10 ? Math.ceil(weeklyMiles) :
    Math.round(weeklyMiles / 5) * 5 || 15;
  const longRun = Math.round(weeklyMileage * 0.3);

  // Send wrap-up immediately so it arrives before the (slower) initial plan
  await sendAndStore(
    user.id,
    user.phone_number,
    "Perfect, I have everything I need. Give me a moment and I'll put together your first training week. 🏃"
  );

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
        proactive_cadence: proactiveCadence,
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
        onboarding_data: { ...onboardingData, nightly_reminders: parsed.nightly_reminders },
      })
      .eq("id", user.id),
  ]);

  if (profileResult.error) console.error("[onboarding] training_profiles upsert failed:", profileResult.error);
  if (stateResult.error) console.error("[onboarding] training_state upsert failed:", stateResult.error);
  if (userResult.error) console.error("[onboarding] users update failed:", userResult.error);

  // Use after() so the coach/respond call is guaranteed to run even after this
  // route handler returns — fire-and-forget alone is killed by serverless exit.
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
  "awaiting_experience",
  "awaiting_injury",
  "awaiting_pacing",
  "awaiting_conversational_pace",
  "awaiting_crosstraining",
  "awaiting_schedule",
  "awaiting_preferences",
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
    case "awaiting_experience":
      return data.experience_years != null && data.weekly_miles != null;
    case "awaiting_injury":
      // Only required when injury was mentioned; skip if no injury flagged
      return !data.injury_mentioned || data.injury_notes != null;
    case "awaiting_pacing":
      // Satisfied if we already have pace data
      return data.easy_pace != null;
    case "awaiting_conversational_pace":
      return data.easy_pace != null;
    case "awaiting_crosstraining":
      return Object.prototype.hasOwnProperty.call(data, "crosstraining_tools");
    case "awaiting_schedule":
      return Array.isArray(data.training_days) && (data.training_days as string[]).length > 0;
    case "awaiting_preferences":
      return Object.prototype.hasOwnProperty.call(data, "nightly_reminders");
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
  const isMultiSport = isTri || isCycling;

  switch (step) {
    case "awaiting_race_date":
      return data.goal === "general_fitness"
        ? "Do you have a target event or date in mind? If not, just say 'no event' and we'll keep the plan open-ended."
        : "What's the date of your event? If you don't have one locked in yet, give me your best target and we can adjust later.";

    case "awaiting_experience":
      if (isTri) return "How long have you been training for triathlon? And roughly how many hours a week are you putting in across swim, bike, and run right now?";
      if (isCycling) return "How long have you been cycling, and roughly how many miles (or km) are you riding most weeks?";
      return "How long have you been running, and roughly how many miles (or km) are you putting in most weeks right now? Don't overthink it — a ballpark is totally fine.";

    case "awaiting_injury":
      return "Understood — thanks for flagging that. What's the injury, and where are you in recovery? Any specific limits I should plan around (max distance or duration, activities to avoid, no back-to-back days, etc.)?";

    case "awaiting_pacing":
      if (isTri) return "Have you done any triathlons or time trials recently? If so, what were your swim/bike/run splits or finish time? If not, just tell me your comfortable pace in each discipline.";
      if (isCycling) return "Have you done any cycling events or time trials recently? If so, what was your time or average speed? If not, what's your comfortable cruising pace?";
      return "Have you run any races before? If so, what's your best time — even a 5K or a recent training run you remember? That helps me set the right paces for your workouts.";

    case "awaiting_conversational_pace":
      if (isTri) return "No worries — just give me a rough sense of your comfortable pace in each: swim (per 100m), bike (speed or power if you have it), and run (per mile or km).";
      if (isCycling) return "No worries — what's a comfortable cruising speed or effort for you on the bike?";
      return "No worries — what would you say your comfortable, conversational running pace is per mile (or per km)?";

    case "awaiting_crosstraining":
      if (isTri) return "Do you do any strength work or yoga alongside your swim/bike/run training? I can slot those in as recovery or supplemental sessions.";
      if (isCycling) return "Do you do any other training alongside cycling — running, gym work, yoga? I can work those into your plan as well.";
      return "Do you do any cross-training alongside running — cycling, lifting, swimming, yoga? If so, I can work those into your plan on non-running days so your whole week stays active.";

    case "awaiting_schedule":
      if (isTri) return "How many days a week are you training total? And do you have any days that work better for longer sessions like a long ride or long run?";
      if (isCycling) return "How many days a week do you want to ride? And which days work best for your longer rides?";
      return "How many days a week do you want to run? And which days work best for you — including which day you'd prefer for your long run?";

    case "awaiting_preferences":
      return "Last one: how do you want me to reach out? I can send you a full weekly plan every Sunday, or also text you the night before each session as a reminder. Which works better, or do you want both?";

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
    awaiting_experience: { topic: "their running background and weekly mileage" },
    awaiting_injury: { topic: "their injury — what it is, where they are in recovery, and any running constraints" },
    awaiting_pacing: { topic: "their race times or running performance" },
    awaiting_conversational_pace: { topic: "their easy running pace" },
    awaiting_crosstraining: { topic: "cross-training or other fitness activities" },
    awaiting_schedule: { topic: "their weekly training schedule and availability" },
    awaiting_preferences: { topic: "how often they want to receive messages" },
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
