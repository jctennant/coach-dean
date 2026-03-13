import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { calculateVDOTPaces, estimatePacesFromEasyPace, easyPaceRange } from "@/lib/paces";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping, typingDurationMs } from "@/lib/linq";
import { trackEvent } from "@/lib/track";
import { fetchWeekWeather, buildWeatherBlock } from "@/lib/weather";
import type { Json } from "@/lib/database.types";

export const maxDuration = 60;

type TriggerType = "morning_plan" | "post_run" | "user_message" | "initial_plan" | "weekly_recap" | "nightly_reminder" | "morning_reminder" | "workout_image";

interface CoachRequest {
  userId: string;
  trigger: TriggerType;
  activityId?: number;
  imageActivity?: Record<string, unknown>; // Pre-extracted workout data from image upload
  dry_run?: boolean;
  chatId?: string; // Linq chat ID — passed directly so typing indicator works without a DB round-trip
  includeWorkoutCheckin?: boolean; // True when we want to check in on the previous session alongside the reminder
}

interface ActivityRow {
  activity_type: string;
  distance_meters: number;
  moving_time_seconds: number;
  average_heartrate: number | null;
  elevation_gain: number | null;
  average_pace: string;
  start_date: string;
  average_cadence: number | null;
  gear_name: string | null;
}

interface CoachingSignals {
  avgCadenceSpm: number | null;          // avg spm across recent runs; flag if < 170
  weekOverWeekRampPct: number | null;    // % change between last two complete weeks
  totalTrackedMiles: number;             // proxy for shoe mileage
  hasRecentLongEffort: boolean;          // run ≥ 10 mi or ≥ 75 min in last 14 days
  dominantGear: string | null;           // most-used shoe name if available
  daysUntilRace: number | null;          // null if no race date or race has passed
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
  const { userId, trigger, activityId, imageActivity, dry_run, chatId: requestChatId, includeWorkoutCheckin } = body;

