import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS } from "@/lib/linq";

type TriggerType = "morning_plan" | "post_run" | "user_message";

interface CoachRequest {
  userId: string;
  trigger: TriggerType;
  activityId?: number;
}

interface ActivityRow {
  activity_type: string;
  distance_meters: number;
  moving_time_seconds: number;
  average_heartrate: number | null;
  elevation_gain: number | null;
  average_pace: string;
  start_date: string;
}

/**
 * POST /api/coach/respond
 * Core coaching function. Given a user + trigger, generates and sends a coaching response via SMS.
 */
export async function POST(request: Request) {
  const { userId, trigger, activityId }: CoachRequest = await request.json();

  // Fetch user context in parallel
  const [
    userResult,
    profileResult,
    stateResult,
    conversationsResult,
    recentActivitiesResult,
  ] = await Promise.all([
    supabase.from("users").select("*").eq("id", userId).single(),
    supabase
      .from("training_profiles")
      .select("*")
      .eq("user_id", userId)
      .single(),
    supabase
      .from("training_state")
      .select("*")
      .eq("user_id", userId)
      .single(),
    supabase
      .from("conversations")
      .select("role, content, message_type, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(15),
    supabase
      .from("activities")
      .select(
        "activity_type, distance_meters, moving_time_seconds, average_heartrate, elevation_gain, average_pace, start_date"
      )
      .eq("user_id", userId)
      .order("start_date", { ascending: false })
      .limit(50),
  ]);

  const user = userResult.data;
  const profile = profileResult.data;
  const state = stateResult.data;
  const recentMessages = conversationsResult.data?.reverse() || [];
  const recentActivities =
    (recentActivitiesResult.data as ActivityRow[] | null) || [];

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // If post_run, fetch the activity
  let activityData = null;
  if (trigger === "post_run" && activityId) {
    const { data } = await supabase
      .from("activities")
      .select("*")
      .eq("strava_activity_id", activityId)
      .single();
    activityData = data;
  }

  // Build system prompt with activity trends
  const activitySummary = buildActivitySummary(recentActivities);
  const stravaStats = (
    user.onboarding_data as Record<string, unknown> | null
  )?.strava_stats as Record<string, unknown> | undefined;

  const systemPrompt = buildSystemPrompt(
    user,
    profile,
    state,
    recentMessages,
    activitySummary,
    stravaStats
  );

  // Build user message based on trigger
  const userMessage = buildUserMessage(trigger, activityData);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const coachMessage =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Send SMS
  await sendSMS(user.phone_number, coachMessage);

  // Store the response
  await supabase.from("conversations").insert({
    user_id: userId,
    role: "assistant",
    content: coachMessage,
    message_type:
      trigger === "post_run"
        ? "post_run"
        : trigger === "morning_plan"
          ? "morning_plan"
          : "coach_response",
    strava_activity_id: activityId || null,
  });

  // Update training state if post_run
  if (trigger === "post_run" && activityData) {
    const distanceMiles = activityData.distance_meters / 1609.34;
    await supabase
      .from("training_state")
      .update({
        week_mileage_so_far: (state?.week_mileage_so_far || 0) + distanceMiles,
        last_activity_date: activityData.start_date,
        last_activity_summary: {
          type: activityData.activity_type,
          distance_miles: Math.round(distanceMiles * 100) / 100,
          pace: activityData.average_pace,
          hr: activityData.average_heartrate,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }

  return NextResponse.json({ ok: true, message: coachMessage });
}

/**
 * Compute weekly mileage, pace trends, and run type breakdown from recent activities.
 */
function buildActivitySummary(activities: ActivityRow[]): string {
  if (activities.length === 0) return "No activity history available.";

  // Group by ISO week
  const weeks: Record<
    string,
    { miles: number; runs: number; vert: number; fastest: number }
  > = {};

  for (const a of activities) {
    const d = new Date(a.start_date);
    const yr = d.getFullYear();
    // Approximate ISO week
    const startOfYear = new Date(yr, 0, 1);
    const dayOfYear =
      Math.floor(
        (d.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000)
      ) + 1;
    const weekNum = Math.ceil(dayOfYear / 7);
    const key = `${yr}-W${String(weekNum).padStart(2, "0")}`;

    const miles = a.distance_meters / 1609.34;
    const paceMinPerMile =
      miles > 0 ? a.moving_time_seconds / 60 / miles : 999;

    if (!weeks[key])
      weeks[key] = { miles: 0, runs: 0, vert: 0, fastest: 999 };
    weeks[key].miles += miles;
    weeks[key].runs += 1;
    weeks[key].vert += a.elevation_gain || 0;
    if (paceMinPerMile < weeks[key].fastest)
      weeks[key].fastest = paceMinPerMile;
  }

  const sortedWeeks = Object.entries(weeks)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 8);

  let summary = "WEEKLY MILEAGE (recent):\n";
  for (const [week, data] of sortedWeeks) {
    const totalSec = Math.round(data.fastest * 60);
    const fMin = Math.floor(totalSec / 60);
    const fSec = totalSec % 60;
    summary += `  ${week}: ${data.miles.toFixed(1)} mi (${data.runs} runs, ${Math.round(data.vert)}ft vert, fastest ${fMin}:${String(fSec).padStart(2, "0")}/mi)\n`;
  }

  // Pace distribution from road-like runs (< 12 min/mi)
  const roadRuns = activities.filter((a) => {
    const miles = a.distance_meters / 1609.34;
    const pace = miles > 0 ? a.moving_time_seconds / 60 / miles : 999;
    return pace < 12 && miles > 0.5;
  });

  if (roadRuns.length > 0) {
    const paces = roadRuns.map((a) => {
      const miles = a.distance_meters / 1609.34;
      return a.moving_time_seconds / 60 / miles;
    });
    paces.sort((a, b) => a - b);

    const formatPace = (p: number) => {
      const totalSeconds = Math.round(p * 60);
      const m = Math.floor(totalSeconds / 60);
      const s = totalSeconds % 60;
      return `${m}:${String(s).padStart(2, "0")}`;
    };

    const fastest5 = paces.slice(0, 3);
    const median = paces[Math.floor(paces.length / 2)];
    const slowest = paces[paces.length - 1];

    summary += `\nPACE ANALYSIS (${roadRuns.length} road-like runs):\n`;
    summary += `  Fastest efforts: ${fastest5.map(formatPace).join(", ")}/mi\n`;
    summary += `  Median pace: ${formatPace(median)}/mi\n`;
    summary += `  Slowest easy: ${formatPace(slowest)}/mi\n`;
  }

  // Trail runs
  const trailRuns = activities.filter(
    (a) => a.activity_type === "TrailRun" || (a.elevation_gain || 0) > 150
  );
  if (trailRuns.length > 0) {
    summary += `\nTRAIL RUNS: ${trailRuns.length} of ${activities.length} recent runs are trail/high-vert\n`;
  }

  // HR data
  const withHR = activities.filter((a) => a.average_heartrate);
  if (withHR.length > 0) {
    const avgHR =
      withHR.reduce((sum, a) => sum + (a.average_heartrate || 0), 0) /
      withHR.length;
    const maxHR = Math.max(...withHR.map((a) => a.average_heartrate || 0));
    summary += `\nHEART RATE: avg ${Math.round(avgHR)} bpm across runs, highest avg ${maxHR} bpm\n`;
  }

  return summary;
}

function buildSystemPrompt(
  user: Record<string, unknown>,
  profile: Record<string, unknown> | null,
  state: Record<string, unknown> | null,
  recentMessages: Array<{
    role: string;
    content: string;
    message_type: string;
  }>,
  activitySummary: string,
  stravaStats?: Record<string, unknown>
): string {
  const conversationHistory = recentMessages
    .map((m) => `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`)
    .join("\n");

  // All-time stats from Strava
  let allTimeInfo = "";
  if (stravaStats) {
    const allRun = stravaStats.all_run_totals as {
      count?: number;
      distance?: number;
    } | null;
    if (allRun) {
      allTimeInfo = `- All-time: ${allRun.count || 0} runs, ${Math.round((allRun.distance || 0) / 1609.34)} miles\n`;
    }
  }

  const trainingDays = profile?.training_days
    ? (profile.training_days as string[]).join(", ")
    : "TBD";

  return `You are Coach Dean, an expert running coach communicating via text message. You specialize in trail running, ultra running, and periodized training. You are coaching ${user.name || "this athlete"} for ${profile?.goal ? formatGoalLabel(profile.goal as string) : "general fitness"}${profile?.race_date ? ` on ${profile.race_date}` : ""}.

TRAINING PHILOSOPHY:
- Follow periodized training: base → build → peak → taper
- 80/20 rule: ~80% easy effort, ~20% quality workouts
- Progressive overload: increase weekly mileage by no more than 10%/week
- Every 4th week is a recovery week (reduce volume 25-30%)
- Long runs progress by ~1 mile per week
- Quality workouts: tempo runs, intervals, race pace work (introduced in build phase)
- For trail races: include vert-specific training, technical downhill practice, power hiking

ATHLETE HISTORY:
${allTimeInfo}- Fitness level: ${profile?.fitness_level || "unknown"}
- Training days: ${trainingDays}
- Constraints: ${profile?.constraints || "None"}

${activitySummary}

CURRENT TRAINING STATE:
- Week ${state?.current_week || 1} of training, phase: ${state?.current_phase || "base"}
- Weekly mileage target: ${state?.weekly_mileage_target || "TBD"} mi
- Mileage so far this week: ${state?.week_mileage_so_far || 0} mi
- Current paces: Easy ${profile?.current_easy_pace || "TBD"}, Tempo ${profile?.current_tempo_pace || "TBD"}, Interval ${profile?.current_interval_pace || "TBD"}
- Last activity: ${state?.last_activity_summary ? JSON.stringify(state.last_activity_summary) : "None yet"}
- Active adjustments: ${state?.plan_adjustments || "None"}

COMMUNICATION STYLE:
- Text message tone: concise, encouraging, knowledgeable
- Use numbers and paces specifically — don't be vague
- Flag potential injury/overtraining signals directly
- It's okay to tell the user to rest or scale back
- Keep messages under 300 words
- Use occasional emoji sparingly

RECENT CONVERSATION:
${conversationHistory || "No previous messages."}`;
}

function formatGoalLabel(goal: string): string {
  const labels: Record<string, string> = {
    "5k": "a 5K",
    "10k": "a 10K",
    half_marathon: "a half marathon",
    marathon: "a marathon",
    general_fitness: "general fitness",
    "30k": "a 30K trail race",
    "50k": "a 50K ultra",
    "100k": "a 100K ultra",
  };
  return labels[goal] || goal;
}

function buildUserMessage(
  trigger: TriggerType,
  activityData: Record<string, unknown> | null
): string {
  switch (trigger) {
    case "morning_plan":
      return "Generate today's workout plan for this athlete. Consider their current training state, recent activity history and trends, and any adjustments needed. Be specific about distances, paces, and effort levels.";
    case "post_run":
      return `The athlete just completed a workout. Here are the details:\n${JSON.stringify(activityData, null, 2)}\n\nProvide post-run feedback analyzing their performance, noting what went well, any concerns, and what's coming up next. Reference their recent training trends.`;
    case "user_message":
      return "The athlete just sent you a message (see the most recent message in RECENT CONVERSATION above). Respond helpfully as their running coach. Use their activity history and training data to give specific, personalized advice.";
  }
}
