import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS } from "@/lib/linq";

type TriggerType = "morning_plan" | "post_run" | "user_message" | "initial_plan" | "weekly_recap" | "nightly_reminder" | "workout_image";

interface CoachRequest {
  userId: string;
  trigger: TriggerType;
  activityId?: number;
  imageActivity?: Record<string, unknown>; // Pre-extracted workout data from image upload
  dry_run?: boolean;
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
  const { userId, trigger, activityId, imageActivity, dry_run }: CoachRequest = await request.json();

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
  const userTimezone = (user.timezone as string) || "America/New_York";

  const systemPrompt = buildSystemPrompt(
    user,
    profile,
    state,
    recentMessages,
    activitySummary,
    stravaStats,
    userTimezone
  );

  // Build user message based on trigger
  const userMessage = buildUserMessage(trigger, activityData, imageActivity);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const coachMessage =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Send SMS (skip if dry run)
  if (!dry_run) await sendSMS(user.phone_number, coachMessage);

  // Store the response (skip if dry run)
  if (dry_run) return NextResponse.json({ ok: true, dry_run: true, message: coachMessage });

  await supabase.from("conversations").insert({
    user_id: userId,
    role: "assistant",
    content: coachMessage,
    message_type:
      trigger === "post_run"
        ? "post_run"
        : trigger === "morning_plan"
          ? "morning_plan"
          : "coach_response", // initial_plan, user_message, weekly_recap stored as coach_response
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
  stravaStats?: Record<string, unknown>,
  timezone?: string
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

  // Build date context in user's timezone
  const tz = timezone || "America/New_York";
  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const shortFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const todayStr = dateFormatter.format(now);

  // Pre-compute the next 7 days so Claude never has to calculate dates itself
  const upcomingDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
    return shortFormatter.format(d);
  });
  const tomorrowStr = upcomingDays[0];

