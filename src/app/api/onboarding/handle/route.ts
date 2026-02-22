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
    system: `Classify whether the user's message contains a clear running or fitness goal. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "goal": "5k"|"10k"|"half_marathon"|"marathon"|"30k"|"50k"|"100k"|"triathlon"|"general_fitness"|null}

Rules:
- complete: true only if a clear training goal is identifiable
- Pure greetings ("Hi", "Hi Dean!", "Hey", "Hello", "yo") with no goal context → complete: false, goal: null
- "Hi Dean! I want to run a half marathon" → complete: true, goal: "half_marathon"
- "half marathon" or "half" → "half_marathon"
- "full marathon" or "marathon" → "marathon"
- "ultra" without distance → "50k"
- "triathlon" → "triathlon"
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
      "Hey, I'm Coach Dean! 👋 I'll be your running coach over text.\n\nWhat are you training for? (e.g. 5K, half marathon, full marathon, ultra, triathlon, or just general fitness?)"
    );
    return NextResponse.json({ ok: true });
  }

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_race_date",
      onboarding_data: { ...onboardingData, goal: parsed.goal },
    })
    .eq("id", user.id);

  const goalLabel = formatGoalInline(parsed.goal);
  const responseMsg =
    parsed.goal === "general_fitness"
      ? "Love it — building consistent fitness is a great foundation. Do you have a target event or date in mind? If not, just say 'no race' and we'll keep the plan open-ended."
      : `Love it, a ${goalLabel} — great goal. What's the exact date of your race? If you don't have one locked in yet, give me your best target and we can adjust later.`;

  await sendAndStore(user.id, user.phone_number, responseMsg);
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

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_experience",
      onboarding_data: { ...onboardingData, race_date: parsed.race_date },
    })
    .eq("id", user.id);

  await sendAndStore(
    user.id,
    user.phone_number,
    "How long have you been running, and roughly how many miles (or km) are you putting in most weeks right now? Don't overthink it — a ballpark is totally fine."
  );
  return NextResponse.json({ ok: true });
}

async function handleExperience(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: `Extract running experience and weekly volume from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "experience_years": number|null, "weekly_miles": number|null, "injury_mentioned": boolean, "follow_up": string|null}

Rules:
- complete: true only if BOTH experience duration AND weekly volume are clearly stated or strongly implied
- "just started" or "beginner" implies experience_years: 0 and weekly_miles: ~5 → complete: true
- If only experience is given (e.g. "3 years"): complete: false, experience_years: 3, weekly_miles: null
- If only volume is given (e.g. "about 25 miles a week"): complete: false, experience_years: null, weekly_miles: 25
- weekly_miles: convert km to miles if needed (1 km = 0.621 mi)
- experience_years: "a few months" → 0.3, "about a year" → 1, "5+ years" → 5
- injury_mentioned: true if the user mentions an injury, being hurt, recovering, or any physical limitation affecting their running
- follow_up: a short, natural message acknowledging what was shared and asking specifically for the missing piece. Example: "3 years, nice! And roughly how many miles (or km) a week are you running right now?"
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
    injury_mentioned: boolean;
    follow_up: string | null;
  } = { complete: false, experience_years: null, weekly_miles: null, injury_mentioned: false, follow_up: null };
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

  const updatedData = {
    ...onboardingData,
    experience_years: parsed.experience_years ?? 1,
    weekly_miles: parsed.weekly_miles ?? 15,
  };

  if (parsed.injury_mentioned) {
    // Collect injury details before moving to pacing
    await supabase
      .from("users")
      .update({ onboarding_step: "awaiting_injury", onboarding_data: updatedData })
      .eq("id", user.id);

    await sendAndStore(
      user.id,
      user.phone_number,
      "Understood — thanks for flagging that. What's the injury, and where are you in recovery? Any specific limits I should plan around (max distance, terrain to avoid, no back-to-back days, etc.)?"
    );
  } else {
    await supabase
      .from("users")
      .update({ onboarding_step: "awaiting_pacing", onboarding_data: updatedData })
      .eq("id", user.id);

    await sendAndStore(
      user.id,
      user.phone_number,
      "Have you run any races before? If so, what's your best time — even a 5K or a recent training run you remember? That helps me set the right paces for your workouts."
    );
  }
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

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_pacing",
      onboarding_data: { ...onboardingData, injury_notes: injuryNotes },
    })
    .eq("id", user.id);

  await sendAndStore(
    user.id,
    user.phone_number,
    "Got it — I'll keep that in mind and make sure we build back carefully. Have you run any races before? If so, what's your best time — even a 5K or a time trial? That helps me set the right training paces."
  );
  return NextResponse.json({ ok: true });
}

