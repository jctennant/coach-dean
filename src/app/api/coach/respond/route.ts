import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { calculateVDOTPaces, estimatePacesFromEasyPace, easyPaceRange } from "@/lib/paces";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping, typingDurationMs } from "@/lib/linq";
import { trackEvent } from "@/lib/track";

export const maxDuration = 60;

type TriggerType = "morning_plan" | "post_run" | "user_message" | "initial_plan" | "weekly_recap" | "nightly_reminder" | "workout_image" | "welcome_message";

interface CoachRequest {
  userId: string;
  trigger: TriggerType;
  activityId?: number;
  imageActivity?: Record<string, unknown>; // Pre-extracted workout data from image upload
  dry_run?: boolean;
  chatId?: string; // Linq chat ID — passed directly so typing indicator works without a DB round-trip
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
  const body = await request.json();

  // For non-dry_run requests, return 200 immediately and do all the work in
  // after() so the caller (webhook) isn't left waiting on Claude + SMS time.
  if (!body.dry_run) {
    after(async () => {
      try {
        await processCoachRequest(body);
      } catch (err) {
        console.error("[coach/respond] unhandled error in after():", err);
      }
    });
    return NextResponse.json({ ok: true });
  }

  // dry_run: process inline so the caller gets the generated message back
  return await processCoachRequest(body);
}