  let dateContext = `DATE CONTEXT:\n- Today: ${todayStr}\n- Tomorrow: ${tomorrowStr}\n- Next 7 days: ${upcomingDays.join(", ")}\n- Timezone: ${tz}\n- Always use specific calendar dates (e.g. "Mon, Feb 23") rather than relative terms like "tomorrow" or "next Monday" — messages may be read after the day they're sent.\n`;
  if (profile?.race_date) {
    const raceDate = new Date((profile.race_date as string) + "T00:00:00");
    const daysUntil = Math.ceil((raceDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    const weeksUntil = Math.round(daysUntil / 7);
    dateContext += `- Race date: ${profile.race_date} (${daysUntil} days / ~${weeksUntil} weeks away)\n`;
    dateContext += `- Plan backwards from race date: allocate taper (2 weeks), peak (2-3 weeks), build, and base phases\n`;
  }

  const onboardingData = (user.onboarding_data as Record<string, unknown>) || {};
  const swimPace = onboardingData.swim_pace as string | null;
  const bikeInfo = onboardingData.bike_info as string | null;
  const weeklyHours = onboardingData.weekly_hours as number | null;
  const sportType = onboardingData.sport_type as string || "running";
  const isTri = ["sprint_tri", "olympic_tri", "70.3", "ironman"].includes(profile?.goal as string || "");

  return `You are Coach Dean, an expert endurance coach communicating via text message. You specialize in running, triathlon, cycling, and multi-sport periodized training. You are coaching ${user.name || "this athlete"} for ${profile?.goal ? formatGoalLabel(profile.goal as string) : "general fitness"}${profile?.race_date ? ` on ${profile.race_date}` : ""}.

${dateContext}
TRAINING PHILOSOPHY:
- Follow periodized training: base → build → peak → taper
- 80/20 rule: ~80% easy effort, ~20% quality workouts
- Progressive overload: increase weekly mileage by no more than 10%/week
- Every 4th week is a recovery week (reduce volume 25-30%)
- Long runs progress by ~1 mile per week
- Quality workouts: tempo runs, intervals, race pace work (introduced in build phase)
- For trail races: include vert-specific training, technical downhill practice, power hiking
- Match session format to the athlete's actual situation. Walk-jog intervals, time-based sessions, effort-capped easy runs, structured workouts — choose what's genuinely appropriate given their current volume, injury status, goal, and fitness history. Don't default to a rigid format based on mileage alone.

ATHLETE HISTORY:
${allTimeInfo}- Sport: ${sportType}
- Fitness level: ${profile?.fitness_level || "unknown"}
- Training days: ${trainingDays}
- Weekly volume: ${weeklyHours ? `~${weeklyHours} hours/week` : state?.weekly_mileage_target ? `${state.weekly_mileage_target} miles/week` : "unknown"}
- Injury / constraints: ${profile?.injury_notes || "None reported"}
${isTri ? `- Swim pace: ${swimPace || "unknown"}\n- Bike: ${bikeInfo || "unknown"}` : ""}

${activitySummary}

CURRENT TRAINING STATE:
- Week ${state?.current_week || 1} of training, phase: ${state?.current_phase || "base"}
- Weekly mileage target: ${state?.weekly_mileage_target || "TBD"} mi
- Mileage so far this week: ${state?.week_mileage_so_far || 0} mi
- Current paces: Easy ${profile?.current_easy_pace || "TBD"}, Tempo ${profile?.current_tempo_pace || "TBD"}, Interval ${profile?.current_interval_pace || "TBD"}
- Last activity: ${state?.last_activity_summary ? JSON.stringify(state.last_activity_summary) : "None yet"}
- Active adjustments: ${state?.plan_adjustments || "None"}

COMMUNICATION STYLE:
- Text message tone: concise, encouraging, knowledgeable — more like a supportive training partner than a strict authority
- Use numbers and paces specifically — don't be vague
- Keep responses to 2-3 short paragraphs max — responses should feel like texts from a coach, not essays. If a topic genuinely needs more detail, send multiple sequential short messages rather than one long wall of text.
- Use occasional emoji sparingly
- NEVER use asterisks, markdown bold/italic, or any special formatting characters — SMS does not render markdown and asterisks will appear literally in the message
- If the athlete uses metric units (km, kilometers, min/km), give all distances and paces in metric. If they use imperial (miles, min/mi), use imperial. Match their preference consistently throughout.

TONE WHEN ATHLETE RUNS FASTER THAN PRESCRIBED:
- Lead with genuine excitement — celebrate the effort and the fitness it reflects
- Then offer one brief, casual note about why the prescribed pace matters (adaptation, recovery), framed as context not criticism
- Never lecture or repeat the caution. Say it once, lightly, then move on
- If the athlete reports feeling fine, trust them and don't belabor it
- If they report heavy legs, fatigue, or soreness, gently suggest they listen to their body and offer to adjust upcoming sessions — but keep it low-key, not alarming
- Example framing: "That's a strong effort — your fitness is clearly there. Just keep an eye on how the legs feel tomorrow since that was a bigger stimulus than planned. Let me know if they're not fresh by Thursday and we'll dial it back."

TONE WHEN ATHLETE DOES A DIFFERENT WORKOUT THAN PRESCRIBED:
- Never make the athlete feel guilty or questioned for doing something different — life happens, plans change
- Acknowledge what they did do, positively, before anything else
- Briefly note the adjustment you'll make to the plan as a result (e.g. pushing the missed session, swapping next week's order) — keep it practical, not preachy
- If the swap was reasonable (e.g. easy run instead of tempo, shorter distance), treat it as a non-issue and just recalibrate
- If the deviation meaningfully affects the training block (e.g. skipped a key long run close to race day), flag it once in a neutral, matter-of-fact way and suggest how to adapt — no guilt
- Never ask the athlete to justify why they deviated
- Example framing: "No worries — easy days are always a good call when the body asks for it. I'll shift Thursday's tempo to Saturday and keep the long run as planned. You're still on track."

HANDLING UNKNOWN REFERENCES:
- If the athlete mentions a specific coach, athlete, or training philosophy (e.g. "Pfitzinger", "Lydiard", "80/20 method", "polarized training") that you are not fully confident you know well, do NOT guess or assume. Instead, ask the athlete to share the key principles of that approach so you can incorporate it accurately into their plan. This prevents bad advice and produces better personalization.

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
    sprint_tri: "a sprint triathlon",
    olympic_tri: "an Olympic-distance triathlon",
    "70.3": "a 70.3 Half Ironman",
    ironman: "a Full Ironman",
    cycling: "a cycling event",
  };
  return labels[goal] || goal;
}

function buildUserMessage(
  trigger: TriggerType,
  activityData: Record<string, unknown> | null,
  imageActivity?: Record<string, unknown>
): string {
  switch (trigger) {
    case "morning_plan":
      return "Generate today's workout plan for this athlete. Consider their current training state, recent activity history and trends, and any adjustments needed. Be specific about distances, paces, and effort levels.";
    case "post_run":
      return `The athlete just completed a workout. Here are the details:\n${JSON.stringify(activityData, null, 2)}\n\nProvide post-run feedback analyzing their performance, noting what went well, any concerns, and what's coming up next. Reference their recent training trends.`;
    case "user_message":
      return "The athlete just sent you a message (see the most recent message in RECENT CONVERSATION above). Respond helpfully as their running coach. Use their activity history and training data to give specific, personalized advice.";
    case "nightly_reminder":
      return "Send a brief nightly reminder for tomorrow's scheduled workout. Include the workout type (easy run, tempo, long run, etc.), the target distance, and the target pace. 2-3 sentences max — this is a gentle heads-up, not a full plan.";
    case "weekly_recap":
      return `Generate a weekly training recap and preview of the coming week (use DATE CONTEXT for the current day). If activity data is available for the past 7 days, analyze volume/paces/consistency and give 2-3 specific observations. If no activity data, ask how last week went and what they want to focus on next week. Either way, give a brief preview of the coming week's key sessions with specific dates. Keep it under 250 words.`;
    case "workout_image":
      return `The athlete just shared a workout screenshot. Here are the extracted details:\n${JSON.stringify(imageActivity || {}, null, 2)}\n\nProvide post-workout coaching feedback. Analyze their performance against their training paces and recent history. Note what went well, flag anything worth discussing (pace, HR, effort), and briefly mention what's next in their plan. Keep it concise — 2-3 short paragraphs, SMS tone.`;

    case "initial_plan":
      return `This athlete just completed onboarding. Generate their first week training plan.

1. Welcome them and acknowledge their goal and event date (use DATE CONTEXT for exact weeks remaining)
2. Briefly note their current fitness starting point
3. Give THIS WEEK's specific sessions — day by day with specific calendar dates (e.g. "Monday, Feb 23") for their scheduled training days, including session type, duration or distance, intensity/effort, and purpose

SPORT-SPECIFIC GUIDANCE:
- For runners: running sessions with paces or effort descriptions. Cross-training on off days if applicable.
- For triathletes: distribute swim, bike, and run sessions across the week appropriately for their goal distance. Include strength/yoga if they mentioned it. Use their stated paces/times as reference.
- For cyclists: rides with duration/distance and effort levels. Include any supplemental work they mentioned.
- For general fitness: mix of whatever makes sense for their lifestyle and any activities they mentioned.

Use your full coaching knowledge to determine the right session types, formats, intensities, and weekly structure for this specific person. Their goal, event date, fitness history, sport, injury status, and weekly volume all matter — don't apply a generic template.

VOLUME AND SAFETY:
- Don't exceed their current weekly volume in week 1. Apply the 10% rule from current baseline, not historical peak.
- If they have an injury, acknowledge it, explain how the plan accounts for it, and ask one follow-up question about constraints.
- If no injury, end with a brief open question about any niggles or schedule constraints.

Keep it conversational and specific. Under 300 words.`;
  }
}
