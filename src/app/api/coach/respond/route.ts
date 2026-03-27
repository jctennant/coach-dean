import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { calculateVDOTPaces, estimatePacesFromEasyPace, easyPaceRange } from "@/lib/paces";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping, typingDurationMs } from "@/lib/linq";
import { trackEvent } from "@/lib/track";
import { fetchWeekWeather, buildWeatherBlock } from "@/lib/weather";
import { buildPeriodization, computePhase } from "@/lib/periodization";
import type { PeriodizationContext } from "@/lib/periodization";
import { computePhaseForPlan, generateAndSaveFullPlan } from "@/lib/training-plan";
import { enforceVolumeCaps, deduplicateSessionLines } from "@/lib/plan-validation";
import type { Json } from "@/lib/database.types";

export const maxDuration = 120;

type TriggerType = "morning_plan" | "post_run" | "user_message" | "initial_plan" | "weekly_recap" | "nightly_reminder" | "morning_reminder" | "workout_image";

interface CoachRequest {
  userId: string;
  trigger: TriggerType;
  activityId?: number;
  imageActivity?: Record<string, unknown>; // Pre-extracted workout data from image upload
  dry_run?: boolean;
  chatId?: string; // Linq chat ID — passed directly so typing indicator works without a DB round-trip
  includeWorkoutCheckin?: boolean; // True when we want to check in on the previous session alongside the reminder (non-Strava users)
  missedRunCheckin?: boolean; // True when Strava user had a scheduled workout but no run came through — check if they got it in
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
  source: string | null;
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
  const { userId, trigger, activityId, imageActivity, dry_run, chatId: requestChatId, includeWorkoutCheckin, missedRunCheckin } = body;

  // Fetch user context in parallel
  const [
    userResult,
    profileResult,
    stateResult,
    conversationsResult,
    recentActivitiesResult,
    raceHistoryResult,
    upcomingRacesResult,
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
      // user_message needs full context; proactive triggers (reminders, post_run, plans) need less
      .limit(trigger === "user_message" ? 15 : 8),
    supabase
      .from("activities")
      .select(
        "activity_type, distance_meters, moving_time_seconds, average_heartrate, elevation_gain, average_pace, start_date, average_cadence, gear_name, source"
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
    supabase
      .from("races")
      .select("race_date, race_name, goal, priority, goal_time_minutes, goal_distance_miles")
      .eq("user_id", userId)
      .gte("race_date", new Date().toISOString().split("T")[0])
      .order("race_date", { ascending: true })
      .limit(10),
  ]);

  const user = userResult.data;
  let profile = profileResult.data;
  const state = stateResult.data;
  const recentMessages = conversationsResult.data?.reverse() || [];
  const recentActivities = deduplicateActivities(
    (recentActivitiesResult.data as ActivityRow[] | null) || []
  );
  const raceHistory =
    (raceHistoryResult.data as Array<Record<string, unknown>> | null) || [];
  const upcomingRaces =
    (upcomingRacesResult.data as Array<Record<string, unknown>> | null) || [];

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
  // For post_run, exclude the current activity from RECENT WORKOUTS — it's already shown
  // in the user message activity details, and duplicating it causes week-mileage double-counting.
  const excludeFromSummary = trigger === "post_run" && activityData?.start_date
    ? new Date(activityData.start_date as string).getTime()
    : undefined;
  const recentWorkoutsMode =
    trigger === "post_run" ? "suppress" :
    trigger === "weekly_recap" ? "this_week_only" : "full";
  const activitySummary = buildActivitySummary(recentActivities, userTimezone, excludeFromSummary, recentWorkoutsMode as "full" | "suppress" | "this_week_only");
  const weekMileageSoFar = computeWeekMileage(recentActivities, userTimezone);
  const weekRunCount = computeWeekRunCount(recentActivities, userTimezone);
  // Fall back to the onboarding-stated mileage baseline for non-Strava users until
  // enough activity history accumulates for a real 6-week average.
  const weeklyMilesBaseline = ((user.onboarding_data as Record<string, unknown> | null)?.weekly_miles as number | null) ?? null;
  const avgWeeklyMileage = computeAvgWeeklyMileage(recentActivities, userTimezone) ?? weeklyMilesBaseline;
  const coachingSignals = computeCoachingSignals(recentActivities, userTimezone, profile?.race_date as string | null, weekMileageSoFar);
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

  const shouldUseWebSearch = trigger === "user_message";

  // For user_message: extract race/pace data BEFORE building the system prompt so the
  // coach responds with accurate paces immediately (not one message later).
  let pendingExtracted: Awaited<ReturnType<typeof extractProfileData>> | null = null;
  let computedVdot: number | null = null;
  const originalProfile = profile; // preserve for crosstraining merge in persistence
  if (trigger === "user_message") {
    const latestMsg = [...recentMessages].reverse().find(m => m.role === "user");
    if (latestMsg) {
      pendingExtracted = await extractProfileData(latestMsg.content, userTimezone);
      const hasRaceData = !!(pendingExtracted?.recent_race_distance_km && pendingExtracted?.recent_race_time_minutes);
      const hasEasyPace = !!pendingExtracted?.easy_pace;
      if (hasRaceData) {
        const paces = calculateVDOTPaces(
          pendingExtracted!.recent_race_distance_km!,
          pendingExtracted!.recent_race_time_minutes!
        );
        computedVdot = paces.vdot;
        profile = { ...profile, current_easy_pace: paces.easy, current_tempo_pace: paces.tempo, current_interval_pace: paces.interval } as typeof profile;
      } else if (hasEasyPace) {
        const p = estimatePacesFromEasyPace(pendingExtracted!.easy_pace!);
        if (p.easy) profile = { ...profile, current_easy_pace: p.easy, ...(p.tempo ? { current_tempo_pace: p.tempo } : {}), ...(p.interval ? { current_interval_pace: p.interval } : {}) } as typeof profile;
      }
    }
  }