async function processCoachRequest(body: CoachRequest): Promise<NextResponse> {
  const { userId, trigger, activityId, imageActivity, dry_run, chatId: requestChatId } = body;

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

  const shouldUseWebSearch = trigger === "user_message" || trigger === "initial_plan";

  const systemPrompt = buildSystemPrompt(
    user,
    profile,
    state,
    recentMessages,
    activitySummary,
    stravaStats,
    userTimezone,
    shouldUseWebSearch
  );

  // Build user message based on trigger
  const userMessage = buildUserMessage(trigger, activityData, imageActivity);

  // Prefer chatId passed directly in the request (avoids a DB round-trip and
  // works even before linq_chat_id is persisted). Fall back to the stored value.
  const chatId = requestChatId ?? (user.linq_chat_id as string | null) ?? null;
  console.log("[coach/respond] chatId:", chatId, "trigger:", trigger);

  // Show typing indicator before generating, then keep it alive every 4.5s
  // during Claude's response. Most platforms auto-clear "..." after ~5-10s
  // without a refresh, so a single call often expires before the message arrives.
  let keepTypingAlive = false;
  if (!dry_run && chatId) {
    console.log("[coach/respond] starting typing indicator");
    await startTyping(chatId);
    keepTypingAlive = true;
    const refreshId = chatId;
    void (async () => {
      while (keepTypingAlive) {
        await new Promise((r) => setTimeout(r, 4500));
        if (keepTypingAlive) void startTyping(refreshId);
      }
    })();
  }
  const typingStartMs = Date.now();

  // For initial_plan, set awaiting_cadence BEFORE calling Claude so the routing
  // is in place even if the function times out mid-send. Don't void — this is critical.
  if (trigger === "initial_plan") {
    await supabase.from("users").update({ onboarding_step: "awaiting_cadence" }).eq("id", userId);
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    ...(shouldUseWebSearch
      ? { tools: [{ type: "web_search_20250305" as const, name: "web_search" }] }
      : {}),
  });

  // Stop the typing refresh loop — generation is done, message is about to send.
  keepTypingAlive = false;

  // Web search splits Claude's response across multiple text blocks: text generated
  // before each search call, and text generated after. Joining them all reconstructs
  // the full response. (Without search, there's only one text block — join is a no-op.)
  const coachMessage = stripMarkdown(
    response.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("")
  );

  if (dry_run) return NextResponse.json({ ok: true, dry_run: true, message: coachMessage });

  // Split into iMessage-sized chunks. Each part is sent as a separate text
  // with its own typing indicator so it feels like a real person composing
  // multiple follow-up messages.
  const parts = splitIntoMessages(coachMessage);
  const msgType =
    trigger === "post_run"
      ? "post_run"
      : trigger === "morning_plan"
        ? "morning_plan"
        : trigger === "nightly_reminder"
          ? "nightly_reminder"
          : trigger === "weekly_recap"
            ? "weekly_recap"
            : "coach_response";

  let learnedChatId: string | null = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (i === 0) {
      // First part: typing indicator was started before generation.
      // Wait only the time remaining to hit the proportional target.
      const target = typingDurationMs(part.length);
      const elapsed = Date.now() - typingStartMs;
      const remaining = Math.max(0, target - elapsed);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    } else {
      // Subsequent parts: restart typing, pause briefly to feel like composing.
      if (chatId) await startTyping(chatId);
      const composeMs = Math.min(2000, Math.max(800, part.length * 8));
      await new Promise((r) => setTimeout(r, composeMs));
    }

    const { chatId: returnedChatId } = await sendSMS(user.phone_number, part);
    if (returnedChatId && !learnedChatId) learnedChatId = returnedChatId;

    await supabase.from("conversations").insert({
      user_id: userId,
      role: "assistant",
      content: part,
      message_type: msgType,
      strava_activity_id: activityId || null,
    });
  }

  // Persist chatId if we learned it for the first time
  if (learnedChatId && !chatId) {
    void supabase
      .from("users")
      .update({ linq_chat_id: learnedChatId })
      .eq("id", userId);
  }

  void trackEvent(userId, "coaching_response_sent", { trigger, onboarding: false });

  if (trigger === "initial_plan") {
    void trackEvent(userId, "plan_generated", { plan_type: "initial" });

  } else if (trigger === "weekly_recap") {
    void trackEvent(userId, "plan_generated", { plan_type: "weekly" });
  }

  // For user_message, background-extract any profile updates (injuries, new cross-training,
  // preferences) and write them back to training_profiles / onboarding_data so future
  // responses and plans automatically reflect what the athlete shared.
  if (trigger === "user_message") {
    const latestUserMsg = [...recentMessages].reverse().find(m => m.role === "user");
    if (latestUserMsg) {
      void extractAndPersistProfileUpdates(
        userId,
        latestUserMsg.content,
        profile,
        (user.onboarding_data as Record<string, unknown>) || {}
      );
    }
  }

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
 * Strip markdown formatting that Claude occasionally generates despite instructions.
 * SMS renders all characters literally — asterisks, hashes, etc. appear as-is.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1") // **bold** → bold
    .replace(/\*([^*\n]+)\*/g, "$1")      // *italic* → italic
    .replace(/`([^`\n]+)`/g, "$1")        // `code` → code
    .replace(/^#+\s+/gm, "")             // ## Header → Header
    .replace(/^[-•]\s+/gm, "")           // - bullet or • bullet → plain line
    .trim();
}

/**
 * Split a coach response into iMessage-sized chunks (≤ MAX_CHARS each).
 *
 * Strategy:
 *   1. Split on blank lines (paragraph breaks) — Claude is prompted to use these.
 *   2. If any paragraph still exceeds MAX_CHARS, split further at sentence boundaries.
 *
 * Each chunk is sent as a separate text message with its own typing indicator,
 * so it feels like a real person sending a few short follow-up texts.
 */
const MAX_MSG_CHARS = 480;

function splitIntoMessages(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_MSG_CHARS) return [trimmed];

  const chunks: string[] = [];
  const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  let current = "";

  for (const para of paragraphs) {
    if (para.length > MAX_MSG_CHARS) {
      // Flush current buffer first
      if (current) { chunks.push(current); current = ""; }

      // Split long paragraph at sentence boundaries
      const sentences = para.match(/[^.!?…]+(?:[.!?…]+\s*|$)/g) ?? [para];
      for (const raw of sentences) {
        const s = raw.trim();
        if (!s) continue;
        if (!current) {
          current = s;
        } else if (current.length + 1 + s.length <= MAX_MSG_CHARS) {
          current += " " + s;
        } else {
          chunks.push(current);
          current = s;
        }
      }
    } else if (!current) {
      current = para;
    } else if (current.length + 2 + para.length <= MAX_MSG_CHARS) {
      // Fits in the same bubble — join with a single newline (not blank line)
      current += "\n" + para;
    } else {
      chunks.push(current);
      current = para;
    }
  }

  if (current) chunks.push(current);
  return chunks.filter((c) => c.length > 0);
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

  // Individual workout log — chronological (oldest first) so Claude can list them in order
  const recent = [...activities].reverse().slice(-20);
  summary += `\nRECENT WORKOUTS (chronological, oldest first):\n`;
  for (const a of recent) {
    const d = new Date(a.start_date);
    const dateLabel = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const miles = a.distance_meters ? (a.distance_meters / 1609.34).toFixed(1) : null;
    const parts = [
      a.activity_type || "Workout",
      miles ? `${miles}mi` : null,
      a.average_pace ? `@ ${a.average_pace}` : null,
      a.elevation_gain ? `${Math.round(a.elevation_gain)}ft vert` : null,
    ].filter(Boolean);
    summary += `  ${dateLabel}: ${parts.join(", ")}\n`;
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
    created_at?: string;
  }>,
  activitySummary: string,
  stravaStats?: Record<string, unknown>,
  timezone?: string,
  hasWebSearch?: boolean
): string {
  const tz2 = timezone || "America/New_York";
  const msgFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz2,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const conversationHistory = recentMessages
    .map((m) => {
      const ts = m.created_at ? `[${msgFormatter.format(new Date(m.created_at))}] ` : "";
      return `${ts}${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`;
    })
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
  const todayStr = dateFormatter.format(now);

  // Determine today's calendar date in the user's local timezone, then build
  // the next 7 days using explicit UTC date arithmetic so the weekday and date
  // always align correctly. Using Date.UTC avoids any server-timezone influence.
  // We use "en-CA" to get "YYYY-MM-DD" format reliably.
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const [ty, tm, td] = todayLocal.split("-").map(Number);

  // Full weekday name ("Friday, Feb 27") matches the long format used for
  // todayStr and eliminates any ambiguity from abbreviated day names.
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  // Pre-compute the next 7 days using explicit calendar arithmetic.
  // Joined with " | " so the comma inside "Friday, Feb 27" is never confused
  // with the list separator.
  const upcomingDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(ty, tm - 1, td + i + 1));
    return dayFormatter.format(d);
  });
  const tomorrowStr = upcomingDays[0];

  let dateContext = `DATE CONTEXT:\n- Today: ${todayStr}\n- Tomorrow: ${tomorrowStr}\n- Next 7 days: ${upcomingDays.join(" | ")}\n- Timezone: ${tz}\n- Always use specific calendar dates (e.g. "Friday, Feb 27") rather than relative terms like "tomorrow" or "next Monday" — messages may be read after the day they're sent.\n`;
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
  // Additional athlete preferences captured during onboarding (strengthening, cross-training
  // requests, injury prevention goals, race history notes, etc.)
  const otherNotes = onboardingData.other_notes as string | null;
  const crosstrainingTools = (profile?.crosstraining_tools as string[] | null)?.filter(Boolean);

  // TODO: Once Strava API app is approved, update "Activity tracking" in PRODUCT CAPABILITIES below to:
  // "Activity tracking: Strava only. No Garmin, Apple Watch, Wahoo, etc."
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

GRADE-ADJUSTED PACE — apply this any time you prescribe a treadmill or trail workout with significant elevation:
- Each 1% of grade adds roughly 8-12 seconds/mile of equivalent effort. At 8% grade that's 64-96 seconds/mile harder than the same pace on flat.
- Never pair a flat easy pace with a steep grade and call it easy. A runner whose easy flat pace is 9:30/mile should be running ~11:00-11:30/mile at 8% grade to stay at the same effort.
- When prescribing treadmill intervals with grade: set the effort level first ("easy", "moderate", "hard"), then derive a pace that actually matches that effort at the stated grade — do not borrow a flat-ground pace and attach it to a steep grade.
- The same applies to hilly trail workouts: if a trail segment averages 8-10% grade, the athlete's pace will and should be much slower than their flat easy pace. Don't flag this as "slow" — it's correct.

ATHLETE HISTORY:
${allTimeInfo}- Sport: ${sportType}
- Fitness level: ${profile?.fitness_level || "unknown"}
- Training days: ${trainingDays}
- Weekly volume: ${weeklyHours ? `~${weeklyHours} hours/week` : state?.weekly_mileage_target ? `${state.weekly_mileage_target} miles/week` : "unknown"}
- Injury / constraints: ${profile?.injury_notes || "None reported"}
- Cross-training available: ${crosstrainingTools && crosstrainingTools.length > 0 ? crosstrainingTools.join(", ") : "None mentioned"}
${otherNotes ? `- Athlete preferences / notes: ${otherNotes}\n` : ""}${isTri ? `- Swim pace: ${swimPace || "unknown"}\n- Bike: ${bikeInfo || "unknown"}` : ""}

${activitySummary}

CURRENT TRAINING STATE:
- Week ${state?.current_week || 1} of training, phase: ${state?.current_phase || "base"}
- Weekly mileage target: ${state?.weekly_mileage_target || "TBD"} mi
- Mileage so far this week: ${state?.week_mileage_so_far || 0} mi
- Current paces: Easy ${easyPaceRange(profile?.current_easy_pace as string ?? null) || "TBD"}, Tempo ${profile?.current_tempo_pace || "TBD"}, Interval ${profile?.current_interval_pace || "TBD"}
- Last activity: ${state?.last_activity_summary ? JSON.stringify(state.last_activity_summary) : "None yet"}
- Active adjustments: ${state?.plan_adjustments || "None"}

COMMUNICATION STYLE:
You are texting over iMessage. Write exactly like a real human coach would text — not an email, not a report, not a bullet-point summary.

LENGTH — this is the most important rule:
- Keep responses under 480 characters. Most replies should be a single short text.
- If you genuinely need more space, you can split into 2–3 messages by separating them with a blank line — the system will send each as its own bubble. But this isn't required; one tight message is usually better.
- When in doubt, cut it. A short reply that nails the key point beats a long reply that covers everything.

TONE:
- Cut filler openers. Never start with "Great job!", "Awesome!", "That's fantastic!" — get straight to the substance. Specific, earned praise ("That negative split shows real fitness") is fine; generic openers are not.
- No sign-offs, no "Let me know if you have questions", no "You've got this!" at the end.
- Sound like a knowledgeable friend, not a customer service bot.
- Use specific numbers for paces and distances. Only state specific dates when they appear explicitly in the data provided to you (activity dates, race date, DATE CONTEXT). Never invent or guess a date.
- One emoji max per response. Often none is better.

FORMATTING:
- NEVER use asterisks, markdown bold/italic, bullet points, or dashes as list markers — SMS does not render markdown and they appear as raw characters.
- If the athlete uses metric (km, min/km), respond in metric. If imperial (miles, min/mi), respond in imperial. Match consistently.

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

MEMORY AND DATA LIMITATIONS:
- You only have access to: the last 15 conversation messages, the athlete's activity history (visible in RECENT WORKOUTS), their profile, and today's date context. Nothing else.
- Never state when the athlete first reached out, when they signed up, or what was said in conversations not shown above. You don't have that information.
- If asked about something outside your data window, be honest: "I don't have that far back in our conversation history" is fine. Fabricating a confident answer is not — it destroys trust when the athlete knows you're wrong.
- When in doubt about a historical fact, omit it or flag uncertainty. Never invent specifics.

PRODUCT CAPABILITIES — what Coach Dean actually supports:
- Activity tracking: none currently. There is no automatic sync with Strava, Garmin, Apple Watch, Wahoo, or any other platform right now. Athletes report workouts by texting you directly or sharing screenshots of a workout.
- Communication: SMS only. No app, no web dashboard, no email.
- Proactive reminders: evening-before reminders (the night before a session) and weekly Sunday overviews are supported. Morning reminders or any specific time (8am, noon, etc.) are NOT supported.
- If an athlete asks for morning reminders or says anything like "you can text me in the morning" or "morning of works for me", do NOT agree. Correct it directly: "I can only send reminders the evening before — no morning option yet." Then confirm that's what you'll do.
- NEVER say "I'll check in Thursday morning" or "I'll text you in the morning" — you can't. Always say "I'll send you a reminder Wednesday evening" (i.e. the evening before). If you're unsure of the day, just say "I'll send you a reminder the evening before your next run."
- If an athlete asks how to connect Garmin, Strava, Apple Health, or any other service, tell them clearly: "I don't have automatic sync set up yet — just text me after your workouts and I'll track from there." Do NOT invent a setup flow or imply an integration exists that doesn't.
- If asked about a feature that doesn't exist (a web dashboard, export, calendar sync, etc.), say you don't have that yet rather than fabricating instructions.

STRENGTH, MOBILITY & CROSS-TRAINING — include on rest days when appropriate:
- Include a strength/mobility session when the athlete has injury notes, has asked for strength or stretching, or has gym/yoga listed as cross-training. Tailor exercises to their specific injury or needs.
- Include cross-training when they've listed tools (bike, pool, elliptical, yoga, etc.) or asked for it.
- Format in the plan as e.g. "Strength + mobility 20 min" or "Easy bike 45 min" — brief and specific.
- If none of the above apply, do NOT add strength or cross-training unprompted.

HANDLING UNKNOWN REFERENCES:
- If the athlete mentions a specific coach, athlete, or training philosophy (e.g. "Pfitzinger", "Lydiard", "80/20 method", "polarized training") that you are not fully confident you know well, do NOT guess or assume. Instead, ask the athlete to share the key principles of that approach so you can incorporate it accurately into their plan. This prevents bad advice and produces better personalization.

${hasWebSearch ? `WEB SEARCH:
You have access to web search. Use it proactively when:
- The athlete mentions a specific race, event, or trail by name — search for course details, elevation profile, terrain, cutoff times
- The athlete asks about something requiring current or specific information you're not fully confident about (race logistics, course records, a specific training methodology)
- You need factual details about a route, venue, or event to give accurate training advice
Do NOT search for general training concepts, coaching methodology, or things you already know well.
` : ""}RECENT CONVERSATION:
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

/**
 * Background function: extracts any new injury notes, cross-training tools, or preference
 * changes from the athlete's message and persists them to training_profiles and onboarding_data.
 * Called fire-and-forget for user_message triggers so future responses reflect current context.
 */
async function extractAndPersistProfileUpdates(
  userId: string,
  message: string,
  profile: Record<string, unknown> | null,
  onboardingData: Record<string, unknown>
): Promise<void> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: `Extract structured data from an athlete's message to their coach.

Extract ONLY explicitly stated NEW information:
- A new or changed injury, pain, or physical limitation → injury_notes (brief: type + status, e.g. "IT band tightness, started this week")
- New cross-training activities or equipment access mentioned (pool, bike, gym, yoga, etc.) → new_crosstraining (array of normalized strings)
- New training preferences, goals, or constraints (e.g. "I want more hill work", "please add strength training", "I can't run Tuesdays anymore") → other_notes
- A PR or recent race time → recent_race_distance_km + recent_race_time_minutes. Distances: 5K=5, 10K=10, half=21.0975, marathon=42.195, 1mi=1.609. If given as a pace (e.g. "5K PR pace is 5:40/mi"), compute total time: pace_sec/mile × distance_in_miles / 60 (5K=3.107mi, 10K=6.214mi, half=13.109mi, marathon=26.219mi).
- A comfortable/easy running pace (NOT a race or PR pace) → easy_pace as M:SS per mile. Convert from km if needed (÷0.621).
- A completed workout the athlete is reporting (e.g. "did a 10 mile run", "just finished 45 min easy", "rode 30 miles this morning") → workout with fields:
  - activity_type: one of "Run", "Ride", "Swim", "Walk", "TrailRun", "WeightTraining", "Yoga", "Other"
  - distance_meters: convert miles×1609.34 or km×1000 (null if not stated)
  - moving_time_seconds: convert from minutes or hours (null if not stated)
  - average_pace: as "M:SS/mi" for runs (null if not stated or not a run)
  - elevation_gain: in meters, convert from feet÷3.281 (null if not stated)
  - date_offset: 0 for today, -1 for yesterday (default 0)

Output: {"injury_notes": string | null, "new_crosstraining": string[] | null, "other_notes": string | null, "recent_race_distance_km": number | null, "recent_race_time_minutes": number | null, "easy_pace": string | null, "workout": {"activity_type": string, "distance_meters": number | null, "moving_time_seconds": number | null, "average_pace": string | null, "elevation_gain": number | null, "date_offset": number} | null}

Return {} if nothing new is present.`,
      messages: [{ role: "user", content: message }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
    let extracted: {
      injury_notes?: string | null;
      new_crosstraining?: string[] | null;
      other_notes?: string | null;
      recent_race_distance_km?: number | null;
      recent_race_time_minutes?: number | null;
      easy_pace?: string | null;
      workout?: {
        activity_type: string;
        distance_meters: number | null;
        moving_time_seconds: number | null;
        average_pace: string | null;
        elevation_gain: number | null;
        date_offset: number;
      } | null;
    } = {};
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      return;
    }

    const hasInjury = !!extracted.injury_notes;
    const hasCrosstraining = Array.isArray(extracted.new_crosstraining) && extracted.new_crosstraining.length > 0;
    const hasOtherNotes = !!extracted.other_notes;
    const hasRaceData = !!(extracted.recent_race_distance_km && extracted.recent_race_time_minutes);
    const hasEasyPace = !!extracted.easy_pace;
    const hasWorkout = !!extracted.workout;

    if (!hasInjury && !hasCrosstraining && !hasOtherNotes && !hasRaceData && !hasEasyPace && !hasWorkout) return;

    console.log("[coach/respond] persisting profile updates from user message:", extracted);

    // Compute VDOT paces if race data provided, otherwise use easy pace estimate
    let computedPaces: { easy: string; tempo: string; interval: string } | null = null;
    if (hasRaceData) {
      computedPaces = calculateVDOTPaces(
        extracted.recent_race_distance_km as number,
        extracted.recent_race_time_minutes as number
      );
    } else if (hasEasyPace) {
      const p = estimatePacesFromEasyPace(extracted.easy_pace as string);
      if (p.easy) computedPaces = { easy: p.easy, tempo: p.tempo ?? "", interval: p.interval ?? "" };
    }

    // Build profile update
    const profileUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (hasInjury) profileUpdate.injury_notes = extracted.injury_notes;
    if (hasCrosstraining) {
      const existing = (profile?.crosstraining_tools as string[]) || [];
      profileUpdate.crosstraining_tools = Array.from(new Set([...existing, ...(extracted.new_crosstraining as string[])]));
    }
    if (computedPaces) {
      profileUpdate.current_easy_pace = computedPaces.easy;
      if (computedPaces.tempo) profileUpdate.current_tempo_pace = computedPaces.tempo;
      if (computedPaces.interval) profileUpdate.current_interval_pace = computedPaces.interval;
    }

    // Build onboarding_data update
    const updatedOnboardingData = { ...onboardingData };
    if (hasOtherNotes) {
      const existing = (onboardingData.other_notes as string) || "";
      updatedOnboardingData.other_notes = existing
        ? `${existing}; ${extracted.other_notes}`
        : (extracted.other_notes as string);
    }

    // Write manual workout to activities table if reported
    if (hasWorkout && extracted.workout) {
      const w = extracted.workout;
      const activityDate = new Date();
      activityDate.setDate(activityDate.getDate() + (w.date_offset ?? 0));
      activityDate.setHours(12, 0, 0, 0); // noon local — we don't know exact time

      // Dedup: skip if we already have an activity for this user on this date with similar distance
      const dateStr = activityDate.toISOString().slice(0, 10);
      const { data: existing } = await supabase
        .from("activities")
        .select("id, distance_meters")
        .eq("user_id", userId)
        .gte("start_date", `${dateStr}T00:00:00Z`)
        .lte("start_date", `${dateStr}T23:59:59Z`);

      const isDuplicate = existing?.some((row) => {
        if (!w.distance_meters || !row.distance_meters) return false;
        return Math.abs(row.distance_meters - w.distance_meters) < 200; // within ~200m
      });

      if (!isDuplicate) {
        console.log("[coach/respond] writing manual activity from user message:", w);
        await supabase.from("activities").insert({
          user_id: userId,
          activity_type: w.activity_type,
          distance_meters: w.distance_meters,
          moving_time_seconds: w.moving_time_seconds,
          average_pace: w.average_pace,
          elevation_gain: w.elevation_gain,
          start_date: activityDate.toISOString(),
          source: "manual",
        });
      } else {
        console.log("[coach/respond] skipping duplicate manual activity for", dateStr);
      }
    }

    await Promise.all([
      Object.keys(profileUpdate).length > 1
        ? supabase.from("training_profiles").update(profileUpdate).eq("user_id", userId)
        : Promise.resolve(),
      hasOtherNotes
        ? supabase.from("users").update({ onboarding_data: updatedOnboardingData }).eq("id", userId)
        : Promise.resolve(),
    ]);
  } catch (err) {
    console.error("[coach/respond] extractAndPersistProfileUpdates failed:", err);
  }
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
    case "welcome_message":
      return `Send a short, warm message the evening before this athlete's very first training session. Two goals: (1) wish them luck for tomorrow, and (2) let them know they can text you anytime — not just after runs, but with any question about training, how something feels, pacing, nutrition, cross-training, anything. Make it personal: reference their specific goal, and if they mentioned any injury or concern during onboarding, acknowledge it naturally (e.g. "if the back talks to you at any point, just let me know"). One short message, no more than 2-3 sentences. Warm and human — not a feature announcement.`;

    case "nightly_reminder":
      return `Send a short reminder text about tomorrow's workout. Three parts, all on one message:

1. A brief, natural opener — vary it each time so it doesn't feel canned. Options: "Tomorrow's workout:", "Here's what's on for tomorrow:", use their name casually ("Hey [name], tomorrow:"), reference the day ("Wednesday's session:"), etc. Mix it up.

2. The workout — type, distance, and target pace or effort. One or two sentences max.

3. A short, warm closer — vary this too. Rotate through things like "Good luck!", "Let me know how it goes.", "Have fun out there.", "You've got this.", "Enjoy the run.", etc. One short phrase, nothing more.

Keep the whole thing under 480 characters. No markdown, no bullet points. Sound like a real coach texting, not a notification from an app.`;
    case "weekly_recap":
      return `Send 2–3 short texts recapping last week and previewing the coming week (use DATE CONTEXT for exact dates). Each text under 480 characters, separated by a blank line. First text: last week summary (mileage, one specific observation). Second: this week's key sessions. Third (optional): one brief note on the training focus. No intro fluff.

For the sessions text, put each session on its own line using this compact format:
Mon 3/2 · Easy 5mi @ 9:30/mi
Wed 3/4 · Tempo 4mi (2mi @ 8:45)
Sat 3/7 · Long run 8mi easy
Use short day abbreviations (Mon/Tue/Wed/Thu/Fri/Sat/Sun) and M/D date format. No prose between sessions.

STRENGTH & CROSS-TRAINING: If the athlete has injury notes or has requested strength/mobility work, include a "Strength + mobility" session on a rest day in the week preview (see STRENGTH, MOBILITY & CROSS-TRAINING in system prompt). If they have cross-training tools, include a cross-training day where appropriate.

MILEAGE ACCURACY: If you state a weekly total (e.g. "28 miles this week"), you must first add up every individual session distance you've listed and confirm the sum matches. Never state a total that doesn't equal the sum of the sessions you've written. If you're not listing every session, don't state a total — just describe the key sessions.`;
    case "workout_image":
      return `The athlete just shared a workout screenshot. Here are the extracted details:\n${JSON.stringify(imageActivity || {}, null, 2)}\n\nSend 1–2 short texts as post-workout feedback. First text: one specific reaction to their performance (pace, effort, HR — whatever is most notable). Second text (only if needed): what's next. Each under 480 characters. No generic openers.`;

    case "initial_plan":
      return `This athlete just finished onboarding. Send them an initial week plan — framed as a starting point, not a finished prescription. The goal is to get something in front of them quickly and invite them to shape it.

VOLUME AND SAFETY:
- Be conservative in week 1. Start at or below their stated baseline — do not apply the 10% growth rule yet.
- For athletes coming back from injury, returning after a long break, or with low current mileage: start shorter than you might think. It's easier to add than to walk back an overambitious first week.
- Address any injury or physical limitation directly in the plan itself — briefly note how the plan accounts for it. Do NOT ask a follow-up question about it.

ULTRA DISTANCE GOALS (50K, 100K, and beyond):
- Do NOT apply beginner conservatism. Anyone training for an ultra is already running meaningful volume — calibrate to their stated mileage, not a cautious floor.
- Long run in week 1 should reflect ultra training reality: at minimum 10–12mi, and up to 16–18mi if their weekly mileage supports it. A 6mi long run for a 100K athlete is not appropriate.
- Time-on-feet matters more than pace. Frame long runs by duration or easy effort, not a specific pace target.
- For mountain/technical ultras (Black Canyon, Western States, etc.) include vert-specific work and power hiking from the start — not just later in the build.
- If a finish time goal is given (e.g. "under 18 hours"), use it to infer experience level and calibrate the plan accordingly. An 18-hour 100K is not a beginner finishing.

SPORT-SPECIFIC GUIDANCE:
- Runners: runs with effort or pace. On rest days: if the athlete has injury notes or requested strength/mobility work, replace one rest day with a tailored strength + mobility session (see STRENGTH, MOBILITY & CROSS-TRAINING in system prompt). Include cross-training on off days if they mentioned it.
- Triathletes: distribute swim/bike/run appropriately. Include strength/yoga if mentioned.
- Cyclists: rides with duration and effort. Include any supplemental work they mentioned.
- General fitness: whatever makes sense given their lifestyle and activities mentioned.

MILEAGE ACCURACY: Never state a weekly total unless you've verified it equals the sum of every session listed.

Write as 2 short iMessage texts separated by a blank line. Each under 480 characters.

First bubble: 1-2 sentences that acknowledge the most important constraint or context the athlete just shared (injury, lifting schedule, recent mileage, etc.) and frame what follows as your initial thinking, not the final word. Do NOT open with "Got it" or any generic acknowledgment phrase — get straight to the substance. Do NOT restate their goal back to them.

Second bubble: this week's sessions, one per line:
Mon 3/2 · Easy 3mi @ easy effort
Wed 3/4 · Easy 3mi
Sat 3/7 · Easy 4mi
Use short day abbreviations and M/D dates. Then on a new line at the end: invite feedback and ask the cadence question together — e.g. "How does this feel? Happy to adjust anything. And — want evening reminders before each session, or just a weekly overview on Sundays?"

ONE QUESTION RULE: The closing line above is the only question in the entire response. Do not ask anything else — no follow-ups about injuries, niggles, schedule, or anything else. If you want to flag something about an injury or constraint, state it as information ("I've kept this conservative given your hip") not as a question.`;

  }
}
