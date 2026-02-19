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
- weekly_miles: if vague ("not much", "just started") → 10; low → 5
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
      onboarding_step: "awaiting_pacing",
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
    "Have you run any races before? If so, what's your best time — even a 5K or a recent training run you remember? That helps me set the right paces for your workouts."
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
    max_tokens: 128,
    system: `Extract race or time trial performance data from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"has_race_data": true|false, "distance_km": <number>|null, "time_minutes": <number>|null}

Rules:
- has_race_data: true if they mention any race time or a specific training run with a time
- distance_km: convert to km. 5K=5, 10K=10, half marathon=21.0975, marathon=42.195, 1 mile=1.609, 3 miles=4.828
- time_minutes: total minutes. "25:30"=25.5, "1:45:00"=105, "21 minutes"=21, "sub-2-hour half"=119
- "no", "never raced", "I don't have any", "no races" → {"has_race_data": false, "distance_km": null, "time_minutes": null}`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] pacing raw response:", parseText);

  let parsed: { has_race_data: boolean; distance_km: number | null; time_minutes: number | null } =
    { has_race_data: false, distance_km: null, time_minutes: null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] pacing parse failed:", e);
  }

  if (parsed.has_race_data && parsed.distance_km && parsed.time_minutes) {
    // Calculate VDOT-based training paces
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
      "Got it. Do you do anything else for fitness alongside running? Cycling, lifting, swimming, yoga — anything counts."
    );
  } else {
    // No race data — ask for conversational pace instead
    await supabase
      .from("users")
      .update({ onboarding_step: "awaiting_conversational_pace" })
      .eq("id", user.id);

    await sendAndStore(
      user.id,
      user.phone_number,
      "No worries — what would you say your comfortable, conversational running pace is per mile?"
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
- Convert any format to M:SS (minutes and seconds per mile, no "/mi" suffix needed)
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

  // Conversational pace = easy pace. Estimate tempo and interval from it.
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
    max_tokens: 128,
    system: `Extract training schedule preferences from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"days_per_week": <number>, "training_days": ["monday"|"tuesday"|...|"sunday"], "long_run_day": "<day>"|null}

Rules:
- Normalize all day names to full lowercase
- days_per_week: the number they state, or infer from listed days
- training_days: infer sensible days if not specified (e.g. "4 days" → ["tuesday","thursday","saturday","sunday"])
- long_run_day: the day they prefer for their long run; null if not mentioned
- "4 days, Tue/Thu/Sat/Sun, long run Sunday" → {"days_per_week": 4, "training_days": ["tuesday","thursday","saturday","sunday"], "long_run_day": "sunday"}`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text" ? parseResponse.content[0].text : "{}";
  console.log("[onboarding] schedule raw response:", parseText);

  let parsed: { days_per_week: number; training_days: string[]; long_run_day: string | null } = {
    days_per_week: 4,
    training_days: ["tuesday", "thursday", "saturday", "sunday"],
    long_run_day: null,
  };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] schedule parse failed:", e);
  }

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_preferences",
      onboarding_data: {
        ...onboardingData,
        days_per_week: parsed.days_per_week,
        training_days: parsed.training_days,
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
  const proactiveCadence = parsed.nightly_reminders ? "nightly_reminders" : "weekly_only";

  const fitnessLevel = assessFitnessLevel(experienceYears, weeklyMiles);
  const weeklyMileage = weeklyMiles > 0 ? Math.round(weeklyMiles / 5) * 5 || 10 : 15;
  const longRun = Math.round(weeklyMileage * 0.3);

  // Send wrap-up before the (slower) initial plan request
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

  fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id, trigger: "initial_plan" }),
  }).catch((err) => console.error("[onboarding] coach trigger failed:", err));

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

  // %VO2max utilized at race pace
  const pctVO2 =
    0.8 +
    0.1894393 * Math.exp(-0.012778 * timeMinutes) +
    0.2989558 * Math.exp(-0.1932605 * timeMinutes);

  // VO2 at race pace
  const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;

  // VDOT (maximal oxygen uptake)
  const vdot = vo2 / pctVO2;

  return {
    easy: paceAtVDOTPct(vdot, 0.65),     // ~65% VO2max
    tempo: paceAtVDOTPct(vdot, 0.86),    // ~86% VO2max (lactate threshold)
    interval: paceAtVDOTPct(vdot, 0.98), // ~98% VO2max (VO2max intervals)
  };
}

/** Solve for velocity at a given %VO2max from VDOT, return as "M:SS/mi" */
function paceAtVDOTPct(vdot: number, pct: number): string {
  const targetVO2 = vdot * pct;
  // Quadratic: 0.000104*v^2 + 0.182258*v - (targetVO2 + 4.60) = 0
  const a = 0.000104;
  const b = 0.182258;
  const c = -(targetVO2 + 4.60);
  const v = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a); // m/min
  const minPerMile = 1609.34 / v;
  const min = Math.floor(minPerMile);
  const sec = Math.round((minPerMile - min) * 60);
  return `${min}:${String(sec).padStart(2, "0")}/mi`;
}

/**
 * Estimate tempo and interval paces from a known easy/conversational pace.
 * Easy pace is roughly 90s/mi slower than tempo and 150s/mi slower than interval.
 */
function estimatePacesFromEasyPace(paceStr: string | null): {
  easy: string | null;
  tempo: string | null;
  interval: string | null;
} {
  if (!paceStr) return { easy: null, tempo: null, interval: null };

  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return { easy: paceStr, tempo: null, interval: null };

  const easySec = parseInt(match[1]) * 60 + parseInt(match[2]);

  const formatSec = (s: number): string => {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${String(sec).padStart(2, "0")}/mi`;
  };

  return {
    easy: formatSec(easySec),
    tempo: easySec > 90 ? formatSec(easySec - 90) : null,
    interval: easySec > 150 ? formatSec(easySec - 150) : null,
  };
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
