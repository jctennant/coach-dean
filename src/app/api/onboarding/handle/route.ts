import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS } from "@/lib/linq";

interface OnboardingRequest {
  userId: string;
  message: string;
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
      return handleStravaReminder(user);
    case "awaiting_schedule":
      return handleSchedule(user, message, onboardingData);
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

Output format: {"goal": "5k" | "10k" | "half_marathon" | "marathon" | "general_fitness", "race_date": "YYYY-MM-DD" | null}

Rules:
- If they mention a month but no year, assume ${new Date().getFullYear()} (or next year if the month has passed)
- If they mention a specific date, use it
- If no date mentioned, set race_date to null
- "Just getting in shape" or similar → goal: "general_fitness"
- "Half marathon" or "half" → "half_marathon"
- Today's date is ${new Date().toISOString().split("T")[0]}`,
    messages: [{ role: "user", content: message }],
  });

  const parseText =
    parseResponse.content[0].type === "text"
      ? parseResponse.content[0].text
      : "{}";

  let parsed: { goal: string; race_date: string | null };
  try {
    parsed = JSON.parse(parseText);
  } catch {
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
  user: { id: string; phone_number: string }
) {
  const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
  const reminderMsg = `I still need to connect to your Strava! Tap this link to authorize: ${stravaUrl}`;

  await sendAndStore(user.id, user.phone_number, reminderMsg);
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

  let parsed: { training_days: string[]; days_per_week: number };
  try {
    parsed = JSON.parse(parseText);
  } catch {
    const clarifyMsg =
      "I didn't catch which days work for you. Which days of the week can you run? (e.g., Tue, Thu, Sat, Sun)";
    await sendAndStore(user.id, user.phone_number, clarifyMsg);
    return NextResponse.json({ ok: true });
  }

  // Save schedule and finalize onboarding
  const updatedData = {
    ...onboardingData,
    training_days: parsed.training_days,
    days_per_week: parsed.days_per_week,
  };

  const goal = (onboardingData.goal as string) || "general_fitness";
  const raceDate = (onboardingData.race_date as string) || null;

  // Assess fitness from Strava stats (synced during OAuth callback)
  const stravaStats = onboardingData.strava_stats as {
    all_run_totals?: { count?: number; distance?: number };
    recent_run_totals?: { count?: number; distance?: number };
  } | undefined;

  const fitnessLevel = assessFitnessLevel(stravaStats);
  const { weeklyMileage, longRun } = estimateWeeklyMileage(
    fitnessLevel,
    parsed.days_per_week,
    stravaStats
  );

  // Create training profile, training state, and clear onboarding — all in parallel
  await Promise.all([
    supabase.from("training_profiles").upsert(
      {
        user_id: user.id,
        goal,
        race_date: raceDate,
        fitness_level: fitnessLevel,
        days_per_week: parsed.days_per_week,
        training_days: parsed.training_days,
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

  // Trigger first coaching message via coach/respond
  await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: user.id,
      trigger: "user_message",
    }),
  });

  return NextResponse.json({ ok: true });
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

/**
 * Assess fitness level from Strava history.
 */
function assessFitnessLevel(stats: StravaStats | undefined): string {
  if (!stats?.all_run_totals) return "beginner";

  const totalRuns = stats.all_run_totals.count ?? 0;
  const totalMiles = (stats.all_run_totals.distance ?? 0) / 1609.34;

  // Recent 4-week activity level
  const recentRuns = stats.recent_run_totals?.count ?? 0;
  const recentMiles = (stats.recent_run_totals?.distance ?? 0) / 1609.34;
  const recentWeeklyMiles = recentMiles / 4;

  // Advanced: lots of history AND currently active
  if ((totalRuns >= 200 || totalMiles >= 2000) && recentWeeklyMiles >= 20)
    return "advanced";

  // Intermediate: moderate history or moderate current volume
  if (totalRuns >= 50 || totalMiles >= 500 || recentWeeklyMiles >= 12)
    return "intermediate";

  return "beginner";
}

/**
 * Estimate starting weekly mileage target.
 * If Strava stats are available, use recent 4-week average as baseline.
 */
function estimateWeeklyMileage(
  fitnessLevel: string,
  daysPerWeek: number,
  stravaStats?: StravaStats
): { weeklyMileage: number; longRun: number } {
  // If we have recent Strava data, use it as the baseline
  if (stravaStats?.recent_run_totals?.distance) {
    const recentWeeklyMiles =
      stravaStats.recent_run_totals.distance / 1609.34 / 4;
    // Use the actual recent average, rounded to nearest 5
    const weeklyMileage = Math.round(recentWeeklyMiles / 5) * 5 || 10;
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
    general_fitness: "General fitness",
  };
  return labels[goal] || goal;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
