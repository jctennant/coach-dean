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
  // Try to extract from ```json ... ``` or ``` ... ``` blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text;
}

/**
 * POST /api/onboarding/handle
 * Processes inbound SMS during onboarding. Uses Claude to parse natural-language
 * responses and advances the user through onboarding steps.
 */
export async function POST(request: Request) {
  const { userId, message }: OnboardingRequest = await request.json();

  // Fetch current user state
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
    case "awaiting_strava":
      return handleStravaReminder(user, message, onboardingData);
    case "awaiting_manual_fitness":
      return handleManualFitness(user, message, onboardingData);
    case "awaiting_schedule":
      return handleSchedule(user, message, onboardingData);
    case "awaiting_preferences":
      return handlePreferences(user, message, onboardingData);
    default:
      return NextResponse.json({ ok: true });
  }
}

async function handleGoal(
  user: { id: string; phone_number: string; name: string | null },
  message: string,
  onboardingData: Record<string, unknown>
) {
  // Use Claude to extract goal and race date from natural language
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 256,
    system: `Extract the running goal and optional race date from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"goal": "5k" | "10k" | "half_marathon" | "marathon" | "30k" | "50k" | "100k" | "general_fitness", "race_date": "YYYY-MM-DD" | null}

Rules:
- If they mention a month but no year, assume ${new Date().getFullYear()} (or next year if the month has passed)
- If they mention a specific date, use it
- If no date mentioned, set race_date to null
- "Just getting in shape" or similar → goal: "general_fitness"
- "Half marathon" or "half" → "half_marathon"
- "30k", "50k", "100k", "ultra" or similar trail/ultra distances → use the matching distance
- "End of [month]" → use the last day of that month
- Today's date is ${new Date().toISOString().split("T")[0]}`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text"
      ? parseResponse.content[0].text
      : "{}";

  console.log("[onboarding] goal raw response:", parseText);

  let parsed: { goal: string; race_date: string | null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] goal parse failed:", e);
    // If parsing fails, ask them to clarify
    const clarifyMsg =
      "I didn't quite catch that. What are you training for? (e.g., half marathon in June, 10K, just getting in shape)";
    await sendAndStore(user.id, user.phone_number, clarifyMsg);
    return NextResponse.json({ ok: true });
  }

  // Save goal data and advance to awaiting_strava
  const updatedData = {
    ...onboardingData,
    goal: parsed.goal,
    race_date: parsed.race_date,
  };

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_strava",
      onboarding_data: updatedData,
    })
    .eq("id", user.id);

  // Build acknowledgment + Strava link message
  const goalLabel = formatGoal(parsed.goal);
  const dateInfo = parsed.race_date
    ? ` on ${formatDate(parsed.race_date)}`
    : "";
  const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;

  const responseMsg = `${goalLabel}${dateInfo} — great choice! Now I need to connect to your Strava so I can see your runs and tailor your training.\n\nTap this link to connect: ${stravaUrl}`;

  await sendAndStore(user.id, user.phone_number, responseMsg);
  return NextResponse.json({ ok: true });
}

async function handleStravaReminder(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  // Detect if user is saying they don't have Strava
  const classifyResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 64,
    system: `Classify whether the user's message indicates they don't have Strava or want to skip connecting it. Respond with ONLY valid JSON: {"no_strava": true} or {"no_strava": false}

Examples of "no Strava": "I don't have Strava", "skip", "no thanks", "I don't use it", "no Strava", "nope", "can we skip this", "I'm not on Strava"
Examples of NOT "no Strava": any URL, "ok", "I'll do it", "how do I connect", "help", "linked"`,
    messages: [{ role: "user", content: message }],
  });

  const classifyText =
    classifyResponse.content[0].type === "text"
      ? classifyResponse.content[0].text
      : "{}";

  console.log("[onboarding] strava classify response:", classifyText);

  let classified: { no_strava: boolean } = { no_strava: false };
  try {
    classified = JSON.parse(extractJSON(classifyText));
  } catch (e) {
    console.error("[onboarding] strava classify parse failed:", e);
  }

  if (classified.no_strava) {
    // Route to manual fitness collection
    await supabase
      .from("users")
      .update({ onboarding_step: "awaiting_manual_fitness", onboarding_data: onboardingData })
      .eq("id", user.id);

    const manualMsg =
      "No problem! To tailor your training, roughly how many miles are you running per week, how long have you been running, and what's a typical easy run pace? (e.g., ~25 mi/week, 2 years, ~9:30/mi)";
    await sendAndStore(user.id, user.phone_number, manualMsg);
  } else {
    // Resend Strava link
    const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
    const reminderMsg = `I still need to connect to your Strava! Tap this link to authorize: ${stravaUrl}`;
    await sendAndStore(user.id, user.phone_number, reminderMsg);
  }

  return NextResponse.json({ ok: true });
}

