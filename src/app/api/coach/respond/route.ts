import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { calculateVDOTPaces, estimatePacesFromEasyPace, easyPaceRange } from "@/lib/paces";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping, typingDurationMs } from "@/lib/linq";
import { trackEvent } from "@/lib/track";
import { fetchWeekWeather, buildWeatherBlock } from "@/lib/weather";
import { buildPeriodization, computePhase } from "@/lib/periodization";
import type { PeriodizationContext } from "@/lib/periodization";
import { computePhaseForPlan, generateAndSaveFullPlan, computeRacePreparedness } from "@/lib/training-plan";
import { enforceVolumeCaps, deduplicateSessionLines, fixSessionDistanceErrors } from "@/lib/plan-validation";
import type { Json } from "@/lib/database.types";

export const maxDuration = 120;

type TriggerType = "morning_plan" | "post_run" | "post_run_onboarding" | "user_message" | "initial_plan" | "weekly_recap" | "nightly_reminder" | "morning_reminder" | "workout_image" | "rebuild_plan" | "sync_sessions";

interface CoachRequest {
  userId: string;
  trigger: TriggerType;
  activityId?: number;
  imageActivity?: Record<string, unknown>; // Pre-extracted workout data from image upload
  dry_run?: boolean;
  silent?: boolean; // For rebuild_plan: regenerates the arc without sending the "plan ready" SMS
  prescribedWeek1Miles?: number; // For rebuild_plan: admin override for base mileage when Strava data is wrong/incomplete
  partialWeekTarget?: number; // For sync_sessions: re-apply partial-week mileage target after syncArcCurrentWeek
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
  hasRecentLongEffort: boolean;          // run ≥ 10 mi or ≥ 75 min in last 14 days
  daysUntilRace: number | null;          // null if no race date or race has passed
}

/**
 * POST /api/coach/respond
 * Core coaching function. Given a user + trigger, generates and sends a coaching response via SMS.
 */
export async function POST(request: Request) {
  const body = await request.json();

  if (!body.userId || !body.trigger) {
    return NextResponse.json({ error: "Missing required fields: userId, trigger" }, { status: 400 });
  }

  // For non-dry_run requests, return 200 immediately and do all the work in
  // after() so the caller (webhook) isn't left waiting on Claude + SMS time.
  if (!body.dry_run) {
    after(async () => {
      try {
        await processCoachRequest(body);
      } catch (err) {
        console.error("[coach/respond] unhandled error in after():", err);
        void trackEvent(body.userId, "after_error", { trigger: body.trigger, error: String(err) });
      }
    });
    return NextResponse.json({ ok: true });
  }

  // dry_run: process inline so the caller gets the generated message back
  return await processCoachRequest(body);
}

// Step-to-question map for mid-onboarding post_run nudges.
const ONBOARDING_STEP_QUESTIONS: Record<string, string> = {
  awaiting_schedule: "Which days of the week work best for your training? (e.g. Mon, Wed, Fri, Sun)",
  awaiting_race_date: "When's your race? A rough month and year works fine.",
  awaiting_goal_time: "Do you have a time goal in mind?",
  awaiting_anything_else: "Anything else I should know before I put your plan together?",
  awaiting_ultra_background: "Have you run any ultras or very long trail races before?",
  awaiting_injury_background: "Any injuries or physical limitations I should keep in mind?",
  awaiting_cadence: "Last thing — would you like a reminder the morning of each workout, or the evening before? If not, I'll just send you a weekly plan every Sunday.",
};

/**
 * Full plan rebuild triggered by a [REBUILD_PLAN] signal from Dean.
 *
 * Sequencing is the key guarantee here: profile updates from the conversation are
 * persisted FIRST (so corrected paces, training days, etc. are in the DB), then
 * generateAndSaveFullPlan runs against the fresh profile. This prevents the
 * "paces corrected in conversation but plan regenerated from stale profile" failure.
 *
 * Does NOT reset current_week — the athlete stays on their current week in the arc.
 * generateAndSaveFullPlan sends the dashboard link SMS automatically.
 */
async function handleRebuildPlan(userId: string, dryRun: boolean, silent = false, adminOverrideMiles?: number): Promise<NextResponse> {
  // Load user and profile.
  // Profile extraction is intentionally NOT done here — by the time rebuild_plan fires,
  // persistProfileUpdates has already run in the user_message handler (line ~1173).
  // Doing it again adds a redundant LLM call (~5s) and would push us over the 10s
  // Hobby plan function limit.
  const [userResult, profileResult] = await Promise.all([
    supabase.from("users").select("*").eq("id", userId).single(),
    supabase.from("training_profiles").select("*").eq("user_id", userId).single(),
  ]);

  const user = userResult.data as Record<string, unknown> | null;
  const profile = profileResult.data as Record<string, unknown> | null;
  if (!user || !profile) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const phoneNumber = user.phone_number as string;
  const hasStrava = !!(user.strava_athlete_id as number | null);

  // Fetch Strava activities, B/C races, training_state, and recent conversations in parallel.
  // No profile re-fetch needed — profile was already persisted by user_message before this fires.
  const now = new Date();
  const eightWeeksAgo = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000).toISOString();
  const [recentActsResult, { data: upcomingRaces }, { data: stateData }, { data: conversationsData }] = await Promise.all([
    hasStrava
      ? supabase.from("activities").select("distance_meters, start_date").eq("user_id", userId).gte("start_date", eightWeeksAgo).in("activity_type", ["Run", "TrailRun", "VirtualRun", "Treadmill"])
      : Promise.resolve({ data: null }),
    supabase.from("races").select("race_date, race_name, priority").eq("user_id", userId).gt("race_date", now.toISOString().slice(0, 10)).in("priority", ["B", "C"]),
    supabase.from("training_state").select("weekly_mileage_target, current_week, weekly_plan_sessions").eq("user_id", userId).single(),
    supabase.from("conversations").select("role, content").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
  ]);

  let avgWeeklyMileage: number | null = null;
  const recentActs = recentActsResult.data;
  if (recentActs && recentActs.length > 0) {
    const totalMiles = recentActs.reduce((sum, a) => sum + ((a.distance_meters as number) / 1609.34), 0);
    avgWeeklyMileage = Math.round((totalMiles / 8) * 10) / 10;
  }

  const bCRaces = (upcomingRaces ?? []) as Array<{ race_date: string; race_name: string | null; priority: string }>;
  const typedStateData = stateData as { weekly_mileage_target: number | null; current_week: number | null; weekly_plan_sessions: unknown } | null;
  const existingTarget = typedStateData?.weekly_mileage_target ?? null;
  const currentWeek = typedStateData?.current_week ?? 1;

  // When rebuilding in week 1, we allow a full week 1 regeneration (update mileage target +
  // sessions) but preserve any sessions whose date has already passed — the athlete may have
  // already completed or missed those sessions and wiping them loses context.
  const isWeek1Rebuild = currentWeek === 1;
  const rawSessions = typedStateData?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }> | null;
  let preservedSessions: Array<{ day: string; date: string; label: string }> | null = null;
  if (isWeek1Rebuild && rawSessions) {
    const todayMonth = now.getMonth() + 1;
    const todayDay = now.getDate();
    const past = rawSessions.filter(s => {
      const [m, d] = s.date.split("/").map(Number);
      return !isNaN(m) && !isNaN(d) && (m < todayMonth || (m === todayMonth && d < todayDay));
    });
    preservedSessions = past.length > 0 ? past : null;
  }

  const allRecentText = (conversationsData ?? []).map((m: { content: string }) => m.content).join(" ").toLowerCase();

  // Haiku classifies whether the athlete requested a mileage/volume change.
  // Defaults to NO (conservative — preserves existing target if the call fails).
  // Skipped for silent (admin) rebuilds — result is unused and NO is the right default.
  type MileageIntent = "INCREASE" | "DECREASE" | "NO";
  let mileageIntent: MileageIntent = "NO";
  if (!silent) {
    try {
      const mileageCheck = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        system: `Classify the athlete's intent. Reply with exactly one word:
DECREASE — they explicitly asked to reduce weekly mileage or volume
INCREASE — they explicitly asked to increase weekly mileage or volume
NO — no mileage/volume change requested (e.g. adding workout types, fixing sessions, changing schedule)

Ignore mentions of specific workout types (tempo, intervals, hill repeats, cycling, HIIT). Only classify explicit mileage/volume requests.`,
        messages: [{ role: "user", content: allRecentText.slice(-2000) }],
      });
      const raw = mileageCheck.content[0].type === "text"
        ? mileageCheck.content[0].text.trim().toUpperCase()
        : "NO";
      if (raw === "INCREASE" || raw === "DECREASE") mileageIntent = raw;
      console.log(`[handleRebuildPlan] mileage classification: ${mileageIntent}`);
    } catch (err) {
      console.error("[handleRebuildPlan] mileage classification failed (non-fatal):", err);
    }
  }
  const wantsMileageChange = mileageIntent !== "NO";
  const wantsDecrease = mileageIntent === "DECREASE";

  // Extract athlete-stated mileage from recent conversation.
  // When Strava data is incomplete (e.g. watch not syncing), the athlete often corrects us
  // by stating their actual weekly volume. Parse the highest plausible figure mentioned in
  // the last 20 messages and use it as a floor when it significantly exceeds Strava avg.
  let statedMileage: number | null = null;
  const mileageMatches = allRecentText.matchAll(/\b(\d{1,3}(?:\.\d)?)\s*(?:miles?|mi)\b/g);
  for (const m of mileageMatches) {
    const val = parseFloat(m[1]);
    if (val >= 5 && val <= 150) {
      statedMileage = statedMileage === null ? val : Math.max(statedMileage, val);
    }
  }

  // Compute the effective base for the rebuild arc.
  // Priority: admin override > content-only anchor > Strava avg > profile default.
  //
  // Content-only anchor: when no mileage change was requested and we have an existing
  // target, lock the arc to that value. This prevents Strava avg drift from silently
  // shifting all mileage targets when the user only asked to add hill repeats or cycling.
  let rebuildBase: number | undefined;
  if (adminOverrideMiles != null && adminOverrideMiles > 0) {
    rebuildBase = adminOverrideMiles;
    console.log(`[handleRebuildPlan] using admin override: ${rebuildBase} mi/week`);
  } else if (!wantsMileageChange && existingTarget != null) {
    rebuildBase = existingTarget;
    console.log(`[handleRebuildPlan] content-only rebuild — anchoring to existing target: ${rebuildBase} mi/week`);
  } else if (avgWeeklyMileage !== null) {
    const stravaBase = wantsDecrease
      ? Math.min(avgWeeklyMileage, existingTarget ?? avgWeeklyMileage)
      : avgWeeklyMileage;
    // Use stated mileage as floor when it's materially higher than Strava (likely a sync gap).
    const statedFloor = statedMileage !== null && statedMileage > stravaBase * 1.5
      ? statedMileage
      : null;
    rebuildBase = statedFloor ?? stravaBase;
    if (statedFloor) {
      console.log(`[handleRebuildPlan] Strava avg (${avgWeeklyMileage} mi) significantly below stated mileage (${statedMileage} mi) — using stated as base`);
    }
  }
  // No Strava and no existing target: leave rebuildBase undefined → derives from profile.

  const onboardingData = (user.onboarding_data as Record<string, unknown> | null) ?? {};
  const wantsSpeedWork = !!onboardingData.wants_speed_work;
  const otherNotes = (onboardingData.other_notes as string | null) ?? null;

  // Craft a context line for the post-rebuild SMS so the athlete knows what changed.
  // This is appended to the dashboard link so they're not left wondering if their
  // current week was affected or just the upcoming weeks.
  const planReadyNote = silent ? undefined
    : isWeek1Rebuild
    ? "Your plan has been fully regenerated starting this week. Check your dashboard for the updated schedule."
    : wantsMileageChange
    ? "Your plan has been updated with the adjusted mileage — your current week is unchanged."
    : "Your upcoming weeks have been updated with your changes. Your current week is unchanged.";

  if (!dryRun) {
    // Run generateAndSaveFullPlan in after() so this function returns immediately.
    // The caller (linq webhook's after() or the wantsRebuild after()) only needs to
    // wait for the fast DB reads above, not the 30-60s Haiku enrichment. This keeps
    // both callers within the Hobby plan's 60s function budget.
    after(async () => {
      try {
        await generateAndSaveFullPlan(
          userId,
          phoneNumber,
          profile as Record<string, unknown> | null,
          avgWeeklyMileage,
          {
            resetToWeek1: false,
            week1Reset: isWeek1Rebuild,
            preservedSessions,
            planReadyNote,
            bRaces: bCRaces.length > 0 ? bCRaces : undefined,
            wantsSpeedWork,
            prescribedWeek1Miles: rebuildBase,
            skipLinkSms: silent,
            otherNotes,
          }
        );
        void trackEvent(userId, "plan_generated", { plan_type: "rebuild" });
      } catch (err) {
        console.error("[handleRebuildPlan] generateAndSaveFullPlan failed:", err);
        void trackEvent(userId, "after_error", { trigger: "rebuild_plan", error: String(err) });
        // Send fallback SMS so the user isn't left waiting for a link that never arrives
        try {
          await sendSMS(phoneNumber, "Something went wrong updating your plan — try texting UPDATE PLAN again, or text \"my plan\" to see your current version.");
        } catch (smsErr) {
          console.error("[handleRebuildPlan] fallback SMS also failed:", smsErr);
        }
      }
    });
  }

  return NextResponse.json({ ok: true });
}

/**
 * Runs extractAndStorePlanSessions + syncArcCurrentWeek in a fresh invocation
 * so initial_plan and weekly_recap stay within the 10s Hobby budget.
 *
 * Reads the plan text from the most recent initial_plan/weekly_recap conversation row —
 * that message is already saved to DB before this trigger fires.
 *
 * @param partialWeekTarget - When set (> 0), re-applies this value as weekly_mileage_target
 *   after syncArcCurrentWeek runs, preserving the partial-week onboard total
 *   (miles already logged + miles Dean prescribed for remaining days).
 */
async function handleSyncSessions(userId: string, partialWeekTarget: number | null): Promise<NextResponse> {
  const [userResult, profileResult, stateResult, convResult] = await Promise.all([
    supabase.from("users").select("id, name").eq("id", userId).single(),
    supabase.from("training_profiles").select("goal").eq("user_id", userId).single(),
    supabase.from("training_state").select("current_week, current_phase").eq("user_id", userId).single(),
    supabase.from("conversations")
      .select("content")
      .eq("user_id", userId)
      .eq("role", "assistant")
      .in("message_type", ["initial_plan", "weekly_recap"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single(),
  ]);

  const user = userResult.data as { id: string; name: string | null } | null;
  const profile = profileResult.data as { goal: string | null } | null;
  const state = stateResult.data as { current_week: number | null; current_phase: string | null } | null;
  const planMessage = convResult.data as { content: string } | null;

  if (!user || !profile || !state) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (planMessage) {
    await extractAndStorePlanSessions(userId, planMessage.content);
  }

  await syncArcCurrentWeek(
    userId,
    state.current_week ?? 1,
    state.current_phase ?? "base",
    profile.goal ?? "",
    user.name ?? null,
  );

  // Re-apply the partial-week onboard total if provided — syncArcCurrentWeek overwrites
  // weekly_mileage_target with just the prescribed session sum, losing the miles already logged.
  if (partialWeekTarget != null && partialWeekTarget > 0) {
    await supabase.from("training_state")
      .update({ weekly_mileage_target: partialWeekTarget })
      .eq("user_id", userId);
  }

  return NextResponse.json({ ok: true });
}

/**
 * Handles a Strava activity event for a user who hasn't finished onboarding yet.
 * Sends a brief, warm reaction to the run, then re-asks the current onboarding question
 * so the user knows to reply and finish setup.
 */
async function handlePostRunOnboarding(
  userId: string,
  activityId: number | undefined,
  dryRun: boolean,
  requestChatId: string | undefined
): Promise<NextResponse> {
  const [userResult, activityResult] = await Promise.all([
    supabase
      .from("users")
      .select("id, phone_number, name, onboarding_step, linq_chat_id, messaging_opted_out")
      .eq("id", userId)
      .single(),
    activityId
      ? supabase
          .from("activities")
          .select("activity_type, distance_meters, moving_time_seconds, average_heartrate, average_pace, elevation_gain")
          .eq("strava_activity_id", activityId)
          .single()
      : Promise.resolve({ data: null }),
  ]);

  const user = userResult.data;
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (user.messaging_opted_out) {
    console.log(`[coach/respond] user ${userId} is opted out, skipping post_run_onboarding`);
    return NextResponse.json({ ok: true, skipped: "opted_out" });
  }

  const activity = activityResult.data as Record<string, unknown> | null;
  const onboardingStep = user.onboarding_step as string | null;
  const pendingQuestion = onboardingStep ? (ONBOARDING_STEP_QUESTIONS[onboardingStep] ?? null) : null;

  const systemPrompt = `You are Coach Dean, an AI running coach. A user just finished a run but hasn't finished setting up their coaching profile yet. React briefly and warmly to their run in 1-2 sentences — be specific about what they did (distance, pace if notable). Then pivot naturally to continue their onboarding with the question below. Keep the whole message under 4 sentences. No lists, no markdown, no bullet points.${pendingQuestion ? `\n\nAfter your brief reaction, ask: "${pendingQuestion}"` : "\n\nAfter your brief reaction, let them know you're excited to get their plan together."}`;

  const activityDetails = activity
    ? {
        type: activity.activity_type,
        distance_miles: Math.round(((activity.distance_meters as number) / 1609.34) * 100) / 100,
        duration_minutes: Math.round((activity.moving_time_seconds as number) / 60),
        average_pace: activity.average_pace,
        average_heartrate: activity.average_heartrate ?? null,
        elevation_gain_feet: activity.elevation_gain != null
          ? Math.round((activity.elevation_gain as number) * 3.28084)
          : null,
      }
    : null;

  const claudeResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 300,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: activityDetails
          ? `New activity synced from Strava:\n${JSON.stringify(activityDetails, null, 2)}`
          : "A new run just synced from Strava (details unavailable).",
      },
    ],
  });

  const rawOnboardingMsg = claudeResponse.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text.trim())
    .join(" ")
    .trim();
  const coachMessage = stripReasoningPreamble(rawOnboardingMsg);

  if (dryRun) return NextResponse.json({ ok: true, dry_run: true, message: coachMessage });

  if (!coachMessage) return NextResponse.json({ ok: true, skipped: true });

  const chatId = requestChatId ?? (user.linq_chat_id as string | null) ?? null;
  if (chatId) await startTyping(chatId);

  await sendSMS(user.phone_number as string, coachMessage);
  await supabase.from("conversations").insert({
    user_id: userId,
    role: "assistant",
    content: coachMessage,
    message_type: "post_run",
    strava_activity_id: activityId || null,
  });

  void trackEvent(userId, "coaching_response_sent", { trigger: "post_run_onboarding", onboarding: true });

  return NextResponse.json({ ok: true, message: coachMessage });
}