async function handlePacing(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 200,
    system: `Extract race or time trial performance data from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"complete": true|false, "has_race_data": true|false, "distance_km": number|null, "time_minutes": number|null, "follow_up": string|null}

Rules:
- has_race_data: true if they mention any race or specific run with a time
- complete: true if has_race_data is false (no race is a complete, valid answer)
- complete: true if has_race_data is true AND both distance_km and time_minutes are provided
- complete: false if they confirm they have raced but don't give an actual time or distance
- distance_km: 5K=5, 10K=10, half marathon=21.0975, marathon=42.195, 1 mile=1.609, 3 miles=4.828
- time_minutes: "25:30"=25.5, "1:45:00"=105, "21 minutes"=21, "sub-2-hour half"=119
- "no", "never raced", "I don't have any" → has_race_data: false, complete: true
- "yes I have raced" with no time → complete: false, follow_up: "What race and roughly what was your time?"
- If complete is true, follow_up must be null`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] pacing raw response:", parseText);

  let parsed: {
    complete: boolean;
    has_race_data: boolean;
    distance_km: number | null;
    time_minutes: number | null;
    follow_up: string | null;
  } = { complete: false, has_race_data: false, distance_km: null, time_minutes: null, follow_up: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] pacing parse failed:", e);
  }

  if (!parsed.complete) {
    // They mentioned racing but didn't give a time — ask specifically
    const followUp =
      parsed.follow_up ||
      "What race and roughly what was your time? Even a ballpark helps.";
    await sendAndStore(user.id, user.phone_number, followUp);
    return NextResponse.json({ ok: true });
  }

  if (parsed.has_race_data && parsed.distance_km && parsed.time_minutes) {
    const paces = calculateVDOTPaces(parsed.distance_km, parsed.time_minutes);

    await supabase
      .from("users")
      .update({
        onboarding_step: "awaiting_crosstraining",
        onboarding_data: {
          ...onboardingData,
          easy_pace: paces.easy,
          tempo_pace: paces.tempo,
          interval_pace: paces.interval,
        },
      })
      .eq("id", user.id);

    await sendAndStore(
      user.id,
      user.phone_number,
      "Perfect, that gives me what I need to set your training paces. Do you do any cross-training alongside running — cycling, lifting, swimming, yoga? If so, I can work those into your plan on non-running days so your whole week stays active."
    );
  } else {
    // No race data — ask for conversational pace
    await supabase
      .from("users")
      .update({ onboarding_step: "awaiting_conversational_pace" })
      .eq("id", user.id);

    await sendAndStore(
      user.id,
      user.phone_number,
      "No worries — what would you say your comfortable, conversational running pace is per mile (or per km)?"
    );
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
    max_tokens: 32,
    system: `Extract a running pace from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"pace": "M:SS" | null}

Rules:
- Convert any format to M:SS (per mile or per km — just capture the numbers)
- "9:30", "9 and a half minutes", "nine thirty" → "9:30"
- "10 minute mile" → "10:00"
- If no clear pace given → null`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] conversational pace raw response:", parseText);

  let parsed: { pace: string | null } = { pace: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] conversational pace parse failed:", e);
  }

  const paces = estimatePacesFromEasyPace(parsed.pace);

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_crosstraining",
      onboarding_data: {
        ...onboardingData,
        easy_pace: paces.easy,
        tempo_pace: paces.tempo,
        interval_pace: paces.interval,
      },
    })
    .eq("id", user.id);

  await sendAndStore(
    user.id,
    user.phone_number,
    "Got it. Do you do any cross-training alongside running — cycling, lifting, swimming, yoga? If so, I can work those into your plan on non-running days so your whole week stays active."
  );
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

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_schedule",
      onboarding_data: { ...onboardingData, crosstraining_tools: parsed.crosstraining_tools },
    })
    .eq("id", user.id);

  await sendAndStore(
    user.id,
    user.phone_number,
    "How many days a week do you want to run? And which days work best for you — including which day you'd prefer for your long run?"
  );
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

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_preferences",
      onboarding_data: {
        ...onboardingData,
        days_per_week: daysPerWeek,
        training_days: trainingDays,
        long_run_day: parsed.long_run_day,
      },
    })
    .eq("id", user.id);

  await sendAndStore(
    user.id,
    user.phone_number,
    "Last one: how do you want me to reach out? I can send you a full weekly plan every Sunday, or I can also text you the night before each workout as a reminder. Which works better for you, or do you want both?"
  );
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

  const fitnessLevel = assessFitnessLevel(experienceYears, weeklyMiles);
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

  await Promise.all([
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

function assessFitnessLevel(experienceYears: number, weeklyMiles: number): string {
  if (weeklyMiles >= 30 || experienceYears >= 3) return "advanced";
  if (weeklyMiles >= 15 || experienceYears >= 1) return "intermediate";
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
    triathlon: "triathlon",
    general_fitness: "general fitness",
  };
  return labels[goal] || goal;
}