  // Fetch user context in parallel
  const [
    userResult,
    profileResult,
    stateResult,
    conversationsResult,
    recentActivitiesResult,
    raceHistoryResult,
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
        "activity_type, distance_meters, moving_time_seconds, average_heartrate, elevation_gain, average_pace, start_date, average_cadence, gear_name"
      )
      .eq("user_id", userId)
      .order("start_date", { ascending: false })
      .limit(50),
    supabase
      .from("activities")
      .select("activity_type, distance_meters, average_pace, start_date, workout_type")
      .eq("user_id", userId)
      .eq("workout_type", 1)
      .order("start_date", { ascending: false })
      .limit(20),
  ]);

  const user = userResult.data;
  const profile = profileResult.data;
  const state = stateResult.data;
  const recentMessages = conversationsResult.data?.reverse() || [];
  const recentActivities =
    (recentActivitiesResult.data as ActivityRow[] | null) || [];
  const raceHistory =
    (raceHistoryResult.data as Array<Record<string, unknown>> | null) || [];

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
  const userTimezone = (user.timezone as string) || "America/New_York";
  const activitySummary = buildActivitySummary(recentActivities, userTimezone);
  const weekMileageSoFar = computeWeekMileage(recentActivities, userTimezone);
  const weekRunCount = computeWeekRunCount(recentActivities, userTimezone);
  const avgWeeklyMileage = computeAvgWeeklyMileage(recentActivities, userTimezone);
  const coachingSignals = computeCoachingSignals(recentActivities, userTimezone, profile?.race_date as string | null);
  const stravaStats = (
    user.onboarding_data as Record<string, unknown> | null
  )?.strava_stats as Record<string, unknown> | undefined;

  // Fetch weather for triggers where upcoming conditions matter
  // (skip post_run and user_message where it's rarely relevant)
  const weatherTriggers = new Set<TriggerType>(["weekly_recap", "morning_reminder", "nightly_reminder", "initial_plan", "morning_plan"]);
  const onboardingData = (user.onboarding_data as Record<string, unknown>) || {};
  const stravaCity = onboardingData.strava_city as string | null;
  const stravaState = onboardingData.strava_state as string | null;
  let weatherBlock = "";
  if (weatherTriggers.has(trigger) && stravaCity && stravaState) {
    const forecast = await fetchWeekWeather(stravaCity, stravaState, userTimezone).catch(() => null);
    if (forecast) weatherBlock = buildWeatherBlock(forecast, userTimezone);
  }

  const shouldUseWebSearch = trigger === "user_message" || trigger === "initial_plan";

  const systemPrompt = buildSystemPrompt(
    user,
    profile,
    state,
    recentMessages,
    activitySummary,
    weekMileageSoFar,
    weekRunCount,
    raceHistory,
    stravaStats,
    userTimezone,
    shouldUseWebSearch,
    avgWeeklyMileage,
    coachingSignals,
    weatherBlock
  );

  // Build user message based on trigger
  const injuryNotes = (profile?.injury_notes as string | null) || null;
  const userMessage = buildUserMessage(trigger, activityData, imageActivity, includeWorkoutCheckin, injuryNotes, userTimezone);

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

  // When web search is used, Claude emits text blocks BEFORE each tool call (narration/
  // reasoning) and then a final text block with the actual response. Only the last text
  // block is the intended output — concatenating all blocks leaks internal reasoning.
  // Without search there is only one text block, so last === only.
  const textBlocks = response.content.filter(b => b.type === "text");
  const rawText = textBlocks.length > 0
    ? (textBlocks[textBlocks.length - 1] as { type: "text"; text: string }).text
    : "";
  const coachMessage = correctMileageTotal(stripMarkdown(rawText));

  if (dry_run) return NextResponse.json({ ok: true, dry_run: true, message: coachMessage });

  // Claude signals "nothing to send" with [NO_REPLY] — skip all SMS and DB writes.
  if (coachMessage.trim() === "[NO_REPLY]") {
    console.log("[coach/respond] Claude returned [NO_REPLY] — skipping send");
    return NextResponse.json({ ok: true, skipped: true });
  }

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
          : trigger === "morning_reminder"
            ? "morning_reminder"
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
    // Extract and store the specific planned sessions so all subsequent messages
    // (post_run, reminders) use the exact same distances — not independently recalculated.
    void extractAndStorePlanSessions(userId, coachMessage);
  } else if (trigger === "weekly_recap") {
    void trackEvent(userId, "plan_generated", { plan_type: "weekly" });
    void extractAndStorePlanSessions(userId, coachMessage);
  }

  // For user_message, background-extract any profile updates (injuries, new cross-training,
  // preferences) and write them back to training_profiles / onboarding_data so future
  // responses and plans automatically reflect what the athlete shared.
  // Also check if the exchange resulted in any plan changes and update weekly_plan_sessions.
  if (trigger === "user_message") {
    const latestUserMsg = [...recentMessages].reverse().find(m => m.role === "user");
    if (latestUserMsg) {
      void extractAndPersistProfileUpdates(
        userId,
        latestUserMsg.content,
        profile,
        (user.onboarding_data as Record<string, unknown>) || {}
      );
      const currentSessions = (state?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }>) ?? [];
      void maybeUpdatePlanSessions(userId, currentSessions, latestUserMsg.content, coachMessage);
    }
  }

  // Update training state if post_run.
  // Note: week_mileage_so_far is NOT updated here — it drifted indefinitely because it
  // was never reset on Mondays. The system prompt uses computeWeekMileage() (live Strava
  // query) as the authoritative source, so we only persist last_activity_summary.
  if (trigger === "post_run" && activityData) {
    const distanceMiles = (activityData.distance_meters ?? 0) / 1609.34;
    await supabase
      .from("training_state")
      .update({
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
/**
 * Post-processing guard: if the message contains a session list and a stated
 * weekly mileage total, verify the total matches the sum of running sessions
 * and correct it if not. Strength, mobility, and cross-training lines are skipped.
 *
 * Only activates when both a session list (lines matching our format) and a
 * stated total are found — otherwise it's a no-op.
 */
function correctMileageTotal(message: string): string {
  // Non-running keywords — lines containing these don't contribute mileage
  const nonRunningRe = /strength|mobility|yoga|bike|swim|elliptical|cross.train|rest day|hike/i;

  // Session lines: "Mon 3/2 · ..." or "Tue 3/10 · ..."
  const sessionLineRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d+\/\d+\s+·\s+(.+)$/gm;

  let computedMiles = 0;
  let hasSessionList = false;
  let m: RegExpExecArray | null;

  while ((m = sessionLineRe.exec(message)) !== null) {
    hasSessionList = true;
    const desc = m[2];
    if (nonRunningRe.test(desc)) continue;
    // First mileage figure in the description is the session total (e.g. "Tempo 6mi (2mi @ 8:45)" → 6)
    const miMatch = desc.match(/(\d+(?:\.\d+)?)\s*mi/i);
    if (miMatch) computedMiles += parseFloat(miMatch[1]);
  }

  if (!hasSessionList || computedMiles === 0) return message;

  const rounded = Math.round(computedMiles * 10) / 10;

  // Patterns that state a weekly total — replace the number if wrong
  // Handles: "10 miles total", "Total: 10mi", "stays at 10 miles", "~10mi total", etc.
  const totalPatterns: RegExp[] = [
    /(Total:\s*~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?\s*(?:total|this week|for the week))/gi,
    /(stays?\s+at\s+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(staying\s+at\s+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  ];

  let corrected = message;
  for (const pattern of totalPatterns) {
    corrected = corrected.replace(pattern, (full, pre, num, post) => {
      const stated = parseFloat(num);
      if (Math.abs(stated - rounded) > 0.4) {
        console.warn(`[correctMileageTotal] stated ${stated}mi but sessions sum to ${rounded}mi — correcting`);
        return `${pre}${rounded}${post}`;
      }
      return full;
    });
  }

  return corrected;
}

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
 * Returns the "YYYY-MM-DD" of the Monday that starts the week containing `date`,
 * computed in the user's local timezone. All week calculations use this so that
 * week boundaries are consistent and timezone-aware (no UTC bleeding into Sun/Mon).
 */
function localWeekMonday(date: Date, timezone: string): string {
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const [yr, mo, dy] = localDate.split("-").map(Number);
  const d = new Date(Date.UTC(yr, mo - 1, dy));
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon…
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const monday = new Date(Date.UTC(yr, mo - 1, dy - daysFromMon));
  return monday.toISOString().slice(0, 10);
}

const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

/**
 * Count run sessions in the current Mon–Sun week in the user's local timezone.
 */
function computeWeekRunCount(activities: ActivityRow[], timezone: string): number {
  const thisMonday = localWeekMonday(new Date(), timezone);
  return activities.filter((a) => {
    if (!RUN_TYPES.has(a.activity_type)) return false;
    const activityDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(a.start_date));
    return activityDate >= thisMonday;
  }).length;
}

/**
 * Sum running mileage for the current Mon–Sun week in the user's local timezone.
 * Excludes non-run activity types (bikes, swims, etc.).
 */
function computeWeekMileage(activities: ActivityRow[], timezone: string): number {
  const thisMonday = localWeekMonday(new Date(), timezone);
  return activities
    .filter((a) => {
      if (!RUN_TYPES.has(a.activity_type)) return false;
      const activityDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(a.start_date));
      return activityDate >= thisMonday;
    })
    .reduce((sum, a) => sum + (a.distance_meters || 0) / 1609.34, 0);
}

/**
 * Average weekly running mileage over the last 6 complete weeks (ignores the current partial week).
 * Returns null if there's not enough data to form even one complete week.
 */
function computeAvgWeeklyMileage(activities: ActivityRow[], timezone: string): number | null {
  if (activities.length === 0) return null;

  const thisMonday = localWeekMonday(new Date(), timezone);

  const weeks: Record<string, number> = {};
  for (const a of activities) {
    if (!RUN_TYPES.has(a.activity_type)) continue;
    const mondayKey = localWeekMonday(new Date(a.start_date), timezone);
    if (mondayKey >= thisMonday) continue; // skip current partial week
    weeks[mondayKey] = (weeks[mondayKey] || 0) + (a.distance_meters || 0) / 1609.34;
  }

  const weekValues = Object.values(weeks).slice(-6);
  if (weekValues.length === 0) return null;
  return weekValues.reduce((s, v) => s + v, 0) / weekValues.length;
}

/**
 * Compute proactive coaching signals from recent activity data.
 * These are surfaced in the system prompt so Dean can bring them up at natural moments.
 */
function computeCoachingSignals(activities: ActivityRow[], timezone: string, raceDate?: string | null): CoachingSignals {
  const runTypes = new Set(["Run", "TrailRun", "VirtualRun"]);

  // Average cadence from the 10 most recent runs with cadence data
  const runsWithCadence = activities
    .filter(a => runTypes.has(a.activity_type) && a.average_cadence && a.average_cadence > 100)
    .slice(0, 10);
  const avgCadenceSpm = runsWithCadence.length >= 3
    ? runsWithCadence.reduce((s, a) => s + (a.average_cadence ?? 0), 0) / runsWithCadence.length
    : null;

  // Week-over-week ramp: compare the two most recently completed weeks (not current partial week)
  const thisMonday = localWeekMonday(new Date(), timezone);
  const weeklyMiles: Record<string, number> = {};
  for (const a of activities) {
    if (!RUN_TYPES.has(a.activity_type)) continue;
    const key = localWeekMonday(new Date(a.start_date), timezone);
    if (key >= thisMonday) continue; // skip current partial week
    weeklyMiles[key] = (weeklyMiles[key] || 0) + (a.distance_meters || 0) / 1609.34;
  }
  const sortedCompleteWeeks = Object.keys(weeklyMiles).sort().reverse();
  let weekOverWeekRampPct: number | null = null;
  if (sortedCompleteWeeks.length >= 2) {
    const lastWeek = weeklyMiles[sortedCompleteWeeks[0]];
    const prevWeek = weeklyMiles[sortedCompleteWeeks[1]];
    if (prevWeek > 0) {
      weekOverWeekRampPct = ((lastWeek - prevWeek) / prevWeek) * 100;
    }
  }

  // Total tracked miles — rough shoe mileage proxy
  const totalTrackedMiles = activities.reduce((s, a) => s + (a.distance_meters || 0) / 1609.34, 0);

  // Recent long effort: any run ≥ 10 miles or ≥ 75 min in the last 14 days
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const hasRecentLongEffort = activities.some(a => {
    if (!runTypes.has(a.activity_type)) return false;
    if (new Date(a.start_date) < cutoff) return false;
    const miles = (a.distance_meters || 0) / 1609.34;
    const minutes = (a.moving_time_seconds || 0) / 60;
    return miles >= 10 || minutes >= 75;
  });

  // Most-used shoe from recent activities
  const gearCounts: Record<string, number> = {};
  for (const a of activities) {
    if (a.gear_name) gearCounts[a.gear_name] = (gearCounts[a.gear_name] || 0) + 1;
  }
  const dominantGear = Object.entries(gearCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Days until race
  let daysUntilRace: number | null = null;
  if (raceDate) {
    const race = new Date(raceDate + "T00:00:00");
    const days = Math.ceil((race.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (days >= 0) daysUntilRace = days;
  }

  return { avgCadenceSpm, weekOverWeekRampPct, totalTrackedMiles, hasRecentLongEffort, dominantGear, daysUntilRace };
}

/**
 * Compute weekly mileage, pace trends, and run type breakdown from recent activities.
 */
function buildActivitySummary(activities: ActivityRow[], timezone: string): string {
  if (activities.length === 0) return "No activity history available.";

  // Group by Mon–Sun week in the user's local timezone (key = "YYYY-MM-DD" of that Monday)
  const weeks: Record<
    string,
    { miles: number; runs: number; vert: number; fastest: number }
  > = {};

  for (const a of activities) {
    if (!RUN_TYPES.has(a.activity_type)) continue;
    const d = new Date(a.start_date);
    const key = localWeekMonday(d, timezone); // consistent with computeWeekMileage

    const miles = a.distance_meters / 1609.34;
    const paceMinPerMile =
      miles > 0 ? a.moving_time_seconds / 60 / miles : 999;

    if (!weeks[key])
      weeks[key] = { miles: 0, runs: 0, vert: 0, fastest: 999 };
    weeks[key].miles += miles;
    weeks[key].runs += 1;
    weeks[key].vert += (a.elevation_gain || 0) * 3.28084; // stored in meters, display in feet
    if (paceMinPerMile < weeks[key].fastest)
      weeks[key].fastest = paceMinPerMile;
  }

  // Exclude the current partial week from this table — it's already shown in
  // CURRENT TRAINING STATE as the authoritative "Mileage so far this week" figure.
  // Including it here too (with different framing) causes Dean to confuse past
  // weeks with the current one.
  const thisWeekKey = localWeekMonday(new Date(), timezone);
  const sortedWeeks = Object.entries(weeks)
    .filter(([week]) => week < thisWeekKey)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 8);

  let summary = "WEEKLY MILEAGE (completed weeks, most recent first):\n";
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
    const dateLabel = d.toLocaleDateString("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
    const miles = a.distance_meters ? (a.distance_meters / 1609.34).toFixed(1) : null;
    const parts = [
      a.activity_type || "Workout",
      miles ? `${miles}mi` : null,
      a.average_pace ? `@ ${a.average_pace}` : null,
      a.elevation_gain ? `${Math.round(a.elevation_gain * 3.28084)}ft vert` : null,
    ].filter(Boolean);
    summary += `  ${dateLabel}: ${parts.join(", ")}\n`;
  }

  return summary;
}

function buildCoachingSignalsBlock(signals: CoachingSignals): string {
  const lines: string[] = [];

  if (signals.avgCadenceSpm !== null && signals.avgCadenceSpm < 170) {
    lines.push(`- Cadence: avg ${Math.round(signals.avgCadenceSpm)} spm (below the ~170-180 spm target for efficient running). Low cadence usually means overstriding — the foot lands ahead of the center of mass, increasing braking forces and injury risk. Bring this up naturally in post-run feedback or the weekly recap — one casual observation is enough. Suggested cue: "try for a slightly quicker, shorter stride" rather than a technical lecture.`);
  }

  if (signals.weekOverWeekRampPct !== null && signals.weekOverWeekRampPct > 10) {
    lines.push(`- Mileage ramp: +${Math.round(signals.weekOverWeekRampPct)}% from the prior week (above the 10% guideline). Mention this in the weekly recap — bones and tendons adapt slower than cardiovascular fitness, so big jumps are where overuse injuries originate. Keep the tone matter-of-fact, not alarming.`);
  }

  if (signals.totalTrackedMiles > 400) {
    const gear = signals.dominantGear ? ` in their ${signals.dominantGear}` : "";
    lines.push(`- Shoe mileage proxy: ~${Math.round(signals.totalTrackedMiles)} miles tracked since connecting${gear}. Most running shoes last 300–500 miles. Work a shoe check question into a natural moment (post-long-run, weekly recap) — e.g. "How are your shoes holding up? Most have about 400-500 miles in them before the cushioning breaks down."`);
  }

  if (signals.hasRecentLongEffort) {
    lines.push(`- Long effort in the last 14 days (≥10 miles or ≥75 min). For these sessions, check in on fueling and hydration in your post-run feedback if the athlete hasn't mentioned it — e.g. "Did you fuel on that one? Anything over an hour starts to matter for recovery." One casual question only.`);
  }

  if (signals.daysUntilRace !== null) {
    const d = signals.daysUntilRace;
    if (d <= 1) {
      lines.push(`- RACE IS TOMORROW (or today). Send an encouraging, focused message: confirm the plan is locked, remind them nothing new on race day (gear, nutrition, pacing), and wish them well. Keep it short and energizing — not a data dump.`);
    } else if (d <= 7) {
      lines.push(`- RACE WEEK (${d} days out). Proactively cover: final gear check (nothing new on race day — shoes, socks, kit all tested), race morning routine (wake time, breakfast timing ~2-3 hrs before, warmup plan), mental strategy (break the race into segments, know your A/B/C goals), and what to do if things go sideways (went out too fast, cramping, heat). Weave these across the week's messages — don't dump it all at once.`);
    } else if (d <= 14) {
      lines.push(`- FINAL BUILD / TAPER START (${d} days out). Confirm the race strategy in detail this week: target pacing (even split vs. slight negative split), mile-by-mile nutrition plan (carbs every 45-60 min for anything over 75 min), hydration (drink to thirst + electrolytes for efforts >90 min), and gear decisions locked in. Address taper anxiety if it comes up — feeling sluggish or antsy is normal and expected.`);
    } else if (d <= 21) {
      lines.push(`- 3 WEEKS OUT (${d} days). Start introducing race strategy topics naturally — don't wait for the athlete to ask. Topics to weave in over the next few weeks: target pacing strategy and splits, race-day nutrition plan, gear/shoe decisions, course-specific considerations (hills, heat, terrain). One topic at a time; don't overwhelm.`);
    }
  }

  if (lines.length === 0) return "";
  return `COACHING SIGNALS — bring these up proactively at natural moments (not all at once):
${lines.join("\n")}

`;
}

/**
 * After generating an initial_plan or weekly_recap, extract the specific planned
 * sessions as structured JSON and store them in training_state.weekly_plan_sessions.
 * This gives every subsequent message (post_run, reminders) a single authoritative
 * source for session distances — Claude cannot contradict itself if it reads from here.
 */
async function extractAndStorePlanSessions(userId: string, planText: string): Promise<void> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: `Extract the list of planned training sessions from this coaching message.
Return ONLY valid JSON array, nothing else.
Each session object: {"day": "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun", "date": "M/D" (e.g. "3/10"), "label": "the full session description as written"}
Example: [{"day":"Tue","date":"3/10","label":"Easy 6.5 km"},{"day":"Thu","date":"3/12","label":"Easy 6.5 km"},{"day":"Sat","date":"3/14","label":"Easy 8 km"}]
If no session list is found, return [].`,
    messages: [{ role: "user", content: planText }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
  let sessions: Array<{ day: string; date: string; label: string }> = [];
  try {
    const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || "[]");
    if (Array.isArray(parsed)) sessions = parsed;
  } catch {
    // leave empty — no sessions to store
  }
  await supabase
    .from("training_state")
    .update({ weekly_plan_sessions: sessions as unknown as Json })
    .eq("user_id", userId);
}

/**
 * After a user_message exchange, check if the conversation resulted in any plan
 * changes (day swaps, distance changes, cancelled sessions). If so, merge the
 * changes into the stored weekly_plan_sessions so reminders and post-run messages
 * stay consistent with what Dean just agreed to.
 *
 * Only writes to the DB if changes are actually detected — no-ops on normal chat.
 */
async function maybeUpdatePlanSessions(
  userId: string,
  currentSessions: Array<{ day: string; date: string; label: string }>,
  userMessage: string,
  coachResponse: string
): Promise<void> {
  if (currentSessions.length === 0) return; // no plan stored yet — nothing to update

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: `You are checking whether a conversation exchange changed any planned training sessions for the week.

Current planned sessions (JSON):
${JSON.stringify(currentSessions)}

The athlete sent a message and the coach responded. Determine if any sessions were changed (different day, different distance, cancelled, added, or replaced).

If NO changes were made, return exactly: {"changed": false}
If changes WERE made, return the full updated sessions list reflecting the agreed changes:
{"changed": true, "sessions": [{"day": "Mon"|"Tue"|..., "date": "M/D", "label": "..."}]}

Rules:
- Only mark changed=true if the coach explicitly agreed to a change
- Preserve all unchanged sessions exactly as-is
- If a session was cancelled with no replacement, omit it from the list
- Return ONLY valid JSON, no other text`,
    messages: [{ role: "user", content: `Athlete: ${userMessage}\n\nCoach: ${coachResponse}` }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    if (parsed.changed && Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
      await supabase
        .from("training_state")
        .update({ weekly_plan_sessions: parsed.sessions as unknown as Json })
        .eq("user_id", userId);
    }
  } catch {
    // parse failed — leave sessions unchanged
  }
}

function buildSystemPrompt(
  user: Record<string, unknown>,
  profile: Record<string, unknown> | null,
  state: Record<string, unknown> | null,
  recentMessages: Array<{
    role: string;
    content: string;
    message_type: string | null;
    created_at?: string | null;
  }>,
  activitySummary: string,
  weekMileageSoFar: number,
  weekRunCount: number,
  raceHistory: Array<Record<string, unknown>>,
  stravaStats?: Record<string, unknown>,
  timezone?: string,
  hasWebSearch?: boolean,
  avgWeeklyMileage?: number | null,
  coachingSignals?: CoachingSignals,
  weatherBlock?: string
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

  // All-time, YTD, and recent stats from Strava
  let allTimeInfo = "";
  if (stravaStats) {
    const allRun = stravaStats.all_run_totals as { count?: number; distance?: number } | null;
    const ytdRun = stravaStats.ytd_run_totals as { count?: number; distance?: number } | null;
    const recentRun = stravaStats.recent_run_totals as { count?: number; distance?: number } | null;
    if (allRun) {
      allTimeInfo += `- All-time: ${allRun.count || 0} runs, ${Math.round((allRun.distance || 0) / 1609.34)} miles\n`;
    }
    if (ytdRun) {
      allTimeInfo += `- Year-to-date: ${ytdRun.count || 0} runs, ${Math.round((ytdRun.distance || 0) / 1609.34)} miles\n`;
    }
    if (recentRun) {
      allTimeInfo += `- Last 4 weeks (aggregate across all 4 weeks, NOT this week): ${recentRun.count || 0} runs, ${Math.round((recentRun.distance || 0) / 1609.34)} miles total\n`;
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
  const goalTimeMinutes = onboardingData.goal_time_minutes as number | null | undefined;
  const isTri = ["sprint_tri", "olympic_tri", "70.3", "ironman"].includes(profile?.goal as string || "");

  // Pre-compute goal pace so Claude never has to do the arithmetic (it gets it wrong).
  // Only computed for single-sport running goals where a race distance is known.
  const runGoalDistancesMiles: Record<string, number> = {
    "5k": 3.107, "10k": 6.214, "half_marathon": 13.109, "marathon": 26.219,
    "30k": 18.641, "50k": 31.069, "100k": 62.137,
  };
  let goalPaceStr = "";
  if (goalTimeMinutes != null && profile?.goal) {
    const distMiles = runGoalDistancesMiles[profile.goal as string];
    if (distMiles) {
      const paceMinsPerMile = goalTimeMinutes / distMiles;
      const paceMin = Math.floor(paceMinsPerMile);
      const paceSec = Math.round((paceMinsPerMile - paceMin) * 60);
      const pacePerKm = goalTimeMinutes / (distMiles * 1.60934);
      const paceKmMin = Math.floor(pacePerKm);
      const paceKmSec = Math.round((pacePerKm - paceKmMin) * 60);
      goalPaceStr = ` — goal pace: ${paceMin}:${String(paceSec).padStart(2, "0")}/mi (${paceKmMin}:${String(paceKmSec).padStart(2, "0")}/km)`;
    }
  }
  // Additional athlete preferences captured during onboarding (strengthening, cross-training
  // requests, injury prevention goals, race history notes, etc.)
  const otherNotes = onboardingData.other_notes as string | null;
  const crosstrainingTools = (profile?.crosstraining_tools as string[] | null)?.filter(Boolean);

  // TODO: Once Strava API app is approved, update "Activity tracking" in PRODUCT CAPABILITIES below to:
  // "Activity tracking: Strava only. No Garmin, Apple Watch, Wahoo, etc."
  return `You are Coach Dean, an expert endurance coach communicating via text message. You specialize in running, triathlon, cycling, and multi-sport periodized training. You are coaching ${user.name || "this athlete"} for ${profile?.goal ? formatGoalLabel(profile.goal as string) : "general fitness"}${profile?.race_date ? ` on ${profile.race_date}` : ""}.

CRITICAL — OUTPUT RULES:
Your response is sent directly to the athlete as an SMS text message. Never include any of the following in your output:
- Internal reasoning, calculations, or self-corrections ("Wait...", "Let me recalculate...", "Actually...", "Let me think about...")
- Draft versions or abandoned attempts ("I was going to say X but actually Y")
- Meta-commentary about the plan ("I need to be smart here", "Given his history...")
Do all reasoning silently before writing your final response. Output only the message the athlete should receive.

${dateContext}
CALIBRATE TO ATHLETE'S ACTUAL FITNESS FIRST:
Before applying any training philosophy, anchor the plan to what the data shows. The athlete's recent weekly mileage, pace distribution, and workout history in RECENT WORKOUTS are ground truth. The philosophy principles below are defaults — they yield to observed fitness. An athlete already running 40+ miles/week with quality sessions in their history does not need to earn intensity; they need a plan that matches where they actually are. Apply conservative defaults only where the data is thin, the athlete is clearly new to consistent training, or injury history warrants it.
${
  avgWeeklyMileage == null
    ? `FITNESS TIER: No activity data yet. Default to a conservative, base-building approach until training history establishes their level.`
    : avgWeeklyMileage < 10
    ? `FITNESS TIER: LOW VOLUME (avg ${avgWeeklyMileage.toFixed(1)} mi/week). This athlete is in early base-building. Prioritize easy aerobic volume and consistency. Hold off on structured quality sessions (tempo, intervals) until they have 4–6 weeks of steady easy running. Protect them from overtraining — it's the most common reason early runners quit or get hurt.`
    : avgWeeklyMileage < 30
    ? `FITNESS TIER: MODERATE VOLUME (avg ${avgWeeklyMileage.toFixed(1)} mi/week). This athlete has an established aerobic base. 1–2 quality sessions per week (tempo or interval work) are appropriate and expected alongside easy volume. The 80/20 principle applies — most miles easy, but don't withhold quality work.`
    : `FITNESS TIER: HIGH VOLUME (avg ${avgWeeklyMileage.toFixed(1)} mi/week). This is an experienced, high-volume runner. Skip base-building preamble — they already have the base. Quality sessions are appropriate from the start. Plan to their current training level, not a conservative floor. Don't apply beginner defaults to an athlete running this kind of volume.`
}

TRAINING PHILOSOPHY — apply in this priority order, within the context of the fitness tier above:

1. AEROBIC BASE FIRST (Lydiard / Uphill Athlete): For athletes still building their base, don't rush to intensity — build the aerobic engine patiently before adding quality work. For athletes with an established high-volume history, the base is already there; plan accordingly.

2. 80/20 INTENSITY DISTRIBUTION (Fitzgerald / Seiler / Roche): ~80% of all training at genuinely easy, conversational effort. Avoid the moderate "gray zone" — it accumulates fatigue without driving meaningful adaptation. Easy runs are truly easy. Hard days are genuinely hard.

3. VDOT-CALIBRATED PACING (Jack Daniels): Use the athlete's current fitness (from race times or effort-based estimation) to assign specific training paces: Easy, Marathon, Threshold, Interval. Never assign arbitrary paces. Pace zones should reflect actual current fitness, not aspirational targets.

4. PERIODIZATION (Base → Build → Peak → Taper): Structure training in phases appropriate to the athlete's tier. Progressive overload: increase weekly mileage by no more than 10%/week. Every 4th week is a recovery week (reduce volume 25-30%). Long runs progress ~1 mile/week. Taper 2 weeks before target races.

5. DURABILITY VIA STRENGTH (Roche / SWAP Running): Runners break down not from mileage but from muscles that can't absorb the load. Prioritize hip stability, glute activation, and single-leg exercises. Recommend 2x/week strength when the athlete has capacity or injury history.

6. PROCESS ORIENTATION (The Happy Runner): Emphasize consistency and long-term development. Celebrate showing up. Normalize easy days. Reinforce that a running life that lasts beats peak performance that burns out.

Additional notes:
- For trail races: include vert-specific training, technical downhill practice, power hiking
- Match session format to the athlete's actual situation. Walk-jog intervals, time-based sessions, effort-capped easy runs, structured workouts — choose what's appropriate given their volume, injury status, goal, and fitness. Don't default to a rigid format based on mileage alone.

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
- Goal: ${profile?.goal ? formatGoalLabel(profile.goal as string) : "unknown"}${profile?.race_date ? ` on ${profile.race_date}` : ""}${goalTimeMinutes != null ? ` — goal finish time: ${Math.floor(goalTimeMinutes / 60)}:${String(Math.round(goalTimeMinutes % 60)).padStart(2, "0")}${goalPaceStr}` : goalTimeMinutes === null ? " — no specific time goal (completion/fitness focus)" : ""}
- Injury / constraints: ${profile?.injury_notes || "None reported"}
- Cross-training available: ${crosstrainingTools && crosstrainingTools.length > 0 ? crosstrainingTools.join(", ") : "None mentioned"}
${otherNotes ? `- Athlete preferences / notes: ${otherNotes}\n` : ""}${isTri ? `- Swim pace: ${swimPace || "unknown"}\n- Bike: ${bikeInfo || "unknown"}` : ""}

${activitySummary}
${raceHistory.length > 0 ? `
RACE HISTORY (from Strava, workout_type=race):
${raceHistory.map((r) => {
  const date = r.start_date ? (r.start_date as string).slice(0, 10) : "unknown date";
  const distMiles = Math.round(((r.distance_meters as number) / 1609.34) * 10) / 10;
  return `- ${date}: ${distMiles} mi @ ${r.average_pace || "unknown pace"}`;
}).join("\n")}
` : ""}
CURRENT TRAINING STATE:
${(() => {
  const useMetric = profile?.preferred_units === "metric";
  const mi = (miles: number) => useMetric ? `${(miles * 1.60934).toFixed(1)} km` : `${miles.toFixed(1)} mi`;
  const targetMiles = (state?.weekly_mileage_target as number) || 0;
  const sessionRows = (() => {
    const sessions = state?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }> | null;
    if (!sessions || sessions.length === 0) return "";
    // Filter out stale sessions (all dates before today means plan is from last week)
    const today = new Date();
    const currentYear = today.getFullYear();
    const activeSessions = sessions.filter(s => {
      const [m, d] = s.date.split("/").map(Number);
      const sessionDate = new Date(currentYear, m - 1, d);
      // Keep if date is today or in the future, or if we can't parse the date
      return isNaN(sessionDate.getTime()) || sessionDate >= new Date(today.getFullYear(), today.getMonth(), today.getDate());
    });
    if (activeSessions.length === 0) return "";
    const list = activeSessions.map(s => `${s.day} ${s.date} · ${s.label}`).join("\n");
    return `\n- THIS WEEK'S PLANNED SESSIONS (authoritative — use these exact sessions and distances; do not recalculate or change them unless the athlete explicitly asks to adjust):\n${list}`;
  })();
  return `- Week ${state?.current_week || 1} of training, phase: ${state?.current_phase || "base"}
- Weekly mileage target: ${targetMiles ? mi(targetMiles) : "TBD"}
- Mileage so far this week: ${mi(weekMileageSoFar)} across ${weekRunCount} run${weekRunCount !== 1 ? "s" : ""} (Strava-synced; authoritative — use ONLY these figures for session count and weekly mileage, do NOT use "Last 4 weeks" totals from ATHLETE HISTORY)
- Athlete preferred units: ${profile?.preferred_units || "imperial"} — use ${profile?.preferred_units === "metric" ? "km and min/km" : "miles and min/mile"} in all responses
- Current paces: Easy ${easyPaceRange(profile?.current_easy_pace as string ?? null, useMetric) || "TBD"}, Tempo ${profile?.current_tempo_pace || "TBD"}, Interval ${profile?.current_interval_pace || "TBD"}
- Last activity: ${state?.last_activity_summary ? JSON.stringify(state.last_activity_summary) : "None yet"}
- Active adjustments: ${state?.plan_adjustments || "None"}${sessionRows}`;
})()}

COMMUNICATION STYLE:
You are texting over iMessage. Write exactly like a real human coach would text — not an email, not a report, not a bullet-point summary.

WHEN NOT TO REPLY — check this first:
If the athlete's last message is purely a closing acknowledgment with nothing left to address — "Perfect", "Thanks!", "Sounds great", "Got it", "👍", etc. — and the conversation has naturally concluded, output exactly: [NO_REPLY]
Output nothing else. Do not explain your reasoning. Do not describe what you would have said. Just output [NO_REPLY] and stop.

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
- COUNTING RULE: Never state a count and then list items that don't match. If you write "4 training days left (Tue, Wed, Thu, Sat)" count the items in the parentheses first — that's 4, which is fine. "4 training days left (Tue, Wed, Thu, Sat, Sun)" is 5, not 4 — fix the number before sending. Same rule applies to any enumerated list followed by a stated count.
- WHEN LISTING MULTIPLE SESSIONS (week plan, schedule, multi-day preview): always use this compact one-per-line format with NO blank lines between sessions:
  Mon 3/9 · Easy 5mi @ 9:30/mi
  Tue 3/10 · Strength + mobility 20 min
  Wed 3/11 · Tempo 4mi (2mi @ 8:45)
  Sat 3/14 · Long run 8mi easy
  Use short day abbreviations (Mon/Tue/Wed/Thu/Fri/Sat/Sun), M/D dates, and · as the separator. Never use full day names ("Monday, March 9"), colons, or dashes as separators for session lists. Blank lines split into separate SMS bubbles — keep the session list as one unbroken block. Always sort sessions in chronological order by date — never group by workout type (e.g. runs first, then strength). A strength session on Tuesday belongs before a run on Thursday.

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
- Activity tracking: Strava only. If an athlete has connected Strava, their activities sync automatically. No Garmin, Apple Watch, Wahoo, or other platform sync.
- If an athlete asks how to connect Strava, tell them to text "connect strava" and you'll send them the link.
- If an athlete asks how to connect Garmin, Apple Health, or any other service, tell them clearly: "I only have Strava sync right now — just text me after your workouts and I'll track from there."
- Communication: SMS only. No app, no web dashboard, no email.
- Proactive reminders: three options are supported: (1) morning-of reminders, (2) evening-before reminders, (3) weekly Sunday overview only.
- Morning reminders go out at approximately 6am PT / 7am MT / 8am CT / 9am ET. If an athlete asks what time, give them the appropriate time for their timezone.
- Evening reminders go out at approximately 6pm PT / 7pm MT / 8pm CT / 9pm ET (the evening before the session).
- Specific times beyond these (e.g. "8:30am", "noon") are NOT supported — just morning or evening.
- NEVER promise a reminder at a precise time — say "around 6am" or "evening before", not "at 8am exactly".
- If asked about a feature that doesn't exist (a web dashboard, export, calendar sync, etc.), say you don't have that yet rather than fabricating instructions.

STRENGTH, MOBILITY & CROSS-TRAINING — include on rest days when appropriate:
- Include a strength/mobility session when the athlete has injury notes, has asked for strength or stretching, or has gym/yoga listed as cross-training. Tailor exercises to their specific injury or needs.
- Include cross-training when they've listed tools (bike, pool, elliptical, yoga, etc.) or asked for it.
- Format in the plan as e.g. "Strength + mobility 20 min" or "Easy bike 45 min" — brief and specific.
- If none of the above apply, do NOT add strength or cross-training unprompted.

PROACTIVE INJURY & CONCERN FOLLOW-UP:
If the athlete has injury notes or reported physical concerns (see "Injury / constraints" in ATHLETE HISTORY above), reference them proactively — don't wait for the athlete to bring them up first.
- Post-run feedback: always briefly check in on how the affected area held up during the run. Treat it as a natural part of the debrief, not a clinical question. E.g. "How'd the IT band feel on that one?" or "Any calf tightness on the downhills?" One short sentence is enough.
- Morning/nightly reminders: when the upcoming session is longer or harder, add a one-liner about what to watch for. E.g. "Keep an eye on the knee — back off if it starts talking to you mid-run."
- Weekly recap: note whether the injury/concern appears to be trending based on recent training load or any athlete-reported context. If they haven't mentioned it recently, check in.
- A good coach tracks these proactively. Never silently skip injury notes just because the athlete didn't bring them up.

${weatherBlock || ""}${coachingSignals ? buildCoachingSignalsBlock(coachingSignals) : ""}
ATHLETE-STATED PHILOSOPHIES — when an athlete mentions a coach, book, or training system they follow:
1. Recognize it — acknowledge naturally, not robotically
2. Surface the overlap — point out where it aligns with Dean's defaults (most do)
3. Adapt language and emphasis — match their framing going forward
4. Note any meaningful tension once, kindly, then move on

Reference:
- "Jack Daniels / VDOT" → Dean's default; no tension. Affirm precision and structure.
- "David Roche / SWAP / The Happy Runner" → Highly compatible. Amplify joy, process, easy-first framing, strength as durability.
- "Matt Fitzgerald / 80/20" → Dean's default aligns. Affirm intensity distribution.
- "Lydiard" → Honor aerobic base emphasis; may want longer base phases than Dean's defaults.
- "Pfitzinger / Pete Pfitz" → Respect higher volume tolerance and medium-long runs as a staple. Higher mileage than Dean pushes for beginners.
- "Hanson's Method" → Acknowledge cumulative fatigue methodology and shorter long runs (16 mi max). Long run length may feel short to some athletes.
- "Training for the Uphill Athlete / Uphill Athlete" → Lean into aerobic threshold / zone 2 language, strength integration. Very low intensity emphasis; may need to calibrate for road runners.
- "Galloway" → Honor run/walk intervals; frame them positively as a durability and sustainability tool.
- "Polarized / Seiler / 90-10" → Reduce moderate work further; make quality sessions sharper. Suitable for experienced athletes.
- "Born to Run / natural running" → Lean into form focus and joy; may resist structured pacing — use feel-based cues.
- Unknown philosophy → Ask the athlete to share the key principles so you can incorporate it accurately. Never guess or invent details about a methodology you don't know.

${hasWebSearch ? `WEB SEARCH:
You have access to web search. Use it proactively when:
- The athlete mentions a specific race, event, or trail by name — search for course details, elevation profile, terrain, cutoff times
- The athlete asks about something requiring current or specific information you're not fully confident about (race logistics, course records, a specific training methodology)
- You need factual details about a route, venue, or event to give accurate training advice
Do NOT search for general training concepts, coaching methodology, or things you already know well.
` : ""}RACE PREPARATION & STRATEGY — what comprehensive race coaching covers:
When the athlete asks about race strategy, race day, or you're proactively bringing it up (see COACHING SIGNALS), cover these topics — one at a time, spread across conversations, not all at once:

Pacing:
- Even split vs. slight negative split (going slightly faster in the second half) is almost always optimal. Positive splits (going out too fast) are the most common race mistake.
- For most athletes: run the first half feeling easier than goal pace. The second half is where the race happens.
- Course-specific: if there are hills early, go by effort not pace on the uphills and bank nothing — you'll need those reserves.
- Have an A goal (dream), B goal (solid execution), C goal (finish strong) so a rough patch doesn't become a spiral.

Nutrition (racing):
- Anything over ~60-75 min requires exogenous carbs. Target 30-60g of carbs per hour for half marathon and shorter; 60-90g/hr for marathon and longer (with practice).
- Start fueling early — by mile 4-5 for a marathon, not when you feel depleted. By the time you feel it, you're already behind.
- Practice the exact race-day nutrition in training. Never try a new gel, chew, or drink on race day.
- Liquid calories at aid stations count — if taking sports drink, adjust gel frequency.

Hydration:
- Drink to thirst for most conditions. Don't over-drink (hyponatremia is a real risk for slower runners drinking heavily).
- For efforts over 90 min or in heat: sodium matters. Electrolytes, not just water.
- Know the aid station locations on the course so you're not caught dry or forced to drink at a hard effort.

Gear (race day):
- Nothing new on race day — shoes, socks, shorts, top, watch all need to be tested in training.
- Race-day kit laid out the night before. Know your watch settings in advance.
- Body Glide or anti-chafe anywhere that rubs on long runs.

Mental strategy:
- Break the race into segments. Don't think about mile 20 at mile 3.
- Have a mantra or two ready for when it gets hard — something simple and personal.
- Expect a rough patch. Every race has one. The plan is to stay calm, hold form, keep fueling, and let it pass.

Contingency planning:
- If you go out too fast: don't panic, ease back 10-15 sec/mile, refuel aggressively.
- If it's hotter than expected: adjust goal pace 20-30 sec/mile per 10°F above ideal racing temps (~50-55°F).
- If something hurts: distinguish between discomfort (normal) and pain (stop).

${hasWebSearch ? `WEB SEARCH:
You have access to web search. Use it proactively when:
- The athlete mentions a specific race, event, or trail by name — search for course details, elevation profile, terrain, cutoff times
- The athlete asks about something requiring current or specific information you're not fully confident about (race logistics, course records, a specific training methodology)
- You need factual details about a route, venue, or event to give accurate training advice
Do NOT search for general training concepts, coaching methodology, or things you already know well.
` : ""}RECENT CONVERSATION:
${conversationHistory || "No previous messages."}`;
}

/**
 * Convert a raw Strava split or lap object into Claude-readable units.
 * Strava always returns distance in meters, speed in m/s, and elevation in meters
 * regardless of whether the split is metric or imperial.
 */
function transformSplitForClaude(split: Record<string, unknown>): Record<string, unknown> {
  const speed = typeof split.average_speed === "number" ? split.average_speed : null;
  const elevDiff = typeof split.elevation_difference === "number" ? split.elevation_difference : null;
  const distMeters = typeof split.distance === "number" ? split.distance : null;

  const pace = speed && speed > 0
    ? (() => {
        const paceMinPerMile = 1609.34 / speed / 60;
        const paceMin = Math.floor(paceMinPerMile);
        const paceSec = Math.round((paceMinPerMile - paceMin) * 60);
        return `${paceMin}:${String(paceSec).padStart(2, "0")}/mi`;
      })()
    : null;

  const result: Record<string, unknown> = { ...split };
  if (distMeters != null) result.distance_miles = Math.round((distMeters / 1609.34) * 100) / 100;
  if (pace) result.pace = pace;
  if (elevDiff != null) result.elevation_difference_feet = Math.round(elevDiff * 3.28084);
  // Remove the raw Strava fields so Claude doesn't misread the units
  delete result.distance;
  delete result.average_speed;
  delete result.elevation_difference;
  return result;
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
    injury_recovery: "injury recovery and return to running",
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
    const todayName = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date());
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: `Today is ${todayName}. Extract structured data from an athlete's message to their coach.

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
  - date_offset: days before today (0=today, -1=yesterday, -2=two days ago, etc.). For named days like "Monday" or "Tuesday", compute the offset from today. Default 0.
- Their location or timezone if explicitly mentioned (e.g. "I'm in Denver", "I live in Seattle", "I'm on Pacific time", "I'm in PST") → timezone as IANA string (e.g. "America/Denver", "America/Los_Angeles"). Only set if they are clearly stating where they are, not just mentioning a city in passing.
- A one-off request to skip a specific training day this week (e.g. "skip Sunday", "I won't run this Saturday", "skipping my workout Thursday", "can we move Sunday's run") → skip_date as "YYYY-MM-DD" for the upcoming occurrence of that day. Today is ${new Date().toISOString().slice(0, 10)}. Compute the date of the next occurrence of the named weekday (if today is that day, use today). Only set for explicit skip/cancel requests, not vague mentions.
- A new or updated target race date (e.g. "I just signed up for Boston on April 21st", "my marathon is October 13th") → race_date as "YYYY-MM-DD". Only set when athlete clearly states a specific race date. If month only, use first day of that month. Today is ${new Date().toISOString().slice(0, 10)}.
- A new or revised finish time goal (e.g. "I want to run sub-3:30", "revised my goal to 1:55", "aiming for under 4 hours") → goal_time_minutes as total minutes (e.g. sub-3:30 → 210, 1:55 → 115).

Output: {"injury_notes": string | null, "new_crosstraining": string[] | null, "other_notes": string | null, "recent_race_distance_km": number | null, "recent_race_time_minutes": number | null, "easy_pace": string | null, "timezone": string | null, "skip_date": string | null, "race_date": string | null, "goal_time_minutes": number | null, "workout": {"activity_type": string, "distance_meters": number | null, "moving_time_seconds": number | null, "average_pace": string | null, "elevation_gain": number | null, "date_offset": number} | null}

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
      timezone?: string | null;
      skip_date?: string | null;
      race_date?: string | null;
      goal_time_minutes?: number | null;
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
    const hasTimezone = !!(extracted.timezone && /^[A-Za-z_]+\/[A-Za-z_]+$/.test(extracted.timezone));
    const hasSkipDate = !!(extracted.skip_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.skip_date));
    const hasRaceDate = !!(extracted.race_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.race_date));
    const hasGoalTime = typeof extracted.goal_time_minutes === "number" && extracted.goal_time_minutes > 0;
    const hasWorkout = !!extracted.workout;

    if (!hasInjury && !hasCrosstraining && !hasOtherNotes && !hasRaceData && !hasEasyPace && !hasTimezone && !hasSkipDate && !hasRaceDate && !hasGoalTime && !hasWorkout) return;

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
    if (hasSkipDate) {
      const existing = (profile?.skip_dates as string[]) || [];
      if (!existing.includes(extracted.skip_date as string)) {
        profileUpdate.skip_dates = [...existing, extracted.skip_date as string];
      }
    }
    if (computedPaces) {
      profileUpdate.current_easy_pace = computedPaces.easy;
      if (computedPaces.tempo) profileUpdate.current_tempo_pace = computedPaces.tempo;
      if (computedPaces.interval) profileUpdate.current_interval_pace = computedPaces.interval;
    }
    if (hasRaceDate) profileUpdate.race_date = extracted.race_date;
    if (hasGoalTime) profileUpdate.goal_time_minutes = extracted.goal_time_minutes;

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
      hasOtherNotes || hasTimezone
        ? supabase.from("users").update({
            onboarding_data: updatedOnboardingData as unknown as Json,
            ...(hasTimezone ? { timezone: extracted.timezone } : {}),
          }).eq("id", userId)
        : Promise.resolve(),
    ]);
  } catch (err) {
    console.error("[coach/respond] extractAndPersistProfileUpdates failed:", err);
  }
}