async function processCoachRequest(body: CoachRequest): Promise<NextResponse> {
  const { userId, trigger, activityId, imageActivity, dry_run, silent, chatId: requestChatId, includeWorkoutCheckin, missedRunCheckin } = body;

  // Lightweight early-exit: brief run reaction + onboarding nudge for mid-onboarding users.
  // Avoids the heavy data fetching the full post_run path requires.
  if (trigger === "post_run_onboarding") {
    return await handlePostRunOnboarding(userId, activityId, dry_run ?? false, requestChatId);
  }

  // Rebuild plan early exit: persists profile updates from recent conversation, then
  // regenerates the full plan arc without resetting the week counter. No Claude call needed.
  // Fired after Dean sends a [REBUILD_PLAN] confirmation to the athlete.
  if (trigger === "rebuild_plan") {
    return await handleRebuildPlan(userId, dry_run ?? false, silent ?? false, body.prescribedWeek1Miles);
  }

  if (trigger === "sync_sessions") {
    return await handleSyncSessions(userId, body.partialWeekTarget ?? null);
  }

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

  // Opt-out gate — never send messages to users who have unsubscribed.
  if (user.messaging_opted_out) {
    console.log(`[coach/respond] user ${userId} is opted out, skipping trigger: ${trigger}`);
    return NextResponse.json({ ok: true, skipped: "opted_out" });
  }

  // Subscription gate — only applies to users with billing_enabled.
  // Grandfathered users (billing_enabled = false) always pass through.
  // initial_plan is exempt — it's fired by the Stripe webhook right after checkout.
  if (user.billing_enabled && trigger !== "initial_plan") {
    const status = user.subscription_status as string | null;
    const hasAccess = status === "trialing" || status === "active";
    const isPastDue = status === "past_due";

    if (!hasAccess) {
      if (trigger === "user_message") {
        // Reply to user messages so the line isn't dead, but don't run coaching logic.
        // past_due → Stripe Customer Portal (update payment method on existing subscription).
        // canceled → new checkout session (re-subscribe, reuses existing Stripe customer).
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
        let dashboardToken = user.dashboard_token as string | null;
        if (!dashboardToken && !dry_run) {
          dashboardToken = crypto.randomUUID();
          await supabase.from("users").update({ dashboard_token: dashboardToken }).eq("id", userId);
        }
        const checkoutUrl = dashboardToken ? `${appUrl}/checkout?token=${dashboardToken}` : appUrl;
        const portalUrl = dashboardToken ? `${appUrl}/cancel?token=${dashboardToken}` : appUrl;
        // Detect subscribe/pay intent — reply warmly with direct link instead of the canned wall message.
        const latestUserMsg = [...recentMessages].reverse().find(m => m.role === "user");
        const hasSubscribeIntent = latestUserMsg &&
          /\b(subscribe|subscription|pay|payment|sign.?up|get started|ready to start|want to join|want to subscribe|want to pay|want to sign up|ready to subscribe)\b/i.test(latestUserMsg.content as string);
        const msg = isPastDue
          ? (hasSubscribeIntent
              ? `Got it — here's your direct link to update your payment method, takes 2 minutes: ${portalUrl}`
              : "Your last payment didn't go through — update your payment method here to continue coaching: " + portalUrl)
          : (hasSubscribeIntent
              ? `Got it — here's your direct link to get started, takes 2 minutes: ${checkoutUrl}`
              : "Your Coach Dean subscription isn't active. Subscribe here to continue: " + checkoutUrl);
        if (!dry_run) {
          await sendSMS(user.phone_number as string, msg);
          await supabase.from("conversations").insert({ user_id: userId, role: "assistant", content: msg, message_type: "user_message" });
        }
      }
      // Silently skip all proactive triggers (reminders, post_run, weekly_recap, etc.)
      return NextResponse.json({ ok: true, gated: true });
    }
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

  // "My plan" keyword: short-circuit before any LLM calls.
  // Must be placed here — before profile extraction — so we don't waste a Haiku call.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
  let dashboardToken = user.dashboard_token as string | null;
  let dashboardUrl = dashboardToken ? `${appUrl}/dashboard?token=${dashboardToken}` : null;
  if (trigger === "user_message") {
    // recentMessages is oldest-first (DB returns DESC, then reversed at line 239).
    // Spread-reverse to search newest-first and get the most recent user message.
    const latestUserMsg = [...recentMessages].reverse().find(m => m.role === "user");
    // Catch natural-language plan requests in addition to the exact "my plan" keyword.
    // "Could you send me my plan for training for bay to breakers?" must hit this path —
    // if it falls through to Claude, web search kicks in and Claude generates an inline
    // plan instead of sending the dashboard link.
    const isPlanRequest = latestUserMsg && (
      /^\s*my\s+plan\s*$/i.test(latestUserMsg.content) ||
      /\bsend\s+(?:me\s+)?(?:my|the)\s+(?:training\s+)?plan\b/i.test(latestUserMsg.content) ||
      /\b(?:show|see|view)\s+(?:me\s+)?(?:my|the)\s+(?:training\s+)?plan\b/i.test(latestUserMsg.content) ||
      // Catches "show me the entire week by week plan", "show me my full plan", etc.
      // Allows up to 6 intermediate words between "show/see/view/send me" and "plan".
      /\b(?:show|see|view|send)\s+me\s+(?:\w+\s+){0,6}plan\b/i.test(latestUserMsg.content)
    );
    if (isPlanRequest) {
      if (!dashboardToken) {
        const bCRaces = upcomingRaces.filter(r => r.priority === "B" || r.priority === "C") as Array<{ race_date: string; race_name: string | null; priority: string }>;
        const newToken = await generateAndSaveFullPlan(
          userId,
          user.phone_number as string,
          profile,
          avgWeeklyMileage,
          {
            skipLinkSms: true,
            prescribedWeek1Miles: (state?.weekly_mileage_target as number | null) ?? undefined,
            bRaces: bCRaces.length > 0 ? bCRaces : undefined,
            // "my plan" is only triggered when there's no dashboard token yet — this is
            // always a first-time plan generation, so start at week 1.
            resetToWeek1: true,
          }
        ).catch(err => {
          console.error("[coach/respond] generateAndSaveFullPlan failed on my-plan request:", err);
          return null;
        });
        dashboardToken = newToken;
        dashboardUrl = newToken ? `${appUrl}/dashboard?token=${newToken}` : null;
      }
      const chatId = requestChatId ?? (user.linq_chat_id as string | null) ?? null;
      if (chatId) await startTyping(chatId);
      const linkMsg = dashboardUrl
        ? `Here's your full training plan: ${dashboardUrl}`
        : "Having trouble pulling up your plan right now — try again in a few minutes.";
      if (!dry_run) {
        await sendSMS(user.phone_number as string, linkMsg);
        await supabase.from("conversations").insert({ user_id: userId, role: "assistant", content: linkMsg, message_type: "user_message" });
        void trackEvent(userId, "plan_link_sent", { source: "my_plan_keyword" });
      }
      return NextResponse.json({ ok: true, message: linkMsg });
    }
  }

  // "Cancel" / "help" keyword: short-circuit before LLM calls.
  // Send the Stripe portal link directly — no need to route through Claude.
  if (trigger === "user_message") {
    const latestUserMsg = [...recentMessages].reverse().find(m => m.role === "user");
    const isCancelRequest = latestUserMsg && (
      /^\s*cancel\s*$/i.test(latestUserMsg.content) ||
      /\b(cancel|unsubscribe|stop\s+subscription|end\s+my\s+subscription|cancel\s+my\s+subscription)\b/i.test(latestUserMsg.content)
    );
    const isHelpRequest = latestUserMsg && /^\s*help\s*$/i.test(latestUserMsg.content);
    if ((isCancelRequest || isHelpRequest) && dashboardToken) {
      const cancelUrl = `${appUrl}/cancel?token=${dashboardToken}`;
      const chatId = requestChatId ?? (user.linq_chat_id as string | null) ?? null;
      if (chatId) await startTyping(chatId);
      const cancelMsg = isCancelRequest
        ? `To cancel your subscription, tap here — you can manage everything yourself:\n\n${cancelUrl}\n\nSorry to see you go! Let me know if there's anything I can do.`
        : `To manage your subscription (cancel, update payment, view invoices), tap here:\n\n${cancelUrl}`;
      if (!dry_run) {
        await sendSMS(user.phone_number as string, cancelMsg);
        await supabase.from("conversations").insert({ user_id: userId, role: "assistant", content: cancelMsg, message_type: "user_message" });
      }
      return NextResponse.json({ ok: true, message: cancelMsg });
    }
  }

  // For user_message: extract race/pace data BEFORE building the system prompt so the
  // coach responds with accurate paces immediately (not one message later).
  let pendingExtracted: Awaited<ReturnType<typeof extractProfileData>> | null = null;
  let computedVdot: number | null = null;
  const originalProfile = profile; // preserve for crosstraining merge in persistence
  if (trigger === "user_message") {
    // Collect all user messages since the last assistant reply — the debounce can batch
    // multiple messages from the same send burst into one coach/respond call, and we only
    // ever fire coach/respond for the LAST message in a burst (earlier ones are skipped by
    // the debounce check). That means if the user sent "please ignore wrist HR\nI have a
    // chest strap but don't always wear it", only the second message would be extracted if
    // we look at latestMsg alone. Join the whole burst so we capture all stated preferences.
    const lastAssistantIdx = (() => {
      for (let i = recentMessages.length - 1; i >= 0; i--) {
        if (recentMessages[i].role === "assistant") return i;
      }
      return -1;
    })();
    const burstMessages = recentMessages.slice(lastAssistantIdx + 1).filter(m => m.role === "user");
    const latestMsg = burstMessages.length > 0
      ? burstMessages[burstMessages.length - 1]
      : [...recentMessages].reverse().find(m => m.role === "user");
    if (latestMsg) {
      // Join all messages in the burst so multi-part preferences are fully captured
      const extractionInput = burstMessages.length > 1
        ? burstMessages.map(m => m.content).join("\n")
        : latestMsg.content;
      pendingExtracted = await extractProfileData(extractionInput, userTimezone);
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

  // For initial_plan: compute whether the athlete can reach an adequate long run in their
  // remaining weeks. If not, Dean needs to acknowledge this and set realistic expectations.
  let racePreparednessFlag = "";
  if (trigger === "initial_plan") {
    const prep = computeRacePreparedness(
      (profile?.goal as string | null) ?? null,
      avgWeeklyMileage,
      (profile?.race_date as string | null) ?? null,
    );
    if (prep && prep.achievableLongRun < prep.minAdequateLongRun * 0.85) {
      const rpIsMetric = (profile?.preferred_units as string | null) === "metric";
      const rpMi = (miles: number) => rpIsMetric ? `${(miles * 1.60934).toFixed(1)} km` : `${miles.toFixed(1)} mi`;
      const shortfall = Math.round((prep.minAdequateLongRun - prep.achievableLongRun) * 10) / 10;
      const goalLabel = ((profile?.goal as string | null) ?? "this race").replace(/_/g, " ");
      racePreparednessFlag = `\n<rule>RACE PREPAREDNESS GAP — READ THIS BEFORE WRITING THE PLAN:
This athlete is at ${rpMi(avgWeeklyMileage ?? 0)}. At the maximum safe build rate (10%/week), they can reach an estimated peak long run of ~${rpMi(prep.achievableLongRun)} before race day. The standard guideline for a ${goalLabel} is a ${rpMi(prep.minAdequateLongRun)}+ peak long run. Gap: ~${rpMi(shortfall)}.

The right response is NOT to prescribe a race-day run/walk strategy — that's presumptuous and demoralizing for an experienced runner. Instead:

1. Acknowledge the timeline is tight (one honest sentence). Frame it as a challenge to approach smartly, not a reason to doubt the goal.
2. Recommend run/walk intervals specifically for TRAINING LONG RUNS as a tool to safely extend distance beyond what continuous running allows right now. Example framing: "For the longer efforts, we'll use short walk breaks — run 10 min, walk 1 min — to keep the effort honest and let you go further without breaking down." This is the Galloway approach and it's legitimate training methodology, not a concession.
3. Ask the athlete one question about their preference: whether they've used run/walk training before and are open to it, OR if they'd rather keep runs continuous and shorter (focusing on building pure running base over time). Their answer will shape how Dean structures the long runs.
4. Do NOT tell the athlete how they should run the race — that's their call on race day based on how training goes.
</rule>`;
    }
  }

  const lastCoachMsgForGap = trigger === "user_message"
    ? [...recentMessages].reverse().find(m => m.role === "assistant")
    : null;
  const daysSinceLastCoachMessage = lastCoachMsgForGap?.created_at
    ? Math.round((Date.now() - new Date(lastCoachMsgForGap.created_at).getTime()) / 86400000)
    : null;

  const wantsSpeedWork = !!((user.onboarding_data as Record<string, unknown> | null)?.wants_speed_work);

  // Pre-compute the most recent run reference for user_message trigger.
  // Instead of telling Claude "check the N-days-ago label before saying yesterday"
  // (an advisory rule Claude can ignore), we inject the exact phrase to use and
  // explicitly state what yesterday actually was. This prevents "yesterday" errors
  // for runs that happened 2+ days ago.
  const mostRecentRunRef = (() => {
    if (trigger !== "user_message") return null;
    const RUN_TYPES_REF = new Set(["Run", "TrailRun", "VirtualRun"]);
    const sortedRuns = [...recentActivities]
      .filter(a => RUN_TYPES_REF.has(a.activity_type as string))
      .sort((a, b) => (b.start_date as string).localeCompare(a.start_date as string));
    if (sortedRuns.length === 0) return null;
    const mostRecent = sortedRuns[0];
    const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: userTimezone }).format(new Date());
    const actLocal = new Intl.DateTimeFormat("en-CA", { timeZone: userTimezone }).format(new Date(mostRecent.start_date as string));
    const [ty2, tm2, td2] = todayLocal.split("-").map(Number);
    const [ay, am, ad] = actLocal.split("-").map(Number);
    const daysAgo = Math.round((Date.UTC(ty2, tm2 - 1, td2) - Date.UTC(ay, am - 1, ad)) / 86400000);
    if (daysAgo < 2) return null; // "today" or "yesterday" are correct — no override needed
    const dayName = new Date(actLocal + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long" });
    const yesterdayUTC = Date.UTC(ty2, tm2 - 1, td2 - 1);
    const yesterdayLocal = new Date(yesterdayUTC).toISOString().slice(0, 10);
    const yesterdayDayName = new Date(yesterdayUTC).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const yesterdayHadRun = recentActivities.some(a => {
      const aLocal = new Intl.DateTimeFormat("en-CA", { timeZone: userTimezone }).format(new Date(a.start_date as string));
      return aLocal === yesterdayLocal && RUN_TYPES_REF.has(a.activity_type as string);
    });
    return `<rule>MOST RECENT RUN: ${dayName} (${daysAgo} days ago). Always reference as "${dayName}'s run" — do NOT say "yesterday". Yesterday was ${yesterdayDayName}${yesterdayHadRun ? " (also a run day)" : " (a rest day — no runs)"}.</rule>`;
  })();

  // For initial_plan: pre-compute the remaining training days in the current week so we can
  // inject them explicitly into the user message. This prevents Claude from scheduling runs
  // on non-training days (e.g. picking "tomorrow=Friday" when Friday isn't a training day).
  let initialPlanDaysConstraint: string | null = null;
  if (trigger === "initial_plan") {
    const rawDays = (profile?.training_days as string[] | null) ?? [];
    if (rawDays.length > 0) {
      const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: userTimezone }).format(new Date());
      const [ily, ilm, ild] = localDate.split("-").map(Number);
      const todayJsDow = new Date(Date.UTC(ily, ilm - 1, ild)).getUTCDay(); // 0=Sun, 1=Mon...
      // Use Mon=1 through Sun=7 so Sunday doesn't collide with 0 and appear "before" weekdays
      const WEEK_ORDER: Record<string, number> = {
        monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
      };
      const dayNamesByDow = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const todayName = dayNamesByDow[todayJsDow]!;
      const todayOrder = WEEK_ORDER[todayName] ?? 0;

      let availableDays: string[];
      if (todayJsDow === 0) {
        // Sunday: plan the full upcoming Mon–Sun week — all training days are candidates
        availableDays = rawDays
          .sort((a, b) => (WEEK_ORDER[a.toLowerCase()] ?? 0) - (WEEK_ORDER[b.toLowerCase()] ?? 0))
          .map(d => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase());
      } else {
        // Mid-week: only training days that fall AFTER today (skip today — athlete needs
        // prep time after onboarding; today's workout window is effectively closed)
        availableDays = rawDays
          .filter(d => (WEEK_ORDER[d.toLowerCase()] ?? 0) > todayOrder)
          .sort((a, b) => (WEEK_ORDER[a.toLowerCase()] ?? 0) - (WEEK_ORDER[b.toLowerCase()] ?? 0))
          .map(d => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase());
      }

      // Attach calendar dates to each available day
      const baseDate = new Date(Date.UTC(ily, ilm - 1, ild));
      const daysWithDates = availableDays.map(day => {
        const dayOrder = WEEK_ORDER[day.toLowerCase()] ?? 0;
        const daysAhead = todayJsDow === 0 ? dayOrder : (dayOrder - todayOrder + 7) % 7;
        const dt = new Date(baseDate.getTime() + daysAhead * 24 * 60 * 60 * 1000);
        return `${day} ${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
      });

      if (daysWithDates.length > 0) {
        initialPlanDaysConstraint = `CONFIRMED TRAINING DAYS REMAINING THIS WEEK: ${daysWithDates.join(", ")} — exactly ${daysWithDates.length} session${daysWithDates.length !== 1 ? "s" : ""}. Schedule running sessions ONLY on these days. Do NOT put a run on any other day this week. Do NOT add a session for today (athlete needs time to prepare after onboarding).`;
      } else {
        initialPlanDaysConstraint = `NO TRAINING DAYS REMAIN THIS WEEK after today. Do NOT schedule any sessions this week. Send a brief note telling the athlete their plan starts next week, then show their full week plan starting Monday.`;
      }
    }
  }

  const userMessage = buildUserMessage(trigger, activityData, imageActivity, includeWorkoutCheckin, injuryNotes, userTimezone, hasStrava, weekMileageSoFar, weekRunCount, missedRunCheckin, periodization, storedPlanWeek, storedNextPlanWeek, timezoneConfirmed, storedPlanAllWeeks, dashboardUrl, racePreparednessFlag, (profile?.preferred_units as string | undefined) ?? "imperial", daysSinceLastCoachMessage, wantsSpeedWork, mostRecentRunRef, initialPlanDaysConstraint);

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
    // user_message gets 1000 to handle full plan arc requests
    max_tokens: (trigger === "initial_plan" || trigger === "weekly_recap") ? 800 : trigger === "user_message" ? 1000 : 512,
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
  // web_search_20250305 is a server-side tool: the SDK returns blocks typed as
  // "server_tool_use" (the search request) and "web_search_tool_result" (the result),
  // NOT "tool_use". We must match all three so that pre-search text blocks (Claude's
  // internal reasoning) are correctly discarded.
  const lastToolIdx = response.content.reduce(
    (idx, b, i) => (
      b.type === "tool_use" ||
      b.type === "server_tool_use" ||
      b.type === "web_search_tool_result"
        ? i : idx
    ),
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
  // Also strip any reasoning preamble Claude occasionally outputs before its actual response.
  const wantsRebuild = /\[REBUILD_PLAN\]/i.test(rawText);
  const strippedRaw = stripReasoningPreamble(
    rawText.replace(/\[NO_REPLY\]/gi, "").replace(/\[REBUILD_PLAN\]/gi, "").trim()
  );
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

  // Detect session mileage that equals the weekly total (copy-paste errors like "Hill reps 33mi")
  const sessionFixed = fixSessionDistanceErrors(volumeChecked);
  // Remove exact duplicate session lines (e.g. same "Thu 3/26 · Easy 2mi" twice)
  const coachMessage = deduplicateSessionLines(sessionFixed);

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

  // For initial_plan, hard-cap at 2 SMS bubbles regardless of how many blank-line
  // separators Claude generated. A 3rd bubble (e.g. strength block detail) overloads
  // the user at a critical moment. Merge any overflow into the 2nd bubble.
  if (trigger === "initial_plan" && parts.length > 2) {
    const merged = parts.slice(1).join("\n\n");
    parts.splice(1, parts.length - 1, merged);
  }

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
    const _ipStart = Date.now();
    console.log("[initial_plan] weekMileageSoFar=", weekMileageSoFar, "recentActivities count=", recentActivities.length, "activityTypes=", recentActivities.slice(0, 10).map(a => `${a.activity_type}(${new Date(a.start_date).toISOString().slice(0,10)})`).join(", "));

    // Parse the prescribed week total from the plan text.
    // Match various formats Dean uses: "Total: ~18mi", "~18 miles this week", etc.
    const prescribedWeek1Match =
      coachMessage.match(/Total[:\s~]+(\d+(?:\.\d+)?)\s*mi/i) ||
      coachMessage.match(/~(\d+(?:\.\d+)?)\s+mi(?:les?)?\s+this\s+week/i) ||
      coachMessage.match(/[Tt]hat'?s\s+~?(\d+(?:\.\d+)?)\s+mi(?:les?)?\s+for\s+the\s+week/i) ||
      coachMessage.match(/(\d+(?:\.\d+)?)\s+mi(?:les?)?\s+(?:total\s+)?for\s+the\s+week/i);
    const prescribedWeek1MilesRaw = prescribedWeek1Match ? parseFloat(prescribedWeek1Match[1]) : null;

    // Compute how many days this initial plan covers so we can:
    //   (a) set weekly_mileage_target to match what was actually prescribed (not a phantom full-week target)
    //   (b) annualize prescribedWeek1Miles for the arc when Strava data isn't available
    // Sunday (dayOfWeek=0): prompt tells Dean to plan the full upcoming Mon–Sun week → 7 days.
    // Any other day: today + days remaining until Sunday.
    const initPlanNow = new Date();
    const initPlanLocalDate = new Intl.DateTimeFormat("en-CA", { timeZone: userTimezone }).format(initPlanNow);
    const [ipY, ipM, ipD] = initPlanLocalDate.split("-").map(Number);
    const initPlanDayOfWeek = new Date(Date.UTC(ipY, ipM - 1, ipD)).getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
    const daysToSunday = initPlanDayOfWeek === 0 ? 0 : 7 - initPlanDayOfWeek;
    const daysInPlan = initPlanDayOfWeek === 0 ? 7 : daysToSunday + 1;
    const isPartialWeek = daysInPlan < 7; // any day other than Mon (7 days) or Sun (7-day upcoming week)

    // weekly_mileage_target stored in training_state: use what was actually prescribed for
    // the days covered. This prevents "0/65mi done" when only a 2-day plan was assigned.
    // For partial weeks, add miles already done this week so the dashboard shows the TRUE
    // weekly total (done + planned), not just the planned sessions. E.g. if a user has run
    // 17mi Mon-Thu and Dean prescribes 19mi for Fri-Sun, the target should display as 36mi.
    // The Sunday recap will reset this to the proper full-week target for next week.
    const weekMileageTarget = isPartialWeek
      ? Math.round(((prescribedWeek1MilesRaw ?? periodization.suggestedWeeklyMiles ?? 0) + weekMileageSoFar) * 2) / 2
      : periodization.suggestedWeeklyMiles;
    console.log("[initial_plan] prescribedWeek1MilesRaw=", prescribedWeek1MilesRaw, "isPartialWeek=", isPartialWeek, "weekMileageSoFar=", weekMileageSoFar, "weekMileageTarget=", weekMileageTarget);

    // Persist week counter, phase, and computed target. Clear taper_peak_miles so the
    // next taper window re-locks the peak from scratch.
    await supabase.from("training_state").update({
      current_week: periodization.effectiveWeek,
      current_phase: periodization.phase,
      taper_peak_miles: null,
      ...(weekMileageTarget != null ? { weekly_mileage_target: weekMileageTarget } : {}),
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
    // Arc base mileage calibration:
    // - If Strava history exists (avgWeeklyMileage != null): always use it — it's an 8-week
    //   real average and is accurate regardless of what day the user onboarded. The
    //   prescribedWeek1Miles covers only the days remaining in the current week (as few as 2),
    //   so it would under-calibrate a high-mileage athlete's entire arc (e.g. Julia at 60mpw
    //   onboarding Saturday → 16mi prescribed → arc built from 16mi base instead of 60mi).
    // - If no Strava (user stated their mileage, which is what Dean worked from): annualize
    //   prescribedWeek1MilesRaw × (7 / daysInPlan) to get the full-week equivalent. This
    //   scales correctly for any onboard day: Sat (×3.5), Wed (×1.4), Mon (×1.0).
    const annualizedWeek1Miles = prescribedWeek1MilesRaw != null
      ? Math.round((prescribedWeek1MilesRaw * 7 / daysInPlan) * 2) / 2
      : null;
    const prescribedWeek1Miles = avgWeeklyMileage
      ? null               // Strava avg is authoritative — don't let partial-week total distort the arc
      : annualizedWeek1Miles; // no Strava: annualized prescribed total is the best estimate

    // Generate and save the full multi-week training arc.
    // skipLinkSms=true — we'll include the dashboard URL inline in the cadence question below
    // so the user gets one closing message instead of two back-to-back.
    const bCRaces = upcomingRaces.filter(r => r.priority === "B" || r.priority === "C") as Array<{ race_date: string; race_name: string | null; priority: string }>;
    // New plan from scratch at the end of onboarding — always start at week 1.
    const _preGenMs = Date.now() - _ipStart;
    console.log(`[initial_plan] ${_preGenMs}ms elapsed before generateAndSaveFullPlan — budget remaining: ~${10000 - _preGenMs}ms`);
    if (_preGenMs > 6000) console.warn(`[initial_plan] ⚠️ already ${_preGenMs}ms in — generateAndSaveFullPlan may exceed 10s Hobby cap`);
    const newDashboardToken = await generateAndSaveFullPlan(userId, user.phone_number as string, profile, avgWeeklyMileage, { skipLinkSms: true, prescribedWeek1Miles: prescribedWeek1Miles ?? undefined, bRaces: bCRaces.length > 0 ? bCRaces : undefined, resetToWeek1: true, wantsSpeedWork });
    console.log(`[initial_plan] generateAndSaveFullPlan done — total elapsed: ${Date.now() - _ipStart}ms`);

    // Fire sync_sessions in a fresh invocation so it doesn't eat into the 10s Hobby budget.
    // It must run AFTER generateAndSaveFullPlan (which clears weekly_plan_sessions) but
    // the plan message is now in the DB, so sync_sessions can read it from conversations.
    after(async () => {
      try {
        const syncBody: Record<string, unknown> = { userId, trigger: "sync_sessions" };
        // Pass partial-week target so syncArcCurrentWeek's session-sum doesn't clobber it.
        if (isPartialWeek && weekMileageTarget != null && weekMileageTarget > 0) {
          syncBody.partialWeekTarget = weekMileageTarget;
        }
        await fetch(`${appUrl}/api/coach/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(syncBody),
        });
      } catch (err) {
        console.error("[coach/respond] sync_sessions trigger failed (initial_plan):", err);
        void trackEvent(userId, "after_error", { trigger: "sync_sessions_initial_plan", error: String(err) });
      }
    });

    // Build the dashboard URL from the token generateAndSaveFullPlan just created/returned.
    const planToken = newDashboardToken ?? dashboardToken;
    const planUrl = planToken ? `${appUrl}/dashboard?token=${planToken}` : null;

    // Just send the dashboard link here — no cadence question yet.
    // We ask about reminders after the user responds to the plan (next inbound SMS or post-run),
    // so they get a chance to react to the plan before we add another question.
    const closingMsg = planUrl
      ? `Your full plan is here: ${planUrl}`
      : null;
    if (closingMsg) {
      if (!dry_run) {
        if (chatId) await startTyping(chatId);
        await new Promise((r) => setTimeout(r, 1500));
        await sendSMS(user.phone_number, closingMsg);
      }
      await supabase.from("conversations").insert({
        user_id: userId,
        role: "assistant",
        content: closingMsg,
        message_type: "initial_plan_link",
      });
    }
  } else if (trigger === "weekly_recap") {
    void trackEvent(userId, "plan_generated", { plan_type: "weekly" });
    // Advance week counter and phase; update mileage target to this week's computed value.
    // Note: syncArcCurrentWeek below will overwrite weekly_mileage_target with the actual
    // session sum — this sets the periodization engine's suggestion as a fallback only.
    await supabase.from("training_state").update({
      current_week: periodization.effectiveWeek,
      current_phase: periodization.phase,
      ...(periodization.suggestedWeeklyMiles != null ? { weekly_mileage_target: periodization.suggestedWeeklyMiles } : {}),
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
    // Fire sync_sessions in a fresh invocation — saves ~3s vs inline Haiku calls.
    after(async () => {
      try {
        await fetch(`${appUrl}/api/coach/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, trigger: "sync_sessions" }),
        });
      } catch (err) {
        console.error("[coach/respond] sync_sessions trigger failed (weekly_recap):", err);
        void trackEvent(userId, "after_error", { trigger: "sync_sessions_weekly_recap", error: String(err) });
      }
    });
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
          user.phone_number,
          pendingExtracted,
          originalProfile,
          (user.onboarding_data as Record<string, unknown>) || {},
          userTimezone,
          hasStrava
        );
      }
      // If Dean committed to a full plan rebuild, fire it now that profile is persisted.
      // Skip the per-week patch — the full rebuild supersedes it.
      if (wantsRebuild) {
        after(async () => {
          try {
            const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
            await fetch(`${appUrl}/api/coach/respond`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId, trigger: "rebuild_plan" }),
            });
          } catch (err) {
            console.error("[coach/respond] rebuild_plan trigger failed:", err);
            void trackEvent(userId, "after_error", { trigger: "rebuild_plan_trigger", error: String(err) });
          }
        });
      } else {
        const currentSessions = (state?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }>) ?? [];
        await maybeUpdatePlanSessions(
          userId, currentSessions, latestUserMsg.content, coachMessage,
          storedPlanId, storedPlanAllWeeks, periodization.effectiveWeek,
        );
        if (storedPlanId && storedPlanAllWeeks.length > 0) {
          await maybeUpdateTrainingPlanWeeks(storedPlanId, storedPlanAllWeeks, latestUserMsg.content, coachMessage);
        }
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

  // If the user is still awaiting_cadence (i.e. they haven't answered the reminders question
  // yet — either they just got their initial plan or they replied about the plan without
  // answering cadence), ask it now as a natural follow-up to the post-run response.
  if (trigger === "post_run" && user.onboarding_step === "awaiting_cadence" && !dry_run) {
    const onboardingDataForCadence = (user.onboarding_data as Record<string, unknown>) || {};
    const stravaCity2 = onboardingDataForCadence.strava_city as string | null;
    const stravaState2 = onboardingDataForCadence.strava_state as string | null;
    const stravaLocation2 = stravaCity2
      ? (stravaState2 ? `${stravaCity2}, ${stravaState2}` : stravaCity2)
      : null;
    const timezoneConfirmed2 = !!(onboardingDataForCadence.timezone_confirmed) || !!(user.strava_athlete_id);
    const cadenceQ = stravaLocation2
      ? `One quick thing — would you like reminders about your upcoming workouts the morning of, or the evening before? I have you in ${stravaLocation2} from Strava so I'll get the timing right.`
      : !timezoneConfirmed2
      ? `One quick thing — would you like reminders about your upcoming workouts the morning of, or the evening before? What city are you in so I get the timing right?`
      : `One quick thing — would you like reminders about your upcoming workouts the morning of, or the evening before?`;
    const cadenceChatId = requestChatId ?? learnedChatId ?? (user.linq_chat_id as string | null) ?? null;
    if (cadenceChatId) await startTyping(cadenceChatId);
    await new Promise((r) => setTimeout(r, 1500));
    await sendSMS(user.phone_number, cadenceQ);
    await supabase.from("conversations").insert({
      user_id: userId,
      role: "assistant",
      content: cadenceQ,
      message_type: "post_run",
    });
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
const MONTH_NAME_TO_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function correctMileageTotal(message: string, alreadyCompletedMiles = 0): string {
  // Primary format: "Mon 3/2 · ..." or "Tue 3/10 · ..."
  // Fallback format: "Tuesday, Mar 31: ..." or "Monday, Apr 6 — ..." (Claude sometimes uses this)
  // Capture month/day so we can detect future-week plans.
  const sessionLineRe = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d+)\/(\d+)\s+·\s+(.+)$/gm;
  const fallbackLineRe = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)\s*[:\-–—]\s*(.+)$/gim;

  let plannedMiles = 0;
  let hasSessionList = false;
  let earliestSessionMs = Infinity;
  let m: RegExpExecArray | null;

  const extractSessionMiles = (monthNum: number, dayNum: number, desc: string) => {
    hasSessionList = true;
    const now = new Date();
    const sessionDate = new Date(Date.UTC(now.getUTCFullYear(), monthNum - 1, dayNum));
    if (now.getTime() - sessionDate.getTime() > 180 * 24 * 60 * 60 * 1000) {
      sessionDate.setUTCFullYear(now.getUTCFullYear() + 1);
    }
    if (sessionDate.getTime() < earliestSessionMs) earliestSessionMs = sessionDate.getTime();
    const isCrossTraining = /\b(bike|biking|cycling|swim|swimming|strength|mobility|stretch|yoga|elliptical|cross.train)\b/i.test(desc);
    if (isCrossTraining) return;
    const explicitTotal = desc.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi(?:les?)?\b/i)
      || desc.match(/\((\d+(?:\.\d+)?)\s*mi(?:les?)?(?:\s+total)?\)/i);
    const firstMi = desc.match(/(\d+(?:\.\d+)?)\s*mi(?:les?)?\b/i);
    const miMatch = explicitTotal || firstMi;
    if (miMatch) plannedMiles += parseFloat(miMatch[1]);
  };

  while ((m = sessionLineRe.exec(message)) !== null) {
    extractSessionMiles(parseInt(m[2], 10), parseInt(m[3], 10), m[4]);
  }

  // Also scan fallback format: "Tuesday, Mar 31: 6 mi ..." that Claude sometimes uses
  while ((m = fallbackLineRe.exec(message)) !== null) {
    const monthNum = MONTH_NAME_TO_NUM[m[1].toLowerCase()] ?? 0;
    if (monthNum > 0) extractSessionMiles(monthNum, parseInt(m[2], 10), m[3]);
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
    // Subtract 12h from "now" before computing the current Monday. This handles the common
    // case where a US user engages Sunday evening and the server UTC clock has already rolled
    // over into Monday — without this buffer, planMonday === todayMonday (same week boundary)
    // and the guard fails, causing past-week completed miles to inflate a fresh next-week plan.
    const todayMonday = getUTCMonday(new Date(Date.now() - 12 * 60 * 60 * 1000));
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

/**
 * Strip Claude's internal chain-of-thought reasoning before it reaches the athlete.
 * Claude occasionally outputs a reasoning scratchpad as regular text — either as
 * leading paragraphs or separated from the actual response with a "---" divider.
 * Both patterns are detected and stripped here so no reasoning reaches the SMS layer.
 */
function stripReasoningPreamble(text: string): string {
  // Safety net: strip any <rule>...</rule> blocks that leaked into the output.
  // The system prompt uses <rule> XML tags for all coaching directives — Claude should
  // never echo these, but if it does, remove them entirely.
  let cleaned = text.replace(/<rule>[\s\S]*?<\/rule>/gi, "").trim();
  if (!cleaned) return text; // if we stripped everything, return original (something went wrong)
  text = cleaned;

  // Pattern 1: "RESPONSE:" separator — Claude sometimes outputs analysis then "RESPONSE:\n".
  // Only take what follows the last "RESPONSE:" label.
  const responseLabelMatch = text.match(/^RESPONSE:\s*/im);
  if (responseLabelMatch && responseLabelMatch.index !== undefined) {
    const afterLabel = text.slice(responseLabelMatch.index + responseLabelMatch[0].length).trim();
    if (afterLabel) return afterLabel;
  }

  // Pattern 2: preamble + "---" separator + actual response.
  // Strip the preamble if it reads like internal reasoning (not a coaching message).
  const sepIdx = text.indexOf("\n---\n");
  if (sepIdx !== -1) {
    const preamble = text.slice(0, sepIdx);
    const reasoningMarkers = [
      /^⚠️/,  // Claude might still use ⚠️ from training data despite instructions
      /^<rule>/i,  // echoed rule tag
      /^The athlete is (asking|looking|trying|requesting|wondering)/im,
      /^I should (keep|answer|respond|address|be|make)/im,
      /^Key considerations:/im,
      /^This is a (training|general|coaching|question|philosophy)/im,
      /^(Let me|I'll|I need to) (think|answer|address|keep|make|write)/im,
      /^Based on (the|this|their|what the athlete)/im,
    ];
    if (reasoningMarkers.some(p => p.test(preamble.trim()))) {
      return text.slice(sepIdx + 5).trim(); // 5 = "\n---\n".length
    }
  }

  // Pattern 3: leading paragraph(s) that look like reasoning scratchpad.
  // Strip ⚠️ blocks (Claude may still use from training data) and common reasoning openers.
  const reasoningStartPatterns = [
    /^⚠️/,
    /^<rule>/i,
    /^The athlete is (asking|looking|trying|requesting|wondering)/i,
    /^I should (keep|answer|respond|address|be|make)/i,
    /^Key considerations:/i,
    /^This is a (training|general|coaching|question|philosophy)/i,
  ];
  const paragraphs = text.split(/\n{2,}/);
  let firstCoachingPara = 0;
  while (
    firstCoachingPara < paragraphs.length - 1 &&
    reasoningStartPatterns.some(p => p.test(paragraphs[firstCoachingPara].trim()))
  ) {
    firstCoachingPara++;
  }
  if (firstCoachingPara > 0) {
    return paragraphs.slice(firstCoachingPara).join("\n\n").trim();
  }

  return text;
}

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

  // Recent long effort: any run ≥ 10 miles or ≥ 75 min in the last 14 days
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const hasRecentLongEffort = activities.some(a => {
    if (!runTypes.has(a.activity_type)) return false;
    if (new Date(a.start_date) < cutoff) return false;
    const miles = (a.distance_meters || 0) / 1609.34;
    const minutes = (a.moving_time_seconds || 0) / 60;
    return miles >= 10 || minutes >= 75;
  });

  // Days until race
  let daysUntilRace: number | null = null;
  if (raceDate) {
    const race = new Date(raceDate + "T00:00:00");
    const days = Math.ceil((race.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (days >= 0) daysUntilRace = days;
  }

  return { avgCadenceSpm, weekOverWeekRampPct, hasRecentLongEffort, daysUntilRace };
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
      const nowForLabels = new Date();
      const todayLocalStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(nowForLabels);
      for (const a of filteredRecent) {
        const d = new Date(a.start_date);
        const dateLabel = d.toLocaleDateString("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
        // Compute a server-side relative label so Claude doesn't need to infer recency.
        const activityLocalStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d);
        const [ty2, tm2, td2] = todayLocalStr.split("-").map(Number);
        const [ay, am, ad] = activityLocalStr.split("-").map(Number);
        const todayMs = Date.UTC(ty2, tm2 - 1, td2);
        const actMs = Date.UTC(ay, am - 1, ad);
        const daysAgo = Math.round((todayMs - actMs) / 86_400_000);
        const relativeLabel = daysAgo === 0 ? " (today)" : daysAgo === 1 ? " (yesterday)" : daysAgo <= 13 ? ` (${daysAgo} days ago)` : "";
        const isRun = RUN_TYPES.has(a.activity_type);
        // Non-run activities (rides, swims, etc.) show duration, not miles, to prevent
        // Claude from accidentally summing cross-training distance as running mileage.
        const milesOrDuration = isRun && a.distance_meters
          ? `${(a.distance_meters / 1609.34).toFixed(1)}mi`
          : a.moving_time_seconds
          ? `${Math.round(a.moving_time_seconds / 60)}min`
          : null;
        const parts = [
          a.activity_type || "Workout",
          milesOrDuration,
          isRun && a.average_pace ? `@ ${a.average_pace}` : null,
          a.elevation_gain ? `${Math.round(a.elevation_gain * 3.28084)}ft vert` : null,
        ].filter(Boolean);
        summary += `  ${dateLabel}${relativeLabel}: ${parts.join(", ")}\n`;
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
    const pctStr = `+${Math.round(signals.weekOverWeekRampPct)}%`;
    if (signals.weekOverWeekRampPct > 100) {
      lines.push(`<rule>EXTREME MILEAGE JUMP: Current week is ${pctStr} above last completed week. This is a very large spike — well above safe training build rates. Do NOT describe it as "right on track," "solid," or normalize it without comment. Before discussing workouts, explicitly check in with the athlete: "That's a big jump from last week — how's your body feeling with the increased load?" Flag the jump matter-of-factly and gauge their response before recommending more volume. Bones and tendons adapt much slower than the cardiovascular system.</rule>`);
    } else {
      lines.push(`- Mileage ramp: current week is ${pctStr} above last completed week (above the 10% guideline). This compares the current week's mileage so far vs the prior full week — not the week before that. Mention this naturally in post-run feedback or the weekly recap — bones and tendons adapt slower than cardiovascular fitness, so big jumps are where overuse injuries originate. Keep the tone matter-of-fact, not alarming.`);
    }
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
    max_tokens: 500,
    system: `Extract the list of planned training sessions from this coaching message and call save_plan_sessions.
If a session starts with "(Optional)" or "Optional:", set "optional": true and strip that prefix from the label.
If no session list is found, call save_plan_sessions with an empty sessions array.`,
    messages: [{ role: "user", content: planText }],
    tools: [{
      name: "save_plan_sessions",
      description: "Save the extracted training sessions from the plan message.",
      input_schema: {
        type: "object" as const,
        properties: {
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                day: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
                date: { type: "string", description: "M/D format, e.g. 3/10" },
                label: { type: "string", description: "Session description, e.g. Easy 6.5mi" },
                optional: { type: "boolean" },
              },
              required: ["day", "date", "label", "optional"],
            },
          },
        },
        required: ["sessions"],
      },
    }],
    tool_choice: { type: "tool" as const, name: "save_plan_sessions" },
  });

  const toolBlock = response.content.find(b => b.type === "tool_use" && b.name === "save_plan_sessions");
  let sessions: Array<{ day: string; date: string; label: string; optional?: boolean }> = [];
  if (toolBlock && toolBlock.type === "tool_use") {
    const input = toolBlock.input as { sessions?: unknown };
    if (Array.isArray(input.sessions)) sessions = input.sessions as typeof sessions;
  }

  // Sanitize cross-training labels with incorrect units or suspiciously short durations.
  const CROSS_TRAINING_KEYWORDS = /\b(strength|mobility|stretch|yoga|bike|biking|cycling|swim|swimming|elliptical|cross.train|zwift|spin)\b/i;
  sessions = sessions.map(s => {
    if (!CROSS_TRAINING_KEYWORDS.test(s.label)) return s;
    let label = s.label;
    // Fix 1: "X mi" on a cross-training session → "X min" (e.g. "3.5 mi" → "4 min", then fix 2 below)
    // e.g. "Strength + mobility 3.5 mi" → "Strength + mobility 4 min"
    label = label.replace(/(\d+(?:\.\d+)?)\s*mi(?!\w)/gi, (_, num) => {
      const mins = Math.round(parseFloat(num));
      return `${mins} min`;
    });
    // Fix 2: suspiciously short decimal durations (< 5 min) like "3.5min" or "3.5 min" are almost
    // certainly a mis-extracted "35 min" where the Haiku extractor dropped a digit.
    // e.g. "Strength + mobility 3.5min" → "Strength + mobility 35 min"
    label = label.replace(/(\d+\.\d+)\s*min\b/gi, (match, num) => {
      const val = parseFloat(num);
      if (val < 5) return `${Math.round(val * 10)} min`;
      return match;
    });
    return { ...s, label };
  });

  await supabase
    .from("training_state")
    .update({ weekly_plan_sessions: sessions as unknown as Json })
    .eq("user_id", userId);
}

/**
 * After extractAndStorePlanSessions runs, sync the training arc's current week entry
 * so the dashboard shows what Dean actually prescribed — not what the Haiku arc
 * generator guessed during plan creation.
 *
 * Updates three fields on the current week row in training_plans.weeks:
 *   - mileage_target  → sum of miles from stored sessions
 *   - key_workout     → label of the quality session (or long run)
 *   - notes           → Haiku-generated note based on actual sessions
 *
 * Non-fatal: failures are logged and the arc is left as-is.
 */
async function syncArcCurrentWeek(
  userId: string,
  currentWeekNum: number,
  phase: string,
  goal: string,
  athleteName?: string | null,
): Promise<void> {
  try {
    // Fetch the sessions that were just stored
    const { data: stateRow } = await supabase
      .from("training_state")
      .select("weekly_plan_sessions")
      .eq("user_id", userId)
      .single();

    const sessions = (stateRow?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }> | null) ?? [];
    if (sessions.length === 0) return;

    // Compute actual mileage from session labels.
    // For run/walk interval sessions (time-based, e.g. "Run 2 min, walk 2 min × 6 (~24 min total)")
    // that don't include explicit miles, estimate from total minutes at ~13 min/mile as a fallback.
    function parseMilesFromLabel(label: string): number {
      const m = label.match(/(\d+(?:\.\d+)?)\s*mi(?!\w)/i);
      if (m) return parseFloat(m[1]!);
      // Fallback: time-based run/walk session → estimate at ~13 min/mile
      if (/\b(run|walk)\b/i.test(label)) {
        const totalMinMatch = label.match(/~?(\d+)\s*min(?:\s+total)?[)]/i);
        if (totalMinMatch) return Math.round(parseInt(totalMinMatch[1]) / 13 * 10) / 10;
      }
      return 0;
    }
    const actualMiles = Math.round(sessions.reduce((sum, s) => sum + parseMilesFromLabel(s.label), 0) * 2) / 2;

    // Detect the key quality session (intervals, tempo, etc.) and the long run
    function isQualitySession(label: string): boolean {
      const l = label.toLowerCase();
      return l.includes("tempo") || l.includes("interval") || l.includes("repeat") ||
        l.includes("threshold") || l.includes("fartlek") || l.includes("vo2") ||
        l.includes("hill") || l.includes("stride") || l.includes("progression");
    }
    const qualitySession = sessions.find(s => isQualitySession(s.label));
    // Identify the long run: prefer explicit "long" keyword, fall back to the
    // highest-mileage running session (Dean sometimes omits "Long run" and just
    // writes "Easy 11mi" for the Saturday session).
    const CROSS_TRAINING_RE = /\b(strength|mobility|stretch|yoga|bike|biking|cycling|swim|swimming|elliptical|cross.train|zwift|spin)\b/i;
    const longRunByLabel = sessions.find(s => s.label.toLowerCase().includes("long"));
    const longRunByMileage = sessions
      .filter(s => !CROSS_TRAINING_RE.test(s.label))
      .reduce<{ day: string; date: string; label: string } | null>((best, s) =>
        parseMilesFromLabel(s.label) > parseMilesFromLabel(best?.label ?? "") ? s : best
      , null);
    const longRunSession = longRunByLabel ?? longRunByMileage;
    const longRunMiles = longRunSession ? parseMilesFromLabel(longRunSession.label) : 0;
    const keySession = qualitySession ?? longRunSession ?? sessions[0];
    let derivedKeyWorkout = keySession?.label ?? "";
    if (derivedKeyWorkout.length > 80) derivedKeyWorkout = derivedKeyWorkout.slice(0, 77) + "...";

    // Generate notes using actual sessions so the dashboard reflects what Dean prescribed
    let derivedNotes = "";
    try {
      const sessionList = sessions.map(s => `${s.day}: ${s.label}`).join("; ");
      const notesResp = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 180,
        system: `Write a 2-sentence coach's note for an athlete's training week dashboard. Phase: ${phase}. Goal: ${goal || "general running fitness"}.
First sentence: this week's purpose and why it matters. Second sentence: one brief execution tip for the key session — what to focus on during that workout.
If the session list includes jargon (strides, tempo, intervals), use plain language to describe the effort level in that second sentence.
Do not use the athlete's name. Be direct and practical. No filler. Return ONLY the note text.`,
        messages: [{ role: "user", content: `Sessions: ${sessionList}\nTotal: ~${actualMiles}mi` }],
      });
      derivedNotes = notesResp.content[0].type === "text" ? notesResp.content[0].text.trim() : "";
    } catch (err) {
      console.error("[syncArcCurrentWeek] notes generation failed (non-fatal):", err);
    }

    // Fetch the latest plan for this user and patch the current week
    const { data: planRow } = await supabase
      .from("training_plans")
      .select("id, weeks")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!planRow) return;

    const planWeeks = (planRow.weeks as Array<{ week_number: number; phase: string; mileage_target: number; long_run_target: number; key_workout: string; notes: string }>) ?? [];
    const updatedWeeks = planWeeks.map(w =>
      w.week_number === currentWeekNum
        ? {
            ...w,
            ...(actualMiles > 0 ? { mileage_target: actualMiles } : {}),
            ...(longRunMiles > 0 ? { long_run_target: longRunMiles } : {}),
            ...(derivedKeyWorkout ? { key_workout: derivedKeyWorkout } : {}),
            ...(derivedNotes ? { notes: derivedNotes } : {}),
          }
        : w
    );

    await supabase
      .from("training_plans")
      .update({ weeks: updatedWeeks as unknown as Json, updated_at: new Date().toISOString() })
      .eq("id", planRow.id as string);

    // Also sync training_state.weekly_mileage_target to match what Dean actually prescribed
    // (the value set during weekly_recap is the periodization engine's suggestion, which may
    // differ from what Claude prescribed after adjusting for the athlete's specific week).
    if (actualMiles > 0) {
      await supabase
        .from("training_state")
        .update({ weekly_mileage_target: actualMiles })
        .eq("user_id", userId);
    }

    console.log(`[syncArcCurrentWeek] synced week ${currentWeekNum}: ${actualMiles}mi, key="${derivedKeyWorkout.slice(0, 50)}"`);
  } catch (err) {
    console.error("[syncArcCurrentWeek] failed (non-fatal):", err);
  }
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
  coachResponse: string,
  planId: string | null = null,
  planAllWeeks: Array<{ week_number: number; phase: string; mileage_target: number; long_run_target: number; key_workout: string; notes: string }> = [],
  currentWeekNum: number = 1,
): Promise<void> {
  if (currentSessions.length === 0) return; // no plan stored yet — nothing to update

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: `You are checking whether a conversation exchange changed any planned training sessions for the week.

Current planned sessions (JSON):
${JSON.stringify(currentSessions)}

The athlete sent a message and the coach responded. Determine if any sessions were changed (different day, different distance, cancelled, added, or replaced).

If NO changes were made, return exactly: {"changed": false}
If changes WERE made, return the full updated sessions list AND the new key workout for the plan arc:
{"changed": true, "sessions": [{"day": "Mon"|"Tue"|..., "date": "M/D", "label": "..."}], "key_workout": "brief label for the defining quality session this week, e.g. '6×800m @ 5K pace' or '4mi tempo'. Null if no quality session was added or changed."}

Rules:
- Mark changed=true if the coach agreed to a session change — explicit past-tense ("Done — moved strength to Sunday", "I've moved...", "Switched...") OR explicit future-tense confirmation ("Moving strength to Sunday", "I'll put the easy 3mi on Tuesday instead", "Sure — strength goes to Sunday"). Do NOT require "I've updated" specifically.
- Mark changed=false if the coach only gave general advice, asked a clarifying question, or suggested a change without agreeing to it.
- For day swaps: update BOTH the "day" field AND the "date" field. The date for each session should match the calendar date of its new day. Infer dates from the existing sessions (e.g. if Mon is "4/7" and Tue is "4/8", Sun would be "4/13").
- Preserve all unchanged sessions exactly as-is
- If a session was cancelled with no replacement, omit it from the list
- key_workout: pick the most quality-focused session that changed (intervals, tempo, race-specific work). If only easy runs changed, set to null.
- Return ONLY valid JSON, no other text`,
    messages: [{ role: "user", content: `Athlete: ${userMessage}\n\nCoach: ${coachResponse}` }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    if (!parsed.changed || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) return;

    await supabase
      .from("training_state")
      .update({ weekly_plan_sessions: parsed.sessions as unknown as Json })
      .eq("user_id", userId);

    // If a quality session changed and we have the arc, patch the current week's key_workout
    // so the dashboard reflects what Dean actually agreed to.
    if (planId && planAllWeeks.length > 0 && parsed.key_workout) {
      const updatedWeeks = planAllWeeks.map(w =>
        w.week_number === currentWeekNum ? { ...w, key_workout: parsed.key_workout as string } : w
      );
      await supabase
        .from("training_plans")
        .update({ weeks: updatedWeeks as unknown as Json, updated_at: new Date().toISOString() })
        .eq("id", planId);
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
  const adjustmentKeywords = /\b(sick|ill|illness|injury|injured|hurt|travel|traveling|travelling|busy|adjust|update.*plan|change.*plan|drop.*week|recovery week|rest week|modified|lighter week|easy week|more interval|add interval|more tempo|add tempo|more hill|add hill|more strength|add strength|switch.*workout|change.*workout|different workout|more quality|harder week)\b/i;
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
  // Unit helpers — available throughout buildSystemPrompt
  const spUseMetric = profile?.preferred_units === "metric";
  const spMi = (miles: number) => spUseMetric ? `${(miles * 1.60934).toFixed(1)} km` : `${miles.toFixed(1)} mi`;
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

  const ALL_WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const restDays = profile?.training_days && (profile.training_days as string[]).length > 0
    ? ALL_WEEK_DAYS
        .filter(d => !(profile!.training_days as string[]).map((x: string) => x.toLowerCase()).includes(d))
        .map(d => d.charAt(0).toUpperCase() + d.slice(1))
    : [];

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
  const yesterdayStr = dayFormatter.format(new Date(Date.UTC(ty, tm - 1, td - 1)));

  // Pre-compute days until the profile race date. Used in both dateContext and the
  // ATHLETE header section so we can gate both on the race being in the future.
  const profileRaceDate = profile?.race_date ? new Date((profile.race_date as string) + "T00:00:00") : null;
  const profileRaceDaysUntil = profileRaceDate ? Math.ceil((profileRaceDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) : null;

  let dateContext = `DATE CONTEXT:\n- Today: ${todayStr}\n- Yesterday: ${yesterdayStr}\n- Tomorrow: ${tomorrowStr}\n- Next 7 days: ${upcomingDays.join(" | ")}\n- Timezone: ${tz}\n- For future scheduled sessions, use specific calendar dates (e.g. "Friday, Feb 27") rather than vague relative terms like "tomorrow" or "next Monday" — messages may be read after the day they're sent.\n- When referencing past activities or events: ONLY say "yesterday" if the event's date or conversation timestamp matches Yesterday above. If it was any earlier, use the weekday name instead ("Monday's double header", "last week's long run"). Recent workouts in the system prompt now include a server-computed label like "(yesterday)" or "(3 days ago)" — use those labels as the authoritative recency signal, not your own inference.\n`;
  if (profile?.race_date && profileRaceDaysUntil !== null && profileRaceDaysUntil > 0) {
    const daysUntil = profileRaceDaysUntil;
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
      // w1Pct = race week training miles only (pre-race), intentionally low.
      // The race itself adds a major distance on top (e.g. marathon +26.2mi).
      let w3Pct = 0.88, w2Pct = 0.72, w1Pct = 0.25;
      if (isUltra)    { w3Pct = 0.78; w2Pct = 0.62; w1Pct = 0.25; }
      else if (isMarathon || is30k) { w3Pct = 0.88; w2Pct = 0.72; w1Pct = 0.25; }
      else if (isHalf)     { w3Pct = 0.90; w2Pct = 0.75; w1Pct = 0.28; }
      else               { w3Pct = 0.90; w2Pct = 0.78; w1Pct = 0.35; } // 5K/10K

      const w3 = Math.round(peak * w3Pct);
      const w2 = Math.round(peak * w2Pct);
      const w1 = Math.round(peak * w1Pct);

      if (daysUntil > 14) {
        dateContext += `- TAPER PROTOCOL (rules-based — follow exactly): Peak volume ~${spMi(peak)}. This week (3 weeks out): ${spMi(w3)} total. Next week (2 weeks out): ${spMi(w2)} total. Race week: ${spMi(w1)} total. No quality sessions in race week — easy miles only. One short race-pace tune-up (${spMi(2.5)} @ goal pace) allowed 10-12 days out.\n`;
      } else if (daysUntil > 7) {
        dateContext += `- TAPER PROTOCOL (rules-based — follow exactly): Peak volume ~${spMi(peak)}. This week (2 weeks out): ${spMi(w2)} total. Race week: ${spMi(w1)} total. No quality sessions in race week — easy miles only. One short race-pace tune-up (${spMi(2.5)} @ goal pace) is acceptable this week.\n`;
      } else {
        dateContext += `- TAPER PROTOCOL (rules-based — follow exactly): Peak volume ~${spMi(peak)}. Race week: ${spMi(w1)} total. Easy miles only — no hard workouts. Shakeout run (15-30 min easy) the day before is optional.\n`;
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

  // Post-race recovery context: inject when the athlete's goal race has passed within the
  // last 6 weeks. Tells Dean the race is done, gives recovery guidance, and opens the door
  // to next-goal conversation — without requiring any new trigger or flow.
  if (profileRaceDaysUntil !== null && profileRaceDaysUntil <= 0 && profileRaceDaysUntil >= -42) {
    const daysSinceRace = Math.abs(profileRaceDaysUntil);
    const onboardingDataForRace = (user.onboarding_data as Record<string, unknown>) || {};
    const raceNameForContext = (onboardingDataForRace.race_name as string | null) ?? (profile?.goal ? formatGoalLabel(profile.goal as string) : "their goal race");
    let recoveryGuidance: string;
    if (daysSinceRace <= 7) {
      recoveryGuidance = `Week 1 post-race: easy running only. No tempo, intervals, or quality sessions. Keep efforts short and comfortable — this is active recovery, not training. Celebrate what they accomplished.`;
    } else if (daysSinceRace <= 14) {
      recoveryGuidance = `Week 2 post-race: reduced volume (roughly 60–70% of normal). Easy running is fine. One light quality session (strides or very short tempo) is okay if they feel good, but don't push it.`;
    } else {
      recoveryGuidance = `Weeks 3–6 post-race: fairly normal training. Rebuild toward their usual volume and reintroduce quality sessions. Follow their lead on how they're feeling.`;
    }
    dateContext += `
POST-RACE CONTEXT:
This athlete completed their goal race — ${raceNameForContext} on ${profile!.race_date} (${daysSinceRace} day${daysSinceRace === 1 ? "" : "s"} ago). The training plan they built with you led them to this race.
${recoveryGuidance}
Next goal: At the right moment, ask what's next — a new race, a fitness goal, or just maintaining. Don't force it; let the athlete bring it up or ask once naturally when they seem ready (typically week 2–3 post-race). When they share a new goal, handle it conversationally — update the plan from there without needing a full re-onboarding.
Do NOT reference the completed race as an upcoming event. Do NOT suggest taper, race-week, or race-prep protocols. The race is done.\n`;
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
      // Sanity check: pace > 15 min/mi is not a running pace — the goal time was likely
      // set for a different race distance (e.g. marathon time stored against a half).
      if (paceMinsPerMile > 15) {
        goalPaceStr = ` — <rule>GOAL TIME MISMATCH: stored goal time ${Math.floor(goalTimeMinutes / 60)}:${String(Math.round(goalTimeMinutes % 60)).padStart(2, "0")} implies ${fmtPace(paceMinsPerMile, "mi")} pace for this race, which is not a running pace. The stored time was likely set for a different distance. Ask the athlete to clarify their goal time for this specific race before building the plan.</rule>`;
      } else {
        goalPaceStr = ` — goal pace: ${fmtPace(paceMinsPerMile, "mi")} (${fmtPace(pacePerKm, "km")})`;
      }
    }
  }
  // Additional athlete preferences captured during onboarding (strengthening, cross-training
  // requests, injury prevention goals, race history notes, etc.)
  const otherNotes = onboardingData.other_notes as string | null;
  const secondaryGoal = onboardingData.secondary_goal as string | null;
  const crosstrainingTools = (profile?.crosstraining_tools as string[] | null)?.filter(Boolean);

  // Detect and enforce time-constrained training days (e.g. "Tuesday and Thursday limited to 60 minutes")
  let timeConstraintBlock = "";
  if (otherNotes) {
    const timeMatch = otherNotes.match(/(\w+day)\s+and\s+(\w+day)\s+are\s+limited\s+to\s+(\d+)\s+minutes?/i);
    if (timeMatch) {
      const [, day1, day2, timeMins] = timeMatch;
      const easyPaceRaw = profile?.current_easy_pace as string | null;
      const paceMatch = easyPaceRaw?.match(/(\d+):(\d+)/);
      if (paceMatch) {
        const paceSeconds = parseInt(paceMatch[1]) * 60 + parseInt(paceMatch[2]);
        const maxMiles = (parseInt(timeMins) * 60 / paceSeconds).toFixed(1);
        timeConstraintBlock = `\n<rule>TIME CONSTRAINT — HARD CAP: ${day1} and ${day2} sessions are strictly limited to ${timeMins} minutes. At this athlete's easy pace (${easyPaceRaw}), that is a maximum of ~${maxMiles} miles. NEVER prescribe more than ${maxMiles} miles on ${day1} or ${day2} — in any week, including peak week.</rule>`;
      }
    }
  }

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
  // Only show the ATHLETE/GOAL header and race date references when the race is in the future.
  // If the race has already passed, profile.race_date is stale — don't tell Claude the athlete
  // is still training for a race that occurred days ago.
  const raceIsUpcoming = profileRaceDaysUntil !== null && profileRaceDaysUntil > 0;

  // ─── Pre-compute training state values (used in both FACTS block and training state section) ───
  const tsUseMetric = spUseMetric;
  const tsMi = spMi;
  const tsTargetMiles = (state?.weekly_mileage_target as number) || 0;
  const tsFormatPace = (paceStr: string | null | undefined): string => {
    if (!paceStr) return "TBD";
    if (!tsUseMetric) return paceStr;
    const match = paceStr.match(/(\d+):(\d+)/);
    if (!match) return paceStr;
    const totalSec = parseInt(match[1]) * 60 + parseInt(match[2]);
    const kmSec = Math.round(totalSec / 1.60934);
    const min = Math.floor(kmSec / 60);
    const sec = kmSec % 60;
    return `${min}:${String(sec).padStart(2, "0")}/km`;
  };
  const tsEasyPaceRaw = profile?.current_easy_pace as string | null;

  // Parse easy pace to seconds for sanity-checking derived paces.
  const tsEasySec = (() => {
    if (!tsEasyPaceRaw) return null;
    const m = tsEasyPaceRaw.match(/(\d+):(\d+)/);
    return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
  })();
  // Sanity-check stored tempo/interval paces. A valid tempo must be:
  //   - at least 30s/mi faster than easy pace, AND
  //   - faster than 13:00/mi (absolute floor — anything slower is walking, not tempo)
  // If either fails, the stored paces are corrupt (likely a km/mi confusion at intake)
  // and we should NOT let Claude use them in prescriptions.
  const TEMPO_FLOOR_SEC = 13 * 60; // 13:00/mi
  const getRawPaceSec = (paceStr: string | null): number | null => {
    if (!paceStr) return null;
    const m = paceStr.match(/(\d+):(\d+)/);
    return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : null;
  };
  const storedTempoPaceRaw = profile?.current_tempo_pace as string | null;
  const tempoSecRaw = getRawPaceSec(storedTempoPaceRaw) ?? getRawPaceSec(estimatePacesFromEasyPace(tsEasyPaceRaw).tempo);
  const pacesAreSane = tempoSecRaw == null || (
    tempoSecRaw < TEMPO_FLOOR_SEC &&
    (tsEasySec == null || tempoSecRaw < tsEasySec - 30)
  );

  const tsTempoPace = (() => {
    if (!pacesAreSane) return "INVALID — paces appear corrupted (tempo ≥ easy or slower than 13:00/mi). Use effort-based language only (e.g. 'comfortably hard', 'easy effort'). Do not prescribe specific paces until the athlete provides a recent race time or easy pace to recalibrate.";
    const stored = profile?.current_tempo_pace as string | null;
    if (stored) return tsFormatPace(stored);
    const est = estimatePacesFromEasyPace(tsEasyPaceRaw);
    return est.tempo ? `${tsFormatPace(est.tempo)} (estimated)` : "TBD";
  })();
  const tsIntervalPace = (() => {
    if (!pacesAreSane) return "INVALID — see tempo note above";
    const stored = profile?.current_interval_pace as string | null;
    if (stored) return tsFormatPace(stored);
    const est = estimatePacesFromEasyPace(tsEasyPaceRaw);
    return est.interval ? `${tsFormatPace(est.interval)} (estimated)` : "TBD";
  })();
  const tsEffectiveWeek = periodization?.effectiveWeek ?? (state?.current_week as number | null) ?? 1;
  const tsPhaseDisplay = (periodization?.phase ?? (state?.current_phase as string | null) ?? "base");
  const tsPhaseLabel = tsPhaseDisplay.charAt(0).toUpperCase() + tsPhaseDisplay.slice(1);
  const tsDeloadBlock = periodization?.isDeloadWeek
    ? `<rule>RECOVERY WEEK — MANDATORY: Week ${tsEffectiveWeek} is a scheduled recovery week (every 4th week). Reduce volume 25–30% from recent average.${periodization.suggestedWeeklyMiles != null ? ` Target: ~${tsMi(periodization.suggestedWeeklyMiles)} this week.` : ""} No new quality sessions — if there's a tempo or interval in the plan, shorten it or replace with an easy run. Same number of runs, shorter distances. Recovery weeks are when adaptation happens — do not skip this.</rule>\n` : "";
  const tsProgressionLine = !periodization?.isDeloadWeek && periodization?.suggestedWeeklyMiles != null && tsPhaseDisplay !== "taper"
    ? `- Progression target this week: ~${tsMi(periodization.suggestedWeeklyMiles)} (~${tsPhaseDisplay === "peak" ? "5%" : "8%"} step up from recent avg)\n`
    : "";
  const tsEasyGuard = tsEasyPaceRaw ? tsFormatPace(tsEasyPaceRaw) : null;
  const tsTempoPaceGuard = (() => {
    if (!pacesAreSane) return null; // guard: suppress invalid paces from plan generation
    const stored = profile?.current_tempo_pace as string | null;
    if (stored) return tsFormatPace(stored);
    const est = estimatePacesFromEasyPace(tsEasyPaceRaw);
    return est.tempo ? tsFormatPace(est.tempo) : null;
  })();
  const { sessionRows, projectedWeekMiles, remainingPlanLine } = (() => {
    const sessions = (state?.weekly_plan_sessions as Array<{ day: string; date: string; label: string }> | null) ?? [];
    if (!sessions || sessions.length === 0) return { sessionRows: "", projectedWeekMiles: weekMileageSoFar, remainingPlanLine: "" };
    const tz2 = timezone || "America/New_York";
    const localTodayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz2 }).format(new Date());
    const [ty, tm, td] = localTodayStr.split("-").map(Number);
    const localTodayUTC = new Date(Date.UTC(ty, tm - 1, td));
    const dayOfWeekToday = localTodayUTC.getUTCDay();
    const daysToSunday = dayOfWeekToday === 0 ? 0 : 7 - dayOfWeekToday;
    const endOfWeekMs = Date.UTC(ty, tm - 1, td + daysToSunday);
    const todaySessions = sessions.filter(s => {
      const [m, d] = s.date.split("/").map(Number);
      if (isNaN(m) || isNaN(d)) return false;
      return new Date(Date.UTC(ty, m - 1, d)).getTime() === localTodayUTC.getTime();
    });
    const futureSessions = sessions.filter(s => {
      const [m, d] = s.date.split("/").map(Number);
      if (isNaN(m) || isNaN(d)) return true;
      return new Date(Date.UTC(ty, m - 1, d)) > localTodayUTC;
    });
    const activeSessions = [...todaySessions, ...futureSessions];
    if (activeSessions.length === 0) return { sessionRows: "", projectedWeekMiles: weekMileageSoFar, remainingPlanLine: "" };
    const parseSessionMiles = (s: { label: string }) => {
      const explicitTotal = s.label.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi(?!n)/i) || s.label.match(/\((\d+(?:\.\d+)?)\s*mi(?!n)(?:\s+total)?\)/i);
      const firstMi = s.label.match(/(\d+(?:\.\d+)?)\s*mi(?!n)/i);
      const mMatch = explicitTotal || firstMi;
      return mMatch ? parseFloat(mMatch[1]) : 0;
    };
    const remainingSessionMiles = futureSessions.reduce((sum, s) => sum + parseSessionMiles(s), 0);
    const todaySessionMiles = trigger !== "post_run" ? todaySessions.reduce((sum, s) => sum + parseSessionMiles(s), 0) : 0;
    const totalRemainingPlanMiles = todaySessionMiles + remainingSessionMiles;
    const targetAlreadyMet = tsTargetMiles > 0 && weekMileageSoFar >= tsTargetMiles;
    let sessionRows = "";
    if (todaySessions.length > 0) {
      const todayList = todaySessions.map(s => `${s.day} ${s.date} · ${s.label}`).join("\n");
      const todayLabel = trigger === "post_run"
        ? `TODAY'S PLANNED SESSION (COMPLETED — already included in week-to-date above; do NOT add this distance again)`
        : `TODAY'S PLANNED SESSION (may already be completed — check conversation history before giving future-tense advice)`;
      sessionRows += `\n- ${todayLabel}:\n${todayList}\n`;
    }
    if (futureSessions.length > 0) {
      if (targetAlreadyMet) {
        const futureList = futureSessions.map(s => `${s.day} ${s.date} · ${s.label}`).join("\n");
        sessionRows += `\n- REMAINING SESSIONS (weekly target already met — these are optional / bonus miles only):\n${futureList}\n`;
      } else {
        const thisWeekFuture = futureSessions.filter(s => {
          const [mm, dd] = s.date.split("/").map(Number);
          if (isNaN(mm) || isNaN(dd)) return true;
          return new Date(Date.UTC(ty, mm - 1, dd)).getTime() <= endOfWeekMs;
        });
        const nextWeekFuture = futureSessions.filter(s => {
          const [mm, dd] = s.date.split("/").map(Number);
          if (isNaN(mm) || isNaN(dd)) return false;
          return new Date(Date.UTC(ty, mm - 1, dd)).getTime() > endOfWeekMs;
        });
        if (thisWeekFuture.length > 0) {
          sessionRows += `\n- UPCOMING SESSIONS THIS WEEK (week ends Sunday):\n${thisWeekFuture.map(s => `${s.day} ${s.date} · ${s.label}`).join("\n")}\n`;
        }
        if (nextWeekFuture.length > 0) {
          sessionRows += `\n- NEXT WEEK'S PLANNED SESSIONS (starts Monday — do NOT count these as part of this week's mileage or day count):\n${nextWeekFuture.map(s => `${s.day} ${s.date} · ${s.label}`).join("\n")}\n`;
        }
      }
    }
    let remainingPlanLine = "";
    if (totalRemainingPlanMiles > 0 && !targetAlreadyMet && trigger !== "post_run") {
      const thisWeekRemaining = [
        ...todaySessions,
        ...futureSessions.filter(s => {
          const [mm, dd] = s.date.split("/").map(Number);
          if (isNaN(mm) || isNaN(dd)) return true;
          return new Date(Date.UTC(ty, mm - 1, dd)).getTime() <= endOfWeekMs;
        }),
      ];
      const breakdown = thisWeekRemaining.map(s => {
        const [m, d] = s.date.split("/").map(Number);
        const isToday = !isNaN(m) && !isNaN(d) && new Date(Date.UTC(ty, m - 1, d)).getTime() === localTodayUTC.getTime();
        return `${isToday ? "today's" : `${s.day} ${s.date}`} ${s.label}`;
      }).join(" + ");
      const projTotal = weekMileageSoFar + totalRemainingPlanMiles;
      remainingPlanLine = `\n- MILES REMAINING IN PLAN THIS WEEK: ${tsMi(totalRemainingPlanMiles)} across ${thisWeekRemaining.length} session${thisWeekRemaining.length !== 1 ? "s" : ""} (${breakdown}) → projected week total: ${tsMi(projTotal)}`;
    }
    return {
      sessionRows,
      projectedWeekMiles: trigger === "post_run"
        ? weekMileageSoFar + remainingSessionMiles
        : weekMileageSoFar + totalRemainingPlanMiles,
      remainingPlanLine,
    };
  })();
  const tsMileageLine = (() => {
    const hasStrava = !!(user.strava_athlete_id as number | null);
    if (!hasStrava && weekMileageSoFar === 0 && weekRunCount === 0) {
      return `not tracked (athlete not on Strava) — refer to RECENT CONVERSATION for what was reported`;
    }
    const done = `${tsMi(weekMileageSoFar)} done so far this week (${weekRunCount} run${weekRunCount !== 1 ? "s" : ""})`;
    if (trigger === "post_run") return `${done} (includes today's synced run — do NOT add it again)`;
    if (projectedWeekMiles !== null && projectedWeekMiles > weekMileageSoFar) {
      return `${done} | Projected week total (done + upcoming sessions): ${tsMi(projectedWeekMiles)}`;
    }
    return done;
  })();

  // ─── FACTS block — pre-computed numbers injected at top of system prompt ───
  const factsBlock = (() => {
    const hasStrava = !!(user.strava_athlete_id as number | null);
    const milogged = hasStrava || weekMileageSoFar > 0
      ? `${tsMi(weekMileageSoFar)} logged (${weekRunCount} run${weekRunCount !== 1 ? "s" : ""})${projectedWeekMiles > weekMileageSoFar ? ` | Projected: ${tsMi(projectedWeekMiles)}` : ""}`
      : "not tracked (no Strava)";
    const easyRange = easyPaceRange(tsEasyPaceRaw, tsUseMetric) || "TBD";
    const raceLine = raceIsUpcoming && profileRaceDaysUntil !== null
      ? `Race: ${goalDisplay} on ${profile!.race_date as string} · ${profileRaceDaysUntil} day${profileRaceDaysUntil !== 1 ? "s" : ""} / ~${Math.round(profileRaceDaysUntil / 7)} week${Math.round(profileRaceDaysUntil / 7) !== 1 ? "s" : ""} out`
      : "";
    const remainingLine = remainingPlanLine
      ? `Miles remaining this week:${remainingPlanLine.replace(/^- MILES REMAINING IN PLAN THIS WEEK:/, "").split("→")[0].trim()} → ${remainingPlanLine.split("→")[1]?.trim() ?? ""}`
      : "";
    const lines = [
      `Today: ${todayStr}`,
      `Training: Week ${tsEffectiveWeek} · ${tsPhaseLabel} phase${periodization?.isDeloadWeek ? " — recovery week" : ""}`,
      `This week: ${milogged}`,
      `Paces: Easy ${easyRange} · Tempo ${tsTempoPace} · Interval ${tsIntervalPace}`,
      ...(raceLine ? [raceLine] : []),
      ...(remainingLine ? [remainingLine] : []),
    ];
    return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FACTS — pre-computed by system. Never recalculate these.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${lines.join("\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  })();

  return `${factsBlock}

${raceIsUpcoming ? `ATHLETE: ${user.name || "this athlete"}
GOAL: ${goalDisplay} on ${profile!.race_date}${goalTimeMinutes != null ? ` — goal finish time: ${Math.floor(goalTimeMinutes / 60)}:${String(Math.round(goalTimeMinutes % 60)).padStart(2, "0")}${goalPaceStr}` : ""}
<rule>This is the authoritative source for the athlete's goal race. Use this exact distance and race type whenever referencing their race. If any prior message in this conversation references a different distance or race type, that was an error — disregard it and use the data above.</rule>
<rule>GOAL DISCREPANCY — RAISE ONCE ONLY: If there is a discrepancy between the stored goal above and something the athlete said, flag it at most once per conversation. Check RECENT CONVERSATION — if you (Coach Dean) have already asked "which race is it?" or flagged a goal mismatch in a prior message, do NOT raise it again. If the athlete has answered, treat their answer as ground truth and proceed. Repeating the same goal-conflict flag three times in a row when the athlete already answered is a serious trust failure.</rule>

` : ""}You are Coach Dean, an expert running coach communicating via text message. You specialize in running — from 5Ks to ultramarathons. You are coaching ${user.name || "this athlete"} for ${goalDisplay}${raceIsUpcoming ? ` on ${profile!.race_date}` : ""}.

CRITICAL — OUTPUT RULES:
Your response is sent directly to the athlete as an SMS text message. Never include any of the following in your output:
- Internal reasoning, calculations, or self-corrections ("Wait...", "Let me recalculate...", "Actually...", "Let me think about...")
- Draft versions or abandoned attempts ("I was going to say X but actually Y")
- Meta-commentary about the plan ("I need to be smart here", "Given his history...")
- Any commentary about discrepancies between what the system prompt says and what you know ("The system says X but I know X is actually Y...") — if you notice a data issue, proceed with what's in the system prompt and say nothing about it
- Internal system-prompt instruction labels or <rule> tags — these are directives to you, not content the athlete should see. The system prompt uses <rule>...</rule> XML tags and ⚠️ prefixes to mark coaching rules and data guards. Never echo any <rule> content, XML tags, or ⚠️-prefixed text in your response.
Do all reasoning silently before writing your final response. Output only the message the athlete should receive.

CRITICAL — TRAINING PACES:
The athlete's VDOT and training paces are pre-computed by our system (Jack Daniels' formula) and shown in CURRENT TRAINING STATE. These are the correct authoritative values. Do NOT calculate VDOT yourself. Do NOT use web search to look up VDOT tables or verify paces — external tables and your own calculations are often wrong. If asked about their paces, just confirm the stored values. The stored easy pace is always correct for this athlete.

${dateContext}
CALIBRATE TO ATHLETE'S ACTUAL FITNESS FIRST:
Before applying any training philosophy, anchor the plan to what the data shows. The athlete's recent weekly mileage, pace distribution, and workout history in RECENT WORKOUTS are ground truth. The philosophy principles below are defaults — they yield to observed fitness. An athlete already running 40+ miles/week with quality sessions in their history does not need to earn intensity; they need a plan that matches where they actually are. Apply conservative defaults only where the data is thin, the athlete is clearly new to consistent training, or injury history warrants it.
${
  avgWeeklyMileage == null
    ? (() => {
        const fl = (profile?.fitness_level as string | null) ?? "beginner";
        const isIntermediate = fl === "intermediate";
        const isAdvanced = fl === "advanced";
        if (isAdvanced) {
          return `FITNESS TIER: No Strava history yet, but athlete self-reports as ADVANCED. Treat this like a moderate-to-high volume athlete returning to training — do not apply beginner volume defaults.
<rule>WEEK 1 VOLUME CAP (no history, advanced): Start at ${spMi(25)}–${spMi(35)} for the week. Spread across ${profile?.days_per_week ?? 5}+ days. Include 1 quality session. Do not prescribe fewer than ${spMi(20)} — that is inconsistent with advanced fitness.</rule>`;
        } else if (isIntermediate) {
          return `FITNESS TIER: No Strava history yet, but athlete self-reports as INTERMEDIATE. Treat as an athlete with an established aerobic base — do not apply beginner volume defaults.
<rule>WEEK 1 VOLUME CAP (no history, intermediate): Start at ${spMi(15)}–${spMi(25)} for the week. Spread across ${profile?.days_per_week ?? 4}+ days. Include at least 1 easy quality session (strides or short tempo). Do not prescribe fewer than ${spMi(12)} — that is inconsistent with intermediate fitness.</rule>`;
        } else {
          return `FITNESS TIER: No activity data yet. Default to a conservative, base-building approach until training history establishes their level.
<rule>WEEK 1 VOLUME CAP (no history, beginner): Since no mileage data exists and this is a beginner, Week 1 must not exceed ${spMi(10)} total. Start extremely conservatively — 3 short sessions of ${spMi(2)}–${spMi(3)} each is appropriate. It is much easier to add volume next week than to walk back an injury in week one.</rule>`;
        }
      })()
    : avgWeeklyMileage < 10
    ? `FITNESS TIER: LOW VOLUME (avg ${spMi(avgWeeklyMileage)}). Prioritize easy aerobic volume and consistency. Include at least 1 quality session per week (strides, a short tempo, or brief intervals) — even low-volume athletes benefit from variety and it keeps training engaging. Calibrate the intensity and duration of quality work to their actual experience level (check all-time Strava mileage) and race goal — a true beginner building their first base needs gentler introductions to quality work than an experienced runner who's simply at low volume right now.
<rule>WEEK 1 VOLUME CAP — HARD LIMIT: This athlete currently runs ~${spMi(avgWeeklyMileage)}. Week 1 MUST NOT exceed ${spMi(Math.max(Math.ceil(avgWeeklyMileage * 1.3), 6))} total (current volume × 1.30, floor ${spMi(6)}). This is non-negotiable — prescribing 2–3× their current volume is a guaranteed injury risk. Do not exceed this cap under any circumstances, regardless of race goals or timelines.</rule>
<rule>LONG RUN CAP — HARD LIMIT: The single longest run in Week 1 must not exceed ${spMi(Math.max(Math.ceil(avgWeeklyMileage * 0.35), 3))} (35% of current weekly volume, floor ${spMi(3)}). A long run that equals or exceeds the athlete's entire weekly baseline is a serious injury risk. State your long run distance, then verify it does not exceed this cap before sending.</rule>`
    : avgWeeklyMileage < 30
    ? `FITNESS TIER: MODERATE VOLUME (avg ${spMi(avgWeeklyMileage)}). This athlete has an established aerobic base. 1–2 quality sessions per week (tempo or interval work) are appropriate and expected alongside easy volume. The 80/20 principle applies — most miles easy, but don't withhold quality work.
<rule>WEEK 1 VOLUME CAP — GUIDELINE: Current avg is ${spMi(avgWeeklyMileage)}. Week 1 should not jump more than 15% above that — target ${spMi(Math.round(avgWeeklyMileage * 1.05))}–${spMi(Math.round(avgWeeklyMileage * 1.15))}. A first-week spike above ${spMi(Math.round(avgWeeklyMileage * 1.2))} risks overuse injury at the start of the plan.</rule>`
    : `FITNESS TIER: HIGH VOLUME (avg ${spMi(avgWeeklyMileage)}). This is an experienced, high-volume runner. Skip base-building preamble — they already have the base. Quality sessions are appropriate from the start. Plan to their current training level, not a conservative floor. Don't apply beginner defaults to an athlete running this kind of volume.
<rule>WEEK 1 VOLUME CAP — GUIDELINE: Even for high-volume runners, Week 1 of a new plan should not spike more than 10–15% above current base. Current avg: ${spMi(avgWeeklyMileage)} → Week 1 target: ${spMi(Math.round(avgWeeklyMileage * 1.05))}–${spMi(Math.round(avgWeeklyMileage * 1.12))}. Don't jump to peak volume on Day 1.</rule>`
}

${!isReminder ? `TRAINING PHILOSOPHY — apply in this priority order, within the context of the fitness tier above:

1. AEROBIC BASE FIRST (Lydiard / Uphill Athlete): For athletes still building their base, don't rush to intensity — build the aerobic engine patiently before adding quality work. For athletes with an established high-volume history, the base is already there; plan accordingly.

2. 80/20 INTENSITY DISTRIBUTION (Fitzgerald / Seiler / Roche): ~80% of all training at genuinely easy, conversational effort. Avoid the moderate "gray zone" — it accumulates fatigue without driving meaningful adaptation. Easy runs are truly easy. Hard days are genuinely hard.

3. VDOT-CALIBRATED PACING (Jack Daniels): Use the stored training paces from CURRENT TRAINING STATE — these are pre-computed from the athlete's race times using Jack Daniels' formula. Never calculate or look up VDOT yourself. Never assign arbitrary paces. Pace zones should reflect the stored values, not aspirational targets.

WHEN PACES ARE TBD (no stored paces, VDOT unknown): If the athlete has recent Strava runs visible in RECENT WORKOUTS, use their typical easy run average pace as an estimated baseline — this is better than refusing to prescribe paces entirely. Derive tempo (~45-60 sec/mi faster than easy) and interval (~75-90 sec/mi faster than easy) from that estimate, and label them clearly as estimates (e.g. "~8:45/mi tempo (estimate)"). When you need better calibration data, ask for a recent race time first — any recent race (5K, 10K, half) gives a clean VDOT calculation without requiring extra effort. Only suggest a 5K time trial if they genuinely have no recent race times; if you do suggest one, also offer "share a recent race time" as an alternative in the same message.

HEART RATE ZONES — use when HR data is available: If HEART RATE appears in the activity summary (e.g. "avg 148 bpm across runs, highest avg 162 bpm"), use these to give richer easy run targets. Easy/Zone 2 effort = roughly 10–20 bpm below their "highest avg" figure (which reflects a moderate-to-hard effort). Append a bpm target in parens on easy run session lines when it adds value — e.g. "Easy 6mi @ 9:30-10:00/mi (~140 bpm)". Only do this when HR data is present in the summary. If no HR data, omit bpm targets entirely.

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
- Training days: ${trainingDays}${profile?.training_days && (profile.training_days as string[]).length > 0 ? `\n- <rule>TRAINING SESSION COUNT — PLAN GENERATION RULE: When building any week plan, include EXACTLY ${(profile.training_days as string[]).length} running session${(profile.training_days as string[]).length !== 1 ? "s" : ""} — never more. No optional, bonus, or supplementary running sessions beyond these days. (This applies to plan generation only — do not volunteer session counts in post-run or conversational responses.)${(profile.training_days as string[]).length <= 3 ? ` With only ${(profile.training_days as string[]).length} training days, structure each week as: 1 long run + 1 quality session (tempo OR intervals — NOT both in the same week) + ${(profile.training_days as string[]).length === 3 ? "1 easy/medium run" : "easy runs"}. Scheduling separate tempo AND interval sessions in the same week requires more days than this athlete has — never do it.` : ""}</rule>` : ""}
${restDays.length > 0 ? `- <rule>REST DAYS — NEVER schedule a run on: ${restDays.join(", ")}. This is a hard constraint — it applies to all weeks including the initial plan and any future-week previews.</rule>\n` : ""}- Goal: ${raceName ? `${raceName}${exactDistanceSuffix}` : (profile?.goal ? formatGoalLabel(profile.goal as string) : "unknown")}${profile?.race_date ? ` on ${profile.race_date}` : ""}${goalTimeMinutes != null ? ` — goal finish time: ${Math.floor(goalTimeMinutes / 60)}:${String(Math.round(goalTimeMinutes % 60)).padStart(2, "0")}${goalPaceStr}` : goalTimeMinutes === null ? " — no specific time goal (completion/fitness focus)" : " — no goal time on file"}
${secondaryGoal ? `- Secondary goal: ${secondaryGoal} (build toward this after the primary race — don't split focus now)\n` : ""}- Injury / constraints: ${profile?.injury_notes || "None reported"}${(() => { const parts = (profile?.injury_body_parts as string[] | null) || []; return parts.length > 0 ? `\n- RECURRING INJURY ALERT: The following body parts have been flagged across multiple sessions: ${parts.join(", ")}. If the athlete mentions any of these areas again, you MUST: (1) acknowledge it as a recurring concern, (2) recommend taking a rest day or reducing intensity, (3) suggest they consult a physical therapist or sports medicine doctor before pushing through. Do not continue with normal coaching mode.` : ""; })()}
- Cross-training available: ${crosstrainingTools && crosstrainingTools.length > 0 ? crosstrainingTools.join(", ") : "None mentioned"}
${otherNotes ? `- Athlete preferences / notes: ${otherNotes}\n` : ""}${timeConstraintBlock ? `${timeConstraintBlock}\n` : ""}${isTri ? `- Swim pace: ${swimPace || "unknown"}\n- Bike: ${bikeInfo || "unknown"}` : ""}

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
(See FACTS block at top for today's date, weekly mileage, paces, and race countdown — those are the authoritative numbers.)
${(() => {
  const useMetric = tsUseMetric;
  const mi = tsMi;
  const targetMiles = tsTargetMiles;
  // Session rows, projectedWeekMiles, remainingPlanLine, and tsMileageLine are all
  // pre-computed before the return statement — use them directly here.
  // (Legacy IIFE removed; values computed once in the ts* pre-computation block above.)
  return `- Week ${tsEffectiveWeek} of training, phase: ${tsPhaseLabel}${periodization?.isDeloadWeek ? " — RECOVERY WEEK" : ""}
${tsDeloadBlock}${tsProgressionLine}- Weekly mileage target (athlete baseline): ${tsTargetMiles ? tsMi(tsTargetMiles) : "TBD"}
<rule>THIS WEEK'S MILEAGE: ${tsMileageLine}.${!!(user.strava_athlete_id as number | null) ? ` The "done so far" figure is the ONLY authoritative source for the athlete's current week mileage — it is computed directly from Strava data and covers Monday through today. NEVER compute or estimate week mileage yourself by adding up individual run mentions from the conversation. NEVER include runs from previous weeks as "carryover" — each week's mileage resets on Monday. If the athlete mentions a run that is not yet reflected here, acknowledge it but do not add it to the week total yourself. Use the "done" figure as-is when discussing current mileage; use the "projected" figure only when discussing the week plan. IMPORTANT: If your own prior messages in this conversation stated a different mileage total, those messages were wrong — do not defend, re-cite, or re-state them. Re-anchor to the authoritative figure in this system prompt immediately. When an athlete corrects you on mileage, agree and state the correct Strava figure without qualification.` : ` Since this athlete is not on Strava, estimate current week mileage from what they have reported in the RECENT CONVERSATION — but only count runs they explicitly placed in the current week (Monday onward). Do not carry forward runs from previous weeks. When referencing the total, frame it as an estimate ("based on what you've told me this week, you're around X miles") — never state it as a precise verified figure.`}</rule>
- Athlete preferred units: ${profile?.preferred_units || "imperial"} — use ${profile?.preferred_units === "metric" ? "km and min/km" : "miles and min/mile"} in all responses
- Athlete VDOT: ${freshVdot != null ? freshVdot : (profile?.current_vdot != null ? profile.current_vdot : "unknown (no race data on file)")}
- Current paces (computed by Jack Daniels' VDOT formula — AUTHORITATIVE; treat as ground truth): Easy ${easyPaceRange(tsEasyPaceRaw, tsUseMetric) || "TBD"}, Tempo ${tsTempoPace}, Interval ${tsIntervalPace}${(() => { const prYear = onboardingData?.pr_year as number | null; if (prYear && (new Date().getFullYear() - prYear) >= 2) { return ` (NOTE: PR data is from ${prYear} — ${new Date().getFullYear() - prYear} years ago. These paces may be conservative if fitness has improved, or too aggressive if there's been a long break. Treat as a starting estimate and adjust based on actual workout performance.)`; } return ""; })()}
- RULE: NEVER recalculate VDOT or training paces yourself. Never use web search to look up VDOT tables or verify paces. The stored paces above are computed by our system using Jack Daniels' formula and are correct. If the athlete asks to verify or questions their paces, simply confirm the stored values directly — no lookups, no calculations.
<rule>PACE SANITY CHECK: Quality paces (tempo, threshold, interval) must be FASTER (lower number) than the athlete's easy pace.${tsEasyGuard ? ` This athlete's easy pace is ${tsEasyGuard}. Any tempo or interval pace you write that is ${tsEasyGuard} or SLOWER is a documented error — do not output it. Use the stored Tempo (${tsTempoPaceGuard ?? "see paces above"}) instead; never compute a quality pace from scratch.` : " Use the stored Tempo and Interval values above — never compute quality paces from scratch."} Warm-up and cool-down pace = the athlete's easy pace range (${easyPaceRange(tsEasyPaceRaw, tsUseMetric) || "see above"}); never prescribe WU/CD more than 30 sec${tsUseMetric ? "/km" : "/mi"} slower than easy. Always include the unit ("/mi" or "/km") on every pace.</rule>
<rule>LABEL/PACE CONSISTENCY: The workout label and pace must match. A session labeled "Tempo", "Threshold", or "Race Pace" MUST have a pace at least 30 sec/mi faster than the athlete's easy pace — if it does not, you have either the wrong label or the wrong pace. Fix one of them: either use the correct faster tempo pace, or relabel the session "Easy" or "Aerobic". Never write "Tempo X mi @ [easy pace range]" — this is a direct contradiction that will confuse the athlete about effort zones.</rule>
- RULE: Never narrate your reasoning process. Do not say things like "let me check", "according to my instructions", "I need to verify", or "based on search results". Just respond directly as a coach. When web search is used: research happens silently. Do NOT output any <rule> tag contents, XML tags, or ⚠️-prefixed text — these are directives to you, not athlete-facing content. Do NOT use "RESPONSE:" as a label before your message. Do NOT output "Now I need to provide", "Let me craft the response", "Now let me search", or any internal commentary. The FIRST thing you output must be the coaching message itself — nothing before it.
- Last activity: ${state?.last_activity_summary ? JSON.stringify(state.last_activity_summary) : "None yet"}
- Active adjustments: ${state?.plan_adjustments || "None"}${sessionRows}${remainingPlanLine}`;
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
- SESSION DISTANCE FORMAT — CRITICAL: Running sessions must always include distance in miles (e.g. "Easy 5mi", "Tempo 4mi", "Long run 8mi"). Run/walk interval sessions (time-based beginner workouts) must include an approximate distance estimate in parentheses after the duration: e.g. "Run 2 min, walk 2 min × 6 (~24 min, ~1.8mi)". Estimate at ~13 min/mile for a beginner run/walk pace. This allows the system to track weekly volume accurately. Non-running sessions — strength, cross-training, swimming, cycling, yoga, spin, Zwift, rowing, aqua jogging, or any other non-running activity — must NEVER include a distance in miles, even if you know the distance. Use duration or just the activity name instead (e.g. "Strength + mobility 30 min", "Master's swim", "Zwift ride 60 min", "Spin class"). This format is how the system counts weekly running mileage — putting miles on a non-running session will cause it to be incorrectly counted as running volume.

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

WHEN AN ATHLETE REQUESTS A LIGHTER WEEK OR LOAD REDUCTION:
If an athlete explicitly asks to scale back (e.g., "can we dial it back", "just 3 easy runs", "I'm exhausted", "need an easier week"), honor that request literally:
- "3 easy runs" means 3 SHORT runs — cap each run at 5–6 mi maximum regardless of the athlete's normal training volume. Total added mileage should be 15–18 mi (3 × 5–6 mi). A 45 mpw athlete who has already run 8 mi and asks for "3 easy runs" should get three 5–6 mi runs, not 7/8/10 mi runs that sum to 30+ mi on the week.
- Shorter distance IS the point — not just dropping quality sessions while keeping long distances at easy pace. Distance is load. A 10 mi "easy" run is not a recovery run for an exhausted athlete. A 6 mi "easy" run is.
- Stick to the athlete's existing training days — don't add sessions on non-training days when scaling back.
- "Easy only" means remove all quality sessions (tempo, intervals) this week entirely — not "a lighter tempo".
- Never push back or suggest they keep a hard session. Life stress is training load. Exhaustion is data. Validate it in one sentence, then give the specific lighter schedule.
- After giving the lighter week, confirm next week returns to normal — one short sentence is enough.

WHEN AN ATHLETE REQUESTS A STRUCTURAL CHANGE (fewer or more training days):
Make a concrete recommendation — don't ask the athlete to decide. Analyze their training days and quality session placement and give them a specific N-day schedule.
- For dropping a day: recommend dropping an easy day, not a quality session or long run. Prefer dropping a day adjacent to the long run (e.g. Monday after Sunday long run) — that's the natural cut. State which day to drop and why (one sentence max), then show the updated day list.
- For adding a day: recommend the day that best fills a gap in the week and fits easy-day recovery. Show the updated schedule.
- Never respond with "it depends, which day do you prefer?" — make the call, they can override if needed.

WHEN AN ATHLETE REQUESTS MORE QUALITY WORK:
If an athlete asks for more speed, intervals, or tempo — add it. Validate their instinct in at most one sentence. Do NOT explain aerobic base theory, caution about overtraining, or lecture about patience unless there is a specific, concrete risk (e.g., they already have 3 quality sessions this week, or they're within 5 days of a race).
- For 5k/10k athletes, 2 quality sessions per week is appropriate even in early plan weeks — "base phase" does not mean zero intensity for athletes with an established aerobic base.
- Add the session with specifics: session type, distance, exact pace from stored VDOT values. Keep the response short — don't explain the physiology, just give the session.
- If the fitness tier says "1–2 quality sessions appropriate", you have full permission to go to 2. Don't artificially limit to 1 when the athlete is asking for more and their profile supports it.

MEMORY AND DATA LIMITATIONS:
- You only have access to: the last 15 conversation messages, the athlete's activity history (visible in RECENT WORKOUTS), their profile, and today's date context. Nothing else.
- You have their Coach Dean start date (shown in ATHLETE HISTORY above) — use it when asked how long they've been training with Dean or when they started. For everything else (what was said in earlier conversations, mileage from before your activity window), you don't have that information.
- If asked about something outside your data window, be honest: "I don't have that far back in our conversation history" is fine. Fabricating a confident answer is not — it destroys trust when the athlete knows you're wrong.
- When in doubt about a historical fact, omit it or flag uncertainty. Never invent specifics.
- <rule>HISTORICAL MILEAGE RULE: When citing a specific prior week's mileage, use ONLY the values shown in "WEEKLY MILEAGE (completed weeks)" above. If a particular week is not in that table, say "I don't have exact data for that week" — never estimate or fabricate a specific number. Inventing a mileage figure (e.g. saying "last week you ran 6.8 miles" when the actual number was 12.8) erodes trust immediately when the athlete knows their own training.</rule>
- <rule>ATHLETE-CONFIRMED IN-CONVERSATION DATA: If an athlete corrects or confirms a specific pace, distance, or training zone during the conversation — that value is ground truth for the rest of this session. Do NOT re-derive or re-interpret it from stored profile values. When generating any plan output (session list, week plan, updated targets), use the most recently athlete-confirmed pace zones (easy, tempo, long run pace), overriding stored defaults. Once a value is confirmed by the athlete, lock it and acknowledge it before moving on — never flip-flop on a data point the athlete has already corrected.</rule>

${isConversational ? `PRODUCT CAPABILITIES — what Coach Dean actually supports:
- Activity tracking: Strava only. If an athlete has connected Strava, their activities sync automatically. No Garmin, Apple Watch, Wahoo, or other platform sync.
- If an athlete asks how to connect Strava, tell them to text "connect strava" and you'll send them the link.
- If an athlete asks how to connect Garmin, Apple Health, or any other service, tell them clearly: "I only have Strava sync right now — just text me after your workouts and I'll track from there."
- Communication: SMS only. Athletes can text "my plan" at any time to receive a link to their full week-by-week training plan dashboard. There is no separate app, calendar export, or email — but the plan link is always available on request. When an athlete asks to see their plan (in any phrasing), either send the link directly if you have it, or tell them to text "my plan" and you'll send it immediately — do NOT say you cannot send it.
- Proactive reminders: three options are supported: (1) morning-of reminders, (2) evening-before reminders, (3) weekly Sunday overview only.
- Morning reminders go out at approximately 6am PT / 7am MT / 8am CT / 9am ET. If an athlete asks what time, give them the appropriate time for their timezone.
- Evening reminders go out at approximately 6pm PT / 7pm MT / 8pm CT / 9pm ET (the evening before the session).
- Specific times beyond these (e.g. "8:30am", "noon", "3pm", "after work") are NOT supported — just morning or evening.
- NEVER promise a reminder at a precise time — say "around 6am" or "evening before", not "at 8am exactly".
- <rule>REMINDER TIME CONSTRAINT: If an athlete requests a specific time that isn't morning or evening (e.g. "3pm", "noon", "lunchtime"), immediately disclose the constraint — do NOT confirm the unsupported time first. Say something like: "I can send reminders around 6am [their timezone] or the evening before — which works better?" Surface the limitation upfront so the athlete can choose. Never confirm a time you cannot support and correct it later.</rule>
- If asked about a feature that doesn't exist (a web dashboard, export, calendar sync, etc.), say you don't have that yet rather than fabricating instructions.
` : ""}

${!isReminder && !isPostRun ? `STRENGTH, MOBILITY & CROSS-TRAINING — include on rest days when appropriate:
- Include a strength/mobility session when the athlete has injury notes, has asked for strength or stretching, or has gym/yoga listed as cross-training. Tailor exercises to their specific injury or needs.
- Include cross-training when they've listed tools (bike, pool, elliptical, yoga, etc.) or asked for it.
- Format in the plan as e.g. "Strength + mobility 20 min" or "Easy bike 45 min" — brief and specific.
- If none of the above apply, do NOT add strength or cross-training unprompted.
- STRENGTH SESSION SPECIFICS: Whenever you include a strength or mobility session, follow the session list with a separate bubble giving 3–5 specific exercises. Default to runner-specific hip stability and glute work (e.g. single-leg deadlifts, hip thrusts, clamshells, Copenhagen plank, lateral band walks). Adjust for any injury notes or stated preferences. Keep this bubble short — under 480 chars. Example: "For the strength block: single-leg deadlifts 3×10, glute bridges 3×15, clamshells 3×20/side, Copenhagen plank 3×20 sec." Never leave a strength session at just "30 min" with no detail — runners won't know what to do with that.
- VOLUME ADJUSTMENT FOR ATHLETES DOING CONSISTENT STRENGTH TRAINING: If an athlete is doing 2+ days/week of strength or gym work alongside running, their total training load is meaningfully higher than a running-only athlete. Reduce peak running volume by 10–15% compared to a comparable running-only athlete at the same base mileage. For example: a runner averaging 32 mi/week who also lifts 2x/week should peak around 42–48mi/week running, not 55+. Strength days count as training load — don't ignore them when projecting the volume arc.
- SCHEDULING AROUND STRENGTH DAYS: Never schedule a hard quality run (tempo, intervals, long run) the day before or the day of a scheduled strength session. Easy runs are fine on strength days. Hard running + hard lifting on the same or adjacent days leads to under-recovery and injury.
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
  this_week_override_days?: string[] | null;
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
- A new or updated target race date (e.g. "I just signed up for Boston on April 21st", "my marathon is October 13th", "late May", "end of June") → race_date as "YYYY-MM-DD". Resolve vague phrases: "early [month]" → first Saturday of that month, "mid [month]" → Saturday nearest the 15th, "late [month]" or "end of [month]" → last Saturday of that month, month only → first Saturday of that month. Always use the next upcoming occurrence of that month. Today is ${todayDateStr}. IMPORTANT: Only set race_date when the athlete is CHANGING or SETTING their PRIMARY goal race date. Do NOT set race_date when they are adding a secondary, tune-up, or B-race alongside their existing goal — indicated by phrases like "also", "too", "as well", "build towards that too", "make sure my plan covers", or when the named race is clearly different from their current primary goal.
- A new or revised finish time goal (e.g. "I want to run sub-3:30", "revised my goal to 1:55", "aiming for under 4 hours") → goal_time_minutes as total minutes (e.g. sub-3:30 → 210, 1:55 → 115).
- A change to the athlete's recurring weekly schedule (e.g. "I can only run Tuesday, Thursday, Sunday from now on", "I'm switching my long run to Saturday", "I do Mon/Wed/Fri going forward") → updated_training_days as array of full day names (e.g. ["Tuesday", "Thursday", "Sunday"]). Only set when the athlete is changing their standing schedule, NOT for a one-off skip, swap, or "this week only" request (e.g. "I want to run Mon, Tue, Fri this week" should NOT set updated_training_days).
- A one-week-only schedule change (e.g. "I want to run Mon/Wed/Fri this week", "just this week I'm running Tuesday and Thursday", "this week I can only do Mon and Sat", "running Tue/Wed/Fri instead this week") → this_week_override_days as array of full day names. Only set when the athlete explicitly scopes the change to the current week. Do NOT set if it sounds like a permanent change.
- A correction or change to the athlete's goal race type (e.g. "actually I'm doing a half marathon not a full", "I signed up for a 10K instead", "I'm training for a 5K now") → goal_race_type as one of: "5k", "10k", "half_marathon", "marathon", "50k", "100k", "50mi", "100mi", "30k", "mile", "general_fitness". Only set when the athlete is clearly changing their goal distance, not just mentioning a race in passing.

Output: {"injury_notes": string | null, "injury_resolved": boolean | null, "injury_body_part": string | null, "new_crosstraining": string[] | null, "other_notes": string | null, "recent_race_distance_km": number | null, "recent_race_time_minutes": number | null, "easy_pace": string | null, "timezone": string | null, "skip_date": string | null, "race_date": string | null, "goal_time_minutes": number | null, "updated_training_days": string[] | null, "this_week_override_days": string[] | null, "goal_race_type": string | null, "workout": {"activity_type": string, "distance_meters": number | null, "moving_time_seconds": number | null, "average_pace": string | null, "elevation_gain": number | null, "date_offset": number} | null}

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
  phoneNumber: string,
  extracted: ExtractedProfileData,
  profile: Record<string, unknown> | null,
  onboardingData: Record<string, unknown>,
  timezone?: string,
  hasStravaConnected?: boolean
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
    const hasWeekOverride = Array.isArray(extracted.this_week_override_days) && (extracted.this_week_override_days as string[]).length > 0;
    const hasGoalRaceType = !!(extracted.goal_race_type);
    if (!hasInjury && !hasInjuryResolved && !hasInjuryBodyPart && !hasCrosstraining && !hasOtherNotes && !hasRaceData && !hasEasyPace && !hasTimezone && !hasSkipDate && !hasRaceDate && !hasGoalTime && !hasWorkout && !hasTrainingDays && !hasWeekOverride && !hasGoalRaceType) return;

    console.log("[coach/respond] persisting profile updates from user message:", extracted);

    // Compute VDOT paces if race data provided, otherwise use easy pace estimate
    let computedPaces: { easy: string; tempo: string; interval: string; vdot?: number } | null = null;
    if (hasRaceData) {
      const raceDistKm = extracted.recent_race_distance_km as number;
      const raceTimeMins = extracted.recent_race_time_minutes as number;
      // Sanity-check the extracted race time before computing VDOT.
      // Implied pace must be between 4:00/mi (elite) and 20:00/mi (walking).
      // Outside that range the extraction almost certainly mangled the input
      // (e.g. passed pace-seconds as minutes, confused km with miles, etc.).
      const impliedPaceMinPerMile = raceTimeMins / ((raceDistKm / 1.60934));
      const RACE_PACE_MIN = 4.0;   // 4:00/mi — faster than any amateur runner
      const RACE_PACE_MAX = 20.0;  // 20:00/mi — slower than brisk walking at race effort
      if (impliedPaceMinPerMile >= RACE_PACE_MIN && impliedPaceMinPerMile <= RACE_PACE_MAX) {
        computedPaces = calculateVDOTPaces(raceDistKm, raceTimeMins);
      } else {
        console.warn(
          `[coach/respond] Skipping VDOT calc — implied pace ${impliedPaceMinPerMile.toFixed(1)} min/mi is outside [${RACE_PACE_MIN}, ${RACE_PACE_MAX}] for dist=${raceDistKm}km time=${raceTimeMins}min`
        );
      }
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
    if (hasTrainingDays) {
      profileUpdate.training_days = (extracted.updated_training_days as string[]).map(d => d.toLowerCase());
      // Clear any active week override — the standing schedule takes precedence
      profileUpdate.this_week_override_days = null;
      profileUpdate.this_week_override_expires = null;
    }
    if (hasWeekOverride) {
      profileUpdate.this_week_override_days = (extracted.this_week_override_days as string[]).map(d => d.toLowerCase());
      // Expires end of current week: compute local date string, then add days to reach Sunday
      const tz = timezone || "America/New_York";
      const now = new Date();
      const localDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now); // "YYYY-MM-DD"
      const localDate = new Date(localDateStr + "T12:00:00Z"); // noon UTC proxy for local date
      const nowDow = localDate.getUTCDay(); // 0=Sun … 6=Sat
      const daysUntilSunday = nowDow === 0 ? 0 : 7 - nowDow;
      const sundayDate = new Date(localDate.getTime() + daysUntilSunday * 24 * 60 * 60 * 1000);
      profileUpdate.this_week_override_expires = sundayDate.toISOString().slice(0, 10);
    }
    if (hasGoalRaceType) {
      profileUpdate.goal = extracted.goal_race_type;
      const goalDistanceMap: Record<string, number> = {
        "mile": 1.0, "5k": 3.107, "10k": 6.214, "half_marathon": 13.109, "marathon": 26.219,
        "30k": 18.641, "50k": 31.069, "50mi": 50.0, "100k": 62.137, "100mi": 100.0,
      };
      const dist = goalDistanceMap[extracted.goal_race_type as string];
      if (dist) profileUpdate.goal_distance_miles = dist;
    }

    // Build onboarding_data update
    const updatedOnboardingData = { ...onboardingData };
    if (hasOtherNotes) {
      const existing = (onboardingData.other_notes as string) || "";
      updatedOnboardingData.other_notes = existing
        ? `${existing}; ${extracted.other_notes}`
        : (extracted.other_notes as string);
    }

    // Write manual workout to activities table if reported.
    // Skip for Strava users — their runs come in via webhook automatically, and writing
    // a manual entry from conversation creates phantom activities that stack on top of
    // real Strava data and inflate weekly mileage totals.
    if (hasWorkout && extracted.workout && !hasStravaConnected) {
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

    // When goal race type changed, sync the A race row so the dashboard shows consistent info.
    if (hasGoalRaceType) {
      const goalDistanceMap: Record<string, number> = {
        "mile": 1.0, "5k": 3.107, "10k": 6.214, "half_marathon": 13.109, "marathon": 26.219,
        "30k": 18.641, "50k": 31.069, "50mi": 50.0, "100k": 62.137, "100mi": 100.0,
      };
      const newGoal = extracted.goal_race_type as string;
      const newDist = goalDistanceMap[newGoal] ?? null;
      await supabase.from("races")
        .update({ goal: newGoal, ...(newDist !== null ? { goal_distance_miles: newDist } : {}) })
        .eq("user_id", userId)
        .eq("priority", "A");
    }

    // When the race date changed, propagate it to the races table (A race) and the
    // training plan arc so the dashboard countdown and week count stay accurate.
    let didFullRegenerate = false;
    if (hasRaceDate && extracted.race_date) {
      const newRaceDate = extracted.race_date as string;

      // Update A race row in races table
      await supabase.from("races")
        .update({ race_date: newRaceDate })
        .eq("user_id", userId)
        .eq("priority", "A");

      // Update training_plans: fix race_date, recompute total_weeks, trim weeks if shorter
      const { data: plan } = await supabase
        .from("training_plans")
        .select("id, weeks, total_weeks")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (plan) {
        const now = new Date();
        const race = new Date(newRaceDate + "T12:00:00Z");
        // Anchor to Monday (same logic as generateAndSaveFullPlan) so the race
        // always falls in the last week of the plan rather than one week past it.
        const monday = new Date(now);
        monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
        monday.setUTCHours(0, 0, 0, 0);
        const newTotalWeeks = Math.max(4, Math.min(52, Math.ceil(
          (race.getTime() - monday.getTime()) / (7 * 24 * 60 * 60 * 1000)
        )));
        const planWeeks = (plan.weeks as unknown[]) ?? [];
        if (newTotalWeeks > planWeeks.length) {
          // Race moved further out — need more weeks than the existing arc has.
          // Do a full regeneration so the dashboard reflects the new plan correctly.
          const mergedProfile = { ...profile, ...profileUpdate };
          // Race date changed to a new, further-out date — this is a genuinely new plan
          // for a different race, so reset to week 1.
          await generateAndSaveFullPlan(userId, phoneNumber, mergedProfile, null, { skipLinkSms: true, resetToWeek1: true });
          didFullRegenerate = true;
          console.log(`[persistProfileUpdates] race_date updated to ${newRaceDate}, full plan regenerated (${planWeeks.length} → ${newTotalWeeks} weeks)`);
        } else {
          // Race moved closer — trim the existing arc.
          const updatedWeeks = planWeeks.slice(0, newTotalWeeks);
          await supabase.from("training_plans")
            .update({
              race_date: newRaceDate,
              total_weeks: updatedWeeks.length,
              weeks: updatedWeeks as unknown as Json,
              updated_at: new Date().toISOString(),
            })
            .eq("id", plan.id as string);
          console.log(`[persistProfileUpdates] race_date updated to ${newRaceDate}, arc trimmed to ${updatedWeeks.length} weeks`);
        }
      }
    }
    // When VDOT paces change (race data provided) or goal race type changes, regenerate
    // the full training plan arc so session labels, key workouts, and volume targets
    // reflect the updated profile. Skip if hasRaceDate already triggered a full regen above.
    if ((hasRaceData || hasGoalRaceType) && !didFullRegenerate) {
      const mergedProfile = { ...profile, ...profileUpdate };
      // Goal change → reset to week 1 (entirely different training paradigm).
      // VDOT-only update → preserve current week, just rebuild arc with new paces.
      await generateAndSaveFullPlan(userId, phoneNumber, mergedProfile, null, {
        skipLinkSms: true,
        resetToWeek1: hasGoalRaceType,
      });
      console.log(`[persistProfileUpdates] ${hasGoalRaceType ? "goal" : "VDOT"} changed, plan regenerated (resetToWeek1=${hasGoalRaceType})`);
    }
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
  timezoneConfirmed = true,
  storedPlanAllWeeks?: Array<{ week_number: number; phase: string; mileage_target: number; long_run_target: number; key_workout: string; notes: string }>,
  dashboardUrl?: string | null,
  racePreparednessFlag = "",
  preferredUnits: string = "imperial",
  daysSinceLastCoachMessage: number | null = null,
  wantsSpeedWork = false,
  mostRecentRunRef: string | null = null,
  initialPlanDaysConstraint: string | null = null,
): string {
  switch (trigger) {
    case "morning_plan":
      return "Generate today's workout plan for this athlete. Consider their current training state, recent activity history and trends, and any adjustments needed. Be specific about distances, paces, and effort levels.";
    case "post_run_onboarding":
      // Handled by early-exit in processCoachRequest; unreachable here.
      return "";
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
                  // splits_standard gives one entry per mile (matching what the athlete sees in
                  // the Strava app). Add cumulative_miles so Claude knows the actual position —
                  // the last split is often partial (e.g. a 5.1mi run has 5 full splits + 1 partial).
                  splits: (() => {
                    let cumulativeMiles = 0;
                    return rawSummary.splits
                      ?.map(s => transformSplitForClaude(s as Record<string, unknown>))
                      .filter(s => {
                        const pace = s.pace as string | null;
                        if (!pace) return true;
                        const mins = parseInt(pace.split(":")[0], 10);
                        return isNaN(mins) || mins < 20;
                      })
                      .map(s => {
                        cumulativeMiles += (s.distance_miles as number) || 0;
                        return { ...s, cumulative_miles: Math.round(cumulativeMiles * 100) / 100 };
                      });
                  })(),
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
      const runDistanceMiles = activityData?.distance_meters != null
        ? (activityData.distance_meters as number) / 1609.34
        : null;
      const splitCount = (activityForClaude as { summary?: { splits?: unknown[] } })?.summary?.splits?.length ?? 0;
      const dataGuards: string[] = [];
      if (!hasSplits) dataGuards.push("No per-mile split data was synced from Strava. Do NOT quote specific mile split paces — ask the athlete how it felt instead.");
      if (!hasLaps) dataGuards.push("No lap data was synced from Strava. Do NOT reference lap counts, per-lap pace, per-lap elevation, or lap-by-lap effort. Do NOT use terms like 'lap-button', 'lap X', or describe the run as having discrete named segments (warmup lap, hard lap, cooldown lap). Pace/HR variation visible in the GPS splits is NOT evidence of lap-button presses — describe it as 'your splits show…' or 'around mile X' instead.");
      if (!hasHR) dataGuards.push("No heart rate data is available for this activity. Do NOT reference specific HR values.");
      // Power/watt guard: only present when there's no actual power data in the DB record.
      // If average_watts is populated (power meter, Zwift, etc.) Claude can reference the overall average.
      const hasWatts = !!(activityData?.average_watts != null);
      if (!hasWatts) dataGuards.push("No power data is available for this activity. Do NOT reference wattage, watts, or power output — not even as a range or estimate. Describe effort using HR, elapsed time, and pace-equivalent language only.");
      // Cadence guard: only reference cadence when it's stored in the activity record.
      const hasCadence = !!(activityData?.average_cadence != null);
      if (!hasCadence) dataGuards.push("No cadence data is available for this activity. Do NOT reference cadence (steps per minute, spm, rpm, or stride rate) — not as a specific value, average, or range.");
      // Per-mile and per-lap elevation breakdown is not a Strava-provided field — only total elevation gain is.
      dataGuards.push("Per-mile and per-lap elevation breakdowns (e.g. '500ft gain on lap 2', '721ft at miles 11-12') are NOT available from Strava. Reference total elevation gain only — do NOT attribute specific footage to individual miles or laps.");
      // splits_standard gives one split per mile, so splitCount ≈ ceil(runDistanceMiles).
      // Guard: if splits look like km data (far more splits than miles), warn Claude.
      // This handles legacy activities stored before the switch to splits_standard.
      if (hasSplits && runDistanceMiles != null && splitCount > Math.ceil(runDistanceMiles) + 1) {
        dataGuards.push(`SPLIT UNIT WARNING: This run is ${runDistanceMiles.toFixed(2)} miles but has ${splitCount} split entries — the splits appear to be per-kilometer, not per-mile. Each split's "cumulative_miles" field shows its actual position in the run. NEVER reference "mile ${splitCount}" or any mile number beyond ${Math.ceil(runDistanceMiles)} — that mile does not exist in this run. Use cumulative_miles to describe position (e.g. "around mile 2.5" or "in the final stretch").`);
      }
      const dataGuardBlock = dataGuards.length > 0
        ? `\nDATA AVAILABILITY GUARD — the following data is NOT present; do not fabricate it:\n${dataGuards.map(g => `- ${g}`).join("\n")}`
        : "";

      const weekMilesStr = weekMileageSoFar.toFixed(1);
      const isRunActivity = ["Run", "TrailRun", "VirtualRun"].includes((activityData?.type as string) ?? "");
      const weekMileageContext = isRunActivity
        ? `\n<rule>WEEK-TO-DATE (this run included): ${weekMilesStr} mi across ${weekRunCount} run${weekRunCount !== 1 ? "s" : ""}. This is the exact, computed total — do not add or subtract anything from it.</rule>\n`
        : `\n<rule>WEEK-TO-DATE RUNNING MILES: ${weekMilesStr} mi across ${weekRunCount} run${weekRunCount !== 1 ? "s" : ""}. This counts ONLY running activities — the ${(activityData?.type as string) ?? "non-run"} activity above is NOT included. Do NOT add its distance to this total.</rule>\n`;

      return `A workout just synced from Strava. ${dateNote}${weekMileageContext}

CONTEXT CHECK: Before writing, scan the RECENT CONVERSATION above. If there is ALREADY a coach response (from you) about this same workout — same activity date or discussing the same run — do NOT give full post-run feedback again. This happens when the athlete texts about a run before Strava syncs, and then Strava triggers this message an hour later. In that case, send only 1-2 sentences acknowledging the sync and adding what's new from Strava data (specific pace, HR, splits, or elevation not yet covered). e.g. "Saw it come through — 8:12/mi avg, HR held at 148, nice negative split." Skip anything already discussed. Also applies if the athlete texted about this run and you responded.

DATA GLOSSARY for the details below:
- summary.splits: auto-generated by Strava, one entry per kilometer (NOT per mile). Each entry includes a "cumulative_miles" field showing how far into the run that split ends. Use cumulative_miles to describe position — do NOT treat the array index or the "split" field as a mile number. For a 3.1mi run there will be ~5 km splits; calling the last one "mile 5" is wrong.${hasLaps ? "\n- summary.laps: manual lap button presses on the athlete's watch (or device auto-laps). Distance and time vary — these reflect segments the athlete intentionally marked, e.g. warm-up, hard effort, cooldown. IMPORTANT: Lap data provides per-lap AVERAGES for pace and HR only. Do NOT cite per-lap elevation gain, per-lap cadence, or per-lap power/watt ranges — Strava does not provide these per lap. Do NOT cite specific elapsed-time markers within a lap (e.g. \"at 48:46 into the run, HR jumped to 140\") — Strava does not record event-level timestamps within a lap. Only reference per-lap pace and HR averages." : ""}
- All paces are min/mile. Elevation in feet. Distances in miles.${dataGuardBlock}

Details:
${JSON.stringify(activityForClaude, null, 2)}

WORKOUT STRUCTURE — READ THIS BEFORE INTERPRETING SPLITS:
If TODAY'S PLANNED SESSION is shown in CURRENT TRAINING STATE above, check whether it describes a structured workout (e.g. "1mi WU + 3mi @ 8:30/mi + 1mi CD", "intervals", "strides", "hill repeats"). If it does:
- The opening slower segment = warmup. Do NOT flag it as a pacing anomaly or "going out too fast/slow."
- The middle segment(s) = the main effort. Compare these against the prescribed pace.
- The closing slower segment = cooldown. Do NOT describe it as "backing off" or "fading" — it is intentional.
Read the planned structure first, then interpret the splits against it. If no plan is stored, describe the split pattern as observed (e.g. "your first mile was a touch slower, then you settled into a strong rhythm") without inferring intent.

Provide post-run feedback analyzing their performance, noting what went well, any concerns, and what's coming up next. Reference their recent training trends.

COACHING FORWARD — this is the most important instruction:
You are a proactive coach, not a performance logger. Don't just describe what the athlete did — tell them what it means for where they're going.
- If the athlete has a race goal (check ATHLETE HISTORY and DATE CONTEXT): connect this run to their race prep. Are they building the right base? Is it time to add a quality session? Are they on track for their goal pace?
- If the athlete has been running only easy volume for several weeks with a time goal: this is the moment to mention adding tempo or interval work. Don't wait for them to ask.
- If the athlete is improving week-over-week: name it. Specific progress ("your easy pace has dropped 20 sec/mile over the last month") is more motivating than generic praise.
- If something needs to change in the plan: say it now, don't defer it to the next weekly recap.
Keep it concise — one coaching-forward observation is enough. Don't lecture.

MILEAGE ACCURACY — CRITICAL: The WEEK-TO-DATE figure in CURRENT TRAINING STATE is what the athlete has ALREADY RUN this week — it already includes the activity shown above. Use it as the current/completed figure. If you mention a projected end-of-week total, always add the word "on track for" or "projected" to make clear it's not yet achieved. Never say "you're at X miles this week" when X includes future sessions.

PLAN CONSISTENCY RULES — follow these exactly:
- Week-to-date mileage: use the WEEK-TO-DATE figure from CURRENT TRAINING STATE as the already-completed figure. Do not manually sum runs from conversation history or include runs from previous weeks.
- Upcoming sessions: if THIS WEEK'S PLANNED SESSIONS is present in CURRENT TRAINING STATE, use those exact sessions and distances. Do not recalculate, substitute, or invent different numbers. Only omit sessions that have already been completed (i.e. activity date falls on or before today's date).
- If no planned sessions are stored yet, reference the most recent plan from conversation history if visible.${injuryReminder}`;
    }
    case "user_message": {
      const umIsMetric = preferredUnits === "metric";
      const umMi = (miles: number) => umIsMetric ? `${(miles * 1.60934).toFixed(1)} km` : `${miles.toFixed(1)} mi`;
      const nextWeekContext = storedNextPlanWeek
        ? `Week ${storedNextPlanWeek.week_number} (next week): ${umMi(storedNextPlanWeek.mileage_target)} target, long run ${umMi(storedNextPlanWeek.long_run_target)}, key workout: ${storedNextPlanWeek.key_workout}${weekMileageSoFar > storedNextPlanWeek.mileage_target ? ` <rule>NOTE: This target (${umMi(storedNextPlanWeek.mileage_target)}) is LOWER than this week's current mileage (${umMi(weekMileageSoFar)}). Do NOT say "steps up" or "stepping up the volume" — describe it as a planned lighter week and explain why (pre-race management, recovery, arc design).</rule>` : ''}`
        : null;
      // Inject a compact summary of every planned week so Dean can answer questions about
      // upcoming mileage, peak volume, long runs, or key sessions without guessing.
      const fullArcContext = storedPlanAllWeeks && storedPlanAllWeeks.length > 0
        ? `\n\nFULL TRAINING PLAN ARC — ${storedPlanAllWeeks.length} weeks total (use this to answer questions about specific weeks, key workouts, or overall plan structure; do NOT reproduce the full list in your response; when asked about a specific week like "what's week 2's speed workout", answer directly from this data — NEVER say you don't have access to the training plan):\n${storedPlanAllWeeks.map(w => `  Week ${w.week_number} (${w.phase}): ${umMi(w.mileage_target)}, long run ~${umMi(w.long_run_target)}${w.key_workout ? ` — ${w.key_workout}` : ''}`).join('\n')}`
        : '';
      return `The athlete just sent you a message. If you see multiple consecutive Athlete messages at the bottom of RECENT CONVERSATION above, treat them together as one thought — SMS sometimes splits long messages into segments. Respond to the full intent of what they said, not just the last fragment. Respond helpfully as their running coach. Use their activity history and training data to give specific, personalized advice.

ALREADY-COMPLETED UPDATES: Check RECENT CONVERSATION. If your most recent message already made an update the athlete is now asking about or providing context for (e.g., you just recalculated paces from a race time and the athlete is now confirming the race date, or you just changed the schedule and they're confirming the swap), do NOT redo the work or say you can't do it. Acknowledge briefly that it's already done. Example: "Already updated — your paces are locked in from that half 👊" One sentence max. Do not re-explain the update.

PACE UPDATES FROM RACE DATA — CRITICAL: If the athlete provides a race result (e.g. "17:40 5K", "sub-20 10K") and you recalculate their training paces, you MUST:
1. Show the new paces in THIS message. Do NOT say "give me a sec", "I'll send that over", "I'll rebuild the plan shortly", or any variation implying a follow-up message is coming. There is no follow-up — this IS the message. If you want to show a rebuilt week plan, include it here.
2. Name each pace zone explicitly: "Easy X–Y/mi, Tempo X/mi, Interval X/mi" — never just say "your paces" or reference a single unlabeled pace.
3. Briefly explain what each zone is for when this is the first time the athlete is seeing them. One sentence each is enough: Easy = conversational, used for most of your training miles; Tempo = comfortably hard, builds your lactate threshold — the engine of your race pace; Interval = near-maximal effort (~5K race pace), sharpens speed and VO2 max.

PACE ZONE LABELS: Whenever you mention a specific pace (e.g. 6:13/mi), always label which zone it is (Easy, Tempo, Interval, Race pace). Never give a bare pace number without context — athletes don't know what 7:47 means if you don't say "easy pace".

PLAN CONSISTENCY: If there are UPCOMING SESSIONS THIS WEEK in CURRENT TRAINING STATE, those are the active plan. When the athlete asks about their schedule or upcoming runs, reference those stored sessions first — don't reconstruct the plan from memory or guess at different distances. If a plan exists and the athlete is asking about it, quote it back to them accurately before offering any adjustments.

FULL PLAN REQUESTS — HARD RULE: If the athlete asks to see their full plan, training schedule, full training arc, all upcoming weeks, or says anything like "send me my plan" / "show me my plan" — your entire response is the dashboard link${dashboardUrl ? `: ${dashboardUrl}` : " (unavailable — tell them to reply \"my plan\" and the system will generate it)"}. One or two sentences max. Do NOT output a week-by-week schedule in the SMS. Do NOT use web search to research the race and build a plan inline. Do NOT promise to send the plan later. This applies even if web search is available — research does not override this rule.

EXCEPTION: If the athlete mentions the plan in the context of asking to CHANGE it (e.g. "my plan has me running Sunday, can we switch?", "can we move Thursday's run?", "swap my rest day"), this is a session swap request — NOT a plan view request. Do NOT send the dashboard link. Handle it using the THIS WEEK SESSION SWAP rules below.

THIS WEEK SESSION SWAP: If the athlete asks to move, swap, or reschedule a session and their intent is clearly scoped to this week only (e.g. "just this week", "this Sunday only"), make the change immediately and confirm it explicitly: e.g. "Done — moved strength to Sunday and easy 3mi to Tuesday for this week."

If the request is ambiguous about scope (no "just this week" or "from now on"), ask before committing: e.g. "Just for this week, or would you like strength on Sundays going forward?" One question, then stop — don't make the change yet.

If they clearly want it as a permanent schedule change (e.g. "from now on", "every week", "going forward"), confirm the permanent update: e.g. "Done — moving strength to Sundays as your new standing schedule." The system will sync confirmed changes to their dashboard automatically.

TRAINING PLAN ADJUSTMENT: You can modify upcoming weeks in the athlete's stored training plan when circumstances clearly warrant it — illness, injury, travel, or a deliberate priority change. When you commit to a change, state it explicitly so the athlete knows their dashboard will reflect it (e.g. "I've updated next week on your dashboard — dropping it to X miles with easy running only" or "I've swapped the tempo for an easy run next week"). Only commit to a change if it's clearly warranted; don't suggest adjustments for minor day-to-day issues. Do not modify weeks that have already passed.

DASHBOARD UPDATES: When the athlete asks to "update the dashboard", "update the plan", or "update the whole plan" — you CAN do this. Do not say "I can't update the dashboard." This includes situations where the dashboard is showing wrong or mismatched data (e.g. "the dashboard shows 16 miles but you only gave me two short sessions" — that is a plan correction request, not a system bug outside your control). In all cases: describe what you're changing in 1-2 sentences and ask them to confirm. Do NOT say you can't edit the system, can't touch the database, or that the plan is auto-generated.

FULL PLAN REBUILD: If the athlete asks to rebuild or update their whole plan (not just swap a session this week) — e.g. "update the whole plan", "rebuild my plan with more tempo", "add speed work throughout", "the dashboard shows the wrong mileage, can you fix it" — describe what will change in 1-2 sentences, then end with: "Reply UPDATE PLAN to confirm and I'll send you the updated dashboard link." Do NOT include a session list or week-by-week schedule. Do NOT say the plan has already been updated — nothing changes until they confirm. Do NOT use [REBUILD_PLAN].${nextWeekContext ? `\n\nUPCOMING WEEK (stored plan):\n${nextWeekContext}` : ""}

MILEAGE DISPUTE: If the athlete corrects a mileage figure ("I didn't do that run", "that was a rest day", "I only ran X not Y"), do NOT rearrange the existing narrative or reinterpret the same data differently. Re-anchor immediately to the authoritative figure from CURRENT TRAINING STATE: "You're right — Strava shows X mi so far this week." If you stated a week total the athlete disputes, trust the correction and restate only what Strava has confirmed. A planned run is not a completed run until it appears in Strava.

SESSION DAY LABELING: When referencing a planned session as "today" or "tomorrow," or when rescheduling, always cross-check the session's stored date against today's date in DATE CONTEXT. Do not infer "today" vs "tomorrow" from the order sessions appear in the plan list — use the actual dates. When confirming a reschedule, name what is being moved: "Moving today's easy 3mi (Tue 4/1) to tomorrow, Wed 4/2" — not "shifting tomorrow's run."

LENGTH IN CONVERSATION: Check RECENT CONVERSATION. If there are already 4+ messages from today (active back-and-forth), keep this reply to 1 bubble — 2 at most. Answer the question directly and stop. Don't pad with context that was already covered.

NO REPEAT SCHEDULE PREVIEW: If RECENT CONVERSATION already contains a message from you today that mentioned tomorrow's session, next session, or upcoming workouts — do NOT mention it again in this reply. The athlete already has that information. Answer what they asked, then stop. Only re-mention the schedule if they specifically asked about it.

SCHEDULE DAYS — DO NOT INVENT: If the athlete says "X days a week" without specifying which days, do NOT assign specific days in your response (e.g. "Monday and Thursday"). Ask which days work best before locking anything in. Their confirmed training days are in ATHLETE HISTORY — only use those. If you have confirmed days in ATHLETE HISTORY, use them. If you do not, ask.

CONTEXT RETENTION — DO NOT RE-ASK FOR KNOWN DATA: If ATHLETE HISTORY already contains the athlete's race, race date, or goal time, do NOT ask for that information again. Use the stored data. Asking "what distance are you training for?" when you already have their race in ATHLETE HISTORY is a trust failure.

INTERVAL SESSION MATH: When converting interval sessions to time or total distance, always calculate explicitly — never estimate or guess. Formula: (number of reps × rep distance) + warmup + recovery jogs + cooldown = session total. Example: 6×400m = 6 × 0.25 mi = 1.5 mi of fast work. Add warmup (~1 mi), recovery jogs between reps (~0.75 mi for 5 jogs × ~150m each), and cooldown (~0.5 mi) → ~3.75 mi total. Do NOT output a range that spans 4+ miles (e.g. "3.5–7 mi") — that is internally contradictory and wrong. Output a single coherent total. If you are unsure of warmup/cooldown lengths, use reasonable defaults (1 mi warmup, 0.5 mi cooldown, ~150m jog between reps) and state them explicitly.

GENERAL FITNESS ATHLETES — WORKOUT PRESCRIPTIONS: If the athlete's goal is general_fitness (no race target) and they are in the base or early build phase (weeks 1–8), prescribe easy runs at conversational effort — NOT tempo runs, interval sessions, or threshold work. General fitness athletes building a base benefit from aerobic volume at easy effort; quality sessions are not appropriate until they have established consistent mileage. A tempo run prescribed to a base-phase general fitness athlete at 15–25 mi/week is aggressive and counterproductive. The exception: if the athlete explicitly requests speed work or says they want to add quality, then include it — otherwise default to easy miles.

FEEDBACK MESSAGES: If the athlete's message starts with "Feedback:" or "FEEDBACK:", they are submitting feedback. Decide which of two paths applies:
- If it's something you can act on as their coach (e.g. "I want more interval sessions", "the mileage feels too low", "can we add tempo runs") — skip any acknowledgment of the feedback label entirely. Just respond as their coach and make the adjustment. Don't say "thanks for the feedback". Act on it.
- If it's a product suggestion or something outside your control as a coach (e.g. "you should add midday check-ins", "the app should let me set my own paces", "I think the schedule format should change") — respond with something like: "Got it — I'll pass that along and someone will follow up." One sentence, then stop. Don't coach on it.

${mostRecentRunRef ? `${mostRecentRunRef}\n` : ""}ACTIVITY RECENCY: When referencing past activities, use the "(N days ago)" label in RECENT WORKOUTS to confirm how long ago each run was before using relative terms. Never say "yesterday" for a run that happened 2+ days ago. Use the day name (e.g. "Monday's run", "Wednesday's workout") for any activity more than 1 day ago.${daysSinceLastCoachMessage !== null && daysSinceLastCoachMessage >= 2 ? `

CONTACT GAP: Your last message to this athlete was ${daysSinceLastCoachMessage} days ago. If they seem to be checking in or acknowledging the silence, acknowledge the gap briefly and naturally — don't act like you've been watching in real time.` : ""}${fullArcContext}`;
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
        return `If RECENT CONVERSATION already contains a message from you covering today's plan or rest day, output ONE brief confirmation sentence under 160 characters. The confirmation must match what was actually discussed — if it covered a run, confirm the run (e.g. "Good morning — long run tonight as planned. Let me know how it goes."); if it covered a rest day, confirm the rest day (e.g. "Good morning — rest day today as we talked about. Let me know how you're feeling."). No preamble, no explanation. Just the one sentence.

Otherwise, send a short message that does two things: check in on yesterday's workout, then preview today's.

Structure (all in one message unless it runs long — split into two bubbles with a blank line if needed):
1. A brief, casual check-in on yesterday — vary the phrasing each time. e.g. "How'd yesterday's run go?" / "Hope yesterday's session felt good —" / "How'd [day]'s workout treat you?" Keep it light, one sentence.
2. Today's workout: type, distance, and target pace or effort. One or two sentences max. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number.
3. A short invite to adjust if needed — vary this too. e.g. "Let me know if you want to dial anything back based on how yesterday felt." / "Happy to tweak today if the legs are tired." One sentence.

No markdown. Sound like a real coach texting. Total under 560 characters.`;
      }
      return `If RECENT CONVERSATION already contains a message from you covering today's workout or rest day, send ONE brief confirmation sentence under 160 characters only. The confirmation must match what was actually discussed — if last night covered a run, confirm the run (e.g. "Good morning — easy long run tonight as planned. Let me know how it goes."); if it covered a rest day, confirm the rest day (e.g. "Good morning — rest day today as we discussed. Let me know how you're feeling."). Output nothing else.

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
        return `If RECENT CONVERSATION already contains a message from you sent today covering tomorrow's plan or rest day, send ONE brief confirmation sentence under 160 characters only. The confirmation must match what was actually discussed — if it covered a run, confirm the run (e.g. "Just a heads up for tomorrow — long run as planned. Should be a good one."); if it covered a rest day, confirm the rest day (e.g. "Just a heads up for tomorrow — rest day as we talked about. Hope you're feeling better!"). Output nothing else.

Otherwise, send a short message that does two things: check in on today's workout, then preview tomorrow's.

Structure (all in one message unless it runs long — split into two bubbles with a blank line if needed):
1. A brief, casual check-in on today — vary the phrasing each time. e.g. "How'd today's run go?" / "Hope today's session felt good —" / "How did [day]'s workout go?" Keep it light, one sentence.
2. Tomorrow's workout: type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number. If tomorrow is a quality session (tempo, intervals, repeats, or race-pace work), add one sentence explaining the purpose — e.g. "Tomorrow's tempo is working your lactate threshold — that's the core of your half marathon fitness." One sentence max, woven naturally after the workout description.
3. A short invite to adjust based on how today felt — vary this. e.g. "Let me know if you want to tweak anything based on how today felt." / "Happy to adjust if you're feeling it." One sentence.

No markdown. Sound like a real coach texting. Total under 560 characters.`;
      }
      return `If RECENT CONVERSATION already contains a message from you sent today covering tomorrow's workout or rest day, output ONE brief confirmation sentence under 160 characters. The confirmation must match what was actually discussed — if it covered a run, confirm the run (e.g. "Wednesday reminder — long run tomorrow as we talked about. You've got this."); if it covered a rest day, confirm the rest day (e.g. "Wednesday reminder — rest day tomorrow as we discussed. You're doing the right thing."). No preamble, no explanation. Just the one sentence.

Otherwise, send a short reminder text about tomorrow's workout. Three parts, all in one message:

1. A brief, natural opener — vary it each time so it doesn't feel canned. Options: "Tomorrow's workout:", "Here's what's on for tomorrow:", use their name casually ("Hey [name], tomorrow:"), reference the day ("Wednesday's session:"), etc. Mix it up.

2. The workout — type, distance, and target pace or effort. Use THIS WEEK'S PLANNED SESSIONS from CURRENT TRAINING STATE for the exact distance — do not invent a different number. If tomorrow is a quality session (tempo, intervals, repeats, or race-pace work), add one sentence explaining the purpose — e.g. "This tempo run builds your lactate threshold — that's the engine behind your goal pace." One sentence max, woven naturally after the workout description.

3. A short, warm closer — vary this too. Rotate through things like "Good luck!", "Let me know how it goes.", "Have fun out there.", "You've got this.", "Enjoy the run.", etc. One short phrase, nothing more.

Keep the whole thing under 480 characters. No markdown, no bullet points. Sound like a real coach texting, not a notification from an app.`;
    case "weekly_recap": {
      // Inject stored plan context so Dean reflects on what was planned vs. actual.
      const recapIsMetric = preferredUnits === "metric";
      const recapMi = (miles: number) => recapIsMetric ? `${(miles * 1.60934).toFixed(1)} km` : `${miles.toFixed(1)} mi`;
      const storedPlanContext = storedPlanWeek
        ? `STORED TRAINING PLAN — WHAT WAS PLANNED FOR WEEK ${storedPlanWeek.week_number}:\nPhase: ${storedPlanWeek.phase} | Planned mileage: ~${recapMi(storedPlanWeek.mileage_target)} | Long run: ~${recapMi(storedPlanWeek.long_run_target)}\nKey workout: ${storedPlanWeek.key_workout || "n/a"}\nCoaching note: ${storedPlanWeek.notes || "n/a"}\n\nYour job: recap how actual training compared to this plan, then advise on the upcoming week using the arc above as your guide — don't invent the progression from scratch.\n\n`
        : "";
      const isMetric = preferredUnits === "metric";
      const weekVolumeVal = isMetric ? (weekMileageSoFar * 1.60934).toFixed(1) : weekMileageSoFar.toFixed(1);
      const weekVolumeUnit = isMetric ? "km" : "mi";
      const weekVolumeStr = `${weekVolumeVal} ${weekVolumeUnit}`;
      // For non-Strava users with no tracked data, do NOT tell Claude "0 miles" —
      // that causes Dean to say "last week was quiet" and reset to a conservative plan.
      // Instead, tell Claude the data is missing and to use the conversation.
      const noStravaMileageData = !hasStrava && weekMileageSoFar === 0;
      const weekMileageContext = noStravaMileageData
        ? `<rule>MILEAGE TRACKING UNAVAILABLE: This athlete is not on Strava, so no mileage was automatically tracked this week. Do NOT say "0 miles logged", "quiet week", or imply the athlete didn't run — the data is simply missing. Non-Strava athletes typically only text about a fraction of their runs; assume they completed most of their planned sessions unless they explicitly told you otherwise.</rule>\n\nCRITICAL — BUILD NEXT WEEK FROM THE PROGRESSION TARGET, NOT FROM REPORTED MILEAGE: The "Progression target" in CURRENT TRAINING STATE is your baseline for next week's volume. Do NOT anchor next week's mileage to what the athlete mentioned conversationally — that will always undercount. If the progression target says ~X mi, build toward that. Only deviate down if the athlete explicitly said they struggled or didn't complete sessions.\n\n`
        : `<rule>THIS WEEK'S MILEAGE (authoritative, do not recompute): ${weekVolumeStr} across ${weekRunCount} run${weekRunCount !== 1 ? "s" : ""}. Use this exact figure when recapping the week — never sum individual runs yourself. IMPORTANT: distance phrases in the athlete's messages (e.g. "the first 9 miles were on trails") describe portions of already-tracked Strava activities — do NOT count them as additional runs or add them to the total.</rule>\n\nYOUR FIRST TEXT MUST OPEN WITH THE EXACT PHRASE: "Last week: ${weekVolumeStr} across ${weekRunCount} run${weekRunCount !== 1 ? "s" : ""}." (You may append to this sentence, but do not alter these numbers.)\n\n`;
      const deloadInstruction = periodization?.isDeloadWeek
        ? `\n<rule>RECOVERY WEEK — THIS OVERRIDES NORMAL PROGRESSION:\nThis is a scheduled recovery week. The first text MUST frame it explicitly: "Recovery week this week — pulling back the volume intentionally, this is when your body adapts to the work you've been putting in" or similar. All session distances must be 25–30% shorter than last week.${periodization.suggestedWeeklyMiles != null ? ` Target total: ~${recapMi(periodization.suggestedWeeklyMiles)}.` : ""} Remove or replace all quality sessions (tempo, intervals) with easy runs or strides. No new intensity. Same number of runs, just shorter and easier. Recovery weeks are not optional — skipping them is how athletes break down.</rule>\n`
        : periodization?.suggestedWeeklyMiles != null
        ? `\nPROGRESSION TARGET: This week's suggested mileage is ~${recapMi(periodization.suggestedWeeklyMiles)} (~${periodization.phase === "peak" ? "5%" : "8%"} step up from recent average). Build toward this across the week's sessions. If the athlete's recent pace suggests they're ready to add a quality session, include one. If they've been building for 3+ weeks, this is week ${(periodization.effectiveWeek ?? 0) % 4 === 3 ? "3 of the build — next week is recovery, so push a little this week" : "of the build — stay consistent"}.\n`
        : "";
      return `${storedPlanContext}${weekMileageContext}${deloadInstruction}Send 2–3 short texts recapping last week and previewing the coming week (use DATE CONTEXT for exact dates). Each text under 480 characters, separated by a blank line. First text: last week summary (mileage, one specific observation) plus one sentence on what this week is targeting and why — e.g. "This week we're adding a tempo run now that your base is solid" or "Pulling back volume slightly — recovery week, which is when adaptation actually happens." Second: this week's key sessions. Third (optional): one brief motivational or tactical note. No intro fluff.

PROGRESSION — be a proactive coach, not a scheduler:
If the athlete has a race goal with a time target (check ATHLETE HISTORY), the weekly plan must reflect where they are in their training arc — don't just repeat last week's plan with the same mileage.
- If recent weeks have been all easy miles with no quality work: this week should introduce or propose a tempo or interval session. Name it specifically ("Let's add a 3-mile tempo at 8:30/mi on Wednesday").
- If the athlete is several weeks out from their race: the plan should be building toward race-specific fitness (threshold work, goal-pace miles), not just accumulating easy volume.
- If the athlete has been consistent: acknowledge the trend and explain what comes next and why ("You've built a solid base over the last month — time to start sharpening with some quality sessions").
Always include one sentence in the first text explaining what this week is targeting and why — even if the phase hasn't changed ("Another building week — consistency is the work right now" / "Recovery week this week, which is actually when your body adapts" / "Ramping the long run this week — that's the core fitness driver for your marathon"). Don't over-explain; one sentence is enough.

QUALITY SESSION "WHY": In the sessions list, for any tempo run, interval session, or race-pace workout, add a brief purpose note on the same line — one short clause after a dash. e.g. "Wed 3/12 · Tempo 4mi (2mi @ 8:45) — threshold work, the engine for your marathon pace" or "Thu 3/13 · 6×800m @ 7:30 — sharpens race speed and economy." Keep it to one clause only. Easy runs and long runs do not need this.

EASY RUN ENRICHMENT: Easy runs don't need a "why" clause, but they should never be bare mileage either. Add one of the following based on context — pick whichever is most useful for this athlete this week:
- HR target if HR data is in the activity summary: "Easy 6mi @ 9:30-10:00/mi (~140 bpm)"
- Terrain or surface cue when it matters: "Easy 6mi — trails or soft surface if you can, legs should feel fresh"
- Effort cue for weeks with no quality sessions: "Easy 5mi — full conversational effort, never pushing"
- Recovery framing after a hard week: "Easy 6mi — keep it genuinely easy, this is active recovery"
One cue per easy run is enough. Don't annotate every run the same way — vary them, and skip the annotation entirely on short recovery runs where the label is self-explanatory.

WEEK NUMBERING: Do NOT refer to weeks as "Week 2", "Week 3", etc. You do not have a reliable count of how many training weeks this athlete has been through. Use "this week" and "next week" instead. If you want to signal a training phase, describe it by feel or intent — e.g. "another building week", "recovery week", "adding a quality session this week" — not a number.

MONDAY: Make sure Monday's session is clearly included in the sessions list. Close the final bubble with a natural, warm invitation to check in after Monday — vary the phrasing so it doesn't feel templated. Something like "Excited to hear how Monday goes." or "Hit me up after Monday's run." or "Let me know how the week kicks off." One short sentence, feels like a real coach signing off for the weekend.

YTD MILESTONES: Check "Year-to-date" in ATHLETE HISTORY. If the athlete has crossed a round-number milestone this week (100, 200, 250, 300, 500, 1000 miles) or is within striking distance of one in the coming week, call it out naturally — one short sentence woven into the recap, not a separate announcement. e.g. "You also just crossed 500 miles on the year — that's a real number." Keep it earned, not forced. Skip it if the number isn't notable.

SCHEDULE CONSTRAINT — CRITICAL: Only schedule *running* sessions on the athlete's confirmed training days listed under "Training days" in ATHLETE HISTORY. Do not put runs on other days. Strength, mobility, or cross-training sessions may appear on rest days (days not in the training days list) — especially if the athlete has requested them or has injury notes. If the athlete has mentioned specific day conflicts for running (e.g. "Saturday is spin class", "I have soccer Monday"), do not put a run on those days. If training days is "TBD", distribute runs across weekdays and weekends reasonably.
<rule>CROSS-TRAINING DAY PROTECTION: If ATHLETE HISTORY shows the athlete does a specific activity on a specific day (e.g., "swimming on Fridays", "yoga on Tuesdays", "spin class on Saturdays"), that day MUST show the cross-training activity — do NOT override it with a run. If they requested a specific count of a non-running session (e.g., "strength twice a week"), that exact count must appear in the plan.</rule>

TRAINING DAY COUNT VALIDATION — CRITICAL: The number of running sessions in your plan must exactly match the athlete's stated days/week preference ("Training days" in ATHLETE HISTORY). If the athlete wants 5 days of running, the plan must have exactly 5 running sessions — not 4, not 6. If the count is wrong, fix the plan. This is one of the most common plan errors.

For the sessions text, put each session on its own line using this compact format, sorted chronologically by date — never group by type:
Mon 3/2 · Easy 5mi @ 9:30/mi
Tue 3/3 · Strength + mobility 20 min
Wed 3/4 · Tempo 4mi (2mi @ 8:45)
Sat 3/7 · Long run 8mi easy
Use short day abbreviations (Mon/Tue/Wed/Thu/Fri/Sat/Sun) and M/D date format. No prose between sessions.
NO DUPLICATE ENTRIES: Each date must appear at most once per session type. Before sending, scan your session list — if the same date and session description appear more than once, remove the duplicate. A plan with "Thu 3/26 · Easy 2mi" listed twice is wrong and confusing.
SESSION DISTANCE FORMAT: Running sessions must include distance in miles (e.g. "Easy 5mi"). Non-running sessions (strength, cross-training, swimming, cycling, spin, Zwift, yoga, etc.) must NEVER include distance in miles — use duration or activity name only (e.g. "Strength + mobility 30 min", "Zwift ride 60 min", "Master's swim"). Putting miles on a non-running session causes it to be incorrectly counted as running volume.

STRENGTH & CROSS-TRAINING: If the athlete has injury notes or has requested strength/mobility work, include a "Strength + mobility" session on a rest day in the week preview (see STRENGTH, MOBILITY & CROSS-TRAINING in system prompt). If they have cross-training tools, include a cross-training day where appropriate. When you prescribe a strength session, always follow the session list with a separate bubble giving 3–5 specific exercises — never leave it at "30 min" with no detail. See STRENGTH SESSION SPECIFICS in the system prompt.
OPTIONAL CROSS-TRAINING SESSIONS: If the athlete has requested optional workouts (e.g. "optional bike", "optional strength", "optional cross-training"), include them in the sessions list on rest days. Mark them with "(Optional)" at the start of the label. Example: "Mon 3/2 · (Optional) Easy bike 45 min" or "Fri 3/6 · (Optional) Strength + climbing drills 30 min". Optional sessions are a suggestion — the athlete can skip them freely. Do NOT include their duration in the Total mileage count.

QUALITY SESSION MILEAGE — ALWAYS INCLUDE WARMUP AND COOLDOWN: For any quality session that requires a warmup or cooldown (tempo runs, interval sessions, hill repeats, fartlek, threshold work), the stated session distance must be the TOTAL distance including warmup and cooldown — NOT just the hard portion. Use defaults of 1mi warmup and 0.5–1mi cooldown if the athlete hasn't specified. Format the label to show the breakdown in parentheses. Examples:
- "Tempo 6.5mi (1mi WU + 4.5mi @ 8:45/mi tempo + 1mi CD)"
- "Intervals 5mi (1mi WU + 6×800m @ 7:30/mi + 0.5mi CD)"
- "Treadmill hills 6.5mi (1mi WU + 5mi at 8% grade + 0.5mi CD)"
Never write "Tempo 3mi" when the athlete will also run 1.5mi of warmup/cooldown — the stored session distance must reflect the full activity that will sync from Strava. This prevents the plan from understating the week's actual mileage.

MILEAGE ACCURACY: Any weekly mileage total you state must equal the sum of running session distances — strength, mobility, and cross-training sessions contribute zero miles. If the sum doesn't match your stated total, correct the plan before sending. Never show the calculation. If you're not listing every session, omit the total entirely.
TOTAL LINE FORMAT: The upcoming week starts at zero — do NOT add the miles from the week you just recapped. Those belong to the recap. The Total line shows ONLY the sum of the planned upcoming sessions. Correct: "Total: 32.5 mi". Wrong: adding past-week miles to next week’s total (e.g. if the plan is 32.5 mi but the recap week had 30.8 mi, the Total is 32.5 mi, not 63.3 mi).
<rule>CROSS-TRAINING FORMAT: For bike, swim, strength, and mobility sessions use 'min' for duration — NEVER 'mi'. Example: "Thu 4/3 · Easy bike 60min" not "Easy bike 60mi". Writing 'mi' in a cross-training session causes it to be counted as running miles and will inflate your stated total.</rule>`;
    }
    case "workout_image":
      return `The athlete just shared a workout screenshot. Here are the extracted details:\n${JSON.stringify(imageActivity || {}, null, 2)}\n\nSend 1–2 short texts as post-workout feedback. First text: one specific reaction to their performance (pace, effort, HR — whatever is most notable). Second text (only if needed): what's next. Each under 480 characters. No generic openers.`;

    case "initial_plan": {
      // Compute how many days remain in the current Mon-Sun week, including today.
      // The Sunday recap cron will send the full next-week plan starting from Monday,
      // so the initial plan should only cover the current week — not bleed into next week.
      const initNow = new Date();
      const initLocalDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(initNow);
      const [iy, im, id] = initLocalDate.split("-").map(Number);
      const dayOfWeekLocal = new Date(Date.UTC(iy, im - 1, id)).getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
      const daysToSunday = dayOfWeekLocal === 0 ? 0 : 7 - dayOfWeekLocal;
      const sundayDate = new Date(Date.UTC(iy, im - 1, id + daysToSunday));
      const sundayStr = sundayDate.toLocaleDateString("en-US", {
        timeZone: "UTC", weekday: "long", month: "short", day: "numeric"
      });
      const daysRemainingInclToday = daysToSunday + 1; // today + days until Sunday
      const weekBoundaryNote = dayOfWeekLocal === 0
        // Today IS Sunday — plan the full upcoming Mon–Sun week so they have something
        // to run on; the recap cron will have run (or is running) tonight and they'd
        // otherwise go a full week without a plan.
        ? `WEEK TIMING: Today is Sunday. Plan the upcoming full week (Monday through next Sunday). Do NOT just plan today.`
        // Mid-week onboard: plan today through this Sunday only. Sunday recap generates next week.
        : `WEEK BOUNDARY — IMPORTANT: This athlete just onboarded. Plan sessions from TODAY through this ${sundayStr} only (${daysRemainingInclToday} day${daysRemainingInclToday === 1 ? "" : "s"} remaining in this Mon-Sun week). Do NOT schedule sessions into next week (starting Monday). The Sunday recap will generate a full next-week plan automatically. If very few days remain (1-2), keep this initial plan brief — just get them started.`;
      return `This athlete just finished onboarding. Send them an initial week plan — framed as a starting point, not a finished prescription. The goal is to get something in front of them quickly and invite them to shape it.

LEAD WITH THE PLAN: Do not spend bubble 1 on preamble or coaching philosophy — get to the sessions. Any context about training approach, injury notes, or periodization belongs as 1–2 sentences woven into the plan message itself, not as a standalone opener. Never write "I'll get your plan put together now" — just send it. The athlete is waiting; give them the plan, then invite feedback.

${weekBoundaryNote}
${racePreparednessFlag}

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
- For general fitness goals with no race date in DATE CONTEXT: the training arc is a 12-week base/build cycle. When referencing the plan length, say "12-week" — do not invent a different number.

GENERAL FITNESS GOAL — SET EXPECTATIONS:
- When the athlete has a general fitness goal (no race target), include 1-2 sentences in your first text bubble about what they can expect to achieve by the end of this training cycle. Be specific and concrete — not "you'll feel better" but something like: "By week 12 you'll be running comfortably through both days each week, and we'll look to steadily add a third day and more miles as you find your rhythm." Ground it in their current mileage and days/week.

${wantsSpeedWork ? `<rule>SPEED WORK REQUIRED: This athlete explicitly requested speed work as a training goal. Week 1 MUST include at minimum strides or a short tempo segment — do not send an all-easy plan. This requirement overrides conservative defaults. Strides are low-impact and appropriate even when being cautious about injury history.</rule>

` : ""}DELOAD WEEKS — REQUIRED IN BASE AND BUILD PHASES:
- <rule>Every plan arc covering 9+ weeks MUST include deload weeks during the base and build phases. The standard pattern: build 3 weeks, recover 1 week (~70% of the prior build week's volume). A plan that shows 10+ consecutive weeks of increases without any deload is a safety failure. When presenting the full-arc summary, explicitly mark deload weeks — e.g., "Weeks 1–3 (build): 34, 36, 38 mi; Week 4 (recovery): 26 mi; Weeks 5–7 (build): 42, 44, 46 mi; Week 8 (recovery): 32 mi..."</rule>
- Deloads apply only during base and build phases. Do NOT insert a deload week during the peak or taper phase — taper already handles volume reduction for a different purpose (pre-race sharpening, not adaptation). Mixing "deload" and "taper" language confuses athletes.
- Deload timing flexes around races: if a scheduled deload would fall within 2 weeks of a race (including B and C races), shift it earlier rather than forcing it immediately pre-race. Pre-race weeks should follow the taper protocol, not a deload label.
- Short plans (8 weeks or fewer): one step-back week near the midpoint is sufficient — do not force a 4th-week deload if the plan is too short to have a meaningful build-deload-build cycle before the taper starts.
- MARATHON-SPECIFIC: For marathon plans (18+ weeks), the arc should have 4-5 deload weeks across the base and build phases. Additionally, long runs in the build/peak phase should include marathon-pace (MP) segments — e.g., the last 2-3 miles of a 16mi long run at goal marathon pace. This teaches the legs to run at race pace when already fatigued, which is non-negotiable marathon prep.

VOLUME AND SAFETY:
- The FITNESS TIER section above contains a WEEK 1 VOLUME CAP and a LONG RUN CAP — both are hard limits calculated from the athlete's actual current mileage. You MUST respect both caps. Prescribing 2–3× current volume is a documented injury risk. If the cap says Week 1 max is 7 mi, do not write a plan with 15 mi. If the long run cap is 2 mi, do not prescribe a 9 mi long run.
- SELF-CONSISTENCY CHECK: Before sending any plan, verify that (1) the sum of running session distances matches your stated weekly total, and (2) no single session exceeds the long run cap from FITNESS TIER. If you state a safety cap in one sentence and prescribe a plan that violates it in the next sentence, that is a direct contradiction and must be corrected before sending.
- HIGH VOLUME athletes: week 1 MUST include at least one quality session (tempo, intervals, strides, or hill repeats). An athlete running 30+ mi/week should NOT get an all-easy first week — prescribing all easy miles for an established runner is sandbagging them.
- MODERATE VOLUME athletes: week 1 must include at least strides (4–6 × 20-second pickups at the end of an easy run). "Strides" counts as a quality session. Do not send a completely flat, all-easy plan to someone running 10–30 mi/week — they are past the phase where that makes sense.
- LOW VOLUME athletes: include strides on at least one easy run in week 1 (e.g., "Easy 3mi, then 4 × 20 sec strides"). Even athletes at 5–10 mi/week benefit from neuromuscular variety, and it makes the plan feel more purposeful. Scale effort to their current fitness.
- For mountain or technical trail races with significant elevation gain (Snowbird, Cirque Series, Dipsea, Black Canyon, etc.): include at least one vert-specific session in week 1 — this applies regardless of race distance category. Do NOT delay climbing work to "later in the build"; athletes preparing for elevation gain need it from the start. Vert work can be a hilly easy run, power hiking intervals, or a designated hill session.
- For athletes coming back from injury, returning after a long break, or with low current mileage: start shorter than you might think. It's easier to add than to walk back an overambitious first week.
- Address any injury or physical limitation directly in the plan itself — briefly note how the plan accounts for it. Do NOT ask a follow-up question about it.

EXPLAINING THE PLAN (beginner and low-volume athletes only):
- When FITNESS TIER is "No activity data yet" (beginner self-report), LOW VOLUME (<10 mi/week), or no Strava history: include 2–3 sentences explaining the WHY behind the plan structure. Athletes who are new or just getting consistent need to understand why easy effort is the right approach — otherwise an all-easy-looking plan feels like generic advice, not coaching.
- Explain pacing zones: what "easy" actually means (conversational — able to speak in full sentences, never gasping), and why that builds the aerobic engine rather than just "going slow."
- Explain the ramp: why we start where we are and add ~10% per week rather than jumping ahead. Frame it as protecting the investment they're about to make, not holding them back.
- Keep it brief — 2 sentences is enough. The goal is trust, not a lecture. e.g. "Easy effort means conversational pace — if you can't hold a sentence, slow down. Starting here and building steadily is how you arrive at the start line healthy and ready."
- This explanation belongs in the first text bubble alongside the plan overview, not as a separate standalone block.

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
- <rule>STRIDES REQUIRED: Every week of a mile TT plan MUST include strides (6-10x 20-second pickups at the end of an easy run). Strides are the single most important neuromuscular stimulus for mile performance — omitting them is a plan error. Tag them explicitly in the session description, e.g., "Easy 5mi + 6×20sec strides".</rule>
- <rule>SHORT FAST INTERVALS: The mile is a ~4 minute anaerobic/lactate effort — the primary quality sessions MUST be short and fast: 200m–400m repeats at goal pace or faster (NOT 800m repeats, which target a different energy system). 800m repeats are too long for mile prep and train the wrong physiological pathway. Use 6-12x200m or 6-10x400m at goal-mile pace or 3-5 sec/lap faster.</rule>
- Key quality sessions: 400m repeats (6-10x) at goal-mile pace, 200m repeats (8-12x) at faster than goal pace for neuromuscular development, and strides (see above). One short tempo run (2-3mi) per week maximum for aerobic support — this is secondary, not the focus.
- If they have a goal time, compute goal pace (e.g., 5:45 mile = 1:26 per 400m) and calibrate: 400m reps at or 3-5 sec faster per rep, 200m reps at 5-8 sec faster per rep than goal-pace equivalent.
- Easy mileage fills the rest but total volume stays modest — 25-35mi/week is plenty for most mile-focused athletes. More is not better here.
- Intensity distribution flips compared to longer events: 60-70% of sessions are genuinely easy, but the quality sessions are sharper and shorter than anything needed for a 5K or 10K.
- No traditional taper — the final 7 days before the time trial, reduce total volume ~30% and do one short sharpening session (4-6x400m at goal pace).

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
TOTAL LINE FORMAT: The Total line must show ONLY the sum of the planned future sessions. Never write "Total: X mi + your Y mi already this week" — that is confusing and misleading. If the athlete has already run some miles this week and you want to acknowledge it, do so in a separate sentence outside the session list. Never combine planned and already-completed miles in the same Total line.
<rule>CROSS-TRAINING FORMAT: For bike, swim, strength, and mobility sessions use 'min' for duration — NEVER 'mi'. Example: "Thu 4/3 · Easy bike 60min" not "Easy bike 60mi". Writing 'mi' in a cross-training session causes it to be counted as running miles and will inflate your stated total.</rule>

SCHEDULE CONSTRAINT: Only schedule *running* sessions on the athlete's confirmed training days listed under "Training days" in ATHLETE HISTORY. Do not put runs on other days. Strength, mobility, or cross-training sessions may appear on rest days if the athlete has requested them.
<rule>CROSS-TRAINING DAY PROTECTION: If ATHLETE HISTORY shows the athlete does a specific activity on a specific day (e.g., "swimming on Fridays", "yoga on Tuesdays", "spin class on Saturdays"), that day MUST show the cross-training activity — do NOT override it with a run. If they requested a specific count of a non-running session (e.g., "strength twice a week"), that exact count must appear in the plan.</rule>

OPTIONAL CROSS-TRAINING SESSIONS: If the athlete has requested optional workouts (e.g. "optional bike", "optional strength", "optional cross-training"), include them in the sessions list on upcoming rest days — even if those days are not in the athlete's confirmed training day list. Mark them with "(Optional)" at the start of the label. Example: "Fri 4/11 · (Optional) Easy bike 45 min" or "Mon 4/14 · (Optional) Strength + climbing drills 30 min". Optional sessions are a suggestion — the athlete can skip them freely. Do NOT include their duration in the Total mileage count. Note: the CONFIRMED TRAINING DAYS list above is for running sessions only — optional cross-training can appear on any upcoming rest day.

DATES AND DAY LABELS:
- CRITICAL: Use the day names from DATE CONTEXT above — do not compute weekdays yourself. DATE CONTEXT lists tomorrow and the next 7 days with correct day names. Copy them directly. "Wed, Mar 11" → use "Wed 3/11". Getting these wrong destroys trust.
${initialPlanDaysConstraint ?? "- Do NOT add a session for today. Start from the athlete's next training day."}
- If "Mileage so far this week" in CURRENT TRAINING STATE is > 0, acknowledge it in the first bubble with a separate sentence — e.g. "You've already got X miles in this week." DO NOT add those miles to the Total line. The Total line must equal ONLY the sum of the planned future sessions you are prescribing. Never write "Total: X mi + your Y mi already this week" — that format is confusing and implies a combined 65-mile week when you mean 28 miles of new work. If the current week's mileage is already very high relative to the athlete's normal weekly target (e.g. they ran a long race mid-week), flag the overload risk explicitly rather than silently stacking more miles on top.

B/C RACE PLANNING (if B or C races appear in DATE CONTEXT above):
- The arc orientation should mention B races as tune-up checkpoints — e.g. "The Dipsea in June serves as a great fitness check before the Sierre Zinal build." Do NOT ignore them.
- B races = race at strong controlled effort, not an all-out peak. Plan doesn't fully taper for them.
- C races = treat as a quality workout day. No schedule disruption.
- Do NOT try to peak for both A and B races simultaneously — the A race is the only peak.

DEFAULT FORMAT (for athletes not matching the EXPERIENCED RUNNER CLOSE TO RACE criteria above):
Write as EXACTLY 2 SMS bubbles separated by a blank line — no more, no less. Each under 480 characters. Do not create a 3rd bubble for strength details, extra context, or anything else. If you want to include strength work or additional notes, fold them into the 2 bubbles.

First bubble: 3-4 sentences max. If the athlete has a race date, open with a 1-2 sentence training arc orientation — briefly sketch the shape of the journey from now to race day (e.g. "You've got ~18 weeks — first 6 or so we're building your aerobic base, then we'll layer in quality work and sharpen into goal pace in the final month before the taper"). This tells them where they're going, not just what's happening this week. Then one sentence on why this specific first week is structured the way it is — e.g. "Starting with all easy miles to build your aerobic base before introducing quality work" or "Keeping volume conservative given the hip — easier to add than to walk back a flare-up." If no race date, skip the arc and just explain the week's rationale. Do NOT open with "Got it" or any generic acknowledgment phrase. Do NOT restate their goal back to them.

Second bubble: this week's sessions, one per line, sorted strictly by calendar date ascending — never group by type (runs first, then strength). CRITICAL: if your training days span a month boundary (e.g. Sat 3/28, Sun 3/29, then Tue 3/31, Wed 4/1), the earlier calendar dates MUST appear first regardless of day name. Do not sort by day-of-week order — sort by the actual date.
Mon 3/2 · Easy 3mi @ easy effort
Tue 3/3 · Strength + mobility 20 min
Wed 3/4 · Tempo 4mi (2mi @ 8:45) — builds lactate threshold, the engine for your goal pace
Sat 3/7 · Easy 4mi
SESSION DISTANCE FORMAT: Running sessions must include distance in miles (e.g. "Easy 3mi"). Run/walk interval sessions (time-based beginner workouts) must include an approximate distance estimate after the duration: e.g. "Run 2 min, walk 2 min × 6 (~24 min, ~1.8mi)". Estimate at ~13 min/mile for beginner run/walk pace. Non-running sessions (strength, cross-training, swimming, cycling, spin, Zwift, yoga, etc.) must NEVER include distance in miles — use duration or activity name only (e.g. "Strength + mobility 20 min", "Zwift ride 60 min"). Putting miles on a non-running session causes it to be incorrectly counted as running volume.
QUALITY SESSION MILEAGE — ALWAYS INCLUDE WARMUP AND COOLDOWN: For any quality session that requires a warmup or cooldown (tempo runs, interval sessions, hill repeats, fartlek, threshold work), the stated session distance must be the TOTAL distance including warmup and cooldown — NOT just the hard portion. Use defaults of 1mi warmup and 0.5–1mi cooldown if the athlete hasn't specified. Format the label to show the breakdown in parentheses. Examples:
- "Tempo 6.5mi (1mi WU + 4.5mi @ 8:45/mi tempo + 1mi CD)"
- "Intervals 5mi (1mi WU + 6×800m @ 7:30/mi + 0.5mi CD)"
- "Treadmill hills 6.5mi (1mi WU + 5mi at 8% grade + 0.5mi CD)"
Never write "Tempo 3mi" when the athlete will also run 1.5mi of warmup/cooldown — the stored session distance must reflect the full activity that will sync from Strava.
QUALITY SESSION "WHY": For any tempo run, interval session (800m repeats, etc.), or race-pace workout in the plan, add a brief purpose note on the same line — one short clause after a dash. Keep it specific to the athlete's goal: "— builds lactate threshold, the engine for your half marathon pace" or "— sharpens the speed you'll need at goal pace" or "— teaches your legs to run fast when tired." Easy runs and long runs do not need this treatment.
Use short day abbreviations and M/D dates (cross-referenced against DATE CONTEXT — do not compute day names independently). End the second bubble (after the session list and Total line) with exactly this line:
"How does this look? Happy to adjust anything."
Do NOT add any other closing line — no "this number's always open", no reminders question. The reminders question is sent separately.

ONE QUESTION RULE: Do not ask any questions in this response — no follow-ups about injuries, niggles, schedule, reminders, or anything else. If you want to flag something about an injury or constraint, state it as information ("I've kept this conservative given your hip") not as a question.
${!hasStrava ? `
NO STRAVA — SET THE TEXT-TRACKING HABIT: This athlete is not on Strava, so there's no automatic activity sync. Weave a natural, low-key line into the closing of the plan that tells them to text you after each run. Make it feel like a coach thing, not a system requirement. Examples: "Since you're not on Strava, just shoot me a text after each run — even a quick 'done, 5 miles' — and I'll track from there." or "No Strava sync here, so just drop me a message after each workout and I'll keep tabs on your progress." Vary the phrasing. One sentence only — don't dwell on it.` : ""}`;
    }
    default:
      return "";
  }
}