  // Compute the training week, phase, and deload/progression targets for this plan.
  const hasStrava = !!(user.strava_athlete_id as number | null);
  // For non-Strava users, avgWeeklyMileage is always null (no tracked activities).
  // Fall back to the stored weekly_mileage_target (what Dean last prescribed) so the
  // progression target doesn't silently drop to null and cause Dean to reset the plan.
  const storedMileageTarget = (state?.weekly_mileage_target as number | null) ?? null;
  const periodizationMileage = avgWeeklyMileage ?? (!hasStrava && storedMileageTarget ? storedMileageTarget : null);
  const periodization: PeriodizationContext = buildPeriodization(
    trigger,
    (state?.current_week as number | null) ?? null,
    (profile?.race_date as string | null) ?? null,
    periodizationMileage
  );

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
    weatherBlock,
    computedVdot,
    trigger,
    periodization,
    upcomingRaces
  );

  // For weekly_recap and user_message, fetch the stored training plan.
  // weekly_recap: injects the current-week plan so Dean recaps what was planned vs actual.
  // user_message: injects the next-week plan so Dean can propose and commit to adjustments.
  type StoredPlanWeek = { week_number: number; phase: string; mileage_target: number; long_run_target: number; key_workout: string; notes: string };
  let storedPlanWeek: StoredPlanWeek | null = null;
  let storedNextPlanWeek: StoredPlanWeek | null = null;
  let storedPlanAllWeeks: StoredPlanWeek[] = [];
  let storedPlanId: string | null = null;
  if (trigger === "weekly_recap" || trigger === "user_message") {
    const { data: planData } = await supabase
      .from("training_plans")
      .select("id, weeks, total_weeks")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (planData?.weeks && Array.isArray(planData.weeks)) {
      const currentWeekNum = periodization.effectiveWeek;
      storedPlanAllWeeks = planData.weeks as StoredPlanWeek[];
      storedPlanId = planData.id as string;
      storedPlanWeek = storedPlanAllWeeks.find(w => w.week_number === currentWeekNum) ?? null;
      storedNextPlanWeek = storedPlanAllWeeks.find(w => w.week_number === currentWeekNum + 1) ?? null;
    }
  }

  // Build user message based on trigger
  const injuryNotes = (profile?.injury_notes as string | null) || null;
  const timezoneConfirmed = !!(onboardingData.timezone_confirmed) || !!(user.strava_athlete_id); // Strava users get TZ from athlete profile
  const userMessage = buildUserMessage(trigger, activityData, imageActivity, includeWorkoutCheckin, injuryNotes, userTimezone, hasStrava, weekMileageSoFar, weekRunCount, missedRunCheckin, periodization, storedPlanWeek, storedNextPlanWeek, timezoneConfirmed);

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
    // Plans can be longer (full week schedule); SMS triggers cap at 512 (SMS max ~640 chars ≈ 150 tokens)
    max_tokens: (trigger === "initial_plan" || trigger === "weekly_recap") ? 800 : 512,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    ...(shouldUseWebSearch
      ? { tools: [{ type: "web_search_20250305" as const, name: "web_search" }] }
      : {}),
  });

  // Stop the typing refresh loop — generation is done, message is about to send.
  keepTypingAlive = false;

  // When web search is used, Claude emits text blocks both BEFORE the tool_use block
  // (internal reasoning like "Let me check that.") and AFTER it (the actual response).
  // We must discard pre-search text — it's reasoning, not a coach message — and only
  // keep text blocks that follow the last tool_use block.
  // When no tool is used, all text blocks are part of the answer and are concatenated.
  //
  // Claude streams the response as many small fragments when using web search
  // (individual sentences, clause continuations, even standalone commas/periods).
  // Join them at block boundaries: append punctuation-starting blocks directly to the
  // previous block; add a single space when two word-boundary blocks meet. This preserves
  // any embedded paragraph breaks (\n\n inside blocks) without introducing spurious ones.
  const lastToolIdx = response.content.reduce(
    (idx, b, i) => (b.type === "tool_use" ? i : idx),
    -1
  );
  const textBlocks = response.content
    .slice(lastToolIdx + 1) // if no tool_use, lastToolIdx === -1 → slice(0) = all blocks
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text.trim())
    .filter(t => t.length > 0);
  const rawText = textBlocks.reduce((acc, block) => {
    if (!acc) return block;
    // If boundary already has whitespace, or block starts with punctuation that
    // attaches to the preceding word (comma, period, colon, etc.), append directly.
    if (/\s$/.test(acc) || /^[,;:.!?)}\]]/.test(block)) return acc + block;
    // Otherwise two non-space character boundaries meet — insert a single space.
    return acc + " " + block;
  }, "");
  // Strip internal system tokens ([NO_REPLY], etc.) from the text before any
  // further processing. These should never reach the athlete's SMS.
  const strippedRaw = rawText.replace(/\[NO_REPLY\]/gi, "").trim();
  // correctMileageTotal catches math errors where Claude states a weekly total that
  // doesn't match the sum of session distances in the response.
  // - post_run: uses correctProjectedTotal instead — no session plan in the response
  //   but still need to fix "on track for X mi" when Dean's number diverges from the
  //   system-computed projection (see computeProjectedWeekMiles).
  // - user_message: run with weekMileageSoFar — catches cases like Ian's where Dean
  //   removes a session from the list but forgets to recalculate the stated total.
  // - weekly_recap / initial_plan: run with alreadyCompletedMiles=0 — full week being planned.
  // - all other triggers (reminders, morning_plan): run with weekMileageSoFar.
  const alreadyCompletedMiles =
    trigger === "initial_plan" || trigger === "weekly_recap" ? 0 : weekMileageSoFar;
  const stripped = stripMarkdown(strippedRaw);
  // post_run: skip full session-list correction (no session plan in the response)
  // but still correct "on track for X mi" using the system-computed projection —
  // Dean sometimes mentions only the next 1-2 sessions while citing the full-week
  // projected total, making the math look wrong to the user.
  const mileageCorrected = trigger === "post_run"
    ? correctProjectedTotal(
        stripped,
        computeProjectedWeekMiles(
          (state?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }> | null) ?? null,
          weekMileageSoFar
        )
      )
    : correctMileageTotal(stripped, alreadyCompletedMiles);

  // Enforce hard volume caps for plan-generating triggers when the athlete is
  // in the low-volume tier (< 10 mi/week). Prompt instructions alone are not
  // reliable enough for this safety-critical constraint.
  const planTriggers = new Set<TriggerType>(["initial_plan", "weekly_recap"]);
  const isLowVolume = avgWeeklyMileage != null && avgWeeklyMileage < 10;
  const weeklyCapMiles =
    planTriggers.has(trigger) && isLowVolume
      ? Math.max(Math.ceil(avgWeeklyMileage! * 1.3), 6)
      : null;
  const longRunCapMiles =
    planTriggers.has(trigger) && isLowVolume
      ? Math.max(Math.ceil(avgWeeklyMileage! * 0.35), 3)
      : null;
  const { message: volumeChecked } = enforceVolumeCaps(
    mileageCorrected,
    weeklyCapMiles,
    longRunCapMiles
  );

  // Remove exact duplicate session lines (e.g. same "Thu 3/26 · Easy 2mi" twice)
  const coachMessage = deduplicateSessionLines(volumeChecked);

  if (dry_run) return NextResponse.json({ ok: true, dry_run: true, message: coachMessage });

  // Claude signals "nothing to send" with [NO_REPLY] — skip all SMS and DB writes.
  // Also skip if the response is empty (can happen if web search returns no final text block,
  // or Claude times out mid-generation) — sending an empty body causes Linq to deliver a ".".
  if (!coachMessage.trim() || coachMessage.trim() === "[NO_REPLY]") {
    console.log("[coach/respond] Claude returned empty or [NO_REPLY] — skipping send");
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Split into iMessage-sized chunks. Each part is sent as a separate text
  // with its own typing indicator so it feels like a real person composing
  // multiple follow-up messages.
  const parts = splitIntoMessages(coachMessage);
  const msgType =
    trigger === "post_run"
      ? "post_run"
      : trigger === "initial_plan"
        ? "initial_plan"
        : trigger === "morning_plan"
          ? "morning_plan"
          : trigger === "nightly_reminder"
            ? "nightly_reminder"
            : trigger === "morning_reminder"
              ? "morning_reminder"
              : trigger === "weekly_recap"
                ? "weekly_recap"
                : "coach_response";

  const targetMiles = (state?.weekly_mileage_target as number | null) ?? 0;
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
    // Persist week counter, phase, and computed target. Clear taper_peak_miles so the
    // next taper window re-locks the peak from scratch.
    await supabase.from("training_state").update({
      current_week: periodization.effectiveWeek,
      current_phase: periodization.phase,
      taper_peak_miles: null,
      ...(periodization.suggestedWeeklyMiles != null ? { weekly_mileage_target: periodization.suggestedWeeklyMiles } : {}),
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
    // Extract and store the specific planned sessions so all subsequent messages
    // (post_run, reminders) use the exact same distances — not independently recalculated.
    await extractAndStorePlanSessions(userId, coachMessage);
    // Parse the prescribed week 1 total from the plan text so the arc week 1 matches
    // what Dean actually sent (not an independently recomputed estimate).
    // Match "Total: ~18mi" OR "~18 miles this week" (the more common format Dean uses)
    const prescribedWeek1Match =
      coachMessage.match(/Total[:\s~]+(\d+(?:\.\d+)?)\s*mi/i) ||
      coachMessage.match(/~(\d+(?:\.\d+)?)\s+mi(?:les?)?\s+this\s+week/i);
    const prescribedWeek1Miles = prescribedWeek1Match ? parseFloat(prescribedWeek1Match[1]) : null;
    // Generate and save the full multi-week training arc, then text the dashboard link.
    // Pass B/C races so the arc enrichment Haiku can label those weeks appropriately.
    const bCRaces = upcomingRaces.filter(r => r.priority === "B" || r.priority === "C") as Array<{ race_date: string; race_name: string | null; priority: string }>;
    await generateAndSaveFullPlan(userId, user.phone_number as string, profile, avgWeeklyMileage, { prescribedWeek1Miles: prescribedWeek1Miles ?? undefined, bRaces: bCRaces.length > 0 ? bCRaces : undefined });
  } else if (trigger === "weekly_recap") {
    void trackEvent(userId, "plan_generated", { plan_type: "weekly" });
    // Advance week counter and phase; update mileage target to this week's computed value.
    await supabase.from("training_state").update({
      current_week: periodization.effectiveWeek,
      current_phase: periodization.phase,
      ...(periodization.suggestedWeeklyMiles != null ? { weekly_mileage_target: periodization.suggestedWeeklyMiles } : {}),
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
    await extractAndStorePlanSessions(userId, coachMessage);
  }

  // For user_message, persist any profile updates extracted above (injuries, cross-training,
  // race data, preferences) and check for plan changes. We already extracted in-memory
  // before building the system prompt; now just persist to DB fire-and-forget.
  if (trigger === "user_message") {
    const latestUserMsg = [...recentMessages].reverse().find(m => m.role === "user");
    if (latestUserMsg) {
      if (pendingExtracted) {
        await persistProfileUpdates(
          userId,
          pendingExtracted,
          originalProfile,
          (user.onboarding_data as Record<string, unknown>) || {},
          userTimezone
        );
      }
      const currentSessions = (state?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }>) ?? [];
      await maybeUpdatePlanSessions(userId, currentSessions, latestUserMsg.content, coachMessage);
      if (storedPlanId && storedPlanAllWeeks.length > 0) {
        await maybeUpdateTrainingPlanWeeks(storedPlanId, storedPlanAllWeeks, latestUserMsg.content, coachMessage);
      }
    }
  }

  // Lock in taper_peak_miles the first time an athlete enters the taper window (≤21 days
  // to race). Must happen here (not inside buildSystemPrompt) so the await is guaranteed.
  if (!state?.taper_peak_miles && avgWeeklyMileage && avgWeeklyMileage > 0 && profile?.race_date) {
    const raceDate = new Date((profile.race_date as string) + "T00:00:00");
    const daysUntil = Math.ceil((raceDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (daysUntil > 0 && daysUntil <= 21) {
      await supabase
        .from("training_state")
        .update({ taper_peak_miles: Math.round(avgWeeklyMileage * 10) / 10 })
        .eq("user_id", userId);
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
 * Compute the system-authoritative projected week total from stored sessions + done miles.
 * Mirrors the logic in buildCurrentTrainingState so they stay in sync.
 */
function computeProjectedWeekMiles(
  sessions: Array<{ day: string; date: string; label: string }> | null,
  weekMileageSoFar: number
): number | null {
  if (!sessions || sessions.length === 0) return null;
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const activeSessions = sessions.filter(s => {
    const [m, d] = s.date.split("/").map(Number);
    if (isNaN(m) || isNaN(d)) return true;
    const sessionDate = new Date(Date.UTC(now.getUTCFullYear(), m - 1, d));
    return sessionDate.getTime() >= todayUTC.getTime();
  });
  if (activeSessions.length === 0) return weekMileageSoFar;
  let remainingMiles = 0;
  for (const s of activeSessions) {
    const explicitTotal = s.label.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi/i)
      || s.label.match(/\((\d+(?:\.\d+)?)\s*mi(?:\s+total)?\)/i);
    const firstMi = s.label.match(/(\d+(?:\.\d+)?)\s*mi/i);
    const mMatch = explicitTotal || firstMi;
    if (mMatch) remainingMiles += parseFloat(mMatch[1]);
  }
  return weekMileageSoFar + remainingMiles;
}

/**
 * Correct "on track for X mi" / "projected X mi" in post_run responses.
 * Dean computes this himself from the session list, but may only mention a subset
 * of upcoming sessions while citing the full projection — making the math look wrong.
 * Replace with the system-computed value when they diverge.
 */
function correctProjectedTotal(message: string, projectedWeekMiles: number | null): string {
  if (!projectedWeekMiles || projectedWeekMiles <= 0) return message;
  const projected = Math.round(projectedWeekMiles * 10) / 10;
  const patterns: RegExp[] = [
    /(on\s+track\s+for\s+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(on\s+pace\s+for\s+~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(projected\s+(?:(?:to\s+hit|total)[:\s]+)?~?)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  ];
  let corrected = message;
  for (const pattern of patterns) {
    corrected = corrected.replace(pattern, (full, pre, num, post) => {
      const stated = parseFloat(num);
      if (Math.abs(stated - projected) <= 0.4) return full;
      console.warn(`[correctProjectedTotal] stated ${stated}mi projected, system says ${projected}mi — correcting`);
      return `${pre}${projected}${post}`;
    });
  }
  return corrected;
}

/**
 * Post-processing guard: if the message contains a session list and a stated
 * weekly mileage total, verify the total matches the sum of running sessions
 * and correct it if not. Strength, mobility, and cross-training lines are skipped.
 *
 * Only activates when both a session list (lines matching our format) and a
 * stated total are found — otherwise it's a no-op.
 */
function correctMileageTotal(message: string, alreadyCompletedMiles = 0): string {
  // Session lines: "Mon 3/2 · ..." or "Tue 3/10 · ..."
  // Capture month/day so we can detect future-week plans.
  const sessionLineRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d+)\/(\d+)\s+·\s+(.+)$/gm;

  let plannedMiles = 0;
  let hasSessionList = false;
  let earliestSessionMs = Infinity;
  let m: RegExpExecArray | null;

  while ((m = sessionLineRe.exec(message)) !== null) {
    hasSessionList = true;
    const monthNum = parseInt(m[2], 10);
    const dayNum = parseInt(m[3], 10);
    const desc = m[4];

    // Track earliest session date to detect future-week plans
    const now = new Date();
    const sessionDate = new Date(Date.UTC(now.getUTCFullYear(), monthNum - 1, dayNum));
    // If this date appears to be >180 days in the past, assume it wraps to next year
    if (now.getTime() - sessionDate.getTime() > 180 * 24 * 60 * 60 * 1000) {
      sessionDate.setUTCFullYear(now.getUTCFullYear() + 1);
    }
    if (sessionDate.getTime() < earliestSessionMs) earliestSessionMs = sessionDate.getTime();

    // Skip mileage counting for cross-training sessions regardless of what unit appears.
    // Claude sometimes writes "60mi" meaning "60 minutes" for bike sessions — counting
    // that as 60 miles inflates the total and defeats the correction.
    const isCrossTraining = /\b(bike|biking|cycling|swim|swimming|strength|mobility|stretch|yoga|elliptical|cross.train)\b/i.test(desc);
    if (isCrossTraining) continue;

    // Positive matching: only count sessions that have an explicit mileage marker.
    // Non-running sessions (strength, cross-training, swimming, cycling, rest) are
    // instructed in the prompt to NEVER include a distance in miles — so no mi marker
    // means it's a non-running session. This avoids a brittle exclusion keyword list.
    //   "≈7mi", "~7mi", "(7mi total)", "= 7mi" — these are intentionally placed totals.
    // Fall back to the first mileage figure for simple sessions ("Easy 5mi @ 9:30/mi" → 5).
    // Use word boundaries on "mi" so "60 min" is not counted as 60 miles.
    // \bmi\b matches "mi" and "mi" alone; "miles" is caught by the mi(?:les?)? variant.
    const explicitTotal = desc.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi(?:les?)?\b/i)
      || desc.match(/\((\d+(?:\.\d+)?)\s*mi(?:les?)?(?:\s+total)?\)/i);
    const firstMi = desc.match(/(\d+(?:\.\d+)?)\s*mi(?:les?)?\b/i);
    const miMatch = explicitTotal || firstMi;
    if (miMatch) plannedMiles += parseFloat(miMatch[1]);
  }

  if (!hasSessionList || plannedMiles === 0) return message;

  // If the plan's sessions start in a future week, the already-completed miles for the
  // current week don't apply — the new week starts at 0. Without this check, a user who
  // has run 10 mi this week and asks for next week's 15 mi plan gets correctTotal = 25,
  // which makes Dean's "15 mi total" look wrong and get "corrected" upward to 25.
  let effectiveCompleted = alreadyCompletedMiles;
  if (earliestSessionMs !== Infinity && alreadyCompletedMiles > 0) {
    // Get UTC Monday of a date (no timezone needed — plan dates are in rough UTC)
    const getUTCMonday = (d: Date): number => {
      const dow = d.getUTCDay(); // 0=Sun
      const daysBack = dow === 0 ? 6 : dow - 1;
      return d.getTime() - daysBack * 86_400_000;
    };
    const planMonday = getUTCMonday(new Date(earliestSessionMs));
    const todayMonday = getUTCMonday(new Date());
    if (planMonday > todayMonday) effectiveCompleted = 0;
  }

  // The correct week total = planned sessions + miles already completed this week.
  // For weekly_recap / initial_plan callers, alreadyCompletedMiles is 0.
  const correctTotal = Math.round((plannedMiles + effectiveCompleted) * 10) / 10;
  const plannedRounded = Math.round(plannedMiles * 10) / 10;

  // Patterns that state a weekly total — replace the number if wrong
  // Handles: "10 miles total", "Total: 10mi", "stays at 10 miles", "~10mi total", etc.
  const totalPatterns: RegExp[] = [
    /(Total:\s*~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?[ \t]*(?:total|this week|for the week))/gi,
    /(week(?:ly)?\s+(?:mileage|total)[:\s]+~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(stays?\s+at\s+~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(staying\s+at\s+~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
    /(puts\s+(?:you\s+at|the\s+week\s+at)\s+~?)(?<!-)(\d+(?:\.\d+)?)(\s*mi(?:les?)?)/gi,
  ];

  let corrected = message;
  for (const pattern of totalPatterns) {
    corrected = corrected.replace(pattern, (full, pre, num, post) => {
      const stated = parseFloat(num);
      // Already correct — stated matches the full week total
      if (Math.abs(stated - correctTotal) <= 0.4) return full;
      // Stated matches already-completed miles — Claude is correctly reporting current
      // week-to-date mileage (not a projected total). Leave it alone.
      if (effectiveCompleted > 0.5 && Math.abs(stated - effectiveCompleted) <= 0.4) return full;
      // Stated matches plan-only total but ignores already-completed miles — correct it
      if (effectiveCompleted > 0.5 && Math.abs(stated - plannedRounded) <= 0.4) {
        console.warn(`[correctMileageTotal] stated ${stated}mi = plan only; full week total is ${correctTotal}mi (${plannedRounded} planned + ${effectiveCompleted} completed) — correcting`);
        return `${pre}${correctTotal}${post}`;
      }
      // Stated is wrong outright — correct to full week total
      console.warn(`[correctMileageTotal] stated ${stated}mi, correct total is ${correctTotal}mi — correcting`);
      return `${pre}${correctTotal}${post}`;
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

/** Format a fractional minutes-per-mile value as "M:SS/mi". Safe against :60 rollover. */
function fmtPace(minsPerMile: number, unit: "mi" | "km" = "mi"): string {
  const totalSec = Math.round(minsPerMile * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}/${unit}`;
}

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
 * Remove near-duplicate activities. Two passes:
 *
 * Pass 1 — Strava near-dupes: same run stored twice with different strava_activity_ids
 *   (e.g. watch auto-sync + manual GPX upload). Start times within ±2 min, distance within 15%.
 *   Keep the richer record (has HR); otherwise keep the first seen.
 *
 * Pass 2 — Manual/conversation shadow of a Strava activity: user texted Dean about a run
 *   before or after Strava synced it. The Strava webhook tries to delete these but can miss
 *   (e.g. time-of-day causes UTC date shift). Same UTC date, same activity type, distance
 *   within 15% → discard the manual/conversation record, keep the Strava one.
 */
function deduplicateActivities(activities: ActivityRow[]): ActivityRow[] {
  // Pass 1: near-dupe by start time (±2 min)
  const kept: ActivityRow[] = [];
  for (const a of activities) {
    const aMs = new Date(a.start_date).getTime();
    const dupeIndex = kept.findIndex((k) => {
      // Never dedup across different activity types — a bike can't be a near-dupe of a run
      if (k.activity_type !== a.activity_type) return false;
      const kMs = new Date(k.start_date).getTime();
      if (Math.abs(aMs - kMs) > 120_000) return false;
      const larger = Math.max(k.distance_meters || 0, a.distance_meters || 0);
      if (larger === 0) return false;
      return Math.abs((k.distance_meters || 0) - (a.distance_meters || 0)) / larger < 0.15;
    });
    if (dupeIndex === -1) {
      kept.push(a);
    } else if (a.average_heartrate != null && kept[dupeIndex].average_heartrate == null) {
      // Incoming activity is richer — replace the existing weaker one
      kept[dupeIndex] = a;
    }
    // else: existing is richer or equivalent — discard incoming
  }

  // Pass 2: drop manual/conversation activities that have a Strava counterpart on the same UTC
  // date with similar distance. The Strava webhook tries to delete these, but can miss when the
  // run happens late at night and crosses a UTC day boundary.
  const stravaDates = new Map<string, number[]>(); // UTC date → [distance_meters, ...]
  for (const a of kept) {
    if (a.source === "strava" || (a.source == null)) {
      const dateKey = a.start_date.slice(0, 10); // UTC date
      if (!stravaDates.has(dateKey)) stravaDates.set(dateKey, []);
      stravaDates.get(dateKey)!.push(a.distance_meters || 0);
    }
  }

  return kept.filter((a) => {
    if (a.source !== "manual" && a.source !== "conversation") return true;
    const dateKey = a.start_date.slice(0, 10);
    const stravaMiles = stravaDates.get(dateKey);
    if (!stravaMiles) return true;
    const aDist = a.distance_meters || 0;
    // If any Strava activity on this UTC date has similar distance → discard manual shadow
    return !stravaMiles.some((d) => {
      const larger = Math.max(d, aDist);
      return larger > 0 && Math.abs(d - aDist) / larger < 0.15;
    });
  });
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

  // Sort by week key (YYYY-MM-DD) so slice(-6) takes the 6 most recent weeks,
  // not the 6 oldest (Object.values insertion order is newest-first since
  // activities are fetched start_date DESC).
  const weekValues = Object.entries(weeks)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([, v]) => v);
  if (weekValues.length === 0) return null;
  return weekValues.reduce((s, v) => s + v, 0) / weekValues.length;
}

/**
 * Compute proactive coaching signals from recent activity data.
 * These are surfaced in the system prompt so Dean can bring them up at natural moments.
 */
function computeCoachingSignals(activities: ActivityRow[], timezone: string, raceDate?: string | null, currentWeekMiles?: number): CoachingSignals {
  const runTypes = new Set(["Run", "TrailRun", "VirtualRun"]);

  // Average cadence from the 10 most recent runs with cadence data
  const runsWithCadence = activities
    .filter(a => runTypes.has(a.activity_type) && a.average_cadence && a.average_cadence > 100)
    .slice(0, 10);
  const avgCadenceSpm = runsWithCadence.length >= 3
    ? runsWithCadence.reduce((s, a) => s + (a.average_cadence ?? 0), 0) / runsWithCadence.length
    : null;

  // Week-over-week ramp: compare current week's mileage (so far) vs last completed week.
  // Using current vs last-completed is what athletes and coaches actually track for overuse risk.
  const thisMonday = localWeekMonday(new Date(), timezone);
  const weeklyMiles: Record<string, number> = {};
  for (const a of activities) {
    if (!RUN_TYPES.has(a.activity_type)) continue;
    const key = localWeekMonday(new Date(a.start_date), timezone);
    if (key >= thisMonday) continue; // skip current partial week — we use currentWeekMiles instead
    weeklyMiles[key] = (weeklyMiles[key] || 0) + (a.distance_meters || 0) / 1609.34;
  }
  const sortedCompleteWeeks = Object.keys(weeklyMiles).sort().reverse();
  let weekOverWeekRampPct: number | null = null;
  const lastCompletedWeekMiles = sortedCompleteWeeks.length > 0 ? weeklyMiles[sortedCompleteWeeks[0]] : null;
  if (currentWeekMiles != null && lastCompletedWeekMiles != null && lastCompletedWeekMiles > 0) {
    weekOverWeekRampPct = ((currentWeekMiles - lastCompletedWeekMiles) / lastCompletedWeekMiles) * 100;
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
function buildActivitySummary(activities: ActivityRow[], timezone: string, excludeStartMs?: number, recentWorkoutsMode: "full" | "suppress" | "this_week_only" = "full"): string {
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
    if (!RUN_TYPES.has(a.activity_type)) return false;
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

  if (recentWorkoutsMode !== "suppress") {
    // Individual workout log — chronological (oldest first).
    // "suppress": omitted entirely (post_run — current activity is in user message).
    // "this_week_only": only shows runs from the current week (weekly_recap — avoids cross-week summing while still giving Claude the details it needs to recap the week).
    // "full": all recent runs with week tags (initial_plan, user_message, etc.).
    const recentRaw = [...activities].reverse().slice(-20);
    const recent = excludeStartMs !== undefined
      ? recentRaw.filter(a => new Date(a.start_date).getTime() !== excludeStartMs)
      : recentRaw;
    const currentWeekKey = localWeekMonday(new Date(), timezone);
    const filteredRecent = recentWorkoutsMode === "this_week_only"
      ? recent.filter(a => localWeekMonday(new Date(a.start_date), timezone) === currentWeekKey)
      : recent;
    if (filteredRecent.length > 0) {
      const header = recentWorkoutsMode === "this_week_only"
        ? `\nTHIS WEEK'S RUNS (do not sum these to compute mileage — use the authoritative figure above):\n`
        : `\nRECENT WORKOUTS (chronological, oldest first):\n`;
      summary += header;
      for (const a of filteredRecent) {
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
    }
  }

  return summary;
}

function buildCoachingSignalsBlock(signals: CoachingSignals): string {
  const lines: string[] = [];

  if (signals.avgCadenceSpm !== null && signals.avgCadenceSpm < 170) {
    lines.push(`- Cadence: avg ${Math.round(signals.avgCadenceSpm)} spm (below the ~170-180 spm target for efficient running). Low cadence usually means overstriding — the foot lands ahead of the center of mass, increasing braking forces and injury risk. Bring this up naturally in post-run feedback or the weekly recap — one casual observation is enough. Suggested cue: "try for a slightly quicker, shorter stride" rather than a technical lecture.`);
  }

  if (signals.weekOverWeekRampPct !== null && signals.weekOverWeekRampPct > 10) {
    lines.push(`- Mileage ramp: current week is +${Math.round(signals.weekOverWeekRampPct)}% above last completed week (above the 10% guideline). This compares the current week's mileage so far vs the prior full week — not the week before that. Mention this naturally in post-run feedback or the weekly recap — bones and tendons adapt slower than cardiovascular fitness, so big jumps are where overuse injuries originate. Keep the tone matter-of-fact, not alarming.`);
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

/**
 * After a user_message exchange, check if the coach committed to adjusting any
 * upcoming training plan weeks (e.g. reducing mileage for illness, swapping the
 * key workout for travel, marking a week as recovery). If so, patch those weeks
 * in the stored training_plans.weeks JSONB array.
 *
 * Only fires when adjustment-relevant keywords are present — avoids a Haiku call
 * on every conversational message.
 */
async function maybeUpdateTrainingPlanWeeks(
  planId: string,
  allWeeks: Array<{ week_number: number; phase: string; mileage_target: number; long_run_target: number; key_workout: string; notes: string }>,
  userMessage: string,
  coachResponse: string
): Promise<void> {
  const adjustmentKeywords = /\b(sick|ill|illness|injury|injured|hurt|travel|traveling|travelling|busy|adjust|update.*plan|change.*plan|drop.*week|recovery week|rest week|modified|lighter week|easy week)\b/i;
  if (!adjustmentKeywords.test(userMessage) && !adjustmentKeywords.test(coachResponse)) return;

  // Only look ahead at upcoming weeks — don't allow retroactive changes to past weeks.
  // We infer "current" as the lowest week_number not yet modified; practically just pass all weeks
  // and let Haiku pick the right ones from the coach's response.
  const upcomingWeeks = allWeeks.slice(0, 8); // limit context size

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `You are checking whether a coaching exchange committed to changing an upcoming training plan week.

Upcoming plan weeks (JSON):
${JSON.stringify(upcomingWeeks)}

If the coach did NOT explicitly commit to changing a plan week, return: {"changed": false}
If the coach DID commit (e.g. said "I've updated week X", "I've adjusted next week", "dropping week X to...", "I'll make it a recovery week"), return:
{"changed": true, "weeks": [{"week_number": N, "mileage_target": X, "key_workout": "...", "notes": "..."}]}

Rules:
- Only return changed=true if the coach explicitly stated it is making a plan change — not just giving advice
- week_number must match an existing week in the list above
- For a recovery/rest week: mileage_target should be ~30% of the original, key_workout "Easy recovery — no quality work"
- Only include fields that are actually changing; always include week_number
- Return ONLY valid JSON, no other text`,
    messages: [{ role: "user", content: `Athlete: ${userMessage}\n\nCoach: ${coachResponse}` }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    if (!parsed.changed || !Array.isArray(parsed.weeks) || parsed.weeks.length === 0) return;

    const updatedWeeks = allWeeks.map(w => {
      const change = parsed.weeks.find((c: { week_number: number }) => c.week_number === w.week_number);
      return change ? { ...w, ...change } : w;
    });

    await supabase
      .from("training_plans")
      .update({ weeks: updatedWeeks as unknown as Json, updated_at: new Date().toISOString() })
      .eq("id", planId);
  } catch {
    // parse failed — leave plan unchanged
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
  weatherBlock?: string,
  freshVdot?: number | null,
  trigger?: TriggerType,
  periodization?: PeriodizationContext,
  upcomingRaces?: Array<Record<string, unknown>>
): string {
  // Which trigger-conditional sections to include.
  const isReminder = trigger === "morning_reminder" || trigger === "nightly_reminder";
  const isPlan = trigger === "initial_plan" || trigger === "weekly_recap";
  const isPostRun = trigger === "post_run";
  // Sections that are only useful when the athlete might raise a capability/philosophy question
  const isConversational = trigger === "user_message";
  // Sections useful when reviewing a completed run
  const isRunReview = isPostRun || isConversational;
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

  // Coach Dean start date + weeks
  const coachStartDate = user.created_at ? new Date(user.created_at as string) : null;
  const coachStartFormatted = coachStartDate
    ? coachStartDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;
  const weeksWithDean = coachStartDate
    ? Math.floor((Date.now() - coachStartDate.getTime()) / (7 * 24 * 60 * 60 * 1000))
    : null;

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
      const refreshedAt = stravaStats.refreshed_at as string | null;
      const freshnessNote = refreshedAt
        ? ` (as of ${new Date(refreshedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`
        : " (as of Strava connect — may be slightly outdated)";
      allTimeInfo += `- Year-to-date${freshnessNote}: ${ytdRun.count || 0} runs, ${Math.round((ytdRun.distance || 0) / 1609.34)} miles\n`;
    }
    // recent_run_totals (last 4 weeks from Strava) intentionally omitted — it's a stale
    // snapshot from connect time and has caused hallucinations where the model confuses
    // the 4-week aggregate with the current week's total. Live weekly breakdowns are in
    // WEEKLY MILEAGE below; current week is authoritative in CURRENT TRAINING STATE.
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

    // Inject a code-computed taper plan when 21 days or fewer remain.
    // Use the stored taper_peak_miles if available — this locks in the peak on first
    // entry so targets don't shift as avgWeeklyMileage fluctuates between messages.
    // If not yet stored, use avgWeeklyMileage and persist it as a side-effect.
    if (daysUntil > 0 && daysUntil <= 21 && avgWeeklyMileage && avgWeeklyMileage > 0) {
      const storedPeak = state?.taper_peak_miles as number | null;
      const peak = storedPeak ?? Math.round(avgWeeklyMileage * 10) / 10;
      const goal = profile?.goal as string | null;
      const isUltra = ["50k","100k","50mi","100mi"].includes(goal ?? "");
      const is30k = goal === "30k";
      const isMarathon = goal === "marathon";
      const isHalf = goal === "half_marathon";
      const isMile = goal === "mile";

      // Mile PR is a track/time-trial event — no traditional 3-week taper.
      // Within 7 days: cut volume ~30%, keep intensity, one short tune-up effort.
      if (isMile) {
        if (daysUntil <= 7) {
          dateContext += `- MILE SHARPENING WEEK: Time trial is ${daysUntil} days away. Cut total volume ~30% this week — keep one short speed session (4-6x400m @ mile effort), drop everything else to easy. No heavy quality work in the final 48 hours before the time trial.\n`;
        }
        // No action needed 8-21 days out — normal training continues
      } else {
      // Volume percentages by race type and taper stage.
      // 30K (~18.6 mi) is a trail race closer to marathon distance than to 5K/10K —
      // give it marathon-style taper rather than the short-race defaults.
      let w3Pct = 0.88, w2Pct = 0.72, w1Pct = 0.45;
      if (isUltra)    { w3Pct = 0.78; w2Pct = 0.62; w1Pct = 0.40; }
      else if (isMarathon || is30k) { w3Pct = 0.88; w2Pct = 0.72; w1Pct = 0.45; }
      else if (isHalf)     { w3Pct = 0.90; w2Pct = 0.75; w1Pct = 0.50; }
      else               { w3Pct = 0.90; w2Pct = 0.78; w1Pct = 0.55; } // 5K/10K

      const w3 = Math.round(peak * w3Pct);
      const w2 = Math.round(peak * w2Pct);
      const w1 = Math.round(peak * w1Pct);

      if (daysUntil > 14) {
        dateContext += `- TAPER PROTOCOL (rules-based — follow exactly): Peak volume ~${peak}mi/wk. This week (3 weeks out): ${w3}mi total. Next week (2 weeks out): ${w2}mi total. Race week: ${w1}mi total. No quality sessions in race week — easy miles only. One short race-pace tune-up (2-3mi @ goal pace) allowed 10-12 days out.\n`;
      } else if (daysUntil > 7) {
        dateContext += `- TAPER PROTOCOL (rules-based — follow exactly): Peak volume ~${peak}mi/wk. This week (2 weeks out): ${w2}mi total. Race week: ${w1}mi total. No quality sessions in race week — easy miles only. One short race-pace tune-up (2-3mi @ goal pace) is acceptable this week.\n`;
      } else {
        dateContext += `- TAPER PROTOCOL (rules-based — follow exactly): Peak volume ~${peak}mi/wk. Race week: ${w1}mi total. Easy miles only — no hard workouts. Shakeout run (15-30 min easy) the day before is optional.\n`;
      }
      } // end non-mile taper block
    }
  }

  // B/C race context: list upcoming secondary races, inject coaching guidance when close.
  const nonARaces = (upcomingRaces ?? []).filter(r => r.priority === "B" || r.priority === "C");
  if (nonARaces.length > 0) {
    for (const race of nonARaces) {
      const bRaceDate = new Date((race.race_date as string) + "T12:00:00Z");
      const daysUntilBRace = Math.ceil((bRaceDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      const weeksUntilBRace = Math.round(daysUntilBRace / 7);
      const bRaceLabel = (race.race_name as string | null) ?? (race.goal ? formatGoalLabel(race.goal as string) : "race");
      if (race.priority === "B") {
        if (daysUntilBRace <= 14) {
          dateContext += `- B RACE (tune-up): ${bRaceLabel} on ${race.race_date} (${daysUntilBRace} days away). Reduce total volume 10-15% this week. Race at a strong controlled effort — this is a tune-up, not an all-out peak. Resume normal training 2-3 days after.\n`;
        } else {
          dateContext += `- Upcoming B race (tune-up): ${bRaceLabel} on ${race.race_date} (~${weeksUntilBRace} weeks away). Keep in mind when scheduling hard sessions — leave a light day or two before it.\n`;
        }
      } else {
        if (daysUntilBRace <= 7) {
          dateContext += `- C RACE (for-fun): ${bRaceLabel} on ${race.race_date} (${daysUntilBRace} days away). No taper — treat it as a quality workout day. Normal training week otherwise.\n`;
        } else {
          dateContext += `- Upcoming C race (for-fun/workout): ${bRaceLabel} on ${race.race_date} (~${weeksUntilBRace} weeks away).\n`;
        }
      }
    }
  }

  const onboardingData = (user.onboarding_data as Record<string, unknown>) || {};
  const swimPace = onboardingData.swim_pace as string | null;
  const bikeInfo = onboardingData.bike_info as string | null;
  const weeklyHours = onboardingData.weekly_hours as number | null;
  const sportType = onboardingData.sport_type as string || "running";
  // If the athlete's goal was a non-standard distance (e.g. "25K Marin Headlands"),
  // race_name holds the exact description so we display it instead of the mapped bucket label.
  const raceName = onboardingData.race_name as string | null;
  const goalTimeMinutes = onboardingData.goal_time_minutes as number | null | undefined;
  const isTri = ["sprint_tri", "olympic_tri", "70.3", "ironman"].includes(profile?.goal as string || "");

  // Pre-compute goal pace so Claude never has to do the arithmetic (it gets it wrong).
  // Only computed for single-sport running goals where a race distance is known.
  // Prefer the exact stored goal_distance_miles (captures non-standard distances like 25K);
  // fall back to the canonical bucket distance.
  const runGoalDistancesMiles: Record<string, number> = {
    "mile": 1.0, "5k": 3.107, "10k": 6.214, "half_marathon": 13.109, "marathon": 26.219,
    "30k": 18.641, "50k": 31.069, "50mi": 50.0, "100k": 62.137, "100mi": 100.0,
  };
  const storedGoalDistanceMiles = profile?.goal_distance_miles as number | null ?? null;
  let goalPaceStr = "";
  if (goalTimeMinutes != null && profile?.goal) {
    const distMiles = storedGoalDistanceMiles ?? runGoalDistancesMiles[profile.goal as string];
    if (distMiles) {
      const paceMinsPerMile = goalTimeMinutes / distMiles;
      const pacePerKm = goalTimeMinutes / (distMiles * 1.60934);
      goalPaceStr = ` — goal pace: ${fmtPace(paceMinsPerMile, "mi")} (${fmtPace(pacePerKm, "km")})`;
    }
  }
  // Additional athlete preferences captured during onboarding (strengthening, cross-training
  // requests, injury prevention goals, race history notes, etc.)
  const otherNotes = onboardingData.other_notes as string | null;
  const secondaryGoal = onboardingData.secondary_goal as string | null;
  const crosstrainingTools = (profile?.crosstraining_tools as string[] | null)?.filter(Boolean);

  // TODO: Once Strava API app is approved, update "Activity tracking" in PRODUCT CAPABILITIES below to:
  // "Activity tracking: Strava only. No Garmin, Apple Watch, Wahoo, etc."
  // When the exact stored distance differs from the bucket standard (i.e., non-standard race),
  // append "(X miles)" so Claude never has to infer it.
  const bucketDistanceMiles = runGoalDistancesMiles[profile?.goal as string] ?? null;
  const isNonStandardDistance =
    storedGoalDistanceMiles != null &&
    bucketDistanceMiles != null &&
    Math.abs(storedGoalDistanceMiles - bucketDistanceMiles) > 0.5;
  const exactDistanceSuffix = isNonStandardDistance ? ` (${storedGoalDistanceMiles} miles)` : "";
  const goalDisplay = raceName
    ? `${raceName}${exactDistanceSuffix}`
    : (profile?.goal ? formatGoalLabel(profile.goal as string) : "general fitness");
  return `${profile?.race_date ? `ATHLETE: ${user.name || "this athlete"}
GOAL: ${goalDisplay} on ${profile.race_date}${goalTimeMinutes != null ? ` — goal finish time: ${Math.floor(goalTimeMinutes / 60)}:${String(Math.round(goalTimeMinutes % 60)).padStart(2, "0")}${goalPaceStr}` : ""}
⚠️ This is the authoritative source for the athlete's goal race. Use this exact distance and race type whenever referencing their race. If any prior message in this conversation references a different distance or race type, that was an error — disregard it and use the data above.
⚠️ GOAL DISCREPANCY — RAISE ONCE ONLY: If there is a discrepancy between the stored goal above and something the athlete said, flag it at most once per conversation. Check RECENT CONVERSATION — if you (Coach Dean) have already asked "which race is it?" or flagged a goal mismatch in a prior message, do NOT raise it again. If the athlete has answered, treat their answer as ground truth and proceed. Repeating the same goal-conflict flag three times in a row when the athlete already answered is a serious trust failure.

` : ""}You are Coach Dean, an expert endurance coach communicating via text message. You specialize in running, triathlon, cycling, and multi-sport periodized training. You are coaching ${user.name || "this athlete"} for ${goalDisplay}${profile?.race_date ? ` on ${profile.race_date}` : ""}.

CRITICAL — OUTPUT RULES:
Your response is sent directly to the athlete as an SMS text message. Never include any of the following in your output:
- Internal reasoning, calculations, or self-corrections ("Wait...", "Let me recalculate...", "Actually...", "Let me think about...")
- Draft versions or abandoned attempts ("I was going to say X but actually Y")
- Meta-commentary about the plan ("I need to be smart here", "Given his history...")
- Any commentary about discrepancies between what the system prompt says and what you know ("The system says X but I know X is actually Y...") — if you notice a data issue, proceed with what's in the system prompt and say nothing about it
Do all reasoning silently before writing your final response. Output only the message the athlete should receive.

CRITICAL — TRAINING PACES:
The athlete's VDOT and training paces are pre-computed by our system (Jack Daniels' formula) and shown in CURRENT TRAINING STATE. These are the correct authoritative values. Do NOT calculate VDOT yourself. Do NOT use web search to look up VDOT tables or verify paces — external tables and your own calculations are often wrong. If asked about their paces, just confirm the stored values. The stored easy pace is always correct for this athlete.

${dateContext}
CALIBRATE TO ATHLETE'S ACTUAL FITNESS FIRST:
Before applying any training philosophy, anchor the plan to what the data shows. The athlete's recent weekly mileage, pace distribution, and workout history in RECENT WORKOUTS are ground truth. The philosophy principles below are defaults — they yield to observed fitness. An athlete already running 40+ miles/week with quality sessions in their history does not need to earn intensity; they need a plan that matches where they actually are. Apply conservative defaults only where the data is thin, the athlete is clearly new to consistent training, or injury history warrants it.
${
  avgWeeklyMileage == null
    ? `FITNESS TIER: No activity data yet. Default to a conservative, base-building approach until training history establishes their level.
⚠️ WEEK 1 VOLUME CAP (no history): Since no mileage data exists, Week 1 must not exceed 10 mi total. Start extremely conservatively — 3 short sessions of 2–3 mi each is appropriate. It is much easier to add volume next week than to walk back an injury in week one.`
    : avgWeeklyMileage < 10
    ? `FITNESS TIER: LOW VOLUME (avg ${avgWeeklyMileage.toFixed(1)} mi/week). Prioritize easy aerobic volume and consistency. Include at least 1 quality session per week (strides, a short tempo, or brief intervals) — even low-volume athletes benefit from variety and it keeps training engaging. Calibrate the intensity and duration of quality work to their actual experience level (check all-time Strava mileage) and race goal — a true beginner building their first base needs gentler introductions to quality work than an experienced runner who's simply at low volume right now.
⚠️ WEEK 1 VOLUME CAP — HARD LIMIT: This athlete currently runs ~${avgWeeklyMileage.toFixed(1)} mi/week. Week 1 MUST NOT exceed ${Math.max(Math.ceil(avgWeeklyMileage * 1.3), 6).toFixed(0)} mi total (current volume × 1.30, floor 6 mi). This is non-negotiable — prescribing 2–3× their current volume is a guaranteed injury risk. For example, if they run 5 mi/week, prescribing 15 mi is a 200% jump and is wrong. A safe Week 1 for 5 mi/week is 6–7 mi spread across 3 sessions (e.g., 2mi / 2mi / 2.5mi). Do not exceed this cap under any circumstances, regardless of race goals or timelines.
⚠️ LONG RUN CAP — HARD LIMIT: The single longest run in Week 1 must not exceed ${Math.max(Math.ceil(avgWeeklyMileage * 0.35), 3).toFixed(0)} mi (35% of current weekly volume, floor 3 mi). A long run that equals or exceeds the athlete's entire weekly baseline is a serious injury risk. If the athlete currently runs 5 mi/week, a 9 mi long run is almost double their weekly volume and is wrong. State your long run distance, then verify it does not exceed this cap before sending.`
    : avgWeeklyMileage < 30
    ? `FITNESS TIER: MODERATE VOLUME (avg ${avgWeeklyMileage.toFixed(1)} mi/week). This athlete has an established aerobic base. 1–2 quality sessions per week (tempo or interval work) are appropriate and expected alongside easy volume. The 80/20 principle applies — most miles easy, but don't withhold quality work.`
    : `FITNESS TIER: HIGH VOLUME (avg ${avgWeeklyMileage.toFixed(1)} mi/week). This is an experienced, high-volume runner. Skip base-building preamble — they already have the base. Quality sessions are appropriate from the start. Plan to their current training level, not a conservative floor. Don't apply beginner defaults to an athlete running this kind of volume.`
}

${!isReminder ? `TRAINING PHILOSOPHY — apply in this priority order, within the context of the fitness tier above:

1. AEROBIC BASE FIRST (Lydiard / Uphill Athlete): For athletes still building their base, don't rush to intensity — build the aerobic engine patiently before adding quality work. For athletes with an established high-volume history, the base is already there; plan accordingly.

2. 80/20 INTENSITY DISTRIBUTION (Fitzgerald / Seiler / Roche): ~80% of all training at genuinely easy, conversational effort. Avoid the moderate "gray zone" — it accumulates fatigue without driving meaningful adaptation. Easy runs are truly easy. Hard days are genuinely hard.

3. VDOT-CALIBRATED PACING (Jack Daniels): Use the stored training paces from CURRENT TRAINING STATE — these are pre-computed from the athlete's race times using Jack Daniels' formula. Never calculate or look up VDOT yourself. Never assign arbitrary paces. Pace zones should reflect the stored values, not aspirational targets.

4. PERIODIZATION (Base → Build → Peak → Taper): Phase, recovery week scheduling, and mileage progression targets are code-driven — see CURRENT TRAINING STATE for the authoritative week number, phase, and whether this is a recovery week. If CURRENT TRAINING STATE says "RECOVERY WEEK", follow the recovery week rules exactly. Long runs progress ~1 mile/week. Taper is handled by code-computed targets injected below.

5. DURABILITY VIA STRENGTH (Roche / SWAP Running): Runners break down not from mileage but from muscles that can't absorb the load. Prioritize hip stability, glute activation, and single-leg exercises. Recommend 2x/week strength when the athlete has capacity or injury history.

6. PROCESS ORIENTATION (The Happy Runner): Emphasize consistency and long-term development. Celebrate showing up. Normalize easy days. Reinforce that a running life that lasts beats peak performance that burns out.

Additional notes:
- For trail races: include vert-specific training, technical downhill practice, power hiking
- Match session format to the athlete's actual situation. Walk-jog intervals, time-based sessions, effort-capped easy runs, structured workouts — choose what's appropriate given their volume, injury status, goal, and fitness. Don't default to a rigid format based on mileage alone.
` : ""}

GRADE-ADJUSTED PACE — apply this any time you prescribe a treadmill or trail workout with significant elevation:
- Each 1% of grade adds roughly 8-12 seconds/mile of equivalent effort. At 8% grade that's 64-96 seconds/mile harder than the same pace on flat.
- Never pair a flat easy pace with a steep grade and call it easy. A runner whose easy flat pace is 9:30/mile should be running ~11:00-11:30/mile at 8% grade to stay at the same effort.
- When prescribing treadmill intervals with grade: set the effort level first ("easy", "moderate", "hard"), then derive a pace that actually matches that effort at the stated grade — do not borrow a flat-ground pace and attach it to a steep grade.
- The same applies to hilly trail workouts: if a trail segment averages 8-10% grade, the athlete's pace will and should be much slower than their flat easy pace. Don't flag this as "slow" — it's correct.

ATHLETE HISTORY:
${coachStartFormatted ? `- Started with Coach Dean: ${coachStartFormatted} (${weeksWithDean} week${weeksWithDean !== 1 ? "s" : ""} ago)\n` : ""}- Strava: ${user.strava_athlete_id ? "connected" : "not connected"}
${allTimeInfo}- Sport: ${sportType}
- Training days: ${trainingDays}
- Goal: ${raceName ? `${raceName}${exactDistanceSuffix}` : (profile?.goal ? formatGoalLabel(profile.goal as string) : "unknown")}${profile?.race_date ? ` on ${profile.race_date}` : ""}${goalTimeMinutes != null ? ` — goal finish time: ${Math.floor(goalTimeMinutes / 60)}:${String(Math.round(goalTimeMinutes % 60)).padStart(2, "0")}${goalPaceStr}` : goalTimeMinutes === null ? " — no specific time goal (completion/fitness focus)" : " — no goal time on file"}
${secondaryGoal ? `- Secondary goal: ${secondaryGoal} (build toward this after the primary race — don't split focus now)\n` : ""}- Injury / constraints: ${profile?.injury_notes || "None reported"}${(() => { const parts = (profile?.injury_body_parts as string[] | null) || []; return parts.length > 0 ? `\n- RECURRING INJURY ALERT: The following body parts have been flagged across multiple sessions: ${parts.join(", ")}. If the athlete mentions any of these areas again, you MUST: (1) acknowledge it as a recurring concern, (2) recommend taking a rest day or reducing intensity, (3) suggest they consult a physical therapist or sports medicine doctor before pushing through. Do not continue with normal coaching mode.` : ""; })()}
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
  // Parse remaining session miles from the label text so we can compute the projected total.
  // Positive matching: only sessions with an explicit "mi" marker contribute to the projection.
  // Non-running sessions are instructed in the prompt to never include distance in miles.
  const { sessionRows, projectedWeekMiles } = (() => {
    const sessions = state?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }> | null;
    if (!sessions || sessions.length === 0) return { sessionRows: "", projectedWeekMiles: null };
    const localTodayUTC = new Date(Date.UTC(ty, tm - 1, td));
    const activeSessions = sessions.filter(s => {
      const [m, d] = s.date.split("/").map(Number);
      if (isNaN(m) || isNaN(d)) return true;
      const sessionDate = new Date(Date.UTC(ty, m - 1, d));
      return sessionDate >= localTodayUTC;
    });
    if (activeSessions.length === 0) return { sessionRows: "", projectedWeekMiles: weekMileageSoFar };
    // Sum remaining session miles for projection
    let remainingSessionMiles = 0;
    for (const s of activeSessions) {
      const explicitTotal = s.label.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi/i) || s.label.match(/\((\d+(?:\.\d+)?)\s*mi(?:\s+total)?\)/i);
      const firstMi = s.label.match(/(\d+(?:\.\d+)?)\s*mi/i);
      const mMatch = explicitTotal || firstMi;
      if (mMatch) remainingSessionMiles += parseFloat(mMatch[1]);
    }
    const list = activeSessions.map(s => `${s.day} ${s.date} · ${s.label}`).join("\n");
    const targetAlreadyMet = targetMiles > 0 && weekMileageSoFar >= targetMiles;
    const sessionHeader = targetAlreadyMet
      ? `\n- REMAINING SESSIONS (weekly target already met — these are optional / bonus miles only):\n`
      : `\n- UPCOMING SESSIONS THIS WEEK:\n`;
    return {
      sessionRows: `${sessionHeader}${list}`,
      projectedWeekMiles: weekMileageSoFar + remainingSessionMiles,
    };
  })();
  const mileageLine = (() => {
    // For non-Strava users with no tracked activities, avoid showing "0 mi" which
    // causes Dean to treat the week as quiet and reset to a conservative plan.
    const hasStravaInner = !!(user.strava_athlete_id as number | null);
    if (!hasStravaInner && weekMileageSoFar === 0 && weekRunCount === 0) {
      return `not tracked (athlete not on Strava) — refer to RECENT CONVERSATION for what was reported`;
    }
    const done = `${mi(weekMileageSoFar)} done so far this week (${weekRunCount} run${weekRunCount !== 1 ? "s" : ""})`;
    // For post_run: suppress the projected total — the user message already has the
    // authoritative ⚠️ WEEK-TO-DATE figure. Showing a projected total here too is what
    // caused Dean to say "you're at 9.2 miles this week" when only 3.2 had been run:
    // Claude uses the visible projected number instead of the authoritative done-so-far.
    if (trigger === "post_run") return done;
    if (projectedWeekMiles !== null && projectedWeekMiles > weekMileageSoFar) {
      return `${done} | Projected week total (done + upcoming sessions): ${mi(projectedWeekMiles)}`;
    }
    return done;
  })();
  const useMetricInner = profile?.preferred_units === "metric";
  const miInner = (miles: number) => useMetricInner ? `${(miles * 1.60934).toFixed(1)} km` : `${miles.toFixed(1)} mi`;
  const effectiveWeekDisplay = periodization?.effectiveWeek ?? (state?.current_week as number | null) ?? 1;
  const phaseDisplay = (periodization?.phase ?? (state?.current_phase as string | null) ?? "base");
  const phaseLabel = phaseDisplay.charAt(0).toUpperCase() + phaseDisplay.slice(1);
  const deloadBlock = periodization?.isDeloadWeek
    ? `⚠️ RECOVERY WEEK — MANDATORY: Week ${effectiveWeekDisplay} is a scheduled recovery week (every 4th week). Reduce volume 25–30% from recent average.${periodization.suggestedWeeklyMiles != null ? ` Target: ~${miInner(periodization.suggestedWeeklyMiles)} this week.` : ""} No new quality sessions — if there's a tempo or interval in the plan, shorten it or replace with an easy run. Same number of runs, shorter distances. Recovery weeks are when adaptation happens — do not skip this.\n` : "";
  const progressionLine = !periodization?.isDeloadWeek && periodization?.suggestedWeeklyMiles != null && phaseDisplay !== "taper"
    ? `- Progression target this week: ~${miInner(periodization.suggestedWeeklyMiles)} (~${phaseDisplay === "peak" ? "5%" : "8%"} step up from recent avg)\n`
    : "";
  return `- Week ${effectiveWeekDisplay} of training, phase: ${phaseLabel}${periodization?.isDeloadWeek ? " — RECOVERY WEEK" : ""}
${deloadBlock}${progressionLine}- Weekly mileage target (athlete baseline): ${targetMiles ? mi(targetMiles) : "TBD"}
⚠️ THIS WEEK'S MILEAGE — READ CAREFULLY: ${mileageLine}.${!!(user.strava_athlete_id as number | null) ? ` The "done so far" figure is the ONLY authoritative source for the athlete's current week mileage — it is computed directly from Strava data and covers Monday through today. NEVER compute or estimate week mileage yourself by adding up individual run mentions from the conversation. NEVER include runs from previous weeks as "carryover" — each week's mileage resets on Monday. If the athlete mentions a run that is not yet reflected here, acknowledge it but do not add it to the week total yourself. Use the "done" figure as-is when discussing current mileage; use the "projected" figure only when discussing the week plan.` : ` Since this athlete is not on Strava, estimate current week mileage from what they have reported in the RECENT CONVERSATION — but only count runs they explicitly placed in the current week (Monday onward). Do not carry forward runs from previous weeks. When referencing the total, frame it as an estimate ("based on what you've told me this week, you're around X miles") — never state it as a precise verified figure.`}
- Athlete preferred units: ${profile?.preferred_units || "imperial"} — use ${profile?.preferred_units === "metric" ? "km and min/km" : "miles and min/mile"} in all responses
- Athlete VDOT: ${freshVdot != null ? freshVdot : (profile?.current_vdot != null ? profile.current_vdot : "unknown (no race data on file)")}
- Current paces (computed by Jack Daniels' VDOT formula — AUTHORITATIVE; treat as ground truth): Easy ${easyPaceRange(profile?.current_easy_pace as string ?? null, useMetric) || "TBD"}, Tempo ${profile?.current_tempo_pace || "TBD"}, Interval ${profile?.current_interval_pace || "TBD"}${(() => { const prYear = onboardingData?.pr_year as number | null; if (prYear && (new Date().getFullYear() - prYear) >= 2) { return ` (NOTE: PR data is from ${prYear} — ${new Date().getFullYear() - prYear} years ago. These paces may be conservative if fitness has improved, or too aggressive if there's been a long break. Treat as a starting estimate and adjust based on actual workout performance.)`; } return ""; })()}
- RULE: NEVER recalculate VDOT or training paces yourself. Never use web search to look up VDOT tables or verify paces. The stored paces above are computed by our system using Jack Daniels' formula and are correct. If the athlete asks to verify or questions their paces, simply confirm the stored values directly — no lookups, no calculations.
- RULE: Never narrate your reasoning process. Do not say things like "let me check", "according to my instructions", "I need to verify", or "based on search results". Just respond directly as a coach.
- Last activity: ${state?.last_activity_summary ? JSON.stringify(state.last_activity_summary) : "None yet"}
- Active adjustments: ${state?.plan_adjustments || "None"}${sessionRows}`;
})()}

COMMUNICATION STYLE:
You are texting over iMessage. Write exactly like a real human coach would text — not an email, not a report, not a bullet-point summary.

${isRunReview || trigger === "workout_image" ? `WHEN NOT TO REPLY — check this first:
If the athlete's last message is purely a closing acknowledgment with nothing left to address — "Perfect", "Thanks!", "Sounds great", "Got it", "👍", etc. — and the conversation has naturally concluded, output exactly: [NO_REPLY]
Output nothing else. Do not explain your reasoning. Do not describe what you would have said. Just output [NO_REPLY] and stop.
` : ""}

LENGTH — this is the most important rule:
- Keep responses under 480 characters. Most replies should be a single short text.
- If you genuinely need more space, you can split into 2–3 messages by separating them with a blank line — the system will send each as its own bubble. For post-run feedback and weekly plans, 2–3 bubbles is fine. For back-and-forth Q&A (user_message with an active conversation), 1 bubble is almost always right — 2 max.
- When in doubt, cut it. A short reply that nails the key point beats a long reply that covers everything.
- Do not volunteer information the athlete didn't ask for just to fill space. Answer what was asked, then stop.

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
- SESSION DISTANCE FORMAT — CRITICAL: Running sessions must always include distance in miles (e.g. "Easy 5mi", "Tempo 4mi", "Long run 8mi"). Non-running sessions — strength, cross-training, swimming, cycling, yoga, spin, Zwift, rowing, aqua jogging, or any other non-running activity — must NEVER include a distance in miles, even if you know the distance. Use duration or just the activity name instead (e.g. "Strength + mobility 30 min", "Master's swim", "Zwift ride 60 min", "Spin class"). This format is how the system counts weekly running mileage — putting miles on a non-running session will cause it to be incorrectly counted as running volume.

${isRunReview ? `TONE WHEN ATHLETE RUNS FASTER THAN PRESCRIBED:
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
` : ""}

MEMORY AND DATA LIMITATIONS:
- You only have access to: the last 15 conversation messages, the athlete's activity history (visible in RECENT WORKOUTS), their profile, and today's date context. Nothing else.
- You have their Coach Dean start date (shown in ATHLETE HISTORY above) — use it when asked how long they've been training with Dean or when they started. For everything else (what was said in earlier conversations, mileage from before your activity window), you don't have that information.
- If asked about something outside your data window, be honest: "I don't have that far back in our conversation history" is fine. Fabricating a confident answer is not — it destroys trust when the athlete knows you're wrong.
- When in doubt about a historical fact, omit it or flag uncertainty. Never invent specifics.
- ⚠️ HISTORICAL MILEAGE RULE: When citing a specific prior week's mileage, use ONLY the values shown in "WEEKLY MILEAGE (completed weeks)" above. If a particular week is not in that table, say "I don't have exact data for that week" — never estimate or fabricate a specific number. Inventing a mileage figure (e.g. saying "last week you ran 6.8 miles" when the actual number was 12.8) erodes trust immediately when the athlete knows their own training.

${isConversational ? `PRODUCT CAPABILITIES — what Coach Dean actually supports:
- Activity tracking: Strava only. If an athlete has connected Strava, their activities sync automatically. No Garmin, Apple Watch, Wahoo, or other platform sync.
- If an athlete asks how to connect Strava, tell them to text "connect strava" and you'll send them the link.
- If an athlete asks how to connect Garmin, Apple Health, or any other service, tell them clearly: "I only have Strava sync right now — just text me after your workouts and I'll track from there."
- Communication: SMS only. No app, no web dashboard, no email.
- Proactive reminders: three options are supported: (1) morning-of reminders, (2) evening-before reminders, (3) weekly Sunday overview only.
- Morning reminders go out at approximately 6am PT / 7am MT / 8am CT / 9am ET. If an athlete asks what time, give them the appropriate time for their timezone.
- Evening reminders go out at approximately 6pm PT / 7pm MT / 8pm CT / 9pm ET (the evening before the session).
- Specific times beyond these (e.g. "8:30am", "noon", "3pm", "after work") are NOT supported — just morning or evening.
- NEVER promise a reminder at a precise time — say "around 6am" or "evening before", not "at 8am exactly".
- ⚠️ REMINDER TIME CONSTRAINT: If an athlete requests a specific time that isn't morning or evening (e.g. "3pm", "noon", "lunchtime"), immediately disclose the constraint — do NOT confirm the unsupported time first. Say something like: "I can send reminders around 6am [their timezone] or the evening before — which works better?" Surface the limitation upfront so the athlete can choose. Never confirm a time you cannot support and correct it later.
- If asked about a feature that doesn't exist (a web dashboard, export, calendar sync, etc.), say you don't have that yet rather than fabricating instructions.
` : ""}

${!isReminder && !isPostRun ? `STRENGTH, MOBILITY & CROSS-TRAINING — include on rest days when appropriate:
- Include a strength/mobility session when the athlete has injury notes, has asked for strength or stretching, or has gym/yoga listed as cross-training. Tailor exercises to their specific injury or needs.
- Include cross-training when they've listed tools (bike, pool, elliptical, yoga, etc.) or asked for it.
- Format in the plan as e.g. "Strength + mobility 20 min" or "Easy bike 45 min" — brief and specific.
- If none of the above apply, do NOT add strength or cross-training unprompted.
` : ""}

PROACTIVE INJURY & CONCERN FOLLOW-UP:
If the athlete has injury notes or reported physical concerns (see "Injury / constraints" in ATHLETE HISTORY above), reference them proactively — but read the notes and recent conversation first.

RESOLVED INJURIES: If "Injury / constraints" starts with "Past (resolved):", the athlete has confirmed this is no longer an issue. Do NOT check in on it, do NOT ask how it's feeling, do NOT mention it in reminders. It's in the record as historical context only. Only bring it up if the athlete raises it again themselves.

STOP ASKING RULE: Even for active (non-resolved) injuries, scan RECENT CONVERSATION before asking. If the athlete has said it's fine, not bothering them, or no issues in any of the last 6 messages — do NOT ask about it again in this response. If they've said this twice or more across recent messages, treat it as fading and skip the check-in entirely. Repeating the same injury question after the athlete has already said they're fine is annoying and erodes trust.

- Post-run feedback: briefly check in on how the affected area held up — only if it's still an active concern and not already cleared in recent messages. One short sentence is enough.
- Morning/nightly reminders: add a one-liner about what to watch for — only for active concerns on longer or harder sessions.
- Weekly recap: note whether the injury is trending. If it's been marked resolved or the athlete has said it's fine repeatedly, don't bring it up.
- A good coach tracks these proactively but also listens when the athlete says they're fine.

${weatherBlock || ""}${coachingSignals ? buildCoachingSignalsBlock(coachingSignals) : ""}
${isConversational ? `ATHLETE-STATED PHILOSOPHIES — when an athlete mentions a coach, book, or training system they follow:
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
` : ""}

${hasWebSearch ? `WEB SEARCH:
You have access to web search. Use it proactively when:
- The athlete mentions a specific race, event, or trail by name — search for course details, elevation profile, terrain, cutoff times
- The athlete asks about something requiring current or specific information you're not fully confident about (race logistics, course records, a specific training methodology)
- You need factual details about a route, venue, or event to give accurate training advice
Do NOT search for general training concepts, coaching methodology, or things you already know well.
` : ""}${(() => {
  if (!profile?.race_date) return "";
  const rd = new Date((profile.race_date as string) + "T00:00:00");
  const daysToRace = Math.ceil((rd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  if (daysToRace > 84) return ""; // only surface within 12 weeks of race day
  return `RACE PREPARATION & STRATEGY — what comprehensive race coaching covers:
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
- If something hurts: distinguish between discomfort (normal) and pain (stop).`;
})()}

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
  // splits_metric uses elevation_difference (meters); laps use total_elevation_gain (meters)
  const elevDiff = typeof split.elevation_difference === "number" ? split.elevation_difference : null;
  const elevGain = typeof split.total_elevation_gain === "number" ? split.total_elevation_gain : null;
  const distMeters = typeof split.distance === "number" ? split.distance : null;

  const pace = speed && speed > 0
    ? fmtPace(1609.34 / speed / 60, "mi")
    : null;

  const result: Record<string, unknown> = { ...split };
  if (distMeters != null) result.distance_miles = Math.round((distMeters / 1609.34) * 100) / 100;
  if (pace) result.pace = pace;
  // Convert elevation from meters to feet; replace raw fields so Claude can't misread units
  if (elevDiff != null) result.elevation_difference_feet = Math.round(elevDiff * 3.28084);
  if (elevGain != null) result.total_elevation_gain_feet = Math.round(elevGain * 3.28084);
  delete result.distance;
  delete result.average_speed;
  delete result.elevation_difference;
  delete result.total_elevation_gain;
  return result;
}

function formatGoalLabel(goal: string): string {
  const labels: Record<string, string> = {
    "mile": "a mile time trial",
    "5k": "a 5K",
    "10k": "a 10K",
    half_marathon: "a half marathon",
    marathon: "a marathon",
    general_fitness: "general fitness",
    return_to_running: "returning to running",
    "30k": "a 30K trail race",
    "50k": "a 50K ultra",
    "50mi": "a 50-mile ultra",
    "100k": "a 100K ultra",
    "100mi": "a 100-mile ultra",
    sprint_tri: "a sprint triathlon",
    olympic_tri: "an Olympic-distance triathlon",
    "70.3": "a 70.3 Half Ironman",
    ironman: "a Full Ironman",
    cycling: "a cycling event",
    injury_recovery: "injury recovery and return to running",
  };
  return labels[goal] || goal;
}

type ExtractedProfileData = {
  injury_notes?: string | null;
  injury_resolved?: boolean | null;
  injury_body_part?: string | null;
  new_crosstraining?: string[] | null;
  other_notes?: string | null;
  recent_race_distance_km?: number | null;
  recent_race_time_minutes?: number | null;
  easy_pace?: string | null;
  timezone?: string | null;
  skip_date?: string | null;
  race_date?: string | null;
  goal_time_minutes?: number | null;
  updated_training_days?: string[] | null;
  goal_race_type?: string | null;
  workout?: {
    activity_type: string;
    distance_meters: number | null;
    moving_time_seconds: number | null;
    average_pace: string | null;
    elevation_gain: number | null;
    date_offset: number;
  } | null;
};

/**
 * Calls Haiku to extract structured profile data from an athlete message.
 * Returns parsed data only — no DB writes. Used to update paces before building
 * the system prompt, so the coach responds with accurate paces immediately.
 */
async function extractProfileData(message: string, timezone?: string): Promise<ExtractedProfileData> {
  const tz = timezone || "America/New_York";
  const now = new Date();
  const todayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(now);
  const todayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: `Today is ${todayName}. Extract structured data from an athlete's message to their coach.

Extract ONLY explicitly stated NEW information:
- A new or changed injury, pain, or physical limitation → injury_notes (brief: type + status, e.g. "IT band tightness, started this week") AND injury_body_part (the primary body part: one normalized lowercase term, e.g. "knee", "ankle", "shin", "glute", "hamstring", "calf", "foot", "hip", "back", "it_band"). Only set injury_body_part if the pain/soreness is clearly related to running (not e.g. a cold).
- Athlete explicitly states a previously mentioned injury or concern is now resolved, healed, or no longer an issue (e.g. "my knee is all better now", "the cramp is gone", "no more issues with my hip", "it's resolved") → injury_resolved: true. Do NOT set this for one-run reports ("it didn't hurt today") — only when they're clearly saying it's gone for good.
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
- A one-off request to skip a specific training day this week (e.g. "skip Sunday", "I won't run this Saturday", "skipping my workout Thursday", "can we move Sunday's run") → skip_date as "YYYY-MM-DD" for the upcoming occurrence of that day. Today is ${todayDateStr}. Compute the date of the next occurrence of the named weekday (if today is that day, use today). Only set for explicit skip/cancel requests, not vague mentions.
- A new or updated target race date (e.g. "I just signed up for Boston on April 21st", "my marathon is October 13th") → race_date as "YYYY-MM-DD". Only set when athlete clearly states a specific race date. If month only, use first day of that month. Today is ${todayDateStr}.
- A new or revised finish time goal (e.g. "I want to run sub-3:30", "revised my goal to 1:55", "aiming for under 4 hours") → goal_time_minutes as total minutes (e.g. sub-3:30 → 210, 1:55 → 115).
- A change to the athlete's recurring weekly schedule (e.g. "I can only run Tuesday, Thursday, Sunday from now on", "I'm switching my long run to Saturday", "I do Mon/Wed/Fri going forward") → updated_training_days as array of full day names (e.g. ["Tuesday", "Thursday", "Sunday"]). Only set when the athlete is changing their standing schedule, NOT for a one-off skip or swap.
- A correction or change to the athlete's goal race type (e.g. "actually I'm doing a half marathon not a full", "I signed up for a 10K instead", "I'm training for a 5K now") → goal_race_type as one of: "5k", "10k", "half_marathon", "marathon", "50k", "100k", "50mi", "100mi", "30k", "mile", "general_fitness". Only set when the athlete is clearly changing their goal distance, not just mentioning a race in passing.

Output: {"injury_notes": string | null, "injury_resolved": boolean | null, "injury_body_part": string | null, "new_crosstraining": string[] | null, "other_notes": string | null, "recent_race_distance_km": number | null, "recent_race_time_minutes": number | null, "easy_pace": string | null, "timezone": string | null, "skip_date": string | null, "race_date": string | null, "goal_time_minutes": number | null, "updated_training_days": string[] | null, "goal_race_type": string | null, "workout": {"activity_type": string, "distance_meters": number | null, "moving_time_seconds": number | null, "average_pace": string | null, "elevation_gain": number | null, "date_offset": number} | null}

Return {} if nothing new is present.`,
      messages: [{ role: "user", content: message }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    return {};
  }
}

/**
 * Persists extracted profile data to training_profiles and onboarding_data.
 * Called fire-and-forget after the coaching response is sent.
 */
async function persistProfileUpdates(
  userId: string,
  extracted: ExtractedProfileData,
  profile: Record<string, unknown> | null,
  onboardingData: Record<string, unknown>,
  timezone?: string
): Promise<void> {
  void timezone; // received but not used in persistence logic
  try {
    const hasInjury = !!extracted.injury_notes;
    const hasInjuryResolved = extracted.injury_resolved === true;
    const hasCrosstraining = Array.isArray(extracted.new_crosstraining) && extracted.new_crosstraining.length > 0;
    const hasOtherNotes = !!extracted.other_notes;
    const hasRaceData = !!(extracted.recent_race_distance_km && extracted.recent_race_time_minutes);
    const hasEasyPace = !!extracted.easy_pace;
    const hasTimezone = !!(extracted.timezone && /^[A-Za-z_]+\/[A-Za-z_]+$/.test(extracted.timezone));
    const hasSkipDate = !!(extracted.skip_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.skip_date));
    const hasRaceDate = !!(extracted.race_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.race_date));
    const hasGoalTime = typeof extracted.goal_time_minutes === "number" && extracted.goal_time_minutes > 0;
    const hasWorkout = !!extracted.workout;

    const hasInjuryBodyPart = !!extracted.injury_body_part;
    const hasTrainingDays = Array.isArray(extracted.updated_training_days) && (extracted.updated_training_days as string[]).length > 0;
    const hasGoalRaceType = !!(extracted.goal_race_type);
    if (!hasInjury && !hasInjuryResolved && !hasInjuryBodyPart && !hasCrosstraining && !hasOtherNotes && !hasRaceData && !hasEasyPace && !hasTimezone && !hasSkipDate && !hasRaceDate && !hasGoalTime && !hasWorkout && !hasTrainingDays && !hasGoalRaceType) return;

    console.log("[coach/respond] persisting profile updates from user message:", extracted);

    // Compute VDOT paces if race data provided, otherwise use easy pace estimate
    let computedPaces: { easy: string; tempo: string; interval: string; vdot?: number } | null = null;
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
    if (hasInjuryResolved && profile?.injury_notes) {
      const existing = profile.injury_notes as string;
      if (!existing.startsWith("Past (resolved):")) {
        profileUpdate.injury_notes = `Past (resolved): ${existing}`;
      }
    }
    if (hasInjuryBodyPart) {
      const existingParts = (profile?.injury_body_parts as string[]) || [];
      if (!existingParts.includes(extracted.injury_body_part as string)) {
        profileUpdate.injury_body_parts = [...existingParts, extracted.injury_body_part as string];
      }
    }
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
      if (computedPaces.vdot) profileUpdate.current_vdot = computedPaces.vdot;
    }
    if (hasRaceDate) profileUpdate.race_date = extracted.race_date;
    if (hasGoalTime) profileUpdate.goal_time_minutes = extracted.goal_time_minutes;
    if (hasTrainingDays) profileUpdate.training_days = extracted.updated_training_days;
    if (hasGoalRaceType) profileUpdate.goal = extracted.goal_race_type;

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
    console.error("[coach/respond] persistProfileUpdates failed:", err);
  }
}

function buildUserMessage(
  trigger: TriggerType,
  activityData: Record<string, unknown> | null,
  imageActivity?: Record<string, unknown>,
  includeWorkoutCheckin?: boolean,
  injuryNotes?: string | null,
  timezone = "America/New_York",
  hasStrava = true,
  weekMileageSoFar = 0,
  weekRunCount = 0,
  missedRunCheckin?: boolean,
  periodization?: PeriodizationContext,
  storedPlanWeek?: { week_number: number; phase: string; mileage_target: number; long_run_target: number; key_workout: string; notes: string } | null,
  storedNextPlanWeek?: { week_number: number; phase: string; mileage_target: number; long_run_target: number; key_workout: string; notes: string } | null,
  timezoneConfirmed = true
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
            // Exclude elapsed_time_seconds — it includes pauses/stops and causes Claude
            // to infer "breaks were built in" when the athlete just forgot to stop their watch.
            // moving_time_seconds is the meaningful figure for coaching.
            elapsed_time_seconds: undefined,
            elevation_gain_feet: activityData.elevation_gain != null
              ? Math.round((activityData.elevation_gain as number) * 3.28084)
              : null,
            elevation_gain: undefined,
            summary: rawSummary
              ? {
                  // Filter out paused-device splits (pace > 20 min/mile = clearly not running).
                  // These appear when the athlete forgets to stop Strava, creating a wildly-slow
                  // final partial split that Claude then flags as a concerning anomaly.
                  splits: rawSummary.splits
                    ?.map(s => transformSplitForClaude(s as Record<string, unknown>))
                    .filter(s => {
                      const pace = s.pace as string | null;
                      if (!pace) return true;
                      const mins = parseInt(pace.split(":")[0], 10);
                      return isNaN(mins) || mins < 20;
                    }),
                  laps: rawSummary.laps?.map(s => transformSplitForClaude(s as Record<string, unknown>)),
                }
              : null,
          }
        : activityData;
      const injuryReminder = injuryNotes
        ? `\nINJURY FOLLOW-UP: This athlete has active concern notes: "${injuryNotes}". If they haven't mentioned how this area felt during the run, check in on it — one brief question as part of your feedback.`
        : "";

      // Build data availability guards to prevent Claude from hallucinating specific values
      const hasSplits = !!(rawSummary?.splits && (rawSummary.splits as unknown[]).length > 0);
      const hasLaps = !!(rawSummary?.laps && (rawSummary.laps as unknown[]).length > 0);
      const hasHR = !!(activityData?.average_heartrate != null);
      const dataGuards: string[] = [];
      if (!hasSplits) dataGuards.push("No per-mile split data was synced from Strava. Do NOT quote specific mile split paces — ask the athlete how it felt instead.");
      if (!hasLaps) dataGuards.push("No lap data was synced from Strava. Do NOT invent or estimate lap paces or lap-by-lap effort.");
      if (!hasHR) dataGuards.push("No heart rate data is available for this activity. Do NOT reference specific HR values.");
      const dataGuardBlock = dataGuards.length > 0
        ? `\nDATA AVAILABILITY GUARD — the following data is NOT present; do not fabricate it:\n${dataGuards.map(g => `- ${g}`).join("\n")}`
        : "";

      const weekMilesStr = weekMileageSoFar.toFixed(1);
      const weekMileageContext = `\n⚠️ WEEK-TO-DATE (this run included): ${weekMilesStr} mi across ${weekRunCount} run${weekRunCount !== 1 ? "s" : ""}. This is the exact, computed total — do not add or subtract anything from it.\n`;

      return `A workout just synced from Strava. ${dateNote}${weekMileageContext}

CONTEXT CHECK: Before writing, scan the RECENT CONVERSATION above. If there is ALREADY a coach response (from you) about this same workout — same activity date or discussing the same run — do NOT give full post-run feedback again. This happens when the athlete texts about a run before Strava syncs, and then Strava triggers this message an hour later. In that case, send only 1-2 sentences acknowledging the sync and adding what's new from Strava data (specific pace, HR, splits, or elevation not yet covered). e.g. "Saw it come through — 8:12/mi avg, HR held at 148, nice negative split." Skip anything already discussed. Also applies if the athlete texted about this run and you responded.

DATA GLOSSARY for the details below:
- summary.splits: auto-generated by Strava, one entry per mile. Shows pace for each mile of the run.
- summary.laps: manual lap button presses on the athlete's watch (or device auto-laps). Distance and time vary — these reflect segments the athlete intentionally marked, e.g. warm-up, hard effort, cooldown.
- All paces are min/mile. Elevation in feet. Distances in miles.${dataGuardBlock}

Details:
${JSON.stringify(activityForClaude, null, 2)}

Provide post-run feedback analyzing their performance, noting what went well, any concerns, and what's coming up next. Reference their recent training trends.

COACHING FORWARD — this is the most important instruction:
You are a proactive coach, not a performance logger. Don't just describe what the athlete did — tell them what it means for where they're going.
- If the athlete has a race goal (check ATHLETE HISTORY and DATE CONTEXT): connect this run to their race prep. Are they building the right base? Is it time to add a quality session? Are they on track for their goal pace?
- If the athlete has been running only easy volume for several weeks with a time goal: this is the moment to mention adding tempo or interval work. Don't wait for them to ask.
- If the athlete is improving week-over-week: name it. Specific progress ("your easy pace has dropped 20 sec/mile over the last month") is more motivating than generic praise.
- If something needs to change in the plan: say it now, don't defer it to the next weekly recap.
Keep it concise — one coaching-forward observation is enough. Don't lecture.

MILEAGE ACCURACY — CRITICAL: The ⚠️ AUTHORITATIVE WEEK-TO-DATE MILEAGE in CURRENT TRAINING STATE is what the athlete has ALREADY RUN this week — it already includes the activity shown above. Use it as the current/completed figure. If you mention a projected end-of-week total, always add the word "on track for" or "projected" to make clear it's not yet achieved. Never say "you're at X miles this week" when X includes future sessions.

PLAN CONSISTENCY RULES — follow these exactly:
- Week-to-date mileage: use the ⚠️ AUTHORITATIVE WEEK-TO-DATE MILEAGE figure from CURRENT TRAINING STATE as the already-completed figure. Do not manually sum runs from conversation history or include runs from previous weeks.
- Upcoming sessions: if THIS WEEK'S PLANNED SESSIONS is present in CURRENT TRAINING STATE, use those exact sessions and distances. Do not recalculate, substitute, or invent different numbers. Only omit sessions that have already been completed (i.e. activity date falls on or before today's date).
- If no planned sessions are stored yet, reference the most recent plan from conversation history if visible.${injuryReminder}`;
    }
    case "user_message": {
      const nextWeekContext = storedNextPlanWeek
        ? `Week ${storedNextPlanWeek.week_number} (next week): ${storedNextPlanWeek.mileage_target} mi target, long run ${storedNextPlanWeek.long_run_target} mi, key workout: ${storedNextPlanWeek.key_workout}`
        : null;
      return `The athlete just sent you a message. If you see multiple consecutive Athlete messages at the bottom of RECENT CONVERSATION above, treat them together as one thought — SMS sometimes splits long messages into segments. Respond to the full intent of what they said, not just the last fragment. Respond helpfully as their running coach. Use their activity history and training data to give specific, personalized advice.

PLAN CONSISTENCY: If there are UPCOMING SESSIONS THIS WEEK in CURRENT TRAINING STATE, those are the active plan. When the athlete asks about their schedule or upcoming runs, reference those stored sessions first — don't reconstruct the plan from memory or guess at different distances. If a plan exists and the athlete is asking about it, quote it back to them accurately before offering any adjustments.

TRAINING PLAN ADJUSTMENT: You can modify upcoming weeks in the athlete's stored training plan when circumstances clearly warrant it — illness, injury, travel, or a deliberate priority change. When you commit to a change, state it explicitly so the athlete knows their dashboard will reflect it (e.g. "I've updated next week on your dashboard — dropping it to X miles with easy running only" or "I've swapped the tempo for a easy run next week"). Only commit to a change if it's clearly warranted; don't suggest adjustments for minor day-to-day issues. Do not modify weeks that have already passed.${nextWeekContext ? `\n\nUPCOMING WEEK (stored plan):\n${nextWeekContext}` : ""}

LENGTH IN CONVERSATION: Check RECENT CONVERSATION. If there are already 4+ messages from today (active back-and-forth), keep this reply to 1 bubble — 2 at most. Answer the question directly and stop. Don't pad with context that was already covered.

NO REPEAT SCHEDULE PREVIEW: If RECENT CONVERSATION already contains a message from you today that mentioned tomorrow's session, next session, or upcoming workouts — do NOT mention it again in this reply. The athlete already has that information. Answer what they asked, then stop. Only re-mention the schedule if they specifically asked about it.

INTERVAL SESSION MATH: When converting interval sessions to time or total distance, always calculate explicitly — never estimate or guess. Formula: (number of reps × rep distance) + warmup + recovery jogs + cooldown = session total. Example: 6×400m = 6 × 0.25 mi = 1.5 mi of fast work. Add warmup (~1 mi), recovery jogs between reps (~0.75 mi for 5 jogs × ~150m each), and cooldown (~0.5 mi) → ~3.75 mi total. Do NOT output a range that spans 4+ miles (e.g. "3.5–7 mi") — that is internally contradictory and wrong. Output a single coherent total. If you are unsure of warmup/cooldown lengths, use reasonable defaults (1 mi warmup, 0.5 mi cooldown, ~150m jog between reps) and state them explicitly.

FEEDBACK MESSAGES: If the athlete's message starts with "Feedback:" or "FEEDBACK:", they are submitting feedback. Decide which of two paths applies:
- If it's something you can act on as their coach (e.g. "I want more interval sessions", "the mileage feels too low", "can we add tempo runs") — skip any acknowledgment of the feedback label entirely. Just respond as their coach and make the adjustment. Don't say "thanks for the feedback". Act on it.
- If it's a product suggestion or something outside your control as a coach (e.g. "you should add midday check-ins", "the app should let me set my own paces", "I think the schedule format should change") — respond with something like: "Got it — I'll pass that along and someone will follow up." One sentence, then stop. Don't coach on it.`;
    }
    case "morning_reminder":
      if (missedRunCheckin) {
        return `If RECENT CONVERSATION already shows the athlete mentioned skipping yesterday or rescheduling, skip the missed-run check-in and send today's workout reminder only (plain, under 480 characters).

Otherwise: Strava didn't pick up a run from this athlete yesterday, even though it was a scheduled training day. Send a short, casual message that does two things: check in to see if they got the workout in (or what happened), then preview today's session.

Structure (all in one message — split into two bubbles with a blank line if it runs long):
1. A brief, non-judgmental check-in on yesterday — vary the phrasing. e.g. "Didn't catch a run from you yesterday — did you end up getting it in?" / "Looks like yesterday's run didn't sync — all good if you got it in another way!" / "Hey — I didn't see yesterday's workout come through. Did you get it done?" Keep it casual and light, not accusatory. One sentence.
2. Today's workout: type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance. One or two sentences.
3. A brief, open invite to reschedule if yesterday was a miss — vary it. e.g. "Happy to shift things around if yesterday didn't happen." / "Let me know if you want to adjust the week." One sentence.

No markdown. Sound like a real coach texting. Total under 560 characters.`;
      }
      if (includeWorkoutCheckin) {
        return `If RECENT CONVERSATION already contains a message from you covering today's plan or rest day, output ONE brief confirmation sentence under 160 characters — e.g. "Good morning — rest day today as we talked about. Let me know how you're feeling." No preamble, no explanation. Just the one sentence.

Otherwise, send a short message that does two things: check in on yesterday's workout, then preview today's.

Structure (all in one message unless it runs long — split into two bubbles with a blank line if needed):
1. A brief, casual check-in on yesterday — vary the phrasing each time. e.g. "How'd yesterday's run go?" / "Hope yesterday's session felt good —" / "How'd [day]'s workout treat you?" Keep it light, one sentence.
2. Today's workout: type, distance, and target pace or effort. One or two sentences max. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number.
3. A short invite to adjust if needed — vary this too. e.g. "Let me know if you want to dial anything back based on how yesterday felt." / "Happy to tweak today if the legs are tired." One sentence.

No markdown. Sound like a real coach texting. Total under 560 characters.`;
      }
      return `If RECENT CONVERSATION already contains a message from you covering today's workout or rest day, send ONE brief confirmation sentence under 160 characters only — e.g. "Good morning — rest day today as we discussed last night. Let me know how you're feeling." Output nothing else.

Otherwise, send a short reminder text about today's workout. Three parts, all in one message:

1. A brief, natural opener — vary it each time. Options: "Today's workout:", "Here's what's on for today:", use their name casually, reference the day, etc.

2. The workout — type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number. If the session is a quality workout (tempo, intervals, repeats, or race-pace work), add one sentence explaining the purpose — e.g. "This tempo targets your lactate threshold — the foundation of your half marathon pace." Keep it casual and coach-like, one sentence max.

3. A short, energizing closer — vary this too. "Go get it.", "Have a great one.", "Enjoy the run.", "You've got this.", etc. One short phrase.

Keep the whole thing under 480 characters. No markdown, no bullet points. Sound like a real coach texting, not a notification from an app.`;

    case "nightly_reminder":
      if (missedRunCheckin) {
        return `If RECENT CONVERSATION already shows the athlete mentioned skipping today or rescheduling, skip the missed-run check-in and send tomorrow's workout reminder only (plain, under 480 characters).

Otherwise: Strava didn't pick up a run from this athlete today, even though it was a scheduled training day. Send a short, casual message that does two things: check in to see if they got the workout in (or what happened), then preview tomorrow's session.

Structure (all in one message — split into two bubbles with a blank line if it runs long):
1. A brief, non-judgmental check-in on today — vary the phrasing. e.g. "Hey — didn't see today's run come through. Did you get it in?" / "Looks like today's workout didn't sync — hope it went well if you got out there!" / "Didn't catch a run from you today — everything okay?" Keep it casual and light. One sentence.
2. Tomorrow's workout: type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance. One or two sentences.
3. A brief, open invite to reschedule if today was a miss — vary it. e.g. "Happy to adjust the week if today didn't happen." / "Let me know if you want to shift things around." One sentence.

No markdown. Sound like a real coach texting. Total under 560 characters.`;
      }
      if (includeWorkoutCheckin) {
        return `If RECENT CONVERSATION already contains a message from you sent today covering tomorrow's plan or rest day, send ONE brief confirmation sentence under 160 characters only — e.g. "Just a heads up for tomorrow — rest day as we talked about. Hope you're feeling better!" Output nothing else.

Otherwise, send a short message that does two things: check in on today's workout, then preview tomorrow's.

Structure (all in one message unless it runs long — split into two bubbles with a blank line if needed):
1. A brief, casual check-in on today — vary the phrasing each time. e.g. "How'd today's run go?" / "Hope today's session felt good —" / "How did [day]'s workout go?" Keep it light, one sentence.
2. Tomorrow's workout: type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number. If tomorrow is a quality session (tempo, intervals, repeats, or race-pace work), add one sentence explaining the purpose — e.g. "Tomorrow's tempo is working your lactate threshold — that's the core of your half marathon fitness." One sentence max, woven naturally after the workout description.
3. A short invite to adjust based on how today felt — vary this. e.g. "Let me know if you want to tweak anything based on how today felt." / "Happy to adjust if you're feeling it." One sentence.

No markdown. Sound like a real coach texting. Total under 560 characters.`;
      }
      return `If RECENT CONVERSATION already contains a message from you sent today covering tomorrow's workout or rest day, output ONE brief confirmation sentence under 160 characters — e.g. "Wednesday reminder — rest day tomorrow as we discussed. You're doing the right thing." No preamble, no explanation. Just the one sentence.

Otherwise, send a short reminder text about tomorrow's workout. Three parts, all in one message:

1. A brief, natural opener — vary it each time so it doesn't feel canned. Options: "Tomorrow's workout:", "Here's what's on for tomorrow:", use their name casually ("Hey [name], tomorrow:"), reference the day ("Wednesday's session:"), etc. Mix it up.

2. The workout — type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number. If tomorrow is a quality session (tempo, intervals, repeats, or race-pace work), add one sentence explaining the purpose — e.g. "This tempo run builds your lactate threshold — that's the engine behind your goal pace." One sentence max, woven naturally after the workout description.

3. A short, warm closer — vary this too. Rotate through things like "Good luck!", "Let me know how it goes.", "Have fun out there.", "You've got this.", "Enjoy the run.", etc. One short phrase, nothing more.

Keep the whole thing under 480 characters. No markdown, no bullet points. Sound like a real coach texting, not a notification from an app.`;
    case "weekly_recap": {
      // Inject stored plan context so Dean reflects on what was planned vs. actual.
      const storedPlanContext = storedPlanWeek
        ? `STORED TRAINING PLAN — WHAT WAS PLANNED FOR WEEK ${storedPlanWeek.week_number}:\nPhase: ${storedPlanWeek.phase} | Planned mileage: ~${storedPlanWeek.mileage_target}mi | Long run: ~${storedPlanWeek.long_run_target}mi\nKey workout: ${storedPlanWeek.key_workout || "n/a"}\nCoaching note: ${storedPlanWeek.notes || "n/a"}\n\nYour job: recap how actual training compared to this plan, then advise on the upcoming week using the arc above as your guide — don't invent the progression from scratch.\n\n`
        : "";
      const weekMilesStr = weekMileageSoFar.toFixed(1);
      // For non-Strava users with no tracked data, do NOT tell Claude "0 miles" —
      // that causes Dean to say "last week was quiet" and reset to a conservative plan.
      // Instead, tell Claude the data is missing and to use the conversation.
      const noStravaMileageData = !hasStrava && weekMileageSoFar === 0;
      const weekMileageContext = noStravaMileageData
        ? `⚠️ MILEAGE TRACKING UNAVAILABLE: This athlete is not on Strava, so no mileage was automatically tracked this week. Do NOT say "0 miles logged", "quiet week", or imply the athlete didn't run — the data is simply missing. Non-Strava athletes typically only text about a fraction of their runs; assume they completed most of their planned sessions unless they explicitly told you otherwise.\n\nCRITICAL — BUILD NEXT WEEK FROM THE PROGRESSION TARGET, NOT FROM REPORTED MILEAGE: The "Progression target" in CURRENT TRAINING STATE is your baseline for next week's volume. Do NOT anchor next week's mileage to what the athlete mentioned conversationally — that will always undercount. If the progression target says ~X mi, build toward that. Only deviate down if the athlete explicitly said they struggled or didn't complete sessions.\n\n`
        : `⚠️ THIS WEEK'S MILEAGE (authoritative, do not recompute): ${weekMilesStr} mi across ${weekRunCount} run${weekRunCount !== 1 ? "s" : ""}. Use this exact figure when recapping the week — never sum individual runs yourself.\n\n`;
      const deloadInstruction = periodization?.isDeloadWeek
        ? `\n⚠️ RECOVERY WEEK — THIS OVERRIDES NORMAL PROGRESSION:\nThis is a scheduled recovery week. The first text MUST frame it explicitly: "Recovery week this week — pulling back the volume intentionally, this is when your body adapts to the work you've been putting in" or similar. All session distances must be 25–30% shorter than last week.${periodization.suggestedWeeklyMiles != null ? ` Target total: ~${periodization.suggestedWeeklyMiles.toFixed(1)} mi.` : ""} Remove or replace all quality sessions (tempo, intervals) with easy runs or strides. No new intensity. Same number of runs, just shorter and easier. Recovery weeks are not optional — skipping them is how athletes break down.\n`
        : periodization?.suggestedWeeklyMiles != null
        ? `\nPROGRESSION TARGET: This week's suggested mileage is ~${periodization.suggestedWeeklyMiles.toFixed(1)} mi (~${periodization.phase === "peak" ? "5%" : "8%"} step up from recent average). Build toward this across the week's sessions. If the athlete's recent pace suggests they're ready to add a quality session, include one. If they've been building for 3+ weeks, this is week ${(periodization.effectiveWeek ?? 0) % 4 === 3 ? "3 of the build — next week is recovery, so push a little this week" : "of the build — stay consistent"}.\n`
        : "";
      return `${storedPlanContext}${weekMileageContext}${deloadInstruction}Send 2–3 short texts recapping last week and previewing the coming week (use DATE CONTEXT for exact dates). Each text under 480 characters, separated by a blank line. First text: last week summary (mileage, one specific observation) plus one sentence on what this week is targeting and why — e.g. "This week we're adding a tempo run now that your base is solid" or "Pulling back volume slightly — recovery week, which is when adaptation actually happens." Second: this week's key sessions. Third (optional): one brief motivational or tactical note. No intro fluff.

PROGRESSION — be a proactive coach, not a scheduler:
If the athlete has a race goal with a time target (check ATHLETE HISTORY), the weekly plan must reflect where they are in their training arc — don't just repeat last week's plan with the same mileage.
- If recent weeks have been all easy miles with no quality work: this week should introduce or propose a tempo or interval session. Name it specifically ("Let's add a 3-mile tempo at 8:30/mi on Wednesday").
- If the athlete is several weeks out from their race: the plan should be building toward race-specific fitness (threshold work, goal-pace miles), not just accumulating easy volume.
- If the athlete has been consistent: acknowledge the trend and explain what comes next and why ("You've built a solid base over the last month — time to start sharpening with some quality sessions").
Always include one sentence in the first text explaining what this week is targeting and why — even if the phase hasn't changed ("Another building week — consistency is the work right now" / "Recovery week this week, which is actually when your body adapts" / "Ramping the long run this week — that's the core fitness driver for your marathon"). Don't over-explain; one sentence is enough.

QUALITY SESSION "WHY": In the sessions list, for any tempo run, interval session, or race-pace workout, add a brief purpose note on the same line — one short clause after a dash. e.g. "Wed 3/12 · Tempo 4mi (2mi @ 8:45) — threshold work, the engine for your marathon pace" or "Thu 3/13 · 6×800m @ 7:30 — sharpens race speed and economy." Keep it to one clause only. Easy runs and long runs do not need this.

WEEK NUMBERING: Do NOT refer to weeks as "Week 2", "Week 3", etc. You do not have a reliable count of how many training weeks this athlete has been through. Use "this week" and "next week" instead. If you want to signal a training phase, describe it by feel or intent — e.g. "another building week", "recovery week", "adding a quality session this week" — not a number.

MONDAY: Make sure Monday's session is clearly included in the sessions list. Close the final bubble with a natural, warm invitation to check in after Monday — vary the phrasing so it doesn't feel templated. Something like "Excited to hear how Monday goes." or "Hit me up after Monday's run." or "Let me know how the week kicks off." One short sentence, feels like a real coach signing off for the weekend.

YTD MILESTONES: Check "Year-to-date" in ATHLETE HISTORY. If the athlete has crossed a round-number milestone this week (100, 200, 250, 300, 500, 1000 miles) or is within striking distance of one in the coming week, call it out naturally — one short sentence woven into the recap, not a separate announcement. e.g. "You also just crossed 500 miles on the year — that's a real number." Keep it earned, not forced. Skip it if the number isn't notable.

SCHEDULE CONSTRAINT — CRITICAL: Only schedule *running* sessions on the athlete's confirmed training days listed under "Training days" in ATHLETE HISTORY. Do not put runs on other days. Strength, mobility, or cross-training sessions may appear on rest days (days not in the training days list) — especially if the athlete has requested them or has injury notes. If the athlete has mentioned specific day conflicts for running (e.g. "Saturday is spin class", "I have soccer Monday"), do not put a run on those days. If training days is "TBD", distribute runs across weekdays and weekends reasonably.
⚠️ CROSS-TRAINING DAY PROTECTION: If ATHLETE HISTORY shows the athlete does a specific activity on a specific day (e.g., "swimming on Fridays", "yoga on Tuesdays", "spin class on Saturdays"), that day MUST show the cross-training activity — do NOT override it with a run. If they requested a specific count of a non-running session (e.g., "strength twice a week"), that exact count must appear in the plan.

TRAINING DAY COUNT VALIDATION — CRITICAL: The number of running sessions in your plan must exactly match the athlete's stated days/week preference ("Training days" in ATHLETE HISTORY). If the athlete wants 5 days of running, the plan must have exactly 5 running sessions — not 4, not 6. If the count is wrong, fix the plan. This is one of the most common plan errors.

For the sessions text, put each session on its own line using this compact format, sorted chronologically by date — never group by type:
Mon 3/2 · Easy 5mi @ 9:30/mi
Tue 3/3 · Strength + mobility 20 min
Wed 3/4 · Tempo 4mi (2mi @ 8:45)
Sat 3/7 · Long run 8mi easy
Use short day abbreviations (Mon/Tue/Wed/Thu/Fri/Sat/Sun) and M/D date format. No prose between sessions.
NO DUPLICATE ENTRIES: Each date must appear at most once per session type. Before sending, scan your session list — if the same date and session description appear more than once, remove the duplicate. A plan with "Thu 3/26 · Easy 2mi" listed twice is wrong and confusing.
SESSION DISTANCE FORMAT: Running sessions must include distance in miles (e.g. "Easy 5mi"). Non-running sessions (strength, cross-training, swimming, cycling, spin, Zwift, yoga, etc.) must NEVER include distance in miles — use duration or activity name only (e.g. "Strength + mobility 30 min", "Zwift ride 60 min", "Master's swim"). Putting miles on a non-running session causes it to be incorrectly counted as running volume.

STRENGTH & CROSS-TRAINING: If the athlete has injury notes or has requested strength/mobility work, include a "Strength + mobility" session on a rest day in the week preview (see STRENGTH, MOBILITY & CROSS-TRAINING in system prompt). If they have cross-training tools, include a cross-training day where appropriate.

MILEAGE ACCURACY: Any weekly mileage total you state must equal the sum of running session distances — strength, mobility, and cross-training sessions contribute zero miles. If the sum doesn't match your stated total, correct the plan before sending. Never show the calculation. If you're not listing every session, omit the total entirely.
⚠️ CROSS-TRAINING FORMAT: For bike, swim, strength, and mobility sessions use 'min' for duration — NEVER 'mi'. Example: "Thu 4/3 · Easy bike 60min" not "Easy bike 60mi". Writing 'mi' in a cross-training session causes it to be counted as running miles and will inflate your stated total.`;
    }
    case "workout_image":
      return `The athlete just shared a workout screenshot. Here are the extracted details:\n${JSON.stringify(imageActivity || {}, null, 2)}\n\nSend 1–2 short texts as post-workout feedback. First text: one specific reaction to their performance (pace, effort, HR — whatever is most notable). Second text (only if needed): what's next. Each under 480 characters. No generic openers.`;

    case "initial_plan":
      return `This athlete just finished onboarding. Send them an initial week plan — framed as a starting point, not a finished prescription. The goal is to get something in front of them quickly and invite them to shape it.

USE STRAVA DATA — this is critical:
- All plan decisions must be grounded in WEEKLY MILEAGE, PACE ANALYSIS, and RECENT WORKOUTS — use these as your primary inputs, not the athlete's stated goal alone.
- If Strava data exists, reference it specifically: "I can see you've been running X miles/week with some efforts down to Y pace" — this tells the athlete you actually looked at their history.
- Set all training paces based on observed fitness from Strava, not just the goal time. If their recent fast efforts are faster than goal pace, acknowledge that — it tells you they have the speed and the plan should focus on execution and sharpening, not building fitness from scratch.
- If no Strava data exists, proceed without it — but don't pretend to have data you don't have.

GOAL PACE — never compute this yourself:
- The athlete's goal pace (per mile and per km) is pre-calculated and shown in ATHLETE HISTORY as "goal pace: X:XX/mi". Use exactly that number. Do not recalculate it.
- If "goal pace" does NOT appear in ATHLETE HISTORY, there is no goal pace on file. Do not invent one, do not estimate it from race distance alone, and do not reference it in training prescriptions. Use effort-based language instead (e.g. "comfortably hard", "race-effort segments") until a goal time is provided.

RACE TIMELINE — never compute this yourself:
- The days and weeks until the race are pre-calculated in DATE CONTEXT above (e.g. "Race date: YYYY-MM-DD (X days / ~Y weeks away)"). Use those exact numbers. Do not compute the timeline yourself and do not convert between units (do not say "7.5 months" if DATE CONTEXT says "32 weeks"). If you reference the timeline at all, use the weeks figure from DATE CONTEXT verbatim.

VOLUME AND SAFETY:
- ⚠️ CRITICAL: The FITNESS TIER section in your system prompt contains a "⚠️ WEEK 1 VOLUME CAP" and a "⚠️ LONG RUN CAP" — both are hard limits calculated from the athlete's actual current mileage. You MUST respect both caps. Prescribing 2–3× current volume is a documented injury risk. If the cap says Week 1 max is 7 mi, do not write a plan with 15 mi. If the long run cap is 2 mi, do not prescribe a 9 mi long run.
- SELF-CONSISTENCY CHECK: Before sending any plan, verify that (1) the sum of running session distances matches your stated weekly total, and (2) no single session exceeds the long run cap from FITNESS TIER. If you state a safety cap in one sentence and prescribe a plan that violates it in the next sentence, that is a direct contradiction and must be corrected before sending.
- For high-volume athletes, start at their current level — don't sandbagging them with a beginner week.
- For athletes coming back from injury, returning after a long break, or with low current mileage: start shorter than you might think. It's easier to add than to walk back an overambitious first week.
- Address any injury or physical limitation directly in the plan itself — briefly note how the plan accounts for it. Do NOT ask a follow-up question about it.

RUN/WALK INTERVALS FOR ZERO-BASELINE ATHLETES:
- If FITNESS TIER is "No activity data yet" OR the athlete's weekly mileage is 0 (or nearly 0) and they have no current running habit (e.g., "I only walk", "I don't run", "just starting"), prescribe run/walk intervals — NOT continuous running.
- Format: "Run X min, walk Y min, repeat Z times" or similar. Example: "Run 90 sec, walk 2 min × 8 (~30 min total)"
- Writing "Easy 3mi" for a non-runner is dangerous — they cannot run 3 miles continuously and will quit or get injured. Write intervals instead.
- Frame run/walk positively — it's how every distance runner builds their base, not a beginner shortcut.
- Only switch to continuous easy runs once the athlete has built several weeks of consistent running base.

FOCUSED WORKOUT FORMAT — use this instead of a day-by-day schedule when the athlete has indicated they want specific workout prescriptions rather than a complete plan. Look for signals in the recent conversation: phrases like "I don't need a full plan", "just help me with workouts", "I already have a base", "just need the key sessions", "help designing specific workouts", or any variation of wanting workout guidance rather than a complete schedule. Race proximity and Strava history are supporting signals but not required — the athlete's stated preference is the primary trigger.
- Skip the day-by-day schedule format entirely.
- Instead: one bubble acknowledging their context (Strava fitness if available, race timeline, stated base) + a weekly mileage target. One bubble with 2-3 specific quality sessions — describe each session's structure, distance, and exact paces. Frame these as the key sessions for the week; easy miles fill the rest.
- Example quality sessions: "Tue or Wed: 2mi easy, 3mi @ [threshold pace], 1mi easy" / "Fri: 6x800m @ [interval pace] w/400m jog recovery" / "Sun: long run Xmi, last Y easy @ [goal pace]"
- Be specific about paces. For goal-pace-based training: threshold ~10-15 sec/mi faster than goal pace, interval ~25-35 sec/mi faster than goal pace. Cross-check against observed Strava paces — if their fast efforts already exceed goal pace, note that and calibrate accordingly.

MILE TIME TRIAL GOAL:
- Training for a mile PR is speed and neuromuscular work, not endurance volume. Don't pad the week with junk mileage.
- Key sessions: 800m repeats (4-8x) at mile effort or slightly faster, 400m repeats (6-10x) at mile effort, strides (6-10x 20 sec) 2-3x/week, and one longer tempo run (3-5mi) for aerobic support.
- Easy mileage fills the rest but total volume stays modest — 25-35mi/week is plenty for most mile-focused athletes. More is not better here.
- Intensity distribution flips compared to longer events: 60-70% of sessions are genuinely easy, but the quality sessions are sharper and shorter than anything needed for a 5K or 10K.
- No traditional taper — the final 7 days before the time trial, reduce total volume ~30% and do one short sharpening session (4-6x400m).
- If they have a goal time, compute goal pace (e.g., 5:30 mile = 5:30/mi) and use it to calibrate intervals: 400m repeats ~5-10 sec/quarter faster than goal pace.

ULTRA AND LONG TRAIL DISTANCE GOALS (30K, 50K, 100K, 50mi, 100mi, and beyond):
- Do NOT apply beginner conservatism. Anyone training for these distances is already running meaningful volume — calibrate to their stated mileage, not a cautious floor.
- Long run in week 1 should reflect the race distance: for 50K+, at minimum 10–12mi and up to 16–18mi if their weekly mileage supports it. For 30K, at minimum 8–10mi. A 6mi long run for a 50K+ athlete is not appropriate.
- Time-on-feet matters more than pace. Frame long runs by duration or easy effort, not a specific pace target — especially for mountain races.
- For mountain/technical trail races (Black Canyon, Western States, Dipsea, Hardrock, etc.) include vert-specific work and power hiking from the start — not just later in the build.
- For 100-milers specifically: volume tolerance and back-to-back long runs are the primary training stressors. The long run should grow to 20–22mi at peak, with optional back-to-back long days once base is established.
- If a finish time goal is given (e.g. "under 18 hours"), use it to infer experience level and calibrate the plan accordingly. An 18-hour 100K is not a beginner finishing.

SPORT-SPECIFIC GUIDANCE:
- Runners: runs with effort or pace. On rest days: if the athlete has injury notes or requested strength/mobility work, replace one rest day with a tailored strength + mobility session (see STRENGTH, MOBILITY & CROSS-TRAINING in system prompt). Include cross-training on off days if they mentioned it.
- Triathletes: distribute swim/bike/run appropriately. Include strength/yoga if mentioned.
- Cyclists: rides with duration and effort. Include any supplemental work they mentioned.
- General fitness: whatever makes sense given their lifestyle and activities mentioned.

MILEAGE ACCURACY: Any weekly mileage total you state must equal the sum of running session distances — strength, mobility, and cross-training sessions contribute zero miles. If the sum doesn't match your stated total, correct the plan before sending. Never show the calculation. If you're not listing every session, omit the total entirely.
⚠️ CROSS-TRAINING FORMAT: For bike, swim, strength, and mobility sessions use 'min' for duration — NEVER 'mi'. Example: "Thu 4/3 · Easy bike 60min" not "Easy bike 60mi". Writing 'mi' in a cross-training session causes it to be counted as running miles and will inflate your stated total.

SCHEDULE CONSTRAINT: Only schedule *running* sessions on the athlete's confirmed training days listed under "Training days" in ATHLETE HISTORY. Do not put runs on other days. Strength, mobility, or cross-training sessions may appear on rest days if the athlete has requested them.
⚠️ CROSS-TRAINING DAY PROTECTION: If ATHLETE HISTORY shows the athlete does a specific activity on a specific day (e.g., "swimming on Fridays", "yoga on Tuesdays", "spin class on Saturdays"), that day MUST show the cross-training activity — do NOT override it with a run. If they requested a specific count of a non-running session (e.g., "strength twice a week"), that exact count must appear in the plan.

DATES AND DAY LABELS:
- CRITICAL: Use the day names from DATE CONTEXT above — do not compute weekdays yourself. DATE CONTEXT lists tomorrow and the next 7 days with correct day names. Copy them directly. "Wed, Mar 11" → use "Wed 3/11". Getting these wrong destroys trust.
- Start the plan from tomorrow or later — do not add a session for today.
- If "Mileage so far this week" in CURRENT TRAINING STATE is > 0, acknowledge it in the first bubble ("You've already got X miles in this week") and factor it into the weekly total. Do not ignore it.

B/C RACE PLANNING (if B or C races appear in DATE CONTEXT above):
- The arc orientation should mention B races as tune-up checkpoints — e.g. "The Dipsea in June serves as a great fitness check before the Sierre Zinal build." Do NOT ignore them.
- B races = race at strong controlled effort, not an all-out peak. Plan doesn't fully taper for them.
- C races = treat as a quality workout day. No schedule disruption.
- Do NOT try to peak for both A and B races simultaneously — the A race is the only peak.

DEFAULT FORMAT (for athletes not matching the EXPERIENCED RUNNER CLOSE TO RACE criteria above):
Write as 2 short iMessage texts separated by a blank line. Each under 480 characters.

First bubble: 3-4 sentences max. If the athlete has a race date, open with a 1-2 sentence training arc orientation — briefly sketch the shape of the journey from now to race day (e.g. "You've got ~18 weeks — first 6 or so we're building your aerobic base, then we'll layer in quality work and sharpen into goal pace in the final month before the taper"). This tells them where they're going, not just what's happening this week. Then one sentence on why this specific first week is structured the way it is — e.g. "Starting with all easy miles to build your aerobic base before introducing quality work" or "Keeping volume conservative given the hip — easier to add than to walk back a flare-up." If no race date, skip the arc and just explain the week's rationale. Do NOT open with "Got it" or any generic acknowledgment phrase. Do NOT restate their goal back to them.

Second bubble: this week's sessions, one per line, sorted chronologically by date — never group by type (runs first, then strength):
Mon 3/2 · Easy 3mi @ easy effort
Tue 3/3 · Strength + mobility 20 min
Wed 3/4 · Tempo 4mi (2mi @ 8:45) — builds lactate threshold, the engine for your goal pace
Sat 3/7 · Easy 4mi
SESSION DISTANCE FORMAT: Running sessions must include distance in miles (e.g. "Easy 3mi"). Non-running sessions (strength, cross-training, swimming, cycling, spin, Zwift, yoga, etc.) must NEVER include distance in miles — use duration or activity name only (e.g. "Strength + mobility 20 min", "Zwift ride 60 min"). Putting miles on a non-running session causes it to be incorrectly counted as running volume.
QUALITY SESSION "WHY": For any tempo run, interval session (800m repeats, etc.), or race-pace workout in the plan, add a brief purpose note on the same line — one short clause after a dash. Keep it specific to the athlete's goal: "— builds lactate threshold, the engine for your half marathon pace" or "— sharpens the speed you'll need at goal pace" or "— teaches your legs to run fast when tired." Easy runs and long runs do not need this treatment.
Use short day abbreviations and M/D dates (cross-referenced against DATE CONTEXT — do not compute day names independently). Then close with three short lines on a new line, each as its own sentence:
1. Invite feedback on the plan — e.g. "How does this look? Happy to adjust anything."
2. Offer reminders naturally${!timezoneConfirmed ? " — and since you haven't confirmed your location yet, ask for their city/timezone in the same sentence so reminders go out at the right time. Combine both naturally into one question, e.g. \"I can send a reminder the morning of each session or the evening before — which works better? And what city are you in so I time them right?\"" : " — e.g. \"I can also shoot you a reminder the morning of each session or the evening before — just let me know which works better.\""}
3. Open line — e.g. "And this number's always open — how a run felt, questions, if something's off. That's what I'm here for."
Vary the phrasing each time — these are the ideas, not a script.

ONE QUESTION RULE: The closing line above is the only question in the entire response. Do not ask anything else — no follow-ups about injuries, niggles, schedule, or anything else. If you want to flag something about an injury or constraint, state it as information ("I've kept this conservative given your hip") not as a question.
${!hasStrava ? `
NO STRAVA — SET THE TEXT-TRACKING HABIT: This athlete is not on Strava, so there's no automatic activity sync. Weave a natural, low-key line into the closing of the plan that tells them to text you after each run. Make it feel like a coach thing, not a system requirement. Examples: "Since you're not on Strava, just shoot me a text after each run — even a quick 'done, 5 miles' — and I'll track from there." or "No Strava sync here, so just drop me a message after each workout and I'll keep tabs on your progress." Vary the phrasing. One sentence only — don't dwell on it.` : ""}`;

  }
}