async function handleManualFitness(
  user: { id: string; phone_number: string },
  message: string,
  onboardingData: Record<string, unknown>
) {
  // Use Claude to extract fitness info from natural language
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 128,
    system: `Extract the user's running fitness info from their message. Respond with ONLY valid JSON, no other text.

Output format: {"weekly_miles": <number>, "experience_years": <number>, "easy_pace": "<M:SS/mi>" | null}

Rules:
- weekly_miles: approximate miles per week. If not mentioned, estimate from context or use 15.
- experience_years: years running. "2 years" → 2, "a few months" → 0.3, "just started" → 0, "10+ years" → 10.
- easy_pace: format as "M:SS/mi". If not mentioned, set to null.
- "~25 mi/week, 2 years, ~9:30/mi" → {"weekly_miles": 25, "experience_years": 2, "easy_pace": "9:30/mi"}`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text"
      ? parseResponse.content[0].text
      : "{}";

  console.log("[onboarding] manual fitness raw response:", parseText);

  let parsed: { weekly_miles: number; experience_years: number; easy_pace: string | null };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] manual fitness parse failed:", e);
    const clarifyMsg =
      "I didn't quite catch that. Could you share roughly how many miles you run per week, how long you've been running, and your typical easy pace? (e.g., ~20 mi/week, 3 years, ~10:00/mi)";
    await sendAndStore(user.id, user.phone_number, clarifyMsg);
    return NextResponse.json({ ok: true });
  }

  const updatedData = {
    ...onboardingData,
    manual_fitness: {
      weekly_miles: parsed.weekly_miles,
      experience_years: parsed.experience_years,
      easy_pace: parsed.easy_pace,
    },
  };

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_schedule",
      onboarding_data: updatedData,
    })
    .eq("id", user.id);

  const scheduleMsg =
    "Got it! Which days of the week work best for running? (e.g., Tue, Thu, Sat, Sun)";
  await sendAndStore(user.id, user.phone_number, scheduleMsg);
  return NextResponse.json({ ok: true });
}

async function handleSchedule(
  user: { id: string; phone_number: string; name: string | null },
  message: string,
  onboardingData: Record<string, unknown>
) {
  // Use Claude to extract training days from natural language
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 256,
    system: `Extract which days of the week the user wants to train from their message. Respond with ONLY valid JSON, no other text.

Output format: {"training_days": ["monday", "tuesday", ...], "days_per_week": <number>}

Rules:
- Normalize day names to full lowercase (monday, tuesday, wednesday, thursday, friday, saturday, sunday)
- "Tue Thu Sat Sun" → ["tuesday", "thursday", "saturday", "sunday"]
- "Weekdays" → ["monday", "tuesday", "wednesday", "thursday", "friday"]
- "Weekends" → ["saturday", "sunday"]
- "Every day" → all 7 days
- days_per_week should equal the length of training_days`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text"
      ? parseResponse.content[0].text
      : "{}";

  console.log("[onboarding] schedule raw response:", parseText);

  let parsed: { training_days: string[]; days_per_week: number };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] schedule parse failed:", e);
    const clarifyMsg =
      "I didn't catch which days work for you. Which days of the week can you run? (e.g., Tue, Thu, Sat, Sun)";
    await sendAndStore(user.id, user.phone_number, clarifyMsg);
    return NextResponse.json({ ok: true });
  }

  // Save schedule to onboarding_data only — do NOT create training_profile yet
  const updatedData = {
    ...onboardingData,
    training_days: parsed.training_days,
    days_per_week: parsed.days_per_week,
  };

  await supabase
    .from("users")
    .update({
      onboarding_step: "awaiting_preferences",
      onboarding_data: updatedData,
    })
    .eq("id", user.id);

  const prefsMsg =
    "Two quick things: (1) Any access to a treadmill, bike, pool, or gym for cross-training? (2) Want a reminder the night before each workout, or just your weekly plan and Sunday check-in? You can always text me anytime.";
  await sendAndStore(user.id, user.phone_number, prefsMsg);
  return NextResponse.json({ ok: true });
}

