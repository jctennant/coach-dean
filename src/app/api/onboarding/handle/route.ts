import { NextResponse } from "next/server";
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
 * Processes inbound SMS during onboarding. Uses Claude to parse natural-language
 * responses and advances the user through onboarding steps.
 *
 * Flow: awaiting_goal → awaiting_race_date → awaiting_experience
 *       → awaiting_crosstraining → awaiting_preferences → null (complete)
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

  switch (step) {
    case "awaiting_goal":
      return handleGoal(user, message, onboardingData);
    case "awaiting_race_date":
      return handleRaceDate(user, message, onboardingData);
    case "awaiting_experience":
      return handleExperience(user, message, onboardingData);
    case "awaiting_crosstraining":
      return handleCrossTraining(user, message, onboardingData);
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
    max_tokens: 64,
    system: `Extract the user's running goal from their message. Respond with ONLY valid JSON, no other text.

Output format: {"goal": "5k" | "10k" | "half_marathon" | "marathon" | "30k" | "50k" | "100k" | "triathlon" | "general_fitness"}

Rules:
- "half marathon" or "half" → "half_marathon"
- "full marathon" or just "marathon" → "marathon"
- "ultra" without a distance → "50k"
- "triathlon" → "triathlon"
- "just getting in shape", "get fit", "general" → "general_fitness"`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] goal raw response:", parseText);

  let parsed: { goal: string };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] goal parse failed:", e);
    await sendAndStore(
      user.id,
      user.phone_number,
      "I didn't quite catch that — what are you training for? (e.g. 5K, half marathon, full marathon, ultra, triathlon, or just general fitness?)"
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
    "How long have you been running, and roughly how many miles are you putting in most weeks right now? Don't overthink it — a ballpark is totally fine."
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
    max_tokens: 64,
    system: `Extract running experience and weekly mileage from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"experience_years": <number>, "weekly_miles": <number>}

Rules:
- experience_years: "a few months" → 0.3, "just started" → 0, "about a year" → 1, "5+ years" → 5
- weekly_miles: if vague ("not much", "just started") → 10; if clearly low → use 5
- "3 years, ~25 miles a week" → {"experience_years": 3, "weekly_miles": 25}`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] experience raw response:", parseText);

  let parsed: { experience_years: number; weekly_miles: number } = {
    experience_years: 1,
    weekly_miles: 15,
  };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] experience parse failed:", e);
  }

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_crosstraining",
      onboarding_data: {
        ...onboardingData,
        experience_years: parsed.experience_years,
        weekly_miles: parsed.weekly_miles,
      },
    })
    .eq("id", user.id);

  await sendAndStore(
    user.id,
    user.phone_number,
    "Got it. Do you do anything else for fitness alongside running? Cycling, lifting, swimming, yoga — anything counts."
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
      onboarding_step: "awaiting_preferences",
      onboarding_data: { ...onboardingData, crosstraining_tools: parsed.crosstraining_tools },
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

  // Pull everything collected so far
  const goal = (onboardingData.goal as string) || "general_fitness";
  const raceDate = (onboardingData.race_date as string) || null;
  const experienceYears = (onboardingData.experience_years as number) ?? 1;
  const weeklyMiles = (onboardingData.weekly_miles as number) ?? 15;
  const crosstrain = (onboardingData.crosstraining_tools as string[]) || [];
  const proactiveCadence = parsed.nightly_reminders ? "nightly_reminders" : "weekly_only";

  const fitnessLevel = assessFitnessLevel(experienceYears, weeklyMiles);
  const { weeklyMileage, longRun, daysPerWeek, trainingDays } =
    estimateTrainingDefaults(fitnessLevel, weeklyMiles);

  // Send wrap-up immediately so it arrives before the (slower) initial plan
  await sendAndStore(
    user.id,
    user.phone_number,
    "Perfect, I have everything I need. Give me a moment and I'll put together your first training week. 🏃"
  );

  // Persist profile + state + clear onboarding step
  await Promise.all([
    supabase.from("training_profiles").upsert(
      {
        user_id: user.id,
        goal,
        race_date: raceDate,
        fitness_level: fitnessLevel,
        days_per_week: daysPerWeek,
        training_days: trainingDays,
        current_easy_pace: null,
        current_tempo_pace: null,
        current_interval_pace: null,
        crosstraining_tools: crosstrain,
        proactive_cadence: proactiveCadence,
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

  // Fire-and-forget initial coaching plan
  fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id, trigger: "initial_plan" }),
  }).catch((err) => console.error("[onboarding] coach trigger failed:", err));

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Helpers
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

function estimateTrainingDefaults(
  fitnessLevel: string,
  weeklyMiles: number
): { weeklyMileage: number; longRun: number; daysPerWeek: number; trainingDays: string[] } {
  const defaults: Record<
    string,
    { daysPerWeek: number; trainingDays: string[] }
  > = {
    beginner: {
      daysPerWeek: 3,
      trainingDays: ["monday", "wednesday", "saturday"],
    },
    intermediate: {
      daysPerWeek: 4,
      trainingDays: ["tuesday", "thursday", "saturday", "sunday"],
    },
    advanced: {
      daysPerWeek: 5,
      trainingDays: ["monday", "tuesday", "thursday", "friday", "saturday"],
    },
  };

  const d = defaults[fitnessLevel] ?? defaults.intermediate;
  const weeklyMileage = weeklyMiles > 0 ? Math.round(weeklyMiles / 5) * 5 || 10 : 15;
  const longRun = Math.round(weeklyMileage * 0.3);

  return { weeklyMileage, longRun, daysPerWeek: d.daysPerWeek, trainingDays: d.trainingDays };
}

/** Lowercase goal label without article, for use mid-sentence */
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