function buildUserMessage(
  trigger: TriggerType,
  activityData: Record<string, unknown> | null,
  imageActivity?: Record<string, unknown>,
  includeWorkoutCheckin?: boolean,
  injuryNotes?: string | null,
  timezone = "America/New_York"
): string {
  switch (trigger) {
    case "morning_plan":
      return "Generate today's workout plan for this athlete. Consider their current training state, recent activity history and trends, and any adjustments needed. Be specific about distances, paces, and effort levels.";
    case "post_run": {
      const actStartDate = activityData?.start_date && typeof activityData.start_date === "string"
        ? new Date(activityData.start_date).toLocaleDateString("en-US", { timeZone: timezone, weekday: "long", month: "short", day: "numeric" })
        : null;
      const dateNote = actStartDate
        ? `Activity date: ${actStartDate}. This may differ from today if the athlete logged it retroactively — use the activity date, not today's date, when referencing when the run happened.`
        : "";
      // Convert elevation_gain from meters (how Strava/DB stores it) to feet for Claude.
      // Also transform splits and laps: Strava always returns distance in meters, speed in m/s,
      // and elevation in meters regardless of split type — convert all to imperial/readable units.
      const rawSummary = activityData?.summary as { splits?: unknown[]; laps?: unknown[] } | null;
      const activityForClaude = activityData
        ? {
            ...activityData,
            elevation_gain_feet: activityData.elevation_gain != null
              ? Math.round((activityData.elevation_gain as number) * 3.28084)
              : null,
            elevation_gain: undefined,
            summary: rawSummary
              ? {
                  splits: rawSummary.splits?.map(s => transformSplitForClaude(s as Record<string, unknown>)),
                  laps: rawSummary.laps?.map(s => transformSplitForClaude(s as Record<string, unknown>)),
                }
              : null,
          }
        : activityData;
      const injuryReminder = injuryNotes
        ? `\nINJURY FOLLOW-UP: This athlete has active concern notes: "${injuryNotes}". If they haven't mentioned how this area felt during the run, check in on it — one brief question as part of your feedback.`
        : "";
      return `A workout just synced from Strava. ${dateNote}

DATA GLOSSARY for the details below:
- summary.splits: auto-generated by Strava, one entry per mile. Shows pace for each mile of the run.
- summary.laps: manual lap button presses on the athlete's watch (or device auto-laps). Distance and time vary — these reflect segments the athlete intentionally marked, e.g. warm-up, hard effort, cooldown.
- All paces are min/mile. Elevation in feet. Distances in miles.

Details:
${JSON.stringify(activityForClaude, null, 2)}

Provide post-run feedback analyzing their performance, noting what went well, any concerns, and what's coming up next. Reference their recent training trends.

PLAN CONSISTENCY RULES — follow these exactly:
- Week-to-date mileage: use the "Mileage so far this week" figure from CURRENT TRAINING STATE. Do not manually sum runs from conversation history or include runs from previous weeks.
- Upcoming sessions: if THIS WEEK'S PLANNED SESSIONS is present in CURRENT TRAINING STATE, use those exact sessions and distances. Do not recalculate, substitute, or invent different numbers. Only omit sessions that have already been completed (i.e. activity date falls on or before today's date).
- If no planned sessions are stored yet, reference the most recent plan from conversation history if visible.${injuryReminder}`;
    }
    case "user_message":
      return "The athlete just sent you a message (see the most recent message in RECENT CONVERSATION above). Respond helpfully as their running coach. Use their activity history and training data to give specific, personalized advice.";
    case "morning_reminder":
      if (includeWorkoutCheckin) {
        return `Send a short message that does two things: check in on yesterday's workout, then preview today's.

Structure (all in one message unless it runs long — split into two bubbles with a blank line if needed):
1. A brief, casual check-in on yesterday — vary the phrasing each time. e.g. "How'd yesterday's run go?" / "Hope yesterday's session felt good —" / "How'd [day]'s workout treat you?" Keep it light, one sentence.
2. Today's workout: type, distance, and target pace or effort. One or two sentences max. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number.
3. A short invite to adjust if needed — vary this too. e.g. "Let me know if you want to dial anything back based on how yesterday felt." / "Happy to tweak today if the legs are tired." One sentence.

No markdown. Sound like a real coach texting. Total under 560 characters.`;
      }
      return `Send a short reminder text about today's workout. Three parts, all on one message:

1. A brief, natural opener — vary it each time. Options: "Today's workout:", "Here's what's on for today:", use their name casually, reference the day, etc.

2. The workout — type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number. One or two sentences max.

3. A short, energizing closer — vary this too. "Go get it.", "Have a great one.", "Enjoy the run.", "You've got this.", etc. One short phrase.

Keep the whole thing under 480 characters. No markdown, no bullet points. Sound like a real coach texting, not a notification from an app.`;

    case "nightly_reminder":
      if (includeWorkoutCheckin) {
        return `Send a short message that does two things: check in on today's workout, then preview tomorrow's.

Structure (all in one message unless it runs long — split into two bubbles with a blank line if needed):
1. A brief, casual check-in on today — vary the phrasing each time. e.g. "How'd today's run go?" / "Hope today's session felt good —" / "How did [day]'s workout go?" Keep it light, one sentence.
2. Tomorrow's workout: type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number. One or two sentences max.
3. A short invite to adjust based on how today felt — vary this. e.g. "Let me know if you want to tweak anything based on how today felt." / "Happy to adjust if you're feeling it." One sentence.

No markdown. Sound like a real coach texting. Total under 560 characters.`;
      }
      return `Send a short reminder text about tomorrow's workout. Three parts, all on one message:

1. A brief, natural opener — vary it each time so it doesn't feel canned. Options: "Tomorrow's workout:", "Here's what's on for tomorrow:", use their name casually ("Hey [name], tomorrow:"), reference the day ("Wednesday's session:"), etc. Mix it up.

2. The workout — type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number. One or two sentences max.

3. A short, warm closer — vary this too. Rotate through things like "Good luck!", "Let me know how it goes.", "Have fun out there.", "You've got this.", "Enjoy the run.", etc. One short phrase, nothing more.

Keep the whole thing under 480 characters. No markdown, no bullet points. Sound like a real coach texting, not a notification from an app.`;
    case "weekly_recap":
      return `Send 2–3 short texts recapping last week and previewing the coming week (use DATE CONTEXT for exact dates). Each text under 480 characters, separated by a blank line. First text: last week summary (mileage, one specific observation) plus one sentence on what this week is targeting and why — e.g. "This week we're adding a tempo run now that your base is solid" or "Pulling back volume slightly — week 4 is a recovery week, which is when adaptation actually happens." Second: this week's key sessions. Third (optional): one brief motivational or tactical note. No intro fluff.

For the sessions text, put each session on its own line using this compact format, sorted chronologically by date — never group by type:
Mon 3/2 · Easy 5mi @ 9:30/mi
Tue 3/3 · Strength + mobility 20 min
Wed 3/4 · Tempo 4mi (2mi @ 8:45)
Sat 3/7 · Long run 8mi easy
Use short day abbreviations (Mon/Tue/Wed/Thu/Fri/Sat/Sun) and M/D date format. No prose between sessions.

STRENGTH & CROSS-TRAINING: If the athlete has injury notes or has requested strength/mobility work, include a "Strength + mobility" session on a rest day in the week preview (see STRENGTH, MOBILITY & CROSS-TRAINING in system prompt). If they have cross-training tools, include a cross-training day where appropriate.

MILEAGE ACCURACY: Before writing any weekly mileage total, silently sum every running session distance to verify it. Strength, mobility, and cross-training sessions contribute zero miles. If the sum doesn't match, correct the sessions or the stated total before writing — never show the calculation in your response. If you're not listing every session, omit the total entirely.`;
    case "workout_image":
      return `The athlete just shared a workout screenshot. Here are the extracted details:\n${JSON.stringify(imageActivity || {}, null, 2)}\n\nSend 1–2 short texts as post-workout feedback. First text: one specific reaction to their performance (pace, effort, HR — whatever is most notable). Second text (only if needed): what's next. Each under 480 characters. No generic openers.`;

    case "initial_plan":
      return `This athlete just finished onboarding. Send them an initial week plan — framed as a starting point, not a finished prescription. The goal is to get something in front of them quickly and invite them to shape it.

USE STRAVA DATA — this is critical:
- Look at WEEKLY MILEAGE, PACE ANALYSIS, and RECENT WORKOUTS before writing a single word of the plan.
- If Strava data exists, reference it specifically: "I can see you've been running X miles/week with some efforts down to Y pace" — this tells the athlete you actually looked at their history.
- Set all training paces based on observed fitness from Strava, not just the goal time. If their recent fast efforts are faster than goal pace, acknowledge that — it tells you they have the speed and the plan should focus on execution and sharpening, not building fitness from scratch.
- If no Strava data exists, proceed without it — but don't pretend to have data you don't have.

GOAL PACE — never compute this yourself:
- The athlete's goal pace (per mile and per km) is pre-calculated and shown in ATHLETE HISTORY as "goal pace: X:XX/mi". Use exactly that number. Do not recalculate it.

VOLUME AND SAFETY:
- Match week 1 volume to the athlete's FITNESS TIER (see top of system prompt). For low-volume athletes, start conservatively at or below their baseline. For high-volume athletes, start at their current level — don't sandbagging them with a beginner week.
- For athletes coming back from injury, returning after a long break, or with low current mileage: start shorter than you might think. It's easier to add than to walk back an overambitious first week.
- Address any injury or physical limitation directly in the plan itself — briefly note how the plan accounts for it. Do NOT ask a follow-up question about it.

FOCUSED WORKOUT FORMAT — use this instead of a day-by-day schedule when the athlete has indicated they want specific workout prescriptions rather than a complete plan. Look for signals in the recent conversation: phrases like "I don't need a full plan", "just help me with workouts", "I already have a base", "just need the key sessions", "help designing specific workouts", or any variation of wanting workout guidance rather than a complete schedule. Race proximity and Strava history are supporting signals but not required — the athlete's stated preference is the primary trigger.
- Skip the day-by-day schedule format entirely.
- Instead: one bubble acknowledging their context (Strava fitness if available, race timeline, stated base) + a weekly mileage target. One bubble with 2-3 specific quality sessions — describe each session's structure, distance, and exact paces. Frame these as the key sessions for the week; easy miles fill the rest.
- Example quality sessions: "Tue or Wed: 2mi easy, 3mi @ [threshold pace], 1mi easy" / "Fri: 6x800m @ [interval pace] w/400m jog recovery" / "Sun: long run Xmi, last Y easy @ [goal pace]"
- Be specific about paces. For goal-pace-based training: threshold ~10-15 sec/mi faster than goal pace, interval ~25-35 sec/mi faster than goal pace. Cross-check against observed Strava paces — if their fast efforts already exceed goal pace, note that and calibrate accordingly.

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

MILEAGE ACCURACY: Before writing any weekly mileage total, silently sum every running session distance to verify it. Strength, mobility, and cross-training sessions contribute zero miles. If the sum doesn't match, correct the sessions or the stated total before writing — never show the calculation in your response. If you're not listing every session, omit the total entirely.

DATES AND DAY LABELS:
- CRITICAL: Use the day names from DATE CONTEXT above — do not compute weekdays yourself. DATE CONTEXT lists tomorrow and the next 7 days with correct day names. Copy them directly. "Wed, Mar 11" → use "Wed 3/11". Getting these wrong destroys trust.
- Start the plan from tomorrow or later — do not add a session for today.
- If "Mileage so far this week" in CURRENT TRAINING STATE is > 0, acknowledge it in the first bubble ("You've already got X miles in this week") and factor it into the weekly total. Do not ignore it.

DEFAULT FORMAT (for athletes not matching the EXPERIENCED RUNNER CLOSE TO RACE criteria above):
Write as 2 short iMessage texts separated by a blank line. Each under 480 characters.

First bubble: 2-3 sentences max. Lead with the most important constraint or context (injury, mileage baseline, race timeline, etc.). Then add one sentence explaining the training rationale behind the plan — why you've structured it this way. Keep it specific and grounded: "Starting with all easy miles to build your aerobic base before introducing quality work" or "Keeping volume conservative given the hip — easier to add than to walk back a flare-up." This is what makes the plan feel like coaching, not a random schedule. Do NOT open with "Got it" or any generic acknowledgment phrase. Do NOT restate their goal back to them.

Second bubble: this week's sessions, one per line, sorted chronologically by date — never group by type (runs first, then strength):
Mon 3/2 · Easy 3mi @ easy effort
Tue 3/3 · Strength + mobility 20 min
Sat 3/7 · Easy 4mi
Use short day abbreviations and M/D dates (cross-referenced against DATE CONTEXT — do not compute day names independently). Then close with three short lines on a new line, each as its own sentence:
1. Invite feedback on the plan — e.g. "How does this look? Happy to adjust anything."
2. Offer reminders naturally — e.g. "I can also shoot you a reminder the morning of each session or the evening before — just let me know which works better."
3. Open line — e.g. "And this number's always open — how a run felt, questions, if something's off. That's what I'm here for."
Vary the phrasing each time — these are the ideas, not a script.

ONE QUESTION RULE: The closing line above is the only question in the entire response. Do not ask anything else — no follow-ups about injuries, niggles, schedule, or anything else. If you want to flag something about an injury or constraint, state it as information ("I've kept this conservative given your hip") not as a question.`;

  }
}