async function handlePreferences(
  user: { id: string; phone_number: string; name: string | null },
  message: string,
  onboardingData: Record<string, unknown>
) {
  // Use Claude to extract cross-training tools and nightly reminder preference
  const parseResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 128,
    system: `Extract cross-training tools and messaging cadence preference from the user's message. Respond with ONLY valid JSON, no other text.

Output format: {"crosstraining_tools": ["treadmill" | "bike" | "pool" | "gym" | ...], "nightly_reminders": true | false}

Rules:
- crosstraining_tools: list any equipment/facilities mentioned. Empty array if none mentioned or "no" / "none".
- nightly_reminders: true if they want nightly reminders before workouts; false if weekly-only or no preference stated.
- "treadmill and a bike" → ["treadmill", "bike"]
- "just a gym membership" → ["gym"]
- "nightly sounds great" → nightly_reminders: true
- "weekly is fine" or no clear preference → nightly_reminders: false`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text"
      ? parseResponse.content[0].text
      : "{}";

  console.log("[onboarding] preferences raw response:", parseText);

  let parsed: { crosstraining_tools: string[]; nightly_reminders: boolean };
  try {
    parsed = JSON.parse(extractJSON(parseText));
  } catch (e) {
    console.error("[onboarding] preferences parse failed:", e);
    parsed = { crosstraining_tools: [], nightly_reminders: false };
  }

  // Determine fitness level and mileage from whichever data source we have
  const stravaStats = onboardingData.strava_stats as StravaStats | undefined;
  const manualFitness = onboardingData.manual_fitness as {
    weekly_miles?: number;
    experience_years?: number;
    easy_pace?: string | null;
  } | undefined;

  const daysPerWeek = (onboardingData.days_per_week as number) || 4;
  const trainingDays = (onboardingData.training_days as string[]) || [];
  const goal = (onboardingData.goal as string) || "general_fitness";
  const raceDate = (onboardingData.race_date as string) || null;

  const fitnessLevel = assessFitnessLevel(stravaStats, manualFitness);
  const { weeklyMileage, longRun } = estimateWeeklyMileage(
    fitnessLevel,
    daysPerWeek,
    stravaStats,
    manualFitness
  );

  // Fetch paces from Strava activities (returns nulls for non-Strava users)
  const paces = await computePacesFromActivities(user.id);

  // If no Strava paces but manual easy_pace provided, use it
  const easyPace = paces.easy ?? manualFitness?.easy_pace ?? null;

  const proactiveCadence = parsed.nightly_reminders ? "nightly_reminders" : "weekly_only";

  const updatedData = {
    ...onboardingData,
    crosstraining_tools: parsed.crosstraining_tools,
    nightly_reminders: parsed.nightly_reminders,
  };

  // Upsert training_profile, training_state, and clear onboarding — all in parallel
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
        current_tempo_pace: paces.tempo,
        current_interval_pace: paces.interval,
        crosstraining_tools: parsed.crosstraining_tools,
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
        onboarding_data: updatedData,
      })
      .eq("id", user.id),
  ]);

  // Fire-and-forget first coaching message — don't await
  fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: user.id,
      trigger: "initial_plan",
    }),
  }).catch((err) => console.error("[onboarding] coach trigger failed:", err));

  return NextResponse.json({ ok: true });
}

/**
 * Compute easy/tempo/interval paces from stored Strava activities.
 * Uses pace distribution: easy = ~75th percentile (slower), tempo = ~25th, interval = ~10th (fastest).
 */
async function computePacesFromActivities(
  userId: string
): Promise<{ easy: string | null; tempo: string | null; interval: string | null }> {
  const { data: activities } = await supabase
    .from("activities")
    .select("distance_meters, moving_time_seconds")
    .eq("user_id", userId)
    .gt("distance_meters", 800) // ignore very short runs
    .order("start_date", { ascending: false })
    .limit(50);

  if (!activities || activities.length < 3) {
    return { easy: null, tempo: null, interval: null };
  }

  // Calculate pace in min/mile for each activity
  const paces = activities
    .map((a) => {
      const miles = a.distance_meters / 1609.34;
      return miles > 0 ? a.moving_time_seconds / 60 / miles : null;
    })
    .filter((p): p is number => p !== null && p < 15) // filter out walks
    .sort((a, b) => a - b); // fastest to slowest

  if (paces.length < 3) {
    return { easy: null, tempo: null, interval: null };
  }

  const formatPace = (minPerMile: number): string => {
    const totalSec = Math.round(minPerMile * 60);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, "0")}/mi`;
  };

  const percentile = (arr: number[], p: number) => arr[Math.floor(arr.length * p)];

  return {
    easy: formatPace(percentile(paces, 0.75)),
    tempo: formatPace(percentile(paces, 0.25)),
    interval: formatPace(percentile(paces, 0.1)),
  };
}

/** Store an outbound message and send via SMS */
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

interface StravaStats {
  all_run_totals?: { count?: number; distance?: number };
  recent_run_totals?: { count?: number; distance?: number };
}

interface ManualFitness {
  weekly_miles?: number;
  experience_years?: number;
  easy_pace?: string | null;
}

/**
 * Assess fitness level from Strava history or manual fitness data.
 */
function assessFitnessLevel(
  stats: StravaStats | undefined,
  manual: ManualFitness | undefined
): string {
  // Prefer Strava data if available
  if (stats?.all_run_totals) {
    const totalRuns = stats.all_run_totals.count ?? 0;
    const totalMiles = (stats.all_run_totals.distance ?? 0) / 1609.34;
    const recentMiles = (stats.recent_run_totals?.distance ?? 0) / 1609.34;
    const recentWeeklyMiles = recentMiles / 4;

    if ((totalRuns >= 200 || totalMiles >= 2000) && recentWeeklyMiles >= 20)
      return "advanced";
    if (totalRuns >= 50 || totalMiles >= 500 || recentWeeklyMiles >= 12)
      return "intermediate";
    return "beginner";
  }

  // Fall back to manual fitness data
  if (manual) {
    const weeklyMiles = manual.weekly_miles ?? 0;
    const years = manual.experience_years ?? 0;

    if (weeklyMiles >= 30 || years >= 3) return "advanced";
    if (weeklyMiles >= 15 || years >= 1) return "intermediate";
  }

  return "beginner";
}

/**
 * Estimate starting weekly mileage target.
 * Uses Strava recent stats, manual fitness, or fitness-level defaults.
 */
function estimateWeeklyMileage(
  fitnessLevel: string,
  daysPerWeek: number,
  stravaStats?: StravaStats,
  manual?: ManualFitness
): { weeklyMileage: number; longRun: number } {
  // If we have recent Strava data, use it as the baseline
  if (stravaStats?.recent_run_totals?.distance) {
    const recentWeeklyMiles =
      stravaStats.recent_run_totals.distance / 1609.34 / 4;
    const weeklyMileage = Math.round(recentWeeklyMiles / 5) * 5 || 10;
    const longRun = Math.round(weeklyMileage * 0.3);
    return { weeklyMileage, longRun };
  }

  // If manual weekly miles provided, use that
  if (manual?.weekly_miles) {
    const weeklyMileage = Math.round(manual.weekly_miles / 5) * 5 || 10;
    const longRun = Math.round(weeklyMileage * 0.3);
    return { weeklyMileage, longRun };
  }

  // Fallback: estimate from fitness level
  const baseMileagePerDay: Record<string, number> = {
    beginner: 2.5,
    intermediate: 5,
    advanced: 7,
  };
  const perDay = baseMileagePerDay[fitnessLevel] ?? 3;
  const weeklyMileage = Math.round(perDay * daysPerWeek);
  const longRun = Math.round(weeklyMileage * 0.3);
  return { weeklyMileage, longRun };
}

function formatGoal(goal: string): string {
  const labels: Record<string, string> = {
    "5k": "A 5K",
    "10k": "A 10K",
    half_marathon: "A half marathon",
    marathon: "A marathon",
    "30k": "A 30K trail race",
    "50k": "A 50K ultra",
    "100k": "A 100K ultra",
    general_fitness: "General fitness",
  };
  return labels[goal] || goal;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
